@echo off
cd /d "%~dp0"

echo === Removendo locks ===
del /f /s /q ".git\*.lock" 2>nul

echo === Verificando fim do route.ts ===
tail -5 app\api\ml\vendas\route.ts 2>nul

echo === Commitando correcao do syntax error ===
git add app/api/ml/vendas/route.ts
git add -A
git commit -m "fix: corrigir syntax error no route.ts (remover linhas extras)"

echo.
echo === Deploy no Vercel ===
call npx vercel --prod

echo.
pause
