// Testes da camada de APRESENTAÇÃO - sem DOM, sem React, sem rede.
//
// O que se prova aqui, e por que vale um teste próprio:
//
//  1. A PRECEDÊNCIA DA CONFIGURAÇÃO. `localStorage` tem de vencer o
//     `runtime-config.json`. Se essa ordem inverter, o campo das Configurações
//     deixa de ter efeito e o operador troca o hostname do tunnel sem entender
//     por que nada muda - que é justamente o problema que a config em runtime
//     existe para resolver.
//
//  2. AS FUNÇÕES QUE MONTAM OS PAINÉIS. A decisão "este balde é vazamento e vai
//     vermelho", "esta issue bloqueia a entrega" e "isto é uma regra nova de
//     memória" é a tese do projeto virando pixel. Dentro do JSX ela só seria
//     testável com DOM; extraída para `lib/apresentacao.js`, é `node:test` puro.
//
//  3. QUE O SELETOR DE DESTINO NÃO PODE CAUSAR CLASSE A. `candidatosPara` nunca
//     devolve subtotal - então a interface humana e a interface do modelo veem
//     apenas escolhas que, no pior caso, são erro de julgamento (Classe B).
//
//  4. A LEITURA DE TABELA COLADA / CSV. É o único ponto do portal que produz
//     NÚMERO a partir de texto livre. Um parser que desloca uma coluna produz um
//     balanço errado sem nenhum sintoma - exatamente a classe de falha que o v2
//     existe para eliminar. Por isso ele vive em `lib/tabela.js` e não no `.jsx`.
//
// Sobre mockar `globalThis`: `config.js` lê `localStorage` e `fetch` de
// `globalThis` de propósito, e não por import. É o que permite testá-lo em Node
// sem jsdom e sem injeção de dependência artificial.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  linhasDaTrilha, resumoDaTrilha, BALDES_TRILHA,
  separarIssues, idsComErroClasseA, badgeDoBalanco,
  montarDiffMemoria, chaveMemoria,
  blocosDaShadow, shadowLinhaTemValor,
} from '../src/lib/apresentacao.js';
import { tabelaParaLinhas, detectarDelimitador } from '../src/lib/tabela.js';
import { candidatosPara, CONTAS_ALOCAVEIS, SUBTOTAIS } from '../src/core/planoContas.js';
import { runPipeline, memoriaDeRows } from '../src/core/index.js';

// ---------------------------------------------------------------------------
// Ambiente falso para config.js
// ---------------------------------------------------------------------------
/** localStorage em memória, com a mesma superfície que o do navegador. */
function storageFalso(inicial = {}) {
  const mapa = new Map(Object.entries(inicial));
  return {
    getItem: (k) => (mapa.has(k) ? mapa.get(k) : null),
    setItem: (k, v) => { mapa.set(k, String(v)); },
    removeItem: (k) => { mapa.delete(k); },
    clear: () => mapa.clear(),
    _mapa: mapa,
  };
}

/** `fetch` que devolve sempre o mesmo JSON e conta as chamadas. */
function fetchFalso(json, { ok = true } = {}) {
  const chamadas = [];
  const f = async (url, init) => {
    chamadas.push({ url, init });
    return { ok, status: ok ? 200 : 404, json: async () => json };
  };
  f.chamadas = chamadas;
  return f;
}

/**
 * `config.js` guarda a config resolvida em módulo, e o `import` é cacheado pelo
 * Node. Cada teste recarrega o módulo com uma query única para partir de zero,
 * senão o segundo teste herdaria o estado do primeiro.
 */
async function carregarModuloConfig(sufixo) {
  return import(`../src/lib/config.js?t=${sufixo}`);
}

// ---------------------------------------------------------------------------
// DOIS CANAIS DE AUTENTICAÇÃO
//
// O servidor lê a sessão de `X-Sessao` (`usuario_atual` em
// server/app/db/rotas.py declara `x_sessao: str = Header(default="")`) e a chave
// compartilhada de `Authorization` (`exigir_token` em main.py).
//
// O portal mandava o JWT da sessão em `Authorization`. Efeito no ar: o login
// funcionava - é a única rota que não exige sessão - e TODA rota de dados
// devolvia 401 "Sessão ausente". No painel isso aparecia como 0 clientes, 0
// análises e "não consegui carregar o histórico", ou seja, como banco vazio.
// E a dica de 401 culpava o token de API, o que desviou o diagnóstico duas vezes.
// ---------------------------------------------------------------------------

/**
 * Captura os headers de uma requisição de dados, sem tocar a rede.
 *
 * Usa import SEM query de propósito: `repo.js` importa `'./config.js'`, e um
 * `config.js?t=123` seria outra instância do módulo - a config preparada aqui não
 * seria a que o repositório enxerga, `modoLocal()` daria `true` e nenhuma
 * requisição aconteceria. Foi exatamente o erro da primeira versão deste teste.
 */
async function capturarHeaders({ tokenApi = '' } = {}) {
  const originalFetch = globalThis.fetch;
  const originalStorage = globalThis.localStorage;
  const originalLocation = globalThis.location;
  const capturadas = [];
  globalThis.fetch = async (url, init) => {
    capturadas.push({ url, headers: init?.headers ?? {} });
    return { ok: true, status: 200, json: async () => [] };
  };
  globalThis.localStorage = storageFalso({
    'allocator:sessao': JSON.stringify({
      token: 'jwt-da-sessao', usuario: { id: 'u1' }, local: false,
    }),
  });
  globalThis.location = { hostname: 'exemplo.github.io' };
  try {
    const config = await import('../src/lib/config.js');
    config.salvarConfig({ apiDados: 'https://dados.example.com', tokenApi });
    const repo = await import('../src/lib/repo.js');
    await repo.listarClientes();
    return capturadas;
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalStorage;
    globalThis.location = originalLocation;
  }
}

test('★ a SESSÃO viaja em X-Sessao, nunca em Authorization', async () => {
  const capturadas = await capturarHeaders();

  assert.equal(capturadas.length, 1, 'esperava uma requisição ao plano de dados');
  const h = capturadas[0].headers;
  assert.equal(h['X-Sessao'], 'jwt-da-sessao',
    'sem X-Sessao o servidor responde 401 "Sessão ausente" em TODA rota de dados');
  assert.ok(!h.Authorization,
    'sem tokenApi configurado, Authorization não deve existir');
  assert.ok(capturadas[0].url.includes('/dados/clientes'),
    `prefixo /dados ausente: ${capturadas[0].url}`);
});

test('★ a INFERÊNCIA também recebe a sessão, sem o chamador pedir', async () => {
  // Se a única credencial aceita em /read fosse o ALLOCATOR_API_TOKEN, cada
  // pessoa convidada a testar o portal teria de colar o segredo à mão - e
  // publicá-lo no runtime-config.json para evitar isso o exporia num repositório
  // PÚBLICO, acabando com a proteção. Ver `exigir_token` em server/app/main.py.
  const originalFetch = globalThis.fetch;
  const originalStorage = globalThis.localStorage;
  const originalLocation = globalThis.location;
  const capturadas = [];
  globalThis.fetch = async (url, init) => {
    capturadas.push({ url, headers: init?.headers ?? {} });
    return { ok: true, status: 200, json: async () => ({ status: 'ok' }) };
  };
  globalThis.localStorage = storageFalso({
    'allocator:sessao': JSON.stringify({ token: 'jwt-da-sessao', local: false }),
  });
  globalThis.location = { hostname: 'exemplo.github.io' };
  try {
    const config = await import('../src/lib/config.js');
    config.salvarConfig({ apiInferencia: 'https://tunel.example.com' });
    const api = await import('../src/lib/api.js');
    await api.health();
    assert.equal(capturadas.length, 1);
    assert.equal(capturadas[0].headers['X-Sessao'], 'jwt-da-sessao',
      'sem a sessão, /read exigiria o segredo compartilhado colado à mão');
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalStorage;
    globalThis.location = originalLocation;
  }
});

test('a chave da sessão é uma só nos dois módulos', async () => {
  // Duas constantes iguais divergem. O sintoma seria sessão que existe e não é
  // enviada, e o diagnóstico levaria horas.
  const api = await import('../src/lib/api.js');
  const repo = await import('../src/lib/repo.js');
  assert.equal(repo.CHAVES.sessao, api.CHAVE_SESSAO);
});

test('sessão e chave de API CONVIVEM quando as duas existem', async () => {
  // Uma implantação endurecida pode pôr `exigir_token` também nas rotas de dados.
  const capturadas = await capturarHeaders({ tokenApi: 'chave-compartilhada' });

  const h = capturadas[0].headers;
  assert.equal(h['X-Sessao'], 'jwt-da-sessao');
  assert.equal(h.Authorization, 'Bearer chave-compartilhada',
    'a chave da API não pode ser substituída pela sessão');
});

test('carregarConfig - localStorage tem PRECEDÊNCIA sobre runtime-config.json', async () => {
  const doArquivo = {
    apiDados: 'https://do-arquivo.example.com',
    apiInferencia: 'https://inferencia-do-arquivo.example.com',
    tokenApi: 'token-do-arquivo',
    versao: '2.0.0',
  };
  const doUsuario = {
    apiDados: 'https://do-usuario.example.com',
    apiInferencia: 'https://tunnel-novo.trycloudflare.com',
  };

  globalThis.localStorage = storageFalso({
    'allocator:config': JSON.stringify(doUsuario),
  });
  globalThis.fetch = fetchFalso(doArquivo);

  const cfg = await carregarModuloConfig('precedencia');
  const c = await cfg.carregarConfig();

  // O que o usuário definiu vence, campo por campo.
  assert.equal(c.apiDados, 'https://do-usuario.example.com');
  assert.equal(c.apiInferencia, 'https://tunnel-novo.trycloudflare.com');
  // O que ele NÃO definiu vem do arquivo - a sobreposição é parcial, não total.
  assert.equal(c.tokenApi, 'token-do-arquivo');
  assert.equal(c.fonte, 'localStorage');

  // `getConfig()` é síncrono e devolve o mesmo valor já resolvido: é assim que
  // `api.js` e `repo.js` leem a config a cada requisição.
  assert.deepEqual(cfg.getConfig(), c);
});

test('carregarConfig - sem override, vale o runtime-config.json (relativo, no-store)', async () => {
  globalThis.localStorage = storageFalso();
  globalThis.fetch = fetchFalso({
    apiDados: 'https://allocator-api.onrender.com',
    apiInferencia: 'https://tunnel.trycloudflare.com',
    tokenApi: '',
    versao: '2.0.0',
  });

  const cfg = await carregarModuloConfig('arquivo');
  const c = await cfg.carregarConfig();

  assert.equal(c.apiDados, 'https://allocator-api.onrender.com');
  assert.equal(c.fonte, 'runtime-config');

  // Caminho RELATIVO: absoluto pediria o arquivo na raiz do domínio, e o Pages de
  // projeto serve num subcaminho. `no-store` porque o cache serviria a versão
  // anterior e o hostname trocado não teria efeito visível.
  const [chamada] = globalThis.fetch.chamadas;
  assert.equal(chamada.url, './runtime-config.json');
  assert.equal(chamada.init.cache, 'no-store');
});

test('carregarConfig - arquivo ausente ou inválido degrada, não quebra', async () => {
  globalThis.localStorage = storageFalso();
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };

  const cfg = await carregarModuloConfig('sem-arquivo');
  const c = await cfg.carregarConfig();

  // Sem `location` (estamos em Node), `ehAmbienteLocal()` é verdadeiro e os
  // padrões de desenvolvimento entram. O que importa é que NÃO lança.
  assert.equal(typeof c.apiDados, 'string');
  assert.equal(c.versao, '2.0.0');
});

test('salvarConfig - grava em localStorage e passa a valer na hora', async () => {
  globalThis.localStorage = storageFalso();
  globalThis.fetch = fetchFalso({ apiDados: 'https://arquivo.example.com', tokenApi: 'tk' });

  const cfg = await carregarModuloConfig('salvar');
  await cfg.carregarConfig();
  assert.equal(cfg.getConfig().apiDados, 'https://arquivo.example.com');

  const nova = cfg.salvarConfig({ apiInferencia: 'https://novo-tunnel.trycloudflare.com/' });
  // Barra final removida: `${base}/read` não pode virar `${base}//read`.
  assert.equal(nova.apiInferencia, 'https://novo-tunnel.trycloudflare.com');
  assert.equal(nova.apiDados, 'https://arquivo.example.com', 'o campo não tocado continua');
  assert.equal(cfg.getConfig().apiInferencia, 'https://novo-tunnel.trycloudflare.com');

  const gravado = JSON.parse(globalThis.localStorage.getItem('allocator:config'));
  assert.equal(gravado.apiInferencia, 'https://novo-tunnel.trycloudflare.com');

  // Limpar um campo FORÇA o modo local, mesmo havendo valor no arquivo: é o que o
  // botão de limpar precisa fazer, e o valor antigo não pode voltar pela camada
  // de baixo.
  const limpa = cfg.salvarConfig({ apiDados: '' });
  assert.equal(limpa.apiDados, '');
});

// ---------------------------------------------------------------------------
// TRILHA DE VALOR
// ---------------------------------------------------------------------------
/** Trilha sintética com vazamento em três baldes distintos. */
const TRILHA_COM_VAZAMENTO = {
  folhasSim: { ano1: 0, ano2: 0, ano3: 1000 },
  alocado: { ano1: 0, ano2: 0, ano3: 700 },
  agregado: { ano1: 0, ano2: 0, ano3: 700 },
  orfao: { ano1: 0, ano2: 0, ano3: 120 },
  subtotal: { ano1: 0, ano2: 0, ano3: 80 },
  semDestino: { ano1: 0, ano2: 0, ano3: 0 },
  ladoTrocado: { ano1: 0, ano2: 0, ano3: 100 },
  memoDre: { ano1: 0, ano2: 0, ano3: 250 },
  perdas: { ano1: 0, ano2: 0, ano3: 300 },
  conservado: { ano1: true, ano2: true, ano3: true },
  ok: false,
  detalhes: {
    orfao: [{ id: 'r1', origem: 'MUTUO FINANCEIRO L/P', destino: 'Mútuo Financeiro L/P', ano3: 120 }],
    subtotal: [{ id: 'r2', origem: 'ESTOQUE FINAL', destino: 'Estoques', ano3: 80 }],
    semDestino: [],
    ladoTrocado: [{ id: 'r3', origem: 'CLIENTES', ladoLinha: 'ativo', ladoDestino: 'passivoPl', ano3: 100 }],
    memoDre: [{ id: 'r4', origem: 'DEPRECIACAO', destino: '- Depreciação e amortização (imob e intang)', ano3: 250 }],
  },
};

test('linhasDaTrilha - a ordem e a semântica dos baldes da equação de conservação', () => {
  const linhas = linhasDaTrilha(TRILHA_COM_VAZAMENTO, 'ano3');

  // A ordem é a da leitura: origem, depois o que chegou, depois cada vazamento,
  // e o memorando por último (porque não é vazamento).
  assert.deepEqual(linhas.map((l) => l.campo), [
    'folhasSim', 'alocado', 'orfao', 'subtotal', 'semDestino', 'ladoTrocado', 'memoDre',
  ]);
  assert.equal(linhas.length, BALDES_TRILHA.length);

  const por = Object.fromEntries(linhas.map((l) => [l.campo, l]));

  // A equação fecha: o que chegou + as perdas = as folhas alocadas.
  const perdas = por.orfao.valor + por.subtotal.valor
    + por.semDestino.valor + por.ladoTrocado.valor;
  assert.equal(por.alocado.valor + perdas, por.folhasSim.valor);

  // VERMELHO só nas perdas não-zero.
  assert.equal(por.orfao.alerta, true);
  assert.equal(por.subtotal.alerta, true);
  assert.equal(por.ladoTrocado.alerta, true);
  assert.equal(por.semDestino.alerta, false, 'balde zerado não pode alarmar');
  assert.equal(por.folhasSim.alerta, false, 'a origem não é perda');
  assert.equal(por.alocado.alerta, false, 'chegar ao destino é o comportamento desejado');

  // ÂMBAR, nunca vermelho: memorando da DRE NÃO é perda. O valor está na Shadow;
  // só não alcança o Lucro Líquido. Pintar de vermelho mandaria o analista caçar
  // um erro que não existe.
  assert.equal(por.memoDre.alerta, false);
  assert.equal(por.memoDre.atencao, true);
  assert.match(por.memoDre.explicacao, /NÃO é perda/);

  // Clicável apenas quando há detalhe E valor.
  assert.equal(por.orfao.temDetalhes, true);
  assert.equal(por.orfao.nDetalhes, 1);
  assert.equal(por.semDestino.temDetalhes, false);
});

test('linhasDaTrilha - ano sem movimento tem todos os baldes em zero e nada alarma', () => {
  const linhas = linhasDaTrilha(TRILHA_COM_VAZAMENTO, 'ano1');
  assert.ok(linhas.every((l) => l.zero));
  assert.ok(linhas.every((l) => !l.alerta && !l.atencao));
});

test('resumoDaTrilha - `conserva` vem de `trilha.ok`, não de uma segunda conta', () => {
  const r = resumoDaTrilha(TRILHA_COM_VAZAMENTO);
  assert.equal(r.conserva, false);
  assert.deepEqual(r.anos, ['ano3'], 'só os anos com movimento aparecem');
  assert.equal(r.perdaTotal, 300);
  assert.equal(r.memoTotal, 250);

  // Recalcular a conservação aqui criaria uma SEGUNDA fonte de verdade capaz de
  // divergir do núcleo. `ok: true` com perdas presentes é contraditório, mas o
  // painel obedece ao núcleo - a contradição é bug de lá, não daqui.
  assert.equal(resumoDaTrilha({ ...TRILHA_COM_VAZAMENTO, ok: true }).conserva, true);

  const vazio = resumoDaTrilha(null);
  assert.equal(vazio.semDados, true);
  assert.deepEqual(vazio.anos, []);
});

// ---------------------------------------------------------------------------
// CLASSE A vs CLASSE B
// ---------------------------------------------------------------------------
const ISSUES = [
  { classe: 'A', level: 'error', code: 'destino-subtotal', msg: 'x', id: 'r2' },
  { classe: 'A', level: 'error', code: 'lado-trocado', msg: 'y', id: 'r3' },
  { classe: 'A', level: 'error', code: 'orfao', msg: 'z', chave: 'k' },
  { classe: 'A', level: 'action', code: 'nao-encerrado', msg: 'w', transporte: -689138.41, ano: 'ano3' },
  { classe: 'B', level: 'warn', code: 'subcat', msg: 'a', id: 'r5' },
  { classe: 'B', level: 'warn', code: 'retificadora', msg: 'b', id: 'r6' },
  { classe: 'B', level: 'info', code: 'zerada', msg: 'c', id: 'r7' },
];

test('separarIssues - Classe A bloqueia, `action` NÃO bloqueia, Classe B nunca bloqueia', () => {
  const s = separarIssues(ISSUES);

  assert.equal(s.classeA.erros.length, 3);
  assert.equal(s.classeA.acoes.length, 1);
  assert.equal(s.classeB.avisos.length, 2);
  assert.equal(s.classeB.infos.length, 1);
  assert.deepEqual(s.contagens, { erros: 3, acoes: 1, avisos: 2, infos: 1 });
  assert.equal(s.bloqueado, true);

  // `action` sozinho NÃO bloqueia: `nao-encerrado` não é erro do sistema nem do
  // modelo, é a natureza do documento. Exige um clique consciente, não conserto.
  const soAcao = separarIssues(ISSUES.filter((i) => i.level === 'action'));
  assert.equal(soAcao.bloqueado, false);
  assert.equal(soAcao.classeA.acoes[0].transporte, -689138.41);

  // Classe B jamais bloqueia, mesmo em volume.
  const soB = separarIssues(ISSUES.filter((i) => i.classe === 'B'));
  assert.equal(soB.bloqueado, false);
  assert.equal(soB.classeA.erros.length, 0);

  assert.equal(separarIssues(undefined).bloqueado, false);
});

test('idsComErroClasseA - só Classe A `error` com id vira destaque na grade', () => {
  const ids = idsComErroClasseA(ISSUES);
  assert.deepEqual([...ids].sort(), ['r2', 'r3']);
  // A issue de órfão não tem `id` (é por chave agregada) e não pode inventar um.
  assert.equal(ids.has('k'), false);
  // Nenhuma Classe B entra: destacar aviso de KPI como bloqueio treinaria o
  // analista a ignorar vermelho.
  assert.equal(ids.has('r5'), false);
});

test('badgeDoBalanco - distingue fechado, NÃO ENCERRADO e divergente', () => {
  const fechado = badgeDoBalanco({
    ativo: 100, passivoPl: 100, dif: 0, difEstendida: 0, difRelativa: 0,
    tolerancia: 0.5, fecha: true, fechaEstendida: true, naoEncerrado: false,
    semDados: false, transporteSugerido: null,
  });
  assert.equal(fechado.estado, 'fechado');
  assert.equal(fechado.texto, 'A = P + PL');

  // O caso do golden dataset real: a simples não fecha, a estendida fecha, e a
  // diferença é exatamente o resultado do período. A v1 chamava isso de erro.
  const naoEncerrado = badgeDoBalanco({
    ativo: 118035576.14, passivoPl: 118724714.55, resultado: -689138.41,
    dif: -689138.41, difEstendida: 0, difRelativa: 0.00584, tolerancia: 59.02,
    fecha: false, fechaEstendida: true, naoEncerrado: true, semDados: false,
    transporteSugerido: -689138.41,
  });
  assert.equal(naoEncerrado.estado, 'nao-encerrado');
  assert.equal(naoEncerrado.transporte, -689138.41);
  assert.match(naoEncerrado.detalhe, /Não é erro/);

  const divergente = badgeDoBalanco({
    ativo: 100, passivoPl: 80, resultado: 0, dif: 20, difEstendida: 20,
    difRelativa: 0.2, tolerancia: 0.5, fecha: false, fechaEstendida: false,
    naoEncerrado: false, semDados: false, transporteSugerido: null,
  });
  assert.equal(divergente.estado, 'divergente');
  assert.equal(divergente.transporte, null);

  assert.equal(badgeDoBalanco({ semDados: true }).estado, 'sem-dados');
  assert.equal(badgeDoBalanco(null).estado, 'sem-dados');
});

// ---------------------------------------------------------------------------
// DIFF DE MEMÓRIA
// ---------------------------------------------------------------------------
test('montarDiffMemoria - conta novas, alteradas, "não alocar" e inalteradas', () => {
  const anterior = [
    { origem: 'CAIXA GERAL', destino: 'Caixa', grupo: 'Ativo', subCategoria: 'Circulante', decisao: 'alocar', confirmadoPorHumano: true },
    { origem: 'CLIENTES LOCACAO', destino: 'Clientes', grupo: 'Ativo', subCategoria: 'Circulante', decisao: 'alocar', confirmadoPorHumano: true },
    { origem: 'ADIANTAMENTO A SOCIOS', destino: 'Mútuo Financeiro', grupo: 'Ativo', subCategoria: 'Circulante', decisao: 'alocar', confirmadoPorHumano: false },
    { origem: 'CONTA QUE SAIU DO PLANO', destino: 'Caixa', grupo: 'Ativo', subCategoria: 'Circulante', decisao: 'alocar', confirmadoPorHumano: true },
  ];
  const proposta = [
    // inalterada - a comparação é NORMALIZADA, então caixa e acento não contam
    { origem: 'caixa geral', destino: 'CAIXA', grupo: 'ativo', subCategoria: 'circulante', decisao: 'alocar', confirmadoPorHumano: true },
    // alterada por DESTINO (continua alocando: é correção)
    { origem: 'CLIENTES LOCACAO', destino: 'Clientes - Grupo', grupo: 'Ativo', subCategoria: 'Circulante', decisao: 'alocar', confirmadoPorHumano: true },
    // alterada por DECISÃO: o analista RETIROU. A v1 perdia exatamente isto.
    { origem: 'ADIANTAMENTO A SOCIOS', destino: '', grupo: 'Ativo', subCategoria: 'Circulante', decisao: 'nao_alocar', confirmadoPorHumano: true },
    // nova
    { origem: 'DEBENTURES', destino: 'Debêntures', grupo: 'Passivo', subCategoria: 'Circulante', decisao: 'alocar', confirmadoPorHumano: false },
    // nova, negativa
    { origem: 'TOTAL DO ATIVO', destino: '', grupo: 'Ativo', subCategoria: 'Circulante', decisao: 'contexto', confirmadoPorHumano: false },
  ];

  const d = montarDiffMemoria(anterior, proposta);

  assert.equal(d.resumo.novas, 2);
  assert.equal(d.resumo.inalteradas, 1, 'divergir só em caixa/acento NÃO é alteração');
  assert.equal(d.resumo.alteradas, 2);
  assert.equal(d.resumo.removidas, 1);

  // DISJUNTOS de propósito: uma entrada que virou `nao_alocar` também "perdeu o
  // destino", mas contá-la nas duas linhas do painel infla os números e ensina o
  // analista a aprovar sem ler. Trocar de destino é correção; virar `nao_alocar`
  // é decisão de outra natureza.
  assert.equal(d.resumo.destinoMudou, 1);
  assert.equal(d.resumo.decisaoMudou, 1);
  assert.equal(d.resumo.destinoMudou + d.resumo.decisaoMudou, d.resumo.alteradas);

  // As decisões NEGATIVAS entram na revisão. É o ganho central sobre a v1: a
  // retirada feita pelo analista se reaproveita sozinha no mês seguinte, em vez
  // de o dicionário realocar a mesma conta no mesmo lugar errado.
  assert.equal(d.resumo.naoAlocar, 1);
  assert.equal(d.resumo.contexto, 1);
  assert.equal(d.naoAlocar[0].origem, 'ADIANTAMENTO A SOCIOS');

  assert.equal(d.resumo.total, 5);
  assert.equal(d.temMudanca, true);

  // Removida não é destruída: a memória é versionada, e a lista serve para o
  // analista saber o que não aparece mais NESTA análise.
  assert.equal(d.removidas[0].origem, 'CONTA QUE SAIU DO PLANO');
});

test('montarDiffMemoria - memória idêntica não abre o painel', () => {
  const m = [{ origem: 'CAIXA', destino: 'Caixa', grupo: 'Ativo', subCategoria: 'Circulante', decisao: 'alocar', confirmadoPorHumano: true }];
  const d = montarDiffMemoria(m, m);
  assert.equal(d.temMudanca, false);
  assert.equal(d.resumo.inalteradas, 1);
  assert.equal(d.resumo.novas, 0);

  // Memória vazia dos dois lados também não abre.
  assert.equal(montarDiffMemoria([], []).temMudanca, false);
  assert.equal(montarDiffMemoria(null, undefined).resumo.total, 0);
});

test('montarDiffMemoria - entrada sem origem é descartada (a chave casaria com tudo)', () => {
  const d = montarDiffMemoria([], [
    { origem: '', destino: 'Caixa', grupo: 'Ativo', subCategoria: 'Circulante', decisao: 'alocar' },
    { origem: '   ', destino: 'Caixa', grupo: 'Ativo', subCategoria: 'Circulante', decisao: 'alocar' },
  ]);
  assert.equal(d.resumo.total, 0);
  assert.equal(chaveMemoria({ origem: '', grupo: '', subCategoria: '' }), '||');
});

test('montarDiffMemoria - casa com o que `memoriaDeRows` realmente produz', () => {
  // Contrato de ponta a ponta: o pipeline gera as linhas, `memoriaDeRows` extrai
  // as decisões e o diff as compara. Se o formato de `memoriaDeRows` mudar, este
  // teste quebra aqui - e não numa tela em produção.
  const res = runPipeline([
    { id: 'a', origem: 'CAIXA GERAL', codigo: '11010100000071', valoresPorSlot: { '31/05/2026': '1000' }, naturezaPorSlot: { '31/05/2026': 'D' }, grupo: 'Ativo', subCategoria: 'Circulante', destino: 'Caixa' },
    { id: 'b', origem: 'CONTA RETIRADA', codigo: '11010200000072', valoresPorSlot: { '31/05/2026': '500' }, naturezaPorSlot: { '31/05/2026': 'D' }, grupo: 'Ativo', subCategoria: 'Circulante', alocacaoHierarquia: 'Não', noAuto: true },
  ], { saldosAbsolutos: true });

  const proposta = memoriaDeRows(res.rows, { apenasConfirmadas: false });
  assert.ok(proposta.length >= 2, `memoriaDeRows devolveu ${proposta.length} entradas`);

  const d = montarDiffMemoria([], proposta);
  assert.equal(d.resumo.novas, proposta.length);
  assert.equal(d.resumo.total, proposta.length);
  // A conta retirada tem de aparecer como decisão NEGATIVA na revisão.
  assert.equal(d.resumo.naoAlocar >= 1, true,
    `esperava ao menos uma decisão negativa, veio ${JSON.stringify(d.resumo)}`);
});

// ---------------------------------------------------------------------------
// SELETOR DE DESTINO - a garantia de que a UI não cria Classe A
// ---------------------------------------------------------------------------
test('candidatosPara NUNCA devolve subtotal - o seletor não pode causar Classe A', () => {
  // É o invariante que sustenta a grade: como o seletor de destino oferece
  // exclusivamente `candidatosPara(grupo, sub)`, o analista (e o LLM, que recebe
  // a mesma lista) não consegue produzir `destino-subtotal`, `destino-invalido`
  // nem `lado-trocado`. Restam apenas escolhas de julgamento, que são Classe B.
  assert.equal(SUBTOTAIS.length, 28, 'o plano tem 28 subtotais calculados');
  assert.equal(CONTAS_ALOCAVEIS.length, 79, 'e 79 posições alocáveis');
  const nomesDeSubtotal = new Set(SUBTOTAIS.map((s) => s.destino));

  const blocos = [
    ['Ativo', 'Circulante'],
    ['Ativo', 'Não Circulante'],
    ['Passivo', 'Circulante'],
    ['Passivo', 'Não Circulante'],
    ['Passivo', 'PL'],
    ['DRE', 'DRE'],
    ['', ''],            // sem grupo: devolve as 79
    ['Ativo', ''],       // grupo sem sub
    ['ATIVO', 'CIRCULANTE'], // tolera caixa
  ];

  for (const [grupo, sub] of blocos) {
    const cands = candidatosPara(grupo, sub);
    assert.ok(cands.length > 0, `nenhum candidato para ${grupo}/${sub}`);
    for (const c of cands) {
      assert.equal(c.tipo, 'conta',
        `"${c.destino}" (${grupo}/${sub}) tem tipo "${c.tipo}" - subtotal não pode ser oferecido`);
      assert.equal(nomesDeSubtotal.has(c.destino), false,
        `"${c.destino}" é nome de subtotal e apareceu como candidato`);
    }
    // E o lado é sempre preservado quando o grupo foi informado.
    if (grupo) {
      const g = grupo.toLowerCase();
      assert.ok(cands.every((c) => c.grupo.toLowerCase() === g),
        `candidatos de ${grupo} vazaram para outro grupo`);
    }
  }

  // Nem "Estoques" nem "Disponibilidades" - os destinos mais intuitivos que
  // existem, e ambos subtotais - podem ser escolhidos em nenhum bloco.
  const todos = new Set(CONTAS_ALOCAVEIS.map((c) => c.destino));
  for (const nome of ['Estoques', 'Disponibilidades', 'Clientes Líquido', 'TOTAL ATIVO']) {
    assert.equal(todos.has(nome), false, `"${nome}" não deveria ser alocável`);
  }
});

// ---------------------------------------------------------------------------
// SHADOW
// ---------------------------------------------------------------------------
test('blocosDaShadow e shadowLinhaTemValor agrupam e filtram para exibição', () => {
  const linhas = [
    { row: 5, destino: 'Caixa', grupo: 'Ativo', subCategoria: 'Circulante', tipo: 'conta', ano1: 0, ano2: 0, ano3: 10 },
    { row: 7, destino: 'Disponibilidades', grupo: 'Ativo', subCategoria: 'Circulante', tipo: 'subtotal', ano1: 0, ano2: 0, ano3: 10 },
    { row: 45, destino: 'Fornecedores', grupo: 'Passivo', subCategoria: 'Circulante', tipo: 'conta', ano1: 0, ano2: 0, ano3: 0 },
  ];
  const blocos = blocosDaShadow(linhas);
  assert.deepEqual(blocos.map((b) => b.rotulo),
    ['Ativo · Circulante', 'Passivo · Circulante']);
  assert.equal(blocos[0].linhas.length, 2);

  assert.equal(shadowLinhaTemValor(linhas[0]), true);
  assert.equal(shadowLinhaTemValor(linhas[2]), false);
  // Meio centavo é zero para exibição: o `round2` do núcleo já mostraria 0,00, e
  // destacar um "não-zero" que a tela imprime como 0,00 seria mentir.
  assert.equal(shadowLinhaTemValor({ ano1: 0, ano2: 0, ano3: 0.004 }), false);

  // A DRE colapsa num bloco único, e não em "DRE · DRE".
  const dre = blocosDaShadow([
    { row: 5, destino: 'Vendas Totais', grupo: 'DRE', subCategoria: 'DRE', tipo: 'subtotal', ano3: 1 },
  ]);
  assert.equal(dre[0].rotulo, 'DRE');
});

// ---------------------------------------------------------------------------
// LEITURA DE TABELA COLADA / CSV
// ---------------------------------------------------------------------------
test('detectarDelimitador prefere tabulação, depois ";", e vírgula por último', () => {
  // Vírgula por último porque em número pt-BR ela é separador DECIMAL: usá-la
  // como delimitador partiria "1.234,56" em duas células e deslocaria a linha
  // inteira para a direita - a causa nº 1 de valor na coluna errada.
  assert.equal(detectarDelimitador('a\tb\tc\n1\t2\t3'), '\t');
  assert.equal(detectarDelimitador('a;b;c\n1;2;3'), ';');
  assert.equal(detectarDelimitador('a,b,c\n1,2,3'), ',');
  // Com os dois presentes, tabulação vence: "CAIXA\t1.234,56" tem tab E vírgula.
  assert.equal(detectarDelimitador('CAIXA\t1.234,56'), '\t');
  assert.equal(detectarDelimitador('CAIXA;1.234,56'), ';');
  assert.equal(detectarDelimitador('linha unica sem separador'), '\t');
});

test('tabelaParaLinhas - balancete de ERP: código, descrição, saldo e D/C', () => {
  const texto = [
    'Codigo\tDescricao\tSaldo Atual\tD/C',
    '11010100000071\tCAIXA GERAL\t12.345,67\tD',
    '11030500000002\t(-) PCLD CLIENTES\t3.849.906,69\tC',
    '22080200000009\t( - ) JUROS DEBENTURES LP\t52.170.251,82\tD',
  ].join('\n');

  const { linhas, periodos, avisos } = tabelaParaLinhas(texto);

  assert.deepEqual(periodos, ['Saldo Atual']);
  assert.equal(linhas.length, 3);

  assert.equal(linhas[0].origem, 'CAIXA GERAL');
  assert.equal(linhas[0].codigo, '11010100000071');
  assert.equal(linhas[0].valoresPorSlot['Saldo Atual'], '12.345,67');
  assert.equal(linhas[0].naturezaPorSlot['Saldo Atual'], 'D');

  // A coluna D/C tem de ser reconhecida, e o aviso tem de pedir a marcação de
  // "saldos absolutos" - sem ela o núcleo ignora o D/C e o Ativo infla.
  assert.ok(avisos.some((a) => /saldos absolutos/i.test(a)));
  assert.ok(!avisos.some((a) => /código contábil identificada/i.test(a)),
    'com coluna de código não deveria avisar ausência de código');

  // E o resultado alimenta o pipeline direto, sem adaptador.
  const res = runPipeline(linhas, { saldosAbsolutos: true });
  assert.equal(res.rows.length, 3);
  // (-) PCLD é Ativo com saldo CREDOR: apresentação NEGATIVA.
  const pcld = res.rows.find((r) => r.codigo === '11030500000002');
  assert.ok(pcld.ano3Apresentacao < 0, `PCLD veio ${pcld.ano3Apresentacao}`);
});

test('tabelaParaLinhas - coluna de saldos INTEIROS não é confundida com código', () => {
  // A ambiguidade real: `1000` casa com o padrão de código contábil E com o de
  // valor. Se a ordem da detecção estivesse errada, esta tabela chegaria sem
  // valor nenhum - e "0 linhas com valor" é o pior modo de falhar, porque a tela
  // parece funcionar.
  const texto = [
    '1.1.01\tCAIXA GERAL\t1000\t2000',
    '1.1.02\tBANCOS CONTA MOVIMENTO\t3000\t4000',
    '2.1.01\tFORNECEDORES NACIONAIS\t5000\t6000',
  ].join('\n');

  const { linhas, periodos } = tabelaParaLinhas(texto);
  assert.equal(linhas.length, 3);
  assert.equal(periodos.length, 2, `esperava 2 colunas de valor, veio ${periodos.length}`);
  assert.equal(linhas[0].codigo, '1.1.01');
  assert.equal(linhas[0].origem, 'CAIXA GERAL');
  assert.deepEqual(Object.values(linhas[0].valoresPorSlot), ['1000', '2000']);
});

test('tabelaParaLinhas - sem cabeçalho, sem código, e recusa o que não é tabela', () => {
  // Sem cabeçalho: os rótulos viram "Coluna N" e o pipeline ainda funciona.
  const semCabecalho = tabelaParaLinhas('CAIXA GERAL\t100,00\nBANCOS ITAU\t200,00');
  assert.deepEqual(semCabecalho.periodos, ['Coluna 2']);
  assert.equal(semCabecalho.linhas[0].origem, 'CAIXA GERAL');
  assert.equal(semCabecalho.linhas[0].codigo, '');
  // E avisa que sem código TODA linha é analítica - que é como a v1 somava
  // totalizadores junto com as aberturas e multiplicava o balanço.
  assert.ok(semCabecalho.linhas.length === 2);
  assert.ok(semCabecalho.avisos.some((a) => /analítica/i.test(a)));

  // Texto sem nenhuma coluna numérica: recusa com instrução, não com silêncio.
  const prosa = tabelaParaLinhas('Bata quatro ovos\nAcrescente farinha\nLeve ao forno');
  assert.deepEqual(prosa.linhas, []);
  assert.ok(prosa.avisos.some((a) => /coluna de valor/i.test(a)));

  assert.deepEqual(tabelaParaLinhas('').linhas, []);
  assert.deepEqual(tabelaParaLinhas(null).linhas, []);
});

test('tabelaParaLinhas - BOM do Excel e aspas de CSV não entram no dado', () => {
  const texto = '\uFEFF"Codigo";"Descricao";"31/05/2026"\n"1101";"CAIXA GERAL";"1.234,56"';
  const { linhas, periodos } = tabelaParaLinhas(texto);
  assert.deepEqual(periodos, ['31/05/2026']);
  assert.equal(linhas.length, 1);
  assert.equal(linhas[0].codigo, '1101', 'o BOM não pode grudar no primeiro campo');
  assert.equal(linhas[0].origem, 'CAIXA GERAL');
  assert.equal(linhas[0].valoresPorSlot['31/05/2026'], '1.234,56');
});

// ---------------------------------------------------------------------------
// Integração leve: o pipeline alimenta os painéis com a forma esperada
// ---------------------------------------------------------------------------
test('o resultado do pipeline alimenta os três painéis sem adaptador', () => {
  // Alocar em "Estoques" (subtotal) é a Classe A mais fácil de cometer à mão.
  // Este teste garante que ela chega aos painéis já pronta para renderizar: a
  // trilha aponta o balde, o QA aponta o bloqueio e o badge aponta a divergência.
  const res = runPipeline([
    { id: 'x', origem: 'ESTOQUE DE MERCADORIAS', codigo: '11040100000001', valoresPorSlot: { '31/05/2026': '5000' }, naturezaPorSlot: { '31/05/2026': 'D' }, grupo: 'Ativo', subCategoria: 'Circulante', destino: 'Estoques' },
  ], { saldosAbsolutos: true });

  const linhas = linhasDaTrilha(res.shadow.trilha, 'ano3');
  const balde = linhas.find((l) => l.campo === 'subtotal');
  assert.equal(balde.valor, 5000);
  assert.equal(balde.alerta, true, 'alocar em subtotal tem de aparecer em vermelho');
  assert.equal(balde.temDetalhes, true);

  const s = separarIssues(res.qa.issues);
  assert.equal(s.bloqueado, true);
  assert.equal(res.qa.bloqueado, true, 'o painel e o núcleo concordam');
  assert.ok(s.classeA.erros.some((i) => i.code === 'destino-subtotal'));

  // E o valor NÃO chegou a nenhuma posição: é exatamente o que a v1 descartava
  // em silêncio.
  assert.equal(res.shadow.trilha.alocado.ano3, 0);
  assert.equal(res.shadow.trilha.perdas.ano3, 5000);
});
