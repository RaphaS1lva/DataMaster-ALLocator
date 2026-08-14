# Deploy: GitHub Pages, Neon e Render - migração manual da v1 para a v2

> Procedimento para colocar a v2 no ar **à mão**, sem pressupor conhecimento de
> GitHub Actions. Público: o autor do projeto, migrando do portal v1.
>
> A regra deste documento: **nada aqui derruba o portal v1**. A v1 continua no ar
> até você decidir trocar, e a seção 10 mostra como voltar em menos de 5 minutos.

---

## 1. Visão do que muda

| | v1 | v2 |
|---|---|---|
| Frontend | React + Vite no GitHub Pages | **igual** |
| Dados | Supabase direto do browser (anon key + RLS) | **API própria → Neon Postgres** |
| Auth | Supabase Auth | **JWT próprio, emitido pela API** |
| IA | 4 APIs gratuitas em cascata | **Ollama local + fallback de nuvem** |
| URL da API | embutida na build (`VITE_API_URL`) | **lida em runtime (`runtime-config.json`)** |

Quatro mudanças, quatro motivos distintos:

**Dados: por que sair do acesso direto do browser.** Com Supabase chamado do
frontend, a `anon key` está no bundle - é pública por desenho - e a única coisa
entre um curioso e a tabela é a política de RLS. Uma política mal escrita é
vazamento de dado de cliente. Com API no meio, o segredo do banco vive **no
servidor**, e a regra de autorização é código testável em vez de configuração de
painel.

**Auth: por que JWT próprio.** Consequência da anterior. Se a API é a única porta
do banco, é ela que precisa saber quem está falando. Manter o Supabase Auth
significaria validar token de terceiro numa API que já não usa o resto do
Supabase.

**IA: por que local.** É o assunto da seção 11 de
<ref_file file="docs/09-runbook-notebook.md" />, e resumindo: as 4 APIs da v1
rodavam em tier gratuito, cujos termos permitem usar o conteúdo enviado para
treinamento. Balancete de cliente em análise de crédito não pode transitar assim.

**URL em runtime: por que não `VITE_API_URL`.** O hostname do Cloudflare Tunnel
gratuito muda a cada reinício. Detalhe na seção 6.

### O que NÃO muda, e é o ponto

O motor determinístico continua **inteiro no navegador**: `portal/src/core/`,
`keys.js`, `planoContas.js`, `sign.js`, `hierarchy.js`, `invariants.js`,
`shadow.js`, `qa.js`. Ele não depende de rede, de banco nem de LLM. É por isso
que a arquitetura de dois planos funciona: a parte que **garante** o fechamento
`Ativo = Passivo + PL` já roda no cliente, e o que está sendo distribuído aqui é
persistência e julgamento - nunca a correção aritmética.

---

## 2. Preparar o repositório

### Estrutura a subir

```
ALLocator-v2/
├── .github/
│   └── workflows/
│       └── deploy.yml            <- build e publicação do portal
├── docs/                         <- documentação (sobe: é parte da entrega)
│   ├── 02-invariante-contabil.md
│   ├── 09-runbook-notebook.md
│   └── 10-deploy-github-pages.md
├── knowledge/                    <- fonte de verdade do plano de contas
│   ├── plano-de-contas.lock.json
│   ├── plano-de-contas.md
│   ├── regras-de-sinal.md
│   ├── formulas-shadow.md
│   ├── auditoria-dicionario.md
│   └── dicionario.csv
├── portal/
│   ├── public/
│   │   └── runtime-config.json   <- URLs lidas em runtime (seção 6)
│   ├── src/
│   │   └── core/                 <- motor determinístico
│   ├── test/
│   ├── index.html
│   ├── package.json
│   ├── package-lock.json         <- SOBE. O `npm ci` do CI exige
│   └── vite.config.js
├── scripts/
│   ├── bootstrap_knowledge.py
│   ├── gen_knowledge.py
│   ├── extrair_fixture_balancete.py
│   ├── setup-notebook.ps1
│   └── start-servidor.ps1
├── server/
│   ├── app/
│   │   ├── db/
│   │   │   └── schema.sql
│   │   ├── llm/
│   │   ├── obs/
│   │   ├── reading/
│   │   └── main.py
│   ├── tests/
│   ├── .env.example              <- SOBE (é modelo, sem valores reais)
│   ├── requirements.txt
│   └── run_tests.py
├── .gitignore
└── README.md
```

### O que NÃO subir

| Não subir | Por quê |
|---|---|
| `server/.env` | senha do Neon, `JWT_SECRET`, `ALLOCATOR_API_TOKEN`, chaves de API |
| `server/.venv/` | centenas de MB de binário específico da sua máquina; reconstruído por `pip install -r requirements.txt` |
| `portal/node_modules/` | idem; reconstruído por `npm ci` |
| `portal/dist/` | artefato de build; quem gera é o GitHub Actions |
| `__pycache__/`, `*.pyc` | bytecode |
| **balanços e balancetes de clientes** | `*.xlsx`, `*.pdf` com dado real. **Repositório público é publicação.** |

O último merece parágrafo próprio. `git rm` num commit seguinte **não remove** o
arquivo do histórico - ele permanece recuperável por qualquer clone. Se dado real
de cliente for para um repositório público, o procedimento não é "apagar": é
reescrever o histórico ou recriar o repositório. Configure o `.gitignore`
**antes** do primeiro `git add`.

Para fixture de teste, use dado **anonimizado** - é o que
`scripts/extrair_fixture_balancete.py` existe para produzir.

### `.gitignore` recomendado

Na raiz do repositório:

```gitignore
# --- segredos ---
.env
.env.*
!.env.example
*.pem
*.key

# --- Python ---
__pycache__/
*.py[cod]
.venv/
venv/
server/.venv/
.pytest_cache/
.ruff_cache/

# --- Node / build do portal ---
node_modules/
portal/node_modules/
dist/
portal/dist/
.vite/
npm-debug.log*

# --- dado de cliente: NUNCA versionar ---
*.xlsx
*.xlsm
*.pdf
!docs/**/*.pdf
dados/
entrada/
balancetes/

# --- sistema operacional e editor ---
Thumbs.db
desktop.ini
.DS_Store
.idea/
.vscode/*
!.vscode/settings.json

# --- Cloudflare ---
.cloudflared/
*.json.cloudflared
```

`.env.*` com a exceção `!.env.example` é deliberado: bloqueia `.env.local`,
`.env.producao` e variações, mas deixa passar o **modelo** sem valores, que é
justamente o que precisa estar versionado.

> Nota: a regra `*.xlsx` também ignora o template Excel original. Se ele tiver de
> ser versionado, adicione uma exceção pontual (`!knowledge/template.xlsx`) em
> vez de remover a regra genérica.

### Criar e enviar

```powershell
cd "C:\caminho\para\ALLocator v2"
git init -b main
```

Escreva o `.gitignore` **agora**. Depois confirme o que entraria - a hora de
descobrir um `.env` na lista é aqui, não depois do push:

```powershell
git add --all --dry-run
```

Confira que **não** aparecem `.env`, `node_modules`, `.venv`, `dist` nem nenhum
`.xlsx`/`.pdf` de cliente. Se aparecer, corrija o `.gitignore` e repita.

```powershell
git add --all
git commit -m "ALLocator v2: motor deterministico, plano de dados e plano de inferencia"
```

Crie o repositório vazio no GitHub (**sem** README, **sem** `.gitignore` - eles
causam conflito no primeiro push) e conecte:

```powershell
git remote add origin https://github.com/SEU-USUARIO/ALLocator-v2.git
git push -u origin main
```

Verificar:

```powershell
git ls-files | Select-String "\.env$|node_modules|\.venv"
```

**Não deve retornar nada.** `git ls-files` lista o que está de fato rastreado,
é a checagem que vale, não o `.gitignore`.

---

## 3. Criar o projeto no Neon

### Passos

**1. Conta.** <https://neon.tech> → *Sign up* (login com GitHub é o mais direto).

**2. Projeto.** *Create project*:

- **Name**: `allocator-v2`
- **Postgres version**: 16 ou 17
- **Region**: a mais próxima do Render - se o Render ficar em Oregon, escolha
  `AWS us-west-2`. Cada milissegundo de latência entre API e banco é pago em
  **toda** query; região errada é o gargalo mais bobo de se criar.

**3. Copiar a connection string.** No dashboard → *Connection Details*. Escolha o
formato de **URI** e o driver **psycopg**:

```
postgresql://usuario:senha@ep-nome-aleatorio-123456.us-west-2.aws.neon.tech/neondb?sslmode=require
```

`sslmode=require` faz parte da string - o Neon recusa conexão sem TLS.

**4. Rodar o schema.** No painel do Neon → **SQL Editor**. Abra
`server/app/db/schema.sql` localmente, copie o conteúdo inteiro, cole e execute.

Verificar que criou:

```sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
ORDER BY table_name;
```

Confira que as tabelas do schema apareceram (`usuarios`, `clientes`, `analises` e
as demais que o arquivo declara).

**5. Criar o primeiro usuário.** Não insira hash à mão: gere-o com o **mesmo**
`bcrypt` que a API usa para verificar, senão o login falha sem explicação. Com o
venv ativo:

```powershell
python -c "import bcrypt; print(bcrypt.hashpw(b'SUA-SENHA-FORTE', bcrypt.gensalt()).decode())"
```

Copie o `$2b$...` e, no SQL Editor (ajuste os nomes de coluna ao seu
`schema.sql`):

```sql
INSERT INTO usuarios (email, senha_hash, nome)
VALUES ('voce@exemplo.com', '$2b$12$COLE-O-HASH-AQUI', 'Seu Nome');
```

Verificar:

```sql
SELECT id, email, nome, criado_em FROM usuarios;
```

O teste real é fazer login pelo portal depois da seção 4. Se der 401, o hash foi
gerado por outra biblioteca ou a senha tem caractere que o PowerShell interpretou
- evite `$`, `` ` `` e `"` na senha de teste, ou use `'` simples como acima.

### Por que Neon e não Supabase

Aqui a escolha contraria o óbvio: o Supabase já estava funcionando na v1 e
oferece muito mais que banco. Trocamos por **um** motivo, e ele é operacional.

| | Supabase free | Neon free |
|---|---|---|
| Ociosidade | **pausa o projeto após 7 dias** sem atividade | **hiberna o compute em ~5 min** |
| Retomada | **manual**, pelo painel: alguém tem de clicar em *Restore* | **automática**, em ~0,5 s na primeira query |
| Falha típica | projeto pausado às 8h da manhã do dia da banca | primeira query 0,5 s mais lenta |

A diferença não é de tempo, é de **natureza**: hibernação que acorda sozinha é
latência; pausa que exige clique humano é **indisponibilidade**. E ela chega
exatamente no pior momento - depois de um fim de semana, ou depois das duas
semanas em que você esteve concentrado no motor e não abriu o portal.

O modelo do Neon é separar **storage** de **compute**. O storage nunca dorme; o
compute suspende quando não há conexão e é reprovisionado quando chega uma. Você
não gerencia isso e não pode esquecer de fazê-lo.

O que se perde ao sair do Supabase: Auth, Storage, Realtime e as políticas de
RLS. Como a v2 passou a ter API própria - com JWT próprio e autorização em
código - , esses recursos já não estavam sendo usados. Estávamos pagando o risco
de pausa por um serviço do qual só se usava o Postgres.

> Contrapartida honesta: com o compute hibernado, a **primeira** query depois de
> um período parado leva ~0,5 s a mais. Somada ao cold start do Render (seção 4),
> a primeira interação do dia é perceptivelmente mais lenta. Aquecer a API antes
> da apresentação resolve as duas de uma vez - e está no checklist da seção 9.

---

## 4. Publicar a API do plano de DADOS no Render

Este é o serviço que precisa estar **sempre alcançável**: login, clientes,
análises salvas, upload e leitura determinística. A inferência **não** vem para
cá - fica no notebook, por causa da GPU.

### Passos

**1.** <https://render.com> → *Sign up*, de preferência com GitHub (autoriza o
acesso ao repositório de uma vez).

**2.** *New* → **Web Service** → *Build and deploy from a Git repository* →
selecione `ALLocator-v2`.

**3.** Configuração:

| Campo | Valor |
|---|---|
| **Name** | `allocator-api` |
| **Region** | a mesma do Neon |
| **Branch** | `main` |
| **Root Directory** | `server` |
| **Runtime** | Python 3 |
| **Build Command** | `pip install -r requirements.txt` |
| **Start Command** | `uvicorn app.main:app --host 0.0.0.0 --port $PORT` |
| **Instance Type** | Free |

Dois pontos que quebram o deploy se passarem batido:

- **Root Directory = `server`.** Sem isso o Render procura `requirements.txt` na
  raiz do repositório e não encontra. Com isso, todos os caminhos de build e start
  são relativos a `server/`, e é por isso que o comando é
  `pip install -r requirements.txt`, **sem** o prefixo `server/`.
- **`--port $PORT`, nunca um número fixo.** O Render injeta a porta em `$PORT` e
  roteia só para ela. Um `--port 8123` cravado aqui resulta em serviço que sobe,
  loga normalmente e responde 502 em toda requisição.

**4. Variáveis de ambiente.** *Environment* → *Add Environment Variable*. Copie os
valores do seu `server/.env` - **sem** subir o arquivo:

| Variável | Valor |
|---|---|
| `DATABASE_URL` | a connection string do Neon (seção 3) |
| `JWT_SECRET` | o mesmo do `.env` local |
| `ALLOCATOR_API_TOKEN` | o mesmo do `.env` local |
| `ALLOWED_ORIGINS` | `https://SEU-USUARIO.github.io` |
| `MAX_UPLOAD_MB` | `25` |
| `PYTHON_VERSION` | `3.11.9` (ou a versão que você validou) |

**Não** defina `GEMINI_API_KEY` nem `GROQ_API_KEY` aqui: este serviço é o plano de
**dados**. Sem chave, `cloud._chave()` levanta `ErroProvedor` e nada é enviado,
que é o comportamento desejado. Também não defina `OLLAMA_URL`: não há Ollama no
Render.

`PYTHON_VERSION` é explícita de propósito. Sem ela o Render escolhe o default do
momento, e uma mudança silenciosa de minor version pode quebrar wheel de
`psycopg[binary]` ou `pypdfium2` num deploy que você não pediu - que é a mesma
razão pela qual `requirements.txt` tem versões pinadas exatas.

**5.** *Create Web Service*. O primeiro build leva de 3 a 8 minutos,
`pypdfium2` traz o binário do PDFium (~10 MB) e `psycopg[binary]` também tem
wheel grande.

### Verificar

Acompanhe *Logs* no painel. O sinal de sucesso é:

```
Uvicorn running on http://0.0.0.0:10000
==> Your service is live 🎉
```

Depois, de fora:

```powershell
Invoke-RestMethod https://allocator-api.onrender.com/health | ConvertTo-Json -Depth 5
```

E a documentação interativa, útil para exercitar o login antes de o portal
existir:

```
https://allocator-api.onrender.com/docs
```

Se falhar, veja *Logs* → *Deploy logs*. Os três erros mais comuns:

| Erro no log | Causa |
|---|---|
| `Could not open requirements file` | *Root Directory* não é `server` |
| `no such option: --host` / serviço sobe e dá 502 | *Start Command* sem `--port $PORT` |
| `connection to server ... failed` | `DATABASE_URL` errada, ou faltando `?sslmode=require` |

### O cold start de ~50 s, e por que é aceitável

No plano free, o Render **suspende** o serviço após ~15 minutos sem requisição. A
requisição seguinte espera o contêiner subir: cerca de **50 segundos**, às vezes
mais no primeiro do dia.

Isso é tolerável aqui porque as operações do plano de dados são **pequenas e
pontuais**: autenticar, listar clientes, gravar uma análise. São dezenas de
kilobytes e milissegundos de CPU. Pagar 50 s uma vez ao acordar, e nada nas
seguintes, é um preço razoável - e há mitigação trivial: **acessar o `/health`
uns dois minutos antes de precisar** (está no checklist da seção 9).

O que **não** seria tolerável é rodar inferência aqui. A instância free não tem
GPU: `qwen2.5:7b` em CPU compartilhada, com 512 MB de RAM, não carrega - e mesmo
que carregasse, levaria minutos por documento. A separação de planos não é
elegância arquitetural, é a única configuração que funciona:

```
operação de DADO       pequena, frequente, precisa estar sempre no ar   -> Render free
operação de INFERÊNCIA grande, intermitente, precisa de GPU             -> notebook + tunnel
```

E o corolário, que é o argumento de robustez: **se o notebook estiver desligado,
o portal continua lendo e salvando análises.** Só o botão de IA fica
indisponível.

---

## 5. Publicar o portal no GitHub Pages

### 5.1 `vite.config.js`: `base: './'` e HashRouter

Duas configurações, dois problemas distintos. Sem elas o portal publica e abre
uma página branca - sem erro visível, só 404 no console.

**Problema 1: o subcaminho.** O Pages de projeto serve em
`https://SEU-USUARIO.github.io/ALLocator-v2/`, não na raiz do domínio. O padrão do
Vite é `base: '/'`, que gera `<script src="/assets/index-abc123.js">` - caminho
**absoluto**, que o navegador resolve como
`https://SEU-USUARIO.github.io/assets/index-abc123.js`, ignorando
`/ALLocator-v2/`. Resultado: 404 em todos os assets, tela branca.

`base: './'` gera caminho **relativo** (`./assets/index-abc123.js`), que resolve
corretamente **em qualquer subcaminho** - e, de bônus, funciona também se você
abrir o `dist/index.html` direto do disco ou publicar em outro host.

```javascript
// portal/vite.config.js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],

  // Caminhos RELATIVOS nos assets. Sem isto o Pages de projeto serve em
  // /ALLocator-v2/ e o bundle pede /assets/... na raiz do domínio -> 404.
  base: './',

  build: {
    outDir: 'dist',
    // Sem sourcemap: o repositório é público e o mapa expõe o fonte original.
    sourcemap: false,
  },

  server: { port: 5173 },
})
```

**Problema 2: o recarregamento.** Com `BrowserRouter`, a rota `/analise/42` é uma
**URL de servidor**. Ao recarregar a página, o navegador pede
`/ALLocator-v2/analise/42` ao GitHub Pages, que procura um arquivo nesse caminho,
não encontra e devolve **404**. Funciona ao navegar por links (o React Router
intercepta o clique) e quebra ao apertar F5 - o tipo de falha que só aparece na
frente de outra pessoa.

O Pages é hospedagem **estática**: não há como configurar "sirva `index.html`
para qualquer rota". A solução robusta é `HashRouter`, que põe a rota **depois do
`#`**:

```
BrowserRouter -> /ALLocator-v2/analise/42        pedido ao servidor -> 404
HashRouter    -> /ALLocator-v2/#/analise/42      servidor vê só /ALLocator-v2/ -> OK
```

O que vem depois do `#` **nunca é enviado ao servidor** - é fragmento, tratado
inteiramente no cliente. Recarregar, colar link, usar o botão voltar: tudo
funciona.

```jsx
// portal/src/main.jsx
import { HashRouter } from 'react-router-dom'

// HashRouter, não BrowserRouter: o GitHub Pages é estático e devolve 404 em
// qualquer caminho que não seja arquivo. Com o `#`, o servidor só vê a raiz.
root.render(
  <HashRouter>
    <App />
  </HashRouter>
)
```

> Existe o truque de copiar `index.html` para `404.html` e deixar o Pages servir a
> SPA pela página de erro. Funciona, mas devolve **HTTP 404** no primeiro byte,
> ruim para cache e um detalhe estranho de se explicar se alguém abrir o
> DevTools. O `#` é feio e correto; escolha o correto.

### 5.2 O workflow do GitHub Actions

Crie `.github/workflows/deploy.yml`. Ele descreve o que o GitHub deve fazer a cada
push: instalar Node, buildar o portal e publicar o resultado.

```yaml
name: Deploy do portal no GitHub Pages

on:
  push:
    branches: [main]
    # Só rebuilda se o portal mudou. Commit em docs/ ou server/ nao dispara
    # deploy - o portal e o servidor tem ciclos de vida independentes.
    paths:
      - 'portal/**'
      - '.github/workflows/deploy.yml'
  # Permite disparar a mao pela aba Actions (util para republicar sem commit).
  workflow_dispatch:

permissions:
  contents: read
  pages: write        # publicar no Pages
  id-token: write     # OIDC: prova a identidade do workflow para o Pages

# Um deploy por vez. Dois pushes seguidos nao brigam pelo Pages.
concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Node 20
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: portal/package-lock.json

      # `npm ci` e nao `npm install`: instala EXATAMENTE o package-lock.json e
      # falha se ele estiver dessincronizado do package.json. Build reproduzivel
      # e pre-requisito de leitura deterministica.
      - name: Instalar dependencias
        working-directory: portal
        run: npm ci

      - name: Testes do motor deterministico
        working-directory: portal
        run: npm test

      - name: Build
        working-directory: portal
        run: npm run build

      - name: Configurar Pages
        uses: actions/configure-pages@v5

      - name: Upload do artefato
        uses: actions/upload-pages-artifact@v3
        with:
          path: portal/dist

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - name: Publicar
        id: deployment
        uses: actions/deploy-pages@v4
```

O que cada parte faz:

| Bloco | Papel |
|---|---|
| `on.push.paths` | filtro: só roda se algo em `portal/**` mudou. Editar este documento não dispara deploy. |
| `workflow_dispatch` | botão *Run workflow* na aba Actions, para republicar sem commit vazio |
| `permissions.pages: write` | sem isto, `deploy-pages` falha com "Resource not accessible by integration" |
| `permissions.id-token: write` | `deploy-pages@v4` autentica por OIDC; sem o token, erro de credencial |
| `concurrency` | serializa deploys; `cancel-in-progress` descarta o build obsoleto |
| `cache: 'npm'` | cacheia `~/.npm` pela hash do lockfile: build de ~2 min cai para ~40 s |
| `npm ci` | instalação exata a partir do lockfile |
| `npm test` | **trava de segurança**: se o motor determinístico quebrar, o deploy não acontece |
| dois jobs (`build`/`deploy`) | é o modelo exigido pelo Pages via Actions: `build` produz artefato, `deploy` publica |

> A separação em dois jobs não é estilo. `actions/deploy-pages` só publica um
> artefato produzido por `actions/upload-pages-artifact`, e o job de deploy tem de
> declarar `environment: github-pages` para receber a permissão de publicação.

Suba:

```powershell
git add .github/workflows/deploy.yml portal/vite.config.js
git commit -m "deploy: workflow do GitHub Pages e base relativa no Vite"
git push
```

### 5.3 Ligar o Pages

**Este passo é manual e não tem substituto.** O workflow pode estar perfeito e
falhar até que você o faça.

No GitHub: repositório → **Settings** → **Pages** (menu lateral) → em **Build and
deployment**, campo **Source**, troque de *Deploy from a branch* para
**GitHub Actions**.

Não há botão de salvar - a mudança vale ao selecionar. Se ficar em *Deploy from a
branch*, o `deploy-pages` falha com "Get Pages site failed" ou publica o conteúdo
da branch em vez do build.

### 5.4 Acompanhar o build e ler o erro

Aba **Actions** do repositório. A execução mais recente está no topo:

| Ícone | Estado |
|---|---|
| amarelo girando | rodando |
| verde | publicado |
| vermelho | falhou |

Clique na execução → job `build` → expanda o passo vermelho. A mensagem útil está
nas últimas ~20 linhas, não no começo. Onde olhar por sintoma:

| Falha em | Erro típico | Correção |
|---|---|---|
| `Instalar dependencias` | `npm ci can only install with an existing package-lock.json` | o lockfile não foi commitado - rode `npm install` local e commite `portal/package-lock.json` |
| `Instalar dependencias` | `npm ci` acusa lockfile desatualizado | `package.json` mudou sem regerar o lock: `npm install` local, commite o lock |
| `Testes` | asserção do motor | **isto é o workflow funcionando.** Corrija o código, não remova o passo |
| `Build` | `Could not resolve "./algo"` | import com caminho ou caixa errada. Windows é *case-insensitive*, o Ubuntu do CI **não**: `Card.jsx` importado como `card.jsx` passa local e falha no CI |
| `Publicar` | `Resource not accessible by integration` | falta `permissions: pages: write` / `id-token: write` |
| `Publicar` | `Get Pages site failed` | Source ainda em *Deploy from a branch* (seção 5.3) |

Deu verde: o endereço aparece no job `deploy`, como

```
https://SEU-USUARIO.github.io/ALLocator-v2/
```

A primeira publicação pode levar de 1 a 2 minutos a mais para propagar. Se abrir
branco, force recarga sem cache (`Ctrl+Shift+R`) antes de investigar.

---

## 6. Configurar as URLs em runtime

### O arquivo

`portal/public/runtime-config.json`:

```json
{
  "apiDados": "https://allocator-api.onrender.com",
  "apiInferencia": "https://algo-aleatorio-quatro-palavras.trycloudflare.com",
  "versao": "2.0.0"
}
```

Tudo em `portal/public/` é copiado **verbatim** para `dist/` pelo Vite - sem
passar por bundling, sem hash no nome, sem inline. É o que permite editar o
arquivo publicado e ter efeito imediato.

O portal o lê no boot, com caminho relativo:

```javascript
const cfg = await fetch('./runtime-config.json', { cache: 'no-store' })
  .then(r => r.json())
  .catch(() => ({}))   // sem o arquivo, cai no modo deterministico local
```

Três detalhes que importam:

- **`./runtime-config.json`**, relativo - mesma razão do `base: './'`.
- **`cache: 'no-store'`**, senão o navegador serve a versão anterior do cache e
  você troca o hostname sem efeito visível, o que é péssimo de diagnosticar.
- **`.catch()`** devolvendo objeto vazio: falta de arquivo ou JSON malformado
  degrada para o modo determinístico local, não para tela branca.

### Precedência

```
campo nas Configurações do portal (localStorage)   <- ganha
runtime-config.json publicado                       <- padrão
nada                                                <- modo deterministico local
```

O campo nas Configurações vence porque é o caminho de correção **mais rápido**: um
campo de texto, um clique em salvar, zero deploy. `localStorage` é por navegador e
por origem, então ajustar na sua máquina não afeta ninguém - e há um botão de
limpar para voltar ao valor do arquivo.

### Por que isto é melhor que `VITE_API_URL`

Com `VITE_API_URL`, o Vite faz **substituição em tempo de build**: o valor é
literalmente escrito no bundle minificado. A string deixa de ser configuração e
passa a ser código compilado.

Enquanto a URL é estável, tanto faz. O problema é que **a URL do plano de
inferência não é estável**: o Cloudflare Tunnel gratuito gera hostname aleatório
`*.trycloudflare.com` a cada reinício do processo - fechou o terminal, caiu o
Wi-Fi, reiniciou a máquina, hostname novo (seção 8 de
<ref_file file="docs/09-runbook-notebook.md" />).

Compare o custo de trocar uma string:

| | Com `VITE_API_URL` (build) | Com `runtime-config.json` (runtime) |
|---|---|---|
| Passos | editar env → `npm run build` → commit → push → esperar Actions → esperar propagação do Pages | editar o campo nas Configurações |
| Tempo | 2 a 5 minutos | ~5 segundos |
| Precisa de rede/CI? | sim, GitHub Actions | não |
| Dá para fazer com a banca esperando? | não | sim |

Cinco minutos de espera não são um inconveniente numa apresentação: são a
diferença entre "um segundo, deixe-me ajustar" e um deploy travado em fila. E o
cenário não é hipotético - é o comportamento **normal** do tunnel gratuito.

Migrar para o caminho B (tunnel nomeado, hostname fixo) elimina a instabilidade,
mas a configuração em runtime segue sendo o desenho certo: a URL da API é
**operação**, não **código**. `apiDados` também se beneficia - trocar o Render por
outro host é editar uma linha.

### Atualizar depois de publicado

O caminho lento (permanente, para todo mundo):

```powershell
# editar portal/public/runtime-config.json
git add portal/public/runtime-config.json
git commit -m "config: atualiza hostname do tunnel de inferencia"
git push
```

O caminho rápido (imediato, só para o seu navegador): portal → **Configurações**
→ colar a URL no campo da API de inferência → salvar.

Verificar, com o hostname atual:

```powershell
Invoke-RestMethod https://SEU-HOSTNAME/health | ConvertTo-Json -Depth 5
```

---

## 7. Migrar os dados do Supabase

Pule esta seção se não houver histórico a preservar. Se houver, o trabalho é
**renomear colunas**, e o v2 é mais rígido na entrada do que o v1 era.

### 7.1 Exportar

No painel do Supabase → **Table Editor** → tabela → menu de exportação →
**Export as CSV**. Faça uma tabela por vez: `clientes` e `analises`.

Também é possível pelo **SQL Editor**, que dá controle sobre a ordem e sobre o
JSON aninhado:

```sql
SELECT * FROM clientes ORDER BY created_at;
```

Use o botão de *download* do resultado. Verifique **antes de importar** que a
contagem de linhas do CSV bate com a da tabela.

### 7.2 Mapear as colunas que mudaram

O v2 renomeou campos para português, alinhado ao resto do código:

| v1 (Supabase) | v2 (Neon) | Observação |
|---|---|---|
| `rows` | `linhas` | as linhas lidas do documento |
| `anos` | `periodos` | "ano" era impreciso: balancete tem período (mês, trimestre), não ano |
| `is_balancete` | `saldos_absolutos` | **mudança de significado, não só de nome** - ver abaixo |
| `user_id` | `usuario_id` | FK para `usuarios` |

**`is_balancete` → `saldos_absolutos` merece atenção.** Não é tradução: é
correção de conceito, e ela vem de
<ref_file file="knowledge/regras-de-sinal.md" />. Na v1, `isBalancete` acionava
`valor * sinalGrupo(grupo)`, com `-1` para todo Passivo/PL - o que pressupõe que
toda conta de um grupo tem a natureza normal daquele grupo. No balancete real,
**24 contas têm natureza contrária ao próprio grupo**, e ignorar isso inflava o
Ativo em R$ 26.534.262,98 e o Passivo em R$ 124.618.951,48. Multiplicar o grupo
por `-1` **não** resolve, porque o erro é intra-grupo.

O que o v2 sinaliza é outra coisa: *"este relatório traz todos os valores
positivos, com a natureza numa coluna D/C ao lado de cada coluna de valor"*,
típico de Protheus `CTBR040` e SAP. A natureza passa a ser lida da **linha**,
nunca derivada do grupo.

Consequência prática: `is_balancete = true` na v1 corresponde, na maioria dos
casos, a `saldos_absolutos = true` no v2 - mas **confira caso a caso**. Se o
documento original já trazia valores assinados, o correto é `false`, e copiar o
`true` cegamente reintroduz na v2 exatamente o bug que o v2 corrigiu.

Exemplo de `SELECT` de exportação já com os nomes novos, para evitar renomear
depois:

```sql
SELECT
  id,
  user_id      AS usuario_id,
  rows         AS linhas,
  anos         AS periodos,
  is_balancete AS saldos_absolutos,
  created_at   AS criado_em
FROM analises
ORDER BY created_at;
```

### 7.3 Importar no Neon

Para poucas linhas, o mais simples é gerar `INSERT` e colar no SQL Editor.

Para volume maior, use `\copy` do `psql` - ele lê o arquivo no **cliente**, o que
o torna a única variante viável contra um Postgres gerenciado (o `COPY` do
servidor precisaria do arquivo no disco do servidor, ao qual você não tem acesso):

```powershell
psql "postgresql://usuario:senha@ep-xxxx.us-west-2.aws.neon.tech/neondb?sslmode=require" `
  -c "\copy clientes (nome, cnpj, usuario_id, criado_em) FROM 'clientes.csv' WITH (FORMAT csv, HEADER true)"
```

Importe **`usuarios` primeiro, depois `clientes`, depois `analises`**: as FKs
exigem essa ordem. Verifique:

```sql
SELECT 'usuarios' AS tabela, count(*) FROM usuarios
UNION ALL SELECT 'clientes', count(*) FROM clientes
UNION ALL SELECT 'analises', count(*) FROM analises;
```

E confirme que não sobrou FK órfã:

```sql
SELECT count(*) AS analises_orfas
FROM analises a
LEFT JOIN usuarios u ON u.id = a.usuario_id
WHERE u.id IS NULL;
```

Esperado: `0`.

### 7.4 As regras de dicionário aprendidas na v1: audite antes de importar

**Este é o ponto mais importante da migração, e o mais fácil de subestimar.**

Se a v1 acumulou regras de dicionário aprendidas com o uso, **parte delas aponta
para destinos com grafia inválida**. Não é hipótese - está medido em
<ref_file file="knowledge/auditoria-dicionario.md" /> e em
<ref_file file="docs/02-invariante-contabil.md" />: **229 das 1.285 regras
(17,8%) apontavam para destinos que não existiam com aquela grafia no template**.

Na v1 isso era invisível e caro. A agregação usava `Map.get()` com chave montada
só com `trim()`, então `Mútuo Financeiro L/P` não encontrava
`Mútuo Financeiro LP`, o valor virava `0` e **desaparecia sem gerar erro** - o QA
localizava a conta por comparação normalizada e concluía que estava tudo bem.
Como `Mútuo Financeiro L/P` (97 ocorrências) e `Bancos L/P` (41) são contas de
Passivo Não Circulante, o lado direito perdia valor sistematicamente. Daí o
sintoma permanente da v1: `Ativo > Passivo + PL`.

**O v2 rejeita essas regras na entrada** - `destino-invalido` é Classe A,
bloqueante (condição C da seção 3 de
<ref_file file="docs/02-invariante-contabil.md" />). O que era perda silenciosa
passa a ser erro explícito.

Então importar as regras cruas produz um destes dois resultados, e nenhum é bom:
regras rejeitadas em bloco na primeira análise, ou centenas de mensagens de
Classe A de uma vez, sem separar "grafia velha, corrigível automaticamente" de
"destino de fato errado".

**Audite antes.** Rode a auditoria de dicionário sobre as regras exportadas e
resolva no arquivo, não em produção:

```powershell
python scripts/audit-dicionario.py --entrada dicionario-v1-exportado.csv --saida auditoria.md
```

> Se o script ainda não existir com esse nome, a lógica de auditoria e correção de
> grafia está em `scripts/bootstrap_knowledge.py`, que gerou
> `knowledge/auditoria-dicionario.md` e é reexecutável. `scripts/gen_knowledge.py`
> valida a integridade e **aborta o build (exit 1)** se algum destino do CSV não
> resolver para uma conta alocável - o que faz dele a rede de segurança final.

O que a auditoria classifica, e o que fazer com cada classe:

| Situação | Ação |
|---|---|
| destino exato no template | importar |
| grafia corrigível por regra explícita (ex.: `L/P` → `LP`) | corrigir e importar |
| resolvida por nome único | importar com o nome canônico |
| **ambígua** (nome existe em 2 grupos) | **decidir à mão** - importar é escolher um grupo no escuro |
| **destino inexistente** | **descartar ou remapear** |
| **destino é subtotal** | **descartar** - subtotal é `kind:"calc"`, não tem bucket: o valor evaporaria (condição B) |
| duplicata | remover |

A auditoria da v1 fechou com **1.260 regras** boas de 1.285: 1.054 exatas, 225
corrigidas por regra de grafia, 4 resolvidas por nome único, e **zero** ambíguas,
inexistentes ou apontando para subtotal. Vale repetir o processo com o que a v1
aprendeu desde então.

Verifique depois de importar:

```powershell
python scripts/gen_knowledge.py --check
```

`--check` valida sem escrever. Ele confere as quatro travas de build: contagem
(79 alocáveis, 28 subtotais), grafia byte a byte contra o lock, cobertura das
folhas no grafo de fórmulas, e integridade do dicionário. Se sair `0`, o
dicionário importado está consistente com o template.

---

## 8. Conviver com o portal antigo

### As duas opções

**(a) Repositório novo, v1 intocada.** `ALLocator-v2` é um repositório
independente, com seu próprio Pages. O portal v1 continua exatamente onde está,
no ar, no mesmo endereço.

**(b) Mesmo repositório, v1 arquivada numa pasta.** Move-se a v1 para `v1/`,
adiciona-se a v2, e o workflow publica a v2 na raiz.

### Recomendação: (a), e o motivo é risco

**Risco zero de derrubar o que funciona.** É a única razão que importa, e é
suficiente.

Na opção (b), colocar a v2 no mesmo repositório significa mexer no repositório que
hospeda o portal **que está funcionando hoje**. E as coisas que dão errado nesse
caminho dão errado exatamente no lugar mais caro:

| Passo da opção (b) | O que pode dar errado |
|---|---|
| trocar o **Source** do Pages para GitHub Actions | a publicação anterior (branch/`docs`) **para de ser servida na hora**, antes de a v2 existir. Janela de indisponibilidade real |
| mudar a estrutura de pastas | o build da v1 quebra; os caminhos do workflow antigo não valem mais |
| um workflow para duas apps | filtro de `paths` errado publica a app errada - e você descobre pelo endereço público |
| histórico de commits | as duas linhas de desenvolvimento se misturam; `git bisect` na v1 fica inútil |
| rollback | reverter o commit **e** reverter a configuração do Pages, sob pressão |

Na opção (a), nada disso existe porque **nada da v1 é tocado**. Você constrói,
publica e testa a v2 num endereço novo, com a v1 no ar em paralelo. Se a v2 tiver
problema no dia, o endereço da v1 continua funcionando - não porque você
"reverteu", mas porque nunca foi alterado.

O custo de (a) é duplicar arquivos que talvez fossem compartilhados. É um custo de
disco. O custo de (b) é a possibilidade de estar com dois portais fora do ar às
19h do dia da banca. Não são grandezas comparáveis.

### Endereços em paralelo

```
v1:  https://SEU-USUARIO.github.io/allocator/          <- intocado, no ar
v2:  https://SEU-USUARIO.github.io/ALLocator-v2/       <- novo
```

Quando a v2 estiver validada, arquive a v1 (**Settings** → *Archive this
repository*) - o Pages continua servindo repositório arquivado. Faça isso
**depois** da banca, nunca antes.

---

## 9. Verificação final

Na ordem. Não marque um item sem executar a verificação.

**1. Repositório não contém segredo nem dado de cliente.**

```powershell
git ls-files | Select-String "\.env$|node_modules|\.venv|\.xlsx$"
```

Não deve retornar nada.

**2. Actions verde.** Aba **Actions** → execução mais recente com ícone verde nos
dois jobs (`build` e `deploy`).

**3. Portal abre.** `https://SEU-USUARIO.github.io/ALLocator-v2/` - a UI carrega,
sem tela branca. Se estiver branca: `F12` → *Console*. 404 em `/assets/...` é
`base: './'` faltando (seção 5.1).

**4. Recarregar numa rota interna não dá 404.** Navegue para dentro do app, confirme
que a URL tem `#` (ex.: `.../ALLocator-v2/#/clientes`) e aperte `Ctrl+Shift+R`. Se
der 404, ainda há `BrowserRouter` (seção 5.1).

**5. API de dados no ar** (a primeira chamada leva ~50 s se o Render estiver
suspenso - é o cold start, não erro):

```powershell
Invoke-RestMethod https://allocator-api.onrender.com/health | ConvertTo-Json -Depth 5
```

**6. Login funciona.** Entre com o usuário criado na seção 3. Sucesso prova três
coisas de uma vez: a API alcança o Neon, o schema está aplicado, e o hash de senha
foi gerado com o bcrypt certo.

**7. Sem erro de CORS.** Com o portal aberto, `F12` → *Console*. Nenhuma linha com
`blocked by CORS policy`. Se houver, `ALLOWED_ORIGINS` no Render precisa conter
exatamente `https://SEU-USUARIO.github.io` (sem caminho, sem barra final) - e a
API precisa ser reiniciada, porque a lista é lida na inicialização.

**8. Persistência de verdade.** Crie um cliente, salve uma análise, **recarregue a
página** e confirme que continuam lá. Sem o recarregamento, você só testou o
estado em memória do React.

**9. Config em runtime está sendo lida.**

```powershell
Invoke-RestMethod https://SEU-USUARIO.github.io/ALLocator-v2/runtime-config.json
```

Tem de devolver o JSON com `apiDados` e `apiInferencia`. Se der 404, o arquivo não
está em `portal/public/`.

**10. Plano de inferência (só se o notebook estiver ligado).** Siga o checklist da
seção 9 de <ref_file file="docs/09-runbook-notebook.md" />, e depois:

```powershell
Invoke-RestMethod https://SEU-HOSTNAME-DO-TUNNEL/health | ConvertTo-Json -Depth 5
```

No portal, a tela de diagnóstico deve mostrar Ollama ativo e a escada de texto com
os dois degraus instalados.

**11. Documento de ponta a ponta.** Processe um balancete de teste com a IA
**ligada** e confirme: leitura fecha as sintéticas, sugestões passam pelos
guardrails, trilha de valor sem perda não classificada, identidade fechando
(simples, ou estendida com o resíduo explicado como resultado do período), export
saindo.

**12. Documento de ponta a ponta com a IA DESLIGADA.** Repita com o notebook
desligado - ou com o modo determinístico ativado no portal. **Tem de funcionar.**
Este é o teste que valida a tese do projeto e a separação de planos: sem LLM
nenhum, o sistema lê, aplica o dicionário, roda as verificações de Classe A e
fecha o balanço.

**13. Ensaie o rollback.** Uma vez, com calma, antes do dia. Seção 10.

---

## 10. Rollback: voltar à v1 em menos de 5 minutos

A premissa que torna isso possível é a decisão da seção 8: **a v1 nunca foi
tocada.** Não há nada a reverter - só um endereço a usar.

### Se você seguiu a recomendação (repositório novo)

**Rollback total: abrir o endereço da v1.**

```
https://SEU-USUARIO.github.io/allocator/
```

Tempo: o de digitar a URL. Nenhum comando, nenhum deploy, nenhuma configuração.
Mantenha o endereço da v1 **aberto numa aba em segundo plano** durante a
apresentação - se algo falhar, você troca de aba.

### Falhas parciais: quase nunca é preciso rollback

Antes de voltar para a v1, veja se o problema não tem correção de segundos:

| Sintoma | Correção | Tempo |
|---|---|---|
| Botão de IA indisponível | **nada a fazer.** Siga no modo determinístico: leitura, dicionário, Classe A e fechamento não dependem de LLM | 0 s |
| Hostname do tunnel mudou | portal → **Configurações** → colar a URL nova → salvar | ~10 s |
| API de dados lenta na primeira chamada | é o cold start do Render (~50 s). Espere | ~50 s |
| Primeira chamada de IA lenta | é o carregamento do modelo (~20 s). Espere, e aqueça antes na próxima vez | ~20 s |
| Portal branco depois de um deploy | `Ctrl+Shift+R` (cache). Persistindo, reverta o deploy abaixo | ~30 s |

A primeira linha é a mais importante e a mais fácil de esquecer sob pressão: **IA
fora do ar não é falha do sistema.** É o modo degradado previsto, e demonstrá-lo
funcionando é um argumento a favor da arquitetura, não uma desculpa.

### Reverter o último deploy do portal

Se um commit quebrou o portal v2 e você quer a versão anterior de volta:

```powershell
git revert --no-edit HEAD
git push
```

O workflow roda de novo e republica o estado anterior. Leva de 1 a 2 minutos,
consulte a aba **Actions**.

Alternativa sem commit: **Actions** → escolha a última execução **verde** →
*Re-run all jobs*. Republica aquele build, sem tocar no histórico.

### Se você usou a opção (b), mesmo repositório

Aqui o rollback é mais lento, e é exatamente o custo antecipado na seção 8:
reverter o commit **e** restaurar **Settings** → **Pages** → **Source** para
*Deploy from a branch*, apontando para a branch da v1. São dois sistemas
diferentes, com propagação própria - de 5 a 10 minutos, feitos à mão, sob
pressão. Mais uma razão para a opção (a).

### Prepare antes, não durante

Deixe isto pronto na véspera:

1. **Aba da v1 aberta** no navegador, em segundo plano.
2. **Aba de `/health` do Render** aberta - mostra na hora se a API está viva.
3. **Hostname do tunnel anotado** em texto, colável.
4. **Um balancete de teste** já validado de ponta a ponta, nas duas modalidades
   (com IA e sem IA).
5. **O rollback ensaiado** pelo menos uma vez.

---

## Referências

| Assunto | Onde |
|---|---|
| Subir o plano de inferência no notebook | <ref_file file="docs/09-runbook-notebook.md" /> |
| Por que o fechamento não depende do LLM | <ref_file file="docs/02-invariante-contabil.md" /> |
| `is_balancete` → `saldos_absolutos`, natureza por linha | <ref_file file="knowledge/regras-de-sinal.md" /> |
| Os 229 destinos inválidos da v1 | <ref_file file="knowledge/auditoria-dicionario.md" /> |
| Validações que abortam o build | `scripts/gen_knowledge.py` |
| Auditoria e correção de grafia do dicionário | `scripts/bootstrap_knowledge.py` |
| Motor determinístico (roda no navegador) | `portal/src/core/` |
| Dependências pinadas do servidor | <ref_file file="server/requirements.txt" /> |
