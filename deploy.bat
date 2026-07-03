@echo off
cd /d "%~dp0"
if exist .git\index.lock del .git\index.lock
git add -A
git commit -m "fix: dashboard faturamento - passa lojasSelecionadas explicitamente no useEffect (stale closure)"
git push
echo.
echo === Subindo para o Vercel ===
call npx vercel --prod
echo.
echo Pronto! Build enviado.
pause
