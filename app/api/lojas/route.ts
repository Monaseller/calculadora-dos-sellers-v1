/**
 * GET /api/lojas — lojas ativas do usuário da sessão.
 *
 * TRATAMENTO DE ERRO (corrigido em 2026-09-01). A versão anterior fazia:
 *
 *   if (error) return NextResponse.json({ erro: true, mensagem: error.message });
 *
 * ...sem `status`, ou seja, **HTTP 200 para falha de infraestrutura**. Isso
 * não é detalhe de estilo: foi exatamente o que escondeu, por ~54 dias,
 * uma `NEXT_PUBLIC_SUPABASE_URL` malformada em produção. Nenhum
 * monitoramento acusa 200, e todo consumidor daqui trata "não é array"
 * como "nenhuma loja" — então a tela mostrava zero lojas em vez de
 * mostrar que algo estava quebrado.
 *
 * Agora: banco fora do ar é 5xx, lista vazia legítima é 200 com `[]`, e
 * as duas coisas param de se parecer.
 *
 * A mensagem do Supabase **não** vai para o cliente: ela pode conter
 * nome de tabela, coluna e detalhe de esquema. Fica no log do servidor.
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getUserId } from "@/lib/session";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export async function GET(request: Request) {
  const userId = getUserId(request);
  // Corpo de objeto, não `[]`: um array vazio com 401 se parece com
  // "você não tem lojas", que é outra afirmação.
  if (!userId) return NextResponse.json({ erro: "Não autenticado." }, { status: 401 });

  try {
    const { data, error } = await supabase
      .from("lojas")
      .select("id, nome, marketplace, seller_id, nickname, ativo, created_at")
      .eq("ativo", true)
      .eq("user_id", userId)
      .order("created_at");

    if (error) {
      console.error("[GET /api/lojas] falha ao consultar lojas:", error.message);
      return NextResponse.json({ erro: "Não foi possível carregar as lojas." }, { status: 503 });
    }

    // Sucesso: array, mesmo vazio. Zero lojas é resposta legítima.
    return NextResponse.json(data ?? []);
  } catch (err: any) {
    console.error("[GET /api/lojas] erro inesperado:", err?.message);
    return NextResponse.json({ erro: "Não foi possível carregar as lojas." }, { status: 500 });
  }
}
