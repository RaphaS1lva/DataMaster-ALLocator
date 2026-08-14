"""
Classificação de página e GATE DE ADMISSIBILIDADE - zero token.

O que este módulo responde, sem chamar nenhum LLM:

  1. esta página é Balanço, DRE, balancete ou outra coisa?
  2. este documento é uma demonstração financeira, ou é uma receita de bolo,
     um contrato, um currículo?

A pergunta 2 é a que economiza dinheiro e evita alucinação: um PDF que não é
demonstração tem score ~0 e é REJEITADO antes de qualquer chamada de modelo.

A evidência mais forte não é textual, é ARITMÉTICA: existir uma linha que é a
soma exata de um bloco contíguo de linhas anteriores, em TODAS as colunas ao
mesmo tempo. Âncora textual pode ser fabricada - basta escrever "Ativo
circulante" num documento qualquer, inclusive de propósito, para tentar induzir
o pipeline. Um sistema de somas coerente em duas ou mais colunas, não: teria de
ser construído para isso. Daí o peso mais alto ser o do subtotal.
"""
from __future__ import annotations

import logging
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Mapping, Sequence

from .columns import (
    Coluna,
    descartar_coluna_codigo,
    descartar_coluna_nota,
    detectar_colunas,
    eh_token_valor,
)
from .pdf_words import Palavra, n_paginas, paginas_com_texto, palavras_por_pagina
from .tables import montar_linhas

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Âncoras (já normalizadas: minúsculas, sem acento, espaço simples)
# ---------------------------------------------------------------------------
# Quase todas as âncoras têm DUAS palavras ou mais, de propósito: "ativo",
# "receita" ou "saldo" sozinhos aparecem em contrato, proposta e e-mail, e
# gerariam falso positivo no gate de admissibilidade. As poucas de uma palavra
# ("imobilizado", "intangivel", "estoques", "fornecedores", "balancete") são
# termos técnicos que não aparecem em texto corrido comum.
ANCORAS_BP: list[str] = [
    "balanco patrimonial",
    "ativo circulante",
    "ativo nao circulante",
    "passivo circulante",
    "passivo nao circulante",
    "patrimonio liquido",
    "total do ativo",
    "total do passivo",
    "caixa e equivalentes de caixa",
    "contas a receber",
    "realizavel a longo prazo",
    "imobilizado",
    "intangivel",
    "estoques",
    "fornecedores",
    "obrigacoes sociais e trabalhistas",
    "obrigacoes fiscais",
    "emprestimos e financiamentos",
    "capital social",
    "reservas de lucros",
    "reservas de capital",
    "lucros ou prejuizos acumulados",
    "adiantamento de clientes",
    "partes relacionadas",
]
ANCORAS_DRE: list[str] = [
    "demonstracao do resultado",
    "receita liquida",
    "receita operacional liquida",
    "receita de vendas",
    "receita bruta",
    "custo dos produtos vendidos",
    "custo dos bens e ou servicos vendidos",
    "custo dos servicos prestados",
    "lucro bruto",
    "despesas com vendas",
    "despesas gerais e administrativas",
    "despesas administrativas",
    "outras receitas operacionais",
    "resultado antes do resultado financeiro",
    "resultado financeiro",
    "receitas financeiras",
    "despesas financeiras",
    "lucro antes do imposto de renda",
    "imposto de renda e contribuicao social",
    "lucro liquido do exercicio",
    "lucro liquido do periodo",
    "prejuizo do exercicio",
    "lucro por acao",
]
ANCORAS_BALANCETE: list[str] = [
    "balancete",
    "balancete de verificacao",
    "saldo anterior",
    "saldo atual",
    "saldo final",
    "movimento do periodo",
    "movimentacao do periodo",
    "conta contabil",
    "codigo reduzido",
    "debito credito",
    "natureza do saldo",
    "razao contabil",
]
# Páginas que TÊM cara de demonstração, somam corretamente e ainda assim não
# servem: o pipeline mapeia BP e DRE, e ler DFC/DMPL/DVA como se fossem uma
# delas cria linha duplicada no template. Por isso a penalidade é grande o
# suficiente para vencer âncora + colunas.
ANCORAS_NEGATIVAS: list[str] = [
    "fluxo de caixa",
    "demonstracao dos fluxos",
    "mutacoes do patrimonio",
    "dmpl",
    "valor adicionado",
    "dva",
    "notas explicativas",
    "relatorio do auditor",
    "parecer dos auditores",
    "sumario",
    "indice",
]

PESO_ANCORA = 0.35
PESO_COLUNAS = 0.20
PESO_DENSIDADE = 0.15
PESO_SUBTOTAL = 0.30

# Âncora negativa no TÍTULO é VETO (score = 0): a página É uma DFC/DMPL/DVA/nota,
# e essas demonstrações têm muita estrutura numérica - inclusive subtotais que
# fecham - então descontar um valor fixo não bastaria para reprová-las.
# No CORPO, a mesma frase costuma ser referência cruzada ("conforme a
# Demonstração dos Fluxos de Caixa"), e penalizar pesado rejeitaria um BP
# legítimo que menciona as outras demonstrações. Daí a penalidade branda.
PENALIDADE_NEGATIVA_CORPO = 0.15

# Faixa considerada "título": do topo até 18% da altura ocupada, com piso
# absoluto para página curta.
FAIXA_TITULO_FRACAO = 0.18
FAIXA_TITULO_MIN = 40.0

MIN_COLUNAS = 2
MIN_DENSIDADE_NUMERICA = 0.15
LIMIAR_ADMISSIVEL = 0.50

# Desempate estável quando duas famílias empatam em nº de âncoras.
_PRIORIDADE = {"BP": 0, "DRE": 1, "BALANCETE": 2}

_NAO_ALFANUMERICO = re.compile(r"[^a-z0-9\s]")
_ESPACOS = re.compile(r"\s+")


def normalizar(texto: object) -> str:
    """lower + NFKD sem acento + não-alfanumérico vira espaço + colapsa espaço.

    CONTRATO CRÍTICO: byte a byte igual a `normalizeText` de
    portal/src/core/normalize.js, a `normalize_text` de scripts/gen_knowledge.py
    e a `dm_normalize` do Postgres. Divergir aqui gera chave diferente para a
    mesma conta - foi o que no v1 duplicou linhas do dicionário e impediu a
    regra aprendida de sobrescrever o seed.
    """
    txt = str(texto if texto is not None else "").strip().lower()
    txt = unicodedata.normalize("NFKD", txt)
    txt = "".join(c for c in txt if not unicodedata.combining(c))
    txt = _NAO_ALFANUMERICO.sub(" ", txt)
    return _ESPACOS.sub(" ", txt).strip()


@dataclass
class ClassificacaoPagina:
    """Veredito sobre uma página, com as evidências que o sustentam."""

    pagina: int
    tipo: str  # 'BP' | 'DRE' | 'BALANCETE' | 'outro'
    score: float  # 0..1
    evidencias: list[str] = field(default_factory=list)
    n_colunas: int = 0
    densidade_numerica: float = 0.0
    tem_subtotal_aritmetico: bool = False


@dataclass
class RelatorioLeitura:
    """Resultado da varredura do documento inteiro."""

    n_paginas: int
    paginas: list[ClassificacaoPagina]
    tem_texto: dict[int, bool]
    admissivel: bool
    motivo: str

    @property
    def paginas_admissiveis(self) -> list[ClassificacaoPagina]:
        return [p for p in self.paginas if p.score >= LIMIAR_ADMISSIVEL]


def tem_subtotal_aritmetico(
    linhas_de_valores: Sequence[Mapping[str, float | None]],
) -> bool:
    """Existe linha que é a soma de um bloco contíguo (>=2) das anteriores?

    A soma tem de fechar em TODAS as colunas comuns ao candidato e ao bloco.
    Exigir todas é o que separa evidência de coincidência: com uma coluna só,
    duas linhas quaisquer somando a terceira acontece por acaso com frequência
    incômoda; em duas colunas simultâneas, praticamente não acontece.

    Tolerância `max(0.6, |valor| * 0.0005)`: o piso absoluto cobre o
    arredondamento de centavos das parcelas e o relativo cobre demonstração
    publicada em milhares, onde cada parcela já vem arredondada.
    """
    linhas = [dict(l) for l in linhas_de_valores]
    for i in range(2, len(linhas)):
        candidato = {k: float(v) for k, v in linhas[i].items() if _numero(v)}
        if not candidato:
            continue
        for inicio in range(i - 2, -1, -1):
            bloco = linhas[inicio:i]
            comuns = [k for k in candidato if all(_numero(l.get(k)) for l in bloco)]
            if not comuns:
                continue
            somas = {k: sum(float(l[k]) for l in bloco) for k in comuns}
            # bloco de zeros soma zero e casaria com qualquer total zerado
            if max(abs(s) for s in somas.values()) <= 1.0:
                continue
            if all(
                abs(somas[k] - candidato[k]) <= max(0.6, abs(candidato[k]) * 0.0005)
                for k in comuns
            ):
                logger.debug(
                    "subtotal confirmado: linha %d = soma de %d linhas em %s",
                    i, len(bloco), comuns,
                )
                return True
    return False


def _numero(valor: object) -> bool:
    """`True` só para número de verdade - `None` (célula vazia) não conta."""
    return isinstance(valor, (int, float)) and not isinstance(valor, bool)


def classificar_pagina(
    palavras: Sequence[Palavra],
    colunas: Sequence[Coluna],
    pagina: int | None = None,
) -> ClassificacaoPagina:
    """Pontua uma página: âncoras 0.35, colunas 0.20, densidade 0.15,
    subtotal 0.30, âncora negativa -0.50 (uma vez, mesmo com várias)."""
    numero = pagina if pagina is not None else (palavras[0].pagina if palavras else 0)
    evidencias: list[str] = []

    linhas = montar_linhas(palavras, colunas, [f"c{i}" for i in range(len(colunas))])
    # O texto para busca de âncora sai dos RÓTULOS já remontados, não da ordem
    # em que as palavras saíram do PDF: content stream de ERP costuma emitir
    # coluna a coluna, e aí "Ativo" e "circulante" nem sempre saem vizinhos.
    # Remontar primeiro garante que a âncora de duas palavras seja encontrada.
    texto = normalizar(" ".join(l.rotulo for l in linhas))

    achados = {
        "BP": [a for a in ANCORAS_BP if a in texto],
        "DRE": [a for a in ANCORAS_DRE if a in texto],
        "BALANCETE": [a for a in ANCORAS_BALANCETE if a in texto],
    }
    familia = max(achados, key=lambda k: (len(achados[k]), -_PRIORIDADE[k]))

    # ÂNCORA NEGATIVA: o PESO DEPENDE DE ONDE ELA APARECE.
    #
    # "Demonstração dos fluxos de caixa" no TÍTULO significa que a página É uma
    # DFC - veto absoluto, não importa quanta estrutura numérica ela tenha (e a
    # DFC tem muita). A mesma frase no CORPO costuma ser referência cruzada
    # ("conforme a Demonstração dos Fluxos de Caixa"), e penalizar 0,5 por isso
    # rejeitaria um BP legítimo que menciona as outras demonstrações.
    #
    # A distinção é estrutural: título fica na faixa superior da página.
    tops = [p.top for p in palavras]
    if tops:
        topo, base = min(tops), max(tops)
        limite_titulo = topo + max(FAIXA_TITULO_MIN, (base - topo) * FAIXA_TITULO_FRACAO)
    else:
        limite_titulo = 0.0
    texto_titulo = normalizar(" ".join(
        l.rotulo for l in linhas if l.top <= limite_titulo))
    negativas = [a for a in ANCORAS_NEGATIVAS if a in texto]
    negativas_titulo = [a for a in ANCORAS_NEGATIVAS if a in texto_titulo]

    tokens = [p for p in palavras if eh_token_valor(p.texto)]
    densidade = len(tokens) / len(palavras) if palavras else 0.0

    # linhas sem nenhum valor (cabeçalho de seção, título) são retiradas antes
    # do teste de soma: elas não são parcela nem total, e mantê-las quebraria a
    # contiguidade justamente entre as contas e o subtotal que as fecha.
    valores = [l.valores for l in linhas if l.tem_valor()]
    subtotal = tem_subtotal_aritmetico(valores)

    score = 0.0
    if achados[familia]:
        score += PESO_ANCORA
        evidencias.append(
            f"ancoras {familia}: " + ", ".join(achados[familia][:6])
        )
    if len(colunas) >= MIN_COLUNAS:
        score += PESO_COLUNAS
        evidencias.append(f"{len(colunas)} colunas de valor alinhadas por x1")
    if densidade >= MIN_DENSIDADE_NUMERICA:
        score += PESO_DENSIDADE
        evidencias.append(f"densidade numerica {densidade:.2f}")
    if subtotal:
        score += PESO_SUBTOTAL
        evidencias.append("subtotal aritmetico confirmado em todas as colunas")
    if negativas_titulo:
        # VETO: a página é uma DFC/DMPL/DVA/nota. Zera, não desconta.
        evidencias.append("VETO - titulo de demonstracao nao alocavel: "
                          + ", ".join(negativas_titulo[:3]))
        score = 0.0
    elif negativas:
        score -= PENALIDADE_NEGATIVA_CORPO
        evidencias.append("mencao a demonstracao nao alocavel no corpo "
                          "(provavel referencia cruzada): "
                          + ", ".join(negativas[:4]))

    score = max(0.0, min(1.0, score))
    tipo = familia if achados[familia] and score >= LIMIAR_ADMISSIVEL else "outro"
    return ClassificacaoPagina(
        pagina=numero,
        tipo=tipo,
        score=round(score, 4),
        evidencias=evidencias,
        n_colunas=len(colunas),
        densidade_numerica=round(densidade, 4),
        tem_subtotal_aritmetico=subtotal,
    )


def classificar_documento(pdf_bytes: bytes) -> RelatorioLeitura:
    """Varre o PDF inteiro e decide se ele MERECE processamento.

    `admissivel=False` quando NENHUMA página atinge score >= 0.5. É este o gate
    que impede o pipeline de gastar token com documento que não é demonstração:
    receita de bolo, contrato e currículo pontuam ~0 porque não têm âncora, não
    têm colunas alinhadas por x1 e, sobretudo, não têm subtotal aritmético.
    """
    tem_texto = paginas_com_texto(pdf_bytes)
    total = n_paginas(pdf_bytes)
    por_pagina = palavras_por_pagina(pdf_bytes)

    classificacoes: list[ClassificacaoPagina] = []
    for numero in range(1, total + 1):
        palavras = por_pagina.get(numero, [])
        colunas = descartar_coluna_codigo(detectar_colunas(palavras), palavras)
        colunas = descartar_coluna_nota(colunas, palavras)
        classificacao = classificar_pagina(palavras, colunas, pagina=numero)
        if not tem_texto.get(numero, False):
            classificacao.evidencias.append(
                "pagina sem camada de texto util (provavel digitalizacao: requer visao)"
            )
        classificacoes.append(classificacao)

    sem_texto = [n for n, ok in tem_texto.items() if not ok]
    melhor = max(classificacoes, key=lambda c: c.score, default=None)
    admissivel = melhor is not None and melhor.score >= LIMIAR_ADMISSIVEL

    if admissivel and melhor is not None:
        aptas = [c for c in classificacoes if c.score >= LIMIAR_ADMISSIVEL]
        motivo = (
            f"{len(aptas)} de {total} pagina(s) com score >= {LIMIAR_ADMISSIVEL:.2f}; "
            f"melhor: pagina {melhor.pagina} ({melhor.tipo}, score {melhor.score:.2f})"
        )
    else:
        melhor_score = melhor.score if melhor else 0.0
        motivo = (
            f"nenhuma das {total} pagina(s) atingiu score {LIMIAR_ADMISSIVEL:.2f} "
            f"(melhor: {melhor_score:.2f}); o documento nao tem estrutura de "
            "balanco, DRE ou balancete"
        )
    if sem_texto:
        motivo += (
            f"; {len(sem_texto)} pagina(s) sem camada de texto util "
            f"({', '.join(str(n) for n in sem_texto[:10])})"
        )

    logger.info("admissibilidade: %s -- %s", admissivel, motivo)
    return RelatorioLeitura(
        n_paginas=total,
        paginas=classificacoes,
        tem_texto=tem_texto,
        admissivel=admissivel,
        motivo=motivo,
    )
