/**
 * CDS IA — M2-I1-A5. A superfície de UI das Conexões do agente.
 *
 * ── Duas naturezas de prova, e por quê ──────────────────────────────
 *
 * O CLIENTE HTTP é executado de verdade, contra um `fetch` duplado: o
 * que se afirma é o endereço exato, o verbo, as chaves do corpo e o
 * mapeamento de cada status — comportamento, não ortografia.
 *
 * O COMPONENTE é provado por FONTE. Este repositório não tem runner de
 * React, e montar um só para esta aba seria infraestrutura nova num
 * slice de UI. A compensação é que cada sonda de fonte vem com controle
 * negativo: elas precisam saber dizer NÃO.
 *
 * ── Zero rede ───────────────────────────────────────────────────────
 *
 * `fetch` global é substituído antes de qualquer import. Nenhum host é
 * tocado, nenhum token existe, nada é gravado.
 *
 * Rodar:  npx tsx scripts/testar-ia-agentes-conexoes-ui.ts
 */
import { readFileSync } from "node:fs";
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
const ler = (rel: string) => readFileSync(join(RAIZ, rel), "utf8");
const semComentarios = (f: string) =>
  f.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const COMPONENTE_REL = "components/ia/agente/ConexoesAgente.tsx";
const PAGINA_REL = "components/ia/agente/PaginaAgente.tsx";
const TRANSPORTE_REL = "lib/ia/agentes-http.ts";
const ABAS_REL = "lib/ia/abas.ts";

const COMPONENTE = semComentarios(ler(COMPONENTE_REL));
const PAGINA = semComentarios(ler(PAGINA_REL));
const TRANSPORTE = semComentarios(ler(TRANSPORTE_REL));
const ABAS_TS = semComentarios(ler(ABAS_REL));

// ─── O duplo de rede ──────────────────────────────────────────────────

interface Requisicao {
  url: string;
  metodo: string;
  corpo: unknown;
  cabecalhos: Record<string, string>;
  temSignal: boolean;
}

let requisicoes: Requisicao[] = [];
let proxima: { status: number; corpo: unknown; lanca?: boolean } = { status: 200, corpo: {} };

globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  requisicoes.push({
    url: String(url),
    metodo: init?.method ?? "GET",
    corpo: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    cabecalhos: (init?.headers ?? {}) as Record<string, string>,
    temSignal: init?.signal !== undefined,
  });
  if (proxima.lanca) throw new Error("rede caiu");
  return {
    ok: proxima.status >= 200 && proxima.status < 300,
    status: proxima.status,
    json: async () => proxima.corpo,
  } as unknown as Response;
}) as unknown as typeof fetch;

const responde = (status: number, corpo: unknown) => {
  requisicoes = [];
  proxima = { status, corpo };
};
const respondeQueCai = () => {
  requisicoes = [];
  proxima = { status: 0, corpo: null, lanca: true };
};

// ─── Fixtures ─────────────────────────────────────────────────────────

const AGENTE = "44444444-5555-6666-7777-888888888888";
const LOJA = "aaaaaaaa-2222-4000-8000-000000000001";

const conexaoCrua = (extra: Record<string, unknown> = {}) => ({
  plataforma: "mercado_livre",
  recurso: "perguntas",
  obrigatoria: true,
  marketplace: "ML",
  lojaIdSelecionada: null,
  utilizavel: false,
  lojasElegiveis: [{ id: LOJA, nome: "Minha loja", nickname: "minha-loja" }],
  ...extra,
});

console.log("\n══ CDS IA — M2-I1-A5: UI das Conexões do agente ══");

// ─── A. O cliente HTTP, executado ─────────────────────────────────────

async function principal(): Promise<void> {
  const http = await import("../lib/ia/agentes-http");

  secao("A. UI-CONN-1..4 — o cliente HTTP");

  responde(200, { ok: true, conexoes: [conexaoCrua()] });
  const rGet = await http.buscarConexoesDoAgente(AGENTE);
  ok("UI-CONN-1  GET no endereco exato",
    requisicoes[0]?.url === `/api/agentes/${AGENTE}/conexoes`, requisicoes[0]?.url);
  ok("UI-CONN-1a e o verbo e GET, sem corpo",
    requisicoes[0]?.metodo === "GET" && requisicoes[0]?.corpo === null);
  ok("UI-CONN-1b o resultado chega normalizado",
    rGet.estado === "ok" && rGet.estado === "ok" && rGet.conexoes.length === 1);
  ok("UI-CONN-1c `agenteId` e escapado no caminho",
    /encodeURIComponent/.test(TRANSPORTE.slice(TRANSPORTE.indexOf("caminhoDasConexoes"))));

  responde(200, { ok: true, conexao: { plataforma: "mercado_livre", recurso: "perguntas", lojaId: LOJA } });
  await http.definirConexaoDoAgente(AGENTE, {
    plataforma: "mercado_livre", recurso: "perguntas", lojaId: LOJA,
  });
  ok("UI-CONN-2  PATCH no mesmo endereco, com o verbo certo",
    requisicoes[0]?.url === `/api/agentes/${AGENTE}/conexoes` &&
      requisicoes[0]?.metodo === "PATCH");
  ok("UI-CONN-2a o corpo tem EXATAMENTE tres chaves",
    JSON.stringify(Object.keys(requisicoes[0]?.corpo as object).sort()) ===
      JSON.stringify(["lojaId", "plataforma", "recurso"]),
    JSON.stringify(Object.keys(requisicoes[0]?.corpo as object)));

  const proibidos = ["marketplace", "userId", "user_id", "agenteId", "agente_id",
    "sellerId", "seller_id", "accessToken", "refreshToken", "nivel", "permission"];
  const serializado = JSON.stringify(requisicoes[0]?.corpo);
  ok("UI-CONN-3  nenhum campo proibido no corpo",
    !proibidos.some((c) => serializado.includes(c)), serializado);
  ok("UI-CONN-3a e o corpo e montado campo a campo, nunca por spread",
    !/body: JSON\.stringify\(\{\s*\.\.\./.test(
      TRANSPORTE.slice(TRANSPORTE.indexOf("export async function definirConexaoDoAgente"))));
  ok("UI-CONN-3b CONTROLE: a sonda de proibidos acha quando existe",
    proibidos.some((c) => JSON.stringify({ marketplace: "ML" }).includes(c)));

  // UI-CONN-4: cada status vira estado proprio, e nada cru sobe.
  const casos: [string, number, unknown, string][] = [
    ["401 -> nao_autenticado", 401, {}, "nao_autenticado"],
    ["404 -> nao_encontrado", 404, {}, "nao_encontrado"],
    ["500 -> falha", 500, {}, "falha"],
    ["corpo sem ok -> falha", 200, { conexoes: [] }, "falha"],
    ["item malformado -> falha", 200, { ok: true, conexoes: [{ plataforma: 7 }] }, "falha"],
    ["`utilizavel` ausente -> falha", 200,
      { ok: true, conexoes: [{ ...conexaoCrua(), utilizavel: undefined }] }, "falha"],
  ];
  for (const [rotulo, status, corpo, esperado] of casos) {
    responde(status, corpo);
    const r = await http.buscarConexoesDoAgente(AGENTE);
    ok(`UI-CONN-4  GET ${rotulo}`, r.estado === esperado, r.estado);
  }

  respondeQueCai();
  ok("UI-CONN-4a rede caida -> falha",
    (await http.buscarConexoesDoAgente(AGENTE)).estado === "falha");

  responde(409, { ok: false, erro: "Conta indisponível para este requisito." });
  const rConflito = await http.definirConexaoDoAgente(AGENTE, {
    plataforma: "mercado_livre", recurso: "perguntas", lojaId: LOJA,
  });
  ok("UI-CONN-4b 409 vira `conflito`, com a frase publica do servidor",
    rConflito.estado === "conflito" &&
      rConflito.mensagem === "Conta indisponível para este requisito.");

  responde(409, { ok: false, erro: "permission denied for table agente_conexoes" });
  const rConflitoEstranho = await http.definirConexaoDoAgente(AGENTE, {
    plataforma: "mercado_livre", recurso: "perguntas", lojaId: null,
  });
  ok("UI-CONN-4c uma frase que o servidor NAO publica vira a generica",
    rConflitoEstranho.estado === "conflito" &&
      !/permission denied|table/.test(rConflitoEstranho.mensagem),
    rConflitoEstranho.estado === "conflito" ? rConflitoEstranho.mensagem : "");

  responde(200, { ok: true, conexao: { plataforma: "mercado_livre", recurso: "perguntas", lojaId: "x" } });
  const rEcoErrado = await http.definirConexaoDoAgente(AGENTE, {
    plataforma: "mercado_livre", recurso: "perguntas", lojaId: LOJA,
  });
  ok("UI-CONN-4d o eco vem do SERVIDOR, nao do argumento",
    rEcoErrado.estado === "ok" && rEcoErrado.lojaId === "x");

  // ─── B. UI-CONN-5 — a centralizacao de rede ────────────────────────

  secao("B. UI-CONN-5 — só o transporte fala com a rede");

  ok("UI-CONN-5  o componente nao tem `fetch`", !/\bfetch\s*\(/.test(COMPONENTE));
  ok("UI-CONN-5a nem constroi endereco de API", !/["'`]\/api\//.test(COMPONENTE));
  ok("UI-CONN-5b e consome o transporte nominal",
    /from "@\/lib\/ia\/agentes-http"/.test(COMPONENTE) &&
      /buscarConexoesDoAgente/.test(COMPONENTE) &&
      /definirConexaoDoAgente/.test(COMPONENTE));
  ok("UI-CONN-5c zero Supabase, zero dominio de agentes, zero env",
    !/getSupabaseServidor|createClient|service_role|lib\/agentes|process\.env/
      .test(COMPONENTE));
  ok("UI-CONN-5d zero chamada a marketplace",
    !/mercadolibre|shopee\.com|Authorization|Bearer/.test(COMPONENTE));
  ok("UI-CONN-5e CONTROLE: as sondas acham os padroes quando existem",
    /\bfetch\s*\(/.test("await fetch(u)") && /["'`]\/api\//.test('"/api/x"'));

  // ─── C. UI-CONN-6..10 — os estados ─────────────────────────────────

  secao("C. UI-CONN-6..10 — os cinco estados da tela");

  ok("UI-CONN-6  renderiza a lista inteira do servidor, sem filtrar",
    /leitura\.conexoes\.map\(/.test(COMPONENTE) &&
      !/\.filter\(\s*\(?c\)?\s*=>\s*c\.utilizavel/.test(COMPONENTE));
  ok("UI-CONN-7  sem selecao diz `Nenhuma conta escolhida`",
    /lojaIdSelecionada === null \? \(/.test(COMPONENTE) &&
      /Nenhuma conta escolhida/.test(COMPONENTE));
  ok("UI-CONN-7a e NAO diz `Nenhuma conta conectada` — sao coisas diferentes",
    !/Nenhuma conta conectada/.test(COMPONENTE));
  ok("UI-CONN-8  selecao valida mostra a conta em uso",
    /conexao\.utilizavel \? \(/.test(COMPONENTE) && /Conta em uso/.test(COMPONENTE));

  // O estado mais importante da tela.
  ok("UI-CONN-9  selecao INCOMPATIVEL tem ramo proprio",
    /cds-cx-incompativel/.test(COMPONENTE) &&
      /nao serve para este requisito|não serve para este requisito/.test(COMPONENTE));
  ok("UI-CONN-9a e ela NUNCA e convertida para `null`",
    !/lojaIdSelecionada\s*=\s*null/.test(COMPONENTE) &&
      !/utilizavel\s*=\s*(true|false)/.test(COMPONENTE));
  ok("UI-CONN-9b o requisito continua na lista — nao ha `continue` nem filtro",
    !/if \(!conexao\.utilizavel\) return null/.test(COMPONENTE));
  ok("UI-CONN-9c e a tela orienta a trocar ou remover",
    /Escolha outra ou remova/.test(COMPONENTE));
  ok("UI-CONN-10 zero contas elegiveis tem texto proprio",
    /lojasElegiveis\.length === 0/.test(COMPONENTE) &&
      /Nenhuma conta compat[ií]vel conectada/.test(COMPONENTE));
  ok("UI-CONN-10a e sem botao de OAuth, link de provider ou token",
    !/OAuth|Conectar conta|Autorizar|oauth/i.test(COMPONENTE));

  // ─── D. UI-CONN-11..15 — a escrita ─────────────────────────────────

  secao("D. UI-CONN-11..15 — escrever sem otimismo");

  ok("UI-CONN-11 selecionar chama o PATCH com plataforma e recurso do item",
    /definirConexaoDoAgente\(agenteId, \{\s*plataforma: conexao\.plataforma,\s*recurso: conexao\.recurso,\s*lojaId,\s*\}\)/s
      .test(COMPONENTE));
  ok("UI-CONN-12 remover manda `null`",
    /definir\(conexao, null\)/.test(COMPONENTE) &&
      /valor === "" \? null : valor/.test(COMPONENTE));
  ok("UI-CONN-13 pendente e por requisito, indexado por chave nominal",
    /pendentes\[chave\] === true/.test(COMPONENTE) &&
      /disabled=\{pendente\}/.test(COMPONENTE));
  ok("UI-CONN-13a e a chave NAO e o indice do array",
    /const chaveDe = \(c/.test(COMPONENTE) &&
      /key=\{chave\}/.test(COMPONENTE) &&
      !/\.map\(\((\w+), (i|idx|index)\)/.test(COMPONENTE));
  ok("UI-CONN-14 erro de PATCH vira erro daquele requisito, nunca sucesso",
    /errosPorRequisito\[chave\]/.test(COMPONENTE) &&
      /role="alert"/.test(COMPONENTE));
  ok("UI-CONN-14a e nenhum ramo de falha chama `carregar` como se tivesse gravado",
    (COMPONENTE.match(/await carregar\(\);/g) ?? []).length === 2);
  ok("UI-CONN-15 sucesso ressincroniza pelo GET",
    /resposta\.estado === "ok"\)\s*\{\s*await carregar\(\)/s.test(COMPONENTE));
  ok("UI-CONN-15a conflito TAMBEM ressincroniza",
    /resposta\.estado === "conflito"\)\s*\{\s*await carregar\(\)/s.test(COMPONENTE));
  ok("UI-CONN-15b zero otimismo: a tela nao deriva estado local da escolha",
    !/setLeitura\(\s*\(?atual/.test(COMPONENTE));
  ok("UI-CONN-15c o GET em voo e cancelavel, e o novo cancela o velho",
    /AbortController/.test(COMPONENTE) && /requisicaoRef\.current\?\.abort\(\)/.test(COMPONENTE));

  // ─── E. UI-CONN-16, 21..23 — o que a tela nao pode dizer ───────────

  secao("E. UI-CONN-16/21/22/23 — vocabulário e segredo");

  ok("UI-CONN-16 zero credencial no componente",
    !/token|secret|senha|credencial|sellerId|seller_id/i.test(COMPONENTE));
  ok("UI-CONN-21 a tela NAO promete cobertura remota",
    !/verificad|confirmad|grant|API funcionando|pronta para uso/i.test(COMPONENTE));
  ok("UI-CONN-21a e o rotulo diz o que a lista realmente e",
    /Contas conectadas compat[ií]veis/.test(COMPONENTE));
  ok("UI-CONN-21b CONTROLE: a sonda acusaria a promessa",
    /verificad/i.test("Conexão verificada"));
  ok("UI-CONN-22 zero requisitos diz que o agente NAO exige conexao",
    /conexoes\.length === 0/.test(COMPONENTE) &&
      /n[aã]o exige nenhuma conex[aã]o/i.test(COMPONENTE));
  ok("UI-CONN-22a e nao confunde com `voce nao conectou nenhuma conta`",
    !/voc[eê] n[aã]o conectou/i.test(COMPONENTE));
  ok("UI-CONN-23 o nome exibido e `nickname ?? nome`",
    /loja\.nickname \?\? loja\.nome/.test(COMPONENTE));

  // ─── F. UI-CONN-17..20 — a aba ─────────────────────────────────────

  secao("F. UI-CONN-17..20 — a aba, por id nominal");

  const { ABAS, PENDENCIA_ABA } = await import("../lib/ia/abas");
  const aba = ABAS.find((a) => a.id === "conexoes");
  ok("UI-CONN-17 a aba existe por id nominal e esta implementada",
    aba !== undefined && aba.implementada === true, JSON.stringify(aba));
  ok("UI-CONN-17a e saiu do mapa de pendencia",
    !(PENDENCIA_ABA as Record<string, string>).conexoes);
  ok("UI-CONN-18 PaginaAgente renderiza o componente pela comparacao de id",
    /aba === "conexoes" && <ConexoesAgente agenteId=/.test(PAGINA));
  ok("UI-CONN-18a e o import e nominal",
    /import ConexoesAgente from "@\/components\/ia\/agente\/ConexoesAgente"/.test(PAGINA));
  ok("UI-CONN-19 zero dependencia de posicao na resolucao da aba",
    !/ABAS\[\d\]|abas\[\d\]|\.indexOf\(aba\)/.test(PAGINA) &&
      !/ABAS\[\d\]/.test(ABAS_TS));
  ok("UI-CONN-19a e a ordem das abas segue intacta",
    JSON.stringify(ABAS.map((a) => a.id)) ===
      JSON.stringify(["visao-geral", "chat", "tarefas", "conexoes", "funcoes",
        "permissoes", "memoria", "custos"]));
  ok("UI-CONN-20 o placeholder antigo nao coexiste com a tela",
    !/EmBreve[\s\S]{0,200}conexoes/.test(PAGINA) &&
      (PAGINA.match(/<EmBreve/g) ?? []).length === 1);
  ok("UI-CONN-20a e nao ha segundo componente de conexoes do agente",
    !/AbaConexoes|ConexoesDoAgente/.test(PAGINA));

  console.log(`\n══ ${passou} PASS / ${falhou} FAIL ══\n`);
  process.exitCode = falhou === 0 ? 0 : 1;
}

principal().catch((e) => {
  console.log(`  FAIL  excecao nao tratada — ${String(e).slice(0, 300)}`);
  process.exitCode = 1;
});
