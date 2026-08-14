"""
Despeja a leitura REAL de um PDF, página por página, num JSON de diagnóstico.

POR QUE ESTE SCRIPT EXISTE
--------------------------
A máquina de desenvolvimento não tem `pdfplumber` (PyPI bloqueado por proxy),
então não há como inspecionar ali o que a leitura faz com um documento de
verdade. Sem isso, calibrar o classificador de página e a detecção de coluna
viraria adivinhação - e adivinhação em leitura determinística é exatamente como
a v1 produziu um Ativo três vezes maior sem ninguém perceber.

Este script roda no notebook servidor (onde as dependências existem), usa o
MESMO código do pipeline (`app.reading.*`) e grava tudo que a decisão precisa:
score e evidências por página, colunas detectadas com seus x1, e cada linha com
rótulo, x0, nível de indentação e valores por coluna.

A saída serve a dois propósitos: diagnóstico imediato e matéria-prima para uma
fixture de regressão de DEMONSTRAÇÃO PUBLICADA - caso que o golden dataset
atual (balancete de ERP com código contábil) não cobre.

PRIVACIDADE
-----------
Companhia ABERTA tem demonstração pública, e aí o JSON pode ir para o
repositório. Documento de empresa FECHADA não pode: use `--somente-estrutura`,
que troca todo valor numérico por `0` e preserva apenas a geometria (x0, x1,
níveis, contagens), que é o que a calibragem precisa.

Uso:
    python -X utf8 scripts/dump_leitura.py <arquivo.pdf>
    python -X utf8 scripts/dump_leitura.py <arquivo.pdf> --paginas 1-12
    python -X utf8 scripts/dump_leitura.py <arquivo.pdf> --somente-estrutura
    python -X utf8 scripts/dump_leitura.py <arquivo.pdf> --saida diag.json
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path
from typing import Any, Iterable

RAIZ = Path(__file__).resolve().parent.parent
# `app` mora em server/. Sem isto o import falha quando o script é chamado da
# raiz do repositório, que é justamente como o runbook manda chamar.
sys.path.insert(0, str(RAIZ / "server"))

logger = logging.getLogger("dump_leitura")


def faixa_de_paginas(texto: str | None) -> set[int] | None:
    """Interpreta `3`, `1-12`, `6,8,20-22`. `None` significa todas."""
    if not texto:
        return None
    escolhidas: set[int] = set()
    for parte in texto.split(","):
        parte = parte.strip()
        if not parte:
            continue
        if "-" in parte:
            ini, _, fim = parte.partition("-")
            escolhidas.update(range(int(ini), int(fim) + 1))
        else:
            escolhidas.add(int(parte))
    return escolhidas or None


def _limpar_valores(valores: dict[str, Any], somente_estrutura: bool) -> dict[str, Any]:
    if not somente_estrutura:
        return valores
    return {k: (0 if v is not None else None) for k, v in valores.items()}


def _rotulo_ofuscado(rotulo: str) -> str:
    """Preserva forma (comprimento, pontuação, caixa) e descarta conteúdo.

    A calibragem depende de tamanho e pontuação do rótulo, não do nome da
    conta. Isto permite diagnosticar documento de empresa fechada sem expor
    razão social nem descrição de conta.
    """
    saida = []
    for ch in rotulo:
        if ch.isdigit():
            saida.append("9")
        elif ch.isupper():
            saida.append("A")
        elif ch.islower():
            saida.append("a")
        else:
            saida.append(ch)
    return "".join(saida)


def dump(
    caminho: Path,
    paginas_escolhidas: set[int] | None,
    somente_estrutura: bool,
    incluir_palavras: bool,
) -> dict[str, Any]:
    # ESPELHA `main.read` - se divergir, o diagnóstico MENTE.
    #
    # Já mentiu: este script não chamava `descartar_coluna_codigo`, e o dump do DFP
    # do Fleury saiu com a coluna `Conta` ainda presente como coluna de valores.
    # Passei um bom tempo diagnosticando um deslocamento de coluna que a produção
    # já não tinha. Ferramenta de diagnóstico que não reproduz o caminho real é
    # pior que não ter ferramenta.
    from app.reading.columns import (
        descartar_coluna_codigo,
        descartar_coluna_nota,
        detectar_colunas,
        mapear_cabecalho,
    )
    from app.reading.page_classifier import LIMIAR_ADMISSIVEL, classificar_documento
    from app.reading.pdf_words import extrair_palavras
    from app.reading.tables import montar_linhas, nivel_por_indentacao

    dados = caminho.read_bytes()
    logger.info("arquivo: %s (%.1f KB)", caminho.name, len(dados) / 1024)

    relatorio = classificar_documento(dados)
    logger.info(
        "%d páginas; admissível=%s; %s",
        relatorio.n_paginas, relatorio.admissivel, relatorio.motivo,
    )

    saida: dict[str, Any] = {
        "arquivo": caminho.name if not somente_estrutura else "(ofuscado)",
        "bytes": len(dados),
        "somenteEstrutura": somente_estrutura,
        "nPaginas": relatorio.n_paginas,
        "admissivel": relatorio.admissivel,
        "motivo": relatorio.motivo,
        "limiarAdmissivel": LIMIAR_ADMISSIVEL,
        "paginas": [],
    }

    for classificacao in relatorio.paginas:
        n = classificacao.pagina
        if paginas_escolhidas is not None and n not in paginas_escolhidas:
            continue

        registro: dict[str, Any] = {
            "pagina": n,
            "tipo": classificacao.tipo,
            "score": classificacao.score,
            "evidencias": classificacao.evidencias,
            "nColunas": classificacao.n_colunas,
            "densidadeNumerica": classificacao.densidade_numerica,
            "temSubtotalAritmetico": classificacao.tem_subtotal_aritmetico,
            "temTexto": relatorio.tem_texto.get(n, False),
            "admitidaPeloGate": classificacao.score >= LIMIAR_ADMISSIVEL,
        }

        if relatorio.tem_texto.get(n, False):
            palavras = extrair_palavras(dados, n)
            colunas = detectar_colunas(palavras)
            if colunas:
                colunas = descartar_coluna_codigo(colunas, palavras)
                colunas = descartar_coluna_nota(colunas, palavras)
            rotulos = mapear_cabecalho(palavras, colunas)
            linhas = montar_linhas(palavras, colunas, rotulos)
            nivel_por_indentacao(linhas)

            registro["colunas"] = [
                {"indice": i, "x1": round(c.x1, 2),
                 "rotulo": rotulos[i] if i < len(rotulos) else ""}
                for i, c in enumerate(colunas)
            ]
            registro["rotulosCabecalho"] = rotulos
            registro["nPalavras"] = len(palavras)
            registro["linhas"] = [
                {
                    "rotulo": _rotulo_ofuscado(l.rotulo) if somente_estrutura else l.rotulo,
                    # O código do DOCUMENTO (padronizada da CVM). Sem ele no dump é
                    # impossível reconstruir a hierarquia por prefixo fora da
                    # máquina que tem pdfplumber - e era justamente o que faltava
                    # para diagnosticar o DFP do Fleury sem consumir mais uma
                    # rodada do usuário.
                    "codigo": l.codigo,
                    "x0": round(l.x0_rotulo, 2),
                    "top": round(l.top, 2),
                    "nivel": l.nivel_indentacao,
                    "valores": _limpar_valores(dict(l.valores), somente_estrutura),
                }
                for l in linhas
                if l.rotulo.strip() or l.codigo
            ]
            if incluir_palavras:
                registro["palavras"] = [
                    {
                        "texto": _rotulo_ofuscado(p.texto) if somente_estrutura else p.texto,
                        "x0": round(p.x0, 2), "x1": round(p.x1, 2),
                        "top": round(p.top, 2),
                    }
                    for p in palavras
                ]

        saida["paginas"].append(registro)

    return saida


def resumo_na_tela(diag: dict[str, Any]) -> None:
    """Imprime o que decide: quais páginas o gate admitiu e com que evidência."""
    print()
    print(f"{'PÁG':>4}  {'TIPO':<10} {'SCORE':>5}  {'COLS':>4} {'LINHAS':>6}  ADMITIDA")
    print("-" * 78)
    admitidas: list[int] = []
    total_linhas = 0
    for p in diag["paginas"]:
        n_linhas = len(p.get("linhas", []))
        total_linhas += n_linhas if p["admitidaPeloGate"] else 0
        if p["admitidaPeloGate"]:
            admitidas.append(p["pagina"])
        marca = "SIM" if p["admitidaPeloGate"] else "-"
        print(f"{p['pagina']:>4}  {p['tipo']:<10} {p['score']:>5.2f}  "
              f"{p.get('nColunas', 0):>4} {n_linhas:>6}  {marca}")
    print("-" * 78)
    print(f"admitidas pelo gate: {len(admitidas)} página(s) -> {admitidas}")
    print(f"linhas que entrariam no pipeline: {total_linhas}")
    print()
    print("Períodos por página (é aqui que a fusão de colunas se perde):")
    for p in diag["paginas"]:
        if p["admitidaPeloGate"] and p.get("rotulosCabecalho"):
            print(f"  pág {p['pagina']:>3}: {p['rotulosCabecalho']}")


def main(argv: Iterable[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Despeja a leitura real de um PDF para diagnóstico e fixture."
    )
    ap.add_argument("pdf", type=Path, help="caminho do PDF")
    ap.add_argument("--paginas", default=None,
                    help="filtra páginas: '6', '1-12', '6,8,20-22'")
    ap.add_argument("--saida", type=Path, default=None,
                    help="arquivo JSON de saída (padrão: <pdf>.leitura.json)")
    ap.add_argument("--somente-estrutura", action="store_true",
                    help="zera valores e ofusca rótulos (empresa fechada)")
    ap.add_argument("--com-palavras", action="store_true",
                    help="inclui cada palavra com x0/x1/top (arquivo bem maior)")
    args = ap.parse_args(list(argv) if argv is not None else None)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    if not args.pdf.exists():
        logger.error("não encontrei %s", args.pdf)
        return 2

    try:
        diag = dump(args.pdf, faixa_de_paginas(args.paginas),
                    args.somente_estrutura, args.com_palavras)
    except ImportError as e:
        logger.error("dependência de leitura ausente (%s).", e)
        logger.error("ative o venv e instale: pip install -r server/requirements.txt")
        return 3

    destino = args.saida or args.pdf.with_suffix(".leitura.json")
    destino.write_text(
        json.dumps(diag, ensure_ascii=False, indent=1), encoding="utf-8"
    )

    resumo_na_tela(diag)
    print(f"JSON gravado em: {destino}")
    print(f"tamanho: {destino.stat().st_size / 1024:.0f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
