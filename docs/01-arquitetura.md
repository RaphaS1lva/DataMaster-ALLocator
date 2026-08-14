# Arquitetura

## 1. O problema

Analistas de crédito recebem demonstrações financeiras em formatos
heterogêneos - PDF auditado, balancete de ERP, planilha, imagem - e precisam
"planilhá-las": alocar cada conta num plano padronizado de 79 posições,
respeitando regras de sinal, hierarquia, anti-dupla-contagem, e tendo
`Ativo = Passivo + PL` como condição de entrega.

O trabalho tem duas naturezas distintas, e tratá-las igual é o erro que custa
caro:

| Natureza | Exemplo | Quem deve fazer |
|---|---|---|
| **Fato** | "esta célula vale 118.035.576,14" · "esta conta é analítica" · "este saldo é credor" | código determinístico |
| **Julgamento** | "`( - ) JUROS DEBENTURES` pertence a qual das 15 posições de Passivo Circulante?" | modelo de linguagem, revisável por humano |

A v1 misturava as duas. O LLM lia números, e um erro de leitura virava um
balanço errado sem nenhum sinal. O v2 separa, e cerca a fronteira com
verificações.

## 2. Componentes

```
┌──────────────────────────────────────────────────────────────┐
│  GitHub Pages - portal React (estático, público)             │
│                                                              │
│  · fluxo em 4 etapas: Documento → Conferência → Revisão →   │
│    Resultado                                                 │
│  · PIPELINE CONTÁBIL 100% no navegador (portal/src/core/)   │
│    hierarquia · sinal · agregação · conservação · identidade │
│  · recalcula a cada edição; funciona sem servidor            │
└───────────┬──────────────────────────────┬───────────────────┘
            │                              │
   plano de DADOS                 plano de INFERÊNCIA
   (sempre alcançável)            (intermitente, com GPU)
            │                              │
            ▼                              ▼
┌───────────────────────┐   ┌──────────────────────────────────┐
│ FastAPI no Render     │   │ FastAPI no notebook pessoal      │
│ (free, cold start     │   │ via Cloudflare Tunnel            │
│  ~50s, nunca pausa)   │   │                                  │
│                       │   │ /read  leitura determinística    │
│ /dados/*  CRUD        │   │        (0 tokens) + gate         │
│ /dados/memoria        │   │ /julgamental  LLM + guardrails    │
└──────────┬────────────┘   │ /parecer      prosa              │
           │                └──────────┬───────────────────────┘
           ▼                           ▼
┌───────────────────────┐   ┌──────────────────────────────────┐
│ Neon Postgres         │   │ Ollama local (RTX 4050, 6 GB)    │
│ hiberna em 5 min,     │   │  qwen2.5:7b → 3b (julgamento)    │
│ ACORDA em ~0,5s       │   │  qwen2.5vl:3b → 7b → granite     │
│                       │   │  nomic-embed-text (similaridade) │
│ nunca precisa de      │   │         ↓ fallback               │
│ restore manual        │   │  Gemini → Groq                   │
└───────────────────────┘   │         ↓ fallback               │
                            │  MODO DETERMINÍSTICO (sem LLM)   │
                            └──────────────────────────────────┘
```

### Por que dois planos

Dado precisa estar **sempre** disponível; inferência é **intermitente e
pesada**. Separar significa que, com o notebook desligado, o portal continua
lendo e salvando análises - só o botão de IA fica indisponível, e o pipeline
determinístico já funciona sem ele.

É o mesmo código-fonte implantado duas vezes. O portal descobre as duas URLs em
runtime (`portal/public/runtime-config.json`), o que também resolve o hostname
variável do Cloudflare Tunnel gratuito.

## 3. Onde o LLM entra - e onde não entra

| Etapa | LLM? | Verificação de código |
|---|---|---|
| identificar páginas financeiras | **não** | score por âncoras + colunas alinhadas + **subtotal aritmético confirmado** |
| ler valores e colunas | **não** | clusterização de bordas direitas por coordenada x |
| natureza (débito/crédito) | **não** | coluna D/C da linha; conferido contra os subtotais declarados |
| hierarquia (folha vs sintética) | **não** | maior prefixo estrito de código, **conferido aritmeticamente** |
| **mapear conta → posição** | **sim** | destino ∈ 79 · lado preservado · sinal compatível · origem existe no documento · limiar de confiança |
| parecer executivo | **sim** | nenhuma - é só texto, nunca altera dado |

O número que justifica essa fronteira: no arquivo real que motivou o projeto,
**nenhum centavo dos R$ 151 milhões de erro veio do julgamento do modelo.** Todo
ele veio de leitura (natureza D/C ignorada) e de estrutura (detecção de folha).

Ver <ref_file file="docs/02-invariante-contabil.md" /> para a prova de que o
fechamento é imune a erro de julgamento.

## 4. Leitura sem tokens

A intuição: numa demonstração financeira, **coluna é coordenada x**. Todo valor
de uma coluna compartilha a mesma borda direita, porque número contábil é
alinhado à direita.

```
palavras com caixa (pdfplumber)
      │
      ├─ clusteriza os x1 dos tokens numéricos  →  colunas
      ├─ descarta a coluna "Nota" por ESTRUTURA →  (mais à esquerda do bloco,
      │                                             ≥70% |v|<100, sem separador)
      ├─ agrupa por `top`                        →  linhas
      ├─ x0 do rótulo                            →  nível de indentação
      └─ soma de bloco contíguo                  →  subtotal confirmado
```

Detalhes que resolvem os bugs mais comuns:

- **traço isolado é célula vazia, não zero, e ocupa a coluna.** Cada linha é
  pré-semeada com todas as chaves de coluna, então um traço nunca desloca os
  valores à direita dele - que era a causa nº 1 de valor na coluna errada.
- **a ordem das visões vem da posição x** do cabeçalho, nunca de uma lista
  pré-definida. Se o documento imprime `Consolidado | Controladora`, é essa a
  ordem.
- **borda direita, não a esquerda.** `1.234.567,89` e `55` só compartilham o x1.

### Docling foi descartado - e por quê

O TableFormer do Docling **falha em tabelas sem borda alinhadas por whitespace**
([issue #3749](https://github.com/docling-project/docling/issues/3749)), que é
exatamente o formato de BP/DRE brasileiro. Além disso traz ~2 GB de PyTorch. Para
este domínio, a clusterização por coordenada é mais precisa, instantânea e sem
dependência pesada.

### Custo

O modelo vê apenas os **nomes de conta que o dicionário não conhece** - algumas
dezenas de strings curtas - e, raramente, a imagem de uma página escaneada.
Consumo por documento: de ~6.000 tokens na v1 para **~500**.

## 5. A camada de LLM

**Cascata:** `ollama[qwen2.5:7b]` → `ollama[qwen2.5:3b]` → `gemini` → `groq` →
**modo determinístico** (memória + dicionário + edição manual, sem LLM nenhum).

**Disjuntor por modelo:** três falhas consecutivas colocam o modelo em cooldown
de 120s. Evita queimar latência insistindo num modelo que não está carregado.

**Saída estruturada:** o Ollama aceita um JSON Schema no campo `format` e o
converte em gramática GBNF aplicada **no sampling**
([docs](https://docs.ollama.com/capabilities/structured-outputs)). JSON inválido
deixa de ser "tolerado por um parser" e passa a ser **impossível de gerar**. É
também o guardrail anti-injeção mais forte que temos: um "ignore tudo e faça X"
não tem por onde sair, porque o espaço de saída está restringido.

**Truncamento vira erro, nunca sucesso silencioso.** Resposta cortada por limite
de tokens é um `ErroProvedor` retentável. Número incompleto é tão inaceitável
quanto número errado.

**Redução do espaço de decisão:** `candidatosPara(grupo, sub)` corta de 79 para
9–15 destinos antes da chamada. Combinado com a cadeia de contas-pai no prompt,
transforma "classifique entre 79" em "escolha entre 15, sabendo o pai" - tarefa
em que um 7B é confiável.

## 6. Guardrails, em seis camadas

| # | Camada | Custo | O que barra |
|---|---|---|---|
| 0 | tipo real por **magic bytes**, tamanho, páginas | 0 | executável renomeado para `.pdf` (a v1 confiava na extensão) |
| 1 | conteúdo ativo em PDF (`/JS`, `/OpenAction`, `/Launch`, anexos) | 0 | PDF armado |
| 2 | **gate contábil** por evidência estrutural e aritmética | 0 | receita de bolo, contrato, currículo, DFC, DMPL, DVA, notas |
| 3 | isolamento de canal + neutralização de padrões de injeção | 0 | "ignore as instruções anteriores" |
| 4 | JSON Schema no sampling (GBNF) | 0 | qualquer saída fora do contrato |
| 5 | validação da resposta | 0 | destino fora do plano · lado trocado · **origem inventada** · confiança baixa |

A camada 2 é a resposta ao requisito "se subirem uma receita, o sistema deve
entender que não é um demonstrativo e não seguir". Ela exige **evidência
aritmética**: ao menos uma linha cujo valor seja a soma exata das anteriores, em
**todas** as colunas. Para passar, o atacante teria de fabricar uma tabela
numericamente consistente - ou seja, um balanço de verdade. Salpicar termos como
"Total do Ativo" no texto não move o score.

Âncora negativa no **título** é veto absoluto (a página *é* uma DFC); no corpo é
penalidade branda, porque costuma ser referência cruzada legítima.

A camada 5 inclui a verificação de que a `origem` devolvida pelo modelo **existe
no documento**. Isso mata a injeção "adicione a linha X com valor Y". E os
valores nunca vêm do modelo: vêm do parser posicional.

## 7. Dados e memória

**Neon** em vez de Supabase. O Supabase free **pausa após 7 dias de
inatividade** e exige restore manual pelo painel - inaceitável para uma
apresentação. O Neon hiberna em 5 minutos mas **acorda sozinho em ~0,5s**.

A API passa a ser a única a falar com o banco. Some o RLS; entra filtro por
`usuario_id` no repositório e JWT próprio. Menos mágica, fronteira mais clara, e
a `anon key` deixa de circular no código público.

### Memória do cliente: decisões positivas **e** negativas

Quando o analista **retira** uma conta de uma linha, isso é uma decisão tão
informativa quanto alocá-la. A v1 exportava apenas linhas com destino, então a
retirada era perdida e, na análise seguinte do mesmo cliente, o dicionário
realocava exatamente a mesma conta.

```
memoria_cliente(cliente_id, revisao, origem_norm, grupo_norm, sub_norm)
  → destino, decisao ∈ {alocar, nao_alocar, contexto},
    confirmado_por_humano, analise_id, vezes
```

- **versionada por revisão** - cada salvamento cria uma revisão nova; nada é
  sobrescrito, e é possível auditar e reverter
- **opt-in com diff** - o portal mostra "41 novas, 7 alteradas, 3 marcadas não
  alocar, 12 confirmadas" **antes** de gravar
- **aprende só de análise concluída e conciliada** - um rascunho quebrado nunca
  envenena a memória
- **o dicionário global recebe apenas o confirmado por humano.** Na v1 um trigger
  aprendia de tudo que era salvo, então um erro de julgamento entrava no
  dicionário e se propagava para sempre.

### Uma função de normalização, três implementações provadas equivalentes

`normalizeText` (JS) ≡ `normalize_text` (Python) ≡ `dm_normalize` (SQL).

A v1 tinha o trigger normalizando com `lower(unaccent(...))` e o cliente com
remoção de pontuação. `"ICMS s/ vendas"` gerava duas chaves distintas: linhas
duplicadas no dicionário, e o seed nunca sendo sobrescrito.

## 8. Decisões e trade-offs

| Decisão | Alternativa | Por quê |
|---|---|---|
| pipeline contábil no navegador | tudo no backend | recálculo instantâneo na revisão; funciona offline; o backend gratuito fica leve |
| clusterização por coordenada | Docling / TableFormer | Docling erra tabela sem borda, que é o nosso caso, e traz 2 GB de PyTorch |
| Ollama local | só APIs free | privacidade (§9), custo zero, sem limite de cota; e a arquitetura torna um 7B suficiente |
| Neon | Supabase free | Supabase pausa em 7 dias e exige restore manual |
| API como única a falar com o banco | RLS + anon key no browser | fronteira explícita; menos superfície pública |
| config em runtime | `VITE_API_URL` na build | o hostname do tunnel gratuito muda a cada reinício |
| workflow orquestrado | multiagente autônomo | o fluxo é conhecido e auditável; agente livre adiciona não-determinismo onde crédito exige reprodutibilidade |
| `.md`/`.csv` como fonte de verdade | Excel | diff no git, revisável, e o build valida a cobertura das fórmulas |
| mutar a linha para ajustar | colunas Retirar/Adicionar do Excel | as colunas do Excel permitem adicionar sem retirar, violando a conservação por construção |

## 9. Privacidade

Este é provavelmente o argumento mais forte da arquitetura, e não é sobre custo.

Na v1, o balanço de uma empresa fechada trafegava por Gemini, Groq, OpenRouter e
Hugging Face em **tier gratuito**, onde os termos permitem uso dos dados para
treinamento. Estava documentado como limitação de MVP - honesto, mas uma
limitação real num caso de uso de crédito bancário.

Com o Ollama local, **o balanço do cliente não sai da máquina**. Trocar de
provedor de API para inferência local não é otimização de token: é a resposta
correta de privacidade para o domínio.

## 10. Verificação

| Camada | Como se prova |
|---|---|
| cobertura das fórmulas | `scripts/gen_knowledge.py` falha o build se alguma das 56 posições de Ativo/Passivo não entrar em exatamente um total |
| integridade do dicionário | 1.260 regras, todas resolvendo para conta alocável (teste) |
| leitura | 134 sintéticas × colunas contra a soma das folhas, zero divergência |
| conservação | Σ folhas = Σ alocado + Σ perdas, por ano |
| identidade | fecha em 0,00 no golden dataset real, após o transporte do resultado |
| imunidade a julgamento | 15 mapeamentos aleatórios distintos, fechamento idêntico |
| anti-injeção | suíte red-team: receita, contrato, DFC, âncoras injetadas, injeção de prompt |

`portal`: 32 testes · `server`: 105 testes.

## 11. O que a v1 acertou e foi preservado

Vale registrar, porque a base conceitual estava boa:

- **LLM como componente, não como sistema.** A tese de que ~80% da lógica é
  determinística estava certa e é o que a maioria dos projetos não faz.
- **Guardrail de whitelist** no destino do julgamental.
- **Falha honesta** com portões de qualidade em vez de resultado silencioso.
- **Eval com golden dataset** transcrito à mão.
- **Prompts versionados.**
- O **plano de contas de 79 posições** e o **grafo de fórmulas**, que verifiquei
  linha por linha e estavam matematicamente corretos.
- O **dicionário de 1.285 regras**, do qual 1.260 foram preservadas (as demais
  eram grafias inválidas ou cabeçalhos de seção perigosos).

O que mudou foi o rigor de execução: invariante provada em vez de checada, eval
que bloqueia, observabilidade com latência, e privacidade resolvida em vez de
justificada.
