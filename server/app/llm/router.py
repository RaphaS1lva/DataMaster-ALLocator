"""Cascata de provedores: Ollama local (escada de modelos) -> Gemini -> Groq.

A escada existe porque o orçamento é 6 GB de VRAM (RTX 4050). Em vez de exigir
que UM modelo caiba e esteja sempre carregado, tentamos do mais capaz para o mais
leve e caímos para a nuvem só se nada local responder. Como o julgamento recebe um
conjunto de candidatos já reduzido (~9 a 15 destinos, não 79), o degrau de baixo
ainda resolve a maior parte dos casos.

Toda tentativa - inclusive as puladas pelo disjuntor - é registrada em
`obs/trace.py` com o motivo da decisão. É o que permite responder "por que este
documento foi para a nuvem?" com dado, não com suposição.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Mapping, Sequence

from ..obs.trace import TRACE
from . import cloud
from .ollama import ClienteOllama, ErroProvedor, RespostaLLM

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------- escada de modelos
# vram_gb = footprint aproximado do peso quantizado; o que sobra dos 6 GB é KV cache.
MODELOS: dict[str, list[dict[str, Any]]] = {
    "texto": [
        {
            "nome": "qwen2.5:7b-instruct-q4_K_M",
            "tipo": "texto",
            "vram_gb": 4.7,
            "nota": "Preferido: cabe inteiro na VRAM de 6 GB e é o melhor em seguir instrução em português contábil.",
        },
        {
            "nome": "qwen2.5:3b-instruct-q4_K_M",
            "tipo": "texto",
            "vram_gb": 2.0,
            "nota": "Rápido e folgado; suficiente porque a lista de candidatos já vem reduzida pelo pré-filtro.",
        },
    ],
    "visao": [
        {
            "nome": "qwen2.5vl:3b",
            "tipo": "visao",
            "vram_gb": 3.2,
            "nota": "Preferido em visão: cabe na VRAM junto com o projetor de imagem.",
        },
        {
            "nome": "qwen2.5vl:7b",
            "tipo": "visao",
            "vram_gb": 6.0,
            "nota": "Mais preciso, mas exige offload parcial para a RAM - mais lento, usar só se o 3b falhar.",
        },
        {
            "nome": "granite3.3-vision:2b",
            "tipo": "visao",
            "vram_gb": 2.4,
            "nota": "Último degrau local: treinado especificamente para tabelas/documentos, ótimo em balancete tabular.",
        },
    ],
    "embedding": [
        {
            "nome": "nomic-embed-text",
            "tipo": "embedding",
            "vram_gb": 0.3,
            "nota": "Embeddings do pré-filtro determinístico (não decide nada sozinho).",
        },
    ],
}

# ------------------------------------------------------------------- disjuntor
FALHAS_PARA_ABRIR = 3
COOLDOWN_S = 120.0

# Estado por modelo: {"falhas": n, "aberto_ate": timestamp}.
# POR QUÊ: quando um modelo não está baixado ou não cabe na VRAM, cada tentativa
# custa o timeout inteiro (ou o tempo de carregar/derrubar peso da GPU). Insistir
# nele em toda requisição queima latência do usuário para chegar sempre no mesmo
# erro. Após 3 falhas consecutivas ele fica 120s de fora e a cascata pula direto
# para o degrau que funciona. Um sucesso zera o contador.
_disjuntor: dict[str, dict[str, float]] = {}


def _em_cooldown(nome: str) -> bool:
    estado = _disjuntor.get(nome)
    return bool(estado and estado.get("aberto_ate", 0.0) > time.monotonic())


def _registrar_falha(nome: str) -> None:
    estado = _disjuntor.setdefault(nome, {"falhas": 0.0, "aberto_ate": 0.0})
    estado["falhas"] += 1
    if estado["falhas"] >= FALHAS_PARA_ABRIR:
        estado["aberto_ate"] = time.monotonic() + COOLDOWN_S
        logger.warning("disjuntor aberto para %s por %.0fs (%.0f falhas)", nome, COOLDOWN_S, estado["falhas"])


def _registrar_sucesso(nome: str) -> None:
    _disjuntor.pop(nome, None)


def resetar_disjuntores() -> None:
    """Zera o estado do disjuntor (usado em testes e no reload de configuração)."""
    _disjuntor.clear()


def estado_disjuntores() -> dict[str, dict[str, Any]]:
    """Visão legível do disjuntor para o portal/diagnóstico."""
    agora = time.monotonic()
    return {
        nome: {
            "falhas": int(estado.get("falhas", 0)),
            "aberto": estado.get("aberto_ate", 0.0) > agora,
            "cooldown_restante_s": max(0.0, round(estado.get("aberto_ate", 0.0) - agora, 1)),
        }
        for nome, estado in _disjuntor.items()
    }


# --------------------------------------------------------------------- cliente
_cliente: ClienteOllama | None = None


def cliente_ollama() -> ClienteOllama:
    """Cliente Ollama do processo (singleton preguiçoso, facilita monkeypatch)."""
    global _cliente
    if _cliente is None:
        _cliente = ClienteOllama()
    return _cliente


def _mensagens(prompt: str, sistema: str | None) -> list[dict[str, Any]]:
    mensagens: list[dict[str, Any]] = []
    if sistema:
        mensagens.append({"role": "system", "content": sistema})
    mensagens.append({"role": "user", "content": prompt})
    return mensagens


async def _cascata(
    tipo: str,
    prompt: str,
    *,
    sistema: str | None,
    formato: str | Mapping[str, Any] | None,
    imagens: Sequence[bytes | bytearray | str] | None,
    tentar_nuvem: bool,
) -> RespostaLLM:
    """Percorre a escada local e, se preciso, a nuvem. Registra cada decisão."""
    erros: list[str] = []
    cliente = cliente_ollama()
    mensagens = _mensagens(prompt, sistema)

    for spec in MODELOS.get(tipo, []):
        nome = str(spec["nome"])
        if _em_cooldown(nome):
            restante = estado_disjuntores().get(nome, {}).get("cooldown_restante_s", 0.0)
            TRACE.evento(
                "llm.roteamento",
                decisao="pulado_disjuntor",
                provedor="ollama",
                modelo=nome,
                tipo=tipo,
                cooldown_restante_s=restante,
            )
            erros.append(f"ollama/{nome}: pulado - disjuntor aberto (faltam {restante}s de cooldown)")
            continue

        TRACE.evento(
            "llm.roteamento",
            decisao="tentativa_local",
            provedor="ollama",
            modelo=nome,
            tipo=tipo,
            vram_gb=spec.get("vram_gb"),
        )
        try:
            with TRACE.contexto("llm.chamada", provedor="ollama", modelo=nome, tipo=tipo) as extras:
                resposta = await cliente.chat(nome, mensagens, formato=formato, imagens=imagens)
                extras["tokens_entrada"] = resposta.tokens_entrada
                extras["tokens_saida"] = resposta.tokens_saida
        except ErroProvedor as exc:
            _registrar_falha(nome)
            erros.append(f"ollama/{nome}: {exc}")
            continue
        _registrar_sucesso(nome)
        return resposta

    if not tentar_nuvem:
        raise ErroProvedor(
            f"nenhum modelo local de {tipo} respondeu e o fallback de nuvem está desabilitado | " + " | ".join(erros),
            provedor="ollama",
        )

    for nome_provedor in ("gemini", "groq"):
        # Groq não tem visão nesta integração: não faz sentido enviar imagens.
        if tipo == "visao" and nome_provedor == "groq":
            TRACE.evento("llm.roteamento", decisao="pulado_sem_visao", provedor="groq", tipo=tipo)
            erros.append("groq: pulado - provedor sem suporte a visão nesta integração")
            continue

        TRACE.evento("llm.roteamento", decisao="tentativa_nuvem", provedor=nome_provedor, tipo=tipo)
        try:
            with TRACE.contexto("llm.chamada", provedor=nome_provedor, tipo=tipo) as extras:
                if nome_provedor == "gemini":
                    resposta = await cloud.gemini(prompt, json_mode=formato is not None, imagens=imagens, sistema=sistema)
                else:
                    resposta = await cloud.groq(prompt, json_mode=formato is not None, sistema=sistema)
                extras["modelo"] = resposta.modelo
                extras["tokens_entrada"] = resposta.tokens_entrada
                extras["tokens_saida"] = resposta.tokens_saida
        except ErroProvedor as exc:
            erros.append(f"{nome_provedor}: {exc}")
            continue
        return resposta

    # Histórico concatenado: sem ele o erro final vira "não funcionou" e o
    # diagnóstico (modelo não baixado? chave ausente? VRAM?) se perde.
    raise ErroProvedor(f"todos os provedores de {tipo} falharam | " + " | ".join(erros), provedor="cascata")


async def completar_texto(
    prompt: str,
    *,
    sistema: str | None = None,
    formato: str | Mapping[str, Any] | None = None,
    tentar_nuvem: bool = True,
) -> RespostaLLM:
    """Julgamento textual (o caminho normal do ALLocator)."""
    return await _cascata("texto", prompt, sistema=sistema, formato=formato, imagens=None, tentar_nuvem=tentar_nuvem)


async def completar_visao(
    prompt: str,
    imagens: Sequence[bytes | bytearray | str],
    *,
    sistema: str | None = None,
    formato: str | Mapping[str, Any] | None = None,
    tentar_nuvem: bool = True,
) -> RespostaLLM:
    """Leitura assistida de documento em imagem (balancete escaneado)."""
    return await _cascata("visao", prompt, sistema=sistema, formato=formato, imagens=imagens, tentar_nuvem=tentar_nuvem)


async def embutir(textos: Sequence[str]) -> list[list[float]]:
    """Embeddings do pré-filtro. Sem fallback de nuvem: trocar de modelo de
    embedding mudaria o espaço vetorial e invalidaria qualquer índice/cache."""
    erros: list[str] = []
    cliente = cliente_ollama()
    for spec in MODELOS["embedding"]:
        nome = str(spec["nome"])
        if _em_cooldown(nome):
            erros.append(f"ollama/{nome}: pulado - disjuntor aberto")
            continue
        TRACE.evento("llm.roteamento", decisao="tentativa_embedding", provedor="ollama", modelo=nome)
        try:
            with TRACE.contexto("llm.embedding", provedor="ollama", modelo=nome, itens=len(textos)):
                vetores = await cliente.embeddings(nome, textos)
        except ErroProvedor as exc:
            _registrar_falha(nome)
            erros.append(f"ollama/{nome}: {exc}")
            continue
        _registrar_sucesso(nome)
        return vetores
    raise ErroProvedor("nenhum modelo de embedding respondeu | " + " | ".join(erros), provedor="ollama")


async def status() -> dict[str, Any]:
    """O que está REALMENTE disponível agora (o portal mostra isto ao usuário)."""
    cliente = cliente_ollama()
    ollama_ok = await cliente.esta_disponivel()
    instalados = await cliente.modelos_disponiveis() if ollama_ok else []
    # O Ollama devolve "nome:tag"; normalizamos ":latest" para comparar.
    conjunto = {n for n in instalados} | {n.rsplit(":latest", 1)[0] for n in instalados if n.endswith(":latest")}

    escada: dict[str, list[dict[str, Any]]] = {}
    for tipo, especificacoes in MODELOS.items():
        escada[tipo] = [
            {
                **spec,
                "instalado": ollama_ok and spec["nome"] in conjunto,
                "disponivel": ollama_ok and spec["nome"] in conjunto and not _em_cooldown(str(spec["nome"])),
            }
            for spec in especificacoes
        ]

    return {
        "ollama": {"url": cliente.base_url, "ativo": ollama_ok, "modelos_instalados": instalados},
        "nuvem": cloud.provedores_configurados(),
        "escada": escada,
        "disjuntores": estado_disjuntores(),
        "trace": TRACE.resumo(),
    }


__all__ = [
    "MODELOS",
    "FALHAS_PARA_ABRIR",
    "COOLDOWN_S",
    "completar_texto",
    "completar_visao",
    "embutir",
    "status",
    "cliente_ollama",
    "resetar_disjuntores",
    "estado_disjuntores",
]
