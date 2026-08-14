"""Memória do cliente: decisões de alocação POSITIVAS e NEGATIVAS, versionadas.

O QUE ESTE MÓDULO RESOLVE
-------------------------
Toda análise passa por revisão humana. O analista aceita alocações, corrige
outras e - o ponto que interessa - RETIRA contas de linhas onde a máquina as
colocou. Retirar é uma decisão tão informativa quanto alocar: significa "esta
origem não pertence a este destino".

No v1 a exportação de memória só olhava linhas alocadas COM destino
preenchido. A retirada era descartada. Resultado: na análise do mês seguinte o
dicionário realocava exatamente a mesma conta no mesmo lugar errado, e o
analista refazia o mesmo trabalho manual - todo mês, para sempre. A memória
"aprendia" só metade do que o humano ensinava.

Aqui `decisao` tem três valores e `nao_alocar` é cidadão de primeira classe:

    alocar      origem -> destino
    nao_alocar  o humano retirou; nenhuma camada automática pode realocar
    contexto    linha informativa/totalizador; capturada, mas não alocável

TRÊS DECISÕES DE DESENHO
------------------------
1. LÓGICA PURA SEPARADA DO BANCO. `normalizar`, `diff_memoria`,
   `entradas_promoviveis` e `aplicar_memoria` não tocam em I/O. São elas que
   carregam a regra de negócio, e são testadas sem banco nenhum
   (server/tests/test_memoria.py). O banco só persiste.

2. SALVAMENTO OPT-IN COM DIFF NA FRENTE. `diff_memoria` existe para o portal
   mostrar ao analista o que vai mudar ANTES de gravar:

       Salvar memória de SPE (exemplo)?   [x]
         -> 41 regras novas
         ->  7 alteradas (destino mudou)
         ->  3 marcadas "não alocar"
         -> 12 confirmadas sem mudança

   Memória que se grava sozinha é memória em que ninguém confia: basta uma
   análise ruim para envenenar o cliente e não há como saber quando aconteceu.

3. VERSIONAMENTO, NUNCA UPDATE DESTRUTIVO. `salvar_revisao` sempre cria
   `max(revisao) + 1`. Dá para auditar o que foi decidido em cada análise e
   reverter uma revisão ruim lendo a anterior.

Sobre `psycopg`: importado LAZY em `conexao.py`. Este módulo é importável (e
testável) numa máquina sem driver de banco - ver docstring de `app/db/conexao`.
"""

from __future__ import annotations

import json
import logging
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping, Sequence

from . import conexao

logger = logging.getLogger(__name__)

# --------------------------------------------------------------------- decisões
ALOCAR = "alocar"
NAO_ALOCAR = "nao_alocar"
CONTEXTO = "contexto"
#: Espelha `DECISAO` de portal/src/core/matching.js e o CHECK de `schema.sql`.
DECISOES: frozenset[str] = frozenset({ALOCAR, NAO_ALOCAR, CONTEXTO})

#: Separador de chave. Mesmo caractere de `aggKey` em portal/src/core/keys.js,
#: improvável em nome de conta, então não há ambiguidade de fronteira.
SEP = "|"

#: Chave de identidade de uma decisão: (origem, grupo, subCategoria) normalizados.
Chave = tuple[str, str, str]

_NAO_ALFANUM = re.compile(r"[^a-z0-9\s]")
_ESPACOS = re.compile(r"\s+")
#: Faixa Unicode dos diacríticos combinantes que o NFKD separa das letras.
_COMBINANTES = range(0x0300, 0x0370)


# ---------------------------------------------------------------- normalização
def normalizar(valor: object) -> str:
    """lower + remove acento + `[^a-z0-9\\s]` -> espaço + colapsa + trim.

    CONTRATO CRÍTICO: byte a byte equivalente a
      · `normalizeText` de portal/src/core/normalize.js
      · `dm_normalize` de server/app/db/schema.sql

    Divergir aqui é o bug mais caro que este projeto já teve. No v1 o banco
    normalizava com `lower(unaccent(...))` e o portal removia pontuação também:
    "ICMS s/ vendas" virava `icms s/ vendas` de um lado e `icms s vendas` do
    outro. O UPSERT nunca achava a linha existente, inseria uma nova, e o
    dicionário ficou com pares duplicados em que a regra aprendida jamais
    vencia o seed. 229 das 1.285 entradas caíam nesse caso.

    >>> normalizar("Mútuo Financeiro L/P")
    'mutuo financeiro l p'
    >>> normalizar("(-) PREJUIZOS ACUMULADOS")
    'prejuizos acumulados'
    """
    texto = ("" if valor is None else str(valor)).strip().lower()
    # NFKD separa 'á' em 'a' + acento combinante; descartamos os combinantes.
    # É o equivalente exato do `.normalize('NFKD').replace(/[\u0300-\u036f]/g,'')`
    # do JS - e não `unicodedata.name`, que seria ordens de grandeza mais lento.
    texto = "".join(
        c for c in unicodedata.normalize("NFKD", texto) if ord(c) not in _COMBINANTES
    )
    # Pontuação vira ESPAÇO, não vazio: "l/p" tem de virar "l p" e não "lp",
    # senão "s/ vendas" e "s vendas" deixam de casar com "svendas".
    texto = _NAO_ALFANUM.sub(" ", texto)
    return _ESPACOS.sub(" ", texto).strip()


def chave_de(origem: object, grupo: object = "", sub_categoria: object = "") -> Chave:
    """Chave de identidade normalizada de uma decisão."""
    return (normalizar(origem), normalizar(grupo), normalizar(sub_categoria))


def chave_dicionario(entrada: EntradaMemoria) -> str:
    """Chave textual de `dicionario_global.chave` (formato de `aggKey` do portal)."""
    return SEP.join(entrada.chave)


# --------------------------------------------------------------------- entrada
@dataclass(slots=True)
class EntradaMemoria:
    """Uma decisão do analista sobre uma origem.

    `destino` vazio é NORMAL e esperado quando `decisao != 'alocar'` - a ausência
    de destino é precisamente o conteúdo da decisão negativa.

    `confirmado_por_humano` distingue "o analista olhou e aprovou" de "a máquina
    sugeriu e ninguém contestou". Só o primeiro pode virar regra global
    (`entradas_promoviveis`).
    """

    origem: str
    destino: str = ""
    grupo: str = ""
    sub_categoria: str = ""
    decisao: str = ALOCAR
    confirmado_por_humano: bool = False

    @property
    def chave(self) -> Chave:
        return chave_de(self.origem, self.grupo, self.sub_categoria)

    @classmethod
    def de_dict(cls, dados: Mapping[str, Any]) -> EntradaMemoria:
        """Aceita snake_case (API/banco) e camelCase (portal) na mesma função.

        O portal fala `subCategoria`/`confirmadoPorHumano`; o banco, `sub_categoria`
        /`confirmado_por_humano`. Tolerar as duas grafias num único ponto de
        entrada evita espalhar tradutores por todo o código - e evita o campo
        chegar vazio sem ninguém notar, que foi como o v1 perdeu grupo/sub em
        parte das entradas.
        """
        decisao = _texto(dados, "decisao") or ALOCAR
        if decisao not in DECISOES:
            raise ValueError(f"decisão inválida: {decisao!r} (use {sorted(DECISOES)})")
        return cls(
            origem=_texto(dados, "origem"),
            destino=_texto(dados, "destino"),
            grupo=_texto(dados, "grupo"),
            sub_categoria=_texto(dados, "sub_categoria", "subCategoria"),
            decisao=decisao,
            confirmado_por_humano=_bool(
                dados, "confirmado_por_humano", "confirmadoPorHumano"
            ),
        )

    def para_dict(self) -> dict[str, Any]:
        return {
            "origem": self.origem,
            "destino": self.destino,
            "grupo": self.grupo,
            "subCategoria": self.sub_categoria,
            "decisao": self.decisao,
            "confirmadoPorHumano": self.confirmado_por_humano,
        }


def _texto(fonte: Mapping[str, Any], *nomes: str) -> str:
    for nome in nomes:
        valor = fonte.get(nome)
        if valor is None:
            continue
        limpo = str(valor).strip()
        if limpo:
            return limpo
    return ""


def _bool(fonte: Mapping[str, Any], *nomes: str) -> bool:
    for nome in nomes:
        if nome in fonte:
            return bool(fonte[nome])
    return False


def _dedupe(entradas: Iterable[EntradaMemoria]) -> dict[Chave, EntradaMemoria]:
    """Indexa por chave normalizada; em empate, a ÚLTIMA decisão vence.

    Mesma regra de `memoriaDeRows` no portal: o analista pode ter mexido duas
    vezes na mesma origem durante a sessão, e o que vale é a última palavra.
    Entradas sem origem são descartadas - chave vazia casaria com qualquer coisa.
    """
    return {e.chave: e for e in entradas if e.chave[0]}


# ------------------------------------------------------------------------ diff
@dataclass(slots=True)
class Alteracao:
    """Mesma chave, conteúdo diferente. Guarda os DOIS lados para exibição.

    O painel de confirmação precisa dizer "Mútuo Financeiro -> Empréstimos" e
    não apenas "mudou": sem o `de`, o analista não tem como julgar se aprova.
    """

    chave: Chave
    de: EntradaMemoria
    para: EntradaMemoria

    @property
    def destino_mudou(self) -> bool:
        return normalizar(self.de.destino) != normalizar(self.para.destino)

    @property
    def decisao_mudou(self) -> bool:
        return self.de.decisao != self.para.decisao

    @property
    def campos(self) -> list[str]:
        mudou = []
        if self.destino_mudou:
            mudou.append("destino")
        if self.decisao_mudou:
            mudou.append("decisao")
        return mudou

    def para_dict(self) -> dict[str, Any]:
        return {
            "chave": SEP.join(self.chave),
            "campos": self.campos,
            "de": self.de.para_dict(),
            "para": self.para.para_dict(),
        }


@dataclass(slots=True)
class DiffMemoria:
    """Resultado da comparação entre a memória gravada e a proposta."""

    novas: list[EntradaMemoria] = field(default_factory=list)
    alteradas: list[Alteracao] = field(default_factory=list)
    removidas: list[EntradaMemoria] = field(default_factory=list)
    inalteradas: list[EntradaMemoria] = field(default_factory=list)

    def resumo(self) -> dict[str, int]:
        """Contagens para o painel de confirmação e para `memoria_revisoes`.

        Mapeamento das linhas que o analista vê:

            "41 regras novas"            -> novas
            "7 alteradas (destino mudou)"-> destino_mudou
            "3 marcadas não alocar"      -> nao_alocar
            "12 confirmadas sem mudança" -> inalteradas

        `destino_mudou` e `decisao_mudou` são DISJUNTOS de propósito: uma
        entrada que virou `nao_alocar` também "perdeu o destino", mas contá-la
        nas duas linhas do painel infla os números e ensina o analista a
        aprovar sem ler. Trocar de destino continuando a alocar é uma correção;
        virar `nao_alocar` é uma decisão de natureza diferente.
        """
        propostas = self.novas + [a.para for a in self.alteradas] + self.inalteradas
        return {
            "novas": len(self.novas),
            "alteradas": len(self.alteradas),
            "destino_mudou": sum(
                1 for a in self.alteradas if a.destino_mudou and not a.decisao_mudou
            ),
            "decisao_mudou": sum(1 for a in self.alteradas if a.decisao_mudou),
            "removidas": len(self.removidas),
            "inalteradas": len(self.inalteradas),
            "nao_alocar": sum(1 for e in propostas if e.decisao == NAO_ALOCAR),
            "contexto": sum(1 for e in propostas if e.decisao == CONTEXTO),
            "confirmadas": sum(1 for e in propostas if e.confirmado_por_humano),
            "total": len(propostas),
        }

    def tem_mudanca(self) -> bool:
        """Nada mudou -> o portal não precisa nem abrir o painel de confirmação."""
        return bool(self.novas or self.alteradas or self.removidas)

    def para_dict(self) -> dict[str, Any]:
        return {
            "resumo": self.resumo(),
            "novas": [e.para_dict() for e in self.novas],
            "alteradas": [a.para_dict() for a in self.alteradas],
            "removidas": [e.para_dict() for e in self.removidas],
        }


def diff_memoria(
    anterior: Sequence[EntradaMemoria], nova: Sequence[EntradaMemoria]
) -> DiffMemoria:
    """Compara duas memórias por chave normalizada. LÓGICA PURA, sem banco.

    Uma entrada é ALTERADA quando a chave é a mesma e o destino OU a decisão
    difere. Incluir a decisão na comparação é essencial: "antes alocava em
    Mútuo Financeiro, agora está marcada como não alocar" é a mudança mais
    importante que existe aqui, e comparar só o destino a classificaria como
    inalterada (o destino velho continua ali no registro antigo).

    A comparação de destino é NORMALIZADA - "Mútuo Financeiro" e "MUTUO
    FINANCEIRO" são o mesmo destino, e mostrar isso ao analista como "7
    alteradas" seria ruído que o treina a aprovar o painel sem ler.
    """
    antes = _dedupe(anterior)
    depois = _dedupe(nova)
    diff = DiffMemoria()

    for chave, entrada in depois.items():
        velha = antes.get(chave)
        if velha is None:
            diff.novas.append(entrada)
            continue
        alteracao = Alteracao(chave=chave, de=velha, para=entrada)
        if alteracao.campos:
            diff.alteradas.append(alteracao)
        else:
            diff.inalteradas.append(entrada)

    diff.removidas.extend(e for chave, e in antes.items() if chave not in depois)
    return diff


# ------------------------------------------------------------- aplicar memória
def indexar(memoria: Iterable[EntradaMemoria]) -> dict[Chave, EntradaMemoria]:
    """Índice por chave normalizada, pronto para `buscar_entrada`."""
    return _dedupe(memoria)


def buscar_entrada(
    indice: Mapping[Chave, EntradaMemoria],
    origem: object,
    grupo: object = "",
    sub_categoria: object = "",
) -> EntradaMemoria | None:
    """Melhor decisão para uma origem. LÓGICA PURA.

    Duas passadas:
      1. chave exata `(origem, grupo, sub)`;
      2. mesma origem com grupo/sub COMPATÍVEIS - vazio de um dos lados é
         curinga, valor diferente nos dois lados é veto.

    O veto implementa a regra absoluta do projeto: Ativo só vai para Ativo. Sem
    ele, uma decisão tomada no Passivo vazaria para uma conta homônima do Ativo
    e furaria a identidade Ativo = Passivo + PL - o único erro capaz de quebrar
    o balanço sem aparecer no QA.

    Desempate: quem o humano confirmou vence; depois, a regra mais específica
    (com grupo/sub preenchidos), porque foi tomada com mais contexto.
    """
    chave = chave_de(origem, grupo, sub_categoria)
    exata = indice.get(chave)
    if exata is not None:
        return exata

    origem_norm, grupo_norm, sub_norm = chave
    if not origem_norm:
        return None

    def compativel(a: str, b: str) -> bool:
        return not (a and b and a != b)

    candidatos = [
        e
        for (o, g, s), e in indice.items()
        if o == origem_norm and compativel(grupo_norm, g) and compativel(sub_norm, s)
    ]
    if not candidatos:
        return None
    candidatos.sort(
        key=lambda e: (
            not e.confirmado_por_humano,
            not (normalizar(e.grupo) and normalizar(e.sub_categoria)),
        )
    )
    return candidatos[0]


def aplicar_memoria(
    linhas: Sequence[Mapping[str, Any]], memoria: Sequence[EntradaMemoria]
) -> dict[str, Any]:
    """Simula a memória sobre as linhas de um documento novo. LÓGICA PURA.

    NÃO MUTA `linhas`: devolve um PLANO. Quem decide aplicar é a camada de cima,
    e o portal mostra o plano ao analista antes.

    Quatro destinos possíveis para cada linha:

      aplicados   memória diz `alocar` -> a linha receberia este destino
      bloqueados  memória diz `nao_alocar`/`contexto` -> a linha seria marcada
                  como NÃO alocada e ficaria imune às camadas automáticas.
                  ESTE É O GANHO SOBRE O v1: a retirada feita pelo analista no
                  mês passado se reaproveita sozinha, em vez de o dicionário
                  realocar a mesma conta e obrigar ao mesmo trabalho manual.
      preservados a linha já tem destino, ou o humano já a retirou nesta sessão
                  (`noAuto`). Decisão existente nunca é sobrescrita - no v1 uma
                  passada do dicionário depois da revisão desfazia correção
                  manual.
      sem_regra   a memória não tem opinião; segue para dicionário e julgamental

    O campo `motivo` de cada bloqueio é o texto que a Rastreabilidade exporta:
    "por que esta linha não foi alocada" precisa ser respondível.
    """
    indice = indexar(memoria)
    plano: dict[str, list[dict[str, Any]]] = {
        "aplicados": [],
        "bloqueados": [],
        "preservados": [],
        "sem_regra": [],
    }

    for posicao, linha in enumerate(linhas or ()):
        origem = _texto(linha, "origem")
        if not origem:
            continue
        grupo = _texto(linha, "grupo")
        sub = _texto(linha, "sub_categoria", "subCategoria")
        base = {
            "id": _texto(linha, "id") or str(posicao),
            "origem": origem,
            "grupo": grupo,
            "sub_categoria": sub,
        }

        destino_atual = _texto(linha, "destino")
        if destino_atual or _bool(linha, "no_auto", "noAuto"):
            plano["preservados"].append(
                {**base, "destino": destino_atual, "motivo": "decisão já existente"}
            )
            continue

        entrada = buscar_entrada(indice, origem, grupo, sub)
        if entrada is None:
            plano["sem_regra"].append(base)
            continue

        if entrada.decisao == ALOCAR:
            if not entrada.destino:
                # Regra inconsistente: 'alocar' sem destino não aloca nada.
                # No v1 isso era aplicado e produzia chave órfã na Shadow - a
                # linha "alocada" sem destino desaparecia do somatório.
                plano["sem_regra"].append(
                    {**base, "motivo": "memória com decisão 'alocar' e destino vazio"}
                )
                continue
            plano["aplicados"].append(
                {
                    **base,
                    "destino": entrada.destino,
                    "grupo": entrada.grupo or grupo,
                    "sub_categoria": entrada.sub_categoria or sub,
                    "confirmado_por_humano": entrada.confirmado_por_humano,
                    "tipo_mapeamento": "Memória",
                }
            )
            continue

        plano["bloqueados"].append(
            {
                **base,
                "destino": "",
                "decisao": entrada.decisao,
                "confirmado_por_humano": entrada.confirmado_por_humano,
                "motivo": f"Memória: decisão anterior do analista ({entrada.decisao})",
            }
        )

    return {
        **plano,
        "resumo": {nome: len(itens) for nome, itens in plano.items()},
    }


# ------------------------------------------------------------------ promoção
def entradas_promoviveis(entradas: Iterable[EntradaMemoria]) -> list[EntradaMemoria]:
    """Filtro do que pode virar regra GLOBAL. LÓGICA PURA, testável sem banco.

    Passa só `decisao == 'alocar'` E `confirmado_por_humano` E destino não vazio.

    POR QUE O FILTRO É TÃO ESTREITO: no v1 um trigger de banco aprendia de TUDO
    que era gravado, incluindo sugestão de LLM que ninguém revisou. Um único
    erro de julgamento entrava no dicionário global e se propagava para a
    carteira inteira, em todas as análises seguintes, sem nenhum humano ter
    aprovado - e sem registro de quando entrou.

    E por que `nao_alocar` NUNCA sobe, mesmo confirmada: ela é específica do
    cliente. "Nesta SPE, adiantamento a sócios não é mútuo" é verdade sobre
    ESTA empresa; promovida a global, bloquearia a alocação correta em todas as
    outras. Decisão negativa vive em `memoria_cliente` e só lá.

    Extraída como função separada de propósito: assim o teste do filtro roda
    sem banco, e o de escrita (que precisa de Postgres) fica isolado e pode dar
    skip. Regra de negócio testável não deve depender de infraestrutura.
    """
    return [
        e
        for e in entradas
        if e.decisao == ALOCAR and e.confirmado_por_humano and e.destino.strip()
    ]


# ============================================================================
# A PARTIR DAQUI: PERSISTÊNCIA. Requer DATABASE_URL e psycopg.
# ============================================================================
# Casts `::uuid` explícitos em todo parâmetro de id: o driver manda `str` como
# texto, e `uuid = text` não tem operador no Postgres. O cast no SQL é
# idempotente (aceita str e uuid.UUID) e mantém o parâmetro ligado, sem
# nenhuma interpolação de dado do usuário na string.

_COLUNAS_ENTRADA = "origem, destino, grupo, sub_categoria, decisao, confirmado_por_humano"

_SQL_REVISAO_ATUAL = """
select coalesce(max(revisao), 0) as revisao
  from memoria_cliente
 where cliente_id = %(cliente_id)s::uuid
   and (%(usuario_id)s::uuid is null or usuario_id = %(usuario_id)s::uuid)
"""

_SQL_CARREGAR = f"""
select {_COLUNAS_ENTRADA}
  from memoria_cliente
 where cliente_id = %(cliente_id)s::uuid
   and revisao = %(revisao)s
   and (%(usuario_id)s::uuid is null or usuario_id = %(usuario_id)s::uuid)
 order by origem_norm
"""

_SQL_VEZES = """
select origem_norm, grupo_norm, sub_norm, vezes
  from memoria_cliente
 where cliente_id = %(cliente_id)s::uuid and revisao = %(revisao)s
"""

_SQL_INSERIR_ENTRADA = """
insert into memoria_cliente (
    usuario_id, cliente_id, revisao, origem, origem_norm,
    grupo, grupo_norm, sub_categoria, sub_norm,
    destino, decisao, confirmado_por_humano, analise_id, vezes)
values (
    %(usuario_id)s::uuid, %(cliente_id)s::uuid, %(revisao)s, %(origem)s, %(origem_norm)s,
    %(grupo)s, %(grupo_norm)s, %(sub_categoria)s, %(sub_norm)s,
    %(destino)s, %(decisao)s, %(confirmado_por_humano)s, %(analise_id)s::uuid, %(vezes)s)
"""

_SQL_INSERIR_REVISAO = """
insert into memoria_revisoes (
    cliente_id, revisao, analise_id, novas, alteradas, removidas, confirmadas, observacao)
values (
    %(cliente_id)s::uuid, %(revisao)s, %(analise_id)s::uuid,
    %(novas)s, %(alteradas)s, %(removidas)s, %(confirmadas)s, %(observacao)s)
"""

_SQL_EVENTO = """
insert into eventos (usuario_id, analise_id, tipo, payload)
values (%(usuario_id)s::uuid, %(analise_id)s::uuid, %(tipo)s, %(payload)s::jsonb)
"""


def _revisao_atual(cur: Any, cliente_id: str, usuario_id: str | None = None) -> int:
    cur.execute(_SQL_REVISAO_ATUAL, {"cliente_id": cliente_id, "usuario_id": usuario_id})
    reg = cur.fetchone()
    return int(reg["revisao"]) if reg else 0


def _carregar(
    cur: Any, cliente_id: str, revisao: int, usuario_id: str | None = None
) -> list[EntradaMemoria]:
    cur.execute(
        _SQL_CARREGAR,
        {"cliente_id": cliente_id, "revisao": revisao, "usuario_id": usuario_id},
    )
    return [EntradaMemoria.de_dict(reg) for reg in cur.fetchall()]


def carregar_memoria(
    cliente_id: str, *, revisao: int | None = None, usuario_id: str | None = None
) -> list[EntradaMemoria]:
    """Memória de um cliente. Sem `revisao`, a ÚLTIMA (`max(revisao)`).

    `usuario_id` é opcional na assinatura mas a API deve SEMPRE passá-lo: é o
    que impede um `cliente_id` adivinhado de vazar a memória de outro analista.
    Sem ele a função confia em quem chamou.
    """
    with conexao.conectar() as conn, conn.cursor() as cur:
        alvo = revisao if revisao is not None else _revisao_atual(cur, cliente_id, usuario_id)
        if alvo <= 0:
            return []
        return _carregar(cur, cliente_id, alvo, usuario_id)


def salvar_revisao(
    usuario_id: str,
    cliente_id: str,
    entradas: Sequence[EntradaMemoria],
    *,
    analise_id: str | None = None,
    observacao: str | None = None,
) -> dict[str, Any]:
    """Grava uma revisão NOVA (`max+1`) e registra o resumo do diff.

    Nunca faz UPDATE nem DELETE na memória existente. Consequências desejadas:
    a revisão anterior continua legível (auditoria: "o que foi decidido na
    análise de março?") e reverter é ler a revisão N-1 e regravá-la como N+1,
    sem perder o caminho. O custo é espaço em disco, que é barato; o benefício é
    a prova da decisão, que não tem preço quando o cliente questiona um número.

    Tudo numa transação só: uma revisão gravada pela metade seria uma memória
    mentirosa - pior que memória nenhuma, porque parece completa.
    """
    propostas = list(entradas)
    with conexao.conectar() as conn, conn.cursor() as cur:
        anterior_rev = _revisao_atual(cur, cliente_id, usuario_id)
        # Lê a revisão anterior DENTRO da transação: calcular o diff fora dela
        # abriria janela para outra gravação entrar no meio e o resumo gravado
        # descrever uma comparação que nunca existiu.
        anterior = _carregar(cur, cliente_id, anterior_rev, usuario_id) if anterior_rev else []
        diff = diff_memoria(anterior, propostas)
        nova_rev = anterior_rev + 1

        # `vezes` acumula quantas revisões seguidas confirmaram a mesma decisão.
        # É o sinal de confiança que o matching usa para desempatar: regra
        # reconfirmada cinco meses seguidos vale mais que palpite de ontem.
        vezes_antes = {}
        if anterior_rev:
            cur.execute(_SQL_VEZES, {"cliente_id": cliente_id, "revisao": anterior_rev})
            vezes_antes = {
                (reg["origem_norm"], reg["grupo_norm"], reg["sub_norm"]):
                    int(reg["vezes"] or 1)
                for reg in cur.fetchall()
            }

        registros = []
        for entrada in _dedupe(propostas).values():
            origem_norm, grupo_norm, sub_norm = entrada.chave
            registros.append(
                {
                    "usuario_id": usuario_id,
                    "cliente_id": cliente_id,
                    "revisao": nova_rev,
                    "origem": entrada.origem,
                    "origem_norm": origem_norm,
                    "grupo": entrada.grupo,
                    "grupo_norm": grupo_norm,
                    "sub_categoria": entrada.sub_categoria,
                    "sub_norm": sub_norm,
                    "destino": entrada.destino,
                    "decisao": entrada.decisao,
                    "confirmado_por_humano": entrada.confirmado_por_humano,
                    "analise_id": analise_id,
                    "vezes": vezes_antes.get(entrada.chave, 0) + 1,
                }
            )
        if registros:
            cur.executemany(_SQL_INSERIR_ENTRADA, registros)

        resumo = diff.resumo()
        cur.execute(
            _SQL_INSERIR_REVISAO,
            {
                "cliente_id": cliente_id,
                "revisao": nova_rev,
                "analise_id": analise_id,
                "novas": resumo["novas"],
                "alteradas": resumo["alteradas"],
                "removidas": resumo["removidas"],
                "confirmadas": resumo["confirmadas"],
                "observacao": observacao,
            },
        )
        # Evento na MESMA transação: trilha que pode divergir do fato não serve
        # como trilha.
        cur.execute(
            _SQL_EVENTO,
            {
                "usuario_id": usuario_id,
                "analise_id": analise_id,
                "tipo": "memoria.revisao_salva",
                "payload": json.dumps(
                    {"cliente_id": str(cliente_id), "revisao": nova_rev, "diff": resumo},
                    ensure_ascii=False,
                ),
            },
        )

    logger.info(
        "memória do cliente %s: revisão %d gravada (%d entradas) %s",
        cliente_id, nova_rev, len(registros), resumo,
    )
    return {
        "cliente_id": str(cliente_id),
        "revisao": nova_rev,
        "revisao_anterior": anterior_rev,
        "gravadas": len(registros),
        "diff": resumo,
    }


def promover_ao_dicionario(
    usuario_id: str, entradas: Sequence[EntradaMemoria]
) -> dict[str, int]:
    """Sobe para `dicionario_global` só o que `entradas_promoviveis` liberar.

    A regra de negócio (o filtro) é pura e testada sem banco; aqui só há
    escrita. Ver `entradas_promoviveis` para o porquê do filtro estreito.
    """
    from . import repo  # import local: repo importa este módulo em upsert_dicionario

    # Materializa antes de filtrar: `entradas` pode ser um gerador, e contar
    # depois de consumir daria `ignoradas = 0` - número errado num relatório de
    # auditoria é pior que número ausente.
    todas = list(entradas)
    promoviveis = entradas_promoviveis(todas)
    total = len(todas)
    if not promoviveis:
        logger.info("nada a promover ao dicionário (%d entradas avaliadas)", total)
        return {"promovidas": 0, "ignoradas": total}

    repo.upsert_dicionario(
        usuario_id,
        [
            {
                "chave": chave_dicionario(e),
                "origem": e.origem,
                "destino": e.destino,
                "grupo": e.grupo,
                "sub_categoria": e.sub_categoria,
                "fonte": "memoria",
                "confirmado_por_humano": True,
            }
            for e in promoviveis
        ],
    )
    logger.info(
        "promovidas %d de %d entradas ao dicionário global do usuário %s",
        len(promoviveis), total, usuario_id,
    )
    return {"promovidas": len(promoviveis), "ignoradas": total - len(promoviveis)}
