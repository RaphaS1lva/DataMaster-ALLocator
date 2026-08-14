// GOLDEN DATASET nº 2 - Balancete SPE (exemplo) 05.2026 (TOTVS Protheus).
//
// É o caso real em que `Ativo = Passivo + PL` não fechava. O arquivo está
// contabilmente PERFEITO (débito total = crédito total = 65.083.272,00), e as
// três causas eram todas de processamento:
//
//   1. natureza D/C em colunas de TEXTO separadas, todos os valores positivos
//      -> ignorar isso inflava Ativo em 26,5 MM e Passivo em 124,6 MM
//   2. códigos SEM ponto e com níveis ausentes -> a detecção de folha do v1
//      tratava as 358 linhas como analíticas e multiplicava o balanço por ~3
//   3. balancete NÃO ENCERRADO -> a diferença de 689.138,41 é exatamente o
//      prejuízo do período, não um erro
//
// O teste central é `INVARIANTE`: prova que o fechamento NÃO depende de qual
// conta o LLM escolheu, apenas de que ela esteja no bloco certo.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { runPipeline } from '../src/core/index.js';
import { anotarHierarquia } from '../src/core/hierarchy.js';
import { verificarSinteticas } from '../src/core/invariants.js';
import { parseNumber } from '../src/core/normalize.js';
import { candidatosPara } from '../src/core/planoContas.js';
import { saldoParaApresentacao, signIsValid } from '../src/core/sign.js';
import { POSICOES_MEMO_DRE } from '../src/core/shadow.js';
import { aggKey } from '../src/core/keys.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(AQUI, '..', '..', 'server', 'eval', 'datasets',
  'balancete_spe_exemplo.json');

const { fatos, rows: rowsBrutas } = JSON.parse(readFileSync(FIXTURE, 'utf-8'));

/** Só a coluna Saldo Atual - é a que interessa para o fechamento. */
function apenasSaldoAtual(rows) {
  return rows.map((r) => ({
    codigo: r.codigo,
    origem: r.origem,
    valoresPorSlot: { '31/05/2026': r.valoresPorSlot['Saldo Atual'] },
    naturezaPorSlot: { '31/05/2026': r.naturezaPorSlot['Saldo Atual'] || '' },
  }));
}

/**
 * Mapeamento de teste: manda cada folha para o destino "guarda-chuva" do seu
 * bloco, deduzido dos 2 primeiros dígitos do código Protheus.
 *
 * Este mapeamento é DELIBERADAMENTE grosseiro - nenhuma pretensão de estar
 * contabilmente correto. É justamente o ponto: se o balanço fecha com um
 * mapeamento ruim mas estruturalmente válido, então o fechamento é independente
 * da qualidade do julgamento. Um erro do LLM vira aviso de Classe B, nunca um
 * balanço errado.
 */
const BLOCO = {
  11: ['Ativo', 'Circulante', 'Outros Operacionais (AC)'],
  12: ['Ativo', 'Não Circulante', 'Outros Operacionais (ANC)'],
  21: ['Passivo', 'Circulante', 'Outros Operacionais (PC)'],
  22: ['Passivo', 'Não Circulante', 'Outros Operacionais (PNC)'],
  24: ['Passivo', 'PL', 'Outras Reservas'],
};

function mapearGrosseiro(rows) {
  return rows.map((r) => {
    const c = String(r.codigo);
    const bloco = BLOCO[c.slice(0, 2)];
    if (bloco) {
      const [grupo, sub, destino] = bloco;
      return { ...r, grupo, subCategoria: sub, destino };
    }
    if (c[0] === '3' || c[0] === '4') {
      // Destino `+/-` (preserva o sinal) para TODA a DRE. Isso é deliberado:
      // um destino `neg`/`pos` grava `Math.abs()` e destruiria o sinal das
      // contas de natureza contrária ao bloco - que existem nos dois grupos
      // (grupo 3 tem `39 OUTRAS RECEITAS` credora, grupo 4 tem `43 DEDUÇÕES`
      // devedora). O guardrail de Classe A `sinal-incompativel` barra essa
      // combinação, e o teste `DETECÇÃO` abaixo prova que ele barra.
      return {
        ...r, grupo: 'DRE', subCategoria: 'DRE',
        destino: '+/-Outras Receitas/Despesas Operacionais',
      };
    }
    return r;
  });
}

const APROX = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

// ---------------------------------------------------------------------------
test('a fixture reproduz os números do arquivo original', () => {
  assert.equal(fatos.linhas, 358);
  assert.equal(fatos.folhas, 224);
  assert.equal(fatos.sinteticas, 134);
  assert.ok(APROX(fatos.saldoAtual.ativo, 118035576.14));
  assert.ok(APROX(fatos.saldoAtual.passivoPl, 118724714.55));
  assert.ok(APROX(fatos.saldoAtual.resultado, -689138.41));
  // a identidade ESTENDIDA fecha exatamente: o arquivo está correto
  assert.ok(APROX(fatos.saldoAtual.difEstendida, 0));
});

test('CAUSA 3 - hierarquia por prefixo acha 224 folhas e 134 sintéticas', () => {
  const rows = apenasSaldoAtual(rowsBrutas);
  const h = anotarHierarquia(rows);
  assert.equal(h.fonte, 'codigo');
  assert.equal(h.folhas, 224);
  assert.equal(h.sinteticas, 134);
  assert.deepEqual(h.duplicados, []);

  // Os códigos não têm ponto: a regra do v1 ("existe outro código começando
  // com <código>+'.'") acharia ZERO sintéticas e somaria as 358 linhas.
  assert.ok(rowsBrutas.every((r) => !String(r.codigo).includes('.')));

  // E a regra "pai = código truncado no nível anterior" também falha, porque
  // faltam níveis: existe 110101 e 11010100000071, mas não 11010100.
  const codigos = new Set(rowsBrutas.map((r) => String(r.codigo)));
  assert.ok(codigos.has('110101'));
  assert.ok(codigos.has('11010100000071'));
  assert.ok(!codigos.has('11010100'), 'nível de 8 dígitos deveria estar ausente');
});

test('CAUSA 3b - folha aloca, sintética vira contexto automaticamente', () => {
  const res = runPipeline(apenasSaldoAtual(rowsBrutas), { saldosAbsolutos: true });
  assert.equal(res.qa.summary.folhas, 224);
  assert.equal(res.qa.summary.sinteticas, 134);
  // as 134 sintéticas não podem estar marcadas para alocar
  const sinteticasSim = res.rows.filter((r) => r._folha === false
    && r.alocacaoHierarquia === 'Sim');
  assert.deepEqual(sinteticasSim.map((r) => r.origem), []);
});

test('CAUSA 2 - natureza D/C por linha reproduz os totais declarados', () => {
  const rows = apenasSaldoAtual(rowsBrutas);
  const res = runPipeline(rows, { saldosAbsolutos: true });
  const porCodigo = new Map(res.rows.map((r) => [String(r.codigo), r]));
  // usa a APRESENTAÇÃO (§14.2), que é o valor comparável ao documento
  const valor = (cod) => parseNumber(porCodigo.get(cod).valoresApresentacao['31/05/2026']).value;

  // A soma das folhas de cada grupo tem de bater com a linha raiz declarada.
  // Sem aplicar D/C, o Ativo daria 144.569.839,12 (+26,5 MM) e o Passivo
  // 243.343.666,03 (+124,6 MM).
  const folhas = res.rows.filter((r) => r._folha);
  const soma = (prefixo) => folhas
    .filter((r) => String(r.codigo).startsWith(prefixo))
    .reduce((acc, r) => acc + (parseNumber(r.valoresApresentacao['31/05/2026']).value || 0), 0);

  assert.ok(APROX(soma('1'), 118035576.14), `Ativo = ${soma('1')}`);
  assert.ok(APROX(soma('1'), valor('1')));
  // Passivo: grupo credor, então a apresentação é positiva e o total declarado
  // no arquivo é 118.724.714,55 C
  assert.ok(APROX(soma('2'), 118724714.55), `Passivo+PL = ${soma('2')}`);
  assert.ok(APROX(soma('24'), 13428998.48), `PL = ${soma('24')}`);
});

test('CAUSA 2b - as 13 retificadoras de BP entram com sinal negativo', () => {
  const res = runPipeline(apenasSaldoAtual(rowsBrutas), { saldosAbsolutos: true });
  const porCodigo = new Map(res.rows.map((r) => [String(r.codigo), r]));
  const v = (cod) => parseNumber(porCodigo.get(cod).valoresApresentacao['31/05/2026']).value;

  // Ativo com saldo CREDOR -> negativo na apresentação
  assert.ok(v('11030500000002') < 0, '(-) PCLD deveria ser negativa');
  assert.ok(APROX(v('12220500000004'), -3849906.69), '(-) AMORT.ACUM.EQUIP.INFORM');
  // Passivo com saldo DEVEDOR -> negativo na apresentação
  assert.ok(APROX(v('22080200000009'), -52170251.82), '( - ) JUROS DEBENTURES LP');
  assert.ok(APROX(v('24040100000001'), -1171001.52), '(-) PREJUIZOS ACUMULADOS');
  // e uma conta normal continua positiva
  assert.ok(v('24010100000001') > 0, 'CAPITAL SOCIAL SUBSCRITO deveria ser positiva');
});

test('LEITURA - as 134 sintéticas batem com a soma das folhas (0 divergências)', () => {
  const rows = apenasSaldoAtual(rowsBrutas);
  const res = runPipeline(rows, { saldosAbsolutos: true });
  const v = res.diagnostico.verificacaoLeitura;
  assert.ok(v.testes >= 130, `só ${v.testes} testes de leitura`);
  assert.deepEqual(v.divergencias, [],
    `${v.divergencias.length} blocos não batem - erro de LEITURA`);
  assert.equal(v.ok, true);
});

test('LEITURA - ignorar o D/C faz a verificação FALHAR (prova do contrário)', () => {
  // Sem a natureza, 72 blocos divergem. Este teste garante que a verificação
  // de leitura realmente detecta o erro em vez de passar por acidente.
  const semDC = apenasSaldoAtual(rowsBrutas).map((r) => ({ ...r, naturezaPorSlot: {} }));
  const h = anotarHierarquia(semDC);
  assert.equal(h.fonte, 'codigo');
  const v = verificarSinteticas(semDC, ['31/05/2026'],
    (r, col) => parseNumber((r.valoresPorSlot || {})[col]).value); // valores crus, todos positivos
  // 22 blocos divergem só na coluna Saldo Atual (72 somando as 5 colunas)
  assert.ok(v.divergencias.length >= 20,
    `esperava muitas divergências sem D/C, veio ${v.divergencias.length}`);
  const raizAtivo = v.divergencias.find((d) => d.codigo === '1');
  assert.ok(raizAtivo, 'a raiz ATIVO deveria divergir');
  assert.ok(APROX(raizAtivo.diferenca, 26534262.98, 1),
    `erro do Ativo = ${raizAtivo.diferenca}`);
});

test('CAUSA 1 - identidade estendida detecta o balancete NÃO ENCERRADO', () => {
  const rows = mapearGrosseiro(apenasSaldoAtual(rowsBrutas));
  const res = runPipeline(rows, { saldosAbsolutos: true });
  const b = res.shadow.balance.ano3;

  assert.ok(APROX(b.ativo, 118035576.14), `ativo=${b.ativo}`);
  assert.ok(APROX(b.passivoPl, 118724714.55), `passivoPl=${b.passivoPl}`);
  assert.ok(APROX(b.resultado, -689138.41), `resultado=${b.resultado}`);
  assert.ok(APROX(b.dif, -689138.41), `dif=${b.dif}`);

  // a identidade SIMPLES não fecha, a ESTENDIDA fecha exatamente
  assert.equal(b.fecha, false);
  assert.equal(b.fechaEstendida, true);
  assert.ok(APROX(b.difEstendida, 0), `difEstendida=${b.difEstendida}`);

  // e o sistema classifica corretamente: não é erro, é resultado não transportado
  assert.equal(b.naoEncerrado, true);
  assert.ok(APROX(b.transporteSugerido, -689138.41));

  // o QA emite `action` (exige um clique), não `error` (que barraria a entrega)
  const acao = res.qa.issues.find((i) => i.code === 'nao-encerrado');
  assert.ok(acao, 'deveria haver a ação de transporte');
  assert.equal(acao.level, 'action');
  assert.match(acao.msg, /balancete não encerrado/i);
  const idErro = res.qa.issues.find((i) => i.code === 'identidade');
  assert.equal(idErro, undefined, 'não deveria acusar "identidade" quando é só transporte');
});

test('★ INVARIANTE - com o transporte, o balanço fecha em 0,00', () => {
  const rows = mapearGrosseiro(apenasSaldoAtual(rowsBrutas));
  const res = runPipeline(rows, { saldosAbsolutos: true, transportarResultado: true });
  const b = res.shadow.balance.ano3;

  assert.ok(APROX(b.dif, 0, 0.01), `diferença final = ${b.dif} (esperado 0,00)`);
  assert.equal(b.fecha, true);
  assert.equal(b.ok, true);
  assert.equal(b.naoEncerrado, false);

  // Ativo preservado e Passivo+PL agora reduzido pelo prejuízo
  assert.ok(APROX(b.ativo, 118035576.14));
  assert.ok(APROX(b.passivoPl, 118035576.14),
    `passivoPl após transporte = ${b.passivoPl}`);

  // nenhum bloqueante restante
  const bloqueantes = res.qa.issues.filter((i) => i.classe === 'A' && i.level === 'error');
  assert.deepEqual(bloqueantes.map((i) => `${i.code}: ${i.msg}`), []);
  assert.equal(res.qa.bloqueado, false);
});

test('★ INVARIANTE - conservação de valor: nada some entre a folha e a Shadow', () => {
  const rows = mapearGrosseiro(apenasSaldoAtual(rowsBrutas));
  const res = runPipeline(rows, { saldosAbsolutos: true, transportarResultado: true });
  const t = res.shadow.trilha;

  assert.equal(t.ok, true, `trilha: ${JSON.stringify(t.perdas)}`);
  assert.equal(t.orfao.ano3, 0, 'nenhuma chave órfã');
  assert.equal(t.subtotal.ano3, 0, 'nada alocado em subtotal');
  assert.equal(t.semDestino.ano3, 0, 'nada alocado sem destino');
  assert.equal(t.ladoTrocado.ano3, 0, 'nenhum lado trocado');
  assert.equal(t.perdas.ano3, 0);
  // o que a trilha diz que foi alocado é o que a agregação produziu
  assert.ok(APROX(t.alocado.ano3, t.agregado.ano3),
    `alocado=${t.alocado.ano3} agregado=${t.agregado.ano3}`);
  assert.equal(res.shadow.orphans.length, 0);
});

test('★ INVARIANTE - o fechamento NÃO depende de qual conta o LLM escolheu', () => {
  // O TESTE QUE SUSTENTA A ARQUITETURA.
  //
  // Enunciado preciso: o fechamento é invariante a qualquer realocação que
  // preserve (a) o LADO do balanço e (b) a COMPATIBILIDADE DE SINAL. Essas são
  // exatamente as duas condições de Classe A que o código verifica - logo, o
  // LLM pode errar qual conta e o balanço continua fechando.
  //
  // A restrição (b) não é detalhe: destinos `neg`/`pos` gravam `Math.abs()`, e
  // mandar um valor de sinal contrário para lá inverte a contribuição. É por
  // isso que ela é bloqueante, e não um aviso.
  //
  // Sorteamos 15 mapeamentos, cada um escolhendo OUTRA conta compatível dentro
  // do MESMO bloco. Todos têm de produzir o MESMO fechamento.
  const base = apenasSaldoAtual(rowsBrutas);
  const difs = [];

  for (let semente = 0; semente < 15; semente += 1) {
    let n = semente * 7919 + 13;
    const proximo = () => { n = (n * 1103515245 + 12345) & 0x7fffffff; return n; };

    const rows = base.map((r) => {
      const c = String(r.codigo);
      let grupo; let sub;
      if (BLOCO[c.slice(0, 2)]) {
        [grupo, sub] = BLOCO[c.slice(0, 2)];
      } else if (c[0] === '3' || c[0] === '4') { grupo = 'DRE'; sub = 'DRE'; }
      else return r;

      // sinal de apresentação desta conta (contribuição assinada ao bloco)
      const ap = saldoParaApresentacao(r.valoresPorSlot['31/05/2026'], grupo, {
        natureza: r.naturezaPorSlot['31/05/2026'], saldosAbsolutos: true,
      });
      // candidatas do bloco cujo sinal é compatível E que alcançam o resultado
      // (as posições 16/17/19 da DRE são memorando de add-back do EBITDA e não
      // chegam ao Lucro Líquido - não são escolhas equivalentes)
      const cands = candidatosPara(grupo, sub)
        .filter((x) => !POSICOES_MEMO_DRE.has(aggKey(x.destino, x.grupo, x.subCategoria)))
        .filter((x) => ap.valor === null || signIsValid(ap.valor, x.destino));
      assert.ok(cands.length, `sem candidata compatível para ${r.origem}`);
      const escolhida = cands[proximo() % cands.length];
      return { ...r, grupo, subCategoria: sub, destino: escolhida.destino };
    });

    const res = runPipeline(rows, { saldosAbsolutos: true, transportarResultado: true });
    const b = res.shadow.balance.ano3;
    difs.push(b.dif);

    const bloqueantes = res.qa.issues.filter((i) => i.classe === 'A' && i.level === 'error');
    assert.deepEqual(bloqueantes.map((i) => i.code), [],
      `semente ${semente}: bloqueantes inesperados`);
    assert.ok(APROX(b.dif, 0, 0.01),
      `semente ${semente}: diferença ${b.dif} - o fechamento NÃO deveria depender da conta`);
    assert.ok(APROX(b.ativo, 118035576.14), `semente ${semente}: ativo ${b.ativo}`);
    assert.equal(res.shadow.trilha.ok, true, `semente ${semente}: trilha furou`);
  }
  // os 15 mapeamentos produzem exatamente o MESMO fechamento
  assert.equal(new Set(difs.map((d) => Math.round(d * 100))).size, 1);
});

test('DETECÇÃO - alocar em subtotal é bloqueado e o valor aparece na trilha', () => {
  const rows = mapearGrosseiro(apenasSaldoAtual(rowsBrutas)).map((r) => (
    // desvia o Ativo Circulante para "Estoques", que é subtotal
    String(r.codigo).startsWith('11') ? { ...r, destino: 'Estoques' } : r
  ));
  const res = runPipeline(rows, { saldosAbsolutos: true });
  assert.equal(res.qa.bloqueado, true);
  assert.ok(res.qa.issues.some((i) => i.code === 'destino-subtotal'));
  // e o dinheiro desviado aparece explicitamente, em vez de evaporar
  assert.ok(res.shadow.trilha.subtotal.ano3 !== 0,
    'o valor mandado para subtotal precisa aparecer na trilha');
});

test('TEMPLATE - 6 posições da DRE ficam fora da cadeia do resultado', () => {
  // Descoberta ao construir o teste do invariante. Dois motivos distintos:
  //
  // ADD-BACK do EBITDA - a linha 18 é `EBITDA = +15 +16 +17 −14`. A depreciação
  //   já está dentro das despesas que formam o EBIT (linha 15); as posições
  //   16/17/19 existem para DIVULGAR quanto dela era depreciação/aluguel.
  // ABAIXO DO LUCRO LÍQUIDO - 36 (abrangentes, só entra na linha 37), 39
  //   (dividendos) e 40 (minoritários) vêm depois do resultado por definição.
  assert.equal(POSICOES_MEMO_DRE.size, 6);
  const nomes = [...POSICOES_MEMO_DRE].map((k) => k.split('|')[0]).sort();
  assert.deepEqual(nomes, [
    'depreciacao amortizacao dos arrendamentos op',
    'depreciacao e amortizacao imob e intang',
    'despesas custo de aluguel',
    'dividendos',
    'participacoes minoritarias',
    'resultados abrangentes',
  ]);

  // Alocar ali faz o valor aparecer na Shadow mas não no resultado. A trilha
  // registra isso num balde próprio (não é perda) e a mensagem de diferença
  // cita como provável origem do resíduo.
  const rows = mapearGrosseiro(apenasSaldoAtual(rowsBrutas)).map((r) => (
    String(r.codigo).startsWith('31')
      ? { ...r, destino: '- Depreciação e amortização (imob e intang)' } : r
  ));
  const res = runPipeline(rows, { saldosAbsolutos: true });
  assert.ok(res.shadow.trilha.memoDre.ano3 !== 0,
    'o valor em posição de memorando precisa aparecer na trilha');
  // e o valor NÃO é contado como perda, porque está na Shadow
  assert.equal(res.shadow.trilha.perdas.ano3, 0);
  // e a mensagem de diferença aponta a ORIGEM em vez de dizer "investigue"
  const idErro = res.qa.issues.find((i) => i.code === 'identidade');
  assert.ok(idErro, 'deveria acusar a identidade');
  assert.match(idErro.msg, /fora da cadeia do resultado/i);
  assert.match(idErro.msg, /prov[áa]vel origem do res[íi]duo/i);
});

test('DETECÇÃO - sinal incompatível com o destino é BLOQUEADO', () => {
  // `RECUPERACAO DE DESPESAS` é crédito dentro do grupo 3: apresentação
  // POSITIVA (aumenta o lucro). Mandá-la para um destino `neg`, que grava
  // módulo e é subtraído, inverteria a contribuição. No v1 a checagem
  // equivalente rodava sobre o valor já em módulo e nunca disparava.
  const rows = mapearGrosseiro(apenasSaldoAtual(rowsBrutas)).map((r) => (
    String(r.codigo) === '39010101000003'
      ? { ...r, destino: '- Despesas Administrativas' } : r
  ));
  const res = runPipeline(rows, { saldosAbsolutos: true });
  const issue = res.qa.issues.find((i) => i.code === 'sinal-incompativel');
  assert.ok(issue, 'deveria detectar o sinal incompatível');
  assert.equal(issue.classe, 'A');
  assert.equal(res.qa.bloqueado, true);
  assert.match(issue.msg, /SUBTRA[ÍI]DO/i);
});

test('DETECÇÃO - lado trocado é bloqueado (o único erro de julgamento que fura)', () => {
  const rows = mapearGrosseiro(apenasSaldoAtual(rowsBrutas)).map((r) => (
    String(r.codigo) === '11010100000071'
      ? { ...r, grupo: 'Ativo', subCategoria: 'Circulante', destino: 'Bancos' }
      : r
  ));
  const res = runPipeline(rows, { saldosAbsolutos: true });
  // "Bancos" é Passivo|Circulante; a linha é Ativo -> lado trocado
  const issue = res.qa.issues.find((i) => i.code === 'lado-trocado');
  assert.ok(issue, 'deveria detectar a troca de lado');
  assert.equal(res.qa.bloqueado, true);
  assert.match(issue.msg, /2x o valor/);
});
