-- ─────────────────────────────────────────────────────────────────────
-- AGENT-FACTORY-F6 — MEMORIA MANUAL DO AGENTE
--
-- Aditiva. Cria UMA tabela. Nao altera tabela existente, nao recria
-- funcao, nao mexe em privilegio, nao toca migration historica.
--
-- 1. O QUE ESTA TABELA NAO E
-- ---------------------------------------------------------------------
-- NAO e SKILL. Skill e "como o agente executa uma especialidade" e ja
-- tem casa propria (`skills` + `agente_skills`, desde a 20260922). Esta
-- frente NAO cria uma segunda arquitetura de Skill: ela reusa aquela.
--
-- NAO e FONTE. Fonte e um arquivo que alguem entregou (`agente_fontes`).
--
-- NAO e HISTORICO DE CONVERSA. O que foi dito num chat continua no
-- chat. Uma frase so vira memoria quando uma PESSOA decide que vira —
-- ver secao 2.
--
-- E: preferencia ou conhecimento duravel que o dono escreveu para
-- aquele agente. "Quando eu pedir resumo financeiro, mostre saldo
-- primeiro."
--
-- 2. ESCRITA MANUAL, E SO
-- ---------------------------------------------------------------------
-- Nao ha coluna de origem com valor `automatica`, nao ha trigger que
-- promova mensagem a memoria, e o agente nao tem Function para escrever
-- aqui (decisao registrada: memoria e configuracao do dono, feita pela
-- UI, e nao capacidade do modelo). O modelo LE; quem escreve e a
-- pessoa.
--
-- Isso e desenho, nao limitacao temporaria: um agente que aprende
-- sozinho a partir do que leu numa planilha ou numa mensagem de cliente
-- e um agente que pode ser ensinado por quem escreveu a planilha.
--
-- 3. PRECEDENCIA EXPLICITA, EM VEZ DE "A MAIS RECENTE GANHA"
-- ---------------------------------------------------------------------
-- Duas memorias ativas podem se contradizer, e o banco nao tem como
-- saber disso. A politica escolhida:
--
--   - `ordem` e do DONO. A montagem do contexto respeita essa ordem, e
--     nao a data. "Mais recente ganha" e silencioso: a pessoa editaria
--     uma preferencia antiga e mudaria, sem perceber, qual das duas
--     vale.
--   - DUPLICATA EXATA e impedida pelo indice unico sobre o conteudo
--     normalizado. Nao resolve contradicao — resolve repeticao, que e a
--     causa mais comum de "por que ele esta fazendo duas vezes?".
--   - Contradicao SEMANTICA continua possivel e NAO e adivinhada aqui.
--     A UI mostra a lista ordenada e a pessoa decide. Registrado como
--     limite conhecido, nao escondido.
--
-- 4. TENANT
-- ---------------------------------------------------------------------
-- FK COMPOSTA (agente_id, user_id) -> agentes (id, user_id), a mesma
-- forma de `agente_skills`. Memoria do dono A para agente do dono B e
-- impossivel, e nao apenas proibida por um `where`.
--
-- 5. SEM RLS E SEM GRANT
-- ---------------------------------------------------------------------
-- Mesma razao ja documentada em `20260916_agentes_fundacao.sql` secao 6
-- e repetida em `20261016_agente_fontes.sql`: migrations aplicam como
-- `postgres`, cujo default ACL para tabelas ja e {postgres,
-- service_role}. GRANT seria ruido; REVOKE, no-op teatral.
-- ─────────────────────────────────────────────────────────────────────

create table if not exists public.agente_memorias (
  id        uuid        not null default gen_random_uuid(),

  -- `text` acompanha `agentes.user_id`. Divergir quebraria a FK.
  user_id   text        not null,
  agente_id uuid        not null,

  conteudo  text        not null,

  -- Rotulo LIVRE do dono ("formato", "tom", "regra"). O sistema nao
  -- conhece nenhum valor: fixar um enum aqui amarraria o produto a um
  -- caso de uso, como ja se evitou em `agente_fontes.papel`.
  tipo      text,

  -- Precedencia escolhida pela PESSOA. Ver secao 3.
  ordem     integer     not null default 0,

  ativo     boolean     not null default true,

  criado_em     timestamptz not null default now(),
  -- Sem trigger: o projeto nao tem esse padrao; quem escreve atualiza a
  -- mao, como em `agente_permissoes` e `agente_fontes`.
  atualizado_em timestamptz not null default now(),

  constraint agente_memorias_pk primary key (id),

  constraint agente_memorias_id_por_dono unique (user_id, id),

  constraint agente_memorias_agente_do_mesmo_dono
    foreign key (agente_id, user_id)
    references public.agentes (id, user_id)
    on delete cascade
    on update restrict,

  constraint agente_memorias_conteudo_nao_vazio
    check (length(btrim(conteudo)) > 0),

  -- 2000 caracteres. Nao e numero solto: memoria entra no contexto a
  -- CADA turno, entao ela e paga em token toda vez. 2000 caracteres sao
  -- ~500 tokens — espaco de sobra para uma preferencia bem escrita, e
  -- pouco o suficiente para que ninguem cole um documento aqui. Quem
  -- precisa de documento tem `agente_fontes`.
  constraint agente_memorias_conteudo_tamanho
    check (length(conteudo) <= 2000),

  constraint agente_memorias_tipo_tamanho
    check (tipo is null or length(btrim(tipo)) between 1 and 60),

  constraint agente_memorias_ordem_valida
    check (ordem >= 0 and ordem <= 9999)
);

-- A consulta quente: "as memorias ATIVAS deste agente, na ordem do
-- dono". Parcial porque memoria desativada nunca entra nessa leitura.
create index if not exists idx_agente_memorias_ativas
  on public.agente_memorias (user_id, agente_id, ordem, criado_em)
  where ativo;

-- Impede DUPLICATA EXATA no mesmo agente. Ver secao 3: resolve
-- repeticao, nao contradicao. `lower(btrim(...))` porque "Mostrar saldo
-- primeiro" e "mostrar saldo primeiro " sao a mesma instrucao para
-- qualquer leitor, inclusive o modelo.
create unique index if not exists idx_agente_memorias_sem_duplicata
  on public.agente_memorias (user_id, agente_id, lower(btrim(conteudo)));
