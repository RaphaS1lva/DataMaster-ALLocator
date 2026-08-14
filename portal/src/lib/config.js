// Configuração lida em RUNTIME, nunca embutida na build.
//
// ---------------------------------------------------------------------------
// POR QUE NÃO `VITE_API_URL`
// ---------------------------------------------------------------------------
// Na v1 a URL da API vinha de `import.meta.env.VITE_API_URL`, e o Vite faz
// substituição em TEMPO DE BUILD: o valor é escrito literalmente no bundle
// minificado. A string deixa de ser configuração e passa a ser código
// compilado.
//
// Isso seria indiferente se a URL fosse estável - e a do plano de dados até é.
// A do plano de INFERÊNCIA não: o Cloudflare Tunnel gratuito sorteia um
// hostname `*.trycloudflare.com` novo A CADA REINÍCIO do processo. Fechou o
// terminal, caiu o Wi-Fi, reiniciou a máquina: hostname novo.
//
// Com a URL na build, trocar uma string custa: editar env -> `npm run build` ->
// commit -> push -> esperar o GitHub Actions -> esperar a propagação do Pages.
// Dois a cinco minutos, com dependência de rede e de CI. Em runtime custa um
// campo de texto e um clique: ~5 segundos, sem rede, sem deploy. A diferença
// não é conforto - é conseguir ou não corrigir com alguém esperando na frente.
//
// Conclusão de desenho: a URL da API é OPERAÇÃO, não CÓDIGO.
//
// ---------------------------------------------------------------------------
// PRECEDÊNCIA
// ---------------------------------------------------------------------------
//   1. `localStorage['allocator:config']`   o que o usuário pôs em Configurações
//   2. `./runtime-config.json`              o que foi publicado junto do bundle
//   3. padrões de desenvolvimento           `http://127.0.0.1:8123`
//
// (1) ganha porque é o caminho de correção mais rápido, e `localStorage` é por
// navegador e por origem - ajustar na sua máquina não afeta ninguém. Há botão de
// limpar para voltar ao valor publicado.
//
// O fetch é RELATIVO (`./runtime-config.json`) pela mesma razão do
// `base: './'` do Vite: o Pages de projeto serve num subcaminho, e um caminho
// absoluto pediria o arquivo na raiz do domínio. `cache: 'no-store'` porque sem
// isso o navegador devolve a versão anterior e você troca o hostname sem efeito
// visível - o pior tipo de bug de configuração. E qualquer falha (arquivo
// ausente, JSON malformado, rede caída) DEGRADA para o modo local em vez de
// virar tela branca.

/**
 * @typedef {object} ConfigRuntime
 * @property {string} apiDados       base do plano de dados (CRUD, memória, auth)
 * @property {string} apiInferencia  base do plano de inferência (/read, /julgamental)
 * @property {string} tokenApi       Bearer compartilhado; vazio = API aberta
 * @property {string} versao         versão declarada da configuração
 * @property {'localStorage'|'runtime-config'|'padrao-dev'|'vazio'} fonte
 *   de onde veio o valor efetivo de `apiDados` - exibido em Configurações para
 *   o usuário saber o que está de fato em uso
 */

export const CHAVE_CONFIG = 'allocator:config';
export const ARQUIVO_CONFIG = './runtime-config.json';

/** Campos que o portal reconhece. Qualquer outro no JSON é ignorado. */
export const CAMPOS = Object.freeze(['apiDados', 'apiInferencia', 'tokenApi', 'versao']);

/**
 * Padrões de desenvolvimento. `uvicorn app.main:app --port 8123` local atende os
 * dois planos ao mesmo tempo (é o mesmo código-fonte, duas implantações).
 */
export const PADROES_DEV = Object.freeze({
  apiDados: 'http://127.0.0.1:8123',
  apiInferencia: 'http://127.0.0.1:8123',
  tokenApi: '',
  versao: '2.0.0',
});

export const CONFIG_VAZIA = Object.freeze({
  apiDados: '', apiInferencia: '', tokenApi: '', versao: '2.0.0',
});

/**
 * Estamos rodando na máquina do desenvolvedor?
 *
 * Só nesse caso os padrões de dev entram. Aplicá-los em produção faria o portal
 * publicado tentar `127.0.0.1` e falhar com "conexão recusada" - mensagem que
 * não diz nada a quem abriu a página. Sem servidor configurado, o certo é cair
 * no modo local (localStorage), que é demonstrável e honesto.
 */
function ehAmbienteLocal() {
  try {
    const h = globalThis.location?.hostname ?? '';
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '';
  } catch {
    return false;
  }
}

/**
 * Só as chaves conhecidas, como string com trim. Descarta lixo do JSON.
 *
 * `manterVazios` distingue as duas fontes, e a distinção não é detalhe:
 *
 *   ARQUIVO (`false`)      `"apiDados": ""` significa "não configurado". Manter a
 *                          chave vazia faria ela SOBREPOR o padrão de
 *                          desenvolvimento, e o `runtime-config.json` que vai no
 *                          repositório (sem URL, porque URL de tunnel é efêmera)
 *                          quebraria o `npm run dev` de quem clonasse.
 *   localStorage (`true`)  `""` significa "quero explicitamente vazio" - é como o
 *                          usuário força o modo local mesmo havendo URL publicada.
 */
function sanear(bruto, { manterVazios = false } = {}) {
  const out = {};
  if (!bruto || typeof bruto !== 'object') return out;
  for (const campo of CAMPOS) {
    if (!Object.prototype.hasOwnProperty.call(bruto, campo)) continue;
    const v = bruto[campo];
    if (v === null || v === undefined) continue;
    // trim e sem barra final: `${base}/read` não pode virar `${base}//read`
    const limpo = String(v).trim().replace(/\/+$/, '');
    if (!limpo && !manterVazios) continue;
    out[campo] = limpo;
  }
  return out;
}

/** Lê o override do usuário. Safari em navegação privada LANÇA ao acessar. */
function lerLocal() {
  try {
    const cru = globalThis.localStorage?.getItem(CHAVE_CONFIG);
    if (!cru) return {};
    return sanear(JSON.parse(cru), { manterVazios: true });
  } catch {
    // JSON corrompido ou storage bloqueado: ignora e segue para o arquivo.
    return {};
  }
}

async function lerArquivo() {
  try {
    const r = await globalThis.fetch(ARQUIVO_CONFIG, { cache: 'no-store' });
    if (!r || !r.ok) return {};
    return sanear(await r.json());
  } catch {
    return {};
  }
}

/** Config em vigor. Sempre um objeto - nunca `null`, para não exigir guarda. */
let configAtual = { ...CONFIG_VAZIA, fonte: 'vazio' };
/**
 * Último `runtime-config.json` lido, CRU.
 *
 * Guardado porque `salvarConfig` precisa recompor a precedência do zero. Se ele
 * usasse a config já resolvida como se fosse o arquivo, limpar um campo nas
 * Configurações não teria efeito: o valor antigo voltaria pela camada de baixo,
 * e o usuário veria "salvo" com a URL velha ainda em uso.
 */
let arquivoAtual = {};

function decidirFonte(local, arquivo) {
  if (local.apiDados || local.apiInferencia) return 'localStorage';
  if (arquivo.apiDados || arquivo.apiInferencia) return 'runtime-config';
  if (ehAmbienteLocal()) return 'padrao-dev';
  return 'vazio';
}

/**
 * Resolve a configuração efetiva. Puro: recebe as duas fontes já lidas, o que
 * torna a precedência testável sem rede nem storage.
 *
 * A sobreposição é POR CAMPO e respeita chave presente com valor VAZIO - é
 * assim que o botão "limpar" das Configurações força o modo local mesmo havendo
 * URL no `runtime-config.json` publicado.
 *
 * @param {Record<string,string>} local
 * @param {Record<string,string>} arquivo
 * @returns {ConfigRuntime}
 */
export function resolverConfig(local, arquivo) {
  const base = ehAmbienteLocal() && !arquivo.apiDados && !arquivo.apiInferencia
    && !local.apiDados && !local.apiInferencia
    ? PADROES_DEV
    : CONFIG_VAZIA;
  return {
    ...base,
    ...arquivo,
    ...local,
    fonte: decidirFonte(local, arquivo),
  };
}

/**
 * Carrega a configuração na ordem de precedência e a publica em `getConfig()`.
 *
 * Não memoiza de propósito: é chamada no boot e no botão "recarregar" das
 * Configurações, e memoizar transformaria "recarregar" num no-op silencioso.
 *
 * @returns {Promise<ConfigRuntime>}
 */
export async function carregarConfig() {
  const local = lerLocal();
  // Otimização deliberada: se o usuário já definiu as duas URLs, o arquivo não
  // pode mudar nada (localStorage tem precedência em todos os campos que ele
  // define) - e evitamos um fetch que, offline, custa o timeout do navegador.
  const precisaArquivo = !(local.apiDados && local.apiInferencia && 'tokenApi' in local);
  arquivoAtual = precisaArquivo ? await lerArquivo() : {};
  configAtual = resolverConfig(local, arquivoAtual);
  return configAtual;
}

/**
 * Configuração já carregada. Síncrona: os módulos de rede (`api.js`, `repo.js`)
 * a consultam a cada requisição, então uma troca em Configurações vale na
 * chamada seguinte, sem recarregar a página.
 *
 * @returns {ConfigRuntime}
 */
export function getConfig() {
  return configAtual;
}

/**
 * Grava um override parcial em `localStorage` e o aplica imediatamente.
 *
 * @param {Partial<ConfigRuntime>} parcial campos a sobrepor; `''` é válido e
 *   significa "não configurado" (força o modo local para aquele plano)
 * @returns {ConfigRuntime} a configuração resultante
 */
export function salvarConfig(parcial) {
  const local = { ...lerLocal(), ...sanear(parcial, { manterVazios: true }) };
  try {
    globalThis.localStorage?.setItem(CHAVE_CONFIG, JSON.stringify(local));
  } catch {
    // Storage indisponível: a config vale só para esta sessão. Não é motivo
    // para abortar - o usuário acabou de pedir a troca.
  }
  configAtual = resolverConfig(local, arquivoAtual);
  return configAtual;
}

/** Apaga o override e volta ao `runtime-config.json` publicado. */
export async function limparConfig() {
  try {
    globalThis.localStorage?.removeItem(CHAVE_CONFIG);
  } catch { /* idem salvarConfig */ }
  return carregarConfig();
}

/** Sem plano de dados configurado o `repo` cai no modo local (localStorage). */
export function temApiDados() {
  return Boolean(getConfig().apiDados);
}

/** Sem plano de inferência, o portal segue no modo determinístico. */
export function temApiInferencia() {
  return Boolean(getConfig().apiInferencia);
}
