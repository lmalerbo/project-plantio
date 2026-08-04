@echo off
setlocal
set "E=%~dp0"
set "E=%E:~0,-1%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$e='%E%';$p=Split-Path $e;$s=(New-Object -COM WScript.Shell).CreateShortcut(\"$p\ATUALIZAR_PROJETOS.lnk\");$s.TargetPath=\"$e\ATUALIZAR_PROJETOS.bat\";$s.IconLocation=\"$e\favicon.ico,0\";$s.WorkingDirectory=$e;$s.Save();Write-Host 'Atalho criado em:' $p"
echo.
echo Atalho ATUALIZAR_PROJETOS.lnk criado na pasta da planilha.
echo Pode fechar esta janela.
pause
