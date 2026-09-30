/**
 * MEDICAO do recall CROSS-CHAT do Zep — F7b.4.5 §8/§9/§12.
 *
 * A pergunta e uma so, e ela decide o desenho da correcao:
 *
 *   uma thread NOVA, do MESMO principal, ja nasce enxergando o que foi
 *   dito nas threads anteriores?
 *
 * Se sim, basta ligar `recuperarContexto` no runtime. Se nao, o caminho
 * cross-chat precisa de outra fonte (busca no grafo do usuario), e e
 * melhor descobrir isso agora do que depois de escrever o codigo errado.
 *
 * Nenhuma chave e impressa. Tudo sob um principal sintetico proprio.
 *
 * Roda com: npx tsx scripts/medir-zep-cross-chat.ts
 */
import "./_server-only-inerte";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function carregarEnvLocal(): void {
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
      return;
    } catch { /* proximo */ }
  }
}
carregarEnvLocal();

const BASE = "https://api.getzep.com/api/v2";
/** MEDIDO no F7b.4: sem User-Agent, a API responde 403 code 1010. */
const UA = "cds-agent-factory/1.0";

async function pedir(metodo: string, caminho: string, corpo?: unknown) {
  const r = await fetch(`${BASE}${caminho}`, {
    method: metodo,
    headers: {
      Authorization: `Api-Key ${process.env.ZEP_API_KEY}`,
      "User-Agent": UA,
      Accept: "application/json",
      ...(corpo === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
  });
  const texto = await r.text();
  let json: unknown = null;
  try { json = JSON.parse(texto); } catch { /* fica null */ }
  return { status: r.status, json, texto };
}

async function main(): Promise<void> {
  if (!process.env.ZEP_API_KEY) { console.log("ZEP_API_KEY ausente."); return; }

  const marca = Date.now().toString(36);
  const principal = `cds-medicao-f745-${marca}`;
  const threadA = `conversa-a-${marca}`;
  const threadB = `conversa-b-${marca}`;

  console.log(`principal: ${principal}`);

  // ── 1. O principal ────────────────────────────────────────────────
  const u = await pedir("POST", "/users", { user_id: principal });
  console.log(`[1] POST /users -> ${u.status}`);

  // ── 2. Thread A, com um fato que so pode vir dela ─────────────────
  const a = await pedir("POST", "/threads", { thread_id: threadA, user_id: principal });
  console.log(`[2] POST /threads (A) -> ${a.status}`);

  const msgs = await pedir("POST", `/threads/${threadA}/messages`, {
    messages: [
      { role: "user", name: "usuario", content: "Meu nome e Douglas." },
      { role: "assistant", name: "assistente", content: "Prazer, Douglas." },
      { role: "user", name: "usuario",
        content: "Nos resumos financeiros prefiro ver o saldo primeiro." },
      { role: "assistant", name: "assistente",
        content: "Anotado: saldo primeiro nos resumos." },
    ],
  });
  console.log(`[3] POST /threads/A/messages -> ${msgs.status}`);

  // ── 3. O contexto da PROPRIA thread A ─────────────────────────────
  const ctxA = await pedir("GET", `/threads/${threadA}/context`);
  const textoA = JSON.stringify(ctxA.json ?? "");
  console.log(`\n[4] GET /threads/A/context -> ${ctxA.status}`);
  console.log(`    cita "Douglas"? ${/Douglas/i.test(textoA)}`);
  console.log(`    tamanho: ${textoA.length}`);

  // ── 4. A PERGUNTA CENTRAL: thread B, nova, mesmo principal ────────
  const b = await pedir("POST", "/threads", { thread_id: threadB, user_id: principal });
  console.log(`\n[5] POST /threads (B, NOVA) -> ${b.status}`);

  // O Zep processa o grafo de forma ASSINCRONA. Medir logo depois de
  // ingerir mede a latencia do processamento, e nao o recall.
  let total = 0;
  for (const espera of [0, 15000, 30000, 45000, 60000]) {
    if (espera > 0) { await new Promise((s) => setTimeout(s, espera)); total += espera; }
    const ctxA2 = await pedir("GET", `/threads/${threadA}/context`);
    const ctxB = await pedir("GET", `/threads/${threadB}/context`);
    const tA = JSON.stringify(ctxA2.json ?? "");
    const textoB = JSON.stringify(ctxB.json ?? "");
    console.log(`[6] apos ${total / 1000}s  A: Douglas=${/Douglas/i.test(tA)} ` +
      `len=${tA.length}  |  B(nova): Douglas=${/Douglas/i.test(textoB)} ` +
      `saldo=${/saldo/i.test(textoB)} len=${textoB.length}`);
    if (/Douglas/i.test(textoB)) break;
  }

  // ── 5. O grafo do usuario, que e a outra fonte possivel ───────────
  const busca = await pedir("POST", "/graph/search", {
    user_id: principal, query: "Qual e o nome do usuario?", scope: "edges", limit: 5,
  });
  console.log(`\n[7] POST /graph/search -> ${busca.status}`);
  const textoG = JSON.stringify(busca.json ?? "");
  console.log(`    cita "Douglas"? ${/Douglas/i.test(textoG)}`);
  console.log(`    forma: ${Object.keys((busca.json ?? {}) as object).join(", ")}`);
  if (busca.status >= 400) console.log(`    corpo: ${busca.texto.slice(0, 200)}`);
  else console.log(`    trecho: ${textoG.slice(0, 400)}`);

  // ── 6. Limpeza ────────────────────────────────────────────────────
  console.log(`\n[8] LIMPEZA`);
  for (const t of [threadA, threadB]) {
    const d = await pedir("DELETE", `/threads/${t}`);
    console.log(`    DELETE /threads/${t} -> ${d.status}`);
  }
  const du = await pedir("DELETE", `/users/${principal}`);
  console.log(`    DELETE /users/${principal} -> ${du.status}`);
}

void main();
