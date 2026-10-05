/**
 * POST /api/anuncios/desativar  { ids: string[] } — soft delete (SEC-3-B2).
 *
 * Mesmo contrato que a tela já tinha com o banco: `ativo:false` (nunca
 * DELETE físico), um lote de no máximo 200 ids por chamada, e a resposta
 * traz SÓ os ids que o banco confirmou. Id de outro usuário não casa com
 * `user_id = sessão` e simplesmente não volta — a tela o mantém na lista.
 */
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import { autenticarRequisicao } from "@/lib/autenticacao";
import { LOTE_MAXIMO_DESATIVACAO, desativarAnunciosDoDono } from "@/lib/anuncios/servico";

let clienteServidor: SupabaseClient | null = null;
function supabase(): SupabaseClient {
  return (clienteServidor ??= getSupabaseServidor());
}

export async function POST(request: Request) {
  const auth = await autenticarRequisicao(request);
  if (!auth.autenticado) {
    return NextResponse.json({ erro: "Sessão inválida." }, { status: 401 });
  }

  let corpo: any;
  try {
    corpo = await request.json();
  } catch {
    return NextResponse.json({ erro: "Corpo inválido." }, { status: 400 });
  }
  const ids = corpo?.ids;
  const chaves = corpo && typeof corpo === "object" ? Object.keys(corpo) : [];
  if (
    chaves.length !== 1 ||
    !Array.isArray(ids) || ids.length === 0 || ids.length > LOTE_MAXIMO_DESATIVACAO ||
    !ids.every((x: unknown) => typeof x === "string" && x.length > 0 && x.length <= 200)
  ) {
    return NextResponse.json({ erro: "Lista de anúncios inválida." }, { status: 400 });
  }

  const r = await desativarAnunciosDoDono(supabase(), auth.uid, ids);
  if (r.erro) {
    return NextResponse.json({ erro: r.erro }, { status: 500 });
  }
  return NextResponse.json({ ids: r.ids });
}
