-- Schema inicial: tabelas de programação, log de exportações e usuários.
-- Aplicar com: supabase link --project-ref <PROJECT_REF> && supabase db push

create table if not exists programacao (
  layer       bigint primary key,
  periodo_op  int,
  cod_faz     int,
  fazenda     text,
  talhao      int,
  status      text default '',
  tipo_linha  text default '',
  ciclo       text default '',
  area_ha     numeric default 0,
  estagio     text default '',
  updated_at  timestamptz default now()
);

create table if not exists log_exportacoes (
  id                bigserial primary key,
  data_consolidacao timestamptz default now(),
  registrado_em     timestamptz,
  usuario           text,
  layer             bigint,
  fazenda           text,
  talhao            int,
  tipo_linha        text,
  ciclo             text,
  status            text
);

create table if not exists usuarios (
  nome   text primary key,
  perfis jsonb default '[]',
  ha     numeric default 0
);

alter table programacao       enable row level security;
alter table log_exportacoes   enable row level security;
alter table usuarios          enable row level security;

create policy "programacao_select_anon" on programacao
  for select to anon using (true);

create policy "programacao_update_anon" on programacao
  for update to anon using (true) with check (true);

create policy "log_exportacoes_select_anon" on log_exportacoes
  for select to anon using (true);

create policy "log_exportacoes_insert_anon" on log_exportacoes
  for insert to anon with check (true);

create policy "usuarios_select_anon" on usuarios
  for select to anon using (true);

create policy "usuarios_update_anon" on usuarios
  for update to anon using (true) with check (true);