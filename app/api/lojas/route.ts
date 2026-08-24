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
import { autenticarRequisicao } from "@/lib/autenticacao";
import { listarLojasAtivasDoDono } from "@/lib/marketplace/credenciais";

// LOJAS-ANON-SELECT: o cliente ANON de módulo foi REMOVIDO — esta rota
// não tem mais nenhuma consulta própria.

export async function GET(request: Request) {
  const auth = await autenticarRequisicao(request);
  const userId = auth.autenticado ? auth.uid : null;
  // Corpo de objeto, não `[]`: um array vazio com 401 se parece com
  // "você não tem lojas", que é outra afirmação.
  if (!userId) return NextResponse.json({ erro: "Não autenticado." }, { status: 401 });

  try {
    // LOJAS-ANON-SELECT: era leitura com o cliente ANON. Mesma projecao,
    // mesmos filtros, mesma ordenacao — so a origem passou a ser
    // privilegiada e server-only.
    const { linhas: data, erro: error } = await listarLojasAtivasDoDono(userId);

    if (error) {
      // `erro` e um CODIGO estavel da capability, nao o texto do Postgres.
      console.error("[GET /api/lojas] falha ao consultar lojas:", error);
      return NextResponse.json({ erro: "Não foi possível carregar as lojas." }, { status: 503 });
    }

    // Sucesso: array, mesmo vazio. Zero lojas é resposta legítima.
    return NextResponse.json(data ?? []);
  } catch (err: any) {
    console.error("[GET /api/lojas] erro inesperado:", err?.message);
    return NextResponse.json({ erro: "Não foi possível carregar as lojas." }, { status: 500 });
  }
}
