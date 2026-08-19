/**
 * POST /api/lojas/desconectar — desconecta uma loja do usuário da sessão.
 *
 * ── O BUG QUE ESTA VERSÃO CORRIGE (F0.c.6a) ─────────────────────────
 * A rota ficou no mecanismo de sessão V1, extinto no cutover `5933332`:
 *
 *     const userId = getCookie(request, "cds_session");
 *     …update(…).eq("id", loja_id).eq("user_id", userId);
 *     return NextResponse.json({ ok: true });
 *
 * Desde o cutover, `cds_session` carrega um TOKEN ASSINADO, não um UUID.
 * Comparar esse token com a coluna `user_id` (tipo `uuid`) não casa nunca
 * — e o retorno era `ok: true` sem checar erro nem linhas afetadas. Ou
 * seja: a tela dizia "Loja desconectada." e nada acontecia.
 *
 * Foi o que fechou o beco sem saída do incidente de 2026-08-14: sem botão
 * de reconectar em Configurações, o único botão disponível era inerte.
 *
 * A rota não aparecia no inventário de F0.c.3a porque lia o cookie com um
 * helper próprio, em vez de `getUserId`. É a mesma classe de falha que já
 * escapou antes: inventário por nome não encontra quem lê o cookie por
 * conta própria.
 *
 * ── O QUE "DESCONECTAR" SIGNIFICA AQUI ──────────────────────────────
 * `ativo = false` e as três colunas de credencial de SESSÃO zeradas. A
 * linha NÃO é apagada: `pedidos` referencia `loja_id`, e apagar levaria
 * histórico financeiro junto.
 *
 * `partner_id`, `partner_key` e `shop_id` são PRESERVADOS de propósito.
 * Apesar do nome, `partner_key` não é credencial de sessão: é a chave de
 * aplicação da Shopee, lida do banco para assinar cada requisição
 * (`lib/shopee-auth.ts`). Ela não volta por reautorização — apagá-la
 * impediria reconectar a loja depois.
 */
import { NextResponse } from "next/server";
import { autenticarRequisicao, lerCookie } from "@/lib/autenticacao";
import { desconectarLojaDoDono } from "@/lib/marketplace/credenciais";

/** Mesmo formato canônico já exigido em `lib/ml-auth.ts` (F0.c.4). */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Cookie expirado explicitamente no mesmo `path` em que foi emitido. */
function limparCookie(res: NextResponse, nome: string) {
  res.cookies.set(nome, "", { maxAge: 0, path: "/" });
}

export async function POST(request: Request) {
  const auth = await autenticarRequisicao(request);
  const userId = auth.autenticado ? auth.uid : null;
  if (!userId) {
    return NextResponse.json({ erro: true, mensagem: "Sessão inválida." }, { status: 401 });
  }

  // Entrada inválida é 400: o cliente pediu errado, o servidor está bem.
  let corpo: any;
  try {
    corpo = await request.json();
  } catch {
    return NextResponse.json({ erro: true, mensagem: "Body inválido." }, { status: 400 });
  }

  const lojaId = corpo?.loja_id;
  // Id malformado é barrado ANTES do banco: além de não pertencer a
  // ninguém, um valor não-UUID numa coluna `uuid` faz o Postgres devolver
  // erro, e o erro viraria 5xx em vez da recusa limpa que o caso merece.
  if (typeof lojaId !== "string" || !UUID_REGEX.test(lojaId)) {
    return NextResponse.json({ erro: true, mensagem: "loja_id inválido." }, { status: 400 });
  }

  // ── A escrita ─────────────────────────────────────────────────────
  // A rota NÃO fala com o banco: quem escreve é a capability server-only,
  // e é lá que vive o filtro privilegiado (`id + user_id + ativo=true`) —
  // dono na própria instrução de UPDATE, não numa checagem anterior que
  // alguém possa remover ao refatorar. Aqui só sobra a tradução do
  // resultado para HTTP.
  const { desconectadas, erro } = await desconectarLojaDoDono(lojaId, userId);

  if (erro) {
    // A mensagem crua do Supabase pode conter nome de tabela, coluna e
    // esquema — fica no log, nunca na resposta.
    console.error("[POST /api/lojas/desconectar] falha ao desconectar:", erro);
    return NextResponse.json(
      { erro: true, mensagem: "Não foi possível desconectar a loja agora." },
      { status: 503 }
    );
  }

  if (desconectadas === 0) {
    // Não existe, não é sua, ou já estava desconectada — MESMA resposta.
    // Distinguir os casos permitiria descobrir se uma loja alheia existe.
    return NextResponse.json(
      { erro: true, mensagem: "Loja não encontrada ou já desconectada." },
      { status: 404 }
    );
  }

  const res = NextResponse.json({ ok: true });

  // ── Cookies da loja que deixou de operar ──────────────────────────
  // Só quando a loja desconectada era a SELECIONADA: os cookies são por
  // navegador, não por loja, então limpá-los sempre derrubaria a seleção
  // de outra loja que continua conectada.
  if (lerCookie(request, "loja_ativa_id") === lojaId) {
    limparCookie(res, "loja_ativa_id");
    limparCookie(res, "ml_access_token");
    // O `ml_refresh_token` (180 dias) NUNCA era apagado em lugar nenhum —
    // sobrevivia ao logout e à desconexão. Aqui ele finalmente sai.
    limparCookie(res, "ml_refresh_token");
  }

  if (lerCookie(request, "shopee_loja_id") === lojaId) {
    limparCookie(res, "shopee_loja_id");
    limparCookie(res, "shopee_access_token");
    limparCookie(res, "shopee_shop_id");
  }

  return res;
}
