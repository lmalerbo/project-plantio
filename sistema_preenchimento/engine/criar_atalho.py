import os, shutil, subprocess

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PARENT_DIR = os.path.dirname(SCRIPT_DIR)

lnk = os.path.join(PARENT_DIR, 'ATUALIZAR_PROJETOS.lnk')
bat = os.path.join(SCRIPT_DIR, 'ATUALIZAR_PROJETOS.bat')
ico_rede = os.path.join(SCRIPT_DIR, 'favicon.ico')

# Windows não carrega ícones de pastas de rede — copia para pasta local
ico_local_dir = os.path.join(os.environ['LOCALAPPDATA'], 'GEO_Plantio')
os.makedirs(ico_local_dir, exist_ok=True)
ico = os.path.join(ico_local_dir, 'favicon.ico')
shutil.copy2(ico_rede, ico)

ps = f"""
$s = (New-Object -COM WScript.Shell).CreateShortcut('{lnk}')
$s.TargetPath       = '{bat}'
$s.IconLocation     = '{ico},0'
$s.WorkingDirectory = '{SCRIPT_DIR}'
$s.Save()
"""

r = subprocess.run(
    ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
    capture_output=True, text=True, encoding='utf-8'
)
if r.returncode == 0:
    print(f'Atalho criado em:\n  {lnk}')
    print(f'Icone salvo localmente em:\n  {ico}')
else:
    print('Erro:', r.stderr or r.stdout)

input('\nPressione Enter para fechar...')
