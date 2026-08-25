/**
 * Isolamento de tenant NO BANCO — AGENTES-FASE1B.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │ ESTA SUITE TOCA O BANCO REAL. E a excecao declarada a regra do   │
 * │ projeto ("as suites nao chamam IA, rede nem banco, salvo onde o  │
 * │ cabecalho disser o contrario"). Por isso ela e um ARQUIVO        │
 * │ SEPARADO de `testar-agentes-fundacao.ts`, que continua a custo   │
 * │ zero e roda em qualquer lugar.                                   │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * ── O que ela prova, e por que a outra suite nao poderia ────────────
 * Que e IMPOSSIVEL criar uma tarefa do usuario B apontando para um
 * agente do usuario A — e prova isso CONTORNANDO DELIBERADAMENTE a
 * capability: `createClient` direto, service_role, INSERT cru.
 *
 * Esse contorno e o ponto. Uma prova que passasse pela capability
 * mostraria apenas que o TypeScript filtra direito; se amanha alguem
 * escrever uma rota nova, um script de manutencao ou um `psql` a mao, o
 * filtro do TypeScript nao esta la. A FK composta esta.
 *
 * ── Como se executa ────────────────────────────────────────────────
 *     npx tsx scripts/testar-agentes-isolamento-banco.ts --confirmo
 *
 * SEM `--confirmo` a suite NAO toca o banco: imprime o que faria e sai
 * com 0. A trava e proposital — este arquivo escreve e apaga linhas, e
 * um `npx tsx scripts/testar-*` distraido nao deve conseguir faze-lo.
 *
 * ── O que ela escreve, e como devolve o banco ao estado anterior ───
 * 1 agente + 1 tarefa, com `user_id` sintetico de prefixo
 * `teste-isolamento-1b-`, que nao existe em producao e nao aparece em
 * nenhuma tela. A limpeza roda em `finally` — inclusive se um assert
 * falhar no meio — e na ORDEM CERTA: tarefas primeiro, agentes depois,
 * porque `ON DELETE RESTRICT` recusa o contrario. Ao final a suite
 * RECONTA as linhas sinteticas e falha se sobrar alguma.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { join } from "path";

// ── .env.local, mesmo carregador dos workers ──────────────────────────
function carregarEnvLocal() {
  try {
    const raw = readFileSync(join(__dirname, "..", ".env.local"), "utf-8");
    for (const linha of raw.split("\n")) {
      const l = linha.trim();
      if (!l || l.startsWith("#")) continue;
      const idx = l.indexOf("=");
      if (idx === -1) continue;
      const chave = l.slice(0, idx).trim();
      let valor = l.slice(idx + 1).trim();
      if ((valor.startsWith('"') && valor.endsWith('"')) || (valor.startsWith("'") && valor.endsWith("'"))) {
        valor = valor.slice(1, -1);
      }
      if (!(chave in process.env)) process.env[chave] = valor;
    }
  } catch {
    // ausente/ilegivel — segue com o que ja estiver em process.env
  }
}
carregarEnvLocal();

const CONFIRMADO = process.argv.includes("--confirmo");

const PREFIXO = "teste-isolamento-1b-";
const USUARIO_A = `${PREFIXO}A`;
const USUARIO_B = `${PREFIXO}B`;

// SQLSTATEs esperados. Sao contrato do PostgreSQL, nao texto de mensagem
// — comparar mensagem quebraria com locale ou versao.
const VIOLACAO_FK = "23503";
const VIOLACAO_NOT_NULL = "23502";
const VIOLACAO_CHECK = "23514";

let passou = 0;
let falhou = 0;
function ok(nome: string, condicao: boolean, detalhe = "") {
  if (condicao) {
    passou++;
    console.log(`  ok  ${nome}`);
  } else {
    falhou++;
    console.error(`  x   ${nome}${detalhe ? `  [${detalhe}]` : ""}`);
  }
}

const codigoDe = (erro: unknown): string =>
  (erro as { code?: string } | null)?.code ?? "SEM_ERRO";

async function main() {
  if (!CONFIRMADO) {
    console.log(`
Esta suite ESCREVE no banco (1 agente + 1 tarefa sinteticos, apagados ao final).
Ela nao roda sem confirmacao explicita.

  npx tsx scripts/testar-agentes-isolamento-banco.ts --confirmo

Pre-requisito: a migration 20260916_agentes_fundacao.sql ja aplicada.
`);
    return;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !chave) {
    // Nomes das variaveis, nunca os valores.
    console.error("ERRO: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes (.env.local).");
    process.exitCode = 1;
    return;
  }

  // service_role de proposito: se ate ELA for barrada, nenhum papel de
  // menor privilegio consegue burlar a regra.
  const db = createClient(url, chave);

  let agenteA: string | null = null;

  try {
    // Higiene: restos de execucao anterior interrompida.
    await db.from("agente_tarefas").delete().like("user_id", `${PREFIXO}%`);
    await db.from("agentes").delete().like("user_id", `${PREFIXO}%`);

    console.log("\n1. Preparacao");
    const { data: criado, error: erroCriacao } = await db
      .from("agentes")
      .insert({ user_id: USUARIO_A, nome: "Agente de teste 1B", tipo: "mensagens" })
      .select("id")
      .single();
    ok("1.1 agente sintetico de A criado", !erroCriacao && !!criado?.id, codigoDe(erroCriacao));
    if (!criado?.id) {
      console.error("Sem agente base nao ha o que provar — interrompendo.");
      falhou++;
      return;
    }
    agenteA = criado.id as string;

    // ── O ASSERT QUE JUSTIFICA ESTA SUITE ────────────────────────────
    console.log("\n2. Isolamento de tenant (o alvo da fase)");
    const { error: erroCross } = await db
      .from("agente_tarefas")
      .insert({ agente_id: agenteA, user_id: USUARIO_B, tipo: "teste" });
    ok("2.1 tarefa de B sobre agente de A e REJEITADA (23503)",
       codigoDe(erroCross) === VIOLACAO_FK, codigoDe(erroCross));

    // ── CONTROLE NEGATIVO ────────────────────────────────────────────
    // Sem ele, 2.1 poderia estar "passando" porque a tabela recusa
    // QUALQUER insert — o que provaria nada sobre isolamento.
    console.log("\n3. Controle negativo");
    const { data: tarefaOk, error: erroOk } = await db
      .from("agente_tarefas")
      .insert({ agente_id: agenteA, user_id: USUARIO_A, tipo: "teste" })
      .select("id, status, progresso, tentativas, max_tentativas")
      .single();
    ok("3.1 tarefa de A sobre agente de A e ACEITA", !erroOk && !!tarefaOk?.id, codigoDe(erroOk));
    ok("3.2 nasce pendente", tarefaOk?.status === "pendente", String(tarefaOk?.status));
    ok("3.3 nasce com progresso 0", tarefaOk?.progresso === 0, String(tarefaOk?.progresso));
    ok("3.4 nasce com 0 tentativas e max 3",
       tarefaOk?.tentativas === 0 && tarefaOk?.max_tentativas === 3);

    console.log("\n4. RESTRICT — historico protegido");
    const { error: erroUpdate } = await db
      .from("agentes")
      .update({ user_id: USUARIO_B })
      .eq("id", agenteA);
    ok("4.1 ON UPDATE RESTRICT bloqueia troca de dono (23503)",
       codigoDe(erroUpdate) === VIOLACAO_FK, codigoDe(erroUpdate));

    const { error: erroDelete } = await db.from("agentes").delete().eq("id", agenteA);
    ok("4.2 ON DELETE RESTRICT impede apagar agente com tarefa (23503)",
       codigoDe(erroDelete) === VIOLACAO_FK, codigoDe(erroDelete));

    console.log("\n5. NOT NULL fecha o furo do MATCH SIMPLE");
    const { error: erroNulo } = await db
      .from("agente_tarefas")
      .insert({ agente_id: agenteA, user_id: null, tipo: "teste" });
    ok("5.1 user_id NULL e recusado (23502)",
       codigoDe(erroNulo) === VIOLACAO_NOT_NULL, codigoDe(erroNulo));

    console.log("\n6. CHECKs de dominio");
    const { error: erroTipo } = await db
      .from("agentes")
      .insert({ user_id: USUARIO_A, nome: "x", tipo: "tipo_inexistente" });
    ok("6.1 tipo fora do CHECK e recusado (23514)",
       codigoDe(erroTipo) === VIOLACAO_CHECK, codigoDe(erroTipo));

    const { error: erroStatus } = await db
      .from("agente_tarefas")
      .insert({ agente_id: agenteA, user_id: USUARIO_A, tipo: "t", status: "thinking" });
    ok("6.2 status 'thinking' e recusado — nao e estado persistido (23514)",
       codigoDe(erroStatus) === VIOLACAO_CHECK, codigoDe(erroStatus));

    const { error: erroErro } = await db
      .from("agente_tarefas")
      .insert({ agente_id: agenteA, user_id: USUARIO_A, tipo: "t", status: "erro" });
    ok("6.3 status 'erro' sem erro_tipo e recusado (23514)",
       codigoDe(erroErro) === VIOLACAO_CHECK, codigoDe(erroErro));

    const { error: erroConcl } = await db
      .from("agente_tarefas")
      .insert({ agente_id: agenteA, user_id: USUARIO_A, tipo: "t", status: "concluido", progresso: 40 });
    ok("6.4 'concluido' com progresso != 100 e recusado (23514)",
       codigoDe(erroConcl) === VIOLACAO_CHECK, codigoDe(erroConcl));

    console.log("\n7. Privilegios das duas tabelas novas");
    // anon nao pode enxergar nada. Provado com a chave anon de verdade,
    // nao por consulta ao catalogo: e o caminho que um browser teria.
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (anonKey) {
      const dbAnon = createClient(url, anonKey);
      const { error: erroAnonAgentes } = await dbAnon.from("agentes").select("id").limit(1);
      const { error: erroAnonTarefas } = await dbAnon.from("agente_tarefas").select("id").limit(1);
      ok("7.1 anon NAO le agentes", !!erroAnonAgentes, codigoDe(erroAnonAgentes));
      ok("7.2 anon NAO le agente_tarefas", !!erroAnonTarefas, codigoDe(erroAnonTarefas));
    } else {
      console.log("  --  NEXT_PUBLIC_SUPABASE_ANON_KEY ausente: 7.1/7.2 nao executados");
    }
  } finally {
    // ── Limpeza: ORDEM OBRIGATORIA (RESTRICT recusa o contrario) ─────
    console.log("\n8. Limpeza");
    const { error: limpezaTarefas } = await db
      .from("agente_tarefas")
      .delete()
      .like("user_id", `${PREFIXO}%`);
    const { error: limpezaAgentes } = await db
      .from("agentes")
      .delete()
      .like("user_id", `${PREFIXO}%`);
    ok("8.1 tarefas sinteticas removidas", !limpezaTarefas, codigoDe(limpezaTarefas));
    ok("8.2 agentes sinteticos removidos", !limpezaAgentes, codigoDe(limpezaAgentes));

    // Nao basta o delete nao ter dado erro — reconta.
    const { count: sobraT } = await db
      .from("agente_tarefas")
      .select("id", { count: "exact", head: true })
      .like("user_id", `${PREFIXO}%`);
    const { count: sobraA } = await db
      .from("agentes")
      .select("id", { count: "exact", head: true })
      .like("user_id", `${PREFIXO}%`);
    ok("8.3 zero tarefas sinteticas remanescentes", (sobraT ?? 0) === 0, String(sobraT));
    ok("8.4 zero agentes sinteticos remanescentes", (sobraA ?? 0) === 0, String(sobraA));

    const total = passou + falhou;
    console.log(`\n${"=".repeat(58)}`);
    console.log(`AGENTES-FASE1B — isolamento no banco:  ${passou}/${total} passaram`);
    if (falhou > 0) {
      console.log(`${falhou} FALHARAM`);
      process.exitCode = 1;
    } else {
      console.log("TODOS OS ASSERTS PASSARAM");
    }
    console.log("=".repeat(58));
  }
}

main().catch((e) => {
  // Nunca imprimir o objeto inteiro: ele carrega URL e headers.
  console.error("ERRO NAO TRATADO:", e instanceof Error ? e.message.slice(0, 300) : "desconhecido");
  process.exitCode = 1;
});
