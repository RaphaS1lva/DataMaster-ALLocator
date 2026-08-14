"""Acesso ao Postgres (Neon). Fina de propósito: abre conexão, executa, fecha.

POR QUE O `import psycopg` É LAZY (dentro das funções)
-----------------------------------------------------
A máquina de desenvolvimento deste projeto está atrás de um proxy corporativo
que bloqueia o PyPI, então `psycopg` só existe no notebook que roda o servidor.
Se o import estivesse no topo do módulo, `import app.db.memoria` explodiria aqui
- e com ele TODA a suíte de testes de lógica pura (normalização, diff de
memória, reaproveitamento de decisão negativa), que é justamente a parte que
precisa rodar em qualquer lugar. Import dentro da função paga o custo (alguns
microssegundos, o módulo fica em `sys.modules`) para manter a lógica testável
onde o banco não existe. Mesmo padrão de `app/llm/schemas.py` com o pydantic.

POR QUE NÃO HÁ POOL AQUI
------------------------
O Neon fecha conexão ociosa e oferece um pooler próprio no endpoint
`...-pooler.<região>.aws.neon.tech`. Manter um pool no processo sobre um banco
que hiberna dá conexão morta em cache - erro intermitente, o pior tipo. Usamos
conexão por unidade de trabalho e delegamos o pooling ao endpoint. Se um dia o
volume justificar, o lugar de mudar é só este arquivo.
"""

from __future__ import annotations

import logging
import os
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Literal, Mapping, Sequence

logger = logging.getLogger(__name__)

VAR_URL = "DATABASE_URL"
CAMINHO_SCHEMA = Path(__file__).resolve().parent / "schema.sql"

Fetch = Literal["none", "one", "all"]
_FETCH_VALIDOS: frozenset[str] = frozenset({"none", "one", "all"})


class ErroBanco(RuntimeError):
    """Falha de configuração ou de dependência da camada de dados.

    Separada de `psycopg.Error` para que a API distinga "o ambiente está mal
    configurado" (culpa nossa, 500 com mensagem acionável) de "a query falhou"
    (que pode ser 409 de constraint, por exemplo).
    """


def esta_configurado() -> bool:
    """Há `DATABASE_URL` no ambiente?

    Usada por rotas de health check e pelos testes que precisam de banco real,
    eles chamam isto e dão `skip` quando não há banco, em vez de falhar. Teste
    vermelho por falta de infraestrutura treina o time a ignorar teste vermelho.
    """
    return bool(os.getenv(VAR_URL))


def _url() -> str:
    url = os.getenv(VAR_URL, "").strip()
    if not url:
        raise ErroBanco(
            f"{VAR_URL} não definida. Exporte a connection string do Neon, ex.: "
            "postgresql://usuario:senha@ep-xxx-pooler.sa-east-1.aws.neon.tech/"
            "allocator?sslmode=require"
        )
    return url


def _psycopg() -> tuple[Any, Any]:
    """Importa psycopg sob demanda e devolve `(modulo, dict_row)`."""
    try:
        import psycopg
        from psycopg.rows import dict_row
    except ModuleNotFoundError as erro:  # pragma: no cover - depende do ambiente
        raise ErroBanco(
            "psycopg não está instalado neste interpretador. Instale as "
            "dependências do servidor: pip install -r server/requirements.txt "
            "(o pacote é psycopg[binary]==3.3.4). A lógica pura de "
            "app/db/memoria.py roda sem ele; persistência, não."
        ) from erro
    return psycopg, dict_row


@contextmanager
def conectar(*, autocommit: bool = False) -> Iterator[Any]:
    """Conexão como context manager, com `dict_row` e transação explícita.

    `dict_row` é obrigatório em todo o projeto: linha como tupla obriga a
    lembrar a ordem das colunas do SELECT, e um dia alguém insere uma coluna no
    meio e o código passa a ler o campo errado sem erro nenhum.

    Commit no fim do bloco, rollback em QUALQUER exceção (inclusive
    `KeyboardInterrupt`, por isso `BaseException`): meio-caminho gravado é pior
    que nada gravado, principalmente em `salvar_revisao()`, onde metade das
    entradas de memória seria uma revisão mentirosa.
    """
    psycopg, dict_row = _psycopg()
    conexao = psycopg.connect(_url(), row_factory=dict_row, autocommit=autocommit)
    try:
        yield conexao
        if not autocommit:
            conexao.commit()
    except BaseException:
        if not autocommit:
            conexao.rollback()
        raise
    finally:
        conexao.close()


def executar(
    sql: str,
    params: Sequence[Any] | Mapping[str, Any] = (),
    *,
    fetch: Fetch = "none",
) -> Any:
    """Executa uma instrução e devolve conforme `fetch`.

    fetch='none' -> None · 'one' -> dict | None · 'all' -> list[dict]

    `params` é SEMPRE passado ao driver, nunca interpolado na string: é o que
    torna injeção de SQL impossível por construção. Se em algum lugar do
    projeto aparecer f-string com dado de usuário dentro de SQL, é bug.
    """
    if fetch not in _FETCH_VALIDOS:
        raise ValueError(f"fetch inválido: {fetch!r} (use {sorted(_FETCH_VALIDOS)})")
    with conectar() as conexao, conexao.cursor() as cur:
        # `params or None`: sem parâmetros, psycopg usa o protocolo simples,
        # necessário para scripts com mais de uma instrução.
        cur.execute(sql, params or None)
        if fetch == "one":
            return cur.fetchone()
        if fetch == "all":
            return cur.fetchall()
        return None


def aplicar_schema(caminho: Path | None = None) -> None:
    """Aplica `schema.sql`. Idempotente - pode rodar no boot da API.

    Roda o arquivo inteiro em UMA chamada, sem parâmetros: é assim que o
    psycopg usa o protocolo simples e aceita várias instruções na mesma
    execução. Tentar quebrar o script em statements aqui exigiria um parser de
    SQL (as funções têm `;` dentro do corpo `$$ ... $$`), e parser meia-boca de
    SQL é fonte garantida de falha silenciosa de migração.
    """
    arquivo = caminho or CAMINHO_SCHEMA
    if not arquivo.exists():
        raise ErroBanco(f"schema não encontrado: {arquivo}")
    sql = arquivo.read_text(encoding="utf-8")
    with conectar() as conexao:
        conexao.execute(sql)
    logger.info("schema aplicado: %s (%d bytes)", arquivo.name, len(sql))
