/**
 * PATCH /api/anuncios/[id] — edição de um anúncio (SEC-3-B2).
 *
 * Antes: o browser fazia `update(payload).eq("id", id)` — SEM dono. Agora
 * a escrita é `WHERE id = :id AND user_id = :sessão`, com whitelist de
 * campos. Anúncio de outro usuário e anúncio inexistente respondem o MESMO
 * 404: a rota não revela que o id existe.
 */
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import { autenticarRequisicao } from "@/lib/autenticacao";
import { atualizarAnuncioDoDono, montarCamposGravaveis } from "@/lib/anuncios/servico";

let clienteServidor: SupabaseClient | null = null;
function supabase(): SupabaseClient {
  return (clienteServidor ??= getSupabaseServidor());
}

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
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
  const payload = montarCamposGravaveis(corpo, true);
  if (!payload.ok) {
    return NextResponse.json({ erro: payload.erro }, { status: 400 });
  }

  const alterou = await atualizarAnuncioDoDono(supabase(), auth.uid, id, payload.campos);
  if (alterou === null) {
    return NextResponse.json({ erro: "Falha ao salvar anúncio." }, { status: 500 });
  }
  if (!alterou) {
    return NextResponse.json({ erro: "Anúncio não encontrado." }, { status: 404 });
  }
  return NextResponse.json({ id });
}
