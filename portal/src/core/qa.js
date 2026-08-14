// QA: valida a alocação e decide se a entrega é liberada.
//
// ---------------------------------------------------------------------------
// CLASSE A vs CLASSE B - a distinção central do v2
// ---------------------------------------------------------------------------
// CLASSE A - BLOQUEANTE, verificada por código. São as três (e só as três)
// condições que podem furar `Ativo = Passivo + PL`, mais a leitura:
//     · destino inexistente        (chave órfã, valor evapora)
//     · destino é subtotal         (sem bucket, valor evapora)
//     · lado do balanço trocado    (Ativo <-> Passivo, BP <-> DRE)
//     · sintética que não bate com a soma das folhas  (erro de LEITURA)
//     · conservação de valor violada
//     · identidade não fecha (nem a simples nem a estendida)
//   Não é opinião: é álgebra. Se qualquer uma falha, a entrega é barrada.
//
// CLASSE B - REVISÁVEL por humano. Afeta KPI, composição e leitura do analista,
// mas NUNCA o fechamento:
//     · qual conta exatamente dentro do bloco correto
//     · Circulante vs Não Circulante (ambos entram na linha 72)
//     · sinal §14.1, irmãos divergentes, divergência do dicionário
//   Sinalizada, justificada e destacada - nunca bloqueia.
//
// Por que isso importa: é o que permite que o LLM faça o julgamento sem que um
// erro dele possa produzir um balanço errado. Um modelo local de 7B errando a
// conta específica gera um aviso de Classe B; ele não consegue gerar Classe A,
// porque o guardrail rejeita antes.

import { normalizeText } from './normalize.js';
import {
  signIsValid, signKind, explicarSinalIncompativel,
  pareceRetificadora, parseNatureza, NATUREZA,
} from './sign.js';
import { resolveDestinoAlocavel, DESTINOS_ATENCAO, ladoDoBalanco } from './planoContas.js';
import { matchEntry, DECISAO } from './matching.js';
import { ANOS } from './invariants.js';

export const CLASSE = { A: 'A', B: 'B' };

const issue = (classe, level, code, msg, extra = {}) => ({ classe, level, code, msg, ...extra });
const isSim = (r) => r.alocacaoHierarquia === 'Sim';
const temValor = (r) => ANOS.some((a) => Number(r[a]) && Number.isFinite(Number(r[a])));

const fmt = (n) => new Intl.NumberFormat('pt-BR',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n) || 0);

// ---------------------------------------------------------------------------
// CLASSE A
// ---------------------------------------------------------------------------
/** Destino inexistente, subtotal, ou lado trocado - as três que furam o balanço. */
function validarDestinos(rows) {
  const out = [];
  for (const r of (rows || []).filter(isSim)) {
    const nome = String(r.destino ?? '').trim();
    if (!nome) {
      if (temValor(r)) {
        out.push(issue(CLASSE.A, 'error', 'sem-destino',
          `"${r.origem}" está marcada para alocar e tem valor, mas não tem destino.`,
          { id: r.id }));
      }
      continue;
    }
    const res = resolveDestinoAlocavel(nome, r.grupo, r.subCategoria);
    if (!res.ok) {
      const code = /subtotal/i.test(res.erro || '') ? 'destino-subtotal' : 'destino-invalido';
      out.push(issue(CLASSE.A, 'error', code, `"${r.origem}": ${res.erro}`, { id: r.id }));
      continue;
    }
    // Compara contra o lado DECLARADO no documento (derivado do código
    // contábil quando existe), não contra `r.grupo` - que as camadas de
    // matching podem ter sobrescrito com o grupo do destino, "legitimando" a
    // troca de lado e tornando o erro invisível.
    const ladoLinha = r._ladoDeclarado || ladoDoBalanco(r.grupo, r.subCategoria);
    const ladoDestino = ladoDoBalanco(res.conta.grupo, res.conta.subCategoria);
    if (ladoLinha && ladoDestino && ladoLinha !== ladoDestino) {
      const NOME = { ativo: 'Ativo', passivoPl: 'Passivo+PL', dre: 'DRE' };
      out.push(issue(CLASSE.A, 'error', 'lado-trocado',
        `"${r.origem}"${r.codigo ? ` (código ${r.codigo})` : ''} é `
        + `${NOME[ladoLinha] || ladoLinha} mas o destino "${res.conta.destino}" é `
        + `${NOME[ladoDestino] || ladoDestino} - isso quebra o fechamento em 2x o valor.`,
        { id: r.id }));
    }
  }
  return out;
}

/** Dupla contagem: totalizador e suas aberturas marcados "Sim" ao mesmo tempo. */
function validarDuplaContagem(rows) {
  const out = [];
  const filhosSim = new Map();
  for (const r of (rows || []).filter(isSim)) {
    const pai = normalizeText(r._paiNome || r.hierarquia);
    if (pai && pai !== normalizeText(r.origem)) {
      filhosSim.set(pai, (filhosSim.get(pai) || 0) + 1);
    }
  }
  for (const r of (rows || []).filter(isSim)) {
    if (r.totalizador !== 'Sim') continue;
    const n = filhosSim.get(normalizeText(r.origem));
    if (n) {
      out.push(issue(CLASSE.A, 'error', 'dupla-contagem',
        `Dupla contagem: o totalizador "${r.origem}" e ${n} abertura(s) dele estão `
        + 'ambos marcados "Sim". Escolha um dos dois.', { id: r.id }));
    }
  }
  // CÓDIGO REPETIDO é dupla contagem de verdade: a MESMA conta aparece duas
  // vezes no documento e seu valor entraria duas vezes na soma.
  const porCodigo = new Map();
  for (const r of rows || []) {
    const c = String(r.codigo ?? '').replace(/\D/g, '');
    if (!c) continue;
    porCodigo.set(c, (porCodigo.get(c) || 0) + 1);
  }
  for (const [c, n] of porCodigo) {
    if (n > 1) {
      out.push(issue(CLASSE.A, 'error', 'codigo-duplicado',
        `O código contábil ${c} aparece ${n} vezes - o valor entraria ${n} vezes `
        + 'na soma. Remova as linhas repetidas.'));
    }
  }
  return out;
}

/**
 * CLASSE B - mesma ORIGEM (nome) indo para destinos diferentes.
 *
 * O v1 tratava isso como dupla contagem bloqueante, e está errado: duas contas
 * com o mesmo NOME e códigos DIFERENTES são valores distintos, e alocá-las em
 * posições diferentes do mesmo bloco não altera nenhum total. Acontece de forma
 * legítima em plano de contas de ERP - no balancete real, "CLIENTES LOCACAO" e
 * "IMPOSTOS INCIDENTES SOBRE RECEITAS" aparecem em mais de um nível.
 *
 * Continua sendo sinal útil de inconsistência, então vira aviso - e a chave de
 * agrupamento inclui o código, para não acusar homônimos que são contas
 * genuinamente diferentes.
 */
function validarConsistenciaDeDestino(rows) {
  const out = [];
  const porNome = new Map();
  for (const r of (rows || []).filter(isSim)) {
    if (!r.chave) continue;
    const k = r.chave;
    if (!porNome.has(k)) porNome.set(k, new Map());
    porNome.get(k).set(r.chaveDestino, String(r.codigo ?? ''));
  }
  for (const [chave, dests] of porNome) {
    if (dests.size > 1) {
      out.push(issue(CLASSE.B, 'warn', 'destino-inconsistente',
        `"${chave.split('|')[0]}" aparece com destinos diferentes: `
        + `${[...dests.keys()].map((d) => d.split('|')[0]).join(' ; ')}. `
        + 'Não afeta o fechamento, mas confira se é intencional.'));
    }
  }
  return out;
}

/** Conservação de valor: nada pode sumir entre a folha e a posição. */
function validarConservacao(trilha) {
  const out = [];
  if (!trilha) return out;
  for (const a of ANOS) {
    if (!trilha.conservado[a]) {
      out.push(issue(CLASSE.A, 'error', 'conservacao',
        `${a.toUpperCase()}: a soma das folhas alocadas (${fmt(trilha.folhasSim[a])}) não `
        + `bate com o que chegou às posições (${fmt(trilha.alocado[a])}) mais as perdas `
        + `(${fmt(trilha.perdas[a])}). Há um vazamento não classificado.`));
      continue;
    }
    if (trilha.perdas[a] > 0.005) {
      const partes = [];
      if (trilha.orfao[a]) partes.push(`${fmt(trilha.orfao[a])} em destino inexistente`);
      if (trilha.subtotal[a]) partes.push(`${fmt(trilha.subtotal[a])} em subtotal`);
      if (trilha.semDestino[a]) partes.push(`${fmt(trilha.semDestino[a])} sem destino`);
      if (trilha.ladoTrocado[a]) partes.push(`${fmt(trilha.ladoTrocado[a])} com lado trocado`);
      out.push(issue(CLASSE.A, 'error', 'valor-perdido',
        `${a.toUpperCase()}: ${fmt(trilha.perdas[a])} não chegaram à Shadow - `
        + partes.join('; ') + '.'));
    }
  }
  return out;
}

/** Chaves órfãs, com o valor de cada uma. */
function validarOrfaos(orphans) {
  return (orphans || []).map((o) => issue(CLASSE.A, 'error', 'orfao',
    `Chave órfã "${o.destino}" (${o.grupo}/${o.subCategoria}): `
    + `${fmt(o.ano3 || o.ano2 || o.ano1)} não entram em nenhuma linha do template. `
    + `Origens: ${o.origens.slice(0, 3).join(', ')}${o.origens.length > 3 ? '…' : ''}`,
    { chave: o.chave }));
}

/** A identidade - e a distinção entre "errado", "não encerrado" e "memorando". */
function validarIdentidade(balance, trilha) {
  const out = [];
  if (!balance) return out;
  for (const a of ANOS) {
    const b = balance[a];
    if (!b || b.semDados) continue;
    if (b.fecha) continue;

    if (b.naoEncerrado) {
      // NÃO é erro do sistema nem do modelo: é a natureza do documento.
      out.push(issue(CLASSE.A, 'action', 'nao-encerrado',
        `${a.toUpperCase()}: balancete não encerrado. Ativo ${fmt(b.ativo)} − `
        + `(Passivo+PL) ${fmt(b.passivoPl)} = ${fmt(b.dif)}, que é exatamente o `
        + `resultado do período (${fmt(b.resultado)}). Transporte o resultado para `
        + 'o PL para fechar.',
        { transporte: b.transporteSugerido, ano: a }));
      continue;
    }
    // Pista concreta em vez de "investigue": se há valor em posição de
    // memorando da DRE (16/17/19), ele não alcança o resultado e é candidato
    // natural a explicar o resíduo da identidade estendida.
    const memo = trilha?.memoDre?.[a] || 0;
    const pista = Math.abs(memo) > 0.005
      ? ` Atenção: ${fmt(memo)} estão em posições da DRE fora da cadeia do `
        + 'resultado (add-back do EBITDA, ou abaixo da linha do lucro líquido: '
        + 'abrangentes, dividendos, minoritários) - provável origem do resíduo.'
      : '';
    out.push(issue(CLASSE.A, 'error', 'identidade',
      `${a.toUpperCase()}: Ativo ${fmt(b.ativo)} ≠ Passivo+PL ${fmt(b.passivoPl)} - `
      + `diferença ${fmt(b.dif)} (${(b.difRelativa * 100).toFixed(3)}% do Ativo, `
      + `tolerância ${fmt(b.tolerancia)}). A identidade estendida também não fecha `
      + `(resíduo ${fmt(b.difEstendida)}), então não é resultado não transportado.`
      + pista));
  }
  return out;
}

/** Erro de LEITURA: sintética que não bate com a soma das folhas. */
function validarLeitura(verificacao) {
  const out = [];
  if (!verificacao || verificacao.ok) return out;
  const porBloco = new Map();
  for (const d of verificacao.divergencias) {
    if (!porBloco.has(d.codigo)) porBloco.set(d.codigo, d);
  }
  for (const d of [...porBloco.values()].slice(0, 12)) {
    out.push(issue(CLASSE.A, 'error', 'leitura',
      `Bloco ${d.codigo} "${d.origem}": o documento declara ${fmt(d.declarado)} em `
      + `${d.coluna}, mas suas ${d.nFolhas} contas analíticas somam `
      + `${fmt(d.somaFolhas)} (diferença ${fmt(d.diferenca)}). Erro de LEITURA - `
      + 'confira a natureza D/C e o alinhamento de colunas deste bloco.'));
  }
  return out;
}

/** Valores que não foram sequer interpretados como número. */
function validarValoresIlegiveis(rows) {
  const out = [];
  for (const r of rows || []) {
    for (const v of r.valoresInvalidos || []) {
      out.push(issue(CLASSE.A, 'error', 'valor-ilegivel',
        `"${r.origem}" (${v.periodo}): não consegui interpretar "${v.raw}" como número. `
        + 'Corrija antes de continuar - um valor descartado quebra o fechamento.',
        { id: r.id }));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLASSE B
// ---------------------------------------------------------------------------
/**
 * CLASSE A - sinal da apresentação incompatível com o destino.
 *
 * Destinos `neg`/`pos` gravam `Math.abs()`, destruindo o sinal. Se o sinal já
 * não concordava com a direção do destino, a contribuição sai INVERTIDA e a
 * diferença vira 2x o valor. É bloqueante porque fura o fechamento.
 *
 * Roda sobre `anoNApresentacao` (§14.2), não sobre o valor gravado. No v1 a
 * checagem equivalente rodava sobre o gravado - que é sempre >= 0 depois do
 * `abs()` - e por isso nunca disparava.
 */
function validarCompatibilidadeDeSinal(rows) {
  const out = [];
  for (const r of (rows || []).filter(isSim)) {
    if (!String(r.destino ?? '').trim()) continue;
    const kind = signKind(r.destino);
    if (kind !== 'neg' && kind !== 'pos') continue;
    ANOS.forEach((a, i) => {
      const p = r[`${a}Apresentacao`];
      if (p === null || p === undefined || !Number(p)) return;
      if (!signIsValid(p, r.destino)) {
        out.push(issue(CLASSE.A, 'error', 'sinal-incompativel',
          `Ano ${i + 1} de "${r.origem}": ${explicarSinalIncompativel(p, r.destino)}`,
          { id: r.id }));
      }
    });
  }
  return out;
}

/** Nome diz retificadora mas a natureza D/C diz o contrário. */
function validarRetificadoras(rows) {
  const out = [];
  for (const r of rows || []) {
    const nat = parseNatureza(r.natureza);
    if (!nat) continue;
    const esperadaSeRetif = normalizeText(r.grupo) === 'ativo'
      ? NATUREZA.CREDITO : NATUREZA.DEBITO;
    const pareceR = pareceRetificadora(r.origem);
    const ehR = nat === esperadaSeRetif;
    if (pareceR && !ehR) {
      out.push(issue(CLASSE.B, 'warn', 'retificadora',
        `"${r.origem}" tem nome de conta retificadora mas natureza ${nat}, que é a `
        + `normal do grupo ${r.grupo}. Confiei no D/C do documento; confirme.`, { id: r.id }));
    }
  }
  return out;
}

function validarSubcategoria(rows) {
  const out = [];
  for (const r of rows || []) {
    const g = normalizeText(r.grupo); const s = normalizeText(r.subCategoria);
    if (g === 'ativo' && !['circulante', 'nao circulante'].includes(s)) {
      out.push(issue(CLASSE.B, 'warn', 'subcat',
        `Ativo com Sub Categoria inválida: "${r.origem}" (${r.subCategoria || 'vazia'})`, { id: r.id }));
    }
    if (g === 'passivo' && !['circulante', 'nao circulante', 'pl'].includes(s)) {
      out.push(issue(CLASSE.B, 'warn', 'subcat',
        `Passivo com Sub Categoria inválida: "${r.origem}" (${r.subCategoria || 'vazia'})`, { id: r.id }));
    }
    if (g === 'dre' && s !== 'dre') {
      out.push(issue(CLASSE.B, 'warn', 'subcat',
        `DRE deve ter Sub Categoria = DRE: "${r.origem}"`, { id: r.id }));
    }
  }
  return out;
}

function validarIrmaos(rows) {
  const out = [];
  const porPai = new Map();
  for (const r of (rows || []).filter(isSim)) {
    const pai = normalizeText(r._paiNome || r.hierarquia);
    if (!pai || pai === normalizeText(r.origem)) continue;
    const k = `${pai}|${r.grupo}`;
    if (!porPai.has(k)) porPai.set(k, new Map());
    const d = porPai.get(k);
    d.set(r.chaveDestino, (d.get(r.chaveDestino) || 0) + 1);
  }
  for (const [k, dests] of porPai) {
    if (dests.size > 1) {
      out.push(issue(CLASSE.B, 'info', 'irmaos',
        `Aberturas de "${k.split('|')[0]}" foram para destinos diferentes: `
        + `${[...dests.keys()].join(' ; ')} - a regra é "o filho segue o pai".`));
    }
  }
  return out;
}

function validarZeradas(rows) {
  const out = [];
  for (const r of (rows || []).filter(isSim)) {
    if (!temValor(r) && String(r.destino ?? '').trim()) {
      out.push(issue(CLASSE.B, 'info', 'zerada',
        `"${r.origem}" está alocada mas zerada - considere marcar como contexto.`, { id: r.id }));
    }
  }
  return out;
}

function validarVsDicionario(rows, dictIndex) {
  const out = [];
  if (!dictIndex || !dictIndex.length) return out;
  for (const r of (rows || []).filter(isSim)) {
    if (r.tipoMapeamento !== 'Julgamental') continue;
    const m = matchEntry(r, dictIndex);
    if (m && m.decisao === DECISAO.ALOCAR
        && normalizeText(m.destino) !== normalizeText(r.destino)) {
      out.push(issue(CLASSE.B, 'info', 'dicionario',
        `"${r.origem}" foi para "${r.destino}", mas o dicionário sugere "${m.destino}".`,
        { id: r.id }));
    }
  }
  return out;
}

function validarAtencao(rows) {
  const out = [];
  for (const r of (rows || []).filter(isSim)) {
    if (DESTINOS_ATENCAO.has(normalizeText(r.destino))) {
      out.push(issue(CLASSE.B, 'info', 'atencao-destino',
        `"${r.destino}" é linha de reconciliação (entra duas vezes no cálculo do `
        + 'EBITDA). Confira se é realmente o destino desejado.', { id: r.id }));
    }
  }
  return out;
}

/**
 * Toda alocação RESIDUAL aparece nominalmente. É a condição que torna a
 * residual aceitável: ela troca um bloqueio de Classe A por um aviso revisável,
 * e isso só é honesto se o aviso existir de fato.
 *
 * Classe B, não A: a residual está no bloco correto, logo `Ativo = Passivo + PL`
 * continua fechando. O que ela muda é o INDICADOR - valor em
 * `Outros Operacionais` não lê liquidez como `Clientes` leria.
 */
function validarResidual(rows) {
  const out = [];
  for (const r of (rows || []).filter(isSim)) {
    // `tipoMapeamento`, e não `_residual`: `normalizeRow` descarta campos com
    // prefixo `_` que não estejam na lista dela, então a marca `_residual` não
    // sobrevive a um ciclo de salvar/reabrir. O tipo sobrevive.
    if (r.tipoMapeamento !== 'Residual') continue;
    out.push(issue(CLASSE.B, 'warn', 'destino-residual',
      `"${r.origem}" foi para "${r.destino}", a posição residual de `
      + `${r.grupo}/${r.subCategoria} - nenhuma posição nomeada correspondia ao nome. `
      + 'O balanço fecha, mas o indicador muda: confirme ou troque na grade.',
      { id: r.id }));
  }
  return out;
}

function validarConfianca(rows, minimo = 0.55) {
  const out = [];
  for (const r of (rows || []).filter(isSim)) {
    const c = r.confiancaMapeamento;
    if (typeof c === 'number' && c < minimo && r.tipoMapeamento === 'Julgamental') {
      out.push(issue(CLASSE.B, 'warn', 'baixa-confianca',
        `"${r.origem}" → "${r.destino}" com confiança ${(c * 100).toFixed(0)}% - `
        + 'revise. Abaixo do limiar o sistema prefere deixar em branco a adivinhar.',
        { id: r.id }));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
export function runQA(rows, shadow, dictIndex, opts = {}) {
  const issues = [
    ...validarValoresIlegiveis(rows),
    ...validarLeitura(opts.verificacaoLeitura),
    ...validarDestinos(rows),
    ...validarCompatibilidadeDeSinal(rows),
    ...validarDuplaContagem(rows),
    ...validarOrfaos(shadow?.orphans),
    ...validarConservacao(shadow?.trilha),
    ...validarIdentidade(shadow?.balance, shadow?.trilha),
    ...validarSubcategoria(rows),
    ...validarConsistenciaDeDestino(rows),
    ...validarRetificadoras(rows),
    ...validarIrmaos(rows),
    ...validarZeradas(rows),
    ...validarAtencao(rows),
    ...validarResidual(rows),
    ...validarConfianca(rows),
    ...validarVsDicionario(rows, dictIndex),
  ];

  const classeA = issues.filter((i) => i.classe === CLASSE.A);
  const bloqueantes = classeA.filter((i) => i.level === 'error');
  const acoes = classeA.filter((i) => i.level === 'action');

  const tipos = {};
  for (const r of (rows || []).filter(isSim)) {
    const t = r.tipoMapeamento || '(vazio)';
    tipos[t] = (tipos[t] || 0) + 1;
  }

  return {
    issues,
    bloqueado: bloqueantes.length > 0,
    // `action` não bloqueia a análise, mas exige um clique consciente do
    // usuário antes da entrega (é o caso do transporte de resultado).
    acoesPendentes: acoes,
    summary: {
      linhas: (rows || []).length,
      alocadas: (rows || []).filter(isSim).length,
      contexto: (rows || []).filter((r) => !isSim(r)).length,
      folhas: (rows || []).filter((r) => r._folha).length,
      sinteticas: (rows || []).filter((r) => r._folha === false).length,
      tiposMapeamento: tipos,
      nBloqueantes: bloqueantes.length,
      nAcoes: acoes.length,
      nAvisos: issues.filter((i) => i.classe === CLASSE.B && i.level === 'warn').length,
      nInfos: issues.filter((i) => i.level === 'info').length,
      balance: shadow?.balance ?? null,
      trilha: shadow?.trilha ?? null,
      orfaos: (shadow?.orphans || []).length,
    },
  };
}
