/**
 * GET /api/ml/conexao — estado da conexão com o Mercado Livre, decidido
 * no servidor. F0.c.5, fase B.
 *
 * ── Por que existe ──────────────────────────────────────────────────
 * `/api/auth/status`, que hoje governa a tela Meus Produtos, responde
 * "conectado" perguntando ao navegador se ele tem o cookie
 * `ml_access_token`. O cookie vive 6 horas; quando vence, a tela declara
 * desconexão e desabilita justamente os botões que renovariam o token.
 * O usuário fica preso com a credencial intacta no banco.
 *
 * Aqui a decisão sai da sessão do CDS: quem é o usuário, qual loja é
 * dele, o que existe no banco — e, se preciso, uma renovação
 * server-side. O navegador não guarda nem fornece credencial.
 *
 * ── Esta rota ainda não é consumida ─────────────────────────────────
 * `/api/auth/status` continua existindo e nenhuma tela foi migrada. A
 * troca é da fase C.
 *
 * ── O que nunca sai daqui ───────────────────────────────────────────
 * access_token, refresh_token, header Authorization, client_secret. A
 * resposta é montada por `montarRespostaConexao`, campo a campo, e o
 * `catch` registra apenas a mensagem do erro no log do servidor — a
 * resposta ao cliente é genérica.
 */
import { NextResponse } from "next/server";
import { autenticarRequisicao, lerCookie } from "@/lib/autenticacao";
import { resolverContaML, montarRespostaConexao } from "@/lib/ml-conexao";

/**
 * A resposta é POR USUÁRIO e depende de estado que muda (validade do
 * token). Sem isto, o Next tenta pré-renderizar esta rota no build e
 * serviria uma resposta estática — o estado de conexão de alguém virando
 * o estado de todo mundo. `force-dynamic` é obrigatório aqui, não estilo.
 */
export const dynamic = "force-dynamic";

/** Identidade da loja escolhida — NUNCA credencial. Ver §12 de F0.c.5. */
const COOKIE_LOJA_ATIVA = "loja_ativa_id";

export async function GET(request: Request) {
  const auth = await autenticarRequisicao(request);
  // Sem sessão: 401 antes de qualquer consulta e sem nenhuma chamada ao
  // Mercado Livre. Nem o cookie de loja é lido.
  if (!auth.autenticado) {
    return NextResponse.json({ erro: "Não autenticado." }, { status: 401 });
  }

  // O cookie diz QUAL loja; a propriedade dela é verificada dentro do
  // resolvedor, contra o uid da sessão. Cookie apontando para loja alheia
  // não vira fallback para nada — vira recusa.
  const lojaIndicada = lerCookie(request, COOKIE_LOJA_ATIVA);

  try {
    const resultado = await resolverContaML(auth.uid, lojaIndicada);
    return NextResponse.json(montarRespostaConexao(resultado));
  } catch (err: any) {
    // Falha de infraestrutura NÃO é "desconectado": responder 200 com
    // `conectado: false` aqui repetiria o erro que escondeu por 54 dias
    // uma URL de Supabase malformada em produção.
    console.error("[GET /api/ml/conexao] falha ao resolver conexão:", err?.message);
    return NextResponse.json(
      { erro: "Não foi possível verificar a conexão com o Mercado Livre." },
      { status: 503 }
    );
  }
}
