"""DFP/ITR PADRONIZADA da CVM - a terceira classe de documento.

POR QUE ESTE ARQUIVO EXISTE
===========================

O primeiro golden foi um balancete de ERP. O segundo, o ITR do Fleury (relatório
diagramado pela companhia). Calibrei o gate de demonstração contra o segundo e
tratei o resultado como geral. Errado: existe uma TERCEIRA classe, e ela é a que
mais chega na mesa do analista - o formulário **padronizado** que a companhia
entrega à CVM.

Resultado ao subir o DFP 2025 do Fleury (139 páginas): **0 linhas lidas**. Nenhum
Balanço encontrado, nenhuma coluna mapeada, `Revisão` vazia. Pior que a v1, que ao
menos exibia as linhas para alocação manual.

Três defeitos, todos de VOCABULÁRIO - nenhum de algoritmo. O texto real extraído
do arquivo:

    pagina 2 de 137 dfp demonstracoes financeiras padronizadas 31 12 2025
    fleury s a versao 1 reais mil
    conta        31/12/2025    31/12/2024    31/12/2023
    1            Ativo Total   11.497.695    11.310.641    9.839.889
    1.01         Ativo Circulante  2.899.764
    1.01.01      Caixa e equivalentes de caixa   5.080

  1. a âncora de fechamento é `Ativo Total`, não `Total do ativo`. Faltando na
     lista, NENHUMA página fechava BP e a leitura zerava. Não degradava: zerava.
  2. a escala é `Reais Mil`, não `Em milhares de reais`. A identidade fecha igual
     em qualquer escala, então isto passaria por toda validação e sairia mil vezes
     menor.
  3. o documento TEM código de conta hierárquico (`1.01.02.01.03`) e ele ficava
     grudado no rótulo. Duas perdas: nenhuma regra do dicionário casa com
     `1.01.01 Caixa e equivalentes de caixa`, e a hierarquia por prefixo - o
     caminho mais testado do projeto - ficava sem uso num documento que tem
     código.

Mais um fato de layout: nesta classe o Ativo e o Passivo vêm em PÁGINAS
SEPARADAS (2 e 4 do documento). É o que justifica as famílias `BP-ATIVO` e
`BP-PASSIVO` serem distintas em vez de um `BP` único.
"""
from __future__ import annotations

import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
if str(RAIZ) not in sys.path:
    sys.path.insert(0, str(RAIZ))

from app.reading.columns import (  # noqa: E402
    descartar_coluna_codigo,
    descartar_coluna_nota,
    detectar_colunas,
    mapear_cabecalho,
)
from app.reading.demonstracao import (  # noqa: E402
    ANCORAS_FECHAMENTO,
    classificar,
    detectar_escala,
    familias_que_fecham,
)
from app.reading.pdf_words import Palavra  # noqa: E402
from app.reading.tables import RE_CODIGO_CONTA, LinhaLida, montar_linhas  # noqa: E402

LARGURA = 6.0


def _p(texto: str, x0: float, top: float) -> Palavra:
    return Palavra(texto=texto, x0=x0, x1=x0 + LARGURA * len(texto),
                   top=top, bottom=top + 10.0, pagina=1)


def _valor(texto: str, x1: float, top: float) -> Palavra:
    return _p(texto, x1 - LARGURA * len(texto), top)


# Colunas de valor da padronizada: três exercícios, alinhados à direita.
X_2025, X_2024, X_2023 = 360.0, 450.0, 540.0
X_CODIGO, X_ROTULO = 40.0, 110.0


def _linha(top: float, codigo: str, rotulo: str,
           v2025: str, v2024: str, v2023: str) -> list[Palavra]:
    palavras = [_p(codigo, X_CODIGO, top)]
    deslocamento = 0.0
    for pedaco in rotulo.split(" "):
        palavras.append(_p(pedaco, X_ROTULO + deslocamento * LARGURA, top))
        deslocamento += len(pedaco) + 1
    palavras.append(_valor(v2025, X_2025, top))
    palavras.append(_valor(v2024, X_2024, top))
    palavras.append(_valor(v2023, X_2023, top))
    return palavras


def _pagina_ativo(com_titulo: bool = False) -> list[Palavra]:
    """Página do Ativo, com os números REAIS do DFP 2025 do Fleury (públicos).

    `com_titulo` acrescenta o bloco de título do formulário da CVM, que contém
    `Versão: 1` - um token de valor solto ACIMA da linha de datas. É ele que
    quebrava a detecção do cabeçalho.
    """
    palavras: list[Palavra] = []
    if com_titulo:
        for i, pedaco in enumerate(
            "DFP - Demonstrações Financeiras Padronizadas - 31/12/2025 - FLEURY S.A.".split()
        ):
            palavras.append(_p(pedaco, X_CODIGO + i * 34.0, 12.0))
        palavras += [_p("Versão:", 480.0, 12.0), _valor("1", X_2025, 12.0)]
        palavras += [_p("(Reais", X_CODIGO, 26.0), _p("Mil)", X_CODIGO + 40.0, 26.0)]
    palavras += [_p("Conta", X_CODIGO, 40.0),
                 _valor("31/12/2025", X_2025, 40.0),
                 _valor("31/12/2024", X_2024, 40.0),
                 _valor("31/12/2023", X_2023, 40.0)]
    palavras += _linha(60.0, "1", "Ativo Total",
                       "11.497.695", "11.310.641", "9.839.889")
    palavras += _linha(80.0, "1.01", "Ativo Circulante",
                       "2.899.764", "3.038.982", "1.701.015")
    palavras += _linha(100.0, "1.01.01", "Caixa e equivalentes de caixa",
                       "5.080", "6.765", "9.675")
    palavras += _linha(120.0, "1.01.03", "Contas a receber",
                       "985.633", "866.878", "820.995")
    palavras += _linha(140.0, "1.01.04", "Estoques",
                       "79.860", "60.367", "56.718")
    palavras += _linha(160.0, "1.02", "Ativo Nao Circulante",
                       "8.597.931", "8.271.659", "8.138.874")
    palavras += _linha(180.0, "1.02.02", "Investimentos",
                       "4.509.232", "4.419.687", "4.205.703")
    palavras.sort(key=lambda p: (round(p.top, 1), p.x0))
    return palavras


# ---------------------------------------------------------------------------
# 1. as âncoras
# ---------------------------------------------------------------------------

def test_ancora_ativo_total_da_cvm_existe() -> None:
    """`Ativo Total` tem de fechar BP-ATIVO. Sem isto a leitura ZERA."""
    assert "ativo total" in ANCORAS_FECHAMENTO["BP-ATIVO"]
    assert "passivo total" in ANCORAS_FECHAMENTO["BP-PASSIVO"]


def test_pagina_do_ativo_da_padronizada_fecha_BP_ATIVO() -> None:
    linhas = [LinhaLida(rotulo="Ativo Total", valores={"c1": 11_497_695.0})]
    assert familias_que_fecham(linhas) == ["BP-ATIVO"]


def test_pagina_do_passivo_da_padronizada_fecha_BP_PASSIVO() -> None:
    # Nesta classe de documento o Passivo vem em página SEPARADA do Ativo.
    linhas = [LinhaLida(rotulo="Passivo Total", valores={"c1": 11_497_695.0})]
    assert familias_que_fecham(linhas) == ["BP-PASSIVO"]


def test_ativo_circulante_continua_NAO_fechando() -> None:
    """Subtotal intermediário promovido a raiz partiria a árvore em duas."""
    linhas = [LinhaLida(rotulo="Ativo Circulante", valores={"c1": 2_899_764.0})]
    assert familias_que_fecham(linhas) == []


# ---------------------------------------------------------------------------
# 2. a escala
# ---------------------------------------------------------------------------

def test_escala_reais_mil_da_padronizada() -> None:
    """`Reais Mil` é como a CVM declara a escala. Errar aqui é invisível.

    A identidade fecha em qualquer escala: se isto passar batido, o balanço sai
    mil vezes menor e NENHUMA validação acusa.
    """
    fator, unidade = detectar_escala([
        "DFP - Demonstrações Financeiras Padronizadas - 31/12/2025 - FLEURY S.A.",
        "Versão: 1", "(Reais Mil)",
    ])
    assert fator == 1000.0
    assert unidade == "milhares de reais"


def test_reais_mil_nao_e_confundido_com_reais() -> None:
    """`em reais` casaria por substring e daria fator 1 - mil vezes errado."""
    fator, _ = detectar_escala(["valores expressos em Reais Mil"])
    assert fator == 1000.0


# ---------------------------------------------------------------------------
# 3. o código de conta
# ---------------------------------------------------------------------------

def test_padrao_de_codigo_aceita_o_formato_da_cvm() -> None:
    for codigo in ("1", "1.01", "1.01.01", "1.01.02.01.03", "2.02.01.02", "3.11"):
        assert RE_CODIGO_CONTA.match(codigo), codigo


def _ler_pagina(palavras: list[Palavra]) -> list[LinhaLida]:
    """Mesma sequência que `main.read` usa, na mesma ordem."""
    colunas = detectar_colunas(palavras)
    colunas = descartar_coluna_codigo(colunas, palavras)
    colunas = descartar_coluna_nota(colunas, palavras)
    rotulos = mapear_cabecalho(palavras, colunas)
    return montar_linhas(palavras, colunas, rotulos)


def test_coluna_Conta_nao_e_confundida_com_coluna_de_valor() -> None:
    """O defeito mais grave desta classe de documento, e o mais silencioso.

    Os tokens `1`, `1.01`, `1.02` são numéricos e alinhados, então
    `detectar_colunas` os encontra como coluna legítima. Sem descartá-la, ela vira
    a PRIMEIRA coluna de valores e todos os períodos deslocam um para a direita:
    `1.01` entra como saldo `1,01` e o exercício mais antigo cai numa coluna sem
    nome. Medido: 4 colunas em vez de 3.
    """
    palavras = _pagina_ativo()
    brutas = detectar_colunas(palavras)
    assert len(brutas) == 4, "a coluna de código é detectada como valor"

    limpas = descartar_coluna_codigo(brutas, palavras)
    assert len(limpas) == 3, "a coluna de código tem de sair"
    # e as que sobram são as de valor, nas abscissas certas
    assert [round(c.x1) for c in limpas] == [round(X_2025), round(X_2024), round(X_2023)]


def test_milhar_nao_e_confundido_com_codigo() -> None:
    """`1.234` é dinheiro; `1.01` é código. O grupo depois do ponto decide.

    Se a regra fosse "tem ponto, então é código", toda coluna de valores em
    milhares seria descartada e a leitura perderia o documento inteiro.
    """
    from app.reading.columns import _CODIGO_HIERARQUICO

    for codigo in ("1.01", "1.01.02", "2.02.01.02", "1.1"):
        assert _CODIGO_HIERARQUICO.match(codigo), codigo
    for dinheiro in ("1.234", "11.497.695", "9.839.889", "1.234.567"):
        assert not _CODIGO_HIERARQUICO.match(dinheiro), dinheiro


def test_codigo_sai_do_rotulo_e_vai_para_campo_proprio() -> None:
    """Com o código grudado, nenhuma regra do dicionário casa."""
    linhas = _ler_pagina(_pagina_ativo())

    por_rotulo = {l.rotulo: l for l in linhas}
    assert "Caixa e equivalentes de caixa" in por_rotulo, list(por_rotulo)
    caixa = por_rotulo["Caixa e equivalentes de caixa"]
    assert caixa.codigo == "1.01.01"
    # e o valor continua na coluna certa
    assert caixa.valores["31/12/2025"] == 5080.0
    assert caixa.valores["31/12/2023"] == 9675.0

    assert por_rotulo["Ativo Total"].codigo == "1"
    assert por_rotulo["Ativo Circulante"].codigo == "1.01"


def test_a_hierarquia_vem_do_PREFIXO_quando_o_documento_traz_codigo() -> None:
    """Fato do documento vence inferência por soma."""
    linhas = _ler_pagina(_pagina_ativo())
    colunas_nome = [c for c in linhas[0].valores]
    classificadas = classificar(linhas, colunas_nome)

    por_rotulo = {c.linha.rotulo: c for c in classificadas if not c.descartada}
    assert "Caixa e equivalentes de caixa" in por_rotulo
    # o código emitido é o DO DOCUMENTO, não `10101` gerado pela árvore
    assert por_rotulo["Caixa e equivalentes de caixa"].codigo == "1.01.01"
    assert por_rotulo["Ativo Total"].codigo == "1"
    # e a família sai do 1º dígito
    assert por_rotulo["Ativo Total"].familia == "BP-ATIVO"
    assert por_rotulo["Estoques"].familia == "BP-ATIVO"


def test_MOBILIA_de_pagina_nao_ganha_codigo_de_conta() -> None:
    """O rodapé "2 de 46" tem `2` como primeiro token.

    Tratado linha a linha, ele receberia código `2`, herdaria família BP-PASSIVO
    pelo primeiro dígito e entraria como conta alocável - mobília de página
    promovida a saldo. A decisão é POR PÁGINA justamente por isso.
    """
    from app.reading.demonstracao import _pagina_tem_coluna_de_codigo

    # página SEM coluna de código: só o rodapé tem número no início
    linhas = [
        LinhaLida(rotulo="Caixa e equivalentes", valores={"c1": 100.0}),
        LinhaLida(rotulo="Contas a receber", valores={"c1": 200.0}),
        LinhaLida(rotulo="Estoques", valores={"c1": 300.0}),
        LinhaLida(rotulo="de 46", valores={"c1": 46.0}, codigo="2"),
    ]
    assert _pagina_tem_coluna_de_codigo(linhas) is False


def test_pagina_da_padronizada_e_reconhecida_como_tendo_codigo() -> None:
    from app.reading.demonstracao import _pagina_tem_coluna_de_codigo

    linhas = [
        LinhaLida(rotulo="Ativo Total", valores={"c1": 11_497_695.0}, codigo="1"),
        LinhaLida(rotulo="Ativo Circulante", valores={"c1": 2_899_764.0}, codigo="1.01"),
        LinhaLida(rotulo="Caixa", valores={"c1": 5_080.0}, codigo="1.01.01"),
        LinhaLida(rotulo="Contas a receber", valores={"c1": 985_633.0}, codigo="1.01.03"),
        LinhaLida(rotulo="Estoques", valores={"c1": 79_860.0}, codigo="1.01.04"),
    ]
    assert _pagina_tem_coluna_de_codigo(linhas) is True


def test_tres_codigos_pontuados_e_o_minimo() -> None:
    """Duas referências de nota não fazem uma coluna de código."""
    from app.reading.demonstracao import _pagina_tem_coluna_de_codigo

    linhas = [
        LinhaLida(rotulo="Caixa", valores={"c1": 1.0}, codigo="1.01"),
        LinhaLida(rotulo="Clientes", valores={"c1": 2.0}, codigo="1.02"),
    ]
    assert _pagina_tem_coluna_de_codigo(linhas) is False


# ---------------------------------------------------------------------------
# 3b. o cabeçalho e as datas das colunas
# ---------------------------------------------------------------------------

def test_as_datas_do_cabecalho_nomeiam_as_colunas() -> None:
    """Sem isso as colunas viram `coluna 1` e o analista adivinha o exercício."""
    palavras = _pagina_ativo()
    colunas = descartar_coluna_codigo(detectar_colunas(palavras), palavras)
    rotulos = mapear_cabecalho(palavras, colunas)
    assert rotulos == ["31/12/2025", "31/12/2024", "31/12/2023"]


def test_VERSAO_1_no_titulo_nao_esconde_a_linha_de_datas() -> None:
    """O defeito que fazia toda coluna virar `coluna N`.

    `top_inicio_valores` marcava a fronteira do cabeçalho no PRIMEIRO token de
    valor. O formulário da CVM traz `Versão: 1` no bloco de título, ACIMA da linha
    de datas: aquele `1` solto é token de valor legítimo, a fronteira subia para
    cima dele, e `mapear_cabecalho` passava a olhar apenas o que estava acima,
    perdendo `Conta 31/12/2025 31/12/2024 31/12/2023`.

    Uma linha de dados de verdade preenche mais de uma coluna. `Versão: 1`
    preenche uma.
    """
    palavras = _pagina_ativo(com_titulo=True)
    colunas = descartar_coluna_codigo(detectar_colunas(palavras), palavras)
    rotulos = mapear_cabecalho(palavras, colunas)
    assert rotulos == ["31/12/2025", "31/12/2024", "31/12/2023"], rotulos


def test_com_data_reconhecida_a_proposta_deixa_de_ser_posicional() -> None:
    """A consequência prática: `propor` volta ao caminho normal, por DATA."""
    from app.reading.periodos import descrever_colunas, propor

    palavras = _pagina_ativo(com_titulo=True)
    colunas = descartar_coluna_codigo(detectar_colunas(palavras), palavras)
    rotulos = mapear_cabecalho(palavras, colunas)
    proposta = propor(descrever_colunas(rotulos, {}))

    assert "POSIÇÃO" not in proposta.criterio, proposta.criterio
    # o exercício mais recente no slot mais recente
    assert proposta.por_slot["Ano 3"] == "31/12/2025"
    assert proposta.por_slot["Ano 2"] == "31/12/2024"
    assert proposta.por_slot["Ano 1"] == "31/12/2023"


def test_data_centralizada_casa_por_ordem_de_x() -> None:
    """Rede de segurança para cabeçalho centralizado sobre a coluna.

    `atribuir_a_coluna` compara pela borda direita. Formulário gerado por sistema
    às vezes centraliza o cabeçalho, e aí a data fica fora da tolerância mesmo
    estando visivelmente sobre a coluna. Com a QUANTIDADE de datas igual à de
    colunas não há ambiguidade possível, e casar por ordem de x é seguro.
    """
    palavras: list[Palavra] = []
    # datas deslocadas ~40pt à esquerda da borda direita das colunas
    for x, texto in ((X_2025 - 40, "31/12/2025"), (X_2024 - 40, "31/12/2024"),
                     (X_2023 - 40, "31/12/2023")):
        palavras.append(_p(texto, x, 40.0))
    palavras += _linha(60.0, "1", "Ativo Total", "11.497.695", "11.310.641", "9.839.889")
    palavras += _linha(80.0, "1.01", "Ativo Circulante", "2.899.764", "3.038.982", "1.701.015")
    palavras += _linha(100.0, "1.01.01", "Caixa", "5.080", "6.765", "9.675")
    palavras.sort(key=lambda p: (round(p.top, 1), p.x0))

    colunas = descartar_coluna_codigo(detectar_colunas(palavras), palavras)
    rotulos = mapear_cabecalho(palavras, colunas)
    assert rotulos == ["31/12/2025", "31/12/2024", "31/12/2023"], rotulos


# ---------------------------------------------------------------------------
# 3c. CONTINUAÇÃO DE PÁGINA - o Balanço ocupa duas páginas por lado
# ---------------------------------------------------------------------------

def _pagina_cvm(numero: int, titulo: str, linhas: list[tuple[str, str, float]]
                ) -> "PaginaLida":
    """Página do formulário da CVM: título, escala, cabeçalho e contas."""
    from app.reading.demonstracao import PaginaLida

    corpo = [
        LinhaLida(rotulo="DFP Demonstrações Financeiras Padronizadas 31/12/2025"),
        LinhaLida(rotulo=titulo),
        LinhaLida(rotulo="(Reais Mil)"),
        LinhaLida(rotulo="Conta 31/12/2025 31/12/2024 31/12/2023"),
    ]
    for codigo, rotulo, valor in linhas:
        corpo.append(LinhaLida(rotulo=rotulo, codigo=codigo,
                               valores={"31/12/2025": valor}))
    return PaginaLida(pagina=numero, tipo="BP", score=0.7,
                      rotulos=["31/12/2025"], linhas=corpo)


def test_a_pagina_de_CONTINUACAO_nao_pode_ser_descartada() -> None:
    """No DFP do Fleury o Balanço ocupa DUAS páginas por lado.

        pág 4  DFs Individuais / Balanço Patrimonial Ativo    34 linhas  ← Ativo Total
        pág 5  DFs Individuais / Balanço Patrimonial Ativo    13 linhas  ← sem âncora
        pág 6  DFs Individuais / Balanço Patrimonial Passivo  34 linhas  ← Passivo Total
        pág 7  DFs Individuais / Balanço Patrimonial Passivo  31 linhas  ← sem âncora

    As páginas 5 e 7 não têm linha de fechamento, então eram descartadas como nota
    explicativa - levando embora 13 linhas de Ativo e 31 de Passivo. O total
    continuava certo (está na página 4), mas as PARCELAS desapareciam, e a
    verificação de leitura acusaria sintética diferente da soma das folhas: Classe
    A, bloqueio.
    """
    from app.reading.demonstracao import agrupar_continuacoes

    ativo = "DFs Individuais / Balanço Patrimonial Ativo"
    passivo = "DFs Individuais / Balanço Patrimonial Passivo"
    paginas = [
        _pagina_cvm(4, ativo, [("1", "Ativo Total", 11_497_695.0),
                               ("1.01", "Ativo Circulante", 2_899_764.0)]),
        _pagina_cvm(5, ativo, [("1.02.02.01", "Participações em Controladas",
                                4_509_232.0)]),
        _pagina_cvm(6, passivo, [("2", "Passivo Total", 11_497_695.0)]),
        _pagina_cvm(7, passivo, [("2.03.05", "Ajustes de Avaliação Patrimonial",
                                  52_817.0)]),
    ]
    agrupadas = agrupar_continuacoes(paginas)

    assert [p.pagina for p in agrupadas] == [4, 6], "5 e 7 são continuação"
    # e as linhas foram ANEXADAS, não perdidas
    rotulos_ativo = [l.rotulo for l in agrupadas[0].linhas]
    assert "Participações em Controladas" in rotulos_ativo
    rotulos_passivo = [l.rotulo for l in agrupadas[1].linhas]
    assert "Ajustes de Avaliação Patrimonial" in rotulos_passivo


def test_titulo_DIFERENTE_nao_e_continuacao() -> None:
    """É o título repetido que identifica continuação, não a ordem da página."""
    from app.reading.demonstracao import agrupar_continuacoes

    paginas = [
        _pagina_cvm(4, "DFs Individuais / Balanço Patrimonial Ativo",
                    [("1", "Ativo Total", 11_497_695.0)]),
        # nota explicativa: título próprio, sem âncora
        _pagina_cvm(16, "Notas explicativas", [("", "Instrumento X", 10.0)]),
    ]
    agrupadas = agrupar_continuacoes(paginas)
    assert [p.pagina for p in agrupadas] == [4, 16]


def test_CONSOLIDADO_nao_continua_INDIVIDUAL() -> None:
    """Somar as duas visões seria somar entidades diferentes.

    O título inteiro entra na comparação - `DFs Individuais` e `DFs Consolidadas`
    trazem o mesmo `Balanço Patrimonial Ativo` mas não são a mesma demonstração.
    """
    from app.reading.demonstracao import agrupar_continuacoes

    paginas = [
        _pagina_cvm(4, "DFs Individuais / Balanço Patrimonial Ativo",
                    [("1", "Ativo Total", 11_497_695.0)]),
        _pagina_cvm(17, "DFs Consolidadas / Balanço Patrimonial Ativo",
                    [("1.02", "Ativo Não Circulante", 8_799_016.0)]),
    ]
    agrupadas = agrupar_continuacoes(paginas)
    assert [p.pagina for p in agrupadas] == [4, 17], "visões diferentes não se juntam"


def test_continuacao_nao_forma_corrente_a_partir_de_pagina_que_nao_fecha() -> None:
    """Não se anexa continuação a continuação: a base tem de ter âncora."""
    from app.reading.demonstracao import agrupar_continuacoes

    titulo = "Notas explicativas"
    paginas = [
        _pagina_cvm(20, titulo, [("", "A", 1.0)]),
        _pagina_cvm(21, titulo, [("", "B", 2.0)]),
    ]
    agrupadas = agrupar_continuacoes(paginas)
    assert [p.pagina for p in agrupadas] == [20, 21]


# ---------------------------------------------------------------------------
# 3c-bis. QUEM É TOTAL vem do CÓDIGO, não da árvore por soma
# ---------------------------------------------------------------------------

def test_folha_com_valor_igual_ao_pai_NAO_pode_virar_total() -> None:
    """O defeito que furou a identidade em 4.509.232 no DFP do Fleury.

        1.02.02        Investimentos                 4.509.232
        1.02.02.01     Participações Societárias     4.509.232
        1.02.02.01.02  Participações em Controladas  4.509.232

    `arvore_por_soma` pressupõe o total DEPOIS das parcelas (layout do ITR). Na
    padronizada da CVM o pai vem PRIMEIRO, então ao processar a última linha a
    lista de pendentes termina com uma de valor IDÊNTICO - sufixo de tamanho 1 que
    soma exatamente o candidato. Ela foi adotada e a FOLHA MAIS PROFUNDA virou
    total, saindo da soma do Ativo.

    Onde há código, o código decide: total é quem outro código ESTENDE.
    """
    from app.reading.demonstracao import sinteticas_por_codigo

    codigos = ["1", "1.01", "1.01.01", "1.02", "1.02.02",
               "1.02.02.01", "1.02.02.01.02", "1.02.03"]
    sinteticas = sinteticas_por_codigo(codigos)

    assert "1.02.02.01.02" not in sinteticas, "folha mais profunda virou total"
    assert "1.02.03" not in sinteticas
    assert "1.01.01" not in sinteticas
    # e os pais continuam totais
    assert {"1", "1.01", "1.02", "1.02.02", "1.02.02.01"} <= sinteticas


def test_prefixo_exige_o_PONTO() -> None:
    """`1.1` não é pai de `1.10`. Sem o ponto, a comparação inventaria pai."""
    from app.reading.demonstracao import sinteticas_por_codigo

    assert sinteticas_por_codigo(["1.1", "1.10"]) == set()
    assert sinteticas_por_codigo(["1.1", "1.1.10"]) == {"1.1"}


def test_sinteticas_por_codigo_tolera_lista_degenerada() -> None:
    from app.reading.demonstracao import sinteticas_por_codigo

    assert sinteticas_por_codigo([]) == set()
    assert sinteticas_por_codigo(["", None, "  "]) == set()
    # código repetido não pode virar pai de si mesmo
    assert sinteticas_por_codigo(["1.01", "1.01"]) == set()


# ---------------------------------------------------------------------------
# 3d. SUBTOTAL DE APURAÇÃO da DRE - irmão, sem código aninhado
# ---------------------------------------------------------------------------

def test_subtotais_da_DRE_da_cvm_sao_reconhecidos() -> None:
    """`3.07 Resultado Antes dos Tributos` ficou folha e foi para `- Impostos Pagos`.

    Casou em Jaccard 0,63 com a entrada de dicionário
    `provisões dos tributos sobre o lucro` - cinco tokens coincidem
    (`dos tributos sobre o lucro`). Um SUBTOTAL numa posição de DESPESA. O guardrail
    de sinal pegou (3 bloqueios de Classe A no DFP do Fleury), mas o mapeamento não
    devia existir: subtotal não é alocável.

    `arvore_por_soma` reconhece parte destes subtotais e não todos - ela exige um
    bloco contíguo de parcelas ainda não adotadas, e num encadeamento de subtotais
    as parcelas de um já foram consumidas pelo anterior.
    """
    from app.reading.demonstracao import eh_subtotal_de_apuracao

    for rotulo in (
        "Resultado Bruto",
        "Resultado Antes do Resultado Financeiro e dos Tributos",
        "Resultado Antes dos Tributos sobre o Lucro",
        "Resultado Líquido das Operações Continuadas",
        "Lucro/Prejuízo Consolidado do Período",
        "Lucro antes de Impostos",
    ):
        assert eh_subtotal_de_apuracao(rotulo), rotulo


def test_conta_de_verdade_com_a_palavra_resultado_continua_alocavel() -> None:
    """O padrão exige o PAR: `resultado` mais qualificador de apuração.

    `Resultado de Equivalência Patrimonial` é conta, não subtotal - existe posição
    própria para ela no plano (`+/- Equivalência Patrimonial`). Vetá-la faria o
    valor desaparecer da DRE.
    """
    from app.reading.demonstracao import eh_subtotal_de_apuracao

    for rotulo in (
        "Resultado de Equivalência Patrimonial",
        "Resultado Financeiro",
        "Receita de Venda de Bens e/ou Serviços",
        "Custo dos Bens e/ou Serviços Vendidos",
        "Despesas Financeiras",
        "Provisões dos tributos sobre o lucro",
    ):
        assert not eh_subtotal_de_apuracao(rotulo), rotulo


# ---------------------------------------------------------------------------
# 4. NUNCA DEVOLVER ZERO - a lição estrutural desta rodada
# ---------------------------------------------------------------------------

def test_sem_data_no_cabecalho_a_proposta_NAO_pode_ser_vazia() -> None:
    """Propor nada é pior que propor com ressalva.

    Este caminho devolvia `por_slot` vazio quando nenhuma coluna tinha data. O
    resultado no DFP 2025 do Fleury foi 0 linhas na tela e "Nenhuma linha
    carregada" na Revisão - pior que a v1, que ao menos exibia tudo para alocação
    manual. O analista perdeu até a chance de decidir.
    """
    from app.reading.periodos import ColunaCandidata, propor

    colunas = [
        ColunaCandidata(rotulo="coluna 1", escopo="", recorte="", tem_data=False,
                        valores_de_referencia={"Ativo Total": 13_220_481.0}),
        ColunaCandidata(rotulo="coluna 2", escopo="", recorte="", tem_data=False,
                        valores_de_referencia={"Ativo Total": 13_062_410.0}),
    ]
    proposta = propor(colunas)

    assert proposta.por_slot, "sem proposta o portal mostra 0 linhas"
    # mais à esquerda = mais recente: convenção da CVM e do ITR diagramado
    assert proposta.por_slot["Ano 3"] == "coluna 1"
    assert proposta.por_slot["Ano 2"] == "coluna 2"
    # e a suposição fica DECLARADA, não escondida
    assert proposta.escolha_pendente is True
    assert "POSIÇÃO" in proposta.criterio
    assert "CONFIRME" in proposta.motivo_pendencia


def test_proposta_posicional_respeita_o_teto_de_tres_slots() -> None:
    from app.reading.periodos import SLOTS, ColunaCandidata, propor

    colunas = [
        ColunaCandidata(rotulo=f"coluna {i}", escopo="", recorte="", tem_data=False)
        for i in range(1, 6)
    ]
    proposta = propor(colunas)
    assert len(proposta.por_slot) == len(SLOTS)
    # as que não couberam continuam ofertadas como alternativa
    assert proposta.alternativas == ["coluna 4", "coluna 5"]


def test_coluna_com_data_continua_tendo_prioridade() -> None:
    """A proposta posicional é rede de segurança, não o caminho normal."""
    from app.reading.periodos import ColunaCandidata, propor

    colunas = [
        ColunaCandidata(rotulo="coluna 1", escopo="", recorte="", tem_data=False),
        ColunaCandidata(rotulo="31/12/2025", escopo="", recorte="", tem_data=True),
        ColunaCandidata(rotulo="31/12/2024", escopo="", recorte="", tem_data=True),
    ]
    proposta = propor(colunas)
    assert proposta.por_slot["Ano 3"] == "31/12/2025"
    assert "coluna 1" not in proposta.por_slot.values()
    assert "POSIÇÃO" not in proposta.criterio


# ---------------------------------------------------------------------------
# 5. o documento sem código continua funcionando como antes
# ---------------------------------------------------------------------------

def test_ITR_diagramado_nao_e_afetado() -> None:
    """A demonstração publicada comum não tem código, e a árvore por soma segue.

    Regressão obrigatória: o golden nº 2 (ITR do Fleury) tem as 53 linhas de conta
    no MESMO x0, sem código nenhum. Se a mudança de código quebrasse esse caminho,
    a hierarquia aritmética inteira cairia.
    """
    from app.reading.demonstracao import _pagina_tem_coluna_de_codigo

    linhas = [
        LinhaLida(rotulo="Caixa e equivalentes de caixa", valores={"c1": 19_060.0}),
        LinhaLida(rotulo="Titulos e valores mobiliarios", valores={"c1": 1_880_069.0}),
        LinhaLida(rotulo="Contas a receber", valores={"c1": 2_094_735.0}),
        LinhaLida(rotulo="Total circulante", valores={"c1": 3_993_864.0}),
    ]
    assert _pagina_tem_coluna_de_codigo(linhas) is False
    assert all(not l.codigo for l in linhas)
