"""Contrato de saída do LLM.

O LLM do ALLocator faz UM trabalho só: julgamento semântico ("esta conta lida do
documento pertence a qual das ~9-15 posições candidatas do plano padronizado?").
Ele nunca lê valores e nunca calcula totais. Por isso o contrato de saída é
pequeno e fechado - e isso é exatamente o que nos permite travá-lo por gramática.

POR QUE `json_schema_de` É O GUARDRAIL MAIS FORTE QUE TEMOS
----------------------------------------------------------
O campo `format` da API do Ollama aceita um JSON Schema. O Ollama (via llama.cpp)
converte esse schema em uma gramática GBNF e a aplica DURANTE O SAMPLING: em cada
passo, os tokens que violariam o schema recebem probabilidade zero.

A consequência prática é categórica: JSON inválido, campo faltando, campo extra
ou tipo errado deixam de ser "erros tolerados por um parser tolerante" e passam a
ser *impossíveis de gerar*. Isso também neutraliza a forma mais comum de prompt
injection em pipelines assim - a tentativa de fazer o modelo responder em prosa,
abrir um bloco ```, "explicar" que recebeu novas instruções ou devolver uma
estrutura diferente da combinada. Ele não consegue: a gramática não permite.

O que a gramática NÃO garante é o CONTEÚDO (destino existente, lado do balanço,
conta não inventada). Isso é papel de `guardrails.validar_sugestoes`.
"""

from __future__ import annotations

import copy
from typing import Any

# Pydantic só existe no notebook servidor (ver docs/09-runbook-notebook.md). Na
# máquina de desenvolvimento o PyPI está bloqueado por proxy corporativo, e
# queremos que `guardrails.py` - que é a parte crítica de segurança e não depende
# de pydantic - continue importável e testável. Então a falta da lib vira um erro
# explícito no momento do USO, não no import.
try:
    from pydantic import BaseModel, Field
    PYDANTIC_DISPONIVEL = True
except ImportError:  # pragma: no cover - exercitado só onde a lib falta
    PYDANTIC_DISPONIVEL = False

    class BaseModel:  # type: ignore[no-redef]
        """Stub. Instanciar sem pydantic é erro de configuração do servidor."""

        def __init__(self, *_a: Any, **_k: Any) -> None:
            raise RuntimeError(
                "pydantic não está instalado. Os schemas de saída do LLM exigem "
                "pydantic para gerar a gramática do Ollama. Instale as "
                "dependências do servidor: pip install -r server/requirements.txt"
            )

        @classmethod
        def model_json_schema(cls, *_a: Any, **_k: Any) -> dict[str, Any]:
            raise RuntimeError("pydantic não está instalado - ver server/requirements.txt")

    def Field(default: Any = None, **_k: Any) -> Any:  # type: ignore[no-redef] # noqa: N802
        return default


class SugestaoMapeamento(BaseModel):
    """Uma decisão de mapeamento: linha do documento -> posição do plano."""

    # `id` amarra a sugestão à linha exata enviada; sem ele não há como validar
    # se o modelo inventou uma conta que não estava no documento.
    id: str = Field(..., description="Identificador da linha do documento (copiado da entrada)")
    origem: str = Field(..., description="Nome da conta exatamente como lido do documento")
    destino: str = Field(..., description="Destino do plano de contas, copiado LITERALMENTE da lista de candidatos")
    grupo: str = Field(..., description="Grupo do destino escolhido: Ativo | Passivo | DRE")
    subCategoria: str = Field(..., description="Subcategoria do destino: Circulante | Não Circulante | PL | DRE")
    # Justificativa curta de propósito: é para auditoria humana, não para o
    # modelo "pensar em voz alta" (raciocínio longo aqui só gera alucinação).
    justificativa: str = Field(..., max_length=200, description="Motivo objetivo da escolha (máx. 200 caracteres)")
    confianca: float = Field(..., ge=0.0, le=1.0, description="Confiança honesta de 0 a 1")


class RespostaJulgamental(BaseModel):
    """Resposta da etapa de julgamento: uma sugestão por linha classificada.

    `sugestoes` é OBRIGATÓRIO (sem default) de propósito: no JSON Schema um campo
    com default sai da lista `required`, e aí a gramática permitiria ao modelo
    devolver `{}`. Obrigatório = a chave sempre existe (mesmo que a lista venha
    vazia), e o chamador nunca precisa adivinhar se houve resposta.
    """

    sugestoes: list[SugestaoMapeamento] = Field(..., description="Uma entrada por linha recebida, na mesma ordem")


class RespostaParecer(BaseModel):
    """Resposta da etapa de parecer (texto analítico sobre o resumo já calculado)."""

    parecer: str = Field(..., description="Parecer em prosa sobre os números JÁ calculados pelo motor determinístico")


def json_schema_de(modelo: type[BaseModel]) -> dict[str, Any]:
    """JSON Schema pronto para o campo `format` do Ollama (ou `response_schema`).

    Devolvemos uma cópia profunda porque o Pydantic reaproveita/cacheia a
    estrutura do schema: se um chamador mutar o dict (para injetar um campo, por
    exemplo), contaminaria todas as chamadas seguintes do processo.
    """
    # `schema()` é a rota do Pydantic v1: mantida só para não explodir em ambiente
    # legado (lá os subschemas saem em "definitions" em vez de "$defs").
    gerar = getattr(modelo, "model_json_schema", None) or modelo.schema  # type: ignore[attr-defined]
    return copy.deepcopy(gerar())


__all__ = [
    "SugestaoMapeamento",
    "RespostaJulgamental",
    "RespostaParecer",
    "json_schema_de",
]
