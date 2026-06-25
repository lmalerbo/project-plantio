-- Trava o que o role "anon" pode escrever diretamente no schema "plantio".
-- Pré-requisito desta migration: a engine Python local (atualizar_programacao.py
-- e sincronizar_planilha.py) precisa estar usando a service_role key em
-- supabase_config.json (bypassa RLS) — ela compartilhava até aqui a mesma
-- publishable key do navegador, então revogar o INSERT/UPDATE do anon sem essa
-- troca quebraria o ATUALIZAR.bat/SINCRONIZAR_PLANILHA.bat.
--
-- Depois desta migration, o único jeito de escrever em programacao/usuarios
-- com a publishable key (a do formulario.html, pública) é via as funções
-- security definer criadas em 20260625000000_plantio_secure_writes.sql.

-- ── programacao: só leitura direta; escrita só via registrar_bloco() ──────
drop policy if exists "programacao_insert_anon" on plantio.programacao;
drop policy if exists "programacao_update_anon" on plantio.programacao;
revoke insert, update, delete on plantio.programacao from anon, authenticated;

-- ── usuarios: só leitura direta; escrita só via upsert_usuario()/remover_usuario() ──
drop policy if exists "usuarios_update_anon" on plantio.usuarios;
revoke insert, update, delete on plantio.usuarios from anon, authenticated;

-- ── log_exportacoes: o único caminho de escrita do app agora é dentro de
-- registrar_bloco() (security definer) — o formulario.html não faz mais POST
-- direto nessa tabela, então fecha o INSERT direto do anon também.
drop policy if exists "log_exportacoes_insert_anon" on plantio.log_exportacoes;
revoke insert, update, delete on plantio.log_exportacoes from anon, authenticated;
