/**
 * GET /api/ferramentas/buscar?termo=... — AGENT-FACTORY-F7b.4.1.
 *
 * A busca unificada que a etapa Ferramentas usa.
 *
 * ── Exige sessao, e nao exige agente ────────────────────────────────
 *
 * Buscar no catalogo nao e sobre um agente especifico: e sobre o que a
 * CDS oferece. Por isso a rota pede sessao (o catalogo externo consome a
 * credencial da CDS, e isso nao se abre para anonimo) mas nao pede
 * `agenteId`.
 *
 * ── A credencial do Composio nao passa por aqui ─────────────────────
 *
 * Quem fala com o Composio e `lib/agentes/composio/cliente.ts`, que e
 * `server-only`. Esta rota chama a busca e devolve o resultado ja
 * traduzido; nenhum cabecalho externo e nenhuma credencial aparecem na
 * resposta.
 */
import { NextResponse } from "next/server";

import { autenticarRequisicao } from "@/lib/autenticacao";
import { buscarFerramentas } from "@/lib/agentes/factory/busca-de-ferramentas";

export const dynamic = "force-dynamic";

/** Teto do termo. Busca nao e campo de texto livre para o servidor. */
const MAX_TERMO = 80;

function responder(corpo: unknown, status: number): NextResponse {
  return NextResponse.json(corpo, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function GET(request: Request) {
  try {
    const auth = await autenticarRequisicao(request);
    if (!auth.autenticado) {
      return responder({ ok: false, erro: "Não autenticado." }, 401);
    }

    const bruto = new URL(request.url).searchParams.get("termo") ?? "";
    const termo = bruto.slice(0, MAX_TERMO);

    const r = await buscarFerramentas(termo);
    return responder({
      ok: true,
      termo,
      achados: r.achados,
      externoDisponivel: r.externoDisponivel,
      externoDesfecho: r.externoDesfecho,
      externoTotal: r.externoTotal,
    }, 200);
  } catch {
    return responder({ ok: false, erro: "Nao foi possivel buscar ferramentas." }, 500);
  }
}
