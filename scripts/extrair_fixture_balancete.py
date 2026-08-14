"""
Extrai o Balancete SPE (exemplo) 05.2026 para uma fixture JSON usada como
golden dataset nos testes.

Este arquivo é um balancete do TOTVS Protheus (relatório CTBR040) e exercita,
ao mesmo tempo, as três coisas que o v1 errava:

  · natureza D/C em colunas de texto separadas (todos os valores positivos)
  · hierarquia por PREFIXO de código, sem pontos e com níveis ausentes
  · balancete NÃO ENCERRADO (resultado não transportado ao PL)

Fatos verificados a preservar como assertivas (Saldo Atual, 31/05/2026):
    Ativo        = 118.035.576,14
    Passivo + PL = 118.724.714,55
    Receitas     =  28.281.223,87
    Despesas     =  28.970.362,28
    resultado    =    -689.138,41  (= a diferença, resíduo 0,00)
    débito total = crédito total = 65.083.272,00
    224 folhas / 134 sintéticas / 24 retificadoras

Uso:
    python scripts/extrair_fixture_balancete.py [caminho.xlsx]
"""
from __future__ import annotations

import json
import sys
import zipfile
import re
import xml.etree.ElementTree as ET
from pathlib import Path
from decimal import Decimal

RAIZ = Path(__file__).resolve().parent.parent
PADRAO = RAIZ.parent / "Balancete SPE (exemplo) 05.2026"
NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def col_letra(ref: str) -> str:
    return re.match(r"([A-Z]+)", ref).group(1)


def ler_xlsx(caminho: Path) -> dict[str, list[dict[str, object]]]:
    """Leitor mínimo de xlsx sem dependências (openpyxl não é garantido)."""
    with zipfile.ZipFile(caminho) as z:
        # sharedStrings
        compartilhadas: list[str] = []
        if "xl/sharedStrings.xml" in z.namelist():
            raiz = ET.fromstring(z.read("xl/sharedStrings.xml"))
            for si in raiz.findall(f"{NS}si"):
                compartilhadas.append("".join(t.text or "" for t in si.iter(f"{NS}t")))

        # nomes das abas na ordem dos rIds
        wb = ET.fromstring(z.read("xl/workbook.xml"))
        nomes = [s.get("name") for s in wb.iter(f"{NS}sheet")]

        abas: dict[str, list[dict[str, object]]] = {}
        for idx, nome in enumerate(nomes, start=1):
            alvo = f"xl/worksheets/sheet{idx}.xml"
            if alvo not in z.namelist():
                continue
            ws = ET.fromstring(z.read(alvo))
            linhas = []
            for row in ws.iter(f"{NS}row"):
                celulas: dict[str, object] = {}
                for c in row.findall(f"{NS}c"):
                    ref = c.get("r") or ""
                    tipo = c.get("t")
                    v = c.find(f"{NS}v")
                    isel = c.find(f"{NS}is")
                    if tipo == "s" and v is not None:
                        val = compartilhadas[int(v.text)]
                    elif tipo == "inlineStr" and isel is not None:
                        val = "".join(t.text or "" for t in isel.iter(f"{NS}t"))
                    elif v is not None:
                        txt = v.text or ""
                        try:
                            val = float(txt)
                        except ValueError:
                            val = txt
                    else:
                        continue
                    celulas[col_letra(ref)] = val
                if celulas:
                    linhas.append(celulas)
            abas[nome] = linhas
        return abas


def main() -> int:
    caminho = Path(sys.argv[1]) if len(sys.argv) > 1 else PADRAO
    if not caminho.exists():
        print(f"ERRO: {caminho} não encontrado", file=sys.stderr)
        return 1

    abas = ler_xlsx(caminho)
    nome_aba = next((n for n in abas if "alancete" in n), None)
    if not nome_aba:
        print(f"ERRO: aba de balancete não encontrada em {list(abas)}", file=sys.stderr)
        return 1

    linhas = abas[nome_aba]
    cabecalho = linhas[0]
    dados = linhas[1:]
    print(f"aba: {nome_aba!r}  linhas de dados: {len(dados)}")
    print("cabeçalho:", {k: cabecalho[k] for k in sorted(cabecalho)})

    # Layout Protheus: cada coluna de valor é seguida por sua coluna D/C.
    #   A Conta | B Descrição | C Saldo Anterior | D D/C | E Débito | F Crédito
    #   | G Mov Período | H D/C | I Saldo Atual | J D/C
    PARES = [("C", "D", "Saldo Anterior"), ("G", "H", "Mov Periodo"),
             ("I", "J", "Saldo Atual")]

    rows = []
    for c in dados:
        codigo = c.get("A")
        if codigo is None:
            continue
        # o código vem como float/int: reconstrói sem separador decimal
        cod = str(int(codigo)) if isinstance(codigo, float) else str(codigo).strip()
        descricao = str(c.get("B") or "").strip()
        if not descricao:
            continue
        valores, natureza = {}, {}
        for col_v, col_dc, rotulo in PARES:
            v = c.get(col_v)
            if v is None:
                continue
            valores[rotulo] = v
            dc = str(c.get(col_dc) or "").strip()
            if dc:
                natureza[rotulo] = dc
        rows.append({
            "codigo": cod,
            "origem": descricao,
            "valoresPorSlot": valores,
            "naturezaPorSlot": natureza,
        })

    # --- fatos de conferência, calculados aqui em Decimal ---
    def dec(x) -> Decimal:
        return Decimal(str(x if x is not None else 0))

    codigos = {r["codigo"] for r in rows}

    def eh_folha(cod: str) -> bool:
        return not any(o != cod and o.startswith(cod) for o in codigos)

    folhas = [r for r in rows if eh_folha(r["codigo"])]
    sinteticas = [r for r in rows if not eh_folha(r["codigo"])]

    def assinado(r, rotulo) -> Decimal:
        v = dec(r["valoresPorSlot"].get(rotulo))
        return -v if r["naturezaPorSlot"].get(rotulo, "").upper() == "C" else v

    grupos: dict[str, Decimal] = {}
    for g in "1234":
        grupos[g] = sum((assinado(r, "Saldo Atual") for r in folhas
                         if r["codigo"].startswith(g)), Decimal(0))

    ativo = grupos["1"]
    passivo_pl = -grupos["2"]
    despesas = grupos["3"]
    receitas = -grupos["4"]
    resultado = receitas - despesas
    retif = [r for r in folhas
             if (r["codigo"][0] == "1" and r["naturezaPorSlot"].get("Saldo Atual") == "C")
             or (r["codigo"][0] == "2" and r["naturezaPorSlot"].get("Saldo Atual") == "D")]

    fatos = {
        "arquivo": caminho.name,
        "aba": nome_aba,
        "competencia": "05/2026",
        "linhas": len(rows),
        "folhas": len(folhas),
        "sinteticas": len(sinteticas),
        "retificadoras": len(retif),
        "saldoAtual": {
            "ativo": float(ativo),
            "passivoPl": float(passivo_pl),
            "receitas": float(receitas),
            "despesas": float(despesas),
            "resultado": float(resultado),
            "difSimples": float(ativo - passivo_pl),
            "difEstendida": float(ativo - passivo_pl - resultado),
        },
        "totaisDeclarados": {
            r["codigo"]: {
                "origem": r["origem"],
                "saldoAtual": float(assinado(r, "Saldo Atual")),
            }
            for r in sinteticas if r["codigo"] in ("1", "2", "3", "4", "24")
        },
    }

    saida = RAIZ / "server" / "eval" / "datasets"
    saida.mkdir(parents=True, exist_ok=True)
    (saida / "balancete_spe_exemplo.json").write_text(
        json.dumps({"fatos": fatos, "rows": rows}, ensure_ascii=False, indent=1),
        encoding="utf-8")

    print()
    for k, v in fatos.items():
        if isinstance(v, dict):
            print(f"  {k}:")
            for k2, v2 in v.items():
                print(f"      {k2:16} {v2}")
        else:
            print(f"  {k:16} {v}")
    print(f"\nfixture -> {(saida / 'balancete_spe_exemplo.json').relative_to(RAIZ)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
