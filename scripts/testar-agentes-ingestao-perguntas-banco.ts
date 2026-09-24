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

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Client } from "pg";

import {
  registrarAberturaAcao,
  registrarDesfechoAcao,
} from "@/lib/agentes/acoes/auditoria-acao";
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
const AGENTE_B = "22222222-2222-4222-8222-0000000012b3";
const ACAO = "sincronizar_perguntas";

/** Uma chave de tentativa por chamada. Duas chamadas com a mesma chave
 *  sao a MESMA tentativa — e a abertura da segunda perde no indice. */
let sequencia = 0;
const chaveNova = (): string => {
  sequencia += 1;
  return `n8n:banco-t${sequencia}:${ACAO}:ag`;
};

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
 * Portas: agente e provider falsos; persistencia e AUDITORIA reais.
 *
 * `gravar`, `abrirAcao` e `fecharAcao` NAO sao duplos — sao as funcoes
 * de producao, contra as tabelas locais de verdade. E esse o ponto da
 * suite: falsificar as DUAS camadas duraveis e chamar isso de aceitacao
 * provaria apenas que os duplos concordam entre si.
 *
 * `opcoes.auditoriaDaFuncao` controla a saude do ledger de FUNCAO que
 * cada pagina reporta — o campo que o servico passou a propagar no I3B.
 * `opcoes.paginasIncompletas` marca paginas especificas.
 */
function portas(
  paginas: Array<{ linhas: PerguntaRecebida[]; truncado: boolean }>,
  lojaId: string,
  userId: string,
  opcoes: {
    agenteId?: string;
    paginasIncompletas?: readonly number[];
    espiao?: { paginas: number; chaves: string[] };
  } = {}
): PortasSincronizacao {
  let i = 0;
  const incompletas = new Set(opcoes.paginasIncompletas ?? []);
  return {
    lerAgente: async () => ({
      agente: { agenteId: opcoes.agenteId ?? AGENTE_A, userId, ativo: true },
      erro: null,
    }),
    executar: async (entrada: { idempotencyKey?: string }) => {
      const indice = i;
      const pag = paginas[indice] ?? paginas[paginas.length - 1];
      i += 1;
      if (opcoes.espiao) {
        opcoes.espiao.paginas += 1;
        opcoes.espiao.chaves.push(entrada.idempotencyKey ?? "");
      }
      return {
        tipo: "sucesso",
        requestId: `req-local-${indice}`,
        envelope: {
          contrato: 1, ok: true, request_id: `req-local-${indice}`,
          data: {
            linhas: pag.linhas, truncado: pag.truncado, erro: null,
            providerRecebidas: pag.linhas.length, descartadasNormalizacao: 0,
          },
        },
        auditoria: incompletas.has(indice) ? "incompleta" : "completa",
        autoridade: { lojaId },
      };
    },
    gravar: gravarPerguntasNaInbox,
    abrirAcao: registrarAberturaAcao,
    fecharAcao: registrarDesfechoAcao,
  } as unknown as PortasSincronizacao;
}

/** Portas cujo executor devolve um desfecho NAO-sucesso na pagina 1. */
function portasComFalha(
  resposta: unknown,
  userId: string,
  opcoes: { agenteId?: string; espiao?: { paginas: number; chaves: string[] } } = {}
): PortasSincronizacao {
  return {
    lerAgente: async () => ({
      agente: { agenteId: opcoes.agenteId ?? AGENTE_A, userId, ativo: true },
      erro: null,
    }),
    executar: async (entrada: { idempotencyKey?: string }) => {
      if (opcoes.espiao) {
        opcoes.espiao.paginas += 1;
        opcoes.espiao.chaves.push(entrada.idempotencyKey ?? "");
      }
      return resposta;
    },
    gravar: gravarPerguntasNaInbox,
    abrirAcao: registrarAberturaAcao,
    fecharAcao: registrarDesfechoAcao,
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
    await pg.query(
      "delete from public.agente_acao_execucoes where user_id in ($1,$2)", [DONO_A, DONO_B]);
    for (const [dono, loja, agente, nome] of [
      [DONO_A, LOJA_A, AGENTE_A, "ML SINTETICA A"],
      [DONO_B, LOJA_B, AGENTE_B, "ML SINTETICA B"],
    ] as const) {
      await pg.query("delete from public.agente_perguntas_ml where loja_id = $1::uuid", [loja]);
      await pg.query("delete from public.lojas where id = $1::uuid", [loja]);
      await pg.query("delete from public.agentes where id = $1::uuid", [agente]);
      // O agente e REAL: a abertura da acao tem FK composta
      // `(agente_id, user_id)`, e sem a linha aqui nada abriria.
      await pg.query(
        `insert into public.agentes (id, user_id, nome, tipo, ativo)
         values ($1::uuid, $2, 'AGENTE SINTETICO', 'mensagens', true)`, [agente, dono]);
      await pg.query(
        `insert into public.lojas (id, nome, marketplace, user_id, ativo)
         values ($1::uuid, $2, 'ML', $3, true)`, [loja, nome, dono]);
    }

    secao("P. Persistencia real, uma pagina");

    {
      const r = await sincronizarPerguntas({ agenteId: AGENTE_A, idempotencyKey: chaveNova() }, portas(umaPagina([pergunta()]), LOJA_A, DONO_A));
      const linha = await linhaDe(LOJA_A, "Q1");
      ok("P1  uma pergunta valida vira UMA linha, `novas=1`",
        r.tipo === "sincronizado" && r.persistencia.novas === 1
        && (await contar(LOJA_A)) === 1 && linha?.estado_interno === "nova");
      ok("P12 a linha gravada tem o `user_id` autoritativo", linha?.user_id === DONO_A);
    }
    {
      const r = await sincronizarPerguntas({ agenteId: AGENTE_A, idempotencyKey: chaveNova() }, portas(umaPagina([pergunta()]), LOJA_A, DONO_A));
      ok("P2  replay identico: 1 linha final, `reobservadas=1`",
        r.tipo === "sincronizado" && r.persistencia.novas === 0
        && r.persistencia.reobservadas === 1 && (await contar(LOJA_A)) === 1);
    }
    {
      const r = await sincronizarPerguntas(
        { agenteId: AGENTE_A, idempotencyKey: chaveNova() }, portas(umaPagina([pergunta({ texto: "Texto novo." })]), LOJA_A, DONO_A));
      ok("P3  mudanca material: `atualizadas=1` e o texto novo prevalece",
        r.tipo === "sincronizado" && r.persistencia.atualizadas === 1
        && (await linhaDe(LOJA_A, "Q1"))?.texto === "Texto novo.");
    }
    {
      const r = await sincronizarPerguntas({ agenteId: AGENTE_A, idempotencyKey: chaveNova() }, portas(umaPagina([]), LOJA_A, DONO_A));
      ok("P4  pagina vazia: metricas zeradas e deterministicas, nada escrito",
        r.tipo === "sincronizado" && r.persistencia.recebidas === 0
        && r.persistencia.novas === 0 && (await contar(LOJA_A)) === 1);
    }
    {
      const antes = await contar(LOJA_A);
      const r = await sincronizarPerguntas(
        { agenteId: AGENTE_A, idempotencyKey: chaveNova() }, portas(umaPagina([pergunta({ id: "Q-ANS", status: "ANSWERED" })]), LOJA_A, DONO_A));
      ok("P5  status inesperado nao e persistido",
        r.tipo === "sincronizado" && (await contar(LOJA_A)) === antes
        && (await linhaDe(LOJA_A, "Q-ANS")) === null);
    }
    {
      const antes = await contar(LOJA_A);
      const r = await sincronizarPerguntas(
        { agenteId: AGENTE_A, idempotencyKey: chaveNova() }, portas(umaPagina([pergunta({ id: "Q-DT", criadaEm: "ontem" })]), LOJA_A, DONO_A));
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
        { agenteId: AGENTE_A, idempotencyKey: chaveNova() }, portas(umaPagina([pergunta({ id: "Q-X" })]), LOJA_B, DONO_A));
      ok("P15 dono A nao consegue gravar na loja de B — recusa 42501",
        r.tipo === "persistencia_recusada" && r.codigo === "42501"
        && (await contar(LOJA_B)) === antes);
    }
    {
      const r = await sincronizarPerguntas(
        { agenteId: AGENTE_A, idempotencyKey: chaveNova() }, portas(umaPagina([pergunta({ id: "Q-B1" })]), LOJA_B, DONO_B, { agenteId: AGENTE_B }));
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
        { agenteId: AGENTE_A, idempotencyKey: chaveNova() }, portas(umaPagina([pergunta({ id: "Q-TOC" })]), LOJA_B, DONO_B, { agenteId: AGENTE_B }));
      ok("P14 trocar a autoridade da execucao troca o destino da gravacao",
        (await contar(LOJA_B)) === antesB + 1 && (await contar(LOJA_A)) === antesA);
    }

    secao("R. Falha da persistencia");

    {
      // Loja inexistente: a RPC recusa, e o servico NAO reporta sucesso.
      const fantasma = "eeeeeeee-0000-4000-8000-0000000012ff";
      const r = await sincronizarPerguntas(
        { agenteId: AGENTE_A, idempotencyKey: chaveNova() }, portas(umaPagina([pergunta({ id: "Q-F" })]), fantasma, DONO_A));
      ok("P9  loja inexistente: recusa, sem sucesso falso e sem escrita parcial",
        r.tipo === "persistencia_recusada" && r.codigo === "42501");
    }
    {
      // Identidade imutavel divergente: a RPC derruba o LOTE.
      const r = await sincronizarPerguntas(
        { agenteId: AGENTE_A, idempotencyKey: chaveNova() },
        portas(umaPagina([pergunta({ anuncioId: "OUTRO-ANUNCIO" })]), LOJA_A, DONO_A));
      ok("P9b identidade do provider divergente derruba o lote (22023)",
        r.tipo === "persistencia_recusada" && r.codigo === "22023"
        && (await linhaDe(LOJA_A, "Q1"))?.texto === "Texto novo.");
    }

    secao("S. Duplicata ENTRE paginas — quem decide e a RPC");

    {
      // G6: o MESMO id_externo, payload identico, nas duas paginas.
      const q = pergunta({ id: "Q-DUP" });
      const r = await sincronizarPerguntas({ agenteId: AGENTE_A, idempotencyKey: chaveNova() }, portas([
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
      const r = await sincronizarPerguntas({ agenteId: AGENTE_A, idempotencyKey: chaveNova() }, portas([
        { linhas: [pergunta({ id: "Q-DIV", anuncioId: "ITEM-A" })], truncado: true },
        { linhas: [pergunta({ id: "Q-DIV", anuncioId: "ITEM-B" })], truncado: false },
      ], LOJA_A, DONO_A));
      ok("G7  duplicata DIVERGENTE entre paginas derruba o lote, zero parcial",
        r.tipo === "persistencia_recusada" && r.codigo === "22023"
        && (await contar(LOJA_A)) === antes);
    }

    // =================================================================
    // A. O CICLO DE VIDA DA ACAO, contra a tabela REAL
    // =================================================================
    secao("A. Ciclo de vida da acao — tabelas reais, provider falso");

    /** As linhas de auditoria de UMA execucao de acao. */
    const linhasDaAcao = async (requestId: string) =>
      (await pg.query(
        `select fase, status, codigo_desfecho, loja_id::text as loja_id, idempotency_key,
                entrada_resumo, latencia_ms, user_id, agente_id, acao_id, mensagem_desfecho
           from public.agente_acao_execucoes
          where request_id = $1 order by fase desc`, [requestId])).rows as Array<Record<string, unknown>>;
    const porChave = async (chave: string) =>
      Number((await pg.query(
        "select count(*)::int as n from public.agente_acao_execucoes where idempotency_key = $1",
        [chave])).rows[0].n);
    const totalAcoes = async (dono: string) =>
      Number((await pg.query(
        "select count(*)::int as n from public.agente_acao_execucoes where user_id = $1",
        [dono])).rows[0].n);

    {
      const chave = chaveNova();
      const espiao = { paginas: 0, chaves: [] as string[] };
      const r = await sincronizarPerguntas(
        { agenteId: AGENTE_A, idempotencyKey: chave },
        portas(umaPagina([pergunta({ id: "A1" })]), LOJA_A, DONO_A, { espiao }));
      const linhas = r.tipo === "sincronizado" ? await linhasDaAcao(r.requestId) : [];
      const abertura = linhas.find((l) => l.fase === "abertura") ?? {};
      ok("A1  a primeira tentativa ABRE a acao",
        linhas.length === 2 && abertura.status === "executando"
        && abertura.loja_id === null && abertura.idempotency_key === chave
        && abertura.acao_id === ACAO && abertura.user_id === DONO_A
        && abertura.agente_id === AGENTE_A,
        JSON.stringify(abertura));
      ok("A16 a chave da pagina e a chave da acao com sufixo",
        espiao.chaves.length === 1 && espiao.chaves[0] === `${chave}:p0`,
        espiao.chaves.join(","));
    }

    {
      // Mesma tentativa de novo: o INDICE decide, e nada alem dele.
      const chave = chaveNova();
      const e1 = { paginas: 0, chaves: [] as string[] };
      await sincronizarPerguntas({ agenteId: AGENTE_A, idempotencyKey: chave },
        portas(umaPagina([pergunta({ id: "A2" })]), LOJA_A, DONO_A, { espiao: e1 }));
      const antes = await totalAcoes(DONO_A);
      const inboxAntes = await contar(LOJA_A);

      const e2 = { paginas: 0, chaves: [] as string[] };
      const r = await sincronizarPerguntas({ agenteId: AGENTE_A, idempotencyKey: chave },
        portas(umaPagina([pergunta({ id: "A2b" })]), LOJA_A, DONO_A, { espiao: e2 }));
      ok("A2  replay da MESMA tentativa para antes do provider e da RPC",
        r.tipo === "ja_processado" && e2.paginas === 0
        && (await totalAcoes(DONO_A)) === antes
        && (await contar(LOJA_A)) === inboxAntes);
      ok("A2b nenhuma linha nova foi criada para a tentativa repetida",
        (await porChave(chave)) === 1);
    }

    {
      const e = { paginas: 0, chaves: [] as string[] };
      const r = await sincronizarPerguntas(
        { agenteId: AGENTE_A, idempotencyKey: chaveNova() },
        portas(umaPagina([pergunta({ id: "A3" })]), LOJA_A, DONO_A, { espiao: e }));
      ok("A3  tentativa DIFERENTE, mesmo agente e mesma acao, e permitida",
        r.tipo === "sincronizado" && e.paginas === 1);
    }

    {
      // FAIL_CLOSED_BEFORE_PROVIDER. O agente devolvido pelo duplo NAO
      // existe na tabela, entao a FK composta recusa a abertura — falha
      // tecnica de verdade, nao um duplo dizendo "falhei".
      const fantasma = "99999999-9999-4999-8999-0000000012ff";
      const e = { paginas: 0, chaves: [] as string[] };
      const inboxAntes = await contar(LOJA_A);
      const r = await sincronizarPerguntas(
        { agenteId: fantasma, idempotencyKey: chaveNova() },
        portas(umaPagina([pergunta({ id: "A4" })]), LOJA_A, DONO_A,
          { agenteId: fantasma, espiao: e }));
      ok("A4  abertura que nao grava impede provider E inbox",
        r.tipo === "abertura_falhou" && e.paginas === 0
        && (await contar(LOJA_A)) === inboxAntes);
      ok("A4b e nenhuma linha de acao ficou para tras",
        r.tipo === "abertura_falhou" && (await linhasDaAcao(r.requestId)).length === 0);
    }

    {
      const e = { paginas: 0, chaves: [] as string[] };
      const inboxAntes = await contar(LOJA_A);
      const r = await sincronizarPerguntas(
        { agenteId: AGENTE_A, idempotencyKey: chaveNova() },
        portasComFalha(
          { tipo: "negado", requestId: "r", codigo: "permissao_bloqueada" }, DONO_A, { espiao: e }));
      const linhas = r.tipo === "negado" ? await linhasDaAcao(r.requestId) : [];
      const desfecho = linhas.find((l) => l.fase === "desfecho") ?? {};
      ok("A5  falha na pagina 1 produz UM desfecho, e so um",
        linhas.length === 2 && desfecho.status === "negado"
        && desfecho.codigo_desfecho === "permissao_bloqueada"
        && (await contar(LOJA_A)) === inboxAntes,
        JSON.stringify(desfecho));
      ok("A5b o desfecho de uma acao que nao gravou nao reivindica conta",
        desfecho.loja_id === null);
    }

    {
      // Pagina 1 ok e cheia, pagina 2 falha: a varredura para, e o
      // desfecho fala da falha — nao do que a pagina 1 trouxe.
      let i = 0;
      const e = { paginas: 0, chaves: [] as string[] };
      const inboxAntes = await contar(LOJA_A);
      const p: PortasSincronizacao = {
        lerAgente: async () => ({
          agente: { agenteId: AGENTE_A, userId: DONO_A, ativo: true }, erro: null }),
        executar: async (entrada: { idempotencyKey?: string }) => {
          e.paginas += 1;
          e.chaves.push(entrada.idempotencyKey ?? "");
          if (i++ === 0) {
            return {
              tipo: "sucesso", requestId: "p0", auditoria: "completa",
              autoridade: { lojaId: LOJA_A },
              envelope: { data: {
                linhas: Array.from({ length: 50 }, (_, k) => pergunta({ id: `A6-${k}` })),
                truncado: true, erro: null, providerRecebidas: 50, descartadasNormalizacao: 0 } },
            };
          }
          return { tipo: "erro", requestId: "p1",
            envelope: { error: { code: "limite_excedido" } }, auditoria: "completa" };
        },
        gravar: gravarPerguntasNaInbox,
        abrirAcao: registrarAberturaAcao,
        fecharAcao: registrarDesfechoAcao,
      } as unknown as PortasSincronizacao;

      const r = await sincronizarPerguntas(
        { agenteId: AGENTE_A, idempotencyKey: chaveNova() }, p);
      const linhas = r.tipo === "erro" ? await linhasDaAcao(r.requestId) : [];
      const desfecho = linhas.find((l) => l.fase === "desfecho") ?? {};
      ok("A6  falha na pagina 2 tambem produz UM unico desfecho",
        e.paginas === 2 && linhas.length === 2
        && desfecho.status === "erro" && desfecho.codigo_desfecho === "provedor_falhou"
        && (await contar(LOJA_A)) === inboxAntes,
        JSON.stringify(desfecho));
      const resumo = (desfecho.entrada_resumo ?? {}) as Record<string, unknown>;
      ok("A6b o resumo guarda o que a pagina 1 ja tinha trazido",
        resumo.paginas === 1 && resumo.provider_recebidas === 50,
        JSON.stringify(resumo));
    }

    {
      // Divergencia de autoridade entre paginas: ZERO inbox, um desfecho.
      let i = 0;
      const inboxAntesA = await contar(LOJA_A);
      const inboxAntesB = await contar(LOJA_B);
      const p: PortasSincronizacao = {
        lerAgente: async () => ({
          agente: { agenteId: AGENTE_A, userId: DONO_A, ativo: true }, erro: null }),
        executar: async () => {
          const loja = i++ === 0 ? LOJA_A : LOJA_B;
          return {
            tipo: "sucesso", requestId: `d${i}`, auditoria: "completa",
            autoridade: { lojaId: loja },
            envelope: { data: {
              linhas: Array.from({ length: 50 }, (_, k) => pergunta({ id: `A7-${i}-${k}` })),
              truncado: true, erro: null, providerRecebidas: 50, descartadasNormalizacao: 0 } },
          };
        },
        gravar: gravarPerguntasNaInbox,
        abrirAcao: registrarAberturaAcao,
        fecharAcao: registrarDesfechoAcao,
      } as unknown as PortasSincronizacao;

      const r = await sincronizarPerguntas(
        { agenteId: AGENTE_A, idempotencyKey: chaveNova() }, p);
      const linhas = r.tipo === "autoridade_divergente" ? await linhasDaAcao(r.requestId) : [];
      const desfecho = linhas.find((l) => l.fase === "desfecho") ?? {};
      ok("A7  divergencia de autoridade: um desfecho e ZERO escrita",
        desfecho.status === "erro" && desfecho.codigo_desfecho === "autoridade_divergente"
        && (await contar(LOJA_A)) === inboxAntesA
        && (await contar(LOJA_B)) === inboxAntesB,
        JSON.stringify(desfecho));
      ok("A7b e o desfecho NAO reivindica nenhuma das duas contas",
        desfecho.loja_id === null);
    }

    {
      // Loja de outro dono: a RPC recusa com 42501, e o desfecho precisa
      // gravar mesmo assim — e por isso `loja_id` vai NULL.
      const r = await sincronizarPerguntas(
        { agenteId: AGENTE_A, idempotencyKey: chaveNova() },
        portas(umaPagina([pergunta({ id: "A8" })]), LOJA_B, DONO_A));
      const linhas = r.tipo === "persistencia_recusada" ? await linhasDaAcao(r.requestId) : [];
      const desfecho = linhas.find((l) => l.fase === "desfecho") ?? {};
      ok("A8  recusa da persistencia produz desfecho classificado",
        linhas.length === 2 && desfecho.status === "erro"
        && desfecho.codigo_desfecho === "persistencia_negada",
        JSON.stringify(desfecho));
      ok("A8b o desfecho GRAVOU — a FK de tenancy nao o impediu",
        desfecho.loja_id === null && r.tipo === "persistencia_recusada"
        && r.auditoria === "completa");
    }

    {
      const r = await sincronizarPerguntas(
        { agenteId: AGENTE_A, idempotencyKey: chaveNova() },
        portas(umaPagina([pergunta({ id: "A9" })]), LOJA_A, DONO_A));
      const linhas = r.tipo === "sincronizado" ? await linhasDaAcao(r.requestId) : [];
      const d = linhas.find((l) => l.fase === "desfecho") ?? {};
      ok("A9  varredura limpa fecha como SUCESSO, com a conta autoritativa",
        d.status === "sucesso" && d.codigo_desfecho === null
        && d.loja_id === LOJA_A && d.mensagem_desfecho === null,
        JSON.stringify(d));
      ok("A9b a latencia da acao foi medida, e nao inventada",
        typeof d.latencia_ms === "number" && (d.latencia_ms as number) >= 0);
    }

    {
      const r = await sincronizarPerguntas(
        { agenteId: AGENTE_A, idempotencyKey: chaveNova() },
        portas(umaPagina([
          pergunta({ id: "A10" }), pergunta({ id: "A10x", status: "ANSWERED" }),
        ]), LOJA_A, DONO_A));
      const linhas = r.tipo === "sincronizado" ? await linhasDaAcao(r.requestId) : [];
      const d = linhas.find((l) => l.fase === "desfecho") ?? {};
      ok("A10 descarte na varredura fecha como parcial",
        d.status === "parcial" && d.codigo_desfecho === "descartes_na_varredura",
        JSON.stringify(d));
    }

    {
      const cheia = (marca: string) =>
        Array.from({ length: 50 }, (_, k) => pergunta({ id: `${marca}-${k}` }));
      const r = await sincronizarPerguntas(
        { agenteId: AGENTE_A, idempotencyKey: chaveNova() },
        portas([
          { linhas: cheia("A11a"), truncado: true },
          { linhas: cheia("A11b"), truncado: true },
        ], LOJA_A, DONO_A));
      const linhas = r.tipo === "backlog_truncado" ? await linhasDaAcao(r.requestId) : [];
      const d = linhas.find((l) => l.fase === "desfecho") ?? {};
      const resumo = (d.entrada_resumo ?? {}) as Record<string, unknown>;
      ok("A11 teto de paginas com backlog fecha como parcial/backlog_truncado",
        d.status === "parcial" && d.codigo_desfecho === "backlog_truncado"
        && resumo.limite_atingido === true && resumo.truncado === true,
        JSON.stringify({ s: d.status, c: d.codigo_desfecho }));
    }

    {
      // A inbox grava, e o desfecho PERDE no indice unico porque outra
      // sessao ja fechou esta execucao. Conflito REAL: a porta escreve o
      // terminal concorrente antes de chamar a funcao de producao.
      const chave = chaveNova();
      let requestVisto = "";
      const p: PortasSincronizacao = {
        lerAgente: async () => ({
          agente: { agenteId: AGENTE_A, userId: DONO_A, ativo: true }, erro: null }),
        executar: async () => ({
          tipo: "sucesso", requestId: "x", auditoria: "completa",
          autoridade: { lojaId: LOJA_A },
          envelope: { data: {
            linhas: [pergunta({ id: "A12" })], truncado: false, erro: null,
            providerRecebidas: 1, descartadasNormalizacao: 0 } },
        }),
        gravar: gravarPerguntasNaInbox,
        abrirAcao: registrarAberturaAcao,
        fecharAcao: async (e: { requestId: string }) => {
          requestVisto = e.requestId;
          await pg.query(
            `insert into public.agente_acao_execucoes
               (user_id, agente_id, loja_id, acao_id, request_id, fase, status,
                codigo_desfecho, mensagem_desfecho, entrada_resumo)
             values ($1,$2::uuid,null,$3,$4,'desfecho','erro','erro_interno',
                     'outra sessao chegou primeiro','{}'::jsonb)`,
            [DONO_A, AGENTE_A, ACAO, e.requestId]);
          return registrarDesfechoAcao(e as never);
        },
      } as unknown as PortasSincronizacao;

      const r = await sincronizarPerguntas({ agenteId: AGENTE_A, idempotencyKey: chave }, p);
      ok("A12 inbox gravada + desfecho perdido: o dado NAO e desfeito",
        r.tipo === "sincronizado" && r.persistencia.novas === 1
        && (await linhaDe(LOJA_A, "A12")) !== null);
      ok("A12b e o resultado declara a auditoria INCOMPLETA",
        r.tipo === "sincronizado" && r.auditoria === "incompleta");
      ok("A12c o desfecho vencedor permanece, e e UM so",
        (await linhasDaAcao(requestVisto)).filter((l) => l.fase === "desfecho").length === 1);
    }

    {
      // ── A13: a orfa PRECISA ser fabricada ─────────────────────────
      //
      // Ate aqui nao havia nenhuma, e isso e resultado, nao acaso: a
      // fiacao fecha tudo que abre. Entao o caso e construido — o banco
      // cai no instante do desfecho — e o que se prova e que a orfa
      // resultante e encontravel pelo anti-join, que e o motivo de os
      // dois indices parciais existirem.
      const antes = Number((await pg.query(
        `select count(*)::int as n
           from public.agente_acao_execucoes a
          where a.fase = 'abertura' and a.user_id = $1
            and not exists (
              select 1 from public.agente_acao_execucoes d
               where d.fase = 'desfecho' and d.user_id = a.user_id
                 and d.request_id = a.request_id)`, [DONO_A])).rows[0].n);
      ok("A13 ate aqui a fiacao fechou TUDO que abriu", antes === 0, String(antes));

      const p: PortasSincronizacao = {
        lerAgente: async () => ({
          agente: { agenteId: AGENTE_A, userId: DONO_A, ativo: true }, erro: null }),
        executar: async () => ({
          tipo: "sucesso", requestId: "a13", auditoria: "completa",
          autoridade: { lojaId: LOJA_A },
          envelope: { data: {
            linhas: [pergunta({ id: "A13" })], truncado: false, erro: null,
            providerRecebidas: 1, descartadasNormalizacao: 0 } },
        }),
        gravar: gravarPerguntasNaInbox,
        // A abertura e REAL; so o desfecho e que nao acontece.
        abrirAcao: registrarAberturaAcao,
        fecharAcao: async () => ({ estado: "falhou" }),
      } as unknown as PortasSincronizacao;

      const r = await sincronizarPerguntas(
        { agenteId: AGENTE_A, idempotencyKey: chaveNova() }, p);

      const depois = Number((await pg.query(
        `select count(*)::int as n
           from public.agente_acao_execucoes a
          where a.fase = 'abertura' and a.user_id = $1
            and not exists (
              select 1 from public.agente_acao_execucoes d
               where d.fase = 'desfecho' and d.user_id = a.user_id
                 and d.request_id = a.request_id)`, [DONO_A])).rows[0].n);
      ok("A13b desfecho perdido deixa UMA orfa, e ela e localizavel",
        depois === 1, String(depois));
      ok("A13c a inbox NAO e desfeita, e o resultado admite a incompletude",
        r.tipo === "sincronizado" && r.auditoria === "incompleta"
        && (await linhaDe(LOJA_A, "A13")) !== null);
      ok("A13d a orfa e a desta execucao, e continua `executando`",
        r.tipo === "sincronizado"
        && (await linhasDaAcao(r.requestId)).length === 1
        && (await linhasDaAcao(r.requestId))[0].status === "executando");
    }

    {
      const textos = (await pg.query(
        `select entrada_resumo::text as r, mensagem_desfecho as m
           from public.agente_acao_execucoes where user_id in ($1,$2)`,
        [DONO_A, DONO_B])).rows as Array<{ r: string; m: string | null }>;
      const proibido = /Acompanha manual|MLB1|Q1|UNANSWERED|2026-09-20/;
      ok("A14 nenhuma linha de auditoria carrega payload de pergunta",
        textos.every((l) => !proibido.test(l.r) && !proibido.test(l.m ?? "")),
        String(textos.find((l) => proibido.test(l.r) || proibido.test(l.m ?? ""))?.r ?? ""));
      const chaves = new Set(
        textos.flatMap((l) => Object.keys(JSON.parse(l.r) as Record<string, unknown>)));
      ok("A14b toda chave do resumo pertence a allowlist de metricas",
        [...chaves].every((k) => /^(paginas|provider_recebidas|normalizadas|descartadas_normalizacao|descartadas_ingestao|status_inesperados|ingeriveis|recebidas|unicas|duplicadas_no_lote|novas|atualizadas|reobservadas|truncado|limite_atingido|orcamento_esgotado|auditoria_funcao_incompleta)$/.test(k)),
        [...chaves].join(","));
    }

    {
      ok("A15 a auditoria de FUNCAO segue intocada por esta frente",
        Number((await pg.query(
          "select count(*)::int as n from public.agente_funcao_chamadas")).rows[0].n) === 0);
    }

    {
      const { acoesRegistradas, resolverAcao } =
        await import("@/lib/agentes/acoes/catalogo");
      ok("A17 o MAIN generico NAO alcanca `sincronizar_perguntas`",
        resolverAcao(ACAO) === null && !acoesRegistradas().includes(ACAO),
        acoesRegistradas().join(","));
    }

    {
      // SEM comentario. O docblock do orcamento cita os arquivos de
      // adapter para explicar de onde saem os 20 s, e a primeira versao
      // deste invariante reprovou por causa da propria prosa que
      // documenta a decisao — o mesmo defeito de oraculo que ja custou
      // caro nesta frente.
      const fonte = readFileSync(
        join(__dirname, "..", "lib/agentes/ingestao/sincronizar-perguntas.ts"), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ 	]*\/\/.*$/gm, "");
      ok("A18 o servico nao alcanca o marketplace real por caminho nenhum",
        !/mercado-livre|buscarPerguntasRecebidasML|fetch\(/.test(fonte));
    }

    // =================================================================
    // T. AS TRES CAMADAS DE IDEMPOTENCIA, ao mesmo tempo
    // =================================================================
    secao("T. Tres camadas — e nenhuma delas faz o trabalho da outra");

    {
      // Camada 1 (ACAO): a mesma tentativa nao varre duas vezes.
      // Camada 3 (DOMINIO): a mesma pergunta nao vira duas linhas, nem
      // quando chega por tentativas DIFERENTES.
      //
      // As duas juntas, no mesmo teste, porque e a combinacao que
      // importa: se a camada 1 fizesse o trabalho da 3, uma tentativa
      // nova duplicaria a inbox; se a 3 fizesse o da 1, o provider seria
      // chamado de novo a cada replay.
      const chave = chaveNova();
      const q = pergunta({ id: "T-DOM" });
      const e1 = { paginas: 0, chaves: [] as string[] };
      await sincronizarPerguntas({ agenteId: AGENTE_A, idempotencyKey: chave },
        portas(umaPagina([q]), LOJA_A, DONO_A, { espiao: e1 }));

      const e2 = { paginas: 0, chaves: [] as string[] };
      const r2 = await sincronizarPerguntas({ agenteId: AGENTE_A, idempotencyKey: chave },
        portas(umaPagina([q]), LOJA_A, DONO_A, { espiao: e2 }));

      const e3 = { paginas: 0, chaves: [] as string[] };
      const r3 = await sincronizarPerguntas({ agenteId: AGENTE_A, idempotencyKey: chaveNova() },
        portas(umaPagina([q]), LOJA_A, DONO_A, { espiao: e3 }));

      ok("T1  camada ACAO: a MESMA tentativa nao volta ao provider",
        r2.tipo === "ja_processado" && e2.paginas === 0 && e1.paginas === 1);
      ok("T2  camada ACAO: uma tentativa NOVA volta, e isso e correto",
        e3.paginas === 1 && r3.tipo === "sincronizado");
      ok("T3  camada DOMINIO: a pergunta repetida continua sendo UMA linha",
        (await contarChave(LOJA_A, "T-DOM")) === 1
        && r3.tipo === "sincronizado" && r3.persistencia.novas === 0
        && r3.persistencia.reobservadas === 1);
      ok("T4  camada FUNCAO: cada pagina levou a chave da SUA tentativa",
        e1.chaves[0] === `${chave}:p0` && e3.chaves[0] !== e1.chaves[0]
        && (e3.chaves[0] ?? "").endsWith(":p0"),
        `${e1.chaves[0]} | ${e3.chaves[0]}`);
      ok("T5  as tres chaves sao de espacos DIFERENTES e nao se confundem",
        chave !== `${chave}:p0` && chave !== "T-DOM"
        && !(e1.chaves[0] ?? "").includes("T-DOM"));
    }

    {
      // Duas paginas da mesma tentativa nao compartilham chave: se
      // compartilhassem, a pagina 2 seria recusada pela idempotencia de
      // Funcao e a varredura terminaria curta, em silencio.
      const chave = chaveNova();
      const cheia = Array.from({ length: 50 }, (_, k) => pergunta({ id: `T6-${k}` }));
      const e = { paginas: 0, chaves: [] as string[] };
      await sincronizarPerguntas({ agenteId: AGENTE_A, idempotencyKey: chave },
        portas([
          { linhas: cheia, truncado: true },
          { linhas: [pergunta({ id: "T6-fim" })], truncado: false },
        ], LOJA_A, DONO_A, { espiao: e }));
      ok("T6  paginas da MESMA tentativa tem chaves distintas, com prefixo comum",
        e.chaves.length === 2 && e.chaves[0] === `${chave}:p0`
        && e.chaves[1] === `${chave}:p1`
        && new Set(e.chaves).size === 2,
        e.chaves.join(" | "));
      ok("T7  o prefixo e o que correlaciona acao e paginas",
        e.chaves.every((c) => c.startsWith(`${chave}:`)));
    }

    // =================================================================
    // C. A COLISAO DE `resposta_fora_de_forma`
    // =================================================================
    secao("C. As duas formas ruins deixaram de ter o mesmo nome");

    let terminalC1 = "";
    let terminalC2 = "";
    {
      const r = await sincronizarPerguntas(
        { agenteId: AGENTE_A, idempotencyKey: chaveNova() },
        portasComFalha({
          tipo: "sucesso", requestId: "c1", auditoria: "completa",
          autoridade: { lojaId: LOJA_A }, envelope: { data: { fora: 1 } },
        }, DONO_A));
      const d = r.tipo === "erro"
        ? (await linhasDaAcao(r.requestId)).find((l) => l.fase === "desfecho") ?? {}
        : {};
      terminalC1 = String(d.codigo_desfecho ?? "");
      ok("C1  envelope da Funcao fora de forma -> erro/contrato_violado",
        r.tipo === "erro" && r.codigo === "resposta_funcao_fora_de_forma"
        && r.origem === "contrato" && terminalC1 === "contrato_violado",
        `${r.tipo === "erro" ? r.codigo : r.tipo} / ${terminalC1}`);
    }
    {
      // A RPC saudavel nao produz resposta fora de forma — e por isso
      // SO `gravar` e injetado aqui. A abertura, o desfecho e a tabela
      // continuam reais, e o que se prova e o mapeamento chegando la.
      const p: PortasSincronizacao = {
        lerAgente: async () => ({
          agente: { agenteId: AGENTE_A, userId: DONO_A, ativo: true }, erro: null }),
        executar: async () => ({
          tipo: "sucesso", requestId: "c2", auditoria: "completa",
          autoridade: { lojaId: LOJA_A },
          envelope: { data: { linhas: [], truncado: false, erro: null,
            providerRecebidas: 0, descartadasNormalizacao: 0 } },
        }),
        gravar: async () => ({ tipo: "erro", codigo: "resposta_rpc_fora_de_forma" }),
        abrirAcao: registrarAberturaAcao,
        fecharAcao: registrarDesfechoAcao,
      } as unknown as PortasSincronizacao;

      const r = await sincronizarPerguntas(
        { agenteId: AGENTE_A, idempotencyKey: chaveNova() }, p);
      const d = r.tipo === "erro"
        ? (await linhasDaAcao(r.requestId)).find((l) => l.fase === "desfecho") ?? {}
        : {};
      terminalC2 = String(d.codigo_desfecho ?? "");
      ok("C2  resposta da RPC fora de forma -> erro/persistencia_falhou",
        r.tipo === "erro" && r.codigo === "resposta_rpc_fora_de_forma"
        && r.origem === "persistencia" && terminalC2 === "persistencia_falhou",
        `${r.tipo === "erro" ? r.codigo : r.tipo} / ${terminalC2}`);
    }
    {
      ok("C3  os dois casos nao colapsam no mesmo desfecho",
        terminalC1 !== "" && terminalC2 !== "" && terminalC1 !== terminalC2,
        `${terminalC1} vs ${terminalC2}`);
      const fonte = readFileSync(
        join(__dirname, "..", "lib/agentes/dados/perguntas-inbox.ts"), "utf8");
      ok("C3b o codigo curto e ambiguo nao existe mais na fonte",
        !/"resposta_fora_de_forma"/.test(fonte));
    }

    // =================================================================
    // F. AUDITORIA DE FUNCAO INCOMPLETA
    // =================================================================
    secao("F. O ledger de Funcao furado deixou de ser invisivel");

    {
      const r = await sincronizarPerguntas(
        { agenteId: AGENTE_A, idempotencyKey: chaveNova() },
        portas(umaPagina([pergunta({ id: "F1" })]), LOJA_A, DONO_A));
      const d = r.tipo === "sincronizado"
        ? (await linhasDaAcao(r.requestId)).find((l) => l.fase === "desfecho") ?? {}
        : {};
      const resumo = (d.entrada_resumo ?? {}) as Record<string, unknown>;
      ok("F1  pagina com ledger inteiro: sucesso limpo",
        d.status === "sucesso" && d.codigo_desfecho === null
        && resumo.auditoria_funcao_incompleta === false);
    }

    {
      const r = await sincronizarPerguntas(
        { agenteId: AGENTE_A, idempotencyKey: chaveNova() },
        portas(umaPagina([pergunta({ id: "F2" })]), LOJA_A, DONO_A,
          { paginasIncompletas: [0] }));
      const d = r.tipo === "sincronizado"
        ? (await linhasDaAcao(r.requestId)).find((l) => l.fase === "desfecho") ?? {}
        : {};
      const resumo = (d.entrada_resumo ?? {}) as Record<string, unknown>;
      ok("F2  ledger furado: o dado persiste E o desfecho deixa de ser limpo",
        (await linhaDe(LOJA_A, "F2")) !== null
        && d.status === "parcial" && d.codigo_desfecho === "auditoria_funcao_incompleta"
        && resumo.auditoria_funcao_incompleta === true,
        JSON.stringify({ s: d.status, c: d.codigo_desfecho }));
    }

    {
      const cheia = (marca: string) =>
        Array.from({ length: 50 }, (_, k) => pergunta({ id: `${marca}-${k}` }));
      const r = await sincronizarPerguntas(
        { agenteId: AGENTE_A, idempotencyKey: chaveNova() },
        portas([
          { linhas: cheia("F3a"), truncado: true },
          { linhas: cheia("F3b"), truncado: true },
        ], LOJA_A, DONO_A, { paginasIncompletas: [0] }));
      const d = r.tipo === "backlog_truncado"
        ? (await linhasDaAcao(r.requestId)).find((l) => l.fase === "desfecho") ?? {}
        : {};
      const resumo = (d.entrada_resumo ?? {}) as Record<string, unknown>;
      ok("F3  backlog vence na precedencia, e o fato secundario sobrevive",
        d.codigo_desfecho === "backlog_truncado"
        && resumo.auditoria_funcao_incompleta === true,
        JSON.stringify({ c: d.codigo_desfecho, a: resumo.auditoria_funcao_incompleta }));
    }

    {
      const r = await sincronizarPerguntas(
        { agenteId: AGENTE_A, idempotencyKey: chaveNova() },
        portas(umaPagina([
          pergunta({ id: "F4" }), pergunta({ id: "F4x", status: "ANSWERED" }),
        ]), LOJA_A, DONO_A, { paginasIncompletas: [0] }));
      const d = r.tipo === "sincronizado"
        ? (await linhasDaAcao(r.requestId)).find((l) => l.fase === "desfecho") ?? {}
        : {};
      const resumo = (d.entrada_resumo ?? {}) as Record<string, unknown>;
      ok("F4  descartes vencem auditoria incompleta, sem apaga-la",
        d.codigo_desfecho === "descartes_na_varredura"
        && resumo.auditoria_funcao_incompleta === true,
        JSON.stringify({ c: d.codigo_desfecho, a: resumo.auditoria_funcao_incompleta }));
    }

    {
      // Pagina 1 com ledger furado, pagina 2 falhando no provider: a
      // causa primaria e o provider, e o fato secundario fica no resumo.
      let i = 0;
      const p: PortasSincronizacao = {
        lerAgente: async () => ({
          agente: { agenteId: AGENTE_A, userId: DONO_A, ativo: true }, erro: null }),
        executar: async () => {
          if (i++ === 0) {
            return {
              tipo: "sucesso", requestId: "f5a", auditoria: "incompleta",
              autoridade: { lojaId: LOJA_A },
              envelope: { data: {
                linhas: Array.from({ length: 50 }, (_, k) => pergunta({ id: `F5-${k}` })),
                truncado: true, erro: null, providerRecebidas: 50, descartadasNormalizacao: 0 } },
            };
          }
          return { tipo: "erro", requestId: "f5b", auditoria: "completa",
            envelope: { error: { code: "indisponivel" } } };
        },
        gravar: gravarPerguntasNaInbox,
        abrirAcao: registrarAberturaAcao,
        fecharAcao: registrarDesfechoAcao,
      } as unknown as PortasSincronizacao;

      const r = await sincronizarPerguntas(
        { agenteId: AGENTE_A, idempotencyKey: chaveNova() }, p);
      const d = r.tipo === "erro"
        ? (await linhasDaAcao(r.requestId)).find((l) => l.fase === "desfecho") ?? {}
        : {};
      const resumo = (d.entrada_resumo ?? {}) as Record<string, unknown>;
      ok("F5  falha de provider vence, e a auditoria furada continua no resumo",
        d.status === "erro" && d.codigo_desfecho === "provedor_falhou"
        && resumo.auditoria_funcao_incompleta === true,
        JSON.stringify({ c: d.codigo_desfecho, a: resumo.auditoria_funcao_incompleta }));
    }

    {
      // O invariante geral: nenhuma acao com `auditoria_funcao_incompleta`
      // no resumo pode ter terminado como `sucesso`.
      const mentirosas = Number((await pg.query(
        `select count(*)::int as n from public.agente_acao_execucoes
          where fase = 'desfecho' and status = 'sucesso'
            and entrada_resumo ->> 'auditoria_funcao_incompleta' = 'true'`)).rows[0].n);
      ok("F6  nenhum sucesso limpo foi emitido com ledger de Funcao furado",
        mentirosas === 0, String(mentirosas));
    }

  } finally {
    await pg.query(
      "delete from public.agente_acao_execucoes where user_id in ($1,$2)", [DONO_A, DONO_B]);
    for (const loja of [LOJA_A, LOJA_B]) {
      await pg.query("delete from public.agente_perguntas_ml where loja_id = $1::uuid", [loja]);
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
