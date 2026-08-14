"""
O CORAÇÃO da leitura: descobrir as colunas de uma tabela sem borda.

A INTUIÇÃO
----------
Numa demonstração financeira a coluna NÃO é delimitada por linha, borda ou tag:
ela é delimitada por COORDENADA X. Todo valor de uma mesma coluna é alinhado à
direita na mesma abscissa, porque é assim que contador e ERP formatam número.
Então: filtra as palavras que são número, clusteriza as BORDAS DIREITAS e cada
cluster é uma coluna.

POR QUE A BORDA DIREITA (x1) E NÃO O CENTRO NEM x0
--------------------------------------------------
Porque número contábil é alinhado à direita. `1.234.567,89` e `55` na mesma
coluna têm x0 completamente diferente (o primeiro começa ~9 caracteres antes) e
centros diferentes; o que eles têm IGUAL, com precisão de fração de ponto, é o
x1. Clusterizar por x0 ou por centro espalha a mesma coluna em vários clusters
e é a origem clássica do "valor foi para a coluna errada".

Este módulo é geometria pura: não importa pdfplumber em runtime, o que o torna
testável com palavras sintéticas e reaproveitável para outra origem (OCR, por
exemplo, que também devolve caixas).
"""
from __future__ import annotations

import logging
import re
import unicodedata
from dataclasses import dataclass
from statistics import median
from typing import TYPE_CHECKING, Iterable, Sequence

if TYPE_CHECKING:  # pragma: no cover - só para o type checker
    from .pdf_words import Palavra

logger = logging.getLogger(__name__)

# Tolerância usada quando não há como estimar a largura de caractere da página.
TOLERANCIA_PADRAO = 12.0

# Quantas larguras de caractere separam duas colunas distintas. 3 é o menor
# valor que não junta colunas vizinhas em relatório apertado de ERP e ainda
# absorve o jitter de sub-ponto do x1 dentro de uma mesma coluna.
FATOR_TOLERANCIA = 3.0

# ---------------------------------------------------------------------------
# Reconhecimento de número contábil
# ---------------------------------------------------------------------------
# Formatos aceitos: 1.234.567,89 · 1234567.89 · (55.497) = negativo ·
# -1.234 · 1.234,56- (sinal à direita, exportação SAP/Protheus) · R$ 1.000 ·
# 123 456 (separador de milhar por espaço) · e o TRAÇO ISOLADO.
#
# O TRAÇO ISOLADO (-, –, - ) É TOKEN DE VALOR DE PROPÓSITO. Ele significa
# "célula sem valor" e ocupa POSIÇÃO na tabela. Se ele não fosse reconhecido
# como token, a coluna dele não receberia nada naquela linha e os valores
# seguintes seriam empurrados uma coluna para a esquerda - o bug de leitura
# mais comum e mais difícil de perceber, porque o número lido é plausível.
# Atenção: traço é VAZIO, não é zero (ver `para_numero`).
TOKEN_VALOR = re.compile(
    r"""^(?:
        [-\u2013\u2014]                     # traço / en dash / em dash isolado
      |
        \(?\s*(?:R\$\s*)?[-+]?\s*           # abre parêntese, moeda, sinal à esquerda
        \d+(?:[.,\s\u00a0]\d{3})*           # inteiro, com ou sem separador de milhar
        (?:[.,]\d{1,4})?                    # parte decimal
        \s*[-\u2013\u2014]?\s*\)?           # sinal à direita e fecha parêntese
    )$""",
    re.VERBOSE,
)

_SO_TRACO = re.compile(r"^[-\u2013\u2014]$")
_MILHAR_BR = re.compile(r"^\d{1,3}(\.\d{3})+$")
_NUMERO_LIMPO = re.compile(r"^\d*\.?\d+$")
_ESPACOS = re.compile(r"[\s\u00a0\u2009]")
_MOEDA = re.compile(r"R\$", re.IGNORECASE)

# "dígito separador dígito" - basta isso para saber que o token está formatado
# como valor monetário, e não como número de nota explicativa.
_TEM_SEPARADOR = re.compile(r"\d[.,\s\u00a0]\d")

# Número de nota explicativa: 1..99, opcionalmente com alínea ("23.c").
_EH_NOTA = re.compile(r"^\d{1,2}(?:\.[a-z]{1,2})?$", re.IGNORECASE)

# Código de conta hierárquico da padronizada da CVM. O que o separa de um valor
# com separador de milhar é o TAMANHO DO GRUPO depois do ponto: milhar tem sempre
# 3 dígitos (`1.234`), código tem 1 ou 2 (`1.01`, `1.01.02.01.03`).
_CODIGO_HIERARQUICO = re.compile(r"^\d{1,2}(?:\.\d{1,2})+$")
# Raiz da árvore da CVM: `1` Ativo, `2` Passivo, `3` DRE.
_CODIGO_RAIZ = re.compile(r"^[1-9]$")

# Ano isolado no cabeçalho. Não entra na conta de "onde começam os valores"
# porque 2025 é sintaticamente indistinguível de um valor.
_ANO = re.compile(r"^(?:19|20)\d{2}$")

# Rótulos de cabeçalho: dd/mm/aaaa, mm/aaaa ou o ano puro.
DATA_CABECALHO = re.compile(r"^(?:\d{1,2}/\d{1,2}/\d{4}|\d{1,2}/\d{4}|(?:19|20)\d{2})$")

# Visões de uma demonstração. Chave normalizada -> grafia de saída.
VISOES: dict[str, str] = {
    "controladora": "Controladora",
    "consolidado": "Consolidado",
    "individual": "Individual",
    "combinado": "Combinado",
}


def eh_token_valor(texto: str) -> bool:
    """`True` se o texto ocupa uma célula de valor (inclui o traço vazio)."""
    return bool(TOKEN_VALOR.match((texto or "").strip()))


def para_numero(texto: str) -> float | None:
    """Interpreta número contábil brasileiro. `None` = célula vazia.

    Regras, na ordem em que são aplicadas:
      · traço/travessão isolado -> `None`. É VAZIO, NÃO É ZERO: zero é uma
        afirmação contábil ("esta conta fechou em zero"), traço é ausência de
        afirmação. Confundir os dois transforma buraco de leitura em dado, e o
        somatório fecha errado sem ninguém notar.
      · parênteses envolvendo o número -> negativo (padrão CVM/IFRS);
      · sinal à direita -> negativo (exportação de ERP);
      · vírgula e ponto juntos: manda quem estiver mais à DIREITA (é o decimal);
      · só ponto: é milhar quando casa `^\\d{1,3}(\\.\\d{3})+$`, senão decimal.

    Espelha `parseNumber` de portal/src/core/normalize.js - leitura e portal
    precisam concordar no valor, senão a trilha de conservação acusa diferença
    que não existe.
    """
    bruto = (texto or "").strip()
    if not bruto or _SO_TRACO.match(bruto):
        return None

    negativo = False
    t = _ESPACOS.sub("", _MOEDA.sub("", bruto).replace("$", ""))
    if t.startswith("(") and t.endswith(")"):
        negativo, t = True, t[1:-1]
    if t and t[-1] in "-\u2013\u2014":
        negativo, t = True, t[:-1]
    if t.startswith("-"):
        negativo, t = True, t[1:]
    elif t.startswith("+"):
        t = t[1:]
    if not t:
        return None

    tem_virgula, tem_ponto = "," in t, "." in t
    if tem_virgula and tem_ponto:
        if t.rindex(",") > t.rindex("."):
            t = t.replace(".", "").replace(",", ".")  # 1.234.567,89 (BR)
        else:
            t = t.replace(",", "")                    # 1,234,567.89 (US)
    elif tem_virgula:
        t = t.replace(",", ".")
    elif tem_ponto and _MILHAR_BR.match(t):
        t = t.replace(".", "")

    if not _NUMERO_LIMPO.match(t):
        logger.debug("token nao interpretado como numero: %r", bruto)
        return None
    valor = float(t)
    return -valor if negativo else valor


# ---------------------------------------------------------------------------
# Detecção das colunas
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Coluna:
    """Uma coluna de valores. `x1` é a âncora; `n` é quantos tokens a formaram."""

    x_centro: float
    x0: float
    x1: float
    n: int


def agrupar_por_gap(valores: Iterable[float], tolerancia: float) -> list[list[float]]:
    """Clusterização 1-D: ordena e quebra onde o intervalo passa de `tolerancia`.

    Não usamos k-means nem DBSCAN porque o número de colunas é desconhecido e
    porque em 1-D com dados alinhados o corte por gap é ótimo, determinístico e
    explicável para um auditor (o que k-means não é).
    """
    ordenados = sorted(valores)
    if not ordenados:
        return []
    grupos: list[list[float]] = [[ordenados[0]]]
    for v in ordenados[1:]:
        if v - grupos[-1][-1] > tolerancia:
            grupos.append([v])
        else:
            grupos[-1].append(v)
    return grupos


def largura_media_caractere(palavras: Sequence[Palavra]) -> float | None:
    """Mediana de (largura da palavra / nº de caracteres). Escala da página."""
    larguras = [
        p.largura / len(p.texto)
        for p in palavras
        if p.texto and p.largura > 0
    ]
    return median(larguras) if larguras else None


def detectar_colunas(
    palavras: Sequence[Palavra],
    min_ocorrencias: int = 3,
    tolerancia: float | None = None,
) -> list[Coluna]:
    """Descobre as colunas de valores pela BORDA DIREITA dos números.

    `min_ocorrencias=3` é o filtro que separa coluna de coincidência: um número
    solto no meio do texto (ano numa frase, número de página, quantidade citada
    num parágrafo) nunca aparece três vezes na mesma abscissa.
    """
    tokens = [p for p in palavras if eh_token_valor(p.texto)]
    if not tokens:
        return []

    if tolerancia is None:
        largura = largura_media_caractere(palavras)
        tolerancia = largura * FATOR_TOLERANCIA if largura else TOLERANCIA_PADRAO

    colunas: list[Coluna] = []
    for grupo in agrupar_por_gap((p.x1 for p in tokens), tolerancia):
        if len(grupo) < min_ocorrencias:
            continue
        inicio, fim = grupo[0], grupo[-1]
        membros = [p for p in tokens if inicio - 1e-6 <= p.x1 <= fim + 1e-6]
        x0 = min(p.x0 for p in membros)
        x1 = max(p.x1 for p in membros)
        colunas.append(Coluna(x_centro=(x0 + x1) / 2.0, x0=x0, x1=x1, n=len(membros)))

    colunas.sort(key=lambda c: c.x1)
    logger.debug(
        "colunas detectadas (tolerancia %.1f): %s",
        tolerancia, [(round(c.x1, 1), c.n) for c in colunas],
    )
    return colunas


def atribuir_a_coluna(
    palavra: Palavra,
    colunas: Sequence[Coluna],
    tolerancia: float = TOLERANCIA_PADRAO,
) -> int | None:
    """Índice da coluna a que a palavra pertence, ou `None`.

    Critério primário: maior sobreposição horizontal. Empate (ou quase) é
    desempatado pela distância entre as bordas direitas, de novo porque é o x1
    que identifica a coluna. Sem sobreposição nenhuma, aceita a coluna mais
    próxima em x1 desde que dentro de `tolerancia` - assim um token que sobrou
    de uma coluna descartada (a de notas, tipicamente) devolve `None` em vez de
    ser enfiado à força na coluna vizinha.
    """
    if not colunas:
        return None

    def sobreposicao(c: Coluna) -> float:
        return max(0.0, min(palavra.x1, c.x1) - max(palavra.x0, c.x0))

    melhor = max(
        range(len(colunas)),
        key=lambda i: (sobreposicao(colunas[i]), -abs(palavra.x1 - colunas[i].x1)),
    )
    if sobreposicao(colunas[melhor]) > 0:
        return melhor

    proxima = min(range(len(colunas)), key=lambda i: abs(palavra.x1 - colunas[i].x1))
    return proxima if abs(palavra.x1 - colunas[proxima].x1) <= tolerancia else None


def top_inicio_valores(
    palavras: Sequence[Palavra],
    colunas: Sequence[Coluna],
    tolerancia_linha: float = 3.0,
) -> float:
    """`top` da primeira linha de valores - fronteira entre cabeçalho e corpo.

    Ano puro é ignorado porque `2025` no cabeçalho é indistinguível de um valor
    e faria a fronteira subir para cima do próprio cabeçalho.

    EXIGE MAIS DE UMA COLUNA PREENCHIDA na mesma linha, e é isso que a torna
    confiável. A versão anterior aceitava o PRIMEIRO token de valor que caísse em
    qualquer coluna, e no formulário padronizado da CVM isso quebrava tudo: o
    cabeçalho do documento traz `Versão: 1`, e aquele `1` solto é um token de
    valor legítimo, posicionado ACIMA da linha de datas. A fronteira subia para
    cima dele, `mapear_cabecalho` passava a olhar só o que estava acima, e a linha
    `Conta 31/12/2025 31/12/2024 31/12/2023` ficava FORA do cabeçalho.

    Consequência medida no DFP 2025 do Fleury: nenhuma data reconhecida, colunas
    chamadas `coluna 1`, `coluna 2`, `coluna 3`, e o mapeamento coluna→Ano caindo
    na proposta posicional de emergência.

    Uma linha de dados de verdade preenche mais de uma coluna; `Versão: 1`
    preenche uma. Quando a página tem uma coluna só, o piso volta a ser 1 - não há
    o que exigir.
    """
    candidatos = [
        p
        for p in palavras
        if eh_token_valor(p.texto)
        and not _ANO.match(p.texto.strip())
        and atribuir_a_coluna(p, colunas) is not None
    ]
    if not candidatos:
        return float("inf")

    minimo = min(2, len(colunas))
    # agrupa por `top` e conta COLUNAS DISTINTAS por linha
    por_linha: list[tuple[float, set[int]]] = []
    for p in sorted(candidatos, key=lambda w: w.top):
        indice = atribuir_a_coluna(p, colunas)
        if por_linha and p.top - por_linha[-1][0] <= tolerancia_linha:
            por_linha[-1][1].add(indice)
        else:
            por_linha.append((p.top, {indice}))

    for top, indices in por_linha:
        if len(indices) >= minimo:
            return top
    # Nenhuma linha preenche o mínimo: cai no comportamento antigo em vez de
    # devolver `inf`, que faria a página inteira ser lida como cabeçalho.
    return por_linha[0][0]


def descartar_coluna_codigo(
    colunas: Sequence[Coluna], palavras: Sequence[Palavra]
) -> list[Coluna]:
    """Remove a coluna `Conta` da DFP/ITR PADRONIZADA da CVM.

    O formulário da CVM traz, à esquerda de tudo, uma coluna de código hierárquico
    (`1`, `1.01`, `1.01.02.01.03`). Esses tokens são numéricos e alinhados, então
    `detectar_colunas` os encontra como coluna legítima de valores. A consequência
    medida no DFP 2025 do Fleury foi grave e silenciosa: a coluna de código virou
    a primeira coluna de valores e **todos os períodos deslocaram um para a
    direita** - `1.01` entrou como saldo `1,01` e o exercício de 2023 caiu numa
    quarta coluna sem nome.

    `descartar_coluna_nota` não pega este caso, e por um motivo instrutivo: ela
    desiste assim que vê separador (`if any(_TEM_SEPARADOR...)`), porque separador
    de milhar é o sinal de que a coluna é dinheiro. Mas `1.01` também tem ponto. A
    regra certa está no TAMANHO DO GRUPO depois do ponto:

        milhar  -> sempre 3 dígitos   1.234   1.497.695
        código  -> 1 ou 2 dígitos     1.01    1.01.02.01.03

    Isso é decisão de estrutura, não de magnitude, e por isso não condena coluna
    legítima de valores pequenos (demonstração em milhares tem coluna inteira de
    12, 45, 80 - essa é da `descartar_coluna_nota`).

    Só a coluna MAIS À ESQUERDA é candidata, e exige-se ao menos dois códigos
    pontuados: uma coluna com um único `1.01` solto é coincidência, não formulário.
    """
    if len(colunas) < 2:
        return list(colunas)

    tokens = [
        p.texto.strip()
        for p in palavras
        if eh_token_valor(p.texto) and atribuir_a_coluna(p, colunas) == 0
    ]
    if not tokens:
        return list(colunas)

    pontuados = [t for t in tokens if _CODIGO_HIERARQUICO.match(t)]
    if len(pontuados) < 2:
        return list(colunas)
    # nível de topo da árvore: `1`, `2`, `3` sozinhos também são código
    raizes = [t for t in tokens if _CODIGO_RAIZ.match(t)]
    if (len(pontuados) + len(raizes)) / len(tokens) < 0.70:
        return list(colunas)

    logger.info(
        "coluna de CODIGO DE CONTA descartada: x1=%.1f, %d tokens (%s) -- "
        "documento padronizado da CVM",
        colunas[0].x1, len(tokens), ", ".join(tokens[:8]),
    )
    return list(colunas[1:])


def descartar_coluna_nota(
    colunas: Sequence[Coluna], palavras: Sequence[Palavra]
) -> list[Coluna]:
    """Remove a coluna "Nota"/"Nota explicativa", se houver.

    Muitas demonstrações põem, ENTRE o rótulo e os valores, uma coluna com o
    número da nota explicativa (4, 12, 23, às vezes "23.c"). Ela é alinhada à
    direita igual aos valores, então a detecção a encontra como coluna legítima
 - e aí "Nota 12" viraria o saldo de 2024.

    A decisão começa pela ESTRUTURA, não pelo formato do número: só é candidata
    a coluna MAIS À ESQUERDA do bloco de valores. Sobre ela, exige-se ainda que
    >=70% dos tokens tenham módulo < 100 e que NENHUM traga separador de
    milhar/decimal.

    A ordem dos critérios importa. Decidir pelo formato do número - "inteiro
    curto sem separador, então é nota" - condenaria qualquer coluna legítima de
    valores pequenos, e demonstração em milhares tem coluna inteira de 12, 45,
    80. O que desempata é a POSIÇÃO: uma coluna de valores de verdade não fica
    encravada entre o rótulo e as outras colunas de valores. Posição + magnitude
    + ausência de formatação monetária, juntos, só descrevem a coluna de notas.
    """
    if len(colunas) < 2:
        return list(colunas)

    tokens = [
        p.texto.strip()
        for p in palavras
        if (eh_token_valor(p.texto) or _EH_NOTA.match(p.texto.strip()))
        and atribuir_a_coluna(p, colunas) == 0
    ]
    if not tokens:
        return list(colunas)
    if any(_TEM_SEPARADOR.search(t) for t in tokens):
        return list(colunas)

    pequenos = 0
    for t in tokens:
        valor = para_numero(t)
        if valor is None:
            pequenos += 1 if _EH_NOTA.match(t) else 0
        elif abs(valor) < 100:
            pequenos += 1
    if pequenos / len(tokens) < 0.70:
        return list(colunas)

    logger.info(
        "coluna de notas descartada: x1=%.1f, %d tokens (%s)",
        colunas[0].x1, len(tokens), ", ".join(tokens[:8]),
    )
    return list(colunas[1:])


def mapear_cabecalho(
    palavras: Sequence[Palavra],
    colunas: Sequence[Coluna],
    top_max: float | None = None,
) -> list[str]:
    """Rótulo de cada coluna, na ordem em que as colunas aparecem na página.

    Procura, acima de `top_max` (default: a primeira linha de valores), datas
    (`dd/mm/aaaa`, `mm/aaaa`, `19xx|20xx`) e rótulos de visão (Controladora,
    Consolidado, Individual, Combinado) e casa cada um com a coluna por
    posição x.

    A ORDEM DAS VISÕES VEM DA POSIÇÃO X, NUNCA DA ORDEM DE `VISOES`. Publicação
    brasileira alterna as duas ordens sem aviso: quem assume "Controladora
    primeiro" troca os dois blocos de valores inteiros em metade dos arquivos, e
    o erro passa por todos os testes de soma porque as duas visões fecham
    individualmente.
    """
    if not colunas:
        return []
    if top_max is None:
        top_max = top_inicio_valores(palavras, colunas)

    cabecalho = [p for p in palavras if p.top < top_max]

    # visões ordenadas pela POSIÇÃO X (ver docstring)
    visoes: list[tuple[float, str]] = []
    for p in cabecalho:
        chave = _normalizar_simples(p.texto)
        if chave in VISOES:
            visoes.append((p.x_centro, VISOES[chave]))
    visoes.sort()

    # data por coluna; havendo mais de uma, vale a mais baixa (mais próxima do
    # corpo da tabela), que é a que de fato titula os valores.
    datas: dict[int, tuple[float, str]] = {}
    for p in cabecalho:
        texto = p.texto.strip()
        if not DATA_CABECALHO.match(texto):
            continue
        indice = atribuir_a_coluna(p, colunas)
        if indice is None:
            continue
        if indice not in datas or p.top > datas[indice][0]:
            datas[indice] = (p.top, texto)

    # REDE DE SEGURANÇA: datas no cabeçalho que não casaram com nenhuma coluna.
    #
    # `atribuir_a_coluna` compara pela borda direita, e um cabeçalho CENTRALIZADO
    # sobre a coluna (comum em formulário gerado por sistema) fica fora da
    # tolerância mesmo estando visivelmente sobre ela. Quando a QUANTIDADE de datas
    # é exatamente a de colunas, a correspondência por ordem de x é segura - não há
    # ambiguidade possível - e é muito melhor que rotular tudo `coluna 1`, que
    # obriga o analista a adivinhar qual exercício é qual.
    if not datas:
        # A LINHA das datas, não as datas soltas da página. O título do formulário
        # da CVM contém uma data também (`DFP ... 31/12/2025 ... FLEURY S.A.`), e
        # juntar tudo faria a data do título competir com as da tabela.
        #
        # A linha certa é a MAIS BAIXA que tenha 2+ datas: no formulário, é
        # `Conta 31/12/2025 31/12/2024 31/12/2023`. O título tem uma só.
        por_linha: dict[float, list[tuple[float, str]]] = {}
        for p in cabecalho:
            texto = p.texto.strip()
            if DATA_CABECALHO.match(texto):
                por_linha.setdefault(round(p.top, 1), []).append((p.x_centro, texto))
        candidatas = [
            (top, sorted(itens))
            for top, itens in por_linha.items()
            if len(itens) >= 2
        ]
        if candidatas:
            _, itens = max(candidatas)  # mais baixa = mais próxima do corpo
            if len(itens) == len(colunas):
                logger.info(
                    "datas do cabecalho casadas por ORDEM DE X (nenhuma casou por "
                    "borda direita): %s", [t for _, t in itens],
                )
                datas = {i: (0.0, t) for i, (_, t) in enumerate(itens)}

    rotulos: list[str] = []
    for i, coluna in enumerate(colunas):
        partes: list[str] = []
        if visoes:
            partes.append(min(visoes, key=lambda v: abs(coluna.x_centro - v[0]))[1])
        if i in datas:
            partes.append(datas[i][1])
        rotulos.append(" ".join(partes) if partes else f"coluna {i + 1}")

    return _desambiguar(rotulos)


def _normalizar_simples(texto: str) -> str:
    """Minúsculas sem acento e sem pontuação - o bastante para casar visão.

    Duplica de propósito o mínimo de `page_classifier.normalizar` para manter
    este módulo livre de dependência de classificação (evita import circular).
    """
    limpo = unicodedata.normalize("NFKD", (texto or "").strip().lower())
    return "".join(c for c in limpo if not unicodedata.combining(c) and c.isalnum())


def _desambiguar(rotulos: Sequence[str]) -> list[str]:
    """Garante rótulos únicos: eles são CHAVE de dicionário lá em `tables`."""
    contagem: dict[str, int] = {}
    saida: list[str] = []
    for r in rotulos:
        contagem[r] = contagem.get(r, 0) + 1
        saida.append(r if contagem[r] == 1 else f"{r} #{contagem[r]}")
    return saida
