/**
 * AGENT-FACTORY-F7b.4.6 — o agente cresce pelo proprio chat.
 *
 * LIVE: provider real, guard real, banco real, catalogo real, e a ROTA
 * real com cookie de sessao assinado.
 *
 * ── O cenario ───────────────────────────────────────────────────────
 *
 *   agente SEM Planilhas
 *   usuario: "Analise a planilha de vendas que enviei."
 *     -> a CDS detecta a falta e oferece opcoes REAIS
 *   usuario clica Ativar
 *     -> binding criado, leitura em `automatico`
 *     -> a TAREFA ORIGINAL continua, sem a pergunta ser repetida
 *
 * ── Os controles que fazem disso prova ──────────────────────────────
 *
 *   agente que JA TEM Planilhas   -> nenhuma oferta (senao seria ruido)
 *   mensagem sem nada a ver       -> nenhuma oferta
 *   dois cliques                  -> um binding so
 *   outro dono                    -> 404
 *
 * Sem o primeiro controle, um detector que oferece sempre passaria.
 *
 * Roda com: npx tsx scripts/testar-capacidade-inline-live.ts
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

const DONO = "c7b00000-f746-4000-8000-0000000000d0";
const INTRUSO = "c7b00000-f746-4000-8000-0000000000d1";
const AGENTE = "c7b00000-0000-4000-8000-000000000060";
const AGENTE_COM_PLANILHAS = "c7b00000-0000-4000-8000-000000000061";
const AGENTE_INTRUSO = "c7b00000-0000-4000-8000-000000000062";

const PEDIDO = "Analise a planilha de vendas em Excel que eu enviei e some a coluna de valores.";

let passou = 0;
let falhou = 0;
function ok(nome: string, cond: boolean, detalhe = ""): void {
  if (cond) { passou++; console.log(`  PASS  ${nome}`); }
  else { falhou++; console.log(`  FAIL  ${nome}${detalhe ? ` — ${detalhe}` : ""}`); }
}
function secao(t: string): void { console.log(`\n${t}`); }

async function limpar(db: SupabaseClient): Promise<void> {
  for (const dono of [DONO, INTRUSO]) {
    await db.from("agente_capacidades_pendentes").delete().eq("user_id", dono);
    await db.from("agente_conversas").delete().eq("user_id", dono);
    await db.from("agente_permissoes").delete().eq("user_id", dono);
    await db.from("agente_ferramentas_externas").delete().eq("user_id", dono);
    await db.from("agentes").update({ ativo: false }).eq("user_id", dono);
  }
}

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const chaveDb = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !chaveDb) { console.error("ERRO: env do Supabase ausente."); process.exit(1); }
  if (!process.env.ANTHROPIC_API_KEY || !process.env.ANTHROPIC_MODEL_AGENTE) {
    console.error("ERRO: env da Anthropic ausente."); process.exit(1);
  }
  const db = createClient(url, chaveDb);

  const { responderNaConversa } = await import("../lib/agentes/conversas/runtime");
  const { criarPortaDeConversas } = await import("../lib/agentes/conversas/repositorio");
  const { emitirTokenSessao, COOKIE_SESSAO } = await import("../lib/autenticacao");
  const { detectarCapacidadeFaltante } = await import(
    "../lib/agentes/factory/capacidade-faltante");
  const { lerPendenciaVivaDaConversa } = await import(
    "../lib/agentes/factory/capacidade-pendente");
  const rota = await import("../app/api/agentes/[agenteId]/capacidades/[pendenciaId]/route");

  const portaC = criarPortaDeConversas(db);
  const cookieDe = async (uid: string) =>
    `${COOKIE_SESSAO}=${(await emitirTokenSessao(uid)).token}`;

  async function decidir(
    cookie: string | undefined, agenteId: string, pendenciaId: string,
    acao: "ativar" | "recusar", escolha?: string
  ) {
    const req = new Request(
      `http://local/api/agentes/${agenteId}/capacidades/${pendenciaId}`,
      {
        method: "PATCH",
        headers: {
          ...(cookie ? { cookie } : {}), "Content-Type": "application/json",
        },
        body: JSON.stringify(escolha === undefined ? { acao } : { acao, escolha }),
      }
    );
    const r = await rota.PATCH(req, { params: { agenteId, pendenciaId } });
    let corpo: Record<string, unknown> = {};
    try { corpo = await r.json() as Record<string, unknown>; } catch { /* vazio */ }
    return { status: r.status, corpo };
  }

  const contarPermissoes = async (agenteId: string): Promise<number> =>
    (await db.from("agente_permissoes")
      .select("funcao_id", { count: "exact", head: true })
      .eq("user_id", DONO).eq("agente_id", agenteId)).count ?? 0;

  console.log("\n== F7b.4.6 — o agente cresce pelo chat ==");

  try {
    await limpar(db);
    for (const [id, dono] of [
      [AGENTE, DONO], [AGENTE_COM_PLANILHAS, DONO], [AGENTE_INTRUSO, INTRUSO],
    ] as const) {
      await db.from("agentes").upsert({
        id, user_id: dono, nome: "ZZ FIXTURE capacidade f746",
        tipo: "personalizado", ativo: false,
        instrucoes: "Voce ajuda com analise de dados. Responda de forma curta.",
      }, { onConflict: "id" });
    }
    // O agente de CONTROLE ja tem Planilhas.
    for (const f of ["planilha.inspecionar", "planilha.ler", "planilha.agregar"]) {
      await db.from("agente_permissoes").upsert({
        agente_id: AGENTE_COM_PLANILHAS, user_id: DONO, funcao_id: f,
        nivel: "automatico", alterado_em: new Date().toISOString(),
      }, { onConflict: "agente_id,funcao_id" });
    }

    // ═══ A. O resolvedor, sem rede de conversa ══════════════════════

    secao("A. A CDS resolve os candidatos do catalogo REAL (§2/§17)");
    {
      const falta = await detectarCapacidadeFaltante({
        texto: PEDIDO, nomesQueJaTem: [],
      });
      ok("A1  a falta e detectada", falta.desfecho === "falta_capacidade",
        falta.desfecho);
      if (falta.desfecho === "falta_capacidade") {
        console.log(`  opcoes: ${falta.opcoes.map((o) => o.nome).join(" · ")}`);
        ok("A2  a necessidade tem NOME DE GENTE", falta.necessidade === "Planilhas",
          falta.necessidade);
        ok("A3  e Planilhas esta entre as opcoes",
          falta.opcoes.some((o) => o.nome === "Planilhas"));
        ok("A4  NENHUMA opcao mostra id interno",
          falta.opcoes.every((o) => !/[a-z]+\.[a-z_]+/.test(o.nome)),
          falta.opcoes.map((o) => o.nome).join(","));
        // §5: havendo alternativa externa real, ela aparece — e a escolha
        // e da pessoa. A CDS nao escolhe servico externo sozinha.
        console.log(`  origens: ${[...new Set(falta.opcoes.map((o) => o.origem))].join(",")}`);
      }

      // O CONTROLE que faz disto prova: quem JA TEM nao recebe oferta.
      //
      // A mensagem cita UMA capacidade so. `PEDIDO` fala de planilha E de
      // vendas, entao com Planilhas ja presente ele continua faltando
      // Vendas — e o controle mediria outra coisa. O teste pegou isso.
      const SO_PLANILHA = "Leia o arquivo Excel que enviei e me diga quantas abas tem.";
      const jaTem = await detectarCapacidadeFaltante({
        texto: SO_PLANILHA, nomesQueJaTem: ["Planilhas"],
      });
      ok("A5  CONTROLE: agente que JA TEM nao recebe oferta",
        jaTem.desfecho === "nada_falta", jaTem.desfecho);
      // ANCORA: a MESMA mensagem, sem a capacidade, oferece. Sem isto, A5
      // passaria com um detector que nunca detecta nada.
      ok("A5a ANCORA: a mesma mensagem SEM a capacidade oferece",
        (await detectarCapacidadeFaltante({ texto: SO_PLANILHA, nomesQueJaTem: [] }))
          .desfecho === "falta_capacidade");
      // E uma mensagem com DUAS necessidades oferece UMA de cada vez.
      const duas = await detectarCapacidadeFaltante({
        texto: PEDIDO, nomesQueJaTem: ["Planilhas"],
      });
      ok("A5b com Planilhas presente, a oferta passa a ser a OUTRA",
        duas.desfecho === "falta_capacidade" && duas.necessidade !== "Planilhas",
        duas.desfecho === "falta_capacidade" ? duas.necessidade : duas.desfecho);

      const semRelacao = await detectarCapacidadeFaltante({
        texto: "Bom dia, tudo bem com voce?", nomesQueJaTem: [],
      });
      ok("A6  CONTROLE: mensagem sem necessidade nao oferece nada",
        semRelacao.desfecho === "nada_falta", semRelacao.desfecho);
    }

    // ═══ B. Pelo runtime: o turno responde E oferece ════════════════

    secao("B. O turno acontece, e a oferta vem junto (§3)");
    const conversa = await portaC.criarConversa(DONO, AGENTE, "Falta capacidade");
    let pendenciaId = "";
    {
      const r = await responderNaConversa(
        { userId: DONO, agenteId: AGENTE, conversaId: conversa.id, texto: PEDIDO },
        portaC
      );
      ok("B1  o turno concluiu normalmente", r.ok === true, r.ok ? "" : `${r.codigo}`);
      if (!r.ok) throw new Error("turno falhou");
      console.log(`  resposta: ${(r.resposta.conteudo ?? "").slice(0, 130)}`);

      ok("B2  e a pendencia de capacidade foi aberta",
        r.capacidadePendente !== undefined,
        JSON.stringify(r.capacidadePendente));
      pendenciaId = r.capacidadePendente?.id ?? "";
      ok("B3  com a necessidade em nome de gente",
        r.capacidadePendente?.necessidade === "Planilhas",
        String(r.capacidadePendente?.necessidade));

      // §3: a oferta NAO substitui a resposta. O agente falou.
      ok("B4  a resposta do agente existe — a oferta nao a substituiu",
        (r.resposta.conteudo ?? "").length > 10);

      // §28: a pendencia sobrevive a um refresh.
      const viva = await lerPendenciaVivaDaConversa({
        userId: DONO, conversaId: conversa.id,
      });
      ok("B5  e ela e reencontravel pela conversa (§28)",
        viva.leitura === "ok" && viva.pendencia?.id === pendenciaId);
      ok("B6  com o OBJETIVO original congelado (§10)",
        viva.leitura === "ok" && (viva.pendencia?.objetivo ?? "").includes("planilha"),
        viva.leitura === "ok" ? (viva.pendencia?.objetivo ?? "").slice(0, 60) : "");
    }

    // O agente NAO tem Planilhas antes do clique.
    const antesDoClique = await contarPermissoes(AGENTE);
    ok("B7  o agente ainda NAO tem permissao nenhuma", antesDoClique === 0,
      String(antesDoClique));

    // ═══ C. Isolamento, ANTES de ativar ════════════════════════════

    secao("C. So o dono do agente decide (§29)");
    {
      ok("C1  sem sessao: 401",
        (await decidir(undefined, AGENTE, pendenciaId, "ativar")).status === 401);
      ok("C2  cookie forjado: 401",
        (await decidir(`${COOKIE_SESSAO}=x`, AGENTE, pendenciaId, "ativar")).status === 401);
      const intruso = await decidir(
        await cookieDe(INTRUSO), AGENTE_INTRUSO, pendenciaId, "ativar");
      ok("C3  outro dono: 404", intruso.status === 404, String(intruso.status));
      ok("C4  e nada foi ativado", (await contarPermissoes(AGENTE)) === 0);
    }

    // ═══ D. Ativar, e CONTINUAR A TAREFA ═══════════════════════════

    secao("D. Ativar continua o pedido original (§9)");
    const cookie = await cookieDe(DONO);
    const antesDeAtivar = await portaC.listarMensagens(DONO, conversa.id);
    {
      const r = await decidir(cookie, AGENTE, pendenciaId, "ativar", "planilhas");
      ok("D1  a rota aceitou", r.status === 200,
        `${r.status} ${JSON.stringify(r.corpo).slice(0, 140)}`);
      ok("D2  e diz o que foi ativado, com nome de gente",
        r.corpo.ativada === "Planilhas", String(r.corpo.ativada));

      // §6/§19: leitura entra em `automatico`, usavel na hora.
      const { data: perms } = await db.from("agente_permissoes")
        .select("funcao_id, nivel").eq("user_id", DONO).eq("agente_id", AGENTE);
      const linhas = (perms ?? []) as { funcao_id: string; nivel: string }[];
      ok("D3  as Funcoes do pack foram vinculadas", linhas.length === 3,
        `${linhas.length}`);
      ok("D4  e TODAS em `automatico` — leitura nao pede aprovacao (§19)",
        linhas.every((l) => l.nivel === "automatico"),
        linhas.map((l) => `${l.funcao_id}=${l.nivel}`).join(", "));

      // §9: a TAREFA continuou.
      ok("D5  a tarefa original foi RETOMADA", r.corpo.retomada === true,
        String(r.corpo.retomada));
      const msg = r.corpo.mensagem as { conteudo?: string } | undefined;
      console.log(`  resposta: ${(msg?.conteudo ?? "").slice(0, 130)}`);
      ok("D6  com uma resposta nova do agente",
        (msg?.conteudo ?? "").length > 10);

      // §23: o historico continua.
      const depois = await portaC.listarMensagens(DONO, conversa.id);
      ok("D7  as mensagens anteriores continuam la (§23)",
        antesDeAtivar.every((m) => depois.some((d) => d.id === m.id)),
        `${antesDeAtivar.length} -> ${depois.length}`);
      ok("D8  e a conversa e a MESMA", r.corpo.conversaId === conversa.id);

      // §9: o usuario nao digitou de novo. A mensagem retomada e o
      // objetivo congelado, e nao algo que ele reescreveu.
      const doUsuario = depois.filter((m) => m.papel === "usuario");
      ok("D9  o texto retomado e o objetivo ORIGINAL, sem reescrita",
        doUsuario[doUsuario.length - 1]?.conteudo === PEDIDO,
        (doUsuario[doUsuario.length - 1]?.conteudo ?? "").slice(0, 60));

      // §28: a pendencia ORIGINAL nao reaparece.
      //
      // Cobrar "nenhuma pendencia viva" seria errado, e o teste mostrou
      // por que: o pedido cita planilha E vendas, entao ao retomar a
      // tarefa a CDS detecta a SEGUNDA necessidade e oferece Vendas. Isso
      // e o comportamento certo — uma capacidade de cada vez —, e o que
      // precisa ser verdade e que a de Planilhas foi concluida.
      const { data: original } = await db.from("agente_capacidades_pendentes")
        .select("estado").eq("id", pendenciaId).single();
      ok("D10 a pendencia ORIGINAL foi concluida",
        (original as { estado?: string } | null)?.estado === "concluida",
        String((original as { estado?: string } | null)?.estado));
      const viva = await lerPendenciaVivaDaConversa({
        userId: DONO, conversaId: conversa.id,
      });
      ok("D11 e se houver outra viva, ela e para OUTRA necessidade",
        viva.leitura === "ok" &&
          (viva.pendencia === null || viva.pendencia.necessidade !== "Planilhas"),
        viva.leitura === "ok" ? String(viva.pendencia?.necessidade) : viva.leitura);
    }

    // ═══ E. Idempotencia ═══════════════════════════════════════════

    secao("E. Dois cliques nao criam dois bindings (§11)");
    {
      const antes = await contarPermissoes(AGENTE);
      const r2 = await decidir(cookie, AGENTE, pendenciaId, "ativar", "planilhas");
      ok("E1  o segundo clique responde de forma controlada",
        r2.status === 200 || r2.status === 404, String(r2.status));
      const depois = await contarPermissoes(AGENTE);
      ok("E2  e o numero de permissoes NAO mudou", depois === antes,
        `${antes} -> ${depois}`);
    }

    // ═══ F. Persistencia ═══════════════════════════════════════════

    secao("F. A capacidade fica no agente (§8)");
    {
      const nova = await portaC.criarConversa(DONO, AGENTE, "Conversa nova");
      // Um pedido que cita SO planilha: se Planilhas ficou mesmo no
      // agente, nao ha nada a oferecer. O pedido original citava vendas
      // tambem, e ai a oferta seria de outra capacidade — o que
      // confundiria a pergunta que esta secao faz.
      const r = await responderNaConversa(
        {
          userId: DONO, agenteId: AGENTE, conversaId: nova.id,
          texto: "Leia o arquivo Excel que enviei e me diga quantas abas ele tem.",
        },
        portaC
      );
      ok("F1  numa conversa NOVA o turno acontece", r.ok === true);
      ok("F2  e NAO ha oferta de Planilhas — o agente ja tem (§8)",
        r.ok && r.capacidadePendente === undefined,
        JSON.stringify(r.ok ? r.capacidadePendente : null));

      // E a permissao continua la, que e o que "ficar" significa.
      ok("F3  as permissoes do pack continuam gravadas",
        (await contarPermissoes(AGENTE)) === 3,
        String(await contarPermissoes(AGENTE)));
    }

    // ═══ G. Recusar ════════════════════════════════════════════════

    secao("G. `Agora nao` mantem a conversa (§16)");
    {
      const c = await portaC.criarConversa(DONO, AGENTE_COM_PLANILHAS, "Recusa");
      // Este agente TEM Planilhas, entao peco outra coisa para faltar.
      const r = await responderNaConversa(
        {
          userId: DONO, agenteId: AGENTE_COM_PLANILHAS, conversaId: c.id,
          texto: "Quanto eu vendi hoje no Mercado Livre?",
        },
        portaC
      );
      ok("G1  a falta de Vendas e detectada",
        r.ok && r.capacidadePendente !== undefined,
        JSON.stringify(r.ok ? r.capacidadePendente : null));

      const id = r.ok ? (r.capacidadePendente?.id ?? "") : "";
      if (id !== "") {
        const antes = await portaC.listarMensagens(DONO, c.id);
        const neg = await decidir(cookie, AGENTE_COM_PLANILHAS, id, "recusar");
        ok("G2  recusar responde 200", neg.status === 200, String(neg.status));
        const depois = await portaC.listarMensagens(DONO, c.id);
        ok("G3  e a conversa continua intacta",
          antes.every((m) => depois.some((d) => d.id === m.id)));
        const viva = await lerPendenciaVivaDaConversa({ userId: DONO, conversaId: c.id });
        ok("G4  a pendencia recusada nao reaparece",
          viva.leitura === "ok" && viva.pendencia === null);
        // §16: nao insistir.
        const r2 = await responderNaConversa(
          {
            userId: DONO, agenteId: AGENTE_COM_PLANILHAS, conversaId: c.id,
            texto: "E entao?",
          },
          portaC
        );
        ok("G5  e a CDS nao insiste no turno seguinte",
          r2.ok && r2.capacidadePendente === undefined);
      }
    }

  } finally {
    secao("Limpeza");
    await limpar(db);
    const { count: pend } = await db.from("agente_capacidades_pendentes")
      .select("id", { count: "exact", head: true }).eq("user_id", DONO);
    const { count: conv } = await db.from("agente_conversas")
      .select("id", { count: "exact", head: true }).eq("user_id", DONO);
    ok("Z1  nenhuma pendencia sobrou", (pend ?? 0) === 0, String(pend));
    ok("Z2  nenhuma conversa sobrou", (conv ?? 0) === 0, String(conv));
  }

  console.log(`\nPASS ${passou}   FAIL ${falhou}`);
  process.exit(falhou === 0 ? 0 : 1);
}

void main();
