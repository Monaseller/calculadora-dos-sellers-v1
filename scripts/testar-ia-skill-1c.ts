/**
 * CDS IA — SKILL-1C. Suite do motor de diagnostico de pre-requisitos.
 *
 * Prova por EXECUCAO da funcao pura, e por leitura de fonte apenas onde
 * a garantia e estrutural (ausencia de I/O, de LLM, de identificador de
 * dono). Toda varredura de fonte tem CONTROLE NEGATIVO.
 *
 * O caso que define a fase esta em L: Shopee conectada e valida NAO
 * prova Shopee Chat autorizado.
 *
 * Rodar:  npx tsx scripts/testar-ia-skill-1c.ts
 * Sem rede, sem banco, sem IA, sem escrita.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  COBERTURAS_RECURSO,
  ESTADOS_DIAGNOSTICO,
  SITUACOES_CONFIGURACAO,
  TIPOS_ALVO,
  diagnosticarSkill,
  type Diagnostico,
  type EntradaDiagnostico,
  type FatoConexao,
  type FatoConfiguracao,
  type FatoFuncao,
  type FatoPermissao,
  type Pendencia,
} from "../lib/ia/skills/diagnostico";

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
const ler = (rel: string) => readFileSync(join(RAIZ, rel), "utf8");
const existe = (rel: string) => existsSync(join(RAIZ, rel));
const semComentarios = (f: string) =>
  f.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const FONTE = ler("lib/ia/skills/diagnostico.ts");
const CODIGO = semComentarios(FONTE);

// ─── Fixtures ─────────────────────────────────────────────────────────

/** Skill minima. `requer` e o unico campo que o motor consome. */
const skill = (requer?: EntradaDiagnostico["skill"]["requer"]): EntradaDiagnostico["skill"] => ({
  id: "atendimento-shopee",
  ...(requer === undefined ? {} : { requer }),
});

const entrada = (p: Partial<EntradaDiagnostico> = {}): EntradaDiagnostico => ({
  skill: skill(),
  funcoes: [],
  permissoes: [],
  conexoes: [],
  ...p,
});

const F = (id: string, ex = true): FatoFuncao => ({ id, existe: ex });
const P = (funcaoId: string, nivel: FatoPermissao["nivel"]): FatoPermissao => ({ funcaoId, nivel });
const C = (
  plataforma: string,
  recurso: string,
  estado: FatoConexao["estado"] = "conectada",
  cobertura: FatoConexao["cobertura"] = "confirmada"
): FatoConexao => ({ plataforma, recurso, estado, cobertura });
const CFG = (
  chave: string,
  situacao: FatoConfiguracao["situacao"],
  obrigatoria = true,
  plataforma = "shopee",
  recurso = "chat"
): FatoConfiguracao => ({ plataforma, recurso, chave, situacao, obrigatoria });

const CONEXAO_CHAT = { plataforma: "shopee", recurso: "chat", obrigatoria: true } as const;

const estados = (d: Diagnostico) => [...d.bloqueios, ...d.limitacoes].map((p) => p.estado);
const alvos = (ps: readonly Pendencia[]) => ps.map((p) => p.alvo);
const tem = (d: Diagnostico, estado: string, alvo: string) =>
  [...d.bloqueios, ...d.limitacoes].some((p) => p.estado === estado && p.alvo === alvo);

console.log("\n══ CDS IA — SKILL-1C: motor de diagnostico ══");

// ─── A. Dominios ──────────────────────────────────────────────────────

secao("A. Dominios fechados");

ok("A1  8 estados, exatamente", ESTADOS_DIAGNOSTICO.length === 8);
ok(
  "A2  os 8 nomes canonicos",
  ["PRONTO", "FALTA_FUNCAO", "FALTA_CONEXAO", "CONEXAO_INVALIDA", "FALTA_CONFIGURACAO",
    "BLOQUEADO_POR_PERMISSAO", "REQUER_APROVACAO", "NAO_VERIFICAVEL"]
    .every((e) => (ESTADOS_DIAGNOSTICO as readonly string[]).includes(e))
);
ok(
  "A3  CONHECIMENTO_DESATUALIZADO NAO e estado de prontidao",
  !(ESTADOS_DIAGNOSTICO as readonly string[]).includes("CONHECIMENTO_DESATUALIZADO")
);
ok("A4  sem duplicata no enum", new Set(ESTADOS_DIAGNOSTICO).size === 8);
ok("A5  3 tipos de alvo", TIPOS_ALVO.length === 3);
ok("A6  3 coberturas de recurso", COBERTURAS_RECURSO.length === 3);
ok("A7  3 situacoes de configuracao", SITUACOES_CONFIGURACAO.length === 3);
ok("A8  o modulo existe", existe("lib/ia/skills/diagnostico.ts"));

// ─── B. Funcoes ───────────────────────────────────────────────────────

secao("B. Funcoes — existencia, permissao e opcionalidade");

{
  const d1 = diagnosticarSkill(entrada());
  ok("B1  Skill sem requisitos -> PRONTO", d1.estadoGeral === "PRONTO" && d1.pronto);
  ok("B1b sem requisitos, zero pendencias", d1.bloqueios.length === 0 && d1.limitacoes.length === 0);

  const d2 = diagnosticarSkill(entrada({
    skill: skill({ funcoes: ["mensagens.listar"] }),
    funcoes: [F("mensagens.listar")],
    permissoes: [P("mensagens.listar", "automatico")],
  }));
  ok("B2  funcao obrigatoria existe e automatica -> PRONTO", d2.estadoGeral === "PRONTO" && d2.pronto);
  ok("B2b aparece em funcoesUtilizaveis", d2.funcoesUtilizaveis.includes("mensagens.listar"));

  const d3 = diagnosticarSkill(entrada({
    skill: skill({ funcoes: ["mensagens.responder"] }),
    funcoes: [F("mensagens.listar")],
  }));
  ok("B3  funcao obrigatoria ausente -> FALTA_FUNCAO", d3.estadoGeral === "FALTA_FUNCAO");
  ok("B3b e bloqueia", d3.bloqueios.length === 1 && d3.bloqueios[0].bloqueia && !d3.pronto);
  ok("B3c nao entra em funcoesUtilizaveis", d3.funcoesUtilizaveis.length === 0);

  const d4 = diagnosticarSkill(entrada({
    skill: skill({ funcoes: ["mensagens.listar"], funcoes_opcionais: ["whatsapp.enviar"] }),
    funcoes: [F("mensagens.listar")],
    permissoes: [P("mensagens.listar", "automatico")],
  }));
  ok("B4  funcao OPCIONAL ausente nao bloqueia", d4.pronto && d4.bloqueios.length === 0);
  ok("B4b vira limitacao, nao bloqueio", d4.limitacoes.length === 1 && !d4.limitacoes[0].bloqueia);
  ok("B4c limitacao e FALTA_FUNCAO de whatsapp.enviar", tem(d4, "FALTA_FUNCAO", "whatsapp.enviar"));

  const d5 = diagnosticarSkill(entrada({
    skill: skill({ funcoes: ["mensagens.responder"] }),
    funcoes: [F("mensagens.responder")],
    permissoes: [P("mensagens.responder", "bloqueado")],
  }));
  ok("B5  nivel bloqueado -> BLOQUEADO_POR_PERMISSAO", d5.estadoGeral === "BLOQUEADO_POR_PERMISSAO");
  ok("B5b bloqueia mesmo a Funcao existindo", !d5.pronto);
  ok("B5c nao entra em funcoesUtilizaveis", d5.funcoesUtilizaveis.length === 0);

  const d6 = diagnosticarSkill(entrada({
    skill: skill({ funcoes: ["mensagens.responder"] }),
    funcoes: [F("mensagens.responder")],
    permissoes: [P("mensagens.responder", "aprovacao")],
  }));
  ok("B6  nivel aprovacao -> REQUER_APROVACAO", d6.estadoGeral === "REQUER_APROVACAO");
  ok("B6b NAO e falha: nada bloqueia", d6.pronto && d6.bloqueios.length === 0);
  ok("B6c a funcao continua utilizavel", d6.funcoesUtilizaveis.includes("mensagens.responder"));

  const d7 = diagnosticarSkill(entrada({
    skill: skill({ funcoes: ["x.y"] }),
    funcoes: [F("x.y")],
  }));
  ok("B7  permissao AUSENTE = bloqueado (padrao seguro)", d7.estadoGeral === "BLOQUEADO_POR_PERMISSAO");

  const d8 = diagnosticarSkill(entrada({
    skill: skill({ funcoes: ["x.y"] }),
    funcoes: [F("x.y", false)],
    permissoes: [P("x.y", "bloqueado")],
  }));
  ok("B8  inexistente + bloqueada -> FALTA_FUNCAO (nao manda mexer em permissao)",
    d8.estadoGeral === "FALTA_FUNCAO" && !tem(d8, "BLOQUEADO_POR_PERMISSAO", "x.y"));

  const d9 = diagnosticarSkill(entrada({
    skill: skill({ funcoes: ["mensagens.listar"] }),
    funcoes: [F("mensagens.li")],
  }));
  ok("B9  funcao NAO e inferida por nome parecido", d9.estadoGeral === "FALTA_FUNCAO");
}

// ─── C. Conexoes ──────────────────────────────────────────────────────

secao("C. Conexoes — ausente, invalida, coberta");

{
  const base = { skill: skill({ conexoes: [CONEXAO_CHAT] }) };

  const d1 = diagnosticarSkill(entrada(base));
  ok("C1  conexao obrigatoria ausente -> FALTA_CONEXAO", d1.estadoGeral === "FALTA_CONEXAO" && !d1.pronto);
  ok("C1b alvo e plataforma/recurso", tem(d1, "FALTA_CONEXAO", "shopee/chat"));

  const d2 = diagnosticarSkill(entrada({
    skill: skill({ conexoes: [{ plataforma: "whatsapp", recurso: "envio", obrigatoria: false }] }),
  }));
  ok("C2  conexao OPCIONAL ausente nao bloqueia", d2.pronto && d2.limitacoes.length === 1);

  for (const est of ["expirada", "desconectada", "erro"] as const) {
    const d = diagnosticarSkill(entrada({ ...base, conexoes: [C("shopee", "chat", est)] }));
    ok(`C3  conexao ${est} -> CONEXAO_INVALIDA`, d.estadoGeral === "CONEXAO_INVALIDA");
  }

  const d4 = diagnosticarSkill(entrada({ ...base, conexoes: [C("shopee", "chat")] }));
  ok("C4  conexao valida e coberta -> PRONTO", d4.estadoGeral === "PRONTO" && d4.pronto);

  const d5 = diagnosticarSkill(entrada({
    ...base, conexoes: [C("shopee", "chat", "conectada", "ausente")],
  }));
  ok("C5  cobertura ausente -> FALTA_CONEXAO", d5.estadoGeral === "FALTA_CONEXAO");

  const d6 = diagnosticarSkill(entrada({ ...base, conexoes: [C("shopee", "pedidos")] }));
  ok("C6  conexao de OUTRO recurso nao satisfaz", d6.estadoGeral === "FALTA_CONEXAO");
}

// ─── D. NAO_VERIFICAVEL ───────────────────────────────────────────────

secao("D. NAO_VERIFICAVEL — sem otimismo e sem pessimismo");

{
  const d = diagnosticarSkill(entrada({
    skill: skill({ conexoes: [CONEXAO_CHAT] }),
    conexoes: [C("shopee", "chat", "conectada", "nao_verificavel")],
  }));
  ok("D1  conexao valida + recurso nao verificavel -> NAO_VERIFICAVEL", d.estadoGeral === "NAO_VERIFICAVEL");
  ok("D2  NAO vira PRONTO", d.estadoGeral !== "PRONTO");
  ok("D3  NAO vira FALTA_CONEXAO", !estados(d).includes("FALTA_CONEXAO"));
  ok("D4  NAO vira CONEXAO_INVALIDA", !estados(d).includes("CONEXAO_INVALIDA"));
  ok("D5  bloqueia quando o requisito e obrigatorio", !d.pronto);

  const opc = diagnosticarSkill(entrada({
    skill: skill({ conexoes: [{ plataforma: "shopee", recurso: "chat", obrigatoria: false }] }),
    conexoes: [C("shopee", "chat", "conectada", "nao_verificavel")],
  }));
  ok("D6  em requisito opcional, e limitacao", opc.pronto && opc.limitacoes.length === 1);
}

// ─── E. Configuracoes ─────────────────────────────────────────────────

secao("E. Configuracoes");

{
  const base = { skill: skill({ conexoes: [CONEXAO_CHAT] }), conexoes: [C("shopee", "chat")] };

  const d1 = diagnosticarSkill(entrada({ ...base, configuracoes: [CFG("webhook", "ausente")] }));
  ok("E1  configuracao obrigatoria ausente -> FALTA_CONFIGURACAO", d1.estadoGeral === "FALTA_CONFIGURACAO");
  ok("E1b alvo carrega a chave", tem(d1, "FALTA_CONFIGURACAO", "shopee/chat#webhook"));

  const d2 = diagnosticarSkill(entrada({ ...base, configuracoes: [CFG("webhook", "ausente", false)] }));
  ok("E2  configuracao opcional ausente -> aviso, nao bloqueio", d2.pronto && d2.limitacoes.length === 1);

  const d3 = diagnosticarSkill(entrada({ ...base, configuracoes: [CFG("webhook", "satisfeita")] }));
  ok("E3  configuracao satisfeita nao gera pendencia", d3.estadoGeral === "PRONTO");

  const d4 = diagnosticarSkill(entrada({ ...base, configuracoes: [CFG("webhook", "nao_verificavel")] }));
  ok("E4  configuracao nao verificavel -> NAO_VERIFICAVEL", d4.estadoGeral === "NAO_VERIFICAVEL");

  const d5 = diagnosticarSkill(entrada({
    ...base, configuracoes: [CFG("x", "ausente", true, "mercado_livre", "ads")],
  }));
  ok("E5  configuracao de par NAO pedido e ignorada", d5.estadoGeral === "PRONTO");

  const d6 = diagnosticarSkill(entrada({ ...base }));
  ok("E6  `configuracoes` ausente e valido", d6.estadoGeral === "PRONTO");
}

// ─── F. Multiplos problemas ───────────────────────────────────────────

secao("F. Nada e escondido por precedencia");

{
  const d = diagnosticarSkill(entrada({
    skill: skill({
      funcoes: ["mensagens.responder"],
      funcoes_opcionais: ["whatsapp.enviar"],
      conexoes: [CONEXAO_CHAT],
    }),
    funcoes: [],
  }));
  ok("F1  funcao ausente + conexao ausente: AMBOS aparecem",
    tem(d, "FALTA_FUNCAO", "mensagens.responder") && tem(d, "FALTA_CONEXAO", "shopee/chat"));
  ok("F1b o opcional tambem foi preservado", tem(d, "FALTA_FUNCAO", "whatsapp.enviar"));
  ok("F1c total de pendencias = 3", d.bloqueios.length + d.limitacoes.length === 3);
  ok("F1d o opcional ficou em limitacoes", d.limitacoes.length === 1 && d.bloqueios.length === 2);

  const d2 = diagnosticarSkill(entrada({
    skill: skill({ funcoes: ["a.b"], conexoes: [CONEXAO_CHAT] }),
    funcoes: [F("a.b")],
    permissoes: [P("a.b", "bloqueado")],
    conexoes: [C("shopee", "chat", "expirada")],
  }));
  ok("F2  bloqueado + conexao invalida: AMBOS aparecem",
    tem(d2, "BLOQUEADO_POR_PERMISSAO", "a.b") && tem(d2, "CONEXAO_INVALIDA", "shopee/chat"));

  const d3 = diagnosticarSkill(entrada({
    skill: skill({ funcoes: ["a.b"], conexoes: [CONEXAO_CHAT] }),
    funcoes: [F("a.b")],
    permissoes: [P("a.b", "aprovacao")],
  }));
  ok("F3  aprovacao NAO esconde conexao ausente", d3.estadoGeral === "FALTA_CONEXAO");
  ok("F3b mas a aprovacao continua registrada", tem(d3, "REQUER_APROVACAO", "a.b"));
}

// ─── G. Precedencia e determinismo ────────────────────────────────────

secao("G. Precedencia, ordem e determinismo");

{
  const d = diagnosticarSkill(entrada({
    skill: skill({ funcoes: ["z.z", "a.a"], conexoes: [CONEXAO_CHAT] }),
    funcoes: [],
  }));
  ok("G1  FALTA_FUNCAO vence FALTA_CONEXAO no resumo", d.estadoGeral === "FALTA_FUNCAO");
  ok("G2  dentro do mesmo estado, alvos em ordem alfabetica",
    JSON.stringify(alvos(d.bloqueios).slice(0, 2)) === JSON.stringify(["a.a", "z.z"]));

  const d2 = diagnosticarSkill(entrada({
    skill: skill({ funcoes: ["a.b"], conexoes: [CONEXAO_CHAT] }),
    funcoes: [F("a.b", false)],
    permissoes: [P("a.b", "bloqueado")],
  }));
  ok("G3  FALTA_FUNCAO antes de BLOQUEADO_POR_PERMISSAO", d2.estadoGeral === "FALTA_FUNCAO");

  // Mesma entrada, ordens embaralhadas: a saida tem de ser identica.
  const montar = (inverter: boolean) => {
    const funcoes = [F("a.a"), F("b.b")];
    const permissoes = [P("a.a", "aprovacao"), P("b.b", "automatico")];
    const conexoes = [C("shopee", "chat"), C("mercado_livre", "ads")];
    return diagnosticarSkill(entrada({
      skill: skill({
        funcoes: inverter ? ["b.b", "a.a"] : ["a.a", "b.b"],
        conexoes: [CONEXAO_CHAT, { plataforma: "zz", recurso: "kk", obrigatoria: true }],
      }),
      funcoes: inverter ? [...funcoes].reverse() : funcoes,
      permissoes: inverter ? [...permissoes].reverse() : permissoes,
      conexoes: inverter ? [...conexoes].reverse() : conexoes,
    }));
  };
  ok("G4  ordem dos fatos NAO altera a saida",
    JSON.stringify(montar(false)) === JSON.stringify(montar(true)));
  ok("G4b controle: a saida comparada nao e vazia",
    montar(false).bloqueios.length + montar(false).limitacoes.length > 0);

  const r1 = diagnosticarSkill(entrada({ skill: skill({ funcoes: ["a.b"] }) }));
  const r2 = diagnosticarSkill(entrada({ skill: skill({ funcoes: ["a.b"] }) }));
  ok("G5  mesma entrada -> saida profundamente igual", JSON.stringify(r1) === JSON.stringify(r2));

  // As duas exigencias que puxam o resumo para lados opostos. Elas so
  // convivem por causa da regra documentada em `diagnosticarSkill`, e
  // por isso ficam lado a lado aqui: quebrar uma quebra a outra.
  const so_aprovacao = diagnosticarSkill(entrada({
    skill: skill({ funcoes: ["a.b"] }),
    funcoes: [F("a.b")],
    permissoes: [P("a.b", "aprovacao")],
  }));
  ok("G8  caso 21: aprovacao + resto pronto -> REQUER_APROVACAO",
    so_aprovacao.estadoGeral === "REQUER_APROVACAO" && so_aprovacao.pronto);

  const so_opcional = diagnosticarSkill(entrada({
    skill: skill({ funcoes: ["a.b"], funcoes_opcionais: ["nao.existe"] }),
    funcoes: [F("a.b")],
    permissoes: [P("a.b", "automatico")],
  }));
  ok("G9  caso 22: opcional ausente + nucleo pronto -> PRONTO",
    so_opcional.estadoGeral === "PRONTO" && so_opcional.pronto);
  ok("G9b a limitacao NAO foi escondida pelo resumo",
    so_opcional.limitacoes.length === 1 && tem(so_opcional, "FALTA_FUNCAO", "nao.existe"));

  ok("G6  `pronto` ignora limitacoes",
    diagnosticarSkill(entrada({
      skill: skill({ funcoes_opcionais: ["nao.existe"] }),
    })).pronto);
  ok("G7  `pronto` e falso com qualquer bloqueio",
    !diagnosticarSkill(entrada({ skill: skill({ funcoes: ["nao.existe"] }) })).pronto);
}

// ─── H. Deduplicacao ──────────────────────────────────────────────────

secao("H. Deduplicacao de requisito de conexao");

{
  const d = diagnosticarSkill(entrada({
    skill: skill({
      funcoes: ["mensagens.listar", "mensagens.responder"],
      conexoes: [CONEXAO_CHAT, { plataforma: "shopee", recurso: "chat", obrigatoria: false }],
    }),
    funcoes: [F("mensagens.listar"), F("mensagens.responder")],
    permissoes: [P("mensagens.listar", "automatico"), P("mensagens.responder", "automatico")],
  }));
  const deConexao = [...d.bloqueios, ...d.limitacoes].filter((p) => p.tipo === "conexao");
  ok("H1  par repetido gera UMA pendencia", deConexao.length === 1);
  ok("H2  obrigatoria vence por OR (bloqueia)", deConexao[0].bloqueia === true);
  ok("H3  as duas funcoes seguem utilizaveis", d.funcoesUtilizaveis.length === 2);
  ok("H4  funcoesUtilizaveis sem duplicata e ordenado",
    JSON.stringify(d.funcoesUtilizaveis) === JSON.stringify(["mensagens.listar", "mensagens.responder"]));

  const d2 = diagnosticarSkill(entrada({
    skill: skill({ funcoes: ["a.b"], funcoes_opcionais: ["a.b"] }),
    funcoes: [F("a.b")],
    permissoes: [P("a.b", "automatico")],
  }));
  ok("H5  funcao repetida em obrigatoria e opcional nao duplica utilizaveis",
    d2.funcoesUtilizaveis.length === 1);
}

// ─── I. Skill nao tem autoridade ──────────────────────────────────────

secao("I. A Skill nao concede nada");

{
  // Uma Skill so contribui com IDS e um booleano. Ainda que o manifesto
  // trouxesse chaves de autoridade, o motor le apenas `requer` — e o
  // contrato da 1B ja recusa o arquivo antes disso.
  const maliciosa = {
    id: "x",
    requer: { funcoes: ["a.b"] },
    nivel: "automatico",
    permissoes: [{ funcaoId: "a.b", nivel: "automatico" }],
  } as unknown as EntradaDiagnostico["skill"];

  const d = diagnosticarSkill(entrada({ skill: maliciosa, funcoes: [F("a.b")] }));
  ok("I1  Skill nao consegue conceder permissao", d.estadoGeral === "BLOQUEADO_POR_PERMISSAO");
  ok("I2  Skill nao consegue alterar autonomia", !d.pronto);

  const d2 = diagnosticarSkill(entrada({
    skill: maliciosa,
    funcoes: [F("a.b", false)],
  }));
  ok("I3  Skill nao consegue declarar que a Funcao existe", d2.estadoGeral === "FALTA_FUNCAO");

  const d3 = diagnosticarSkill(entrada({
    skill: skill({ conexoes: [CONEXAO_CHAT] }),
    conexoes: [C("shopee", "chat", "expirada")],
  }));
  ok("I4  Skill nao consegue declarar conexao valida", d3.estadoGeral === "CONEXAO_INVALIDA");

  ok("I5  o motor le apenas `requer` da Skill",
    /entrada\.skill\.requer/.test(CODIGO) && !/entrada\.skill\.(nivel|permiss|conce)/.test(CODIGO));
}

// ─── J. Saida sem segredo ─────────────────────────────────────────────

secao("J. Saida e contrato sem segredo nem identificador de dono");

{
  const d = diagnosticarSkill(entrada({
    skill: skill({ funcoes: ["a.b"], conexoes: [CONEXAO_CHAT] }),
    funcoes: [F("a.b")],
    permissoes: [P("a.b", "aprovacao")],
    conexoes: [C("shopee", "chat", "conectada", "nao_verificavel")],
    configuracoes: [CFG("webhook", "ausente")],
  }));
  const serializada = JSON.stringify(d);

  const SONDAS: readonly [string, RegExp][] = [
    ["segredo", /access_token|refresh_token|partner_key|api[_-]?key|bearer|private key/i],
    ["identificador de dono", /\buser_id\b|\bloja_id\b|\buserId\b/],
    ["identificador externo", /\bseller_id\b|\bshop_id\b|\bpartner_id\b/],
    ["credencial", /\btoken\b|\bsenha\b|\bcredencial\b/i],
  ];
  for (const [nome, re] of SONDAS) {
    ok(`J1  saida sem ${nome}`, !re.test(serializada));
    ok(`J2  fonte (codigo) sem ${nome}`, !re.test(CODIGO));
  }
  ok("J3  controle: as 4 sondas acusam a isca",
    SONDAS.every(([, re]) => re.test('access_token user_id seller_id token senha Bearer shop_id')));
  ok("J4  controle: a saida serializada nao esta vazia", serializada.length > 50);
  ok("J5  a saida tem os 5 campos do contrato",
    ["estadoGeral", "pronto", "bloqueios", "limitacoes", "funcoesUtilizaveis"]
      .every((k) => Object.prototype.hasOwnProperty.call(d, k)));
}

// ─── K. Pureza ────────────────────────────────────────────────────────

secao("K. Pureza — sem I/O, sem LLM, sem mocks");

{
  const PROIBIDOS: readonly [string, RegExp][] = [
    ["node:fs", /node:fs|readFileSync|writeFileSync/],
    ["rede", /\bfetch\s*\(|XMLHttpRequest|WebSocket/],
    ["supabase", /createClient|supabase|service_role/i],
    ["SQL", /\bselect\b[^;\n]{0,80}\bfrom\b|create table|alter table/i],
    ["RPC", /\.rpc\(/],
    ["Server Action / rota", /"use server"|app\/api\/|route\.ts|NextResponse/],
    ["provider de IA", /anthropic|@google\/genai|openai|ai-gateway/i],
    ["marketplace", /lib\/marketplace|mercadolibre\.com|shopee\.com|partner_id/i],
    ["n8n", /\bn8n\b/i],
    ["env", /process\.env/],
    ["relogio/aleatorio", /Date\.now|Math\.random|new Date\(/],
    ["mocks", /lib\/ia\/mocks|MOCK_/],
    ["React/Next", /from "react"|next\//],
    ["eval", /\beval\s*\(|new Function/],
    ["storage", /\bstorage\b|upload|bucket/i],
  ];
  for (const [nome, re] of PROIBIDOS) ok(`K  diagnostico.ts sem ${nome}`, !re.test(CODIGO));
  ok("K16 controle: as sondas acusam quando o padrao existe",
    PROIBIDOS.every(([, re]) =>
      re.test('readFileSync fetch( createClient select * from x .rpc( "use server" anthropic ' +
        'lib/marketplace n8n process.env Date.now MOCK_X from "react" eval( storage')));
  ok("K17 sem importacao de valor de conceitos.ts (so tipo)",
    !/^import \{[^}]*\} from "@\/lib\/ia\/conceitos"/m.test(CODIGO));
  ok("K18 importa o contrato da Skill como tipo", /import type .*skills\/contrato/.test(FONTE));
  ok("K19 nao importa formato.ts (parser nao e do motor)", !/skills\/formato/.test(CODIGO));
}

// ─── L. Caso Shopee Chat ──────────────────────────────────────────────

secao("L. Caso de referencia — Shopee conectada nao prova Chat");

{
  // SINTETICO. `mensagens.listar` e `mensagens.responder` sao ids
  // HIPOTETICOS: nao existem no registry real, e nada aqui afirma que a
  // integracao de Chat da Shopee exista.
  const d = diagnosticarSkill({
    skill: skill({
      funcoes: ["mensagens.listar", "mensagens.responder"],
      conexoes: [CONEXAO_CHAT],
    }),
    funcoes: [F("mensagens.listar"), F("mensagens.responder")],
    permissoes: [P("mensagens.listar", "automatico"), P("mensagens.responder", "automatico")],
    conexoes: [C("shopee", "chat", "conectada", "nao_verificavel")],
  });

  ok("L1  tudo pronto menos a cobertura -> NAO_VERIFICAVEL", d.estadoGeral === "NAO_VERIFICAVEL");
  ok("L2  NAO e PRONTO", d.estadoGeral !== "PRONTO");
  ok("L3  NAO e FALTA_CONEXAO", d.estadoGeral !== "FALTA_CONEXAO");
  ok("L4  NAO e CONEXAO_INVALIDA", d.estadoGeral !== "CONEXAO_INVALIDA");
  ok("L5  a unica pendencia e a cobertura", d.bloqueios.length === 1 && d.limitacoes.length === 0);
  ok("L6  as duas funcoes continuam utilizaveis", d.funcoesUtilizaveis.length === 2);

  // A mesma Skill, agora com a cobertura confirmada.
  const confirmada = diagnosticarSkill({
    skill: skill({ funcoes: ["mensagens.listar"], conexoes: [CONEXAO_CHAT] }),
    funcoes: [F("mensagens.listar")],
    permissoes: [P("mensagens.listar", "automatico")],
    conexoes: [C("shopee", "chat", "conectada", "confirmada")],
  });
  ok("L7  controle: com cobertura confirmada, vira PRONTO", confirmada.estadoGeral === "PRONTO");
}

// ─── M. WhatsApp opcional ─────────────────────────────────────────────

secao("M. WhatsApp opcional — limitacao, nunca bloqueio");

{
  const d = diagnosticarSkill({
    skill: skill({
      funcoes: ["mensagens.listar", "mensagens.responder"],
      funcoes_opcionais: ["whatsapp.enviar"],
      conexoes: [CONEXAO_CHAT, { plataforma: "whatsapp", recurso: "envio", obrigatoria: false }],
    }),
    funcoes: [F("mensagens.listar"), F("mensagens.responder")],
    permissoes: [P("mensagens.listar", "automatico"), P("mensagens.responder", "automatico")],
    conexoes: [C("shopee", "chat", "conectada", "confirmada")],
  });

  ok("M1  o nucleo obrigatorio esta PRONTO", d.pronto && d.bloqueios.length === 0);
  // Caso 22: opcional ausente + nucleo pronto -> PRONTO COM LIMITACAO.
  // O resumo nao rebaixa por algo que a Skill declarou dispensavel; a
  // limitacao continua inteira em `limitacoes`.
  ok("M2  estadoGeral e PRONTO, e as limitacoes seguem listadas",
    d.estadoGeral === "PRONTO" && d.limitacoes.length === 2);
  ok("M3  a funcao opcional aparece como limitacao", tem(d, "FALTA_FUNCAO", "whatsapp.enviar"));
  ok("M4  a conexao opcional aparece como limitacao", tem(d, "FALTA_CONEXAO", "whatsapp/envio"));
  ok("M5  duas limitacoes, zero bloqueios", d.limitacoes.length === 2 && d.bloqueios.length === 0);
  ok("M6  o Shopee continua utilizavel", d.funcoesUtilizaveis.length === 2);
  ok("M7  nenhuma limitacao marca bloqueia", d.limitacoes.every((p) => !p.bloqueia));
}

// ─── N. Fronteira desta fase ──────────────────────────────────────────

secao("N. Fronteira — o que a SKILL-1C nao faz");

{
  for (const [nome, re] of [
    ["resolucao de Ficha por id", /fichas\s*[.[]|resolverFicha|carregarFicha/],
    ["composicao de varias Skills", /skills\s*:\s*readonly|mesclar|combinarSkills/],
    ["montagem de prompt", /montarPrompt|systemPrompt|instrucao\s*:/],
    ["texto conversacional", /Ola |Voce precisa |vá em |mensagem\s*:/i],
  ] as const) {
    ok(`N  diagnostico.ts sem ${nome}`, !re.test(CODIGO));
  }
  ok("N5  controle: essas sondas acusam quando o termo existe",
    /montarPrompt/.test("const montarPrompt = 1") && /Ola /i.test("Ola Rodrigo"));
  ok("N6  Pendencia nao tem campo de texto livre",
    !/\b(mensagem|texto|frase|descricao)\s*:\s*string/.test(
      CODIGO.slice(CODIGO.indexOf("interface Pendencia"), CODIGO.indexOf("interface Diagnostico"))
    ));
  ok("N7  nao existe index.ts na pasta", !existe("lib/ia/skills/index.ts"));
  /**
   * 456 linhas foram aceitas CONSCIENTEMENTE, depois que a regra do
   * resumo (bloqueios x limitacoes) precisou ser documentada — ela ja
   * corrigiu um defeito real, em que uma dependencia OPCIONAL ausente
   * rebaixava o estado geral de uma Skill com o nucleo inteiro.
   *
   * Sao ~200 linhas de codigo; o volume e comentario. O teto de 500 e
   * ponto de REVISAO, nao cota a consumir: chegar a 500 exige gate
   * proprio sobre divisao de responsabilidade, nao um numero maior.
   *
   * O limite e literal, nunca derivado do arquivo — limite calculado a
   * partir do que existe jamais reprova nada.
   */
  const LIMITE_LINHAS = 500;
  const linhas = FONTE.split("\n").length;

  ok(`N8  diagnostico.ts abaixo de ${LIMITE_LINHAS} linhas (hoje ${linhas})`,
    linhas < LIMITE_LINHAS, String(linhas));
  ok("N9  controle: a contagem le o arquivo real", linhas > 100);
  // Controle negativo do proprio guarda: ele TEM de reprovar no limite e
  // acima dele. Sem isto, um `<` trocado por `<=` — ou um limite
  // acidentalmente enorme — passaria despercebido.
  ok("N10 controle: o guarda reprova exatamente em 500", !(500 < LIMITE_LINHAS));
  ok("N11 controle: o guarda reprova acima de 500", !(501 < LIMITE_LINHAS));
  ok("N12 controle: o guarda aprova abaixo de 500", 499 < LIMITE_LINHAS);
}

// ─── Placar ───────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(66)}`);
console.log(`  ${passou}/${passou + falhou} passaram` + (falhou > 0 ? `  ·  ${falhou} FALHARAM` : ""));
console.log(`${"═".repeat(66)}\n`);
process.exit(falhou > 0 ? 1 : 0);
