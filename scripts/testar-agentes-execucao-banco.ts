/**
 * Motor de execucao contra o BANCO REAL — AGENTES-FASE1C.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │ ESTA SUITE ESCREVE NO BANCO. Excecao declarada a regra do        │
 * │ projeto, por isso e um arquivo SEPARADO de                       │
 * │ `testar-agentes-execucao.ts`, que continua a custo zero.         │
 * └──────────────────────────────────────────────────────────────────┘
 *
 *     npx tsx scripts/testar-agentes-execucao-banco.ts --confirmo
 *
 * SEM `--confirmo` nao toca o banco: imprime o que faria e sai com 0.
 *
 * ── O que ela prova ─────────────────────────────────────────────────
 * As garantias que SO existem no banco: atomicidade do claim,
 * concorrencia real, retry, recuperacao de orfa, e os privilegios das
 * tres funcoes novas.
 *
 * Ela chama as RPCs DIRETAMENTE, contornando a capability — pelo mesmo
 * motivo da suite de isolamento da 1B: o que se quer provar e que a
 * garantia vale mesmo quando ninguem passa pelo TypeScript.
 *
 * ── Dados sinteticos e limpeza ──────────────────────────────────────
 * `user_id` com prefixo `teste-exec-1c-`, inexistente em producao.
 * Limpeza em `finally`, ordem tarefas -> agentes (ON DELETE RESTRICT
 * recusa o contrario), com RECONTAGEM ao final.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { join } from "path";

// O HANDLER REAL. Importado de proposito: fixar `{eco, executado}` a mao
// aqui provaria a RPC, nao o motor — a suite passaria mesmo que o handler
// tivesse sido trocado por outro. Ele e puro (sem banco, sem rede, sem
// `server-only`), entao importa-lo aqui nao exige nenhum shim.
import { handlerTesteFundacao } from "../lib/agentes/handlers/teste-fundacao";
import type { ContextoTarefa } from "../lib/agentes/tipos-execucao";

function carregarEnvLocal() {
  try {
    const raw = readFileSync(join(__dirname, "..", ".env.local"), "utf-8");
    for (const linha of raw.split("\n")) {
      const l = linha.trim();
      if (!l || l.startsWith("#")) continue;
      const i = l.indexOf("=");
      if (i === -1) continue;
      const k = l.slice(0, i).trim();
      let v = l.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch {
    /* ausente — segue com o ambiente */
  }
}
carregarEnvLocal();

const CONFIRMADO = process.argv.includes("--confirmo");
const PREFIXO = "teste-exec-1c-";
const USUARIO_A = `${PREFIXO}A`;

let passou = 0;
let falhou = 0;
function ok(nome: string, cond: boolean, det = "") {
  if (cond) { passou++; console.log(`  ok  ${nome}`); }
  else { falhou++; console.error(`  x   ${nome}${det ? `  [${det}]` : ""}`); }
}
const codigoDe = (e: unknown): string => (e as { code?: string } | null)?.code ?? "SEM_ERRO";

/**
 * Houve tarefa reivindicada?
 *
 * ── O contrato observado do PostgREST ───────────────────────────────
 * `claim_next_agente_tarefa()` e `RETURNS public.agente_tarefas`. Quando
 * ela faz `RETURN NULL`, o PostgREST NAO entrega `null` ao supabase-js:
 * entrega um OBJETO COMPOSTO com as 16 colunas nulas —
 *
 *   {"id":null,"agente_id":null,"user_id":null, … }
 *
 * — que e truthy em JavaScript. Comparar com `=== null` mede a forma do
 * transporte, nao a existencia da tarefa, e foi o que fez 4 asserts
 * falharem na primeira execucao deste gate enquanto o motor estava
 * correto (confirmado por `SELECT claim_next_agente_tarefa() IS NULL`
 * em SQL puro, que devolveu `true`).
 *
 * A verdade nao esta no invólucro, esta no `id`: existe tarefa se, e
 * somente se, veio um `id` valido. E o MESMO criterio que
 * `scripts/agentes-worker.mjs` ja aplica em producao — centralizado aqui
 * num lugar so, em vez de repetido em cada assert.
 *
 * Aceita: null · undefined · objeto composto com id=null · array vazio ·
 * array com objeto de id=null · objeto ou array com tarefa de id valido.
 */
function temTarefaReivindicada(valor: unknown): boolean {
  const linha = Array.isArray(valor) ? valor[0] : valor;
  if (linha === null || linha === undefined) return false;
  if (typeof linha !== "object") return false;
  const id = (linha as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0;
}

/** Cria um agente e uma tarefa sinteticos. Devolve os dois ids. */
async function semear(
  db: SupabaseClient,
  opcoes: { ativo?: boolean; maxTentativas?: number; tipo?: string } = {}
) {
  const { data: ag } = await db
    .from("agentes")
    .insert({ user_id: USUARIO_A, nome: "Agente 1C", tipo: "gerente", ativo: opcoes.ativo ?? true })
    .select("id")
    .single();
  const { data: tf } = await db
    .from("agente_tarefas")
    .insert({
      agente_id: ag!.id,
      user_id: USUARIO_A,
      tipo: opcoes.tipo ?? "teste_fundacao",
      entrada: { mensagem: "teste" },
      max_tentativas: opcoes.maxTentativas ?? 3,
    })
    .select("id")
    .single();
  return { agenteId: ag!.id as string, tarefaId: tf!.id as string };
}

async function limpar(db: SupabaseClient) {
  await db.from("agente_tarefas").delete().like("user_id", `${PREFIXO}%`);
  await db.from("agentes").delete().like("user_id", `${PREFIXO}%`);
}

async function main() {
  if (!CONFIRMADO) {
    console.log(`
Esta suite ESCREVE no banco (agentes e tarefas sinteticos, apagados ao final).

  npx tsx scripts/testar-agentes-execucao-banco.ts --confirmo

Pre-requisito: migration 20260917_agentes_execucao.sql ja aplicada.
`);
    return;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !chave) {
    console.error("ERRO: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes (.env.local).");
    process.exitCode = 1;
    return;
  }
  const db = createClient(url, chave);

  try {
    await limpar(db);

    // ── 1. Ciclo completo ────────────────────────────────────────────
    console.log("\n1. Ciclo pendente -> rodando -> concluido");
    {
      const { tarefaId } = await semear(db);
      const { data: cl, error: eCl } = await db.rpc("claim_next_agente_tarefa");
      const t = Array.isArray(cl) ? cl[0] : cl;
      ok("1.1 claim devolve a tarefa", t?.id === tarefaId, codigoDe(eCl));
      ok("1.2 status virou rodando", t?.status === "rodando", String(t?.status));
      ok("1.3 tentativas incrementou no claim", t?.tentativas === 1, String(t?.tentativas));
      ok("1.4 iniciado_em e heartbeat_em gravados", !!t?.iniciado_em && !!t?.heartbeat_em);

      // ── O HANDLER REAL executa aqui ────────────────────────────────
      // O contexto e montado a partir da LINHA reivindicada, exatamente
      // como `executar-tarefa.ts` faz. Sem HTTP (isso e o proximo gate),
      // mas com o handler de verdade — nao um resultado fixado a mao.
      const contexto: ContextoTarefa = {
        tarefaId: t.id,
        agenteId: t.agente_id,
        userId: t.user_id,
        tipo: t.tipo,
        entrada: t.entrada ?? {},
        tentativa: t.tentativas,
        maxTentativas: t.max_tentativas,
      };
      const progressos: number[] = [];
      const resultadoDoHandler = await handlerTesteFundacao(contexto, (p) => progressos.push(p));
      ok("1.5 handler real executou e reportou 0 -> 50 -> 100",
         JSON.stringify(progressos) === JSON.stringify([0, 50, 100]), JSON.stringify(progressos));
      ok("1.6 handler devolveu o contrato exato",
         JSON.stringify(resultadoDoHandler) === JSON.stringify({ eco: "teste", executado: true }),
         JSON.stringify(resultadoDoHandler));

      const { data: cc, error: eCc } = await db.rpc("concluir_tarefa", {
        p_tarefa_id: tarefaId,
        p_resultado: resultadoDoHandler,
      });
      const f = Array.isArray(cc) ? cc[0] : cc;
      ok("1.7 concluir_tarefa devolve a linha", !!f?.id, codigoDe(eCc));
      ok("1.8 status = concluido", f?.status === "concluido", String(f?.status));
      ok("1.9 progresso forcado a 100", f?.progresso === 100, String(f?.progresso));
      ok("1.10 resultado do HANDLER persistido no banco",
         JSON.stringify(f?.resultado) === JSON.stringify({ eco: "teste", executado: true }),
         JSON.stringify(f?.resultado));
      ok("1.11 concluido_em gravado", !!f?.concluido_em);
      ok("1.12 heartbeat_em zerado no terminal", f?.heartbeat_em === null, String(f?.heartbeat_em));

      // Fora de ordem LANCA — nunca no-op silencioso.
      const { error: eDup } = await db.rpc("concluir_tarefa", { p_tarefa_id: tarefaId, p_resultado: {} });
      ok("1.13 concluir de novo LANCA (55000)", codigoDe(eDup) === "55000", codigoDe(eDup));
      const { error: eFal } = await db.rpc("falhar_tarefa", {
        p_tarefa_id: tarefaId, p_erro_tipo: "handler_falhou", p_erro_mensagem: "x",
      });
      ok("1.14 falhar apos concluir LANCA — nunca ambos", codigoDe(eFal) === "55000", codigoDe(eFal));
      await limpar(db);
    }

    // ── 2. Claim unico sob concorrencia ──────────────────────────────
    console.log("\n2. Claim unico (concorrencia)");
    {
      const { tarefaId } = await semear(db);
      // Dois clientes = duas conexoes. Chamadas simultaneas.
      const db2 = createClient(url, chave);
      const [r1, r2] = await Promise.all([
        db.rpc("claim_next_agente_tarefa"),
        db2.rpc("claim_next_agente_tarefa"),
      ]);
      const l1 = Array.isArray(r1.data) ? r1.data[0] : r1.data;
      const l2 = Array.isArray(r2.data) ? r2.data[0] : r2.data;
      const pegaram = [l1?.id, l2?.id].filter(Boolean);
      // Ids sinteticos — nenhum dado real. Impressos porque a prova de
      // concorrencia pedida e "com IDs e contagens".
      console.log(`      tarefa semeada : ${tarefaId}`);
      console.log(`      claim A devolveu: ${l1?.id ?? "NULL"}`);
      console.log(`      claim B devolveu: ${l2?.id ?? "NULL"}`);
      ok("2.1 exatamente UM worker pegou a tarefa", pegaram.length === 1, `pegaram=${pegaram.length}`);
      ok("2.2 quem pegou pegou a tarefa certa", pegaram[0] === tarefaId);
      ok("2.3 o outro recebeu NULL, sem erro", !r1.error && !r2.error);
      ok("2.4 tentativas subiu UMA vez so", await (async () => {
           const { data } = await db.from("agente_tarefas").select("tentativas").eq("id", tarefaId).single();
           return data?.tentativas === 1;
         })(), "duplicaria se o SKIP LOCKED falhasse");
      await limpar(db);
    }

    // ── 3. N tarefas, N claims: nenhuma duplicada ────────────────────
    console.log("\n3. Nenhuma duplicacao com fila maior");
    {
      const { agenteId } = await semear(db);
      const extras = Array.from({ length: 4 }, () => ({
        agente_id: agenteId, user_id: USUARIO_A, tipo: "teste_fundacao", entrada: { mensagem: "t" },
      }));
      await db.from("agente_tarefas").insert(extras);
      const clientes = Array.from({ length: 5 }, () => createClient(url, chave));
      const res = await Promise.all(clientes.map((c) => c.rpc("claim_next_agente_tarefa")));
      const ids = res.map((r) => (Array.isArray(r.data) ? r.data[0] : r.data)?.id).filter(Boolean);
      console.log(`      reivindicados: ${ids.length}  |  distintos: ${new Set(ids).size}`);
      ok("3.1 5 claims sobre 5 tarefas devolvem 5 linhas", ids.length === 5, String(ids.length));
      ok("3.2 sem repeticao de id", new Set(ids).size === ids.length, `unicos=${new Set(ids).size}`);
      await limpar(db);
    }

    // ── 4. Agente inativo ────────────────────────────────────────────
    console.log("\n4. Agente inativo pausa a fila (nao cancela)");
    {
      const { agenteId, tarefaId } = await semear(db, { ativo: false });
      const { data: c1 } = await db.rpc("claim_next_agente_tarefa");
      ok("4.1 tarefa de agente inativo NAO e reivindicada", !temTarefaReivindicada(c1));
      const { data: t1 } = await db
        .from("agente_tarefas")
        .select("status, tentativas, heartbeat_em, iniciado_em")
        .eq("id", tarefaId)
        .single();
      ok("4.2 a tarefa continua PENDENTE (nao cancelada)", t1?.status === "pendente", String(t1?.status));
      // O claim nao pode ter TOCADO a tarefa — nem contando tentativa.
      ok("4.3 tentativas NAO mudou", t1?.tentativas === 0, String(t1?.tentativas));
      ok("4.4 iniciado_em continua NULL", t1?.iniciado_em === null, String(t1?.iniciado_em));
      ok("4.5 heartbeat_em continua NULL", t1?.heartbeat_em === null, String(t1?.heartbeat_em));

      await db.from("agentes").update({ ativo: true }).eq("id", agenteId);
      const { data: c2 } = await db.rpc("claim_next_agente_tarefa");
      ok("4.6 reativado, a tarefa volta a ser reivindicada",
         (Array.isArray(c2) ? c2[0] : c2)?.id === tarefaId);
      await limpar(db);
    }

    // ── 5. Retry e max_tentativas ────────────────────────────────────
    console.log("\n5. Retry respeita max_tentativas");
    {
      const { tarefaId } = await semear(db, { maxTentativas: 2 });
      const { data: a } = await db.rpc("claim_next_agente_tarefa");
      ok("5.1 1o claim, tentativas=1", (Array.isArray(a) ? a[0] : a)?.tentativas === 1);
      const { data: f1 } = await db.rpc("falhar_tarefa", {
        p_tarefa_id: tarefaId, p_erro_tipo: "handler_falhou", p_erro_mensagem: "falha 1",
      });
      const l1 = Array.isArray(f1) ? f1[0] : f1;
      ok("5.2 falha com tentativa sobrando -> volta a PENDENTE", l1?.status === "pendente", String(l1?.status));
      ok("5.3 erro_tipo PRESERVADO no retry", l1?.erro_tipo === "handler_falhou", String(l1?.erro_tipo));
      ok("5.3b erro_mensagem PRESERVADA no retry", l1?.erro_mensagem === "falha 1", String(l1?.erro_mensagem));
      ok("5.3c heartbeat_em zerado no retry", l1?.heartbeat_em === null, String(l1?.heartbeat_em));
      // A tarefa NAO terminou — `concluido_em` marcaria um fim que nao houve.
      ok("5.3d concluido_em continua NULL no retry", l1?.concluido_em === null, String(l1?.concluido_em));

      const { data: b } = await db.rpc("claim_next_agente_tarefa");
      ok("5.4 2o claim, tentativas=2", (Array.isArray(b) ? b[0] : b)?.tentativas === 2);
      const { data: f2 } = await db.rpc("falhar_tarefa", {
        p_tarefa_id: tarefaId, p_erro_tipo: "handler_falhou", p_erro_mensagem: "falha 2",
      });
      const l2 = Array.isArray(f2) ? f2[0] : f2;
      ok("5.5 tentativas esgotadas -> ERRO terminal", l2?.status === "erro", String(l2?.status));
      ok("5.6 erro_tipo registrado no terminal", l2?.erro_tipo === "handler_falhou");
      ok("5.6b erro_mensagem registrada no terminal", l2?.erro_mensagem === "falha 2", String(l2?.erro_mensagem));
      ok("5.7 concluido_em gravado no terminal", !!l2?.concluido_em);
      ok("5.7b heartbeat_em zerado no terminal", l2?.heartbeat_em === null, String(l2?.heartbeat_em));

      const { data: c } = await db.rpc("claim_next_agente_tarefa");
      ok("5.8 3o claim NAO reivindica (tentativas >= max)", !temTarefaReivindicada(c));
      await limpar(db);
    }

    // ── 6. Recuperacao de orfa ───────────────────────────────────────
    console.log("\n6. Recuperacao de orfa (at-least-once)");
    {
      const { tarefaId } = await semear(db);
      await db.rpc("claim_next_agente_tarefa");

      // CONTROLE NEGATIVO primeiro: heartbeat recente NAO ressuscita.
      const { data: c0 } = await db.rpc("claim_next_agente_tarefa");
      ok("6.1 CONTROLE: heartbeat recente NAO e ressuscitado", !temTarefaReivindicada(c0));

      // Envelhece o heartbeat em 10 minutos (limite e 5). Estado
      // sintetico preparado direto — nao se espera 5 minutos reais.
      const velho = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      await db.from("agente_tarefas").update({ heartbeat_em: velho }).eq("id", tarefaId);
      const { data: c1 } = await db.rpc("claim_next_agente_tarefa");
      const l = Array.isArray(c1) ? c1[0] : c1;
      ok("6.2 heartbeat orfao (>5min) E ressuscitado", l?.id === tarefaId);
      ok("6.3 a ressurreicao conta como nova tentativa", l?.tentativas === 2, String(l?.tentativas));
      ok("6.4 status continua rodando", l?.status === "rodando", String(l?.status));
      // O heartbeat foi RENOVADO: se continuasse velho, o proximo claim
      // ressuscitaria de novo, em loop.
      ok("6.5 heartbeat_em foi RENOVADO (nao e mais o valor velho)",
         !!l?.heartbeat_em && l.heartbeat_em !== velho, String(l?.heartbeat_em));
      ok("6.6 o novo heartbeat esta dentro da janela de 5 min",
         !!l?.heartbeat_em && Date.now() - new Date(l.heartbeat_em).getTime() < 5 * 60 * 1000);
      ok("6.7 iniciado_em atualizado para ESTA tentativa",
         !!l?.iniciado_em && new Date(l.iniciado_em).getTime() > new Date(velho).getTime());
      // Confirmacao independente: com o heartbeat renovado, um novo
      // claim NAO pode pega-la de novo.
      const { data: c2 } = await db.rpc("claim_next_agente_tarefa");
      ok("6.8 renovada, NAO e ressuscitada outra vez", !temTarefaReivindicada(c2));
      await limpar(db);
    }

    // ── 6b. Isolamento de tenant — a FK composta da 1B ───────────────
    // Repetido AQUI, e nao so na suite da 1B, porque a 1C introduziu
    // caminhos novos de escrita (as 3 RPCs). A garantia precisa valer
    // depois deles, nao so antes.
    console.log("\n6b. Isolamento de tenant (FK composta continua valendo)");
    {
      const { agenteId } = await semear(db);
      const OUTRO = `${PREFIXO}B`;
      const { data: agB } = await db
        .from("agentes")
        .insert({ user_id: OUTRO, nome: "Agente B", tipo: "ads" })
        .select("id")
        .single();

      const { error: eCross } = await db.from("agente_tarefas").insert({
        agente_id: agenteId, user_id: OUTRO, tipo: "teste_fundacao",
      });
      ok("6b.1 tarefa de B sobre agente de A REJEITADA (23503)",
         codigoDe(eCross) === "23503", codigoDe(eCross));

      // CONTROLE NEGATIVO: sem ele, 6b.1 poderia estar passando porque a
      // tabela recusa qualquer insert.
      const { error: eOk } = await db.from("agente_tarefas").insert({
        agente_id: agB!.id, user_id: OUTRO, tipo: "teste_fundacao",
      });
      ok("6b.2 CONTROLE: par coerente (B sobre agente de B) ACEITO", !eOk, codigoDe(eOk));

      const { error: eUpd } = await db.from("agentes").update({ user_id: OUTRO }).eq("id", agenteId);
      ok("6b.3 trocar o dono de agente com tarefa REJEITADO (23503)",
         codigoDe(eUpd) === "23503", codigoDe(eUpd));
      await limpar(db);
    }

    // ── 7. Validacoes das RPCs ───────────────────────────────────────
    console.log("\n7. Validacao de parametro e estado");
    {
      const { tarefaId } = await semear(db);
      const { error: e1 } = await db.rpc("concluir_tarefa", { p_tarefa_id: tarefaId, p_resultado: {} });
      ok("7.1 concluir tarefa PENDENTE LANCA (55000)", codigoDe(e1) === "55000", codigoDe(e1));
      const { error: e2 } = await db.rpc("falhar_tarefa", {
        p_tarefa_id: tarefaId, p_erro_tipo: "x", p_erro_mensagem: "y",
      });
      ok("7.2 falhar tarefa PENDENTE LANCA (55000)", codigoDe(e2) === "55000", codigoDe(e2));

      await db.rpc("claim_next_agente_tarefa");
      const { error: e3 } = await db.rpc("falhar_tarefa", {
        p_tarefa_id: tarefaId, p_erro_tipo: "   ", p_erro_mensagem: "y",
      });
      ok("7.3 erro_tipo vazio LANCA (22023)", codigoDe(e3) === "22023", codigoDe(e3));
      const { error: e4 } = await db.rpc("concluir_tarefa", { p_tarefa_id: null, p_resultado: {} });
      ok("7.4 tarefa_id NULL LANCA (22023)", codigoDe(e4) === "22023", codigoDe(e4));
      await limpar(db);
    }

    // ── 8. CHECKs provados por UPDATE DIRETO ─────────────────────────
    // `concluir_tarefa` FORCA progresso=100, entao o CHECK e inalcancavel
    // por ela. Provado aqui contornando a RPC — que e justamente onde o
    // CHECK precisa valer.
    console.log("\n8. CHECKs do banco (contornando as RPCs)");
    {
      const { tarefaId } = await semear(db);
      await db.rpc("claim_next_agente_tarefa");
      const { error: e1 } = await db.from("agente_tarefas")
        .update({ status: "concluido", progresso: 40 }).eq("id", tarefaId);
      ok("8.1 UPDATE direto concluido com progresso 40 e recusado (23514)",
         codigoDe(e1) === "23514", codigoDe(e1));
      const { error: e2 } = await db.from("agente_tarefas")
        .update({ status: "erro", erro_tipo: null }).eq("id", tarefaId);
      ok("8.2 UPDATE direto erro sem erro_tipo e recusado (23514)",
         codigoDe(e2) === "23514", codigoDe(e2));
      await limpar(db);
    }

    // ── 9. Privilegios das 3 funcoes ─────────────────────────────────
    console.log("\n9. Privilegios das 3 RPCs");
    {
      const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      if (anonKey) {
        const dbAnon = createClient(url, anonKey);
        for (const fn of ["claim_next_agente_tarefa", "concluir_tarefa", "falhar_tarefa"]) {
          const args = fn === "claim_next_agente_tarefa"
            ? {}
            : fn === "concluir_tarefa"
              ? { p_tarefa_id: "00000000-0000-0000-0000-000000000000", p_resultado: {} }
              : { p_tarefa_id: "00000000-0000-0000-0000-000000000000", p_erro_tipo: "x", p_erro_mensagem: "y" };
          const { error } = await dbAnon.rpc(fn, args as never);
          ok(`9.x anon NAO executa ${fn}`, !!error, codigoDe(error));
        }
      } else {
        console.log("  --  NEXT_PUBLIC_SUPABASE_ANON_KEY ausente: 9.x nao executados");
      }
    }
  } finally {
    console.log("\n10. Limpeza");
    await limpar(db);
    const { count: cT } = await db.from("agente_tarefas").select("id", { count: "exact", head: true }).like("user_id", `${PREFIXO}%`);
    const { count: cA } = await db.from("agentes").select("id", { count: "exact", head: true }).like("user_id", `${PREFIXO}%`);
    ok("10.1 zero tarefas sinteticas remanescentes", (cT ?? 0) === 0, String(cT));
    ok("10.2 zero agentes sinteticos remanescentes", (cA ?? 0) === 0, String(cA));
    const { count: tA } = await db.from("agentes").select("id", { count: "exact", head: true });
    const { count: tT } = await db.from("agente_tarefas").select("id", { count: "exact", head: true });
    ok("10.3 tabela agentes de volta a ZERO", (tA ?? -1) === 0, String(tA));
    ok("10.4 tabela agente_tarefas de volta a ZERO", (tT ?? -1) === 0, String(tT));

    const total = passou + falhou;
    console.log(`\n${"=".repeat(58)}`);
    console.log(`AGENTES-FASE1C — motor no banco:  ${passou}/${total} passaram`);
    if (falhou > 0) { console.log(`${falhou} FALHARAM`); process.exitCode = 1; }
    else console.log("TODOS OS ASSERTS PASSARAM");
    console.log("=".repeat(58));
  }
}

main().catch((e) => {
  console.error("ERRO NAO TRATADO:", e instanceof Error ? e.message.slice(0, 300) : "desconhecido");
  process.exitCode = 1;
});
