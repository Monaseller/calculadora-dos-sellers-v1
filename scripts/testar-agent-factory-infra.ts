/**
 * AGENT-FACTORY — smoke da INFRAESTRUTURA real (banco + storage).
 *
 * ── Esta suite TOCA O BANCO E O BUCKET DE PRODUCAO ──────────────────
 *
 * Diferente de toda a familia `testar-agentes-*`, que nao chama banco
 * nem rede, esta aqui usa a service_role para exercitar o caminho que
 * so existe de verdade contra Postgres e Storage: upload, resolucao por
 * `fileId`, isolamento por dono e por agente, e leitura de planilha a
 * partir dos bytes que estao no bucket.
 *
 * Ela NAO roda sozinha em varredura nenhuma. E invocada a mao, num gate
 * que autoriza escrever em producao — e o que ela escreve sao FIXTURES
 * com prefixo proprio, apagadas no fim.
 *
 * ── Cleanup e obrigatorio, inclusive quando um assert falha ─────────
 *
 * Todo o corpo roda dentro de `try`, e a limpeza vive no `finally`. Um
 * teste que deixa lixo em producao e pior que um teste que nao existe:
 * a proxima pessoa encontra linhas que nao explicam nada e nao sabe se
 * pode apagar. No fim, a propria suite CONFERE que nao sobrou nada.
 *
 * ── Nenhum dado real ────────────────────────────────────────────────
 *
 * Os donos sao sinteticos (`FIXTURE-AF-*`), nao existem em `perfil`, e
 * as planilhas sao as fixtures determinísticas do F3. Nenhum agente
 * real e lido, escrito ou sequer consultado.
 *
 * Rodar:  npx tsx scripts/testar-agent-factory-infra.ts
 */
import "./_server-only-inerte";

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { BUCKET_FONTES } from "@/lib/agentes/fontes/armazenamento";
import { criarPortaDeFontes } from "@/lib/agentes/fontes/repositorio";
import { criarFonteDeArquivoDasSources } from "@/lib/agentes/fontes/resolvedor";
import { receberFonte } from "@/lib/agentes/fontes/upload";
import { criarPortaDeMemorias } from "@/lib/agentes/memorias/repositorio";
import {
  criarMemoria, definirAtivoDaMemoria, listarMemorias, removerMemoria,
} from "@/lib/agentes/memorias/servico";
import { montarContextoDoAgente } from "@/lib/agentes/ia/contexto-do-agente";
import { criarPortaDeConversas } from "@/lib/agentes/conversas/repositorio";
import { registrarFonteDeArquivo } from "@/lib/agentes/funcoes/planilha";
import { resolverFuncao, type ContextoFuncao } from "@/lib/agentes/funcoes/registry";

const RAIZ = join(__dirname, "..");
const FIXTURES = join(RAIZ, "scripts", "fixtures", "planilhas");

// Prefixo proprio: e por ele que o cleanup encontra tudo que esta suite
// criou, sem precisar guardar lista em lugar nenhum.
const PREFIXO = "FIXTURE-AF";
const DONO_A = `${PREFIXO}-DONO-A`;
const DONO_B = `${PREFIXO}-DONO-B`;
const AG_A1 = "af000000-0000-4000-8000-000000000001";
const AG_A2 = "af000000-0000-4000-8000-000000000002";
const AG_B1 = "af000000-0000-4000-8000-000000000003";

// ─── Saida sem segredo ────────────────────────────────────────────────
//
// Fail-closed por VALOR: toda variavel de ambiente que parece credencial
// e trocada por marcador antes de qualquer coisa chegar ao console,
// venha ela de onde vier — inclusive de dentro de uma mensagem de erro.

function valoresSensiveis(): string[] {
  const fora: string[] = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== "string" || v.length < 12) continue;
    if (/KEY|SECRET|TOKEN|PASSWORD|SENHA|CREDENTIAL|AUTH/i.test(k)) fora.push(v);
  }
  return fora;
}
let SENSIVEIS: string[] = [];
function limpar(t: string): string {
  let s = t;
  for (const v of SENSIVEIS) s = s.split(v).join("«REDIGIDO»");
  return s.replace(/eyJ[A-Za-z0-9_-]{20,}/g, "«REDIGIDO»");
}
function log(...p: unknown[]): void {
  console.log(limpar(p.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")));
}

let passou = 0;
let falhou = 0;
function ok(nome: string, cond: boolean, detalhe?: string): void {
  if (cond) { passou += 1; log(`  PASS  ${nome}`); }
  else { falhou += 1; log(`  FAIL  ${nome}${detalhe ? ` — ${detalhe}` : ""}`); }
}
function secao(t: string): void {
  log(`\n── ${t} ${"─".repeat(Math.max(2, 58 - t.length))}`);
}

function carregarEnvLocal(): void {
  for (const caminho of [
    join(RAIZ, ".env.local"),
    join("C:", "Users", "USER", "Desktop", "calculadora-dos-sellers-v1", ".env.local"),
  ]) {
    try {
      for (const linha of readFileSync(caminho, "utf-8").split("\n")) {
        const l = linha.trim();
        if (!l || l.startsWith("#")) continue;
        const i = l.indexOf("=");
        if (i === -1) continue;
        const k = l.slice(0, i).trim();
        let v = l.slice(i + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        if (!(k in process.env)) process.env[k] = v;
      }
      return;
    } catch { /* tenta o proximo */ }
  }
}

/**
 * Apaga TUDO que o prefixo alcanca.
 *
 * Roda no `finally`, entao roda mesmo com assert quebrado. A ordem e
 * storage primeiro: se o processo morrer no meio, sobra linha sem
 * objeto — detectavel — em vez de objeto sem linha, que ninguem acha.
 */
async function limparFixtures(db: SupabaseClient): Promise<{
  objetos: number; fontes: number; memorias: number; agentes: number;
}> {
  const { data: comCaminho } = await db.from("agente_fontes")
    .select("caminho_objeto").like("user_id", `${PREFIXO}%`);
  const caminhos = (comCaminho ?? []).map((l) => (l as { caminho_objeto: string }).caminho_objeto);
  if (caminhos.length > 0) await db.storage.from(BUCKET_FONTES).remove(caminhos);

  // Conversas primeiro: o CASCADE leva as mensagens junto.
  await db.from("agente_conversas").delete().like("user_id", `${PREFIXO}%`);
  const { count: cm } = await db.from("agente_memorias")
    .delete({ count: "exact" }).like("user_id", `${PREFIXO}%`);
  const { count: cf } = await db.from("agente_fontes")
    .delete({ count: "exact" }).like("user_id", `${PREFIXO}%`);
  const { count: ca } = await db.from("agentes")
    .delete({ count: "exact" }).like("user_id", `${PREFIXO}%`);
  return { objetos: caminhos.length, fontes: cf ?? 0, memorias: cm ?? 0, agentes: ca ?? 0 };
}

async function main(): Promise<void> {
  carregarEnvLocal();
  SENSIVEIS = valoresSensiveis();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !chave) {
    console.error("ERRO: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes.");
    process.exit(1);
  }
  const db = createClient(url, chave);
  const portaF = criarPortaDeFontes(db);
  const portaM = criarPortaDeMemorias(db);

  log("\n══ AGENT FACTORY — smoke de infraestrutura (banco + storage) ══");

  try {
    // Estado anterior: se ja havia lixo de um run interrompido, some agora.
    const antes = await limparFixtures(db);
    if (antes.agentes + antes.fontes + antes.memorias > 0) {
      log(`  (limpeza previa: ${JSON.stringify(antes)})`);
    }

    // ═════════════════════════════════════════════════════════════════
    secao("A. Bucket privado e fixtures");
    // ═════════════════════════════════════════════════════════════════
    {
      const { data: buckets } = await db.storage.listBuckets();
      const b = (buckets ?? []).find((x) => x.name === BUCKET_FONTES);
      ok("A1  o bucket existe", b !== undefined, BUCKET_FONTES);
      ok("A2  e ele e PRIVADO", b?.public === false, String(b?.public));

      const { error } = await db.from("agentes").insert([
        { id: AG_A1, user_id: DONO_A, nome: "ZZ FIXTURE AF agente A1", tipo: "personalizado", ativo: true },
        { id: AG_A2, user_id: DONO_A, nome: "ZZ FIXTURE AF agente A2", tipo: "personalizado", ativo: true },
        { id: AG_B1, user_id: DONO_B, nome: "ZZ FIXTURE AF agente B1", tipo: "personalizado", ativo: true },
      ]);
      ok("A3  tres agentes-fixture criados (donos sinteticos)", error === null,
        error ? String(error.message).slice(0, 90) : "");
    }

    // ═════════════════════════════════════════════════════════════════
    secao("B. Upload real: XLSX e CSV no bucket privado");
    // ═════════════════════════════════════════════════════════════════
    const ids: Record<string, string> = {};
    {
      for (const [arq, papel] of [
        ["entrada.xlsx", "Entradas"], ["saida.xlsx", "Saidas"], ["movimentos.csv", "Movimentos"],
      ] as [string, string][]) {
        const r = await receberFonte(portaF, {
          userId: DONO_A, escopo: "agente", agenteId: AG_A1, nome: arq, papel,
          descricao: `Fixture ${papel}`,
          bytes: new Uint8Array(readFileSync(join(FIXTURES, arq))),
        });
        ok(`B1  upload de ${arq}`, r.ok === true, r.ok ? "" : r.codigo);
        if (r.ok) ids[arq] = r.fonte.id;
      }
      const { data: objetos } = await db.storage.from(BUCKET_FONTES)
        .list(`${DONO_A}/agente/${AG_A1}`);
      ok("B2  os bytes estao mesmo no bucket", (objetos?.length ?? 0) === 3,
        String(objetos?.length));

      const { data: linha } = await db.from("agente_fontes")
        .select("hash_sha256").eq("user_id", DONO_A).eq("id", ids["entrada.xlsx"]).single();
      ok("B3  o hash gravado e o do arquivo",
        (linha as { hash_sha256?: string } | null)?.hash_sha256 ===
          createHash("sha256").update(readFileSync(join(FIXTURES, "entrada.xlsx"))).digest("hex"));
    }

    // ═════════════════════════════════════════════════════════════════
    secao("C. Resolver real -> planilha -> numeros conhecidos");
    // ═════════════════════════════════════════════════════════════════
    const ctx: ContextoFuncao = Object.freeze({ userId: DONO_A, conexao: null });
    const chamar = async (id: string, args: unknown) => {
      const d = resolverFuncao(id);
      const v = d.validarEntrada(args);
      if (!v.valida) return { ok: false, codigo: v.codigo } as Record<string, unknown>;
      return (await d.executor(ctx, args)) as Record<string, unknown>;
    };
    const resolvedorA1 = criarFonteDeArquivoDasSources({
      porta: portaF, userId: DONO_A, agenteId: AG_A1 });
    {
      registrarFonteDeArquivo(resolvedorA1);

      const insp = await chamar("planilha.inspecionar", { fileId: ids["entrada.xlsx"] });
      ok("C1  planilha.inspecionar PELO storage", insp.ok === true,
        JSON.stringify(insp).slice(0, 110));
      ok("C2  NENHUM caminho fisico na resposta",
        !new RegExp(`${BUCKET_FONTES}|${DONO_A}/agente|caminhoObjeto`).test(JSON.stringify(insp)));
      ok("C3  e NENHUMA credencial",
        !JSON.stringify(insp).includes(chave.slice(0, 20)) && !/eyJ/.test(JSON.stringify(insp)));

      const lido = await chamar("planilha.ler", { fileId: ids["movimentos.csv"], limite: 2 });
      ok("C4  planilha.ler funciona com CSV pelo bucket",
        lido.ok === true && (lido.linhas as string[][]).length === 2);

      const SET = { valor: "2026-09-01", ate: "2026-09-30" };
      const entradas = await chamar("planilha.agregar", {
        fileId: ids["entrada.xlsx"], operacao: "sum", coluna: "Valor",
        filtros: [{ coluna: "Data", operador: "entre", ...SET },
                  { coluna: "Categoria", operador: "diferente", valor: "controle" }],
      });
      ok("C5  ENTRADAS de setembro = 4969.12", entradas.valor === "4969.12",
        String(entradas.valor));

      const saidas = await chamar("planilha.agregar", {
        fileId: ids["saida.xlsx"], operacao: "sum", coluna: "Valor",
        filtros: [{ coluna: "Data", operador: "entre", ...SET }],
      });
      ok("C6  SAIDAS de setembro = 2600.50", saidas.valor === "2600.50", String(saidas.valor));

      const saldo = await chamar("calculadora.calcular",
        { operacao: "subtract", valores: ["4969.12", "2600.50"] });
      ok("C7  SALDO = 2368.62",
        (saldo as { resultado?: string }).resultado === "2368.62", JSON.stringify(saldo));

      ok("C8  a proveniencia traz o fileId autorizado",
        (entradas.proveniencia as Record<string, unknown>).fileId === ids["entrada.xlsx"]);
    }

    // ═════════════════════════════════════════════════════════════════
    secao("D. Isolamento no runtime real");
    // ═════════════════════════════════════════════════════════════════
    {
      registrarFonteDeArquivo(criarFonteDeArquivoDasSources({
        porta: portaF, userId: DONO_A, agenteId: AG_A2 }));
      const outroAgente = await chamar("planilha.inspecionar", { fileId: ids["entrada.xlsx"] });
      ok("D1  OUTRO AGENTE do mesmo dono nao le",
        outroAgente.ok === false && outroAgente.codigo === "arquivo_nao_encontrado",
        JSON.stringify(outroAgente).slice(0, 90));

      registrarFonteDeArquivo(criarFonteDeArquivoDasSources({
        porta: portaF, userId: DONO_B, agenteId: AG_B1 }));
      ok("D2  OUTRO DONO nao le",
        (await chamar("planilha.inspecionar", { fileId: ids["entrada.xlsx"] })).ok === false);

      registrarFonteDeArquivo(resolvedorA1);
      ok("D3  CONTROLE: o dono/agente certo AINDA le — 'tudo nega' nao e prova",
        (await chamar("planilha.inspecionar", { fileId: ids["entrada.xlsx"] })).ok === true);

      await db.from("agente_fontes").update({ ativo: false })
        .eq("user_id", DONO_A).eq("id", ids["movimentos.csv"]);
      ok("D4  fonte DESATIVADA nao resolve",
        (await chamar("planilha.inspecionar", { fileId: ids["movimentos.csv"] })).ok === false);

      // O BANCO recusa o vinculo cruzado, e nao so o codigo.
      const { error: cross } = await db.from("agente_fontes").insert({
        user_id: DONO_B, agente_id: AG_A1, escopo: "agente", nome: "x.csv",
        tipo: "csv", mime: "text/csv", tamanho_bytes: 10,
        hash_sha256: "0".repeat(64), caminho_objeto: `${PREFIXO}/cross`,
      });
      ok("D5  o BANCO recusa fonte cross-tenant (FK composta)",
        cross !== null && /foreign key|violates/i.test(String(cross.message)),
        String(cross?.message ?? "(passou!)").slice(0, 80));
    }

    // ═════════════════════════════════════════════════════════════════
    secao("E. Memoria no banco real");
    // ═════════════════════════════════════════════════════════════════
    {
      const m = await criarMemoria(portaM, { userId: DONO_A, agenteId: AG_A1,
        conteudo: "Fixture AF: mostre saldo primeiro.", tipo: "formato", ordem: 1 });
      ok("E1  criar memoria", m.ok === true, m.ok ? "" : m.codigo);

      const dup = await criarMemoria(portaM, { userId: DONO_A, agenteId: AG_A1,
        conteudo: "  FIXTURE AF: MOSTRE SALDO PRIMEIRO.  " });
      ok("E2  duplicata exata recusada pelo indice unico",
        !dup.ok && dup.codigo === "memoria_duplicada", JSON.stringify(dup));

      ok("E3  o agente ve a dele",
        (await listarMemorias(portaM, DONO_A, AG_A1, { somenteAtivas: true })).length === 1);
      ok("E4  outro agente do mesmo dono NAO ve",
        (await listarMemorias(portaM, DONO_A, AG_A2)).length === 0);
      ok("E5  outro dono NAO ve",
        (await listarMemorias(portaM, DONO_B, AG_A1)).length === 0);

      const { error: crossM } = await db.from("agente_memorias").insert({
        user_id: DONO_B, agente_id: AG_A1, conteudo: "invasora",
      });
      ok("E6  o BANCO recusa memoria cross-tenant",
        crossM !== null && /foreign key|violates/i.test(String(crossM.message)),
        String(crossM?.message ?? "(passou!)").slice(0, 80));

      if (m.ok) {
        await definirAtivoDaMemoria(portaM, DONO_A, AG_A1, m.memoria.id, false);
        const ativas = await listarMemorias(portaM, DONO_A, AG_A1, { somenteAtivas: true });
        ok("E7  desativada sai das ativas", ativas.length === 0);

        const contexto = montarContextoDoAgente({
          instrucoesDoAgente: "fixture", skills: [], memorias: ativas,
          fontes: (await portaF.listarDoAgente(DONO_A, AG_A1)).map((f) => ({
            id: f.id, nome: f.nome, descricao: f.descricao, papel: f.papel, tipo: f.tipo })),
        });
        ok("E8  e o contexto montado NAO a cita",
          !contexto.instrucao.includes("Fixture AF"));
        ok("E9  mas cita as fontes por nome e papel",
          contexto.instrucao.includes("entrada.xlsx") && contexto.instrucao.includes("Entradas"));
        ok("E10 e NENHUM caminho ou credencial no contexto",
          !new RegExp(`${BUCKET_FONTES}|eyJ`).test(contexto.instrucao));
        ok("E11 remover memoria",
          (await removerMemoria(portaM, DONO_A, AG_A1, m.memoria.id)).ok === true);
      }
    }

    // ═════════════════════════════════════════════════════════════════
    secao("F. CROSS-CHAT contra o banco REAL");
    // ═════════════════════════════════════════════════════════════════
    {
      const portaC = criarPortaDeConversas(db);
      const chatA = await portaC.criarConversa(DONO_A, AG_A1, "Chat A");
      const chatB = await portaC.criarConversa(DONO_A, AG_A1, "Chat B");
      ok("F1  duas conversas do mesmo agente", chatA.id !== chatB.id);

      await portaC.anexarMensagem({ userId: DONO_A, conversaId: chatA.id,
        papel: "usuario", conteudo: "assunto exclusivo do chat A" });
      await portaC.anexarMensagem({ userId: DONO_A, conversaId: chatA.id,
        papel: "assistente", conteudo: "resposta do A",
        provedor: "anthropic", modelo: "fixture", tokensEntrada: 1, tokensSaida: 1, tempoMs: 1 });
      await portaC.anexarMensagem({ userId: DONO_A, conversaId: chatB.id,
        papel: "usuario", conteudo: "assunto do chat B" });

      const msgsA = await portaC.listarMensagens(DONO_A, chatA.id);
      const msgsB = await portaC.listarMensagens(DONO_A, chatB.id);
      ok("F2  a ordem e sequencial e o UNIQUE do banco aceitou",
        msgsA.map((m) => m.ordem).join(",") === "0,1" && msgsB[0].ordem === 0);
      ok("F3  HISTORICO de A NAO aparece em B",
        !msgsB.some((m) => m.conteudo.includes("exclusivo do chat A")));
      ok("F4  CONTROLE: em A ele aparece",
        msgsA.some((m) => m.conteudo.includes("exclusivo do chat A")));

      // ANEXO no chat A (escopo conversa) vs FONTE do agente.
      const bytesCsv = new Uint8Array(readFileSync(join(FIXTURES, "movimentos.csv")));
      const anexo = await receberFonte(portaF, {
        userId: DONO_A, escopo: "conversa", conversaId: chatA.id,
        nome: "anexo-temporario.csv", bytes: bytesCsv });
      ok("F5  anexo aceito no chat A", anexo.ok === true, anexo.ok ? "" : anexo.codigo);

      const resA = criarFonteDeArquivoDasSources({
        porta: portaF, userId: DONO_A, agenteId: AG_A1, conversaId: chatA.id });
      const resB = criarFonteDeArquivoDasSources({
        porta: portaF, userId: DONO_A, agenteId: AG_A1, conversaId: chatB.id });

      ok("F6  FONTE do agente resolve no chat A",
        (await resA.resolver(DONO_A, ids["entrada.xlsx"])) !== null);
      ok("F7  e resolve TAMBEM no chat B — atravessa a conversa",
        (await resB.resolver(DONO_A, ids["entrada.xlsx"])) !== null);
      ok("F8  ANEXO resolve no chat A",
        anexo.ok && (await resA.resolver(DONO_A, anexo.fonte.id)) !== null);
      ok("F9  e NAO resolve no chat B — fica na conversa",
        anexo.ok && (await resB.resolver(DONO_A, anexo.fonte.id)) === null);

      // MEMORIA atravessa: ela e do agente.
      const m = await criarMemoria(portaM, { userId: DONO_A, agenteId: AG_A1,
        conteudo: "Fixture AF cross-chat: saldo primeiro." });
      const ativas = await listarMemorias(portaM, DONO_A, AG_A1, { somenteAtivas: true });
      const fontesDoAgente = (await portaF.listarDoAgente(DONO_A, AG_A1)).map((f) => ({
        id: f.id, nome: f.nome, descricao: f.descricao, papel: f.papel, tipo: f.tipo }));
      const ctxA = montarContextoDoAgente({ instrucoesDoAgente: "fixture", skills: [],
        memorias: ativas, fontes: fontesDoAgente });
      const ctxB = montarContextoDoAgente({ instrucoesDoAgente: "fixture", skills: [],
        memorias: ativas, fontes: fontesDoAgente });
      ok("F10 MEMORIA aparece nos DOIS chats",
        m.ok && ctxA.instrucao.includes("cross-chat: saldo primeiro") &&
        ctxB.instrucao.includes("cross-chat: saldo primeiro"));
      ok("F11 o ANEXO NAO entra no contexto do agente",
        !ctxA.instrucao.includes("anexo-temporario.csv"));
      ok("F12 e nenhum caminho de storage no contexto",
        !new RegExp(`${BUCKET_FONTES}|${DONO_A}/agente`).test(ctxA.instrucao));

      // Conversa de outro dono nao e lida.
      ok("F13 conversa do dono A nao e lida pelo dono B",
        (await portaC.obterConversa(DONO_B, chatA.id)) === null);

      // O BANCO recusa o vinculo cruzado.
      const { error: crossC } = await db.from("agente_conversas")
        .insert({ user_id: DONO_B, agente_id: AG_A1, titulo: "invasora" });
      ok("F14 o BANCO recusa conversa cross-tenant",
        crossC !== null && /foreign key|violates/i.test(String(crossC.message)),
        String(crossC?.message ?? "(passou!)").slice(0, 70));
    }
  } finally {
    // ═════════════════════════════════════════════════════════════════
    // CLEANUP — roda mesmo com assert quebrado.
    // ═════════════════════════════════════════════════════════════════
    registrarFonteDeArquivo(null);
    const removido = await limparFixtures(db);
    log(`\n  cleanup: ${removido.objetos} objetos, ${removido.fontes} fontes, ` +
        `${removido.memorias} memorias, ${removido.agentes} agentes`);

    // E a suite CONFERE que nao sobrou nada.
    const { count: sobraF } = await db.from("agente_fontes")
      .select("id", { count: "exact", head: true }).like("user_id", `${PREFIXO}%`);
    const { count: sobraM } = await db.from("agente_memorias")
      .select("id", { count: "exact", head: true }).like("user_id", `${PREFIXO}%`);
    const { count: sobraA } = await db.from("agentes")
      .select("id", { count: "exact", head: true }).like("user_id", `${PREFIXO}%`);
    const { data: sobraO } = await db.storage.from(BUCKET_FONTES).list(`${DONO_A}/agente/${AG_A1}`);

    ok("Z1  cleanup: zero fontes de fixture", (sobraF ?? 0) === 0, String(sobraF));
    ok("Z2  cleanup: zero memorias de fixture", (sobraM ?? 0) === 0, String(sobraM));
    ok("Z3  cleanup: zero agentes de fixture", (sobraA ?? 0) === 0, String(sobraA));
    ok("Z4  cleanup: zero objetos no bucket", (sobraO?.length ?? 0) === 0, String(sobraO?.length));
  }

  log(`\n── placar ${"─".repeat(50)}`);
  log(`  PASS ${passou}   FAIL ${falhou}`);
}

void main().then(
  () => process.exit(falhou > 0 ? 1 : 0),
  (e) => { console.error("ERRO NAO TRATADO:", limpar(String((e as Error).message ?? e)).slice(0, 300)); process.exit(1); }
);
