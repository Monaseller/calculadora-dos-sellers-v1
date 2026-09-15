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

## CDS IA — Approval/Decision/Resume — 2026-09-15

> Modulo diferente do Estudio de Anuncios. Registrado aqui porque `CLAUDE.md`
> define este arquivo como fonte unica do "onde paramos" do projeto.

**Commit em producao:** `bafce6db4a7feec008d46804d32852d930cb6233` · deployment
`dpl_EGMKrRo7SfezryNZN5Uw8TyCUusb` READY · migration
`20261003_remover_aguardar_aprovacao_tarefa_2args.sql` **aplicada**
(remote version `20260915170748`, remote name
`remover_aguardar_aprovacao_tarefa_2args`) · tsc limpo · build verde.

### Concluido
- **D1 — ponteiro duravel.** `agente_tarefas.aprovacao_aguardada_id`, com FK por dono e
  CHECK "ponteiro so na espera", mais a pausa `aguardar_aprovacao_tarefa(uuid, integer, uuid)`.
- **D2 — caller de producao.** A pausa passou a gravar o id da Approval causal. Provado em
  runtime: tarefa parada com o ponteiro igual ao id da aprovacao que ela aguarda.
- **D3 — limpeza.** A overload legada `aguardar_aprovacao_tarefa(uuid, integer)` foi
  **removida do banco**. Sobrou apenas a de tres argumentos, unica sobrevivente.

### ATENCAO — rollback floor ATIVO
`POST_D3_ROLLBACK_FLOOR = d1998901a404fc034711be0392175da62de05c8e`.
Rollback de codigo para SHA **anterior** a esse e incompativel com o banco atual: o caller
antigo envia dois argumentos e recebe PGRST202. **Nao usar `23fb46c` nem anteriores** com
rollback de deploy sozinho — voltar para pre-floor exigiria antes uma migration forward
recriando a overload de dois argumentos. O Vercel nao conhece esse piso.

### D4 — implementado no codigo e revisado · migration ainda NAO APLICADA
A decisao humana passou a encerrar a tarefa causal. O codigo esta escrito e revisado, mas
**nada disso vale no banco ainda**: a migration
`supabase/migrations/20261004_aprovacao_decidir_encerra_tarefa.sql` continua **UNAPPLIED** e,
enquanto nao for aplicada, o comportamento em producao permanece o antigo — rejeitar uma
aprovacao ainda deixa a tarefa parada para sempre.
- **Mesma assinatura.** `aprovacao_decidir` e recriada com `CREATE OR REPLACE`, sem nova
  overload: nenhum caller precisa mudar.
- **Ordem de travamento:** a **Approval primeiro**, a **Task causal depois** — nunca o inverso.
- **Vinculo exato.** A Task so e alcancada pelo vinculo causal completo; qualquer
  incompatibilidade recusa fail-closed (`tarefa_incompativel`), **antes** de qualquer escrita
  de decisao.
- **approve** deixa a tarefa em `aguardando_aprovacao` com o ponteiro intacto (insumo do D5).
- **reject/cancel** levam a tarefa causal a `cancelado` com ponteiro NULL e invariantes
  terminais, na mesma transacao, sem Tool Call e sem executar Funcao.

### NAO concluido — nao registrar como feito
- **D5 (resume claim / reentrada do worker): nao implementado.**
- **D7 (scanner de aprovacoes expiradas/rejeitadas/canceladas orfas e da corrida C0-R3-L1):
  nao implementado.**
- **API de decisao nao existe** (`/api/aprovacoes` e GET-only) e os botoes **Aprovar/Recusar
  seguem `disabled`**. Nao conectar a UI antes de D5 e D7.

### Dividas registradas (nao sao a proxima tarefa)
- **D3-A0-M1 — OPEN / MEDIUM.** `scripts/testar-agentes-execucao-banco.ts` ainda chama o
  contrato legado de dois argumentos em quatro pontos. **NAO EXECUTAR essa suite.** Criterio de
  saida: migrar para a overload de tres argumentos criando/usando uma Approval causal valida
  (mesma tarefa, dono e agente) e passar EXATAMENTE essa `Approval.id` em `p_aprovacao_id`.
  O marcador esta no topo do proprio arquivo.
- **Tarefa parada legada (pre-D1)** tem `Approval.tarefa_id` preenchido e ponteiro NULL; sob o
  desenho do D4 ela fica nao-decidivel. Cura prevista no D7 ou em reparo forward separado.

### Proxima etapa (aguardando autorizacao)
1. **Versionar e publicar o slice D4** — commit isolado, push e deployment, em gates separados.
2. **Preflight live obrigatorio** no banco antes de tocar na funcao.
3. **Apply controlado** de `20261004_aprovacao_decidir_encerra_tarefa.sql` — uma unica vez.
4. **Prova pos-apply** em runtime; so entao `PROJECT_STATE.md` e atualizado.
5. Depois: **D5** (resume claim).
6. **D7** (scanner/reparo) antes de a UI de decisao ficar alcancavel.

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

---

## CDS — PR #2b-1: callback OAuth Shopee — 2026-08-19

**IMPLEMENTADA, NAO COMMITADA.** Nenhuma alteracao de banco.

### Concluido
- **Bug corrigido (`SHOPEE-OAUTH1` em `BUGS.md`):** o callback derivava o dono de `cds_session` lido CRU. Desde o cutover esse cookie carrega token assinado, nao UUID, e `lojas.user_id` e `uuid` — a comparacao nunca casava. Com os erros do Supabase descartados, a rota devolvia `?ok=shopee` sem gravar. Medido: 3 lojas Shopee, **2 com `user_id` NULL**, ultima criacao 2026-07-02.
- `userId` agora vem **exclusivamente** de `autenticarRequisicao`, e **antes** da troca do `code`.
- Persistencia movida para a capability server-only **`registrarLojaShopeeOAuth`**: `SELECT` escopado por `user_id`+`marketplace`+`seller_id`, `UPDATE` tenant-aware confirmado pela linha afetada, `INSERT` com o dono da sessao, e `23505` tratado como criacao concorrente (rele e atualiza).
- **`upsert` deliberadamente NAO usado:** `UNIQUE (seller_id, user_id)` nao inclui `marketplace`, e `seller_id` e generica entre marketplaces — um upsert cego poderia sobrescrever a linha de ML do proprio usuario.
- **Modelo A de ownership confirmado** (medicao do ML: 3 donos distintos para o mesmo seller): mesma conta externa pode ter uma linha por usuario CDS.
- Falha de persistencia **nunca** termina em `?ok=shopee` — novos `?erro=shopee_sessao`, `shopee_persistencia`, `shopee_duplicidade`.
- Fallback de `partner_id`/`partner_key` por cookie removido (era codigo morto — nada emitia `shopee_partner_*`).
- Logs saneados: nenhum recebe `tokenData`, token, `partner_key` ou corpo bruto do provedor.
- Trava de inventario de `testar-autenticacao.ts` subiu 41 -> 42, registrando a entrada da rota na camada.

### NAO concluido — nao registrar como feito
- **`SHOPEE-OAUTH2` (aberto):** o fluxo Shopee **nao tem `state`**. Permite associacao induzida (CSRF) da loja do atacante a conta da vitima. Exige comprovar que a Shopee preserva parametros no `redirect` do `auth_partner`. **PKCE nao se aplica** ao fluxo usado.
- `partner_key` continua persistida em `lojas` (3 rotas admin ainda a leem do banco) — e um segredo GLOBAL de ambiente replicado por linha.
- ML callback, `lojas/desconectar` e `lojas/ativar` seguem como bypass arquitetural de capability — **PR #2b** propriamente dita.

### Proxima etapa
**PR #2b** (restante): migrar os tres bypasses remanescentes para a capability. Depois, **PR #2c** — reduzir privilegio de `anon` em `lojas`.

---

## CDS — SHOPEE-DEBUG1: rota de diagnostico removida — 2026-08-19

**IMPLEMENTADA, NAO COMMITADA.** Nenhuma alteracao de banco.

### O que a rota expunha
`app/api/auth/shopee/debug/route.ts` devolvia, em JSON, **a qualquer usuario autenticado**:
- `partnerKeyLength`, `partnerKeyStart` (8 primeiros) e `partnerKeyEnd` (8 ultimos) da `SHOPEE_PARTNER_KEY` — **segredo GLOBAL da aplicacao**, nao por loja;
- `baseString` da assinatura;
- **tres assinaturas HMAC validas** sobre esse baseString (`sign_key_as_string`, `sign_no_shpk_string`, `sign_no_shpk_hex_decoded`);
- **duas URLs de autorizacao Shopee ja assinadas e prontas para uso** (`url_sign1`, `url_sign3`).

Os pares (baseString, HMAC) servem de oraculo para verificacao offline de chave adivinhada — combinados com o comprimento e os 16 caracteres conhecidos.

**Vetor adicional POTENCIAL, nao comprovado.** A implementacao local calcula a assinatura sobre `partner_id + path + timestamp` (`app/api/auth/shopee/route.ts:22`), e a `redirect` **nao entra nessa baseString local**. Isso levanta a hipotese de que uma URL assinada exposta pudesse ter o `redirect` trocado. **Nao esta comprovado** — depende inteiramente da politica server-side da Shopee: se ela aceita `redirect` arbitrario, se ha whitelist/matching exato, e se a assinatura permaneceria valida apos a troca. Nenhum desses pontos foi verificado; a documentacao oficial (`open.shopee.com`) nao esteve acessivel na auditoria. Fica classificado como **vetor potencial condicionado a politica de validacao de redirect da Shopee**, na mesma familia de evidencia pendente do `SHOPEE-OAUTH2`.

A severidade e a decisao de remover a rota **nao dependem** dessa hipotese: a exposicao de fragmentos da chave, do baseString e de HMACs validos ja basta.

### Decisao
**Rota REMOVIDA integralmente.** Nenhum consumidor legitimo: zero referencias em frontend, script ou codigo de producao. A remocao ja estava planejada pelo proprio projeto — o teste 17 de `testar-middleware.ts` registrava "Remocao definitiva em F0.d".

Exigir sessao **nao** era solucao: reduzia a superficie, nao tornava aceitavel expor material derivado de segredo global.

### Guarda de regressao
`scripts/testar-middleware.ts` ganhou o teste **19**, que falha se o arquivo voltar a existir — mesmo padrao do assert "lib/session.ts nao existe mais" em `testar-autenticacao.ts`. Os testes 17 e 18 foram **mantidos** de proposito: se o caminho reaparecer, tem de nascer bloqueado.

### NAO alterado nesta tarefa
Callback OAuth, fluxo de conexao, `SHOPEE-OAUTH2`, banco, credenciais.
