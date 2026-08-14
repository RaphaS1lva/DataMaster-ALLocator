# Regras de sinal

> **Fonte de verdade.** Implementado em `portal/src/core/sign.js`, com testes em
> `portal/test/balancete.test.mjs` (CAUSA 2 e CAUSA 2b).

Um valor percorre três formas. Confundi-las produz erro de 2× e, pior, erro
silencioso.

| Forma | Regra aplicada | Serve para |
|---|---|---|
| `valoresRaw` | nenhuma | auditoria: o que estava no documento |
| `valoresApresentacao` | §14.2 (natureza) | comparar com o documento, verificar leitura |
| `valoresPorSlot` | §14.2 + §14.1 (prefixo) | gravar no template, alimentar a Shadow |

---

## §14.2 - Natureza: a contribuição assinada ao bloco

O valor de apresentação é definido como **a contribuição assinada da conta ao seu
próprio bloco**:

| Bloco | Positivo significa | Natureza natural |
|---|---|---|
| Ativo | aumenta o Ativo | **débito** |
| Passivo / PL | aumenta Passivo + PL | **crédito** |
| DRE | aumenta o **lucro** | **crédito** |

```
apresentação = (natureza da linha == natureza natural do bloco) ? +|saldo| : −|saldo|
```

Consequência: **uma conta retificadora sai negativa automaticamente**, sem
precisar classificá-la como "despesa" ou "receita". Crédito dentro do Ativo é
negativo; débito dentro da DRE é negativo.

### Prioridade das fontes de sinal

1. **coluna D/C da linha** - autoritativa quando o documento a declara
2. **sinal do próprio valor** - parênteses, `-` à esquerda, `-` à direita
3. **natureza natural do bloco** - último recurso

### A natureza é da LINHA, nunca do grupo

Esta é a correção mais valiosa em relação à v1, que fazia `valor * sinalGrupo(grupo)`
com `-1` para todo Passivo/PL.

No `Balancete SPE (exemplo) 05.2026` (TOTVS Protheus, 224 contas analíticas),
**24 contas têm natureza contrária ao próprio grupo**:

| Onde | Exemplos | Total |
|---|---|---|
| Ativo com saldo **credor** | `( - ) PCLD`, `(-) AMORT.ACUM.SOFTWARES`, `(-) AMORT.ACUM.BENFEITORIAS PROP.TERC.` (+7) | R$ 13.267.131,49 |
| Passivo com saldo **devedor** | `( - ) JUROS DEBENTURES EMPRESA` (×2), `(-) PREJUIZOS ACUMULADOS` | R$ 62.309.475,74 |
| Grupo 3 (Despesas) com saldo credor | `RECUPERACAO DE DESPESAS`, `REVERSAO DE CONTINGENCIAS TRABALHISTAS`, `DESCONTOS OBTIDOS` (+4) | R$ 640.105,03 |
| Grupo 4 (Receitas) com saldo devedor | `PIS`, `COFINS`, `ISSQN`, `ABATIMENTOS CONCEDIDOS` | R$ 4.538.453,13 |

Ignorar a natureza inflava o **Ativo em R$ 26.534.262,98** e o **Passivo em
R$ 124.618.951,48**. E multiplicar o grupo por `-1` **não resolve**: o erro é
intra-grupo.

Note também que **os grupos de resultado não são homogêneos** - o grupo 3 contém
`39 OUTRAS RECEITAS` (credora) e o grupo 4 contém `43 DEDUÇÕES DA RECEITA BRUTA`
(devedora). Qualquer regra baseada no grupo erra nesses casos.

### Balancete com saldos absolutos

Relatórios de ERP (Protheus/TOTVS `CTBR040`, SAP) tipicamente traem **todos os
valores positivos**, com a natureza numa coluna de texto ao lado de cada coluna de
valor:

```
Conta | Descrição | Saldo Anterior | D/C* | Débito | Crédito | Mov Período | D/C** | Saldo Atual | D/C***
```

Cada coluna `D/C` pertence à coluna de valor **imediatamente à sua esquerda**.
Quando o valor é `0`, a coluna D/C vem vazia - tratar vazio como neutro, não como
erro.

Nesse caso, passe `saldosAbsolutos: true` ao pipeline. Sem a coluna D/C numa
linha, o sistema mantém o módulo e **emite aviso** em vez de arriscar uma inversão
silenciosa.

### `(-)` no nome é rótulo, não sinal

`(-) PREJUIZOS ACUMULADOS`, `( - ) PCLD`, `(-) AMORT.ACUM...` - o parêntese faz
parte do **nome da conta**. A informação de sinal está no D/C.

A heurística `pareceRetificadora()` existe apenas como **conferência cruzada**: se
o nome sugere retificadora mas o D/C diz o contrário, o sistema **confia no D/C** e
emite aviso de Classe B. Nunca o inverso.

---

## §14.1 - Prefixo do destino: o valor a gravar

O nome do destino no template carrega a direção que a fórmula vai aplicar:

| Prefixo | Classificação | Valor gravado | Fórmula do template |
|---|---|---|---|
| começa com `+/-` | `pm` | preserva o sinal | soma |
| começa com `-` | `neg` | `Math.abs()` | **subtrai** |
| começa com `+` | `pos` | `Math.abs()` | soma |
| sem prefixo | `none` | preserva o sinal | soma |

**Por que `neg` grava positivo:** a fórmula já tem o sinal. Gravar negativo faria
"menos com menos" e inverteria o resultado. Exemplo do guia original:

> OCR lê `Custo de Produtos Vendidos: 60.000`. Destino `-Custo de Produtos
> Vendidos`. Gravar **60.000 (positivo)**. A fórmula faz `Vendas Líquidas −
> 60.000`. Se gravarmos `-60.000`, a fórmula faria `− (−60.000) = +60.000`.

Verifiquei posição por posição em `formulas-shadow.md`: **todo destino com prefixo
`-` é subtraído do seu subtotal, e todo o resto é somado**. Então:

```
contribuição = (prefixo == '-') ? −gravado : +gravado
```

### As 14 contas `neg`

*Ativo redutor (3):* `-PDD` (10), `-Depreciação Acumulada` (36),
`- Depreciação acumulada (Direito de uso)` (32)

*DRE (11):* `-Impostos` (6), `-Custo de Produtos Vendidos` (8),
`- Despesas com Vendas` (10), `- Despesas Administrativas` (11),
`- Depreciação e amortização (imob e intang)` (16),
`- Depreciação/Amortização dos Arrendamentos Op.` (17),
`- Despesas/Custo de Aluguel` (19), `-  Despesas Financeiras` (21),
`- Juros de Arrendamento Operacional` (30), `- Impostos Pagos` (33),
`- Dividendos` (39)

`pos` (1): `+ Receitas Financeiras` (22)

`pm` (10): `+/-Outras Receitas/Despesas Operacionais`, `+/-Provisões Operacionais`,
`+/- Variações Cambiais`, `+/- Equivalência Patrimonial`,
`Outros não recorrentes e/ou não operacionais`, `+/- Créditos Tributários`,
`+/- Resultado de alienação do Imobilizado`, `+/- Impostos Diferidos`,
`+/- Resultados Abrangentes`, `+/- Participações Minoritárias`

> Cuidado: `Ajustes derivativos / cambio (+)` (linha 49) **não** é `pos` - o `(+)`
> está no meio do nome, não no início. Classificação: `none`.

---

## Compatibilidade de sinal - regra bloqueante

Como `neg` e `pos` gravam `Math.abs()`, **o sinal da apresentação é destruído na
gravação**. Isso só é seguro se o sinal já concordava com a direção do destino.

```
destino `neg` (subtraído)  ->  apresentação deve ser <= 0
destino `pos` (somado)     ->  apresentação deve ser >= 0
destino `none` / `pm`      ->  qualquer sinal (é preservado)
```

Exemplos reais:

| Conta | Apresentação | Destino | Veredito |
|---|---|---|---|
| `(-) AMORT.ACUM.SOFTWARES` | −2.028.812,59 | `-Depreciação Acumulada` (neg) | **OK** - grava módulo, fórmula subtrai, contribui −2,02 MM |
| `RECUPERACAO DE DESPESAS` | +109.077,90 | `- Despesas Administrativas` (neg) | **ERRO** - é crédito no grupo de despesas, ou seja AUMENTA o lucro; o módulo faria a fórmula subtrair. Use um `+/-`. |
| `PIS` (dedução de receita) | −541.621,04 | `-Impostos` (neg) | **OK** - contribui −541.621,04 ao lucro |
| `CLIENTES NACIONAIS` | +5.310.870,89 | `-PDD` (neg) | **ERRO** - inverteria em 2× o valor |

Isto é **Classe A (bloqueante)**, porque fura o fechamento.

> A v1 tinha uma checagem parecida, mas rodava sobre o valor **já gravado** - que
> é sempre `>= 0` depois do `Math.abs()`. Nunca disparava.

---

## §8.7 - O código contábil define o GRUPO

O 1º dígito prevalece sobre o nome:

| Dígito | Grupo | Papel |
|---|---|---|
| 1 | Ativo | - |
| 2 | Passivo / PL | - |
| 3 | DRE | despesa |
| 4 | DRE | receita |
| 5 | DRE | apuração |

O código decide o **grupo**, nunca a **natureza** - essa vem do D/C. Confundir as
duas foi o que levou a v1 a inverter as 24 retificadoras.

O grupo derivado do código também é o **lado autoritativo do balanço**
(`_ladoDeclarado`), guardado antes de qualquer camada de matching. Sem isso, o
dicionário sobrescreve `grupo` com o grupo do destino e a troca de lado se
"legitima" sozinha, ficando invisível - bug real observado na v1.

---

## Ordem de aplicação

```
saldo do documento
   │
   ├─ §14.2  natureza (D/C da linha > sinal do valor > natural do bloco)
   │         └─> valoresApresentacao   ← verificação de leitura usa ESTE
   │
   └─ §14.1  prefixo do destino (abs para neg/pos, preserva para none/pm)
             └─> valoresPorSlot        ← a Shadow agrega ESTE
```

§14.1 vem depois porque depende do destino já resolvido para a grafia canônica,
é ela que carrega o prefixo correto.

Linhas com `_sinalAplicado: true` (o transporte automático de resultado) **não
passam por nenhuma das duas**: já nascem com o valor final. Na v1 passavam, e o
`sinalGrupo('Passivo') = -1` negava o valor, aumentando a diferença em 2× o
resultado em vez de fechar o balanço.

---

## Sobre o `INTERPRETAÇÃO DE SINAL DRE.xlsx` da v1

Aquela planilha classificava cada linha da DRE em "Contribui para lucro" /
"Contribui para prejuízo" e trazia uma tabela de quando inverter o sinal. Ela
**não é consumida por nenhum código** - nem na v1, nem aqui.

A convenção "apresentação = contribuição assinada ao bloco" torna essa tabela
desnecessária: o D/C da linha já responde à pergunta que ela tentava responder por
semântica. O único resíduo legítimo é o caso de um destino `pm` cuja direção
dependa de interpretação; nesses, o sistema **pergunta** em vez de adivinhar.
