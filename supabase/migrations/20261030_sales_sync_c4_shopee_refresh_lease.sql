-- =====================================================================
-- CDS-STABILIZATION SALES-SYNC-C4 — LEASE DISTRIBUIDO DO REFRESH SHOPEE
--
-- NAO APLICADA neste gate (o proximo gate faz preflight → autorizacao →
-- apply → teste real).
--
-- ── O DEFEITO RESIDUAL QUE ESTA TABELA FECHA ───────────────────────
--
-- O C3 deixou o refresh Shopee seguro NO BANCO (compare-and-swap sobre o
-- refresh_token lido + releitura da vencedora). Mas o CAS acontece DEPOIS
-- da chamada ao provider: duas instancias que leram o mesmo R0 ainda
-- podem chamar a Shopee ao mesmo tempo. Nao se sabe se a Shopee emite
-- R1 e R2 a partir do mesmo R0 e invalida R1 ao emitir R2 — se fizer, o
-- vencedor do CAS (R1) pode guardar um par que o provider ja nao honra.
-- A cura e impedir a SEGUNDA chamada: no maximo um refresh em andamento
-- por loja, coordenado pelo banco (instancias serverless nao compartilham
-- memoria). O CAS continua como defesa em profundidade.
--
-- ── POR QUE LEASE, E NAO LOCK DE SESSAO ───────────────────────────
--
-- `pg_advisory_lock` morreria com a conexao do pooler e
-- `pg_advisory_xact_lock` com a transacao da RPC — nenhum dos dois cobre
-- a chamada HTTP que acontece FORA do banco. Mesmo raciocinio (e mesma
-- forma) de public.agente_ingestao_monitor_lease (20261014), que nao e
-- reaproveitavel: e presa a `agentes` e a mercado_livre/perguntas.
--
-- ── FORMA ──────────────────────────────────────────────────────────
--
-- Uma linha por (loja, marketplace), reaproveitada a cada aquisicao. A
-- EXPIRACAO (relogio do banco) e a garantia real contra processo morto;
-- a liberacao explicita e melhor esforco e casada com o PORTADOR. Cerca
-- de dono pela FK (loja_id, user_id) → lojas(id, user_id). So Shopee por
-- ora (o ML ja e seguro pelo CAS dele e nao entra aqui).
--
-- TTL: o chamador pede 30 s (faixa aceita 5..120). O refresh HTTP da
-- Shopee aborta em 8 s (refreshShopeeToken); CAS + releitura somam
-- poucos segundos. 30 s cobre o caminho normal com folga e devolve a
-- loja sozinho em ate 30 s se o portador morrer.
--
-- ── SEGURANCA (padrao SEC-3) ───────────────────────────────────────
--
-- RLS ligada, 0 policies; REVOKE nominal de PUBLIC, anon e authenticated
-- (este projeto tem ALTER DEFAULT PRIVILEGES concedendo a eles em objeto
-- novo — bug SEC1); service_role so com o minimo (INSERT/UPDATE na
-- tabela, EXECUTE nas duas RPCs). Nada exposto ao browser.
--
-- ── ROLLBACK EXATO ─────────────────────────────────────────────────
--     BEGIN;
--     SET LOCAL lock_timeout = '5s';
--     DROP FUNCTION public.liberar_lease_refresh_credencial(text, uuid, text, text);
--     DROP FUNCTION public.adquirir_lease_refresh_credencial(text, uuid, text, text, integer);
--     DROP TABLE public.credencial_refresh_lease;
--     COMMIT;
-- (o codigo C4 trata RPC inexistente como "lease indisponivel" e cai no
-- modo C3 — CAS sem lease —, entao o rollback nao derruba o refresh)
-- =====================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE public.credencial_refresh_lease (
  user_id      text        NOT NULL,
  loja_id      uuid        NOT NULL,
  marketplace  text        NOT NULL,
  -- Quem detem o direito AGORA: opaco, gerado por tentativa (UUID), sem
  -- significado de negocio e nunca derivado de token/segredo.
  portador     text        NOT NULL,
  adquirida_em timestamptz NOT NULL DEFAULT now(),
  expira_em    timestamptz NOT NULL,
  liberada_em  timestamptz NULL,
  -- Esta aquisicao tomou o lugar de um portador que NAO liberou (morreu)?
  tomada_de_expirada boolean NOT NULL DEFAULT false,
  tomadas      integer     NOT NULL DEFAULT 0,

  CONSTRAINT credencial_refresh_lease_pk PRIMARY KEY (loja_id, marketplace),
  CONSTRAINT credencial_refresh_lease_loja_do_mesmo_dono
    FOREIGN KEY (loja_id, user_id) REFERENCES public.lojas (id, user_id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT credencial_refresh_lease_marketplace_conhecido CHECK (marketplace = 'Shopee'),
  CONSTRAINT credencial_refresh_lease_portador_nao_vazio CHECK (length(btrim(portador)) > 0),
  CONSTRAINT credencial_refresh_lease_tempos_coerentes
    CHECK (expira_em >= adquirida_em AND (liberada_em IS NULL OR liberada_em >= adquirida_em)),
  CONSTRAINT credencial_refresh_lease_tomadas_nao_negativas CHECK (tomadas >= 0)
);

COMMENT ON TABLE public.credencial_refresh_lease IS
  'Direito temporario de chamar o refresh de token do marketplace para UMA loja (SALES-SYNC-C4). Coordenacao entre instancias, sem historico. A expiracao (relogio do banco) e a garantia real; liberacao explicita e melhor esforco, casada com o portador.';

ALTER TABLE public.credencial_refresh_lease ENABLE ROW LEVEL SECURITY;

-- ── Aquisicao ATOMICA ────────────────────────────────────────────────
-- UM comando: o WHERE do DO UPDATE e avaliado com a linha ja travada,
-- entao a segunda tentativa concorrente reavalia depois da primeira ter
-- escrito, ve o lease novo e afeta zero linhas. Relogio do BANCO.
CREATE FUNCTION public.adquirir_lease_refresh_credencial(
  p_user_id text,
  p_loja_id uuid,
  p_marketplace text,
  p_portador text,
  p_ttl_segundos integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF p_portador IS NULL OR length(btrim(p_portador)) = 0 THEN
    RAISE EXCEPTION 'portador obrigatorio';
  END IF;
  IF p_ttl_segundos IS NULL OR p_ttl_segundos < 5 OR p_ttl_segundos > 120 THEN
    RAISE EXCEPTION 'ttl fora da faixa permitida';
  END IF;

  INSERT INTO public.credencial_refresh_lease AS alvo (
    user_id, loja_id, marketplace, portador, adquirida_em, expira_em, liberada_em, tomada_de_expirada, tomadas
  )
  VALUES (
    p_user_id, p_loja_id, p_marketplace, p_portador, now(), now() + make_interval(secs => p_ttl_segundos), NULL, false, 0
  )
  ON CONFLICT (loja_id, marketplace) DO UPDATE
    SET portador = excluded.portador,
        adquirida_em = now(),
        expira_em = now() + make_interval(secs => p_ttl_segundos),
        liberada_em = NULL,
        tomada_de_expirada = (alvo.liberada_em IS NULL),
        tomadas = alvo.tomadas + 1
    -- O lease em si, e a cerca de dono: dono errado nunca adquire.
    WHERE alvo.expira_em <= now()
      AND alvo.user_id = p_user_id;

  RETURN FOUND;
END;
$$;

COMMENT ON FUNCTION public.adquirir_lease_refresh_credencial(text, uuid, text, text, integer) IS
  'Adquire, em UM comando, o direito de renovar a credencial daquela loja. false = outra execucao detem lease valido (ou dono incoerente). Relogio do banco.';

-- ── Liberacao — casada com o PORTADOR ───────────────────────────────
CREATE FUNCTION public.liberar_lease_refresh_credencial(
  p_user_id text,
  p_loja_id uuid,
  p_marketplace text,
  p_portador text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  UPDATE public.credencial_refresh_lease AS alvo
     SET expira_em = now(),
         liberada_em = now()
   WHERE alvo.loja_id = p_loja_id
     AND alvo.user_id = p_user_id
     AND alvo.marketplace = p_marketplace
     AND alvo.portador = p_portador
     AND alvo.liberada_em IS NULL;

  RETURN FOUND;
END;
$$;

COMMENT ON FUNCTION public.liberar_lease_refresh_credencial(text, uuid, text, text) IS
  'Libera o lease ANTES da expiracao, somente se o portador for o mesmo que adquiriu. Melhor esforco: a expiracao continua sendo a garantia real.';

-- ── Privilegios ──────────────────────────────────────────────────────
-- Uma instrucao com os tres papeis: o padrao fail-closed exigido desde a
-- SEC-3-C (scripts/testar-s2d1-migracao.ts, teste 7).
REVOKE ALL PRIVILEGES ON TABLE public.credencial_refresh_lease FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.credencial_refresh_lease FROM service_role;
-- RPCs security invoker: quem executa precisa do privilegio na tabela.
GRANT INSERT, UPDATE ON TABLE public.credencial_refresh_lease TO service_role;

REVOKE ALL ON FUNCTION public.adquirir_lease_refresh_credencial(text, uuid, text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.adquirir_lease_refresh_credencial(text, uuid, text, text, integer) FROM anon;
REVOKE ALL ON FUNCTION public.adquirir_lease_refresh_credencial(text, uuid, text, text, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.adquirir_lease_refresh_credencial(text, uuid, text, text, integer) TO service_role;

REVOKE ALL ON FUNCTION public.liberar_lease_refresh_credencial(text, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.liberar_lease_refresh_credencial(text, uuid, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.liberar_lease_refresh_credencial(text, uuid, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.liberar_lease_refresh_credencial(text, uuid, text, text) TO service_role;

COMMIT;
