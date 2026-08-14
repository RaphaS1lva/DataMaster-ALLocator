# Leitura de documento: a tabela reconstruída por coordenada

Este documento descreve como o ALLocator v2 extrai valores, colunas e hierarquia
de um Balanço, de uma DRE e de um balancete de ERP **sem gastar um único token**.
É a camada que produz os "fatos" da tabela de
<ref_file file="docs/01-arquitetura.md" />, e é onde nasceram os R$ 151 milhões de
erro da v1 - nenhum centavo deles veio do julgamento do modelo.

## 1. A intuição: coluna é coordenada X

Numa demonstração financeira a coluna **não** é delimitada por linha, borda ou
tag. Ela é delimitada por **abscissa**. Todo valor de uma mesma coluna é alinhado
à direita na mesma coordenada, porque é assim que contador e ERP formatam número.

Então o algoritmo é: filtrar as palavras que são número, clusterizar as **bordas
direitas** e chamar cada cluster de coluna.

### Por que a borda direita (`x1`) e não `x0` nem o centro

```
                            x0        centro        x1
1.234.567,89          |    412.0      455.5      499.0
55                    |    487.0      493.0      499.0
```

`1.234.567,89` e `55` na mesma coluna têm `x0` separado por ~9 caracteres e
centros distintos. O que eles têm **igual, com precisão de fração de ponto**, é o
`x1`. Clusterizar por `x0` ou por centro espalha a mesma coluna em vários
clusters - e é a origem clássica do "o valor foi para a coluna errada".

Está escrito no cabeçalho de `server/app/reading/columns.py`, que é geometria
pura: o módulo não importa `pdfplumber` em runtime, opera sobre a dataclass
`Palavra` e é testável com palavras construídas à mão.

## 2. O pipeline, função por função

```
bytes do PDF
   │
   ├─ pdf_words.palavras_por_pagina()      → dict[pagina, list[Palavra]]
   ├─ pdf_words.paginas_com_texto()        → escaneada? (vai para visão)
   │
   ├─ columns.detectar_colunas()           → clusteriza os x1 dos tokens de valor
   ├─ columns.descartar_coluna_nota()      → remove a coluna de nota explicativa
   ├─ columns.mapear_cabecalho()           → rótulo de cada coluna, pela posição x
   │
   ├─ tables.agrupar_em_linhas()           → agrupa por `top`
   ├─ tables.montar_linhas()               → LinhaLida com TODAS as colunas
   ├─ tables.juntar_rotulos_quebrados()    → cola rótulo de duas linhas físicas
   ├─ tables.nivel_por_indentacao()        → nível pelo x0 (fonte AUXILIAR)
   ├─ demonstracao.familias_que_fecham()   → é demonstração ou é nota?
   ├─ demonstracao.arvore_por_soma()       → hierarquia ARITMÉTICA (§4.1)
   ├─ demonstracao.classificar()           → código gerado · o que descartar
   ├─ periodos.reconstruir_cabecalho()     → cabeçalho empilhado (§10.2)
   └─ periodos.propor()                    → coluna → Ano, com o critério à vista
```

### `pdf_words.Palavra` - a unidade de tudo

```python
@dataclass(frozen=True)
class Palavra:
    texto: str
    x0: float; x1: float; top: float; bottom: float
    pagina: int
```

`extract_words(keep_blank_chars=False, use_text_flow=False)`. As duas opções são
deliberadas: `keep_blank_chars=False` evita colar rótulo e valor num único token,
e `use_text_flow=False` ignora a ordem interna do *content stream* e usa a ordem
**geométrica**. Num PDF gerado por ERP o stream costuma sair coluna a coluna, e
respeitá-lo embaralharia as linhas. Palavra com `upright=False` é descartada - é
marca d'água ou carimbo de "cópia controlada", não pertence a coluna nenhuma e só
sujaria a clusterização.

`paginas_com_texto()` exige **dois** pisos: `MIN_CARACTERES_TEXTO = 200` e
`MIN_DIGITOS_TEXTO = 30`. O piso de dígitos existe porque PDF escaneado com OCR
ruim devolve um punhado de letras soltas: texto sem número não é demonstração
financeira, é ruído - e tratar ruído como texto faria a página escaneada **não**
ir para a visão, que é o pior dos mundos (leitura silenciosamente vazia).

`renderizar_pagina(escala=2.0)` (≈144 dpi) só é chamada nesse caminho de exceção.

### `columns.detectar_colunas()`

```python
def detectar_colunas(palavras, min_ocorrencias=3, tolerancia=None) -> list[Coluna]
```

A tolerância de corte é derivada da própria página:
`largura_media_caractere(palavras) * FATOR_TOLERANCIA`, com
`FATOR_TOLERANCIA = 3.0` e `TOLERANCIA_PADRAO = 12.0` como piso quando não há
como estimar a escala. Três larguras de caractere é o menor valor que não junta
colunas vizinhas em relatório apertado de ERP e ainda absorve o jitter de
sub-ponto do `x1` dentro de uma mesma coluna.

A clusterização é `agrupar_por_gap()`: ordena e quebra onde o intervalo passa da
tolerância. **Não é k-means nem DBSCAN**, de propósito - o número de colunas é
desconhecido, e em 1-D com dados alinhados o corte por gap é ótimo,
determinístico e explicável para um auditor. K-means não é nenhuma das três
coisas.

`min_ocorrencias=3` é o filtro que separa coluna de coincidência: um número solto
no meio do texto (ano numa frase, número de página, quantidade citada num
parágrafo) nunca aparece três vezes na mesma abscissa.

`atribuir_a_coluna()` usa **maior sobreposição horizontal** como critério
primário e desempata pela distância entre os `x1` - de novo porque é o `x1` que
identifica a coluna. Sem sobreposição nenhuma, aceita a coluna mais próxima em
`x1` desde que dentro da tolerância; fora dela devolve `None`, e o token não é
enfiado à força na coluna vizinha.

### `columns.para_numero()` - traço é vazio, não é zero

`TOKEN_VALOR` aceita `1.234.567,89`, `1234567.89`, `(55.497)`, `-1.234`,
`1.234,56-` (sinal à direita, exportação SAP/Protheus), `R$ 1.000`,
`123 456` (milhar por espaço) - e o **traço isolado** (`-`, `–`, ` - `).

Regras de `para_numero()`, na ordem em que são aplicadas:

| Entrada | Saída | Por quê |
|---|---|---|
| `-` `–` ` - ` | `None` | é **vazio**, não é zero |
| `(55.497)` | `-55497.0` | parênteses = negativo (padrão CVM/IFRS) |
| `1.234,56-` | `-1234.56` | sinal à direita (exportação de ERP) |
| `1.234,56` | `1234.56` | vírgula e ponto juntos: manda quem está mais à **direita** |
| `1.234` | `1234.0` | só ponto, casando `^\d{1,3}(\.\d{3})+$` → milhar |
| `1.5` | `1.5` | só ponto, sem casar milhar → decimal |

**Zero é uma afirmação contábil** ("esta conta fechou em zero"); traço é ausência
de afirmação. Confundir os dois transforma buraco de leitura em dado, e o
somatório fecha errado sem ninguém notar.

`para_numero` espelha `parseNumber` de `portal/src/core/normalize.js`. Se as duas
divergirem, a trilha de conservação acusa uma diferença que não existe.

## 3. Os quatro bugs que a geometria resolve

### 3.1 Traço isolado: célula vazia que **ocupa** a coluna

Este é o bug de leitura nº 1 em demonstração financeira, e o mais difícil de
perceber, porque o número lido é plausível.

O traço é reconhecido como token de valor de propósito. Se não fosse, a coluna
dele não receberia nada naquela linha e os valores seguintes escorregariam uma
coluna para a esquerda - 2024 lendo o número de 2025.

A defesa está em `tables.montar_linhas()`:

```python
# todas as colunas nascem presentes e vazias: é isso que impede o
# deslocamento quando uma célula é traço ou simplesmente não existe.
valores: dict[str, float | None] = {nome: None for nome in nomes}
```

Cada `LinhaLida` é **pré-semeada com todas as chaves de coluna**. A posição de um
valor passa a não depender de quantos valores a linha tem. É uma linha de código
que elimina uma classe inteira de erro.

Token de valor que **não** pertence a nenhuma coluna é **descartado** em vez de
virar rótulo - com uma exceção: se for a primeira palavra da linha, é código de
conta e fica no rótulo. Sem esse descarte, o número da nota explicativa que sobra
solto produziria `"Caixa e equivalentes de caixa 4"`, e nenhuma regra do
dicionário casaria com isso.

### 3.2 A coluna "Nota", descartada por critério **estrutural**

Muitas demonstrações põem, **entre** o rótulo e os valores, uma coluna com o
número da nota explicativa (`4`, `12`, `23`, às vezes `23.c`). Ela é alinhada à
direita igual aos valores, então `detectar_colunas` a encontra como coluna
legítima - e aí "Nota 12" viraria o saldo de 2024.

`descartar_coluna_nota(colunas, palavras)` decide por **estrutura, não por
formato do número**. Três condições, todas obrigatórias:

| # | Condição | Implementação |
|---|---|---|
| 1 | é a coluna **mais à esquerda** do bloco de valores | `atribuir_a_coluna(p, colunas) == 0` |
| 2 | **nenhum** token traz separador de milhar/decimal | `_TEM_SEPARADOR = \d[.,\s\u00a0]\d` |
| 3 | ≥ **70%** dos tokens com `abs(valor) < 100` (ou casando `_EH_NOTA`, que cobre `23.c`) | `pequenos / len(tokens) >= 0.70` |

**A ordem dos critérios importa, e é aqui que a decisão contraria o óbvio.**
Decidir pelo formato do número - "inteiro curto sem separador, então é nota",
condenaria qualquer coluna legítima de valores pequenos, e demonstração publicada
em milhares tem coluna inteira de `12`, `45`, `80`. O que desempata é a
**posição**: uma coluna de valores de verdade não fica encravada entre o rótulo e
as outras colunas de valores. Posição + magnitude + ausência de formatação
monetária, juntas, só descrevem a coluna de notas.

O descarte é logado em `INFO` com o `x1` e os primeiros oito tokens, porque
descartar coluna por heurística sem deixar rastro é inaceitável numa leitura
auditável.

### 3.3 A ordem das visões vem da posição x, nunca de uma lista

```python
VISOES = {"controladora": "Controladora", "consolidado": "Consolidado",
          "individual": "Individual", "combinado": "Combinado"}
```

`mapear_cabecalho()` coleta os rótulos de visão do cabeçalho, **ordena por
`x_centro`** e casa cada coluna com a visão mais próxima. A ordem do dicionário
`VISOES` é irrelevante para o resultado.

Publicação brasileira alterna `Consolidado | Controladora` e
`Controladora | Consolidado` sem aviso. Quem assume "Controladora primeiro" troca
os dois blocos de valores inteiros em metade dos arquivos - **e o erro passa por
todos os testes de soma, porque as duas visões fecham individualmente**. É o tipo
de defeito que nenhuma verificação aritmética pega; só a geometria pega.

As datas (`dd/mm/aaaa`, `mm/aaaa`, `19xx|20xx`) são casadas coluna a coluna; com
mais de uma data na mesma coluna vale a **mais baixa** (maior `top`), que é a que
de fato titula os valores. `_desambiguar()` fecha o processo garantindo rótulos
únicos (`Consolidado #2`), porque eles são chave de dicionário em `tables`.

Ano puro é excluído de `top_inicio_valores()`: `2025` é sintaticamente
indistinguível de um valor e faria a fronteira cabeçalho/corpo subir para cima do
próprio cabeçalho.

### 3.4 Rótulo que atravessa duas linhas

`juntar_rotulos_quebrados()` cola a linha atual na seguinte quando: a atual não
tem **nenhum** valor, a próxima tem, e as duas estão no **mesmo nível de
indentação** (`abs(Δx0) <= TOLERANCIA_INDENTACAO`).

A exigência de mesmo nível é o que impede colar um cabeçalho de seção
("Ativo circulante", sem valores) na sua primeira conta filha - que está recuada
à direita e portanto em outro nível. Sem ela, a correção de um bug criaria outro.

## 4. Hierarquia sem código: indentação **não basta**

Demonstração publicada não traz código contábil, e a hipótese natural é que o
recuo faça o papel dele - "Caixa e equivalentes" recuado sob "Ativo circulante",
exatamente como o olho humano lê.

**Os dados desmentem isso.** Medido no ITR do Fleury 2T26 com
`scripts/dump_leitura.py`:

```
x0 =  42,60    3 linhas   (título, legenda de unidade, rodapé de notas)
x0 =  44,76   53 linhas   ← TODAS as contas E todos os totais
x0 = 328,80    1 linha    ("Controladora Consolidado", cabeçalho)
x0 = 519,48    1 linha    ("2de" = o rodapé "2 de 46")
```

Não existe recuo. As 53 linhas de conta do Balanço estão na mesma abscissa, e a
estrutura está inteiramente nas linhas `Total ...`. Um pipeline que dependesse de
indentação trataria as 53 como analíticas e somaria `Total do ativo circulante`
junto com as contas que ele totaliza - o bug da v1, ressurgindo num caminho que o
golden dataset de balancete nunca exercitou.

`nivel_por_indentacao()` continua existindo e serve a documento indentado:
clusteriza os `x0` distintos com `agrupar_por_gap` e `TOLERANCIA_INDENTACAO = 3.0`
(≈ meio caractere: menos é jitter de renderização, mais é recuo deliberado do
diagramador), numerando da esquerda para a direita. Mas é **fonte auxiliar**.

### 4.1 A fonte primária é ARITMÉTICA

`demonstracao.arvore_por_soma()`: uma linha é sintética quando é a **soma exata de
um bloco contíguo** das linhas anteriores ainda não adotadas, em **todas** as
colunas comuns.

O algoritmo mantém a lista dos índices ainda sem pai. Para cada linha, procura o
**sufixo mais longo** dessa lista cuja soma bate; achando, adota o bloco e a
sintética entra no lugar dele.

O sufixo mais longo primeiro é o que produz o aninhamento certo. No Balanço do
Fleury, `Total não circulante` precisa englobar `Total do realizável a longo
prazo` - que já é um total - mais Investimentos, Imobilizado, Intangível e Direito
de uso. Buscando do mais curto, casaria com um par qualquer de contas vizinhas e a
árvore sairia rasa.

Exigir todas as colunas comuns é o que separa evidência de coincidência: numa
coluna só, três números somando acontece por acaso com frequência incômoda; em
duas simultâneas, praticamente não.

Resultado no documento real:

```
1          Total do ativo                              (raiz)
  101      └─ Total circulante
    10101     ├─ Circulante Caixa e equivalentes de caixa
    ...
  102      └─ Total não circulante
    10201     ├─ Total do realizável a longo prazo      ← total dentro de total
      1020101    ├─ Títulos e valores mobiliários
    10202     ├─ Investimentos
2          Total do passivo e patrimônio líquido       (raiz)
```

As duas raízes são exatamente os dois lados da equação, e `13.558.475 =
13.558.475`. A hierarquia é **autoverificável**: se ela fecha, está certa.

### 4.2 Por que o servidor GERA código contábil

O núcleo do portal já reconstrói hierarquia por prefixo de código
(`hierarquiaPorCodigo`), com 670 assertivas passando no balancete SPE. Emitir o
**nome do pai** seria ambíguo: a página 6 do Fleury tem `Total circulante` duas
vezes, uma no Ativo e outra no Passivo, e um índice por nome colidiria.

Então a árvore vira código: largura fixa por nível, prefixo do filho contendo o do
pai. E o **primeiro dígito sai da âncora de fechamento da raiz** (§8.7:
`1`=Ativo, `2`=Passivo, `5`=DRE apuração), o que dá `_ladoDeclarado` de graça e
habilita a checagem Classe A de lado trocado.

DRE recebe `5` (apuração) de propósito: numa demonstração publicada o sinal já vem
no número (custo negativo), e declarar `3` (despesa) ou `4` (receita) convidaria a
uma segunda aplicação de sinal.

### 4.3 O que a árvore descarta, e por quê isso basta

Reconstruída a árvore, o lixo se separa sozinho: **folha solta na raiz** é
mobília. Sem lista de termos proibidos.

| Descartado | O que era |
|---|---|
| `2de` com saldo 46 | o rodapé "2 de 46" |
| `Nota` com 2026 / 2025 | linha de cabeçalho cujos anos caíram nas colunas de valor |
| `de junho de junho` com 30 | a data "30 de junho" partida entre linhas do cabeçalho |
| `Lucro por ação` = 0,41 | razão, não valor monetário |
| `Resultado abrangente total` | repete o lucro líquido; alocar duplicaria |

Nada disso é apagado em silêncio: cada linha volta ao portal com o motivo e
aparece na Conferência. Descartar valor sem dizer que descartou é o mesmo defeito
de perdê-lo por chave errada - o número muda e a tela não explica.

### 4.4 O gate de DEMONSTRAÇÃO

Antes de tudo isso, uma pergunta: esta página é uma demonstração primária?

O gate de página (`page_classifier`) aprova qualquer tabela com âncora contábil,
colunas alinhadas por `x1` e subtotal aritmético - e **nota explicativa tem as
três**. No Fleury, 33 das 50 páginas passaram, e o pipeline recebeu 1.222 linhas
em vez de 115: `10ª Emissão 1ª Série` (nota de debêntures), `121 a dias` (faixa de
aging), `2027` (cronograma de vencimento).

`familias_que_fecham()` resolve com uma observação: **uma demonstração primária se
fecha; uma nota decompõe uma linha dela e não fecha nada.** O Balanço termina em
`Total do ativo` e `Total do passivo e patrimônio líquido`; a DRE em `Lucro líquido
do período`. Das 30 páginas de nota do documento, **nenhuma** tem âncora de
fechamento.

O casamento é quase exato (`_casa_ancora`): tolera referência de nota colada
(`Total do ativo 3`) e recusa `Total do ativo circulante`, que é subtotal
intermediário - promovê-lo a raiz partiria a árvore em duas.

Composto com o veto de título que já existia, o resultado é exato:

```
admitida pelo gate de página  AND  fecha alguma demonstração  =  {6, 7, 8}
páginas 9 e 10 fecham DRE mas são DMPL e DFC → vetadas pelo título
páginas 16 a 49 passam no gate mas não fecham → notas
```

`agrupar_em_linhas()` usa `altura mediana * FATOR_LINHA` (`0.6`) como tolerância
de `top`, e compara sempre contra o topo da **primeira** palavra da linha, nunca
da última: comparar com a última acumula deriva e funde a página inteira quando o
espaçamento é apertado.

### 4.5 O cabeçalho de seção que a leitura gruda na primeira conta

Mesmo com tudo acima correto, o Fleury entregou quatro nomes de conta
contaminados. A linha crua do `/read` é literalmente:

```
'Circulante Caixa e equivalentes de caixa'   3181  5080  19060  21772
```

Não existe nenhuma linha isolada chamada `Circulante` nas 66 - o rótulo da seção
foi absorvido pela primeira conta de cada seção durante a junção de palavras.
Vítimas: `Circulante Caixa e equivalentes de caixa`, `Circulante Fornecedores`,
`Não circulante Financiamentos`, `Patrimônio líquido Capital social 24a.`. A
referência de nota (`24a.`, `24.d`) também fica colada.

O efeito não é cosmético. `Capital social` está no dicionário desde sempre
(→ `Capital Social`/PL); `Patrimônio líquido Capital social 24a.` dá Jaccard 0,40
contra ela e **não casa**. Duas contas que o sistema já sabia mapear ficaram sem
destino, e R$ 2,7 milhões não chegaram à Shadow.

O conserto **não** foi mexer na tolerância de junção de linhas. A evidência
disponível é de um PDF só, e alterar a junção afeta todo documento. A separação
foi feita por vocabulário contábil, em `portal/src/core/secoes.js`, e o pedaço
removido não é descartado - ele vira `_secaoDeclarada`, que é exatamente o dado
que faltava na próxima seção.

`origem` **nunca** é alterada: é o que o documento diz, e o guardrail "a origem
existe no documento" depende disso. O nome limpo vive em `_contaLimpa`, o
matching consulta esse, e a grade mostra os dois.

### 4.6 O CÍRCULO da subcategoria - a falha mais cara das cinco

Este é o defeito que custou mais e o único que não estava na leitura.

`candidatosPara(grupo, sub)` reduz o espaço de decisão do LLM de 79 destinos para
o bloco compatível. É a premissa que sustenta usar um modelo de 3B em 6 GB de
VRAM, e está escrita em quatro arquivos. Mas ela tem uma cláusula que ninguém
olhava:

```js
if (!g) return CONTAS_ALOCAVEIS;              // sem grupo: as 79
return CONTAS_ALOCAVEIS.filter((c) => {
  if (normalizeText(c.grupo) !== g) return false;
  return !s || normalizeText(c.subCategoria) === s;   // sub VAZIA: o grupo inteiro
});
```

E `subCategoria` só era preenchida pelo **destino que o matching escolhia**
(`applyMapping` faz `row.subCategoria = res.conta.subCategoria`). Ou seja: quem
mais precisava da subcategoria era exatamente quem não a tinha - a linha que o
dicionário não conheceu.

No balancete de ERP o círculo passava despercebido: o dicionário acerta quase
tudo por nome exato. Na demonstração publicada ele mordeu. As 6 linhas que
sobraram foram ao modelo assim:

```
conta         : Participação de não controladores
bloco_provavel: Passivo/?                        ← 28 candidatos, não 4
cadeia_pais   : ['Total do patrimônio líquido', 'Total do passivo e patrimônio líquido']
```

Somado à regra que o prompt trazia - *"NA DÚVIDA, DEIXE EM BRANCO"* - o modelo
se absteve em 6 de 11. **Ele não errou: obedeceu.** Foi o único componente que se
comportou corretamente.

A informação nunca faltou. Ela estava no **nome das contas-pai**, em texto claro.
`anotarSecoes()` a lê de lá:

| cadeia de pais | subcategoria |
|---|---|
| `Total circulante` | Circulante |
| `Total do realizável a longo prazo` | Não Circulante |
| `Total não circulante` | Não Circulante |
| `Total do patrimônio líquido` | PL |
| `Total do passivo e patrimônio líquido` | **nenhuma** - é a raiz |

A última linha é o detalhe que decide. Essa raiz contém as palavras "patrimônio
líquido" e é ancestral de **todo** o Passivo Circulante: sem o veto por `passivo`,
o balanço inteiro seria classificado como PL. E `Total não circulante` contém a
palavra `circulante`, então "não circulante" tem de ser testado primeiro.

Resultado medido, sobre o payload real:

```
Passivo/?    28 candidatos   →   Passivo/PL           4 candidatos
Ativo/?      28 candidatos   →   Ativo/Circulante    14
                                 Ativo/Não Circulante 14
```

As duas linhas homônimas `Outros ativos` - uma no circulante, outra no realizável
a longo prazo - chegavam ao modelo com contexto idêntico. Agora se distinguem
pelo pai.

A subcategoria inferida **não filtra** o matching, só desempata. Filtrar por dado
inferido poderia recusar um acerto do dicionário que já funciona; desempatar
apenas escolhe melhor entre homônimos - `Financiamentos` existe duas vezes, como
`Bancos` (Circulante) e `Bancos LP` (Não Circulante), e é o pai que decide.

Na grade, a célula mostra **"deduzida da hierarquia"** quando o valor não veio do
documento. O analista tem de saber o que a ferramenta adivinhou, porque é esse
campo que restringe os destinos oferecidos ao lado.

### 4.7 Polaridade: quando uma despesa vira receita em silêncio

O defeito mais grave dos cinco, e o único que nenhuma validação pegaria.

`Despesas financeiras` foi mapeada para `+ Receitas Financeiras`, com selo
`Dicionário` e confiança 0,9. Mecanismo, rodado no código real:

```
linha  : "despesas financeiras"
entrada: "receitas despesas financeiras liquidas"   ← dicionario.csv:683
strongPartialMatch = true    (2/4 tokens = 0,50 - e o piso minRatio é 0,50)
```

A entrada 683 é uma linha **líquida** (receitas menos despesas) e contém
literalmente a substring `despesas financeiras`. Uma despesa foi para uma posição
de receita.

Só não entrou no balanço porque o Fleury publica despesa com sinal negativo e o
guardrail de sinal disparou. **Com despesa positiva - e vem positiva em muitos
balanços - R$ 348.334 seriam contabilizados como receita, com selo de
"Dicionário", sem erro em lugar nenhum.**

Subir o `minRatio` não resolve: `Caixa e equivalentes` ⊂ `Caixa e equivalentes de
caixa` vive em 0,60 e é match legítimo. O problema nunca foi a fração de tokens,
é **qual** token está sobrando. São duas regras, com justificativas diferentes:

| Regra | Quando vale | Por que |
|---|---|---|
| `polaridadeInverte` | qualquer match parcial | cada lado tem um marcador exclusivo da mesma dimensão → troca de sentido (`outras receitas ... líquidas` × `outras despesas ... líquidas`, 0,80 de Jaccard) |
| `polaridadeAcrescenta` | só match por **continência** | o nome maior traz marcador que o menor não tem → o menor é uma parcela e o maior é a linha líquida |

A primeira exige os **dois** lados de propósito. Uma versão anterior desta guarda
exigia só um, e matou três acertos legítimos do dicionário:
`IRPJ e CSLL a recolher` × `IRPJ e CSLL a pagar` casa em 0,67 e é o mesmo passivo
- `recolher` e `pagar` não se opõem. Estão fixados como teste de regressão em
`portal/test/secoes.test.mjs`.

`bruta`/`bruto` ficou **fora** das dimensões: `Receita` ⊂ `Receita bruta de
vendas` é variação benigna de grafia, e bloquear isso só geraria trabalho manual
sem ganho de segurança. `líquida` entrou porque marca uma linha que já compensou
duas parcelas.

### 4.8 O placar das cinco correções

Sobre o payload real do `/read`, com o dicionário de 1.260 regras e **sem IA**:

```
                                    antes        depois
linhas pendentes de julgamento         11             9
  resolvidas pelo dicionário           41            44
despesa em posição de receita           1             0
linha com bloco X/? (sem redução)       6             0
bloqueios de Classe A                  13             0   (com as 9 decididas)
```

E a prova que fecha: atribuindo a cada pendente o **último** candidato do próprio
bloco - o pior palpite ainda plausível, nunca o certo - a identidade fecha em
`0,00` nos dois períodos, com `Ativo = 13.558.475` e `13.220.481`, que são os
números do documento. É a consequência de `ladoDoBalanco`: como os candidatos já
vêm restritos a um lado, **a qualidade do julgamento não afeta o fechamento - só a
existência dele.**

Esse é o argumento que justificou reescrever a regra 4 do prompt. Abster-se
produz `sem-destino`, que é Classe A e **bloqueia**; escolher dentro do bloco, na
pior das hipóteses, produz um erro de Classe B, **revisável**. A instrução antiga
trocava um erro inofensivo por um erro fatal.

## 5. O adaptador de balancete (`reading/balancete.py`)

Um balancete de verificação **não** é um Balanço publicado. Três diferenças, e
ignorá-las foi o que produziu os R$ 151 milhões de erro no caso real
(`Balancete SPE (exemplo) 05.2026`, TOTVS Protheus, relatório `CTBR040`).

### 5.1 Pares valor ↔ D/C emparelhados **posicionalmente**

```
Conta | Descrição | Saldo Anterior | D/C* | Débito | Crédito | Mov Período | D/C** | Saldo Atual | D/C***
```

Todos os valores são positivos; a natureza vive em colunas de **texto**, uma por
coluna de valor, imediatamente à direita dela.

`detectar_layout()` emparelha cada `D/C` com a coluna de valor imediatamente à
sua **esquerda**:

```python
for j, c in enumerate(celulas):
    if not _RE_NATUREZA.match(c):
        continue
    for k in range(j - 1, -1, -1):
        if k in por_indice:
            por_indice[k].indice_natureza = j
            break
```

**Não dá para emparelhar pelo nome**, e é por isso que a decisão é posicional: os
rótulos são todos iguais a menos de asteriscos (`D/C*`, `D/C**`, `D/C***`) e a
quantidade de asteriscos não é padronizada entre versões do relatório.
`_RE_NATUREZA` cobre `D/C`, `Nat`, `Natureza`, `D ou C`, `DC`, com asteriscos
opcionais.

`Débito` e `Crédito` entram como `eh_saldo=False`: são **movimento** do período,
não saldo, e não têm coluna D/C própria. `LayoutBalancete.saldos_absolutos` é
`True` quando ao menos uma coluna de valor tem D/C própria - é esse o gatilho que
faz o núcleo contábil tratar os valores como módulo e buscar o sinal na natureza
da linha.

A confiança do layout é composta: `+0,25` por coluna de código, `+0,2` por coluna
de descrição, `+0,1` por coluna de saldo (teto `0,3`) e `+0,25` quando existe D/C
emparelhado.

### 5.2 Hierarquia por MAIOR PREFIXO ESTRITO

```python
def classificar_folhas(codigos) -> dict[str, bool]:
    """Folha = nenhum outro código a tem como prefixo estrito."""
    limpos = [_RE_SO_DIGITOS.sub("", c) for c in codigos]
    presentes = {c for c in limpos if c}
    return {c: not any(o != c and o.startswith(c) for o in presentes)
            for c in presentes}
```

As duas alternativas óbvias **falham**, e a docstring da função registra o número
medido no arquivo real:

| Regra | Resultado no arquivo real | Por que falha |
|---|---|---|
| "existe outro código começando com `<codigo>` + `'.'`" | **0 sintéticas** | códigos do Protheus não têm ponto: `11010100000071` |
| "pai = código truncado no nível anterior" | **116 falsos órfãos** | faltam níveis: existe `110101` e `11010100000071`, mas **não** `11010100` |
| "folha = comprimento máximo" | funciona **por acaso** (14 dígitos) | quebra em plano de profundidade irregular |

A primeira era a regra da v1. Como ela achava zero sintéticas, as 358 linhas eram
somadas juntas e o Ativo de 118 MM virava ~382 MM - o balanço multiplicado por
~3. O teste `CAUSA 3` de `portal/test/balancete.test.mjs` prova as três
afirmações acima, inclusive a ausência de `11010100`.

As contas analíticas e sintéticas vêm **misturadas** porque o parâmetro de emissão
é `Imprime Contas = Ambas`. `eh_balancete()` exige, por critério estrutural e não
semântico: layout com coluna de código e ao menos uma de saldo, ≥70% das linhas
com código numérico, e hierarquia por prefixo produzindo **sintéticas E folhas**,
um plano de contas de verdade tem os dois níveis.

No arquivo real: **224 analíticas e 134 sintéticas**.

### 5.3 Código é TEXTO, com os zeros à esquerda

```python
def _codigo_texto(valor): ...
```

Num `.xlsx` o código chega como `float`/`int` (`11010100000071.0`), e `str()`
direto produziria notação científica ou um `.0` no fim - o que quebra a
comparação de prefixo da hierarquia. `_codigo_texto` normaliza `float` inteiro
para `int` antes de `str`, e preserva a grafia quando o valor já é texto.

`montar_linhas()` devolve dicts com `codigo`, `origem`, `valoresPorSlot` e
`naturezaPorSlot`, e **não decide sinal, hierarquia ou destino**. Isso é do núcleo
contábil, que já é testado contra este mesmo arquivo. Linha de rodapé/assinatura
(descrição sem código e sem valor) é descartada.

## 6. A verificação de LEITURA

`verificar_sinteticas(linhas, colunas, valor_assinado)` confere **cada conta
sintética contra a soma das suas folhas descendentes**, coluna por coluna, com
tolerância `max(0.05, abs(declarado) * 0.0005)`.

É o mecanismo que sustenta a premissa (1) de
<ref_file file="docs/02-invariante-contabil.md" />: se o documento não fecha
consigo mesmo, o erro é de leitura e fica **localizado num bloco**, não espalhado
pela alocação.

A docstring da função registra a medição no relatório original: **134 sintéticas ×
5 colunas = 670 assertivas**, todas passando com a natureza aplicada.

| Cenário | Divergências |
|---|---|
| natureza D/C aplicada | **0** |
| natureza D/C ignorada, valores crus | **72** somando as 5 colunas; **22** só na coluna `Saldo Atual` |

E a divergência da raiz `ATIVO`, sem D/C, é exatamente **R$ 26.534.262,98** - o
mesmo número de <ref_file file="knowledge/regras-de-sinal.md" />. O teste
`LEITURA - ignorar o D/C faz a verificação FALHAR (prova do contrário)` afirma
isso literalmente.

Uma nota de precisão: a fixture JSON
(`server/eval/datasets/balancete_spe_exemplo.json`) carrega **três** colunas de
saldo - `Saldo Anterior`, `Mov Periodo`, `Saldo Atual`. `Débito` e `Crédito` são
movimento e não entram como saldo (`eh_saldo=False` em `detectar_layout`). Os
números `5 colunas` e `670 assertivas` referem-se ao relatório completo; sobre a
fixture, o teste do portal exercita a coluna `Saldo Atual` e exige
`v.testes >= 130` com `divergencias == []`.

Essa contraprova não é decoração: uma verificação que passa mesmo com a leitura
errada não está medindo nada. `server/eval/run_eval.py` a promoveu a métrica
própria - `poder de detecção (divergências sem D/C)`, com limiar `>= 1`. Se esse
número cair a zero, o teste de leitura perdeu poder de detecção e o CI acusa.

O arquivo real está contabilmente **perfeito**: débito total = crédito total =
R$ 65.083.272,00. As três causas eram todas de processamento.

## 7. Por que Docling foi descartado

O TableFormer do Docling **falha em tabela sem borda alinhada por whitespace**
([docling-project/docling#3749](https://github.com/docling-project/docling/issues/3749)),
que é exatamente o formato de BP e DRE brasileiros. Além disso arrasta ~2 GB de
PyTorch para dentro da imagem.

| | clusterização por coordenada | Docling / TableFormer |
|---|---|---|
| tabela sem borda | é o caso projetado | issue #3749 |
| dependência | `pdfplumber` (0,7 MB de wheel) | ~2 GB de PyTorch |
| custo por página | microssegundos, CPU | inferência de modelo |
| explicabilidade | "este valor está em `x1=499,0`, cluster 2" | pesos de rede |
| determinismo | total | depende de versão de peso |

Para este domínio a decisão não é um trade-off: é mais precisa, instantânea e sem
dependência pesada. Está registrada no cabeçalho de
`server/app/reading/pdf_words.py` e em `server/requirements.txt`, para que ninguém
a reintroduza por engano.

As versões de `pdfplumber==0.11.10` e `pypdfium2==5.12.1` são **pinadas exatas**
pelo mesmo motivo: se `extract_words` muda de heurística numa release menor, as
coordenadas mudam e a detecção de colunas muda com elas, silenciosamente.

## 8. Constantes, num só lugar

| Constante | Valor | Arquivo |
|---|---|---|
| `TOLERANCIA_PADRAO` | `12.0` | `columns.py` |
| `FATOR_TOLERANCIA` | `3.0` (× largura média de caractere) | `columns.py` |
| `min_ocorrencias` | `3` | `columns.detectar_colunas` |
| `FATOR_LINHA` | `0.6` (× altura mediana) | `tables.py` |
| `TOLERANCIA_INDENTACAO` | `3.0` pt | `tables.py` |
| `TOLERANCIA_SOMA_PISO` | `0.6` | `tables.py` |
| `TOLERANCIA_SOMA_RELATIVA` | `0.0005` | `tables.py` |
| `MIN_CARACTERES_TEXTO` | `200` | `pdf_words.py` |
| `MIN_DIGITOS_TEXTO` | `30` | `pdf_words.py` |
| tolerância da verificação de leitura | `max(0.05, abs(declarado) * 0.0005)` | `balancete.verificar_sinteticas` |

`TOLERANCIA_SOMA_*` vive em `tables.py`, que tanto `page_classifier` quanto
`demonstracao` importam. Duas cópias do mesmo número sairiam de sincronia, e o
sintoma seria perverso: o gate de página aceitaria uma página cuja árvore a
hierarquia depois recusaria, e isso apareceria como **"0 assertivas"** - verde por
vacuidade.

## 9. Escala: o erro que nenhuma validação pega

O cabeçalho diz "Em milhares de reais R$". `Total do ativo = 13.558.475` significa
R$ 13,56 **bilhões**.

A identidade fecha em qualquer escala. Conservação de valor também. Se a legenda
passar batido, **todas** as métricas continuam verdes e o número sai mil vezes
menor - o erro só aparece na frente de quem lê o resultado.

`demonstracao.detectar_escala()` reconhece as formas usuais (`em milhares de
reais`, `em R$ mil`, `valores em milhões`) e devolve fator e rótulo. Ausência de
declaração vira **aviso explícito**, nunca palpite: escala não declarada é
pergunta aberta.

## 10. Quem escolhe a coluna é o analista

`computeYears` pegava "os 3 mais recentes" entre todos os rótulos de coluna. Com o
documento fundido em 38 pseudo-períodos (`Controladora #2`, `coluna 7`,
`Consolidado #5`), escolheu `coluna 7 · coluna 8 · coluna 9` - fragmentos de tabela
de nota, onde quase nenhum valor morava. O Ativo saiu **R$ 2,00**.

O conserto não é adivinhar melhor. Um documento pode trazer Controladora e
Consolidado, três meses e seis meses, Saldo Anterior / Débito / Crédito / Saldo
Final - e qual coluna entra na análise é **julgamento profissional**, não
propriedade do arquivo.

`periodos.propor()` faz exatamente duas coisas: propõe com critério explícito
(só colunas com data; um único escopo; um único recorte, preferindo o mais longo;
as 3 datas mais recentes, a mais recente em Ano 3) e declara
`escolha_pendente=True` quando existe alternativa relevante, para o portal
**perguntar**.

### 10.1 O que faz a escolha ser possível

Cada coluna é apresentada com o valor que ela produz na linha que **fecha** a
demonstração:

```
Controladora 30/06/2026  → Total do ativo: 11.689.351
Consolidado  30/06/2026  → Total do ativo: 13.558.475
```

O analista reconhece 13,56 bi como Consolidado num olhar, mesmo que o rótulo tenha
saído como `coluna 3`. **A aritmética vira a legenda** - e isso rebaixa a
remontagem de cabeçalho de requisito a conveniência.

### 10.2 Cabeçalho empilhado

A DRE do ITR tem quatro linhas de cabeçalho, e a data mora nas **colunas de
valor**:

```
"Controladora"                                    (sem valor)
"Período de três meses   Período de seis meses"   (sem valor)
"de junho de junho"          valores: 30 · 30 ·
"Nota"                       valores: 2026 2025 2026 2025
```

Sem remontar, `mapear_cabecalho` devolve `Controladora #2/#3/#4`, nenhuma coluna
tem data, `porSlot` sai vazio e **a DRE inteira contribui zero**.

`periodos.reconstruir_cabecalho()` recupera o ano de dentro dos valores do
cabeçalho, toma dia e mês de onde aparecerem (a data-base é a mesma; só o ano muda
entre colunas) e distribui o recorte temporal em blocos quando a contagem divide
as colunas exatamente. Saída: `Controladora 6 meses 30/06/2026`.

Roda em **duas passadas**: a primeira classificação serve só para achar onde o
cabeçalho termina - é tudo que vem antes da primeira linha que a árvore aproveitou.
Não há como saber isso antes de rodar a árvore, nem como rodar a árvore com rótulo
definitivo antes de ler o cabeçalho.

## 11. Como isto é testado

| Arquivo | O que prova |
|---|---|
| `server/tests/test_reading.py` | `para_numero` em formato brasileiro · traço não desloca coluna e ocupa a coluna certa · descarte da coluna Nota · não descarta coluna legítima de valores pequenos · ordem das visões vem do x · rótulo quebrado em duas linhas · nível por indentação · leitura completa de um balanço sintético |
| `server/tests/test_balancete.py` | layout Protheus com três pares valor/D-C · emparelhamento **posicional, não por nome** · código preserva zeros e não vira notação científica · folha por prefixo estrito · níveis ausentes não geram órfão · códigos sem ponto ainda têm hierarquia · verificação de leitura passa com natureza e **falha** sem ela |
| `server/tests/test_demonstracao.py` | nota explicativa não fecha nada · `Total do ativo circulante` não é fechamento · aninhamento de totais recuperado · uma coluna só não basta para virar pai · bloco de zeros não casa · arredondamento em milhares ainda fecha · código com prefixo do lado certo e do pai · rodapé descartado com motivo · escala |
| `server/tests/test_golden_demonstracao.py` | ★ o ITR real: 33 páginas admitidas → 3 demonstrações → 66 linhas · identidade nas 4 colunas · 25 assertivas de leitura · cabeçalho remontado · escolha de escopo pendente · seleção respeita o analista |
| `portal/test/balancete.test.mjs` | os mesmos números pelo lado JS: 224 folhas, 134 sintéticas, zero divergência de leitura, e a divergência de R$ 26.534.262,98 sem D/C |
| `portal/test/demonstracao.test.mjs` | ★ o invariante na demonstração publicada, com o código gerado pelo servidor · verificação de leitura deixa de ser vazia · nenhuma linha de nota entrou · nada de Ativo fica sem destino |
| `portal/test/demonstracoes-selecao.test.mjs` | `aplicarSelecao` (JS) ≡ `montar_selecao` (Python), linha a linha, contra a saída real do servidor |
| `server/tests/test_normalize_parity.py` | `normalizar` da leitura ≡ `normalizeText` do portal, executando o `.js` real com o Node |

O ponto de arquitetura por trás desta suíte: `columns.py`, `tables.py` e
`page_classifier.py` são **lógica pura sobre `Palavra`**, e os imports de
`pdfplumber`/`pypdfium2` ficam confinados em funções dentro de `pdf_words.py`.
Isso não é conveniência de ambiente - é a fronteira certa. Todo o raciocínio
geométrico é importável e testável com listas construídas à mão, em qualquer
máquina, sem lib de PDF.

O gate de admissibilidade que decide se a página **merece** ser lida está em
`page_classifier.py` e é descrito em
<ref_file file="docs/08-seguranca-guardrails.md" />, camada 2.
