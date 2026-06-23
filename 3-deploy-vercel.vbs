Set objShell = CreateObject("WScript.Shell")
objShell.Run "cmd.exe /k ""cd /d C:\Users\USER\Desktop\calculadora-dos-sellers-v1 && echo === Login no Vercel (vai abrir o browser) === && vercel login && echo. && echo === Fazendo deploy === && vercel --prod && echo. && echo === PRONTO! URL acima === && pause""", 1, False
