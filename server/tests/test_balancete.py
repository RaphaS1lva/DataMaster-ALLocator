"""
Testes do adaptador de balancete contra o arquivo REAL.

Golden dataset: `Balancete SPE (exemplo) 05.2026` (TOTVS Protheus CTBR040).
Fatos verificados a preservar (coluna Saldo Atual, 31/05/2026):

    Ativo        = 118.035.576,14      224 contas analíticas
    Passivo + PL = 118.724.714,55      134 contas sintéticas
    resultado    =    -689.138,41      débito total = crédito total
    identidade estendida fecha com resíduo 0,00
"""
from __future__ import annotations

import json
import sys
import unicodedata
from pathlib import Path

import pytest

RAIZ = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(RAIZ / "server"))

from app.reading.balancete import (  # noqa: E402
    classificar_folhas, detectar_layout, eh_balancete, ler_balancete,
    montar_linhas, normalizar, verificar_sinteticas,
)

FIXTURE = RAIZ / "server" / "eval" / "datasets" / "balancete_spe_exemplo.json"

CABECALHO = ["Conta", "Descrição", "Saldo Anterior", "D/C*", "Débito", "Crédito",
             "Mov Período", "D/C**", "Saldo Atual", "D/C***"]


@pytest.fixture(scope="module")
def fixture_real() -> dict:
    if not FIXTURE.exists():
        pytest.skip(f"fixture ausente: rode scripts/extrair_fixture_balancete.py")
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def tabela_do_fixture(dados: dict) -> list[list]:
    """Reconstrói a tabela crua (com as colunas D/C) a partir da fixture."""
    tabela = [CABECALHO]
    for r in dados["rows"]:
        v = r["valoresPorSlot"]
        n = r["naturezaPorSlot"]
        tabela.append([
            r["codigo"], r["origem"],
            v.get("Saldo Anterior"), n.get("Saldo Anterior", ""),
            None, None,
            v.get("Mov Periodo"), n.get("Mov Periodo", ""),
            v.get("Saldo Atual"), n.get("Saldo Atual", ""),
        ])
    return tabela


# ---------------------------------------------------------------------------
# Layout
# ---------------------------------------------------------------------------
def test_normalizar_casa_com_o_js():
    """Contrato: idêntica a normalizeText de portal/src/core/normalize.js."""
    assert normalizar("Mútuo Financeiro L/P") == "mutuo financeiro l p"
    assert normalizar("ICMS s/ vendas") == "icms s vendas"
    assert normalizar("  PRODUTOS   ACABADOS  ") == "produtos acabados"
    assert normalizar("(-) PREJUIZOS ACUMULADOS") == "prejuizos acumulados"
    assert normalizar(None) == ""


def test_detecta_layout_protheus_com_tres_pares_valor_dc():
    layout = detectar_layout([CABECALHO])
    assert layout is not None
    assert layout.indice_codigo == 0
    assert layout.indice_descricao == 1
    saldos = [c for c in layout.colunas if c.eh_saldo]
    assert [c.rotulo for c in saldos] == ["Saldo Anterior", "Mov Periodo", "Saldo Atual"]
    # cada coluna de saldo emparelhada com a D/C IMEDIATAMENTE à sua direita
    assert [c.indice_natureza for c in saldos] == [3, 7, 9]
    assert layout.saldos_absolutos is True
    # Débito/Crédito são movimento, não saldo, e não têm D/C própria
    mov = [c for c in layout.colunas if not c.eh_saldo]
    assert [c.rotulo for c in mov] == ["Débito", "Crédito"]
    assert all(c.indice_natureza is None for c in mov)


def test_emparelhamento_e_posicional_nao_por_nome():
    """Os rótulos D/C só diferem por asteriscos, cuja quantidade não é padrão."""
    layout = detectar_layout([["Conta", "Descrição", "Saldo Atual", "D/C"]])
    assert layout is not None
    assert layout.colunas[0].indice_natureza == 3

    # variações que outros ERPs usam
    for rotulo in ("Natureza", "Nat", "D ou C", "DC", "D/C***"):
        lay = detectar_layout([["Conta", "Nome", "Saldo", rotulo]])
        assert lay is not None, rotulo
        assert lay.colunas[0].indice_natureza == 3, rotulo


def test_sem_coluna_dc_nao_e_saldo_absoluto():
    """BP publicado: o valor já traz o sinal, não há D/C."""
    layout = detectar_layout([["Conta", "Descrição", "2025", "2024"]])
    assert layout is None or not layout.saldos_absolutos


def test_codigo_preserva_zeros_e_nao_vira_notacao_cientifica():
    tabela = [CABECALHO,
              [11010100000071.0, "PRF - MOBI", None, "", None, None, None, "", 3000.0, "D"]]
    layout = detectar_layout(tabela)
    linhas = montar_linhas(tabela, layout)
    assert linhas[0]["codigo"] == "11010100000071"
    assert "e+" not in linhas[0]["codigo"] and "." not in linhas[0]["codigo"]


# ---------------------------------------------------------------------------
# Hierarquia por prefixo
# ---------------------------------------------------------------------------
def test_folha_por_prefixo_estrito():
    codigos = ["1", "11", "1101", "110101", "11010100000071", "110102",
               "11010200000151", "11010200000152"]
    folha = classificar_folhas(codigos)
    assert folha["11010100000071"] is True
    assert folha["11010200000151"] is True
    assert folha["110101"] is False
    assert folha["1101"] is False
    assert folha["1"] is False


def test_niveis_ausentes_nao_geram_orfao():
    """Existe 110101 e 11010100000071, mas NÃO 11010100.

    A regra "pai = código truncado no nível anterior" produziria 116 falsos
    órfãos no arquivo real. A regra de prefixo estrito não se importa.
    """
    codigos = ["110101", "11010100000071"]
    folha = classificar_folhas(codigos)
    assert folha == {"110101": False, "11010100000071": True}


def test_codigos_sem_ponto_ainda_tem_hierarquia():
    """A regra do v1 procurava `codigo + "."` e achava ZERO sintéticas."""
    codigos = ["2", "21", "2111", "211101", "21110100000001"]
    folha = classificar_folhas(codigos)
    assert sum(1 for v in folha.values() if not v) == 4
    assert folha["21110100000001"] is True


# ---------------------------------------------------------------------------
# Arquivo real
# ---------------------------------------------------------------------------
def test_arquivo_real_reconhecido_como_balancete(fixture_real):
    out = ler_balancete(tabela_do_fixture(fixture_real))
    assert out["eh_balancete"] is True, out["motivo"]
    assert out["saldosAbsolutos"] is True
    assert out["confianca"] >= 0.9
    assert out["folhas"] == 224
    assert out["sinteticas"] == 134
    assert len(out["linhas"]) == 358
    assert "Saldo Atual" in out["colunas"]


def test_arquivo_real_natureza_extraida_em_todas_as_colunas(fixture_real):
    out = ler_balancete(tabela_do_fixture(fixture_real))
    por_codigo = {l["codigo"]: l for l in out["linhas"]}

    # conta normal do Ativo: devedora
    assert por_codigo["11010100000071"]["naturezaPorSlot"]["Saldo Atual"] == "D"
    # retificadora do Ativo: CREDORA (é ela que o v1 somava em vez de subtrair)
    assert por_codigo["12220500000004"]["naturezaPorSlot"]["Saldo Atual"] == "C"
    # retificadora do Passivo: DEVEDORA
    assert por_codigo["22080200000009"]["naturezaPorSlot"]["Saldo Atual"] == "D"
    # conta normal do Passivo: credora
    assert por_codigo["24010100000001"]["naturezaPorSlot"]["Saldo Atual"] == "C"


def test_verificacao_de_leitura_passa_com_natureza(fixture_real):
    """134 sintéticas x colunas, zero divergência - o documento fecha consigo."""
    out = ler_balancete(tabela_do_fixture(fixture_real))
    esperada = {"1": "D", "2": "C", "3": "C", "4": "C"}  # natural do bloco

    def assinado(linha, coluna):
        v = linha["valoresPorSlot"].get(coluna)
        if v is None:
            return None
        nat = (linha["naturezaPorSlot"].get(coluna) or "").upper()
        if not nat:
            return None
        # Ativo natural = D; Passivo, Despesa e Receita natural = C
        # (convenção "contribuição assinada ao bloco", ver knowledge/regras-de-sinal.md)
        natural = esperada.get(str(linha["codigo"])[0], "D")
        mag = abs(float(v))
        return mag if nat == natural else -mag

    r = verificar_sinteticas(out["linhas"], ["Saldo Atual"], assinado)
    assert r["folhas"] == 224
    assert r["sinteticas"] == 134
    assert r["testes"] >= 130
    assert r["divergencias"] == [], f"{len(r['divergencias'])} blocos divergem"
    assert r["ok"] is True


def test_verificacao_de_leitura_FALHA_sem_natureza(fixture_real):
    """A prova do contrário: sem D/C, o Ativo infla em R$ 26.534.262,98."""
    out = ler_balancete(tabela_do_fixture(fixture_real))

    def modulo(linha, coluna):
        v = linha["valoresPorSlot"].get(coluna)
        return abs(float(v)) if v is not None else None

    r = verificar_sinteticas(out["linhas"], ["Saldo Atual"], modulo)
    assert r["ok"] is False
    assert len(r["divergencias"]) >= 20
    raiz = next(d for d in r["divergencias"] if d["codigo"] == "1")
    assert abs(raiz["diferenca"] - 26_534_262.98) < 1.0, raiz


def test_identidade_estendida_fecha_no_arquivo_real(fixture_real):
    """Ativo = Passivo + PL + (Receitas − Despesas), resíduo 0,00."""
    f = fixture_real["fatos"]["saldoAtual"]
    assert abs(f["ativo"] - 118_035_576.14) < 0.01
    assert abs(f["passivoPl"] - 118_724_714.55) < 0.01
    assert abs(f["resultado"] - (-689_138.41)) < 0.01
    # a diferença da identidade SIMPLES é exatamente o resultado do período
    assert abs(f["difSimples"] - f["resultado"]) < 0.01
    # e a ESTENDIDA fecha exatamente
    assert abs(f["difEstendida"]) < 0.01


# ---------------------------------------------------------------------------
# Rejeição
# ---------------------------------------------------------------------------
def test_nao_confunde_planilha_qualquer_com_balancete():
    tabela = [
        ["Ingrediente", "Quantidade", "Unidade"],
        ["Farinha de trigo", 500, "g"],
        ["Açúcar", 200, "g"],
        ["Ovos", 3, "un"],
    ]
    out = ler_balancete(tabela)
    assert out["eh_balancete"] is False
    assert out["motivo"]


def test_plano_sem_sinteticas_e_recusado():
    """Um extrato de contas soltas não é plano de contas."""
    tabela = [CABECALHO,
              ["1001", "Conta A", None, "", None, None, None, "", 100.0, "D"],
              ["1002", "Conta B", None, "", None, None, None, "", 200.0, "D"]]
    out = ler_balancete(tabela)
    assert out["eh_balancete"] is False
    assert "sintética" in out["motivo"] or "sintetica" in unicodedata.normalize(
        "NFKD", out["motivo"]).encode("ascii", "ignore").decode()
