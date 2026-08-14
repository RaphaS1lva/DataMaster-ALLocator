# Roadmap: o que ficou pronto, o que ficou de fora, e por quê

Este documento é o inventário honesto do ALLocator v2. A parte (b) é a mais
importante: um projeto que só lista o que funciona não permite avaliar o risco de
usá-lo. Cada lacuna aqui tem a causa e o custo estimado de correção, em esforço
relativo, sem prazo.

## (a) O que ficou pronto

### Núcleo contábil - a tese, provada

| Entrega | Evidência |
|---|---|
| `Ativo = Passivo + PL` como **consequência**, não esperança | <ref_file file="docs/02-invariante-contabil.md" /> |
| imunidade a erro de julgamento | 15 mapeamentos aleatórios distintos, fechamento idêntico (`★ INVARIANTE`) |
| conservação de valor com perdas **nomeadas** | `trilhaDeValor`: órfão, subtotal, sem destino, lado trocado, `memoDre` |
| identidade estendida para balancete não encerrado | resíduo `0,00` no golden dataset; diferença de `-689.138,41` reconhecida como o resultado do período |
| natureza D/C **por linha**, nunca por grupo | 24 contas com natureza contrária ao grupo tratadas corretamente |
| hierarquia por **maior prefixo estrito** | 224 analíticas e 134 sintéticas no arquivo real |
| Classe A vs Classe B, com as quatro condições bloqueantes | `qa.js`; um erro do modelo não consegue gerar Classe A |
| cobertura das fórmulas provada em **build time** | `gen_knowledge.py --check`: as 56 posições de Ativo/Passivo, cada uma em exatamente um total |
| 6 posições da DRE fora da cadeia do resultado, identificadas e contabilizadas | `POSICOES_MEMO_DRE` (16, 17, 19 do add-back do EBITDA; 36, 39, 40 abaixo da linha) |

### Leitura determinística - zero token

| Entrega | Referência |
|---|---|
| colunas por clusterização das bordas direitas (`x1`) | <ref_file file="docs/03-leitura-documento.md" /> |
| traço isolado como célula vazia que **ocupa** a coluna | `tables.montar_linhas`, pré-semeando todas as chaves |
| descarte da coluna "Nota" por critério **estrutural** | `columns.descartar_coluna_nota` |
| ordem das visões vinda da posição x | `columns.mapear_cabecalho` |
| hierarquia por indentação para documento publicado | `tables.nivel_por_indentacao` |
| rótulo quebrado em duas linhas físicas | `tables.juntar_rotulos_quebrados` |
| adaptador de balancete de ERP com pares valor↔D/C **posicionais** | `reading/balancete.detectar_layout` |
| código como texto, preservando zeros à esquerda | `balancete._codigo_texto` |
| verificação de leitura: 134 sintéticas × 5 colunas, zero divergência | `balancete.verificar_sinteticas` |
| Docling descartado com motivo documentado | `pdf_words.py`, `requirements.txt` |

### Camada de LLM

| Entrega | Referência |
|---|---|
| redução do espaço de decisão de 79 para ~9-15 | `candidatosPara(grupo, sub)` + cadeia de contas-pai |
| escada de modelos dimensionada para 6.141 MB de VRAM | `router.MODELOS` |
| cascata Ollama → Gemini → Groq → modo determinístico | `router._cascata` |
| disjuntor por modelo (3 falhas, 120s), com tentativa pulada registrada | `router._disjuntor` |
| JSON Schema no sampling (gramática GBNF) | `schemas.json_schema_de` |
| truncamento como erro retentável nos três provedores | `done_reason`, `finishReason`, `finish_reason` |
| prompts versionados (`PROMPT_VERSION = "v3.0-local"`) com isolamento de canal | `llm/prompts.py` |
| privacidade: o balanço não sai da máquina | <ref_file file="docs/04-camada-llm.md" /> |

### Dados e memória

| Entrega | Referência |
|---|---|
| Neon em vez de Supabase (não pausa, acorda sozinho) | <ref_file file="docs/05-dados-persistencia.md" /> |
| API como única a falar com o banco; autorização no `WHERE` | `db/repo.py` |
| JWT próprio + bearer de serviço, senha em bcrypt | `app/auth.py` |
| `dm_normalize` equivalente às três outras implementações, **verificada com Node** | `test_normalize_parity.py` |
| memória do cliente com decisões **positivas e negativas**, versionada por revisão | `db/memoria.py`, `memoria_cliente` |
| opt-in com diff mostrado antes de gravar | `diff_memoria`, `memoria_revisoes` |
| dicionário global só recebe o confirmado por humano | `entradas_promoviveis` |
| modo local em `localStorage` com a mesma interface | `portal/src/lib/repo.js` |

### Segurança e verificação

| Entrega | Referência |
|---|---|
| seis camadas de guardrail, todas com custo zero em token | <ref_file file="docs/08-seguranca-guardrails.md" /> |
| gate contábil com **evidência aritmética** | `page_classifier.tem_subtotal_aritmetico` |
| suíte red-team: receita de bolo, âncoras injetadas, DFC/DMPL/DVA, PDF armado, executável renomeado, 11 padrões de injeção | `test_seguranca.py` |
| validação da resposta em 8 filtros, com canonicalização a partir do plano | `guardrails.validar_sugestoes` |
| CI com 5 jobs bloqueantes | `.github/workflows/ci.yml` |
| **60 testes no portal · 201 no servidor** | `node --test` · `run_tests.py` |
| runner que funciona com **ou sem** pytest, e CI que roda nos dois modos | `server/run_tests.py` |
| observabilidade com latência p50/p95, tokens e decisão de roteamento | <ref_file file="docs/07-observabilidade.md" /> |

---

## (b) O que ficou de fora, e por quê

### b.1 Bloqueado pelo ambiente de desenvolvimento

A máquina de desenvolvimento está atrás de um proxy corporativo que bloqueia o
**PyPI** (SSL handshake failure) e o **registry do npm**
(`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`). Isso não é uma desculpa genérica - tem
consequências específicas e verificáveis:

| Lacuna | Consequência | Mitigação que existe hoje |
|---|---|---|
| **`package-lock.json` não pôde ser gerado** | a instalação do front **não é reprodutível**. Uma release menor de uma dependência transitiva pode mudar o build sem que nada no repositório mude | o job `portal` do CI cai para `npm install`, avisa com `::warning::` e **publica o lockfile como artefato** para baixar e commitar. A partir daí `npm ci` passa a valer |
| **dependências do servidor não instaláveis localmente** | `pdfplumber`, `pypdfium2`, `httpx`, `pydantic`, `psycopg`, `bcrypt`, `PyJWT` só existem no notebook servidor e no CI | **imports lazy** em `pdf_words.py`, `ollama.httpx_lazy()`, `schemas.py` (stub que levanta no uso), `conexao._psycopg()`, `auth._bcrypt()`/`_pyjwt()`. Isso virou decisão de arquitetura: lógica pura sempre importável, I/O só quando usado |
| **pytest não instalável localmente** | os testes de lógica não rodariam na máquina onde o código é escrito | `run_tests.py` injeta um shim da API do pytest, e o CI roda nos **dois** modos para o shim não mascarar nada |
| **`npm run build` não roda localmente** | um caminho de import errado ou dependência esquecida só apareceria no deploy | `portal/test/imports.test.mjs` percorre todo `.js`/`.jsx`/`.mjs` de `portal/src`, extrai os imports e resolve cada um contra o disco e o `package.json` |

Vale registrar que as três primeiras mitigações **melhoraram** o projeto. A fronteira
"lógica pura importável / I/O confinado" é a arquitetura correta, e ela não teria sido
imposta com tanto rigor sem a restrição. A quarta é pura compensação.

### b.2 Não implementado

| Lacuna | Estado real | Por que ficou de fora |
|---|---|---|
| **rotas `/dados/*`** | `main.py` faz `from .db.rotas import router as router_dados` num `try/except ImportError` e o módulo `server/app/db/rotas.py` **não existe**; a API loga `"rotas de dados indisponíveis - API roda só a inferência"`. `repo.py`, `memoria.py`, `auth.py` e `schema.sql` estão prontos e testados | o esforço foi concentrado na tese (invariante, leitura, guardrails). A camada HTTP é a parte mais mecânica e a menos original |
| **modo de visão com PDF escaneado real** | o caminho existe ponta a ponta - `paginas_com_texto` detecta, `renderizar_pagina` rasteriza, `completar_visao` roteia pela escada `qwen2.5vl:3b → 7b → granite3.3-vision:2b` - mas **não foi exercitado com um documento escaneado de verdade** | não havia um balancete escaneado real disponível para transcrever como golden dataset. É a lacuna mais desconfortável da lista, porque é o único caminho em que o LLM tocaria em número |
| **rate limit por usuário** | só existe `MAX_JOBS_SIMULTANEOS = 4`, **global** | exige a camada de identidade das rotas de dados funcionando primeiro |
| **persistência do trace** | `deque(maxlen=500)` em memória; restart apaga | a tabela `eventos` já existe e é append-only, então a lacuna é de fiação, não de modelo de dados |
| **tracing distribuído** | três processos (portal, Render, notebook) sem `trace_id` propagado | uma leitura lenta não pode ser atribuída a uma perna específica |
| **painel histórico** | `/usage` devolve o estado do processo atual, sem série temporal nem comparação entre versões de prompt | depende da persistência do trace |
| **matching semântico por embedding em produção** | `nomic-embed-text` está declarado em `router.MODELOS`, `ClienteOllama.embeddings()` e `router.embutir()` estão implementados e testados na cascata - mas **nada no fluxo de julgamento os chama** | ver b.3 |
| **extração de palavras sem pré-filtro de página** | `MAX_PAGINAS = 400` já é aplicado em `avaliar_arquivo`, mas dentro do limite TODA página passa pela extração completa de coordenadas. Num DFP de 300 páginas, ~290 são descartadas pelo gate depois de já terem custado CPU | falta um pré-passe de texto barato (`pypdfium2` cru, sem caixas) para localizar a região das demonstrações e só então extrair coordenadas. O limite de 120 original mascarava isso ao recusar o documento inteiro |
| **`main.exigir_token` não é fail-closed** | tem implementação própria que **libera a rota** quando `ALLOCATOR_API_TOKEN` está ausente, em vez de usar `auth.conferir_token_api()`, que é fail-closed por design | inconsistência real entre dois módulos que resolvem o mesmo problema. É o item de maior risco/menor custo da lista |
| **`server/eval/run_eval.py` não roda no CI** | nenhum job o invoca. As propriedades que ele mede estão cobertas indiretamente pelas suítes, mas os `LIMIARES` nomeados e as métricas de contraprova ficam fora do gate | o harness foi escrito depois dos jobs e não foi fiado |
| **`recall_contas` e `acuracia_valores_posicional` declarados e não consumidos** | os dois limiares existem em `LIMIARES` mas nenhuma `Metrica` os usa; `conservacao_perda_centavos` também não. A crítica metodológica ao `any(...)` da v1 está registrada e a métrica correta está **nomeada**, mas o cálculo posicional linha a linha depende de um dataset com gabarito de mapeamento, que não existe | falta o dataset, não o código |
| **`cadeiaPais` vs `cadeia_pais`** | o portal envia `cadeiaPais` (`Analise.jsx`); `prompts._linha_formatada` lê `linha.get('cadeia_pais')`. Na prática o campo sai sempre como `(raiz)` no prompt | bug de nomenclatura entre as duas pontas. O prompt continua funcionando (o modelo ainda recebe código, nome e bloco), mas **perde justamente o contexto que a regra 2 do prompt de sistema manda usar** |
| **testes próprios de `trace.py`** | exercitado indiretamente pelos testes de disjuntor; `_percentil` com amostra de 0 e 1 elemento não tem teste dedicado | escopo |
| **fila offline com reenvio** | existe modo local em `localStorage` e tolerância a falha de rede no polling de `/read` (`MAX_FALHAS_SEGUIDAS = 8`), mas uma **escrita** que falha por servidor fora do ar não é enfileirada para reenvio | o modo local cobre o cenário de demonstração; a fila cobriria o de conectividade intermitente, que não foi exercitado |
| **revisão de dependências** | versões pinadas exatas e publicadas há 7+ dias, mas sem `pip-audit`, `npm audit` ou Dependabot no CI | uma CVE em `pdfplumber` ou `pillow` passaria sem sinal |
| **auditoria de acesso a leitura** | `eventos` registra escrita, não leitura | "quem abriu a análise do cliente X" não é respondível |
| **criptografia em repouso** | apenas a do provedor; `analises.linhas` guarda o balanço integral em `jsonb` claro | fora do escopo escolhido |
| **gestão de segredo** | `JWT_SECRET`, `ALLOCATOR_API_TOKEN`, chaves de nuvem e `DATABASE_URL` em variável de ambiente, sem cofre e sem rotação | infraestrutura padrão, deliberadamente adiada |

### b.3 Sobre o embedding, com precisão

Vale separar porque é fácil sobrevender. O que existe:

- `nomic-embed-text` declarado em `router.MODELOS["embedding"]`, com `vram_gb: 0.3`;
- `ClienteOllama.embeddings(modelo, textos)` chamando `POST /api/embed`;
- `router.embutir(textos)` com disjuntor e trace, e **sem fallback de nuvem** por
  decisão explícita (trocar de modelo mudaria o espaço vetorial e invalidaria
  qualquer índice);
- a docstring que declara o papel pretendido: *"embeddings do pré-filtro
  determinístico (não decide nada sozinho)"*.

O que **não** existe: nenhuma chamada a `embutir()` no fluxo de julgamento. Hoje o
matching é exato-normalizado - memória do cliente, depois dicionário, depois LLM.
Contas com nome parecido mas não idêntico (`APL.CDB ITAU EMPRESA AG.9999A` vs
`APLICACAO CDB ITAU`) não são aproximadas por similaridade; caem no julgamental.

A frase honesta é: **a infraestrutura de embedding está pronta e a integração ao
fluxo de julgamento é o próximo passo.** Não "o sistema usa busca semântica".

---

## (c) Próximos passos, priorizados por valor

Esforço relativo: **baixo** (uma sessão), **médio** (vários dias de trabalho
focado), **alto** (frente de trabalho própria).

### Prioridade 1 - corrige defeito conhecido

| # | Item | Valor | Esforço |
|---|---|---|---|
| 1 | **`main.exigir_token` usar `auth.conferir_token_api`** | fecha a porta que a v1 deixou aberta. Hoje uma implantação sem `ALLOCATOR_API_TOKEN` reproduz exatamente o problema da v1: API de inferência pública. É o pior risco da lista e a correção é de uma linha | **baixo** |
| 2 | **corrigir `cadeiaPais` / `cadeia_pais`** | a cadeia de contas-pai é o campo que "mais reduz erro" segundo o próprio comentário de `prompts.py`, e a regra 2 do prompt de sistema depende dele. Hoje o modelo julga sem esse contexto | **baixo** |
| 3 | **pré-filtro de página antes da extração de coordenadas** | `MAX_PAGINAS` já é aplicado, mas um DFP de 300 páginas gasta CPU em ~290 que o gate descarta. Um pré-passe de texto cru localizaria a região das demonstrações primeiro | **médio** |
| 4 | **commitar o `package-lock.json`** publicado pelo CI | torna o build do front reprodutível. Depende apenas de rodar o job e baixar o artefato | **baixo** |
| 5 | **fiar `run_eval.py` no CI** como job próprio | os `LIMIARES` nomeados e as duas métricas de contraprova (poder de detecção sem D/C, reconstrução independente da identidade) passam a bloquear | **baixo** |
| 6 | **transformar em trava dura o aviso de "não salve memória com Classe A pendente"** | hoje o portal avisa mas não impede: desabilitar o botão `salvar memória do cliente…` quando `qa.bloqueado` alinha o código à intenção declarada em `memoria.py` | **baixo** |

### Prioridade 2 - completa o produto

| # | Item | Valor | Esforço |
|---|---|---|---|
| 7 | **implementar `server/app/db/rotas.py`** (`/dados/auth/login`, `/clientes`, `/analises`, `/memoria/{cliente_id}`, `/dicionario`) | destrava tudo que depende de identidade: memória versionada de verdade, dicionário global, histórico multi-cliente. Toda a lógica e o schema já existem e estão testados; falta a camada HTTP e os testes de rota | **médio** |
| 8 | **exercitar o modo de visão com um PDF escaneado real** e transcrevê-lo como terceiro golden dataset | é o único caminho em que o LLM tocaria em número, e o único sem evidência empírica. Precisa também de uma regra explícita: o valor lido por visão tem de passar pela mesma verificação de sintéticas antes de ser aceito | **médio** |
| 9 | **rate limit por usuário** | com as rotas de dados no ar, `usuario_id` existe e o limite passa a ser aplicável. Sem isso, um bearer legítimo consome a GPU indefinidamente | **médio** (depende de 7) |
| 10 | **persistir o trace na tabela `eventos`** | a tabela já é append-only e tem índice por tipo e por timestamp. Resolve a perda de histórico a cada restart e viabiliza o item 13 | **baixo/médio** |
| 11 | **teste próprio de `trace.py`** | `_percentil` com amostra de 0 e 1 elemento, e a regra de "só conta como chamada quem declarou `ok`" | **baixo** |

### Prioridade 3 - aumenta a qualidade do julgamento

| # | Item | Valor | Esforço |
|---|---|---|---|
| 12 | **integrar `nomic-embed-text` ao fluxo de julgamento** como pré-filtro determinístico | reduz o volume que chega ao LLM e melhora o recall do dicionário em contas com grafia divergente. Precisa de: índice de embeddings das 1.260 origens do dicionário, limiar de similaridade calibrado, e a regra de que **o embedding sugere, o guardrail decide** - jamais aloca sozinho | **médio** |
| 13 | **painel histórico de `/usage`** com série temporal e comparação por `PROMPT_VERSION` | é o que transforma "trocamos o prompt" em "trocamos o prompt e a taxa de aceitação subiu de X para Y" | **médio** (depende de 10) |
| 14 | **sinal de produção de acurácia**: registrar quando o analista **corrige** uma sugestão aceita | hoje a acurácia só é medida offline pelos golden datasets. A taxa de correção humana é o único sinal que reflete o uso real | **médio** (depende de 7) |
| 15 | **`trace_id` propagado do portal até o notebook** | permite atribuir latência a uma das três pernas | **médio** |

### Prioridade 4 - endurecimento

| # | Item | Valor | Esforço |
|---|---|---|---|
| 16 | **`pip-audit` e `npm audit` no CI** | fecha a lacuna de revisão de dependências. Barato e independente de tudo o mais | **baixo** |
| 17 | **auditoria de acesso a leitura** em `eventos` | responde "quem abriu a análise do cliente X e quando" | **baixo/médio** (depende de 7) |
| 18 | **fila offline de escrita no portal** | cobre conectividade intermitente, que é o cenário real de um plano de dados com cold start de ~50s | **médio** |
| 19 | **cofre e rotação de segredo** | tira `JWT_SECRET` e as chaves de nuvem do ambiente do processo | **médio** |
| 20 | **criptografia em repouso no nível de coluna** para `analises.linhas` | o balanço integral do cliente hoje está em `jsonb` claro | **alto** |

### Deliberadamente fora de escopo

Para não deixar dúvida sobre o que é lacuna e o que é decisão:

| Item | Por que não |
|---|---|
| **agente autônomo multiagente** | o fluxo é conhecido e auditável; agente livre adiciona não-determinismo onde crédito exige reprodutibilidade |
| **fine-tuning do modelo de julgamento** | a redução de candidatos de 79 para ~9-15 já torna a tarefa fácil o bastante para um 7B. Fine-tuning trocaria um mecanismo explicável por pesos, e o ganho marginal é pequeno |
| **Docling / TableFormer** | falha em tabela sem borda alinhada por whitespace, que é o formato de BP/DRE brasileiro, e traz ~2 GB de PyTorch. Ver <ref_file file="docs/03-leitura-documento.md" /> |
| **RLS no Postgres** | a autorização mora no `WHERE` do repositório, com fronteira explícita. RLS amarraria o banco a funções de sessão de um provedor |
| **colunas `Retirar`/`Adicionar` da Shadow do Excel** | violam a conservação de valor por construção. Ver <ref_file file="docs/02-invariante-contabil.md" />, §11 |
| **LLM lendo número** | é a fronteira que a v1 errou e que custou R$ 151 milhões de erro no arquivo real. Não volta |
