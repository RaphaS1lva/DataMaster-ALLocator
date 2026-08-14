# Plano de Contas - template Shadow

> **Fonte de verdade.** Este arquivo é lido por `scripts/gen_knowledge.py`, que
> gera `portal/src/core/data/planoContas.gen.js`. Não edite o `.gen.js`.

São **79 contas alocáveis** (`conta`) e **28 subtotais** (`subtotal`). Um
subtotal é calculado por aritmética (ver `formulas-shadow.md`) e **nunca recebe
alocação**: alocar num subtotal faz o valor desaparecer do balanço, porque ele
não tem bucket de agregação.

## Colunas

| Coluna | Significado |
|---|---|
| `row` | linha na planilha Shadow (é a identidade usada pelas fórmulas) |
| `side` | `AP` = Ativo/Passivo/PL · `DRE` = Demonstração do Resultado |
| `destino` | nome EXATO, incluindo prefixo de sinal e espaços duplos. É parte da chave. |
| `grupo` / `sub` | compõem a chave estrutural `destino\|grupo\|sub` |
| `tipo` | `conta` (alocável) · `subtotal` (calculado) |
| `sinal` | ver `regras-de-sinal.md` - `none` \| `neg` \| `pos` \| `pm` |

**Atenção aos espaços:** `-  Despesas Financeiras` tem dois espaços,
`Resultado da Exploração ` e `Lucro antes de Impostos ` têm espaço no fim.
Isso é preservado verbatim porque faz parte da chave no template original.

**Homônimos entre lados** - `Mútuo Financeiro` (Ativo linha 18 / Passivo 54) e
`Mútuo Financeiro LP` (Ativo 26 / Passivo 67). Só `grupo` + `sub` desambiguam.
Resolver por nome apenas é o que jogava um mútuo passivo no Ativo e produzia
erro de 2x o valor.

## Ativo · Circulante

14 contas alocáveis, 4 subtotais.

| row | side | destino | tipo | sinal |
|---:|:---:|---|:---:|:---:|
| 5 | AP | `Caixa` | conta | none |
| 6 | AP | `Aplicações Financeiras` | conta | none |
| 7 | AP | `Disponibilidades` | subtotal | none |
| 8 | AP | `Clientes` | conta | none |
| 9 | AP | `Clientes - Grupo` | conta | none |
| 10 | AP | `-PDD` | conta | neg |
| 11 | AP | `Clientes Líquido` | subtotal | none |
| 12 | AP | `Matéria-Prima` | conta | none |
| 13 | AP | `Produtos em Elaboração` | conta | none |
| 14 | AP | `Produtos Acabados` | conta | none |
| 15 | AP | `Estoques` | subtotal | none |
| 16 | AP | `Ajustes derivativos / cambio (AC)` | conta | none |
| 17 | AP | `Adiantamento a Fornecedores` | conta | none |
| 18 | AP | `Mútuo Financeiro` | conta | none |
| 19 | AP | `Impostos a Recuperar` | conta | none |
| 20 | AP | `Outros Operacionais (AC)` | conta | none |
| 21 | AP | `Outros Não Operacionais (AC)` | conta | none |
| 22 | AP | `TOTAL ATIVO CIRCULANTE` | subtotal | none |

## Ativo · Não Circulante

14 contas alocáveis, 5 subtotais.

| row | side | destino | tipo | sinal |
|---:|:---:|---|:---:|:---:|
| 23 | AP | `Ajustes derivativos / cambio (ANC)` | conta | none |
| 24 | AP | `Impostos Diferidos` | conta | none |
| 25 | AP | `Impostos a recuperar/Crédito tributário` | conta | none |
| 26 | AP | `Mútuo Financeiro LP` | conta | none |
| 27 | AP | `Aplicações Financeiras de LP` | conta | none |
| 28 | AP | `Outros Operacionais (ANC)` | conta | none |
| 29 | AP | `Outros Não Operacionais LP (ANC)` | conta | none |
| 30 | AP | `TOTAL ATIVO REALIZÁVEL LP` | subtotal | none |
| 31 | AP | `Direito de Uso` | conta | none |
| 32 | AP | `- Depreciação acumulada (Direito de uso)` | conta | neg |
| 33 | AP | `Direito de Uso Líquido` | subtotal | none |
| 34 | AP | `Terreno` | conta | none |
| 35 | AP | `Edificios, maquinas e outros` | conta | none |
| 36 | AP | `-Depreciação Acumulada` | conta | neg |
| 37 | AP | `Imobilizado líquido` | subtotal | none |
| 38 | AP | `Investimentos` | conta | none |
| 39 | AP | `Outros Ativos Intangiveis / Goodwill` | conta | none |
| 40 | AP | `TOTAL ATIVO FIXO` | subtotal | none |
| 41 | AP | `TOTAL ATIVO` | subtotal | none |

## Passivo · Circulante

15 contas alocáveis, 3 subtotais.

| row | side | destino | tipo | sinal |
|---:|:---:|---|:---:|:---:|
| 44 | AP | `PASSIVO` | subtotal | none |
| 45 | AP | `Bancos` | conta | none |
| 46 | AP | `Outras Dividas Financeiras` | conta | none |
| 47 | AP | `Confirming` | conta | none |
| 48 | AP | `Dividas Fiscais de Curto Prazo` | conta | none |
| 49 | AP | `Ajustes derivativos / cambio (+)` | conta | none |
| 50 | AP | `Fornecedores` | conta | none |
| 51 | AP | `Fornecedores - Partes Relacionadas` | conta | none |
| 52 | AP | `Fornecedores Totais` | subtotal | none |
| 53 | AP | `Passivo de Arrendamento Circulante` | conta | none |
| 54 | AP | `Mútuo Financeiro` | conta | none |
| 55 | AP | `Salários` | conta | none |
| 56 | AP | `Impostos` | conta | none |
| 57 | AP | `Adiantamento de Clientes` | conta | none |
| 58 | AP | `Dividendos a Pagar` | conta | none |
| 59 | AP | `Outros Operacionais (PC)` | conta | none |
| 60 | AP | `Outros Não Operacionais (PC)` | conta | none |
| 61 | AP | `TOTAL PASSIVO CIRCULANTE` | subtotal | none |

## Passivo · Não Circulante

9 contas alocáveis, 2 subtotais.

| row | side | destino | tipo | sinal |
|---:|:---:|---|:---:|:---:|
| 62 | AP | `Bancos LP` | conta | none |
| 63 | AP | `Outras Dividas Financeiras LP` | conta | none |
| 64 | AP | `Dividas Fiscais LP` | conta | none |
| 65 | AP | `Ajustes derivativos / cambio (PNC)` | conta | none |
| 66 | AP | `Passivo de Arrendamento LP` | conta | none |
| 67 | AP | `Mútuo Financeiro LP` | conta | none |
| 68 | AP | `Provisões` | conta | none |
| 69 | AP | `Outros Operacionais (PNC)` | conta | none |
| 70 | AP | `Outros Não Operacionais (PNC)` | conta | none |
| 71 | AP | `TOTAL PASSIVO NÃO CIRCULANTE` | subtotal | none |
| 72 | AP | `TOTAL PASSIVO` | subtotal | none |

## Passivo · PL

4 contas alocáveis, 2 subtotais.

| row | side | destino | tipo | sinal |
|---:|:---:|---|:---:|:---:|
| 75 | AP | `PARTICIPAÇÕES MINORITÁRIAS` | conta | none |
| 76 | AP | `Capital Social` | conta | none |
| 77 | AP | `Lucros Acumulados` | conta | none |
| 78 | AP | `Outras Reservas` | conta | none |
| 79 | AP | `PATRIMÔNIO LÍQUIDO` | subtotal | none |
| 80 | AP | `RECURSOS PROPRIOS - Reportado com IFRS16` | subtotal | none |

## DRE · DRE

23 contas alocáveis, 12 subtotais.

| row | side | destino | tipo | sinal |
|---:|:---:|---|:---:|:---:|
| 5 | DRE | `Vendas Totais` | conta | none |
| 6 | DRE | `-Impostos` | conta | neg |
| 7 | DRE | `Vendas Líquidas` | subtotal | none |
| 8 | DRE | `-Custo de Produtos Vendidos` | conta | neg |
| 9 | DRE | `Resultado Bruto` | subtotal | none |
| 10 | DRE | `- Despesas com Vendas` | conta | neg |
| 11 | DRE | `- Despesas Administrativas` | conta | neg |
| 12 | DRE | `Resultado da Exploração␣` | subtotal | none |
| 13 | DRE | `+/-Outras Receitas/Despesas Operacionais` | conta | pm |
| 14 | DRE | `+/-Provisões Operacionais` | conta | pm |
| 15 | DRE | `Resultado Operacional (EBIT)` | subtotal | none |
| 16 | DRE | `- Depreciação e amortização (imob e intang)` | conta | neg |
| 17 | DRE | `- Depreciação/Amortização dos Arrendamentos Op.` | conta | neg |
| 18 | DRE | `EBITDA` | subtotal | none |
| 19 | DRE | `- Despesas/Custo de Aluguel` | conta | neg |
| 20 | DRE | `EBITDA ex-IFRS16` | subtotal | none |
| 21 | DRE | `- ␣Despesas Financeiras` | conta | neg |
| 22 | DRE | `+ Receitas Financeiras` | conta | pos |
| 23 | DRE | `+/- Resultado Financeiro` | subtotal | pm |
| 24 | DRE | `+/- Variações Cambiais` | conta | pm |
| 25 | DRE | `+/- Equivalência Patrimonial` | conta | pm |
| 26 | DRE | `Lucro antes de Impostos e Extraordinários` | subtotal | none |
| 27 | DRE | `Outros não recorrentes e/ou não operacionais` | conta | none |
| 28 | DRE | `+/- Créditos Tributários` | conta | pm |
| 29 | DRE | `+/- Resultado de alienação do Imobilizado` | conta | pm |
| 30 | DRE | `- Juros de Arrendamento Operacional` | conta | neg |
| 31 | DRE | `+/- Resultado Extraordinário` | subtotal | pm |
| 32 | DRE | `Lucro antes de Impostos␣` | subtotal | none |
| 33 | DRE | `- Impostos Pagos` | conta | neg |
| 34 | DRE | `+/- Impostos Diferidos` | conta | pm |
| 35 | DRE | `Lucro Liquido` | subtotal | none |
| 36 | DRE | `+/- Resultados Abrangentes` | conta | pm |
| 37 | DRE | `Lucro Líquido+Resultado Abrangente a Distribuir` | subtotal | none |
| 39 | DRE | `- Dividendos` | conta | neg |
| 40 | DRE | `+/- Participações Minoritárias` | conta | pm |

---

## Legenda de caracteres

- `␣` marca espaço significativo (duplo ou de borda) preservado na chave.
- Ao editar, mantenha o nome **byte a byte** igual ao template Excel.
  `scripts/gen_knowledge.py` valida contra `plano-de-contas.lock.json`
  e falha se algum nome mudar sem atualização deliberada do lock.
