/**
 * GET /api/internal/agentes/monitor-ingestao — M2-I1-A8B-I4P9 (OBS-5).
 *
 * O vigia da ingestao de perguntas. Alvo do Vercel Cron.
 *
 * ── A REQUISICAO NAO CARREGA AUTORIDADE NENHUMA ─────────────────────
 *
 * Sem body, sem query, sem `agenteId`, sem `userId`. O alvo vem do
 * ambiente e o dono vem do BANCO. Aceitar qualquer um dos dois de quem
 * chama transformaria o cron num seletor de tenant para quem tivesse o
 * segredo — e o segredo do cron autoriza ACIONAR o vigia, nunca escolher
 * sobre quem ele age.
 *
 * ── AUTENTICACAO: `CRON_SECRET`, o mecanismo QUE JA EXISTE ──────────
 *
 * Mesma guarda de `/api/sync`, do worker do Estudio, do worker de
 * agentes e do poller: `Authorization: Bearer <CRON_SECRET>`, fail
 * closed, resposta generica. Criar um segredo proprio daria mais uma
 * coisa para rotacionar sem separar poder nenhum — quem aciona o cron ja
 * aciona os outros quatro. E o segredo do n8n NAO e reaproveitado: ele
 * pertence a quem PRODUZ a ingestao, e este endpoint so a observa.
 *
 * ── ESTA ROTA NAO E O CICLO DE VIDA ─────────────────────────────────
 *
 * Ela autentica, chama o orquestrador com as portas de producao e traduz
 * o resultado em HTTP. Nenhuma regra de alerta mora aqui.
 */
import { NextResponse } from "next/server";

import { executarMonitorDaIngestao } from "@/lib/agentes/observabilidade/monitor-ingestao";
import { portasDeProducao } from "@/lib/agentes/observabilidade/monitor-portas";

/**
 * Cinco consultas curtas e algumas escritas pontuais. O padrao de
 * `app/api/**` no `vercel.json` ja e 60 s; declarar aqui deixa explicito
 * que este nao e um trabalho longo como o dos workers.
 */
export const maxDuration = 60;

const EVENTO = "MONITOR_INGESTAO_FALHA";

function responder(corpo: unknown, status: number): NextResponse {
  return NextResponse.json(corpo, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/** Log estruturado: codigo e estagio, nada mais. Sem tenant, sem dado. */
function registrar(codigo: string, estagio: string): void {
  console.error(JSON.stringify({ evento: EVENTO, codigo, estagio, quando: new Date().toISOString() }));
}

export async function GET(request: Request) {
  // ── Auth fail-closed ──────────────────────────────────────────────
  //
  // Resposta generica, sem revelar se o que faltou foi a configuracao do
  // servidor ou o header de quem chamou. Somente `Authorization: Bearer`
  // — nao aceita segredo por query, por body nem por `x-worker-secret`.
  const segredo = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");
  if (!segredo || !auth || auth !== `Bearer ${segredo}`) {
    return responder({ ok: false, erro: "nao_autorizado" }, 401);
  }

  try {
    const r = await executarMonitorDaIngestao(portasDeProducao());

    if (r.estado === "avaliado") {
      // Contadores, e so contadores. Nenhum `agente_id`, nenhum
      // `user_id`, nenhum deslocamento, nenhuma linha de ledger — o
      // corpo desta resposta vai para log de plataforma.
      return responder({ ok: true, estado: "avaliado", metricas: r.metricas }, 200);
    }

    if (r.estado === "ignorado_por_sobreposicao") {
      // Outra execucao ja estava avaliando este escopo. Nao e falha do
      // agendador, nao e cegueira do vigia e nao gera alerta nenhum: o
      // proximo minuto reavalia a janela inteira. Sem log, porque isso
      // pode ser rotina e um registro por minuto viraria ruido.
      return responder({ ok: true, estado: "ignorado_por_sobreposicao" }, 200);
    }

    if (r.estado === "avaliacao_parcial") {
      // NUNCA 200. Uma rodada que gravou parte das observacoes e parou
      // no meio pareceria saudavel no painel do cron, e o silencio
      // seria lido como "nada a relatar".
      registrar("avaliacao_parcial", r.estagio);
      return responder(
        { ok: false, estado: "avaliacao_parcial", erro: "avaliacao_parcial", metricas: r.metricas },
        500
      );
    }

    if (r.estado === "alvo_nao_configurado") {
      // Falha de implantacao do proprio vigia, nao achado sobre o
      // sistema observado: sem alvo nao existe nem o sujeito do alerta.
      registrar("monitor_target_unconfigured", "alvo");
      return responder({ ok: false, erro: "monitor_target_unconfigured" }, 500);
    }

    if (r.estado === "alvo_invalido") {
      registrar("monitor_target_invalido", "alvo");
      return responder({ ok: false, erro: "monitor_target_invalido" }, 500);
    }

    // Banco indisponivel. O vigia NAO tenta gravar "o banco esta fora"
    // no mesmo banco que acabou de recusar: isso e monitoramento de
    // plataforma, e ele observa de fora.
    registrar("falha_de_plataforma", r.estagio);
    return responder({ ok: false, erro: "falha_de_plataforma" }, 500);
  } catch {
    // Sem inspecionar nem logar o erro: qualquer detalhe daqui e
    // material de reconhecimento.
    registrar("excecao", "execucao");
    return responder({ ok: false, erro: "falha_monitor" }, 500);
  }
}
