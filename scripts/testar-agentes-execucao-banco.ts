/**
 * Motor de execucao contra o BANCO REAL — AGENTES-FASE1C.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │ ESTA SUITE ESCREVE NO BANCO. Excecao declarada a regra do        │
 * │ projeto, por isso e um arquivo SEPARADO de                       │
 * │ `testar-agentes-execucao.ts`, que continua a custo zero.         │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * D3-A0-M1 — DIVIDA ABERTA. NAO EXECUTAR ESTA SUITE.
 *
 * D3-A0-M1: esta suite ainda contem chamadas ao contrato legado de DOIS
 * argumentos de `aguardar_aprovacao_tarefa` — quatro call sites, todos
 * montando corpo `{ p_tarefa_id, p_tentativa_esperada }`.
 *
 * Apos o apply da migration
 * `20261003_remover_aguardar_aprovacao_tarefa_2args.sql`, essa overload
 * deixa de existir no banco. A partir dai esta suite NAO e valida para
 * execucao: os quatro call sites passariam a receber PGRST202 (funcao
 * inexistente) no lugar dos codigos de negocio que eles afirmam. O
 * assert de privilegio do anon ficaria pior ainda — passaria pelo
 * motivo errado, porque PGRST202 tambem nao e codigo de negocio.
 *
 * As quatro chamadas ficam como estao, DE PROPOSITO. Corrigi-las aqui
 * exigiria desenhar Approval fixtures novas numa suite que nao pode ser
 * executada nesta fase — isso transformaria o D3 de limpeza de schema
 * em redesenho de suite proibida. Pior: converter para tres argumentos
 * com UUID falso, `null`, `randomUUID()` ou assert desligado faria a
 * divida sumir do texto sem sumir do mundo. A divida fica visivel e
 * verdadeira ate ser paga.
 *
 * CRITERIO DE SAIDA — D3-A0-M1 so fecha quando esta suite for
 * redesenhada para CRIAR/USAR uma Approval causal valida (mesma tarefa,
 * mesmo dono, mesmo agente, estado ativo) e passar EXATAMENTE essa
 * Approval.id como p_aprovacao_id, o terceiro argumento da overload de
 * TRES argumentos.
 *
 * A amarracao E o criterio, e nao as duas metades soltas. Uma Approval
 * causal criada e depois NAO usada no terceiro argumento nao fecha a
 * divida; e chamar a overload de tres argumentos com um id de outra
 * origem fecha menos ainda — a RPC recusaria fail-closed, e o teste
 * passaria a provar a recusa, nunca a pausa. Nao fecha no D3.
 *
 * `scripts/testar-agentes-execucao.ts` (secao T) contem um guard
 * estatico que exige este marcador enquanto houver chamada legada aqui:
 * apagar o marcador sem migrar as chamadas deixa a matriz VERMELHA.
 *
 *     npx tsx scripts/testar-agentes-execucao-banco.ts --confirmo
 *
 * SEM `--confirmo` nao toca o banco: imprime o que faria e sai com 0.
 *
 * ── DUAS AUTORIZACOES, PORQUE HA DOIS NIVEIS DE RISCO ───────────────
 *
 * `claim_next_agente_tarefa()` e GLOBAL: nao recebe parametro algum,
 * varre `agente_tarefas` inteira e reivindica a elegivel MAIS ANTIGA
 * (`ORDER BY t.criado_em ASC`), de QUALQUER dono. A fixture desta suite
 * nasce agora, logo e sempre a MAIS NOVA — se houver uma tarefa real
 * elegivel, o claim leva a real, nao a fixture. E leva MUTANDO:
 * `status = 'rodando'` sem executor, `tentativas + 1`, `iniciado_em` e
 * `heartbeat_em` sobrescritos. A limpeza por prefixo NAO desfaz isso,
 * porque a linha atingida nao tem o prefixo. Repeticoes podem esgotar
 * `max_tentativas` e deixar a tarefa real inalcancavel para sempre.
 *
 * Por isso as duas flags:
 *
 *   --confirmo
 *       Testes ESCOPADOS. Toda escrita e endereçada por id de fixture
 *       ou por `user_id LIKE 'teste-exec-1c-%'`. NENHUMA chamada ao
 *       claim global e alcancavel.
 *
 *   --confirmo --confirmo-claim-global
 *       Acrescenta as secoes 1 a 8, que chamam o claim global. Exige as
 *       DUAS: a segunda e autorizacao ADICIONAL, nunca substituta.
 *       Rodar so com a fila comprovadamente drenada — e mesmo assim
 *       sobra a janela em que uma tarefa `rodando` vira elegivel apenas
 *       pela passagem dos 5 minutos de heartbeat.
 *
 * ── O que ela prova ─────────────────────────────────────────────────
 * As garantias que SO existem no banco. No modo escopado: a transicao
 * de pausa, o fencing por tentativa e os privilegios das RPCs. No modo
 * de claim global: atomicidade do claim, concorrencia real, retry e
 * recuperacao de orfa.
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

/**
 * Autorizacao ADICIONAL, nunca substituta. A flag e longa e literal de
 * proposito: `--all`, `--full`, `--force` ou `--yes` sao teclaveis por
 * engano; `--confirmo-claim-global` nomeia exatamente o que libera.
 */
const CONFIRMADO_CLAIM_GLOBAL = process.argv.includes("--confirmo-claim-global");

/** A conjuncao e a unica porta do bloco perigoso. As DUAS flags. */
const CLAIM_GLOBAL_LIBERADO = CONFIRMADO && CONFIRMADO_CLAIM_GLOBAL;

const PREFIXO = "teste-exec-1c-";
/**
 * `user_id` real neste projeto e UUID (ver `assinarSessao`), e nenhum
 * UUID comeca por `teste-exec-1c-`. A limpeza por prefixo nao alcanca
 * linha de producao pela FORMA do identificador, nao por sorte — e
 * continua segura com a tabela cheia.
 */
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

/**
 * Cria agente + tarefa sinteticos JA em `rodando`, sem passar pelo
 * claim.
 *
 * ── Por que INSERT direto, e nao `claim_next_agente_tarefa()` ───────
 *
 * O claim e global: ele escolhe a tarefa mais antiga da tabela inteira,
 * nao a que acabamos de semear. Usa-lo so para promover a fixture era o
 * caminho pelo qual esta suite podia sequestrar uma tarefa real.
 *
 * O INSERT e legal: `agente_tarefas_status_valido` aceita `'rodando'`;
 * `agente_tarefas_erro_explicado` so cobra `erro_tipo` quando o status e
 * `'erro'`; `agente_tarefas_concluido_completo` so cobra `progresso=100`
 * quando o status e `'concluido'`; e a tabela nao tem trigger algum.
 *
 * O que se perde: esta fixture nao prova que o claim sabe promover. Isso
 * e proposital — quem prova o claim e o bloco perigoso, sob a outra
 * flag. Aqui o assunto e a transicao de pausa.
 */
async function semearEmRodando(
  db: SupabaseClient,
  opcoes: { tentativas: number; progresso: number; maxTentativas?: number }
) {
  const { data: ag } = await db
    .from("agentes")
    .insert({ user_id: USUARIO_A, nome: "Agente P0", tipo: "gerente", ativo: true })
    .select("id")
    .single();
  const agora = new Date().toISOString();
  const { data: tf } = await db
    .from("agente_tarefas")
    .insert({
      agente_id: ag!.id,
      user_id: USUARIO_A,
      tipo: "teste_fundacao",
      entrada: { mensagem: "teste" },
      status: "rodando",
      tentativas: opcoes.tentativas,
      max_tentativas: opcoes.maxTentativas ?? 3,
      progresso: opcoes.progresso,
      iniciado_em: agora,
      heartbeat_em: agora,
    })
    .select("id, status, tentativas, progresso, iniciado_em")
    .single();
  return {
    agenteId: ag!.id as string,
    tarefaId: tf!.id as string,
    linha: tf as unknown as Record<string, unknown>,
  };
}

async function limpar(db: SupabaseClient) {
  await db.from("agente_tarefas").delete().like("user_id", `${PREFIXO}%`);
  await db.from("agentes").delete().like("user_id", `${PREFIXO}%`);
}

async function main() {
  if (!CONFIRMADO) {
    console.log(`
Esta suite ESCREVE no banco (agentes e tarefas sinteticos, apagados ao final).
Nenhuma escrita foi autorizada: nada foi tocado.

  npx tsx scripts/testar-agentes-execucao-banco.ts --confirmo
      Modo ESCOPADO. Toda escrita e endereçada por id de fixture ou pelo
      prefixo '${PREFIXO}'. ZERO chamadas a claim_next_agente_tarefa.

  npx tsx scripts/testar-agentes-execucao-banco.ts --confirmo --confirmo-claim-global
      Acrescenta as secoes 1 a 8, que chamam o claim GLOBAL e podem
      reivindicar e MUTAR uma tarefa REAL de outro dono. As DUAS flags
      sao obrigatorias.

Pre-requisitos: migrations 20260917_agentes_execucao.sql e
20260929_agente_tarefa_aguardar_aprovacao.sql ja aplicadas.
`);
    if (CONFIRMADO_CLAIM_GLOBAL) {
      console.log("AVISO: --confirmo-claim-global sozinho NAO autoriza nada. Falta --confirmo.");
    }
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

    // ── BLOCO PERIGOSO: so roda com AUTORIZACAO ADICIONAL ────────────
    //
    // As secoes 1 a 8 provam o que SO o claim global consegue provar —
    // atomicidade, SKIP LOCKED, concorrencia, retry e recuperacao de
    // orfa. Elas continuam valendo e continuam aqui, inteiras. O que
    // mudou e que agora exigem `--confirmo-claim-global` ALEM de
    // `--confirmo`. Ver o cabecalho deste arquivo.
    if (CLAIM_GLOBAL_LIBERADO) {
      console.log("\n*** CLAIM_GLOBAL_DANGEROUS_ENABLED ***");
      console.log("    As proximas secoes chamam claim_next_agente_tarefa(), que e GLOBAL:");
      console.log("    ela reivindica a tarefa elegivel MAIS ANTIGA da tabela inteira, de");
      console.log("    qualquer dono, e MUTA essa linha (status, tentativas, iniciado_em,");
      console.log("    heartbeat_em). Rode isto somente com a fila comprovadamente drenada.");
      await testarClaimGlobalPerigoso(db, url, chave);
    } else {
      console.log("\n1-8. CLAIM_GLOBAL_SKIPPED — secoes que exigem claim_next global NAO rodaram.");
      console.log("     Atomicidade, SKIP LOCKED, concorrencia, retry e recuperacao de orfa");
      console.log("     NAO foram provadas nesta execucao. Para prova-las, acrescente");
      console.log("     --confirmo-claim-global (exige --confirmo junto).");
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

    // ── 9. Privilegios das RPCs ENDERECADAS ──────────────────────────
    //
    // Estas tres recebem `p_tarefa_id` explicito. O uuid nulo abaixo nao
    // existe, e as RPCs nao tem varredura: mesmo que o REVOKE estivesse
    // errado, o pior desfecho seria um 55000 sobre uma linha inexistente
    // — nenhuma linha real e alcancavel sem conhecer um id real.
    //
    // `claim_next_agente_tarefa` NAO esta aqui, e nao e esquecimento: o
    // cenario de falha dela e varrer a tabela inteira e reivindicar. O
    // probe dela vive no bloco perigoso, como 9b.1.
    console.log("\n9. Privilegios das RPCs endereçadas (sem claim global)");
    {
      const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      if (anonKey) {
        // ── O ALVO e uma fixture DEDICADA desta execucao ──────────────
        //
        // O uuid nulo `00000000-…` parecia seguro porque `gen_random_uuid()`
        // (v4) nunca o produz. Mas NADA no schema o proibe: `id` e
        // `uuid PRIMARY KEY DEFAULT gen_random_uuid()`, sem CHECK — um
        // INSERT que informe o id explicitamente pode grava-lo. A
        // impossibilidade era de CONVENCAO, nao de constraint, e este
        // probe existe justamente para o mundo em que uma premissa
        // falhou.
        //
        // Com uma fixture propria, a invariante passa a ser estrutural:
        // se o REVOKE estiver quebrado e a RPC de fato executar, a unica
        // linha que ela pode alcancar e esta, criada agora, apagada pela
        // limpeza por prefixo. Nunca uma linha externa.
        const { tarefaId: ALVO_PRIVILEGIO } = await semear(db);
        const dbAnon = createClient(url, anonKey);

        // ── E o assert discrimina o MOTIVO do erro ───────────────────
        //
        // `!!error` sozinho e falso-verde: com o REVOKE quebrado, a RPC
        // executaria de verdade, nao acharia a tarefa em `rodando` e
        // devolveria 55000 — um erro, e o probe passaria anunciando uma
        // protecao que nao existe. Erro de NEGOCIO nao prova privilegio;
        // so um erro de ACESSO prova.
        const CODIGOS_DE_NEGOCIO = ["55000", "22023", "23514", "23503"];
        const barradoPorPrivilegio = (e: unknown) =>
          !!e && !CODIGOS_DE_NEGOCIO.includes(codigoDe(e));

        for (const fn of ["concluir_tarefa", "falhar_tarefa"]) {
          const args = fn === "concluir_tarefa"
            ? { p_tarefa_id: ALVO_PRIVILEGIO, p_resultado: {}, p_tentativa_esperada: 1 }
            : { p_tarefa_id: ALVO_PRIVILEGIO, p_erro_tipo: "x", p_erro_mensagem: "y",
                p_tentativa_esperada: 1 };
          const { error } = await dbAnon.rpc(fn, args as never);
          ok(`9.x anon barrado por PRIVILEGIO em ${fn}`, barradoPorPrivilegio(error), codigoDe(error));
        }
        // FUNCTION-RUNTIME-P0: a quarta RPC segue a mesma regra.
        const { error: eAnonPausa } = await dbAnon.rpc("aguardar_aprovacao_tarefa", {
          p_tarefa_id: ALVO_PRIVILEGIO,
          p_tentativa_esperada: 1,
        } as never);
        ok("9.x anon barrado por PRIVILEGIO em aguardar_aprovacao_tarefa",
          barradoPorPrivilegio(eAnonPausa), codigoDe(eAnonPausa));

        // CONTROLE: a sonda sabe dizer NAO. Um 55000 — exatamente o que
        // uma RPC executada devolveria — NAO pode contar como barrado.
        ok("9.x CONTROLE: 55000 NAO conta como barrado por privilegio",
          !barradoPorPrivilegio({ code: "55000" }));

        await limpar(db);
      } else {
        console.log("  --  NEXT_PUBLIC_SUPABASE_ANON_KEY ausente: 9.x nao executados");
      }
    }

    // ── 11. FUNCTION-RUNTIME-P0: a pausa, e o fencing por tentativa ──
    //
    // O que esta secao prova e que `status = 'rodando'` SOZINHO nao
    // protege nada: o claim recupera orfa com `rodando -> rodando`
    // direto, incrementando `tentativas`. Sem o fencing, um worker da
    // tentativa 1 pausaria a execucao da tentativa 2.
    //
    // ── ZERO claim global aqui ───────────────────────────────────────
    //
    // A fixture entra em `rodando` por INSERT proprio (`semearEmRodando`),
    // com a tentativa que ESTE teste escolheu. Nao ha por que perguntar
    // ao banco qual e a tentativa corrente: o teste a inseriu. Toda
    // chamada abaixo e endereçada por `F`, o id da propria fixture.
    console.log("\n11. Pausa por aprovacao (fencing por tentativa) — escopado, sem claim");
    {
      // Tentativa explicita, > 0 e < max_tentativas (3). NAO vem de claim.
      const N = 2;
      const PROGRESSO = 42;
      const { tarefaId: F, linha } = await semearEmRodando(db, {
        tentativas: N,
        progresso: PROGRESSO,
      });
      const iniciadoEmAntes = linha.iniciado_em as string | null;

      ok("11.1 fixture nasceu em rodando, sem passar pelo claim",
        linha.status === "rodando", String(linha.status));
      ok("11.2 tentativas = N escolhido pelo teste", linha.tentativas === N, String(linha.tentativas));
      ok("11.3 progresso semeado", linha.progresso === PROGRESSO, String(linha.progresso));
      ok("11.4 iniciado_em gravado", !!iniciadoEmAntes);

      // ── Tentativa ERRADA (stale): precisa ser recusada ────────────
      const { error: eVelha } = await db.rpc("aguardar_aprovacao_tarefa", {
        p_tarefa_id: F,
        p_tentativa_esperada: N - 1,
      });
      ok("11.5 tentativa stale (N-1) e RECUSADA com 55000", codigoDe(eVelha) === "55000", codigoDe(eVelha));

      const { data: intacta } = await db
        .from("agente_tarefas")
        .select("status, tentativas, progresso, heartbeat_em")
        .eq("id", F)
        .maybeSingle();
      ok("11.6 apos a recusa a linha continua INTACTA",
        intacta?.status === "rodando" &&
        intacta?.tentativas === N &&
        intacta?.progresso === PROGRESSO &&
        intacta?.heartbeat_em !== null,
        `${intacta?.status}/${intacta?.tentativas}/${intacta?.progresso}`);

      // ── Tentativa CORRETA: pausa ─────────────────────────────────
      const { data: pa, error: ePausa } = await db.rpc("aguardar_aprovacao_tarefa", {
        p_tarefa_id: F,
        p_tentativa_esperada: N,
      });
      const p = Array.isArray(pa) ? pa[0] : pa;
      ok("11.7 a tentativa corrente PAUSA a tarefa", !ePausa && p?.status === "aguardando_aprovacao",
        codigoDe(ePausa));
      ok("11.8 progresso PRESERVADO", p?.progresso === PROGRESSO, String(p?.progresso));
      ok("11.9 tentativas PRESERVADAS", p?.tentativas === N, String(p?.tentativas));
      ok("11.10 iniciado_em PRESERVADO (mesmo carimbo)",
        !!p?.iniciado_em && new Date(p.iniciado_em).getTime() === new Date(iniciadoEmAntes!).getTime(),
        String(p?.iniciado_em));
      ok("11.11 heartbeat_em zerado", p?.heartbeat_em === null, String(p?.heartbeat_em));
      ok("11.12 resultado NULL", p?.resultado === null);
      ok("11.13 erro_tipo NULL", p?.erro_tipo === null);
      ok("11.14 erro_mensagem NULL", p?.erro_mensagem === null);
      ok("11.15 concluido_em NULL", p?.concluido_em === null, String(p?.concluido_em));

      // ── Pausa DUPLICADA: falha explicita, nunca idempotencia muda ─
      const { error: eDup } = await db.rpc("aguardar_aprovacao_tarefa", {
        p_tarefa_id: F,
        p_tentativa_esperada: N,
      });
      ok("11.16 pausar de novo LANCA 55000", codigoDe(eDup) === "55000", codigoDe(eDup));

      const { data: aposDup } = await db
        .from("agente_tarefas")
        .select("status, tentativas, progresso")
        .eq("id", F)
        .maybeSingle();
      ok("11.17 e a recusa nao corrompeu o estado pausado",
        aposDup?.status === "aguardando_aprovacao" &&
        aposDup?.tentativas === N &&
        aposDup?.progresso === PROGRESSO,
        `${aposDup?.status}/${aposDup?.tentativas}/${aposDup?.progresso}`);

      // ── E as irmas tambem recusam, fora de rodando ────────────────
      const { error: eConcluir } = await db.rpc("concluir_tarefa", {
        p_tarefa_id: F, p_resultado: {}, p_tentativa_esperada: 1,
      });
      ok("11.18 concluir_tarefa recusa tarefa pausada", codigoDe(eConcluir) === "55000", codigoDe(eConcluir));

      // ── "pausada NAO e reivindicada pelo claim" ───────────────────
      //
      // Esta propriedade NAO e provada aqui, e nao por descuido: prova-la
      // com o claim real significaria chamar a RPC global e arriscar
      // reivindicar tarefa alheia. Ela e dedutiva e vive na suite de
      // fonte: o `WHERE` do claim so alcanca `'pendente'` e `'rodando'`,
      // e `scripts/testar-agentes-execucao.ts` (C6, C7, C16, C17) prova
      // que a disjuncao e EXATAMENTE essa — inclusive reprovando quem
      // acrescentar `aguardando_aprovacao` ao predicado.
      console.log("      (paused-not-claim: provado em testar-agentes-execucao.ts, secao C)");

      await limpar(db);
    }
  } finally {
    console.log("\n10. Limpeza");
    await limpar(db);

    // ── A prova pos-limpeza mede o MESMO universo que a limpeza apaga ─
    //
    // `limpar()` apaga por `user_id LIKE '${PREFIXO}%'`. A verificacao
    // usa o MESMO predicado, nas MESMAS duas tabelas — nao a tabela
    // inteira (producao tem linhas reais, e exigi-la vazia seria
    // falso-vermelho garantido) e nao um tenant isolado (um residuo do
    // outro tenant passaria despercebido).
    const ONDE_SINTETICO = `${PREFIXO}%`;
    const { count: cT } = await db
      .from("agente_tarefas").select("id", { count: "exact", head: true })
      .like("user_id", ONDE_SINTETICO);
    const { count: cA } = await db
      .from("agentes").select("id", { count: "exact", head: true })
      .like("user_id", ONDE_SINTETICO);
    ok("10.1 zero tarefas do PREFIXO remanescentes", (cT ?? -1) === 0, String(cT));
    ok("10.2 zero agentes do PREFIXO remanescentes", (cA ?? -1) === 0, String(cA));

    // ── 10.3: quem sobrou, se sobrou ─────────────────────────────────
    //
    // Contagem diz QUANTO; esta enumeracao diz QUEM. Mesmo universo,
    // mesmo `LIKE`. Se uma secao futura criar um tenant novo e ele
    // escapar da limpeza, o nome dele aparece aqui em vez de virar um
    // "1" sem explicacao. Continua sem tocar uma linha de producao.
    const { data: sobrasT } = await db
      .from("agente_tarefas").select("user_id").like("user_id", ONDE_SINTETICO);
    const { data: sobrasA } = await db
      .from("agentes").select("user_id").like("user_id", ONDE_SINTETICO);
    const tenantsResiduais = [
      ...new Set([...(sobrasT ?? []), ...(sobrasA ?? [])].map((l) => String(l.user_id))),
    ];
    ok(`10.3 nenhum tenant sintetico residual (${tenantsResiduais.join(", ") || "nenhum"})`,
      tenantsResiduais.length === 0);

    // ── 10.4: o universo medido COBRE todos os tenants do teste ──────
    //
    // Puramente em processo, sem consulta. 10.1-10.3 so valem enquanto
    // todo tenant que o teste cria estiver DENTRO do `LIKE`. Se alguem
    // acrescentar um tenant fora do prefixo, a limpeza nao o alcanca e
    // as contagens acima ficariam verdes sobre um universo incompleto.
    const TENANTS_DO_TESTE = [USUARIO_A, `${PREFIXO}B`];
    ok("10.4 todo tenant do teste esta dentro do universo do PREFIXO",
      TENANTS_DO_TESTE.every((t) => t.startsWith(PREFIXO)) && TENANTS_DO_TESTE.length === 2);

    console.log(
      CLAIM_GLOBAL_LIBERADO
        ? "\n  modo: CLAIM_GLOBAL_DANGEROUS_ENABLED (secoes 1-8 executadas)"
        : "\n  modo: CLAIM_GLOBAL_SKIPPED (atomicidade/SKIP LOCKED/retry/orfa NAO provados)"
    );

    const total = passou + falhou;
    console.log(`\n${"=".repeat(58)}`);
    console.log(`AGENTES-FASE1C — motor no banco:  ${passou}/${total} passaram`);
    if (falhou > 0) { console.log(`${falhou} FALHARAM`); process.exitCode = 1; }
    else console.log("TODOS OS ASSERTS PASSARAM");
    console.log("=".repeat(58));
  }
}

/**
 * ═══ BLOCO CLAIM GLOBAL PERIGOSO — secoes 1 a 8 da FASE 1C ══════════
 *
 * TUDO que chama `claim_next_agente_tarefa()` vive AQUI DENTRO, e esta
 * funcao tem UM unico chamador, guardado por `CLAIM_GLOBAL_LIBERADO`.
 * A fronteira e nominal de proposito: `scripts/testar-agentes-execucao.ts`
 * (secao R) prova estaticamente que a regiao segura do arquivo nao
 * contem nenhuma chamada ao claim — e um `if` solto no meio do codigo
 * nao daria como provar isso.
 *
 * NAO mover chamada de claim para fora desta funcao. NAO chamar esta
 * funcao de outro lugar.
 */
async function testarClaimGlobalPerigoso(db: SupabaseClient, url: string, chave: string) {
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
      // Um claim aconteceu nesta secao, entao a tentativa corrente e 1.
      p_tentativa_esperada: 1,
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
    const { error: eDup } = await db.rpc("concluir_tarefa", {
      p_tarefa_id: tarefaId, p_resultado: {}, p_tentativa_esperada: 1,
    });
    ok("1.13 concluir de novo LANCA (55000)", codigoDe(eDup) === "55000", codigoDe(eDup));
    const { error: eFal } = await db.rpc("falhar_tarefa", {
      p_tarefa_id: tarefaId, p_erro_tipo: "handler_falhou", p_erro_mensagem: "x",
      p_tentativa_esperada: 1,
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
      p_tentativa_esperada: 1,
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
      p_tentativa_esperada: 2,
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

  // ── 7. Validacoes das RPCs ───────────────────────────────────────
  console.log("\n7. Validacao de parametro e estado");
  {
    const { tarefaId } = await semear(db);
    const { error: e1 } = await db.rpc("concluir_tarefa", {
      p_tarefa_id: tarefaId, p_resultado: {}, p_tentativa_esperada: 0,
    });
    ok("7.1 concluir tarefa PENDENTE LANCA (55000)", codigoDe(e1) === "55000", codigoDe(e1));
    const { error: e2 } = await db.rpc("falhar_tarefa", {
      p_tarefa_id: tarefaId, p_erro_tipo: "x", p_erro_mensagem: "y",
      p_tentativa_esperada: 0,
    });
    ok("7.2 falhar tarefa PENDENTE LANCA (55000)", codigoDe(e2) === "55000", codigoDe(e2));

    await db.rpc("claim_next_agente_tarefa");
    const { error: e3 } = await db.rpc("falhar_tarefa", {
      p_tarefa_id: tarefaId, p_erro_tipo: "   ", p_erro_mensagem: "y",
      p_tentativa_esperada: 1,
    });
    ok("7.3 erro_tipo vazio LANCA (22023)", codigoDe(e3) === "22023", codigoDe(e3));
    const { error: e4 } = await db.rpc("concluir_tarefa", {
      p_tarefa_id: null, p_resultado: {}, p_tentativa_esperada: 1,
    });
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


  // ── 9b. Privilegio do claim, que so se prova chamando o claim ─────
  //
  // Este probe ficou AQUI, e nao na secao 9 segura, por um motivo
  // preciso: o cenario de falha que ele mede E executar o claim global
  // de verdade. Se o REVOKE estivesse errado, a propria medicao
  // reivindicaria — e mutaria — uma tarefa real.
  {
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (anonKey) {
      const dbAnon = createClient(url, anonKey);
      const { error } = await dbAnon.rpc("claim_next_agente_tarefa");
      ok("9b.1 anon NAO executa claim_next_agente_tarefa", !!error, codigoDe(error));
    } else {
      console.log("  --  NEXT_PUBLIC_SUPABASE_ANON_KEY ausente: 9b.1 nao executado");
    }
  }
}
// ═══ FIM DO BLOCO CLAIM GLOBAL PERIGOSO ════════════════════════════

main().catch((e) => {
  console.error("ERRO NAO TRATADO:", e instanceof Error ? e.message.slice(0, 300) : "desconhecido");
  process.exitCode = 1;
});
