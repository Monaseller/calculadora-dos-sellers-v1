# Estúdio de Anúncios com IA — Revisão de Experiência (UX simplificada)

> Este documento é um **adendo** a `ESTUDIO_ANUNCIOS_IA_PLANEJAMENTO.md`, não uma reescrita. Só é repetido aqui o que muda; tudo que não é mencionado permanece exatamente como no documento anterior. Nenhum código foi alterado, nenhum arquivo criado no projeto, nenhuma migration escrita.

Aviso direto antes de entrar nos 16 itens pedidos: a simplificação de UX tem um efeito colateral real na arquitetura de aprovação que o documento anterior definia como proteção de custo — ver item 14. Não é um detalhe menor, é uma troca consciente que vale confirmar explicitamente antes de implementar.

---

## 1. Nova proposta de experiência simplificada

O fluxo deixa de ser um wizard de 7 etapas com aprovação obrogatória entre cada fase cara (texto → aprovar → imagem → aprovar → vídeo) e passa a ser: **1 tela mínima → 1 clique → o sistema gera o máximo possível sozinho → o usuário revisa o resultado já pronto, separado por marketplace, e só então decide o que aprovar, editar ou completar.**

A complexidade que antes era pedida ao usuário antes de gerar (marca, categoria, medidas, peso, quantidade de imagens, formato de vídeo etc.) não desaparece do sistema — ela vira **inferência automática em primeiro lugar** e **pergunta pontual depois**, só para o que não pôde ser confirmado. Isso não reduz o trabalho do pipeline; desloca quando a informação é coletada (antes de gerar → depois de gerar, sob demanda).

## 2. Novo fluxo principal em três etapas

1. **Entrada mínima:** nome do produto + 1 foto (obrigatória; mais fotos opcionais) + marketplace (ou "Todos").
2. **Um clique:** "Gerar anúncio completo" — dispara todo o pipeline automaticamente, sem nenhuma pergunta intermediária.
3. **Revisão do resultado:** conteúdo, imagens e vídeo já prontos, organizados por marketplace, com uma seção separada de pendências para o que não pôde ser confirmado — o usuário completa isso quando quiser, não antes.

## 3. Nova tela inicial

Substitui o wizard de 7 etapas do documento anterior (seção 9, Etapas 1-7) **só para o fluxo padrão**. Contém apenas:

- Campo "Nome do produto" (texto livre, único campo obrigatório de texto).
- Área de upload de foto (1 obrigatória, múltiplas opcionais, com indicação de qual é a principal — mesmo componente de upload já previsto no documento anterior, seção 10, só que sem os campos de texto ao redor).
- Seleção de marketplace: Mercado Livre / Shopee / Amazon / TikTok Shop / **Todos** (múltipla escolha ou "Todos" como atalho para selecionar os quatro).
- Botão "Gerar anúncio completo".
- Link discreto "Personalizar geração" (abaixo do botão, texto pequeno, não é um botão de mesmo peso visual — evita competir com a ação principal).

Tudo o que era Etapa 2 e Etapa 4-6 do documento anterior (marca, categoria, medidas, peso, material, conteúdo de embalagem, diferenciais, observações, quantidade de imagens, estilo, formato de vídeo, locução etc.) muda de "campo da tela inicial" para "campo dentro de Personalizar geração", todos opcionais, nenhum bloqueando o botão principal.

## 4. Nova tela de processamento

Mantém a ideia de progresso real por etapa (documento anterior, seção 7 e "tela de processamento" do pedido original), mas com uma camada de simplificação: por padrão, mostra um progresso único e compreensível ("Analisando produto" → "Criando conteúdo" → "Adaptando para cada marketplace" → "Gerando imagens" → "Gerando vídeo" → "Pronto"), não a lista técnica de jobs individuais. Um link "Ver detalhes técnicos" (mesmo princípio de progressive disclosure pedido para Personalizar geração) expande para o detalhamento por job, horário de início/fim, provedor usado — útil para o usuário avançado ou para suporte/depuração, não exigido do usuário comum.

Diferença estrutural em relação ao documento anterior: como agora existe adaptação por marketplace (item 12 abaixo), a barra de progresso precisa somar o progresso das N adaptações selecionadas ("Todos" = 4 pipelines de adaptação rodando), não só 1 pipeline linear.

## 5. Nova tela de resultados por marketplace

Uma aba (ou seção) por marketplace selecionado, com os campos exatamente como especificados no pedido:

| Marketplace | Campos exibidos |
|---|---|
| Mercado Livre | título, descrição, características, ficha técnica, perguntas frequentes, palavras-chave, imagens, vídeo, pendências |
| Shopee | título, descrição comercial, características, palavras-chave, imagens, vídeo vertical, texto promocional, pendências |
| Amazon | título, bullet points, descrição, termos de busca, ficha técnica, imagens, pendências |
| TikTok Shop | título, descrição curta, vídeo vertical, roteiro, texto na tela, legenda, chamadas de venda, pendências |

Cada aba tem sua própria caixa de pendências (item 6) — uma pendência de "peso" pode afetar Mercado Livre e Amazon (que mostram ficha técnica) e não afetar TikTok Shop (que não mostra ficha técnica), então pendências sãoavaliadas por marketplace quanto ao **impacto de exibição**, mesmo que a informação em si seja do produto como um todo (ver item 10, `estudio_ia_pendencias` continua em nível de projeto, não duplicada por marketplace).

## 6. Funcionamento das pendências

Caixa única, em linguagem simples ("Confirme estas informações para completar seu anúncio"), listando perguntas objetivas (ex.: "Qual é a medida do produto?", "O produto acompanha cabo?"). Cada pendência:

- Fica disponível para resposta a qualquer momento, sem bloquear a visualização do restante do anúncio já gerado.
- Ao ser respondida, dispara automaticamente um novo job (`atualizacao_pos_pendencia`, ver item 12) que recalcula **só o que depende daquele campo**: descrição, ficha técnica, atributos, imagem de medidas (se a pendência era medida), conteúdo do vídeo, e o pacote de cada marketplace afetado — nunca regenera do zero o que não dependia da resposta (mesmo princípio de "nunca recalcular período inteiro sem necessidade" já usado em `lib/resumos-diarios.ts`, aplicado aqui ao invés de datas: "nunca regenerar conteúdo inteiro sem necessidade").
- Uma pendência sem resposta não impede a exportação/uso do restante do anúncio; ela só some da caixa quando respondida ou explicitamente descartada pelo usuário ("não sei"/"não aplicável" também é uma resposta válida, e deveria interromper regeneração futura para aquele campo).

## 7. Separação entre campos obrigatórios e opcionais

| Campo | Obrigatório no fluxo padrão? | Onde vive agora |
|---|---|---|
| Nome do produto | **Sim** | Tela inicial |
| 1 foto do produto | **Sim** | Tela inicial |
| Marketplace (ou Todos) | **Sim** | Tela inicial |
| Marca, categoria, modelo, cor, material | Não | Personalizar geração (opcional) — se ausente, IA tenta inferir/confirmar visualmente |
| Medidas, peso, quantidade, conteúdo da embalagem | Não | Personalizar geração (opcional) — se ausente e não confirmável, vira pendência |
| Características, diferenciais, observações | Não | Personalizar geração (opcional) |
| Quantidade de imagens, formato, estilo, proporção | Não | Personalizar geração (opcional) — padrão: gerar o máximo possível automaticamente (ver item 12) |
| Duração de vídeo, locução, música, textos na tela | Não | Personalizar geração (opcional) |
| Palavras-chave, ficha técnica | Não (geradas automaticamente) | Nunca pedidas ao usuário no fluxo padrão — só editáveis depois, na revisão |

## 8. Alterações necessárias no mapa de telas

Em relação à seção 9 do documento anterior:

```
/estudio-ia                              → (sem mudança) lista de projetos
/estudio-ia/novo                         → SUBSTITUI o wizard: agora é 1 tela única
                                            (nome + foto + marketplace + botão),
                                            com painel "Personalizar geração"
                                            recolhido por padrão (mesma rota,
                                            não uma rota nova)
/estudio-ia/[projetoId]                  → (sem mudança estrutural) processamento,
                                            agora com progresso agregado por
                                            marketplace (item 4)
/estudio-ia/[projetoId]/resultado        → NOVA — substitui as 3 rotas antigas
                                            (/conteudo, /imagens, /video) por
                                            uma única tela com abas por
                                            marketplace, cada aba já mostrando
                                            texto+imagem+vídeo juntos (o pedido
                                            original de revisão em telas
                                            separadas por tipo de conteúdo dava
                                            lugar a uma revisão organizada por
                                            marketplace, que é como o resultado
                                            final é consumido)
/estudio-ia/[projetoId]/pendencias        → NOVA — pode ser seção dentro de
                                            /resultado em vez de rota própria;
                                            listada aqui separadamente só para
                                            deixar explícito que existe
/estudio-ia/[projetoId]/exportar         → (sem mudança)
```

As antigas `/conteudo`, `/imagens`, `/video` (documento anterior, seção 9) deixam de ser o desenho principal — ficam substituídas por abas dentro de `/resultado`, uma vez que o usuário agora revisa por marketplace, não por tipo de material.

## 9. Alterações necessárias nos componentes

Em relação à seção 10 do documento anterior:

- **Removido do fluxo padrão:** stepper/wizard de 7 etapas (deixa de ser necessário como navegação principal; pode continuar existindo só dentro de "Personalizar geração", como um formulário opcional de campos, não como progressão obrigatória).
- **Novo:** painel colapsável "Personalizar geração" (accordion/drawer, fechado por padrão).
- **Novo:** seletor de marketplace com opção "Todos" (diferente de uma lista simples — precisa comunicar visualmente "vou gerar 4 pacotes distintos").
- **Novo:** navegação por abas de marketplace na tela de resultado (componente de abas não existe em nenhuma tela atual do projeto, mesmo ponto já sinalizado no documento anterior sobre ausência de padrão de abas).
- **Novo:** caixa de pendências (lista de perguntas + campo de resposta inline, sem navegação para outra tela) — mais simples que um formulário completo, mais parecido com uma lista de tarefas curtas.
- **Mantido, sem mudança:** card de projeto (lista), grade de imagens com estado por item, player/preview de vídeo, comparador de versões, indicador de custo.
- **Simplificado:** barra de progresso — agora precisa de uma visão "resumida" (padrão) e uma "detalhada" (expandível), em vez de só a detalhada.

## 10. Alterações necessárias no banco

Em relação à seção 13 do documento anterior — mudanças pontuais, não um redesenho:

**Nova tabela — `estudio_ia_projetos_marketplace`** (necessária porque "Todos" faz 1 projeto gerar N adaptações independentes, cada uma com seu próprio progresso/status/conteúdo):

| Campo | Tipo |
|---|---|
| id | UUID PK |
| projeto_id | UUID NOT NULL REFERENCES estudio_ia_projetos(id) ON DELETE CASCADE |
| marketplace | TEXT NOT NULL CHECK (IN ('ML','Shopee','Amazon','TikTok Shop')) |
| status | TEXT NOT NULL DEFAULT 'aguardando' | mesmo vocabulário de status do projeto, mas por marketplace |
| criado_em, concluido_em | TIMESTAMPTZ | |

Único (`projeto_id, marketplace`) — "Todos" insere até 4 linhas, nunca duplicadas.

**`estudio_ia_projetos`:** perde a obrigatoriedade da coluna `marketplace` (documento anterior, 13.1) — o projeto passa a representar "a geração" como um todo; o marketplace específico migra para a nova tabela acima. `marketplace` pode continuar existindo na tabela do projeto como campo legado/resumo (ex.: "ML, Shopee" para exibição rápida na lista), mas deixa de ser a fonte de verdade.

**`estudio_ia_entradas_produto` (13.2):** sem mudança de schema — já era 100% opcional/nullable no desenho anterior. Só muda o comportamento da aplicação: antes, a tela pedia esses campos antes de gerar; agora, ficam vazios por padrão e são preenchidos (a) pela IA quando confirmável, (b) pelo usuário via "Personalizar geração" ou via resposta a uma pendência, depois.

**`estudio_ia_conteudo_versoes` (13.5):** passa a referenciar `projeto_marketplace_id` (novo FK) em vez de `projeto_id` diretamente — cada marketplace tem sua própria linha de versão de conteúdo, porque os campos são estruturalmente diferentes por marketplace (bullet points só existe na Amazon, roteiro só no TikTok). Proposta de simplificação adicional: em vez de manter dezenas de colunas típicas por marketplace (a maioria ficaria NULL para 3 dos 4 marketplaces), consolidar os campos específicos de marketplace em uma única coluna `conteudo JSONB NOT NULL`, mantendo como colunas típicas só o que é comum a todos (`titulo_principal`, `palavras_chave`) para permitir busca/índice. Isso é uma mudança de desenho em relação ao documento anterior (que propunha colunas típicas para tudo) — motivada diretamente pela multiplicação por marketplace que não existia antes.

**`estudio_ia_videos_gerados` (13.8):** ganha `projeto_marketplace_id` (vídeo vertical de Shopee e de TikTok Shop podem ter roteiro/duração diferentes mesmo usando as mesmas imagens de base) — diferente de imagens, que ficam compartilhadas.

**`estudio_ia_imagens_geradas` (13.7):** **sem mudança de FK** — continua ligada a `projeto_id` (pool compartilhado entre marketplaces), não a `projeto_marketplace_id`. Decisão de custo: gerar a "capa com fundo branco" uma vez e reaproveitar entre Mercado Livre/Shopee/Amazon é mais barato que gerar 4 vezes a mesma imagem para 4 marketplaces — proporção/corte específico por marketplace fica para a etapa de exportação/empacotamento, não para a etapa de geração.

**`estudio_ia_auditoria` (13.6):** o `CHECK` de `classificacao` ganha um valor novo: `'encontrada_em_fonte_externa'` (lista agora: confirmada_visualmente | informada_pelo_usuario | encontrada_em_fonte_externa | inferida_pela_ia | pendente_confirmacao | rejeitada_por_inconsistencia). Ver item 12 sobre quem produz essa classificação — não estava coberto pelos 3 provedores do documento anterior.

**Nova tabela — `estudio_ia_pendencias`:**

| Campo | Tipo |
|---|---|
| id | UUID PK |
| projeto_id | UUID NOT NULL REFERENCES estudio_ia_projetos(id) | em nível de projeto, não de marketplace — uma pendência de peso é do produto, não de um marketplace específico |
| campo | TEXT NOT NULL | ex.: "peso", "voltagem", "conteudo_embalagem" |
| pergunta | TEXT NOT NULL | texto exibido ao usuário |
| resposta | TEXT NULL | |
| respondida_em | TIMESTAMPTZ NULL | |
| criado_em | TIMESTAMPTZ NOT NULL DEFAULT now() | |

Índice (`projeto_id, respondida_em`) — localizar pendências em aberto rapidamente.

**Impacto no banco atual:** ainda zero — todas as mudanças acima são em tabelas que já eram novas/propostas no documento anterior, nenhuma delas chegou a ser criada. Nada em `pedidos`, `lojas`, `dashboard_resumos_diarios`, `sync_jobs` muda.

## 11. Alterações necessárias nas rotas

Em relação à seção 15 do documento anterior:

- `POST /api/estudio-ia/projetos` — payload mínimo agora é só `{ nome_produto, marketplaces: string[] | "todos" }` + a foto vai por rota separada de upload (sem mudança na rota de upload em si); todos os demais campos de `estudio_ia_entradas_produto` tornam-se opcionais no corpo da requisição (já eram opcionais no schema, mas antes o formulário os coletava antes de chamar esta rota — agora não).
- `POST /api/estudio-ia/projetos/[id]/iniciar` — passa a criar jobs para **todas as etapas do pipeline automaticamente**, incluindo `adaptacao_marketplace` × N (uma por marketplace selecionado), sem esperar aprovação intermediária por padrão (ver item 14 sobre o toggle "exigir aprovação manual entre etapas" para quem quiser o comportamento antigo).
- **Nova:** `GET /api/estudio-ia/projetos/[id]/pendencias` e `PATCH /api/estudio-ia/projetos/[id]/pendencias/[pendenciaId]` — listar e responder pendências; o PATCH é quem dispara os jobs de `atualizacao_pos_pendencia`.
- **Nova:** `GET /api/estudio-ia/projetos/[id]/resultado` — devolve o pacote completo já organizado por marketplace (título, descrição, imagens, vídeo, pendências relevantes àquele marketplace), consumida pela nova tela de resultado (item 8) em vez das 3 rotas antigas de conteúdo/imagens/vídeo separadas (que deixam de ser a interface principal, mas podem continuar existindo como rotas mais granulares para edição pontual de 1 imagem ou 1 vídeo específico).

## 12. Alterações necessárias no pipeline

Em relação à seção 7 e 8 do documento anterior — a mudança mais estrutural desta revisão:

| # | Etapa | Mudança |
|---|---|---|
| 4 | Análise visual | Sem mudança de responsável (OpenAI), mas agora **sempre tenta identificar tudo de uma vez** (tipo, categoria, cor, formato, componentes visíveis) em vez de só o que o usuário pediu — é a peça central que viabiliza "só nome + foto" |
| — | **Nova: busca em fonte externa** | Necessária para a classificação `encontrada_em_fonte_externa` do pedido do usuário (ex.: encontrar ficha técnica pública do fabricante a partir do nome do produto) — **não estava coberta por nenhum dos 3 provedores do documento anterior**. Sinalizado como decisão em aberto (item a seguir aqui e na seção de decisões): qual provedor faz isso (busca web via OpenAI? uma integração própria de busca? o próprio Claude com acesso a busca?) não foi definido pelo usuário nem neste pedido. Sem essa etapa, a classificação "encontrada em fonte externa" não tem como existir de fato. |
| 5-6 | Geração de conteúdo + revisão Claude | Sem mudança de responsável, mas o conteúdo gerado agora é um **rascunho-base único**, não já dividido por marketplace |
| — | **Nova: adaptação por marketplace** | 1 job por marketplace selecionado, depois da revisão do Claude — transforma o conteúdo-base no formato específico de cada marketplace (bullet points Amazon, roteiro TikTok etc.). Não existia como etapa própria no documento anterior (estava implícita dentro de "geração de conteúdo"). |
| 7 | Aprovação humana (texto) | **Deixa de ser um bloqueio obrigatório por padrão** — ver item 14, é a mudança mais sensível desta revisão |
| 8-9 | Prompts + geração de imagem | Sem mudança de responsável, mas a "quantidade desejada de imagens" deixa de ser input do usuário no fluxo padrão — o sistema tenta gerar o conjunto completo (capa, perspectiva, detalhes, benefícios, uso, embalagem-se-confirmável, promocional, medidas-se-confirmadas) automaticamente, marcando como pendente (não gerando) qualquer imagem que dependa de informação não confirmada |
| 10 | Aprovação humana (imagens) | Mesma observação do item 7 — deixa de bloquear por padrão |
| 11-12 | Roteiro + geração de vídeo | Sem mudança de responsável; formato agora decidido automaticamente por marketplace (vertical para Shopee/TikTok) em vez de perguntado ao usuário |
| 13 | Aprovação humana (vídeo) | Mesma observação — deixa de bloquear por padrão |
| — | **Nova: atualização pós-pendência** | Disparada sob demanda quando o usuário responde uma pendência (item 6) — recalcula só o que depende do campo respondido, nunca o projeto inteiro |

## 13. O que permanece igual no planejamento anterior

- Arquitetura de fila (`estudio_ia_jobs`, `claim_next_estudio_ia_job()`, heartbeat, retry classificado) — seção 13.4 do documento anterior, sem mudança.
- Necessidade de worker persistente como pré-requisito (Fase 0) — seção 2 e 25 do documento anterior, **reforçada, não enfraquecida**: mais jobs simultâneos (N marketplaces em paralelo) tornam a dependência de infraestrutura ainda mais crítica, não menos.
- Armazenamento privado, URLs assinadas, organização por usuário/projeto (seção 14).
- Sistema de custo/créditos, idempotência de débito por job (seção 17).
- Segurança: chaves só no servidor, verificação de propriedade, validação de upload (seção 18).
- Histórico e versionamento (`numero_versao` em conteúdo/imagem/vídeo) — seção 20, sem mudança de princípio (só de FK, ver item 10).
- Regra de nunca inventar informação técnica — reforçada, não alterada; a nova classificação `encontrada_em_fonte_externa` é uma extensão da mesma regra, não uma exceção a ela.
- Riscos técnicos e decisões em aberto do documento anterior (seções 25-26) continuam válidos e não estão resolvidos por esta revisão.

## 14. O que deve ser removido ou simplificado

- **Removido do fluxo padrão:** formulário extenso antes da geração (Etapas 2, 4, 5, 6 do wizard original) — vira "Personalizar geração", opcional.
- **Removido do fluxo padrão:** telas separadas de revisão por tipo de material (`/conteudo`, `/imagens`, `/video`) — viram abas dentro de uma única tela de resultado, organizadas por marketplace.
- **Simplificado:** "quantidade de imagens desejada"/"se deseja vídeo" deixam de ser perguntas — o padrão passa a ser "gerar o máximo possível", com a decisão de "gerar ou não vídeo" implícita em "há informação suficiente para um vídeo sem inventar especificação" (item Vídeo do pedido do usuário).
- **Ponto que exige decisão explícita, não simplesmente "removido":** os três gates de aprovação humana obrigatória (texto → antes de imagem; imagem → antes de vídeo) do documento anterior existiam especificamente para **evitar gastar em geração de imagem/vídeo a partir de conteúdo ainda não validado** (seção 21 do documento anterior, e seção 17 sobre controle de custo). O fluxo pedido agora ("um clique... o sistema gera o máximo possível") remove esses gates do caminho padrão — imagem e vídeo passam a ser gerados **antes** de qualquer aprovação humana do texto. Isso é uma troca real: menos cliques e mais velocidade percebida, em troca de gastar (créditos/custo de provedor) em imagem e vídeo de um anúncio cujo texto ainda pode ser corrigido depois. Proponho resolver isso com uma opção em "Personalizar geração": **"Exigir minha aprovação entre cada etapa"** (desligada por padrão, para manter a experiência de 1 clique; ligada, restaura o comportamento do documento anterior). Isso não estava no pedido do usuário — é uma recomendação minha para não descartar de vez a proteção de custo, e precisa ser confirmada ou rejeitada explicitamente, não assumida.

## 15. Critérios de aceite atualizados

Substituem/complementam a seção 29 do documento anterior:

- **Fase 1 (revisada):** criar um projeto informando só nome + 1 foto + marketplace(s) é suficiente para o botão "Gerar anúncio completo" ficar habilitado — nenhum outro campo bloqueia o clique.
- **Fase 2 (revisada):** com apenas nome + 1 foto, o sistema produz um rascunho de conteúdo e o Claude classifica cada campo usando as 6 categorias (incluindo `encontrada_em_fonte_externa`, se essa etapa for aprovada — ver item 12); qualquer campo não classificável aparece na caixa de pendências, nunca como fato.
- **Fase 2 (nova):** selecionar "Todos" gera 4 linhas em `estudio_ia_projetos_marketplace`, cada uma progredindo e podendo concluir de forma independente (uma pode falhar sem travar as outras três — mesmo princípio de isolamento por loja já usado em `sync_jobs`).
- **Fase 2 (nova):** responder 1 pendência dispara regeneração só dos campos/imagens/vídeo dependentes daquele campo, comprovável comparando timestamps de atualização antes/depois (equivalentes não deveriam mudar `atualizado_em`).
- **Fase 3 (revisada):** sem nenhuma configuração de imagem informada, o sistema tenta gerar o conjunto completo de finalidades (seção 12), com as que dependem de dado ausente aparecendo como pendentes, não inventadas.
- **Fase 4 (revisada):** vídeo gerado sem especificação técnica confirmada não contém nenhuma afirmação técnica não confirmada na locução/texto na tela — mesmo padrão de auditoria do texto aplicado ao roteiro de vídeo.
- **Novo critério transversal:** se a opção "Exigir minha aprovação entre cada etapa" (item 14) for implementada, alternar essa opção precisa mudar de fato o comportamento do pipeline (gates ativos/inativos), não só a interface.

## 16. Próximo prompt recomendado (Fase 0 e Fase 1)

Deveria conter, no mínimo:

1. Confirmação das decisões já pendentes do documento anterior (seção 26) — nenhuma foi resolvida por esta revisão de UX.
2. **Decisão nova, específica desta revisão:** quem/como cobre a etapa de "busca em fonte externa" (item 12) — sem isso, a classificação `encontrada_em_fonte_externa` não pode ser implementada e deveria ser removida do escopo da Fase 2, não deixada pela metade.
3. **Decisão nova, específica desta revisão:** aceitar ou rejeitar a proposta de gate de aprovação opcional (item 14) — afeta diretamente o desenho da Fase 2/3/4 e o cálculo de custo estimado (Fase 5).
4. Confirmação do modelo de dados revisado (item 10) — em especial, a divisão `estudio_ia_projetos` (geração) vs. `estudio_ia_projetos_marketplace` (adaptação por marketplace) e a consolidação de conteúdo específico de marketplace em JSONB.
5. Escopo fechado: Fase 1 continua sendo só schema + CRUD + upload, **sem geração de IA nenhuma** — a tela inicial simplificada (item 3) já pode ser construída nesta fase, mesmo sem o pipeline funcionando atrás dela (o botão "Gerar anúncio completo" pode existir e criar o projeto/jobs em `pendente` antes do worker existir de verdade).

---

## Confirmação final

O fluxo padrão, como revisado neste documento, exige exatamente e apenas:

- nome do produto;
- uma foto;
- marketplace (ou "Todos");
- um clique.

Todo o restante (marca, categoria, medidas, peso, material, quantidade de imagens, formato de vídeo, palavras-chave, ficha técnica, etc.) é opcional, vive em "Personalizar geração" ou é resolvido depois via a caixa de pendências — nunca é pré-requisito para o clique em "Gerar anúncio completo".
