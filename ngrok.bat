@echo off
set NGROK="C:\Users\USER\AppData\Local\Microsoft\WinGet\Packages\Ngrok.Ngrok_Microsoft.Winget.Source_8wekyb3d8bbwe\ngrok.exe"
echo Iniciando ngrok...
echo Dominio: flap-gothic-launder.ngrok-free.dev
echo Porta: 3001
echo.
%NGROK% http --domain=flap-gothic-launder.ngrok-free.dev 3001
