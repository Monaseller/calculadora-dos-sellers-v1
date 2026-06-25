import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export async function GET() {
  const { data, error } = await supabase
    .from("lojas")
    .select("id, nome, marketplace, seller_id, nickname, ativo, created_at")
    .eq("ativo", true)
    .order("created_at");

  if (error) return NextResponse.json({ erro: true, mensagem: error.message });
  return NextResponse.json(data ?? []);
}
