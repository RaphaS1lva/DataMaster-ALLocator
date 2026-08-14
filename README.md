# ALLocator v2

Planilhamento assistido de demonstrações financeiras para análise de crédito.
Lê Balanço Patrimonial, DRE e balancete de ERP, aloca cada conta num plano
padronizado de 79 posições e **garante por construção** que
`Ativo = Passivo + PL`.

> **A tese.** `Ativo = Passivo + PL` não é uma esperança verificada no fim: é
> consequência de duas propriedades verificáveis - o documento fecha consigo
> mesmo, e a alocação conserva valor. Ver
> [docs/02-invariante-contabil.md](docs/02-invariante-contabil.md).

## O que mudou em relação à v1

A v1 nunca fechava o balanço. Diagnostiquei três causas, todas de processamento,
nenhuma delas "o modelo de IA errou":

| Causa | Efeito medido |
|---|---|
| 229 das 1.285 regras do dicionário apontavam para destinos com grafia divergente, e a agregação usava chave não normalizada → valor descartado **sem erro no QA** | vazamento sistemático no Passivo (`Mútuo Financeiro L/P` ×97, `Bancos L/P` ×41) |
| natureza débito/crédito ignorada - 24 contas têm natureza contrária ao próprio grupo | Ativo inflado em **R$ 26.534.262,98**, Passivo em **R$ 124.618.951,48** |
| detecção de conta analítica pela regra errada (códigos de ERP não têm ponto separador) | balanço multiplicado por ~3 |

E o que parecia erro, no caso real, era um **balancete não encerrado**: a
diferença de R$ 689.138,41 é exatamente o resultado do período. O v2 detecta
isso, explica e oferece o transporte com um clique.

Nada disso vinha do julgamento do modelo. A fronteira entre "fato" (código) e
"julgamento" (LLM) estava no lugar errado.

## O que mudou depois do primeiro ITR real

A v2 foi validada contra um balancete de ERP - e esse é o caso **minoritário**.
No primeiro PDF auditado de companhia aberta (Fleury, ITR 2T26) o resultado foi
1.222 linhas lidas em vez de 115, 38 pseudo-períodos e um `Total do Ativo` de
**R$ 2,00**. Quatro causas, todas de leitura:

| Causa | Como se manifestou |
|---|---|
| **nota explicativa** passa no gate de página: tem âncora contábil, colunas alinhadas e subtotal que fecha | 33 das 50 páginas admitidas; `10ª Emissão 1ª Série` e `121 a dias` tratadas como contas |
| **mobília de página** lida como conta | o rodapé "12 de 46" virou uma conta `12de` de saldo 46 |
| **cabeçalho de 4 linhas empilhadas** na DRE: a data mora nas colunas de valor | `30` e `2026` de "30 de junho de 2026" entraram como saldo |
| demonstração publicada **não tem código nem indentação** (53 linhas no mesmo `x0`) | toda linha virou analítica e os totais foram somados junto com as parcelas |

O conserto não foi adivinhar melhor: foi **perguntar**. E o discriminador que
resolveu o essencial é aritmético - uma demonstração primária *se fecha*
(`Total do ativo`, `Lucro líquido do período`); uma nota *decompõe* uma linha e
não fecha nada. Das 30 páginas de nota, nenhuma tem âncora de fechamento.

O que a ferramenta fez de certo mesmo errando: **bloqueou**. Não exportou balanço
inflado - recusou com 30 verificações de Classe A e explicou cada uma.

## O que mudou na segunda passagem do mesmo ITR

Com a leitura já correta - 66 linhas, hierarquia aritmética fechando, verificação
de leitura passando com 25 assertivas - a identidade **ainda** furava em 23%:
R$ 3.314.468 não chegavam à Shadow porque 6 linhas ficavam marcadas para alocar
sem destino. Cinco causas, nenhuma delas "o modelo errou":

| Causa | Como se manifestou |
|---|---|
| **o círculo da subcategoria**: `candidatosPara(grupo, '')` devolve o grupo inteiro, e `subCategoria` só era preenchida pelo destino que o matching escolhia | as 6 linhas foram ao LLM como `bloco_provavel=Passivo/?` com **28** candidatos em vez de 4 |
| **viés de abstenção no prompt** (`"NA DÚVIDA, DEIXE EM BRANCO"`) | com 28 opções e sem subcategoria, o modelo se absteve em 6 de 11 - obedecendo |
| **cabeçalho de seção grudado** na primeira conta de cada seção | `Patrimônio líquido Capital social 24a.` dá Jaccard 0,40 contra `Capital social`, que o dicionário conhece desde sempre |
| **parcela casando com linha líquida** | `Despesas financeiras` → `+ Receitas Financeiras`, selo `Dicionário`, confiança 0,9. Uma despesa numa posição de receita |
| **dígito de código não declarado** ao modelo | o prompt manda confiar no 1º dígito e define 1-4; a DRE publicada gera `5`. O modelo respondeu "Código 5010105 indica Passivo, cadeia_pais aponta para DRE" |

A quarta é a mais grave e a única que nenhuma validação pegaria: só apareceu
porque o Fleury publica despesa com sinal negativo e o guardrail de sinal
disparou. Com despesa positiva, R$ 348.334 entrariam como receita sem sintoma.

E a primeira ensina o que fazer com a IA. **A informação nunca faltou** - estava
no nome das contas-pai, em texto claro (`Total do patrimônio líquido`). Depois de
derivá-la, o placar sem gastar um token:

```
                                    antes    depois
pendentes de julgamento                11         9
  resolvidas pelo dicionário           41        44
despesa em posição de receita           1         0
linha sem redução de candidatos         6         0
bloqueios de Classe A                  13         0
```

O fechamento não depende da qualidade do julgamento. Atribuindo a cada pendente o
**pior** candidato plausível do próprio bloco, `Ativo = Passivo + PL` fecha em
`0,00` - em `13.558.475`, que é o número do documento. É consequência de
`ladoDoBalanco`: candidatos restritos a um lado do balanço tornam qualquer escolha
conservativa. Por isso abster-se é a pior opção disponível: erra para Classe A
(bloqueia) onde decidir erraria no máximo para Classe B (revisável).

## Como funciona

```
documento
   │
   ├─ 0. tipo real por magic bytes · conteúdo ativo em PDF        (0 tokens)
   ├─ 1. gate de PÁGINA: âncoras + colunas alinhadas +
   │     SUBTOTAL ARITMÉTICO confirmado                            (0 tokens)
   │     └─ receita de bolo, contrato, DFC, DMPL → recusado aqui
   ├─ 2. gate de DEMONSTRAÇÃO: a página FECHA um balanço?          (0 tokens)
   │     └─ nota explicativa, índice e parecer → recusados aqui.
   │        Uma nota decompõe uma linha; ela não fecha nada.
   ├─ 3. leitura: colunas por coordenada x, natureza D/C,
   │     hierarquia por prefixo de código OU por ARITMÉTICA        (0 tokens)
   │     └─ demonstração publicada não tem código nem recuo:
   │        sintética é a soma exata de um bloco contíguo
   ├─ 4. verificação de LEITURA: cada sintética contra a soma
   │     das suas folhas - zero divergência                        (0 tokens)
   ├─ 5. o ANALISTA escolhe: qual demonstração, qual coluna
   │     em qual Ano. A ferramenta propõe e explica                (0 tokens)
   ├─ 6. SEÇÕES: subcategoria a partir do nome das contas-pai      (0 tokens)
   │     └─ sem ela `candidatosPara` devolve o grupo inteiro e a
   │        redução que viabiliza um modelo pequeno não acontece
   ├─ 7. memória do cliente → dicionário (1.260 regras)           (0 tokens)
   │     └─ match parcial vetado por POLARIDADE: despesa não casa
   │        com receita, parcela não casa com linha líquida
   ├─ 8. julgamental: só o que sobrou, com candidatos já
   │     restritos ao bloco compatível (4 a 15 de 79)              ← LLM
   │     └─ dentro do bloco ele DECIDE: abster-se bloquearia, e
   │        qualquer opção do bloco preserva a identidade
   │     └─ se ainda sobrar, a RESIDUAL do bloco, marcada         (0 tokens)
   │        como "confirme" - nunca gravada na memória
   ├─ 8. guardrails: destino ∈ plano · lado preservado ·
   │     sinal compatível · origem existe no documento             (0 tokens)
   └─ 9. conservação de valor + identidade                         (0 tokens)
```

Dois formatos entram por caminhos diferentes e chegam ao mesmo motor:

| | Balancete de ERP | Demonstração publicada (ITR/DFP) |
|---|---|---|
| código contábil | sim, hierarquia por prefixo | **não** - o servidor gera a partir da árvore |
| hierarquia | prefixo do código | **aritmética**: soma de bloco contíguo |
| indentação | irrelevante | **inexistente** (53 linhas no mesmo `x0`) |
| natureza | coluna D/C própria | o sinal já vem no número |
| subcategoria | do destino do dicionário | **do nome das contas-pai** - o documento não a declara |
| nome da conta | limpo | cabeçalho de seção e nota **grudados** no rótulo |
| ruído | nenhum | 47 páginas de nota, parecer e índice |
| escala | unidades | **milhares** - declarado no cabeçalho |

O modelo vê apenas os nomes de conta que o dicionário não conhece. Consumo por
documento: **~500 tokens**, contra ~6.000 na v1.

## Estrutura

```
knowledge/     base de conhecimento em texto versionado (era Excel)
               plano-de-contas.md · regras-de-sinal.md ·
               formulas-shadow.md · dicionario.csv · auditoria-dicionario.md
portal/        React + Vite → GitHub Pages
  src/core/    PIPELINE CONTÁBIL - puro, sem DOM, sem rede
               demonstracoes.js = seleção e mapeamento coluna → Ano
               secoes.js       = subcategoria a partir da cadeia de pais
server/        FastAPI - leitura, LLM, dados
  app/reading/ leitura determinística de PDF e balancete
               demonstracao.py = gate de demonstração + árvore por soma
               periodos.py     = cabeçalho empilhado + proposta de mapeamento
  app/llm/      Ollama + nuvem + guardrails
  app/db/       Neon + memória versionada
  eval/         harness com limiares + os dois golden datasets
scripts/       geradores, setup do notebook e diagnóstico de leitura
               dump_leitura.py    = despeja a leitura real de um PDF
               verificar_jsx.mjs  = sintaxe dos componentes sem npm
docs/          arquitetura, invariante, runbooks
```

## Rodar

### Portal (só ele já é útil - o pipeline funciona sem servidor)

```powershell
cd portal
npm ci
npm run dev          # http://localhost:5173
npm test             # 123 testes do núcleo contábil
```

Se o npm registry estiver bloqueado, `npm test` e `npm run build` não rodam - mas
`node --test "test/*.test.mjs"` roda (é ESM puro, sem dependência) e
`node scripts/verificar_jsx.mjs portal/src` cobre a sintaxe dos componentes, que
é o que `node --test` não alcança.

### Servidor

Precisa das dependências Python e, para a IA, do Ollama. O guia completo está em
[docs/09-runbook-notebook.md](docs/09-runbook-notebook.md).

```powershell
cd server
python -m venv .venv; .\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --port 8123
python run_tests.py             # 295 testes
```

`run_tests.py` funciona **com ou sem pytest** - ele injeta um shim da API do
pytest quando a lib não está disponível. Existe porque a máquina de
desenvolvimento está atrás de um proxy que bloqueia o PyPI, e os testes de
lógica (guardrails, conservação, leitura) são justamente os que não podem deixar
de rodar.

### Regenerar os artefatos de build a partir de `knowledge/`

```powershell
python scripts/gen_knowledge.py          # valida e gera
python scripts/gen_knowledge.py --check  # só valida (usado no CI)
```

O gerador **falha o build** se alguma das 56 posições de Ativo/Passivo não entrar
em exatamente um total, ou se alguma regra do dicionário apontar para um destino
inexistente. A cobertura das fórmulas é provada em build time.

## Verificação

| O que | Como |
|---|---|
| cobertura das fórmulas | `python scripts/gen_knowledge.py --check` |
| núcleo contábil | `cd portal && npm test` - 123 testes |
| servidor | `python server/run_tests.py` - 295 testes |
| tudo agregado, com limiares | `python server/eval/run_eval.py` - 26 métricas |
| sintaxe dos `.jsx` sem npm | `node scripts/verificar_jsx.mjs portal/src` - 36 arquivos |
| golden nº 1: balancete de ERP | balancete SPE (exemplo) fecha em `0,00` |
| golden nº 2: demonstração publicada | ITR Fleury 2T26 - 1.222 linhas viram 66, Ativo `13.558.475` = Passivo+PL |
| imunidade a erro de julgamento | 15 mapeamentos aleatórios, fechamento idêntico |
| **fechamento no pior palpite** | cada pendente recebe o último candidato do bloco → resíduo `0,00`, 0 bloqueios |
| **posição residual** | zera os bloqueios, avisa em Classe B nominal e **não** entra na memória do cliente |
| contrato do prompt | todo prefixo de código gerado é declarado; zero instruções que induzem abstenção |
| red team | receita de bolo, PDF com JavaScript, injeção de prompt, DFC, **nota explicativa** |

## Documentação

| Documento | Assunto |
|---|---|
| [01-arquitetura.md](docs/01-arquitetura.md) | componentes, fronteiras de LLM, trade-offs |
| [02-invariante-contabil.md](docs/02-invariante-contabil.md) | **a prova** de que o balanço fecha por construção |
| [03-leitura-documento.md](docs/03-leitura-documento.md) | colunas por coordenada, natureza D/C, hierarquia |
| [04-camada-llm.md](docs/04-camada-llm.md) | Ollama, cascata, JSON Schema, redução de candidatos |
| [05-dados-persistencia.md](docs/05-dados-persistencia.md) | Neon, memória versionada opt-in |
| [06-avaliacao.md](docs/06-avaliacao.md) | golden datasets, métricas, gate de CI |
| [07-observabilidade.md](docs/07-observabilidade.md) | tracing, latência, decisão de roteamento |
| [08-seguranca-guardrails.md](docs/08-seguranca-guardrails.md) | as seis camadas, matriz de ameaças |
| [09-runbook-notebook.md](docs/09-runbook-notebook.md) | instalar Ollama e subir o servidor local |
| [10-deploy-github-pages.md](docs/10-deploy-github-pages.md) | publicar e migrar da v1 |
| [11-roadmap.md](docs/11-roadmap.md) | o que ficou de fora e por quê |

Regras de negócio: [knowledge/](knowledge/) - plano de contas, regras de sinal e
grafo de fórmulas em texto revisável, com auditoria do dicionário.

## Privacidade

Com o Ollama local, **o balanço do cliente não sai da máquina**. Na v1 ele
trafegava por quatro provedores em tier gratuito, onde os termos permitem uso dos
dados para treinamento. Para análise de crédito, isso não é detalhe.
