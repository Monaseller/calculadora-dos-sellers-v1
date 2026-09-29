/**
 * A PORTA das rotas de agente — AGENT-FACTORY-F7a.
 *
 * ── Uma copia, e nao oito ───────────────────────────────────────────
 *
 * O padrao ja existia, mas como funcao LOCAL dentro de
 * `app/api/agentes/[agenteId]/permissoes/route.ts`. Com sete rotas
 * novas precisando dele, copiar seria criar sete lugares onde alguem
 * pode esquecer o `lerAgenteDoDono` — e a falha teria a cara de uma
 * rota que funciona.
 *
 * A rota de permissoes NAO foi alterada para importar daqui: ela esta
 * provada e este gate nao e sobre ela. Convergir as duas e limpeza
 * propria, registrada e nao feita de passagem.
 *
 * ── O que esta porta garante ────────────────────────────────────────
 *
 *   1. ha sessao valida;
 *   2. o `user_id` vem da SESSAO, nunca do corpo ou da query;
 *   3. o `agenteId` tem forma de uuid;
 *   4. o agente E DAQUELE DONO.
 *
 * "Nao existe" e "nao e seu" devolvem a MESMA coisa, de proposito:
 * distinguir transformaria a rota num oraculo para descobrir ids
 * alheios.
 */
import "server-only";
import { NextResponse } from "next/server";

import { autenticarRequisicao } from "@/lib/autenticacao";
import { lerAgenteDoDono } from "@/lib/agentes/capability";

export const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function responder(corpo: unknown, status: number): NextResponse {
  return NextResponse.json(corpo, {
    status,
    // Resposta de agente nunca e cacheavel: ela depende de quem pediu.
    headers: { "Cache-Control": "no-store" },
  });
}

export type Porta =
  | { readonly ok: true; readonly userId: string; readonly agenteId: string }
  | { readonly ok: false; readonly resposta: NextResponse };

export async function atravessarPorta(
  request: Request,
  agenteIdBruto: string,
  falhaInterna = "Nao foi possivel completar a operacao."
): Promise<Porta> {
  const auth = await autenticarRequisicao(request);
  if (!auth.autenticado) {
    return { ok: false, resposta: responder({ ok: false, erro: "Não autenticado." }, 401) };
  }
  if (typeof agenteIdBruto !== "string" || !UUID_REGEX.test(agenteIdBruto)) {
    return { ok: false, resposta: responder({ ok: false, erro: "agenteId inválido." }, 400) };
  }

  const { linha, erro } = await lerAgenteDoDono(agenteIdBruto, auth.uid);
  if (erro !== null) {
    return { ok: false, resposta: responder({ ok: false, erro: falhaInterna }, 500) };
  }
  if (linha === null) {
    return { ok: false, resposta: responder({ ok: false, erro: "Agente não encontrado." }, 404) };
  }
  return { ok: true, userId: auth.uid, agenteId: agenteIdBruto };
}

/** Le o corpo JSON sem deixar um payload malformado virar 500. */
export async function lerCorpo(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const bruto: unknown = await request.json();
    if (typeof bruto !== "object" || bruto === null || Array.isArray(bruto)) return null;
    return bruto as Record<string, unknown>;
  } catch {
    return null;
  }
}
