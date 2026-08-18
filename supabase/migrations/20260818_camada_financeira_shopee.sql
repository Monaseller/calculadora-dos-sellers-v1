-- 20260818_camada_financeira_shopee.sql
--
-- Camada financeira Shopee: colunas minimas para reconciliar `pedidos` contra
-- /api/v2/payment/get_escrow_detail.
--
-- CONTEXTO (auditoria de 2026-08-18, dia 04/07 com escrow real de 770 pedidos):
--   - taxas REAIS da Shopee   : R$ 6.773,07
--   - `tarifa_venda` ESTIMADA : R$ 3.410,08  -> o CDS enxerga 50,3% do real
--   - repasse real (escrow)   : 60,7% do item_subtotal, contra ~83% de "margem"
--     exibida hoje no Dashboard.
--
-- CRITERIO DE SELECAO: `order_income` tem 91 campos; 51 vieram sempre zerados e
-- outros ~20 sao de outros paises (th_import_duty, withholding_*, cross_border_tax).
-- Persistimos apenas o que alimenta uma metrica declarada abaixo. Campo sem
-- consumidor nao entra.
--
-- NAO cria indice novo: a fila financeira e filtrada por
-- (user_id, marketplace, status_shopee_raw, financial_reconciled_at) e o volume
-- elegivel atual e de ~8 mil pedidos. Indice so depois de medir necessidade real.

-- ── Camada B: decomposicao das taxas do marketplace ─────────────────────────
-- Alimentam "Taxas Shopee" e explicam POR QUE o repasse chegou naquele valor.
-- commission_fee / service_fee / transaction_fee / campaign_fee JA EXISTEM.
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS net_commission_fee        NUMERIC DEFAULT 0;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS net_service_fee           NUMERIC DEFAULT 0;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS order_ams_commission_fee  NUMERIC DEFAULT 0;

-- ── Descontos custeados pelo vendedor ───────────────────────────────────────
-- voucher_from_seller / voucher_from_shopee JA EXISTEM.
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS seller_product_rebate     NUMERIC DEFAULT 0;

-- ── Ajustes e devolucoes ────────────────────────────────────────────────────
-- Assinatura de cancelamento/devolucao: escrow_amount = 0 E seller_return_refund < 0.
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS seller_return_refund      NUMERIC DEFAULT 0;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS total_adjustment_amount   NUMERIC DEFAULT 0;

-- Repasse ANTES do ajuste. `escrow_amount` guarda o valor FINAL
-- (escrow_amount_after_adjustment quando existir); esta coluna preserva o bruto
-- para que a diferenca seja auditavel sem nova chamada a Shopee.
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS escrow_amount_bruto       NUMERIC DEFAULT 0;

-- ── Frete subsidiado ────────────────────────────────────────────────────────
-- O `service_fee` da Shopee e majoritariamente o programa de frete gratis; sem
-- este campo a taxa efetiva de ~44% fica sem explicacao.
-- frete_real (= actual_shipping_fee) e frete_estimado JA EXISTEM.
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS shopee_shipping_rebate    NUMERIC DEFAULT 0;

-- ── Estado da reconciliacao ─────────────────────────────────────────────────
-- NULL = nunca reconciliado. Preenchido = snapshot financeiro oficial gravado.
-- Reconsulta futura: data_atualizacao_marketplace > financial_reconciled_at
-- indica que o pedido mudou depois da reconciliacao (devolucao/ajuste tardio).
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS financial_reconciled_at   TIMESTAMPTZ;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS financial_source          TEXT;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS financial_version         INTEGER;

-- ── Contrato semantico das colunas (documentado no proprio banco) ───────────
COMMENT ON COLUMN pedidos.tarifa_venda IS
  'ESTIMATIVA do CDS (tabela de faixas + taxa de campanha). NUNCA e dado oficial da Shopee. E o que o Dashboard exibe como "Comissoes" hoje. Mantida por compatibilidade.';
COMMENT ON COLUMN pedidos.commission_fee IS
  'OFICIAL da Shopee (get_escrow_detail.commission_fee), rateado por item. Vale 0 enquanto financial_reconciled_at for NULL. Nunca recebe estimativa.';
COMMENT ON COLUMN pedidos.escrow_amount IS
  'Repasse FINAL ao vendedor: escrow_amount_after_adjustment quando existir, senao escrow_amount. Zero e valor VALIDO (devolucao total); negativo tambem (debito pos-reembolso).';
COMMENT ON COLUMN pedidos.escrow_amount_bruto IS
  'Repasse ANTES do ajuste (escrow_amount cru da Shopee). A diferenca contra escrow_amount e explicada por total_adjustment_amount.';
COMMENT ON COLUMN pedidos.has_income_data IS
  'TRUE quando a Shopee devolveu um order_income valido. NAO depende de escrow_amount > 0 — cancelamento e devolucao total tem escrow 0 e sao dado financeiro REAL.';
COMMENT ON COLUMN pedidos.financial_reconciled_at IS
  'Quando o snapshot financeiro oficial foi gravado. NULL = na fila. Chave da reconciliacao incremental.';
COMMENT ON COLUMN pedidos.financial_source IS
  'Origem do dado financeiro. Hoje sempre "get_escrow_detail".';
COMMENT ON COLUMN pedidos.financial_version IS
  'Versao da REGRA de reconciliacao que gravou a linha. Permite reprocessar so o que foi gravado por uma regra antiga sem tocar no resto.';
