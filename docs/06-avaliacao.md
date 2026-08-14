# Avaliação: o que é medido, com que limiar, e o que barra o merge

Este documento descreve como o ALLocator v2 prova que funciona: os golden
datasets, as categorias de teste com contagem real, os limiares do harness de eval
e o que exatamente cada job do CI impede de entrar no `main`. A tese que estas
medidas sustentam está em <ref_file file="docs/02-invariante-contabil.md" />.

## 1. O golden dataset

`server/eval/datasets/balancete_spe_exemplo.json` - balancete de verificação
real, TOTVS Protheus, relatório `CTBR040`, aba
`01-026001 - Balancete de Verif`, competência `05/2026`. O arquivo traz um bloco
`fatos` com o que precisa ser preservado, e as `rows` transcritas com
`valoresPorSlot` e `naturezaPorSlot`.

```json
"fatos": {
  "linhas": 358, "folhas": 224, "sinteticas": 134, "retificadoras": 13,
  "saldoAtual": {
    "ativo": 118035576.14, "passivoPl": 118724714.55,
    "receitas": 28281223.87, "despesas": 28970362.28,
    "resultado": -689138.41, "difSimples": -689138.41, "difEstendida": 0.0
  },
  "totaisDeclarados": { "1": "ATIVO", "2": "PASSIVO", "24": "PATRIMONIO LIQUIDO",
                        "3": "CUSTOS E DESPESAS", "4": "RECEITAS" }
}
```

### Por que um balancete é mais exigente que um ITR

Um ITR ou DFP publicado já vem com sinais aplicados, hierarquia visível por
indentação e resultado transportado ao PL. Ele exercita uma coisa: leitura de
tabela sem borda.

Este balancete exercita **três problemas independentes ao mesmo tempo**, e cada um
deles quebrava a v1 por conta própria:

| Problema | Por que só um balancete o exercita | Custo medido do erro |
|---|---|---|
| **natureza D/C em coluna separada** | publicação já traz o sinal embutido; ERP emite tudo positivo com a natureza numa coluna de texto | Ativo inflado em **R$ 26.534.262,98**, Passivo em **R$ 124.618.951,48** (24 contas com natureza contrária ao próprio grupo) |
| **hierarquia por prefixo de código** | publicação não tem código contábil, só indentação; aqui os códigos não têm ponto (`11010100000071`) e faltam níveis intermediários | as 358 linhas tratadas como analíticas → balanço multiplicado por ~3 (118 MM → ~382 MM) |
| **balancete não encerrado** | publicação sempre tem o resultado transportado ao PL | diferença de **R$ 689.138,41** parecendo erro quando é exatamente o resultado do período |

E o arquivo é contabilmente **perfeito**: débito total = crédito total =
**R$ 65.083.272,00**. Isso é o que torna o dataset útil como referência - qualquer
divergência é do nosso processamento, nunca da fonte. A ausência de transporte está
confirmada documentalmente pela aba oculta `Parametros` do próprio arquivo
(`Pergunta 22 : Posicao Ant. L/P ? = 'Nao'`).

Um dataset que exercita um problema por vez não pega interação entre eles. Aqui, a
verificação de leitura só passa se as três coisas estiverem certas
**simultaneamente**: aplicar D/C sem detectar folha corretamente compara uma soma
errada contra um total certo, e vice-versa.

O mesmo arquivo é consumido pelos dois lados - `portal/test/balancete.test.mjs`
(JS, pipeline completo) e `server/tests/test_balancete.py` (Python, adaptador de
leitura) - o que também prova que as duas implementações concordam.

## 2. Categorias de teste

### 2.1 Cobertura das fórmulas, em **build time**

`scripts/gen_knowledge.py --check` falha o build se:

| Verificação | Implementação |
|---|---|
| são exatamente **79 contas alocáveis** e **28 subtotais** | `carregar_lock()`, comparação literal |
| nenhuma linha é contada nos **dois** lados do balanço | `set(ativo) & set(direita)` |
| cada uma das **56 posições de Ativo/Passivo** entra em **exatamente um** total | `contar_folhas(shadow["AP"], 41)`, `72`, `80`; `n != 1` é erro |
| nenhuma conta alocável fica **fora** de todo total | `aloc_ap - cobertas` |
| o grafo não agrega linha que **não é** conta alocável | `cobertas - aloc_ap` |
| na DRE, `agg` e alocáveis coincidem exatamente | `dre_agg != aloc_dre` |
| todo destino do lock aparece em `plano-de-contas.md` | `validar_md_contra_lock` |
| toda regra do dicionário resolve para conta alocável (não subtotal, não inexistente) | `carregar_dicionario` |

Isto é diferente de um teste: é **prova de propriedade estrutural antes de o código
rodar**. A raiz do Ativo é a linha 41, e o lado direito é `72 + 80`; o algoritmo
percorre o grafo de fórmulas contando quantas vezes cada folha é somada. Contagem
`!= 1` significa dupla contagem ou sinal invertido no grafo, e o build para.

Os espaços do plano de contas são significativos (`-  Despesas Financeiras` tem
dois; `Resultado da Exploração ` termina com um). `plano-de-contas.lock.json`
congela isso e o gerador falha se mudar - no `.md`, para humanos, o espaço
significativo é marcado com `␣`.

### 2.2 Integridade do dicionário

**1.260 regras** em `knowledge/dicionario.csv` (1.261 linhas, uma de cabeçalho),
todas resolvendo para conta alocável. A auditoria da migração está em
`knowledge/auditoria-dicionario.md`: das **1.285** entradas da v1, 1.054 tinham
destino exato, 225 foram corrigidas por regra explícita, 4 resolvidas por nome
único, 2 eram cabeçalho de seção (removidas) e 23 eram duplicatas.

O resumo termina com três zeros que são o ponto:

| | Entradas |
|---|---:|
| **ambígua** (nome existe em 2 grupos) | **0** |
| **destino inexistente** | **0** |
| **destino é subtotal** (valor evaporaria) | **0** |

Na v1, **229 das 1.285 (17,8%)** apontavam para destino com grafia divergente, e a
agregação usava chave não normalizada. O valor era descartado **sem erro no QA**.

### 2.3 Verificação de leitura

`verificar_sinteticas` confere cada sintética contra a soma das suas folhas, coluna
por coluna. A docstring registra a medição no relatório completo: **134 sintéticas ×
5 colunas = 670 assertivas**, zero divergência com D/C aplicado.

E a contraprova, que é o que dá valor à métrica: **sem** D/C, **72** divergências
somando as 5 colunas e **22** só na coluna `Saldo Atual`, com a raiz `ATIVO`
acusando exatamente **R$ 26.534.262,98**. Detalhe - inclusive a nota de que a
fixture JSON carrega três colunas de saldo e não cinco - em
<ref_file file="docs/03-leitura-documento.md" />.

### 2.4 Conservação de valor

`★ INVARIANTE - conservação de valor: nada some entre a folha e a Shadow`. Por ano:

```
Σ(folhas alocadas) = Σ(alocado) + Σ(órfão) + Σ(subtotal) + Σ(sem destino) + Σ(lado trocado)
```

O teste exige `trilha.ok === true` e **zero** em cada balde de perda, além de
`alocado ≈ agregado` - o que a trilha diz que foi alocado tem de ser o que a
agregação realmente produziu.

### 2.5 Identidade

`CAUSA 1` prova que a identidade **simples** não fecha e a **estendida** fecha:
`dif = -689.138,41`, `difEstendida = 0,00`, `naoEncerrado = true`,
`transporteSugerido = -689.138,41`. E prova que o QA emite `level: 'action'` (exige
um clique consciente), **não** `error` - e que não acusa `identidade`, porque não é
erro.

`★ INVARIANTE - com o transporte, o balanço fecha em 0,00` fecha o ciclo:
`dif ≈ 0,00`, `passivoPl` passa a `118.035.576,14`, e a lista de bloqueantes de
Classe A é **vazia**.

### 2.6 Imunidade a erro de julgamento

O teste que sustenta a arquitetura:
`★ INVARIANTE - o fechamento NÃO depende de qual conta o LLM escolheu`.

Sorteia **15 mapeamentos** do balancete real com um LCG de semente fixa (portanto
reprodutível). Em cada um, cada folha vai para **outra** conta compatível dentro do
mesmo bloco, respeitando duas restrições:

1. o **lado** do balanço;
2. a **compatibilidade de sinal** (`signIsValid`) - destinos `neg`/`pos` gravam
   `Math.abs()`, e mandar um valor de sinal contrário para lá inverte a
   contribuição;

e excluindo as **6 posições de memorando da DRE** (`POSICOES_MEMO_DRE`), que não
alcançam o Lucro Líquido e portanto não são escolhas equivalentes.

Os 15 produzem exatamente o mesmo fechamento:

```js
assert.equal(new Set(difs.map((d) => Math.round(d * 100))).size, 1);
```

Enunciado preciso: **o fechamento é invariante a qualquer realocação que preserve
lado e compatibilidade de sinal** - que são exatamente as duas condições de
Classe A que o código verifica. Logo, o LLM pode errar qual conta e o balanço
continua fechando.

O mapeamento base (`mapearGrosseiro`) é **deliberadamente grosseiro**, sem nenhuma
pretensão de correção contábil. É o ponto: se o balanço fecha com um mapeamento
ruim mas estruturalmente válido, o fechamento é independente da qualidade do
julgamento.

Complementando, três testes provam que o que **deve** quebrar quebra:

| Teste | Prova |
|---|---|
| `DETECÇÃO - alocar em subtotal é bloqueado` | `destino-subtotal`, `qa.bloqueado = true`, e o valor desviado aparece em `trilha.subtotal` em vez de evaporar |
| `DETECÇÃO - sinal incompatível com o destino é BLOQUEADO` | `RECUPERACAO DE DESPESAS` (crédito no grupo 3) para destino `neg` → Classe A. "No v1 a checagem equivalente rodava sobre o valor já em módulo e nunca disparava" |
| `DETECÇÃO - lado trocado é bloqueado` | conta de Ativo para `Bancos` (Passivo\|Circulante) → `lado-trocado`, mensagem citando `2x o valor` |

E `TEMPLATE - 6 posições da DRE ficam fora da cadeia do resultado` afirma
`POSICOES_MEMO_DRE.size === 6` e lista os nomes: depreciação/amortização de imob e
intang (16), depreciação/amortização dos arrendamentos (17), despesas/custo de
aluguel (19) - add-back do EBITDA - e resultados abrangentes (36), dividendos (39),
participações minoritárias (40) - abaixo da linha do lucro líquido.

### 2.7 Red team

`server/tests/test_seguranca.py` e `server/tests/test_llm_guardrails.py`. Detalhe
completo em <ref_file file="docs/08-seguranca-guardrails.md" />; aqui basta
registrar que o job de CI correspondente roda **sem instalar dependência
alguma**.

### 2.8 Paridade de normalização

`server/tests/test_normalize_parity.py` executa o `normalize.js` real com o Node e
compara contra as duas implementações Python, sobre um `CORPUS` de casos reais que
já quebraram. Ver <ref_file file="docs/05-dados-persistencia.md" />, §4.

### 2.9 Contagem real

| Suíte | Testes | Comando |
|---|---|---|
| portal (núcleo contábil) | **60** | `cd portal && node --test test/*.test.mjs` |
| servidor | **201** | `python -X utf8 server/run_tests.py` |

Os 60 do portal se dividem em quatro arquivos: `balancete.test.mjs` (o invariante),
`planoContas.test.mjs`, `pipeline-ui.test.mjs` e `imports.test.mjs`. Este último
percorre todo arquivo `.js`/`.jsx`/`.mjs` de `portal/src`, extrai os imports e
resolve cada um contra o disco e contra o `package.json` - existe porque nesta
máquina o registry do npm está bloqueado, então `npm run build` não roda aqui, e
sem o bundler um caminho de import errado ou uma dependência esquecida só
apareceria no deploy.

Os 201 do servidor vêm de 140 funções `test_*` em seis arquivos, expandidas pelos
`mark.parametrize`.

## 3. O harness de eval (`server/eval/run_eval.py`)

Além das suítes, existe um harness que **mede e bloqueia**. Cada métrica tem
limiar, e o processo sai com código 1 quando qualquer um é violado:

```python
LIMIARES = {
    "leitura_divergencias":          0,      # exato
    "conservacao_perda_centavos":    0,      # exato
    "identidade_residuo_centavos":   1,      # 1 centavo de arredondamento
    "hierarquia_erros":              0,      # exato
    "recall_contas":                 0.98,
    "acuracia_valores_posicional":   0.995,
}
```

Quatro deles são **exatos**, e não é rigor gratuito: leitura e conservação de valor
são propriedades algébricas, e "quase" não existe. Recall e acurácia de mapeamento
admitem margem porque dependem de julgamento.

**Duas ressalvas honestas sobre este dicionário.** `recall_contas` e
`acuracia_valores_posicional` estão **declarados e não são consumidos por nenhuma
métrica** de `avaliar_balancete` - eles existem como contrato para quando houver um
dataset com gabarito de mapeamento por linha, e hoje não há. E
`conservacao_perda_centavos` também não é referenciado: a conservação é provada em
`portal/test/balancete.test.mjs` (`★ INVARIANTE - conservação de valor`), que roda
com o pipeline completo, e o harness a alcança indiretamente via `rodar_suites()`.
As métricas efetivamente calculadas hoje são: hierarquia, leitura, poder de
detecção sem D/C, identidade estendida, diferença == resultado do período,
reconstrução independente da identidade e os três totais reconstruídos.

Duas métricas do harness merecem destaque por serem **contraprovas**:

- `poder de detecção (divergências sem D/C)`, com limiar **`>= 1`**. Um harness que
  passa mesmo com a leitura errada não está medindo nada. Se esse número cair a
  zero, o teste de leitura perdeu poder de detecção.
- `reconstrução independente da identidade`: soma as folhas por grupo e confere
  `Ativo − (Passivo+PL) − resultado ≈ 0`, **sem usar os totais pré-calculados na
  fixture**. É a contraprova de que os números da fixture não estão apenas se
  confirmando a si mesmos. O comentário registra que essa métrica pegou um erro
  real na primeira execução: escrever `grupo 4 − grupo 3` em vez de `3 + 4`, já que
  com a convenção de contribuição assinada as duas já são contribuições ao lucro.

`rodar_suites()` executa `run_tests.py` e `node --test`, e converte o resultado em
métrica. "Um harness de eval que ignora a suíte de testes mede a metade errada do
problema: as propriedades algébricas estão provadas lá, com o pipeline completo."

## 4. A crítica honesta ao eval da v1

Vale registrar porque é o erro de método mais instrutivo do projeto. O eval da v1
comparava valores assim:

```python
any(abs(g - esperado) < 0.51 for g in obtidos)
```

Isso testa **pertinência a um conjunto**, não **posição**. Um par de períodos
trocado na mesma linha marcava 100% de acurácia - `{2024: 100, 2025: 200}` e
`{2024: 200, 2025: 100}` são indistinguíveis para `any(...)`.

Ou seja: **o harness era cego justamente à troca de coluna que motivou o módulo de
reconciliação.** Ele media a extração e declarava sucesso enquanto o defeito que
importava passava batido.

A métrica correta é **posicional**: cada valor comparado na coluna a que pertence,
identificada pelo rótulo do período. É o que `acuracia_valores_posicional`
significa, e o nome carrega a correção de propósito.

O segundo defeito era de gate. A v1 só chamava `sys.exit(1)` em erro de rede ou de
job - uma **queda de acurácia passava sem ninguém notar**. E, mesmo com o exit
correto, o eval nunca rodava automaticamente: era um script que alguém executava
quando lembrava.

Terceiro: a v1 media apenas a extração. Aqui medimos as quatro coisas que sustentam
a tese - leitura, conservação, identidade e imunidade a erro de julgamento.

## 5. O gate de CI (`.github/workflows/ci.yml`)

Cinco jobs, em `push` para `main`, `pull_request` e `workflow_dispatch`, com
`cancel-in-progress`.

| Job | O que roda | O que barra |
|---|---|---|
| **`nucleo-contabil`** | `node --test test/*.test.mjs` no `portal`, **sem instalar nada** | invariante contábil quebrado, conservação furada, imunidade a julgamento perdida, detecção de Classe A regredida. Roda sem dependência porque o núcleo é puro por decisão de arquitetura - e `imports.test.mjs` garante que continue assim |
| **`base-de-conhecimento`** | `gen_knowledge.py --check`, depois `gen_knowledge.py` + `git diff --exit-code` | cobertura das fórmulas quebrada; regra de dicionário apontando para destino inexistente ou subtotal; **artefato `.gen.js` editado à mão** (a fonte de verdade e o que roda ficariam diferentes) |
| **`servidor`** | `pip install -r requirements.txt -r requirements-dev.txt`, então `python -m pytest server/tests -q` **e** `python server/run_tests.py` | qualquer regressão de leitura, guardrail, memória, paridade de normalização - **e divergência entre o pytest real e o shim** |
| **`portal`** | `npm ci` (ou `npm install` sem lockfile) + `npm run build`, publicando `package-lock.json` como artefato | portal que não compila |
| **`red-team`** | `run_tests.py seguranca -v` e `run_tests.py llm_guardrails -v`, **sem instalar dependência nenhuma** | guardrail que parou de barrar o que deveria - e, se um guardrail passar a exigir uma lib, o job falha, que é exatamente o alarme desejado |

O `nucleo-contabil` e o `red-team` rodarem sem instalação não é economia de tempo:
é a verificação de uma **propriedade arquitetural**. O núcleo contábil e os
guardrails são lógica pura, e o CI é o lugar onde isso deixa de ser promessa.

O comentário no topo do arquivo lista o contrato em linguagem direta:

```
Aqui o build FALHA quando:
  · alguma das 56 posições de Ativo/Passivo não entra em exatamente um total
  · alguma regra do dicionário aponta para destino inexistente ou subtotal
  · o invariante contábil não fecha no golden dataset real
  · a normalização divergir entre JS, Python e SQL
  · um guardrail de segurança parar de barrar o que deveria
  · o portal não compilar
```

### Uma lacuna honesta

`server/eval/run_eval.py` **não é chamado por nenhum job do CI**. As propriedades
que ele mede estão cobertas indiretamente - os datasets são exercitados por
`test_balancete.py` e `balancete.test.mjs`, que rodam nos jobs `servidor` e
`nucleo-contabil` - mas os limiares nomeados de `LIMIARES` e as métricas de
contraprova ficam fora do gate automático. Ver
<ref_file file="docs/11-roadmap.md" />.

## 6. `run_tests.py` e o shim de pytest

### Por que existe

A máquina de desenvolvimento está atrás de um proxy corporativo que **bloqueia o
PyPI** (SSL handshake failure). `pip install pytest` não funciona lá. Mas os testes
de lógica - clusterização de colunas, parsing de número, guardrails anti-injeção,
adaptador de balancete, diff de memória - são justamente os mais críticos e
precisam rodar em qualquer lugar.

A solução é um **shim mínimo da API do pytest**, injetado em `sys.modules` **antes**
de importar os módulos de teste:

```python
TEM_PYTEST_REAL = importlib.util.find_spec("pytest") is not None
if not TEM_PYTEST_REAL:
    _instalar_shim()
```

O shim cobre `fixture` (incluindo geradoras com `yield` e `autouse=True`),
`mark.parametrize`, `mark.skipif`, marcas desconhecidas como no-op, `raises` (com
`match`), `approx` (com `abs` e `rel`), `skip`, `fail`, `MonkeyPatch` como
anotação de tipo, e uma implementação própria de `monkeypatch` com
`setattr`/`setenv`/`delenv`/`setitem`/`undo`, recriada por teste e desfeita no fim.

Onde o pytest real existe - o notebook servidor e o CI - ele é usado e o shim nem é
criado. Os testes são escritos com a API do pytest normalmente; nada no código de
teste sabe qual runner está ativo.

### Por que o CI roda nos DOIS modos

```yaml
- name: Testes com pytest real
  run: python -m pytest server/tests -q

- name: Testes com o runner próprio (valida o shim)
  run: python -X utf8 server/run_tests.py
```

O comentário no `ci.yml` diz o motivo em uma linha: **"Rodar nos dois modos é de
propósito: garante que o shim não mascara nada."**

Um shim tem duas maneiras de mentir. Pode ser mais permissivo que o pytest - uma
fixture que o shim resolve por acidente e o pytest recusaria, ou um `parametrize`
que expande diferente - e aí o desenvolvedor vê verde numa suíte que o CI real
reprovaria. Ou pode ser mais restritivo, e aí o inverso. Rodando os dois, uma
divergência de comportamento aparece como job vermelho no lugar em que dá para
consertá-la, e não como surpresa no notebook servidor.

Uso:

```powershell
python -X utf8 server/run_tests.py                 # tudo
python -X utf8 server/run_tests.py balancete -v    # filtra pelo nome do arquivo
python -X utf8 server/run_tests.py seguranca -v
```

### Testes que exigem dependência ausente dão skip com motivo

`_exige_libs_pdf()` e `_exige_pydantic()` pulam com razão explícita, e os testes
que precisam de Postgres consultam `conexao.esta_configurado()`. A regra do projeto
é dura aqui: **nunca deixe um teste falhar silenciosamente por falta de
dependência**, e nunca deixe um teste vermelho por falta de infraestrutura - teste
vermelho crônico treina o time a ignorar teste vermelho.
