Set objShell = CreateObject("WScript.Shell")
objShell.Run "cmd.exe /k ""cd /d C:\Users\USER\Desktop\calculadora-dos-sellers-v1 && echo === Fazendo novo deploy === && vercel --prod && echo. && echo === PRONTO! === && pause""", 1, False
