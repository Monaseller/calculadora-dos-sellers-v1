# API_RULES.md — Regras de integração e sessão (CDS)

> Atualizar sempre que uma rota de API mudar de contrato ou uma nova rota `/api/*` for criada.

## Sessão / autenticação interna

Cookie httpOnly `cds_session`. Valor = `user_id` em texto puro (`lib/session.ts`). Sem assinatura, sem JWT. Valor legado `"1"` (modo single-tenant antigo) é explicitamente ignorado. Toda rota autenticada chama `getUserId(request)` e retorna 401 se ausente.

**Risco documentado:** qualquer requisição forjando `cds_session=<uuid de outro usuário>` é tratada como autenticada para aquele usuário — não há verificação de que o cookie foi de fato emitido pelo servidor para aquele valor. Ver `BUGS.md`.

## Mercado Livre

- OAuth: `app/api/auth/mercadolivre/route.ts` (start) + `.../callback/route.ts` (troca code por token). Callback trata erro/expiração do `code` (corrigido em auditoria 03/07 — antes crashava silenciosamente).
- Sync: `lib/sync-ml.ts`, `app/api/ml/*` (vendas, vendas-hoje, sync-precos, sync-skus, importar-anuncios).
- Variável de ambiente: `ML_CLIENT_ID`, `ML_CLIENT_SECRET`, `ML_REDIRECT_URI`.

## Shopee

- OAuth: `app/api/auth/shopee/route.ts` + `.../callback/route.ts`.
- Sync: `lib/sync-shopee.ts` (motor principal), `lib/shopee-api.ts` (`shopeeGet`/`shopeePost`, timeout de 15s via `AbortController`), `lib/shopee-auth.ts` (`getShopeeLojaAtiva`).
- Variáveis: `SHOPEE_PARTNER_ID`, `SHOPEE_PARTNER_KEY`, `SHOPEE_REDIRECT_URI`, `SHOPEE_BASE_URL`.
- **Duas fontes de tempo diferentes dependendo de como o sync é disparado** (`lib/sync-shopee.ts` ~linha 267): `noBuffer=true` (sync manual) usa `create_time`; `noBuffer=false` (cron) usa `pay_time`. Isso é relevante para qualquer investigação de divergência de datas — o sync manual e o automático podem classificar o mesmo pedido em dias diferentes.
- `get_order_detail`: busca em lotes de até 50 `order_sn` por chamada (`fetchShopeeDetail` em `pending-compare/route.ts`), campos: `order_status, create_time, pay_time, total_amount, actual_shipping_fee, payment_method, cancel_reason, cancel_by, income_distribution, item_list`.

## Rotas de debug (`/api/debug/*`)

Todas exigem sessão válida (401 sem cookie). Todas fazem chamadas diretas ao Supabase com a chave anon (não usam nenhuma rota intermediária de backend própria). Lista atual:

| Rota | Objetivo | Observação |
|---|---|---|
| `boundary-audit` | Testar hipótese de timezone (order_sn UTC vs `data` BRT) para 01–03/07/2026 | Tem constantes `SHOPEE_PEDIDOS=989` e `SHOPEE_VENDAS=22339.82` **hardcoded no código-fonte** — não vêm de API nem de config |
| `shopee-audit` | Breakdown por status e por campo financeiro, 29/06 a 03/07 | Mesmas constantes hardcoded |
| `nao-paid-02jul` | Testa hipótese alternativa: pedidos não-`paid` em 02/07 explicam o gap | Mesmas constantes hardcoded; objetivo textual no comentário do arquivo é literalmente "identificar os ~10 pedidos" — mesmo escopo da pergunta desta tarefa, mas por ângulo de status, não de timezone |
| `pending-compare` | Compara pedidos `pending` do banco com status atual real na API Shopee; com `?sync=1` executa sync incremental de 02/07 e reporta se "FASE_1_ENCERRADA" | Único endpoint de debug que consulta a API Shopee ao vivo, não só o banco |
| `check-loja`, `refresh-token` | utilitários de diagnóstico de conta Shopee | não revisado a fundo nesta tarefa |
| `full-reconciliation` | **Descartado** (2026-07-06): universo Shopee por create_time ∪ update_time trouxe centenas de pedidos de outros dias. Mantido no repo só como histórico, não usar para concluir nada. | — |
| `reconcile-989` | Reconciliação pedido-a-pedido: universo Shopee = get_order_list só por `create_time` (02/07 BRT), sem filtro de status; universo CDS = `data='2026-07-02' AND status='paid'`. **Rodado em 2026-07-06: total_todos_status=1102, total_status_paid=975 — nenhum bate com 989.** Pausado até `dashboard-formulas` achar a regra de status correta. | Requer loja Shopee ativa (token válido) |
| `dashboard-formulas` | Não reconcilia banco. Testa create_time/pay_time/update_time × ~14 grupos de status (todos, paid, completed, shipped, completed+shipped, paid+cancelled, exceto-unpaid, status brutos isolados) contra a API Shopee, uma única leitura reaproveitada para todas as combinações, ordenado por menor erro vs 989 pedidos/R$22.339,82. **Resultado (2026-07-06): melhor combinação foi `create_time + exceto_unpaid_e_cancelado` = 979 pedidos/R$21.977,42 — nenhuma bateu com 989.** | Requer loja Shopee ativa (token válido) |
| `verify-979` | Última validação da Fase 1: compara por order_sn os "979" da regra `create_time + exceto_unpaid_e_cancelado` (achada em dashboard-formulas) contra os "979" que a CDS mostra (`data=02/07 AND status=paid`). Diz se são o MESMO conjunto (contagem igual não implica conjunto igual) e se os valores batem pedido a pedido. | Requer loja Shopee ativa (token válido) |

**Ponto de atenção:** existem no mínimo três endpoints de debug (`boundary-audit`, `shopee-audit`, `nao-paid-02jul`) testando explicações concorrentes para o mesmo gap de 10 pedidos / R$349,34, cada um com os mesmos números da Shopee hardcoded. Nenhum dos três está marcado como "vencedor"/conclusão final adotada — ver `DECISIONS.md`.

## Limite de execução (Vercel Hobby)

Toda função declara `maxDuration` (60 ou 300), mas o plano Hobby corta em 60s independente do valor declarado. `app/api/sync/route.ts` declara 300s e pode ser cortado silenciosamente. Não corrigido — ver `BUGS.md`.
