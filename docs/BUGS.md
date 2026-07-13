# BUGS.md — Bugs conhecidos (CDS)

> Status: 🔴 aberto crítico | 🟠 aberto médio | 🟡 aberto baixo | ✅ corrigido | 🔎 em investigação

## Corrigidos (auditoria 03/07/2026 — ver AUDITORIA_FINAL.md e RELATORIO_FASE1.md para detalhe)

- ✅ H1 — `GET /api/perfil` retornava `senha` em plaintext para o cliente.
- ✅ H2 — Callback OAuth ML não tratava erro/expiração de `code` (crash silencioso).
- ✅ H3 — Cadastro criava conta com `email_verificado: true` (bypass de verificação).
- ✅ M1 — DateRangePicker sem presets de 15/30/90 dias.
- ✅ M2 — Avatar do TopBar hardcoded ("R") em vez de dinâmico.
- ✅ M3 — `shopeePost()` sem timeout, podia travar indefinidamente.
- ✅ C1 — Rotas `historico`, `comparativo`, `suporte` retornavam 404.
- ✅ C2 — Dashboard com double-load (deps reativas erradas no `useCallback`).
- ✅ BUG-PIPE-1 — Sync Shopee descartava pedidos silenciosamente por usar `pay_time` quando a API foi consultada por `create_time`.
- ✅ BUG-PIPE-2 — Faturamento calculado como `preço_item × qtd` em vez de `total_amount` oficial (ignorava frete/voucher).
- ✅ BUG-PIPE-3 — `pedidosUnicos` contava pedidos cancelados; `faturamento` não.

## Abertos — críticos

- 🔴 **Senha em plaintext.** `lib/session.ts` + `app/api/perfil/route.ts` + `app/api/auth/login/route.ts` armazenam e comparam senha em texto puro na coluna `perfil.senha`. Solução recomendada documentada em `AUDITORIA_FINAL.md` (bcrypt). Não implementado.
- 🔴 **Sessão sem assinatura.** Cookie `cds_session` carrega o `user_id` cru, sem JWT/HMAC. Qualquer requisição forjando esse cookie com um UUID válido de outro usuário é tratada como autenticada. Identificado nesta revisão (2026-07-06), ainda não estava documentado antes. Precisa de decisão: assinar o cookie (HMAC) ou migrar para sessão via Supabase Auth.
- 🔎 **RLS não confirmada nas tabelas Supabase.** Isolamento por usuário é feito só via `.eq("user_id", ...)` na aplicação. Se RLS estiver desativada, a chave anon pública (`NEXT_PUBLIC_SUPABASE_ANON_KEY`) pode expor dados de qualquer usuário a quem souber montar a query REST diretamente. Precisa confirmação manual no painel Supabase — não verificável a partir deste ambiente (sem acesso de rede ao Supabase).

## Abertos — médios

- 🟠 **`maxDuration` ignorado no Vercel Hobby.** Funções declaram até 300s mas o plano corta em 60s. Syncs grandes podem falhar silenciosamente por timeout.
- 🟠 **`taxaFixa` Shopee ausente do cálculo de margem.** Subestima custo em R$0,10–0,30/pedido nos itens de menor valor. Ver `BUSINESS_RULES.md`.
- 🟠 **Migrations SQL espalhadas sem numeração única** (raiz + `supabase/` + `supabase/migrations/`). Risco de aplicar migration errada ou fora de ordem. Ver `DATABASE.md`.

## Encerrado com limitação documentada — gap Shopee vs CDS (02/07/2026)

- 🔎➡️📌 **Gap de 10 pedidos / ≈R$350 entre painel oficial Shopee (989 pedidos, R$22.339,82) e CDS (979 pedidos, R$21.990,48). Investigação encerrada em 2026-07-06 por decisão do usuário — ver `DECISIONS.md` para o registro formal.**

  Histórico de hipóteses testadas, nenhuma confirmou a causa:
  1. `boundary-audit` — timezone (order_sn UTC vs `data` BRT). Resultado: **PARCIAL**, não comprovou a origem dos 10 pedidos.
  2. `nao-paid-02jul` — filtro de status (pending/cancelado/devolução em 02/07). Resultado: **também não explicou** a diferença.
  3. `shopee-audit` — diagnóstico geral, não conclusivo.
  4. `full-reconciliation` — descartado: universo Shopee por união `create_time`+`update_time` trouxe ~574 pedidos de outros dias (contaminação por `update_time`).
  5. `reconcile-989` — universo por `create_time`: `total_todos_status=1102`, `total_status_paid=975`. Nenhum bate com 989.
  6. `dashboard-formulas` — testou `create_time`/`update_time` × ~14 grupos de status contra a API Shopee (`pay_time` não é aceito por `get_order_list`, erro confirmado da própria API: "must use create_time or update_time"). **Melhor resultado encontrado: `create_time + exceto_unpaid_e_cancelado` → 979 pedidos / R$21.977,42.** Nenhuma combinação testada bateu exatamente com 989 pedidos / R$22.339,82.

  **Conclusão adotada:** a melhor regra reproduzível via API oficial da Shopee (`get_order_list`/`get_order_detail`) fecha em 979 pedidos, o mesmo número que a CDS já exibe. O painel oficial do Seller Center usa aparentemente uma regra de agregação interna (não exposta pela API pública) que chega a 989 — essa diferença de 10 pedidos / ≈R$350 **não é reproduzível pelos endpoints públicos da Shopee** e é tratada como limitação conhecida, não como bug do CDS.

  **Ressalva não resolvida (documentada, não investigada por decisão do usuário):** a regra `create_time + exceto_unpaid_e_cancelado` bateu em **quantidade** com a CDS (979 = 979), mas não em **valor** — R$21.977,42 (API) vs R$21.990,48 (CDS), diferença de R$13,06. Contagem igual não prova que é o mesmo conjunto de 979 pedidos; pode ser um conjunto diferente de mesmo tamanho, ou o mesmo conjunto com uma fórmula de valor ligeiramente diferente (ex.: rateio proporcional de frete/voucher). Não foi verificado order_sn a order_sn. Registrado para retomada futura se necessário — ver `DECISIONS.md`.

  Endpoints de debug criados durante esta investigação (candidatos a remoção — ver `ROADMAP.md`, checklist pré-Fase 2): `boundary-audit`, `nao-paid-02jul`, `shopee-audit`, `full-reconciliation`, `reconcile-989`, `dashboard-formulas`, `verify-979`, `pending-compare`.

## Encontrado, fora de escopo por decisão do usuário (2026-07-11)

- 🔎 **`lojas` com `user_id = NULL`.** Auditoria de colisão de nickname (para a migration `loja_id`, ver `DECISIONS.md`) encontrou 9 registros em `lojas` com `ativo=true` e `user_id` nulo (7 marketplace ML, 2 Shopee) — contra apenas 6 registros com `user_id` real (5 ML, 1 Shopee) no mesmo filtro. Ou seja, a maioria das linhas "ativas" na tabela não pertence a usuário nenhum.
  **Confirmado inofensivo hoje:** toda leitura real filtra por `user_id` de sessão (`getShopeeLojaAtiva`, `getMLLojaAtiva`, `GET /api/lojas`, etc.), então essas linhas nunca aparecem para nenhum usuário real. O cron `/api/sync` já tem um `.not("user_id","is",null)` explícito — alguém já havia topado com isso antes e contornado, sem documentar.
  **Causa não investigada** — hipóteses possíveis: bug no callback OAuth que insere a loja antes de resolver a sessão do usuário, ou sobras de testes manuais durante o desenvolvimento. Decisão explícita do usuário (2026-07-11): não alterar, não remover, não investigar agora. Tratar em auditoria separada depois que a arquitetura de `loja_id` estiver concluída — ver `DECISIONS.md`.

## Reaberto — conjuntos de 979 não são idênticos (2026-07-06)

- 🔎➡️📌 `verify-979` (rodado após o encerramento acima, com o mesmo total 979=979 dos dois lados): os conjuntos **não são idênticos por order_sn**. 6 pedidos só na Shopee, 6 só na CDS, 973 em comum. **Causa identificada order_sn a order_sn em 2026-07-06** (endpoint editado, sem criar novo, para trazer create_time/pay_time/update_time e lookup direto nos 12 pedidos):

  **6 pedidos só-Shopee (nunca chegaram ao banco):**
  - 5 deles (260703NKHH7MTJ, 260703NG57K4SB, 260703NFBKG9TA, 260703NA7NBD8J, 260703MVCRS86J): `create_time` em 02/07 BRT mas `pay_time`/`update_time` em 03/07 ou 04/07. Causa mais provável: o cron (`app/api/sync/route.ts:34-35`) usa uma janela rolante de só 2 dias (`ontem`+`hoje`, recalculada a cada execução) com `time_range_field="update_time"` (`lib/sync-shopee.ts:~147`) — hoje (06/07) essa janela já passou de 02-04/07. Não confirmado se o cron de fato rodou nesses dias (sem acesso a logs de execução da Vercel) — só o código explica o mecanismo do gap.
  - 1 deles (260702MHK41708): `create_time` E `pay_time` ambos em 02/07 (sem ambiguidade), mas status atual é `COMPLETED`. **Causa confirmada por código:** `lib/sync-shopee.ts:~147-148` (`filtrarCompleted = !noBuffer`) e `~181-183` exclui explicitamente pedidos `COMPLETED` da listagem do cron antes mesmo de buscar detalhe — um pedido novo que já nasce/vira `COMPLETED` rápido demais nunca entra pelo cron, independente de quando ele rodar.

  **6 pedidos só-CDS (no banco como "paid"/02-07, mas não no universo Shopee testado):**
  - 4 deles são diferença de **definição**, não bug: `create_time` em 01/07 (2 casos) ou create_time_brt_date=01/07 por fronteira de fuso literal (2 casos, incluindo um caso de 2 minutos antes/depois da meia-noite BRT — a mesma hipótese do `boundary-audit` original, agora confirmada com pedido real), mas `pay_time` em 02/07. O banco usa `pay_time` para gravar `data` no modo cron (`lib/sync-shopee.ts:267-270`) — regra atual e consistente, só diferente do critério `create_time` usado na comparação. Decisão de produto pendente: qual referência de tempo é "o dia do pedido" — ver `DECISIONS.md`.
  - 2 deles (260702MF16B5U8, 260702KH1BDRJF): `create_time`/`pay_time` ambos 02/07 sem ambiguidade, mas status atual na Shopee é `CANCELLED` enquanto o banco ainda diz `paid` (valores reais, não zero: R$102,47 e R$17,96). Pedido foi pago, sincronizado, depois cancelado/estornado na Shopee — banco nunca foi atualizado porque nenhum sync desde então revisitou esse order_sn (mesma limitação da janela rolante de 2 dias do cron). **Gap arquitetural real:** o sistema não tem rotina de reconciliação de status para pedidos não-terminais já sincronizados.

- 🔎 **Achado novo, sistêmico, ainda não investigado:** dos 973 pedidos em comum, praticamente todos (973 de 973 na amostra bruta) têm `item_subtotal` idêntico mas `buyer_paid_amount` diferente entre Shopee e CDS. Isso não parece ser sobre os 12 pedidos da divergência de conjunto — é uma diferença de fórmula/fonte de dado aplicada a quase toda a base. Candidato mais provável: rateio proporcional de `buyer_paid_amount` em `lib/sync-shopee.ts` (`buyerPaidItem = hasIncomeData ? incBuyerTotal * ratioItem : faturamento`) pode ter sido calculado num momento em que `income_distribution` ainda não estava disponível (pedido não `COMPLETED`), e nunca foi recalculado após o pedido virar `COMPLETED`/receber o dado oficial — ver `BUSINESS_RULES.md`. **Não investigado nesta rodada por decisão de foco do usuário** (prioridade era os 12 pedidos do gap de contagem). Retomar depois de fechar os 12.

## 🔴 Trocar loja no TopBar não muda os dados exibidos em Vendas/Dashboard (encontrado 2026-07-13)

Contexto: auditoria pré-deploy (Parte 6 do pedido de organização do deploy, ver `DECISIONS.md` 2026-07-13) foi investigar se hoje já é possível conectar mais de uma conta do mesmo marketplace, como preparação para a etapa futura de multi-lojas.

**Confirmado — armazenamento já suporta múltiplas lojas por marketplace:**
- `app/api/auth/shopee/callback/route.ts` e `app/api/auth/relay/route.ts` (callback do ML) buscam a loja existente por `(marketplace, seller_id/shop_id, user_id)`, não por `(marketplace, user_id)`. Conectar uma segunda conta com um `shop_id`/`seller_id` diferente insere uma linha nova em `lojas` — não sobrescreve a primeira.
- Nada no fluxo de conexão desativa (`ativo=false`) a loja irmã ao conectar uma nova. Múltiplas linhas `ativo=true` do mesmo marketplace/usuário já coexistem hoje.
- O dropdown do TopBar (`components/TopBar.tsx`) já lista todas as lojas conectadas via `GET /api/lojas` e tem um botão "trocar loja" por linha.

**O bug real:** `trocarLoja()` no TopBar chama `POST /api/lojas/ativar`, que **só seta cookies** (`loja_ativa_id` para ML, `shopee_loja_id` para Shopee) — nunca escreve na coluna `ativo` de `lojas`, nunca desativa a loja irmã. E as rotas que de fato servem dados (`app/api/ml/vendas/route.ts`, `app/api/shopee/vendas/route.ts`, e por extensão o Dashboard) resolvem a loja ativa via `getMLLojaAtiva`/`getShopeeLojaAtiva` (`lib/ml-auth.ts`, `lib/shopee-auth.ts`), que fazem `.eq("ativo", true).order("created_at", {ascending:false}).limit(1)` — **isso ignora completamente o cookie setado pelo dropdown.**

Resultado prático: se um usuário tem 2 lojas Shopee conectadas e usa o dropdown pra "trocar" para a mais antiga, o ✓ verde no menu muda, mas Vendas/Dashboard continuam mostrando os dados da loja conectada/reconectada mais recentemente — a troca é cosmética para leitura de dados. Isso não é uma limitação de "falta implementar seleção múltipla" — é um mecanismo de UI que hoje não faz o que aparenta fazer.

**Por que não foi corrigido agora:** decisão explícita do usuário (2026-07-13) de tratar multi-lojas (incluindo este bug) como frente própria, depois do deploy atual — ver arquitetura proposta em `ROADMAP.md` ("Fase 6 — Seleção de lojas").
