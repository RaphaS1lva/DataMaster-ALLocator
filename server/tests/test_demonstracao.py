"""
Testes da leitura de DEMONSTRAÇÃO PUBLICADA (`app.reading.demonstracao`).

As fixtures reproduzem a ESTRUTURA REAL medida no ITR do Fleury 2T26, extraída
com `scripts/dump_leitura.py`. Os fatos que elas preservam, e o motivo de cada um:

  · as 53 linhas de conta do Balanço estão TODAS no mesmo x0 (44,76) - não há
    indentação, então a hierarquia só pode vir da aritmética;
  · `Total não circulante` engloba `Total do realizável a longo prazo`, que já é
    um total: o aninhamento é real e o algoritmo tem de recuperá-lo;
  · o rodapé "2 de 46" é lido como uma linha de rótulo `2de` e valor 46 - é o
    caso que mais parecia conta e não é;
  · a DRE tem 4 linhas de cabeçalho empilhadas, e duas delas produzem VALOR
    (`30` de "30 de junho" e `2026` do ano).

Nenhum teste aqui depende de pdfplumber: opera sobre `LinhaLida`, que é o
contrato entre a extração e a interpretação.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

RAIZ_SERVER = Path(__file__).resolve().parents[1]
if str(RAIZ_SERVER) not in sys.path:
    sys.path.insert(0, str(RAIZ_SERVER))

from app.reading.demonstracao import (  # noqa: E402
    ANCORAS_FECHAMENTO,
    MOTIVO_FOLHA_SOLTA,
    arvore_por_soma,
    classificar,
    detectar_escala,
    familias_que_fecham,
    normalizar,
)
from app.reading.tables import LinhaLida, tolerancia_soma  # noqa: E402

# Duas colunas: é o mínimo que o algoritmo exige para tratar soma como evidência
# em vez de coincidência.
COLS = ["Controladora 30/06/2026", "Controladora 31/12/2025"]


def linha(rotulo: str, *valores: float | None, x0: float = 44.76) -> LinhaLida:
    """Uma linha no mesmo recuo de todas as outras - como no Fleury."""
    return LinhaLida(
        rotulo=rotulo,
        valores={c: v for c, v in zip(COLS, valores)},
        x0_rotulo=x0,
        top=0.0,
        pagina=6,
    )


def balanco_fleury() -> list[LinhaLida]:
    """Recorte fiel do Ativo + Passivo da página 6, com os valores reais."""
    return [
        linha("Balanço Patrimonial", None, None),
        linha("Em milhares de reais R$", None, None),
        linha("Circulante Caixa e equivalentes de caixa", 3181, 5080),
        linha("Títulos e valores mobiliários", 1071565, 1495042),
        linha("Contas a receber", 1161401, 985633),
        linha("Estoques", 70204, 79860),
        linha("Impostos a recuperar", 202579, 219564),
        linha("Dividendos a receber Hermes Pardini", 57070, 57070),
        linha("Outros ativos", 109549, 57515),
        linha("Total circulante", 2675549, 2899764),
        linha("Títulos e valores mobiliários", 149089, 122859),
        linha("Depósitos judiciais", 4907, 11131),
        linha("Outros ativos", 28736, 33663),
        linha("Total do realizável a longo prazo", 182732, 167653),
        linha("Investimentos", 4961084, 4509232),
        linha("Imobilizado", 816368, 832547),
        linha("Intangível", 2321532, 2385791),
        linha("Direito de uso", 732086, 702708),
        linha("Total não circulante", 9013802, 8597931),
        linha("Total do ativo", 11689351, 11497695),
        linha("Passivo e Patrimônio Líquido", None, None),
        linha("Circulante Fornecedores", 375575, 385681),
        linha("Debêntures", 557886, 214745),
        linha("Outros passivos", 561624, 828406),
        linha("Total circulante", 1495085, 1428832),
        linha("Debêntures", 3447853, 3797474),
        linha("Dividendos a pagar", 1328835, 1270049),
        linha("Total não circulante", 4776688, 5067523),
        linha("Patrimônio líquido Capital social 24a.", 2736029, 2736029),
        linha("Reserva de capital", 1928698, 1915603),
        linha("Lucro do período", 752851, 349708),
        linha("Total do patrimônio líquido", 5417578, 5001340),
        linha("Total do passivo e patrimônio líquido", 11689351, 11497695),
        linha("As notas explicativas são parte integrante", None, None),
        # o rodapé "2 de 46": a linha que mais parece conta e não é
        linha("2de", None, 46, x0=519.48),
    ]


def nota_explicativa() -> list[LinhaLida]:
    """Nota de debêntures: tem âncora contábil, colunas e subtotal que FECHA.

    É por isso que ela pontuava 1,00 no gate de página. O que ela não tem é
    âncora de FECHAMENTO - e é só isso que a separa de uma demonstração.
    """
    return [
        linha("15. Debêntures", None, None),
        linha("10ª Emissão 1ª Série", 578403, 572859),
        linha("10ª Emissão 2ª série", 578514, 572952),
        linha("Total", 1156917, 1145811),
        linha("Circulante", 557886, 214745),
        linha("Não circulante", 599031, 931066),
        linha("Total", 1156917, 1145811),
    ]


# ---------------------------------------------------------------------------
# Seleção: demonstração x nota
# ---------------------------------------------------------------------------
def test_balanco_fecha_ativo_e_passivo():
    assert familias_que_fecham(balanco_fleury()) == ["BP-ATIVO", "BP-PASSIVO"]


def test_nota_explicativa_nao_fecha_nada():
    """O fato medido: das 33 páginas admitidas do ITR, as 30 de nota dão []."""
    assert familias_que_fecham(nota_explicativa()) == []


def test_subtotal_intermediario_nao_e_fechamento():
    """`Total do ativo circulante` é subtotal, não o fim do Balanço.

    Sem esta distinção o subtotal viraria raiz e a árvore sairia partida em duas.
    """
    linhas = [
        linha("Caixa", 100, 100),
        linha("Clientes", 400, 400),
        linha("Total do ativo circulante", 500, 500),
    ]
    assert familias_que_fecham(linhas) == []


def test_referencia_de_nota_depois_da_ancora_ainda_fecha():
    """"Total do ativo 3" (com a referência da nota colada) tem de casar."""
    assert familias_que_fecham([linha("Total do ativo 3", 10, 10)]) == ["BP-ATIVO"]


def test_ancora_em_frase_corrida_nao_fecha():
    linhas = [linha("as notas explicativas detalham o total do ativo", 1, 1)]
    assert familias_que_fecham(linhas) == []


# ---------------------------------------------------------------------------
# Árvore por soma
# ---------------------------------------------------------------------------
def test_arvore_recupera_aninhamento_de_totais():
    """`Total não circulante` engloba `Total do realizável`, que já é total."""
    linhas = [l for l in balanco_fleury() if l.tem_valor()]
    arvore = arvore_por_soma(linhas, COLS)

    rotulo = {i: l.rotulo for i, l in enumerate(linhas)}
    por_rotulo_sintetica = {
        rotulo[i] for i in arvore.filhos_de if arvore.eh_sintetica(i)
    }
    assert "Total circulante" in por_rotulo_sintetica
    assert "Total do realizável a longo prazo" in por_rotulo_sintetica
    assert "Total não circulante" in por_rotulo_sintetica
    assert "Total do ativo" in por_rotulo_sintetica

    # o aninhamento: o realizável é FILHO do não circulante
    i_realizavel = next(i for i, r in rotulo.items()
                        if r == "Total do realizável a longo prazo")
    i_nao_circ = next(i for i, r in rotulo.items()
                      if r == "Total não circulante")
    assert arvore.pai_de[i_realizavel] == i_nao_circ


def test_as_duas_raizes_sao_os_dois_lados_do_balanco():
    linhas = [l for l in balanco_fleury() if l.tem_valor()]
    arvore = arvore_por_soma(linhas, COLS)
    raizes_sinteticas = [linhas[i].rotulo for i in arvore.raizes
                         if arvore.eh_sintetica(i)]
    assert raizes_sinteticas == ["Total do ativo",
                                "Total do passivo e patrimônio líquido"]


def test_toda_sintetica_bate_com_a_soma_dos_filhos():
    """A hierarquia é AUTOVERIFICÁVEL: se fecha, está certa.

    É esta propriedade que transforma "verificação de leitura: 0 assertivas" em
    assertivas de verdade.
    """
    linhas = [l for l in balanco_fleury() if l.tem_valor()]
    arvore = arvore_por_soma(linhas, COLS)
    assert arvore.filhos_de, "nenhuma sintética detectada"
    for pai, filhos in arvore.filhos_de.items():
        for col in COLS:
            alvo = linhas[pai].valores.get(col)
            if alvo is None:
                continue
            if any(linhas[f].valores.get(col) is None for f in filhos):
                continue
            soma = sum(float(linhas[f].valores[col]) for f in filhos)
            assert abs(soma - float(alvo)) <= tolerancia_soma(float(alvo))


def test_uma_coluna_so_nao_basta_para_virar_pai():
    """Coincidência em UMA coluna não é evidência.

    Duas contas quaisquer somando uma terceira acontece por acaso com frequência
    incômoda; em duas colunas simultâneas, praticamente não acontece - e é por
    isso que a soma tem de fechar em todas as colunas comuns.
    """
    linhas = [
        linha("Conta A", 100, 7),
        linha("Conta B", 200, 11),
        linha("Coincidência", 300, 999),  # fecha na 1ª coluna, não na 2ª
    ]
    arvore = arvore_por_soma(linhas, COLS)
    assert arvore.filhos_de == {}


def test_bloco_de_zeros_nao_vira_filho_de_total_zerado():
    linhas = [
        linha("Zero A", 0, 0),
        linha("Zero B", 0, 0),
        linha("Total zerado", 0, 0),
    ]
    assert arvore_por_soma(linhas, COLS).filhos_de == {}


def test_arredondamento_em_milhares_ainda_fecha():
    """Demonstração publicada arredonda cada parcela; o total não bate exato."""
    linhas = [
        linha("Parcela A", 1_000_000.4, 10),
        linha("Parcela B", 2_000_000.4, 20),
        linha("Total", 3_000_001, 30),
    ]
    arvore = arvore_por_soma(linhas, COLS)
    assert len(arvore.filhos_de) == 1


# ---------------------------------------------------------------------------
# Classificação e código gerado
# ---------------------------------------------------------------------------
def test_codigo_gerado_tem_prefixo_do_lado_certo():
    """1 = Ativo, 2 = Passivo (§8.7). É o que dá `_ladoDeclarado` de graça."""
    cls = classificar(balanco_fleury(), COLS)
    por_rotulo = {c.linha.rotulo: c for c in cls}

    assert por_rotulo["Total do ativo"].codigo == "1"
    assert por_rotulo["Total do passivo e patrimônio líquido"].codigo == "2"
    assert por_rotulo["Circulante Caixa e equivalentes de caixa"].codigo.startswith("1")
    assert por_rotulo["Circulante Fornecedores"].codigo.startswith("2")


def test_codigo_do_filho_tem_o_do_pai_como_prefixo():
    """Contrato com `hierarquiaPorCodigo`: pai = maior prefixo estrito presente."""
    cls = [c for c in classificar(balanco_fleury(), COLS) if c.codigo]
    codigos = {c.codigo for c in cls}
    for c in cls:
        if len(c.codigo) <= 1:
            continue
        prefixos = {c.codigo[:n] for n in range(1, len(c.codigo))}
        assert prefixos & codigos, f"{c.codigo} ({c.linha.rotulo}) ficou órfão"


def test_codigos_gerados_sao_unicos():
    """Código repetido faz `hierarquiaPorCodigo` DESCARTAR a segunda árvore."""
    codigos = [c.codigo for c in classificar(balanco_fleury(), COLS) if c.codigo]
    assert len(codigos) == len(set(codigos))


def test_rodape_de_pagina_e_descartado_com_motivo():
    """"2 de 46" chega como rótulo `2de` e valor 46 - e não é conta."""
    cls = classificar(balanco_fleury(), COLS)
    rodape = next(c for c in cls if c.linha.rotulo == "2de")
    assert rodape.descartada
    assert rodape.motivo == MOTIVO_FOLHA_SOLTA
    assert rodape.codigo == ""


def test_linha_sem_valor_e_descartada_sem_entrar_na_arvore():
    cls = classificar(balanco_fleury(), COLS)
    titulo = next(c for c in cls if c.linha.rotulo == "Balanço Patrimonial")
    assert titulo.descartada
    assert "sem valor" in titulo.motivo


def test_nenhuma_conta_do_balanco_fica_sem_codigo():
    """Se uma conta real cair fora da árvore, o valor dela desaparece da Shadow."""
    cls = classificar(balanco_fleury(), COLS)
    sem_codigo = [c.linha.rotulo for c in cls
                  if not c.descartada and not c.codigo]
    assert sem_codigo == []


def test_contagem_bate_com_o_documento_real():
    """9 sintéticas e 42 contas é o que a página 6 do Fleury produz."""
    cls = classificar(balanco_fleury(), COLS)
    sinteticas = [c for c in cls if c.sintetica and not c.descartada]
    # O recorte da fixture é menor que a página inteira, mas a proporção de
    # sintéticas tem de ser exatamente a estrutura do Balanço: 4 no Ativo
    # (circulante, realizável, não circulante, total) e 4 no Passivo
    # (circulante, não circulante, PL, total).
    assert len(sinteticas) == 8
    assert all(c.codigo for c in sinteticas)


def test_nota_explicativa_nao_gera_codigo_nenhum():
    """Sem âncora de fechamento na raiz, nada recebe código - nem grupo."""
    cls = classificar(nota_explicativa(), COLS)
    assert all(c.codigo == "" for c in cls)
    assert all(c.descartada for c in cls)


# ---------------------------------------------------------------------------
# DRE
# ---------------------------------------------------------------------------
def dre_fleury() -> list[LinhaLida]:
    """Recorte da página 7, incluindo as linhas de cabeçalho que dão valor."""
    return [
        linha("Demonstração do resultado", None, None),
        linha("de junho de junho", 30, None),        # "30 de junho" quebrado
        linha("Nota", 2026, 2025),                   # o ano como se fosse saldo
        linha("Receita de prestação de serviços", 1346590, 1181022),
        linha("Custo dos serviços prestados", -955294, -838770),
        linha("Lucro Bruto", 391296, 342252),
        linha("Despesas gerais e administrativas", -118427, -104924),
        linha("Despesas comerciais", -17195, -10418),
        linha("Outras receitas operacionais, líquidas", 6588, 6814),
        linha("Equivalência patrimonial", 89521, 39091),
        linha("Lucro operacional antes do resultado financeiro", 351783, 272815),
        linha("Receitas financeiras", 52845, 63814),
        linha("Despesas financeiras", -174562, -181589),
        linha("Resultado financeiro", -121717, -117775),
        linha("Lucro antes do imposto de renda", 230066, 155040),
        linha("Imposto de renda e contribuição social Corrente", -33772, -50305),
        linha("Diferido", 25556, 47564),
        linha("Lucro líquido do período", 221850, 152299),
        linha("Lucro por ação", 0.41, 0.28),
        linha("3de", None, 46, x0=519.48),
    ]


def test_dre_fecha_e_recebe_prefixo_de_apuracao():
    """DRE recebe `5` de propósito: o sinal já vem no número da publicada.

    Declarar `3` (despesa) ou `4` (receita) convidaria a uma segunda aplicação de
    sinal sobre um custo que já está negativo.
    """
    assert familias_que_fecham(dre_fleury()) == ["DRE"]
    cls = classificar(dre_fleury(), COLS)
    por_rotulo = {c.linha.rotulo: c for c in cls}
    assert por_rotulo["Lucro líquido do período"].codigo == "5"
    assert por_rotulo["Receita de prestação de serviços"].codigo.startswith("5")


def test_dre_reconstroi_a_cadeia_do_resultado():
    cls = classificar(dre_fleury(), COLS)
    sinteticas = {c.linha.rotulo for c in cls if c.sintetica and not c.descartada}
    assert sinteticas == {
        "Lucro Bruto",
        "Lucro operacional antes do resultado financeiro",
        "Resultado financeiro",
        "Lucro antes do imposto de renda",
        "Lucro líquido do período",
    }


def test_linhas_de_cabecalho_com_valor_sao_descartadas():
    """`30` de "30 de junho" e `2026` do ano não podem entrar como saldo."""
    cls = classificar(dre_fleury(), COLS)
    por_rotulo = {c.linha.rotulo: c for c in cls}
    assert por_rotulo["de junho de junho"].descartada
    assert por_rotulo["Nota"].descartada


def test_lucro_por_acao_nao_e_valor_monetario():
    """0,41 é razão. Alocar isso soma centavos a uma posição do template."""
    cls = classificar(dre_fleury(), COLS)
    assert next(c for c in cls if c.linha.rotulo == "Lucro por ação").descartada


# ---------------------------------------------------------------------------
# Escala
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("texto,fator,unidade", [
    ("Em milhares de reais R$", 1_000.0, "milhares de reais"),
    ("Em milhares de reais R$, exceto lucro por ação", 1_000.0, "milhares de reais"),
    ("(Valores expressos em milhares de reais)", 1_000.0, "milhares de reais"),
    ("Em milhões de reais", 1_000_000.0, "milhões de reais"),
    ("Em reais", 1.0, "reais"),
])
def test_detectar_escala(texto, fator, unidade):
    assert detectar_escala([texto]) == (fator, unidade)


def test_escala_nao_declarada_nao_e_adivinhada():
    """Sem declaração, a escala é pergunta aberta - não palpite escondido.

    O balanço fecha igual em qualquer escala, então um palpite errado aqui passa
    por toda a validação e só aparece na frente de quem lê o resultado.
    """
    assert detectar_escala(["Balanço Patrimonial", "Ativo"]) == (1.0, "")


def test_escala_do_balanco_real():
    fator, unidade = detectar_escala(l.rotulo for l in balanco_fleury())
    assert (fator, unidade) == (1_000.0, "milhares de reais")


# ---------------------------------------------------------------------------
# Contrato de normalização (ver AGENTS.md)
# ---------------------------------------------------------------------------
def test_normalizar_mantem_o_contrato_das_quatro_implementacoes():
    assert normalizar("Total do Ativo") == "total do ativo"
    assert normalizar("PATRIMÔNIO LÍQUIDO") == "patrimonio liquido"
    assert normalizar("Ações  em   tesouraria 24.d") == "acoes em tesouraria 24 d"
    assert normalizar(None) == ""


def test_ancoras_estao_normalizadas():
    """Âncora com acento nunca casaria: a comparação é contra texto normalizado."""
    for familia, ancoras in ANCORAS_FECHAMENTO.items():
        for a in ancoras:
            assert a == normalizar(a), f"{familia}: {a!r} não está normalizada"
