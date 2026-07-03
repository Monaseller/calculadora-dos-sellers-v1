@echo off
cd /d "%~dp0"
if exist .git\index.lock del .git\index.lock
git add -A
git commit -m "fix: filtrar COMPLETED no update_time para prevenir timeout no Historico; fix from7 undefined no cron"
git push
echo.
echo === Subindo para o Vercel ===
call npx vercel --prod
echo.
echo Pronto! Build enviado.
pause
