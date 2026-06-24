"""Utilitários compartilhados entre os scripts da engine."""

import os
import re
import unicodedata
import datetime


# ── Normalização de texto (remove acentos, upper) ─────────────────────────

def strip_accents(s):
    if s is None:
        return ''
    return ''.join(c for c in unicodedata.normalize('NFKD', str(s)) if not unicodedata.combining(c))


def norm_header(s):
    """Normaliza nome de cabeçalho de coluna: sem acento, upper, sem espaços nas pontas."""
    return strip_accents(s).strip().upper()


# ── Mês (PT) → número 1-12 ──────────────────────────────────────────────

_MESES_PT = {
    'JANEIRO': 1, 'FEVEREIRO': 2, 'MARCO': 3, 'ABRIL': 4, 'MAIO': 5, 'JUNHO': 6,
    'JULHO': 7, 'AGOSTO': 8, 'SETEMBRO': 9, 'OUTUBRO': 10, 'NOVEMBRO': 11, 'DEZEMBRO': 12,
}


def mes_to_periodo(v):
    """Converte nome de mês em português (com ou sem acento) para número 1-12."""
    if v is None:
        return None
    return _MESES_PT.get(norm_header(v))


# ── Talhões: explode célula (lista, faixa, ou número corrompido) em ints ──

def parse_talhoes(raw):
    """Expande o valor de uma célula 'TALHÕES' em uma lista de números de talhão.

    Trata os formatos encontrados na planilha real:
      - inteiro único:            5        → [5]
      - lista separada por vírgula: "1,2,3" → [1, 2, 3]
      - faixa:                    "1 AO 4" → [1, 2, 3, 4]
      - anotações extras:         "(13P)", "1,2 LARANJA" → dígitos extraídos de cada item
      - float corrompido pelo Excel ao digitar "X,Y" com X/Y de 1 talhão cada
        (vírgula interpretada como separador decimal): 1.2 → [1, 2], 10.11 → [10, 11]
    """
    if raw is None:
        return []
    if isinstance(raw, bool):
        return []
    if isinstance(raw, int):
        return [raw]
    if isinstance(raw, float):
        s = repr(round(raw, 4))
        if '.' not in s:
            return [int(raw)]
        intpart, frac = s.split('.', 1)
        frac = frac.rstrip('0')
        if not frac:
            return [int(raw)]
        try:
            return [int(intpart), int(frac)]
        except ValueError:
            return [int(raw)]

    s = str(raw).strip()
    if not s:
        return []

    out = []
    for tok in re.split(r'[,;]', s):
        tok = tok.strip()
        if not tok:
            continue
        m = re.fullmatch(r'(\d+)\s*A[OÀ]\s*(\d+)', tok, re.IGNORECASE)
        if m:
            a, b = int(m.group(1)), int(m.group(2))
            out.extend(range(min(a, b), max(a, b) + 1))
            continue
        digits = re.findall(r'\d+', tok)
        if digits:
            out.append(int(digits[0]))
    return out


# ── Cabeçalho de planilha (linha + posição de cada coluna nomeada) ───────

def achar_header(ws, obrigatorios, max_row=15, max_col=None):
    """Procura nas primeiras linhas da planilha por uma linha contendo todos os
    cabeçalhos normalizados em `obrigatorios`. Retorna (linha, {header_norm: col_idx_0based}).

    `max_col` limita a busca a um bloco de colunas — necessário na aba Sequencia
    da planilha de plantio, onde o bloco "MUDA" (fora de escopo) repete nomes de
    coluna como Código/Seção/Talhão."""
    for i, row in enumerate(ws.iter_rows(min_row=1, max_row=max_row, max_col=max_col, values_only=True), start=1):
        norms = [norm_header(c) for c in row]
        if all(h in norms for h in obrigatorios):
            return i, {norms[j]: j for j in range(len(norms)) if norms[j]}
    return None, {}


# ── Datas de célula Excel → ISO ────────────────────────────────────────────

def data_para_iso(v):
    if isinstance(v, datetime.datetime):
        return v.date().isoformat()
    if isinstance(v, datetime.date):
        return v.isoformat()
    return None


# ── Normalização de Sist. Conser. (nomenclatura bagunçada da planilha) ────
# A coluna SISTEMA DE CONSERVAÇÃO da planilha de Preparo chega com grafias
# inconsistentes — normaliza pra um rótulo canônico único por situação:
#   '-', 'SEM DADOS' (e variações de acento/maiúscula) → ''  (vazio)
#   'BASE LARGA'                                        → 'Base larga'
#   'EMBUTIDO' / 'INTERCALADA' / 'INTERCALADO'           → 'Embutido'
# Mantenha esta função em sincronia com normalizaSistConser() no formulario.html
# — não há como compartilhar código entre JS e Python aqui.

def normaliza_sist_conser(v):
    if v is None:
        return ''
    s = norm_header(v)
    if s in ('', '-', 'SEM DADOS', 'SEM DADO'):
        return ''
    if s == 'BASE LARGA':
        return 'Base larga'
    if s in ('EMBUTIDO', 'INTERCALADA', 'INTERCALADO'):
        return 'Embutido'
    return s


# ── Rollup de Sist. Conser. por bloco (mesma regra usada em formulario.html) ──
# Qualquer talhão Embutido no bloco → bloco inteiro vira 'Embutido'.
# Sem nenhum, vale o valor ('Base larga' ou '') com mais ocorrências.
# Mantenha esta lógica em sincronia com SIST_CONSER_PRECISA_MAPEAMENTO/rollupSistConser
# no formulario.html — não há como compartilhar código entre JS e Python aqui.

SIST_CONSER_PRECISA_MAPEAMENTO = {'Embutido'}


def rollup_sist_conser(valores):
    vals = [v for v in valores if v]
    if not vals:
        return ''
    if any(v in SIST_CONSER_PRECISA_MAPEAMENTO for v in vals):
        return 'Embutido'
    from collections import Counter
    return Counter(vals).most_common(1)[0][0]


# ── Normalização de LAYER ──────────────────────────────────────────────────

def layer_to_str(v):
    """Converte qualquer representação de LAYER para string inteira padronizada.

    Trata floats do pandas (1001005.0), strings ("1001005"), ints (1001005) e
    casos inválidos (None, '', 'nan') de forma uniforme.
    """
    if v is None:
        return ''
    try:
        s = str(v).strip()
        if s in ('', 'nan'):
            return ''
        return str(int(float(s)))
    except (ValueError, TypeError):
        return ''


# ── Logging persistente ────────────────────────────────────────────────────

class _TeeWriter:
    """Encaminha escrita para múltiplos writers (console + arquivo)."""

    def __init__(self, *writers):
        self._writers = writers

    def write(self, text):
        for w in self._writers:
            try:
                w.write(text)
            except Exception:
                pass

    def flush(self):
        for w in self._writers:
            try:
                w.flush()
            except Exception:
                pass

    def isatty(self):
        return False


def redirecionar_stdout(log_path):
    """Redireciona sys.stdout para escrever simultaneamente no console e em log_path.

    Deve ser chamado no início do script. Retorna o handle do arquivo de log
    para que possa ser fechado ao final, se necessário.
    """
    import sys
    os.makedirs(os.path.dirname(os.path.abspath(log_path)), exist_ok=True)
    try:
        log_fh = open(log_path, 'a', encoding='utf-8')
    except Exception:
        return None

    ts = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    log_fh.write(f'\n{"="*60}\n[{ts}] Sessão iniciada\n{"="*60}\n')
    log_fh.flush()

    sys.stdout = _TeeWriter(sys.__stdout__, log_fh)
    return log_fh


def fechar_log(log_fh):
    """Fecha o handle do log e restaura sys.stdout."""
    import sys
    if log_fh is None:
        return
    try:
        ts = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        log_fh.write(f'[{ts}] Sessão encerrada\n')
        log_fh.flush()
        log_fh.close()
    except Exception:
        pass
    finally:
        try:
            sys.stdout = sys.__stdout__
        except Exception:
            pass
