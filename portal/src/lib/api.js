// Cliente do plano de INFERÊNCIA: /read, /julgamental, /parecer, /health.
//
// Contrato em server/app/main.py. Três coisas que este módulo faz e a v1 não
// fazia:
//
//  1. TETO EM TODA ESPERA. O POST /read devolve `job_id` na hora e o portal
//     acompanha por polling; sem teto, um job que morre no servidor deixa o
//     portal girando para sempre e o usuário sem saber se pode reenviar.
//     10 minutos é generoso para um PDF escaneado grande e finito.
//
//  2. ERRO DE REDE NUM POLL NÃO ABORTA. O plano de inferência roda num notebook
//     atrás de um tunnel gratuito: um poll que falha é o caso NORMAL (Wi-Fi
//     oscilou, tunnel reconectou), não o caso de erro. Abortar aqui jogaria fora
//     um job que está processando bem. Só desistimos depois de
//     `MAX_FALHAS_SEGUIDAS` falhas consecutivas - ou do teto de tempo.
//
//  3. CANCELAR. Todo método aceita um `AbortSignal`. Na v1 não havia como
//     interromper uma leitura: só recarregar a página, perdendo a análise em
//     edição.
//
// Sobre o 422: é o GATE CONTÁBIL recusando o documento (não é balanço, é DFC, é
// receita de bolo). Acontece ANTES de qualquer chamada de modelo - nenhum token
// foi gasto - e a mensagem do servidor explica o motivo. O portal precisa dizer
// isso ao usuário, porque "422" sozinho parece falha do sistema quando é o
// sistema funcionando.

import { getConfig } from './config.js';

/** Intervalo entre consultas de progresso do job. */
export const INTERVALO_POLL_MS = 3000;
/** Teto absoluto de acompanhamento de um job de leitura. */
export const TETO_LEITURA_MS = 10 * 60 * 1000;
/** Timeout de uma requisição isolada (não do job inteiro). */
export const TIMEOUT_REQUISICAO_MS = 60 * 1000;
/** Timeout do upload: arquivo de 25 MB em rede ruim leva mais que 60s. */
export const TIMEOUT_UPLOAD_MS = 5 * 60 * 1000;
/** Falhas de rede consecutivas num poll antes de desistir. */
export const MAX_FALHAS_SEGUIDAS = 8;

/**
 * Erro de API com o que o usuário precisa para AGIR.
 *
 * `status` permite ao chamador distinguir 422 (documento recusado pelo gate) de
 * 503 (modelo fora do ar, mas o determinístico continua) - que exigem reações
 * completamente diferentes na tela.
 */
export class ErroApi extends Error {
  /**
   * @param {string} mensagem o que aconteceu
   * @param {{status?:number, dica?:string, causa?:unknown, corpo?:unknown}} [extra]
   *   `dica` é o que FAZER; sem ela a mensagem de erro é só reclamação
   */
  constructor(mensagem, extra = {}) {
    super(mensagem);
    this.name = 'ErroApi';
    this.status = extra.status ?? 0;
    this.dica = extra.dica ?? '';
    this.corpo = extra.corpo ?? null;
    this.causa = extra.causa ?? null;
  }

  /** Texto completo para exibir num alerta. */
  get textoCompleto() {
    return this.dica ? `${this.message} ${this.dica}` : this.message;
  }
}

/** Cancelamento pedido pelo usuário - não é falha, não deve virar alerta vermelho. */
export class Cancelado extends Error {
  constructor(mensagem = 'Operação cancelada.') {
    super(mensagem);
    this.name = 'Cancelado';
  }
}

function exigirBase(qual) {
  const cfg = getConfig();
  const base = qual === 'dados' ? cfg.apiDados : cfg.apiInferencia;
  if (!base) {
    throw new ErroApi(
      qual === 'dados'
        ? 'Nenhuma URL de dados configurada.'
        : 'Nenhuma URL de inferência configurada.',
      {
        dica: 'Abra Configurações na barra lateral e preencha a URL. Sem ela o '
          + 'portal segue no modo determinístico: leitura manual, dicionário, '
          + 'memória e todo o pipeline contábil continuam funcionando.',
      },
    );
  }
  return base;
}

/**
 * Cabeçalhos com Bearer.
 *
 * `token` explícito sobrepõe o `tokenApi` da configuração: no plano de dados quem
 * autentica é o USUÁRIO (JWT emitido por `/dados/auth/login`, cujo `usuario_id`
 * o servidor põe no WHERE de toda consulta), e não a chave compartilhada da API.
 */
function cabecalhos(token, extra = {}) {
  const efetivo = token || getConfig().tokenApi;
  const h = { ...extra };
  // Bearer só quando existe. A API roda aberta em dev (e AVISA no log); mandar
  // "Bearer " vazio faria a comparação de string falhar com 401.
  if (efetivo) h.Authorization = `Bearer ${efetivo}`;
  return h;
}

/**
 * Une um `AbortSignal` externo (cancelar) com um timeout próprio.
 *
 * `AbortSignal.any` não existe em todos os navegadores-alvo, então encadeamos à
 * mão. Devolve `{ sinal, encerrar }` e o chamador DEVE chamar `encerrar()` no
 * `finally`, senão o timer sobrevive à requisição.
 */
function sinalComTeto(sinalExterno, timeoutMs) {
  const ctrl = new AbortController();
  let porTimeout = false;
  const t = setTimeout(() => { porTimeout = true; ctrl.abort(); }, timeoutMs);
  const propagar = () => ctrl.abort();
  if (sinalExterno) {
    if (sinalExterno.aborted) ctrl.abort();
    else sinalExterno.addEventListener('abort', propagar, { once: true });
  }
  return {
    sinal: ctrl.signal,
    foiTimeout: () => porTimeout,
    encerrar() {
      clearTimeout(t);
      sinalExterno?.removeEventListener?.('abort', propagar);
    },
  };
}

/** Mensagem do FastAPI: `{detail: "..."}`, ou o corpo cru se não for JSON. */
async function extrairDetalhe(resposta) {
  try {
    const texto = await resposta.text();
    if (!texto) return '';
    try {
      const j = JSON.parse(texto);
      if (typeof j?.detail === 'string') return j.detail;
      if (typeof j?.detalhe === 'string') return j.detalhe;
      if (typeof j?.message === 'string') return j.message;
      return texto.slice(0, 400);
    } catch {
      return texto.slice(0, 400);
    }
  } catch {
    return '';
  }
}

/** Dica de ação por código HTTP. Diz o que fazer, não só o que falhou. */
function dicaPara(status) {
  switch (status) {
    case 401:
      return 'O token de API está errado ou ausente. Confira o campo Token em Configurações.';
    case 404:
      return 'O job expirou ou a API reiniciou. Reenvie o arquivo.';
    case 413:
      return 'O arquivo passou do limite de upload da API. Reduza o PDF ou envie só as páginas do balanço.';
    case 415:
      return 'Aceito PDF, PNG, JPG, WEBP e XLSX (o tipo é conferido pelo conteúdo, não pela extensão). '
        + 'CSV e tabela copiada podem ser colados direto na etapa Documento.';
    case 422:
      return 'O gate contábil recusou o documento ANTES de chamar qualquer modelo - nenhum token foi gasto. '
        + 'Envie a página que contém o Balanço Patrimonial ou a DRE.';
    case 429:
      return 'Há leituras demais em andamento na API. Tente de novo em alguns segundos.';
    case 502:
      return 'O provedor de modelo devolveu resposta inválida. Tente novamente; se persistir, use o modo determinístico.';
    case 503:
      return 'A camada de IA está fora do ar. O modo determinístico (dicionário, memória e edição manual) continua funcionando.';
    default:
      return status >= 500
        ? 'Erro no servidor. Confira o log da API; o pipeline contábil no navegador não é afetado.'
        : '';
  }
}

/**
 * Requisição JSON com teto de tempo e cancelamento.
 *
 * @param {'dados'|'inferencia'} plano
 * @param {string} caminho começando com `/`
 * @param {{metodo?:string, corpo?:unknown, sinal?:AbortSignal, timeoutMs?:number,
 *          formData?:FormData, token?:string}} [opcoes]
 */
export async function requisitar(plano, caminho, opcoes = {}) {
  const base = exigirBase(plano);
  const {
    metodo = 'GET', corpo, sinal, formData, token,
    timeoutMs = formData ? TIMEOUT_UPLOAD_MS : TIMEOUT_REQUISICAO_MS,
  } = opcoes;

  const teto = sinalComTeto(sinal, timeoutMs);
  try {
    const init = { method: metodo, signal: teto.sinal, headers: cabecalhos(token) };
    if (formData) {
      // NÃO defina Content-Type: o navegador precisa gerar o boundary do
      // multipart. Definir à mão produz um corpo que o FastAPI não parseia.
      init.body = formData;
    } else if (corpo !== undefined) {
      init.headers = cabecalhos(token, { 'Content-Type': 'application/json' });
      init.body = JSON.stringify(corpo);
    }

    const r = await fetch(`${base}${caminho}`, init);
    if (!r.ok) {
      const detalhe = await extrairDetalhe(r);
      throw new ErroApi(detalhe || `A API respondeu ${r.status}.`, {
        status: r.status, dica: dicaPara(r.status),
      });
    }
    if (r.status === 204) return null;
    return await r.json();
  } catch (e) {
    if (e instanceof ErroApi) throw e;
    if (e?.name === 'AbortError') {
      if (teto.foiTimeout()) {
        throw new ErroApi(
          `A API não respondeu em ${Math.round(timeoutMs / 1000)}s.`,
          {
            dica: 'Se for o plano de dados no Render, o primeiro acesso após ociosidade '
              + 'demora (cold start de ~50s) - tente de novo. Se for a inferência, '
              + 'confira se o tunnel está no ar em Configurações.',
            causa: e,
          },
        );
      }
      throw new Cancelado();
    }
    // TypeError de fetch = DNS, CORS ou rede. A mensagem nativa ("Failed to
    // fetch") não ajuda ninguém, então trocamos pelas causas prováveis.
    throw new ErroApi('Não consegui falar com a API.', {
      dica: `Confira a URL em Configurações (${base}), se o servidor está no ar e se `
        + 'esta origem está em ALLOWED_ORIGINS. O portal continua funcionando offline.',
      causa: e,
    });
  } finally {
    teto.encerrar();
  }
}

const dormir = (ms, sinal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  const cancelar = () => { clearTimeout(t); reject(new Cancelado()); };
  if (sinal) {
    if (sinal.aborted) cancelar();
    else sinal.addEventListener('abort', cancelar, { once: true });
  }
});

/**
 * @typedef {object} ProgressoLeitura
 * @property {'enviando'|'na-fila'|'processando'|'concluido'} fase
 * @property {string} mensagem texto que o servidor devolve em `progresso`
 * @property {number} decorridoMs
 * @property {number} tentativas quantos polls já foram feitos
 * @property {number} falhasSeguidas polls que erraram sem derrubar o job
 * @property {string} [jobId]
 */

/**
 * @typedef {object} ResultadoLeitura resposta de `_ler` em server/app/main.py
 * @property {'balancete'|'pdf-texto'|'imagem'} fonte
 * @property {boolean} admissivel
 * @property {{admissivel:boolean, tipo:string, motivo:string, avisos:string[]}} arquivo
 * @property {Array<object>} linhas linhas cruas, prontas para `runPipeline`
 * @property {string[]} periodos rótulos de coluna detectados
 * @property {boolean} [saldosAbsolutos] documento traz módulo + coluna D/C
 * @property {number} [folhas]
 * @property {number} [sinteticas]
 * @property {Array<object>} [evidencias]
 * @property {Array<{pagina:number, tipo:string, score:number, evidencias:string[], temTexto:boolean}>} [paginas]
 * @property {number[]} [paginasSemTexto]
 * @property {string[]} [injecoesNeutralizadas]
 * @property {string[]} avisos
 * @property {boolean} [precisaVisao]
 */

/**
 * Lê um documento: POST /read e polling em GET /read/{job_id}.
 *
 * @param {File|Blob} arquivo
 * @param {(p: ProgressoLeitura) => void} [onProgresso]
 * @param {{sinal?:AbortSignal, tetoMs?:number, intervaloMs?:number}} [opcoes]
 * @returns {Promise<ResultadoLeitura>}
 * @throws {ErroApi} `status === 422` quando o gate contábil recusa o documento
 * @throws {Cancelado} quando o usuário cancela
 */
export async function lerDocumento(arquivo, onProgresso, opcoes = {}) {
  const { sinal, tetoMs = TETO_LEITURA_MS, intervaloMs = INTERVALO_POLL_MS } = opcoes;
  const inicio = Date.now();
  const avisar = (p) => { try { onProgresso?.(p); } catch { /* UI não derruba leitura */ } };

  avisar({
    fase: 'enviando', mensagem: 'enviando o arquivo…', decorridoMs: 0,
    tentativas: 0, falhasSeguidas: 0,
  });

  const fd = new FormData();
  fd.append('file', arquivo, arquivo.name || 'documento');
  const abertura = await requisitar('inferencia', '/read', {
    metodo: 'POST', formData: fd, sinal,
  });

  const jobId = abertura?.job_id;
  if (!jobId) {
    throw new ErroApi('A API aceitou o arquivo mas não devolveu um identificador de job.', {
      dica: 'Confira se a URL de inferência aponta para o ALLocator v2 (GET /health deve responder).',
      corpo: abertura,
    });
  }

  let tentativas = 0;
  let falhasSeguidas = 0;

  avisar({
    fase: 'na-fila', mensagem: abertura.progresso || 'na fila…', jobId,
    decorridoMs: Date.now() - inicio, tentativas, falhasSeguidas,
  });

  // Teto SEMPRE presente. Sem ele, um job perdido no servidor (processo
  // reiniciou, container reciclou) deixa a tela girando indefinidamente.
  while (Date.now() - inicio < tetoMs) {
    await dormir(intervaloMs, sinal);
    tentativas += 1;

    let estado;
    try {
      estado = await requisitar('inferencia', `/read/${jobId}`, { sinal });
      falhasSeguidas = 0;
    } catch (e) {
      if (e instanceof Cancelado) throw e;
      // 404 = o job não existe mais: insistir é inútil, o servidor esqueceu.
      if (e instanceof ErroApi && e.status === 404) throw e;
      // Qualquer outra falha (rede, 5xx, tunnel reconectando) é TRANSITÓRIA.
      // O job continua rodando do outro lado; desistir aqui jogaria fora
      // trabalho já feito. Só paramos depois de muitas falhas seguidas.
      falhasSeguidas += 1;
      if (falhasSeguidas >= MAX_FALHAS_SEGUIDAS) {
        throw new ErroApi(
          `Perdi contato com a API por ${falhasSeguidas} tentativas seguidas.`,
          {
            status: e instanceof ErroApi ? e.status : 0,
            dica: 'A leitura pode ter terminado no servidor. Confira se ele está no ar e '
              + 'reenvie o arquivo, ou siga no modo manual colando a tabela.',
            causa: e,
          },
        );
      }
      avisar({
        fase: 'processando', jobId, tentativas, falhasSeguidas,
        mensagem: `sem resposta da API (tentativa ${falhasSeguidas} de ${MAX_FALHAS_SEGUIDAS}) - continuo acompanhando`,
        decorridoMs: Date.now() - inicio,
      });
      continue;
    }

    if (estado?.status === 'concluido') {
      avisar({
        fase: 'concluido', mensagem: 'leitura concluída', jobId, tentativas,
        falhasSeguidas: 0, decorridoMs: Date.now() - inicio,
      });
      return estado.resultado;
    }
    if (estado?.status === 'erro') {
      const status = Number(estado.codigo) || 500;
      throw new ErroApi(String(estado.detalhe || 'A leitura falhou no servidor.'), {
        status, dica: dicaPara(status),
      });
    }
    avisar({
      fase: 'processando', jobId, tentativas, falhasSeguidas: 0,
      mensagem: estado?.progresso || 'processando…',
      decorridoMs: Date.now() - inicio,
    });
  }

  throw new ErroApi(
    `A leitura passou de ${Math.round(tetoMs / 60000)} minutos sem concluir.`,
    {
      dica: 'Documento muito grande ou servidor travado. Envie só as páginas do Balanço '
        + 'e da DRE, ou cole a tabela na etapa Documento.',
    },
  );
}

/**
 * Julgamento semântico das contas que o dicionário não conhece.
 *
 * `candidatos` tem de vir JÁ RESTRITO ao bloco compatível - use
 * `candidatosPara(grupo, sub)` de `core/planoContas.js`. Mandar as 79 posições
 * soltas é o que faria um modelo pequeno errar; e a API recusa lista vazia.
 *
 * @param {Array<object>} linhas linhas pendentes (`pendentesDeJulgamento`)
 * @param {Array<object>} candidatos subconjunto de CONTAS_ALOCAVEIS
 * @param {{sinal?:AbortSignal}} [opcoes]
 * @returns {Promise<{sugestoes:Array<object>, descartadas:string[], provedor:string|null, modelo?:string}>}
 */
export async function julgamental(linhas, candidatos, opcoes = {}) {
  if (!linhas?.length) return { sugestoes: [], descartadas: [], provedor: null };
  if (!candidatos?.length) {
    throw new ErroApi('Nenhum candidato de destino para julgar.', {
      dica: 'Defina Grupo e Sub Categoria das linhas pendentes: é isso que reduz o '
        + 'espaço de decisão de 79 para ~9-15 posições.',
    });
  }
  return requisitar('inferencia', '/julgamental', {
    metodo: 'POST', corpo: { linhas, candidatos }, sinal: opcoes.sinal,
  });
}

/**
 * Parecer executivo. Só prosa - nunca altera dado.
 * @param {object} resumo números já calculados pelo pipeline
 * @param {{sinal?:AbortSignal}} [opcoes]
 * @returns {Promise<{parecer:string, provedor:string, modelo:string}>}
 */
export async function parecer(resumo, opcoes = {}) {
  return requisitar('inferencia', '/parecer', {
    metodo: 'POST', corpo: resumo, sinal: opcoes.sinal,
  });
}

/**
 * Estado do plano de inferência.
 *
 * Timeout curto de propósito: é um indicador de tela, e um `/health` que demora
 * 60s para dizer "fora do ar" é pior que dizer logo. O cartão do Dashboard trata
 * a falha como informação ("inferência indisponível"), não como erro.
 *
 * @param {{sinal?:AbortSignal, timeoutMs?:number}} [opcoes]
 */
export async function health(opcoes = {}) {
  return requisitar('inferencia', '/health', {
    sinal: opcoes.sinal, timeoutMs: opcoes.timeoutMs ?? 8000,
  });
}

/** Consumo e latência por provedor desde o boot do processo (GET /usage). */
export async function usage(opcoes = {}) {
  return requisitar('inferencia', '/usage', { sinal: opcoes.sinal, timeoutMs: 8000 });
}
