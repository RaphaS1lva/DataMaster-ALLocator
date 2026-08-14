"""
Adaptador de BALANCETE - detecção de layout de relatório de ERP.

Um balancete de verificação não é um Balanço Patrimonial publicado. Ele tem três
características que exigem tratamento próprio, e ignorá-las foi o que produziu
R$ 151 milhões de erro no caso real (`Balancete SPE (exemplo) 05.2026`, TOTVS
Protheus, relatório CTBR040):

1. TODOS OS VALORES SÃO POSITIVOS. A natureza (devedora/credora) vive em colunas
   de TEXTO separadas - uma por coluna de valor, imediatamente à direita dela:

       Conta | Descrição | Saldo Anterior | D/C* | Débito | Crédito | Mov Período | D/C** | Saldo Atual | D/C***

   Somar os módulos infla o Ativo em R$ 26.534.262,98 e o Passivo em
   R$ 124.618.951,48, porque 24 contas têm natureza CONTRÁRIA ao próprio grupo
   (amortização acumulada, PCLD, juros de debêntures, prejuízos acumulados).
   E multiplicar o grupo por -1 não resolve: o erro é intra-grupo.

2. A HIERARQUIA VEM DO CÓDIGO, não da indentação. E os códigos podem não ter
   separador: `11010100000071`. A regra que funciona é "uma conta é sintética se
   existe outra cujo código a tem como PREFIXO ESTRITO" - ver
   `portal/src/core/hierarchy.js`, que implementa o lado JS da mesma regra.

3. AS CONTAS ANALÍTICAS E SINTÉTICAS VÊM MISTURADAS. O parâmetro de emissão
   `Imprime Contas = Ambas` traz os dois. Tratar as 358 linhas como analíticas
   multiplica o balanço por ~3 (Ativo de 118 MM viraria ~382 MM).

Este módulo NÃO decide sinal nem hierarquia: ele apenas identifica o layout e
devolve as linhas com `naturezaPorSlot` preenchido, para o núcleo contábil (que
já é testado contra este mesmo arquivo) fazer o resto.
"""
from __future__ import annotations

import logging
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Iterable, Sequence

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Reconhecimento de cabeçalho
# ---------------------------------------------------------------------------
# Rótulos de coluna de NATUREZA. Cobrimos as variações que os ERPs usam:
# Protheus emite "D/C", "D/C*", "D/C**"; outros usam "Natureza", "D ou C", "Nat".
_RE_NATUREZA = re.compile(r"^(d\s*/?\s*c|nat(ureza)?|d\s+ou\s+c|dc)\**$")

# Rótulos de coluna de VALOR que nos interessam. `Débito`/`Crédito` são
# MOVIMENTO do período (não saldo) e não têm coluna D/C própria - entram como
# informativos, nunca como saldo.
_ROTULOS_SALDO = {
    "saldo anterior": "Saldo Anterior",
    "saldo inicial": "Saldo Anterior",
    "saldo ant": "Saldo Anterior",
    "anterior": "Saldo Anterior",
    "mov periodo": "Mov Periodo",
    "movimento": "Mov Periodo",
    "mov do periodo": "Mov Periodo",
    "saldo atual": "Saldo Atual",
    "saldo final": "Saldo Atual",
    "atual": "Saldo Atual",
    "saldo": "Saldo Atual",
}
_ROTULOS_MOVIMENTO = {"debito": "Débito", "credito": "Crédito"}
_ROTULOS_CODIGO = {"conta", "codigo", "cod", "classificacao", "conta contabil",
                   "reduzida", "conta reduzida", "cta"}
_ROTULOS_DESCRICAO = {"descricao", "nome", "historico", "conta descricao",
                      "titulo", "descricao da conta"}


def normalizar(valor: Any) -> str:
    """Mesma normalização de `portal/src/core/normalize.js` (normalizeText)."""
    txt = str(valor if valor is not None else "").strip().lower()
    txt = unicodedata.normalize("NFKD", txt)
    txt = "".join(c for c in txt if not unicodedata.combining(c))
    txt = re.sub(r"[^a-z0-9\s]", " ", txt)
    return re.sub(r"\s+", " ", txt).strip()


@dataclass
class ColunaBalancete:
    """Uma coluna de valor e a coluna de natureza que a acompanha (se houver)."""

    indice: int
    rotulo: str
    indice_natureza: int | None = None
    eh_saldo: bool = True


@dataclass
class LayoutBalancete:
    indice_codigo: int | None
    indice_descricao: int | None
    colunas: list[ColunaBalancete] = field(default_factory=list)
    linha_cabecalho: int = 0
    confianca: float = 0.0
    evidencias: list[str] = field(default_factory=list)

    @property
    def saldos_absolutos(self) -> bool:
        """True quando ao menos uma coluna de valor tem coluna D/C própria.

        É o gatilho que faz o núcleo tratar os valores como MÓDULO e buscar o
        sinal na natureza da linha.
        """
        return any(c.indice_natureza is not None for c in self.colunas)


def detectar_layout(tabela: Sequence[Sequence[Any]],
                    max_linhas_busca: int = 12) -> LayoutBalancete | None:
    """Acha o cabeçalho e emparelha cada coluna de valor com sua coluna D/C.

    O emparelhamento é POSICIONAL: a coluna de natureza pertence à coluna de
    valor imediatamente à sua ESQUERDA. Não dá para emparelhar pelo nome, porque
    os rótulos são todos iguais a menos de asteriscos (`D/C*`, `D/C**`, `D/C***`)
 - e a quantidade de asteriscos não é padronizada entre versões do relatório.
    """
    for i, linha in enumerate(tabela[:max_linhas_busca]):
        celulas = [normalizar(c) for c in linha]
        if not any(celulas):
            continue

        idx_codigo = next(
            (j for j, c in enumerate(celulas) if c in _ROTULOS_CODIGO), None)
        idx_descricao = next(
            (j for j, c in enumerate(celulas) if c in _ROTULOS_DESCRICAO), None)

        colunas: list[ColunaBalancete] = []
        for j, c in enumerate(celulas):
            if not c:
                continue
            if c in _ROTULOS_SALDO:
                colunas.append(ColunaBalancete(j, _ROTULOS_SALDO[c], eh_saldo=True))
            elif c in _ROTULOS_MOVIMENTO:
                colunas.append(ColunaBalancete(j, _ROTULOS_MOVIMENTO[c], eh_saldo=False))

        if not colunas:
            continue

        # emparelha D/C -> coluna de valor imediatamente à esquerda
        por_indice = {c.indice: c for c in colunas}
        for j, c in enumerate(celulas):
            if not _RE_NATUREZA.match(c):
                continue
            for k in range(j - 1, -1, -1):
                if k in por_indice:
                    por_indice[k].indice_natureza = j
                    break

        saldos = [c for c in colunas if c.eh_saldo]
        if not saldos:
            continue

        com_natureza = sum(1 for c in saldos if c.indice_natureza is not None)
        confianca = 0.0
        evid: list[str] = []
        if idx_codigo is not None:
            confianca += 0.25
            evid.append(f"coluna de código em {idx_codigo}")
        if idx_descricao is not None:
            confianca += 0.2
            evid.append(f"coluna de descrição em {idx_descricao}")
        confianca += min(0.3, 0.1 * len(saldos))
        evid.append(f"{len(saldos)} coluna(s) de saldo: "
                    + ", ".join(c.rotulo for c in saldos))
        if com_natureza:
            confianca += 0.25
            evid.append(f"{com_natureza} coluna(s) D/C emparelhada(s) - "
                        "saldos em módulo, sinal vem da natureza")

        return LayoutBalancete(
            indice_codigo=idx_codigo,
            indice_descricao=idx_descricao,
            colunas=colunas,
            linha_cabecalho=i,
            confianca=round(min(1.0, confianca), 3),
            evidencias=evid,
        )
    return None


# ---------------------------------------------------------------------------
# Montagem das linhas
# ---------------------------------------------------------------------------
_RE_SO_DIGITOS = re.compile(r"\D")


def _codigo_texto(valor: Any) -> str:
    """Código como TEXTO, preservando zeros à esquerda.

    Num .xlsx o código costuma chegar como float/int (`11010100000071.0`), e
    `str()` direto produziria notação científica ou um `.0` no fim - que quebra a
    comparação de prefixo da hierarquia.
    """
    if valor is None:
        return ""
    if isinstance(valor, bool):
        return ""
    if isinstance(valor, float) and valor.is_integer():
        return str(int(valor))
    if isinstance(valor, int):
        return str(valor)
    return str(valor).strip()


def montar_linhas(tabela: Sequence[Sequence[Any]],
                  layout: LayoutBalancete) -> list[dict[str, Any]]:
    """Converte a tabela crua em linhas no formato que o núcleo contábil espera.

    Devolve dicts com `codigo`, `origem`, `valoresPorSlot` e `naturezaPorSlot`.
    NÃO decide sinal, hierarquia ou destino - isso é do núcleo, que já é testado
    contra este mesmo arquivo.
    """
    saldos = [c for c in layout.colunas if c.eh_saldo]
    linhas: list[dict[str, Any]] = []

    for bruta in tabela[layout.linha_cabecalho + 1:]:
        if not bruta:
            continue

        def celula(j: int | None) -> Any:
            return bruta[j] if j is not None and j < len(bruta) else None

        codigo = _codigo_texto(celula(layout.indice_codigo))
        descricao = str(celula(layout.indice_descricao) or "").strip()
        if not descricao:
            continue
        # linha de rodapé/assinatura do relatório: tem descrição mas nenhum valor
        # e nenhum código
        if not codigo and not any(
                celula(c.indice) is not None for c in saldos):
            continue

        valores: dict[str, Any] = {}
        natureza: dict[str, str] = {}
        for c in saldos:
            v = celula(c.indice)
            if v is None or (isinstance(v, str) and not v.strip()):
                continue
            valores[c.rotulo] = v
            nat = str(celula(c.indice_natureza) or "").strip()
            if nat:
                natureza[c.rotulo] = nat

        if not valores:
            continue

        linhas.append({
            "codigo": codigo,
            "origem": descricao,
            "valoresPorSlot": valores,
            "naturezaPorSlot": natureza,
        })

    return linhas


# ---------------------------------------------------------------------------
# Hierarquia por prefixo - porte fiel de portal/src/core/hierarchy.js
# ---------------------------------------------------------------------------
def classificar_folhas(codigos: Iterable[str]) -> dict[str, bool]:
    """`codigo -> eh_folha`. Folha = nenhum outro código a tem como prefixo estrito.

    Por que não as alternativas óbvias, medido no arquivo real:

      · "existe outro código começando com <codigo> + '.'"  -> 0 sintéticas,
        porque os códigos do Protheus não têm ponto. As 358 linhas seriam
        somadas juntas e o Ativo iria de 118 MM para ~382 MM.
      · "pai = código truncado no nível anterior"           -> 116 falsos órfãos,
        porque faltam níveis: existe `110101` e `11010100000071`, mas NÃO
        `11010100`.
      · "folha = comprimento máximo"                        -> funciona por acaso
        neste arquivo (14 dígitos) e quebra em plano de profundidade irregular.
    """
    limpos = [_RE_SO_DIGITOS.sub("", c) for c in codigos]
    presentes = {c for c in limpos if c}
    return {
        c: not any(o != c and o.startswith(c) for o in presentes)
        for c in presentes
    }


def verificar_sinteticas(linhas: Sequence[dict[str, Any]],
                         colunas: Sequence[str],
                         valor_assinado) -> dict[str, Any]:
    """Confere cada sintética contra a soma das suas folhas descendentes.

    É a VERIFICAÇÃO DE LEITURA: se o documento não fecha consigo mesmo, o erro é
    de leitura e fica localizado num bloco, não espalhado pela alocação. No
    arquivo real são 134 sintéticas x 5 colunas = 670 assertivas, e passam todas
    quando a natureza D/C é aplicada - contra 72 divergências quando não é.

    `valor_assinado(linha, coluna) -> float | None`
    """
    folha_de = classificar_folhas(l.get("codigo", "") for l in linhas)
    folhas = [l for l in linhas
              if folha_de.get(_RE_SO_DIGITOS.sub("", l.get("codigo", "")), False)]
    sinteticas = [l for l in linhas
                  if not folha_de.get(_RE_SO_DIGITOS.sub("", l.get("codigo", "")), True)]

    divergencias: list[dict[str, Any]] = []
    testes = 0
    for s in sinteticas:
        pref = _RE_SO_DIGITOS.sub("", s.get("codigo", ""))
        if not pref:
            continue
        desc = [f for f in folhas
                if (c := _RE_SO_DIGITOS.sub("", f.get("codigo", "")))
                and len(c) > len(pref) and c.startswith(pref)]
        if not desc:
            continue
        for col in colunas:
            declarado = valor_assinado(s, col)
            if declarado is None:
                continue
            testes += 1
            somado = sum(valor_assinado(f, col) or 0.0 for f in desc)
            tol = max(0.05, abs(declarado) * 0.0005)
            if abs(somado - declarado) > tol:
                divergencias.append({
                    "codigo": pref, "origem": s.get("origem"), "coluna": col,
                    "declarado": round(declarado, 2),
                    "somaFolhas": round(somado, 2),
                    "diferenca": round(somado - declarado, 2),
                    "nFolhas": len(desc),
                })

    return {
        "ok": not divergencias,
        "testes": testes,
        "folhas": len(folhas),
        "sinteticas": len(sinteticas),
        "divergencias": divergencias,
    }


def eh_balancete(layout: LayoutBalancete | None,
                 linhas: Sequence[dict[str, Any]]) -> tuple[bool, list[str]]:
    """Decide se a tabela é um balancete, com as evidências.

    Critérios ESTRUTURAIS (não semânticos, para não depender de rótulo):
      · layout com coluna de código e ao menos uma de saldo
      · maioria das linhas com código numérico
      · hierarquia por prefixo produz sintéticas E folhas (um plano de contas de
        verdade tem os dois níveis)
    """
    if layout is None:
        return False, ["cabeçalho de balancete não reconhecido"]
    evid = list(layout.evidencias)
    if layout.indice_codigo is None:
        return False, evid + ["sem coluna de código contábil"]

    com_codigo = sum(1 for l in linhas if _RE_SO_DIGITOS.sub("", l.get("codigo", "")))
    if not linhas or com_codigo / len(linhas) < 0.7:
        return False, evid + [
            f"só {com_codigo}/{len(linhas)} linhas têm código numérico"]

    folha_de = classificar_folhas(l.get("codigo", "") for l in linhas)
    n_folhas = sum(1 for v in folha_de.values() if v)
    n_sint = sum(1 for v in folha_de.values() if not v)
    if not n_sint:
        return False, evid + ["nenhuma conta sintética - não parece plano de contas"]

    evid.append(f"hierarquia por prefixo: {n_folhas} analíticas, {n_sint} sintéticas")
    return True, evid


def ler_balancete(tabela: Sequence[Sequence[Any]]) -> dict[str, Any]:
    """Ponto de entrada. Devolve linhas + metadados prontos para o pipeline."""
    layout = detectar_layout(tabela)
    if layout is None:
        return {"eh_balancete": False, "motivo": "cabeçalho não reconhecido",
                "linhas": [], "evidencias": []}

    linhas = montar_linhas(tabela, layout)
    ok, evid = eh_balancete(layout, linhas)
    folha_de = classificar_folhas(l.get("codigo", "") for l in linhas)

    log.info("balancete: %s linhas, layout confiança %.2f, saldos_absolutos=%s",
             len(linhas), layout.confianca, layout.saldos_absolutos)

    return {
        "eh_balancete": ok,
        "motivo": "" if ok else "; ".join(evid),
        "linhas": linhas,
        "colunas": [c.rotulo for c in layout.colunas if c.eh_saldo],
        "saldosAbsolutos": layout.saldos_absolutos,
        "confianca": layout.confianca,
        "evidencias": evid,
        "folhas": sum(1 for v in folha_de.values() if v),
        "sinteticas": sum(1 for v in folha_de.values() if not v),
    }
