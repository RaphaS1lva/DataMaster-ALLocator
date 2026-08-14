// PARIDADE: `aplicarSelecao` (JS) x `montar_selecao` (Python).
//
// O golden `demonstracao_fleury_2t26.json` guarda, no campo `leitura`, o que o
// servidor produziu com a sua PRÓPRIA implementação. Este arquivo alimenta a
// implementação JS com as mesmas demonstrações e exige resultado idêntico.
//
// Por que isso merece teste próprio: se as duas divergirem, o padrão que o
// servidor propôs muda de significado ao chegar na tela - o valor vai para outro
// Ano N e nada indica que mudou. É a mesma classe de bug de `normalizeText`, que
// na v1 duplicou linhas do dicionário porque quatro implementações da mesma
// normalização não eram idênticas.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  aplicarSelecao, chavesDeSelecao, descartadasDe, escolhaPadrao, familiaPrincipal,
  rotuloUnificado,
} from '../src/core/demonstracoes.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(
  join(AQUI, '..', '..', 'server', 'eval', 'datasets',
    'demonstracao_fleury_2t26.json'), 'utf-8'));

/**
 * Reconstrói o array `demonstracoes` a partir do golden.
 *
 * O golden guarda as páginas cruas e o resultado da seleção, mas não o objeto
 * intermediário. Como `leitura.linhas` traz `demonstracao` em cada linha, dá
 * para reagrupar - e as colunas e o mapeamento vêm de `fatos`.
 */
function demonstracoesDoGolden() {
  const porId = new Map();
  for (const linha of golden.leitura.linhas) {
    const id = linha.demonstracao;
    if (!porId.has(id)) porId.set(id, []);
    porId.get(id).push(linha);
  }
  return [...porId.keys()].map((id) => ({
    id,
    familias: id === 'p6' ? ['BP-ATIVO', 'BP-PASSIVO'] : ['DRE'],
    // As linhas do golden já vêm rechaveadas por período. Para exercitar o
    // rechaveamento, o mapeamento aponta cada slot para o próprio rótulo de
    // período - o que torna a operação idempotente e ainda cobre o caminho.
    mapeamento: {
      porSlot: {
        'Ano 2': golden.leitura.periodos[0],
        'Ano 3': golden.leitura.periodos[1],
      },
    },
    linhas: porId.get(id),
    descartadas: [],
  }));
}

test('rotuloUnificado espelha o rotulo_unificado do Python', () => {
  assert.equal(rotuloUnificado('Consolidado 30/06/2026'), '30/06/2026');
  assert.equal(rotuloUnificado('Controladora 6 meses 30/06/2025'), '30/06/2025');
  assert.equal(rotuloUnificado('Controladora 31/12/2025'), '31/12/2025');
  assert.equal(rotuloUnificado('2026'), '2026');
  assert.equal(rotuloUnificado('Controladora 06/2026'), '06/2026');
  assert.equal(rotuloUnificado('coluna 7'), 'coluna 7');
  assert.equal(rotuloUnificado(null), '');
});

test('rotuloUnificado normaliza dia e mês com dois dígitos', () => {
  // `1/6/2026` e `01/06/2026` são a mesma data: se saírem com chaves diferentes,
  // Balanço e DRE deixam de casar.
  assert.equal(rotuloUnificado('Consolidado 1/6/2026'), '01/06/2026');
  assert.equal(rotuloUnificado('2026-06-01'), '01/06/2026');
});

test('familiaPrincipal junta os dois lados do Balanço numa escolha só', () => {
  assert.equal(familiaPrincipal({ familias: ['BP-ATIVO', 'BP-PASSIVO'] }), 'BP');
  assert.equal(familiaPrincipal({ familias: ['DRE'] }), 'DRE');
});

test('★ a escolha é por LADO do balanço, não por "BP"', () => {
  // MUDANÇA DELIBERADA. A chave era `BP`, e isso valia enquanto o único caso
  // conhecido era o ITR diagramado, onde Ativo e Passivo dividem a página.
  //
  // Na DFP padronizada da CVM eles vêm em páginas SEPARADAS. Com a chave `BP`, as
  // duas páginas disputavam o mesmo slot, a segunda era descartada, e o resultado
  // saía com 48 linhas de Ativo e DRE e ZERO de Passivo - `Ativo = Passivo + PL`
  // sem chance de fechar, porque metade do balanço nunca chegou.
  assert.deepEqual(
    chavesDeSelecao({ familias: ['BP-ATIVO'] }), ['BP-ATIVO'],
  );
  assert.deepEqual(
    chavesDeSelecao({ familias: ['BP-PASSIVO'] }), ['BP-PASSIVO'],
  );
  assert.deepEqual(
    chavesDeSelecao({ familias: ['DRE'] }), ['DRE'],
  );
});

test('página que fecha os DOIS lados ocupa as duas chaves', () => {
  // É o caso do ITR: uma página só. Ocupando as duas chaves, ela impede que uma
  // segunda página entre por um dos lados - que contaria valor em dobro, porque
  // `aplicarSelecao` inclui TODAS as linhas da página escolhida.
  assert.deepEqual(
    chavesDeSelecao({ familias: ['BP-ATIVO', 'BP-PASSIVO'] }),
    ['BP-ATIVO', 'BP-PASSIVO'],
  );
});

test('escolhaPadrao pega uma demonstração por lado', () => {
  const demonstracoes = demonstracoesDoGolden();
  // No ITR, a página 6 fecha os dois lados: aparece nas duas chaves, e é a MESMA
  // página - `aplicarSelecao` deduplica por id.
  assert.deepEqual(escolhaPadrao(demonstracoes), {
    'BP-ATIVO': 'p6', 'BP-PASSIVO': 'p6', DRE: 'p7',
  });
});

test('página escolhida duas vezes entra UMA vez', () => {
  // Sem o dedupe por id, cada valor da página 6 seria contado em dobro - o erro
  // que multiplicava o balanço na v1.
  const demonstracoes = demonstracoesDoGolden();
  const { ids, linhas } = aplicarSelecao(
    demonstracoes, { 'BP-ATIVO': 'p6', 'BP-PASSIVO': 'p6' },
  );
  assert.deepEqual(ids, ['p6']);
  const daPagina6 = linhas.filter((r) => r.demonstracao === 'p6');
  assert.equal(daPagina6.length, linhas.length);
  // e nenhuma linha duplicada
  const chaves = daPagina6.map((r) => `${r.codigo}|${r.origem}`);
  assert.equal(new Set(chaves).size, chaves.length, 'linha duplicada na seleção');
});

test('★ aplicarSelecao reproduz o resultado do servidor', () => {
  const demonstracoes = demonstracoesDoGolden();
  const { linhas, periodos, ids } = aplicarSelecao(
    demonstracoes, escolhaPadrao(demonstracoes));

  assert.deepEqual(ids, golden.leitura.selecionadas);
  assert.deepEqual(periodos, golden.leitura.periodos);
  assert.equal(linhas.length, golden.leitura.linhas.length);

  // linha a linha: código, origem e valores por período
  const chave = (r) => `${r.demonstracao}|${r.codigo}|${r.origem}`;
  const doServidor = new Map(golden.leitura.linhas.map((r) => [chave(r), r]));
  for (const r of linhas) {
    const esperada = doServidor.get(chave(r));
    assert.ok(esperada, `linha a mais no JS: ${chave(r)}`);
    assert.deepEqual(r.valoresPorSlot, esperada.valoresPorSlot, chave(r));
    assert.equal(r.totalizador, esperada.totalizador);
  }
});

test('trocar a demonstração escolhida troca as linhas', () => {
  const demonstracoes = demonstracoesDoGolden();
  const { ids, linhas } = aplicarSelecao(demonstracoes, { BP: 'p6' });
  assert.deepEqual(ids, ['p6']);
  assert.ok(linhas.every((r) => r.demonstracao === 'p6'));
  assert.ok(linhas.every((r) => !String(r.codigo).startsWith('5')),
    'sem DRE escolhida, nenhuma linha de resultado deve entrar');
});

test('mapeamento do analista sobrescreve o proposto', () => {
  const demonstracoes = demonstracoesDoGolden();
  // Aponta Ano 3 para o período ANTERIOR: o valor tem de seguir a escolha.
  const anterior = golden.leitura.periodos[0];
  const { linhas, periodos } = aplicarSelecao(
    demonstracoes, { BP: 'p6' }, { p6: { 'Ano 3': anterior, 'Ano 2': null } });

  assert.deepEqual(periodos, [anterior]);
  const ativo = linhas.find((r) => r.codigo === '1');
  assert.deepEqual(Object.keys(ativo.valoresPorSlot), [anterior]);
  assert.equal(ativo.valoresPorSlot[anterior],
    golden.fatos.bp.totalAtivoConsolidado31122025);
});

test('slot sem coluna não inventa período', () => {
  const demonstracoes = demonstracoesDoGolden();
  const { periodos } = aplicarSelecao(
    demonstracoes, { BP: 'p6' }, { p6: { 'Ano 2': null, 'Ano 3': null } });
  assert.deepEqual(periodos, []);
});

test('descartadasDe traz só as das demonstrações escolhidas', () => {
  const demonstracoes = demonstracoesDoGolden();
  demonstracoes[0].descartadas = [{ origem: '2de', motivo: 'rodapé' }];
  demonstracoes[1].descartadas = [{ origem: '3de', motivo: 'rodapé' }];

  assert.deepEqual(
    descartadasDe(demonstracoes, { BP: 'p6' }).map((d) => d.origem), ['2de']);
  assert.deepEqual(
    descartadasDe(demonstracoes, escolhaPadrao(demonstracoes)).map((d) => d.origem),
    ['2de', '3de']);
});

test('sem demonstração nenhuma, não quebra', () => {
  const vazio = aplicarSelecao([], {});
  assert.deepEqual(vazio.linhas, []);
  assert.deepEqual(vazio.periodos, []);
  assert.deepEqual(vazio.ids, []);
  assert.deepEqual(descartadasDe(undefined, undefined), []);
});
