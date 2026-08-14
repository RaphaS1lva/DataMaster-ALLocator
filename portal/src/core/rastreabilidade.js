// Rastreabilidade: monta as 14 colunas da aba de auditoria, alinhando os
// períodos nos 3 slots (Ano 1/2/3) com o mais recente em Ano 3.

import { parseNumber, round2 } from './normalize.js';
import { chaveOrigem, chaveDestino } from './keys.js';
import { normalizeAlocacao, hierarquiaDisplay } from './hierarchy.js';
import { groupSubOrder, destinationOrder } from './planoContas.js';

/**
 * Chave de ordenação cronológica de um rótulo de período.
 *
 * Precisa lidar com rótulos compostos como `"Consolidado 31/03/2026"` e
 * `"30/04/2026 Orçado"`. Um `parseInt` simples falha nesses casos e cai num
 * fallback de string que ordena "31/12/2025" antes de "31/03/2026" (porque
 * "12" > "03" alfabeticamente), quebrando a regra "Ano 3 = mais recente".
 */
export function yearKey(y) {
  const s = String(y).trim();
  if (/^\d{4}$/.test(s)) return [0, parseInt(s, 10) * 10000];
  const dmy = s.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (dmy) return [0, +dmy[3] * 10000 + +dmy[2] * 100 + +dmy[1]];
  const ymd = s.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (ymd) return [0, +ymd[1] * 10000 + +ymd[2] * 100 + +ymd[3]];
  const mmyyyy = s.match(/\b(\d{1,2})\/(\d{4})\b/);
  if (mmyyyy) return [0, +mmyyyy[2] * 10000 + +mmyyyy[1] * 100 + 28];
  const anos = [...s.matchAll(/\b(?:19|20)\d{2}\b/g)];
  if (anos.length) return [0, parseInt(anos[anos.length - 1][0], 10) * 10000];
  return [1, s];
}

/** Períodos distintos presentes nas linhas, ordenados, no máximo os 3 últimos. */
export function computeYears(rows) {
  const set = new Set();
  for (const r of rows || []) {
    for (const [y, v] of Object.entries(r.valoresPorSlot || {})) {
      if (v !== null && v !== undefined && v !== '') set.add(String(y).trim());
    }
  }
  let anos = [...set].sort((a, b) => {
    const ka = yearKey(a); const kb = yearKey(b);
    if (ka[0] !== kb[0]) return ka[0] - kb[0];
    return ka[1] < kb[1] ? -1 : ka[1] > kb[1] ? 1 : 0;
  });
  if (anos.length > 3) anos = anos.slice(anos.length - 3);
  return anos;
}

/** Alinha os períodos à DIREITA nos 3 slots. */
export function alignYearHeaders(anos) {
  const slots = [
    { slot: 'Ano 1', year: null },
    { slot: 'Ano 2', year: null },
    { slot: 'Ano 3', year: null },
  ];
  const offset = 3 - (anos || []).length;
  (anos || []).forEach((y, i) => { if (offset + i >= 0) slots[offset + i].year = y; });
  return slots.map((s) => ({ ...s, header: s.year != null ? String(s.year) : s.slot }));
}

/**
 * Finaliza as linhas: alocação normalizada, hierarquia de exibição, ano1..3 e
 * as chaves de exibição. Devolve novo array.
 *
 * Espera que `anotarHierarquia` já tenha rodado (para `totalizador` e `_folha`).
 */
export function finalizeRows(rows, anos) {
  const slots = alignYearHeaders(anos);
  return (rows || []).map((r) => {
    const alocacao = normalizeAlocacao(r.alocacaoHierarquia);
    const base = { ...r, alocacaoHierarquia: alocacao };

    const invalidos = [];
    slots.forEach((s, i) => {
      const campo = `ano${i + 1}`;
      if (s.year == null) { base[campo] = null; base[`${campo}Apresentacao`] = null; return; }
      // ano1..3 = valor GRAVADO (§14.1) - é o que a Shadow agrega
      const p = parseNumber((r.valoresPorSlot || {})[s.year]);
      if (!p.ok) {
        invalidos.push({ periodo: s.year, raw: p.raw });
        base[campo] = null;
      } else {
        base[campo] = p.value === null ? null : round2(p.value);
      }
      // ...e o valor de APRESENTAÇÃO (§14.2) fica ao lado, para a auditoria
      // conferir contra o documento e para a verificação de leitura.
      const a = parseNumber((r.valoresApresentacao || r.valoresPorSlot || {})[s.year]);
      base[`${campo}Apresentacao`] = a.ok && a.value !== null ? round2(a.value) : null;
    });
    if (invalidos.length) base.valoresInvalidos = invalidos;

    base.hierarquiaDisplay = hierarquiaDisplay(base);
    if (alocacao !== 'Sim') {
      base.tipoMapeamento = '';
    } else if (!base.tipoMapeamento || base.tipoMapeamento === 'Referência') {
      base.tipoMapeamento = 'Julgamental';
    }
    base.chave = chaveOrigem(base);
    base.chaveDestino = chaveDestino(base);
    return base;
  });
}

/** Ordena na ordem do plano de contas. */
export function sortRows(rows) {
  return [...(rows || [])].sort((a, b) => {
    const g = groupSubOrder(a.grupo, a.subCategoria) - groupSubOrder(b.grupo, b.subCategoria);
    if (g) return g;
    const ha = a.destino && String(a.destino).trim() ? 0 : 1;
    const hb = b.destino && String(b.destino).trim() ? 0 : 1;
    if (ha !== hb) return ha - hb;
    const d = destinationOrder(a.destino, a.grupo, a.subCategoria)
      - destinationOrder(b.destino, b.grupo, b.subCategoria);
    if (d) return d;
    const ca = String(a.codigo ?? ''); const cb = String(b.codigo ?? '');
    if (ca && cb && ca !== cb) return ca.localeCompare(cb, 'pt');
    return String(a.origem ?? '').localeCompare(String(b.origem ?? ''), 'pt');
  });
}
