@echo off
cd /d "%~dp0"

echo === Removendo locks ===
del /f /s /q ".git\*.lock" 2>nul

echo === Removendo tsconfig.tsbuildinfo do git ===
git rm --cached tsconfig.tsbuildinfo 2>nul
echo Feito.

echo === Commitando ===
git add -A
git commit -m "fix: remover tsconfig.tsbuildinfo do git tracking"

echo.
echo === Deploy no Vercel ===
call npx vercel --prod

echo.
pause
