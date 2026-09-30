/**
 * As contas externas do DONO — AGENT-FACTORY-F7b.4.2 §14/§15.
 *
 * GET   as contas ja conectadas (opcionalmente de um aplicativo so)
 * POST  gera o link para o dono autorizar uma conta nova
 *
 * ── Rota por DONO, e nao por agente ─────────────────────────────────
 *
 * Igual a `/api/ferramentas/buscar`: exige sessao e nao exige `agenteId`.
 *
 * Uma conta do Google e do Rodrigo, nao de um agente dele. E o modelo que
 * a CDS ja usa em Mercado Livre e Shopee: a CDS e dona da credencial, e o
 * agente recebe capability e binding. Uma conexao por agente o obrigaria a
 * autorizar o mesmo Google N vezes, e cada autorizacao extra e uma chance
 * extra de conceder escopo demais.
 *
 * ── Conectar NAO concede nada ao agente ─────────────────────────────
 *
 * Esta rota nao toca `agente_permissoes` nem `agente_ferramentas_externas`.
 * Ter a conta conectada nao faz nenhum agente poder usar nenhuma acao — o
 * que permite continua sendo o par vinculo + permissao, conferido pelo
 * guard. Mesma regra do §10: selecionar nao concede.
 *
 * ── O que NAO atravessa esta rota — §14 ─────────────────────────────
 *
 * `COMPOSIO_API_KEY`, `link_token`, access token, refresh token e qualquer
 * segredo de credencial. Quem fala com o Composio e
 * `lib/agentes/composio/conexao.ts`, que e `server-only` e ja recorta a
 * resposta antes de devolver — provado em
 * `scripts/testar-composio-conexao-live.ts` (C6–C11).
 *
 * O `userId` vem SEMPRE da sessao. A identidade no provedor e derivada por
 * hash dentro do modulo, e nunca chega nem sai por aqui.
 */
import { NextResponse } from "next/server";

import { autenticarRequisicao } from "@/lib/autenticacao";
import {
  gerarLinkDeConexao, listarContasDoDono,
} from "@/lib/agentes/composio/conexao";

export const dynamic = "force-dynamic";

/** Teto do slug. Aplicativo e um identificador curto, nao texto livre. */
const MAX_TOOLKIT = 60;

function responder(corpo: unknown, status: number): NextResponse {
  return NextResponse.json(corpo, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/** Uma frase por estado. `nao_configurado` nao e falha — e ausencia. */
function respostaDeErro(estado: "nao_configurado" | "falha"): NextResponse {
  return estado === "nao_configurado"
    ? responder({ ok: false, erro: "Conexão com aplicativos não está configurada." }, 503)
    : responder({ ok: false, erro: "Não foi possível falar com o serviço de conexões." }, 502);
}

export async function GET(request: Request) {
  try {
    const auth = await autenticarRequisicao(request);
    if (!auth.autenticado) return responder({ ok: false, erro: "Não autenticado." }, 401);

    const bruto = new URL(request.url).searchParams.get("toolkit") ?? "";
    const toolkit = bruto.slice(0, MAX_TOOLKIT).trim();

    const r = await listarContasDoDono({
      userId: auth.uid,
      toolkit: toolkit === "" ? undefined : toolkit,
    });
    if (r.estado !== "ok") return respostaDeErro(r.estado);

    return responder({
      ok: true,
      // `doDono` nao e publicado: aqui ele e sempre `true` por construcao, e
      // um campo que nunca varia so convida alguem a confiar nele um dia.
      contas: r.dados.map((c) => ({
        contaId: c.contaId, toolkit: c.toolkit, estado: c.estado,
      })),
    }, 200);
  } catch {
    return responder({ ok: false, erro: "Nao foi possivel carregar as conexoes." }, 500);
  }
}

export async function POST(request: Request) {
  try {
    const auth = await autenticarRequisicao(request);
    if (!auth.autenticado) return responder({ ok: false, erro: "Não autenticado." }, 401);

    let corpo: unknown;
    try { corpo = await request.json(); } catch { corpo = null; }
    const toolkit = typeof corpo === "object" && corpo !== null
      ? String((corpo as Record<string, unknown>).toolkit ?? "").slice(0, MAX_TOOLKIT).trim()
      : "";
    if (toolkit === "") {
      return responder({ ok: false, erro: "Informe o aplicativo." }, 400);
    }

    const r = await gerarLinkDeConexao({ userId: auth.uid, toolkit });
    if (r.estado !== "ok") return respostaDeErro(r.estado);

    // TRES campos, e o modulo ja garantiu que sao esses. Montar o objeto a
    // mao em vez de espalhar `...r.dados` e o que impede um campo novo do
    // provedor de chegar a tela sem ninguem ter decidido.
    return responder({
      ok: true,
      urlParaConectar: r.dados.urlParaConectar,
      expiraEm: r.dados.expiraEm,
      contaId: r.dados.contaId,
    }, 201);
  } catch {
    return responder({ ok: false, erro: "Nao foi possivel iniciar a conexao." }, 500);
  }
}
