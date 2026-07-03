@echo off
cd /d "%~dp0"
if exist .git\index.lock del .git\index.lock
git add -A
git commit -m "feat: teste rapido 1 dia no Historico; progresso por dia nos meses; Sincronizar Shopee ontem+hoje"
git push
echo.
echo === Subindo para o Vercel ===
call npx vercel --prod
echo.
echo Pronto! Build enviado.
pause
