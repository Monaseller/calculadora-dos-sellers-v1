@echo off
cd /d "%~dp0"

echo === Removendo locks ===
del /f /s /q ".git\*.lock" 2>nul

echo === Verificando fim do route.ts ===
tail -5 app\api\ml\vendas\route.ts 2>nul

echo === Commitando fix thumbnails MLBU via buy_box_winner ===
git add -A
git commit -m "fix: sync-precos busca thumbnail MLBU via products/buy_box_winner/items"

echo.
echo === Deploy no Vercel ===
call npx vercel --prod

echo.
pause
