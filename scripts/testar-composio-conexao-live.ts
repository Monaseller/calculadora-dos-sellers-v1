/**
 * AGENT-FACTORY-F7b.4.2 §14/§15 — conectar conta externa, contra a API REAL.
 *
 * ── O que esta suite prova, e o que ela deliberadamente NAO prova ────
 *
 * PROVA: que a CDS gera um link de conexao valido sem app OAuth proprio,
 * que a identidade usada e derivada no servidor e nao e o `user_id` da CDS,
 * que a propriedade da conta e conferida, e que nenhum segredo sai do
 * servidor.
 *
 * NAO PROVA que uma acao do Google Sheets executa. Para isso o OAuth teria
 * de ser concluido num Google real, e o §15 proibe usar o do Rodrigo. O
 * desfecho honesto deste turno e PENDING_USER_OAUTH: o caminho esta
 * montado e a ultima etapa e uma decisao da pessoa, nao um trabalho nosso.
 *
 * ── Limpeza ─────────────────────────────────────────────────────────
 *
 * Toda conta criada aqui e APAGADA no fim. A auth config e mantida de
 * proposito: ela e a configuracao que o produto precisa, e reusada em vez
 * de recriada — recriar por execucao deixaria lixo na conta do Composio.
 *
 * Roda com: npx tsx scripts/testar-composio-conexao-live.ts
 */
import "./_server-only-inerte";

import { readFileSync } from "node:fs";
import { join } from "node:path";

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
carregarEnvLocal();

let passou = 0;
let falhou = 0;
function ok(nome: string, cond: boolean, detalhe = ""): void {
  if (cond) { passou++; console.log(`  PASS  ${nome}`); }
  else { falhou++; console.log(`  FAIL  ${nome}${detalhe ? ` — ${detalhe}` : ""}`); }
}
function secao(t: string): void { console.log(`\n${t}`); }

const TOOLKIT = "googlesheets";
/**
 * Dois donos SINTETICOS. Nenhum e o `user_id` real do Rodrigo — o §15 nao
 * pede isso explicitamente, mas usar o id real aqui criaria uma conexao no
 * nome dele sem que ele tivesse pedido.
 */
const DONO_A = "dono-sintetico-f742-a";
const DONO_B = "dono-sintetico-f742-b";

async function main(): Promise<void> {
  console.log("\n== F7b.4.2 §14/§15 — conexao externa (Composio REAL) ==");

  const mod = await import("../lib/agentes/composio/conexao");
  const {
    ESTADOS_DA_CONTA, estadoDaConta, garantirAuthConfig, gerarLinkDeConexao,
    listarContasDoDono, principalDeConexao,
  } = mod;

  if (!process.env.COMPOSIO_API_KEY) {
    console.log("\nCOMPOSIO_API_KEY ausente — suite nao pode medir nada.");
    console.log("\nPASS 0   FAIL 1");
    process.exit(1);
  }

  const paraApagar: string[] = [];

  // ─── A. A identidade e derivada, e nao o id da CDS ──────────────────

  secao("A. A identidade no provedor externo e DERIVADA");

  const pA = principalDeConexao(DONO_A);
  const pB = principalDeConexao(DONO_B);

  ok("A1  o principal NAO contem o user_id da CDS",
    !pA.includes(DONO_A));
  ok("A2  ele e prefixado com versao — o formato pode mudar sem ambiguidade",
    pA.startsWith("cds-conta-v1:"));
  ok("A3  e o resto e um sha256 hexadecimal de 64 caracteres",
    /^cds-conta-v1:[0-9a-f]{64}$/.test(pA));
  ok("A4  DETERMINISTICO: o mesmo dono da o mesmo principal",
    principalDeConexao(DONO_A) === pA);
  ok("A5  e donos diferentes dao principais diferentes", pA !== pB);
  // ANTI-VACUIDADE: sem isto, uma funcao que devolvesse constante passaria
  // em A1..A4 inteiros.
  ok("A6  ANCORA: a funcao nao devolve constante",
    principalDeConexao("x") !== principalDeConexao("y"));

  // ─── B. A auth config gerenciada ────────────────────────────────────

  secao("B. A auth config e do COMPOSIO — sem app OAuth do Rodrigo");

  const config = await garantirAuthConfig(TOOLKIT);
  ok("B1  garantirAuthConfig responde ok", config.estado === "ok",
    config.estado === "falha" ? config.codigo : config.estado);
  if (config.estado !== "ok") {
    console.log(`\nPASS ${passou}   FAIL ${falhou + 1}`);
    process.exit(1);
  }
  ok("B2  com um id de auth config", config.dados.authConfigId.length > 0);
  ok("B3  no formato `ac_…` que a API usa",
    config.dados.authConfigId.startsWith("ac_"),
    config.dados.authConfigId.slice(0, 3));

  // IDEMPOTENCIA: a segunda chamada REUSA, e nao cria outra.
  const config2 = await garantirAuthConfig(TOOLKIT);
  ok("B4  a segunda chamada devolve a MESMA auth config",
    config2.estado === "ok" && config2.dados.authConfigId === config.dados.authConfigId);
  ok("B5  e diz explicitamente que nao criou",
    config2.estado === "ok" && config2.dados.criada === false);

  ok("B6  toolkit vazio e recusado antes de qualquer rede",
    (await garantirAuthConfig("   ")).estado === "falha");

  // ─── C. O link de conexao ───────────────────────────────────────────

  secao("C. O link e gerado, e SO o link sai do servidor");

  const link = await gerarLinkDeConexao({ userId: DONO_A, toolkit: TOOLKIT });
  ok("C1  gerarLinkDeConexao responde ok", link.estado === "ok",
    link.estado === "falha" ? link.codigo : link.estado);
  if (link.estado !== "ok") {
    console.log(`\nPASS ${passou}   FAIL ${falhou + 1}`);
    process.exit(1);
  }
  paraApagar.push(link.dados.contaId);

  ok("C2  com uma URL para a pessoa autorizar",
    link.dados.urlParaConectar.startsWith("https://"));
  ok("C3  no host de conexao do provedor",
    new URL(link.dados.urlParaConectar).host === "connect.composio.dev",
    new URL(link.dados.urlParaConectar).host);
  ok("C4  e com prazo de validade", link.dados.expiraEm !== null);
  ok("C5  e o id da conta criada", link.dados.contaId.length > 0);

  // ── §14: o que o servidor devolve NAO carrega segredo ─────────────
  //
  // A varredura e sobre o OBJETO INTEIRO, serializado. Checar campo por
  // campo deixaria passar um segredo dentro de um campo novo.
  const serializado = JSON.stringify(link.dados);
  ok("C6  a resposta NAO contem `link_token`",
    !/link_token/i.test(serializado) && !("linkToken" in link.dados));
  ok("C7  nem access token, refresh token ou client secret",
    !/access_?token|refresh_?token|client_?secret/i.test(serializado));
  ok("C8  nem a COMPOSIO_API_KEY",
    !serializado.includes(String(process.env.COMPOSIO_API_KEY)));
  ok("C9  nem o user_id da CDS",
    !serializado.includes(DONO_A));
  // ANTI-VACUIDADE do C6..C9: a varredura tem de ser capaz de ACUSAR.
  ok("C10 ANCORA: a varredura acusa um segredo plantado",
    /link_token/i.test(JSON.stringify({ ...link.dados, link_token: "x" })) &&
      JSON.stringify({ ...link.dados, k: process.env.COMPOSIO_API_KEY })
        .includes(String(process.env.COMPOSIO_API_KEY)));
  ok("C11 as chaves publicadas sao EXATAMENTE tres",
    JSON.stringify(Object.keys(link.dados).sort()) ===
      JSON.stringify(["contaId", "expiraEm", "urlParaConectar"]),
    Object.keys(link.dados).join(","));

  ok("C12 sem dono, nao gera link nenhum",
    (await gerarLinkDeConexao({ userId: "", toolkit: TOOLKIT })).estado === "falha");

  // ─── D. O estado da conta, e a PROPRIEDADE ──────────────────────────

  secao("D. O estado e conferido, e a propriedade tambem");

  const est = await estadoDaConta({ userId: DONO_A, contaId: link.dados.contaId });
  ok("D1  estadoDaConta responde ok", est.estado === "ok",
    est.estado === "falha" ? est.codigo : est.estado);
  if (est.estado === "ok") {
    // §15: o OAuth NAO foi concluido. `aguardando_dono` e a verdade.
    ok("D2  a conta esta AGUARDANDO o dono — o OAuth nao foi concluido",
      est.dados.estado === "aguardando_dono", est.dados.estado);
    ok("D3  e o estado e um dos declarados",
      (ESTADOS_DA_CONTA as readonly string[]).includes(est.dados.estado));
    ok("D4  a conta e reconhecida como DO DONO A", est.dados.doDono);
    ok("D5  com o toolkit certo", est.dados.toolkit === TOOLKIT, est.dados.toolkit);
    // O corpo traduzido nao carrega segredo, pelo mesmo motivo do C6.
    const s2 = JSON.stringify(est.dados);
    ok("D6  e a traducao nao carrega token nem chave",
      !/access_?token|refresh_?token|client_?secret/i.test(s2) &&
        !s2.includes(String(process.env.COMPOSIO_API_KEY)));

    // ── O CONTROLE que importa: o dono B nao e dono da conta de A ────
    const alheia = await estadoDaConta({ userId: DONO_B, contaId: link.dados.contaId });
    ok("D7  CONTROLE: para OUTRO dono, a MESMA conta nao e dele",
      alheia.estado === "ok" && alheia.dados.doDono === false,
      alheia.estado === "ok" ? String(alheia.dados.doDono) : alheia.estado);
    ok("D8  e isso nao depende de o id ser secreto — ele viaja pela tela",
      alheia.estado === "ok" && alheia.dados.contaId === link.dados.contaId);
  }

  ok("D9  contaId vazio e recusado antes da rede",
    (await estadoDaConta({ userId: DONO_A, contaId: "" })).estado === "falha");

  // ─── E. A lista por dono ────────────────────────────────────────────

  secao("E. A lista traz as contas do dono, e so dela");

  const listaA = await listarContasDoDono({ userId: DONO_A, toolkit: TOOLKIT });
  ok("E1  listarContasDoDono responde ok", listaA.estado === "ok",
    listaA.estado === "falha" ? listaA.codigo : listaA.estado);
  if (listaA.estado === "ok") {
    ok("E2  e a conta recem-criada esta la",
      listaA.dados.some((c) => c.contaId === link.dados.contaId),
      `${listaA.dados.length} conta(s)`);
    ok("E3  todas marcadas como do dono", listaA.dados.every((c) => c.doDono));
  }

  // O CONTROLE: o dono B nao ve a conta do dono A.
  const listaB = await listarContasDoDono({ userId: DONO_B, toolkit: TOOLKIT });
  ok("E4  CONTROLE: o dono B NAO ve a conta do dono A",
    listaB.estado === "ok" &&
      !listaB.dados.some((c) => c.contaId === link.dados.contaId),
    listaB.estado === "ok" ? `${listaB.dados.length} conta(s)` : listaB.estado);

  // ─── F. Sem chave, nada acontece ────────────────────────────────────

  secao("F. Sem credencial, o caminho fecha — e nao degrada");

  const guardada = process.env.COMPOSIO_API_KEY;
  delete process.env.COMPOSIO_API_KEY;
  const semChave = await gerarLinkDeConexao({ userId: DONO_A, toolkit: TOOLKIT });
  ok("F1  sem chave o estado e `nao_configurado`, e nao `falha`",
    semChave.estado === "nao_configurado", semChave.estado);
  ok("F2  e nao ha link nenhum na resposta",
    !("dados" in semChave));
  process.env.COMPOSIO_API_KEY = guardada;
  // ANTI-VACUIDADE: a chave voltou, e o caminho volta a funcionar.
  ok("F3  ANCORA: com a chave de volta, a auth config responde de novo",
    (await garantirAuthConfig(TOOLKIT)).estado === "ok");

  // ─── Limpeza ────────────────────────────────────────────────────────

  secao("Limpeza: as contas de teste sao apagadas");
  for (const id of paraApagar) {
    const r = await fetch(`https://backend.composio.dev/api/v3/connected_accounts/${id}`, {
      method: "DELETE",
      headers: { "x-api-key": String(process.env.COMPOSIO_API_KEY) },
    });
    ok(`L1  conta de teste apagada (${r.status})`, r.ok);
  }

  console.log(`\nPASS ${passou}   FAIL ${falhou}`);
  process.exit(falhou === 0 ? 0 : 1);
}

void main();
