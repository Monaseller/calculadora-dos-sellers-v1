/**
 * GET /api/internal/estudio-anuncios/worker
 *
 * O QUE ESTA ROTA CONSERTA (2026-09-04). Até aqui a fila do Pipeline só
 * tinha um consumidor: `scripts/estudio-anuncios-worker.mjs`, rodando na
 * máquina de quem desenvolve. Em produção não havia processo nenhum
 * consumindo — então "Iniciar pipeline" pela interface enfileirava um
 * job que ficava `pendente`, com zero tentativas, **para sempre**. Sem
 * erro, sem log, sem sintoma: o usuário clicava e nada acontecia.
 *
 * Esta rota é o consumidor que faltava em produção. É acionada pelo
 * Vercel Cron (ver `vercel.json`).
 *
 * ── Decisões que valem explicação ───────────────────────────────────
 *
 * **Autenticação: `CRON_SECRET`, não um segredo novo.** É o mecanismo
 * OFICIAL do Vercel Cron — o agendador manda `Authorization: Bearer
 * <CRON_SECRET>` sozinho. Criar mais um segredo daria mais uma coisa
 * para configurar, esquecer e vazar. Fail closed, igual a `/api/sync`:
 * sem a variável, ninguém entra — nem o cron.
 *
 * **Chama a lógica direto, não a rota interna por HTTP.** Uma função
 * serverless chamando a si mesma dependeria de descobrir a própria URL,
 * gastaria uma invocação a mais e exigiria um segundo segredo
 * (`ESTUDIO_ANUNCIOS_WORKER_INTERNAL_SECRET`) configurado em produção.
 * `processarJobDoPipeline()` é a MESMA função que a rota interna usa —
 * não há duas implementações.
 *
 * **Processa em laço, dentro de um orçamento de tempo.** Uma etapa por
 * invocação faria o pipeline de 7 etapas levar 7 ciclos de cron. O laço
 * encadeia enquanto houver folga na janela de execução e para assim que
 * o tempo restante deixa de ser suficiente para outra etapa — sem
 * arriscar ser cortado no meio de uma chamada de IA.
 *
 * **Um job por vez, sempre.** O claim é atômico no banco (`FOR UPDATE
 * SKIP LOCKED`), então duas invocações simultâneas nunca pegam o mesmo
 * job. E não há retry aqui: reprocessar é decisão do banco, via um novo
 * claim numa execução posterior.
 *
 * NÃO PUBLICA NADA. Só processa a fila da Fase 1.
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  processarJobDoPipeline,
  reivindicarProximoJob,
} from "@/lib/estudio-anuncios/processar-job";

const supabaseServico = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * Janela de execução desta função, em `vercel.json`. O orçamento abaixo
 * é deliberadamente menor: precisa sobrar tempo para fechar a resposta.
 */
export const maxDuration = 300;

/**
 * Só começa outra etapa se ainda houver esta folga. Uma etapa de IA
 * demora dezenas de segundos — começar uma com pouco tempo restante
 * significaria ser cortado no meio, deixando o job `rodando` sem
 * ninguém para concluí-lo até o timeout do banco.
 */
const FOLGA_MINIMA_MS = 90_000;
const ORCAMENTO_MS = 240_000;

export async function GET(request: Request) {
  const segredo = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");

  // Mesma guarda de `/api/sync`: resposta genérica, sem revelar se o que
  // faltou foi a configuração do servidor ou o header de quem chamou.
  if (!segredo || !auth || auth !== `Bearer ${segredo}`) {
    return NextResponse.json({ erro: true }, { status: 401 });
  }

  const inicio = Date.now();
  const processados: { jobId: string; etapa: string; ok: boolean }[] = [];

  try {
    while (Date.now() - inicio < ORCAMENTO_MS - FOLGA_MINIMA_MS) {
      const job = await reivindicarProximoJob(supabaseServico);
      if (!job) break; // Fila vazia — trabalho normal, não erro.

      const { corpo } = await processarJobDoPipeline(supabaseServico, job.id);
      processados.push({ jobId: job.id, etapa: job.etapa, ok: corpo.ok === true });

      // Job que falhou encerra a rodada: insistir na sequência gastaria
      // orçamento com um pipeline que já parou. O retry vem do próximo
      // ciclo, pelo caminho normal de claim.
      if (corpo.ok !== true) break;
    }

    return NextResponse.json({
      ok: true,
      processados: processados.length,
      jobs: processados,
      duracaoMs: Date.now() - inicio,
    });
  } catch (err: any) {
    // Nunca devolve exceção crua. O que já foi processado nesta rodada
    // permanece — cada job é concluído no banco assim que termina.
    const mensagem = (err?.message ?? "Erro desconhecido").toString().slice(0, 300);
    console.error("[internal/estudio-anuncios/worker] falhou:", mensagem);
    return NextResponse.json(
      { ok: false, erro: "Falha ao processar a fila.", processados: processados.length },
      { status: 500 }
    );
  }
}
