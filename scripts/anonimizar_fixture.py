"""
Anonimiza a fixture do golden dataset, preservando tudo que prova o invariante.

POR QUE ISTO EXISTE
O balancete real que motivou o projeto contém dados identificáveis de um cliente:
razão social, agência e número de conta bancária. O GitHub Pages em conta
gratuita exige repositório PÚBLICO, e o `.gitignore` desprotege
`server/eval/datasets/*.json` de propósito, porque os testes dependem da fixture.
Publicar sem anonimizar exporia o balanço completo e as contas bancárias de uma
empresa fechada.

O QUE É PRESERVADO - tudo que os testes verificam:
  · os 358 códigos contábeis, byte a byte (a hierarquia por prefixo depende deles)
  · todos os valores, em todas as colunas
  · todas as naturezas D/C (é o que prova a regra de sinal por linha)
  · a estrutura de nomes de conta contábil ("(-) AMORT.ACUM.SOFTWARES",
    "( - ) JUROS DEBENTURES", "CAPITAL SOCIAL SUBSCRITO"), que é vocabulário
    contábil genérico e não identifica ninguém
  · os fatos: Ativo 118.035.576,14 · Passivo+PL 118.724.714,55 ·
    resultado -689.138,41 · resíduo da identidade estendida 0,00

O QUE É REMOVIDO:
  · razão social e nome de fantasia
  · agência e número de conta bancária
  · o nome do arquivo original

Reexecutável e IDEMPOTENTE: rodar duas vezes dá o mesmo resultado.

Uso:
    python scripts/anonimizar_fixture.py            # anonimiza e verifica
    python scripts/anonimizar_fixture.py --conferir  # só audita, não escreve
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from decimal import Decimal
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
DATASETS = RAIZ / "server" / "eval" / "datasets"
ORIGEM = DATASETS / "balancete_spe_nova_mobi.json"
DESTINO = DATASETS / "balancete_spe_exemplo.json"

# ---------------------------------------------------------------------------
# Regras de substituição, aplicadas em ordem.
#
# Cuidado deliberado: NÃO mexer em nada que os testes ou os documentos citem.
# Os códigos e os valores nunca são tocados - só texto de nome de conta.
# ---------------------------------------------------------------------------
SUBSTITUICOES: list[tuple[re.Pattern[str], str]] = [
    # agência e conta bancária, nas várias grafias que o Protheus emite
    (re.compile(r"\bAG[.:]?\s*\d+[-\dA-Z]*", re.IGNORECASE), "AG XXXX"),
    (re.compile(r"\bC/C[.:]?\s*[\d.-]+", re.IGNORECASE), "C/C XXXXX"),
    (re.compile(r"\bCC[.:]?\s*[\d.-]+\b", re.IGNORECASE), "CC XXXXX"),
    (re.compile(r"\bC[.:]\s*\d[\d.-]*", re.IGNORECASE), "C. XXXXX"),
    # razão social / nome de fantasia
    (re.compile(r"\bNOVA\s+MOBI\b", re.IGNORECASE), "EMPRESA"),
    (re.compile(r"\bHERMES\s+PARDINI\b", re.IGNORECASE), "PARTE RELACIONADA"),
    # sobra de numeração longa em nome de conta (nº de contrato, apólice)
    (re.compile(r"\b\d{6,}\b"), "XXXXXX"),
]

# Termos que, se aparecerem no resultado, indicam que algo escapou.
PROIBIDOS: tuple[str, ...] = ("NOVA MOBI", "PARDINI", "7868", "71705", "09499",
                              "09903", "3391", "3221", "0678")


def anonimizar_texto(texto: str) -> str:
    saida = texto
    for padrao, troca in SUBSTITUICOES:
        saida = padrao.sub(troca, saida)
    # colapsa espaço que a substituição pode ter deixado
    return re.sub(r"\s{2,}", " ", saida).strip()


def _dec(x) -> Decimal:
    return Decimal(str(x if x is not None else 0))


def conferir_integridade(antes: dict, depois: dict) -> list[str]:
    """Garante que a anonimização não mexeu em NENHUM número nem código."""
    problemas: list[str] = []
    ra, rd = antes["rows"], depois["rows"]

    if len(ra) != len(rd):
        problemas.append(f"nº de linhas mudou: {len(ra)} -> {len(rd)}")
        return problemas

    for i, (a, d) in enumerate(zip(ra, rd)):
        if a["codigo"] != d["codigo"]:
            problemas.append(f"linha {i}: código mudou {a['codigo']} -> {d['codigo']}")
        if a["valoresPorSlot"] != d["valoresPorSlot"]:
            problemas.append(f"linha {i} ({a['codigo']}): VALOR mudou")
        if a["naturezaPorSlot"] != d["naturezaPorSlot"]:
            problemas.append(f"linha {i} ({a['codigo']}): natureza D/C mudou")

    # os fatos que sustentam o invariante
    for chave in ("ativo", "passivoPl", "resultado", "difSimples", "difEstendida"):
        va, vd = antes["fatos"]["saldoAtual"][chave], depois["fatos"]["saldoAtual"][chave]
        if _dec(va) != _dec(vd):
            problemas.append(f"fato {chave} mudou: {va} -> {vd}")
    for chave in ("linhas", "folhas", "sinteticas", "retificadoras"):
        if antes["fatos"][chave] != depois["fatos"][chave]:
            problemas.append(f"fato {chave} mudou")

    return problemas


def auditar(dados: dict) -> list[str]:
    """Procura resquício identificável no resultado."""
    texto = json.dumps(dados, ensure_ascii=False).upper()
    return [t for t in PROIBIDOS if t.upper() in texto]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--conferir", action="store_true",
                    help="audita sem escrever")
    args = ap.parse_args()

    alvo = DESTINO if DESTINO.exists() else ORIGEM
    if not alvo.exists():
        print(f"ERRO: fixture não encontrada em {DATASETS}", file=sys.stderr)
        return 1

    antes = json.loads(alvo.read_text(encoding="utf-8"))

    if args.conferir:
        resquicios = auditar(antes)
        print(f"auditando {alvo.name}")
        if resquicios:
            print(f"  DADO IDENTIFICÁVEL PRESENTE: {resquicios}")
            return 1
        print("  nenhum termo identificável encontrado")
        return 0

    depois = json.loads(json.dumps(antes))  # cópia profunda
    trocadas = 0
    for linha in depois["rows"]:
        novo = anonimizar_texto(linha["origem"])
        if novo != linha["origem"]:
            trocadas += 1
            linha["origem"] = novo

    # metadados do arquivo
    depois["fatos"]["arquivo"] = "balancete_exemplo_05.2026.xlsx"
    depois["fatos"]["aba"] = anonimizar_texto(depois["fatos"].get("aba", ""))
    depois["fatos"]["anonimizado"] = True
    depois["fatos"]["nota"] = (
        "Fixture anonimizada por scripts/anonimizar_fixture.py. Razão social, "
        "agência e conta bancária foram substituídas. Códigos contábeis, valores "
        "e naturezas D/C estão INTACTOS - é isso que o golden dataset precisa "
        "preservar para provar o invariante."
    )
    for k, v in list(depois["fatos"].get("totaisDeclarados", {}).items()):
        v["origem"] = anonimizar_texto(v["origem"])

    problemas = conferir_integridade(antes, depois)
    resquicios = auditar(depois)

    print(f"origem     : {alvo.name}")
    print(f"nomes trocados : {trocadas} de {len(depois['rows'])} linhas")
    print(f"integridade    : {'OK' if not problemas else 'FALHOU'}")
    for p in problemas[:10]:
        print(f"    {p}")
    print(f"auditoria      : {'OK - nenhum resquício' if not resquicios else resquicios}")

    if problemas or resquicios:
        print("\nNADA foi escrito.", file=sys.stderr)
        return 1

    DESTINO.write_text(json.dumps(depois, ensure_ascii=False, indent=1),
                       encoding="utf-8")
    print(f"\nescrito        : {DESTINO.relative_to(RAIZ)}")

    if alvo == ORIGEM and ORIGEM.exists():
        ORIGEM.unlink()
        print(f"removido       : {ORIGEM.relative_to(RAIZ)} (continha dado do cliente)")

    print("\nAmostra do resultado:")
    for linha in depois["rows"]:
        if "AG XXXX" in linha["origem"] or "EMPRESA" in linha["origem"]:
            print(f"    {linha['codigo']:16} {linha['origem']}")
            if linha["codigo"].startswith("110104"):
                break
    return 0


if __name__ == "__main__":
    sys.exit(main())
