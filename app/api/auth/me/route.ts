import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getUserId } from "@/lib/session";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export async function GET(request: NextRequest) {
  const userId = getUserId(request);
  if (!userId) return NextResponse.json({ userId: null }, { status: 401 });

  // Confirma que o UUID existe no banco
  const { data } = await supabase
    .from("perfil")
    .select("user_uuid, nome_completo, email")
    .eq("user_uuid", userId)
    .single();

  if (!data) return NextResponse.json({ userId: null }, { status: 401 });

  return NextResponse.json({ userId: data.user_uuid, nome: data.nome_completo, email: data.email });
}
