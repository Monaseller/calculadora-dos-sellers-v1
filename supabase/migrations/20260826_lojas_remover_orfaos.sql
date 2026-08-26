-- ============================================================
-- CONEXOES/CAPABILITIES-1 — remocao das lojas orfas
-- Aplicada em: 2026-08-26
--
-- ── O QUE E UMA LOJA ORFA AQUI ──────────────────────────────────────
--
-- `lojas.user_id` e NULLABLE, e 9 das 15 linhas estavam com dono NULO.
-- Auditadas uma a uma, com evidencia buscada em TODAS as 8 tabelas que
-- referenciam `lojas`:
--
--   pedidos ................................ 0
--   sync_jobs .............................. 0
--   dashboard_resumos_diarios .............. 0
--   estudio_anuncios_projetos .............. 0
--   estudio_anuncios_projetos_marketplace .. 0
--   estudio_anuncios_publicacoes ........... 0
--   estudio_anuncios_pictures_marketplace .. 0
--   estudio_anuncios_validacoes_publicacao . 0
--
-- E os 9 tokens ja estavam EXPIRADOS (nenhum valido). Sao restos de
-- tentativas repetidas de OAuth: 7 em 2026-06-26 (ML) e 2 em 2026-07-02
-- (Shopee).
--
-- ── POR QUE NAO HOUVE BACKFILL DE DONO ──────────────────────────────
--
-- Porque nao existe evidencia capaz de provar dono, e a unica pista
-- disponivel DESMENTE a inferencia em vez de sustenta-la:
--
--   O `seller_id` ML `c7fa38…` aparece em DEZ lojas — as 7 orfas mais
--   tres lojas COM dono, pertencentes a TRES usuarios CDS diferentes.
--   Ou seja: a mesma conta de vendedor externa esta ligada a tres donos
--   distintos, e `seller_id` mapeia para 3 — logo nao identifica nenhum.
--
--   No Shopee o seller mapeia para um unico dono, o que e indicio mais
--   forte, mas continua circunstancial: uma orfa pode ser de alguem que
--   conectou e nunca sincronizou.
--
-- Atribuir dono por palpite seria pior que apagar: criaria uma conexao
-- "autorizada" com credencial real para um dono que talvez nao seja o
-- verdadeiro. Preferimos perder o registro a inventar autoridade.
--
-- Efeito colateral desejavel: some do banco a credencial em texto puro
-- dessas 9 linhas (access_token; e partner_key nas duas Shopee).
--
-- ── ACHADO REGISTRADO DE PASSAGEM ───────────────────────────────────
--
-- Os tres donos do seller ML compartilhado somam 18.430 `order_id` em
-- comum. Isto e a causa-raiz do achado da AGENTES-FASE1D-e, que
-- registrou "tenants 2 e 3 compartilham ~12 mil order_ids (dataset
-- duplicado)" sem explicacao na epoca: sao tres contas CDS conectadas a
-- MESMA conta de vendedor do Mercado Livre. Nao e corrigido aqui, e o
-- modelo passa a suportar isso de proposito — ver a migration de
-- autoridade.
--
-- ── O DELETE E AUTO-GUARDADO ────────────────────────────────────────
--
-- Nao basta `WHERE user_id IS NULL`: entre o diagnostico e a aplicacao,
-- uma orfa poderia ganhar referencia. Os oito `NOT EXISTS` abaixo fazem
-- a propria condicao reverificar o que a auditoria verificou — se
-- qualquer linha tiver ganhado referencia, ela simplesmente NAO e
-- apagada, em vez de o comando falhar ou apagar dado vivo.
-- ============================================================

delete from public.lojas l
where l.user_id is null
  and not exists (select 1 from public.pedidos                                p  where p.loja_id  = l.id)
  and not exists (select 1 from public.sync_jobs                              s  where s.loja_id  = l.id)
  and not exists (select 1 from public.dashboard_resumos_diarios              d  where d.loja_id  = l.id)
  and not exists (select 1 from public.estudio_anuncios_projetos              e  where e.loja_id  = l.id)
  and not exists (select 1 from public.estudio_anuncios_projetos_marketplace  pm where pm.loja_id = l.id)
  and not exists (select 1 from public.estudio_anuncios_publicacoes           pu where pu.loja_id = l.id)
  and not exists (select 1 from public.estudio_anuncios_pictures_marketplace  pi where pi.loja_id = l.id)
  and not exists (select 1 from public.estudio_anuncios_validacoes_publicacao v  where v.loja_id  = l.id);

-- ── O QUE ESTA MIGRATION NAO FAZ ───────────────────────────────────
--   - Nao apaga loja COM dono, nem mesmo as duas que tem token expirado
--     e zero pedidos (`32639c…` e `93790f…`): ter dono e o criterio.
--   - Nao altera schema, tipo, constraint ou indice.
--   - Nao toca em pedidos, sync_jobs, dashboard ou Estudio.
--   - Nao exibe nem move credencial alguma.
