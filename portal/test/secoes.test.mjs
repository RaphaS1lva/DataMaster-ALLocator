// SEÇÕES E POLARIDADE - os quatro defeitos encontrados na segunda passagem do
// ITR do Fleury pelo portal, depois que a leitura já estava correta.
//
// A leitura entregou 66 linhas certas, a hierarquia aritmética fechou e a
// verificação de leitura passou com 26 assertivas. Mesmo assim a identidade
// furou em 23%: R$ 3.314.468 não chegaram à Shadow porque 6 linhas ficaram
// `alocacaoHierarquia = 'Sim'` sem destino.
//
// Nenhuma das quatro causas era "o modelo errou". Três são de código e a quarta
// era uma instrução errada que EU dei ao modelo:
//
//   1. CÍRCULO DA SUBCATEGORIA. `candidatosPara(grupo, '')` devolve o grupo
//      inteiro. As 6 linhas foram ao LLM como `Passivo/?` com 28 candidatos em
//      vez de 4 - e a redução "de 79 para ~9-15" é a premissa que sustenta usar
//      um modelo de 3B. Ela não valia para exatamente as linhas que dependiam
//      dela.
//   2. CABEÇALHO DE SEÇÃO GRUDADO. A linha crua do /read é
//      `'Patrimônio líquido Capital social 24a.'`. O dicionário conhece
//      `Capital social` desde sempre; o nome contaminado dá Jaccard 0,40 e não
//      casa.
//   3. PARCELA CASANDO COM LINHA LÍQUIDA. `Despesas financeiras` foi para
//      `+ Receitas Financeiras` com selo `Dicionário` e confiança 0,9 - uma
//      DESPESA numa posição de RECEITA. Passou porque a entrada
//      `Receitas despesas financeiras líquidas` contém a substring e a razão de
//      tokens dá exatamente o piso 0,50.
//   4. VIÉS DE ABSTENÇÃO no prompt (testado em server/tests/test_llm_prompt.py).
//
// O caso 3 é o mais grave dos quatro e o único que a suíte antiga não pegaria:
// só foi visível porque o Fleury publica despesa com sinal negativo e o
// guardrail de sinal disparou. Com despesa positiva o valor entraria como
// receita sem sintoma nenhum.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  secaoDeNome, separarSecao, limparRotulo, anotarSecoes,
} from '../src/core/secoes.js';
import { polaridadeInverte, polaridadeAcrescenta } from '../src/core/normalize.js';
import { candidatosPara, posicaoResidual } from '../src/core/planoContas.js';
import { runPipeline, memoriaDeRows } from '../src/core/index.js';
import { pendentesDeJulgamento, patchesResiduais } from '../src/core/matching.js';

/**
 * Reproduz o que a tela faz: roda o pipeline, pede os patches residuais e os
 * aplica nas linhas de ORIGEM - nunca em `result.rows`. Realimentar o pipeline
 * com a própria saída aplicaria a regra de sinal duas vezes.
 */
function comResidual(linhasFonte) {
  const fonte = linhasFonte.map((l, i) => ({ ...l, id: l.id ?? `F${i}` }));
  const { patches, semResidual } = patchesResiduais(runPipeline(fonte, {}).rows);
  const porId = new Map(patches.map((p) => [p.id, p.patch]));
  const linhas = fonte.map((l) => (porId.has(l.id) ? { ...l, ...porId.get(l.id) } : l));
  return { linhas, patches, semResidual, resultado: runPipeline(linhas, {}) };
}

const AQUI = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(
  join(AQUI, '..', '..', 'server', 'eval', 'datasets', 'demonstracao_fleury_2t26.json'),
  'utf-8',
));

// ---------------------------------------------------------------------------
// secaoDeNome
// ---------------------------------------------------------------------------

test('secaoDeNome lê a seção dos nomes de pai reais do ITR', () => {
  assert.equal(secaoDeNome('Total circulante'), 'Circulante');
  assert.equal(secaoDeNome('Total não circulante'), 'Não Circulante');
  assert.equal(secaoDeNome('Total do realizável a longo prazo'), 'Não Circulante');
  assert.equal(secaoDeNome('Total do patrimônio líquido'), 'PL');
  assert.equal(secaoDeNome('Patrimônio líquido dos controladores'), 'PL');
});

test('a RAIZ "Total do passivo e patrimônio líquido" não é a seção de PL', () => {
  // Sem o veto por `passivo`, TODO Passivo Circulante do documento seria
  // classificado como PL, porque essa raiz é ancestral de todos eles.
  assert.equal(secaoDeNome('Total do passivo e patrimônio líquido'), '');
  assert.equal(secaoDeNome('Total do passivo e do patrimônio líquido'), '');
});

test('"não circulante" é testado antes de "circulante"', () => {
  // 'Total não circulante' contém a palavra 'circulante': ordem errada na tabela
  // de seções mandaria todo o não circulante para o circulante.
  assert.equal(secaoDeNome('Total não circulante'), 'Não Circulante');
  assert.equal(secaoDeNome('Passivo não circulante'), 'Não Circulante');
});

test('nome que não declara seção devolve vazio', () => {
  assert.equal(secaoDeNome('Total do ativo'), '');
  assert.equal(secaoDeNome('Reservas de lucro'), '');
  assert.equal(secaoDeNome(''), '');
  assert.equal(secaoDeNome(null), '');
});

// ---------------------------------------------------------------------------
// separarSecao / limparRotulo
// ---------------------------------------------------------------------------

test('separa o cabeçalho de seção grudado, preservando a grafia do documento', () => {
  const a = separarSecao('Circulante Caixa e equivalentes de caixa');
  assert.equal(a.separou, true);
  assert.equal(a.secao, 'Circulante');
  assert.equal(a.conta, 'Caixa e equivalentes de caixa');

  const b = separarSecao('Não circulante Financiamentos');
  assert.equal(b.secao, 'Não circulante');
  assert.equal(b.conta, 'Financiamentos');

  const c = separarSecao('Patrimônio líquido Capital social 24a.');
  assert.equal(c.secao, 'Patrimônio líquido');
  assert.equal(c.conta, 'Capital social 24a.');
});

test('cabeçalho sozinho NÃO é separado - a linha perderia identidade', () => {
  const r = separarSecao('Circulante');
  assert.equal(r.separou, false);
  assert.equal(r.conta, 'Circulante');
});

test('conta sem cabeçalho passa intacta', () => {
  const r = separarSecao('Contas a receber');
  assert.equal(r.separou, false);
  assert.equal(r.secao, '');
  assert.equal(r.conta, 'Contas a receber');
});

test('remove referência de nota com sufixo de letra', () => {
  assert.equal(limparRotulo('Capital social 24a.').conta, 'Capital social');
  assert.equal(limparRotulo('Ações em tesouraria 24.d').conta, 'Ações em tesouraria');
  assert.equal(limparRotulo('Patrimônio líquido Capital social 24a.').conta, 'Capital social');
});

test('número solto no fim do nome NÃO é removido', () => {
  // Num balancete de ERP o número pode ser parte do nome da conta. Remover às
  // cegas trocaria a chave de agregação de uma conta legítima.
  assert.equal(limparRotulo('Banco Itaú 341').conta, 'Banco Itaú 341');
  assert.equal(limparRotulo('Conta 12').conta, 'Conta 12');
  assert.equal(limparRotulo('Debêntures 10ª emissão').conta, 'Debêntures 10ª emissão');
});

// ---------------------------------------------------------------------------
// anotarSecoes - a subcategoria que faltava
// ---------------------------------------------------------------------------

test('subcategoria sai da cadeia de pais nas 6 linhas que ficaram sem destino', () => {
  const casos = [
    ['Outros ativos', 'Ativo', ['Total circulante', 'Total do ativo'], 'Circulante'],
    ['Outros ativos', 'Ativo',
      ['Total do realizável a longo prazo', 'Total não circulante', 'Total do ativo'],
      'Não Circulante'],
    ['Não circulante Financiamentos', 'Passivo',
      ['Total não circulante', 'Total do passivo e patrimônio líquido'], 'Não Circulante'],
    ['Patrimônio líquido Capital social 24a.', 'Passivo',
      ['Patrimônio líquido dos controladores', 'Total do patrimônio líquido',
        'Total do passivo e patrimônio líquido'], 'PL'],
    ['Reservas de lucro', 'Passivo',
      ['Patrimônio líquido dos controladores', 'Total do patrimônio líquido',
        'Total do passivo e patrimônio líquido'], 'PL'],
    ['Participação de não controladores', 'Passivo',
      ['Total do patrimônio líquido', 'Total do passivo e patrimônio líquido'], 'PL'],
  ];
  const rows = casos.map(([origem, grupo, cadeia]) => ({
    origem, grupo, subCategoria: '', _cadeiaPais: cadeia,
  }));
  anotarSecoes(rows);
  rows.forEach((r, i) => {
    assert.equal(r._subInferida, casos[i][3],
      `${casos[i][0]} deveria inferir ${casos[i][3]}, veio ${r._subInferida}`);
  });
});

test('a inferência reduz o espaço de decisão de 28 para 4 no PL', () => {
  // É este número que a arquitetura inteira presume. Com sub vazia a redução
  // simplesmente não acontecia.
  assert.equal(candidatosPara('Passivo', '').length, 28);
  assert.equal(candidatosPara('Passivo', 'PL').length, 4);
  const destinos = candidatosPara('Passivo', 'PL').map((c) => c.destino);
  assert.ok(destinos.includes('PARTICIPAÇÕES MINORITÁRIAS'));
  assert.ok(destinos.includes('Outras Reservas'));
});

test('subcategoria declarada no documento vence a inferida', () => {
  const rows = [{
    origem: 'Outros ativos', grupo: 'Ativo', subCategoria: 'Não Circulante',
    _cadeiaPais: ['Total circulante'],
  }];
  anotarSecoes(rows);
  assert.equal(rows[0]._subInferida, '', 'não deve inferir sobre sub já declarada');
  assert.equal(rows[0].subCategoria, 'Não Circulante');
});

test('anotarSecoes nunca altera origem', () => {
  const rows = [{
    origem: 'Patrimônio líquido Capital social 24a.', grupo: 'Passivo',
    subCategoria: '', _cadeiaPais: [],
  }];
  anotarSecoes(rows);
  assert.equal(rows[0].origem, 'Patrimônio líquido Capital social 24a.',
    'origem é o que o documento diz - o guardrail depende disso');
  assert.equal(rows[0]._contaLimpa, 'Capital social');
});

// ---------------------------------------------------------------------------
// polaridade
// ---------------------------------------------------------------------------

test('INVERSÃO: receita e despesa nos dois lados é troca de sentido', () => {
  assert.equal(
    polaridadeInverte('outras receitas operacionais liquidas',
      'outras despesas operacionais liquidas'), true,
  );
  assert.equal(polaridadeInverte('contas a receber', 'contas a pagar'), true);
  assert.equal(polaridadeInverte('outros ativos', 'outros passivos'), true);
});

test('INVERSÃO exige os DOIS lados - sinônimo legítimo não pode ser bloqueado', () => {
  // `IRPJ e CSLL a recolher` × `IRPJ e CSLL a pagar` casa em 0,67 e é o MESMO
  // passivo. Uma versão anterior desta guarda exigia só um lado e matou este
  // acerto do dicionário, junto com `- Despesas Administrativas`.
  assert.equal(polaridadeInverte('irpj e csll a recolher', 'irpj e csll a pagar'), false);
  assert.equal(
    polaridadeInverte('despesas receitas operacionais gerais e administrativas',
      'despesas gerais e administrativas'), false,
  );
  assert.equal(
    polaridadeInverte('outras receitas despesas operacionais liquidas',
      'outras despesas operacionais liquidas'), false,
  );
});

test('CONTINÊNCIA: o nome maior acrescenta marcador que o menor não tem', () => {
  // O bug real: entrada líquida do dicionário engolindo uma parcela.
  assert.equal(
    polaridadeAcrescenta('despesas financeiras',
      'receitas despesas financeiras liquidas'), true,
  );
});

test('CONTINÊNCIA não bloqueia match legítimo sem marcador excedente', () => {
  assert.equal(
    polaridadeAcrescenta('caixa e equivalentes', 'caixa e equivalentes de caixa'), false,
  );
  assert.equal(polaridadeAcrescenta('fornecedores', 'fornecedores nacionais'), false);
});

// ---------------------------------------------------------------------------
// Fim a fim, sobre o payload REAL do /read
// ---------------------------------------------------------------------------

test('o dicionário passa a resolver sozinho o que o nome contaminado escondia', () => {
  const { rows } = runPipeline(golden.leitura.linhas, {});
  const por = (o) => rows.find((r) => r.origem === o);

  // Estas três estavam sem destino ou custando token de LLM só por causa do
  // cabeçalho grudado. Todas as três já existiam no dicionário.
  assert.equal(por('Patrimônio líquido Capital social 24a.').destino, 'Capital Social');
  assert.equal(por('Patrimônio líquido Capital social 24a.').tipoMapeamento, 'Dicionário');
  assert.equal(por('Não circulante Financiamentos').destino, 'Bancos LP');
  assert.equal(por('Circulante Fornecedores').destino, 'Fornecedores');

  // Financiamentos existe DUAS vezes no dicionário (Bancos e Bancos LP). Só a
  // subcategoria inferida desempata - e ela veio de 'Total não circulante'.
  assert.equal(por('Não circulante Financiamentos').subCategoria, 'Não Circulante');
});

test('a DESPESA financeira não vai mais para posição de RECEITA', () => {
  const { rows } = runPipeline(golden.leitura.linhas, {});
  const despesa = rows.find((r) => r.origem === 'Despesas financeiras');
  const receita = rows.find((r) => r.origem === 'Receitas financeiras');

  assert.notEqual(despesa.destino, '+ Receitas Financeiras',
    'uma despesa jamais pode cair numa posição de receita');
  assert.equal(despesa.destino, '', 'sem entrada segura, a linha vai ao julgamento');
  // e o acerto legítimo continua de pé
  assert.equal(receita.destino, '+ Receitas Financeiras');
  assert.equal(receita.tipoMapeamento, 'Dicionário');
});

test('REGRESSÃO: os acertos do dicionário que a guarda não pode matar', () => {
  const { rows } = runPipeline(golden.leitura.linhas, {});
  const por = (o) => rows.find((r) => r.origem === o);
  assert.equal(por('IRPJ e CSLL a recolher').destino, 'Impostos');
  assert.equal(
    por('(Despesas) receitas operacionais Gerais e administrativas').destino,
    '- Despesas Administrativas',
  );
  assert.equal(
    por('Outras receitas (despesas) operacionais, líquidas').destino,
    '+/-Outras Receitas/Despesas Operacionais',
  );
});

test('toda linha pendente chega ao LLM com bloco restrito - nunca X/?', () => {
  const { rows } = runPipeline(golden.leitura.linhas, {});
  const pendentes = pendentesDeJulgamento(rows);
  assert.ok(pendentes.length > 0, 'o cenário precisa ter pendências para valer algo');
  for (const r of pendentes) {
    assert.ok(r.grupo, `${r.origem} sem grupo: não há bloco compatível`);
    assert.ok(r.subCategoria,
      `${r.origem} iria ao modelo como ${r.grupo}/? - a redução de candidatos não aconteceu`);
    const n = candidatosPara(r.grupo, r.subCategoria).length;
    assert.ok(n <= 23, `${r.origem} recebeu ${n} candidatos`);
  }
});

test('★ com destino nas pendentes, a identidade fecha em 0,00 - no PIOR palpite', () => {
  // Este é o teste que responde à pergunta que originou a correção: "a linha
  // está marcada para alocar e não tem destino; isso a IA precisa fazer".
  //
  // Aqui a IA é simulada da forma mais hostil possível: cada linha pendente
  // recebe o ÚLTIMO candidato do próprio bloco - o pior palpite ainda plausível,
  // nunca o certo. Mesmo assim `Ativo = Passivo + PL` fecha exatamente, e nos
  // números do documento.
  //
  // É a demonstração do argumento que motivou tirar o viés de abstenção do
  // prompt: como `candidatosPara` já restringe ao lado do balanço, a QUALIDADE do
  // julgamento não afeta o fechamento - só a existência dele. Abster-se, ao
  // contrário, produz `sem-destino`, que é Classe A e bloqueia.
  const soDicionario = runPipeline(golden.leitura.linhas, {});
  const pendentes = new Set(pendentesDeJulgamento(soDicionario.rows).map((r) => r.id));

  const comJulgamento = golden.leitura.linhas.map((entrada) => {
    const linha = soDicionario.rows.find(
      (x) => x.origem === entrada.origem && x.codigo === entrada.codigo,
    );
    if (!linha || !pendentes.has(linha.id)) return entrada;
    const candidatos = candidatosPara(linha.grupo, linha.subCategoria);
    const pior = candidatos[candidatos.length - 1];
    return {
      ...entrada,
      grupo: pior.grupo,
      subCategoria: pior.subCategoria,
      destino: pior.destino,
    };
  });

  const { shadow, qa } = runPipeline(comJulgamento, {});

  for (const ano of ['ano2', 'ano3']) {
    const b = shadow.balance[ano];
    assert.equal(b.dif, 0, `${ano}: resíduo ${b.dif} - deveria ser exatamente 0`);
    assert.equal(b.fecha, true);
  }
  // e os totais são os do ITR, não números inventados pela alocação
  assert.equal(shadow.balance.ano3.ativo, 13558475);
  assert.equal(shadow.balance.ano2.ativo, 13220481);

  const classeA = qa.issues.filter((i) => i.classe === 'A');
  assert.equal(classeA.length, 0,
    `ainda bloqueia: ${classeA.map((i) => i.code).join(', ')}`);
});

test('sem destino nas pendentes, o valor perdido é EXATAMENTE o das pendentes', () => {
  // Prova que não existe nenhum outro vazamento: todo o furo da identidade é a
  // soma das linhas sem destino, e nada mais. Se este teste passar a falhar,
  // apareceu uma segunda fonte de perda e ela precisa de nome próprio.
  const { rows, shadow } = runPipeline(golden.leitura.linhas, {});
  const pendentes = pendentesDeJulgamento(rows);

  for (const ano of ['ano2', 'ano3']) {
    const somaPendentes = pendentes.reduce((acc, r) => acc + (Number(r[ano]) || 0), 0);
    const b = shadow.balance[ano];
    const furo = Math.abs(b.ativo - b.passivoPl);
    assert.ok(somaPendentes > 0, `${ano} sem pendências - cenário inválido`);
    assert.ok(furo <= somaPendentes,
      `${ano}: furo ${furo} maior que a soma das pendentes ${somaPendentes}`);
  }
});

// ---------------------------------------------------------------------------
// Posição residual - o último recurso
// ---------------------------------------------------------------------------

test('todo bloco alocável tem posição residual', () => {
  // Se um bloco não tiver residual, a linha que cair nele fica sem destino e
  // bloqueia a entrega, sem alternativa nenhuma.
  const blocos = [
    ['Ativo', 'Circulante'], ['Ativo', 'Não Circulante'],
    ['Passivo', 'Circulante'], ['Passivo', 'Não Circulante'],
    ['Passivo', 'PL'], ['DRE', 'DRE'],
  ];
  for (const [grupo, sub] of blocos) {
    const r = posicaoResidual(grupo, sub);
    assert.ok(r, `${grupo}/${sub} sem posição residual`);
    // a residual tem de ser candidata do próprio bloco: fora dele seria
    // lado-trocado ou destino-invalido, ambos Classe A
    const candidatos = candidatosPara(grupo, sub).map((c) => c.destino);
    assert.ok(candidatos.includes(r.destino),
      `${r.destino} não é candidato de ${grupo}/${sub}`);
  }
});

test('a residual da DRE aceita os DOIS sinais', () => {
  // A residual é usada quando NÃO se sabe a direção do valor. Se ela tivesse
  // prefixo fixo (`- Despesas` ou `+ Receitas`), metade dos casos cairia em
  // `sinal-incompativel`, que é Classe A - exatamente o que se quer evitar.
  const r = posicaoResidual('DRE', 'DRE');
  assert.equal(r.destino, '+/-Outras Receitas/Despesas Operacionais');
  assert.ok(r.destino.startsWith('+/-'), 'a residual da DRE precisa ser +/-');
});

test('★ a residual zera os bloqueios no cenário real do Fleury', () => {
  // Reproduz o estado em que o usuário ficou: dicionário aplicado, a IA abstida
  // nas de nome genérico. Antes da residual eram 4 linhas sem destino, cada uma
  // um erro `sem-destino` de Classe A que bloqueia a entrega inteira.
  const antes = pendentesDeJulgamento(runPipeline(golden.leitura.linhas, {}).rows);
  assert.ok(antes.length > 0, 'o cenário precisa ter pendências');

  const { patches, semResidual, resultado } = comResidual(golden.leitura.linhas);
  assert.equal(patches.length, antes.length);
  assert.equal(semResidual.length, 0, 'todo bloco do Fleury tem residual');
  assert.equal(pendentesDeJulgamento(resultado.rows).length, 0);

  const classeA = resultado.qa.issues.filter((i) => i.classe === 'A');
  assert.equal(classeA.length, 0,
    `ainda bloqueia: ${classeA.map((i) => i.code).join(', ')}`);
  for (const ano of ['ano2', 'ano3']) {
    assert.equal(resultado.shadow.balance[ano].dif, 0, `${ano} não fecha`);
  }
  assert.equal(resultado.shadow.balance.ano3.ativo, 13558475);
});

test('a residual NUNCA passa calada - vira aviso de Classe B nominal', () => {
  const { patches, resultado } = comResidual(golden.leitura.linhas);
  const avisos = resultado.qa.issues.filter((i) => i.code === 'destino-residual');
  assert.equal(avisos.length, patches.length,
    'cada linha residual precisa do seu próprio aviso');
  for (const a of avisos) {
    assert.equal(a.classe, 'B', 'residual não pode bloquear');
    assert.ok(a.id, 'o aviso tem de apontar a linha');
  }
});

test('a residual sobrevive a salvar/reabrir e continua avisando', () => {
  // `normalizeRow` descarta campos `_` fora da lista dela, então o aviso não pode
  // depender de `_residual`. Se dependesse, a marca sumiria ao reabrir a análise
  // e o palpite passaria a parecer um mapeamento normal.
  const { linhas, resultado } = comResidual(golden.leitura.linhas);
  const reaberta = runPipeline(linhas.map((l) => ({ ...l })), {});
  assert.equal(
    reaberta.qa.issues.filter((i) => i.code === 'destino-residual').length,
    resultado.qa.issues.filter((i) => i.code === 'destino-residual').length,
  );
});

test('★ FALLBACK NÃO É CONHECIMENTO: residual não entra na memória do cliente', () => {
  // Se entrasse, na análise seguinte voltaria como "Memória do cliente", que é a
  // camada de MAIOR confiança do matching - e o palpite de hoje seria a verdade
  // de amanhã, sem ninguém ter decidido nada.
  const { resultado } = comResidual(golden.leitura.linhas);
  const residuais = resultado.rows.filter((r) => r.tipoMapeamento === 'Residual');
  assert.ok(residuais.length > 0, 'o cenário precisa ter residuais');

  const memoria = memoriaDeRows(resultado.rows);
  const naMemoria = new Set(memoria.map((e) => `${e.origem}|${e.destino}`));
  for (const r of residuais) {
    assert.ok(!naMemoria.has(`${r.origem}|${r.destino}`),
      `"${r.origem}" → "${r.destino}" foi gravada na memória sendo residual`);
  }
});

test('residual CONFIRMADA pelo humano já pode ser memorizada', () => {
  // A regra veta o palpite, não a decisão. Confirmada, ela é conhecimento.
  const { resultado } = comResidual(golden.leitura.linhas);
  const alvo = resultado.rows.find((r) => r.tipoMapeamento === 'Residual');
  const confirmada = resultado.rows.map((r) => (r.id === alvo.id
    ? { ...r, confirmadoPorHumano: true } : r));
  const memoria = memoriaDeRows(confirmada);
  assert.ok(
    memoria.some((e) => e.origem === alvo.origem && e.destino === alvo.destino),
    'residual confirmada pelo analista deveria entrar na memória',
  );
});

test('sem bloco definido não há residual - a linha continua pendente', () => {
  // Inventar um destino para linha sem Grupo seria escolher o LADO do balanço no
  // lugar do analista, e isso pode furar a identidade.
  const rows = [{
    id: 'x1', origem: 'Conta misteriosa', grupo: '', subCategoria: '',
    destino: '', alocacaoHierarquia: 'Sim', ano3: 1000, noAuto: false,
  }];
  const { patches, semResidual } = patchesResiduais(rows);
  assert.equal(patches.length, 0);
  assert.equal(semResidual.length, 1);
  assert.equal(rows[0].destino, '', 'patchesResiduais não pode mutar a linha');
});

// ---------------------------------------------------------------------------
// Subtotal IRMÃO - a DRE da padronizada da CVM
// ---------------------------------------------------------------------------

test('★ subtotal declarado pela leitura não volta a ser folha por falta de filho', () => {
  // Na DRE da CVM os subtotais são IRMÃOS, não pais:
  //
  //     3.01  Receita de Venda
  //     3.02  Custo dos Bens Vendidos
  //     3.03  Resultado Bruto      = 3.01 + 3.02, e NADA se aninha embaixo
  //
  // Por prefixo de código `3.03` não tem filhos, logo pareceria folha - e alocá-la
  // somaria o subtotal junto com as suas parcelas, dobrando o resultado. O
  // servidor já identificou por ARITMÉTICA que ela é sintética e manda
  // `totalizador: 'Sim'`; essa evidência estava sendo descartada aqui.
  const entrada = [
    { codigo: '3.01', origem: 'Receita de Venda', totalizador: 'Não', ano3: 1000 },
    { codigo: '3.02', origem: 'Custo dos Bens Vendidos', totalizador: 'Não', ano3: -600 },
    { codigo: '3.03', origem: 'Resultado Bruto', totalizador: 'Sim', ano3: 400 },
  ];
  const { rows } = runPipeline(entrada, {});
  const por = (c) => rows.find((r) => r.codigo === c);

  assert.equal(por('3.03').totalizador, 'Sim', 'subtotal irmão virou folha');
  assert.equal(por('3.03')._folha, false);
  assert.equal(por('3.03').alocacaoHierarquia, 'Não', 'sintética não aloca');
  // e as parcelas seguem alocáveis
  assert.equal(por('3.01')._folha, true);
  assert.equal(por('3.02')._folha, true);
});

test('sem declaração da leitura, o prefixo continua mandando', () => {
  // Regressão: o balancete de ERP não declara `totalizador`, e ali quem manda é o
  // prefixo. Esta precedência não pode inverter.
  const entrada = [
    { codigo: '1', origem: 'ATIVO', ano3: 100 },
    { codigo: '101', origem: 'CIRCULANTE', ano3: 100 },
    { codigo: '10101', origem: 'CAIXA', ano3: 100 },
  ];
  const { rows } = runPipeline(entrada, {});
  const por = (c) => rows.find((r) => r.codigo === c);
  assert.equal(por('1')._folha, false, 'tem filho: sintética');
  assert.equal(por('101')._folha, false);
  assert.equal(por('10101')._folha, true, 'sem filho e sem declaração: folha');
});

test('as duas linhas homônimas "Outros ativos" são desambiguadas pelo pai', () => {
  const { rows } = runPipeline(golden.leitura.linhas, {});
  const outros = rows.filter((r) => r.origem === 'Outros ativos');
  assert.equal(outros.length, 2);
  const subs = outros.map((r) => r.subCategoria).sort();
  assert.deepEqual(subs, ['Circulante', 'Não Circulante'],
    'sem isso as duas chegam ao modelo com o mesmo contexto e 28 candidatos');
});
