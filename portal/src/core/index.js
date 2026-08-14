// Orquestrador do pipeline contábil. Puro: sem DOM, sem rede, sem estado.
// Roda igual no browser, no Node (testes) e - se preciso - no servidor.
//
// ORDEM DAS ETAPAS (a ordem importa):
//
//   1. hierarquia - quem é folha, quem é sintética. Define o que soma.
//   2. classificação - grupo/sub a partir do código contábil (§8.7)
//   3. memória - decisões humanas do cliente (inclui "não alocar")
//   4. dicionário - 1.260 regras curadas
//   5. resolução - todo destino vira a grafia canônica do template
//   6. sinal - §14.2 (natureza D/C) e §14.1 (prefixo do destino)
//   7. finalização - ano1..3, chaves, ordenação
//   8. Shadow - agregação + grafo de subtotais + órfãos + trilha
//   9. QA - Classe A (bloqueia) / Classe B (revisa)
//
// O sinal vem DEPOIS do destino porque §14.1 depende do prefixo do destino. E o
// destino é resolvido ANTES do sinal porque a grafia canônica é o que carrega o
// prefixo correto ("- Depreciação..." vs "Depreciação...").

import { anotarHierarquia } from './hierarchy.js';
import { anotarSecoes } from './secoes.js';
import { resolveDestinoAlocavel, ladoDoBalanco } from './planoContas.js';
import { buildIndex, applyMapping, annotateDictionarySource } from './matching.js';
import { saldoParaApresentacao, applySignByDestino, grupoFromCodigo } from './sign.js';
import { normalizeText, parseNumber, round2 } from './normalize.js';
import { computeYears, finalizeRows, sortRows, alignYearHeaders } from './rastreabilidade.js';
import { computeShadow } from './shadow.js';
import { runQA } from './qa.js';
import { verificarSinteticas, linhaDeTransporteDoResultado } from './invariants.js';
import { DICIONARIO_SEED } from './data/dicionario.gen.js';

export { DICIONARIO_SEED };
export * from './invariants.js';

let contadorId = 0;
const novoId = () => {
  contadorId += 1;
  return `r${contadorId}`;
};

/** Formato canônico de uma linha de entrada. */
function normalizeRow(input) {
  return {
    id: input.id ?? novoId(),
    origem: String(input.origem ?? '').trim(),
    hierarquia: String(input.hierarquia ?? '').trim(),
    codigo: String(input.codigo ?? '').trim(),
    paginaReferencia: String(input.paginaReferencia ?? input.pagina ?? '').trim(),
    // valores CRUS por rótulo de período, como estão no documento
    valoresPorSlot: { ...(input.valoresPorSlot || input.valores || {}) },
    // natureza D/C por período (balancete). string ou objeto {periodo: 'D'|'C'}
    natureza: input.natureza ?? '',
    naturezaPorSlot: { ...(input.naturezaPorSlot || {}) },
    grupo: String(input.grupo ?? '').trim(),
    subCategoria: String(input.subCategoria ?? '').trim(),
    destino: String(input.destino ?? '').trim(),
    tipoMapeamento: String(input.tipoMapeamento ?? '').trim(),
    // `totalizador` vem da LEITURA quando o servidor identificou a linha como
    // subtotal por aritmética. Sem preservá-lo aqui, `anotarHierarquia` perdia
    // essa evidência e um subtotal irmão da DRE da CVM (`3.03 Resultado Bruto`,
    // que é 3.01 + 3.02 e não tem código aninhado) voltava a ser folha alocável.
    totalizador: input.totalizador ?? '',
    alocacaoHierarquia: input.alocacaoHierarquia ?? '',
    justificativa: String(input.justificativa ?? '').trim(),
    confiancaMapeamento: input.confiancaMapeamento,
    noAuto: input.noAuto ?? false,
    _sinalAplicado: input._sinalAplicado ?? false,
    _transporte: input._transporte ?? false,
  };
}

/**
 * Classificação por CÓDIGO CONTÁBIL (§8.7). O 1º dígito manda e prevalece
 * sobre o nome: num balancete, `4.x` é receita mesmo que o nome sugira despesa.
 *
 * Não mexe na NATUREZA - essa vem do D/C da linha. Confundir as duas foi o que
 * levou o v1 a inverter 24 contas retificadoras (R$ 75,5 MM no arquivo real).
 */
function classificarPorCodigo(rows) {
  for (const r of rows) {
    const g = grupoFromCodigo(r.codigo);
    if (g) {
      if (!r.grupo) r.grupo = g.grupo;
      if (g.grupo === 'DRE') { r.grupo = 'DRE'; r.subCategoria = 'DRE'; }
      r._papelContabil = g.papel || '';
      // LADO AUTORITATIVO: vem do código, que é fato do documento. As camadas
      // de matching podem sobrescrever `r.grupo` (o dicionário devolve o grupo
      // do destino), então guardar o lado ANTES é o que permite detectar que
      // uma conta de Ativo terminou alocada no Passivo.
      r._ladoDeclarado = ladoDoBalanco(g.grupo, g.grupo === 'DRE' ? 'DRE' : r.subCategoria);
      r._ladoFonte = 'codigo';
    } else if (r.grupo) {
      r._ladoDeclarado = ladoDoBalanco(r.grupo, r.subCategoria);
      r._ladoFonte = 'documento';
    } else {
      r._ladoDeclarado = '';
      r._ladoFonte = '';
    }
  }
  return rows;
}

/**
 * Aplica a regra de sinal, produzindo TRÊS versões de cada valor:
 *
 *   `valoresRaw`          como está no documento (auditoria)
 *   `valoresApresentacao` §14.2 aplicado - o valor com o sinal que o documento
 *                         quer dizer. Positivo = natureza normal da conta,
 *                         negativo = retificadora.
 *   `valoresPorSlot`      §14.1 também aplicado - o valor A GRAVAR no template,
 *                         onde um destino com prefixo `-` guarda o MÓDULO
 *                         porque a fórmula já subtrai.
 *
 * Distinguir apresentação de gravado é essencial e eu errei isso na primeira
 * versão: a VERIFICAÇÃO DE LEITURA (sintética x soma das folhas) tem de usar a
 * APRESENTAÇÃO. Se usar o valor gravado, uma folha que caiu num destino `neg`
 * sofre `Math.abs()` e passa a divergir da sua sintética - que, sendo contexto,
 * não tem destino e portanto não sofreu `abs()`. Caso real: COFINS e ISSQN
 * (natureza D dentro do grupo 4, ou seja, dedução de receita) casam o
 * dicionário para `-Impostos`, viram módulo, e o bloco 43 "não fechava" por
 * 7.954.956,08 - sendo que a leitura estava perfeita.
 *
 * Respeita `_sinalAplicado`: a linha de transporte de resultado já nasce com o
 * valor final e não pode ser convertida de novo. No v1 era, e o
 * `sinalGrupo('Passivo') = -1` negava o valor, aumentando a diferença em 2x o
 * resultado em vez de fechar o balanço.
 */
function aplicarSinal(rows, opts) {
  const avisos = [];
  for (const r of rows) {
    r.valoresRaw = { ...r.valoresPorSlot };
    if (r._sinalAplicado) {
      r.valoresApresentacao = { ...r.valoresPorSlot };
      continue;
    }
    const apresentacao = {};
    const gravado = {};
    for (const [periodo, bruto] of Object.entries(r.valoresPorSlot)) {
      const nat = r.naturezaPorSlot[periodo] ?? r.natureza ?? '';
      const ap = saldoParaApresentacao(bruto, r.grupo, {
        natureza: nat,
        papel: r._papelContabil || '',
        saldosAbsolutos: opts.saldosAbsolutos ?? false,
      });
      if (ap.fonte === 'ilegivel') {
        (r.valoresInvalidos ??= []).push({ periodo, raw: String(bruto) });
        apresentacao[periodo] = null;
        gravado[periodo] = null;
        continue;
      }
      if (ap.aviso) avisos.push({ id: r.id, origem: r.origem, periodo, aviso: ap.aviso });
      apresentacao[periodo] = ap.valor === null ? null : round2(ap.valor);
      const temDestino = r.destino && String(r.destino).trim();
      const g = temDestino && ap.valor !== null
        ? applySignByDestino(ap.valor, r.destino) : ap.valor;
      gravado[periodo] = g === null ? null : round2(g);
    }
    r.valoresApresentacao = apresentacao;
    r.valoresPorSlot = gravado;
  }
  return avisos;
}

/** Resolve todo destino para a grafia canônica do template. */
function canonicalizarDestinos(rows) {
  const rejeitados = [];
  for (const r of rows) {
    if (!r.destino) continue;
    const res = resolveDestinoAlocavel(r.destino, r.grupo, r.subCategoria);
    if (res.ok) {
      r.destino = res.conta.destino;
      r.grupo = res.conta.grupo;
      r.subCategoria = res.conta.subCategoria;
      r._motivoResolucao = res.conta.motivo;
    } else {
      // mantém o destino como está para o QA apontar exatamente o que veio
      r._destinoInvalido = res.erro;
      rejeitados.push({ id: r.id, origem: r.origem, destino: r.destino, erro: res.erro });
    }
  }
  return rejeitados;
}

/**
 * Executa o pipeline completo.
 *
 * @param {Array} inputRows
 * @param {object} [opts]
 *   `dicionario`        entradas do dicionário (default: seed gerado)
 *   `companyMemory`     memória do cliente (com decisões negativas)
 *   `saldosAbsolutos`   documento traz módulos + coluna D/C (balancete de ERP)
 *   `transportarResultado`  insere a linha de transporte quando o balancete
 *                       não está encerrado (padrão: false - é decisão do usuário)
 * @returns {{rows, years, yearHeaders, shadow, qa, diagnostico}}
 */
export function runPipeline(inputRows, opts = {}) {
  let rows = (inputRows || []).map(normalizeRow);

  // 1 + 2
  const hier = anotarHierarquia(rows);
  classificarPorCodigo(rows);

  // Alocação inicial: folha aloca, sintética é contexto. É a decisão que o v1
  // não tomava no import de planilha (marcava as 358 linhas como "Sim" e
  // contava cada valor 4-6 vezes, inflando o Ativo de 118 MM para ~382 MM).
  for (const r of rows) {
    if (r.alocacaoHierarquia === '') {
      r.alocacaoHierarquia = r._folha ? 'Sim' : 'Não';
      if (!r._folha) r.noAuto = true; // nenhuma camada automática aloca sintética
    }
  }

  // 2.5 - SEÇÕES. Precisa de `_cadeiaPais` (etapa 1) e alimenta o matching
  // (etapas 3 e 4) e a restrição de candidatos do LLM. Ver o cabeçalho de
  // `secoes.js`: numa demonstração publicada a subcategoria só existe no nome
  // das contas-pai, e sem ela `candidatosPara` devolve o grupo inteiro.
  const secoes = anotarSecoes(rows);

  // 3 + 4
  const memIndex = buildIndex(opts.companyMemory || []);
  const memRes = memIndex.length ? applyMapping(rows, memIndex, 'Memória do cliente')
    : { aplicados: 0, bloqueados: 0, invalidos: [] };
  const dictIndex = buildIndex(opts.dicionario || DICIONARIO_SEED);
  const dicRes = applyMapping(rows, dictIndex, 'Dicionário');
  annotateDictionarySource(rows, dictIndex);

  // A linha que NENHUMA camada automática mapeou é justamente a que vai ao
  // julgamento humano ou ao LLM - e é a que mais precisa da subcategoria, porque
  // é ela que restringe os candidatos. Preencher aqui (e não antes) mantém o
  // matching com o comportamento já validado pelos goldens.
  for (const r of rows) {
    if (!r.subCategoria && r._subInferida) {
      r.subCategoria = r._subInferida;
      r._subCategoriaInferida = true;
    }
  }

  // 5
  const rejeitados = canonicalizarDestinos(rows);

  // 6
  const avisosSinal = aplicarSinal(rows, opts);

  // Verificação de LEITURA: sintética x soma das folhas, sobre o valor de
  // APRESENTAÇÃO (§14.2 aplicado, §14.1 não). Se o documento não fecha consigo
  // mesmo, o erro é de LEITURA e fica localizado no bloco - não faz sentido
  // investigar a alocação ainda.
  const periodos = [...new Set(rows.flatMap((r) => Object.keys(r.valoresApresentacao || {})))];
  const verificacaoLeitura = verificarSinteticas(rows, periodos,
    (r, col) => parseNumber((r.valoresApresentacao || {})[col]).value);

  // 7
  let years = computeYears(rows);
  let finalized = sortRows(finalizeRows(rows, years));
  let shadow = computeShadow(finalized);

  // Transporte do resultado (opcional, sob decisão do usuário)
  let transporte = null;
  if (opts.transportarResultado) {
    transporte = linhaDeTransporteDoResultado(shadow.balance, years);
    if (transporte) {
      rows = [...rows, normalizeRow({ ...transporte, id: 'transporte-resultado' })];
      years = computeYears(rows);
      finalized = sortRows(finalizeRows(rows, years));
      shadow = computeShadow(finalized);
    }
  }

  // 9
  const qa = runQA(finalized, shadow, dictIndex, { verificacaoLeitura });

  return {
    rows: finalized,
    years,
    yearHeaders: alignYearHeaders(years),
    shadow,
    qa,
    dictIndex,
    diagnostico: {
      hierarquia: hier,
      secoes,
      verificacaoLeitura,
      memoria: memRes,
      dicionario: dicRes,
      destinosRejeitados: rejeitados,
      avisosSinal,
      regrasInvalidas: [...memRes.invalidos, ...dicRes.invalidos],
      transporteAplicado: transporte ? transporte.valoresPorSlot : null,
    },
  };
}

/**
 * Entradas de memória a partir de linhas revisadas - POSITIVAS e NEGATIVAS.
 *
 * No v1 só as positivas eram exportadas, então a retirada manual de uma conta
 * era perdida e o dicionário a realocava na análise seguinte.
 *
 * @param {Array} rows linhas finalizadas
 * @param {{apenasConfirmadas?:boolean}} [opts]
 */
export function memoriaDeRows(rows, opts = {}) {
  const out = [];
  for (const r of rows || []) {
    const origem = String(r.origem ?? '').trim();
    if (!origem || r._transporte) continue;

    const confirmado = Boolean(r.confirmadoPorHumano || r.noAuto
      || r.tipoMapeamento === 'Julgamental');
    if (opts.apenasConfirmadas && !confirmado) continue;

    // FALLBACK NÃO É CONHECIMENTO. A posição residual é o que se usa quando
    // NENHUMA posição nomeada correspondia - gravá-la na memória do cliente a
    // transformaria em decisão, e na análise seguinte ela voltaria como
    // "Memória do cliente", que é a camada de MAIOR confiança do matching.
    // O palpite de hoje viraria a verdade de amanhã, sem ninguém ter decidido.
    if (r.tipoMapeamento === 'Residual' && !r.confirmadoPorHumano) continue;

    if (r.alocacaoHierarquia === 'Sim' && String(r.destino ?? '').trim()) {
      out.push({
        origem,
        destino: String(r.destino).trim(),
        grupo: String(r.grupo || '').trim(),
        subCategoria: String(r.subCategoria || '').trim(),
        decisao: 'alocar',
        confirmadoPorHumano: confirmado,
      });
    } else if (r.noAuto || r._folha === false) {
      // decisão negativa: o analista retirou, ou é sintética (contexto)
      out.push({
        origem,
        destino: '',
        grupo: String(r.grupo || '').trim(),
        subCategoria: String(r.subCategoria || '').trim(),
        decisao: r._folha === false ? 'contexto' : 'nao_alocar',
        confirmadoPorHumano: confirmado,
      });
    }
  }
  // dedupe por chave normalizada, última decisão vence
  const porChave = new Map();
  for (const e of out) {
    porChave.set([normalizeText(e.origem), normalizeText(e.grupo),
      normalizeText(e.subCategoria)].join('|'), e);
  }
  return [...porChave.values()];
}
