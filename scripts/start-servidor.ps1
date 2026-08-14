<#
.SYNOPSIS
    Sobe o plano de INFERENCIA do ALLocator v2 na ordem correta, verificando
    cada etapa.

.DESCRIPTION
    Sequencia (secoes 7 a 9 de docs/09-runbook-notebook.md):

      1. Ollama respondendo em /api/tags (a mesma sonda que ClienteOllama usa);
      2. AQUECIMENTO do modelo de texto - carrega os 4,7 GB na VRAM antes de o
         usuario precisar (ver o comentario extenso na funcao Aquecer);
      3. API (uvicorn) numa janela propria;
      4. espera /health responder antes de seguir;
      5. cloudflared, com a URL publica destacada na tela.

    Ctrl+C encerra os processos filhos que este script criou.

.PARAMETER Porta
    Porta da API. Padrao: 8123.

.PARAMETER SemTunnel
    Nao sobe o cloudflared. Para uso puramente local (portal em localhost:5173).

.PARAMETER TunnelNomeado
    Nome de um tunnel nomeado ja criado (caminho B do runbook): usa
    `cloudflared tunnel run <nome>` e hostname FIXO, em vez do tunnel rapido de
    hostname aleatorio.

.PARAMETER SemAquecimento
    Pula a chamada de aquecimento. So use se o modelo ja estiver residente
    (confira com `ollama ps`).

.EXAMPLE
    .\scripts\start-servidor.ps1
    Ollama + aquecimento + API + tunnel rapido (hostname aleatorio).

.EXAMPLE
    .\scripts\start-servidor.ps1 -TunnelNomeado allocator
    Idem, com hostname fixo.

.EXAMPLE
    .\scripts\start-servidor.ps1 -SemTunnel
    So local, sem expor nada.
#>

[CmdletBinding()]
param(
    [int]    $Porta = 8123,
    [switch] $SemTunnel,
    [string] $TunnelNomeado = '',
    [switch] $SemAquecimento
)

$ErrorActionPreference = 'Stop'

# No PowerShell 7.4+ esta preferencia vem $true e faz comando NATIVO com exit
# code != 0 virar erro TERMINANTE. Aqui isso e indesejado: `ollama ps` ou
# `cloudflared` devolvendo codigo nao-zero nao deve derrubar o script no meio,
# deixando processo filho orfao. No PowerShell 5.1 a variavel nao existe e a
# atribuicao e inocua.
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

function Ok     { param([string] $Texto) Write-Host "  [ok]     $Texto" -ForegroundColor Green }
function Aviso  { param([string] $Texto) Write-Host "  [aviso]  $Texto" -ForegroundColor Yellow }
function Erro   { param([string] $Texto) Write-Host "  [erro]   $Texto" -ForegroundColor Red }
function Info   { param([string] $Texto) Write-Host "  [info]   $Texto" -ForegroundColor Gray }
function Passo  { param([string] $Texto) Write-Host "  ->       $Texto" -ForegroundColor White }
function Pulado { param([string] $Texto) Write-Host "  [pulado] $Texto" -ForegroundColor DarkGray }

# Largura interna das molduras de destaque.
$LARGURA_CAIXA = 68

function Caixa {
    <#
      Desenha uma moldura com as linhas informadas. O alinhamento e CALCULADO
      (PadRight), nao contado a mao: caixa com borda torta chama atencao para o
      lugar errado, e a URL do tunnel e a informacao mais importante da tela.
      Linha maior que a largura e truncada em vez de estourar a moldura.
    #>
    param(
        [string[]] $Linhas,
        [string]   $Cor = 'Green'
    )
    $borda = '  +' + ('-' * $LARGURA_CAIXA) + '+'
    Write-Host $borda -ForegroundColor Cyan
    foreach ($linha in $Linhas) {
        $texto = '  ' + $linha
        if ($texto.Length -gt $LARGURA_CAIXA) { $texto = $texto.Substring(0, $LARGURA_CAIXA) }
        Write-Host '  |' -NoNewline -ForegroundColor Cyan
        Write-Host $texto.PadRight($LARGURA_CAIXA) -NoNewline -ForegroundColor $Cor
        Write-Host '|' -ForegroundColor Cyan
    }
    Write-Host $borda -ForegroundColor Cyan
}

# ---------------------------------------------------------------------------
# Caminhos e constantes
# ---------------------------------------------------------------------------

$Raiz       = Split-Path -Parent $PSScriptRoot
$DirServer  = Join-Path $Raiz 'server'
$PythonVenv = Join-Path $Raiz '.venv\Scripts\python.exe'
$DirLogs    = Join-Path $Raiz '.logs'

$URL_OLLAMA         = 'http://127.0.0.1:11434'
$MODELO_AQUECIMENTO = 'qwen2.5:7b-instruct-q4_K_M'
$MODELO_RESERVA     = 'qwen2.5:3b-instruct-q4_K_M'

$SEGUNDOS_HEALTH    = 60   # janela para a API subir (import de pdfplumber/psycopg leva alguns segundos)
$SEGUNDOS_TUNNEL    = 45   # janela para o cloudflared anunciar o hostname
$SEGUNDOS_AQUECER   = 180  # carregar 4,7 GB do disco pode passar de 60s em disco lento

# Processos filhos criados por este script. O handler de Ctrl+C percorre esta
# lista - sem isso, cancelar o script deixaria uvicorn e cloudflared orfaos,
# segurando a porta e o tunnel, e a proxima execucao falharia com "address in use".
$script:Filhos = New-Object System.Collections.Generic.List[object]

function RegistrarFilho {
    param([System.Diagnostics.Process] $Processo, [string] $Rotulo)
    if ($null -ne $Processo) {
        $script:Filhos.Add([pscustomobject]@{ Processo = $Processo; Rotulo = $Rotulo }) | Out-Null
    }
}

function EncerrarFilhos {
    if ($script:Filhos.Count -eq 0) { return }
    Write-Host ''
    Titulo 'Encerrando'
    foreach ($f in $script:Filhos) {
        try {
            if (-not $f.Processo.HasExited) {
                Passo "encerrando $($f.Rotulo) (PID $($f.Processo.Id))"
                # Stop-Process -Force mata a arvore do filho. Nao usamos
                # Stop-Process por NOME em nenhum ponto: mataria instancia de
                # uvicorn/cloudflared que o usuario subiu por fora deste script.
                Stop-Process -Id $f.Processo.Id -Force -ErrorAction SilentlyContinue
                Ok "$($f.Rotulo) encerrado"
            } else {
                Info "$($f.Rotulo) ja havia terminado"
            }
        } catch {
            Aviso "nao consegui encerrar $($f.Rotulo): $($_.Exception.Message)"
        }
    }
    $script:Filhos.Clear()
    Write-Host ''
    Info 'o daemon do Ollama NAO foi encerrado (ele nao foi iniciado por este script)'
    Write-Host ''
}

# ---------------------------------------------------------------------------
# Etapas
# ---------------------------------------------------------------------------

function VerificarOllama {
    <# /api/tags e a sonda de disponibilidade do projeto (TIMEOUT_SONDA = 2s em
       server/app/llm/ollama.py). Se ela nao responde, a cascata considera o
       Ollama fora e cai para a nuvem - entao e exatamente ela que checamos. #>
    Titulo '1/5  Ollama'

    try {
        $tags = Invoke-RestMethod -Uri "$URL_OLLAMA/api/tags" -TimeoutSec 5
    } catch {
        Erro "Ollama nao respondeu em $URL_OLLAMA"
        Passo 'abra o Ollama pelo menu Iniciar (fica na bandeja do sistema)'
        Passo 'ou rode primeiro:  .\scripts\setup-notebook.ps1'
        return $null
    }

    $nomes = @($tags.models | ForEach-Object { $_.name })
    Ok "daemon respondendo ($($nomes.Count) modelo(s) no disco)"

    $keepAlive = [Environment]::GetEnvironmentVariable('OLLAMA_KEEP_ALIVE', 'User')
    if ($keepAlive) {
        Ok "OLLAMA_KEEP_ALIVE = $keepAlive"
    } else {
        Aviso 'OLLAMA_KEEP_ALIVE nao definido: o padrao de 5 min vai descarregar'
        Aviso 'o modelo da VRAM e a proxima chamada pagara ~20s de carregamento.'
        Passo 'rode .\scripts\setup-notebook.ps1 -SemModelos para corrigir'
    }

    # Escolhe o degrau da escada que esta de fato no disco. `ollama list` anexa
    # ":latest" as vezes, dai o -like.
    foreach ($candidato in @($MODELO_AQUECIMENTO, $MODELO_RESERVA)) {
        if ($nomes | Where-Object { $_ -eq $candidato -or $_ -like "$candidato*" }) {
            Ok "modelo de texto disponivel: $candidato"
            return $candidato
        }
    }

    Aviso 'nenhum modelo de texto da escada esta baixado'
    Passo "ollama pull $MODELO_AQUECIMENTO"
    Info  'a API sobe de qualquer forma: sem modelo local, a cascata usa nuvem'
    Info  'ou o portal segue no modo 100% deterministico'
    return ''
}

function Aquecer {
    <#
      AQUECIMENTO - por que esta etapa existe.

      Os 4,7 GB do peso quantizado de qwen2.5:7b so entram na VRAM na PRIMEIRA
      requisicao. Ler isso do disco e transferir para a GPU leva cerca de 20
      segundos. Se a primeira requisicao do dia for a que o usuario dispara na
      frente de outra pessoa, sao 20 segundos de tela parada, sem barra de
      progresso e sem explicacao na UI - indistinguivel de travamento.

      Fazendo a chamada aqui, o custo e pago no tempo do operador, antes de
      qualquer uso. Com OLLAMA_KEEP_ALIVE=30m o modelo permanece residente pela
      sessao inteira, e as chamadas seguintes voltam em menos de 2 segundos.

      keep_alive vai explicito no corpo para nao depender exclusivamente da
      variavel de ambiente (que so vale se o daemon subiu depois do setx).
    #>
    param([string] $Modelo)

    Titulo '2/5  Aquecimento do modelo'

    if ($SemAquecimento) { Pulado '-SemAquecimento informado'; return }
    if ([string]::IsNullOrWhiteSpace($Modelo)) {
        Pulado 'sem modelo de texto local para aquecer'
        return
    }

    Passo "carregando $Modelo na VRAM"
    Info  'a primeira chamada leva ~20s (peso do disco -> VRAM). E o ponto.'

    $corpo = @{
        model      = $Modelo
        messages   = @(@{ role = 'user'; content = 'responda apenas: ok' })
        stream     = $false
        keep_alive = '30m'
        options    = @{ temperature = 0; num_ctx = 8192 }
    } | ConvertTo-Json -Depth 5

    $cronometro = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $r = Invoke-RestMethod -Method Post -Uri "$URL_OLLAMA/api/chat" `
            -ContentType 'application/json' -Body $corpo -TimeoutSec $SEGUNDOS_AQUECER
        $cronometro.Stop()
        $seg = [math]::Round($cronometro.Elapsed.TotalSeconds, 1)
        Ok "modelo carregado em ${seg}s"
        if ($r.message.content) {
            Info "resposta: $(($r.message.content -replace '\s+', ' ').Trim())"
        }
    } catch {
        $cronometro.Stop()
        Erro "aquecimento falhou apos $([math]::Round($cronometro.Elapsed.TotalSeconds,1))s"
        Info  "detalhe: $($_.Exception.Message)"
        Info  'out-of-memory? feche o navegador (Chrome/Edge reservam VRAM) e use'
        Info  "o degrau menor: $MODELO_RESERVA"
        Aviso 'seguindo sem aquecimento - a primeira chamada real pagara o custo'
        return
    }

    # `ollama ps` e a prova visual de que o modelo ficou residente e em GPU.
    # A coluna PROCESSOR tem de dizer 100% GPU; UNTIL, ~30 minutos a frente.
    Write-Host ''
    Info 'ollama ps (confira PROCESSOR = 100% GPU e UNTIL ~30 min a frente):'
    try { & ollama ps } catch { Aviso 'nao consegui rodar `ollama ps`' }
}

function SubirApi {
    Titulo '3/5  API (uvicorn)'

    if (-not (Test-Path $DirServer)) {
        Erro "pasta server nao encontrada em $DirServer"
        return $null
    }

    # O venv e preferido; se nao existir, cai para o python do PATH em vez de
    # abortar - as deps podem estar instaladas globalmente.
    $python = if (Test-Path $PythonVenv) { $PythonVenv } else { 'python' }
    if ($python -eq 'python') {
        Aviso 'venv nao encontrado; usando o python do PATH'
        Passo 'crie o venv com .\scripts\setup-notebook.ps1'
    } else {
        Ok 'usando o Python do venv'
    }

    if (-not (Test-Path (Join-Path $DirServer '.env'))) {
        Aviso 'server/.env nao existe - a API pode subir sem banco e sem CORS'
        Passo 'secao 6 de docs/09-runbook-notebook.md'
    }

    if (-not (Test-Path $DirLogs)) { New-Item -ItemType Directory -Path $DirLogs -Force | Out-Null }
    $logApi = Join-Path $DirLogs 'uvicorn.log'

    Passo "uvicorn app.main:app --host 0.0.0.0 --port $Porta"
    Info  'em janela propria: o log fica visivel e nao polui esta saida'
    Info  'sem --reload de proposito: reiniciar descarta disjuntores e trace'

    # Janela propria (-NoExit) para o log ficar a vista durante a sessao.
    # -WorkingDirectory server/ e obrigatorio: `app.main:app` e resolvido
    # relativo ao diretorio de trabalho.
    $argumentos = @(
        '-NoProfile', '-NoExit', '-Command',
        "& '$python' -m uvicorn app.main:app --host 0.0.0.0 --port $Porta 2>&1 | Tee-Object -FilePath '$logApi'"
    )

    try {
        $proc = Start-Process -FilePath 'powershell.exe' -ArgumentList $argumentos `
            -WorkingDirectory $DirServer -PassThru
        RegistrarFilho -Processo $proc -Rotulo 'uvicorn'
        Ok "uvicorn iniciado (PID $($proc.Id))"
        Info "log: $logApi"
        return $proc
    } catch {
        Erro "nao consegui iniciar o uvicorn: $($_.Exception.Message)"
        return $null
    }
}

function EsperarHealth {
    <# Espera ativa no /health. Subir o processo nao e o mesmo que estar
       pronto: importar pdfplumber, pypdfium2 e psycopg leva alguns segundos, e
       abrir o tunnel antes disso produz 502 no primeiro acesso. #>
    Titulo '4/5  Esperando /health'

    $url = "http://127.0.0.1:$Porta/health"
    Passo "aguardando $url (ate ${SEGUNDOS_HEALTH}s)"

    $limite = (Get-Date).AddSeconds($SEGUNDOS_HEALTH)
    $saude  = $null

    while ((Get-Date) -lt $limite) {
        try {
            $saude = Invoke-RestMethod -Uri $url -TimeoutSec 3
            break
        } catch {
            Write-Host '.' -NoNewline -ForegroundColor DarkGray
            Start-Sleep -Seconds 2
        }
    }
    Write-Host ''

    if ($null -eq $saude) {
        Erro "/health nao respondeu em ${SEGUNDOS_HEALTH}s"
        Passo 'veja o erro na janela do uvicorn (ou no log em .logs\uvicorn.log)'
        Info  'faltando app/main.py? porta ocupada? .env invalido?'
        return $false
    }

    Ok "/health respondeu"

    # Le o retorno de router.status() e traduz para linguagem de operacao.
    try {
        if ($null -ne $saude.ollama) {
            if ($saude.ollama.ativo) {
                Ok "Ollama ativo em $($saude.ollama.url)"
                $inst = @($saude.ollama.modelos_instalados)
                Info "modelos instalados: $($inst.Count)"
            } else {
                Aviso 'a API nao esta enxergando o Ollama - confira OLLAMA_URL no .env'
            }
        }
        if ($null -ne $saude.nuvem) {
            foreach ($p in @('gemini', 'groq')) {
                $prov = $saude.nuvem.$p
                if ($null -ne $prov) {
                    if ($prov.configurado) {
                        Info "fallback $p configurado (modelo $($prov.modelo))"
                    } else {
                        Ok "fallback $p SEM chave - dado do cliente nao sai da maquina"
                    }
                }
            }
        }
        if ($null -ne $saude.disjuntores) {
            $abertos = @($saude.disjuntores.PSObject.Properties | Where-Object { $_.Value.aberto })
            if ($abertos.Count -gt 0) {
                Aviso "disjuntor aberto: $($abertos.Name -join ', ')"
                Info  '3 falhas consecutivas abrem por 120s; um sucesso zera o contador'
            } else {
                Ok 'nenhum disjuntor aberto'
            }
        }
    } catch {
        Info 'nao consegui interpretar todos os campos do /health (formato diferente do esperado)'
    }

    Write-Host ''
    Info "documentacao interativa: http://127.0.0.1:$Porta/docs"
    return $true
}

function SubirTunnel {
    Titulo '5/5  Cloudflare Tunnel'

    if ($SemTunnel) {
        Pulado '-SemTunnel informado: nada foi exposto'
        Info   "a API responde apenas em http://127.0.0.1:$Porta"
        return
    }

    if (-not (Get-Command 'cloudflared' -ErrorAction SilentlyContinue)) {
        Erro 'cloudflared nao encontrado no PATH'
        Passo 'winget install --id Cloudflare.cloudflared'
        Passo 'depois FECHE E REABRA o PowerShell (o PATH muda)'
        Aviso "seguindo sem tunnel - a API continua em http://127.0.0.1:$Porta"
        return
    }

    # -------------------------------------------------- caminho B: nomeado
    if (-not [string]::IsNullOrWhiteSpace($TunnelNomeado)) {
        Passo "cloudflared tunnel run $TunnelNomeado"
        Info  'caminho B: hostname FIXO, definido no ~/.cloudflared/config.yml'

        try {
            $proc = Start-Process -FilePath 'cloudflared' -ArgumentList @('tunnel', 'run', $TunnelNomeado) -PassThru
            RegistrarFilho -Processo $proc -Rotulo "cloudflared ($TunnelNomeado)"
            Ok "tunnel '$TunnelNomeado' iniciado (PID $($proc.Id))"
        } catch {
            Erro "nao consegui iniciar o tunnel: $($_.Exception.Message)"
            return
        }

        Start-Sleep -Seconds 5
        Write-Host ''
        Caixa -Cor Yellow -Linhas @(
            'TUNNEL NOMEADO ATIVO - hostname FIXO',
            '',
            "tunnel: $TunnelNomeado"
        )
        Write-Host ''
        Info  "o hostname e o que voce mapeou com: cloudflared tunnel route dns $TunnelNomeado <host>"
        Info  'como ele NAO muda, o runtime-config.json ja deve estar correto.'
        Write-Host ''
        Passo 'confirme de fora (troque pelo seu hostname):'
        Write-Host '      Invoke-RestMethod https://SEU-HOST/health | ConvertTo-Json -Depth 5' -ForegroundColor White
        Write-Host ''
        return
    }

    # -------------------------------------------------- caminho A: rapido
    Passo "cloudflared tunnel --url http://localhost:$Porta"
    Info  'caminho A: sem conta, hostname ALEATORIO que muda a cada reinicio'

    $logTunnel = Join-Path $DirLogs 'cloudflared.log'

    # Apagar OS DOIS logs da execucao anterior antes de subir. Se sobrasse o
    # .err antigo, o regex acharia o hostname da sessao passada e o script
    # anunciaria com destaque uma URL que nao existe mais - erro pior que nao
    # achar nenhuma, porque parece ter funcionado.
    foreach ($antigo in @($logTunnel, "$logTunnel.err")) {
        if (Test-Path $antigo) { Remove-Item $antigo -Force -ErrorAction SilentlyContinue }
    }

    # O hostname e anunciado na saida do processo, e o cloudflared escreve em
    # stderr. Redirecionamos os dois para arquivo e lemos de la - e a unica
    # forma confiavel de capturar a URL sem consumir o console do processo.
    try {
        $proc = Start-Process -FilePath 'cloudflared' `
            -ArgumentList @('tunnel', '--url', "http://localhost:$Porta") `
            -RedirectStandardOutput $logTunnel `
            -RedirectStandardError  "$logTunnel.err" `
            -PassThru -WindowStyle Hidden
        RegistrarFilho -Processo $proc -Rotulo 'cloudflared (rapido)'
        Ok "cloudflared iniciado (PID $($proc.Id))"
    } catch {
        Erro "nao consegui iniciar o cloudflared: $($_.Exception.Message)"
        return
    }

    Passo "procurando o hostname publico (ate ${SEGUNDOS_TUNNEL}s)"
    $limite   = (Get-Date).AddSeconds($SEGUNDOS_TUNNEL)
    $hostname = $null

    while ((Get-Date) -lt $limite -and -not $hostname) {
        Start-Sleep -Seconds 2
        Write-Host '.' -NoNewline -ForegroundColor DarkGray

        foreach ($arq in @($logTunnel, "$logTunnel.err")) {
            if (-not (Test-Path $arq)) { continue }
            $texto = Get-Content $arq -Raw -ErrorAction SilentlyContinue
            if (-not $texto) { continue }
            $m = [regex]::Match($texto, 'https://[a-z0-9-]+\.trycloudflare\.com')
            if ($m.Success) { $hostname = $m.Value; break }
        }

        if ($proc.HasExited) {
            Write-Host ''
            Erro "cloudflared terminou sozinho (exit $($proc.ExitCode))"
            Info  "log: $logTunnel"
            return
        }
    }
    Write-Host ''

    if (-not $hostname) {
        Aviso "nao achei o hostname em ${SEGUNDOS_TUNNEL}s (o processo continua rodando)"
        Passo "procure a URL *.trycloudflare.com no log: $logTunnel"
        return
    }

    # -------------------------------------------------- destaque
    Write-Host ''
    Caixa -Cor Green -Linhas @(
        'URL PUBLICA DO PLANO DE INFERENCIA',
        '',
        $hostname,
        ''
    )
    Write-Host ''

    Write-Host '  ESTE HOSTNAME MUDA A CADA REINICIO DO CLOUDFLARED.' -ForegroundColor Yellow
    Write-Host '  Atualize o portal, por um dos dois caminhos:' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '    (a) RAPIDO - portal > Configuracoes > campo da API de inferencia' -ForegroundColor White
    Write-Host '        cole a URL e salve. Vale na hora, sem rebuild, sem deploy.' -ForegroundColor DarkGray
    Write-Host '        Salva em localStorage e tem PRIORIDADE sobre o arquivo.' -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '    (b) PERMANENTE - portal/public/runtime-config.json' -ForegroundColor White
    Write-Host '        {' -ForegroundColor DarkGray
    Write-Host '          "apiDados": "https://SEU-SERVICO.onrender.com",' -ForegroundColor DarkGray
    Write-Host "          `"apiInferencia`": `"$hostname`"," -ForegroundColor Green
    Write-Host '          "versao": "2.0.0"' -ForegroundColor DarkGray
    Write-Host '        }' -ForegroundColor DarkGray
    Write-Host '        exige commit + push (o workflow republica em ~2 min).' -ForegroundColor DarkGray
    Write-Host ''

    # Copia para a area de transferencia: reduz erro de digitacao na hora ruim.
    try {
        Set-Clipboard -Value $hostname
        Ok 'URL copiada para a area de transferencia'
    } catch {
        Info 'nao consegui copiar para a area de transferencia'
    }

    Passo 'confirmando o caminho publico ponta a ponta'
    try {
        $externo = Invoke-RestMethod -Uri "$hostname/health" -TimeoutSec 25
        if ($null -ne $externo) { Ok '/health respondeu pelo tunnel - caminho publico fechado' }
    } catch {
        Aviso "o /health nao respondeu pelo tunnel ainda: $($_.Exception.Message)"
        Info  'a borda da Cloudflare pode levar alguns segundos. Tente:'
        Write-Host "      Invoke-RestMethod $hostname/health | ConvertTo-Json -Depth 5" -ForegroundColor White
    }

    Write-Host ''
    Info 'limitacoes do tunnel rapido: hostname muda a cada reinicio, ~200'
    Info 'requisicoes concorrentes e sem suporte a SSE. Para hostname fixo, use'
    Info '-TunnelNomeado <nome> (caminho B, secao 8 do runbook).'
}

# ===========================================================================
# Execucao
# ===========================================================================

Write-Host ''
Write-Host '  ALLocator v2 - plano de INFERENCIA' -ForegroundColor Cyan
Write-Host '  ----------------------------------' -ForegroundColor DarkGray
Info "raiz:  $Raiz"
Info "porta: $Porta"
if ($SemTunnel)                                     { Info 'tunnel: desabilitado (-SemTunnel)' }
elseif (-not [string]::IsNullOrWhiteSpace($TunnelNomeado)) { Info "tunnel: nomeado '$TunnelNomeado' (hostname fixo)" }
else                                                { Info 'tunnel: rapido (hostname aleatorio)' }

# Ctrl+C: o PowerShell interrompe o pipeline e o bloco `finally` la embaixo
# executa de qualquer forma - e ele que chama EncerrarFilhos. Nao registramos
# handler nativo de console de proposito: try/finally cobre tanto Ctrl+C quanto
# excecao quanto `exit`, e um handler extra so criaria caminho duplicado de
# limpeza (com risco de encerrar duas vezes o mesmo PID).
$codigoSaida = 0

try {
    $modeloTexto = VerificarOllama
    if ($null -eq $modeloTexto) {
        Erro 'sem Ollama nao ha plano de inferencia. Abortando.'
        Info 'para subir so a API (modo deterministico), use:'
        Write-Host "      cd server; uvicorn app.main:app --host 0.0.0.0 --port $Porta" -ForegroundColor White
        exit 1
    }

    Aquecer -Modelo $modeloTexto

    $api = SubirApi
    if ($null -eq $api) {
        Erro 'a API nao subiu. Abortando.'
        EncerrarFilhos
        exit 1
    }

    if (-not (EsperarHealth)) {
        Aviso 'a API nao ficou saudavel. Nao vou abrir o tunnel (daria 502).'
        Passo 'corrija o erro na janela do uvicorn e rode este script de novo.'
        Write-Host ''
        if ((Read-Host '  [?]      encerrar os processos filhos agora? [S/n]') -notmatch '^[nN]') {
            EncerrarFilhos
        } else {
            # O usuario pediu para MANTER os processos. Esvaziamos a lista para
            # que o `finally` nao os encerre por baixo - sem isto, a limpeza
            # automatica desfaria a escolha dele.
            $mantidos = @($script:Filhos | ForEach-Object { "$($_.Rotulo) (PID $($_.Processo.Id))" })
            $script:Filhos.Clear()
            Info "processos mantidos de pe para inspecao: $($mantidos -join ', ')"
            Info 'encerre-os a mao quando terminar:  Stop-Process -Id <PID> -Force'
        }
        exit 1
    }

    SubirTunnel

    # ------------------------------------------------------------------ pronto
    Titulo 'De pe'
    Write-Host ''
    Write-Host '  Checklist final (secao 9 de docs/09-runbook-notebook.md):' -ForegroundColor Cyan
    Write-Host '    1. ollama ps  -> PROCESSOR 100% GPU, UNTIL ~30 min a frente' -ForegroundColor Gray
    Write-Host "    2. http://127.0.0.1:$Porta/health  -> Ollama ativo, escada instalada" -ForegroundColor Gray
    Write-Host '    3. /health pelo tunnel, de FORA (celular na rede movel serve)' -ForegroundColor Gray
    Write-Host '    4. portal > Configuracoes com a URL de inferencia atual' -ForegroundColor Gray
    Write-Host '    5. um balancete de ponta a ponta, COM e SEM a IA ligada' -ForegroundColor Gray
    Write-Host ''
    Write-Host '  Lembretes:' -ForegroundColor Cyan
    Write-Host '    - notebook na tomada e sono desligado:' -ForegroundColor Gray
    Write-Host '        powercfg /change standby-timeout-ac 0' -ForegroundColor White
    Write-Host '    - se o notebook desligar, o portal SEGUE lendo e salvando analises.' -ForegroundColor Gray
    Write-Host '      So o botao de IA fica indisponivel.' -ForegroundColor Gray
    Write-Host ''
    Write-Host '  Ctrl+C encerra a API e o tunnel iniciados aqui.' -ForegroundColor Yellow
    Write-Host '  (o daemon do Ollama NAO e encerrado)' -ForegroundColor DarkGray
    Write-Host ''

    # Espera ativa: enquanto os filhos vivem, o script vive. Sai sozinho se um
    # deles morrer - a morte do uvicorn deixa o tunnel apontando para o vazio.
    while ($true) {
        Start-Sleep -Seconds 5
        $mortos = @($script:Filhos | Where-Object { $_.Processo.HasExited })
        if ($mortos.Count -gt 0) {
            Write-Host ''
            foreach ($m in $mortos) {
                Erro "$($m.Rotulo) terminou (exit $($m.Processo.ExitCode))"
            }
            Aviso 'encerrando o restante para nao deixar processo orfao'
            $codigoSaida = 1
            break
        }
    }
} catch {
    # Ctrl+C e qualquer excecao nao tratada caem aqui.
    Write-Host ''
    if ($_.Exception -is [System.Management.Automation.PipelineStoppedException]) {
        Info 'interrompido pelo usuario (Ctrl+C)'
    } else {
        Erro "falha inesperada: $($_.Exception.Message)"
        Info  $_.ScriptStackTrace
        $codigoSaida = 1
    }
} finally {
    EncerrarFilhos
}

exit $codigoSaida
