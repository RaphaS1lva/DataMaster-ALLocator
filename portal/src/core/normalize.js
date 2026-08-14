// Normalização de texto e de números. Módulo puro: roda em browser e em Node.
//
// ATENÇÃO - CONTRATO CRÍTICO: `normalizeText` precisa ser byte a byte
// equivalente a:
//   · scripts/gen_knowledge.py                  (normalize_text)
//   · server/app/reading/page_classifier.py     (normalizar)
//   · server/app/db/schema.sql                  (dm_normalize)
//
// Divergência entre elas gera chaves diferentes para a MESMA conta, e o valor é
// silenciosamente descartado da Shadow - sem erro em lugar nenhum. Na v1 o
// trigger do Postgres normalizava com `lower(unaccent(...))` enquanto o cliente
// também removia pontuação: `"ICMS s/ vendas"` gerava duas chaves distintas,
// produzindo linhas duplicadas no dicionário e impedindo o seed de ser
// sobrescrito pelas regras aprendidas.
//
// A equivalência é VERIFICADA, não presumida: `server/tests/test_normalize_parity.py`
// executa ESTE arquivo com o Node e compara contra as implementações de Python
// sobre um corpus de 40 casos reais, mais uma tabela de referência escrita à mão
// e checagens de propriedade (idempotência, sem espaço duplo, só ASCII).

/**
 * lower + trim + NFKD sem acentos + tudo que não for [a-z0-9\s] vira espaço +
 * colapsa espaços.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeText(value) {
  let text = String(value ?? '').trim().toLowerCase();
  text = text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  text = text.replace(/[^a-z0-9\s]/g, ' ');
  return text.replace(/\s+/g, ' ').trim();
}

/** Conjunto de tokens não vazios do texto normalizado. */
export function tokenize(text) {
  return new Set(normalizeText(text).split(' ').filter(Boolean));
}

/** Índice de Jaccard entre os conjuntos de tokens de `a` e `b`. */
export function tokenOverlap(a, b) {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  const union = ta.size + tb.size - inter;
  return union ? inter / union : 0;
}

/**
 * Substring em qualquer ordem, com PISO DE TOKENS.
 *
 * O v1 usava `a.includes(b) || b.includes(a)` sem piso, e isso casava
 * cabeçalho de seção com totalizador: a entrada de dicionário
 * `origem: "Passivo não circulante"` casava com a linha
 * `"Total do passivo não circulante"` e duplicava o bloco PNC inteiro no
 * balanço. Exigir que o lado curto tenha pelo menos `minTokens` tokens e
 * represente uma fração relevante do lado longo elimina essa classe de erro
 * sem perder os casos legítimos (ex.: "Caixa e equivalentes de caixa" ⊃
 * "Caixa e equivalentes").
 *
 * @param {string} a texto normalizado
 * @param {string} b texto normalizado
 * @param {{minTokens?: number, minRatio?: number}} [opts]
 */
export function strongPartialMatch(a, b, opts = {}) {
  if (!a || !b) return false;
  if (a === b) return true;
  const minTokens = opts.minTokens ?? 2;
  const minRatio = opts.minRatio ?? 0.5;
  const [curto, longo] = a.length <= b.length ? [a, b] : [b, a];
  if (!longo.includes(curto)) return false;
  const nCurto = curto.split(' ').filter(Boolean).length;
  const nLongo = longo.split(' ').filter(Boolean).length;
  if (nCurto < minTokens) return false;
  return nCurto / nLongo >= minRatio;
}

/**
 * Pares de tokens que INVERTEM o sentido contábil de um nome de conta. Cada
 * conjunto é uma dimensão: dois tokens do mesmo conjunto no lugar um do outro
 * trocam receita por despesa, ativo por passivo, ou parcela por linha líquida.
 */
const POLARIDADES = [
  new Set(['receita', 'receitas', 'despesa', 'despesas']),
  new Set(['ativo', 'ativos', 'passivo', 'passivos']),
  new Set(['receber', 'pagar']),
  new Set(['ganho', 'ganhos', 'perda', 'perdas']),
  new Set(['credito', 'creditos', 'debito', 'debitos']),
  // `líquida` marca uma linha que JÁ compensou duas parcelas. Casar uma parcela
  // com ela é dupla contagem ou inversão - foi exatamente o caso do Fleury.
  // `bruta` NÃO entra: `Receita` ⊂ `Receita bruta de vendas` é variação benigna
  // de grafia e bloquear isso só geraria trabalho manual sem ganho de segurança.
  new Set(['liquida', 'liquidas', 'liquido', 'liquidos']),
];

/**
 * INVERSÃO de polaridade: cada lado tem, na MESMA dimensão, um marcador que o
 * outro não tem. É a troca de sentido propriamente dita,
 * `outras receitas operacionais líquidas` × `outras despesas operacionais
 * líquidas` compartilham 3 de 4 tokens e passam folgado no piso de Jaccard
 * (0,60), mas uma é receita e a outra é despesa.
 *
 * Exige os DOIS lados de propósito. Exigir só um lado bloquearia sinônimo
 * legítimo: `IRPJ e CSLL a recolher` × `IRPJ e CSLL a pagar` casa em 0,67 e é o
 * mesmo passivo - `recolher` e `pagar` não se opõem, e a dimensão só aparece num
 * dos lados.
 *
 * @param {string} a texto (normalizado ou não)
 * @param {string} b texto (normalizado ou não)
 */
export function polaridadeInverte(a, b) {
  const ta = tokenize(a);
  const tb = tokenize(b);
  for (const dim of POLARIDADES) {
    const soEmA = [...ta].some((t) => dim.has(t) && !tb.has(t));
    const soEmB = [...tb].some((t) => dim.has(t) && !ta.has(t));
    if (soEmA && soEmB) return true;
  }
  return false;
}

/**
 * O nome MAIOR acrescenta um marcador de polaridade que o menor não tem.
 *
 * Só faz sentido quando o match veio por CONTINÊNCIA (`strongPartialMatch`): o
 * nome curto está literalmente dentro do longo, então são exatamente os tokens
 * excedentes que mudam o significado. Se um deles é marcador de polaridade, o
 * nome longo é outra coisa - tipicamente uma linha LÍQUIDA que já compensou duas
 * parcelas, e o curto é só uma das parcelas.
 *
 * EXISTE POR UM ERRO REAL, e do pior tipo - silencioso. `Despesas financeiras`
 * do ITR do Fleury foi para `+ Receitas Financeiras` com selo `Dicionário` e
 * confiança 0,9: a entrada `Receitas despesas financeiras líquidas` CONTÉM a
 * substring `despesas financeiras` e a razão de tokens dá exatamente 2/4 = 0,50,
 * que é o piso `minRatio`. Uma DESPESA foi para uma posição de RECEITA.
 *
 * Só não entrou no balanço porque aquele documento publica despesa com sinal
 * negativo e o guardrail de sinal disparou. Com despesa positiva - que é comum,
 * R$ 348.334 virariam receita sem erro em lugar nenhum.
 *
 * Subir o `minRatio` não resolveria: `Caixa e equivalentes` ⊂ `Caixa e
 * equivalentes de caixa` vive em 0,60 e é match legítimo. O problema nunca foi a
 * fração de tokens, é QUAL token está sobrando.
 *
 * @param {string} a texto (normalizado ou não)
 * @param {string} b texto (normalizado ou não)
 */
export function polaridadeAcrescenta(a, b) {
  const ta = tokenize(a);
  const tb = tokenize(b);
  const [menor, maior] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  for (const dim of POLARIDADES) {
    for (const t of maior) {
      if (dim.has(t) && !menor.has(t)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Números
// ---------------------------------------------------------------------------
const RE_MILHAR_BR = /^\d{1,3}(\.\d{3})+$/;

/**
 * Interpreta um número contábil e informa SE conseguiu.
 *
 * Diferença em relação ao v1: lá `coerceNumber` devolvia a string original
 * quando não conseguia parsear, e um `valorAno()` mais adiante a transformava
 * em `null`. O valor era descartado sem nenhum aviso - e como nunca entrava na
 * soma de origem, a trilha de conservação também não o veria. Aqui a falha é
 * explícita e o chamador é obrigado a decidir o que fazer com ela.
 *
 * Formatos aceitos: `1.234.567,89` (BR), `1,234,567.89` (US), `1.000`,
 * `(1.234,56)` = negativo, `R$ 1.000`, `1.234,56-` (sinal à direita, comum em
 * exportação de ERP), `-` isolado = vazio.
 *
 * @param {unknown} value
 * @returns {{ok: boolean, value: number|null, vazio: boolean, raw: string}}
 */
export function parseNumber(value) {
  const raw = value === null || value === undefined ? '' : String(value);
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? { ok: true, value, vazio: false, raw }
      : { ok: false, value: null, vazio: false, raw };
  }
  if (typeof value === 'boolean') return { ok: false, value: null, vazio: false, raw };

  let t = raw.trim();
  if (t === '') return { ok: true, value: null, vazio: true, raw };
  // traço/travessão isolado = célula sem valor (NÃO é zero)
  if (/^[-–—]$/.test(t)) return { ok: true, value: null, vazio: true, raw };

  let neg = false;
  t = t.replace(/R\$/gi, '').replace(/\$/g, '').replace(/\s|\u00a0|\u2009/g, '');
  if (t.startsWith('(') && t.endsWith(')')) { neg = true; t = t.slice(1, -1); }
  // sinal à direita: "1.234,56-" (SAP/Protheus/Totvs em alguns relatórios)
  if (/[-–—]$/.test(t)) { neg = true; t = t.slice(0, -1); }
  if (t.startsWith('-')) { neg = true; t = t.slice(1); }
  if (t.startsWith('+')) t = t.slice(1);
  if (t === '') return { ok: true, value: null, vazio: true, raw };

  const temVirgula = t.includes(',');
  const temPonto = t.includes('.');
  if (temVirgula && temPonto) {
    t = t.lastIndexOf(',') > t.lastIndexOf('.')
      ? t.replace(/\./g, '').replace(',', '.') // BR
      : t.replace(/,/g, ''); // US
  } else if (temVirgula) {
    t = t.replace(',', '.');
  } else if (temPonto && RE_MILHAR_BR.test(t)) {
    t = t.replace(/\./g, '');
  }

  if (!/^\d*\.?\d+$/.test(t)) return { ok: false, value: null, vazio: false, raw };
  const n = Number(t);
  if (!Number.isFinite(n)) return { ok: false, value: null, vazio: false, raw };
  return { ok: true, value: neg ? -n : n, vazio: false, raw };
}

/**
 * Versão simples: número ou `null`. NUNCA devolve a string original,
 * ao contrário do v1, um valor ilegível não se disfarça de dado.
 */
export function coerceNumber(value) {
  return parseNumber(value).value;
}

/** Número seguro para aritmética: vazio/ilegível vira 0. */
export function num(value) {
  const n = parseNumber(value).value;
  return n === null ? 0 : n;
}

/** Arredonda para 2 casas evitando o erro de ponto flutuante binário. */
export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}
