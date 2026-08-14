// Persistência: fala com `/dados/*` da API; sem API, guarda em `localStorage`.
//
// ---------------------------------------------------------------------------
// POR QUE DOIS MODOS COM A MESMA INTERFACE
// ---------------------------------------------------------------------------
// O plano de dados é o FastAPI no Render, que é gratuito e tem cold start de
// ~50s, e o banco é o Neon, que hiberna. Nada disso é problema no uso normal,
// mas há dois cenários em que o portal PRECISA funcionar sem servidor nenhum:
//
//   · demonstração - abrir o portal publicado e mostrar o fluxo inteiro, com a
//     trilha de valor e o painel de QA reais, sem depender de rede;
//   · desenvolvimento do front - mexer na tela sem subir API e banco.
//
// Então cada método tem duas implementações e a MESMA assinatura. Quem chama não
// sabe (e não deve saber) em qual modo está; o único lugar que trata a diferença
// é a UI, que avisa "modo local, sem servidor" - porque esconder isso do usuário
// seria mentir sobre onde o dado dele está.
//
// A escolha é por REQUISIÇÃO, não no boot: trocar a URL em Configurações passa a
// valer na chamada seguinte, sem recarregar a página.
//
// ---------------------------------------------------------------------------
// O QUE O MODO LOCAL NÃO FAZ
// ---------------------------------------------------------------------------
// Não versiona memória por revisão (o banco tem `memoria_cliente.revisao` e a
// tabela `memoria_revisoes`), não promove nada ao dicionário global e não tem
// usuário. É armazenamento de demonstração, e a UI diz isso.

import { getConfig } from './config.js';
import { requisitar, ErroApi, CHAVE_SESSAO } from './api.js';
import { DICIONARIO_SEED } from '../core/data/dicionario.gen.js';

export const CHAVES = Object.freeze({
  clientes: 'allocator:clientes',
  analises: 'allocator:analises',
  memoria: 'allocator:memoria',
  // Importada, não redeclarada: `api.js` também precisa dela para autorizar as
  // rotas de inferência com a sessão, e duas constantes iguais divergem.
  sessao: CHAVE_SESSAO,
});

/** `true` quando não há plano de dados: o repositório opera em `localStorage`. */
export function modoLocal() {
  return !getConfig().apiDados;
}

// ---------------------------------------------------------------------------
// localStorage
// ---------------------------------------------------------------------------
function ler(chave, padrao) {
  try {
    const cru = globalThis.localStorage?.getItem(chave);
    if (!cru) return padrao;
    const v = JSON.parse(cru);
    return v ?? padrao;
  } catch {
    // JSON corrompido não pode derrubar o portal: o analista perderia a análise
    // aberta por causa de um registro velho ilegível.
    return padrao;
  }
}

function gravar(chave, valor) {
  try {
    globalThis.localStorage?.setItem(chave, JSON.stringify(valor));
    return true;
  } catch (e) {
    // Cota estourada é o caso real: uma análise com 358 linhas mais Shadow passa
    // de 1 MB, e o limite típico é 5 MB por origem.
    throw new ErroApi('Não consegui gravar no armazenamento do navegador.', {
      dica: 'O espaço local (~5 MB) provavelmente encheu. Apague análises antigas em '
        + 'Análises, ou configure a URL de dados em Configurações para salvar no servidor.',
      causa: e,
    });
  }
}

/** Id local. `crypto.randomUUID` existe nos navegadores-alvo; o resto é rede. */
function novoId() {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `loc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

const agora = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Sessão
// ---------------------------------------------------------------------------
/**
 * @typedef {object} Sessao
 * @property {string} token JWT emitido por `/dados/auth/login` (vazio no modo local)
 * @property {{id:string, email:string, nome:string}} usuario
 * @property {boolean} local `true` quando não houve servidor nenhum
 */

/** @returns {Sessao|null} */
export function sessaoAtual() {
  return ler(CHAVES.sessao, null);
}

function tokenSessao() {
  return sessaoAtual()?.token || '';
}

/**
 * Prefixo das rotas de dados no servidor.
 *
 * `server/app/main.py` monta o router com `prefix="/dados"`, e `apiDados` na
 * configuração é o HOST puro (`https://allocator-api.onrender.com`) - é assim que
 * o `runtime-config.json` documenta o campo, e é o que o operador cola do painel
 * do Render. O prefixo, portanto, é responsabilidade deste módulo. Deixá-lo de
 * fora produziria 404 em tudo com a URL "certa" configurada: o pior tipo de erro
 * de integração, porque a mensagem não aponta para a causa.
 */
const PREFIXO_DADOS = '/dados';

/**
 * Requisição ao plano de dados, com a sessão no cabeçalho `X-Sessao`.
 *
 * `sessao` e NÃO `token`: são dois canais diferentes e o servidor os lê em
 * lugares diferentes. `usuario_atual` (server/app/db/rotas.py) declara
 * `x_sessao: str = Header(default="")`; `exigir_token` (main.py) lê
 * `Authorization`. Mandar o JWT em `Authorization` fazia o login passar - única
 * rota sem sessão - e TODA rota de dados devolver 401 "Sessão ausente", o que na
 * tela parecia banco vazio.
 *
 * Os dois viajam juntos quando ambos existem: o `tokenApi` da configuração entra
 * em `Authorization` por conta do `cabecalhos`, e a sessão aqui. Uma implantação
 * que ponha `exigir_token` também nas rotas de dados continua funcionando sem
 * mudança neste módulo.
 */
function dados(caminho, opcoes = {}) {
  return requisitar('dados', `${PREFIXO_DADOS}${caminho}`, {
    ...opcoes, sessao: tokenSessao(),
  });
}

/**
 * Login contra `/dados/auth/login`.
 *
 * No modo local entra direto e devolve `local: true` - a UI usa isso para
 * mostrar o aviso permanente de que não há servidor.
 *
 * @param {string} email
 * @param {string} senha
 * @returns {Promise<Sessao>}
 */
export async function entrar(email, senha) {
  if (modoLocal()) {
    const s = {
      token: '',
      usuario: { id: 'local', email: email || 'local@allocator', nome: 'Analista (modo local)' },
      local: true,
    };
    gravar(CHAVES.sessao, s);
    return s;
  }
  const r = await dados('/auth/login', {
    metodo: 'POST', corpo: { email, senha },
  });
  const s = {
    token: r?.token || r?.access_token || '',
    usuario: r?.usuario || r?.user || { id: '', email, nome: '' },
    local: false,
  };
  if (!s.token) {
    throw new ErroApi('O servidor aceitou o login mas não devolveu um token.', {
      dica: 'Confira se a URL de dados aponta para o ALLocator v2 e se as rotas /dados/* '
        + 'estão registradas (o log da API avisa quando a camada de banco não subiu).',
    });
  }
  gravar(CHAVES.sessao, s);
  return s;
}

export function sair() {
  try {
    globalThis.localStorage?.removeItem(CHAVES.sessao);
  } catch { /* nada a fazer: a sessão sai da memória de qualquer forma */ }
}

// ---------------------------------------------------------------------------
// Clientes
// ---------------------------------------------------------------------------
/**
 * @typedef {object} Cliente
 * @property {string} id
 * @property {string} nome
 * @property {string} cnpj
 * @property {string} grupo
 * @property {string} setor
 * @property {string} [criadoEm]
 * @property {string} [atualizadoEm]
 */

/** @returns {Promise<Cliente[]>} */
export async function listarClientes() {
  if (modoLocal()) {
    return ler(CHAVES.clientes, [])
      .slice()
      .sort((a, b) => String(a.nome).localeCompare(String(b.nome), 'pt'));
  }
  const r = await dados('/clientes');
  return Array.isArray(r) ? r : (r?.clientes ?? []);
}

/**
 * Cria (sem `id`) ou atualiza (com `id`).
 * @param {Partial<Cliente>} cliente
 * @returns {Promise<Cliente>}
 */
export async function salvarCliente(cliente) {
  const nome = String(cliente?.nome ?? '').trim();
  if (!nome) {
    throw new ErroApi('Cliente sem nome.', { dica: 'Preencha o nome antes de salvar.' });
  }
  if (modoLocal()) {
    const lista = ler(CHAVES.clientes, []);
    const i = cliente.id ? lista.findIndex((c) => c.id === cliente.id) : -1;
    const registro = {
      id: cliente.id || novoId(),
      nome,
      cnpj: String(cliente.cnpj ?? '').trim(),
      grupo: String(cliente.grupo ?? '').trim(),
      setor: String(cliente.setor ?? '').trim(),
      criadoEm: i >= 0 ? lista[i].criadoEm : agora(),
      atualizadoEm: agora(),
    };
    if (i >= 0) lista[i] = registro; else lista.push(registro);
    gravar(CHAVES.clientes, lista);
    return registro;
  }
  const corpo = {
    nome,
    cnpj: cliente.cnpj ?? '',
    grupo: cliente.grupo ?? '',
    setor: cliente.setor ?? '',
  };
  return cliente.id
    ? dados(`/clientes/${cliente.id}`, { metodo: 'POST', corpo })
    : dados('/clientes', { metodo: 'POST', corpo });
}

/** @param {string} id */
export async function apagarCliente(id) {
  if (modoLocal()) {
    gravar(CHAVES.clientes, ler(CHAVES.clientes, []).filter((c) => c.id !== id));
    // Desvincula as análises em vez de apagá-las: apagar o cadastro do cliente
    // não pode destruir histórico já entregue (é o `on delete set null` do
    // schema.sql, reproduzido aqui para os dois modos se comportarem igual).
    gravar(CHAVES.analises, ler(CHAVES.analises, [])
      .map((a) => (a.clienteId === id ? { ...a, clienteId: null } : a)));
    // A memória, ao contrário, é DO cliente e não sobrevive a ele.
    const mem = ler(CHAVES.memoria, {});
    delete mem[id];
    gravar(CHAVES.memoria, mem);
    return true;
  }
  await dados(`/clientes/${id}`, { metodo: 'DELETE' });
  return true;
}

// ---------------------------------------------------------------------------
// Análises
// ---------------------------------------------------------------------------
/**
 * @typedef {object} ResumoAnalise cabeçalho, SEM as linhas
 * @property {string} id
 * @property {string|null} clienteId
 * @property {string} empresa
 * @property {string} cnpj
 * @property {'rascunho'|'em_revisao'|'concluida'} status
 * @property {string[]} periodos
 * @property {number} nLinhas
 * @property {boolean} balancoFechado
 * @property {boolean} conciliado
 * @property {string} atualizadoEm
 */

/**
 * @typedef {ResumoAnalise & {linhas:Array<object>, qa?:object, trilha?:object,
 *   saldosAbsolutos?:boolean, transportarResultado?:boolean}} Analise
 */

/**
 * Lista os CABEÇALHOS. Nunca traz `linhas`.
 *
 * O `jsonb` de uma análise real passa de 1 MB; trazer 200 delas para desenhar a
 * lista inicial era o que fazia a tela de entrada da v1 levar segundos. No modo
 * local o corte é feito aqui, para a mesma forma de dado chegar à UI.
 *
 * @param {{clienteId?:string, limite?:number}} [filtro]
 * @returns {Promise<ResumoAnalise[]>}
 */
export async function listarAnalises(filtro = {}) {
  const { clienteId, limite } = filtro;
  if (modoLocal()) {
    let lista = ler(CHAVES.analises, []);
    if (clienteId) lista = lista.filter((a) => a.clienteId === clienteId);
    lista = lista
      .slice()
      .sort((a, b) => String(b.atualizadoEm ?? '').localeCompare(String(a.atualizadoEm ?? '')));
    if (limite) lista = lista.slice(0, limite);
    return lista.map(({ linhas, qa, trilha, ...cabecalho }) => ({
      ...cabecalho,
      nLinhas: cabecalho.nLinhas ?? (linhas?.length ?? 0),
    }));
  }
  const q = new URLSearchParams();
  if (clienteId) q.set('cliente_id', clienteId);
  if (limite) q.set('limite', String(limite));
  const sufixo = q.toString() ? `?${q}` : '';
  const r = await dados(`/analises${sufixo}`);
  return Array.isArray(r) ? r : (r?.analises ?? []);
}

/**
 * Uma análise COMPLETA, com as linhas.
 * @param {string} id
 * @returns {Promise<Analise|null>}
 */
export async function obterAnalise(id) {
  if (modoLocal()) {
    return ler(CHAVES.analises, []).find((a) => a.id === id) ?? null;
  }
  return dados(`/analises/${id}`);
}

/**
 * Cria ou atualiza uma análise.
 *
 * `linhas` são as linhas DE ENTRADA (antes do pipeline), não o resultado. O
 * pipeline é determinístico: guardar a entrada e recalcular é mais barato, mais
 * auditável e imune a mudança de formato interno do núcleo. `qa` e `trilha`
 * entram apenas como SNAPSHOT do que o analista viu quando aprovou.
 *
 * @param {Partial<Analise>} analise
 * @returns {Promise<Analise>}
 */
export async function salvarAnalise(analise) {
  const corpo = {
    clienteId: analise.clienteId ?? null,
    empresa: String(analise.empresa ?? '').trim(),
    cnpj: String(analise.cnpj ?? '').trim(),
    grupo: String(analise.grupo ?? '').trim(),
    status: analise.status || 'rascunho',
    unidade: analise.unidade || 'Mil',
    moeda: analise.moeda || 'BRL',
    saldosAbsolutos: Boolean(analise.saldosAbsolutos),
    transportarResultado: Boolean(analise.transportarResultado),
    periodos: analise.periodos ?? [],
    linhas: analise.linhas ?? [],
    qa: analise.qa ?? null,
    trilha: analise.trilha ?? null,
    nLinhas: (analise.linhas ?? []).length,
    balancoFechado: Boolean(analise.balancoFechado),
    conciliado: Boolean(analise.conciliado),
  };

  if (modoLocal()) {
    const lista = ler(CHAVES.analises, []);
    const i = analise.id ? lista.findIndex((a) => a.id === analise.id) : -1;
    const registro = {
      ...corpo,
      id: analise.id || novoId(),
      criadoEm: i >= 0 ? lista[i].criadoEm : agora(),
      atualizadoEm: agora(),
    };
    if (i >= 0) lista[i] = registro; else lista.push(registro);
    gravar(CHAVES.analises, lista);
    return registro;
  }
  return analise.id
    ? dados(`/analises/${analise.id}`, { metodo: 'POST', corpo })
    : dados('/analises', { metodo: 'POST', corpo });
}

/** @param {string} id */
export async function apagarAnalise(id) {
  if (modoLocal()) {
    gravar(CHAVES.analises, ler(CHAVES.analises, []).filter((a) => a.id !== id));
    return true;
  }
  await dados(`/analises/${id}`, { metodo: 'DELETE' });
  return true;
}

// ---------------------------------------------------------------------------
// Memória do cliente
// ---------------------------------------------------------------------------
/**
 * @typedef {object} EntradaMemoria
 * @property {string} origem nome da conta como está no documento
 * @property {string} destino vazio quando `decisao !== 'alocar'` - e isso é o CONTEÚDO da decisão
 * @property {string} grupo
 * @property {string} subCategoria
 * @property {'alocar'|'nao_alocar'|'contexto'} decisao
 * @property {boolean} confirmadoPorHumano
 */

/**
 * Última revisão da memória de um cliente.
 * @param {string} clienteId
 * @returns {Promise<EntradaMemoria[]>}
 */
export async function carregarMemoria(clienteId) {
  if (!clienteId) return [];
  if (modoLocal()) {
    const todas = ler(CHAVES.memoria, {});
    return todas[clienteId]?.entradas ?? [];
  }
  const r = await dados(`/memoria/${clienteId}`);
  if (Array.isArray(r)) return r;
  return r?.entradas ?? r?.memoria ?? [];
}

/**
 * Grava uma revisão da memória.
 *
 * OPT-IN: só é chamada depois do clique explícito do analista no `<DiffMemoria>`.
 * Memória que se grava sozinha é memória em que ninguém confia - basta uma
 * análise ruim para envenenar o cliente, e sem revisão não há como saber quando
 * aconteceu.
 *
 * @param {string} clienteId
 * @param {EntradaMemoria[]} entradas resultado de `memoriaDeRows`
 * @param {{analiseId?:string, observacao?:string, resumo?:object}} [meta]
 */
export async function salvarMemoria(clienteId, entradas, meta = {}) {
  if (!clienteId) {
    throw new ErroApi('Memória sem cliente.', {
      dica: 'Vincule a análise a um cliente na etapa Resultado antes de salvar a memória - '
        + 'a memória é o que evita refazer o mesmo trabalho manual no mês seguinte.',
    });
  }
  const lista = Array.isArray(entradas) ? entradas : [];
  if (modoLocal()) {
    const todas = ler(CHAVES.memoria, {});
    const anterior = todas[clienteId];
    const registro = {
      clienteId,
      revisao: (anterior?.revisao ?? 0) + 1,
      entradas: lista,
      analiseId: meta.analiseId ?? null,
      observacao: meta.observacao ?? '',
      resumo: meta.resumo ?? null,
      criadoEm: agora(),
    };
    todas[clienteId] = registro;
    gravar(CHAVES.memoria, todas);
    return registro;
  }
  return dados(`/memoria/${clienteId}`, {
    metodo: 'POST',
    corpo: {
      entradas: lista,
      analise_id: meta.analiseId ?? null,
      observacao: meta.observacao ?? '',
    },
  });
}

// ---------------------------------------------------------------------------
// Dicionário
// ---------------------------------------------------------------------------
/**
 * @typedef {object} RegraDicionario
 * @property {string} origem
 * @property {string} destino
 * @property {string} grupo
 * @property {string} subCategoria
 * @property {'seed'|'aprendida'|'manual'} fonte
 * @property {boolean} [confirmadoPorHumano]
 */

/**
 * Dicionário efetivo: as 1.260 regras curadas do seed + as regras do usuário.
 *
 * O seed vem do bundle (`core/data/dicionario.gen.js`), não da rede: ele é a
 * base determinística e o portal não pode depender de servidor para mapear
 * conta. As regras do `dicionario_global` só SOMAM, e vêm marcadas com a fonte,
 * o analista precisa distinguir "regra curada" de "regra que eu ensinei".
 *
 * @param {{incluirServidor?:boolean}} [opcoes]
 * @returns {Promise<RegraDicionario[]>}
 */
export async function listarDicionario(opcoes = {}) {
  const semente = DICIONARIO_SEED.map((e) => ({ ...e, fonte: 'seed' }));
  if (opcoes.incluirServidor === false || modoLocal()) return semente;
  try {
    const r = await dados('/dicionario');
    const extras = (Array.isArray(r) ? r : (r?.regras ?? [])).map((e) => ({
      origem: e.origem,
      destino: e.destino,
      grupo: e.grupo ?? '',
      subCategoria: e.subCategoria ?? e.sub_categoria ?? '',
      fonte: e.fonte === 'seed' ? 'seed' : (e.fonte || 'manual'),
      confirmadoPorHumano: Boolean(e.confirmadoPorHumano ?? e.confirmado_por_humano),
    }));
    return [...semente, ...extras];
  } catch {
    // O dicionário do servidor é um EXTRA. Falhar em buscá-lo não pode impedir
    // o analista de consultar as 1.260 regras que estão no bundle.
    return semente;
  }
}
