/**
 * GET /api/ia/vendas-ao-vivo — as vendas de HOJE para o painel do
 * Escritorio. F8.2-A.
 *
 * ── Leitura fina sobre a camada que ja existe ───────────────────────
 *
 * Para cada loja Mercado Livre ATIVA do dono, chama
 * `criarLeiturasDeVendasML(...)` duas vezes — "hoje" cortado em AGORA e
 * "ontem" cortado no MESMO horario (F8.2-B) — exatamente a
 * camada deterministica da Tool `mercadolivre.vendas.consultar`. A rota
 * nao soma, nao divide, nao reinterpreta periodo: `lojaAoVivoDoResultado`
 * so copia o resultado (ou diz que nao ha numero).
 *
 * Nao passa por agente, conversa, laco de ferramentas nem provedor de
 * IA: nenhuma chamada de LLM, nenhuma mensagem criada. E por isso que
 * ela nao depende de qual agente esta selecionado.
 *
 * Shopee: nao configurada nesta etapa, e NAO e simulada. O marketplace
 * so entra na resposta quando houver leitura real dele.
 */
import { NextResponse } from "next/server";
import { autenticarRequisicao } from "@/lib/autenticacao";
import { listarLojasAtivasDoDono } from "@/lib/marketplace/credenciais";
import { criarLeiturasDeVendasML } from "@/lib/agentes/dados/vendas-ml";
import {
  PERIODO_AO_VIVO, PERIODO_COMPARADO, corteDeOntemMs, lojaAoVivoDoResultado, nomeDaLoja,
  type LojaAoVivo, type MarketplaceDoPainel,
} from "@/lib/agentes/dados/vendas-ao-vivo";

export const dynamic = "force-dynamic";

/** Mesmo literal que `credenciais.ts` usa para a loja do Mercado Livre. */
const MARKETPLACE_ML = "ML";

function responder(corpo: unknown, status: number) {
  return NextResponse.json(corpo, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: Request) {
  const auth = await autenticarRequisicao(request);
  if (!auth.autenticado) return responder({ ok: false, erro: "Não autenticado." }, 401);

  try {
    const lojas = await listarLojasAtivasDoDono(auth.uid);
    if (lojas.erro !== null) {
      return responder({ ok: false, erro: "Não foi possível ler as lojas." }, 503);
    }
    const doML = lojas.linhas.filter((l) => l.marketplace === MARKETPLACE_ML);

    const agora = Date.now();
    const blocos: LojaAoVivo[] = await Promise.all(doML.map(async (loja) => {
      const nome = nomeDaLoja(loja);
      try {
        // F8.2-B: duas leituras da MESMA camada, cada uma cortada no seu
        // instante — hoje ate AGORA, ontem ate o MESMO horario. Em
        // paralelo, e as duas com o mesmo `agora`.
        const lerHoje = criarLeiturasDeVendasML(
          auth.uid, loja.id, agora, undefined, undefined, { ateInstanteMs: agora });
        const lerOntem = criarLeiturasDeVendasML(
          auth.uid, loja.id, agora, undefined, undefined, { ateInstanteMs: corteDeOntemMs(agora) });
        const [hoje, ontem] = await Promise.all([
          lerHoje({ periodo: PERIODO_AO_VIVO }),
          // Ontem que falhar NAO derruba hoje: so some o comparativo.
          lerOntem({ periodo: PERIODO_COMPARADO }).catch(() => null),
        ]);
        return lojaAoVivoDoResultado(nome, hoje, ontem);
      } catch {
        // O detalhe fica no servidor; a tela so precisa saber que esta
        // loja nao respondeu agora — e os dados bons anteriores ficam.
        console.error("[vendas-ao-vivo] falha ao ler a loja ML");
        return { nome, estado: "erro" as const };
      }
    }));

    const marketplaces: MarketplaceDoPainel[] = [
      { marketplace: "mercadolivre", configurado: doML.length > 0, lojas: blocos },
    ];
    return responder({
      ok: true,
      geradoEm: new Date(agora).toISOString(),
      // Os dois cortes, para a tela poder dizer "ate HH:MM" sem calcular.
      corteHoje: new Date(agora).toISOString(),
      corteOntem: new Date(corteDeOntemMs(agora)).toISOString(),
      marketplaces,
    }, 200);
  } catch {
    return responder({ ok: false, erro: "Não foi possível ler as vendas agora." }, 500);
  }
}
