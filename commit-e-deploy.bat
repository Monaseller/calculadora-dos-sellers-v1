@echo off
cd /d "%~dp0"

echo === Removendo locks ===
del /f /s /q ".git\*.lock" 2>nul

echo === Commitando correcao ===
git add -A
git commit -m "fix: remover tsconfig.tsbuildinfo (caminhos Windows incompativeis com Vercel)"

echo.
echo === Deploy no Vercel ===
call npx vercel --prod

echo.
pause
