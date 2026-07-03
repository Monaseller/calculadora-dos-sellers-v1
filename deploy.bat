@echo off
cd /d "%~dp0"
if exist .git\index.lock del .git\index.lock
git add -A
git commit -m "audit: correcoes auditoria geral CDS — stub pages historico/comparativo/suporte, dashboard double-load, perfil senha exposta, ML callback sem erro check, email_verificado bypass, DateRangePicker 15/30/90 dias, TopBar avatar dinamico, shopeePost timeout"
git push
echo.
echo === Subindo para o Vercel ===
call npx vercel --prod
echo.
echo Pronto! Build enviado.
pause
