Set objShell = CreateObject("WScript.Shell")
objShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ""winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements; Write-Host ''; Write-Host '=== Git instalado! Feche esta janela e rode o 1-iniciar-git.vbs ===' -ForegroundColor Green; pause""", 1, False
