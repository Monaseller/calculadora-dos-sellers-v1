Set objShell = CreateObject("WScript.Shell")
objShell.Run "cmd.exe /k ""cd /d C:\Users\USER\Desktop\calculadora-dos-sellers-v1 && echo https://calculadora-dos-sellers-v1.vercel.app/api/auth/mercadolivre/callback | vercel env add ML_REDIRECT_URI production --force && vercel --prod && echo. && echo === PRONTO! Agora atualize o ML Developer Console === && pause""", 1, False
