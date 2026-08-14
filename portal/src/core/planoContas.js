// Plano de contas do template: resolução canônica de destino.
//
// Este módulo é o ÚNICO ponto autorizado a decidir em que posição do template
// uma linha cai. Todo destino que entra na Rastreabilidade passa por
// `resolveDestino`, que devolve `destino`, `grupo` e `subCategoria` com a
// grafia EXATA do template - ou `null`, e aí a linha fica visivelmente sem
// destino em vez de virar uma chave órfã silenciosa.
//
// Contraste com o v1, onde havia `canonicalDestino()` que só corrigia o NOME
// (deixando grupo/sub como vieram) e cujas duas regras de reparo eram código
// morto:
//   1. as chaves do mapa de aliases não foram normalizadas, e a busca era
//      `MAPA.get(normalizeText(destino))` - então chaves contendo `/`, `(`,
//      `)` ou `+` eram inalcançáveis (3 dos 5 aliases);
//   2. a regra `L/P` -> `LP` usava /\bl\s*\/\s*p\b/, que exige uma barra que
//      `normalizeText` já havia trocado por espaço - logo as ~138 entradas
//      "Mútuo Financeiro L/P" e "Bancos L/P" (Passivo Não Circulante) nunca
//      eram corrigidas, e o lado direito do balanço perdia valor.

import { PLANO_CONTAS } from './data/planoContas.gen.js';
import { normalizeText } from './normalize.js';
import { aggKey } from './keys.js';

export { PLANO_CONTAS };

/** Contas que recebem alocação (têm bucket de agregação). São 79. */
export const CONTAS_ALOCAVEIS = PLANO_CONTAS.filter((p) => p.tipo === 'conta');

/** Subtotais: calculados por aritmética, NUNCA alocáveis. São 28. */
export const SUBTOTAIS = PLANO_CONTAS.filter((p) => p.tipo === 'subtotal');

// Ordem dos blocos na Shadow.
export const GROUP_SUB_ORDER = {
  'ativo|circulante': 0,
  'ativo|nao circulante': 1,
  'passivo|circulante': 2,
  'passivo|nao circulante': 3,
  'passivo|pl': 4,
  'dre|dre': 5,
};

export function groupSubOrder(grupo, sub) {
  return GROUP_SUB_ORDER[`${normalizeText(grupo)}|${normalizeText(sub)}`] ?? 99;
}

// ---------------------------------------------------------------------------
// Índices
// ---------------------------------------------------------------------------
/** aggKey completa -> entrada do plano. */
const POR_CHAVE = new Map();
/** nome normalizado -> [entradas] (mais de uma = homônimo entre grupos). */
const POR_NOME = new Map();

for (const p of PLANO_CONTAS) {
  POR_CHAVE.set(aggKey(p.destino, p.grupo, p.subCategoria), p);
  const n = normalizeText(p.destino);
  if (!POR_NOME.has(n)) POR_NOME.set(n, []);
  POR_NOME.get(n).push(p);
}

/**
 * Nomes que existem em mais de um grupo - só `grupo` desambigua.
 * Hoje: "Mútuo Financeiro" (Ativo 18 / Passivo 54), "Mútuo Financeiro LP"
 * (Ativo 26 / Passivo 67) e "Participações Minoritárias" (BP 75 Passivo|PL /
 * DRE 40), que normalizam para a mesma string apesar do prefixo `+/-`.
 */
export const NOMES_AMBIGUOS = new Set(
  [...POR_NOME.entries()].filter(([, v]) => v.length > 1).map(([k]) => k),
);

// ---------------------------------------------------------------------------
// Reescritas de grafia. Espelham scripts/bootstrap_knowledge.py - mantenha as
// duas listas em sincronia (há teste de paridade).
// As chaves JÁ ESTÃO NORMALIZADAS: é exatamente isso que faltava no v1.
// ---------------------------------------------------------------------------
const ALIASES = new Map([
  ['Fornecedores Externos', 'Fornecedores'],
  ['Outros Nao Operacionais (ANC)', 'Outros Não Operacionais LP (ANC)'],
  ['Outros Não Operacionais (ANC)', 'Outros Não Operacionais LP (ANC)'],
  ['Ajustes derivativos / cambio (+) L/P', 'Ajustes derivativos / cambio (PNC)'],
].map(([k, v]) => [normalizeText(k), v]));

/** Aliases que também corrigem grupo/sub (o v1 classificou o grupo errado). */
const ALIASES_COM_GRUPO = new Map([
  ['PARTICIPAÇÕES MINORITÁRIAS',
    { destino: 'PARTICIPAÇÕES MINORITÁRIAS', grupo: 'Passivo', subCategoria: 'PL' }],
  ['Ajustes derivativos / cambio (+)',
    { destino: 'Ajustes derivativos / cambio (+)', grupo: 'Passivo', subCategoria: 'Circulante' }],
].map(([k, v]) => [normalizeText(k), v]));

/**
 * Reescritas genéricas sobre o texto JÁ NORMALIZADO. Só são aceitas se
 * resolverem para uma conta do plano, então são seguras: no pior caso não
 * resolvem e a linha cai como "destino inexistente" - visível, não silenciosa.
 */
const REESCRITAS = [
  [/\bl p\b/g, 'lp'],          // "Mútuo Financeiro L/P" -> LP   (97 entradas)
  [/\bde longo prazo\b/g, 'lp'], // "Dividas Fiscais de Longo Prazo" (35)
  [/\blongo prazo\b/g, 'lp'],
  [/\bnao circulante\b/g, 'lp'], // "Passivo de Arrendamento não Circulante" (7)
];

/** Acha a entrada por chave completa; senão por nome, desambiguando por grupo. */
function buscar(nomeNorm, grupoNorm, subNorm) {
  const exato = POR_CHAVE.get([nomeNorm, grupoNorm, subNorm].join('|'));
  if (exato) return exato;
  const cands = POR_NOME.get(nomeNorm);
  if (!cands || !cands.length) return null;
  if (grupoNorm) {
    const noGrupo = cands.filter((c) => normalizeText(c.grupo) === grupoNorm);
    if (noGrupo.length === 1) return noGrupo[0];
    if (noGrupo.length > 1) {
      // mesmo grupo, subs diferentes: prefere a sub informada, senão desiste
      const noSub = noGrupo.filter((c) => normalizeText(c.subCategoria) === subNorm);
      return noSub.length === 1 ? noSub[0] : null;
    }
  }
  // sem grupo informado: só aceita se o nome for único no plano inteiro
  return cands.length === 1 ? cands[0] : null;
}

/**
 * Resolve um destino qualquer para a posição canônica do template.
 *
 * @param {string} destino
 * @param {string} [grupo]
 * @param {string} [subCategoria]
 * @returns {{destino:string, grupo:string, subCategoria:string, row:number,
 *            side:string, tipo:string, sign:string, motivo:string}|null}
 *   `motivo` ∈ exato | alias | reescrita | nome-unico - útil para auditoria.
 *   `null` quando não resolve: destino inexistente, ambíguo sem grupo, ou
 *   subtotal (que não é alocável).
 */
export function resolveDestino(destino, grupo, subCategoria) {
  if (!destino || !String(destino).trim()) return null;
  const n = normalizeText(destino);
  const g = normalizeText(grupo);
  const s = normalizeText(subCategoria);

  const direto = POR_CHAVE.get([n, g, s].join('|'));
  if (direto) return { ...direto, motivo: 'exato' };

  const comGrupo = ALIASES_COM_GRUPO.get(n);
  if (comGrupo) {
    const alvo = buscar(normalizeText(comGrupo.destino),
      normalizeText(comGrupo.grupo), normalizeText(comGrupo.subCategoria));
    if (alvo) return { ...alvo, motivo: 'alias' };
  }

  const alias = ALIASES.get(n);
  if (alias) {
    const alvo = buscar(normalizeText(alias), g, s);
    if (alvo) return { ...alvo, motivo: 'alias' };
  }

  for (const [re, troca] of REESCRITAS) {
    const n2 = n.replace(re, troca);
    if (n2 !== n) {
      const alvo = buscar(n2, g, s);
      if (alvo) return { ...alvo, motivo: 'reescrita' };
    }
  }

  const alvo = buscar(n, g, s);
  return alvo ? { ...alvo, motivo: 'nome-unico' } : null;
}

/**
 * Resolve exigindo que o resultado seja ALOCÁVEL (`tipo === 'conta'`).
 * Devolve `{ok, conta, erro}` - `erro` é a mensagem pronta para o QA.
 */
export function resolveDestinoAlocavel(destino, grupo, subCategoria) {
  const nome = String(destino ?? '').trim();
  if (!nome) return { ok: false, conta: null, erro: null }; // sem destino ainda
  const r = resolveDestino(nome, grupo, subCategoria);
  if (!r) {
    const n = normalizeText(nome);
    if (NOMES_AMBIGUOS.has(n)) {
      return {
        ok: false,
        conta: null,
        erro: `Destino "${nome}" existe em mais de um grupo - informe o Grupo `
          + `para desambiguar (${(POR_NOME.get(n) || [])
            .map((c) => `${c.grupo}/${c.subCategoria}`).join(' ou ')}).`,
      };
    }
    return {
      ok: false,
      conta: null,
      erro: `Destino "${nome}" não existe no plano de contas do template.`,
    };
  }
  if (r.tipo !== 'conta') {
    return {
      ok: false,
      conta: null,
      erro: `Destino "${r.destino}" é um subtotal calculado (linha ${r.row}) e `
        + 'não recebe alocação - o valor seria descartado. Aloque numa conta analítica.',
    };
  }
  return { ok: true, conta: r, erro: null };
}

/** Ordem da conta dentro do bloco (para ordenar a Rastreabilidade). */
export function destinationOrder(destino, grupo, subCategoria) {
  const r = resolveDestino(destino, grupo, subCategoria);
  return r ? r.row : 9999;
}

/** true se `destino` é uma conta alocável compatível com grupo/sub. */
export function isDestinoAlocavel(destino, grupo, subCategoria) {
  return resolveDestinoAlocavel(destino, grupo, subCategoria).ok;
}

/**
 * Lado do balanço a que a posição pertence - `'ativo' | 'passivoPl' | 'dre'`.
 * É o conceito que torna o fechamento imune a erro de julgamento: realocar
 * DENTRO do mesmo lado não muda `Ativo` nem `Passivo + PL`.
 */
export function ladoDoBalanco(grupo, subCategoria) {
  const g = normalizeText(grupo);
  const s = normalizeText(subCategoria);
  if (g === 'dre' || s === 'dre') return 'dre';
  if (g === 'ativo') return 'ativo';
  if (g === 'passivo') return 'passivoPl';
  return '';
}

/**
 * Contas alocáveis compatíveis com um grupo/sub - usado para restringir o
 * conjunto de candidatos ANTES de chamar o LLM. Reduz o espaço de decisão de
 * 79 para ~9-15 opções, o que é o que viabiliza um modelo local pequeno.
 */
export function candidatosPara(grupo, subCategoria) {
  const g = normalizeText(grupo);
  const s = normalizeText(subCategoria);
  if (!g) return CONTAS_ALOCAVEIS;
  return CONTAS_ALOCAVEIS.filter((c) => {
    if (normalizeText(c.grupo) !== g) return false;
    return !s || normalizeText(c.subCategoria) === s;
  });
}

/**
 * POSIÇÃO RESIDUAL de cada bloco - a casa de quem não tem casa.
 *
 * Todo bloco do plano tem uma posição "Outros …" que existe exatamente para a
 * conta que não corresponde a nenhuma linha nomeada. Duas propriedades a tornam
 * segura como último recurso:
 *
 *  · está DENTRO do bloco, logo do lado certo do balanço - e realocar dentro do
 *    mesmo lado não altera `Ativo` nem `Passivo + PL` (ver `ladoDoBalanco`);
 *  · a da DRE é `+/-`, isto é, aceita os dois sinais. Isso importa: a residual é
 *    usada justamente quando não se sabe a direção, e mandá-la para
 *    `- Despesas …` ou `+ Receitas …` produziria `sinal-incompativel`.
 *
 * `Outras Reservas` é a residual do PL por convenção - não existe "Outros PL".
 *
 * ISTO NÃO É PALPITE DISFARÇADO. Quem aplica marca `tipoMapeamento = 'Residual'`
 * e o QA emite aviso de Classe B nominal para cada linha. A alternativa é pior:
 * linha sem destino é Classe A e bloqueia a entrega inteira.
 */
const POSICAO_RESIDUAL = {
  'ativo|circulante': 'Outros Operacionais (AC)',
  'ativo|nao circulante': 'Outros Operacionais (ANC)',
  'passivo|circulante': 'Outros Operacionais (PC)',
  'passivo|nao circulante': 'Outros Operacionais (PNC)',
  'passivo|pl': 'Outras Reservas',
  'dre|dre': '+/-Outras Receitas/Despesas Operacionais',
};

/**
 * Posição residual do bloco, já na grafia canônica do template, ou `null`.
 * @param {string} grupo
 * @param {string} subCategoria
 * @returns {{destino:string, grupo:string, subCategoria:string}|null}
 */
export function posicaoResidual(grupo, subCategoria) {
  const chave = `${normalizeText(grupo)}|${normalizeText(subCategoria)}`;
  const destino = POSICAO_RESIDUAL[chave];
  if (!destino) return null;
  const res = resolveDestinoAlocavel(destino, grupo, subCategoria);
  // Se o plano mudar e a posição sair, é melhor devolver null do que um destino
  // inexistente: destino fora do plano é Classe A, e o remédio seria pior.
  return res.ok ? res.conta : null;
}

/**
 * Destinos de reconciliação: existem no template mas alocar direto neles
 * distorce indicadores (o EBITDA subtrai `+/-Provisões Operacionais` de novo,
 * porque provisão não é caixa). Gera aviso, não bloqueio.
 */
export const DESTINOS_ATENCAO = new Set([
  '- Despesas/Custo de Aluguel',
  '+/-Provisões Operacionais',
].map(normalizeText));
