/**
 * Suite da observabilidade de IA dos agentes — AGENTES-FASE1E-e.
 *
 * SEM banco, SEM rede, SEM provedor real, SEM chamada de IA.
 *
 * ── O que e comportamental e o que e estrutural ─────────────────────
 * Quase tudo aqui e exercitado de verdade: o wrapper recebe um
 * adaptador dublê e um registrador espião, e os eventos sao inspecionados
 * um a um.
 *
 * A EXCECAO, declarada e nao disfarcada: o tratamento de `23505` mora
 * dentro de `criarRegistradorSupabase()`, que so existe contra um banco
 * real. Essa parte e provada por inspecao de FONTE com ancora e controle
 * negativo — mesma tecnica usada para o repasse de `timeoutMs` na 1E-d,
 * e pelo mesmo motivo: o cliente e construido internamente e nao e
 * injetavel. Chamar isso de teste de comportamento seria mentira.
 */
import { readFileSync } from "fs";
import { join } from "path";

import {
  criarAdaptadorObservavel,
  identidadeDoContexto,
  calcularCustoUsd,
  TABELA_CHAMADAS_IA,
} from "../lib/agentes/observabilidade-ia";
import { validarAnaliseVendasIA, SCHEMA_ANALISE_VENDAS_IA } from "../lib/agentes/ia/contrato-analise";
import { ErroProvedorIA } from "../lib/ai-gateway/erros";
import type { ChamadaIARegistravel, IdentidadeChamadaIA, RegistrarChamadaIA } from "../lib/agentes/observabilidade-ia";
import type { AdaptadorIA, PedidoIA, RespostaEstruturadaIA } from "../lib/agentes/ia/tipos";
import type { ContextoTarefa } from "../lib/agentes/tipos-execucao";

// ── Armadilha de rede ─────────────────────────────────────────────────
let chamadasDeRede = 0;
(globalThis as unknown as { fetch: unknown }).fetch = (...args: unknown[]) => {
  chamadasDeRede++;
  throw new Error(`suite 1E-e: rede proibida (${String(args[0]).slice(0, 50)})`);
};

const RAIZ = join(__dirname, "..");
const FONTE_OBS = readFileSync(join(RAIZ, "lib", "agentes", "observabilidade-ia.ts"), "utf8");
const FONTE_WIRING = readFileSync(join(RAIZ, "lib", "agentes", "ativacao-ia.ts"), "utf8");
const FONTE_MIGRATION = readFileSync(join(RAIZ, "supabase", "migrations", "20260919_agentes_ia_chamadas.sql"), "utf8");

let passou = 0;
let falhou = 0;
function ok(nome: string, condicao: boolean) {
  if (condicao) passou++;
  else { falhou++; console.error(`  x ${nome}`); }
}

function semComentarios(f: string): string {
  let s = "", i = 0, d: string | null = null;
  while (i < f.length) {
    const c = f[i], n = f[i + 1];
    if (d !== null) { s += c; if (c === "\\") { s += f[i + 1] ?? ""; i += 2; continue; } if (c === d) d = null; i++; continue; }
    if (c === '"' || c === "'" || c === "`") { d = c; s += c; i++; continue; }
    if (c === "/" && n === "/") { while (i < f.length && f[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < f.length && !(f[i] === "*" && f[i + 1] === "/")) i++; i += 2; s += " "; continue; }
    s += c; i++;
  }
  return s;
}
const COD_OBS = semComentarios(FONTE_OBS);
const COD_WIRING = semComentarios(FONTE_WIRING);

/** Captura console.warn/error sem perder o comportamento real. */
function capturarLog<T>(acao: () => T): { valor: T; warns: string[]; errors: string[] } {
  const warns: string[] = [], errors: string[] = [];
  const w = console.warn, e = console.error;
  console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { errors.push(a.map(String).join(" ")); };
  try { return { valor: acao(), warns, errors }; }
  finally { console.warn = w; console.error = e; }
}
async function capturarLogAsync<T>(acao: () => Promise<T>) {
  const warns: string[] = [], errors: string[] = [];
  const w = console.warn, e = console.error;
  console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { errors.push(a.map(String).join(" ")); };
  try {
    const valor = await acao().then((v) => ({ ok: true, v }), (err) => ({ ok: false, err }));
    return { ...valor, warns, errors } as { ok: boolean; v?: T; err?: unknown; warns: string[]; errors: string[] };
  } finally { console.warn = w; console.error = e; }
}

const CONTEXTO: ContextoTarefa = {
  tarefaId: "11111111-1111-1111-1111-111111111111",
  agenteId: "22222222-2222-2222-2222-222222222222",
  userId: "33333333-3333-3333-3333-333333333333",
  tipo: "analise_vendas",
  entrada: {},
  tentativa: 1,
  maxTentativas: 3,
};

function pedido(): PedidoIA<ReturnType<typeof validarAnaliseVendasIA>> {
  return {
    instrucao: "INSTRUCAO-SECRETA-QUE-NAO-PODE-SER-PERSISTIDA",
    dados: JSON.stringify({ totais: { pedidosPagos: 1 }, segredo: "DADOS-QUE-NAO-PODEM-SER-PERSISTIDOS" }),
    schema: SCHEMA_ANALISE_VENDAS_IA,
    validar: validarAnaliseVendasIA,
  };
}

/** Espiao de registrador: guarda eventos, nunca escreve nada. */
function espiao(opcoes: { falhar?: boolean } = {}) {
  const eventos: ChamadaIARegistravel[] = [];
  const registrar: RegistrarChamadaIA = async (e) => {
    eventos.push(e);
    if (opcoes.falhar) throw new Error("INSERT simulado falhou");
  };
  return { eventos, registrar };
}

/** Adaptador dublê: registra o pedido recebido e devolve/lança. */
function adaptadorFalso(opcoes: {
  erro?: unknown; modelo?: string; tokensEntrada?: number; tokensSaida?: number; tempoMs?: number;
} = {}) {
  const pedidos: PedidoIA<unknown>[] = [];
  const adaptador: AdaptadorIA = async <T>(p: PedidoIA<T>): Promise<RespostaEstruturadaIA<T>> => {
    pedidos.push(p as PedidoIA<unknown>);
    if (opcoes.erro !== undefined) throw opcoes.erro;
    return {
      conteudo: p.validar({ resumo: "r", destaques: [], alertas: [] }),
      provedor: "anthropic",
      modelo: opcoes.modelo ?? "claude-sonnet-5",
      tokensEntrada: opcoes.tokensEntrada ?? 1881,
      tokensSaida: opcoes.tokensSaida ?? 531,
      tempoMs: opcoes.tempoMs ?? 8243,
    };
  };
  return { adaptador, pedidos };
}

const DECLARADO = { provedor: "anthropic" as const, modelo: "claude-sonnet-5" };

async function main() {
  console.log("\nAGENTES-FASE1E-e — observabilidade de IA (sem banco, sem rede)\n");

  // ═══ A. UMA CHAMADA = UMA LINHA ═══════════════════════════════════
  console.log("A. Granularidade e sequencia");
  {
    const { eventos, registrar } = espiao();
    const { adaptador } = adaptadorFalso();
    const obs = criarAdaptadorObservavel(adaptador, identidadeDoContexto(CONTEXTO), registrar, DECLARADO);
    await obs(pedido());
    ok("A1 uma chamada gera exatamente UM evento", eventos.length === 1);
    ok("A2 sequencia comeca em 1", eventos[0].sequencia === 1);

    await obs(pedido());
    ok("A3 segunda chamada na MESMA execucao gera sequencia 2", eventos.length === 2 && eventos[1].sequencia === 2);
    ok("A4 as duas compartilham tarefa e tentativa",
       eventos[0].identidade.tarefaId === eventos[1].identidade.tarefaId &&
       eventos[0].identidade.tentativa === eventos[1].identidade.tentativa);

    // Retry da tarefa = novo claim = nova tentativa = novo wrapper.
    const { eventos: ev2, registrar: reg2 } = espiao();
    const obs2 = criarAdaptadorObservavel(adaptadorFalso().adaptador,
      identidadeDoContexto({ ...CONTEXTO, tentativa: 2 }), reg2, DECLARADO);
    await obs2(pedido());
    ok("A5 retry da tarefa muda `tentativa`", ev2[0].identidade.tentativa === 2);
    ok("A6 e a sequencia reinicia em 1 (contador por execucao)", ev2[0].sequencia === 1);
    ok("A7 a tripla (tarefa, tentativa, sequencia) distingue as 3 chamadas",
       new Set([...eventos, ...ev2].map((e) => `${e.identidade.tarefaId}|${e.identidade.tentativa}|${e.sequencia}`)).size === 3);
  }

  // ═══ B. IDENTIDADE ════════════════════════════════════════════════
  console.log("B. Identidade vem do claim");
  {
    const id = identidadeDoContexto(CONTEXTO);
    ok("B1 identidade tem exatamente os 5 campos previstos",
       JSON.stringify(Object.keys(id).sort()) === JSON.stringify(["agenteId", "tarefaId", "tentativa", "tipoTarefa", "userId"]));
    ok("B2 todos vem do contexto", id.userId === CONTEXTO.userId && id.agenteId === CONTEXTO.agenteId &&
       id.tarefaId === CONTEXTO.tarefaId && id.tipoTarefa === CONTEXTO.tipo && id.tentativa === CONTEXTO.tentativa);

    // Entrada envenenada nao muda nada: `identidadeDoContexto` nem olha.
    const sujo = { ...CONTEXTO, entrada: { userId: "INTRUSO", user_id: "INTRUSO", tenantId: "INTRUSO" } };
    const idSujo = identidadeDoContexto(sujo);
    ok("B3 ANCORA: a entrada REALMENTE carrega userId plantado", "userId" in sujo.entrada);
    ok("B4 input com userId NAO altera a identidade", JSON.stringify(idSujo) === JSON.stringify(id));
    ok("B5 `identidadeDoContexto` nem le `entrada`", !/contexto\.entrada/.test(COD_OBS));
  }

  // ═══ C. O ADAPTADOR INTERNO CONTINUA CEGO ════════════════════════
  console.log("C. Adaptador interno nao recebe identidade");
  {
    const { eventos, registrar } = espiao();
    const { adaptador, pedidos } = adaptadorFalso();
    await criarAdaptadorObservavel(adaptador, identidadeDoContexto(CONTEXTO), registrar, DECLARADO)(pedido());
    ok("C1 o adaptador recebeu exatamente 1 pedido", pedidos.length === 1);
    ok("C2 o pedido tem SO os 4 campos do contrato",
       JSON.stringify(Object.keys(pedidos[0]).sort()) === JSON.stringify(["dados", "instrucao", "schema", "validar"]));
    const visto = JSON.stringify({ k: Object.keys(pedidos[0]), d: pedidos[0].dados, i: pedidos[0].instrucao });
    for (const k of ["userId", "user_id", "agenteId", "tarefaId", "tentativa"]) {
      ok(`C3 "${k}" nao chega ao adaptador`, !visto.includes(k));
    }
    ok("C4 o userId real do contexto nao chega ao adaptador", !visto.includes(CONTEXTO.userId));
    ok("C5 o evento registrado, esse sim, tem a identidade", eventos[0].identidade.userId === CONTEXTO.userId);
  }

  // ═══ D. SUCESSO: o que e registrado ══════════════════════════════
  console.log("D. Evento de sucesso");
  {
    const { eventos, registrar } = espiao();
    await criarAdaptadorObservavel(adaptadorFalso().adaptador, identidadeDoContexto(CONTEXTO), registrar, DECLARADO)(pedido());
    const e = eventos[0];
    ok("D1 status sucesso, sem tipo_erro", e.status === "sucesso" && e.tipoErro === undefined);
    ok("D2 provedor/modelo vem da RESPOSTA (nao do declarado)", e.provedor === "anthropic" && e.modelo === "claude-sonnet-5");
    ok("D3 tokens e tempo propagados", e.tokensEntrada === 1881 && e.tokensSaida === 531 && e.tempoMs === 8243);
    ok("D4 o evento tem exatamente os campos previstos, e nenhum a mais",
       JSON.stringify(Object.keys(e).sort()) ===
       JSON.stringify(["identidade", "modelo", "provedor", "sequencia", "status", "tempoMs", "tokensEntrada", "tokensSaida"]));

    // O que NAO pode existir no evento.
    const txt = JSON.stringify(e);
    for (const [rot, agulha] of [["instrucao", "INSTRUCAO-SECRETA"], ["dados", "DADOS-QUE-NAO-PODEM"],
                                 ["resumo", '"resumo"'], ["destaques", "destaques"], ["alertas", "alertas"]] as const) {
      ok(`D5 ${rot} NAO e persistido`, !txt.includes(agulha));
    }
    ok("D6 o tipo do evento nao tem campo de conteudo algum",
       !/prompt|instrucao|dados|resposta|conteudo|resumo|destaques|alertas/.test(
         (COD_OBS.match(/export interface ChamadaIARegistravel \{[\s\S]*?\n\}/) ?? [""])[0]));
    ok("D7 CONTROLE NEGATIVO: os detectores achariam se estivesse la",
       JSON.stringify({ instrucao: "INSTRUCAO-SECRETA" }).includes("INSTRUCAO-SECRETA"));
  }

  // ═══ E. CUSTO ═════════════════════════════════════════════════════
  console.log("E. Custo: zero e desconhecido sao coisas diferentes");
  {
    const r = capturarLog(() => calcularCustoUsd("claude-sonnet-5", 1881, 531));
    ok("E1 claude-sonnet-5 1881/531 => 0.013608", r.valor === 0.013608);
    ok("E2 e sem nenhum warn", r.warns.length === 0);

    const d = capturarLog(() => calcularCustoUsd("modelo-inexistente-xyz", 1000, 1000));
    ok("E3 modelo desconhecido => NULL, nunca 0", d.valor === null);
    ok("E4 e emite warn EXPLICITO nomeando o modelo",
       d.warns.length >= 1 && d.warns.join(" ").includes("modelo-inexistente-xyz"));
    ok("E5 o warn explica que NAO e zero", d.warns.join(" ").includes("nao como 0"));
    ok("E6 zero de verdade continua sendo 0", capturarLog(() => calcularCustoUsd("claude-sonnet-5", 0, 0)).valor === 0);
    ok("E7 o custo e calculado no registrador, nunca recebido de fora",
       !/custo/i.test((COD_OBS.match(/export interface ChamadaIARegistravel \{[\s\S]*?\n\}/) ?? [""])[0]) &&
       /custo_usd: calcularCustoUsd\(/.test(COD_OBS));
    ok("E8 e o calculo consulta `modeloTemPrecoCadastrado` ANTES",
       COD_OBS.indexOf("modeloTemPrecoCadastrado(modelo)") < COD_OBS.indexOf("return estimarCustoUsd("));
  }

  // ═══ F. ERRO ══════════════════════════════════════════════════════
  console.log("F. Evento de erro");
  {
    const { eventos, registrar } = espiao();
    const { adaptador } = adaptadorFalso({ erro: new ErroProvedorIA("validation", "JSON quebrado") });
    const obs = criarAdaptadorObservavel(adaptador, identidadeDoContexto(CONTEXTO), registrar, DECLARADO);
    const r = await obs(pedido()).then(() => ({ lancou: false, erro: undefined as unknown }), (e: unknown) => ({ lancou: true, erro: e }));

    ok("F1 o erro do provedor SOBE (fail-closed preservado)", r.lancou && r.erro instanceof ErroProvedorIA);
    ok("F2 e mesmo assim a chamada foi registrada", eventos.length === 1);
    ok("F3 status erro com tipo_erro preenchido", eventos[0].status === "erro" && eventos[0].tipoErro === "validation");
    ok("F4 provedor/modelo vem do DECLARADO (a resposta nao chegou)",
       eventos[0].provedor === "anthropic" && eventos[0].modelo === "claude-sonnet-5");
    ok("F5 o modelo registrado NAO e um rotulo inventado", eventos[0].modelo !== "(indisponivel)" && eventos[0].modelo !== "");

    // Erro que NAO e de provedor nao vira linha de contabilidade.
    const { eventos: ev2, registrar: reg2 } = espiao();
    const obs2 = criarAdaptadorObservavel(adaptadorFalso({ erro: new TypeError("bug nosso") }).adaptador,
      identidadeDoContexto(CONTEXTO), reg2, DECLARADO);
    const r2 = await obs2(pedido()).then(() => ({ lancou: false }), () => ({ lancou: true }));
    ok("F6 erro que nao e ErroProvedorIA nao vira linha", ev2.length === 0);
    ok("F7 mas continua subindo", r2.lancou);
  }

  // ═══ G. FALHA DO REGISTRO NAO DERRUBA A TAREFA ═══════════════════
  console.log("G. Falha do INSERT");
  {
    const { eventos, registrar } = espiao({ falhar: true });
    const obs = criarAdaptadorObservavel(adaptadorFalso().adaptador, identidadeDoContexto(CONTEXTO), registrar, DECLARADO);
    const r = await capturarLogAsync(() => obs(pedido()));
    ok("G1 a resposta VALIDA e devolvida mesmo com o registro falhando", r.ok === true);
    ok("G2 o registrador foi mesmo chamado", eventos.length === 1);
    ok("G3 a falha NAO e silenciosa: gera console.error", r.errors.length >= 1);
    ok("G4 o log identifica tarefa/tentativa/sequencia",
       r.errors.join(" ").includes(CONTEXTO.tarefaId) && /sequencia=1/.test(r.errors.join(" ")));
    ok("G5 o log diz que a tarefa nao foi interrompida ou nomeia a falha",
       /falha ao registrar|NAO foi interrompida/i.test(r.errors.join(" ")));
  }

  // ═══ H. 23505 e persistencia (prova ESTRUTURAL, declarada) ═══════
  console.log("H. Idempotencia e persistencia (estrutural)");
  {
    ok("H0 ANCORA: fonte lida e nao truncada", COD_OBS.includes("export function criarRegistradorSupabase") && COD_OBS.length > 1500);
    ok("H1 23505 e tratado como JA REGISTRADO, nao como falha", /error\.code === "23505"\) return;/.test(COD_OBS));
    ok("H2 e o retorno acontece ANTES do console.error",
       COD_OBS.indexOf('"23505"') < COD_OBS.indexOf("INSERT em ${TABELA_CHAMADAS_IA} falhou"));
    ok("H3 o registrador NUNCA lanca (try/catch envolvendo tudo)", /catch \(err\) \{[\s\S]{0,400}console\.error/.test(COD_OBS));
    ok("H4 escreve na tabela certa", /\.from\(TABELA_CHAMADAS_IA\)/.test(COD_OBS) && TABELA_CHAMADAS_IA === "agentes_ia_chamadas");
    ok("H5 o cliente entra por import DINAMICO (nao arrasta server-only)",
       /await import\("@\/lib\/estudio-anuncios\/supabase-servidor"\)/.test(COD_OBS) &&
       !/^import[^\n]*supabase-servidor/m.test(COD_OBS));
    ok("H6 CONTROLE NEGATIVO: o predicado do 23505 falha se o codigo mudar",
       !/error\.code === "23505"\) return;/.test('if (error.code === "23506") return;'));
  }

  // ═══ I. MIGRATION ═════════════════════════════════════════════════
  console.log("I. Migration");
  {
    const m = FONTE_MIGRATION;
    ok("I0 ANCORA: migration lida", m.includes("create table if not exists public.agentes_ia_chamadas") && m.length > 2000);
    ok("I1 custo_usd e NULLABLE", /custo_usd\s+numeric\(12, 6\) null/.test(m));
    ok("I2 e o CHECK aceita NULL", /custo_usd is null or custo_usd >= 0/.test(m));
    ok("I3 UNIQUE (tarefa_id, tentativa, sequencia)", /unique \(tarefa_id, tentativa, sequencia\)/.test(m));
    ok("I4 FKs para agentes e agente_tarefas com CASCADE",
       /references public\.agentes\(id\)\s+on delete cascade/.test(m) &&
       /references public\.agente_tarefas\(id\) on delete cascade/.test(m));
    ok("I5 provedor com os 5 valores de ProvedorIA",
       /provedor in \('openai', 'anthropic', 'google', 'fake', 'internal'\)/.test(m));
    ok("I6 tipo_erro com os 6 valores de TipoErroIA",
       /'transient', 'auth', 'rate_limit', 'conteudo_rejeitado', 'validation', 'unknown'/.test(m));
    ok("I7 invariante bicondicional status/tipo_erro", /\(status = 'erro'\) = \(tipo_erro is not null\)/.test(m));
    ok("I8 REVOKE de public, anon e authenticated",
       /revoke all on public\.agentes_ia_chamadas from public;/.test(m) &&
       /from anon;/.test(m) && /from authenticated;/.test(m));
    ok("I9 grant SO de select+insert a service_role, sem update/delete",
       /grant select, insert on public\.agentes_ia_chamadas to service_role;/.test(m) &&
       !/grant[^;]*update[^;]*to service_role/i.test(m) && !/grant[^;]*delete[^;]*to service_role/i.test(m));
    ok("I10 os dois indices de dashboard", /\(user_id, criado_em desc\)/.test(m) && /\(criado_em desc\)/.test(m));
    ok("I11 nenhuma coluna de conteudo", !/\b(prompt|instrucao|dados_enviados|resposta|resumo|destaques|alertas|anuncio|order_sn)\s+(text|jsonb)/.test(m));
    ok("I12 nao habilita RLS (convencao do projeto)", !/enable row level security/i.test(m));
    ok("I13 nao toca central_ia_consumo nem tabelas do Estudio",
       !/alter table[^;]*central_ia_consumo/i.test(m) && !/alter table[^;]*estudio_anuncios/i.test(m));
  }

  // ═══ J. WIRING ════════════════════════════════════════════════════
  console.log("J. Wiring");
  {
    ok("J1 o decorator monta a identidade a partir do CONTEXTO", /identidadeDoContexto\(contexto\)/.test(COD_WIRING));
    ok("J2 a identidade vai para o interpretador, nao para o pedido",
       /interpretar\(\s*analise as unknown as AnaliseVendasDeterministica,\s*identidadeDoContexto\(contexto\)\s*\)/.test(COD_WIRING));
    ok("J3 so o caminho REAL e observado (o fake nao gera contabilidade)",
       /criarAdaptadorObservavel\(/.test(COD_WIRING) &&
       COD_WIRING.indexOf("criarAdaptadorObservavel(") > COD_WIRING.indexOf("if (!provedorRealHabilitado())"));
    ok("J4 observabilidade entra por import dinamico", /await import\("@\/lib\/agentes\/observabilidade-ia"\)/.test(COD_WIRING));
    ok("J5 o registry NAO precisou mudar (fabrica continua sem argumento)",
       /criarInterpretadorDeVendas\(\): InterpretarAnaliseDeVendas \| null/.test(COD_WIRING));
  }

  // ═══ K. PUREZA / ZERO ESTUDIO / ZERO REDE ════════════════════════
  console.log("K. Pureza e fronteiras");
  {
    for (const [rot, re] of [
      ["central_ia_consumo", /central_ia_consumo/],
      ["registro.ts do Estudio", /registrarConsumo|registrarPrompt|ai-gateway\/registro/],
      ["projetoId/jobId", /\bprojetoId\b|\bjobId\b/],
      ["SDK de provedor", /@anthropic-ai|@google\/genai|openai/i],
      ["fetch", /\bfetch\s*\(/],
      ["process.env", /process\.env/],
      ["SQL cru", /\bfrom\s+public\.|CREATE TABLE/i],
      ["tools", /\btools\s*:|\btool_choice\b/],
    ] as const) {
      ok(`K1 observabilidade-ia.ts sem ${rot}`, !re.test(COD_OBS));
    }
    ok("K2 CONTROLE NEGATIVO: os padroes acham em amostra",
       [/central_ia_consumo/, /\bjobId\b/, /\bfetch\s*\(/, /process\.env/].every((re) =>
         re.test("central_ia_consumo jobId fetch() process.env")));
    const carregados = Object.keys(require.cache).map((p) => p.replace(/\\/g, "/"));
    ok("K3 ANCORA: o modulo esta no grafo", carregados.some((p) => p.includes("/lib/agentes/observabilidade-ia.ts")));
    ok("K4 nenhum SDK de IA carregado", !carregados.some((p) => /@anthropic-ai|@google\/genai/.test(p)));
    ok("K5 nenhum cliente Supabase carregado", !carregados.some((p) => /@supabase|supabase-servidor/.test(p)));
    ok("K6 zero chamadas de rede", chamadasDeRede === 0);
  }

  const total = passou + falhou;
  console.log(`\n${"=".repeat(62)}`);
  console.log(`AGENTES-FASE1E-e — observabilidade de IA:  ${passou}/${total} passaram`);
  if (falhou > 0) { console.log(`${falhou} FALHARAM`); process.exitCode = 1; }
  else console.log("TODOS OS ASSERTS PASSARAM");
  console.log("=".repeat(62));
}

main().catch((e) => {
  console.error("ERRO NAO TRATADO:", e instanceof Error ? e.message.slice(0, 300) : "desconhecido");
  process.exitCode = 1;
});
