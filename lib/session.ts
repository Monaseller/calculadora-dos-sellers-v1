/** Lê o user UUID do cookie httpOnly cds_session */
export function getUserId(request: Request): string | null {
  const cookieHeader = request.headers.get("cookie") || "";
  const entry = cookieHeader.split("; ").find(c => c.startsWith("cds_session="));
  const val = entry ? entry.slice("cds_session=".length) : null;
  // Cookie antigo era "1" (single-tenant) — ignora
  if (!val || val === "1") return null;
  return val;
}
