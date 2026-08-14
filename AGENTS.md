# AGENTS.md - informações do projeto

Comandos, convenções e armadilhas deste repositório. Leia antes de mexer.

## Comandos

```powershell
# Núcleo contábil (123 testes) - sempre rode depois de tocar em portal/src/core/
$env:Path += ';C:\Program Files\nodejs'
cd portal; node --test "test/*.test.mjs"

# Servidor (295 testes). Funciona COM ou SEM pytest.
python -X utf8 server/run_tests.py
python -X utf8 server/run_tests.py balancete -v   # filtra por nome do arquivo

# Avaliação agregada com limiares (26 métricas). É o gate do CI.
python -X utf8 server/eval/run_eval.py

# SINTAXE DOS .jsx. `node --test` só carrega portal/src/core/**, e sem npm não há
# Vite nem ESLint: um erro de sintaxe num componente React passa por TODA a
# verificação disponível e só aparece como tela branca no navegador. Rode isto
# depois de qualquer edição em .jsx.
node scripts/verificar_jsx.mjs portal/src

# Regenerar o golden de demonstração publicada a partir de um dump de leitura
python -X utf8 scripts/extrair_golden_demonstracao.py <arquivo.leitura.json>

# Regenerar artefatos de build a partir de knowledge/
python -X utf8 scripts/gen_knowledge.py
python -X utf8 scripts/gen_knowledge.py --check   # só valida (CI)

# Reconstruir a base de conhecimento a partir dos seeds da v1 (uso único)
python -X utf8 scripts/bootstrap_knowledge.py

# Extrair a fixture do balancete real
python -X utf8 scripts/extrair_fixture_balancete.py

# Diagnosticar a leitura REAL de um PDF (exige pdfplumber: rode no notebook
# servidor). Mostra score/evidência por página, colunas com x1 e as linhas com
# x0 e nível de indentação. É a única forma de calibrar leitura sem adivinhar.
python -X utf8 scripts/dump_leitura.py <arquivo.pdf> --paginas 1-12
python -X utf8 scripts/dump_leitura.py <arquivo.pdf> --somente-estrutura  # empresa fechada

# Portal em dev / build
cd portal; npm ci; npm run dev; npm run build

# Servidor local
cd server; uvicorn app.main:app --port 8123
```

## Restrições do ambiente de desenvolvimento

**O PyPI está bloqueado por proxy corporativo** (SSL handshake failure). Só
existem `openpyxl`, `pandas`, `numpy`, `xlwings` no Python do sistema. **O npm
registry também pode estar bloqueado.**

Consequências práticas, e como o projeto lida com elas:

- `server/run_tests.py` injeta um **shim da API do pytest** quando o pytest real
  falta. Suporta `fixture` (incluindo geradoras e `autouse`),
  `mark.parametrize`, `mark.skipif`, `raises`, `approx`, `skip` e `monkeypatch`.
  Escreva os testes com a API do pytest normalmente.
- **Imports de dependência externa são LAZY** (dentro da função, nunca no topo do
  módulo): `pdfplumber`/`pypdfium2` em `app/reading/pdf_words.py`, `httpx` via
  `httpx_lazy()` em `app/llm/ollama.py`, `pydantic` com fallback em
  `app/llm/schemas.py`, `psycopg` em `app/db/conexao.py`.
  Isso não é só conveniência: é a fronteira certa. Lógica pura sempre
  importável e testável; I/O só quando usado.
- Testes que exigem as libs chamam `_exige_libs_pdf()` / `_exige_pydantic()`, que
  pulam com motivo explícito. **Nunca deixe um teste falhar silenciosamente por
  falta de dependência.**
- O servidor roda em outro notebook. Ver `docs/09-runbook-notebook.md`.

## Convenções

- **Comentários, docstrings e mensagens de UI em português.** Comente o **porquê**,
  sobre tudo quando a decisão contraria o óbvio.
- Não adicione nem remova comentários existentes sem motivo.
- Python: `from __future__ import annotations`, type hints, `logging` (nunca
  `print`), sem try/except excessivo.
- JS: ESM, sem dependência de runtime além de React/Router no portal. O
  `portal/src/core/` é **puro** - sem DOM, sem rede, sem estado.
- Dependências: versões **pinadas** no Python, publicadas há 7+ dias.

## Armadilhas - leia antes de editar

### Demonstração PUBLICADA não tem indentação. A hierarquia é ARITMÉTICA.

Medido no ITR do Fleury 2T26: as **53 linhas de conta do Balanço estão todas em
`x0 = 44,76`**. Não existe recuo. `tables.nivel_por_indentacao` continua servindo
a documento indentado, mas NÃO pode ser a fonte única - foi a primeira hipótese
deste trabalho e os dados a desmentiram.

A fonte primária é `demonstracao.arvore_por_soma`: sintética é a linha que é a
soma exata de um bloco **contíguo** das anteriores ainda não adotadas, em TODAS
as colunas comuns. Duas consequências de projeto:

- a hierarquia é **autoverificável** - se ela fecha, está certa;
- o servidor **gera código contábil** a partir da árvore (`1`=Ativo, `2`=Passivo,
  `5`=DRE, §8.7), e o portal usa o caminho de `hierarquiaPorCodigo` que já tinha
  670 assertivas passando. Emitir o nome do pai seria ambíguo: a página 6 tem
  `Total circulante` duas vezes, uma no Ativo e outra no Passivo.

Busque sempre o sufixo **mais longo** primeiro. Do mais curto, `Total não
circulante` casaria com um par qualquer de contas vizinhas em vez de englobar o
`Total do realizável a longo prazo`, e a árvore sairia rasa e errada.

### Nota explicativa passa no gate de página. O que a separa é o FECHAMENTO.

Uma nota tem âncora contábil, colunas alinhadas por x1 e subtotal que fecha - as
três evidências do `page_classifier`. No Fleury, **33 das 50 páginas** foram
admitidas e o pipeline recebeu **1.222 linhas em vez de 115**.

O discriminador é `demonstracao.familias_que_fecham`: uma demonstração primária
**se fecha** (`Total do ativo`, `Lucro líquido do período`); uma nota
**decompõe** uma linha da demonstração. Das 30 páginas de nota, nenhuma tem
âncora de fechamento.

Ao mexer em `ANCORAS_FECHAMENTO`, lembre que o casamento é quase exato
(`_casa_ancora`): `Total do ativo circulante` é subtotal intermediário e **não**
pode ser tratado como fim do Balanço, senão a árvore parte em duas.

### A DFP padronizada da CVM é uma TERCEIRA classe de documento

Não é o balancete de ERP nem o ITR diagramado. É o formulário que a companhia
entrega à CVM, e foi ele que zerou a leitura na primeira tentativa. O que muda:

| | ITR diagramado | Padronizada da CVM |
|---|---|---|
| âncora | `Total do ativo` | **`Ativo Total`** / **`Passivo Total`** |
| escala | `Em milhares de reais` | **`Reais Mil`** |
| código | não existe | **existe**: `1.01.02.01.03` em coluna própria |
| Ativo e Passivo | mesma página | **páginas separadas** |
| cada lado | uma página | **duas páginas** (a 2ª sem âncora) |

Cinco consequências, todas com teste em `server/tests/test_dfp_padronizada.py`:

1. **`ANCORAS_FECHAMENTO`** precisa das duas grafias. Faltando `ativo total`, a
   leitura não degrada - **zera**: nenhuma página fecha BP, nenhuma demonstração é
   selecionada, 0 linhas na tela.
2. **`_ESCALAS`** precisa de `reais mil`. A identidade fecha em qualquer escala, então
   errar aqui sai mil vezes menor sem nenhuma validação acusar.
3. **`descartar_coluna_codigo`** existe porque a coluna `Conta` é numérica e alinhada,
   e `detectar_colunas` a encontra como coluna de valores - deslocando TODOS os
   períodos em um. O discriminador é o tamanho do grupo depois do ponto: milhar tem
   sempre 3 dígitos (`1.234`), código tem 1 ou 2 (`1.01`).
4. **`chaves_de_selecao`** / `chavesDeSelecao` escolhem uma demonstração por LADO, não
   por "BP". Com a chave `BP`, as duas páginas disputavam o mesmo slot e o Passivo
   inteiro era descartado: 48 linhas, nenhuma de Passivo.
5. **`agrupar_continuacoes`** anexa a página de continuação. A 2ª página de cada lado
   não tem âncora, então era descartada como nota - levando 13 linhas de Ativo e 31
   de Passivo. O critério é o TÍTULO REPETIDO, e o título inteiro entra na
   comparação: `DFs Individuais` e `DFs Consolidadas` não se juntam.

E `top_inicio_valores` exige **2+ colunas preenchidas** na mesma linha para marcar a
fronteira do cabeçalho. O formulário traz `Versão: 1` no bloco de título, e aquele
`1` solto é token de valor legítimo posicionado ACIMA da linha de datas: com o
critério antigo a fronteira subia para cima dele e
`Conta 31/12/2025 31/12/2024 31/12/2023` ficava fora do cabeçalho - toda coluna
virava `coluna N`.

**Fato verificado do documento** (DFP 2025 do Fleury, informação pública):
`Ativo Total` = `Passivo Total` = `11.497.695` (individual) e `13.220.481`
(consolidado), nos três exercícios. O documento fecha; se o pipeline não fechar, o
defeito é nosso.

### `scripts/dump_leitura.py` TEM de espelhar `main.read`

Já mentiu: não chamava `descartar_coluna_codigo`, e o dump saiu com a coluna `Conta`
ainda presente como coluna de valores. Diagnostiquei um deslocamento de coluna que a
produção já não tinha. Ferramenta de diagnóstico que não reproduz o caminho real é
pior que não ter ferramenta - ela consome rodadas inteiras de investigação em
sintomas inexistentes.

Ao mudar a sequência de leitura em `main.read`, mude aqui também. E o dump grava
`codigo`: sem ele é impossível reconstruir a hierarquia por prefixo fora da máquina
que tem `pdfplumber`.

### Escala: `Em milhares de reais` tem de ser lida

A identidade fecha em QUALQUER escala. Se a legenda passar batido, o balanço sai
mil vezes menor, todas as métricas continuam verdes e o erro só aparece na frente
de quem lê o resultado. `demonstracao.detectar_escala` cobre isso, e ausência de
declaração vira **aviso**, nunca palpite.

### Quem escolhe a coluna é o ANALISTA

`computeYears` pegava "os 3 mais recentes" entre todos os rótulos. Com 38
pseudo-períodos escolheu `coluna 7 · coluna 8 · coluna 9` - fragmentos de tabela
de nota - e o Ativo saiu R$ 2,00.

`periodos.propor` agora PROPÕE com critério explícito e marca
`escolha_pendente=True` quando há alternativa relevante (Controladora x
Consolidado, trimestre x acumulado). O portal pergunta. Um documento pode trazer
Saldo Anterior / Débito / Crédito / Saldo Final, e qual entra na análise não é
propriedade do arquivo.

### `aplicarSelecao` (JS) ≡ `montar_selecao` (Python)

Mais uma paridade obrigatória, do mesmo tipo da de `normalizeText`:
`portal/src/core/demonstracoes.js` reaplica no navegador o mapeamento que o
servidor propôs. Divergir faz o valor ir para outro Ano N sem nada indicar.
Provado em `portal/test/demonstracoes-selecao.test.mjs` contra o campo `leitura`
do golden, que é a saída da implementação Python.

### `normalizeText` tem três implementações que DEVEM ser equivalentes

`portal/src/core/normalize.js` ≡ `scripts/gen_knowledge.py` ≡
`server/app/reading/page_classifier.py` ≡ `dm_normalize` no SQL.

Regra: lower + NFKD sem acentos + `[^a-z0-9\s]` vira espaço + colapsa espaços +
trim. Divergir cria chaves diferentes para a mesma conta - foi assim que a v1
gerou linhas duplicadas no dicionário e o seed nunca era sobrescrito.

### Chave de agregação vs chave de exibição

- `aggKey()` - **normalizada**. A única para agregar, comparar e indexar.
- `displayKey()` - grafia original, só para exibir e exportar no Excel.

Usar a de exibição para agregar foi a causa raiz nº 1 do balanço não fechar.

### Três formas de cada valor

| Campo | Regra | Uso |
|---|---|---|
| `valoresRaw` | nenhuma | auditoria |
| `valoresApresentacao` | §14.2 (natureza D/C) | **verificação de leitura**, comparação com o documento |
| `valoresPorSlot` | §14.2 + §14.1 (prefixo do destino) | agregação na Shadow |

A verificação de leitura **precisa** usar a apresentação. Usar o gravado faz uma
folha que caiu em destino `neg` sofrer `Math.abs()` e divergir da sua sintética,
erro que eu mesmo introduzi e a suíte pegou (bloco `43`, R$ 7.954.956,08).

### `candidatosPara(grupo, '')` devolve o GRUPO INTEIRO - e isso já custou caro

`if (!s)` desliga o filtro de subcategoria. Quem chama com `sub` vazia recebe 28
opções, não as "~9 a 15" que a arquitetura promete em quatro arquivos.

Isso ficou invisível por muito tempo porque `subCategoria` **só era preenchida
pelo destino que o matching escolhia**. Quem mais precisava dela era exatamente
quem não a tinha: a linha que o dicionário não conheceu. No balancete de ERP o
dicionário acerta quase tudo por nome exato e o círculo não aparece; na
demonstração publicada, 6 linhas foram ao LLM como `bloco_provavel=Passivo/?`,
o prompt mandava "na dúvida deixe em branco", e o resultado foi R$ 3.314.468 fora
da Shadow com a identidade furada em 23%.

`portal/src/core/secoes.js` quebra o círculo lendo a subcategoria do **nome das
contas-pai**, entre a hierarquia e o matching. Três coisas a não estragar:

- **A raiz `Total do passivo e patrimônio líquido` NÃO é a seção de PL.** Ela
  contém as duas palavras e é ancestral de todo o Passivo Circulante - sem o veto
  por `passivo`, o balanço inteiro vira PL.
- **`não circulante` antes de `circulante`.** `Total não circulante` contém a
  palavra `circulante`.
- **A subcategoria inferida DESEMPATA, não filtra.** Filtrar por dado inferido
  recusaria acertos do dicionário que hoje funcionam. Ela só escolhe entre
  homônimos (`Financiamentos` = `Bancos` ou `Bancos LP`) e restringe o LLM.

Se um prompt voltar a receber `bloco_provavel=X/?`, a redução não aconteceu,
é defeito do chamador, não do modelo.

### Match parcial precisa das duas guardas de polaridade

`Despesas financeiras` já foi para `+ Receitas Financeiras` com selo `Dicionário`
e confiança 0,9. A entrada `Receitas despesas financeiras líquidas` contém a
substring e a razão de tokens dá exatamente o piso `minRatio` (2/4 = 0,50).

Só não entrou no balanço porque aquele documento publica despesa negativa e o
guardrail de sinal disparou. Com despesa positiva, entra calado.

- `polaridadeInverte` - exige marcador exclusivo nos **dois** lados. Não relaxe
  para um lado só: `IRPJ e CSLL a recolher` × `IRPJ e CSLL a pagar` casa em 0,67
  e é o mesmo passivo. Relaxar matou três acertos do dicionário, todos fixados em
  `portal/test/secoes.test.mjs`.
- `polaridadeAcrescenta` - só vale no match por **continência**, onde os tokens
  excedentes são o que muda o significado.

Não adicione `bruta`/`bruto` às dimensões: `Receita` ⊂ `Receita bruta de vendas`
é variação benigna e bloquear isso só gera trabalho manual.

### Posição RESIDUAL: último recurso, e as quatro condições que a tornam aceitável

O modelo local se abstém de forma **determinística** em conta de nome genérico.
Medido: dois rounds de julgamento no ITR do Fleury devolveram `destino vazio` para
as mesmas quatro linhas (`Outros ativos` ×2, `Arrendamento`, `Dividendos a
pagar`), com contagem de tokens idêntica. Reclicar não resolve.

E o custo do branco é desproporcional: `sem-destino` é **Classe A e bloqueia**,
enquanto a residual (`Outros Operacionais (AC)`, `(PNC)`, …) está no bloco correto
e por isso preserva `Ativo = Passivo + PL`.

`patchesResiduais` em `matching.js` é a **única** implementação. Ela é PURA e
devolve patches porque quem aplica é a tela, nas linhas de ORIGEM - aplicar em
`result.rows` e rodar o pipeline de novo aplica a regra de sinal **duas vezes**
(foi o erro que a suíte pegou quando escrevi o teste).

Quatro condições, todas testadas em `portal/test/secoes.test.mjs`:

1. **Todo bloco tem residual**, e ela é candidata do próprio bloco. Bloco sem
   residual = linha sem alternativa nenhuma.
2. **A da DRE é `+/-`** (`+/-Outras Receitas/Despesas Operacionais`). A residual é
   usada quando não se sabe a direção do valor; prefixo fixo produziria
   `sinal-incompativel`, que é Classe A.
3. **Nunca passa calada**: aviso `destino-residual` de Classe B nominal por linha,
   selo na grade, e o QA olha `tipoMapeamento === 'Residual'` - não `_residual`,
   que `normalizeRow` descarta ao salvar/reabrir.
4. **Fallback não é conhecimento**: `memoriaDeRows` NÃO grava residual sem
   confirmação humana. Se gravasse, ela voltaria na próxima análise como "Memória
   do cliente", que é a camada de maior confiança do matching - o palpite de hoje
   viraria a verdade de amanhã.

Sem grupo/sub definidos **não** há residual: escolher o lado do balanço no lugar
do analista é a única coisa capaz de furar a identidade.

E note o limite: a identidade fecha, mas o **indicador muda**. Valor em
`Outros Operacionais` não lê liquidez como `Clientes` leria. Por isso a linha volta
pedindo confirmação em vez de ficar verde.

### `origem` é o que o documento diz - não conserte nela

A leitura da demonstração publicada gruda o cabeçalho de seção na primeira conta
(`'Circulante Fornecedores'`) e deixa a referência de nota colada
(`'Capital social 24a.'`). O nome limpo vai em `_contaLimpa`; `origem` fica
intocada porque o guardrail "a origem existe no documento" compara contra ela, e
`displayKey()` exporta a grafia original para o Excel.

### Natureza é da LINHA, nunca do grupo

Não reintroduza nada parecido com `sinalGrupo(grupo)`. No arquivo real, 24 contas
têm natureza contrária ao próprio grupo (R$ 75,5 milhões). Ver
`knowledge/regras-de-sinal.md`.

### Espaços do plano de contas são significativos

`-  Despesas Financeiras` tem dois espaços. `Resultado da Exploração ` e
`Lucro antes de Impostos ` têm espaço no fim. Fazem parte da chave.
`plano-de-contas.lock.json` congela isso e o gerador falha se mudar.

### As 6 posições da DRE fora da cadeia do resultado

Linhas 16, 17, 19 (add-back do EBITDA) e 36, 39, 40 (abaixo do lucro líquido)
**não alcançam** a linha 35. Valor alocado ali aparece na Shadow mas não no
resultado. Está em `POSICOES_MEMO_DRE` e a trilha o mostra num balde próprio.

### Classe A vs Classe B

Classe A **bloqueia** a entrega e é álgebra: leitura, destino inválido,
subtotal, lado trocado, sinal incompatível, dupla contagem, órfão, conservação,
identidade. Classe B é revisável e **nunca** bloqueia. Ao adicionar validação,
decida em qual classe ela cai - e o critério é: *isto pode furar
`Ativo = Passivo + PL`?*

### `linhaDeTransporteDoResultado` recebe os períodos

Ela precisa dos rótulos **reais** dos períodos, não dos nomes de slot. Passar
errado desloca todos os slots (o balanço vai para Ano 2 e o Ano 3 fica só com o
transporte). E a linha nasce com `_sinalAplicado: true` - não pode passar pela
regra de sinal outra vez.

## Fonte de verdade

`knowledge/` é a fonte; `portal/src/core/data/*.gen.js` e
`server/app/db/*.json` são **artefatos de build**. Nunca edite os `.gen.js`;
edite o `knowledge/` e rode `scripts/gen_knowledge.py`.

## Dados de cliente - regra dura

**Nenhum dado identificável de cliente entra no repositório.** O GitHub Pages em
conta gratuita exige repositório público, e o `.gitignore` desprotege
`server/eval/datasets/*.json` de propósito, porque os testes dependem da fixture.

A fixture original continha razão social, agência e número de conta bancária.
Foi anonimizada por `scripts/anonimizar_fixture.py`, que:

- preserva **códigos, valores e naturezas D/C byte a byte** (é o que prova o
  invariante) e verifica isso antes de escrever;
- troca razão social, agência e conta por marcadores;
- audita o resultado contra uma lista de termos proibidos e **não escreve nada**
  se encontrar resquício.

Antes de commitar, rode a auditoria:

```powershell
python -X utf8 scripts/anonimizar_fixture.py --conferir
```

Ao adicionar um golden dataset novo, anonimize **antes** de colocá-lo em
`server/eval/datasets/`. E note que o corpus de
`server/tests/test_normalize_parity.py` também usa nomes de conta reais - use
valores fictícios com a mesma *estrutura* (pontuação colada a dígito, letra
dentro de número, hífen interno), que é o que torna o caso útil.

## Golden datasets

São **dois**, e cobrem casos de leitura opostos. O de balancete não exercita nada
do caminho de demonstração publicada, e vice-versa.

- `server/eval/datasets/balancete_spe_exemplo.json` - balancete Protheus real.
  Tem código contábil, hierarquia por prefixo e natureza D/C em coluna própria.
  Fatos a preservar: Ativo `118.035.576,14`, Passivo+PL `118.724.714,55`,
  resultado `-689.138,41`, 224 folhas, 134 sintéticas, identidade estendida com
  resíduo `0,00`.

- `server/eval/datasets/demonstracao_fleury_2t26.json` - ITR de companhia aberta
  (informação pública, CVM/RI; **não** é dado de cliente). Não tem código, não
  tem indentação e vem embrulhado em 47 páginas de nota, parecer e índice. Fatos
  a preservar: 33 páginas admitidas pelo gate de página → 3 demonstrações → 66
  linhas; Ativo Consolidado `13.558.475` = Passivo+PL; 9 sintéticas no Balanço e
  5 na DRE; escala `milhares de reais`; cabeçalho da DRE remontado para
  `Controladora 6 meses 30/06/2026`.

  É este o caso **majoritário** na mesa do analista. A v2 foi originalmente
  validada só contra o balancete, que é a exceção - e foi por isso que o primeiro
  ITR real produziu 1.222 linhas e um Ativo de R$ 2,00.

Ao mexer em `sign.js`, `hierarchy.js`, `shadow.js` ou `invariants.js`, rode
`portal/test/balancete.test.mjs` **e** `portal/test/demonstracao.test.mjs` - são
eles que provam o invariante nos dois formatos.

Ao mexer em `reading/demonstracao.py` ou `reading/periodos.py`, rode
`server/run_tests.py demonstracao` e `server/run_tests.py golden`.

## Verificação de `.jsx` sem npm

O portal não tem `node_modules` na máquina de desenvolvimento (registry
bloqueado), então `.jsx` não passa por parser nenhum: `node --test` carrega só
`src/core/**` e `src/lib/**`, que são ESM puro. Erro de sintaxe num componente
React atravessa TODA a verificação disponível e vira tela branca no navegador.

```powershell
node scripts/verificar_jsx.mjs portal/src        # 36 arquivos, sai 1 se houver erro
```

Não é parser: só confere balanceamento de `()[]{}` e de tags JSX, que é a classe
de erro que uma edição por diff produz. Quando o npm voltar, `npm run build` é a
verificação de verdade.

Duas armadilhas na heurística dele, ambas já resolvidas - **não regrida**:

- `}` está FORA de `ANTES_DE_REGEX`. Em JSX, `({o.grupo}/{o.subCategoria})` tem
  uma barra literal, não uma regex. Tratá-la como regex fazia o verificador
  engolir o resto da linha e acusar `ShadowView.jsx`, que estava correto.
- O trecho só é consumido como regex se a barra de fechamento existir **na mesma
  linha**. Sem isso, uma divisão qualquer devora o resto do arquivo.

Um falso positivo aqui é pior que um falso negativo: ensina a ignorar a
ferramenta. Se ele acusar um arquivo que você não editou, desconfie dele primeiro
- e confirme rodando contra um `.jsx` deliberadamente quebrado, para garantir que
ainda detecta erro de verdade.
