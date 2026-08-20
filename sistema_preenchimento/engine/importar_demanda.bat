@echo off
REM Importar Demanda PLANAGRI -- roda todo dia cedo pelo Task Scheduler
REM Configurar a tarefa para rodar como o usuario do servidor (com acesso a rede)

cd /d "%~dp0"
py importar_demanda.py
if %ERRORLEVEL% NEQ 0 (
    echo ERRO: importar_demanda.py terminou com codigo %ERRORLEVEL%
    exit /b %ERRORLEVEL%
)
