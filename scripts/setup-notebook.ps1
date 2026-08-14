<#
.SYNOPSIS
    Prepara o notebook servidor para rodar o plano de INFERENCIA do ALLocator v2.

.DESCRIPTION
    Automatiza os passos 2 a 6 de docs/09-runbook-notebook.md:

      1. verifica o Ollama (nao instala: da o link, porque instalador grafico
         nao deve ser disparado sem o usuario ver);
      2. define as variaveis de ambiente do Ollama com `setx` (persistentes);
      3. baixa os modelos da escada, PULANDO os que ja estao presentes;
      4. cria o venv e instala server/requirements.txt;
      5. cria server/.env a partir do .env.example (nunca sobrescreve);
      6. roda a suite de testes e imprime o que ficou pronto e o que falta.

    IDEMPOTENTE: pode ser reexecutado quantas vezes for preciso. Nada do usuario
    e apagado ou sobrescrito sem pergunta explicita.

    Hardware alvo: RTX 4050 Laptop, 6.141 MB de VRAM. A escada de modelos foi
    dimensionada para esse orcamento (ver server/app/llm/router.py).

.PARAMETER SemModelos
    Pula os `ollama pull`. Util para reexecutar o script depois de os ~19 GB de
    modelo ja terem sido baixados.

.PARAMETER Porta
    Porta em que a API sera servida. Usada apenas nas instrucoes finais.
    Padrao: 8123.

.EXAMPLE
    .\scripts\setup-notebook.ps1
    Execucao completa (primeira vez).

.EXAMPLE
    .\scripts\setup-notebook.ps1 -SemModelos
    Reexecucao rapida, sem mexer nos modelos.
#>

[CmdletBinding()]
param(
    [switch] $SemModelos,
    [int]    $Porta = 8123
)

$ErrorActionPreference = 'Stop'

# No PowerShell 7.4+ esta preferencia vem $true e faz comando NATIVO com exit
# code != 0 virar erro TERMINANTE. Aqui isso e indesejado: nos verificamos
# $LASTEXITCODE a mao para relatar a falha e continuar com os demais passos
# (um `ollama pull` que caiu nao deve abortar a instalacao das dependencias, e
# `run_tests.py` sai 1 quando um teste falha, o que queremos reportar no
# resumo). No PowerShell 5.1 a variavel nao existe e a atribuicao e inocua.
$PSNativeCommandUseErrorActionPreference = $false

# ---------------------------------------------------------------------------
# Mensagens
# ---------------------------------------------------------------------------

function Titulo {
    param([string] $Texto)
    Write-Host ''
    Write-Host ('=' * 74) -ForegroundColor DarkGray
    Write-Host "  $Texto" -ForegroundColor Cyan
    Write-Host ('=' * 74) -ForegroundColor DarkGray
}

function Ok      { param([string] $Texto) Write-Host "  [ok]     $Texto" -ForegroundColor Green }
function Aviso   { param([string] $Texto) Write-Host "  [aviso]  $Texto" -ForegroundColor Yellow }
function Erro    { param([string] $Texto) Write-Host "  [erro]   $Texto" -ForegroundColor Red }
function Info    { param([string] $Texto) Write-Host "  [info]   $Texto" -ForegroundColor Gray }
function Pulado  { param([string] $Texto) Write-Host "  [pulado] $Texto" -ForegroundColor DarkGray }
function Passo   { param([string] $Texto) Write-Host "  ->       $Texto" -ForegroundColor White }

# Acumuladores do resumo final. Preferimos relatar tudo no fim a interromper o
# script no primeiro tropeco: quem esta configurando a maquina quer saber a
# lista inteira de pendencias de uma vez, nao uma por execucao.
$script:Prontos    = New-Object System.Collections.Generic.List[string]
$script:Pendencias = New-Object System.Collections.Generic.List[string]
$script:Falhas     = New-Object System.Collections.Generic.List[string]

function RegistrarPronto    { param([string] $T) $script:Prontos.Add($T)    | Out-Null }
function RegistrarPendencia { param([string] $T) $script:Pendencias.Add($T) | Out-Null }
function RegistrarFalha     { param([string] $T) $script:Falhas.Add($T)     | Out-Null }

function TemComando {
    param([string] $Nome)
    $null -ne (Get-Command $Nome -ErrorAction SilentlyContinue)
}

function Confirmar {
    <#
      Pergunta sim/nao. Usado SEMPRE antes de qualquer acao destrutiva.
      Sem -Force implicito e sem default perigoso: a resposta vazia e "nao".
    #>
    param([string] $Pergunta)
    $resposta = Read-Host "  [?]      $Pergunta [s/N]"
    return $resposta -match '^[sSyY]'
}

# ---------------------------------------------------------------------------
# Caminhos. O script vive em <raiz>/scripts, entao a raiz e o diretorio pai.
# Resolvido a partir de $PSScriptRoot para funcionar chamado de qualquer lugar.
# ---------------------------------------------------------------------------

$Raiz           = Split-Path -Parent $PSScriptRoot
$DirServer      = Join-Path $Raiz 'server'
$Requirements   = Join-Path $DirServer 'requirements.txt'
$RunTests       = Join-Path $DirServer 'run_tests.py'
$EnvExemplo     = Join-Path $DirServer '.env.example'
$EnvDestino     = Join-Path $DirServer '.env'
$DirVenv        = Join-Path $Raiz '.venv'
$PythonVenv     = Join-Path $DirVenv 'Scripts\python.exe'

# ---------------------------------------------------------------------------
# Escada de modelos. Espelha MODELOS em server/app/llm/router.py.
# Se mudar la, mude aqui: `router.status()` compara o nome byte a byte contra o
# que /api/tags devolve, e uma tag diferente aparece como "nao instalado" no
# /health mesmo estando no disco.
# ---------------------------------------------------------------------------

$Modelos = @(
    @{ Nome = 'qwen2.5:7b-instruct-q4_K_M'; Papel = 'julgamento primario'; Tamanho = '4,7 GB'; Cabe = 'sim' }
    @{ Nome = 'qwen2.5:3b-instruct-q4_K_M'; Papel = 'julgamento rapido';   Tamanho = '~2 GB';  Cabe = 'sim' }
    @{ Nome = 'qwen2.5vl:3b';               Papel = 'visao primaria';      Tamanho = '~3,2 GB'; Cabe = 'sim' }
    @{ Nome = 'qwen2.5vl:7b';               Papel = 'visao qualidade';     Tamanho = '6,0 GB'; Cabe = 'offload parcial p/ CPU' }
    @{ Nome = 'granite3.3-vision:2b';       Papel = 'visao reserva';       Tamanho = '~2,4 GB'; Cabe = 'sim' }
    @{ Nome = 'nomic-embed-text';           Papel = 'embeddings';          Tamanho = '274 MB'; Cabe = 'sim' }
)

# Variaveis de ambiente do Ollama. O "Porque" e impresso na tela: quem executa o
# script deve entender o que esta sendo gravado no registro do seu usuario.
$VariaveisOllama = @(
    @{ Nome = 'OLLAMA_HOST';             Valor = '0.0.0.0'; Porque = 'permite que a API alcance o Ollama; protecao vem do firewall + tunnel' }
    @{ Nome = 'OLLAMA_KEEP_ALIVE';       Valor = '30m';     Porque = 'sem isto o modelo sai da VRAM em 5 min e a proxima chamada paga ~20s' }
    @{ Nome = 'OLLAMA_NUM_PARALLEL';     Valor = '1';       Porque = 'em 6 GB, 2 requisicoes paralelas competem pela VRAM e as duas ficam lentas' }
    @{ Nome = 'OLLAMA_FLASH_ATTENTION';  Valor = '1';       Porque = 'reduz o footprint do KV cache, que e o recurso escasso em 6 GB' }
    @{ Nome = 'OLLAMA_MAX_LOADED_MODELS'; Valor = '1';      Porque = 'impede 2 modelos residentes (4,7 + 3,2 GB nao cabem em 6,1)' }
)

$URL_OLLAMA  = 'http://127.0.0.1:11434'
$LINK_OLLAMA = 'https://ollama.com/download/OllamaSetup.exe'

# ---------------------------------------------------------------------------

Write-Host ''
Write-Host '  ALLocator v2 - preparacao do notebook servidor (plano de inferencia)' -ForegroundColor Cyan
Write-Host '  --------------------------------------------------------------------' -ForegroundColor DarkGray
Info "raiz do projeto: $Raiz"
Info "porta da API:    $Porta"
if ($SemModelos) { Info 'modo -SemModelos: os `ollama pull` serao pulados' }

if (-not (Test-Path $DirServer)) {
    Erro "nao encontrei a pasta 'server' em $Raiz"
    Erro 'este script deve estar em <raiz-do-projeto>/scripts/setup-notebook.ps1'
    exit 1
}

# ===========================================================================
# 1. Ollama instalado?
# ===========================================================================
Titulo '1/6  Ollama'

$temOllama = TemComando 'ollama'

if (-not $temOllama) {
    # Fallback: o instalador altera o PATH, mas a sessao aberta nao ve a mudanca.
    # Antes de declarar ausente, procuramos no caminho padrao de instalacao.
    $exeProvavel = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
    if (Test-Path $exeProvavel) {
        Aviso 'ollama.exe existe, mas nao esta no PATH desta sessao'
        Passo 'feche e reabra o PowerShell, depois rode este script de novo'
        $env:Path = "$env:Path;$(Split-Path -Parent $exeProvavel)"
        $temOllama = TemComando 'ollama'
        if ($temOllama) { Ok 'PATH ajustado para esta sessao' }
    }
}

if (-not $temOllama) {
    Erro 'Ollama nao encontrado.'
    Write-Host ''
    Write-Host '  Baixe e execute o instalador do Windows:' -ForegroundColor Yellow
    Write-Host "      $LINK_OLLAMA" -ForegroundColor White
    Write-Host ''
    Write-Host '  Depois FECHE E REABRA o PowerShell (o instalador altera o PATH)' -ForegroundColor Yellow
    Write-Host '  e rode este script novamente.' -ForegroundColor Yellow
    Write-Host ''
    RegistrarFalha 'Ollama nao instalado - instale por OllamaSetup.exe e reexecute'
    RegistrarPendencia "instalar o Ollama: $LINK_OLLAMA"
    # Segue em frente: venv, deps e testes NAO dependem do Ollama e vale
    # adiantar o que der. O resumo final cobra a pendencia.
} else {
    $versao = (& ollama --version 2>&1 | Out-String).Trim()
    Ok "Ollama presente - $versao"
    RegistrarPronto "Ollama instalado ($versao)"
}

# Daemon respondendo? /api/tags e a mesma sonda que ClienteOllama.esta_disponivel usa.
$daemonOk = $false
if ($temOllama) {
    try {
        $tags = Invoke-RestMethod -Uri "$URL_OLLAMA/api/tags" -TimeoutSec 5
        $daemonOk = $true
        $qtd = @($tags.models).Count
        Ok "daemon respondendo em $URL_OLLAMA ($qtd modelo(s) no disco)"
    } catch {
        Aviso "daemon nao respondeu em $URL_OLLAMA"
        Passo 'abra o Ollama pelo menu Iniciar (ele fica na bandeja do sistema)'
        RegistrarPendencia 'subir o daemon do Ollama (menu Iniciar)'
    }
}

# GPU: verificacao informativa. Rodar em CPU "funciona" e e a causa numero 1 de
# reclamacao de lentidao, entao vale avisar alto.
if (TemComando 'nvidia-smi') {
    try {
        $gpu = (& nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>&1 | Out-String).Trim()
        Ok "GPU: $gpu"
        if ($gpu -notmatch '\d') { Aviso 'nao consegui ler a VRAM; confira com: nvidia-smi' }
    } catch {
        Aviso 'nvidia-smi falhou; confira o driver NVIDIA'
    }
} else {
    Aviso 'nvidia-smi nao encontrado - sem driver NVIDIA no PATH'
    Aviso 'o Ollama vai rodar em CPU (funciona, mas leva minutos por documento)'
    RegistrarPendencia 'instalar/atualizar o driver NVIDIA para usar a RTX 4050'
}

# ===========================================================================
# 2. Variaveis de ambiente
# ===========================================================================
Titulo '2/6  Variaveis de ambiente do Ollama (setx = persistente)'

$mudou = $false
foreach ($v in $VariaveisOllama) {
    $atual = [Environment]::GetEnvironmentVariable($v.Nome, 'User')
    if ($atual -eq $v.Valor) {
        Pulado "$($v.Nome) ja = $($v.Valor)"
        continue
    }

    if ($null -ne $atual -and $atual -ne '') {
        # Valor divergente e do usuario. Nunca sobrescrever sem perguntar.
        Aviso "$($v.Nome) esta '$atual' e o recomendado e '$($v.Valor)'"
        Info  "motivo: $($v.Porque)"
        if (-not (Confirmar "sobrescrever $($v.Nome) com '$($v.Valor)'?")) {
            Pulado "$($v.Nome) mantido em '$atual' por escolha sua"
            RegistrarPendencia "revisar $($v.Nome) (esta '$atual', recomendado '$($v.Valor)')"
            continue
        }
    }

    & setx $v.Nome $v.Valor | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Ok "$($v.Nome) = $($v.Valor)"
        Info "motivo: $($v.Porque)"
        $mudou = $true
    } else {
        Erro "falhou ao gravar $($v.Nome)"
        RegistrarFalha "setx $($v.Nome) falhou"
    }
}

if ($mudou) {
    Write-Host ''
    Aviso 'variavel de ambiente e lida na INICIALIZACAO do processo.'
    Aviso 'nada acima tem efeito enquanto o Ollama nao reiniciar.'
    Write-Host ''
    Write-Host '      Get-Process ollama*, "ollama app" -ErrorAction SilentlyContinue | Stop-Process -Force' -ForegroundColor White
    Write-Host '      Start-Process "$env:LOCALAPPDATA\Programs\Ollama\ollama app.exe"' -ForegroundColor White
    Write-Host ''
    Info 'e abra um NOVO PowerShell: a sessao atual nao ve o que o setx gravou'
    RegistrarPendencia 'reiniciar o Ollama para as variaveis novas valerem'
} else {
    Ok 'todas as variaveis ja estavam no valor recomendado'
    RegistrarPronto 'variaveis de ambiente do Ollama configuradas'
}

# ===========================================================================
# 3. Modelos
# ===========================================================================
Titulo '3/6  Modelos da escada'

if ($SemModelos) {
    Pulado '-SemModelos informado: nenhum download'
} elseif (-not $temOllama -or -not $daemonOk) {
    Aviso 'Ollama indisponivel - pulando os downloads'
    RegistrarPendencia 'baixar os modelos (rode este script de novo com o Ollama de pe)'
} else {
    # `ollama list` da a verdade do disco. Normalizamos ":latest" porque o Ollama
    # anexa a tag na listagem mesmo quando o pull foi feito sem ela - mesma
    # normalizacao que router.status() aplica.
    $instalados = @()
    try {
        $saida = & ollama list 2>&1 | Out-String
        $instalados = $saida -split "`r?`n" |
            Select-Object -Skip 1 |
            Where-Object { $_.Trim() -ne '' } |
            ForEach-Object { ($_ -split '\s+')[0] } |
            ForEach-Object { $_; if ($_.EndsWith(':latest')) { $_ -replace ':latest$', '' } }
    } catch {
        Aviso 'nao consegui ler `ollama list`; vou tentar baixar tudo'
    }

    $faltando = @($Modelos | Where-Object { $instalados -notcontains $_.Nome })

    if ($faltando.Count -eq 0) {
        Ok "todos os $($Modelos.Count) modelos ja estao presentes"
        RegistrarPronto "escada de modelos completa ($($Modelos.Count) modelos)"
    } else {
        Info "$($faltando.Count) de $($Modelos.Count) modelo(s) faltando"
        Write-Host ''
        Aviso 'o download total da escada completa e de ~19 GB.'
        Aviso 'faca isto em rede boa e NUNCA no dia da apresentacao.'
        Write-Host ''
        foreach ($m in $faltando) {
            Write-Host ("      {0,-30} {1,-8} {2}" -f $m.Nome, $m.Tamanho, $m.Papel) -ForegroundColor Gray
        }
        Write-Host ''

        if (-not (Confirmar "baixar os $($faltando.Count) modelo(s) faltantes agora?")) {
            Pulado 'downloads dispensados'
            RegistrarPendencia "baixar $($faltando.Count) modelo(s): .\scripts\setup-notebook.ps1"
        } else {
            $i = 0
            foreach ($m in $Modelos) {
                $i++
                $rotulo = "[$i/$($Modelos.Count)] $($m.Nome)"

                if ($instalados -contains $m.Nome) {
                    Pulado "$rotulo - ja presente"
                    continue
                }

                Write-Host ''
                Passo "$rotulo  ($($m.Tamanho), $($m.Papel), cabe na VRAM: $($m.Cabe))"

                # Saida do pull NAO e redirecionada de proposito: a barra de
                # progresso do Ollama e o unico feedback num download de GB.
                & ollama pull $m.Nome
                if ($LASTEXITCODE -eq 0) {
                    Ok "$($m.Nome) baixado"
                } else {
                    Erro "falha ao baixar $($m.Nome) (exit $LASTEXITCODE)"
                    Info 'o pull e retomavel: rode o script de novo e ele continua'
                    RegistrarFalha "download de $($m.Nome) falhou"
                }
            }
            Write-Host ''
            RegistrarPronto 'downloads de modelo processados'
        }
    }

    Write-Host ''
    Info 'os modelos de VISAO so entram em PDF ESCANEADO (sem camada de texto),'
    Info 'que e a minoria dos casos. O caminho normal e texto e nao os usa.'
}

# ===========================================================================
# 4. Ambiente virtual e dependencias
# ===========================================================================
Titulo '4/6  Ambiente virtual e dependencias do servidor'

if (-not (TemComando 'python')) {
    Erro 'Python nao encontrado no PATH.'
    Passo 'instale Python 3.11+ de https://www.python.org/downloads/windows/'
    Passo 'marque "Add python.exe to PATH" no instalador'
    Passo 'nao use o atalho da Microsoft Store (redirecionamento de FS atrapalha venv)'
    RegistrarFalha 'Python ausente - venv e dependencias nao foram criados'
    RegistrarPendencia 'instalar Python 3.11+ e reexecutar este script'
} else {
    $versaoPy = (& python --version 2>&1 | Out-String).Trim()
    Ok "Python presente - $versaoPy"

    if (Test-Path $PythonVenv) {
        Ok "venv ja existe em $DirVenv"
    } else {
        Passo "criando venv em $DirVenv"
        & python -m venv $DirVenv
        if (Test-Path $PythonVenv) {
            Ok 'venv criado'
        } else {
            Erro 'nao consegui criar o venv'
            RegistrarFalha 'criacao do venv falhou'
        }
    }

    if (Test-Path $PythonVenv) {
        RegistrarPronto 'ambiente virtual (.venv) pronto'

        if (-not (Test-Path $Requirements)) {
            Erro "requirements.txt nao encontrado em $Requirements"
            RegistrarFalha 'server/requirements.txt ausente'
        } else {
            Passo 'atualizando pip'
            & $PythonVenv -m pip install --upgrade pip --quiet
            if ($LASTEXITCODE -ne 0) { Aviso 'upgrade do pip falhou; seguindo com a versao atual' }

            Passo 'instalando server/requirements.txt (versoes pinadas exatas)'
            Info 'pinagem exata e deliberada: mudanca de heuristica no pdfplumber'
            Info 'move as coordenadas e muda a deteccao de colunas silenciosamente'

            & $PythonVenv -m pip install -r $Requirements
            if ($LASTEXITCODE -eq 0) {
                Ok 'dependencias instaladas'
                RegistrarPronto 'dependencias do servidor instaladas'

                # Verificacao real: importar o que o servidor precisa. `pip
                # install` sem erro nao garante que a wheel binaria carrega
                # (psycopg[binary] e pypdfium2 trazem binario nativo).
                $codigo = 'import fastapi, pdfplumber, psycopg, httpx, bcrypt, jwt, openpyxl, pypdfium2; print("imports ok")'
                $r = & $PythonVenv -c $codigo 2>&1 | Out-String
                if ($r -match 'imports ok') {
                    Ok 'todas as libs criticas importam'
                } else {
                    Erro 'alguma lib nao importa:'
                    Write-Host $r -ForegroundColor Red
                    RegistrarFalha 'import de dependencia falhou (ver saida acima)'
                }
            } else {
                Erro "pip install falhou (exit $LASTEXITCODE)"
                Info 'SSLError/CERTIFICATE_VERIFY_FAILED aqui significa proxy corporativo:'
                Info 'desconecte a VPN. Este notebook e pessoal, o PyPI deve funcionar.'
                RegistrarFalha 'pip install -r server/requirements.txt falhou'
            }

            # pytest e opcional. run_tests.py roda sem ele (shim de stdlib), mas
            # com o real o relatorio e melhor - e aqui o PyPI funciona.
            $temPytest = (& $PythonVenv -c "import importlib.util,sys; sys.stdout.write('sim' if importlib.util.find_spec('pytest') else 'nao')" 2>&1 | Out-String).Trim()
            if ($temPytest -eq 'sim') {
                Ok 'pytest real disponivel'
            } else {
                Info 'pytest nao instalado; run_tests.py usara o shim de stdlib'
                if (Confirmar 'instalar o pytest real (relatorio melhor)?') {
                    & $PythonVenv -m pip install pytest --quiet
                    if ($LASTEXITCODE -eq 0) { Ok 'pytest instalado' } else { Aviso 'pytest nao instalou; o shim cobre' }
                } else {
                    Pulado 'pytest dispensado - o shim de stdlib cobre os testes de logica'
                }
            }
        }
    }
}

# ===========================================================================
# 5. Arquivo .env
# ===========================================================================
Titulo '5/6  Configuracao (server/.env)'

if (Test-Path $EnvDestino) {
    Ok "$EnvDestino ja existe - NAO foi tocado"
    Info 'confira as variaveis na secao 6 de docs/09-runbook-notebook.md'
    RegistrarPronto 'server/.env presente'
} elseif (Test-Path $EnvExemplo) {
    Copy-Item $EnvExemplo $EnvDestino
    Ok 'server/.env criado a partir de .env.example'
    RegistrarPendencia 'preencher server/.env (DATABASE_URL, JWT_SECRET, ALLOCATOR_API_TOKEN, ALLOWED_ORIGINS)'
} else {
    # Sem .env.example no repositorio, geramos um modelo minimo com os segredos
    # JA gerados - nao ha razao para deixar o usuario fazer isso a mao e errar.
    Aviso "$EnvExemplo nao existe; vou escrever um modelo minimo"

    $jwt   = 'PREENCHA-COM-UM-SEGREDO-ALEATORIO'
    $token = 'PREENCHA-COM-OUTRO-SEGREDO-ALEATORIO'
    if (Test-Path $PythonVenv) {
        try {
            $jwt   = (& $PythonVenv -c "import secrets; print(secrets.token_urlsafe(48))" 2>&1 | Out-String).Trim()
            $token = (& $PythonVenv -c "import secrets; print(secrets.token_urlsafe(48))" 2>&1 | Out-String).Trim()
            Ok 'segredos gerados com secrets.token_urlsafe(48)'
        } catch {
            Aviso 'nao consegui gerar os segredos; deixei placeholder no arquivo'
        }
    }

    $modelo = @"
# ALLocator v2 - configuracao do servidor.
# Gerado por scripts/setup-notebook.ps1. NUNCA COMMITE ESTE ARQUIVO.
# Referencia completa: secao 6 de docs/09-runbook-notebook.md

# --- plano de dados: connection string do Neon (sslmode=require e obrigatorio) ---
DATABASE_URL=

# --- segredos (gerados aqui; um DIFERENTE para cada papel) ---
JWT_SECRET=$jwt
ALLOCATOR_API_TOKEN=$token

# --- CORS: origem do GitHub Pages + desenvolvimento local ---
# Somente esquema + host + porta. Sem caminho, sem barra final.
ALLOWED_ORIGINS=http://localhost:5173

# --- plano de inferencia: mantenha o loopback mesmo com OLLAMA_HOST=0.0.0.0 ---
OLLAMA_URL=$URL_OLLAMA

# --- fallback de nuvem. VAZIO = garantia estrutural de que nada sai da maquina ---
GEMINI_API_KEY=
GROQ_API_KEY=

# --- limites ---
MAX_UPLOAD_MB=25
"@

    # UTF-8 SEM BOM: no PowerShell 5.1, `Set-Content -Encoding UTF8` grava BOM, e
    # o BOM entra como parte da primeira linha para quem le o .env como texto
    # simples. Aqui escrevemos pelo .NET com UTF8Encoding($false).
    [System.IO.File]::WriteAllText($EnvDestino, $modelo, (New-Object System.Text.UTF8Encoding($false)))
    Ok 'server/.env criado com JWT_SECRET e ALLOCATOR_API_TOKEN ja gerados'
    Aviso 'DATABASE_URL e ALLOWED_ORIGINS continuam vazios - preencha a mao'
    RegistrarPendencia 'preencher DATABASE_URL em server/.env (connection string do Neon)'
    RegistrarPendencia 'preencher ALLOWED_ORIGINS em server/.env com a origem do GitHub Pages'
}

Write-Host ''
Aviso 'NUNCA commite o server/.env: ele tem a senha do banco e as chaves de API.'
Info  'verifique com:  git check-ignore -v server\.env'

# ===========================================================================
# 6. Testes
# ===========================================================================
Titulo '6/6  Suite de testes'

if (-not (Test-Path $RunTests)) {
    Aviso "run_tests.py nao encontrado em $RunTests"
    RegistrarPendencia 'rodar a suite a mao: python -X utf8 server/run_tests.py'
} elseif (-not (Test-Path $PythonVenv)) {
    Aviso 'venv indisponivel - nao rodei os testes'
    RegistrarPendencia 'rodar a suite: python -X utf8 server/run_tests.py'
} else {
    # -X utf8 e obrigatorio: sem ele o console em cp1252 levanta
    # UnicodeEncodeError ao imprimir os simbolos do relatorio.
    Passo 'python -X utf8 server/run_tests.py'
    Write-Host ''
    $codigoTestes = 1
    Push-Location $Raiz
    try {
        & $PythonVenv -X utf8 $RunTests
        $codigoTestes = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    Write-Host ''
    if ($codigoTestes -eq 0) {
        Ok 'suite passou'
        RegistrarPronto 'suite de testes do servidor passando'
    } else {
        Erro "suite falhou (exit $codigoTestes)"
        RegistrarFalha 'suite de testes com falha - veja a saida acima'
    }
}

# ===========================================================================
# Resumo
# ===========================================================================
Titulo 'Resumo'

Write-Host ''
Write-Host '  PRONTO' -ForegroundColor Green
if ($script:Prontos.Count -eq 0) {
    Write-Host '    (nada concluido nesta execucao)' -ForegroundColor DarkGray
} else {
    foreach ($t in $script:Prontos) { Write-Host "    - $t" -ForegroundColor Green }
}

if ($script:Falhas.Count -gt 0) {
    Write-Host ''
    Write-Host '  FALHOU - resolva antes de seguir' -ForegroundColor Red
    foreach ($t in $script:Falhas) { Write-Host "    - $t" -ForegroundColor Red }
}

Write-Host ''
Write-Host '  FALTA VOCE FAZER A MAO' -ForegroundColor Yellow
foreach ($t in $script:Pendencias) { Write-Host "    - $t" -ForegroundColor Yellow }
Write-Host '    - criar o projeto no Neon e rodar server/app/db/schema.sql no SQL Editor' -ForegroundColor Yellow
Write-Host '      (secao 3 de docs/10-deploy-github-pages.md)' -ForegroundColor DarkGray
Write-Host '    - criar o primeiro usuario no banco (hash com o bcrypt do projeto)' -ForegroundColor Yellow
Write-Host '    - instalar o cloudflared:  winget install --id Cloudflare.cloudflared' -ForegroundColor Yellow
Write-Host '      (secao 8 de docs/09-runbook-notebook.md)' -ForegroundColor DarkGray
Write-Host '    - desligar o sono:  powercfg /change standby-timeout-ac 0' -ForegroundColor Yellow

Write-Host ''
Write-Host '  PROXIMO PASSO' -ForegroundColor Cyan
Write-Host "    .\scripts\start-servidor.ps1 -Porta $Porta" -ForegroundColor White
Write-Host ''
Write-Host '    Ele aquece o modelo na VRAM, sobe a API, espera o /health e abre' -ForegroundColor DarkGray
Write-Host '    o tunnel, imprimindo a URL publica para voce colar no portal.' -ForegroundColor DarkGray
Write-Host ''
Write-Host '  Verificacao rapida do que ficou de pe:' -ForegroundColor Cyan
Write-Host "    Invoke-RestMethod $URL_OLLAMA/api/tags | ForEach-Object { `$_.models.name }" -ForegroundColor White
Write-Host "    ollama ps" -ForegroundColor White
Write-Host ''

if ($script:Falhas.Count -gt 0) { exit 1 }
exit 0
