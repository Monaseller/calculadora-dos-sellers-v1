Set objShell = CreateObject("WScript.Shell")
objShell.Run "cmd.exe /k ""cd /d C:\Users\USER\Desktop\calculadora-dos-sellers-v1 && echo Instalando dependencias... && npm install @supabase/supabase-js && echo. && echo Iniciando servidor... && npm run dev"""
