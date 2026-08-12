-- ============================================================
-- Backfill: pedidos.loja_id (2026-07-11)
--
-- Pré-requisito: supabase/migrations/20260711_loja_id_pedidos.sql já
-- executada (coluna loja_id existe em `pedidos`).
--
-- Rodar cada bloco NA ORDEM, manualmente, no SQL Editor do Supabase.
-- Ler o resultado de cada passo antes de seguir pro próximo — este
-- script não é "rodar tudo de uma vez".
--
-- Estratégia de junção: casa (user_id, marketplace, conta) em `pedidos`
-- com (user_id, marketplace, nickname) em `lojas`, SEM filtrar por
-- lojas.ativo — pedidos de lojas já desconectadas também precisam de
-- loja_id (não só as lojas ativas hoje). Match é exato (=), sem
-- lower()/trim(), porque `conta` foi gravado como cópia literal de
-- `loja.nickname` no momento do sync (sync-shopee.ts/sync-ml.ts) — se
-- o nickname mudou depois na Shopee/ML, esses pedidos ficam sem match e
-- aparecem no PASSO 4 (não silenciosamente ignorados).
--
-- NOTA (descoberta ao rodar o Passo 2, 2026-07-11): `lojas.user_id` é
-- UUID e `pedidos.user_id` é TEXT — tipos diferentes para o mesmo dado.
-- Não é bug do app (Supabase/PostgREST faz esse cast sozinho nas chamadas
-- normais da aplicação), mas em SQL puro o Postgres exige cast explícito.
-- Por isso todo join abaixo usa `l.user_id::text = p.user_id`.
-- ============================================================


-- ── PASSO 1 (pré-validação, obrigatório) ────────────────────────────────
-- Colisão de nickname considerando TODAS as lojas (inclusive desconectadas),
-- não só ativo=true — a checagem aprovada em 2026-07-11 só cobriu
-- ativo=true. Se este passo retornar alguma linha, PARAR e resolver a
-- ambiguidade antes de continuar (não dá pra saber com certeza para qual
-- loja esses pedidos pertencem).
select user_id, marketplace, nickname, count(distinct id) as lojas_com_esse_nickname
from lojas
where user_id is not null
group by user_id, marketplace, nickname
having count(distinct id) > 1;
-- Esperado: 0 linhas. Se vier alguma linha, PARAR aqui.


-- ── PASSO 2 (pré-validação, contexto) ───────────────────────────────────
-- Quantos pedidos existem hoje, quantos já têm loja_id (deve ser 0 antes
-- do backfill, exceto se algum pedido novo já foi sincronizado com o
-- código atualizado) e quantos ficarão de fora por não ter loja
-- correspondente encontrável.
select
  count(*) as total_pedidos,
  count(loja_id) as ja_com_loja_id,
  count(*) filter (
    where not exists (
      select 1 from lojas l
      where l.user_id::text = pedidos.user_id
        and l.marketplace = pedidos.marketplace
        and l.nickname = pedidos.conta
    )
  ) as sem_loja_correspondente
from pedidos;
-- "sem_loja_correspondente" > 0 é esperado se algum nickname mudou desde
-- o sync original, ou se a loja foi excluída (não só desativada) do banco.
-- Não precisa ser zero para prosseguir, mas anote o número antes do
-- backfill pra comparar com o PASSO 4 depois.


-- ── PASSO 3 (o backfill em si) ──────────────────────────────────────────
-- Só atualiza pedidos com loja_id ainda NULL — idempotente, pode rodar de
-- novo sem duplicar nem sobrescrever o que já foi resolvido.
update pedidos p
set loja_id = l.id
from lojas l
where p.user_id = l.user_id::text
  and p.marketplace = l.marketplace
  and p.conta = l.nickname
  and p.loja_id is null;
-- Retorna "UPDATE <n>" — confira se n bate com
-- (total_pedidos - ja_com_loja_id - sem_loja_correspondente) do PASSO 2.


-- ── PASSO 4 (pós-validação, obrigatório) ────────────────────────────────
-- Cobertura final do backfill.
select
  count(*) as total_pedidos,
  count(loja_id) as com_loja_id,
  count(*) - count(loja_id) as ainda_sem_loja_id
from pedidos;


-- ── PASSO 5 (pós-validação, detalhe dos que ficaram sem match) ──────────
-- Se "ainda_sem_loja_id" (PASSO 4) > 0, este passo mostra exatamente
-- quais (user_id, marketplace, conta) não casaram com nenhuma loja —
-- geralmente nickname que mudou depois do sync, ou loja removida do
-- banco (não só desativada). Decidir caso a caso, não em massa.
select user_id, marketplace, conta, count(*) as pedidos_afetados
from pedidos
where loja_id is null
group by user_id, marketplace, conta
order by pedidos_afetados desc;


-- ── PASSO 6 (pós-validação, math-must-match — regra já em vigor no
-- projeto para qualquer camada de agregação) ────────────────────────────
-- Confere que o backfill não alterou nenhum valor financeiro — só
-- preencheu a coluna nova. Soma de faturamento/lucro por marketplace
-- antes e depois deve ser idêntica (rode isso ANTES do PASSO 3 também,
-- salve o resultado, e compare).
select marketplace, count(*) as pedidos, sum(faturamento) as faturamento, sum(margem_contrib) as lucro
from pedidos
group by marketplace;
