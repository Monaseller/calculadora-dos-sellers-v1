@echo off
cd /d "%~dp0"

echo === Removendo locks ===
del /f /s /q ".git\*.lock" 2>nul

echo === Verificando fim do route.ts ===
tail -5 app\api\ml\vendas\route.ts 2>nul

echo === Commitando fix contagem de pedidos ===
git add app/api/ml/vendas/route.ts
git add app/vendas/page.tsx
git add -A
git commit -m "fix: usar date_approved BRT para contar pedidos igual ao painel ML"

echo.
echo === Deploy no Vercel ===
call npx vercel --prod

echo.
pause
