# Pipeline Orchestrator — Central de IA / Estúdio de Anúncios (Fase 1)

> Documento de arquitetura para revisão. **Nenhum código funcional, nenhuma migration e nenhum arquivo de implementação foram criados nesta tarefa** — só este documento. Implementação começa em tarefa separada, após aprovação.

Contexto: hoje o módulo tem Projeto Mestre, CRUD, AI Gateway (stub `fake`), Worker de teste (`ping`), `estudio_anuncios_jobs` + `claim_next_estudio_anuncios_job()`, buckets e o schema base. Nada hoje decide "qual é a próxima etapa" — isso é o que este documento propõe.

**Revisão 2 (2026-08-04):** incorpora as 10 decisões aprovadas na rodada de revisão — RPC única de avanço atômico, `AVALIACAO` como etapa própria, etapas condicionais centralizadas no catálogo, `EXPORTACAO` inativa, `cancelado_em` separado, `aguardando_pendencias` como estado próprio, `job_atual_id` como única fonte de verdade de subetapa, remoção do contador `pipeline.tentativas`, retry reaproveitando a mesma linha de job, e tabela mantida com prefixo `estudio_anuncios_*` (sem generalização prematura).

---

## 1. Arquitetura completa do Pipeline

Sem mudança na divisão de responsabilidades (Rota pública / Worker / Rota interna / Gateway) descrita na Revisão 1 — só o **mecanismo** de avanço entre etapas mudou (seção 5/6/7).

---

## 2. Migration da nova tabela (proposta — não criada como arquivo ainda)

```sql
-- PROPOSTA — não executar, não criar arquivo ainda.
CREATE TABLE IF NOT EXISTS estudio_anuncios_pipeline (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  projeto_id        UUID NOT NULL UNIQUE REFERENCES estudio_anuncios_projetos(id) ON DELETE CASCADE,

  etapa_atual       TEXT,      -- valor de EtapaPipeline (etapa AMPLA) — NULL até a 1ª etapa ser decidida
  status            TEXT NOT NULL DEFAULT 'criado' CHECK (status IN (
                      'criado', 'aguardando', 'em_execucao',
                      'aguardando_pendencias', 'concluido', 'erro',
                      'cancelado', 'pausado'
                    )),

  -- Única fonte de verdade da subetapa em andamento (valor técnico de
  -- estudio_anuncios_jobs.etapa) — obtida via este relacionamento, NUNCA
  -- duplicada numa coluna própria (Decisão 7).
  job_atual_id      UUID REFERENCES estudio_anuncios_jobs(id) ON DELETE SET NULL,

  proxima_etapa     TEXT,      -- cache da etapa AMPLA seguinte — sempre recalculável a partir do catálogo

  ultima_execucao   TIMESTAMPTZ,
  proxima_execucao  TIMESTAMPTZ,   -- reservado (retry com atraso) — não usado na Fase 1

  erro_tipo         TEXT,
  erro_mensagem     TEXT,

  criado_em         TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
  concluido_em      TIMESTAMPTZ,
  cancelado_em      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_estudio_anuncios_pipeline_status
  ON estudio_anuncios_pipeline (status);
```

**Alterações em relação à Revisão 1:**
- Removida a coluna `tentativas` (Decisão 8) — `estudio_anuncios_jobs.tentativas`/`max_tentativas` (este último já herdando o limite da etapa no momento da criação do job) continuam sendo a única fonte de verdade.
- `status` ganhou `'aguardando_pendencias'` no lugar de `'aguardando_proxima_etapa'`, que deixou de existir (ver seção 6 — consequência direta da Decisão 1).
- `cancelado_em` confirmado, com regra de exclusividade mútua com `concluido_em` (Decisão 5): concluído → `concluido_em=now()`, `cancelado_em=NULL`; cancelado → `cancelado_em=now()`, `concluido_em=NULL`.

---

## 3. Enum de etapas (novo)

```ts
export enum EtapaPipeline {
  ANALISE_PRODUTO = "analise_produto",   // ordem 1
  PENDENCIAS      = "pendencias",         // ordem 2 — condicional, gate externo
  GERAR_CONTEUDO  = "gerar_conteudo",     // ordem 3
  GERAR_IMAGENS   = "gerar_imagens",      // ordem 4
  GERAR_VIDEO     = "gerar_video",        // ordem 5 — condicional
  AVALIACAO       = "avaliacao",          // ordem 6 — NOVA
  EXPORTACAO      = "exportacao",         // ordem 7 — inativa nesta fase
}
```

`AVALIACAO` adicionada como etapa própria (não mais dentro de `GERAR_CONTEUDO`) — o score depende do resultado completo (texto + imagens + vídeo quando houver), então só faz sentido depois de todas as etapas de geração aplicáveis terem terminado.

---

## 4. Mapeamento etapa ampla → jobs (revisado)

| Etapa ampla | Subetapas (`estudio_anuncios_jobs.etapa`) | Observação |
|---|---|---|
| `ANALISE_PRODUTO` | `analise_visual` (obrigatória) → `busca_externa` (condicional) | `busca_externa` só entra se `projeto.permitir_busca_externa=true` **e** a análise indicar necessidade real — ver Decisão Aberta #4 |
| `PENDENCIAS` | nenhuma (gate externo) | não cria job; pode disparar `atualizacao_pos_pendencia` quando o usuário responde (rota futura, fora de escopo) |
| `GERAR_CONTEUDO` | `geracao_conteudo` → `revisao_claude` → `adaptacao_marketplace` | sequência fixa, todas obrigatórias quando a etapa roda |
| `GERAR_IMAGENS` | `geracao_prompts_imagem` → `geracao_imagem` (1 ou mais) | quantidade de `geracao_imagem` vem de `quantidade_imagens_solicitada` — ver Decisão Aberta #1 sobre paralelismo |
| `GERAR_VIDEO` | `geracao_roteiro_video` → `geracao_video` (1 ou mais) | etapa inteira condicional — só roda se vídeo foi solicitado/aplicável |
| `AVALIACAO` | `calculo_score` | roda depois de todas as etapas de geração aplicáveis (não só `GERAR_CONTEUDO`) |
| `EXPORTACAO` | `exportacao` (ainda não existe no `CHECK` do banco) | `ativa=false` — catálogo já prevê o lugar, sem implementação nem migration agora (Decisão 4) |

---

## 5. Contratos das funções (revisado)

```ts
// tipos.ts — trechos alterados/novos
export enum TipoEtapa {
  OBRIGATORIA = "obrigatoria",
  CONDICIONAL = "condicional",
  MANUAL      = "manual",   // gate externo — só PENDENCIAS usa isso hoje
}

export interface ContextoAvaliacaoEtapa {
  projeto: ProjetoMestre;
  temPendenciasBloqueantes: boolean;
  // outros sinais conforme a etapa exigir (ver Decisão Aberta #4)
}

export interface SubetapaJob {
  jobEtapa: string;                 // valor de estudio_anuncios_jobs.etapa
  obrigatoria: boolean;
  aplicavel?: (ctx: ContextoAvaliacaoEtapa) => boolean;   // só relevante quando obrigatoria=false
  permiteMultiplos?: boolean;       // ex.: geracao_imagem — 1 job por imagem solicitada
}

export interface DefinicaoEtapa {
  id: EtapaPipeline;
  nome: string;
  ordem: number;
  dependeDe: EtapaPipeline[];
  tipo: TipoEtapa;
  aplicavel?: (ctx: ContextoAvaliacaoEtapa) => boolean;   // etapa AMPLA inteira condicional
  subetapas: SubetapaJob[];         // substitui o antigo `jobsEtapa: string[]`
  usaGateway: boolean;
  geraArquivos: boolean;
  permiteParalelismo: boolean;
  timeoutMs: number;
  maxTentativas: number;
  ativa: boolean;
}
```

```ts
// pipeline.ts — contratos revisados

export function iniciarPipeline(supabaseServico: SupabaseClient, projetoId: string): Promise<PipelineEstudioAnuncios>;

/**
 * ÚNICA função chamada pela rota interna quando um job termina com
 * SUCESSO. RPC transacional (ver seção 7) — decide e executa tudo:
 * próximo subjob, próxima etapa ampla, ou conclusão do pipeline.
 * Idempotente: chamar de novo com o mesmo jobId depois que o pipeline
 * já avançou não faz nada (job deixou de ser job_atual_id).
 */
export function avancarPipelineAposJob(supabaseServico: SupabaseClient, pipelineId: string, jobId: string): Promise<PipelineEstudioAnuncios>;

/**
 * ÚNICA função chamada pela rota interna quando um job termina em
 * FALHA. RPC transacional — decide reenviar o mesmo job para
 * 'pendente' (ainda cabe tentativa) ou marcar o pipeline em erro
 * (tentativas esgotadas). Mesma garantia de idempotência.
 */
export function registrarFalhaJob(supabaseServico: SupabaseClient, pipelineId: string, jobId: string, erroTipo: string, erroMensagem: string): Promise<PipelineEstudioAnuncios>;

export function cancelarPipeline(supabaseServico: SupabaseClient, pipelineId: string): Promise<PipelineEstudioAnuncios>;
export function pausarPipeline(supabaseServico: SupabaseClient, pipelineId: string): Promise<PipelineEstudioAnuncios>;
export function retomarPipeline(supabaseServico: SupabaseClient, pipelineId: string): Promise<PipelineEstudioAnuncios>;

/** Contrato apenas — implementação fica para quando a rota de resposta a pendências existir. */
export function responderPendencias(supabaseServico: SupabaseClient, pipelineId: string, respostas: unknown): Promise<PipelineEstudioAnuncios>;
```

**Removidos** em relação à Revisão 1: `obterProximaEtapa()` e `criarProximoJob()` como funções chamadas separadamente pela rota — a decisão e a criação passam a acontecer dentro da mesma RPC (`avancarPipelineAposJob`). A lógica de "qual é a próxima etapa/subetapa" continua existindo, mas como lógica interna da RPC (replicada em PL/pgSQL — ver Decisão Aberta #3), não mais como uma função TS chamada em separado.

---

## 6. Máquina de estados (revisada)

```
CRIADO ──────────────────────────────► AGUARDANDO | AGUARDANDO_PENDENCIAS
AGUARDANDO ──────────────────────────► EM_EXECUCAO
EM_EXECUCAO ─────────────────────────► AGUARDANDO             (avancarPipelineAposJob: próximo subjob/etapa criado)
EM_EXECUCAO ─────────────────────────► AGUARDANDO_PENDENCIAS  (avancarPipelineAposJob: próxima etapa aplicável é PENDENCIAS)
EM_EXECUCAO ─────────────────────────► CONCLUIDO               (avancarPipelineAposJob: não há mais etapa aplicável)
EM_EXECUCAO ─────────────────────────► AGUARDANDO             (registrarFalhaJob: falhou, ainda cabe tentativa — mesmo job volta a pendente)
EM_EXECUCAO ─────────────────────────► ERRO                    (registrarFalhaJob: tentativas esgotadas)
AGUARDANDO_PENDENCIAS ────────────────► AGUARDANDO             (responderPendencias — fora de escopo de implementação)
ERRO ──────────────────────────────────► AGUARDANDO             (retomada manual, se ainda cabe tentativa)
{qualquer estado não-terminal} ──────► PAUSADO
PAUSADO ───────────────────────────────► AGUARDANDO | EM_EXECUCAO | AGUARDANDO_PENDENCIAS   (retomada — reconcilia com o job real)
{qualquer estado não-terminal} ──────► CANCELADO
CONCLUIDO, CANCELADO                 → terminais, sem saída
```

**Removido:** o estado `AGUARDANDO_PROXIMA_ETAPA` da Revisão 1 deixou de existir. Ele representava a janela entre "job concluiu" e "próximo job criado" — com a RPC atômica da Decisão 1, essa janela não existe mais (as duas coisas acontecem na mesma transação), então não há mais um estado persistido e observável para representar. Sinalizando isso explicitamente porque é uma simplificação que decorre direto da Decisão 1, não uma decisão nova por conta própria — se preferir manter o estado só para fins de log/auditoria (mesmo sendo tecnicamente instantâneo), me avise.

---

## 7. Fluxo completo / fluxo transacional de avanço (revisado)

```
1. POST .../pipeline/iniciar → iniciarPipeline()
2. INSERT em estudio_anuncios_pipeline (status=CRIADO)
3. Decide a 1ª etapa aplicável (catálogo + contexto do projeto) e cria o(s) job(s) da 1ª subetapa
4. pipeline.status = AGUARDANDO
5. Worker reivindica o job (claim_next_estudio_anuncios_job(), inalterado)
6. Rota interna inicia o processamento → pipeline.status = EM_EXECUCAO
7. Rota interna chama o Gateway (se a subetapa usa Gateway)
8a. Sucesso → rota interna marca o job concluído E chama avancarPipelineAposJob(pipelineId, jobId) — UMA chamada
8b. Falha → rota interna marca o job em erro E chama registrarFalhaJob(pipelineId, jobId, ...) — UMA chamada
```

**`avancar_pipeline_apos_job` (nome conceitual, a confirmar) — passos dentro da transação:**
1. `SELECT ... FOR UPDATE` na linha do pipeline (lock).
2. Valida que `jobId` recebido é exatamente o `job_atual_id` atual (senão: no-op — chamada duplicada/atrasada, garante idempotência).
3. Confirma que o job está `concluido` em `estudio_anuncios_jobs`.
4. Registra a conclusão da subetapa.
5. Decide se ainda há subetapa pendente dentro da mesma etapa ampla (ex.: `geracao_imagem` #2 de N) → se sim, cria o próximo job da mesma etapa, `status=AGUARDANDO`, retorna.
6. Se a etapa ampla terminou, decide a próxima etapa ampla **aplicável** (pulando condicionais não aplicáveis, sem criar job artificial).
7. Se a próxima etapa aplicável é `PENDENCIAS` → `status=AGUARDANDO_PENDENCIAS`, `job_atual_id=NULL`, sem criar job.
8. Se não há mais etapa aplicável → `status=CONCLUIDO`, `concluido_em=now()`.
9. Senão, cria o job da próxima etapa ampla, `status=AGUARDANDO`.
10. Atualiza `job_atual_id`, `etapa_atual`, `proxima_etapa`, `atualizado_em` (e `concluido_em` quando aplicável) — tudo no mesmo `UPDATE`.

**`registrar_falha_pipeline` (nome conceitual, a confirmar) — passos análogos:**
1. Lock da linha do pipeline.
2. Valida que `jobId` é o `job_atual_id` atual (idempotência).
3. Lê `tentativas`/`max_tentativas` do job (fonte única — Decisão 8).
4. Se `tentativas < max_tentativas` → `UPDATE estudio_anuncios_jobs SET status='pendente'` (mesma linha, sem zerar tentativas), `pipeline.status=AGUARDANDO`.
5. Se esgotado → `pipeline.status=ERRO`, `erro_tipo`/`erro_mensagem` gravados.

A rota interna faz **uma única chamada** (a ou b, conforme o resultado) — nunca as duas separadas, nunca com intervalo entre "job concluiu" e "próximo passo decidido".

---

## 8. Estratégia de retomada (revisada)

Continua nunca confiando cegamente em `etapa_atual`/`job_atual_id` — sempre relê o job real antes de agir:

- `job_atual_id` com `jobs.status='concluido'` mas pipeline ainda não avançou (crash entre o job terminar e a RPC ser chamada) → `retomarPipeline()` simplesmente chama `avancarPipelineAposJob()` de novo — seguro por construção (idempotente, passo 2 da seção 7).
- `job_atual_id` com `jobs.status='erro'` e pipeline ainda não registrou → chama `registrarFalhaJob()` de novo, mesma garantia.
- `job_atual_id` com `jobs.status='pendente'` → nada a fazer, aguarda claim do worker.
- `job_atual_id` com `jobs.status='rodando'` → nada a fazer, só realinha `pipeline.status=EM_EXECUCAO` se estava `PAUSADO`.
- `job_atual_id IS NULL` e `etapa_atual='pendencias'` → aguarda ação do usuário (fora de escopo).
- `job_atual_id IS NULL` e `etapa_atual` preenchido com outra etapa (crash entre decidir a etapa e criar o job) → recria o job da subetapa atual a partir do catálogo.

---

## 9. Estratégia de cancelamento (revisada)

Sem mudança de princípio — de qualquer estado não-terminal (agora incluindo `AGUARDANDO_PENDENCIAS`) → `CANCELADO`, `cancelado_em=now()`, `concluido_em` permanece `NULL`. Idempotente. `avancarPipelineAposJob`/`registrarFalhaJob` verificam `status` não-terminal como parte do lock/precondição (passo 1-2 da seção 7) — se o pipeline já foi cancelado enquanto um job estava `rodando`, a chamada que viria depois vira no-op (job fica registrado em `estudio_anuncios_jobs` normalmente, só não gera continuação).

---

## 10. Estratégia de concorrência

Sem mudança nas 3 camadas da Revisão 1 (`UNIQUE(projeto_id)`, índice único parcial de jobs já existente, lock de linha dentro da RPC) — a camada 3 ficou ainda mais forte, porque agora é uma única função/transação (antes eram duas chamadas separadas).

---

## 11. Estratégia de retry (revisada)

- **Fonte única de tentativas:** `estudio_anuncios_jobs.tentativas`/`max_tentativas`. `max_tentativas` é herdado do catálogo (`DefinicaoEtapa.maxTentativas`) **no momento em que o job é criado** (por `iniciarPipeline()` ou `avancarPipelineAposJob()`) — não existe mais um segundo contador no pipeline (`pipeline.tentativas` removido — Decisão 8).
- **Retry reaproveita a mesma linha do job:** `registrar_falha_pipeline` devolve `status='pendente'` na mesma linha, sem zerar `tentativas` — o próximo `claim_next_estudio_anuncios_job()` incrementa de novo, até `max_tentativas`.
- **Nenhum retry** no Gateway, na rota, ou oculto no worker — toda a decisão fica na RPC de falha.
- Sem backoff/atraso nesta fase (`proxima_execucao` continua reservado, não usado).

---

## 12. Pipeline genérico (nota — Decisão 10)

Confirmado: máquina de estados e conceitos são desenhados de forma genérica, mas a tabela e a implementação inicial continuam com prefixo `estudio_anuncios_*`. Sem tabela polimórfica, sem `central_ia_pipeline` agora — extração para uma camada compartilhada só quando um segundo módulo real precisar do mesmo padrão.

---

## 13. Checklist da implementação (revisado — nada disto foi feito)

1. Resolver as Decisões Abertas (seção final).
2. Migration da tabela `estudio_anuncios_pipeline` (seção 2) — revisão, sem executar.
3. Migration das 2 RPCs (`avancar_pipeline_apos_job`, `registrar_falha_pipeline`) — revisão, sem executar. Mesmo padrão de segurança de `criar_projeto_estudio_anuncios` (`SECURITY INVOKER`, `REVOKE` de `anon`/`authenticated`, só `service_role`).
4. Aprovação e execução das duas migrations.
5. `lib/estudio-anuncios/pipeline/tipos.ts` + `catalogo.ts` (dados estáticos, incluindo `subetapas`/`aplicavel` por etapa).
6. `maquina-estados.ts` (função pura).
7. `pipeline.ts` (funções que chamam as RPCs).
8. Alterar `app/api/internal/estudio-anuncios/executar/route.ts` para chamar `avancarPipelineAposJob()`/`registrarFalhaJob()` em vez de só marcar o job.
9. Criar a rota `POST /api/estudio-anuncios/projetos/[id]/pipeline/iniciar`.
10. Teste sintético ponta a ponta (reaproveitando `ping` como subetapa fake dentro de uma etapa de teste no catálogo).
11. `npx tsc --noEmit` + validação por leitura.

---

## 14. Ordem exata das próximas tarefas

1. Você decide as Decisões Abertas restantes.
2. Migration da tabela `estudio_anuncios_pipeline` — texto para revisão.
3. Migration das 2 RPCs — texto para revisão.
4. Aprovação e execução das duas migrations.
5. `tipos.ts`/`catalogo.ts`/`maquina-estados.ts`.
6. `pipeline.ts`.
7. Alteração da rota interna existente.
8. Nova rota `.../pipeline/iniciar`.
9. Teste sintético ponta a ponta.

---

## Decisões abertas (só o que realmente ainda não foi resolvido)

**#1 — Paralelismo real de subetapas.** `GERAR_IMAGENS` pode gerar N jobs `geracao_imagem` (1 por imagem solicitada) e `GERAR_VIDEO` pode gerar N `geracao_video`. Se esses N jobs rodarem de fato em paralelo, `job_atual_id` (campo único) não é suficiente para representar "vários jobs em andamento ao mesmo tempo" — o modelo atual assume 1 job atual por vez. Minha recomendação para a Fase 1: mesmo em etapas com `permiteParalelismo=true` no catálogo, processar sequencialmente (1 job por vez, `job_atual_id` sempre singular) — paralelismo de fato fica para uma revisão futura do modelo. Confirma essa recomendação, ou prefere já desenhar suporte a múltiplos jobs simultâneos agora?

**#2 — Nomes definitivos das 2 RPCs.** `avancar_pipeline_apos_job` (seu nome sugerido) e `registrar_falha_pipeline` (nome que propus por simetria) — confirma os dois, ou tem preferência diferente para o segundo?

**#3 — Representação do catálogo no lado do banco.** A decisão de "qual a próxima subetapa/etapa" passa a rodar dentro de uma função PL/pgSQL (não só em TypeScript) — mesma filosofia de "não confiar só na aplicação" já usada em `criar_projeto_estudio_anuncios`. Isso significa que a ordem/`dependeDe`/`subetapas`/aplicabilidade condicional precisa ter alguma representação em SQL também. Duas opções: (a) hardcode da sequência via `IF`/`CASE` dentro da função (mais simples, replica manualmente o catálogo TS — risco de os dois ficarem dessincronizados se alguém editar só um lado); (b) uma tabela de referência no banco espelhando o catálogo (mais trabalho agora, fonte única de verdade real). Qual prefere?

**#4 — Aplicabilidade de subetapas que dependem do resultado de um job anterior.** `busca_externa` "somente quando... necessária" não é só configuração estática do projeto (`permitir_busca_externa`) — depende do que `analise_visual` encontrar (há informação faltando que justifique buscar?). O contrato `ContextoAvaliacaoEtapa` (seção 5) precisa incluir esse tipo de sinal, mas o desenho exato (de onde vem esse sinal — resultado estruturado do job, uma tabela de pendências, etc.) fica para quando `ANALISE_PRODUTO`/`busca_externa` forem implementadas de fato, não nesta fase.

**Fora de escopo, só sinalizado:** a rota/mecanismo de "responder pendências" (dispara `responderPendencias()`, `AGUARDANDO_PENDENCIAS → AGUARDANDO`) continua sem desenho — existe como transição na máquina de estados, mas nada a implementa ainda.
