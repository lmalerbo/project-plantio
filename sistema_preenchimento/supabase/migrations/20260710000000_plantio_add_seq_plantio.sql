-- Adiciona coluna seq_plantio (texto da coluna "Sequência Plantio" da planilha,
-- ex: 'EXPERIMENTO') para sinalizar talhões que precisam de validação prévia
-- com o Departamento Técnico antes do Projeto avançar.
alter table plantio.programacao add column if not exists seq_plantio text;
