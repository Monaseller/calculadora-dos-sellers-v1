/**
 * GET  /api/anuncios?de=0&ate=999[&projecao=dashboard]
 * POST /api/anuncios
 *
 * SEC-3-B2: Meus Produtos e o dashboard liam/gravavam `anuncios` direto do
 * browser com a chave anon. Agora passam por aqui: o dono vem SEMPRE da
 * sessão, nunca de query, body ou header, e cada consulta leva o filtro de
 * dono dentro dela (ver lib/anuncios/servico.ts).
 *
 * GET devolve UMA página: quem pagina é a tela (`buscarPaginado`), como
 * antes — `de`/`ate` são o `range` que ela já pedia ao PostgREST.
 */
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import { autenticarRequisicao, lerCookie } from "@/lib/autenticacao";
import { listarLojasAtivasDoDono } from "@/lib/marketplace/credenciais";
import { decidirLoja, type ResolucaoLoja } from "@/lib/lojas/resolver";
import {
  TAMANHO_MAXIMO_PAGINA,
  criarAnuncio,
  listarAnunciosDoDono,
  montarCamposGravaveis,
} from "@/lib/anuncios/servico";

let clienteServidor: SupabaseClient | null = null;
function supabase(): SupabaseClient {
  return (clienteServidor ??= getSupabaseServidor());
}

function inteiroNaoNegativo(v: string | null): number | null {
  if (v === null || !/^\d{1,7}$/.test(v)) return null;
  return Number(v);
}

export async function GET(request: Request) {
  const auth = await autenticarRequisicao(request);
  if (!auth.autenticado) {
    return NextResponse.json({ erro: "Sessão inválida." }, { status: 401 });
  }

  const params = new URL(request.url).searchParams;
  const de = inteiroNaoNegativo(params.get("de") ?? "0");
  const ate = inteiroNaoNegativo(params.get("ate") ?? String(TAMANHO_MAXIMO_PAGINA - 1));
  if (de === null || ate === null || ate < de || ate - de + 1 > TAMANHO_MAXIMO_PAGINA) {
    return NextResponse.json({ erro: "Intervalo inválido." }, { status: 400 });
  }
  const projecao = params.get("projecao") === "dashboard" ? "dashboard" : "tela";

  const anuncios = await listarAnunciosDoDono(supabase(), auth.uid, de, ate, projecao);
  if (anuncios === null) {
    return NextResponse.json({ erro: "Falha ao carregar anúncios." }, { status: 500 });
  }
  return NextResponse.json({ anuncios });
}

export async function POST(request: Request) {
  const auth = await autenticarRequisicao(request);
  if (!auth.autenticado) {
    return NextResponse.json({ erro: "Sessão inválida." }, { status: 401 });
  }

  let corpo: unknown;
  try {
    corpo = await request.json();
  } catch {
    return NextResponse.json({ erro: "Corpo inválido." }, { status: 400 });
  }
  const payload = montarCamposGravaveis(corpo, false);
  if (!payload.ok) {
    return NextResponse.json({ erro: payload.erro, ...(payload.codigo ? { codigo: payload.codigo } : {}) }, { status: 400 });
  }

  // CDS V2 Fase 2D: anúncio ML manual (sem identidade do provider) também pertence a UMA loja ML,
  // resolvida AQUI no servidor — o body não escolhe loja (loja_id nem é campo gravável).
  let lojaId: string | null = null;
  if (payload.campos.marketplace === "ML") {
    const loja = await lojaMLDoContexto(auth.uid, lerCookie(request, "loja_ativa_id"));
    if (!loja.ok) {
      if (loja.motivo === "ERRO_LEITURA") return NextResponse.json({ erro: "Falha ao salvar anúncio." }, { status: 503 });
      return NextResponse.json({ erro: "Selecione a loja do Mercado Livre deste anúncio.", codigo: "STORE_SELECTION_REQUIRED" }, { status: 409 });
    }
    lojaId = loja.loja.id;
  }

  const id = await criarAnuncio(supabase(), auth.uid, payload.campos, lojaId);
  if (!id) {
    return NextResponse.json({ erro: "Falha ao salvar anúncio." }, { status: 500 });
  }
  return NextResponse.json({ id }, { status: 201 });
}

/**
 * Loja ML de um anúncio manual: o contexto `loja_ativa_id` SÓ vale se for uma loja ML ATIVA deste
 * dono; senão, a loja ML ativa ÚNICA (opt-in explícito). 0 lojas ou 2+ sem contexto válido →
 * STORE_SELECTION_REQUIRED (nunca "a mais recente", "a primeira" ou LIMIT 1).
 */
async function lojaMLDoContexto(userId: string, contexto: string | null): Promise<ResolucaoLoja> {
  const { linhas, erro } = await listarLojasAtivasDoDono(userId);
  if (erro) return { ok: false, motivo: "ERRO_LEITURA" };
  if (contexto) {
    const doContexto = decidirLoja(linhas, { marketplace: "ML", lojaId: contexto });
    if (doContexto.ok) return doContexto;
  }
  return decidirLoja(linhas, { marketplace: "ML", permitirUnica: true });
}
