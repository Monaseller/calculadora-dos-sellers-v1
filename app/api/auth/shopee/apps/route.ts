import { NextResponse } from "next/server";
import { autenticarRequisicao } from "@/lib/autenticacao";
import { listarAppsShopeePublicos } from "@/lib/shopee-apps";

/**
 * GET /api/auth/shopee/apps — quais apps Shopee o servidor pode usar para
 * conectar uma conta (para a tela de Configuracoes mostrar as opcoes).
 *
 * Exige sessao. Devolve SO {chave, rotulo, configurado}: nunca partner_id,
 * partner_key, token ou dado do estado — o navegador nao precisa de nenhum
 * deles (o inicio do OAuth resolve tudo no servidor pela chave).
 */
export async function GET(request: Request) {
  const auth = await autenticarRequisicao(request);
  if (!auth.autenticado) return NextResponse.json({ erro: true, mensagem: "Nao autenticado." }, { status: 401 });
  const apps = listarAppsShopeePublicos().map(({ chave, rotulo, configurado }) => ({ chave, rotulo, configurado }));
  return NextResponse.json({ apps }, { headers: { "Cache-Control": "no-store" } });
}
