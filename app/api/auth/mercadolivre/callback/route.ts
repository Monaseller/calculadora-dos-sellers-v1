/**
 * GET /api/auth/mercadolivre/callback — retorno do OAuth do Mercado Livre.
 *
 * ── O que muda em F0.c.6c + 6d ──────────────────────────────────────
 * A versão anterior trocava o `code` por token e mandava o navegador para
 * `/api/auth/relay?token=…&refresh_token=…` — credencial em QUERY STRING,
 * portanto em histórico, `Referer` e logs de acesso. O relay, por sua
 * vez, tratava a sessão como opcional, procurava a loja por `seller_id`
 * sem dono quando não havia sessão, e embrulhava tudo num `try {} catch {}`
 * vazio que redirecionava como se tivesse dado certo.
 *
 * Agora o callback faz tudo aqui: valida, troca, identifica, confere
 * propriedade, grava e confere o efeito da gravação. Os tokens só existem
 * em variável local — nunca em URL, `Location`, cookie, resposta ou log.
 *
 * ── Ordem, e por que ela é essa ─────────────────────────────────────
 * Tudo o que pode reprovar sem custo vem ANTES da troca do `code`: o
 * `code` é de uso único, e queimá-lo para depois descobrir que o `state`
 * era inválido ou que a loja não é do usuário desperdiça a autorização.
 * A única checagem que não cabe antes é a do seller — só se sabe quem
 * autorizou depois de ter o token.
 *
 * ── Consequência assumida ───────────────────────────────────────────
 * Quando a recusa é `conta_ml_diferente`, o token JÁ foi obtido. O
 * Mercado Livre não expõe revogação no que usamos, então ele é
 * descartado — nunca gravado, nunca logado — e expira sozinho. Não há
 * como evitar sem saber o seller antes, o que é impossível.
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { autenticarRequisicao, agoraEmSegundos, lerCookie } from "@/lib/autenticacao";
import { verificarEstado, verifierConfere, nomeCookiePkce } from "@/lib/estado-oauth";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

const TIMEOUT_MS = 20_000;

/**
 * Códigos enumerados. A UI traduz cada um; nenhum carrega detalhe do
 * provedor, nome de tabela, token ou seller.
 */
type CodigoErroOAuth =
  | "sessao_invalida"
  | "oauth_cancelado"
  | "state_invalido"
  | "state_expirado"
  | "pkce_cookie_ausente"
  | "pkce_invalido"
  | "loja_nao_pertence_usuario"
  | "conta_ml_diferente"
  | "duplicidade_loja"
  | "token_exchange_falhou"
  | "identidade_falhou"
  | "persistencia_falhou"
  | "configuracao_invalida";

/**
 * Expira o cookie do PKCE. Chamado em TODO desfecho terminal em que o
 * challenge já é conhecido — o `code_verifier` é de uso único, e deixá-lo
 * no navegador o tornaria reaproveitável numa tentativa seguinte.
 *
 * `path` tem de ser idêntico ao da emissão, senão a remoção falha em
 * silêncio e o cookie sobrevive.
 */
function limparCookiePkce(res: NextResponse, chal: string | null) {
  if (!chal) return;
  res.cookies.set(nomeCookiePkce(chal), "", { maxAge: 0, path: "/api/auth/mercadolivre" });
}

function erro(request: Request, codigo: CodigoErroOAuth, chal: string | null = null) {
  const destino = new URL("/configuracoes", request.url);
  destino.searchParams.set("ml_erro", codigo);
  const res = NextResponse.redirect(destino);
  limparCookiePkce(res, chal);
  return res;
}

function sucesso(request: Request, resultado: "connected" | "reconnected", lojaId: string, chal: string | null) {
  const destino = new URL("/configuracoes", request.url);
  destino.searchParams.set("ml", resultado);
  destino.searchParams.set("loja", lojaId);
  const res = NextResponse.redirect(destino);
  limparCookiePkce(res, chal);
  return res;
}

export async function GET(request: Request) {
  const url = new URL(request.url);

  // 1. Sessão CDS. Depois de F0.c.6b o callback volta no MESMO host do
  //    login, então o cookie (host-only, SameSite=Lax) chega aqui numa
  //    navegação top-level — que é exatamente o que este retorno é.
  const auth = await autenticarRequisicao(request);
  if (!auth.autenticado) return erro(request, "sessao_invalida");
  const userId = auth.uid;

  // 2. O usuário pode ter recusado no Mercado Livre.
  if (url.searchParams.get("error")) return erro(request, "oauth_cancelado");

  // 3. `code`. Ausência dele SEM `error` não é desfecho de OAuth: é
  //    requisição malformada. Segue 400 em JSON, como antes — o Mercado
  //    Livre sempre manda `code` ou `error`, então quem chega aqui assim
  //    não é um usuário no meio de um fluxo.
  const code = url.searchParams.get("code");
  if (!code) {
    return NextResponse.json({ erro: true, mensagem: "Code não recebido" }, { status: 400 });
  }

  // 4-6. `state`: assinatura, versão, formato e expiração.
  const segredo = process.env.SESSION_SECRET;
  if (!segredo) {
    console.error("[callback ML] SESSION_SECRET ausente — não é possível verificar o state.");
    return erro(request, "configuracao_invalida");
  }
  const agora = agoraEmSegundos();
  const stateBruto = url.searchParams.get("state");
  const state = await verificarEstado(stateBruto, { segredo, agoraSegundos: agora });
  if (!state) {
    // `verificarEstado` não distingue expirado de adulterado, de
    // propósito. Só damos a pista mais útil quando ela não revela nada:
    // um payload legível e bem-assinado que apenas venceu.
    //
    // Num state expirado ainda conseguimos o challenge — e com ele o
    // cookie do PKCE daquela tentativa, que aproveitamos para limpar.
    const vencido = await estadoApenasExpirado(stateBruto, segredo, agora);
    return vencido
      ? erro(request, "state_expirado", vencido.chal)
      : erro(request, "state_invalido");
  }

  // 7. Binding: quem voltou é quem começou.
  if (state.uid !== userId) return erro(request, "state_invalido", state.chal);

  // 7b. PKCE — o cookie desta tentativa precisa existir e casar com o
  //     challenge que o `state` carrega. Isso impede parear o verifier de
  //     uma tentativa com o `state` de outra, e roda ANTES de gastar o
  //     `code`. Nenhum dos dois valores aparece em erro, log ou URL.
  const verifier = lerCookie(request, nomeCookiePkce(state.chal));
  if (!verifier) return erro(request, "pkce_cookie_ausente", state.chal);
  if (!(await verifierConfere(verifier, state.chal))) {
    return erro(request, "pkce_invalido", state.chal);
  }

  // 8-9. RECONNECT revalida a propriedade da loja ANTES de gastar o code.
  let lojaAlvo: { id: string; seller_id: string | null } | null = null;
  if (state.intent === "reconnect") {
    const { data, error } = await supabase
      .from("lojas")
      .select("id, seller_id")
      .eq("id", state.loja)
      .eq("user_id", userId)
      .eq("marketplace", "ML")
      .maybeSingle();

    if (error) {
      console.error("[callback ML] falha ao revalidar a loja:", error.message);
      return erro(request, "persistencia_falhou", state.chal);
    }
    if (!data) return erro(request, "loja_nao_pertence_usuario", state.chal);
    lojaAlvo = data as { id: string; seller_id: string | null };
  }

  // 10-11. Troca do code por token — SERVER-SIDE, nada disso sai daqui.
  const credencial = await trocarCodePorToken(code, verifier);
  if (!credencial) return erro(request, "token_exchange_falhou", state.chal);

  // 12-13. Quem autorizou?
  const identidade = await obterIdentidadeML(credencial.accessToken);
  if (!identidade) return erro(request, "identidade_falhou", state.chal);

  const expiraEm = new Date(Date.now() + credencial.expiresIn * 1000).toISOString();

  // ── 14-16. Escrita ────────────────────────────────────────────────
  if (state.intent === "reconnect") {
    // O seller que voltou tem de ser o da loja pretendida. Autorizar
    // outra conta NÃO transforma esta loja naquela conta.
    if ((lojaAlvo!.seller_id ?? "") !== identidade.sellerId) {
      return erro(request, "conta_ml_diferente", state.chal);
    }

    const gravou = await gravarCredencial(
      { id: lojaAlvo!.id, userId },
      credencial,
      identidade.nickname,
      expiraEm
    );
    if (gravou === "erro") return erro(request, "persistencia_falhou", state.chal);
    if (gravou === "vazio") return erro(request, "persistencia_falhou", state.chal);
    return sucesso(request, "reconnected", lojaAlvo!.id, state.chal);
  }

  // CONNECT. A busca é SEMPRE escopada pelo usuário: o mesmo seller pode
  // existir para outros donos (medido no banco: 3 donos distintos para o
  // mesmo seller) e para linhas órfãs. Nenhuma delas é alcançável daqui.
  const { data: proprias, error: erroBusca } = await supabase
    .from("lojas")
    .select("id")
    .eq("user_id", userId)
    .eq("marketplace", "ML")
    .eq("seller_id", identidade.sellerId);

  if (erroBusca) {
    console.error("[callback ML] falha ao buscar loja do usuário:", erroBusca.message);
    return erro(request, "persistencia_falhou", state.chal);
  }

  const linhas = proprias ?? [];

  // Duplicidade DENTRO do mesmo usuário: fail-closed. Escolher uma linha
  // arbitrariamente esconderia a inconsistência e gravaria credencial num
  // registro que talvez não seja o que a interface mostra.
  if (linhas.length > 1) return erro(request, "duplicidade_loja", state.chal);

  if (linhas.length === 1) {
    const gravou = await gravarCredencial(
      { id: linhas[0].id, userId },
      credencial,
      identidade.nickname,
      expiraEm
    );
    if (gravou !== "ok") return erro(request, "persistencia_falhou", state.chal);
    return sucesso(request, "connected", linhas[0].id, state.chal);
  }

  // Nenhuma linha própria: cria uma, sempre com o dono da sessão.
  const novaLinha: Record<string, unknown> = {
    marketplace: "ML",
    seller_id: identidade.sellerId,
    nickname: identidade.nickname,
    nome: identidade.nickname,
    access_token: credencial.accessToken,
    token_expires_at: expiraEm,
    ativo: true,
    user_id: userId,
  };
  // Ausência de refresh_token: a coluna é OMITIDA, nunca gravada como
  // null explícito. Ver o comentário de `gravarCredencial`.
  if (credencial.refreshToken) novaLinha.refresh_token = credencial.refreshToken;

  const { data: criada, error: erroInsert } = await supabase
    .from("lojas")
    .insert(novaLinha)
    .select("id");

  if (erroInsert) {
    console.error("[callback ML] falha ao criar a loja:", erroInsert.message);
    return erro(request, "persistencia_falhou", state.chal);
  }
  if (!criada || criada.length === 0) return erro(request, "persistencia_falhou", state.chal);

  return sucesso(request, "connected", criada[0].id, state.chal);
}

/** O Mercado Livre também chama por POST em algumas configurações. */
export async function POST(request: Request) {
  return GET(request);
}

// ────────────────────────────────────────────────────────────────────

interface CredencialML {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
}

/**
 * Troca `code` por token. Uma chamada, sem retry: o `code` é de uso
 * único, e repetir só produziria um segundo erro.
 *
 * Nada do corpo da resposta é logado — ele contém as duas credenciais.
 */
async function trocarCodePorToken(code: string, codeVerifier: string): Promise<CredencialML | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch("https://api.mercadolibre.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: process.env.ML_CLIENT_ID!.trim(),
        client_secret: process.env.ML_CLIENT_SECRET!.trim(),
        code,
        // Precisa ser IDÊNTICO ao usado na autorização — o Mercado Livre
        // recusa a troca se divergir, inclusive por uma barra final.
        redirect_uri: process.env.ML_REDIRECT_URI!.trim(),
        // PKCE: prova de que quem troca o code é quem iniciou o fluxo.
        // O `client_secret` CONTINUA sendo enviado — o app é confidencial,
        // e PKCE se soma a ele, não o substitui.
        code_verifier: codeVerifier,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      // Registra o CÓDIGO enumerado do erro (`invalid_client`,
      // `invalid_grant`, …), nunca o corpo bruto: ele pode trazer
      // `error_description` com conteúdo inesperado. Sem esse campo, a
      // investigação anterior ficou sem distinguir "credencial errada" de
      // "code/PKCE inválido" — foi o que mais custou tempo.
      console.error(`[callback ML] token endpoint respondeu ${res.status} · error=${await lerErroEnumerado(res)}`);
      return null;
    }
    const data = await res.json();
    if (!data?.access_token || typeof data.access_token !== "string") return null;
    return {
      accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === "string" && data.refresh_token ? data.refresh_token : null,
      expiresIn: Number.isFinite(data.expires_in) && data.expires_in > 0 ? data.expires_in : 21600,
    };
  } catch (e: any) {
    console.error("[callback ML] falha de comunicação na troca do code:", e?.name ?? "erro");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extrai SOMENTE o campo `error` de uma resposta de erro do OAuth, e só
 * se ele parecer um código enumerado (minúsculas e `_`, curto). Qualquer
 * outra coisa vira `"unknown"`.
 *
 * O corpo inteiro nunca é logado: além de `error_description` poder
 * trazer texto arbitrário, respostas de erro de OAuth não têm formato
 * garantido.
 */
async function lerErroEnumerado(res: Response): Promise<string> {
  try {
    const corpo: any = await res.json();
    const codigo = corpo?.error;
    return typeof codigo === "string" && /^[a-z_]{1,40}$/.test(codigo) ? codigo : "unknown";
  } catch {
    return "unknown";
  }
}

interface IdentidadeML {
  sellerId: string;
  nickname: string;
}

/** `GET /users/me` — quem autorizou. O token só aparece no header. */
async function obterIdentidadeML(accessToken: string): Promise<IdentidadeML | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch("https://api.mercadolibre.com/users/me", {
      headers: { Authorization: `Bearer ${accessToken}`, accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.error(`[callback ML] /users/me respondeu ${res.status}`);
      return null;
    }
    const me = await res.json();
    const sellerId = me?.id === undefined || me?.id === null ? "" : String(me.id);
    if (!sellerId) return null;
    return {
      sellerId,
      nickname: typeof me.nickname === "string" && me.nickname
        ? me.nickname
        : (typeof me.first_name === "string" && me.first_name ? me.first_name : "Loja ML"),
    };
  } catch (e: any) {
    console.error("[callback ML] falha de comunicação em /users/me:", e?.name ?? "erro");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Grava a credencial numa linha JÁ resolvida, sempre com `user_id` no
 * filtro da própria escrita — não numa checagem anterior que um refactor
 * possa remover. `.select("id")` torna o efeito observável: zero linhas
 * nunca vira sucesso.
 *
 * REFRESH TOKEN: quando o Mercado Livre não devolve um, a coluna NÃO
 * entra no update. Sobrescrever com `null` destruiria uma credencial de
 * longa duração ainda válida por causa de uma resposta que legitimamente
 * pode vir sem ela — é a mesma regra que `refreshMLToken` já aplica
 * (`data.refresh_token ?? refreshToken`) e que o relay aplicava.
 */
async function gravarCredencial(
  alvo: { id: string; userId: string },
  credencial: CredencialML,
  nickname: string,
  expiraEm: string
): Promise<"ok" | "vazio" | "erro"> {
  const atualizacao: Record<string, unknown> = {
    access_token: credencial.accessToken,
    token_expires_at: expiraEm,
    nickname,
    nome: nickname,
    ativo: true,
  };
  if (credencial.refreshToken) atualizacao.refresh_token = credencial.refreshToken;

  const { data, error } = await supabase
    .from("lojas")
    .update(atualizacao)
    .eq("id", alvo.id)
    .eq("user_id", alvo.userId)
    .select("id");

  if (error) {
    console.error("[callback ML] falha ao gravar a credencial:", error.message);
    return "erro";
  }
  return data && data.length > 0 ? "ok" : "vazio";
}

/**
 * O `state` é bem-formado e bem-assinado, e a ÚNICA coisa errada é ter
 * vencido? Serve só para escolher entre duas mensagens de UI.
 *
 * Reverifica com um instante no passado: se aí ele passa, o problema era
 * temporal. Qualquer outro defeito continua reprovando, então isto não
 * abre caminho para aceitar state inválido.
 */
async function estadoApenasExpirado(
  stateBruto: string | null,
  segredo: string,
  agora: number
) {
  if (!stateBruto) return null;
  return verificarEstado(stateBruto, {
    segredo,
    agoraSegundos: Math.max(1, agora - 24 * 60 * 60),
  });
}
