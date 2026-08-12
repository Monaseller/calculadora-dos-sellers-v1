' ─────────────────────────────────────────────────────────────────────
' 4-configurar-env-vercel.vbs
'
' ATENCAO (2026-09-01): este arquivo continha CREDENCIAIS REAIS em texto
' puro — ML_CLIENT_SECRET, a URL do Supabase e a chave publishable —
' passadas por `echo` para `vercel env add`. O repositorio e PUBLICO no
' GitHub, entao esses valores ficaram expostos desde o commit ebd4400.
'
' Os valores foram removidos daqui, mas **isso nao desfaz a exposicao**:
' eles continuam no historico publico do Git e podem ja ter sido
' clonados ou indexados. A unica correcao real e ROTACIONAR o segredo no
' painel de desenvolvedor do Mercado Livre e atualizar a variavel na
' Vercel. Ver docs/BUGS.md.
'
' O historico NAO foi reescrito de proposito: reescrever nao remove o que
' ja e publico, quebra clones existentes, e e uma decisao de quem
' administra o repositorio — nao um efeito colateral de uma tarefa de
' preparacao de deploy.
'
' Se precisar configurar variaveis de novo, use o painel da Vercel ou
' `vercel env add NOME production` SEM `echo`: o CLI pergunta o valor de
' forma interativa e ele nao fica no script, no historico do shell nem
' no Git.
' ─────────────────────────────────────────────────────────────────────
Set objShell = CreateObject("WScript.Shell")
objShell.Run "cmd.exe /k ""echo Este script foi desativado por conter credenciais. && echo Use: vercel env add NOME production  (o CLI pergunta o valor) && pause""", 1, False
