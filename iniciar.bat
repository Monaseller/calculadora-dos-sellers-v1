@echo off
cd /d "%~dp0"
echo Verificando dependencias...
npm install --silent
echo Iniciando CDS - Calculadora dos Sellers...
echo Abra o navegador em: http://localhost:3000
echo.
npm run dev
