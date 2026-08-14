// Hierarquia: quem é conta analítica (folha) e quem é totalizador (sintética).
//
// Isto decide o que ENTRA na soma. Errar aqui não produz um desvio pequeno:
// produz um múltiplo do balanço inteiro.
//
// ---------------------------------------------------------------------------
// DUAS FONTES DE HIERARQUIA, em ordem de confiabilidade
// ---------------------------------------------------------------------------
// 1. CÓDIGO CONTÁBIL (balancete de ERP) - estrutural, verificável, sem LLM.
//    Uma conta é totalizadora se existe OUTRA conta cujo código a tem como
//    prefixo estrito. É a regra mais geral, e a única que funciona nos três
//    layouts que encontramos:
//
//      a) com pontos      1.1.01.001
//      b) sem pontos      11010100000071    <- Protheus, o caso real
//      c) níveis ausentes existe 110101 e 11010100000071, mas NÃO 11010100
//
//    O caso (c) elimina duas alternativas tentadoras:
//      · "pai = código truncado no nível anterior" -> 116 falsos órfãos
//      · "folha = comprimento máximo" -> funciona por acaso neste arquivo
//        (14 dígitos), quebra em qualquer plano com profundidade irregular
//
// 2. CAMPO `hierarquia` (BP/DRE publicado) - o nome do pai imediato, vindo da
//    indentação. Usado quando não há código.
//
// Em ambos os casos a hierarquia é CONFERIDA ARITMETICAMENTE
// (`verificarSinteticas` em invariants.js): o valor de cada sintética tem de
// bater com a soma das suas folhas. No balancete SPE (exemplo) isso são 670
// assertivas (134 sintéticas x 5 colunas) e todas passam - o que prova que a
// hierarquia reconstruída está certa, sem depender de julgamento.

import { normalizeText } from './normalize.js';

const SUFIXO_TOTALIZADOR = ' - Totalizador';

/** Remove o sufixo de legado ` - Totalizador` (idempotente). */
export function stripTotalizadorSuffix(nome) {
  const s = String(nome ?? '');
  return s.endsWith(SUFIXO_TOTALIZADOR) ? s.slice(0, -SUFIXO_TOTALIZADOR.length) : s;
}

/** `sim|s|yes|true|1` -> `'Sim'`; qualquer outra coisa -> `'Não'`. */
export function normalizeAlocacao(valor) {
  return ['sim', 's', 'yes', 'true', '1'].includes(normalizeText(valor)) ? 'Sim' : 'Não';
}

/** Código contábil só com dígitos (descarta pontos, barras, espaços). */
export function codigoDigitos(codigo) {
  return String(codigo ?? '').replace(/\D/g, '');
}

/**
 * Reconstrói a hierarquia a partir dos CÓDIGOS contábeis.
 *
 * @param {Array<{id?:any, codigo?:string, origem?:string}>} rows
 * @returns {{
 *   porId: Map<string, {codigo:string, folha:boolean, paiCodigo:string|null,
 *                       nivel:number, filhos:string[]}>,
 *   folhas: Set<string>, sinteticas: Set<string>,
 *   temCodigos: boolean, duplicados: string[]
 * }}  chaveado por código normalizado (só dígitos)
 */
export function hierarquiaPorCodigo(rows) {
  const porCodigo = new Map();
  const duplicados = [];

  for (const r of rows || []) {
    const c = codigoDigitos(r.codigo);
    if (!c) continue;
    if (porCodigo.has(c)) { duplicados.push(c); continue; }
    porCodigo.set(c, { codigo: c, row: r, folha: true, paiCodigo: null, nivel: 0, filhos: [] });
  }

  const temCodigos = porCodigo.size >= 2;
  if (!temCodigos) {
    return {
      porCodigo, folhas: new Set(), sinteticas: new Set(),
      temCodigos: false, duplicados,
    };
  }

  // Ordenar por comprimento permite achar o pai olhando só os prefixos mais
  // curtos já vistos. O pai é o MAIOR prefixo estrito presente no conjunto.
  const codigos = [...porCodigo.keys()].sort((a, b) => a.length - b.length || a.localeCompare(b));
  for (const c of codigos) {
    let pai = null;
    for (let len = c.length - 1; len >= 1; len -= 1) {
      const cand = c.slice(0, len);
      if (porCodigo.has(cand)) { pai = cand; break; }
    }
    const no = porCodigo.get(c);
    no.paiCodigo = pai;
    if (pai) {
      const noPai = porCodigo.get(pai);
      noPai.folha = false;          // tem descendente => é sintética
      noPai.filhos.push(c);
      no.nivel = noPai.nivel + 1;
    }
  }

  const folhas = new Set();
  const sinteticas = new Set();
  for (const [c, no] of porCodigo) (no.folha ? folhas : sinteticas).add(c);

  return { porCodigo, folhas, sinteticas, temCodigos: true, duplicados };
}

/**
 * Conjunto de origens (normalizadas) que aparecem como `hierarquia` de outra
 * linha - isto é, que são pai de alguém. Usado quando não há código.
 */
export function totalizadorOrigens(rows) {
  const origens = new Set((rows || []).map((r) => normalizeText(r.origem)));
  const pais = new Set();
  for (const r of rows || []) {
    const h = normalizeText(stripTotalizadorSuffix(r.hierarquia));
    if (!h) continue;
    if (h !== normalizeText(r.origem) && origens.has(h)) pais.add(h);
  }
  return pais;
}

/**
 * Decide folha/sintética para TODAS as linhas, usando código quando houver e
 * o campo `hierarquia` como alternativa. Anota cada linha in-place com:
 *
 *   `_folha`       boolean - é conta analítica?
 *   `_nivel`       number - profundidade (0 = raiz)
 *   `_paiCodigo`   string|null
 *   `_paiNome`     string - nome do pai imediato (para exibir e para o LLM)
 *   `_cadeiaPais`  string[] - do mais próximo ao mais distante; é o contexto
 *                             que restringe o julgamento do LLM
 *   `totalizador`  'Sim'|'Não'
 *
 * @returns {{fonte:'codigo'|'hierarquia'|'nenhuma', folhas:number,
 *            sinteticas:number, duplicados:string[]}}
 */
export function anotarHierarquia(rows) {
  const lista = rows || [];
  // SUBTOTAL DECLARADO PELA LEITURA vence o prefixo de código.
  //
  // Na DRE da padronizada da CVM os subtotais são IRMÃOS, não pais:
  //
  //     3.01  Receita de Venda de Bens e/ou Serviços
  //     3.02  Custo dos Bens e/ou Serviços Vendidos
  //     3.03  Resultado Bruto        <- é 3.01 + 3.02, e NADA se aninha embaixo
  //
  // Por prefixo, `3.03` não tem filhos, logo parece folha - e alocá-la somaria o
  // subtotal junto com as suas parcelas. O servidor já sabe a verdade: a árvore
  // ARITMÉTICA identificou `Resultado Bruto` como sintética (é a soma exata de um
  // bloco contíguo) e mandou `totalizador: 'Sim'` na linha. Essa informação estava
  // sendo descartada aqui.
  //
  // A precedência é deliberada: aritmética confirmada é evidência mais forte que
  // ausência de código aninhado. O contrário - código com filhos e leitura dizendo
  // folha - não acontece, porque a árvore por soma nunca chama de folha algo que
  // fecha um bloco.
  // Indexado por POSIÇÃO, não por `id`: `anotarHierarquia` é chamada direto nos
  // testes e no golden com linhas que ainda não têm `id`, e um `Set` de `id`
  // viraria `Set{undefined}`, cujo `has(undefined)` é verdadeiro para TODA linha,
  // marcando as 66 como sintéticas. A suíte pegou.
  const declaradoSubtotal = lista.map((r) => r.totalizador === 'Sim');
  const h = hierarquiaPorCodigo(lista);

  if (h.temCodigos) {
    const nomePor = new Map([...h.porCodigo].map(([c, no]) => [c, String(no.row.origem ?? '')]));
    for (let i = 0; i < lista.length; i += 1) {
      const r = lista[i];
      const c = codigoDigitos(r.codigo);
      const no = c ? h.porCodigo.get(c) : null;
      if (!no) {
        // linha sem código num documento que tem códigos: trata como folha,
        // mas registra para o QA avisar (pode ser cabeçalho perdido)
        r._folha = true; r._nivel = 0; r._paiCodigo = null;
        r._paiNome = ''; r._cadeiaPais = []; r._semCodigo = true;
        r.totalizador = 'Não';
        continue;
      }
      const cadeia = [];
      let p = no.paiCodigo;
      while (p) {
        cadeia.push(nomePor.get(p) || p);
        p = h.porCodigo.get(p)?.paiCodigo ?? null;
      }
      const sintetica = !no.folha || declaradoSubtotal[i];
      r._folha = !sintetica;
      r._nivel = no.nivel;
      r._paiCodigo = no.paiCodigo;
      r._paiNome = cadeia[0] || '';
      r._cadeiaPais = cadeia;
      r._semCodigo = false;
      r._subtotalPorAritmetica = no.folha && sintetica;
      r.totalizador = sintetica ? 'Sim' : 'Não';
    }
    // Recontagem: `h.folhas`/`h.sinteticas` vêm do prefixo, e o subtotal
    // declarado pela aritmética muda a classificação de algumas linhas.
    return {
      fonte: 'codigo',
      folhas: lista.filter((r) => r._folha).length,
      sinteticas: lista.filter((r) => !r._folha).length,
      duplicados: h.duplicados,
      subtotaisPorAritmetica: lista.filter((r) => r._subtotalPorAritmetica).length,
    };
  }

  const pais = totalizadorOrigens(lista);
  if (pais.size) {
    const porNome = new Map(lista.map((r) => [normalizeText(r.origem), r]));
    for (const r of lista) {
      const ehPai = pais.has(normalizeText(r.origem));
      const cadeia = [];
      let atual = normalizeText(stripTotalizadorSuffix(r.hierarquia));
      const visto = new Set([normalizeText(r.origem)]);
      while (atual && porNome.has(atual) && !visto.has(atual)) {
        visto.add(atual);
        const pai = porNome.get(atual);
        cadeia.push(String(pai.origem ?? ''));
        atual = normalizeText(stripTotalizadorSuffix(pai.hierarquia));
      }
      r._folha = !ehPai;
      r._nivel = cadeia.length;
      r._paiCodigo = null;
      r._paiNome = cadeia[0] || '';
      r._cadeiaPais = cadeia;
      r._semCodigo = true;
      r.totalizador = ehPai ? 'Sim' : 'Não';
    }
    return {
      fonte: 'hierarquia',
      folhas: lista.filter((r) => r._folha).length,
      sinteticas: pais.size, duplicados: [],
    };
  }

  // Sem código e sem hierarquia: tudo é folha. Situação do v1 para import de
  // xlsx/CSV - e a razão pela qual as 358 linhas do balancete eram somadas
  // todas juntas, inflando o Ativo de 118 MM para ~382 MM.
  for (const r of lista) {
    r._folha = true; r._nivel = 0; r._paiCodigo = null;
    r._paiNome = ''; r._cadeiaPais = []; r._semCodigo = true;
    r.totalizador = 'Não';
  }
  return { fonte: 'nenhuma', folhas: lista.length, sinteticas: 0, duplicados: [] };
}

/**
 * Nome do pai para exibir na coluna Hierarquia: a própria conta quando é
 * totalizadora, senão o pai imediato. Nunca vazio.
 */
export function hierarquiaDisplay(row) {
  const origem = String(row.origem ?? '').trim();
  if (row.totalizador === 'Sim') return origem;
  return String(row._paiNome ?? stripTotalizadorSuffix(row.hierarquia) ?? '').trim() || origem;
}
