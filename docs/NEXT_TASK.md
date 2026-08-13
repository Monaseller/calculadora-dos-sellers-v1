# NEXT_TASK — Estúdio de Anúncios com IA

> Arquivo curto (<100 linhas), muda a cada sessão. É a fonte única do
> estado corrente — nunca o `PROJECT_STATE.md`.
> **Ordem de leitura: `CLAUDE_CONSTITUTION.md` primeiro, este arquivo em
> seguida.** A Constituição (v1.0, congelada) é a autoridade máxima.
> Ao encerrar QUALQUER sessão neste módulo, atualizar este arquivo é
> obrigatório, mesmo que a tarefa não tenha terminado.

---


## Estado corrente — 2026-09-06

**Commit em producao:** `b99007c` · migration `20260906` **aplicada** · 821/821 testes · tsc limpo · build verde.

### Concluido nesta sessao
- Capa `capa_principal` deterministica, **sem IA**: recorte da foto real + fundo branco. Fidelidade medida em foto real: **100,000% dos pixels do produto identicos**, maior diferenca de canal 0.
- Validacao de foto sem IA, com politica de resolucao ancorada no minimo oficial do ML (500px), medindo o **lado util** (caixa do produto).
- Retomada de pipeline em erro (`estudio_anuncios_pipeline_retomar`), append-only e idempotente.
- Proveniencia auditavel com tres checksums e CHECK que impede declaracao falsa.
- `sharp` em producao.

### NAO validado ainda — precisa de acao do usuario
- **Retry real pela interface** (clique em "Tentar novamente"). Exige sessao autenticada.
- **Capa real pelo fluxo do pipeline.** A composicao foi exercitada com o codigo de producao sobre foto real, mas invocada diretamente: chegar nela pelo pipeline exige o retry (clique) + etapas pagas.

### Aberto — ver BUGS.md
- **CAPA1:** o recorte separa fundo de nao-fundo, nao produto de decoracao. Foto promocional com respingos decorativos gera capa fiel porem inadequada para marketplace.
- **CAPA2:** transparencia de vidro PARCIAL. Fundo escuro nao liberado.

### Proxima etapa (aguardando autorizacao)
Cenario hibrido, camada grafica (@vercel/og), regeneracao individual e score visual continuam **fora de escopo** ate revisao desta base.
