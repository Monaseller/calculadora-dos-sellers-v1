/**
 * POST /api/admin/shopee/status
 *
 * SYNC DE STATUS Shopee — dirigido pelo BANCO, sem `get_order_list`.
 *
 * Rota operacional, nao exposta em tela, gated pela sessao (`autenticarRequisicao`),
 * no mesmo molde de app/api/admin/shopee/reconciliar-financeiro.
 *
 * MOTIVO (medido em producao em 18/08/2026): a etapa 1.6 de lib/sync-shopee.ts
 * nunca e alcancada. A listagem de UM dia por `update_time` consumiu 54,3 s em
 * 30 paginas e ainda paginava quando a guarda de 55 s disparou. O gargalo nao e
 * a correcao de status — e a varredura da qual ela dependia. Esta rota inverte
 * a dependencia: seleciona no banco os pedidos NAO-TERMINAIS do ciclo e
 * pergunta o status deles direto por `get_order_detail` (50 por chamada, 10
 * chamadas concorrentes).
 *
 * O QUE ESCREVE: `status` e `status_shopee_raw`. Mais nada. Nao ha upsert, nao
 * ha objeto completo, nao ha montarLinhasDoPedido, nao ha rateio. A protecao do
 * snapshot financeiro v2 aqui nao e verificacao — e impossibilidade estrutural:
 * os campos nao existem na instrucao de UPDATE.
 *
 * Body (todos opcionais):
 *   dry_run  - `false` grava de fato. QUALQUER outro valor, ou ausencia, = dry-run.
 *              Default SEGURO: dry-run.
 *   campos   - "completo" (default, DETAIL_FIELDS ja provado) | "minimo"
 *              (`response_optional_fields: "order_status"`, payload menor, AINDA
 *              NAO PROVADO contra a API). SEM fallback automatico entre os dois:
 *              trocar de modo dentro de um catch mascararia timeout, 429 e erro
 *              de autenticacao.
 *   kA, kB   - buckets por execucao (default 8). Precisam DIVIDIR 1024.
 *   teto     - maximo de pedidos por execucao (default 4000). Excedido =>
 *              aborta ANTES da Shopee, sem truncar.
 *
 * NAO aceita `user_id`: o usuario vem exclusivamente da sessao.
 * NAO aceita `agoraMs`: a rotacao usa o relogio do servidor. Um parametro capaz
 * de deslocar arbitrariamente a janela de buckets seria uma porta para escolher
 * qual fatia da base processar; o tick deterministico e testado nas funcoes
 * puras da suite, que e onde ele precisa ser controlavel.
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { autenticarRequisicao } from "@/lib/autenticacao";
import { getShopeeLojaAtiva } from "@/lib/shopee-auth";
import { shopeeGet } from "@/lib/shopee-api";
import { mapStatus, withRetry } from "@/lib/sync-shopee";
import type { GrupoDeStatus } from "@/lib/shopee-financeiro";
import {
  BUCKETS,
  STATUS_NAO_TERMINAIS,
  TETO_POR_EXECUCAO_PADRAO,
  RPC_SELECAO,
  montarParametrosRpc,
  dataReferenciaBRT,
  tickDoCiclo,
  bucketsDoCiclo,
  executarSyncDeStatus,
  lotesDe,
  LOTE_UPDATE_STATUS,
  type ModoCampos,
} from "@/lib/shopee-status";

export const maxDuration = 60;

/**
 * Cliente com service_role: a RPC de selecao tem EXECUTE revogado de PUBLIC,
 * anon e authenticated. Fail-closed — chave ausente lanca, nunca degrada para
 * a chave anonima.
 */
function supabaseServidor() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL ausente.");
  if (!chave) throw new Error("SUPABASE_SERVICE_ROLE_KEY ausente — a RPC de selecao exige service_role.");
  return createClient(url, chave);
}

/** K valido = inteiro >= 1 que divide BUCKETS. Validado ANTES de qualquer I/O. */
function validarK(nome: string, valor: unknown, padrao: number): number {
  if (valor === undefined || valor === null || valor === "") return padrao;
  const k = Number(valor);
  if (!Number.isInteger(k) || k < 1 || k > BUCKETS || BUCKETS % k !== 0) {
    throw new Error(`${nome} invalido: ${valor}. Precisa ser inteiro que divide ${BUCKETS} (1,2,4,...,${BUCKETS}).`);
  }
  return k;
}

export async function POST(request: Request) {
  const auth = await autenticarRequisicao(request);
  if (!auth.autenticado) {
    return NextResponse.json({ ok: false, erro: "Sessao invalida." }, { status: 401 });
  }
  const userId = auth.uid;   // UNICA origem do usuario. Nunca do body.

  const body = await request.json().catch(() => ({} as Record<string, unknown>));
  let kA: number, kB: number, teto: number, campos: ModoCampos;
  try {
    kA = validarK("kA", (body as any).kA, 8);
    kB = validarK("kB", (body as any).kB, 8);
    const t = (body as any).teto;
    teto = t === undefined || t === null || t === "" ? TETO_POR_EXECUCAO_PADRAO : Number(t);
    if (!Number.isInteger(teto) || teto < 1) throw new Error(`teto invalido: ${t}`);
    const c = (body as any).campos;
    if (c !== undefined && c !== "completo" && c !== "minimo") throw new Error(`campos invalido: ${c}`);
    campos = (c ?? "completo") as ModoCampos;
  } catch (e: any) {
    return NextResponse.json({ ok: false, erro: String(e?.message ?? e) }, { status: 400 });
  }
  // Default SEGURO: so grava com dry_run === false explicito.
  const dryRun = (body as any).dry_run !== false;

  const loja = await getShopeeLojaAtiva(userId);
  if (!loja) return NextResponse.json({ ok: false, erro: "Shopee nao conectada." }, { status: 400 });

  const supabase = supabaseServidor();
  const agoraMs = Date.now();               // relogio do SERVIDOR, nunca do cliente
  const dataReferencia = dataReferenciaBRT(agoraMs);
  let retries = 0;

  const resultado = await executarSyncDeStatus(
    { userId, dryRun, campos, kA, kB, teto, agoraMs },
    {
      async selecionar({ bucketsA, bucketsB }) {
        const params = montarParametrosRpc({ userId, dataReferencia, bucketsA, bucketsB });
        const { data, error } = await supabase.rpc(RPC_SELECAO, params);
        // Erro na selecao NUNCA vira "nada a fazer": isso esconderia a fila.
        if (error) throw new Error(`RPC ${RPC_SELECAO} falhou: ${error.message}`);
        const faixaA: string[] = [], faixaB: string[] = [];
        for (const r of (data ?? []) as Array<{ order_id: string; faixa: string }>) {
          (r.faixa === "A" ? faixaA : faixaB).push(r.order_id);
        }
        return { faixaA, faixaB };
      },

      async consultarLote(orderSns, camposReq) {
        return withRetry(
          () => shopeeGet("/api/v2/order/get_order_detail", loja.partnerId, loja.partnerKey,
                          loja.accessToken, loja.shopId,
                          { order_sn_list: orderSns.join(","), response_optional_fields: camposReq }),
          3, 1000,
          () => { retries++; },
        );
      },

      async statusNoBanco(orderSns) {
        const mapa = new Map<string, string | null>();
        for (const lote of lotesDe(orderSns, LOTE_UPDATE_STATUS)) {
          const { data, error } = await supabase
            .from("pedidos")
            .select("order_id, status_shopee_raw")
            .eq("user_id", userId)            // isolamento entre usuarios
            .eq("marketplace", "Shopee")      // isolamento entre marketplaces
            .in("order_id", lote);
          // Erro aqui NUNCA vira "nao existe": reescreveria status a esmo.
          if (error) throw new Error(`consulta de status existentes falhou: ${error.message}`);
          for (const r of data ?? []) mapa.set((r as any).order_id, (r as any).status_shopee_raw ?? null);
        }
        return mapa;
      },

      async aplicarGrupo(g: GrupoDeStatus) {
        const { error } = await supabase
          .from("pedidos")
          // SOMENTE status. Nenhum campo financeiro, nenhuma data, nenhum valor
          // comercial entra nesta instrucao — a protecao e estrutural.
          .update({ status: g.statusComercial, status_shopee_raw: g.statusRaw })
          .eq("user_id", userId)
          .eq("marketplace", "Shopee")
          .in("order_id", g.orderSns);
        if (error) console.error(`[shopee-status] chunk falhou (${g.statusRaw}, ${g.orderSns.length} pedidos):`, error.message);
        return { erro: error ? error.message : null };
      },

      mapear: mapStatus,          // o mapa de producao, nunca uma copia
      agora: () => Date.now(),
      retriesAcumulados: () => retries,
    },
  ).catch((e: any) => ({ erroFatal: String(e?.message ?? e) }) as any);

  if ((resultado as any).erroFatal) {
    return NextResponse.json({ ok: false, erro: (resultado as any).erroFatal }, { status: 500 });
  }

  // Contagens sempre; order_id e payload da Shopee, nunca.
  console.log("[shopee-status] execucao", {
    ...resultado, dataReferencia,
    tick: tickDoCiclo(agoraMs),
    bucketsA: bucketsDoCiclo(tickDoCiclo(agoraMs), kA).length,
    bucketsB: bucketsDoCiclo(tickDoCiclo(agoraMs), kB).length,
    naoTerminais: STATUS_NAO_TERMINAIS.length,
  });

  return NextResponse.json({ ...resultado, dataReferencia });
}
