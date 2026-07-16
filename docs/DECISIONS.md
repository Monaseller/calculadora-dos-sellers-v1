# DECISIONS.md — Decisões de arquitetura/produto (CDS)

> Registrar toda decisão relevante com data, contexto, alternativas consideradas e motivo da escolha. Decisões pendentes ficam na seção "Em aberto" até serem resolvidas.

## Decisão de arquitetura — separação de três datas (2026-07-06)

**Status: APROVADA pelo usuário, com respostas explícitas aos 5 pontos abaixo. Migration de schema (Fase A) escrita em `supabase/migrations/20260706_separacao_datas.sql` — arquivo criado, NÃO executado no banco ainda (aguardando o usuário rodar manualmente no SQL Editor do Supabase). Fases B/C/D (sync, API, frontend) ainda não iniciadas.**

### Respostas do usuário aos 5 pontos (2026-07-06)

1. **Nomenclatura genérica:** confirmado — `data_criacao`/`data_pagamento`/`data_atualizacao` são os nomes oficiais da CDS; cada marketplace mapeia seu próprio campo nativo internamente (não `create_time`/`pay_time`/`update_time` como se fossem universais).
2. **Pedido sem pagamento — regra final (mais estrita que a proposta inicial):** se tem `pay_time`, usa `data_pagamento`. Se não tem, `data_pagamento` fica **NULL** (não cai automaticamente para `data_criacao` dentro do campo). Visão financeira exclui pedidos com `data_pagamento` NULL. Visão operacional usa `data_criacao` para esses pedidos. O fallback é decisão de qual coluna a *view/query* usa, não um valor substituto gravado no campo. Ver `BUSINESS_RULES.md`.
3. **Sync incremental por `data_atualizacao`:** confirmado como não-genérico por enquanto — Shopee usa `update_time`; ML continua com a estratégia atual (`date_created` + buffer) até existir uma solução seguindo o padrão de notificação do ML. Não bloqueia a Fase A/B.
4. **Bug de status obsoleto:** confirmado como problema separado, meramente preparado por esta migration (coluna `data_atualizacao_marketplace`, não populada ainda) — não resolvido agora.
5. **Backfill histórico:** confirmado que NÃO haverá backfill agressivo. `data` (coluna existente) permanece como fallback para pedidos sincronizados antes desta migration. `data_criacao`/`data_pagamento` nascem NULL em pedidos antigos e só são preenchidas em novos syncs/resyncs (Fase B, ainda não implementada). Limitação documentada em `BUSINESS_RULES.md` e nos comentários da própria migration SQL.

Contexto: a investigação do gap de 12 pedidos (`BUGS.md`) expôs que o campo único `pedidos.data` hoje mistura semânticas diferentes dependendo do modo de sync que escreveu por último (`create_time` no histórico/manual, `pay_time` no cron) — isso é sintoma direto de nunca ter existido uma separação formal entre "quando o pedido foi criado" e "quando foi pago". O usuário decidiu formalizar três conceitos: data de criação (auditoria, nunca financeiro), data de pagamento (regra oficial para toda métrica financeira, com seletor no dashboard) e data de atualização (uso interno de sync, nunca relatório). Regra completa em `BUSINESS_RULES.md`.

## Encerramento formal da auditoria financeira Shopee (2026-07-10)

Decisão: encerrar a etapa de auditoria/reconciliação financeira e iniciar a etapa de arquitetura de performance (camada de resumos diários). Registro consolidado do que foi confirmado nesta etapa, para não depender do histórico de conversa:

1. **`get_order_detail` não fornece `income_distribution`** — o campo vem sempre zerado/ausente nesse endpoint para contas Open Platform Brasil. Confirmado empiricamente antes de partir para `get_escrow_detail`.
2. **Os dados financeiros oficiais vêm de `/api/v2/payment/get_escrow_detail`** — confirmado ao vivo, funcionando para BR, validado em mais de 7.500 pedidos reais sem nenhum erro de permissão/endpoint inexistente.
3. **A reconciliação financeira foi validada** — pipeline completo (seleção, ordenação, idempotência, rateio proporcional por item, dry-run/force, orquestração em lotes via script local) testado em escala crescente (5 → 7.500+ pedidos), com checagens de integridade (sem gravação parcial, sem duplicata) confirmadas por SQL.
4. **`escrow_amount` usa `escrow_amount_after_adjustment` como valor principal** (fallback para `escrow_amount` quando o primeiro não vier) — é o valor final pós-ajustes reais da Shopee (DIFAL, débitos fiscais, correções pós-reembolso). Ver `BUSINESS_RULES.md`.
5. **`has_income_data=true` sempre que a Shopee retornar um `order_income` válido**, independente do sinal de `escrow_amount` (zero = devolução total, negativo = débito pós-reembolso são eventos financeiros reais, não "dado ausente"). Ver `BUSINESS_RULES.md`.
6. **Paginação das APIs de vendas foi corrigida** — `.range()` em página de 1000 linhas em `app/api/shopee/vendas/route.ts`/`app/api/ml/vendas/route.ts`, eliminando o truncamento silencioso do PostgREST no limite padrão de linhas.
7. **A fórmula exata de "Vendas sem os descontos da plataforma" permanece sem confirmação** — ver seção própria acima ("Métrica 'Vendas sem os descontos da plataforma'... encerrada sem fórmula, com ressalvas"). Não reaberta nesta etapa.
8. **`seller_product_rebate` não vira regra oficial** — não implementar como fórmula de negócio enquanto o item acima não for resolvido.
9. **O faturamento atual (`item_subtotal` com fallback para `faturamento`/`total_amount`) permanece a regra vigente** até nova decisão explícita — não alterado por esta auditoria.

Também nesta etapa: removido o bloco de log temporário em `lib/sync-shopee.ts` (`console.log("[AUDITORIA] order completo (bruto)"...)`) que imprimia o pedido inteiro, incluindo dados de comprador, no terminal a cada sync — não tinha mais função depois da validação do formato de `income_distribution`.

A partir daqui, o foco passa a ser a camada de performance (resumos diários pré-agregados) — ver `ROADMAP.md`. Reconciliação dos ~56 mil pedidos pendentes segue disponível via `scripts/reconciliar-lotes.mjs`, mas não é bloqueante para o início da etapa de performance.

## Decisão de arquitetura — loja_id como referência principal (2026-07-11)

**Status: APROVADA pelo usuário. Migrations escritas, NÃO executadas ainda — aguardando revisão manual antes de rodar no SQL Editor do Supabase.**

### Redesenho do botão "Sincronizar" (sync_jobs) — 2026-07-11

**Status: APROVADO pelo usuário após duas rodadas de correção. Implementado (código); migration `supabase/migrations/20260711_sync_jobs.sql` NÃO executada ainda.**

Correções obrigatórias do usuário, todas endereçadas na implementação:
1. Nada de fire-and-forget dentro de rota HTTP → job assíncrono processado por processo separado (`scripts/sync-worker.mjs`).
2. Nada de inferir conclusão por `pedidos.synced_at` → status persistente em `sync_jobs`, polling por `job_id` (nunca `loja_id` — evita confundir com job antigo concluído).
3. Lock não pode ser só `Map` em memória → índice único parcial no Postgres (`sync_jobs (loja_id) WHERE status IN ('pendente','rodando')`) + aquisição atômica via `FOR UPDATE SKIP LOCKED` (`claim_next_sync_job()`), resolvendo dois problemas distintos: duplicidade de job por loja, e dois workers pegando o mesmo job.
4. Timeout fixo rejeitado → `heartbeat_em`, atualizado a cada 30s pelo worker; só considerado abandonado com heartbeat mais velho que `SYNC_JOB_STALE_MINUTES` (10, aprovado).
5. Sync cotidiano (tela Vendas) não aceita período arbitrário do cliente → `POST /api/sync/iniciar` recebe só `{ loja_id }`; servidor calcula `ontem..hoje` (America/Sao_Paulo). Período largo é outro tipo de job (`tipo='backfill'`, coluna já existe, uso interno futuro — não criado pela tela Vendas).
6. Worker não importa `.ts` (sem `tsx`/`ts-node` no projeto) → chama `app/api/internal/sync/executar` via HTTP (mesmo padrão de `scripts/reconciliar-lotes.mjs`), autenticado por segredo estático (`SYNC_WORKER_INTERNAL_SECRET`), nunca pelo cookie de sessão.
7. Retry: erro permanente (`LojaIdIntegrityError`, extraída para `lib/sync-errors.ts`) nunca reenfileira; erro transitório incrementa `tentativas` até `max_tentativas` (3).

RLS: decisão explícita de NÃO habilitar em `sync_jobs` — nenhuma outra tabela do projeto tem RLS, a app não usa Supabase Auth (sem `auth.uid()`), e autorização já é 100% em código via `getUserId()`. Justificativa completa no comentário da migration.

Limitação assumida conscientemente: o worker é um script manual local (`node scripts/sync-worker.mjs`) — precisa estar rodando para qualquer sync acontecer. Processador de produção é decisão futura, fora desta fase.

Contexto: auditoria da arquitetura de múltiplas lojas (motivada pelo pedido de eliminar sincronização manual e permitir seleção de uma ou mais lojas por marketplace) encontrou que hoje existem três mecanismos de "seleção de loja" (TopBar, dropdown do Dashboard, flag `ativo` em `lojas`) e nenhum deles controla de fato o que o backend sincroniza/lê — a plataforma trabalha implicitamente por `marketplace`, usando `getShopeeLojaAtiva`/`getMLLojaAtiva` (que sempre resolve para 1 única loja "mais recente" por marketplace) e `pedidos.conta` (nickname, não estável) como proxy de identidade.

**Decisões aprovadas:**
1. **Separar visualização de sincronização.** A seleção de loja(s) no dropdown (uma ou mais, controlando o que aparece em Dashboard/Vendas/Financeiro/Resumos) é independente do escopo de sincronização em background (que roda para TODAS as lojas ativas do usuário, sempre, para não deixar loja desmarcada ficar desatualizada silenciosamente).
2. **`loja_id` (uuid de `lojas.id`) passa a ser a referência principal** em toda a plataforma, substituindo o uso implícito de `"Shopee"`/`"Mercado Livre"` como identidade.
3. **Fonte única de verdade para a seleção de visualização** — um único contexto compartilhado (mesmo padrão já usado por `lib/date-field-context.tsx`), eliminando os três mecanismos atuais.

**Auditoria de identificador estável (pré-requisito para a migration, 2026-07-11):**
- `lojas.shop_id` (Shopee) e `lojas.seller_id` (ML) são os identificadores oficiais e permanentes — já armazenados desde a conexão OAuth.
- Confirmado que **nenhum desses identificadores nunca foi propagado para `pedidos`** — a tabela nunca teve coluna `shop_id`/`seller_id`/`loja_id` (conferido no schema original e em todas as migrations subsequentes). O único vínculo hoje é `pedidos.conta` (nickname capturado no momento do sync).
- Como não há proxy melhor já persistido nos pedidos existentes, o backfill histórico usa `nickname` como chave de correspondência **uma única vez** (não como dependência contínua) — auditoria de colisão rodada antes de aprovar isso.
- **Resultado da auditoria de colisão:** zero colisões de nickname entre lojas de um mesmo usuário/marketplace (`user_id` real). Havia 2 colisões aparentes na primeira tentativa da query, causadas por registros com `user_id = NULL` sendo agrupados juntos — não eram colisões reais. Ver achado separado sobre esses registros órfãos em `BUGS.md` (fora de escopo desta migration, por decisão explícita do usuário).
- A partir da execução desta migration, `sync-shopee.ts`/`sync-ml.ts` passam a gravar `loja_id` diretamente em todo pedido novo — nickname deixa de ser usado para qualquer finalidade de identidade a partir daí.

## Em aberto

### 189 pedidos Shopee de 07/07/2026 — RECUPERADOS via backfill (2026-07-15)

**Backfill executado e validado com sucesso.** Rota `app/api/admin/shopee/backfill-pedidos-0707/route.ts` (busca pontual via `get_order_detail` para os 189 `order_sn` conhecidos — nunca chama `get_order_list`, então estruturalmente não pode tocar em nenhum pedido fora da lista). Reaproveita, sem duplicar, `montarLinhasDoPedido()` e `carregarMapaAnuncios()` já existentes em `lib/sync-shopee.ts` — mesma lógica oficial do sync normal, nenhuma fórmula nova.

Processo de validação (aprovado pelo usuário antes da execução completa): 1 pedido canário gravado primeiro e conferido campo a campo no Supabase; dry-run repetido confirmando que o upsert reconhece corretamente "já existente" vs "novo"; só depois disso o restante foi gravado.

**Resultado:** 189/189 pedidos recuperados, 222 linhas, R$4.924,83 de faturamento recuperado, 0 erros, 0 duplicação (validado por `count(distinct order_id)=189` e `group by id having count(*)>1`=0 em toda a tabela `pedidos`, não só nos 189).

Nenhum código de sync, cron, paginação ou filtro foi alterado neste processo — só a extração pura (sem mudança de comportamento) de `montarLinhasDoPedido`/`carregarMapaAnuncios` para fora de `syncShopeeForUserV2`, e a rota de backfill nova (candidata a remoção do repositório depois de uso, é pontual — ver `ROADMAP.md`, checklist de limpeza de endpoints administrativos).

**Prevenção (Etapa 2) continua em aberto, decisão não tomada.** Causa raiz do evento original de 07/07 nunca foi 100% identificada (ver investigação abaixo) — a recuperação não dependeu disso. Opções A-F do plano de 2026-07-14 seguem candidatas; nenhuma implementada.

### 189 pedidos Shopee perdidos em 07/07/2026 — causa raiz NÃO é (só) o filtro COMPLETED (2026-07-14)

**Fato confirmado:** 189 `order_sn` pagos em 07/07/2026 (~20:43–23:17 BRT) nunca chegaram à tabela `pedidos` — ver `BUGS.md`.

**Investigação concluída via rota de diagnóstico temporária** (`get_order_list` real, por `create_time` e por `update_time`, rodada localmente em 2026-07-14 — rota removida depois de usada, não fica no repositório). Resultado:

- Os 189 aparecem tanto na listagem por `create_time` (janela 07/05–07/09) quanto na listagem por `update_time` (janela 07/06–07/14) — 0 não encontrados nas duas. **Descarta as hipóteses "nunca aparecem no get_order_list" e "aparecem só por um dos dois campos de tempo".**
- Status atual (ao vivo): 88 dos 189 estão `COMPLETED`; os outros 101 estão `TO_CONFIRM_RECEIVE` (85), `SHIPPED` (11) ou `TO_RETURN` (5).
- O filtro `filtrarCompleted` (`lib/sync-shopee.ts`) só poderia explicar os **88 que hoje estão `COMPLETED`** — e mesmo isso exigiria que tivessem virado `COMPLETED` rápido demais para o cron pegá-los antes, o que não foi confirmado (não temos o status histórico do dia 07-08/07, só o de hoje). **Para os outros 101, o filtro não é sequer aplicável**: nenhum está `COMPLETED` hoje, então em nenhum dia dos últimos 7 o filtro deveria tê-los bloqueado — e mesmo assim nunca foram gravados.

**Conclusão: o filtro `filtrarCompleted` não é causa suficiente para os 189 — no máximo explicaria uma fração deles (até 88), e não explica os outros 101.** A causa comum aos 189 (todos pagos na mesma janela de ~2h40 em 07/07) ainda não foi identificada. Hipóteses mais prováveis, não verificadas: falha de execução do cron `/api/sync` especificamente nesse dia (sem acesso a logs de execução da Vercel a partir deste ambiente), ou um bug de paginação/cursor em `get_order_list`/`get_order_detail` que descartou esse lote específico de `order_sn` silenciosamente.

**Consequência para a Etapa 2 (prevenção):** a Opção B do plano original (comparar `update_time` dentro da própria listagem de `get_order_list`) foi testada e **não é viável** — a API da Shopee rejeita `update_time` como `response_optional_field` desse endpoint ("does not support [update_time]"), só está disponível via `get_order_detail`. As opções que **não dependem de identificar a causa exata** (C — reconciliação periódica por `create_time` comparando contra o banco; D — alerta de queda anormal de volume) continuam candidatas. Nenhuma implementada — decisão de qual seguir ainda pendente do usuário, e a causa raiz específica de 07/07 segue em aberto (precisaria de acesso a logs de execução do cron na Vercel para fechar).

### Gap residual de 10 pedidos / ≈R$350 (02/07/2026) — retomar só se houver novo sinal

Decisão (2026-07-06): **encerrar a investigação ativa** do gap entre painel Shopee (989 pedidos/R$22.339,82) e CDS (979 pedidos/R$21.990,48).

Motivo: seis ângulos diferentes foram testados (timezone, filtro de status, diagnóstico geral, reconciliação por create_time∪update_time, reconciliação por create_time puro, e varredura sistemática de todas as combinações razoáveis de campo-de-tempo × grupo-de-status contra a API oficial da Shopee). A melhor combinação encontrada (`create_time + exceto_unpaid_e_cancelado`) reproduz 979 pedidos — o mesmo número que a CDS já mostra — mas nenhuma combinação bateu com 989. Conclusão: os 989 pedidos do painel do Seller Center vêm de uma regra de agregação interna da Shopee, não exposta pelos endpoints públicos (`get_order_list`/`get_order_detail`) usados pelo CDS. Sem acesso a essa regra interna (não documentada publicamente pela Shopee), continuar tentando reproduzi-la client-side é busca sem critério de parada.

Consequência prática: a CDS está tecnicamente correta em relação ao que a API pública da Shopee permite calcular. O gap de 10 pedidos/≈R$350 é uma limitação de origem externa (Shopee), documentada, não um bug do CDS. Ver `BUGS.md`.

**Ressalva não fechada:** o "979 pedidos" reproduzido via API (`create_time + exceto_unpaid_e_cancelado`) tem valor de R$21.977,42, enquanto a CDS mostra R$21.990,48 para os mesmos "979 pedidos" — diferença de R$13,06 nunca verificada order_sn a order_sn (pode ser conjunto diferente do mesmo tamanho, ou mesmo conjunto com fórmula de valor diferente). Não investigado por decisão do usuário de encerrar a Fase 1. Se o gap voltar a importar (ex.: crescer, ou aparecer em outro dia), começar por aqui antes de qualquer hipótese nova.

Critério para reabrir: só retomar se (a) a Shopee documentar publicamente a regra do Seller Center, (b) o gap crescer proporcionalmente mais que 10/989 (~1%) em outro período, ou (c) o usuário decidir que vale investigar a ressalva do R$13,06 acima.

**Atualização 2026-07-06 (pós-fechamento):** a ressalva acima foi de fato retomada (`verify-979`) e a causa dos 12 pedidos foi identificada order_sn a order_sn — ver `BUGS.md`. Resumo da decisão a tomar agora: (1) formalizar se "dia do pedido" é `create_time` ou `pay_time` — hoje o próprio sync usa os dois dependendo do modo (`noBuffer`), o que já causa inconsistência interna, não só divergência com a Shopee; (2) decidir se vale a pena implementar uma rotina de reconciliação de status para pedidos não-terminais antigos (cobriria o caso dos 2 pedidos cancelados-após-pago que ficaram com status desatualizado no banco); (3) o cron ter uma janela rolante de só 2 dias é o mecanismo mais provável por trás dos 5 pedidos que nunca chegaram ao banco — considerar ampliar essa janela ou adicionar backfill periódico independente do cron diário.

## Deploy seletivo, feature flag e escopo do multi-lojas (2026-07-13)

Contexto: preparação do primeiro deploy em produção desde o início da Fase 4/5. Auditoria encontrou todo o trabalho das últimas sessões (Fase D, paginação, Fase B três-datas, loja_id, sync_jobs) ainda 100% não commitado, misturado no working tree, e um bug real de multi-lojas (ver `BUGS.md`).

**Decisões aprovadas:**
1. **Nada fica só local.** Toda a infraestrutura de `sync_jobs`/worker é commitada e vai para o GitHub — mas protegida por `NEXT_PUBLIC_ENABLE_ASYNC_SYNC_JOBS` (padrão `false`). Motivo explícito do usuário: evitar divergência entre o código local e o repositório, sem arriscar produção.
2. **A flag não será ativada em produção enquanto não existir um processador permanente de jobs.** Migrar de verdade para a arquitetura assíncrona é uma etapa própria e futura do roadmap, com sua própria infraestrutura, monitoramento e plano de rollback — não uma consequência automática de "a flag existir no código".
3. **Multi-lojas (bug do TopBar + novo dropdown "Lojas Conectadas" + filtro real por `loja_id`) vira uma frente separada, depois deste deploy.** Não implementar agora além de registrar o achado e a arquitetura proposta em `BUGS.md`/`ROADMAP.md`. Escopo dessa frente futura definido pelo usuário: fonte única de seleção, seleção múltipla, filtros por `loja_id` nas APIs, Dashboard/Vendas respeitando a seleção, nomes personalizados, sync independente da seleção visual.
4. **Commit A (produção, ativo):** correções de data (Fase D), paginação `.range()`, fix de faturamento Shopee (`item_subtotal`), exposição de `lojaId`, três-datas (Fase B) e escrita de `loja_id` em `sync-shopee.ts`/`sync-ml.ts`, restauração do `forceSync` nas rotas de leitura. **Commit B (versionado, desativado):** `sync_jobs`, worker, rota interna, polling, a própria feature flag, migrations do novo fluxo, scripts. Nenhum arquivo de teste/debug/scratch (`app/api/debug/*`, `app/api/admin/*`, JSONs soltos) entra em nenhum dos dois.

### Métrica "Vendas sem os descontos da plataforma" (Seller Center) — encerrada sem fórmula, com ressalvas (2026-07-08)

Decisão: **encerrar a tentativa de reproduzir por fórmula** a métrica "Vendas sem os descontos da plataforma" do Seller Center, usando os campos de `get_escrow_detail` já reconciliados (2055/2055 pedidos, cobertura de 100% do período de referência).

Contexto: período 01/05 a 02/05/2026, Seller Center mostra Vendas = R$49.057,71 e Vendas sem descontos = R$48.650,84 (diferença de **R$406,87**). Hipóteses testadas, em ordem:

1. `buyer_paid_amount`/`faturamento` — mais próximo de "Vendas" (diferença de R$54,51), não exato.
2. `seller_product_rebate.amount` — R$392,11 com cobertura parcial (1900/2055 pedidos); R$433,37 com cobertura total (2055/2055) — a divergência **aumentou** de R$14,76 para R$26,50 ao fechar a cobertura. Hipótese rejeitada pelos dados.
3. `promotion_list` com `promotion_type: "platform_sale"` (11 ocorrências) — soma R$520,24 ou R$635,88 conforme a medida usada, nenhuma bate.
4. Busca combinatória por força bruta entre 10 campos de desconto/ajuste — melhor achado (`pix_discount + seller_product_rebate.commission_fee_offset` ≈ R$408,07, diff R$1,20) descartado explicitamente como provável coincidência estatística dado o tamanho do espaço de busca, não uma relação de negócio real.
5. Auditoria estrutural completa: todos os ~130 campos do JSON de `get_escrow_detail` (top-level, `items[]`, listas aninhadas) mapeados com tipo/ocorrências/soma em 2055/2055 pedidos. Nenhum campo nunca utilizado tem soma isolada próxima de R$406,87. O de maior valor não examinado (`shopee_shipping_rebate`, R$20.453,04) é subsídio de frete ao vendedor, não desconto sobre o preço de venda.

Conclusão: com os campos hoje disponíveis em `get_escrow_detail` e com os dados que conseguimos obter, não existe fórmula de campo único ou combinação com justificativa de negócio que reproduza essa métrica com exatidão. Não implementar por aproximação.

**Ressalvas não fechadas (a investigação não esgotou tudo, só o que era possível a partir daqui):**
- Os endpoints `get_wallet_transaction_list`, `get_payout_detail` e `get_escrow_list` nunca foram chamados na prática — existe só confirmação genérica de terceiros (sem documentação primária acessível) de que existem; nenhuma confirmação de que expõem, ou não, esse valor.
- Nunca foi confirmado se o Seller Center permite exportar desconto por pedido individual. Sem esse ground-truth pedido a pedido, a rejeição das hipóteses acima usa só o total do período — não uma validação order_sn a order_sn.

**Critério para reabrir:** (a) confirmar/testar exportação por pedido no Seller Center; (b) qualquer um dos três endpoints acima ser efetivamente testado e mostrar um campo explícito de desconto de plataforma; (c) Shopee documentar publicamente a origem desse número.

### Qual campo é o "faturamento oficial" da Shopee?

Candidatos: `item_subtotal` (preço puro dos itens), `faturamento` (`total_amount` proporcional, inclui frete do comprador), `buyer_paid_amount`, `escrow_amount` (receita líquida do vendedor). Ainda não confirmado qual bate exatamente com o número que o painel Shopee chama de "Faturamento"/"Vendas". Decisão bloqueada por precisar de comparação empírica direta com o painel (ver `RELATORIO_FASE1.md`, seção de query SQL sugerida).

### Como fechar o gap de 10 pedidos / R$349,34 (Fase 1)

Três hipóteses com endpoints próprios e nenhuma adotada como final: timezone (`boundary-audit`), filtro de status (`nao-paid-02jul`), diagnóstico geral (`shopee-audit`). Ver relatório de investigação entregue em 2026-07-06 e `BUGS.md`. Decisão de qual (ou quais, combinadas) explica o gap ainda não foi tomada — depende de rodar os endpoints com dados reais, o que não foi possível fazer a partir do ambiente do assistente.

### Sessão sem assinatura (`cds_session` = user_id cru)

Ainda não decidido se a solução será assinar o cookie (HMAC) ou migrar para Supabase Auth nativo. Levantado nesta revisão (2026-07-06), sem decisão tomada.

## Decididas

### Estimativas nunca substituem valor oficial de API

Regra de produto adotada desde o início do projeto (ver `PROJECT_CONTEXT.md`). Fallback para tabela de estimativa de comissão só é aceito quando a API explicitamente não retorna o dado (ex.: `income_distribution` ausente para pedidos ainda não `COMPLETED`), e deve ser sinalizado como estimativa, nunca apresentado como valor oficial.

### Contagem de pedidos = apenas `status = 'paid'`

Decidido e implementado (`RELATORIO_FASE1.md` P5, `AUDITORIA_FINAL.md` BUG-PIPE-3) para bater com a forma como a Shopee/ML contam "pedidos" no painel oficial.
