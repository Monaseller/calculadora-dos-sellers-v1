/**
 * CDS IA — SKILL-1D.f.4-C. Suite local de `promoverSkillVigente`.
 *
 * A RPC real EXISTE no banco desde a f.4-B, e esta suite NAO a chama.
 * Aqui o cliente Supabase e substituido por um duplo que registra cada
 * invocacao: o que se afirma nao e "a promocao funciona", e sim quantas
 * chamadas o modulo real fez, com que nome, com que payload, e como ele
 * traduz cada resposta possivel.
 *
 * Semantica de verdade contra banco real e da f.4-E, com duas sessoes.
 *
 * Precedentes seguidos, nenhum inventado: `_server-only-inerte` e o
 * duplo de `Module.prototype.require`, os mesmos da suite da f.3.
 *
 * Rodar:  npx tsx scripts/testar-ia-skill-1d-f4-c.ts
 * Sem rede, sem banco, sem IA, sem escrita real.
 */
import "./_server-only-inerte";

import Module from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

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

const RAIZ = join(__dirname, "..");
const FONTE = readFileSync(join(RAIZ, "lib/agentes/skills/escrita.ts"), "utf8");
/** Sem comentario e sem string literal: o docblock de
 *  `promoverSkillVigente` cita `.update()`, `02000` e `nao_disponivel`
 *  para explicar o que NAO faz. Sondar o arquivo cru leria a explicacao
 *  como se fosse codigo — exatamente a dividida `P7`. */
const CODIGO = FONTE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

// ─── O duplo do cliente Supabase ──────────────────────────────────────

interface Invocacao {
  tipo: "rpc" | "from";
  nome: string;
  payload?: unknown;
}

interface Resposta {
  data?: unknown;
  error?: Record<string, unknown> | null;
}

let invocacoes: Invocacao[] = [];
let resposta: Resposta = {};

function roteiro(r: Resposta): void {
  resposta = r;
  invocacoes = [];
}

const clienteFake = {
  rpc(nome: string, payload: unknown) {
    invocacoes.push({ tipo: "rpc", nome, payload });
    return Promise.resolve({ data: resposta.data ?? null, error: resposta.error ?? null });
  },
  // Se a promocao algum dia tentar SQL direto, a chamada fica registrada
  // e os asserts de "zero prequery" reprovam.
  from(nome: string) {
    invocacoes.push({ tipo: "from", nome });
    const b: Record<string, unknown> = {
      select: () => b, update: () => b, insert: () => b, delete: () => b, eq: () => b,
      then: (res: (v: unknown) => void) => res({ data: null, error: null }),
    };
    return b;
  },
};

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

const USER = "user-sintetico-f4c";
const SKILL = "3f1c8a52-9b0e-4d77-a1c3-6e2f5b8d0417";

console.log("\n══ CDS IA — SKILL-1D.f.4-C: promoverSkillVigente ══");

async function principal(): Promise<void> {
  const escrita = await import("../lib/agentes/skills/escrita");
  const { promoverSkillVigente, importarEPersistirSkill, associarSkillAoAgente, desassociarSkillDoAgente } = escrita;

  // ─── A. Instrumento ─────────────────────────────────────────────────

  secao("A. O duplo esta instalado e o modulo real foi carregado");

  ok("A1  ANCORA: o duplo interceptou o cliente Supabase", interceptou);
  const carregados = Object.keys(require.cache).map((p) => p.replace(/\\/g, "/"));
  ok("A2  ANCORA: escrita.ts esta no grafo",
    carregados.some((p) => p.includes("/lib/agentes/skills/escrita.ts")));
  ok("A3  nenhum cliente Supabase real carregado",
    !carregados.some((p) => /@supabase|supabase-servidor/.test(p)));
  ok("A4  promoverSkillVigente e exportada", typeof promoverSkillVigente === "function");
  ok("A5  as tres APIs da f.3 continuam exportadas",
    typeof importarEPersistirSkill === "function" &&
    typeof associarSkillAoAgente === "function" &&
    typeof desassociarSkillDoAgente === "function");

  // Controle positivo do instrumento: uma chamada valida registra 1 RPC.
  roteiro({ data: "promovida" });
  await promoverSkillVigente({ userId: USER, skillId: SKILL });
  ok("A6  CONTROLE POSITIVO: chamada valida registra 1 invocacao", invocacoes.length === 1);

  // ─── B. Guards ──────────────────────────────────────────────────────

  secao("B. Sem autoridade nao ha RPC");

  for (const [rot, ent] of [
    ["userId vazio", { userId: "", skillId: SKILL }],
    ["skillId vazio", { userId: USER, skillId: "" }],
    ["ambos vazios", { userId: "", skillId: "" }],
  ] as const) {
    roteiro({ data: "promovida" });
    const r = await promoverSkillVigente(ent);
    ok(`B1 ${rot} -> entrada_invalida`, r.estado === "entrada_invalida");
    ok(`B2 ${rot} -> ZERO invocacao (nem RPC, nem query)`, invocacoes.length === 0);
  }

  // ─── C. A chamada ───────────────────────────────────────────────────

  secao("C. Exatamente uma RPC, com o payload exato");

  roteiro({ data: "promovida" });
  await promoverSkillVigente({ userId: USER, skillId: SKILL });

  ok("C1  exatamente UMA invocacao", invocacoes.length === 1);
  ok("C2  e ela e uma RPC", invocacoes[0]?.tipo === "rpc");
  ok("C3  nome exato da RPC", invocacoes[0]?.nome === "promover_skill_vigente");

  const payload = (invocacoes[0]?.payload ?? {}) as Record<string, unknown>;
  ok("C4  payload tem exatamente 2 chaves",
    JSON.stringify(Object.keys(payload).sort()) === JSON.stringify(["p_skill_id", "p_user_id"]));
  ok("C5  p_user_id e o da entrada", payload.p_user_id === USER);
  ok("C6  p_skill_id e o da entrada", payload.p_skill_id === SKILL);
  ok("C7  ZERO slug no payload", !("p_slug" in payload) && !JSON.stringify(payload).includes("slug"));
  ok("C8  ZERO prequery — nenhuma leitura antes", !invocacoes.some((i) => i.tipo === "from"));
  ok("C9  ZERO query depois", invocacoes.length === 1);

  // ─── D. Os tres retornos validos ────────────────────────────────────

  secao("D. O vocabulario fechado da RPC");

  for (const estado of ["promovida", "ja_vigente", "nao_disponivel"] as const) {
    roteiro({ data: estado });
    const r = await promoverSkillVigente({ userId: USER, skillId: SKILL });
    ok(`D1 data "${estado}" -> ${estado}`, r.estado === estado);
    ok(`D2 data "${estado}" -> uma unica RPC`, invocacoes.length === 1);
  }

  // ─── E. Fail-closed ─────────────────────────────────────────────────

  secao("E. Qualquer outra coisa e falha, nunca 'quase promovida'");

  const INVALIDOS: readonly (readonly [string, unknown])[] = [
    ["null", null],
    ["undefined", undefined],
    ["string vazia", ""],
    ["PROMOVIDA (caixa alta)", "PROMOVIDA"],
    ["'promovida ' com espaco", "promovida "],
    ["' promovida' com espaco", " promovida"],
    ["outro texto", "outro"],
    ["objeto", {}],
    ["objeto com estado", { estado: "promovida" }],
    ["array", []],
    ["array com o valor", ["promovida"]],
    ["boolean", true],
    ["numero", 1],
  ];

  for (const [rot, data] of INVALIDOS) {
    roteiro({ data });
    const r = await promoverSkillVigente({ userId: USER, skillId: SKILL });
    ok(`E1 retorno ${rot} -> falha_escrita`, r.estado === "falha_escrita");
    ok(`E2 retorno ${rot} NAO vira promovida`, r.estado !== "promovida");
  }

  // ─── F. Erros ───────────────────────────────────────────────────────

  secao("F. Todo erro e falha_escrita — inclusive 02000");

  for (const codigo of ["02000", "42501", "23505", "23503", "08006", "57014"]) {
    roteiro({ error: { code: codigo } });
    const r = await promoverSkillVigente({ userId: USER, skillId: SKILL });
    ok(`F1 error.code ${codigo} -> falha_escrita`, r.estado === "falha_escrita");
    ok(`F2 error.code ${codigo} NAO vira nao_disponivel`, r.estado !== "nao_disponivel");
  }

  roteiro({ error: { semCode: true } });
  const rSemCode = await promoverSkillVigente({ userId: USER, skillId: SKILL });
  ok("F3  erro SEM code -> falha_escrita", rSemCode.estado === "falha_escrita");

  // O assert nominal que o gate pediu: os dois casos sao distintos.
  roteiro({ data: "nao_disponivel" });
  const rNormal = await promoverSkillVigente({ userId: USER, skillId: SKILL });
  roteiro({ error: { code: "02000" } });
  const rRaise = await promoverSkillVigente({ userId: USER, skillId: SKILL });
  // Comparados como string: o TypeScript estreita os dois literais e
  // acusaria a comparacao como impossivel, mas o que se prova aqui e
  // justamente que o modulo produziu estados DIFERENTES em runtime.
  ok("F4  02000 NAO E nao_disponivel — sao estados diferentes",
    rNormal.estado === "nao_disponivel" && rRaise.estado === "falha_escrita" &&
    (rNormal.estado as string) !== (rRaise.estado as string));

  // ─── G. Vazamento ───────────────────────────────────────────────────

  secao("G. Nada do erro sai no retorno nem no log");

  const SENTINELAS = {
    message: "SENTINELA-MESSAGE-zzq1",
    details: "SENTINELA-DETAILS-zzq2",
    hint: "SENTINELA-HINT-zzq3",
    query: "SENTINELA-QUERY-zzq4",
  };

  const capturado: string[] = [];
  const errOriginal = console.error;
  const logOriginal = console.log;
  console.error = (...a: unknown[]) => { capturado.push(a.map(String).join(" ")); };
  console.log = (...a: unknown[]) => { capturado.push(a.map(String).join(" ")); };
  roteiro({ error: { code: "42501", ...SENTINELAS } });
  const rLeak = await promoverSkillVigente({ userId: USER, skillId: SKILL });
  console.error = errOriginal;
  console.log = logOriginal;

  const saida = capturado.join("\n");
  const retorno = JSON.stringify(rLeak);

  for (const [campo, valor] of Object.entries(SENTINELAS)) {
    ok(`G1 ${campo} nao aparece no retorno`, !retorno.includes(valor));
    ok(`G2 ${campo} nao aparece no log`, !saida.includes(valor));
  }
  ok("G3  o retorno e so o envelope", retorno === JSON.stringify({ estado: "falha_escrita" }));
  ok("G4  o log registrou o sqlstate", /42501/.test(saida));
  ok("G5  ANCORA: houve saida capturada", capturado.length > 0);
  ok("G6  CONTROLE: as sentinelas seriam detectadas",
    `x ${SENTINELAS.message} y`.includes(SENTINELAS.message));
  ok("G7  o retorno nao carrega userId nem skillId",
    !retorno.includes(USER) && !retorno.includes(SKILL));
  ok("G8  o log nao carrega userId nem skillId",
    !saida.includes(USER) && !saida.includes(SKILL));

  // ─── H. Estrutura ───────────────────────────────────────────────────

  secao("H. O que o codigo nao contem");

  const iFn = CODIGO.indexOf("export async function promoverSkillVigente");
  const METODO = iFn > 0 ? CODIGO.slice(iFn) : "";

  ok("H0  ANCORA: o metodo foi isolado do fonte sem comentarios",
    METODO.length > 200 && CODIGO.length < FONTE.length - 2000);
  ok("H1  exatamente uma `.rpc(` em todo o modulo",
    (CODIGO.match(/\.rpc\(/g) ?? []).length === 1);
  ok("H2  e ela esta dentro de promoverSkillVigente", /\.rpc\(/.test(METODO));
  ok("H3  CONTROLE: a sonda acharia uma segunda RPC",
    (`.rpc(a) .rpc(b)`.match(/\.rpc\(/g) ?? []).length === 2);
  ok("H4  zero .from( dentro do metodo", !/\.from\(/.test(METODO));
  ok("H5  zero .update( dentro do metodo", !/\.update\(/.test(METODO));
  ok("H6  zero .select(/.insert(/.delete( dentro do metodo",
    !/\.(select|insert|delete)\(/.test(METODO));
  ok("H7  CONTROLE: a sonda de prequery acharia um .from(",
    /\.from\(/.test('await c.from("skills").select("slug")'));
  ok("H8  zero retry/loop no metodo", !/\b(for|while|retry|tentativa)\b/i.test(METODO));
  // Delimitar ao CORPO da interface. Com `[\s\S]*?` aberto, a sonda
  // atravessa o bloco e encontra `slug` em qualquer lugar do arquivo —
  // acusaria o contrato por causa de codigo que nao e dele.
  const IFACE = CODIGO.match(/interface EntradaPromocao\s*\{([^}]*)\}/)?.[1] ?? "";
  ok("H9a ANCORA: o corpo de EntradaPromocao foi isolado",
    /userId/.test(IFACE) && /skillId/.test(IFACE));
  ok("H9  zero slug no contrato de entrada", !/slug/i.test(IFACE));
  ok("H9b CONTROLE: a sonda acharia slug no contrato",
    /slug/i.test(" userId: string; slug: string; "));
  ok("H10 o modulo continua server-only", /import "server-only"/.test(CODIGO));
  ok("H11 nunca le error.message/details/hint/query",
    !/error\.(message|details|hint|query)/.test(CODIGO));
  ok("H12 CONTROLE: a sonda de leitura de message acharia",
    /error\.(message|details|hint|query)/.test("console.log(r.error.message)"));
  ok("H13 o vocabulario aceito e fechado e literal",
    /\["promovida", "ja_vigente", "nao_disponivel"\]/.test(CODIGO));
  ok("H14 nao ha normalizacao do retorno da RPC",
    !/devolvido\.(trim|toLowerCase|toUpperCase)/.test(METODO));
  ok("H15 CONTROLE: a sonda de normalizacao acharia",
    /devolvido\.(trim|toLowerCase)/.test("devolvido.trim()"));

  // ─── I. As APIs da f.3 nao mudaram ──────────────────────────────────

  secao("I. Zero regressao nas features publicadas");

  roteiro({ data: null });
  const rAssoc = await associarSkillAoAgente({ userId: USER, agenteId: SKILL, skillId: SKILL });
  ok("I1  associar continua respondendo pelo mesmo envelope",
    ["associada", "ja_associada", "nao_disponivel", "entrada_invalida", "falha_escrita"].includes(rAssoc.estado));
  ok("I2  e continua usando .from(, nao RPC",
    invocacoes.some((i) => i.tipo === "from") && !invocacoes.some((i) => i.tipo === "rpc"));

  roteiro({ data: "promovida" });
  const rGuard = await associarSkillAoAgente({ userId: "", agenteId: "", skillId: "" });
  ok("I3  guards da f.3 intactos", rGuard.estado === "entrada_invalida" && invocacoes.length === 0);

  // ─── J. Fronteira ───────────────────────────────────────────────────

  secao("J. O que ainda nao existe");

  const varrer = (dir: string, achados: string[]): string[] => {
    for (const e of readdirSync(join(RAIZ, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (!/node_modules|\.next/.test(e.name)) varrer(rel, achados);
      } else if (/\.tsx?$/.test(e.name) && rel !== "lib/agentes/skills/escrita.ts") {
        if (/promoverSkillVigente/.test(readFileSync(join(RAIZ, rel), "utf8"))) achados.push(rel);
      }
    }
    return achados;
  };
  const consumidores = varrer("lib", varrer("app", []));
  ok("J1  zero consumidor de producao de promoverSkillVigente",
    consumidores.length === 0, consumidores.join(", "));
  ok("J1b ANCORA: a varredura leu arquivos de verdade",
    existsSync(join(RAIZ, "lib/agentes/skills/fatos.ts")));
  // ── J2 — invertido pela SKILL-1D.f.4-D ───────────────────────────
  //
  // Sentinela de fronteira, nao replica da suite de banco: aqui basta
  // saber que a prova real EXISTE, esta atras de `--confirmo`, e que
  // existir nao e o mesmo que ter rodado. O historico de execucao nao se
  // le no fonte — ele e evidencia do gate.
  const BANCO = "scripts/testar-ia-skill-1d-f4-banco.ts";
  const FONTE_BANCO = existsSync(join(RAIZ, BANCO))
    ? readFileSync(join(RAIZ, BANCO), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")
    : "";
  ok("J2  a suite real de banco da f.4 EXISTE e exige --confirmo",
    FONTE_BANCO.length > 1000 && /--confirmo/.test(FONTE_BANCO) &&
      /if \(!CONFIRMADO\)/.test(FONTE_BANCO));
  ok("J2a e prepara a observacao de bloqueio por catalogo",
    /pg_blocking_pids\(/.test(FONTE_BANCO));
  ok("J2b PREPARADO NAO E EXECUTADO — a promocao real, a serializacao e a " +
     "ausencia de deadlock so serao medidas na f.4-E",
    /promoverSkillVigente/.test(FONTE_BANCO) && /pg_backend_pid\(\)/.test(FONTE_BANCO));

  console.log(`\n══ ${passou} PASS / ${falhou} FAIL ══\n`);
  process.exit(falhou === 0 ? 0 : 1);
}

principal().catch((e) => {
  console.log(`  FAIL  excecao nao tratada — ${String(e).slice(0, 300)}`);
  process.exit(1);
});
