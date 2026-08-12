/**
 * POST /api/estudio-anuncios/projetos/[id]/pipeline/iniciar
 *
 * AJUSTE (2026-08-07 — UI iniciar/acompanhar Pipeline com Gateway fake).
 *
 * Rota nova (nenhuma rota paralela/duplicada — este é o único ponto de
 * entrada para iniciar um Pipeline). Mesmo padrão de autenticação do
 * resto do módulo: sessão via cookie cds_session (getUserId), sem
 * Supabase Auth, sem RLS — autorização 100% em código de aplicação.
 *
 * Segurança (nesta ordem, nunca invertida):
 *   1) getUserId(request) — 401 se ausente;
 *   2) valida formato UUID de params.id — 400 se inválido;
 *   3) buscarProjetoPorId(supabase, userId, params.id) — já filtra por
 *      user_id da sessão; projeto inexistente OU de outro usuário
 *      devolvem o MESMO 404 (não vaza existência);
 *   4) só DEPOIS de confirmar a propriedade do projeto é que o service
 *      role (getSupabaseServidor()) é usado, exclusivamente para a
 *      chamada da RPC restrita — nunca para leitura.
 * Nunca aceita user_id vindo do corpo/query da requisição.
 *
 * Regras de status (ver RPC estudio_anuncios_pipeline_iniciar em
 * supabase/migrations/20260807_estudio_anuncios_iniciar_pipeline_rpc.sql,
 * ainda NÃO executada — até a execução, toda chamada a esta rota falha
 * com 500 "function ... does not exist", mesmo comportamento documentado
 * já usado por POST /api/estudio-anuncios/projetos enquanto sua RPC
 * esperava aprovação):
 *   - projeto.status = 'cancelado' → 409 (checado aqui, na rota, ANTES
 *     de chamar a RPC — que também revalida isso internamente, ver
 *     migration);
 *   - projeto.status = 'concluido' → 409 (mesma lógica);
 *   - RPC devolve criadoAgora=true → 201 (Pipeline novo);
 *   - RPC devolve criadoAgora=false e pipeline.status IN
 *     ('concluido','cancelado') → 409 (idempotente, mas terminal —
 *     nada a fazer);
 *   - RPC devolve criadoAgora=false e qualquer outro status
 *     (criado/aguardando/em_execucao/aguardando_pendencias/erro/pausado)
 *     → 200 idempotente, com o estado atual (não reinicia nada — "erro"
 *     inclusive: retomar um pipeline em erro é fora de escopo desta
 *     tarefa, ver instrução do usuário).
 *
 * NÃO chama Worker, NÃO chama Gateway, NÃO executa nenhum job dentro
 * desta requisição — só cria a linha do Pipeline + o primeiro job
 * pendente. O Worker (processo externo, fora de escopo desta tarefa)
 * continua sendo quem reivindica e executa jobs.
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getUserId } from "@/lib/session";
import { buscarProjetoPorId } from "@/lib/estudio-anuncios/projetos";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import { iniciarPipelineAtomico } from "@/lib/estudio-anuncios/pipeline/pipeline";
import { buscarJobPorId } from "@/lib/estudio-anuncios/jobs";
import { obterEstadoFotosProjeto } from "@/lib/estudio-anuncios/fotos";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  const userId = getUserId(request);
  if (!userId) {
    return NextResponse.json({ ok: false, erro: "Não autenticado." }, { status: 401 });
  }

  if (!UUID_REGEX.test(params.id)) {
    return NextResponse.json({ ok: false, erro: "id inválido." }, { status: 400 });
  }

  try {
    const projeto = await buscarProjetoPorId(supabase, userId, params.id);
    if (!projeto) {
      return NextResponse.json({ ok: false, erro: "Projeto não encontrado." }, { status: 404 });
    }

    if (projeto.status === "cancelado") {
      return NextResponse.json(
        { ok: false, erro: "Projeto cancelado — não é possível iniciar a geração." },
        { status: 409 }
      );
    }
    if (projeto.status === "concluido") {
      return NextResponse.json(
        { ok: false, erro: "Projeto já concluído — não é possível iniciar a geração novamente." },
        { status: 409 }
      );
    }

    // AJUSTE (2026-08-10 — corrigir bug real: Pipeline podia iniciar com
    // zero fotos). Pré-checagem na rota, com o cliente anon (mesmo
    // padrão de leitura já usado acima) — a RPC
    // estudio_anuncios_pipeline_iniciar faz a MESMA checagem de novo,
    // dentro da própria transação (ver migration
    // 20260810_estudio_anuncios_pipeline_exigir_foto.sql), então esta
    // checagem aqui é só para devolver um erro rápido e amigável antes
    // de sequer chamar o service role — nunca a única linha de defesa.
    const estadoFotos = await obterEstadoFotosProjeto(supabase, params.id);
    if (estadoFotos.total === 0) {
      return NextResponse.json(
        { ok: false, erro: "Adicione pelo menos uma foto do produto antes de iniciar a geração." },
        { status: 409 }
      );
    }

    const supabaseServico = getSupabaseServidor();
    const resultado = await iniciarPipelineAtomico(supabaseServico, params.id);

    // Busca o job atual (1º job, recém-criado ou já existente) para
    // devolver junto do Pipeline — leitura simples, cliente anon,
    // mesmo padrão do resto do módulo.
    const job = resultado.pipeline.jobAtualId
      ? await buscarJobPorId(supabase, resultado.pipeline.jobAtualId)
      : null;

    if (!resultado.criadoAgora) {
      if (resultado.pipeline.status === "concluido" || resultado.pipeline.status === "cancelado") {
        return NextResponse.json(
          {
            ok: false,
            erro: `Pipeline já está ${resultado.pipeline.status === "concluido" ? "concluído" : "cancelado"}.`,
            criado: false,
            pipeline: resultado.pipeline,
            job,
          },
          { status: 409 }
        );
      }

      return NextResponse.json(
        { ok: true, criado: false, pipeline: resultado.pipeline, job },
        { status: 200 }
      );
    }

    return NextResponse.json(
      { ok: true, criado: true, pipeline: resultado.pipeline, job },
      { status: 201 }
    );
  } catch (err: any) {
    const msg: string = err?.message || "";

    // Mapeia as exceções sinalizadas da RPC (RAISE EXCEPTION 'PREFIXO: ...')
    // para respostas HTTP amigáveis — defesa extra caso a checagem acima
    // (feita antes da chamada) tenha ficado desatualizada com o estado
    // real do projeto entre a leitura e a chamada da RPC.
    if (msg.includes("PROJETO_NAO_ENCONTRADO")) {
      return NextResponse.json({ ok: false, erro: "Projeto não encontrado." }, { status: 404 });
    }
    if (msg.includes("PROJETO_CANCELADO")) {
      return NextResponse.json({ ok: false, erro: "Projeto cancelado — não é possível iniciar a geração." }, { status: 409 });
    }
    if (msg.includes("PROJETO_CONCLUIDO")) {
      return NextResponse.json({ ok: false, erro: "Projeto já concluído — não é possível iniciar a geração novamente." }, { status: 409 });
    }
    if (msg.includes("PROJETO_SEM_FOTOS")) {
      return NextResponse.json({ ok: false, erro: "Adicione pelo menos uma foto do produto antes de iniciar a geração." }, { status: 409 });
    }

    console.error("[POST /api/estudio-anuncios/projetos/[id]/pipeline/iniciar] falhou:", msg);
    return NextResponse.json({ ok: false, erro: "Falha ao iniciar a geração." }, { status: 500 });
  }
}
