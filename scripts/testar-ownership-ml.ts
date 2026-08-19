/**
 * Isolamento de propriedade de loja no `getMLToken` — testes de F0.c.4.
 *
 * ── A falha que estes testes fecham ─────────────────────────────────
 * `getMLToken` resolvia a loja apenas pelo cookie `loja_ativa_id` e
 * consultava `lojas` filtrando SÓ por `id`. Como cookie é dado do
 * cliente, um usuário autenticado que enviasse o id da loja de outro
 * recebia o **token de Mercado Livre alheio** — e, pelo caminho de
 * refresh, ainda **sobrescrevia os tokens daquela loja** no banco.
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

// ── Banco de mentira, com as duas lojas do cenário ───────────────────
const UID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LOJA_A = "11111111-1111-4111-8111-111111111111"; // dono: A
const LOJA_B = "22222222-2222-4222-8222-222222222222"; // dono: B
const LOJA_ORFA = "33333333-3333-4333-8333-333333333333"; // user_id NULL
const LOJA_SHOPEE_A = "44444444-4444-4444-8444-444444444444"; // dono A, Shopee

const DAQUI_A_UMA_HORA = new Date(Date.now() + 3600_000).toISOString();

/** Nunca um token real — só marcadores para o teste distinguir a origem. */
const LINHAS = [
  { id: LOJA_A, user_id: UID_A, marketplace: "ML", access_token: "<token-da-loja-A>", refresh_token: "<refresh-A>", token_expires_at: DAQUI_A_UMA_HORA },
  { id: LOJA_B, user_id: UID_B, marketplace: "ML", access_token: "<token-da-loja-B>", refresh_token: "<refresh-B>", token_expires_at: DAQUI_A_UMA_HORA },
  { id: LOJA_ORFA, user_id: null, marketplace: "ML", access_token: "<token-orfa>", refresh_token: null, token_expires_at: DAQUI_A_UMA_HORA },
  { id: LOJA_SHOPEE_A, user_id: UID_A, marketplace: "Shopee", access_token: "<token-shopee-A>", refresh_token: null, token_expires_at: DAQUI_A_UMA_HORA },
];

/** Toda consulta feita pelo código sob teste, para auditoria do contrato. */
interface ConsultaRegistrada { tabela: string; filtros: Record<string, unknown>; tipo: "select" | "update" }
let consultas: ConsultaRegistrada[] = [];

function clienteFalso() {
  const criarCadeia = (tabela: string) => {
    const filtros: Record<string, unknown> = {};
    let tipo: "select" | "update" = "select";
    const cadeia: any = {
      select: () => cadeia,
      update: () => { tipo = "update"; return cadeia; },
      eq: (col: string, val: unknown) => { filtros[col] = val; return cadeia; },
      maybeSingle: async () => {
        consultas.push({ tabela, filtros, tipo });
        const achada = LINHAS.find(l =>
          Object.entries(filtros).every(([c, v]) => (l as any)[c] === v)
        );
        return { data: achada ?? null, error: null };
      },
      // `update(...).eq(...)` é aguardado sem maybeSingle
      then: (resolve: any) => { consultas.push({ tabela, filtros, tipo }); resolve({ data: null, error: null }); },
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

/**
 * Importado dinamicamente DENTRO de `principal()`: o módulo precisa ser
 * carregado depois de o duplo do Supabase estar instalado, e `tsx` não
 * aceita `await` no topo do arquivo.
 */
let getMLToken: (req: Request, userId: string) => Promise<{ token: string; lojaId?: string } | null>;

/** Requisição com os cookies que o cliente controla. */
function req(cookies: Record<string, string>) {
  const valor = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  return new Request("https://exemplo.test/api/ml/qualquer",
    valor ? { headers: { cookie: valor } } : undefined);
}

async function principal() {
({ getMLToken } = await import("../lib/ml-auth"));

console.log("\n[1. matriz de propriedade]");

t("1. Usuário A + Loja A -> PERMITIDO, com o token da própria loja", async () => {
  consultas = [];
  const r = await getMLToken(req({ loja_ativa_id: LOJA_A }), UID_A);
  assert(r !== null, "usuário legítimo foi bloqueado");
  assert(r!.token === "<token-da-loja-A>", `token errado: ${r!.token}`);
  assert(r!.lojaId === LOJA_A, "lojaId divergente");
});

t("2. Usuário A + Loja B -> NEGADO (o ataque)", async () => {
  const r = await getMLToken(req({ loja_ativa_id: LOJA_B }), UID_A);
  assert(r === null, `VAZAMENTO: recebeu ${JSON.stringify(r)}`);
});

t("3. Usuário B + Loja B -> PERMITIDO", async () => {
  const r = await getMLToken(req({ loja_ativa_id: LOJA_B }), UID_B);
  assert(r !== null && r.token === "<token-da-loja-B>", "usuário legítimo foi bloqueado");
});

t("4. Usuário B + Loja A -> NEGADO (simétrico)", async () => {
  const r = await getMLToken(req({ loja_ativa_id: LOJA_A }), UID_B);
  assert(r === null, `VAZAMENTO: recebeu ${JSON.stringify(r)}`);
});

console.log("\n[2. casos de borda]");

t("5. loja inexistente -> NEGADO", async () => {
  const r = await getMLToken(req({ loja_ativa_id: "99999999-9999-4999-8999-999999999999" }), UID_A);
  assert(r === null, "loja inexistente foi aceita");
});

t("6. loja ÓRFÃ (user_id NULL) -> NEGADO — comportamento definido", async () => {
  // Decisão de F0.c.4: loja sem dono não pertence a ninguém, então
  // nenhum usuário autenticado a alcança por este caminho.
  const r = await getMLToken(req({ loja_ativa_id: LOJA_ORFA }), UID_A);
  assert(r === null, "loja órfã foi alcançada por um usuário");
});

t("7. loja do PRÓPRIO usuário, mas de outro marketplace -> NEGADO", async () => {
  const r = await getMLToken(req({ loja_ativa_id: LOJA_SHOPEE_A }), UID_A);
  assert(r === null, "loja Shopee foi usada como loja ML");
});

t("8. userId ausente -> NEGADO, sem nem consultar o banco", async () => {
  consultas = [];
  const r = await getMLToken(req({ loja_ativa_id: LOJA_A }), "");
  assert(r === null, "userId vazio foi aceito");
  assert(consultas.length === 0, "consultou o banco sem usuário autenticado");
});

t("9. lojaId malformado -> NEGADO, sem consultar o banco", async () => {
  for (const mau of ["nao-e-uuid", "1", "'; DROP TABLE lojas;--", LOJA_A + "x"]) {
    consultas = [];
    const r = await getMLToken(req({ loja_ativa_id: mau }), UID_A);
    assert(r === null, `id malformado aceito: ${mau}`);
    assert(consultas.length === 0, `id malformado chegou ao banco: ${mau}`);
  }
});

console.log("\n[3. contrato da consulta — o que o refactor não pode perder]");

t("10. a consulta de resolução filtra por id E user_id, juntos", async () => {
  consultas = [];
  await getMLToken(req({ loja_ativa_id: LOJA_A }), UID_A);
  const resolucao = consultas.find(c => c.tabela === "lojas" && c.tipo === "select");
  assert(!!resolucao, "nenhuma consulta a `lojas` foi registrada");
  assert(resolucao!.filtros.id === LOJA_A, "consulta sem filtro de id");
  assert(resolucao!.filtros.user_id === UID_A, "🔴 consulta SEM filtro de user_id — a falha voltou");
});

t("11. TODA consulta a `lojas` nesta função carrega user_id", async () => {
  consultas = [];
  await getMLToken(req({ loja_ativa_id: LOJA_A }), UID_A);
  const semDono = consultas.filter(c => c.tabela === "lojas" && c.tipo === "select" && !("user_id" in c.filtros));
  assert(semDono.length === 0,
    `consulta a lojas sem user_id: ${JSON.stringify(semDono)}`);
});

t("12. o cookie de token não contorna a checagem de propriedade", async () => {
  // Cookie de sessão do ML + loja alheia: a propriedade é avaliada ANTES,
  // então nem o atalho do token direto é servido.
  const r = await getMLToken(
    req({ loja_ativa_id: LOJA_B, ml_access_token: "<token-qualquer>" }), UID_A);
  assert(r === null, "atalho do cookie de token furou a checagem de propriedade");
});

t("13. sem loja selecionada, o atalho do cookie continua funcionando", async () => {
  // Regressão do caminho legítimo: quem não tem `loja_ativa_id` e já tem
  // o cookie de token continua operando como antes.
  const r = await getMLToken(req({ ml_access_token: "<token-do-proprio-usuario>" }), UID_A);
  assert(r !== null && r.token === "<token-do-proprio-usuario>", "caminho legítimo quebrou");
});

t("14. escrita de token nunca mira loja não validada", async () => {
  // Caminho de refresh com loja alheia: nem chega a gravar.
  consultas = [];
  await getMLToken(req({ loja_ativa_id: LOJA_B, ml_refresh_token: "<refresh-do-atacante>" }), UID_A);
  const escritas = consultas.filter(c => c.tipo === "update");
  assert(escritas.length === 0, `gravou em loja alheia: ${JSON.stringify(escritas)}`);
});

console.log("\n[4. contrato da API]");

t("15. getMLToken exige userId na assinatura", () => {
  // Duas posições: chamar sem o segundo argumento é erro de compilação
  // (provado pelo tsc do projeto). Aqui garantimos o efeito em runtime.
  assert(getMLToken.length === 2, `esperado 2 parâmetros obrigatórios, encontrado ${getMLToken.length}`);
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
