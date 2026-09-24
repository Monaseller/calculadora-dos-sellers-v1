/**
 * `agente_perguntas_continuacao` — COMPORTAMENTO contra o Postgres. I4B2.
 *
 * ── O que so o banco pode provar ────────────────────────────────────
 *
 * Comparacao-e-troca, corrida entre dois escritores, FK composta,
 * CHECK e privilegio sao todos do Postgres. Uma suite que confirmasse
 * isso com duplos estaria confirmando a si mesma.
 *
 * E aqui tambem mora a prova que fecha `PAGINATION_OVERFLOW_F1`: uma
 * sequencia de operacoes progride 0 -> 50 -> 100 -> 150 SEM que nenhum
 * chamador escolha deslocamento nenhum.
 *
 * ── Onde roda ───────────────────────────────────────────────────────
 *
 * SOMENTE num Supabase local descartavel. Exige `--confirmo`, URL local
 * e `QUESTION_INBOX_TEST_DATABASE_URL` local: esta suite ESCREVE.
 *
 * Rodar:
 *   NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:54321" \
 *   SUPABASE_SERVICE_ROLE_KEY="<local>" \
 *   QUESTION_INBOX_TEST_DATABASE_URL="postgresql://...54322/postgres" \
 *     npx tsx scripts/testar-agentes-continuacao-perguntas-banco.ts --confirmo
 */
import "./_server-only-inerte";

import { Client } from "pg";

import type { PerguntaRecebida } from "@/lib/agentes/dados/perguntas";
import { gravarPerguntasNaInbox } from "@/lib/agentes/dados/perguntas-inbox";
import {
  avancarContinuacao,
  iniciarContinuacao,
  lerContinuacao,
  reapontarContinuacao,
  reiniciarContinuacao,
  type Continuacao,
} from "@/lib/agentes/dados/continuacao-perguntas";
import {
  registrarAberturaAcao,
  registrarDesfechoAcao,
} from "@/lib/agentes/acoes/auditoria-acao";
import {
  sincronizarPerguntas,
  PAGE_LIMIT,
  type PortasSincronizacao,
} from "@/lib/agentes/ingestao/sincronizar-perguntas";

const HOSTS_LOCAIS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

function conferirAmbiente(): { onde: string } {
  if (!process.argv.includes("--confirmo")) {
    throw new Error("falta --confirmo: esta suite escreve e commita fixtures");
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL ausente");
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY ausente");
  }
  const alvo = new URL(url);
  if (!HOSTS_LOCAIS.has(alvo.hostname)) {
    throw new Error(`hospedeiro "${alvo.hostname}" nao e local`);
  }
  const direto = process.env.QUESTION_INBOX_TEST_DATABASE_URL;
  if (!direto) throw new Error("QUESTION_INBOX_TEST_DATABASE_URL ausente");
  if (!HOSTS_LOCAIS.has(new URL(direto).hostname)) {
    throw new Error("QUESTION_INBOX_TEST_DATABASE_URL nao aponta para host local");
  }
  return { onde: `${alvo.hostname}:${alvo.port}` };
}

const DONO_A = "aaaaaaaa-0000-4000-8000-0000000014b1";
const DONO_B = "bbbbbbbb-0000-4000-8000-0000000014b2";
const AGENTE_A = "11111111-1111-4111-8111-0000000014b3";
const AGENTE_B = "22222222-2222-4222-8222-0000000014b4";
const LOJA_A = "cccccccc-0000-4000-8000-0000000014b5";
const LOJA_A2 = "dddddddd-0000-4000-8000-0000000014b6";
const LOJA_B = "eeeeeeee-0000-4000-8000-0000000014b7";

let passou = 0;
let falhou = 0;
const ok = (nome: string, cond: boolean, det = ""): void => {
  if (cond) { passou += 1; console.log(`  PASS  ${nome}`); }
  else { falhou += 1; console.log(`  FAIL  ${nome}${det ? `  — ${det}` : ""}`); }
};
const secao = (t: string) =>
  console.log(`\n── ${t} ${"─".repeat(Math.max(2, 58 - t.length))}`);

const pergunta = (o: Partial<PerguntaRecebida> = {}): PerguntaRecebida => ({
  id: "Q1", anuncioId: "MLB1", texto: "Acompanha manual?",
  status: "UNANSWERED", criadaEm: "2026-09-20T10:00:00.000-04:00", ...o,
});

let seqChave = 0;
const chaveNova = () => {
  seqChave += 1;
  return `n8n:i4b2-t${seqChave}:sincronizar_perguntas:ag`;
};

/**
 * Portas com provider FALSO e tudo mais REAL: inbox, auditoria e cursor.
 *
 * `janelas` descreve o que o provider devolve para CADA deslocamento
 * pedido — e assim que a progressao 0 -> 50 -> 100 e exercitada de
 * verdade, sem o teste escolher o deslocamento.
 */
function portas(
  janelas: (deslocamento: number) => { linhas: PerguntaRecebida[]; truncado: boolean },
  lojaId: string,
  userId: string,
  agenteId: string,
  espiao?: { deslocamentos: number[] }
): PortasSincronizacao {
  return {
    lerAgente: async () => ({ agente: { agenteId, userId, ativo: true }, erro: null }),
    executar: async (entrada: { argumentos?: unknown }) => {
      const args = (entrada.argumentos ?? {}) as { deslocamento?: number };
      const desloc = args.deslocamento ?? 0;
      espiao?.deslocamentos.push(desloc);
      const janela = janelas(desloc);
      return {
        tipo: "sucesso",
        requestId: `req-${desloc}`,
        envelope: {
          contrato: 1, ok: true, request_id: `req-${desloc}`,
          data: {
            linhas: janela.linhas, truncado: janela.truncado, erro: null,
            providerRecebidas: janela.linhas.length, descartadasNormalizacao: 0,
          },
        },
        auditoria: "completa",
        autoridade: { lojaId },
      };
    },
    gravar: gravarPerguntasNaInbox,
    abrirAcao: registrarAberturaAcao,
    fecharAcao: registrarDesfechoAcao,
    lerCursor: lerContinuacao,
    iniciarCursor: iniciarContinuacao,
    avancarCursor: avancarContinuacao,
    reiniciarCursor: reiniciarContinuacao,
    reapontarCursor: reapontarContinuacao,
  } as unknown as PortasSincronizacao;
}

/** Uma janela CHEIA — o provider diz que ha mais. */
const cheia = (marca: string, desloc: number) => ({
  linhas: Array.from({ length: PAGE_LIMIT }, (_, i) =>
    pergunta({ id: `${marca}-${desloc + i}` })),
  truncado: true,
});

async function main(): Promise<void> {
  const { onde } = conferirAmbiente();
  console.log("\n══ CDS IA — continuacao de perguntas: comportamento real (I4B2) ══");
  console.log(`  alvo = ${onde}   (chaves nunca impressas)`);

  const pg = new Client({ connectionString: process.env.QUESTION_INBOX_TEST_DATABASE_URL });
  await pg.connect();
  await pg.query("set statement_timeout = 30000");

  const linhaDoCursor = async (agente: string) =>
    (await pg.query(
      `select loja_id::text as loja_id, proximo_deslocamento, versao::int as versao
         from public.agente_perguntas_continuacao where agente_id = $1::uuid`,
      [agente])).rows[0] ?? null;
  const contarInbox = async (loja: string) =>
    Number((await pg.query(
      "select count(*)::int as n from public.agente_perguntas_ml where loja_id = $1::uuid",
      [loja])).rows[0].n);
  const sqlstate = async (sql: string, args: unknown[] = []): Promise<string | null> => {
    try { await pg.query(sql, args); return null; }
    catch (e) { return (e as { code?: string }).code ?? "SEM_CODIGO"; }
  };

  const limpar = async () => {
    await pg.query("delete from public.agente_perguntas_continuacao where user_id in ($1,$2)",
      [DONO_A, DONO_B]);
    await pg.query("delete from public.agente_acao_execucoes where user_id in ($1,$2)",
      [DONO_A, DONO_B]);
    await pg.query("delete from public.agente_perguntas_ml where user_id in ($1,$2)",
      [DONO_A, DONO_B]);
  };

  try {
    await limpar();
    for (const loja of [LOJA_A, LOJA_A2, LOJA_B]) {
      await pg.query("delete from public.lojas where id = $1::uuid", [loja]);
    }
    for (const agente of [AGENTE_A, AGENTE_B]) {
      await pg.query("delete from public.agentes where id = $1::uuid", [agente]);
    }
    for (const [dono, agente] of [[DONO_A, AGENTE_A], [DONO_B, AGENTE_B]] as const) {
      await pg.query(
        `insert into public.agentes (id, user_id, nome, tipo, ativo)
         values ($1::uuid, $2, 'AGENTE SINTETICO I4B2', 'mensagens', true)`, [agente, dono]);
    }
    for (const [dono, loja, nome] of [
      [DONO_A, LOJA_A, "ML A"], [DONO_A, LOJA_A2, "ML A2"], [DONO_B, LOJA_B, "ML B"],
    ] as const) {
      await pg.query(
        `insert into public.lojas (id, nome, marketplace, user_id, ativo)
         values ($1::uuid, $2, 'ML', $3, true)`, [loja, nome, dono]);
    }

    // =================================================================
    secao("C. Leitura, criacao e as tres trocas");
    // =================================================================

    {
      const r = await lerContinuacao({ userId: DONO_A, agenteId: AGENTE_A });
      ok("C1  sem linha, a leitura diz `ausente` — e a varredura comeca em 0",
        r.estado === "ausente", r.estado);
    }

    let cursor: Continuacao;
    {
      const r = await iniciarContinuacao({
        userId: DONO_A, agenteId: AGENTE_A, lojaId: LOJA_A, proximoDeslocamento: 50,
      });
      ok("C2  o cursor nasce com a conta AUTORITATIVA e versao 1",
        r.estado === "aplicada" && r.continuacao.lojaId === LOJA_A
        && r.continuacao.proximoDeslocamento === 50 && r.continuacao.versao === 1,
        r.estado);
      if (r.estado !== "aplicada") throw new Error("C2 nao aplicou");
      cursor = r.continuacao;
    }

    {
      const r = await iniciarContinuacao({
        userId: DONO_A, agenteId: AGENTE_A, lojaId: LOJA_A, proximoDeslocamento: 0,
      });
      ok("C2b criar de novo PERDE na chave primaria, e nao sobrescreve",
        r.estado === "perdida" && (await linhaDoCursor(AGENTE_A))?.proximo_deslocamento === 50,
        r.estado);
    }

    {
      const r = await avancarContinuacao(cursor, LOJA_A, 100);
      ok("C3/C4 avanco 50 -> 100 e a versao sobe",
        r.estado === "aplicada" && r.continuacao.proximoDeslocamento === 100
        && r.continuacao.versao === 2, r.estado);
      if (r.estado === "aplicada") cursor = r.continuacao;
    }

    {
      const r = await reiniciarContinuacao(cursor, LOJA_A);
      ok("C5  travessia completa reinicia 100 -> 0, na MESMA conta",
        r.estado === "aplicada" && r.continuacao.proximoDeslocamento === 0
        && r.continuacao.lojaId === LOJA_A && r.continuacao.versao === 3, r.estado);
      if (r.estado === "aplicada") cursor = r.continuacao;
    }

    {
      // C11: uma escrita com a versao ANTIGA nao pode vencer.
      const obsoleto: Continuacao = { ...cursor, versao: 1, proximoDeslocamento: 50 };
      const r = await avancarContinuacao(obsoleto, LOJA_A, 999);
      ok("C11 deslocamento/versao obsoletos NAO sobrescrevem o mais novo",
        r.estado === "perdida"
        && (await linhaDoCursor(AGENTE_A))?.proximo_deslocamento === 0, r.estado);
    }

    {
      // O ABA: o par (loja, deslocamento) voltou a ser o mesmo, mas a
      // versao nao voltou. Sem `versao`, esta escrita passaria.
      const aba: Continuacao = { ...cursor, versao: 1 };
      const r = await avancarContinuacao(aba, LOJA_A, 50);
      ok("C11b ABA: mesmo par (loja, deslocamento), versao velha -> PERDE",
        r.estado === "perdida", r.estado);
    }

    // =================================================================
    secao("D. Corrida real entre dois escritores");
    // =================================================================

    {
      const atual = await lerContinuacao({ userId: DONO_A, agenteId: AGENTE_A });
      if (atual.estado !== "encontrada") throw new Error("cursor sumiu");
      const base = atual.continuacao;

      const [a, b] = await Promise.all([
        avancarContinuacao(base, LOJA_A, 50),
        avancarContinuacao(base, LOJA_A, 50),
      ]);
      const vencedores = [a, b].filter((r) => r.estado === "aplicada").length;
      ok("C9  duas trocas concorrentes: exatamente UMA vence",
        vencedores === 1, `${a.estado}+${b.estado}`);
      ok("C10 a perdedora rele e encontra o estado do vencedor",
        (await linhaDoCursor(AGENTE_A))?.proximo_deslocamento === 50
        && (await linhaDoCursor(AGENTE_A))?.versao === base.versao + 1);
    }

    // =================================================================
    secao("E. Tenancy e privilegios");
    // =================================================================

    {
      const r = await lerContinuacao({ userId: DONO_B, agenteId: AGENTE_A });
      ok("C16 o dono B nao enxerga o cursor do agente de A",
        r.estado === "ausente", r.estado);
    }
    {
      const atual = await lerContinuacao({ userId: DONO_A, agenteId: AGENTE_A });
      if (atual.estado !== "encontrada") throw new Error("cursor sumiu");
      const forjado: Continuacao = { ...atual.continuacao, userId: DONO_B };
      const r = await avancarContinuacao(forjado, LOJA_A, 999);
      ok("C16b escrita com dono trocado nao alcanca a linha",
        r.estado === "perdida", r.estado);
    }
    {
      const estado = await sqlstate(
        `insert into public.agente_perguntas_continuacao
           (agente_id, user_id, plataforma, recurso, loja_id, proximo_deslocamento)
         values ($1::uuid, $2, 'mercado_livre', 'perguntas', $3::uuid, 0)`,
        [AGENTE_B, DONO_B, LOJA_A]);
      ok("C17 cursor do dono B apontando para loja de A e recusado pela FK",
        estado === "23503", String(estado));
    }
    {
      const estado = await sqlstate(
        `insert into public.agente_perguntas_continuacao
           (agente_id, user_id, plataforma, recurso, loja_id, proximo_deslocamento)
         values ($1::uuid, $2, 'mercado_livre', 'perguntas', null, 150)`,
        [AGENTE_B, DONO_B]);
      ok("C17b deslocamento adiantado SEM conta e recusado pelo CHECK",
        estado === "23514", String(estado));
    }
    {
      const priv = (await pg.query<{ p: boolean }>(
        `select has_table_privilege($1, 'public.agente_perguntas_continuacao', $2) as p`,
        ["anon", "SELECT"])).rows[0].p;
      const privW = (await pg.query<{ p: boolean }>(
        `select has_table_privilege($1, 'public.agente_perguntas_continuacao', $2) as p`,
        ["authenticated", "INSERT"])).rows[0].p;
      ok("C18 anon nao le e authenticated nao escreve", priv === false && privW === false);
    }
    {
      const perm = async (p: string) => (await pg.query<{ p: boolean }>(
        `select has_table_privilege('service_role', 'public.agente_perguntas_continuacao', $1) as p`,
        [p])).rows[0].p;
      ok("C19 service_role tem SELECT, INSERT e UPDATE",
        (await perm("SELECT")) && (await perm("INSERT")) && (await perm("UPDATE")));
      ok("C20 e NAO tem DELETE nem TRUNCATE — o reinicio e UPDATE",
        !(await perm("DELETE")) && !(await perm("TRUNCATE")));
    }

    // =================================================================
    secao("F. A PROGRESSAO — sem o chamador escolher deslocamento");
    // =================================================================

    await limpar();

    {
      const espiao = { deslocamentos: [] as number[] };
      // O provider tem 200 perguntas: 0..149 cheias, 150 e o fim.
      const janela = (d: number) =>
        d < 150 ? cheia("P", d) : { linhas: [pergunta({ id: "P-fim" })], truncado: false };

      // Cada operacao e uma chamada NOVA do servico. Nenhuma delas recebe
      // deslocamento: a unica coisa que muda entre elas e o cursor.
      const op1 = await sincronizarPerguntas(
        { agenteId: AGENTE_A, idempotencyKey: chaveNova() },
        portas(janela, LOJA_A, DONO_A, AGENTE_A, espiao));
      const apos1 = await linhaDoCursor(AGENTE_A);

      const op2 = await sincronizarPerguntas(
        { agenteId: AGENTE_A, idempotencyKey: chaveNova() },
        portas(janela, LOJA_A, DONO_A, AGENTE_A, espiao));
      const apos2 = await linhaDoCursor(AGENTE_A);

      const op3 = await sincronizarPerguntas(
        { agenteId: AGENTE_A, idempotencyKey: chaveNova() },
        portas(janela, LOJA_A, DONO_A, AGENTE_A, espiao));
      const apos3 = await linhaDoCursor(AGENTE_A);

      // Cada operacao consome ATE `MAX_PAGINAS` janelas. Com duas, a
      // progressao real e 0,50 -> 100,150 -> e o fim da lista chega na
      // SEGUNDA operacao. A primeira versao deste oraculo supunha uma
      // janela por operacao e reprovou o comportamento CERTO.
      ok("C21/C22 a operacao 1 consome 0 e 50, e o cursor vai a 100",
        espiao.deslocamentos.slice(0, 2).join(",") === "0,50"
        && apos1?.proximo_deslocamento === 100
        && op1.tipo === "backlog_truncado",
        `${espiao.deslocamentos.join(",")} | ${apos1?.proximo_deslocamento}`);
      ok("F2  a operacao 2 comeca em 100 — ninguem lhe disse isso",
        espiao.deslocamentos[2] === 100,
        `${espiao.deslocamentos.join(",")}`);
      ok("F2b e segue para 150 DENTRO da mesma operacao",
        espiao.deslocamentos[3] === 150, espiao.deslocamentos.join(","));
      ok("F3  ao alcancar o fim da lista, a operacao 2 fecha como sucesso",
        op2.tipo === "sincronizado", op2.tipo);
      ok("C23 travessia completa reinicia o cursor em ZERO, na MESMA conta",
        apos2?.proximo_deslocamento === 0 && apos2?.loja_id === LOJA_A,
        JSON.stringify(apos2));
      ok("F3b a operacao 3 recomeca do zero — e a travessia seguinte",
        espiao.deslocamentos[4] === 0 && op3.tipo === "backlog_truncado"
        && apos3?.proximo_deslocamento === 100,
        `${espiao.deslocamentos.join(",")} | ${apos3?.proximo_deslocamento}`);
      ok("F4  a lista INTEIRA, inclusive alem de 100, foi ingerida",
        (await contarInbox(LOJA_A)) === 151, String(await contarInbox(LOJA_A)));
      ok("F5  e reler o comeco na travessia nova NAO duplicou nada",
        (await contarInbox(LOJA_A)) === 151);
    }

    // =================================================================
    secao("G. Deriva de conta — o salto mudo que nao acontece");
    // =================================================================

    await limpar();

    {
      // Cursor adiantado em LOJA_A...
      await iniciarContinuacao({
        userId: DONO_A, agenteId: AGENTE_A, lojaId: LOJA_A, proximoDeslocamento: 100,
      });
      const espiao = { deslocamentos: [] as number[] };
      // ...e a execucao devolve LOJA_A2.
      const r = await sincronizarPerguntas(
        { agenteId: AGENTE_A, idempotencyKey: chaveNova() },
        portas(() => cheia("X", 0), LOJA_A2, DONO_A, AGENTE_A, espiao));
      const depois = await linhaDoCursor(AGENTE_A);

      ok("C12 a pagina buscada com o deslocamento velho NAO e persistida",
        (await contarInbox(LOJA_A2)) === 0 && (await contarInbox(LOJA_A)) === 0,
        `${await contarInbox(LOJA_A2)}/${await contarInbox(LOJA_A)}`);
      ok("C13 o cursor passa a apontar para a conta NOVA, no zero",
        depois?.loja_id === LOJA_A2 && depois?.proximo_deslocamento === 0,
        JSON.stringify(depois));
      ok("C13b o servico devolve `cursor_reiniciado`, nao um sucesso",
        r.tipo === "cursor_reiniciado", r.tipo);
      ok("C13c e so UMA ida ao provider aconteceu",
        espiao.deslocamentos.join(",") === "100", espiao.deslocamentos.join(","));
    }

    {
      // C15: a proxima operacao na conta nova comeca do zero e ingere.
      const espiao = { deslocamentos: [] as number[] };
      const r = await sincronizarPerguntas(
        { agenteId: AGENTE_A, idempotencyKey: chaveNova() },
        portas(() => ({ linhas: [pergunta({ id: "NOVA-1" })], truncado: false }),
          LOJA_A2, DONO_A, AGENTE_A, espiao));
      ok("C15 a operacao seguinte na conta nova comeca em 0 e ingere",
        espiao.deslocamentos.join(",") === "0" && r.tipo === "sincronizado"
        && (await contarInbox(LOJA_A2)) === 1);
    }

    {
      // C14: duas reapontadas concorrentes, um unico resultado.
      await limpar();
      await iniciarContinuacao({
        userId: DONO_A, agenteId: AGENTE_A, lojaId: LOJA_A, proximoDeslocamento: 50,
      });
      const lido = await lerContinuacao({ userId: DONO_A, agenteId: AGENTE_A });
      if (lido.estado !== "encontrada") throw new Error("cursor sumiu");
      const [a, b] = await Promise.all([
        reapontarContinuacao(lido.continuacao, LOJA_A2),
        reapontarContinuacao(lido.continuacao, LOJA_A2),
      ]);
      const depois = await linhaDoCursor(AGENTE_A);
      ok("C14 duas reapontadas concorrentes: uma vence, o estado e unico",
        [a, b].filter((r) => r.estado === "aplicada").length === 1
        && depois?.loja_id === LOJA_A2 && depois?.proximo_deslocamento === 0,
        `${a.estado}+${b.estado}`);
    }

    // =================================================================
    secao("H. Falha nao move o cursor");
    // =================================================================

    await limpar();
    await iniciarContinuacao({
      userId: DONO_A, agenteId: AGENTE_A, lojaId: LOJA_A, proximoDeslocamento: 50,
    });

    for (const [rotulo, caso, resposta] of [
      ["C6  falha de provider", "C6", { tipo: "erro", requestId: "r", auditoria: "completa",
        envelope: { error: { code: "indisponivel" } } }],
      ["C6b negacao do guard", "C6b", { tipo: "negado", requestId: "r", codigo: "permissao_ausente" }],
      ["C6c aprovacao pendente", "C6c",
        { tipo: "aguardando_aprovacao", requestId: "r", aprovacaoId: "a1" }],
    ] as const) {
      void caso;
      const p: PortasSincronizacao = {
        ...portas(() => cheia("H", 0), LOJA_A, DONO_A, AGENTE_A),
        executar: async () => resposta,
      } as unknown as PortasSincronizacao;
      await sincronizarPerguntas({ agenteId: AGENTE_A, idempotencyKey: chaveNova() }, p);
      const depois = await linhaDoCursor(AGENTE_A);
      ok(`${rotulo}: o cursor fica onde estava`,
        depois?.proximo_deslocamento === 50 && depois?.versao === 1,
        JSON.stringify(depois));
    }

    {
      // C7: a inbox recusa o lote, SEM deriva de conta. So `gravar` e
      // injetado — cursor, auditoria e a conta continuam reais, e o que
      // se prova e que uma recusa de persistencia nao move o cursor.
      //
      // A primeira versao deste caso usava a loja de OUTRO dono para
      // provocar o 42501. Nao servia: a cerca de deriva age antes da
      // persistencia, entao o teste media outra coisa.
      const p: PortasSincronizacao = {
        ...portas(() => cheia("C7", 0), LOJA_A, DONO_A, AGENTE_A),
        gravar: async () => ({ tipo: "recusado", codigo: "22023" }),
      } as unknown as PortasSincronizacao;
      const r = await sincronizarPerguntas(
        { agenteId: AGENTE_A, idempotencyKey: chaveNova() }, p);
      const depois = await linhaDoCursor(AGENTE_A);
      ok("C7  recusa da persistencia nunca AVANCA o cursor",
        depois?.proximo_deslocamento === 50 && depois?.versao === 1
        && r.tipo === "persistencia_recusada",
        `${JSON.stringify(depois)} ${r.tipo}`);
    }

    {
      // A cerca de dono vale ATE no caminho de recuperacao: se a
      // execucao devolvesse loja de outro dono, o cursor NAO passaria a
      // aponta-la — a FK composta recusa, e o cursor fica onde estava.
      // Inalcancavel na pratica (`agente_conexoes` tem a mesma cerca),
      // mas e o tipo de coisa que se prova antes de precisar.
      const antes = await linhaDoCursor(AGENTE_A);
      const r = await sincronizarPerguntas(
        { agenteId: AGENTE_A, idempotencyKey: chaveNova() },
        portas(() => cheia("C7b", 0), LOJA_B, DONO_A, AGENTE_A));
      const depois = await linhaDoCursor(AGENTE_A);
      ok("C7b o cursor NUNCA passa a apontar loja de outro dono",
        depois?.loja_id === antes?.loja_id
        && depois?.proximo_deslocamento === antes?.proximo_deslocamento
        && r.tipo === "cursor_reiniciado",
        `${JSON.stringify(depois)} ${r.tipo}`);
      ok("C7c e nada foi gravado na loja alheia",
        (await contarInbox(LOJA_B)) === 0);
    }

    {
      // C8: inbox grava e a troca do cursor PERDE. O dado fica.
      await limpar();
      const perdedor: PortasSincronizacao = {
        ...portas(() => ({ linhas: [pergunta({ id: "C8-1" })], truncado: false }),
          LOJA_A, DONO_A, AGENTE_A),
        iniciarCursor: async () => ({ estado: "perdida" }),
      } as unknown as PortasSincronizacao;
      const r = await sincronizarPerguntas(
        { agenteId: AGENTE_A, idempotencyKey: chaveNova() }, perdedor);
      ok("C8  inbox gravada + cursor perdido: o dado NAO e desfeito",
        r.tipo === "sincronizado" && (await contarInbox(LOJA_A)) === 1);
      ok("C8b e o resumo admite que o cursor nao avancou",
        r.tipo === "sincronizado" && r.metricas.cursor_atualizado === false);
    }

    {
      // C24: a queda entre inbox e cursor. O pedaco e relido, e a chave
      // natural da inbox absorve — nenhuma linha duplicada.
      await limpar();
      const inbox = () => ({ linhas: [pergunta({ id: "C24-1" })], truncado: false });
      const semCursor: PortasSincronizacao = {
        ...portas(inbox, LOJA_A, DONO_A, AGENTE_A),
        iniciarCursor: async () => ({ estado: "falhou" }),
      } as unknown as PortasSincronizacao;
      await sincronizarPerguntas({ agenteId: AGENTE_A, idempotencyKey: chaveNova() }, semCursor);
      const aposQueda = await linhaDoCursor(AGENTE_A);
      ok("C24 queda entre inbox e cursor deixa o cursor para tras",
        aposQueda === null && (await contarInbox(LOJA_A)) === 1);

      const r = await sincronizarPerguntas(
        { agenteId: AGENTE_A, idempotencyKey: chaveNova() },
        portas(inbox, LOJA_A, DONO_A, AGENTE_A));
      ok("C24b a releitura do mesmo pedaco NAO duplica linha na inbox",
        (await contarInbox(LOJA_A)) === 1
        && r.tipo === "sincronizado" && r.persistencia.reobservadas === 1,
        String(await contarInbox(LOJA_A)));
    }

    {
      // C25: o desfecho da acao falha DEPOIS de o cursor avancar. O
      // cursor NAO volta atras — auditoria furada nao desfaz controle.
      await limpar();
      const p: PortasSincronizacao = {
        ...portas((d) => d === 0 ? cheia("C25", 0) : { linhas: [], truncado: false },
          LOJA_A, DONO_A, AGENTE_A),
        fecharAcao: async () => ({ estado: "falhou" }),
      } as unknown as PortasSincronizacao;
      const r = await sincronizarPerguntas(
        { agenteId: AGENTE_A, idempotencyKey: chaveNova() }, p);
      const depois = await linhaDoCursor(AGENTE_A);
      ok("C25 desfecho perdido depois do cursor: o cursor PERMANECE",
        depois !== null && r.tipo === "sincronizado" && r.auditoria === "incompleta",
        `${JSON.stringify(depois)} ${r.tipo}`);
    }
  } finally {
    await limpar();
    for (const loja of [LOJA_A, LOJA_A2, LOJA_B]) {
      await pg.query("delete from public.lojas where id = $1::uuid", [loja]);
    }
    for (const agente of [AGENTE_A, AGENTE_B]) {
      await pg.query("delete from public.agentes where id = $1::uuid", [agente]);
    }
    await pg.end();
  }

  console.log(`\n── placar ${"─".repeat(54)}`);
  console.log(`  PASS ${passou}   FAIL ${falhou}\n`);
  if (falhou > 0) process.exitCode = 1;
}

main().catch((e: unknown) => {
  const erro = e as { code?: string; message?: string };
  console.log(`\nERRO: ${erro.code ?? ""} ${erro.message ?? String(e)}`);
  process.exit(2);
});
