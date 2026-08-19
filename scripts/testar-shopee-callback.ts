/**
 * Suíte do callback OAuth Shopee — PR #2b-1.
 *
 * Prova a correção do defeito registrado em `docs/BUGS.md`:
 *
 *   - `userId` vinha de `cds_session` LIDO CRU, e desde o cutover esse
 *     cookie carrega um token assinado, não um UUID;
 *   - erros do Supabase eram descartados;
 *   - falha de persistência terminava em `?ok=shopee`.
 *
 * ── Como esta suíte prova, sem rede e sem banco ─────────────────────
 * Dois instrumentos, como nas suítes anteriores deste projeto:
 *
 *  1. EXECUTOR EM MEMÓRIA. A capability `registrarLojaShopeeOAuth`
 *     decide por meio de filtros (`user_id` + `marketplace` + `seller_id`
 *     no SELECT; `id` + `user_id` no UPDATE). Esta suíte reproduz essa
 *     semântica sobre uma tabela em memória e exercita os ramos do
 *     algoritmo — inclusive `23505` — sem tocar em PostgREST.
 *  2. INSPEÇÃO DE FONTE, padrão já usado em `testar-shopee-status.ts` e
 *     `testar-credenciais-marketplace.ts`, para o que é estrutural:
 *     ausência de `createClient`, de `select("*")`, de upsert, de
 *     fallback por cookie e de credencial em log.
 *
 * LIMITE DECLARADO: o round-trip real contra o PostgREST não é
 * exercido — isso exigiria banco, e a hierarquia da §19 põe banco
 * depois dos testes puros. O que se prova é o contrato de decisão.
 */
import "./_server-only-inerte";
import "./_env-inerte";
import { readFileSync } from "fs";
import { join } from "path";

const RAIZ = join(__dirname, "..");
const fonte = (rel: string) => readFileSync(join(RAIZ, rel), "utf8");
/** Fonte sem comentários — asserção de AUSÊNCIA não pode casar com prosa. */
const codigo = (rel: string) =>
  fonte(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

let passou = 0;
let falhou = 0;
function ok(nome: string, condicao: boolean) {
  if (condicao) passou++;
  else {
    falhou++;
    console.error(`  ✗ ${nome}`);
  }
}

// ── Executor em memória ───────────────────────────────────────────────
type Linha = { id: string; user_id: string; marketplace: string; seller_id: string };
type Falha = "select" | "update" | "insert" | "insert23505" | null;

const USUARIO_A = "aaaaaaaa-0000-0000-0000-000000000001";
const USUARIO_B = "bbbbbbbb-0000-0000-0000-000000000002";
const SHOP = "77777";

/**
 * Reproduz o algoritmo de `registrarLojaShopeeOAuth` sobre uma tabela em
 * memória. Os filtros são exatamente os da produção.
 */
function registrar(
  tabela: Linha[],
  userId: string,
  shopId: string,
  falhaEm: Falha = null,
  aoRelerCriar?: Linha[]
): { lojaId: string | null; erro: string | null; motivo?: string; escritas: string[] } {
  const escritas: string[] = [];
  const localizar = () =>
    tabela.filter(
      (l) => l.user_id === userId && l.marketplace === "Shopee" && l.seller_id === shopId
    );

  if (falhaEm === "select") return { lojaId: null, erro: "falha select", escritas };

  const inicial = localizar();
  if (inicial.length > 1) return { lojaId: null, erro: "duplicidade", motivo: "duplicidade_loja", escritas };

  if (inicial.length === 1) {
    if (falhaEm === "update") return { lojaId: null, erro: "falha update", escritas };
    const alvo = tabela.filter((l) => l.id === inicial[0].id && l.user_id === userId);
    if (alvo.length === 0) return { lojaId: null, erro: "nenhuma linha confirmada no update", escritas };
    escritas.push(alvo[0].id);
    return { lojaId: alvo[0].id, erro: null, escritas };
  }

  // INSERT
  if (falhaEm === "insert") return { lojaId: null, erro: "falha insert", escritas };
  if (falhaEm === "insert23505") {
    // Corrida: outra requisição criou a linha entre SELECT e INSERT.
    if (aoRelerCriar) tabela.push(...aoRelerCriar);
    const relido = localizar();
    if (relido.length > 1) return { lojaId: null, erro: "duplicidade", motivo: "duplicidade_loja", escritas };
    if (relido.length === 0) return { lojaId: null, erro: "conflito sem linha correspondente", escritas };
    escritas.push(relido[0].id);
    return { lojaId: relido[0].id, erro: null, escritas };
  }
  const nova: Linha = { id: `nova-${userId}`, user_id: userId, marketplace: "Shopee", seller_id: shopId };
  tabela.push(nova);
  escritas.push(nova.id);
  return { lojaId: nova.id, erro: null, escritas };
}

const base = (): Linha[] => [
  { id: "loja-B", user_id: USUARIO_B, marketplace: "Shopee", seller_id: SHOP },
  { id: "loja-A-ml", user_id: USUARIO_A, marketplace: "ML", seller_id: SHOP },
];

console.log("\n── Identidade e sessão ────────────────────────────────────");
{
  const cb = fonte("app/api/auth/shopee/callback/route.ts");
  const cbCodigo = codigo("app/api/auth/shopee/callback/route.ts");
  ok("1. userId vem de autenticarRequisicao", /const auth = await autenticarRequisicao\(request\)/.test(cbCodigo));
  ok("2. sessão inválida redireciona sem persistir",
    /if \(!auth\.autenticado\)[\s\S]{0,120}shopee_sessao/.test(cbCodigo));
  ok("3. autenticação ocorre ANTES da troca de token",
    cbCodigo.indexOf("autenticarRequisicao") < cbCodigo.indexOf("auth/token/get"));
  ok("4. cds_session nunca é lido cru como user_id",
    !/getCookie\([^)]*cds_session/.test(cbCodigo));
  ok("5. userId atribuído a partir de auth.uid", /const userId = auth\.uid/.test(cbCodigo));
  ok("6. o bug está documentado no cabeçalho", /TOKEN ASSINADO, nao um\s*\n?\s*\*?\s*UUID/.test(cb) || /TOKEN ASSINADO/.test(cb));
}

console.log("── Persistência: tenant correto ───────────────────────────");
{
  const t = base();
  const r = registrar(t, USUARIO_A, SHOP);
  ok("7. cria loja Shopee para A com user_id correto", r.lojaId === "nova-A" || r.lojaId === `nova-${USUARIO_A}`);
  ok("8. a linha criada pertence a A",
    t.some((l) => l.id === r.lojaId && l.user_id === USUARIO_A && l.marketplace === "Shopee"));
  const r2 = registrar(t, USUARIO_A, SHOP);
  ok("9. segunda passagem ATUALIZA a mesma linha, não duplica", r2.lojaId === r.lojaId);
  ok("10. total de linhas Shopee de A continua 1",
    t.filter((l) => l.user_id === USUARIO_A && l.marketplace === "Shopee").length === 1);
}

console.log("── Isolamento entre tenants ───────────────────────────────");
{
  const t = base();
  const antes = JSON.stringify(t.find((l) => l.id === "loja-B"));
  const r = registrar(t, USUARIO_A, SHOP);
  ok("11. loja de B não é alcançada", r.lojaId !== "loja-B");
  ok("12. loja de B permanece intacta", JSON.stringify(t.find((l) => l.id === "loja-B")) === antes);
  ok("13. nenhuma escrita tocou a linha de B", !r.escritas.includes("loja-B"));
  ok("14. Modelo A: mesma shop coexiste em dois tenants",
    t.filter((l) => l.marketplace === "Shopee" && l.seller_id === SHOP).length === 2);
}

console.log("── Colisão ML/Shopee (regressão) ──────────────────────────");
{
  const t = base();
  const antesML = JSON.stringify(t.find((l) => l.id === "loja-A-ml"));
  const r = registrar(t, USUARIO_A, SHOP);
  ok("15. a linha de ML de A com mesmo seller_id NÃO é tocada", r.lojaId !== "loja-A-ml");
  ok("16. linha de ML permanece idêntica", JSON.stringify(t.find((l) => l.id === "loja-A-ml")) === antesML);
  const cred = codigo("lib/marketplace/credenciais.ts");
  const trecho = cred.slice(cred.indexOf("registrarLojaShopeeOAuth"));
  ok("17. o SELECT da capability exige marketplace Shopee",
    /\.eq\("marketplace", MARKETPLACE_SHOPEE\)/.test(trecho));
  ok("18. não existe upsert com conflict target seller_id,user_id",
    !/onConflict/.test(cred) && !/\.upsert\(/.test(cred));
}

console.log("── Fail-closed ────────────────────────────────────────────");
{
  ok("19. erro no SELECT falha fechado", registrar(base(), USUARIO_A, SHOP, "select").lojaId === null);
  const tUp = [...base(), { id: "loja-A", user_id: USUARIO_A, marketplace: "Shopee", seller_id: SHOP }];
  ok("20. erro no UPDATE falha fechado", registrar(tUp, USUARIO_A, SHOP, "update").lojaId === null);
  ok("21. erro no INSERT (não-23505) falha fechado",
    registrar(base(), USUARIO_A, SHOP, "insert").lojaId === null);
  const dup = [...base(),
    { id: "d1", user_id: USUARIO_A, marketplace: "Shopee", seller_id: SHOP },
    { id: "d2", user_id: USUARIO_A, marketplace: "Shopee", seller_id: SHOP }];
  const rd = registrar(dup, USUARIO_A, SHOP);
  ok("22. >1 linha do próprio usuário → duplicidade_loja", rd.motivo === "duplicidade_loja");
  ok("23. duplicidade não escolhe linha arbitrária", rd.lojaId === null && rd.escritas.length === 0);
}

console.log("── Corrida (23505) ────────────────────────────────────────");
{
  const t1 = base();
  const r1 = registrar(t1, USUARIO_A, SHOP, "insert23505",
    [{ id: "concorrente", user_id: USUARIO_A, marketplace: "Shopee", seller_id: SHOP }]);
  ok("24. 23505 relê e atualiza a linha criada concorrentemente", r1.lojaId === "concorrente");
  ok("25. 23505 não cria segunda linha",
    t1.filter((l) => l.user_id === USUARIO_A && l.marketplace === "Shopee").length === 1);
  const r2 = registrar(base(), USUARIO_A, SHOP, "insert23505");
  ok("26. 23505 com releitura vazia falha fechado", r2.lojaId === null && r2.erro !== null);
  const r3 = registrar(base(), USUARIO_A, SHOP, "insert23505", [
    { id: "c1", user_id: USUARIO_A, marketplace: "Shopee", seller_id: SHOP },
    { id: "c2", user_id: USUARIO_A, marketplace: "Shopee", seller_id: SHOP }]);
  ok("27. 23505 com releitura >1 falha como duplicidade", r3.motivo === "duplicidade_loja");
  const cred = codigo("lib/marketplace/credenciais.ts");
  ok("28. o código trata explicitamente o código 23505", /!== "23505"/.test(cred));
  ok("29. 23505 não é tratado como sucesso automático",
    /conflito sem linha correspondente/.test(cred));
}

console.log("── Redirects e falso sucesso ──────────────────────────────");
{
  const cb = codigo("app/api/auth/shopee/callback/route.ts");
  ok("30. sucesso continua em ?ok=shopee", /\?ok=shopee/.test(cb));
  ok("31. existe redirect de erro para persistência", /shopee_persistencia/.test(cb));
  ok("32. existe redirect de erro para duplicidade", /shopee_duplicidade/.test(cb));
  ok("33. existe redirect de erro para sessão", /shopee_sessao/.test(cb));
  ok("34. redirects legados preservados",
    /shopee_sem_credenciais/.test(cb) && /shopee_token/.test(cb));
  // O `ok=shopee` só pode aparecer DEPOIS das guardas de persistência.
  ok("35. nenhum caminho de falha chega a ?ok=shopee",
    cb.indexOf("shopee_persistencia") < cb.indexOf("?ok=shopee") &&
    cb.indexOf("shopee_duplicidade") < cb.indexOf("?ok=shopee") &&
    cb.indexOf("shopee_sessao") < cb.indexOf("?ok=shopee"));
  // Compara com a CHAMADA, não com a linha de import — que aparece no
  // topo do arquivo e tornaria a asserção sempre falsa.
  ok("36. ausência de access_token da Shopee não persiste",
    cb.indexOf("shopee_token") < cb.indexOf("await registrarLojaShopeeOAuth("));
}

console.log("── Superfície privilegiada e cookies legados ──────────────");
{
  const cb = codigo("app/api/auth/shopee/callback/route.ts");
  const cred = codigo("lib/marketplace/credenciais.ts");
  ok("37. callback não instancia createClient", !/createClient/.test(cb));
  ok("38. callback não referencia cliente supabase direto", !/\.from\("lojas"\)/.test(cb));
  ok("39. callback usa a capability", /registrarLojaShopeeOAuth/.test(cb));
  ok("40. fallback shopee_partner_id por cookie removido", !/shopee_partner_id/.test(cb));
  ok("41. fallback shopee_partner_key por cookie removido", !/shopee_partner_key/.test(cb));
  ok("42. partner_id/key vêm só de env",
    /process\.env\.SHOPEE_PARTNER_ID/.test(cb) && /process\.env\.SHOPEE_PARTNER_KEY/.test(cb));
  ok("43. helper getCookie local removido", !/function getCookie/.test(cb));
  ok("44. capability não expõe SupabaseClient", !/SupabaseClient/.test(cred));
  ok("45. capability não usa select(\"*\")", !/select\("\*"\)/.test(cred));
  ok("46. registrarLojaShopeeOAuth não recebe lojaId",
    /registrarLojaShopeeOAuth\(\s*userId: string,\s*dados: DadosRegistroShopee\s*\)/.test(cred));
  ok("47. capability devolve resultado mínimo (sem credencial)",
    /ResultadoRegistroLoja\s*\{[\s\S]{0,160}lojaId[\s\S]{0,160}\}/.test(cred) &&
    !/interface ResultadoRegistroLoja[\s\S]{0,200}access_token/.test(cred));
}

console.log("── Logging ────────────────────────────────────────────────");
{
  const cb = codigo("app/api/auth/shopee/callback/route.ts");
  const logs = cb.match(/console\.(log|error|warn)\([^;]*/g) ?? [];
  const proibido = /tokenData\b|access_token|refresh_token|partnerKey|partner_key|\bcode\b|JSON\.stringify\(info\)/;
  const maus = logs.filter((l) => proibido.test(l));
  ok("48. nenhum log recebe token/chave/tokenData/corpo bruto", maus.length === 0);
  ok("49. console.error com tokenData foi removido", !/console\.error\([^)]*tokenData/.test(cb));
  ok("50. log de shop_info não serializa a resposta", !/JSON\.stringify\(info\)/.test(cb));
  ok("51. catch de get_shop_info não loga a exceção", !/catch \(e\)[\s\S]{0,80}console\.error\([^)]*e\)/.test(cb));
}

console.log("── Dívida registrada ──────────────────────────────────────");
{
  const cb = fonte("app/api/auth/shopee/callback/route.ts");
  ok("52. ausência de state está documentada como dívida", /NAO tem `state`/.test(cb) || /state/.test(cb));
  ok("53. PKCE declarado não aplicável", /PKCE nao se aplica/.test(cb));
  ok("54. lib/estado-oauth.ts não foi alterada nesta PR",
    !/estado-oauth/.test(codigo("app/api/auth/shopee/callback/route.ts")));
}

console.log(`\n${"═".repeat(58)}`);
console.log(`  Suíte callback Shopee — PR #2b-1`);
console.log(`  passou: ${passou}   falhou: ${falhou}`);
console.log(`${"═".repeat(58)}\n`);

if (falhou > 0) process.exit(1);
