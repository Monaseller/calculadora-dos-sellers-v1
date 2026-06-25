import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export async function GET() {
  const { data } = await supabase
    .from("perfil")
    .select("*")
    .eq("id", 1)
    .single();

  return NextResponse.json(data ?? {});
}

export async function POST(request: Request) {
  const body = await request.json();

  const campos: Record<string, string> = {};
  if (body.nome_completo !== undefined) campos.nome_completo = body.nome_completo;
  if (body.usuario      !== undefined) campos.usuario       = body.usuario;
  if (body.email        !== undefined) campos.email         = body.email;
  if (body.documento    !== undefined) campos.documento     = body.documento;
  if (body.senha        !== undefined) campos.senha         = body.senha;

  const { error } = await supabase
    .from("perfil")
    .upsert({ id: 1, ...campos }, { onConflict: "id" });

  if (error) {
    return NextResponse.json({ erro: true, mensagem: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
