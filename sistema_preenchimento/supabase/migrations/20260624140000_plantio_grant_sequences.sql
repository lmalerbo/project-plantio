-- Corrige privilégio faltante na migration anterior: "grant all on all tables"
-- não inclui sequences — colunas bigserial (ex: log_exportacoes.id) dependem de
-- uma sequence própria pra gerar o próximo valor. Sem essa permissão, INSERT em
-- log_exportacoes falha com "permission denied for sequence log_exportacoes_id_seq".

grant usage, select on all sequences in schema plantio to anon, authenticated;
alter default privileges in schema plantio grant usage, select on sequences to anon, authenticated;
