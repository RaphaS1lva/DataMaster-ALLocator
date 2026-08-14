import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Configuração do build do portal.
//
// `base: './'` - CAMINHOS RELATIVOS nos assets. O GitHub Pages de projeto serve
// em `https://usuario.github.io/ALLocator-v2/`, e o padrão do Vite (`base: '/'`)
// gera `<script src="/assets/index-abc.js">`, que o navegador resolve na RAIZ do
// domínio: 404 em todos os assets e tela branca sem erro visível. Com `./` o
// bundle funciona em qualquer subcaminho - e também ao abrir o `dist/index.html`
// direto do disco. É a mesma razão pela qual `lib/config.js` faz
// `fetch('./runtime-config.json')` e não `/runtime-config.json`.
//
// `sourcemap: false` - o repositório é público e o mapa publicaria o fonte
// original junto com o bundle.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: false,
    // O `dicionario.gen.js` tem 1.260 regras e o `shadowCompute.gen.js` o grafo
    // inteiro de fórmulas: o chunk passa de 500 kB e o aviso padrão do Vite é
    // só ruído aqui. Subimos o limite em vez de fatiar o núcleo contábil, que
    // é carregado inteiro de qualquer forma (o pipeline roda no boot da análise).
    chunkSizeWarningLimit: 900,
  },
  server: { port: 5173 },
  preview: { port: 4173 },
});
