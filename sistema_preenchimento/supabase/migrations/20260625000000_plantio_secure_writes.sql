-- Funções RPC para restringir o que o role "anon" pode escrever no schema
-- "plantio". Hoje (migrations anteriores) o anon tem "using (true) with check
-- (true)" em programacao/usuarios — qualquer pessoa com a publishable key (que
-- é pública, está embutida no formulario.html) pode alterar QUALQUER coluna de
-- QUALQUER linha, ou inserir lixo. Como a publishable key é compartilhada pelo
-- formulario.html (browser, não confiável) e pela engine Python local
-- (confiável), não dá pra simplesmente revogar privilégios do anon sem quebrar
-- a engine — por isso o caminho é: expor só estas funções (security definer,
-- validam entrada e tocam só as colunas que o app realmente precisa) e, numa
-- migration seguinte — depois que a engine local passar a usar a service_role
-- key (bypassa RLS) — revogar o INSERT/UPDATE direto do anon nas tabelas.
--
-- Esta migration é só ADITIVA (não revoga nada ainda): cria as funções e
-- concede EXECUTE ao anon, sem remover os grants antigos. Ver
-- 20260625000100_plantio_lock_down_anon.sql para o lockdown final.

-- ── registrar_bloco: atualiza Mapeamento/Projeto de um conjunto de talhões e
-- grava o log de exportação, tudo numa única transação (corrige também a falta
-- de atomicidade do client antigo, que fazia um PATCH por talhão em paralelo).
create or replace function plantio.registrar_bloco(
  p_layers     bigint[],
  p_mapeamento text,
  p_projeto    text,
  p_usuario    text
)
returns void
language plpgsql
security definer
set search_path = plantio
as $$
declare
  v_agora timestamptz := now();
begin
  if p_layers is null or array_length(p_layers, 1) is null then
    raise exception 'nenhum layer informado';
  end if;
  if p_mapeamento not in ('Sim', 'Não') then
    raise exception 'mapeamento inválido: %', p_mapeamento;
  end if;
  if p_projeto not in ('Aguard. Map.', 'Pendente', 'Andamento', 'Ok') then
    raise exception 'projeto inválido: %', p_projeto;
  end if;
  if p_usuario is null or length(trim(p_usuario)) = 0 or length(p_usuario) > 60 then
    raise exception 'usuário inválido';
  end if;

  update plantio.programacao
     set mapeamento = p_mapeamento,
         projeto    = p_projeto,
         updated_at = v_agora
   where layer = any(p_layers);

  insert into plantio.log_exportacoes
    (data_consolidacao, registrado_em, usuario, layer, fazenda, talhao, mapeamento, ciclo, projeto)
  select v_agora, v_agora, p_usuario, p.layer, p.fazenda, p.talhao, p_mapeamento, p.ciclo, p_projeto
    from plantio.programacao p
   where p.layer = any(p_layers);
end;
$$;

grant execute on function plantio.registrar_bloco(bigint[], text, text, text) to anon;

-- ── upsert_usuario / remover_usuario: o painel "Gerenciar Usuários" do
-- formulario.html só editava localStorage (cada navegador tinha sua própria
-- lista) porque nunca existiu nenhum jeito de escrever em plantio.usuarios
-- (só select/update, sem insert/delete). Estas funções fecham esse buraco e
-- passam a ser o único caminho de escrita pra essa tabela.
create or replace function plantio.upsert_usuario(p_nome text, p_perfis jsonb)
returns void
language plpgsql
security definer
set search_path = plantio
as $$
declare
  v_nome   text := lower(trim(p_nome));
  v_perfil text;
begin
  if v_nome is null or length(v_nome) = 0 then
    raise exception 'nome é obrigatório';
  end if;
  if length(v_nome) > 60 then
    raise exception 'nome muito longo';
  end if;
  if p_perfis is null or jsonb_typeof(p_perfis) <> 'array' then
    raise exception 'perfis deve ser uma lista';
  end if;
  for v_perfil in select jsonb_array_elements_text(p_perfis) loop
    if v_perfil not in ('preenchimento', 'dashboard') then
      raise exception 'perfil inválido: %', v_perfil;
    end if;
  end loop;

  insert into plantio.usuarios (nome, perfis)
  values (v_nome, p_perfis)
  on conflict (nome) do update set perfis = excluded.perfis;
end;
$$;

grant execute on function plantio.upsert_usuario(text, jsonb) to anon;

create or replace function plantio.remover_usuario(p_nome text)
returns void
language plpgsql
security definer
set search_path = plantio
as $$
begin
  delete from plantio.usuarios where nome = lower(trim(p_nome));
end;
$$;

grant execute on function plantio.remover_usuario(text) to anon;
