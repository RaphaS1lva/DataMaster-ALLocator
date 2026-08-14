"""
Bootstrap ÚNICO da base de conhecimento (executar uma vez).

Lê os seeds auto-gerados do projeto v1 - que foram validados contra o template
Excel original e estão CORRETOS - e os converte para arquivos-fonte legíveis e
versionáveis em `knowledge/`:

    planoContas.seed.js    -> knowledge/plano-de-contas.md
    shadowCompute.seed.js  -> knowledge/formulas-shadow.md
    dicionario.seed.js     -> knowledge/dicionario.csv

Por que inverter a direção: no v1 o Excel era a fonte e o JS o derivado, então
ninguém conseguia revisar 1.285 regras nem ver um diff no git. Aqui o texto
passa a ser a fonte de verdade e o JS volta a ser artefato de build
(scripts/gen_knowledge.py). O Excel deixa de participar do fluxo.

Também emite knowledge/auditoria-dicionario.md: o relatório que prova quais
entradas do dicionário apontam para destinos inexistentes no template - a
causa raiz nº 1 do balanço não fechar.

Uso:
    python scripts/bootstrap_knowledge.py [--v1 <caminho do repo v1>]
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
V1_PADRAO = RAIZ.parent / "datamaster-portal" / "src" / "data"


# ---------------------------------------------------------------------------
# normalizeText: DEVE ser idêntica a portal/src/core/normalize.js e à função
# dm_normalize do Postgres. Divergência aqui é bug silencioso de chave (foi o
# que gerou linhas duplicadas no dicionário do v1).
# ---------------------------------------------------------------------------
def normalize_text(valor) -> str:
    txt = str(valor if valor is not None else "").strip().lower()
    txt = unicodedata.normalize("NFKD", txt)
    txt = "".join(c for c in txt if not unicodedata.combining(c))
    txt = re.sub(r"[^a-z0-9\s]", " ", txt)
    return re.sub(r"\s+", " ", txt).strip()


def ler_seed(caminho: Path):
    """Extrai o literal JSON de um `export const NOME = <json>;`."""
    texto = caminho.read_text(encoding="utf-8")
    inicio = texto.index("=") + 1
    fim = texto.rindex(";")
    return json.loads(texto[inicio:fim].strip())


# ---------------------------------------------------------------------------
# 1. plano-de-contas.md
# ---------------------------------------------------------------------------
CABECALHO_PLANO = """# Plano de Contas - template Shadow

> **Fonte de verdade.** Este arquivo é lido por `scripts/gen_knowledge.py`, que
> gera `portal/src/core/data/planoContas.gen.js`. Não edite o `.gen.js`.

São **79 contas alocáveis** (`conta`) e **28 subtotais** (`subtotal`). Um
subtotal é calculado por aritmética (ver `formulas-shadow.md`) e **nunca recebe
alocação**: alocar num subtotal faz o valor desaparecer do balanço, porque ele
não tem bucket de agregação.

## Colunas

| Coluna | Significado |
|---|---|
| `row` | linha na planilha Shadow (é a identidade usada pelas fórmulas) |
| `side` | `AP` = Ativo/Passivo/PL · `DRE` = Demonstração do Resultado |
| `destino` | nome EXATO, incluindo prefixo de sinal e espaços duplos. É parte da chave. |
| `grupo` / `sub` | compõem a chave estrutural `destino\\|grupo\\|sub` |
| `tipo` | `conta` (alocável) · `subtotal` (calculado) |
| `sinal` | ver `regras-de-sinal.md` - `none` \\| `neg` \\| `pos` \\| `pm` |

**Atenção aos espaços:** `-  Despesas Financeiras` tem dois espaços,
`Resultado da Exploração ` e `Lucro antes de Impostos ` têm espaço no fim.
Isso é preservado verbatim porque faz parte da chave no template original.

**Homônimos entre lados** - `Mútuo Financeiro` (Ativo linha 18 / Passivo 54) e
`Mútuo Financeiro LP` (Ativo 26 / Passivo 67). Só `grupo` + `sub` desambiguam.
Resolver por nome apenas é o que jogava um mútuo passivo no Ativo e produzia
erro de 2x o valor.

"""


def escrever_plano(plano: list[dict], destino: Path) -> None:
    partes = [CABECALHO_PLANO]
    blocos: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for p in plano:
        blocos[(p["grupo"], p["subCategoria"])].append(p)

    ordem = [
        ("Ativo", "Circulante"), ("Ativo", "Não Circulante"),
        ("Passivo", "Circulante"), ("Passivo", "Não Circulante"),
        ("Passivo", "PL"), ("DRE", "DRE"),
    ]
    for grupo, sub in ordem:
        linhas = sorted(blocos.get((grupo, sub), []), key=lambda x: x["row"])
        if not linhas:
            continue
        n_conta = sum(1 for x in linhas if x["tipo"] == "conta")
        partes.append(
            f"## {grupo} · {sub}\n\n"
            f"{n_conta} contas alocáveis, {len(linhas) - n_conta} subtotais.\n\n"
            "| row | side | destino | tipo | sinal |\n|---:|:---:|---|:---:|:---:|\n"
        )
        for x in linhas:
            # escapa o pipe e marca espaços de borda com · para revisão humana
            nome = x["destino"].replace("|", "\\|")
            visivel = nome.replace("  ", " ␣")
            if nome != nome.strip():
                visivel = visivel.replace(" ", "␣") if nome.strip() == "" else (
                    ("␣" if nome.startswith(" ") else "") + visivel.strip()
                    + ("␣" if nome.endswith(" ") else "")
                )
            partes.append(
                f"| {x['row']} | {x['side']} | `{visivel}` | {x['tipo']} | {x['sign']} |\n"
            )
        partes.append("\n")

    partes.append(
        "---\n\n"
        "## Legenda de caracteres\n\n"
        "- `␣` marca espaço significativo (duplo ou de borda) preservado na chave.\n"
        "- Ao editar, mantenha o nome **byte a byte** igual ao template Excel.\n"
        "  `scripts/gen_knowledge.py` valida contra `plano-de-contas.lock.json`\n"
        "  e falha se algum nome mudar sem atualização deliberada do lock.\n"
    )
    destino.write_text("".join(partes), encoding="utf-8")


# ---------------------------------------------------------------------------
# 2. formulas-shadow.md
# ---------------------------------------------------------------------------
def escrever_formulas(shadow: dict, plano: list[dict], destino: Path) -> None:
    nome_por_linha = {(p["side"], p["row"]): p["destino"] for p in plano}
    partes = ["""# Fórmulas da Shadow - grafo de subtotais

> **Fonte de verdade.** Gera `portal/src/core/data/shadowCompute.gen.js`.

Cada posição é `agg` (soma as alocações cuja chave estrutural bate) ou `calc`
(aritmética sobre outras linhas). O grafo abaixo foi verificado contra o
template Excel: **as 28 folhas do Ativo e as 28 folhas de Passivo/PL entram
exatamente uma vez cada** nos totais - sem omissão e sem dupla contagem.

## A identidade

```
Ativo        = linha 41
Passivo + PL = linha 72 + linha 80
```

Note que **80 = 75 + 79** inclui as participações minoritárias, enquanto
**79 = 76 + 77 + 78** não. Usar 79 no lugar de 80 no fechamento erra pelo
valor dos minoritários.

### Consequência importante (imunidade a erro de julgamento)

Como 61, 71 (→72) e 75, 79 (→80) todos desembocam em `Passivo + PL`, **qualquer
realocação dentro desse conjunto é neutra para o fechamento** - inclusive
Circulante ↔ Não Circulante ↔ PL. O mesmo vale dentro do Ativo. Só três coisas
quebram a identidade:

1. atravessar o lado (Ativo ↔ Passivo, ou BP ↔ DRE);
2. cair num `subtotal` (não tem bucket - o valor evapora);
3. cair num destino inexistente (chave órfã).

É por isso que essas três, e só essas três, são verificações **bloqueantes** de
código. Qual folha exatamente é julgamento revisável. Ver
`docs/02-invariante-contabil.md`.

## A identidade estendida (balancete não encerrado)

Num balancete cujo resultado ainda não foi transportado ao PL, a identidade que
vale é:

```
Ativo = Passivo + PL + (Receitas − Despesas)
```

O sistema testa as duas. Se a estendida fecha e a simples não, a diferença
**não é erro**: é o resultado do período, e o valor exato do transporte já é
conhecido.

"""]
    for lado in ("AP", "DRE"):
        partes.append(f"## Lado {lado}\n\n| row | destino | tipo | fórmula |\n|---:|---|:---:|---|\n")
        for spec in shadow[lado]:
            nome = nome_por_linha.get((lado, spec["row"]), spec.get("destino", "")).replace("|", "\\|")
            if spec["kind"] == "agg":
                formula = f"`agg({spec['grupo']}\\|{spec['subCategoria']})`"
                tipo = "conta"
            else:
                termos = spec.get("terms") or []
                if not termos:
                    formula = "`0` (cabeçalho decorativo)"
                else:
                    pedacos = []
                    for t in termos:
                        op = "+" if (t.get("sign") or 1) > 0 else "−"
                        for r in t["rows"]:
                            pedacos.append(f"{op}{r}")
                    formula = "`" + " ".join(pedacos).lstrip("+").strip() + "`"
                tipo = "subtotal"
            partes.append(f"| {spec['row']} | `{nome}` | {tipo} | {formula} |\n")
        partes.append("\n")
    destino.write_text("".join(partes), encoding="utf-8")


# ---------------------------------------------------------------------------
# 3. dicionario.csv + auditoria
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Reescritas de grafia. IMPORTANTE: as chaves são comparadas JÁ NORMALIZADAS.
# No v1 as chaves foram escritas com "/", "(" e "+", que normalizeText remove,
# então o mapa era inalcançável. Aqui a normalização é aplicada na construção.
#
# O valor pode ser:
#   str                      -> troca só o nome do destino
#   (nome, grupo, sub)       -> troca nome + grupo + sub (quando o v1 também
#                               classificou o grupo errado)
# ---------------------------------------------------------------------------
_CORRECOES_BRUTAS = {
    "Fornecedores Externos": "Fornecedores",
    "Outros Nao Operacionais (ANC)": "Outros Não Operacionais LP (ANC)",
    "Outros Não Operacionais (ANC)": "Outros Não Operacionais LP (ANC)",
    "Ajustes derivativos / cambio (+) L/P": "Ajustes derivativos / cambio (PNC)",
    # Grupo trocado no v1: existe "PARTICIPAÇÕES MINORITÁRIAS" (BP linha 75,
    # Passivo|PL) e "+/- Participações Minoritárias" (DRE linha 40). As duas
    # normalizam para a MESMA string, então resolver por nome é ambíguo. A
    # entrada do dicionário vinha como Passivo|Não Circulante, que não casa com
    # nenhuma das duas. O destino correto é o do PL.
    "PARTICIPAÇÕES MINORITÁRIAS": ("PARTICIPAÇÕES MINORITÁRIAS", "Passivo", "PL"),
    # Ativo|Circulante no v1, mas a linha 49 do template é Passivo|Circulante.
    "Ajustes derivativos / cambio (+)": ("Ajustes derivativos / cambio (+)",
                                        "Passivo", "Circulante"),
}
CORRECOES = {normalize_text(k): v for k, v in _CORRECOES_BRUTAS.items()}

# Reescritas GENÉRICAS sobre o texto normalizado, tentadas em ordem. Uma
# reescrita só é aceita se resolver para uma conta alocável - então são
# seguras: no pior caso não resolvem e a entrada cai na auditoria.
#
# É aqui que mora a correção da causa raiz nº 1: no v1 a regra L/P->LP usava
# /\bl\s*\/\s*p\b/ sobre o texto normalizado, exigindo uma barra que
# normalizeText já havia trocado por espaço. Nunca casava, e as ~138 entradas
# "Mútuo Financeiro L/P" / "Bancos L/P" (contas de Passivo Não Circulante)
# vazavam silenciosamente - o sintoma "Ativo > Passivo + PL".
REESCRITAS = [
    (re.compile(r"\bl p\b"), "lp"),
    (re.compile(r"\bde longo prazo\b"), "lp"),
    (re.compile(r"\blongo prazo\b"), "lp"),
    (re.compile(r"\bnao circulante\b"), "lp"),
]

# Origens que são CABEÇALHO DE SEÇÃO, não conta. Perigosas porque
# strongPartialMatch usa includes(): "Passivo não circulante" casa com
# "Total do passivo não circulante" e duplica o bloco inteiro.
ORIGENS_PROIBIDAS = {
    normalize_text(x) for x in [
        "Ativo", "Passivo", "Ativo circulante", "Ativo não circulante",
        "Passivo circulante", "Passivo não circulante", "Patrimônio líquido",
        "Ativo realizável a longo prazo", "Resultado", "Total", "Totais",
        "Demonstração do resultado", "Balanço patrimonial",
    ]
}


def escrever_dicionario(dic: list[dict], plano: list[dict], destino_csv: Path,
                        destino_md: Path) -> dict:
    # índices do template
    por_chave = {}
    por_nome = defaultdict(list)
    for p in plano:
        n = normalize_text(p["destino"])
        por_chave[(n, normalize_text(p["grupo"]), normalize_text(p["subCategoria"]))] = p
        por_nome[n].append(p)

    def _tentar(n: str, gn: str, sn: str):
        """Chave completa; se não houver, nome único. None se ambíguo/ausente."""
        alvo = por_chave.get((n, gn, sn))
        if alvo:
            return alvo
        cands = por_nome.get(n, [])
        # com grupo conhecido, desambigua homônimos (Mútuo Financeiro etc.)
        if gn:
            no_grupo = [c for c in cands if normalize_text(c["grupo"]) == gn]
            if len(no_grupo) == 1:
                return no_grupo[0]
        return cands[0] if len(cands) == 1 else None

    def resolver(dest: str, grupo: str, sub: str):
        """Espelha resolveDestino() do core. Devolve (entrada, motivo)."""
        n, gn, sn = normalize_text(dest), normalize_text(grupo), normalize_text(sub)

        if (alvo := por_chave.get((n, gn, sn))) is not None:
            return alvo, "exato"

        # 1) reescrita explícita (pode trocar grupo/sub)
        if (corr := CORRECOES.get(n)) is not None:
            if isinstance(corr, tuple):
                nome, g2, s2 = corr
                if (alvo := _tentar(normalize_text(nome), normalize_text(g2),
                                    normalize_text(s2))) is not None:
                    return alvo, "corrigido"
            elif (alvo := _tentar(normalize_text(corr), gn, sn)) is not None:
                return alvo, "corrigido"

        # 2) reescritas genéricas (L/P -> LP, longo prazo -> LP, ...)
        for padrao, troca in REESCRITAS:
            n2 = padrao.sub(troca, n)
            if n2 != n and (alvo := _tentar(n2, gn, sn)) is not None:
                return alvo, "corrigido"

        # 3) nome único no template
        cands = por_nome.get(n, [])
        if gn:
            no_grupo = [c for c in cands if normalize_text(c["grupo"]) == gn]
            if len(no_grupo) == 1:
                return no_grupo[0], "por-nome-unico"
        if len(cands) == 1:
            return cands[0], "por-nome-unico"
        if len(cands) > 1:
            return None, "ambiguo"
        return None, "inexistente"

    linhas, problemas = [], []
    contagem = Counter()
    for e in dic:
        origem = str(e.get("origem", "")).strip()
        dest = str(e.get("destino", "")).strip()
        grupo = str(e.get("grupo", "")).strip()
        sub = str(e.get("subCategoria", "")).strip()

        if normalize_text(origem) in ORIGENS_PROIBIDAS:
            contagem["origem_secao"] += 1
            problemas.append(("origem-de-seção", origem, dest, grupo, sub,
                              "removida: casaria com qualquer 'Total de ...'"))
            continue

        alvo, motivo = resolver(dest, grupo, sub)
        contagem[motivo] += 1
        if alvo is None:
            problemas.append((motivo, origem, dest, grupo, sub, "SEM DESTINO VÁLIDO"))
            continue
        if alvo["tipo"] != "conta":
            contagem["subtotal"] += 1
            problemas.append(("destino-subtotal", origem, dest, grupo, sub,
                              f"linha {alvo['row']} é subtotal - valor evaporaria"))
            continue
        if motivo != "exato":
            problemas.append((motivo, origem, dest, grupo, sub,
                              f"-> {alvo['destino']} | {alvo['grupo']} | {alvo['subCategoria']}"))
        linhas.append({
            "origem": origem, "destino": alvo["destino"],
            "grupo": alvo["grupo"], "sub_categoria": alvo["subCategoria"],
        })

    # dedupe pela chave normalizada da origem (mantém a 1ª ocorrência)
    vistas, final, dups = set(), [], 0
    for r in linhas:
        k = (normalize_text(r["origem"]), normalize_text(r["grupo"]),
             normalize_text(r["sub_categoria"]))
        if k in vistas:
            dups += 1
            continue
        vistas.add(k)
        final.append(r)
    final.sort(key=lambda r: (normalize_text(r["grupo"]), normalize_text(r["sub_categoria"]),
                              normalize_text(r["origem"])))

    with destino_csv.open("w", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["origem", "destino", "grupo", "sub_categoria"])
        w.writeheader()
        w.writerows(final)

    md = [f"""# Auditoria do dicionário de contas

> Gerado por `scripts/bootstrap_knowledge.py`. Reexecutável.

Auditoria das {len(dic)} entradas do dicionário v1 contra as 79 posições
alocáveis do template. **Toda entrada cujo destino não resolve para uma conta
alocável é um vazamento silencioso de valor**: `structuralKey` usava `Map.get()`
exato, então a alocação acontecia na Rastreabilidade, o QA não reclamava, e o
valor simplesmente não chegava à Shadow.

## Resumo

| Situação | Entradas |
|---|---:|
| destino exato no template | {contagem['exato']} |
| grafia corrigida por regra explícita | {contagem['corrigido']} |
| resolvida por nome único | {contagem['por-nome-unico']} |
| **ambígua** (nome existe em 2 grupos) | **{contagem['ambiguo']}** |
| **destino inexistente** | **{contagem['inexistente']}** |
| **destino é subtotal** (valor evaporaria) | **{contagem['subtotal']}** |
| origem é cabeçalho de seção (removida) | {contagem['origem_secao']} |
| duplicatas removidas | {dups} |
| **total no CSV final** | **{len(final)}** |

## Por que a correção do v1 não funcionava

`portal/src/core/planoContas.js` do v1 tinha um mapa `DEST_ALIASES` e uma regra
`L/P` → `LP`. Ambos eram código morto:

1. As chaves do mapa não foram normalizadas. A busca era
   `DEST_ALIASES.get(normalizeText(destino))`, e `normalizeText` remove `/`,
   `(`, `)` e `+`. Logo chaves como `'outros nao operacionais (anc)'` e
   `'ajustes derivativos / cambio (+) l/p'` eram **inalcançáveis**.
2. A regra `L/P` usava `/\\bl\\s*\\/\\s*p\\b/`, que exige uma barra literal,
   mas `normalizeText` já a havia trocado por espaço. `"Mútuo Financeiro L/P"`
   chega como `"mutuo financeiro l p"` e nunca casa.

Resultado: as ~138 entradas `L/P` nunca eram corrigidas. Como
`Mútuo Financeiro L/P` e `Bancos L/P` são majoritariamente contas de **Passivo
Não Circulante**, o lado direito perdia valor de forma sistemática - que é
exatamente o sintoma `Ativo > Passivo + PL`.

No v2 a normalização é aplicada às chaves na construção do mapa e a regra de
`L/P` opera sobre o texto **já normalizado** (`l p` → `lp`). Há teste de
regressão para as duas.

## Ocorrências por destino problemático

| destino no dicionário | vezes |
|---|---:|
"""]
    problem_counts = Counter(p[2] for p in problemas if p[0] in
                             ("corrigido", "inexistente", "ambiguo", "destino-subtotal"))
    for dest, n in problem_counts.most_common(40):
        md.append(f"| `{dest}` | {n} |\n")

    md.append("\n## Detalhamento\n\n| situação | origem | destino | grupo | sub | ação |\n"
              "|---|---|---|---|---|---|\n")
    for situacao, origem, dest, grupo, sub, acao in problemas[:400]:
        md.append(f"| {situacao} | `{origem}` | `{dest}` | {grupo} | {sub} | {acao} |\n")
    if len(problemas) > 400:
        md.append(f"\n_(+{len(problemas) - 400} não listadas)_\n")
    destino_md.write_text("".join(md), encoding="utf-8")
    return {"total": len(final), "problemas": len(problemas), "contagem": dict(contagem)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--v1", type=Path, default=V1_PADRAO,
                    help="pasta src/data do portal v1")
    args = ap.parse_args()
    if not (args.v1 / "planoContas.seed.js").exists():
        print(f"ERRO: seeds do v1 não encontrados em {args.v1}", file=sys.stderr)
        return 1

    plano = ler_seed(args.v1 / "planoContas.seed.js")
    shadow = ler_seed(args.v1 / "shadowCompute.seed.js")
    dic = ler_seed(args.v1 / "dicionario.seed.js")

    kn = RAIZ / "knowledge"
    kn.mkdir(exist_ok=True)
    escrever_plano(plano, kn / "plano-de-contas.md")
    escrever_formulas(shadow, plano, kn / "formulas-shadow.md")
    stats = escrever_dicionario(dic, plano, kn / "dicionario.csv",
                                kn / "auditoria-dicionario.md")

    # lock: congela os nomes canônicos para que o gerador detecte alteração
    # acidental de grafia (um espaço a mais quebra a chave e o balanço)
    lock = {
        "n_contas": sum(1 for p in plano if p["tipo"] == "conta"),
        "n_subtotais": sum(1 for p in plano if p["tipo"] == "subtotal"),
        "destinos": [
            {"row": p["row"], "side": p["side"], "destino": p["destino"],
             "grupo": p["grupo"], "subCategoria": p["subCategoria"],
             "tipo": p["tipo"], "sign": p["sign"]}
            for p in sorted(plano, key=lambda x: (x["side"], x["row"]))
        ],
        "shadow": shadow,
    }
    (kn / "plano-de-contas.lock.json").write_text(
        json.dumps(lock, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"plano-de-contas.md          {lock['n_contas']} contas + "
          f"{lock['n_subtotais']} subtotais")
    print(f"formulas-shadow.md          AP={len(shadow['AP'])} DRE={len(shadow['DRE'])}")
    print(f"dicionario.csv              {stats['total']} regras "
          f"(de {len(dic)} do v1)")
    print(f"auditoria-dicionario.md     {stats['problemas']} problemas")
    for k, v in sorted(stats["contagem"].items()):
        print(f"    {k:22} {v}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
