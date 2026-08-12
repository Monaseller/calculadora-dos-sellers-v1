# PROJECT STATE — Estúdio de Anúncios com IA (Central de IA / CDS)

> Fonte oficial de contexto deste módulo. Escrito a partir do código real do
> repositório (migrations, `lib/`, `app/api/`, `app/(app)/central-ia/`,
> `scripts/`), não da memória de conversa. Qualquer nova sessão do Claude
> Code deve conseguir retomar o trabalho a partir só deste arquivo.
>
> Última atualização: 2026-08-06 (data do ambiente no momento da escrita).
> Este arquivo muda raramente — só quando algo estrutural muda (nova
> migration executada, nova decisão congelada, novo bug, novo contrato).
> Para saber exatamente onde o trabalho parou e qual é a próxima tarefa
> autorizada, **leia `docs/NEXT_TASK.md` primeiro** (arquivo curto, muda a
> cada sessão) — ele é a fonte única de estado da sessão, não a Seção 13
> abaixo (que só guarda o resumo histórico fixo de PARTE 1/PARTE 2).

---

## COMO CONTINUAR ESTE PROJETO

**Antes de escrever qualquer código, toda nova sessão deve seguir esta ordem:**

0. **Ler `docs/CLAUDE_CONSTITUTION.md` integralmente — sempre, antes de
   tudo.** É a autoridade máxima do repositório (criada em 2026-08-06).
   Havendo conflito entre este arquivo e a Constituição, **a Constituição
   prevalece**.
1. Ler `docs/NEXT_TASK.md` — é o resumo mais curto e mais
   recente de onde o trabalho parou e do que está de fato autorizado a
   fazer agora.
2. Ler este arquivo (`PROJECT_STATE.md`) inteiro — contexto estrutural
   completo (arquitetura, migrations, contratos, decisões, regras).
3. Ler `docs/BUGS.md`.
4. Ler `docs/CHANGELOG.md` — com ressalva: está desatualizado para este
   módulo desde 2026-08-04 (ver Seção 14, divergência registrada). Não
   assumir que o que não está lá não aconteceu.
5. Ler só os arquivos de código relacionados à tarefa atual (a Seção 12
   indica onde cada responsabilidade vive, para não precisar reler o
   módulo inteiro a cada sessão).
6. Nunca assumir que a documentação está correta sem conferir o código
   real — este documento já registra 2 divergências doc↔código
   encontradas por auditoria direta (Seção 14).
7. Nunca editar uma migration já executada — sempre criar uma migration
   nova (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE
   FUNCTION`, nunca editar o arquivo antigo).
8. Nunca alterar um contrato JSON (Seção 6) sem decidir explicitamente se
   `schema_versao` precisa subir.
9. Nunca criar fallback silencioso — env ausente/inválida, provedor,
   modelo: sempre erro explícito, nunca um valor "tentado" no lugar.
10. Rodar `npx tsc --noEmit` antes de finalizar qualquer alteração.
11. Só depois de tudo isso, começar a implementação.
12. **Ao encerrar a sessão, atualizar `docs/NEXT_TASK.md` — sempre,
    mesmo que a tarefa não tenha terminado.** Só atualizar este arquivo
    (`PROJECT_STATE.md`) se algo estrutural realmente mudou. Este passo é
    exatamente o que falhou com `docs/CHANGELOG.md` neste módulo (ver
    Seção 14) — não deixar de fazer aqui.

---

## 1. Visão geral

O **Estúdio de Anúncios com IA** é um módulo novo da Calculadora dos
Sellers (CDS), dentro de um contêiner maior chamado **Central de IA**
(`app/(app)/central-ia/`). Ele recebe fotos reais de um produto e gera,
automaticamente, o material necessário para anunciá-lo em um ou mais
marketplaces (ML, Shopee, Amazon, TikTok Shop): análise visual do produto,
título/descrição-base, revisão, adaptação por marketplace, prompts e
imagens de apresentação, vídeo (fase futura) e uma nota de qualidade
estrutural do anúncio (score). É um módulo 100% aditivo — não altera
nenhuma tabela, rota ou regra financeira do restante do CDS (pedidos,
lojas, sync, dashboard).

O núcleo do módulo é o **Pipeline Orchestrator**: uma máquina de estados
que decide, projeto a projeto, qual é a próxima etapa a executar, e uma
fila (`estudio_anuncios_jobs`) processada por um **Worker** externo
(`scripts/estudio-anuncios-worker.mjs`) que chama uma rota interna, que
por sua vez chama um **AI Gateway** — hoje majoritariamente **fake**
(determinístico, sem custo, sem rede), com **Gemini real** já integrado
para 2 das 8 etapas (`analise_visual` e `geracao_conteudo`), atrás de
feature flags que, por padrão, mantêm essas etapas em modo fake.

Panorama do Pipeline (catálogo `versao_catalogo=1`, guardado no banco —
única fonte de verdade, nunca duplicado em código):

```
analise_produto (obrigatória)
  └─ analise_visual → busca_externa (condicional, nunca disparada automaticamente)
pendencias (manual — nunca disparada automaticamente)
gerar_conteudo (obrigatória)
  └─ geracao_conteudo → revisao_claude → adaptacao_marketplace
gerar_imagens (obrigatória)
  └─ geracao_prompts_imagem → geracao_imagem
gerar_video (condicional — nunca disparada automaticamente)
  └─ geracao_roteiro_video → geracao_video
avaliacao (obrigatória)
  └─ calculo_score
exportacao (condicional, INATIVA no catálogo — nunca disparada)
```

Na Fase 1 (estado atual), só etapas `tipo='obrigatoria'` avançam
automaticamente. O fluxo automático real, hoje, é:
**analise_produto → gerar_conteudo → gerar_imagens → avaliacao → concluído.**
`pendencias`, `gerar_video` e `exportacao` existem no catálogo (arquitetura
pronta para o futuro) mas nunca são disparadas nesta fase.

---

## 2. Estado atual do desenvolvimento

| Módulo | Estado | Observação |
|---|---|---|
| Projetos (CRUD do Projeto Mestre) | **Concluído** | RPC `criar_projeto_estudio_anuncios` + rotas GET/POST/PATCH/DELETE implementadas, testadas, com soft-delete idempotente. |
| Upload de fotos | **Concluído** | Upload real multipart, validação por assinatura de bytes, compensação em caso de falha parcial, resposta por-arquivo (sucesso/falha). |
| Storage | **Concluído** | Bucket privado `estudio-anuncios-originais` em uso (upload/download/URL assinada). Buckets de imagem gerada/exportação (`estudio-anuncios-gerado`, `estudio-anuncios-exportacoes`) só existem no plano documentado — **nunca criados nem usados em código**. |
| Pipeline (schema + 7 RPCs) | **Concluído e testado** | Todas as RPCs executadas e validadas via SQL puro e/ou E2E real do Worker (ver seção 8). |
| Worker | **Concluído** | Execução única (sem loop, sem heartbeat próprio), claim atômico, timeout HTTP configurável. |
| Gateway (fake + roteamento) | **Concluído** | Caminho fake 100% funcional para as 8 etapas. `decidirProvedor()` só desvia para Google em 2 etapas, atrás de 2 flags independentes (ambas `false` por padrão em `.env.example`). |
| Registry (executor de handlers) | **Concluído** | `HANDLERS_ESPECIFICOS = {analise_visual, geracao_conteudo}`; as outras 6 etapas caem no `handlerFakeGenerico`. |
| Análise Visual (Gemini) | **Concluído e validado com chamada real** | Prompt versionado, schema JSON, validação estrutural, seleção/limite de fotos e persistência do resultado todos implementados. **Validado contra a API real em 2026-08-06** (5 chamadas, US$ 0,0496, 1 resultado estruturado gravado, produtos reais reconhecidos) — ver Seção 8. `GOOGLE_AI_ENABLED=true` no `.env.local`. |
| Geração de Conteúdo (Gemini) | **Concluído e validado com chamada real** | Domínio, schema Google, entrada segura, orquestração, handler real e 56 testes unitários — todos passando. **Validado contra a API real em 2026-08-06** (US$ 0,010197; campo opcional confirmado como *chave ausente*, não `null`; `fatoIds` e `contemRessalva` corretos com dado real). `GOOGLE_AI_GERACAO_CONTEUDO_ENABLED=true` no `.env.local`. Ver Seção 8. |
| Revisão Claude | **CONCLUÍDA — IA real (Anthropic) validada em produção-de-teste** | Segundo provedor real do módulo. Chamada real executada em 2026-08-14 com `claude-opus-5` (`provedor=anthropic`, 10,8s, US$ 0,02688). Domínio, schema, orquestração, validações, handler, idempotência e 40 testes determinísticos validados; `tsc` limpo; `adaptacao_marketplace` passou a consumir o artefato revisado. `ANTHROPIC_REVISAO_ENABLED=true`. |
| Adaptação por Marketplace | **Concluído e validado com chamada real** | Domínio, schema Google, orquestração, validação estrutural + integridade, handler real e 36 testes determinísticos. **Validado contra a API real em 2026-08-13** (US$ 0,010017; 2 marketplaces num único job; CTA restrito a lista server-side; nenhuma especificação/medida alterada). `GOOGLE_AI_ADAPTACAO_MARKETPLACE_ENABLED=true`. Persiste só em `resultados_pipeline` — ver Seção 8. |
| Geração de Prompts de Imagem (Gemini) | **CONCLUÍDA — validada com chamada real** | Transforma a **verdade visual** de `analise_visual` em prompts estruturados. Chamada real em 2026-08-15 (`gemini-3.6-flash`, 20,4s, 733/773 tokens, **US$ 0,006897**, 3 prompts, 1 principal). Domínio, schema Google, orquestração, validações, handler, idempotência e 60 testes determinísticos; `tsc` limpo. **Não gera imagem, não toca Storage, não escreve em `imagens_geradas`.** `GOOGLE_AI_PROMPTS_IMAGEM_ENABLED=true`. |
| Geração de Imagens (a imagem em si) | **CONCLUÍDA — imagens reais geradas e auditadas visualmente** | Executa o contrato de `geracao_prompts_imagem` com `gemini-3.1-flash-image` via Interactions API, usando as fotos originais como referência visual. **4 imagens reais geradas em 2026-08-16** (1 no cenário mínimo + 3 no completo), todas 1024×1024 JPEG, 1:1 exato, com auditoria visual aprovada. Idempotência e recuperação parcial validadas contra banco e Storage reais. 51 testes; `tsc` limpo; caminho fake preservado. `GOOGLE_AI_IMAGEM_ENABLED=true`. |
| Vídeo (roteiro + geração) | **Não iniciado** | Etapa `condicional`, nunca avançada automaticamente na Fase 1. Nenhum código além do placeholder de catálogo. |
| Score (cálculo) | **CONCLUÍDA — Fase 1 fechada** | Score 0–100 determinístico, **sem nenhuma chamada de IA** (`provedor=internal`, `modelo=regras-score-v1`). 8 blocos com pesos somando exatamente 100, cada ponto vindo de um critério nomeado com explicação. Reproduzível, explicável, auditável e versionado. Execução real em 2026-08-17: **96/100 (excelente)**, Pipeline fechado com `status=concluido`. 58 testes; `tsc` limpo. |
| **Publicação real (`POST /items`)** | **CONCLUÍDA — 1 anúncio real criado** | Primeira publicação controlada em 2026-08-31: item **`MLB7395781296`**, status `active`, conta MONAMOR, a partir do projeto de teste. **Exatamente um `POST /items`**, sem retry em nenhum caminho. Publica o payload LIDO da validação — nunca remontado — com os mesmos picture ids; **zero divergências** entre validado e criado. Protegido por reserva no banco (UNIQUE parcial) antes da chamada: segunda tentativa e duplo clique simultâneo retornam **409 `ja_publicado`** sem criar linha nova. Timeout/5xx viram `publicacao_incerta` (nunca `falha`) e disparam reconciliação por busca, sem reenviar. Não edita, não pausa, não fecha, não exclui. 23 testes novos; `tsc` limpo. |
| Pictures no CDN do ML + semântica de warning | **CONCLUÍDA — validada contra a conta real** | As 3 imagens sobem por `POST /pictures/items/upload` (oficial, multipart) e o payload passa a levar `pictures: [{ id }]` com picture ids **estáveis para a conta** — o payload validado e o que um `POST /items` enviaria viram o mesmo objeto. Mapa idempotente por `(loja, imagem, checksum)`. `derivarStatusOficial()` deixou de confundir HTTP com veredito: `warning` não bloqueia, `error` bloqueia, e a exceção ao 400 é estreita (só o envelope `validation_error` interpretado). Resultado real: **zero erros**, `validado_com_alertas`, `podePublicarML = true`. 21 testes novos; `tsc` limpo. |
| Imagens no Mercado Livre (`pictures`) | **CONCLUÍDA — validada contra a conta real** | As imagens geradas do próprio projeto passam a ir ao validador oficial, e `requiresPictures` **desapareceu**. Duas representações separadas: **identidade estável** (`id + checksum + ordem + principal`), que entra no hash e é persistida, e **transporte efêmero** (`{source}` com URL assinada de 300 s), que nasce no instante da chamada e **nunca** é persistido, logado ou hasheado. Bucket segue **privado** — zero `getPublicUrl`, zero base64, zero `storage_path` enviado. Seleção determinística (principal → `ordem` → id) com limite vindo de `max_pictures_per_item` da categoria. `versaoRegras = 7`. 24 testes novos; `tsc` limpo. |
| Dados logísticos da embalagem (`SELLER_PACKAGE_*`) | **CONCLUÍDA — validada contra a conta real** | Peso e as três dimensões da **embalagem de envio**, exigidos pelo ML (confirmado por `/categories/{id}/attributes` e pela resposta de `/items/validate`). **A caixa não é o produto:** nada deriva estes valores de `ficha.peso`/`ficha.medidas`, nem como valor inicial — um teste existe só para provar isso. Guardados em `g` e `cm`, **sem conversão**. Cinco regras de bloqueio (`versaoRegras = 6`), sendo uma só de FORMATO — "não informado" e "informado errado" são pedidos diferentes; as quatro medidas entram no hash do parecer e no da submissão. Só `SELLER_PACKAGE_*` (`hierarchy: ITEM`) é enviado; `PACKAGE_*` é `read_only`. Na validação real o erro de dimensões **sumiu**. As medidas são **inteiras** em todo o caminho (banco, servidor, UI, payload) e **nada é arredondado** — decimal é recusado, nunca consertado em silêncio. 43 testes; `tsc` limpo. |
| Modelo User Products + `family_name` | **CONCLUÍDA — validada contra a conta real** | O modelo da conta é **resolvido em `GET /users/{seller_id}`** (tag `user_product_seller`), nunca inferido do erro. Dois builders explícitos: em User Products o **`title` NÃO é enviado** (o ML monta o título) e `family_name` é obrigatório, com limite = `max_title_length` da categoria; em legacy o formato anterior é preservado. `variations` nunca é montado. O **título editorial continua intacto** — a diferença vive só no adapter. 46 testes; `tsc` limpo. |
| Vínculo de loja + validação oficial ML (`/items/validate`) | **CONCLUÍDA — validada contra a conta real** | Canal vinculado a uma conta ML **do próprio usuário**, reusando o OAuth existente (`lib/ml-auth.ts` + `lojas`) — **nenhuma arquitetura de autenticação nova**. Payload submetido é o MESMO artefato produzido pelo compliance (`montarPayloadPublicacaoMercadoLivre`), nunca remontado. Parecer oficial persistido append-only, idempotente por `hash_payload`. `podePublicarMercadoLivre()` é o portão obrigatório antes de qualquer `POST /items` futuro. **NENHUM anúncio criado.** 36 testes; `tsc` limpo. |
| Dados de publicação do Mercado Livre | **CONCLUÍDA — validada com fluxo real** | Categoria, preço, estoque, condição, tipo de anúncio e atributos por canal, em `projetos_marketplace`. **`category_id` só é gravado depois de `GET /categories/{id}` responder 200 na API pública do ML** (sem OAuth) — junto vem o snapshot de `settings`, que torna verificáveis os limites que são POR CATEGORIA. Preço em **centavos (BIGINT)**, exato ponta a ponta. Regras subiram para **v2**: título, descrição, moeda, condição, quantidade de imagens e atributos obrigatórios passaram de `nao_verificavel` a verificados de verdade. 81 testes; `tsc` limpo. |
| Pré-publicação / compliance (Mercado Livre) | **CONCLUÍDA — validada com fluxo real** | Responde "este conteúdo aprovado atende aos requisitos técnicos do marketplace?", separado da camada editorial. **Zero IA, zero custo, zero publicação, zero OAuth.** Regras 100% determinísticas, cada uma com `fonteOficial` + `verificadoEm` em `compliance/regras-mercado-livre.ts`, espelhadas em `docs/MARKETPLACE_COMPLIANCE.md`. Produz o **payload de pré-publicação** que a integração futura vai consumir, e `podePublicarMarketplace()` é o **portão único**. Parecer imutável em tabela própria, idempotente por hash da entrada + versão das regras. 55 testes; `tsc` limpo. |
| Pré-publicação — Shopee/Amazon/TikTok | **`nao_implementado` (deliberado)** | Shopee: a documentação oficial da Open Platform é SPA e não pôde ser lida neste ambiente; congelar regra de memória ou de terceiros é exatamente o que a camada existe para impedir. Amazon/TikTok: fora do escopo da V1. Nenhum deles aparece como publicável, e o motivo é explícito na UI. |
| Materialização do pacote em arquivo (ZIP) | **CONCLUÍDA — validada com fluxo real** | O ZIP é montado **exclusivamente a partir do pacote congelado** (`itens_incluidos`), nunca do estado atual do projeto. Estrutura `pacote-0001/` com `manifest.json`, `conteudo.json`, um `conteudo.csv` por canal exportável e `imagens/NN-finalidade.ext`. Escritor de ZIP próprio (`lib/estudio-anuncios/zip.ts`, zero dependência nova) **byte-estável**: mesmo pacote ⇒ bytes idênticos. Bucket privado **já existente** `estudio-anuncios-exportacoes`; download só por URL assinada de 300s. Materializar **não altera** hash/itens/número/status — garantido pela lista de SET da RPC. 32 testes; `tsc` limpo. |
| Exportação do conteúdo aprovado | **CONCLUÍDA — validada com fluxo real** | Pacote em `estudio_anuncios_pacotes_exportacao` montado **exclusivamente** da versão aprovada de cada canal. Canal sem aprovação entra como não exportável — **zero fallback**. Idempotente por `hash_conteudo` (sha256 do conjunto aprovado): regerar sem mudança reaproveita o pacote; trocar a aprovação cria um novo e preserva o anterior. **Não publica, não gera arquivo, não chama serviço externo.** 23 testes; `tsc` limpo. |
| Camada editorial (edição/aprovação/versionamento) | **CONCLUÍDA — validada com fluxo real** | Histórico editorial humano em `estudio_anuncios_conteudo_versoes`, **append-only** e por marketplace. Versão 1 nasce lazily do snapshot de `adaptacao_marketplace`; editar cria N+1; aprovar é ação separada com troca atômica (no máximo 1 aprovada por canal, garantido por índice único parcial). Autor e aprovador vêm sempre da sessão. **A Fase 1 é intocável:** nenhuma escrita em `resultados_pipeline`, jobs, Pipeline, score ou imagens. 30 testes; `tsc` limpo. |
| UI de resultado do projeto | **CONCLUÍDA — leitura, validada com dado real** | Tela de detalhe exibe score (fonte oficial `resultados_pipeline/calculo_score`, **nunca** a tabela legada), conteúdo final, revisão antes/depois, versão por marketplace, galeria de imagens com URL assinada de curta duração, análise visual separada em confirmado/não confirmado, custo estimado por etapa e o histórico técnico. Só leitura: sem edição, aprovação, regeneração, exportação ou download. Reusa o MESMO GET já existente — nenhum endpoint paralelo, nenhuma query Supabase no client. 31 testes; `tsc` limpo. |
| Pendências (perguntas objetivas ao usuário) | **Não iniciado** | Tabela `estudio_anuncios_pendencias` existe; etapa `manual` no catálogo; nenhuma tela nem lógica de servidor implementada. |
| Exportação | **Não iniciado** | Etapa `condicional` e **inativa** (`ativa=false`) no catálogo; tabela `estudio_anuncios_pacotes_exportacao` existe, sem código. |
| Biblioteca de Produtos / Biblioteca de Prompts (reaproveitamento) | **Não iniciado** | Tabelas existem (`central_ia_biblioteca_produtos*`, uso de `central_ia_prompts` como registro histórico); nenhuma tela ou fluxo de reaproveitamento implementado. |
| UI (Central de IA) | **Parcialmente concluído** | Dashboard (`central-ia/page.tsx`), listagem, criação (com upload real) e detalhe (com polling, progresso, botão "Iniciar geração" bloqueado sem foto) implementados. Não há tela de revisão/aprovação de conteúdo, imagens, vídeo, pendências ou exportação — natural, já que essas etapas ainda não produzem resultado real. |

---

## 3. Arquitetura atual

**Pipeline** — 1 linha por projeto em `estudio_anuncios_pipeline`
(`status`, `etapa_atual`, `job_atual_id`, `versao_catalogo` travada na
criação). Nunca é escrito por `UPDATE` solto da aplicação — toda transição
passa pelas RPCs atômicas (seção 5). O catálogo de etapas
(`estudio_anuncios_pipeline_catalogo` + `..._catalogo_jobs`) é a única
fonte de verdade sobre "o que vem depois de quê"; TypeScript
(`lib/estudio-anuncios/pipeline/catalogo.ts`) só lê, nunca decide.

**Worker** (`scripts/estudio-anuncios-worker.mjs`) — processo Node
independente, sem `tsx`/framework, execução única por invocação (roda,
processa no máximo 1 job, encerra). Reivindica atomicamente via
`claim_next_estudio_anuncios_job()` (`FOR UPDATE SKIP LOCKED`, incrementa
`tentativas` no mesmo passo), chama a rota interna via HTTP puro, nunca
importa `.ts` diretamente. Precisa estar rodando manualmente
(`node scripts/estudio-anuncios-worker.mjs`) — não há processador de
produção/cron configurado.

**Rota interna** (`app/api/internal/estudio-anuncios/executar/route.ts`) —
protegida por segredo estático (`x-worker-secret`, nunca pelo cookie de
sessão). Regra central: esta rota **nunca decide a sequência do
Pipeline** — só valida, marca início de execução, chama o executor, e
então chama **exatamente uma** das duas RPCs atômicas de conclusão/falha.

**Executor** (`lib/estudio-anuncios/executar-job.ts`) — resolve o handler
da etapa via o **Registry**, confere `provedoresPermitidos`, executa,
registra prompt/consumo (idempotentes por `job_id`) e, quando aplicável,
o resultado estruturado em `estudio_anuncios_resultados_pipeline`. Nunca
lança para o caminho de erro esperado — devolve `{sucesso, erro}`
classificado.

**Registry** (`lib/estudio-anuncios/executores/registry.ts`) — única peça
que decide *como* uma etapa é executada. `HANDLERS_ESPECIFICOS` (hoje:
`analise_visual`, `geracao_conteudo`) vs. `ETAPAS_FAKE_GENERICAS` (as
outras 6). Validação de boot garante que nenhuma etapa está nos dois
conjuntos ao mesmo tempo.

**AI Gateway** — `lib/ai-gateway/roteamento.ts` (`decidirProvedor()`,
`decidirTipoPrompt()`), `lib/ai-gateway/cliente.ts` (gateway 100% fake,
recusa-se a rodar se `decidirProvedor()` devolver algo diferente de
`"fake"`), `lib/ai-gateway/registro.ts` (grava
`central_ia_prompts`/`central_ia_consumo`/`estudio_anuncios_resultados_pipeline`,
todos idempotentes por `job_id`), `lib/ai-gateway/provedores/google.ts`
(cliente real do Gemini via `@google/genai`, `Interactions API`, com
`chamarGeminiComImagens()` e `chamarGeminiTexto()` paralelas, mapeamento
de erro estrutural para as 6 categorias de `erro_tipo`).

**RPCs** — ver seção 5. Todas `SECURITY INVOKER`, `search_path` fixo,
restritas a `service_role` (nunca chamáveis pela chave `anon`).

**Storage** — bucket privado `estudio-anuncios-originais` (10MB/arquivo,
JPEG/PNG/WebP), usado por `lib/estudio-anuncios/storage.ts`. MIME real
detectado por assinatura de bytes (nunca `file.type` do cliente). Nunca
gera URL pública — só assinada, sob demanda, nunca persistida no banco.

**Resultado do Pipeline** (`estudio_anuncios_resultados_pipeline`) —
tabela genérica (1 linha por `job_id`, `UNIQUE(job_id)`, nunca `UPDATE`)
para o resultado estruturado real de qualquer etapa. Só `analise_visual`
e `geracao_conteudo` gravam aqui hoje. `schema_versao` versiona o
contrato JSON por etapa, decidido pelo servidor, nunca pela IA.

**Prompt/Consumo** (`central_ia_prompts`/`central_ia_consumo`) — 1 registro
de cada por `job_id` (índice único parcial em ambas), histórico de todo
prompt enviado e todo consumo (tokens/custo) gerado, real ou fake.

**Fluxo completo (feliz)**: usuário cria o Projeto Mestre (RPC atômica) →
envia 1-10 fotos (Storage + banco) → clica "Iniciar geração" (RPC
`estudio_anuncios_pipeline_iniciar`, exige ≥1 foto) → Worker reivindica o
job de `analise_visual` → rota interna executa via Registry → RPC
`concluir_job` avança o Pipeline atomicamente → Worker reivindica o
próximo job (`geracao_conteudo`, depois `revisao_claude`,
`adaptacao_marketplace`, `geracao_prompts_imagem`, `geracao_imagem`,
`calculo_score`) → Pipeline conclui. Cada etapa exige uma nova execução
manual do Worker (sem loop) até implantação de um processador contínuo.

---

## 4. Migrations existentes

Todas em `supabase/migrations/`, ordem cronológica. Confirmado **executadas
e validadas** (via o fluxo estabelecido de "eu escrevo o SQL, o usuário
executa no Supabase SQL Editor e cola o resultado literal antes de eu
prosseguir") — evidência: cada uma foi seguida, na conversa, de uma etapa
de teste real (RPC via SQL puro e/ou E2E do Worker) que só funciona se a
migration anterior já estivesse aplicada. **Nenhuma migration deste módulo
está pendente de execução.**

| Migration | O que faz |
|---|---|
| `20260803_central_ia_estudio_anuncios_schema.sql` | Schema completo da Fase 0: 18 tabelas (6 `central_ia_*` + 12 `estudio_anuncios_*`) + `claim_next_estudio_anuncios_job()`. Base de tudo o que veio depois. |
| `20260804_criar_projeto_estudio_anuncios_rpc.sql` | RPC `criar_projeto_estudio_anuncios()` — cria Projeto Mestre + N adaptações por marketplace, atomicamente. Restrita a `service_role`. |
| `20260805_estudio_anuncios_pipeline_schema.sql` | 3 tabelas do Pipeline Orchestrator: `estudio_anuncios_pipeline`, `..._pipeline_catalogo`, `..._pipeline_catalogo_jobs` (+ seed do catálogo `versao_catalogo=1`). |
| `20260805_estudio_anuncios_pipeline_rpcs.sql` | RPCs `estudio_anuncios_pipeline_avancar()` e `..._registrar_falha()` — decisão de avanço/retry, não tolerantes a chamada fora de ordem (lançam exceção explícita). |
| `20260806_central_ia_prompts_job_id.sql` | `central_ia_prompts.job_id` (nullable, índice único parcial) + índice único parcial equivalente em `central_ia_consumo.job_id` — fecha a janela de duplicidade de registro por job. |
| `20260806_estudio_anuncios_pipeline_rpcs_atomicas.sql` | Cria a 1ª versão de `estudio_anuncios_pipeline_concluir_job()`/`_falhar_job()` (2/4 argumentos) — **substituída ainda no mesmo dia** pela migration seguinte. |
| `20260806_corrigir_provedor_jobs_pipeline.sql` | Corrige `chk_jobs_provedor_definido` (provedor só obrigatório quando `status='concluido'`, não em qualquer status ≠ `'pendente'`) e **substitui** `concluir_job`/`falhar_job` pelas versões finais (3/5 argumentos, `p_provedor`). |
| `20260807_estudio_anuncios_iniciar_pipeline_rpc.sql` | RPC `estudio_anuncios_pipeline_iniciar()` — cria Pipeline + 1º job atomicamente, idempotente. **Substituída** pela migration seguinte. |
| `20260808_estudio_anuncios_imagens_origem_add_mime.sql` | `estudio_anuncios_imagens_origem` ganha `mime_type`/`nome_original`. |
| `20260809_estudio_anuncios_resultados_pipeline.sql` | Tabela `estudio_anuncios_resultados_pipeline` — resultado estruturado real, genérica por etapa, `UNIQUE(job_id)`. |
| `20260810_estudio_anuncios_pipeline_exigir_foto.sql` | **Substitui** `estudio_anuncios_pipeline_iniciar()` — adiciona a exigência de ≥1 foto original antes de criar o Pipeline (bug real corrigido: era possível iniciar sem foto e só falhar depois, dentro do executor). |
| `20260811_estudio_anuncios_job_origem_id.sql` | `estudio_anuncios_jobs.job_origem_id` (rastreabilidade de qual job de `analise_visual` originou um job de `geracao_conteudo`) + **substitui** `estudio_anuncios_pipeline_avancar()` para popular essa coluna na criação do job de `geracao_conteudo`. |
| `20260831_publicacao_mercado_livre.sql` | **Tabela nova** `estudio_anuncios_publicacoes` + a TRAVA de publicação única. **Não grava em `anuncios`:** a auditoria mostrou que aquela tabela é a calculadora de custo/margem alimentada pelo Worker de sync (1.579 linhas, todas com `ml_item_id`, colunas NOT NULL de custo) — gravar lá exigiria **inventar custos**. Esta responde a pergunta que nenhuma tabela respondia: qual projeto criou qual item. Append-only, com `UNIQUE` parcial em `projeto_marketplace_id` cobrindo `em_andamento`/`publicado`/`publicacao_incerta` — `falha` fica de fora porque 4xx prova que nada foi criado. Duas RPCs: **reservar** (roda ANTES do `POST /items`; é a proteção real contra duplo clique) e **concluir** (único UPDATE, só a partir de `em_andamento`). CHECK anti-credencial e CHECK que recusa `publicado` sem `ml_item_id`. Aplicada e verificada em 2026-08-31. |
| `20260830_pictures_mercado_livre.sql` | **Tabela nova** `estudio_anuncios_pictures_marketplace` — a auditoria das 18 tabelas do módulo mostrou que nenhuma guardava identificador de recurso criado do lado do marketplace. Mapa **append-only** `(loja_id, imagem_gerada_id, checksum_sha256) → ml_picture_id`, com `UNIQUE` nas três partes. **O checksum está na chave de propósito:** sem ele, trocar os bytes mantendo o mesmo id reaproveitaria um picture id que aponta para a imagem antiga no CDN. CHECK anti-credencial no metadado. RPC `estudio_anuncios_registrar_picture_ml` — INSERT puro com `ON CONFLICT DO NOTHING` que devolve sempre a linha VENCEDORA, permitindo ao chamador detectar upload órfão em concorrência. Aplicada e verificada em 2026-08-30. |
| `20260828_embalagem_inteiros.sql` | **Muda o DOMÍNIO** das quatro medidas de embalagem para `INTEGER` — o Mercado Livre só aceita inteiro nos `SELLER_PACKAGE_*` (confirmado por `/items/validate`). **Não arredonda nada:** um bloco `DO` recusa rodar (`EMBALAGEM_DECIMAL_PERSISTIDO`) se encontrar decimal gravado, em vez de decidir sozinha o que fazer com dado alheio — a auditoria prévia mostrou 27 linhas, 1 com embalagem, **0 decimais**, e o único projeto envolvido é de teste (`cancelado`). Os parâmetros da RPC seguem `NUMERIC` **de propósito**: com `INTEGER`, o Postgres converteria 13.5 em 14 no cast, que é exatamente o arredondamento silencioso que se quer evitar; assim a função recusa com `EMBALAGEM_VALOR_NAO_INTEIRO`. Sem `DROP FUNCTION` (assinatura preservada). Aplicada e verificada em 2026-08-28. |
| `20260827_dados_logisticos_embalagem.sql` | **Aditiva** em `projetos_marketplace`: `embalagem_peso_g`, `embalagem_altura_cm`, `embalagem_largura_cm`, `embalagem_comprimento_cm` (todas `NUMERIC(10,2)`) e `embalagem_atualizada_em`. **Nas unidades que a API do ML declara** (`allowed_units`: `cm` para dimensões, `g` para peso) — assim **não há conversão em lugar nenhum** e não há onde perder precisão. `chk_pm_embalagem_positiva` rejeita zero e negativo: é invariante NOSSO e estável, ao contrário dos enums do ML, que continuam sem CHECK. RPC própria `estudio_anuncios_salvar_embalagem` (`SECURITY INVOKER`, `EXECUTE` só para `postgres`/`service_role`), separada pelo mesmo motivo da de `family_name`: reescrever a RPC de configuração exigiria `DROP`. **Nenhuma coluna de peso/medida do PRODUTO é lida por ela.** Aplicada e verificada em 2026-08-27. |
| `20260826_user_products_ml.sql` | **Aditiva** em `projetos_marketplace`: `modelo_publicacao` (CHECK `user_products`/`legacy` — enum NOSSO, não do ML), `modelo_verificado_em`, `conta_tags` (snapshot datado que sustenta a decisão) e `family_name`. **Sem CHECK de tamanho no `family_name`**: o limite é o `max_title_length` da categoria e vem da API. Duas RPCs: `salvar_modelo_publicacao` e `salvar_family_name` (recusa string vazia; NULL limpa). A segunda é separada de propósito — reescrever a RPC de configuração exigiria `DROP`, operação destrutiva sem justificativa. Aplicada e verificada em 2026-08-26. |
| `20260825_validacao_oficial_ml.sql` | **Aditiva** + 1 tabela nova. Em `projetos_marketplace`: `loja_id` (FK `lojas`), `loja_vinculada_em`, `tipos_anuncio_disponiveis` (os que a CONTA permite, só obteníveis com OAuth). Tabela **`estudio_anuncios_validacoes_publicacao`**: append-only, UNIQUE `(projeto_marketplace_id, hash_payload)`, CHECK de status (`validado`/`validado_com_alertas`/`bloqueado`/`erro_comunicacao` — **nenhum se chama `publicado`**) e **CHECK anti-credencial** que recusa qualquer texto com token. Três RPCs: vínculo (recusa loja de outro usuário/marketplace/inativa **no banco**), gravação dos tipos da conta e registro da validação (`FOR UPDATE`, idempotente, INSERT puro). Aplicada e verificada em 2026-08-25. |
| `20260824_projetos_marketplace_publicacao.sql` | **Aditiva** em `estudio_anuncios_projetos_marketplace`: `category_id`, `categoria_nome/caminho/settings/atributos/verificada_em`, `condicao`, `tipo_anuncio_id`, `moeda`, `preco_centavos` (BIGINT), `estoque`, `atributos_marketplace` (JSONB), autor e data. **Preço não reusa `anuncios`**: a auditoria mostrou que as 1.533 linhas de lá têm `ml_item_id`, ou seja, só contêm anúncios **já publicados**, sem nenhum vínculo com projetos do Estúdio — e **estoque não existe em tabela alguma** do CDS. CHECKs só para invariante estável (`preco > 0`, `estoque >= 0`, categoria sempre com snapshot, atributos como array); **nenhum CHECK congela enum externo** do ML, que muda sem aviso — condição e moeda são validadas contra a API. RPC `estudio_anuncios_salvar_publicacao_marketplace` com `FOR UPDATE`, PATCH parcial por `coalesce` e recusa a gravar categoria sem snapshot. Aplicada e verificada em 2026-08-24. |
| `20260823_compliance_marketplace.sql` | **Tabela nova** `estudio_anuncios_compliance_marketplace` — a auditoria das 16 tabelas do módulo mostrou que nenhuma responde à pergunta desta camada (editorial = o que foi aprovado; pacotes = o que foi congelado; `resultados_pipeline` = saída de IA com `UNIQUE(job_id)`). **Append-only:** regras mudam, e "por que isto foi publicável em agosto?" só tem resposta se o parecer daquela data sobreviver. UNIQUE `(projeto_id, marketplace, hash_entrada)` — o hash inclui **`versao_regras`**, então subir a versão invalida os pareceres anteriores. CHECKs de status, marketplace e da relação `nao_implementado ⇔ versao_regras = 0`. RPC `estudio_anuncios_registrar_compliance`: `FOR UPDATE` no projeto, recusa canal de outro projeto, INSERT puro. Aplicada e verificada em 2026-08-23. |
| `20260822_pacotes_exportacao_arquivo.sql` | **Aditiva.** Acrescenta `bucket`, `mime_type`, `tamanho_bytes`, `checksum_sha256` (sha256 dos **bytes do arquivo** — não confundir com `hash_conteudo`, que identifica o conjunto aprovado), `materializado_em` e `materializado_por`; CHECK que impede `storage_path` preenchido com metadado faltando; unique em `storage_path` (um objeto pertence a no máximo um pacote). RPC `estudio_anuncios_registrar_arquivo_pacote`: trava o pacote (`FOR UPDATE`), é idempotente para o mesmo caminho, **lança** se o pacote já aponta para outro arquivo (nunca reaponta em silêncio, o que orfanaria o objeto anterior) e tem lista de SET que **não inclui** hash/itens/número/status. Aplicada e verificada em 2026-08-22. |
| `20260821_pacotes_exportacao.sql` | **Aditiva** em `estudio_anuncios_pacotes_exportacao` (tabela existia desde 20260803, **vazia e sem nenhum código**) + 1 RPC atômica. Adiciona `numero_pacote`, `hash_conteudo`, `status` (`gerado`/`parcial`) e `gerado_por`; unique **(projeto_id, hash_conteudo)** — a idempotência é do banco, não da aplicação — e unique de numeração. RPC `estudio_anuncios_gerar_pacote_exportacao`: trava o projeto (`FOR UPDATE`), devolve o pacote existente quando o hash já foi exportado, numera monotonicamente e é **INSERT puro** (nunca UPDATE, nunca apaga). Aplicada e verificada em 2026-08-21. |
| `20260820_conteudo_versoes_editorial.sql` | **Aditiva** em `estudio_anuncios_conteudo_versoes` + 2 RPCs atômicas. Adiciona `criado_por`, `aprovado_por`, `request_id` (idempotência de duplo clique) e `resultado_pipeline_origem_id` (responde "esta versão nasceu de qual saída da IA", sem depender de timestamp); amplia o CHECK de `origem` com `ia_adaptacao_marketplace` **preservando os 3 valores legados**; cria índice único parcial de **uma aprovada por canal**. RPCs `estudio_anuncios_criar_versao_conteudo` (numera sob concorrência com `FOR UPDATE`, materializa a v1 lazily, idempotente por `request_id`) e `estudio_anuncios_aprovar_versao_conteudo` (troca a aprovada atomicamente). Aplicada e verificada em 2026-08-20. |
| `20260818_consumo_tokens_saida_imagem.sql` | **Aditiva** em `central_ia_consumo`: adiciona `tokens_saida_imagem` (nullable) + CHECK de coerência. Existe porque `gemini-3.1-flash-image` cobra a saída em **duas taxas** ($3 texto / $60 imagem por 1M): sem a fatia de imagem gravada, `custo_estimado` deixaria de ser re-derivável a partir da própria linha. NULL = modelo de saída única. Aplicada e verificada em 2026-08-18. |
| `20260817_calculo_score_job_origem.sql` | **Substitui** `estudio_anuncios_pipeline_avancar()` — popula `job_origem_id` de `calculo_score` com o job de `geracao_imagem` (último artefato obrigatório antes do score). As demais fontes do score **não** são buscadas às cegas: saem de referências embutidas nos próprios envelopes, encadeadas a partir daí. Exatamente 1 candidato; >1 levanta `ORIGEM_AMBIGUA`. Última transição da Fase 1 — depois dela o Pipeline fecha pelo caminho que já existia, sem criar job novo. Aplicada e verificada com `pg_get_functiondef()` em 2026-08-17. |
| `20260816_imagens_geradas_rastreabilidade.sql` | **Aditiva** em `estudio_anuncios_imagens_geradas`: adiciona `job_id`, `prompt_ordem`, `mime_type`, `largura_px`, `altura_px`, `tamanho_bytes`, `provedor`, `modelo`; CHECKs de MIME/dimensões/provedor; e **três índices únicos** — `(job_id, prompt_ordem)` (idempotência e concorrência garantidas no banco, não só em TypeScript), `storage_path`, e o já existente de principal. Nenhuma coluna removida, nenhuma constraint derrubada. Corrige a colisão real do unique `(projeto_id, finalidade, numero_versao)` quando o job produz duas imagens da mesma finalidade — resolvida atribuindo `numero_versao` como índice 1-based dentro da finalidade. Aplicada e verificada em 2026-08-16. |
| `20260816_geracao_imagem_job_origem.sql` | **Substitui** `estudio_anuncios_pipeline_avancar()` — no branch intra-etapa, popula `job_origem_id` de `geracao_imagem` com o job de `geracao_prompts_imagem`. Aqui o job anterior na fila **é** a origem semântica, porque o artefato consumido é o próprio `EnvelopeGeracaoPromptsImagem`. Fotos originais entram como referência visual, mas referência não é artefato consumido — `job_origem_id` continua sendo um só. Exatamente 1 candidato; >1 levanta `ORIGEM_AMBIGUA`; 0 deixa `NULL`. Sem ordenação por tempo. Não generaliza para `calculo_score`. Aplicada e verificada com `pg_get_functiondef()` em 2026-08-16. |
| `20260815_geracao_prompts_imagem_job_origem.sql` | **Substitui** `estudio_anuncios_pipeline_avancar()` — no branch **entre etapas amplas**, popula `job_origem_id` de `geracao_prompts_imagem` com o job de `analise_visual` do projeto. Primeira transição em que o job anterior na fila (`adaptacao_marketplace`) **não** é a origem semântica: quem produz o artefato consumido é a análise visual, não o conteúdo comercial. Resolução por `JOIN` com `resultados_pipeline`, exigindo exatamente 1 candidato; >1 levanta `ORIGEM_AMBIGUA`; 0 deixa `NULL`. Sem ordenação por tempo. Não generaliza `geracao_prompts_imagem → geracao_imagem`. Aplicada e verificada com `pg_get_functiondef()` em 2026-08-15. |
| `20260814_revisao_claude_job_origem.sql` | **Substitui** `estudio_anuncios_pipeline_avancar()` — popula `job_origem_id` para `revisao_claude` (aponta para `geracao_conteudo`) e promove `revisao_claude` a origem de `adaptacao_marketplace`, com **precedencia** sobre `geracao_conteudo`. Cada tentativa exige exatamente 1 candidato; >1 levanta `ORIGEM_AMBIGUA`; 0 em ambas deixa `NULL`. Sem ordenacao por tempo. Aplicada e verificada em 2026-08-14. |
| `20260813_adaptacao_marketplace_job_origem.sql` | **Substitui** `estudio_anuncios_pipeline_avancar()` — no branch intra-etapa, e só quando a próxima subetapa é `adaptacao_marketplace`, popula `job_origem_id` com o job de `geracao_conteudo` que produziu o artefato consumido. Resolução por `JOIN` com `resultados_pipeline`, sem ordenação; >1 candidato levanta `ORIGEM_AMBIGUA`; 0 candidatos deixa `NULL` (caminho fake). Nenhuma outra transição intra-etapa foi alterada. Aplicada e verificada com `pg_get_functiondef()` em 2026-08-13. |
| `20260812_preservar_erro_no_retry.sql` | **Substitui** `estudio_anuncios_pipeline_registrar_falha()` — o `UPDATE` do job no branch de retry deixou de zerar `erro_tipo`/`erro_mensagem`. Corrige perda permanente da causa de toda tentativa não-final. Semântica de retry inalterada. Aplicada e verificada com `pg_get_functiondef()` em 2026-08-12. |

Nota: como o Postgres não versiona funções por "migration de origem", o
estado real no banco de `estudio_anuncios_pipeline_concluir_job`,
`_falhar_job`, `_iniciar` e `_avancar` é sempre o da **última** migration
que os recriou (`CREATE OR REPLACE`) — ver seção 5 para a assinatura
final de cada uma.

---

## 5. RPCs existentes

Todas `SECURITY INVOKER`, `search_path=public` fixo, `REVOKE ... FROM
PUBLIC, anon, authenticated` + `GRANT ... TO service_role` — nunca
chamáveis pela chave `anon`/pelo browser, só por um cliente
`service_role` server-only, sempre depois da rota já ter validado sessão
e propriedade.

| RPC | Responsabilidade | Depende de |
|---|---|---|
| `claim_next_estudio_anuncios_job()` | Reivindica atomicamente o próximo job `pendente` com `tentativas < max_tentativas` (`FOR UPDATE SKIP LOCKED`), incrementa `tentativas` e marca `rodando` no mesmo passo. Chamada só pelo Worker. | `estudio_anuncios_jobs` |
| `criar_projeto_estudio_anuncios(7 args)` | Cria 1 Projeto Mestre + N adaptações por marketplace, atomicamente, com validação própria (não confia só em TypeScript). | `estudio_anuncios_projetos`, `..._projetos_marketplace` |
| `estudio_anuncios_pipeline_iniciar(p_projeto_id)` *(versão final: 20260810)* | Cria Pipeline + 1º job atomicamente; idempotente; lock `FOR UPDATE` no projeto; rejeita projeto cancelado/concluído/sem foto. `RETURNS TABLE` com `criado_agora`. | `estudio_anuncios_pipeline`, `..._pipeline_catalogo*`, `..._imagens_origem` |
| `estudio_anuncios_pipeline_avancar(pipeline_id, job_id)` *(versão final: 20260811)* | Decide e cria o próximo job (mesma etapa ampla ou próxima obrigatória) ou conclui o Pipeline. Popula `job_origem_id` ao criar o 1º job de `geracao_conteudo`. Lança exceção explícita se chamada fora de ordem (`job_atual_id` divergente ou `status != em_execucao`) — nunca no-op silencioso. | `estudio_anuncios_jobs`, catálogo |
| `estudio_anuncios_pipeline_registrar_falha(pipeline_id, job_id, erro_tipo, erro_mensagem)` *(versão final: 20260812)* | Reenvia o job para `pendente` (se ainda há tentativa) ou marca o Pipeline em erro (tentativas esgotadas). Mesma disciplina de erro explícito de `_avancar`. **Desde 20260812 o retry PRESERVA `erro_tipo`/`erro_mensagem` do job** — só o Pipeline tem o erro próprio limpo, porque enquanto há tentativa ele não está em erro. | `estudio_anuncios_jobs` |
| `estudio_anuncios_pipeline_concluir_job(pipeline_id, job_id, p_provedor)` *(versão final: 20260806_corrigir_provedor)* | Marca o job `concluido` (com `provedor` obrigatório) e chama `_avancar()` internamente, na mesma transação. | `_avancar`, `estudio_anuncios_jobs` |
| `estudio_anuncios_pipeline_falhar_job(pipeline_id, job_id, erro_tipo, erro_mensagem, p_provedor)` *(versão final: 20260806_corrigir_provedor)* | Marca o job `erro` (`provedor` opcional, nunca apaga um já gravado — `COALESCE`) e chama `_registrar_falha()` internamente, na mesma transação. | `_registrar_falha`, `estudio_anuncios_jobs` |

`estudio_anuncios_pipeline_avancar()`/`_registrar_falha()` continuam
existindo como primitivas internas — a aplicação (rota interna) usa
**exclusivamente** as duas RPCs atômicas (`concluir_job`/`falhar_job`)
para mudar status de job, nunca as duas primeiras diretamente.

---

## 6. Contratos congelados

**`AnaliseVisualIA`** (`lib/ai-gateway/provedores/google-tipos.ts`) — o que
o Gemini devolve para `analise_visual`. 16 campos de nível raiz:
`produtoIdentificado`/`marca`/`modelo` (string|null),
`categoriaProvavel` (array de string, hierarquia — nunca string
concatenada), `resumoVisual` (string), `caracteristicasVisiveis`/`cores`/
`materiais`/`componentes`/`textosLegiveis`/`possiveisUsos`/
`publicoProvavel` (arrays de item + `origem`), `quantidadeDeclarada`
(`{valor, textoOrigem}`, os dois sempre juntos ou os dois `null`),
`alertas`/`informacoesNaoConfirmadas` (array de string),
`qualidadeDasFotos` (`{nota 0-100, problemas[], sugestoes[]}`),
`atributosAdicionais` (`{nome, valor, origem}[]`).
`AnaliseVisualCompleta` estende isso com `fotosAnalisadas`/
`metadadosAnalise`, montados 100% pelo servidor, nunca pedidos à IA.

**`OrigemAtributo`** — 4 valores possíveis em todo item de lista acima:
`"produto"` | `"embalagem_fisica"` | `"material_promocional"` |
`"indeterminado"`. Nunca confundir produto com embalagem é a regra mais
importante do prompt.

**`CampoOrigem`** (também em `google-tipos.ts`) — os 12 campos de
`AnaliseVisualIA` que servem de fonte de fato citável para
`geracao_conteudo`: `produtoIdentificado`, `marca`, `categoriaProvavel`,
`caracteristicasVisiveis`, `cores`, `materiais`, `componentes`,
`textosLegiveis`, `quantidadeDeclarada`, `possiveisUsos`,
`publicoProvavel`, `atributosAdicionais`. Derivado via `keyof Pick<...>`
(nunca lista copiada à mão). **`publicoProvavel` foi incluído aqui por
decisão explícita — ver seção 9, divergência com o contrato de texto.**

**`OrigemFatoEntrada`** (`lib/estudio-anuncios/geracao-conteudo-tipos.ts`)
— subconjunto de `OrigemAtributo` que pode virar fato citável:
`"produto" | "embalagem_fisica"`. `material_promocional`/`indeterminado`
nunca chegam a isso — vão para `contextoPromocional`/`informacoesProibidas`
antes.

**`EntradaSeguraGeracaoConteudo`** — o que é de fato apresentado ao Gemini
em `geracao_conteudo`, persistido junto do resultado: `fatosPermitidos`
(`FatoPermitido[]`, IDs `F1,F2,...`), `descricoesComRessalva`
(`DescricaoComRessalva[]`, IDs `R1,R2,...`), `informacoesProibidas`
(string[], nunca citável), `contextoPromocional` (string[], nunca
citável), `alertas` (cópia direta de `analise_visual.alertas`),
`fatosAfetadosPorAlerta` (metadado server-side de rebaixe/exclusão).

**`GeracaoConteudoIA`** — o que o Gemini devolve para `geracao_conteudo`.
`tituloBase`/`descricaoCurta` são os **2 únicos campos obrigatórios**
(texto nunca vazio); `bullets`/`descricaoLonga`/`especificacoes`/
`publicoSugerido` são genuinamente omissíveis (chave ausente, nunca
array/objeto vazio). `tituloBase`/`especificacoes`/`publicoSugerido` só
aceitam `fatoIds`/`fatoId` começando com `"F"` (nunca `"R"`);
`descricaoCurta`/`bullets`/`descricaoLonga` podem citar `"R"`, mas só se
`contemRessalva=true`. Validação primária: `validarIntegridadeFatoIds()`
(`lib/estudio-anuncios/geracao-conteudo.ts`) — ID inexistente, `fatoIds`
vazio, `R*` fora de lugar ou `contemRessalva` incoerente = rejeição
(`erro_tipo="conteudo_rejeitado"`).

**`EnvelopeGeracaoConteudo`** — o que é de fato persistido em
`estudio_anuncios_resultados_pipeline.resultado` para esta etapa:
`{fonteAnaliseVisual: {jobId, resultadoId, schemaVersao}, entrada:
EntradaSeguraGeracaoConteudo, saida: GeracaoConteudoIA}`.

**`ResultadoPipeline`** (linha de `estudio_anuncios_resultados_pipeline`)
— `{id, projeto_id, job_id, etapa, provedor, modelo, schema_versao,
resultado: jsonb, criado_em}`. `UNIQUE(job_id)`. `etapa` exclui
propositalmente `"ping"` (etapa de teste de infraestrutura, nunca produz
resultado de domínio).

**`schema_versao`** — inteiro `>0`, por linha, decidido pelo **servidor**
(nunca pelo modelo de IA), nunca lido de env/config. Hoje:
`SCHEMA_VERSAO_ANALISE_VISUAL=1`, `SCHEMA_VERSAO_GERACAO_CONTEUDO=1`
(constantes independentes, nunca um contador global compartilhado).

---

## 7. Decisões arquiteturais congeladas

- **Registry de handlers, não `if/else` único.** Extraído de dentro de
  `executar-job.ts` (2026-08-11) para permitir que cada etapa tenha
  comportamento próprio sem inflar um único arquivo — motivo: preparar o
  terreno para `geracao_conteudo` real sem repetir o padrão ad-hoc que já
  existia para `analise_visual`.
- **Handler fake genérico compartilhado**, nunca um handler fake por
  etapa — as 6 etapas ainda-fake têm comportamento observável idêntico
  (mesmo `chamarIA()` fake), então usar 1 objeto só evita duplicação sem
  nenhuma perda de flexibilidade futura (cada uma pode ganhar handler
  próprio a qualquer momento, movendo do Set para o Record).
- **`provedoresPermitidos` por handler**, checado no executor **antes**
  de qualquer chamada de IA. Motivo: pega erro de configuração/roteamento
  (`decidirProvedor()` devolvendo algo que o handler não sabe tratar)
  como `validation` determinística, nunca como uma falha obscura no meio
  de uma chamada real.
- **`job_origem_id`** (rastreabilidade explícita, nunca inferida por
  ordenação/timestamp) — `geracao_conteudo` precisa saber exatamente qual
  `analise_visual` a originou; inferir isso por "o job de análise mais
  recente do projeto" seria frágil em qualquer cenário de retry/paralelismo
  futuro.
  **Semântica oficial (congelada em 2026-08-13):** `job_origem_id` aponta
  para o job que produziu o **artefato de domínio efetivamente consumido**
  pela etapa atual — **não** necessariamente o job imediatamente anterior
  na cadeia.
  **Mapa vigente (atualizado em 2026-08-14):** `analise_visual →
  geracao_conteudo`; `geracao_conteudo → revisao_claude`;
  `revisao_claude → adaptacao_marketplace` **com precedência** sobre
  `geracao_conteudo`. A precedência não é fallback silencioso: cada
  tentativa exige exatamente 1 candidato, >1 levanta `ORIGEM_AMBIGUA`, e
  0 em ambas deixa `NULL` (rejeitado explicitamente pelo handler quando o
  provedor é real). Quando `revisao_claude` roda pelo caminho fake ela não
  grava resultado, então o conteúdo-base continua sendo a única fonte
  existente. **Os dois ramos foram validados com execução real:** com a
  flag desligada a adaptação caiu em `geracao_conteudo`; com a Anthropic
  ligada (2026-08-14) a adaptação passou a apontar para `revisao_claude`.
  **Caso mais forte da regra (2026-08-15):** `geracao_prompts_imagem`
  aponta para **`analise_visual`**, e não para `adaptacao_marketplace`,
  que é o job imediatamente anterior na fila. Motivo de segurança, não de
  estilo: a etapa produz instruções do que será *desenhado*, e só
  `analise_visual` classifica cada atributo por `origem` (`produto` /
  `embalagem_fisica` / `material_promocional` / `indeterminado`). Os
  artefatos de conteúdo são texto comercial derivado — usá-los como fonte
  visual **lava** a classificação de origem e abre caminho para alegação
  textual virar elemento visual confirmado.
  **Contraste didático (2026-08-16):** `geracao_prompts_imagem →
  geracao_imagem` **passou a ter vínculo**, e aqui o job anterior na fila
  É a origem semântica — porque o artefato consumido é exatamente o
  `EnvelopeGeracaoPromptsImagem`. As fotos originais entram como
  referência visual, mas referência não é artefato de domínio consumido:
  `job_origem_id` continua sendo um só, nunca vira lista.
  **A regra não é generalizada automaticamente:** cada nova dependência
  semântica é definida quando a etapa real for implementada —
  `calculo_score` segue sem vínculo.
- **Resultado do Pipeline é imutável** (`UNIQUE(job_id)`, nunca `UPDATE`)
  — um resultado divergente na 2ª tentativa do mesmo job é tratado como
  erro de idempotência (`ErroIdempotenciaResultadoPipeline`), nunca
  sobrescrito silenciosamente. Motivo direto: Gemini não é determinístico
  (diferente do Gateway fake), então "o mesmo job gerou 2 resultados
  diferentes" é um sinal real que não pode ser mascarado.
- **`schema_versao` por linha, decidido pelo servidor.** Corrige um
  acoplamento real encontrado em auditoria: antes, uma constante importada
  era usada incondicionalmente ao registrar qualquer resultado — um
  handler novo herdaria a versão errada por engano. Hoje cada `HandlerEtapa`
  declara `versaoSaida` e o executor falha explicitamente se um handler
  produzir resultado estruturado sem declarar essa versão.
- **Sem `UPDATE` solto no Pipeline** — toda transição de
  `estudio_anuncios_pipeline` passa pelas RPCs atômicas (exceto
  `cancelarPipeline()`/`pausarPipeline()`/`retomarPipeline()`, que fazem
  `UPDATE` direto mas só depois de validar a transição contra
  `maquina-estados.ts`).
- **Sem fallback silencioso, em nenhuma camada.** `GOOGLE_AI_ENABLED`/
  `GOOGLE_AI_GERACAO_CONTEUDO_ENABLED` ausentes/inválidos mantêm o
  caminho fake (nunca "tentam" o real); `GOOGLE_AI_MODEL_VISUAL`/
  `_CONTEUDO` ausentes lançam erro `auth` explícito (nunca caem um no
  outro); `GOOGLE_AI_MAX_IMAGES`/`_BYTES` inválidos lançam erro (nunca
  ignoram o valor configurado).
- **Prompt embutido/resumido, nunca o envelope inteiro em
  `resultado_resumo`.** `central_ia_prompts.resultado_resumo` sempre
  recebe um resumo curto e seguro (`montarResumoCurto*()`); o
  JSON completo vive só em `estudio_anuncios_resultados_pipeline`.
- **Entrada segura como camada obrigatória antes de qualquer prompt de
  `geracao_conteudo`.** A IA nunca vê o resultado bruto de
  `analise_visual` — só a entrada já classificada
  (`fatosPermitidos`/`descricoesComRessalva`/`informacoesProibidas`/
  `contextoPromocional`), montada por uma função pura e determinística.
- **IDs `F*`/`R*` opacos, sequenciais, por chamada.** Nunca comparáveis
  entre execuções diferentes; existem só para permitir que a IA cite a
  origem exata de cada afirmação, e para permitir validação
  determinística pós-resposta (`validarIntegridadeFatoIds()`).
- **`material_promocional` nunca vira fato**, mesmo que pareça técnico —
  vai para `contextoPromocional`, citável só como contexto de marketing,
  nunca como confirmação de atributo do produto.
- **`categoriaProvavel` é array (hierarquia), nunca string concatenada.**
  Decisão baseada em evidência real (4 análises auditadas — a IA já
  devolvia isso espontaneamente como hierarquia).
- **Domínio de `geracao_conteudo` vive em `lib/estudio-anuncios/`, nunca
  em `lib/ai-gateway/provedores/google-*`** — exceção consciente única:
  `CampoOrigem` vive em `google-tipos.ts` porque descreve a estrutura de
  `AnaliseVisualIA` (outro contrato), não algo de `geracao_conteudo`.
- **Nova etapa real só entra em `HANDLERS_ESPECIFICOS` como último passo
  atômico**, depois que tipos + schema + entrada segura + handler já
  existem e já passaram por `tsc` limpo — nunca como andaime
  intermediário (aplicado literalmente em `geracao_conteudo`).

---

## 8. Testes já executados

**Migration / Pipeline (SQL puro, contra o banco real)**
- Todas as 12 migrations da seção 4: validadas por leitura pós-execução
  (colunas, constraints, índices, permissões) — resultado: **todas
  corretas**.
- `estudio_anuncios_pipeline_avancar()` com `job_origem_id`: teste
  isolado ponta a ponta (criar projeto/job/pipeline de teste → concluir
  via RPC real → verificar `job_origem_id` populado → simular falha e
  retry → verificar `job_origem_id` preservado). Descoberta no processo:
  passo manual faltante (`aguardando→em_execucao`) — não era bug,
  documentado. Resultado: **passou**, resíduo de teste neutralizado
  (não apagado).
- Teste de idempotência/concorrência/projeto cancelado-concluído/segurança
  (401/400/404) de `estudio_anuncios_pipeline_iniciar()`: **passou** em
  todos os cenários.

**Worker / E2E real (Gateway fake)**
- Ciclo completo de 7 jobs (`analise_visual` → `geracao_conteudo` →
  `revisao_claude` → `adaptacao_marketplace` → `geracao_prompts_imagem` →
  `geracao_imagem` → `calculo_score`), 1 por execução do Worker,
  Pipeline concluído ao final. **Passou** — nenhuma chamada real de IA
  neste ciclo (tudo fake).
- `ping` (etapa de teste de infraestrutura): validado ponta a ponta,
  incluindo 5 testes negativos (401/401/404/409/400). **Passou.**

**Upload de fotos / Storage**
- Validado por `tsc --noEmit` limpo + revisão manual de escopo; não há
  registro, neste repositório, de um teste real de upload contra o
  Storage vivo colado de volta (diferente do padrão de outras etapas) —
  **pendência de confirmação**, não falha conhecida.

**Gemini (real)**
- Teste real com **chave inválida**: confirmou o mapeamento de erro
  `auth` (achado registrado: a mensagem de erro do SDK, nesse caso, não
  trazia texto reconhecível de credencial — limitação documentada da
  Interactions API/SDK nesta versão).
- ✅ **`analise_visual` com chave válida e fotos reais: VALIDADO**
  (correção de 2026-08-06, a partir de leitura direta do banco — a versão
  anterior desta seção dizia que não havia evidência, e estava
  desatualizada). Evidência: **5 chamadas reais** registradas em
  `central_ia_consumo` com `provedor=google`/`modelo=gemini-3.6-flash`
  em 2026-08-06 (12:06, 12:48, 12:58, 13:17 e 14:31 UTC), somando
  ~9.249 tokens de entrada / 4.229 de saída e **US$ 0,0496** de custo
  estimado. Uma delas gravou resultado estruturado real em
  `estudio_anuncios_resultados_pipeline`
  (`id=ac5c3468-…`, `job=39415edc-…`, `projeto=bc8b8dc3-…`,
  `schema_versao=1`). Os resumos em `central_ia_prompts` mostram produtos
  reais reconhecidos com hierarquia de categoria (ex.: *"Fone de ouvido
  Bluetooth JBL Tune 720BT (Eletrônicos / Áudio / Fones de Ouvido)"*,
  *"Alicate para Cutículas Mundial Professional 777"*) — ou seja, o
  contrato `AnaliseVisualIA` funciona ponta a ponta contra a API real.
- ✅ **`geracao_conteudo` com Gemini real: VALIDADO em 2026-08-06.**
  Primeira chamada real da etapa em toda a história do módulo — o
  stop-gate da PARTE 2 foi cumprido, não violado.
  **Execução:** projeto de teste `bc8b8dc3-…` ("TESTE_V2_CONTRATO_FINAL 1"),
  job `cb145955-…`, `job_origem_id=39415edc-…` (a `analise_visual` real já
  validada), `gemini-3.6-flash`, 21,1s, **1.283 tokens de entrada / 1.103
  de saída, US$ 0,010197** de custo estimado. Resultado gravado com
  `schema_versao=1`.
  **Resultado central — a dúvida que originou o stop-gate está resolvida:**
  o structured output do Gemini **aceita chave ausente de verdade**. O
  opcional `publicoSugerido` voltou completamente **ausente do JSON** (não
  `null`, não `[]`); os outros 4 opcionais (`bullets`, `descricaoLonga`,
  `especificacoes`, além dos 2 obrigatórios) vieram preenchidos.
  **`GERACAO_CONTEUDO_JSON_SCHEMA` não precisa de nenhum ajuste.**
  **Validações que passaram com dado real, não sintético:**
  `validarEstruturaGeracaoConteudo()` e `validarIntegridadeFatoIds()` —
  ambas rodam dentro do handler, e o job só conclui se as duas passarem.
  Conferido manualmente depois: 12 `fatosPermitidos` (F1–F12) e 1
  `descricaoComRessalva` (R1 = *"Pedra (aparência de jade)"*);
  `tituloBase` citou só `F*` (F3,F9,F10) e `especificacoes` idem — nenhum
  `R*` em campo que não o aceita; os 3 trechos que citaram R1
  (`descricaoCurta`, 1 bullet, 1 parágrafo de `descricaoLonga`) marcaram
  `contemRessalva=true` corretamente, e o texto gerado hedgeou de fato
  (*"aparenta ter tom de jade"*), nunca afirmou jade.
  A ausência de `publicoSugerido` confirma a previsão da seção 7 do
  contrato: `publicoProvavel` caiu em `informacoesProibidas`, logo não
  havia fato citável para o campo.
- ✅ **`adaptacao_marketplace` com Gemini real: VALIDADO em 2026-08-13.**
  Projeto de teste `bc8b8dc3-…`, job `a1f13856-…`,
  `job_origem_id=cb145955-…` (o job de `geracao_conteudo`, resolvido pela
  migration `20260813`), `gemini-3.6-flash`, 10,2s, **1.468 tokens de
  entrada / 1.042 de saída, US$ 0,010017**, `schema_versao=1`.
  **1 job → 2 marketplaces (ML e Shopee) → 1 envelope** — cardinalidade
  aprovada, respeitando `UNIQUE(job_id)`.
  Conferido no resultado real: ambos os marketplaces receberam título,
  descrição, 5 bullets e 6 especificações; **todas as especificações
  idênticas às do conteúdo-base** (nenhum valor alterado); CTA restrito à
  lista server-side (`"Confira os detalhes"` no ML, `"Conheça o produto"`
  na Shopee); nenhuma medida, marca ou quantidade nova; nenhuma promessa
  promocional ou alegação clínica.
  Idempotência verificada contra o banco com as funções reais: reenviar o
  mesmo envelope devolve o mesmo `id` sem duplicar; envelope divergente no
  mesmo `job_id` levanta `ErroIdempotenciaResultadoPipeline` sem
  sobrescrever; prompt e consumo continuam 1 por job.
- ✅ **`revisao_claude` com Anthropic real: VALIDADO em 2026-08-14.**
  Projeto de teste `44e781d5-…`, pipeline `6168e33b-…`, job
  `e638b379-…`. **`provedor=anthropic`, `modelo=claude-opus-5`, 10,8s,
  1.201 tokens de entrada / 835 de saída, US$ 0,02688**, `schema_versao=1`.
  O custo gravado bate exatamente com a fórmula US$ 5 entrada / US$ 25
  saída por 1M — prova de que o modelo está cadastrado em
  `custos.ts` e **não** caiu no caminho de custo 0 com `console.warn`.
  Cadeia real completa numa única execução: `analise_visual` (Google) →
  `geracao_conteudo` (Google) → **`revisao_claude` (Anthropic)** →
  `adaptacao_marketplace` (Google), **US$ 0,046851** no total.
  **Integridade conferida no resultado real:** `especificacoes` e
  `publicoSugerido` idênticos ao conteúdo-base (comparação profunda),
  todos os `fatoIds` preservados, `contemRessalva` preservado, contagem de
  bullets preservada, shape idêntico ao `GeracaoConteudoIA` de origem.
  2 dos 6 trechos revisáveis foram alterados, com `motivo` preenchido
  (ex.: *"Confeccionado nos materiais pedra e metal, apresentando as cores
  verde e dourado."* → *"Confeccionado em pedra e metal, nas cores verde e
  dourado."*) — melhora de redação sem tocar em fato.
  O `resumo` do prompt registrado tem 73 caracteres (não o envelope
  inteiro). **Migração de origem comprovada:** o
  `adaptacao_marketplace` desta execução nasceu com `job_origem_id`
  apontando para **`revisao_claude`**, não para `geracao_conteudo` — a
  precedência da migration `20260814` funciona com dado real.
  Idempotência revalidada contra o banco com as funções reais, agora sobre
  o resultado da Anthropic: mesmo envelope → mesmo `id` sem duplicar;
  envelope divergente no mesmo `job_id` → `ErroIdempotenciaResultadoPipeline`
  **sem sobrescrever** o registro original; prompt e consumo seguem 1 por
  job, com os tokens originais intactos.
- ✅ **`geracao_prompts_imagem` com Gemini real: VALIDADO em 2026-08-15.**
  Projeto de teste `44e781d5-…` (reaproveitado por já ter uma
  `analise_visual` real), job `6147397d-…`, `job_origem_id=27fdee99-…`
  (o job de `analise_visual`, resolvido pela migration `20260815`),
  `gemini-3.6-flash`, 20,4s, **733 tokens de entrada / 773 de saída,
  US$ 0,006897**, `schema_versao=1`. O custo bate exatamente com a
  fórmula US$ 1,5 / US$ 7,5 por 1M.
  **1 job → 3 prompts → 1 envelope**, respeitando `UNIQUE(job_id)`.
  Quantidade veio de `quantidade_imagens_solicitada` do projeto, não de
  constante. `tiposPermitidos` foi calculado a partir da verdade visual e
  saiu `capa_principal, perspectiva, detalhes, uso` — **sem `embalagem`**,
  porque aquela análise não tinha nenhum item com origem
  `embalagem_fisica`. Exatamente 1 principal, ordens 1–3 contíguas,
  `aspectRatio` 1:1 em todas, `textosPermitidos` vazio.
  **Nenhuma escrita em `estudio_anuncios_imagens_geradas` nem em
  `conteudo_versoes` (ambas seguem vazias), nenhum acesso a Storage,
  nenhum modelo de imagem chamado.**
  **Duas rejeições reais ANTES do sucesso — e as duas eram defeito da
  minha validação, não do modelo** (ver `CHANGELOG.md` e `BUGS.md`):
  "fundo branco" era barrado como cor inventada do produto, e "condições
  reais de uso" era barrado como se "reais" fosse moeda. Corrigidos com
  teste de regressão cada um; o job voltou a `pendente` preservando
  `erro_tipo`, exatamente como a migration `20260812` prevê.
  Idempotência verificada contra o banco com as funções reais: mesmo
  envelope → mesmo `id`; divergente → `ErroIdempotenciaResultadoPipeline`
  sem sobrescrever; prompt e consumo seguem 1 por job.
- ✅ **`geracao_imagem` com Gemini real: VALIDADO em 2026-08-16.**
  Billing habilitado pelo usuário; cota confirmada por consulta à API
  ANTES de qualquer geração (a métrica deixou de ser `free_tier`).
  **Cenário mínimo** — projeto `d3eeb91a-…` (qtd=1), job `cfab1965-…`:
  `gemini-3.1-flash-image`, 9,6s, 663/1.425 tokens, 1 imagem
  **1024×1024 JPEG, 316.936 B, proporção 1:1 com desvio 0,00%**,
  `job_origem_id` → job de `geracao_prompts_imagem`.
  **Cenário completo** — projeto `44e781d5-…` (qtd=3), job `29c09b53-…`:
  25,7s para as 3 imagens em sequência, 1.684/4.270 tokens,
  `unidades_geradas=3`, ordens 1–3 contíguas, exatamente 1 principal,
  todas 1024×1024 e 1:1, finalidades `capa_principal`/`detalhes`/`uso`.
  Casamento banco↔Storage perfeito, `tamanho_bytes` idêntico ao metadata
  do objeto, path sempre dentro de `{user}/{projeto}/geradas/{job}/`.
  **Auditoria VISUAL (obrigatória, feita olhando as imagens):** é
  inequivocamente o mesmo produto; formato, cores (verde jade + dourado),
  componentes (2 rolos, haste, forquilha, 2 anilhas, 1 placa Gua Sha) e
  quantidade preservados; nenhum acessório, marca, texto ou embalagem
  inventados; fundo neutro coerente; qualidade adequada para anúncio.
  **Ressalva registrada:** a placa Gua Sha sai maior em relação ao rolo
  que no original, com bordas mais arredondadas, e o arame dourado sai um
  pouco mais espesso — desvios perceptíveis lado a lado, sem deformação
  estrutural.
  **Idempotência e recuperação parcial validadas contra banco e Storage
  reais:** reexecutar o mesmo job devolveu `imagensGeradasAgora=0`,
  **zero tokens**, os mesmos ids, sem duplicar linha nem objeto; apagando
  a imagem 3, a reexecução regenerou **só ela** e reaproveitou 1 e 2 com
  os ids originais.
- ✅ **`calculo_score` (determinístico, sem IA): VALIDADO em 2026-08-17.**
  Projeto `44e781d5-…` (o único com os 6 artefatos reais), job
  `43ac9f5b-…`: `provedor=internal`, `modelo=regras-score-v1`,
  `schema_versao=1`, **zero prompt e zero consumo registrados** (a etapa
  não consome IA — ver a correção §37.2 abaixo).
  **Score 96/100 — "excelente".** Soma dos blocos 96,2333 → `Math.round`
  → 96, batendo com o valor persistido. Pesos somam 100.
  Perdas explicadas por critério, não por caixa-preta: `analise_visual`
  7,73/10 (foto nota 80 escalonada, e só 1 foto analisada) e `conteudo`
  18,50/20 (1 parágrafo de descrição longa, o critério pede 2). Os outros
  6 blocos em 100%.
  As 6 fontes resolvidas deterministicamente, todas do mesmo projeto.
  **Pipeline fechado corretamente:** `status=concluido`, `concluido_em`
  preenchido, `erro` nulo, nenhum job novo criado, fila global zerada.
  **Reprodutibilidade comprovada:** duas reexecuções sobre as mesmas
  fontes deram score e blocos idênticos — só `calculadoEm` muda.
  Idempotência: mesmo envelope → mesmo `id`; envelope divergente →
  `ErroIdempotenciaResultadoPipeline` sem sobrescrever.
- 💲 **Custo de `geracao_imagem` INSTRUMENTADO em 2026-08-18.** Antes,
  `custo_estimado` era gravado como 0 com `console.warn` (nenhum preço
  cadastrado). Preço verificado na **documentação oficial** do Google
  (ai.google.dev/gemini-api/docs/pricing, tier Standard), não na memória:
  `gemini-3.1-flash-image` cobra **$0,50 entrada / $3 saída de
  texto+thinking / $60 saída de IMAGEM** por 1M de tokens.
  **A saída tem duas taxas** — o que a arquitetura anterior não sabia
  representar (§37.2): `PrecoPorMilhaoTokens` ganhou
  `saidaImagemPorMilhao` e `estimarCustoUsd()` um 4º argumento opcional,
  ambos aditivos (os 4 modelos de texto seguem idênticos).
  A fatia de imagem vem de `usage.output_tokens_by_modality`, **reportada
  pela própria API** — nunca de `unidades × preço por imagem`, que
  quebraria em resolução diferente de 1K. Confirmado em chamada real:
  **1120 tokens** para uma imagem 1024×1024, exatamente o número da
  documentação.
  **Validação real (job `e8afeed9-…`):** 663 entrada / 1.439 saída, das
  quais 1.120 de imagem → `custo_estimado = US$ 0,06848850`, batendo
  **exatamente** com a fórmula oficial. Antes da instrumentação, a mesma
  execução gravaria US$ 0.
- ⚙️ **Correção estrutural §37.2 aplicada ANTES da implementação.**
  `executar-job.ts` chamava `registrarPrompt()`/`registrarConsumo()`
  **incondicionalmente**, assumindo que toda etapa fala com um provedor.
  Como `central_ia_prompts.modelo` e `central_ia_consumo.modelo` são NOT
  NULL, uma etapa sem IA seria obrigada a **inventar uma string de
  modelo** e gravar consumo inexistente — poluindo as tabelas que existem
  para auditar gasto real. Novo campo `HandlerEtapa.consomeIAExterna`
  (default `true`, então nenhuma das 6 etapas anteriores mudou) faz o
  executor pular os dois registros.

**Timeout do Worker**
- Corrigido (30s fixo → configurável, padrão 120s) depois de um
  falso-negativo real identificado: a rota interna terminava com sucesso
  depois que o Worker já tinha desistido de esperar.

**Contrato JSON de `analise_visual` — auditoria comparativa**
- 3 cenários auditados manualmente (texto no produto vs. embalagem;
  marca ambígua/ausente; múltiplas fotos com divergência) contra o
  schema/prompt vigente — usados para desenhar a revisão de contrato que
  resultou em `origem` por atributo.

**`geracao_conteudo` — 56 testes unitários (funções puras)**
- `scripts/testar-geracao-conteudo.ts`, executado via `npx tsx` — **56/56
  passando**: registry (11), classificação B/C/D e roteamento por origem
  (16), efeito de alertas (3), atribuição de IDs (3), validação
  estrutural (11), integridade de `fatoIds` (12). Cobrem só as funções
  determinísticas — não exercitam `executarGeracaoConteudoGoogle()`
  (depende de Supabase) nem uma chamada real ao Gemini.

**TypeScript**
- `npx tsc --noEmit` confirmado limpo em cada incremento relevante deste
  módulo, checado pela última vez após a implementação de
  `geracao_conteudo` (57 arquivos deste módulo compilando sem erro).

---

## 9. Bugs encontrados

| # | Causa | Solução | Arquivos | Status |
|---|---|---|---|---|
| 1 | `chk_jobs_provedor_definido` exigia `provedor` definido em qualquer status ≠ `pendente` — quebrava o próprio `claim` (que muda `pendente→rodando` sem conhecer o provedor ainda). | Constraint reescrita: `provedor` só obrigatório quando `status='concluido'`. `concluir_job`/`falhar_job` recriadas com `p_provedor`. | `20260806_corrigir_provedor_jobs_pipeline.sql` | Corrigido |
| 2 | `estudio_anuncios_pipeline_iniciar()` original (`RETURNS TABLE`) tinha nomes de coluna que colidiam com variáveis OUT implícitas do Postgres (`id`, `projeto_id`, `versao_catalogo`) — `ERROR: column reference "id" is ambiguous` em teste real. | Toda referência não-qualificada trocada por `nome_da_tabela.coluna` nos pontos afetados. | `20260807_estudio_anuncios_iniciar_pipeline_rpc.sql` | Corrigido |
| 3 | `EXECUTE` de `claim_next_estudio_anuncios_job()` (e, por precaução, `claim_next_sync_job()`) concedido a `anon`/`authenticated` mesmo com `REVOKE FROM PUBLIC` — causa: `ALTER DEFAULT PRIVILEGES` do projeto Supabase concede `EXECUTE` a esses roles em toda função nova, automaticamente. | `REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated` explícito + `GRANT ... TO service_role`, nas duas funções. Validado por leitura e por impersonação transacional. | Migrations de `claim_next_*` | Corrigido (ver `docs/BUGS.md`, item SEC1) |
| 4 | Timeout HTTP fixo (30s) do Worker causava falso-negativo: a rota interna concluía o job com sucesso *depois* do Worker já ter desistido de esperar e reportado falha. | Timeout configurável via `ESTUDIO_ANUNCIOS_WORKER_HTTP_TIMEOUT_MS` (padrão 120s, teto 600s, falha explícita se inválido). Worker nunca decide o status real do job por esse timeout — só para de esperar. | `scripts/estudio-anuncios-worker.mjs` | Corrigido |
| 5 | `estudio_anuncios_pipeline_iniciar()` permitia criar Pipeline + 1º job para um projeto **sem nenhuma foto**, e só falhava depois, dentro do executor (`erro_tipo=validation`), gastando um ciclo do Worker. | Checagem `PROJETO_SEM_FOTOS` adicionada dentro da própria RPC (transacional), mais uma pré-checagem amigável na rota. | `20260810_estudio_anuncios_pipeline_exigir_foto.sql`, rota `pipeline/iniciar` | Corrigido |
| 6 | `mapearErroGoogle()` original usava `err instanceof ApiError` — a Interactions API na verdade lança uma hierarquia de erro própria, não exportada publicamente pelo SDK; um teste real com chave inválida gravou `erro_tipo="unknown"` em vez de `"auth"`. | Reescrito para inspeção estrutural do objeto de erro (`status`/`statusCode`/`name`), não `instanceof`. | `lib/ai-gateway/provedores/google.ts` | Corrigido (com ressalva documentada: a API às vezes não devolve texto reconhecível de credencial — ver comentário `erroIndicaCredencialInvalida`) |
| 7 | Comentário JSDoc contendo a substring literal `*/` fechava o bloco de comentário prematuramente, quebrando o parser TypeScript em cascata. | Reescrita do texto do comentário para evitar a substring `*/`. | `geracao-conteudo-tipos.ts`, `google-conteudo-schema.ts` | Corrigido |
| 8 | Lista ilustrativa de `CampoOrigem` no contrato de texto (`ESTUDIO_ANUNCIOS_IA_GERACAO_CONTEUDO_CONTRATO.md`, seção 12) tinha 11 valores, omitindo `publicoProvavel` — tornaria o mecanismo de `publicoSugerido` (seção 7 do mesmo contrato) inexequível. | Resolvido via confirmação explícita do usuário: `CampoOrigem` definitivo tem 12 valores (`keyof Pick<...>`, nunca lista copiada à mão). | `google-tipos.ts` | Corrigido — mas o **texto do documento `.md` continua com a lista antiga de 11**, nunca editado (ver seção 14, divergência doc↔código) |

---

## 10. Limitações conhecidas

- **Worker sem processo contínuo/cron.** Precisa ser rodado manualmente
  (`node scripts/estudio-anuncios-worker.mjs`), 1 job por vez — não há
  loop nem agendamento em produção.
- **`ping`** continua no `CHECK` de `estudio_anuncios_jobs.etapa` e no
  `ETAPAS_FAKE_GENERICAS` — etapa exclusiva de teste de infraestrutura,
  nunca deveria aparecer em UI voltada ao usuário final.
- **Jobs de teste residuais preservados, não apagados** (por decisão
  explícita, nunca `DELETE`): resíduos de testes de `ping`, de RPCs, e do
  ciclo E2E do Worker continuam nas tabelas, neutralizados
  (`status=erro`/`cancelado`) mas presentes — qualquer consulta futura
  sobre "todos os jobs"/"todos os projetos" vai incluí-los.
- **Buckets de Storage de saída (`estudio-anuncios-gerado`,
  `estudio-anuncios-exportacoes`) nunca foram criados** — só existem no
  plano documentado (`CHANGELOG.md`, 2026-08-03). Necessários antes de
  `geracao_imagem`/vídeo/exportação gerarem qualquer arquivo real.
- **Sem RLS em nenhuma tabela do módulo** (mesma decisão já vigente no
  resto do CDS) — autorização é 100% em código de aplicação, sempre
  filtrando por `user_id` da sessão. Sinalizado no schema original como
  "ponto a reconsiderar" (fotos e conteúdo de anúncio de clientes têm
  perfil de sensibilidade diferente de número financeiro).
- **`central_ia_consumo`/`central_ia_prompts` acoplados só ao Estúdio de
  Anúncios**, apesar do nome "central_ia" — dívida técnica registrada
  explicitamente na migration de origem, a ser revisada antes de um 2º
  módulo real da Central de IA existir.
- **Tabela de preços do Gemini (`TABELA_PRECOS_USD_POR_MILHAO_TOKENS`)
  tem só 1 modelo cadastrado** (`gemini-3.6-flash`) — qualquer outro
  modelo configurado devolve `custoEstimado=0` silenciosamente (com
  `console.warn`), nunca um erro.
- **`GOOGLE_AI_MAX_IMAGES`/`GOOGLE_AI_MAX_BYTES` só valem para
  `analise_visual`** — `geracao_conteudo` não envia imagens (é
  texto-only), então esses limites não se aplicam a ela.
- **Nenhuma etapa além de `analise_visual`/`geracao_conteudo` tem sequer
  um schema Google desenhado** — `revisao_claude` nem usa o Gemini (é
  Claude, por nome, mas roda 100% fake hoje).
- **Nenhum teste real documentado de upload de foto contra o Storage
  vivo** neste repositório (diferente do padrão rigoroso aplicado ao
  resto do módulo) — ver seção 8.

---

## 11. Estado do banco

Tabelas deste módulo (todas em `public`, sem RLS):

**Núcleo do Projeto**
- `estudio_anuncios_projetos` — "Projeto Mestre" (1 produto). `status`
  com 13 valores. `loja_id` opcional (`ON DELETE SET NULL`).
- `estudio_anuncios_projetos_marketplace` — 1 linha por
  marketplace escolhido, `UNIQUE(projeto_id, marketplace)`.
- `estudio_anuncios_entradas_produto` — ficha editável do produto,
  `UNIQUE(projeto_id)` (sem versionamento nesta fase).
- `estudio_anuncios_imagens_origem` — fotos reais enviadas pelo usuário.
  No máximo 1 `e_principal=true` por projeto (índice único parcial).

**Pipeline**
- `estudio_anuncios_pipeline` — 1 linha por projeto (`UNIQUE
  projeto_id`), estado do orquestrador.
- `estudio_anuncios_pipeline_catalogo` — catálogo de etapas amplas,
  `UNIQUE(versao_catalogo, etapa)` e `UNIQUE(versao_catalogo, ordem)`.
- `estudio_anuncios_pipeline_catalogo_jobs` — mapeamento etapa ampla →
  `estudio_anuncios_jobs.etapa`, em ordem.
- `estudio_anuncios_jobs` — fila persistente. `job_origem_id`
  auto-referente (`ON DELETE SET NULL`). Índice único parcial de "job
  ativo" (projeto+etapa+marketplace+referência, `WHERE status IN
  (pendente,rodando)`).
- `estudio_anuncios_resultados_pipeline` — resultado estruturado real,
  `UNIQUE(job_id)`, `resultado JSONB` (`CHECK` de tipo objeto).

**Conteúdo/mídia (fases futuras, tabelas já existem)**
- `estudio_anuncios_conteudo_versoes` — histórico de versões de conteúdo
  por adaptação, `UNIQUE(projeto_marketplace_id, numero_versao)`.
- `estudio_anuncios_auditoria` — classificação por campo (6 categorias),
  ligada a `conteudo_versoes`.
- `estudio_anuncios_imagens_geradas` — pool por projeto (não por
  marketplace), no máximo 1 `e_principal` por projeto.
- `estudio_anuncios_videos_gerados` — unicidade considera marketplace via
  `COALESCE`.
- `estudio_anuncios_pendencias` — perguntas objetivas pendentes.
- `estudio_anuncios_pacotes_exportacao` — pacote gerado sob demanda.
- `estudio_anuncios_score` — histórico de versões (nunca sobrescreve),
  notas 0-100, `conversao_estimada` reservada para fase futura (nunca
  preenchida pela IA).

**Central de IA compartilhada**
- `central_ia_biblioteca_produtos` (+`_versoes`) — biblioteca curada/
  privada de produtos reaproveitáveis.
- `central_ia_prompts` — histórico de todo prompt (real ou fake),
  `job_id` nullable com índice único parcial.
- `central_ia_consumo` — custo/consumo por chamada real, mesma disciplina
  de idempotência por `job_id`.
- `central_ia_creditos` (+`_lancamentos`) — saldo por usuário,
  compartilhado entre módulos futuros; débito idempotente por `job_id`.

**Relacionamentos-chave**: `estudio_anuncios_jobs.job_origem_id →
estudio_anuncios_jobs.id` (auto-referente); `..._resultados_pipeline.job_id
→ ..._jobs.id` (1:1); `..._pipeline.job_atual_id → ..._jobs.id`;
`..._projetos_marketplace.projeto_id → ..._projetos.id` (cascade);
`central_ia_prompts.job_id`/`central_ia_consumo.job_id → ..._jobs.id`
(nullable, `SET NULL`).

**Constraints importantes**: `chk_jobs_tentativas_max`
(`tentativas <= max_tentativas`), `chk_jobs_provedor_definido`
(`status <> 'concluido' OR provedor IS NOT NULL` — versão corrigida),
`chk_pipeline_concluido_xor_cancelado`, `CHECK(jsonb_typeof(resultado) =
'object')` em `resultados_pipeline`.

---

## 12. Estado do código

**`lib/estudio-anuncios/`**
- `tipos.ts` — tipos-base espelhando o schema (Projeto, Adaptação,
  EntradaProduto, ImagemOrigem, Pendencia, CRUD do Projeto Mestre).
- `validacao.ts` — validação de entrada do CRUD (formato/domínio, nunca
  consulta o banco).
- `projetos.ts` — acesso a dados do CRUD (list/get/create via RPC/edit/
  cancelar-logicamente).
- `jobs.ts` — leitura mínima da fila (nunca claim, nunca criação de job
  fora do fluxo do Pipeline).
- `storage.ts` — todo o Storage real (detecção de MIME, dimensões,
  sanitização de nome, caminho, upload/download/URL assinada).
- `fotos.ts` — acesso a `estudio_anuncios_imagens_origem` (estado
  ordem/principal, inserção, formatação de resposta de API).
- `analise-visual.ts` — orquestrador de `analise_visual` real (seleção de
  fotos por limite, prompt versionado, validação manual do JSON,
  montagem do resultado completo).
- `geracao-conteudo-tipos.ts` — domínio puro de `geracao_conteudo`.
- `geracao-conteudo.ts` — orquestrador de `geracao_conteudo` real
  (entrada segura, prompt, validação estrutural, validação de
  integridade de `fatoIds`, 7 pré-condições de `job_origem_id`).
- `executar-job.ts` — executor central (resolve handler via Registry,
  checa `provedoresPermitidos`, registra prompt/consumo/resultado).
- `executores/registry.ts` — `HandlerEtapa`, `HANDLERS_ESPECIFICOS`,
  `ETAPAS_FAKE_GENERICAS`, `resolverHandler()`, validação de boot.
- `executores/analise-visual.ts` / `executores/geracao-conteudo.ts` —
  handlers reais das 2 etapas com IA de verdade.
- `executores/fake-generico.ts` — handler fake compartilhado pelas
  outras 6 etapas.
- `pipeline/tipos.ts`, `pipeline/catalogo.ts`, `pipeline/maquina-estados.ts`,
  `pipeline/pipeline.ts` — tipos, leitura do catálogo, transições válidas
  (função pura) e todas as escritas do Pipeline (incluindo envelopes
  finos sobre as 7 RPCs).
- `supabase-servidor.ts` — cliente `service_role`, criado sob demanda,
  nunca importável de código client-side.

**`lib/ai-gateway/`**
- `tipos.ts` — `ProvedorIA`, `RespostaIA`, `ErroIA`/`TipoErroIA`,
  `SolicitacaoIA`.
- `roteamento.ts` — `decidirProvedor()` (única leitura de
  `GOOGLE_AI_ENABLED`/`GOOGLE_AI_GERACAO_CONTEUDO_ENABLED`),
  `decidirTipoPrompt()`.
- `cliente.ts` — Gateway 100% fake, recusa rodar se o roteamento não
  devolver `"fake"`.
- `registro.ts` — `registrarPrompt()`/`registrarConsumo()`/
  `registrarResultadoPipeline()`, todos idempotentes.
- `provedores/google.ts` — cliente real do Gemini (`chamarGeminiComImagens`/
  `chamarGeminiTexto`, `obterModeloVisual`/`obterModeloConteudo`,
  `estimarCustoUsd`, `mapearErroGoogle`, `ErroProvedorIA`).
- `provedores/google-tipos.ts` — contrato de `analise_visual`
  (`AnaliseVisualIA`, schema JSON, `CampoOrigem`).
- `provedores/google-conteudo-schema.ts` — schema JSON de
  `geracao_conteudo` (só forma, nunca conteúdo).

**`app/api/estudio-anuncios/`** — CRUD de projetos (`projetos/route.ts`,
`projetos/[id]/route.ts`), upload de fotos
(`projetos/[id]/fotos/route.ts`), início do Pipeline
(`projetos/[id]/pipeline/iniciar/route.ts`).

**`app/api/internal/estudio-anuncios/executar/route.ts`** — única rota
que o Worker chama; nunca decide sequência do Pipeline.

**`app/(app)/central-ia/`** — `page.tsx` (dashboard com contagem de
projetos), `estudio-anuncios/page.tsx` (listagem), `.../novo/page.tsx`
(criação + upload multi-arquivo), `.../[projetoId]/page.tsx` (detalhe,
polling, botão "Iniciar geração").

**`scripts/estudio-anuncios-worker.mjs`** — Worker de execução única.
**`scripts/testar-estudio-anuncios-ping.mjs`** — teste manual da etapa
`ping`. **`scripts/testar-geracao-conteudo.ts`** — 56 testes unitários
das funções puras de `geracao_conteudo`.

---

## 13. Próxima tarefa

Esta seção guarda só o **resumo histórico fixo** de autorizações já
encerradas — não muda a cada sessão. **Para o estado corrente e a
próxima tarefa efetivamente autorizada, ver `docs/NEXT_TASK.md`
(sempre — nunca confiar nesta seção para isso).**

A autorização conhecida internamente como **"PARTE 2"** (continuação de
uma mega-autorização anterior, "PARTE 1", que produziu só documentos de
auditoria/design, sem tocar em código — **PARTE 1 está encerrada**) teve
sua ordem obrigatória de 15 passos cumprida integralmente:

1. Migration `job_origem_id` apresentada, executada e validada.
2. RPC `estudio_anuncios_pipeline_avancar()` testada via SQL puro
   (incluindo preservação de `job_origem_id` no retry).
3. Resíduo de teste da RPC neutralizado (nunca apagado).
4. Executor registry implementado (`registry.ts`, `analise-visual.ts`,
   `fake-generico.ts`).
5. `executar-job.ts` migrado para usar o registry.
6. Regressão das etapas fake + `analise_visual` validada pós-registry.
7. Domínio `geracao-conteudo-tipos.ts` implementado.
8. Schema Google (`google-conteudo-schema.ts`) implementado.
9. Entrada segura + orquestração (`geracao-conteudo.ts`) implementadas.
10. Funções de texto do Google (`obterModeloConteudo`/`chamarGeminiTexto`)
    implementadas.
11. Handler real de `geracao_conteudo` criado + troca atômica no registry.
12. 56 testes isolados executados (56/56) + `tsc --noEmit` limpo.
13. Relatório final de 17 itens entregue.

**O stop-gate explícito da PARTE 2 — "pare antes da primeira chamada real
ao Gemini [em `geracao_conteudo`]" — foi respeitado.** Nenhuma chamada
real ao Gemini foi feita em `geracao_conteudo` em nenhum momento;
`GOOGLE_AI_GERACAO_CONTEUDO_ENABLED` permanece `false`.

**"PARTE 2" está encerrada.** Qualquer autorização posterior a ela (nova
"PARTE 3" ou equivalente) é registrada em `docs/NEXT_TASK.md`, não aqui —
inclusive se essa autorização já tiver sido concluída e uma nova ainda
mais recente estiver em andamento. Esta seção só ganha um novo bloco
numerado quando uma fase inteira (como "PARTE 2") se encerra de vez.

---

## 14. Regras para futuras implementações

- **Nunca inventar dado.** Nenhum campo de IA é preenchido por inferência
  não sustentada por evidência textual/visual explícita — regra aplicada
  literalmente em `analise_visual` (marca/modelo/quantidade só com
  evidência clara, senão `null` + registro em
  `informacoesNaoConfirmadas`) e em `geracao_conteudo` (toda afirmação
  precisa citar um `fatoId` real).
- **Nunca fazer fallback silencioso entre modelo/provedor/config.** Toda
  variável de ambiente ausente-mas-obrigatória lança erro explícito
  classificado; nenhuma etapa "tenta" outro provedor sozinha.
- **Validar tudo duas vezes quando a RPC recebe parâmetro cru.** Toda RPC
  restrita a `service_role` (que recebe `p_user_id`/`p_provedor`/etc. sem
  nenhuma verificação de sessão possível dentro dela mesma) replica a
  validação já feita em TypeScript — nunca confia só na camada de cima.
- **Preservar idempotência por `job_id`** em qualquer nova tabela de
  registro (`central_ia_prompts`, `central_ia_consumo`,
  `estudio_anuncios_resultados_pipeline` já seguem isso) — índice único
  parcial + tratamento explícito de `23505`.
- **Não alterar o Gateway fake sem migração controlada.** Mudar o
  conteúdo/formato de `gerarConteudoFake()` pode quebrar testes/scripts
  que dependem do determinismo atual.
- **Não criar handlers duplicados.** Uma etapa só pode estar em
  `HANDLERS_ESPECIFICOS` OU `ETAPAS_FAKE_GENERICAS`, nunca nos dois — a
  validação de boot do registry já garante isso, não burlar.
- **Nunca gerar URL pública de Storage.** Sempre assinada, sob demanda,
  nunca persistida no banco.
- **Nunca mover uma etapa para `HANDLERS_ESPECIFICOS` como andaime
  intermediário** — só como último passo, depois de tipos/schema/lógica/
  testes já prontos e `tsc` limpo (mesmo padrão já aplicado a
  `geracao_conteudo`).
- **Migration nova para toda mudança de schema já executado** — nunca
  editar uma migration já executada; `CREATE OR REPLACE FUNCTION`/`ALTER
  TABLE ... ADD COLUMN IF NOT EXISTS` em arquivo novo, sempre.
- **~~Zero acesso a banco/rede ao vivo por quem estiver executando estas
  tarefas~~ — REVOGADA em 2026-08-06 pela Emenda 1 da Constituição.**
  A regra original dizia: *"todo SQL é apresentado para o usuário rodar;
  todo resultado é validado a partir do dado literal colado de volta,
  nunca aceito por afirmação de 'sucesso'."*
  **Vigente agora:** executar migrations, SQL, Worker e chamadas reais ao
  Gemini **em projeto de teste** é Nível 1 (automático) — ver
  `CLAUDE_CONSTITUTION.md`, Seções 41 a 43. O que **não** mudou: o
  resultado continua sendo validado pelo retorno literal (lido, agora, em
  vez de colado), e continua proibido declarar concluído o que não foi
  verificado. Mudou quem executa, não o que conta como prova.
- **⚠️ Divergência doc↔código encontrada nesta auditoria**: o documento
  `ESTUDIO_ANUNCIOS_IA_GERACAO_CONTEUDO_CONTRATO.md` (seção 12) ainda
  lista `CampoOrigem` com 11 valores (sem `publicoProvavel`) — o código
  (`google-tipos.ts`) já usa a versão correta de 12, confirmada
  explicitamente com o usuário (2026-08-11). **O `.md` nunca foi
  atualizado para refletir essa correção** — se alguém ler só o `.md`,
  vai encontrar uma definição desatualizada. Recomendação: tratar o
  código como fonte da verdade neste ponto específico, e atualizar o
  `.md` numa próxima janela de manutenção de documentação.
- **⚠️ `docs/CHANGELOG.md` está desatualizado para este módulo.** A
  convenção do projeto ("toda tarefa que criar/corrigir/remover
  funcionalidade deve adicionar uma entrada") não foi seguida a partir de
  2026-08-04 para o Estúdio de Anúncios — RPC de criação de projeto,
  Pipeline Orchestrator completo (schema+7 RPCs), integração do Worker,
  upload real de fotos, Gemini em `analise_visual`, e todo o trabalho de
  `geracao_conteudo` **não têm entrada no CHANGELOG**. Este arquivo
  (`PROJECT_STATE.md`) cobre esse histórico; recomenda-se retomar a
  disciplina do CHANGELOG a partir daqui, ou tratá-lo como
  descontinuado para este módulo em favor deste documento.

---

## 15. Histórico resumido

1. **2026-08-03** — Planejamento (3 documentos) → Schema completo da Fase 0
   executado (18 tabelas + `claim_next_estudio_anuncios_job()`). Achado de
   segurança (SEC1, `EXECUTE` aberto a `anon`) corrigido no mesmo dia.
2. **2026-08-04** — Teste `ping` E2E validado (fila/claim/worker/rota
   interna, zero custo). RPC `criar_projeto_estudio_anuncios()` desenhada.
3. **2026-08-05** — Pipeline Orchestrator (schema + catálogo + RPCs
   `avancar`/`registrar_falha`) implementado e testado.
4. **2026-08-06** — Integração funcional completa: RPCs atômicas
   `concluir_job`/`falhar_job` (2 versões — bug de `provedor` corrigido no
   mesmo dia), `central_ia_prompts.job_id`, UI do Projeto Mestre
   (dashboard/listagem/criação/detalhe), E2E real do Worker nas 7 etapas
   via Gateway fake.
5. **2026-08-07** — RPC `estudio_anuncios_pipeline_iniciar()` (bug de
   ambiguidade de coluna corrigido no mesmo dia), UI de início/
   acompanhamento do Pipeline com polling.
6. **2026-08-08** — Upload real de fotos (Storage privado, `file-type`/
   `image-size`, compensação de falha, UI de upload multi-arquivo).
7. **2026-08-09** — Primeira API real de IA: Gemini para `analise_visual`
   (SDK `@google/genai`, Interactions API, schema com `origem` por
   atributo, mapeamento de erro corrigido após teste real com chave
   inválida).
8. **2026-08-10** — Bug real corrigido: Pipeline podia iniciar sem foto
   (RPC `estudio_anuncios_pipeline_iniciar()` passou a exigir ≥1 foto).
9. **2026-08-11 (PARTE 2, esta sessão)** — `job_origem_id` (migration +
   RPC `avancar` atualizada, testado via SQL puro); Executor registry
   extraído; domínio, schema, entrada segura e orquestração de
   `geracao_conteudo` implementados; handler real criado e trocado
   atomicamente no registry; 56 testes unitários (56/56); `tsc` limpo;
   relatório final entregue. **Nenhuma chamada real ao Gemini em
   `geracao_conteudo` — stop-gate respeitado.**
10. **2026-08-06 (data do ambiente, esta tarefa)** — Este documento
    (`docs/PROJECT_STATE.md`) criado, consolidando tudo acima a partir de
    leitura direta do código e das migrations.
