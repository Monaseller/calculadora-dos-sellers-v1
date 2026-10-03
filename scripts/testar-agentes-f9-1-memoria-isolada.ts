/**
 * F9.1-D — anexo "so desta conversa" nao alimenta a memoria persistente.
 *
 * NAO chama IA, NAO chama banco, NAO chama storage, NAO chama o Zep.
 *
 * ── Como "nao chama o Zep" e garantido ──────────────────────────────
 *
 * `zep.ts` fala com a API por `fetch` global e so tenta quando ha
 * `ZEP_API_KEY`. Aqui a chave e FICTICIA e `fetch` e trocado, ANTES de
 * qualquer chamada, por um gravador que responde localmente. Ele nunca
 * delega ao `fetch` real, e qualquer URL fora da base do Zep reprova a
 * suite. O que ele grava e exatamente o que teria saido da CDS.
 *
 * ── Como o taint e provado ──────────────────────────────────────────
 *
 * A pergunta "esta conversa tem ou teve anexo?" roda pela PORTA REAL
 * (`criarPortaDeFontes`) sobre uma tabela em memoria que aplica os
 * `.eq()` de verdade. A ingestao roda pela funcao REAL
 * (`ingerirTurnoDaConversa` -> `ingerirTurno` -> politica -> cliente Zep).
 *
 * Rodar:  npx tsx scripts/testar-agentes-f9-1-memoria-isolada.ts
 */
import "./_server-only-inerte";

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";

import { criarPortaDeFontes } from "@/lib/agentes/fontes/repositorio";
import { ingerirTurnoDaConversa } from "@/lib/agentes/conversas/memoria-da-conversa";
import { threadDeConversa } from "@/lib/agentes/memoria/identidade";

const RAIZ = join(__dirname, "..");
const BASE_ZEP = "https://api.getzep.com/api/v2";

let passou = 0;
let falhou = 0;
function ok(nome: string, cond: boolean, detalhe?: string): void {
  if (cond) { passou += 1; console.log(`  PASS  ${nome}`); }
  else { falhou += 1; console.log(`  FAIL  ${nome}${detalhe ? ` — ${detalhe}` : ""}`); }
}
function secao(t: string): void {
  console.log(`\n── ${t} ${"─".repeat(Math.max(2, 60 - t.length))}`);
}
function semComentarios(f: string): string {
  return f.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// ─── O Zep FALSO ──────────────────────────────────────────────────────

interface PedidoAoZep { metodo: string; caminho: string; corpo: unknown }
const pedidosAoZep: PedidoAoZep[] = [];
const urlsForaDoZep: string[] = [];

process.env.ZEP_API_KEY = "chave-ficticia-da-suite-f91d";
globalThis.fetch = (async (entrada: unknown, init?: { method?: string; body?: unknown }) => {
  const url = String(entrada);
  if (!url.startsWith(`${BASE_ZEP}/`)) {
    urlsForaDoZep.push(url);
    throw new Error("rede proibida nesta suite");
  }
  const caminho = url.slice(BASE_ZEP.length);
  const corpo = typeof init?.body === "string" ? JSON.parse(init.body) : null;
  pedidosAoZep.push({ metodo: init?.method ?? "GET", caminho, corpo });
  if (/^\/threads\/[^/]+\/messages$/.test(caminho)) {
    const n = Array.isArray((corpo as { messages?: unknown[] })?.messages)
      ? (corpo as { messages: unknown[] }).messages.length : 0;
    return new Response(JSON.stringify({ message_uuids: Array.from({ length: n }, (_, i) => `m${i}`) }),
      { status: 201 });
  }
  return new Response("{}", { status: 201 });
}) as typeof fetch;

/** As mensagens que chegaram ao thread desta conversa. */
function mensagensNoZep(conversaId: string): { role: string; content: string }[] {
  const caminho = `/threads/${encodeURIComponent(threadDeConversa(conversaId))}/messages`;
  return pedidosAoZep
    .filter((p) => p.caminho === caminho)
    .flatMap((p) => (p.corpo as { messages: { role: string; content: string }[] }).messages);
}
function pedidosDoThread(conversaId: string): PedidoAoZep[] {
  const t = threadDeConversa(conversaId);
  return pedidosAoZep.filter((p) =>
    p.caminho.includes(encodeURIComponent(t)) ||
    (p.corpo as { thread_id?: string } | null)?.thread_id === t);
}

// ─── A tabela de fontes em memoria, com `.eq()` de verdade ────────────

interface LinhaFonteMem {
  id: string; user_id: string; agente_id: string | null; conversa_id: string | null;
  escopo: string; ativo: boolean; criado_em: string;
}

function clienteEmMemoria(linhas: LinhaFonteMem[], quebrado = false) {
  const consultas: Record<string, unknown>[] = [];
  const builder = () => {
    const filtros: Record<string, unknown> = {};
    const executar = () => {
      consultas.push({ ...filtros });
      return linhas.filter((l) =>
        Object.entries(filtros).every(([c, v]) => (l as never)[c] === v));
    };
    const q = {
      select() { return q; },
      eq(c: string, v: unknown) { filtros[c] = v; return q; },
      order() { return q; },
      limit() { return q; },
      then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
        const r = quebrado
          ? { data: null, error: { message: "falha simulada do driver com conversa-x" } }
          : { data: executar(), error: null };
        return Promise.resolve(r).then(res, rej);
      },
    };
    return q;
  };
  const cliente = {
    from(t: string) {
      if (t !== "agente_fontes") throw new Error(`tabela inesperada: ${t}`);
      return builder();
    },
  };
  return { cliente: cliente as unknown as SupabaseClient, consultas };
}

const DONO_A = "f91d-dono-a";
const DONO_B = "f91d-dono-b";
const AG_1 = "f91d-agente-1";
const AG_2 = "f91d-agente-2";

let seq = 0;
function anexo(user: string, conversa: string, ativo = true): LinhaFonteMem {
  seq += 1;
  return { id: `anexo-${seq}`, user_id: user, agente_id: null, conversa_id: conversa,
    escopo: "conversa", ativo, criado_em: `2026-10-03T00:00:${String(seq).padStart(2, "0")}Z` };
}
function permanente(user: string, agente: string): LinhaFonteMem {
  seq += 1;
  return { id: `perm-${seq}`, user_id: user, agente_id: agente, conversa_id: null,
    escopo: "agente", ativo: true, criado_em: `2026-10-03T00:00:${String(seq).padStart(2, "0")}Z` };
}

async function main(): Promise<void> {
  console.log("\n══ CDS IA — F9.1-D: anexo da conversa fora da memoria persistente ══");

  const linhas: LinhaFonteMem[] = [];
  const { cliente, consultas } = clienteEmMemoria(linhas);
  const porta = criarPortaDeFontes(cliente);
  const verificar = (u: string, c: string) => porta.conversaTemOuTeveAnexo(u, c);

  const turno = (user: string, agente: string, conversa: string, usuario: string,
                 assistente: string, memoriaAtiva = true) =>
    ingerirTurnoDaConversa(
      { userId: user, agenteId: agente, conversaId: conversa, memoriaAtiva },
      [{ papel: "usuario", conteudo: usuario }, { papel: "assistente", conteudo: assistente }],
      verificar);

  // ═══════════════════════════════════════════════════════════════════
  secao("A. Conversa SEM anexo — memoria como sempre");
  // ═══════════════════════════════════════════════════════════════════
  {
    const r = await turno(DONO_A, AG_1, "conv-limpa", "Meu nome e Rodrigo.", "Prazer, Rodrigo.");
    const m = mensagensNoZep("conv-limpa");
    ok("A1  a fala do USUARIO chega ao Zep",
      m.some((x) => x.role === "user" && x.content === "Meu nome e Rodrigo."));
    ok("A2  a fala do ASSISTENTE chega ao Zep",
      m.some((x) => x.role === "assistant" && x.content === "Prazer, Rodrigo."));
    ok("A3  desfecho ok, duas mensagens", r.desfecho === "ok" && r.mensagensIngeridas === 2,
      JSON.stringify(r));
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("B. Anexo da conversa ATIVO — nada chega ao Zep");
  // ═══════════════════════════════════════════════════════════════════
  {
    linhas.push(anexo(DONO_A, "conv-anexo-ativo"));
    const r = await turno(DONO_A, AG_1, "conv-anexo-ativo",
      "Qual o marcador do arquivo?", "O marcador e F91_SECRET_827361.");
    ok("B1  USUARIO nao chega ao Zep", !mensagensNoZep("conv-anexo-ativo").some((x) => x.role === "user"));
    ok("B2  ASSISTENTE nao chega ao Zep",
      !mensagensNoZep("conv-anexo-ativo").some((x) => x.role === "assistant"));
    ok("B3  nem um pedido sequer sobre este thread (nem criar thread)",
      pedidosDoThread("conv-anexo-ativo").length === 0);
    ok("B4  o marcador nao aparece em NENHUM pedido ao Zep",
      !JSON.stringify(pedidosAoZep).includes("F91_SECRET_827361"));
    ok("B5  desfecho isolada / anexo_da_conversa",
      r.desfecho === "isolada" && "motivo" in r && r.motivo === "anexo_da_conversa", JSON.stringify(r));
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("C. Anexo REMOVIDO (ativo=false) — continua isolada");
  // ═══════════════════════════════════════════════════════════════════
  {
    linhas.push(anexo(DONO_A, "conv-anexo-removido", false));
    const r = await turno(DONO_A, AG_1, "conv-anexo-removido",
      "E o valor?", "O valor era R$ 456,78.");
    ok("C1  USUARIO nao chega ao Zep",
      !mensagensNoZep("conv-anexo-removido").some((x) => x.role === "user"));
    ok("C2  ASSISTENTE nao chega ao Zep",
      !mensagensNoZep("conv-anexo-removido").some((x) => x.role === "assistant"));
    ok("C3  desfecho isolada", r.desfecho === "isolada");
    const consulta = consultas[consultas.length - 1];
    ok("C4  a consulta NAO filtra `ativo` — removido tambem conta",
      consulta !== undefined && !("ativo" in consulta), JSON.stringify(consulta));
    ok("C5  e filtra dono, conversa e escopo=conversa",
      consulta?.user_id === DONO_A && consulta?.conversa_id === "conv-anexo-removido" &&
        consulta?.escopo === "conversa", JSON.stringify(consulta));
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("D. Arquivo PERMANENTE do agente — nao marca a conversa");
  // ═══════════════════════════════════════════════════════════════════
  {
    linhas.push(permanente(DONO_A, AG_1));
    const r = await turno(DONO_A, AG_1, "conv-com-permanente",
      "Some a planilha de entradas.", "As entradas somam R$ 4.969,12.");
    const m = mensagensNoZep("conv-com-permanente");
    ok("D1  USUARIO chega ao Zep", m.some((x) => x.role === "user"));
    ok("D2  ASSISTENTE chega ao Zep", m.some((x) => x.role === "assistant"));
    ok("D3  desfecho ok", r.desfecho === "ok", JSON.stringify(r));
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("E/F. Anexo DEPOIS de turnos normais — dali em diante, nada");
  // ═══════════════════════════════════════════════════════════════════
  {
    const c = "conv-anexo-no-meio";
    await turno(DONO_A, AG_1, c, "Prefiro respostas curtas.", "Combinado, serei breve.");
    const antes = mensagensNoZep(c).length;
    ok("E1  turno ANTES do anexo foi ingerido normalmente", antes === 2, String(antes));

    linhas.push(anexo(DONO_A, c));
    await turno(DONO_A, AG_1, c, "Leia o arquivo anexado.", "Produto TESTE F9.1: 123 unidades.");
    await turno(DONO_A, AG_1, c, "E o valor?", "R$ 456,78.");
    // F: o USUARIO repete o dado do arquivo com as proprias palavras.
    await turno(DONO_A, AG_1, c, "Certo, entao sao 123 unidades e R$ 456,78.", "Isso mesmo.");
    const depois = mensagensNoZep(c);
    ok("E2  turnos DEPOIS do anexo nao foram ingeridos", depois.length === antes,
      `${antes} -> ${depois.length}`);
    ok("E3  o que ja estava (antes do anexo) continua la, intocado",
      depois.some((x) => x.content === "Prefiro respostas curtas."));
    ok("F1  a fala do usuario repetindo o dado do arquivo NAO chega ao Zep",
      !JSON.stringify(pedidosAoZep).includes("123 unidades e R$ 456,78"));
    ok("F2  nenhum valor do arquivo saiu para o Zep",
      !JSON.stringify(pedidosAoZep).includes("456,78") &&
        !JSON.stringify(pedidosAoZep).includes("TESTE F9.1"));
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("G/H/I. Isolamento: outra conversa, outro agente, outro dono");
  // ═══════════════════════════════════════════════════════════════════
  {
    // G: conv-anexo-ativo (AG_1, DONO_A) esta marcada; outra conversa do
    // MESMO agente e dono segue normal.
    await turno(DONO_A, AG_1, "conv-irma-limpa", "Trabalho com eletronicos.", "Anotado.");
    ok("G1  conversa LIMPA do mesmo agente segue ingerindo",
      mensagensNoZep("conv-irma-limpa").length === 2);

    // H: outro agente do mesmo dono.
    await turno(DONO_A, AG_2, "conv-agente-2", "Meu fornecedor e da China.", "Entendido.");
    ok("H1  conversa de OUTRO agente segue ingerindo",
      mensagensNoZep("conv-agente-2").length === 2);

    // I: outro dono — inclusive pedindo pelo MESMO id de conversa marcada.
    await turno(DONO_B, AG_1, "conv-dono-b", "Vendo roupas.", "Certo.");
    ok("I1  conversa de OUTRO dono segue ingerindo",
      mensagensNoZep("conv-dono-b").length === 2);
    ok("I2  o anexo do dono A NAO marca nada para o dono B (filtro por user_id)",
      (await porta.conversaTemOuTeveAnexo(DONO_B, "conv-anexo-ativo")) === false);
    ok("I3  CONTROLE: para o dono A a mesma conversa esta marcada",
      (await porta.conversaTemOuTeveAnexo(DONO_A, "conv-anexo-ativo")) === true);
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("J. Falha na verificacao — FECHA (nao ingere)");
  // ═══════════════════════════════════════════════════════════════════
  {
    const erros: string[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => { erros.push(a.map(String).join(" ")); };
    let r1, r2;
    try {
      r1 = await ingerirTurnoDaConversa(
        { userId: DONO_A, agenteId: AG_1, conversaId: "conv-erro-1", memoriaAtiva: true },
        [{ papel: "usuario", conteudo: "texto do usuario" },
         { papel: "assistente", conteudo: "texto do assistente" }],
        async () => { throw new Error("banco fora"); });

      // Pela porta REAL, com o driver devolvendo erro.
      const quebrada = criarPortaDeFontes(clienteEmMemoria([], true).cliente);
      r2 = await ingerirTurnoDaConversa(
        { userId: DONO_A, agenteId: AG_1, conversaId: "conv-erro-2", memoriaAtiva: true },
        [{ papel: "usuario", conteudo: "texto do usuario" },
         { papel: "assistente", conteudo: "texto do assistente" }],
        (u, c) => quebrada.conversaTemOuTeveAnexo(u, c));
    } finally {
      console.error = original;
    }
    ok("J1  verificacao que LANCA: nada chega ao Zep",
      pedidosDoThread("conv-erro-1").length === 0 && mensagensNoZep("conv-erro-1").length === 0);
    ok("J2  desfecho isolada / verificacao_falhou",
      r1?.desfecho === "isolada" && "motivo" in r1 && r1.motivo === "verificacao_falhou",
      JSON.stringify(r1));
    ok("J3  porta REAL com erro do driver: tambem fecha",
      r2?.desfecho === "isolada" && pedidosDoThread("conv-erro-2").length === 0, JSON.stringify(r2));
    ok("J4  o erro foi registrado", erros.length >= 2, String(erros.length));
    ok("J5  e o registro nao traz conteudo, ids nem texto do driver",
      erros.every((e) => !/texto do|conv-erro|f91d-|banco fora|falha simulada/.test(e)),
      JSON.stringify(erros));
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("K. Memoria DESLIGADA — nem consulta, nem Zep (como antes)");
  // ═══════════════════════════════════════════════════════════════════
  {
    let consultou = false;
    const antes = pedidosAoZep.length;
    const r = await ingerirTurnoDaConversa(
      { userId: DONO_A, agenteId: AG_1, conversaId: "conv-desligada", memoriaAtiva: false },
      [{ papel: "usuario", conteudo: "x" }, { papel: "assistente", conteudo: "y" }],
      async () => { consultou = true; return false; });
    ok("K1  desfecho desligada", r.desfecho === "desligada");
    ok("K2  sem consulta de anexo", !consultou);
    ok("K3  sem pedido ao Zep", pedidosAoZep.length === antes);
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("L. Uma porta so — runtime e retomada");
  // ═══════════════════════════════════════════════════════════════════
  {
    const arquivos: string[] = [];
    const varrer = (dir: string) => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) varrer(p);
        else if (/\.(ts|tsx)$/.test(n)) arquivos.push(relative(RAIZ, p).replace(/\\/g, "/"));
      }
    };
    varrer(join(RAIZ, "lib"));
    varrer(join(RAIZ, "app"));
    const permitidos = new Set([
      "lib/agentes/memoria/zep.ts",                  // define `adicionarMensagens`
      "lib/agentes/memoria/automatica.ts",           // define `ingerirTurno`
      "lib/agentes/conversas/memoria-da-conversa.ts", // a UNICA porta de conversa
    ]);
    const chamadores = arquivos.filter((f) =>
      !permitidos.has(f) &&
      /\bingerirTurno\(|\badicionarMensagens\(/.test(semComentarios(readFileSync(join(RAIZ, f), "utf8"))));
    ok("L1  ninguem fora da porta chama ingerirTurno/adicionarMensagens",
      chamadores.length === 0, JSON.stringify(chamadores));

    const rt = semComentarios(readFileSync(join(RAIZ, "lib/agentes/conversas/runtime.ts"), "utf8"));
    ok("L2  o runtime ingere pela porta, com a verificacao da porta de fontes",
      /ingerirTurnoDaConversa\(/.test(rt) &&
        /portaFontes\.conversaTemOuTeveAnexo\(userId, conversaId\)/.test(rt));

    const rr = semComentarios(readFileSync(join(RAIZ, "lib/agentes/conversas/retomada.ts"), "utf8"));
    ok("L3  a retomada hoje NAO ingere memoria",
      !/ingerirTurno|adicionarMensagens|memoria\/automatica/.test(rr));
    ok("L4  e se um dia ingerir, so pode ser pela porta (L1 reprova o resto)",
      !/ingerirTurno\(/.test(rr) || /ingerirTurnoDaConversa\(/.test(rr));
  }

  ok("Z1  nenhum pedido de rede saiu para fora do Zep falso", urlsForaDoZep.length === 0,
    JSON.stringify(urlsForaDoZep));

  console.log(`\n── placar ${"─".repeat(54)}`);
  console.log(`  PASS ${passou}   FAIL ${falhou}`);
}

void main().then(
  () => process.exit(falhou > 0 ? 1 : 0),
  (e) => { console.error("ERRO NAO TRATADO:", e); process.exit(1); }
);
