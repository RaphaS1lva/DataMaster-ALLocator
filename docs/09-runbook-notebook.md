# Runbook do notebook servidor - plano de inferência

> Procedimento operacional para deixar o **plano de inferência** de pé no notebook
> pessoal (Windows). Público: o autor do projeto, executando passo a passo.
>
> Hardware alvo confirmado: **i7-13650HX · 32 GB RAM · RTX 4050 Laptop com
> 6.141 MB de VRAM** (GDDR6, Max-Q Gen 5). Todo dimensionamento deste documento
> parte desse orçamento de 6 GB.

---

## 1. O que roda aqui e o que não roda

A arquitetura tem **dois planos separados de propósito**, e a separação é a
decisão que este documento operacionaliza:

```
GitHub Pages (portal React estático, público)
    │
    ├── plano de DADOS       ──> FastAPI no Render (free) ──> Neon Postgres
    │                            sempre alcançável
    │
    └── plano de INFERÊNCIA  ──> FastAPI NESTE notebook ──> Ollama (GPU local)
                                 (Cloudflare Tunnel)        fallback Gemini/Groq
                                                            e, por fim, modo
                                                            100% determinístico
```

| Componente | Onde roda | Este notebook precisa estar ligado? |
|---|---|---|
| Portal React (UI) | GitHub Pages | **não** |
| Login, clientes, análises salvas | Render + Neon | **não** |
| Upload e leitura determinística de PDF | Render (plano de dados) | **não** |
| Motor de invariante, QA, Shadow, export | navegador do usuário (`portal/src/core`) | **não** |
| Julgamento semântico por LLM (Ollama) | **aqui**, na RTX 4050 | **sim** |
| Leitura de PDF escaneado (modelos de visão) | **aqui** | **sim** |
| Embeddings do pré-filtro | **aqui** | **sim** |
| Fallback Gemini / Groq | nuvem, disparado por **este** processo | sim (é este processo que chama) |

**Deixe isto explícito para você mesmo:** se o notebook estiver desligado, o
portal continua **lendo e salvando análises normalmente**. Só o botão de IA fica
indisponível. Não existe caminho em que a indisponibilidade deste notebook
derrube o portal.

E o motivo pelo qual isso é aceitável está em <ref_file file="docs/02-invariante-contabil.md" />:
o fechamento `Ativo = Passivo + PL` é **consequência do código determinístico**,
não do julgamento do modelo. O teste `★ INVARIANTE` gera 15 mapeamentos
diferentes do balancete real, sorteando outra conta dentro do mesmo bloco, e os
15 fecham em `0,00`. O LLM melhora a **utilidade** do resultado; ele não é
requisito da **correção aritmética**. Por isso existe um modo 100%
determinístico que funciona sem LLM nenhum.

### Por que separar os planos

Dado precisa estar **sempre** disponível: perder acesso ao histórico de análises
de um cliente é uma falha de produto. Inferência é **intermitente e pesada**:
exige GPU, carrega 4,7 GB de peso na VRAM e responde em segundos, não em
milissegundos. Colocar as duas coisas na mesma máquina significa aceitar o pior
dos dois mundos - ou paga-se GPU em nuvem para servir `SELECT`, ou aceita-se que
o histórico caia quando o notebook dorme.

---

## 2. Instalar o Ollama

### Instalação

Baixe e execute o instalador do Windows:

```
https://ollama.com/download/OllamaSetup.exe
```

O instalador registra o Ollama como aplicação de usuário e o sobe
automaticamente no login (ícone na bandeja). Não requer privilégio de
administrador.

### Verificar que instalou

```powershell
ollama --version
```

Se `ollama` não for reconhecido, feche e reabra o PowerShell - o instalador
altera o `PATH` e a sessão aberta não vê a mudança.

### Verificar que o daemon está respondendo

```powershell
curl http://127.0.0.1:11434/api/tags
```

Esperado: um JSON com `{"models":[...]}`. Logo após a instalação a lista vem
**vazia**, e isso está certo - nenhum modelo foi baixado ainda. O que importa
aqui é receber JSON em vez de erro de conexão.

Se preferir a forma nativa do PowerShell (mais legível):

```powershell
Invoke-RestMethod http://127.0.0.1:11434/api/tags | ConvertTo-Json -Depth 4
```

> `/api/tags` é exatamente a rota que o projeto usa como sonda de
> disponibilidade, em `ClienteOllama.esta_disponivel()`
> (<ref_file file="server/app/llm/ollama.py" />), com timeout de 2 s. Se ela não
> responde em 2 s, a cascata considera o Ollama fora e cai para a nuvem.

### Confirmar que a GPU foi detectada

Isto é o passo que as pessoas pulam e depois reclamam de lentidão. O Ollama roda
em CPU sem avisar, e a diferença é de uma ordem de magnitude.

Primeiro, confirme que o driver enxerga a placa e quanta VRAM ela tem:

```powershell
nvidia-smi --query-gpu=name,memory.total,memory.used,driver_version --format=csv
```

Esperado: `NVIDIA GeForce RTX 4050 Laptop GPU, 6141 MiB, ...`. Os **6141 MiB**
são o número que governa todas as escolhas de modelo da seção 3.

Agora, **durante uma geração**, veja onde o modelo foi colocado. Abra dois
terminais. No primeiro, dispare algo que leve alguns segundos:

```powershell
ollama run qwen2.5:7b-instruct-q4_K_M "explique em tres frases o que e um balancete contabil"
```

No segundo, enquanto aquilo roda:

```powershell
ollama ps
```

A coluna que interessa é **`PROCESSOR`**:

| O que aparece | Significado |
|---|---|
| `100% GPU` | correto - o modelo inteiro está na VRAM |
| `73%/27% CPU/GPU` | offload parcial: parte do peso foi para a RAM, vai ficar lento |
| `100% CPU` | a GPU não foi usada. Driver desatualizado ou CUDA não detectado |

Se aparecer `100% CPU`, atualize o driver NVIDIA e reinicie o Ollama antes de
seguir. Rodar `qwen2.5:7b` em CPU funciona, mas leva minutos por documento em vez
de segundos - inviável para demonstração.

---

## 3. Baixar os modelos - o orçamento de VRAM explicado

A escada de modelos está declarada em `MODELOS`, em
<ref_file file="server/app/llm/router.py" />. Ela é percorrida do mais capaz para
o mais leve, e só cai para a nuvem se nada local responder.

### O orçamento

São **6.141 MB de VRAM**, e o peso do modelo não é a única coisa que mora lá. O
**KV cache** também, e ele cresce com o contexto. O projeto usa
`NUM_CTX_PADRAO = 8192` (<ref_file file="server/app/llm/ollama.py" />), que é
descrito no próprio código como "o teto prático para 6 GB de VRAM sem estourar o
KV cache com o modelo 7B". Some ainda o que o Windows e o navegador já reservam
da placa.

Regra prática: **o peso do modelo tem de caber com folga de ~1 GB**, não
exatamente.

| Papel | Modelo | Tamanho | Cabe na VRAM? |
|---|---|---:|---|
| julgamento primário | `qwen2.5:7b-instruct-q4_K_M` | 4,7 GB | **sim** - sobra para o KV cache de 8k |
| julgamento rápido | `qwen2.5:3b-instruct-q4_K_M` | ~2 GB | **sim**, com folga grande |
| visão primária | `qwen2.5vl:3b` | ~3,2 GB | **sim** - cabe com o projetor de imagem |
| visão qualidade | `qwen2.5vl:7b` | 6,0 GB | **não inteiro** - offload parcial para CPU, bem mais lento |
| visão reserva | `granite3.3-vision:2b` | ~2,4 GB | **sim**, e é feito para tabelas |
| embeddings | `nomic-embed-text` | 274 MB | **sim** |

### Comandos

Um por vez. Cada um mostra barra de progresso própria e é retomável - se cair a
rede, rode de novo e ele continua de onde parou.

```powershell
ollama pull qwen2.5:7b-instruct-q4_K_M
```

```powershell
ollama pull qwen2.5:3b-instruct-q4_K_M
```

```powershell
ollama pull qwen2.5vl:3b
```

```powershell
ollama pull qwen2.5vl:7b
```

```powershell
ollama pull granite3.3-vision:2b
```

```powershell
ollama pull nomic-embed-text
```

> **Aviso de download: o total é ~19 GB.** Faça isto em rede boa e com
> antecedência, nunca no dia da apresentação. Os modelos ficam em
> `%USERPROFILE%\.ollama\models` e não são reinstalados a cada boot.

Se o disco estiver apertado e for preciso escolher, o mínimo funcional é
`qwen2.5:7b-instruct-q4_K_M` + `nomic-embed-text` (~5 GB): cobre o caminho normal
inteiro, porque **PDF com camada de texto nem chega no modelo de visão**.

### Verificar que baixou

```powershell
ollama list
```

Confirme que as seis linhas aparecem com o nome **exato** da tabela. O nome
importa: `router.status()` compara o que `/api/tags` devolve contra as chaves de
`MODELOS` byte a byte (com uma normalização de `:latest`). Um modelo baixado com
tag diferente aparece como "não instalado" no `/health` mesmo estando no disco.

### Por que a visão primária é o 3b e não o 7b

Contraria o óbvio - o 7b é claramente melhor em ler tabela de balancete - e a
razão é aritmética, não preferência:

**6,0 GB de peso não cabem em 6.141 MB junto com o KV cache.** O Ollama não
recusa: ele faz *offload* das camadas excedentes para a RAM do sistema e passa a
alternar entre VRAM e RAM pelo barramento PCIe a cada token. O resultado é um
modelo que responde, com qualidade melhor, e **muito** mais lento - em página
escaneada densa a diferença sai da casa dos segundos para a casa dos minutos.

Então a escada faz o seguinte: `qwen2.5vl:3b` primeiro (cabe inteiro, resposta
rápida); `qwen2.5vl:7b` como **fallback de qualidade**, aceitando a lentidão
apenas quando o 3b falhou; e `granite3.3-vision:2b` como último degrau local,
porque é treinado especificamente para documentos e tabelas e frequentemente
acerta um balancete tabular onde um modelo generalista se perde.

### E lembre-se: visão é a exceção, não a regra

Os modelos de visão só entram quando o PDF é **escaneado**, isto é, quando não
existe camada de texto para o `pdfplumber` extrair. O caminho normal é:

```
PDF com texto ──> pdfplumber.extract_words() ──> clusterização de colunas por X
                  ──> julgamento TEXTUAL (qwen2.5:7b) ──> guardrails ──> motor
```

Nesse caminho, `completar_visao()` **nunca é chamado**. Se você estiver com o
disco cheio ou com pouco tempo, é nos modelos de visão que se economiza - não no
de texto.

---

## 4. Variáveis de ambiente do Ollama

`setx` grava no registro do usuário e **persiste entre reinícios**. Sem `setx`,
definir a variável só vale para a sessão atual do PowerShell, e o Ollama - que
sobe pelo autostart, não pelo seu terminal - não a veria.

```powershell
setx OLLAMA_HOST "0.0.0.0"
setx OLLAMA_KEEP_ALIVE "30m"
setx OLLAMA_NUM_PARALLEL "1"
setx OLLAMA_FLASH_ATTENTION "1"
setx OLLAMA_MAX_LOADED_MODELS "1"
```

O que cada uma faz e por que este valor:

| Variável | Valor | Por quê |
|---|---|---|
| `OLLAMA_HOST` | `0.0.0.0` | Por padrão o Ollama escuta só em `127.0.0.1`. Como `0.0.0.0`, ele aceita conexão de qualquer interface - necessário se a API e o Ollama não estiverem no mesmo *loopback* (contêiner, WSL, outra máquina da rede). **Isto expõe a porta 11434 na rede local.** A proteção não vem do bind: vem do firewall do Windows (mantenha 11434 bloqueada para entrada externa) e do fato de que o que sai para a internet é o **tunnel**, apontando para a porta da API (8123), nunca para a do Ollama. |
| `OLLAMA_KEEP_ALIVE` | `30m` | O padrão é 5 minutos: passados 5 min sem uso, o modelo é descarregado da VRAM, e a próxima chamada paga **~20 s só de carregamento** dos 4,7 GB. Numa demonstração ao vivo, 20 s de tela parada é fatal. Com 30 min, o modelo fica residente durante toda a sessão. |
| `OLLAMA_NUM_PARALLEL` | `1` | Com 6 GB, duas requisições em paralelo dividem a VRAM e **as duas** ficam lentas - ou o Ollama reduz o contexto de cada uma para caber, o que pode truncar a resposta (e resposta truncada é `ErroProvedor` no cliente, não sucesso parcial: ver o tratamento de `done_reason == "length"` em `ollama.py`). Serializar é mais rápido no total e mais previsível. |
| `OLLAMA_FLASH_ATTENTION` | `1` | Atenção com uso reduzido de memória: diminui o footprint do KV cache, o que em 6 GB é exatamente o recurso escasso. Habilita contexto maior com o mesmo peso carregado. |
| `OLLAMA_MAX_LOADED_MODELS` | `1` | Impede o Ollama de manter dois modelos residentes ao mesmo tempo. Sem isso, uma chamada de visão logo após uma de texto tentaria carregar `qwen2.5vl:3b` (3,2 GB) sem descarregar `qwen2.5:7b` (4,7 GB) - 7,9 GB em 6 GB de VRAM, que termina em offload ou em out-of-memory. |

### Reinicie o Ollama

Variável de ambiente é lida **na inicialização do processo**. Nada acima tem
efeito até o daemon reiniciar.

```powershell
Get-Process ollama*, "ollama app" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
Start-Process "$env:LOCALAPPDATA\Programs\Ollama\ollama app.exe"
```

Se o caminho não existir, saia pelo ícone da bandeja e abra o Ollama pelo menu
Iniciar. Também é preciso **abrir um novo PowerShell**, porque a sessão atual não
recebe o que o `setx` gravou.

### Verificar que pegou

```powershell
[Environment]::GetEnvironmentVariable("OLLAMA_KEEP_ALIVE", "User")
curl http://127.0.0.1:11434/api/tags
```

A primeira linha tem de imprimir `30m`. A segunda tem de voltar a responder após
o reinício.

---

## 5. Instalar Python e as dependências do servidor

### Python

Instale **Python 3.11 ou superior** de <https://www.python.org/downloads/windows/>.
Marque **"Add python.exe to PATH"** no instalador. (O projeto já foi exercitado em
3.13; qualquer versão de 3.11 para cima serve.)

```powershell
python --version
```

Não use o atalho da Microsoft Store: ele instala num diretório com redirecionamento
de sistema de arquivos que atrapalha venv e caminhos longos.

### Ambiente virtual

A partir da **raiz do repositório**:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

Se o PowerShell recusar o script de ativação (`execution of scripts is
disabled`), libere para o usuário atual - isto não requer administrador:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

Com o venv ativo o prompt fica prefixado por `(.venv)`. Confirme que o Python em
uso é o do venv, não o global:

```powershell
python -c "import sys; print(sys.prefix)"
```

### Dependências

```powershell
python -m pip install --upgrade pip
pip install -r server/requirements.txt
```

As versões em <ref_file file="server/requirements.txt" /> são **pinadas exatas de
propósito**, e o próprio arquivo explica por quê: se o `pdfplumber` muda a
heurística de `extract_words` numa release menor, as coordenadas mudam, a
detecção de colunas por X muda com elas - silenciosamente - e a leitura
determinística deixa de ser determinística. Não troque `==` por `>=` para
"resolver" um conflito.

Verificar que as três libs que mais importam entraram:

```powershell
pip show fastapi pdfplumber psycopg | Select-String "^Name|^Version"
```

Esperado: `fastapi 0.141.1`, `pdfplumber 0.11.10`, `psycopg 3.3.4`.

### Rodar a suíte

```powershell
python -X utf8 server/run_tests.py
```

`-X utf8` força UTF-8 na saída. Sem ele, o console do Windows em code page 1252
levanta `UnicodeEncodeError` ao imprimir os símbolos `✔ ✖ ○` e as acentuações das
mensagens de teste - o teste passa, o relatório quebra.

A primeira linha da saída diz qual runner está em uso:

```
pytest real: sim
```

<ref_file file="server/run_tests.py" /> funciona **com ou sem pytest instalado**.
A máquina de desenvolvimento do projeto está atrás de proxy corporativo que
bloqueia o PyPI, então lá `pip install pytest` falha; para não perder justamente
os testes mais críticos (clusterização de colunas, parsing de número, guardrails
anti-injeção, adaptador de balancete), o arquivo injeta em `sys.modules` um
**shim de stdlib** com a fatia da API do pytest que o projeto usa - `fixture`,
`mark.parametrize`, `raises`, `approx`, `skip`, `monkeypatch`.

Neste notebook o PyPI funciona, então instale o pytest real e ganhe o relatório
completo:

```powershell
pip install pytest
python -X utf8 server/run_tests.py -v
```

A mensagem passa a ser `pytest real: sim` e o shim nem é criado. Se aparecer
`pytest real: NÃO - usando shim stdlib`, não é erro: é o modo degradado
funcionando. O que **é** erro é qualquer linha vermelha no resumo final.

---

## 6. Configurar o `.env` do servidor

Crie `server/.env`. Se existir `server/.env.example`, copie-o como base:

```powershell
Copy-Item server\.env.example server\.env
```

### Gerar os segredos

Nunca invente segredo à mão nem reutilize senha. Rode duas vezes - um valor
diferente para cada variável:

```powershell
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

### Todas as variáveis

| Variável | Obrigatória | O que é |
|---|---|---|
| `DATABASE_URL` | sim (plano de dados) | Connection string do Neon, no formato `psycopg`: `postgresql://usuario:senha@ep-xxxx.sa-east-1.aws.neon.tech/neondb?sslmode=require`. O `sslmode=require` não é opcional - o Neon recusa conexão sem TLS. Ver seção 3 de <ref_file file="docs/10-deploy-github-pages.md" />. |
| `JWT_SECRET` | sim | Chave de assinatura dos tokens de sessão emitidos pela API (o v2 tem auth própria, não usa mais Supabase Auth). Trocar este valor invalida todas as sessões ativas de uma vez - que é exatamente o procedimento se você suspeitar de vazamento. |
| `ALLOCATOR_API_TOKEN` | sim | Segredo compartilhado que o portal envia ao chamar o **plano de inferência**. Sem ele, quem descobrir o hostname do tunnel usa a sua GPU de graça. Use um valor **diferente** do `JWT_SECRET`: papéis distintos, rotação independente. |
| `ALLOWED_ORIGINS` | sim | Origens autorizadas no CORS, separadas por vírgula. Tem de conter a origem do GitHub Pages **e** a de desenvolvimento local: `https://SEU-USUARIO.github.io,http://localhost:5173`. É só a **origem** - esquema + host + porta, sem caminho e sem barra final. Causa nº 1 de "não funciona no Pages e funciona local". |
| `OLLAMA_URL` | não | Endereço do Ollama. O padrão do código é `http://127.0.0.1:11434` (`URL_PADRAO` em <ref_file file="server/app/llm/ollama.py" />). Mantenha o **loopback** aqui mesmo tendo posto `OLLAMA_HOST=0.0.0.0`: a API fala com o Ollama dentro da própria máquina, e apontar para o IP da LAN só adiciona um caminho de rede que pode falhar. |
| `GEMINI_API_KEY` | não | Fallback de nuvem, 1º degrau depois do local. Ausência **não** é erro: `cloud._chave()` levanta `ErroProvedor` com a mensagem "rodando somente local" e a cascata segue. Deixe **vazia** se você quer garantir que nenhum dado saia da máquina (ver seção 11). |
| `GROQ_API_KEY` | não | Fallback de nuvem, último degrau. Só texto - a cascata pula o Groq em requisição de visão, registrando `decisao="pulado_sem_visao"` no trace. |
| `MAX_UPLOAD_MB` | recomendada | Teto do tamanho de upload. Segura tanto acidente (arrastar o PDF errado) quanto abuso: sem limite, um arquivo grande vira consumo de RAM no processo do uvicorn. Algo entre `20` e `50` cobre balancete de ERP com folga. |

Opcionais, lidos em <ref_file file="server/app/llm/cloud.py" /> se você quiser
fixar outro modelo de nuvem: `GEMINI_MODEL` (padrão `gemini-2.5-flash`) e
`GROQ_MODEL` (padrão `llama-3.3-70b-versatile`).

### Modelo de `server/.env`

```ini
# --- plano de dados ---
DATABASE_URL=postgresql://usuario:senha@ep-xxxx.sa-east-1.aws.neon.tech/neondb?sslmode=require

# --- segredos (gerados com secrets.token_urlsafe(48), um DIFERENTE para cada) ---
JWT_SECRET=cole-aqui-o-primeiro-valor-gerado
ALLOCATOR_API_TOKEN=cole-aqui-o-segundo-valor-gerado

# --- CORS: origem do GitHub Pages + desenvolvimento local ---
ALLOWED_ORIGINS=https://SEU-USUARIO.github.io,http://localhost:5173

# --- plano de inferência ---
OLLAMA_URL=http://127.0.0.1:11434

# --- fallback de nuvem (deixe vazio para modo estritamente local) ---
GEMINI_API_KEY=
GROQ_API_KEY=

# --- limites ---
MAX_UPLOAD_MB=25
```

> **NUNCA commite o `.env`.** Ele contém a senha do banco e as chaves de API.
> Confirme que o `.gitignore` da raiz tem a linha `.env` **antes** do primeiro
> `git add` - ver seção 2 de <ref_file file="docs/10-deploy-github-pages.md" />.
> Se um segredo já foi para o histórico do Git, remover o arquivo num commit
> seguinte **não resolve**: o valor continua recuperável. O procedimento correto
> é rotacionar o segredo no provedor.
>
> Verificação rápida antes de commitar:
>
> ```powershell
> git status --short
> git check-ignore -v server\.env
> ```
>
> A primeira não deve listar o `.env`; a segunda deve responder qual regra o
> está ignorando.

---

## 7. Subir a API

A partir da pasta `server/` - e não da raiz, porque `app.main:app` é resolvido
relativo ao diretório de trabalho:

```powershell
cd server
uvicorn app.main:app --host 0.0.0.0 --port 8123
```

Para desenvolvimento, com recarga automática a cada alteração de arquivo:

```powershell
uvicorn app.main:app --host 0.0.0.0 --port 8123 --reload
```

Não use `--reload` no dia da apresentação: o watcher reinicia o processo ao menor
toque em arquivo, e reiniciar a API descarta o estado do disjuntor
(`resetar_disjuntores`) e o trace acumulado.

`--host 0.0.0.0` é necessário para o `cloudflared` alcançar o processo de forma
confiável. `--port 8123` é a porta adotada no projeto para não colidir com o
5173 do Vite nem com o 8000 de outras ferramentas.

### Verificar

Deixe o uvicorn rodando e, **em outro terminal**:

```powershell
Invoke-RestMethod http://127.0.0.1:8123/health | ConvertTo-Json -Depth 5
```

O `/health` é a página de diagnóstico do plano de inferência: expõe o retorno de
`router.status()` (<ref_file file="server/app/llm/router.py" />), que consulta o
Ollama de verdade em vez de assumir. Confira quatro coisas:

| Campo | Esperado | Se estiver diferente |
|---|---|---|
| `ollama.ativo` | `true` | o daemon não está de pé, ou `OLLAMA_URL` está errada |
| `ollama.modelos_instalados` | as 6 tags da seção 3 | falta `ollama pull`, ou a tag baixada tem nome diferente |
| `escada.texto[].instalado` | `true` nos dois degraus | mesma causa acima |
| `nuvem.gemini.configurado` | `true` só se você pôs a chave | `false` é o esperado em modo estritamente local |
| `disjuntores` | `{}` vazio | há modelo em cooldown: 3 falhas consecutivas abrem o disjuntor por 120 s |

E a documentação interativa, que é a forma mais rápida de exercitar uma rota sem
escrever cliente:

```
http://127.0.0.1:8123/docs
```

---

## 8. Expor com Cloudflare Tunnel

O notebook está atrás de NAT doméstico, sem IP público e sem porta encaminhada. O
tunnel resolve isso **sem abrir porta no roteador**: o `cloudflared` abre uma
conexão de dentro para fora até a borda da Cloudflare, e o tráfego de entrada
volta por ela.

### Instalar

```powershell
winget install --id Cloudflare.cloudflared
```

Abra um **novo** PowerShell (o `PATH` mudou) e verifique:

```powershell
cloudflared --version
```

---

### Caminho A - tunnel rápido, sem conta

Um comando, zero configuração. É o modo de teste.

```powershell
cloudflared tunnel --url http://localhost:8123
```

Na saída aparece um bloco emoldurado com o hostname público:

```
+--------------------------------------------------------------------------------------------+
|  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
|  https://algo-aleatorio-quatro-palavras.trycloudflare.com                                  |
+--------------------------------------------------------------------------------------------+
```

Verifique de fora, trocando pelo seu hostname:

```powershell
Invoke-RestMethod https://SEU-HOSTNAME.trycloudflare.com/health | ConvertTo-Json -Depth 5
```

Se responder o mesmo JSON de `/health` que você viu no `127.0.0.1`, o caminho
público está fechado ponta a ponta.

#### As três limitações, e leia esta parte com atenção

1. **O hostname MUDA a cada reinício do `cloudflared`.** Não é configurável no
   modo rápido. Fechou o terminal, caiu a conexão, reiniciou a máquina: hostname
   novo.
2. **Limite de ~200 requisições concorrentes.** Suficiente para uso individual e
   para uma banca; não é hospedagem.
3. **Não suporta SSE** (*Server-Sent Events*). Streaming de resposta token a
   token por SSE não passa. Como o projeto chama o Ollama com `stream: false`
   (<ref_file file="server/app/llm/ollama.py" />) e devolve a resposta completa,
   isto não bloqueia nada hoje - mas registre a restrição antes de "melhorar" a
   UI com streaming.

**É a limitação nº 1 que determinou uma decisão de arquitetura do portal.** A URL
da API **não** é embutida na build: é lida em **runtime** de
`portal/public/runtime-config.json`, e existe um campo nas Configurações do
portal que sobrepõe o arquivo (salvo em `localStorage`). Se a URL estivesse
compilada na build - via `VITE_API_URL` - , cada reinício do tunnel exigiria
`npm run build` + commit + workflow do GitHub Actions + propagação do Pages, algo
entre 2 e 5 minutos, para mudar uma string. Com config em runtime, é editar um
campo na tela. Detalhes na seção 6 de
<ref_file file="docs/10-deploy-github-pages.md" />.

---

### Caminho B - tunnel nomeado, hostname fixo (recomendado)

Exige um domínio hospedado na Cloudflare (os nameservers do domínio apontando
para lá). Em troca, o hostname **nunca muda** e o tunnel sobe como serviço do
Windows, junto com a máquina.

**1. Autenticar.** Abre o navegador para você escolher a zona:

```powershell
cloudflared tunnel login
```

Isso grava o certificado em `%USERPROFILE%\.cloudflared\cert.pem`.

**2. Criar o tunnel.** Gera um UUID e o arquivo de credenciais:

```powershell
cloudflared tunnel create allocator
```

**3. Mapear o hostname.** Cria o registro DNS `CNAME` apontando para o tunnel:

```powershell
cloudflared tunnel route dns allocator allocator.seudominio.com
```

**4. Escrever a configuração.** Crie `%USERPROFILE%\.cloudflared\config.yml`:

```yaml
tunnel: allocator
credentials-file: C:\Users\SEU-USUARIO\.cloudflared\UUID-DO-TUNNEL.json
ingress:
  - hostname: allocator.seudominio.com
    service: http://localhost:8123
  - service: http_status:404
```

O `UUID-DO-TUNNEL` é o que o passo 2 imprimiu; o arquivo `.json` está na mesma
pasta. A última regra sem `hostname` é obrigatória: é o *catch-all*, e o
`cloudflared` recusa a configuração sem ela.

**5. Rodar em primeiro plano** para validar antes de virar serviço:

```powershell
cloudflared tunnel run allocator
```

Verifique:

```powershell
Invoke-RestMethod https://allocator.seudominio.com/health | ConvertTo-Json -Depth 5
```

**6. Instalar como serviço do Windows.** Precisa de PowerShell **como
administrador**:

```powershell
cloudflared service install
```

Verificar que o serviço está registrado e rodando:

```powershell
Get-Service cloudflared | Select-Object Name, Status, StartType
```

Esperado: `Running` e `Automatic`. A partir daqui o tunnel sobe no boot, sem
terminal aberto. Para acompanhar:

```powershell
Get-Service cloudflared
Restart-Service cloudflared
```

> Atenção à ordem de dependência: o tunnel sobe no boot, mas a **API não**. Se o
> `cloudflared` estiver de pé e o uvicorn não, o hostname responde **502 Bad
> Gateway** - que é informação útil, não bug: significa "o caminho público está
> ok, o processo local é que não está".

#### Restringir quem acessa: Cloudflare Access

Por padrão o hostname do tunnel é **público** - qualquer um que descubra a URL
alcança a sua API, e o `ALLOCATOR_API_TOKEN` passa a ser a única barreira. Se
quiser uma camada antes disso, o **Cloudflare Access** (Zero Trust, gratuito até
50 usuários) põe autenticação na **borda**: a requisição só chega ao seu notebook
depois de passar por uma política - e-mail autorizado, código de uso único,
domínio permitido, provedor de identidade.

Configuração no painel Zero Trust → Access → Applications: nova aplicação
*self-hosted*, hostname `allocator.seudominio.com`, política *Allow* com o seu
e-mail. Vale para o caminho B; no caminho A não há hostname estável para
aplicar política.

Contrapartida: uma aplicação de Access protegida por login interativo bloqueia
chamada programática do portal, porque o navegador é redirecionado para a tela de
autenticação e o `fetch` recebe HTML em vez de JSON. Para uso pelo portal, use
*Service Auth* com token de serviço, ou deixe o Access para as rotas
administrativas e mantenha as rotas do portal protegidas pelo
`ALLOCATOR_API_TOKEN`.

---

## 9. Checklist do dia da apresentação

Na ordem. Cada item tem uma verificação objetiva - não avance sem ela.

**1. Energia e sono.** Notebook na tomada, e o sono desligado (ver seção 10):

```powershell
powercfg /change standby-timeout-ac 0
powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE | Select-String "Current AC Power Setting"
```

Esperado: `0x00000000`.

**2. Ollama de pé.**

```powershell
Invoke-RestMethod http://127.0.0.1:11434/api/tags | ForEach-Object { $_.models.name }
```

Esperado: as 6 tags da seção 3.

**3. Modelo já carregado na VRAM - a chamada de aquecimento.**

```powershell
$corpo = @{
  model      = "qwen2.5:7b-instruct-q4_K_M"
  messages   = @(@{ role = "user"; content = "responda apenas: ok" })
  stream     = $false
  keep_alive = "30m"
  options    = @{ temperature = 0; num_ctx = 8192 }
} | ConvertTo-Json -Depth 5

Measure-Command {
  Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:11434/api/chat" `
    -ContentType "application/json" -Body $corpo
} | Select-Object TotalSeconds
```

**Por que aquecer:** os 4,7 GB do modelo quantizado só entram na VRAM na
**primeira** requisição, e ler isso do disco leva cerca de 20 segundos. Se a
primeira requisição do dia for a que você faz na frente da banca, são 20 s de
tela parada que parecem travamento e não têm explicação visível na UI. Fazendo a
chamada de aquecimento antes, o custo é pago no seu tempo.

Verificação: esta chamada leva ~20 s. Rode o mesmo bloco **de novo** - a segunda
tem de voltar em menos de 2 s. Essa queda é a prova de que o modelo ficou
residente. Confirme:

```powershell
ollama ps
```

Esperado: `qwen2.5:7b-instruct-q4_K_M`, `PROCESSOR` = `100% GPU`, `UNTIL` ≈ 30
minutos à frente. **Se `UNTIL` disser "4 minutes from now", o
`OLLAMA_KEEP_ALIVE` não foi aplicado** - volte à seção 4 e reinicie o daemon.

**4. API respondendo.**

```powershell
cd server
uvicorn app.main:app --host 0.0.0.0 --port 8123
```

Em outro terminal:

```powershell
Invoke-RestMethod http://127.0.0.1:8123/health | ConvertTo-Json -Depth 5
```

**5. Tunnel ativo.** Caminho A:

```powershell
cloudflared tunnel --url http://localhost:8123
```

Caminho B - só confirmar o serviço:

```powershell
Get-Service cloudflared | Select-Object Status
```

**6. Anote o hostname e teste de fora.** Do celular na rede móvel, ou:

```powershell
Invoke-RestMethod https://SEU-HOSTNAME/health | ConvertTo-Json -Depth 5
```

Testar de fora, e não do próprio notebook, é o que distingue "a API funciona" de
"o caminho público funciona".

**7. Portal apontando para a URL certa.** Abra o portal no GitHub Pages, vá em
**Configurações** e confirme que o campo da API de inferência tem o hostname do
passo 6. Se mudou, cole o novo e salve - vale imediatamente, sem rebuild.

**8. `/health` mostrando os provedores.** No portal, abra a tela de diagnóstico e
confirme visualmente: Ollama ativo, escada de texto com os dois degraus
instalados, disjuntores vazios.

**9. Um documento de ponta a ponta.** Não é opcional. Processe um balancete de
teste - de preferência o `Balancete SPE (exemplo) 05.2026`, que é o caso de
referência do projeto - e confirme:

- a leitura fecha as verificações de sintéticas;
- o julgamento por LLM devolve sugestões e elas passam pelos guardrails;
- a trilha de valor fecha sem perda não classificada;
- a identidade fecha - pela **simples**, ou pela **estendida** com o resíduo
  explicado como resultado do período (o caso real: diferença `-689.138,41`
  idêntica à linha 35, resíduo `0,00`);
- o export sai.

**10. Deixe o modo determinístico pronto como plano B.** Saiba, antes de subir ao
palco, qual botão desliga a IA. Se o Wi-Fi do auditório cair, você segue a
demonstração inteira sem LLM - e essa é a tese do projeto, não uma desculpa:
o fechamento não depende do modelo.

---

## 10. Solução de problemas

| Sintoma | Causa | Correção |
|---|---|---|
| `model requires more system memory than is available` / geração morre no meio | VRAM insuficiente. Típico ao tentar `qwen2.5vl:7b` (6,0 GB) em 6.141 MB, ou dois modelos residentes. | Use o degrau menor (`qwen2.5:3b-instruct-q4_K_M`, `qwen2.5vl:3b`). **Feche o navegador** - Chrome/Edge com aceleração de hardware reservam centenas de MB de VRAM, e em 6 GB isso decide. Confirme `OLLAMA_MAX_LOADED_MODELS=1`. Cheque o que está ocupando: `nvidia-smi --query-compute-apps=pid,name,used_memory --format=csv`. |
| Primeira requisição leva ~20 s, as seguintes são rápidas | Não é bug: é o carregamento dos 4,7 GB do disco para a VRAM. | Chamada de **aquecimento** antes de usar (seção 9, passo 3) e `OLLAMA_KEEP_ALIVE=30m` para não repetir. Confirme com `ollama ps` que `UNTIL` está ~30 min à frente. |
| Requisição volta a ficar lenta depois de uma pausa | O modelo foi descarregado: `OLLAMA_KEEP_ALIVE` não foi aplicado (padrão de 5 min voltou a valer). | `[Environment]::GetEnvironmentVariable("OLLAMA_KEEP_ALIVE","User")` tem de dizer `30m`. Se disser, o daemon subiu antes do `setx`: reinicie o Ollama (seção 4). |
| Portal diz que a IA está indisponível, mas o Ollama está de pé | Tunnel caiu, ou - no caminho A - o hostname mudou no reinício e o portal aponta para o antigo. | Confirme o hostname atual na saída do `cloudflared`. Atualize `portal/public/runtime-config.json` ou, mais rápido, o campo nas **Configurações** do portal (tem prioridade, salva em `localStorage`, vale sem rebuild). Migre para o caminho B se isso repetir. |
| `502 Bad Gateway` no hostname do tunnel | O `cloudflared` está de pé e a API **não**. Clássico do caminho B, em que o tunnel é serviço e sobe no boot, mas o uvicorn não. | Suba o uvicorn. Confirme a porta: o `ingress` do `config.yml` e o `--port` do uvicorn têm de ser o mesmo número. |
| `has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header` | `ALLOWED_ORIGINS` não contém a origem do GitHub Pages. | Inclua **exatamente** `https://SEU-USUARIO.github.io` - só esquema + host, sem caminho de repositório e sem barra final. Vírgula separa múltiplas origens. Reinicie a API: a lista é lida na inicialização. Note que o portal em `https://` chamando API em `http://` também é bloqueado (*mixed content*) - o tunnel resolve isso por servir em `https://`. |
| Tudo funcionava e parou; o notebook estava sozinho | Windows suspendeu a máquina. Em suspensão não há processo, não há tunnel. | `powercfg /change standby-timeout-ac 0` (nunca dormir na tomada) e `powercfg /change monitor-timeout-ac 15` (tela pode apagar - isso não suspende nada). Verifique: `powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE`. Se a máquina dorme mesmo assim, procure "Sono moderno"/*Modern Standby* nas configurações do fabricante. |
| Wi-Fi caiu e voltou | O `cloudflared` **reconecta sozinho** - não precisa reiniciar. | No caminho B o hostname é o mesmo depois da reconexão e nada precisa ser feito. No caminho A, **se o processo morreu**, o hostname novo é outro: atualize o portal. Motivo adicional para preferir o caminho B. |
| `pip install` falha com `SSLError` / `SSL: CERTIFICATE_VERIFY_FAILED` | É a máquina **corporativa**, atrás de proxy que intercepta TLS e bloqueia o PyPI. | **Aqui não deve acontecer** - este notebook é pessoal, em rede doméstica. Se acontecer, você está na máquina errada, ou num VPN corporativo: desconecte a VPN e repita. É justamente por causa desse bloqueio que `run_tests.py` traz o shim de pytest e que `app/llm/__init__.py` tolera a ausência de `httpx` sem derrubar os guardrails. |
| `/health` mostra `disjuntores` com entradas abertas | 3 falhas consecutivas no mesmo modelo abriram o disjuntor por 120 s (`FALHAS_PARA_ABRIR`, `COOLDOWN_S` em `router.py`). | Não é o problema, é o sintoma. Leia o histórico de erros no trace - `router` concatena o motivo de **cada** tentativa. Causas usuais: modelo não baixado, VRAM, timeout. Corrija a causa; o cooldown expira sozinho e um sucesso zera o contador. |
| `resposta truncada por limite de tokens (done_reason=length)` | A resposta bateu no teto de contexto. | Isto é **proteção deliberada**, não falha a contornar: um JSON cortado ao meio com gramática ativa "parece" parcialmente válido, e uma sugestão perdida no caminho vira conta não alocada **sem aviso**. Reduza o lote de candidatos por chamada em vez de aumentar `num_ctx` - em 6 GB, contexto maior tira espaço do peso do modelo. |
| `UnicodeEncodeError: 'charmap' codec can't encode character` ao rodar os testes | Console do Windows em code page 1252 tentando imprimir `✔`/acento. | Sempre `python -X utf8 server/run_tests.py`. |
| `ollama` não é reconhecido como comando | `PATH` da sessão desatualizado depois da instalação. | Feche e reabra o PowerShell. Persistindo: `& "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe" --version`. |

---

## 11. Privacidade - o argumento mais forte da arquitetura

> **Com o Ollama local, o balanço do cliente NÃO SAI DA MÁQUINA.**

Não é otimização de custo. É a diferença entre um protótipo que se pode
apresentar num contexto de crédito bancário e um que não se pode.

**Como era na v1.** O julgamento semântico ia para quatro APIs em cascata,
Gemini, Groq, OpenRouter e correlatas - todas em **tier gratuito**. E o tier
gratuito dessas plataformas é gratuito por uma razão: os termos de uso permitem
**empregar o conteúdo enviado para treinar e melhorar os modelos**. O plano pago
dos mesmos provedores normalmente exclui isso; o gratuito, não.

Ou seja: cada balancete processado significava enviar razão social, estrutura de
capital, endividamento, prejuízos acumulados e composição de resultado de uma
empresa real para um terceiro, sob termos que autorizam retenção e uso para
treinamento. Num caso de uso de **análise de crédito bancário**, isso é
inaceitável por si só - antes de qualquer discussão sobre LGPD, sigilo bancário
ou política interna de classificação de informação.

**Como é na v2.** O caminho normal é `qwen2.5:7b-instruct-q4_K_M` rodando **nesta
GPU**. O dado do cliente vai do disco para a RAM, da RAM para a VRAM e volta como
sugestão de mapeamento. Não atravessa a internet. Não há terceiro. Não há termo
de uso a interpretar.

A nuvem continua no código, mas mudou de papel - de **caminho principal** para
**último recurso explícito**, e o próprio
<ref_file file="server/app/llm/cloud.py" /> registra isso na primeira linha:
*"usado APENAS quando o Ollama local não responde"*. Três propriedades sustentam
a afirmação:

1. **A ordem é fixa no código.** `_cascata()` esgota **toda** a escada local antes
   de considerar nuvem (<ref_file file="server/app/llm/router.py" />).
2. **Sem chave, não há saída.** `cloud._chave()` levanta `ErroProvedor` quando
   `GEMINI_API_KEY`/`GROQ_API_KEY` estão vazias. **Deixar as duas variáveis vazias
   no `.env` é uma garantia estrutural** de que nenhum byte de cliente sai da
   máquina - não é uma configuração de boa vontade, é impossibilidade.
3. **Se saiu, está registrado.** Cada ida à nuvem grava um evento
   `llm.roteamento` com `decisao="tentativa_nuvem"` e o provedor em
   `obs/trace.py`. A pergunta "este documento foi para a nuvem?" tem resposta
   auditável, com dado - não com suposição.

E há um terceiro estado, que é o que fecha o argumento: o **modo 100%
determinístico**. Sem Ollama, sem Gemini, sem Groq, o sistema ainda lê o
documento, aplica o dicionário, roda as verificações de Classe A e fecha o
balanço. O que se perde é a sugestão de mapeamento para conta nova - o resto,
incluindo o invariante, é código.

Para uma banca, a frase é curta: *o dado sensível nunca sai da máquina; quando
sai, foi por decisão explícita e ficou registrado; e o sistema fecha o balanço
mesmo sem nenhum modelo de linguagem.*

---

## Referências

| Assunto | Onde |
|---|---|
| Escada de modelos, disjuntor, cascata | <ref_file file="server/app/llm/router.py" /> |
| Cliente Ollama, `URL_PADRAO`, `NUM_CTX_PADRAO`, timeouts | <ref_file file="server/app/llm/ollama.py" /> |
| Fallback de nuvem e variáveis de chave | <ref_file file="server/app/llm/cloud.py" /> |
| Fronteira do que o LLM decide | <ref_file file="server/app/llm/__init__.py" /> |
| Dependências pinadas | <ref_file file="server/requirements.txt" /> |
| Executor de testes com e sem pytest | <ref_file file="server/run_tests.py" /> |
| Por que o fechamento não depende do LLM | <ref_file file="docs/02-invariante-contabil.md" /> |
| Deploy do portal e do plano de dados | <ref_file file="docs/10-deploy-github-pages.md" /> |
| Automação destes passos | `scripts/setup-notebook.ps1`, `scripts/start-servidor.ps1` |
