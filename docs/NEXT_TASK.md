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

---

## CDS — SEC-1: privilegios do schema public — 2026-08-19

**APLICADA NO BANCO.** Migration em `supabase/migrations/20260819_sec1_revogar_privilegios_nao_utilizados.sql` — **ainda NAO commitada**.

### Concluido
- **33 tabelas** de `public` protegidas: `anon` e `authenticated` perderam `DELETE`, `TRUNCATE`, `TRIGGER`, `REFERENCES`, `MAINTAIN`.
- **Default privileges corrigidos** (`FOR ROLE postgres IN SCHEMA public ON TABLES`): tabela nova nasce concedendo apenas `INSERT, SELECT, UPDATE` a `anon`/`authenticated` — impede regressao.
- `service_role` e `postgres`/owner **inalterados**, conferidos por `has_table_privilege` antes e depois.
- Sequences, functions/RPCs, RLS e policies **nao tocadas**.
- Verificacao 100% por metadado; nenhuma operacao destrutiva executada.

### NAO concluido — nao registrar como feito
- `SELECT`, `INSERT` e `UPDATE` de `anon`/`authenticated` **continuam abertos nas 33 tabelas**. Leitura e alteracao anonima de `pedidos`, `perfil` e das colunas de credencial de `lojas` seguem possiveis.
- RLS continua ausente em 31 tabelas.
- Sequences: `anon` mantem `SELECT, UPDATE, USAGE` (permite `setval()`) — gate proprio.
- **SEC-1C pendente**: default `EXECUTE` de FUNCTIONS para `anon`/`authenticated` nao foi alterado.

### Proxima superficie prioritaria
`SELECT` / `INSERT` / `UPDATE` de `anon`. A PR #2 deve ser **incremental e orientada pelos fluxos reais**, nunca uma revogacao em bloco: 13 rotas de producao usam a chave anon hoje. Auditoria estatica ja identificou 4 bypasses de credencial fora da capability da PR #1 (`auth/mercadolivre/callback`, `auth/shopee/callback`, `lojas/desconectar`, `lojas/ativar`) e 5 `select("*")`.

---

## CDS — SEC-2a: role `authenticated` removida de public — 2026-08-19

**APLICADA NO BANCO.** Migration em `supabase/migrations/20260819_sec2a_revogar_authenticated_nao_utilizado.sql` — **ainda NAO commitada**.

### Concluido
- `authenticated` perdeu `SELECT`, `INSERT` e `UPDATE` nas **33 tabelas**. Somada a SEC-1, a role ficou **sem nenhum privilegio de tabela** em `public`.
- **Default privileges corrigidos**: tabela nova criada por `postgres` nao concede nada a `authenticated`.
- Justificativa comprovada: o CDS **nao usa Supabase Auth** (zero ocorrencias de `supabase.auth` no repositorio); autenticacao e propria via `perfil` + cookie `cds_session`. Nenhuma sessao real assume essa role.
- **`anon` preservado** com `SELECT, INSERT, UPDATE` — verificado em 33/33 simultaneamente ao teste negativo.
- `service_role` e `postgres`/owner inalterados. Sequences, functions/RPCs, RLS e policies nao tocadas.
- Teste negativo 100% estrutural (`has_table_privilege`); nenhuma mutacao de dado executada.

### NAO concluido — nao registrar como feito
- **PR #2b NAO iniciada.** Os 4 bypasses de credencial continuam usando `anon`.
- `anon` segue com `SELECT/INSERT/UPDATE` nas 33 — a superficie realmente explorada hoje **nao mudou**.
- `authenticated` mantem defaults de **sequences** (`SELECT, UPDATE, USAGE`) — fora do escopo, gate proprio.
- SEC-1C (default `EXECUTE` de FUNCTIONS) continua pendente.

### Proxima etapa
**PR #2b** — fechar os quatro bypasses de credencial (`auth/mercadolivre/callback`, `auth/shopee/callback`, `lojas/desconectar`, `lojas/ativar`), estendendo a capability `lib/marketplace/credenciais.ts` com criacao e anulacao. E pre-requisito de qualquer reducao de privilegio de `anon` em `lojas` (PR #2c).
