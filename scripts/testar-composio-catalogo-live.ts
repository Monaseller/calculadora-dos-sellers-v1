/**
 * AGENT-FACTORY-F7b.4 — catalogo externo e a cerca dele, PROVADOS.
 *
 * ── As duas perguntas ───────────────────────────────────────────────
 *
 *   1. O catalogo funciona de verdade? (rede real, §48)
 *   2. Uma Function externa chega ao guard ANTES do adapter? (§49)
 *
 * A segunda e a que importa mais. Um catalogo que funciona e conveniencia;
 * uma ferramenta externa que executa sem passar pelo guard e um buraco na
 * fronteira de autorizacao da CDS.
 *
 * ── Nenhuma conta real e conectada ──────────────────────────────────
 *
 * Nada aqui faz OAuth, nada toca conta do Rodrigo, nada executa acao
 * externa. O catalogo e SO LEITURA, e a prova do guard usa um vinculo
 * sintetico com um adapter espiao que registra se foi chamado.
 *
 * Roda com: npx tsx scripts/testar-composio-catalogo-live.ts
 */
import "./_server-only-inerte";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buscarToolkits, catalogoExternoConfigurado, listarAcoesDoToolkit,
} from "@/lib/agentes/composio/cliente";
import {
  FORMATO_DO_BANCO, ehFuncaoExterna, idDaFuncaoExterna, nivelRecomendado,
  pecasDoId, riscoDaAcao,
} from "@/lib/agentes/composio/identidade-de-funcao";
import { autorizarFuncao } from "@/lib/agentes/funcoes/guard";
import { FUNCOES } from "@/lib/agentes/funcoes/registry";
import type { FatoConexao, FatoFuncao, FatoPermissao } from "@/lib/ia/skills/diagnostico";

let passou = 0;
let falhou = 0;

function valoresSensiveis(): string[] {
  const fora: string[] = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string" && v.length >= 12 &&
        /KEY|SECRET|TOKEN|PASSWORD|SENHA|CREDENTIAL|DATABASE_URL|DIRECT_URL/i.test(k)) {
      fora.push(v);
    }
  }
  return fora;
}
function limpar(t: string): string {
  let s = t;
  for (const v of valoresSensiveis()) s = s.split(v).join("[REDIGIDO]");
  return s;
}
function log(t: string): void { console.log(limpar(t)); }
function ok(nome: string, cond: boolean, detalhe = ""): void {
  if (cond) { passou++; log(`  PASS  ${nome}`); }
  else { falhou++; log(`  FAIL  ${nome}${detalhe ? ` — ${detalhe}` : ""}`); }
}
function secao(t: string): void { log(`\n${t}`); }

function carregarEnvLocal(): boolean {
  for (const caminho of [
    join(__dirname, "..", ".env.local"),
    join("C:", "Users", "USER", "Desktop", "calculadora-dos-sellers-v1", ".env.local"),
  ]) {
    try {
      for (const linha of readFileSync(caminho, "utf-8").split("\n")) {
        const l = linha.trim();
        if (!l || l.startsWith("#")) continue;
        const i = l.indexOf("=");
        if (i <= 0) continue;
        const k = l.slice(0, i).trim();
        if (!process.env[k]) process.env[k] = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
      }
      return true;
    } catch { /* proximo */ }
  }
  return false;
}

async function main(): Promise<void> {
  log("\n== CDS IA — AGENT-FACTORY-F7b.4: catalogo externo (Composio REAL) ==");
  log(`env carregado: ${carregarEnvLocal() ? "sim" : "NAO"}`);

  // ─── A. O id canonico (puro) ───────────────────────────────────────

  secao("A. A Function externa na gramatica que o banco aceita");
  {
    const r = idDaFuncaoExterna({ toolkit: "googlesheets", acao: "GOOGLESHEETS_ADD_SHEET" });
    ok("A1  o id canonico tem tres segmentos, em minuscula",
      r.ok && r.funcaoId === "composio.googlesheets.googlesheets_add_sheet",
      r.ok ? r.funcaoId : r.motivo);
    ok("A2  e passa no MESMO formato que o CHECK do banco exige",
      r.ok && FORMATO_DO_BANCO.test(r.funcaoId));

    // O CHECK real, copiado da migration. Se as duas divergirem, a
    // permissao seria aceita aqui e recusada no INSERT.
    const CHECK_DA_MIGRATION = /^[a-z0-9]+(\.[a-z0-9_]+)+$/;
    ok("A3  a copia do CHECK e a MESMA expressao da migration",
      FORMATO_DO_BANCO.source === CHECK_DA_MIGRATION.source);

    ok("A4  hifen no slug e normalizado, e o resultado segue valido",
      (() => {
        const x = idDaFuncaoExterna({ toolkit: "google-super", acao: "SOME-ACTION" });
        return x.ok && FORMATO_DO_BANCO.test(x.funcaoId) &&
          x.funcaoId === "composio.google_super.some_action";
      })());
    ok("A5  toolkit vazio e RECUSADO, nao vira id degradado",
      !idDaFuncaoExterna({ toolkit: "", acao: "X" }).ok);
    ok("A6  acao que normaliza para vazio tambem",
      !idDaFuncaoExterna({ toolkit: "gs", acao: "!!!" }).ok);

    ok("A7  externa e reconhecivel por inspecao",
      ehFuncaoExterna("composio.googlesheets.googlesheets_add_sheet"));
    ok("A8  e Function INTERNA nao e confundida com externa",
      !ehFuncaoExterna("planilha.ler") && !ehFuncaoExterna("calculadora.calcular"));
    ok("A9  id de 2 ou 4 segmentos nao passa",
      !ehFuncaoExterna("composio.googlesheets") &&
        !ehFuncaoExterna("composio.a.b.c"));
    ok("A10 a volta devolve as pecas certas",
      (() => {
        const p = pecasDoId("composio.googlesheets.googlesheets_add_sheet");
        return p?.toolkit === "googlesheets" && p.acao === "googlesheets_add_sheet";
      })());
    ok("A11 e devolve null para id interno",
      pecasDoId("planilha.ler") === null);

    // Nenhum id externo pode colidir com Function interna.
    const internas = Object.keys(FUNCOES);
    ok("A12 nenhuma Function interna comeca com o prefixo externo",
      internas.every((i) => !i.startsWith("composio.")), internas.join(",").slice(0, 80));
  }

  // ─── B. Risco: escrita nunca ganha autonomia por engano ────────────

  secao("B. Leitura, escrita e desconhecido — e o default de cada um");
  {
    ok("B1  verbo de leitura classifica como leitura",
      riscoDaAcao("GOOGLESHEETS_GET_SPREADSHEET_INFO") === "leitura" &&
        riscoDaAcao("GMAIL_LIST_THREADS") === "leitura");
    ok("B2  verbo de escrita classifica como escrita",
      riscoDaAcao("GOOGLESHEETS_ADD_SHEET") === "escrita" &&
        riscoDaAcao("GMAIL_SEND_EMAIL") === "escrita");
    // O empate e o caso perigoso: `GET_AND_UPDATE` le E escreve.
    ok("B3  ESCRITA vence o empate — nao vira leitura por acidente",
      riscoDaAcao("SOMETHING_GET_AND_UPDATE_ROW") === "escrita");
    ok("B4  slug sem verbo conhecido fica DESCONHECIDO",
      riscoDaAcao("GOOGLESHEETS_XYZZY") === "desconhecido");

    ok("B5  so leitura recebe `automatico` recomendado",
      nivelRecomendado("leitura") === "automatico");
    ok("B6  escrita recomenda APROVACAO",
      nivelRecomendado("escrita") === "aprovacao");
    ok("B7  e desconhecido tambem — a duvida nao vira autonomia",
      nivelRecomendado("desconhecido") === "aprovacao");
  }

  // ─── C. O GUARD: nenhuma externa executa sem ele ───────────────────

  secao("C. A Function externa passa pelo MESMO guard, antes do adapter");
  {
    const ID_EXT = "composio.googlesheets.googlesheets_add_sheet";

    // O fato de existencia vem do VINCULO que o dono criou, e nao de
    // `FUNCOES`. E isso que permite reusar o guard sem duplicar registry.
    const funcoes: FatoFuncao[] = [
      ...Object.keys(FUNCOES).map((id) => ({ id, existe: true })),
      { id: ID_EXT, existe: true },
    ];
    const conexoes: readonly FatoConexao[] = [];

    /** Espiao: registra se o adapter externo teria sido chamado. */
    let adapterChamado = 0;
    const executarExterna = async () => { adapterChamado += 1; return "executou"; };

    /** O caminho completo: guard primeiro, adapter depois. E so depois. */
    async function tentar(permissoes: readonly FatoPermissao[]) {
      const g = autorizarFuncao({
        funcaoId: ID_EXT, conexaoNecessaria: null, funcoes, permissoes, conexoes,
      });
      if (!g.permitido) return { permitido: false as const, estado: g.estado, codigo: g.codigo };
      await executarExterna();
      return { permitido: true as const, estado: "executou", codigo: null };
    }

    // 1. Selecionada e automatica -> chega ao adapter.
    adapterChamado = 0;
    const auto = await tentar([{ funcaoId: ID_EXT, nivel: "automatico" }]);
    ok("C1  automatica: o guard permite e o adapter executa",
      auto.permitido && adapterChamado === 1);

    // 2. Bloqueada -> o adapter NUNCA e chamado.
    adapterChamado = 0;
    const bloq = await tentar([{ funcaoId: ID_EXT, nivel: "bloqueado" }]);
    ok("C2  bloqueada: o guard nega",
      !bloq.permitido && bloq.estado === "negado", String(bloq.codigo));
    ok("C3  e o adapter externo NAO foi chamado",
      adapterChamado === 0, String(adapterChamado));

    // 3. Aprovacao -> para antes do adapter.
    adapterChamado = 0;
    const apr = await tentar([{ funcaoId: ID_EXT, nivel: "aprovacao" }]);
    ok("C4  aprovacao: para antes de executar",
      !apr.permitido && apr.estado === "aguardando_aprovacao", String(apr.codigo));
    ok("C5  e o adapter externo NAO foi chamado",
      adapterChamado === 0, String(adapterChamado));

    // 4. Permissao AUSENTE -> negado, adapter intocado.
    adapterChamado = 0;
    const sem = await tentar([]);
    ok("C6  sem permissao: o guard nega",
      !sem.permitido, String(sem.codigo));
    ok("C7  e o adapter externo NAO foi chamado",
      adapterChamado === 0, String(adapterChamado));

    // 5. CONTROLE NEGATIVO: sem a perna do guard, o adapter executaria.
    //    Sem este controle, C3/C5/C7 passariam com um adapter quebrado.
    adapterChamado = 0;
    await executarExterna();
    ok("C8  CONTROLE: o espiao do adapter FUNCIONA quando chamado",
      adapterChamado === 1);

    // 6. Nao declarada como fato -> inexistente, nao "permitida".
    adapterChamado = 0;
    const g = autorizarFuncao({
      funcaoId: "composio.notion.notion_create_page",
      conexaoNecessaria: null,
      funcoes, // nao contem essa
      permissoes: [{ funcaoId: "composio.notion.notion_create_page", nivel: "automatico" }],
      conexoes,
    });
    // `ResultadoGuard` e uma uniao: `codigo` so existe no ramo negado.
    // Estreitar antes de ler e o que o `tsc` cobra — e esta certo,
    // porque um `permitido: true` com codigo seria contradicao.
    ok("C9  externa NAO vinculada e inexistente, mesmo com permissao",
      !g.permitido && g.codigo === "funcao_inexistente",
      g.permitido ? "permitiu" : g.codigo);
  }

  // ─── D. Nenhuma meta-tool irrestrita ───────────────────────────────

  secao("D. O modelo nunca recebe um executor universal");
  {
    const cli = readFileSync(join(__dirname, "..", "lib", "agentes", "composio",
      "cliente.ts"), "utf-8");
    const semCom = cli.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

    ok("D1  o cliente NAO tem executor de tool",
      !/\/tools\/execute|execute_?tool|MULTI_EXECUTE|proxy/i.test(semCom));
    ok("D2  e so faz GET — nao ha POST ao Composio",
      !/method:\s*"POST"/.test(semCom) && /method:\s*"GET"/.test(semCom));
    ok("D3  o cliente e server-only",
      /^import "server-only";/m.test(cli));
    ok("D4  a chave e lida de UM lugar so",
      (cli.match(/process\.env\.COMPOSIO_API_KEY/g) ?? []).length === 1);
    ok("D5  o SDK do Composio NAO esta instalado — nem em package.json",
      !/@composio\/core|composio-core/.test(
        readFileSync(join("C:", "Users", "USER", "Desktop",
          "calculadora-dos-sellers-v1", "package.json"), "utf-8")));

    // A declaracao ao modelo continua saindo de `declararFerramentas`,
    // que le PERMISSOES — e nao do catalogo externo.
    const ferr = readFileSync(join(__dirname, "..", "lib", "agentes", "ia",
      "ferramentas.ts"), "utf-8");
    ok("D6  a declaracao ao modelo nao importa o catalogo externo",
      !/composio/i.test(ferr));
  }

  // ─── E. O catalogo REAL ────────────────────────────────────────────

  secao("E. O catalogo, contra a API real");
  if (!catalogoExternoConfigurado()) {
    ok("E0  COMPOSIO_API_KEY presente", false, "ausente");
  } else {
    const sheets = await buscarToolkits("sheets", 8);
    ok("E1  a busca responde",
      sheets.estado === "ok", sheets.estado === "ok" ? "" : JSON.stringify(sheets));

    if (sheets.estado === "ok") {
      const gs = sheets.dados.itens.find((t) => t.slug === "googlesheets");
      ok("E2  Google Sheets aparece na busca por `sheets`",
        gs !== undefined, sheets.dados.itens.map((t) => t.slug).join(","));
      ok("E3  com nome de gente, nao slug",
        gs?.nome === "Google Sheets", String(gs?.nome));
      ok("E4  e o catalogo diz que ele EXIGE conexao",
        gs?.semAutenticacao === false, String(gs?.semAutenticacao));
      ok("E5  a busca e PAGINADA — nao devolve o catalogo inteiro",
        sheets.dados.itens.length <= 8 && sheets.dados.totalDisponivel < 100,
        `itens=${sheets.dados.itens.length} total=${sheets.dados.totalDisponivel}`);

      const acoes = await listarAcoesDoToolkit("googlesheets", 10);
      ok("E6  as acoes reais do toolkit sao descobertas",
        acoes.estado === "ok" && acoes.dados.itens.length > 0,
        acoes.estado === "ok" ? `n=${acoes.dados.itens.length}` : acoes.estado);

      if (acoes.estado === "ok") {
        ok("E7  ha mais acoes do que o limite pedido — e o limite e respeitado",
          acoes.dados.totalDisponivel > acoes.dados.itens.length &&
            acoes.dados.itens.length <= 10,
          `itens=${acoes.dados.itens.length} total=${acoes.dados.totalDisponivel}`);

        // Toda acao descoberta tem de virar um id que o banco aceita.
        const ids = acoes.dados.itens.map((a) =>
          idDaFuncaoExterna({ toolkit: "googlesheets", acao: a.slug }));
        ok("E8  TODA acao real vira um funcao_id valido",
          ids.every((r) => r.ok && FORMATO_DO_BANCO.test(r.funcaoId)),
          ids.filter((r) => !r.ok).length + " recusadas");
        ok("E9  e os ids sao unicos entre si",
          new Set(ids.filter((r) => r.ok).map((r) => (r as { funcaoId: string }).funcaoId)).size
            === ids.length);

        // Classificacao das acoes reais: nenhuma de escrita pode
        // recomendar `automatico`.
        const escritas = acoes.dados.itens
          .map((a) => ({ slug: a.slug, risco: riscoDaAcao(a.slug) }))
          .filter((x) => x.risco !== "leitura");
        ok("E10 nenhuma acao de escrita/desconhecida recomenda automatico",
          escritas.every((x) => nivelRecomendado(x.risco) === "aprovacao"),
          escritas.map((x) => `${x.slug}=${x.risco}`).join(",").slice(0, 120));
        log(`        (classificacao das ${acoes.dados.itens.length} primeiras: ` +
          acoes.dados.itens.map((a) => riscoDaAcao(a.slug)[0]).join("") + ")");
      }
    }

    // Termo sem resultado nao e erro.
    const nada = await buscarToolkits("zzzz-nao-existe-zzzz", 5);
    ok("E11 termo sem resultado devolve lista vazia, nao falha",
      nada.estado === "ok" && nada.dados.itens.length === 0,
      nada.estado === "ok" ? "" : nada.estado);
  }

  // ─── F. Falha do Composio nao derruba o interno ────────────────────

  secao("F. Composio fora: ferramentas internas seguem inteiras");
  {
    const salvo = process.env.COMPOSIO_API_KEY;
    delete process.env.COMPOSIO_API_KEY;
    const r = await buscarToolkits("sheets", 3);
    ok("F1  sem chave, a busca devolve `nao_configurado` — nao lanca",
      r.estado === "nao_configurado", r.estado);
    ok("F2  e as Functions internas continuam no registry",
      Object.keys(FUNCOES).length > 0 && "calculadora.calcular" in FUNCOES);
    const g = autorizarFuncao({
      funcaoId: "calculadora.calcular", conexaoNecessaria: null,
      funcoes: Object.keys(FUNCOES).map((id) => ({ id, existe: true })),
      permissoes: [{ funcaoId: "calculadora.calcular", nivel: "automatico" }],
      conexoes: [],
    });
    ok("F3  e o guard interno continua decidindo normalmente", g.permitido);
    if (salvo !== undefined) process.env.COMPOSIO_API_KEY = salvo;
    ok("F4  ANCORA: a chave foi restaurada para o resto da execucao",
      process.env.COMPOSIO_API_KEY === salvo);
  }

  log("\n-- placar ------------------------------------------------------");
  log(`  PASS ${passou}   FAIL ${falhou}`);
  if (falhou > 0) process.exitCode = 1;
}

void main().catch((e) => {
  log(`erro fatal: ${limpar(String((e as Error).message ?? "")).slice(0, 300)}`);
  process.exitCode = 1;
});
