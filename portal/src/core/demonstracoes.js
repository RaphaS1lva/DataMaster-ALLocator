// Seleção de DEMONSTRAÇÃO e mapeamento COLUNA -> SLOT, no navegador.
//
// POR QUE ISTO EXISTE AQUI, E NÃO SÓ NO SERVIDOR
// ----------------------------------------------
// O `/read` devolve TODAS as demonstrações que encontrou, cada uma com as linhas
// chaveadas pelos rótulos de coluna do próprio documento, e uma proposta de
// mapeamento. Trocar a escolha - Controladora em vez de Consolidado, acumulado
// em vez de trimestre - é decisão do analista e tem de ser instantânea. Voltar
// ao servidor a cada troca exigiria reenviar o arquivo ou guardar estado de
// sessão, e as duas coisas são piores que reaplicar um mapeamento sobre dados
// que já estão no navegador.
//
// ATENÇÃO - PARIDADE OBRIGATÓRIA
// ------------------------------
// `aplicarSelecao` aqui e `montar_selecao` em server/app/reading/periodos.py
// TÊM de produzir o mesmo resultado, e `rotuloUnificado` tem de espelhar
// `rotulo_unificado`. Divergir faz o padrão que o servidor propôs mudar de
// significado ao chegar na tela: o valor iria para outro Ano N sem nada indicar.
// É a mesma exigência que vale para `normalizeText`. Ver AGENTS.md.

/** Ordem dos slots, do mais antigo ao mais recente. Espelha `SLOTS` no Python. */
export const SLOTS = ['Ano 1', 'Ano 2', 'Ano 3'];

const RE_DMY = /\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/;
const RE_YMD = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/;
const RE_MY = /\b(\d{1,2})[/.](\d{4})\b/;
const RE_ANO = /\b(?:19|20)\d{2}\b/g;

const dois = (n) => String(n).padStart(2, '0');

/**
 * A DATA do rótulo quando existe, senão o rótulo cru.
 *
 * É o que dá a Balanço e DRE a MESMA chave de período: no documento a coluna do
 * Balanço é `Consolidado 30/06/2026` e a da DRE `Controladora 6 meses
 * 30/06/2026` - períodos de negócio idênticos, rótulos diferentes. Sem unificar,
 * Ativo e Resultado nunca ocupariam o mesmo Ano N e metade do template sairia
 * vazia.
 *
 * Espelha `rotulo_unificado` de server/app/reading/periodos.py.
 */
export function rotuloUnificado(rotulo) {
  const s = String(rotulo ?? '').trim();
  let m = RE_DMY.exec(s);
  if (m) return `${dois(+m[1])}/${dois(+m[2])}/${m[3]}`;
  m = RE_YMD.exec(s);
  if (m) return `${dois(+m[3])}/${dois(+m[2])}/${m[1]}`;
  m = RE_MY.exec(s);
  if (m) return `${dois(+m[1])}/${m[2]}`;
  const anos = s.match(RE_ANO);
  if (anos && anos.length) return anos[anos.length - 1];
  return s;
}

/**
 * Família que representa a demonstração para efeito de escolha única.
 *
 * No ITR diagramado o Balanço traz `BP-ATIVO` e `BP-PASSIVO` na mesma página e as
 * duas árvores são do mesmo documento: contam como uma escolha só. A DRE é outra.
 */
export function familiaPrincipal(demonstracao) {
  const familias = demonstracao?.familias ?? [];
  return familias.some((f) => String(f).startsWith('BP')) ? 'BP' : 'DRE';
}

/**
 * Quais slots de escolha esta demonstração OCUPA.
 *
 * ESPELHA `chaves_de_selecao` em server/app/reading/periodos.py - a paridade é
 * obrigatória (ver AGENTS.md), porque é este cálculo que decide quais páginas
 * entram no template.
 *
 * `familiaPrincipal` devolve `'BP'` tanto para a página que fecha o Ativo quanto
 * para a que fecha o Passivo. Isso vale no ITR diagramado, onde as duas árvores
 * dividem a página - e é FALSO na DFP padronizada da CVM, onde o Ativo está numa
 * página e o Passivo em outra.
 *
 * Medido no DFP 2025 do Fleury: as duas páginas disputavam a chave `'BP'`, a
 * segunda era descartada, e o resultado tinha 48 linhas de Ativo e DRE e **ZERO
 * de Passivo**. `Ativo = Passivo + PL` não tinha como fechar - não por erro de
 * alocação, mas porque metade do balanço nunca chegou.
 */
export function chavesDeSelecao(demonstracao) {
  const familias = (demonstracao?.familias ?? []).map((f) => String(f));
  const chaves = ['BP-ATIVO', 'BP-PASSIVO'].filter((f) => familias.includes(f));
  return chaves.length ? chaves : ['DRE'];
}

/**
 * `{ 'BP-ATIVO': 'p4', 'BP-PASSIVO': 'p6', DRE: 'p9' }` - um por LADO.
 *
 * Uma página que fecha os dois lados preenche as duas chaves de uma vez, então
 * nenhuma segunda página é aceita para nenhum dos lados - que é exatamente o
 * comportamento antigo para o ITR, preservado.
 */
export function escolhaPadrao(demonstracoes) {
  const por = {};
  for (const d of demonstracoes ?? []) {
    const chaves = chavesDeSelecao(d);
    if (chaves.some((c) => c in por)) continue;
    for (const c of chaves) por[c] = d.id;
  }
  return por;
}

/**
 * Aplica a escolha do analista e devolve as linhas prontas para o pipeline.
 *
 * @param {Array} demonstracoes o que o `/read` devolveu
 * @param {object} escolha `{ BP: 'p6', DRE: 'p8' }`
 * @param {object} [mapeamento] sobrescreve o proposto: `{ p6: { 'Ano 3': 'coluna' } }`
 * @returns {{linhas:Array, periodos:string[], porSlot:object, ids:string[]}}
 */
export function aplicarSelecao(demonstracoes, escolha, mapeamento = {}) {
  const lista = demonstracoes ?? [];
  // DEDUPE obrigatório: uma página que fecha Ativo e Passivo aparece nas DUAS
  // chaves de `escolha`. Sem `new Set`, ela entraria duas vezes e cada valor
  // seria contado em dobro - o erro que multiplicava o balanço na v1.
  const ids = [...new Set(Object.values(escolha ?? {}).filter(Boolean))];
  const escolhidas = ids
    .map((id) => lista.find((d) => d.id === id))
    .filter(Boolean);

  // Mapa efetivo por demonstração: o do analista quando existe, senão o proposto.
  const porSlot = {};
  for (const d of escolhidas) {
    porSlot[d.id] = { ...(d.mapeamento?.porSlot ?? {}), ...(mapeamento[d.id] ?? {}) };
  }

  // Rótulo de cada slot: a primeira demonstração que oferecer data manda, e as
  // demais se alinham a ela.
  const rotuloDoSlot = {};
  for (const d of escolhidas) {
    for (const slot of SLOTS) {
      const coluna = porSlot[d.id][slot];
      if (!coluna || rotuloDoSlot[slot]) continue;
      const unificado = rotuloUnificado(coluna);
      if (unificado) rotuloDoSlot[slot] = unificado;
    }
  }
  for (const slot of SLOTS) if (!rotuloDoSlot[slot]) rotuloDoSlot[slot] = slot;

  const linhas = [];
  const slotsUsados = [];
  for (const d of escolhidas) {
    for (const slot of SLOTS) {
      if (porSlot[d.id][slot] && !slotsUsados.includes(slot)) slotsUsados.push(slot);
    }
    for (const origem of d.linhas ?? []) {
      const valores = origem.valoresPorSlot ?? {};
      const rechaveado = {};
      for (const slot of SLOTS) {
        const coluna = porSlot[d.id][slot];
        if (coluna && coluna in valores) rechaveado[rotuloDoSlot[slot]] = valores[coluna];
      }
      linhas.push({ ...origem, valoresPorSlot: rechaveado, demonstracao: d.id });
    }
  }

  return {
    linhas,
    periodos: SLOTS.filter((s) => slotsUsados.includes(s)).map((s) => rotuloDoSlot[s]),
    porSlot,
    ids: escolhidas.map((d) => d.id),
  };
}

/**
 * Linhas que a leitura descartou, com o motivo, das demonstrações escolhidas.
 *
 * Existem para serem MOSTRADAS. Descartar valor sem dizer que descartou é o
 * mesmo defeito que a v1 tinha ao perder linha por chave não normalizada: o
 * número muda e nada na tela indica por quê.
 */
export function descartadasDe(demonstracoes, escolha) {
  const ids = new Set(Object.values(escolha ?? {}).filter(Boolean));
  const saida = [];
  for (const d of demonstracoes ?? []) {
    if (!ids.has(d.id)) continue;
    for (const linha of d.descartadas ?? []) saida.push({ ...linha, demonstracao: d.id });
  }
  return saida;
}
