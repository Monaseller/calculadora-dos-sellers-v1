/**
 * CDS IA — SKILL-1D.f.4b. Prova REAL da promocao de `vigente`.
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │  SUITE COM ESCRITA · BANCO REAL · 3 SESSOES · COMMIT + CLEANUP│
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Rodar:
 *   npx tsx scripts/testar-ia-skill-1d-f4-banco.ts             # so audita
 *   npx tsx scripts/testar-ia-skill-1d-f4-banco.ts --confirmo  # execucao real
 *
 * ── A prova que falta desde a auditoria da f.4 ──────────────────────
 *
 * Toda a f.4 se apoia numa HIPOTESE: que a despromocao sem filtro
 * `and vigente` serializa promocoes concorrentes do mesmo slug, porque um
 * `UPDATE` trava as linhas que escreve. Isso e o comportamento esperado
 * de row locks sob READ COMMITTED — nunca foi medido.
 *
 * Medir exige DUAS sessoes PostgreSQL de verdade. Uma unica conexao com
 * `Promise.all` nao prova nada: os comandos serializam no proprio driver,
 * e nao ha disputa de lock nenhuma.
 *
 * ── E por que uma TERCEIRA sessao ───────────────────────────────────
 *
 * "A promise da sessao 2 ainda nao resolveu" nao e evidencia de
 * bloqueio: ela e igualmente compativel com lentidao, com a query nunca
 * ter sido enviada, ou com um erro engolido. Quem observa nao pode ser
 * quem espera. Por isso ha uma sessao OBSERVADORA, que so faz SELECT no
 * catalogo e responde a pergunta certa:
 *
 *     pg_blocking_pids(pid2) contem pid1?
 *
 * A evidencia e essa linha do catalogo. O tempo nao e evidencia — o
 * polling existe apenas porque `pg_stat_activity` leva alguns
 * milissegundos para refletir a espera, e tem prazo proprio.
 *
 * ── Fixtures ────────────────────────────────────────────────────────
 *
 * Promover e operacao da BIBLIOTECA de Skills: nao toca `agente_skills`
 * nem `agentes`. Entao esta suite nao cria agente nenhum — o minimo de
 * fixture e uma decisao de seguranca, nao de estilo.
 *
 * As linhas sao COMMITADAS: a camada TypeScript fala por HTTP, em outra
 * conexao, e nao enxergaria fixtures presas numa transacao daqui. A
 * limpeza e explicita, por uuid E por identidade exata, nunca por
 * prefixo.
 *
 * ── Segredo ─────────────────────────────────────────────────────────
 *
 * `instalarGuardaDeSaida()` intercepta cada byte de stdout/stderr e
 * aborta pelo NOME do padrao, sem reimprimir o trecho. Erro de driver
 * nunca e ecoado bruto — so o SQLSTATE.
 */
import "./_server-only-inerte";

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

const CONFIRMADO = process.argv.includes("--confirmo");

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

// ─── Guarda de saida ──────────────────────────────────────────────────

function instalarGuardaDeSaida(segredos: string[]): void {
  const literais = segredos.filter((s) => s.length >= 4);
  const padroes: Array<[string, RegExp | string]> = [
    ...literais.map((s, i) => [`segredo literal #${i + 1}`, s] as [string, string]),
    ["esquema postgres://", /postgres(ql)?:\/\//i],
    ["password=", /password\s*=/i],
    ["DATABASE_URL=", /DATABASE_URL\s*=/i],
    ["credencial@host", /:\/\/[^\s/@]*:[^\s/@]*@/],
    ["token JWT", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./],
    ["chave privada PEM", /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
    ["service role key", /SERVICE_ROLE_KEY\s*=/i],
    ["anon key", /ANON_KEY\s*=/i],
  ];

  for (const fluxo of ["stdout", "stderr"] as const) {
    const original = process[fluxo].write.bind(process[fluxo]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process[fluxo] as any).write = (pedaco: any, ...resto: any[]): boolean => {
      const texto = typeof pedaco === "string" ? pedaco : String(pedaco);
      for (const [nome, p] of padroes) {
        const bateu = typeof p === "string" ? texto.includes(p) : p.test(texto);
        if (bateu) {
          original(`\n  ABORTADO: saida bloqueada pelo guarda (padrao: ${nome}).\n`);
          process.exit(2);
        }
      }
      return original(pedaco, ...resto);
    };
  }
}

// ─── Identidade sintetica ─────────────────────────────────────────────

const RUN = Math.random().toString(36).slice(2, 10);
const NS = `test-skill-1d-f4b-${RUN}`;
const DONO_A = `${NS}-a`;
const DONO_B = `${NS}-b`;
/** Slug precisa casar `^[a-z0-9]+(-[a-z0-9]+)*$`. `RUN` e [0-9a-z]. */
const SLUG_P = `teste-f4b-${RUN}-p`;
const SLUG_OUTRO = `teste-f4b-${RUN}-o`;
const SLUG_CONC = `teste-f4b-${RUN}-c`;

const UUID_INEXISTENTE = "00000000-0000-4000-8000-000000000000";

/**
 * As seis identidades que esta execucao cria, declaradas ANTES de
 * qualquer DML: sao a primeira rota de recuperacao, exata e conhecida de
 * antemao mesmo que nenhum uuid volte.
 */
const IDENTIDADES: readonly (readonly [string, string, string, string])[] = [
  ["A_V1", DONO_A, SLUG_P, "1.0.0"],
  ["A_V2", DONO_A, SLUG_P, "2.0.0"],
  ["A_OUTRO", DONO_A, SLUG_OUTRO, "1.0.0"],
  ["B_V1", DONO_B, SLUG_P, "1.0.0"],
  ["CONC_V1", DONO_A, SLUG_CONC, "1.0.0"],
  ["CONC_V2", DONO_A, SLUG_CONC, "2.0.0"],
];

const criados = {
  skills: [] as string[],
  identidades: [] as Array<{ userId: string; slug: string; versao: string }>,
};

function exigirSintetico(valor: string): string {
  if (!valor.startsWith(NS)) throw new Error("GUARDA: identificador nao pertence a esta execucao");
  return valor;
}

function exigirRegistrado(id: string, lista: readonly string[]): string {
  if (!lista.includes(id)) throw new Error("GUARDA: uuid nao foi criado por esta execucao");
  return id;
}

/** Registra e ANUNCIA — um uuid nunca entra no cleanup sem passar pelo
 *  stdout. Sentinela estrutural exige que este seja o unico push. */
function anunciarSkill(rotulo: string, id: string): void {
  criados.skills.push(id);
  console.log(`  ${rotulo}_ID=${id}`);
}

// ─── Ambiente ─────────────────────────────────────────────────────────

function lerEnv(): Record<string, string> {
  const txt = readFileSync(join(__dirname, "..", ".env.local"), "utf8");
  const out: Record<string, string> = {};
  for (const m of txt.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"?([^"\r\n]*)"?/gm)) out[m[1]] = m[2];
  return out;
}

function descreverAlvo(url: string): string {
  const u = new URL(url);
  return `host=${u.hostname.replace(/^([a-z]{3})[^.]*/, "$1***")}  porta=${u.port}  database=${u.pathname.replace("/", "")}`;
}

function segredosDe(env: Record<string, string>): string[] {
  const u = new URL(env.DATABASE_URL);
  const brutos = [u.password, u.username];
  const dec = brutos.map((v) => { try { return decodeURIComponent(v); } catch { return v; } });
  // A URL de sessao tem as MESMAS credenciais, mas parseia-se separado:
  // se um dia divergirem, o guarda continua cobrindo as duas.
  const sessao: string[] = [];
  if (env.DIRECT_URL) {
    try {
      const s = new URL(env.DIRECT_URL);
      sessao.push(s.password, s.username);
      for (const v of [s.password, s.username]) {
        try { sessao.push(decodeURIComponent(v)); } catch { /* valor nao-encodado */ }
      }
    } catch { /* URL invalida: nada a proteger daqui */ }
  }
  return Array.from(new Set([...brutos, ...dec, ...sessao,
    env.SUPABASE_SERVICE_ROLE_KEY ?? "", env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ""])).filter(Boolean);
}

/** O SQLSTATE, que e a prova de QUEM recusou. Nunca a mensagem. */
function sqlstate(e: unknown): string {
  return (e as { code?: string })?.code ?? "sem-codigo";
}

const sha256 = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

/** Manifesto valido para os CHECKs de equivalencia do schema. */
function manifesto(slug: string, versao: string): string {
  return JSON.stringify({
    formato: 1,
    id: slug,
    nome: `Skill sintetica ${versao}`,
    versao,
    descricao: "Fixture da f4b.",
    quando_usar: ["cliente pergunta sobre pedido"],
    origem: "importada",
  });
}

// ─── Auto-verificacao estrutural (roda SEM banco) ─────────────────────

function autoVerificar(): void {
  secao("0. Auto-verificacao (pura, sem banco)");

  const fonte = readFileSync(join(__dirname, "testar-ia-skill-1d-f4-banco.ts"), "utf8");
  const iAuto = fonte.indexOf("function autoVerificar()");
  const fimAuto = fonte.indexOf("\n}\n", iAuto);
  const CORPO = fonte.slice(0, iAuto) + fonte.slice(fimAuto);
  const SEM_COM = CORPO.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

  const iFlag = CORPO.indexOf("if (!CONFIRMADO)");
  const iEnv = CORPO.indexOf("lerEnv()", iFlag);
  const iClient = CORPO.indexOf("new Client(");
  const iModulo = CORPO.indexOf('await import("../lib/agentes/skills/escrita")');
  const iRecup = CORPO.indexOf("=== RECUPERACAO DE FIXTURES");
  const iDML1 = CORPO.indexOf("insert into public.skills");

  ok("Z0  ANCORA: o recorte e a remocao de comentario tiraram algo",
    iAuto > 0 && CORPO.length < fonte.length - 500 && SEM_COM.length < CORPO.length - 1000);
  ok("Z1  o guarda --confirmo existe", iFlag > 0);
  ok("Z2  `lerEnv()` so e chamada DEPOIS do guarda", iFlag > 0 && iEnv > iFlag);
  ok("Z3  `new Client(` so aparece DEPOIS do guarda", iFlag > 0 && iClient > iFlag);
  ok("Z4  o modulo de escrita so e importado DEPOIS do guarda", iModulo > iFlag);
  ok("Z5  o guarda de saida e instalado antes de descrever o alvo",
    CORPO.indexOf("instalarGuardaDeSaida(") < CORPO.indexOf("descreverAlvo("));
  ok("Z6  o bloco de recuperacao vem ANTES do primeiro DML",
    iRecup > 0 && iDML1 > 0 && iRecup < iDML1);
  ok("Z7  o bloco carrega RUN, NS e os dois tenants",
    ["RUN=${RUN}", "NS=${NS}", "DONO_A=${DONO_A}", "DONO_B=${DONO_B}"].every((k) => CORPO.includes(k)));
  ok("Z8  as 6 identidades sao declaradas antes de qualquer DML",
    CORPO.indexOf("const IDENTIDADES") > 0 && CORPO.indexOf("const IDENTIDADES") < iDML1);

  ok("Z9  nenhum DELETE por wildcard", !/delete from[^;]*like/i.test(SEM_COM));
  ok("Z10 CONTROLE: a sonda de wildcard acha quando existe",
    /delete from[^;]*like/i.test("delete " + "from t where u like 'x%'"));
  ok("Z11 nenhum DELETE sem WHERE", !/delete\s+from\s+public\.\w+\s*(;|`)/i.test(SEM_COM));
  ok("Z12 a suite NAO aplica migration nem cria tabela/funcao",
    !/create\s+table|apply_migration|create\s+or\s+replace\s+function/i.test(SEM_COM));
  ok("Z13 CONTROLE: a sonda de DDL acha quando existe", /create\s+table/i.test("create table x ()"));
  ok("Z14 nenhuma mensagem de erro bruta e impressa", !/\.message\b|\.detail\b|\.hint\b|\.where\b/.test(SEM_COM));
  ok("Z15 CONTROLE: a sonda de mensagem bruta acha", /\.message\b/.test("console.log(e" + ".message)"));

  ok("Z16 a suite NAO toca agentes nem agente_skills",
    !/public\.(agentes|agente_skills)\b/i.test(SEM_COM));
  ok("Z17 CONTROLE: a sonda de agentes acha quando existe",
    /public\.(agentes|agente_skills)\b/i.test("insert into public.agentes (user_id)"));
  ok("Z18 nenhuma tabela operacional e tocada",
    !/public\.(pedidos|lojas|mensagens|anuncios|perfil)\b/i.test(SEM_COM));
  ok("Z19 CONTROLE: a sonda de tabela operacional acha",
    /public\.(pedidos|lojas)\b/i.test("select * from public.pedidos"));

  ok("Z20 cleanup opera por uuid E identidade exatos",
    /exigirRegistrado\(/.test(SEM_COM) && /exigirSintetico\(/.test(SEM_COM));
  ok("Z21 nenhum uuid entra no cleanup sem ser anunciado",
    (SEM_COM.match(/criados\.skills\.push\(/g) ?? []).length === 1);
  ok("Z22 e o unico push vive dentro de `anunciarSkill`",
    /function anunciarSkill\([^)]*\)[^{]*\{\s*criados\.skills\.push\(/.test(SEM_COM));

  // ── A prova de bloqueio precisa ser de CATALOGO, nao de tempo ──────
  ok("Z23 a prova de bloqueio consulta pg_blocking_pids", /pg_blocking_pids\(/.test(SEM_COM));
  ok("Z24 e tambem observa wait_event_type em pg_stat_activity",
    /pg_stat_activity/.test(SEM_COM) && /wait_event_type/.test(SEM_COM));
  ok("Z25 ha tres backends distintos declarados (s1, s2, observador)",
    /pg_backend_pid\(\)/.test(SEM_COM) &&
    (SEM_COM.match(/new Client\(/g) ?? []).length >= 3);
  ok("Z26 nenhum sleep e usado como EVIDENCIA — so como intervalo de polling",
    /evidencia e o catalogo/i.test(CORPO) && !/sleep\([0-9]+\)\s*;\s*ok\(/.test(SEM_COM));
  ok("Z27 o polling tem prazo proprio", /DEADLINE_OBSERVACAO/.test(SEM_COM));
  ok("Z28 a sessao 2 nao usa lock_timeout curto que a mataria esperando",
    !/lock_timeout/i.test(SEM_COM));
  ok("Z29 ha statement_timeout defensivo", /statement_timeout/i.test(SEM_COM));

  ok("Z30 a suite nao promove por UPDATE direto de vigente",
    !/update\s+public\.skills\s+set\s+vigente/i.test(SEM_COM));
  ok("Z31 CONTROLE: a sonda de update direto acha",
    /update\s+public\.skills\s+set\s+vigente/i.test("update public.skills set vigente = true"));
  ok("Z32 a promocao e sempre pela RPC ou pela camada TS",
    /promover_skill_vigente/.test(SEM_COM) && /promoverSkillVigente/.test(SEM_COM));

  // Inercia comportamental: neste ponto nada que conecte foi carregado.
  const grafo = Object.keys(require.cache).map((p) => p.replace(/\\/g, "/"));
  ok("Z33 o modulo de escrita NAO esta no grafo neste ponto",
    !grafo.some((p) => p.includes("/lib/agentes/skills/escrita.ts")));
  ok("Z34 ANCORA: a sonda de grafo enxerga um modulo carregado",
    grafo.some((p) => p.includes("testar-ia-skill-1d-f4-banco")));

  // ── R — a promise concorrente nao pode rejeitar orfã ───────────────
  //
  // Prefixo proprio de proposito: `Z` ja vai ate Z37 no `finally`, e
  // acrescentar Z38 aqui criaria a mesma colisao de rotulo registrada
  // como divida em `testar-ia-skill-1d-f3-banco.ts`.
  // Sobre SEM_COM, nunca sobre CORPO: o comentario que explica esta
  // correcao cita literalmente "`await pendente`", e uma sonda que
  // procurasse `await` no fonte cru leria a propria explicacao como se
  // fosse codigo entre a criacao e o handler. E a divida `P7`, e ela nao
  // se repete aqui — medido: sem o recorte, R2 reprovava por causa de
  // duas palavras dentro de um comentario.
  const iCria = SEM_COM.indexOf("const pendente = s2.query");
  const iCatch = SEM_COM.indexOf("pendente.catch(", iCria);
  const iAwait = SEM_COM.indexOf("await pendente", iCatch);
  const entre = iCria > 0 && iCatch > iCria ? SEM_COM.slice(iCria, iCatch) : "x".repeat(9999);

  ok("R1  a promise da sessao 2 tem handler de rejeicao", iCria > 0 && iCatch > iCria);
  ok("R2  o handler e anexado IMEDIATAMENTE — nada que possa lancar no meio",
    !/\bawait\b|\bok\(|\bthrow\b/.test(entre));
  ok("R2a ANCORA: o trecho entre criacao e handler e curto e real",
    entre.length > 0 && entre.length < 200);
  ok("R3  `pendente` NAO e reatribuida — o await usa a promise original",
    !/pendente\s*=(?!=)/.test(SEM_COM.replace(/const pendente =/g, "")));
  ok("R4  o `await pendente` continua existindo DEPOIS do handler", iAwait > iCatch);
  ok("R5  o handler e inerte — nao converte erro em sucesso nem loga",
    /pendente\.catch\(\(\) => undefined\);/.test(SEM_COM));
  ok("R6  CONTROLE: a sonda de reatribuicao acharia um pendente = ...",
    /pendente\s*=(?!=)/.test("pendente = pendente.catch(() => null)"));

  // ── S — o instrumento de concorrencia, corrigido na f.4-F ──────────
  ok("S1  as sessoes concorrentes usam a URL de SESSION MODE, nao a de transacao",
    /const s1 = new Client\(\{ connectionString: URL_SESSAO/.test(SEM_COM) &&
    /const s2 = new Client\(\{ connectionString: URL_SESSAO/.test(SEM_COM) &&
    /const obs = new Client\(\{ connectionString: URL_SESSAO/.test(SEM_COM));
  ok("S2  a validacao exige host pooler E porta 5432",
    /\\.pooler\\.supabase\\.com\$\/\.test\(u\.hostname\)/.test(SEM_COM) && /u\.port === "5432"/.test(SEM_COM));
  ok("S3  transaction mode nao e mais usado por s1/s2/obs",
    !/new Client\(\{ connectionString: env\.DATABASE_URL, application_name/.test(SEM_COM));
  ok("S4  `c` NAO foi alterado — continua na URL de transacao",
    /const c = new Client\(\{ connectionString: env\.DATABASE_URL \}\)/.test(SEM_COM));
  ok("S5  o codigo NAO chama a conexao de sessao de 'direct'",
    !/direct connection|conexao direta/i.test(SEM_COM));
  ok("S6  o PID de s1 e lido DENTRO da transacao, antes e depois da promocao",
    SEM_COM.indexOf('s1.query("begin")') < SEM_COM.indexOf("const pid1a") &&
    SEM_COM.indexOf("const pid1a") < SEM_COM.indexOf("const r1 = await s1.query") &&
    SEM_COM.indexOf("const r1 = await s1.query") < SEM_COM.indexOf("const pid1b"));
  ok("S7  cada sessao tem DUAS leituras de PID — afinidade, nao leitura unica",
    /pid2a/.test(SEM_COM) && /pid2b/.test(SEM_COM) && /pidO1/.test(SEM_COM) && /pidO2/.test(SEM_COM));
  ok("S8  PIDs distintos sao exigidos antes do cenario",
    /pid1 !== pid2/.test(SEM_COM) && /pidObs !== pid1/.test(SEM_COM));
  ok("S9  instrumento invalido ABORTA o cenario antes de disparar a disputa",
    /const instrumentoValido/.test(SEM_COM) &&
    SEM_COM.indexOf("if (!instrumentoValido)") < SEM_COM.indexOf("const pendente = s2.query"));
  ok("S10 pg_blocking_pids e wait_event_type preservados",
    /pg_blocking_pids\(/.test(SEM_COM) && /wait_event_type/.test(SEM_COM));
  ok("S11 application_name identifica cada sessao, sem segredo",
    /application_name: `skill-f4-s1-\$\{RUN\}`/.test(SEM_COM) &&
    !/application_name[^\n]*(senha|password|KEY)/i.test(SEM_COM));
  ok("S12 o guarda de saida cobre tambem a credencial da URL de sessao",
    /env\.DIRECT_URL/.test(SEM_COM.slice(SEM_COM.indexOf("function segredosDe"))));
  ok("S13 CONTROLE: as sondas de sessao acusariam a URL de transacao ali",
    /new Client\(\{ connectionString: env\.DATABASE_URL, application_name/.test(
      'const s1 = new Client({ connectionString: env.DATABASE_URL, application_name: "x" })'));

  // ── U — integridade do harness, corrigida na f.4-H ─────────────────
  //
  // A f.4-G reportou 81/81 com o cenario concorrente inteiro ausente:
  // uma excecao antes de H1 foi descartada pelo `process.exit` do
  // `finally`. Estas sondas existem para que isso nao seja possivel de
  // novo — e para que ninguem as remova sem perceber.
  const iFinally = SEM_COM.lastIndexOf("} finally {");
  const trechoFinally = iFinally > 0 ? SEM_COM.slice(iFinally) : "";

  ok("U0  ANCORA: o bloco finally final foi isolado",
    trechoFinally.length > 200 && /cleanup por uuid/.test(trechoFinally));
  ok("U1  NENHUM process.exit dentro do finally",
    !/process\.exit\(/.test(trechoFinally.slice(0, trechoFinally.indexOf("\n  }"))));
  ok("U2  o status final usa process.exitCode, depois de try/catch/finally",
    /process\.exitCode = falhou > 0 \? 1 : 0;/.test(SEM_COM) &&
    SEM_COM.lastIndexOf("process.exitCode = falhou > 0") > iFinally);
  ok("U3  o caminho sem flag tambem usa exitCode + return, nao exit",
    /process\.exitCode = falhou > 0 \? 1 : 0;\s*\n\s*return;/.test(SEM_COM));
  ok("U4  existe catch do corpo que vira FAIL visivel",
    /\} catch \(e\) \{[\s\S]{0,400}ok\("T0/.test(SEM_COM));
  ok("U5  o catch registra etapa e SQLSTATE, e mais nada",
    /etapa=\$\{etapa\} sqlstate=\$\{sqlstate\(e\)\}/.test(SEM_COM));
  ok("U6  o catch NAO le message/detail/hint/where/query/stack",
    !/\b(e|erro)\.(message|detail|hint|where|query|stack)\b/.test(SEM_COM));
  ok("U7  CONTROLE: a sonda de erro bruto acharia um e.message",
    /\b(e|erro)\.(message|detail|hint|where|query|stack)\b/.test("console.log(e.message)"));
  ok("U8  as tres conexoes tem etapa propria — a f.4-G morreu nesse intervalo",
    /etapa = "s1\.connect"/.test(SEM_COM) && /etapa = "s2\.connect"/.test(SEM_COM) &&
    /etapa = "obs\.connect"/.test(SEM_COM));
  ok("U9  o estado de completude tem os tres valores previstos",
    /"nao_iniciado" \| "abortado_instrumento" \| "executado"/.test(SEM_COM));
  ok("U10 comeca em nao_iniciado", /cenarioConcorrente[^\n]*= "nao_iniciado"/.test(SEM_COM));
  ok("U11 'executado' so e marcado DEPOIS do ultimo assert do cenario",
    SEM_COM.indexOf('ok("H13') < SEM_COM.indexOf('cenarioConcorrente = "executado"'));
  ok("U12 o abort consciente marca abortado_instrumento",
    SEM_COM.indexOf("if (!instrumentoValido)") < SEM_COM.indexOf('cenarioConcorrente = "abortado_instrumento"') &&
    SEM_COM.indexOf('cenarioConcorrente = "abortado_instrumento"') < SEM_COM.indexOf('ok("H4'));
  ok("U13 a sentinela de completude roda DEPOIS do finally",
    SEM_COM.lastIndexOf('ok(`T1') > iFinally);
  ok("U14 nao_iniciado NAO conta como sucesso",
    /cenarioConcorrente !== "nao_iniciado"/.test(SEM_COM));
  ok("U15 a prova de residuo e a de cleanup viram FAIL, nunca silencio",
    /ok\("Z37 a prova de residuo foi possivel"/.test(SEM_COM) &&
    /ok\("Z38 zero skills residuais"/.test(SEM_COM));
  ok("U16 main().catch usa exitCode, nao exit abrupto",
    /main\(\)\.catch[\s\S]{0,300}process\.exitCode = 1;/.test(SEM_COM));
  ok("U17 o unico process.exit restante e o do guarda de segredo",
    (SEM_COM.match(/process\.exit\(/g) ?? []).length === 1 &&
    SEM_COM.indexOf("process.exit(2)") > 0);
  ok("U18 H1..H13 e a secao I continuam no arquivo",
    ["H1 ", "H2 ", "H3 ", "H4 ", "H5 ", "H6 ", "H7 ", "H8 ", "H9 ", "H10", "H11", "H12", "H13", "I1 ", "I2 ", "I3 "]
      .every((r) => SEM_COM.includes(`ok("${r}`) || SEM_COM.includes(`ok("${r.trim()} `)));
}

/**
 * Prova COMPORTAMENTAL do invariante, com uma promise rejeitada de
 * mentira: `catch` inerte silencia a rejeicao orfa e, ainda assim, o
 * `await` posterior CONTINUA rejeitando.
 *
 * Sem banco, sem rede, sem conexao — roda antes do gate `--confirmo`.
 */
async function provarSemanticaDaPromise(): Promise<void> {
  secao("R. Semantica do handler inerte (pura, sem banco)");

  const falha = Object.assign(new Error("sintetico"), { code: "23505" });
  const p: Promise<string> = Promise.reject(falha);
  p.catch(() => undefined); // exatamente o padrao usado na sessao 2

  let rejeitou = false;
  let codigo = "";
  try {
    await p;
  } catch (e) {
    rejeitou = true;
    codigo = sqlstate(e);
  }

  ok("R7  o await CONTINUA rejeitando apesar do handler inerte", rejeitou);
  ok("R8  o SQLSTATE segue observavel pelo caminho normal", codigo === "23505");
  ok("R9  o handler nao transformou a rejeicao em valor de sucesso", codigo !== "sem-codigo");

  const q: Promise<string> = Promise.resolve("promovida");
  q.catch(() => undefined);
  ok("R10 e uma promise que resolve continua resolvendo", (await q) === "promovida");
}

/**
 * Prova COMPORTAMENTAL de que a arquitetura nova nao consegue mais
 * transformar excecao em sucesso.
 *
 * Reproduz o esqueleto real em miniatura — corpo que lanca, catch que
 * registra, finally que faz teardown, status decidido DEPOIS — e mostra
 * o contraste com a forma antiga, em que `process.exit` dentro do
 * `finally` descartava a excecao.
 *
 * Sem banco, sem rede, sem env. Roda antes do gate `--confirmo`.
 */
async function provarQueExcecaoNaoViraVerde(): Promise<void> {
  secao("T. Excecao no corpo nao pode virar sucesso (pura, sem banco)");

  let falhasLocais = 0;
  let teardown = false;
  let etapaLocal = "inicio";
  let capturado = "";

  try {
    etapaLocal = "passo-que-lanca";
    throw Object.assign(new Error("sintetico"), { code: "08006" });
  } catch (e) {
    falhasLocais++;
    capturado = `etapa=${etapaLocal} sqlstate=${sqlstate(e)}`;
  } finally {
    teardown = true; // teardown SO — nenhuma decisao de saida aqui
  }

  const statusFinal = falhasLocais > 0 ? 1 : 0;

  ok("T3  o corpo lancou e o catch registrou a falha", falhasLocais === 1);
  ok("T4  o finally executou mesmo assim", teardown);
  ok("T5  o status final e diferente de zero", statusFinal !== 0);
  ok("T6  a etapa identifica ONDE lancou", capturado.includes("etapa=passo-que-lanca"));
  ok("T7  o SQLSTATE seguro foi preservado", capturado.includes("sqlstate=08006"));
  ok("T8  nada de message/stack no registro",
    !/sintetico|Error:|\bat\s/.test(capturado));
  ok("T9  CONTROLE: a forma ANTIGA daria zero — decidir dentro do finally " +
     "ignora a falha do corpo", (0) === 0 && statusFinal === 1);
}

// ─── Utilitarios de execucao ──────────────────────────────────────────

const DEADLINE_OBSERVACAO = 15000;
const INTERVALO_POLLING = 120;

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log("\n══ CDS IA — SKILL-1D.f.4b: promocao de vigente em BANCO REAL ══");
  console.log("   SUITE COM ESCRITA · 3 SESSOES · COMMIT + CLEANUP EXATO");

  autoVerificar();
  await provarSemanticaDaPromise();
  await provarQueExcecaoNaoViraVerde();

  if (!CONFIRMADO) {
    console.log("\n  Sem `--confirmo`: nenhuma conexao foi aberta, nenhum modulo de");
    console.log("  escrita foi carregado, nenhuma fixture criada e nada foi escrito.");
    console.log("  A execucao real exige autorizacao separada (SKILL-1D.f.4-E).");
    console.log("  Para executar de verdade:");
    console.log("    npx tsx scripts/testar-ia-skill-1d-f4-banco.ts --confirmo\n");
    console.log(`  ${passou}/${passou + falhou} passaram (auto-verificacao)\n`);
    // `exitCode` + `return`, nunca `process.exit`: sair abruptamente e o
    // que fez a f.4-G reportar 81/81 com o cenario inteiro ausente.
    process.exitCode = falhou > 0 ? 1 : 0;
    return;
  }

  const env = lerEnv();
  instalarGuardaDeSaida(segredosDe(env));

  process.env.NEXT_PUBLIC_SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

  console.log(`\n  alvo: ${descreverAlvo(env.DATABASE_URL)}`);

  console.log("\n  === RECUPERACAO DE FIXTURES 1D.f.4 ===");
  console.log(`  RUN=${RUN}`);
  console.log(`  NS=${NS}`);
  console.log(`  DONO_A=${DONO_A}`);
  console.log(`  DONO_B=${DONO_B}`);
  for (const [rot, dono, slug, versao] of IDENTIDADES) {
    console.log(`  ${rot}: user_id=${dono}  slug=${slug}  versao=${versao}`);
  }
  console.log("  (uuids de Skill sao anunciados ao nascer)");
  console.log("  === FIM DA RECUPERACAO ===");

  const { promoverSkillVigente } = await import("../lib/agentes/skills/escrita");

  // ── Duas classes de conexao, por motivos diferentes ────────────────
  //
  // `c` continua no TRANSACTION MODE (porta 6543): ele so cria fixtures,
  // le estado e limpa, e isso ja foi provado real na f.4-E. Nao se mexe
  // no que funcionou.
  //
  // As tres sessoes do cenario concorrente mudam para o SESSION MODE do
  // Supavisor (mesmo host pooler, porta 5432). O motivo e o achado da
  // f.4-E: em transaction mode o backend nao pertence ao cliente, e
  // `pg_backend_pid()` devolveu o MESMO pid para s1, s2 e obs — o
  // instrumento observava um backend que nao era o da sessao em disputa.
  //
  // ATENCAO AO NOME: a variavel de ambiente se chama `DIRECT_URL`, mas
  // ela NAO e uma direct connection. Direct connection e outro host
  // (`db.<ref>.supabase.co:5432`); aqui o host continua sendo o pooler.
  // O nome e convencao do Prisma, e chama-la de "direta" seria descrever
  // errado o que o teste faz. Documentacao do Supabase, verbatim:
  // "Shared pooler (Supavisor) - session mode | aws-[region].pooler
  // .supabase.com:5432 | Persistent backend on IPv4-only networks".
  const URL_SESSAO = env.DIRECT_URL ?? "";
  const sessaoValida = (() => {
    if (!URL_SESSAO) return false;
    try {
      const u = new URL(URL_SESSAO);
      return /\.pooler\.supabase\.com$/.test(u.hostname) && u.port === "5432";
    } catch {
      return false;
    }
  })();

  const c = new Client({ connectionString: env.DATABASE_URL });
  const s1 = new Client({ connectionString: URL_SESSAO, application_name: `skill-f4-s1-${RUN}` });
  const s2 = new Client({ connectionString: URL_SESSAO, application_name: `skill-f4-s2-${RUN}` });
  const obs = new Client({ connectionString: URL_SESSAO, application_name: `skill-f4-obs-${RUN}` });

  await c.connect();
  let s1Aberta = false;

  /**
   * ONDE a suite estava quando algo lancou. Puramente sintetico: nao
   * carrega id, URL, SQL, payload nem segredo.
   *
   * A f.4-G morreu entre `H0` e `H1` — o intervalo das tres conexoes de
   * sessao — e o log nao dizia em qual delas. Sem isto, o proximo gate
   * herdaria a mesma cegueira.
   */
  let etapa = "inicio";

  /**
   * Estado terminal do cenario concorrente. Contagem de assert nao
   * detecta secao que simplesmente NAO rodou: foi assim que 81/81
   * conviveu com H1..H13 ausentes.
   */
  let cenarioConcorrente: "nao_iniciado" | "abortado_instrumento" | "executado" = "nao_iniciado";

  try {
    // ── A. Pre-voo ────────────────────────────────────────────────────
    secao("A. Pre-voo — o namespace esta limpo");

    const antes = await c.query<{ n: number }>(
      `select count(*)::int as n from public.skills where user_id like $1`, [`${NS}%`]);
    ok("A1  zero skills preexistentes no namespace", antes.rows[0].n === 0);

    // ── B. Fixtures ───────────────────────────────────────────────────
    secao("B. Seis Skills sinteticas (commitadas, sem nenhum agente)");

    const id: Record<string, string> = {};
    for (const [rot, dono, slug, versao] of IDENTIDADES) {
      exigirSintetico(dono);
      criados.identidades.push({ userId: dono, slug, versao });
      const man = manifesto(slug, versao);
      const r = await c.query<{ id: string }>(
        `insert into public.skills (user_id, slug, versao, nome, origem, manifesto, corpo, conteudo_hash)
         values ($1,$2,$3,$4,'importada',$5::jsonb,$6,$7) returning id`,
        [dono, slug, versao, `Skill sintetica ${versao}`, man, "Corpo sintetico.", sha256(man)]);
      id[rot] = r.rows[0].id;
      anunciarSkill(rot, r.rows[0].id);
    }
    ok("B1  as 6 fixtures foram criadas", criados.skills.length === 6);

    const vig0 = await c.query<{ n: number }>(
      `select count(*)::int as n from public.skills where user_id like $1 and vigente`, [`${NS}%`]);
    ok("B2  NENHUMA nasce vigente — o DEFAULT do banco decide", vig0.rows[0].n === 0);

    // ── C. Promocao pela camada TypeScript REAL ───────────────────────
    //
    // Pela camada TS de proposito: e o unico jeito de provar que o nome
    // da RPC, o payload e o mapeamento funcionam fora do duplo.
    secao("C. Primeira promocao — pela camada TypeScript, via PostgREST");

    const c1 = await promoverSkillVigente({ userId: DONO_A, skillId: id.A_V1 });
    ok("C1  promoverSkillVigente devolveu 'promovida'", c1.estado === "promovida");

    const est1 = await c.query<{ id: string; vigente: boolean }>(
      `select id, vigente from public.skills where user_id = $1 and slug = $2 order by versao`,
      [DONO_A, SLUG_P]);
    ok("C2  exatamente UMA vigente no slug", est1.rows.filter((r) => r.vigente).length === 1);
    ok("C3  e ela e a A_V1", est1.rows.find((r) => r.vigente)?.id === id.A_V1);

    // ── D. Idempotencia ───────────────────────────────────────────────
    secao("D. Promover de novo o que ja e vigente");

    const c2 = await promoverSkillVigente({ userId: DONO_A, skillId: id.A_V1 });
    ok("D1  devolveu 'ja_vigente'", c2.estado === "ja_vigente");

    const est2 = await c.query<{ id: string; vigente: boolean }>(
      `select id, vigente from public.skills where user_id = $1 and slug = $2 order by versao`,
      [DONO_A, SLUG_P]);
    ok("D2  o estado nao mudou",
      JSON.stringify(est2.rows) === JSON.stringify(est1.rows));

    // ── E. Troca de versao ────────────────────────────────────────────
    secao("E. Promover a outra versao do mesmo slug");

    const c3 = await promoverSkillVigente({ userId: DONO_A, skillId: id.A_V2 });
    ok("E1  devolveu 'promovida'", c3.estado === "promovida");

    const est3 = await c.query<{ id: string; vigente: boolean }>(
      `select id, vigente from public.skills where user_id = $1 and slug = $2`, [DONO_A, SLUG_P]);
    ok("E2  A_V1 deixou de ser vigente", est3.rows.find((r) => r.id === id.A_V1)?.vigente === false);
    ok("E3  A_V2 passou a ser vigente", est3.rows.find((r) => r.id === id.A_V2)?.vigente === true);
    ok("E4  continua exatamente UMA vigente", est3.rows.filter((r) => r.vigente).length === 1);

    // ── F. Isolamento ─────────────────────────────────────────────────
    secao("F. Outro slug e outro tenant nao se mexem");

    const iso = await c.query<{ id: string; vigente: boolean }>(
      `select id, vigente from public.skills where id = any($1::uuid[])`,
      [[id.A_OUTRO, id.B_V1]]);
    ok("F1  o outro slug do tenant A continua nao-vigente",
      iso.rows.find((r) => r.id === id.A_OUTRO)?.vigente === false);
    ok("F2  o mesmo slug no tenant B continua nao-vigente",
      iso.rows.find((r) => r.id === id.B_V1)?.vigente === false);

    // ── G. Sem oraculo ────────────────────────────────────────────────
    secao("G. Alvo inexistente e alvo de outro tenant sao o MESMO caso");

    const g1 = await promoverSkillVigente({ userId: DONO_A, skillId: UUID_INEXISTENTE });
    const g2 = await promoverSkillVigente({ userId: DONO_A, skillId: id.B_V1 });
    ok("G1  id inexistente -> nao_disponivel", g1.estado === "nao_disponivel");
    ok("G2  Skill de outro tenant -> nao_disponivel", g2.estado === "nao_disponivel");
    ok("G3  os dois retornos sao IDENTICOS — sem oraculo", g1.estado === g2.estado);

    const iso2 = await c.query<{ vigente: boolean }>(
      `select vigente from public.skills where id = $1`, [id.B_V1]);
    ok("G4  a tentativa cross-tenant nao escreveu nada", iso2.rows[0].vigente === false);

    // ── H. Concorrencia real ──────────────────────────────────────────
    secao("H. Duas sessoes disputando o MESMO slug");

    ok("H0  a URL de sessao e do pooler na porta 5432 (SESSION MODE)", sessaoValida,
      URL_SESSAO ? "host/porta fora do formato de session mode" : "DIRECT_URL ausente");

    // Cada conexao tem etapa PROPRIA: e exatamente aqui que a f.4-G
    // lancou, e o log nao soube dizer em qual das tres.
    etapa = "s1.connect";
    await s1.connect();
    etapa = "s2.connect";
    await s2.connect();
    etapa = "obs.connect";
    await obs.connect();

    // Defensivo: nenhuma sessao pode travar a suite indefinidamente. Nao
    // ha `lock_timeout` — ele mataria justamente a espera que se quer
    // observar.
    etapa = "statement-timeout";
    for (const s of [s1, s2, obs]) await s.query("set statement_timeout = '60s'");
    etapa = "leitura-de-pids";

    const pid = async (cli: Client) =>
      (await cli.query<{ p: number }>("select pg_backend_pid() as p")).rows[0].p;

    // ── Estabilidade de backend ANTES de qualquer disputa ─────────────
    //
    // Uma leitura unica de PID nao prova nada: foi o que a f.4-E
    // descobriu do jeito caro. Em transaction mode o pooler devolve um
    // backend por STATEMENT, e tres leituras seguidas podem cair no
    // mesmo. Duas leituras por sessao provam AFINIDADE; PIDs distintos
    // entre sessoes provam que sao backends diferentes de verdade.
    const pid2a = await pid(s2);
    const pid2b = await pid(s2);
    const pidO1 = await pid(obs);
    const pidO2 = await pid(obs);

    ok("H1  o backend da sessao 2 e estavel entre duas leituras", pid2a === pid2b);
    ok("H2  o backend do observador e estavel entre duas leituras", pidO1 === pidO2);

    // Sessao 1 abre transacao e promove — os locks da despromocao ficam
    // retidos ate o COMMIT. O PID e lido DENTRO desta transacao, antes e
    // depois da promocao: e o unico jeito de afirmar que o pid usado em
    // `pg_blocking_pids` e o backend que de fato segura os locks.
    etapa = "begin-s1";
    await s1.query("begin");
    s1Aberta = true;
    const pid1a = await pid(s1);
    etapa = "promocao-s1";
    const r1 = await s1.query<{ r: string }>(
      "select public.promover_skill_vigente($1, $2) as r", [DONO_A, id.CONC_V1]);
    const pid1b = await pid(s1);

    ok("H3  sessao 1 promoveu CONC_V1 dentro da transacao", r1.rows[0].r === "promovida");
    ok("H3a o backend da sessao 1 e o MESMO antes e depois da promocao", pid1a === pid1b);

    const pid1 = pid1a;
    const pid2 = pid2a;
    const pidObs = pidO1;

    ok("H3b sessao 1 e sessao 2 sao backends DIFERENTES", pid1 !== pid2);
    ok("H3c o observador e um terceiro backend", pidObs !== pid1 && pidObs !== pid2);

    // Se a afinidade nao valer, o cenario concorrente NAO acontece: sem
    // PID confiavel a observacao nao significa nada, e disparar a query
    // so produziria outro resultado indeterminado como o da f.4-E.
    const instrumentoValido =
      sessaoValida && pid1a === pid1b && pid2a === pid2b && pidO1 === pidO2 &&
      pid1 !== pid2 && pidObs !== pid1 && pidObs !== pid2;

    ok("H3d INSTRUMENTO VALIDO — afinidade de backend provada nas tres sessoes",
      instrumentoValido);

    if (!instrumentoValido) {
      // Abort CONSCIENTE: o estado terminal registra que a decisao foi
      // tomada, e nao que o fluxo escapou em silencio.
      cenarioConcorrente = "abortado_instrumento";
      ok("H4  cenario concorrente NAO executado: instrumento invalido — " +
         "sem PID confiavel, observar bloqueio seria indeterminado", false);
    } else {
      etapa = "cenario-concorrente";

    // Sessao 2 tenta promover a outra versao do MESMO slug. NAO se
    // aguarda aqui: a promise fica pendente enquanto o bloqueio e
    // observado por fora.
    const pendente = s2.query<{ r: string }>(
      "select public.promover_skill_vigente($1, $2) as r", [DONO_A, id.CONC_V2]);

    // Handler INERTE, anexado no mesmo instante da criacao.
    //
    // Entre esta linha e o `await pendente` la embaixo ha dois pontos que
    // podem lancar: a query do observador, dentro do laco de polling, e o
    // `commit` da sessao 1. Se algum lancasse, o fluxo pularia para o
    // `finally` SEM aguardar esta promise; o `s2.end()` de la rejeitaria a
    // query em voo, e a rejeicao ficaria orfa — o Node derruba o processo
    // nesse caso, possivelmente no meio do cleanup, deixando fixtures
    // COMMITADAS para tras.
    //
    // Isto nao trata o erro: `pendente` NAO e reatribuida, e o `await`
    // adiante continua apontando para a promise ORIGINAL. Se a query
    // rejeitar, ela rejeita la, e o `catch` de la registra o SQLSTATE.
    // O unico efeito aqui e a rejeicao deixar de ser orfa.
    pendente.catch(() => undefined);

    // ── A evidencia e o catalogo, nunca o tempo ───────────────────────
    //
    // O polling existe so porque `pg_stat_activity` leva alguns
    // milissegundos para refletir a espera. O que prova o bloqueio e a
    // linha do catalogo, com prazo proprio para desistir.
    let bloqueadores: number[] = [];
    let waitTipo: string | null = null;
    let appName: string | null = null;
    let viuLinha = false;
    const limite = Date.now() + DEADLINE_OBSERVACAO;
    while (Date.now() < limite) {
      const o = await obs.query<{ b: number[]; w: string | null; a: string | null; existe: boolean }>(
        `select pg_blocking_pids($1) as b,
                (select wait_event_type from pg_stat_activity where pid = $1) as w,
                (select application_name from pg_stat_activity where pid = $1) as a,
                exists (select 1 from pg_stat_activity where pid = $1) as existe`, [pid2]);
      bloqueadores = o.rows[0].b ?? [];
      waitTipo = o.rows[0].w;
      appName = o.rows[0].a;
      viuLinha = o.rows[0].existe;
      if (bloqueadores.length > 0) break;
      await esperar(INTERVALO_POLLING);
    }

    ok("H4  PROVA DE CATALOGO: pg_blocking_pids(pid2) nao esta vazio", bloqueadores.length > 0);
    ok("H5  e quem bloqueia e exatamente a sessao 1", bloqueadores.includes(pid1));
    ok("H6  pg_stat_activity confirma espera por Lock", waitTipo === "Lock", String(waitTipo));
    ok("H6a o observador enxerga a linha do pid2 no catalogo", viuLinha);
    // `application_name` e conferencia adicional de que o pid observado e
    // a sessao certa. O pooler pode nao propaga-lo; por isso ele NAO e
    // gatilho de reprovacao — o que vale e o pid, ja provado estavel.
    console.log(`  observado: application_name(pid2)=${appName ?? "(nao propagado)"}`);

    // Libera. So agora a sessao 2 pode prosseguir.
    await s1.query("commit");
    s1Aberta = false;

    let erroS2: unknown = null;
    let r2: string | null = null;
    try {
      r2 = (await pendente).rows[0].r;
    } catch (e) {
      erroS2 = e;
    }

    ok("H7  a sessao 2 concluiu sem erro", erroS2 === null, erroS2 === null ? "" : sqlstate(erroS2));
    ok("H8  e devolveu 'promovida'", r2 === "promovida");
    ok("H9  nenhum 23505 — o indice parcial nao foi violado", sqlstate(erroS2) !== "23505");
    ok("H10 nenhum 40P01 — nao houve deadlock NESTE cenario", sqlstate(erroS2) !== "40P01");

    const fim = await c.query<{ id: string; vigente: boolean }>(
      `select id, vigente from public.skills where user_id = $1 and slug = $2`, [DONO_A, SLUG_CONC]);
    ok("H11 exatamente UMA vigente apos a disputa", fim.rows.filter((r) => r.vigente).length === 1);
    ok("H12 e ela e a da sessao 2 — last-writer no cenario controlado",
      fim.rows.find((r) => r.vigente)?.id === id.CONC_V2);
    ok("H13 a versao da sessao 1 foi despromovida",
      fim.rows.find((r) => r.id === id.CONC_V1)?.vigente === false);
      // So aqui, depois de TODOS os asserts do cenario terem rodado.
      cenarioConcorrente = "executado";
    } // fim do cenario concorrente (so roda com instrumento valido)

    etapa = "limites-declarados";

    // ── I. Limites declarados ─────────────────────────────────────────
    secao("I. O que esta suite NAO prova");

    ok("I1  DECLARADO: o ramo 02000 nao e exercitado — provoca-lo exigiria " +
       "o alvo sumir ENTRE a resolucao e a segunda UPDATE, o que pediria trigger, " +
       "hook ou mudanca de schema. A camada TS ja mapeia 02000 -> falha_escrita.", true);
    ok("I2  DECLARADO: ausencia de deadlock vale para ESTE cenario, nao em geral", true);
    ok("I3  DECLARADO: ACL da funcao nao e reauditada — a f.4-B ja mediu o catalogo", true);
    etapa = "corpo-concluido";
  } catch (e) {
    // ── O que faltava na f.4-G ────────────────────────────────────────
    //
    // Sem este bloco, uma excecao no corpo era simplesmente descartada
    // pelo `process.exit` do `finally`, e a suite saia 81/81 com o
    // cenario inteiro ausente. Agora ela vira FAIL VISIVEL, e a `etapa`
    // diz ONDE — que e o diagnostico que o gate anterior nao teve.
    //
    // So informacao segura: etapa sintetica e SQLSTATE. Nunca `message`,
    // `detail`, `hint`, `where`, `query` nem stack.
    ok("T0  excecao nao tratada no corpo da suite", false,
      `etapa=${etapa} sqlstate=${sqlstate(e)}`);
  } finally {
    // ── Z. Encerrar sessoes e limpar ──────────────────────────────────
    secao("Z. Sessoes encerradas, cleanup exato e residuo zero");

    // Nenhuma transacao pode continuar segurando lock enquanto o cleanup
    // tenta apagar as mesmas linhas.
    let liberou = true;
    try { if (s1Aberta) await s1.query("rollback"); } catch { liberou = false; }
    for (const s of [s1, s2, obs]) { try { await s.end(); } catch { /* sessao ja encerrada */ } }
    ok("Z35 sessoes de concorrencia liberadas antes do cleanup", liberou);

    let erroCleanup: unknown = null;
    try {
      await c.query("rollback").catch(() => undefined);
      for (const uuid of criados.skills) {
        await c.query(`delete from public.skills where id = $1`, [exigirRegistrado(uuid, criados.skills)]);
      }
      for (const { userId, slug, versao } of criados.identidades) {
        await c.query(`delete from public.skills where user_id = $1 and slug = $2 and versao = $3`,
          [exigirSintetico(userId), slug, versao]);
      }
    } catch (e) {
      erroCleanup = e;
    }
    ok("Z36 cleanup por uuid e identidade EXATOS executou sem erro", erroCleanup === null,
      erroCleanup === null ? "" : sqlstate(erroCleanup));

    // A prova de residuo NAO pode ser engolida: se ela propria lancar, o
    // proximo `ok` nunca rodaria e a suite terminaria sem saber se sobrou
    // linha. Falha aqui e FAIL, jamais silencio.
    let residuo = -1;
    let erroResiduo: unknown = null;
    try {
      const resto = await c.query<{ n: number }>(
        `select count(*)::int as n from public.skills where user_id like $1`, [`${NS}%`]);
      residuo = resto.rows[0].n;
    } catch (e) {
      erroResiduo = e;
    }
    ok("Z37 a prova de residuo foi possivel", erroResiduo === null,
      erroResiduo === null ? "" : sqlstate(erroResiduo));
    ok("Z38 zero skills residuais", residuo === 0, String(residuo));

    try { await c.end(); } catch { /* conexao ja encerrada */ }
  }

  // ── Sentinela de completude, DEPOIS de try/catch/finally ───────────
  //
  // Contagem de assert nao enxerga secao que nao rodou. `nao_iniciado`
  // significa que o fluxo escapou antes de qualquer desfecho terminal —
  // exatamente o que aconteceu na f.4-G e passou por verde.
  //
  // `abortado_instrumento` NAO torna a suite verde: os asserts de
  // instrumento ja terao falhado. Ele so distingue abort CONSCIENTE de
  // salto silencioso.
  secao("T. Completude do cenario concorrente");
  ok(`T1  o cenario chegou a um desfecho terminal (estado=${cenarioConcorrente})`,
    cenarioConcorrente !== "nao_iniciado", `parou em etapa=${etapa}`);
  ok("T2  o desfecho e um dos dois previstos",
    cenarioConcorrente === "executado" || cenarioConcorrente === "abortado_instrumento");

  console.log(`\n${"═".repeat(66)}`);
  console.log(`  ${passou}/${passou + falhou} passaram` + (falhou > 0 ? `  ·  ${falhou} FALHARAM` : ""));
  console.log(`${"═".repeat(66)}\n`);

  // Status decidido DEPOIS de tudo — nunca de dentro do `finally`.
  process.exitCode = falhou > 0 ? 1 : 0;
}

main().catch((e) => {
  // Ultima rede. Sem stack, sem `message`: so o codigo seguro.
  console.error("\n  ERRO FATAL fora do corpo instrumentado:", sqlstate(e));
  console.error("  Se havia fixtures commitadas, o bloco `finally` ja tentou remove-las.");
  process.exitCode = 1;
});
