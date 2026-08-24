/**
 * PERFIL-SENHA1a: leitura migrada para a capability server-only.
 * Contrato HTTP e campos devolvidos permanecem idênticos.
 */
import { NextRequest, NextResponse } from "next/server";
import { autenticarRequisicao } from "@/lib/autenticacao";
import { lerPerfilDaSessao } from "@/lib/perfil/credenciais";

export async function GET(request: NextRequest) {
  const auth = await autenticarRequisicao(request);
  const userId = auth.autenticado ? auth.uid : null;
  if (!userId) return NextResponse.json({ userId: null }, { status: 401 });

  // Confirma que o UUID existe no banco
  const { perfil: data } = await lerPerfilDaSessao(userId);

  if (!data) return NextResponse.json({ userId: null }, { status: 401 });

  return NextResponse.json({ userId: data.user_uuid, nome: data.nome_completo, email: data.email });
}
