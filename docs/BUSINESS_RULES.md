# BUSINESS_RULES.md — Regras de negócio (CDS)

> Atualizar sempre que uma regra financeira/contábil mudar.

## Regra inegociável do projeto

Nunca usar estimativas. Todo número exibido ao usuário deve vir de valor oficial retornado pela API do marketplace (ML ou Shopee), não de cálculo aproximado feito localmente — exceto quando a própria API não retorna o dado (ex.: `income_distribution` só existe para pedidos `COMPLETED`; para pedidos em trânsito o fallback é uma tabela de estimativa de comissão, documentado como fallback explícito, não como valor oficial).

## Margem de contribuição (fórmula V1, README)

```
margem_contrib % = (valor líquido recebido - imposto - custo do produto) / valor anunciado × 100
```

Faixas de saúde do produto: verde ≥ 20%, amarelo 10–19,99%, vermelho < 10%.

## Contagem de "pedidos" (o que conta como venda)

Só pedidos com `status = 'paid'` entram em `pedidosUnicos` e em totais de faturamento — cancelados, devoluções, pendentes e status desconhecidos ficam de fora (corrigido em `RELATORIO_FASE1.md` P5 e `AUDITORIA_FINAL.md` BUG-PIPE-3). Mapeamento de status Shopee → CDS:

| Status Shopee | Status CDS | Entra em faturamento/pedidos? |
|---|---|---|
| READY_TO_SHIP, RETRY_SHIP, PROCESSED, SHIPPED, TO_CONFIRM_RECEIVE, COMPLETED | paid | sim |
| UNPAID | pending | não |
| CANCELLED, IN_CANCEL | cancelled | não |
| TO_RETURN, RETURN, RETURN_APPROVE, RETURN_DONE, REFUND, DAMAGED | devolucao | não |
| LOST | lost | não |
| qualquer outro | unknown | não |

## Reconciliação financeira Shopee (`get_escrow_detail`) — regras oficiais (fechado 2026-07-10)

`get_order_detail` não fornece `income_distribution` para contas Open Platform Brasil — os dados financeiros oficiais vêm de `/api/v2/payment/get_escrow_detail`, via rotina separada (`app/api/admin/shopee/reconciliar-financeiro/route.ts`), não do sync principal.

- **`escrow_amount` = `escrow_amount_after_adjustment` quando existir, senão `escrow_amount`.** É o valor final pós-ajustes reais da Shopee (DIFAL, débitos fiscais, correções pós-reembolso) — usar sempre este como receita líquida do vendedor, nunca o `escrow_amount` bruto isoladamente.
- **`has_income_data = true` sempre que a Shopee retornar um `order_income` válido**, independente do valor de `escrow_amount` ser positivo, zero ou negativo. Zero (devolução total) e negativo (débito pós-reembolso) são eventos financeiros reais, não "dado ausente" — não usar `escrow_amount > 0` como critério.
- Reconciliação é idempotente: `has_income_data=true` bloqueia reprocessamento, exceto com `force=1`.
- **"Vendas sem os descontos da plataforma" não tem fórmula confirmada** — não implementar `seller_product_rebate` nem qualquer outro campo como regra oficial dessa métrica. Ver `DECISIONS.md` para o histórico completo e o critério de reabertura.
- O faturamento atualmente exibido (`item_subtotal`, com fallback para `faturamento`/`total_amount`) permanece a regra vigente até nova decisão explícita — não alterado por esta auditoria.

## Faturamento Shopee — campo de referência

Ainda em aberto qual campo bate exatamente com o "Faturamento"/"Vendas" exibido no painel oficial da Shopee: candidatos são `item_subtotal` (preço puro dos itens), `faturamento` (`total_amount` proporcional, inclui frete do comprador) e `buyer_paid_amount`/`escrow_amount` (fontes de `income_distribution`). Ver `DECISIONS.md` — decisão pendente de confirmação empírica comparando com o painel.

## "Vendas sem os descontos da plataforma" — não usar como número conciliado

Essa métrica do Seller Center **não deve ser exibida nem calculada no CDS como valor oficial/conciliado**. Motivo: investigação exaustiva (campo a campo, `seller_product_rebate`, `promotion_list`, força bruta descartada, auditoria estrutural completa dos ~130 campos de `get_escrow_detail`) não encontrou fórmula que a reproduza — ver `DECISIONS.md` para o histórico completo e as ressalvas ainda em aberto (endpoints não testados, exportação por pedido não confirmada). Se essa métrica precisar aparecer em alguma tela no futuro, só com aviso explícito de que é aproximada/não conciliada — nunca como valor oficial. Mesma regra de "nunca usar estimativas" já vigente no projeto (topo deste arquivo).

## Comissão Shopee — pendência conhecida

O cálculo de margem Shopee usa `faixa.comissao + TAXA_CAMPANHA_SHOPEE` mas **não inclui `taxaFixa`** (ex.: R$0,30 por pedido em itens abaixo de R$30). Isso subestima o custo em ~R$0,10–0,30 por pedido nos itens de menor valor. Correção sugerida e ainda não aplicada, documentada em `AUDITORIA_FINAL.md`. Depende também de saber se a conta é CPF ou CNPJ (impacta a taxa correta) — schema de lojas ainda não tem esse campo.

## Arquitetura de três datas (decisão 2026-07-06 — status: APROVADA, ver `DECISIONS.md` para o registro completo das respostas do usuário)

A CDS separa formalmente três conceitos de tempo por pedido. Os nomes de campo abaixo (`create_time`/`pay_time`/`update_time`) são os nomes nativos da API da Shopee — **são usados aqui como atalho de comunicação, não como nome de coluna/variável genérica**. Cada marketplace mapeia seu próprio campo nativo para os três conceitos abstratos (`data_criacao`, `data_pagamento`, `data_atualizacao`); ver tabela de mapeamento por marketplace abaixo.

### 1. Data de criação (`data_criacao`)

Quando o pedido foi criado pelo cliente. Uso: auditorias, comparação com Seller Center, histórico operacional, relatórios por criação, localização de divergências. **Nunca usada como referência financeira.**

### 2. Data de pagamento (`data_pagamento`)

Quando a venda aconteceu financeiramente. **Regra oficial da CDS para toda métrica financeira**: dashboard principal, faturamento, receita, fluxo de caixa, lucro, DRE, balancete, KPIs financeiros, produtos mais vendidos, ranking, comissão.

**Regra para pedido sem pagamento confirmado (definida pelo usuário em 2026-07-06 — substitui a proposta inicial de fallback automático):**
- Se o pedido tem `pay_time`/equivalente → `data_pagamento` recebe essa data.
- Se o pedido **não** tem pagamento confirmado (cancelado antes de pagar, ou pendente) → `data_pagamento` fica **NULL**. Não cai para `data_criacao` automaticamente dentro do próprio campo.
- **Visão financeira** (faturamento, DRE, KPIs): pedidos com `data_pagamento` NULL **não entram** no cálculo — é a query/tela financeira que filtra por `data_pagamento IS NOT NULL`, não um valor substituto gravado no campo.
- **Visão operacional** (histórico, auditoria, "pedidos do período" sem filtro financeiro): usa `data_criacao` para esses mesmos pedidos.
- Ou seja: o fallback acontece na camada de exibição/consulta (qual coluna a view usa), não como valor de fallback dentro da própria coluna `data_pagamento`.

**Pedido pago e depois cancelado/estornado:** mantém a `data_pagamento` original (a venda aconteceu financeiramente naquele momento, mesmo que revertida depois) — o *status atual* (paid/cancelled/devolucao) é que decide se entra ou não no somatório de receita/faturamento de um relatório, não a data. Isto ainda depende de o status no banco estar atualizado — ver limitação de reconciliação de status em `BUGS.md` (tratada separadamente, por decisão explícita do usuário).

### 3. Data de atualização (`data_atualizacao`)

Quando o marketplace alterou qualquer informação do pedido. Uso exclusivo: sincronização incremental, cron, reconciliação. **Nunca aparece em relatório ou tela para o usuário.**

### Mapeamento por marketplace

| Conceito | Shopee (campo nativo) | Mercado Livre (campo nativo) | Amazon/Magalu/TikTok |
|---|---|---|---|
| data_criacao | `create_time` | `date_created` | não implementado — mapear ao integrar |
| data_pagamento | `pay_time` (NULL se não pago) | `payments[].date_approved` (NULL se não aprovado) | não implementado |
| data_atualizacao | `update_time` | não há campo direto hoje — ML sync não usa update_time (ver `BUGS.md`, ML sempre range por `date_created`) | não implementado |

**Decidido (2026-07-06):** ML hoje NÃO tem um mecanismo de sync incremental por `update_time` equivalente ao da Shopee — `lib/sync-ml.ts` sempre busca por `date_created` (histórico) com buffer de -5 dias no cron, nunca por "o que mudou". Por decisão do usuário, isso **fica como está por enquanto**: Shopee usa `update_time` para sync incremental; ML continua com a estratégia atual (`date_created` + buffer) até existir uma solução seguindo o padrão de notificação/webhook do ML. Não é bloqueante para a Fase A/B — a camada de sync permanece marketplace-específica por baixo de uma interface comum (`syncXForUser(userId, dateFrom, dateTo, noBuffer)`), o que já é o caso hoje.

## Fase C — `date_field` nas APIs de vendas (implementado 2026-07-06)

`app/api/shopee/vendas/route.ts` e `app/api/ml/vendas/route.ts` aceitam `?date_field=pagamento|criacao` (padrão: `pagamento`). Frontend ainda não foi alterado — só a API.

**`date_field=pagamento`** (visão financeira): filtra por `data_pagamento`. Regra de fallback restrita, para não violar a regra de NULL-sem-fallback da seção acima:
- Pedido com `data_pagamento` preenchido → entra se estiver no range.
- Pedido com `data_pagamento` NULL **e** `data_criacao` NULL (nunca tocado pelo sync pós-Fase-B) → cai no fallback: usa a coluna `data` legada. Este é o único caso em que o fallback se aplica.
- Pedido com `data_pagamento` NULL mas `data_criacao` preenchido (sincronizado depois da Fase B, genuinamente não pago) → **fica de fora**, sem exceção. Não usa `data_criacao` nem `data` como substituto — é exatamente o comportamento que a arquitetura de três datas foi desenhada para garantir.

**`date_field=criacao`** (visão operacional): filtra por `data_criacao`, com fallback simples para `data` legada quando `data_criacao` é NULL (pedido pré-Fase-B). Não tem a restrição acima porque não há regra de exclusão por não-pagamento nessa visão.

**Decisão explícita do usuário (2026-07-06):** ao ser alertado que um fallback genérico "`data_pagamento` NULL → usa `data` legada" reintroduziria a contaminação create_time/pay_time que a arquitetura de três datas resolveu, o usuário optou por manter o fallback para pedidos pré-Fase-B (em vez de excluí-los até ressincronizar) — mas com o escopo restrito acima (exige `data_criacao` também NULL), que evita a contaminação em pedidos novos.

`data_atualizacao_marketplace` não é usada em nenhum filtro de relatório (regra 5 da Fase C) — uso exclusivo de sync/reconciliação, como já documentado na seção anterior.

## Timezone dos pedidos (BRT vs UTC) — resolvido para fins de exibição, mecanismo permanece

A data é sempre gravada/exibida em BRT (UTC-3), calculada a partir do epoch do campo relevante (`data_criacao` ou `data_pagamento`, conforme o contexto). A Shopee usa UTC no prefixo do `order_sn` — isso é só uma característica do identificador, não afeta mais a regra de exibição de data. Casos de fronteira 21h-24h BRT (pedido "muda de dia" no prefixo do order_sn vs data BRT real) foram confirmados com pedidos reais durante a investigação de 2026-07-06 (ver `BUGS.md`) — não são bug, são o comportamento esperado do fuso.

## Integridade dos dados financeiros no banco — garantia parcial desde 2026-08-19

A partir da SEC-1 (ver `DECISIONS.md`), **nenhum dado do CDS pode ser apagado com a chave pública**. `anon` e `authenticated` perderam `DELETE` e `TRUNCATE` nas 33 tabelas de `public`, incluindo `pedidos`, `lojas`, `perfil` e `dashboard_resumos_diarios`. A garantia vale também para tabelas criadas no futuro por `postgres` neste schema.

**A garantia é de não-destruição, não de integridade.** `SELECT`, `INSERT` e `UPDATE` continuam disponíveis a `anon` — logo, com a chave pública ainda é possível **ler** e **alterar** valor financeiro em `pedidos`, e escrever em `dashboard_resumos_diarios`. Nenhum número financeiro deve ser tratado como inviolável no banco enquanto essa superfície existir. As regras que protegem o valor financeiro continuam sendo as da aplicação: origem em API oficial, cálculo determinístico, e o snapshot financeiro v2 preservado por `protegerSnapshotFinanceiro`.

Fechar `SELECT`/`INSERT`/`UPDATE` anônimos é a próxima frente (PR #2), e só ela transforma esta garantia parcial em integridade real.

**SEC-2a (2026-08-19):** a role `authenticated` do Supabase perdeu **todos** os privilégios de tabela nas 33. Ela não era usada pelo CDS — a autenticação é própria (`perfil` + cookie `cds_session`), e a chave pública do projeto resolve para `anon`. Isso não altera nenhuma regra de negócio nem o acesso atual; registra-se porque fecha uma porta que se abriria sozinha caso o projeto passasse a usar Supabase Auth sem revisar privilégios. **A superfície que ainda alcança dado financeiro continua sendo `anon`.**
