@echo off
cd /d "%~dp0"

echo === Removendo locks ===
del /f /s /q ".git\*.lock" 2>nul

echo === Verificando fim do route.ts ===
tail -5 app\api\ml\vendas\route.ts 2>nul

echo === Commitando reverter date_approved (piorou: 380 -> 371) ===
git add app/api/ml/vendas/route.ts
git add app/vendas/page.tsx
git add -A
git commit -m "revert: voltar date_created BRT (date_approved deixou 371 vs 380)"

echo.
echo === Deploy no Vercel ===
call npx vercel --prod

echo.
pause
