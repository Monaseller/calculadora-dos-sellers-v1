/**
 * Camada de autenticação da CDS — preparação do cutover (Fase 0, F0.c.2).
 *
 * ── ESTA CAMADA AINDA NÃO ESTÁ EM USO ───────────────────────────────
 * F0.c.2 entrega a peça e seus testes. Nada aqui é importado por login,
 * middleware, rotas ou `lib/session.ts`. Produção continua emitindo e
 * aceitando `cds_session` no formato antigo (UUID cru) até o cutover,
 * que é F0.c.3.
 *
 * ── O que esta camada é ─────────────────────────────────────────────
 * A ponte entre a requisição HTTP e a sessão assinada:
 *
 *     Request → cookie cds_session → verificarSessao() → uid
 *
 * Ela concentra as três coisas que `lib/sessao-assinada.ts` se recusa a
 * fazer, de propósito: ler o cookie, ler o segredo do ambiente e ler o
 * relógio. Aquele módulo é criptografia pura e testável; este é o ponto
 * único de contato com o mundo.
 *
 * ── A decisão central: impossibilitar o bypass por `await` esquecido ─
 * `verificarSessao` é assíncrona. Se esta camada devolvesse
 * `Promise<string | null>`, o padrão que existe hoje em 34 rotas
 *
 *     const userId = getUserId(request);
 *     if (!userId) return 401;
 *
 * compilaria sem `await` e **liberaria todo mundo** — uma Promise é
 * sempre truthy. Por isso o retorno é um OBJETO discriminado, nunca uma
 * string: qualquer uso real (`.autenticado`, `.uid`) sobre uma Promise
 * é erro de compilação. O esquecimento deixa de ser silencioso.
 *
 * ── Runtime ─────────────────────────────────────────────────────────
 * Edge-safe: nenhuma API exclusiva do Node. `process.env.SESSION_SECRET`
 * é acesso ESTÁTICO, que o Next resolve no build também para o Edge —
 * acesso dinâmico (`process.env[nome]`) não funcionaria lá.
 *
 * ── Fail-closed ─────────────────────────────────────────────────────
 * Segredo ausente ou curto demais **lança**. Nunca há degradação para
 * "aceita a sessão antiga": indisponibilidade é preferível a autenticar
 * sem verificar.
 */
import {
  verificarSessao,
  assinarSessao,
  DURACAO_PADRAO_SEGUNDOS,
  ErroConfiguracaoSessao,
} from "./sessao-assinada";

/** Nome do cookie. Não muda no cutover — só o conteúdo muda. */
export const COOKIE_SESSAO = "cds_session";

/** Duração do cookie e do token, sempre iguais. 7 dias fixos, sem renovação. */
export const DURACAO_SESSAO_SEGUNDOS = DURACAO_PADRAO_SEGUNDOS;

/**
 * Motivo da recusa. Existe para log e diagnóstico — **nunca** deve
 * chegar à resposta HTTP: para quem chama, 401 é 401.
 */
export type MotivoRecusa = "sem_cookie" | "token_invalido";

/**
 * Retorno deliberadamente NÃO-string. Ver o bloco sobre `await` acima.
 */
export type Autenticacao =
  | { autenticado: true; uid: string }
  | { autenticado: false; motivo: MotivoRecusa };

/** Instante de referência do sistema, em segundos. Ponto único. */
export function agoraEmSegundos(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Lê `SESSION_SECRET` do ambiente.
 *
 * Acesso estático e leitura em tempo de chamada (não no carregamento do
 * módulo), para que continue testável. A validação de tamanho mínimo
 * vive em `sessao-assinada.ts` — aqui só garantimos presença, e a
 * mensagem nunca inclui o valor.
 */
function obterSegredoSessao(): string {
  const segredo = process.env.SESSION_SECRET;
  if (!segredo) {
    throw new ErroConfiguracaoSessao(
      "SESSION_SECRET ausente no ambiente — autenticação não pode operar."
    );
  }
  return segredo;
}

/**
 * Extrai um cookie do header `Cookie`.
 *
 * Serve tanto para `Request` (rotas) quanto para `NextRequest`
 * (middleware) — os dois expõem `headers.get("cookie")`, então esta
 * camada não precisa de duas versões.
 *
 * Mais tolerante que o parser atual de `lib/session.ts`, que assume o
 * separador exato `"; "`.
 */
export function lerCookie(request: Request, nome: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const parte of header.split(";")) {
    const bruto = parte.trim();
    if (!bruto.startsWith(`${nome}=`)) continue;
    const valor = bruto.slice(nome.length + 1);
    return valor.length > 0 ? valor : null;
  }
  return null;
}

/**
 * Autentica uma requisição pelo cookie de sessão assinada.
 *
 * Devolve `{ autenticado: false }` para ausência, adulteração,
 * expiração, versão desconhecida e qualquer outro defeito do token —
 * incluindo, deliberadamente, o **formato antigo** (UUID cru) e o
 * legado `"1"`, que não são tokens assinados e portanto não passam.
 *
 * **Lança** apenas quando `SESSION_SECRET` está ausente ou inadequado.
 * É erro de configuração, e tem de ser barulhento.
 */
export async function autenticarRequisicao(
  request: Request,
  agoraSegundos: number = agoraEmSegundos()
): Promise<Autenticacao> {
  // O segredo é lido ANTES de olhar o cookie: configuração errada
  // precisa estourar mesmo quando não há cookie nenhum.
  const segredo = obterSegredoSessao();

  const token = lerCookie(request, COOKIE_SESSAO);
  if (!token) return { autenticado: false, motivo: "sem_cookie" };

  const sessao = await verificarSessao(token, { segredo, agoraSegundos });
  if (!sessao) return { autenticado: false, motivo: "token_invalido" };

  return { autenticado: true, uid: sessao.uid };
}

/**
 * Produz o token que o login vai colocar no cookie (a partir de F0.c.3).
 *
 * Devolve só o token e a duração — **não** monta a resposta nem seta
 * cookie. Quem faz isso é a rota de login, com `OPCOES_COOKIE_SESSAO`.
 */
export async function emitirTokenSessao(
  uid: string,
  agoraSegundos: number = agoraEmSegundos()
): Promise<{ token: string; maxAgeSegundos: number }> {
  const token = await assinarSessao(uid, {
    segredo: obterSegredoSessao(),
    agoraSegundos,
    duracaoSegundos: DURACAO_SESSAO_SEGUNDOS,
  });
  return { token, maxAgeSegundos: DURACAO_SESSAO_SEGUNDOS };
}

/**
 * Contrato do cookie no cutover.
 *
 * `secure` fica ligado só em produção porque o desenvolvimento local
 * roda em `http://localhost` — mesma regra já usada hoje pelo login e
 * pelos cookies de marketplace.
 *
 * `domain` **não** é definido de propósito: cookie host-only vale apenas
 * para o domínio que o emitiu, sem vazar para subdomínios.
 */
export const OPCOES_COOKIE_SESSAO = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/",
  maxAge: DURACAO_SESSAO_SEGUNDOS,
} as const;
