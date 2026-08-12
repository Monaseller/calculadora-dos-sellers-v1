# Estúdio de Anúncios com IA — Planejamento Técnico, Funcional e Visual

> Documento de planejamento. Nenhum código foi alterado, nenhum arquivo foi criado no projeto, nenhuma migration foi escrita, nenhuma biblioteca foi instalada. Nome do módulo é provisório, conforme informado.

---

## 1. Resumo executivo

O Estúdio de Anúncios com IA seria um módulo novo, dentro da mesma aplicação Next.js do CDS, que orquestra três provedores externos de IA (OpenAI, Anthropic/Claude, Google) para transformar fotos reais de um produto em um pacote de anúncio pronto (texto, imagens, vídeo), com revisão automática de veracidade antes da entrega.

O diagnóstico central deste documento é o seguinte: a CDS já teve, uma vez, exatamente o mesmo problema estrutural que este módulo vai enfrentar — trabalho externo demorado demais para caber dentro do ciclo de vida de uma requisição HTTP — e a solução construída para isso (`sync_jobs` + `scripts/sync-worker.mjs`) está no repositório, funcional em código, e **inativa em produção há semanas** porque nunca foi resolvida a pergunta "onde roda um processo persistente". Qualquer plano para o Estúdio de Anúncios que não resolva essa mesma pergunta como pré-requisito (não como detalhe a decidir depois) está repetindo um caminho que já se mostrou não terminar em produção.

Fora esse ponto, a boa notícia: a cultura de negócio da CDS ("nunca usar estimativas", "marcar claramente o que é oficial vs. estimado", nunca inventar dado que a API não confirma) é diretamente compatível com a exigência deste módulo de nunca inventar característica de produto. Não é um valor novo a introduzir — é o mesmo valor já certificado em `BUSINESS_RULES.md`, aplicado a um domínio novo (visão computacional + geração de conteúdo em vez de dados financeiros de marketplace).

Pontos que exigem decisão explícita do usuário antes da Fase 1 de implementação (não técnicos, de produto/risco): infraestrutura de worker persistente (ver acima), política de RLS/privacidade para fotos reais de produtos (hoje inexistente em qualquer tabela), orçamento e política de créditos (hoje não existe nenhuma tabela de billing/consumo no projeto), e nome definitivo das tabelas (evitar colisão com a tabela `anuncios` já existente, que significa outra coisa).

---

## 2. Diagnóstico da estrutura atual

**Stack confirmada:** Next.js 14.2.5 (App Router) + TypeScript + React 18, Supabase (Postgres) via `@supabase/supabase-js` com a chave **anon** (não há uso de `service_role` no frontend/rotas normais — só em `scripts/sync-worker.mjs`, que roda fora do Next.js). Deploy: Vercel plano **Hobby**. `package.json` não tem nenhuma dependência de UI (sem Tailwind, sem shadcn, sem Material UI, sem CSS-in-JS library) e nenhum SDK de IA.

**Autenticação:** cookie httpOnly `cds_session`, valor = `user_id` em texto puro, sem JWT/assinatura (risco já documentado em `BUGS.md` como crítico aberto). Toda rota autenticada usa `getUserId(request)` (`lib/session.ts`) e retorna 401 se ausente. Não há Supabase Auth — logo não há `auth.uid()` disponível para políticas RLS.

**RLS:** confirmado, via grep em todas as migrations existentes, que **nenhuma tabela do projeto usa Row Level Security**. Isolamento por usuário é feito inteiramente em código de aplicação (`.eq("user_id", userId)`). Isso é uma decisão já tomada e documentada (ver comentário da migration `sync_jobs`), não um esquecimento — mas o Estúdio de Anúncios eleva o que está em jogo (fotos reais de produtos de clientes, não só números financeiros), o que é motivo para reabrir a pergunta, não para herdar o padrão sem revisão.

**Limite de execução:** toda função declara `maxDuration`, mas o plano Hobby corta em 60s **independente do valor declarado** (`API_RULES.md`, `BUGS.md`) — isso não é uma restrição a ser contornada com otimização, é um teto físico. Qualquer chamada síncrona de geração de imagem ou vídeo (que rotineiramente passam de 60s nos provedores citados) é estruturalmente impossível dentro de uma rota HTTP deste projeto, hoje.

**Precedente direto e mais importante: `sync_jobs`.** Migration `20260711_sync_jobs.sql` — fila de jobs com `claim_next_sync_job()` via `FOR UPDATE SKIP LOCKED`, heartbeat, retry com classificação de erro, processada por `scripts/sync-worker.mjs`. Foi construída especificamente porque o usuário vetou fire-and-forget dentro de rota HTTP ("decisão explícita do usuário: NÃO USAR FIRE-AND-FORGET DENTRO DA ROTA HTTP", comentário da própria migration). Está **implementada e nunca ativada em produção** (`NEXT_PUBLIC_ENABLE_ASYNC_SYNC_JOBS=false` hoje, inclusive em produção, confirmado em sessão anterior) porque falta exatamente uma coisa: um processo que rode `scripts/sync-worker.mjs` de forma persistente — o Vercel Hobby é serverless, sem processo de longa duração, e isso nunca foi resolvido. Esse é o teste empírico mais próximo que existe, no próprio projeto, de "o que acontece quando você constrói a fila mas não o worker persistente": ela fica pronta e não roda nada em produção.

**Naming/schema atual:** tabelas em `snake_case`, PK `UUID DEFAULT gen_random_uuid()` na maioria, mas `pedidos.id` é `TEXT` (chave sintética composta) e `sync_jobs.user_id`/`pedidos.user_id` são `TEXT` (não UUID) — não há Supabase Auth, então `user_id` é só o valor do cookie. Timestamps ora em inglês (`created_at`/`updated_at`, em `pedidos`/`dashboard_resumos_diarios`), ora em português (`criado_em`/`iniciado_em`/`concluido_em`/`heartbeat_em`, em `sync_jobs`) — inconsistência já existente, não introduzida por este documento, registrada aqui para quem for nomear as tabelas novas decidir conscientemente qual convenção seguir (recomendo a mais recente, `sync_jobs`, por ser o precedente de fila/job mais próximo do que este módulo precisa).

**Armazenamento de arquivo:** não há nenhum uso de Supabase Storage em todo o código revisado. Imagens hoje são só URLs em texto (`imagem_url`, `thumbnail`) apontando para os próprios CDNs da Shopee/ML. **Armazenar arquivo binário do usuário seria uma capacidade inteiramente nova para este projeto**, não uma extensão de um padrão existente.

**Visual:** não há biblioteca de componentes. Todo estilo é inline (`style={{...}}`) mais um `app/globals.css` com classes utilitárias soltas (`.card`, `.badge`, `.metric`, `.health`, `.notice` etc.) usadas de forma ad-hoc por página. Paleta confirmada: fundo `#07090f` com gradientes radiais laranja/âmbar; texto principal branco, texto secundário `#9099aa`; acento primário `#FF6A00`/`#ff6b00`, acento secundário `#ffb800`; cards com fundo `rgba(13,18,31,0.86)`, borda `rgba(255,255,255,0.10)`, `border-radius` entre 12 e 28px conforme o elemento; ícones SVG em stroke (padrão Feather/Lucide), 20×20, `strokeWidth=2`. Menu lateral fixo (`components/Sidebar.tsx`, 240px, fundo `#111318`), item ativo em laranja com fundo `rgba(255,106,0,0.12)`. Não existe um Design System documentado — os tokens acima foram extraídos diretamente do código, não de um `UI_UX.md` (que não existe neste projeto).

---

## 3. Pontos que já podem ser reutilizados

- **Padrão de sessão/autenticação** (`getUserId(request)`) — todas as rotas novas devem seguir exatamente esse padrão, sem inventar um segundo mecanismo.
- **Padrão de fila de job assíncrono** (`sync_jobs`/`claim_next_sync_job()`/heartbeat/retry classificado) — não como código a copiar, mas como **arquitetura a repetir conscientemente**, resolvendo desta vez o problema do worker persistente que ficou pendente.
- **Padrão de integração com API externa por "loja"** (`lib/shopee-auth.ts`/`lib/ml-auth.ts`: função que resolve credencial + renova token expirado) — não se aplica da mesma forma (OpenAI/Anthropic/Google não são "lojas" do usuário, são credenciais da plataforma), mas o *formato* de uma função central que resolve/valida a credencial antes de cada chamada é reaproveitável como padrão.
- **Padrão de rota "por id específico" vs. "ativo mais recente"** (`getShopeeLojaById` vs. `getShopeeLojaAtiva`, criado em 2026-07-11 exatamente para o worker) — o Estúdio de Anúncios vai precisar do mesmo tipo de rota "buscar projeto por id", nunca "o projeto mais recente".
- **Padrão de classificação de erro para decidir retry** (`erro_tipo` em `sync_jobs`: `transient | auth | rate_limit | loja | validation | unknown`) — diretamente aplicável (rate limit de IA é um caso real e frequente).
- **Padrão de migration comentada e não-destrutiva** (todas as migrations revisadas são aditivas, com `IF NOT EXISTS`, comentário de contexto/decisão/o-que-não-faz) — seguir à risca.
- **Tokens visuais** (paleta, raios, gradientes, ícones stroke) — extraíveis de `globals.css`/`Sidebar.tsx`/`TopBar.tsx` para as novas telas, sem inventar uma identidade nova.
- **Layout de app autenticado** (`app/(app)/layout.tsx`: Sidebar fixa + TopBar + `<main>`) — o módulo novo entra como mais uma página dentro de `(app)`, sem alterar o layout.
- **Padrão de placeholder de página em construção** (`app/(app)/historico/page.tsx`) — útil se a primeira fase de implementação entregar a tela antes da funcionalidade completa.

## 4. Pontos que precisarão ser criados (nada disso existe hoje)

- Qualquer schema de banco para o módulo (projetos, versões, jobs, custo, créditos).
- Qualquer uso de Supabase Storage (buckets, políticas de acesso, URLs assinadas).
- Qualquer integração com OpenAI, Anthropic (fora do próprio Claude que executa esta tarefa) ou Google — nenhum SDK, nenhuma chamada, nenhuma chave configurada.
- Qualquer sistema de créditos/consumo/limite — não existe hoje nenhuma tabela de billing ou uso no projeto inteiro.
- Um worker persistente de verdade (o que falta para `sync_jobs` também funcionar) — ver seção 25 (riscos).
- Qualquer componente de upload de arquivo (não existe hoje nenhum input de upload de imagem no projeto — os uploads existentes são todos de dados via formulário texto/número).
- Qualquer padrão de exportação de pacote (ZIP/CSV/JSON) — não existe hoje nenhuma rota de exportação no projeto.

---

## 5. Arquitetura geral do módulo

```
┌─────────────────────────────────────────────────────────────────┐
│  Frontend (Next.js, dentro de app/(app)/estudio-ia/*)            │
│  Cria projeto → envia fotos → aciona pipeline → acompanha status │
└───────────────────────────┬───────────────────────────────────────┘
                            │ HTTP (rotas curtas, nunca fazem a       
                            │ chamada de IA na própria requisição)   
┌───────────────────────────▼───────────────────────────────────────┐
│  Camada de orquestração (rotas app/api/estudio-ia/*)              │
│  - Validam, gravam intenção, criam/atualizam registro em          │
│    estudio_ia_jobs, devolvem imediatamente (padrão sync_jobs)      │
└───────────────────────────┬───────────────────────────────────────┘
                            │ enfileira
┌───────────────────────────▼───────────────────────────────────────┐
│  Worker persistente (PRÉ-REQUISITO, ver seção 25)                 │
│  Consome estudio_ia_jobs, executa 1 etapa do pipeline por vez,     │
│  chama o provedor de IA correspondente, grava resultado parcial,   │
│  atualiza heartbeat, nunca faz 2 etapas em 1 job                   │
└──────┬─────────────────┬─────────────────┬────────────────────────┘
       │                 │                 │
┌──────▼──────┐   ┌──────▼──────┐   ┌──────▼──────┐
│   OpenAI    │   │   Claude    │   │   Google    │
│ visão+texto │   │  revisão/   │   │ vídeo (Veo/ │
│ +imagem     │   │  auditoria  │   │  Gemini)    │
└─────────────┘   └─────────────┘   └─────────────┘
```

Princípio central: **a CDS nunca chama um provedor de IA de dentro de uma rota HTTP que o navegador está esperando responder.** Toda chamada de IA acontece dentro do worker, uma etapa do pipeline por vez, com resultado parcial sempre persistido antes de seguir para a próxima etapa. Isso não é uma preferência de estilo — é a única forma de respeitar o teto de 60s do Vercel Hobby (seção 2) sem reintroduzir o mesmo problema que motivou `sync_jobs`.

---

## 6. Fluxo completo do usuário

1. Usuário acessa "Estúdio com IA" no menu lateral.
2. Vê lista de projetos recentes (cards com status, marketplace, produto, data, thumb).
3. Clica "Novo anúncio".
4. Preenche em etapas (marketplace → dados do produto → fotos → conteúdo desejado → imagens desejadas → vídeo desejado → revisão).
5. Clica "Gerar anúncio" — a partir daqui, a experiência do usuário é acompanhar status, nunca esperar uma resposta síncrona.
6. Tela de processamento mostra progresso real, etapa a etapa, com horário de início/fim de cada uma.
7. Ao chegar em "conteúdo pronto para revisão", o fluxo **pausa** e espera aprovação humana antes de gastar dinheiro/tempo gerando imagem.
8. Usuário aprova, edita ou pede nova versão do texto.
9. Só após aprovação do texto, o pipeline gera as imagens (mesma pausa se aplica antes do vídeo).
10. Usuário aprova, refaz ou edita cada imagem individualmente.
11. Só após aprovação das imagens, se solicitado, gera o vídeo.
12. Projeto concluído fica no histórico, com todas as versões e custos registrados.
13. Usuário exporta o pacote (seleciona o que incluir) ou reutiliza o material depois.

Do ponto de vista do usuário o botão "Gerar anúncio" parece uma ação única; internamente é uma sequência de jobs independentes, cada um retomável.

---

## 7. Fluxo interno de processamento (pipeline)

| # | Etapa | Quem executa | Pode falhar sem destruir o projeto? | Resultado parcial salvo? |
|---|---|---|---|---|
| 1 | Criação do projeto | CDS (síncrono, rápido) | — | registro criado |
| 2 | Upload das fotos | CDS + Storage (síncrono, rápido) | sim | fotos gravadas mesmo se etapa seguinte falhar |
| 3 | Validação (formato/tamanho/qtd) | CDS (síncrono, rápido) | sim | status de validação por foto |
| 4 | Análise visual | Worker → OpenAI | sim | características extraídas, mesmo parciais |
| 5 | Geração do conteúdo textual | Worker → OpenAI | sim | rascunho salvo mesmo incompleto |
| 6 | Revisão pelo Claude (auditoria) | Worker → Claude (este mesmo tipo de modelo, via API própria) | sim | relatório de auditoria salvo |
| 7 | Aprovação humana (texto) | Usuário (pausa o pipeline) | — | decisão registrada |
| 8 | Criação dos prompts visuais | Worker → OpenAI ou Claude | sim | prompts salvos antes de gerar imagem (evita gerar 2x sem querer) |
| 9 | Geração das imagens | Worker → OpenAI | sim, por imagem individualmente | cada imagem é seu próprio registro/status |
| 10 | Aprovação humana (imagens) | Usuário (pausa) | — | decisão por imagem |
| 11 | Criação do roteiro de vídeo | Worker → Claude ou OpenAI | sim | roteiro salvo |
| 12 | Geração do vídeo | Worker → Google | sim | — |
| 13 | Aprovação humana (vídeo) | Usuário (pausa) | — | decisão registrada |
| 14 | Conclusão | CDS | — | status final |
| 15 | Exportação | CDS (sob demanda, não faz parte do pipeline automático) | sim | pacote gerado sob demanda, não recalcula nada |

Cada linha 4–13 é um `estudio_ia_jobs` distinto (ver seção 13), nunca uma etapa "escondida" dentro de outra — isso é o que permite retomar exatamente de onde parou, e é o mesmo princípio que fez `sync_jobs` funcionar tecnicamente (mesmo sem produção ativa).

---

## 8. Divisão de responsabilidade — OpenAI / Claude / Google / CDS

| Responsabilidade | Provedor | Observação |
|---|---|---|
| Visão computacional (características do produto a partir das fotos) | OpenAI | CDS nunca mostra a foto crua para o modelo sem também mandar os dados que o usuário confirmou — para o modelo poder marcar convergência/divergência |
| Geração do conteúdo textual inicial | OpenAI | rascunho, nunca a versão final exibida ao usuário sem revisão |
| Geração/edição de imagem comercial | OpenAI | preservando aparência real (ver seção 18) |
| Revisão do conteúdo, organização, ficha técnica | Claude | é quem aplica a classificação confirmada/informada/inferida/pendente/rejeitada (seção 18) |
| Detecção de inconsistência/invenção | Claude | ponto de bloqueio antes da aprovação humana — se o Claude marca "rejeitada", o item não aparece como se fosse fato no anúncio |
| Geração de vídeo a partir das imagens aprovadas | Google (Veo/Gemini, a confirmar qual exatamente) | só recebe imagens já aprovadas pelo usuário, nunca gera vídeo de imagem ainda pendente |
| Orquestração de todo o fluxo, nunca expor os provedores ao usuário | CDS | usuário não abre ChatGPT/Claude/Google diretamente — suposição herdada literalmente do pedido do usuário, não verificável tecnicamente por mim nesta etapa |

**Suposição registrada explicitamente:** este documento assume que "Claude" nas etapas de revisão é acessado via API paga da Anthropic (mesma família de modelo que está escrevendo este documento, mas uma chamada de API separada, com sua própria chave/custo) — não é o mesmo processo desta conversa. Isso não foi confirmado com o usuário e precisa ser.

---

## 9. Mapa de telas

```
/estudio-ia                              → lista de projetos (cards + status)
/estudio-ia/novo                         → wizard de criação (etapas 1-7 do pedido)
/estudio-ia/[projetoId]                  → tela de processamento (progresso ao vivo)
/estudio-ia/[projetoId]/conteudo         → revisão de conteúdo (abas)
/estudio-ia/[projetoId]/imagens          → grade de imagens + aprovação
/estudio-ia/[projetoId]/video            → revisão de vídeo + aprovação
/estudio-ia/[projetoId]/exportar         → seleção do que exportar
```

Seguindo o padrão de rota já usado em `app/(app)/vendas/[algo]` (o projeto hoje não usa muitas rotas dinâmicas — a maioria das páginas é estática dentro de `(app)`; rota dinâmica `[projetoId]` seria uma introdução nova, mas consistente com o App Router já em uso).

---

## 10. Componentes necessários (nenhum existe hoje, listados por função, não por nome de arquivo)

- Card de projeto (lista) — status, marketplace, produto, data, thumb, ações (continuar/duplicar/excluir/baixar).
- Stepper/wizard de etapas (novo anúncio) — não existe nenhum componente de etapas no projeto hoje.
- Upload de múltiplas imagens com reordenação, exclusão, indicação de capa — inexistente hoje (nenhum upload de arquivo existe no projeto).
- Barra/lista de progresso por etapa (tela de processamento) — inexistente.
- Abas de revisão de conteúdo — inexistente (não há padrão de abas em nenhuma tela atual).
- Grade de imagens com estado por item (gerando/pronta/aprovada/rejeitada) — inexistente.
- Player/preview de vídeo com aprovação — inexistente.
- Comparador de versões (texto e imagem) — inexistente.
- Indicador de custo estimado/consumido — inexistente (não há nenhum componente de "custo" em todo o projeto hoje).

Como não há biblioteca de componentes, cada um desses precisa ser escrito do zero em React + inline style, reaproveitando só os tokens visuais (cor, raio, tipografia) já identificados na seção 2 — isto é mais trabalho do que "reaproveitar componentes existentes" sugere; vale dizer isso com todas as letras para não subestimar o esforço da Fase de UI.

---

## 11. Estados e status do sistema

Status do projeto (conforme lista do pedido, já é razoável e compatível com o padrão de status usado em `sync_jobs`/`pedidos`):

`rascunho → aguardando_analise → analisando_produto → gerando_conteudo → revisando_conteudo → aguardando_aprovacao_conteudo → gerando_imagens → aguardando_aprovacao_imagens → gerando_video → aguardando_aprovacao_video → concluido`

Mais os estados de exceção: `erro_parcial`, `cancelado`.

Status por job individual (dentro de `estudio_ia_jobs`, espelhando `sync_jobs`): `pendente | rodando | concluido | erro`, com `erro_tipo` (`transient | auth | rate_limit | conteudo_rejeitado | validation | unknown`) — acrescentei `conteudo_rejeitado` em relação ao `sync_jobs` original porque este módulo tem um tipo de "falha" que o sync nunca tinha: o Claude pode rejeitar o conteúdo por inconsistência, o que não é erro técnico, é um resultado válido do pipeline que precisa de tratamento diferente (voltar para revisão humana, não para retry automático).

Status por imagem individual: `pendente | gerando | pronta | aprovada | rejeitada_pelo_usuario | rejeitada_pela_auditoria`.

---

## 12. Estrutura de pastas sugerida

```
app/
  (app)/
    estudio-ia/
      page.tsx                  # lista de projetos
      novo/page.tsx              # wizard
      [projetoId]/
        page.tsx                 # processamento
        conteudo/page.tsx
        imagens/page.tsx
        video/page.tsx
        exportar/page.tsx
  api/
    estudio-ia/
      projetos/route.ts                    # criar/listar
      projetos/[id]/route.ts               # ler/atualizar/excluir
      projetos/[id]/fotos/route.ts          # upload
      projetos/[id]/iniciar/route.ts        # dispara pipeline (cria job, retorna na hora — padrão sync_jobs)
      projetos/[id]/status/route.ts         # polling
      projetos/[id]/conteudo/route.ts       # ler/editar/aprovar conteúdo
      projetos/[id]/imagens/route.ts        # ler/aprovar/refazer imagem
      projetos/[id]/video/route.ts          # ler/aprovar/refazer vídeo
      projetos/[id]/exportar/route.ts       # gerar pacote
    internal/
      estudio-ia/executar/route.ts          # chamada interna do worker (mesmo padrão de app/api/internal/sync/executar)
lib/
  estudio-ia/
    tipos.ts                     # tipos compartilhados (Projeto, Job, Imagem, Video)
    openai-client.ts             # wrapper de chamada OpenAI (visão, texto, imagem)
    claude-client.ts             # wrapper de chamada Claude (revisão/auditoria)
    google-video-client.ts       # wrapper de chamada Google (vídeo)
    pipeline.ts                  # definição das etapas e transições de status
    creditos.ts                  # cálculo/débito/estorno de crédito
    storage.ts                   # upload/URL assinada/organização de arquivo
scripts/
  estudio-ia-worker.mjs          # processo persistente (mesmo modelo de sync-worker.mjs)
supabase/
  migrations/
    <data>_estudio_ia_schema.sql
```

Nomes de pasta em português (`estudio-ia`) para ficar consistente com o resto de `app/(app)/*` (`vendas`, `precificacao`, `configuracoes`), não em inglês.

---

## 13. Estrutura de banco de dados sugerida

**Aviso de nomenclatura, antes de tudo:** o projeto já tem uma tabela `anuncios` (cadastro de produto para cálculo de margem/precificação — nada a ver com o conceito de "anúncio gerado por IA para um marketplace"). Usar `ai_projects`/`anuncios_ia`/qualquer nome que comece com "anuncio" sozinho arrisca confusão real com essa tabela existente. Proposta: prefixar tudo com `estudio_ia_` (explícito, sem ambiguidade, e sinaliza claramente "isto pertence ao módulo novo"). Isto é uma **proposta**, não um nome definitivo — o usuário precisa confirmar antes da Fase 1.

Convenção adotada nesta proposta: PK `UUID DEFAULT gen_random_uuid()`, `user_id TEXT` (mesmo tipo usado em `pedidos`/`sync_jobs`, não UUID — não há Supabase Auth), timestamps em português (`criado_em`/`atualizado_em`/`concluido_em`), seguindo o precedente mais recente (`sync_jobs`) em vez do mais antigo (`pedidos`).

### 13.1 `estudio_ia_projetos`

Finalidade: 1 linha por "anúncio a ser criado" — o objeto raiz de tudo.

| Campo | Tipo | Observação |
|---|---|---|
| id | UUID PK | `gen_random_uuid()` |
| user_id | TEXT NOT NULL | dono, mesmo padrão de `pedidos.user_id` |
| loja_id | UUID NULL REFERENCES lojas(id) | opcional — para qual loja este anúncio se destina, se o usuário já escolher (permite reaproveitar o padrão `loja_id` já consolidado no projeto em vez de guardar `marketplace` solto) |
| marketplace | TEXT NOT NULL CHECK (IN ('ML','Shopee','Amazon','TikTok Shop','outro')) | denormalizado, mesmo padrão de `sync_jobs.marketplace` |
| nome_produto | TEXT NOT NULL | |
| status | TEXT NOT NULL DEFAULT 'rascunho' CHECK (IN (...)) | lista da seção 11 |
| criado_em | TIMESTAMPTZ NOT NULL DEFAULT now() | |
| atualizado_em | TIMESTAMPTZ NOT NULL DEFAULT now() | |
| concluido_em | TIMESTAMPTZ NULL | |
| cancelado_em | TIMESTAMPTZ NULL | |

Índices: `(user_id, criado_em DESC)` para a listagem; `(status)` para monitoramento/fila.
Restrição de duplicidade: nenhuma natural (usuário pode criar 2 projetos do mesmo produto de propósito) — duplicidade a evitar é de **jobs**, não de projetos (ver 13.6).
Exclusão: soft-delete recomendado (`cancelado_em`, nunca DELETE físico) — mesma lógica de preservar histórico que rege `pedidos` (nunca apagados, mesmo cancelados).
Impacto no banco atual: zero — tabela nova, sem FK de tabela existente apontando para ela, só ela apontando (opcionalmente) para `lojas`.

### 13.2 `estudio_ia_entradas_produto`

Finalidade: os campos que o usuário preencheu manualmente (nome, marca, medidas, etc.) — separado de `estudio_ia_projetos` para poder ter histórico de edição sem inflar a tabela raiz.

| Campo | Tipo |
|---|---|
| id | UUID PK |
| projeto_id | UUID NOT NULL REFERENCES estudio_ia_projetos(id) ON DELETE CASCADE |
| marca, categoria, modelo, cor, material | TEXT NULL |
| medidas | JSONB NULL | (altura/largura/profundidade — estrutura livre, sem inventar unidade) |
| peso | NUMERIC NULL | |
| unidade_peso | TEXT NULL CHECK (IN ('g','kg')) | |
| quantidade | INTEGER NULL | |
| conteudo_embalagem | TEXT NULL | |
| diferenciais | TEXT NULL | |
| observacoes | TEXT NULL | |
| criado_em | TIMESTAMPTZ NOT NULL DEFAULT now() | |

Só 1 linha "atual" por projeto (não versionado aqui — versionamento de conteúdo *gerado* vive em 13.5, não nos dados brutos que o usuário digitou). Índice: `(projeto_id)`.
Impacto: zero, tabela nova isolada.

### 13.3 `estudio_ia_imagens_origem`

Finalidade: fotos reais enviadas pelo usuário (a referência de verdade que a IA nunca pode contradizer).

| Campo | Tipo |
|---|---|
| id | UUID PK |
| projeto_id | UUID NOT NULL REFERENCES estudio_ia_projetos(id) ON DELETE CASCADE |
| storage_path | TEXT NOT NULL | caminho no Supabase Storage (ver seção 14) |
| ordem | INTEGER NOT NULL | posição escolhida pelo usuário |
| e_principal | BOOLEAN NOT NULL DEFAULT false | foto de referência principal |
| largura_px, altura_px, tamanho_bytes | INTEGER NULL | preenchido na validação |
| criado_em | TIMESTAMPTZ NOT NULL DEFAULT now() | |

Restrição: no máximo 1 linha com `e_principal=true` por projeto — via índice único parcial `WHERE e_principal = true`, mesmo estilo do índice parcial já usado em `sync_jobs`/`idx_pedidos_data_pagamento_loja`.
Exclusão: física é aceitável aqui (é arquivo do usuário, não histórico financeiro) — mas exige excluir também o objeto no Storage (ver seção 14), nunca um sem o outro.
Impacto: zero.

### 13.4 `estudio_ia_jobs`

Finalidade: fila de trabalho — 1 linha por etapa do pipeline (seção 7), copiando deliberadamente o desenho de `sync_jobs` (é o único precedente do projeto para "trabalho assíncrono confiável").

| Campo | Tipo | Observação |
|---|---|---|
| id | UUID PK | |
| projeto_id | UUID NOT NULL REFERENCES estudio_ia_projetos(id) | |
| etapa | TEXT NOT NULL CHECK (IN ('analise_visual','geracao_conteudo','revisao_claude','geracao_prompts_imagem','geracao_imagem','geracao_roteiro_video','geracao_video')) | |
| referencia_id | UUID NULL | ex.: para `geracao_imagem`, aponta para a linha específica em `estudio_ia_imagens_geradas` que este job produz — permite job por imagem individual, não só por projeto |
| status | TEXT NOT NULL DEFAULT 'pendente' CHECK (IN ('pendente','rodando','concluido','erro')) | |
| erro_tipo | TEXT NULL CHECK (erro_tipo IS NULL OR IN ('transient','auth','rate_limit','conteudo_rejeitado','validation','unknown')) | |
| erro_mensagem | TEXT NULL | resumida, nunca payload bruto do provedor (mesma regra de `sync_jobs`) |
| tentativas, max_tentativas | INT NOT NULL DEFAULT 0 / 3 | |
| provedor | TEXT NOT NULL CHECK (IN ('openai','anthropic','google')) | |
| criado_em, iniciado_em, concluido_em, heartbeat_em | TIMESTAMPTZ | mesmo padrão de `sync_jobs` |

Índice único parcial: impedir 2 jobs ativos (`pendente`/`rodando`) para a mesma `(projeto_id, etapa, referencia_id)` — equivalente direto do `idx_sync_jobs_loja_ativo`, evitando gerar a mesma imagem 2x em paralelo por erro de UI.
Função equivalente a `claim_next_sync_job()`: `claim_next_estudio_ia_job()`, mesmo mecanismo `FOR UPDATE SKIP LOCKED`.
Impacto: zero em tabelas existentes.

### 13.5 `estudio_ia_conteudo_versoes`

Finalidade: cada geração/edição do conteúdo textual é uma nova linha, nunca um UPDATE destrutivo — histórico completo, permite "restaurar versão anterior" (pedido explícito do usuário).

| Campo | Tipo |
|---|---|
| id | UUID PK |
| projeto_id | UUID NOT NULL REFERENCES estudio_ia_projetos(id) |
| numero_versao | INTEGER NOT NULL | sequencial por projeto |
| origem | TEXT NOT NULL CHECK (IN ('ia_openai','revisao_claude','edicao_manual')) | |
| titulo_principal, titulos_alternativos, descricao_completa, descricao_curta | JSONB/TEXT | títulos alternativos como array JSONB |
| ficha_tecnica, caracteristicas, beneficios, diferenciais | JSONB | estrutura chave-valor, permite marcar por campo a classificação da seção 18 |
| conteudo_embalagem, modo_uso, cuidados | TEXT NULL | |
| perguntas_frequentes | JSONB | array de {pergunta, resposta} |
| palavras_chave, termos_busca | TEXT[] | |
| roteiro_video, locucao, legenda_redes | TEXT NULL | |
| aprovado | BOOLEAN NOT NULL DEFAULT false | |
| aprovado_em | TIMESTAMPTZ NULL | |
| criado_em | TIMESTAMPTZ NOT NULL DEFAULT now() | |

Único (`projeto_id, numero_versao`).
Impacto: zero.

### 13.6 `estudio_ia_auditoria`

Finalidade: guardar o resultado da revisão do Claude — a classificação confirmada/informada/inferida/pendente/rejeitada exigida pelo pedido, por **campo individual**, não por projeto inteiro (é isso que permite a tela "auditoria" mostrada em abas).

| Campo | Tipo |
|---|---|
| id | UUID PK |
| conteudo_versao_id | UUID NOT NULL REFERENCES estudio_ia_conteudo_versoes(id) | |
| campo | TEXT NOT NULL | ex.: "voltagem", "material", "certificacao" |
| valor | TEXT NULL | |
| classificacao | TEXT NOT NULL CHECK (IN ('confirmada_visualmente','informada_pelo_usuario','inferida_pela_ia','pendente_confirmacao','rejeitada_por_inconsistencia')) | |
| justificativa | TEXT NULL | por que o Claude classificou assim |
| criado_em | TIMESTAMPTZ NOT NULL DEFAULT now() | |

Esta é a tabela que operacionaliza a regra "o sistema não pode inventar" — qualquer campo que não tenha uma linha aqui com classificação `confirmada_visualmente` ou `informada_pelo_usuario` não deveria ser exibido como fato no anúncio final.
Impacto: zero.

### 13.7 `estudio_ia_imagens_geradas`

| Campo | Tipo |
|---|---|
| id | UUID PK |
| projeto_id | UUID NOT NULL REFERENCES estudio_ia_projetos(id) |
| finalidade | TEXT NOT NULL CHECK (IN ('capa_principal','perspectiva','beneficios','medidas','detalhes','uso','embalagem','promocional_secundaria')) |
| numero_versao | INTEGER NOT NULL | permite "refazer" sem perder a anterior |
| storage_path | TEXT NULL | preenchido quando pronta |
| prompt_utilizado | TEXT NULL | |
| status | TEXT NOT NULL DEFAULT 'pendente' CHECK (IN ('pendente','gerando','pronta','aprovada','rejeitada_pelo_usuario','rejeitada_pela_auditoria')) |
| e_principal | BOOLEAN NOT NULL DEFAULT false |
| criado_em | TIMESTAMPTZ NOT NULL DEFAULT now() |

Único (`projeto_id, finalidade, numero_versao`).
Impacto: zero.

### 13.8 `estudio_ia_videos_gerados`

Mesmo desenho de 13.7, campos equivalentes (`formato` em vez de `finalidade`: `vertical | marketplace`), mais `duracao_segundos`, `roteiro_cenas JSONB`, `locucao_texto`, `textos_tela JSONB`.
Impacto: zero.

### 13.9 `estudio_ia_consumo`

Finalidade: 1 linha por chamada real a um provedor — a fonte de verdade de custo, no mesmo espírito de "nunca estimar, sempre valor oficial" já vigente no resto da CDS (aqui, "oficial" = o que o provedor de fato cobrou/retornou de uso).

| Campo | Tipo |
|---|---|
| id | UUID PK |
| projeto_id | UUID NOT NULL REFERENCES estudio_ia_projetos(id) |
| job_id | UUID NULL REFERENCES estudio_ia_jobs(id) |
| provedor | TEXT NOT NULL |
| modelo | TEXT NOT NULL | ex.: nome exato do modelo usado, para custo variar por versão |
| tokens_entrada, tokens_saida | INTEGER NULL | quando aplicável (texto) |
| unidades_geradas | INTEGER NULL | quando aplicável (imagem/vídeo — 1 chamada pode gerar N) |
| custo_estimado | NUMERIC NULL | calculado no momento, não oficial |
| custo_real | NUMERIC NULL | se/quando o provedor expuser isso na resposta |
| criado_em | TIMESTAMPTZ NOT NULL DEFAULT now() |

Impacto: zero.

### 13.10 `estudio_ia_creditos`

Finalidade: saldo/consumo por usuário — **não existe hoje nenhum equivalente no projeto**, é a peça mais nova de todas.

| Campo | Tipo |
|---|---|
| user_id | TEXT PK | 1 linha por usuário |
| saldo_creditos | NUMERIC NOT NULL DEFAULT 0 | |
| limite_diario, limite_mensal | NUMERIC NULL | |
| atualizado_em | TIMESTAMPTZ NOT NULL DEFAULT now() | |

Mais uma tabela de **lançamentos** (nunca só um saldo mutável sem histórico, para permitir auditoria e estorno):

`estudio_ia_creditos_lancamentos`: `id, user_id, projeto_id NULL, tipo (debito|estorno|recarga), valor, motivo, criado_em`.

Estratégia de duplicidade: débito de crédito deve ser idempotente por `job_id` (um job que falha e é reprocessado não pode debitar 2x) — índice único em `(job_id, tipo)` quando `tipo='debito'`.
Impacto: zero em tabelas existentes, mas é a tabela que exige mais decisão de produto antes de desenhar de verdade (ver seção 17).

### 13.11 `estudio_ia_pacotes_exportacao`

| Campo | Tipo |
|---|---|
| id | UUID PK |
| projeto_id | UUID NOT NULL REFERENCES estudio_ia_projetos(id) |
| itens_incluidos | JSONB NOT NULL | o que o usuário escolheu incluir |
| storage_path | TEXT NULL | caminho do ZIP gerado |
| criado_em | TIMESTAMPTZ NOT NULL DEFAULT now() |

Impacto: zero.

### Políticas de acesso (todas as tabelas acima)

Seguindo o padrão já em uso (nenhuma tabela do projeto tem RLS): autorização via `getUserId()` + filtro `.eq("user_id", ...)` (direto em `estudio_ia_projetos`, via join em `projeto_id` nas demais). **Sinalizado como ponto a reconsiderar, não a herdar automaticamente** — ver seção 18.

---

## 14. Estrutura de armazenamento

Proposta (não confirmada, primeira vez que este projeto usaria Supabase Storage):

- Bucket `estudio-ia-originais` (privado) — fotos reais enviadas pelo usuário. Nunca público: é a foto real do produto/negócio do cliente.
- Bucket `estudio-ia-gerado` (privado por padrão; público só se/quando o usuário decidir publicar) — imagens e vídeos gerados.
- Bucket `estudio-ia-exportacoes` (privado) — pacotes ZIP finais.

Organização de caminho: `{user_id}/{projeto_id}/originais/{imagem_id}.{ext}` e equivalente para gerado/exportação — nunca por nome de arquivo original do usuário (evita colisão e vazamento de nome de arquivo pessoal).

Acesso: URLs assinadas de curta duração (Supabase Storage signed URLs), nunca URL pública direta para conteúdo do bucket privado — consistente com "privacidade dos produtos enviados" pedida explicitamente.

Retenção/limpeza: versões antigas de imagem/vídeo rejeitadas devem ter política de expiração (não definida aqui — decisão de produto, ver seção 26), para não acumular indefinidamente arquivo binário gerado e nunca aprovado.

**Não confirmado:** se o plano Supabase atual do projeto já inclui Storage e qual o limite de armazenamento contratado — não verificável a partir deste ambiente (mesma limitação de rede já documentada em `PROJECT_CONTEXT.md`).

---

## 15. Rotas internas necessárias (conceitual — nenhuma implementada)

| Rota | Método | Finalidade | Idempotente? | Efeito no banco |
|---|---|---|---|---|
| `/api/estudio-ia/projetos` | POST | criar projeto | não (cada chamada cria um novo) | insert em `estudio_ia_projetos` |
| `/api/estudio-ia/projetos` | GET | listar projetos do usuário | sim | leitura |
| `/api/estudio-ia/projetos/[id]` | GET/PATCH | ler/editar projeto | PATCH sim (mesmo payload = mesmo resultado) | update |
| `/api/estudio-ia/projetos/[id]/fotos` | POST | upload de foto | não | insert + Storage |
| `/api/estudio-ia/projetos/[id]/iniciar` | POST | dispara pipeline — **só cria/atualiza jobs, nunca chama IA na própria requisição** (mesmo padrão de `POST /api/sync/iniciar`) | sim, por etapa (índice único evita duplicar) | insert em `estudio_ia_jobs` |
| `/api/estudio-ia/projetos/[id]/status` | GET | polling de status | sim | leitura |
| `/api/estudio-ia/projetos/[id]/conteudo` | GET/PATCH | ler/editar/aprovar versão de conteúdo | PATCH sim | update/insert versão |
| `/api/estudio-ia/projetos/[id]/imagens/[imagemId]` | PATCH | aprovar/refazer/definir como principal | sim para aprovar; refazer cria novo job | update + insert job |
| `/api/estudio-ia/projetos/[id]/video` | PATCH | aprovar/refazer vídeo | igual acima | update + insert job |
| `/api/estudio-ia/projetos/[id]/exportar` | POST | gerar pacote | não (mas não deveria recalcular nada, só empacotar o que já existe) | insert em `estudio_ia_pacotes_exportacao` |
| `/api/estudio-ia/projetos/[id]` | DELETE | excluir (soft) | sim | update `cancelado_em` |
| `/api/internal/estudio-ia/executar` | POST | chamada do worker, protegida por segredo estático (mesmo padrão de `SYNC_WORKER_INTERNAL_SECRET`) | depende da etapa | executa 1 etapa, grava resultado |

Autenticação: cookie de sessão em todas, exceto a rota `internal`, que usa segredo estático — mesma separação já validada em `app/api/internal/sync/executar/route.ts`.
Validação: toda rota que recebe `projeto_id` deve confirmar `projeto.user_id === sessão` antes de qualquer leitura/escrita — mesmo princípio já aplicado (embora manualmente, sem RLS) em todo o resto do projeto.
Custo de IA envolvido: só as etapas processadas pelo worker (seção 7) geram custo; as rotas de CRUD simples (criar projeto, editar campo, listar) não chamam nenhum provedor.

---

## 16. Integrações externas

| Provedor | Responsabilidade | Timeout sugerido | Retry | Fallback | Registro de custo |
|---|---|---|---|---|---|
| OpenAI | visão, texto, imagem | por chamada, bem maior que os 8-15s já usados para ML/Shopee (`shopeeGet` usa 15s) — geração de imagem facilmente passa de 30-60s | igual ao `withRetry` já usado em `sync-shopee.ts` (backoff exponencial), mas só para erro transitório/rate limit, nunca para "conteúdo rejeitado" | nenhum — se falhar, job fica em erro, não se inventa resultado | `estudio_ia_consumo` |
| Anthropic (Claude) | revisão/auditoria | menor que os de imagem (é análise de texto) | igual acima | nenhum | `estudio_ia_consumo` |
| Google (Veo/Gemini) | vídeo | o maior de todos os três, potencialmente minutos | igual acima, mas com `max_tentativas` menor (vídeo é caro, não vale reprocessar às cegas) | nenhum | `estudio_ia_consumo` |

Segurança da chave: as três chaves ficam **só em variável de ambiente do servidor** (nunca `NEXT_PUBLIC_`), chamadas exclusivamente de dentro do worker/rotas internas — nunca do componente cliente. Isso é uma continuação direta do padrão já usado para `SHOPEE_PARTNER_KEY`/`ML_CLIENT_SECRET` (nunca expostos ao bundle).

Limites: cada provedor tem rate limit próprio — o `erro_tipo='rate_limit'` em `estudio_ia_jobs` existe justamente para o worker poder pausar aquele provedor especificamente sem travar os outros dois.

Risco de duplicidade: mitigado pelo índice único parcial em `estudio_ia_jobs` (seção 13.4) — o mesmo mecanismo que impede `sync_jobs` de rodar 2 syncs da mesma loja ao mesmo tempo.

---

## 17. Controle de custo e créditos (estrutura, sem valores comerciais)

Fluxo proposto:
1. Antes de cada etapa cara (imagem, vídeo), calcular **estimativa** de custo com base em `quantidade de imagens desejada`/`duração de vídeo` — nunca debitar antes de confirmar que o usuário tem saldo.
2. Debitar crédito somente quando o job entra em `rodando` (não em `pendente` — evita debitar por um job que nunca chegou a processar).
3. Se o job falhar por erro técnico (`transient`/`rate_limit`/`unknown`), estornar automaticamente.
4. Se o job falhar por `conteudo_rejeitado` (a IA gerou, mas a auditoria recusou), **decisão de produto em aberto**: estornar integralmente ou cobrar parcialmente pelo processamento já feito — não decidido neste documento (ver seção 26).
5. Bloqueio: nenhum job novo é criado se `saldo_creditos` insuficiente para a estimativa da próxima etapa — verificado na rota `iniciar`, nunca no worker (o worker não deveria ter que "descobrir" que não tinha crédito no meio do processamento).

Nada disso tem tabela equivalente hoje no projeto — é a área com menos precedente interno para se apoiar, mais risco de subestimar a complexidade real (webhooks de billing dos provedores, estorno parcial, limite por período).

---

## 18. Segurança

- Chaves de IA só no servidor — já coberto na seção 16.
- Autenticação obrigatória em toda rota, via `getUserId()` — sem exceção.
- Verificação de propriedade do projeto em toda operação — `projeto.user_id === sessão`.
- Validação de arquivo: tipo (apenas imagem, lista de MIME explícita), tamanho máximo, quantidade máxima por projeto — nenhum desses limites existe hoje no projeto (primeira vez que há upload de arquivo).
- Proteção contra upload malicioso: no mínimo validação de MIME real (não só extensão) antes de gravar no Storage — Next.js/Supabase não fazem isso automaticamente.
- Rate limit por usuário nas rotas de criação de job — não existe rate limit em nenhuma rota do projeto hoje (ponto novo a resolver, não uma lacuna deste módulo especificamente).
- **RLS/privacidade — ponto de decisão que merece ser levantado, não herdado em silêncio:** o projeto inteiro hoje não usa RLS, com justificativa registrada (sem Supabase Auth, autorização 100% em código). Isso já é um risco aceito para dados financeiros (`pedidos`). Fotos reais de produtos e conteúdo de anúncio de clientes têm um perfil de sensibilidade diferente (imagem, não só número) — vale a pergunta explícita ao usuário se este módulo deveria ser o primeiro a introduzir RLS (o que pressupõe migrar para Supabase Auth, mudança estrutural grande) ou se aceita o mesmo modelo já em uso. Não decidido aqui.
- Isolamento de arquivo: nunca servir imagem de um usuário para outro — reforça a necessidade de URLs assinadas (seção 14), não URLs previsíveis por padrão de caminho.
- Exclusão segura: ao excluir projeto, remover também os objetos correspondentes no Storage — hoje nada no projeto tem essa preocupação (pedidos nunca são excluídos), então é lógica nova a escrever, não a copiar.

---

## 19. Tratamento de erros

Segue diretamente o padrão de `erro_tipo` de `sync_jobs` (seção 13.4), com a adição de `conteudo_rejeitado` (não existe em `sync_jobs` porque sync nunca tem esse tipo de "falha de conteúdo"). Toda etapa que falhar:
- Nunca derruba o projeto inteiro — só aquele job específico fica em erro.
- Sempre permite "tentar novamente" manualmente pela UI, além do retry automático do worker.
- Sempre preserva o resultado parcial de etapas anteriores já concluídas (mesmo princípio de `atualizarResumoDia`: nunca perder trabalho já feito por causa de uma etapa seguinte que falhou).

---

## 20. Estratégia de histórico e versões

Já embutida no desenho da seção 13: `estudio_ia_conteudo_versoes` (nunca UPDATE destrutivo, sempre nova versão), `estudio_ia_imagens_geradas`/`estudio_ia_videos_gerados` com `numero_versao` (permite "refazer" sem perder a anterior e comparar lado a lado). Nenhuma tabela existente no projeto hoje versiona conteúdo dessa forma — `dashboard_resumos_diarios`, por exemplo, é literalmente o oposto (sempre recalculado do zero, nunca versionado) — então este é um padrão novo a introduzir, não uma extensão.

---

## 21. Estratégia de aprovação humana

Três pontos de pausa obrigatória no pipeline (seção 7): depois do conteúdo textual, depois das imagens, depois do vídeo. Cada pausa é modelada como o projeto ficando em um status `aguardando_aprovacao_*` — o worker nunca avança sozinho para a etapa seguinte sem uma ação explícita do usuário gravada (campo `aprovado`/`aprovado_em`). Isso é o que impede o sistema de "gastar dinheiro sozinho" gerando imagem de um texto que ninguém validou, ou vídeo de imagem que ninguém aprovou — requisito explícito do pedido.

---

## 22. Estratégia de exportação

Pacote final por seleção do usuário (`estudio_ia_pacotes_exportacao.itens_incluidos`), nunca "tudo automaticamente". Formatos: JSON (dados estruturados), TXT (texto corrido), CSV/XLSX (tabular, para quem for subir manualmente em outra ferramenta), imagens/vídeos originais, tudo compactado em um único ZIP gerado sob demanda (não pré-gerado) — evita manter um ZIP desatualizado se o usuário editar algo depois.

---

## 23. Preparação futura para marketplaces (não implementar agora)

Estrutura mínima para não fechar a porta depois: `estudio_ia_projetos.loja_id` (já proposto na seção 13.1) é o que permite, no futuro, relacionar 1 projeto a 1 publicação real numa loja específica (reaproveitando o conceito `loja_id` já consolidado no resto do projeto, em vez de inventar um novo). Uma tabela futura `estudio_ia_publicacoes` (`projeto_id`, `loja_id`, `status_publicacao`, `id_anuncio_no_marketplace`) cobriria "publicar"/"rascunho"/"atualizar"/"acompanhar status" — não desenhada em detalhe aqui por estar fora do escopo desta etapa, só para confirmar que o desenho de `loja_id`/`projeto_id` já comporta essa extensão sem migração destrutiva.

---

## 24. Impactos sobre o sistema atual

- **Nenhum.** Todas as tabelas propostas são novas e aditivas; nenhuma coluna existente muda; nenhuma rota existente é alterada; o menu lateral ganha 1 item novo (`Sidebar.tsx` precisaria de 1 entrada nova em `MENU`, a única alteração concreta em código existente prevista por este plano — e mesmo essa não é para agora).
- Risco indireto: se o worker deste módulo e o `scripts/sync-worker.mjs` acabarem precisando rodar no mesmo processo/host persistente (ver seção 25), a solução de infraestrutura passa a ser compartilhada — vale desenhar pensando nos dois, não só neste módulo isoladamente.

---

## 25. Riscos técnicos

1. **Worker persistente inexistente (risco maior, herdado, não nasce com este módulo).** `sync_jobs` prova que o projeto sabe desenhar a fila, mas não tem hoje onde rodar o consumidor dela em produção. Este módulo tem exatamente a mesma dependência, com etapas ainda mais longas (vídeo). Resolver isso é pré-requisito de infraestrutura, não item da Fase 1 de código.
2. **Custo real de IA não estimado neste documento** — por instrução explícita ("não definir valores comerciais nesta etapa"), mas o risco de estourar orçamento por retry mal controlado é real e deve ser mitigado por `max_tentativas` baixo em etapas caras (vídeo).
3. **Ausência de qualquer precedente de Storage no projeto** — primeira implementação, mais chance de erro de configuração de bucket/política do que em uma área já testada.
4. **RLS/privacidade** (seção 18) — decisão de produto pendente, não só técnica.
5. **Tempo de resposta dos 3 provedores é variável e fora do controle da CDS** — mesmo com arquitetura assíncrona correta, a experiência do usuário depende de SLA que a CDS não controla; vale expor isso na UI (estimativa, não promessa).
6. **Vazamento de chave** se alguém, por engano, chamar OpenAI/Anthropic/Google direto de um componente cliente (`"use client"`) em vez do worker — mesmo tipo de erro que motivou a separação rígida já existente para as chaves Shopee/ML.
7. **Divergência entre o que o usuário informou e o que a foto mostra** — tratado pela classificação da seção 18, mas exige que o pipeline realmente pare o fluxo quando há conflito, não apenas registre e siga adiante.

---

## 26. Decisões que precisam ser tomadas (usuário, não técnicas)

1. Onde/como rodar o worker persistente — mesma pergunta em aberto desde 2026-07-13 para `sync_jobs`, agora com um segundo módulo dependendo da resposta.
2. Nome definitivo das tabelas (`estudio_ia_*` é proposta, não aprovação).
3. RLS neste módulo especificamente, ou manter o modelo atual (autorização só em código)?
4. Qual API exata do Google (Veo? Gemini com geração de vídeo? ambos, um por caso de uso?) — não confirmado.
5. Se "Claude" é de fato Anthropic API paga separada (suposição registrada na seção 8) — precisa confirmação.
6. Política de estorno quando o conteúdo é rejeitado pela auditoria, mas o processamento já ocorreu (seção 17).
7. Retenção de arquivo gerado e rejeitado (por quanto tempo guardar antes de expirar/apagar).
8. Se o menu deste módulo entra já na Fase 1 ou só quando houver algo funcional atrás dele (o projeto já tem precedente de item de menu que leva a placeholder — `historico`, `comparativo` — então tecnicamente é aceitável entregar cedo).

---

## 27. Plano de implementação dividido em fases

**Fase 0 — Infraestrutura de execução assíncrona (pré-requisito, compartilhado com a dívida já existente de `sync_jobs`).** Decidir e implantar onde um processo persistente roda em produção. Sem isso, nenhuma fase seguinte tem como funcionar em produção — só localmente, como `sync_jobs` hoje.

**Fase 1 — Schema + CRUD básico de projeto (sem IA nenhuma ainda).** Migrations da seção 13 (revisadas/aprovadas antes de rodar, mesmo processo já usado em todas as migrations deste projeto). Rotas de criar/listar/editar/excluir projeto. Tela de lista + wizard de criação (sem disparar geração). Upload de foto funcionando (primeira vez com Storage).

**Fase 2 — Pipeline de texto (OpenAI geração + Claude revisão), sem imagem/vídeo.** `estudio_ia_jobs` para as etapas 4-7 da seção 7. Tela de processamento + tela de revisão de conteúdo + aprovação humana.

**Fase 3 — Pipeline de imagem.** Etapas 8-10. Tela de grade de imagens.

**Fase 4 — Pipeline de vídeo.** Etapas 11-13. Tela de vídeo.

**Fase 5 — Créditos/consumo/custo.** Pode e deveria ser desenhada em paralelo às Fases 2-4 (cada etapa nova já nasce registrando consumo), mas o bloqueio por saldo insuficiente só precisa estar ativo antes de expor o módulo para uso real com custo de verdade.

**Fase 6 — Exportação.**

**Fase 7 — Preparação para publicação em marketplace** (schema apenas, seção 23) — não implementar a publicação em si.

---

## 28. Ordem seguraram de implementação

(Reafirmando a Fase 0 como bloqueio real, não figurativo.)

Fase 0 → Fase 1 → Fase 2 → (Fase 5 parcial, junto com Fase 2) → Fase 3 → Fase 4 → Fase 5 completa → Fase 6 → Fase 7.

Justificativa da ordem: cada fase só é testável de ponta a ponta se a anterior já produz um resultado real e aprovável — mesmo princípio já usado nas Fases 1-5 da arquitetura de resumos diários deste mesmo projeto (nunca avançar de fase sem validar a anterior).

---

## 29. Critérios de aceite por fase

- **Fase 0:** um job de teste (não precisa ser deste módulo) roda em produção sem que ninguém precise deixar um terminal aberto localmente.
- **Fase 1:** criar, listar, editar, excluir (soft) e fazer upload de foto num projeto, sem nenhuma chamada de IA, com `tsc --noEmit` limpo e sem alterar nenhuma tabela existente.
- **Fase 2:** um projeto real gera conteúdo textual, passa pela revisão do Claude, mostra a classificação por campo (seção 18), e só avança após aprovação humana explícita — nenhum campo aparece como fato sem estar marcado `confirmada_visualmente`/`informada_pelo_usuario`.
- **Fase 3:** imagem gerada preserva a aparência real do produto (validação humana, não automática nesta fase) e só é usada depois de aprovada.
- **Fase 4:** vídeo só é gerado a partir de imagens já aprovadas, nunca de rascunho.
- **Fase 5:** nenhum job roda sem saldo suficiente estimado antes; estorno automático comprovado em pelo menos 1 caso de falha técnica simulada.
- **Fase 6:** pacote exportado contém exatamente o que foi selecionado, nada a mais.
- **Fase 7:** schema criado, nenhuma publicação real acontece.

---

## 30. Lista de arquivos que futuramente deverão ser criados ou alterados

**Criados (nenhum ainda):** todos os listados na seção 12, mais a migration da seção 13.

**Alterados (mínimo, e só a partir da Fase 1):** `components/Sidebar.tsx` (1 item de menu novo); `.env.example` (novas variáveis: chaves OpenAI/Anthropic/Google, segredo do worker interno, mesmo padrão de `SYNC_WORKER_INTERNAL_SECRET`); possivelmente `middleware.ts` (se as novas rotas precisarem de alguma regra pública, o que não parece ser o caso — todas exigem sessão).

**Nada em `lib/sync-shopee.ts`, `lib/sync-ml.ts`, `lib/resumos-diarios.ts`, ou qualquer rota de vendas/dashboard existente.**

---

## Documentação — o que precisará ser atualizado (não alterado agora)

- `docs/PROJECT_CONTEXT.md` — novo módulo na lista de "o que já funciona"/estrutura do repositório; nota de que este doc já está desatualizado em relação ao próprio código hoje (não referencia `loja_id`, `dashboard_resumos_diarios` executada, nem `sync_jobs` — todos já existentes no código, ver seção 2). Vale sinalizar essa defasagem ao usuário independentemente deste módulo.
- `docs/ROADMAP.md` — nova fase (Estúdio de Anúncios com IA), com a mesma estrutura de fases 0-7 acima.
- `docs/DATABASE.md` — todas as tabelas novas da seção 13, quando de fato criadas.
- `docs/API_RULES.md` — todas as rotas novas da seção 15.
- `docs/BUSINESS_RULES.md` — a regra de classificação confirmada/informada/inferida/pendente/rejeitada, formalizada como regra de negócio do módulo (equivalente ao tratamento já dado a `has_income_data`/status oficiais).
- `docs/DECISIONS.md` — registro formal de cada item da seção 26 assim que decidido.
- `docs/CHANGELOG.md` — a cada fase entregue.
- `docs/BUGS.md` — se a RLS/privacidade (seção 18) for aceita como risco conhecido em vez de resolvida, deveria entrar aqui, no mesmo formato dos riscos já documentados (sessão sem assinatura, RLS não confirmada).
- Não existem `MASTER_CONTEXT.md`, `UI_UX.md`, `DEPLOY.md` neste projeto — os pedidos referentes a esses três arquivos não têm onde ser aplicados sem antes decidir se serão criados (ou se `PROJECT_CONTEXT.md` continua acumulando esse papel, como já faz hoje segundo sua própria nota de rodapé).

Nenhum desses arquivos foi alterado nesta etapa.

---

## PRÓXIMO PROMPT RECOMENDADO

Ao iniciar a implementação da Fase 0/Fase 1, o próximo prompt deveria conter, no mínimo:

1. Confirmação explícita das decisões da seção 26 (em especial: onde roda o worker persistente; nome definitivo das tabelas; se Claude = Anthropic API paga separada; RLS sim/não neste módulo).
2. Autorização explícita para escrever a migration da seção 13 (mas não executá-la sem revisão, seguindo o padrão já usado em todas as migrations deste projeto).
3. Escopo fechado da Fase 1 apenas (schema + CRUD de projeto + upload de foto), sem geração de IA nenhuma — mesmo princípio de "não implementar várias fases de uma vez" já seguido no resto deste projeto.
4. Instrução explícita de preservar 100% do código/rotas/tabelas existentes, sem exceção.
5. Se o menu (`Sidebar.tsx`) deve ganhar o item "Estúdio com IA" já na Fase 1 ou só depois.

---

## Confirmação final

**Arquivos lidos nesta análise:** `docs/PROJECT_CONTEXT.md`, `docs/DATABASE.md`, `docs/API_RULES.md`, `docs/BUSINESS_RULES.md`, `docs/ROADMAP.md`, `docs/BUGS.md`, `docs/DECISIONS.md` (parcial — primeiras ~100 linhas), `lib/session.ts`, `lib/supabase.ts`, `lib/feature-flags.ts`, `lib/shopee-auth.ts`, `middleware.ts`, `app/(app)/layout.tsx`, `components/Sidebar.tsx`, `app/globals.css`, `app/(app)/historico/page.tsx`, `supabase-setup.sql`, `supabase/migrations/20260711_sync_jobs.sql`, `package.json`.

**Não lidos integralmente (por volume/tempo, amostrados ou pulados nesta etapa):** `docs/CHANGELOG.md`, `docs/DECISIONS.md` (restante, ~500 linhas depois da linha 100), `components/TopBar.tsx`, `app/(app)/vendas/page.tsx` (já lido em profundidade em sessão anterior, não re-lido agora), demais páginas (`dashboard`, `precificacao`, `anuncios`, `configuracoes`, `suporte`, `comparativo`).

**Pastas analisadas:** `app/(app)/*` (listagem completa), `app/api/*` (listagem completa), `components/`, `lib/` (listagem completa), `supabase/migrations/` (listagem completa + 2 arquivos lidos por inteiro).

**Partes do banco analisadas:** exclusivamente via os arquivos `.sql` do repositório e via `docs/DATABASE.md` — **nenhuma query real foi rodada no Supabase** (mesma limitação de rede já documentada em `PROJECT_CONTEXT.md`: o ambiente não tem acesso a `*.supabase.co`). O schema exato hoje em produção não foi confirmado ao vivo, só inferido dos arquivos de migration presentes no repositório.

**Padrões atuais que serão preservados, conforme este plano:** autenticação via cookie `cds_session`/`getUserId()`; ausência de RLS (com ressalva explícita na seção 18); estilo inline + tokens de `globals.css`, sem framework novo; estrutura de pastas `app/(app)/*` e `app/api/*`; convenção de migration comentada, aditiva, `IF NOT EXISTS`; padrão de fila de job com `FOR UPDATE SKIP LOCKED`; separação entre "visualização" e "sincronização em background" já estabelecida para lojas (análoga aqui à separação entre aprovação humana e geração automática).

**Informações que não puderam ser confirmadas (registradas como suposição, não como fato):**
- Se "Claude" no pedido do usuário significa uma chamada de API Anthropic separada e paga, distinta desta própria conversa.
- Qual produto exato do Google (Veo vs. Gemini) seria usado.
- Se o plano Supabase atual já suporta/inclui Storage e qual seu limite.
- Schema exato de `lojas` (não encontrado um `CREATE TABLE lojas` explícito no repositório — inferido a partir das colunas usadas em `lib/shopee-auth.ts`/`lib/ml-auth.ts`).
- Se há alguma decisão de produto já tomada em conversa fora deste projeto sobre nome definitivo do módulo, orçamento de IA, ou fornecedor de vídeo — tratado aqui como ainda em aberto.
