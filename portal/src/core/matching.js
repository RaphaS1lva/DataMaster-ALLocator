// Matching Origem -> Destino. Camadas, em ordem:
//   1. Memória do cliente (decisões humanas da última análise conciliada)
//   2. Dicionário (1.260 regras curadas)
//   3. Julgamental (LLM - fora deste módulo, ver server/app/llm)
//
// Duas mudanças em relação ao v1:
//
// · A memória do cliente agora carrega decisões NEGATIVAS. Quando o analista
//   retira uma conta de uma linha, isso é uma decisão tão informativa quanto
//   alocá-la. No v1 `entriesFromRows` só exportava linhas "Sim" com destino, e
//   a retirada era perdida - então o dicionário realocava a mesma conta na
//   análise seguinte e o analista refazia o mesmo trabalho manual.
//
// · O destino do match passa por `resolveDestinoAlocavel`. No v1 o destino do
//   dicionário era copiado verbatim (`row.destino = m.destino`), e 229 das
//   1.285 entradas tinham grafia divergente do template.

import {
  normalizeText, strongPartialMatch, tokenOverlap, tokenize,
  polaridadeInverte, polaridadeAcrescenta,
} from './normalize.js';
import { resolveDestinoAlocavel, posicaoResidual } from './planoContas.js';

/** Piso de similaridade para aceitar um candidato parcial. */
export const OVERLAP_THRESHOLD = 0.60;

export const DECISAO = {
  ALOCAR: 'alocar',
  NAO_ALOCAR: 'nao_alocar',   // o humano retirou: nenhuma camada automática realoca
  CONTEXTO: 'contexto',       // capturada, mas é totalizador/informativa
};

/**
 * Índice de busca a partir de entradas
 * `{origem, destino, grupo, subCategoria, decisao?, confirmadoPorHumano?}`.
 */
export function buildIndex(entries) {
  return (entries || []).map((e) => ({
    ...e,
    decisao: e.decisao || DECISAO.ALOCAR,
    origemNorm: normalizeText(e.origem),
    grupoNorm: normalizeText(e.grupo),
    subNorm: normalizeText(e.subCategoria),
    tokenCount: tokenize(e.origem).size,
  }));
}

/**
 * Melhor entrada do índice para uma linha.
 *
 * Filtro duro: se grupo (ou sub) existe nos dois lados e difere, descarta,
 * é a regra absoluta "Ativo só vai para Ativo".
 *
 * O texto comparado é `_contaLimpa` quando existe (nome sem cabeçalho de seção
 * grudado nem referência de nota - ver `secoes.js`), senão `origem`. `origem`
 * permanece intocada: é o que o documento diz, e o guardrail "a origem existe no
 * documento" depende disso.
 *
 * Match PARCIAL passa por duas vedações de polaridade; match EXATO não passa por
 * nenhuma, porque grafia idêntica não tem o que inverter e a curadoria do
 * dicionário vale mais que heurística de token.
 */
export function matchEntry(row, index) {
  const alvo = String(row._contaLimpa || row.origem || '');
  const origemNorm = normalizeText(alvo);
  if (!origemNorm) return null;
  const grupoNorm = normalizeText(row.grupo);
  const subNorm = normalizeText(row.subCategoria);
  // A inferida NÃO filtra - só desempata. Filtrar por um dado inferido poderia
  // recusar um acerto do dicionário que hoje funciona; desempatar apenas escolhe
  // melhor entre homônimos (`Financiamentos` existe como `Bancos` e `Bancos LP`).
  const subDesempate = subNorm || normalizeText(row._subInferida);

  const exatos = [];
  const parciais = [];
  for (const e of index || []) {
    if (grupoNorm && e.grupoNorm && grupoNorm !== e.grupoNorm) continue;
    if (subNorm && e.subNorm && subNorm !== e.subNorm) continue;
    if (origemNorm === e.origemNorm) {
      exatos.push(e);
      continue;
    }
    let score = null;
    let porContinencia = false;
    if (strongPartialMatch(origemNorm, e.origemNorm)) {
      score = tokenOverlap(origemNorm, e.origemNorm);
      porContinencia = true;
    } else {
      const s = tokenOverlap(origemNorm, e.origemNorm);
      if (s >= OVERLAP_THRESHOLD) score = s;
    }
    if (score === null) continue;
    // troca de sentido: vale em qualquer caminho de match
    if (polaridadeInverte(origemNorm, e.origemNorm)) continue;
    // parcela casando com linha líquida: só é detectável na continência, onde os
    // tokens excedentes são exatamente o que muda o significado
    if (porContinencia && polaridadeAcrescenta(origemNorm, e.origemNorm)) continue;
    parciais.push({ e, score });
  }

  const subCasa = (e) => (subDesempate && e.subNorm && subDesempate === e.subNorm ? 0 : 1);
  // preferir o que o humano confirmou: decisão revisada vale mais que seed
  const humano = (e) => (e.confirmadoPorHumano ? 0 : 1);

  if (exatos.length) {
    exatos.sort((a, b) => humano(a) - humano(b)
      || subCasa(a) - subCasa(b)
      || b.tokenCount - a.tokenCount
      || a.origemNorm.length - b.origemNorm.length);
    return exatos[0];
  }
  if (parciais.length) {
    parciais.sort((a, b) => b.score - a.score
      || humano(a.e) - humano(b.e)
      || subCasa(a.e) - subCasa(b.e)
      || b.e.tokenCount - a.e.tokenCount);
    return parciais[0].e;
  }
  return null;
}

/**
 * Preenche destino nas linhas que ainda não têm, a partir de um índice.
 * Não sobrescreve destino existente (preserva a decisão do usuário).
 *
 * @returns {{aplicados:number, bloqueados:number, invalidos:Array}}
 */
export function applyMapping(rows, index, tipo) {
  let aplicados = 0;
  let bloqueados = 0;
  const invalidos = [];

  for (const row of rows || []) {
    if (row.destino && String(row.destino).trim()) continue; // já decidido
    if (row.noAuto) continue;                                // humano retirou nesta sessão

    const m = matchEntry(row, index);
    if (!m) continue;

    // decisão negativa vinda da memória: registra e não aloca
    if (m.decisao === DECISAO.NAO_ALOCAR || m.decisao === DECISAO.CONTEXTO) {
      row.alocacaoHierarquia = 'Não';
      row.noAuto = true;
      row.tipoMapeamento = '';
      row.motivoNaoAlocar = `${tipo}: decisão anterior do analista (${m.decisao})`;
      bloqueados += 1;
      continue;
    }

    const res = resolveDestinoAlocavel(m.destino, m.grupo || row.grupo,
      m.subCategoria || row.subCategoria);
    if (!res.ok) {
      // regra de memória/dicionário apontando para destino inválido: NÃO aplica.
      // No v1 aplicava, e a chave virava órfã silenciosa.
      invalidos.push({ origem: row.origem, destino: m.destino, erro: res.erro, fonte: tipo });
      continue;
    }
    row.destino = res.conta.destino;
    row.grupo = res.conta.grupo;
    row.subCategoria = res.conta.subCategoria;
    row.tipoMapeamento = tipo;
    row.confiancaMapeamento = m.confirmadoPorHumano ? 1 : 0.9;
    aplicados += 1;
  }
  return { aplicados, bloqueados, invalidos };
}

/**
 * Se a linha já tinha destino com tipo vazio/Julgamental e o dicionário mapeia
 * a MESMA origem para o MESMO destino, re-rotula como 'Dicionário'.
 * Nunca muda o destino.
 */
export function annotateDictionarySource(rows, dictIndex) {
  for (const row of rows || []) {
    const destino = String(row.destino ?? '').trim();
    if (!destino) continue;
    const tipo = String(row.tipoMapeamento ?? '').trim();
    if (tipo && tipo !== 'Julgamental') continue;
    const m = matchEntry(row, dictIndex);
    if (m && m.decisao === DECISAO.ALOCAR
        && normalizeText(m.destino) === normalizeText(destino)) {
      row.tipoMapeamento = 'Dicionário';
    }
  }
  return rows;
}

/**
 * Linhas que sobraram para o julgamental do LLM: alocáveis, com valor, sem
 * destino e que o humano não retirou.
 */
export function pendentesDeJulgamento(rows) {
  return (rows || []).filter((r) => r.alocacaoHierarquia === 'Sim'
    && !String(r.destino ?? '').trim()
    && !r.noAuto
    && ['ano1', 'ano2', 'ano3'].some((a) => Number(r[a])));
}

/**
 * ÚLTIMO RECURSO: manda cada linha ainda sem destino para a posição residual do
 * seu próprio bloco (`Outros Operacionais (AC)`, `(PNC)`, …).
 *
 * POR QUE EXISTE. O modelo local se abstém de forma DETERMINÍSTICA em conta de
 * nome genérico. Medido no ITR do Fleury, dois rounds idênticos de julgamento:
 * `Outros ativos` (×2), `Arrendamento` e `Dividendos a pagar` voltaram com
 * `destino vazio` nas duas vezes, com a mesma contagem de tokens. Reclicar não
 * resolve - não é aleatoriedade, é recusa estável.
 *
 * E o custo de deixar em branco é alto e desproporcional: `sem-destino` é
 * Classe A e **bloqueia a entrega**, enquanto a residual está no bloco correto e
 * por isso preserva `Ativo = Passivo + PL`. Trocar o bloqueio por um aviso
 * revisável é estritamente melhor.
 *
 * Um caso do Fleury mostra que a regra é a certa mesmo com plano completo:
 * `Dividendos a pagar` aparece no longo prazo, e o plano de 79 **não tem**
 * posição de dividendos no não circulante - só no circulante. Não há o que
 * acertar pelo nome; a residual do bloco é a resposta correta.
 *
 * NÃO É SILENCIOSO, e essa é a condição para ser aceitável:
 *   · `tipoMapeamento = 'Residual'` distingue de Dicionário e de Julgamental;
 *   · `confiancaMapeamento = 0.3` e `_residual = true` marcam a linha;
 *   · o QA emite aviso de Classe B nominal para cada uma;
 *   · a grade mostra o selo e o motivo.
 *
 * ATENÇÃO ao que isto NÃO garante: a identidade fecha, mas o INDICADOR muda.
 * Valor em `Outros Operacionais` não é a mesma leitura de liquidez que em
 * `Clientes`. Por isso cada linha volta pedindo confirmação.
 *
 * É PURA e devolve PATCHES, não muta nada. O motivo é concreto: quem aplica é a
 * tela, e ela precisa escrever nas linhas de ORIGEM (`linhas`), não nas linhas de
 * resultado (`result.rows`). Rodar o pipeline sobre a própria saída aplicaria a
 * regra de sinal duas vezes - uma folha em destino `neg` sofreria `Math.abs()`
 * outra vez e divergiria da sua sintética. Devolver patches deixa a decisão de
 * onde escrever com o chamador, e mantém UMA implementação da regra.
 *
 * @param {Array} rows linhas JÁ processadas (precisam de grupo/subCategoria)
 * @returns {{patches: Array<{id:string, origem:string, patch:object}>,
 *            semResidual: Array<{id:string, origem:string}>}}
 */
export function patchesResiduais(rows) {
  const patches = [];
  const semResidual = [];
  for (const row of pendentesDeJulgamento(rows)) {
    const conta = posicaoResidual(row.grupo, row.subCategoria);
    if (!conta) {
      // Sem grupo/sub não há bloco, logo não há residual. E inventar um destino
      // aqui seria escolher o LADO do balanço no lugar do analista - isso pode
      // furar a identidade, que é o único erro que este projeto não admite.
      semResidual.push({ id: row.id, origem: row.origem });
      continue;
    }
    patches.push({
      id: row.id,
      origem: row.origem,
      patch: {
        destino: conta.destino,
        grupo: conta.grupo,
        subCategoria: conta.subCategoria,
        tipoMapeamento: 'Residual',
        confiancaMapeamento: 0.3,
        justificativa: `Sem posição nomeada compatível em ${conta.grupo}/`
          + `${conta.subCategoria} - residual do bloco. CONFIRME.`,
      },
    });
  }
  return { patches, semResidual };
}
