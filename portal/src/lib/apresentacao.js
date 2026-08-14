// Funções PURAS que montam os dados de exibição dos painéis.
//
// Por que este módulo existe separado dos componentes: a lógica que decide "este
// balde é vazamento e vai vermelho" e "esta issue bloqueia a entrega" é a mesma
// que sustenta a tese do projeto. Se ela vive dentro do JSX, só é testável com
// DOM - e um teste de DOM que renderiza React é lento, frágil e não é o que
// queremos provar. Extraída, é `node:test` puro (portal/test/pipeline-ui.test.mjs).
//
// Nada aqui lê estado, faz rede ou toca no DOM. Entra dado do pipeline, sai
// estrutura para renderizar.

import { ANOS } from '../core/invariants.js';
import { normalizeText } from '../core/normalize.js';

// ---------------------------------------------------------------------------
// TRILHA DE VALOR
// ---------------------------------------------------------------------------
/**
 * Baldes da equação de conservação, na ordem em que o analista lê.
 *
 * `severidade`:
 *   `origem`  Σ das folhas alocadas - é o lado esquerdo da equação, referência
 *   `ok`      chegou ao destino: é o que DEVERIA acontecer com tudo
 *   `perda`   valor que NÃO chegou a nenhuma posição -> vermelho quando != 0
 *   `memo`    valor que chegou à Shadow mas não alcança o Lucro Líquido ->
 *             âmbar, porque NÃO é perda (ver nota abaixo)
 *
 * Os quatro baldes de `perda` são exatamente as quatro condições que podem furar
 * `Ativo = Passivo + PL`. Não é uma lista de avisos genéricos: é a decomposição
 * completa do vazamento, e é o painel que na v1 não existia - lá o dinheiro
 * simplesmente não aparecia em lugar nenhum.
 */
export const BALDES_TRILHA = Object.freeze([
  {
    campo: 'folhasSim',
    rotulo: 'Σ folhas alocadas',
    severidade: 'origem',
    explicacao: 'Soma de todas as linhas marcadas para alocar. É o lado esquerdo da '
      + 'equação de conservação: tudo isto tem de reaparecer nas linhas abaixo.',
  },
  {
    campo: 'alocado',
    rotulo: 'chegou às posições',
    severidade: 'ok',
    explicacao: 'Valor que caiu numa das 79 posições alocáveis do template. '
      + 'No caso ideal é igual à linha de cima e todo o resto é zero.',
  },
  {
    campo: 'orfao',
    rotulo: 'chave órfã',
    severidade: 'perda',
    explicacao: 'O destino não existe no plano de contas com aquela grafia, então o '
      + 'valor não entra em nenhuma linha. Foi a causa raiz nº 1 da v1: 229 das '
      + '1.285 regras do dicionário apontavam para destinos inexistentes e o valor '
      + 'desaparecia sem gerar erro.',
  },
  {
    campo: 'subtotal',
    rotulo: 'alocado em subtotal',
    severidade: 'perda',
    explicacao: 'Subtotais são calculados por fórmula e não têm bucket de agregação - '
      + 'alocar neles descarta o valor. "Estoques" e "Disponibilidades" são os '
      + 'destinos mais intuitivos para um humano, e são subtotais.',
  },
  {
    campo: 'semDestino',
    rotulo: 'sem destino',
    severidade: 'perda',
    explicacao: 'Linha marcada para alocar, com valor, mas sem destino escolhido. '
      + 'Basta preencher o destino na grade.',
  },
  {
    campo: 'ladoTrocado',
    rotulo: 'lado trocado',
    severidade: 'perda',
    explicacao: 'A conta é de um lado do balanço (Ativo / Passivo+PL / DRE) e o destino '
      + 'é de outro. Quebra o fechamento em DUAS vezes o valor: sai de um lado e '
      + 'entra no outro.',
  },
  {
    campo: 'memoDre',
    rotulo: 'memorando da DRE',
    severidade: 'memo',
    // Esta nota é o ponto mais fácil de interpretar errado no painel inteiro.
    explicacao: 'NÃO é perda: o valor está na Shadow e aparece na linha da DRE. Só não '
      + 'alcança o Lucro Líquido, porque são posições de add-back do EBITDA '
      + '(depreciação e aluguel, já dentro do EBIT) ou abaixo da linha do resultado '
      + '(abrangentes, dividendos, minoritários). É o desenho do template, não um bug - '
      + 'mas é invisível, e por isso aparece separado.',
  },
]);

/**
 * Linhas do painel de trilha para UM ano.
 *
 * @param {object} trilha `result.shadow.trilha`
 * @param {'ano1'|'ano2'|'ano3'} ano
 * @returns {Array<{campo:string, rotulo:string, severidade:string, explicacao:string,
 *   valor:number, zero:boolean, alerta:boolean, temDetalhes:boolean, nDetalhes:number}>}
 *   `alerta` = precisa de destaque vermelho (é perda e não é zero).
 */
export function linhasDaTrilha(trilha, ano) {
  if (!trilha) return [];
  return BALDES_TRILHA.map((b) => {
    const valor = Number(trilha[b.campo]?.[ano] ?? 0) || 0;
    const zero = Math.abs(valor) < 0.005;
    const detalhes = trilha.detalhes?.[b.campo] ?? [];
    return {
      ...b,
      valor,
      zero,
      // Só `perda` fica vermelho. `memoDre` diferente de zero é âmbar e `alocado`
      // diferente de zero é o comportamento desejado.
      alerta: b.severidade === 'perda' && !zero,
      atencao: b.severidade === 'memo' && !zero,
      temDetalhes: detalhes.length > 0,
      nDetalhes: detalhes.length,
    };
  });
}

/**
 * Resumo da trilha para o cabeçalho e o badge.
 *
 * `conserva` vem de `trilha.ok`, que é a conjunção de "a conta fecha" e "não há
 * perda" nos três anos. Não recalculamos aqui de propósito: uma segunda
 * implementação da mesma conta é uma segunda fonte de verdade capaz de divergir.
 *
 * @param {object} trilha
 */
export function resumoDaTrilha(trilha) {
  if (!trilha) {
    return { conserva: false, semDados: true, anos: [], perdaTotal: 0, memoTotal: 0 };
  }
  const anos = ANOS.filter((a) => {
    const folhas = Number(trilha.folhasSim?.[a] ?? 0);
    const alocado = Number(trilha.alocado?.[a] ?? 0);
    return Math.abs(folhas) >= 0.005 || Math.abs(alocado) >= 0.005;
  });
  return {
    conserva: Boolean(trilha.ok),
    semDados: anos.length === 0,
    anos,
    perdaTotal: anos.reduce((s, a) => s + Math.abs(Number(trilha.perdas?.[a] ?? 0)), 0),
    memoTotal: anos.reduce((s, a) => s + Math.abs(Number(trilha.memoDre?.[a] ?? 0)), 0),
  };
}

// ---------------------------------------------------------------------------
// QA - CLASSE A vs CLASSE B
// ---------------------------------------------------------------------------
/**
 * Texto curto que abre o painel de QA. Fica aqui, e não no JSX, porque é
 * conteúdo - e porque o teste garante que a distinção não se perde numa refação.
 */
export const TEXTO_CLASSES = Object.freeze({
  A: 'CLASSE A - álgebra: se falha, não entrega. São as condições que podem furar '
    + 'Ativo = Passivo + PL, mais a leitura do documento. Verificadas por código, '
    + 'não por opinião.',
  B: 'CLASSE B - revisável por humano: afeta KPI e composição, nunca o fechamento. '
    + 'Qual conta exatamente dentro do bloco certo, Circulante vs Não Circulante '
    + '(ambos entram na mesma linha do template), divergência do dicionário. '
    + 'Sinalizada e justificada - nunca bloqueia.',
});

/**
 * @typedef {object} Issue saída de `runQA`
 * @property {'A'|'B'} classe
 * @property {'error'|'action'|'warn'|'info'} level
 * @property {string} code
 * @property {string} msg
 * @property {string} [id] id da linha, quando a issue é localizável
 * @property {number} [transporte] valor sugerido (só em `nao-encerrado`)
 * @property {string} [ano]
 * @property {string} [chave]
 */

/**
 * Separa as issues nos grupos que a tela mostra.
 *
 * `acoes` é `level === 'action'` e existe por um caso só: `nao-encerrado`. Não é
 * erro do sistema nem do modelo - é a natureza do documento (balancete cujo
 * resultado ainda não foi transportado ao PL). Não bloqueia, mas exige um clique
 * consciente, e o valor exato do transporte já é conhecido.
 *
 * @param {Issue[]} issues
 * @returns {{classeA:{erros:Issue[], acoes:Issue[]}, classeB:{avisos:Issue[], infos:Issue[]},
 *   bloqueado:boolean, contagens:{erros:number, acoes:number, avisos:number, infos:number}}}
 */
export function separarIssues(issues) {
  const lista = Array.isArray(issues) ? issues : [];
  const erros = lista.filter((i) => i.classe === 'A' && i.level === 'error');
  const acoes = lista.filter((i) => i.classe === 'A' && i.level === 'action');
  const avisos = lista.filter((i) => i.classe === 'B' && i.level === 'warn');
  const infos = lista.filter((i) => i.classe === 'B' && i.level === 'info');
  return {
    classeA: { erros, acoes },
    classeB: { avisos, infos },
    // `bloqueado` é DERIVADO da existência de erro de Classe A, igual ao núcleo.
    bloqueado: erros.length > 0,
    contagens: {
      erros: erros.length,
      acoes: acoes.length,
      avisos: avisos.length,
      infos: infos.length,
    },
  };
}

/** Agrupa issues por `code`, preservando a ordem de primeira aparição. */
export function agruparPorCodigo(issues) {
  const mapa = new Map();
  for (const i of issues || []) {
    if (!mapa.has(i.code)) mapa.set(i.code, []);
    mapa.get(i.code).push(i);
  }
  return [...mapa.entries()].map(([code, itens]) => ({ code, itens }));
}

/** Ids de linha com erro de Classe A - a grade destaca essas linhas. */
export function idsComErroClasseA(issues) {
  const ids = new Set();
  for (const i of issues || []) {
    if (i.classe === 'A' && i.level === 'error' && i.id) ids.add(i.id);
  }
  return ids;
}

/**
 * Badge do balanço para o cabeçalho fixo da Shadow.
 *
 * Os três estados que precisam ser visualmente distintos, porque exigem ações
 * diferentes do analista:
 *
 *   `fechado`        `A = P + PL`. Entregável.
 *   `nao-encerrado`  não fecha a simples, fecha a ESTENDIDA, e a diferença é
 *                    exatamente o resultado do período. Não é erro: falta
 *                    transportar. Um clique resolve e o valor já é conhecido.
 *   `divergente`     não fecha nenhuma das duas. Aí sim há erro a investigar,
 *                    e a trilha diz onde.
 *
 * A v1 não distinguia: qualquer `dif != 0` virava "não fecha, investigue".
 *
 * @param {object} balance `result.shadow.balance[ano]`
 * @returns {{estado:'sem-dados'|'fechado'|'nao-encerrado'|'divergente', texto:string,
 *   detalhe:string, dif:number, difRelativa:number, transporte:number|null}}
 */
export function badgeDoBalanco(balance) {
  if (!balance || balance.semDados) {
    return {
      estado: 'sem-dados',
      texto: 'sem dados no período',
      detalhe: 'Nenhum valor alocado neste período ainda.',
      dif: 0,
      difRelativa: 0,
      transporte: null,
    };
  }
  if (balance.fecha) {
    return {
      estado: 'fechado',
      // A tolerância é RELATIVA ao Ativo (com piso absoluto), não um `< 0,50`
      // fixo: para um Ativo de R$ 118 milhões, R$ 1 de resíduo de arredondamento
      // reprovava na v1 um balanço legitimamente fechado.
      texto: 'A = P + PL',
      detalhe: 'Ativo e Passivo+PL batem dentro da tolerância relativa ao tamanho do Ativo.',
      dif: balance.dif,
      difRelativa: balance.difRelativa,
      transporte: null,
    };
  }
  if (balance.naoEncerrado) {
    return {
      estado: 'nao-encerrado',
      texto: 'balancete não encerrado',
      detalhe: 'A identidade estendida fecha: a diferença é exatamente o resultado do '
        + 'período, que ainda não foi transportado ao Patrimônio Líquido. Não é erro.',
      dif: balance.dif,
      difRelativa: balance.difRelativa,
      transporte: balance.transporteSugerido,
    };
  }
  return {
    estado: 'divergente',
    texto: 'A ≠ P + PL',
    detalhe: 'Nem a identidade simples nem a estendida fecham. A trilha de valor mostra '
      + 'em qual balde o valor está parando.',
    dif: balance.dif,
    difRelativa: balance.difRelativa,
    transporte: null,
  };
}

// ---------------------------------------------------------------------------
// DIFF DE MEMÓRIA
// ---------------------------------------------------------------------------
/** Chave de identidade de uma decisão: (origem, grupo, sub) normalizados. */
export function chaveMemoria(entrada) {
  return [
    normalizeText(entrada?.origem),
    normalizeText(entrada?.grupo),
    normalizeText(entrada?.subCategoria),
  ].join('|');
}

/** Indexa por chave; em empate, a ÚLTIMA decisão vence (igual a `memoriaDeRows`). */
function indexar(entradas) {
  const m = new Map();
  for (const e of entradas || []) {
    const k = chaveMemoria(e);
    if (!k.split('|')[0]) continue; // sem origem: a chave casaria com qualquer coisa
    m.set(k, e);
  }
  return m;
}

/**
 * Compara a memória GRAVADA com a memória PROPOSTA pela análise atual.
 *
 * Espelha `diff_memoria` de server/app/db/memoria.py - inclusive na decisão de
 * manter `destinoMudou` e `decisaoMudou` DISJUNTOS. Uma entrada que virou
 * `nao_alocar` também "perdeu o destino", mas contá-la nas duas linhas do painel
 * infla os números e ensina o analista a aprovar sem ler. Trocar de destino
 * continuando a alocar é uma CORREÇÃO; virar `nao_alocar` é uma decisão de outra
 * natureza.
 *
 * A comparação de destino é NORMALIZADA: "Mútuo Financeiro" e "MUTUO FINANCEIRO"
 * são o mesmo destino, e mostrar isso como "alterada" seria ruído.
 *
 * @param {Array<object>} anterior memória carregada do cliente
 * @param {Array<object>} proposta `memoriaDeRows(result.rows)`
 * @returns {{
 *   novas:Array<object>,
 *   alteradas:Array<{chave:string, de:object, para:object, destinoMudou:boolean, decisaoMudou:boolean}>,
 *   removidas:Array<object>,
 *   inalteradas:Array<object>,
 *   naoAlocar:Array<object>,
 *   contexto:Array<object>,
 *   resumo:{novas:number, alteradas:number, destinoMudou:number, decisaoMudou:number,
 *           removidas:number, inalteradas:number, naoAlocar:number, contexto:number,
 *           confirmadas:number, total:number},
 *   temMudanca:boolean
 * }}
 */
export function montarDiffMemoria(anterior, proposta) {
  const antes = indexar(anterior);
  const depois = indexar(proposta);

  const novas = [];
  const alteradas = [];
  const inalteradas = [];

  for (const [chave, entrada] of depois) {
    const velha = antes.get(chave);
    if (!velha) { novas.push(entrada); continue; }
    const destinoMudou = normalizeText(velha.destino) !== normalizeText(entrada.destino);
    const decisaoMudou = (velha.decisao || 'alocar') !== (entrada.decisao || 'alocar');
    if (destinoMudou || decisaoMudou) {
      alteradas.push({
        chave,
        de: velha,
        para: entrada,
        // disjuntos: quando a decisão mudou, não contamos também como troca de destino
        destinoMudou: destinoMudou && !decisaoMudou,
        decisaoMudou,
      });
    } else {
      inalteradas.push(entrada);
    }
  }

  const removidas = [...antes.entries()]
    .filter(([chave]) => !depois.has(chave))
    .map(([, e]) => e);

  const propostas = [...novas, ...alteradas.map((a) => a.para), ...inalteradas];
  const naoAlocar = propostas.filter((e) => e.decisao === 'nao_alocar');
  const contexto = propostas.filter((e) => e.decisao === 'contexto');

  return {
    novas,
    alteradas,
    removidas,
    inalteradas,
    naoAlocar,
    contexto,
    resumo: {
      novas: novas.length,
      alteradas: alteradas.length,
      destinoMudou: alteradas.filter((a) => a.destinoMudou).length,
      decisaoMudou: alteradas.filter((a) => a.decisaoMudou).length,
      removidas: removidas.length,
      inalteradas: inalteradas.length,
      naoAlocar: naoAlocar.length,
      contexto: contexto.length,
      confirmadas: propostas.filter((e) => e.confirmadoPorHumano).length,
      total: propostas.length,
    },
    // Nada mudou -> não vale abrir o painel de confirmação.
    temMudanca: novas.length > 0 || alteradas.length > 0 || removidas.length > 0,
  };
}

// ---------------------------------------------------------------------------
// SHADOW
// ---------------------------------------------------------------------------
/**
 * Agrupa as linhas da Shadow em blocos (Ativo Circulante, ..., DRE) para
 * renderizar com cabeçalho de seção.
 *
 * @param {Array<object>} linhas `shadow.ativoPassivo` ou `shadow.dre`
 */
export function blocosDaShadow(linhas) {
  const blocos = [];
  let atual = null;
  for (const l of linhas || []) {
    const rotulo = l.grupo === 'DRE' || l.subCategoria === 'DRE'
      ? 'DRE'
      : `${l.grupo} · ${l.subCategoria}`;
    if (!atual || atual.rotulo !== rotulo) {
      atual = { rotulo, grupo: l.grupo, subCategoria: l.subCategoria, linhas: [] };
      blocos.push(atual);
    }
    atual.linhas.push(l);
  }
  return blocos;
}

/**
 * Linha da Shadow tem valor em algum ano?
 * Usado pelo filtro "esconder posições zeradas" - as 79 posições cheias de
 * `0,00` afogam as ~15 que importam num balanço típico.
 */
export function shadowLinhaTemValor(linha) {
  return ANOS.some((a) => Math.abs(Number(linha?.[a] ?? 0)) >= 0.005);
}
