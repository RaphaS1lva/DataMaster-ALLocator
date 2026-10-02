# ALLocator AI

Planilhamento assistido de demonstrações financeiras para análise de crédito.

O ALLocator lê Balanço Patrimonial, DRE e balancetes de ERP, interpreta a estrutura contábil dos documentos, aloca cada conta em um plano padronizado de 79 posições e **garante por construção** a preservação da identidade contábil:

`Ativo = Passivo + PL`

> **A tese.** O fechamento do balanço não é apenas uma verificação realizada ao final do processamento. Ele é consequência de propriedades verificáveis durante o pipeline: o documento precisa ser validado estruturalmente e a alocação precisa conservar valor.
> Ver [docs/02-invariante-contabil.md](docs/02-invariante-contabil.md).

## Principais características

O sistema combina processamento determinístico, regras contábeis, memória de cliente e LLM apenas onde existe julgamento necessário.

Entre os principais mecanismos estão:

* validação estrutural de PDFs e balancetes;
* identificação das páginas que realmente contêm demonstrações financeiras;
* reconhecimento de colunas por coordenadas;
* interpretação de natureza débito/crédito;
* reconstrução de hierarquia contábil;
* validação aritmética da leitura;
* identificação automática de seções e subcategorias;
* dicionário de regras contábeis versionado;
* matching com proteção de polaridade;
* redução do espaço de candidatos antes do uso do LLM;
* guardrails para destino, lado do balanço, sinal e origem;
* conservação de valor;
* validação da identidade `Ativo = Passivo + PL`;
* bloqueio automático quando a leitura do documento não é confiável;
* posição residual para casos que exigem confirmação humana.

A arquitetura prioriza **determinismo e auditabilidade**. O LLM não é utilizado para interpretar informações que podem ser determinadas diretamente pelo documento ou pelas regras contábeis.

## Validação da leitura dos documentos

Documentos financeiros publicados apresentam desafios diferentes de balancetes estruturados. O ALLocator trata esses casos por meio de validações sucessivas antes de iniciar a etapa de alocação.

Entre os problemas tratados pelo pipeline estão:

| Situação                                   | Tratamento                                                              |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| Nota explicativa contendo termos contábeis | Rejeitada quando não apresenta evidências de fechamento de demonstração |
| Rodapés e elementos visuais da página      | Filtrados durante a leitura                                             |
| Cabeçalhos de múltiplas linhas             | Interpretados separadamente das linhas contábeis                        |
| Demonstrações sem código contábil          | Hierarquia reconstruída por relações aritméticas                        |
| Ausência de indentação                     | Estrutura inferida pela soma de blocos contíguos                        |
| Múltiplas colunas de períodos              | Colunas identificadas por coordenadas e cabeçalhos                      |
| Demonstração que não fecha                 | Processamento bloqueado                                                 |
| Dados inconsistentes                       | Bloqueio antes da exportação                                            |

A validação utiliza propriedades matemáticas do documento para distinguir uma demonstração financeira primária de conteúdos auxiliares, como notas explicativas, índices e pareceres.

Uma demonstração primária deve apresentar relações aritméticas verificáveis, como:

* `Total do Ativo`;
* `Total do Passivo`;
* `Total do Patrimônio Líquido`;
* `Lucro Líquido do Período`;
* somas entre linhas sintéticas e suas respectivas folhas.

Quando essas propriedades não são satisfeitas, o sistema **não exporta um resultado potencialmente incorreto**.

## Como funciona

```text
documento
   │
   ├─ 0. tipo real por magic bytes · conteúdo ativo em PDF        (0 tokens)
   │
   ├─ 1. gate de PÁGINA: âncoras + colunas alinhadas +
   │     SUBTOTAL ARITMÉTICO confirmado                            (0 tokens)
   │     └─ receita de bolo, contrato, DFC, DMPL → recusado aqui
   │
   ├─ 2. gate de DEMONSTRAÇÃO: a página FECHA um balanço?          (0 tokens)
   │     └─ nota explicativa, índice e parecer → recusados aqui
   │
   ├─ 3. leitura: colunas por coordenada x, natureza D/C,
   │     hierarquia por prefixo de código OU por ARITMÉTICA        (0 tokens)
   │
   ├─ 4. verificação de LEITURA: cada sintética contra a soma
   │     das suas folhas - zero divergência                        (0 tokens)
   │
   ├─ 5. o ANALISTA escolhe: qual demonstração, qual coluna
   │     em qual Ano. A ferramenta propõe e explica                (0 tokens)
   │
   ├─ 6. SEÇÕES: subcategoria a partir do nome das contas-pai      (0 tokens)
   │
   ├─ 7. memória do cliente → dicionário (1.260 regras)           (0 tokens)
   │     └─ match parcial vetado por POLARIDADE
   │
   ├─ 8. julgamento: somente o que sobrou, com candidatos
   │     restritos ao bloco compatível (4 a 15 de 79)              ← LLM
   │
   │     └─ se ainda sobrar, RESIDUAL do bloco, marcada
   │        como "confirme" e nunca gravada na memória             (0 tokens)
   │
   ├─ 9. guardrails: destino ∈ plano · lado preservado ·
   │     sinal compatível · origem existe no documento             (0 tokens)
   │
   └─ 10. conservação de valor + identidade                       (0 tokens)
```

## Suporte a diferentes fontes

O ALLocator possui caminhos específicos de leitura para diferentes formatos de dados, convergindo posteriormente para o mesmo motor contábil.

|                 | Balancete de ERP                  | Demonstração publicada (ITR/DFP)       |
| --------------- | --------------------------------- | -------------------------------------- |
| código contábil | sim, hierarquia por prefixo       | não - o servidor gera a estrutura      |
| hierarquia      | prefixo do código                 | **aritmética**: soma de bloco contíguo |
| indentação      | irrelevante                       | pode inexistir                         |
| natureza        | coluna D/C própria                | sinal presente no número               |
| subcategoria    | derivada do destino do dicionário | derivada do nome das contas-pai        |
| nome da conta   | limpo                             | pode conter cabeçalhos de seção        |
| ruído           | baixo                             | notas, pareceres e índices             |
| escala          | unidades                          | milhares, conforme cabeçalho           |

O sistema utiliza as informações disponíveis na própria fonte para reconstruir a estrutura contábil quando determinados metadados não são publicados.

## Alocação e uso do LLM

O modelo é utilizado somente na etapa em que existe efetivamente uma decisão de classificação.

Antes de chegar ao LLM, o sistema já determina:

1. o tipo de documento;
2. a demonstração relevante;
3. os períodos;
4. as colunas de valores;
5. a hierarquia;
6. a seção contábil;
7. as regras conhecidas pelo dicionário;
8. o lado do balanço;
9. os candidatos possíveis.

Com isso, o modelo não escolhe livremente entre as 79 posições do plano de contas.

Ele recebe apenas os candidatos compatíveis com o contexto identificado pelo pipeline, normalmente entre **4 e 15 possibilidades**.

A decisão é então submetida aos guardrails antes de ser aceita.

### Guardrails

Entre as validações realizadas estão:

* destino precisa existir no plano de contas;
* lado do balanço precisa ser preservado;
* sinal precisa ser compatível;
* origem precisa existir no documento;
* contas de despesa não podem ser classificadas em posições de receita;
* parcelas não podem ser classificadas como linhas líquidas incompatíveis;
* valores precisam ser conservados;
* resultados inconsistentes são bloqueados ou enviados para confirmação.

## Identidade contábil

A propriedade central do sistema é a conservação da identidade:

```text
Ativo = Passivo + Patrimônio Líquido
```

A alocação é estruturada de forma que os candidatos de uma conta sejam restritos ao lado compatível do balanço.

Dessa forma, uma escolha dentro de um bloco válido não pode transferir valor de Ativo para Passivo ou PL, preservando a identidade estrutural do balanço.

Além disso, o sistema possui verificações independentes de:

* conservação de valor;
* fechamento do documento;
* fechamento das estruturas sintéticas;
* compatibilidade de sinal;
* validade dos destinos;
* origem dos valores;
* fechamento final do balanço.

A prova formal dessa propriedade está documentada em [docs/02-invariante-contabil.md](docs/02-invariante-contabil.md).

## Resultados de validação

O projeto possui dois conjuntos principais de validação:

### Balancete de ERP

O golden dataset de balancete representa uma fonte estruturada com código contábil e hierarquia por prefixo.

Resultado esperado:

```text
Ativo = Passivo + PL
Resíduo = 0,00
```

### Demonstração publicada

O segundo golden dataset utiliza o ITR 2T26 da Fleury.

Durante a validação, o pipeline identificou e filtrou conteúdo não pertencente à demonstração principal, reconstruindo a estrutura financeira a partir das relações aritméticas publicadas.

Resultado:

```text
1.222 linhas lidas
        ↓
66 linhas contábeis válidas

Ativo = 13.558.475
Passivo + PL = 13.558.475

Resíduo = 0,00
```

A leitura foi validada por **25 assertivas** de consistência.

## Estrutura do projeto

```text
knowledge/
  base de conhecimento em texto versionado
  plano-de-contas.md
  regras-de-sinal.md
  formulas-shadow.md
  dicionario.csv
  auditoria-dicionario.md

portal/
  React + Vite → GitHub Pages

  src/core/
    PIPELINE CONTÁBIL - puro, sem DOM, sem rede
    demonstracoes.js = seleção e mapeamento coluna → Ano
    secoes.js        = subcategoria a partir da cadeia de pais

server/
  FastAPI - leitura, LLM, dados

  app/reading/
    leitura determinística de PDF e balancete
    demonstracao.py = gate de demonstração + árvore por soma
    periodos.py     = cabeçalho empilhado + proposta de mapeamento

  app/llm/
    Ollama + nuvem + guardrails

  app/db/
    Neon + memória versionada

  eval/
    harness com limiares + golden datasets

scripts/
  geradores, setup do notebook e diagnóstico de leitura
  dump_leitura.py
  verificar_jsx.mjs

docs/
  arquitetura, invariante, runbooks
```

## Como executar

### Portal

O portal pode ser executado independentemente do servidor para utilizar as funcionalidades que não dependem de processamento de documentos no backend.

```powershell
cd portal
npm ci
npm run dev          # http://localhost:5173
npm test             # 123 testes do núcleo contábil
```

Se o npm registry estiver bloqueado:

```powershell
node --test "test/*.test.mjs"
node scripts/verificar_jsx.mjs portal/src
```

O primeiro executa os testes ESM do núcleo e o segundo verifica a sintaxe dos componentes.

### Servidor

O servidor utiliza FastAPI e pode ser executado localmente com Python.

```powershell
cd server
python -m venv .venv
.\.venv\Scripts\Activate.ps1

pip install -r requirements.txt

uvicorn app.main:app --port 8123
python run_tests.py
```

Para utilizar os modelos locais, o ambiente também precisa do Ollama configurado.

O guia completo está disponível em [docs/09-runbook-notebook.md](docs/09-runbook-notebook.md).

O `run_tests.py` funciona com ou sem `pytest`, utilizando um shim compatível quando a biblioteca não está disponível.

## Regenerar os artefatos de conhecimento

```powershell
python scripts/gen_knowledge.py
python scripts/gen_knowledge.py --check
```

O gerador valida a consistência da base de conhecimento e interrompe o build caso:

* alguma das posições esperadas de Ativo/Passivo não esteja presente corretamente;
* uma regra do dicionário aponte para um destino inexistente;
* existam inconsistências nas fórmulas.

A cobertura das fórmulas é validada em build time.

## Verificação

| O que                          | Como                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------- |
| cobertura das fórmulas         | `python scripts/gen_knowledge.py --check`                                     |
| núcleo contábil                | `cd portal && npm test` - 123 testes                                          |
| servidor                       | `python server/run_tests.py` - 295 testes                                     |
| avaliação agregada             | `python server/eval/run_eval.py` - 26 métricas                                |
| sintaxe dos `.jsx`             | `node scripts/verificar_jsx.mjs portal/src` - 36 arquivos                     |
| golden nº 1                    | balancete de ERP - fechamento em `0,00`                                       |
| golden nº 2                    | ITR Fleury 2T26 - Ativo `13.558.475` = Passivo + PL                           |
| imunidade a erro de julgamento | 15 mapeamentos aleatórios com fechamento preservado                           |
| fechamento no pior palpite     | resíduo `0,00`                                                                |
| posição residual               | bloqueios convertidos em confirmação sem gravação na memória                  |
| contrato do prompt             | prefixos de código declarados e sem instruções de abstenção                   |
| red team                       | receita de bolo, PDF com JavaScript, prompt injection, DFC e nota explicativa |

## Documentação

| Documento                                                     | Assunto                                              |
| ------------------------------------------------------------- | ---------------------------------------------------- |
| [01-arquitetura.md](docs/01-arquitetura.md)                   | componentes, fronteiras de LLM e trade-offs          |
| [02-invariante-contabil.md](docs/02-invariante-contabil.md)   | **prova** de que o balanço fecha por construção      |
| [03-leitura-documento.md](docs/03-leitura-documento.md)       | colunas, natureza D/C e hierarquia                   |
| [04-camada-llm.md](docs/04-camada-llm.md)                     | Ollama, cascata, JSON Schema e redução de candidatos |
| [05-dados-persistencia.md](docs/05-dados-persistencia.md)     | Neon e memória versionada opt-in                     |
| [06-avaliacao.md](docs/06-avaliacao.md)                       | golden datasets, métricas e gate de CI               |
| [07-observabilidade.md](docs/07-observabilidade.md)           | tracing, latência e decisão de roteamento            |
| [08-seguranca-guardrails.md](docs/08-seguranca-guardrails.md) | camadas de proteção e matriz de ameaças              |
| [09-runbook-notebook.md](docs/09-runbook-notebook.md)         | instalação do Ollama e execução local                |
| [10-deploy-github-pages.md](docs/10-deploy-github-pages.md)   | publicação do portal no GitHub Pages                 |
| [11-roadmap.md](docs/11-roadmap.md)                           | escopo futuro e itens planejados                     |

Regras de negócio: [knowledge/](knowledge/) — plano de contas, regras de sinal e grafo de fórmulas em texto revisável, com auditoria do dicionário.

## Privacidade

Quando configurado para utilizar o Ollama localmente, o processamento do balanço do cliente pode permanecer integralmente na máquina local.

A arquitetura permite separar o processamento determinístico dos componentes que utilizam modelos de linguagem, possibilitando controlar quais dados são enviados para modelos externos conforme a configuração do ambiente.
