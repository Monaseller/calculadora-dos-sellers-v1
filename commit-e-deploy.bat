@echo off
cd /d "%~dp0"

echo === Removendo locks ===
del /f /s /q ".git\*.lock" 2>nul

echo === Verificando fim do route.ts ===
tail -5 app\api\ml\vendas\route.ts 2>nul

echo === Commitando melhorias ===
git add -A
git commit -m "feat: agrupamento de variacoes + SKU por variacao + corrige duplicados"

echo.
echo === Deploy no Vercel ===
call npx vercel --prod

echo.
pause
