/**
 * AGENT-FACTORY-F7b.4.8.3 §24–§32 — o envio tem identidade.
 *
 * Suite LIVE: rota real de conversa, sessao assinada, banco real,
 * **OpenAI real** (§14 do gate anterior: o bug so aparece com ela).
 *
 * ── A evidencia que originou isto ───────────────────────────────────
 *
 * O Rodrigo digitou "me traz os ultimos 7 dias". A tela disse:
 *
 *   "Nao foi possivel enviar."
 *
 * Ele NAO reenviou. Depois de um tempo, **o agente respondeu sozinho**.
 *
 * Isso nao e falha de envio. `responderNaConversa` persiste a fala do
 * usuario ANTES de chamar o modelo, entao se o pedido chegou o turno
 * existe. Quem desistiu foi o cliente — e a frase que ele leu convidava a
 * reenviar uma consulta que estava rodando.
 *
 * Roda com:
 *   OPENAI_MODEL_AGENTE=gpt-5.2 npx tsx scripts/testar-envio-turno-live.ts
 */
import "./_server-only-inerte";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

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

const DONO = "c7b00000-f483-4000-8000-0000000000e0";
const AGENTE = "c7b00000-f483-4000-8000-0000000000e1";

/** As tres frases da sequencia obrigatoria do §32. */
const FRASE_1 = "Quanto vendi esta semana no Mercado Livre?";
const FRASE_2 =
  "Compare esta semana com a semana passada e me fale a diferença em reais e em porcentagem.";
const FRASE_3 = "me traz os últimos 7 dias";

let pass = 0;
let fail = 0;
function ok(nome: string, cond: boolean, detalhe = ""): void {
  if (cond) { pass += 1; console.log(`  PASS  ${nome}`); }
  else { fail += 1; console.log(`  FAIL  ${nome}${detalhe ? `  — ${detalhe}` : ""}`); }
}
function secao(t: string): void { console.log(`\n${t}`); }

async function limpar(db: SupabaseClient): Promise<void> {
  await db.from("agente_capacidades_pendentes").delete().eq("user_id", DONO);
  await db.from("agente_conversas").delete().eq("user_id", DONO);
  await db.from("agente_permissoes").delete().eq("user_id", DONO);
  await db.from("agentes").update({ ativo: false }).eq("user_id", DONO);
}

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const chaveDb = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !chaveDb) { console.error("ERRO: env do Supabase."); process.exit(1); }
  if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_MODEL_AGENTE) {
    console.error("ERRO: env da OpenAI. Passe OPENAI_MODEL_AGENTE inline.");
    process.exit(1);
  }
  const db = createClient(url, chaveDb);

  const { emitirTokenSessao, COOKIE_SESSAO } = await import("../lib/autenticacao");
  const { criarPortaDeConversas } = await import("../lib/agentes/conversas/repositorio");
  const rota = await import(
    "../app/api/agentes/[agenteId]/conversas/[conversaId]/route");

  const portaC = criarPortaDeConversas(db);
  const cookie = `${COOKIE_SESSAO}=${(await emitirTokenSessao(DONO)).token}`;

  async function ler(r: Response) {
    let corpo: Record<string, unknown> = {};
    try { corpo = await r.json() as Record<string, unknown>; } catch { /* vazio */ }
    return { status: r.status, corpo };
  }
  /** O MESMO POST de `enviarNaConversaDoChat`, com identidade de envio. */
  const enviar = async (cid: string, texto: string, envioId?: string) =>
    ler(await rota.POST(
      new Request(`http://local/api/agentes/${AGENTE}/conversas/${cid}`, {
        method: "POST", headers: { cookie, "Content-Type": "application/json" },
        body: JSON.stringify(envioId === undefined ? { texto } : { texto, envioId }),
      }), { params: { agenteId: AGENTE, conversaId: cid } }));
  const lerConversa = async (cid: string) => ler(await rota.GET(
    new Request(`http://local/api/agentes/${AGENTE}/conversas/${cid}`, {
      headers: { cookie },
    }), { params: { agenteId: AGENTE, conversaId: cid } }));
  const contarMensagens = async (cid: string) => {
    const { count } = await db.from("agente_mensagens")
      .select("id", { count: "exact", head: true })
      .eq("user_id", DONO).eq("conversa_id", cid);
    return count ?? 0;
  };

  console.log("══ F7b.4.8.3 — identidade do envio e reconciliacao ══");

  try {
    await limpar(db);
    await db.from("agentes").upsert({
      id: AGENTE, user_id: DONO, nome: "ZZ FIXTURE envio f4883",
      tipo: "personalizado", ativo: true, provedor_ia: "openai",
      memoria_ativa: false,
      instrucoes: "Responda em uma frase curta. Nao use ferramenta.",
    }, { onConflict: "id" });
    // Sem ferramenta: o turno e rapido e o que se mede e o CICLO do envio.
    // As consultas pesadas ja sao provadas em `testar-ml-completude-live`.

    // ═══ A. Um envio normal, com identidade ═════════════════════════

    secao("A. O envio identificado roda uma vez");
    let conversaA = "";
    const envioA = "envio-a-f4883";
    {
      const c = await portaC.criarConversa(DONO, AGENTE, null);
      conversaA = c.id;
      const r = await enviar(conversaA, "diga apenas ok", envioA);
      ok("A1  a rota responde 200", r.status === 200, String(r.status));
      ok("A2  com a fala do usuario e a resposta",
        r.corpo.mensagem !== null && r.corpo.resposta !== null);
      ok("A3  e NAO e reconciliado — este envio e novo",
        r.corpo.reconciliado !== true, String(r.corpo.reconciliado));
      ok("A4  duas mensagens gravadas", await contarMensagens(conversaA) === 2,
        String(await contarMensagens(conversaA)));

      // O `envio_id` ficou na fala do usuario.
      const { data } = await db.from("agente_mensagens")
        .select("papel, envio_id").eq("conversa_id", conversaA)
        .order("ordem", { ascending: true });
      const linhas = (data ?? []) as { papel: string; envio_id: string | null }[];
      ok("A5  §29: o envio ficou gravado na fala do usuario",
        linhas[0]?.papel === "usuario" && linhas[0]?.envio_id === envioA,
        String(linhas[0]?.envio_id));
      ok("A6  e a resposta do agente NAO carrega envio",
        linhas[1]?.envio_id === null, String(linhas[1]?.envio_id));
    }

    // ═══ B. §30: reenviar o MESMO envio nao duplica ═════════════════

    secao("B. Reenviar o mesmo envio reconcilia — §30");
    {
      const antes = await contarMensagens(conversaA);
      const idsAntes = (await db.from("agente_mensagens")
        .select("id").eq("conversa_id", conversaA)).data ?? [];

      const r = await enviar(conversaA, "diga apenas ok", envioA);
      ok("B1  responde 200", r.status === 200, String(r.status));
      ok("B2  §30: marcado como RECONCILIADO — nao rodou de novo",
        r.corpo.reconciliado === true, String(r.corpo.reconciliado));
      ok("B3  e NENHUMA mensagem nova foi gravada",
        await contarMensagens(conversaA) === antes,
        `${antes} -> ${await contarMensagens(conversaA)}`);

      const idsDepois = (await db.from("agente_mensagens")
        .select("id").eq("conversa_id", conversaA)).data ?? [];
      ok("B4  os ids sao os MESMOS — nenhum turno novo",
        JSON.stringify(idsAntes) === JSON.stringify(idsDepois));

      // §30: e a resposta devolvida e a MESMA, e nao outra gerada agora.
      const resp = r.corpo.resposta as { id?: string } | undefined;
      const { data: assistente } = await db.from("agente_mensagens")
        .select("id").eq("conversa_id", conversaA).eq("papel", "assistente")
        .maybeSingle();
      ok("B5  a resposta devolvida e a que ja existia",
        resp?.id === (assistente as { id?: string } | null)?.id,
        `${String(resp?.id)} vs ${String((assistente as { id?: string } | null)?.id)}`);

      // CONTROLE: um envio DIFERENTE com o mesmo texto roda de novo.
      const r2 = await enviar(conversaA, "diga apenas ok", "envio-b-f4883");
      ok("B6  CONTROLE: envio DIFERENTE roda — nao e cache de texto",
        r2.status === 200 && r2.corpo.reconciliado !== true &&
          await contarMensagens(conversaA) === antes + 2,
        `${String(r2.corpo.reconciliado)} / ${await contarMensagens(conversaA)}`);
    }

    // ═══ C. §27: turno EM ANDAMENTO nao e falha ═════════════════════

    secao("C. Turno aceito e ainda rodando — §26/§27");
    {
      const c = await portaC.criarConversa(DONO, AGENTE, null);
      const envioC = "envio-c-f4883";

      // Simula o estado real: a fala do usuario JA gravada com o envio, e
      // a resposta ainda nao. E exatamente o que existe no banco enquanto
      // o modelo trabalha — e era esse o momento em que a tela mentia.
      await portaC.anexarMensagem({
        userId: DONO, conversaId: c.id, papel: "usuario",
        conteudo: FRASE_3, envioId: envioC,
      });

      const r = await enviar(c.id, FRASE_3, envioC);
      ok("C1  §27: NAO e erro — o envio foi aceito",
        r.status === 202 && r.corpo.ok === true,
        `${r.status} ok=${String(r.corpo.ok)}`);
      ok("C2  e diz que esta EM ANDAMENTO",
        r.corpo.emAndamento === true && r.corpo.motivo === "em_andamento",
        `${String(r.corpo.emAndamento)}/${String(r.corpo.motivo)}`);
      ok("C3  a fala do usuario volta — ela existe",
        (r.corpo.mensagem as { conteudo?: string } | undefined)?.conteudo === FRASE_3);
      ok("C4  e a resposta vem NULA, sem inventar conteudo",
        r.corpo.resposta === null, String(r.corpo.resposta));
      ok("C5  §30: e NADA rodou — uma mensagem, nao duas",
        await contarMensagens(c.id) === 1, String(await contarMensagens(c.id)));

      // §31: refresh durante o turno em curso.
      const recarregada = await lerConversa(c.id);
      const msgs = (recarregada.corpo.mensagens ?? []) as { conteudo?: string }[];
      ok("C6  §31: o refresh MANTEM a mensagem enviada",
        msgs.length === 1 && msgs[0]?.conteudo === FRASE_3,
        String(msgs.length));

      // E quando a resposta chega, o mesmo envio a devolve.
      //
      // A resposta NAO leva `envioId` — o indice unico parcial so admite
      // uma linha por envio, e essa linha e a fala do usuario. A resposta
      // e encontrada por ser a mensagem seguinte.
      await portaC.anexarMensagem({
        userId: DONO, conversaId: c.id, papel: "assistente",
        conteudo: "pronto",
      });
      const depois = await enviar(c.id, FRASE_3, envioC);
      ok("C7  com a resposta gravada, o MESMO envio a entrega",
        depois.status === 200 && depois.corpo.reconciliado === true &&
          (depois.corpo.resposta as { conteudo?: string } | undefined)?.conteudo === "pronto",
        `${depois.status}/${String(depois.corpo.reconciliado)}`);
      ok("C8  e ainda sem turno novo",
        await contarMensagens(c.id) === 2, String(await contarMensagens(c.id)));
    }

    // ═══ D. §32: a terceira mensagem funciona ═══════════════════════

    secao("D. A sequencia do §32 — a terceira mensagem nao morre");
    {
      const c = await portaC.criarConversa(DONO, AGENTE, null);
      const frases = [FRASE_1, FRASE_2, FRASE_3];
      let anteriores = 0;
      for (let i = 0; i < frases.length; i += 1) {
        const r = await enviar(c.id, frases[i], `envio-d${i}-f4883`);
        ok(`D${i + 1}  a mensagem ${i + 1} e aceita e respondida`,
          r.status === 200 && r.corpo.resposta !== null,
          `${r.status} ${String(r.corpo.motivo)}`);
        const agora = await contarMensagens(c.id);
        ok(`D${i + 1}a e as anteriores continuam`, agora === anteriores + 2,
          `${anteriores} -> ${agora}`);
        anteriores = agora;
      }
      const final = await lerConversa(c.id);
      const msgs = (final.corpo.mensagens ?? []) as { conteudo?: string }[];
      ok("D4  a conversa tem os TRES pares, na ordem",
        msgs.length === 6 && msgs[0]?.conteudo === FRASE_1 &&
          msgs[2]?.conteudo === FRASE_2 && msgs[4]?.conteudo === FRASE_3,
        String(msgs.length));
    }

    // ═══ E. Sem `envioId`, nada muda ════════════════════════════════

    secao("E. Envio sem identidade continua funcionando");
    {
      const c = await portaC.criarConversa(DONO, AGENTE, null);
      const r = await enviar(c.id, "diga apenas ok");
      ok("E1  responde 200 sem `envioId`", r.status === 200, String(r.status));
      ok("E2  com resposta", r.corpo.resposta !== null);
      ok("E3  e nao se diz reconciliado", r.corpo.reconciliado !== true);
      ok("E4  duas mensagens", await contarMensagens(c.id) === 2,
        String(await contarMensagens(c.id)));

      // Dois envios sem id NAO se confundem: cada um e um turno.
      await enviar(c.id, "diga apenas ok");
      ok("E5  e um segundo envio sem id roda de novo, como antes",
        await contarMensagens(c.id) === 4, String(await contarMensagens(c.id)));
    }

    // ═══ F. O banco, e nao a boa vontade, garante um turno por envio ══

    secao("F. A garantia e do indice, nao do codigo");
    {
      const c = await portaC.criarConversa(DONO, AGENTE, null);
      const envioF = "envio-f-f4883";
      await portaC.anexarMensagem({
        userId: DONO, conversaId: c.id, papel: "usuario",
        conteudo: "primeira", envioId: envioF,
      });
      // Duas linhas com o MESMO envio devem ser recusadas pelo banco. E por
      // isso que a resposta do agente nao pode carregar o envio — e por isso
      // que `lerTurnoDoEnvio` a encontra pela ordem.
      let recusou = false;
      try {
        await portaC.anexarMensagem({
          userId: DONO, conversaId: c.id, papel: "usuario",
          conteudo: "segunda", envioId: envioF,
        });
      } catch { recusou = true; }
      ok("F1  §30: o indice unico RECUSA um segundo registro do mesmo envio",
        recusou && await contarMensagens(c.id) === 1,
        `recusou=${recusou} n=${await contarMensagens(c.id)}`);

      // CONTROLE: sem envio, duas linhas convivem — o indice e parcial.
      const d = await portaC.criarConversa(DONO, AGENTE, null);
      await portaC.anexarMensagem({
        userId: DONO, conversaId: d.id, papel: "usuario", conteudo: "a" });
      await portaC.anexarMensagem({
        userId: DONO, conversaId: d.id, papel: "usuario", conteudo: "b" });
      ok("F2  CONTROLE: sem envio o indice nao atrapalha — ele e parcial",
        await contarMensagens(d.id) === 2, String(await contarMensagens(d.id)));

      // CONTROLE: o mesmo envio em OUTRA conversa nao colide.
      const e = await portaC.criarConversa(DONO, AGENTE, null);
      let outraOk = true;
      try {
        await portaC.anexarMensagem({
          userId: DONO, conversaId: e.id, papel: "usuario",
          conteudo: "outra", envioId: envioF });
      } catch { outraOk = false; }
      ok("F3  CONTROLE: o escopo e a conversa, nao o envio sozinho", outraOk);
    }

    // ═══ G. Dois pedidos do MESMO envio, ao mesmo tempo ══════════════

    secao("G. A corrida — §30 sob simultaneidade");
    {
      // `lerTurnoDoEnvio` acontece ANTES da gravacao, e entre as duas cabe
      // o outro pedido. Aqui os dois partem juntos: qualquer que seja a
      // ordem, o resultado tem de ser UM turno e nenhuma frase de falha.
      const c = await portaC.criarConversa(DONO, AGENTE, null);
      const envioG = "envio-g-f4883";
      const [a, b] = await Promise.all([
        enviar(c.id, "diga apenas ok", envioG),
        enviar(c.id, "diga apenas ok", envioG),
      ]);
      ok("G1  os DOIS pedidos respondem sem erro",
        (a.status === 200 || a.status === 202) &&
          (b.status === 200 || b.status === 202),
        `${a.status} / ${b.status}`);
      ok("G2  §30: e existe UM turno, nao dois",
        await contarMensagens(c.id) <= 2, String(await contarMensagens(c.id)));
      ok("G2a e o turno existe de fato — nao e vazio",
        await contarMensagens(c.id) >= 1, String(await contarMensagens(c.id)));
      // Exatamente um dos dois pode ter rodado o modelo; o outro tem de
      // ter reconciliado ou dito "em andamento". O que nao pode e os dois
      // se declararem donos do turno novo.
      const novos = [a, b].filter((r) =>
        r.corpo.reconciliado !== true && r.corpo.emAndamento !== true).length;
      ok("G3  no maximo um dos dois se declara turno novo", novos <= 1,
        String(novos));
      ok("G4  e nenhum dos dois devolve erro de gravacao",
        a.corpo.erro === undefined && b.corpo.erro === undefined,
        `${String(a.corpo.erro)} / ${String(b.corpo.erro)}`);
    }

  } catch (erro) {
    fail += 1;
    console.log(`  ERRO  ${erro instanceof Error ? erro.message : String(erro)}`);
  } finally {
    secao("Limpeza");
    await limpar(db);
    const { count } = await db.from("agente_conversas")
      .select("id", { count: "exact", head: true }).eq("user_id", DONO);
    ok("Z1  nenhuma conversa fixture sobrou", (count ?? 0) === 0, String(count));
    console.log(`\nPASS ${pass}   FAIL ${fail}`);
    process.exit(fail === 0 ? 0 : 1);
  }
}

void main();
