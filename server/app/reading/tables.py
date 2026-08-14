"""
Montagem das LINHAS a partir das palavras e das colunas já detectadas.

Aqui mora a correção do bug de leitura mais comum em demonstração financeira:
a célula grafada com traço. Ela é VAZIA, mas OCUPA a coluna. Quem trata o traço
como "nada" faz os valores à direita escorregarem uma coluna para a esquerda, e
o resultado é um balanço inteiro plausível e errado - 2024 lendo o número de
2025. Aqui o traço é atribuído à sua coluna com valor `None`, e cada linha
nasce com TODAS as colunas presentes, de modo que posição de valor nunca
depende de quantos valores a linha tem.

A INDENTAÇÃO (x0 do rótulo) é UMA fonte de hierarquia, para quando o diagramador
recua as contas filhas sob a sua sintética. Mas ela NÃO é confiável como fonte
única: no ITR do Fleury (2T26), as 53 linhas de conta do Balanço estão todas no
MESMO x0 = 44,76 - não existe recuo nenhum, e a estrutura está inteira nas linhas
`Total ...`. Para demonstração publicada a fonte primária é ARITMÉTICA, em
`demonstracao.py`: sintética é a linha que é a soma exata de um bloco contíguo
das anteriores. Ver docs/03-leitura-documento.md.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from statistics import median
from typing import TYPE_CHECKING, Sequence

from .columns import (
    DATA_CABECALHO,
    Coluna,
    agrupar_por_gap,
    atribuir_a_coluna,
    eh_token_valor,
    para_numero,
)

if TYPE_CHECKING:  # pragma: no cover - só para o type checker
    from .pdf_words import Palavra

logger = logging.getLogger(__name__)

# Fração da altura de linha usada para decidir se duas palavras estão na mesma
# linha. 0.6 tolera sobrescrito e mudança de corpo de fonte sem colar a linha
# de cima na de baixo.
FATOR_LINHA = 0.6

# Diferença de x0 abaixo da qual dois rótulos estão no MESMO nível hierárquico.
# 3pt ≈ meio caractere: menos que isso é jitter de renderização, mais que isso
# é recuo deliberado do diagramador.
TOLERANCIA_INDENTACAO = 3.0

# Tolerância de comparação de soma, usada tanto pelo gate de página
# (`tem_subtotal_aritmetico`) quanto pela reconstrução de hierarquia
# (`demonstracao.arvore_por_soma`). Vive aqui, num módulo que os dois importam,
# porque duas cópias do mesmo número saem de sincronia: o gate aceitaria uma
# página cuja árvore a hierarquia depois recusaria, e o sintoma apareceria como
# "0 assertivas" - verde por vacuidade.
#
# O piso absoluto cobre arredondamento de centavos das parcelas; o relativo
# cobre demonstração publicada em milhares, onde cada parcela já vem arredondada
# e o erro acumulado cresce com a ordem de grandeza do total.
TOLERANCIA_SOMA_PISO = 0.6
TOLERANCIA_SOMA_RELATIVA = 0.0005


def tolerancia_soma(valor: float) -> float:
    """Quanto um total pode divergir da soma das suas parcelas."""
    return max(TOLERANCIA_SOMA_PISO, abs(valor) * TOLERANCIA_SOMA_RELATIVA)


# CÓDIGO DE CONTA no início do rótulo.
#
# A DFP/ITR PADRONIZADA da CVM traz uma coluna `Conta` com código hierárquico
# pontuado: `1`, `1.01`, `1.01.02.01.03`, `2.02.01.02`. Reconhecer isso vale
# muito, por dois motivos:
#
#  · a hierarquia passa a sair do PREFIXO DO CÓDIGO, que é o caminho mais testado
#    do projeto (`hierarquiaPorCodigo`, 670 assertivas) - e não da reconstrução
#    por soma, que é inferência;
#  · o rótulo fica limpo. Com o código grudado, `1.01.01 Caixa e equivalentes de
#    caixa` não casa com nenhuma regra do dicionário.
#
# Exige ao menos um dígito e aceita ponto como separador. Um número solto (`7`,
# `2025`) TAMBÉM casa, e isso é proposital: `montar_linhas` só consulta este
# padrão na primeira palavra da linha, e ali um número solto é código de conta ou
# referência de nota - em nenhum dos dois casos ele pertence ao nome da conta.
RE_CODIGO_CONTA = re.compile(r"^\d+(?:\.\d+)*\.?$")


@dataclass
class LinhaLida:
    """Uma linha da demonstração, já com os valores nas colunas certas."""

    rotulo: str
    valores: dict[str, float | None] = field(default_factory=dict)
    x0_rotulo: float = 0.0
    top: float = 0.0
    pagina: int = 0
    nivel_indentacao: int = 0
    # Código do DOCUMENTO, quando ele traz um. Vazio na demonstração publicada
    # comum (o ITR do Fleury não tem código nenhum) e preenchido na padronizada
    # da CVM. Quando existe, prevalece sobre o código gerado por
    # `demonstracao.classificar` - fato do documento vence inferência.
    codigo: str = ""

    def tem_valor(self) -> bool:
        """`True` se alguma coluna traz número (traço/vazio não conta)."""
        return any(v is not None for v in self.valores.values())


def agrupar_em_linhas(palavras: Sequence[Palavra]) -> list[list[Palavra]]:
    """Agrupa palavras por `top`, com tolerância = altura mediana * 0.6."""
    if not palavras:
        return []
    alturas = [p.altura for p in palavras if p.altura > 0]
    tolerancia = (median(alturas) if alturas else 10.0) * FATOR_LINHA

    ordenadas = sorted(palavras, key=lambda p: (p.top, p.x0))
    linhas: list[list[Palavra]] = [[ordenadas[0]]]
    for p in ordenadas[1:]:
        # comparação contra o topo da PRIMEIRA palavra da linha, não da última:
        # comparar com a última acumula deriva e funde a página inteira quando
        # o espaçamento é apertado.
        if p.top - linhas[-1][0].top > tolerancia:
            linhas.append([p])
        else:
            linhas[-1].append(p)
    for linha in linhas:
        linha.sort(key=lambda p: p.x0)
    return linhas


def montar_linhas(
    palavras: Sequence[Palavra],
    colunas: Sequence[Coluna],
    rotulos: Sequence[str],
) -> list[LinhaLida]:
    """Reconstrói as linhas da tabela.

    Em cada linha: cada token de valor vai para a coluna a que sua borda direita
    pertence, e o RÓTULO é a concatenação das palavras restantes, em ordem de x,
    que na prática são exatamente as que ficam à esquerda do bloco de valores.

    Token de valor que NÃO pertence a nenhuma coluna é DESCARTADO em vez de
    virar rótulo - com uma exceção: se for a primeira palavra da linha, é código
    de conta. Sem esse descarte, o número da nota explicativa (que sobra solto
    depois de `descartar_coluna_nota`, entre o rótulo e os valores) produziria
    "Caixa e equivalentes de caixa 4", e nenhuma regra do dicionário casaria.

    O CÓDIGO VAI PARA CAMPO PRÓPRIO, não para o rótulo. Antes ele ficava no
    rótulo, e na DFP padronizada da CVM - que traz coluna `Conta` com
    `1.01.02.01.03` - isso custava duas coisas de uma vez: nenhuma regra do
    dicionário casava com `1.01.01 Caixa e equivalentes de caixa`, e a hierarquia
    por prefixo de código, que é o caminho mais testado do projeto, ficava sem uso
    num documento que TEM código.
    """
    nomes = [
        rotulos[i] if i < len(rotulos) else f"coluna {i + 1}"
        for i in range(len(colunas))
    ]

    linhas: list[LinhaLida] = []
    for grupo in agrupar_em_linhas(palavras):
        # todas as colunas nascem presentes e vazias: é isso que impede o
        # deslocamento quando uma célula é traço ou simplesmente não existe.
        valores: dict[str, float | None] = {nome: None for nome in nomes}
        partes: list[str] = []
        x0_rotulo: float | None = None
        codigo = ""

        for posicao, p in enumerate(grupo):
            if eh_token_valor(p.texto):
                indice = atribuir_a_coluna(p, colunas)
                if indice is not None:
                    valores[nomes[indice]] = para_numero(p.texto)
                    continue
                if posicao > 0:
                    logger.debug(
                        "token de valor sem coluna descartado: %r em x1=%.1f",
                        p.texto, p.x1,
                    )
                    continue
            # Primeira palavra da linha com cara de código de conta: vai para o
            # campo próprio. O `x0` dela continua sendo o do rótulo, porque é ela
            # que marca o início da linha e a indentação se mede a partir dali.
            if posicao == 0 and not partes and RE_CODIGO_CONTA.match(p.texto):
                codigo = p.texto.rstrip(".")
                if x0_rotulo is None:
                    x0_rotulo = p.x0
                continue
            partes.append(p.texto)
            if x0_rotulo is None:
                x0_rotulo = p.x0

        rotulo = " ".join(partes).strip()
        # Linha só com código e sem rótulo nem valor não é conta: descarta. Mas
        # código + valor SEM rótulo é conta real na padronizada da CVM (o nome vem
        # da linha-pai ou o formulário simplesmente o omite), e jogar fora seria
        # perder valor - o furo que este projeto existe para evitar.
        if not rotulo and not any(v is not None for v in valores.values()):
            continue
        linhas.append(
            LinhaLida(
                rotulo=rotulo,
                valores=valores,
                x0_rotulo=x0_rotulo if x0_rotulo is not None else grupo[0].x0,
                top=min(p.top for p in grupo),
                pagina=grupo[0].pagina,
                codigo=codigo,
            )
        )

    linhas = juntar_rotulos_quebrados(linhas)
    nivel_por_indentacao(linhas)
    return linhas


def _tem_data_de_cabecalho(rotulo: str) -> bool:
    """A linha traz um rótulo de coluna (`31/12/2025`, `12/2025`, `2025`)?"""
    return any(DATA_CABECALHO.match(t) for t in (rotulo or "").split())


def juntar_rotulos_quebrados(
    linhas: Sequence[LinhaLida], tolerancia: float = TOLERANCIA_INDENTACAO
) -> list[LinhaLida]:
    """Cola o rótulo que o diagramador quebrou em duas linhas físicas.

    Condições: a linha atual não tem NENHUM valor, a próxima tem, e as duas
    estão no MESMO nível de indentação. A exigência de mesmo nível é o que
    impede colar um cabeçalho de seção ("Ativo circulante", sem valores) na sua
    primeira conta filha - que está recuada à direita, e portanto em outro
    nível.

    E NUNCA cola uma linha que traz DATA DE CABEÇALHO. Na DFP padronizada da CVM
    o cabeçalho é `Conta 31/12/2025 31/12/2024 31/12/2023`: ele não tem valor
    nenhum (as datas são texto, não número) e começa no mesmo x0 da primeira
    conta, porque nas duas o primeiro token está na coluna `Conta`. Sem este veto,
    a primeira conta do documento nasce chamada
    `"Conta 31/12/2025 31/12/2024 31/12/2023 Ativo Total"` - e é justamente a linha
    que fecha o Balanço, então a demonstração inteira deixa de ser reconhecida.
    Um rótulo legitimamente quebrado em duas linhas nunca contém uma data assim.
    """
    saida: list[LinhaLida] = []
    i = 0
    while i < len(linhas):
        atual = linhas[i]
        proxima = linhas[i + 1] if i + 1 < len(linhas) else None
        if (
            proxima is not None
            and atual.rotulo
            and proxima.rotulo
            and not atual.tem_valor()
            and proxima.tem_valor()
            and not _tem_data_de_cabecalho(atual.rotulo)
            and abs(atual.x0_rotulo - proxima.x0_rotulo) <= tolerancia
        ):
            logger.debug("rotulo em duas linhas: %r + %r", atual.rotulo, proxima.rotulo)
            saida.append(
                LinhaLida(
                    rotulo=f"{atual.rotulo} {proxima.rotulo}",
                    valores=proxima.valores,
                    x0_rotulo=atual.x0_rotulo,
                    top=atual.top,
                    pagina=atual.pagina,
                    # O código é da linha que TEM valor: é ela que é a conta. A
                    # primeira metade é só a continuação do nome, e na padronizada
                    # da CVM ela costuma vir sem código nenhum.
                    codigo=proxima.codigo or atual.codigo,
                )
            )
            i += 2
            continue
        saida.append(atual)
        i += 1
    return saida


def nivel_por_indentacao(
    linhas: Sequence[LinhaLida], tolerancia: float = TOLERANCIA_INDENTACAO
) -> None:
    """Grava `nivel_indentacao` em cada linha, in place.

    Os x0 distintos são clusterizados em 1-D e numerados da esquerda para a
    direita: nível 0 é a margem, nível 1 o primeiro recuo, e assim por diante.
    Sem código contábil, é essa a única fonte de hierarquia - e é ela que
    decide, depois, quem é folha e quem é sintética.
    """
    if not linhas:
        return
    grupos = agrupar_por_gap((l.x0_rotulo for l in linhas), tolerancia)
    faixas = [(g[0], g[-1]) for g in grupos]
    for linha in linhas:
        for nivel, (inicio, fim) in enumerate(faixas):
            if inicio - 1e-6 <= linha.x0_rotulo <= fim + 1e-6:
                linha.nivel_indentacao = nivel
                break
