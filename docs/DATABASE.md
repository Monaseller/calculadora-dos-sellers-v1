# DATABASE.md — Schema Supabase (CDS)

> Atualizar sempre que uma migration for criada/aplicada.

## Tabela `pedidos`

Cache unificado de pedidos ML + Shopee. PK sintética: `userId_MKTPLACE_orderId_itemId_variationId`.

Colunas base (`supabase/migration_pedidos.sql`):

| Coluna | Tipo | Observação |
|---|---|---|
| id | TEXT PK | composta |
| user_id | TEXT | dono do registro (RLS/filtro manual, ver BUGS.md) |
| marketplace | TEXT | `'ML'` \| `'Shopee'` |
| order_id | TEXT | order_sn (Shopee) ou order id (ML) |
| data | DATE | LEGADO/fallback — data gravada em BRT pela regra antiga (create_time no sync histórico, pay_time no cron). Mantida sem alteração; ver nota de arquitetura de datas abaixo |
| data_criacao | DATE | **(migration `20260706_separacao_datas.sql`, executada — confirmado em uso ativo)** quando o pedido foi criado no marketplace. Nunca usar como referência financeira. NULL em pedidos sincronizados antes desta migration — sem backfill agressivo (decisão do usuário) |
| data_pagamento | DATE | **(migration `20260706_separacao_datas.sql`, executada — confirmado em uso ativo, é o campo usado em toda a reconciliação financeira e no seletor global)** quando o pedido foi pago. NULL se nunca foi pago — não recebe fallback automático; a aplicação decide usar `data_criacao` na visão operacional. Regra oficial da CDS para toda métrica financeira |
| data_atualizacao_marketplace | TIMESTAMPTZ | **(migration `20260706_separacao_datas.sql`, executada)** timestamp bruto da última alteração do pedido no marketplace (ex.: `update_time` Shopee). Uso interno de sync/reconciliação futura |
| status | TEXT | `paid`, `pending`, `cancelled`, `devolucao`, `lost`, `unknown` — valor JÁ remapeado por `mapStatus()`, nunca usar pra saber o status real da Shopee |
| status_shopee_raw | TEXT | **(migration `20260707_status_shopee_raw.sql`, executada — confirmado em uso ativo na reconciliação financeira, filtro `status_shopee_raw='COMPLETED'`)** status bruto original da Shopee (`UNPAID`, `READY_TO_SHIP`, `SHIPPED`, `COMPLETED`, `CANCELLED`, etc.), antes do `mapStatus()`. Só auditoria/diagnóstico — nunca regra de negócio. NULL em pedidos sincronizados antes de 2026-07-07 |
| valor_unit, qtd, faturamento, custo, imposto, tarifa_venda | NUMERIC | motor de cálculo de margem |
| frete_comprador, frete_vendedor | NUMERIC | |
| margem_contrib, mc_percent | NUMERIC | saída do cálculo |
| synced_at | TIMESTAMPTZ | |

Colunas adicionadas em 03/07/2026 (`supabase/migrations/20260703_pedidos_novos_campos.sql`): `frete_real`, `frete_estimado`, `lucro_liquido`, `roi`, `forma_pagamento`, `codigo_rastreio`, `transportadora`, `imagem_url`, `buyer_username`, `buyer_cidade`, `buyer_estado`. Índices: `pedidos_user_data_idx`, `pedidos_user_marketplace_data_idx`, `pedidos_synced_at_idx`.

Colunas de income_distribution da Shopee (`supabase-migration-fase1.sql`, 15 colunas — conferir arquivo para lista exata, inclui pelo menos): `item_subtotal`, `buyer_paid_amount`, `escrow_amount`, `commission_fee`, `service_fee`, `transaction_fee`, `campaign_fee`, `voucher_from_shopee`, `voucher_from_seller`, `seller_income`, `has_income_data`.

**Fonte real desses valores (fechado 2026-07-10):** `get_order_detail` NÃO fornece `income_distribution` (confirmado vazio/ausente para contas BR) — os valores acima são gravados por uma rotina separada, `app/api/admin/shopee/reconciliar-financeiro/route.ts`, que consulta `/api/v2/payment/get_escrow_detail` por pedido. `escrow_amount` gravado é `income.escrow_amount_after_adjustment ?? income.escrow_amount` (valor pós-ajuste é a regra, não o bruto). `has_income_data=true` é gravado sempre que a Shopee retornar um `order_income` válido, independente do sinal de `escrow_amount`. Migration de índices para essa rotina: `20260707_indices_reconciliacao_financeira.sql` (executada). Ver `BUSINESS_RULES.md` e `DECISIONS.md` para o histórico completo.

**Distinção crítica de faturamento** (de `RELATORIO_FASE1.md`):

| Campo | Fórmula | Equivale no painel Shopee a |
|---|---|---|
| `item_subtotal` | `model_discounted_price × qty` | "Valor dos Itens" / GMV |
| `faturamento` | `total_amount` distribuído proporcionalmente por item | "Total do Pedido" (inclui frete pago pelo comprador) |
| `buyer_paid_amount` | `income_distribution.buyer_total_amount` | "Total Pago pelo Comprador" |
| `escrow_amount` | `income_distribution.escrow_amount` | "Receita do Vendedor" / Ganhos |

Ainda não está formalmente decidido qual campo é o "faturamento oficial" a ser exibido no dashboard — ver `DECISIONS.md`.

## Arquitetura de datas (decisão 2026-07-06 — ver `DECISIONS.md` e `BUSINESS_RULES.md`)

`data` (legado) é gravada em BRT (UTC-3) por uma regra que mistura `create_time` (sync histórico) e `pay_time` (cron) — sintoma do problema que motivou a separação em três colunas (`data_criacao`, `data_pagamento`, `data_atualizacao_marketplace`, todas na migration `20260706_separacao_datas.sql`, ainda não executada). O `order_id`/`order_sn` da Shopee tem prefixo `YYMMDD` que reflete a data em UTC no momento da criação do pedido — pedidos criados entre ~21h e 23h59 BRT caem no dia seguinte em UTC, confirmado com pedidos reais durante a investigação de 2026-07-06 (ver `BUGS.md`). `lib/sync-shopee.ts:267` (`noBuffer=true` usa `create_time`, `noBuffer=false` usa `pay_time`) é o código-fonte dessa mistura, ainda não alterado (Fase B da separação de datas, pendente).

## Migrations soltas — ponto de atenção

O repositório tem migrations em dois lugares diferentes sem numeração sequencial única: arquivos soltos na raiz (`supabase-migrate-erp.sql`, `supabase-migration-fase1.sql`, `supabase-migration-sku-lucro.sql`, `supabase-migration-variation.sql`, `supabase-setup.sql`) e uma pasta `supabase/` com `migration_pedidos.sql`, `supabase/migrations/20260703_pedidos_novos_campos.sql` e `supabase/migrations/20260706_separacao_datas.sql` (esta última criada mas **ainda não executada no banco** — só o arquivo existe no repo). Não há como saber, só olhando os nomes, qual conjunto já foi de fato aplicado em produção nem a ordem de aplicação. Isso é uma fonte de risco: alguém pode reaplicar a migration errada ou assumir uma coluna existe que não foi migrada ainda. Recomendação: consolidar em uma única pasta com prefixo de data/sequência antes que o schema cresça mais.

## RLS

Não há evidência no código revisado de que Row Level Security está configurada nas tabelas — o isolamento por usuário é feito inteiramente via `.eq("user_id", userId)` na aplicação, usando a chave anon do Supabase. Se RLS não estiver ativa, a chave anon pode ler/escrever qualquer linha de qualquer usuário caso alguém obtenha a `NEXT_PUBLIC_SUPABASE_ANON_KEY` (que é pública no bundle do cliente, por definição do prefixo `NEXT_PUBLIC_`). Isso precisa ser confirmado diretamente no Supabase (Authentication > Policies) — não foi possível confirmar aqui por falta de acesso de rede ao Supabase a partir do sandbox.
