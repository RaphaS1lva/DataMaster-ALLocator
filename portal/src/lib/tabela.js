// Leitura determinística de tabela colada / CSV, no navegador.
//
// POR QUE ISTO NÃO PASSA PELA API
// A camada 0 de segurança do servidor identifica o tipo por MAGIC BYTES e aceita
// PDF, PNG, JPG, WEBP e XLSX. CSV não tem assinatura e seria recusado - com
// razão, porque confiar na extensão do nome é o buraco que a v1 tinha. E como
// CSV e texto colado JÁ SÃO tabela, parseá-los aqui é determinístico,
// instantâneo, funciona offline e não gasta rede. O caminho da API existe para o
// que exige extração de verdade: PDF, imagem e planilha binária.
//
// POR QUE EM `lib/` E NÃO DENTRO DA PÁGINA
// É transformação de dado, não interface: entra texto, sai linha de pipeline. Num
// arquivo `.jsx` seria intestável em `node:test` (o Node não parseia JSX), e um
// parser de documento contábil sem teste é exatamente o código que silenciosamente
// desloca uma coluna e produz um balanço errado.
//
// A DETECÇÃO É ESTRUTURAL, NUNCA POR NOME DE CABEÇALHO
// Nenhum ERP usa os mesmos rótulos, e um parser que depende deles quebra no
// segundo cliente. Aqui o papel de cada coluna vem do CONTEÚDO dela: descrição
// tem letras, natureza é literalmente `D` ou `C`, código é dígito com pontuação,
// valor é o que parseia como número.

import { parseNumber } from '../core/normalize.js';

/**
 * Delimitador provável.
 *
 * Tabulação primeiro (é o que o Excel põe no clipboard), depois ponto-e-vírgula
 * (CSV brasileiro), e vírgula só em último caso - em número pt-BR a vírgula é
 * separador DECIMAL, então usá-la como delimitador parte `1.234,56` em duas
 * células e desloca a linha inteira para a direita.
 *
 * @param {string} texto
 * @returns {'\t'|';'|','}
 */
export function detectarDelimitador(texto) {
  const linhas = String(texto ?? '').trim().split(/\r?\n/).slice(0, 30);
  const contar = (d) => linhas.reduce((s, l) => s + (l.split(d).length - 1), 0);
  if (contar('\t') > 0) return '\t';
  if (contar(';') > 0) return ';';
  return contar(',') > 0 ? ',' : '\t';
}

/** Rótulo de PERÍODO: data, ano, ou vocabulário de coluna de balancete. */
const PARECE_PERIODO = /(\b\d{1,2}\/\d{1,2}\/\d{4}\b)|(\b\d{4}-\d{1,2}-\d{1,2}\b)|(\b\d{1,2}\/\d{4}\b)|(\b(?:19|20)\d{2}\b)|saldo|movimento|anterior|atual|per[íi]odo|exerc[íi]cio/i;
/** Só dígitos e pontuação de código: `1.1.01`, `11010100000071`, `1-01/02`. */
const PARECE_CODIGO = /^\d[\d.\-/]*$/;
const RE_LETRA = /[a-zA-ZÀ-ÿ]/g;

const celulaDe = (linha, i) => (linha?.[i] ?? '');

/**
 * @typedef {object} PerfilColuna
 * @property {number} i índice da coluna
 * @property {number} preenchidas células não vazias
 * @property {number} comPalavra células com 3+ letras (ou seja: nome de conta)
 * @property {number} compMedio comprimento médio das células
 * @property {number} fracaoNumerica fração que parseia como número
 * @property {number} fracaoCodigo fração que casa com padrão de código
 * @property {number} fracaoDc fração que é literalmente `D` ou `C`
 */

/**
 * Perfila cada coluna a partir das linhas dadas.
 * @param {string[][]} linhas
 * @param {number} nCols
 * @returns {PerfilColuna[]}
 */
function perfilar(linhas, nCols) {
  const perfil = [];
  for (let i = 0; i < nCols; i += 1) {
    let numericas = 0;
    let codigos = 0;
    let dc = 0;
    let comTexto = 0;
    let comPalavra = 0;
    let comprimento = 0;
    for (const l of linhas) {
      const c = celulaDe(l, i);
      if (!c) continue;
      comTexto += 1;
      comprimento += c.length;
      const p = parseNumber(c);
      if (p.ok && p.value !== null) numericas += 1;
      if (PARECE_CODIGO.test(c)) codigos += 1;
      if (/^[dc]$/i.test(c)) dc += 1;
      // 3+ letras = NOME de conta. O piso de 3 é o que separa "CAIXA GERAL" do
      // "D" da coluna de natureza, que também é letra.
      if ((c.match(RE_LETRA) || []).length >= 3) comPalavra += 1;
    }
    perfil.push({
      i,
      preenchidas: comTexto,
      comPalavra,
      compMedio: comTexto ? comprimento / comTexto : 0,
      fracaoNumerica: comTexto ? numericas / comTexto : 0,
      fracaoCodigo: comTexto ? codigos / comTexto : 0,
      fracaoDc: comTexto ? dc / comTexto : 0,
    });
  }
  return perfil;
}

/**
 * Atribui um papel a cada coluna.
 *
 * A ORDEM IMPORTA, e resolve uma ambiguidade real: `1000` casa tanto com "código
 * contábil" quanto com "valor". Decidimos primeiro o que é inequívoco (descrição
 * tem LETRAS; natureza é literalmente `D`/`C`), depois o código (o mais à
 * esquerda que só tem dígitos e pontuação), e só o que sobra pode ser valor. Sem
 * essa ordem, uma coluna de saldos inteiros seria tomada por código e o documento
 * chegaria SEM VALOR NENHUM - que é o pior modo de falhar, porque a tela parece
 * ter funcionado.
 *
 * @param {PerfilColuna[]} perfil
 */
function atribuirPapeis(perfil) {
  const colDescricao = perfil
    .filter((p) => p.comPalavra > 0)
    .sort((a, b) => b.comPalavra - a.comPalavra || a.i - b.i)[0]?.i ?? 0;

  const colNatureza = perfil.find((p) => p.i !== colDescricao
    && p.preenchidas > 0 && p.fracaoDc >= 0.8)?.i ?? -1;

  const colCodigo = perfil.find((p) => p.i !== colDescricao && p.i !== colNatureza
    && p.preenchidas > 0 && p.fracaoCodigo >= 0.8
    // À esquerda da descrição é o layout de todo balancete de ERP. À direita só
    // aceitamos se for longo (os 14 dígitos do Protheus), nunca um saldo inteiro.
    && (p.i < colDescricao || p.compMedio >= 6))?.i ?? -1;

  const colsValor = perfil
    .filter((p) => p.i !== colDescricao && p.i !== colNatureza && p.i !== colCodigo
      && p.preenchidas > 0 && p.fracaoNumerica >= 0.6)
    .map((p) => p.i);

  return { colDescricao, colNatureza, colCodigo, colsValor };
}

/**
 * A primeira linha é CABEÇALHO?
 *
 * A pergunta certa não é "a linha tem números?" - um cabeçalho `Descrição | 2024
 * | 2025` é numérico em duas de três colunas. A pergunta é: **nas colunas que as
 * outras linhas usam como VALOR, o que está na primeira linha parece um RÓTULO DE
 * PERÍODO em vez de dinheiro?**
 *
 * Testar contra `PARECE_PERIODO` sozinho não bastaria: `2000` num saldo inteiro
 * casa com "ano 2000" e faria a primeira linha de dados ser comida como
 * cabeçalho - perdendo uma conta do balanço em silêncio. Exigir que TODAS as
 * colunas de valor sejam rótulo elimina esse caso, porque um documento com
 * valores em várias colunas não teria todas elas parecendo ano.
 *
 * @param {string[]} primeira
 * @param {number[]} colsValor colunas de valor deduzidas das linhas SEGUINTES
 */
function detectarCabecalho(primeira, colsValor) {
  if (!colsValor.length) return false;
  const celulas = colsValor.map((i) => celulaDe(primeira, i)).filter((c) => c !== '');
  if (!celulas.length) return false;
  return celulas.every((c) => PARECE_PERIODO.test(c));
}

/**
 * @typedef {object} LinhaLida formato de entrada de `runPipeline`
 * @property {string} origem nome da conta como está no documento
 * @property {string} codigo código contábil, ou `''`
 * @property {Record<string,string>} valoresPorSlot valor CRU por rótulo de período
 * @property {Record<string,string>} naturezaPorSlot `'D'|'C'|''` por período
 * @property {string} natureza natureza da linha, quando declarada numa coluna única
 */

/**
 * Converte texto tabular em linhas de entrada do pipeline.
 *
 * DUAS PASSADAS DE PERFIL, e a razão é concreta: incluir o cabeçalho no perfil
 * dilui as frações. Numa tabela de UMA linha de dados mais cabeçalho, a coluna de
 * saldo teria 50% de células numéricas e não passaria do piso de 60% - o parser
 * concluiria "não achei coluna de valor" numa tabela perfeitamente legível.
 * Então: perfilamos assumindo que HÁ cabeçalho (`slice(1)`), verificamos a
 * hipótese, e se ela cair reperfilamos sobre tudo.
 *
 * NÃO atribui `id`: quem monta a análise é que decide a identidade das linhas.
 * Manter esta função sem estado global é o que a torna reprodutível no teste.
 *
 * @param {string} texto
 * @returns {{linhas: LinhaLida[], periodos: string[], avisos: string[]}}
 */
export function tabelaParaLinhas(texto) {
  const avisos = [];
  const cru = String(texto ?? '');
  const delim = detectarDelimitador(cru);
  if (delim === ',') {
    avisos.push('Delimitador detectado: vírgula. Se os valores usam vírgula decimal '
      + '(1.234,56), confira se as colunas não ficaram deslocadas - prefira colar direto '
      + 'do Excel (tabulação) ou salvar o CSV com ponto-e-vírgula.');
  }

  const bruto = cru
    .replace(/^\uFEFF/, '') // BOM que o Excel escreve no começo do CSV
    .trim()
    .split(/\r?\n/)
    .map((l) => l.split(delim).map((c) => c.replace(/^"|"$/g, '').trim()))
    .filter((cs) => cs.some((c) => c !== ''));

  if (!bruto.length) {
    return { linhas: [], periodos: [], avisos: [...avisos, 'Nada para interpretar.'] };
  }

  const nCols = Math.max(...bruto.map((c) => c.length));
  const primeira = bruto[0];

  // Passada 1: hipótese "existe cabeçalho".
  const perfilSemPrimeira = perfilar(bruto.slice(1), nCols);
  const temCabecalho = detectarCabecalho(primeira, atribuirPapeis(perfilSemPrimeira).colsValor);

  // Passada 2: perfil definitivo sobre as linhas de DADOS.
  const dados = temCabecalho ? bruto.slice(1) : bruto;
  if (!dados.length) {
    return { linhas: [], periodos: [], avisos: [...avisos, 'Só encontrei o cabeçalho.'] };
  }
  const perfil = temCabecalho ? perfilSemPrimeira : perfilar(dados, nCols);
  const { colDescricao, colNatureza, colCodigo, colsValor } = atribuirPapeis(perfil);

  if (!colsValor.length) {
    return {
      linhas: [],
      periodos: [],
      avisos: [...avisos, 'Não encontrei nenhuma coluna de valor. Esperado: uma coluna de '
        + 'descrição e ao menos uma coluna de saldo numérico.'],
    };
  }

  const periodos = colsValor.map((i) => {
    const rotulo = temCabecalho ? celulaDe(primeira, i) : '';
    return rotulo || `Coluna ${i + 1}`;
  });

  const linhas = dados.map((l) => {
    const valoresPorSlot = {};
    const naturezaPorSlot = {};
    colsValor.forEach((i, k) => {
      const v = celulaDe(l, i);
      // Célula vazia NÃO entra como zero: no núcleo, ausência e zero são
      // diferentes, e tratar traço como zero foi um erro concreto da v1.
      if (v !== '') valoresPorSlot[periodos[k]] = v;
      if (colNatureza >= 0) naturezaPorSlot[periodos[k]] = celulaDe(l, colNatureza);
    });
    return {
      origem: celulaDe(l, colDescricao),
      codigo: colCodigo >= 0 ? celulaDe(l, colCodigo) : '',
      valoresPorSlot,
      naturezaPorSlot,
      natureza: colNatureza >= 0 ? celulaDe(l, colNatureza) : '',
    };
  }).filter((r) => r.origem || Object.keys(r.valoresPorSlot).length);

  if (colCodigo < 0) {
    avisos.push('Nenhuma coluna de código contábil identificada. Sem código, a hierarquia '
      + 'depende do campo Hierarquia - e sem nenhum dos dois TODA linha é tratada como '
      + 'analítica, o que soma os totalizadores junto com as aberturas e multiplica o '
      + 'balanço. Confira as marcações de "aloca / contexto" na grade.');
  }
  if (colNatureza >= 0) {
    avisos.push('Coluna de natureza D/C detectada: marque "saldos absolutos" na conferência '
      + 'se os valores vêm todos positivos (típico de balancete de ERP).');
  }
  return { linhas, periodos, avisos };
}
