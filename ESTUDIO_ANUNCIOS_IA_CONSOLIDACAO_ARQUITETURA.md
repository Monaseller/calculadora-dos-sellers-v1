# Central de IA — Consolidação Arquitetural (2ª revisão)

> Terceiro documento da série. Adendo a `ESTUDIO_ANUNCIOS_IA_PLANEJAMENTO.md` e `ESTUDIO_ANUNCIOS_IA_REVISAO_UX.md` — nenhum dos dois foi reescrito, só o que muda está registrado aqui. Nenhum código alterado, nenhuma migration criada, nenhum arquivo do projeto tocado.

Antes dos 18 itens pedidos: duas decisões desta rodada colidem diretamente com decisões já registradas nos documentos anteriores. Não resolvi essas colisões por conta própria — estão sinalizadas explicitamente onde aparecem (itens 3 e 4 abaixo), porque são o tipo de coisa que devo apontar, não suavizar.

---

## 0. Renomeação de escopo (necessária pela Decisão 1, aplicada em todo o resto do documento)

A introdução da **Central de IA** como guarda-chuva muda o que é "específico do Estúdio de Anúncios" vs. "compartilhado entre todos os módulos futuros". O prefixo `estudio_ia_*` usado nos dois documentos anteriores ficou ambíguo (parecia geral, mas era só do primeiro módulo). Proposta de renomeação:

| Nome anterior (documentos 1 e 2) | Nome novo proposto | Escopo |
|---|---|---|
| `estudio_ia_projetos` | `estudio_anuncios_projetos` | específico do módulo Estúdio de Anúncios |
| `estudio_ia_projetos_marketplace` | `estudio_anuncios_projetos_marketplace` | idem |
| `estudio_ia_entradas_produto` | `estudio_anuncios_entradas_produto` | idem |
| `estudio_ia_imagens_origem` | `estudio_anuncios_imagens_origem` | idem |
| `estudio_ia_jobs` | `estudio_anuncios_jobs` | idem (fila é por módulo — ver item 4) |
| `estudio_ia_conteudo_versoes` | `estudio_anuncios_conteudo_versoes` | idem |
| `estudio_ia_auditoria` | `estudio_anuncios_auditoria` | idem |
| `estudio_ia_imagens_geradas` | `estudio_anuncios_imagens_geradas` | idem |
| `estudio_ia_videos_gerados` | `estudio_anuncios_videos_gerados` | idem |
| `estudio_ia_pendencias` | `estudio_anuncios_pendencias` | idem |
| `estudio_ia_pacotes_exportacao` | `estudio_anuncios_pacotes_exportacao` | idem |
| `estudio_ia_consumo` | **`central_ia_consumo`** | **compartilhado** — todo módulo futuro registra custo aqui, não uma tabela de custo por módulo |
| `estudio_ia_creditos` / `estudio_ia_creditos_lancamentos` | **`central_ia_creditos`** / **`central_ia_creditos_lancamentos`** | **compartilhado** — 1 saldo por usuário, vale para todos os módulos |

Tabelas inteiramente novas desta rodada já nascem com o prefixo correto (`central_ia_*` quando compartilhadas, `estudio_anuncios_*` quando específicas) — ver itens 5-9.

Esta é uma proposta de nomenclatura, não uma decisão fechada — segue a mesma ressalva já registrada no documento 1 (nome definitivo pendente de confirmação).

---

## 1. Todas as alterações provocadas pelas decisões acima

Resumo executivo das 10 decisões, antes do detalhamento pedido nos itens 2-18:

- **Decisão 1** transforma o módulo único em um sistema de módulos (Central de IA), exigindo uma camada de infraestrutura compartilhada (créditos, biblioteca de produtos, biblioteca de prompts, histórico) que nenhum dos dois documentos anteriores separava do módulo específico.
- **Decisão 2** introduz uma camada de abstração (AI Gateway) entre a CDS e os provedores — nenhum módulo (nem o Estúdio de Anúncios, nem futuros) chama OpenAI/Claude/Google diretamente.
- **Decisão 3** reintroduz "quantidade de imagens" como campo obrigatório do fluxo rápido — **isto reverte parcialmente** o que `ESTUDIO_ANUNCIOS_IA_REVISAO_UX.md` (item 12) definiu ("quantidade de imagens deixa de ser input do usuário no fluxo padrão"). Tratado como a versão vigente agora, mas registrado como reversão, não como continuidade silenciosa.
- **Decisão 4** formaliza "Personalizar geração" (um link discreto, no documento 2) em um seletor de modo de primeira classe (Rápido/Profissional).
- **Decisões 5 e 6** criam duas bibliotecas compartilhadas (produtos, prompts) que não existiam em nenhuma versão anterior.
- **Decisão 7** resolve uma pergunta que o documento 2 tinha deixado em aberto (quem/quando faz busca externa) — mas com uma ambiguidade própria, sinalizada no item correspondente.
- **Decisão 8** adiciona uma etapa de pipeline inteiramente nova (score do anúncio) que não existia em nenhum dos dois documentos anteriores.
- **Decisão 9** formaliza a exibição de custo por projeto — já estava previsto em princípio (documento 1, seção 17), agora com o detalhamento exato de campos.
- **Decisão 10** confirma que nada da arquitetura técnica de execução muda — usada aqui como restrição, não como item a detalhar de novo.

---

## 2. Quais partes do planejamento original mudam

- Nome/estrutura do módulo (era "Estúdio de Anúncios com IA" como módulo único; passa a ser "Central de IA" com "Estúdio de Anúncios" como primeiro módulo dentro dela).
- Camada de integração com provedores (era chamada direta por módulo; passa a ser via Gateway único).
- Campos obrigatórios do fluxo rápido (ganha "quantidade de imagens").
- Estrutura da tela inicial (o link discreto vira um seletor de modo).
- Escopo de "Personalizar geração" (passa a ser todo o conteúdo do Modo Profissional, não só alguns campos avançados soltos).
- Prefixo de nomenclatura de tabelas (ver item 0).
- Pipeline ganha 2 etapas novas: verificação de produto semelhante (Decisão 5) e cálculo de score (Decisão 8).
- Custo/consumo deixa de ser por módulo e passa a ser central, com quebra por projeto quando exibido (Decisão 9).

## 3. Quais partes permanecem iguais

- Regra de nunca inventar informação técnica, com as 6 classificações (documento 2, item 10) — sem mudança.
- Fluxo de pendências (documento 2, item 6) — sem mudança de mecanismo, só passa a conviver com o score (Decisão 8) na mesma tela de resultado.
- Separação por marketplace na tela de resultado (documento 2, itens 5 e 8) — sem mudança.
- Toda a arquitetura de execução listada na Decisão 10 (worker, jobs, pipeline, retry, heartbeat, storage, versionamento, histórico por versão, segurança, custos como conceito, exportação) — confirmada como já estava, ver item 13 abaixo para o detalhe de onde o Gateway se encaixa sem alterar essas peças.
- A pergunta em aberto sobre onde roda o worker persistente (Fase 0, documento 1) — continua sem solução, e agora com peso maior (ver item 4/riscos).

---

## 4. Impacto dessas decisões na arquitetura

```
CDS (Central de IA)
├── Estúdio de Anúncios (módulo, fila própria: estudio_anuncios_jobs)
├── Atendimento IA, Redes Sociais, SEO, Copywriter, Traduções, Marketing (futuros — cada um teria sua própria fila de jobs por módulo, mesmo padrão)
│
├── Biblioteca de Produtos (central_ia_biblioteca_produtos — compartilhada entre módulos)
├── Biblioteca de Prompts (central_ia_prompts — compartilhada, alimentada pelo Gateway)
├── Créditos (central_ia_creditos — compartilhado, 1 saldo por usuário)
├── Histórico (visão consolidada entre módulos — ver item 14)
└── Configurações (da Central de IA especificamente, não do CDS como um todo)
        │
        ▼
   AI GATEWAY (lib/ai-gateway/*, ponto único de saída para IA externa)
        │
        ├── decide provedor/modelo por tipo de tarefa
        ├── registra em central_ia_prompts (cada chamada = 1 linha)
        ├── registra em central_ia_consumo (custo/tempo/tokens agregados)
        └── classifica falha (mesmo vocabulário de erro_tipo já usado em sync_jobs/estudio_anuncios_jobs)
        │
        ▼
   OpenAI · Claude (Anthropic) · Google · DeepSeek · futuros
```

Consequência arquitetural mais importante: **cada módulo futuro (Atendimento IA, SEO, etc.) não precisa reconstruir integração com IA, custo, prompt, nem crédito — só precisa ter sua própria fila de jobs e suas próprias telas, e chamar o Gateway.** Isso só funciona se a linha entre "o que é do módulo" e "o que é central" for mantida rigorosamente — é exatamente o que o item 0 (renomeação) tenta garantir desde a nomenclatura.

Risco reforçado (não novo, já estava no documento 1, seção 25): a Fase 0 (worker persistente) agora precisa suportar não 1 fila (`sync_jobs`), não 2 (`sync_jobs` + `estudio_anuncios_jobs`), mas potencialmente N filas (uma por módulo futuro) rodando no mesmo processo ou em processos irmãos. Vale decidir agora se o worker é **genérico** (1 processo que sabe processar job de qualquer módulo, incluindo `sync_jobs`) ou **por módulo** (1 processo por fila) — não decidido neste documento, listado no item 18.

---

## 5. Impacto no banco

Além da renomeação (item 0), tabelas novas necessárias:

**`central_ia_biblioteca_produtos`** (Decisão 5)
`id, user_id, produto, marca, categoria, criado_em, atualizado_em`. Campo de similaridade a decidir (ver item 9) — texto simples (nome/categoria/marca) ou vetor de embedding (exigiria extensão `pgvector`, **não usada em nenhum lugar deste projeto hoje** — capacidade nova, mesma categoria de "primeira vez" já sinalizada para Storage no documento 1).

**`central_ia_biblioteca_produtos_versoes`** — liga um produto da biblioteca às versões de conteúdo/imagem/vídeo já aprovadas (`estudio_anuncios_conteudo_versoes.id`, `estudio_anuncios_imagens_geradas.id`, etc.) que podem ser reaproveitadas — tabela de associação, não duplica dado.

**`estudio_anuncios_projetos.biblioteca_produto_id`** (novo FK, nullable) — liga um projeto a um produto da biblioteca, quando o usuário aceita reutilizar.

**`central_ia_prompts`** (Decisão 6)
`id, modulo TEXT, projeto_id UUID NULL, tipo TEXT CHECK (IN ('texto','imagem','video','seo','revisao','auditoria')), provedor, modelo, versao_modelo, temperatura, prompt_texto, resultado_resumo, tempo_ms, custo, nota INT NULL, reutilizacoes INT NOT NULL DEFAULT 0, criado_em`. `projeto_id` não tem FK rígida para uma tabela específica (pode ser de qualquer módulo) — proposta: coluna `modulo` + `projeto_id` como referência solta (sem `REFERENCES`), documentada, não impondo integridade referencial cruzada entre módulos (mesmo trade-off que projetos poliformficos sempre têm — registrado como decisão consciente, não descuido).

**`estudio_anuncios_score`** (Decisão 8)
`id, projeto_marketplace_id UUID NOT NULL REFERENCES estudio_anuncios_projetos_marketplace(id), nota_seo, nota_titulo, nota_descricao, nota_imagens, nota_video, nota_geral (todos NUMERIC), conversao_estimada NUMERIC NULL, sugestoes JSONB, criado_em`. Por marketplace, não por projeto (um anúncio pode pontuar melhor na Shopee que na Amazon, faz sentido serem notas independentes).

**`estudio_anuncios_projetos.permitir_busca_externa`** (novo campo BOOLEAN NOT NULL DEFAULT false) — Decisão 7, registra o consentimento explícito do usuário.

**Consumo/créditos:** só renomeação (item 0), sem mudança de schema em relação ao documento 1, seção 13.9-13.10 — os campos já propostos (`provedor`, `modelo`, `tokens_entrada/saida`, `custo_estimado/real`) já cobrem o detalhamento pedido na Decisão 9 (OpenAI/Claude/Google/Total é uma agregação `GROUP BY provedor`, não uma coluna nova).

**Impacto em tabelas já existentes do CDS (`pedidos`, `lojas`, `sync_jobs`, `dashboard_resumos_diarios`):** continua zero.

---

## 6. Impacto nas APIs

- **Nova camada, não uma rota HTTP pública:** `lib/ai-gateway/` não é exposto como `/api/*` para o frontend — é uma biblioteca chamada de dentro do worker (mesmo princípio de nunca chamar IA de dentro de uma rota síncrona, documento 1, seção 5). Não cria rota nova por si só.
- `POST /api/estudio-anuncios/projetos` (renomeado de `/api/estudio-ia/projetos`, ver item 0) — payload ganha `quantidade_imagens` (Decisão 3: `4 | 6 | 8 | 10 | number` quando "Personalizado") e `permitir_busca_externa` (Decisão 7, default false).
- **Nova:** `GET /api/central-ia/biblioteca-produtos/semelhantes?nome=&marca=&categoria=` — chamada antes (ou logo após) o envio do nome/foto, para a checagem de produto semelhante (Decisão 5). Roda de forma síncrona e rápida (é busca, não geração) — não passa pelo worker.
- **Nova:** `POST /api/estudio-anuncios/projetos/[id]/reutilizar` — aplica a estrutura de um produto da biblioteca ao novo projeto, quando o usuário aceita a sugestão.
- **Nova:** `GET /api/central-ia/prompts` (biblioteca de prompts, para tela de consulta/edição) e `PATCH /api/central-ia/prompts/[id]` (só para editar `nota`, não o conteúdo histórico do prompt em si — isso quebraria o próprio histórico).
- **Nova:** `GET /api/central-ia/creditos` (renomeado de `/api/estudio-ia/creditos`) — agora explicitamente compartilhado entre módulos, não específico do Estúdio de Anúncios.
- **Nova:** `GET /api/central-ia/historico` — visão consolidada entre módulos (ver item 14).

---

## 7. Impacto na interface

- Tela inicial (documento 2, item 3) ganha: seletor de quantidade de imagens (chips `4/6/8/10/Personalizado`, `8` marcado por padrão) como 4º campo obrigatório; e um seletor de modo **Rápido/Profissional** no lugar do link discreto "Personalizar geração" (Decisão 4) — visualmente, um switch/segmented control no topo da tela, não mais um link de canto.
- Quando o usuário digita nome + envia foto, antes (ou logo depois) de clicar em gerar, se a Biblioteca de Produtos encontrar algo semelhante, aparece uma confirmação intermediária: "Encontramos um produto parecido. Deseja reutilizar a estrutura existente?" com opção de aceitar (pré-preenche o que for reaproveitável) ou seguir do zero — não bloqueia o clique final, é um passo opcional que só aparece quando há semelhança detectada.
- Tela de resultado por marketplace (documento 2, item 5) ganha um bloco de **Score do anúncio** por aba (nota geral + notas por critério + lista de sugestões) — abaixo do conteúdo, antes das pendências, ou como uma aba própria dentro da aba do marketplace (a decidir na Fase 3, não neste documento).
- Custo (Decisão 9) — painel por projeto mostrando os 4 números (OpenAI/Claude/Google/Total) + tempo + contagens — pode reaproveitar o "indicador de custo estimado/consumido" já previsto no documento 1 (seção 10), só detalhando por provedor em vez de 1 número único.

## 8. Impacto na Central de IA

Este item é, em essência, uma reafirmação do item 4: a Central de IA é a peça que **generaliza** o que antes era específico do Estúdio de Anúncios. Concretamente:

- O item de menu lateral (`components/Sidebar.tsx`) deixa de ser "Estúdio com IA" (1 entrada) e passa a ser "Central de IA" (1 entrada, apontando para uma página própria).
- **Ponto técnico a decidir, não assumido aqui:** o Sidebar atual (`components/Sidebar.tsx`, lido no documento 1) é uma lista plana, sem submenu/expansão — não existe nenhum padrão de menu aninhado em todo o projeto hoje. Recomendo que "Central de IA" seja 1 entrada única no Sidebar, levando a uma página própria (`/central-ia`) que exibe os 6 itens (Estúdio de Anúncios, Biblioteca de Produtos, Biblioteca de Prompts, Histórico, Créditos, Configurações) como **cards de navegação**, reaproveitando o mesmo padrão visual de "cards de projetos recentes" já previsto no documento 1 (seção "página principal do módulo") — em vez de inventar um submenu lateral expansível, que seria um componente novo sem precedente no projeto. Isto é uma recomendação, não uma decisão do usuário — precisa de confirmação.
- Módulos futuros (Atendimento IA, Redes Sociais, SEO, Copywriter, Traduções, Marketing) entrariam como novos cards nessa mesma página, cada um com sua própria fila de jobs e telas, todos compartilhando Gateway/Biblioteca de Prompts/Créditos.

## 9. Novas tabelas necessárias (consolidação de tudo listado nos itens 5 e 0)

| Tabela | Escopo |
|---|---|
| `central_ia_biblioteca_produtos` | compartilhada |
| `central_ia_biblioteca_produtos_versoes` | compartilhada |
| `central_ia_prompts` | compartilhada |
| `central_ia_consumo` (renomeada) | compartilhada |
| `central_ia_creditos` / `central_ia_creditos_lancamentos` (renomeadas) | compartilhada |
| `estudio_anuncios_score` | específica do módulo |
| Todas as demais de `estudio_anuncios_*` (renomeadas do documento 1/2, sem mudança de campo) | específicas do módulo |

Ponto em aberto, registrado explicitamente (Decisão 5 exige, não é suposição minha): **mecanismo de detecção de semelhança.** Duas opções, nenhuma decidida:
(a) comparação textual simples (nome/marca/categoria) — mais simples, sem dependência nova, mais impreciso;
(b) busca por similaridade vetorial (embeddings + extensão `pgvector`) — mais precisa, mas é uma capacidade **inteiramente nova** para este banco (nenhuma migration existente usa `pgvector` ou qualquer índice vetorial). Recomendo começar por (a) na Fase 1/2 e considerar (b) só se a precisão de (a) se mostrar insuficiente na prática — mas isto é uma recomendação, não uma decisão tomada.

## 10. Novos componentes necessários

- Seletor de quantidade de imagens (chips, Decisão 3).
- Switch Modo Rápido / Modo Profissional (Decisão 4) — substitui o link discreto do documento 2.
- Cartão de confirmação "produto semelhante encontrado" (Decisão 5).
- Bloco/cartão de Score do anúncio com lista de sugestões (Decisão 8).
- Painel de custo detalhado por provedor (Decisão 9) — evolução do indicador já previsto, não um componente do zero.
- Página/grade de navegação da Central de IA (item 8) — cards para os 6 itens do menu.
- Tela de consulta da Biblioteca de Prompts (lista + filtro por tipo/modelo/nota) — nova, sem precedente visual no projeto (mais próxima de uma tabela do que de um card).

## 11. Novas rotas necessárias

Consolidado do item 6: `GET/POST /api/central-ia/biblioteca-produtos*`, `POST /api/estudio-anuncios/projetos/[id]/reutilizar`, `GET/PATCH /api/central-ia/prompts*`, `GET /api/central-ia/creditos`, `GET /api/central-ia/historico`. Renomeação de todas as rotas `/api/estudio-ia/*` do documento 1 para `/api/estudio-anuncios/*` (consistente com o item 0).

## 12. Atualização do fluxo completo

1. Usuário acessa Central de IA → escolhe Estúdio de Anúncios.
2. Modo Rápido (padrão): nome do produto, foto, marketplace(s), quantidade de imagens (8 por padrão) → "Gerar anúncio completo". Modo Profissional: mesmos 4 campos + todos os parâmetros avançados visíveis de uma vez (sem link escondido).
3. Se a Biblioteca de Produtos encontrar algo semelhante, oferece reutilização antes de prosseguir.
4. Pipeline roda (item 13) via Gateway, nunca direto aos provedores.
5. Resultado por marketplace, agora incluindo Score + sugestões, além do conteúdo/imagem/vídeo/pendências já previstos.
6. Pendências respondidas disparam atualização parcial, como já definido (documento 2, item 6) — incluindo recálculo do Score quando o campo respondido afetar alguma nota.
7. Custo/consumo de tudo isso alimenta `central_ia_consumo`/`central_ia_prompts`, visível tanto no projeto quanto na tela central de Créditos.

## 13. Atualização do pipeline

Em relação ao documento 2 (item 12):

| Etapa | Mudança |
|---|---|
| Análise visual, geração de conteúdo, revisão Claude, adaptação por marketplace, geração de imagem/vídeo | **Sem mudança de responsável ou ordem** — só passam a ser chamadas através do Gateway em vez de diretamente (Decisão 2), o que é uma troca de "quem faz a chamada HTTP" em `lib/`, não uma troca de lógica de negócio |
| Busca externa | Deixa de ser automática por padrão — só roda se `permitir_busca_externa=true` (consentimento explícito) **ou** se for "necessária para completar informação específica" (Decisão 7). **Ambiguidade sinalizada:** essas duas condições em "ou" podem significar que o sistema pesquisa mesmo sem consentimento quando julgar necessário — o que conflitaria com "somente quando autorizada pelo usuário". Preciso que isso seja esclarecido antes da Fase 2: a segunda condição é uma exceção ao consentimento, ou só se aplica quando o consentimento já foi dado e a pergunta é apenas "para quais campos especificamente"? |
| **Nova: verificação de produto semelhante** | Roda antes de criar os jobs de geração (é consulta, não geração — não precisa do worker) |
| **Nova: cálculo de score** | Roda depois da adaptação por marketplace + geração de imagem/vídeo, 1 vez por `projeto_marketplace_id`, refeita quando pendência relevante for respondida |

**Ponto de atenção sobre retry, não resolvido aqui:** a Decisão 2 pede que o Gateway registre falhas — se o Gateway também reter internamente (ex.: reintentar a chamada HTTP ao provedor), e o job (`estudio_anuncios_jobs`) também aplicar seu próprio retry (`tentativas`/`max_tentativas`, herdado de `sync_jobs`), o número real de tentativas pode multiplicar (3 do Gateway × 3 do job = até 9). Precisa ficar definido qual camada é dona do retry — não decidido neste documento, ver item 18.

## 14. Atualização do histórico

O "Histórico" da Decisão 1 é um item de menu **da Central de IA**, diferente do versionamento por projeto (documento 1, seção 20, que continua existindo sem mudança — `numero_versao` em conteúdo/imagem/vídeo). Proposta: uma visão consolidada, entre módulos, de eventos relevantes (projeto criado, versão aprovada, exportação gerada, etc.), não uma tabela de versionamento nova. Recomendo uma tabela leve e opcional, `central_ia_eventos` (`modulo, projeto_id, tipo_evento, descricao, criado_em`), alimentada pelas próprias rotas de cada módulo — mais simples de consultar do que fazer `UNION` entre tabelas de módulos diferentes toda vez que a tela de Histórico for aberta. Proposta, não decisão fechada.

## 15. Atualização dos custos

Já coberto nos itens 5 e 9 — resumo: `central_ia_consumo` (renomeada) é a fonte única, o Gateway é quem escreve nela a cada chamada (Decisão 2), e a tela de custo por projeto (Decisão 9) e a tela de Créditos (Decisão 1) são duas visões diferentes da mesma tabela — por projeto, e agregada por usuário, respectivamente.

## 16. Atualização do armazenamento

Sem mudança de mecanismo em relação ao documento 1 (seção 14) — buckets privados, URLs assinadas, organização por usuário/projeto. Adição: se a Biblioteca de Produtos permitir reaproveitar imagens aprovadas (Decisão 5), o caminho de armazenamento não deve ser copiado fisicamente a cada reutilização — apenas referenciado (a linha em `estudio_anuncios_imagens_geradas` de um novo projeto aponta para o mesmo `storage_path` já existente, quando reaproveitada), para não duplicar armazenamento nem custo de geração.

## 17. Atualização da documentação

Em relação ao documento 1 (seção "Documentação"): os mesmos arquivos (`PROJECT_CONTEXT.md`, `ROADMAP.md`, `DATABASE.md`, `API_RULES.md`, `BUSINESS_RULES.md`, `DECISIONS.md`, `CHANGELOG.md`) precisarão registrar, adicionalmente: a existência da Central de IA como conceito (não só o Estúdio de Anúncios), o AI Gateway como novo componente de arquitetura central (provavelmente merece sua própria nota em `DECISIONS.md`, no mesmo nível de detalhe que `sync_jobs` recebeu), e a renomeação de tabelas do item 0 (para não haver dois nomes concorrentes documentados para a mesma coisa). Nada disso foi alterado nesta etapa.

---

## 18. Próximo prompt recomendado (Fase 0 e Fase 1)

Além do que já constava nos documentos anteriores, esta consolidação adiciona às decisões pendentes:

1. **Onde roda o worker** — agora com a pergunta adicional: 1 worker genérico para todas as filas (incluindo `sync_jobs`) ou 1 processo por módulo/fila?
2. **Qual camada é dona do retry** — Gateway ou job (item 13) — para não multiplicar tentativas em chamadas caras.
3. **Ambiguidade da Decisão 7** — "autorizada pelo usuário" e "necessária para completar informação" são condições alternativas de verdade, ou a segunda só se aplica dentro da primeira?
4. **Mecanismo de similaridade da Biblioteca de Produtos** — comparação textual simples (Fase 1/2) ou embeddings vetoriais (`pgvector`, capacidade nova) — recomendo começar simples, mas não decidido.
5. **Padrão de navegação da Central de IA** — página com cards (minha recomendação, item 8) ou submenu no Sidebar (padrão novo, sem precedente) — precisa confirmação antes de desenhar a tela.
6. Confirmação da renomeação de tabelas (item 0) antes de escrever qualquer migration.
7. Escopo da Fase 1 continua sendo só schema + CRUD + upload — **sem Gateway funcional ainda** (o Gateway pode ser desenhado/roteado na Fase 1, mas só precisa de fato chamar um provedor externo a partir da Fase 2, quando a geração de conteúdo entra em cena).

---

## Confirmação final

A experiência padrão do usuário, confirmada por esta consolidação, é exatamente:

1. Digitar o nome do produto.
2. Enviar uma foto.
3. Escolher os marketplaces.
4. Escolher a quantidade de imagens.
5. Clicar em "Gerar anúncio completo".

Todo o restante — análise visual, geração de conteúdo, revisão, adaptação por marketplace, geração de imagem/vídeo, cálculo de score, registro de custo e prompt — acontece automaticamente, através da Central de IA e do AI Gateway, sem exigir nenhuma outra ação do usuário nesse momento.
