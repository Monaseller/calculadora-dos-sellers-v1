@echo off
cd /d "%~dp0"
if exist .git\index.lock del .git\index.lock
git add -A
git commit -m "fix: create_time p/ Historico, update_time p/ Cron; timeout shopeeGet 8s->15s; fix from7 cron"
git push
echo.
echo === Subindo para o Vercel ===
call npx vercel --prod
echo.
echo Pronto! Build enviado.
pause
