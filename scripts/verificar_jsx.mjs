// Verificador MÍNIMO de JSX: delimitadores e tags balanceados.
//
// POR QUE ISTO EXISTE. A máquina de desenvolvimento está atrás de um proxy que
// bloqueia o npm registry, então `npm ci` pode não rodar e com isso não há Vite,
// nem ESLint, nem Babel - nada que faça o parse de um `.jsx`. E `node --test` só
// carrega `portal/src/core/**`, que é ESM puro: um erro de sintaxe em qualquer
// componente React passa por TODA a verificação disponível e só aparece como tela
// branca no navegador do usuário.
//
// Isto não substitui um parser. Ele pega exatamente a classe de erro que uma
// edição por diff produz: parêntese/chave/colchete desbalanceado e tag JSX sem
// fechamento. Quando `npm ci` funcionar, `npm run build` continua sendo a
// verificação de verdade.
//
// Uso:
//   node scripts/verificar_jsx.mjs portal/src
//   node scripts/verificar_jsx.mjs portal/src/pages/Analise.jsx

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const VAZIAS = new Set(['input', 'br', 'hr', 'img', 'meta', 'link']);

/**
 * Caracteres que, como último token significativo, permitem que `/` inicie um
 * literal de regex.
 *
 * `}` está deliberadamente FORA. Em JSX, `}` fecha um container de expressão e o
 * que vem depois é texto - `({o.grupo}/{o.subCategoria})` tem uma barra literal,
 * não uma regex. Tratá-la como regex fazia o verificador engolir o resto da
 * linha, perder um `{` e acusar `ShadowView.jsx` de desbalanceado quando o
 * arquivo estava correto. Um falso positivo aqui é pior que um falso negativo:
 * ele treina a gente a ignorar a ferramenta.
 */
const ANTES_DE_REGEX = '(,=:[!&|?;+-*%~^';

function verificar(arquivo) {
  const src = readFileSync(arquivo, 'utf-8');
  let i = 0;
  let linha = 1;
  const pilha = [];
  const tags = [];
  const erros = [];

  const avanca = (n = 1) => {
    for (let k = 0; k < n; k += 1) if (src[i + k] === '\n') linha += 1;
    i += n;
  };

  while (i < src.length) {
    const c = src[i];
    const dois = src.slice(i, i + 2);

    if (dois === '//') { while (i < src.length && src[i] !== '\n') avanca(); continue; }
    if (dois === '/*') {
      const fim = src.indexOf('*/', i + 2);
      avanca((fim < 0 ? src.length : fim + 2) - i);
      continue;
    }
    if (c === '/') {
      let k = i - 1;
      while (k >= 0 && /\s/.test(src[k])) k -= 1;
      const anterior = k >= 0 ? src[k] : '';
      const podeSerRegex = k < 0 || ANTES_DE_REGEX.includes(anterior)
        || /\b(return|typeof|case|in|of|do|else)$/.test(src.slice(Math.max(0, k - 9), k + 1));
      if (podeSerRegex) {
        // Espia até o fim da linha: só consome como regex se houver a barra de
        // fechamento. Assim uma divisão nunca engole o resto da linha.
        const fimLinha = src.indexOf('\n', i + 1);
        const trecho = src.slice(i + 1, fimLinha < 0 ? src.length : fimLinha);
        let j = 0;
        let emClasse = false;
        let fechou = false;
        while (j < trecho.length) {
          if (trecho[j] === '\\') { j += 2; continue; }
          if (trecho[j] === '[') emClasse = true;
          else if (trecho[j] === ']') emClasse = false;
          else if (trecho[j] === '/' && !emClasse) { fechou = true; break; }
          j += 1;
        }
        if (fechou) { avanca(j + 2); continue; }
      }
    }
    if (c === '"' || c === "'" || c === '`') {
      const abre = c;
      avanca();
      while (i < src.length && src[i] !== abre) {
        if (src[i] === '\\') avanca();
        avanca();
      }
      avanca();
      continue;
    }
    if ('([{'.includes(c)) { pilha.push({ c, linha }); avanca(); continue; }
    if (')]}'.includes(c)) {
      const par = { ')': '(', ']': '[', '}': '{' }[c];
      const topo = pilha.pop();
      if (!topo || topo.c !== par) {
        erros.push(`linha ${linha}: '${c}' fecha '${topo ? topo.c : 'nada'}'`);
      }
      avanca();
      continue;
    }

    const m = /^<(\/?)([A-Za-z][A-Za-z0-9.]*)/.exec(src.slice(i));
    if (m) {
      const fechando = m[1] === '/';
      const nome = m[2];
      let j = i + m[0].length;
      let prof = 0;
      while (j < src.length) {
        const ch = src[j];
        if (ch === '{') prof += 1;
        else if (ch === '}') prof -= 1;
        else if ((ch === '"' || ch === "'") && prof === 0) {
          const abre = ch;
          j += 1;
          while (j < src.length && src[j] !== abre) j += 1;
        } else if (ch === '>' && prof === 0) break;
        j += 1;
      }
      const corpo = src.slice(i, j);
      const autofechada = corpo.trimEnd().endsWith('/') || VAZIAS.has(nome);
      if (fechando) {
        const topo = tags.pop();
        if (!topo || topo.nome !== nome) {
          erros.push(`linha ${linha}: </${nome}> fecha <${topo ? topo.nome : 'nada'}>`
            + (topo ? ` aberta na linha ${topo.linha}` : ''));
        }
      } else if (!autofechada) {
        tags.push({ nome, linha });
      }
      avanca(j - i + 1);
      continue;
    }

    avanca();
  }

  for (const p of pilha) erros.push(`'${p.c}' aberto na linha ${p.linha} sem fechar`);
  for (const t of tags) erros.push(`<${t.nome}> aberta na linha ${t.linha} sem fechar`);
  return erros;
}

function coletar(alvo) {
  if (statSync(alvo).isFile()) return [alvo];
  const out = [];
  for (const nome of readdirSync(alvo)) {
    const caminho = join(alvo, nome);
    if (statSync(caminho).isDirectory()) out.push(...coletar(caminho));
    else if (['.jsx', '.js', '.mjs'].includes(extname(nome))) out.push(caminho);
  }
  return out.sort();
}

const alvo = process.argv[2] || 'portal/src';
const arquivos = coletar(alvo);
let comErro = 0;
for (const arquivo of arquivos) {
  const erros = verificar(arquivo);
  if (!erros.length) continue;
  comErro += 1;
  console.log(`\u2716 ${arquivo}`);
  for (const e of erros.slice(0, 25)) console.log(`   ${e}`);
}
console.log(`${comErro ? '\u2716' : '\u2714'} ${arquivos.length} arquivo(s) verificado(s), `
  + `${comErro} com delimitador ou tag desbalanceada`);
process.exit(comErro ? 1 : 0);
