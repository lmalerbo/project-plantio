-- A engine Python local passou a usar a service_role key (ver migration
-- 20260625000100), mas as migrations anteriores só concediam "usage on schema
-- plantio" e os grants de tabela/sequence para "anon, authenticated" — nunca
-- para "service_role". Bypassar RLS (bypassrls) não dispensa o grant de
-- schema/tabela em si, então sem isso a service_role fica sem acesso nenhum
-- ao schema "plantio" (erro "permission denied for schema plantio").

grant usage on schema plantio to service_role;
grant all on all tables in schema plantio to service_role;
grant all on all sequences in schema plantio to service_role;
alter default privileges in schema plantio grant all on tables to service_role;
alter default privileges in schema plantio grant all on sequences to service_role;
