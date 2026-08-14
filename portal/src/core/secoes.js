// SEÇÕES DA DEMONSTRAÇÃO - de onde sai a subcategoria quando não há código de ERP.
//
// Este módulo existe por causa de um CÍRCULO no pipeline, encontrado no primeiro
// ITR real (Fleury 2T26) e invisível até então:
//
//   · `subCategoria` só era preenchida pelo DESTINO que o matching escolhia
//     (`applyMapping` faz `row.subCategoria = res.conta.subCategoria`);
//   · mas `matchEntry` usa `subCategoria` para desempatar entradas homônimas do
//     dicionário - `Financiamentos` existe duas vezes, uma para `Bancos`
//     (Circulante) e uma para `Bancos LP` (Não Circulante);
//   · e `candidatosPara(grupo, sub)` usa `subCategoria` para reduzir o espaço de
//     decisão do LLM. Sem ela, `!s` faz a função devolver o GRUPO INTEIRO.
//
// Ou seja: quem mais precisava da subcategoria era exatamente quem não a tinha,
// a linha que o dicionário não conheceu. No balancete de ERP o círculo passava
// despercebido, porque o dicionário acertava quase tudo por nome exato e o
// código contábil já trazia o grupo. Na demonstração publicada ele mordeu: as 6
// linhas que sobraram chegaram ao modelo como `bloco_provavel=Passivo/?` com
// 28 candidatos em vez de 4, e a regra "na dúvida, deixe em branco" fez o resto.
// Resultado: R$ 3.314.468 sem destino e a identidade furada em 23%.
//
// A informação nunca faltou. Ela estava no NOME DAS CONTAS-PAI, em texto claro:
// `Total do patrimônio líquido`, `Total do realizável a longo prazo`,
// `Total circulante`. A demonstração publicada declara a seção; ela só não
// declara código.
//
// SEGUNDA FUNÇÃO - cabeçalho de seção absorvido pela primeira conta.
//
// Na leitura do Fleury o rótulo da seção não virou linha própria: ele foi
// grudado na primeira conta da seção pelo assembler de palavras. A linha crua do
// `/read` é literalmente
//
//     'Circulante Caixa e equivalentes de caixa'   valores: 3181 5080 19060 21772
//
// e não existe nenhuma linha isolada chamada `Circulante` nas 66. Quatro contas
// nasceram com o nome contaminado, e duas delas o dicionário JÁ CONHECERIA pelo
// nome limpo (`Capital social` → `Capital Social`/PL, linha 1225 do dicionário;
// `Financiamentos` → `Bancos LP`/Não Circulante, linha 1094).
//
// Por que separar aqui, e não subir a tolerância de linha no leitor: mexer na
// junção de palavras afeta TODO documento e a evidência disponível é de um só
// PDF. A separação por vocabulário contábil é local, reversível e verificável,
// e o pedaço removido não é jogado fora, ele vira `_secaoDeclarada`, que é
// justamente o dado que faltava.
//
// `origem` NUNCA é alterada. Ela é o que o documento diz, e o guardrail
// `origem existe no documento` depende disso. O nome limpo vive em
// `_contaLimpa`, e é ele que o matching consulta.

import { normalizeText } from './normalize.js';

/**
 * Seções reconhecidas, do mais específico para o mais genérico. A ORDEM IMPORTA:
 * `Total não circulante` contém a palavra `circulante`, então "não circulante"
 * tem de ser testado antes.
 *
 * `padrao` casa contra o texto JÁ normalizado (sem acento, minúsculo).
 * `veto` impede a leitura quando presente - é o que salva a raiz
 * `Total do passivo e patrimônio líquido`, que contém "patrimônio líquido" mas é
 * o total do lado inteiro, não a seção de PL. Sem esse veto, todo Passivo
 * Circulante do documento seria classificado como PL.
 */
const SECOES = [
  { sub: 'PL', padrao: /\bpatrimonio liquido\b/, veto: /\bpassivo\b/ },
  { sub: 'Não Circulante', padrao: /\bnao circulante\b|\blongo prazo\b/, veto: null },
  { sub: 'Circulante', padrao: /\bcirculante\b/, veto: null },
];

/**
 * Cabeçalhos que aparecem GRUDADOS na primeira conta da seção. São prefixos
 * exatos do rótulo normalizado - nunca casam no meio do nome.
 *
 * `ativo` e `passivo` entram porque o mesmo defeito atinge o título do lado
 * ("Ativo Nota 30/06/2026 ..." é uma linha real deste documento). Ficam por
 * último para que `Ativo circulante` seja lido como a seção Circulante, e não
 * como o título `Ativo`.
 */
const CABECALHOS = [
  'patrimonio liquido',
  'ativo nao circulante',
  'passivo nao circulante',
  'ativo circulante',
  'passivo circulante',
  'nao circulante',
  'circulante',
  'ativo',
  'passivo',
];

/**
 * Subcategoria declarada por um nome de seção, ou `''`.
 * @param {string} nome rótulo cru (a normalização é feita aqui)
 * @returns {''|'Circulante'|'Não Circulante'|'PL'}
 */
export function secaoDeNome(nome) {
  const n = normalizeText(nome);
  if (!n) return '';
  for (const s of SECOES) {
    if (!s.padrao.test(n)) continue;
    if (s.veto && s.veto.test(n)) continue;
    return s.sub;
  }
  return '';
}

/**
 * Separa um cabeçalho de seção absorvido no início do rótulo.
 *
 * Só separa quando SOBRA nome de conta: `'Circulante'` sozinho continua sendo
 * uma linha de seção (e o servidor já a descarta por não ter valor). Devolver
 * `conta: ''` faria a linha perder identidade.
 *
 * @param {string} rotulo
 * @returns {{secao: string, conta: string, separou: boolean}}
 */
export function separarSecao(rotulo) {
  const bruto = String(rotulo ?? '').trim();
  const n = normalizeText(bruto);
  if (!n) return { secao: '', conta: bruto, separou: false };

  for (const cab of CABECALHOS) {
    if (n === cab) return { secao: bruto, conta: bruto, separou: false };
    if (!n.startsWith(`${cab} `)) continue;
    // Recorta o MESMO número de palavras no rótulo original, preservando a
    // grafia e a acentuação do documento - `_contaLimpa` tem de ser comparável
    // com o dicionário, que guarda grafia real.
    const palavras = bruto.split(/\s+/);
    const quantas = cab.split(' ').length;
    const conta = palavras.slice(quantas).join(' ').trim();
    if (!conta) return { secao: bruto, conta: bruto, separou: false };
    return { secao: palavras.slice(0, quantas).join(' '), conta, separou: true };
  }
  return { secao: '', conta: bruto, separou: false };
}

/**
 * Referência de nota explicativa colada no fim do nome da conta:
 * `Capital social 24a.`, `Ações em tesouraria 24.d`.
 *
 * EXIGE o sufixo de letra. Um número solto no fim (`Banco Itaú 341`,
 * `Conta 12`) é ambíguo - pode ser parte do nome da conta num balancete de ERP,
 * e remover às cegas trocaria a chave de agregação de uma conta legítima. As
 * duas formas acima são as que de fato apareceram no ITR, e ambas têm letra.
 * Nota puramente numérica costuma vir em COLUNA própria ("Nota") na publicada,
 * não colada no rótulo.
 */
const RE_NOTA = /\s+\(?\d{1,2}\s*\.?\s*[a-z]\.?\)?$/i;

/**
 * Nome da conta sem cabeçalho de seção e sem referência de nota.
 * @param {string} rotulo
 * @returns {{conta: string, secao: string, limpou: boolean}}
 */
export function limparRotulo(rotulo) {
  const { secao, conta, separou } = separarSecao(rotulo);
  let limpa = conta;
  const semNota = limpa.replace(RE_NOTA, '').trim();
  // exige que sobre algo com letra: `24a.` isolado não é conta
  const removeuNota = semNota !== limpa && /[a-zà-ú]/i.test(semNota);
  if (removeuNota) limpa = semNota;
  return { conta: limpa, secao, limpou: separou || removeuNota };
}

/**
 * Anota `_contaLimpa`, `_secaoDeclarada` e `_subInferida` em cada linha.
 *
 * Roda DEPOIS de `anotarHierarquia` (precisa de `_cadeiaPais`) e ANTES do
 * matching (é quem consome). Não toca em `origem` nem em `subCategoria` já
 * declarada: informação vinda do documento sempre vence a inferida.
 *
 * A ordem das fontes de subcategoria é a ordem da confiança:
 *   1. o nome da própria linha, quando trouxe o cabeçalho grudado
 *      (`Patrimônio líquido Capital social` declara a seção explicitamente);
 *   2. a cadeia de pais, do pai imediato para a raiz - `Total do realizável a
 *      longo prazo` antes de `Total não circulante`, porque o pai mais próximo
 *      é o mais específico.
 *
 * @param {Array} rows
 * @returns {{limpas:number, inferidas:number}}
 */
export function anotarSecoes(rows) {
  let limpas = 0;
  let inferidas = 0;

  for (const r of rows || []) {
    const { conta, secao, limpou } = limparRotulo(r.origem);
    r._secaoDeclarada = secao;
    // `_contaLimpa` só existe quando difere: assim `matchEntry` cai no `origem`
    // sem precisar saber deste módulo, e a grade continua exibindo o original.
    r._contaLimpa = limpou && conta !== r.origem ? conta : '';
    if (r._contaLimpa) limpas += 1;

    r._subInferida = '';
    if (r.subCategoria) continue;
    if (r.grupo !== 'Ativo' && r.grupo !== 'Passivo') continue;
    for (const nome of [secao, ...(r._cadeiaPais || [])]) {
      const s = secaoDeNome(nome);
      if (s) { r._subInferida = s; break; }
    }
    if (r._subInferida) inferidas += 1;
  }
  return { limpas, inferidas };
}
