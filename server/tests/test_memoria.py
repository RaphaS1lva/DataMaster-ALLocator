"""Testes da memória do cliente. A MAIORIA RODA SEM BANCO.

Isto não é acidente de conveniência: a regra de negócio desta camada é
`normalizar`, `diff_memoria`, `aplicar_memoria` e `entradas_promoviveis` - lógica
pura, sem I/O. Regra de negócio que só pode ser verificada com Postgres em pé é
regra que ninguém verifica.

O teste mais importante do arquivo é
`test_decisao_negativa_bloqueia_em_vez_de_alocar`: ele descreve exatamente o que
o v1 não conseguia fazer. Lá a exportação de memória só pegava linhas alocadas
com destino, então quando o analista RETIRAVA uma conta a informação era jogada
fora - e na análise do mês seguinte o dicionário realocava a mesma conta no
mesmo lugar errado. Aqui a retirada é uma entrada de primeira classe
(`decisao='nao_alocar'`) e volta sozinha na análise seguinte.

Os testes que exigem Postgres chamam `_exige_banco()`, que dá `skip` quando não
há `DATABASE_URL`. Nesta máquina de desenvolvimento não há (proxy corporativo
bloqueia o PyPI, então nem o psycopg está instalado) - e o import de psycopg é
lazy justamente para que este arquivo seja importável de todo modo.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest

# `server` no sys.path para importar `app.db.*` sem instalar o pacote.
RAIZ_SERVIDOR = Path(__file__).resolve().parents[1]
if str(RAIZ_SERVIDOR) not in sys.path:
    sys.path.insert(0, str(RAIZ_SERVIDOR))

from app.db import conexao  # noqa: E402
from app.db import memoria as mem  # noqa: E402

CAMINHO_SCHEMA = RAIZ_SERVIDOR / "app" / "db" / "schema.sql"
CAMINHO_REPO = RAIZ_SERVIDOR / "app" / "db" / "repo.py"

#: Hash bcrypt de fachada para os testes de banco: a coluna é `text` e o que
#: está sob teste é a memória, não a autenticação. Assim os testes de banco não
#: passam a depender do bcrypt estar instalado.
HASH_FALSO = "$2b$12$" + "x" * 53


# --------------------------------------------------------------------- helpers
def ent(
    origem: str,
    destino: str = "",
    grupo: str = "Ativo",
    sub: str = "Circulante",
    decisao: str = mem.ALOCAR,
    confirmado: bool = True,
) -> mem.EntradaMemoria:
    """Construtor curto. Padrão = decisão positiva confirmada pelo analista."""
    return mem.EntradaMemoria(
        origem=origem,
        destino=destino,
        grupo=grupo,
        sub_categoria=sub,
        decisao=decisao,
        confirmado_por_humano=confirmado,
    )


def linha(origem: str, **campos: Any) -> dict[str, Any]:
    """Linha de documento no formato do portal (camelCase em `subCategoria`)."""
    base: dict[str, Any] = {
        "id": f"L-{origem[:6]}",
        "origem": origem,
        "destino": "",
        "grupo": "Ativo",
        "subCategoria": "Circulante",
    }
    base.update(campos)
    return base


def _exige_banco() -> None:
    """Pula o teste quando não há Postgres configurado.

    Skip e não falha: teste vermelho por falta de infraestrutura treina o time a
    ignorar teste vermelho, e aí o vermelho de verdade passa batido.
    """
    if not conexao.esta_configurado():
        pytest.skip("DATABASE_URL não definida - teste de banco real")


def _schema() -> str:
    return CAMINHO_SCHEMA.read_text(encoding="utf-8")


def _compacto(texto: str) -> str:
    """Minúsculas com espaços colapsados: asserção de SQL não deve depender de
    onde alguém resolveu quebrar a linha."""
    return re.sub(r"\s+", " ", texto).lower()


# =============================================================================
# normalizar - CONTRATO com normalizeText (JS) e dm_normalize (SQL)
# =============================================================================
# Mesmos casos de portal/src/core/normalize.js. Divergir aqui foi o bug mais
# caro do v1: chaves diferentes para a mesma conta duplicavam linhas no
# dicionário e a regra aprendida nunca vencia o seed.
CASOS_JS: list[tuple[Any, str]] = [
    ("Mútuo Financeiro L/P", "mutuo financeiro l p"),
    ("ICMS s/ vendas", "icms s vendas"),
    ("(-) PREJUIZOS ACUMULADOS", "prejuizos acumulados"),
    ("Adiantamento a Sócios/Diretores", "adiantamento a socios diretores"),
    ("Imobilizado (líquido)", "imobilizado liquido"),
    ("IRPJ/CSLL a recolher", "irpj csll a recolher"),
    ("  Caixa   e    Equivalentes  ", "caixa e equivalentes"),
    ("Provisão p/ Férias", "provisao p ferias"),
    ("", ""),
    (None, ""),
    (123, "123"),
]


@pytest.mark.parametrize("bruto,esperado", CASOS_JS)
def test_normalizar_casa_com_os_casos_do_js(bruto: Any, esperado: str) -> None:
    assert mem.normalizar(bruto) == esperado


def test_normalizar_pontuacao_vira_espaco_e_nao_vazio() -> None:
    """`l/p` -> `l p`, nunca `lp`.

    Colapsar em vazio grudaria tokens ("s/ vendas" -> "svendas") e destruiria o
    overlap de tokens de que o matching parcial depende.
    """
    assert mem.normalizar("Mútuo Financeiro L/P") == "mutuo financeiro l p"
    assert "lp" not in mem.normalizar("Mútuo Financeiro L/P")


@pytest.mark.parametrize(
    "a,b",
    [
        ("MÚTUO FINANCEIRO L/P", "mutuo financeiro l/p"),
        ("Provisão", "PROVISAO"),
        ("Depósitos Judiciais", "depositos judiciais"),
        ("ICMS S/ VENDAS", "icms s/ vendas"),
        ("Ágio", "agio"),
    ],
)
def test_caixa_e_acento_nao_geram_chaves_diferentes(a: str, b: str) -> None:
    assert mem.normalizar(a) == mem.normalizar(b)


def test_chave_de_normaliza_os_tres_componentes() -> None:
    assert mem.chave_de("Caixa Geral", "ATIVO", "Não Circulante") == (
        "caixa geral", "ativo", "nao circulante",
    )


# =============================================================================
# diff_memoria - alimenta o painel de confirmação (salvamento OPT-IN)
# =============================================================================
def test_diff_detecta_entrada_nova() -> None:
    diff = mem.diff_memoria([], [ent("Caixa Geral", "Caixa")])
    assert len(diff.novas) == 1
    assert diff.novas[0].origem == "Caixa Geral"
    assert diff.alteradas == [] and diff.removidas == [] and diff.inalteradas == []


def test_diff_detecta_destino_alterado() -> None:
    antes = [ent("Adiantamento a sócios", "Mútuo Financeiro")]
    depois = [ent("Adiantamento a sócios", "Adiantamento a Fornecedores")]
    diff = mem.diff_memoria(antes, depois)

    assert len(diff.alteradas) == 1
    alteracao = diff.alteradas[0]
    # `de`/`para` existem para o painel poder mostrar "X -> Y": sem o lado
    # antigo o analista não tem como julgar se aprova a mudança.
    assert alteracao.de.destino == "Mútuo Financeiro"
    assert alteracao.para.destino == "Adiantamento a Fornecedores"
    assert alteracao.destino_mudou is True
    assert alteracao.decisao_mudou is False
    assert alteracao.campos == ["destino"]
    assert diff.novas == [] and diff.removidas == []


def test_diff_detecta_decisao_alterada_de_alocar_para_nao_alocar() -> None:
    """A mudança mais importante que existe aqui.

    Comparar apenas o destino classificaria isto como "inalterada", porque o
    destino antigo continua gravado no registro velho. É por isso que
    `diff_memoria` compara destino OU decisão.
    """
    antes = [ent("Adiantamento a sócios", "Mútuo Financeiro")]
    depois = [ent("Adiantamento a sócios", "", decisao=mem.NAO_ALOCAR)]
    diff = mem.diff_memoria(antes, depois)

    assert len(diff.alteradas) == 1
    alteracao = diff.alteradas[0]
    assert alteracao.decisao_mudou is True
    assert "decisao" in alteracao.campos
    assert alteracao.de.decisao == mem.ALOCAR
    assert alteracao.para.decisao == mem.NAO_ALOCAR
    assert diff.inalteradas == []


def test_diff_detecta_removida() -> None:
    antes = [ent("Conta que saiu do plano", "Caixa")]
    diff = mem.diff_memoria(antes, [])
    assert len(diff.removidas) == 1
    assert diff.removidas[0].origem == "Conta que saiu do plano"


def test_diff_detecta_inalterada_mesmo_com_grafia_diferente() -> None:
    """Diferença só de caixa/acento NÃO é mudança.

    Contá-la como alteração encheria o painel de ruído e ensinaria o analista a
    aprovar sem ler - que é o oposto do objetivo do salvamento opt-in.
    """
    antes = [ent("Adiantamento a sócios", "Mútuo Financeiro")]
    depois = [ent("ADIANTAMENTO A SOCIOS", "MUTUO FINANCEIRO")]
    diff = mem.diff_memoria(antes, depois)
    assert len(diff.inalteradas) == 1
    assert diff.alteradas == [] and diff.novas == [] and diff.removidas == []


def test_resumo_do_diff_tem_as_contagens_certas() -> None:
    """Os números que o painel de confirmação exibe:

        Salvar memória de SPE (exemplo)?   [x]
          -> N regras novas
          -> N alteradas (destino mudou)
          -> N marcadas "não alocar"
          -> N confirmadas sem mudança
    """
    antes = [
        ent("Caixa Geral", "Caixa"),                                   # inalterada
        ent("Adiantamento a sócios", "Mútuo Financeiro"),              # destino muda
        ent("Reserva de lucros", "Outras Reservas", grupo="Passivo", sub="PL"),
        ent("Conta extinta", "Caixa"),                                 # removida
    ]
    depois = [
        ent("Caixa Geral", "Caixa"),
        ent("Adiantamento a sócios", "Adiantamento a Fornecedores"),
        ent("Reserva de lucros", "", grupo="Passivo", sub="PL",
            decisao=mem.NAO_ALOCAR),                                   # decisão muda
        ent("Depósitos judiciais", "Depósitos Judiciais", sub="Não Circulante"),
    ]
    resumo = mem.diff_memoria(antes, depois).resumo()

    assert resumo["novas"] == 1
    assert resumo["alteradas"] == 2
    assert resumo["destino_mudou"] == 1
    assert resumo["decisao_mudou"] == 1
    assert resumo["removidas"] == 1
    assert resumo["inalteradas"] == 1
    assert resumo["nao_alocar"] == 1
    assert resumo["contexto"] == 0
    assert resumo["confirmadas"] == 4
    assert resumo["total"] == 4


def test_resumo_separa_destino_de_decisao() -> None:
    """As duas contagens são DISJUNTAS.

    Uma entrada que virou `nao_alocar` também perdeu o destino; contá-la nas
    duas linhas do painel infla os números e mina a confiança neles.
    """
    antes = [ent("X", "Caixa")]
    depois = [ent("X", "", decisao=mem.NAO_ALOCAR)]
    resumo = mem.diff_memoria(antes, depois).resumo()
    assert resumo["decisao_mudou"] == 1
    assert resumo["destino_mudou"] == 0
    assert resumo["alteradas"] == 1


def test_diff_sem_mudanca_nao_abre_painel() -> None:
    igual = [ent("Caixa Geral", "Caixa")]
    assert mem.diff_memoria(igual, list(igual)).tem_mudanca() is False
    assert mem.diff_memoria(igual, []).tem_mudanca() is True


def test_diff_dedupe_ultima_decisao_vence() -> None:
    """Mesma origem mexida duas vezes na sessão: vale a última palavra.

    Mesma regra de `memoriaDeRows` no portal. Sem o dedupe, a gravação violaria
    a UNIQUE `(cliente_id, revisao, origem_norm, grupo_norm, sub_norm)`.
    """
    diff = mem.diff_memoria([], [ent("Caixa", "Errado"), ent("CAIXA", "Caixa")])
    assert len(diff.novas) == 1
    assert diff.novas[0].destino == "Caixa"


# =============================================================================
# aplicar_memoria - a prova de que a decisão negativa é reaproveitada
# =============================================================================
def test_aplicar_memoria_preenche_destino_de_linha_de_mesmo_nome() -> None:
    plano = mem.aplicar_memoria(
        [linha("Caixa Geral")], [ent("Caixa Geral", "Caixa")]
    )
    assert plano["resumo"]["aplicados"] == 1
    aplicado = plano["aplicados"][0]
    assert aplicado["destino"] == "Caixa"
    assert aplicado["origem"] == "Caixa Geral"
    assert aplicado["tipo_mapeamento"] == "Memória"
    assert plano["bloqueados"] == []


def test_decisao_negativa_bloqueia_em_vez_de_alocar() -> None:
    """*** TESTE CENTRAL - O QUE O v1 NÃO CONSEGUIA PASSAR ***

    O analista retirou "Adiantamento a sócios" da linha de Mútuo Financeiro na
    análise passada. No v1 essa retirada não era exportada (só linhas alocadas
    COM destino iam para a memória), então o dicionário realocava a mesma conta
    no mês seguinte e o analista refazia o mesmo trabalho manual.

    Agora a decisão negativa está na memória e a linha é BLOQUEADA: não recebe
    destino e fica imune às camadas automáticas seguintes.
    """
    memoria = [ent("Adiantamento a sócios", "", decisao=mem.NAO_ALOCAR)]
    plano = mem.aplicar_memoria([linha("Adiantamento a sócios")], memoria)

    assert plano["resumo"]["bloqueados"] == 1
    assert plano["resumo"]["aplicados"] == 0
    assert plano["aplicados"] == []

    bloqueado = plano["bloqueados"][0]
    assert bloqueado["destino"] == ""           # nenhum destino foi inventado
    assert bloqueado["decisao"] == mem.NAO_ALOCAR
    assert "nao_alocar" in bloqueado["motivo"]  # motivo exportável na Rastreabilidade


def test_decisao_contexto_tambem_bloqueia() -> None:
    """Totalizador/linha informativa não é alocável - mesmo tratamento."""
    plano = mem.aplicar_memoria(
        [linha("Total do ativo circulante")],
        [ent("Total do ativo circulante", "", decisao=mem.CONTEXTO)],
    )
    assert plano["resumo"]["bloqueados"] == 1
    assert plano["bloqueados"][0]["decisao"] == mem.CONTEXTO


@pytest.mark.parametrize(
    "origem_memoria,origem_linha",
    [
        ("ADIANTAMENTO A SOCIOS", "Adiantamento a Sócios"),
        ("Adiantamento a Sócios", "adiantamento a socios"),
        ("ICMS s/ vendas", "ICMS  S/  VENDAS"),
        ("Mútuo Financeiro L/P", "MUTUO FINANCEIRO L P"),
    ],
)
def test_aplicar_memoria_casa_por_chave_normalizada(
    origem_memoria: str, origem_linha: str
) -> None:
    """Caixa e acento diferentes ainda casam - a chave é a normalizada."""
    plano = mem.aplicar_memoria(
        [linha(origem_linha, grupo="ATIVO", subCategoria="circulante")],
        [ent(origem_memoria, "Caixa", grupo="Ativo", sub="Circulante")],
    )
    assert plano["resumo"]["aplicados"] == 1
    assert plano["aplicados"][0]["destino"] == "Caixa"


def test_aplicar_memoria_nao_sobrescreve_destino_existente() -> None:
    """Decisão já tomada é intocável.

    No v1 uma passada do dicionário depois da revisão desfazia correção manual
    do analista, silenciosamente.
    """
    plano = mem.aplicar_memoria(
        [linha("Caixa Geral", destino="Bancos")], [ent("Caixa Geral", "Caixa")]
    )
    assert plano["resumo"]["aplicados"] == 0
    assert plano["resumo"]["preservados"] == 1
    assert plano["preservados"][0]["destino"] == "Bancos"


def test_aplicar_memoria_respeita_retirada_da_sessao_atual() -> None:
    """`noAuto` = o humano acabou de retirar; nenhuma camada automática realoca."""
    plano = mem.aplicar_memoria(
        [linha("Caixa Geral", noAuto=True)], [ent("Caixa Geral", "Caixa")]
    )
    assert plano["resumo"]["aplicados"] == 0
    assert plano["resumo"]["preservados"] == 1


def test_aplicar_memoria_veta_grupo_divergente() -> None:
    """Regra absoluta: Ativo só vai para Ativo.

    Uma conta homônima no Passivo não pode herdar decisão tomada no Ativo - é o
    único erro de julgamento capaz de furar Ativo = Passivo + PL.
    """
    plano = mem.aplicar_memoria(
        [linha("Juros a pagar", grupo="Ativo")],
        [ent("Juros a pagar", "Empréstimos", grupo="Passivo")],
    )
    assert plano["resumo"]["aplicados"] == 0
    assert plano["resumo"]["sem_regra"] == 1


def test_aplicar_memoria_grupo_vazio_na_memoria_e_curinga() -> None:
    """Entrada sem grupo casa com qualquer grupo: ausência não é divergência."""
    plano = mem.aplicar_memoria(
        [linha("Juros a pagar", grupo="Passivo", subCategoria="Circulante")],
        [ent("Juros a pagar", "Empréstimos", grupo="", sub="")],
    )
    assert plano["resumo"]["aplicados"] == 1


def test_aplicar_memoria_ignora_regra_alocar_sem_destino() -> None:
    """'alocar' sem destino não aloca nada.

    No v1 isso era aplicado e produzia chave órfã: a linha ficava "alocada" sem
    destino e o valor desaparecia do somatório da Shadow sem erro no QA.
    """
    plano = mem.aplicar_memoria(
        [linha("Conta esquisita")], [ent("Conta esquisita", "")]
    )
    assert plano["resumo"]["aplicados"] == 0
    assert plano["resumo"]["sem_regra"] == 1


def test_aplicar_memoria_sem_regra_quando_memoria_nao_opina() -> None:
    plano = mem.aplicar_memoria([linha("Conta inédita")], [ent("Outra coisa", "Caixa")])
    assert plano["resumo"]["sem_regra"] == 1
    assert plano["resumo"]["aplicados"] == 0


def test_aplicar_memoria_nao_muta_as_linhas() -> None:
    """Devolve PLANO, não efeito colateral: quem aplica é a camada de cima,
    depois de o analista ver o que vai acontecer."""
    linhas = [linha("Caixa Geral"), linha("Adiantamento a sócios")]
    copia = [dict(item) for item in linhas]
    mem.aplicar_memoria(
        linhas,
        [ent("Caixa Geral", "Caixa"),
         ent("Adiantamento a sócios", "", decisao=mem.NAO_ALOCAR)],
    )
    assert linhas == copia


def test_aplicar_memoria_com_memoria_vazia_nao_quebra() -> None:
    plano = mem.aplicar_memoria([linha("Caixa Geral")], [])
    assert plano["resumo"] == {
        "aplicados": 0, "bloqueados": 0, "preservados": 0, "sem_regra": 1,
    }


def test_aplicar_memoria_ignora_linha_sem_origem() -> None:
    plano = mem.aplicar_memoria([linha("", id="vazia")], [ent("Caixa", "Caixa")])
    assert sum(plano["resumo"].values()) == 0


# =============================================================================
# promoção ao dicionário global - o filtro, separado da escrita
# =============================================================================
def test_entradas_promoviveis_so_alocar_confirmado() -> None:
    entradas = [
        ent("Caixa Geral", "Caixa"),                                        # sobe
        ent("Sugerido pelo LLM", "Estoques", confirmado=False),             # não sobe
        ent("Retirada pelo analista", "", decisao=mem.NAO_ALOCAR),          # não sobe
        ent("Totalizador", "", decisao=mem.CONTEXTO),                       # não sobe
        ent("Alocar sem destino", ""),                                      # não sobe
    ]
    promoviveis = mem.entradas_promoviveis(entradas)
    assert [e.origem for e in promoviveis] == ["Caixa Geral"]


def test_promovivel_exige_confirmacao_humana() -> None:
    """Sugestão não revisada NUNCA vira regra global.

    No v1 um trigger aprendia de tudo que era gravado: um erro de julgamento do
    LLM entrava no dicionário e se propagava para a carteira inteira, em todas
    as análises seguintes, sem nenhum humano ter aprovado.
    """
    assert mem.entradas_promoviveis([ent("X", "Caixa", confirmado=False)]) == []
    assert len(mem.entradas_promoviveis([ent("X", "Caixa", confirmado=True)])) == 1


def test_nao_alocar_nunca_sobe_ao_dicionario_global() -> None:
    """Decisão negativa é ESPECÍFICA do cliente.

    "Nesta SPE, adiantamento a sócios não é mútuo" é verdade sobre esta empresa.
    Promovida a global, bloquearia a alocação correta em todas as outras.
    """
    confirmadas_negativas = [
        ent("A", "", decisao=mem.NAO_ALOCAR, confirmado=True),
        ent("B", "Caixa", decisao=mem.NAO_ALOCAR, confirmado=True),
        ent("C", "", decisao=mem.CONTEXTO, confirmado=True),
    ]
    assert mem.entradas_promoviveis(confirmadas_negativas) == []


def test_chave_dicionario_usa_o_formato_do_portal() -> None:
    """Mesmo formato de `aggKey` (portal/src/core/keys.js): normalizado e com `|`."""
    chave = mem.chave_dicionario(ent("Caixa Geral", "Caixa", "ATIVO", "Circulante"))
    assert chave == "caixa geral|ativo|circulante"


# =============================================================================
# EntradaMemoria - tolerância de grafia entre portal (camelCase) e banco (snake)
# =============================================================================
def test_entrada_de_dict_aceita_camel_e_snake() -> None:
    do_portal = mem.EntradaMemoria.de_dict(
        {"origem": "Caixa Geral", "destino": "Caixa", "grupo": "Ativo",
         "subCategoria": "Circulante", "decisao": "alocar",
         "confirmadoPorHumano": True}
    )
    do_banco = mem.EntradaMemoria.de_dict(
        {"origem": "Caixa Geral", "destino": "Caixa", "grupo": "Ativo",
         "sub_categoria": "Circulante", "decisao": "alocar",
         "confirmado_por_humano": True}
    )
    assert do_portal == do_banco
    assert do_portal.sub_categoria == "Circulante"


def test_entrada_de_dict_recusa_decisao_invalida() -> None:
    """Mesma trava do CHECK do banco, mas na borda da API.

    Falhar aqui dá mensagem útil; falhar no INSERT dá violação de constraint
    crua no meio de uma transação.
    """
    with pytest.raises(ValueError, match="decisão inválida"):
        mem.EntradaMemoria.de_dict({"origem": "X", "decisao": "talvez"})


def test_entrada_sem_decisao_assume_alocar() -> None:
    assert mem.EntradaMemoria.de_dict({"origem": "X"}).decisao == mem.ALOCAR


# =============================================================================
# schema.sql - lido como texto, sem banco
# =============================================================================
def test_schema_define_dm_normalize() -> None:
    sql = _compacto(_schema())
    assert "create or replace function public.dm_normalize(txt text)" in sql
    assert "immutable" in sql


def test_dm_normalize_remove_pontuacao_com_dois_regexp_replace() -> None:
    """O conserto do bug do v1.

    Lá o trigger fazia só `lower(unaccent(...))`: a pontuação sobrevivia e
    "ICMS s/ vendas" gerava chave diferente da do portal, criando linhas
    duplicadas que nunca sobrescreviam o seed.
    """
    sql = _compacto(_schema())
    assert sql.count("regexp_replace") >= 2, "faltam os dois replace encadeados"
    assert "unaccent(lower(coalesce(txt, '')))" in sql
    assert "'[^a-z0-9[:space:]]'" in sql   # pontuação -> espaço
    assert "'[[:space:]]+'" in sql         # colapsa espaços


def test_schema_cria_unaccent_antes_da_funcao() -> None:
    """Ordem importa: a função depende da extensão existir.

    E `with schema public` porque provedor que isola extensões em outro schema
    faria `dm_normalize` quebrar em tempo de execução, não no deploy.
    """
    sql = _compacto(_schema())
    pos_ext = sql.find("create extension if not exists unaccent")
    pos_fn = sql.find("function public.dm_normalize")
    assert pos_ext != -1 and pos_fn != -1
    assert pos_ext < pos_fn
    assert "with schema public" in sql
    assert "set search_path = public" in sql


@pytest.mark.parametrize("extensao", ["unaccent", "citext", "pgcrypto"])
def test_schema_declara_extensoes(extensao: str) -> None:
    assert f"create extension if not exists {extensao}" in _compacto(_schema())


def test_schema_tem_check_de_decisao() -> None:
    assert "check (decisao in ('alocar','nao_alocar','contexto'))" in _compacto(_schema())


def test_schema_tem_check_de_status() -> None:
    """No v1 isto era só um comentário na coluna, sem trava nenhuma - e o banco
    acumulou 'draft', 'Rascunho' e '' convivendo, com o filtro da lista
    escondendo trabalho do analista."""
    assert "check (status in ('rascunho','em_revisao','concluida'))" in _compacto(_schema())


def test_schema_tem_unique_de_memoria_cliente() -> None:
    assert (
        "unique (cliente_id, revisao, origem_norm, grupo_norm, sub_norm)"
        in _compacto(_schema())
    )


def test_schema_tem_unique_de_memoria_revisoes() -> None:
    assert "unique (cliente_id, revisao)" in _compacto(_schema())


def test_schema_tem_unique_composta_do_dicionario() -> None:
    assert "unique (usuario_id, chave)" in _compacto(_schema())


def test_schema_indexa_memoria_por_revisao_desc() -> None:
    assert "on memoria_cliente (cliente_id, revisao desc)" in _compacto(_schema())


@pytest.mark.parametrize(
    "proibido",
    ["auth.uid", "auth.users", "enable row level security", "create policy",
     "supabase", "anon key"],
)
def test_schema_nao_tem_nada_de_supabase(proibido: str) -> None:
    """Postgres puro. A segurança vem da API, que filtra por `usuario_id`.

    O portal não fala mais com o banco, então não existe usuário de sessão para
    uma política de linha consultar.
    """
    assert proibido not in _compacto(_schema())


def test_repo_declara_conflito_nas_duas_colunas_da_unique() -> None:
    """O bug 42P10 do v1.

    Lá o upsert declarava `onConflict: 'chave'` contra a UNIQUE composta
    `(user_id, chave)`. O Postgres responde "no unique or exclusion constraint
    matching the ON CONFLICT specification", e o erro caía num catch vazio: o
    portal dizia "salvo" e o aprendizado do dicionário era um no-op silencioso.
    """
    repo_sql = _compacto(CAMINHO_REPO.read_text(encoding="utf-8"))
    assert "on conflict (usuario_id, chave) do update" in repo_sql
    assert "on conflict (chave) do" not in repo_sql


def test_listar_analises_nao_traz_os_jsonb_pesados() -> None:
    """Listar 200 análises com `linhas`/`qa`/`trilha` era o que fazia a tela
    inicial do v1 baixar centenas de megabytes."""
    fonte = CAMINHO_REPO.read_text(encoding="utf-8")
    bloco = fonte.split("_COLUNAS_ANALISE_LISTA = ")[1].split('"""')[1]
    # Compara NOMES, não substrings: `n_linhas` contém "linhas" e passaria por
    # engano num `not in` sobre o texto solto.
    colunas = {c.strip() for c in bloco.replace("\n", " ").split(",")}
    for pesado in ("linhas", "qa", "trilha"):
        assert pesado not in colunas, f"coluna pesada na lista: {pesado}"
    assert "id" in colunas and "n_linhas" in colunas


# =============================================================================
# Banco real - skip sem DATABASE_URL
# =============================================================================
@pytest.fixture
def cliente_temporario() -> Any:
    """Usuário + cliente descartáveis. Fixture GERADORA: limpa no teardown.

    Apagar o usuário derruba cliente, análises e memória em cascata (ver as FKs
    de `schema.sql`), então uma linha de limpeza basta e não sobra lixo capaz de
    fazer o próximo teste passar por acidente.
    """
    _exige_banco()
    from app.db import repo

    email = f"teste-memoria-{uuid4().hex[:10]}@allocator.local"
    usuario = repo.criar_usuario(email, HASH_FALSO, "Teste Memória")
    cliente = repo.upsert_cliente(str(usuario["id"]), {"nome": "SPE (exemplo)"})
    try:
        yield {"usuario_id": str(usuario["id"]), "cliente_id": str(cliente["id"])}
    finally:
        conexao.executar(
            "delete from usuarios where id = %s::uuid", (str(usuario["id"]),)
        )


def test_schema_aplica_de_forma_idempotente() -> None:
    """Rodar duas vezes não pode falhar: `aplicar_schema` roda no boot da API."""
    _exige_banco()
    conexao.aplicar_schema()
    conexao.aplicar_schema()


def test_carregar_memoria_de_cliente_sem_revisao_devolve_vazio() -> None:
    _exige_banco()
    assert mem.carregar_memoria(str(uuid4())) == []


def test_ciclo_salvar_revisao_e_recarregar(cliente_temporario: dict) -> None:
    """Ida e volta pelo banco preservando a decisão NEGATIVA.

    É o teste de integração do requisito central: a retirada tem de sobreviver à
    serialização, ao trigger de normalização e à releitura.
    """
    usuario_id = cliente_temporario["usuario_id"]
    cliente_id = cliente_temporario["cliente_id"]

    entradas = [
        ent("Caixa Geral", "Caixa"),
        ent("Adiantamento a sócios", "", decisao=mem.NAO_ALOCAR),
    ]
    resultado = mem.salvar_revisao(
        usuario_id, cliente_id, entradas,
        analise_id=None, observacao="revisão de teste",
    )
    assert resultado["revisao"] == 1
    assert resultado["gravadas"] == 2
    assert resultado["diff"]["novas"] == 2
    assert resultado["diff"]["nao_alocar"] == 1

    recarregada = mem.carregar_memoria(cliente_id, usuario_id=usuario_id)
    por_chave = {e.chave: e for e in recarregada}
    negativa = por_chave[mem.chave_de("Adiantamento a sócios", "Ativo", "Circulante")]
    assert negativa.decisao == mem.NAO_ALOCAR
    assert negativa.destino == ""

    # E a decisão negativa recarregada bloqueia a linha do documento novo.
    plano = mem.aplicar_memoria([linha("ADIANTAMENTO A SOCIOS")], recarregada)
    assert plano["resumo"]["bloqueados"] == 1


def test_salvar_revisao_versiona_sem_apagar_a_anterior(
    cliente_temporario: dict,
) -> None:
    """`max(revisao) + 1` sempre. Versionar é o que permite auditar e reverter."""
    usuario_id = cliente_temporario["usuario_id"]
    cliente_id = cliente_temporario["cliente_id"]

    mem.salvar_revisao(
        usuario_id, cliente_id, [ent("Caixa Geral", "Caixa")],
        analise_id=None, observacao=None,
    )
    segunda = mem.salvar_revisao(
        usuario_id, cliente_id, [ent("Caixa Geral", "Bancos")],
        analise_id=None, observacao=None,
    )
    assert segunda["revisao"] == 2
    assert segunda["diff"]["alteradas"] == 1
    assert segunda["diff"]["destino_mudou"] == 1

    # A revisão 1 continua legível: é a prova da decisão anterior.
    antiga = mem.carregar_memoria(cliente_id, revisao=1, usuario_id=usuario_id)
    assert [e.destino for e in antiga] == ["Caixa"]
    atual = mem.carregar_memoria(cliente_id, usuario_id=usuario_id)
    assert [e.destino for e in atual] == ["Bancos"]


def test_promover_ao_dicionario_grava_so_o_confirmado(
    cliente_temporario: dict,
) -> None:
    _exige_banco()
    from app.db import repo

    usuario_id = cliente_temporario["usuario_id"]
    resultado = mem.promover_ao_dicionario(
        usuario_id,
        [
            ent("Caixa Geral", "Caixa"),
            ent("Sugerido", "Estoques", confirmado=False),
            ent("Retirada", "", decisao=mem.NAO_ALOCAR),
        ],
    )
    assert resultado == {"promovidas": 1, "ignoradas": 2}

    gravadas = repo.listar_dicionario(usuario_id)
    assert [g["origem"] for g in gravadas] == ["Caixa Geral"]
    assert gravadas[0]["chave"] == "caixa geral|ativo|circulante"
    # O trigger `dm_normalizar_dicionario` tem de concordar com o Python.
    assert gravadas[0]["origem_norm"] == mem.normalizar("Caixa Geral")


def test_dm_normalize_do_banco_concorda_com_o_python() -> None:
    """PARIDADE REAL: a mesma entrada pelas duas implementações.

    Este é o único teste que consegue provar o contrato de normalização de ponta
    a ponta; os outros provam apenas o lado Python. Divergência aqui é o bug do
    v1 voltando.
    """
    _exige_banco()
    for bruto, esperado in CASOS_JS:
        if bruto is None:
            continue
        linha_sql = conexao.executar(
            "select dm_normalize(%s) as norm", (str(bruto),), fetch="one"
        )
        assert linha_sql["norm"] == esperado == mem.normalizar(bruto), bruto
