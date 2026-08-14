"""Fallback de nuvem: usado APENAS quando o Ollama local não responde.

Ordem de preferência do projeto (ver `router.py`): Ollama -> Gemini -> Groq.
A nuvem existe para o dia em que o notebook está sem o daemon subido ou sem o
modelo baixado - não é o caminho normal. Dado contábil de cliente sai da máquina
somente nesse cenário, e de forma explícita (exige chave de API configurada).

Ausência de chave é `ErroProvedor`, não crash: rodar sem chave é a configuração
esperada de quem só usa local, e o roteador precisa apenas saber que essa perna
da cascata não está disponível.
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any, Mapping, Sequence

from .ollama import ErroProvedor, RespostaLLM, httpx_lazy, para_base64

logger = logging.getLogger(__name__)

URL_GEMINI = "https://generativelanguage.googleapis.com/v1beta/models/{modelo}:generateContent"
URL_GROQ = "https://api.groq.com/openai/v1/chat/completions"

MODELO_GEMINI_PADRAO = "gemini-2.5-flash"
MODELO_GROQ_PADRAO = "llama-3.3-70b-versatile"

# O free tier do Groq limita TOKENS POR MINUTO, não só requisições. Pedir um
# `max_tokens` alto queima a cota do minuto inteiro em uma chamada só; 4096 cobre
# um lote de sugestões com folga e mantém o rate limit administrável.
MAX_TOKENS_GROQ = 4096
TIMEOUT_NUVEM = 90.0


async def _postar(
    url: str,
    corpo: Mapping[str, Any],
    cabecalhos: Mapping[str, str],
    *,
    provedor: str,
    modelo: str,
    timeout: float,
) -> tuple[dict[str, Any], float]:
    """POST JSON traduzindo qualquer falha em `ErroProvedor`."""
    inicio = time.perf_counter()
    httpx = httpx_lazy()
    async with httpx.AsyncClient(timeout=timeout) as cliente:
        try:
            resposta = await cliente.post(url, json=dict(corpo), headers=dict(cabecalhos))
            resposta.raise_for_status()
            dados = resposta.json()
        except httpx.HTTPStatusError as exc:
            detalhe = exc.response.text[:300].replace("\n", " ")
            raise ErroProvedor(
                f"{provedor} devolveu HTTP {exc.response.status_code}: {detalhe}", provedor=provedor, modelo=modelo
            ) from exc
        except httpx.HTTPError as exc:
            raise ErroProvedor(f"{provedor} inacessível ({type(exc).__name__}: {exc})", provedor=provedor, modelo=modelo) from exc
        except ValueError as exc:
            raise ErroProvedor(f"{provedor} devolveu corpo não-JSON: {exc}", provedor=provedor, modelo=modelo) from exc
    return dados, round((time.perf_counter() - inicio) * 1000, 2)


def _chave(nome_env: str, provedor: str) -> str:
    chave = (os.getenv(nome_env) or "").strip()
    if not chave:
        raise ErroProvedor(
            f"{nome_env} não configurada - fallback {provedor} indisponível (rodando somente local)",
            provedor=provedor,
        )
    return chave


async def gemini(
    prompt: str,
    *,
    json_mode: bool = False,
    imagens: Sequence[bytes | bytearray | str] | None = None,
    sistema: str | None = None,
    timeout: float = TIMEOUT_NUVEM,
) -> RespostaLLM:
    """Gemini via `generateContent`.

    É o primeiro fallback porque tem visão nativa (necessária para balancete em
    imagem/PDF escaneado) e `responseMimeType: application/json`, que é o
    equivalente mais próximo da gramática do Ollama.
    """
    chave = _chave("GEMINI_API_KEY", "gemini")
    modelo = os.getenv("GEMINI_MODEL", MODELO_GEMINI_PADRAO)

    partes: list[dict[str, Any]] = [{"text": prompt}]
    for imagem in imagens or ():
        partes.append({"inline_data": {"mime_type": "image/png", "data": para_base64(imagem)}})

    corpo: dict[str, Any] = {
        "contents": [{"role": "user", "parts": partes}],
        "generationConfig": {
            "temperature": 0.0,
            "responseMimeType": "application/json" if json_mode else "text/plain",
        },
    }
    if sistema:
        corpo["systemInstruction"] = {"parts": [{"text": sistema}]}

    dados, duracao_ms = await _postar(
        URL_GEMINI.format(modelo=modelo),
        corpo,
        {"x-goog-api-key": chave, "content-type": "application/json"},
        provedor="gemini",
        modelo=modelo,
        timeout=timeout,
    )

    bloqueio = (dados.get("promptFeedback") or {}).get("blockReason")
    if bloqueio:
        raise ErroProvedor(f"gemini bloqueou o prompt (blockReason={bloqueio})", provedor="gemini", modelo=modelo)

    candidato = (dados.get("candidates") or [{}])[0]
    # Mesmo critério do local: truncado é erro, não resultado parcial aceitável.
    if candidato.get("finishReason") == "MAX_TOKENS":
        raise ErroProvedor("resposta truncada (finishReason=MAX_TOKENS)", provedor="gemini", modelo=modelo)

    texto = "".join(str(p.get("text") or "") for p in ((candidato.get("content") or {}).get("parts") or []))
    if not texto.strip():
        raise ErroProvedor(
            f"gemini devolveu conteúdo vazio (finishReason={candidato.get('finishReason')})",
            provedor="gemini",
            modelo=modelo,
        )

    uso = dados.get("usageMetadata") or {}
    return RespostaLLM(
        texto=texto,
        modelo=modelo,
        provedor="gemini",
        tokens_entrada=int(uso.get("promptTokenCount") or 0),
        tokens_saida=int(uso.get("candidatesTokenCount") or 0),
        duracao_ms=duracao_ms,
    )


async def groq(
    prompt: str,
    *,
    json_mode: bool = False,
    sistema: str | None = None,
    timeout: float = TIMEOUT_NUVEM,
) -> RespostaLLM:
    """Groq (API compatível com OpenAI). Último degrau: só texto, sem visão."""
    chave = _chave("GROQ_API_KEY", "groq")
    modelo = os.getenv("GROQ_MODEL", MODELO_GROQ_PADRAO)

    mensagens: list[dict[str, str]] = []
    if sistema:
        mensagens.append({"role": "system", "content": sistema})
    mensagens.append({"role": "user", "content": prompt})

    corpo: dict[str, Any] = {
        "model": modelo,
        "messages": mensagens,
        "temperature": 0.0,
        "max_tokens": MAX_TOKENS_GROQ,
    }
    if json_mode:
        corpo["response_format"] = {"type": "json_object"}

    dados, duracao_ms = await _postar(
        URL_GROQ,
        corpo,
        {"authorization": f"Bearer {chave}", "content-type": "application/json"},
        provedor="groq",
        modelo=modelo,
        timeout=timeout,
    )

    escolha = (dados.get("choices") or [{}])[0]
    if escolha.get("finish_reason") == "length":
        raise ErroProvedor(
            f"resposta truncada (finish_reason=length, max_tokens={MAX_TOKENS_GROQ})", provedor="groq", modelo=modelo
        )

    texto = str((escolha.get("message") or {}).get("content") or "")
    if not texto.strip():
        raise ErroProvedor(
            f"groq devolveu conteúdo vazio (finish_reason={escolha.get('finish_reason')})", provedor="groq", modelo=modelo
        )

    uso = dados.get("usage") or {}
    return RespostaLLM(
        texto=texto,
        modelo=modelo,
        provedor="groq",
        tokens_entrada=int(uso.get("prompt_tokens") or 0),
        tokens_saida=int(uso.get("completion_tokens") or 0),
        duracao_ms=duracao_ms,
    )


def provedores_configurados() -> dict[str, Any]:
    """Quais fallbacks têm chave (sem chamar a rede) - alimenta `router.status`."""
    return {
        "gemini": {
            "configurado": bool((os.getenv("GEMINI_API_KEY") or "").strip()),
            "modelo": os.getenv("GEMINI_MODEL", MODELO_GEMINI_PADRAO),
            "visao": True,
        },
        "groq": {
            "configurado": bool((os.getenv("GROQ_API_KEY") or "").strip()),
            "modelo": os.getenv("GROQ_MODEL", MODELO_GROQ_PADRAO),
            "visao": False,
        },
    }


__all__ = ["gemini", "groq", "provedores_configurados", "MODELO_GEMINI_PADRAO", "MODELO_GROQ_PADRAO"]
