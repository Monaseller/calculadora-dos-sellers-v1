/**
 * Ingestão de perguntas — prova contra a RPC REAL. I2.
 *
 * ── Por que esta suite existe, alem da pura ─────────────────────────
 *
 * A suite pura prova a fronteira de dominio com a persistencia
 * injetada. Isso nao prova que a linha chega ao banco: um duplo confirma
 * o que ELE mesmo definiu. Aqui o caminho e inteiro —
 *
 *   sincronizarPerguntas → gravarPerguntasNaInbox → RPC de verdade → linha
 *
 * — e so o provider continua falso, porque o gate proibe marketplace.
 *
 * ── Onde roda ───────────────────────────────────────────────────────
 *
 * SOMENTE contra um Supabase local descartavel. O cliente real le
 * `NEXT_PUBLIC_SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY`, entao esta
 * suite exige que a URL seja local e que `--confirmo` esteja presente.
 * Ela ESCREVE e COMMITA fixtures: sem essas cercas poderia gravar em
 * producao.
 *
 * Rodar:
 *   NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:54321" \
 *   SUPABASE_SERVICE_ROLE_KEY="<local>" \
 *     npx tsx scripts/testar-agentes-ingestao-perguntas-banco.ts --confirmo
 */
import "./_server-only-inerte";

import { Client } from "pg";

import type { PerguntaRecebida } from "@/lib/agentes/dados/perguntas";
import { gravarPerguntasNaInbox } from "@/lib/agentes/dados/perguntas-inbox";
import {
  sincronizarPerguntas,
  type PortasSincronizacao,
} from "@/lib/agentes/ingestao/sincronizar-perguntas";

// ── Cercas ────────────────────────────────────────────────────────────

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

// ── Fixtures sinteticos ───────────────────────────────────────────────

const DONO_A = "aaaaaaaa-0000-4000-8000-0000000012a1";
const DONO_B = "bbbbbbbb-0000-4000-8000-0000000012b1";
const LOJA_A = "cccccccc-0000-4000-8000-0000000012a2";
const LOJA_B = "dddddddd-0000-4000-8000-0000000012b2";
const AGENTE_A = "11111111-1111-4111-8111-0000000012a3";

let passou = 0;
let falhou = 0;
const ok = (nome: string, cond: boolean, det = ""): void => {
  if (cond) { passou += 1; console.log(`  PASS  ${nome}`); }
  else { falhou += 1; console.log(`  FAIL  ${nome}${det ? `  — ${det}` : ""}`); }
};
const secao = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(2, 58 - t.length))}`);

const pergunta = (o: Partial<PerguntaRecebida> = {}): PerguntaRecebida => ({
  id: "Q1", anuncioId: "MLB1", texto: "Acompanha manual?",
  status: "UNANSWERED", criadaEm: "2026-09-20T10:00:00.000-04:00", ...o,
});

/**
 * Portas: agente e provider falsos, persistencia REAL.
 *
 * `gravar` NAO e injetada com duplo — e a funcao de producao. E esse o
 * ponto da suite.
 */
function portas(
  paginas: Array<{ linhas: PerguntaRecebida[]; truncado: boolean }>,
  lojaId: string,
  userId: string
): PortasSincronizacao {
  let i = 0;
  return {
    lerAgente: async () => ({ agente: { agenteId: AGENTE_A, userId, ativo: true }, erro: null }),
    executar: async () => {
      const pag = paginas[i] ?? paginas[paginas.length - 1];
      i += 1;
      return {
        tipo: "sucesso",
        requestId: "req-local",
        envelope: {
          contrato: 1, ok: true, request_id: "req-local",
          data: {
            linhas: pag.linhas, truncado: pag.truncado, erro: null,
            providerRecebidas: pag.linhas.length, descartadasNormalizacao: 0,
          },
        },
        auditoria: "completa",
        autoridade: { lojaId },
      };
    },
    gravar: gravarPerguntasNaInbox,
  } as unknown as PortasSincronizacao;
}

/** Uma pagina so, incompleta — o caso comum do I2. */
const umaPagina = (linhas: PerguntaRecebida[]) => [{ linhas, truncado: false }];

async function main(): Promise<void> {
  const { onde } = conferirAmbiente();
  console.log("\n══ CDS IA — ingestao de perguntas: RPC REAL (I2) ══");
  console.log(`  alvo = ${onde}   (chaves nunca impressas)`);

  const pg = new Client({ connectionString: process.env.QUESTION_INBOX_TEST_DATABASE_URL });
  await pg.connect();
  await pg.query("set statement_timeout = 20000");

  const contar = async (loja: string) =>
    Number((await pg.query(
      "select count(*)::int as n from public.agente_perguntas_ml where loja_id = $1::uuid", [loja]
    )).rows[0].n);
  const contarChave = async (loja: string, id: string) =>
    Number((await pg.query(
      "select count(*)::int as n from public.agente_perguntas_ml where loja_id = $1::uuid and id_externo = $2",
      [loja, id])).rows[0].n);
  const linhaDe = async (loja: string, id: string) =>
    (await pg.query(
      `select texto, provider_status, estado_interno, user_id
         from public.agente_perguntas_ml where loja_id = $1::uuid and id_externo = $2`,
      [loja, id])).rows[0] ?? null;

  try {
    // Fixtures: dois donos, duas lojas ML. Sem dado de producao.
    for (const [dono, loja, nome] of [
      [DONO_A, LOJA_A, "ML SINTETICA A"], [DONO_B, LOJA_B, "ML SINTETICA B"],
    ] as const) {
      await pg.query("delete from public.agente_perguntas_ml where loja_id = $1::uuid", [loja]);
      await pg.query("delete from public.lojas where id = $1::uuid", [loja]);
      await pg.query(
        `insert into public.lojas (id, nome, marketplace, user_id, ativo)
         values ($1::uuid, $2, 'ML', $3, true)`, [loja, nome, dono]);
    }

    secao("P. Persistencia real, uma pagina");

    {
      const r = await sincronizarPerguntas({ agenteId: AGENTE_A }, portas(umaPagina([pergunta()]), LOJA_A, DONO_A));
      const linha = await linhaDe(LOJA_A, "Q1");
      ok("P1  uma pergunta valida vira UMA linha, `novas=1`",
        r.tipo === "sincronizado" && r.persistencia.novas === 1
        && (await contar(LOJA_A)) === 1 && linha?.estado_interno === "nova");
      ok("P12 a linha gravada tem o `user_id` autoritativo", linha?.user_id === DONO_A);
    }
    {
      const r = await sincronizarPerguntas({ agenteId: AGENTE_A }, portas(umaPagina([pergunta()]), LOJA_A, DONO_A));
      ok("P2  replay identico: 1 linha final, `reobservadas=1`",
        r.tipo === "sincronizado" && r.persistencia.novas === 0
        && r.persistencia.reobservadas === 1 && (await contar(LOJA_A)) === 1);
    }
    {
      const r = await sincronizarPerguntas(
        { agenteId: AGENTE_A }, portas(umaPagina([pergunta({ texto: "Texto novo." })]), LOJA_A, DONO_A));
      ok("P3  mudanca material: `atualizadas=1` e o texto novo prevalece",
        r.tipo === "sincronizado" && r.persistencia.atualizadas === 1
        && (await linhaDe(LOJA_A, "Q1"))?.texto === "Texto novo.");
    }
    {
      const r = await sincronizarPerguntas({ agenteId: AGENTE_A }, portas(umaPagina([]), LOJA_A, DONO_A));
      ok("P4  pagina vazia: metricas zeradas e deterministicas, nada escrito",
        r.tipo === "sincronizado" && r.persistencia.recebidas === 0
        && r.persistencia.novas === 0 && (await contar(LOJA_A)) === 1);
    }
    {
      const antes = await contar(LOJA_A);
      const r = await sincronizarPerguntas(
        { agenteId: AGENTE_A }, portas(umaPagina([pergunta({ id: "Q-ANS", status: "ANSWERED" })]), LOJA_A, DONO_A));
      ok("P5  status inesperado nao e persistido",
        r.tipo === "sincronizado" && (await contar(LOJA_A)) === antes
        && (await linhaDe(LOJA_A, "Q-ANS")) === null);
    }
    {
      const antes = await contar(LOJA_A);
      const r = await sincronizarPerguntas(
        { agenteId: AGENTE_A }, portas(umaPagina([pergunta({ id: "Q-DT", criadaEm: "ontem" })]), LOJA_A, DONO_A));
      ok("P6  data invalida nao e persistida e nao derruba a varredura",
        r.tipo === "sincronizado" && (await contar(LOJA_A)) === antes
        && (await linhaDe(LOJA_A, "Q-DT")) === null);
    }

    secao("Q. Autoridade e isolamento entre donos");

    {
      // A loja B e do dono B. Gravar nela com o dono A tem de ser
      // recusado pela guarda de tenant da propria RPC.
      const antes = await contar(LOJA_B);
      const r = await sincronizarPerguntas(
        { agenteId: AGENTE_A }, portas(umaPagina([pergunta({ id: "Q-X" })]), LOJA_B, DONO_A));
      ok("P15 dono A nao consegue gravar na loja de B — recusa 42501",
        r.tipo === "persistencia_recusada" && r.codigo === "42501"
        && (await contar(LOJA_B)) === antes);
    }
    {
      const r = await sincronizarPerguntas(
        { agenteId: AGENTE_A }, portas(umaPagina([pergunta({ id: "Q-B1" })]), LOJA_B, DONO_B));
      ok("P13 a gravacao vai para a loja que a EXECUCAO devolveu",
        r.tipo === "sincronizado" && (await linhaDe(LOJA_B, "Q-B1")) !== null
        && (await linhaDe(LOJA_A, "Q-B1")) === null);
    }
    {
      // P14: o unico `lojaId` do servico vem de `resultado.autoridade`.
      // Trocar so a autoridade, com tudo mais igual, troca o destino —
      // e isso e a prova de que nao ha segunda resolucao entre buscar e
      // gravar. Sem segunda leitura, nao ha janela para divergir.
      const antesA = await contar(LOJA_A);
      const antesB = await contar(LOJA_B);
      await sincronizarPerguntas(
        { agenteId: AGENTE_A }, portas(umaPagina([pergunta({ id: "Q-TOC" })]), LOJA_B, DONO_B));
      ok("P14 trocar a autoridade da execucao troca o destino da gravacao",
        (await contar(LOJA_B)) === antesB + 1 && (await contar(LOJA_A)) === antesA);
    }

    secao("R. Falha da persistencia");

    {
      // Loja inexistente: a RPC recusa, e o servico NAO reporta sucesso.
      const fantasma = "eeeeeeee-0000-4000-8000-0000000012ff";
      const r = await sincronizarPerguntas(
        { agenteId: AGENTE_A }, portas(umaPagina([pergunta({ id: "Q-F" })]), fantasma, DONO_A));
      ok("P9  loja inexistente: recusa, sem sucesso falso e sem escrita parcial",
        r.tipo === "persistencia_recusada" && r.codigo === "42501");
    }
    {
      // Identidade imutavel divergente: a RPC derruba o LOTE.
      const r = await sincronizarPerguntas(
        { agenteId: AGENTE_A },
        portas(umaPagina([pergunta({ anuncioId: "OUTRO-ANUNCIO" })]), LOJA_A, DONO_A));
      ok("P9b identidade do provider divergente derruba o lote (22023)",
        r.tipo === "persistencia_recusada" && r.codigo === "22023"
        && (await linhaDe(LOJA_A, "Q1"))?.texto === "Texto novo.");
    }

    secao("S. Duplicata ENTRE paginas — quem decide e a RPC");

    {
      // G6: o MESMO id_externo, payload identico, nas duas paginas.
      const q = pergunta({ id: "Q-DUP" });
      const r = await sincronizarPerguntas({ agenteId: AGENTE_A }, portas([
        { linhas: [q], truncado: true }, { linhas: [q], truncado: false },
      ], LOJA_A, DONO_A));
      ok("G6  duplicata exata entre paginas vira UMA linha",
        r.tipo === "sincronizado"
        && (await contarChave(LOJA_A, "Q-DUP")) === 1
        && r.persistencia.recebidas === 2
        && r.persistencia.unicas === 1
        && r.persistencia.duplicadas_no_lote === 1);
    }
    {
      // G7: mesma chave natural, identidade IMUTAVEL divergente.
      const antes = await contar(LOJA_A);
      const r = await sincronizarPerguntas({ agenteId: AGENTE_A }, portas([
        { linhas: [pergunta({ id: "Q-DIV", anuncioId: "ITEM-A" })], truncado: true },
        { linhas: [pergunta({ id: "Q-DIV", anuncioId: "ITEM-B" })], truncado: false },
      ], LOJA_A, DONO_A));
      ok("G7  duplicata DIVERGENTE entre paginas derruba o lote, zero parcial",
        r.tipo === "persistencia_recusada" && r.codigo === "22023"
        && (await contar(LOJA_A)) === antes);
    }
  } finally {
    for (const loja of [LOJA_A, LOJA_B]) {
      await pg.query("delete from public.agente_perguntas_ml where loja_id = $1::uuid", [loja]);
      await pg.query("delete from public.lojas where id = $1::uuid", [loja]);
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
