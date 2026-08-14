"""
De COLUNA DO DOCUMENTO para SLOT do template (Ano 1 / Ano 2 / Ano 3).

O QUE DAVA ERRADO
-----------------
O portal escolhia sozinho: `computeYears` juntava todos os rótulos de coluna de
todas as páginas e pegava "os 3 mais recentes". No ITR do Fleury isso produziu 38
pseudo-períodos (`Controladora #2`, `coluna 7`, `Consolidado #5`…) e os três
escolhidos foram `coluna 7 · coluna 8 · coluna 9` - fragmentos de tabela de nota.
Quase nenhum valor morava ali, e o Total do Ativo saiu 2,00.

A DECISÃO DE PROJETO
--------------------
Quem escolhe é o ANALISTA, não o código. Um documento pode trazer Controladora e
Consolidado, três meses e seis meses, Saldo Anterior / Débito / Crédito / Saldo
Atual - e qual dessas colunas entra na análise é julgamento profissional, não
propriedade do arquivo.

Este módulo, então, faz exatamente duas coisas e nenhuma a mais:

  1. PROPÕE um mapeamento, com o critério explícito e auditável;
  2. DECLARA quando existe alternativa relevante (`escolha_pendente`), para o
     portal PERGUNTAR em vez de assumir.

Um mapeamento proposto que o usuário pode ver e trocar é diferente de um
mapeamento escondido: o primeiro é conveniência, o segundo é o que produziu o
Ativo de 2,00.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

# Slots do template, do mais antigo para o mais recente. O mais recente fica em
# Ano 3 - mesma convenção de `alignYearHeaders` em portal/src/core/rastreabilidade.js.
SLOTS: tuple[str, ...] = ("Ano 1", "Ano 2", "Ano 3")

# Escopo de consolidação. Não é exaustivo de propósito: o que não casa fica com
# escopo vazio e o portal mostra o rótulo cru para o usuário decidir.
_ESCOPOS: tuple[tuple[str, str], ...] = (
    ("consolidado", "Consolidado"),
    ("controladora", "Controladora"),
    ("individual", "Controladora"),
)

# Recortes temporais que aparecem em DRE de trimestre. Um ITR traz os quatro na
# mesma página, e trimestre isolado x acumulado muda toda a leitura de crédito.
# As formas CANÔNICAS ("3 meses") vêm primeiro de propósito: `reconstruir_cabecalho`
# grava o nome canônico no rótulo, e `recorte_do_rotulo` precisa reconhecer a
# própria saída. Sem isso o rótulo remontado sai com o recorte certo e o campo
# `recorte` vem vazio - e aí `propor` não consegue separar trimestre de acumulado,
# desempata pela data (que é a mesma nos dois) e escolhe o trimestre por acidente
# de ordem.
_RECORTES: tuple[tuple[str, str], ...] = (
    ("3 meses", "3 meses"),
    ("6 meses", "6 meses"),
    ("9 meses", "9 meses"),
    ("12 meses", "12 meses"),
    ("periodo de tres meses", "3 meses"),
    ("tres meses", "3 meses"),
    ("trimestre", "3 meses"),
    ("periodo de seis meses", "6 meses"),
    ("seis meses", "6 meses"),
    ("semestre", "6 meses"),
    ("nove meses", "9 meses"),
    ("exercicio", "12 meses"),
    ("acumulado", "acumulado"),
)

_DMY = re.compile(r"\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b")
_YMD = re.compile(r"\b(\d{4})-(\d{1,2})-(\d{1,2})\b")
_MY = re.compile(r"\b(\d{1,2})[/.](\d{4})\b")
_ANO = re.compile(r"\b(?:19|20)\d{2}\b")


def chave_cronologica(rotulo: object) -> tuple[int, int | str]:
    """Chave de ordenação de um rótulo de período.

    ESPELHA `yearKey` de portal/src/core/rastreabilidade.js. Tem de espelhar: se
    servidor e portal ordenarem diferente, a coluna que o servidor propôs para
    Ano 3 vira Ano 2 no portal, e todos os valores deslocam um slot.

    `(0, n)` é data reconhecida (ordenável); `(1, texto)` é rótulo sem data, que
    vai para o fim em ordem alfabética estável.
    """
    s = str(rotulo if rotulo is not None else "").strip()
    if re.fullmatch(r"\d{4}", s):
        return (0, int(s) * 10000)
    m = _DMY.search(s)
    if m:
        return (0, int(m.group(3)) * 10000 + int(m.group(2)) * 100 + int(m.group(1)))
    m = _YMD.search(s)
    if m:
        return (0, int(m.group(1)) * 10000 + int(m.group(2)) * 100 + int(m.group(3)))
    m = _MY.search(s)
    if m:
        return (0, int(m.group(2)) * 10000 + int(m.group(1)) * 100 + 28)
    anos = _ANO.findall(s)
    if anos:
        return (0, int(anos[-1]) * 10000)
    return (1, s)


def rotulo_unificado(rotulo: object) -> str:
    """A DATA do rótulo, quando existe; senão o rótulo cru.

    Serve para dar a Balanço e DRE a MESMA chave de período. No documento a
    coluna do Balanço se chama `Controladora 30/06/2026` e a da DRE
    `Controladora` (cabeçalho de quatro linhas empilhadas, com a data noutra
    linha) - mas as duas são o mesmo período de negócio, e precisam cair no mesmo
    Ano N para que Ativo e Resultado sejam comparáveis.

    Devolver a data crua, e não "Ano 3", é deliberado: o cabeçalho da planilha
    tem de mostrar `30/06/2026`, que é o que o analista reconhece.
    """
    s = str(rotulo if rotulo is not None else "").strip()
    m = _DMY.search(s)
    if m:
        return f"{int(m.group(1)):02d}/{int(m.group(2)):02d}/{m.group(3)}"
    m = _YMD.search(s)
    if m:
        return f"{int(m.group(3)):02d}/{int(m.group(2)):02d}/{m.group(1)}"
    m = _MY.search(s)
    if m:
        return f"{int(m.group(1)):02d}/{m.group(2)}"
    anos = _ANO.findall(s)
    if anos:
        return anos[-1]
    return s


def tem_data(rotulo: object) -> bool:
    """O rótulo carrega data ou ano reconhecível?

    Coluna sem data é a marca de cabeçalho mal remontado (`coluna 7`,
    `Controladora #2`). Não impede o uso - o usuário pode reconhecer a coluna
    pelo VALOR que ela produz - mas rebaixa a proposta automática.
    """
    return chave_cronologica(rotulo)[0] == 0


def _normalizar(texto: object) -> str:
    import unicodedata
    s = str(texto if texto is not None else "").strip().lower()
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9\s]", " ", s)).strip()


def escopo_do_rotulo(rotulo: object) -> str:
    rot = _normalizar(rotulo)
    for agulha, nome in _ESCOPOS:
        if agulha in rot:
            return nome
    return ""


def recorte_do_rotulo(rotulo: object) -> str:
    rot = _normalizar(rotulo)
    for agulha, nome in _RECORTES:
        if agulha in rot:
            return nome
    return ""


# ---------------------------------------------------------------------------
# Remontagem de cabeçalho empilhado
# ---------------------------------------------------------------------------
_MESES: dict[str, int] = {
    "janeiro": 1, "fevereiro": 2, "marco": 3, "abril": 4, "maio": 5,
    "junho": 6, "julho": 7, "agosto": 8, "setembro": 9, "outubro": 10,
    "novembro": 11, "dezembro": 12,
    "jan": 1, "fev": 2, "mar": 3, "abr": 4, "mai": 5, "jun": 6,
    "jul": 7, "ago": 8, "set": 9, "out": 10, "nov": 11, "dez": 12,
}

# Quantos meses cada recorte cobre. Usado para PREFERIR o período mais longo na
# proposta: para análise de crédito o acumulado informa mais que o trimestre
# isolado. É preferência declarada, não verdade - daí a escolha ficar pendente.
_MESES_DO_RECORTE: dict[str, int] = {
    "3 meses": 3, "6 meses": 6, "9 meses": 9, "12 meses": 12,
    "acumulado": 12,
}


def _mes_do_texto(texto: str) -> int | None:
    for nome, numero in _MESES.items():
        if re.search(rf"\b{nome}\b", texto):
            return numero
    return None


def reconstruir_cabecalho(
    rotulos: list[str], linhas_cabecalho: list[object]
) -> list[str]:
    """Remonta o rótulo das colunas usando as LINHAS DE CABEÇALHO empilhadas.

    O PROBLEMA, medido na página 7 do ITR do Fleury: o cabeçalho da DRE tem
    quatro linhas físicas, e a data está partida entre elas,

        "Controladora"                                     (sem valor)
        "Período de três meses   Período de seis meses"    (sem valor)
        "de junho de junho"          valores: 30 · 30 ·
        "Nota"                       valores: 2026 2025 2026 2025

    O `30` e o `2026` caem nas COLUNAS DE VALOR, então `mapear_cabecalho` só vê
    "Controladora" e devolve `Controladora #2/#3/#4`. Sem data, `propor` não tem
    como ordenar, `porSlot` sai vazio e a DRE inteira contribui ZERO - foi
    exatamente o que aconteceu.

    Aqui o ano é recuperado de dentro dos valores do cabeçalho, o dia e o mês são
    tomados de onde aparecerem (a data-base é a mesma; só o ano muda entre
    colunas) e o recorte temporal é distribuído em blocos quando a contagem
    divide as colunas exatamente.

    `linhas_cabecalho` são `LinhaLida`; recebidas como `object` para este módulo
    não importar `tables` e criar ciclo.
    """
    if not rotulos or not linhas_cabecalho:
        return list(rotulos)

    ano_da_coluna: dict[str, int] = {}
    dias: list[int] = []
    mes: int | None = None
    recortes_mencionados: list[str] = []

    for linha in linhas_cabecalho:
        texto = _normalizar(getattr(linha, "rotulo", ""))
        if mes is None:
            mes = _mes_do_texto(texto)
        for termo, nome in _RECORTES:
            for m in re.finditer(rf"\b{termo}\b", texto):
                recortes_mencionados.append((m.start(), nome))  # type: ignore[arg-type]
        for coluna, valor in (getattr(linha, "valores", {}) or {}).items():
            if valor is None or valor != int(valor):
                continue
            inteiro = int(valor)
            if 1900 <= inteiro <= 2100:
                ano_da_coluna.setdefault(coluna, inteiro)
            elif 1 <= inteiro <= 31:
                dias.append(inteiro)

    # ordem de aparição, sem repetir
    ordenados = [nome for _, nome in sorted(recortes_mencionados)]  # type: ignore[misc]
    recortes: list[str] = []
    for nome in ordenados:
        if nome not in recortes:
            recortes.append(nome)

    dia = max(set(dias), key=dias.count) if dias else None

    # Recorte em blocos: 2 recortes e 4 colunas -> 2 colunas cada. Só quando
    # divide exato; senão não há como afirmar a quem cada recorte pertence, e
    # afirmar errado trocaria trimestre por acumulado sem aviso.
    recorte_da_coluna: dict[str, str] = {}
    if recortes and len(rotulos) % len(recortes) == 0:
        largura = len(rotulos) // len(recortes)
        for i, coluna in enumerate(rotulos):
            recorte_da_coluna[coluna] = recortes[i // largura]

    novos: list[str] = []
    usados: set[str] = set()
    for coluna in rotulos:
        # `Controladora #3` -> `Controladora`: o sufixo era só para desempatar
        base = re.sub(r"\s*#\d+$", "", coluna).strip()
        partes = [base] if base else []
        recorte = recorte_da_coluna.get(coluna, "")
        if recorte:
            partes.append(recorte)
        ano = ano_da_coluna.get(coluna)
        if ano is not None:
            if dia and mes:
                partes.append(f"{dia:02d}/{mes:02d}/{ano}")
            elif mes:
                partes.append(f"{mes:02d}/{ano}")
            else:
                partes.append(str(ano))
        novo = " ".join(p for p in partes if p) or coluna
        # unicidade: chave repetida sobrescreveria valor de outra coluna
        candidato, n = novo, 1
        while candidato in usados:
            n += 1
            candidato = f"{novo} #{n}"
        usados.add(candidato)
        novos.append(candidato)

    if novos != list(rotulos):
        logger.info("cabecalho remontado: %s -> %s", list(rotulos), novos)
    return novos


@dataclass
class ColunaCandidata:
    """Uma coluna de valor oferecida ao analista, com o que a identifica.

    `valores_de_referencia` é o que faz esta tela funcionar: o valor que a coluna
    produz na linha que FECHA a demonstração. O analista bate o olho em
    11.689.351 contra 13.558.475 e sabe qual é Controladora e qual é Consolidado
    mesmo que o rótulo tenha saído como `coluna 3`. A aritmética vira a legenda.
    """

    rotulo: str
    escopo: str = ""
    recorte: str = ""
    tem_data: bool = False
    valores_de_referencia: dict[str, float] = field(default_factory=dict)

    def como_dict(self) -> dict[str, object]:
        return {
            "rotulo": self.rotulo,
            "escopo": self.escopo,
            "recorte": self.recorte,
            "temData": self.tem_data,
            "valoresDeReferencia": self.valores_de_referencia,
        }


def descrever_colunas(
    rotulos: list[str], valores_de_referencia: dict[str, dict[str, float]]
) -> list[ColunaCandidata]:
    """Descreve cada coluna para o analista escolher.

    `valores_de_referencia[rotulo_da_coluna][rotulo_da_raiz] = valor`.
    """
    return [
        ColunaCandidata(
            rotulo=r,
            escopo=escopo_do_rotulo(r),
            recorte=recorte_do_rotulo(r),
            tem_data=tem_data(r),
            valores_de_referencia=valores_de_referencia.get(r, {}),
        )
        for r in rotulos
    ]


@dataclass
class Proposta:
    """Mapeamento proposto, com o porquê e as alternativas."""

    por_slot: dict[str, str] = field(default_factory=dict)  # 'Ano 3' -> rótulo
    criterio: str = ""
    escolha_pendente: bool = False
    motivo_pendencia: str = ""
    alternativas: list[str] = field(default_factory=list)

    def como_dict(self) -> dict[str, object]:
        return {
            "porSlot": self.por_slot,
            "criterio": self.criterio,
            "escolhaPendente": self.escolha_pendente,
            "motivoPendencia": self.motivo_pendencia,
            "alternativas": self.alternativas,
        }


def propor(colunas: list[ColunaCandidata]) -> Proposta:
    """Propõe até 3 colunas para os slots, e declara quando há escolha a fazer.

    Critério, nesta ordem:
      1. só colunas com data entram na proposta - sem data não há como afirmar
         qual é mais recente, e inventar ordem foi o que gerou `coluna 7`;
      2. um ÚNICO escopo por proposta. Misturar Controladora com Consolidado no
         mesmo balanço é somar duas entidades diferentes;
      3. um ÚNICO recorte temporal, pelo mesmo motivo (3 meses com 6 meses);
      4. as 3 datas mais recentes, a mais recente em Ano 3.

    Havendo mais de um escopo ou recorte disponível, `escolha_pendente` fica
    `True`: a proposta serve para a tela abrir preenchida, não para decidir.
    """
    com_data = [c for c in colunas if c.tem_data]
    if not com_data:
        # PROPOR NADA É PIOR QUE PROPOR COM RESSALVA.
        #
        # Este caminho devolvia `por_slot` VAZIO. Consequência medida no DFP 2025
        # do Fleury: nenhuma coluna mapeada, `montar_selecao` sem período, e o
        # portal exibindo "0 linhas lidas" e "Nenhuma linha carregada" na Revisão.
        # Zero linhas é pior que a v1, que ao menos mostrava tudo para alocação
        # manual - o analista perdeu até a chance de decidir.
        #
        # A ordem não é palpite: tanto o formulário padronizado da CVM
        # (`31/12/2025 31/12/2024 31/12/2023`) quanto o ITR diagramado põem o
        # exercício MAIS RECENTE À ESQUERDA. Então a primeira coluna vai para
        # Ano 3.
        #
        # E a ressalva é verificável na hora, sem sair da tela: a coluna `PRODUZ`
        # mostra o valor da linha que fecha cada coluna. Se a ordem estiver
        # trocada, o analista vê pelo número e corrige num clique.
        posicionais = colunas[: len(SLOTS)]
        por_slot = {
            SLOTS[len(SLOTS) - 1 - i]: c.rotulo for i, c in enumerate(posicionais)
        }
        logger.info(
            "nenhuma coluna com data: proposta POSICIONAL (%s) marcada como pendente",
            por_slot,
        )
        return Proposta(
            por_slot=por_slot,
            criterio=(
                f"{len(posicionais)} coluna(s) sem data - ordem presumida pela "
                "POSIÇÃO (mais à esquerda = mais recente)"
            ),
            escolha_pendente=True,
            motivo_pendencia=(
                "Nenhuma coluna trouxe data reconhecível - o cabeçalho pode ter "
                "várias linhas empilhadas. Mapeei pela posição, supondo que a "
                "coluna mais à esquerda é a mais recente. CONFIRME pelo valor de "
                "referência que cada coluna produz, na coluna PRODUZ."
            ),
            alternativas=[c.rotulo for c in colunas[len(SLOTS):]],
        )

    escopos = sorted({c.escopo for c in com_data if c.escopo})
    recortes = sorted({c.recorte for c in com_data if c.recorte})

    # Consolidado é o padrão de análise de crédito para grupo econômico, mas isso
    # é PREFERÊNCIA, não verdade: quando os dois existem a escolha fica pendente.
    escopo_alvo = ""
    if escopos:
        escopo_alvo = "Consolidado" if "Consolidado" in escopos else escopos[0]

    # Recorte mais LONGO primeiro: o acumulado do semestre informa mais sobre
    # capacidade de pagamento que o trimestre isolado, e é o que se compara com o
    # exercício anterior. Também é preferência declarada, não verdade.
    recorte_alvo = ""
    if recortes:
        recorte_alvo = max(recortes, key=lambda r: _MESES_DO_RECORTE.get(r, 0))

    elegiveis = [
        c for c in com_data
        if (not escopo_alvo or c.escopo == escopo_alvo)
        and (not recorte_alvo or c.recorte == recorte_alvo or not c.recorte)
    ]
    if not elegiveis:
        elegiveis = com_data

    # Mais recente primeiro; deduplica por data, mantendo a primeira ocorrência.
    ordenadas = sorted(elegiveis, key=lambda c: chave_cronologica(c.rotulo),
                       reverse=True)
    vistas: set[tuple[int, int | str]] = set()
    escolhidas: list[ColunaCandidata] = []
    for c in ordenadas:
        k = chave_cronologica(c.rotulo)
        if k in vistas:
            continue
        vistas.add(k)
        escolhidas.append(c)
        if len(escolhidas) == len(SLOTS):
            break

    # Ano 3 = mais recente, alinhado à DIREITA quando há menos de 3 períodos.
    por_slot: dict[str, str] = {}
    for i, c in enumerate(escolhidas):
        por_slot[SLOTS[len(SLOTS) - 1 - i]] = c.rotulo

    partes = [f"{len(escolhidas)} coluna(s) com data, mais recente em Ano 3"]
    if escopo_alvo:
        partes.append(f"escopo {escopo_alvo}")
    if recorte_alvo:
        partes.append(f"recorte {recorte_alvo}")

    pendente = len(escopos) > 1 or len(recortes) > 1
    motivo = ""
    if len(escopos) > 1:
        motivo = (f"O documento traz {' e '.join(escopos)}. Somar os dois seria "
                  "somar entidades diferentes - confirme qual entra na análise.")
    elif len(recortes) > 1:
        motivo = (f"O documento traz {' e '.join(recortes)}. Confirme se a "
                  "análise usa o período isolado ou o acumulado.")

    return Proposta(
        por_slot=por_slot,
        criterio="; ".join(partes),
        escolha_pendente=pendente,
        motivo_pendencia=motivo,
        alternativas=[c.rotulo for c in colunas
                      if c.rotulo not in por_slot.values()],
    )


# ---------------------------------------------------------------------------
# Seleção: uma demonstração por família, com os valores rechaveados por período
# ---------------------------------------------------------------------------
def familia_principal(demonstracao: dict) -> str:
    """Família que representa a demonstração para efeito de seleção única.

    No ITR diagramado, `BP-ATIVO` e `BP-PASSIVO` estão na MESMA página e as duas
    árvores pertencem ao mesmo documento: contam como uma escolha só. A DRE é
    outra.
    """
    familias = demonstracao.get("familias") or []
    return "BP" if any(str(f).startswith("BP") for f in familias) else "DRE"


def chaves_de_selecao(demonstracao: dict) -> list[str]:
    """Quais slots de escolha esta demonstração OCUPA.

    POR QUE ISTO EXISTE, E O QUE CUSTOU NÃO EXISTIR
    -----------------------------------------------
    `familia_principal` devolve `"BP"` tanto para uma página que fecha o Ativo
    quanto para uma que fecha o Passivo. Isso vale no ITR diagramado, onde as duas
    árvores dividem a mesma página - mas é FALSO na DFP/ITR padronizada da CVM,
    onde o Ativo está numa página e o Passivo em outra.

    Consequência medida no DFP 2025 do Fleury: duas demonstrações distintas
    disputavam a mesma chave `"BP"`, a segunda era descartada com
    `familia BP ja escolhida`, e o resultado tinha **48 linhas, todas de Ativo e
    DRE, e ZERO de Passivo**. `Ativo = Passivo + PL` não tinha como fechar - não
    por erro de alocação, mas porque metade do balanço nunca chegou.

    A correção é distinguir os dois lados quando eles vêm SEPARADOS, e continuar
    tratando-os como uma escolha só quando vêm juntos. Uma página que fecha os
    dois devolve as duas chaves, então ela preenche ambas de uma vez e nenhuma
    segunda página é aceita para nenhum dos lados.
    """
    familias = [str(f) for f in (demonstracao.get("familias") or [])]
    chaves = [f for f in ("BP-ATIVO", "BP-PASSIVO") if f in familias]
    if not chaves:
        return ["DRE"]
    return chaves


def montar_selecao(
    demonstracoes: list[dict],
    escolhidos: list[str] | None = None,
) -> tuple[list[dict], list[str], list[str]]:
    """Achata as demonstrações escolhidas, rechaveando os valores por PERÍODO.

    Rechavear é o que faz Balanço e DRE caírem no mesmo Ano N: a coluna
    `Controladora 30/06/2026` do Balanço e a coluna de seis meses de 2026 da DRE
    são o MESMO período de negócio, com rótulos diferentes no documento. Sem
    isso, cada demonstração ocuparia slots próprios e o Ativo nunca conviveria
    com o Resultado.

    Uma por família porque duas DREs no mesmo template seriam a mesma
    demonstração contada duas vezes - e, além disso, os códigos gerados
    colidiriam (as duas começam em `5`), fazendo `hierarquiaPorCodigo` descartar
    a segunda árvore inteira.

    Vive aqui, e não em `main.py`, porque é lógica pura: precisa ser importável e
    testável numa máquina sem fastapi (ver AGENTS.md).

    @returns `(linhas, periodos, ids_selecionados)`
    """
    if escolhidos:
        pedidos = [d for d in demonstracoes if d.get("id") in set(escolhidos)]
    else:
        pedidos = list(demonstracoes)

    # Uma por LADO, não uma por "BP". Na padronizada da CVM o Ativo e o Passivo
    # vêm em páginas separadas; tratá-los como a mesma escolha descartava metade
    # do balanço. Ver `chaves_de_selecao`.
    ocupadas: dict[str, str] = {}   # chave de seleção -> id da demonstração
    escolhidas: dict[str, dict] = {}  # id -> demonstração (dedupe: 1 página, 2 lados)
    for d in pedidos:
        chaves = chaves_de_selecao(d)
        if any(c in ocupadas for c in chaves):
            logger.info(
                "lado(s) %s ja preenchido(s); %s ignorada",
                ", ".join(c for c in chaves if c in ocupadas), d.get("id"),
            )
            continue
        for c in chaves:
            ocupadas[c] = str(d.get("id"))
        escolhidas[str(d.get("id"))] = d

    # Rótulo de cada slot: a data da coluna escolhida. A primeira demonstração que
    # oferecer data para o slot manda - as demais se alinham a ela.
    rotulo_do_slot: dict[str, str] = {}
    for d in escolhidas.values():
        for slot, coluna in (d.get("mapeamento", {}).get("porSlot") or {}).items():
            unificado = rotulo_unificado(coluna)
            if slot not in rotulo_do_slot and unificado:
                rotulo_do_slot[slot] = unificado
    for slot in SLOTS:
        rotulo_do_slot.setdefault(slot, slot)

    linhas: list[dict] = []
    slots_usados: list[str] = []
    for d in escolhidas.values():
        por_slot = d.get("mapeamento", {}).get("porSlot") or {}
        for slot in por_slot:
            if slot not in slots_usados:
                slots_usados.append(slot)
        for origem in d.get("linhas") or []:
            valores = origem.get("valoresPorSlot") or {}
            rechaveado = {
                rotulo_do_slot[slot]: valores[coluna]
                for slot, coluna in por_slot.items()
                if coluna in valores
            }
            linhas.append({**origem, "valoresPorSlot": rechaveado,
                           "demonstracao": d.get("id", "")})

    periodos = [rotulo_do_slot[s] for s in SLOTS if s in slots_usados]
    return linhas, periodos, [d.get("id", "") for d in escolhidas.values()]
