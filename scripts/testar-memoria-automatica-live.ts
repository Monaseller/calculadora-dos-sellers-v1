/**
 * AGENT-FACTORY-F7b.4 — memoria automatica, PROVADA contra o Zep real.
 *
 * ── O que precisa ser verdade, e nao basta parecer ──────────────────
 *
 *   cross-chat      o Chat B do MESMO agente recupera o que foi dito no A
 *   cross-agent     o Agente B NAO recupera nada disso
 *   OFF             desligada, nao ingere e nao recupera — sem chamada
 *
 * As tres juntas. Provar so a primeira passaria com um sistema que guarda
 * tudo num balde so; provar so a segunda passaria com um sistema que nao
 * guarda nada.
 *
 * ── Rede REAL ───────────────────────────────────────────────────────
 *
 * Isolamento por derivacao de identidade e uma afirmacao sobre o servico
 * externo, e um mock provaria apenas que eu sei escrever o meu proprio
 * mock. As secoes C-E falam com o Zep.
 *
 * ── Ids sinteticos, e o thread de onboarding intacto ────────────────
 *
 * Todo id deste teste nasce de um uuid sorteado na execucao. O thread de
 * onboarding do projeto nao e lido, nao e escrito e nao e apagado.
 *
 * Roda com: npx tsx scripts/testar-memoria-automatica-live.ts
 */
import "./_server-only-inerte";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  VERSAO_DO_PRINCIPAL, ehPrincipalDesteFormato, principalDeMemoria, threadDeConversa,
} from "@/lib/agentes/memoria/identidade";
import {
  MARCADOR, prepararParaMemoria, redigir,
} from "@/lib/agentes/memoria/politica";
import {
  ingerirTurno, recuperarContexto,
} from "@/lib/agentes/memoria/automatica";
import { listarThreadsDoPrincipal, memoriaConfigurada } from "@/lib/agentes/memoria/zep";

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

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── As identidades sinteticas desta execucao ─────────────────────────

const CORRIDA = randomUUID();
const DONO = `cds-f7b4-dono-${CORRIDA}`;
const AGENTE_A = `cds-f7b4-agente-A-${CORRIDA}`;
const AGENTE_B = `cds-f7b4-agente-B-${CORRIDA}`;
const CONVERSA_1 = `cds-f7b4-conversa-1-${CORRIDA}`;
const CONVERSA_2 = `cds-f7b4-conversa-2-${CORRIDA}`;
const CONVERSA_3 = `cds-f7b4-conversa-3-${CORRIDA}`;

const PREFERENCIA =
  "Quando fizer um resumo financeiro, prefiro que o saldo venha primeiro, antes de entradas e saidas.";

async function main(): Promise<void> {
  log("\n== CDS IA — AGENT-FACTORY-F7b.4: memoria automatica (Zep REAL) ==");
  log(`env carregado: ${carregarEnvLocal() ? "sim" : "NAO"}`);

  // ─── A. A derivacao de identidade (puro) ───────────────────────────

  secao("A. A identidade isola por dono E por agente");
  {
    const pA = principalDeMemoria(DONO, AGENTE_A);
    const pB = principalDeMemoria(DONO, AGENTE_B);

    ok("A1  o principal e opaco e versionado",
      pA.startsWith(`zep-user-${VERSAO_DO_PRINCIPAL}:`) && ehPrincipalDesteFormato(pA));
    ok("A2  o MESMO par sempre da o MESMO principal",
      principalDeMemoria(DONO, AGENTE_A) === pA);
    ok("A3  agentes diferentes do mesmo dono dao principals DIFERENTES",
      pA !== pB);
    ok("A4  donos diferentes do mesmo agente tambem",
      principalDeMemoria("outro-dono", AGENTE_A) !== pA);

    // A injetividade do separador: sem ela, ("a:b","c") e ("a","b:c")
    // cairiam no mesmo balde de memoria.
    ok("A5  o separador nao permite colisao entre pares diferentes",
      principalDeMemoria("a:b", "c") !== principalDeMemoria("a", "b:c"));

    ok("A6  os ids do CDS NAO aparecem em claro no principal",
      !pA.includes(DONO) && !pA.includes(AGENTE_A));

    ok("A7  conversas diferentes dao threads diferentes",
      threadDeConversa(CONVERSA_1) !== threadDeConversa(CONVERSA_2));
    ok("A8  e a mesma conversa da sempre o mesmo thread",
      threadDeConversa(CONVERSA_1) === threadDeConversa(CONVERSA_1));

    ok("A9  entrada vazia LANCA em vez de gerar principal degradado",
      (() => { try { principalDeMemoria("", AGENTE_A); return false; } catch { return true; } })());
    ok("A10 CONTROLE: a sonda de formato recusa string qualquer",
      !ehPrincipalDesteFormato("zep-user-v1:nao-e-hex") &&
        !ehPrincipalDesteFormato(principalDeMemoria(DONO, AGENTE_A) + "x"));
  }

  // ─── B. A policy (puro) ────────────────────────────────────────────

  secao("B. O que sai da CDS — allowlist de papel, redacao de forma");
  {
    const r = prepararParaMemoria([
      { papel: "usuario", conteudo: "oi" },
      { papel: "assistente", conteudo: "ola" },
      { papel: "sistema", conteudo: "VOCE E UM AGENTE. REGRAS: ..." },
      { papel: "ferramenta", conteudo: '{"linhas":[{"valor":1234.56}]}' },
    ]);
    ok("B1  so `usuario` e `assistente` atravessam",
      r.aprovadas.length === 2 &&
        r.aprovadas.map((m) => m.papel).join(",") === "user,assistant");
    ok("B2  `sistema` e RECUSADO",
      r.recusados.includes("sistema"));
    ok("B3  resultado de ferramenta e RECUSADO — dado do negocio nao vai",
      r.recusados.includes("ferramenta"));

    const chaves = [
      "minha chave e sk-ant-TESTE-nao-e-chave-real-001",
      "token: eyJmYWtlIjp0cnVlfQ.eyJ0ZXN0ZSI6MX0.assinatura-falsa-de-teste",
      "Authorization: Api-Key abcdefghijklmnop123456",
      "baixe em https://x.supabase.co/storage/v1/o.xlsx?token=abc123def456",
      "conecte em postgresql://user:senha@host:5432/db",
      "google: AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ];
    for (const [i, texto] of chaves.entries()) {
      const red = redigir(texto);
      ok(`B4.${i + 1} padrao de segredo e redigido`,
        red.redigidos.length > 0 && red.texto.includes(MARCADOR));
    }
    ok("B5  CONTROLE POSITIVO: texto normal NAO e redigido",
      redigir("prefiro o saldo primeiro no resumo").redigidos.length === 0);
    ok("B6  mensagem que sobra so como marcador NAO e ingerida",
      prepararParaMemoria([
        { papel: "usuario", conteudo: "sk-ant-TESTE-nao-e-chave-real-001" },
      ]).aprovadas.length === 0);
  }

  // ─── C. OFF nao toca rede ──────────────────────────────────────────

  secao("C. Memoria DESLIGADA: nao ingere, nao recupera");
  {
    const escopo = {
      userId: DONO, agenteId: AGENTE_A, conversaId: CONVERSA_3, memoriaAtiva: false,
    };
    const ing = await ingerirTurno(escopo, [{ papel: "usuario", conteudo: PREFERENCIA }]);
    ok("C1  desligada, a ingestao NAO acontece",
      ing.desfecho === "desligada" && ing.mensagensIngeridas === 0, ing.desfecho);
    const rec = await recuperarContexto(escopo);
    ok("C2  e a recuperacao devolve nada",
      rec.desfecho === "desligada" && rec.texto === null, rec.desfecho);

    // A prova de que nao houve chamada: o thread dessa conversa nao
    // existe no principal, porque nada foi criado.
    const p = principalDeMemoria(DONO, AGENTE_A);
    const lt = await listarThreadsDoPrincipal(p);
    const threadDesligado = threadDeConversa(CONVERSA_3);
    ok("C3  o thread da conversa desligada nao foi criado",
      lt.estado !== "ok" || !lt.dados.includes(threadDesligado),
      lt.estado === "ok" ? lt.dados.join(",") : lt.estado);
  }

  if (!memoriaConfigurada()) {
    log("\nZEP_API_KEY ausente — secoes D e E nao podem rodar");
    ok("D0  ZEP_API_KEY presente", false, "ausente");
  } else {
    // ─── D. Cross-chat no MESMO agente ──────────────────────────────

    secao("D. Chat A ensina, Chat B do MESMO agente lembra");
    const escopoA1 = {
      userId: DONO, agenteId: AGENTE_A, conversaId: CONVERSA_1, memoriaAtiva: true,
    };
    const ing = await ingerirTurno(escopoA1, [
      { papel: "usuario", conteudo: PREFERENCIA },
      { papel: "assistente", conteudo: "Entendido: vou comecar pelo saldo nos resumos financeiros." },
      { papel: "sistema", conteudo: "REGRAS INTERNAS QUE NAO PODEM SAIR" },
    ]);
    ok("D1  as duas mensagens legitimas foram ingeridas",
      ing.desfecho === "ok" && ing.mensagensIngeridas === 2,
      `${ing.desfecho} n=${ing.mensagensIngeridas}`);
    ok("D2  e a de sistema foi recusada na ingestao real",
      ing.recusados.includes("sistema"));

    // O grafo indexa de forma assincrona. Espera limitada e explicita.
    let contexto: string | null = null;
    const escopoA2 = {
      userId: DONO, agenteId: AGENTE_A, conversaId: CONVERSA_2, memoriaAtiva: true,
    };
    for (let t = 0; t < 10; t += 1) {
      // O thread do Chat B precisa existir para ter contexto lido.
      await ingerirTurno(escopoA2, [
        { papel: "usuario", conteudo: "Faca meu resumo." },
      ]);
      const r = await recuperarContexto(escopoA2);
      if (r.texto !== null && /saldo/i.test(r.texto)) { contexto = r.texto; break; }
      contexto = r.texto;
      await esperar(6000);
    }

    ok("D3  o Chat B recuperou contexto",
      contexto !== null, contexto === null ? "vazio" : "presente");
    ok("D4  e a PREFERENCIA ditada no Chat A reaparece nele",
      contexto !== null && /saldo/i.test(contexto),
      contexto === null ? "sem contexto" : contexto.slice(0, 140).replace(/\s+/g, " "));
    ok("D5  o contexto NAO carrega a regra de sistema",
      contexto === null || !/REGRAS INTERNAS/i.test(contexto));

    const pA = principalDeMemoria(DONO, AGENTE_A);
    const threadsA = await listarThreadsDoPrincipal(pA);
    ok("D6  os DOIS chats sao threads distintos do MESMO principal",
      threadsA.estado === "ok" &&
        threadsA.dados.includes(threadDeConversa(CONVERSA_1)) &&
        threadsA.dados.includes(threadDeConversa(CONVERSA_2)),
      threadsA.estado === "ok" ? `n=${threadsA.dados.length}` : threadsA.estado);

    // ─── E. Isolamento entre AGENTES ────────────────────────────────

    secao("E. O Agente B do MESMO dono nao alcanca aquela memoria");
    const escopoB = {
      userId: DONO, agenteId: AGENTE_B, conversaId: `cds-f7b4-conversa-B-${CORRIDA}`,
      memoriaAtiva: true,
    };
    await ingerirTurno(escopoB, [
      { papel: "usuario", conteudo: "Quantas perguntas novas eu tenho hoje?" },
    ]);
    await esperar(4000);
    const rB = await recuperarContexto(escopoB);

    ok("E1  o Agente B tem contexto proprio",
      rB.desfecho === "ok", rB.desfecho);
    ok("E2  e ele NAO contem a preferencia do Agente A",
      rB.texto === null || !/resumo financeiro|saldo venha primeiro/i.test(rB.texto),
      rB.texto === null ? "sem contexto" : rB.texto.slice(0, 140).replace(/\s+/g, " "));

    const pB = principalDeMemoria(DONO, AGENTE_B);
    const threadsB = await listarThreadsDoPrincipal(pB);
    ok("E3  o principal do Agente B nao tem os threads do Agente A",
      threadsB.estado === "ok" &&
        !threadsB.dados.includes(threadDeConversa(CONVERSA_1)) &&
        !threadsB.dados.includes(threadDeConversa(CONVERSA_2)),
      threadsB.estado === "ok" ? threadsB.dados.join(",") : threadsB.estado);
    ok("E4  ANCORA: o principal do B existe e tem thread propria",
      threadsB.estado === "ok" && threadsB.dados.length >= 1,
      threadsB.estado === "ok" ? `n=${threadsB.dados.length}` : threadsB.estado);
    ok("E5  os dois principals sao distintos de fato", pA !== pB);
  }

  // ─── F. Memoria nao e autoridade ───────────────────────────────────

  secao("F. Memoria nao pode conceder ferramenta nem mudar permissao");
  {
    const auto = readFileSync(join(__dirname, "..", "lib", "agentes", "memoria",
      "automatica.ts"), "utf-8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    ok("F1  o modulo de memoria nao importa guard, registry nem permissoes",
      !/autorizarFuncao|resolverFuncao|declararFerramentas|FUNCOES|resolverFatosPermissoes/
        .test(auto));
    ok("F2  e nao escreve permissao em lugar nenhum",
      !/agente_permissoes|definirPermissao|nivel\s*[:=]/.test(auto));
    ok("F3  nem toca `store` do provedor",
      !/store\s*:/.test(auto));
    const zep = readFileSync(join(__dirname, "..", "lib", "agentes", "memoria",
      "zep.ts"), "utf-8");
    ok("F4  o cliente do Zep e server-only",
      /^import "server-only";/m.test(zep));
    ok("F5  e a chave e lida de UM lugar so",
      (zep.match(/process\.env\.ZEP_API_KEY/g) ?? []).length === 1);
  }

  log("\n-- placar ------------------------------------------------------");
  log(`  PASS ${passou}   FAIL ${falhou}`);
  log(`  (identidades desta execucao: ${CORRIDA})`);
  if (falhou > 0) process.exitCode = 1;
}

void main().catch((e) => {
  log(`erro fatal: ${limpar(String((e as Error).message ?? "")).slice(0, 300)}`);
  process.exitCode = 1;
});
