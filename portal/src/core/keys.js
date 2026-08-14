// Chaves estruturais.
//
// A chave mínima obrigatória de uma alocação é `Destino | Grupo | Sub Categoria`.
// Existem DUAS formas dela, e confundi-las foi a causa raiz nº 1 do balanço não
// fechar no v1:
//
//   aggKey - NORMALIZADA. É a única usada para agregar/comparar/indexar.
//   displayKey - texto original apenas com trim. Só para exibir e exportar,
//                porque as colunas "Chave"/"Chave Destino" da Rastreabilidade
//                precisam sair no Excel com a grafia do documento.
//
// No v1 havia só a versão com `trim()`, e ela era usada para AGREGAR:
//
//     const key = structuralKey(destino, grupo, sub);   // só trim
//     const a = agg.get(key);                           // Map.get() exato
//
// Como `findAccount`, `matchEntry` e a ordenação todos normalizavam, qualquer
// divergência de caixa, acento ou pontuação entre o dicionário e o template
// fazia `Map.get()` devolver `undefined`, o valor virar 0 e o dinheiro
// desaparecer da Shadow - sem erro no QA, porque o QA achava a conta pela
// versão normalizada. 229 das 1.285 entradas do dicionário caíam nisso.
//
// Em Excel, `SUMIFS` é case-insensitive; era por isso que a planilha original
// fechava e o port em JS não. `aggKey` restaura essa semântica.

import { normalizeText } from './normalize.js';

/** Separador improvável de aparecer em nome de conta. */
const SEP = '|';

/**
 * Chave de AGREGAÇÃO (normalizada). Use esta em todo Map/Set/comparação.
 * @returns {string} ex.: `caixa|ativo|circulante`
 */
export function aggKey(destino, grupo, subCategoria) {
  return [
    normalizeText(destino),
    normalizeText(grupo),
    normalizeText(subCategoria),
  ].join(SEP);
}

/**
 * Chave de EXIBIÇÃO (grafia original, só trim). Nunca use para comparar.
 * @returns {string} ex.: `Caixa|Ativo|Circulante`
 */
export function displayKey(destino, grupo, subCategoria) {
  return [
    String(destino ?? '').trim(),
    String(grupo ?? '').trim(),
    String(subCategoria ?? '').trim(),
  ].join(SEP);
}

/** aggKey da ORIGEM de uma linha (identidade da conta no documento). */
export function aggKeyOrigem(row) {
  return aggKey(row.origem, row.grupo, row.subCategoria);
}

/**
 * Chave da origem para EXIBIÇÃO - só existe quando a linha está alocada.
 * (Regra do template: linhas de contexto saem com Chave vazia.)
 */
export function chaveOrigem(row) {
  if (row.alocacaoHierarquia !== 'Sim') return '';
  return displayKey(row.origem, row.grupo, row.subCategoria);
}

/** Chave do destino para EXIBIÇÃO - idem. */
export function chaveDestino(row) {
  if (row.alocacaoHierarquia !== 'Sim') return '';
  return displayKey(row.destino, row.grupo, row.subCategoria);
}

/** Desmonta uma aggKey de volta em partes (para mensagens de erro). */
export function partesDaChave(chave) {
  const [destino = '', grupo = '', subCategoria = ''] = String(chave).split(SEP);
  return { destino, grupo, subCategoria };
}
