import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") || "";
  const entry = header.split("; ").find(c => c.startsWith(`${name}=`));
  return entry ? entry.slice(name.length + 1) : null;
}

export async function POST(request: Request) {
  const { loja_id } = await request.json();

  await supabase
    .from("lojas")
    .update({ ativo: false, access_token: null })
    .eq("id", loja_id);

  const activeId = getCookie(request, "loja_ativa_id");
  const res = NextResponse.json({ ok: true });

  if (activeId === loja_id) {
    res.cookies.delete("ml_access_token");
    res.cookies.delete("loja_ativa_id");
  }

  return res;
}
