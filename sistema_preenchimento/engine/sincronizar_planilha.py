"""
sincronizar_planilha.py
Uso: python sincronizar_planilha.py  OU  duplo clique no SINCRONIZAR_PLANILHA.bat

Pensado pra rodar direto na pasta de rede onde a Sequência de Plantio mora —
a tela Admin → "Sincronizar Planilha" do formulario.html ajuda a colocar este
script (+ utils.py + requirements.txt) ali usando a File System Access API do
navegador (Chrome/Edge). Por isso a planilha é procurada no diretório atual
(*.xlsx), não numa subpasta.

Lê a tabela `programacao` do Supabase, agrupa por `bloco_id` (a mesma chave
que já era calculada na importação: COD FAZ + MÊS DE PLANTIO + texto bruto de
TALHÕES), aplica o rollup de Sist. Conser. por bloco e escreve de volta nas
colunas Z (Sist. Conser.) / AA (Mapeamento) / AB (Projeto / Mapa) da aba
"Sequencia" — localizando cada linha pelo mesmo bloco_id recalculado a partir
do conteúdo atual da planilha (sobrevive a reordenação de linhas, mas não a
uma edição de Código/Mês de Plantio/Talhões entre sincronizações).

Por quê Excel real (xlwings) em vez de openpyxl para escrever: a aba "Sequencia"
tem mais de 100 regras de formatação condicional e várias listas de validação
(são elas que colorem PENDENTE/ANDAMENTO/OK e os dropdowns) — abrir e salvar esse
arquivo com openpyxl arrisca descartar essas extensões. Por isso este script só
roda numa máquina Windows com Excel instalado, e a planilha não pode estar aberta
em outra instância do Excel no momento da sincronização.

A localização das linhas (achar_header, varredura de TALHÕES) é feita com
openpyxl, só leitura — o Excel real (xlwings) é usado só para escrever as 3
células e salvar, minimizando o que passa pelo motor de salvamento do Excel.
"""

import os
import sys

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_BASE_DIR   = os.path.dirname(_SCRIPT_DIR)   # sistema_preenchimento/
sys.path.insert(0, _SCRIPT_DIR)
from utils import (norm_header, redirecionar_stdout, fechar_log,
                    achar_header, data_para_iso, rollup_sist_conser)

_log_fh = redirecionar_stdout(os.path.join(_BASE_DIR, 'logs', 'sincronizar.log'))

import glob as _glob
import json

import requests
import openpyxl
import xlwings as xw

_config_path = os.path.join(_BASE_DIR, 'supabase_config.json')
if not os.path.exists(_config_path):
    print(f"ERRO: Arquivo nao encontrado → {_config_path}")
    fechar_log(_log_fh)
    input("\nPressione Enter para sair...")
    sys.exit(1)

with open(_config_path, 'r', encoding='utf-8') as _f:
    _sb_cfg = json.load(_f)

SUPABASE_URL = _sb_cfg['url'].rstrip('/')
SUPABASE_KEY = _sb_cfg['key']
# Projeto compartilhado com o project-preparo — tabelas do Plantio isoladas no
# schema "plantio" (ver migration), por isso Accept-Profile/Content-Profile.
SB_HEADERS = {
    'apikey': SUPABASE_KEY,
    'Authorization': f'Bearer {SUPABASE_KEY}',
    'Accept-Profile': 'plantio',
    'Content-Profile': 'plantio',
}

# Planilha protegida por senha (proteção de gravação) — sem ela, o Excel abre a
# planilha como somente-leitura ao automatizar via COM (sem dialogo pra perguntar),
# e wb.save() não lança erro mas também não grava nada no disco.
_planilha_cfg_path = os.path.join(_BASE_DIR, 'planilha_config.json')
SENHA_PLANILHA = None
if os.path.exists(_planilha_cfg_path):
    with open(_planilha_cfg_path, 'r', encoding='utf-8') as _f:
        SENHA_PLANILHA = json.load(_f).get('senha_plantio') or None
if not SENHA_PLANILHA:
    print(f"AVISO: {_planilha_cfg_path} não encontrado ou sem 'senha_plantio' — "
          "se a planilha tiver senha de gravação, a sincronização vai abrir em modo "
          "somente-leitura e salvar silenciosamente sem efeito.\n")

os.chdir(_BASE_DIR)

# ── 1. Lê programação do Supabase e agrupa por bloco_id ───────────────────
print("Lendo programação do Supabase...")
_res = requests.get(
    f"{SUPABASE_URL}/rest/v1/programacao?select=bloco_id,sist_conser,mapeamento,projeto",
    headers=SB_HEADERS,
    timeout=30,
)
if not _res.ok:
    print(f"ERRO ao ler programacao: {_res.status_code} {_res.text}")
    fechar_log(_log_fh)
    input("\nPressione Enter para sair...")
    sys.exit(1)

_por_bloco = {}
for row in _res.json():
    bloco_id = row.get('bloco_id')
    if not bloco_id:
        continue
    _por_bloco.setdefault(bloco_id, []).append(row)

blocos = {}   # bloco_id → (sist_conser, mapeamento, projeto)
for bloco_id, rows in _por_bloco.items():
    sist_conser = rollup_sist_conser([r.get('sist_conser') for r in rows])
    mapeamento  = rows[0].get('mapeamento') or 'Não'
    projeto     = rows[0].get('projeto') or 'Pendente'
    blocos[bloco_id] = (sist_conser, mapeamento, projeto)
print(f"  {len(blocos)} bloco(s) carregado(s) do Supabase.\n")

# ── 2. Localiza, por leitura (openpyxl), as linhas que batem com cada bloco ──
# Planilha procurada no diretório atual (este script roda na mesma pasta de
# rede onde ela mora — ver docstring no topo do arquivo). Ignora os arquivos
# de lock temporário do Excel ("~$nome.xlsx", criados enquanto o arquivo está
# aberto em outra instância).
print("Localizando linhas na planilha de Sequência de Plantio...")
_plantio_found = [f for f in _glob.glob("*.xlsx") if not os.path.basename(f).startswith('~$')]
if not _plantio_found:
    print("ERRO: Nenhum arquivo .xlsx encontrado nesta pasta.")
    fechar_log(_log_fh)
    input("\nPressione Enter para sair...")
    sys.exit(1)
if len(_plantio_found) > 1:
    print(f"  AVISO: {len(_plantio_found)} arquivos .xlsx nesta pasta — usando o primeiro encontrado "
          f"({_plantio_found[0]}); remova os demais pra evitar ambiguidade.")
SOURCE_PLANTIO = os.path.abspath(_plantio_found[0])
print(f"  Planilha de plantio: {SOURCE_PLANTIO}")

wb_ro = openpyxl.load_workbook(SOURCE_PLANTIO, data_only=True)
sheet_seq = next((n for n in wb_ro.sheetnames if norm_header(n) == 'SEQUENCIA'), None)
if not sheet_seq:
    print(f"ERRO: Aba 'Sequencia' não encontrada. Abas disponíveis: {wb_ro.sheetnames}")
    fechar_log(_log_fh)
    input("\nPressione Enter para sair...")
    sys.exit(1)
ws_ro = wb_ro[sheet_seq]

LIMITE_COL = openpyxl.utils.column_index_from_string('AB')
header_row, hmap = achar_header(ws_ro, ['MES DE PLANTIO', 'CODIGO', 'SECAO', 'TALHOES'], max_row=10, max_col=LIMITE_COL)
if header_row is None:
    print(f"ERRO: Cabeçalho (Mês de Plantio/Código/Seção/Talhões) não encontrado na aba '{sheet_seq}'.")
    fechar_log(_log_fh)
    input("\nPressione Enter para sair...")
    sys.exit(1)

idx_mes = hmap['MES DE PLANTIO']
idx_cod = hmap['CODIGO']
idx_tal = hmap['TALHOES']

linhas_para_escrever = []   # [(numero_da_linha, sist_conser, mapeamento, projeto)]
blocos_restantes = dict(blocos)
for i, row in enumerate(ws_ro.iter_rows(min_row=header_row + 1, max_row=ws_ro.max_row, max_col=LIMITE_COL, values_only=True), start=header_row + 1):
    cod_raw = row[idx_cod] if idx_cod < len(row) else None
    tal_raw = row[idx_tal] if idx_tal < len(row) else None
    mes_raw = row[idx_mes] if idx_mes < len(row) else None
    if cod_raw is None or tal_raw is None:
        continue
    try:
        cod_faz = int(cod_raw)
    except (ValueError, TypeError):
        continue
    mes_iso = data_para_iso(mes_raw)
    bloco_id = f"{cod_faz}|{mes_iso}|{str(tal_raw).strip()}"

    if bloco_id in blocos_restantes:
        sist_conser, mapeamento, projeto = blocos_restantes.pop(bloco_id)
        linhas_para_escrever.append((i, sist_conser, mapeamento, projeto))

print(f"  {len(linhas_para_escrever)} linha(s) encontrada(s) pra atualizar.")
if blocos_restantes:
    print(f"  ⚠  {len(blocos_restantes)} bloco(s) do Supabase não encontrados na planilha "
          f"(Código/Mês de Plantio/Talhões pode ter sido editado desde a última Atualização de Demanda):")
    for b in sorted(blocos_restantes)[:10]:
        print(f"     {b}")
    if len(blocos_restantes) > 10:
        print(f"     ... e mais {len(blocos_restantes) - 10}")
print()

if not linhas_para_escrever:
    print("Nada para escrever na planilha.")
    fechar_log(_log_fh)
    input("\nPressione Enter para fechar...")
    sys.exit(0)

# ── 3. Escreve via Excel real (preserva formatação condicional/validação) ──
# Sem a senha de gravação, o Excel automatizado via COM abre a planilha como
# somente-leitura (sem mostrar diálogo nenhum) — wb.save() não lança erro, mas
# também não grava nada no disco. Por isso a senha (planilha_config.json) é
# passada explicitamente no Open. Além disso, salva num arquivo temporário e
# substitui o original via os.replace() (atômico, não depende do Excel) em vez
# de salvar direto por cima — reduz o impacto de qualquer outra contenção
# pontual (antivírus/indexador) no exato momento da troca do arquivo.
print("Abrindo Excel para escrever e salvar...")
COL_Z, COL_AA, COL_AB = 26, 27, 28   # Sist. Conser. / Mapeamento / Projeto-Mapa (1-based)

_tmp_path = SOURCE_PLANTIO + '.sync_tmp.xlsx'
if os.path.exists(_tmp_path):
    os.remove(_tmp_path)

app = xw.App(visible=False)
app.display_alerts = False
try:
    wb = app.books.open(SOURCE_PLANTIO, password=SENHA_PLANILHA)
    ws = wb.sheets[sheet_seq]
    for linha, sist_conser, mapeamento, projeto in linhas_para_escrever:
        ws.range((linha, COL_Z)).value  = sist_conser
        ws.range((linha, COL_AA)).value = mapeamento
        ws.range((linha, COL_AB)).value = projeto
    wb.save(_tmp_path)
finally:
    wb.close()
    app.quit()

os.replace(_tmp_path, SOURCE_PLANTIO)
print(f"  {len(linhas_para_escrever)} linha(s) escrita(s) e planilha salva.")

print("\nSincronização concluída.")
fechar_log(_log_fh)
input("\nPressione Enter para fechar...")
