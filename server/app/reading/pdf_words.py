"""
Camada mais baixa da leitura: transforma bytes de PDF em PALAVRAS com
coordenadas, e página escaneada em PNG.

POR QUE pdfplumber E NÃO Docling/TableFormer
--------------------------------------------
Balanço Patrimonial e DRE brasileiros são tabelas SEM BORDA, alinhadas por
whitespace. O TableFormer do Docling falha exatamente nesse caso
(github.com/docling-project/docling/issues/3749) e ainda arrasta ~2GB de
PyTorch para dentro da imagem. Aqui a tabela é reconstruída a partir da
COORDENADA X das palavras (ver `columns.py`): determinístico, auditável,
explicável linha por linha e com custo zero de token.

Convenções deste módulo:
  · toda função recebe `pdf_bytes: bytes` (nada de path - o upload chega em
    memória e nunca é gravado em disco);
  · página é sempre 1-based, como o usuário vê no leitor de PDF;
  · `top` cresce para BAIXO (origem no canto superior esquerdo), que é a
    convenção do pdfplumber e a que usamos em todo o pipeline.
"""
from __future__ import annotations

import io
import logging
from dataclasses import dataclass

logger = logging.getLogger(__name__)

# IMPORTS PREGUIÇOSOS DE PROPÓSITO.
#
# `pdfplumber` e `pypdfium2` só existem no notebook servidor (ver
# docs/09-runbook-notebook.md). Importá-los no topo deste módulo tornaria
# `columns.py`, `page_classifier.py` e `tables.py` - que são LÓGICA PURA sobre a
# dataclass `Palavra` - impossíveis de importar e de testar sem as libs de PDF.
#
# Isso não é só conveniência de ambiente: é a fronteira certa. I/O de PDF fica
# confinado neste arquivo; todo o resto opera sobre `Palavra` e é testável com
# listas construídas à mão.


def _pdfplumber():
    import pdfplumber  # noqa: PLC0415
    return pdfplumber


def _pdfium():
    import pypdfium2  # noqa: PLC0415
    return pypdfium2


# Uma página só é considerada "com texto" se passar nos DOIS pisos abaixo.
# O piso de dígitos existe porque PDF escaneado com OCR ruim costuma devolver
# um punhado de letras soltas: texto sem número não é demonstração financeira,
# é ruído - e tratar ruído como texto faz a página escaneada NÃO ir para a
# visão, que é o pior dos mundos (leitura silenciosamente vazia).
MIN_CARACTERES_TEXTO = 200
MIN_DIGITOS_TEXTO = 30


@dataclass(frozen=True)
class Palavra:
    """Uma palavra com sua caixa na página. É a unidade de tudo o que vem depois."""

    texto: str
    x0: float
    x1: float
    top: float
    bottom: float
    pagina: int

    @property
    def largura(self) -> float:
        return self.x1 - self.x0

    @property
    def altura(self) -> float:
        return self.bottom - self.top

    @property
    def x_centro(self) -> float:
        return (self.x0 + self.x1) / 2.0


def _abrir(pdf_bytes: bytes):
    """`pdfplumber.open` sobre um buffer em memória (usar como context manager)."""
    return _pdfplumber().open(io.BytesIO(pdf_bytes))


def _palavras_da_pagina(pagina_plumber, numero: int) -> list[Palavra]:
    """Converte os dicts do pdfplumber em `Palavra`.

    `keep_blank_chars=False` para não colar rótulo e valor num único token, e
    `use_text_flow=False` para ignorar a ordem interna do content stream e usar
    a ordem GEOMÉTRICA (cima→baixo, esquerda→direita): num PDF gerado por ERP a
    ordem do stream costuma ser coluna a coluna, o que embaralharia as linhas.
    """
    brutas = pagina_plumber.extract_words(keep_blank_chars=False, use_text_flow=False)
    return [
        Palavra(
            texto=b["text"],
            x0=float(b["x0"]),
            x1=float(b["x1"]),
            top=float(b["top"]),
            bottom=float(b["bottom"]),
            pagina=numero,
        )
        # palavra rotacionada é marca d'água / carimbo de "cópia controlada";
        # ela não pertence a nenhuma coluna e só sujaria a clusterização.
        for b in brutas
        if b.get("upright", True)
    ]


def extrair_palavras(pdf_bytes: bytes, pagina: int) -> list[Palavra]:
    """Palavras de UMA página, com coordenadas (página 1-based)."""
    with _abrir(pdf_bytes) as pdf:
        return _palavras_da_pagina(pdf.pages[pagina - 1], pagina)


def palavras_por_pagina(pdf_bytes: bytes) -> dict[int, list[Palavra]]:
    """Palavras de TODAS as páginas abrindo o PDF uma única vez.

    Existe para que `classificar_documento` não reabra o arquivo por página,
    em documento de 200 páginas isso dominava o tempo de resposta.
    """
    with _abrir(pdf_bytes) as pdf:
        return {n: _palavras_da_pagina(p, n) for n, p in enumerate(pdf.pages, start=1)}


def paginas_com_texto(pdf_bytes: bytes) -> dict[int, bool]:
    """Mapa `página -> tem camada de texto`.

    `False` significa página escaneada (imagem): a leitura determinística não
    tem o que ler e a página precisa ser renderizada e mandada para a visão.
    """
    resultado: dict[int, bool] = {}
    with _abrir(pdf_bytes) as pdf:
        for numero, pagina in enumerate(pdf.pages, start=1):
            texto = pagina.extract_text() or ""
            digitos = sum(1 for c in texto if c.isdigit())
            resultado[numero] = (
                len(texto) >= MIN_CARACTERES_TEXTO and digitos >= MIN_DIGITOS_TEXTO
            )
            if not resultado[numero]:
                logger.debug(
                    "pagina %d sem texto util (%d caracteres, %d digitos)",
                    numero, len(texto), digitos,
                )
    return resultado


def n_paginas(pdf_bytes: bytes) -> int:
    """Quantidade de páginas do PDF."""
    with _abrir(pdf_bytes) as pdf:
        return len(pdf.pages)


def renderizar_pagina(pdf_bytes: bytes, pagina: int, escala: float = 2.0) -> bytes:
    """Rasteriza uma página em PNG (`escala=2.0` ≈ 144 dpi).

    Só é usado no caminho de exceção (página sem texto). O import de
    `pypdfium2` é preguiçoso (ver topo do módulo): quem faz leitura de PDF com
    camada de texto - a maioria - não paga o carregamento da lib nativa do
    PDFium.
    """
    documento = _pdfium().PdfDocument(pdf_bytes)
    bitmap = documento[pagina - 1].render(scale=escala)
    imagem = bitmap.to_pil()  # requer pillow
    buffer = io.BytesIO()
    imagem.save(buffer, format="PNG")
    documento.close()
    logger.debug("pagina %d renderizada em %s px", pagina, imagem.size)
    return buffer.getvalue()
