/**
 * GET /api/debug/comparar-listagem-shopee
 *
 * ROTA TEMPORÁRIA DE DEBUG (criada 2026-07-30) — existe só para validar a
 * Opção B da Fase 4 (listagem paralela por dia, ver docs/DECISIONS.md):
 * compara o conjunto de order_sn que o algoritmo ANTIGO (1 cursor
 * sequencial pro intervalo inteiro) produz contra o algoritmo NOVO (2
 * janelas paralelas, uma por dia, dedup via Set) para a MESMA janela de 2
 * dias. Nunca escreve em `pedidos` nem em nenhuma outra tabela — só lista
 * via get_order_list e compara os dois conjuntos.
 *
 * Remover esta rota depois que a Opção B estiver validada e aprovada (ou
 * descartada) — não faz parte do fluxo de produção.
 *
 * Uso:
 *   http://localhost:3000/api/debug/comparar-listagem-shopee?date_from=2026-07-29&date_to=2026-07-30
 *
 * date_from/date_to devem formar um intervalo de exatamente 2 dias (o
 * mesmo caso que o caminho novo em syncShopeeForUserV2 usa) — não valida
 * isso à força, mas a comparação só é significativa nesse caso.
 */
import { NextResponse } from "next/server";
import { getUserId } from "@/lib/session";
import { getShopeeLojaAtiva } from "@/lib/shopee-auth";
import {
  listarOrderSnsDaJanela,
  listarOrderSnsSequencialParaTeste,
  type ContextoListagemShopee,
} from "@/lib/sync-shopee";

export const maxDuration = 60;

export async function GET(request: Request) {
  const userId = getUserId(request);
  if (!userId) return NextResponse.json({ erro: "Sessao invalida" }, { status: 401 });

  const url = new URL(request.url);
  const dateFrom = url.searchParams.get("date_from");
  const dateTo   = url.searchParams.get("date_to");
  if (!dateFrom || !dateTo) {
    return NextResponse.json({ erro: "date_from e date_to sao obrigatorios (YYYY-MM-DD)" }, { status: 400 });
  }

  const loja = await getShopeeLojaAtiva(userId);
  if (!loja) return NextResponse.json({ erro: "Shopee nao conectada" }, { status: 400 });

  // Mesmos parâmetros que o fluxo real de forceSync usa (noBuffer=true):
  // create_time, sem filtrar COMPLETED — pra comparação ser fiel ao caso real.
  const ctx: ContextoListagemShopee = {
    partnerId:        loja.partnerId,
    partnerKey:       loja.partnerKey,
    accessToken:      loja.accessToken,
    shopId:           loja.shopId,
    timeRangeField:   "create_time",
    filtrarCompleted: false,
  };

  // ── Algoritmo ANTIGO (sequencial, 1 cursor pro intervalo inteiro) ──────────
  const antigo = await listarOrderSnsSequencialParaTeste(ctx, dateFrom, dateTo);

  // ── Algoritmo NOVO (2 janelas paralelas, uma por dia) ──────────────────────
  const _novoInicioMs = Date.now();
  const [resOntem, resHoje] = await Promise.all([
    listarOrderSnsDaJanela(ctx, dateFrom, dateFrom),
    listarOrderSnsDaJanela(ctx, dateTo,   dateTo),
  ]);
  const tempoNovoMs = Date.now() - _novoInicioMs;

  if (antigo.erro || resOntem.erro || resHoje.erro) {
    return NextResponse.json({
      erro: "Uma das listagens falhou — comparacao nao e confiavel.",
      erro_antigo: antigo.erro,
      erro_novo_ontem: resOntem.erro,
      erro_novo_hoje: resHoje.erro,
    }, { status: 502 });
  }

  const novoUnido = [...resOntem.orderSns, ...resHoje.orderSns];
  const novoSet   = new Set(novoUnido);
  const duplicadosRemovidos = novoUnido.length - novoSet.size;

  const antigoSet = new Set(antigo.orderSns);

  const somenteAntiga = [...antigoSet].filter(sn => !novoSet.has(sn)).length;
  const somenteNova   = [...novoSet].filter(sn => !antigoSet.has(sn)).length;
  const intersecao    = [...antigoSet].filter(sn => novoSet.has(sn)).length;

  return NextResponse.json({
    somente_antiga: somenteAntiga,
    somente_nova:   somenteNova,
    intersecao,
    duplicados_removidos: duplicadosRemovidos,
    tempo_antigo: antigo.tempoMs,
    tempo_novo:   tempoNovoMs,
  });
}
