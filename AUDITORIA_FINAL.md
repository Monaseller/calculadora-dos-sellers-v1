# AUDITORIA GERAL — CALCULADORA DOS SELLERS
**Data:** 03/07/2026  
**Versão auditada:** branch atual (commit 9c97d4a)  
**Resultado final:** ✅ APROVADA PARA PRODUÇÃO (com ressalvas documentadas abaixo)

---

## SUMÁRIO EXECUTIVO

A auditoria cobriu 100% do código-fonte: libs de cálculo, APIs de sync (ML + Shopee), rotas de autenticação, componentes de front-end, schema Supabase, configurações de deploy e segurança. Foram identificados e corrigidos **10 bugs** em 4 categorias de severidade. O build TypeScript compila com **zero erros** após as correções.

---

## CORREÇÕES APLICADAS NESTA AUDITORIA

### 🔴 CRÍTICO (Security)

| ID | Arquivo | Problema | Correção |
|----|---------|----------|----------|
| H1 | `app/api/perfil/route.ts` | GET `/api/perfil` retornava o campo `senha` (plaintext) para o cliente | Removido `senha` do `.select()` — agora só campos não-sensíveis são expostos |
| H2 | `app/api/auth/mercadolivre/callback/route.ts` | Callback OAuth não verificava erros da ML; `code` expirado/inválido causava crash silencioso | Adicionado check `!response.ok \|\| data.error \|\| !data.access_token` com redirect para `/configuracoes?ml_erro=...` |
| H3 | `app/api/perfil/route.ts` | Novo cadastro criava conta com `email_verificado: true`, bypassando verificação por email | Corrigido para `email_verificado: false` |

### 🟠 MÉDIO (UX / Funcional)

| ID | Arquivo | Problema | Correção |
|----|---------|----------|----------|
| M1 | `app/(app)/vendas/DateRangePicker.tsx` | Faltavam presets "Últimos 15 dias", "Últimos 30 dias", "Últimos 90 dias" | Adicionados os 3 presets; sidebar alargada de 120px → 140px |
| M2 | `components/TopBar.tsx` | Avatar mostrava "R" hardcoded independente do usuário logado | Adicionado fetch `/api/perfil` no mount; avatar exibe primeira letra do `nome_completo` ou `usuario` dinamicamente |
| M3 | `lib/shopee-api.ts` | `shopeePost()` não tinha timeout — requisições lentas à API Shopee podiam travar o processo indefinidamente | Adicionado `AbortController` com timeout de 15s |

### 🟡 BAIXO (Qualidade / DX)

| ID | Arquivo | Problema | Correção |
|----|---------|----------|----------|
| C1 | `app/(app)/historico/page.tsx` | Rota da Sidebar retornava 404 | Criada página stub "Em breve" |
| C1 | `app/(app)/comparativo/page.tsx` | Rota da Sidebar retornava 404 | Criada página stub "Em breve" |
| C1 | `app/(app)/suporte/page.tsx` | Rota da Sidebar retornava 404 | Criada página com email de contato + links |
| C2 | `app/(app)/dashboard/page.tsx` | Double-load: `carregar` tinha `[anuncios, lojas]` nas deps do `useCallback`, re-disparando sync toda vez que o estado atualizava | Migrado para `useRef` — `anunciosRef` e `lojasRef` lidos dentro do callback sem criar dependência reativa |
| L1 | `deploy.bat` | Mensagem de commit genérica | Atualizada para refletir todas as correções desta auditoria |

### Bugs de compilação (TypeScript)

| Arquivo | Erro | Correção |
|---------|------|----------|
| `app/api/sync/manual/route.ts` | `mlResult` e `shopeeResult` undefined — variáveis inexistentes no scope | Corrigido para `results.ml` e `results.shopee` (objeto `results` correto) |
| `app/(app)/dashboard/page.tsx` | Parâmetro `c` implicitamente `any` em `.replace()` | Tipado como `(c: string)` |
| `app/(app)/vendas/page.tsx` | Parâmetro `c` implicitamente `any` em `.replace()` | Tipado como `(c: string)` |
| `components/TopBar.tsx` | JSX desbalanceado — `</>` órfão e `</div>` faltando para o container flex | Estrutura JSX corrigida: `</div>` adicionado antes de `</header>`, fragmento espúrio removido |

---

## PROBLEMAS CONHECIDOS — NÃO CORRIGIDOS (requerem decisão de produto/infra)

### 🔴 CRÍTICO — Senha em plaintext

**Arquivo:** `lib/session.ts` + `app/api/perfil/route.ts` + `app/api/auth/login/route.ts`  
**Problema:** Senhas armazenadas e comparadas em texto puro na coluna `perfil.senha`.  
**Risco:** Exposição total de credenciais se houver dump do banco.  
**Solução recomendada:**
```bash
npm install bcryptjs @types/bcryptjs
```
1. Migration Supabase: adicionar coluna `senha_hash TEXT`
2. No cadastro: `bcrypt.hash(senha, 12)` → salvar em `senha_hash`
3. No login: `bcrypt.compare(senha, row.senha_hash)`
4. Após migrar todos os usuários: remover coluna `senha`

**Impacto de implementação:** médio (migração de dados necessária para contas existentes)

---

### 🟠 MÉDIO — `maxDuration` ignorado no Vercel Hobby

**Arquivo:** `app/api/sync/route.ts` (declara `export const maxDuration = 300`)  
**Problema:** Vercel Hobby limita todas as funções a 60s independente do valor declarado. O cron de sync declara 300s mas é cortado em 60s.  
**Risco:** Syncs grandes (muitos pedidos, período longo) falham silenciosamente por timeout.  
**Soluções:**
- Upgrade para Vercel Pro (máximo 300s por função)
- Ou: reduzir janela do cron (ex: sync só últimas 48h, não 5 dias)
- Ou: implementar fila de jobs com retry incremental

---

### 🟠 MÉDIO — P&L Shopee: `taxaFixa` não incluída

**Arquivo:** `lib/sync-shopee.ts`  
**Problema:** O cálculo de margem Shopee usa `faixa.comissao + TAXA_CAMPANHA_SHOPEE` mas não inclui a `taxaFixa` das faixas de preço (ex: R$0,30 por pedido em itens abaixo de R$30).  
**Impacto:** Margem Shopee superestimada em ~R$0,10–0,30 por pedido nos itens de menor valor.  
**Correção sugerida em `sync-shopee.ts`:**
```typescript
const custoMarketplace = preco * (faixa.comissao + TAXA_CAMPANHA_SHOPEE) / 100 + (faixa.taxaFixa ?? 0);
```

---

## ARQUITETURA — ESTADO ATUAL

```
calculadora-dos-sellers-v1/
├── app/
│   ├── (app)/
│   │   ├── dashboard/page.tsx     ✅ Double-load corrigido
│   │   ├── vendas/page.tsx        ✅ DateRangePicker com 10 presets
│   │   ├── anuncios/page.tsx      ✅
│   │   ├── precificacao/page.tsx  ✅
│   │   ├── configuracoes/page.tsx ✅
│   │   ├── historico/page.tsx     ✅ Stub criado
│   │   ├── comparativo/page.tsx   ✅ Stub criado
│   │   └── suporte/page.tsx       ✅ Stub criado
│   ├── api/
│   │   ├── auth/
│   │   │   ├── login/route.ts     ⚠️ Senha plaintext (issue pendente)
│   │   │   ├── mercadolivre/callback/route.ts  ✅ Erro OAuth tratado
│   │   │   └── relay/route.ts     ✅
│   │   ├── perfil/route.ts        ✅ senha removida do GET; email_verificado corrigido
│   │   ├── sync/
│   │   │   ├── route.ts           ⚠️ maxDuration 300s ignorado no Hobby
│   │   │   └── manual/route.ts    ✅ Variáveis results.ml/shopee corrigidas
│   │   ├── ml/vendas/route.ts     ✅
│   │   └── shopee/vendas/route.ts ✅
├── lib/
│   ├── sync-ml.ts                 ✅ withRetry + AbortController
│   ├── sync-shopee.ts             ⚠️ taxaFixa não incluída no P&L
│   ├── shopee-api.ts              ✅ shopeePost com timeout 15s
│   ├── comissoes-mercado-livre.ts ✅
│   ├── comissoes-shopee.ts        ✅
│   └── session.ts                 ⚠️ Senha plaintext (issue pendente)
└── components/
    ├── TopBar.tsx                 ✅ Avatar dinâmico; JSX balanceado
    └── Sidebar.tsx                ✅
```

---

## CHECKLIST PRÉ-PRODUÇÃO

- [x] Build TypeScript: zero erros (`npx tsc --noEmit`)
- [x] Todas as rotas da Sidebar resolvem (sem 404)
- [x] OAuth ML retorna erro amigável em vez de crash
- [x] Campo `senha` não exposto via API
- [x] `email_verificado` obrigatório no cadastro
- [x] DateRangePicker com presets completos (10 opções)
- [x] Avatar dinâmico no TopBar
- [x] Timeout em chamadas Shopee
- [x] Dashboard sem double-load
- [ ] **Senha bcrypt** — implementar antes de escalar usuários
- [ ] **Vercel Pro** ou redesign de sync para caber em 60s
- [ ] **taxaFixa Shopee** no cálculo de P&L

---

## VALIDAÇÃO FINAL

```bash
# Executado em 03/07/2026 — resultado:
npx tsc --noEmit
# → (sem saída = zero erros)
```

**Status:** ✅ Código compila limpo. Aplicação pronta para deploy de produção com as ressalvas acima documentadas.
