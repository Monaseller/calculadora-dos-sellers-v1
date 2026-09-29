-- ─────────────────────────────────────────────────────────────────────
-- AGENT-FACTORY-F5 — FONTES DE AGENTE
--
-- Aditiva. Cria UMA tabela. Nao altera nenhuma tabela existente, nao
-- recria funcao, nao mexe em privilegio e nao toca migration historica.
--
-- 1. O QUE E UMA FONTE, E O QUE ELA NAO E
-- ---------------------------------------------------------------------
-- Uma FONTE e um arquivo que PERTENCE ao agente e sobrevive a conversa:
-- o lojista sobe `entradas.xlsx` uma vez e ele continua la no proximo
-- chat, no proximo login, ate ser desativado ou substituido.
--
-- Isso e diferente de ANEXO DE CONVERSA, que vale so naquele dialogo.
-- A diferenca mora na coluna `escopo`, e nao em duas tabelas: a forma
-- do arquivo, a validacao, o hash e a resolucao sao identicas — o que
-- muda e ate quando ele vale. Duas tabelas obrigariam a duplicar o
-- resolvedor, e dois resolvedores que precisam concordar para sempre
-- acabam discordando.
--
-- FONTE tambem NAO e MEMORIA. Memoria e o que o agente aprendeu;
-- fonte e um arquivo que alguem entregou. Sao gates diferentes e nao
-- se misturam aqui.
--
-- 2. CROSS-TENANT MORRE NO BANCO, NAO SO NO CODIGO
-- ---------------------------------------------------------------------
-- A FK e COMPOSTA: (user_id, agente_id) -> agentes (user_id, id),
-- apoiada em `agentes_id_por_dono UNIQUE (user_id, id)`. E o mesmo
-- desenho de `agente_permissoes`, pela mesma razao: ligar a fonte do
-- dono A ao agente do dono B passa a ser impossivel, e nao apenas
-- proibido por um `where` que alguem pode esquecer.
--
-- A aplicacao continua filtrando por `user_id` — esta FK e a segunda
-- tranca, nunca a substituta da primeira.
--
-- 3. O CAMINHO FISICO FICA AQUI DENTRO
-- ---------------------------------------------------------------------
-- `caminho_objeto` e o endereco no bucket privado. Ele NUNCA sai para a
-- UI nem para o modelo: quem fala com o LLM manda `id`, `nome`,
-- `descricao` e `papel`. O modelo pede a fonte pelo id; o resolvedor e
-- o unico que conhece o caminho. Por isso ele e UNIQUE — dois registros
-- apontando para o mesmo objeto fariam "apagar a fonte" deixar bytes
-- vivos referenciados por outra linha.
--
-- 4. SEM RLS, COMO TODO O RESTO
-- ---------------------------------------------------------------------
-- O padrao vigente e capability + filtro explicito, e e o que as 35
-- tabelas de `public` seguem. Ligar RLS so nesta criaria dois modelos
-- convivendo. Tambem NAO ha GRANT/REVOKE aqui, pela mesma razao
-- documentada em `20260916_agentes_fundacao.sql` secao 6: migrations
-- aplicam como `postgres`, cujo default ACL para tabelas ja e
-- {postgres, service_role} desde a SEC-1a. Um GRANT seria ruido; um
-- REVOKE, no-op teatral. A suite prova o resultado em vez de afirma-lo.
--
-- 5. SUBSTITUICAO NAO SOBRESCREVE
-- ---------------------------------------------------------------------
-- Nao ha UPDATE de bytes. Trocar `entradas.xlsx` por uma versao nova
-- significa inserir OUTRA linha e desativar a anterior — `substitui_id`
-- aponta para quem ela substituiu. Sobrescrever perderia o hash do que
-- foi lido ontem, e um relatorio antigo deixaria de ser explicavel.
-- ─────────────────────────────────────────────────────────────────────

create table if not exists public.agente_fontes (
  id             uuid        not null default gen_random_uuid(),

  -- `text` e nao `uuid`: acompanha `agentes.user_id`, que e text por
  -- decisao ja registrada na fundacao. Divergir aqui exigiria cast na
  -- FK composta e ela simplesmente nao casaria.
  user_id        text        not null,

  -- NULL quando `escopo = 'conversa'`: um anexo de chat pertence ao
  -- dono e ao dialogo, nao a um agente.
  agente_id      uuid,

  escopo         text        not null,
  -- Preenchida so no escopo de conversa. `text` porque a camada de
  -- conversa ainda nao existe e fixar `uuid` agora seria decidir o
  -- formato dela de passagem.
  conversa_id    text,

  -- Nome LOGICO, para humano e para o modelo. Nunca um caminho.
  nome           text        not null,
  -- Metadados livres do dono. O sistema NAO conhece "Entradas" nem
  -- "Saidas": quem da sentido a fonte e quem a subiu, e fixar esses
  -- valores no schema amarraria o produto a um unico caso de uso.
  descricao      text,
  papel          text,

  tipo           text        not null,
  mime           text        not null,
  tamanho_bytes  bigint      not null,
  -- sha256 em hex. Serve para detectar reenvio do mesmo arquivo e para
  -- que um numero calculado ontem continue explicavel amanha.
  hash_sha256    text        not null,

  -- Endereco no bucket privado. Ver secao 3: nunca sai daqui.
  caminho_objeto text        not null,

  ativo          boolean     not null default true,
  -- A fonte que esta substitui. NULL na primeira versao.
  substitui_id   uuid,

  criado_em      timestamptz not null default now(),
  -- Sem trigger de updated_at: o projeto nao tem esse padrao; quem
  -- escreve atualiza a mao, como em `agente_permissoes`.
  atualizado_em  timestamptz not null default now(),

  constraint agente_fontes_pk primary key (id),

  -- Alvo para `substitui_id` e para qualquer FK futura que precise
  -- amarrar dono e fonte no mesmo passo.
  constraint agente_fontes_id_por_dono unique (user_id, id),

  -- A segunda tranca contra cross-tenant. Ver secao 2.
  -- CASCADE: fonte e estado do agente; apagado o agente, ela perde
  -- sentido — mesmo criterio de `agente_permissoes`.
  constraint agente_fontes_agente_do_mesmo_dono
    foreign key (user_id, agente_id)
    references public.agentes (user_id, id)
    on delete cascade,

  -- Uma substituicao so pode apontar para fonte DO MESMO DONO.
  constraint agente_fontes_substitui_do_mesmo_dono
    foreign key (user_id, substitui_id)
    references public.agente_fontes (user_id, id)
    on delete set null,

  constraint agente_fontes_escopo_valido
    check (escopo in ('agente', 'conversa')),

  -- O escopo decide QUAL vinculo e obrigatorio, e proibe o outro. Sem
  -- isto existiria "fonte de agente presa a uma conversa", que nao
  -- significa nada e que o resolvedor teria de tratar assim mesmo.
  constraint agente_fontes_vinculo_coerente check (
    (escopo = 'agente'   and agente_id is not null and conversa_id is null)
    or
    (escopo = 'conversa' and conversa_id is not null and agente_id is null)
  ),

  constraint agente_fontes_tipo_valido check (tipo in ('xlsx', 'csv')),

  -- Os dois MIMEs que a leitura suporta de verdade. `.xls` (BIFF
  -- binario) fica de fora: exigiria outra stack de parsing, e prometer
  -- suporte sem ter o leitor seria pior que recusar.
  constraint agente_fontes_mime_valido check (
    mime in (
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/csv'
    )
  ),

  constraint agente_fontes_nome_nao_vazio check (length(btrim(nome)) > 0),

  -- 5 MB. NAO e numero redondo escolhido no olho: o leitor de `.xlsx`
  -- descomprime a planilha INTEIRA em memoria para ler, e um xlsx
  -- comprime XML a taxas de 10x-20x. 5 MB comprimidos ja podem virar
  -- ~100 MB de XML, que e o teto util dentro do limite de 60s e da
  -- memoria de uma funcao serverless na Vercel (limite conhecido,
  -- registrado em docs/BUGS.md). Para referencia, 5 MB comprimidos
  -- cabem dezenas de milhares de linhas financeiras — muito alem do
  -- que a agregacao precisa.
  constraint agente_fontes_tamanho_valido
    check (tamanho_bytes > 0 and tamanho_bytes <= 5242880),

  constraint agente_fontes_hash_formato
    check (hash_sha256 ~ '^[0-9a-f]{64}$'),

  constraint agente_fontes_caminho_nao_vazio
    check (length(btrim(caminho_objeto)) > 0),

  -- Dois registros para o mesmo objeto fariam "apagar a fonte" deixar
  -- bytes vivos referenciados por outra linha. Ver secao 3.
  constraint agente_fontes_caminho_unico unique (caminho_objeto)
);

-- A consulta quente: "as fontes ATIVAS deste agente". Parcial porque
-- fonte desativada nunca entra nessa leitura, e indexa-la seria pagar
-- por linha que a consulta descarta.
create index if not exists idx_agente_fontes_ativas_por_agente
  on public.agente_fontes (user_id, agente_id)
  where ativo and escopo = 'agente';

-- O mesmo para anexo de conversa.
create index if not exists idx_agente_fontes_ativas_por_conversa
  on public.agente_fontes (user_id, conversa_id)
  where ativo and escopo = 'conversa';

-- O Postgres NAO indexa o lado referenciante de uma FK. Sem este
-- indice, todo DELETE em `agente_fontes` faria seq scan procurando
-- quem a referencia por `substitui_id` — a mesma licao registrada em
-- `20260916_agentes_fundacao.sql` secao 5.
create index if not exists idx_agente_fontes_substitui
  on public.agente_fontes (user_id, substitui_id)
  where substitui_id is not null;

-- Reenvio do mesmo arquivo para o mesmo agente: detectavel por hash
-- sem varrer a tabela.
create index if not exists idx_agente_fontes_hash
  on public.agente_fontes (user_id, hash_sha256);
