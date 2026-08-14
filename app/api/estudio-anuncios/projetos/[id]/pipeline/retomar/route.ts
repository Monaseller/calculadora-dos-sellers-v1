/**
 * POST /api/estudio-anuncios/projetos/[id]/pipeline/retomar
 *
 * "Tentar novamente" — retoma um Pipeline que terminou em erro.
 *
 * ── Por que esta rota existe (2026-09-06) ───────────────────────────
 * Um Pipeline que falha ficava parado para sempre. `pipeline/iniciar` é
 * idempotente e devolve o estado atual sem retomar — comportamento
 * correto e documentado, mas que na prática obrigava a refazer o projeto
 * inteiro, pagando de novo as etapas já concluídas. Num caso real
 * ("Cacau shows"), quatro etapas com provedor real já estavam
 * concluídas e persistidas quando a quinta falhou.
 *
 * ── O que ela NÃO faz ───────────────────────────────────────────────
 * Não executa nada. Cria um job novo e devolve. Quem processa continua
 * sendo o cron — a rota nunca chama o worker, nem direta nem
 * indiretamente. Isso mantém um único executor no sistema.
 *
 * Não refaz etapas concluídas. O job novo é da MESMA etapa que falhou e
 * herda a origem do job falho, então os artefatos anteriores continuam
 * sendo consumidos de onde estão.
 *
 * Autorização: mesma disciplina do resto do módulo — sessão obrigatória
 * e propriedade do projeto confirmada com o cliente anon antes de o
 * service role ser usado para a RPC.
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { autenticarRequisicao } from "@/lib/autenticacao";
import { buscarProjetoPorId } from "@/lib/estudio-anuncios/projetos";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import { buscarPipelinePorProjeto } from "@/lib/estudio-anuncios/pipeline/pipeline";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const auth = await autenticarRequisicao(request);
  const userId = auth.autenticado ? auth.uid : null;
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
        { ok: false, erro: "Projeto cancelado — não é possível retomar a geração." },
        { status: 409 }
      );
    }
    if (projeto.status === "concluido") {
      return NextResponse.json(
        { ok: false, erro: "Projeto já concluído — não há o que retomar." },
        { status: 409 }
      );
    }

    const pipeline = await buscarPipelinePorProjeto(supabase, params.id);
    if (!pipeline) {
      return NextResponse.json(
        { ok: false, erro: "Este projeto ainda não tem uma geração iniciada." },
        { status: 409 }
      );
    }
    // Pré-checagem amigável. A RPC refaz a mesma verificação dentro da
    // própria transação, com FOR UPDATE — esta aqui nunca é a única
    // linha de defesa, só evita chamar o service role à toa.
    if (pipeline.status !== "erro") {
      return NextResponse.json(
        { ok: false, erro: `A geração não está em erro (situação atual: "${pipeline.status}").` },
        { status: 409 }
      );
    }

    const supabaseServico = getSupabaseServidor();
    const { data, error } = await supabaseServico
      .rpc("estudio_anuncios_pipeline_retomar", { p_pipeline_id: pipeline.id })
      .single();

    if (error) {
      // Erros de guarda da RPC viram 409; o resto é falha real.
      const guarda = /PROJETO_CANCELADO|PROJETO_CONCLUIDO|JOB_ATUAL_NAO_ESTA_EM_ERRO|PIPELINE_SEM_JOB_ATUAL/.test(
        error.message
      );
      return NextResponse.json(
        { ok: false, erro: guarda ? error.message.slice(0, 200) : "Não foi possível retomar a geração." },
        { status: guarda ? 409 : 500 }
      );
    }

    const linha = data as {
      status: string;
      etapa_atual: string | null;
      job_atual_id: string | null;
      job_criado: boolean;
    };

    return NextResponse.json({
      ok: true,
      // `false` quando outra aba já retomou — não é erro, é idempotência.
      jobCriado: linha.job_criado,
      pipeline: {
        id: pipeline.id,
        status: linha.status,
        etapaAtual: linha.etapa_atual,
        jobAtualId: linha.job_atual_id,
      },
      mensagem: linha.job_criado
        ? "Geração recolocada na fila. A etapa que falhou será refeita automaticamente em instantes."
        : "A geração já havia sido recolocada na fila.",
    });
  } catch (err: any) {
    console.error("[pipeline/retomar] falhou:", (err?.message ?? "").toString().slice(0, 300));
    return NextResponse.json({ ok: false, erro: "Não foi possível retomar a geração." }, { status: 500 });
  }
}
