-- Schema do Plantio, isolado num schema Postgres próprio ("plantio") porque este
-- projeto Supabase é COMPARTILHADO com o project-preparo (mesmo projeto, conta já
-- no limite de 2 projetos free) — o schema "public" já tem tabelas chamadas
-- programacao/log_exportacoes/usuarios pertencentes ao preparo, com colunas
-- diferentes. NUNCA criar/alterar tabelas em "public" a partir deste repositório.
--
-- Versão de migration usa timestamp (20260624120000) em vez do padrão 0001/0002/...
-- de propósito, pra não colidir com as versões já aplicadas pelo project-preparo
-- nesse mesmo projeto (schema_migrations é compartilhado por projeto, não por schema).
--
-- Depois de aplicar, exponha o schema "plantio" em
-- Supabase Dashboard → Settings → API → Data API Settings → Exposed schemas.

create schema if not exists plantio;

create table if not exists plantio.programacao (
  layer        bigint primary key,
  periodo_op   int,
  cod_faz      int,
  fazenda      text,
  talhao       int,
  ciclo        text default '',
  area_ha      numeric default 0,
  mes_plantio  date,
  ambiente     text default '',
  sist_conser  text default '',
  mapeamento   text default 'Não',
  projeto      text default 'Pendente',
  bloco_id     text,
  updated_at   timestamptz default now()
);

create table if not exists plantio.log_exportacoes (
  id                bigserial primary key,
  data_consolidacao timestamptz default now(),
  registrado_em     timestamptz,
  usuario           text,
  layer             bigint,
  fazenda           text,
  talhao            int,
  mapeamento        text,
  ciclo             text,
  projeto           text
);

create table if not exists plantio.usuarios (
  nome   text primary key,
  perfis jsonb default '[]',
  ha     numeric default 0
);

alter table plantio.programacao     enable row level security;
alter table plantio.log_exportacoes enable row level security;
alter table plantio.usuarios        enable row level security;

create policy "programacao_select_anon" on plantio.programacao
  for select to anon using (true);

create policy "programacao_insert_anon" on plantio.programacao
  for insert to anon with check (true);

create policy "programacao_update_anon" on plantio.programacao
  for update to anon using (true) with check (true);

create policy "log_exportacoes_select_anon" on plantio.log_exportacoes
  for select to anon using (true);

create policy "log_exportacoes_insert_anon" on plantio.log_exportacoes
  for insert to anon with check (true);

create policy "usuarios_select_anon" on plantio.usuarios
  for select to anon using (true);

create policy "usuarios_update_anon" on plantio.usuarios
  for update to anon using (true) with check (true);

-- PostgREST só enxerga tabelas dos schemas expostos em Settings → API — sem isso
-- a API continua respondendo 404/erro pras tabelas plantio.* mesmo após esta migration.
grant usage on schema plantio to anon, authenticated;
grant all on all tables in schema plantio to anon, authenticated;
alter default privileges in schema plantio grant all on tables to anon, authenticated;
