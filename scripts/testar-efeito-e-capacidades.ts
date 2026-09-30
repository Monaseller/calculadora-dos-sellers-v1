/**
 * AGENT-FACTORY-F7b.4.5 §2–§5 e §19–§22 — efeito e linguagem humana.
 *
 * Suite PURA: sem rede, sem banco, sem IA.
 *
 * ── As duas decisoes de produto que ela cerca ───────────────────────
 *
 * §2  Aprovacao e por EFEITO, nao por Tool. Ler nao pede confirmacao;
 *     alterar pede. Antes disto, adicionar "Planilhas" fazia o dono
 *     escolher entre tres niveis para poder LER um arquivo.
 *
 * §19 O agente respondia que tinha `planilha_inspecionar`. O usuario
 *     escolheu "Planilhas" numa tela e recebeu de volta um identificador
 *     de implementacao.
 *
 * Roda com: npx tsx scripts/testar-efeito-e-capacidades.ts
 */
import "./_server-only-inerte";

import {
  EFEITOS, EFEITOS_SEM_CONFIRMACAO, efeitoDaAcaoExterna, efeitoDaFuncaoInterna,
  exigeConfirmacao, fraseDoEfeito, nivelSugeridoParaEfeito,
} from "../lib/agentes/factory/efeito";
import { capacidadesDoAgente, nomeDoAplicativo } from "../lib/agentes/factory/capacidades";
import { montarContextoDoAgente } from "../lib/agentes/ia/contexto-do-agente";
import { FUNCOES } from "../lib/agentes/funcoes/registry";

let pass = 0;
let fail = 0;
function ok(nome: string, cond: boolean, detalhe = ""): void {
  if (cond) { pass += 1; console.log(`  PASS  ${nome}`); }
  else { fail += 1; console.log(`  FAIL  ${nome}${detalhe ? `  — ${detalhe}` : ""}`); }
}
function secao(t: string): void { console.log(`\n${t}`); }

// ─── A. A classificacao por efeito ────────────────────────────────────

secao("A. Efeito, e nao Tool — §2");

{
  ok("A1  so leitura e calculo dispensam confirmacao",
    JSON.stringify([...EFEITOS_SEM_CONFIRMACAO].sort()) ===
      JSON.stringify(["CALCULATION", "READ_ONLY"]),
    [...EFEITOS_SEM_CONFIRMACAO].join(","));

  for (const e of ["READ_ONLY", "CALCULATION"] as const) {
    ok(`A2  \`${e}\` NAO pede confirmacao`, !exigeConfirmacao(e));
    ok(`A2a e o nivel sugerido e automatico`,
      nivelSugeridoParaEfeito(e) === "automatico");
  }
  for (const e of
    ["WRITE", "DESTRUCTIVE", "SEND", "PUBLISH", "FINANCIAL_EFFECT", "UNKNOWN"] as const) {
    ok(`A3  \`${e}\` PEDE confirmacao`, exigeConfirmacao(e));
    ok(`A3a e o nivel sugerido e aprovacao`,
      nivelSugeridoParaEfeito(e) === "aprovacao");
  }

  // ANTI-VACUIDADE: todo efeito declarado tem frase, e as frases diferem.
  const frases = EFEITOS.map((e) => fraseDoEfeito(e));
  ok("A4  todo efeito tem frase propria", new Set(frases).size === EFEITOS.length);
  ok("A5  e nenhuma delas cita id interno",
    frases.every((f) => !/funcao_?id|composio\.|planilha\./i.test(f)));

  // §4: UNKNOWN e conservador. Se um efeito novo entrar sem passar pela
  // lista de permitidos, ele cai no lado que confirma.
  ok("A6  UNKNOWN e conservador", exigeConfirmacao("UNKNOWN"));
  ok("A7  ANCORA: um efeito inventado tambem confirmaria",
    exigeConfirmacao("EFEITO_QUE_NAO_EXISTE" as never));
}

// ─── B. Internas: do registry, nao do nome ────────────────────────────

secao("B. Function interna classifica pelo `acesso` do registry — §4");

{
  ok("B1  leitura vira READ_ONLY",
    efeitoDaFuncaoInterna({ funcaoId: "planilha.ler", acesso: "leitura" }) === "READ_ONLY");
  ok("B2  escrita vira WRITE",
    efeitoDaFuncaoInterna({ funcaoId: "planilha.escrever", acesso: "escrita" }) === "WRITE");
  ok("B3  calculadora vira CALCULATION",
    efeitoDaFuncaoInterna({ funcaoId: "calculadora.calcular", acesso: "leitura" })
      === "CALCULATION");

  // O NOME nao decide: uma Funcao chamada "ler" que declara escrita e
  // escrita. O registry e a autoridade.
  ok("B4  o NOME nao alivia: `ler` com acesso escrita e WRITE",
    efeitoDaFuncaoInterna({ funcaoId: "coisa.ler", acesso: "escrita" }) === "WRITE");

  // Toda Funcao do registry classifica, e nenhuma leitura pede aprovacao.
  const todas = Object.entries(FUNCOES).map(([id, d]) =>
    ({ id, efeito: efeitoDaFuncaoInterna({ funcaoId: id, acesso: d.acesso }) }));
  ok("B5  todas as Funcoes do registry classificam", todas.length > 0 &&
    todas.every((f) => (EFEITOS as readonly string[]).includes(f.efeito)));
  ok("B6  e NENHUMA Funcao de leitura exige confirmacao",
    todas.filter((f) => f.efeito === "READ_ONLY" || f.efeito === "CALCULATION")
      .every((f) => !exigeConfirmacao(f.efeito)),
    todas.map((f) => `${f.id}=${f.efeito}`).join(", "));
  ok("B7  ANCORA: a varredura viu Funcoes de verdade", todas.length >= 3,
    `${todas.length}`);
}

// ─── C. Externas: a tag do catalogo, nunca so o slug ──────────────────

secao("C. Acao externa classifica pela tag do catalogo — §4");

{
  // MEDIDO em `/tools/{slug}`: estas sao as tags reais.
  ok("C1  `readOnlyHint` presente vira READ_ONLY",
    efeitoDaAcaoExterna({
      slug: "GOOGLESHEETS_GET_SPREADSHEET_INFO",
      tags: ["readOnlyHint", "openWorldHint", "important"],
    }) === "READ_ONLY");
  ok("C2  sem a tag, nao ha sinal de leitura: UNKNOWN",
    efeitoDaAcaoExterna({
      slug: "GOOGLESHEETS_ADD_SHEET", tags: ["googlesheets", "sheet", "important"],
    }) === "UNKNOWN");
  ok("C3  e UNKNOWN pede confirmacao", exigeConfirmacao(efeitoDaAcaoExterna({
    slug: "GOOGLESHEETS_ADD_SHEET", tags: ["googlesheets"],
  })));
  ok("C4  o Hacker News e READ_ONLY pela tag",
    efeitoDaAcaoExterna({
      slug: "HACKERNEWS_GET_ITEM_WITH_ID", tags: ["openWorldHint", "readOnlyHint"],
    }) === "READ_ONLY");

  // O slug AGRAVA, e nunca alivia.
  ok("C5  enviar e SEND, mesmo sem tag",
    efeitoDaAcaoExterna({ slug: "GMAIL_SEND_EMAIL", tags: ["important"] }) === "SEND");
  ok("C6  apagar e DESTRUCTIVE",
    efeitoDaAcaoExterna({ slug: "DRIVE_DELETE_FILE", tags: [] }) === "DESTRUCTIVE");
  ok("C7  cobrar e FINANCIAL_EFFECT",
    efeitoDaAcaoExterna({ slug: "STRIPE_REFUND_CHARGE", tags: [] }) === "FINANCIAL_EFFECT");

  // O CONTROLE que importa: a tag NAO salva uma acao que envia.
  ok("C8  `readOnlyHint` NAO alivia uma acao de envio",
    efeitoDaAcaoExterna({
      slug: "GMAIL_SEND_EMAIL", tags: ["readOnlyHint"],
    }) === "SEND");
  ok("C9  nem uma que apaga",
    efeitoDaAcaoExterna({
      slug: "X_DELETE_ALL", tags: ["readOnlyHint"],
    }) === "DESTRUCTIVE");
  ok("C10 ANCORA: sem o verbo, a MESMA tag da READ_ONLY",
    efeitoDaAcaoExterna({ slug: "X_GET_THING", tags: ["readOnlyHint"] }) === "READ_ONLY");
}

// ─── D. Capacidades em linguagem de gente ─────────────────────────────

secao("D. Planilhas e Planilhas — §19/§20/§21");

{
  const caps = capacidadesDoAgente({
    permissoes: [
      { funcaoId: "planilha.inspecionar", nivel: "automatico" },
      { funcaoId: "planilha.ler", nivel: "automatico" },
      { funcaoId: "calculadora.calcular", nivel: "automatico" },
    ],
    vinculosExternos: [{ toolkit: "googlesheets" }],
    memoriaAtiva: true, temArquivos: false, temSkills: false,
  });
  const nomes = caps.map((c) => c.nome);
  console.log(`  capacidades: ${nomes.join(" · ")}`);

  ok("D1  o pack aparece pelo NOME de gente", nomes.includes("Planilhas"));
  ok("D2  e a Calculadora tambem", nomes.includes("Calculadora"));
  ok("D3  o aplicativo externo ganha nome apresentavel",
    nomes.includes("Google Sheets"));
  ok("D4  a memoria conta como capacidade",
    nomes.some((n) => /Mem[oó]ria/i.test(n)));

  // O CORACAO do §19: nenhum id interno vira nome.
  ok("D5  NENHUM `funcao_id` aparece como nome",
    caps.every((c) => !/[a-z]+\.[a-z_]+/.test(c.nome)),
    nomes.join(","));
  ok("D6  nem `planilha_inspecionar`, que foi o que o Rodrigo viu",
    !nomes.some((n) => /planilha_inspecionar/i.test(n)));
  ok("D7  DUAS Funcoes do mesmo pack viram UMA capacidade",
    nomes.filter((n) => n === "Planilhas").length === 1);
  ok("D8  ANCORA: as capacidades nao estao vazias", caps.length >= 4, `${caps.length}`);

  // Nunca listar o que o agente nao tem.
  const vazio = capacidadesDoAgente({
    permissoes: [], vinculosExternos: [],
    memoriaAtiva: false, temArquivos: false, temSkills: false,
  });
  ok("D9  agente sem nada nao lista capacidade nenhuma", vazio.length === 0);
  ok("D10 permissao AUSENTE nao vira capacidade",
    capacidadesDoAgente({
      permissoes: [{ funcaoId: "planilha.ler", nivel: "" }],
      vinculosExternos: [], memoriaAtiva: false, temArquivos: false, temSkills: false,
    }).length === 0);
  // `bloqueado` CONTA: o agente tem a capacidade, so nao pode usa-la.
  ok("D11 `bloqueado` conta como capacidade que ele tem",
    capacidadesDoAgente({
      permissoes: [{ funcaoId: "planilha.ler", nivel: "bloqueado" }],
      vinculosExternos: [], memoriaAtiva: false, temArquivos: false, temSkills: false,
    }).some((c) => c.nome === "Planilhas"));

  ok("D12 slug externo desconhecido nao vira nome inventado",
    nomeDoAplicativo("xyzabc") === "Xyzabc");
}

// ─── E. O contexto que o modelo recebe ────────────────────────────────

secao("E. O agente sabe se descrever — §22");

{
  const ctx = montarContextoDoAgente({
    instrucoesDoAgente: "Voce ajuda com financas.",
    skills: [], memorias: [], fontes: [],
    capacidades: capacidadesDoAgente({
      permissoes: [
        { funcaoId: "planilha.ler", nivel: "automatico" },
        { funcaoId: "calculadora.calcular", nivel: "automatico" },
      ],
      vinculosExternos: [], memoriaAtiva: true, temArquivos: false, temSkills: false,
    }),
    estadoDaMemoria: "ligada",
    lembrancasDoDono: [],
  });

  ok("E1  o contexto lista Planilhas e Calculadora",
    /Planilhas/.test(ctx.instrucao) && /Calculadora/.test(ctx.instrucao));
  ok("E2  e a memoria ativa",
    /Mem[oó]ria de longo prazo/.test(ctx.instrucao));
  ok("E3  com instrucao EXPLICITA de nao citar id interno",
    /NUNCA cite\s+identificadores internos/i.test(ctx.instrucao));
  ok("E4  o exemplo do que nao fazer e o caso real do Rodrigo",
    /planilha_inspecionar/.test(ctx.instrucao));
  ok("E5  e proibe afirmar capacidade que nao tem",
    /NUNCA afirme ter uma capacidade/i.test(ctx.instrucao));

  // Sem capacidades, o bloco nem existe — nada de lista vazia.
  const semCaps = montarContextoDoAgente({
    instrucoesDoAgente: null, skills: [], memorias: [], fontes: [],
  });
  ok("E6  sem capacidades, o bloco nao aparece",
    !/CAPACIDADES_DO_AGENTE/.test(semCaps.instrucao));
  ok("E7  ANCORA: com capacidades, ele aparece",
    /CAPACIDADES_DO_AGENTE/.test(ctx.instrucao));
}

console.log(`\nPASS ${pass}   FAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);
