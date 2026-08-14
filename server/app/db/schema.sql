-- =============================================================================
-- ALLocator v2 · esquema de dados · PostgreSQL 15+ (alvo: Neon Serverless)
-- =============================================================================
--
-- POR QUE O MODELO DE SEGURANÇA MUDOU
-- -----------------------------------------------------------------------------
-- No v1 o portal (JavaScript rodando no browser) falava DIRETO com o banco
-- usando uma chave anônima publicada no bundle, e a autorização vivia dentro do
-- Postgres, em políticas de linha que chamavam uma função de sessão do provedor
-- para descobrir "quem é o usuário desta requisição".
--
-- Aqui não existe nada disso, e é de propósito:
--
--   · NÃO usamos RLS e não existe usuário de banco por requisição. Quem conecta
--     é SEMPRE a API, com uma única credencial de serviço que nunca sai do
--     servidor.
--   · A autorização mora na API: toda consulta de `app/db/repo.py` recebe
--     `usuario_id` e o coloca no WHERE. A única fonte desse id é o JWT validado
--     em `app/auth.py` - o cliente não escolhe por quem responde.
--   · O browser, portanto, nunca recebe credencial de banco. No v1 a chave
--     anônima era pública por construção: bastava abrir o DevTools.
--
-- Consequência prática: nenhuma tabela aqui referencia catálogo de autenticação
-- de provedor nenhum. `usuarios` é uma tabela comum deste esquema e
-- `usuario_id` é uma FK normal. Isso torna o banco portável - Neon hoje, RDS ou
-- Postgres local amanhã, sem editar uma linha.
--
-- Motivo da troca de provedor: o projeto gratuito anterior era PAUSADO após 7
-- dias sem tráfego e exigia restore manual no console antes de voltar a
-- responder. Um analista abrindo o portal na segunda-feira encontrava erro de
-- conexão. O Postgres gerenciado do Neon apenas hiberna e acorda na primeira
-- query.
--
-- Este arquivo é IDEMPOTENTE: `app.db.conexao.aplicar_schema()` pode rodar
-- quantas vezes quiser.

-- -----------------------------------------------------------------------------
-- Extensões. Vêm ANTES da função de normalização porque `dm_normalize` depende
-- de `unaccent`. Fixamos `schema public` para não ficar à mercê de onde o
-- provedor resolve instalar extensão (o Neon usa `public`, mas provedores que
-- isolam em `extensions` fariam a função quebrar em tempo de execução).
-- -----------------------------------------------------------------------------
create extension if not exists unaccent  with schema public;   -- remove acento
create extension if not exists citext    with schema public;   -- e-mail case-insensitive
create extension if not exists pgcrypto  with schema public;   -- gen_random_uuid()

-- -----------------------------------------------------------------------------
-- dm_normalize · CONTRATO CRÍTICO DE NORMALIZAÇÃO
-- -----------------------------------------------------------------------------
-- Precisa ser byte a byte equivalente a:
--   · portal/src/core/normalize.js       -> normalizeText()
--   · server/app/db/memoria.py           -> normalizar()
--
-- Receita: lower + remove acento + tudo que não for [a-z0-9\s] vira ESPAÇO +
-- colapsa espaços + trim.
--
-- O BUG DO v1 ESTAVA AQUI: o trigger normalizava com `lower(unaccent(...))` e
-- mais nada. Pontuação sobrevivia. Então "ICMS s/ vendas" virava "icms s/
-- vendas" no banco enquanto o portal calculava "icms s vendas" - duas chaves
-- diferentes para a mesma conta. O UPSERT não achava a linha do seed, inseria
-- uma nova, e o dicionário acumulava pares duplicados em que a regra aprendida
-- nunca vencia a regra original. Os dois `regexp_replace` encadeados abaixo são
-- exatamente o que faltava.
--
-- Sobre IMMUTABLE: `unaccent(text)` é declarada STABLE (depende do dicionário de
-- texto instalado). Declarar este invólucro como IMMUTABLE é o contorno
-- documentado para poder usar a função em índice e em coluna gerada - vale
-- porque o dicionário `unaccent` não muda em produção. `set search_path` impede
-- que a resolução de nomes dependa do search_path de quem chama (o preço é a
-- função não ser inlinada pelo planner; correção antes de micro-otimização).
create or replace function public.dm_normalize(txt text)
returns text
language sql
immutable
parallel safe
set search_path = public
as $$
  select btrim(
    regexp_replace(
      regexp_replace(unaccent(lower(coalesce(txt, ''))), '[^a-z0-9[:space:]]', ' ', 'g'),
      '[[:space:]]+', ' ', 'g'
    )
  );
$$;

-- Toque em `atualizado_em`: preferimos trigger a confiar no cliente, porque
-- "quando este registro mudou" é dado de auditoria e não deve ser falsificável
-- por quem escreve.
create or replace function public.dm_touch()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.atualizado_em := now();
  return new;
end;
$$;

-- Recalcula as colunas `_norm` a partir do texto cru. Deixar isso no banco
-- garante que a chave de unicidade seja consistente mesmo se um cliente futuro
-- (script de carga, migração, psql na mão) esquecer de normalizar.
create or replace function public.dm_normalizar_memoria()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.origem_norm := dm_normalize(new.origem);
  new.grupo_norm  := dm_normalize(new.grupo);
  new.sub_norm    := dm_normalize(new.sub_categoria);
  return new;
end;
$$;

create or replace function public.dm_normalizar_dicionario()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.origem_norm := dm_normalize(new.origem);
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- usuarios
-- -----------------------------------------------------------------------------
-- `citext` no e-mail porque "Ana@Empresa.com" e "ana@empresa.com" são a mesma
-- pessoa; com `text` a UNIQUE deixaria passar contas duplicadas.
-- `senha_hash` guarda bcrypt (ver app/auth.py), nunca a senha.
create table if not exists usuarios (
  id             uuid primary key default gen_random_uuid(),
  email          citext unique not null,
  senha_hash     text not null,
  nome           text,
  criado_em      timestamptz not null default now(),
  ultimo_acesso  timestamptz
);

-- -----------------------------------------------------------------------------
-- clientes
-- -----------------------------------------------------------------------------
-- `on delete cascade`: apagar o usuário apaga a carteira dele. Não existe
-- cliente órfão - ele só faz sentido dentro do escopo de um analista.
create table if not exists clientes (
  id            uuid primary key default gen_random_uuid(),
  usuario_id    uuid not null references usuarios (id) on delete cascade,
  nome          text not null,
  cnpj          text not null default '',
  grupo         text not null default '',
  setor         text not null default '',
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

create index if not exists idx_clientes_usuario on clientes (usuario_id, nome);

-- -----------------------------------------------------------------------------
-- analises
-- -----------------------------------------------------------------------------
-- `cliente_id` é `on delete set null` (e não cascade) de propósito: apagar o
-- cadastro de um cliente não pode destruir o histórico de análises já
-- entregues. A análise sobrevive desvinculada.
--
-- `linhas`, `qa` e `trilha` são jsonb grandes (uma análise real passa de 1MB).
-- `repo.listar_analises()` NUNCA os seleciona - listar 200 análises trazendo os
-- jsonb junto era o que fazia a tela inicial do v1 levar segundos.
create table if not exists analises (
  id                uuid primary key default gen_random_uuid(),
  usuario_id        uuid not null references usuarios (id) on delete cascade,
  cliente_id        uuid references clientes (id) on delete set null,
  empresa           text not null default '',
  cnpj              text not null default '',
  grupo             text not null default '',
  status            text not null default 'rascunho',
  unidade           text not null default 'Mil',
  moeda             text not null default 'BRL',
  saldos_absolutos  boolean not null default false,
  periodos          jsonb not null default '[]'::jsonb,
  linhas            jsonb not null default '[]'::jsonb,
  qa                jsonb,
  trilha            jsonb,
  n_linhas          int not null default 0,
  balanco_fechado   boolean not null default false,
  conciliado        boolean not null default false,
  criado_em         timestamptz not null default now(),
  atualizado_em     timestamptz not null default now(),
  -- No v1 isto era um COMENTÁRIO na coluna e nada mais, então existiam análises
  -- com status 'draft', 'Rascunho' e '' no mesmo banco, e o filtro da lista
  -- silenciosamente escondia trabalho do analista. Agora o banco recusa.
  constraint analises_status_check
    check (status in ('rascunho','em_revisao','concluida'))
);

create index if not exists idx_analises_usuario
  on analises (usuario_id, atualizado_em desc);
create index if not exists idx_analises_cliente
  on analises (cliente_id, atualizado_em desc);

drop trigger if exists trg_analises_touch on analises;
create trigger trg_analises_touch
  before update on analises
  for each row execute function dm_touch();

drop trigger if exists trg_clientes_touch on clientes;
create trigger trg_clientes_touch
  before update on clientes
  for each row execute function dm_touch();

-- -----------------------------------------------------------------------------
-- memoria_cliente · O CORAÇÃO DO SISTEMA
-- -----------------------------------------------------------------------------
-- Guarda as decisões de alocação de um cliente, POSITIVAS E NEGATIVAS, versionadas
-- por `revisao`.
--
-- Por que a decisão negativa é obrigatória: quando o analista RETIRA uma conta
-- de uma linha da Shadow, ele está dizendo "esta conta não vai para cá" - uma
-- informação tão valiosa quanto a alocação. No v1 a exportação de memória só
-- pegava linhas alocadas COM destino, então a retirada era jogada fora, e na
-- análise seguinte o dicionário realocava exatamente a mesma conta no mesmo
-- lugar errado. O analista refazia o trabalho manual todo mês. `decisao =
-- 'nao_alocar'` é o registro que impede isso.
--
--   alocar     -> origem vai para `destino`
--   nao_alocar -> o humano retirou; nenhuma camada automática pode realocar
--   contexto   -> linha capturada mas informativa/totalizador, não é alocável
--
-- Por que versionado (revisao) e não UPDATE no lugar: memória é registro de
-- decisão profissional. `salvar_revisao()` sempre cria `max(revisao) + 1`, então
-- dá para auditar o que foi decidido em cada análise e reverter uma revisão
-- ruim sem perder as anteriores. Um UPDATE destrutivo apagaria a prova.
create table if not exists memoria_cliente (
  id                    uuid primary key default gen_random_uuid(),
  usuario_id            uuid not null references usuarios (id) on delete cascade,
  cliente_id            uuid not null references clientes (id) on delete cascade,
  revisao               int not null,
  origem                text not null,
  origem_norm           text not null,
  grupo                 text not null default '',
  grupo_norm            text not null default '',
  sub_categoria         text not null default '',
  sub_norm              text not null default '',
  destino               text not null default '',
  decisao               text not null,
  confirmado_por_humano boolean not null default false,
  analise_id            uuid references analises (id) on delete set null,
  vezes                 int not null default 1,
  criado_em             timestamptz not null default now(),
  constraint memoria_cliente_decisao_check
    check (decisao in ('alocar','nao_alocar','contexto')),
  -- Uma origem só pode ter UMA decisão por revisão. A chave é a NORMALIZADA:
  -- é ela que o matching usa, e no v1 a unicidade sobre o texto cru permitia
  -- "Caixa Geral" e "CAIXA GERAL " conviverem apontando para destinos
  -- diferentes - matching não determinístico, resultado dependente da ordem.
  constraint memoria_cliente_chave_unica
    unique (cliente_id, revisao, origem_norm, grupo_norm, sub_norm)
);

-- `revisao desc` porque a leitura dominante é "me dê a última revisão deste
-- cliente"; o índice serve tanto o max(revisao) quanto a varredura da revisão.
create index if not exists idx_memoria_cliente_revisao
  on memoria_cliente (cliente_id, revisao desc);
create index if not exists idx_memoria_cliente_origem
  on memoria_cliente (cliente_id, origem_norm);

drop trigger if exists trg_memoria_norm on memoria_cliente;
create trigger trg_memoria_norm
  before insert or update on memoria_cliente
  for each row execute function dm_normalizar_memoria();

-- -----------------------------------------------------------------------------
-- memoria_revisoes · cabeçalho de cada revisão
-- -----------------------------------------------------------------------------
-- Grava o RESUMO DO DIFF que o analista viu e aprovou antes de gravar. É o que
-- transforma "a memória mudou" em "o analista aprovou 41 novas, 7 alteradas e 3
-- marcadas como não alocar em tal análise" - auditoria de verdade.
create table if not exists memoria_revisoes (
  id           uuid primary key default gen_random_uuid(),
  cliente_id   uuid not null references clientes (id) on delete cascade,
  revisao      int not null,
  analise_id   uuid,
  criado_em    timestamptz not null default now(),
  novas        int not null default 0,
  alteradas    int not null default 0,
  removidas    int not null default 0,
  confirmadas  int not null default 0,
  observacao   text,
  constraint memoria_revisoes_unica unique (cliente_id, revisao)
);

-- -----------------------------------------------------------------------------
-- dicionario_global · regras transversais do analista
-- -----------------------------------------------------------------------------
-- Diferente de `memoria_cliente`: aqui a regra vale para TODOS os clientes do
-- usuário. Por isso `app.db.memoria.promover_ao_dicionario()` só deixa subir
-- entrada com `decisao='alocar'` E `confirmado_por_humano=true`.
--
-- No v1 um trigger aprendia de TUDO que era gravado, inclusive de sugestão de
-- LLM não revisada. Um erro de julgamento entrava no dicionário e se propagava
-- para toda a carteira, para sempre, sem ninguém ter aprovado nada.
create table if not exists dicionario_global (
  id                    uuid primary key default gen_random_uuid(),
  usuario_id            uuid not null references usuarios (id) on delete cascade,
  chave                 text not null,
  origem                text not null,
  origem_norm           text not null,
  destino               text not null,
  grupo                 text not null default '',
  sub_categoria         text not null default '',
  fonte                 text not null default 'manual',
  confirmado_por_humano boolean not null default false,
  atualizado_em         timestamptz not null default now(),
  -- A UNIQUE é COMPOSTA e o `ON CONFLICT` de `repo.upsert_dicionario()` cita as
  -- DUAS colunas. No v1 o upsert declarava conflito só em `chave` contra esta
  -- mesma UNIQUE composta: o Postgres respondia 42P10 ("no unique or exclusion
  -- constraint matching the ON CONFLICT specification") e o erro era engolido
  -- por um catch vazio no cliente. O aprendizado do dicionário era um no-op
  -- silencioso - o portal dizia "salvo" e nada tinha sido salvo.
  constraint dicionario_global_chave_unica unique (usuario_id, chave)
);

create index if not exists idx_dicionario_usuario
  on dicionario_global (usuario_id, origem_norm);

drop trigger if exists trg_dicionario_norm on dicionario_global;
create trigger trg_dicionario_norm
  before insert or update on dicionario_global
  for each row execute function dm_normalizar_dicionario();

-- -----------------------------------------------------------------------------
-- eventos · trilha de auditoria
-- -----------------------------------------------------------------------------
-- Append-only. `bigserial` e não uuid porque a ordem de inserção é a informação
-- principal e ordenar por uuid v4 não significa nada. Sem FK para `usuarios`
-- nem para `analises`: o evento tem de sobreviver ao apagamento do que ele
-- descreve, senão a trilha desaparece justamente no caso que mais interessa
-- investigar.
create table if not exists eventos (
  id          bigserial primary key,
  ts          timestamptz not null default now(),
  usuario_id  uuid,
  analise_id  uuid,
  tipo        text not null,
  payload     jsonb
);

create index if not exists idx_eventos_usuario on eventos (usuario_id, ts desc);
create index if not exists idx_eventos_analise on eventos (analise_id, ts desc);
create index if not exists idx_eventos_tipo    on eventos (tipo, ts desc);
