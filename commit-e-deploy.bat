@echo off
cd /d "%~dp0"

echo === Removendo locks ===
del /f /s /q ".git\*.lock" 2>nul

echo === Commitando ===
git add -A
git commit -m "fix: frete Full usa tabela ME2 com proxy de peso + extrai peso da API ML"

echo.
echo === Deploy no Vercel ===
call npx vercel --prod

echo.
pause
