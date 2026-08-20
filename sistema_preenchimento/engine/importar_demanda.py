"""
importar_demanda.py
Roda todo dia cedo no servidor Geo (Task Scheduler).

Lê o PLANAGRI 26-27.xlsx do caminho de rede configurado em config.json,
converte as linhas LIB em registros e faz upsert no Supabase (schema plantio)
com a service_role key — sem precisar do Cloudflare Worker nem do browser.

Regras de preservação:
  - Registros já existentes: atualiza sist_conser e mes_plantio.
    Promove mapeamento para 'Sim' se sist_conser virou auto-elegível,
    mas nunca rebaixa para 'Não'. Não toca em projeto.
  - Registros novos: define mapeamento e projeto inicial pela regra automática.

Requer: openpyxl, requests  (pip install openpyxl requests)
Config: engine/config.json  (ver config.json.example)
"""

import datetime
import json
import os
import sys

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_BASE_DIR   = os.path.dirname(_SCRIPT_DIR)
sys.path.insert(0, _SCRIPT_DIR)

from utils import (
    strip_accents, normaliza_sist_conser,
    redirecionar_stdout, fechar_log,
    SIST_CONSER_MAPEAMENTO_AUTO,
)

# ── Config ────────────────────────────────────────────────────────────────────

_config_path = os.path.join(_SCRIPT_DIR, 'config.json')
if not os.path.exists(_config_path):
    print("ERRO: engine/config.json não encontrado. Copie config.json.example e preencha.")
    sys.exit(1)

with open(_config_path, encoding='utf-8') as _f:
    _cfg = json.load(_f)

SUPABASE_URL  = _cfg['supabase_url'].rstrip('/')
SUPABASE_KEY  = _cfg['supabase_service_key']
PLANAGRI_PATH = _cfg['planagri_path']
LOG_DIR       = _cfg.get('log_dir', os.path.join(_BASE_DIR, 'logs'))

os.makedirs(LOG_DIR, exist_ok=True)
_log_fh = redirecionar_stdout(os.path.join(LOG_DIR, f'importar_{datetime.date.today()}.log'))

import openpyxl       # noqa: E402  (import after log redirect)
import requests       # noqa: E402

_SB_HEADERS = {
    'apikey':           SUPABASE_KEY,
    'Authorization':    f'Bearer {SUPABASE_KEY}',
    'Accept-Profile':   'plantio',
    'Content-Profile':  'plantio',
    'Content-Type':     'application/json',
}

# ── Constantes de colunas PLANAGRI (índices 0-based) ─────────────────────────

COL_LAYER  = 0
COL_COD    = 1
COL_SECAO  = 2
COL_TALHAO = 3
COL_PLAN   = 14
COL_SC     = 31
COL_MES    = 78

_MESES_PT = {
    'JANEIRO': 1, 'FEVEREIRO': 2, 'MARCO': 3,
    'ABRIL': 4,   'MAIO': 5,      'JUNHO': 6,
    'JULHO': 7,   'AGOSTO': 8,    'SETEMBRO': 9,
    'OUTUBRO': 10,'NOVEMBRO': 11, 'DEZEMBRO': 12,
}


def _mes_para_numero(v):
    if v is None:
        return None
    return _MESES_PT.get(strip_accents(str(v).strip()).upper())


def _layer_raw_para_int(s):
    try:
        return int(float(s))
    except (ValueError, TypeError):
        return None


# ── 1. Parse do PLANAGRI ──────────────────────────────────────────────────────

print(f"[{datetime.datetime.now():%H:%M:%S}] Lendo PLANAGRI: {PLANAGRI_PATH}")
if not os.path.exists(PLANAGRI_PATH):
    print(f"ERRO: arquivo não encontrado: {PLANAGRI_PATH}")
    fechar_log(_log_fh)
    sys.exit(1)

_wb = openpyxl.load_workbook(PLANAGRI_PATH, data_only=True, read_only=True)
_ws = _wb.worksheets[0]
_rows = list(_ws.iter_rows(values_only=True))
_wb.close()

_header_idx = None
for _i, _row in enumerate(_rows[:20]):
    _cel = str(_row[COL_LAYER] if len(_row) > COL_LAYER else '').strip().upper()
    if _cel == 'LAYER':
        _header_idx = _i
        break

if _header_idx is None:
    print("ERRO: cabeçalho 'LAYER' não encontrado nas primeiras 20 linhas.")
    fechar_log(_log_fh)
    sys.exit(1)

n_linhas = n_filtradas = n_ignoradas = 0
registros = []

for _raw in _rows[_header_idx + 1:]:
    n_linhas += 1
    _ncols = len(_raw)

    layer_raw = str(_raw[COL_LAYER] if _ncols > COL_LAYER else '').strip()
    if not layer_raw or layer_raw.upper() in ('NONE', 'NAN', ''):
        continue
    if layer_raw == '_' or layer_raw.startswith('_'):
        n_ignoradas += 1
        continue

    plan_raw = str(_raw[COL_PLAN] if _ncols > COL_PLAN else '').strip().upper()
    if plan_raw != 'LIB':
        n_filtradas += 1
        continue

    layer = _layer_raw_para_int(layer_raw)
    if layer is None:
        continue

    sc_raw    = _raw[COL_SC]    if _ncols > COL_SC    else None
    mes_raw   = _raw[COL_MES]   if _ncols > COL_MES   else None
    cod_raw   = _raw[COL_COD]   if _ncols > COL_COD   else None
    secao_raw = _raw[COL_SECAO] if _ncols > COL_SECAO else None
    tal_raw   = _raw[COL_TALHAO] if _ncols > COL_TALHAO else None

    sist_conser = normaliza_sist_conser(sc_raw)
    mes_plantio = _mes_para_numero(mes_raw)
    mapeamento  = 'Sim' if sist_conser in SIST_CONSER_MAPEAMENTO_AUTO else 'Não'

    try:
        cod_faz = str(int(float(str(cod_raw).strip())))
    except (ValueError, TypeError, AttributeError):
        cod_faz = str(cod_raw or '').strip()

    try:
        talhao = int(float(str(tal_raw or 0)))
    except (ValueError, TypeError):
        talhao = None

    registros.append({
        'layer':       layer,
        'cod_faz':     cod_faz,
        'secao':       str(secao_raw or '').strip(),
        'talhao':      talhao,
        'sist_conser': sist_conser,
        'mes_plantio': mes_plantio,
        '_mapeamento': mapeamento,   # campo auxiliar, não vai para o banco
    })

print(f"  {n_linhas} linhas lidas | {len(registros)} LIB válidos | "
      f"{n_filtradas} não-LIB | {n_ignoradas} ignorados (_)")


# ── 2. Busca existentes no Supabase (paginado) ────────────────────────────────

print(f"[{datetime.datetime.now():%H:%M:%S}] Buscando registros existentes no Supabase...")
existing = {}   # layer → {mapeamento, projeto}
_offset  = 0
_LIMIT   = 1000

while True:
    _r = requests.get(
        f"{SUPABASE_URL}/rest/v1/programacao"
        f"?select=layer,mapeamento,projeto&limit={_LIMIT}&offset={_offset}",
        headers=_SB_HEADERS,
        timeout=30,
    )
    if not _r.ok:
        print(f"ERRO ao buscar existentes: {_r.status_code} {_r.text}")
        fechar_log(_log_fh)
        sys.exit(1)
    _batch = _r.json()
    for _row in _batch:
        existing[_row['layer']] = _row
    if len(_batch) < _LIMIT:
        break
    _offset += _LIMIT

print(f"  {len(existing)} registros existentes.")


# ── 3. Monta payload de upsert ────────────────────────────────────────────────

_agora   = datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')
n_novos  = 0
n_atualizados = 0
payload  = []

for rec in registros:
    layer = rec['layer']
    base = {
        'layer':       layer,
        'cod_faz':     rec['cod_faz'],
        'secao':       rec['secao'],
        'talhao':      rec['talhao'],
        'sist_conser': rec['sist_conser'],
        'mes_plantio': rec['mes_plantio'],
        'updated_at':  _agora,
    }

    if layer in existing:
        ex = existing[layer]
        # Promove mapeamento para 'Sim' se sc virou auto-elegível; nunca rebaixa
        mapeamento_atual = ex.get('mapeamento', 'Não') or 'Não'
        if rec['_mapeamento'] == 'Sim' and mapeamento_atual != 'Sim':
            base['mapeamento'] = 'Sim'
        else:
            base['mapeamento'] = mapeamento_atual
        base['projeto'] = ex.get('projeto') or 'Pendente'
        n_atualizados += 1
    else:
        # Registro novo: status inicial calculado
        base['mapeamento'] = rec['_mapeamento']
        base['projeto'] = 'Pendente' if rec['_mapeamento'] == 'Sim' else 'Aguard. Map.'
        n_novos += 1

    payload.append(base)

print(f"  {n_novos} novos | {n_atualizados} a atualizar")


# ── 4. Upsert em lotes ────────────────────────────────────────────────────────

_BATCH_SIZE = 500
_erros      = 0
_total_lotes = (len(payload) + _BATCH_SIZE - 1) // _BATCH_SIZE

print(f"[{datetime.datetime.now():%H:%M:%S}] Enviando {len(payload)} registros em {_total_lotes} lote(s)...")

for _i in range(0, len(payload), _BATCH_SIZE):
    _lote = payload[_i:_i + _BATCH_SIZE]
    _n_lote = _i // _BATCH_SIZE + 1
    _r = requests.post(
        f"{SUPABASE_URL}/rest/v1/programacao",
        headers={**_SB_HEADERS, 'Prefer': 'resolution=merge-duplicates,return=minimal'},
        json=_lote,
        timeout=60,
    )
    if not _r.ok:
        print(f"  ERRO lote {_n_lote}/{_total_lotes}: {_r.status_code} {_r.text[:300]}")
        _erros += 1
    else:
        print(f"  Lote {_n_lote}/{_total_lotes} OK ({len(_lote)} registros)")

if _erros:
    print(f"\n⚠  {_erros} lote(s) com erro — verificar log.")
else:
    print(f"\n✓ Importação concluída: {n_novos} novos, {n_atualizados} atualizados.")

fechar_log(_log_fh)
