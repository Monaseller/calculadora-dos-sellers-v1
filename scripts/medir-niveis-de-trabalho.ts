/**
 * MEDICAO dos niveis de trabalho por provedor — F7b.4.3 §19/§20/§21.
 *
 * A pergunta e uma so, e por modelo REAL:
 *
 *   o caminho que a CDS usa aceita controle de esforco/raciocinio?
 *
 * Nao se responde por documentacao (§20: "Nao inferir apenas da
 * documentacao"). Cada valor e enviado numa chamada real, minima, com
 * ferramenta declarada — porque e assim que o agente chama.
 *
 * Nenhuma chave e impressa. Custo minimo: uma chamada curta por valor.
 *
 * Roda com:
 *   ANTHROPIC_MODEL_AGENTE=... GOOGLE_AI_MODEL_AGENTE=... OPENAI_MODEL_AGENTE=... \
 *     npx tsx scripts/medir-niveis-de-trabalho.ts
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

/** Frase de erro sem nada que pareca credencial. */
function limpar(t: string): string {
  return t.replace(/[A-Za-z0-9_\-]{28,}/g, "[REDIGIDO]").slice(0, 220);
}

const FERRAMENTA_ANTHROPIC = {
  name: "somar",
  description: "Soma dois numeros.",
  input_schema: {
    type: "object",
    properties: { a: { type: "number" }, b: { type: "number" } },
    required: ["a", "b"],
  },
};

async function medirAnthropic(): Promise<void> {
  const modelo = process.env.ANTHROPIC_MODEL_AGENTE;
  const chave = process.env.ANTHROPIC_API_KEY;
  console.log(`\n── ANTHROPIC (${modelo}) ──────────────────────────────`);
  if (!modelo || !chave) { console.log("  env ausente"); return; }

  // O `thinking` da Messages API e o unico controle real de esforco que a
  // Anthropic expoe. Se ele nao for aceito NESTE modelo, pelo caminho que
  // a CDS usa, entao nivel unico fixo e a resposta correta.
  const casos: { rotulo: string; extra: Record<string, unknown> }[] = [
    { rotulo: "sem thinking (o que a CDS faz hoje)", extra: {} },
    { rotulo: "thinking enabled budget_tokens=1024",
      extra: { thinking: { type: "enabled", budget_tokens: 1024 } } },
    { rotulo: "thinking enabled budget_tokens=4096",
      extra: { thinking: { type: "enabled", budget_tokens: 4096 } } },
    { rotulo: "thinking disabled", extra: { thinking: { type: "disabled" } } },
  ];

  for (const c of casos) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": chave,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: modelo,
        // `max_tokens` maior que o budget: a API exige isso quando ha
        // thinking, e um 400 por essa razao nao diria nada sobre suporte.
        max_tokens: 8192,
        tools: [FERRAMENTA_ANTHROPIC],
        messages: [{ role: "user", content: "Quanto e 2 mais 3? Use a ferramenta." }],
        ...c.extra,
      }),
    });
    const texto = await r.text();
    console.log(`  ${r.status}  ${c.rotulo}`);
    if (!r.ok) console.log(`        ${limpar(texto)}`);
  }
}

async function medirGemini(): Promise<void> {
  const modelo = process.env.GOOGLE_AI_MODEL_AGENTE;
  const chave = process.env.GOOGLE_AI_API_KEY;
  console.log(`\n── GEMINI (${modelo}) ────────────────────────────────`);
  if (!modelo || !chave) { console.log("  env ausente"); return; }

  // A CDS fala com a Interactions API e `store: false`. O controle de
  // raciocinio do Gemini 3 e `thinking_level`; valores medidos um a um.
  const casos: { rotulo: string; extra: Record<string, unknown> }[] = [
    { rotulo: "sem thinking_level (o que a CDS faz hoje)", extra: {} },
    { rotulo: "thinking_level=low", extra: { thinking_level: "low" } },
    { rotulo: "thinking_level=high", extra: { thinking_level: "high" } },
    { rotulo: "thinking_level=minimal", extra: { thinking_level: "minimal" } },
  ];

  for (const c of casos) {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: { "x-goog-api-key": chave, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelo,
        store: false,
        input: [{ type: "message", role: "user",
          content: [{ type: "text", text: "Quanto e 2 mais 3? Use a ferramenta." }] }],
        tools: [{ type: "function", name: "somar", description: "Soma dois numeros.",
          parameters: FERRAMENTA_ANTHROPIC.input_schema }],
        ...c.extra,
      }),
    });
    const texto = await r.text();
    console.log(`  ${r.status}  ${c.rotulo}`);
    if (!r.ok) console.log(`        ${limpar(texto)}`);
  }
}

async function medirOpenAI(): Promise<void> {
  const modelo = process.env.OPENAI_MODEL_AGENTE;
  const chave = process.env.OPENAI_API_KEY;
  console.log(`\n── OPENAI (${modelo}) ────────────────────────────────`);
  if (!modelo || !chave) { console.log("  env ausente"); return; }

  // Os QUATRO rotulos da CDS mapeiam para estes quatro valores. O gate
  // exige medir de novo, com o modelo escolhido — e `minimal` entra como
  // CONTROLE: se ele passar, o mapeamento atual esta desatualizado.
  const valores = ["none", "low", "medium", "high", "minimal"];

  for (const v of valores) {
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${chave}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelo,
        store: false,
        reasoning: { effort: v },
        input: [{ role: "user", content: "Quanto e 2 mais 3? Use a ferramenta." }],
        tools: [{ type: "function", name: "somar", description: "Soma dois numeros.",
          parameters: FERRAMENTA_ANTHROPIC.input_schema }],
      }),
    });
    const texto = await r.text();
    const marca = v === "minimal" ? "  (CONTROLE: deve FALHAR)" : "";
    console.log(`  ${r.status}  reasoning.effort=${v}${marca}`);
    if (!r.ok) console.log(`        ${limpar(texto)}`);
    // 3 RPM nesta org. Sem a pausa, os ultimos valores batem em 429 e a
    // medicao mediria o rate limit, nao o suporte.
    await new Promise((s) => setTimeout(s, 22000));
  }
}

async function main(): Promise<void> {
  const so = process.argv[2];
  if (so === undefined || so === "anthropic") await medirAnthropic();
  if (so === undefined || so === "gemini") await medirGemini();
  if (so === undefined || so === "openai") await medirOpenAI();
}

void main();
