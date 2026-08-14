# Auditoria do dicionário de contas

> Gerado por `scripts/bootstrap_knowledge.py`. Reexecutável.

Auditoria das 1285 entradas do dicionário v1 contra as 79 posições
alocáveis do template. **Toda entrada cujo destino não resolve para uma conta
alocável é um vazamento silencioso de valor**: `structuralKey` usava `Map.get()`
exato, então a alocação acontecia na Rastreabilidade, o QA não reclamava, e o
valor simplesmente não chegava à Shadow.

## Resumo

| Situação | Entradas |
|---|---:|
| destino exato no template | 1054 |
| grafia corrigida por regra explícita | 225 |
| resolvida por nome único | 4 |
| **ambígua** (nome existe em 2 grupos) | **0** |
| **destino inexistente** | **0** |
| **destino é subtotal** (valor evaporaria) | **0** |
| origem é cabeçalho de seção (removida) | 2 |
| duplicatas removidas | 23 |
| **total no CSV final** | **1260** |

## Por que a correção do v1 não funcionava

`portal/src/core/planoContas.js` do v1 tinha um mapa `DEST_ALIASES` e uma regra
`L/P` → `LP`. Ambos eram código morto:

1. As chaves do mapa não foram normalizadas. A busca era
   `DEST_ALIASES.get(normalizeText(destino))`, e `normalizeText` remove `/`,
   `(`, `)` e `+`. Logo chaves como `'outros nao operacionais (anc)'` e
   `'ajustes derivativos / cambio (+) l/p'` eram **inalcançáveis**.
2. A regra `L/P` usava `/\bl\s*\/\s*p\b/`, que exige uma barra literal,
   mas `normalizeText` já a havia trocado por espaço. `"Mútuo Financeiro L/P"`
   chega como `"mutuo financeiro l p"` e nunca casa.

Resultado: as ~138 entradas `L/P` nunca eram corrigidas. Como
`Mútuo Financeiro L/P` e `Bancos L/P` são majoritariamente contas de **Passivo
Não Circulante**, o lado direito perdia valor de forma sistemática - que é
exatamente o sintoma `Ativo > Passivo + PL`.

No v2 a normalização é aplicada às chaves na construção do mapa e a regra de
`L/P` opera sobre o texto **já normalizado** (`l p` → `lp`). Há teste de
regressão para as duas.

## Ocorrências por destino problemático

| destino no dicionário | vezes |
|---|---:|
| `Mútuo Financeiro L/P` | 97 |
| `Bancos L/P` | 41 |
| `Dividas Fiscais de Longo Prazo` | 35 |
| `Fornecedores Externos` | 20 |
| `Outros Não Operacionais (ANC)` | 10 |
| `Passivo de Arrendamento não Circulante` | 7 |
| `Aplicações Financeiras de L/P` | 5 |
| `Ajustes derivativos / cambio (+)` | 4 |
| `Ajustes derivativos / cambio (+) L/P` | 3 |
| `Outras Dividas Financeiras L/P` | 2 |
| `PARTICIPAÇÕES MINORITÁRIAS` | 1 |

## Detalhamento

| situação | origem | destino | grupo | sub | ação |
|---|---|---|---|---|---|
| corrigido | `Instrumentos financeiros derivativos não realizados` | `Ajustes derivativos / cambio (+)` | Ativo | Circulante | -> Ajustes derivativos / cambio (+) | Passivo | Circulante |
| corrigido | `Instrumentos financeiros derivativos` | `Ajustes derivativos / cambio (+)` | Ativo | Circulante | -> Ajustes derivativos / cambio (+) | Passivo | Circulante |
| corrigido | `Instrumentos financeiros derivativos` | `Ajustes derivativos / cambio (+)` | Ativo | Circulante | -> Ajustes derivativos / cambio (+) | Passivo | Circulante |
| corrigido | `Imóveis a comercializar` | `Outros Não Operacionais (ANC)` | Ativo | Não Circulante | -> Outros Não Operacionais LP (ANC) | Ativo | Não Circulante |
| corrigido | `Contratos comercialização de energia` | `Outros Não Operacionais (ANC)` | Ativo | Não Circulante | -> Outros Não Operacionais LP (ANC) | Ativo | Não Circulante |
| corrigido | `Venda de Imóveis Repasse do SFH` | `Outros Não Operacionais (ANC)` | Ativo | Não Circulante | -> Outros Não Operacionais LP (ANC) | Ativo | Não Circulante |
| por-nome-unico | `(-)PCLD` | `Outros Operacionais (AC)` | Ativo | Não Circulante | -> Outros Operacionais (AC) | Ativo | Circulante |
| por-nome-unico | `(-)PDD` | `Outros Operacionais (AC)` | Ativo | Não Circulante | -> Outros Operacionais (AC) | Ativo | Circulante |
| corrigido | `Processos Judiciais` | `Outros Não Operacionais (ANC)` | Ativo | Não Circulante | -> Outros Não Operacionais LP (ANC) | Ativo | Não Circulante |
| por-nome-unico | `Realizável de longo prazo` | `Outros Operacionais (AC)` | Ativo | Não Circulante | -> Outros Operacionais (AC) | Ativo | Circulante |
| corrigido | `Títulos precatórios` | `Outros Não Operacionais (ANC)` | Ativo | Não Circulante | -> Outros Não Operacionais LP (ANC) | Ativo | Não Circulante |
| corrigido | `(-)Serviços executados a faturar` | `Outros Não Operacionais (ANC)` | Ativo | Não Circulante | -> Outros Não Operacionais LP (ANC) | Ativo | Não Circulante |
| corrigido | `Instrumentos financeiros derivativos não realizados Longo prazo` | `Ajustes derivativos / cambio (+)` | Ativo | Não Circulante | -> Ajustes derivativos / cambio (+) | Passivo | Circulante |
| corrigido | `contrato de mutuo` | `Mútuo Financeiro L/P` | Ativo | Não Circulante | -> Mútuo Financeiro LP | Ativo | Não Circulante |
| corrigido | `ativos com partes relacionadas` | `Mútuo Financeiro L/P` | Ativo | Não Circulante | -> Mútuo Financeiro LP | Ativo | Não Circulante |
| corrigido | `transacoes intercompanhia` | `Mútuo Financeiro L/P` | Ativo | Não Circulante | -> Mútuo Financeiro LP | Ativo | Não Circulante |
| corrigido | `Transações com partes relacionadas` | `Mútuo Financeiro L/P` | Ativo | Não Circulante | -> Mútuo Financeiro LP | Ativo | Não Circulante |
| corrigido | `Conta Corrente Ativa` | `Mútuo Financeiro L/P` | Ativo | Não Circulante | -> Mútuo Financeiro LP | Ativo | Não Circulante |
| corrigido | `Adiantamento por conta de lucros` | `Mútuo Financeiro L/P` | Ativo | Não Circulante | -> Mútuo Financeiro LP | Ativo | Não Circulante |
| corrigido | `Interligada Transporte e Comercio Fassina Ltda` | `Mútuo Financeiro L/P` | Ativo | Não Circulante | -> Mútuo Financeiro LP | Ativo | Não Circulante |
| corrigido | `antecipacacao de lucros` | `Mútuo Financeiro L/P` | Ativo | Não Circulante | -> Mútuo Financeiro LP | Ativo | Não Circulante |
| corrigido | `antecipacao de dividendos` | `Mútuo Financeiro L/P` | Ativo | Não Circulante | -> Mútuo Financeiro LP | Ativo | Não Circulante |
| corrigido | `dividendos e juros sobre capital proprio a receber` | `Mútuo Financeiro L/P` | Ativo | Não Circulante | -> Mútuo Financeiro LP | Ativo | Não Circulante |
| corrigido | `conta corrente de socios` | `Mútuo Financeiro L/P` | Ativo | Não Circulante | -> Mútuo Financeiro LP | Ativo | Não Circulante |
| corrigido | `antecipacao de lucros` | `Mútuo Financeiro L/P` | Ativo | Não Circulante | -> Mútuo Financeiro LP | Ativo | Não Circulante |
| corrigido | `adiantamento de lucros` | `Mútuo Financeiro L/P` | Ativo | Não Circulante | -> Mútuo Financeiro LP | Ativo | Não Circulante |
| corrigido | `valores a receber de partes relacionadas` | `Mútuo Financeiro L/P` | Ativo | Não Circulante | -> Mútuo Financeiro LP | Ativo | Não Circulante |
| corrigido | `LUCROS DISTRIBUIDOS NO EXERCICIO` | `Mútuo Financeiro L/P` | Ativo | Não Circulante | -> Mútuo Financeiro LP | Ativo | Não Circulante |
| corrigido | `MÚTUO ENTRE COLIGADAS` | `Mútuo Financeiro L/P` | Ativo | Não Circulante | -> Mútuo Financeiro LP | Ativo | Não Circulante |
| corrigido | `creditos pessoas ligadas` | `Mútuo Financeiro L/P` | Ativo | Não Circulante | -> Mútuo Financeiro LP | Ativo | Não Circulante |
| corrigido | `MUTUOS` | `Mútuo Financeiro L/P` | Ativo | Não Circulante | -> Mútuo Financeiro LP | Ativo | Não Circulante |
| corrigido | `adiantamento a titular` | `Mútuo Financeiro L/P` | Ativo | Não Circulante | -> Mútuo Financeiro LP | Ativo | Não Circulante |
| corrigido | `emprestimos empresas ligadas` | `Mútuo Financeiro L/P` | Ativo | Não Circulante | -> Mútuo Financeiro LP | Ativo | Não Circulante |
| corrigido | `SOCIOS E CONTROLADORAS` | `Mútuo Financeiro L/P` | Ativo | Não Circulante | -> Mútuo Financeiro LP | Ativo | Não Circulante |
| corrigido | `SOCIOS CONTA ÉSPECIAL` | `Mútuo Financeiro L/P` | Ativo | Não Circulante | -> Mútuo Financeiro LP | Ativo | Não Circulante |
| corrigido | `contratos de mutuos empresas` | `Mútuo Financeiro L/P` | Ativo | Não Circulante | -> Mútuo Financeiro LP | Ativo | Não Circulante |
| corrigido | `Créditos com Pessoas Relacionadas` | `Mútuo Financeiro L/P` | Ativo | Não Circulante | -> Mútuo Financeiro LP | Ativo | Não Circulante |
| corrigido | `conta corrente coligada` | `Mútuo Financeiro L/P` | Ativo | Não Circulante | -> Mútuo Financeiro LP | Ativo | Não Circulante |
| corrigido | `Adiantamento p futuro aumento de capital` | `Mútuo Financeiro L/P` | Ativo | Não Circulante | -> Mútuo Financeiro LP | Ativo | Não Circulante |
| corrigido | `SÓCIOS ADMINISTRADORES E PESSOAS LIGADAS` | `Mútuo Financeiro L/P` | Ativo | Não Circulante | -> Mútuo Financeiro LP | Ativo | Não Circulante |
| corrigido | `Operações de Mutuo` | `Mútuo Financeiro L/P` | Ativo | Não Circulante | -> Mútuo Financeiro LP | Ativo | Não Circulante |
| corrigido | `DIVIDENDOS A RECEBER` | `Mútuo Financeiro L/P` | Ativo | Não Circulante | -> Mútuo Financeiro LP | Ativo | Não Circulante |
| corrigido | `Créditos com Empresas Ligadas` | `Mútuo Financeiro L/P` | Ativo | Não Circulante | -> Mútuo Financeiro LP | Ativo | Não Circulante |
| corrigido | `Sociedades ligadas` | `Mútuo Financeiro L/P` | Ativo | Não Circulante | -> Mútuo Financeiro LP | Ativo | Não Circulante |
| corrigido | `Adiantamento a sócios` | `Mútuo Financeiro L/P` | Ativo | Não Circulante | -> Mútuo Financeiro LP | Ativo | Não Circulante |
| corrigido | `Adiantamentos a sócios` | `Mútuo Financeiro L/P` | Ativo | Não Circulante | -> Mútuo Financeiro LP | Ativo | Não Circulante |
| corrigido | `Contas a receber de partes relacionadas` | `Mútuo Financeiro L/P` | Ativo | Não Circulante | -> Mútuo Financeiro LP | Ativo | Não Circulante |
| corrigido | `Créditos com sócios` | `Mútuo Financeiro L/P` | Ativo | Não Circulante | -> Mútuo Financeiro LP | Ativo | Não Circulante |
| corrigido | `Créditos de pessoas ligadas - Mútuo` | `Mútuo Financeiro L/P` | Ativo | Não Circulante | -> Mútuo Financeiro LP | Ativo | Não Circulante |
| corrigido | `Créditos de sócios` | `Mútuo Financeiro L/P` | Ativo | Não Circulante | -> Mútuo Financeiro LP | Ativo | Não Circulante |
| corrigido | `Distribuição de lucros antecipada` | `Mútuo Financeiro L/P` | Ativo | Não Circulante | -> Mútuo Financeiro LP | Ativo | Não Circulante |
| corrigido | `Distribuição de lucros antecipados` | `Mútuo Financeiro L/P` | Ativo | Não Circulante | -> Mútuo Financeiro LP | Ativo | Não Circulante |
| corrigido | `Empréstimos` | `Mútuo Financeiro L/P` | Ativo | Não Circulante | -> Mútuo Financeiro LP | Ativo | Não Circulante |
| corrigido | `Empréstimos a sócios` | `Mútuo Financeiro L/P` | Ativo | Não Circulante | -> Mútuo Financeiro LP | Ativo | Não Circulante |
| corrigido | `Empréstimos a sócios e diretores` | `Mútuo Financeiro L/P` | Ativo | Não Circulante | -> Mútuo Financeiro LP | Ativo | Não Circulante |
| corrigido | `Empréstimos a terceiros` | `Mútuo Financeiro L/P` | Ativo | Não Circulante | -> Mútuo Financeiro LP | Ativo | Não Circulante |
| corrigido | `Mútuos com partes relacionadas` | `Mútuo Financeiro L/P` | Ativo | Não Circulante | -> Mútuo Financeiro LP | Ativo | Não Circulante |
| corrigido | `Partes relaciondas` | `Mútuo Financeiro L/P` | Ativo | Não Circulante | -> Mútuo Financeiro LP | Ativo | Não Circulante |
| corrigido | `Administradores e Sócios` | `Mútuo Financeiro L/P` | Ativo | Não Circulante | -> Mútuo Financeiro LP | Ativo | Não Circulante |
| corrigido | `-c/c controlada coremal quimica` | `Mútuo Financeiro L/P` | Ativo | Não Circulante | -> Mútuo Financeiro LP | Ativo | Não Circulante |
| corrigido | `Debêntures` | `Aplicações Financeiras de L/P` | Ativo | Não Circulante | -> Aplicações Financeiras de LP | Ativo | Não Circulante |
| corrigido | `Titulos e Valores Mobiliários` | `Aplicações Financeiras de L/P` | Ativo | Não Circulante | -> Aplicações Financeiras de LP | Ativo | Não Circulante |
| corrigido | `Títulos e ações` | `Aplicações Financeiras de L/P` | Ativo | Não Circulante | -> Aplicações Financeiras de LP | Ativo | Não Circulante |
| corrigido | `TITULOS DE CAPITALIZACAO` | `Aplicações Financeiras de L/P` | Ativo | Não Circulante | -> Aplicações Financeiras de LP | Ativo | Não Circulante |
| corrigido | `Plano de Capitalização` | `Aplicações Financeiras de L/P` | Ativo | Não Circulante | -> Aplicações Financeiras de LP | Ativo | Não Circulante |
| corrigido | `depositos judiciais` | `Outros Não Operacionais (ANC)` | Ativo | Não Circulante | -> Outros Não Operacionais LP (ANC) | Ativo | Não Circulante |
| corrigido | `Outros Não Operacionais LP` | `Outros Não Operacionais (ANC)` | Ativo | Não Circulante | -> Outros Não Operacionais LP (ANC) | Ativo | Não Circulante |
| corrigido | `Depósitos judiciais e indenizações a receber` | `Outros Não Operacionais (ANC)` | Ativo | Não Circulante | -> Outros Não Operacionais LP (ANC) | Ativo | Não Circulante |
| corrigido | `Assets of the disposal group held for sale` | `Outros Não Operacionais (ANC)` | Ativo | Não Circulante | -> Outros Não Operacionais LP (ANC) | Ativo | Não Circulante |
| corrigido | `Duplicatas a pagar` | `Fornecedores Externos` | Passivo | Circulante | -> Fornecedores | Passivo | Circulante |
| corrigido | `FORNECEDORES DE MERC PARA REVENDA` | `Fornecedores Externos` | Passivo | Circulante | -> Fornecedores | Passivo | Circulante |
| corrigido | `FORNECEDORES DE MATERIAIS E SERVICOS` | `Fornecedores Externos` | Passivo | Circulante | -> Fornecedores | Passivo | Circulante |
| corrigido | `FORNECEDORES DE CONSUMO` | `Fornecedores Externos` | Passivo | Circulante | -> Fornecedores | Passivo | Circulante |
| corrigido | `FORNECEDORES CURTO PRAZO` | `Fornecedores Externos` | Passivo | Circulante | -> Fornecedores | Passivo | Circulante |
| corrigido | `Contas a Pagar - Fornecedores CP` | `Fornecedores Externos` | Passivo | Circulante | -> Fornecedores | Passivo | Circulante |
| corrigido | `Fornecedores` | `Fornecedores Externos` | Passivo | Circulante | -> Fornecedores | Passivo | Circulante |
| corrigido | `Fornecedores gerais` | `Fornecedores Externos` | Passivo | Circulante | -> Fornecedores | Passivo | Circulante |
| corrigido | `Fornecedores a pagar` | `Fornecedores Externos` | Passivo | Circulante | -> Fornecedores | Passivo | Circulante |
| corrigido | `Fornecedores diversos` | `Fornecedores Externos` | Passivo | Circulante | -> Fornecedores | Passivo | Circulante |
| corrigido | `Fornecedores ME` | `Fornecedores Externos` | Passivo | Circulante | -> Fornecedores | Passivo | Circulante |
| corrigido | `Fornecedores mercado externo` | `Fornecedores Externos` | Passivo | Circulante | -> Fornecedores | Passivo | Circulante |
| corrigido | `Fornecedores mercado interno` | `Fornecedores Externos` | Passivo | Circulante | -> Fornecedores | Passivo | Circulante |
| corrigido | `Fornecedores MI` | `Fornecedores Externos` | Passivo | Circulante | -> Fornecedores | Passivo | Circulante |
| corrigido | `Fornecedores no exterior` | `Fornecedores Externos` | Passivo | Circulante | -> Fornecedores | Passivo | Circulante |
| corrigido | `Fornecedores no país` | `Fornecedores Externos` | Passivo | Circulante | -> Fornecedores | Passivo | Circulante |
| corrigido | `Fornecedores/credores` | `Fornecedores Externos` | Passivo | Circulante | -> Fornecedores | Passivo | Circulante |
| corrigido | `Trade payables` | `Fornecedores Externos` | Passivo | Circulante | -> Fornecedores | Passivo | Circulante |
| corrigido | `-.fornec./matls.merc.interno` | `Fornecedores Externos` | Passivo | Circulante | -> Fornecedores | Passivo | Circulante |
| corrigido | `.fornec./matls.merc.externo` | `Fornecedores Externos` | Passivo | Circulante | -> Fornecedores | Passivo | Circulante |
| origem-de-seção | `Passivo não circulante` | `Outros Operacionais (PNC)` | Passivo | Não Circulante | removida: casaria com qualquer 'Total de ...' |
| corrigido | `leasing e consorcios` | `Bancos L/P` | Passivo | Não Circulante | -> Bancos LP | Passivo | Não Circulante |
| corrigido | `leasing` | `Bancos L/P` | Passivo | Não Circulante | -> Bancos LP | Passivo | Não Circulante |
| corrigido | `Encargos a Transcorrer` | `Bancos L/P` | Passivo | Não Circulante | -> Bancos LP | Passivo | Não Circulante |
| corrigido | `OBRIGAÇÕES BANCÁRIAS` | `Bancos L/P` | Passivo | Não Circulante | -> Bancos LP | Passivo | Não Circulante |
| corrigido | `obrigacoes financeiras` | `Bancos L/P` | Passivo | Não Circulante | -> Bancos LP | Passivo | Não Circulante |
| corrigido | `BANCO COM CONTAS NEGATIVAS` | `Bancos L/P` | Passivo | Não Circulante | -> Bancos LP | Passivo | Não Circulante |
| corrigido | `Banco Santander` | `Bancos L/P` | Passivo | Não Circulante | -> Bancos LP | Passivo | Não Circulante |
| corrigido | `empréstimos de longo prazo` | `Bancos L/P` | Passivo | Não Circulante | -> Bancos LP | Passivo | Não Circulante |
| corrigido | `CONSÓRCIOS CONTEMPLADOS DE LONGO PRAZO` | `Bancos L/P` | Passivo | Não Circulante | -> Bancos LP | Passivo | Não Circulante |
| corrigido | `JUROS A APROPRIAR SOBRE FINANCIAMENTOS LONGo` | `Bancos L/P` | Passivo | Não Circulante | -> Bancos LP | Passivo | Não Circulante |
| corrigido | `FINANCIAMENTOS DE LONGO PRAZO` | `Bancos L/P` | Passivo | Não Circulante | -> Bancos LP | Passivo | Não Circulante |
| corrigido | `consórcios contemplados` | `Bancos L/P` | Passivo | Não Circulante | -> Bancos LP | Passivo | Não Circulante |
| corrigido | `EMPRESTIMOS CAIXA ECONOMICA FEDERAL` | `Bancos L/P` | Passivo | Não Circulante | -> Bancos LP | Passivo | Não Circulante |
| corrigido | `(-) encargos a apropriar` | `Bancos L/P` | Passivo | Não Circulante | -> Bancos LP | Passivo | Não Circulante |
| corrigido | `(-) encargos financeiros a apropriar` | `Bancos L/P` | Passivo | Não Circulante | -> Bancos LP | Passivo | Não Circulante |
| corrigido | `Bancos conta empréstimo` | `Bancos L/P` | Passivo | Não Circulante | -> Bancos LP | Passivo | Não Circulante |
| corrigido | `Bancos conta empréstimos` | `Bancos L/P` | Passivo | Não Circulante | -> Bancos LP | Passivo | Não Circulante |
| corrigido | `Bancos conta financiamento` | `Bancos L/P` | Passivo | Não Circulante | -> Bancos LP | Passivo | Não Circulante |
| corrigido | `Bancos conta financiamentos` | `Bancos L/P` | Passivo | Não Circulante | -> Bancos LP | Passivo | Não Circulante |
| corrigido | `Dívidas Bancárias` | `Bancos L/P` | Passivo | Não Circulante | -> Bancos LP | Passivo | Não Circulante |
| corrigido | `Empréstimo capital de giro` | `Bancos L/P` | Passivo | Não Circulante | -> Bancos LP | Passivo | Não Circulante |
| corrigido | `Empréstimos` | `Bancos L/P` | Passivo | Não Circulante | -> Bancos LP | Passivo | Não Circulante |
| corrigido | `Empréstimos e financiamentos a pagar` | `Bancos L/P` | Passivo | Não Circulante | -> Bancos LP | Passivo | Não Circulante |
| corrigido | `Empréstimos capital de giro` | `Bancos L/P` | Passivo | Não Circulante | -> Bancos LP | Passivo | Não Circulante |
| corrigido | `Empréstimos CP` | `Bancos L/P` | Passivo | Não Circulante | -> Bancos LP | Passivo | Não Circulante |
| corrigido | `Empréstimos e financiamentos` | `Bancos L/P` | Passivo | Não Circulante | -> Bancos LP | Passivo | Não Circulante |
| corrigido | `Empréstimos e financiamentos bancários` | `Bancos L/P` | Passivo | Não Circulante | -> Bancos LP | Passivo | Não Circulante |
| corrigido | `Empréstimos, financiamentos e debêntures` | `Bancos L/P` | Passivo | Não Circulante | -> Bancos LP | Passivo | Não Circulante |
| corrigido | `encargos a apropriar` | `Bancos L/P` | Passivo | Não Circulante | -> Bancos LP | Passivo | Não Circulante |
| corrigido | `encargos financeiros a apropriar` | `Bancos L/P` | Passivo | Não Circulante | -> Bancos LP | Passivo | Não Circulante |
| corrigido | `Financiamento a construção` | `Bancos L/P` | Passivo | Não Circulante | -> Bancos LP | Passivo | Não Circulante |
| corrigido | `Financiamento de Construção SFH` | `Bancos L/P` | Passivo | Não Circulante | -> Bancos LP | Passivo | Não Circulante |
| corrigido | `Financiamento para aquisição de imóveis` | `Bancos L/P` | Passivo | Não Circulante | -> Bancos LP | Passivo | Não Circulante |
| corrigido | `Financiamentos` | `Bancos L/P` | Passivo | Não Circulante | -> Bancos LP | Passivo | Não Circulante |
| corrigido | `Instituições Financeiras` | `Bancos L/P` | Passivo | Não Circulante | -> Bancos LP | Passivo | Não Circulante |
| corrigido | `Instrumentos financeiros` | `Bancos L/P` | Passivo | Não Circulante | -> Bancos LP | Passivo | Não Circulante |
| corrigido | `Consórcios a pagar` | `Bancos L/P` | Passivo | Não Circulante | -> Bancos LP | Passivo | Não Circulante |
| corrigido | `Debêntures` | `Bancos L/P` | Passivo | Não Circulante | -> Bancos LP | Passivo | Não Circulante |
| corrigido | `Risco sacado pagar` | `Bancos L/P` | Passivo | Não Circulante | -> Bancos LP | Passivo | Não Circulante |
| corrigido | `fornecedores-risco sacado` | `Bancos L/P` | Passivo | Não Circulante | -> Bancos LP | Passivo | Não Circulante |
| corrigido | `Loans and borrowings` | `Bancos L/P` | Passivo | Não Circulante | -> Bancos LP | Passivo | Não Circulante |
| corrigido | `tributos parcelados` | `Dividas Fiscais de Longo Prazo` | Passivo | Não Circulante | -> Dividas Fiscais LP | Passivo | Não Circulante |
| corrigido | `tributos a recolher` | `Dividas Fiscais de Longo Prazo` | Passivo | Não Circulante | -> Dividas Fiscais LP | Passivo | Não Circulante |
| corrigido | `obrigações fiscais/tributárias` | `Dividas Fiscais de Longo Prazo` | Passivo | Não Circulante | -> Dividas Fiscais LP | Passivo | Não Circulante |
| corrigido | `TRIBUTOS A RECUPERAR COMPENSAR` | `Dividas Fiscais de Longo Prazo` | Passivo | Não Circulante | -> Dividas Fiscais LP | Passivo | Não Circulante |
| corrigido | `IMPOSTOS TAXAS E CONTRIBUICOES A PAGAR` | `Dividas Fiscais de Longo Prazo` | Passivo | Não Circulante | -> Dividas Fiscais LP | Passivo | Não Circulante |
| corrigido | `impostos a pagar ou a recolher` | `Dividas Fiscais de Longo Prazo` | Passivo | Não Circulante | -> Dividas Fiscais LP | Passivo | Não Circulante |
| corrigido | `OUTROS IMPOSTOS E CONTRIBUIÇÕES` | `Dividas Fiscais de Longo Prazo` | Passivo | Não Circulante | -> Dividas Fiscais LP | Passivo | Não Circulante |
| corrigido | `Debitos fiscais` | `Dividas Fiscais de Longo Prazo` | Passivo | Não Circulante | -> Dividas Fiscais LP | Passivo | Não Circulante |
| corrigido | `Débitos tributários parcelados` | `Dividas Fiscais de Longo Prazo` | Passivo | Não Circulante | -> Dividas Fiscais LP | Passivo | Não Circulante |
| corrigido | `Imposto de renda e contribuição social a recolher` | `Dividas Fiscais de Longo Prazo` | Passivo | Não Circulante | -> Dividas Fiscais LP | Passivo | Não Circulante |
| corrigido | `IRPJ e CSLL a pagar` | `Dividas Fiscais de Longo Prazo` | Passivo | Não Circulante | -> Dividas Fiscais LP | Passivo | Não Circulante |
| corrigido | `Impostos a pagar` | `Dividas Fiscais de Longo Prazo` | Passivo | Não Circulante | -> Dividas Fiscais LP | Passivo | Não Circulante |
| corrigido | `Impostos a recolher` | `Dividas Fiscais de Longo Prazo` | Passivo | Não Circulante | -> Dividas Fiscais LP | Passivo | Não Circulante |
| corrigido | `Impostos e contribuições a recolher` | `Dividas Fiscais de Longo Prazo` | Passivo | Não Circulante | -> Dividas Fiscais LP | Passivo | Não Circulante |
| corrigido | `Obrigações fiscais a recolher` | `Dividas Fiscais de Longo Prazo` | Passivo | Não Circulante | -> Dividas Fiscais LP | Passivo | Não Circulante |
| corrigido | `Obrigações Fiscais Estaduais` | `Dividas Fiscais de Longo Prazo` | Passivo | Não Circulante | -> Dividas Fiscais LP | Passivo | Não Circulante |
| corrigido | `Obrigações Fiscais Municipais` | `Dividas Fiscais de Longo Prazo` | Passivo | Não Circulante | -> Dividas Fiscais LP | Passivo | Não Circulante |
| corrigido | `Obrigações Tributárias` | `Dividas Fiscais de Longo Prazo` | Passivo | Não Circulante | -> Dividas Fiscais LP | Passivo | Não Circulante |
| corrigido | `Passivo fiscal corrente` | `Dividas Fiscais de Longo Prazo` | Passivo | Não Circulante | -> Dividas Fiscais LP | Passivo | Não Circulante |
| corrigido | `Simples nacional a recolher` | `Dividas Fiscais de Longo Prazo` | Passivo | Não Circulante | -> Dividas Fiscais LP | Passivo | Não Circulante |
| corrigido | `Encargos Sociais e tributárias` | `Dividas Fiscais de Longo Prazo` | Passivo | Não Circulante | -> Dividas Fiscais LP | Passivo | Não Circulante |
| corrigido | `obrigacoes sociais parceladas` | `Dividas Fiscais de Longo Prazo` | Passivo | Não Circulante | -> Dividas Fiscais LP | Passivo | Não Circulante |
| corrigido | `IMPOSTOS PARCELADOS LONGO PRAZO` | `Dividas Fiscais de Longo Prazo` | Passivo | Não Circulante | -> Dividas Fiscais LP | Passivo | Não Circulante |
| corrigido | `PARCELAMENTOS DE OBRIGAÇÕES` | `Dividas Fiscais de Longo Prazo` | Passivo | Não Circulante | -> Dividas Fiscais LP | Passivo | Não Circulante |
| corrigido | `PARCELAMENTOS SOCIAIS TRIBUTARIAS` | `Dividas Fiscais de Longo Prazo` | Passivo | Não Circulante | -> Dividas Fiscais LP | Passivo | Não Circulante |
| corrigido | `PARCELAMENTO OBRIG SOCIAIS TRIBUTARIAS` | `Dividas Fiscais de Longo Prazo` | Passivo | Não Circulante | -> Dividas Fiscais LP | Passivo | Não Circulante |
| corrigido | `PARCELAMENTOS TRIBUTÁRIOS` | `Dividas Fiscais de Longo Prazo` | Passivo | Não Circulante | -> Dividas Fiscais LP | Passivo | Não Circulante |
| corrigido | `Parcelamentos SEFAZ` | `Dividas Fiscais de Longo Prazo` | Passivo | Não Circulante | -> Dividas Fiscais LP | Passivo | Não Circulante |
| corrigido | `Parcelamentos Municipais` | `Dividas Fiscais de Longo Prazo` | Passivo | Não Circulante | -> Dividas Fiscais LP | Passivo | Não Circulante |
| corrigido | `Parcelamentos federais a recolher` | `Dividas Fiscais de Longo Prazo` | Passivo | Não Circulante | -> Dividas Fiscais LP | Passivo | Não Circulante |
| corrigido | `Parcelamento Previdenciário` | `Dividas Fiscais de Longo Prazo` | Passivo | Não Circulante | -> Dividas Fiscais LP | Passivo | Não Circulante |
| corrigido | `Débitos tributários` | `Dividas Fiscais de Longo Prazo` | Passivo | Não Circulante | -> Dividas Fiscais LP | Passivo | Não Circulante |
| corrigido | `Impostos parcelados` | `Dividas Fiscais de Longo Prazo` | Passivo | Não Circulante | -> Dividas Fiscais LP | Passivo | Não Circulante |
| corrigido | `Parcelamento Especial` | `Dividas Fiscais de Longo Prazo` | Passivo | Não Circulante | -> Dividas Fiscais LP | Passivo | Não Circulante |
| corrigido | `Parcelamentos de tributos` | `Dividas Fiscais de Longo Prazo` | Passivo | Não Circulante | -> Dividas Fiscais LP | Passivo | Não Circulante |
| corrigido | `Outras Dividas Financeiras LP` | `Outras Dividas Financeiras L/P` | Passivo | Não Circulante | -> Outras Dividas Financeiras LP | Passivo | Não Circulante |
| corrigido | `Aquisição de controladas` | `Outras Dividas Financeiras L/P` | Passivo | Não Circulante | -> Outras Dividas Financeiras LP | Passivo | Não Circulante |
| corrigido | `Passivo de arrendamentento` | `Passivo de Arrendamento não Circulante` | Passivo | Não Circulante | -> Passivo de Arrendamento LP | Passivo | Não Circulante |
| corrigido | `Obrigações por arrendamento` | `Passivo de Arrendamento não Circulante` | Passivo | Não Circulante | -> Passivo de Arrendamento LP | Passivo | Não Circulante |
| corrigido | `arrendamento a pagar` | `Passivo de Arrendamento não Circulante` | Passivo | Não Circulante | -> Passivo de Arrendamento LP | Passivo | Não Circulante |
| corrigido | `Arrendamento mercantil` | `Passivo de Arrendamento não Circulante` | Passivo | Não Circulante | -> Passivo de Arrendamento LP | Passivo | Não Circulante |
| corrigido | `Passivo de arrendamento` | `Passivo de Arrendamento não Circulante` | Passivo | Não Circulante | -> Passivo de Arrendamento LP | Passivo | Não Circulante |
| corrigido | `Lease liabilities` | `Passivo de Arrendamento não Circulante` | Passivo | Não Circulante | -> Passivo de Arrendamento LP | Passivo | Não Circulante |
| corrigido | `AVP Direito de uso` | `Passivo de Arrendamento não Circulante` | Passivo | Não Circulante | -> Passivo de Arrendamento LP | Passivo | Não Circulante |
| corrigido | `Derivativos` | `Ajustes derivativos / cambio (+) L/P` | Passivo | Não Circulante | -> Ajustes derivativos / cambio (PNC) | Passivo | Não Circulante |
| corrigido | `Derivativos - hedge` | `Ajustes derivativos / cambio (+) L/P` | Passivo | Não Circulante | -> Ajustes derivativos / cambio (PNC) | Passivo | Não Circulante |
| corrigido | `Instrumentos financeiros derivativos` | `Ajustes derivativos / cambio (+) L/P` | Passivo | Não Circulante | -> Ajustes derivativos / cambio (PNC) | Passivo | Não Circulante |
| corrigido | `contrato de mutuo` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `passivos com partes relacionadas` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `Débito com partes relacionadas` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `Crédito de sócios` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `Créditos com Quotistas` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `Conta Corrente passiva` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `Dividendos e juros sobre o capital próprio a pagar` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `Distribuição de lucros` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `Lucros a distribuir` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `Sócios conta lucros` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `CONTA CORRENTE DOS COTISTAS` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `reserva para aumento de capital` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `Reserva para Futuro Aumento de Capital` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `EMPRESTIMOS ENTRE COLIGADAS E CONTROLADAS` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `MUTUOS PARTES RELACIONADAS` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `emprestimos socios` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `emprestimos com partes relacionadas` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `valores a pagar para partes relacionadas` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `MÚTUO ENTRE COLIGADAS` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `CREDITO DE PESSOAS LIGADAS JURIDICA` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `creditos pessoas ligadas` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `Adto Futuro Aumento de Capital` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `AFAC` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `SOCIOS CONTA ESPECIAL` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `conta corrente coligada` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `Mútuos` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `SÓCIOS ADMINISTRADORES E PESSOAS LIGADAS` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `Operações de Mutuo` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `adiantamentos a sócios` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `Obrigações com Empresas Ligadas` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `Obrigações com Acionistas` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `Adiantamento de sócios` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `Adiantamento para aumento de capital` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `Adiantamento para futuro aumento de capital` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `Contas a pagar com partes relacionadas` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `Contas a pagar de partes relacionadas` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `Débitos de pessoas ligadas - Mútuo` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `Empréstimos a pessoas ligadas` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `Empréstimos de sócios` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `Empréstimos dos sócios` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `Mútuos com partes relacionadas` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `Partes Relacionadas` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `Sócios c/empréstimo` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `Sócios c/particular` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `Sócios conta administradores` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `Sócios conta corrente` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `Sócios conta empréstimo` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `Sócios conta particular` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `Créditos de Interligadasadt Aumento capital` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| corrigido | `AFAC Adiant p Futuro Aum Capital` | `Mútuo Financeiro L/P` | Passivo | Não Circulante | -> Mútuo Financeiro LP | Passivo | Não Circulante |
| por-nome-unico | `Obrigações com plano de pensão` | `Outros Operacionais (PC)` | Passivo | Não Circulante | -> Outros Operacionais (PC) | Passivo | Circulante |
| corrigido | `PARTICIPAÇÕES MINORITÁRIAS` | `PARTICIPAÇÕES MINORITÁRIAS` | Passivo | Não Circulante | -> PARTICIPAÇÕES MINORITÁRIAS | Passivo | PL |
| origem-de-seção | `Resultado` | `Lucros Acumulados` | Passivo | PL | removida: casaria com qualquer 'Total de ...' |
