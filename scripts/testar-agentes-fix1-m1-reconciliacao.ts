/**
 * FIX1-M1 — o estado da conexao depois de uma renovacao de credencial.
 *
 * ── O defeito que esta suite existe para fixar ──────────────────────
 *
 * O executor monta o fato de conexao ANTES de confirmar cobertura. A
 * confirmacao resolve a credencial por `getMLLojaById`, que RENOVA token
 * vencido e persiste a nova validade. Só que `confirmarCoberturaDosFatos`
 * devolvia o fato com `estado` calculado antes dessa renovacao — e o
 * guard exige `estado === "conectada"`.
 *
 * Resultado: a primeira execucao renovava a credencial com sucesso e
 * terminava `conexao_ausente`. A segunda passava, porque a validade nova
 * ja estava no banco. Um sistema que precisa ser chamado duas vezes para
 * funcionar uma.
 *
 * ── O que esta suite NAO faz ────────────────────────────────────────
 *
 * Zero rede: a porta `buscar` entra por injecao e o `fetch` global vira
 * armadilha. Zero banco: o cliente Supabase e duplado por interceptacao
 * de modulo. Zero credencial real, zero Mercado Livre.
 *
 * ── Por que um banco em MEMORIA, e nao uma fila de respostas ────────
 *
 * As demais suites roteirizam N respostas em ordem. Aqui isso mediria a
 * quantidade de leituras — exatamente o que o fix muda — e o teste
 * quebraria por implementar o fix, nao por errar. O duplo guarda uma
 * linha e responde o valor CORRENTE dela, entao a asserção passa a ser
 * sobre comportamento observavel: o estado que chega ao guard.
 *
 * Rodar:  npx tsx scripts/testar-agentes-fix1-m1-reconciliacao.ts
 */
import "./_server-only-inerte";

import Module from "node:module";

let passou = 0;
let falhou = 0;

function ok(nome: string, condicao: boolean, detalhe = ""): void {
  if (condicao) {
    passou++;
    console.log(`  PASS  ${nome}`);
  } else {
    falhou++;
    console.log(`  FAIL  ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
  }
}

function secao(titulo: string): void {
  console.log(`\n── ${titulo} ${"─".repeat(Math.max(0, 62 - titulo.length))}`);
}

// ─── Identidades sinteticas ───────────────────────────────────────────

const USER = "user-sintetico-fix1m1";
const LOJA = "aaaaaaaa-0000-4000-8000-00000000000a";
const PLATAFORMA = "mercado_livre";
const RECURSO = "perguntas";
const FUNCAO = "mercadolivre.perguntas.listar";
const TOKEN_SINTETICO = "token-sintetico-nunca-deve-vazar";

const HORA_MS = 3_600_000;
const agora = () => Date.now();
const vencido = () => new Date(Date.now() - 10 * HORA_MS).toISOString();
const valido = () => new Date(Date.now() + 5 * HORA_MS).toISOString();

// ─── O duplo do Supabase: UMA linha de `lojas`, valor corrente ────────

interface LinhaLoja {
  id: string;
  user_id: string;
  marketplace: string;
  ativo: boolean;
  access_token: string | null;
  token_expires_at: string | null;
}

let bancoLoja: LinhaLoja | null = null;
let leiturasDeLojas = 0;
let escritas = 0;

function construtor(tabela: string): unknown {
  let filtroId: string | null = null;
  let filtroUser: string | null = null;

  const linhaOuNull = () => {
    if (tabela !== "lojas") return null;
    leiturasDeLojas++;
    if (bancoLoja === null) return null;
    if (filtroId !== null && filtroId !== bancoLoja.id) return null;
    if (filtroUser !== null && filtroUser !== bancoLoja.user_id) return null;
    return bancoLoja;
  };

  const b: Record<string, unknown> = {
    select() { return b; },
    eq(coluna: string, valor: unknown) {
      if (coluna === "id") filtroId = String(valor);
      if (coluna === "user_id") filtroUser = String(valor);
      return b;
    },
    in() { return b; },
    order() { return b; },
    insert() { escritas++; return b; },
    update() { escritas++; return b; },
    upsert() { escritas++; return b; },
    delete() { escritas++; return b; },
    maybeSingle() {
      const data = linhaOuNull();
      return { then: (fn: (v: { data: unknown; error: unknown }) => void) => fn({ data, error: null }) };
    },
    then(fn: (v: { data: unknown; error: unknown }) => void) {
      const linha = linhaOuNull();
      fn({ data: linha === null ? [] : [linha], error: null });
    },
  };
  return b;
}

const clienteFake = {
  from: (t: string) => construtor(t),
  rpc: () => Promise.resolve({ data: null, error: null }),
};

/** SENTINELA: qualquer rede NAO injetada quebra o teste com nome proprio. */
let tentativasDeRede = 0;
globalThis.fetch = (async (url: string | URL | Request) => {
  tentativasDeRede++;
  throw new Error(`suite sem rede: fetch proibido (${String(url).slice(0, 60)})`);
}) as unknown as typeof fetch;

const requireOriginal = (Module as unknown as { prototype: { require: (id: string) => unknown } }).prototype.require;
let interceptou = false;
(Module as unknown as { prototype: { require: unknown } }).prototype.require = function (this: unknown, id: string) {
  if (typeof id === "string" && id.includes("supabase-servidor")) {
    interceptou = true;
    return { getSupabaseServidor: () => clienteFake };
  }
  // eslint-disable-next-line prefer-rest-params
  return requireOriginal.apply(this, arguments as unknown as [string]);
};

// ─── Portas de rede: a resposta do grant ──────────────────────────────

let chamadasDeGrant = 0;

/** `GET /users/{sellerId}/applications` com o app e os escopos pedidos. */
const grant = (status: number, corpo: unknown) =>
  (async (url: string | URL | Request) => {
    chamadasDeGrant++;
    if (!String(url).includes("/applications")) {
      throw new Error(`porta de grant recebeu endereco inesperado: ${String(url).slice(0, 60)}`);
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => corpo,
      text: async () => JSON.stringify(corpo),
    } as unknown as Response;
  }) as unknown as typeof fetch;

/**
 * O id da aplicacao NAO e escrito aqui.
 *
 * Ele e lido de `PERMISSAO_FUNCIONAL_CONGELADA.appIdVerificado`, que e a
 * autoridade do repositorio sobre qual app foi verificado. Copia-lo como
 * literal criaria uma segunda verdade que envelheceria calada — e o
 * valor nunca e impresso.
 */
let APP_ID = "";
// A chave e `app_id`, como `confirmarCoberturaML` a procura -- nao `id`.
const grantCom = (scopes: string[]) => ({ applications: [{ app_id: APP_ID, scopes }] });

/**
 * O duplo de `getMLLojaById`.
 *
 * Reproduz o comportamento REAL que causa o defeito: ele renova o token
 * vencido e PERSISTE a validade nova — aqui, escrevendo no banco em
 * memoria. O que ele devolve continua sendo so `{accessToken, sellerId}`,
 * exatamente como a funcao de producao: a validade nova nao sobe por
 * valor de retorno, e e por isso que quem so olha o retorno nao percebe
 * que o snapshot envelheceu.
 */
let renovacoes = 0;
const credencialQueRenova = async () => {
  if (bancoLoja === null) return null;
  const expirouOuVaiExpirar =
    bancoLoja.token_expires_at !== null &&
    new Date(bancoLoja.token_expires_at).getTime() - 5 * 60 * 1000 < Date.now();
  if (expirouOuVaiExpirar) {
    renovacoes++;
    bancoLoja = { ...bancoLoja, access_token: TOKEN_SINTETICO, token_expires_at: valido() };
  }
  return { accessToken: TOKEN_SINTETICO, sellerId: "seller-sintetico" };
};

/** Credencial que NAO consegue renovar: o token segue vencido. */
const credencialQueNaoRenova = async () => {
  if (bancoLoja === null) return null;
  return { accessToken: TOKEN_SINTETICO, sellerId: "seller-sintetico" };
};

const credencialAusente = async () => null;

// ─── O cenario ────────────────────────────────────────────────────────

interface Cenario {
  expiraEm: string | null;
  ativo?: boolean;
  temToken?: boolean;
  resolver: () => Promise<{ accessToken: string; sellerId: string } | null>;
  respostaDoGrant: { status: number; corpo: unknown };
}

async function rodar(c: Cenario) {
  const { montarFatoConexao } = await import("../lib/agentes/conexoes/estado");
  const { confirmarCoberturaDosFatos } = await import("../lib/agentes/conexoes/cobertura-remota");
  const { autorizarFuncao } = await import("../lib/agentes/funcoes/guard");

  bancoLoja = {
    id: LOJA,
    user_id: USER,
    marketplace: "ML",
    ativo: c.ativo ?? true,
    access_token: (c.temToken ?? true) ? TOKEN_SINTETICO : null,
    token_expires_at: c.expiraEm,
  };
  leiturasDeLojas = 0;
  escritas = 0;
  chamadasDeGrant = 0;
  renovacoes = 0;

  // 1. O SNAPSHOT, como o agregador o produz: derivado da linha ANTES de
  //    qualquer renovacao. `fatoDaLinha` faz exatamente esta reducao.
  const fatoInicial = montarFatoConexao(PLATAFORMA, RECURSO, {
    marketplace: bancoLoja.marketplace,
    ativo: bancoLoja.ativo,
    temAccessToken: bancoLoja.access_token !== null && bancoLoja.access_token.length > 0,
    token_expires_at: bancoLoja.token_expires_at,
  }, agora());

  // 2. A cobertura — que resolve credencial e pode renovar.
  const elevados = await confirmarCoberturaDosFatos(
    {
      userId: USER,
      requisito: { plataforma: PLATAFORMA, recurso: RECURSO },
      lojaId: LOJA,
      acesso: "leitura",
      conexoes: [fatoInicial],
    },
    { resolverCredencial: c.resolver, buscar: grant(c.respostaDoGrant.status, c.respostaDoGrant.corpo) }
  );

  // 3. O guard, exatamente como o executor o chama.
  const decisao = autorizarFuncao({
    funcaoId: FUNCAO,
    conexaoNecessaria: { plataforma: PLATAFORMA, recurso: RECURSO },
    funcoes: [{ id: FUNCAO, existe: true }],
    permissoes: [{ funcaoId: FUNCAO, nivel: "automatico" }],
    conexoes: elevados.conexoes,
  });

  const fatoFinal = elevados.conexoes.find(
    (f) => f.plataforma === PLATAFORMA && f.recurso === RECURSO
  );

  return {
    estadoInicial: fatoInicial.estado,
    estadoFinal: fatoFinal?.estado ?? null,
    coberturaFinal: fatoFinal?.cobertura ?? null,
    permitido: decisao.permitido,
    codigo: decisao.permitido ? null : decisao.codigo,
    renovacoes,
    chamadasDeGrant,
    leiturasDeLojas,
    escritas,
    expiraEmNoBanco: bancoLoja?.token_expires_at ?? null,
  };
}

// ─── Execucao ─────────────────────────────────────────────────────────

async function principal(): Promise<void> {
  console.log("\n══ CDS IA — FIX1-M1: estado da conexao apos renovacao ══");

  // A cobertura recusa `configuracao_ausente` sem `ML_CLIENT_ID`, e o
  // ambiente de teste nao o tem. O valor vem da constante congelada do
  // proprio repositorio, nunca de um literal e nunca do `.env`.
  const { PERMISSAO_FUNCIONAL_CONGELADA } = await import("../lib/mercado-livre-concessoes");
  APP_ID = PERMISSAO_FUNCIONAL_CONGELADA.appIdVerificado;
  process.env.ML_CLIENT_ID = APP_ID;
  ok("SETUP  o app verificado da constante congelada esta disponivel", APP_ID.length > 0);

  secao("CASE A — token valido desde o inicio, cobertura confirmada");
  const a = await rodar({
    expiraEm: valido(),
    resolver: credencialQueRenova,
    respostaDoGrant: { status: 200, corpo: grantCom(["read", "offline_access"]) },
  });
  ok("A1  o snapshot ja nasce `conectada`", a.estadoInicial === "conectada", a.estadoInicial);
  ok("A2  nenhuma renovacao aconteceu", a.renovacoes === 0, String(a.renovacoes));
  ok("A3  cobertura confirmada", a.coberturaFinal === "confirmada", String(a.coberturaFinal));
  ok("A4  estado final `conectada`", a.estadoFinal === "conectada", String(a.estadoFinal));
  ok("A5  guard PERMITE", a.permitido === true, String(a.codigo));

  secao("CASE B — token vencido, renovacao OK, cobertura confirmada [REGRESSAO]");
  const b = await rodar({
    expiraEm: vencido(),
    resolver: credencialQueRenova,
    respostaDoGrant: { status: 200, corpo: grantCom(["read", "offline_access"]) },
  });
  ok("B1  o snapshot nasce `expirada` — e o defeito comeca aqui",
    b.estadoInicial === "expirada", b.estadoInicial);
  ok("B2  a credencial FOI renovada durante a cobertura", b.renovacoes === 1, String(b.renovacoes));
  ok("B3  e a validade nova esta persistida",
    b.expiraEmNoBanco !== null && new Date(b.expiraEmNoBanco).getTime() > Date.now());
  ok("B4  cobertura confirmada", b.coberturaFinal === "confirmada", String(b.coberturaFinal));
  ok("B5  o estado entregue ao guard reflete a credencial ATUAL",
    b.estadoFinal === "conectada", `estado=${b.estadoFinal}`);
  ok("B6  guard PERMITE — uma execucao basta",
    b.permitido === true, `codigo=${b.codigo}`);
  ok("B7  UMA renovacao, nunca duas", b.renovacoes === 1, String(b.renovacoes));
  ok("B8  UMA chamada de grant", b.chamadasDeGrant === 1, String(b.chamadasDeGrant));

  secao("CASE C — token vencido, renovacao FALHA");
  const c = await rodar({
    expiraEm: vencido(),
    resolver: credencialQueNaoRenova,
    respostaDoGrant: { status: 401, corpo: {} },
  });
  ok("C1  o token continua vencido no banco",
    c.expiraEmNoBanco !== null && new Date(c.expiraEmNoBanco).getTime() < Date.now());
  ok("C2  estado final NAO e `conectada`", c.estadoFinal !== "conectada", String(c.estadoFinal));
  ok("C3  guard NEGA", c.permitido === false, String(c.codigo));
  ok("C4  e nega por conexao", c.codigo === "conexao_ausente", String(c.codigo));

  secao("CASE D — token vencido, SEM refresh token");
  const d = await rodar({
    expiraEm: vencido(),
    resolver: credencialQueNaoRenova,
    respostaDoGrant: { status: 401, corpo: {} },
  });
  ok("D1  guard NEGA", d.permitido === false, String(d.codigo));
  ok("D2  estado final segue `expirada`", d.estadoFinal === "expirada", String(d.estadoFinal));

  secao("CASE E — renovacao OK, cobertura NAO confirmada (app sem `read`)");
  const e = await rodar({
    expiraEm: vencido(),
    resolver: credencialQueRenova,
    respostaDoGrant: { status: 200, corpo: grantCom(["offline_access"]) },
  });
  ok("E1  a credencial foi renovada mesmo assim", e.renovacoes === 1, String(e.renovacoes));
  ok("E2  o estado pode estar reconciliado para `conectada`",
    e.estadoFinal === "conectada", String(e.estadoFinal));
  ok("E3  mas a cobertura NAO foi confirmada",
    e.coberturaFinal !== "confirmada", String(e.coberturaFinal));
  ok("E4  e o guard NEGA — por cobertura, nao por estado",
    e.permitido === false && e.codigo === "conexao_ausente", String(e.codigo));

  secao("CASE F — loja inexistente / de outro dono / inativa");
  const f1 = await rodar({
    expiraEm: valido(),
    resolver: credencialAusente,
    respostaDoGrant: { status: 200, corpo: grantCom(["read", "offline_access"]) },
  });
  ok("F1  credencial ausente -> guard NEGA", f1.permitido === false, String(f1.codigo));
  ok("F2  e nenhum grant foi pedido", f1.chamadasDeGrant === 0, String(f1.chamadasDeGrant));

  const f3 = await rodar({
    expiraEm: valido(),
    ativo: false,
    resolver: credencialQueRenova,
    respostaDoGrant: { status: 200, corpo: grantCom(["read", "offline_access"]) },
  });
  ok("F3  loja inativa -> estado `desconectada`", f3.estadoFinal === "desconectada", String(f3.estadoFinal));
  ok("F4  loja inativa -> guard NEGA", f3.permitido === false, String(f3.codigo));

  const f5 = await rodar({
    expiraEm: valido(),
    temToken: false,
    resolver: credencialQueRenova,
    respostaDoGrant: { status: 200, corpo: grantCom(["read", "offline_access"]) },
  });
  ok("F5  sem access_token -> estado `desconectada`", f5.estadoFinal === "desconectada", String(f5.estadoFinal));
  ok("F6  sem access_token -> guard NEGA", f5.permitido === false, String(f5.codigo));

  secao("G. Isolamento");
  ok("G1  ZERO rede fora das portas injetadas", tentativasDeRede === 0, String(tentativasDeRede));
  ok("G2  ZERO escrita em tabela pelo duplo", escritas === 0, String(escritas));
  // O fix NAO pode derivar estado por conta propria: ele tem de passar
  // pelo produtor canonico, que le `lojas` e aplica `derivarEstadoConexao`.
  // Sem leitura nenhuma, um `estado` correto teria vindo de regra
  // duplicada — que e exatamente o que o gate proibe.
  ok("G3  a reconciliacao passou pelo produtor canonico (leu `lojas`)",
    b.leiturasDeLojas >= 1, `leituras=${b.leiturasDeLojas}`);
  ok("G4  e o duplo do Supabase foi de fato usado", interceptou);

  console.log(`\n── placar ${"─".repeat(54)}`);
  console.log(`  PASS ${passou}   FAIL ${falhou}\n`);
  if (falhou > 0) process.exitCode = 1;
}

void principal();
