/**
 * I4P10 — a superficie do operador, ponta a ponta.
 *
 * ── O que roda de verdade ───────────────────────────────────────────
 *
 * O handler REAL da rota, com `Request` real e sessao assinada real; a
 * consulta REAL, com a projecao e a ordenacao reais. O que e dublado e
 * o cliente do Supabase — e ele e dublado de um jeito que APLICA os
 * filtros `eq`, e nao os ignora: e isso que torna o teste de isolamento
 * de tenant uma prova, e nao uma encenacao. Uma consulta que esquecesse
 * `user_id` devolveria linha do outro dono e reprovaria aqui.
 *
 * Zero rede. Zero banco. Zero marketplace.
 *
 * Rodar:  npx tsx scripts/testar-agentes-observabilidade-superficie.ts
 */
import "./_server-only-inerte";

import Module from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let passou = 0;
let falhou = 0;
function ok(nome: string, condicao: boolean, detalhe = ""): void {
  if (condicao) { passou++; console.log(`  PASS  ${nome}`); }
  else { falhou++; console.log(`  FAIL  ${nome}${detalhe ? ` — ${detalhe}` : ""}`); }
}
function secao(titulo: string): void {
  console.log(`\n── ${titulo} ${"─".repeat(Math.max(2, 60 - titulo.length))}`);
}

const RAIZ = join(__dirname, "..");
const ler = (rel: string) => readFileSync(join(RAIZ, rel), "utf8");
const semComentarios = (f: string) =>
  f.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

process.env.SESSION_SECRET ??= "segredo-de-teste-com-mais-de-32-bytes-000000";

// UUIDs porque a sessao assinada recusa `uid` que nao seja um.
const UID_A = "11111111-4a00-4000-8000-0000000000aa";
const UID_B = "22222222-4b00-4000-8000-0000000000bb";
const AG_A = "aaaaaaaa-4c00-4000-8000-00000000000a";
const AG_B = "bbbbbbbb-4c00-4000-8000-00000000000b";
const T0 = Date.parse("2026-09-26T13:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

// ─── O banco dublado ──────────────────────────────────────────────────

interface Consulta { readonly tabela: string; readonly filtros: readonly [string, unknown][] }

const TABELAS: Record<string, unknown[]> = {
  agente_ingestao_alertas: [],
  agente_ingestao_estado_esperado: [],
  agente_ingestao_monitor_lease: [],
};
const FALHAR = new Set<string>();
let consultas: Consulta[] = [];

function construtor(tabela: string) {
  const filtros: [string, unknown][] = [];
  const b = {
    select: () => b,
    order: () => b,
    limit: () => b,
    eq: (k: string, v: unknown) => { filtros.push([k, v]); return b; },
    // Thenable: o codigo de producao usa `await` direto no construtor.
    then: (resolver: (r: { data: unknown[] | null; error: unknown }) => unknown) => {
      consultas.push({ tabela, filtros: [...filtros] });
      if (FALHAR.has(tabela)) return resolver({ data: null, error: { code: "42P01" } });
      // Os `eq` sao APLICADOS. Uma consulta sem cerca de dono devolve
      // linha alheia e reprova o teste de isolamento.
      const linhas = (TABELAS[tabela] ?? []).filter((linha) =>
        filtros.every(([k, v]) => (linha as Record<string, unknown>)[k] === v));
      return resolver({ data: linhas, error: null });
    },
  };
  return b;
}

const requireOriginal = (Module as unknown as { prototype: { require: (id: string) => unknown } })
  .prototype.require;
(Module as unknown as { prototype: { require: unknown } }).prototype.require = function (
  this: unknown,
  id: string
) {
  if (typeof id === "string" && id.includes("supabase-servidor")) {
    return { getSupabaseServidor: () => ({ from: construtor }) };
  }
  return requireOriginal.apply(this, arguments as unknown as [string]);
};

// ─── Fixtures ─────────────────────────────────────────────────────────

function alerta(p: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "inc-" + (p.id ?? "1"),
    user_id: UID_A,
    agente_id: AG_A,
    tipo: "scheduler_gap",
    estado: "aberto",
    severidade_atual: "warning",
    severidade_maxima: "warning",
    causa_atual: "missing",
    aberto_em: iso(T0),
    ultimo_visto_em: iso(T0 + 60_000),
    ultima_avaliacao_em: iso(T0 + 120_000),
    resolvido_em: null,
    ocorrencias: 1,
    detalhes: { canonicalBucketId: "w5m-20260926T1300Z", streak: 2 },
    ...p,
  };
}

function limpar(): void {
  TABELAS.agente_ingestao_alertas = [];
  TABELAS.agente_ingestao_estado_esperado = [];
  TABELAS.agente_ingestao_monitor_lease = [];
  FALHAR.clear();
  consultas = [];
}

console.log("\n══ CDS IA — I4P10: a superficie do operador ══");

async function main(): Promise<void> {
  const {
    ordenarIncidentes, projetarIncidente, ROTULOS_DE_CAUSA, ROTULOS_DE_TIPO,
    VEREDICTO_DE_SAUDE,
  } = await import("../lib/agentes/observabilidade/alerta-apresentacao");
  const { TIPOS_DE_ALERTA } = await import("../lib/agentes/observabilidade/alerta");
  const { emitirTokenSessao, COOKIE_SESSAO } = await import("../lib/autenticacao");
  const rota = await import("../app/api/agentes/observabilidade/route");

  const tokenA = (await emitirTokenSessao(UID_A)).token;
  const tokenB = (await emitirTokenSessao(UID_B)).token;

  const pede = (token: string | null, query = "") =>
    new Request("http://localhost/api/agentes/observabilidade" + query, {
      method: "GET",
      headers: token === null ? {} : { cookie: `${COOKIE_SESSAO}=${token}` },
    });

  const corpoDe = async (r: Response) => (await r.json()) as Record<string, unknown>;

  // ─── A. Projecao ────────────────────────────────────────────────────
  secao("A. Projecao e minimizacao");

  {
    const p = projetarIncidente(alerta());
    ok("A1  projeta um incidente valido", p !== null);
    ok("A2  NAO carrega `user_id` — e a sessao de quem perguntou",
      p !== null && !JSON.stringify(p).includes(UID_A));
    ok("A3  NAO carrega a chave de evidencia crua",
      !JSON.stringify(projetarIncidente(alerta({ ultima_evidencia_chave: "b:w5m#a:missing" })))
        .includes("#a:missing"));
    ok("A4  NAO carrega `detalhes` inteiro",
      p !== null && !JSON.stringify(p).includes("streak\":2"));
    ok("A5  mas traz a janela, que e o que o operador precisa",
      p !== null && p.janela === "w5m-20260926T1300Z");
    ok("A6  e a sequencia, quando ha", p !== null && p.sequencia === 2);
    ok("A7  o titulo e humano, nao o enum",
      p !== null && p.titulo === ROTULOS_DE_TIPO.scheduler_gap.titulo && !p.titulo.includes("_"));
    ok("A8  e a causa tambem", p !== null && p.causaTitulo === ROTULOS_DE_CAUSA.missing);
    ok("A9  preservando o codigo tecnico para quem for investigar",
      p !== null && p.causaAtual === "missing");
  }
  {
    // Conteudo comercial nao tem caminho ate a tela nem se a linha vier
    // adulterada: a projecao e por allowlist, campo a campo.
    const sujo = projetarIncidente(alerta({
      detalhes: { canonicalBucketId: "w5m-1", textoPergunta: "qual o prazo?", accessToken: "x" },
      texto_pergunta: "qual o prazo?",
    }));
    ok("A10 conteudo comercial na linha nao chega ao operador",
      sujo !== null && !JSON.stringify(sujo).includes("prazo") &&
      !JSON.stringify(sujo).includes("accessToken"));
  }
  for (const [rot, campo] of [
    ["sem tipo", { tipo: null }], ["tipo desconhecido", { tipo: "inventado" }],
    ["severidade invalida", { severidade_atual: "gravissimo" }],
    ["estado invalido", { estado: "pendente" }],
    ["ocorrencias nao inteiras", { ocorrencias: 1.5 }],
    ["sem abertura", { aberto_em: null }],
  ] as const) {
    ok(`A11 linha ${rot} e DESCARTADA, nao exibida pela metade`,
      projetarIncidente(alerta(campo)) === null);
  }
  ok("A12 entrada que nao e objeto devolve null",
    projetarIncidente(null) === null && projetarIncidente("lixo") === null);

  // ─── B. Ordenacao e rotulos ─────────────────────────────────────────
  secao("B. Ordenacao e rotulos");

  {
    const lista = [
      projetarIncidente(alerta({ id: "w", severidade_atual: "warning", aberto_em: iso(T0) }))!,
      projetarIncidente(alerta({ id: "a", severidade_atual: "alert", aberto_em: iso(T0 + 5) }))!,
      projetarIncidente(alerta({ id: "c", severidade_atual: "critical", aberto_em: iso(T0 + 9) }))!,
    ];
    const ordenada = ordenarIncidentes(lista);
    ok("B1  critical vem antes de alert, que vem antes de warning — e nao ordem alfabetica",
      ordenada.map((i) => i.severidadeAtual).join(",") === "critical,alert,warning");
  }
  {
    const lista = [
      projetarIncidente(alerta({ id: "novo", aberto_em: iso(T0 + 600_000) }))!,
      projetarIncidente(alerta({ id: "velho", aberto_em: iso(T0) }))!,
    ];
    ok("B2  entre iguais, o mais ANTIGO primeiro",
      ordenarIncidentes(lista)[0].id === "velho");
  }
  ok("B3  os sete tipos tem rotulo humano",
    TIPOS_DE_ALERTA.every((t) => {
      const r = ROTULOS_DE_TIPO[t];
      return typeof r?.titulo === "string" && r.titulo.length > 0 && !r.titulo.includes("_");
    }));
  ok("B4  as tres causas do agendador sao DISTINTAS entre si",
    new Set([ROTULOS_DE_CAUSA.missing, ROTULOS_DE_CAUSA.incomplete, ROTULOS_DE_CAUSA.failed]).size === 3);
  ok("B5  e nenhuma delas vira um generico tipo `o cron caiu`",
    [ROTULOS_DE_CAUSA.missing, ROTULOS_DE_CAUSA.incomplete, ROTULOS_DE_CAUSA.failed]
      .every((c) => !/cron/i.test(c)));
  {
    const painel = semComentarios(ler("components/ia/monitoramento/PainelMonitoramento.tsx"));
    const mapas = painel.match(/const (?:COR|NOME)_DA_SEVERIDADE[^;]*;/g) ?? [];
    const chaves = mapas.flatMap((m) => (m.match(/^\s*(\w+):/gm) ?? []).map((c) => c.trim().replace(":", "")));
    ok("B6  a tela conhece exatamente as tres severidades do dominio, e nenhuma quarta",
      mapas.length === 2 && chaves.length === 6 &&
      chaves.every((c) => c === "critical" || c === "alert" || c === "warning"));
  }

  // ─── C. Autenticacao ────────────────────────────────────────────────
  secao("C. Autenticacao");

  limpar();
  {
    const r = await rota.GET(pede(null));
    ok("C1  sem cookie de sessao -> 401", r.status === 401);
    const r2 = await rota.GET(pede("token-inventado"));
    ok("C2  token invalido -> 401", r2.status === 401);
    ok("C3  e nenhuma consulta chegou ao banco", consultas.length === 0);
  }
  {
    const r = await rota.GET(pede(tokenA));
    ok("C4  sessao valida -> 200", r.status === 200);
    const corpo = await corpoDe(r);
    ok("C5  e o corpo nao devolve o dono de volta", !JSON.stringify(corpo).includes(UID_A));
  }
  {
    // Autoridade oferecida pelo chamador nao muda o dono consultado.
    limpar();
    await rota.GET(pede(tokenA, `?userId=${UID_B}&ownerId=${UID_B}`));
    const donos = consultas.flatMap((c) => c.filtros.filter(([k]) => k === "user_id").map(([, v]) => v));
    ok("C6  `userId` do chamador e IGNORADO como autoridade",
      donos.length === consultas.length && donos.every((d) => d === UID_A));
  }

  // ─── D. Isolamento de tenant ────────────────────────────────────────
  secao("D. Isolamento de tenant");

  limpar();
  TABELAS.agente_ingestao_alertas = [
    alerta({ id: "do-a" }),
    alerta({ id: "do-b", user_id: UID_B, agente_id: AG_B }),
  ];
  {
    const corpo = await corpoDe(await rota.GET(pede(tokenA)));
    const ids = (corpo.incidentes as { id: string }[]).map((i) => i.id);
    ok("D1  o dono A ve o incidente dele", ids.includes("do-a"));
    ok("D2  e NAO ve o do dono B", !ids.includes("do-b"));
    ok("D3  toda consulta filtra por dono",
      consultas.length > 0 && consultas.every((c) => c.filtros.some(([k]) => k === "user_id")));
  }
  {
    const corpo = await corpoDe(await rota.GET(pede(tokenB)));
    const ids = (corpo.incidentes as { id: string }[]).map((i) => i.id);
    ok("D4  o dono B ve o dele, e so o dele",
      ids.length === 1 && ids[0] === "do-b");
  }
  {
    // Agente de OUTRO dono como filtro: lista vazia, nunca dado alheio.
    const corpo = await corpoDe(await rota.GET(pede(tokenA, `?agenteId=${AG_B}`)));
    ok("D5  agenteId de outro dono devolve vazio, nao 403 revelador",
      (corpo.incidentes as unknown[]).length === 0 && corpo.ok === true);
  }
  {
    limpar();
    TABELAS.agente_ingestao_alertas = [alerta()];
    const corpo = await corpoDe(await rota.GET(pede(tokenA, "?agenteId=nao-e-uuid")));
    ok("D6  agenteId com forma errada e ignorado como filtro, nao derruba a tela",
      corpo.ok === true && (corpo.incidentes as unknown[]).length === 1);
  }

  // ─── E. Falha de leitura ────────────────────────────────────────────
  secao("E. Falha de leitura");

  for (const tabela of [
    "agente_ingestao_alertas", "agente_ingestao_estado_esperado", "agente_ingestao_monitor_lease",
  ]) {
    limpar();
    FALHAR.add(tabela);
    const r = await rota.GET(pede(tokenA));
    const corpo = await corpoDe(r);
    ok(`E1  falha em ${tabela} -> 500`, r.status === 500);
    ok(`E1b e NUNCA "nenhum alerta"`, corpo.ok === false && corpo.incidentes === undefined);
  }

  // ─── F. Estado do monitor ───────────────────────────────────────────
  secao("F. Estado do monitor");

  limpar();
  TABELAS.agente_ingestao_estado_esperado = [{
    user_id: UID_A, agente_id: AG_A, plataforma: "mercado_livre", recurso: "perguntas",
    esperado_ativo: true, esperado_desde: iso(T0),
  }];
  TABELAS.agente_ingestao_monitor_lease = [{
    user_id: UID_A, agente_id: AG_A, plataforma: "mercado_livre", recurso: "perguntas",
    adquirida_em: iso(T0 + 300_000), liberada_em: iso(T0 + 300_500), portador: "SEGREDO-INTERNO",
  }];
  {
    const corpo = await corpoDe(await rota.GET(pede(tokenA)));
    const m = (corpo.monitores as Record<string, unknown>[])[0];
    ok("F1  a configuracao declarada aparece", m?.configuracao === "ativo");
    const at = m?.atividade as Record<string, unknown>;
    ok("F2  a ultima passagem do vigia aparece",
      at?.estado === "observada" && at?.adquiridaEm === iso(T0 + 300_000));
    ok("F3  o PORTADOR do lease nunca sai", !JSON.stringify(corpo).includes("SEGREDO-INTERNO"));
  }
  {
    limpar();
    TABELAS.agente_ingestao_estado_esperado = [{
      user_id: UID_A, agente_id: AG_A, plataforma: "mercado_livre", recurso: "perguntas",
      esperado_ativo: false, esperado_desde: null,
    }];
    const corpo = await corpoDe(await rota.GET(pede(tokenA)));
    const m = (corpo.monitores as Record<string, unknown>[])[0];
    ok("F4  configuracao inativa e dita como inativa, nao como ausente",
      m?.configuracao === "inativo");
    ok("F5  e sem lease a atividade e `nunca_observada`, nao um zero qualquer",
      (m?.atividade as Record<string, unknown>)?.estado === "nunca_observada");
  }
  {
    // O vigia rodou e nao ha configuracao: o caso que o alerta de
    // configuracao ausente existe para mostrar. Nao pode sumir da tela.
    limpar();
    TABELAS.agente_ingestao_monitor_lease = [{
      user_id: UID_A, agente_id: AG_A, plataforma: "mercado_livre", recurso: "perguntas",
      adquirida_em: iso(T0), liberada_em: null,
    }];
    const corpo = await corpoDe(await rota.GET(pede(tokenA)));
    const m = (corpo.monitores as Record<string, unknown>[])[0];
    ok("F6  vigia com atividade e SEM configuracao aparece assim mesmo",
      m?.configuracao === "nao_configurado" &&
      (m?.atividade as Record<string, unknown>)?.estado === "observada");
  }
  {
    limpar();
    const corpo = await corpoDe(await rota.GET(pede(tokenA)));
    ok("F7  sem nada declarado, a lista de monitores e vazia — nao inventada",
      (corpo.monitores as unknown[]).length === 0);
  }

  // ─── G. Zero alertas NAO e saude ────────────────────────────────────
  secao("G. Zero alertas nao e saude");

  {
    limpar();
    const corpo = await corpoDe(await rota.GET(pede(tokenA)));
    ok("G1  sem incidentes, a API nao emite veredito de saude",
      corpo.veredictoDeSaude === VEREDICTO_DE_SAUDE && VEREDICTO_DE_SAUDE === "indisponivel");
    ok("G2  e nao existe campo dizendo que esta tudo bem",
      !/\"(saudavel|saudável|tudoOk|healthy)\"/i.test(JSON.stringify(corpo)));
  }
  {
    const painel = semComentarios(ler("components/ia/monitoramento/PainelMonitoramento.tsx"));
    // A ressalva da propria tela contem "tudo certo" — de proposito. O
    // oraculo tem de procurar AFIRMACAO, e nao casar com a negacao dela.
    const semRessalva = painel
      .replace(/não é o mesmo que estar tudo certo/gi, "")
      .replace(/não que o agendador[^"]*/gi, "");
    ok("G3  a tela nao afirma saude em lugar nenhum",
      !/tudo\s+(certo|ok|bem)|tudo\s+saud|sistema\s+saud|est[áa]\s+saud/i.test(semRessalva));
    ok("G4  e o vazio diz o que sabe: que nao ha incidente REGISTRADO",
      painel.includes("Nenhum incidente aberto"));
    ok("G5  o vazio avisa explicitamente que isso nao e saude",
      /não é o mesmo que estar tudo certo/i.test(painel));
    ok("G6  a tela distingue os cinco estados",
      painel.includes("Carregando") &&
      painel.includes("Não foi possível ler o monitoramento") &&
      painel.includes("Nenhum incidente aberto") &&
      painel.includes("Monitor ainda não configurado") &&
      painel.includes("nunca_observada"));
    ok("G7  e nao conclui saude do agendador a partir do lease",
      /não que o agendador/i.test(painel));
  }

  // ─── H. Somente leitura ─────────────────────────────────────────────
  secao("H. Somente leitura");

  {
    const rotaFonte = semComentarios(ler("app/api/agentes/observabilidade/route.ts"));
    ok("H1  a rota exporta SOMENTE GET",
      /export async function GET/.test(rotaFonte) &&
      !/export async function (POST|PUT|PATCH|DELETE)/.test(rotaFonte));
    const painel = semComentarios(ler("components/ia/monitoramento/PainelMonitoramento.tsx"));
    ok("H2  a tela so faz GET",
      !/method:\s*"(POST|PUT|PATCH|DELETE)"/i.test(painel));
    ok("H3  e nao oferece resolver, silenciar nem apagar",
      !/onClick/.test(painel) && !/<button/i.test(painel));
  }
  {
    // ── CONTROLE DE ESCRITOR UNICO ────────────────────────────────
    //
    // A tabela de alertas so pode ser escrita pelo repositorio do
    // monitor. Um `insert`/`update` novo em qualquer outro arquivo
    // reprova aqui — inclusive se vier da superficie deste gate.
    const PERMITIDO = "lib/agentes/observabilidade/alerta-repositorio.ts";
    const alvos = [
      "lib/agentes/observabilidade/alerta-consulta.ts",
      "lib/agentes/observabilidade/alerta-apresentacao.ts",
      "app/api/agentes/observabilidade/route.ts",
      "components/ia/monitoramento/PainelMonitoramento.tsx",
      "app/(app)/ia/monitoramento/page.tsx",
    ];
    for (const alvo of alvos) {
      const fonte = semComentarios(ler(alvo));
      ok(`H4  ${alvo.split("/").pop()} nao escreve em tabela nenhuma`,
        !fonte.includes(".insert(") && !fonte.includes(".update(") &&
        !fonte.includes(".upsert(") && !fonte.includes(".delete(") &&
        !fonte.includes(".rpc("));
    }
    const repo = semComentarios(ler(PERMITIDO));
    ok("H5  e o repositorio do monitor continua sendo o unico que escreve",
      repo.includes(".insert(") && repo.includes(".update("));
  }

  // ─── I. Seguranca estatica ──────────────────────────────────────────
  secao("I. Seguranca estatica");

  for (const f of [
    "lib/agentes/observabilidade/alerta-consulta.ts",
    "lib/agentes/observabilidade/alerta-apresentacao.ts",
    "app/api/agentes/observabilidade/route.ts",
    "components/ia/monitoramento/PainelMonitoramento.tsx",
  ]) {
    const s = semComentarios(ler(f));
    ok(`I1  ${f.split("/").pop()} nao chama provedor nem n8n`,
      !s.includes("mercado-livre") && !s.includes("ml-auth") &&
      !s.includes("ponte-n8n") && !s.includes("N8N_"));
  }
  {
    const consulta = semComentarios(ler("lib/agentes/observabilidade/alerta-consulta.ts"));
    ok("I2  a consulta declara `server-only`", consulta.includes("server-only"));
    const literal = consulta.match(/const COLUNAS_ALERTA =([\s\S]*?);/)?.[1] ?? "";
    ok("I3  e a minimizacao comeca no SELECT",
      literal.length > 0 && !consulta.includes("select(\"*\")") &&
      !literal.includes("user_id") &&
      !literal.includes("ultima_evidencia_chave") &&
      !literal.includes("evidencias_saudaveis"));
    const apresentacao = semComentarios(ler("lib/agentes/observabilidade/alerta-apresentacao.ts"));
    ok("I4  a apresentacao e PURA: sem supabase, sem server-only",
      !apresentacao.includes("supabase") && !apresentacao.includes("server-only"));
  }
  ok("I5  a area nova esta na navegacao existente, e nao numa aplicacao a parte",
    ler("components/ia/SubNavIA.tsx").includes('href: "/ia/monitoramento"'));
}

void main().then(() => {
  console.log(`\n── placar ${"─".repeat(54)}`);
  console.log(`  PASS ${passou}   FAIL ${falhou}\n`);
  if (falhou > 0) process.exitCode = 1;
});
