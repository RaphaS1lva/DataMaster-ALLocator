"""
Leitura de DEMONSTRAÇÃO PUBLICADA (ITR/DFP de companhia aberta).

O PROBLEMA QUE ESTE MÓDULO RESOLVE
----------------------------------
Um ITR tem 50 páginas: Balanço, DRE, DRA, DMPL, DFC e dezenas de notas
explicativas. O gate de página (`page_classifier`) pontua bem qualquer tabela que
tenha âncora contábil, colunas alinhadas e subtotal que fecha - e uma nota
explicativa tem as três coisas. No ITR do Fleury (2T26), 33 das 50 páginas foram
admitidas e o pipeline recebeu 1.222 linhas em vez das ~115 das demonstrações.
Entre elas: `10ª Emissão 1ª Série` (debênture, nota 15), `121 a dias` (faixa de
aging, nota 7), `2027` (cronograma de vencimento) e `12de` - o RODAPÉ "12 de 46",
lido como uma conta de saldo 46.

DUAS OBSERVAÇÕES QUE RESOLVEM ISSO, E AS DUAS SÃO ARITMÉTICAS
-------------------------------------------------------------
1. UMA DEMONSTRAÇÃO PRIMÁRIA SE FECHA; UMA NOTA NÃO.
   O Balanço termina em `Total do ativo` e `Total do passivo e patrimônio
   líquido`; a DRE termina em `Lucro líquido do período`. Uma nota DECOMPÕE uma
   linha da demonstração - ela não fecha o balanço da entidade. Medido no Fleury:
   das 33 páginas admitidas, as 30 de nota têm ZERO âncora de fechamento.

2. CONTEÚDO LEGÍTIMO PERTENCE A UMA ÁRVORE CUJA RAIZ É SINTÉTICA.
   Reconstruída a árvore por soma, o que sobra como FOLHA NA RAIZ é mobília:
   rodapé de página, linha de cabeçalho, memorando e razão (lucro por ação).
   Não é preciso lista de termos proibidos - a aritmética separa.

POR QUE NÃO POR INDENTAÇÃO
--------------------------
Era o plano inicial e os dados o desmentiram: no Balanço do Fleury as 53 linhas
de conta estão todas em `x0 = 44,76`. Não há recuo. A estrutura está nas linhas
`Total ...`, e só a soma a recupera. `tables.nivel_por_indentacao` continua
existindo e servindo a documento indentado, mas não pode ser a fonte única.

POR QUE GERAR CÓDIGO CONTÁBIL
-----------------------------
O núcleo do portal já reconstrói hierarquia por PREFIXO de código
(`hierarquiaPorCodigo`), com 670 assertivas passando no balancete SPE. Emitir o
nome do pai seria ambíguo - a página 6 tem `Total circulante` duas vezes, uma no
Ativo e outra no Passivo, e o índice por nome colidiria. Emitindo um código
sintético derivado da árvore, o caminho testado do portal funciona sem alteração,
e o 1º dígito (§8.7: 1=Ativo, 2=Passivo, 5=DRE) sai correto a partir da âncora de
fechamento da raiz - o que dá `_ladoDeclarado` de graça e habilita a checagem
Classe A de lado trocado.
"""
from __future__ import annotations

import logging
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Callable, Iterable, Mapping, Sequence

from .tables import LinhaLida, tolerancia_soma

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Âncoras de FECHAMENTO - o que distingue demonstração de nota
# ---------------------------------------------------------------------------
# Já normalizadas. São o RÓTULO DA LINHA QUE FECHA a demonstração, não um termo
# qualquer do assunto. `contas a receber` aparece no Balanço e também na nota que
# a decompõe; `total do ativo` só aparece no Balanço.
ANCORAS_FECHAMENTO: dict[str, tuple[str, ...]] = {
    "BP-ATIVO": (
        "total do ativo",
        "total de ativos",
        "total do ativo circulante e nao circulante",
        # DFP/ITR PADRONIZADA DA CVM. É outra classe de documento, com outro
        # vocabulário: o formulário da CVM rotula a linha que fecha como
        # `Ativo Total`, não `Total do ativo`. Faltar isto aqui não degradava a
        # leitura - ela ZERAVA. Nenhuma página fechava BP, nenhuma demonstração
        # era selecionada, e o portal exibia 0 linhas. Medido no DFP 2025 do
        # Fleury: `1 Ativo Total 11.497.695`, páginas 2 e 15 do documento.
        "ativo total",
        "ativos totais",
    ),
    "BP-PASSIVO": (
        "total do passivo e patrimonio liquido",
        "total do passivo e do patrimonio liquido",
        "total do passivo",
        "total de passivos e patrimonio liquido",
        # idem: na padronizada da CVM o Passivo fecha em `Passivo Total`, e vem em
        # PÁGINA SEPARADA do Ativo - é por isso que a família é dividida em
        # BP-ATIVO e BP-PASSIVO em vez de um "BP" único.
        "passivo total",
        "passivos totais",
    ),
    "DRE": (
        "lucro liquido do periodo",
        "lucro liquido do exercicio",
        "prejuizo liquido do periodo",
        "prejuizo liquido do exercicio",
        "lucro prejuizo liquido do periodo",
        "resultado liquido do periodo",
        "lucro liquido consolidado do periodo",
        # padronizada da CVM: 3.11 / 3.13
        "lucro prejuizo consolidado do periodo",
        "resultado liquido das operacoes continuadas",
    ),
}

# 1º dígito do código gerado, por família (§8.7 em portal/src/core/sign.js).
# DRE recebe `5` (apuração, natureza DESCONHECIDA) de propósito: numa
# demonstração publicada o sinal JÁ vem no número (custo negativo), e declarar
# `3` (despesa) ou `4` (receita) convidaria a uma segunda aplicação de sinal.
PREFIXO_POR_FAMILIA: dict[str, str] = {
    "BP-ATIVO": "1",
    "BP-PASSIVO": "2",
    "DRE": "5",
}

# Escala declarada no cabeçalho. Sem isto o balanço fecha igual e sai MIL VEZES
# menor - erro que passa por toda validação, porque a identidade é indiferente à
# escala.
# A ORDEM IMPORTA: o primeiro que casar vence, então o mais específico vem antes.
# `em reais` é substring de nada aqui, mas `reais mil` tem de ser testado antes de
# `em reais` para não virar fator 1.
_ESCALAS: tuple[tuple[str, float, str], ...] = (
    ("em milhares de reais", 1_000.0, "milhares de reais"),
    ("em milhares de r", 1_000.0, "milhares de reais"),
    ("em r mil", 1_000.0, "milhares de reais"),
    ("valores em milhares", 1_000.0, "milhares de reais"),
    # Cabeçalho da DFP/ITR padronizada da CVM: literalmente `Reais Mil`, sem
    # preposição. Faltava, e a consequência é a pior possível - a identidade fecha
    # igual em qualquer escala, então o balanço sairia MIL VEZES menor sem nenhuma
    # validação acusar. Medido no DFP 2025 do Fleury.
    ("reais mil", 1_000.0, "milhares de reais"),
    ("r mil", 1_000.0, "milhares de reais"),
    ("em milhoes de reais", 1_000_000.0, "milhões de reais"),
    ("em milhoes de r", 1_000_000.0, "milhões de reais"),
    ("valores em milhoes", 1_000_000.0, "milhões de reais"),
    ("reais milhoes", 1_000_000.0, "milhões de reais"),
    ("em reais", 1.0, "reais"),
)

_NAO_ALFANUMERICO = re.compile(r"[^a-z0-9\s]")
_ESPACOS = re.compile(r"\s+")


def normalizar(texto: object) -> str:
    """lower + NFKD sem acento + não-alfanumérico vira espaço + colapsa espaço.

    Mesmo contrato de `page_classifier.normalizar` e de `normalizeText` no
    portal. Ver a nota em AGENTS.md: divergir aqui cria chave diferente para a
    mesma conta.
    """
    txt = str(texto if texto is not None else "").strip().lower()
    txt = unicodedata.normalize("NFKD", txt)
    txt = "".join(c for c in txt if not unicodedata.combining(c))
    txt = _NAO_ALFANUMERICO.sub(" ", txt)
    return _ESPACOS.sub(" ", txt).strip()


# ---------------------------------------------------------------------------
# Âncora de fechamento
# ---------------------------------------------------------------------------
# Sobra tolerada depois da âncora: só referência de nota (`24a`, `nota 5`).
# É o que permite casar "Total do ativo 3" e RECUSAR "Total do ativo circulante"
# - que é subtotal intermediário, não o fechamento da demonstração. Sem isto,
# um Balanço cujo bloco intermediário se chama "Total do ativo circulante" teria
# esse subtotal promovido a raiz e a árvore sairia partida.
_RESTO_TOLERADO = re.compile(r"(nota\s*)?\d{1,3}[a-z]?")


def _casa_ancora(rotulo_normalizado: str, ancora: str) -> bool:
    if rotulo_normalizado == ancora:
        return True
    if not rotulo_normalizado.startswith(ancora):
        return False
    resto = rotulo_normalizado[len(ancora):].strip()
    return bool(resto) and _RESTO_TOLERADO.fullmatch(resto) is not None


def familias_que_fecham(linhas: Sequence[LinhaLida]) -> list[str]:
    """Quais famílias de demonstração esta página FECHA.

    Lista vazia significa "não é demonstração primária" - é nota, índice,
    parecer de auditor ou capa. É este o teste que reduziu 33 páginas admitidas
    do ITR do Fleury para as 3 que são de fato Balanço e DRE.
    """
    achadas: list[str] = []
    for linha in linhas:
        rot = normalizar(linha.rotulo)
        if not rot:
            continue
        for familia, ancoras in ANCORAS_FECHAMENTO.items():
            if familia in achadas:
                continue
            # O rótulo tem de SER o fechamento, não apenas conter o termo:
            # "as notas explicativas ... total do ativo ..." numa frase corrida
            # não fecha nada, e isso aparece em relatório de auditoria.
            if any(_casa_ancora(rot, a) for a in ancoras):
                achadas.append(familia)
    return achadas


# Títulos de demonstração que identificam uma página. Normalizados.
# É o que permite reconhecer que a página seguinte CONTINUA a anterior.
_TITULOS_DEMONSTRACAO: tuple[str, ...] = (
    "balanco patrimonial ativo",
    "balanco patrimonial passivo",
    "balanco patrimonial",
    "demonstracao do resultado",
    "demonstracao do fluxo de caixa",
    "demonstracao das mutacoes do patrimonio liquido",
    "demonstracao de resultado abrangente",
    "demonstracao do valor adicionado",
)


# SUBTOTAIS DA DRE que a aritmética não confirma.
#
# Na DRE da padronizada da CVM os subtotais são IRMÃOS, sem código aninhado:
#
#     3.03  Resultado Bruto                              = 3.01 + 3.02
#     3.05  Resultado Antes do Resultado Financeiro...   = 3.03 + 3.04
#     3.07  Resultado Antes dos Tributos sobre o Lucro   = 3.05 + 3.06
#     3.09  Resultado Líquido das Operações Continuadas  = 3.07 + 3.08
#
# `arvore_por_soma` reconhece parte deles, mas não todos: ela exige um bloco
# CONTÍGUO de parcelas ainda não adotadas, e num encadeamento de subtotais as
# parcelas de um já foram consumidas pelo anterior. `3.07` escapou.
#
# O custo de escapar é concreto e foi medido: `3.07 Resultado Antes dos Tributos
# sobre o Lucro` ficou como folha alocável e o dicionário a mandou para
# `- Impostos Pagos` - casou em Jaccard 0,63 com a entrada
# `provisões dos tributos sobre o lucro`, porque cinco tokens coincidem
# (`dos tributos sobre o lucro`). Um SUBTOTAL foi para uma posição de DESPESA.
# O guardrail de sinal pegou (Classe A, 3 bloqueios), mas o mapeamento não devia
# existir.
#
# O padrão exige o par: `resultado`/`lucro`/`prejuízo` MAIS um qualificador de
# apuração (`bruto`, `antes`, `líquido`, `operacional`). É isso que distingue
# `Resultado Bruto` - subtotal - de `Resultado de Equivalência Patrimonial`, que é
# conta de verdade e tem de continuar alocável.
_RE_SUBTOTAL_DRE = re.compile(
    r"^(resultado|lucro|prejuizo|lucro prejuizo)\b.*"
    r"\b(bruto|antes|liquido|liquida|operacional|continuadas|consolidado)\b"
)


def sinteticas_por_codigo(codigos: Iterable[object]) -> set[str]:
    """Quais códigos são TOTAIS: os que outro código tem como prefixo estrito.

    POR QUE ISTO SUBSTITUI `arvore_por_soma` QUANDO HÁ CÓDIGO
    --------------------------------------------------------
    `arvore_por_soma` pressupõe o total DEPOIS das parcelas, que é o layout do ITR
    diagramado. A padronizada da CVM é TOP-DOWN: o pai vem primeiro e os filhos
    embaixo. Nesse layout a heurística não só falha, ela inverte:

        1.02.02        Investimentos                 4.509.232
        1.02.02.01     Participações Societárias     4.509.232
        1.02.02.01.02  Participações em Controladas  4.509.232

    Ao processar a última linha, a lista de pendentes termina com uma linha de
    valor IDÊNTICO - um sufixo de tamanho 1 que soma exatamente o candidato. Ela é
    adotada, e a FOLHA MAIS PROFUNDA é declarada total.

    Custo medido no DFP 2025 do Fleury: `Participações em Controladas` saiu da soma
    do Ativo e a identidade furou em **4.509.232** nos três exercícios, com dois
    erros de leitura Classe A. E o padrão pai-com-filho-único-de-mesmo-valor é a
    regra na DFP, não a exceção (a cadeia de Aplicações Financeiras e a de
    Intangíveis têm a mesma forma).

    Onde o documento traz código, o código é evidência ESTRUTURAL e dispensa
    heurística: um código é total quando existe outro que o estende. A comparação
    exige o PONTO (`c + "."`) porque `1.1` não é pai de `1.10`.

    A árvore por soma continua valendo onde não há código - é lá que ela é a única
    fonte, e onde o layout é o que ela pressupõe.
    """
    lista = [str(c).strip() for c in codigos if str(c).strip()]
    conjunto = set(lista)
    return {
        c for c in conjunto
        if any(o != c and o.startswith(c + ".") for o in conjunto)
    }


def eh_subtotal_de_apuracao(rotulo: object) -> bool:
    """A linha é um subtotal de apuração da DRE?

    Vocabulário, não estrutura - e isso é deliberado: a estrutura (código
    aninhado) simplesmente NÃO EXISTE para estes subtotais no formulário da CVM, e
    a aritmética só confirma alguns. Onde não há estrutura, o nome é a evidência
    disponível, e em português contábil ele é inequívoco.
    """
    return bool(_RE_SUBTOTAL_DRE.match(normalizar(rotulo)))


def titulo_da_pagina(linhas: Sequence[LinhaLida]) -> str:
    """Título da demonstração declarado na página, normalizado, ou `''`.

    No formulário padronizado da CVM cada página traz
    `DFs Individuais / Balanço Patrimonial Ativo` - e a CONTINUAÇÃO da mesma
    demonstração repete exatamente esse título. É esse repetição que permite
    reconhecer a continuação sem depender de número de página.

    Só olha linhas SEM valor: o título é cabeçalho, não conta.
    """
    for linha in linhas:
        if linha.tem_valor():
            continue
        rot = normalizar(linha.rotulo)
        if not rot:
            continue
        for titulo in _TITULOS_DEMONSTRACAO:
            if titulo in rot:
                # devolve o rótulo inteiro normalizado, não só o título: é ele que
                # distingue `DFs Individuais` de `DFs Consolidadas`, e misturar as
                # duas visões seria somar entidades diferentes
                return rot
    return ""


@dataclass
class PaginaLida:
    """Uma página já extraída, antes da interpretação. Estrutura de transporte."""

    pagina: int
    tipo: str
    score: float
    rotulos: list[str]
    linhas: list[LinhaLida]


def agrupar_continuacoes(paginas: Sequence[PaginaLida]) -> list[PaginaLida]:
    """Junta a página de CONTINUAÇÃO à demonstração que ela continua.

    POR QUE ISTO EXISTE, E O QUE CUSTOU NÃO EXISTIR
    -----------------------------------------------
    No DFP 2025 do Fleury o Balanço ocupa DUAS páginas por lado:

        pág 4  DFs Individuais / Balanço Patrimonial Ativo    34 linhas  ← Ativo Total
        pág 5  DFs Individuais / Balanço Patrimonial Ativo    13 linhas  ← sem âncora
        pág 6  DFs Individuais / Balanço Patrimonial Passivo  34 linhas  ← Passivo Total
        pág 7  DFs Individuais / Balanço Patrimonial Passivo  31 linhas  ← sem âncora

    As páginas 5 e 7 não têm linha de fechamento, então `familias_que_fecham`
    devolvia lista vazia e elas eram descartadas como "nota explicativa" - levando
    embora 13 linhas de Ativo e 31 de Passivo. O total continuava certo (ele está
    na página 4), mas as PARCELAS desapareciam: a verificação de leitura acusaria
    sintética diferente da soma das folhas, que é Classe A e bloqueia.

    O critério é o TÍTULO REPETIDO, não o número da página. Título igual e ausência
    de âncora de fechamento só descrevem continuação - uma nota explicativa tem
    título próprio (`Notas explicativas`, `Instrumentos financeiros`), e a segunda
    página de uma demonstração DIFERENTE tem título diferente.

    Exige também que a continuação venha DEPOIS, na ordem de leitura, e que a
    página que recebe tenha âncora: não se anexa continuação a continuação, para
    não formar corrente a partir de uma página que nunca fechou nada.
    """
    saida: list[PaginaLida] = []
    for pagina in paginas:
        titulo = titulo_da_pagina(pagina.linhas)
        fecha = bool(familias_que_fecham(pagina.linhas))
        if not fecha and titulo and saida:
            anterior = saida[-1]
            if (
                titulo_da_pagina(anterior.linhas) == titulo
                and familias_que_fecham(anterior.linhas)
            ):
                # As linhas de cabeçalho da continuação (título, escala, cabeçalho
                # de coluna) não têm valor e serão descartadas na classificação,
                # não precisam ser filtradas aqui, e filtrar exigiria adivinhar
                # quais são.
                logger.info(
                    "pagina %d e CONTINUACAO da pagina %d (%r): %d linha(s) anexadas",
                    pagina.pagina, anterior.pagina, titulo[:60], len(pagina.linhas),
                )
                anterior.linhas.extend(pagina.linhas)
                continue
        saida.append(pagina)
    return saida


def detectar_escala(textos: Iterable[object]) -> tuple[float, str]:
    """Fator multiplicador e rótulo da unidade declarada no cabeçalho.

    Devolve `(1.0, "")` quando nada é declarado - e aí a escala é uma pergunta
    aberta que o portal precisa fazer, não um palpite a esconder.
    """
    for texto in textos:
        rot = normalizar(texto)
        if not rot:
            continue
        for agulha, fator, nome in _ESCALAS:
            if agulha in rot:
                return fator, nome
    return 1.0, ""


# ---------------------------------------------------------------------------
# Árvore por soma
# ---------------------------------------------------------------------------
@dataclass
class Arvore:
    """Hierarquia reconstruída por aritmética.

    `pai_de` e `filhos_de` são indexados pela posição na lista de linhas COM
    VALOR que foi passada a `arvore_por_soma` - não pela posição na página.
    """

    pai_de: dict[int, int] = field(default_factory=dict)
    filhos_de: dict[int, list[int]] = field(default_factory=dict)
    raizes: list[int] = field(default_factory=list)

    def nivel(self, i: int) -> int:
        n = 0
        visto = {i}
        while i in self.pai_de:
            i = self.pai_de[i]
            if i in visto:  # defesa: ciclo não deveria ocorrer
                break
            visto.add(i)
            n += 1
        return n

    def eh_sintetica(self, i: int) -> bool:
        return i in self.filhos_de


def _numeros_da_linha(
    valores: Mapping[str, float | None], colunas: Sequence[str]
) -> dict[str, float]:
    return {
        c: float(valores[c])
        for c in colunas
        if isinstance(valores.get(c), (int, float))
        and not isinstance(valores.get(c), bool)
    }


def arvore_por_soma(
    linhas: Sequence[LinhaLida], colunas: Sequence[str]
) -> Arvore:
    """Reconstrói a hierarquia: sintética é a soma de um bloco CONTÍGUO anterior.

    O algoritmo mantém uma lista de índices ainda não adotados por ninguém. Para
    cada linha, procura o SUFIXO MAIS LONGO dessa lista cuja soma bate com ela em
    todas as colunas comuns; se acha, adota o bloco como filhos e o sufixo sai da
    lista, entrando a sintética no lugar.

    O sufixo mais LONGO primeiro é o que produz o aninhamento certo. No Balanço
    do Fleury, `Total não circulante` tem de engolir `Total do realizável a longo
    prazo` (que já é um total) mais Investimentos, Imobilizado, Intangível e
    Direito de uso. Buscando do mais curto, ele casaria com um par qualquer de
    contas vizinhas e a árvore sairia rasa e errada.

    Exigir todas as colunas comuns é o que separa evidência de coincidência: em
    duas colunas simultâneas, três números que somam por acaso praticamente não
    ocorrem.
    """
    arvore = Arvore()
    pendentes: list[int] = []

    for i, linha in enumerate(linhas):
        candidato = _numeros_da_linha(linha.valores, colunas)
        bloco_achado: list[int] | None = None

        if candidato and len(pendentes) >= 2:
            for tamanho in range(len(pendentes), 1, -1):
                bloco = pendentes[-tamanho:]
                comuns = [
                    c
                    for c in candidato
                    if all(
                        isinstance(linhas[j].valores.get(c), (int, float))
                        and not isinstance(linhas[j].valores.get(c), bool)
                        for j in bloco
                    )
                ]
                if not comuns:
                    continue
                somas = {
                    c: sum(float(linhas[j].valores[c]) for j in bloco) for c in comuns
                }
                # bloco todo zerado somaria zero e casaria com qualquer total
                # zerado - coincidência, não evidência
                if max(abs(s) for s in somas.values()) <= 1.0:
                    continue
                if all(
                    abs(somas[c] - candidato[c]) <= tolerancia_soma(candidato[c])
                    for c in comuns
                ):
                    bloco_achado = bloco
                    break

        if bloco_achado:
            for j in bloco_achado:
                arvore.pai_de[j] = i
                pendentes.remove(j)
            arvore.filhos_de[i] = list(bloco_achado)
            logger.debug(
                "sintetica: %r = soma de %d linha(s)",
                linhas[i].rotulo, len(bloco_achado),
            )
        pendentes.append(i)

    arvore.raizes = list(pendentes)
    return arvore


# ---------------------------------------------------------------------------
# Papéis: o que é conta, o que é sintética, o que é mobília
# ---------------------------------------------------------------------------
MOTIVO_FOLHA_SOLTA = (
    "não pertence a nenhum total da demonstração: não é parcela de nada nem "
    "fecha nada. É o padrão de rodapé de página, linha de cabeçalho, memorando "
    "e índice - e também de razão (lucro por ação), que não é valor monetário."
)


@dataclass
class LinhaClassificada:
    """Uma linha da demonstração com o papel que a aritmética lhe atribuiu."""

    linha: LinhaLida
    familia: str  # 'BP-ATIVO' | 'BP-PASSIVO' | 'DRE' | ''
    codigo: str  # código gerado; '' quando fora de árvore
    sintetica: bool
    nivel: int
    descartada: bool
    motivo: str = ""


def _largura_indice(n: int) -> int:
    """Dígitos por nível. 2 cobre até 99 irmãos, que é folgado para publicada."""
    return max(2, len(str(max(n, 1))))


def _familia_da_raiz(rotulo: str) -> str:
    rot = normalizar(rotulo)
    for familia, ancoras in ANCORAS_FECHAMENTO.items():
        if any(_casa_ancora(rot, a) for a in ancoras):
            return familia
    return ""


# Primeiro dígito do código da padronizada da CVM → família. A CVM usa a mesma
# convenção de §8.7 para Ativo e Passivo; a DRE dela é toda `3.x`, sem separar
# despesa de receita por dígito.
_FAMILIA_POR_PRIMEIRO_DIGITO = {"1": "BP-ATIVO", "2": "BP-PASSIVO", "3": "DRE"}


# Fração das linhas com valor que precisa trazer código para a página ser tratada
# como "tem coluna de código".
FRACAO_MINIMA_COM_CODIGO = 0.6
# E ao menos este tanto de códigos PONTUADOS. É o que separa uma coluna de código
# de verdade de números soltos que caíram no início da linha.
MINIMO_CODIGOS_PONTUADOS = 3


def _pagina_tem_coluna_de_codigo(linhas: Sequence[LinhaLida]) -> bool:
    """A página traz uma coluna `Conta` com código hierárquico?

    DECISÃO POR PÁGINA, NUNCA POR LINHA - e isso é o ponto. Na demonstração
    publicada comum, o rodapé "2 de 46" tem `2` como primeiro token e satisfaz o
    padrão de código sozinho. Tratado linha a linha, esse rodapé receberia código
    `2`, herdaria família BP-PASSIVO pelo primeiro dígito e entraria como conta
    alocável - mobília de página promovida a saldo, que é exatamente a classe de
    erro que a árvore por soma foi criada para eliminar.

    Duas condições, ambas necessárias: a MAIORIA das linhas com valor tem código, e
    há uma quantidade mínima de códigos PONTUADOS (`1.01`). A primeira sozinha
    aceitaria uma página de tabela numerada; a segunda sozinha aceitaria uma página
    com três referências de nota.
    """
    if not linhas:
        return False
    com_codigo = [l for l in linhas if l.codigo]
    if len(com_codigo) < FRACAO_MINIMA_COM_CODIGO * len(linhas):
        return False
    pontuados = sum(1 for l in com_codigo if "." in l.codigo)
    if pontuados < MINIMO_CODIGOS_PONTUADOS:
        return False
    logger.info(
        "pagina com coluna de codigo: %d de %d linhas com valor, %d pontuados -- "
        "hierarquia por PREFIXO, nao por soma",
        len(com_codigo), len(linhas), pontuados,
    )
    return True


def _familia_por_prefixo(codigo: str) -> str:
    """Família a partir do 1º dígito do código do DOCUMENTO.

    Só é consultada quando a linha tem código próprio e a herança pela árvore não
    resolveu a família - o que acontece quando a raiz da página não fechou por
    soma (arredondamento em milhares) mas o código diz claramente de que lado a
    conta está. Sem isto a linha ficaria sem família e, no portal, sem grupo.
    """
    primeiro = codigo.strip()[:1]
    return _FAMILIA_POR_PRIMEIRO_DIGITO.get(primeiro, "")


def classificar(
    linhas: Sequence[LinhaLida], colunas: Sequence[str]
) -> list[LinhaClassificada]:
    """Papel de cada linha, com código hierárquico gerado para as que ficam.

    Linhas sem valor nenhum (título, legenda, rótulo de seção) não entram na
    árvore: não são parcela nem total. Elas voltam marcadas como descartadas com
    motivo próprio, para o portal poder exibi-las sem alocá-las.
    """
    # Mapeia posição na página -> posição entre as linhas COM VALOR. Por índice,
    # nunca por `id()`: duas linhas com o mesmo rótulo e os mesmos valores são
    # objetos distintos, mas nada garante que o dataclass não seja reusado, e uma
    # colisão de identidade aqui embaralharia papéis silenciosamente.
    com_valor: list[LinhaLida] = []
    posicao_em_com_valor: dict[int, int] = {}
    for pos, linha in enumerate(linhas):
        if linha.tem_valor():
            posicao_em_com_valor[pos] = len(com_valor)
            com_valor.append(linha)

    arvore = arvore_por_soma(com_valor, colunas)

    # Família de cada raiz e, por herança, de toda a sua descendência.
    familia_de: dict[int, str] = {}
    for raiz in arvore.raizes:
        if arvore.eh_sintetica(raiz):
            familia_de[raiz] = _familia_da_raiz(com_valor[raiz].rotulo)

    def propagar(i: int, familia: str) -> None:
        familia_de[i] = familia
        for f in arvore.filhos_de.get(i, []):
            propagar(f, familia)

    for raiz, familia in list(familia_de.items()):
        propagar(raiz, familia)

    # Código: percorre cada árvore de raiz sintética em pré-ordem, na ordem do
    # documento, concatenando índices de largura fixa. Prefixo do filho contém o
    # código do pai, que é exatamente o que `hierarquiaPorCodigo` espera.
    codigo_de: dict[int, str] = {}

    def numerar(i: int, prefixo: str) -> None:
        codigo_de[i] = prefixo
        filhos = arvore.filhos_de.get(i, [])
        largura = _largura_indice(len(filhos))
        for ordem, f in enumerate(sorted(filhos), start=1):
            numerar(f, f"{prefixo}{ordem:0{largura}d}")

    prefixos_usados: set[str] = set()
    for raiz in arvore.raizes:
        if not arvore.eh_sintetica(raiz):
            continue
        familia = familia_de.get(raiz, "")
        prefixo = PREFIXO_POR_FAMILIA.get(familia, "")
        if not prefixo:
            # Raiz que fecha algo mas não reconhecemos qual demonstração é.
            # Sem prefixo não há como afirmar o grupo, e afirmar errado é pior
            # que não afirmar: `grupoFromCodigo` mandaria a conta para o lado
            # oposto do balanço. Fica sem código e o dicionário decide pelo nome.
            logger.info("raiz sintetica sem familia reconhecida: %r",
                        com_valor[raiz].rotulo)
            continue
        if prefixo in prefixos_usados:
            # Duas raízes da MESMA família na mesma página. Reusar o prefixo faria
            # `hierarquiaPorCodigo` ver código duplicado e descartar a segunda
            # árvore inteira (ela conta em `duplicados` e não entra no índice).
            # Preferimos deixar sem código: o dicionário ainda mapeia pelo nome,
            # e o QA aponta o que ficou sem hierarquia - visível em vez de mudo.
            logger.warning(
                "segunda raiz %s na mesma pagina (%r): fica sem codigo gerado",
                familia, com_valor[raiz].rotulo,
            )
            continue
        prefixos_usados.add(prefixo)
        numerar(raiz, prefixo)

    doc_tem_codigo = _pagina_tem_coluna_de_codigo(com_valor)
    sinteticas_doc = (
        sinteticas_por_codigo([l.codigo for l in linhas if l.codigo])
        if doc_tem_codigo else set()
    )

    saida: list[LinhaClassificada] = []
    for pos, linha in enumerate(linhas):  # noqa: PLR1702
        k = posicao_em_com_valor.get(pos)
        if k is None:
            saida.append(LinhaClassificada(
                linha=linha, familia="", codigo="", sintetica=False, nivel=0,
                descartada=True,
                motivo="linha sem valor em nenhuma coluna: título, legenda ou "
                       "rótulo de seção. Não é parcela nem total.",
            ))
            continue
        # Com código próprio, a linha entra mesmo que a árvore por soma não a
        # tenha aproveitado: quem manda na hierarquia é o prefixo. Descartá-la por
        # não fechar aritmeticamente perderia valor num documento onde o
        # arredondamento em milhares é o normal.
        if doc_tem_codigo and linha.codigo:
            saida.append(LinhaClassificada(
                linha=linha,
                familia=familia_de.get(k, "") or _familia_por_prefixo(linha.codigo),
                codigo=linha.codigo,
                # PREFIXO, e não a árvore por soma. Ver `sinteticas_por_codigo`:
                # `arvore_por_soma` pressupõe o total DEPOIS das parcelas, e a
                # padronizada da CVM é top-down - ali ela transforma folha em total.
                sintetica=(linha.codigo in sinteticas_doc
                           or eh_subtotal_de_apuracao(linha.rotulo)),
                nivel=linha.codigo.count("."),
                descartada=False,
            ))
            continue
        if k in codigo_de:
            saida.append(LinhaClassificada(
                linha=linha,
                familia=familia_de.get(k, ""),
                codigo=codigo_de[k],
                sintetica=arvore.eh_sintetica(k),
                nivel=arvore.nivel(k),
                descartada=False,
            ))
            continue
        # Está com valor mas fora de qualquer árvore aproveitável.
        dentro_de_arvore = k in arvore.pai_de or arvore.eh_sintetica(k)
        saida.append(LinhaClassificada(
            linha=linha, familia=familia_de.get(k, ""), codigo="",
            sintetica=arvore.eh_sintetica(k), nivel=arvore.nivel(k),
            descartada=True,
            motivo=(
                "pertence a um total que não foi reconhecido como demonstração "
                "(sem âncora de fechamento na raiz)"
                if dentro_de_arvore else MOTIVO_FOLHA_SOLTA
            ),
        ))
    return saida


# ---------------------------------------------------------------------------
# Uma demonstração inteira, do jeito que o portal recebe
# ---------------------------------------------------------------------------
def montar_demonstracao(
    pagina: int,
    tipo: str,
    score: float,
    rotulos: Sequence[str],
    linhas: Sequence[LinhaLida],
    sanitizar: Callable[[str], tuple[str, list[str]]] | None = None,
) -> tuple[dict[str, object] | None, list[str]]:
    """Interpreta uma página já extraída. Devolve `(demonstracao, injeções)`.

    `None` na primeira posição significa "esta página não é demonstração
    primária" - e o chamador registra o motivo.

    ESTA É A FRONTEIRA DO MÓDULO, e ela é deliberada: tudo que precisa de
    pdfplumber (abrir o PDF, extrair palavra com coordenada) fica em `main.py`;
    tudo que INTERPRETA fica aqui e é importável numa máquina sem as libs de PDF.
    É o que permite ao golden dataset do Fleury exercitar exatamente o código que
    roda em produção, em vez de uma segunda cópia da lógica que sai de sincronia.

    `sanitizar` é injetado (e não importado) para a camada de guardrail de
    injeção de prompt ficar do lado do I/O: este módulo não deve decidir política
    de segurança, só chamar a que lhe passarem.
    """
    from .periodos import descrever_colunas, propor, reconstruir_cabecalho

    familias = familias_que_fecham(linhas)
    if not familias:
        return None, []

    rotulos_atuais = list(rotulos)

    # REMONTAGEM DO CABEÇALHO, em duas passadas. A primeira classificação serve
    # só para achar onde o cabeçalho termina: é tudo que vem ANTES da primeira
    # linha que a árvore aproveitou. Não há como saber isso antes de rodar a
    # árvore, nem como rodar a árvore com rótulo definitivo antes de ler o
    # cabeçalho - e numa página de ~60 linhas rodar duas vezes é irrelevante.
    primeira = classificar(linhas, rotulos_atuais)
    tops = [c.linha.top for c in primeira if not c.descartada]
    if tops:
        corte = min(tops)
        cabecalho = [l for l in linhas if l.top < corte]
        novos = reconstruir_cabecalho(rotulos_atuais, list(cabecalho))
        if novos != rotulos_atuais:
            # Renomear a chave é seguro porque é 1:1 por índice de coluna;
            # remontar as linhas do zero arriscaria mudar a atribuição de valor
            # a coluna, que é o bug de leitura mais difícil de perceber.
            for l in linhas:
                l.valores = {
                    novo: l.valores.get(velho)
                    for velho, novo in zip(rotulos_atuais, novos)
                }
            rotulos_atuais = novos

    classificadas = classificar(linhas, rotulos_atuais)
    fator, unidade = detectar_escala(l.rotulo for l in linhas)

    injecoes: list[str] = []
    aproveitadas: list[dict[str, object]] = []
    descartadas: list[dict[str, object]] = []
    for c in classificadas:
        if not c.linha.rotulo.strip():
            continue
        limpo = c.linha.rotulo
        if sanitizar is not None:
            limpo, achados = sanitizar(c.linha.rotulo)
            injecoes.extend(achados)
        valores = {k: v for k, v in c.linha.valores.items() if v is not None}
        if c.descartada:
            # NUNCA sumir com valor calado: a linha vai para o portal com o
            # motivo, para aparecer na tela como excluída e conferível.
            descartadas.append({
                "origem": limpo, "pagina": pagina, "motivo": c.motivo,
                "valoresPorSlot": valores,
            })
            continue
        aproveitadas.append({
            "origem": limpo,
            # Código GERADO pela árvore. 1º dígito = lado do balanço (§8.7),
            # prefixo = pai. É o contrato de `hierarquiaPorCodigo` no portal.
            "codigo": c.codigo,
            "pagina": pagina,
            "nivelIndentacao": c.linha.nivel_indentacao,
            "nivel": c.nivel,
            "totalizador": "Sim" if c.sintetica else "Não",
            "familia": c.familia,
            "valoresPorSlot": valores,
            "naturezaPorSlot": {},
        })

    # Valor de cada coluna nas linhas que FECHAM a demonstração. É a legenda real
    # da coluna: o analista reconhece 13.558.475 como Consolidado mesmo que o
    # rótulo tenha saído `coluna 3`. A aritmética vira a legenda.
    referencia: dict[str, dict[str, float]] = {r: {} for r in rotulos_atuais}
    for c in classificadas:
        if c.descartada or c.nivel != 0 or not c.sintetica:
            continue
        for col, valor in c.linha.valores.items():
            if valor is not None and col in referencia:
                referencia[col][c.linha.rotulo] = float(valor)

    candidatas = descrever_colunas(list(rotulos_atuais), referencia)
    proposta = propor(candidatas)

    return {
        "id": f"p{pagina}",
        "pagina": pagina,
        "tipo": tipo,
        "score": score,
        "familias": familias,
        "escala": {"fator": fator, "unidade": unidade},
        "colunas": [c.como_dict() for c in candidatas],
        "mapeamento": proposta.como_dict(),
        "linhas": aproveitadas,
        "descartadas": descartadas,
        "resumo": {
            "contas": sum(1 for l in aproveitadas if l["totalizador"] == "Não"),
            "sinteticas": sum(1 for l in aproveitadas if l["totalizador"] == "Sim"),
            "descartadas": len(descartadas),
        },
    }, injecoes
