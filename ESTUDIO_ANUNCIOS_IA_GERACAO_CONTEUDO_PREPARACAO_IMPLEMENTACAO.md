# Preparação da implementação de `geracao_conteudo` — PARTE 1 (auditoria + desenho, sem código)

Nota antes de tudo — divergência interna no pedido, sinalizada em vez de resolvida por conta própria: a seção "EXECUTOR REGISTRY" diz "desenhe e **implemente**, se não houver bloqueio"; a seção "ENTREGA EM DUAS PARTES" põe "implementar registry" explicitamente na PARTE 2, com PARTE 1 exigindo "confirmação de que nada foi alterado" e "parar para aprovação". As duas instruções não podem ser seguidas ao mesmo tempo. Segui a mais específica e a que fecha o documento (a estrutura de 2 partes com gate explícito) — **nenhum arquivo de código foi criado ou alterado nesta rodada**, só este documento. Se a intenção era implementar o registry já nesta rodada, avise e eu sigo.

---

## 1. Decisão de provedor

### 1.1 Auditoria do adaptador Google atual

Arquivos lidos por completo: `lib/ai-gateway/provedores/google.ts`, `google-tipos.ts`, `lib/ai-gateway/roteamento.ts`, `lib/ai-gateway/tipos.ts`, `lib/estudio-anuncios/analise-visual.ts`, `.env.example`.

**Pergunta 1 — o adaptador atual suporta uma segunda tarefa textual sem acoplar `geracao_conteudo` a `analise_visual`?**
Sim, mas não por reaproveitamento direto de `chamarGeminiComImagens()` — essa função está estruturalmente presa a imagens (recebe `ImagemParaAnalise[]`, monta `input` com blocos `type:"image"`). `geracao_conteudo` não envia imagens (a entrada é o resultado já estruturado de `analise_visual`, texto puro). Reaproveitar essa função forçaria `geracao_conteudo` a fingir que tem imagens ou a aceitar um parâmetro condicional — os dois são acoplamento, não reuso. A peça certa é uma função nova e paralela (`chamarGeminiTexto()`, mesmo arquivo `google.ts`), não uma ramificação dentro da função existente.

**Pergunta 2 — reutilizar cliente/erro/timeout/custo/modelo sem reutilizar tipos/schemas de análise visual?**

| Peça | Reaproveitável como está? | Detalhe |
|---|---|---|
| Cliente (`obterCliente()`) | Sim, 100% | Não tem nenhuma menção a tipo de análise visual — só lê `GOOGLE_AI_API_KEY` e faz cache do SDK. |
| Mapeamento de erro (`mapearErroGoogle()`) | Sim, 100% | Opera sobre o objeto de erro do SDK (status/statusCode/name/mensagem) — nenhuma dependência de `AnaliseVisualIA`. |
| Estimativa de custo (`estimarCustoUsd()`) | Sim, 100% | Assinatura já é `(modelo, tokensEntrada, tokensSaida) => number` — genérica por desenho. |
| Timeout | **Parcial** | `TIMEOUT_MS = 30_000` é uma constante de módulo, usada só dentro de `chamarGeminiComImagens()`. Não há leitura de env nem parametrização — reaproveitar significaria herdar cegamente o mesmo timeout calibrado para chamada multimodal (imagem+texto) numa chamada texto-only, sem nenhuma decisão consciente. Recomendo constante própria (ou parâmetro explícito) para a chamada de texto, não reuso 1:1. |
| Leitura de modelo (`obterModeloVisual()`) | **Não** | Lê literalmente `GOOGLE_AI_MODEL_VISUAL` — hardcoded ao nome da variável. Precisa de uma função irmã (`obterModeloConteudo()`), mesma estrutura de validação (trim, erro explícito se ausente/vazio, nunca fallback), lendo `GOOGLE_AI_MODEL_CONTEUDO`. |
| Tipos/schema (`AnaliseVisualIA`, `ANALISE_VISUAL_JSON_SCHEMA`, `OrigemAtributo`) | Não, e não deveria | Ficam em `google-tipos.ts`. `geracao_conteudo` precisa dos próprios tipos, mas **não** no namespace do provedor — ver Bloqueio 2 (seção 4) para a separação domínio/adaptador corrigida nesta rodada. Nenhuma dependência de tipo entre as duas etapas, só a referência lógica via `fonteAnaliseVisual` (dado, não tipo). |

**Pergunta 3 — `GOOGLE_AI_MODEL_CONTEUDO` separada, ou reaproveitar `GOOGLE_AI_MODEL_VISUAL`?**
Concordo com a preferência declarada, e acrescento a justificativa que faltava: o próprio código já estabelece esse padrão — `obterModeloVisual()` é comentado explicitamente como "único ponto que lê `GOOGLE_AI_MODEL_VISUAL` — nenhum outro módulo lê essa variável diretamente" (google.ts, linha 58-64). Reaproveitar essa variável para `geracao_conteudo` quebraria essa invariante já documentada no próprio código, não só uma preferência de configuração. Variável nova mantém a invariante.

**Pergunta 4 — `GOOGLE_AI_MODEL_CONTEUDO` ausente/vazio/só espaços com `GOOGLE_AI_ENABLED=true`.**
Mesmo padrão de `obterModeloVisual()`: `obterModeloConteudo()` faz `trim()`, erro explícito (`ErroProvedorIA("auth", ...)`) se vazio, nunca fallback pra `GOOGLE_AI_MODEL_VISUAL`. Não é uma decisão nova, é replicar o padrão já existente e testado.

**Pergunta 5 — modelo fora da tabela de preços.**
Já é exatamente o comportamento atual de `estimarCustoUsd()` (google.ts, linhas 180-187): devolve `0` explicitamente e loga um aviso só com o nome do modelo, nunca inventa preço. **Nenhuma mudança de código necessária para este requisito** — só adicionar (ou deliberadamente não adicionar) uma entrada para o modelo de conteúdo em `TABELA_PRECOS_USD_POR_MILHAO_TOKENS`.

### 1.2 Recomendação final

**Gemini para `geracao_conteudo`, Claude para `revisao_claude` — aprovado**, com 2 condições técnicas que não são opcionais (detalhadas na seção 4 — arquivos):
1. Nova função `chamarGeminiTexto()` em `google.ts` (não reaproveitar `chamarGeminiComImagens()`).
2. Nova função `obterModeloConteudo()` lendo `GOOGLE_AI_MODEL_CONTEUDO`, timeout com sua própria constante (não herdar `TIMEOUT_MS` de imagem sem decisão consciente).

Argumento a favor que a justificativa original não menciona explicitamente, mas que reforça a decisão: usar um provedor diferente para gerar (Gemini) do que para revisar (Claude) não é só "menor superfície de integração" — é uma defesa real contra o viés de "o mesmo modelo revisando o próprio trabalho", um modo de falha conhecido em pipelines de LLM-como-juiz (um modelo tende a ser mais complacente com o próprio estilo/estrutura de saída do que com o de outro modelo). Isso não estava no argumento original, mas é uma razão técnica adicional, não só estética, para manter a divisão Gemini/Claude.

Ressalva que reduz o risco desta escolha, não aumenta: a arquitetura do contrato de `geracao_conteudo` já foi desenhada para ser resistente a qual for o provedor — a checagem de integridade de `fatoIds` (seção 2.1 do contrato) é 100% determinística e roda independente de qual modelo gerou o texto. Isso significa que a escolha de provedor aqui tem menos risco do que teria em um sistema sem essa rede de segurança — um erro de escolha de provedor não vira silenciosamente um resultado fabricado não detectado.

---

## 2. Executor registry

### 2.1 Fluxo atual de `executarJobEstudioAnuncios()` (lib/estudio-anuncios/executar-job.ts)

1. Recebe `{jobId, projetoId, etapa}`.
2. Confere `ETAPAS_SUPORTADAS_FASE1` (um `Set` fixo de 8 strings) — fora dele, erro `validation`.
3. `decidirTipoPrompt(etapa)` — mapa fixo (`roteamento.ts`), lança se a etapa não estiver mapeada.
4. Monta `promptTexto` a partir de outro mapa fixo (`PROMPT_TEXTO_POR_ETAPA`), com fallback pro nome cru da etapa.
5. `decidirProvedor(etapa)` — só retorna `"google"` para `analise_visual` com `GOOGLE_AI_ENABLED=true`; todo o resto é `"fake"`.
6. `usaGoogleAnaliseVisual = provedor === "google" && etapa === "analise_visual"` — **único ponto de ramificação real hoje**.
7. Se `usaGoogleAnaliseVisual`: chama `executarAnaliseVisualGoogle()`, monta manualmente um objeto `RespostaIA` (custo via `estimarCustoUsd()`, tokens do retorno), guarda o resultado estruturado completo em `resultadoParaPipeline`.
8. Senão: chama `chamarIA()` (Gateway fake genérico).
9. Registra prompt/consumo sempre (idempotentes por `job_id`); se `resultadoParaPipeline` não for nulo, registra em `estudio_anuncios_resultados_pipeline` usando `SCHEMA_VERSAO_ANALISE_VISUAL` **hardcoded** (linha 217).

### 2.2 Acoplamentos encontrados (reais, não hipotéticos)

1. **`usaGoogleAnaliseVisual`** mistura "qual provedor" + "qual etapa" num único booleano ad-hoc. Adicionar `geracao_conteudo` do jeito que o código está hoje exigiria um segundo booleano quase idêntico e um segundo bloco `if` — exatamente o crescimento que o registry deve eliminar.
2. **`SCHEMA_VERSAO_ANALISE_VISUAL` hardcoded dentro do trecho "genérico" de registro** (linha 217) — não é lido a partir de qual handler rodou, é importado direto de `analise-visual.ts` e usado incondicionalmente dentro do único branch estruturado que existe hoje. Se alguém copiasse esse padrão ingenuamente para `geracao_conteudo` (que também começa em `schema_versao=1`), o bug (gravar a versão errada) não seria pego por nenhum CHECK do banco — os dois valores são `1`. Isso não é um risco hipotético para justificar o registry, é uma prova de por que cada handler precisa declarar a própria versão de saída, não confiar numa constante importada solta.
3. **Montagem manual do objeto `RespostaIA`** (linhas 134-154) é escrita especificamente pro formato de retorno de `executarAnaliseVisualGoogle()`. Um handler de `geracao_conteudo` teria um retorno de formato diferente — essa montagem não é reaproveitável como está, precisa ser uma responsabilidade do próprio handler, não do executor genérico.
4. **`PROMPT_TEXTO_POR_ETAPA`** grava em `central_ia_prompts.prompt_texto` um resumo curto ("Analisar visualmente o produto...") mesmo no branch Google — o prompt real enviado ao Gemini (`PROMPT_ANALISE_VISUAL_V1`, em `analise-visual.ts`) nunca é o que fica registrado. Isso já é uma imprecisão pré-existente, fora do escopo desta tarefa corrigir — mas o handler de `geracao_conteudo` não deveria repetir esse padrão sem decidir conscientemente o que registrar.
5. **3 fontes de verdade paralelas hoje** sobre "quais etapas existem/são suportadas": `ETAPAS_SUPORTADAS_FASE1` (Set em TS), `MAPA_TIPO_PROMPT` (Record em TS), e o catálogo no banco (`estudio_anuncios_pipeline_catalogo*`). O registry deve unificar as duas fontes TypeScript numa só (o próprio registry) — o catálogo do banco continua sendo uma coisa conceitualmente diferente (decide ordem/obrigatoriedade do Pipeline) e não deve ser fundido com o registry (decide como executar).

### 2.3 Shape do registry (revisado — corrige Bloqueio 1)

A versão anterior só cobria 2 etapas (`analise_visual`, `geracao_conteudo`) — quebraria as outras 6 hoje suportadas via Gateway fake, que passariam a "etapa sem handler" → `validation`. Isso teria derrubado exatamente o Pipeline E2E de 7 etapas já validado em rodadas anteriores. Redesenhado.

**Lista completa das 8 etapas de `ETAPAS_SUPORTADAS_FASE1` hoje e o handler que cada uma recebe:**

| Etapa | Handler | Observação |
|---|---|---|
| `analise_visual` | específico (`handlerAnaliseVisual`) | extraído mecanicamente do bloco hoje inline em `executar-job.ts` |
| `geracao_conteudo` | **genérico fake** (não específico, nesta rodada) | sem mudança de comportamento — hoje já não tem tratamento especial nenhum (confirmado em `cliente.ts`: cai no mesmo `chamarIA()` fake que as demais 6) |
| `revisao_claude` | genérico fake | idem |
| `adaptacao_marketplace` | genérico fake | idem |
| `geracao_prompts_imagem` | genérico fake | idem |
| `geracao_imagem` | genérico fake | idem |
| `calculo_score` | genérico fake | idem |
| `ping` | genérico fake | idem |

Duas estruturas separadas, não uma só:

```ts
// Handlers com comportamento próprio — 1 chave = 1 handler dedicado.
const HANDLERS_ESPECIFICOS: Readonly<Record<string, HandlerEtapa>> = {
  analise_visual: handlerAnaliseVisual,
  // geracao_conteudo só entra aqui quando a implementação real (tipos +
  // entrada segura + adaptador + validações) estiver completa — nunca
  // como placeholder. Ver regra de sequenciamento em 2.4.
};

// Etapas que hoje passam pelo caminho fake genérico, sem handler
// dedicado — mesmo comportamento observável de hoje, só reorganizado.
const ETAPAS_FAKE_GENERICAS: ReadonlySet<string> = new Set([
  "ping",
  "geracao_conteudo",
  "revisao_claude",
  "adaptacao_marketplace",
  "geracao_prompts_imagem",
  "geracao_imagem",
  "calculo_score",
]);

function resolverHandler(etapa: string): HandlerEtapa | undefined {
  if (etapa in HANDLERS_ESPECIFICOS) return HANDLERS_ESPECIFICOS[etapa];
  if (ETAPAS_FAKE_GENERICAS.has(etapa)) return handlerFakeGenerico; // 1 único objeto, parametrizado por contexto.etapa em tempo de execução
  return undefined; // etapa sem handler -> validation, sem fallback silencioso
}
```

Validação no boot (substitui a checagem "chave == handler.etapa" da versão anterior, que só fazia sentido pra um mapa 1:1):
```ts
for (const etapa of Object.keys(HANDLERS_ESPECIFICOS)) {
  if (ETAPAS_FAKE_GENERICAS.has(etapa)) {
    throw new Error(`Etapa "${etapa}" registrada como handler específico E genérico simultaneamente.`);
  }
  if (HANDLERS_ESPECIFICOS[etapa].etapa !== etapa) {
    throw new Error(`Registry inconsistente: handler em "${etapa}" declara etapa "${HANDLERS_ESPECIFICOS[etapa].etapa}".`);
  }
}
```

`handlerFakeGenerico.executar()` faz exatamente o que o branch `else` de hoje faz (linhas 164-186 de `executar-job.ts`): chama `chamarIA({..., tarefa: contexto.etapa, promptTexto})`, confere `resposta.sucesso`, devolve. Nenhuma etapa fake perde comportamento — só deixa de estar espalhada num `if/else` e passa a estar num conjunto nomeado.

**`tipoPrompt` — como é preservado para todas**: não vira campo estático do handler (isso criaria uma 2ª fonte de verdade competindo com `decidirTipoPrompt()`). Continua exatamente onde está hoje — `lib/ai-gateway/roteamento.ts`, chamado pelo executor para QUALQUER etapa (específica ou genérica) antes de despachar pro handler, byte-a-byte como o código atual (linhas 106-119). Nenhum handler decide isso nem precisa saber disso.

**Como o Pipeline E2E de 7 etapas continua funcionando**: das 7 etapas do fluxo real do catálogo (`analise_visual` → `geracao_conteudo` → `revisao_claude` → `adaptacao_marketplace` → `geracao_prompts_imagem` → `geracao_imagem` → `calculo_score`), só `analise_visual` muda de "inline no executor" para "handler específico" — comportamento idêntico, código só movido de lugar. As outras 6 continuam passando pelo Gateway fake exatamente como hoje, só que através de `ETAPAS_FAKE_GENERICAS` em vez de um `if/else` único. Nenhuma delas passa a exigir handler específico nesta tarefa. `ping` (fora do catálogo, usado só em teste de infraestrutura Fase 0) recebe o mesmo tratamento, sem mudança.

### 2.3.1 `provedoresPermitidos` — validação obrigatória, com efeito real

Renomeado de `provedorEsperado` (singular) para `provedoresPermitidos: ProvedorIA[]`, por ser array, conforme pedido.

```ts
interface HandlerEtapa {
  etapa: string;
  provedoresPermitidos: ProvedorIA[];
  versoesEntradaAceitas?: number[];
  versaoSaida?: number;
  dependencia?: "job_origem_id" | null;
  geraResultadoEstruturado: boolean;
  timeoutMs?: number;
  executar: (ctx: ContextoExecucaoJob, supabase: SupabaseClient) => Promise<ResultadoHandler>;
}
```

Validação obrigatória, não documentação solta — depois que `decidirProvedor(etapa)` resolve o provedor efetivo e ANTES de chamar `handler.executar()`:

```ts
const provedor = decidirProvedor(contexto.etapa);
const handler = resolverHandler(contexto.etapa);
if (!handler) {
  return { sucesso: false, erro: { tipo: "validation", mensagem: `Etapa "${contexto.etapa}" não é suportada nesta fase.` } };
}
if (!handler.provedoresPermitidos.includes(provedor)) {
  return {
    sucesso: false,
    erro: {
      tipo: "validation", // erro de configuração/roteamento pego antes de qualquer chamada externa — mesma categoria já usada em outras falhas de pré-checagem determinística (ex. GOOGLE_AI_MAX_IMAGES inválido). Sujeito a ajuste se você preferir outra classificação.
      mensagem: `decidirProvedor("${contexto.etapa}") retornou "${provedor}", fora de handler.provedoresPermitidos (${handler.provedoresPermitidos.join(", ")}).`,
    },
  };
}
```

Nenhuma chamada de IA acontece se essa checagem falhar. Valores concretos:
- `handlerAnaliseVisual.provedoresPermitidos = ["fake", "google"]` — os 2 caminhos reais de hoje.
- `handlerFakeGenerico.provedoresPermitidos = ["fake"]` — `decidirProvedor()` nunca devolve outra coisa para essas 7 etapas hoje; se algum dia devolver, é bug de roteamento, não deveria prosseguir silenciosamente.

### 2.4 Arquivos que mudariam (PARTE 2) e regra de sequenciamento

- Criar `lib/estudio-anuncios/executores/registry.ts` — tipos `HandlerEtapa`, `HANDLERS_ESPECIFICOS`, `ETAPAS_FAKE_GENERICAS`, `resolverHandler()`, validação de boot.
- Criar `lib/estudio-anuncios/executores/analise-visual.ts` — extração mecânica do bloco hoje inline em `executar-job.ts` (linhas 130-163), sem reescrever a lógica interna (`executarAnaliseVisualGoogle()`, `estimarCustoUsd()`, `montarResumoCurtoAnaliseVisual()` continuam exatamente as mesmas chamadas).
- Criar `lib/estudio-anuncios/executores/fake-generico.ts` — extração mecânica do branch `else` hoje inline (linhas 164-186).
- Reescrever `lib/estudio-anuncios/executar-job.ts` — troca o `if (usaGoogleAnaliseVisual) {...} else {...}` por `resolverHandler()` + checagem de `provedoresPermitidos` + `handler.executar(...)`.

**Regra de sequenciamento para `geracao_conteudo` (corrige o bloqueio do placeholder)**: nenhum handler de `geracao_conteudo` é registrado como parte da criação do registry em si. `geracao_conteudo` permanece em `ETAPAS_FAKE_GENERICAS` durante toda a construção dos tipos de domínio, entrada segura, adaptador e validações. A entrada em `HANDLERS_ESPECIFICOS` só é adicionada como **última etapa** da PARTE 2, depois que tipos + entrada segura + adaptador + validações já existem e já passaram pelos testes isolados — nunca como andaime intermediário. Se a PARTE 2 for interrompida antes desse ponto, o registry fica no último estado consistente: `geracao_conteudo` continua em `ETAPAS_FAKE_GENERICAS`, sem nenhum handler fake/no-op nomeado especificamente para ela — porque não existe um; ela só compartilha o mesmo `handlerFakeGenerico` das outras 6 etapas, exatamente como acontece hoje.

### 2.5 Risco de regressão

Baixo, condicionado a extração mecânica (mover, não reescrever) do bloco de `analise_visual`. Esse caminho já passou por 7 ciclos de teste E2E reais validados (Worker ciclo 1-7, ambos os branches fake e Google exercitados em rodadas anteriores) — a defesa contra regressão não é repetir uma chamada real, é: (a) os testes 1/2/5 da seção de testes abaixo (registry resolve `analise_visual` pro handler certo, etapa sem handler falha, `analise_visual` mantém comportamento atual) rodando sobre a versão extraída; (b) `npx tsc --noEmit` limpo; (c) diff manual confirmando que o corpo do handler é bit-a-bit idêntico ao bloco removido de `executar-job.ts`, só movido de arquivo.

---

## 3. `job_origem_id`

**Status: CONFIRMADO — Bloqueio 3 resolvido.** `pg_get_functiondef('public.estudio_anuncios_pipeline_avancar(uuid,uuid)'::regprocedure)` foi executado e o corpo devolvido é idêntico (fora formatação de `\r\n` e a omissão padrão de `SECURITY INVOKER`, que o Postgres nunca imprime por ser o default) ao extraído de `20260805_estudio_anuncios_pipeline_rpcs.sql`, reproduzido abaixo. Nenhuma migration posterior alterou esta função — diferente do que aconteceu com `estudio_anuncios_pipeline_concluir_job()`/`_falhar_job()`. O `CREATE OR REPLACE` abaixo é a versão definitiva, não mais um rascunho.

### 3.1 Auditoria (antes de propor a migration)

**Schema atual de `estudio_anuncios_jobs`** (`20260803_central_ia_estudio_anuncios_schema.sql`): FKs existentes — `projeto_id` (`ON DELETE RESTRICT`), `projeto_marketplace_id` (`ON DELETE CASCADE`). Índices: `idx_estudio_anuncios_jobs_ativo` (único parcial, `status IN ('pendente','rodando')`), `idx_estudio_anuncios_jobs_status_criado`, `idx_estudio_anuncios_jobs_heartbeat`, `idx_estudio_anuncios_jobs_projeto`. Constraints: `chk_jobs_tentativas_max`, `chk_jobs_provedor_definido` (corrigida em `20260806_corrigir_provedor_jobs_pipeline.sql` para `status <> 'concluido' OR provedor IS NOT NULL`). **Nenhum `job_substitui_id` existe** — mencionado na V2/contrato como decisão futura, nunca criado.

**Quem cria jobs hoje** (3 pontos, todos em PL/pgSQL, nenhum em TypeScript):
1. `estudio_anuncios_pipeline_iniciar(p_projeto_id)` (`20260807`) — cria o Pipeline + o **primeiro** job (sempre `analise_visual`, dado o catálogo atual). `job_origem_id` deve ficar `NULL` aqui — comportamento automático de coluna nova nullable, **nenhuma mudança de código necessária nesta função**.
2. `estudio_anuncios_pipeline_avancar(p_pipeline_id, p_job_id)` (`20260805`) — **é o único lugar que cria o job de `geracao_conteudo` a partir do job de `analise_visual` concluído**, no branch "próxima etapa ampla" (linhas 178-192 da migration atual), porque `analise_visual` e `geracao_conteudo` pertencem a etapas amplas diferentes no catálogo (`analise_produto` → `gerar_conteudo`). O branch "próxima subetapa da mesma etapa ampla" (linhas 121-147) cria jobs como `revisao_claude`/`adaptacao_marketplace` a partir de `geracao_conteudo` — não afetados nesta tarefa.
3. `estudio_anuncios_pipeline_concluir_job(p_pipeline_id, p_job_id, p_provedor)` (`20260806_corrigir_provedor_jobs_pipeline.sql`, assinatura atual — **não** a de `20260806_estudio_anuncios_pipeline_rpcs_atomicas.sql`, que foi substituída) — chama `estudio_anuncios_pipeline_avancar()` internamente. Não cria job diretamente, herda o comportamento de (2) sem duplicar lógica.

`estudio_anuncios_pipeline_registrar_falha()` **nunca cria job** no caminho de retry — devolve a mesma linha para `status='pendente'` (linhas 272-276 da migration `20260805`). Isso já garante, por construção, o requisito "retry mantém o mesmo `job_origem_id`, nunca recalcula" — nenhuma mudança necessária aqui, o valor gravado na criação simplesmente nunca é tocado de novo.

### 3.2 Regra de preenchimento — onde exatamente

Só o branch "próxima etapa ampla" de `estudio_anuncios_pipeline_avancar()` precisa mudar, e só nesse INSERT (não no branch de subetapa-mesma-etapa-ampla, que nunca cria `geracao_conteudo` dado o catálogo atual). Condição por **nome de etapa**, não por posição no catálogo (evita generalizar para toda transição, conforme sua recomendação — opção B mínima):

```sql
job_origem_id = CASE
  WHEN v_job.etapa = 'analise_visual' AND v_primeira_subetapa.job_etapa = 'geracao_conteudo'
  THEN v_job.id
  ELSE NULL
END
```

`v_job` já é lido no passo 3 da função (é o job que acabou de concluir — exatamente `p_job_id`) — nenhuma consulta nova precisa ser adicionada, só usar um dado que a função já carrega. Isso cumpre a exigência "definido na mesma transação do avanço, não depois em TypeScript, e no momento de criação do job seguinte" — é literalmente o mesmo `INSERT` que cria o job, não um `UPDATE` posterior.

### 3.3 Migration — SQL completo, confirmado contra o banco, NÃO executado

Confirmado contra `pg_get_functiondef(...)` (seção 3, topo) — a base usada (`20260805_estudio_anuncios_pipeline_rpcs.sql`) é idêntica à função realmente instalada. Este é o SQL definitivo desta migration, ainda não executado — falta só a decisão sobre os 5 registros de teste da seção 3.6 (opcional, não bloqueante) antes de rodar.

```sql
-- supabase/migrations/20260811_estudio_anuncios_job_origem_id.sql
--
-- Adiciona rastreabilidade explícita entre um job de geracao_conteudo e
-- o job exato de analise_visual que o originou. Nunca inferido por
-- "resultado mais recente" — preenchido dentro da mesma transação que
-- cria o job, por estudio_anuncios_pipeline_avancar().
--
-- Escopo desta migration: só a transição analise_visual -> geracao_conteudo
-- é preenchida. Não generaliza para "job_origem_id sempre aponta pro job
-- imediatamente anterior" — decisão explícita, ver contrato/preparação
-- de implementação. Outras transições continuam gravando NULL até uma
-- decisão própria existir para elas.

ALTER TABLE public.estudio_anuncios_jobs
  ADD COLUMN IF NOT EXISTS job_origem_id UUID;

-- Postgres não tem "ADD CONSTRAINT IF NOT EXISTS" (diferente de ADD
-- COLUMN) — idempotência via checagem explícita em pg_constraint antes
-- de adicionar. Corrigido nesta revisão (a versão anterior tinha um
-- ADD CONSTRAINT nu, que falharia numa 2ª execução acidental da
-- migration).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_estudio_anuncios_jobs_job_origem_id'
      AND conrelid = 'public.estudio_anuncios_jobs'::regclass
  ) THEN
    ALTER TABLE public.estudio_anuncios_jobs
      ADD CONSTRAINT fk_estudio_anuncios_jobs_job_origem_id
      FOREIGN KEY (job_origem_id)
      REFERENCES public.estudio_anuncios_jobs(id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- Parcial (WHERE NOT NULL): a maioria dos jobs continuará com
-- job_origem_id=NULL nesta fase (só geracao_conteudo o preenche) —
-- mesmo padrão já usado em idx_imagens_origem_principal/
-- idx_imagens_geradas_principal (índice parcial condicionado a um
-- subconjunto pequeno de linhas).
CREATE INDEX IF NOT EXISTS idx_estudio_anuncios_jobs_job_origem_id
  ON public.estudio_anuncios_jobs (job_origem_id)
  WHERE job_origem_id IS NOT NULL;

COMMENT ON COLUMN public.estudio_anuncios_jobs.job_origem_id IS
  'Job de origem imediata desta execução (hoje: só preenchido em jobs geracao_conteudo, apontando pro job analise_visual concluído que o originou). NULL para o primeiro job de qualquer pipeline (analise_visual) e para qualquer transição ainda sem vínculo definido. Preenchido exclusivamente por estudio_anuncios_pipeline_avancar(), na mesma transação que cria o job — nunca em TypeScript, nunca inferido por "resultado mais recente". ON DELETE SET NULL: preserva o job consumidor mesmo se o job de origem for removido (hoje jobs nunca são DELETE físico, mas a FK não presume isso pra sempre).';


-- ────────────────────────────────────────────────────────────────────
-- estudio_anuncios_pipeline_avancar() — CREATE OR REPLACE completo,
-- corpo idêntico ao atual (20260805_estudio_anuncios_pipeline_rpcs.sql)
-- exceto o INSERT do branch "próxima etapa ampla" (passo 10), que ganha
-- a coluna job_origem_id. O branch "próxima subetapa da mesma etapa
-- ampla" (passo 6-7) e todo o resto da função permanecem byte-a-byte
-- iguais — reproduzidos aqui só porque CREATE OR REPLACE FUNCTION exige
-- o corpo inteiro, não porque a lógica de decisão foi tocada.
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.estudio_anuncios_pipeline_avancar(
  p_pipeline_id UUID,
  p_job_id      UUID
)
RETURNS public.estudio_anuncios_pipeline
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_pipeline              public.estudio_anuncios_pipeline;
  v_job                   public.estudio_anuncios_jobs;
  v_catalogo_atual        public.estudio_anuncios_pipeline_catalogo;
  v_subetapa_atual        public.estudio_anuncios_pipeline_catalogo_jobs;
  v_proxima_subetapa      public.estudio_anuncios_pipeline_catalogo_jobs;
  v_proxima_etapa_row     public.estudio_anuncios_pipeline_catalogo;
  v_primeira_subetapa     public.estudio_anuncios_pipeline_catalogo_jobs;
  v_novo_job_id           UUID;
BEGIN
  SELECT * INTO v_pipeline
  FROM public.estudio_anuncios_pipeline
  WHERE id = p_pipeline_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'pipeline % não encontrado', p_pipeline_id;
  END IF;

  IF v_pipeline.job_atual_id IS DISTINCT FROM p_job_id THEN
    RAISE EXCEPTION 'USO_INVALIDO_PIPELINE: job informado não corresponde ao job atual do pipeline (pipeline=%, job_atual_id=%, job_informado=%)',
      p_pipeline_id, v_pipeline.job_atual_id, p_job_id;
  END IF;

  IF v_pipeline.status <> 'em_execucao' THEN
    RAISE EXCEPTION 'PIPELINE_NAO_ESTA_EM_EXECUCAO: status atual é "%" (pipeline=%)', v_pipeline.status, p_pipeline_id;
  END IF;

  SELECT * INTO v_job FROM public.estudio_anuncios_jobs WHERE id = p_job_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'job % não encontrado', p_job_id;
  END IF;
  IF v_job.status <> 'concluido' THEN
    RAISE EXCEPTION 'job % não está concluído (status atual: %)', p_job_id, v_job.status;
  END IF;

  SELECT * INTO v_catalogo_atual
  FROM public.estudio_anuncios_pipeline_catalogo
  WHERE versao_catalogo = v_pipeline.versao_catalogo
    AND etapa = v_pipeline.etapa_atual;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'etapa "%" não encontrada no catálogo (versão %)', v_pipeline.etapa_atual, v_pipeline.versao_catalogo;
  END IF;

  SELECT * INTO v_subetapa_atual
  FROM public.estudio_anuncios_pipeline_catalogo_jobs
  WHERE catalogo_id = v_catalogo_atual.id
    AND job_etapa = v_job.etapa;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'subetapa "%" não encontrada no catálogo para a etapa "%"', v_job.etapa, v_catalogo_atual.etapa;
  END IF;

  SELECT * INTO v_proxima_subetapa
  FROM public.estudio_anuncios_pipeline_catalogo_jobs
  WHERE catalogo_id = v_catalogo_atual.id
    AND ordem > v_subetapa_atual.ordem
    AND obrigatoria = true
  ORDER BY ordem ASC
  LIMIT 1;

  IF FOUND THEN
    -- Branch inalterado nesta migration: job_origem_id não é preenchido
    -- aqui (transições dentro da mesma etapa ampla, ex. geracao_conteudo
    -- -> revisao_claude, não têm vínculo definido nesta tarefa).
    INSERT INTO public.estudio_anuncios_jobs (projeto_id, etapa, status, max_tentativas)
    VALUES (v_pipeline.projeto_id, v_proxima_subetapa.job_etapa, 'pendente', v_catalogo_atual.max_tentativas)
    RETURNING id INTO v_novo_job_id;

    UPDATE public.estudio_anuncios_pipeline
    SET job_atual_id = v_novo_job_id,
        status = 'aguardando',
        ultima_execucao = now(),
        atualizado_em = now()
    WHERE id = p_pipeline_id
    RETURNING * INTO v_pipeline;

    RETURN v_pipeline;
  END IF;

  SELECT * INTO v_proxima_etapa_row
  FROM public.estudio_anuncios_pipeline_catalogo
  WHERE versao_catalogo = v_pipeline.versao_catalogo
    AND ordem > v_catalogo_atual.ordem
    AND ativa = true
    AND tipo = 'obrigatoria'
  ORDER BY ordem ASC
  LIMIT 1;

  IF NOT FOUND THEN
    UPDATE public.estudio_anuncios_pipeline
    SET status = 'concluido',
        proxima_etapa = NULL,
        concluido_em = now(),
        ultima_execucao = now(),
        atualizado_em = now()
    WHERE id = p_pipeline_id
    RETURNING * INTO v_pipeline;

    RETURN v_pipeline;
  END IF;

  SELECT * INTO v_primeira_subetapa
  FROM public.estudio_anuncios_pipeline_catalogo_jobs
  WHERE catalogo_id = v_proxima_etapa_row.id
    AND obrigatoria = true
  ORDER BY ordem ASC
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'etapa "%" está ativa e obrigatória mas não tem nenhuma subetapa obrigatória cadastrada', v_proxima_etapa_row.etapa;
  END IF;

  -- ÚNICA MUDANÇA REAL DESTA MIGRATION: job_origem_id preenchido só
  -- quando o job que acabou de concluir é analise_visual e o job novo é
  -- geracao_conteudo. Qualquer outra combinação grava NULL, igual hoje.
  INSERT INTO public.estudio_anuncios_jobs (projeto_id, etapa, status, max_tentativas, job_origem_id)
  VALUES (
    v_pipeline.projeto_id,
    v_primeira_subetapa.job_etapa,
    'pendente',
    v_proxima_etapa_row.max_tentativas,
    CASE
      WHEN v_job.etapa = 'analise_visual' AND v_primeira_subetapa.job_etapa = 'geracao_conteudo'
      THEN v_job.id
      ELSE NULL
    END
  )
  RETURNING id INTO v_novo_job_id;

  UPDATE public.estudio_anuncios_pipeline
  SET etapa_atual = v_proxima_etapa_row.etapa,
      job_atual_id = v_novo_job_id,
      status = 'aguardando',
      ultima_execucao = now(),
      atualizado_em = now()
  WHERE id = p_pipeline_id
  RETURNING * INTO v_pipeline;

  RETURN v_pipeline;
END;
$$;

COMMENT ON FUNCTION public.estudio_anuncios_pipeline_avancar(UUID, UUID) IS
  'Avança o Pipeline após um job concluir com sucesso — cria o próximo job (mesma etapa ou próxima etapa ampla obrigatória) ou marca o pipeline concluído, atomicamente. Preenche job_origem_id apenas na transição analise_visual -> geracao_conteudo (ver migration 20260811); outras transições gravam NULL até terem vínculo definido. NÃO é tolerante a chamada duplicada/fora de ordem. Restrita a service_role.';

-- REVOKE/GRANT inalterados (já existem, CREATE OR REPLACE não os remove
-- em Postgres — mas reafirmados aqui por clareza/paridade com o padrão
-- já usado nas outras migrations desta RPC).
REVOKE EXECUTE ON FUNCTION public.estudio_anuncios_pipeline_avancar(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.estudio_anuncios_pipeline_avancar(UUID, UUID)
  TO service_role;
```

### 3.4 Diff resumido das funções alteradas

- `estudio_anuncios_pipeline_iniciar()`: **nenhuma mudança**. Coluna nova é nullable — o job de `analise_visual` criado por ela já nasce com `job_origem_id=NULL` sem precisar tocar a função.
- `estudio_anuncios_pipeline_avancar()`: **1 `INSERT` alterado** (branch "próxima etapa ampla"), de 4 para 5 colunas, com um `CASE` que só resolve não-`NULL` numa combinação específica de nomes de etapa. Nenhuma outra linha da função muda.
- `estudio_anuncios_pipeline_registrar_falha()`: **nenhuma mudança** — não cria job no caminho de retry.
- `estudio_anuncios_pipeline_concluir_job()` / `estudio_anuncios_pipeline_falhar_job()` (assinaturas atuais, com `p_provedor`): **nenhuma mudança** — chamam as duas funções acima internamente, herdam o comportamento sem precisar de `CREATE OR REPLACE` própria.

Nenhuma lógica de decisão do Pipeline foi duplicada — o `CASE` novo só lê dados que a função já carregava (`v_job`, já buscado no passo 3; `v_primeira_subetapa`, já buscada no passo 10 original) para decidir um VALOR de coluna, não uma branch de fluxo nova.

### 3.5 Pergunta A vs. B (job_origem_id sempre aponta pro job imediatamente anterior, ou cada etapa define sua dependência específica)

Concordo com sua recomendação (coluna genérica, preenchimento pontual). Justificativa técnica adicional: a própria estrutura do catálogo (`estudio_anuncios_pipeline_catalogo`/`_catalogo_jobs`) já separa "etapa ampla" de "subetapa" — o "job imediatamente anterior" nem sempre é semanticamente relevante (ex.: o job imediatamente anterior a `calculo_score` pode ser `geracao_imagem`, mas o score provavelmente depende de `adaptacao_marketplace`, não da imagem). Fixar a coluna como "sempre o anterior" hoje criaria uma regra que quase certamente precisaria ser quebrada mais tarde para pelo menos uma etapa — melhor deixar a coluna genérica e preencher só onde o vínculo já foi decidido (opção B), exatamente como proposto.

### 3.6 Inventário de jobs existentes — CONFIRMADO

Levantado nesta rodada, com dado literal do banco (não presumido).

**Contagem por status** (`estudio_anuncios_jobs`, `etapa='geracao_conteudo'`): 6 `concluido`, 1 `erro`, 4 `pendente`, 0 `rodando`. Total 11.
**Resultados estruturados persistidos** (`estudio_anuncios_resultados_pipeline`, `etapa='geracao_conteudo'`): 0 — nenhum `schema_versao` a reconciliar.

**Detalhamento dos 5 não-concluídos** (`erro` + `pendente`), todos projetos `TESTE_*` de rodadas anteriores deste projeto:

| Projeto | Status | tentativas/max | pipeline_status | Observação |
|---|---|---|---|---|
| `TESTE_FASE_0_PING` | erro | 0/3 | (sem linha de pipeline) | Órfão de infraestrutura Fase 0 — sem pipeline associado, nenhuma RPC consegue tocá-lo de novo (`registrar_falha()` exige a linha do pipeline). |
| `TESTE_COM_FOTO_REGRESSAO` | pendente | 3/3 | aguardando | `tentativas = max_tentativas` |
| `TESTE_CENARIO2_MARCA_AMBIGUA` | pendente | 3/3 | aguardando | idem |
| `TESTE_CENARIO3_MULTIPLAS_FOTOS` | pendente | 3/3 | aguardando | idem |
| `TESTE_V2_CONTRATO_FINAL 1` | pendente | 3/3 | aguardando | idem |

**Achado importante, corrigindo a preocupação original desta seção**: os 4 `pendente` têm `tentativas = max_tentativas = 3`. `claim_next_estudio_anuncios_job()` só reivindica jobs com `tentativas < max_tentativas` (`20260803_central_ia_estudio_anuncios_schema.sql`) — `3 < 3` é falso, então esses 4 já são permanentemente não-reivindicáveis pelo Worker hoje, **independente desta migration**. A validação nova de `job_origem_id` (seção 3.7) nunca chega a rodar contra eles, porque o fluxo normal nunca mais os toca. A hipótese original ("job pendente pode ser pego pelo Worker a qualquer momento e falharia na validação nova") não se confirma para nenhum dos 5 — nem o `erro` (sem pipeline) nem os 4 `pendente` (tentativas esgotadas).

**Confirmação explícita sobre backfill**: esta migration não propõe nenhum backfill de `job_origem_id` para jobs já existentes. Todo job de `geracao_conteudo` criado antes da migration — concluído, em erro, ou pendente — permanece com `job_origem_id = NULL` para sempre, a menos que seja reprocessado por uma nova execução do Pipeline (novo job, criado depois da migration, passando pelo `INSERT` corrigido de `estudio_anuncios_pipeline_avancar()`). Jobs já `concluido`/`erro` (histórico) continuam consultáveis normalmente (nenhuma linha é apagada ou alterada por esta migration) — só não poderão ser reaproveitados por uma nova execução de `geracao_conteudo`.

**Ressalva para o futuro, não urgente**: se algum dia alguém resetar manualmente `tentativas`/`status` de um desses 4 jobs pra "destravá-lo" (fora do escopo desta tarefa, nada aqui propõe isso), ele passaria a ser reivindicável de novo e falharia na validação de `job_origem_id`, já que nasceu antes da migration. Vale documentado aqui pra não surpreender alguém no futuro.

**Recomendação opcional, não decidida por mim**: os 5 são resíduo de teste seguro de limpar (mesmo padrão de reconciliação lógica já usado outras vezes neste projeto — nunca `DELETE`, só `status`/`erro_tipo` ajustados e pipeline cancelado), mas não bloqueiam nem são afetados pela migration. Posso preparar o SQL de limpeza se você quiser, antes ou depois da PARTE 2 — sua escolha.

### 3.7 Validação antes de executar `geracao_conteudo` (7 checagens)

Não é parte da migration — é lógica de aplicação (TypeScript), a ser implementada no handler/executor de `geracao_conteudo` na PARTE 2, ANTES de qualquer chamada de IA:

```
1. job.job_origem_id IS NOT NULL
2. job de origem (job_origem_id) existe
3. job de origem pertence ao mesmo projeto_id
4. job de origem.etapa = 'analise_visual'
5. job de origem.status = 'concluido'
6. exatamente 1 linha em estudio_anuncios_resultados_pipeline com job_id = job_origem_id
7. resultado.schema_versao = 1 E resultado.etapa = 'analise_visual'
```
Qualquer falha: `erro_tipo='validation'`, nenhuma chamada de IA, nenhum prompt registrado, nenhum consumo, nenhum resultado novo — mesmo padrão já usado em `selecionarFotosParaAnalise()` (falha antes de qualquer chamada ao Gemini).

---

## 4. Plano de arquivos — `geracao_conteudo` (implementação real, PARTE 2)

**Correção do Bloqueio 2**: a versão anterior deste plano colocava os tipos de domínio (`GeracaoConteudoIA`, envelope, etc.) dentro de `lib/ai-gateway/provedores/`, namespace do adaptador Google. Isso contraria o próprio contrato congelado, que é explícito em ser "independente de provedor" (linha 4-6 do documento de contrato) — acoplaria o domínio ao Google e obrigaria um futuro adaptador Claude/OpenAI a importar tipos de dentro do namespace de outro provedor. Vale registrar com honestidade: essa separação hoje **não existe** em `analise_visual` — `google-tipos.ts` mistura os tipos de domínio (`AnaliseVisualIA`, `OrigemAtributo`) com o schema JSON específico do Google no mesmo arquivo, sob `lib/ai-gateway/provedores/`. Isso não é revisitado aqui (contrato de `analise_visual` congelado, fora de escopo), mas não há motivo pra repetir a mesma dívida em `geracao_conteudo`, que ainda não tem nenhum código escrito — corrigir agora custa zero retrabalho futuro; herdar o padrão custaria uma migração de tipos mais tarde.

### Domínio
- Novo `lib/estudio-anuncios/geracao-conteudo-tipos.ts`: contrato de domínio completo — `GeracaoConteudoIA`, envelope persistido, `FatoPermitido`, `DescricaoComRessalva`, `CampoOrigem` (derivado de `AnaliseVisualIA`, não redigitado — contrato §12), `OrigemFatoEntrada` (derivado de `OrigemAtributo`), `FatoAfetadoPorAlerta`, `SCHEMA_VERSAO_GERACAO_CONTEUDO = 1`. Nenhuma dependência de `lib/ai-gateway/provedores/*`.

### Adaptador Google
- Novo `lib/ai-gateway/provedores/google-conteudo-schema.ts`: só o JSON Schema / formato de `response_format` específico do SDK do Google, e a tradução do contrato de domínio para esse formato. Importa tipos de `geracao-conteudo-tipos.ts` — nunca redefine.
- Alterar `lib/ai-gateway/provedores/google.ts`: adicionar `chamarGeminiTexto()` (nova função, texto puro, sem imagem/Storage/download) e `obterModeloConteudo()` (lê `GOOGLE_AI_MODEL_CONTEUDO`). Não altera `chamarGeminiComImagens()`/`obterModeloVisual()` existentes.

### Orquestração
- Novo `lib/estudio-anuncios/geracao-conteudo.ts`: `montarEntradaSeguraGeracaoConteudo()` — consome o resultado exato de `analise_visual` (via `job_origem_id`, nunca `ORDER BY criado_em DESC`), atribui `F*`/`R*`, classifica A/B/C/D, serializa `categoriaProvavel`/`quantidadeDeclarada`, separa `informacoesProibidas`/`contextoPromocional`, registra `fatosAfetadosPorAlerta`, decide entrada suficiente/limitada/insuficiente. Também abriga: prompt de domínio, orquestração da chamada ao adaptador, montagem do envelope, validação estrutural/cruzada de `fatoIds`/ressalvas/especificações (seção 2.1 do contrato), e a checagem das 7 condições de `job_origem_id` (seção 3.7 abaixo). Importa tipos de `geracao-conteudo-tipos.ts`, importa a função de chamada de `google.ts` e o schema de `google-conteudo-schema.ts` — nunca o contrário.

### Persistência
- Reaproveita `registrarResultadoPipeline()` (já genérico, `lib/ai-gateway/registro.ts`) — sem alteração — chamado pelo handler com `schemaVersao: SCHEMA_VERSAO_GERACAO_CONTEUDO` (declarado no handler, não hardcoded no executor — ver acoplamento #2 da seção 2.2).

### Arquivos a criar
- `lib/estudio-anuncios/geracao-conteudo-tipos.ts` (domínio)
- `lib/ai-gateway/provedores/google-conteudo-schema.ts` (schema/adaptador Google)
- `lib/estudio-anuncios/geracao-conteudo.ts` (orquestração)
- `lib/estudio-anuncios/executores/registry.ts`
- `lib/estudio-anuncios/executores/analise-visual.ts` (handler extraído)
- `lib/estudio-anuncios/executores/fake-generico.ts` (handler extraído)
- `supabase/migrations/20260811_estudio_anuncios_job_origem_id.sql`
- (só ao final da PARTE 2, ver 2.4) entrada de `geracao_conteudo` em `HANDLERS_ESPECIFICOS` — não é um arquivo novo, é uma linha adicionada em `registry.ts` depois de tudo o mais já estar pronto e testado.

### Arquivos a alterar
- `lib/estudio-anuncios/executar-job.ts` (troca if/else por `resolverHandler()` + checagem de `provedoresPermitidos`)
- `lib/ai-gateway/provedores/google.ts` (+ `chamarGeminiTexto()`, `obterModeloConteudo()`)
- `lib/ai-gateway/roteamento.ts` (`decidirProvedor()` ganha o caso `geracao_conteudo` + `GOOGLE_AI_ENABLED`)
- `.env.example` (+ `GOOGLE_AI_MODEL_CONTEUDO=`)
- RPCs de avanço (migration acima — pendente de confirmação, ver Bloqueio 3)

### Não alterar sem justificativa nova
Worker, páginas, Sidebar, upload, Storage, fotos, contrato congelado de `analise_visual`, contrato congelado de `geracao_conteudo`.

---

## 5. Riscos

1. **Refatoração do executor sem chamada real de IA envolvida** — risco de regressão em `analise_visual` por erro mecânico de extração (não por mudança de lógica). Mitigado pelos testes 1/2/5 da seção 6 + `tsc --noEmit` + diff manual do handler extraído contra o bloco original.
2. **Timeout de `chamarGeminiTexto()` decidido sem dado real** — nesta fase não há nenhuma chamada real de texto ao Gemini testada; a constante inicial será uma estimativa, não uma calibração. Aceitável porque o Worker já tem timeout configurável e generoso (`ESTUDIO_ANUNCIOS_WORKER_HTTP_TIMEOUT_MS`, corrigido em tarefa anterior) como rede de segurança externa.
3. **`decidirProvedor()` ganhando um segundo caso hardcoded** (`geracao_conteudo` + `GOOGLE_AI_ENABLED`) — mesmo padrão do caso existente, sem generalização; se um 3º caso aparecer (`revisao_claude` + Claude), a função pode precisar de uma estrutura mais genérica (não decidida nesta tarefa, fora de escopo).
4. **Migration adiciona FK autorreferente em tabela com índice único parcial já ativo** (`idx_estudio_anuncios_jobs_ativo`) — `job_origem_id` não participa desse índice, sem interação real, mas vale confirmar após a migration que nenhum novo job de teste quebra a unicidade por engano (checagem de smoke test, não um risco arquitetural).
5. **Momento da troca de `geracao_conteudo` entre `ETAPAS_FAKE_GENERICAS` e `HANDLERS_ESPECIFICOS`** (reescrito — a versão anterior deste risco descrevia um placeholder que foi removido do desenho, ver correção de Bloqueio da PARTE 1). Essa troca precisa ser atômica, num único commit: remover a etapa de `ETAPAS_FAKE_GENERICAS` sem, no mesmo passo, adicioná-la a `HANDLERS_ESPECIFICOS` faria `resolverHandler()` devolver `undefined` pra `geracao_conteudo` — não um placeholder silencioso, mas uma regressão real e imediata (uma etapa que hoje funciona, mesmo que fake, passaria a falhar com `validation`). Mitigação: os testes 1-5 (+ o teste de disjunção) da seção 6 devem rodar de novo, já com o handler real registrado, antes de qualquer deploy dessa troca especificamente.

---

## 6. Plano de testes (isolados, offline, antes de qualquer chamada real)

### Registry
1. `analise_visual` resolve para o handler atual (mesmo objeto/comportamento pré-refatoração).
2. `geracao_conteudo` continua resolvendo para `handlerFakeGenerico` até que o handler específico seja implementado — nenhum handler dedicado nem placeholder aparece pra ela nesta rodada (corrige inconsistência apontada na revisão: este item ainda citava "novo handler (placeholder)", texto desatualizado em relação ao desenho corrigido da seção 2.3/2.4).
3. Etapa sem handler → erro `validation`, sem exceção não tratada.
4. Handler específico registrado sob chave diferente da própria `etapa` → falha no boot do módulo (não em runtime).
5. `analise_visual` mantém exatamente o mesmo comportamento observável (fake e google) do código pré-refatoração.

Teste adicional, não numerado no esquema original (evita renumerar os blocos seguintes, que são referenciados por faixa — 16-27, 28-40): etapa presente simultaneamente em `HANDLERS_ESPECIFICOS` e `ETAPAS_FAKE_GENERICAS` → falha no boot do módulo (checagem de disjunção da seção 2.3).

### `job_origem_id`
6. Job de `geracao_conteudo` criado via `estudio_anuncios_pipeline_avancar()` reflete `job_origem_id` = id do job `analise_visual` concluído.
7. Retry do mesmo job (`registrar_falha` com tentativas restantes) preserva `job_origem_id` inalterado.
8. `job_origem_id` nulo → validação de entrada segura bloqueia, `erro_tipo='validation'`, nenhuma chamada de IA.
9. `job_origem_id` apontando pra job inexistente → bloqueia.
10. `job_origem_id` apontando pra job de outro projeto → bloqueia.
11. `job_origem_id` apontando pra job de etapa diferente de `analise_visual` → bloqueia.
12. `job_origem_id` apontando pra job não concluído → bloqueia.
13. `job_origem_id` apontando pra job concluído sem nenhum resultado estruturado → bloqueia.
14. `job_origem_id` apontando pra resultado com `schema_versao` diferente de 1 → bloqueia.
15. Nenhum caminho de código faz `ORDER BY criado_em DESC LIMIT 1` pra achar a origem — checagem por inspeção de código, não teste em runtime.

### Entrada segura (`montarEntradaSeguraGeracaoConteudo`)
16-27. Conforme os 12 itens já listados na sua mensagem — cobertos pelo desenho do contrato (§2, §7, §12 do documento de contrato), a implementar na PARTE 2 junto do código real.

### Validação da saída
28-40. Conforme os 13 itens já listados na sua mensagem — mapeiam diretamente pras regras já fechadas no contrato (§2.1 integridade, §2 regras cruzadas, §1 opcionalidade, §6 especificações).

---

## 7. Não feito nesta rodada (confirmação)

Nenhuma chamada real de `geracao_conteudo`. Nenhum job real executado. Claude não integrado. `revisao_claude`/`adaptacao_marketplace` não implementados. Nenhuma UI nova. Upload/Storage intocados. Provedor fake das demais etapas mantido. `central_ia_prompts.custo` não tocado. Script de `ping` não tocado. **Nenhum arquivo de código foi criado, editado ou executado nesta rodada** — só este documento e a migration acima, que também não foi executada.

---

## 8. Pendências para a PARTE 2 (só após aprovação explícita)

1. Executar a migration `20260811_estudio_anuncios_job_origem_id.sql`.
2. Implementar o registry + extrair o handler de `analise_visual`.
3. Implementar tipos + `montarEntradaSeguraGeracaoConteudo()`.
4. Implementar `chamarGeminiTexto()`/`obterModeloConteudo()` em `google.ts`.
5. Implementar as validações (estrutural, cruzada, especificações).
6. Integrar o handler real de `geracao_conteudo` no registry.
7. Rodar os 40 testes isolados listados na seção 6.
8. `npx tsc --noEmit`.
9. Parar antes da primeira chamada real — não incluído nesta rodada nem na próxima sem novo pedido explícito.
