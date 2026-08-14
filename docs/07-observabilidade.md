# Observabilidade: latência, tokens e a decisão de roteamento

Este documento descreve o que o ALLocator v2 registra sobre a própria camada de
LLM, por quais rotas isso é lido, e - com igual detalhe - o que ainda **não**
existe. A escala é deliberadamente pequena: um trace em memória por processo, sem
dependência externa.

## 1. Por que este módulo existe

`server/app/obs/trace.py` abre com a justificativa:

> O v1 do ALLocator tinha apenas um contador em memória ("chamei o modelo N
> vezes"). Isso é insuficiente para defender a arquitetura: não dizia QUAL modelo
> respondeu, QUANTO tempo levou, QUANTOS tokens custou, nem POR QUE o roteador
> escolheu aquele provedor. Sem esses números não há como afirmar "o modelo local
> resolve 95% dos casos em Xms" - só há opinião.

| | v1 | v2 |
|---|---|---|
| granularidade | um contador agregado | um evento por tentativa, com `provedor`, `modelo`, `tipo` |
| latência | nenhuma | `duracao_ms` por chamada, agregada em p50/p95/média |
| tokens | nenhum | `tokens_entrada` e `tokens_saida` por chamada e por modelo |
| decisão de roteamento | **não registrada** | `decisao` em todo evento `llm.roteamento`, inclusive nas tentativas puladas |
| erros | não | `ok=False` + `erro` com tipo e mensagem, e `ultimo_erro` por modelo |
| sobrevive a restart | não | também não (§5) |

## 2. O que `trace.py` registra

### `Trace.evento(nome, **campos)`

Registra um evento pontual, devolve o registro gravado e emite **uma linha JSON via
`logging`** no logger `allocator.trace`, para quem quiser agregar fora do processo.

```python
{
  "ts": 1786... ,          # relógio de parede
  "t_rel_ms": 1843.27,     # desde a criação do trace
  "evento": "llm.roteamento",
  ...campos
}
```

`t_rel_ms` existe para reconstruir a linha do tempo de uma requisição **sem
depender de relógio de parede** - que pode dar salto por NTP no meio da medição. O
`json.dumps(..., default=str)` evita que um objeto exótico (uma exceção, por
exemplo) derrube o log.

### `Trace.contexto(nome, **campos)` - duração por bloco

Context manager que mede o bloco e registra sucesso **ou** exceção, sempre com
`duracao_ms`. O dict cedido pelo `yield` é mesclado ao evento final, o que permite
ao bloco acrescentar campos descobertos durante a execução sem uma segunda
chamada:

```python
with TRACE.contexto("llm.chamada", provedor="ollama", modelo=nome, tipo=tipo) as extras:
    resposta = await cliente.chat(nome, mensagens, formato=formato, imagens=imagens)
    extras["tokens_entrada"] = resposta.tokens_entrada
    extras["tokens_saida"]  = resposta.tokens_saida
```

Em caso de exceção o evento sai com `ok=False` e
`erro=f"{type(exc).__name__}: {exc}"`, **e a exceção é re-levantada**. O trace nunca
engole falha.

### Eventos emitidos hoje

| Evento | Onde | Campos característicos |
|---|---|---|
| `llm.roteamento` | `router._cascata`, `router.embutir` | `decisao`, `provedor`, `modelo`, `tipo`, `vram_gb`, `cooldown_restante_s` |
| `llm.chamada` | `router._cascata` (contexto) | `provedor`, `modelo`, `tipo`, `tokens_entrada`, `tokens_saida`, `ok`, `duracao_ms`, `erro` |
| `llm.embedding` | `router.embutir` (contexto) | `provedor`, `modelo`, `itens` |
| `julgamental` | `main.julgamental` (contexto) | `ok`, `duracao_ms` |
| `julgamental.guardrail` | `main.julgamental` | `aceitas`, `descartadas` |
| `parecer` | `main.parecer` (contexto) | `ok`, `duracao_ms` |

Valores possíveis de `decisao`: `tentativa_local`, `pulado_disjuntor`,
`tentativa_nuvem`, `pulado_sem_visao`, `tentativa_embedding`.

### `Trace.resumo()` - a agregação

```python
{
  "eventos_em_memoria": 27,
  "por_modelo": {
    "ollama/qwen2.5:7b-instruct-q4_K_M": {
      "chamadas": 4, "sucessos": 3, "erros": 1,
      "tokens_entrada": 1832, "tokens_saida": 412,
      "ultimo_erro": "ErroProvedor: ...",
      "latencia_p50_ms": 2140.5, "latencia_p95_ms": 5310.2, "latencia_media_ms": 2680.4
    }
  },
  "decisoes_roteamento": { "tentativa_local": 5, "pulado_disjuntor": 2 }
}
```

A chave de agregação é `f"{provedor}/{modelo or '-'}"`.

Um detalhe de definição que evita mentira estatística: **só conta como "chamada" o
evento que declarou `ok`** (sucesso ou falha de uma tentativa real). Decisões de
roteamento entram em `decisoes_roteamento` e não inflam a contagem de chamadas - um
modelo pulado pelo disjuntor 40 vezes não pode aparecer como "40 chamadas com 0%
de sucesso".

`_percentil` é implementado à mão, por interpolação linear, de propósito:
`statistics.quantiles` exige `n >= 2` e levanta exceção com amostra pequena - e
amostra pequena é a **regra** aqui, já que uma leitura pode fazer 3 chamadas de
LLM. Um módulo de observabilidade que levanta exceção por ter poucos dados é pior
que nenhum.

### Armazenamento

```python
MAX_EVENTOS = 500
self._eventos: deque[dict[str, Any]] = deque(maxlen=maxlen)
```

`deque` limitado, **sem I/O de disco no caminho crítico**. 500 eventos cobrem uma
sessão de leitura inteira sem virar vazamento de memória; passando disso, os mais
antigos caem.

`TRACE` é um singleton de processo. A camada de LLM é chamada de vários pontos
(rotas do FastAPI, scripts de eval), e o singleton evita ter de passar o trace por
parâmetro em todas as assinaturas só para observabilidade. `limpar()` zera eventos e
reinicia o marco de `t_rel_ms`.

## 3. As rotas

### `GET /usage`

```python
@app.get("/usage")
async def usage() -> dict[str, Any]:
    """Consumo e latência por provedor/modelo, desde o boot do processo."""
    return TRACE.resumo()
```

Devolve exatamente `Trace.resumo()`. O portal a consome em
`portal/src/lib/api.js` (`usage()`, timeout de 8s).

### `GET /health`

Estado do que está **realmente** disponível agora - é o que o portal mostra ao
usuário:

```python
{
  "status": "ok",
  "prompt_version": prompts.PROMPT_VERSION,   # "v3.0-local"
  "provedores": { ... },                      # router.status()
  "banco_configurado": bool,                  # conexao.esta_configurado()
  "autenticacao": bool(TOKEN_API),
  "max_upload_mb": MAX_UPLOAD_MB              # 40
}
```

`provedores` vem de `router.status()`, que sonda o Ollama e devolve:

| Campo | Conteúdo |
|---|---|
| `ollama` | `url`, `ativo` (sonda de 2s), `modelos_instalados` (via `GET /api/tags`) |
| `nuvem` | `cloud.provedores_configurados()` - se Gemini/Groq têm chave, qual modelo, se têm visão. **Sem chamar a rede** |
| `escada` | cada spec de `MODELOS` acrescida de `instalado` e `disponivel` (instalado **e** fora de cooldown) |
| `disjuntores` | `estado_disjuntores()`: `falhas`, `aberto`, `cooldown_restante_s` |
| `trace` | `TRACE.resumo()` embutido |

Duas propriedades importantes:

- **`/health` nunca falha.** A sondagem de provedores está num `try/except` que
  devolve `{"erro": ...}` truncado em 200 caracteres, e a checagem de banco também.
  Um health check que dá 500 é inútil justamente quando é necessário.
- **`instalado` é medido, não configurado.** A escada de `MODELOS` declara o que o
  projeto *quer*; `GET /api/tags` diz o que a máquina *tem*. A comparação normaliza
  `:latest` para que `qwen2.5:7b-instruct-q4_K_M` e a mesma tag com sufixo casem.

Do lado do portal, `health()` usa timeout curto (8s) de propósito: é um indicador
de tela, e um `/health` que demora 60s para dizer "fora do ar" é pior que dizer
logo. O cartão do Dashboard trata a falha como **informação** ("inferência
indisponível"), não como erro - porque com o notebook desligado o portal continua
funcionando no modo determinístico.

## 4. Por que registrar a DECISÃO de roteamento importa

É o item que a v1 não tinha e o que diferencia observabilidade de contagem.

Registrar apenas "o Gemini respondeu" conta o resultado. Registrar a **decisão**
conta a causa:

```
llm.roteamento  decisao=tentativa_local     modelo=qwen2.5:7b-instruct-q4_K_M  vram_gb=4.7
llm.chamada     ok=false  erro=ErroProvedor: ollama /api/chat inacessível (ConnectError: ...)
llm.roteamento  decisao=tentativa_local     modelo=qwen2.5:3b-instruct-q4_K_M  vram_gb=2.0
llm.chamada     ok=false  erro=...
llm.roteamento  decisao=tentativa_nuvem     provedor=gemini
llm.chamada     ok=true   duracao_ms=1840.2  tokens_entrada=612  tokens_saida=284
```

Com esse rastro, "por que este documento foi para a nuvem?" tem resposta factual: o
daemon local não respondeu duas vezes. Sem ele, a resposta é uma suposição.

E é isso que permite defender a arquitetura com número em vez de opinião. As três
afirmações centrais deste projeto - *o modelo local basta*, *a redução de candidatos
é o que viabiliza um 7B*, *o dado do cliente não sai da máquina* - são todas
verificáveis a partir do trace:

| Afirmação | Como o trace a mede |
|---|---|
| o local basta | `decisoes_roteamento`: proporção `tentativa_local` bem-sucedida vs `tentativa_nuvem` |
| a latência é aceitável | `latencia_p50_ms` / `latencia_p95_ms` por modelo |
| o custo por documento é baixo | `tokens_entrada` + `tokens_saida` por modelo (~500 por documento) |
| o dado não sai da máquina | qualquer evento com `provedor` ∈ {`gemini`, `groq`} é uma saída, e está registrado |
| o disjuntor está ajudando | contagem de `pulado_disjuntor` contra o tempo que teria sido gasto em timeout |

A última linha é a mais útil na prática: sem registrar as tentativas puladas, o
efeito do disjuntor é invisível - ele *evita* eventos, e o que não acontece não
aparece em log.

Também vale para os guardrails: `julgamental.guardrail` com `aceitas` e
`descartadas` transforma "o guardrail funciona" em uma taxa, e a lista de motivos de
descarte devolvida por `/julgamental` diz **qual** filtro disparou. Ver
<ref_file file="docs/08-seguranca-guardrails.md" />, camada 5.

## 5. O que ainda NÃO existe

Sendo direto, porque um documento de observabilidade que esconde os próprios pontos
cegos é pior que inútil:

| Lacuna | Consequência concreta |
|---|---|
| **o trace não persiste** | tudo vive num `deque` de 500 posições em memória. Um restart do processo - ou o `uvicorn --reload` - apaga o histórico. Comparar a latência de hoje com a da semana passada é impossível |
| **não há tracing distribuído** | o portal, o plano de dados (Render) e o plano de inferência (notebook via Cloudflare Tunnel) são três processos, e não existe `trace_id` propagado entre eles. Uma leitura lenta não pode ser atribuída a uma das três pernas com precisão |
| **não há painel histórico** | `/usage` devolve JSON do processo atual. Não há série temporal, alerta, nem comparação entre versões de prompt (`PROMPT_VERSION` é registrado, mas não agregado por versão) |
| **o `job_id` de `/read` não entra no trace** | `JOBS` guarda `status` e `progresso`, e o progresso é uma string para a UI. A duração de cada etapa da leitura determinística (classificação, extração por página) não é medida - só a camada de LLM é instrumentada |
| **`registrar_evento` na tabela `eventos` é separado do trace** | a trilha de auditoria de negócio (`memoria.revisao_salva`, por exemplo) vai para o Postgres; o trace técnico fica em memória. Os dois não se cruzam |
| **sem métrica de acurácia em produção** | a acurácia do julgamento é medida offline pelos golden datasets (<ref_file file="docs/06-avaliacao.md" />). Não há sinal de produção - por exemplo, a taxa com que o analista corrige uma sugestão aceita |

Nada disso é acidental: a escolha foi instrumentar **bem** a fronteira que importa
para a tese (a camada de LLM) em vez de instrumentar mal tudo. Mas o custo é real, e
o caminho de correção - persistir o evento na tabela `eventos`, que já existe e já é
append-only, e propagar um `trace_id` a partir do portal - está priorizado em
<ref_file file="docs/11-roadmap.md" />.

## 6. Como isto é testado

O trace em si não tem suíte dedicada; ele é exercitado indiretamente pelos testes de
disjuntor de `server/tests/test_llm_guardrails.py`
(`test_disjuntor_pula_modelo_apos_tres_falhas`,
`test_disjuntor_zera_apos_sucesso`, `test_cascata_sem_nuvem_relata_historico`), que
percorrem `_cascata` e portanto emitem `llm.roteamento` e `llm.chamada`.

Isto é uma lacuna reconhecida: `_percentil` com amostra de 0 e 1 elemento, e a regra
de "só conta como chamada quem declarou `ok`", merecem teste próprio. Está no
roadmap como item de esforço baixo.
