# Fórmulas da Shadow - grafo de subtotais

> **Fonte de verdade.** Gera `portal/src/core/data/shadowCompute.gen.js`.

Cada posição é `agg` (soma as alocações cuja chave estrutural bate) ou `calc`
(aritmética sobre outras linhas). O grafo abaixo foi verificado contra o
template Excel: **as 28 folhas do Ativo e as 28 folhas de Passivo/PL entram
exatamente uma vez cada** nos totais - sem omissão e sem dupla contagem.

## A identidade

```
Ativo        = linha 41
Passivo + PL = linha 72 + linha 80
```

Note que **80 = 75 + 79** inclui as participações minoritárias, enquanto
**79 = 76 + 77 + 78** não. Usar 79 no lugar de 80 no fechamento erra pelo
valor dos minoritários.

### Consequência importante (imunidade a erro de julgamento)

Como 61, 71 (→72) e 75, 79 (→80) todos desembocam em `Passivo + PL`, **qualquer
realocação dentro desse conjunto é neutra para o fechamento** - inclusive
Circulante ↔ Não Circulante ↔ PL. O mesmo vale dentro do Ativo. Só três coisas
quebram a identidade:

1. atravessar o lado (Ativo ↔ Passivo, ou BP ↔ DRE);
2. cair num `subtotal` (não tem bucket - o valor evapora);
3. cair num destino inexistente (chave órfã).

É por isso que essas três, e só essas três, são verificações **bloqueantes** de
código. Qual folha exatamente é julgamento revisável. Ver
`docs/02-invariante-contabil.md`.

## A identidade estendida (balancete não encerrado)

Num balancete cujo resultado ainda não foi transportado ao PL, a identidade que
vale é:

```
Ativo = Passivo + PL + (Receitas − Despesas)
```

O sistema testa as duas. Se a estendida fecha e a simples não, a diferença
**não é erro**: é o resultado do período, e o valor exato do transporte já é
conhecido.

## Lado AP

| row | destino | tipo | fórmula |
|---:|---|:---:|---|
| 5 | `Caixa` | conta | `agg(Ativo\|Circulante)` |
| 6 | `Aplicações Financeiras` | conta | `agg(Ativo\|Circulante)` |
| 7 | `Disponibilidades` | subtotal | `6 +5` |
| 8 | `Clientes` | conta | `agg(Ativo\|Circulante)` |
| 9 | `Clientes - Grupo` | conta | `agg(Ativo\|Circulante)` |
| 10 | `-PDD` | conta | `agg(Ativo\|Circulante)` |
| 11 | `Clientes Líquido` | subtotal | `8 +9 −10` |
| 12 | `Matéria-Prima` | conta | `agg(Ativo\|Circulante)` |
| 13 | `Produtos em Elaboração` | conta | `agg(Ativo\|Circulante)` |
| 14 | `Produtos Acabados` | conta | `agg(Ativo\|Circulante)` |
| 15 | `Estoques` | subtotal | `12 +13 +14` |
| 16 | `Ajustes derivativos / cambio (AC)` | conta | `agg(Ativo\|Circulante)` |
| 17 | `Adiantamento a Fornecedores` | conta | `agg(Ativo\|Circulante)` |
| 18 | `Mútuo Financeiro` | conta | `agg(Ativo\|Circulante)` |
| 19 | `Impostos a Recuperar` | conta | `agg(Ativo\|Circulante)` |
| 20 | `Outros Operacionais (AC)` | conta | `agg(Ativo\|Circulante)` |
| 21 | `Outros Não Operacionais (AC)` | conta | `agg(Ativo\|Circulante)` |
| 22 | `TOTAL ATIVO CIRCULANTE` | subtotal | `7 +11 +15 +16 +17 +18 +19 +20 +21` |
| 23 | `Ajustes derivativos / cambio (ANC)` | conta | `agg(Ativo\|Não Circulante)` |
| 24 | `Impostos Diferidos` | conta | `agg(Ativo\|Não Circulante)` |
| 25 | `Impostos a recuperar/Crédito tributário` | conta | `agg(Ativo\|Não Circulante)` |
| 26 | `Mútuo Financeiro LP` | conta | `agg(Ativo\|Não Circulante)` |
| 27 | `Aplicações Financeiras de LP` | conta | `agg(Ativo\|Não Circulante)` |
| 28 | `Outros Operacionais (ANC)` | conta | `agg(Ativo\|Não Circulante)` |
| 29 | `Outros Não Operacionais LP (ANC)` | conta | `agg(Ativo\|Não Circulante)` |
| 30 | `TOTAL ATIVO REALIZÁVEL LP` | subtotal | `23 +24 +25 +26 +27 +28 +29` |
| 31 | `Direito de Uso` | conta | `agg(Ativo\|Não Circulante)` |
| 32 | `- Depreciação acumulada (Direito de uso)` | conta | `agg(Ativo\|Não Circulante)` |
| 33 | `Direito de Uso Líquido` | subtotal | `31 −32` |
| 34 | `Terreno` | conta | `agg(Ativo\|Não Circulante)` |
| 35 | `Edificios, maquinas e outros` | conta | `agg(Ativo\|Não Circulante)` |
| 36 | `-Depreciação Acumulada` | conta | `agg(Ativo\|Não Circulante)` |
| 37 | `Imobilizado líquido` | subtotal | `34 +35 −36` |
| 38 | `Investimentos` | conta | `agg(Ativo\|Não Circulante)` |
| 39 | `Outros Ativos Intangiveis / Goodwill` | conta | `agg(Ativo\|Não Circulante)` |
| 40 | `TOTAL ATIVO FIXO` | subtotal | `37 +38 +39 +33` |
| 41 | `TOTAL ATIVO` | subtotal | `40 +30 +22` |
| 44 | `PASSIVO` | subtotal | `0` (cabeçalho decorativo) |
| 45 | `Bancos` | conta | `agg(Passivo\|Circulante)` |
| 46 | `Outras Dividas Financeiras` | conta | `agg(Passivo\|Circulante)` |
| 47 | `Confirming` | conta | `agg(Passivo\|Circulante)` |
| 48 | `Dividas Fiscais de Curto Prazo` | conta | `agg(Passivo\|Circulante)` |
| 49 | `Ajustes derivativos / cambio (+)` | conta | `agg(Passivo\|Circulante)` |
| 50 | `Fornecedores` | conta | `agg(Passivo\|Circulante)` |
| 51 | `Fornecedores - Partes Relacionadas` | conta | `agg(Passivo\|Circulante)` |
| 52 | `Fornecedores Totais` | subtotal | `50 +51` |
| 53 | `Passivo de Arrendamento Circulante` | conta | `agg(Passivo\|Circulante)` |
| 54 | `Mútuo Financeiro` | conta | `agg(Passivo\|Circulante)` |
| 55 | `Salários` | conta | `agg(Passivo\|Circulante)` |
| 56 | `Impostos` | conta | `agg(Passivo\|Circulante)` |
| 57 | `Adiantamento de Clientes` | conta | `agg(Passivo\|Circulante)` |
| 58 | `Dividendos a Pagar` | conta | `agg(Passivo\|Circulante)` |
| 59 | `Outros Operacionais (PC)` | conta | `agg(Passivo\|Circulante)` |
| 60 | `Outros Não Operacionais (PC)` | conta | `agg(Passivo\|Circulante)` |
| 61 | `TOTAL PASSIVO CIRCULANTE` | subtotal | `52 +53 +54 +55 +56 +57 +58 +59 +60 +45 +46 +47 +48 +49` |
| 62 | `Bancos LP` | conta | `agg(Passivo\|Não Circulante)` |
| 63 | `Outras Dividas Financeiras LP` | conta | `agg(Passivo\|Não Circulante)` |
| 64 | `Dividas Fiscais LP` | conta | `agg(Passivo\|Não Circulante)` |
| 65 | `Ajustes derivativos / cambio (PNC)` | conta | `agg(Passivo\|Não Circulante)` |
| 66 | `Passivo de Arrendamento LP` | conta | `agg(Passivo\|Não Circulante)` |
| 67 | `Mútuo Financeiro LP` | conta | `agg(Passivo\|Não Circulante)` |
| 68 | `Provisões` | conta | `agg(Passivo\|Não Circulante)` |
| 69 | `Outros Operacionais (PNC)` | conta | `agg(Passivo\|Não Circulante)` |
| 70 | `Outros Não Operacionais (PNC)` | conta | `agg(Passivo\|Não Circulante)` |
| 71 | `TOTAL PASSIVO NÃO CIRCULANTE` | subtotal | `62 +63 +64 +65 +66 +67 +68 +69 +70` |
| 72 | `TOTAL PASSIVO` | subtotal | `71 +61` |
| 75 | `PARTICIPAÇÕES MINORITÁRIAS` | conta | `agg(Passivo\|PL)` |
| 76 | `Capital Social` | conta | `agg(Passivo\|PL)` |
| 77 | `Lucros Acumulados` | conta | `agg(Passivo\|PL)` |
| 78 | `Outras Reservas` | conta | `agg(Passivo\|PL)` |
| 79 | `PATRIMÔNIO LÍQUIDO` | subtotal | `76 +77 +78` |
| 80 | `RECURSOS PROPRIOS - Reportado com IFRS16` | subtotal | `75 +79` |

## Lado DRE

| row | destino | tipo | fórmula |
|---:|---|:---:|---|
| 5 | `Vendas Totais` | conta | `agg(DRE\|DRE)` |
| 6 | `-Impostos` | conta | `agg(DRE\|DRE)` |
| 7 | `Vendas Líquidas` | subtotal | `5 −6` |
| 8 | `-Custo de Produtos Vendidos` | conta | `agg(DRE\|DRE)` |
| 9 | `Resultado Bruto` | subtotal | `7 −8` |
| 10 | `- Despesas com Vendas` | conta | `agg(DRE\|DRE)` |
| 11 | `- Despesas Administrativas` | conta | `agg(DRE\|DRE)` |
| 12 | `Resultado da Exploração ` | subtotal | `9 −10 −11` |
| 13 | `+/-Outras Receitas/Despesas Operacionais` | conta | `agg(DRE\|DRE)` |
| 14 | `+/-Provisões Operacionais` | conta | `agg(DRE\|DRE)` |
| 15 | `Resultado Operacional (EBIT)` | subtotal | `12 +13 +14` |
| 16 | `- Depreciação e amortização (imob e intang)` | conta | `agg(DRE\|DRE)` |
| 17 | `- Depreciação/Amortização dos Arrendamentos Op.` | conta | `agg(DRE\|DRE)` |
| 18 | `EBITDA` | subtotal | `15 +16 +17 −14` |
| 19 | `- Despesas/Custo de Aluguel` | conta | `agg(DRE\|DRE)` |
| 20 | `EBITDA ex-IFRS16` | subtotal | `18 +19` |
| 21 | `-  Despesas Financeiras` | conta | `agg(DRE\|DRE)` |
| 22 | `+ Receitas Financeiras` | conta | `agg(DRE\|DRE)` |
| 23 | `+/- Resultado Financeiro` | subtotal | `−21 +22` |
| 24 | `+/- Variações Cambiais` | conta | `agg(DRE\|DRE)` |
| 25 | `+/- Equivalência Patrimonial` | conta | `agg(DRE\|DRE)` |
| 26 | `Lucro antes de Impostos e Extraordinários` | subtotal | `15 +23 +24 +25` |
| 27 | `Outros não recorrentes e/ou não operacionais` | conta | `agg(DRE\|DRE)` |
| 28 | `+/- Créditos Tributários` | conta | `agg(DRE\|DRE)` |
| 29 | `+/- Resultado de alienação do Imobilizado` | conta | `agg(DRE\|DRE)` |
| 30 | `- Juros de Arrendamento Operacional` | conta | `agg(DRE\|DRE)` |
| 31 | `+/- Resultado Extraordinário` | subtotal | `27 +28 +29 −30` |
| 32 | `Lucro antes de Impostos ` | subtotal | `26 +31` |
| 33 | `- Impostos Pagos` | conta | `agg(DRE\|DRE)` |
| 34 | `+/- Impostos Diferidos` | conta | `agg(DRE\|DRE)` |
| 35 | `Lucro Liquido` | subtotal | `32 −33 +34` |
| 36 | `+/- Resultados Abrangentes` | conta | `agg(DRE\|DRE)` |
| 37 | `Lucro Líquido+Resultado Abrangente a Distribuir` | subtotal | `35 +36` |
| 39 | `- Dividendos` | conta | `agg(DRE\|DRE)` |
| 40 | `+/- Participações Minoritárias` | conta | `agg(DRE\|DRE)` |

