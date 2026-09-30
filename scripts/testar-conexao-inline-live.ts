/**
 * AGENT-FACTORY-F7b.4.7 — completar a capacidade sem sair do chat.
 *
 * LIVE: banco real, catalogo e conexao Composio reais, ROTAS reais com
 * cookie de sessao assinado, provider real na retomada.
 *
 * ── Os dois mundos, que o §11 manda nao confundir ───────────────────
 *
 *   INTEGRACAO EXTERNA  falta CONTA -> OAuth no provedor
 *   NATIVA (ML/Shopee)  a conta talvez exista -> falta escolher a LOJA
 *
 * ── O que esta suite NAO faz ────────────────────────────────────────
 *
 * Nao conclui OAuth real (§15/§27): nenhum Google e conectado. O que se
 * prova e o link, o estado de retorno, a propriedade e a idempotencia — e
 * a retomada e provada pelo caminho NATIVO, onde a "conexao" e uma loja
 * fixture e portanto verificavel de verdade.
 *
 * Nenhuma credencial real do Rodrigo. As lojas sao fixture sintetica.
 *
 * Roda com: npx tsx scripts/testar-conexao-inline-live.ts
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

const DONO = "c7b00000-f747-4000-8000-0000000000d0";
const INTRUSO = "c7b00000-f747-4000-8000-0000000000d1";
/** Pede integracao externa (Google Sheets). */
const AGENTE_EXT = "c7b00000-0000-4000-8000-000000000070";
/** Pede capacidade nativa (Vendas / Mercado Livre). */
const AGENTE_ML = "c7b00000-0000-4000-8000-000000000071";
const AGENTE_INTRUSO = "c7b00000-0000-4000-8000-000000000072";

const LOJA_A = "c7b00000-f747-4000-8000-0000000a0001";
const LOJA_B = "c7b00000-f747-4000-8000-0000000a0002";

/**
 * O pedido que de fato EXIGE conexao.
 *
 * "Consultar minhas vendas" NAO exige: o pack `vendas` le `pedidos`, que o
 * sync da CDS ja preencheu — descoberto por este teste, e registrado em
 * `completar-capacidade.ts`. Quem fala com a API do Mercado Livre e o pack
 * de PERGUNTAS, e e ele que precisa de loja vinculada.
 */
const PEDIDO_ML = "Me mostre as perguntas dos compradores que estao sem resposta.";
const PEDIDO_EXT = "Leia a spreadsheet da minha conta Google e me diga o total.";

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
    await db.from("agente_conexoes").delete().eq("user_id", dono);
    await db.from("agente_conversas").delete().eq("user_id", dono);
    await db.from("agente_permissoes").delete().eq("user_id", dono);
    await db.from("agente_ferramentas_externas").delete().eq("user_id", dono);
    // ── MEDIDO: a loja fixture pode NAO sair, e esta certo ──────────
    //
    // `agente_funcao_chamadas.loja_id` referencia `lojas` com ON DELETE
    // RESTRICT, e essa tabela e append-only por decisao: auditoria que se
    // apaga nao e auditoria. Uma execucao real do turno retomado grava a
    // chamada com a loja, e o DELETE passa a ser impossivel.
    //
    // O precedente ja existe para os agentes fixture: o que nao se apaga
    // fica INERTE. Loja inativa e sem token nao autentica, nao sincroniza e
    // nao aparece como elegivel — `listarLojasConectadasDoDono` exige
    // `ativo = true` e `access_token not null`.
    await db.from("lojas").delete().eq("user_id", dono);
    await db.from("lojas").update({ ativo: false, access_token: null })
      .eq("user_id", dono);
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
  const { faltaParaCompletar, requisitosDeConexaoDoPack } = await import(
    "../lib/agentes/factory/completar-capacidade");
  const {
    abrirCapacidadePendente, lerPendenciaVivaDaConversa, moverPendencia,
  } = await import("../lib/agentes/factory/capacidade-pendente");
  const { MARKETPLACE_POR_PLATAFORMA } = await import(
    "../lib/agentes/conexoes/estado");
  const { listarContasDoDono } = await import("../lib/agentes/composio/conexao");
  const rotaCap = await import("../app/api/agentes/[agenteId]/capacidades/[pendenciaId]/route");
  const rotaCon = await import(
    "../app/api/agentes/[agenteId]/capacidades/[pendenciaId]/conexao/route");

  /**
   * O valor que `lojas.marketplace` realmente guarda.
   *
   * ── Por que isto NAO e uma constante escrita a mao ─────────────────
   *
   * Era. A fixture inseria `marketplace: "mercado_livre"` e a suite passava
   * 51/0 — enquanto `faltaParaCompletar` consultava `lojas` com o MESMO
   * slug errado. Oraculo e codigo erravam juntos, e o teste concordava com
   * o defeito em vez de encontra-lo.
   *
   * MEDIDO no banco: `lojas.marketplace` guarda "ML" e "Shopee". Com uma
   * loja real, o fluxo pediria ao dono para conectar um Mercado Livre que
   * ele ja conectou — o oposto do §13.
   *
   * Agora a fixture le o mapa canonico. Se alguem trocar o valor de um dos
   * lados, os dois mudam juntos — e `M0` abaixo prova que o valor nao e o
   * slug, que era o erro concreto.
   */
  const MKT_ML = MARKETPLACE_POR_PLATAFORMA["mercado_livre"] as string;

  const portaC = criarPortaDeConversas(db);
  const cookieDe = async (uid: string) =>
    `${COOKIE_SESSAO}=${(await emitirTokenSessao(uid)).token}`;

  function req(agenteId: string, pendenciaId: string, corpo?: unknown, cookie?: string) {
    return new Request(
      `http://local/api/agentes/${agenteId}/capacidades/${pendenciaId}/conexao`,
      {
        method: corpo === undefined ? "POST" : "PATCH",
        headers: {
          ...(cookie ? { cookie } : {}), "Content-Type": "application/json",
        },
        ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
      }
    );
  }
  async function ler(r: Response) {
    let corpo: Record<string, unknown> = {};
    try { corpo = await r.json() as Record<string, unknown>; } catch { /* vazio */ }
    return { status: r.status, corpo };
  }
  const gerarLink = async (cookie: string | undefined, a: string, p: string) =>
    ler(await rotaCon.POST(req(a, p, undefined, cookie), { params: { agenteId: a, pendenciaId: p } }));
  const conexao = async (
    cookie: string | undefined, a: string, p: string, corpo: unknown
  ) => ler(await rotaCon.PATCH(req(a, p, corpo, cookie), { params: { agenteId: a, pendenciaId: p } }));
  const ativar = async (cookie: string, a: string, p: string, escolha?: string) => {
    const r = await rotaCap.PATCH(
      new Request(`http://local/api/agentes/${a}/capacidades/${p}`, {
        method: "PATCH",
        headers: { cookie, "Content-Type": "application/json" },
        body: JSON.stringify(escolha === undefined ? { acao: "ativar" } : { acao: "ativar", escolha }),
      }),
      { params: { agenteId: a, pendenciaId: p } }
    );
    return ler(r);
  };

  console.log("\n== F7b.4.7 — conexao inline e retomada ==");

  try {
    await limpar(db);
    for (const [id, dono] of [
      [AGENTE_EXT, DONO], [AGENTE_ML, DONO], [AGENTE_INTRUSO, INTRUSO],
    ] as const) {
      await db.from("agentes").upsert({
        id, user_id: dono, nome: "ZZ FIXTURE conexao f747",
        tipo: "personalizado", ativo: false,
        instrucoes: "Voce ajuda com vendas e dados. Responda de forma curta.",
      }, { onConflict: "id" });
    }
    const cookie = await cookieDe(DONO);

    // ═══ A. A classificacao dos dois mundos (§11) ═══════════════════

    secao("A. Integracao externa e capacidade nativa nao se confundem");
    {
      // Pack sem conexao: nada falta.
      ok("A1  pack sem conexao: nada falta",
        (await faltaParaCompletar({ userId: DONO, chave: "planilhas", origem: "cds" }))
          .falta === "nada");

      // `vendas` NAO exige conexao: ele le os pedidos que o sync ja
      // trouxe. Este foi um achado do teste, e a assercao registra o fato.
      ok("A1a `vendas` NAO exige conexao — o sync da CDS ja trouxe os pedidos",
        (await faltaParaCompletar({ userId: DONO, chave: "vendas", origem: "cds" }))
          .falta === "nada");

      // Pack NATIVO sem loja: pede CONECTAR o marketplace, e nao o Composio.
      const semLoja = await faltaParaCompletar({
        userId: DONO, chave: "mercadolivre-perguntas", origem: "cds",
      });
      ok("A2  pack nativo sem loja: pede conectar o MARKETPLACE",
        semLoja.falta === "conectar_marketplace", semLoja.falta);
      ok("A3  e com o nome que o dono conhece",
        semLoja.falta === "conectar_marketplace" &&
          semLoja.nomeDoMarketplace === "Mercado Livre",
        semLoja.falta === "conectar_marketplace" ? semLoja.nomeDoMarketplace : "");

      // ── Controle ANTI-VACUIDADE do proprio oraculo ──────────────
      //
      // A fixture tem de inserir o valor que o app CONSULTA. Enquanto os
      // dois eram `mercado_livre`, tudo passava e nada funcionava.
      // Duas assercoes, e nao uma com `&&`: dentro do `&&` o TypeScript
      // estreita `MKT_ML` para "ML" e a segunda metade viraria comparacao
      // impossivel — uma assercao que o compilador sabe ser constante nao
      // prova nada em tempo de execucao.
      ok("A1b o valor do banco e o que a autoridade canonica diz",
        MKT_ML === "ML", MKT_ML);
      ok("A1c e NENHUM valor do mapa e o slug — era esse o defeito",
        !Object.values(MARKETPLACE_POR_PLATAFORMA).includes("mercado_livre"),
        Object.values(MARKETPLACE_POR_PLATAFORMA).join(","));

      // Os requisitos vem do REGISTRY.
      const reqs = requisitosDeConexaoDoPack("mercadolivre-perguntas");
      ok("A4  os requisitos do pack vem do registry", reqs.length >= 1,
        JSON.stringify(reqs));
      ok("A5  e o pack sem conexao nao declara requisito",
        requisitosDeConexaoDoPack("calculadora").length === 0);
    }

    // ═══ B. NATIVO: uma loja, e a escolha e explicita (§14) ═════════

    secao("B. Uma loja conectada: a CDS PERGUNTA, nao escolhe");
    {
      // `upsert`, e nao `insert`: a linha da execucao anterior pode ter
      // ficado (a auditoria a prende com RESTRICT). Reaproveitar e o que
      // torna a suite repetivel — `insert` quebraria por chave duplicada na
      // segunda vez, e o placar mediria a fixture, nao o produto.
      const { error } = await db.from("lojas").upsert({
        id: LOJA_A, user_id: DONO, marketplace: MKT_ML,
        nome: "Loja Fixture A", nickname: "FIXTUREA",
        seller_id: "999000111", ativo: true, access_token: "fixture-nao-e-token-real",
      }, { onConflict: "id" });
      ok("B1  loja fixture criada", error === null,
        error ? String(error.message).slice(0, 90) : "");

      const comUma = await faltaParaCompletar({
        userId: DONO, chave: "mercadolivre-perguntas", origem: "cds",
      });
      ok("B2  com UMA loja, falta ESCOLHER — nao conectar",
        comUma.falta === "escolher_loja", comUma.falta);
      ok("B3  e a loja aparece pelo NOME, nunca pelo seller_id",
        comUma.falta === "escolher_loja" &&
          comUma.lojas.length === 1 &&
          comUma.lojas[0].nome === "Loja Fixture A" &&
          !JSON.stringify(comUma.lojas).includes("999000111"),
        comUma.falta === "escolher_loja" ? JSON.stringify(comUma.lojas) : "");
    }

    // ═══ C. O fluxo completo NATIVO, pelo chat ══════════════════════

    secao("C. Pedir vendas -> ativar -> escolher loja -> TAREFA CONTINUA");
    const conversaML = await portaC.criarConversa(DONO, AGENTE_ML, "Vendas ML");
    let pendML = "";
    {
      const t = await responderNaConversa(
        { userId: DONO, agenteId: AGENTE_ML, conversaId: conversaML.id, texto: PEDIDO_ML },
        portaC
      );
      // A frase cita "perguntas" e NAO "Mercado Livre": o texto com as duas
      // palavras dispara `vendas` primeiro (ordem do catalogo), e o cartao
      // ofereceria Vendas. A rota recusou corretamente uma escolha fora das
      // opcoes congeladas — o teste estava ambiguo, nao o sistema.
      ok("C1  a falta de Perguntas do Mercado Livre e detectada",
        t.ok && t.capacidadePendente !== undefined,
        JSON.stringify(t.ok ? t.capacidadePendente : null));
      pendML = t.ok ? (t.capacidadePendente?.id ?? "") : "";

      const a = await ativar(cookie, AGENTE_ML, pendML, "mercadolivre-perguntas");
      ok("C2  ativar responde 200", a.status === 200,
        `${a.status} ${JSON.stringify(a.corpo).slice(0, 140)}`);
      // §13: JA existe conta -> a resposta pede LOJA, e nao OAuth.
      ok("C3  e pede ESCOLHER LOJA — nao manda autenticar de novo (§13)",
        a.corpo.escolherLoja !== undefined && a.corpo.precisaConectar === undefined,
        JSON.stringify(a.corpo).slice(0, 160));
      const esc = a.corpo.escolherLoja as { lojas?: { lojaId: string; nome: string }[] };
      ok("C4  com a loja pelo nome", (esc.lojas ?? []).some((l) => l.nome === "Loja Fixture A"));

      // §23: o cartao sobrevive ao refresh.
      const viva = await lerPendenciaVivaDaConversa({ userId: DONO, conversaId: conversaML.id });
      ok("C5  e a pendencia esta viva em `escolhendo_loja` (§23)",
        viva.leitura === "ok" && viva.pendencia?.estado === "escolhendo_loja",
        viva.leitura === "ok" ? String(viva.pendencia?.estado) : viva.leitura);

      // ── §31: outro dono nao escolhe loja alheia ──────────────────
      const intruso = await conexao(
        await cookieDe(INTRUSO), AGENTE_INTRUSO, pendML,
        { acao: "escolher_loja", lojaId: LOJA_A });
      ok("C6  outro dono: 404", intruso.status === 404, String(intruso.status));
      const semCookie = await conexao(
        undefined, AGENTE_ML, pendML, { acao: "escolher_loja", lojaId: LOJA_A });
      ok("C7  sem sessao: 401", semCookie.status === 401, String(semCookie.status));
      // Loja que nao e do dono: recusada.
      const lojaAlheia = await conexao(cookie, AGENTE_ML, pendML, {
        acao: "escolher_loja", lojaId: "c7b00000-0000-4000-8000-0000000000ff",
      });
      ok("C8  loja fora das do dono: 400", lojaAlheia.status === 400,
        String(lojaAlheia.status));

      // ── A escolha legitima, e a RETOMADA ────────────────────────
      const antes = await portaC.listarMensagens(DONO, conversaML.id);
      const e = await conexao(cookie, AGENTE_ML, pendML, {
        acao: "escolher_loja", lojaId: LOJA_A,
      });
      ok("C9  escolher a loja responde 200", e.status === 200,
        `${e.status} ${JSON.stringify(e.corpo).slice(0, 140)}`);
      ok("C10 e a TAREFA foi retomada (§7)", e.corpo.retomada === true,
        String(e.corpo.retomada));
      const msg = e.corpo.mensagem as { conteudo?: string } | undefined;
      console.log(`  resposta: ${(msg?.conteudo ?? "").slice(0, 120)}`);
      ok("C11 com resposta nova do agente", (msg?.conteudo ?? "").length > 10);

      // §32: USER_RESEND = 0.
      const depois = await portaC.listarMensagens(DONO, conversaML.id);
      ok("C12 as mensagens anteriores continuam (§26)",
        antes.every((m) => depois.some((d) => d.id === m.id)),
        `${antes.length} -> ${depois.length}`);
      const doUsuario = depois.filter((m) => m.papel === "usuario");
      ok("C13 e o texto retomado e o objetivo ORIGINAL (§32)",
        doUsuario[doUsuario.length - 1]?.conteudo === PEDIDO_ML,
        (doUsuario[doUsuario.length - 1]?.conteudo ?? "").slice(0, 60));

      // O binding foi gravado para TODOS os requisitos do pack.
      const { data: bind } = await db.from("agente_conexoes")
        .select("plataforma, recurso, loja_id")
        .eq("user_id", DONO).eq("agente_id", AGENTE_ML);
      const linhas = (bind ?? []) as { loja_id: string }[];
      ok("C14 o binding de loja foi gravado",
        linhas.length === requisitosDeConexaoDoPack("mercadolivre-perguntas").length &&
          linhas.length > 0,
        `${linhas.length}`);
      ok("C15 e aponta para a loja escolhida",
        linhas.every((l) => l.loja_id === LOJA_A));

      // §8: idempotencia — repetir nao retoma de novo.
      const repetido = await conexao(cookie, AGENTE_ML, pendML, {
        acao: "escolher_loja", lojaId: LOJA_A,
      });
      ok("C16 repetir responde de forma controlada",
        repetido.status === 200 || repetido.status === 409, String(repetido.status));
      const depois2 = await portaC.listarMensagens(DONO, conversaML.id);
      ok("C17 e NAO acrescenta outro par de mensagens (§8)",
        depois2.length === depois.length, `${depois.length} -> ${depois2.length}`);
    }

    // ═══ D. DUAS lojas: nao escolher sozinho (§30) ══════════════════

    secao("D. Duas lojas: a escolha e obrigatoriamente explicita");
    {
      await db.from("lojas").upsert({
        id: LOJA_B, user_id: DONO, marketplace: MKT_ML,
        nome: "Loja Fixture B", nickname: "FIXTUREB",
        seller_id: "999000222", ativo: true, access_token: "fixture-nao-e-token-real",
      }, { onConflict: "id" });
      const duas = await faltaParaCompletar({
        userId: DONO, chave: "mercadolivre-perguntas", origem: "cds",
      });
      ok("D1  com DUAS lojas continua sendo escolha",
        duas.falta === "escolher_loja", duas.falta);
      ok("D2  e as DUAS sao oferecidas — nenhuma e eleita sozinha",
        duas.falta === "escolher_loja" && duas.lojas.length === 2,
        duas.falta === "escolher_loja" ? `${duas.lojas.length}` : "");
      ok("D3  ANCORA: os nomes das duas aparecem",
        duas.falta === "escolher_loja" &&
          duas.lojas.some((l) => l.nome === "Loja Fixture A") &&
          duas.lojas.some((l) => l.nome === "Loja Fixture B"));
    }

    // ═══ E. EXTERNO: o link, e o que nao sai dele (§4/§27) ══════════

    secao("E. Integracao externa: link inline, sem segredo");
    {
      if (!process.env.COMPOSIO_API_KEY) {
        ok("E0  COMPOSIO_API_KEY presente", false, "ausente");
      } else {
        const conversaExt = await portaC.criarConversa(DONO, AGENTE_EXT, "Sheets");
        const t = await responderNaConversa(
          { userId: DONO, agenteId: AGENTE_EXT, conversaId: conversaExt.id, texto: PEDIDO_EXT },
          portaC
        );
        const pend = t.ok ? (t.capacidadePendente?.id ?? "") : "";
        ok("E1  a falta e detectada", pend !== "",
          JSON.stringify(t.ok ? t.capacidadePendente : null));

        // Escolhe a opcao EXTERNA (Google Sheets), se oferecida.
        const viva = await lerPendenciaVivaDaConversa({
          userId: DONO, conversaId: conversaExt.id,
        });
        const externa = viva.leitura === "ok"
          ? viva.pendencia?.opcoes.find((o) => o.origem === "integracao")
          : undefined;
        ok("E2  ha uma opcao EXTERNA no cartao", externa !== undefined,
          viva.leitura === "ok"
            ? viva.pendencia?.opcoes.map((o) => `${o.nome}(${o.origem})`).join(",")
            : "");

        if (externa !== undefined && pend !== "") {
          const a = await ativar(cookie, AGENTE_EXT, pend, externa.chave);
          ok("E3  ativar a integracao responde 200", a.status === 200,
            `${a.status} ${JSON.stringify(a.corpo).slice(0, 140)}`);
          ok("E4  e pede CONECTAR A CONTA (§3)",
            a.corpo.precisaConectar !== undefined,
            JSON.stringify(a.corpo).slice(0, 160));

          // §4: o link, gerado no chat.
          const link = await gerarLink(cookie, AGENTE_EXT, pend);
          ok("E5  o link e gerado pela rota do chat", link.status === 201,
            `${link.status} ${JSON.stringify(link.corpo).slice(0, 120)}`);
          const u = String(link.corpo.urlParaConectar ?? "");
          ok("E6  e aponta para o provedor de conexao",
            u.startsWith("https://") && new URL(u).host === "connect.composio.dev",
            u === "" ? "vazio" : new URL(u).host);

          // §4: NADA de segredo na resposta.
          const cru = JSON.stringify(link.corpo);
          ok("E7  a resposta NAO traz a COMPOSIO_API_KEY",
            !cru.includes(String(process.env.COMPOSIO_API_KEY)));
          ok("E8  nem `link_token`, nem token de acesso",
            !/link_token|access_?token|refresh_?token/i.test(cru));
          ok("E9  nem o user_id da CDS", !cru.includes(DONO));
          ok("E10 as chaves publicadas sao SO duas",
            JSON.stringify(Object.keys(link.corpo).filter((k) => k !== "ok").sort()) ===
              JSON.stringify(["expiraEm", "urlParaConectar"]),
            Object.keys(link.corpo).join(","));

          // §5/§23: o estado de retorno fica no SERVIDOR.
          const vivaDepois = await lerPendenciaVivaDaConversa({
            userId: DONO, conversaId: conversaExt.id,
          });
          ok("E11 a pendencia guarda o aplicativo e a conta a conferir (§5)",
            vivaDepois.leitura === "ok" &&
              vivaDepois.pendencia?.estado === "conectando" &&
              vivaDepois.pendencia?.conexaoToolkit === externa.chave &&
              (vivaDepois.pendencia?.conexaoContaId ?? "") !== "",
            vivaDepois.leitura === "ok"
              ? `${vivaDepois.pendencia?.estado}/${vivaDepois.pendencia?.conexaoToolkit}`
              : vivaDepois.leitura);
          ok("E12 e o objetivo original continua guardado (§7)",
            vivaDepois.leitura === "ok" &&
              (vivaDepois.pendencia?.objetivo ?? "").includes("spreadsheet"));

          // §9: sem OAuth concluido, verificar NAO inventa resultado.
          const v = await conexao(cookie, AGENTE_EXT, pend, { acao: "verificar" });
          ok("E13 verificar sem OAuth: `conectado: false`",
            v.status === 200 && v.corpo.conectado === false,
            `${v.status} ${JSON.stringify(v.corpo).slice(0, 120)}`);
          ok("E14 e a tarefa NAO foi concluida", v.corpo.retomada !== true);
          const aindaViva = await lerPendenciaVivaDaConversa({
            userId: DONO, conversaId: conversaExt.id,
          });
          ok("E15 a pendencia continua viva, esperando (§10)",
            aindaViva.leitura === "ok" && aindaViva.pendencia !== null);

          // §31: propriedade no link e na verificacao.
          ok("E16 outro dono nao gera link",
            (await gerarLink(await cookieDe(INTRUSO), AGENTE_INTRUSO, pend)).status === 404);
          ok("E17 nem verifica",
            (await conexao(await cookieDe(INTRUSO), AGENTE_INTRUSO, pend,
              { acao: "verificar" })).status === 404);

          // §9: desistir mantem a conversa.
          const r = await conexao(cookie, AGENTE_EXT, pend, { acao: "recusar" });
          ok("E18 recusar responde 200", r.status === 200, String(r.status));
          const semPend = await lerPendenciaVivaDaConversa({
            userId: DONO, conversaId: conversaExt.id,
          });
          ok("E19 e a pendencia sai do ar sem insistir (§16)",
            semPend.leitura === "ok" && semPend.pendencia === null);
        }
      }
    }


    // ═══ F. A retomada acontece UMA vez — §8/§15/§28 ════════════════

    secao("F. Conexao pronta -> a tarefa retoma UMA vez (caminho externo)");
    {
      // ── O que esta secao PODE e o que NAO PODE provar ────────────
      //
      // NAO PODE: concluir um OAuth real do Composio. Este gate proibe
      // conectar a conta real do Rodrigo e proibe fingir token, e sem uma
      // das duas coisas nao existe conta externa `conectada`. Entao o par
      // completo "conexao real pronta -> retomada" fica NAO PROVADO no
      // caminho externo, e o relatorio diz isso com essa palavra.
      //
      // PODE: provar o MECANISMO que decide se a tarefa retoma, e
      // prova-lo na pendencia EXTERNA. Toda retomada — nativa ou externa
      // — passa por `concluirERetomar`, cuja primeira linha e a
      // transicao para `concluida` a partir de um estado vivo. Quem
      // perde essa corrida recebe `ja_decidida` e NAO chama o modelo.
      //
      // Duas transicoes simultaneas medem exatamente essa garantia: sem
      // ela, dois retornos do provedor — ou dois refreshes da pagina do
      // callback — executariam a tarefa duas vezes.
      const conv = await portaC.criarConversa(DONO, AGENTE_EXT, "Retomada unica");
      const pend = await abrirCapacidadePendente({
        userId: DONO, agenteId: AGENTE_EXT, conversaId: conv.id,
        objetivo: PEDIDO_EXT, necessidade: "Planilhas",
        opcoes: [{
          chave: "googlesheets", origem: "integracao", nome: "Google Sheets",
          descricao: "Ler e escrever em planilhas.", exigeConexao: true,
        }],
      });
      ok("F1  pendencia EXTERNA aberta com o objetivo congelado",
        pend !== null && pend.objetivo === PEDIDO_EXT);

      if (pend !== null) {
        const escolheu = await moverPendencia({
          userId: DONO, pendenciaId: pend.id,
          de: ["pendente"], para: "aguardando_conexao",
          escolha: { chave: "googlesheets", origem: "integracao" },
          conexao: { toolkit: "googlesheets", contaId: null },
        });
        ok("F2  e ela chega a esperar a conexao", escolheu.estado === "ok",
          escolheu.estado);

        // As DUAS ao mesmo tempo, e nao uma depois da outra: em serie o
        // segundo `moverPendencia` acertaria mesmo com um WHERE frouxo,
        // porque o primeiro ja teria terminado.
        const VIVOS = ["aguardando_conexao", "conectando", "escolhendo_loja"];
        const [um, dois] = await Promise.all([
          moverPendencia({
            userId: DONO, pendenciaId: pend.id, de: VIVOS, para: "concluida",
          }),
          moverPendencia({
            userId: DONO, pendenciaId: pend.id, de: VIVOS, para: "concluida",
          }),
        ]);
        const venceram = [um, dois].filter((r) => r.estado === "ok").length;
        const perderam = [um, dois].filter((r) => r.estado === "ja_decidida").length;
        ok("F3  duas conclusoes simultaneas: EXATAMENTE uma vence",
          venceram === 1, `${um.estado} / ${dois.estado}`);
        ok("F4  e a outra recebe `ja_decidida` — nao retomaria a tarefa",
          perderam === 1, `${um.estado} / ${dois.estado}`);

        // CONTROLE NEGATIVO do proprio oraculo: se a transicao aceitasse
        // qualquer estado de origem, uma TERCEIRA tentativa venceria
        // depois de a linha ja estar `concluida`. Ela nao vence.
        const terceira = await moverPendencia({
          userId: DONO, pendenciaId: pend.id, de: VIVOS, para: "concluida",
        });
        ok("F5  CONTROLE: depois de concluida, ninguem mais conclui",
          terceira.estado === "ja_decidida", terceira.estado);
        ok("F6  ANCORA: a sonda sabe reconhecer uma transicao que VALE",
          escolheu.estado === "ok" && venceram === 1);

        const morta = await lerPendenciaVivaDaConversa({
          userId: DONO, conversaId: conv.id,
        });
        ok("F7  e a pendencia nao fica viva oferecendo de novo",
          morta.leitura === "ok" && morta.pendencia === null);
      }

      // ── §10: "expirou" e "nunca conectou" nao sao a mesma frase ──
      //
      // O dono fixture nao tem conta nenhuma no provedor, entao o valor
      // VERDADEIRO aqui e `reconectar: false`. Uma tela que dissesse "sua
      // conexao expirou" a quem nunca conectou mandaria a pessoa procurar
      // um erro que nao e dela.
      const falta = await faltaParaCompletar({
        userId: DONO, chave: "googlesheets", origem: "integracao",
      });
      ok("F8  sem conta nenhuma: falta CONECTAR",
        falta.falta === "conta_externa", falta.falta);
      ok("F9  e `reconectar` e false — nao houve conexao anterior",
        falta.falta === "conta_externa" && falta.reconectar === false,
        falta.falta === "conta_externa" ? String(falta.reconectar) : "");
      ok("F10 o campo EXISTE na resposta — nao e ausencia lida como false",
        falta.falta === "conta_externa" &&
          Object.prototype.hasOwnProperty.call(falta, "reconectar"));

      // ── CONTROLE ANTI-VACUIDADE de F9 ────────────────────────────
      //
      // `reconectar: false` seria trivial se nao houvesse conta nenhuma.
      // Ha: os links emitidos nas secoes anteriores viraram contas
      // `EXPIRED` no provedor. Ou seja, F9 esta dizendo algo forte — HA
      // conta quebrada, e mesmo assim a CDS nao afirma que houve conexao.
      //
      // Foi exatamente aqui que a primeira regra do §10 errou: ela lia
      // essas contas como "expirou" e mandaria o dono reconectar algo que
      // ele nunca conectou.
      const contas = await listarContasDoDono({ userId: DONO, toolkit: "googlesheets" });
      const quebradas = contas.estado === "ok"
        ? contas.dados.filter((c) => c.estado === "com_problema") : [];
      ok("F11 CONTROLE: HA conta quebrada no provedor — F9 nao e vazio",
        contas.estado === "ok" && quebradas.length >= 1,
        contas.estado === "ok" ? `${quebradas.length}` : contas.estado);
      ok("F12 e NENHUMA delas tem evidencia de autorizacao iniciada",
        quebradas.every((c) => c.autorizouAntes === false),
        quebradas.map((c) => String(c.autorizouAntes)).join(","));
      ok("F13 ANCORA: a sonda le o campo, e nao um undefined",
        quebradas.every((c) => typeof c.autorizouAntes === "boolean"));
    }
  } finally {
    secao("Limpeza");
    await limpar(db);
    const { count: lojasVivas } = await db.from("lojas")
      .select("id", { count: "exact", head: true })
      .eq("user_id", DONO).eq("ativo", true);
    const { count: lojasComToken } = await db.from("lojas")
      .select("id", { count: "exact", head: true })
      .eq("user_id", DONO).not("access_token", "is", null);
    const { count: pend } = await db.from("agente_capacidades_pendentes")
      .select("id", { count: "exact", head: true }).eq("user_id", DONO);
    const { count: bind } = await db.from("agente_conexoes")
      .select("agente_id", { count: "exact", head: true }).eq("user_id", DONO);
    // Nao "nenhuma linha": ESTADO TERMINAL. Exigir o DELETE seria exigir
    // que a auditoria fosse apagavel — e a suite falharia pela regra certa.
    ok("Z1  nenhuma loja fixture continua ATIVA", (lojasVivas ?? 0) === 0,
      String(lojasVivas));
    ok("Z1a nem com token — nenhuma e elegivel para o agente",
      (lojasComToken ?? 0) === 0, String(lojasComToken));
    ok("Z2  nenhuma pendencia sobrou", (pend ?? 0) === 0, String(pend));
    ok("Z3  nenhum binding de loja sobrou", (bind ?? 0) === 0, String(bind));
  }

  console.log(`\nPASS ${passou}   FAIL ${falhou}`);
  process.exit(falhou === 0 ? 0 : 1);
}

void main();
