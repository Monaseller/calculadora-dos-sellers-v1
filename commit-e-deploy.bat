@echo off
cd /d "%~dp0"

echo === Removendo locks ===
del /f /s /q ".git\*.lock" 2>nul

echo === Verificando fim do route.ts ===
tail -5 app\api\ml\vendas\route.ts 2>nul

echo === Commitando fix thumbnails MLBU (remover items/search errado) ===
git add -A
git commit -m "fix: sync-precos remove items/search que retornava foto errada para MLBU"

echo.
echo === Deploy no Vercel ===
call npx vercel --prod

echo.
pause
