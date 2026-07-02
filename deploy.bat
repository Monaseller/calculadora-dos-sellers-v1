@echo off
cd /d "%~dp0"
if exist .git\index.lock del .git\index.lock
git add -A
git commit -m "fix: timeout Historico 15s->55s, CONCURRENCY 5->10, UPSERT_BATCH 100->250, elimina dupla getShopeeLojaAtiva"
git push
echo.
echo Deploy enviado! Aguarde o Vercel fazer o build.
pause
