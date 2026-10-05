/**
 * POST /api/anuncios/[id]/vendas-dia — venda do dia de um anúncio (SEC-3-B2).
 *
 * Antes: o card fazia `upsert` em `vendas_dia` direto do browser, e trocar
 * o `anuncio_id` bastava para escrever no anúncio de outro usuário. Agora:
 *   1. sessão;
 *   2. prova de que o anúncio é do dono da sessão (id + user_id);
 *   3. só então o upsert, com a mesma chave de conflito (`anuncio_id,data`)
 *      e a data calculada aqui, no mesmo formato de antes.
 * Anúncio alheio ou inexistente: 404, nenhuma escrita.
 */
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import { autenticarRequisicao } from "@/lib/autenticacao";
import { anuncioPertenceAoDono, registrarVendaDia, validarVendaDia } from "@/lib/anuncios/servico";

let clienteServidor: SupabaseClient | null = null;
function supabase(): SupabaseClient {
  return (clienteServidor ??= getSupabaseServidor());
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const auth = await autenticarRequisicao(request);
  if (!auth.autenticado) {
    return NextResponse.json({ erro: "Sessão inválida." }, { status: 401 });
  }
  const id = params?.id;
  if (!id || id.length > 200) {
    return NextResponse.json({ erro: "Anúncio não encontrado." }, { status: 404 });
  }

  let corpo: unknown;
  try {
    corpo = await request.json();
  } catch {
    return NextResponse.json({ erro: "Corpo inválido." }, { status: 400 });
  }
  const venda = validarVendaDia(corpo);
  if (!venda) {
    return NextResponse.json({ erro: "Venda inválida." }, { status: 400 });
  }

  const doDono = await anuncioPertenceAoDono(supabase(), auth.uid, id);
  if (doDono === null) {
    return NextResponse.json({ erro: "Falha ao validar anúncio." }, { status: 500 });
  }
  if (!doDono) {
    return NextResponse.json({ erro: "Anúncio não encontrado." }, { status: 404 });
  }

  if (!(await registrarVendaDia(supabase(), id, venda))) {
    return NextResponse.json({ erro: "Falha ao salvar venda." }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
