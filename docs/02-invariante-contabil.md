# O invariante contábil: por que `Ativo = Passivo + PL` fecha por construção

> Este é o documento central do ALLocator v2. Ele explica a decisão de
> arquitetura que separa o que a IA decide do que o código garante.

## 1. O problema, e por que a v1 não conseguia resolvê-lo

Na v1, `Ativo = Passivo + PL` era **verificado no fim**:

```js
const dif = ativo - passivoPl;
balance[ano] = { ativo, passivoPl, dif, ok: Math.abs(dif) < 0.5 };
```

Quando `dif != 0`, o sistema informava a diferença e sugeria: *"investigar: conta
sem destino, dupla contagem, sinal ou grupo trocado"*. Ou seja, devolvia o
problema para o analista sem nenhuma pista de onde ele estava.

E o problema era real: **229 das 1.285 regras do dicionário (17,8%) apontavam
para destinos que não existiam com aquela grafia no template**. A agregação
usava `Map.get()` com chave montada só com `trim()`, então `Mútuo Financeiro L/P`
não encontrava `Mútuo Financeiro LP`, o valor virava `0` e **desaparecia sem
gerar erro** - porque o QA localizava a conta por uma comparação normalizada e
concluía que estava tudo bem.

Como `Mútuo Financeiro L/P` (97 ocorrências) e `Bancos L/P` (41) são contas de
Passivo Não Circulante, o lado direito perdia valor de forma sistemática. Daí o
sintoma constante: `Ativo > Passivo + PL`.

O defeito de fundo não era o bug de chave. Era a **ausência de qualquer
verificação de conservação**: nada no sistema perguntava *"a soma do que entrou é
igual à soma do que saiu?"*.

## 2. A tese

> Se **(1)** o documento de origem fecha consigo mesmo e **(2)** a alocação é uma
> função total das folhas para as 79 posições, sem perda e sem duplicata, então o
> balanço alocado **fecha necessariamente**.

A razão é simples: a alocação não cria nem destrói valor. Ela apenas
**reetiqueta** uma partição das contas analíticas. Se o documento respeita a
identidade e a reetiquetagem preserva a soma dentro de cada lado, a identidade
sobrevive.

Isso converte o fechamento de esperança em consequência. E, mais importante,
torna a falha **localizável**: se não fecha, uma das duas premissas caiu, e cada
uma é medida por um mecanismo próprio.

| Premissa que caiu | Mecanismo que detecta | Onde corrigir |
|---|---|---|
| (1) leitura | `verificarSinteticas` - cada conta sintética contra a soma das suas folhas | um bloco entre ~6, não o documento inteiro |
| (2) cobertura | `trilhaDeValor` - Σ(folhas) = Σ(alocado) + Σ(perdas), com as perdas nomeadas | a linha exata |
| (2) duplicação | `codigo-duplicado` e `dupla-contagem` (pai e filhos ambos alocados) | a linha exata |

## 3. Imunidade a erro de julgamento

Esta é a parte que sustenta o uso de um modelo de linguagem local e pequeno.

Olhando o grafo de fórmulas do template (`knowledge/formulas-shadow.md`):

```
Ativo        = linha 41 = 22 + 30 + 40
Passivo + PL = linha 72 + linha 80
               linha 72 = 61 + 71        (Circulante + Não Circulante)
               linha 80 = 75 + 79        (Minoritários + PL)
```

Como Passivo Circulante, Passivo Não Circulante, Minoritários e PL **todos
desembocam em `Passivo + PL`**, qualquer realocação dentro desse conjunto é
**neutra para o fechamento** - inclusive trocar Circulante por Não Circulante ou
por PL. O mesmo vale dentro do Ativo.

Só três coisas quebram a identidade:

| # | Condição | Por quê |
|---|---|---|
| A | atravessar o lado (Ativo ↔ Passivo, BP ↔ DRE) | o valor sai de um lado e entra no outro: erro de 2× |
| B | cair num subtotal | subtotais são `kind:"calc"`, não têm bucket de agregação - o valor evapora |
| C | cair num destino inexistente | chave órfã: o valor não entra em nenhuma linha |

E existe uma quarta, descoberta durante a implementação:

| # | Condição | Por quê |
|---|---|---|
| D | sinal incompatível com o destino | destinos com prefixo `-`/`+` gravam `Math.abs()`; se o sinal já não concordava com a direção do destino, a contribuição sai invertida |

**Essas quatro, e apenas essas quatro, são verificações bloqueantes de código.**
Qual conta exatamente dentro do bloco correto é julgamento revisável: afeta KPI e
composição, nunca o fechamento.

### A prova experimental

O teste `★ INVARIANTE - o fechamento NÃO depende de qual conta o LLM escolheu`
(<ref_file file="portal/test/balancete.test.mjs" />) gera **15 mapeamentos
diferentes** do balancete real, cada um sorteando outra conta dentro do mesmo
bloco, respeitando apenas lado e compatibilidade de sinal. Os 15 produzem
exatamente o mesmo fechamento: diferença `0,00`.

Ou seja: a qualidade do julgamento afeta a **utilidade** do resultado, não a sua
**correção aritmética**. É por isso que `qwen2.5:7b` rodando local é suficiente.

## 4. Classe A e Classe B

Toda validação do QA é classificada:

**Classe A - bloqueante, verificada por código.** Não é opinião, é álgebra.
- `valor-ilegivel` - célula que não foi interpretada como número
- `leitura` - sintética que não bate com a soma das folhas
- `destino-invalido` - não existe no plano (condição C)
- `destino-subtotal` - não é alocável (condição B)
- `lado-trocado` - atravessou o lado (condição A)
- `sinal-incompativel` - `abs()` inverteria a contribuição (condição D)
- `codigo-duplicado` - a mesma conta duas vezes: dupla contagem real
- `dupla-contagem` - totalizador e aberturas ambos alocados
- `orfao` - bucket agregado sem posição correspondente
- `valor-perdido` / `conservacao` - a trilha não fecha
- `identidade` - não fecha nem a simples nem a estendida
- `nao-encerrado` - nível `action`: não bloqueia, mas exige um clique consciente

**Classe B - revisável por humano.** Nunca bloqueia.
- qual conta exatamente dentro do bloco
- Circulante vs Não Circulante (ambos entram na linha 72)
- `destino-inconsistente`, `irmaos`, `retificadora`, `zerada`,
  `baixa-confianca`, `dicionario`, `subcat`, `atencao-destino`

Um erro do modelo de julgamento gera Classe B. **Ele não consegue gerar Classe A,
porque o guardrail rejeita a sugestão antes de ela entrar na Rastreabilidade.**

## 5. A identidade estendida

Um balancete cujo resultado ainda não foi transportado ao Patrimônio Líquido
**não fecha pela identidade simples, por definição**. A que vale é:

```
Ativo = Passivo + PL + (Receitas − Despesas)
```

Medido no caso real (`Balancete SPE (exemplo) 05.2026`, TOTVS Protheus):

```
Ativo                        118.035.576,14
Passivo + PL                 118.724.714,55
diferença                       -689.138,41
Lucro Líquido (linha 35)        -689.138,41   <- idêntico
resíduo da estendida                   0,00   <- exato
```

E vale independentemente nas três colunas do relatório:

```
Saldo Anterior (30/04)   dif -331.176,52   resultado -331.176,52   resíduo 0,00
Mov Período (maio)       dif -357.961,89   resultado -357.961,89   resíduo 0,00
Saldo Atual (31/05)      dif -689.138,41   resultado -689.138,41   resíduo 0,00
                                           soma coerente: -331.176,52 + -357.961,89 = -689.138,41
```

Confirmado documentalmente pela aba oculta `Parametros` do próprio arquivo:
`Pergunta 22 : Posicao Ant. L/P ? = 'Nao'` e `Pergunta 23 : Data Lucros/Perdas ? =
'31/12/2025'` - o resultado não foi transportado e as contas de resultado
acumulam desde o último encerramento.

Quando a estendida fecha e a simples não, **a diferença não é erro: é o resultado
do período, e o valor exato do transporte já é conhecido.** O sistema explica em
vez de acusar:

> ANO3: balancete não encerrado. Ativo 118.035.576,14 − (Passivo+PL)
> 118.724.714,55 = -689.138,41, que é exatamente o resultado do período
> (-689.138,41). Transporte o resultado para o PL para fechar.

Com um clique, o transporte é aplicado e a diferença vai a `0,00`.

### O detalhe que fazia a v1 piorar a situação

A v1 tinha um botão de transporte, acionado por heurística de 1%. Mas a linha
inserida passava **outra vez** por `applySignToRows`, e com `isBalancete` ligado o
`sinalGrupo('Passivo') = -1` **negava o valor**. A diferença crescia 2× o
resultado em vez de fechar. No v2 a linha nasce com `_sinalAplicado: true` e o
pipeline a respeita.

## 6. Apresentação × gravado: a distinção que eu errei primeiro

Cada valor existe em três formas, e confundi-las custa caro:

| Forma | Regra | Para que serve |
|---|---|---|
| `valoresRaw` | como está no documento | auditoria |
| `valoresApresentacao` | §14.2 - natureza D/C aplicada | **contribuição assinada ao bloco**; é o que se compara com o documento |
| `valoresPorSlot` | §14.1 - prefixo do destino aplicado | valor a gravar; alimenta a Shadow |

Na primeira versão deste módulo eu rodei a verificação de leitura sobre o valor
**gravado**. Resultado: `COFINS` e `ISSQN` (natureza D dentro do grupo 4, isto é,
dedução de receita) casam o dicionário para `-Impostos`, sofrem `Math.abs()`, e o
bloco `43 DEDUÇÕES DA RECEITA BRUTA` passou a "não fechar" por R$ 7.954.956,08,
sendo que a leitura estava perfeita. A suíte pegou.

**A verificação de leitura tem de usar a apresentação.** O valor gravado é uma
convenção interna do template, não um fato do documento.

## 7. A convenção que faz tudo colapsar numa regra

`valoresApresentacao` é definido como **contribuição assinada ao próprio bloco**:

| Bloco | Positivo significa | Natureza natural |
|---|---|---|
| Ativo | aumenta o Ativo | débito |
| Passivo / PL | aumenta Passivo + PL | crédito |
| DRE | aumenta o **lucro** | crédito |

Com isso, uma conta retificadora sai negativa **automaticamente**, sem precisar
saber se é "despesa" ou "receita": crédito dentro do Ativo é negativo, débito
dentro da DRE é negativo.

Isso importa porque os grupos de resultado **não são homogêneos**. No arquivo
real, o grupo 3 (Custos e Despesas) contém `39 OUTRAS RECEITAS` (credora) e o
grupo 4 (Receitas) contém `43 DEDUÇÕES DA RECEITA BRUTA` (devedora). Qualquer
regra baseada no grupo erra nesses casos.

Duas consequências:

1. a soma das contribuições das folhas reproduz o subtotal declarado em
   **qualquer** bloco - é o que permite as 134 verificações de leitura;
2. o resultado do período é simplesmente `soma(grupo 3) + soma(grupo 4)`, sem
   subtração e sem caso especial.

## 8. Por que a natureza é da LINHA, nunca do grupo

A v1 fazia `valor * sinalGrupo(grupo)`, com `-1` para todo Passivo/PL. Isso
pressupõe que toda conta de um grupo tem a natureza normal daquele grupo.

No balancete real, **24 contas têm natureza contrária ao próprio grupo**:

| Onde | Contas | Valor |
|---|---|---|
| Ativo com saldo **credor** | `(-) PCLD`, `(-) AMORT.ACUM.SOFTWARES`, `(-) AMORT.ACUM.BENFEITORIAS`, +7 | R$ 13.267.131,49 |
| Passivo com saldo **devedor** | `( - ) JUROS DEBENTURES` (×2), `(-) PREJUIZOS ACUMULADOS` | R$ 62.309.475,74 |
| Grupo 3 com saldo credor | `RECUPERACAO DE DESPESAS`, `REVERSAO DE CONTINGENCIAS`, +5 | R$ 640.105,03 |
| Grupo 4 com saldo devedor | `PIS`, `COFINS`, `ISSQN`, `ABATIMENTOS CONCEDIDOS` | R$ 4.538.453,13 |

Ignorar a natureza inflava o Ativo em **R$ 26.534.262,98** e o Passivo em
**R$ 124.618.951,48**. E multiplicar o grupo por `-1` **não resolve**, porque o
erro é intra-grupo.

O teste `LEITURA - ignorar o D/C faz a verificação FALHAR` prova o contrário: sem
a natureza, 22 blocos divergem só na coluna Saldo Atual, e a raiz `ATIVO` acusa
exatamente os R$ 26.534.262,98.

## 9. Uma descoberta sobre o template

Ao construir o teste do invariante, descobri que **6 das 23 posições alocáveis da
DRE não alcançam a linha 35 (`Lucro Liquido`)**:

*Add-back do EBITDA* - a linha 18 é `EBITDA = +15 +16 +17 −14`. A depreciação já
está dentro das despesas que formam o EBIT (linha 15); estas posições existem
para **divulgar** quanto dela era depreciação, permitindo somar de volta:
- 16 `- Depreciação e amortização (imob e intang)`
- 17 `- Depreciação/Amortização dos Arrendamentos Op.`
- 19 `- Despesas/Custo de Aluguel`

*Abaixo da linha do lucro líquido* - vêm depois do resultado por definição:
- 36 `+/- Resultados Abrangentes` (só entra na linha 37)
- 39 `- Dividendos`
- 40 `+/- Participações Minoritárias`

Não é bug do template: é o desenho dele. Mas um valor alocado só nessas posições
**não chega ao resultado**, e isso era invisível. A trilha de valor passou a
registrar esse balde separadamente (`memoDre`, que **não** é perda - o valor está
na Shadow), e a mensagem de diferença o cita como origem provável do resíduo em
vez de dizer "investigue".

## 10. A trilha de valor

O painel que a v1 não tinha. Por ano:

```
Σ(folhas alocadas)  =  Σ(chegou numa posição)
                     + Σ(chave órfã)
                     + Σ(alocada em subtotal)
                     + Σ(marcada "Sim" sem destino)
                     + Σ(lado trocado)
```

Nada some sem aparecer numa dessas linhas. Se a igualdade não vale, existe um
vazamento **não classificado**, e isso é Classo A - o sistema admite que não sabe
onde o dinheiro foi, em vez de mostrar um total plausível e errado.

A trilha também confere `Σ(alocado)` contra o que a agregação realmente produziu,
para pegar divergência entre a contagem e o `Map` da Shadow.

## 11. Uma trava que foi removida de propósito

O template Excel tem colunas `Retirar` (J:M) e `Adicionar` (N:Q) na aba Shadow.
Elas **violam a conservação de valor por construção**: nada obriga um `Adicionar`
a ter um `Retirar` correspondente, e as fórmulas de `Adicionar` não filtram por
`Alocação = "Sim"`.

Na v1 esse mecanismo existia em `shadow.js` mas era **código morto**
(`opts.adjustments` nunca era passado) - e foi sorte. O ajuste real era feito
mutando a própria linha (trocar destino, marcar como contexto), o que **preserva**
a conservação.

No v2 o código morto foi removido e o modelo de mutação da linha é o único
caminho. É uma decisão deliberada: a planilha original permitia furar o
invariante; o v2 não permite.

## 12. Tolerância

```js
tolerancia = max(0.5, |ativo| * 0.0005)   // 0,05% do Ativo, piso de R$ 0,50
```

A v1 usava `< 0.5` absoluto, o que é incoerente em ambas as pontas: para valores
em unidades é frouxo, e para um Ativo de R$ 118 milhões um resíduo de
arredondamento de R$ 1,00 reprovava um balanço legitimamente fechado. O guia
operacional original especifica ~1% do Ativo; 0,05% é bem mais rigoroso e ainda
absorve centavos em valores grandes. A diferença relativa é sempre exibida junto
com a absoluta.

## 13. O que isto significa para a engenharia de IA

A divisão de responsabilidade fica explícita e mensurável:

| | Decide | Verifica |
|---|---|---|
| **LLM** | qual das 79 posições (com candidatos já restritos a ~9-15 pelo bloco) | - |
| **Código** | - | leitura, hierarquia, natureza, conservação, lado, sinal, identidade |

O número que fecha o argumento: no arquivo real, **nenhum centavo dos R$ 151
milhões de erro veio do julgamento do modelo.** Todo ele veio de leitura (natureza
D/C) e de estrutura (detecção de folha). A fronteira está no lugar certo - e isso
é uma constatação empírica, não uma preferência de estilo.

---

## Referências no código

| Conceito | Arquivo |
|---|---|
| chave de agregação normalizada | `portal/src/core/keys.js` |
| resolução canônica de destino | `portal/src/core/planoContas.js` |
| natureza por linha, compatibilidade de sinal | `portal/src/core/sign.js` |
| hierarquia por prefixo de código | `portal/src/core/hierarchy.js` |
| trilha, identidade estendida, transporte | `portal/src/core/invariants.js` |
| agregação, órfãos, posições de memorando | `portal/src/core/shadow.js` |
| Classe A / Classe B | `portal/src/core/qa.js` |
| validação de cobertura em build time | `scripts/gen_knowledge.py` |
| golden dataset e a prova | `portal/test/balancete.test.mjs` |
