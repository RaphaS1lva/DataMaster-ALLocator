"""
Monta o golden dataset de DEMONSTRAÇÃO PUBLICADA a partir do dump de leitura.

Entrada:  a saída de `scripts/dump_leitura.py` sobre um PDF de demonstração.
Saída:    `server/eval/datasets/demonstracao_fleury_2t26.json`

O dataset guarda TRÊS coisas, e cada uma serve a um teste diferente:

  `paginas`         as linhas cruas das páginas de demonstração (6, 7, 8), com
                    x0/top/valores. Alimenta os testes Python de
                    `montar_demonstracao` - árvore, código gerado, escala.
  `notaExplicativa` uma nota (página 16) que o gate de PÁGINA aprova com score
                    1,00. É o controle negativo: o gate de DEMONSTRAÇÃO tem de
                    recusá-la. Se cair, voltam as 1.222 linhas.
  `leitura`         o que o `/read` devolveria: linhas já classificadas, com
                    código gerado e valores rechaveados por período. Alimenta o
                    teste do NÚCLEO do portal, que consome exatamente este
                    formato - e assim o teste de JS exercita o contrato real da
                    API, não uma reimplementação da lógica em JS.

PRIVACIDADE: Fleury S.A. é companhia ABERTA e o ITR é informação pública
(arquivado na CVM e publicado no site de RI). Não há dado de cliente aqui. Para
documento de empresa FECHADA este script NÃO deve ser usado - o dado não pode ir
para o repositório em nenhuma forma que preserve valores.

Uso:
    python -X utf8 scripts/extrair_golden_demonstracao.py <arquivo.leitura.json>
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path
from typing import Any

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ / "server"))

logger = logging.getLogger("golden")

DESTINO_PADRAO = RAIZ / "server" / "eval" / "datasets" / "demonstracao_fleury_2t26.json"

# Páginas do ITR 2T26: 6 = Balanço, 7 = DRE Controladora, 8 = DRE Consolidado.
# 16 = nota explicativa de contas a receber, usada como controle negativo.
PAGINAS_DEMONSTRACAO = (6, 7, 8)
PAGINA_NOTA = 16


def _linha_lida(registro: dict[str, Any], pagina: int):
    from app.reading.tables import LinhaLida

    return LinhaLida(
        rotulo=registro["rotulo"],
        valores=dict(registro["valores"]),
        x0_rotulo=registro["x0"],
        top=registro["top"],
        pagina=pagina,
        nivel_indentacao=registro["nivel"],
    )


def montar(dump: dict[str, Any]) -> dict[str, Any]:
    from app.reading.demonstracao import montar_demonstracao
    from app.reading.periodos import montar_selecao

    por_numero = {p["pagina"]: p for p in dump["paginas"]}
    faltando = [n for n in (*PAGINAS_DEMONSTRACAO, PAGINA_NOTA) if n not in por_numero]
    if faltando:
        raise SystemExit(
            f"o dump não tem as páginas {faltando}. Rode dump_leitura.py sem "
            "--paginas, ou ajuste PAGINAS_DEMONSTRACAO neste script."
        )

    admitidas = [p["pagina"] for p in dump["paginas"] if p["admitida"]]
    linhas_se_todas = sum(
        len(p.get("linhas", [])) for p in dump["paginas"] if p["admitida"]
    )

    demonstracoes: list[dict[str, Any]] = []
    for n in PAGINAS_DEMONSTRACAO:
        p = por_numero[n]
        d, _ = montar_demonstracao(
            pagina=n, tipo=p["tipo"], score=p["score"],
            rotulos=p["cabecalho"],
            linhas=[_linha_lida(l, n) for l in p["linhas"]],
        )
        if d is None:
            raise SystemExit(f"página {n} não foi reconhecida como demonstração")
        demonstracoes.append(d)

    linhas, periodos, selecionadas = montar_selecao(demonstracoes)

    bp = next(d for d in demonstracoes if d["pagina"] == 6)
    dre = next(d for d in demonstracoes if d["pagina"] == 7)
    ativo = next(l for l in bp["linhas"] if l["codigo"] == "1")
    passivo = next(l for l in bp["linhas"] if l["codigo"] == "2")
    lucro = next(l for l in dre["linhas"] if l["codigo"] == "5")

    return {
        "_fonte": "Fleury S.A. - ITR 2T26 (informação pública, CVM/RI)",
        "_gerado_por": "scripts/dump_leitura.py + scripts/extrair_golden_demonstracao.py",
        "_porque": (
            "Golden dataset de DEMONSTRAÇÃO PUBLICADA. O outro golden (balancete "
            "SPE) tem código contábil, hierarquia por prefixo e natureza D/C em "
            "coluna própria; este não tem NENHUMA das três: sem código, sem "
            "indentação (as 53 linhas de conta do Balanço estão todas em "
            "x0=44,76) e embrulhado em 47 páginas de nota, parecer e índice."
        ),
        "documento": {
            "nPaginas": dump["nPaginas"],
            "paginasAdmitidasPeloGateDePagina": admitidas,
            "linhasSeTodasEntrassem": linhas_se_todas,
            "paginasDeDemonstracao": list(PAGINAS_DEMONSTRACAO),
        },
        "fatos": {
            "escala": bp["escala"]["unidade"],
            "bp": {
                "pagina": 6,
                "contas": bp["resumo"]["contas"],
                "sinteticas": bp["resumo"]["sinteticas"],
                "descartadas": bp["resumo"]["descartadas"],
                "colunas": len(bp["colunas"]),
                "totalAtivoConsolidado30062026":
                    ativo["valoresPorSlot"].get("Consolidado 30/06/2026"),
                "totalPassivoPlConsolidado30062026":
                    passivo["valoresPorSlot"].get("Consolidado 30/06/2026"),
                "totalAtivoControladora30062026":
                    ativo["valoresPorSlot"].get("Controladora 30/06/2026"),
                "totalAtivoConsolidado31122025":
                    ativo["valoresPorSlot"].get("Consolidado 31/12/2025"),
            },
            "dre": {
                "pagina": 7,
                "contas": dre["resumo"]["contas"],
                "sinteticas": dre["resumo"]["sinteticas"],
                "colunas": len(dre["colunas"]),
                "lucroLiquidoControladora3m2026":
                    lucro["valoresPorSlot"].get("Controladora 3 meses 30/06/2026"),
                "lucroLiquidoControladora6m2026":
                    lucro["valoresPorSlot"].get("Controladora 6 meses 30/06/2026"),
            },
            "cabecalhoRemontado": [c["rotulo"] for c in dre["colunas"]],
        },
        "paginas": [
            {
                "pagina": por_numero[n]["pagina"],
                "tipo": por_numero[n]["tipo"],
                "score": por_numero[n]["score"],
                "cabecalho": por_numero[n]["cabecalho"],
                "colunas": por_numero[n]["colunas"],
                "linhas": por_numero[n]["linhas"],
            }
            for n in PAGINAS_DEMONSTRACAO
        ],
        "notaExplicativa": {
            "pagina": PAGINA_NOTA,
            "tipo": por_numero[PAGINA_NOTA]["tipo"],
            "score": por_numero[PAGINA_NOTA]["score"],
            "cabecalho": por_numero[PAGINA_NOTA]["cabecalho"],
            "linhas": por_numero[PAGINA_NOTA]["linhas"],
        },
        # O que o /read devolve. É o contrato que o portal consome.
        "leitura": {
            "fonte": "pdf-texto",
            "selecionadas": selecionadas,
            "periodos": periodos,
            "linhas": linhas,
            "escala": bp["escala"],
        },
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("dump", type=Path, help="saída de scripts/dump_leitura.py")
    ap.add_argument("--saida", type=Path, default=DESTINO_PADRAO)
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    if not args.dump.exists():
        logger.error("não encontrei %s", args.dump)
        return 2

    golden = montar(json.loads(args.dump.read_text(encoding="utf-8")))
    args.saida.parent.mkdir(parents=True, exist_ok=True)
    args.saida.write_text(json.dumps(golden, ensure_ascii=False, indent=1),
                          encoding="utf-8")

    fatos = golden["fatos"]
    doc = golden["documento"]
    print()
    print(f"gravado : {args.saida}")
    print(f"tamanho : {args.saida.stat().st_size / 1024:.0f} KB")
    print(f"páginas : {doc['paginasDeDemonstracao']} + nota {PAGINA_NOTA}")
    print(f"gate de página admitiu {len(doc['paginasAdmitidasPeloGateDePagina'])} "
          f"página(s) = {doc['linhasSeTodasEntrassem']} linhas")
    print(f"gate de demonstração deixou {len(golden['leitura']['linhas'])} linhas")
    print(f"escala  : {fatos['escala']}")
    print(f"períodos: {golden['leitura']['periodos']}")
    print(f"Ativo   : {fatos['bp']['totalAtivoConsolidado30062026']:,}")
    print(f"Passivo : {fatos['bp']['totalPassivoPlConsolidado30062026']:,}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
