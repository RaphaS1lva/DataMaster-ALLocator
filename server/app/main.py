"""
ALLocator v2 - API.

RESPONSABILIDADES, e apenas estas:

  /read        leitura DETERMINÍSTICA do documento (0 tokens) + gate de
               admissibilidade contábil. É o único caminho de entrada.
  /julgamental julgamento semântico pelo LLM, com candidatos já restritos ao
               bloco compatível e guardrails na saída.
  /parecer     texto executivo (só prosa; nunca altera dado).
  /dados/*     CRUD e memória do cliente (Neon).
  /health      estado dos provedores e do banco.

O QUE A API NÃO FAZ: ela não calcula o balanço. O pipeline contábil,
hierarquia, sinal, agregação, conservação de valor, identidade - roda no
NAVEGADOR (`portal/src/core/`), porque assim recalcula instantaneamente a cada
edição do analista e continua funcionando com o servidor fora do ar.

DOIS PLANOS, DE PROPÓSITO (ver docs/01-arquitetura.md):
  · plano de DADOS      -> este mesmo app hospedado no Render (sempre alcançável)
  · plano de INFERÊNCIA -> este mesmo app no notebook com GPU, via Cloudflare Tunnel
Um único código, duas implantações. Se o notebook estiver desligado, o portal
continua lendo e salvando análises; só o botão de IA fica indisponível.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
import uuid
from typing import Any

from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .llm import prompts
from .llm.guardrails import sanitizar_texto_documento, validar_sugestoes
from .obs.trace import TRACE
from .reading.balancete import ler_balancete
from .seguranca import MAX_PAGINAS, MAX_UPLOAD_MB, avaliar_arquivo, detectar_injecao

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="ALLocator v2 API",
    version=prompts.PROMPT_VERSION,
    description="Leitura determinística, julgamento com guardrails e memória do cliente.",
)

# CORS restrito. A v1 usava `*` por padrão e sem autenticação nenhuma: qualquer
# pessoa que descobrisse a URL podia queimar a cota de LLM do projeto.
_ORIGENS = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_ORIGENS or ["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["*"],
)

# Abrir a API tem de ser um ATO EXPLÍCITO. `ALLOCATOR_ABERTA=1` libera as rotas
# sem token, e existe apenas para desenvolvimento local - o boot registra em
# ERROR quando está ligado, e /health expõe o estado.
ABERTA_SEM_TOKEN = os.getenv("ALLOCATOR_ABERTA", "").strip() in {"1", "true", "sim"}


async def exigir_token(authorization: str = Header(default="")) -> None:
    """Bearer compartilhado, FAIL-CLOSED.

    Sem `ALLOCATOR_API_TOKEN` configurada, nada é aceito. É o oposto da v1, onde
    a ausência de configuração significava "aberto para o mundo" - e foi assim
    que a API de inferência ficou pública sem ninguém decidir isso. Quem
    descobrisse a URL podia queimar a cota de LLM do projeto.

    A comparação usa `secrets.compare_digest` (em `auth.conferir_token_api`), e
    não `==`: comparação de string sai no primeiro byte diferente, e a diferença
    de tempo permite descobrir o segredo byte a byte.
    """
    from .auth import api_protegida, conferir_token_api

    if ABERTA_SEM_TOKEN:
        return
    if not api_protegida():
        raise HTTPException(
            503,
            "Servidor sem ALLOCATOR_API_TOKEN configurada. Defina a variável "
            "(ver server/.env.example) ou, apenas em desenvolvimento local, "
            "ALLOCATOR_ABERTA=1.",
        )
    if not conferir_token_api(authorization):
        raise HTTPException(401, "Token de API inválido ou ausente.")


@app.on_event("startup")
async def avisar_configuracao() -> None:
    """Registra no boot o que está frouxo, para não passar despercebido."""
    from .auth import api_protegida

    if ABERTA_SEM_TOKEN:
        logger.error("ALLOCATOR_ABERTA=1 - rotas SEM autenticação. Use apenas "
                     "em desenvolvimento local.")
    elif not api_protegida():
        logger.error("ALLOCATOR_API_TOKEN ausente - rotas de serviço vão recusar "
                     "com 503 até a variável ser definida.")
    if not _ORIGENS:
        logger.warning("ALLOWED_ORIGINS vazio - CORS liberado só para localhost.")


# ---------------------------------------------------------------------------
# /health
# ---------------------------------------------------------------------------
@app.get("/health")
async def health() -> dict[str, Any]:
    from .llm import DEPS_LLM_DISPONIVEIS

    provedores: dict[str, Any] = {"deps": DEPS_LLM_DISPONIVEIS}
    if DEPS_LLM_DISPONIVEIS:
        from .llm.router import status as status_llm
        try:
            provedores = await status_llm()
        except Exception as e:  # noqa: BLE001 - health nunca pode falhar
            provedores = {"erro": str(e)[:200]}

    banco = False
    try:
        from .db.conexao import esta_configurado
        banco = esta_configurado()
    except Exception:  # noqa: BLE001
        banco = False

    from .auth import api_protegida

    return {
        "status": "ok",
        "prompt_version": prompts.PROMPT_VERSION,
        "provedores": provedores,
        "banco_configurado": banco,
        "autenticacao": api_protegida(),
        # exposto de propósito: se estiver `true` em produção, é um incidente
        "aberta_sem_token": ABERTA_SEM_TOKEN,
        "max_upload_mb": MAX_UPLOAD_MB,
        # Exposto porque é um limite que RECUSA documento, e o valor efetivo vem
        # de variável de ambiente: o padrão do código pode ser 400 e o `.env` da
        # máquina ainda dizer 120. Sem isto aqui, a única forma de descobrir o
        # valor em uso é ler código-fonte - e o `.env` vence o código-fonte.
        "max_paginas": MAX_PAGINAS,
        "rotas_dados": ROTAS_DADOS_ATIVAS,
    }


@app.get("/usage")
async def usage() -> dict[str, Any]:
    """Consumo e latência por provedor/modelo, desde o boot do processo."""
    return TRACE.resumo()


# ---------------------------------------------------------------------------
# /read - leitura determinística. Job assíncrono.
# ---------------------------------------------------------------------------
# Proxy de host gratuito (Render) mata requisição longa por volta de 100s, e um
# PDF grande com páginas escaneadas pode passar disso. O POST devolve `job_id`
# imediatamente e o portal acompanha o progresso.
JOBS: dict[str, dict[str, Any]] = {}
JOB_TTL_S = 3600
MAX_JOBS_SIMULTANEOS = 4


def _limpar_jobs() -> None:
    corte = time.time() - JOB_TTL_S
    for jid in [j for j, v in JOBS.items() if v["ts"] < corte]:
        JOBS.pop(jid, None)


def _ativos() -> int:
    return sum(1 for v in JOBS.values() if v["status"] == "processando")


async def _executar_leitura(job_id: str, dados: bytes, nome: str) -> None:
    job = JOBS[job_id]

    def progresso(msg: str) -> None:
        job["progresso"] = msg

    try:
        job["resultado"] = await asyncio.to_thread(_ler, dados, nome, progresso)
        job["status"] = "concluido"
    except HTTPException as e:
        job.update(status="erro", codigo=e.status_code, detalhe=e.detail)
    except Exception as e:  # noqa: BLE001 - job nunca morre mudo
        logger.exception("job de leitura falhou")
        job.update(status="erro", codigo=500,
                   detalhe=f"{type(e).__name__}: {str(e)[:300]}")
    finally:
        job.pop("_dados", None)  # libera o arquivo da memória


def _ler(dados: bytes, nome: str, progresso) -> dict[str, Any]:
    """Pipeline de leitura. Roda em thread: pdfplumber é síncrono e pesado."""
    progresso("verificando o arquivo…")
    veredito = avaliar_arquivo(dados, nome)
    if not veredito.admissivel:
        raise HTTPException(415, veredito.motivo)

    tipo = veredito.tipo

    # ---- XLSX: pode ser balancete de ERP -------------------------------
    if tipo and tipo.endswith("spreadsheetml.sheet"):
        progresso("lendo a planilha…")
        tabela = _tabela_do_xlsx(dados)
        bal = ler_balancete(tabela)
        if not bal["eh_balancete"]:
            raise HTTPException(
                422,
                "A planilha não parece um balancete nem uma demonstração: "
                + bal["motivo"]
                + ". Esperado: coluna de código contábil, coluna de descrição e "
                "ao menos uma coluna de saldo.")
        return {
            "fonte": "balancete",
            "admissivel": True,
            "arquivo": veredito.como_dict(),
            "linhas": bal["linhas"],
            "periodos": bal["colunas"],
            "saldosAbsolutos": bal["saldosAbsolutos"],
            "folhas": bal["folhas"],
            "sinteticas": bal["sinteticas"],
            "evidencias": bal["evidencias"],
            "avisos": veredito.avisos,
        }

    # ---- PDF / imagem --------------------------------------------------
    if tipo != "application/pdf":
        # imagem isolada: não há camada de texto, o caminho é visão
        return {
            "fonte": "imagem",
            "admissivel": True,
            "arquivo": veredito.como_dict(),
            "linhas": [],
            "periodos": [],
            "precisaVisao": True,
            "avisos": veredito.avisos + [
                "imagem não tem camada de texto: a leitura exige o modelo de "
                "visão, que só está disponível com o servidor de inferência ligado"],
        }

    progresso("classificando as páginas (sem IA)…")
    from .reading.page_classifier import classificar_documento

    relatorio = classificar_documento(dados)
    if not relatorio.admissivel:
        # GATE CONTÁBIL: nenhum token gasto, nenhum modelo chamado.
        raise HTTPException(422, relatorio.motivo)

    progresso("extraindo as linhas…")
    from .reading.columns import (
        descartar_coluna_codigo, descartar_coluna_nota, detectar_colunas,
        mapear_cabecalho,
    )
    from .reading.demonstracao import (
        PaginaLida, agrupar_continuacoes, montar_demonstracao,
    )
    from .reading.pdf_words import extrair_palavras
    from .reading.periodos import montar_selecao
    from .reading.tables import montar_linhas, nivel_por_indentacao

    demonstracoes: list[dict[str, Any]] = []
    paginas_ignoradas: list[dict[str, Any]] = []
    injecoes: list[str] = []
    paginas_sem_texto: list[int] = []

    # EXTRAÇÃO de todas as páginas admitidas ANTES de interpretar qualquer uma.
    #
    # A ordem importa: a interpretação precisa saber se a página seguinte é
    # CONTINUAÇÃO desta. No DFP padronizado da CVM o Balanço ocupa duas páginas por
    # lado, e a segunda não tem linha de fechamento - interpretada isoladamente ela
    # era descartada como nota explicativa, levando embora 13 linhas de Ativo e 31
    # de Passivo. Ver `agrupar_continuacoes`.
    extraidas: list[PaginaLida] = []
    for classificacao in relatorio.paginas_admissiveis:
        n = classificacao.pagina
        if not relatorio.tem_texto.get(n, False):
            paginas_sem_texto.append(n)
            continue
        progresso(f"extraindo página {n}…")

        # EXTRAÇÃO (precisa de pdfplumber) - daqui para baixo é I/O puro.
        palavras = extrair_palavras(dados, n)
        colunas = detectar_colunas(palavras)
        if colunas:
            # ORDEM: código antes de nota. A coluna de código é a mais à esquerda,
            # e as duas funções só olham a primeira coluna - se a nota rodasse
            # primeiro num formulário da CVM, ela desistiria (o código tem ponto,
            # e ponto parece separador de milhar) e a de código nunca veria a
            # coluna certa.
            colunas = descartar_coluna_codigo(colunas, palavras)
            colunas = descartar_coluna_nota(colunas, palavras)
        rotulos = mapear_cabecalho(palavras, colunas)
        linhas = montar_linhas(palavras, colunas, rotulos)
        nivel_por_indentacao(linhas)
        extraidas.append(PaginaLida(
            pagina=n, tipo=classificacao.tipo, score=classificacao.score,
            rotulos=list(rotulos), linhas=linhas,
        ))

    for pagina_lida in agrupar_continuacoes(extraidas):
        n = pagina_lida.pagina
        rotulos = pagina_lida.rotulos
        linhas = pagina_lida.linhas

        # INTERPRETAÇÃO - em `demonstracao.py`, sem dependência de PDF, e é o
        # MESMO código que o golden dataset do Fleury exercita nos testes.
        #
        # É aqui que mora o SEGUNDO GATE, o que separa demonstração de NOTA
        # EXPLICATIVA. O gate de página aprova qualquer tabela com âncora
        # contábil, colunas alinhadas e subtotal que fecha - e nota explicativa
        # tem as três: no ITR do Fleury, 33 das 50 páginas passaram e o pipeline
        # recebeu 1.222 linhas em vez de 115. O que uma nota NÃO tem é a linha
        # que FECHA a demonstração.
        demonstracao, achados = montar_demonstracao(
            pagina=n,
            tipo=pagina_lida.tipo,
            score=pagina_lida.score,
            rotulos=rotulos,
            linhas=linhas,
            # Camada 3: o rótulo vem do documento e é conteúdo NÃO CONFIÁVEL.
            # Injetado, e não importado lá dentro, para a política de segurança
            # ficar deste lado da fronteira.
            sanitizar=sanitizar_texto_documento,
        )
        injecoes.extend(achados)
        if demonstracao is None:
            paginas_ignoradas.append({
                "pagina": n,
                "tipo": classificacao.tipo,
                "score": classificacao.score,
                "motivo": "não fecha nenhuma demonstração (sem linha de total do "
                          "ativo, total do passivo ou lucro líquido): é nota "
                          "explicativa, índice, parecer ou capa",
            })
            continue
        demonstracoes.append(demonstracao)

    if not demonstracoes:
        # Havia página com cara de demonstração, mas nenhuma FECHA. Recusar é
        # melhor que entregar as notas como se fossem o balanço.
        raise HTTPException(
            422,
            "Encontrei "
            f"{len(paginas_ignoradas)} página(s) com estrutura contábil, mas "
            "nenhuma fecha uma demonstração: não há linha de total do ativo, "
            "total do passivo nem lucro líquido. Parece ser um conjunto de notas "
            "explicativas ou um relatório sem as demonstrações principais. Envie "
            "o documento que contenha o Balanço Patrimonial e a DRE.",
        )

    if injecoes:
        logger.warning("tentativa de injeção no documento: %s", injecoes[:5])

    avisos = list(veredito.avisos)
    if paginas_sem_texto:
        avisos.append(
            f"páginas {paginas_sem_texto} não têm camada de texto (escaneadas) e "
            "precisam do modelo de visão")
    if paginas_ignoradas:
        avisos.append(
            f"{len(paginas_ignoradas)} página(s) tinham estrutura contábil mas não "
            "fecham demonstração (nota explicativa, índice ou parecer) e foram "
            "deixadas de fora")
    if injecoes:
        avisos.append(
            f"{len(injecoes)} trecho(s) com padrão de injeção de prompt foram "
            "neutralizados no texto do documento")
    escalas = {d["escala"]["unidade"] for d in demonstracoes if d["escala"]["unidade"]}
    if not escalas:
        avisos.append(
            "o documento não declara a unidade dos valores (ex.: 'Em milhares de "
            "reais'). Confirme a escala: o balanço fecha igual em qualquer "
            "escala, então um erro aqui não aparece em nenhuma validação")
    elif len(escalas) > 1:
        avisos.append(f"escalas diferentes entre as demonstrações: {sorted(escalas)}")

    # Compatibilidade + padrão que já funciona: o portal recebe as linhas da
    # PRIMEIRA demonstração de cada família, com os valores rechaveados pelo
    # mapeamento proposto. Sem isto a tela abriria vazia esperando escolha; com
    # isto ela abre preenchida e a escolha vira revisão.
    linhas_padrao, periodos_padrao, ids_padrao = montar_selecao(demonstracoes)

    return {
        "fonte": "pdf-texto",
        "admissivel": True,
        "arquivo": veredito.como_dict(),
        "demonstracoes": demonstracoes,
        "selecionadas": ids_padrao,
        "linhas": linhas_padrao,
        "periodos": periodos_padrao,
        "saldosAbsolutos": False,
        "paginas": [
            {
                "pagina": p.pagina, "tipo": p.tipo, "score": p.score,
                "evidencias": p.evidencias, "temTexto": relatorio.tem_texto.get(p.pagina, False),
            }
            for p in relatorio.paginas
        ],
        "paginasIgnoradas": paginas_ignoradas,
        "paginasSemTexto": paginas_sem_texto,
        "injecoesNeutralizadas": injecoes[:20],
        "avisos": avisos,
    }


def _tabela_do_xlsx(dados: bytes) -> list[list[Any]]:
    """Primeira aba visível com conteúdo, como lista de listas."""
    import io

    import openpyxl

    wb = openpyxl.load_workbook(io.BytesIO(dados), data_only=True, read_only=True)
    try:
        melhor: list[list[Any]] = []
        for ws in wb.worksheets:
            if ws.sheet_state != "visible":
                continue
            linhas = [list(r) for r in ws.iter_rows(values_only=True)]
            if len(linhas) > len(melhor):
                melhor = linhas
        return melhor
    finally:
        wb.close()


@app.post("/read", dependencies=[Depends(exigir_token)])
async def read(file: UploadFile = File(...)) -> dict[str, Any]:
    dados = await file.read()
    if len(dados) > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(413, f"Arquivo acima de {MAX_UPLOAD_MB} MB.")

    _limpar_jobs()
    if _ativos() >= MAX_JOBS_SIMULTANEOS:
        raise HTTPException(429, "Muitas leituras em andamento. Tente em instantes.")

    job_id = uuid.uuid4().hex
    JOBS[job_id] = {"status": "processando", "progresso": "na fila…", "ts": time.time()}
    asyncio.create_task(_executar_leitura(job_id, dados, file.filename or ""))
    return {"job_id": job_id, "status": "processando"}


@app.get("/read/{job_id}", dependencies=[Depends(exigir_token)])
async def read_status(job_id: str) -> dict[str, Any]:
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "Job não encontrado (expirou ou a API reiniciou "
                                 " - reenvie o arquivo).")
    if job["status"] == "concluido":
        return {"status": "concluido", "resultado": job["resultado"]}
    if job["status"] == "erro":
        return {"status": "erro", "codigo": job.get("codigo", 500),
                "detalhe": job.get("detalhe", "")}
    return {"status": "processando", "progresso": job.get("progresso", "")}


# ---------------------------------------------------------------------------
# /julgamental
# ---------------------------------------------------------------------------
class EntradaJulgamental(BaseModel):
    linhas: list[dict[str, Any]]
    candidatos: list[dict[str, Any]]


@app.post("/julgamental", dependencies=[Depends(exigir_token)])
async def julgamental(corpo: EntradaJulgamental) -> dict[str, Any]:
    """Mapeia contas desconhecidas. Toda saída passa pelos guardrails.

    `candidatos` chega do portal JÁ restrito ao bloco compatível (~9 a 15 dos 79
    destinos), derivado do 1º dígito do código e da cadeia de contas-pai. É essa
    redução que permite um modelo local de 7B fazer o trabalho.
    """
    if not corpo.linhas:
        return {"sugestoes": [], "descartadas": [], "provedor": None}
    if not corpo.candidatos:
        raise HTTPException(422, "Nenhum candidato de destino informado.")

    from .llm import DEPS_LLM_DISPONIVEIS
    if not DEPS_LLM_DISPONIVEIS:
        raise HTTPException(503, "Camada de LLM indisponível neste servidor. O "
                                "portal continua no modo determinístico.")

    from .llm.ollama import ErroProvedor
    from .llm.router import completar_texto
    from .llm.schemas import RespostaJulgamental, json_schema_de

    sistema, usuario = prompts.montar_prompt_julgamental(corpo.linhas, corpo.candidatos)
    try:
        with TRACE.contexto("julgamental"):
            resposta = await completar_texto(
                usuario, sistema=sistema, formato=json_schema_de(RespostaJulgamental))
    except ErroProvedor as e:
        raise HTTPException(503, str(e)) from e

    import json
    try:
        bruto = json.loads(resposta.texto)
    except json.JSONDecodeError as e:
        # Com JSON Schema no sampling isto não deveria acontecer; se acontecer,
        # é o provedor de nuvem que ignorou o schema.
        raise HTTPException(502, f"Resposta não é JSON válido: {e}") from e

    aceitas, descartadas = validar_sugestoes(
        bruto.get("sugestoes") or [], corpo.linhas, corpo.candidatos)
    TRACE.evento("julgamental.guardrail", aceitas=len(aceitas),
                 descartadas=len(descartadas))
    return {
        "sugestoes": aceitas,
        "descartadas": descartadas,
        "provedor": resposta.provedor,
        "modelo": resposta.modelo,
        "prompt_version": prompts.PROMPT_VERSION,
    }


# ---------------------------------------------------------------------------
# /parecer
# ---------------------------------------------------------------------------
@app.post("/parecer", dependencies=[Depends(exigir_token)])
async def parecer(resumo: dict[str, Any]) -> dict[str, Any]:
    from .llm import DEPS_LLM_DISPONIVEIS
    if not DEPS_LLM_DISPONIVEIS:
        raise HTTPException(503, "Camada de LLM indisponível neste servidor.")

    from .llm.ollama import ErroProvedor
    from .llm.router import completar_texto

    sistema, usuario = prompts.montar_prompt_parecer(resumo)
    try:
        with TRACE.contexto("parecer"):
            resposta = await completar_texto(usuario, sistema=sistema)
    except ErroProvedor as e:
        raise HTTPException(503, str(e)) from e
    return {"parecer": resposta.texto.strip(), "provedor": resposta.provedor,
            "modelo": resposta.modelo}


# ---------------------------------------------------------------------------
# /dados/* - registradas só se a camada de banco estiver disponível
# ---------------------------------------------------------------------------
ROTAS_DADOS_ATIVAS = False
try:
    from .db.rotas import router as router_dados

    app.include_router(router_dados, prefix="/dados")
    ROTAS_DADOS_ATIVAS = True
    logger.info("rotas de dados registradas em /dados")
except ImportError as e:
    # Acontece quando `psycopg`/`bcrypt`/`pyjwt` não estão instalados - o caso da
    # implantação que serve APENAS inferência (o notebook com GPU). Não é erro: a
    # API continua útil, e o portal usa a outra instância para dados.
    logger.warning("rotas de dados indisponíveis (%s) - esta instância serve só "
                   "a inferência", e)
