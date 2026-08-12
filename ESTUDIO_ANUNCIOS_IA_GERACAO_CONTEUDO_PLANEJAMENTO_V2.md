# Planejamento técnico — etapa `geracao_conteudo` (V2 — redesenho pós-auditoria)

Este documento substitui as decisões estruturais da V1
(`ESTUDIO_ANUNCIOS_IA_GERACAO_CONTEUDO_PLANEJAMENTO.md`) nos 7 pontos
identificados pela auditoria arquitetural (conclusão: RECOMENDO
REDESENHAR ALGUNS PONTOS). A V1 permanece como registro histórico do
raciocínio original — não foi apagada. Ainda sem contrato JSON de
saída, sem código, sem migration, sem escolha de provedor.

---

## 1. Fluxo completo corrigido

```
analise_visual (job concluído, resultado em estudio_anuncios_resultados_pipeline)
        │
        │  job_origem_id (novo, ver seção 7) aponta explicitamente
        │  para o job de analise_visual — nunca "pega o mais recente"
        ▼
montarEntradaSeguraGeracaoConteudo(resultado, alertas)   [server-side, sem IA]
        │
        │  produz: fatosPermitidos / descricoesComRessalva /
        │  informacoesProibidas / contextoPromocional / alertas
        ▼
geracao_conteudo (chamada real ao provedor — contrato de domínio
                   independente do SDK, ver seção 10)
        │
        ▼
registrarResultadoPipeline() [reutilizado sem alteração]
        │
        ▼
revisao_claude (transformação de estilo + auditoria de conformidade
                 em duas camadas, ver seção 10 do redesenho)
        │
        ▼
adaptacao_marketplace (formatação + CTA de lista controlada, nunca
                        fato/benefício novo)
        │
        ├──► estudio_anuncios_conteudo_versoes (primeira vez que esta
        │     tabela é usada — agora com projeto_marketplace_id real)
        │
        ▼
calculo_score (lê o conteúdo ADAPTADO por marketplace, score estrutural
               por marketplace — nunca conversão/venda)
```

---

## 2. Modelo de proveniência versus certeza

**Decisão: opção 2 — manter o contrato de `analise_visual` congelado, e
construir uma camada server-side de fatos permitidos/restritos antes
do prompt.** Não a opção 1 (campo categórico por item).

Justificativa, não preferência: adicionar um campo de status
epistemológico a cada item do contrato de `analise_visual` significa
reabrir um contrato que acabou de ser fechado, testado 5 vezes com
Gemini real e aprovado — e faria isso **sem nenhuma evidência** de que
o modelo de visão consegue popular esse campo de forma confiável (o
único indício que temos de comportamento espontâneo é a linguagem de
hedge dentro do próprio texto, ex. "aparência de jade" — nunca testamos
pedir um campo estruturado separado pra isso). Isso violaria o
princípio que sustentou toda a fase anterior: nenhuma mudança de
contrato sem evidência observada. A opção 2 não tem esse problema — é
uma função determinística, testável offline com o mesmo padrão de
script temporário já usado (sem gastar nenhuma chamada real), que
opera sobre dados que já existem, sem tocar no contrato aprovado.

**Classificação A/B/C/D, sem escala numérica**, resolvida por regras,
não por uma nova pergunta ao modelo:

- **A. Proveniência** — o campo `origem` já existente, sem alteração.
- **B. Afirmação confirmada** — item com `origem=produto` (ou
  `embalagem_fisica`), **sem** padrão de hedge detectado no texto, e
  cujo atributo/tópico **não** aparece (nem por correspondência
  parcial) em `informacoesNaoConfirmadas`.
- **C. Inferência/descrição visual** — mesmo critério de origem, mas
  **com** padrão de hedge detectado no valor/descrição (lista inicial
  observada em dado real: "aparência de", "parece", "possivelmente",
  "provável", "tipo" — lista deliberadamente pequena porque só temos 1
  ocorrência real documentada até agora; deve crescer com evidência,
  nunca por suposição).
- **D. Informação explicitamente não confirmada** — qualquer item que
  aparece em `informacoesNaoConfirmadas` (correspondência por
  palavra-chave/substring com o nome do atributo — heurística
  imperfeita, documentada como tal), mais qualquer campo `null` por
  construção (`marca=null`, `modelo=null`), mais qualquer item com
  `origem=indeterminado`.

Risco assumido e registrado, não escondido: a detecção de hedge por
lista de palavras é frágil e vai errar por omissão (hedge com
linguagem nova não capturada) com mais frequência do que por excesso.
O efeito colateral de errar por omissão é superestimar certeza
(pior caso: promover um C pra B) — por isso a lista deve crescer
conforme mais chamadas reais confirmarem novos padrões de hedge, e
qualquer teste real futuro desta etapa deve verificar explicitamente
se a classificação B/C bateu com o que um humano leria no texto
original.

---

## 3. Função conceitual de entrada segura

`montarEntradaSeguraGeracaoConteudo(resultadoAnaliseVisual, alertas)` —
conceitual, sem assinatura de código. Seções de saída:

- **`fatosPermitidos`** — itens classificados B (seção 2) dos campos:
  `produtoIdentificado`, `marca` (se não-nulo), `categoriaProvavel`,
  `cores`/`materiais`/`componentes`/`caracteristicasVisiveis`/
  `possiveisUsos` (só `origem=produto`), `atributosAdicionais` (só
  `origem=produto`), `quantidadeDeclarada` (só se `valor`+`textoOrigem`
  presentes juntos), `textosLegiveis` (só `origem=produto`).
- **`descricoesComRessalva`** — mesmos campos, itens classificados C.
  Cada item carrega uma marca interna (`preservarHedge=true`) para a
  etapa de montagem do prompt reinjetar linguagem de ressalva
  ("aparenta ser", "possui características de") em vez de afirmar.
- **`informacoesProibidas`** — `informacoesNaoConfirmadas` (passthrough
  literal, inalterado) + qualquer item classificado D + qualquer item
  com `origem=embalagem_fisica` ou `origem=indeterminado` (nunca
  entram em `fatosPermitidos`/`descricoesComRessalva`, mas registrados
  aqui para a IA saber que existem e não deve tentar adivinhá-los).
- **`contextoPromocional`** — só itens `origem=material_promocional`,
  isolados (regras completas na seção 4).
- **`alertas`** — passthrough do array, só incluído se `length > 0`.
  Modifica `fatosPermitidos` conforme seção 6.
- **`metadadosInternos` (nunca enviados ao prompt)** — `qualidadeDasFotos`,
  `fotosAnalisadas`, `metadadosAnalise`, `modelo` (sem evidência de uso
  em 5/5 testes reais), e **`resumoVisual`** — decisão nova desta
  revisão: excluído do que é enviado ao prompt (na V1 eu tinha
  classificado como ÚTIL; a própria auditoria encontrou o risco de
  paráfrase-de-paráfrase — texto livre de um modelo virando insumo de
  outro texto livre é o oposto do princípio "só fatos estruturados").

**Duplicidade entre `caracteristicasVisiveis` e `atributosAdicionais`**:
quando o mesmo atributo aparece nos dois, `atributosAdicionais` tem
prioridade (é o campo deliberadamente mais estruturado, curado para
especificação técnica real). A deduplicação usa correspondência de
texto normalizado (minúsculas, sem acento, substring) e **só remove em
caso de correspondência forte** (quase-idêntica) — na dúvida, mantém
os dois. Justificativa: um falso positivo de dedup (perder um fato
real por achar que era duplicado) é pior que um falso negativo
(repetir o mesmo fato duas vezes no texto final, que é só um problema
de qualidade, corrigível na revisão).

**Regra obrigatória de input esparso**: quando `fatosPermitidos` +
`descricoesComRessalva` combinados forem poucos, o prompt deve
instruir saída proporcionalmente mais curta, e campos de saída não
essenciais (especificações técnicas, descrição longa) devem ser
**omissíveis**, nunca preenchidos por invenção só para parecer
completos. Não fixo aqui um número mínimo — não há evidência real
ainda de onde fica o limiar; isso só deve ser calibrado depois de
observar chamadas reais.

---

## 4. Regras para `material_promocional`

Responsabilidade fechada em duas camadas, conforme decisão-base:

**Camada 1 — prevenção em `geracao_conteudo`.** `contextoPromocional`
nunca entra em `fatosPermitidos`. Permitido: identificar só a
categoria ampla de posicionamento (no caso real já testado, "produto
de bem-estar/cuidados faciais", nunca "melhora a circulação"), ajustar
tom sem repetir promessa, gerar texto neutro baseado só em
`fatosPermitidos`/`descricoesComRessalva`. Proibido: repetir a
alegação, parafrasear a promessa de efeito, implicar resultado de
saúde/desempenho/eficácia, transformar frase de infográfico em
benefício confirmado.

**Camada 2 — fiscalização em `revisao_claude`.** Aqui está o ponto que
a V1 deixou em aberto (a auditoria encontrou isso como responsabilidade
não atribuída a ninguém). Mecanismo de duas partes:
- Determinístico: correspondência de substring (normalizada) entre o
  texto gerado e cada item de `contextoPromocional` — pega repetição
  literal.
- Semântico: `revisao_claude` precisa de sua PRÓPRIA verificação
  assistida por IA (LLM-as-judge), tarefa estreita e auditável — "este
  texto implica, mesmo sem repetir as palavras, alguma das alegações
  desta lista? responda sim/não + trecho correspondente" — não é a
  mesma chamada que gerou o conteúdo original julgando a si mesma; é
  uma segunda avaliação, escopo restrito, sobre entrada já pronta.

Isso fecha explicitamente a lacuna: a garantia não depende só de o
`geracao_conteudo` "seguir a instrução" — existe uma segunda camada
que verifica de forma independente.

---

## 5. Regras para `informacoesNaoConfirmadas`

`fatosEvitados` como autorrelato obrigatório **removido** — é o próprio
modelo que poderia vazar um fato relatando, com a mesma facilidade,
que evitou esse fato. Não é verificação, é opinião do suspeito sobre
si mesmo.

Substituído por:
- **Lista negativa explícita no prompt** (mantida da V1, ainda
  necessária como primeira linha de defesa).
- **Validações determinísticas** — cobrem bem casos numéricos/
  estruturados (nenhum número no texto de saída que não apareça
  literalmente em `atributosAdicionais`/`quantidadeDeclarada`/
  `componentes` de entrada). Cobrem mal os itens em prosa de
  `informacoesNaoConfirmadas` (ex. "marca não informada visualmente" —
  não é uma string pra buscar no texto de saída, é um conceito).
- **Análise semântica delegada a `revisao_claude`** — a MESMA
  verificação de LLM-as-judge da seção 4, com uma segunda lista de
  checagem (`informacoesNaoConfirmadas` em vez de `contextoPromocional`),
  potencialmente na mesma chamada (duas checklists, um resultado).

**O que acontece quando `revisao_claude` encontra violação**: **rejeita,
não corrige silenciosamente.** Corrigir automaticamente dentro da
revisão esconderia que a violação aconteceu — nenhum rastro, nenhuma
auditoria possível depois. Achado favorável durante esta revisão: o
schema de `estudio_anuncios_jobs.erro_tipo` **já inclui**
`'conteudo_rejeitado'` como valor válido — não foi usado até hoje,
parece ter sido provisionado exatamente para este cenário. Job de
`geracao_conteudo` que falha por violação semântica vira
`status='erro'`, `erro_tipo='conteudo_rejeitado'`, e — reaproveitando
`tentativas`/`max_tentativas`, já existente — pode ser reprocessado
automaticamente dentro do limite já existente, sem inventar mecanismo
novo.

---

## 6. Regras para `alertas`

Confirmando a decisão-base: nunca viram texto comercial, só restringem
`fatosPermitidos`. Array vazio não é enviado. Exemplos concretos e
efeito:

| Tipo de alerta (heurística por palavra-chave no texto do alerta) | Efeito em `fatosPermitidos` |
|---|---|
| Divergência de cor | Item(ns) de `cores` rebaixado(s) de `fatosPermitidos` para `descricoesComRessalva` — texto deve evitar afirmar uma cor única categórica |
| Quantidade observada divergente | `quantidadeDeclarada` excluído de `fatosPermitidos` mesmo com `valor`+`textoOrigem` presentes |
| Informação conflitante entre fotos (genérico) | Atributo mencionado no texto do alerta (correspondência por palavra-chave, mesma heurística imperfeita da seção 2) rebaixado |
| Possível produto diferente entre imagens | **Severidade diferente das demais** — não é rebaixamento de 1 campo, é sinal de que o resultado inteiro é suspeito. Recomendação: `geracao_conteudo` não deveria prosseguir normalmente neste caso — job deveria falhar com `erro_tipo='validation'` e ficar pendente de revisão humana, não gerar texto sobre um produto potencialmente ambíguo |

Não proponho estruturar `alertas` (ainda é `string[]` em
`analise_visual` — mudar isso reabriria o contrato congelado, o mesmo
problema evitado na seção 2). A classificação de severidade continua
sendo heurística server-side, no mesmo espírito da camada de proveniência.

---

## 7. Rastreabilidade explícita entre jobs/resultados

**Proibido, confirmado**: buscar por `ORDER BY criado_em DESC LIMIT 1`.

Avaliação das 4 alternativas:

- **(A) `job_origem_id` no job consumidor** — coluna nova, nullable,
  self-referencing em `estudio_anuncios_jobs`, apontando pro job de
  origem específico.
- **(B) `resultado_origem_id`** — aponta pro resultado em vez do job.
  Menos correto semanticamente (a dependência real é job-a-job no
  Pipeline; o resultado é só onde o dado mora hoje).
- **(C) Tabela de dependências job-a-job (N:N)** — generaliza pra
  múltiplas dependências por job.
- **(D) Resolver pela cadeia histórica do Pipeline** — rejeitada: na
  prática, sem um ponteiro explícito de "job anterior" já armazenado,
  isso vira a mesma inferência por ordenação temporal que já foi
  proibida, só com mais passos no meio.

**Recomendação: (A).** Hoje `geracao_conteudo` depende de exatamente 1
job (`analise_visual` — `busca_externa` é condicional e nunca disparado
automaticamente na Fase 1, confirmado no catálogo). Construir uma
tabela de dependências N:N (C) agora seria resolver um problema que
não existe ainda, com evidência zero de que vai existir — mesmo
princípio da seção 2. Se um dia uma etapa realmente precisar de mais
de 1 dependência, migrar para (C) então, com esse caso real como
evidência.

- **Impacto no banco**: 1 coluna nova (`job_origem_id UUID REFERENCES
  estudio_anuncios_jobs(id)`), nullable, sem necessidade de backfill
  (só populada daqui pra frente).
- **Impacto nas RPCs**: a RPC que cria o próximo job ao avançar o
  Pipeline precisa passar a popular `job_origem_id` = id do job que
  acabou de concluir, ao criar o job da etapa seguinte.
- **Impacto em reprocessamentos**: nenhum — retry usa o mesmo `job_id`
  (tentativas incrementa), `job_origem_id` não muda, permanece correto
  automaticamente.
- **Duas análises visuais pro mesmo projeto**: hoje impossível pelo
  catálogo atual (sem fluxo de "refazer analise_visual"). Se um dia
  existir, `job_origem_id` resolve por construção — é setado
  explicitamente no momento da criação do job consumidor, nunca
  inferido depois por ordenação.

---

## 8. Estratégia de regeneração/versionamento

Contexto que faltou endereçar na V1: o único gate manual (`tipo='manual'`)
no catálogo inteiro (`versao_catalogo=1`) fica entre `analise_produto`
e `gerar_conteudo` ("pendencias") — **não existe hoje nenhum ponto de
aprovação humana entre `geracao_conteudo` e `revisao_claude`**. Ou
seja, "o usuário aprova ou rejeita o conteúdo-base antes de seguir"
não é um fluxo suportado pelo catálogo atual — regeneração, se
existir, é ação de operador/suporte, não fluxo rotineiro de usuário,
até que um gate seja adicionado ao catálogo (fora de escopo agora).

Dado isso, recomendação mínima pra v1, sem tabela nova:

- **Primeira geração**: job com um campo novo (mesmo espírito de
  `job_origem_id`), por exemplo `job_substitui_id = NULL`.
- **Regeneração**: novo job de `geracao_conteudo`, com
  `job_substitui_id` apontando pro job anterior da mesma etapa/projeto
  — corrente explícita, não inferida por data.
- **Resultado atualmente escolhido**: o job mais recente da corrente
  (percorrível deterministicamente via `job_substitui_id`, não por
  `ORDER BY criado_em` solto).
- **Histórico**: percorrer a corrente inteira.
- **Aprovado/rejeitado**: **não represento isso agora** — sem gate no
  catálogo que consuma esse estado, adicionar as colunas seria
  antecipar um fluxo que não existe ainda.

`estudio_anuncios_conteudo_versoes` **continua exclusivamente
marketplace-specific** — decisão da V1 reafirmada, agora com argumento
mais forte: é exatamente ali (`adaptacao_marketplace`, seção 9) que
`aprovado`/`numero_versao` fazem sentido de verdade, porque é onde o
conteúdo já está no formato final por canal. Rota de evolução futura,
não implementada agora: se um gate de aprovação for adicionado ao
catálogo entre `geracao_conteudo` e `revisao_claude`, aí sim considerar
uma tabela pequena dedicada — nunca reaproveitar `conteudo_versoes`
pra isso, ela deve continuar exclusivamente ligada a
`projeto_marketplace_id`.

---

## 9. Fronteiras das etapas

### `geracao_conteudo`
Título-base, bullets-base, descrição-base, especificações-base
(condicional), público sugerido (opcional). Não conhece marketplace.
Não gera CTA. Não conhece limite de canal.

### `revisao_claude`
**Decisão: ambos — transformação E auditoria, mas com fronteira clara
dentro da própria etapa.** Clareza/consistência/estilo → corrige
livremente, produz artefato revisado. Violação de `material_promocional`/
`informacoesNaoConfirmadas` (seções 4-5) → **nunca corrige em
silêncio**, rejeita com `erro_tipo='conteudo_rejeitado'`. Motivo da
distinção: correção silenciosa de um problema de estilo é exatamente o
papel de uma revisão; correção silenciosa de uma alucinação esconde
que ela aconteceu e elimina a possibilidade de auditoria — os dois não
podem ter o mesmo tratamento só porque os dois são "correção".

Grava linha própria em `estudio_anuncios_resultados_pipeline`
(`etapa='revisao_claude'`) mesmo quando não há mudança de conteúdo —
custo aceito conscientemente (duplicação de armazenamento em caso de
aprovação sem alterações) em troca de a etapa seguinte ter sempre uma
única fonte determinística a consultar, sem precisar decidir "uso o de
geracao_conteudo ou o de revisao_claude".

### `adaptacao_marketplace`
Pode alterar formato/extensão/terminologia. **CTA vem de lista
controlada por marketplace, nunca texto livre gerado por IA** — isso
resolve o problema que a auditoria encontrou (CTA como conteúdo novo
sem as mesmas salvaguardas): não é geração, é seleção de um valor
pré-aprovado por canal. Não pode criar fato/benefício novo. Recebe as
mesmas listas de restrição (`informacoesProibidas`, `contextoPromocional`)
como entrada, mesmo fazendo só ajuste de formato — qualquer texto novo
que produzir é estilo/formatação, nunca informação de produto.

### `calculo_score`
Lê o conteúdo **adaptado por marketplace** (`estudio_anuncios_conteudo_versoes`),
não o base nem o revisado — é o que de fato vai ser publicado. Como o
conteúdo pode divergir por marketplace após adaptação, o score é **por
marketplace**, não geral único. Métricas estritamente estruturais
(presença de título, aderência a limites de tamanho do canal,
cobertura de palavras-chave, presença de especificações) — nunca
métrica de conversão/venda prevista, alinhado com o próprio texto fake
já existente no Gateway ("nota_seo, nota_titulo..." — já é estrutural
por natureza).

**Achado à parte, não pedido mas relevante**: o catálogo hoje declara
`calculo_score` (`avaliacao`) como dependente só de `gerar_conteudo`
(`depende_de: {gerar_conteudo}`), mas o texto fake já existente
menciona `nota_imagens` — o que implica dependência de `gerar_imagens`
também, não declarada. Pela ordem do catálogo (`gerar_imagens` roda
antes de `avaliacao`), na prática funciona, mas a dependência formal
está incompleta. Não é bloqueador, é inconsistência pré-existente a
registrar, não corrigir agora.

---

## 10. Executor registry

Abstração conceitual `etapa → handler`, cada handler declarando etapa,
provedor, contrato de entrada, contrato de saída, versões aceitas,
dependências, timeout, função de execução, persistência, tipo de
prompt — conforme pedido, sem código.

**Vantagens**: elimina o crescimento linear de `if`/branch em
`executarJobEstudioAnuncios()`; centraliza metadado que hoje está
espalhado (timeout já vive no catálogo, tipo de prompt já vive em
`roteamento.ts`, mas dependência de dado não vive em lugar nenhum
central — um handler formal poderia declarar isso também, reforçando a
seção 7).

**Riscos**: custo de migração inicial — os 2 casos que já existem hoje
(Gateway fake genérico + branch especial `google`+`analise_visual`)
precisam ser retrofitados pro novo padrão sem regredir o fluxo que já
foi validado com 5 chamadas reais.

**Impacto no código atual**: reescreve boa parte de
`executar-job.ts`, toca moderadamente `roteamento.ts`, exige adaptar a
convenção de chamada de `analise-visual.ts` pro novo formato de
handler.

**Recomendação: implementar antes de `geracao_conteudo`, não depois.**
Motivo prático, não estético: o custo de migração é função de quantas
etapas reais já existem. Hoje são 2 (fake genérico + `analise_visual`).
Se `geracao_conteudo` for implementada primeiro no padrão antigo,
depois for preciso migrar 3 etapas de uma vez (incluindo a recém-criada)
em vez de 2. Fazer agora, com a superfície ainda pequena, é
estritamente mais barato que esperar.

---

## 11. Independência do provedor

Separação em 4 camadas, generalizando o padrão que `analise_visual` já
usa de fato (mesmo que não estivesse nomeado assim):

1. **Tipos de domínio** — `AnaliseVisualIA` (equivalente futuro:
   `GeracaoConteudoIA`) + validador (`validarResultadoAnaliseVisual`,
   equivalente futuro) — a única fonte de verdade sobre o QUE a etapa
   produz, nunca amarrada a sintaxe de nenhum SDK.
2. **Schema do provedor** — um adaptador por provedor, traduzindo o
   tipo de domínio pra `response_schema` (Gemini), tool-use/JSON mode
   (Claude), ou function calling (OpenAI). Um módulo por provedor,
   nunca compartilhado.
3. **Validação server-side** — sempre o validador de domínio da camada
   1, chamado depois de QUALQUER provedor responder — nunca duplicada
   por adaptador.
4. **Persistência** — `registrarResultadoPipeline()`, já 100% genérica
   hoje, sem nenhuma mudança necessária.

**Achado durante esta análise, não pedido mas relevante**: o arquivo
atual que guarda os tipos de domínio de `analise_visual` chama-se
`google-tipos.ts` — nome amarrado ao provedor, mesmo o CONTEÚDO
(`AnaliseVisualIA`, o schema JSON, a validação) sendo, na prática,
inteiramente agnóstico de provedor. Isso é uma pequena inconsistência
entre nome de arquivo e separação de responsabilidade real. Para
`geracao_conteudo`, recomendo nomear o módulo de tipos de domínio de
forma neutra (não `google-tipos.ts` nem `claude-tipos.ts`) desde o
início, evitando repetir essa confusão.

---

## 12. Trade-offs assumidos nesta revisão

- Heurísticas por palavra-chave (hedge, tipo de alerta, correspondência
  a `informacoesNaoConfirmadas`) são frágeis por natureza — aceitas
  conscientemente porque a alternativa (reabrir o contrato de
  `analise_visual` sem evidência) é pior, não porque são robustas.
- `revisao_claude` grava linha própria mesmo sem mudança de conteúdo —
  duplicação de armazenamento aceita em troca de fonte única
  determinística pra etapa seguinte.
- Regeneração/versionamento fica deliberadamente mínimo (`job_substitui_id`,
  sem `aprovado`/`numero_versao`) porque o catálogo atual não tem gate
  humano nesse ponto — reavaliar se um gate for adicionado.
- `job_origem_id` (1:1) escolhido sobre tabela de dependências N:N por
  YAGNI disciplinado — evolução pra N:N só quando houver caso real.

---

## 13. Decisões ainda abertas

1. Qual provedor real (Gemini vs. Claude vs. outro) — deliberadamente
   não decidido aqui, e a arquitetura da seção 11 é desenhada
   justamente para não depender dessa escolha ainda.
2. Lista de palavras de hedge (seção 2) — hoje baseada em 1 exemplo
   real, precisa crescer com evidência de chamadas futuras.
3. Limiar de "input esparso" (seção 3) — não definido, precisa de
   observação real antes de virar regra fixa.
4. Se/quando adicionar um gate manual de aprovação entre
   `geracao_conteudo` e `revisao_claude` no catálogo (seção 8) —
   decisão de produto, não técnica, fora do escopo desta revisão.
5. Se a inconsistência de dependência `calculo_score`/`gerar_imagens`
   no catálogo (seção 9) deve ser corrigida em algum momento.

---

## 14. Conclusão

**SIM** — a arquitetura está pronta para avançar à etapa de desenho do
**contrato JSON conceitual** de `geracao_conteudo` (a próxima etapa do
processo: desenhar → auditar → corrigir → implementar, estamos
concluindo "corrigir").

Qualificação importante, pra não superestimar o que "pronto" significa
aqui: pronto para DESENHO DE CONTRATO, não para IMPLEMENTAÇÃO. Antes de
código real, ainda faltam (nenhum deles bloqueia o desenho do
contrato): escolher provedor (item 13.1), implementar o executor
registry (seção 10, antes do código desta etapa), e as 2 colunas novas
de rastreabilidade/versionamento (`job_origem_id`, `job_substitui_id`
— seções 7-8, ainda não migradas, por decisão explícita de não criar
migration nesta tarefa).
