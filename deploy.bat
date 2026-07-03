@echo off
cd /d "%~dp0"
if exist .git\index.lock del .git\index.lock
git add -A
git commit -m "fix: corrige 4 bugs criticos de sync ML+Shopee — COMPLETED filter, ML cap 1k, noBuffer ML, retry backoff; adiciona campos frete_real/rastreio/imagem/comprador"
git push
echo.
echo === Subindo para o Vercel ===
call npx vercel --prod
echo.
echo Pronto! Build enviado.
pause
