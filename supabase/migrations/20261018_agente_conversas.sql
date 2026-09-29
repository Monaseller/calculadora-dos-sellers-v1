-- ─────────────────────────────────────────────────────────────────────
-- AGENT-FACTORY-F7a — CONVERSAS E MENSAGENS DO AGENTE
--
-- Aditiva. Cria DUAS tabelas. Nao altera tabela existente, nao recria
-- funcao, nao mexe em privilegio, nao toca migration historica.
--
-- 1. POR QUE ISTO NAO EXISTIA
-- ---------------------------------------------------------------------
-- O chat de hoje (`app/api/agentes/[agenteId]/conversa`) e uma TAREFA:
-- uma pergunta, uma resposta, nada guardado. O proprio cabecalho dele
-- diz "nao ha thread, historico" — e estava certo em dizer, porque nao
-- havia mesmo.
--
-- A Factory precisa de conversa de verdade: o lojista abre um chat,
-- fecha, abre outro, e espera que o agente continue sendo o mesmo
-- agente — com as mesmas fontes, as mesmas memorias e as mesmas Skills,
-- mas SEM o assunto da conversa anterior.
--
-- 2. AS TRES COISAS QUE NAO SE MISTURAM
-- ---------------------------------------------------------------------
-- HISTORICO (aqui)  o que foi dito NAQUELA conversa. Morre com ela.
-- MEMORIA           preferencia que a PESSOA escreveu. Atravessa todas.
-- FONTE             arquivo que a pessoa entregou. Atravessa todas.
--
-- Uma frase dita no chat NAO vira memoria: nao ha trigger, nao ha
-- promocao, e o agente nao escreve em `agente_memorias`. Isso ja era
-- verdade na F6 e continua sendo — esta migration nao cria caminho novo
-- para burlar aquilo.
--
-- 3. ANEXO DE CONVERSA
-- ---------------------------------------------------------------------
-- `agente_fontes.conversa_id` ja existe desde a F5, como `text`. Ela
-- nasceu assim porque a camada de conversa NAO existia e fixar `uuid`
-- naquele momento seria decidir o formato dela de passagem. Agora o id
-- e uuid, e o valor viaja como texto — a coluna NAO e alterada aqui,
-- porque migration historica nao se edita. A ponte fica no codigo,
-- documentada, e nao num ALTER que reescreveria o passado.
--
-- 4. TENANT
-- ---------------------------------------------------------------------
-- FK COMPOSTA nas duas, como em `agente_skills`, `agente_fontes` e
-- `agente_memorias`. Conversa do dono A em agente do dono B e
-- impossivel; mensagem do dono A em conversa do dono B tambem.
--
-- 5. SEM RLS E SEM GRANT
-- ---------------------------------------------------------------------
-- Mesma razao documentada desde `20260916_agentes_fundacao.sql` secao 6:
-- migrations aplicam como `postgres`, cujo default ACL para tabelas ja e
-- {postgres, service_role}. GRANT seria ruido; REVOKE, no-op teatral.
-- ─────────────────────────────────────────────────────────────────────

create table if not exists public.agente_conversas (
  id        uuid        not null default gen_random_uuid(),

  user_id   text        not null,
  agente_id uuid        not null,

  -- Titulo para a lista. Pode nascer nulo e ser preenchido depois pela
  -- UI; NAO e gerado por IA aqui, porque isso seria uma chamada de
  -- modelo escondida dentro de um INSERT.
  titulo    text,

  -- Conversa arquivada some da lista sem perder o historico. Apagar de
  -- verdade e acao do dono, e ai o CASCADE leva as mensagens.
  arquivada boolean     not null default false,

  criado_em     timestamptz not null default now(),
  -- Tocado a cada mensagem nova, pela aplicacao. Sem trigger: o projeto
  -- nao tem esse padrao.
  atualizado_em timestamptz not null default now(),

  constraint agente_conversas_pk primary key (id),

  constraint agente_conversas_id_por_dono unique (user_id, id),

  constraint agente_conversas_agente_do_mesmo_dono
    foreign key (agente_id, user_id)
    references public.agentes (id, user_id)
    on delete cascade
    on update restrict,

  constraint agente_conversas_titulo_tamanho
    check (titulo is null or length(btrim(titulo)) between 1 and 200)
);

-- A consulta quente: "as conversas deste agente, mais recente primeiro".
create index if not exists idx_agente_conversas_do_agente
  on public.agente_conversas (user_id, agente_id, atualizado_em desc)
  where not arquivada;

create table if not exists public.agente_mensagens (
  id         uuid        not null default gen_random_uuid(),

  user_id    text        not null,
  conversa_id uuid       not null,

  -- `usuario` | `assistente`. NAO existe papel `sistema` aqui: as regras
  -- do sistema, as Skills e as memorias sao MONTADAS a cada turno pela
  -- camada de contexto (F6), a partir do estado atual. Persistir a
  -- instrucao junto da mensagem congelaria uma configuracao antiga e
  -- faria a conversa continuar obedecendo uma Skill ja removida.
  papel      text        not null,

  conteudo   text        not null,

  -- Ordem dentro da conversa. Explicita, e nao derivada de `criado_em`:
  -- duas mensagens no mesmo milissegundo existem, e "ordenar por tempo"
  -- e o tipo de coisa que funciona ate o dia em que nao funciona.
  ordem      integer     not null,

  -- PROVENIENCIA do turno: que ferramentas rodaram, com que desfecho.
  -- jsonb porque a forma pertence ao laco e vai crescer; o banco guarda
  -- o que aconteceu, nao um esquema que teria de ser migrado junto.
  -- NUNCA contem caminho de storage nem credencial — quem monta e
  -- `lib/agentes/conversas`, e a suite cobra.
  passos     jsonb,

  -- Uso real do provedor, para o painel de custo. Nulos numa mensagem
  -- de usuario, que nao consome modelo.
  provedor        text,
  modelo          text,
  tokens_entrada  integer,
  tokens_saida    integer,
  tempo_ms        integer,

  criado_em  timestamptz not null default now(),

  constraint agente_mensagens_pk primary key (id),

  constraint agente_mensagens_conversa_do_mesmo_dono
    foreign key (conversa_id, user_id)
    references public.agente_conversas (id, user_id)
    on delete cascade
    on update restrict,

  constraint agente_mensagens_papel_valido
    check (papel in ('usuario', 'assistente')),

  constraint agente_mensagens_conteudo_nao_vazio
    check (length(btrim(conteudo)) > 0),

  -- 20000 caracteres. Uma mensagem maior que isto nao e mensagem: e
  -- arquivo, e arquivo tem `agente_fontes`.
  constraint agente_mensagens_conteudo_tamanho
    check (length(conteudo) <= 20000),

  constraint agente_mensagens_ordem_valida check (ordem >= 0),

  -- Duas mensagens na mesma posicao da mesma conversa seriam um
  -- historico que se le diferente a cada consulta.
  constraint agente_mensagens_ordem_unica unique (conversa_id, ordem),

  constraint agente_mensagens_uso_coerente check (
    (papel = 'usuario' and provedor is null and modelo is null)
    or papel = 'assistente'
  )
);

-- A leitura do historico: a conversa inteira, na ordem.
create index if not exists idx_agente_mensagens_da_conversa
  on public.agente_mensagens (user_id, conversa_id, ordem);
