# PROJECT_CONTEXT — Calculadora dos Sellers (CDS)

> Última atualização: 2026-07-10. Este arquivo é a fonte de verdade sobre o que o projeto é e onde está. Não depender do histórico de conversas — atualizar aqui sempre que algo mudar. (Nota: este arquivo cumpre o papel que o usuário às vezes chama de "MASTER_CONTEXT" — é o único doc de contexto geral do projeto, não duplicar.)

## Estado atual (2026-07-10)

Auditoria financeira Shopee (`get_escrow_detail`) encerrada formalmente — ver `DECISIONS.md`/`ROADMAP.md` Fase 3. Mais de 7.500 pedidos reconciliados com dados financeiros oficiais, pipeline validado. Etapa atual: arquitetura de performance (Dashboard/Vendas) — Fase 4 em `ROADMAP.md`, ainda em desenho/aprovação, nenhum código escrito ainda além do que já existe.

## O que é

ERP financeiro especializado em marketplaces — não mais "apenas uma calculadora" (reposicionamento formal em 2026-07-06). Objetivo declarado: funcionar para Shopee, Mercado Livre, Amazon, Magalu, TikTok Shop e qualquer marketplace futuro, com arquitetura genérica (sem lógica hardcoded por marketplace nas camadas de regra de negócio). Hoje só ML e Shopee estão implementados; Amazon/Magalu/TikTok são objetivo declarado, não implementação existente. Regra inegociável do projeto: nunca usar estimativas — sempre valores oficiais vindos das APIs dos marketplaces.

## Arquitetura de datas (decisão 2026-07-06 — ver DECISIONS.md e BUSINESS_RULES.md)

Três conceitos de tempo, formalmente separados: **data de criação** (auditoria/histórico, nunca referência financeira), **data de pagamento** (regra oficial para toda métrica financeira — dashboard, DRE, KPIs, ranking), **data de atualização** (uso interno de sincronização, nunca aparece em relatório). Implementada em 4 fases (A: schema, B: sync grava as 3 datas, C: APIs de vendas aceitam `date_field`, D: seletor global no frontend) — todas concluídas em 2026-07-06. Ver `BUSINESS_RULES.md` para a regra completa de fallback.

### Telas migradas vs. legadas (Fase D, 2026-07-06)

**Usam o novo parâmetro `date_field` (seletor global na TopBar já funciona):**
- Dashboard (`app/(app)/dashboard/page.tsx`) — KPIs, gráfico de evolução, balancete, top produtos, comparativo ML×Shopee, saúde financeira, alertas, Centro de Inteligência CDS. Tudo deriva do mesmo `carregar()`, que já propaga `date_field`.
- Vendas (`app/(app)/vendas/page.tsx`) — tabela de pedidos, cards de resumo (Pedidos/Unidades/Faturamento/Margem/MC%), filtros de plataforma/cadastro/status/envio (client-side, sobre o resultado já filtrado por `date_field`).

**Ainda usam a coluna legada `data` diretamente, fora do escopo da Fase D (não pedido, não alterado):**
- `app/api/ml/vendas-hoje/route.ts` — endpoint órfão: não é chamado por nenhuma tela do frontend (confirmado por busca no repositório), consulta a API do ML ao vivo por `date_created`, não lê da tabela `pedidos`. Candidato a remoção na limpeza da Fase 2, não a migração.
- As checagens de *staleness* de sync (`probeHoje`/`probe` em `shopee/vendas/route.ts` e `ml/vendas/route.ts`, e no próprio `vendas/page.tsx`/`dashboard/page.tsx`) continuam usando a coluna `data` para decidir se dispara um sync automático — isso é cache/performance, explicitamente fora do escopo da Fase C/D por instrução do usuário.
- `app/(app)/comparativo/page.tsx` — página placeholder ("Em breve"), não consome nenhuma API de vendas ainda.
- `app/(app)/historico/page.tsx`, `app/(app)/anuncios/page.tsx`, `app/(app)/precificacao/page.tsx` — não consomem `/api/ml/vendas` nem `/api/shopee/vendas`, fora do escopo.

## Stack

- Frontend/Backend: React + Next.js 14.2.5 (App Router) + TypeScript
- Banco: Supabase (Postgres), acesso via `@supabase/supabase-js` com chave anon (`NEXT_PUBLIC_SUPABASE_ANON_KEY`)
- Integrações: Mercado Livre API (OAuth), Shopee Open Platform API (Partner ID/Key)
- Deploy: Vercel (plano Hobby — limite de 60s por função serverless, independente do `maxDuration` declarado)
- Envio de email: Resend

## Estrutura real do repositório

```
app/
  (app)/            páginas autenticadas: dashboard, vendas, anuncios, precificacao, configuracoes, historico, comparativo, suporte
  api/
    auth/           login, logout, mercadolivre (oauth+callback), shopee (oauth+callback), relay, status
    ml/             sync-precos, sync-skus, importar-anuncios, vendas, vendas-hoje, item-thumbnails, debug-item
    shopee/         importar-anuncios, vendas, status, ping
    sync/           route.ts (cron) + manual/route.ts
    lojas/          route.ts, ativar, desconectar
    perfil/         route.ts
    admin/shopee/reconciliar-financeiro/route.ts  reconciliação financeira via get_escrow_detail (separada do sync principal, gated por sessão, não exposta em tela/menu)
    debug/          boundary-audit, shopee-audit, nao-paid-02jul, pending-compare, check-loja, refresh-token
lib/
  date-field-context.tsx      contexto React do seletor global "Data de Pagamento"/"Data de Criação" (Fase D)
  cds-engine.ts               motor de cálculo de margem/precificação
  comissoes-mercado-livre.ts  tabela de comissão ML
  comissoes-shopee.ts         tabela de comissão Shopee
  mercado-livre.ts, ml-auth.ts, ml-promotions.ts
  shopee-api.ts, shopee-auth.ts
  sync-ml.ts, sync-shopee.ts  motores de sincronização (fonte de verdade dos pedidos gravados)
  session.ts                  sessão via cookie httpOnly `cds_session` (valor = user_id; single string, sem JWT)
  supabase.ts, tabela-frete-ml.ts
supabase/
  migration_pedidos.sql                    schema base da tabela `pedidos`
  migrations/20260703_pedidos_novos_campos.sql  colunas adicionadas em 03/07
```

Também na raiz: `supabase-migrate-erp.sql`, `supabase-migration-fase1.sql` (15 colunas de income_distribution/Shopee), `supabase-migration-sku-lucro.sql`, `supabase-migration-variation.sql`, `supabase-setup.sql` — múltiplos scripts de migração soltos, sem numeração/controle de versão único. Ver `DATABASE.md` para detalhe e um ponto de atenção sobre isso.

## Fórmula oficial da V1 (README original)

```
margem_contrib % = (valor líquido recebido - imposto - custo do produto) / valor anunciado × 100
```

Faixas de saúde: verde ≥ 20%, amarelo 10–19,99%, vermelho < 10%.

## O que já funciona

**Mercado Livre:** OAuth, token, categoria automática, tipo de anúncio, comissão automática, precificação.

**Shopee:** login, sincronização, dashboard, banco, income distribution, correção de paginação, correção de status, correção de upsert, correção de item_subtotal.

## Autenticação / sessão

Sessão é um cookie httpOnly `cds_session` cujo valor é o `user_id` em texto puro (ver `lib/session.ts`). Não há verificação de assinatura/JWT — qualquer requisição com um cookie `cds_session=<uuid válido>` é tratada como autenticada para aquele usuário. Ver `BUGS.md` e `API_RULES.md`.

## Ambiente

Variáveis relevantes em `.env.local` (não versionado): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `ML_CLIENT_ID/SECRET/REDIRECT_URI`, `SHOPEE_PARTNER_ID/KEY/REDIRECT_URI/BASE_URL`, `NEXT_PUBLIC_SITE_URL`.

## Limitação conhecida do ambiente Claude/Cowork

O sandbox usado pelo assistente não tem acesso de rede liberado para `*.supabase.co` (proxy retorna `403 blocked-by-allowlist`). Isso significa que o assistente **não consegue executar queries reais no banco nem chamar os endpoints `/api/debug/*` diretamente** — qualquer número reportado precisa vir de (a) o usuário rodando o endpoint no navegador logado e colando o JSON, ou (b) o usuário rodando a query SQL equivalente no SQL Editor do Supabase.
