"""
Rotas HTTP do plano de DADOS. Montadas em `/dados` por `app.main`.

Modelo de segurança, e por que ele mudou em relação à v1:

  v1  o navegador falava DIRETO com o Supabase usando a anon key, e a proteção
      era RLS (`auth.uid() = user_id`). Funciona, mas espalha a fronteira: a
      chave circula em código público, o schema fica acoplado ao provedor de
      auth, e qualquer erro de política vira vazamento.

  v2  a API é a ÚNICA a falar com o banco. Toda consulta recebe `usuario_id`
      extraído do JWT e filtra por ele no `repo`. A fronteira é uma só, está em
      Python e é testável.

Duas camadas de autenticação, de propósito:

  · `Authorization: Bearer <ALLOCATOR_API_TOKEN>` - identifica a APLICAÇÃO.
    Impede que quem descobrir a URL consuma o servidor. Fail-closed.
  · `X-Sessao: <JWT>` - identifica o USUÁRIO. Define de quem são os dados.

Separar as duas evita o erro comum de usar o token de serviço como se fosse
sessão: o token é o mesmo para todos os analistas, o JWT não.
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field

from .. import auth
from . import memoria as mem
from . import repo

logger = logging.getLogger(__name__)
router = APIRouter(tags=["dados"])


# ---------------------------------------------------------------------------
# Dependências
# ---------------------------------------------------------------------------
async def usuario_atual(x_sessao: str = Header(default="")) -> dict[str, Any]:
    """Valida o JWT e devolve as claims. 401 quando ausente ou inválido."""
    if not x_sessao:
        raise HTTPException(401, "Sessão ausente. Faça login novamente.")
    try:
        return auth.validar_token(x_sessao)
    except auth.ErroAuth as e:
        raise HTTPException(401, str(e)) from e


def _id_do_usuario(claims: dict[str, Any]) -> str:
    uid = claims.get("sub") or claims.get("usuario_id")
    if not uid:
        raise HTTPException(401, "Sessão sem identificação de usuário.")
    return str(uid)


def _erro_de_banco(e: Exception) -> HTTPException:
    """Traduz falha de banco em mensagem acionável, sem vazar detalhe interno."""
    logger.exception("falha no banco")
    return HTTPException(
        503,
        "Banco de dados indisponível. Se o servidor acabou de subir, o Neon pode "
        "estar acordando (leva ~1s) - tente de novo. Se persistir, confira "
        "DATABASE_URL.",
    )


# ---------------------------------------------------------------------------
# Autenticação
# ---------------------------------------------------------------------------
class Credenciais(BaseModel):
    email: str = Field(min_length=3, max_length=200)
    senha: str = Field(min_length=8, max_length=200)
    nome: str = ""


@router.post("/auth/login")
async def login(corpo: Credenciais) -> dict[str, Any]:
    try:
        usuario = repo.buscar_usuario_por_email(corpo.email)
    except Exception as e:  # noqa: BLE001
        raise _erro_de_banco(e) from e

    # Mensagem IDÊNTICA para e-mail inexistente e senha errada: distinguir os
    # dois casos entrega ao atacante a lista de e-mails cadastrados.
    if not usuario or not auth.verificar_senha(corpo.senha, usuario["senha_hash"]):
        raise HTTPException(401, "E-mail ou senha inválidos.")

    repo.registrar_acesso(usuario["id"])
    return {
        "token": auth.criar_token(str(usuario["id"]), usuario["email"]),
        "usuario": {"id": str(usuario["id"]), "email": usuario["email"],
                    "nome": usuario.get("nome") or ""},
    }


@router.post("/auth/registrar")
async def registrar(corpo: Credenciais) -> dict[str, Any]:
    """Cria usuário. Exposto porque a equipe se cadastra sozinha até a banca.

    Em produção real isto seria convite ou provisionamento - a nota fica aqui de
    propósito, para a decisão ser visível em vez de esquecida.
    """
    try:
        if repo.buscar_usuario_por_email(corpo.email):
            raise HTTPException(409, "Já existe conta com este e-mail.")
        usuario = repo.criar_usuario(
            corpo.email, auth.hash_senha(corpo.senha), corpo.nome)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise _erro_de_banco(e) from e
    return {
        "token": auth.criar_token(str(usuario["id"]), usuario["email"]),
        "usuario": {"id": str(usuario["id"]), "email": usuario["email"],
                    "nome": usuario.get("nome") or ""},
    }


@router.get("/auth/eu")
async def eu(claims: dict[str, Any] = Depends(usuario_atual)) -> dict[str, Any]:
    return {"id": _id_do_usuario(claims), "email": claims.get("email", "")}


# ---------------------------------------------------------------------------
# Clientes
# ---------------------------------------------------------------------------
class ClienteIn(BaseModel):
    id: str | None = None
    nome: str = Field(min_length=1, max_length=200)
    cnpj: str = ""
    grupo: str = ""
    setor: str = ""


@router.get("/clientes")
async def get_clientes(claims: dict = Depends(usuario_atual)) -> list[dict]:
    try:
        return repo.listar_clientes(_id_do_usuario(claims))
    except Exception as e:  # noqa: BLE001
        raise _erro_de_banco(e) from e


@router.post("/clientes")
async def post_cliente(corpo: ClienteIn,
                       claims: dict = Depends(usuario_atual)) -> dict:
    try:
        return repo.upsert_cliente(_id_do_usuario(claims), corpo.model_dump())
    except Exception as e:  # noqa: BLE001
        raise _erro_de_banco(e) from e


@router.delete("/clientes/{cliente_id}")
async def delete_cliente(cliente_id: str,
                         claims: dict = Depends(usuario_atual)) -> dict:
    try:
        repo.apagar_cliente(_id_do_usuario(claims), cliente_id)
    except repo.NaoEncontrado as e:
        raise HTTPException(404, str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise _erro_de_banco(e) from e
    return {"ok": True}


# ---------------------------------------------------------------------------
# Análises
# ---------------------------------------------------------------------------
class AnaliseIn(BaseModel):
    id: str | None = None
    cliente_id: str | None = None
    empresa: str = ""
    cnpj: str = ""
    grupo: str = ""
    status: str = "rascunho"
    unidade: str = "Mil"
    moeda: str = "BRL"
    saldos_absolutos: bool = False
    periodos: list[Any] = Field(default_factory=list)
    linhas: list[Any] = Field(default_factory=list)
    qa: dict[str, Any] | None = None
    trilha: dict[str, Any] | None = None
    balanco_fechado: bool = False
    conciliado: bool = False


@router.get("/analises")
async def get_analises(claims: dict = Depends(usuario_atual)) -> list[dict]:
    """Lista sem os jsonb pesados (`linhas`, `qa`, `trilha`).

    Uma análise de balancete tem centenas de linhas; trazê-las na listagem
    transformaria a tela inicial em megabytes de tráfego a cada abertura.
    """
    try:
        return repo.listar_analises(_id_do_usuario(claims))
    except Exception as e:  # noqa: BLE001
        raise _erro_de_banco(e) from e


@router.get("/analises/{analise_id}")
async def get_analise(analise_id: str,
                      claims: dict = Depends(usuario_atual)) -> dict:
    try:
        analise = repo.obter_analise(_id_do_usuario(claims), analise_id)
    except Exception as e:  # noqa: BLE001
        raise _erro_de_banco(e) from e
    if not analise:
        raise HTTPException(404, "Análise não encontrada.")
    return analise


@router.post("/analises")
async def post_analise(corpo: AnaliseIn,
                       claims: dict = Depends(usuario_atual)) -> dict:
    uid = _id_do_usuario(claims)
    try:
        salva = repo.salvar_analise(uid, corpo.model_dump())
        repo.registrar_evento(uid, "analise.salva", {
            "analise_id": str(salva.get("id")),
            "n_linhas": len(corpo.linhas),
            "balanco_fechado": corpo.balanco_fechado,
            "conciliado": corpo.conciliado,
        })
    except Exception as e:  # noqa: BLE001
        raise _erro_de_banco(e) from e
    return salva


@router.delete("/analises/{analise_id}")
async def delete_analise(analise_id: str,
                         claims: dict = Depends(usuario_atual)) -> dict:
    try:
        repo.apagar_analise(_id_do_usuario(claims), analise_id)
    except repo.NaoEncontrado as e:
        raise HTTPException(404, str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise _erro_de_banco(e) from e
    return {"ok": True}


# ---------------------------------------------------------------------------
# Memória do cliente - decisões positivas E negativas, versionada
# ---------------------------------------------------------------------------
class EntradaIn(BaseModel):
    origem: str
    destino: str = ""
    grupo: str = ""
    subCategoria: str = ""
    decisao: str = "alocar"
    confirmadoPorHumano: bool = False


class SalvarMemoriaIn(BaseModel):
    cliente_id: str
    entradas: list[EntradaIn]
    analise_id: str | None = None
    observacao: str = ""
    promover_ao_dicionario: bool = False


@router.get("/memoria/{cliente_id}")
async def get_memoria(cliente_id: str,
                      claims: dict = Depends(usuario_atual)) -> dict:
    """Última revisão da memória do cliente."""
    _id_do_usuario(claims)
    try:
        entradas = mem.carregar_memoria(cliente_id)
    except Exception as e:  # noqa: BLE001
        raise _erro_de_banco(e) from e
    return {"entradas": [e.para_dict() for e in entradas], "total": len(entradas)}


@router.post("/memoria/diff")
async def post_diff(corpo: SalvarMemoriaIn,
                    claims: dict = Depends(usuario_atual)) -> dict:
    """Calcula o diff SEM gravar.

    É o que alimenta o painel de confirmação do portal, que mostra ao analista o
    que vai mudar ANTES de decidir. A memória é opt-in: nada é aprendido às
    escondidas - ao contrário da v1, onde um trigger aprendia de tudo que era
    salvo e um erro de julgamento entrava no dicionário para sempre.
    """
    _id_do_usuario(claims)
    try:
        anterior = mem.carregar_memoria(corpo.cliente_id)
    except Exception as e:  # noqa: BLE001
        raise _erro_de_banco(e) from e
    nova = [mem.EntradaMemoria.de_dict(e.model_dump()) for e in corpo.entradas]
    return mem.diff_memoria(anterior, nova).resumo()


@router.post("/memoria")
async def post_memoria(corpo: SalvarMemoriaIn,
                       claims: dict = Depends(usuario_atual)) -> dict:
    """Grava uma REVISÃO nova. Nada é sobrescrito - auditável e reversível."""
    uid = _id_do_usuario(claims)
    nova = [mem.EntradaMemoria.de_dict(e.model_dump()) for e in corpo.entradas]
    try:
        resultado = mem.salvar_revisao(
            uid, corpo.cliente_id, nova,
            analise_id=corpo.analise_id, observacao=corpo.observacao)
        promovidas = 0
        if corpo.promover_ao_dicionario:
            # Só sobe o que o humano CONFIRMOU e que é decisão de alocar.
            promovidas = mem.promover_ao_dicionario(uid, nova).get("promovidas", 0)
        repo.registrar_evento(uid, "memoria.revisao", {
            "cliente_id": corpo.cliente_id,
            "revisao": resultado.get("revisao"),
            "promovidas_ao_dicionario": promovidas,
        })
    except Exception as e:  # noqa: BLE001
        raise _erro_de_banco(e) from e
    return {**resultado, "promovidas_ao_dicionario": promovidas}


# ---------------------------------------------------------------------------
# Dicionário global (por usuário)
# ---------------------------------------------------------------------------
@router.get("/dicionario")
async def get_dicionario(claims: dict = Depends(usuario_atual)) -> list[dict]:
    try:
        return repo.listar_dicionario(_id_do_usuario(claims))
    except Exception as e:  # noqa: BLE001
        raise _erro_de_banco(e) from e


@router.post("/dicionario")
async def post_dicionario(entradas: list[EntradaIn],
                          claims: dict = Depends(usuario_atual)) -> dict:
    """Regras manuais. Só aceita decisão de alocar com destino preenchido."""
    uid = _id_do_usuario(claims)
    validas = [e.model_dump() for e in entradas
               if e.decisao == "alocar" and e.destino.strip()]
    if not validas:
        raise HTTPException(422, "Nenhuma regra válida: é preciso decisão "
                                 "'alocar' e destino preenchido.")
    try:
        n = repo.upsert_dicionario(uid, validas)
    except Exception as e:  # noqa: BLE001
        raise _erro_de_banco(e) from e
    return {"gravadas": n}
