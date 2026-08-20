@echo off
REM Sincronizar Planilha (Supabase -> Sequencia Plantio) -- roda no final do expediente
REM Requer Excel instalado no servidor e planilha fechada por todos no momento de execucao

cd /d "%~dp0"
py sincronizar_planilha.py
if %ERRORLEVEL% NEQ 0 (
    echo ERRO: sincronizar_planilha.py terminou com codigo %ERRORLEVEL%
    exit /b %ERRORLEVEL%
)
