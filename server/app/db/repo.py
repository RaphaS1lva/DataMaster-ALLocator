"""CRUD da camada de dados. Toda consulta é escopada por `usuario_id`.

POR QUE `usuario_id` APARECE EM TODA ASSINATURA
-----------------------------------------------
No v1 a autorização vivia em políticas de linha dentro do Postgres, avaliadas a
partir do usuário da sessão do provedor de autenticação. Aqui não existe usuário
de banco por requisição: quem conecta é sempre a API, com uma credencial de
serviço. Logo, o WHERE é a autorização.

Consequência: nenhuma função deste módulo aceita "faça isso no registro X" sem
também receber "em nome de quem". Um `id` vindo do cliente é palpite até provar
que pertence a quem pediu - e a prova é `and usuario_id = %s` na mesma query,
nunca um SELECT de verificação seguido de UPDATE (isso é corrida clássica).

CONVENÇÕES
----------
· Parâmetros SEMPRE ligados pelo driver. Zero f-string com dado de usuário
  dentro de SQL. As únicas interpolações são listas de colunas constantes,
  definidas neste arquivo.
· `::uuid` explícito nos ids: o driver manda `str` como texto e `uuid = text`
  não tem operador no Postgres. O cast aceita `str` e `uuid.UUID`.
· jsonb via `json.dumps(...)` + `%s::jsonb`, e não pelo adaptador do psycopg,
  assim a serialização é a mesma em qualquer versão do driver e este módulo não
  precisa importar psycopg nem lazy.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Mapping, Sequence

from . import conexao

logger = logging.getLogger(__name__)

#: Colunas leves de `analises`. Os jsonb grandes (`linhas`, `qa`, `trilha`)
#: ficam FORA: uma análise real passa de 1MB e a lista da tela inicial traz
#: dezenas delas. No v1 o SELECT era `*` e abrir o portal baixava centenas de
#: megabytes para exibir nome e data.
_COLUNAS_ANALISE_LISTA = """
    id, usuario_id, cliente_id, empresa, cnpj, grupo, status, unidade, moeda,
    saldos_absolutos, periodos, n_linhas, balanco_fechado, conciliado,
    criado_em, atualizado_em
"""

_CAMPOS_ANALISE = (
    "cliente_id", "empresa", "cnpj", "grupo", "status", "unidade", "moeda",
    "saldos_absolutos", "periodos", "linhas", "qa", "trilha", "n_linhas",
    "balanco_fechado", "conciliado",
)


class NaoEncontrado(LookupError):
    """Registro ausente OU de outro usuário.

    Um único erro para os dois casos de propósito: responder 404 para "não
    existe" e 403 para "existe mas não é seu" conta ao atacante quais ids são
    válidos. A API traduz isto em 404 sempre.
    """


def _json(valor: Any) -> str | None:
    """Serializa para jsonb. `None` viaja como NULL, não como a string 'null'."""
    if valor is None:
        return None
    return json.dumps(valor, ensure_ascii=False, default=str)


# ------------------------------------------------------------------- usuarios
def criar_usuario(email: str, senha_hash: str, nome: str | None = None) -> dict[str, Any]:
    """Cria usuário. `senha_hash` JÁ deve ser bcrypt (ver `app/auth.py`).

    Assinatura pede o hash e não a senha de propósito: uma função que recebe
    senha em texto puro convida alguém a logá-la em algum debug. A senha nunca
    entra neste módulo.

    `on conflict do nothing` + `returning`: e-mail repetido devolve 0 linhas e
    levanta erro claro, em vez de vazar a violação de constraint do Postgres
    para o cliente HTTP.
    """
    linha = conexao.executar(
        """
        insert into usuarios (email, senha_hash, nome)
        values (%s, %s, %s)
        on conflict (email) do nothing
        returning id, email, nome, criado_em
        """,
        (email.strip(), senha_hash, (nome or "").strip() or None),
        fetch="one",
    )
    if linha is None:
        raise ValueError(f"e-mail já cadastrado: {email!r}")
    logger.info("usuário criado: %s", linha["id"])
    return linha


def buscar_usuario_por_email(email: str) -> dict[str, Any] | None:
    """Usuário pelo e-mail, com o hash - é a query do login.

    A comparação é case-insensitive porque a coluna é `citext`: "Ana@x.com" e
    "ana@x.com" são a mesma conta. No v1 a coluna era `text` e um cadastro com
    caixa diferente criava um usuário paralelo, sem clientes e sem memória.
    """
    return conexao.executar(
        """
        select id, email, senha_hash, nome, criado_em, ultimo_acesso
          from usuarios
         where email = %s
        """,
        (email.strip(),),
        fetch="one",
    )


def registrar_acesso(usuario_id: str) -> None:
    """Marca `ultimo_acesso`. Best effort: não é para derrubar um login válido."""
    conexao.executar(
        "update usuarios set ultimo_acesso = now() where id = %s::uuid",
        (usuario_id,),
    )


# ------------------------------------------------------------------- clientes
def listar_clientes(usuario_id: str) -> list[dict[str, Any]]:
    return conexao.executar(
        """
        select c.id, c.nome, c.cnpj, c.grupo, c.setor, c.criado_em, c.atualizado_em,
               (select coalesce(max(m.revisao), 0)
                  from memoria_cliente m
                 where m.cliente_id = c.id) as revisao_memoria
          from clientes c
         where c.usuario_id = %s::uuid
         order by c.nome
        """,
        (usuario_id,),
        fetch="all",
    ) or []


def upsert_cliente(usuario_id: str, cliente: Mapping[str, Any]) -> dict[str, Any]:
    """Insere ou atualiza um cliente. Sem `id`, o banco gera um.

    O `where clientes.usuario_id = excluded.usuario_id` no `do update` é a trava
    de posse: se o id existir e for de OUTRO usuário, o update não acontece,
    `returning` volta vazio e levantamos `NaoEncontrado`. Sem essa cláusula, um
    id adivinhado sobrescreveria o cliente de outro analista - e o `on conflict`
    esconderia o fato, porque não há erro nenhum a reportar.
    """
    linha = conexao.executar(
        """
        insert into clientes (id, usuario_id, nome, cnpj, grupo, setor)
        values (coalesce(%(id)s::uuid, gen_random_uuid()), %(usuario_id)s::uuid,
                %(nome)s, %(cnpj)s, %(grupo)s, %(setor)s)
        on conflict (id) do update
           set nome  = excluded.nome,
               cnpj  = excluded.cnpj,
               grupo = excluded.grupo,
               setor = excluded.setor
         where clientes.usuario_id = excluded.usuario_id
        returning id, nome, cnpj, grupo, setor, criado_em, atualizado_em
        """,
        {
            "id": cliente.get("id") or None,
            "usuario_id": usuario_id,
            "nome": str(cliente.get("nome") or "").strip(),
            "cnpj": str(cliente.get("cnpj") or "").strip(),
            "grupo": str(cliente.get("grupo") or "").strip(),
            "setor": str(cliente.get("setor") or "").strip(),
        },
        fetch="one",
    )
    if linha is None:
        raise NaoEncontrado(f"cliente {cliente.get('id')!r} não é deste usuário")
    return linha


def apagar_cliente(usuario_id: str, cliente_id: str) -> None:
    """Apaga cliente e, em cascata, a memória dele.

    A cascata é intencional (ver `schema.sql`): memória de cliente inexistente é
    lixo que só serve para reaparecer num relatório e assustar alguém. As
    ANÁLISES sobrevivem, com `cliente_id` nulo - histórico entregue não se
    apaga por efeito colateral de um clique no cadastro.
    """
    linha = conexao.executar(
        """
        delete from clientes
         where id = %s::uuid and usuario_id = %s::uuid
        returning id
        """,
        (cliente_id, usuario_id),
        fetch="one",
    )
    if linha is None:
        raise NaoEncontrado(f"cliente {cliente_id!r} não encontrado")
    logger.info("cliente apagado: %s", cliente_id)


# ------------------------------------------------------------------- analises
def listar_analises(
    usuario_id: str, *, cliente_id: str | None = None, limite: int = 200
) -> list[dict[str, Any]]:
    """Lista análises SEM os jsonb pesados (`linhas`, `qa`, `trilha`).

    `cliente_id` opcional resolvido com curinga em vez de SQL montado por
    condição: `(%s::uuid is null or cliente_id = %s::uuid)`. Duas queries
    diferentes divergiriam na manutenção; SQL concatenado convida a injeção.
    """
    return conexao.executar(
        f"""
        select {_COLUNAS_ANALISE_LISTA}
          from analises
         where usuario_id = %(usuario_id)s::uuid
           and (%(cliente_id)s::uuid is null or cliente_id = %(cliente_id)s::uuid)
         order by atualizado_em desc
         limit %(limite)s
        """,
        {"usuario_id": usuario_id, "cliente_id": cliente_id or None,
         "limite": max(1, min(int(limite), 1000))},
        fetch="all",
    ) or []


def obter_analise(usuario_id: str, analise_id: str) -> dict[str, Any]:
    """Análise completa, com os jsonb. Só aqui eles são carregados."""
    linha = conexao.executar(
        """
        select * from analises
         where id = %s::uuid and usuario_id = %s::uuid
        """,
        (analise_id, usuario_id),
        fetch="one",
    )
    if linha is None:
        raise NaoEncontrado(f"análise {analise_id!r} não encontrada")
    return linha


def salvar_analise(usuario_id: str, analise: Mapping[str, Any]) -> dict[str, Any]:
    """Insere ou atualiza uma análise inteira. Mesma trava de posse do cliente.

    `n_linhas` é derivado de `linhas` quando não vem explícito: contador que o
    cliente informa é contador que um dia mente, e é ele que alimenta o painel
    de "tamanho da análise".
    """
    linhas = analise.get("linhas") or []
    status = str(analise.get("status") or "rascunho").strip()
    dados = {
        "id": analise.get("id") or None,
        "usuario_id": usuario_id,
        "cliente_id": analise.get("cliente_id") or None,
        "empresa": str(analise.get("empresa") or "").strip(),
        "cnpj": str(analise.get("cnpj") or "").strip(),
        "grupo": str(analise.get("grupo") or "").strip(),
        "status": status,
        "unidade": str(analise.get("unidade") or "Mil").strip(),
        "moeda": str(analise.get("moeda") or "BRL").strip(),
        "saldos_absolutos": bool(analise.get("saldos_absolutos")),
        "periodos": _json(analise.get("periodos") or []),
        "linhas": _json(linhas),
        "qa": _json(analise.get("qa")),
        "trilha": _json(analise.get("trilha")),
        "n_linhas": int(analise.get("n_linhas") or len(linhas)),
        "balanco_fechado": bool(analise.get("balanco_fechado")),
        "conciliado": bool(analise.get("conciliado")),
    }
    atribuicoes = ",\n               ".join(
        f"{campo} = excluded.{campo}" for campo in _CAMPOS_ANALISE
    )
    linha = conexao.executar(
        f"""
        insert into analises (
            id, usuario_id, cliente_id, empresa, cnpj, grupo, status, unidade,
            moeda, saldos_absolutos, periodos, linhas, qa, trilha, n_linhas,
            balanco_fechado, conciliado)
        values (
            coalesce(%(id)s::uuid, gen_random_uuid()), %(usuario_id)s::uuid,
            %(cliente_id)s::uuid, %(empresa)s, %(cnpj)s, %(grupo)s, %(status)s,
            %(unidade)s, %(moeda)s, %(saldos_absolutos)s, %(periodos)s::jsonb,
            %(linhas)s::jsonb, %(qa)s::jsonb, %(trilha)s::jsonb, %(n_linhas)s,
            %(balanco_fechado)s, %(conciliado)s)
        on conflict (id) do update
           set {atribuicoes}
         where analises.usuario_id = excluded.usuario_id
        returning {_COLUNAS_ANALISE_LISTA}
        """,
        dados,
        fetch="one",
    )
    if linha is None:
        raise NaoEncontrado(f"análise {analise.get('id')!r} não é deste usuário")
    logger.info("análise salva: %s (%d linhas, status=%s)",
                linha["id"], dados["n_linhas"], status)
    return linha


def apagar_analise(usuario_id: str, analise_id: str) -> None:
    linha = conexao.executar(
        """
        delete from analises
         where id = %s::uuid and usuario_id = %s::uuid
        returning id
        """,
        (analise_id, usuario_id),
        fetch="one",
    )
    if linha is None:
        raise NaoEncontrado(f"análise {analise_id!r} não encontrada")
    logger.info("análise apagada: %s", analise_id)


# --------------------------------------------------------------------- eventos
def registrar_evento(
    usuario_id: str | None,
    tipo: str,
    payload: Any = None,
    *,
    analise_id: str | None = None,
) -> None:
    """Append na trilha de auditoria. NUNCA levanta.

    Evento é observabilidade: se a gravação da trilha falhar, o certo é logar e
    deixar a operação de negócio seguir. O inverso - perder um salvamento de
    análise porque o log de auditoria caiu - troca um problema pequeno por um
    grande. Para os casos em que a trilha PRECISA ser atômica com o fato (a
    gravação de revisão de memória), o insert é feito na mesma transação, dentro
    de `app/db/memoria.py`.
    """
    try:
        conexao.executar(
            """
            insert into eventos (usuario_id, analise_id, tipo, payload)
            values (%s::uuid, %s::uuid, %s, %s::jsonb)
            """,
            (usuario_id or None, analise_id or None, tipo, _json(payload)),
        )
    except Exception:  # noqa: BLE001 - trilha não derruba operação de negócio
        logger.exception("falha ao registrar evento %s", tipo)


# ------------------------------------------------------------------ dicionário
def listar_dicionario(usuario_id: str) -> list[dict[str, Any]]:
    """Dicionário global do usuário, no formato que `matching.js` indexa."""
    return conexao.executar(
        """
        select chave, origem, origem_norm, destino, grupo, sub_categoria,
               fonte, confirmado_por_humano, atualizado_em
          from dicionario_global
         where usuario_id = %s::uuid
         order by origem_norm
        """,
        (usuario_id,),
        fetch="all",
    ) or []


def upsert_dicionario(usuario_id: str, entradas: Sequence[Mapping[str, Any]]) -> int:
    """Insere/atualiza regras globais. Devolve quantas linhas foram afetadas.

    O `ON CONFLICT (usuario_id, chave)` cita as DUAS colunas da UNIQUE, e isso é
    o conserto de um bug caro do v1: lá o upsert declarava conflito apenas em
    `chave`, contra uma UNIQUE composta `(usuario_id, chave)`. O Postgres
    responde 42P10 - "there is no unique or exclusion constraint matching the ON
    CONFLICT specification" - porque a especificação precisa cobrir exatamente as
    colunas de alguma constraint. E o erro caía num `catch {}` vazio no cliente:
    o portal mostrava "dicionário atualizado" e NADA havia sido gravado. O
    aprendizado global do produto era um no-op silencioso, e ninguém percebeu
    porque a tela dizia o contrário.

    Lição embutida aqui: erro de banco não é tratado com catch vazio; ou sobe,
    ou é logado com o payload que o causou.
    """
    from .memoria import chave_dicionario, EntradaMemoria  # local: evita ciclo

    registros = []
    for entrada in entradas:
        chave = str(entrada.get("chave") or "").strip()
        if not chave:
            # Deriva a chave pela MESMA regra de normalização do banco e do
            # portal (ver `dm_normalize` em schema.sql).
            chave = chave_dicionario(EntradaMemoria.de_dict(entrada))
        destino = str(entrada.get("destino") or "").strip()
        origem = str(entrada.get("origem") or "").strip()
        if not origem or not destino:
            logger.warning("entrada de dicionário sem origem/destino ignorada: %r", entrada)
            continue
        registros.append(
            {
                "usuario_id": usuario_id,
                "chave": chave,
                "origem": origem,
                "destino": destino,
                "grupo": str(entrada.get("grupo") or "").strip(),
                "sub_categoria": str(
                    entrada.get("sub_categoria") or entrada.get("subCategoria") or ""
                ).strip(),
                "fonte": str(entrada.get("fonte") or "manual").strip(),
                "confirmado_por_humano": bool(
                    entrada.get("confirmado_por_humano")
                    or entrada.get("confirmadoPorHumano")
                ),
            }
        )
    if not registros:
        return 0

    sql = """
        insert into dicionario_global (
            usuario_id, chave, origem, origem_norm, destino, grupo,
            sub_categoria, fonte, confirmado_por_humano, atualizado_em)
        values (
            %(usuario_id)s::uuid, %(chave)s, %(origem)s, dm_normalize(%(origem)s),
            %(destino)s, %(grupo)s, %(sub_categoria)s, %(fonte)s,
            %(confirmado_por_humano)s, now())
        on conflict (usuario_id, chave) do update
           set origem                = excluded.origem,
               origem_norm           = excluded.origem_norm,
               destino               = excluded.destino,
               grupo                 = excluded.grupo,
               sub_categoria         = excluded.sub_categoria,
               fonte                 = excluded.fonte,
               -- Uma vez confirmada por humano, continua confirmada: uma
               -- regravação automática não pode rebaixar decisão revisada.
               confirmado_por_humano = dicionario_global.confirmado_por_humano
                                       or excluded.confirmado_por_humano,
               atualizado_em         = now()
    """
    with conexao.conectar() as conn, conn.cursor() as cur:
        cur.executemany(sql, registros)
        afetadas = cur.rowcount if cur.rowcount and cur.rowcount > 0 else len(registros)
    logger.info("dicionário global do usuário %s: %d entradas gravadas",
                usuario_id, afetadas)
    return afetadas
