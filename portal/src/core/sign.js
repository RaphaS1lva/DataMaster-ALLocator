// Regras de sinal.
//
// Duas regras independentes, aplicadas NESTA ORDEM:
//
//   §14.2  saldo do documento  ->  valor de apresentação   (natureza D/C)
//   §14.1  valor de apresentação -> valor gravado          (prefixo do destino)
//
// ---------------------------------------------------------------------------
// POR QUE O v1 ERRAVA: sinal derivado do GRUPO
// ---------------------------------------------------------------------------
// O v1 fazia `v * sinalGrupo(grupo)`, com `sinalGrupo` devolvendo -1 para todo
// Passivo/PL e +1 para todo Ativo. Isso pressupõe que toda conta de um grupo
// tem a natureza "normal" daquele grupo. É falso, e o custo é enorme.
//
// Medido no Balancete SPE (exemplo) 05.2026 (Protheus, 224 contas analíticas):
// 24 contas têm natureza CONTRÁRIA ao próprio grupo,
//
//   no ATIVO com saldo CREDOR ......... R$  13.267.131,49
//     (-) PCLD, (-) AMORT.ACUM.SOFTWARES, (-) AMORT.ACUM.BENFEITORIAS, +7
//   no PASSIVO com saldo DEVEDOR ...... R$  62.309.475,74
//     ( - ) JUROS DEBENTURES (x2), (-) PREJUIZOS ACUMULADOS
//
// Ignorar a natureza inflava o Ativo em R$ 26.534.262,98 e o Passivo em
// R$ 124.618.951,48. E multiplicar o grupo por -1 NÃO resolve, porque o erro é
// intra-grupo. Os grupos de resultado também não são homogêneos: o grupo 3
// (Despesas) contém "39 OUTRAS RECEITAS" (credora) e o grupo 4 (Receitas)
// contém "43 DEDUÇÕES DA RECEITA BRUTA" (devedora).
//
// Conclusão: a natureza é um atributo DA LINHA, nunca do grupo. Quando o
// documento a declara (coluna D/C do balancete), ela é autoritativa.

import { parseNumber, coerceNumber } from './normalize.js';
import { normalizeText } from './normalize.js';

// ---------------------------------------------------------------------------
// §14.1 - prefixo do nome do destino
// ---------------------------------------------------------------------------
/**
 * `pm`   destino começa com `+/-`  -> preserva o sinal
 * `neg`  destino começa com `-`    -> grava |v|; a fórmula do template subtrai
 * `pos`  destino começa com `+`    -> grava |v|; a fórmula soma
 * `none` sem prefixo               -> preserva o sinal
 *
 * O motivo de `neg` gravar positivo: a fórmula já tem o sinal. Gravar negativo
 * faria "menos com menos" e inverteria o resultado.
 */
export function signKind(destino) {
  const n = String(destino ?? '').trim();
  if (n.startsWith('+/-') || /^\+\s*\/\s*-/.test(n)) return 'pm';
  if (n.startsWith('-')) return 'neg';
  if (n.startsWith('+')) return 'pos';
  return 'none';
}

/** Aplica §14.1: `neg`/`pos` gravam módulo; `pm`/`none` preservam. */
export function applySignByDestino(valorApresentacao, destino) {
  const v = coerceNumber(valorApresentacao);
  if (v === null) return null;
  const kind = signKind(destino);
  return (kind === 'neg' || kind === 'pos') ? Math.abs(v) : v;
}

/**
 * Contribuição que o template dará a uma linha, dado o valor GRAVADO.
 *
 * No grafo de fórmulas, TODO destino com prefixo `-` é subtraído do seu
 * subtotal e todo o resto é somado - verifiquei posição por posição em
 * knowledge/formulas-shadow.md. Então a contribuição é `-gravado` para `neg` e
 * `+gravado` para os demais.
 */
export function contribuicaoNoTemplate(valorGravado, destino) {
  const v = coerceNumber(valorGravado);
  if (v === null) return null;
  return signKind(destino) === 'neg' ? -v : v;
}

/**
 * O sinal do valor é COMPATÍVEL com o destino escolhido?
 *
 * Como `neg`/`pos` gravam `Math.abs()`, o sinal da apresentação é DESTRUÍDO na
 * gravação. Isso só é seguro se o sinal já concordava com a direção do destino;
 * caso contrário a contribuição sai invertida e a diferença vira 2x o valor.
 * Sendo a apresentação a "contribuição assinada ao bloco", a regra é direta:
 *
 *     destino `neg` (subtraído)  -> apresentação deve ser <= 0
 *     destino `pos` (somado)     -> apresentação deve ser >= 0
 *     destino `none` / `pm`      -> qualquer sinal (é preservado)
 *
 * Exemplos reais do balancete:
 *   `(-) AMORT.ACUM.SOFTWARES`  apresentação -2.028.812,59 -> `-Depreciação
 *      Acumulada` (neg). OK: grava módulo, a fórmula subtrai, contribui -2,02 MM.
 *   `RECUPERACAO DE DESPESAS`   apresentação  +109.077,90  -> `- Despesas
 *      Administrativas` (neg). ERRO: é crédito dentro do grupo de despesas, ou
 *      seja AUMENTA o lucro; o módulo faria a fórmula subtrair. Destino correto
 *      é um `+/-`, que preserva o sinal.
 *
 * O v1 tinha uma checagem parecida, mas rodava sobre o valor JÁ gravado (sempre
 * >= 0 depois do `Math.abs()`), então nunca disparava.
 *
 * @param {number|string} valorApresentacao
 * @param {string} destino
 * @returns {boolean}
 */
export function signIsValid(valorApresentacao, destino) {
  const v = coerceNumber(valorApresentacao);
  if (v === null || v === 0) return true;
  const kind = signKind(destino);
  if (kind === 'neg') return v <= 0;
  if (kind === 'pos') return v >= 0;
  return true;
}

/** Mensagem pronta explicando a incompatibilidade de sinal. */
export function explicarSinalIncompativel(valorApresentacao, destino) {
  const kind = signKind(destino);
  const v = coerceNumber(valorApresentacao);
  if (kind === 'neg') {
    return `o destino "${destino}" é SUBTRAÍDO pela fórmula e grava o módulo, mas `
      + `o valor de apresentação é positivo (${v}) - a contribuição sairia `
      + 'invertida. Use um destino "+/-" (preserva o sinal) ou o destino da conta '
      + 'que esta retifica.';
  }
  return `o destino "${destino}" é SOMADO e grava o módulo, mas o valor de `
    + `apresentação é negativo (${v}) - a contribuição sairia invertida. Use um `
    + 'destino "+/-" ou o destino correspondente do outro sinal.';
}

// ---------------------------------------------------------------------------
// §14.2 - natureza da linha (débito/crédito)
// ---------------------------------------------------------------------------
export const NATUREZA = { DEBITO: 'D', CREDITO: 'C', DESCONHECIDA: '' };

/** Interpreta o texto de uma coluna D/C. Vazio/`None`/`-` => desconhecida. */
export function parseNatureza(valor) {
  const t = normalizeText(valor);
  if (!t || t === 'none' || t === 'null') return NATUREZA.DESCONHECIDA;
  if (t === 'd' || t.startsWith('deb')) return NATUREZA.DEBITO;
  if (t === 'c' || t.startsWith('cred')) return NATUREZA.CREDITO;
  return NATUREZA.DESCONHECIDA;
}

/**
 * Natureza que produz CONTRIBUIÇÃO POSITIVA ao bloco da conta.
 *
 * A convenção do v2 - e é ela que faz tudo colapsar numa regra só - é:
 *
 *     valor de apresentação = CONTRIBUIÇÃO ASSINADA AO PRÓPRIO BLOCO
 *
 *   Ativo         positivo aumenta o Ativo          -> natural é DÉBITO
 *   Passivo / PL  positivo aumenta Passivo+PL       -> natural é CRÉDITO
 *   DRE           positivo aumenta o LUCRO          -> natural é CRÉDITO
 *
 * Com isso, uma conta retificadora sai NEGATIVA automaticamente, sem precisar
 * saber se ela é "despesa" ou "receita": crédito dentro do Ativo é negativo,
 * débito dentro da DRE é negativo. E os grupos de resultado deixam de precisar
 * ser homogêneos - o que é essencial, porque no arquivo real o grupo 3
 * (Despesas) contém `39 OUTRAS RECEITAS` (credora) e o grupo 4 (Receitas)
 * contém `43 DEDUÇÕES DA RECEITA BRUTA` (devedora).
 *
 * Consequência que vale ouro: a soma das contribuições das folhas reproduz o
 * subtotal declarado em QUALQUER bloco, e o resultado do período é simplesmente
 * `soma(grupo 3) + soma(grupo 4)` - sem subtração, sem caso especial.
 *
 * @param {string} grupo Ativo | Passivo | DRE
 */
export function naturezaEsperada(grupo) {
  const g = normalizeText(grupo);
  if (g === 'ativo') return NATUREZA.DEBITO;
  if (g === 'passivo' || g === 'dre') return NATUREZA.CREDITO;
  return NATUREZA.DESCONHECIDA;
}

// Nomes que denunciam conta retificadora. Usados APENAS como conferência
// cruzada: se o nome diz "(-)" mas o D/C diz o contrário, emitimos aviso e
// confiamos no D/C. Nunca o inverso - no documento real, `(-)` é rótulo.
const RE_RETIFICADORA = /^\s*\(\s*-\s*\)|(\bamort\w*\.?\s*acum)|(\bdeprec\w*\.?\s*acum)|\bpcld\b|\bpdd\b|\bprovis\w+\s+para\s+(perda|devedor)|em\s+tesouraria/i;

/** Heurística de retificadora pelo nome (só para conferência cruzada). */
export function pareceRetificadora(nome) {
  return RE_RETIFICADORA.test(String(nome ?? ''));
}

/**
 * Converte o saldo lido do documento em VALOR DE APRESENTAÇÃO (§14.2), com
 * sinal positivo na natureza normal do grupo.
 *
 * Fontes de sinal, em ordem de autoridade:
 *   1. `natureza` explícita da linha (coluna D/C) - autoritativa
 *   2. sinal do próprio valor (parênteses, `-`, `-` à direita)
 *   3. natureza esperada do grupo - último recurso
 *
 * @param {number|string} saldo valor como está no documento
 * @param {string} grupo Ativo | Passivo | DRE
 * @param {object} [opts]
 * @param {string} [opts.natureza] 'D' | 'C' | '' (coluna D/C da linha)
 * @param {string} [opts.papel] despesa | receita | apuracao (1º dígito do código)
 * @param {boolean} [opts.saldosAbsolutos=false] o documento traz módulos
 *   (todos positivos) e a natureza vive na coluna D/C - típico de balancete
 * @returns {{valor:number|null, fonte:string, aviso:string|null}}
 */
export function saldoParaApresentacao(saldo, grupo, opts = {}) {
  const p = parseNumber(saldo);
  if (!p.ok) {
    return { valor: null, fonte: 'ilegivel', aviso: `valor ilegível: "${p.raw}"` };
  }
  if (p.value === null) return { valor: null, fonte: 'vazio', aviso: null };

  const nat = parseNatureza(opts.natureza);
  const esperada = naturezaEsperada(grupo);

  if (nat) {
    // O documento declara a natureza: o módulo é o dado, o D/C é o sinal.
    // Natureza natural do bloco => positivo; contrária => retificadora, negativo.
    const mag = Math.abs(p.value);
    if (!esperada) {
      return {
        valor: mag,
        fonte: 'dc-sem-grupo',
        aviso: 'natureza declarada, mas o grupo da conta é desconhecido - valor '
          + 'mantido em módulo; classifique o grupo para o sinal ser aplicado',
      };
    }
    return { valor: nat === esperada ? mag : -mag, fonte: 'dc', aviso: null };
  }

  if (opts.saldosAbsolutos) {
    return {
      valor: Math.abs(p.value),
      fonte: 'absoluto-sem-dc',
      aviso: 'documento com saldos absolutos, mas esta linha não trouxe D/C - '
        + 'natureza assumida como normal do grupo',
    };
  }

  // Documento já traz o sinal (BP/DRE publicado): usa como está.
  return { valor: p.value, fonte: 'sinal-do-valor', aviso: null };
}

/**
 * Pipeline completo: saldo do documento -> valor a gravar em Ano N.
 * @returns {{valor:number|null, fonte:string, aviso:string|null}}
 */
export function computeStoredValue(saldo, destino, grupo, opts = {}) {
  const ap = saldoParaApresentacao(saldo, grupo, opts);
  if (ap.fonte === 'ilegivel') return ap;
  if (ap.valor === null) return ap;
  const temDestino = destino && String(destino).trim();
  return {
    valor: temDestino ? applySignByDestino(ap.valor, destino) : ap.valor,
    fonte: ap.fonte,
    aviso: ap.aviso,
  };
}

/**
 * Grupo a partir do 1º dígito do código contábil (§8.7). Prevalece sobre o
 * nome: num balancete, `4.x` é receita mesmo que o nome pareça despesa.
 * Não decide a NATUREZA - só o grupo. A natureza vem do D/C.
 */
export function grupoFromCodigo(codigo) {
  const m = String(codigo ?? '').trim().match(/^(\d)/);
  if (!m) return null;
  switch (m[1]) {
    case '1': return { grupo: 'Ativo', natureza: NATUREZA.DEBITO };
    case '2': return { grupo: 'Passivo', natureza: NATUREZA.CREDITO };
    case '3': return { grupo: 'DRE', papel: 'despesa', natureza: NATUREZA.DEBITO };
    case '4': return { grupo: 'DRE', papel: 'receita', natureza: NATUREZA.CREDITO };
    case '5': return { grupo: 'DRE', papel: 'apuracao', natureza: NATUREZA.DESCONHECIDA };
    default: return null;
  }
}
