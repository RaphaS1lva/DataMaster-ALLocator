"""
Gerador de artefatos de build a partir de `knowledge/`.

    knowledge/plano-de-contas.lock.json  -> portal/src/core/data/planoContas.gen.js
                                         -> portal/src/core/data/shadowCompute.gen.js
    knowledge/dicionario.csv             -> portal/src/core/data/dicionario.gen.js
                                         -> server/app/db/dicionario.json

Validações que ABORTAM o build (exit 1):

 1. Contagem: exatamente 79 contas alocáveis e 28 subtotais.
 2. Grafia: todo nome de destino igual byte a byte ao lock. Um espaço a mais
    quebra a chave estrutural e o balanço para de fechar - e falha silenciosa
    é justamente o que estamos eliminando.
 3. Cobertura das folhas: cada conta alocável entra em EXATAMENTE UM total
    (41 para o Ativo, 72+80 para Passivo+PL). Detecta omissão e dupla contagem
    no próprio grafo de fórmulas.
 4. Integridade do dicionário: todo destino do CSV resolve para uma conta
    alocável, com grupo/sub compatíveis.

Uso:
    python scripts/gen_knowledge.py [--check]

`--check` valida sem escrever (usado no CI).
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import unicodedata
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
KN = RAIZ / "knowledge"
SAIDA_JS = RAIZ / "portal" / "src" / "core" / "data"
SAIDA_PY = RAIZ / "server" / "app" / "db"

AVISO = "// GERADO por scripts/gen_knowledge.py a partir de knowledge/. NÃO EDITE.\n"


def normalize_text(valor) -> str:
    txt = str(valor if valor is not None else "").strip().lower()
    txt = unicodedata.normalize("NFKD", txt)
    txt = "".join(c for c in txt if not unicodedata.combining(c))
    txt = re.sub(r"[^a-z0-9\s]", " ", txt)
    return re.sub(r"\s+", " ", txt).strip()


class Erro(Exception):
    pass


# ---------------------------------------------------------------------------
# Validação 3: cobertura das folhas no grafo de subtotais
# ---------------------------------------------------------------------------
def contar_folhas(shadow_lado: list[dict], raiz: int) -> dict[int, int]:
    """Quantas vezes cada linha `agg` é contada ao avaliar `raiz`."""
    por_row = {s["row"]: s for s in shadow_lado}
    contagem: dict[int, int] = {}
    visitando: set[int] = set()

    def anda(row: int, peso: int) -> None:
        spec = por_row.get(row)
        if spec is None:
            return
        if row in visitando:
            raise Erro(f"ciclo no grafo de fórmulas na linha {row}")
        if spec["kind"] == "agg":
            contagem[row] = contagem.get(row, 0) + peso
            return
        visitando.add(row)
        for termo in spec.get("terms") or []:
            for r in termo["rows"]:
                anda(r, peso)
        visitando.discard(row)

    anda(raiz, 1)
    return contagem


def validar_cobertura(lock: dict) -> list[str]:
    shadow = lock["shadow"]
    notas: list[str] = []

    ativo = contar_folhas(shadow["AP"], 41)
    passivo = contar_folhas(shadow["AP"], 72)
    recursos = contar_folhas(shadow["AP"], 80)

    direita: dict[int, int] = dict(passivo)
    for row, n in recursos.items():
        direita[row] = direita.get(row, 0) + n

    # nenhuma folha pode estar nos dois lados
    ambos = set(ativo) & set(direita)
    if ambos:
        raise Erro(f"linhas contadas nos DOIS lados do balanço: {sorted(ambos)}")

    for nome, mapa in (("Ativo (41)", ativo), ("Passivo+PL (72+80)", direita)):
        repetidas = {r: n for r, n in mapa.items() if n != 1}
        if repetidas:
            raise Erro(f"{nome}: linhas contadas != 1 vez -> {repetidas} "
                       "(dupla contagem ou sinal invertido no grafo)")

    aloc_ap = {d["row"] for d in lock["destinos"]
               if d["side"] == "AP" and d["tipo"] == "conta"}
    cobertas = set(ativo) | set(direita)
    orfas = aloc_ap - cobertas
    if orfas:
        nomes = {d["row"]: d["destino"] for d in lock["destinos"]}
        raise Erro("contas alocáveis que NÃO entram em nenhum total: "
                   + ", ".join(f"{r} ({nomes.get(r)})" for r in sorted(orfas)))
    extras = cobertas - aloc_ap
    if extras:
        raise Erro(f"o grafo agrega linhas que não são contas alocáveis: {sorted(extras)}")

    notas.append(f"cobertura AP: {len(ativo)} folhas no Ativo + "
                 f"{len(direita)} em Passivo+PL = {len(cobertas)} de "
                 f"{len(aloc_ap)} alocáveis, cada uma exatamente 1x")

    dre_agg = {s["row"] for s in shadow["DRE"] if s["kind"] == "agg"}
    aloc_dre = {d["row"] for d in lock["destinos"]
                if d["side"] == "DRE" and d["tipo"] == "conta"}
    if dre_agg != aloc_dre:
        raise Erro(f"DRE: agg={sorted(dre_agg - aloc_dre)} "
                   f"faltando={sorted(aloc_dre - dre_agg)}")
    notas.append(f"cobertura DRE: {len(dre_agg)} posições agregadas")
    return notas


# ---------------------------------------------------------------------------
def carregar_lock() -> dict:
    lock = json.loads((KN / "plano-de-contas.lock.json").read_text(encoding="utf-8"))
    n_conta = sum(1 for d in lock["destinos"] if d["tipo"] == "conta")
    n_sub = sum(1 for d in lock["destinos"] if d["tipo"] == "subtotal")
    if n_conta != 79:
        raise Erro(f"esperadas 79 contas alocáveis, encontradas {n_conta}")
    if n_sub != 28:
        raise Erro(f"esperados 28 subtotais, encontrados {n_sub}")
    return lock


def validar_md_contra_lock(lock: dict) -> None:
    """O .md é para humanos; o lock é a fonte binária. Confere as contagens e
    que todo destino do lock aparece no .md (proteção contra edição do .md que
    não foi refletida no lock)."""
    md = (KN / "plano-de-contas.md").read_text(encoding="utf-8")
    faltando = []
    for d in lock["destinos"]:
        # o .md marca espaços significativos com ␣
        alvo = d["destino"].replace("|", "\\|").replace("  ", " ␣")
        if f"`{alvo}`" not in md and f"`{d['destino']}`" not in md:
            faltando.append(f"{d['side']}:{d['row']} {d['destino']!r}")
    if faltando:
        raise Erro("destinos do lock ausentes em plano-de-contas.md (rode "
                   "bootstrap_knowledge.py ou corrija o .md): "
                   + "; ".join(faltando[:10]))


def carregar_dicionario(lock: dict) -> list[dict]:
    por_chave = {
        (normalize_text(d["destino"]), normalize_text(d["grupo"]),
         normalize_text(d["subCategoria"])): d
        for d in lock["destinos"]
    }
    linhas, erros = [], []
    with (KN / "dicionario.csv").open(encoding="utf-8", newline="") as fh:
        for i, r in enumerate(csv.DictReader(fh), start=2):
            origem = (r.get("origem") or "").strip()
            destino = (r.get("destino") or "").strip()
            grupo = (r.get("grupo") or "").strip()
            sub = (r.get("sub_categoria") or "").strip()
            if not origem or not destino:
                erros.append(f"linha {i}: origem/destino vazio")
                continue
            alvo = por_chave.get((normalize_text(destino), normalize_text(grupo),
                                  normalize_text(sub)))
            if alvo is None:
                erros.append(f"linha {i}: {destino!r}|{grupo}|{sub} não existe no template")
                continue
            if alvo["tipo"] != "conta":
                erros.append(f"linha {i}: {destino!r} é subtotal - não é alocável")
                continue
            linhas.append({"origem": origem, "destino": alvo["destino"],
                           "grupo": alvo["grupo"], "subCategoria": alvo["subCategoria"]})
    if erros:
        raise Erro("dicionario.csv inválido:\n  " + "\n  ".join(erros[:20]))
    return linhas


def js(nome: str, dados) -> str:
    return AVISO + f"export const {nome} = " + json.dumps(
        dados, ensure_ascii=False, indent=1) + ";\n"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="valida sem escrever")
    args = ap.parse_args()

    try:
        lock = carregar_lock()
        validar_md_contra_lock(lock)
        notas = validar_cobertura(lock)
        dic = carregar_dicionario(lock)
    except Erro as e:
        print(f"FALHA: {e}", file=sys.stderr)
        return 1

    plano = [
        {"row": d["row"], "side": d["side"], "destino": d["destino"],
         "grupo": d["grupo"], "subCategoria": d["subCategoria"],
         "tipo": d["tipo"], "sign": d["sign"]}
        for d in lock["destinos"]
    ]

    print(f"OK  plano: 79 contas + 28 subtotais")
    for n in notas:
        print(f"OK  {n}")
    print(f"OK  dicionário: {len(dic)} regras, todos os destinos alocáveis")

    if args.check:
        print("\n--check: nada escrito.")
        return 0

    SAIDA_JS.mkdir(parents=True, exist_ok=True)
    SAIDA_PY.mkdir(parents=True, exist_ok=True)
    (SAIDA_JS / "planoContas.gen.js").write_text(js("PLANO_CONTAS", plano), encoding="utf-8")
    (SAIDA_JS / "shadowCompute.gen.js").write_text(js("SHADOW_COMPUTE", lock["shadow"]), encoding="utf-8")
    (SAIDA_JS / "dicionario.gen.js").write_text(js("DICIONARIO_SEED", dic), encoding="utf-8")
    (SAIDA_PY / "dicionario.json").write_text(
        json.dumps(dic, ensure_ascii=False, indent=1), encoding="utf-8")
    (SAIDA_PY / "plano_contas.json").write_text(
        json.dumps(plano, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"\nescrito em {SAIDA_JS.relative_to(RAIZ)} e {SAIDA_PY.relative_to(RAIZ)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
