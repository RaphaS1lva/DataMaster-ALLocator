// Shadow: agrega as alocações (substitui os SUMIFS do template) e avalia o
// grafo de subtotais.
//
// Três diferenças em relação ao v1:
//
// 1. AGREGA POR `aggKey` NORMALIZADA. O v1 usava a chave com `trim()` apenas e
//    `Map.get()` exato, então qualquer divergência de caixa/acento fazia o
//    valor virar 0. Em Excel o SUMIFS é case-insensitive - era por isso que a
//    planilha fechava e o port em JS não.
//
// 2. REPORTA ÓRFÃOS. Todo bucket cuja chave não corresponde a nenhuma posição
//    do grafo é devolvido em `orphans[]`, com valor e origens. No v1 esse
//    dinheiro simplesmente não aparecia em lugar nenhum.
//
// 3. TOTAIS PARA A IDENTIDADE ESTENDIDA. Além de Ativo e Passivo+PL, expõe
//    Receitas e Despesas somadas a partir das posições da DRE, para distinguir
//    "balanço errado" de "balancete não encerrado".
//
// Removido: o mecanismo `Retirar/Adicionar/inversor` herdado das colunas J:Q do
// template Excel. No v1 era código morto (`opts.adjustments` nunca era
// passado), e isso foi uma sorte: aquelas colunas permitem adicionar um valor a
// uma linha sem retirá-lo de outra, ou seja, VIOLAM a conservação de valor por
// construção - não há trava exigindo Retirar antes de Adicionar. No v2 o
// ajuste é feito mutando a própria linha (trocar destino, marcar como
// contexto), o que mantém a conservação. Ver docs/02-invariante-contabil.md.

import { SHADOW_COMPUTE } from './data/shadowCompute.gen.js';
import { aggKey, partesDaChave } from './keys.js';
import { num, round2 } from './normalize.js';
import { resolveDestinoAlocavel } from './planoContas.js';
import { contribuicaoNoTemplate } from './sign.js';
import { ANOS, trilhaDeValor, avaliarIdentidade } from './invariants.js';

const LINHA_DRE_LUCRO_LIQUIDO = 35;

// Linhas-chave do template (ver knowledge/formulas-shadow.md)
export const LINHA = {
  TOTAL_ATIVO: 41,
  TOTAL_PASSIVO: 72,          // = 61 + 71 (Circulante + Não Circulante), SEM PL
  PATRIMONIO_LIQUIDO: 79,     // = 76 + 77 + 78, SEM minoritários
  RECURSOS_PROPRIOS: 80,      // = 75 + 79, COM minoritários
  DRE_VENDAS_TOTAIS: 5,
  DRE_LUCRO_LIQUIDO: 35,
};

/** aggKeys que a Shadow sabe agregar (uma por posição `agg` do grafo). */
export const CHAVES_DO_TEMPLATE = new Set(
  [...SHADOW_COMPUTE.AP, ...SHADOW_COMPUTE.DRE]
    .filter((s) => s.kind === 'agg')
    .map((s) => aggKey(s.destino, s.grupo, s.subCategoria)),
);

/** Linhas `agg` alcançadas ao avaliar `raiz` num lado do grafo. */
function alcancaveisDe(spec, raiz) {
  const porRow = new Map(spec.map((s) => [s.row, s]));
  const vistos = new Set();
  const agg = new Set();
  (function anda(row) {
    if (vistos.has(row)) return;
    vistos.add(row);
    const s = porRow.get(row);
    if (!s) return;
    if (s.kind === 'agg') { agg.add(row); return; }
    for (const t of s.terms || []) for (const r of t.rows) anda(r);
  }(raiz));
  return agg;
}

/**
 * Posições da DRE que NÃO alcançam a linha 35 (`Lucro Liquido`).
 *
 * Descoberta ao construir o teste do invariante: 6 das 23 posições alocáveis da
 * DRE ficam fora da cadeia do resultado, por dois motivos distintos,
 *
 * ADD-BACK do EBITDA (a linha 18 é `EBITDA = +15 +16 +17 −14`): a depreciação
 * já está dentro das despesas que compõem o EBIT (linha 15), e estas posições
 * existem para DIVULGAR quanto dela era depreciação/aluguel, permitindo somar
 * de volta:
 *   16  `- Depreciação e amortização (imob e intang)`
 *   17  `- Depreciação/Amortização dos Arrendamentos Op.`
 *   19  `- Despesas/Custo de Aluguel`
 *
 * ABAIXO DA LINHA DO LUCRO LÍQUIDO (distribuição e resultado abrangente, que
 * por definição vêm depois do resultado):
 *   36  `+/- Resultados Abrangentes`   (só entra na linha 37)
 *   39  `- Dividendos`
 *   40  `+/- Participações Minoritárias`
 *
 * Consequência prática comum às duas: um valor alocado só nelas NÃO chega ao
 * resultado do período. Não é bug do template - é o desenho dele. Mas é
 * invisível, então a trilha de valor mostra esse balde separadamente e a
 * mensagem de diferença cita ele como provável origem do resíduo.
 */
export const POSICOES_MEMO_DRE = (() => {
  const noResultado = alcancaveisDe(SHADOW_COMPUTE.DRE, LINHA_DRE_LUCRO_LIQUIDO);
  return new Set(SHADOW_COMPUTE.DRE
    .filter((s) => s.kind === 'agg' && !noResultado.has(s.row))
    .map((s) => aggKey(s.destino, s.grupo, s.subCategoria)));
})();

/**
 * Agrega as linhas alocadas por chave de destino.
 *
 * O destino é RESOLVIDO antes de compor a chave: assim uma linha gravada como
 * "Mútuo Financeiro L/P" agrega no bucket de "Mútuo Financeiro LP". No v1 a
 * chave era montada com a grafia crua e o bucket nunca era encontrado.
 */
export function aggregateAllocations(rastRows) {
  const buckets = new Map();
  for (const r of rastRows || []) {
    if (r.alocacaoHierarquia !== 'Sim') continue;
    const nome = String(r.destino ?? '').trim();
    if (!nome) continue;

    const res = resolveDestinoAlocavel(nome, r.grupo, r.subCategoria);
    const chave = res.ok
      ? aggKey(res.conta.destino, res.conta.grupo, res.conta.subCategoria)
      : aggKey(nome, r.grupo, r.subCategoria);

    if (!buckets.has(chave)) {
      buckets.set(chave, {
        ano1: 0, ano2: 0, ano3: 0, chaves: [], origens: [], ids: [], resolvido: res.ok,
      });
    }
    const b = buckets.get(chave);
    for (const a of ANOS) b[a] += num(r[a]);
    if (r.chave) b.chaves.push(r.chave);
    b.origens.push(r.origem);
    b.ids.push(r.id);
  }
  return buckets;
}

/** Avaliador memoizado do grafo de subtotais de um lado (AP ou DRE). */
function construirResolvedor(spec, buckets) {
  const porRow = new Map(spec.map((s) => [s.row, s]));
  const memo = new Map();
  const emCurso = new Set();

  function evalRow(row, ano) {
    const ck = `${row}|${ano}`;
    if (memo.has(ck)) return memo.get(ck);
    const s = porRow.get(row);
    if (!s) { memo.set(ck, 0); return 0; }
    if (emCurso.has(row)) return 0; // proteção contra ciclo (o gerador já barra)

    let val = 0;
    if (s.kind === 'agg') {
      const b = buckets.get(aggKey(s.destino, s.grupo, s.subCategoria));
      val = b ? num(b[ano]) : 0;
    } else {
      emCurso.add(row);
      for (const termo of s.terms || []) {
        let soma = 0;
        for (const rr of termo.rows) soma += evalRow(rr, ano);
        val += (termo.sign || 1) * soma;
      }
      emCurso.delete(row);
    }
    memo.set(ck, val);
    return val;
  }
  return { porRow, evalRow };
}

/**
 * Calcula a Shadow inteira.
 *
 * @param {Array} rastRows linhas finalizadas (ano1..3, destino, grupo, sub, alocação)
 * @returns {{ativoPassivo:Array, dre:Array, totals:object, balance:object,
 *            orphans:Array, trilha:object}}
 */
export function computeShadow(rastRows) {
  const buckets = aggregateAllocations(rastRows);
  const ap = construirResolvedor(SHADOW_COMPUTE.AP, buckets);
  const dre = construirResolvedor(SHADOW_COMPUTE.DRE, buckets);

  const moldar = (spec, res, isDre) => spec.map((s) => {
    const b = s.kind === 'agg'
      ? buckets.get(aggKey(s.destino, s.grupo, s.subCategoria)) : null;
    return {
      row: s.row,
      destino: s.destino,
      grupo: s.grupo || (isDre ? 'DRE' : ''),
      subCategoria: s.subCategoria || (isDre ? 'DRE' : ''),
      tipo: s.kind === 'agg' ? 'conta' : 'subtotal',
      sign: s.sign || 'none',
      ano1: round2(res.evalRow(s.row, 'ano1')),
      ano2: round2(res.evalRow(s.row, 'ano2')),
      ano3: round2(res.evalRow(s.row, 'ano3')),
      memoriaAtual: b ? b.chaves.slice() : [],
      origens: b ? b.origens.slice() : [],
      origemIds: b ? b.ids.slice() : [],
    };
  });

  const ativoPassivo = moldar(SHADOW_COMPUTE.AP, ap, false);
  const dreLinhas = moldar(SHADOW_COMPUTE.DRE, dre, true);

  // ÓRFÃOS: buckets cuja chave não existe no grafo. Este dinheiro foi alocado
  // pelo usuário/LLM e não chegou a nenhuma posição - no v1 era invisível.
  const orphans = [];
  for (const [chave, b] of buckets) {
    if (CHAVES_DO_TEMPLATE.has(chave)) continue;
    if (ANOS.every((a) => Math.abs(num(b[a])) < 0.005)) continue; // zerado: inofensivo
    const { destino, grupo, subCategoria } = partesDaChave(chave);
    orphans.push({
      chave, destino, grupo, subCategoria,
      ano1: round2(b.ano1), ano2: round2(b.ano2), ano3: round2(b.ano3),
      origens: b.origens.slice(), origemIds: b.ids.slice(),
    });
  }
  orphans.sort((a, b) => Math.abs(b.ano3 || b.ano2 || b.ano1) - Math.abs(a.ano3 || a.ano2 || a.ano1));

  // Totais por ano
  const totals = {};
  for (const a of ANOS) {
    totals[a] = {
      totalAtivo: round2(ap.evalRow(LINHA.TOTAL_ATIVO, a)),
      totalPassivo: round2(ap.evalRow(LINHA.TOTAL_PASSIVO, a)),
      patrimonioLiquido: round2(ap.evalRow(LINHA.PATRIMONIO_LIQUIDO, a)),
      recursosProprios: round2(ap.evalRow(LINHA.RECURSOS_PROPRIOS, a)),
      lucroLiquido: round2(dre.evalRow(LINHA.DRE_LUCRO_LIQUIDO, a)),
      vendasTotais: round2(dre.evalRow(LINHA.DRE_VENDAS_TOTAIS, a)),
    };
  }

  // Receitas e despesas - INFORMATIVAS (para KPI). Usam a contribuição de cada
  // posição da DRE ao lucro: positiva é receita, negativa é despesa. Não
  // alimentam a identidade, justamente para não existir uma segunda
  // implementação do resultado capaz de divergir da do template.
  const receitas = {}; const despesas = {};
  for (const a of ANOS) {
    let rec = 0; let desp = 0;
    for (const l of dreLinhas) {
      if (l.tipo !== 'conta') continue;
      const c = num(contribuicaoNoTemplate(l[a], l.destino));
      if (c >= 0) rec += c; else desp += -c;
    }
    receitas[a] = round2(rec);
    despesas[a] = round2(desp);
  }

  // O RESULTADO vem da linha 35 (`Lucro Liquido`) do próprio template, que já
  // encadeia toda a aritmética da DRE. Recalculá-lo em paralelo criaria uma
  // segunda fonte de verdade capaz de divergir - foi assim que eu mesmo
  // introduzi um erro de 1.280.210,06 na primeira versão deste módulo.
  const balance = avaliarIdentidade({
    ativo: Object.fromEntries(ANOS.map((a) => [a, totals[a].totalAtivo])),
    passivoPl: Object.fromEntries(ANOS.map(
      (a) => [a, round2(totals[a].totalPassivo + totals[a].recursosProprios)])),
    resultado: Object.fromEntries(ANOS.map((a) => [a, totals[a].lucroLiquido])),
    receitas,
    despesas,
  });

  const trilha = trilhaDeValor(rastRows, buckets, CHAVES_DO_TEMPLATE, POSICOES_MEMO_DRE);

  return { ativoPassivo, dre: dreLinhas, totals, balance, orphans, trilha, buckets };
}
