"""
★ GOLDEN - demonstração publicada real: Fleury S.A., ITR 2T26.

POR QUE ESTE ARQUIVO EXISTE
---------------------------
O golden anterior (`balancete_spe_exemplo.json`) é um balancete de ERP: tem
código contábil, hierarquia por prefixo e natureza D/C em coluna própria. A v2
foi inteira validada contra ele - e ele é o caso MINORITÁRIO. O que chega na mesa
do analista é PDF auditado de companhia aberta, que não tem nenhuma das três
coisas.

Quando o Fleury 2T26 passou pelo pipeline pela primeira vez, o resultado foi:
1.222 linhas lidas (contra 115 reais), 38 pseudo-períodos, `Total do Ativo` de
R$ 2,00 e 30 bloqueios de Classe A. As causas, todas de leitura:

  · 30 das 50 páginas eram NOTA EXPLICATIVA e passaram no gate de página, porque
    uma nota tem âncora contábil, colunas alinhadas e subtotal que fecha;
  · o rodapé "2 de 46" foi lido como conta `2de` de saldo 46;
  · o cabeçalho da DRE tem 4 linhas empilhadas, e `30`/`2026` de
    "30 de junho de 2026" caíram como VALOR;
  · sem indentação (as 53 linhas de conta do Balanço estão todas em x0=44,76) e
    sem código, TODA linha virou analítica e os totais foram somados junto.

Os dados aqui são o dump real de `scripts/dump_leitura.py`, limitado às páginas
6, 7 e 8 mais uma nota (página 16) como controle negativo. Fleury é companhia
ABERTA e o ITR é informação pública (CVM/RI) - não há dado de cliente aqui.

Este teste exercita `montar_demonstracao`, que é EXATAMENTE a função que o
`/read` chama. Não é uma segunda implementação da lógica.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

RAIZ_SERVER = Path(__file__).resolve().parents[1]
if str(RAIZ_SERVER) not in sys.path:
    sys.path.insert(0, str(RAIZ_SERVER))

from app.reading.demonstracao import montar_demonstracao  # noqa: E402
from app.reading.periodos import montar_selecao  # noqa: E402
from app.reading.tables import LinhaLida, tolerancia_soma  # noqa: E402

GOLDEN = RAIZ_SERVER / "eval" / "datasets" / "demonstracao_fleury_2t26.json"


@pytest.fixture(scope="module")
def golden() -> dict:
    if not GOLDEN.exists():  # pragma: no cover
        pytest.skip(f"golden ausente: {GOLDEN}")
    return json.loads(GOLDEN.read_text(encoding="utf-8"))


def _linhas(pagina: dict) -> list[LinhaLida]:
    return [
        LinhaLida(
            rotulo=l["rotulo"],
            valores=dict(l["valores"]),
            x0_rotulo=l["x0"],
            top=l["top"],
            pagina=pagina["pagina"],
            nivel_indentacao=l["nivel"],
        )
        for l in pagina["linhas"]
    ]


def _monta(pagina: dict) -> dict | None:
    demonstracao, _ = montar_demonstracao(
        pagina=pagina["pagina"],
        tipo=pagina["tipo"],
        score=pagina["score"],
        rotulos=pagina["cabecalho"],
        linhas=_linhas(pagina),
    )
    return demonstracao


def _pagina(golden: dict, numero: int) -> dict:
    return next(p for p in golden["paginas"] if p["pagina"] == numero)


def _todas(golden: dict) -> list[dict]:
    montadas = [_monta(p) for p in golden["paginas"]]
    return [d for d in montadas if d is not None]


# ---------------------------------------------------------------------------
# O gate de demonstração
# ---------------------------------------------------------------------------
def test_nota_explicativa_e_recusada(golden):
    """★ A nota tem score 1,00 no gate de página - e não é demonstração.

    É o controle negativo mais importante do arquivo: se esta assertiva cair,
    voltam as 1.222 linhas.
    """
    nota = golden["notaExplicativa"]
    assert nota["score"] >= 0.5, "a nota precisa passar no gate de página"
    assert _monta(nota) is None


def test_as_tres_paginas_de_demonstracao_sao_reconhecidas(golden):
    demonstracoes = _todas(golden)
    assert [d["pagina"] for d in demonstracoes] == [6, 7, 8]
    assert _pagina_familias(demonstracoes, 6) == ["BP-ATIVO", "BP-PASSIVO"]
    assert _pagina_familias(demonstracoes, 7) == ["DRE"]
    assert _pagina_familias(demonstracoes, 8) == ["DRE"]


def _pagina_familias(demonstracoes: list[dict], numero: int) -> list[str]:
    return next(d for d in demonstracoes if d["pagina"] == numero)["familias"]


def test_reducao_de_ruido_medida(golden):
    """De 1.222 linhas para 115: o número que motivou toda esta reescrita."""
    doc = golden["documento"]
    assert doc["linhasSeTodasEntrassem"] == 1222
    assert len(doc["paginasAdmitidasPeloGateDePagina"]) == 33
    aproveitadas = sum(len(d["linhas"]) for d in _todas(golden))
    assert aproveitadas < 130


# ---------------------------------------------------------------------------
# Balanço Patrimonial - página 6
# ---------------------------------------------------------------------------
def test_bp_contagem_de_contas_e_sinteticas(golden):
    bp = _monta(_pagina(golden, 6))
    fatos = golden["fatos"]["bp"]
    assert bp["resumo"]["contas"] == fatos["contas"]
    assert bp["resumo"]["sinteticas"] == fatos["sinteticas"]
    assert bp["resumo"]["descartadas"] == fatos["descartadas"]


def test_bp_identidade_fecha_em_todas_as_colunas(golden):
    """★ INVARIANTE - Ativo = Passivo + PL, nas quatro colunas do documento.

    Vem das RAÍZES da árvore aritmética, não de uma soma feita à parte: se a
    reconstrução da hierarquia estivesse errada, as raízes não seriam estas duas.
    """
    bp = _monta(_pagina(golden, 6))
    por_codigo = {l["codigo"]: l for l in bp["linhas"]}
    ativo = por_codigo["1"]          # Total do ativo
    passivo = por_codigo["2"]        # Total do passivo e patrimônio líquido

    comuns = set(ativo["valoresPorSlot"]) & set(passivo["valoresPorSlot"])
    assert len(comuns) == 4, f"esperava 4 colunas, achei {sorted(comuns)}"
    for coluna in comuns:
        a = ativo["valoresPorSlot"][coluna]
        p = passivo["valoresPorSlot"][coluna]
        assert abs(a - p) <= tolerancia_soma(a), f"{coluna}: {a} != {p}"


def test_bp_valores_do_documento_preservados(golden):
    bp = _monta(_pagina(golden, 6))
    fatos = golden["fatos"]["bp"]
    ativo = next(l for l in bp["linhas"] if l["codigo"] == "1")
    assert (ativo["valoresPorSlot"]["Consolidado 30/06/2026"]
            == fatos["totalAtivoConsolidado30062026"])
    assert (ativo["valoresPorSlot"]["Controladora 30/06/2026"]
            == fatos["totalAtivoControladora30062026"])
    assert (ativo["valoresPorSlot"]["Consolidado 31/12/2025"]
            == fatos["totalAtivoConsolidado31122025"])


def test_bp_toda_sintetica_fecha_com_os_filhos(golden):
    """Assertivas de LEITURA de verdade - não mais "passou com 0 assertivas".

    Cada sintética é conferida contra a soma dos seus filhos diretos, em cada
    coluna. É esta contagem que o portal exibe na Conferência.
    """
    bp = _monta(_pagina(golden, 6))
    por_codigo = {l["codigo"]: l for l in bp["linhas"]}
    filhos: dict[str, list[str]] = {}
    for codigo in por_codigo:
        pai = _pai(codigo, por_codigo)
        if pai:
            filhos.setdefault(pai, []).append(codigo)

    assertivas = 0
    for pai, codigos in filhos.items():
        for coluna, alvo in por_codigo[pai]["valoresPorSlot"].items():
            valores = [por_codigo[c]["valoresPorSlot"].get(coluna) for c in codigos]
            if any(v is None for v in valores):
                continue
            assert abs(sum(valores) - alvo) <= tolerancia_soma(alvo), (
                f"{por_codigo[pai]['origem']} [{coluna}]: "
                f"{sum(valores)} != {alvo}")
            assertivas += 1
    # 9 sintéticas x 4 colunas seriam 36, mas 25 é o número correto: o próprio
    # documento deixa célula em branco onde a conta só existe num escopo
    # (`Dividendos a receber Hermes Pardini` não tem Consolidado; `Impostos a
    # recuperar` de longo prazo não tem Controladora). Bloco com filho vazio é
    # pulado em vez de somado como zero - tratar branco como zero faria a
    # sintética "fechar" contra uma soma incompleta, que é conferência falsa.
    assert assertivas == 25, f"{assertivas} assertivas (esperado 25)"


def _pai(codigo: str, por_codigo: dict[str, dict]) -> str:
    """Maior prefixo estrito presente - mesma regra de `hierarquiaPorCodigo`."""
    for tamanho in range(len(codigo) - 1, 0, -1):
        if codigo[:tamanho] in por_codigo:
            return codigo[:tamanho]
    return ""


def test_bp_rodape_de_pagina_nao_entra_como_conta(golden):
    """"2 de 46" chega como `2de` de saldo 46. Alocar isso soma 46 ao Ativo."""
    bp = _monta(_pagina(golden, 6))
    assert all("2de" != l["origem"] for l in bp["linhas"])
    assert any("2de" == d["origem"] for d in bp["descartadas"])


def test_bp_escala_em_milhares_detectada(golden):
    """Sem isto o Ativo sai MIL VEZES menor e a identidade fecha igual."""
    bp = _monta(_pagina(golden, 6))
    assert bp["escala"]["fator"] == 1000.0
    assert bp["escala"]["unidade"] == golden["fatos"]["escala"]


def test_bp_colunas_trazem_valor_de_referencia(golden):
    """O valor da raiz por coluna é o que identifica Controladora x Consolidado.

    Sem ele, escolher coluna com rótulo torto seria adivinhação.
    """
    bp = _monta(_pagina(golden, 6))
    for coluna in bp["colunas"]:
        assert coluna["valoresDeReferencia"], f"{coluna['rotulo']} sem referência"
        assert "Total do ativo" in coluna["valoresDeReferencia"]


def test_bp_escolha_de_escopo_fica_pendente(golden):
    """Controladora e Consolidado juntos: a ferramenta PERGUNTA, não assume."""
    bp = _monta(_pagina(golden, 6))
    assert bp["mapeamento"]["escolhaPendente"] is True
    assert "Consolidado" in bp["mapeamento"]["motivoPendencia"]
    assert "Controladora" in bp["mapeamento"]["motivoPendencia"]


# ---------------------------------------------------------------------------
# DRE - página 7, e o cabeçalho de quatro linhas
# ---------------------------------------------------------------------------
def test_dre_cabecalho_empilhado_e_remontado(golden):
    """★ `30` e `2026` estavam presos nas colunas de VALOR do cabeçalho.

    Antes: `['Controladora', 'Controladora #2', '#3', '#4']` - nenhuma data,
    logo nenhum slot, logo a DRE inteira contribuía ZERO.
    """
    dre = _monta(_pagina(golden, 7))
    rotulos = [c["rotulo"] for c in dre["colunas"]]
    assert rotulos == golden["fatos"]["cabecalhoRemontado"]


def test_dre_recorte_temporal_identificado(golden):
    """Três meses x seis meses: muda toda a leitura de crédito."""
    dre = _monta(_pagina(golden, 7))
    recortes = {c["recorte"] for c in dre["colunas"]}
    assert recortes == {"3 meses", "6 meses"}


def test_dre_propoe_o_acumulado_e_deixa_a_escolha_aberta(golden):
    dre = _monta(_pagina(golden, 7))
    mapeamento = dre["mapeamento"]
    assert mapeamento["porSlot"]["Ano 3"] == "Controladora 6 meses 30/06/2026"
    assert mapeamento["porSlot"]["Ano 2"] == "Controladora 6 meses 30/06/2025"
    assert mapeamento["escolhaPendente"] is True


def test_dre_cadeia_do_resultado_reconstruida(golden):
    dre = _monta(_pagina(golden, 7))
    sinteticas = {l["origem"] for l in dre["linhas"] if l["totalizador"] == "Sim"}
    assert "Lucro Bruto" in sinteticas
    assert "Resultado financeiro" in sinteticas
    assert any(s.startswith("Lucro líquido do período") for s in sinteticas)
    assert dre["resumo"]["sinteticas"] == golden["fatos"]["dre"]["sinteticas"]


def test_dre_lucro_liquido_bate_com_o_documento(golden):
    dre = _monta(_pagina(golden, 7))
    lucro = next(l for l in dre["linhas"] if l["codigo"] == "5")
    fatos = golden["fatos"]["dre"]
    assert (lucro["valoresPorSlot"]["Controladora 3 meses 30/06/2026"]
            == fatos["lucroLiquidoControladora3m2026"])
    assert (lucro["valoresPorSlot"]["Controladora 6 meses 30/06/2026"]
            == fatos["lucroLiquidoControladora6m2026"])


def test_dre_recebe_prefixo_de_apuracao(golden):
    """`5` = apuração: o sinal já vem no número numa demonstração publicada."""
    dre = _monta(_pagina(golden, 7))
    assert all(l["codigo"].startswith("5") for l in dre["linhas"])


def test_dre_linhas_de_cabecalho_com_valor_nao_entram(golden):
    dre = _monta(_pagina(golden, 7))
    descartadas = {d["origem"] for d in dre["descartadas"]}
    assert "Nota" in descartadas               # trazia 2026 / 2025
    assert "de junho de junho" in descartadas  # trazia 30
    assert any("Lucro por ação" in d for d in descartadas)


def test_resultado_abrangente_nao_duplica_o_lucro(golden):
    """`Resultado abrangente total` repete o lucro líquido. Alocar duplicaria."""
    dre = _monta(_pagina(golden, 7))
    aproveitadas = {l["origem"] for l in dre["linhas"]}
    assert not any("abrangente" in o.lower() for o in aproveitadas)


# ---------------------------------------------------------------------------
# Seleção: Balanço + DRE no mesmo template
# ---------------------------------------------------------------------------
def test_selecao_pega_uma_demonstracao_por_familia(golden):
    """Duas DREs no mesmo template seriam a mesma demonstração contada 2x.

    Pior: as duas geram código começando em `5`, e `hierarquiaPorCodigo`
    descartaria a segunda árvore inteira por código duplicado.
    """
    linhas, periodos, ids = montar_selecao(_todas(golden))
    assert ids == ["p6", "p7"]
    assert len(periodos) == 2


def test_selecao_unifica_o_periodo_entre_balanco_e_dre(golden):
    """★ A coluna do Balanço e a da DRE têm rótulos diferentes no documento.

    `Consolidado 30/06/2026` e `Controladora 6 meses 30/06/2026` são o mesmo
    período de negócio. Sem unificar, Ativo e Resultado nunca ocupariam o mesmo
    Ano N e o template sairia com metade das colunas vazias.
    """
    linhas, periodos, _ = montar_selecao(_todas(golden))
    assert periodos == ["31/12/2025", "30/06/2026"]

    ativo = next(l for l in linhas if l["codigo"] == "1")
    lucro = next(l for l in linhas if l["codigo"] == "5")
    assert set(ativo["valoresPorSlot"]) == {"30/06/2026", "31/12/2025"}
    assert "30/06/2026" in lucro["valoresPorSlot"]


def test_selecao_respeita_escolha_do_analista(golden):
    """Quem decide é o especialista: pedir a DRE Consolidada tem de funcionar."""
    linhas, _, ids = montar_selecao(_todas(golden), escolhidos=["p6", "p8"])
    assert ids == ["p6", "p8"]
    assert {l["demonstracao"] for l in linhas} == {"p6", "p8"}


def test_selecao_nao_perde_nem_inventa_linha(golden):
    demonstracoes = _todas(golden)
    linhas, _, ids = montar_selecao(demonstracoes)
    esperado = sum(len(d["linhas"]) for d in demonstracoes if d["id"] in ids)
    assert len(linhas) == esperado


def test_identidade_fecha_apos_a_selecao(golden):
    """O fechamento sobrevive ao rechaveamento de período."""
    linhas, periodos, _ = montar_selecao(_todas(golden))
    ativo = next(l for l in linhas if l["codigo"] == "1")
    passivo = next(l for l in linhas if l["codigo"] == "2")
    for periodo in periodos:
        a = ativo["valoresPorSlot"].get(periodo)
        p = passivo["valoresPorSlot"].get(periodo)
        if a is None or p is None:
            continue
        assert abs(a - p) <= tolerancia_soma(a), f"{periodo}: {a} != {p}"
