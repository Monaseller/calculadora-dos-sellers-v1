/**
 * POST /api/internal/sync/executar
 *
 * Rota INTERNA — não é chamada pelo browser/sessão do usuário. Só o
 * worker local (scripts/sync-worker.mjs) deve chamar isto, autenticado
 * por um segredo estático (header x-worker-secret), nunca pelo cookie
 * cds_session. Ver docs/DECISIONS.md (redesenho do botão Sincronizar,
 * 2026-07-11).
 *
 * Responsabilidade única: dado um job já resolvido (loja_id, marketplace,
 * período, tipo), executar o sync de verdade chamando
 * syncShopeeForUserV2/syncMLForUserV2 diretamente (em processo — o
 * Next.js já compila estes .ts, nenhum loader adicional é necessário).
 *
 * Esta rota NÃO conhece a tabela sync_jobs — não lê nem escreve status,
 * tentativas, heartbeat, etc. Isso é responsabilidade exclusiva do
 * worker, que chama esta rota e trata o resultado. Mantém as duas
 * responsabilidades (execução do sync vs. controle do job) isoladas.
 */
import { NextResponse } from "next/server";
import { syncShopeeForUserV2 } from "@/lib/sync-shopee";
import { syncMLForUserV2 } from "@/lib/sync-ml";
import { getShopeeLojaById } from "@/lib/shopee-auth";
import { getMLLojaById } from "@/lib/ml-auth";
import { LojaIdIntegrityError } from "@/lib/sync-errors";

export async function POST(request: Request) {
  const segredoEsperado = process.env.SYNC_WORKER_INTERNAL_SECRET;
  const segredoRecebido = request.headers.get("x-worker-secret");

  // Sem segredo configurado no ambiente = rota fica bloqueada por padrão,
  // nunca "aberta" por omissão de configuração.
  if (!segredoEsperado || !segredoRecebido || segredoRecebido !== segredoEsperado) {
    return NextResponse.json({ ok: false, erro: "Não autorizado." }, { status: 401 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, erro: "Body inválido." }, { status: 400 });
  }

  const { user_id, loja_id, marketplace, date_from, date_to, tipo } = body ?? {};

  if (!user_id || !loja_id || !marketplace || !date_from || !date_to) {
    return NextResponse.json({ ok: false, erro: "Parâmetros obrigatórios ausentes." }, { status: 400 });
  }
  if (marketplace !== "ML" && marketplace !== "Shopee") {
    return NextResponse.json({ ok: false, erro: "marketplace inválido." }, { status: 400 });
  }

  // noBuffer=true (comportamento de "Histórico"/backfill: busca exatamente
  // o range, sem estender/filtrar por update_time) só quando o job é
  // explicitamente do tipo backfill. Job incremental (o único tipo que a
  // tela Vendas cria hoje) usa o comportamento padrão de refresh diário.
  const noBuffer = tipo === "backfill";

  try {
    // PR #1 — o par (user_id, loja_id) vai INTEIRO para a busca de
    // credencial. `x-worker-secret` autentica o worker, não prova
    // propriedade da loja: se o job trouxer um par incoerente (cenário
    // possível enquanto `sync_jobs` não tem RLS), a credencial não é
    // resolvida e o sync falha fechado, sem tocar loja alheia.
    if (marketplace === "Shopee") {
      const loja = await getShopeeLojaById(loja_id, user_id);
      if (!loja) {
        return NextResponse.json({ ok: false, erro: "Loja Shopee não encontrada ou sem token válido." }, { status: 400 });
      }
      const resultado = await syncShopeeForUserV2(user_id, date_from, date_to, noBuffer, loja);
      return NextResponse.json({ ok: true, pedidosProcessados: resultado.inserted, encontrados: resultado.found });
    } else {
      const loja = await getMLLojaById(loja_id, user_id);
      if (!loja) {
        return NextResponse.json({ ok: false, erro: "Loja ML não encontrada ou sem token válido." }, { status: 400 });
      }
      const resultado = await syncMLForUserV2(user_id, date_from, date_to, undefined, noBuffer, loja);
      return NextResponse.json({ ok: true, pedidosProcessados: resultado.inserted, encontrados: resultado.found });
    }
  } catch (err: any) {
    // Mensagem resumida — nunca token/payload bruto da API do marketplace.
    const mensagem = (err?.message ?? "Erro desconhecido no sync").toString().slice(0, 300);
    // permanente=true (LojaIdIntegrityError): credencial/loja não resolvida
    // — retry não resolveria nada, o worker deve marcar 'erro' direto, sem
    // gastar tentativas (política aprovada 2026-07-11, ponto 6). Qualquer
    // outro erro (rede, timeout, 5xx do marketplace) é transitório —
    // permanente=false, o worker decide reenfileirar via tentativas.
    const permanente = err instanceof LojaIdIntegrityError;
    console.error("[internal/sync/executar] falhou:", mensagem, "permanente:", permanente);
    return NextResponse.json({ ok: false, erro: mensagem, permanente }, { status: 500 });
  }
}
