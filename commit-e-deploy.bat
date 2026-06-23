@echo off
cd /d "%~dp0"
echo === Removendo todos os locks do Git ===
del /f /s /q ".git\*.lock" 2>nul
echo Locks removidos.
echo.

echo === Commitando ===
git add -A
git commit -m "fix: remover chamadas /shipments, corrigir truncamento route.ts"

echo.
echo === Fazendo push ===
git push --set-upstream origin main

echo.
echo === Concluido! ===
echo Acesse: https://vercel.com/liga-dos-sellers/calculadora-dos-sellers-v1
echo.
pause
