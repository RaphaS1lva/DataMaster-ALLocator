# Dados e persistência: a memória do analista

Este documento descreve onde o dado do ALLocator v2 mora, quem tem permissão de
falar com o banco, e o mecanismo central do produto - a memória versionada do
cliente, que registra decisões **positivas e negativas**. É a parte que decide se
o analista refaz ou não o mesmo trabalho manual no mês seguinte.

## 1. Por que Neon e não Supabase

A v1 usava o Supabase (banco + autenticação). O motivo da troca é operacional e
brutalmente simples:

| | Supabase free | Neon |
|---|---|---|
| inatividade | **PAUSA o projeto após 7 dias** | hiberna em ~5 min |
| voltar a responder | **restore manual no console** | **acorda sozinho em ~0,5s**, na primeira query |
| efeito prático | analista abre o portal na segunda-feira e recebe erro de conexão | latência extra imperceptível na primeira consulta |

Um projeto que exige intervenção humana no console para voltar do fim de semana
não é uma opção para uma ferramenta de trabalho - e é inaceitável para uma
apresentação. Está registrado no cabeçalho de `server/app/db/schema.sql` e de
`server/app/auth.py`.

### Sem pool no processo

```
POR QUE NÃO HÁ POOL AQUI
O Neon fecha conexão ociosa e oferece um pooler próprio no endpoint
`...-pooler.<região>.aws.neon.tech`. Manter um pool no processo sobre um banco que
hiberna dá conexão morta em cache - erro intermitente, o pior tipo.
```

`conexao.conectar()` abre uma conexão por unidade de trabalho e delega o pooling
ao endpoint. Se o volume justificar, o lugar de mudar é só esse arquivo.

## 2. O modelo de segurança mudou

| | v1 | v2 |
|---|---|---|
| quem fala com o banco | o **browser**, com `anon key` publicada no bundle | **só a API**, com uma credencial de serviço que nunca sai do servidor |
| onde mora a autorização | RLS no Postgres, com função de sessão do provedor | no `WHERE` de `app/db/repo.py`, alimentado pelo JWT validado em `app/auth.py` |
| autenticação da API de inferência | **nenhuma**, com `ALLOWED_ORIGINS=*` | bearer de serviço + CORS restrito |
| portabilidade do banco | amarrado ao catálogo de auth do provedor | `usuarios` é tabela comum, `usuario_id` é FK normal |

A `anon key` da v1 era pública **por construção**: bastava abrir o DevTools.

E o pior problema da v1, registrado literalmente no docstring de `auth.py`:

> **A API NÃO TINHA AUTENTICAÇÃO NENHUMA.** O servidor de inferência subia com
> `ALLOWED_ORIGINS=*` e nenhuma verificação de credencial. Qualquer pessoa que
> descobrisse a URL podia disparar chamadas de LLM à vontade [...] Não havia sequer
> como saber que estava acontecendo, porque sem identidade não há atribuição.

### Duas credenciais, deliberadamente diferentes

| Credencial | Função | O que carrega |
|---|---|---|
| **JWT por usuário** (`criar_token` / `validar_token`) | sessão de pessoa | `sub` = `usuario_id`, `email`, `iat`, `exp` (`HORAS_PADRAO = 12`) |
| **Bearer de serviço** (`ALLOCATOR_API_TOKEN`) | prova que a chamada vem do nosso portal | nada - não identifica pessoa nem dá acesso a dado de ninguém |

Três detalhes de `auth.py` que contrariam o caminho fácil:

- **`algorithms=[ALGORITMO]` é lista fechada.** Aceitar o algoritmo declarado no
  header do próprio token é a vulnerabilidade clássica de JWT (`alg: none`, ou
  trocar HS por RS para forjar assinatura). Quem manda é o servidor.
- **`_segredo()` falha no boot em produção** se `JWT_SECRET` não existir. Gerar um
  segredo aleatório no boot "pareceria funcionar" - até o processo reiniciar e
  invalidar todas as sessões, ou até subir uma segunda instância que rejeita os
  tokens da primeira. Falha intermitente de login é caríssima de diagnosticar;
  falha no boot, com mensagem clara, custa um minuto. Só
  `ALLOCATOR_AMBIENTE ∈ {dev, local, teste, test}` tolera a ausência, e loga
  `WARNING`.
- **`conferir_token_api()` é FAIL-CLOSED** e usa `secrets.compare_digest`. Sem
  token configurado, **nada** é aceito: "é o oposto do v1, onde a ausência de
  configuração significava aberto para o mundo - e foi assim que a API de
  inferência ficou pública sem ninguém decidir isso. Abrir uma porta deve exigir
  um ato explícito; fechá-la, não." O `compare_digest` evita o oráculo de tempo
  que permitiria descobrir o segredo byte a byte.

Senha é **bcrypt** (`hash_senha` / `verificar_senha`), com truncamento explícito
em 72 bytes - o bcrypt ignora o que passa disso, e deixar implícito significaria
duas frases-senha longas diferentes validando a mesma conta. `verificar_senha`
nunca levanta por hash malformado: devolve `False` e loga, porque uma exceção
distinguiria "usuário existe com hash estranho" de "usuário não existe".

### A autorização é o `WHERE`

```
POR QUE `usuario_id` APARECE EM TODA ASSINATURA
[...] Um `id` vindo do cliente é palpite até provar que pertence a quem pediu - e
a prova é `and usuario_id = %s` na mesma query, nunca um SELECT de verificação
seguido de UPDATE (isso é corrida clássica).
```

Consequências concretas em `repo.py`:

- `upsert_cliente` e `salvar_analise` têm
  `where clientes.usuario_id = excluded.usuario_id` no `do update`. Sem essa
  cláusula, um id adivinhado sobrescreveria o registro de outro analista - e o
  `on conflict` esconderia o fato, porque não há erro nenhum a reportar.
- `NaoEncontrado` é **um único erro** para "não existe" e "existe mas não é seu".
  Responder 404 e 403 diferente conta ao atacante quais ids são válidos. A API
  traduz em 404 sempre.
- Parâmetros são **sempre** ligados pelo driver. `cliente_id` opcional é resolvido
  com curinga (`(%s::uuid is null or cliente_id = %s::uuid)`) em vez de SQL
  montado por condição: duas queries divergiriam na manutenção, e SQL concatenado
  convida a injeção.
- `::uuid` explícito em todo id, porque o driver manda `str` como texto e
  `uuid = text` não tem operador no Postgres.
- `dict_row` é obrigatório em todo o projeto: linha como tupla obriga a lembrar a
  ordem das colunas do SELECT, e um dia alguém insere uma coluna no meio e o
  código passa a ler o campo errado sem erro nenhum.

## 3. Tabelas

`server/app/db/schema.sql` é **idempotente** - `conexao.aplicar_schema()` pode
rodar quantas vezes quiser, inclusive no boot da API. Roda o arquivo inteiro numa
chamada só, sem parâmetros, para usar o protocolo simples do psycopg: quebrar o
script em statements exigiria um parser de SQL (as funções têm `;` dentro do corpo
`$$ ... $$`), e parser meia-boca de SQL é fonte garantida de falha silenciosa de
migração.

| Tabela | Papel | Detalhe que importa |
|---|---|---|
| `usuarios` | pessoas | `email citext unique` - "Ana@x.com" e "ana@x.com" são a mesma conta. Na v1 a coluna era `text`, e um cadastro com caixa diferente criava um usuário paralelo, sem clientes e sem memória. `senha_hash` guarda bcrypt |
| `clientes` | carteira do analista | `on delete cascade` a partir de `usuarios`: não existe cliente órfão |
| `analises` | uma análise inteira | `cliente_id` é `on delete set null` (**não** cascade): apagar o cadastro de um cliente não pode destruir histórico entregue. `linhas`/`qa`/`trilha` são `jsonb` grandes - uma análise real passa de 1 MB |
| `memoria_cliente` | **o coração do sistema** | decisões positivas e negativas, versionadas por `revisao` (§5) |
| `memoria_revisoes` | cabeçalho de cada revisão | grava o **resumo do diff que o analista aprovou** |
| `dicionario_global` | regras transversais do usuário | só recebe o confirmado por humano |
| `eventos` | trilha de auditoria, append-only | `bigserial` e não uuid, porque a ordem de inserção é a informação principal; **sem FK** para `usuarios`/`analises`, para o evento sobreviver ao apagamento do que ele descreve |

Duas travas que na v1 eram apenas comentário:

- `analises_status_check check (status in ('rascunho','em_revisao','concluida'))`.
  "No v1 isto era um COMENTÁRIO na coluna e nada mais, então existiam análises com
  status `'draft'`, `'Rascunho'` e `''` no mesmo banco, e o filtro da lista
  silenciosamente escondia trabalho do analista. Agora o banco recusa."
- `memoria_cliente_decisao_check check (decisao in ('alocar','nao_alocar','contexto'))`,
  espelhando `DECISOES` de `memoria.py` e `DECISAO` de
  `portal/src/core/matching.js`.

`listar_analises()` seleciona `_COLUNAS_ANALISE_LISTA` e **nunca** os `jsonb`
pesados. "No v1 o SELECT era `*` e abrir o portal baixava centenas de megabytes
para exibir nome e data." Só `obter_analise()` os carrega. O teste
`test_listar_analises_nao_traz_os_jsonb_pesados` prova estaticamente que a
constante não os inclui.

## 4. `dm_normalize` - o contrato mais frágil do projeto

```sql
create or replace function public.dm_normalize(txt text)
returns text language sql immutable parallel safe set search_path = public
as $$
  select btrim(
    regexp_replace(
      regexp_replace(unaccent(lower(coalesce(txt, ''))), '[^a-z0-9[:space:]]', ' ', 'g'),
      '[[:space:]]+', ' ', 'g'
    )
  );
$$;
```

A função tem de ser **byte a byte equivalente** a quatro implementações:

| Implementação | Arquivo |
|---|---|
| `normalizeText` | `portal/src/core/normalize.js` (roda no browser) |
| `normalize_text` | `scripts/gen_knowledge.py` (build) |
| `normalizar` | `server/app/reading/page_classifier.py` e `server/app/db/memoria.py` |
| `dm_normalize` | `server/app/db/schema.sql` |

Receita: **lower + NFKD sem acento + `[^a-z0-9\s]` vira ESPAÇO + colapsa espaços +
trim**.

### O bug da v1 estava exatamente aqui

O trigger normalizava com `lower(unaccent(...))` **e mais nada**. A pontuação
sobrevivia:

```
"ICMS s/ vendas"  →  banco:  "icms s/ vendas"
                  →  portal: "icms s vendas"
```

Duas chaves diferentes para a mesma conta. O `UPSERT` não achava a linha do seed,
inseria uma nova, e o dicionário acumulava pares duplicados em que **a regra
aprendida jamais vencia a regra original**. Foi um dos vetores das
**229 de 1.285 regras (17,8%)** com destino divergente. Os dois `regexp_replace`
encadeados acima são exatamente o que faltava.

Note também que a pontuação vira **espaço, não vazio**: `l/p` tem de virar `l p` e
não `lp`, senão `s/ vendas` e `s vendas` deixariam de casar com `svendas`.

### A equivalência agora é VERIFICADA, não prometida

`server/tests/test_normalize_parity.py` **executa o `normalize.js` real com o
Node** e compara contra as implementações Python:

```python
script = (f"import {{ normalizeText }} from '{modulo}';"
          "const entrada = JSON.parse(process.argv[1]);"
          "process.stdout.write(JSON.stringify(entrada.map(normalizeText)));")
```

O `CORPUS` é feito de casos que já quebraram - `Mútuo Financeiro L/P`,
`Bancos L/P`, `ICMS s/ vendas`, `-  Despesas Financeiras` com dois espaços,
`Resultado da Exploração ` com espaço no fim, as retificadoras do Protheus, mais
bordas (`""`, `"   "`, `"---"`, NFD explícito, espaço inquebrável, hífen não
separável).

Além da comparação cruzada, o arquivo valida:

- uma **tabela de referência escrita à mão**, independente das implementações,
  para o caso de as duas divergirem juntas na mesma direção;
- **propriedades invariantes**: sem espaço nas bordas, sem espaço duplo, tudo
  minúsculo, tudo ASCII, sem pontuação, e **idempotência**;
- o bug concreto da v1 (`test_o_bug_da_v1_esta_coberto`): a regra `L/P → LP` da v1
  usava `/\bl\s*\/\s*p\b/` **sobre o texto já normalizado**, exigindo uma barra que
  a própria normalização havia trocado por espaço. Nunca casava, e as ~138 entradas
  `Mútuo Financeiro L/P` / `Bancos L/P` - contas de Passivo Não Circulante,
  vazavam silenciosamente;
- que `dm_normalize` no SQL tem **dois** `regexp_replace`, não regrediu para
  `lower(unaccent())`, e que não há resquício de Supabase (`auth.uid`,
  `create policy`, `row level security`).

Sobre `IMMUTABLE`: `unaccent(text)` é declarada `STABLE` (depende do dicionário de
texto instalado). Declarar o invólucro como `IMMUTABLE` é o contorno documentado
para poder usar a função em índice e em coluna gerada, e vale porque o dicionário
`unaccent` não muda em produção. `set search_path = public` impede que a resolução
de nomes dependa de quem chama - o preço é a função não ser inlinada pelo planner,
e correção vem antes de micro-otimização.

As extensões (`unaccent`, `citext`, `pgcrypto`) são criadas `with schema public`
explicitamente, para não ficar à mercê de onde o provedor resolve instalá-las.

Os triggers `dm_normalizar_memoria` e `dm_normalizar_dicionario` recalculam as
colunas `_norm` a partir do texto cru **no banco**, garantindo consistência mesmo
se um cliente futuro (script de carga, migração, psql na mão) esquecer de
normalizar. `dm_touch` mantém `atualizado_em`: "quando este registro mudou" é dado
de auditoria e não deve ser falsificável por quem escreve.

## 5. Memória do cliente - a seção mais importante

### 5.1 O defeito da v1, e o que ele custou

> No v1 a exportação de memória só olhava linhas alocadas **COM destino
> preenchido**. A retirada era descartada. Resultado: na análise do mês seguinte o
> dicionário realocava exatamente a mesma conta no mesmo lugar errado, e o analista
> refazia o mesmo trabalho manual - todo mês, para sempre. A memória "aprendia" só
> metade do que o humano ensinava.

Quando o analista **retira** uma conta de uma linha da Shadow, ele está afirmando
"esta origem não pertence a este destino". É informação tão valiosa quanto a
alocação - em alguns casos mais, porque contradiz a heurística. Guardar só o lado
positivo é jogar fora metade do aprendizado, e o custo não é abstrato: é o mesmo
trabalho manual repetido em cada fechamento.

### 5.2 Três decisões

```
alocar      origem -> destino
nao_alocar  o humano retirou; nenhuma camada automática pode realocar
contexto    linha informativa/totalizador; capturada, mas não alocável
```

`destino` vazio é **normal e esperado** quando `decisao != 'alocar'` - a ausência
de destino é precisamente o conteúdo da decisão negativa. `EntradaMemoria` aceita
snake_case (API/banco) e camelCase (portal) no mesmo `de_dict()`, para não
espalhar tradutores pelo código e para o campo não chegar vazio sem ninguém
notar, que foi como a v1 perdeu grupo/sub em parte das entradas.

`aplicar_memoria(linhas, memoria)` **não muta as linhas**: devolve um plano com
quatro baldes.

| Balde | Significado |
|---|---|
| `aplicados` | memória diz `alocar` → a linha receberia este destino, `tipo_mapeamento: "Memória"` |
| `bloqueados` | memória diz `nao_alocar`/`contexto` → linha marcada como NÃO alocada, imune às camadas automáticas. **É o ganho sobre a v1** |
| `preservados` | a linha já tem destino, ou o humano a retirou nesta sessão (`noAuto`). Decisão existente nunca é sobrescrita - na v1 uma passada do dicionário depois da revisão desfazia correção manual |
| `sem_regra` | a memória não tem opinião; segue para dicionário e julgamental |

Cada bloqueio carrega um `motivo` textual, que é o que a Rastreabilidade exporta:
"por que esta linha não foi alocada" precisa ser respondível.

`buscar_entrada()` faz duas passadas - chave exata `(origem, grupo, sub)` e, na
falha, mesma origem com grupo/sub **compatíveis**, onde vazio de um lado é curinga
e valor diferente nos dois lados é **veto**. O veto implementa a regra absoluta:
sem ele, uma decisão tomada no Passivo vazaria para uma conta homônima do Ativo e
furaria `Ativo = Passivo + PL`. Desempate: quem o humano confirmou vence; depois, a
regra mais específica, porque foi tomada com mais contexto.

### 5.3 Versionada, nunca sobrescrita

`salvar_revisao()` sempre cria `max(revisao) + 1`. Nunca faz `UPDATE` nem `DELETE`
na memória existente.

> O custo é espaço em disco, que é barato; o benefício é a prova da decisão, que
> não tem preço quando o cliente questiona um número.

Reverter uma revisão ruim é ler a `N-1` e regravá-la como `N+1`, sem perder o
caminho. Um `UPDATE` destrutivo apagaria a prova.

Tudo numa transação só, e a leitura da revisão anterior acontece **dentro** dela:
calcular o diff fora abriria janela para outra gravação entrar no meio e o resumo
gravado descrever uma comparação que nunca existiu. O evento
`memoria.revisao_salva` é inserido na **mesma** transação - trilha que pode
divergir do fato não serve como trilha.

O campo `vezes` acumula quantas revisões seguidas confirmaram a mesma decisão. É o
sinal de confiança que o matching usa para desempatar: regra reconfirmada cinco
meses seguidos vale mais que palpite de ontem.

A unicidade é `(cliente_id, revisao, origem_norm, grupo_norm, sub_norm)` - sobre a
chave **normalizada**. "No v1 a unicidade sobre o texto cru permitia `Caixa Geral`
e `CAIXA GERAL ` conviverem apontando para destinos diferentes - matching não
determinístico, resultado dependente da ordem."

### 5.4 Opt-in, com o diff mostrado ANTES de gravar

`diff_memoria(anterior, nova)` é **lógica pura, sem banco**. Existe para o portal
mostrar ao analista o que vai mudar antes de qualquer escrita:

```
Salvar memória de SPE (exemplo)?   [x]
  -> 41 regras novas
  ->  7 alteradas (destino mudou)
  ->  3 marcadas "não alocar"
  -> 12 confirmadas sem mudança
```

> Memória que se grava sozinha é memória em que ninguém confia: basta uma análise
> ruim para envenenar o cliente e não há como saber quando aconteceu.

Uma entrada é **alterada** quando a chave é a mesma e o destino **ou a decisão**
difere. Incluir a decisão é essencial: "antes alocava em Mútuo Financeiro, agora
está marcada como não alocar" é a mudança mais importante que existe aqui, e
comparar só o destino a classificaria como inalterada.

`destino_mudou` e `decisao_mudou` são **disjuntos de propósito** no
`DiffMemoria.resumo()`. Uma entrada que virou `nao_alocar` também "perdeu o
destino", mas contá-la nas duas linhas do painel infla os números e **ensina o
analista a aprovar sem ler**. Trocar de destino continuando a alocar é uma
correção; virar `nao_alocar` é decisão de outra natureza.

A comparação de destino é normalizada: "Mútuo Financeiro" e "MUTUO FINANCEIRO" são
o mesmo destino, e apresentar isso como "7 alteradas" seria ruído com o mesmo
efeito pedagógico ruim.

`tem_mudanca()` evita abrir o painel quando nada mudou. O resumo aprovado é
gravado em `memoria_revisoes`, o que transforma "a memória mudou" em "o analista
aprovou 41 novas, 7 alteradas e 3 marcadas como não alocar em tal análise",
auditoria de verdade.

### 5.5 Aprende de análise conciliada

A intenção é que a memória aprenda apenas de análise concluída e conciliada - "um
rascunho quebrado nunca envenena a memória do cliente". O que existe hoje,
literalmente:

- `analises.conciliado` é **derivado, não informado**:
  `Boolean(b?.fecha) && Boolean(trilha?.ok) && !qa.bloqueado`. O cliente não pode
  declarar conciliado o que não fecha.
- `analises.status` é restrito pelo CHECK do banco a
  `rascunho | em_revisao | concluida`.
- o botão `salvar memória do cliente…` só existe na **etapa 4 (Resultado)** e está
  desabilitado sem `clienteId` - a memória é sempre de um cliente.
- com `status = 'concluida'` **e** bloqueio de Classe A pendente, a UI exibe um
  aviso de erro explícito: *"Não marque como concluída com bloqueio de Classe A
  pendente. A memória do cliente só deve aprender de análise conciliada - um
  rascunho quebrado envenena a memória e o erro reaparece em todas as análises
  seguintes."*

**A trava é de aviso, não de código.** O portal não impede tecnicamente o
salvamento de memória a partir de uma análise com bloqueio de Classe A; ele avisa,
e o diff (§5.4) força o analista a ver o que vai gravar. Endurecer isso para uma
trava dura é item de esforço baixo em <ref_file file="docs/11-roadmap.md" />.

Também vale registrar uma escolha do `DiffMemoria`: ele monta a proposta com
`memoriaDeRows(rows, { apenasConfirmadas: false })`. Esconder do painel as entradas
não confirmadas tiraria justamente o que o analista tem de olhar. O filtro por
confirmação existe na **promoção ao dicionário global** (§5.6), que é outra decisão.

### 5.6 O dicionário global recebe só o confirmado por humano

```python
def entradas_promoviveis(entradas):
    return [e for e in entradas
            if e.decisao == ALOCAR and e.confirmado_por_humano and e.destino.strip()]
```

> **POR QUE O FILTRO É TÃO ESTREITO:** no v1 um trigger de banco aprendia de TUDO
> que era gravado, incluindo sugestão de LLM que ninguém revisou. Um único erro de
> julgamento entrava no dicionário global e se propagava para a carteira inteira,
> em todas as análises seguintes, sem nenhum humano ter aprovado - e sem registro
> de quando entrou.

E o ponto menos óbvio: **`nao_alocar` nunca sobe, mesmo confirmada.** Ela é
específica do cliente. "Nesta SPE, adiantamento a sócios não é mútuo" é verdade
sobre *esta* empresa; promovida a global, bloquearia a alocação correta em todas as
outras. Decisão negativa vive em `memoria_cliente` e só lá.

O filtro é uma função separada de propósito: assim o teste da regra de negócio roda
**sem banco**, e o de escrita (que precisa de Postgres) fica isolado e pode dar
skip. Regra de negócio testável não deve depender de infraestrutura.

`promover_ao_dicionario` materializa `entradas` numa lista **antes** de filtrar,
porque o argumento pode ser um gerador e contar depois de consumir daria
`ignoradas = 0` - número errado num relatório de auditoria é pior que número
ausente.

### 5.7 O `ON CONFLICT` que era um no-op silencioso

```sql
on conflict (usuario_id, chave) do update ...
```

> No v1 o upsert declarava conflito apenas em `chave`, contra uma UNIQUE composta
> `(usuario_id, chave)`. O Postgres responde **42P10** - "there is no unique or
> exclusion constraint matching the ON CONFLICT specification" - porque a
> especificação precisa cobrir exatamente as colunas de alguma constraint. E o erro
> caía num `catch {}` vazio no cliente: o portal mostrava "dicionário atualizado" e
> NADA havia sido gravado. O aprendizado global do produto era um no-op silencioso,
> e ninguém percebeu porque a tela dizia o contrário.

A lição está embutida no código: erro de banco não é tratado com catch vazio; ou
sobe, ou é logado com o payload que o causou. O teste
`test_repo_declara_conflito_nas_duas_colunas_da_unique` guarda a regressão.

`registrar_evento()` é a única exceção deliberada - ela **nunca levanta**, porque
perder um salvamento de análise porque o log de auditoria caiu troca um problema
pequeno por um grande. Para o caso em que a trilha precisa ser atômica com o fato
(a gravação de revisão de memória), o insert é feito na mesma transação, dentro de
`memoria.py`.

## 6. Modo local no portal (`localStorage`)

`portal/src/lib/repo.js` tem **duas implementações com a mesma assinatura** para
cada método. `modoLocal()` devolve `true` quando não há URL de plano de dados
configurada, e a escolha é feita **por requisição, não no boot** - trocar a URL em
Configurações passa a valer na chamada seguinte, sem recarregar a página.

```js
export const CHAVES = Object.freeze({
  clientes: 'allocator:clientes',
  analises: 'allocator:analises',
  memoria:  'allocator:memoria',
  sessao:   'allocator:sessao',
});
```

Por que existe: o plano de dados é gratuito e tem cold start de ~50s, e o banco
hiberna. Nada disso é problema no uso normal, mas há dois cenários em que o portal
precisa funcionar sem servidor nenhum - demonstração (abrir o portal publicado e
mostrar o fluxo inteiro, com trilha de valor e painel de QA reais, sem depender de
rede) e desenvolvimento de front.

Quem chama não sabe em qual modo está. O único lugar que trata a diferença é a UI,
que avisa "modo local, sem servidor" - **esconder isso do usuário seria mentir
sobre onde o dado dele está.**

O modo local reproduz de propósito as regras do schema: apagar cliente
**desvincula** as análises (`clienteId = null`, espelhando o
`on delete set null`) e **apaga** a memória (que é do cliente e não sobrevive a
ele). E declara o que não faz: não versiona memória além de um contador
`revisao + 1` local, não promove nada ao dicionário global e não tem usuário.

Dois cuidados de robustez: JSON corrompido em `localStorage` não pode derrubar o
portal (o analista perderia a análise aberta por causa de um registro velho
ilegível), e cota estourada é o caso **real** - uma análise com 358 linhas mais
Shadow passa de 1 MB, e o limite típico é ~5 MB por origem - , então `gravar()`
levanta um `ErroApi` com a dica acionável em vez de falhar mudo.

O dicionário de **1.260 regras** vem do bundle
(`portal/src/core/data/dicionario.gen.js`), não da rede: é a base determinística e
o portal não pode depender de servidor para mapear conta. As regras de
`dicionario_global` só **somam**, e vêm marcadas com a `fonte` - o analista precisa
distinguir "regra curada" de "regra que eu ensinei". Falhar em buscar as extras não
impede o uso das 1.260.

## 7. Limites conhecidos

- **As rotas `/dados/*` não existem neste repositório.** `main.py` as registra
  condicionalmente (`from .db.rotas import router as router_dados`) e o módulo
  `server/app/db/rotas.py` não está implementado; a API loga
  `"rotas de dados indisponíveis (...) - API roda só a inferência"`. O `repo.py`, o
  `memoria.py`, o `auth.py` e o `schema.sql` estão prontos e testados, mas a
  camada HTTP que os expõe é o que falta. Ver
  <ref_file file="docs/11-roadmap.md" />.
- **Não há fila offline com reenvio automático.** Existe o modo local
  (`localStorage`) e existe tolerância a falha de rede no *polling* de `/read`
  (`MAX_FALHAS_SEGUIDAS = 8`), mas uma escrita que falha por servidor fora do ar
  não é enfileirada para reenvio posterior.
- Sem rate limit por usuário, sem auditoria de acesso a leitura e sem criptografia
  em repouso além da do provedor. Ver
  <ref_file file="docs/08-seguranca-guardrails.md" />, §"O que não está coberto".

## 8. Como isto é testado

`server/tests/test_memoria.py` - 53 blocos de teste, dos quais a maioria roda **sem
banco**:

| Bloco | O que prova |
|---|---|
| normalização | casa com os casos do JS · pontuação vira espaço e não vazio · caixa e acento não geram chaves diferentes · `chave_de` normaliza os três componentes |
| diff | entrada nova · destino alterado · **decisão alterada de `alocar` para `nao_alocar`** · removida · inalterada com grafia diferente · contagens do resumo · `destino_mudou` separado de `decisao_mudou` · dedupe com a última decisão vencendo |
| aplicar memória | preenche destino de linha homônima · **decisão negativa bloqueia em vez de alocar** · `contexto` também bloqueia · casa por chave normalizada · não sobrescreve destino existente · respeita retirada da sessão atual · **veta grupo divergente** · grupo vazio é curinga · ignora regra `alocar` sem destino · não muta as linhas |
| promoção | só `alocar` + confirmado · exige confirmação humana · **`nao_alocar` nunca sobe ao dicionário global** |
| schema (estático) | `dm_normalize` definida · dois `regexp_replace` · `unaccent` antes da função · extensões declaradas · CHECK de decisão e de status · UNIQUE de `memoria_cliente`, de `memoria_revisoes` e composta do dicionário · índice por `revisao desc` · **nada de Supabase** · `repo` declara conflito nas duas colunas · lista não traz jsonb pesado |
| com Postgres (skip sem `DATABASE_URL`) | schema idempotente · ciclo salvar/recarregar · **versiona sem apagar a anterior** · promoção grava só o confirmado · **`dm_normalize` do banco concorda com o Python** |

Os testes que exigem banco chamam `conexao.esta_configurado()` e dão `skip` com
motivo explícito quando não há `DATABASE_URL`. "Teste vermelho por falta de
infraestrutura treina o time a ignorar teste vermelho."
