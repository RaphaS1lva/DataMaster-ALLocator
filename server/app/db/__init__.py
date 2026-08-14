"""Camada de dados do ALLocator: Postgres (Neon) + memória versionada do cliente.

    conexao   abre conexão, executa, aplica o schema
    repo      CRUD, sempre escopado por `usuario_id`
    memoria   decisões do analista (positivas E negativas), versionadas
    schema.sql  DDL idempotente, PostgreSQL puro

ESTE ARQUIVO NÃO IMPORTA NADA NO NÍVEL DE MÓDULO - DE PROPÓSITO
---------------------------------------------------------------
`repo` e `memoria` levam o `psycopg` a tiracolo. Se o `__init__` importasse os
submódulos de forma eager, um `import app.db.memoria` numa máquina sem driver de
banco falharia - e junto com ele iria embora a suíte de testes da lógica pura
(normalização, diff de memória, reaproveitamento de decisão negativa), que é
exatamente a parte que precisa rodar em qualquer lugar. Nesta máquina de
desenvolvimento o PyPI está bloqueado por proxy e `psycopg` não existe.

O `__getattr__` de módulo (PEP 562) dá a ergonomia de `from app.db import
conectar` sem pagar o import antes da hora: a resolução só acontece quando o
nome é de fato usado.
"""

from __future__ import annotations

from typing import Any

#: Nome exportado -> submódulo que o define.
_ORIGEM: dict[str, str] = {
    # conexao
    "conectar": "conexao",
    "executar": "conexao",
    "aplicar_schema": "conexao",
    "esta_configurado": "conexao",
    "ErroBanco": "conexao",
    # repo
    "NaoEncontrado": "repo",
    # memoria - lógica pura, importável sem banco
    "normalizar": "memoria",
    "chave_de": "memoria",
    "EntradaMemoria": "memoria",
    "DiffMemoria": "memoria",
    "diff_memoria": "memoria",
    "aplicar_memoria": "memoria",
    "entradas_promoviveis": "memoria",
    "carregar_memoria": "memoria",
    "salvar_revisao": "memoria",
    "promover_ao_dicionario": "memoria",
    "ALOCAR": "memoria",
    "NAO_ALOCAR": "memoria",
    "CONTEXTO": "memoria",
}

_SUBMODULOS = frozenset({"conexao", "memoria", "repo"})

__all__ = [*sorted(_ORIGEM), *sorted(_SUBMODULOS)]


def __getattr__(nome: str) -> Any:
    from importlib import import_module

    if nome in _SUBMODULOS:
        return import_module(f".{nome}", __name__)
    modulo = _ORIGEM.get(nome)
    if modulo:
        return getattr(import_module(f".{modulo}", __name__), nome)
    raise AttributeError(f"{__name__!r} não expõe {nome!r}")


def __dir__() -> list[str]:
    return sorted(__all__)
