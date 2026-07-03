@echo off
cd /d "%~dp0"
if exist .git\index.lock del .git\index.lock
git add -A
git commit -m "feat: historico auto-start sem config; progresso direto; mensagem pos-sync; re-sincronizar btn"
git push
echo.
echo === Subindo para o Vercel ===
call npx vercel --prod
echo.
echo Pronto! Build enviado.
pause
