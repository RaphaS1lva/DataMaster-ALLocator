"""
CAMADA DE LEITURA DETERMINÍSTICA DE PDF - sem LLM, sem token, sem GPU.

Demonstração financeira brasileira é tabela SEM BORDA, alinhada por whitespace.
A leitura aqui se apoia num único fato geométrico: numa demonstração, COLUNA É
COORDENADA X. Todo valor de uma coluna tem a mesma borda direita, porque número
contábil é alinhado à direita. Clusterizar os x1 dos números devolve as colunas
sem modelo, sem treino e sem ambiguidade.

Ordem das etapas:

    pdf_words       bytes            -> palavras com caixa (x0, x1, top, bottom)
    columns         palavras         -> colunas (cluster de x1) + rótulos do cabeçalho
    tables          palavras+colunas -> linhas (rótulo, valores, indentação)
    page_classifier tudo             -> tipo da página, score e ADMISSIBILIDADE

Descartamos Docling deliberadamente: o TableFormer erra tabela sem borda
alinhada por whitespace (docling-project/docling#3749), que é exatamente o nosso
caso, e traz ~2GB de PyTorch.
"""
from __future__ import annotations

from .columns import (
    TOKEN_VALOR,
    Coluna,
    agrupar_por_gap,
    atribuir_a_coluna,
    descartar_coluna_codigo,
    descartar_coluna_nota,
    detectar_colunas,
    eh_token_valor,
    mapear_cabecalho,
    para_numero,
    top_inicio_valores,
)
from .page_classifier import (
    ANCORAS_BALANCETE,
    ANCORAS_BP,
    ANCORAS_DRE,
    ANCORAS_NEGATIVAS,
    LIMIAR_ADMISSIVEL,
    ClassificacaoPagina,
    RelatorioLeitura,
    classificar_documento,
    classificar_pagina,
    normalizar,
    tem_subtotal_aritmetico,
)
from .pdf_words import (
    Palavra,
    extrair_palavras,
    n_paginas,
    paginas_com_texto,
    palavras_por_pagina,
    renderizar_pagina,
)
from .tables import (
    LinhaLida,
    agrupar_em_linhas,
    juntar_rotulos_quebrados,
    montar_linhas,
    nivel_por_indentacao,
)

__all__ = [
    # pdf_words
    "Palavra",
    "extrair_palavras",
    "palavras_por_pagina",
    "paginas_com_texto",
    "renderizar_pagina",
    "n_paginas",
    # columns
    "Coluna",
    "TOKEN_VALOR",
    "eh_token_valor",
    "para_numero",
    "detectar_colunas",
    "atribuir_a_coluna",
    "descartar_coluna_codigo",
    "descartar_coluna_nota",
    "mapear_cabecalho",
    "top_inicio_valores",
    "agrupar_por_gap",
    # tables
    "LinhaLida",
    "montar_linhas",
    "agrupar_em_linhas",
    "juntar_rotulos_quebrados",
    "nivel_por_indentacao",
    # page_classifier
    "ClassificacaoPagina",
    "RelatorioLeitura",
    "ANCORAS_BP",
    "ANCORAS_DRE",
    "ANCORAS_BALANCETE",
    "ANCORAS_NEGATIVAS",
    "LIMIAR_ADMISSIVEL",
    "normalizar",
    "classificar_pagina",
    "classificar_documento",
    "tem_subtotal_aritmetico",
]
