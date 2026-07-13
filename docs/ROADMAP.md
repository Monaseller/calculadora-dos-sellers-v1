# ROADMAP.md — Calculadora dos Sellers (CDS)

> Atualizar sempre que uma fase for concluída ou reescopada.

## Fase 1 — Confiabilidade dos dados — ✅ TECNICAMENTE CONCLUÍDA COM LIMITAÇÃO DOCUMENTADA (2026-07-06)

Objetivo: CDS exibir exatamente os mesmos números oficiais que o painel Shopee mostra (pedidos e faturamento).

Concluído:
- Reescrita do sync Shopee (income_distribution, paginação, status, upsert, item_subtotal) — recuperou 190 pedidos (de 799 para 979 de 989 oficiais).
- Investigação sistemática do gap de 10 pedidos / ≈R$350 entre Shopee (989/R$22.339,82) e CDS (979/R$21.990,48): seis ângulos testados (timezone, status, diagnóstico geral, reconciliação ampla, reconciliação por create_time, varredura de combinações campo-de-tempo × grupo-de-status). Melhor regra reproduzível via API pública da Shopee (`create_time + exceto_unpaid_e_cancelado`) fecha em 979 — mesmo número que a CDS já mostra. Nenhuma combinação testada reproduz os 989 do painel. Conclusão: o painel do Seller Center usa regra de agregação interna não exposta pela API pública. Gap tratado como limitação de origem externa (Shopee), documentada, não como bug do CDS. Detalhe completo em `BUGS.md` e `DECISIONS.md`.

Limitação documentada (não bloqueia uso em produção, mas deve ser comunicada ao usuário final do CDS se ele comparar com o painel Shopee):
- Diferença de ~1% em pedidos (10/989) e ~1,6% em faturamento (R$350/R$22.339,82) para o dia 02/07/2026 é esperada e não é corrigível com os dados disponíveis via API pública Shopee.
- Ressalva aberta (não bloqueante): R$13,06 de diferença entre o valor do "979" reproduzido via API e o "979" que a CDS mostra — não verificado order_sn a order_sn. Ver `DECISIONS.md`.

Pendências que NÃO bloqueiam o encerramento da Fase 1, mas ficam registradas para a Fase 2 ou antes conforme prioridade do usuário:
- Decidir formalmente qual campo é "o faturamento oficial" a ser exibido (`item_subtotal` vs `faturamento`/`total_amount` vs `buyer_paid_amount`/`escrow_amount`) — ver `DECISIONS.md`.
- Aplicar `taxaFixa` Shopee no cálculo de margem.
- Resolver senha em plaintext e sessão sem assinatura antes de qualquer escala de usuários.

## Checklist de limpeza — pré-Fase 2

Gerado em 2026-07-06, a executar antes de avançar para a Fase 2. Nenhum item foi executado ainda — isto é só o checklist.

- [ ] **Remover endpoints temporários de debug** criados durante a investigação do gap: `app/api/debug/boundary-audit`, `app/api/debug/nao-paid-02jul`, `app/api/debug/shopee-audit`, `app/api/debug/full-reconciliation`, `app/api/debug/reconcile-989`, `app/api/debug/dashboard-formulas`. Avaliar também `app/api/debug/pending-compare` (tem efeito colateral real — pode disparar sync via `?sync=1`, não é só leitura). Antes de apagar, considerar arquivar o resultado final relevante (já está em `BUGS.md`/`DECISIONS.md`) para não perder o histórico.
- [ ] **Manter apenas correções definitivas** — conferir que nenhum código de produção (fora de `app/api/debug/*`) ficou dependendo de algo criado só para a investigação.
- [ ] **Revisar se `item_subtotal` está sendo tratado como faturamento** em algum lugar da UI onde deveria ser `faturamento`/`buyer_paid_amount`/`escrow_amount` — decisão pendente em `DECISIONS.md` sobre qual é o campo oficial.
- [ ] **Revisar `lib/sync-shopee.ts`** à luz do achado desta investigação (a melhor regra reproduzível foi `create_time + exceto_unpaid_e_cancelado`, não a lógica atual de `noBuffer`/`pay_time` vs `create_time` do cron) — avaliar se o critério de sync deveria mudar para refletir isso.
- [ ] **Revisar `/docs`** — conferir que os 8 arquivos estão consistentes entre si (datas, números, decisões) antes de seguir para a Fase 2.
- [ ] **Rodar TypeScript check** (`npx tsc --noEmit`) — confirmar zero erros antes do deploy, especialmente depois de remover os endpoints de debug.
- [ ] **Preparar deploy** — build local (`npm run build`), conferir variáveis de ambiente na Vercel, e o ponto já conhecido de `maxDuration` cortado em 60s no plano Hobby (ver `BUGS.md`).

## Fase 2 — Arquitetura multi-marketplace e separação de datas (planejamento, 2026-07-06)

Reposicionamento: CDS deixa de ser "calculadora" e passa a ser ERP financeiro para marketplaces, com arquitetura genérica (Shopee, ML hoje; Amazon/Magalu/TikTok objetivo futuro).

Decisão de arquitetura **APROVADA** (ver `DECISIONS.md`): separar `data_criacao` / `data_pagamento` / `data_atualizacao`, com `data_pagamento` como regra oficial para métricas financeiras (NULL quando não pago, sem fallback automático) e seletor global no dashboard (Data de Pagamento como padrão, alternável para Data de Criação).

**Fase A (schema) — arquivo criado, não executado:** `supabase/migrations/20260706_separacao_datas.sql` adiciona `data_criacao`, `data_pagamento`, `data_atualizacao_marketplace` + índices. Aguardando o usuário rodar no SQL Editor do Supabase.

**Fases B/C/D:**
- Fase B (Shopee): ✅ feito 2026-07-06 — `lib/sync-shopee.ts` popula `data_criacao`/`data_pagamento`/`data_atualizacao_marketplace` em cada sync (novos registros e resyncs; sem backfill agressivo de histórico). `tsc --noEmit` limpo.
- Fase B (ML): ✅ feito 2026-07-06 — `lib/sync-ml.ts` popula `data_criacao` (de `date_created`), `data_pagamento` (de `date_approved` quando há pagamento aprovado, `NULL` sem fallback quando não há) e `data_atualizacao_marketplace` (de `last_updated`, campo não verificado empiricamente contra a API real nesta sessão — fica `NULL` se ausente). `tsc --noEmit` limpo. Fase B concluída para os dois marketplaces.
- Fase C: ✅ feito 2026-07-06 — `app/api/shopee/vendas/route.ts` e `app/api/ml/vendas/route.ts` ganharam parâmetro `date_field` (pagamento/criação, padrão pagamento), com fallback legado restrito a pedidos pré-Fase-B (`data_criacao` também NULL). `tsc --noEmit` limpo. Frontend ainda não usa o parâmetro (Fase D).
- Fase D: ✅ feito 2026-07-06 — seletor global "Data de Pagamento"/"Data de Criação" implementado via `lib/date-field-context.tsx` + toggle na `TopBar`, afetando `app/(app)/dashboard/page.tsx` e `app/(app)/vendas/page.tsx` (KPIs, gráficos, balancete, produtos, rankings, comparativo ML×Shopee). `DateRangePicker.tsx` não foi alterado (não precisa — o seletor de data e o seletor de período são independentes). `tsc --noEmit` limpo. Ver `PROJECT_CONTEXT.md` para a lista de telas migradas vs. legadas.
- Fase E (não implementar sem decisão separada): reconciliação de status obsoleto (pedidos pagos-depois-cancelados que ficam com status stale no banco).
- Fase F: verificação order-a-order (mesmo rigor da investigação de 2026-07-06) antes de liberar o seletor em produção.

## Fase 3 — Reconciliação financeira Shopee (`get_escrow_detail`) — ✅ AUDITORIA ENCERRADA (2026-07-10)

Objetivo: obter dados financeiros oficiais por pedido (escrow, comissão, taxas, vouchers) já que `get_order_detail` não fornece `income_distribution`.

Concluído: rotina separada de reconciliação validada em produção (local), mais de 7.500 pedidos reais gravados sem erro de integridade, critérios de `escrow_amount_after_adjustment` e `has_income_data` fechados, script de orquestração em lotes (`scripts/reconciliar-lotes.mjs`) funcionando. Auditoria de campo pra fechar "Vendas sem os descontos da plataforma" encerrada sem fórmula confirmada (limitação documentada, critério de reabertura em `DECISIONS.md`).

Pendente, não bloqueante: reconciliar os pedidos restantes (~56 mil, fora do período de referência já auditado) — pode continuar em paralelo com a Fase 4, usando o mesmo script local.

## Fase 4 — Arquitetura de performance (Dashboard/Vendas) — planejamento (2026-07-10)

Objetivo: Dashboard e Vendas rápidos, sem carregar milhares de linhas de `pedidos` a cada acesso. Tabela `pedidos` continua fonte de verdade (não copiar/substituir). Camada nova: tabela de resumos diários pré-agregados (`dashboard_resumos_diarios`) + função de atualização incremental, disparada após cada sync/reconciliação. Dashboard passa a consumir resumos para KPIs/gráficos/balancete; Vendas e Top Produtos continuam consultando `pedidos` (precisam de detalhe), com paginação server-side.

Restrições explícitas desta fase: não implementar fórmula de "Vendas sem os descontos da plataforma", não adotar `seller_product_rebate` como regra oficial, sem cron em produção, sem deploy, sem alterar a calculadora de precificação. Arquitetura e migration a aprovar antes de qualquer código (ver proposta entregue no chat em 2026-07-10).

**Integração com o sync desativada temporariamente (2026-07-13):** `lib/sync-shopee.ts` e `lib/sync-ml.ts` chamavam `atualizarResumosDosDias` (e coletavam os dias afetados por conta) ao final de cada sync — removido do deploy atual porque `dashboard_resumos_diarios` ainda não existe no banco (a chamada, mesmo protegida por `try/catch`, gerava log de erro conhecido em todo sync de produção). `lib/resumos-diarios.ts` e a migration `20260710_dashboard_resumos_diarios.sql` continuam no repositório, só não são chamados. **Reativar quando:** (1) a Fase 4 estiver completa (Partes 3-5), (2) a migration `dashboard_resumos_diarios` tiver sido executada no Supabase — só então reintroduzir o bloco de coleta por conta + a chamada a `atualizarResumosDosDias` em ambos os arquivos de sync (removidos nesta data, ver `git log`/diff desta sessão para o código exato).

## Fase 5 — loja_id como referência principal / multi-loja — migration + backfill de `pedidos` executados (2026-07-11)

Objetivo: eliminar sincronização manual, permitir seleção de uma ou mais lojas (por loja, não só por marketplace) em Dashboard/Vendas/Financeiro/Resumos, e corrigir o bug real encontrado na auditoria: `getShopeeLojaAtiva`/`getMLLojaAtiva` sempre resolvem para 1 única loja "mais recente" por marketplace, então uma 2ª conta conectada do mesmo marketplace fica invisível para sync/reconciliação silenciosamente.

**Decisões de arquitetura aprovadas** (ver `DECISIONS.md` para o registro completo):
- Visualização (o que aparece na tela) é independente do escopo de sincronização (que roda para todas as lojas ativas do usuário, sempre — nunca só as marcadas no dropdown).
- `loja_id` (uuid de `lojas.id`) substitui `"Shopee"`/`"Mercado Livre"` como referência principal em toda a plataforma.
- Fonte única de seleção de visualização (contexto compartilhado, mesmo padrão de `lib/date-field-context.tsx`), eliminando os três mecanismos hoje duplicados e desconectados (TopBar, dropdown do Dashboard, flag `ativo`).

**Migrations — status em 2026-07-11:**
- `supabase/migrations/20260711_loja_id_pedidos.sql` — **EXECUTADA.** `ALTER TABLE pedidos ADD COLUMN loja_id UUID REFERENCES lojas(id)` + índices.
- `scripts/backfill-loja-id.sql` — **EXECUTADO e validado passo a passo pelo usuário.** Resultado: colisão de nickname = 0 (inclusive contra lojas desconectadas); cobertura final = **350.298 de 350.298 pedidos com loja_id, 0 sem correspondência**. Precisou de um cast explícito não previsto originalmente (`l.user_id::text = p.user_id`, já corrigido no script) — `lojas.user_id` é UUID, `pedidos.user_id` é TEXT, mesma informação em tipos diferentes entre as duas tabelas.
- `supabase/migrations/20260710_dashboard_resumos_diarios.sql` (editada 2026-07-11) — **ainda NÃO executada** (tabela ainda não existe no banco), já escrita com `loja_id` como parte da chave única em vez de `(marketplace, conta)`.

**Estratégia de rollback:** mudança é 100% aditiva — nenhuma coluna existente é alterada ou removida, nenhum dado é apagado.
- Reverter só o backfill (manter a coluna): `UPDATE pedidos SET loja_id = NULL;`
- Reverter a coluna inteira: `ALTER TABLE pedidos DROP COLUMN loja_id;` (seguro enquanto nenhum código em produção depender de `loja_id` estar preenchido — ver impacto abaixo).
- `dashboard_resumos_diarios`: como a tabela ainda não existe no banco, "rollback" é simplesmente não executar a migration, ou `DROP TABLE dashboard_resumos_diarios;` se já tiver sido criada e precisar desfazer.
- Risco de rollback: próximo de zero nesta etapa, porque nenhuma mudança de código (sync, APIs, Dashboard, Vendas) foi feita ainda — só schema. O risco cresce depois, quando `sync-shopee.ts`/`sync-ml.ts`/`lib/resumos-diarios.ts` passarem a gravar/exigir `loja_id` (próxima etapa, aprovação separada).

**Impacto esperado (nenhum código alterado ainda nesta etapa — só schema):**
- `pedidos`: nenhum. Coluna nova, nullable, nenhuma query existente referencia `loja_id`, nada quebra.
- `dashboard_resumos_diarios`: nenhum em produção (tabela não existe ainda). O código já escrito nas Partes 2–4 da Fase 4 (`lib/resumos-diarios.ts`, `app/api/admin/backfill-resumos-diarios/route.ts`, `app/api/dashboard/resumo/route.ts`) hoje grava/lê por `(marketplace, conta)` — vai precisar de um ajuste (não feito ainda) para gravar/ler por `loja_id` antes de qualquer backfill de resumos rodar de verdade.
- Sincronização: nenhum imediato. `sync-shopee.ts`/`sync-ml.ts` continuam gravando só `conta` até uma próxima mudança de código (pendente de aprovação separada) passar a gravar `loja_id` também em pedidos novos — enquanto isso não acontece, o número de pedidos "sem loja_id" cresce a cada sync novo, então vale priorizar essa mudança logo depois do backfill.
- Dashboard/Vendas: nenhum. Nenhuma tela lê `loja_id` hoje — é infraestrutura preparatória para a seleção multi-loja (dropdown único, fonte de verdade compartilhada), que é a próxima etapa de código, ainda não aprovada.

**Etapas de wiring — status em 2026-07-11:**
- Etapa 1 (`sync-shopee.ts` grava `loja_id`) — **concluída, aprovada.**
- Etapa 2 (`sync-ml.ts` grava `loja_id` via `seller_id`, fluxo cookie corrigido) — **concluída, aprovada.**
- Etapas 3-5 (reconciliação, `resumos-diarios.ts`, APIs `loja_ids`) — **pendentes, bloqueadas atrás da correção do botão Sincronizar** (prioridade explícita do usuário).

**Correção do botão Sincronizar (sync_jobs) — implementada 2026-07-11, aguardando testes/migration:**
Bug real corrigido nesta etapa (fora da árvore original de `loja_id`, mas descoberto durante o teste da Etapa 2): `app/(app)/vendas/page.tsx` disparava sync bloqueante dentro da rota HTTP de leitura, e uma falha/timeout de UM marketplace zerava o array combinado inteiro — faturamento caía mesmo com o outro marketplace saudável. Arquitetura nova: fila persistente `sync_jobs` + worker separado (`scripts/sync-worker.mjs`) + `mlRows`/`shopeeRows` independentes no frontend. Detalhe completo em `DECISIONS.md` ("Redesenho do botão Sincronizar"). Pendente: usuário revisar e executar `supabase/migrations/20260711_sync_jobs.sql`, configurar `SUPABASE_SERVICE_ROLE_KEY`/`SYNC_WORKER_INTERNAL_SECRET`, testar localmente.

**Limitação temporária registrada explicitamente (2026-07-11):** `scripts/sync-worker.mjs` executa o sync chamando `app/api/internal/sync/executar` via HTTP (`http.request`, não `fetch`) — não importa `lib/sync-shopee.ts`/`lib/sync-ml.ts` diretamente porque este projeto não tem `tsx`/`ts-node` instalado, e adicionar um loader de TS só para o worker não foi considerado uma solução simples o bastante nesta fase. Isso é uma solução transicional, não a arquitetura final: quando houver infraestrutura/compilação adequada para o worker (ex: build separado do módulo de sync, ou introdução deliberada de um loader TS), o worker deve passar a executar o módulo de sincronização diretamente, sem o hop HTTP intermediário. Enquanto isso não acontece, o hop HTTP exige que `npm run dev`/`next start` esteja rodando para o worker funcionar — outra razão pela qual esta é uma solução local, não de produção.

## Deploy seletivo + feature flag (2026-07-13)

Decisão (ver `DECISIONS.md`): a arquitetura `sync_jobs`/worker (Fase 5, redesenho do botão Sincronizar) fica **versionada no GitHub, porém desativada em produção** atrás de `NEXT_PUBLIC_ENABLE_ASYNC_SYNC_JOBS` (padrão `false`). Motivo: não perder o código já implementado e testado localmente, sem correr o risco de ativar em produção antes de existir um processador permanente de jobs — `scripts/sync-worker.mjs` continua sendo um processo manual local, e não há nada equivalente rodando no Vercel (serverless, sem processo de longa duração).

Com a flag em `false`:
- `app/api/ml/vendas/route.ts`/`app/api/shopee/vendas/route.ts` voltam a aceitar `?sync=1` (sync inline, restaurado — comportamento idêntico ao anterior a 2026-07-11).
- `app/(app)/vendas/page.tsx`: botão Sincronizar chama `dispararSincronizarInline()` (usa `lerMarketplace(..., force=true)` direto, sem criar job/poll) — mas já se beneficia da separação `mlRows`/`shopeeRows` (uma falha num marketplace não zera o outro nem os dados já exibidos).
- `POST /api/sync/iniciar` responde `{ ok:false, disabled:true }` e nunca insere em `sync_jobs` — defesa em profundidade, mesmo que a rota seja chamada por engano.

Com a flag em `true` (não recomendado em produção ainda): usa `sync_jobs` + polling normalmente, mas jobs só são processados se `scripts/sync-worker.mjs` estiver rodando em algum processo alcançável — em produção hoje isso significa nenhum processamento (jobs ficam presos em `pendente`), não um erro visível, só sincronização que nunca completa.

**Migração definitiva da sincronização (ativar a flag de verdade) é uma etapa própria de roadmap, ainda não iniciada** — precisa de: onde/como rodar um processador permanente (servidor dedicado, fila gerenciada, etc.), monitoramento de jobs presos/heartbeat, e plano de rollback documentado antes de qualquer ativação em produção. Decisão explícita do usuário (2026-07-13): não desenhar essa infraestrutura agora.

## Fase 6 — Seleção de lojas (multi-loja de verdade) — planejamento, ainda não iniciada (2026-07-13)

Motivada pelo bug encontrado na auditoria pré-deploy: ver `BUGS.md` ("Trocar loja no TopBar não muda os dados exibidos em Vendas/Dashboard"). Hoje já é possível conectar múltiplas contas do mesmo marketplace (armazenamento suporta), mas nenhuma tela realmente filtra por loja selecionada — `getMLLojaAtiva`/`getShopeeLojaAtiva` sempre resolvem para "a mais recente ativa", ignorando o que o usuário escolheu no dropdown.

Escopo definido pelo usuário para esta etapa futura (nenhum item implementado ainda):
1. Fonte única de lojas selecionadas (substituindo os mecanismos duplicados hoje existentes — cookies `loja_ativa_id`/`shopee_loja_id`, flag `ativo`, dropdown do TopBar — por um contexto compartilhado, mesmo padrão de `lib/date-field-context.tsx`).
2. Seleção de uma ou várias lojas simultaneamente (não só uma por marketplace).
3. Filtros por `loja_id` (ou lista de `loja_id`s) nas APIs de leitura — retoma diretamente a Fase 5 Etapa 5 (`APIs de leitura aceitam loja_ids`, hoje pendente).
4. Dashboard e Vendas respeitando a seleção (hoje ignoram completamente).
5. Nomes personalizados por loja (hoje `nickname` vem só da API do marketplace, sem edição pelo usuário).
6. Sincronização em background independente da seleção visual (todas as lojas ativas do usuário continuam sincronizando mesmo se não estiverem "selecionadas" para visualização — decisão já registrada na Fase 5, reafirmada aqui).

Novo dropdown do TopBar ("Lojas Conectadas", listando cada loja com nome personalizável) faz parte desta mesma frente — não implementar junto com o deploy do Grupo A/B desta rodada.

## Próximas fases (não detalhadas ainda / conforme README original)

- ML: variação (`variation_id`) hoje sempre nulo — variações de anúncio ML ficam invisíveis.
- ML: mesmo bug de `totalOrders` (contar apenas `paid`) ainda pendente no cron ML.
- Consolidar migrations SQL soltas em um único diretório versionado.
