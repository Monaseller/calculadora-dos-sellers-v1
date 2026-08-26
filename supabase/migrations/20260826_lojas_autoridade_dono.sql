-- ============================================================
-- CONEXOES/CAPABILITIES-1 — autoridade estrutural de lojas
-- Aplicada em: 2026-08-26
--
-- Depende de `20260826_lojas_remover_orfaos.sql`, que zerou as lojas
-- sem dono. Sem aquela, o `SET NOT NULL` daqui falharia.
--
-- Objetivo: transformar `lojas` numa fronteira de autoridade CONFIAVEL,
-- para que uma capability de agente possa dizer "esta conexao pertence a
-- este dono" por ESTRUTURA, e nao por disciplina de codigo.
--
-- ── 1. user_id: uuid -> text ────────────────────────────────────────
--
-- O dominio operacional inteiro ja usa `text`:
--
--   pedidos.user_id ......................... text
--   sync_jobs.user_id ....................... text
--   dashboard_resumos_diarios.user_id ....... text
--   estudio_anuncios_projetos.user_id ....... text
--   agente_tarefas.user_id .................. text
--   lojas.user_id ........................... uuid   <- o unico fora
--
-- Cinco contra um. Alinhar `lojas` e a mudanca barata; migrar as cinco
-- para `uuid` seria tocar o CDS inteiro. A alternativa que NAO fizemos —
-- deixar como estava — obrigaria a um cast em toda comparacao de
-- autoridade, e cast em fronteira de seguranca e onde bug mora.
--
-- O codigo ja tratava como string: `.eq("user_id", String(userId))` em
-- `lib/marketplace/credenciais.ts`, tipagem TypeScript `string`, e ZERO
-- casts `::uuid`. A conversao nao muda o valor logico de nada.
--
-- ── 2. O CHECK que substitui a validacao perdida ────────────────────
--
-- Trocar `uuid` por `text` sem mais nada transformaria QUALQUER string
-- em dono valido — inclusive "", " " ou "admin". A validacao de formato
-- que o tipo dava de graca precisa voltar explicitamente, ou a migracao
-- teria enfraquecido a fronteira em vez de fortalece-la.
--
-- Regex ancorado, case-insensitive, exatamente o formato UUID canonico.
-- Verificado antes de aplicar: 6/6 das linhas restantes passam.
--
-- ── 3. NOT NULL ─────────────────────────────────────────────────────
--
-- Loja sem dono deixa de ser representavel. Ate aqui, "orfa" era um
-- estado possivel que o codigo precisava lembrar de excluir — e
-- `ml-auth.ts` de fato lembra, rejeitando `user_id NULL`. Agora o banco
-- garante, e a lembranca vira redundancia saudavel em vez de unica
-- linha de defesa.
--
-- ── 4. UNIQUE (id, user_id) ─────────────────────────────────────────
--
-- Tecnicamente redundante — `id` ja e PK, entao o par tambem e unico.
-- Existe por um motivo so: o Postgres exige que a coluna referenciada
-- por uma FK tenha UNIQUE/PK correspondente. E o que habilita a FK
-- composta abaixo. Mesmo padrao ja usado em
-- `agente_tarefas_agente_do_mesmo_dono`.
--
-- ── 5. A FK composta, que e o ponto de tudo isso ────────────────────
--
-- Hoje `pedidos.loja_id -> lojas(id)` garante que a loja EXISTE, mas nao
-- que ela seja do MESMO dono do pedido. A coincidencia atual (0
-- divergencias em 439.339 linhas) e resultado de disciplina no codigo de
-- sync, nao de garantia do banco.
--
-- Com a FK composta, um pedido do dono A apontando para loja do dono B
-- passa a ser IMPOSSIVEL de gravar.
--
-- ON DELETE: NENHUM, portanto NO ACTION. Escolha consciente, nao
-- omissao. CASCADE apagaria pedidos ao remover uma conexao — perda de
-- dado financeiro por um clique em "desconectar loja". SET NULL deixaria
-- pedido sem loja, quebrando rastreabilidade. NO ACTION faz o banco
-- RECUSAR apagar uma loja que ainda tem pedidos, que e exatamente o
-- comportamento desejado: para desconectar, primeiro se decide o que
-- fazer com o historico.
--
-- Nota sobre `MATCH SIMPLE` (padrao): `pedidos.loja_id` e NULLABLE (0
-- nulos hoje), e com qualquer coluna NULL a FK composta nao e aplicada.
-- Isso NAO e regressao: a FK antiga tambem ja permitia `loja_id` nulo.
-- Ela e mantida de proposito, e cobre justamente esse caso.
--
-- ── 6. seller_id NAO e autoridade ───────────────────────────────────
--
-- Deliberadamente NAO existe unicidade global em `seller_id`, e nao deve
-- existir. A auditoria encontrou o seller ML `c7fa38…` vinculado a TRES
-- donos CDS distintos, compartilhando 18.430 order_id. Isso e SUPORTADO
-- por desenho: a mesma conta externa pode ter varias relacoes CDS.
--
-- `seller_id` e atributo externo. Autoridade e `user_id + loja_id`.
-- ============================================================

-- 1. tipo
alter table public.lojas
  alter column user_id type text using user_id::text;

-- 2. formato (a validacao que o tipo `uuid` dava de graca)
alter table public.lojas
  add constraint lojas_user_id_formato_uuid
  check (user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

-- 3. toda loja tem dono
alter table public.lojas
  alter column user_id set not null;

-- 4. habilita a FK composta
alter table public.lojas
  add constraint lojas_id_user_id_unico unique (id, user_id);

-- 5. pedido e loja sao do MESMO dono. Sem ON DELETE => NO ACTION.
alter table public.pedidos
  add constraint pedidos_loja_do_mesmo_dono
  foreign key (loja_id, user_id) references public.lojas (id, user_id);

comment on constraint lojas_user_id_formato_uuid on public.lojas is
  'Formato UUID canonico. Substitui a validacao que o tipo uuid dava antes da migracao para text — sem isto, qualquer string viraria dono valido.';

comment on constraint pedidos_loja_do_mesmo_dono on public.pedidos is
  'Autoridade composta: um pedido so pode apontar para loja do MESMO dono. ON DELETE NO ACTION de proposito — recusa apagar loja com pedidos, em vez de cascatear perda de historico financeiro.';

-- ── O QUE ESTA MIGRATION NAO FAZ ───────────────────────────────────
--   - Nao remove a FK antiga `pedidos_loja_id_fkey`. Ela e redundante
--     quando `loja_id` nao e nulo, mas continua sendo a unica que atua
--     quando ele e nulo. Remove-la e decisao separada.
--   - Nao cria FK composta em sync_jobs, dashboard_resumos_diarios nem
--     estudio_anuncios_projetos, que tambem tem (loja_id, user_id).
--     Fora do escopo desta fase; fica REGISTRADO.
--   - Nao toca em credencial, nao altera dado de pedido, nao cria
--     unicidade em seller_id, nao habilita RLS.
