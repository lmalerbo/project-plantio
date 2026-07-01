-- upsert_usuario() validava só ('preenchimento', 'dashboard') — não sabia do
-- perfil 'admin' introduzido junto da aba Admin do formulario.html (Usuários +
-- Atualizar Demanda + Sincronizar Planilha). Recria a função só pra adicionar
-- 'admin' à lista de perfis válidos; o resto do corpo é idêntico ao da
-- migration 20260625000000.

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
    if v_perfil not in ('preenchimento', 'dashboard', 'admin') then
      raise exception 'perfil inválido: %', v_perfil;
    end if;
  end loop;

  insert into plantio.usuarios (nome, perfis)
  values (v_nome, p_perfis)
  on conflict (nome) do update set perfis = excluded.perfis;
end;
$$;
