// Verifica que TODO import relativo do portal resolve para um arquivo existente,
// e que nenhum módulo importa algo que não está declarado no package.json.
//
// Por que este teste existe: nesta máquina o registry do npm está bloqueado pelo
// proxy corporativo (UNABLE_TO_GET_ISSUER_CERT_LOCALLY), então `npm install` e
// `npm run build` não rodam aqui - o build de verdade acontece no CI e no
// notebook servidor. Sem o bundler, um caminho de import errado ou uma
// dependência esquecida só apareceria no deploy.
//
// Este teste cobre exatamente essa lacuna usando só a stdlib do Node: percorre
// os arquivos, extrai os imports e resolve cada um. É a validação mais valiosa
// que dá para fazer sem o bundler.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const PORTAL = resolve(AQUI, '..');
const SRC = join(PORTAL, 'src');

const pkg = JSON.parse(readFileSync(join(PORTAL, 'package.json'), 'utf-8'));
const DECLARADAS = new Set([
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.devDependencies || {}),
]);

/** Todos os .js/.jsx/.mjs sob um diretório. */
function arquivos(dir) {
  const out = [];
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    const caminho = join(dir, entrada.name);
    if (entrada.isDirectory()) {
      if (['node_modules', 'dist', '.vite'].includes(entrada.name)) continue;
      out.push(...arquivos(caminho));
    } else if (['.js', '.jsx', '.mjs'].includes(extname(entrada.name))) {
      out.push(caminho);
    }
  }
  return out;
}

// `from '...'` de import estático, re-export e import() dinâmico
const RE_IMPORT = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function importsDe(conteudo) {
  const out = [];
  for (const m of conteudo.matchAll(RE_IMPORT)) {
    const especificador = m[1] || m[2];
    if (especificador) out.push(especificador);
  }
  // `import 'x'` sem `from` (efeito colateral, ex.: CSS)
  for (const m of conteudo.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)) {
    out.push(m[1]);
  }
  return out;
}

/** Resolve como o Vite: caminho exato, ou +extensão, ou /index.*  */
function resolveRelativo(base, especificador) {
  const bruto = resolve(dirname(base), especificador);
  const candidatos = [
    bruto,
    ...['.js', '.jsx', '.mjs', '.json', '.css'].map((e) => bruto + e),
    ...['.js', '.jsx', '.mjs'].map((e) => join(bruto, 'index' + e)),
  ];
  return candidatos.find((c) => existsSync(c) && statSync(c).isFile()) || null;
}

const TODOS = arquivos(SRC);

test('há arquivos para verificar', () => {
  assert.ok(TODOS.length >= 20, `só ${TODOS.length} arquivos em src/`);
});

test('todo import RELATIVO resolve para um arquivo existente', () => {
  const quebrados = [];
  for (const arq of TODOS) {
    for (const esp of importsDe(readFileSync(arq, 'utf-8'))) {
      if (!esp.startsWith('.')) continue;
      if (!resolveRelativo(arq, esp)) {
        quebrados.push(`${arq.replace(PORTAL, '')} -> ${esp}`);
      }
    }
  }
  assert.deepEqual(quebrados, [],
    `${quebrados.length} import(s) apontando para arquivo inexistente`);
});

test('todo import de PACOTE está declarado no package.json', () => {
  const naoDeclarados = new Set();
  for (const arq of TODOS) {
    for (const esp of importsDe(readFileSync(arq, 'utf-8'))) {
      if (esp.startsWith('.') || esp.startsWith('/')) continue;
      if (esp.startsWith('node:')) continue;
      // `react-dom/client` -> pacote `react-dom`; `@scope/pkg/sub` -> `@scope/pkg`
      const pacote = esp.startsWith('@')
        ? esp.split('/').slice(0, 2).join('/')
        : esp.split('/')[0];
      if (!DECLARADAS.has(pacote)) naoDeclarados.add(`${pacote} (em ${arq.replace(PORTAL, '')})`);
    }
  }
  assert.deepEqual([...naoDeclarados], [],
    'dependência usada mas não declarada - o build quebraria no CI');
});

test('o portal não ganhou dependência de runtime inesperada', () => {
  // A leveza é deliberada: sem lib de UI, de estado, de gráfico ou de XLSX. Cada
  // dependência nova é superfície de supply chain num projeto que lê balanço de
  // cliente. Se precisar mesmo de uma, atualize esta lista com intenção.
  assert.deepEqual(Object.keys(pkg.dependencies || {}).sort(),
    ['react', 'react-dom', 'react-router-dom']);
});

test('o núcleo contábil é PURO - sem DOM, sem rede, sem React', () => {
  // `portal/src/core/` roda igual no browser, no Node e nos testes. Se alguém
  // importar React ou tocar em `window` ali, o núcleo deixa de ser testável
  // fora do browser e a garantia do invariante fica dependente de ambiente.
  const proibidos = [/\bfrom\s+['"]react/, /\bwindow\./, /\bdocument\./,
    /\blocalStorage\b/, /\bfetch\s*\(/];
  const violacoes = [];
  for (const arq of arquivos(join(SRC, 'core'))) {
    const conteudo = readFileSync(arq, 'utf-8');
    for (const re of proibidos) {
      if (re.test(conteudo)) violacoes.push(`${arq.replace(PORTAL, '')}: ${re}`);
    }
  }
  assert.deepEqual(violacoes, []);
});

test('nenhum .gen.js foi editado à mão', () => {
  // São artefatos de build de scripts/gen_knowledge.py. Editar à mão faz a
  // fonte de verdade (knowledge/) divergir silenciosamente do que roda.
  for (const arq of arquivos(join(SRC, 'core', 'data'))) {
    const primeira = readFileSync(arq, 'utf-8').split('\n')[0];
    assert.match(primeira, /GERADO por scripts\/gen_knowledge\.py/,
      `${arq.replace(PORTAL, '')} perdeu o cabeçalho de arquivo gerado`);
  }
});
