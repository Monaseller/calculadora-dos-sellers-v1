-- ============================================================
-- SKILL-1D.f.4-A — RPC de promocao atomica de versao vigente
--
-- NAO APLICADA AINDA. Aplicar ao banco exige autorizacao explicita,
-- separada da criacao deste arquivo.
--
-- ── O PROBLEMA ──────────────────────────────────────────────────────
--
-- Promover uma versao a `vigente` e, necessariamente, DOIS movimentos:
-- despromover a versao vigente atual daquele `(user_id, slug)` e marcar
-- a nova. O invariante que `idx_skills_vigente_por_slug` protege — no
-- maximo UMA vigente por dono+slug — precisa valer em todo instante
-- observavel, e nao apenas no fim.
--
-- ── POR QUE NAO DA PARA FAZER ISSO NA APLICACAO ─────────────────────
--
-- O cliente Supabase fala por HTTP: cada `.update()` e uma requisicao
-- com transacao propria. Nao existe transacao multi-statement pelo
-- cliente (medido: zero `begin`/`commit` de cliente em todo o repo).
--
-- Duas `.update()` separadas teriam janela observavel entre elas; se a
-- segunda falhasse, o slug ficaria SEM NENHUMA vigente; e duas
-- promocoes concorrentes nao se serializariam. Na ordem inversa —
-- promover antes de despromover — a colisao com o indice parcial e
-- imediata. Nao ha como fingir atomicidade ali.
--
-- ── POR QUE NAO UM UNICO UPDATE ─────────────────────────────────────
--
-- A forma elegante seria:
--
--     update public.skills set vigente = (id = p_skill_id) where ...
--
-- Ela e uma armadilha. `idx_skills_vigente_por_slug` e
-- `CREATE UNIQUE INDEX`, nao constraint — e so CONSTRAINT aceita
-- `DEFERRABLE`. A unicidade e verificada linha a linha durante o
-- statement: se a linha alvo for processada ANTES da despromocao da
-- vigente atual, existem transitoriamente duas entradas `vigente` no
-- indice e o comando morre com 23505.
--
-- Pior: isso depende da ordem fisica de varredura, entao a falha seria
-- INTERMITENTE. Falha nao-deterministica e pior que falha certa.
--
-- ── A ESCOLHA: DUAS UPDATES DENTRO DE UMA FUNCAO ────────────────────
--
-- Uma chamada de funcao e uma transacao. As duas UPDATEs acontecem ou
-- nenhuma acontece. E, despromovendo PRIMEIRO, nunca existe instante em
-- que duas linhas do mesmo slug estejam `vigente` — o indice parcial
-- nunca e testado contra um estado transitorio invalido.
--
-- ── O FILTRO QUE ESTA FALTANDO DE PROPOSITO ─────────────────────────
--
-- A despromocao NAO tem `and vigente`. Isso parece desperdicio: escreve
-- linhas que ja estao `false`. E deliberado, e e o coracao do desenho.
--
-- Um `UPDATE` trava as linhas que ESCREVE. Com o filtro, o caso mais
-- comum — nenhuma versao vigente ainda, que e o estado de toda Skill
-- recem-importada, ja que `vigente` nasce `false` — casaria ZERO linhas
-- e nao travaria nada. Duas promocoes concorrentes passariam juntas ate
-- colidirem no indice.
--
-- Sem o filtro, a despromocao escreve todas as versoes daquele slug e
-- adquire os locks correspondentes: a segunda transacao bloqueia na
-- primeira linha, espera o commit da primeira, reavalia e completa. O
-- custo e uma escrita morta por versao a cada promocao; a alternativa e
-- perder a serializacao justamente no caso mais frequente.
--
-- ── O QUE ESTE DESENHO AINDA NAO PROVA ──────────────────────────────
--
-- A serializacao acima e o comportamento ESPERADO de row locks sob READ
-- COMMITTED — nao um fato medido. Nao ha ciclo de locks intencional
-- conhecido, e promocoes de slugs ou tenants distintos tocam conjuntos
-- de linhas disjuntos; mas AUSENCIA DE DEADLOCK NAO ESTA PROVADA, e
-- concorrencia real so sera exercitada na SKILL-1D.f.4-E, com duas
-- sessoes independentes. Deadlock aqui e FALHA, nunca fluxo normal:
-- por isso nao ha retry, nem tratamento que o transforme em sucesso.
--
-- ── POR QUE NAO `SELECT ... FOR UPDATE` ─────────────────────────────
--
-- Seria o lock explicito obvio, e foi descartado por dois motivos. O
-- primeiro e que a despromocao ja adquire os mesmos locks. O segundo e
-- de privilegio: no PostgreSQL `SELECT ... FOR UPDATE` exige privilegio
-- de UPDATE de TABELA, e `service_role` tem apenas UPDATE de COLUNA em
-- `vigente` — o lock explicito provavelmente seria recusado com 42501.
-- Advisory lock tambem nao entra: seria trava global sem caso concreto.
--
-- ── SECURITY INVOKER, E O QUE ISSO GARANTE ──────────────────────────
--
-- A funcao roda com os privilegios de quem chama, `service_role`. Como
-- esse papel so tem `update (vigente)`, a ACL de coluna continua valendo
-- DENTRO da funcao: um corpo que tentasse escrever `corpo` ou
-- `manifesto` morreria com 42501. `SECURITY DEFINER` seria escalada sem
-- necessidade — e nenhuma das 27 funcoes deste projeto usa DEFINER.
--
-- Esta migration NAO altera tabela, coluna, indice, constraint, trigger
-- nem a ACL de `skills`/`agente_skills`. O desenho cabe inteiro nos
-- privilegios ja publicados pela 20260922.
-- ============================================================

create or replace function public.promover_skill_vigente(
  p_user_id text,
  p_skill_id uuid
)
returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_slug    text;
  v_vigente boolean;
  v_linhas  integer;
begin
  -- Alvo resolvido pelos DOIS campos juntos. O `slug` sai daqui, nunca
  -- de parametro: aceitar slug externo permitiria promover dentro do
  -- dominio de outro slug com um id que nao pertence a ele.
  select skills.slug, skills.vigente
    into v_slug, v_vigente
    from public.skills
   where skills.id = p_skill_id
     and skills.user_id = p_user_id;

  -- Skill inexistente e Skill de outro dono sao INDISTINGUIVEIS aqui, de
  -- proposito: separa-las viraria um oraculo de existencia alheia.
  if not found then
    return 'nao_disponivel';
  end if;

  -- Ja vigente: o estado final desejado ja vale. Retorna ANTES de
  -- qualquer escrita — nao ha o que mudar, e reescrever so produziria
  -- tuplas mortas.
  if v_vigente then
    return 'ja_vigente';
  end if;

  -- DESPROMOCAO — e o mecanismo de serializacao. Sem `and vigente` de
  -- proposito: ver o cabecalho.
  update public.skills
     set vigente = false
   where skills.user_id = p_user_id
     and skills.slug = v_slug;

  -- PROMOCAO — fechada pelos dois campos, como a resolucao do alvo.
  update public.skills
     set vigente = true
   where skills.id = p_skill_id
     and skills.user_id = p_user_id;

  get diagnostics v_linhas = row_count;

  -- O alvo existia na resolucao e sumiu antes desta linha. Retornar
  -- `nao_disponivel` aqui COMMITARIA a despromocao — o slug ficaria sem
  -- nenhuma vigente, efeito colateral silencioso de uma operacao que
  -- disse nao ter feito nada. O `raise` desfaz a transacao inteira.
  --
  -- A mensagem nao carrega id, dono nem slug.
  if v_linhas <> 1 then
    raise exception 'alvo de promocao indisponivel'
      using errcode = '02000';
  end if;

  return 'promovida';
end;
$$;

-- ── Privilegios ─────────────────────────────────────────────────────
--
-- Os REVOKE nominais de `anon` e `authenticated` NAO sao redundancia de
-- `from public`: este projeto tem `ALTER DEFAULT PRIVILEGES` concedendo
-- EXECUTE a esses papeis em TODA funcao nova, e `PUBLIC` e um
-- pseudo-role distinto — `revoke from public` nao alcanca a concessao
-- nominal. Foi exatamente a causa do bug SEC1.
--
-- `service_role` tambem e revogado antes do grant: GRANT e aditivo, e
-- comecar de um estado conhecido e a unica forma de o arquivo descrever
-- o resultado.

revoke all on function public.promover_skill_vigente(text, uuid) from public;
revoke all on function public.promover_skill_vigente(text, uuid) from anon;
revoke all on function public.promover_skill_vigente(text, uuid) from authenticated;
revoke all on function public.promover_skill_vigente(text, uuid) from service_role;

grant execute on function public.promover_skill_vigente(text, uuid) to service_role;
