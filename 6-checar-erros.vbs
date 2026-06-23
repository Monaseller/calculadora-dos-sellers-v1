Set objShell = CreateObject("WScript.Shell")
objShell.Run "cmd.exe /k ""cd /d C:\Users\USER\Desktop\calculadora-dos-sellers-v1 && npm run build > build-log.txt 2>&1 && echo BUILD OK || echo BUILD FAILED & type build-log.txt && pause""", 1, False
