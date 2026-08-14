"""
Testes da camada de leitura determinística de PDF.

OS PDFs SÃO GERADOS EM MEMÓRIA, À MÃO. Nada de arquivo externo e nada de
reportlab: o que está sob teste é a COORDENADA de cada palavra, e usar um
gerador de terceiros para produzir a fixture esconde exatamente isso.

O truque que torna a fixture exata é a fonte: /Courier é monoespaçada e todo
glifo mede 600/1000 em, ou seja 6.0pt no corpo 10. Com isso o alinhamento à
direita de um número é aritmética simples - `x0 = x1_desejado - 6.0 * len(texto)`
- e a borda direita de todos os valores de uma coluna cai EXATAMENTE na mesma
abscissa, que é o fato geométrico que `detectar_colunas` explora.
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Sequence

import pytest

# `server/` no sys.path: os módulos vivem em `app.reading.*`, como vão ser
# importados pelo FastAPI. Ainda não existe conftest.py no projeto, e depender
# do modo de import do pytest tornaria o teste sensível ao diretório de onde
# `pytest` foi chamado.
RAIZ_SERVER = Path(__file__).resolve().parents[1]
if str(RAIZ_SERVER) not in sys.path:
    sys.path.insert(0, str(RAIZ_SERVER))

from app.reading.columns import (  # noqa: E402
    atribuir_a_coluna,
    descartar_coluna_nota,
    detectar_colunas,
    eh_token_valor,
    mapear_cabecalho,
    para_numero,
)
from app.reading.page_classifier import (  # noqa: E402
    LIMIAR_ADMISSIVEL,
    classificar_documento,
    classificar_pagina,
    normalizar,
    tem_subtotal_aritmetico,
)
from app.reading.pdf_words import (  # noqa: E402
    Palavra,
    extrair_palavras,
    n_paginas,
    paginas_com_texto,
    renderizar_pagina,
)
from app.reading.tables import montar_linhas, nivel_por_indentacao  # noqa: E402

# ---------------------------------------------------------------------------
# Gerador de PDF mínimo
# ---------------------------------------------------------------------------
CORPO_FONTE = 10.0
LARGURA_CARACTERE = CORPO_FONTE * 0.6  # /Courier: todo glifo mede 600/1000 em
LARGURA_PAGINA = 612
ALTURA_PAGINA = 792

Item = tuple[float, float, str]  # (x0, y da linha de base, texto)


def esq(x0: float, y: float, texto: str) -> Item:
    """Texto alinhado à ESQUERDA em x0 (rótulo de conta)."""
    return (x0, y, texto)


def dirt(x1: float, y: float, texto: str) -> Item:
    """Texto alinhado à DIREITA em x1 (valor contábil)."""
    return (x1 - LARGURA_CARACTERE * len(texto), y, texto)


def linha_de_valores(
    y: float, x_rotulo: float, rotulo: str, bordas: Sequence[float],
    valores: Sequence[str | None],
) -> list[Item]:
    """Uma linha: rótulo à esquerda + valores alinhados à direita nas `bordas`."""
    itens = [esq(x_rotulo, y, rotulo)] if rotulo else []
    itens += [
        dirt(x1, y, v) for x1, v in zip(bordas, valores) if v is not None
    ]
    return itens


def _fluxo(itens: Sequence[Item]) -> bytes:
    """Content stream sem compressão: um BT/ET por item, posição absoluta.

    `(`, `)` e `\\` precisam de escape - sem isso o valor negativo em
    parênteses, que é o padrão CVM, quebraria o próprio arquivo.
    """
    partes = []
    for x, y, texto in itens:
        escapado = (
            texto.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        )
        partes.append(
            f"BT /F1 {CORPO_FONTE:g} Tf {x:.2f} {y:.2f} Td ({escapado}) Tj ET"
        )
    return "\n".join(partes).encode("latin-1")


def montar_pdf(paginas: Sequence[Sequence[Item]]) -> bytes:
    """PDF válido, sem compressão, com xref correto e fonte /Courier."""
    ids_pagina = [4 + 2 * i for i in range(len(paginas))]
    ids_conteudo = [5 + 2 * i for i in range(len(paginas))]

    corpos: list[bytes] = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        (
            "<< /Type /Pages /Count %d /Kids [%s] >>"
            % (len(paginas), " ".join(f"{i} 0 R" for i in ids_pagina))
        ).encode("latin-1"),
        # Widths explícito (600 para todo código) para que a métrica não dependa
        # da tabela AFM interna do pdfminer.
        (
            "<< /Type /Font /Subtype /Type1 /BaseFont /Courier "
            "/Encoding /WinAnsiEncoding /FirstChar 0 /LastChar 255 /Widths [%s] >>"
            % " ".join(["600"] * 256)
        ).encode("latin-1"),
    ]
    for i, itens in enumerate(paginas):
        corpos.append(
            (
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %d %d] "
                "/Resources << /Font << /F1 3 0 R >> >> /Contents %d 0 R >>"
                % (LARGURA_PAGINA, ALTURA_PAGINA, ids_conteudo[i])
            ).encode("latin-1")
        )
        fluxo = _fluxo(itens)
        corpos.append(
            f"<< /Length {len(fluxo)} >>\nstream\n".encode("latin-1")
            + fluxo
            + b"\nendstream"
        )

    saida = bytearray(b"%PDF-1.4\n")
    deslocamentos: list[int] = []
    for numero, corpo in enumerate(corpos, start=1):
        deslocamentos.append(len(saida))
        saida += f"{numero} 0 obj\n".encode("latin-1") + corpo + b"\nendobj\n"

    inicio_xref = len(saida)
    saida += f"xref\n0 {len(corpos) + 1}\n".encode("latin-1")
    saida += b"0000000000 65535 f \n"
    for deslocamento in deslocamentos:
        saida += f"{deslocamento:010d} 00000 n \n".encode("latin-1")
    saida += (
        f"trailer\n<< /Size {len(corpos) + 1} /Root 1 0 R >>\n"
        f"startxref\n{inicio_xref}\n%%EOF\n"
    ).encode("latin-1")
    return bytes(saida)


# ---------------------------------------------------------------------------
# Fixtures de página
# ---------------------------------------------------------------------------
BORDAS_BP = (400.0, 480.0)

# (y, x0 do rótulo, rótulo, valor 31/12/2025, valor 31/12/2024)
_BP: list[tuple[float, float, str, str | None, str | None]] = [
    (700, 50, "Ativo circulante", None, None),
    (686, 62, "Caixa e equivalentes de caixa", "1.000,00", "900,00"),
    (672, 62, "Contas a receber", "2.000,00", "1.800,00"),
    (658, 62, "Estoques", "3.000,00", "2.700,00"),
    (644, 50, "Total do ativo circulante", "6.000,00", "5.400,00"),
    (622, 50, "Ativo nao circulante", None, None),
    (608, 62, "Imobilizado", "4.000,00", "3.600,00"),
    (594, 62, "Intangivel", "1.000,00", "900,00"),
    (580, 50, "Total do ativo nao circulante", "5.000,00", "4.500,00"),
    (558, 50, "Total do ativo", "11.000,00", "9.900,00"),
    (536, 50, "Passivo circulante", None, None),
    (522, 62, "Fornecedores", "2.500,00", "2.000,00"),
    (508, 62, "Emprestimos e financiamentos", "1.500,00", "1.400,00"),
    (494, 50, "Total do passivo circulante", "4.000,00", "3.400,00"),
    (472, 50, "Patrimonio liquido", None, None),
    (458, 62, "Capital social", "5.000,00", "5.000,00"),
    (444, 62, "Reservas de lucros", "2.000,00", "1.500,00"),
    (430, 50, "Total do patrimonio liquido", "7.000,00", "6.500,00"),
    (408, 50, "Total do passivo", "11.000,00", "9.900,00"),
]


def pagina_bp() -> list[Item]:
    """Balanço com 2 colunas, uma visão e subtotais que fecham nas duas."""
    itens: list[Item] = [
        esq(50, 752, "Balanco Patrimonial"),
        esq(50, 736, "(Em milhares de reais)"),
        esq(380, 736, "Controladora"),
        dirt(BORDAS_BP[0], 722, "31/12/2025"),
        dirt(BORDAS_BP[1], 722, "31/12/2024"),
    ]
    for y, x0, rotulo, v1, v2 in _BP:
        itens += linha_de_valores(y, x0, rotulo, BORDAS_BP, (v1, v2))
    return itens


BORDAS_4 = (340.0, 410.0, 480.0, 550.0)


def pagina_quatro_colunas() -> list[Item]:
    """4 colunas e DUAS visões, com Consolidado À ESQUERDA de Controladora.

    A ordem invertida em relação à lista `VISOES` é deliberada: é o teste de que
    o rótulo sai da posição x e não da ordem de uma lista pré-definida.
    """
    itens: list[Item] = [
        esq(318, 740, "Consolidado"),    # centro 351 -> cobre as colunas 1 e 2
        esq(455, 740, "Controladora"),   # centro 491 -> cobre as colunas 3 e 4
        dirt(BORDAS_4[0], 726, "31/12/2025"),
        dirt(BORDAS_4[1], 726, "31/12/2024"),
        dirt(BORDAS_4[2], 726, "31/12/2025"),
        dirt(BORDAS_4[3], 726, "31/12/2024"),
    ]
    dados = [
        (700, "Caixa e equivalentes de caixa", "1.000,00", "900,00", "1.100,00", "950,00"),
        (686, "Contas a receber", "2.000,00", "1.800,00", "2.100,00", "1.850,00"),
        (672, "Estoques", "3.000,00", "2.700,00", "3.100,00", "2.750,00"),
        (658, "Total do ativo circulante", "6.000,00", "5.400,00", "6.300,00", "5.550,00"),
    ]
    for y, rotulo, *valores in dados:
        itens += linha_de_valores(y, 50, rotulo, BORDAS_4, valores)
    return itens


BORDAS_TRACO = (400.0, 480.0, 560.0)


def pagina_com_traco() -> list[Item]:
    """3 colunas; a linha do meio tem TRAÇO na coluna 2 e negativo na coluna 3."""
    itens: list[Item] = []
    dados = [
        (700, "Conta A", "1.000,00", "2.000,00", "3.000,00"),
        (686, "Conta B", "1.100,00", "-", "(3.300,00)"),
        (672, "Conta C", "1.200,00", "2.200,00", "3.600,00"),
    ]
    for y, rotulo, *valores in dados:
        itens += linha_de_valores(y, 50, rotulo, BORDAS_TRACO, valores)
    return itens


BORDAS_NOTA = (330.0, 420.0, 500.0)


def pagina_com_coluna_nota() -> list[Item]:
    """Coluna de nota explicativa entre o rótulo e os dois valores."""
    itens: list[Item] = []
    dados = [
        (700, "Caixa e equivalentes", "4", "1.000,00", "900,00"),
        (686, "Contas a receber", "5", "2.000,00", "1.800,00"),
        (672, "Estoques", "12", "3.000,00", "2.700,00"),
        (658, "Imobilizado", "7", "4.000,00", "3.600,00"),
    ]
    for y, rotulo, *valores in dados:
        itens += linha_de_valores(y, 50, rotulo, BORDAS_NOTA, valores)
    return itens


def pagina_rotulo_quebrado() -> list[Item]:
    """Rótulo partido em duas linhas físicas, no mesmo nível de indentação."""
    itens: list[Item] = [esq(62, 700, "Emprestimos e financiamentos de")]
    dados = [
        (686, "curto prazo", "1.500,00", "1.400,00"),
        (672, "Fornecedores", "2.500,00", "2.000,00"),
        (658, "Outras obrigacoes", "3.500,00", "3.000,00"),
    ]
    for y, rotulo, *valores in dados:
        itens += linha_de_valores(y, 62, rotulo, BORDAS_BP, valores)
    return itens


_RECEITA = [
    "Receita de bolo de cenoura da vovo Marta",
    "Ingredientes: cenoura ralada, oleo de milho, ovos inteiros, acucar,",
    "farinha de trigo peneirada, fermento em po quimico e uma pitada de sal.",
    "Modo de preparo: bata no liquidificador a cenoura, o oleo e os ovos",
    "por 3 minutos, ate obter um creme homogeneo e bem liso, sem pedacos.",
    "Acrescente o acucar e bata novamente. Passe a mistura para a vasilha",
    "grande e incorpore a farinha peneirada aos poucos, mexendo devagar",
    "com um batedor de arame para nao perder o ar da massa e deixar leve.",
    "Por fim adicione o fermento e mexa sem pressa. Unte a forma e",
    "polvilhe farinha de trigo. Asse em forno preaquecido a 180 graus.",
    "Faca o teste do palito: se sair seco, o bolo esta pronto para servir.",
    "Deixe esfriar por 40 minutos antes de desenformar sobre um prato.",
]


def pagina_receita() -> list[Item]:
    """Texto corrido sem âncora, sem coluna alinhada e sem soma nenhuma."""
    return [esq(50, 740 - 16 * i, texto) for i, texto in enumerate(_RECEITA)]


# ---------------------------------------------------------------------------
# DOIS CAMINHOS PARA A MESMA VERDADE
#
# `pdfplumber`/`pypdfium2` só existem no notebook servidor (a máquina de
# desenvolvimento está atrás de proxy que bloqueia o PyPI - ver
# docs/09-runbook-notebook.md).
#
# Onde as libs existem, `palavras_de` monta um PDF de verdade e o lê de volta:
# é TESTE DE INTEGRAÇÃO, e valida também o `pdf_words`.
# Onde não existem, os mesmos fixtures viram `Palavra` diretamente - as
# coordenadas já são exatas, porque `dirt()` calcula x1 a partir da largura do
# glifo de /Courier. É TESTE DE LÓGICA, e cobre tudo que importa: clusterização
# de coluna, traço como célula vazia, coluna Nota, score de página, hierarquia.
#
# Assim nenhum teste é silenciosamente pulado por falta de dependência.
# ---------------------------------------------------------------------------
try:
    import pdfplumber as _pdfplumber_probe  # noqa: F401
    TEM_LIBS_PDF = True
except ImportError:
    TEM_LIBS_PDF = False


def _palavras_sinteticas(pagina: Sequence[Item], numero: int = 1) -> list[Palavra]:
    """Converte os itens do fixture em `Palavra`, sem passar por PDF.

    `y` do fixture é a linha de BASE, com origem embaixo (convenção PDF).
    `Palavra.top` cresce para baixo (convenção pdfplumber), então
    `top = ALTURA_PAGINA - y - ascendente`.
    """
    ascendente = CORPO_FONTE * 0.75
    descendente = CORPO_FONTE * 0.25
    palavras: list[Palavra] = []
    for x0, y, texto in pagina:
        # pdfplumber quebra por espaço em branco; reproduzimos isso para que a
        # granularidade das palavras seja a mesma nos dois caminhos.
        deslocamento = 0.0
        for pedaco in texto.split(" "):
            if pedaco:
                inicio = x0 + deslocamento * LARGURA_CARACTERE
                palavras.append(Palavra(
                    texto=pedaco,
                    x0=inicio,
                    x1=inicio + LARGURA_CARACTERE * len(pedaco),
                    top=ALTURA_PAGINA - y - ascendente,
                    bottom=ALTURA_PAGINA - y + descendente,
                    pagina=numero,
                ))
            deslocamento += len(pedaco) + 1
    # mesma ordem de leitura que o pdfplumber devolve
    palavras.sort(key=lambda p: (round(p.top, 1), p.x0))
    return palavras


def palavras_de(pagina: Sequence[Item]) -> list[Palavra]:
    """Palavras de uma página do fixture, com ou sem as libs de PDF."""
    if TEM_LIBS_PDF:
        return extrair_palavras(montar_pdf([pagina]), 1)
    return _palavras_sinteticas(pagina)


def _exige_libs_pdf() -> None:
    """Pula só os testes que verificam a INTEGRAÇÃO com as libs de PDF."""
    if not TEM_LIBS_PDF:
        pytest.skip("pdfplumber/pypdfium2 só no notebook servidor "
                    "(ver docs/09-runbook-notebook.md)")


# ---------------------------------------------------------------------------
# (a) para_numero em todos os formatos
# ---------------------------------------------------------------------------
def test_para_numero_formatos_brasileiros():
    assert para_numero("1.234.567,89") == pytest.approx(1234567.89)
    assert para_numero("(55.497)") == pytest.approx(-55497.0)
    assert para_numero("-1.234") == pytest.approx(-1234.0)
    assert para_numero("1.234,56-") == pytest.approx(-1234.56)
    assert para_numero("R$ 1.000") == pytest.approx(1000.0)
    assert para_numero("R$ 1.234,56") == pytest.approx(1234.56)
    assert para_numero("(1.234,56)") == pytest.approx(-1234.56)
    assert para_numero("1.000") == pytest.approx(1000.0)
    assert para_numero("12,5") == pytest.approx(12.5)
    assert para_numero("2025") == pytest.approx(2025.0)
    # formato US, que aparece em release de subsidiária de multinacional
    assert para_numero("1,234,567.89") == pytest.approx(1234567.89)


def test_para_numero_traco_e_vazio():
    # traço é CÉLULA VAZIA, não zero: zero é uma afirmação contábil.
    for traco in ("-", "\u2013", "\u2014", " - "):
        assert para_numero(traco) is None
    assert para_numero("") is None
    assert para_numero("abc") is None
    assert para_numero("23.c") is None
    # e zero continua sendo zero, não vazio
    assert para_numero("0,00") == 0.0
    assert para_numero("0,00") is not None


def test_eh_token_valor():
    for texto in ("1.234.567,89", "(55.497)", "-1.234", "1.234,56-", "R$ 1.000",
                  "1.000", "0,00", "2025", "-", "\u2013", "\u2014"):
        assert eh_token_valor(texto), texto
    for texto in ("Total", "R$", "", "23.c", "12/2025", "31/12/2025", "1a"):
        assert not eh_token_valor(texto), texto


# ---------------------------------------------------------------------------
# (b) detectar_colunas acha 2 e 4 colunas
# ---------------------------------------------------------------------------
def test_detectar_colunas_duas():
    colunas = detectar_colunas(palavras_de(pagina_bp()))
    assert len(colunas) == 2
    assert [round(c.x1) for c in colunas] == [400, 480]
    assert all(c.n >= 3 for c in colunas)


def test_detectar_colunas_quatro():
    colunas = detectar_colunas(palavras_de(pagina_quatro_colunas()))
    assert len(colunas) == 4
    assert [round(c.x1) for c in colunas] == [340, 410, 480, 550]


def test_detectar_colunas_ignora_numero_solto():
    # 3 números soltos em prosa não formam coluna: min_ocorrencias os elimina.
    assert detectar_colunas(palavras_de(pagina_receita())) == []


# ---------------------------------------------------------------------------
# (c) traço no meio NÃO desloca as colunas seguintes
# ---------------------------------------------------------------------------
def test_traco_no_meio_nao_desloca_as_colunas():
    palavras = palavras_de(pagina_com_traco())
    colunas = detectar_colunas(palavras)
    assert len(colunas) == 3

    rotulos = ["c1", "c2", "c3"]
    linhas = montar_linhas(palavras, colunas, rotulos)
    assert [l.rotulo for l in linhas] == ["Conta A", "Conta B", "Conta C"]

    meio = linhas[1]
    assert meio.valores["c1"] == pytest.approx(1100.0)
    assert meio.valores["c2"] is None          # traço = vazio, e não zero
    assert meio.valores["c3"] == pytest.approx(-3300.0)  # e c3 NÃO virou c2

    # as vizinhas continuam intactas
    assert linhas[0].valores["c3"] == pytest.approx(3000.0)
    assert linhas[2].valores["c2"] == pytest.approx(2200.0)


def test_traco_ocupa_a_coluna_certa():
    palavras = palavras_de(pagina_com_traco())
    colunas = detectar_colunas(palavras)
    traco = next(p for p in palavras if p.texto.strip() == "-")
    assert atribuir_a_coluna(traco, colunas) == 1


# ---------------------------------------------------------------------------
# (d) descartar_coluna_nota
# ---------------------------------------------------------------------------
def test_descartar_coluna_nota():
    palavras = palavras_de(pagina_com_coluna_nota())
    colunas = detectar_colunas(palavras)
    assert len(colunas) == 3  # a de notas é detectada como coluna legítima

    sem_nota = descartar_coluna_nota(colunas, palavras)
    assert len(sem_nota) == 2
    assert [round(c.x1) for c in sem_nota] == [420, 500]

    # e o número da nota não vaza para o rótulo
    linhas = montar_linhas(palavras, sem_nota, ["2025", "2024"])
    assert linhas[0].rotulo == "Caixa e equivalentes"
    assert linhas[0].valores == {"2025": 1000.0, "2024": 900.0}


def test_nao_descarta_coluna_de_valores():
    # colunas formatadas com separador de milhar nunca são confundidas com nota
    palavras = palavras_de(pagina_bp())
    colunas = detectar_colunas(palavras)
    assert descartar_coluna_nota(colunas, palavras) == colunas


# ---------------------------------------------------------------------------
# (e) classificar_pagina: score alto para BP, ~0 para receita de bolo
# ---------------------------------------------------------------------------
def test_classificar_pagina_balanco():
    palavras = palavras_de(pagina_bp())
    colunas = descartar_coluna_nota(detectar_colunas(palavras), palavras)
    c = classificar_pagina(palavras, colunas, pagina=1)

    assert c.tipo == "BP"
    assert c.score >= 0.85
    assert c.n_colunas == 2
    assert c.densidade_numerica > 0.15
    assert c.tem_subtotal_aritmetico is True
    assert any("subtotal" in e for e in c.evidencias)


def test_classificar_pagina_receita_de_bolo():
    palavras = palavras_de(pagina_receita())
    colunas = detectar_colunas(palavras)
    c = classificar_pagina(palavras, colunas, pagina=1)

    assert c.tipo == "outro"
    assert c.score <= 0.1
    assert c.n_colunas == 0
    assert c.tem_subtotal_aritmetico is False


# ---------------------------------------------------------------------------
# (f) classificar_documento rejeita receita de bolo sem chamar LLM
# ---------------------------------------------------------------------------
def test_classificar_documento_rejeita_receita_de_bolo():
    _exige_libs_pdf()
    relatorio = classificar_documento(montar_pdf([pagina_receita()]))
    assert relatorio.admissivel is False
    assert relatorio.n_paginas == 1
    assert relatorio.paginas[0].score <= 0.1
    assert "nao tem estrutura" in relatorio.motivo


def test_classificar_documento_aceita_balanco():
    _exige_libs_pdf()
    pdf = montar_pdf([pagina_bp(), pagina_receita()])
    relatorio = classificar_documento(pdf)
    assert relatorio.admissivel is True
    assert relatorio.n_paginas == 2
    assert relatorio.paginas[0].tipo == "BP"
    assert relatorio.paginas[1].tipo == "outro"
    assert [p.pagina for p in relatorio.paginas] == [1, 2]
    assert len(relatorio.paginas_admissiveis) == 1


# ---------------------------------------------------------------------------
# (g) tem_subtotal_aritmetico
# ---------------------------------------------------------------------------
def test_tem_subtotal_aritmetico_detecta_soma():
    linhas = [
        {"2025": 1000.0, "2024": 900.0},
        {"2025": 2000.0, "2024": 1800.0},
        {"2025": 3000.0, "2024": 2700.0},
        {"2025": 6000.0, "2024": 5400.0},
    ]
    assert tem_subtotal_aritmetico(linhas) is True


def test_tem_subtotal_aritmetico_rejeita_coincidencia_de_uma_coluna():
    # 10 + 20 = 30 na coluna "a", mas a coluna "b" não fecha: coincidência de
    # uma coluna só NÃO é evidência.
    linhas = [
        {"a": 10.0, "b": 5.0},
        {"a": 20.0, "b": 7.0},
        {"a": 30.0, "b": 99.0},
    ]
    assert tem_subtotal_aritmetico(linhas) is False


def test_tem_subtotal_aritmetico_tolera_arredondamento_e_ignora_zeros():
    assert tem_subtotal_aritmetico(
        [{"a": 100.0}, {"a": 200.0}, {"a": 300.4}]
    ) is True
    # bloco de zeros somando um total zerado é trivial, não é evidência
    assert tem_subtotal_aritmetico([{"a": 0.0}, {"a": 0.0}, {"a": 0.0}]) is False
    # célula vazia (None) não entra na soma
    assert tem_subtotal_aritmetico(
        [{"a": 10.0}, {"a": None}, {"a": 10.0}]
    ) is False


# ---------------------------------------------------------------------------
# Cabeçalho: a ordem das visões vem da posição x
# ---------------------------------------------------------------------------
def test_mapear_cabecalho_ordem_das_visoes_vem_do_x():
    palavras = palavras_de(pagina_quatro_colunas())
    colunas = detectar_colunas(palavras)
    assert mapear_cabecalho(palavras, colunas) == [
        "Consolidado 31/12/2025",
        "Consolidado 31/12/2024",
        "Controladora 31/12/2025",
        "Controladora 31/12/2024",
    ]


def test_mapear_cabecalho_uma_visao():
    palavras = palavras_de(pagina_bp())
    colunas = detectar_colunas(palavras)
    assert mapear_cabecalho(palavras, colunas) == [
        "Controladora 31/12/2025",
        "Controladora 31/12/2024",
    ]


# ---------------------------------------------------------------------------
# tables: rótulo quebrado, indentação e leitura ponta a ponta
# ---------------------------------------------------------------------------
def test_rotulo_quebrado_em_duas_linhas():
    palavras = palavras_de(pagina_rotulo_quebrado())
    colunas = detectar_colunas(palavras)
    linhas = montar_linhas(palavras, colunas, ["2025", "2024"])

    assert [l.rotulo for l in linhas] == [
        "Emprestimos e financiamentos de curto prazo",
        "Fornecedores",
        "Outras obrigacoes",
    ]
    assert linhas[0].valores["2025"] == pytest.approx(1500.0)


def test_nivel_por_indentacao():
    palavras = palavras_de(pagina_bp())
    colunas = detectar_colunas(palavras)
    linhas = montar_linhas(palavras, colunas, ["2025", "2024"])
    nivel_por_indentacao(linhas)

    por_rotulo = {l.rotulo: l for l in linhas}
    margem = por_rotulo["Total do ativo"]
    recuada = por_rotulo["Caixa e equivalentes de caixa"]
    assert margem.nivel_indentacao < recuada.nivel_indentacao


def test_leitura_completa_do_balanco():
    palavras = palavras_de(pagina_bp())
    colunas = descartar_coluna_nota(detectar_colunas(palavras), palavras)
    rotulos = mapear_cabecalho(palavras, colunas)
    linhas = montar_linhas(palavras, colunas, rotulos)

    por_rotulo = {l.rotulo: l.valores for l in linhas}
    assert por_rotulo["Total do ativo"] == {
        "Controladora 31/12/2025": 11000.0,
        "Controladora 31/12/2024": 9900.0,
    }
    # o total do passivo fecha com o total do ativo - o balanço bate
    assert por_rotulo["Total do passivo"] == por_rotulo["Total do ativo"]
    # cabeçalho de seção existe como linha, sem valor nenhum
    assert por_rotulo["Ativo circulante"] == {
        "Controladora 31/12/2025": None,
        "Controladora 31/12/2024": None,
    }


# ---------------------------------------------------------------------------
# pdf_words
# ---------------------------------------------------------------------------
def test_n_paginas_e_paginas_com_texto():
    _exige_libs_pdf()
    pdf = montar_pdf([pagina_bp(), pagina_receita()])
    assert n_paginas(pdf) == 2
    # o balanço tem texto e números de sobra; a receita tem texto mas quase
    # nenhum dígito - e texto sem número não é demonstração financeira.
    assert paginas_com_texto(pdf) == {1: True, 2: False}


def test_extrair_palavras_tem_coordenadas_coerentes():
    _exige_libs_pdf()
    palavras = palavras_de(pagina_bp())
    assert palavras, "nenhuma palavra extraida do PDF sintetico"
    assert all(p.pagina == 1 for p in palavras)
    assert all(p.x1 > p.x0 and p.bottom > p.top for p in palavras)
    # /Courier no corpo 10: 6.0pt por caractere, exato
    caixa = next(p for p in palavras if p.texto == "Estoques")
    assert caixa.x1 - caixa.x0 == pytest.approx(6.0 * len("Estoques"), abs=0.05)


def test_renderizar_pagina_devolve_png():
    _exige_libs_pdf()
    png = renderizar_pagina(montar_pdf([pagina_bp()]), 1, escala=1.0)
    assert png[:8] == b"\x89PNG\r\n\x1a\n"


def test_normalizar_espelha_o_portal():
    # mesmo contrato de portal/src/core/normalize.js
    assert normalizar("  Patrimônio Líquido  ") == "patrimonio liquido"
    assert normalizar("Caixa e equivalentes (nota 4)") == "caixa e equivalentes nota 4"
    assert normalizar(None) == ""
    # o gate é 0.5 e mudá-lo em silêncio é mudar o que o sistema aceita ler
    assert LIMIAR_ADMISSIVEL == 0.50
