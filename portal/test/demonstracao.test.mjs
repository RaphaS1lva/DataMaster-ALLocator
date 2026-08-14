// GOLDEN DATASET nº 3 - Fleury S.A., ITR 2T26 (demonstração PUBLICADA).
//
// Por que este arquivo existe, e por que ele é diferente do `balancete.test.mjs`:
//
// O golden nº 2 (balancete SPE) é exportação de ERP - tem código contábil,
// hierarquia por prefixo e natureza D/C em coluna própria. A v2 inteira foi
// validada contra ele, e ele é o caso MINORITÁRIO. O que chega na mesa do
// analista é PDF auditado de companhia aberta, que não tem NENHUMA das três.
//
// Na primeira passagem do Fleury pelo pipeline: 1.222 linhas (contra 115 reais),
// 38 pseudo-períodos, `Total do Ativo` de R$ 2,00 e 30 bloqueios de Classe A.
// Aqui se prova que isso ficou resolvido, e que o fechamento vem da mesma
// álgebra - nenhum caminho especial para "documento publicado".
//
// O que este teste consome é `leitura`, que é o payload REAL do `/read`. O
// código gerado (`1`, `101`, `10101`) sai da árvore aritmética reconstruída no
// servidor, porque neste documento NÃO HÁ indentação: as 53 linhas de conta do
// Balanço estão todas em x0=44,76.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { runPipeline } from '../src/core/index.js';
import { anotarHierarquia } from '../src/core/hierarchy.js';
import { verificarSinteticas } from '../src/core/invariants.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(AQUI, '..', '..', 'server', 'eval', 'datasets',
  'demonstracao_fleury_2t26.json');

const golden = JSON.parse(readFileSync(FIXTURE, 'utf-8'));
const { leitura, fatos, documento } = golden;

/**
 * Mapeamento grosseiro por família, igual em espírito ao do golden nº 2: manda
 * toda folha de Ativo para um destino de Ativo e toda folha de Passivo/PL para
 * um de Passivo. Deliberadamente sem pretensão contábil.
 *
 * É o ponto do teste: se o balanço fecha com um mapeamento ruim mas
 * estruturalmente válido, o fechamento não depende da qualidade do julgamento.
 */
function mapearPorFamilia(rows) {
  return rows.map((r) => {
    const digito = String(r.codigo || '')[0];
    if (digito === '1') {
      return {
        ...r, grupo: 'Ativo', subCategoria: 'Circulante',
        destino: 'Outros Operacionais (AC)',
      };
    }
    if (digito === '2') {
      return {
        ...r, grupo: 'Passivo', subCategoria: 'Circulante',
        destino: 'Outros Operacionais (PC)',
      };
    }
    return r; // DRE (5) fica para o dicionário/julgamental
  });
}

const PERIODO_RECENTE = '30/06/2026';
const PERIODO_ANTERIOR = '31/12/2025';

// ---------------------------------------------------------------------------
// O que a leitura entregou
// ---------------------------------------------------------------------------
test('a leitura entrega 66 linhas, não as 1.222 do documento inteiro', () => {
  assert.equal(documento.linhasSeTodasEntrassem, 1222);
  assert.equal(leitura.linhas.length, 66);
  assert.deepEqual(leitura.periodos, [PERIODO_ANTERIOR, PERIODO_RECENTE]);
});

test('Balanço e DRE compartilham o mesmo rótulo de período', () => {
  // No documento a coluna do Balanço é `Consolidado 30/06/2026` e a da DRE é
  // `Controladora 6 meses 30/06/2026`. Sem unificar, Ativo e Resultado nunca
  // ocupariam o mesmo Ano N.
  const ativo = leitura.linhas.find((r) => r.codigo === '1');
  const lucro = leitura.linhas.find((r) => r.codigo === '5');
  assert.ok(PERIODO_RECENTE in ativo.valoresPorSlot);
  assert.ok(PERIODO_RECENTE in lucro.valoresPorSlot);
});

test('a escala em milhares vem declarada', () => {
  // O balanço fecha igual em qualquer escala: se isto passar batido, o número
  // sai mil vezes menor e nenhuma validação acusa.
  assert.equal(leitura.escala.fator, 1000);
  assert.equal(leitura.escala.unidade, fatos.escala);
});

// ---------------------------------------------------------------------------
// Hierarquia: o código gerado pelo servidor tem de funcionar no portal
// ---------------------------------------------------------------------------
test('★ a hierarquia é reconstruída pelo CÓDIGO gerado, não por indentação', () => {
  const rows = leitura.linhas.map((r) => ({ ...r }));
  const h = anotarHierarquia(rows);
  assert.equal(h.fonte, 'codigo');
  assert.equal(h.duplicados.length, 0, 'código duplicado descarta árvore inteira');
  // 9 sintéticas do Balanço + 5 da DRE
  assert.equal(h.sinteticas, fatos.bp.sinteticas + fatos.dre.sinteticas);
});

test('as duas raízes do Balanço são os dois lados da equação', () => {
  const rows = leitura.linhas.map((r) => ({ ...r }));
  anotarHierarquia(rows);
  const ativo = rows.find((r) => r.codigo === '1');
  const passivo = rows.find((r) => r.codigo === '2');
  assert.equal(ativo._nivel, 0);
  assert.equal(passivo._nivel, 0);
  assert.equal(ativo.totalizador, 'Sim');
  assert.equal(passivo.totalizador, 'Sim');
});

test('sintética nasce como contexto, folha nasce alocável', () => {
  // É a decisão que o v1 não tomava: marcar tudo como "Sim" fez cada valor ser
  // contado 4-6 vezes.
  const { rows } = runPipeline(mapearPorFamilia(leitura.linhas));
  const totalDoAtivo = rows.find((r) => r.codigo === '1');
  const umaFolha = rows.find((r) => r.codigo === '10101');
  assert.equal(totalDoAtivo.alocacaoHierarquia, 'Não');
  assert.equal(umaFolha.alocacaoHierarquia, 'Sim');
});

// ---------------------------------------------------------------------------
// Verificação de LEITURA - o fim do "passou com 0 assertivas"
// ---------------------------------------------------------------------------
test('★ a verificação de leitura deixa de ser vazia', () => {
  // Antes: `hierarquia: nenhuma` -> nenhuma sintética -> 0 assertivas -> verde
  // por vacuidade. Verde por ausência de teste é pior que vermelho.
  const rows = leitura.linhas.map((r) => ({ ...r }));
  anotarHierarquia(rows);
  for (const r of rows) {
    r.valoresApresentacao = { ...r.valoresPorSlot };
  }
  const resultado = verificarSinteticas(rows, leitura.periodos,
    (r, col) => (r.valoresApresentacao || {})[col] ?? null);

  assert.ok(resultado.testes > 20,
    `só ${resultado.testes} assertivas - verificação vazia de novo`);
  assert.deepEqual(resultado.divergencias, [],
    'sintética que não bate com a soma das folhas é erro de LEITURA');
  assert.equal(resultado.ok, true);
});

// ---------------------------------------------------------------------------
// ★ INVARIANTE
// ---------------------------------------------------------------------------
test('★ INVARIANTE - Ativo = Passivo + PL na demonstração publicada', () => {
  const { shadow, years } = runPipeline(mapearPorFamilia(leitura.linhas));
  assert.deepEqual(years, [PERIODO_ANTERIOR, PERIODO_RECENTE]);

  for (const campo of ['ano2', 'ano3']) {
    const b = shadow.balance[campo];
    assert.ok(!b.semDados, `${campo} sem dados`);
    assert.ok(b.fecha || b.fechaEstendida,
      `${campo}: resíduo ${b.dif} (estendido ${b.difEstendida})`);
  }
});

test('★ o Ativo é o do documento, não um número inventado', () => {
  const { shadow, yearHeaders } = runPipeline(mapearPorFamilia(leitura.linhas));
  const slot = yearHeaders.find((h) => h.year === PERIODO_RECENTE);
  assert.ok(slot, 'período mais recente não chegou a nenhum slot');
  const campo = slot.slot === 'Ano 3' ? 'ano3' : 'ano2';
  assert.equal(Math.round(shadow.totals[campo].totalAtivo),
    fatos.bp.totalAtivoConsolidado30062026);
});

test('nenhum vazamento NÃO CLASSIFICADO, e nenhuma perda por defeito', () => {
  // Este teste mapeia só Ativo e Passivo de propósito, então a DRE fica `sem
  // destino` - e isso NÃO é vazamento: é valor que o analista ainda não alocou,
  // contabilizado num balde próprio e visível na tela.
  //
  // O que não pode existir é perda por DEFEITO: destino inexistente (`orfao`),
  // alocação em subtotal (`subtotal`) ou lado do balanço trocado
  // (`ladoTrocado`). E `conservado` tem de ser verdadeiro: soma das folhas =
  // o que chegou às posições + as perdas classificadas.
  const { shadow } = runPipeline(mapearPorFamilia(leitura.linhas));
  const t = shadow.trilha;
  assert.ok(t, 'sem trilha de valor');
  for (const ano of ['ano2', 'ano3']) {
    assert.equal(t.conservado[ano], true, `${ano}: vazamento não classificado`);
    assert.equal(t.orfao[ano], 0, `${ano}: destino inexistente`);
    assert.equal(t.subtotal[ano], 0, `${ano}: alocado em subtotal`);
    assert.equal(t.ladoTrocado[ano], 0, `${ano}: lado do balanço trocado`);
  }
});

test('o Balanço inteiro chega às posições - nada de Ativo fica sem destino', () => {
  // A perda esperada é só a DRE. Se uma folha do Balanço ficasse sem destino, o
  // Ativo sairia menor que o do documento e a identidade quebraria.
  const rows = mapearPorFamilia(leitura.linhas);
  const { shadow } = runPipeline(rows);
  const semDestino = shadow.trilha.detalhes.semDestino || [];
  for (const linha of semDestino) {
    assert.ok(String(linha.codigo || '').startsWith('5'),
      `linha de balanço sem destino: ${linha.origem} (${linha.codigo})`);
  }
});

// ---------------------------------------------------------------------------
// Regressões específicas do que deu errado
// ---------------------------------------------------------------------------
test('o rodapé "2 de 46" não entra como conta', () => {
  // Chegava como rótulo `2de` e saldo 46, somando 46 ao Ativo.
  assert.ok(!leitura.linhas.some((r) => /^\d+de$/.test(r.origem)));
});

test('nenhuma linha de nota explicativa entrou', () => {
  // `10ª Emissão 1ª Série` (debênture), `121 a dias` (aging), `2027`
  // (cronograma) vinham das 30 páginas de nota admitidas pelo gate de página.
  const proibidos = [/emiss[ãa]o/i, /^\d+ a dias$/i, /^20\d{2}$/];
  for (const r of leitura.linhas) {
    for (const padrao of proibidos) {
      assert.ok(!padrao.test(r.origem), `nota vazou: ${r.origem}`);
    }
  }
});

test('o resultado abrangente não duplica o lucro líquido', () => {
  assert.ok(!leitura.linhas.some((r) => /abrangente/i.test(r.origem)));
});

test('nenhuma linha alocável ficou sem código', () => {
  // Linha sem código não tem hierarquia nem lado do balanço: o valor dela
  // desaparece da Shadow sem erro.
  for (const r of leitura.linhas) {
    assert.ok(String(r.codigo || '').length > 0, `sem código: ${r.origem}`);
  }
});

test('todo código de filho tem o do pai como prefixo', () => {
  const codigos = new Set(leitura.linhas.map((r) => r.codigo));
  for (const codigo of codigos) {
    if (codigo.length <= 1) continue;
    let temPai = false;
    for (let n = codigo.length - 1; n >= 1; n -= 1) {
      if (codigos.has(codigo.slice(0, n))) { temPai = true; break; }
    }
    assert.ok(temPai, `${codigo} ficou órfão`);
  }
});
