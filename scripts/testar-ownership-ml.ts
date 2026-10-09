/**
 * Isolamento de propriedade de loja na resolução de credencial ML — testes de F0.c.4,
 * migrados na CDS V2 Fase 1B de `getMLToken` (REMOVIDO) para o substituto real,
 * `resolverContaML` (lib/ml-conexao.ts).
 *
 * ── A falha que estes testes fecham ─────────────────────────────────
 * `getMLToken` resolvia a loja apenas pelo cookie `loja_ativa_id` e
 * consultava `lojas` filtrando SÓ por `id`. Como cookie é dado do
 * cliente, um usuário autenticado que enviasse o id da loja de outro
 * recebia o **token de Mercado Livre alheio** — e, pelo caminho de
 * refresh, ainda **sobrescrevia os tokens daquela loja** no banco.
 * Na Fase 1B o cookie de token deixou de existir como credencial: a
 * credencial vem SÓ do banco, por loja validada (dono + marketplace + ativa).
 *
 * ── O que estes testes provam ───────────────────────────────────────
 * O CONTRATO DA CONSULTA, não só o retorno: o duplo do Supabase registra
 * cada `.eq()` aplicado, e os testes exigem que `id` E `user_id` estejam
 * presentes juntos. Um refactor futuro que remova o filtro de dono
 * quebra aqui, mesmo que o retorno continue igual.
 *
 * Nenhum token real é usado ou impresso — os valores são placeholders.
 * Sem rede, sem banco, sem credencial.
 *
 * Uso: npx tsx scripts/testar-ownership-ml.ts
 */
// Antes de qualquer módulo de `lib/`: a capability de credenciais é
// marcada com `server-only`, que lança fora da condição `react-server`.
// O duplo de `@supabase/supabase-js` instalado abaixo encadeia sobre este.
import "./_server-only-inerte";
import Module from "node:module";

let ok = 0, falhou = 0;
let fila: Promise<void> = Promise.resolve();
function t(nome: string, fn: () => void | Promise<void>) {
  fila = fila.then(async () => {
    try { await fn(); ok++; console.log(`  PASS  ${nome}`); }
    catch (e: any) { falhou++; console.log(`  FALHA ${nome} -> ${e?.message ?? e}`); }
  });
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder-de-teste.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "chave-de-teste-invalida";
// PR #1: a leitura de credencial passou a usar o cliente privilegiado
// (`getSupabaseServidor`), que é FAIL-CLOSED e lança se a variável faltar.
// O duplo instalado abaixo intercepta `@supabase/supabase-js`, então o
// cliente devolvido continua sendo o falso — esta variável só precisa
// existir para a guarda não abortar antes disso. Valor deliberadamente
// inválido para tráfego real.
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "chave-de-teste-invalida";
process.env.ML_CLIENT_ID ??= "ficticio";
process.env.ML_CLIENT_SECRET ??= "ficticio";

// ── Banco de mentira, com as lojas do cenário ────────────────────────
const UID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LOJA_A = "11111111-1111-4111-8111-111111111111"; // dono: A
const LOJA_B = "22222222-2222-4222-8222-222222222222"; // dono: B
const LOJA_ORFA = "33333333-3333-4333-8333-333333333333"; // user_id NULL
const LOJA_SHOPEE_A = "44444444-4444-4444-8444-444444444444"; // dono A, Shopee

const DAQUI_A_UMA_HORA = new Date(Date.now() + 3600_000).toISOString();
const VENCIDO = new Date(Date.now() - 3600_000).toISOString();

/** Nunca um token real — só marcadores para o teste distinguir a origem. */
const LINHAS = [
  { id: LOJA_A, user_id: UID_A, marketplace: "ML", ativo: true, nickname: "A", seller_id: "111", access_token: "<token-da-loja-A>", refresh_token: "<refresh-A>", token_expires_at: DAQUI_A_UMA_HORA },
  { id: LOJA_B, user_id: UID_B, marketplace: "ML", ativo: true, nickname: "B", seller_id: "222", access_token: "<token-da-loja-B>", refresh_token: "<refresh-B>", token_expires_at: VENCIDO },
  { id: LOJA_ORFA, user_id: null, marketplace: "ML", ativo: true, nickname: "O", seller_id: "333", access_token: "<token-orfa>", refresh_token: null, token_expires_at: DAQUI_A_UMA_HORA },
  { id: LOJA_SHOPEE_A, user_id: UID_A, marketplace: "Shopee", ativo: true, nickname: "S", seller_id: "444", access_token: "<token-shopee-A>", refresh_token: null, token_expires_at: DAQUI_A_UMA_HORA },
];

/** Toda consulta feita pelo código sob teste, para auditoria do contrato. */
interface ConsultaRegistrada { tabela: string; filtros: Record<string, unknown>; tipo: "select" | "update" }
let consultas: ConsultaRegistrada[] = [];

function clienteFalso() {
  const criarCadeia = (tabela: string) => {
    const filtros: Record<string, unknown> = {};
    let tipo: "select" | "update" = "select";
    const casa = () => LINHAS.filter(l => Object.entries(filtros).every(([c, v]) => (l as any)[c] === v));
    const cadeia: any = {
      select: () => cadeia,
      order: () => cadeia,
      limit: () => cadeia,
      update: () => { tipo = "update"; return cadeia; },
      eq: (col: string, val: unknown) => { filtros[col] = val; return cadeia; },
      maybeSingle: async () => {
        consultas.push({ tabela, filtros, tipo });
        return { data: casa()[0] ?? null, error: null };
      },
      then: (resolve: any) => {
        consultas.push({ tabela, filtros, tipo });
        resolve(tipo === "select" ? { data: casa(), error: null } : { data: [], error: null });
      },
    };
    return cadeia;
  };
  return { from: (tabela: string) => criarCadeia(tabela) };
}

const requireOriginal = (Module as any).prototype.require;
(Module as any).prototype.require = function (id: string) {
  if (id === "@supabase/supabase-js") return { createClient: () => clienteFalso() };
  return requireOriginal.apply(this, arguments as any);
};

// O refresh do ML é rede: proibido aqui. Se algum caminho tentar renovar, o teste vê.
let chamadasDeRede = 0;
globalThis.fetch = (async () => { chamadasDeRede++; return { ok: false, status: 400, json: async () => ({}) } as any; }) as any;

type Resultado = { ok: true; lojaId: string; accessToken: string } | { ok: false; motivo: string };
let resolver: (userId: string, lojaId?: string | null, opcoes?: { permitirUnica?: boolean }) => Promise<Resultado>;

async function principal() {
const M = await import("../lib/ml-conexao");
resolver = M.resolverContaML as any;
const auth = await import("../lib/ml-auth");

console.log("\n[1. matriz de propriedade]");

t("1. Usuário A + Loja A -> PERMITIDO, com o token da própria loja", async () => {
  consultas = [];
  const r = await resolver(UID_A, LOJA_A);
  assert(r.ok, "usuário legítimo foi bloqueado");
  assert(r.ok && r.accessToken === "<token-da-loja-A>", `token errado: ${JSON.stringify(r)}`);
  assert(r.ok && r.lojaId === LOJA_A, "lojaId divergente");
});

t("2. Usuário A + Loja B -> NEGADO (o ataque)", async () => {
  const r = await resolver(UID_A, LOJA_B);
  assert(!r.ok, `VAZAMENTO: recebeu ${JSON.stringify(r)}`);
});

t("3. Usuário B + Loja B -> a própria loja de B é a resolvida (token vencido e refresh recusado => reconectar, nunca outra loja)", async () => {
  const r = await resolver(UID_B, LOJA_B);
  assert(!r.ok && r.motivo === "PRECISA_RECONECTAR", `esperado PRECISA_RECONECTAR da própria loja, veio ${JSON.stringify(r)}`);
});

t("4. Usuário B + Loja A -> NEGADO (simétrico)", async () => {
  const r = await resolver(UID_B, LOJA_A);
  assert(!r.ok && r.motivo === "LOJA_INVALIDA", `VAZAMENTO: recebeu ${JSON.stringify(r)}`);
});

console.log("\n[2. casos de borda]");

t("5. loja inexistente -> NEGADO", async () => {
  const r = await resolver(UID_A, "99999999-9999-4999-8999-999999999999");
  assert(!r.ok && r.motivo === "LOJA_INVALIDA", "loja inexistente foi aceita");
});

t("6. loja ÓRFÃ (user_id NULL) -> NEGADO — comportamento definido", async () => {
  // Decisão de F0.c.4: loja sem dono não pertence a ninguém, então
  // nenhum usuário autenticado a alcança por este caminho.
  const r = await resolver(UID_A, LOJA_ORFA);
  assert(!r.ok, "loja órfã foi alcançada por um usuário");
});

t("7. loja do PRÓPRIO usuário, mas de outro marketplace -> NEGADO", async () => {
  const r = await resolver(UID_A, LOJA_SHOPEE_A);
  assert(!r.ok && r.motivo === "LOJA_INVALIDA", "loja Shopee foi usada como loja ML");
});

t("8. userId ausente -> NEGADO, sem nem consultar o banco", async () => {
  consultas = [];
  const r = await resolver("", LOJA_A);
  assert(!r.ok, "userId vazio foi aceito");
  assert(consultas.length === 0, "consultou o banco sem usuário autenticado");
});

t("9. lojaId malformado -> NEGADO, sem consultar o banco", async () => {
  for (const mau of ["nao-e-uuid", "1", "'; DROP TABLE lojas;--", LOJA_A + "x"]) {
    consultas = [];
    const r = await resolver(UID_A, mau);
    assert(!r.ok, `id malformado aceito: ${mau}`);
    assert(consultas.length === 0, `id malformado chegou ao banco: ${mau}`);
  }
});

console.log("\n[3. contrato da consulta — o que o refactor não pode perder]");

t("10. a consulta de resolução filtra por id E user_id (e marketplace), juntos", async () => {
  consultas = [];
  await resolver(UID_A, LOJA_A);
  const resolucao = consultas.find(c => c.tabela === "lojas" && c.tipo === "select");
  assert(!!resolucao, "nenhuma consulta a `lojas` foi registrada");
  assert(resolucao!.filtros.id === LOJA_A, "consulta sem filtro de id");
  assert(resolucao!.filtros.user_id === UID_A, "🔴 consulta SEM filtro de user_id — a falha voltou");
  assert(resolucao!.filtros.marketplace === "ML", "consulta sem filtro de marketplace");
});

t("11. TODA consulta a `lojas` nesta função carrega user_id", async () => {
  consultas = [];
  await resolver(UID_A, LOJA_A);
  await resolver(UID_A, null, { permitirUnica: true });
  const semDono = consultas.filter(c => c.tabela === "lojas" && c.tipo === "select" && !("user_id" in c.filtros));
  assert(semDono.length === 0,
    `consulta a lojas sem user_id: ${JSON.stringify(semDono)}`);
});

t("12. a credencial vem SÓ do banco, por loja validada — não há entrada de token do cliente", async () => {
  // Fase 1B: a função não recebe Request/cookie. Loja alheia continua negada.
  const r = await resolver(UID_A, LOJA_B);
  assert(!r.ok, "loja alheia resolvida");
  const proprio = await resolver(UID_A, LOJA_A);
  assert(proprio.ok && proprio.accessToken === "<token-da-loja-A>", "token não veio do banco");
});

t("13. sem loja selecionada: a ÚNICA só com opt-in explícito; sem opt-in -> LOJA_NAO_DEFINIDA", async () => {
  // Antes: "o atalho do cookie de token continua funcionando" — comportamento REMOVIDO na Fase 1B.
  const comOptIn = await resolver(UID_A, null, { permitirUnica: true });
  assert(comOptIn.ok && comOptIn.lojaId === LOJA_A, `opt-in não resolveu a única: ${JSON.stringify(comOptIn)}`);
  const semOptIn = await resolver(UID_A, null);
  assert(!semOptIn.ok && semOptIn.motivo === "LOJA_NAO_DEFINIDA", `sem opt-in escolheu sozinho: ${JSON.stringify(semOptIn)}`);
});

t("14. escrita de token nunca mira loja não validada", async () => {
  // Loja alheia (B, de token vencido) pedida por A: nem chega a renovar nem a gravar.
  consultas = []; chamadasDeRede = 0;
  await resolver(UID_A, LOJA_B);
  const escritas = consultas.filter(c => c.tipo === "update");
  assert(escritas.length === 0 && chamadasDeRede === 0, `gravou/renovou loja alheia: ${JSON.stringify(escritas)} rede=${chamadasDeRede}`);
});

console.log("\n[4. contrato da API]");

t("15. os helpers de cookie de token não existem mais (getMLToken, applyMLCookies)", () => {
  assert(!("getMLToken" in auth) && !("applyMLCookies" in auth), "helper de cookie de token voltou a ser exportado");
});

t("16. nenhum token real aparece nos dados de teste", () => {
  const texto = JSON.stringify(LINHAS);
  assert(!/APP_USR|TG-|Bearer /i.test(texto), "placeholder parece token real");
  assert(texto.includes("<token-da-loja-A>"), "os dados de teste deveriam usar marcadores");
});

  await fila;
  console.log(`\n=== RESULTADO: ${ok} passaram, ${falhou} falharam ===\n`);
  if (falhou > 0) process.exit(1);
}

void principal();
