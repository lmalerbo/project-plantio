import os, subprocess

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PARENT_DIR = os.path.dirname(SCRIPT_DIR)

lnk = os.path.join(PARENT_DIR, 'ATUALIZAR_PROJETOS.lnk')
bat = os.path.join(SCRIPT_DIR, 'ATUALIZAR_PROJETOS.bat')
ico = os.path.join(SCRIPT_DIR, 'favicon.ico')

ps = f"""
$s = (New-Object -COM WScript.Shell).CreateShortcut('{lnk}')
$s.TargetPath      = '{bat}'
$s.IconLocation    = '{ico},0'
$s.WorkingDirectory = '{SCRIPT_DIR}'
$s.Save()
"""

r = subprocess.run(
    ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
    capture_output=True, text=True, encoding='utf-8'
)
if r.returncode == 0:
    print(f'Atalho criado em:\n  {lnk}')
else:
    print('Erro:', r.stderr or r.stdout)

input('\nPressione Enter para fechar...')
