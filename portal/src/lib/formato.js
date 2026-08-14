// Formatação para exibição. Puro, sem React - usado por componentes e testes.
//
// Um número contábil em análise de crédito é lido por gente que confere na mão
// contra o documento. Então: SEMPRE duas casas decimais, SEMPRE separador de
// milhar pt-BR, e nunca notação científica ou abreviação nos valores que
// precisam ser conferidos. A forma abreviada existe só para cartões de resumo,
// onde ninguém confere.

const FMT_2 = new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const FMT_0 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });

/** Número seguro: `null`, `''`, `undefined` e ilegível viram 0. */
function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

/**
 * Valor contábil com duas casas: `118035576.14` -> `"118.035.576,14"`.
 * @param {number|string|null|undefined} v
 */
export function moeda(v) {
  return FMT_2.format(n(v));
}

/**
 * Idem, mas célula VAZIA continua vazia.
 *
 * A distinção importa: no núcleo, `null` significa "o documento não tem valor
 * nesta coluna" e `0` significa "tem, e é zero". Exibir `0,00` para uma célula
 * ausente induz o analista a achar que leu algo que não estava lá - e foi
 * exatamente esse tipo de confusão que fez a v1 tratar traço como zero.
 * @param {number|string|null|undefined} v
 */
export function moedaOuVazio(v) {
  if (v === null || v === undefined || v === '') return '';
  return moeda(v);
}

/** Inteiro com separador de milhar. */
export function inteiro(v) {
  return FMT_0.format(Math.round(n(v)));
}

/**
 * Percentual a partir de FRAÇÃO: `0.0123` -> `"1,230%"`.
 * @param {number} fracao
 * @param {number} [casas]
 */
export function percentual(fracao, casas = 3) {
  return `${(n(fracao) * 100).toFixed(casas).replace('.', ',')}%`;
}

/**
 * Forma abreviada para cartões: `118035576` -> `"118,0 MM"`.
 * Nunca use em coluna que o analista confere contra o documento.
 */
export function compacto(v) {
  const x = n(v);
  const abs = Math.abs(x);
  const sinal = x < 0 ? '-' : '';
  if (abs >= 1e9) return `${sinal}${(abs / 1e9).toFixed(1).replace('.', ',')} BI`;
  if (abs >= 1e6) return `${sinal}${(abs / 1e6).toFixed(1).replace('.', ',')} MM`;
  if (abs >= 1e3) return `${sinal}${(abs / 1e3).toFixed(1).replace('.', ',')} mil`;
  return moeda(x);
}

/**
 * `true` quando o valor é zero dentro da tolerância de exibição.
 *
 * `0.005` é meio centavo: abaixo disso o `round2` do núcleo já produziria
 * `0,00`, então pintar de vermelho um balde "não-zero" que exibe `0,00` seria
 * mentir para o analista.
 */
export function ehZero(v, tol = 0.005) {
  return Math.abs(n(v)) < tol;
}

/** Data/hora ISO em pt-BR curto. String inválida devolve `''`. */
export function dataHora(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/** Só a data. */
export function data(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('pt-BR');
}

/**
 * Rótulo do slot de ano para cabeçalho de tabela.
 *
 * Usa o rótulo REAL do período quando existe (`"31/05/2026"`), porque é o que
 * está impresso no documento; cai para `"Ano 3"` quando o slot está vazio.
 * @param {Array<{slot:string, year:string|null, header:string}>} yearHeaders saída de `alignYearHeaders`
 * @param {number} indice 0..2
 */
export function rotuloAno(yearHeaders, indice) {
  const h = (yearHeaders || [])[indice];
  if (!h) return `Ano ${indice + 1}`;
  return h.header || h.slot || `Ano ${indice + 1}`;
}

/** Slots que têm período real - as colunas que vale a pena renderizar. */
export function anosComDados(yearHeaders) {
  return (yearHeaders || [])
    .map((h, i) => ({ ...h, campo: `ano${i + 1}`, indice: i }))
    .filter((h) => h.year != null);
}

/** Tamanho de arquivo legível. */
export function tamanhoArquivo(bytes) {
  const b = n(bytes);
  if (b < 1024) return `${inteiro(b)} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} kB`;
  return `${(b / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}

/** Corta texto longo preservando o começo, que é o que identifica a conta. */
export function truncar(texto, max = 60) {
  const t = String(texto ?? '');
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}
