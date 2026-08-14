"""Cliente do Ollama local - provedor primário da camada de LLM.

Por que local primeiro: o julgamento é feito sobre um conjunto de candidatos já
reduzido pelo motor determinístico (~9 a 15 destinos em vez de 79), então a tarefa
cabe folgadamente em um modelo pequeno. Isso mantém dado contábil de cliente
dentro da máquina e derruba o custo por documento a zero.

Hardware alvo: RTX 4050 com 6 GB de VRAM. Todo modelo da escada (ver `router.py`)
foi escolhido para caber ou fazer offload parcial aceitável nesse orçamento.
"""

from __future__ import annotations

import base64
import logging
import os
import time
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

logger = logging.getLogger(__name__)


def httpx_lazy():
    """Importa `httpx` só na hora de fazer a chamada.

    Sem isto, importar `app.llm` para usar os GUARDRAILS - que são lógica pura de
    segurança e a parte mais crítica de testar - exigiria as libs de rede, que só
    existem no notebook servidor (ver docs/09-runbook-notebook.md). A fronteira
    certa é: lógica pura sempre importável; I/O só quando usado.
    """
    import httpx  # noqa: PLC0415
    return httpx


URL_PADRAO = "http://127.0.0.1:11434"
# 8192 é o teto prático para 6 GB de VRAM sem estourar o KV cache com o modelo 7B.
NUM_CTX_PADRAO = 8192
TIMEOUT_PADRAO = 120.0
# Sonda de disponibilidade tem de ser barata: se o Ollama não está de pé, quero
# saber em 2s e cair para a nuvem, não travar a requisição do usuário.
TIMEOUT_SONDA = 2.0


class ErroProvedor(RuntimeError):
    """Falha de um provedor de LLM (rede, HTTP, resposta inutilizável).

    Existe para que o roteador tenha UM tipo de exceção para decidir fallback,
    sem precisar conhecer httpx nem o formato de erro de cada API.
    """

    def __init__(self, mensagem: str, *, provedor: str = "desconhecido", modelo: str = "") -> None:
        super().__init__(mensagem)
        self.provedor = provedor
        self.modelo = modelo


@dataclass
class RespostaLLM:
    """Resposta normalizada de qualquer provedor.

    Tokens e duração não são enfeite: são o dado que `obs/trace.py` agrega para
    justificar a escolha de modelo com números (latência p50/p95, custo).
    """

    texto: str
    modelo: str
    provedor: str
    tokens_entrada: int = 0
    tokens_saida: int = 0
    duracao_ms: float = 0.0


def para_base64(imagem: bytes | bytearray | str) -> str:
    """Normaliza imagem para base64 ASCII (aceita bytes ou base64 já pronto)."""
    if isinstance(imagem, (bytes, bytearray)):
        return base64.b64encode(bytes(imagem)).decode("ascii")
    return str(imagem)


class ClienteOllama:
    """Cliente HTTP fino do Ollama. Sem estado além da configuração."""

    def __init__(self, base_url: str | None = None, timeout: float = TIMEOUT_PADRAO) -> None:
        self.base_url = (base_url or os.getenv("OLLAMA_URL") or URL_PADRAO).rstrip("/")
        self.timeout = timeout

    # ------------------------------------------------------------------ interno
    async def _requisitar(
        self,
        metodo: str,
        rota: str,
        *,
        corpo: Mapping[str, Any] | None = None,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Faz a chamada e traduz QUALQUER falha em `ErroProvedor`.

        Um erro de rede e um HTTP 500 são a mesma coisa para o roteador: "este
        modelo não serviu, tente o próximo".
        """
        url = f"{self.base_url}{rota}"
        httpx = httpx_lazy()
        async with httpx.AsyncClient(timeout=timeout or self.timeout) as cliente:
            try:
                resposta = await cliente.request(metodo, url, json=dict(corpo) if corpo else None)
                resposta.raise_for_status()
                return resposta.json()
            except httpx.HTTPStatusError as exc:
                detalhe = exc.response.text[:300].replace("\n", " ")
                raise ErroProvedor(
                    f"ollama {rota} devolveu HTTP {exc.response.status_code}: {detalhe}", provedor="ollama"
                ) from exc
            except httpx.HTTPError as exc:
                raise ErroProvedor(f"ollama {rota} inacessível ({type(exc).__name__}: {exc})", provedor="ollama") from exc
            except ValueError as exc:  # corpo não-JSON
                raise ErroProvedor(f"ollama {rota} devolveu corpo não-JSON: {exc}", provedor="ollama") from exc

    # -------------------------------------------------------------------- chat
    async def chat(
        self,
        modelo: str,
        mensagens: Sequence[Mapping[str, Any]],
        *,
        formato: str | Mapping[str, Any] | None = None,
        temperatura: float = 0.0,
        num_ctx: int = NUM_CTX_PADRAO,
        imagens: Sequence[bytes | bytearray | str] | None = None,
    ) -> RespostaLLM:
        """POST /api/chat com `stream: false`.

        `formato` vai para o campo `format`: aceita "json" (JSON livre) ou um dict
        de JSON Schema (que o Ollama transforma em gramática GBNF e aplica no
        sampling - ver `schemas.json_schema_de`).

        `temperatura=0.0` porque isto é classificação, não redação: queremos a
        mesma entrada produzindo a mesma saída, sempre. Reprodutibilidade é
        requisito de auditoria contábil.
        """
        msgs: list[dict[str, Any]] = [dict(m) for m in mensagens]
        if imagens:
            # O Ollama espera as imagens na mensagem do usuário, em base64.
            alvo = next((m for m in reversed(msgs) if m.get("role") == "user"), None)
            if alvo is None:
                alvo = {"role": "user", "content": ""}
                msgs.append(alvo)
            alvo["images"] = [para_base64(img) for img in imagens]

        corpo: dict[str, Any] = {
            "model": modelo,
            "messages": msgs,
            "stream": False,
            "options": {"temperature": temperatura, "num_ctx": num_ctx},
        }
        if formato is not None:
            corpo["format"] = formato if isinstance(formato, str) else dict(formato)

        inicio = time.perf_counter()
        dados = await self._requisitar("POST", "/api/chat", corpo=corpo)
        duracao_ms = round((time.perf_counter() - inicio) * 1000, 2)

        # Truncamento NUNCA pode virar sucesso silencioso: um JSON cortado ao meio
        # com gramática ativa até "parece" válido em parte, e uma sugestão perdida
        # no meio do caminho é pior que um erro - vira conta não alocada sem aviso.
        if dados.get("done_reason") == "length":
            raise ErroProvedor(
                f"resposta truncada por limite de tokens (done_reason=length, num_ctx={num_ctx})",
                provedor="ollama",
                modelo=modelo,
            )

        texto = str((dados.get("message") or {}).get("content") or "")
        if not texto.strip():
            raise ErroProvedor("ollama devolveu conteúdo vazio", provedor="ollama", modelo=modelo)

        return RespostaLLM(
            texto=texto,
            modelo=str(dados.get("model") or modelo),
            provedor="ollama",
            tokens_entrada=int(dados.get("prompt_eval_count") or 0),
            tokens_saida=int(dados.get("eval_count") or 0),
            duracao_ms=duracao_ms,
        )

    # -------------------------------------------------------------- embeddings
    async def embeddings(self, modelo: str, textos: Sequence[str]) -> list[list[float]]:
        """POST /api/embed. Usado no pré-filtro determinístico, não no julgamento."""
        dados = await self._requisitar("POST", "/api/embed", corpo={"model": modelo, "input": list(textos)})
        vetores = dados.get("embeddings")
        if not isinstance(vetores, list) or not vetores:
            raise ErroProvedor(f"ollama /api/embed não devolveu embeddings para {modelo}", provedor="ollama", modelo=modelo)
        return [[float(x) for x in vetor] for vetor in vetores]

    # ------------------------------------------------------------------ status
    async def modelos_disponiveis(self) -> list[str]:
        """GET /api/tags - o que está REALMENTE instalado nesta máquina."""
        dados = await self._requisitar("GET", "/api/tags", timeout=TIMEOUT_SONDA * 5)
        modelos = dados.get("models") or []
        return [str(m.get("name") or m.get("model") or "") for m in modelos if (m.get("name") or m.get("model"))]

    async def esta_disponivel(self) -> bool:
        """Sonda barata: o daemon do Ollama respondeu em `TIMEOUT_SONDA`?"""
        try:
            await self._requisitar("GET", "/api/tags", timeout=TIMEOUT_SONDA)
            return True
        except ErroProvedor as exc:
            logger.debug("ollama indisponível: %s", exc)
            return False


__all__ = ["ClienteOllama", "ErroProvedor", "RespostaLLM", "para_base64", "URL_PADRAO"]
