/**
 * GET /api/agentes/observabilidade — I4P10.
 *
 * O que o operador ve sobre o vigia da ingestao: incidentes abertos, os
 * ultimos resolvidos e o estado do proprio monitor.
 *
 * ── SOMENTE GET, e isso e contrato ──────────────────────────────────
 *
 * Nao ha POST, PATCH nem DELETE aqui, e nao e esquecimento. O incidente
 * e autoridade do MONITOR: quem abre, escala e resolve e o reducer, a
 * partir de evidencia. Um botao "resolver" nesta tela criaria um segundo
 * escritor da tabela e desfaria, com um clique, a serializacao que o
 * I4P9-R1 acabou de construir — o monitor reabriria o incidente no
 * minuto seguinte, porque a condicao continua valendo.
 *
 * ── Por que aqui, e nao em /api/internal ────────────────────────────
 *
 * `/api/internal` e o namespace do worker: autentica por segredo e nao
 * tem sessao. Esta rota e chamada pelo NAVEGADOR do dono, com cookie —
 * mesma fronteira de `/api/agentes/[agenteId]/diagnostico`.
 *
 * ── O `agenteId` e navegacao, nunca autoridade ──────────────────────
 *
 * O dono vem da sessao e de mais lugar nenhum. O `agenteId` da query
 * entra POR CIMA do filtro de dono: um id de outro tenant devolve lista
 * vazia, identica a de um agente que nao existe. As duas situacoes sao
 * indistinguiveis de proposito — a diferenca so ajudaria quem sonda.
 */
import { NextResponse } from "next/server";

import { autenticarRequisicao } from "@/lib/autenticacao";
import { VEREDICTO_DE_SAUDE } from "@/lib/agentes/observabilidade/alerta-apresentacao";
import {
  listarIncidentesAbertos,
  listarIncidentesResolvidos,
  listarMonitoresDoDono,
} from "@/lib/agentes/observabilidade/alerta-consulta";

/**
 * A resposta e privada e muda a cada avaliacao do vigia. `no-store` em
 * TODA resposta impede que um intermediario guarde a de um dono e a
 * sirva a outro.
 */
export const dynamic = "force-dynamic";

/** Mesma forma local das demais rotas do repo. */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
      // `motivo` morre aqui: para quem chama, 401 e 401.
      return responder({ ok: false, erro: "Não autenticado." }, 401);
    }

    const bruto = new URL(request.url).searchParams.get("agenteId");
    // Id com forma errada e simplesmente IGNORADO como filtro, em vez de
    // virar 400: o parametro e conveniencia de navegacao, e recusar a
    // tela inteira por causa dele nao ajudaria ninguem.
    const agenteId = typeof bruto === "string" && UUID_REGEX.test(bruto) ? bruto : null;

    const [abertos, resolvidos, monitores] = await Promise.all([
      listarIncidentesAbertos(auth.uid, { agenteId }),
      listarIncidentesResolvidos(auth.uid, { agenteId }),
      listarMonitoresDoDono(auth.uid, { agenteId }),
    ]);

    // Falha de leitura NUNCA vira lista vazia: "nada aberto" sobre uma
    // tabela que ninguem conseguiu ler e a pior resposta possivel numa
    // tela de operacao.
    if (abertos.estado !== "ok" || resolvidos.estado !== "ok" || monitores.estado !== "ok") {
      return responder({ ok: false, erro: "Não foi possível ler o monitoramento." }, 500);
    }

    return responder(
      {
        ok: true,
        // Esta superficie NAO conclui saude, e diz isso explicitamente
        // para quem consumir a API amanha. Ver `alerta-apresentacao`.
        veredictoDeSaude: VEREDICTO_DE_SAUDE,
        incidentes: abertos.incidentes,
        resolvidos: resolvidos.incidentes,
        monitores: monitores.monitores,
      },
      200
    );
  } catch {
    // Sem inspecionar nem logar o erro: detalhe daqui e material de
    // reconhecimento.
    return responder({ ok: false, erro: "Não foi possível ler o monitoramento." }, 500);
  }
}
