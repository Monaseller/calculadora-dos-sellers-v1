/**
 * GET/POST /api/estudio-anuncios/projetos
 *
 * CRUD mínimo do Projeto Mestre (Central de IA — Estúdio de Anúncios).
 * Mesmo padrão de autenticação do resto do CDS: sessão via cookie
 * cds_session (autenticarRequisicao), sem Supabase Auth, sem RLS — autorização
 * 100% em código de aplicação, sempre filtrando por user_id da sessão.
 * Nunca usa service role aqui (só worker/rota interna usam).
 *
 * POST depende da função RPC criar_projeto_estudio_anuncios(), proposta
 * nesta mesma entrega mas ainda NÃO criada/executada no banco (ver
 * chat — pendente de aprovação). Até a migration ser aprovada e
 * executada, POST responde 500 com a mensagem de erro do Postgres
 * ("function ... does not exist") — comportamento esperado nesta fase,
 * documentado, não um bug.
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { autenticarRequisicao } from "@/lib/autenticacao";
import { listarProjetos, criarProjeto } from "@/lib/estudio-anuncios/projetos";
import { validarCriarProjeto } from "@/lib/estudio-anuncios/validacao";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import type { ProjetoComAdaptacoes } from "@/lib/estudio-anuncios/tipos";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

/** user_id nunca é selecionado do banco (ver lib/estudio-anuncios/projetos.ts), mas por segurança a resposta nunca o repassa mesmo se algum dia aparecer. */
function paraResposta(p: ProjetoComAdaptacoes) {
  const { ...resto } = p as ProjetoComAdaptacoes & { user_id?: string };
  delete (resto as { user_id?: string }).user_id;
  return resto;
}

export async function GET(request: Request) {
  const auth = await autenticarRequisicao(request);
  const userId = auth.autenticado ? auth.uid : null;
  if (!userId) {
    return NextResponse.json({ ok: false, erro: "Não autenticado." }, { status: 401 });
  }

  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? undefined;
  const pageParam = url.searchParams.get("page");
  const pageSizeParam = url.searchParams.get("pageSize");

  try {
    const resultado = await listarProjetos(supabase, userId, {
      status,
      page: pageParam ? parseInt(pageParam, 10) : undefined,
      pageSize: pageSizeParam ? parseInt(pageSizeParam, 10) : undefined,
    });

    return NextResponse.json({
      ok: true,
      projetos: resultado.projetos.map(paraResposta),
      page: resultado.page,
      pageSize: resultado.pageSize,
    });
  } catch (err: any) {
    console.error("[GET /api/estudio-anuncios/projetos] falhou:", err?.message);
    return NextResponse.json({ ok: false, erro: "Falha ao listar projetos." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const auth = await autenticarRequisicao(request);
  const userId = auth.autenticado ? auth.uid : null;
  if (!userId) {
    return NextResponse.json({ ok: false, erro: "Não autenticado." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, erro: "Corpo da requisição inválido (JSON esperado)." }, { status: 400 });
  }

  const validacao = validarCriarProjeto(body);
  if (!validacao.valido) {
    return NextResponse.json({ ok: false, erro: validacao.erro }, { status: 400 });
  }

  try {
    // supabaseServico (service_role) é usado SÓ dentro de criarProjeto()
    // para a chamada da RPC restrita — nunca para leitura, nunca sai
    // deste escopo de função. Se as env vars necessárias faltarem,
    // getSupabaseServidor() lança um erro controlado (capturado abaixo).
    const supabaseServico = getSupabaseServidor();
    const projeto = await criarProjeto(supabase, supabaseServico, userId, validacao.dados);
    return NextResponse.json({ ok: true, projeto: paraResposta(projeto) }, { status: 201 });
  } catch (err: any) {
    // Nunca logar err completo se pudesse conter a service key — aqui
    // só logamos err.message, que vem de Error() lançado por código
    // nosso (validação/Supabase), nunca da chave em si.
    console.error("[POST /api/estudio-anuncios/projetos] falhou:", err?.message);
    return NextResponse.json({ ok: false, erro: "Falha ao criar projeto." }, { status: 500 });
  }
}
