"""
PARIDADE DE NORMALIZAÇÃO - o contrato mais frágil do projeto.

`normalizeText` existe em QUATRO lugares e as quatro têm de produzir exatamente
a mesma string:

    portal/src/core/normalize.js          normalizeText   (JS, roda no browser)
    scripts/gen_knowledge.py              normalize_text  (build)
    server/app/reading/page_classifier.py normalizar      (leitura)
    server/app/db/schema.sql              dm_normalize    (Postgres)

Por que isso é crítico: a chave de agregação e a chave do dicionário são
derivadas dessa função. Se duas implementações divergirem, a MESMA conta gera
chaves diferentes - e o valor é silenciosamente descartado da Shadow, sem erro
em lugar nenhum. Foi exatamente o que aconteceu na v1: o trigger do Postgres
normalizava com `lower(unaccent(...))` e o cliente também removia pontuação, de
modo que `"ICMS s/ vendas"` virava `icms s/ vendas` no banco e `icms s vendas`
no browser. Resultado: linhas duplicadas no dicionário e o seed nunca sendo
sobrescrito pelas regras aprendidas.

Este arquivo compara as implementações de Python contra a de JS EXECUTANDO o JS
com o Node. Se o Node não estiver disponível, os casos-alvo continuam sendo
verificados contra uma tabela esperada escrita à mão.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

RAIZ = Path(__file__).resolve().parents[2]
if str(RAIZ / "server") not in sys.path:
    sys.path.insert(0, str(RAIZ / "server"))
if str(RAIZ / "scripts") not in sys.path:
    sys.path.insert(0, str(RAIZ / "scripts"))

from app.reading.page_classifier import normalizar as normalizar_leitura  # noqa: E402

# ---------------------------------------------------------------------------
# Corpus: casos reais que já quebraram, ou que quebram se alguém "simplificar"
# ---------------------------------------------------------------------------
CORPUS: list[str] = [
    # os que causaram o vazamento de 229 regras na v1
    "Mútuo Financeiro L/P",
    "Mútuo Financeiro LP",
    "Bancos L/P",
    "Dividas Fiscais de Longo Prazo",
    "Aplicações Financeiras de L/P",
    "Passivo de Arrendamento não Circulante",
    "Ajustes derivativos / cambio (+) L/P",
    "Outros Não Operacionais (ANC)",
    # o caso que gerava chave dupla entre trigger e cliente
    "ICMS s/ vendas",
    "PIS/COFINS a recolher",
    # espaços significativos do template
    "-  Despesas Financeiras",
    "Resultado da Exploração ",
    "Lucro antes de Impostos ",
    "+/-Outras Receitas/Despesas Operacionais",
    "+/- Participações Minoritárias",
    "PARTICIPAÇÕES MINORITÁRIAS",
    # retificadoras reais do balancete Protheus
    "( - ) JUROS DEBENTURES EMPRESA",
    "(-) AMORT.ACUM.BENFEITORIAS PROP.TERC.",
    "(-) PREJUIZOS ACUMULADOS",
    "( - ) PCLD PERDAS CRED.LIQUIDACAO DUVIDO",
    # Anonimizados, mas com a MESMA estrutura que os tornava casos úteis:
    # pontuação colada a dígito, letra dentro de número, hífen interno.
    "APL.CDB ITAU EMPRESA AG.9999A C.999999",
    "BCO BRASIL EMPRESA AG 9999 CC 9999-9",
    # caixa, acento e espaço múltiplo
    "PRODUTOS   ACABADOS",
    "produtos acabados",
    "Dividendos a pagar",
    "IRPJ e CSLL a recolher",
    "Ações em tesouraria",
    "Imobilizado líquido",
    "Impostos a recuperar/Crédito tributário",
    # bordas
    "",
    "   ",
    "---",
    "123",
    "1.234,56",
    "Ç ç Ã ã Õ õ Ê ê Ü ü",
    "conta\tcom\ttab",
    "conta\ncom\nquebra",
    "acento composto: A\u0301 E\u0301",  # NFD explícito
    "espaço\u00a0inquebrável",
    "hífen\u2011não\u2011separável",
]


def normalizar_gen_knowledge(texto: str) -> str:
    """A implementação usada no build (scripts/gen_knowledge.py)."""
    from gen_knowledge import normalize_text  # import tardio: sys.path acima
    return normalize_text(texto)


def _node() -> str | None:
    for caminho in ("node", r"C:\Program Files\nodejs\node.exe"):
        if shutil.which(caminho) or Path(caminho).exists():
            return caminho
    return None


def normalizar_js(textos: list[str]) -> list[str] | None:
    """Roda o normalizeText REAL do portal via Node. `None` se não houver Node."""
    node = _node()
    if not node:
        return None
    modulo = (RAIZ / "portal" / "src" / "core" / "normalize.js").as_uri()
    script = (
        f"import {{ normalizeText }} from '{modulo}';"
        "const entrada = JSON.parse(process.argv[1]);"
        "process.stdout.write(JSON.stringify(entrada.map(normalizeText)));"
    )
    proc = subprocess.run(
        [node, "--input-type=module", "-e", script, json.dumps(textos)],
        capture_output=True, text=True, encoding="utf-8", timeout=60,
    )
    if proc.returncode != 0:
        raise AssertionError(f"Node falhou: {proc.stderr[:500]}")
    return json.loads(proc.stdout)


# ---------------------------------------------------------------------------
# Tabela esperada - a referência independente das implementações
# ---------------------------------------------------------------------------
ESPERADO: dict[str, str] = {
    "Mútuo Financeiro L/P": "mutuo financeiro l p",
    "Mútuo Financeiro LP": "mutuo financeiro lp",
    "Bancos L/P": "bancos l p",
    "ICMS s/ vendas": "icms s vendas",
    "PIS/COFINS a recolher": "pis cofins a recolher",
    "-  Despesas Financeiras": "despesas financeiras",
    "Resultado da Exploração ": "resultado da exploracao",
    "+/-Outras Receitas/Despesas Operacionais": "outras receitas despesas operacionais",
    "PARTICIPAÇÕES MINORITÁRIAS": "participacoes minoritarias",
    "+/- Participações Minoritárias": "participacoes minoritarias",
    "( - ) JUROS DEBENTURES EMPRESA": "juros debentures empresa",
    "(-) PREJUIZOS ACUMULADOS": "prejuizos acumulados",
    "PRODUTOS   ACABADOS": "produtos acabados",
    "produtos acabados": "produtos acabados",
    "Ações em tesouraria": "acoes em tesouraria",
    "Impostos a recuperar/Crédito tributário": "impostos a recuperar credito tributario",
    "": "",
    "   ": "",
    "---": "",
    "123": "123",
    "1.234,56": "1 234 56",
}


@pytest.mark.parametrize("entrada,saida", sorted(ESPERADO.items()))
def test_tabela_de_referencia(entrada: str, saida: str) -> None:
    """As implementações de Python batem com a referência escrita à mão."""
    assert normalizar_leitura(entrada) == saida
    assert normalizar_gen_knowledge(entrada) == saida


def test_leitura_e_build_concordam_em_todo_o_corpus() -> None:
    """As duas implementações de Python são idênticas no corpus inteiro."""
    divergencias = [
        (t, normalizar_leitura(t), normalizar_gen_knowledge(t))
        for t in CORPUS
        if normalizar_leitura(t) != normalizar_gen_knowledge(t)
    ]
    assert divergencias == [], f"{len(divergencias)} divergências: {divergencias[:5]}"


def test_JS_concorda_com_PYTHON_em_todo_o_corpus() -> None:
    """O elo que faltava: o normalizeText do portal contra o do servidor.

    Executa o arquivo .js de verdade com o Node, em vez de reimplementá-lo - o
    objetivo é justamente detectar quando as duas implementações divergirem.
    """
    resultado_js = normalizar_js(CORPUS)
    if resultado_js is None:
        pytest.skip("Node não encontrado - paridade JS não verificada")

    divergencias = [
        {"entrada": t, "js": js, "python": normalizar_leitura(t)}
        for t, js in zip(CORPUS, resultado_js)
        if js != normalizar_leitura(t)
    ]
    assert divergencias == [], (
        f"{len(divergencias)} divergências JS x Python - a chave de agregação vai "
        f"diferir e valor será descartado silenciosamente: {divergencias[:5]}"
    )


def test_propriedades_invariantes() -> None:
    """Propriedades que a normalização tem de garantir, seja qual for a entrada."""
    for t in CORPUS:
        n = normalizar_leitura(t)
        assert n == n.strip(), f"sobrou espaço nas bordas: {t!r} -> {n!r}"
        assert "  " not in n, f"sobrou espaço duplo: {t!r} -> {n!r}"
        assert n == n.lower(), f"sobrou maiúscula: {t!r} -> {n!r}"
        assert all(c.isascii() for c in n), f"sobrou não-ASCII: {t!r} -> {n!r}"
        assert all(c.isalnum() or c == " " for c in n), (
            f"sobrou pontuação: {t!r} -> {n!r}")
        # idempotência: normalizar duas vezes não muda nada
        assert normalizar_leitura(n) == n, f"não é idempotente: {t!r}"


def test_o_bug_da_v1_esta_coberto() -> None:
    """Registro do defeito concreto, para não voltar.

    O reparo `L/P` -> `LP` da v1 usava /\\bl\\s*\\/\\s*p\\b/ SOBRE O TEXTO JÁ
    NORMALIZADO, exigindo uma barra que a normalização havia trocado por espaço.
    Nunca casava, e as ~138 entradas `Mútuo Financeiro L/P` / `Bancos L/P`
    (contas de Passivo Não Circulante) vazavam silenciosamente.
    """
    assert normalizar_leitura("Mútuo Financeiro L/P") == "mutuo financeiro l p"
    assert "/" not in normalizar_leitura("Mútuo Financeiro L/P")
    # e as duas grafias NÃO colidem por acidente: a reescrita tem de ser explícita
    assert normalizar_leitura("Mútuo Financeiro L/P") != normalizar_leitura("Mútuo Financeiro LP")


def test_sql_dm_normalize_existe_e_remove_pontuacao() -> None:
    """O schema tem de usar dois regexp_replace, não só lower(unaccent()).

    Verificação estática: com o banco ausente não há como executar o SQL, mas
    posso garantir que a definição não regrediu para a forma da v1.
    """
    sql = (RAIZ / "server" / "app" / "db" / "schema.sql").read_text(encoding="utf-8")
    assert "dm_normalize" in sql
    assert sql.count("regexp_replace") >= 2, (
        "dm_normalize precisa de dois regexp_replace: um para trocar pontuação por "
        "espaço e outro para colapsar espaços. Só lower(unaccent()) foi o bug da v1.")
    assert "[^a-z0-9" in sql, "falta a classe de caracteres a preservar"
    assert "unaccent" in sql
    # e nada de resquício do modelo do Supabase
    for proibido in ("auth.uid", "auth.users", "create policy", "row level security"):
        assert proibido not in sql.lower(), f"resquício do Supabase: {proibido}"
