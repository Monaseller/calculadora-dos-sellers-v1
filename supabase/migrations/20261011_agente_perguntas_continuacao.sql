-- ============================================================
-- M2-I1-A8B — `agente_perguntas_continuacao`: onde a proxima
-- varredura de perguntas COMECA.
--
-- NAO APLICADA AINDA. Aplicar ao banco exige autorizacao explicita,
-- separada da criacao deste arquivo.
--
-- ── A PERGUNTA QUE ESTA TABELA RESPONDE ─────────────────────────────
--
-- "a varredura de daqui a cinco minutos vai olhar de novo as mesmas 100
--  primeiras perguntas, ou vai adiante?"
--
-- Hoje a resposta e "as mesmas 100". A acao visita `offset 0` e
-- `offset 50` e termina; a proxima comeca em 0 outra vez. Uma conta com
-- 150 perguntas nao respondidas nunca alcanca a de numero 101 — e o
-- carry `PAGINATION_OVERFLOW_F1` e exatamente isso.
--
-- ── POR QUE ESTADO DURAVEL, E NAO O LEDGER DE ACAO ─────────────────
--
-- `agente_acao_execucoes.entrada_resumo` ja guarda `truncado` e
-- `limite_atingido`, entao seria tentador derivar dali o proximo
-- deslocamento. Nao serve, e por um caso PROVADO: quando a inbox grava e
-- o desfecho da acao falha (I3B, casos A12/A13), aquele `entrada_resumo`
-- NUNCA e escrito. A continuacao estaria justamente no registro que se
-- perdeu, e a varredura seguinte recomecaria do zero sem que ninguem
-- soubesse.
--
-- Auditoria diz o que ACONTECEU. Cursor diz o que FAZER EM SEGUIDA. Usar
-- a primeira como o segundo transforma um buraco de auditoria num buraco
-- de dado.
--
-- ── A UNICA TABELA MUTAVEL DESTE TERRITORIO ────────────────────────
--
-- Inbox e append-com-upsert; os dois ledgers sao append-only. Esta muda
-- de valor, e por isso toda escrita passa por comparacao e troca (CAS)
-- sobre `versao` — ver o comentario da coluna.
-- ============================================================

-- ── Sem `if not exists`, e isto e deliberado ─────────────────────────
--
-- Mesma decisao de `20261010`: a tabela e nova e as constraints sao
-- apertadas de proposito. Um objeto de mesmo nome com OUTRA forma seria
-- aceito em silencio, e o cursor passaria a operar contra um contrato
-- que ninguem conferiu. Falhar alto e a resposta honesta.
create table public.agente_perguntas_continuacao (
  -- ── A identidade: a MESMA forma de `agente_conexoes` ──────────────
  --
  -- La a chave primaria e `(agente_id, plataforma, recurso)`, sem
  -- `user_id`: o agente ja determina o dono, e a FK composta fecha o
  -- resto. Repetir aqui a forma que o projeto ja usa para "um agente,
  -- um requisito canonico, um valor" evita inventar uma segunda.
  agente_id   uuid        not null,
  user_id     text        not null,

  -- O requisito canonico, igual ao de `agente_conexoes` e ao que o
  -- catalogo de Funcoes declara em `conexaoNecessaria`.
  plataforma  text        not null,
  recurso     text        not null,

  -- ── A conta para a qual o deslocamento VALE ───────────────────────
  --
  -- NULL enquanto nenhuma pagina autoritativa existiu. Ela NAO e
  -- resolvida por esta camada: vem de `resultado.autoridade.lojaId` da
  -- execucao de Funcao que de fato buscou — a mesma e unica resolucao
  -- que o I2 deixou de pe para fechar o TOCTOU entre buscar e gravar.
  --
  -- E e por existir esta coluna que a troca de vinculo falha FECHADA: se
  -- o cursor diz `loja A` e a execucao devolve `loja B`, o deslocamento
  -- guardado nao vale para B, a pagina e descartada e o cursor reinicia.
  -- Sem esta coluna, um `offset 150` de A seria aplicado a B e as 150
  -- primeiras perguntas de B sumiriam em silencio.
  loja_id     uuid        null,

  -- Onde a PROXIMA varredura comeca. Sempre o deslocamento BRUTO do
  -- provider, nunca contagem de linhas normalizadas: descarte de forma
  -- nao pode mover a janela.
  proximo_deslocamento integer not null default 0,

  -- ── O token de CAS, e por que `(loja, deslocamento)` NAO basta ────
  --
  -- Um `update ... where loja_id = A and proximo_deslocamento = 0`
  -- parece suficiente ate aparecer o ABA: um trabalhador le `(A, 0)`;
  -- enquanto ele busca, uma travessia inteira acontece — 0 -> 50 -> 100
  -- -> fim de lista -> volta a 0; o trabalhador entao aplica a troca
  -- para `(A, 50)` e o `where` PASSA, porque o par voltou a ser o mesmo.
  -- O cursor saltaria as perguntas 0..49 da travessia nova, e nenhum
  -- contador denunciaria.
  --
  -- `versao` e monotonica e nunca volta, entao o mesmo ABA reprova. O
  -- par continua no `where` como cinto e suspensorio — ele nao adiciona
  -- garantia, adiciona diagnostico: quem perde a corrida descobre POR
  -- QUE perdeu.
  versao      bigint      not null default 1,

  criado_em   timestamptz not null default now(),
  -- Sem trigger: este projeto nao tem nenhum. Quem escreve atualiza a
  -- coluna explicitamente, como em `agente_conexoes`.
  alterado_em timestamptz not null default now(),

  constraint agente_perguntas_continuacao_pk
    primary key (agente_id, plataforma, recurso),

  -- ── Cerca de dono ─────────────────────────────────────────────────
  --
  -- Mesma forma das FKs compostas que o schema ja usa. Um cursor de
  -- agente de um dono apontando para loja de outro e ESTRUTURALMENTE
  -- impossivel.
  constraint agente_perguntas_continuacao_agente_do_mesmo_dono
    foreign key (agente_id, user_id)
    references public.agentes (id, user_id)
    on update restrict on delete restrict,

  -- `match simple` e o padrao, e aqui ele importa: com `loja_id` NULL a
  -- composta NAO e verificada, que e exatamente o que o estado inicial
  -- precisa. Preenchida, a cerca volta a valer inteira.
  constraint agente_perguntas_continuacao_loja_do_mesmo_dono
    foreign key (loja_id, user_id)
    references public.lojas (id, user_id)
    on update restrict on delete restrict,

  constraint agente_perguntas_continuacao_deslocamento_nao_negativo
    check (proximo_deslocamento >= 0),

  -- ── Deslocamento adiantado EXIGE conta ────────────────────────────
  --
  -- Um cursor em 150 sem loja nao tem a que se referir, e aplicar esse
  -- 150 na primeira conta que aparecesse seria exatamente o salto
  -- silencioso que esta tabela existe para impedir. Zero sem loja e o
  -- estado inicial legitimo: comecar do comeco serve para qualquer conta.
  constraint agente_perguntas_continuacao_adiantado_exige_loja
    check (proximo_deslocamento = 0 or loja_id is not null),

  constraint agente_perguntas_continuacao_versao_positiva
    check (versao >= 1),

  -- O par canonico. Fechado no banco porque um cursor de
  -- `(shopee, perguntas)` neste caminho seria um requisito que a Funcao
  -- de perguntas do ML nunca vai atender.
  constraint agente_perguntas_continuacao_requisito_conhecido
    check (plataforma = 'mercado_livre' and recurso = 'perguntas')
);

-- ── Por que NAO ha CHECK de alinhamento ao tamanho da pagina ─────────
--
-- Seria facil exigir `proximo_deslocamento % 50 = 0`, e seria errado: 50
-- e `PAGE_LIMIT`, uma constante de DOMINIO que muda quando o limite do
-- provider ou a janela da varredura mudarem. Um CHECK amarrado a ela
-- transformaria um ajuste de codigo numa migration, e — pior — um valor
-- legitimo gravado sob o limite antigo passaria a ser recusado pelo
-- banco na leitura seguinte. O alinhamento e regra de quem calcula a
-- janela, e vive com ela.

comment on table public.agente_perguntas_continuacao is
  'Onde a PROXIMA varredura de perguntas do Mercado Livre comeca, por agente. E ESTADO DE CONTROLE, nao auditoria: `agente_acao_execucoes` diz o que aconteceu e esta tabela diz o que fazer em seguida. Uma linha por (agente, plataforma, recurso) — troca de vinculo REINICIA a mesma linha em vez de criar outra. `loja_id` e a conta para a qual `proximo_deslocamento` vale; cursor de uma conta nunca e aplicado a outra. Toda escrita e comparacao-e-troca sobre `versao`.';

comment on column public.agente_perguntas_continuacao.loja_id is
  'A conta autoritativa para a qual `proximo_deslocamento` vale. NULL antes da primeira pagina. Vem de `resultado.autoridade.lojaId` da execucao de Funcao, nunca de uma segunda resolucao de vinculo e nunca do chamador.';

comment on column public.agente_perguntas_continuacao.proximo_deslocamento is
  'Deslocamento BRUTO do provider em que a proxima varredura comeca. Nunca contagem de linhas normalizadas: descarte de forma nao move a janela.';

comment on column public.agente_perguntas_continuacao.versao is
  'Token de comparacao-e-troca. Monotonica. Existe porque conferir apenas (loja_id, proximo_deslocamento) sofre ABA: uma travessia completa devolve o par ao valor antigo e deixaria uma escrita obsoleta passar, saltando perguntas em silencio.';

-- ── Privilegios ──────────────────────────────────────────────────────
--
-- Os REVOKE nominais nao sao redundancia de `from public`: `PUBLIC` e
-- pseudo-role distinto de `anon` e `authenticated`, e este projeto tem
-- `ALTER DEFAULT PRIVILEGES` concedendo privilegio a eles em objeto
-- novo. Foi o que causou o bug SEC1.
revoke all on table public.agente_perguntas_continuacao from public;
revoke all on table public.agente_perguntas_continuacao from anon;
revoke all on table public.agente_perguntas_continuacao from authenticated;
revoke all on table public.agente_perguntas_continuacao from service_role;

-- ── UPDATE entra, DELETE nao ─────────────────────────────────────────
--
-- Esta e a primeira tabela desta frente que muda de valor, entao UPDATE
-- e necessario. DELETE nao: o reinicio de travessia e `proximo_deslocamento
-- = 0` na MESMA linha, o que preserva `criado_em`, a versao monotonica e
-- o rastro de `alterado_em`. Apagar e recriar perderia os tres e abriria
-- uma corrida entre o DELETE e o INSERT seguinte.
grant select, insert, update on table public.agente_perguntas_continuacao to service_role;

-- Cinto e suspensorio, como nas tabelas vizinhas: se um GRANT futuro
-- reintroduzir remocao por descuido, estes REVOKE a tiram.
revoke delete, truncate on table public.agente_perguntas_continuacao from service_role;
