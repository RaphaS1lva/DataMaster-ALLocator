// Regressão da causa raiz nº 1: destinos do dicionário que não resolviam para
// uma posição do template e por isso viravam chave órfã - valor descartado da
// Shadow sem nenhum erro no QA.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTAS_ALOCAVEIS, SUBTOTAIS, NOMES_AMBIGUOS, PLANO_CONTAS,
  resolveDestino, resolveDestinoAlocavel, candidatosPara, ladoDoBalanco,
  groupSubOrder,
} from '../src/core/planoContas.js';
import { DICIONARIO_SEED } from '../src/core/data/dicionario.gen.js';
import { aggKey, displayKey } from '../src/core/keys.js';
import { normalizeText } from '../src/core/normalize.js';

test('o plano tem exatamente 79 contas alocáveis e 28 subtotais', () => {
  assert.equal(CONTAS_ALOCAVEIS.length, 79);
  assert.equal(SUBTOTAIS.length, 28);
  assert.equal(PLANO_CONTAS.length, 107);
});

test('homônimos entre grupos são detectados', () => {
  // "Mútuo Financeiro" e "Mútuo Financeiro LP" existem no Ativo e no Passivo.
  // "Participações Minoritárias" existe no BP (Passivo|PL) e na DRE - as duas
  // normalizam para a mesma string porque o prefixo "+/-" é removido.
  assert.ok(NOMES_AMBIGUOS.has('mutuo financeiro'));
  assert.ok(NOMES_AMBIGUOS.has('mutuo financeiro lp'));
  assert.ok(NOMES_AMBIGUOS.has('participacoes minoritarias'));
});

test('CAUSA 1a - grafia "L/P" resolve para "LP" (v1: 138 entradas vazavam)', () => {
  // No v1 a regra usava /\bl\s*\/\s*p\b/ sobre o texto normalizado, mas
  // normalizeText já havia trocado "/" por espaço. Nunca casava.
  const casos = [
    ['Mútuo Financeiro L/P', 'Passivo', 'Não Circulante', 'Mútuo Financeiro LP'],
    ['Mútuo Financeiro L/P', 'Ativo', 'Não Circulante', 'Mútuo Financeiro LP'],
    ['Bancos L/P', 'Passivo', 'Não Circulante', 'Bancos LP'],
    ['Aplicações Financeiras de L/P', 'Ativo', 'Não Circulante', 'Aplicações Financeiras de LP'],
    ['Outras Dividas Financeiras L/P', 'Passivo', 'Não Circulante', 'Outras Dividas Financeiras LP'],
  ];
  for (const [dest, grupo, sub, esperado] of casos) {
    const r = resolveDestinoAlocavel(dest, grupo, sub);
    assert.ok(r.ok, `${dest} deveria resolver, veio: ${r.erro}`);
    assert.equal(r.conta.destino, esperado);
    assert.equal(normalizeText(r.conta.grupo), normalizeText(grupo));
  }
});

test('CAUSA 1b - "de Longo Prazo" e "não Circulante" resolvem para LP', () => {
  const a = resolveDestinoAlocavel('Dividas Fiscais de Longo Prazo', 'Passivo', 'Não Circulante');
  assert.ok(a.ok);
  assert.equal(a.conta.destino, 'Dividas Fiscais LP');

  const b = resolveDestinoAlocavel('Passivo de Arrendamento não Circulante', 'Passivo', 'Não Circulante');
  assert.ok(b.ok);
  assert.equal(b.conta.destino, 'Passivo de Arrendamento LP');
});

test('CAUSA 1c - divergência só de caixa resolve (Excel SUMIFS é case-insensitive)', () => {
  for (const [dest, esperado] of [
    ['Produtos acabados', 'Produtos Acabados'],
    ['dividendos a pagar', 'Dividendos a Pagar'],
    ['CAIXA', 'Caixa'],
  ]) {
    const r = resolveDestino(dest, '', '');
    assert.ok(r, `${dest} deveria resolver`);
    assert.equal(r.destino, esperado);
  }
});

test('CAUSA 1d - aliases com "/" e "(" no nome agora são alcançáveis', () => {
  // No v1 as chaves do mapa não eram normalizadas, e a busca era feita com a
  // chave normalizada - então toda chave com "/", "(", ")" ou "+" era morta.
  const r = resolveDestinoAlocavel('Fornecedores Externos', 'Passivo', 'Circulante');
  assert.ok(r.ok);
  assert.equal(r.conta.destino, 'Fornecedores');

  const s = resolveDestinoAlocavel('Outros Não Operacionais (ANC)', 'Ativo', 'Não Circulante');
  assert.ok(s.ok);
  assert.equal(s.conta.destino, 'Outros Não Operacionais LP (ANC)');
});

test('CAUSA 4 - "PARTICIPAÇÕES MINORITÁRIAS" vai para Passivo|PL, não para a DRE', () => {
  const r = resolveDestinoAlocavel('PARTICIPAÇÕES MINORITÁRIAS', 'Passivo', 'Não Circulante');
  assert.ok(r.ok, r.erro);
  assert.equal(r.conta.destino, 'PARTICIPAÇÕES MINORITÁRIAS');
  assert.equal(r.conta.grupo, 'Passivo');
  assert.equal(r.conta.subCategoria, 'PL');
  assert.equal(r.conta.row, 75);
});

test('CAUSA 2 - alocar em subtotal é BLOQUEADO, não apenas avisado', () => {
  // No v1 isto era `warn` e o valor evaporava: subtotais são kind:"calc" e não
  // têm bucket de agregação. "Estoques" e "Disponibilidades" são justamente os
  // destinos mais intuitivos para um humano ou para o LLM.
  for (const nome of ['Estoques', 'Disponibilidades', 'Clientes Líquido',
    'Fornecedores Totais', 'TOTAL ATIVO', 'PATRIMÔNIO LÍQUIDO', 'Lucro Liquido']) {
    const r = resolveDestinoAlocavel(nome, '', '');
    assert.equal(r.ok, false, `${nome} NÃO deveria ser alocável`);
    assert.match(r.erro, /subtotal/i);
  }
});

test('CAUSA 5 - homônimo sem grupo é erro explícito, não vai para o Ativo', () => {
  // No v1 o fallback por nome devolvia a PRIMEIRA ocorrência (sempre o Ativo),
  // então um mútuo passivo caía no Ativo e a diferença virava 2x o valor.
  const semGrupo = resolveDestinoAlocavel('Mútuo Financeiro', '', '');
  assert.equal(semGrupo.ok, false);
  assert.match(semGrupo.erro, /mais de um grupo/i);

  const comGrupo = resolveDestinoAlocavel('Mútuo Financeiro', 'Passivo', 'Circulante');
  assert.ok(comGrupo.ok);
  assert.equal(comGrupo.conta.row, 54); // linha do Passivo, não a 18 do Ativo
  assert.equal(comGrupo.conta.grupo, 'Passivo');
});

test('destino inexistente é recusado com mensagem clara', () => {
  const r = resolveDestinoAlocavel('Conta Que Não Existe', 'Ativo', 'Circulante');
  assert.equal(r.ok, false);
  assert.match(r.erro, /não existe no plano de contas/i);
});

test('INVARIANTE - as 1.260 regras do dicionário resolvem para conta alocável', () => {
  const falhas = [];
  for (const e of DICIONARIO_SEED) {
    const r = resolveDestinoAlocavel(e.destino, e.grupo, e.subCategoria);
    if (!r.ok) falhas.push(`${e.origem} -> ${e.destino}|${e.grupo}|${e.subCategoria}: ${r.erro}`);
  }
  assert.deepEqual(falhas, [], `${falhas.length} regras inválidas`);
  assert.ok(DICIONARIO_SEED.length > 1200, `dicionário com ${DICIONARIO_SEED.length} regras`);
});

test('INVARIANTE - a aggKey do dicionário casa com a aggKey do plano', () => {
  // Este é o teste que o v1 não tinha e que teria pego o bug no primeiro dia:
  // toda chave produzida pela alocação precisa existir no conjunto de chaves
  // que a Shadow sabe agregar.
  const chavesDoPlano = new Set(
    CONTAS_ALOCAVEIS.map((c) => aggKey(c.destino, c.grupo, c.subCategoria)),
  );
  const orfas = new Set();
  for (const e of DICIONARIO_SEED) {
    const r = resolveDestinoAlocavel(e.destino, e.grupo, e.subCategoria);
    if (!r.ok) continue;
    const k = aggKey(r.conta.destino, r.conta.grupo, r.conta.subCategoria);
    if (!chavesDoPlano.has(k)) orfas.add(k);
  }
  assert.deepEqual([...orfas], []);
});

test('aggKey normaliza e displayKey preserva', () => {
  assert.equal(aggKey('Mútuo Financeiro LP', 'Ativo', 'Não Circulante'),
    'mutuo financeiro lp|ativo|nao circulante');
  // caixa e acento não podem produzir chaves diferentes
  assert.equal(aggKey('PRODUTOS ACABADOS', 'ativo', 'CIRCULANTE'),
    aggKey('Produtos Acabados', 'Ativo', 'Circulante'));
  // displayKey mantém a grafia para o Excel
  assert.equal(displayKey('  Caixa ', 'Ativo', 'Circulante'), 'Caixa|Ativo|Circulante');
});

test('espaços significativos do template são preservados byte a byte', () => {
  const nomes = PLANO_CONTAS.map((p) => p.destino);
  assert.ok(nomes.includes('-  Despesas Financeiras'), 'espaço duplo perdido');
  assert.ok(nomes.includes('Resultado da Exploração '), 'espaço final perdido');
  assert.ok(nomes.includes('Lucro antes de Impostos '), 'espaço final perdido');
});

test('ladoDoBalanco agrupa Passivo e PL do mesmo lado', () => {
  assert.equal(ladoDoBalanco('Ativo', 'Circulante'), 'ativo');
  assert.equal(ladoDoBalanco('Ativo', 'Não Circulante'), 'ativo');
  assert.equal(ladoDoBalanco('Passivo', 'Circulante'), 'passivoPl');
  assert.equal(ladoDoBalanco('Passivo', 'Não Circulante'), 'passivoPl');
  assert.equal(ladoDoBalanco('Passivo', 'PL'), 'passivoPl');
  assert.equal(ladoDoBalanco('DRE', 'DRE'), 'dre');
});

test('candidatosPara restringe o espaço de decisão do LLM', () => {
  // É isto que viabiliza um modelo local pequeno: em vez de escolher entre 79
  // posições, ele escolhe entre ~9-15 do bloco compatível.
  const pc = candidatosPara('Passivo', 'Circulante');
  assert.equal(pc.length, 15);
  assert.ok(pc.every((c) => c.grupo === 'Passivo' && c.subCategoria === 'Circulante'));

  const pl = candidatosPara('Passivo', 'PL');
  assert.equal(pl.length, 4);

  assert.equal(candidatosPara('Ativo', 'Circulante').length, 14);
  assert.equal(candidatosPara('Ativo', 'Não Circulante').length, 14);
  assert.equal(candidatosPara('Passivo', 'Não Circulante').length, 9);
  assert.equal(candidatosPara('DRE', 'DRE').length, 23);
  // sem grupo, todas as 79
  assert.equal(candidatosPara('', '').length, 79);
});

test('ordem dos blocos na Shadow', () => {
  assert.equal(groupSubOrder('Ativo', 'Circulante'), 0);
  assert.equal(groupSubOrder('Passivo', 'PL'), 4);
  assert.equal(groupSubOrder('DRE', 'DRE'), 5);
  // tolera variação de caixa/acento
  assert.equal(groupSubOrder('ATIVO', 'NAO CIRCULANTE'), 1);
});
