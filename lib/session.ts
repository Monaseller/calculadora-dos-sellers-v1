/**
 * Lê o user UUID do cookie httpOnly cds_session.
 *
 * ── Endurecimento de formato (Fase 0, F0.c.2.5) ─────────────────────
 * Só um UUID canônico conta como sessão. Qualquer outro conteúdo do
 * cookie devolve `null`, e a rota responde 401 pelo caminho normal.
 *
 * **Isto NÃO é dupla aceitação.** É o contrário: o mecanismo V1 passa a
 * aceitar estritamente o único formato que ele mesmo emite hoje. Nenhum
 * token assinado é entendido aqui — ao contrário, é justamente o que
 * esta validação recusa.
 *
 * Por que agora, antes do cutover: se um dia a sessão assinada for
 * revertida, os navegadores ainda terão o token novo no cookie. Sem esta
 * checagem, `getUserId` devolveria a string inteira como se fosse um
 * `user_id`, ela chegaria ao Postgres como UUID inválido e o usuário
 * veria **500** em vez de "faça login de novo". Com ela, o desfecho é um
 * 401 limpo e o fluxo normal de login.
 *
 * Compatível com a produção atual por construção: o cookie emitido hoje
 * já é exatamente um UUID canônico, então nenhuma sessão válida muda de
 * comportamento.
 *
 * Nunca lança — entrada malformada é `null`, nunca exceção.
 */
const UUID_CANONICO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function getUserId(request: Request): string | null {
  const cookieHeader = request.headers.get("cookie") || "";
  const entry = cookieHeader.split("; ").find(c => c.startsWith("cds_session="));
  const val = entry ? entry.slice("cds_session=".length) : null;
  // Cookie antigo era "1" (single-tenant) — ignora
  if (!val || val === "1") return null;
  if (!UUID_CANONICO.test(val)) return null;
  return val;
}
