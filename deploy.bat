@echo off
cd /d "%~dp0"
if exist .git\index.lock del .git\index.lock
git add -A
git commit -m "fix: shopee sync usa update_time p/ capturar pedidos pagos no dia (era create_time); cron reduzido para [ontem, hoje]"
git push
echo.
echo === Subindo para o Vercel ===
call npx vercel --prod
echo.
echo Pronto! Build enviado.
pause
