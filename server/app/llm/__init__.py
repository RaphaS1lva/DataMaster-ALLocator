"""Camada de LLM do ALLocator.

Fronteira de responsabilidade (é o que torna o sistema auditável):

- O LLM faz APENAS julgamento semântico - "este nome de conta lido do documento
  corresponde a qual posição do plano padronizado?".
- Ele NUNCA lê números (parser determinístico) e NUNCA decide totais (fórmulas).
- Antes de chamá-lo, o motor já reduziu os candidatos ao bloco compatível
  (~9 a 15 destinos em vez de 79) pelo 1º dígito do código e pela cadeia de
  contas-pai. Por isso um modelo pequeno local (6 GB de VRAM) basta.
- Tudo que ele devolve passa por `guardrails.validar_sugestoes` antes de existir.

Ordem dos provedores: Ollama local (escada de modelos) -> Gemini -> Groq.
"""

from __future__ import annotations

# Guardrails e prompts são LÓGICA PURA (só stdlib) e precisam ser importáveis e
# testáveis em qualquer máquina - é a parte crítica de segurança do sistema.
from .guardrails import (
    LIMIAR_CONFIANCA,
    PADROES_INJECAO,
    sanitizar_texto_documento,
    validar_sugestoes,
)
from .prompts import (
    PROMPT_VERSION,
    SISTEMA_JULGAMENTAL,
    SISTEMA_PARECER,
    montar_prompt_julgamental,
    montar_prompt_parecer,
)

# Já os CLIENTES de provedor exigem httpx/pydantic, que só existem no notebook
# servidor (ver docs/09-runbook-notebook.md - a máquina de desenvolvimento está
# atrás de proxy que bloqueia o PyPI). Falha na importação NÃO pode derrubar os
# guardrails: quem tentar usar um provedor sem as libs recebe erro claro no uso.
_ERRO_DEPS: str | None = None
try:
    from .ollama import ClienteOllama, ErroProvedor, RespostaLLM
    from .router import MODELOS, completar_texto, completar_visao, embutir, status
    from .schemas import (
        RespostaJulgamental, RespostaParecer, SugestaoMapeamento, json_schema_de,
    )
    DEPS_LLM_DISPONIVEIS = True
except ImportError as _e:  # pragma: no cover
    DEPS_LLM_DISPONIVEIS = False
    _ERRO_DEPS = str(_e)

    class ErroProvedor(RuntimeError):  # type: ignore[no-redef]
        """Levantada quando um provedor falha - ou quando as libs faltam."""

    def _indisponivel(nome: str):
        def _falha(*_a, **_k):
            raise ErroProvedor(
                f"{nome} indisponível: {_ERRO_DEPS}. Instale as dependências do "
                "servidor com `pip install -r server/requirements.txt` "
                "(ver docs/09-runbook-notebook.md)."
            )
        return _falha

    ClienteOllama = _indisponivel("ClienteOllama")      # type: ignore[assignment]
    RespostaLLM = None                                   # type: ignore[assignment]
    MODELOS = {}                                         # type: ignore[assignment]
    completar_texto = _indisponivel("completar_texto")   # type: ignore[assignment]
    completar_visao = _indisponivel("completar_visao")   # type: ignore[assignment]
    embutir = _indisponivel("embutir")                   # type: ignore[assignment]
    status = _indisponivel("status")                     # type: ignore[assignment]
    RespostaJulgamental = None                           # type: ignore[assignment]
    RespostaParecer = None                               # type: ignore[assignment]
    SugestaoMapeamento = None                            # type: ignore[assignment]
    json_schema_de = _indisponivel("json_schema_de")     # type: ignore[assignment]

__all__ = [
    "DEPS_LLM_DISPONIVEIS",
    # contrato
    "SugestaoMapeamento",
    "RespostaJulgamental",
    "RespostaParecer",
    "json_schema_de",
    # provedores
    "ClienteOllama",
    "ErroProvedor",
    "RespostaLLM",
    "MODELOS",
    "completar_texto",
    "completar_visao",
    "embutir",
    "status",
    # prompts
    "PROMPT_VERSION",
    "SISTEMA_JULGAMENTAL",
    "SISTEMA_PARECER",
    "montar_prompt_julgamental",
    "montar_prompt_parecer",
    # guardrails
    "LIMIAR_CONFIANCA",
    "PADROES_INJECAO",
    "sanitizar_texto_documento",
    "validar_sugestoes",
]
