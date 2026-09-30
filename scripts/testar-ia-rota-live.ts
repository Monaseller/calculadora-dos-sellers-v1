/**
 * AGENT-FACTORY-F7b.4.3 §17/§18/§27 — pela ROTA, com sessao de verdade.
 *
 * ── O que "pela rota" significa aqui, exatamente ────────────────────
 *
 * Os handlers REAIS (`GET`, `PATCH`) sao importados e executados, com um
 * cookie de sessao ASSINADO de verdade por `emitirTokenSessao`. A
 * autenticacao nao e afrouxada, ignorada nem simulada: `autenticarRequisicao`
 * roda inteira, e sem cookie valido a rota responde 401.
 *
 * E o mesmo harness que `scripts/testar-ia-agentes-api.ts` ja usa desde a
 * SKILL-1D, e a razao de existir e a mesma: provar a superficie HTTP sem
 * subir servidor e sem criar um caminho de autenticacao paralelo.
 *
 * O que ele NAO e: uma chamada pela REDE ao deployment do Preview. O
 * Preview esta atras do SSO da Vercel, e furar isso para testar seria
 * exatamente o tipo de atalho que o gate proibe. A prova de que o codigo
 * chegou la e o build; a prova de que ele se comporta e esta.
 *
 * ── §17/§18: os tres providers, e a persistencia ────────────────────
 *
 * As envs de modelo do Gemini e da OpenAI nao estao em `.env.local` (so no
 * Vercel Preview). Elas sao passadas INLINE no comando, com os MESMOS
 * valores que o Preview tem — editar `.env.local` e Nivel 2 e exige "sim"
 * do Rodrigo.
 *
 * Roda com:
 *   GOOGLE_AI_MODEL_AGENTE=gemini-3.8-flash OPENAI_MODEL_AGENTE=gpt-5.2 \
 *     npx tsx scripts/testar-ia-rota-live.ts
 */
import "./_server-only-inerte";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

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
carregarEnvLocal();

/**
 * Os donos sao UUID, e nao um prefixo como nas outras fixtures.
 *
 * `emitirTokenSessao` LANCA se o uid nao for UUID — a assinatura de sessao
 * cobra o formato, e e bom que cobre. Entao a fixture se adapta ao
 * contrato real em vez de o contrato se adaptar ao teste.
 *
 * O bloco `f743` no meio mantem os dois reconheciveis numa varredura.
 */
const DONO = "c7b00000-f743-4000-8000-0000000000d0";
const INTRUSO = "c7b00000-f743-4000-8000-0000000000d1";
const AGENTE = "c7b00000-0000-4000-8000-000000000045";

let passou = 0;
let falhou = 0;
function ok(nome: string, cond: boolean, detalhe = ""): void {
  if (cond) { passou++; console.log(`  PASS  ${nome}`); }
  else { falhou++; console.log(`  FAIL  ${nome}${detalhe ? ` — ${detalhe}` : ""}`); }
}
function secao(t: string): void { console.log(`\n${t}`); }

async function limpar(db: SupabaseClient): Promise<void> {
  await db.from("agente_ferramentas_externas").delete().eq("user_id", DONO);
  await db.from("agente_permissoes").delete().eq("user_id", DONO);
  await db.from("agentes").delete().eq("user_id", DONO);
}

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const chaveDb = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !chaveDb) { console.error("ERRO: env do Supabase ausente."); process.exit(1); }
  const db = createClient(url, chaveDb);

  const rotaIa = await import("../app/api/agentes/[agenteId]/ia/route");
  const { emitirTokenSessao, COOKIE_SESSAO } = await import("../lib/autenticacao");
  const { modelosDisponiveis } = await import("../lib/agentes/factory/catalogo-de-modelos");

  const cookieDe = async (uid: string) =>
    `${COOKIE_SESSAO}=${(await emitirTokenSessao(uid)).token}`;

  function requisicao(cookie?: string, corpo?: unknown): Request {
    return new Request(`http://local/api/agentes/${AGENTE}/ia`, {
      method: corpo === undefined ? "GET" : "PATCH",
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(corpo === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
    });
  }
  const params = { params: { agenteId: AGENTE } };
  const get = (cookie?: string) => rotaIa.GET(requisicao(cookie), params);
  const patch = (cookie: string | undefined, corpo: unknown) =>
    rotaIa.PATCH(requisicao(cookie, corpo), params);

  console.log("\n== F7b.4.3 §17/§18/§27 — a rota /ia, com sessao assinada ==");

  try {
    await limpar(db);
    await db.from("agentes").upsert({
      id: AGENTE, user_id: DONO, nome: "ZZ FIXTURE rota ia",
      tipo: "personalizado", ativo: false, instrucoes: "Fixture.",
    }, { onConflict: "id" });

    const cookie = await cookieDe(DONO);

    // ─── A. A autenticacao continua inteira ──────────────────────────

    secao("A. Sem sessao valida nao ha dominio");
    {
      ok("A1  GET sem cookie: 401", (await get()).status === 401);
      ok("A2  PATCH sem cookie: 401",
        (await patch(undefined, { provedor: "anthropic" })).status === 401);
      ok("A3  cookie FORJADO nao passa",
        (await get(`${COOKIE_SESSAO}=nao-e-um-token-assinado`)).status === 401);
      // O formato ANTIGO (user_id cru) e recusado de proposito — o cutover
      // do cookie de sessao ja fechou isso, e a rota herda a garantia.
      ok("A4  o formato antigo (user_id cru) tambem nao passa",
        (await get(`${COOKIE_SESSAO}=${DONO}`)).status === 401);

      // ANCORA: com cookie legitimo, passa. Sem isto, A1..A4 passariam
      // com uma rota que responde 401 para tudo.
      ok("A5  ANCORA: com cookie legitimo, a rota responde 200",
        (await get(cookie)).status === 200);

      // Agente de OUTRO dono: nao encontrado, e nao "sem permissao".
      const alheio = await get(await cookieDe(INTRUSO));
      ok("A6  agente de outro dono: 404, nao 200", alheio.status === 404,
        String(alheio.status));
    }

    // ─── B. §17: o catalogo que o deployment produz ──────────────────

    secao("B. O catalogo oferecido pela rota, com o env deste ambiente");
    {
      const r = await get(cookie);
      const corpo = await r.json() as {
        opcoes?: { provedor: string; niveis: { id: string }[]; modeloId: string }[];
        desfecho?: string;
      };
      const provedores = (corpo.opcoes ?? []).map((o) => o.provedor).sort();
      console.log(`  providers oferecidos: ${provedores.join(", ") || "nenhum"}`);
      console.log(`  (env presente: ${modelosDisponiveis().map((m) => m.provedor).join(", ")})`);

      ok("B1  a rota oferece os TRES providers",
        JSON.stringify(provedores) === JSON.stringify(["anthropic", "google", "openai"]),
        provedores.join(","));
      ok("B2  e cada um traz o model id que o AMBIENTE serve",
        (corpo.opcoes ?? []).every((o) => o.modeloId.length > 0));
      ok("B3  a OpenAI e a unica com mais de um nivel",
        (corpo.opcoes ?? []).filter((o) => o.niveis.length > 1)
          .map((o) => o.provedor).join(",") === "openai",
        (corpo.opcoes ?? []).map((o) => `${o.provedor}:${o.niveis.length}`).join(" "));
      ok("B4  e o agente ainda nao escolheu — default do ambiente",
        corpo.desfecho === "default_do_ambiente", String(corpo.desfecho));

      // §14: nada de credencial atravessa a rota.
      const cru = JSON.stringify(corpo);
      ok("B5  a resposta nao carrega chave nenhuma",
        ![process.env.OPENAI_API_KEY, process.env.ANTHROPIC_API_KEY,
          process.env.GOOGLE_AI_API_KEY, process.env.COMPOSIO_API_KEY]
          .filter((v): v is string => typeof v === "string" && v !== "")
          .some((v) => cru.includes(v)));
      ok("B6  nem nome de variavel de ambiente",
        !/API_KEY|MODEL_AGENTE|process\.env/.test(cru));
    }

    // ─── C. §18: escolher, salvar, reler — pelos TRES ────────────────

    secao("C. Persistencia pela ROTA, sem mexer no env entre os testes");
    {
      for (const provedor of ["openai", "google", "anthropic"]) {
        const r = await patch(cookie, { provedor });
        ok(`C1  PATCH ${provedor}: 200`, r.status === 200, String(r.status));

        // A RELEITURA por um GET novo, e nao a resposta do PATCH: a
        // pergunta e se o BANCO guardou, nao se a rota devolveu.
        const lido = await (await get(cookie)).json() as {
          escolha?: { provedor?: string }; desfecho?: string;
        };
        ok(`C2  reler ${provedor}: continua ${provedor}`,
          lido.escolha?.provedor === provedor, String(lido.escolha?.provedor));
        ok(`C3  e o desfecho e \`escolhida\``,
          lido.desfecho === "escolhida", String(lido.desfecho));

        // E a linha do banco, que e a autoridade.
        const { data } = await db.from("agentes")
          .select("provedor_ia, modelo_ia").eq("id", AGENTE).single();
        ok(`C4  a coluna do banco tem ${provedor}`,
          (data as { provedor_ia?: string } | null)?.provedor_ia === provedor,
          String((data as { provedor_ia?: string } | null)?.provedor_ia));
        ok(`C5  e o modelo veio do CATALOGO, nao do corpo`,
          (data as { modelo_ia?: string } | null)?.modelo_ia ===
            modelosDisponiveis().find((m) => m.provedor === provedor)?.modeloId);
      }
    }

    // ─── D. O que a rota RECUSA ──────────────────────────────────────

    secao("D. A rota recusa o que nao pode aceitar");
    {
      ok("D1  provedor inexistente: 409, e nao 200",
        (await patch(cookie, { provedor: "provedor-que-nao-existe" })).status === 409);

      // §16: o model id NAO vem do browser.
      await patch(cookie, { provedor: "openai" });
      await patch(cookie, { provedor: "openai", modelo: "gpt-inventado-pelo-cliente" });
      const { data } = await db.from("agentes")
        .select("modelo_ia").eq("id", AGENTE).single();
      ok("D2  `modelo` no corpo e IGNORADO — o id vem do catalogo",
        (data as { modelo_ia?: string } | null)?.modelo_ia !==
          "gpt-inventado-pelo-cliente",
        String((data as { modelo_ia?: string } | null)?.modelo_ia));

      // Nivel que o provedor nao tem.
      ok("D3  nivel inexistente no provedor: 400",
        (await patch(cookie, { provedor: "anthropic", nivel: "maximo" })).status === 400);
      ok("D4  mas o nivel VALIDO da OpenAI passa",
        (await patch(cookie, { provedor: "openai", nivel: "maximo" })).status === 200);

      const lido = await (await get(cookie)).json() as { escolha?: { nivel?: string } };
      ok("D5  e ele sobrevive a releitura", lido.escolha?.nivel === "maximo",
        String(lido.escolha?.nivel));

      // Limpar volta ao default.
      ok("D6  `provedor: null` limpa a escolha",
        (await patch(cookie, { provedor: null })).status === 200);
      const limpo = await (await get(cookie)).json() as {
        escolha?: { provedor?: string | null }; desfecho?: string;
      };
      ok("D7  e o agente volta ao default do ambiente",
        limpo.escolha?.provedor === null && limpo.desfecho === "default_do_ambiente",
        `${limpo.escolha?.provedor}/${limpo.desfecho}`);

      // Propriedade na ESCRITA.
      const intruso = await patch(await cookieDe(INTRUSO), { provedor: "openai" });
      ok("D8  outro dono nao escreve: 404", intruso.status === 404, String(intruso.status));
      const { data: intacto } = await db.from("agentes")
        .select("provedor_ia").eq("id", AGENTE).single();
      ok("D9  e a linha real ficou intacta",
        (intacto as { provedor_ia?: string | null } | null)?.provedor_ia === null);
    }

  } finally {
    secao("Limpeza");
    await limpar(db);
    const { data } = await db.from("agentes").select("id").eq("user_id", DONO);
    ok("Z1  o agente-fixture foi apagado — ele nao executou nada",
      (data ?? []).length === 0, `${(data ?? []).length}`);
  }

  console.log(`\nPASS ${passou}   FAIL ${falhou}`);
  process.exit(falhou === 0 ? 0 : 1);
}

void main();
