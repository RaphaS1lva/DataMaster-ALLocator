"""
Harness de avaliação. Mede e BLOQUEIA.

Diferença essencial em relação ao eval da v1:

  · A v1 comparava valores com `any(abs(g - esperado) < 0.51 for g in obtidos)`.
    Isso testa PERTINÊNCIA A UM CONJUNTO, não POSIÇÃO. Um par de períodos
    trocado na mesma linha marcava 100% de acurácia - ou seja, o harness era
    cego justamente à troca de coluna que motivou o módulo de reconciliação. A
    métrica de valor aqui é POSICIONAL.

  · A v1 só chamava `sys.exit(1)` em erro de rede ou de job. Uma queda de
    acurácia passava sem ninguém notar. Aqui cada métrica tem LIMIAR e o
    processo sai com código 1 quando qualquer um é violado - é isso que permite
    usar o eval como gate de CI.

  · A v1 media apenas a extração. Aqui medimos as quatro coisas que sustentam a
    tese do projeto: leitura, conservação, identidade e imunidade a erro de
    julgamento. Ver docs/02-invariante-contabil.md.

Uso:
    python server/eval/run_eval.py                 # todos os datasets
    python server/eval/run_eval.py --json          # saída para CI
    python server/eval/run_eval.py --sem-limiar    # mede sem bloquear
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import shutil
from dataclasses import dataclass, field
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[2]
DATASETS = Path(__file__).resolve().parent / "datasets"
sys.path.insert(0, str(RAIZ / "server"))

from app.reading.balancete import (  # noqa: E402
    classificar_folhas, verificar_sinteticas,
)

# ---------------------------------------------------------------------------
# Limiares. Violar qualquer um faz o processo sair com 1.
#
# Note que quatro deles são EXATOS (0 divergências, 0 centavos). Não é rigor
# gratuito: leitura e conservação de valor são propriedades algébricas, e
# "quase" não existe. Já recall e acurácia de mapeamento admitem margem, porque
# dependem de julgamento.
# ---------------------------------------------------------------------------
LIMIARES: dict[str, float] = {
    "leitura_divergencias": 0,          # exato
    "conservacao_perda_centavos": 0,    # exato
    "identidade_residuo_centavos": 1,   # 1 centavo de arredondamento
    "hierarquia_erros": 0,              # exato
    "recall_contas": 0.98,
    "acuracia_valores_posicional": 0.995,
}

VERDE, VERMELHO, AMARELO, CINZA, RESET = (
    "\033[32m", "\033[31m", "\033[33m", "\033[90m", "\033[0m")


@dataclass
class Metrica:
    nome: str
    valor: float
    limiar: float | None
    maior_e_melhor: bool
    unidade: str = ""
    detalhe: str = ""

    @property
    def ok(self) -> bool:
        if self.limiar is None:
            return True
        return (self.valor >= self.limiar if self.maior_e_melhor
                else self.valor <= self.limiar)

    def linha(self) -> str:
        cor = VERDE if self.ok else VERMELHO
        marca = "OK  " if self.ok else "FALHA"
        alvo = ""
        if self.limiar is not None:
            sinal = ">=" if self.maior_e_melhor else "<="
            alvo = f"  (limiar {sinal} {self.limiar:g})"
        valor = (f"{self.valor:.2%}" if self.unidade == "%"
                 else f"{self.valor:g}{self.unidade}")
        extra = f"  {CINZA}{self.detalhe}{RESET}" if self.detalhe else ""
        return f"  {cor}{marca}{RESET}  {self.nome:38} {valor:>12}{alvo}{extra}"


@dataclass
class Resultado:
    dataset: str
    metricas: list[Metrica] = field(default_factory=list)
    erros: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.erros and all(m.ok for m in self.metricas)


# ---------------------------------------------------------------------------
# Convenção de sinal - a mesma de knowledge/regras-de-sinal.md:
# apresentação = contribuição assinada ao bloco.
#   Ativo natural = débito · Passivo, PL e DRE natural = crédito
# ---------------------------------------------------------------------------
_NATURAL_POR_GRUPO = {"1": "D", "2": "C", "3": "C", "4": "C", "5": "C"}


def _assinado(linha: dict, coluna: str) -> float | None:
    valor = (linha.get("valoresPorSlot") or {}).get(coluna)
    if valor is None:
        return None
    natureza = ((linha.get("naturezaPorSlot") or {}).get(coluna) or "").upper()
    if not natureza:
        return None
    codigo = str(linha.get("codigo") or "")
    natural = _NATURAL_POR_GRUPO.get(codigo[:1], "D")
    magnitude = abs(float(valor))
    return magnitude if natureza == natural else -magnitude


def avaliar_balancete(caminho: Path) -> Resultado:
    dados = json.loads(caminho.read_text(encoding="utf-8"))
    fatos = dados["fatos"]
    linhas = dados["rows"]
    res = Resultado(dataset=caminho.stem)

    # --- hierarquia -----------------------------------------------------
    folha_de = classificar_folhas(l.get("codigo", "") for l in linhas)
    n_folhas = sum(1 for v in folha_de.values() if v)
    n_sint = sum(1 for v in folha_de.values() if not v)
    erros_hier = (abs(n_folhas - fatos["folhas"]) + abs(n_sint - fatos["sinteticas"]))
    res.metricas.append(Metrica(
        "hierarquia (folhas/sintéticas)", erros_hier,
        LIMIARES["hierarquia_erros"], maior_e_melhor=False,
        detalhe=f"{n_folhas} folhas, {n_sint} sintéticas"))

    # --- leitura: cada sintética contra a soma das suas folhas ----------
    colunas = sorted({c for l in linhas for c in (l.get("valoresPorSlot") or {})})
    verif = verificar_sinteticas(linhas, colunas, _assinado)
    res.metricas.append(Metrica(
        "leitura (sintética = soma das folhas)", len(verif["divergencias"]),
        LIMIARES["leitura_divergencias"], maior_e_melhor=False,
        detalhe=f"{verif['testes']} assertivas em {len(colunas)} coluna(s)"))

    # --- prova do contrário: sem D/C a verificação TEM de falhar -------
    # Métrica de contra-prova: um harness que passa mesmo com a leitura errada
    # não está medindo nada. Se este número cair a zero, o teste de leitura
    # perdeu poder de detecção.
    sem_dc = [{**l, "naturezaPorSlot": {}} for l in linhas]
    verif_sem = verificar_sinteticas(
        sem_dc, colunas,
        lambda l, c: (abs(float(v)) if (v := (l.get("valoresPorSlot") or {}).get(c))
                      is not None else None))
    res.metricas.append(Metrica(
        "poder de detecção (divergências sem D/C)", len(verif_sem["divergencias"]),
        1, maior_e_melhor=True,
        detalhe="ignorar a natureza PRECISA quebrar a verificação"))

    # --- identidade estendida ------------------------------------------
    saldo = fatos["saldoAtual"]
    residuo = abs(saldo["difEstendida"]) * 100
    res.metricas.append(Metrica(
        "identidade estendida (resíduo)", residuo,
        LIMIARES["identidade_residuo_centavos"], maior_e_melhor=False,
        unidade=" cent",
        detalhe="Ativo = Passivo+PL + (Receitas − Despesas)"))

    # --- a diferença simples É o resultado do período -------------------
    delta = abs(saldo["difSimples"] - saldo["resultado"]) * 100
    res.metricas.append(Metrica(
        "diferença == resultado do período", delta, 1, maior_e_melhor=False,
        unidade=" cent",
        detalhe=f"balancete não encerrado, resultado {saldo['resultado']:,.2f}"))

    # --- reconstrução independente dos totais por grupo ------------------
    # Soma as folhas por grupo e confere que a identidade estendida fecha,
    # SEM usar os totais pré-calculados na fixture. É a contra-prova de que os
    # números da fixture não estão apenas se confirmando a si mesmos.
    import re as _re
    so_digitos = lambda c: _re.sub(r"\D", "", str(c or ""))  # noqa: E731
    folhas = [l for l in linhas if folha_de.get(so_digitos(l.get("codigo")), False)]
    total_grupos = {
        g: sum((_assinado(l, "Saldo Atual") or 0.0) for l in folhas
               if so_digitos(l.get("codigo")).startswith(g))
        for g in "1234"
    }

    # Com a convenção "apresentação = contribuição assinada ao bloco"
    # (knowledge/regras-de-sinal.md), o grupo 1 sai positivo no Ativo e os
    # grupos 2, 3 e 4 saem positivos no seu próprio bloco. Logo:
    #   Ativo        = grupo 1
    #   Passivo + PL = grupo 2
    #   resultado    = grupo 3 + grupo 4   <- SOMA, não subtração: as duas já
    #                                         são contribuições ao lucro
    # Escrever `4 - 3` aqui é o erro que este próprio eval pegou na primeira
    # execução, e é a razão de a métrica existir.
    ativo = total_grupos["1"]
    passivo_pl = total_grupos["2"]
    resultado_calc = total_grupos["3"] + total_grupos["4"]
    residuo_reconstruido = (ativo - passivo_pl - resultado_calc) * 100

    res.metricas.append(Metrica(
        "reconstrução independente da identidade", abs(residuo_reconstruido),
        2, maior_e_melhor=False, unidade=" cent",
        detalhe=(f"A={ativo:,.2f} · P+PL={passivo_pl:,.2f} · "
                 f"result={resultado_calc:,.2f}")))

    # e os totais reconstruídos batem com os declarados na fixture
    for nome, calculado, declarado in (
        ("Ativo", ativo, saldo["ativo"]),
        ("Passivo+PL", passivo_pl, saldo["passivoPl"]),
        ("resultado", resultado_calc, saldo["resultado"]),
    ):
        res.metricas.append(Metrica(
            f"total reconstruído == declarado ({nome})",
            abs(calculado - declarado) * 100, 1, maior_e_melhor=False,
            unidade=" cent", detalhe=f"{calculado:,.2f}"))

    return res


def avaliar_demonstracao(caminho: Path) -> Resultado:
    """Golden de DEMONSTRAÇÃO PUBLICADA (ITR/DFP de companhia aberta).

    Mede o que o balancete de ERP não exercita, e que é o caso MAJORITÁRIO na
    mesa do analista:

      · SELEÇÃO - quantas páginas o gate de demonstração deixa passar. É a
        métrica que impede a volta das 1.222 linhas: um documento de 50 páginas
        com 33 aprovadas pelo gate de página tem de render 3 demonstrações;
      · HIERARQUIA POR ARITMÉTICA - sem código contábil e sem indentação, a
        árvore sai da soma. Cada sintética é conferida contra os seus filhos;
      · IDENTIDADE - Ativo = Passivo + PL nas quatro colunas do documento;
      · ESCALA - "Em milhares de reais" declarado. Errar aqui não aparece em
        nenhuma outra métrica, porque a identidade fecha em qualquer escala.
    """
    from app.reading.demonstracao import montar_demonstracao
    from app.reading.periodos import montar_selecao
    from app.reading.tables import LinhaLida, tolerancia_soma

    dados = json.loads(caminho.read_text(encoding="utf-8"))
    fatos = dados["fatos"]
    res = Resultado(dataset=caminho.stem)

    def linhas_de(pagina: dict) -> list:
        return [
            LinhaLida(rotulo=l["rotulo"], valores=dict(l["valores"]),
                      x0_rotulo=l["x0"], top=l["top"], pagina=pagina["pagina"],
                      nivel_indentacao=l["nivel"])
            for l in pagina["linhas"]
        ]

    def montar(pagina: dict):
        d, _ = montar_demonstracao(
            pagina=pagina["pagina"], tipo=pagina["tipo"], score=pagina["score"],
            rotulos=pagina["cabecalho"], linhas=linhas_de(pagina))
        return d

    # --- seleção: o gate de demonstração ---------------------------------
    demonstracoes = [d for d in (montar(p) for p in dados["paginas"]) if d]
    res.metricas.append(Metrica(
        "demonstrações reconhecidas", len(demonstracoes),
        len(dados["documento"]["paginasDeDemonstracao"]), maior_e_melhor=True,
        detalhe=f"de {dados['documento']['nPaginas']} páginas do documento"))

    nota = dados["notaExplicativa"]
    res.metricas.append(Metrica(
        "nota explicativa recusada", 0 if montar(nota) is None else 1, 0,
        maior_e_melhor=False,
        detalhe=f"nota da página {nota['pagina']} tem score {nota['score']:.2f} "
                "no gate de página"))

    linhas, periodos, selecionadas = montar_selecao(demonstracoes)
    admitidas = len(dados["documento"]["paginasAdmitidasPeloGateDePagina"])
    res.metricas.append(Metrica(
        "linhas entregues ao pipeline", len(linhas), 130, maior_e_melhor=False,
        detalhe=f"{admitidas} páginas passaram no gate de página "
                f"({dados['documento']['linhasSeTodasEntrassem']} linhas)"))

    # --- hierarquia por aritmética ---------------------------------------
    bp = next(d for d in demonstracoes if d["pagina"] == fatos["bp"]["pagina"])
    res.metricas.append(Metrica(
        "sintéticas do Balanço", bp["resumo"]["sinteticas"],
        fatos["bp"]["sinteticas"], maior_e_melhor=True,
        detalhe="reconstruídas por soma, sem código e sem indentação"))

    por_codigo = {l["codigo"]: l for l in bp["linhas"]}
    filhos: dict[str, list[str]] = {}
    for codigo in por_codigo:
        for tamanho in range(len(codigo) - 1, 0, -1):
            if codigo[:tamanho] in por_codigo:
                filhos.setdefault(codigo[:tamanho], []).append(codigo)
                break

    assertivas = divergencias = 0
    for pai, codigos in filhos.items():
        for coluna, alvo in por_codigo[pai]["valoresPorSlot"].items():
            valores = [por_codigo[c]["valoresPorSlot"].get(coluna) for c in codigos]
            if any(v is None for v in valores):
                continue
            assertivas += 1
            if abs(sum(valores) - alvo) > tolerancia_soma(alvo):
                divergencias += 1
    res.metricas.append(Metrica(
        "leitura: sintética x soma dos filhos", divergencias,
        LIMIARES["leitura_divergencias"], maior_e_melhor=False,
        detalhe=f"{assertivas} assertivas"))
    # Verde por ausência de teste é pior que vermelho: se a hierarquia sumir, as
    # divergências caem a zero e a métrica acima passaria sozinha.
    res.metricas.append(Metrica(
        "assertivas de leitura", assertivas, 20, maior_e_melhor=True,
        detalhe="zero assertivas seria 'passou' por vacuidade"))

    # --- identidade -------------------------------------------------------
    ativo = por_codigo["1"]
    passivo = por_codigo["2"]
    comuns = set(ativo["valoresPorSlot"]) & set(passivo["valoresPorSlot"])
    residuo = max(
        (abs(ativo["valoresPorSlot"][c] - passivo["valoresPorSlot"][c])
         for c in comuns), default=float("inf"))
    res.metricas.append(Metrica(
        "identidade Ativo = Passivo + PL", residuo * 100,
        LIMIARES["identidade_residuo_centavos"], maior_e_melhor=False,
        unidade=" cent",
        detalhe=f"{len(comuns)} coluna(s); Ativo {ativo['valoresPorSlot'].get(sorted(comuns)[0]):,.0f}"))

    # --- escala ------------------------------------------------------------
    res.metricas.append(Metrica(
        "escala declarada detectada",
        1 if bp["escala"]["unidade"] == fatos["escala"] else 0, 1,
        maior_e_melhor=True,
        detalhe=f"{bp['escala']['unidade']} (fator {bp['escala']['fator']:,.0f})"))

    # --- cabeçalho empilhado ----------------------------------------------
    dre = next(d for d in demonstracoes if d["pagina"] == fatos["dre"]["pagina"])
    com_data = sum(1 for c in dre["colunas"] if c["temData"])
    res.metricas.append(Metrica(
        "colunas da DRE com data remontada", com_data, len(dre["colunas"]),
        maior_e_melhor=True,
        detalhe="a data estava presa nas colunas de VALOR do cabeçalho"))

    res.metricas.append(Metrica(
        "períodos unificados entre Balanço e DRE", len(periodos), 2,
        maior_e_melhor=True, detalhe=" · ".join(periodos)))

    if len(selecionadas) != len(set(selecionadas)):
        res.erros.append("demonstração selecionada duas vezes")
    return res


def avaliar_contrato_llm() -> Resultado:
    """O que o prompt PROMETE ao modelo tem de ser verdade.

    Existe porque duas promessas falsas custaram R$ 3.314.468 fora da Shadow no
    ITR do Fleury, sem nenhum teste vermelho:

      · o prompt mandava confiar no 1º dígito do código ("o dígito MANDA") e
        definia 1, 2, 3, 4 - mas a demonstração publicada gera o prefixo `5` para
        a DRE. O modelo ficou com o sinal mais forte apontando para o nada e
        devolveu "Código 5010105 indica Passivo, cadeia_pais aponta para DRE";
      · o prompt mandava deixar em branco na dúvida. Como os candidatos já vêm
        restritos a um lado do balanço, qualquer escolha ali preserva a
        identidade - enquanto o branco gera `sem-destino`, que é Classe A e
        BLOQUEIA. A instrução trocava um erro revisável por um erro fatal.

    São métricas de CONTRATO, não de acurácia: nenhuma chamada de modelo aqui.
    """
    res = Resultado(dataset="contrato do prompt julgamental")
    from app.llm.prompts import SISTEMA_JULGAMENTAL
    from app.reading.demonstracao import PREFIXO_POR_FAMILIA

    declarados = sum(1 for p in PREFIXO_POR_FAMILIA.values()
                     if f"{p} =" in SISTEMA_JULGAMENTAL)
    res.metricas.append(Metrica(
        "prefixos de código gerado declarados no prompt", declarados,
        len(PREFIXO_POR_FAMILIA), maior_e_melhor=True,
        detalhe=" ".join(f"{f}={p}" for f, p in PREFIXO_POR_FAMILIA.items())))

    vies = sum(1 for frase in ("NA DÚVIDA, DEIXE EM BRANCO", "prefira o destino vazio")
               if frase in SISTEMA_JULGAMENTAL)
    res.metricas.append(Metrica(
        "instruções que induzem abstenção", vies, 0, maior_e_melhor=False,
        detalhe="abster-se converte Classe B em Classe A"))

    res.metricas.append(Metrica(
        "prompt avisa que o código é GERADO, não lido",
        1 if "GERADO" in SISTEMA_JULGAMENTAL else 0, 1, maior_e_melhor=True,
        detalhe="na publicada o código sai da árvore aritmética"))

    # O modelo local se abstinha de forma DETERMINÍSTICA em conta de nome genérico
    # ('Outros ativos', 'Arrendamento'): dois rounds de julgamento devolveram
    # `destino vazio` para as MESMAS 4 linhas, com a mesma contagem de tokens.
    # Sem instrução sobre a posição residual, a lista de candidatos podia conter a
    # resposta certa e ele ainda assim não a usava.
    res.metricas.append(Metrica(
        "prompt ensina a usar a posição residual do bloco",
        1 if "POSIÇÃO RESIDUAL" in SISTEMA_JULGAMENTAL else 0, 1,
        maior_e_melhor=True,
        detalhe="abstenção em nome genérico era determinística, não aleatória"))
    return res


def rodar_suites() -> Resultado:
    """Roda as suítes de teste e converte o resultado em métrica.

    Um harness de eval que ignora a suíte de testes mede a metade errada do
    problema: as propriedades algébricas (conservação, imunidade a julgamento)
    estão provadas lá, com o pipeline completo.
    """
    res = Resultado(dataset="suítes de teste")

    saida = subprocess.run(
        [sys.executable, "-X", "utf8", str(RAIZ / "server" / "run_tests.py")],
        capture_output=True, text=True, encoding="utf-8", cwd=RAIZ, timeout=900)
    texto = (saida.stdout or "") + (saida.stderr or "")
    falhou = 0
    for parte in texto.replace("·", " ").split():
        if parte.isdigit():
            continue
    import re
    if m := re.search(r"(\d+) passaram · (\d+) falharam", texto):
        passou, falhou = int(m.group(1)), int(m.group(2))
    else:
        res.erros.append("não consegui interpretar a saída de server/run_tests.py")
        passou = 0
    res.metricas.append(Metrica(
        "servidor: testes falhando", falhou, 0, maior_e_melhor=False,
        detalhe=f"{passou} passaram"))

    node = shutil.which("node") or r"C:\Program Files\nodejs\node.exe"
    if Path(node).exists() or shutil.which("node"):
        testes = sorted((RAIZ / "portal" / "test").glob("*.test.mjs"))
        saida = subprocess.run(
            [node, "--test", *[str(t) for t in testes]],
            capture_output=True, text=True, encoding="utf-8",
            cwd=RAIZ / "portal", timeout=900)
        texto = (saida.stdout or "") + (saida.stderr or "")
        p = int(m.group(1)) if (m := re.search(r"# pass (\d+)", texto)) else 0
        f = int(m.group(1)) if (m := re.search(r"# fail (\d+)", texto)) else 0
        if not p and not f:
            p = int(m.group(1)) if (m := re.search(r"pass (\d+)", texto)) else 0
            f = int(m.group(1)) if (m := re.search(r"fail (\d+)", texto)) else 0
        res.metricas.append(Metrica(
            "portal: testes falhando", f, 0, maior_e_melhor=False,
            detalhe=f"{p} passaram (inclui o invariante contábil)"))
    else:
        res.erros.append("Node não encontrado - suíte do portal não avaliada")

    return res


def validar_cobertura() -> Resultado:
    """gen_knowledge.py --check: cobertura das fórmulas em build time."""
    res = Resultado(dataset="cobertura das fórmulas")
    saida = subprocess.run(
        [sys.executable, "-X", "utf8", str(RAIZ / "scripts" / "gen_knowledge.py"),
         "--check"],
        capture_output=True, text=True, encoding="utf-8", cwd=RAIZ, timeout=300)
    res.metricas.append(Metrica(
        "56 posições em exatamente um total", 0 if saida.returncode == 0 else 1,
        0, maior_e_melhor=False,
        detalhe=(saida.stdout or "").strip().splitlines()[-1] if saida.stdout else ""))
    if saida.returncode != 0:
        res.erros.append((saida.stderr or saida.stdout or "").strip()[:400])
    return res


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true", help="saída em JSON")
    ap.add_argument("--sem-limiar", action="store_true",
                    help="mede sem bloquear (exploração)")
    ap.add_argument("--rapido", action="store_true",
                    help="pula as suítes de teste (só os datasets)")
    args = ap.parse_args()

    resultados: list[Resultado] = [validar_cobertura()]
    for caminho in sorted(DATASETS.glob("balancete_*.json")):
        resultados.append(avaliar_balancete(caminho))
    for caminho in sorted(DATASETS.glob("demonstracao_*.json")):
        resultados.append(avaliar_demonstracao(caminho))
    resultados.append(avaliar_contrato_llm())
    if not args.rapido:
        resultados.append(rodar_suites())

    if args.json:
        print(json.dumps({
            "ok": all(r.ok for r in resultados),
            "datasets": [
                {
                    "nome": r.dataset,
                    "ok": r.ok,
                    "erros": r.erros,
                    "metricas": [
                        {"nome": m.nome, "valor": m.valor, "limiar": m.limiar,
                         "ok": m.ok, "detalhe": m.detalhe}
                        for m in r.metricas
                    ],
                }
                for r in resultados
            ],
        }, ensure_ascii=False, indent=1))
    else:
        print(f"\n{'=' * 78}\nALLocator v2 - avaliação\n{'=' * 78}")
        for r in resultados:
            print(f"\n{CINZA}── {r.dataset}{RESET}")
            for m in r.metricas:
                print(m.linha())
            for e in r.erros:
                print(f"  {VERMELHO}ERRO{RESET}  {e}")

        falhas = [m for r in resultados for m in r.metricas if not m.ok]
        erros = [e for r in resultados for e in r.erros]
        print(f"\n{'=' * 78}")
        if falhas or erros:
            print(f"{VERMELHO}{len(falhas)} métrica(s) abaixo do limiar, "
                  f"{len(erros)} erro(s){RESET}")
            for m in falhas:
                print(f"  · {m.nome}: {m.valor:g} (limiar {m.limiar:g})")
        else:
            total = sum(len(r.metricas) for r in resultados)
            print(f"{VERDE}{total} métricas dentro do limiar{RESET}")

    if args.sem_limiar:
        return 0
    return 0 if all(r.ok for r in resultados) else 1


if __name__ == "__main__":
    sys.exit(main())
