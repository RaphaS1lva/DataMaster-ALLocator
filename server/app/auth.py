"""Autenticação própria: bcrypt para senha, JWT para sessão, bearer para máquina.

POR QUE SAIMOS DO AUTH DO PROVEDOR
----------------------------------
O v1 usava o serviço de autenticação do Supabase junto com o banco. Duas dores:
o projeto gratuito era pausado após 7 dias de inatividade (e voltar exigia
restore manual no console, com o portal fora do ar até alguém perceber), e a
autorização ficava amarrada a funções de sessão daquele provedor, o que travava
o banco lá. Aqui a API valida credencial por conta própria; o Postgres do Neon é
só armazenamento.

E O PIOR PROBLEMA DO v1: A API NÃO TINHA AUTENTICAÇÃO NENHUMA
-------------------------------------------------------------
O servidor de inferência subia com `ALLOWED_ORIGINS=*` e nenhuma verificação de
credencial. Qualquer pessoa que descobrisse a URL podia disparar chamadas de LLM
à vontade - queimar a cota paga, e de graça usar o classificador contábil que é
o núcleo do produto. Não havia sequer como saber que estava acontecendo, porque
sem identidade não há atribuição.

Duas credenciais resolvem os dois casos de uso, e são deliberadamente
diferentes:

  · JWT por USUÁRIO (`criar_token`/`validar_token`) - sessão de pessoa. Carrega
    `sub` = usuario_id, que é o que `app/db/repo.py` usa em todo WHERE. É a
    única fonte de identidade: o cliente não escolhe por quem responde.
  · BEARER de SERVIÇO (`TOKEN_API`) - segredo compartilhado para o portal
    chamar as rotas de inferência. Não identifica pessoa e não dá acesso a
    dado de ninguém; só prova "esta chamada vem do nosso portal".

Imports de `bcrypt` e `PyJWT` são LAZY, dentro das funções: a máquina de
desenvolvimento está atrás de proxy que bloqueia o PyPI, e este módulo precisa
ser importável lá para que o resto da suíte de testes rode. Mesmo padrão de
`app/db/conexao.py` com o psycopg.
"""

from __future__ import annotations

import hashlib
import logging
import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

logger = logging.getLogger(__name__)

VAR_SEGREDO = "JWT_SECRET"
VAR_TOKEN_API = "ALLOCATOR_API_TOKEN"
VAR_AMBIENTE = "ALLOCATOR_AMBIENTE"

ALGORITMO = "HS256"
HORAS_PADRAO = 12

#: Ambientes onde a ausência de `JWT_SECRET` é tolerada (com aviso alto).
AMBIENTES_DEV: frozenset[str] = frozenset({"dev", "local", "teste", "test"})

#: Bearer compartilhado com o portal para as rotas de inferência.
#: Lido no import para aparecer em diagnóstico de boot; use `token_api()` no
#: caminho de verificação, que relê o ambiente (testes e recarga de .env).
TOKEN_API: str = os.getenv(VAR_TOKEN_API, "")


class ErroAuth(RuntimeError):
    """Configuração ausente, dependência faltando ou token inválido."""


# ----------------------------------------------------------------------- senha
def hash_senha(senha: str) -> str:
    """Hash bcrypt da senha, pronto para `usuarios.senha_hash`.

    bcrypt e não SHA: hash de senha tem de ser LENTO de propósito. SHA-256 faz
    bilhões de tentativas por segundo em GPU; bcrypt com custo padrão faz
    algumas dezenas. O salt vai embutido no resultado, então não há coluna
    separada para esquecer de preencher.

    O truncamento em 72 bytes é explícito porque o bcrypt IGNORA o que passa
    disso. Deixar implícito significa que uma frase-senha longa teria os
    caracteres finais descartados sem ninguém saber - duas senhas diferentes
    validando a mesma conta.
    """
    bcrypt = _bcrypt()
    if not senha:
        raise ErroAuth("senha vazia")
    bruto = senha.encode("utf-8")[:72]
    return bcrypt.hashpw(bruto, bcrypt.gensalt()).decode("ascii")


def verificar_senha(senha: str, hash_armazenado: str) -> bool:
    """Confere senha contra o hash. Nunca levanta por hash malformado.

    Hash corrompido no banco devolve False e vira log de erro: transformar isso
    em exceção daria ao atacante um oráculo (resposta diferente distingue
    "usuário existe com hash estranho" de "usuário não existe").
    """
    if not senha or not hash_armazenado:
        return False
    bcrypt = _bcrypt()
    try:
        return bcrypt.checkpw(
            senha.encode("utf-8")[:72], hash_armazenado.encode("utf-8")
        )
    except (ValueError, TypeError):
        logger.error("hash de senha malformado no banco")
        return False


def _bcrypt() -> Any:
    try:
        import bcrypt
    except ModuleNotFoundError as erro:  # pragma: no cover - depende do ambiente
        raise ErroAuth(
            "bcrypt não instalado. pip install -r server/requirements.txt "
            "(bcrypt==5.0.0)"
        ) from erro
    return bcrypt


# ------------------------------------------------------------------------ JWT
def _segredo() -> str:
    """Segredo de assinatura do JWT.

    Sem `JWT_SECRET` em produção é ERRO, não aviso: um segredo gerado
    aleatoriamente no boot pareceria funcionar - até o processo reiniciar e
    invalidar todas as sessões, ou até subir uma segunda instância que rejeita
    os tokens da primeira. Falha intermitente de login é caríssima de
    diagnosticar; falha no boot, com mensagem clara, custa um minuto.
    """
    segredo = os.getenv(VAR_SEGREDO, "").strip()
    if segredo:
        return segredo
    ambiente = os.getenv(VAR_AMBIENTE, "producao").strip().lower()
    if ambiente not in AMBIENTES_DEV:
        raise ErroAuth(
            f"{VAR_SEGREDO} não definida. Gere um segredo com "
            "`python -c \"import secrets;print(secrets.token_urlsafe(48))\"` e "
            f"exporte-o. Para rodar sem isso em desenvolvimento, defina "
            f"{VAR_AMBIENTE}=dev (os tokens não sobrevivem a um restart)."
        )
    # Derivado do nome da máquina + ambiente: estável dentro da mesma sessão de
    # desenvolvimento, e obviamente inútil como segredo de produção.
    logger.warning(
        "%s ausente e %s=%s: usando segredo derivado, NÃO use em produção",
        VAR_SEGREDO, VAR_AMBIENTE, ambiente,
    )
    # COMPUTERNAME no Windows, HOSTNAME no Linux: o notebook servidor e a
    # máquina de desenvolvimento não são o mesmo sistema operacional.
    maquina = os.getenv("COMPUTERNAME") or os.getenv("HOSTNAME") or "local"
    semente = f"allocator-dev::{ambiente}::{maquina}"
    return hashlib.sha256(semente.encode("utf-8")).hexdigest()


def _pyjwt() -> Any:
    try:
        import jwt
    except ModuleNotFoundError as erro:  # pragma: no cover - depende do ambiente
        raise ErroAuth(
            "PyJWT não instalado. pip install -r server/requirements.txt "
            "(pyjwt==2.13.0)"
        ) from erro
    return jwt


def criar_token(usuario_id: str, email: str, *, horas: int = HORAS_PADRAO) -> str:
    """JWT de sessão. `sub` = usuario_id - a identidade que o repo usa no WHERE.

    12 horas por padrão: cobre um dia de trabalho sem obrigar novo login no meio
    de uma análise, e expira antes de o notebook ir para casa. Sem `exp` o token
    valeria para sempre, e um vazamento de log seria permanente.
    """
    jwt = _pyjwt()
    agora = datetime.now(timezone.utc)
    payload = {
        "sub": str(usuario_id),
        "email": email,
        "iat": agora,
        "exp": agora + timedelta(hours=max(1, int(horas))),
    }
    return jwt.encode(payload, _segredo(), algorithm=ALGORITMO)


def validar_token(token: str) -> dict[str, Any]:
    """Valida assinatura e expiração e devolve as claims.

    `algorithms=[ALGORITMO]` é uma LISTA FECHADA de propósito: aceitar o
    algoritmo declarado no header do próprio token é a vulnerabilidade clássica
    de JWT (`alg: none`, ou trocar HS por RS para forjar assinatura). Quem manda
    é o servidor.

    Levanta `ErroAuth` em qualquer falha, com mensagem genérica: distinguir
    "expirado" de "assinatura inválida" para o cliente é informação de graça
    para quem está tentando forjar.
    """
    jwt = _pyjwt()
    limpo = _sem_bearer(token)
    if not limpo:
        raise ErroAuth("token ausente")
    try:
        claims = jwt.decode(limpo, _segredo(), algorithms=[ALGORITMO])
    except Exception as erro:  # PyJWT tem várias subclasses; todas são 401
        logger.info("token rejeitado: %s", type(erro).__name__)
        raise ErroAuth("token inválido ou expirado") from erro
    if not claims.get("sub"):
        raise ErroAuth("token sem sujeito (sub)")
    return claims


def _sem_bearer(valor: str | None) -> str:
    """Aceita tanto `Authorization: Bearer x` quanto o token cru."""
    texto = (valor or "").strip()
    if texto[:7].lower() == "bearer ":
        return texto[7:].strip()
    return texto


# ------------------------------------------------------- bearer de serviço
def token_api() -> str:
    """Token de serviço vigente. Relê o ambiente para funcionar após recarga."""
    return os.getenv(VAR_TOKEN_API, TOKEN_API) or ""


def api_protegida() -> bool:
    """Há token de serviço configurado? Rota de diagnóstico/boot usa isto."""
    return bool(token_api())


def conferir_token_api(recebido: str | None) -> bool:
    """Compara o bearer recebido com `ALLOCATOR_API_TOKEN`.

    FAIL-CLOSED: sem token configurado, NADA é aceito. É o oposto do v1, onde a
    ausência de configuração significava "aberto para o mundo" - e foi assim que
    a API de inferência ficou pública sem ninguém decidir isso. Abrir uma porta
    deve exigir um ato explícito; fechá-la, não.

    `secrets.compare_digest` e não `==`: comparação de string sai no primeiro
    byte diferente, e a diferença de tempo permite descobrir o segredo byte a
    byte.
    """
    esperado = token_api()
    if not esperado:
        logger.error(
            "%s não configurada: rotas de serviço recusadas. Defina a variável "
            "para liberar o portal.", VAR_TOKEN_API,
        )
        return False
    return secrets.compare_digest(_sem_bearer(recebido), esperado)
