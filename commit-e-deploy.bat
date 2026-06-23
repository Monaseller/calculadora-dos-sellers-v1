@echo off
cd /d "%~dp0"

echo === Removendo locks ===
del /f /s /q ".git\*.lock" 2>nul

echo === Verificando fim do route.ts ===
tail -5 app\api\ml\vendas\route.ts 2>nul

echo === Commitando sync completo MLBU -> MLB ===
git add -A
git commit -m "fix: sync-precos resolve MLBU para MLB real e atualiza ml_item_id permanentemente"

echo.
echo === Deploy no Vercel ===
call npx vercel --prod

echo.
pause
