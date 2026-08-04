@echo off
setlocal
set "AQUI=%~dp0"
set "AQUI=%AQUI:~0,-1%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=(New-Object -COM WScript.Shell).CreateShortcut('%AQUI%\ATUALIZAR_PROJETOS.lnk');$s.TargetPath='%AQUI%\ATUALIZAR_PROJETOS.bat';$s.IconLocation='%AQUI%\engine\favicon.ico,0';$s.WorkingDirectory='%AQUI%';$s.Save();Write-Host 'Atalho criado!'"
echo.
echo Atalho ATUALIZAR_PROJETOS.lnk criado com icone GEO.
echo Pode fechar esta janela.
pause
