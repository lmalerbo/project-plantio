-- Permite que o browser (anon) faça INSERT em programacao para upsert via base ICOL.
-- Necessário para o fluxo "Atualizar base ICOL / Fazendas" no formulário.

create policy "programacao_insert_anon" on programacao
  for insert to anon with check (true);