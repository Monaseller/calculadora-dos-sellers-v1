# RELATÓRIO FASE 1 — CONFIABILIDADE DOS DADOS
**Data:** 03/07/2026  
**Objetivo:** CDS exibir exatamente os mesmos números oficiais da Shopee.

---

## BUGS CORRIGIDOS NESTA FASE

### P1 — income_distribution implementado (`lib/sync-shopee.ts`)

| Campo armazenado | Origem | Representa |
|-----------------|--------|-----------|
| `item_subtotal` | `model_discounted_price × qty` | Preço puro dos itens (sem frete) |
| `buyer_paid_amount` | `income_distribution.buyer_total_amount` | Total pago pelo comprador |
| `escrow_amount` | `income_distribution.escrow_amount` | Receita bruta do vendedor (Shopee paga este valor) |
| `commission_fee` | `income_distribution.commission_amount` | Comissão cobrada pela Shopee |
| `service_fee` | `income_distribution.service_fee` | Taxa de serviço Shopee |
| `transaction_fee` | `income_distribution.seller_transaction_fee` | Taxa de transação |
| `campaign_fee` | `income_distribution.campaign_fee` | Taxa de campanha/publicidade |
| `voucher_from_shopee` | `income_distribution.voucher_from_shopee` | Voucher custeado pela Shopee (beneficia o vendedor) |
| `voucher_from_seller` | `income_distribution.voucher_from_seller` | Voucher custeado pelo vendedor (reduz receita) |
| `seller_income` | `escrow_amount - custo - imposto - frete_vendedor` | Lucro líquido real |
| `has_income_data` | calculado | `true` quando income_distribution foi retornado |

**Lógica de uso:**
- Quando `has_income_data = true`: usa valores oficiais da Shopee para `tarifa_venda` e `margem_contrib`
- Quando `has_income_data = false`: fallback para tabela de estimativa (com base corrigida)

---

### P2 — item_subtotal vs faturamento separados para diagnóstico

Os dois campos agora ficam no banco separados. Após resync:

| Campo | Fórmula | Compare com no painel Shopee |
|-------|---------|------------------------------|
| `item_subtotal` | `model_discounted_price × qty` | "Valor dos Itens" ou "GMV" |
| `faturamento` | `total_amount` proporcional | "Total do Pedido" (inclui frete comprador) |
| `buyer_paid_amount` | `income_distribution.buyer_total_amount` | "Total Pago pelo Comprador" |
| `escrow_amount` | `income_distribution.escrow_amount` | "Receita do Vendedor" / "Ganhos" |

**Para identificar o campo correto:**  
No painel Shopee → Minha Loja → Pedidos → Ver o número de "Faturamento" ou "Vendas".  
Execute `SELECT SUM(item_subtotal), SUM(faturamento), SUM(buyer_paid_amount) FROM pedidos WHERE user_id = 'SEU_ID' AND marketplace = 'Shopee' AND status = 'paid' AND data BETWEEN '2026-06-01' AND '2026-06-30'` e compare com o painel.

---

### P3 — Comissão usa income_distribution quando disponível

**Antes:** `tarifaVenda = faturamento × (comissao% + taxa_campanha)` — base errada (incluía frete)  
**Depois:**
- Com `income_distribution`: `tarifaVenda = (commission_fee + service_fee + campaign_fee + transaction_fee) × ratioItem`
- Sem `income_distribution`: `tarifaVenda = itemValue × (comissao% + taxa_campanha)` — base corrigida para item price (não faturamento)

---

### P4 — Pedidos com item_list vazio agora salvos no banco

**Antes:** pedidos sem itens eram contados em `found` mas não salvos → divergência na contagem.  
**Depois:** pedidos sem item_list geram uma row com `ml_item_id = ""` e `anuncio = "(sem item_list)"` para que o pedido seja contabilizado.

---

### P4 — Upsert com verificação de erro

**Antes:** `await supabase.upsert(...)` — resultado ignorado, falhas silenciosas.  
**Depois:**
```typescript
const { error } = await supabase.from("pedidos").upsert(...);
if (error) { upsertErrors++; console.error("[sync-shopee] upsert batch falhou:", error.message); }
```
O campo `upsertErrors` é retornado por `syncShopeeForUserV2` para diagnóstico externo.

---

### P5 — Todos os status mapeados, default "unknown" (não "paid")

**Antes:** `return m[s] ?? "paid"` — status desconhecidos inflavam faturamento  
**Depois:** `return m[s] ?? "unknown"` — status unknown ignorado em `totais` e `pedidosUnicos`

Novos status adicionados:
| Status Shopee | Mapeado para | Entra no faturamento? |
|--------------|-------------|----------------------|
| `RETRY_SHIP` | paid | ✅ sim |
| `RETURN` | devolucao | ❌ não |
| `RETURN_APPROVE` | devolucao | ❌ não |
| `RETURN_DONE` | devolucao | ❌ não |
| `REFUND` | devolucao | ❌ não |
| `LOST` | lost | ❌ não |
| `DAMAGED` | devolucao | ❌ não |
| desconhecido | unknown | ❌ não |

---

### P5 — totalOrders nas rotas API conta apenas pedidos paid

**Antes:** `new Set(rows.map(r => r.orderId)).size` — incluía cancelados  
**Depois:** `new Set(rows.filter(r => r.status === 'paid').map(r => r.orderId)).size`  
Aplicado em: `app/api/shopee/vendas/route.ts` e `app/api/ml/vendas/route.ts`

---

## ARQUIVOS MODIFICADOS

| Arquivo | Alterações |
|---------|-----------|
| `lib/sync-shopee.ts` | Reescrito completo: P1–P5 |
| `app/api/shopee/vendas/route.ts` | totalOrders → apenas paid |
| `app/api/ml/vendas/route.ts` | totalOrders → apenas paid |
| `supabase-migration-fase1.sql` | Novo: 15 novas colunas na tabela pedidos |

---

## AÇÃO OBRIGATÓRIA ANTES DE TESTAR

### 1. Executar migration no Supabase

Abra o Supabase → SQL Editor → Cole e execute o conteúdo de `supabase-migration-fase1.sql`.  
Este script adiciona 15 novas colunas à tabela `pedidos`. Sem isso, o upsert vai falhar.

### 2. Fazer resync do período de comparação

Após executar a migration, sincronize o mesmo período que você tem no painel Shopee:
- Clique em **Sincronizar → Este mês** (ou o período desejado)
- Aguarde a conclusão

### 3. Comparar os números

Execute no Supabase SQL Editor:
```sql
SELECT
  COUNT(DISTINCT order_id) FILTER (WHERE status = 'paid')         AS pedidos,
  SUM(item_subtotal)       FILTER (WHERE status = 'paid')         AS faturamento_itens,
  SUM(faturamento)         FILTER (WHERE status = 'paid')         AS faturamento_total_amount,
  SUM(buyer_paid_amount)   FILTER (WHERE status = 'paid')         AS faturamento_income_dist,
  SUM(escrow_amount)       FILTER (WHERE status = 'paid')         AS receita_vendedor,
  SUM(commission_fee)      FILTER (WHERE status = 'paid')         AS comissao_oficial,
  COUNT(*) FILTER (WHERE has_income_data = true)                  AS rows_com_income_data,
  COUNT(*) FILTER (WHERE has_income_data = false)                 AS rows_sem_income_data
FROM pedidos
WHERE user_id     = 'SEU_USER_ID'
  AND marketplace = 'Shopee'
  AND data BETWEEN '2026-06-01' AND '2026-06-30';
```

Compare `pedidos` com o painel Shopee. Compare `faturamento_itens`, `faturamento_total_amount` e `receita_vendedor` com o que o Shopee chama de "Faturamento" no painel. O que bater define qual campo usar.

---

## PENDÊNCIAS IDENTIFICADAS (próximas fases)

| Bug | Impacto | Quando corrigir |
|-----|---------|-----------------|
| taxaFixa ausente (BUG-COM-2) | Comissão subestimada R$4–28/pedido | Após confirmar CNPJ/CPF da conta |
| CNPJ vs CPF não determinado | taxaFixa usa taxa errada | Após schema de lojas incluir tipo_conta |
| pedidoToRow não expõe novos campos | UI não vê escrow_amount, seller_income etc. | Após confirmar qual campo = faturamento |
| ML variation_id sempre null | Variações ML invisíveis | Fase 2 |
| ML totalOrders no cron | Mesmo bug P5 | Próxima fase |

---

## VALIDAÇÃO TÉCNICA

```
npx tsc --noEmit → zero erros ✅
```
