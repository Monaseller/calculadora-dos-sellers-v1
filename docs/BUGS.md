# BUGS.md — Bugs conhecidos (CDS)

> Status: 🔴 aberto crítico | 🟠 aberto médio | 🟡 aberto baixo | ✅ corrigido | 🔎 em investigação

## Corrigidos (auditoria 03/07/2026 — ver AUDITORIA_FINAL.md e RELATORIO_FASE1.md para detalhe)

- ✅ H1 — `GET /api/perfil` retornava `senha` em plaintext para o cliente.
- ✅ H2 — Callback OAuth ML não tratava erro/expiração de `code` (crash silencioso).
- ✅ H3 — Cadastro criava conta com `email_verificado: true` (bypass de verificação).
- ✅ M1 — DateRangePicker sem presets de 15/30/90 dias.
- ✅ M2 — Avatar do TopBar hardcoded ("R") em vez de dinâmico.
- ✅ M3 — `shopeePost()` sem timeout, podia travar indefinidamente.
- ✅ C1 — Rotas `historico`, `comparativo`, `suporte` retornavam 404.
- ✅ C2 — Dashboard com double-load (deps reativas erradas no `useCallback`).
- ✅ BUG-PIPE-1 — Sync Shopee descartava pedidos silenciosamente por usar `pay_time` quando a API foi consultada por `create_time`.
- ✅ BUG-PIPE-2 — Faturamento calculado como `preço_item × qtd` em vez de `total_amount` oficial (ignorava frete/voucher).
- ✅ BUG-PIPE-3 — `pedidosUnicos` contava pedidos cancelados; `faturamento` não.
- ✅ SEC1 — `claim_next_sync_job()` e `claim_next_estudio_anuncios_job()` com `EXECUTE` aberto para `anon`/`authenticated` apesar do `REVOKE ... FROM PUBLIC` nas migrations. Ver seção própria abaixo para detalhe e causa.

## Corrigido — EXECUTE de funções RPC aberto para anon/authenticated (2026-08-03)

- ✅ **`claim_next_sync_job()` e `claim_next_estudio_anuncios_job()` chamáveis via chave anon.** Encontrado durante a validação de leitura da Fase 0 da Central de IA: mesmo com `REVOKE EXECUTE ... FROM PUBLIC` presente nas duas migrations (`20260711_sync_jobs.sql`, `20260803_central_ia_estudio_anuncios_schema.sql`), `information_schema.routine_privileges` mostrava `EXECUTE` concedido também a `anon` e `authenticated` nas duas funções.
  **Causa:** uma regra de `ALTER DEFAULT PRIVILEGES` no schema `public` deste projeto Supabase concede `EXECUTE` automaticamente a `anon`/`authenticated`/`service_role` em toda função nova, no momento da criação — independente do `REVOKE FROM PUBLIC`, que só afeta o pseudo-role `PUBLIC`, não esses roles específicos.
  **Risco:** as duas funções fazem `FOR UPDATE SKIP LOCKED` + `UPDATE ... SET status='rodando'` — reivindicam um job real. Com `EXECUTE` aberto, qualquer chamada usando a chave anon pública poderia reivindicar um job, mesmo sem nenhuma rota da aplicação chamar essa função diretamente hoje.
  **Corrigido em produção (2026-08-03)** com `REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated` + `GRANT EXECUTE ... TO service_role` para as duas funções. Validado por leitura (`information_schema.routine_privileges`: só `postgres`/`service_role` restam) e por impersonação transacional (`SET LOCAL ROLE anon`/`authenticated` dentro de `BEGIN`/`ROLLBACK`, retornando `42501 permission denied` nos dois casos, para as duas funções). Migrations locais atualizadas para refletir o `REVOKE` correto em futuras instalações — ver `20260711_sync_jobs.sql` e `20260803_central_ia_estudio_anuncios_schema.sql`.
  **Não verificado:** se outras funções `SECURITY`/RPC já existentes no projeto (fora das duas checadas aqui) têm o mesmo problema. Recomenda-se auditoria geral de `information_schema.routine_privileges` para todo `pg_proc` do schema `public` numa tarefa futura.

## Corrigido — Estúdio de Anúncios (2026-08-12)

- ✅ **Retry do Pipeline apagava a causa da falha — CORRIGIDO e validado por teste comportamental.**
  `estudio_anuncios_pipeline_registrar_falha()`, passo 4, zerava `erro_tipo`/`erro_mensagem` do job a cada reenfileiramento, destruindo a causa de toda tentativa que não fosse a última.
  **Correção:** `supabase/migrations/20260812_preservar_erro_no_retry.sql` — o `UPDATE` do job no branch de retry passou a ser só `SET status = 'pendente'`. Semântica de retry inalterada.
  **Causa da demora:** a migration havia sido reportada como executada em duas ocasiões, mas `pg_get_functiondef()` provou que a versão antiga continuava instalada (2 ocorrências de `erro_tipo = NULL` contra 1 da versão nova). Aplicada de fato em 2026-08-12 via conexão PostgreSQL direta (Session Pooler), com `COMMIT` confirmado.
  **Validação pós-aplicação:** 1 overload apenas, `SECURITY INVOKER`, `search_path=public`, `EXECUTE` só para `postgres`/`service_role`.
  **Teste comportamental — 26/26 verificações, custo zero:** cenário isolado (projeto `b5f916fb-…`, job `7a3981a9-…`, etapa `busca_externa`, que está no catálogo mas fora de `ETAPAS_SUPORTADAS_FASE1` e por isso falha em `validation` no executor, antes de qualquer provedor). Tentativa 1: job volta a `pendente`, `tentativas=1`, `erro_tipo='validation'` **preservado**, `erro_mensagem` preservada, pipeline em `aguardando` com erro próprio limpo. Tentativa 2: mesmo job, `tentativas=2`, erro segue observável e reflete a falha mais recente. Tentativa 3 (terminal): job em `erro` com `tentativas=3/3` e causa preservada, pipeline em `erro` com `erro_tipo`/`erro_mensagem` preenchidos e **coerentes com o job**. `claim_next_estudio_anuncios_job()` reivindicou normalmente nas três execuções. Zero prompts e zero consumo de IA em todo o teste.
  **Resíduo neutralizado, nunca apagado:** projeto de teste marcado `cancelado`; job e pipeline preservados como evidência; fila global com 0 jobs reivindicáveis e 0 rodando.

## 🔴 INCIDENTE DE CREDENCIAL — ML_CLIENT_SECRET publico no GitHub (2026-09-01)

- 🔴 **`ML_CLIENT_SECRET` esteve (e continua) exposto em repositorio PUBLICO.** O arquivo rastreado `4-configurar-env-vercel.vbs` passava credenciais por `echo` para `vercel env add`, com os valores em texto puro: o **client secret do Mercado Livre**, a URL do projeto Supabase e a chave publishable. Entrou no historico no commit `ebd4400` e o repositorio `github.com/Monaseller/calculadora-dos-sellers-v1` e **publico** (`"private": false`, confirmado pela API do GitHub). Ultimo push publico: 2026-07-16.
  **O que foi feito:** os valores foram removidos do arquivo na working tree (commit desta data), para que nao sejam recommitados.
  **O que NAO foi feito, e por que:** o historico **nao** foi reescrito. Reescrever nao desfaz o que ja e publico — o valor pode ja ter sido clonado, indexado por buscadores ou capturado por varredores automaticos de segredo, que sao rotina no GitHub. Alem disso, reescrever historico publico quebra todos os clones existentes e e decisao de quem administra o repositorio, nao efeito colateral de uma tarefa de deploy.
  **UNICA CORRECAO REAL — acao do dono:** **rotacionar o `ML_CLIENT_SECRET`** no painel de desenvolvedor do Mercado Livre e atualizar a variavel na Vercel. Enquanto nao for rotacionado, o segredo deve ser considerado comprometido. Avaliar tambem se a chave publishable do Supabase e a URL do projeto exigem alguma acao (a publishable e projetada para ser publica; a URL nao e segredo).
  **Sugestao adicional:** tornar o repositorio privado, se nao houver motivo para ser publico.

## Corrigido — Seguranca (2026-09-01)

- ✅ **`/api/sync` agora falha FECHADA.** A guarda era `if (process.env.CRON_SECRET && auth !== ...)`: sem a variavel, a condicao inteira era falsa, a autenticacao era pulada e a rota — que varre `lojas` de TODOS os usuarios ativos e dispara sync contra Shopee e Mercado Livre — ficava **aberta**. Agora recusa nos tres casos (segredo ausente, header ausente, header errado) com resposta generica `{erro:true}` 401, sem distinguir o motivo. Mantido o mecanismo **oficial** do Vercel Cron (`Authorization: Bearer <CRON_SECRET>`) — nenhum header proprio, query param ou cookie foi inventado. Suite nova `scripts/testar-cron-sync.ts` com 9 testes, incluindo um que falha se o padrao fail-open voltar.
  **Consequencia operacional a saber:** enquanto `CRON_SECRET` nao existir em producao, o cron das 3h **nao roda** — e recusado como qualquer outro chamador. Isso e deliberado: sync que nao roda e incidente visivel e reversivel; rota multi-tenant aberta, nao.

## Aberto — Seguranca pre-existente (2026-09-01)

- ✅ **(CORRIGIDO em 2026-09-01, ver acima) `/api/sync` falhava ABERTA sem `CRON_SECRET`.** A guarda e `if (process.env.CRON_SECRET && auth !== "Bearer " + process.env.CRON_SECRET)` — se a variavel nao existe, o `if` inteiro e pulado e **nao ha autenticacao nenhuma**. `CRON_SECRET` NAO esta nas variaveis de producao, e `vercel.json` declara um cron diario em `/api/sync`. A rota varre `lojas` de **todos os usuarios ativos** e dispara sync para cada um — ou seja, um terceiro pode acionar trabalho pesado multi-tenant contra Shopee e ML. **Nao alterado de proposito:** inverter para falha fechada sem antes configurar a variavel quebraria o cron das 3h. **Correcao sugerida:** configurar `CRON_SECRET` em producao e so entao trocar a guarda para exigir o header sempre. Achado nesta auditoria; e anterior ao Estudio.

## Corrigido — Deploy (2026-09-01)

- ✅ **11 rotas `app/api/debug/*` REMOVIDAS antes do deploy.** Auditoria individual: todas GET, com sessao, escopadas ao proprio usuario, sem service role, sem IA — mas **sem nenhum consumidor real** (as duas "referencias" eram um comentario e uma string de ajuda), e a de refresh de token era redundante porque `getShopeeLojaAtiva()` ja renova o token 5 min antes de expirar. Preservadas no historico (commit `3486448`). Dois testes novos impedem o retorno: um falha se `app/api/debug` reaparecer, outro varre todas as rotas de `app/api` atras de token/loja/service role na resposta.

## Aberto — Divida tecnica (2026-09-01)

- 🟡 **`listarOrderSnsSequencialParaTeste` em `lib/sync-shopee.ts` ficou sem chamador.** Existia so para a rota de debug `comparar-listagem-shopee`, removida antes do deploy. **Preservada de proposito** — mexer no arquivo do sync numa tarefa de preparacao de deploy seria risco sem beneficio. O comentario dela foi atualizado para nao apontar mais para um arquivo inexistente. Remover numa tarefa propria, com o sync sendo exercitado.

## Aberto — Deploy (2026-08-31)

- 🟠 **Producao nao tem 24 das 29 variaveis — mas so UMA e bloqueante.** Revisado em 2026-09-01 provando pelo codigo: **SUPABASE_SERVICE_ROLE_KEY** e a unica sem a qual o Estudio quebra (toda rota dele a usa). As chaves de IA so sao necessarias para RODAR o pipeline; sem elas os flags *_ENABLED ficam desligados e as rotas recusam explicitamente. Os segredos de worker fazem as rotas internas responderem 401 (falha fechada). E tres variaveis (SYNC_WORKER_BASE_URL, ESTUDIO_ANUNCIOS_WORKER_BASE_URL, SYNC_JOB_STALE_MINUTES) sao usadas SO por scripts locais e **nao devem** ser configuradas na Vercel. Registro original preservado abaixo:
- 🔴 **(original) Producao nao tem 24 das 29 variaveis de ambiente exigidas.** Ausentes, entre outras: `SUPABASE_SERVICE_ROLE_KEY` (critica — toda rota do Estudio a usa), `GOOGLE_AI_API_KEY` + os 12 flags `GOOGLE_AI_*`, `ANTHROPIC_API_KEY` + 2 flags, `ESTUDIO_ANUNCIOS_WORKER_INTERNAL_SECRET`, `SYNC_WORKER_BASE_URL`, `SYNC_WORKER_INTERNAL_SECRET`, `SYNC_JOB_STALE_MINUTES`, `NEXT_PUBLIC_ENABLE_ASYNC_SYNC_JOBS`. **Deploy bloqueado ate serem configuradas.** Sao segredos: quem os configura e o dono da conta, no painel da Vercel — nao ha como fazer isso a partir daqui sem manusear credencial.
- 🟠 **`git push` para `main` dispara deploy de producao automaticamente.** O projeto Vercel esta conectado ao Git (alias `...-git-main-...`). Consequencia pratica: **push e deploy sao a mesma decisao** neste repositorio, e qualquer gate de ambiente precisa ser conferido ANTES do push, nao entre push e deploy.
- 🟡 **11 rotas `app/api/debug/*` entram no commit e irao a producao.** Todas exigem sessao (`getUserId`), entao nao sao endpoints abertos — mas sao superficie de depuracao em producao, com consultas amplas de reconciliacao. Vale decidir se ficam, se vao para tras de um flag, ou se saem.

## Aberto — Estudio de Anuncios (2026-08-31)

- 🟡 **O anuncio `MLB7395781296` esta ATIVO e vendavel, com estoque 999.** Foi criado a partir do projeto de TESTE `TESTE_REVISAO_CLAUDE_REAL_20260814`, a pedido explicito, como primeira publicacao controlada. Enquanto estiver `active` ele aparece na vitrine e pode receber pedido real. **O Estudio nao pausa, nao fecha e nao exclui anuncio** — qualquer contencao e decisao humana, fora deste modulo.
- 🟡 **`publicacao_incerta` nao tem tela de reconciliacao.** Se um POST der timeout e a busca automatica nao identificar exatamente um item novo, a linha fica nesse estado e o canal fica travado ate alguem resolver manualmente. E deliberado (travar e mais seguro que reenviar), mas nao ha UI para desfazer — hoje exige acesso ao banco.
- 🟡 **O ML aplica title-case no `family_name`.** Enviado "…Facial e Pedra…", criado "…Facial E Pedra…". E formatacao do marketplace, nao perda de dado; registrado para nao ser confundido com divergencia numa auditoria futura.

## Aberto — Estudio de Anuncios (2026-08-30)

- 🟡 **Picture orfa no CDN do Mercado Livre e possivel, por construcao.** Subir a imagem no ML e grava-la aqui sao dois sistemas sem transacao comum. Em concorrencia, os dois uploads acontecem e so um vence o UNIQUE `(loja, imagem, checksum)`; o perdedor fica no CDN deles sem referencia. **Nao e escondido:** aparece em `orfaos` no resultado de `garantirPicturesML()`. Inofensivo (imagem nao referenciada nao vira anuncio nem custo), mas registrado porque uma limpeza futura precisa saber que isso existe. Nenhum orfao foi gerado na validacao real desta data.

## Corrigido — Estudio de Anuncios (2026-08-29)

- ✅ **Todo parecer de compliance passou a parecer DESATUALIZADO — CORRIGIDO (§37.2).** Introduzido nesta mesma sessao: o hash da entrada passou a incluir o `checksum` das imagens, que so e legivel com service role. Mas `buscarComplianceDoProjeto()` — o lado que CONFERE o staleness — montava a entrada sem esse cliente, entao os checksums vinham `null` e o hash nunca batia com o gravado. Efeito: a validacao oficial respondia **409 "O parecer esta desatualizado"** para sempre, sem saida. Encontrado na validacao real, nao em teste. **Corrigido na estrutura**, nao no sintoma: os dois lados da comparacao agora montam a entrada exatamente do mesmo jeito. Licao registrada: sempre que um dado entra no hash, TODO caminho que recalcula esse hash precisa enxergar esse dado.

## Corrigido — Estudio de Anuncios (2026-08-30)

- ✅ **HTTP 400 com so WARNINGS virava `bloqueado` — CORRIGIDO.** `derivarStatusOficial()` fazia `if (!aceito || erros.length > 0) return "bloqueado"`, misturando **status de protocolo** com **resultado semantico**: o `/items/validate` responde 400 sempre que tem algo a dizer, inclusive so avisos. Resultado: parecer `bloqueado` com **zero erros** e portao fechado sem motivo. **Corrigido** separando as duas coisas — `error` bloqueia, `warning` nao — com uma excecao ESTREITA: so o envelope conhecido (`validation_error` + `cause` em array, interpretado) e sem nenhuma causa bloqueante. Qualquer 400 fora desse formato segue sendo bloqueio seguro, e 401/403/429/5xx/timeout continuam virando `erro_comunicacao`. Confirmado no fluxo real: `validado_com_alertas`, `podePublicarML = true`, warnings visiveis.

## Historico — Estudio de Anuncios (2026-08-29, corrigido em 2026-08-30)

- ✅ **`/items/validate` responde HTTP 400 mesmo quando so ha WARNINGS, e nosso status vira `bloqueado`.** A resposta crua de 2026-08-29 traz `error: "validation_error"`, `status: 400` e um array `cause` com **apenas** dois `type: "warning"` — nenhum `type: "error"`. Como `derivarStatusOficial()` faz `if (!aceito || erros.length > 0) return "bloqueado"`, e `aceito` e `false` para 400, o parecer fica `bloqueado` com zero erros e o portao de publicacao continua fechado. **Nao foi alterado de proposito:** mudar para `validado_com_alertas` ABRIRIA o portao de publicacao, e essa e uma decisao do usuario, nao um ajuste tecnico silencioso — ainda mais com o stop-gate desta etapa pedindo revisao do retorno oficial antes de qualquer passo novo.
- 🟡 **Warnings de shipping nao resolvidos (segue aberto):** `shipping.lost_me1_by_user` ("User has not mode me1") e `item.shipping.mandatory_free_shipping` ("Mandatory free shipping added"). Sao configuracao de envio da CONTA e politica de frete gratis da categoria — nenhum dos dois e resolvivel pelo payload do anuncio.

## Corrigido — Estudio de Anuncios (2026-08-28)

- ✅ **O Mercado Livre so aceita INTEIROS nas medidas de embalagem — CORRIGIDO na origem, sem arredondar.** Descoberto em 2026-08-27 enviando `13.5 cm`: `item.attribute.invalid.format.seller.package.dimensions` — *"Only integers are accepted for dimensions and weight"*. **Corrigido mudando o DOMINIO, nao mascarando com arredondamento**: as quatro colunas viraram `INTEGER` (migration `20260828`), o servidor exige `Number.isInteger(v) && v > 0`, a UI usa `step=1` e recusa decimal com mensagem propria, e o compliance ganhou o bloqueio `ml_embalagem_medida_nao_inteira` — separado do "nao informado", porque um pede preencher e o outro pede corrigir. **Nao existe `Math.round`, `Math.floor`, `Math.ceil`, `Math.trunc`, `parseInt` nem `toFixed` em nenhum ponto deste caminho** (teste 115 varre os quatro arquivos e falha se aparecerem). Ate os parametros da RPC continuam `NUMERIC` **de proposito**: com `INTEGER`, o proprio Postgres converteria 13.5 em 14 no cast — arredondamento silencioso, sem rastro. Confirmado no banco real: decimal recusado com `EMBALAGEM_VALOR_NAO_INTEIRO`, e `/items/validate` deixou de reclamar do formato.

## Aberto — Estudio de Anuncios (2026-08-27)

- 🟡 **`item.listing_type_id.requiresPictures` continua bloqueando a submissao.** Nao e desta etapa: as imagens ainda nao sao enviadas ao Mercado Livre. Registrado aqui porque, resolvidas as dimensoes de embalagem, este passou a ser o **unico** erro que resta na validacao oficial do projeto de teste.

## Corrigido — Estudio de Anuncios (2026-08-26)

- ✅ **IMPASSE: o modelo de publicacao nunca seria resolvido — CORRIGIDO (§37.2).** A resolucao do modelo (`GET /users/{seller_id}`) acontecia **dentro** de `executarValidacaoOficial`, depois das checagens de compliance. Mas "modelo nao resolvido" e um **bloqueio do compliance** — entao a validacao recusava rodar, e o modelo nunca era resolvido. Deadlock puro, encontrado na validacao real: a rota respondia 409 "a pre-publicacao ainda tem pendencias" para sempre. **Corrigido** movendo a resolucao para ANTES das checagens de compliance e tambem para o momento de **vincular a conta** — que e quando se sabe qual conta e. Como reforco, se o parecer foi montado com outro modelo, a validacao recusa e pede revalidacao, em vez de submeter um documento que o compliance nunca avaliou.

## Aberto — CDS (2026-08-25, fora do escopo do Estudio)

- 🟠 **`getMLLojaById()` (`lib/ml-auth.ts`) NAO checa o dono da loja.** Recebe um `loja_id` e devolve o `access_token` daquela loja, sem nenhuma verificacao de `user_id`. Ela nasceu para o Worker de sincronizacao, que resolve a loja a partir do job e por isso "ja sabe" que o id e legitimo — mas qualquer chamador novo que passe um id vindo do cliente carregaria **token de outro usuario**. **Nao foi alterada nesta tarefa**: esta fora do escopo autorizado e o Worker depende do comportamento atual (Constituicao 25.6). Contornado na origem pelo Estudio: `carregarContaML()` confirma `user_id` + `marketplace` + `ativo` ANTES de pedir o token, e a RPC de vinculo repete as tres checagens no banco. **Quem escrever o proximo consumidor precisa fazer o mesmo** — ou a funcao precisa ganhar a checagem, o que e frente propria.
- 🟡 **`lojas` tem linhas orfas com `user_id` NULL** (7 do ML, 2 da Shopee), residuo de fluxos de OAuth antigos. Elas nao aparecem em nenhuma listagem do Estudio (o filtro exige `user_id` da sessao) e a RPC de vinculo as recusa explicitamente. Registrado porque uma limpeza futura precisa decidir o que fazer com elas — apagar e Nivel 2 e nao foi feito.

## Corrigido — Estudio de Anuncios (2026-08-25)

- ✅ **Validacao oficial parecia ATUAL quando o compliance estava desatualizado — CORRIGIDO.** O hash do payload de agora era calculado a partir do parecer de compliance corrente; se esse parecer estava stale, ele descrevia o payload ANTIGO, e a validacao oficial guardada para aquele payload batia — aparecendo como atual mesmo depois de o preco/estoque mudarem. O portao ja barrava a publicacao (porque `compliance.desatualizado` era true), entao nao havia risco de publicar errado, mas a tela afirmava algo falso. **Corrigido** deixando de calcular hash para canal com compliance desatualizado: sem hash, a validacao e marcada como desatualizada, que e a afirmacao verdadeira. Achado na validacao real.

- ✅ **Tipo de anuncio real da conta era recusado como "invalido" — CORRIGIDO.** A validacao aceitava apenas os quatro tipos que aparecem nos exemplos da documentacao (`gold_pro`, `gold_special`, `silver`, `bronze`). Com OAuth, `GET /sites/MLB/listing_types` revelou que a conta real permite **sete**: os quatro mais `gold_premium`, `gold` e `free`. Um vendedor com Diamante disponivel nao conseguiria seleciona-lo. **Corrigido** dando autoridade a lista da CONTA quando ela existe, com a documentada como fallback — em nenhum caso se aceita string arbitraria.

## Corrigido — Estudio de Anuncios (2026-08-24)

- ✅ **Condicao invalida era ACEITA quando a categoria ja estava salva — CORRIGIDO.** A validacao server-side so comparava a condicao com as `item_conditions` da categoria quando a categoria vinha **no mesmo PATCH**. Salvando a categoria num request e a condicao no seguinte — que e o fluxo normal da UI —, qualquer string passava e era gravada. O compliance ainda pegava depois (`ml_condicao_invalida_para_categoria`), entao nao chegava a liberar publicacao, mas gravar valor invalido contraria a regra "nunca remover bloqueio so porque o campo foi preenchido". **Corrigido** passando os `categoria_settings` ja salvos para a validacao; sem categoria, a condicao nem pode ser definida. Achado na validacao real, com teste dedicado.

- ✅ **Mudar preco/estoque/tipo de anuncio NAO invalidava o parecer de compliance — CORRIGIDO.** A deteccao de parecer desatualizado comparava `versao_conteudo_id` com a versao aprovada atual. Isso cobre mudanca de conteudo, mas **nao enxerga mudanca nos dados de publicacao**: alterar o preco deixava o parecer anterior passando por atual, e o portao podia liberar publicacao com um preco que nunca foi validado. **Corrigido** trocando a comparacao para o **hash da entrada**, que ja cobria todas as entradas (conteudo, imagens, categoria, preco, estoque, condicao, tipo, atributos e versao das regras) — e por isso e a unica comparacao sem buraco. Custo: reconstruir a entrada dos canais que tem parecer, so deles. Validado nos tres cenarios (mudar, revalidar, voltar ao valor anterior e reencontrar o parecer).

## Corrigido — Estudio de Anuncios (2026-08-23)

- ✅ **Parecer de compliance DESATUALIZADO podia liberar publicacao de outro conteudo — CORRIGIDO.** Encontrado na propria validacao real da camada, nao em teste sintetico. O parecer e imutavel e congela a versao aprovada no momento da validacao; se a aprovacao editorial mudasse depois, o parecer continuava valendo como "o parecer do canal" e o portao `podePublicarMarketplace()` podia liberar **conteudo diferente do que foi validado** — aprovar A e publicar B. **Corrigido** com `desatualizado`, derivado no servidor comparando a versao que o parecer validou com a versao aprovada agora; parecer desatualizado **nunca** passa no portao, e a UI mostra o estado com motivo explicito.

- ✅ **"Parecer corrente" nao podia ser "o mais recente" — CORRIGIDO junto.** Consequencia sutil da idempotencia por hash: revalidar depois de **voltar** a uma aprovacao anterior *reencontra* um parecer antigo, que passa a ser o correto sem ser o ultimo criado por data. Selecionar por `criado_em desc` mantinha um parecer stale como corrente mesmo depois de revalidar — o primeiro fix sozinho nao resolvia. **Corrigido** definindo corrente como *o parecer que descreve a versao aprovada agora*; se nenhum descreve, o ultimo e exibido com a marca de desatualizado. Validado nos tres cenarios: versao ja validada, versao nunca validada e volta a versao anterior.

## Aberto — CDS (2026-08-23, fora do escopo do Estudio)

- 🟡 **Layout da pagina de projeto quebra em 375px — PRE-EXISTENTE, nao introduzido pela pre-publicacao.** Em viewport mobile a pagina inteira ganha rolagem horizontal (`scrollWidth` 815 para `clientWidth` 375) e **todos** os cartoes colapsam para ~21px de largura. O elemento que estoura e o **TopBar do app shell** (filtros "Data de Pagamento / Data de Criacao" + "Sem loja ativa"), nao os blocos do Estudio: medido bloco a bloco, o cartao de pre-publicacao **nao estoura o proprio container** (0 elementos fora dos limites) e e o unico que ainda renderiza com largura util. Nao corrigido nesta tarefa por ser app shell e estar fora do escopo autorizado (Constituicao 25.6). Em desktop nao ha estouro dentro do bloco.

## Achado de documentacao — Estudio de Anuncios (2026-08-22)

- 📄 **A Constituicao 13 afirma que os buckets de saida "NUNCA foram criados" — a afirmacao esta desatualizada para os DOIS.** A auditoria de 2026-08-16 ja tinha mostrado que `estudio-anuncios-gerado` existia; a de 2026-08-22 mostrou que **`estudio-anuncios-exportacoes` tambem existe** (privado, 300 MB, `application/zip` apenas). Nenhum bucket foi criado nem reconfigurado nesta tarefa — o existente foi reutilizado, como a propria tarefa mandava. **Nao e bug de codigo e nao foi corrigido na Constituicao**, que esta congelada (47.1) e cuja alteracao o usuario proibiu explicitamente nesta tarefa: o estado real fica registrado aqui, em `PROJECT_STATE.md` e no cabecalho de `lib/estudio-anuncios/storage.ts`, que e o que o codigo le. Registrado como divergencia doc↔codigo no espirito da Secao 31: **o codigo real descreve o que o sistema faz**.

## Corrigido — Estudio de Anuncios (2026-08-21)

- ✅ **`estudio_anuncios_pacotes_exportacao` nao tinha como ser idempotente — CORRIGIDO no banco.** A tabela so tinha `projeto_id`, `itens_incluidos` jsonb, `storage_path` e `criado_em`: sem nenhuma coluna que identificasse **o que** foi exportado, "regerar sem mudanca no conteudo aprovado nao deve criar pacote duplicado" era impossivel de garantir — cada POST criaria uma linha nova. **Corrigido** com `hash_conteudo` (sha256 do conjunto canonico de versoes aprovadas + imagens, deliberadamente **sem** o instante de geracao) e unique parcial `(projeto_id, hash_conteudo)`, colocando a idempotencia no BANCO e nao na aplicacao — dois requests concorrentes com o mesmo conteudo nao conseguem criar dois pacotes. Validado com 3 requests simultaneos (resultado: 1 pacote).

- ✅ **Numeracao de pacote por `max+1` seria insegura sob concorrencia — RESOLVIDO com trava no projeto.** Dois requests leem o mesmo `max(numero_pacote)` e tentam gravar o mesmo numero. **Corrigido** fazendo a numeracao dentro da RPC `estudio_anuncios_gerar_pacote_exportacao`, que trava o projeto com `FOR UPDATE` antes de calcular, mais unique `(projeto_id, numero_pacote)` como rede de seguranca. Mesmo padrao ja usado em `numero_versao` da camada editorial.

- ✅ **Sem `status`/`gerado_por` nao havia auditoria de pacote — CORRIGIDO.** Adicionados `status` (CHECK `gerado`/`parcial` — exatamente os dois valores que os dados produzem hoje; `exportado`/`publicado` **nao** foram inventados porque nada os escreveria) e `gerado_por`, derivado sempre da sessao.

## Corrigido — Estudio de Anuncios (2026-08-20)

- ✅ **`conteudo_versoes` permitia DUAS versoes aprovadas no mesmo canal — CORRIGIDO no banco.** A tabela tinha `aprovado boolean` sem nenhuma restricao de unicidade: nada impedia dois registros aprovados para o mesmo `projeto_marketplace_id`, e "qual e a versao aprovada" viraria ambiguo. **Corrigido** com indice unico parcial `idx_conteudo_versoes_aprovada_unica ON (projeto_marketplace_id) WHERE aprovado`, mais um CHECK que exige `aprovado_em`/`aprovado_por` quando `aprovado = true`. A troca da aprovada acontece numa RPC atomica (rebaixa a anterior e promove a nova na mesma transacao), nunca em dois UPDATEs independentes. Validado com fluxo real e com auditoria SQL.

- ✅ **`conteudo_versoes` nao registrava autor nem a origem de IA — CORRIGIDO.** Sem `criado_por`/`aprovado_por` era impossivel auditar quem editou ou aprovou; sem vinculo com `resultados_pipeline`, descobrir de qual saida da IA a versao 1 nasceu dependeria de timestamp/"mais recente" — heuristica que a arquitetura proibe. **Corrigido** com as tres colunas (`criado_por`, `aprovado_por`, `resultado_pipeline_origem_id` com FK `ON DELETE SET NULL`), todas preenchidas server-side a partir da sessao, nunca do corpo da requisicao.

- ✅ **CHECK de `origem` nao tinha valor para a fonte real — AMPLIADO sem apagar legado.** So aceitava `ia_openai`, `revisao_claude` e `edicao_manual`; a fonte real da camada e `adaptacao_marketplace`. Reaproveitar `ia_openai` seria gravar um nome semanticamente falso so para evitar migration. **Corrigido** somando `ia_adaptacao_marketplace` e **preservando os tres valores legados**.

## Corrigido — Estudio de Anuncios (2026-08-19)

- ✅ **"8 de 7 etapas concluidas" no progresso — CORRIGIDO.** O contador somava jobs concluidos sem teto, e um projeto com retentativa/regeracao pode ter mais jobs concluidos que etapas esperadas. Achado na validacao real da UI (projeto com 8 jobs concluidos para 7 etapas esperadas). **Corrigido** com clamp **de exibicao** (`Math.min(concluidos, total)`); a derivacao continua client-side e continua usando a lista fixa da Fase 1 — a substituicao por um progresso derivado do catalogo permanece como divida, registrada no proprio comentario de `ETAPAS_ESPERADAS`.

- ✅ **Estouro horizontal em 375px no titulo do projeto — CORRIGIDO.** Nome de produto sem espaco (ex.: `TESTE_REVISAO_CLAUDE_REAL_20260814`) nao quebrava e empurrava a largura da pagina em telas estreitas. **Corrigido** com `overflowWrap: anywhere` + `minWidth: 0` no cabecalho. Reverificado: **zero estouros reais em 375px**; tabelas largas seguem dentro dos seus proprios containers com `overflow-x: auto`.

## Corrigido — Estudio de Anuncios (2026-08-18)

- ✅ **Custo de imagem gravado como 0 — CORRIGIDO com preco oficial verificado.** `geracao_imagem` persistia `custo_estimado = 0` com `console.warn` porque nao havia preco cadastrado. **Causa estrutural (§37.2):** a tabela de precos assumia UMA taxa de saida por modelo — verdade para todo modelo de texto e falso para `gemini-3.1-flash-image`, que cobra **$3 por 1M de saida de texto/thinking e $60 por 1M de saida de IMAGEM**. Sem separar, a saida de imagem seria cobrada a taxa de texto: erro de **20x**, em silencio. **Corrigido** com `saidaImagemPorMilhao` (opcional) na tabela e um 4o argumento opcional em `estimarCustoUsd()` — aditivos, os 4 modelos de texto seguem com o calculo identico. A fatia de imagem vem de `usage.output_tokens_by_modality`, reportada pela API. Validado com execucao real: US$ 0,06848850, batendo exatamente com a formula oficial.

- ✅ **`numero_versao` colidia entre jobs do mesmo projeto — CORRIGIDO.** `calcularNumeroVersaoPorOrdem()` numerava so dentro do job, entao gerar imagem novamente para um projeto que ja tinha `capa_principal` versao 1 quebrava o INSERT com violacao do unique `(projeto_id, finalidade, numero_versao)` — **depois** de a imagem ter sido gerada e paga. A acao compensatoria removeu o objeto do Storage corretamente (nenhum orfao), mas o dinheiro ja tinha saido. **Corrigido:** o numero agora parte do maior `numero_versao` ja existente daquela finalidade no PROJETO (leitura correta do nome da coluna) e soma o indice dentro do job. Teste de regressao 22b. Pego por execucao real, nao por teste — custo do aprendizado: 2 imagens descartadas (~US$ 0,137).

## Aberto — Estudio de Anuncios (2026-08-18)

- 🟡 **Nao e possivel ter duas geracoes de imagem no mesmo projeto — pre-requisito de qualquer regeracao futura.** Duas constraints originais de 20260803 impedem a coexistencia: o unique parcial `idx_imagens_geradas_principal` (**1 principal por PROJETO**, nao por job) e o unique `(projeto_id, finalidade, numero_versao)`. Ao tentar gerar imagem de novo num projeto que ja tinha, o INSERT falha na segunda constraint mesmo com o `numero_versao` ja corrigido. **Nao bloqueia a Fase 1** — o Pipeline roda uma vez por projeto e o fluxo completo funciona ponta a ponta. Vira bloqueio no momento em que existir "regerar imagens" / versionamento de imagens na UI. **Decisao a tomar quando isso for construido:** rebaixar automaticamente a geracao anterior (`e_principal=false` + status proprio), ou tornar o unique de principal por `(projeto_id, job_id)`. Nao redesenhado agora, por decisao explicita de escopo.

- 🟡 **`ORIGEM_AMBIGUA` bloqueia `calculo_score` em projeto com mais de um `geracao_imagem` concluido.** Consequencia direta do item acima e do guard-rail funcionando como projetado: a RPC se recusa a escolher entre dois jobs de `geracao_imagem` em vez de adivinhar. Apareceu no teste de 2026-08-18, que criou deliberadamente um segundo job de imagem num projeto que ja tinha um. **Comportamento correto** — registrado para que quem implementar regeracao saiba que precisa resolver a origem junto.

## Corrigido — Estudio de Anuncios (2026-08-17)

- ✅ **Executor registrava prompt/consumo de IA para etapa que nao usa IA — CORRIGIDO antes de existir vitima.** `executar-job.ts` chamava `registrarPrompt()` e `registrarConsumo()` **incondicionalmente**. Enquanto todas as etapas falavam com um provedor isso era invisivel; `calculo_score` (deterministica, server-side, sem modelo e sem custo) expos o defeito. Como `central_ia_prompts.modelo` e `central_ia_consumo.modelo` sao **NOT NULL**, a etapa seria obrigada a **inventar uma string de modelo** e gravar consumo inexistente, poluindo justamente as tabelas que existem para auditar gasto real de IA. **Correcao (§37.2, aplicada ANTES da implementacao):** novo campo `HandlerEtapa.consomeIAExterna`, default `true` — nenhuma das 6 etapas anteriores mudou de comportamento (verificado por teste dedicado) — e o executor pula os dois registros quando o handler declara `false`. Validado na execucao real: o job de `calculo_score` concluiu com **0 linhas** em `central_ia_prompts` e **0** em `central_ia_consumo`.

## Aberto — Estudio de Anuncios (2026-08-17)

- 🟡 **Score nao avalia fidelidade visual — so qualidade tecnica.** O bloco `imagens` mede quantidade, presenca do arquivo no Storage, MIME, dimensoes, proporcao, uma principal, ausencia de duplicidade e bytes > 0. **Nao mede** se e o mesmo produto, se forma/cores foram preservadas, se ha acessorio inventado ou deformacao — isso foi auditado **manualmente** em 2026-08-16 e nao existe sinal deterministico no banco que sustente automatizar. Transformar a avaliacao manual numa regra automatica seria inventar um sinal. **Mitigacao ja em vigor:** o proprio envelope declara isso em `alertas`, e um teste proibe explicitamente criterios como `fidelidade`/`mesmo_produto`/`cores_preservadas` no bloco. **Caminho futuro:** auditor visual dedicado, separado do score.

- 🟡 **`estudio_anuncios_score` (legada) segue vazia e sem uso.** Auditada em 2026-08-17 e **deliberadamente nao reutilizada** por `calculo_score`: e indexada por `projeto_marketplace_id` (score por CANAL, enquanto o novo avalia o anuncio inteiro), nao tem `job_id` nem `schema_versao` (sem idempotencia por job nem versionamento de contrato) e tem `conversao_estimada`, exatamente o que a V1 nao deve produzir. Usar as duas criaria uma segunda fonte de verdade. **Nao foi alterada nem removida.** Decidir no futuro: migrar o conceito, ou remover a tabela numa migration propria.

## Aberto — Estudio de Anuncios (2026-08-16, pos-validacao)

- 🟡 **Fidelidade visual: proporcao entre pecas e espessura do arame desviam do original.** Nas 4 imagens reais geradas com `gemini-3.1-flash-image` usando a foto original como referencia, o produto e inequivocamente o mesmo (formato, cores, componentes e quantidade preservados; nada inventado), mas duas diferencas sao perceptiveis lado a lado: (a) a placa Gua Sha sai **maior em relacao ao rolo** do que no original, com bordas mais arredondadas e a reentrancia superior menos marcada; (b) o arame dourado sai um pouco mais espesso, com o loop da ponta pequena mais aberto. **Nao e deformacao estrutural** (nada derretido, duplicado ou impossivel) e nao invalida a imagem para anuncio. **Nao mascarar com prompt engineering infinito:** se a exigencia de fidelidade dimensional aumentar, o caminho e avaliar `gemini-3-pro-image` (Nano Banana Pro) ou enviar mais de uma foto de referencia (o codigo ja seleciona ate 3), medindo antes e depois — nao empilhar adjetivos no prompt.

- 🟢 **RESOLVIDO (2026-08-16) — BLOQUEIO EXTERNO: geracao de imagem indisponivel na conta (`limit: 0`).** Billing habilitado pelo usuario (Nivel 1, pre-pagamento). Cota reconfirmada por consulta a API antes de qualquer geracao: a resposta deixou de cair em `free_tier` e o modelo passou a devolver imagem. Etapa validada e concluida no mesmo dia. Registro do diagnostico original preservado abaixo por valor historico.

- 🟡 **Referencia pendurada no envelope apos exclusao manual de imagem — residuo de teste, com licao real.** O envelope de `geracao_imagem` guarda `imagemGeradaId` por imagem e e **imutavel por desenho** (`UNIQUE(job_id)`, nunca `UPDATE`). No teste destrutivo de recuperacao parcial eu apaguei a linha+arquivo da imagem 3 do job `29c09b53-...`; a regeneracao criou um UUID novo, entao o envelope daquele job cita um id que nao existe mais. **Nao e defeito de codigo e nao ocorre naturalmente:** o envelope so e gravado quando o job conclui, e um retry real pelo executor produziria envelope divergente e levantaria `ErroIdempotenciaResultadoPipeline` — falha explicita, nunca sobrescrita silenciosa. **Licao que vale para producao:** apagar uma linha de `estudio_anuncios_imagens_geradas` a mao deixa o envelope do job apontando para um fantasma, e nada detecta isso automaticamente. Se a exclusao manual virar operacao rotineira, considerar uma checagem periodica (a query da auditoria ja existe) ou restringir `DELETE` na tabela.

## Historico — Estudio de Anuncios (2026-08-16, bloqueio original)

- ✅ **BLOQUEIO EXTERNO — geracao de imagem indisponivel na conta: `limit: 0` em todos os modelos de imagem.** A primeira chamada real de `geracao_imagem` devolveu HTTP 429. **Nao e throttle nem erro de codigo:** o diagnostico direto na API mostrou `generate_content_free_tier_input_token_count, limit: 0` e `generate_content_free_tier_requests, limit: 0` para `gemini-3.1-flash-image`, `gemini-2.5-flash-image`, `gemini-3.1-flash-lite-image` e `gemini-3-pro-image`. `imagen-4.0-fast-generate-001` via `models.generateImages` devolve 404 (caminho descontinuado, indisponivel nesta chave). Modelos de TEXTO continuam funcionando normalmente com a MESMA chave — ou seja, a conta e free tier e geracao de imagem nao esta incluida no plano.
  **Impacto:** a etapa esta implementada, testada (51/51) e com `tsc` limpo, mas nunca produziu uma imagem. Nenhum arquivo foi criado, nenhuma linha foi gravada em `estudio_anuncios_imagens_geradas`, nenhum custo foi cobrado.
  **Comportamento do sistema no bloqueio (correto):** erro classificado como `rate_limit`, job de volta a `pendente` com a causa preservada, `GOOGLE_AI_IMAGEM_ENABLED=false` restaurado, caminho fake seguindo sem regressao.
  **Como destravar:** habilitar billing no projeto Google AI (Google AI Studio / Cloud Console) e confirmar cota > 0 para o modelo de imagem. **Isso e Nivel 3 (alterar billing) e nao pode ser feito automaticamente — depende do usuario.** Depois disso, o reteste e mecanico: religar a flag e rodar o Worker no job ja preparado.

## Corrigido — Estudio de Anuncios (2026-08-15)


- 🟢 **RESOLVIDO (2026-08-15) — validacao de "cor inventada" barrava fundo branco.** A validacao de integridade de `geracao_prompts_imagem` aplicava a checagem de cor a TODO o texto descritivo, inclusive `fundo` e `iluminacao`. Resultado: o primeiro prompt real ("fundo branco liso") foi rejeitado como se o modelo tivesse atribuido uma cor nova ao produto. **Era defeito da validacao, nao do modelo:** a proibicao do contrato e "nenhuma cor nova atribuida AO PRODUTO", e a cor do cenario nao afirma nada sobre o produto — fundo neutro e justamente o que a imagem principal exige. **Corrigido** separando `textoProduto` (objetivo + cena + elementosObrigatorios) de `textoCenario` (fundo + iluminacao): cor de cenario passou a aceitar uma lista curta e so-neutra (branco, cinza, preto, bege, creme, prata) ou qualquer cor confirmada na verdade visual; cor fora disso continua barrada, porque fundo colorido ao lado de produto colorido pode induzir leitura errada. Teste de regressao 17b.

- 🟢 **RESOLVIDO (2026-08-15) — `"reais"` na lista de termos promocionais barrava "condicoes reais de uso".** `"reais"` estava na lista de termos sempre proibidos como palavra de moeda, e barrou um prompt legitimo de imagem de uso. `"off"` tinha o mesmo problema latente (barraria "off-white", fundo neutro legitimo). **Corrigido** removendo os dois: preco e desconto seguem cobertos por `preco`, `desconto`, `promocao`, `cupom` e `porcentagem`, sem o falso positivo. Teste de regressao 20b. **Licao registrada:** listas de termos proibidos precisam de casamento por palavra inteira **e** de revisao contra ambiguidade semantica — `"reais"` (adjetivo) e `"reais"` (moeda) sao a mesma string.

## Aberto — Estúdio de Anúncios (2026-08-12)

- 🟡 **Pipeline em `aguardando` apontando para job terminal — efeito da convencao de neutralizacao.** 5 ocorrencias (`626c67f5-...`, `aeb3fe4e-...` x2 e `6168e33b-...` x2, entre 08-14 e 08-16) estao em `status=aguardando` com `job_atual_id` apontando para um job em `erro`. **Nao e defeito de codigo:** e consequencia direta da pratica documentada de neutralizar residuo de teste com `UPDATE` direto no job (`status='erro'`), que nao passa pelas RPCs atomicas e portanto nao atualiza o pipeline. Inofensivo — o job nao e reivindicavel e o pipeline nao avanca sozinho. **Como evitar no futuro:** neutralizar via `cancelarPipeline()` (que valida a transicao na maquina de estados) em vez de so marcar o job, ou aceitar o estado e documenta-lo, como aqui.

- 🟡 **1 consumo sem prompt correspondente.** `central_ia_consumo` tem 1 linha para o job `f928ce62-…` (etapa `ping`, provedor `fake`, 0 tokens, 2026-08-04) sem linha correspondente em `central_ia_prompts`. Resíduo do teste original de infraestrutura da Fase 0, anterior à disciplina de registro idempotente por `job_id`. Inofensivo: provedor fake, custo zero, job já concluído. **Zero casos novos** — auditoria de 2026-08-13 confirmou que nenhum job posterior apresenta o padrão. Preservado, nunca apagado.

- 🟡 **4 jobs em estado que o código não deveria produzir.** 3 `geracao_conteudo` e 1 `revisao_claude` em `status=pendente` com `tentativas = max_tentativas` e `erro_tipo=NULL`. A lógica não deveria conseguir gerar isso: o branch de retry só roda com `tentativas < max_tentativas`, e com as tentativas esgotadas o branch terminal deixa o job em `erro`.
  **Causa não determinada — a evidência foi apagada pelo bug do retry** (corrigido acima), que zerava `erro_tipo`/`erro_mensagem` a cada reenfileiramento. Nenhum dos 4 tem registro em `central_ia_prompts`, o que indica falha antes de qualquer chamada de IA.
  **Inofensivos hoje:** não são reivindicáveis (`claim_next_estudio_anuncios_job()` exige `tentativas < max_tentativas`). Preservados, nunca apagados.
  **Como fechar:** agora que a causa da falha sobrevive ao retry, o próximo caso desse tipo virá com `erro_tipo`/`erro_mensagem` preenchidos. Reavaliar quando ocorrer — sem novo caso, qualquer explicação seria especulação.

## Abertos — críticos

- 🔴 **Senha em plaintext.** `lib/session.ts` + `app/api/perfil/route.ts` + `app/api/auth/login/route.ts` armazenam e comparam senha em texto puro na coluna `perfil.senha`. Solução recomendada documentada em `AUDITORIA_FINAL.md` (bcrypt). Não implementado.
- 🔴 **Sessão sem assinatura.** Cookie `cds_session` carrega o `user_id` cru, sem JWT/HMAC. Qualquer requisição forjando esse cookie com um UUID válido de outro usuário é tratada como autenticada. Identificado nesta revisão (2026-07-06), ainda não estava documentado antes. Precisa de decisão: assinar o cookie (HMAC) ou migrar para sessão via Supabase Auth.
- 🔎 **RLS não confirmada nas tabelas Supabase.** Isolamento por usuário é feito só via `.eq("user_id", ...)` na aplicação. Se RLS estiver desativada, a chave anon pública (`NEXT_PUBLIC_SUPABASE_ANON_KEY`) pode expor dados de qualquer usuário a quem souber montar a query REST diretamente. Precisa confirmação manual no painel Supabase — não verificável a partir deste ambiente (sem acesso de rede ao Supabase).

## Abertos — médios

- 🟠 **`maxDuration` ignorado no Vercel Hobby.** Funções declaram até 300s mas o plano corta em 60s. Syncs grandes podem falhar silenciosamente por timeout.
- 🟠 **`taxaFixa` Shopee ausente do cálculo de margem.** Subestima custo em R$0,10–0,30/pedido nos itens de menor valor. Ver `BUSINESS_RULES.md`.
- 🟠 **Migrations SQL espalhadas sem numeração única** (raiz + `supabase/` + `supabase/migrations/`). Risco de aplicar migration errada ou fora de ordem. Ver `DATABASE.md`.

## Encerrado com limitação documentada — gap Shopee vs CDS (02/07/2026)

- 🔎➡️📌 **Gap de 10 pedidos / ≈R$350 entre painel oficial Shopee (989 pedidos, R$22.339,82) e CDS (979 pedidos, R$21.990,48). Investigação encerrada em 2026-07-06 por decisão do usuário — ver `DECISIONS.md` para o registro formal.**

  Histórico de hipóteses testadas, nenhuma confirmou a causa:
  1. `boundary-audit` — timezone (order_sn UTC vs `data` BRT). Resultado: **PARCIAL**, não comprovou a origem dos 10 pedidos.
  2. `nao-paid-02jul` — filtro de status (pending/cancelado/devolução em 02/07). Resultado: **também não explicou** a diferença.
  3. `shopee-audit` — diagnóstico geral, não conclusivo.
  4. `full-reconciliation` — descartado: universo Shopee por união `create_time`+`update_time` trouxe ~574 pedidos de outros dias (contaminação por `update_time`).
  5. `reconcile-989` — universo por `create_time`: `total_todos_status=1102`, `total_status_paid=975`. Nenhum bate com 989.
  6. `dashboard-formulas` — testou `create_time`/`update_time` × ~14 grupos de status contra a API Shopee (`pay_time` não é aceito por `get_order_list`, erro confirmado da própria API: "must use create_time or update_time"). **Melhor resultado encontrado: `create_time + exceto_unpaid_e_cancelado` → 979 pedidos / R$21.977,42.** Nenhuma combinação testada bateu exatamente com 989 pedidos / R$22.339,82.

  **Conclusão adotada:** a melhor regra reproduzível via API oficial da Shopee (`get_order_list`/`get_order_detail`) fecha em 979 pedidos, o mesmo número que a CDS já exibe. O painel oficial do Seller Center usa aparentemente uma regra de agregação interna (não exposta pela API pública) que chega a 989 — essa diferença de 10 pedidos / ≈R$350 **não é reproduzível pelos endpoints públicos da Shopee** e é tratada como limitação conhecida, não como bug do CDS.

  **Ressalva não resolvida (documentada, não investigada por decisão do usuário):** a regra `create_time + exceto_unpaid_e_cancelado` bateu em **quantidade** com a CDS (979 = 979), mas não em **valor** — R$21.977,42 (API) vs R$21.990,48 (CDS), diferença de R$13,06. Contagem igual não prova que é o mesmo conjunto de 979 pedidos; pode ser um conjunto diferente de mesmo tamanho, ou o mesmo conjunto com uma fórmula de valor ligeiramente diferente (ex.: rateio proporcional de frete/voucher). Não foi verificado order_sn a order_sn. Registrado para retomada futura se necessário — ver `DECISIONS.md`.

  Endpoints de debug criados durante esta investigação (candidatos a remoção — ver `ROADMAP.md`, checklist pré-Fase 2): `boundary-audit`, `nao-paid-02jul`, `shopee-audit`, `full-reconciliation`, `reconcile-989`, `dashboard-formulas`, `verify-979`, `pending-compare`.

## Encontrado, fora de escopo por decisão do usuário (2026-07-11)

- 🔎 **`lojas` com `user_id = NULL`.** Auditoria de colisão de nickname (para a migration `loja_id`, ver `DECISIONS.md`) encontrou 9 registros em `lojas` com `ativo=true` e `user_id` nulo (7 marketplace ML, 2 Shopee) — contra apenas 6 registros com `user_id` real (5 ML, 1 Shopee) no mesmo filtro. Ou seja, a maioria das linhas "ativas" na tabela não pertence a usuário nenhum.
  **Confirmado inofensivo hoje:** toda leitura real filtra por `user_id` de sessão (`getShopeeLojaAtiva`, `getMLLojaAtiva`, `GET /api/lojas`, etc.), então essas linhas nunca aparecem para nenhum usuário real. O cron `/api/sync` já tem um `.not("user_id","is",null)` explícito — alguém já havia topado com isso antes e contornado, sem documentar.
  **Causa não investigada** — hipóteses possíveis: bug no callback OAuth que insere a loja antes de resolver a sessão do usuário, ou sobras de testes manuais durante o desenvolvimento. Decisão explícita do usuário (2026-07-11): não alterar, não remover, não investigar agora. Tratar em auditoria separada depois que a arquitetura de `loja_id` estiver concluída — ver `DECISIONS.md`.

## Reaberto — conjuntos de 979 não são idênticos (2026-07-06)

- 🔎➡️📌 `verify-979` (rodado após o encerramento acima, com o mesmo total 979=979 dos dois lados): os conjuntos **não são idênticos por order_sn**. 6 pedidos só na Shopee, 6 só na CDS, 973 em comum. **Causa identificada order_sn a order_sn em 2026-07-06** (endpoint editado, sem criar novo, para trazer create_time/pay_time/update_time e lookup direto nos 12 pedidos):

  **6 pedidos só-Shopee (nunca chegaram ao banco):**
  - 5 deles (260703NKHH7MTJ, 260703NG57K4SB, 260703NFBKG9TA, 260703NA7NBD8J, 260703MVCRS86J): `create_time` em 02/07 BRT mas `pay_time`/`update_time` em 03/07 ou 04/07. Causa mais provável: o cron (`app/api/sync/route.ts:34-35`) usa uma janela rolante de só 2 dias (`ontem`+`hoje`, recalculada a cada execução) com `time_range_field="update_time"` (`lib/sync-shopee.ts:~147`) — hoje (06/07) essa janela já passou de 02-04/07. Não confirmado se o cron de fato rodou nesses dias (sem acesso a logs de execução da Vercel) — só o código explica o mecanismo do gap.
  - 1 deles (260702MHK41708): `create_time` E `pay_time` ambos em 02/07 (sem ambiguidade), mas status atual é `COMPLETED`. **Causa confirmada por código:** `lib/sync-shopee.ts:~147-148` (`filtrarCompleted = !noBuffer`) e `~181-183` exclui explicitamente pedidos `COMPLETED` da listagem do cron antes mesmo de buscar detalhe — um pedido novo que já nasce/vira `COMPLETED` rápido demais nunca entra pelo cron, independente de quando ele rodar.

  **6 pedidos só-CDS (no banco como "paid"/02-07, mas não no universo Shopee testado):**
  - 4 deles são diferença de **definição**, não bug: `create_time` em 01/07 (2 casos) ou create_time_brt_date=01/07 por fronteira de fuso literal (2 casos, incluindo um caso de 2 minutos antes/depois da meia-noite BRT — a mesma hipótese do `boundary-audit` original, agora confirmada com pedido real), mas `pay_time` em 02/07. O banco usa `pay_time` para gravar `data` no modo cron (`lib/sync-shopee.ts:267-270`) — regra atual e consistente, só diferente do critério `create_time` usado na comparação. Decisão de produto pendente: qual referência de tempo é "o dia do pedido" — ver `DECISIONS.md`.
  - 2 deles (260702MF16B5U8, 260702KH1BDRJF): `create_time`/`pay_time` ambos 02/07 sem ambiguidade, mas status atual na Shopee é `CANCELLED` enquanto o banco ainda diz `paid` (valores reais, não zero: R$102,47 e R$17,96). Pedido foi pago, sincronizado, depois cancelado/estornado na Shopee — banco nunca foi atualizado porque nenhum sync desde então revisitou esse order_sn (mesma limitação da janela rolante de 2 dias do cron). **Gap arquitetural real:** o sistema não tem rotina de reconciliação de status para pedidos não-terminais já sincronizados.

- 🔎 **Achado novo, sistêmico, ainda não investigado:** dos 973 pedidos em comum, praticamente todos (973 de 973 na amostra bruta) têm `item_subtotal` idêntico mas `buyer_paid_amount` diferente entre Shopee e CDS. Isso não parece ser sobre os 12 pedidos da divergência de conjunto — é uma diferença de fórmula/fonte de dado aplicada a quase toda a base. Candidato mais provável: rateio proporcional de `buyer_paid_amount` em `lib/sync-shopee.ts` (`buyerPaidItem = hasIncomeData ? incBuyerTotal * ratioItem : faturamento`) pode ter sido calculado num momento em que `income_distribution` ainda não estava disponível (pedido não `COMPLETED`), e nunca foi recalculado após o pedido virar `COMPLETED`/receber o dado oficial — ver `BUSINESS_RULES.md`. **Não investigado nesta rodada por decisão de foco do usuário** (prioridade era os 12 pedidos do gap de contagem). Retomar depois de fechar os 12.

## 🔴 Trocar loja no TopBar não muda os dados exibidos em Vendas/Dashboard (encontrado 2026-07-13)

Contexto: auditoria pré-deploy (Parte 6 do pedido de organização do deploy, ver `DECISIONS.md` 2026-07-13) foi investigar se hoje já é possível conectar mais de uma conta do mesmo marketplace, como preparação para a etapa futura de multi-lojas.

**Confirmado — armazenamento já suporta múltiplas lojas por marketplace:**
- `app/api/auth/shopee/callback/route.ts` e `app/api/auth/relay/route.ts` (callback do ML) buscam a loja existente por `(marketplace, seller_id/shop_id, user_id)`, não por `(marketplace, user_id)`. Conectar uma segunda conta com um `shop_id`/`seller_id` diferente insere uma linha nova em `lojas` — não sobrescreve a primeira.
- Nada no fluxo de conexão desativa (`ativo=false`) a loja irmã ao conectar uma nova. Múltiplas linhas `ativo=true` do mesmo marketplace/usuário já coexistem hoje.
- O dropdown do TopBar (`components/TopBar.tsx`) já lista todas as lojas conectadas via `GET /api/lojas` e tem um botão "trocar loja" por linha.

**O bug real:** `trocarLoja()` no TopBar chama `POST /api/lojas/ativar`, que **só seta cookies** (`loja_ativa_id` para ML, `shopee_loja_id` para Shopee) — nunca escreve na coluna `ativo` de `lojas`, nunca desativa a loja irmã. E as rotas que de fato servem dados (`app/api/ml/vendas/route.ts`, `app/api/shopee/vendas/route.ts`, e por extensão o Dashboard) resolvem a loja ativa via `getMLLojaAtiva`/`getShopeeLojaAtiva` (`lib/ml-auth.ts`, `lib/shopee-auth.ts`), que fazem `.eq("ativo", true).order("created_at", {ascending:false}).limit(1)` — **isso ignora completamente o cookie setado pelo dropdown.**

Resultado prático: se um usuário tem 2 lojas Shopee conectadas e usa o dropdown pra "trocar" para a mais antiga, o ✓ verde no menu muda, mas Vendas/Dashboard continuam mostrando os dados da loja conectada/reconectada mais recentemente — a troca é cosmética para leitura de dados. Isso não é uma limitação de "falta implementar seleção múltipla" — é um mecanismo de UI que hoje não faz o que aparenta fazer.

**Por que não foi corrigido agora:** decisão explícita do usuário (2026-07-13) de tratar multi-lojas (incluindo este bug) como frente própria, depois do deploy atual — ver arquitetura proposta em `ROADMAP.md` ("Fase 6 — Seleção de lojas").

## ✅ 189 pedidos Shopee ausentes de `pedidos` — 07/07/2026, janela ~20:43–23:17 — RECUPERADOS (2026-07-15)

**Recuperação concluída e validada.** Backfill pontual via `app/api/admin/shopee/backfill-pedidos-0707/route.ts` (busca direta por `get_order_detail` para os 189 `order_sn` conhecidos, reaproveitando `montarLinhasDoPedido()`/`carregarMapaAnuncios()` do sync oficial, upsert `onConflict:"id"`). Testado em 3 etapas: (1) 1 pedido canário gravado e validado campo a campo no Supabase (`loja_id`, `status`, `status_shopee_raw`, `data_pagamento`, `data_criacao`, `item_subtotal`, sem duplicação, Dashboard refletindo o pedido); (2) dry-run confirmando 188 novos / 1 já existente (upsert funcionando); (3) backfill completo dos 188 restantes.

**Resultado final:** 189/189 pedidos recuperados, 222 linhas gravadas, R$4.924,83 de faturamento recuperado, 0 erros de gravação, 0 duplicação (confirmado via `count(distinct order_id)=189` e `group by id having count(*)>1` = 0 linhas em toda a tabela). Nenhum pedido fora da lista foi tocado (rota nunca chama `get_order_list`, só `get_order_detail` para os order_sn explicitamente solicitados).

Detalhe original da investigação (mantido para histórico):

**Confirmado (fato, não hipótese):** 189 `order_sn` da loja Shopee Monamor (419809235), todos com pagamento em 07/07/2026 entre ~20:43 e ~23:17 (horário de Brasília), estão **totalmente ausentes** da tabela `pedidos` — confirmado por uma busca `order_id IN (...)` cobrindo os 189 IDs, sem nenhum filtro de data ou status, na tabela inteira (0 linhas retornadas).

**Método de detecção:** cruzamento entre o export oficial da Shopee Seller Center (`Order.all.order_creation_date`, nível item/pedido) e os `order_id` pagos gravados no banco para 07/07/2026. Lista completa dos 189 `order_sn` em `lib/backfill-0707-order-ids.ts` (`DEFAULT_ORDER_IDS_0707`).

**Status atual desses pedidos na Shopee (live, 2026-07-14):** 88 dos 189 já `COMPLETED`; os outros 101 em `TO_CONFIRM_RECEIVE` (85), `SHIPPED` (11) ou `TO_RETURN` (5).

**Causa raiz: confirmado que o filtro `filtrarCompleted` NÃO explica a maioria dos casos.** Diagnóstico direto via `get_order_list` (rodado localmente em 2026-07-14, rota temporária removida depois de usada) confirma que os 189 aparecem normalmente na listagem da Shopee, tanto por `create_time` quanto por `update_time` — não é um problema de "a Shopee nunca lista esse pedido". O filtro `filtrarCompleted` só poderia explicar os 88 hoje `COMPLETED` (e isso não está confirmado — exigiria que tivessem completado rápido demais para o cron pegar antes); os outros 101 não estão `COMPLETED` e mesmo assim nunca foram gravados, então o filtro nem se aplica a eles. Causa real ainda não identificada — ver `DECISIONS.md` para o detalhe completo e hipóteses remanescentes (falha do cron nesse dia específico, ou bug de paginação/cursor).

**Recuperação:** plano de backfill pontual desenhado (rota admin `dry_run`-first, reaproveitando a lógica de montagem de linha extraída para `montarLinhasDoPedido()` em `lib/sync-shopee.ts`, sem tocar em nenhum pedido fora desta lista) — implementação ainda pendente de aprovação final do usuário.
