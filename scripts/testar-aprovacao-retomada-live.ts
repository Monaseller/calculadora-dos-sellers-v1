/**
 * AGENT-FACTORY-F7b.4.4 — o bug do Rodrigo, provado corrigido.
 *
 * LIVE de ponta a ponta: provider real, guard real, banco real, e a ROTA
 * real com cookie de sessao assinado.
 *
 * ── O bug, como ele foi relatado ────────────────────────────────────
 *
 *   adicionou Tools -> chat -> agente pediu aprovacao -> aprovou ->
 *   a conversa voltou/resetou -> mensagens sumiram -> teve de reescrever
 *   -> pediu aprovacao DE NOVO -> ciclo.
 *
 * ── A causa, que era de backend ─────────────────────────────────────
 *
 *   1. `decidirAprovacao` marcava o estado e parava ali.
 *   2. A aprovacao nao guardava conversa nem o id do pedido do modelo.
 *   3. `retomarAprovacao` existia sem chamador e sem produzir resposta.
 *
 * O cartao do chat mandava para `/ia/aprovacoes` — outra pagina. Sair da
 * pagina e o que "apagava" as mensagens; nada as apagou.
 *
 * ── O par que faz disto prova ───────────────────────────────────────
 *
 *   A. `automatico` -> ZERO aprovacao, UMA execucao, resposta certa
 *   B. `aprovacao`  -> ZERO execucao, UMA aprovacao, historico intacto
 *   C. aprovar      -> UMA execucao, 46719.65 no MESMO chat, ZERO
 *                      aprovacao nova, ZERO mensagem de usuario nova
 *
 * Sem A, um sistema que sempre pede aprovacao passaria em B. Sem a
 * contagem de mensagens do usuario, um resume que reenviasse a pergunta
 * passaria em C.
 *
 * Roda com: npx tsx scripts/testar-aprovacao-retomada-live.ts
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

/** UUID porque `emitirTokenSessao` cobra o formato. `f744` identifica. */
const DONO = "c7b00000-f744-4000-8000-0000000000d0";
const INTRUSO = "c7b00000-f744-4000-8000-0000000000d1";
const AGENTE = "c7b00000-0000-4000-8000-000000000046";
const AGENTE_INTRUSO = "c7b00000-0000-4000-8000-000000000047";

const ID_CALC = "calculadora.calcular";
const PERGUNTA = "Quanto e 184530.20 menos 137810.55? Use a ferramenta.";
const RESULTADO = "46719.65";

let passou = 0;
let falhou = 0;
function ok(nome: string, cond: boolean, detalhe = ""): void {
  if (cond) { passou++; console.log(`  PASS  ${nome}`); }
  else { falhou++; console.log(`  FAIL  ${nome}${detalhe ? ` — ${detalhe}` : ""}`); }
}
function secao(t: string): void { console.log(`\n${t}`); }

function temResultado(texto: string): boolean {
  return texto.includes(RESULTADO) || texto.includes("46.719,65") ||
    texto.includes("46719,65");
}

/**
 * Limpa o que PODE ser limpo.
 *
 * `agente_funcao_aprovacoes` NAO aceita DELETE: `service_role` tem SELECT,
 * INSERT em 12 colunas e UPDATE em 11, e mais nada. Isso e deliberado — a
 * decisao de um humano sobre uma acao nao deve poder sumir por conveniencia
 * de teste, do mesmo jeito que a auditoria de Funcao nao some.
 *
 * Entao o que se cobra no fim nao e "sumiu", e sim "nenhuma ficou VIVA":
 * toda aprovacao de teste termina em estado terminal, e nenhuma pode
 * reaparecer como pendente para ninguem.
 */
async function limpar(db: SupabaseClient): Promise<void> {
  await db.from("agente_ferramentas_externas").delete().eq("user_id", DONO);
  await db.from("agente_conversas").delete().eq("user_id", DONO);
  await db.from("agente_conversas").delete().eq("user_id", INTRUSO);
  await db.from("agente_permissoes").delete().eq("user_id", DONO);
  await db.from("agente_permissoes").delete().eq("user_id", INTRUSO);
  // O agente NAO e apagado: FK RESTRICT da auditoria append-only.
  await db.from("agentes").update({ ativo: false }).eq("user_id", DONO);
  await db.from("agentes").update({ ativo: false }).eq("user_id", INTRUSO);
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
  const rota = await import("../app/api/agentes/[agenteId]/aprovacoes/[aprovacaoId]/route");

  const portaC = criarPortaDeConversas(db);

  const cookieDe = async (uid: string) =>
    `${COOKIE_SESSAO}=${(await emitirTokenSessao(uid)).token}`;

  /** A ROTA real, com sessao real. Nada de atalho de autenticacao. */
  async function decidir(
    cookie: string | undefined, agenteId: string, aprovacaoId: string,
    decisao: "aprovar" | "rejeitar"
  ) {
    const req = new Request(
      `http://local/api/agentes/${agenteId}/aprovacoes/${aprovacaoId}`,
      {
        method: "PATCH",
        headers: {
          ...(cookie ? { cookie } : {}),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ decisao }),
      }
    );
    const r = await rota.PATCH(req, { params: { agenteId, aprovacaoId } });
    let corpo: Record<string, unknown> = {};
    try { corpo = await r.json() as Record<string, unknown>; } catch { /* vazio */ }
    return { status: r.status, corpo };
  }

  /**
   * Quantas aprovacoes ESTA execucao criou.
   *
   * Contagem ABSOLUTA nao serve: aprovacao nao pode ser apagada (o
   * `service_role` nao tem DELETE nesta tabela, de proposito), entao as
   * execucoes anteriores da suite ficam. O primeiro oraculo contou o total
   * e acusou "3 aprovacoes" onde esta execucao tinha criado zero.
   *
   * O que importa e o DELTA contra a linha de base tirada no inicio.
   */
  const totalDeAprovacoes = async (): Promise<number> =>
    (await db.from("agente_funcao_aprovacoes")
      .select("id", { count: "exact", head: true }).eq("user_id", DONO)).count ?? 0;

  /** Execucoes distintas de nivel `aprovacao`, por `request_id`. */
  const execucoesAprovadas = async (): Promise<number> => {
    const { data } = await db.from("agente_funcao_chamadas")
      .select("request_id")
      .eq("user_id", DONO).eq("funcao_id", ID_CALC).eq("nivel_no_momento", "aprovacao");
    return new Set(((data ?? []) as { request_id: string }[]).map((l) => l.request_id)).size;
  };

  const BASE_APROVACOES = await totalDeAprovacoes();
  const BASE_EXECUCOES = await execucoesAprovadas();
  console.log(`  base: ${BASE_APROVACOES} aprovacao(oes), ${BASE_EXECUCOES} execucao(oes) anteriores`);

  const contarAprovacoes = async (): Promise<number> =>
    (await totalDeAprovacoes()) - BASE_APROVACOES;

  async function definirNivel(nivel: string): Promise<void> {
    await db.from("agente_permissoes").upsert({
      agente_id: AGENTE, user_id: DONO, funcao_id: ID_CALC, nivel,
      alterado_em: new Date().toISOString(),
    }, { onConflict: "agente_id,funcao_id" });
  }

  console.log("\n== F7b.4.4 — aprovar retoma o MESMO turno ==");
  console.log(`  modelo: ${process.env.ANTHROPIC_MODEL_AGENTE}`);

  try {
    await limpar(db);
    for (const [id, dono] of [[AGENTE, DONO], [AGENTE_INTRUSO, INTRUSO]] as const) {
      await db.from("agentes").upsert({
        id, user_id: dono, nome: "ZZ FIXTURE aprovacao f744",
        tipo: "personalizado", ativo: false,
        instrucoes: "Use SEMPRE a ferramenta para qualquer calculo. Nunca calcule de cabeca.",
      }, { onConflict: "id" });
    }

    // ═══ A. AUTOMATICO: nao pede aprovacao ══════════════════════════

    secao("A. `automatico` nao pede aprovacao nenhuma (§17)");
    {
      await definirNivel("automatico");
      const conversa = await portaC.criarConversa(DONO, AGENTE, "Automatico");
      const r = await responderNaConversa(
        { userId: DONO, agenteId: AGENTE, conversaId: conversa.id, texto: PERGUNTA },
        portaC
      );
      ok("A1  o turno concluiu", r.ok === true, r.ok ? "" : `${r.codigo}`);
      if (r.ok) {
        const calc = (r.resposta.passos ?? []).filter((p) => p.funcaoId === ID_CALC);
        ok("A2  a Funcao executou UMA vez",
          calc.filter((p) => p.executou).length === 1,
          `${calc.filter((p) => p.executou).length}`);
        ok("A3  e a resposta traz o numero da ferramenta",
          temResultado(r.resposta.conteudo ?? ""),
          (r.resposta.conteudo ?? "").slice(0, 90));
      }
      ok("A4  ZERO aprovacao foi criada nesta rodada", (await contarAprovacoes()) === 0,
        String(await contarAprovacoes()));
    }

    // ═══ B. APROVACAO: para, e guarda a conversa ════════════════════

    secao("B. `aprovacao` para o turno e registra de onde veio (§18)");

    await definirNivel("aprovacao");
    const conversa = await portaC.criarConversa(DONO, AGENTE, "Com aprovacao");
    let aprovacaoId = "";
    {
      const r = await responderNaConversa(
        { userId: DONO, agenteId: AGENTE, conversaId: conversa.id, texto: PERGUNTA },
        portaC
      );
      ok("B1  o turno terminou de forma controlada", r.ok === true,
        r.ok ? "" : `${r.codigo}`);
      if (!r.ok) throw new Error("turno de aprovacao falhou");

      const calc = (r.resposta.passos ?? []).filter((p) => p.funcaoId === ID_CALC);
      ok("B2  NENHUMA execucao aconteceu",
        calc.every((p) => p.executou !== true));
      ok("B3  e o motivo foi a espera por aprovacao",
        calc.some((p) => p.desfecho === "aguardando_aprovacao"),
        calc.map((p) => p.desfecho).join(","));
      ok("B4  UMA aprovacao foi criada nesta rodada", (await contarAprovacoes()) === 1,
        String(await contarAprovacoes()));

      // O CAMPO NOVO: o passo publica QUAL aprovacao.
      const comId = calc.find((p) => typeof p.aprovacaoId === "string");
      ok("B5  o passo publica o `aprovacaoId` — a tela sabe qual e",
        comId !== undefined, JSON.stringify(calc));
      aprovacaoId = String(comId?.aprovacaoId ?? "");

      ok("B6  a resposta NAO traz o numero — nada foi inventado",
        !temResultado(r.resposta.conteudo ?? ""),
        (r.resposta.conteudo ?? "").slice(0, 90));
    }

    // A linha do banco carrega a origem. E ela que faltava.
    {
      const { data } = await db.from("agente_funcao_aprovacoes")
        .select("conversa_id, pedido_id, texto_assistente, estado, funcao_id, argumentos")
        .eq("id", aprovacaoId).single();
      const linha = data as Record<string, unknown> | null;
      ok("B7  a aprovacao sabe de qual CONVERSA veio",
        linha?.conversa_id === conversa.id, String(linha?.conversa_id));
      ok("B8  e qual pedido do modelo ficou pendente",
        typeof linha?.pedido_id === "string" && String(linha.pedido_id).length > 0,
        String(linha?.pedido_id));
      ok("B9  com os argumentos CONGELADOS",
        JSON.stringify(linha?.argumentos ?? {}).includes("184530.2"),
        JSON.stringify(linha?.argumentos ?? {}).slice(0, 80));
      ok("B10 e o estado e `pendente`", linha?.estado === "pendente", String(linha?.estado));
    }

    // §20: o historico esta INTACTO — e e ele que a tela releria.
    const antes = await portaC.listarMensagens(DONO, conversa.id);
    {
      ok("B11 a conversa tem a pergunta do usuario gravada",
        antes.some((m) => m.papel === "usuario" && (m.conteudo ?? "").includes("184530")),
        `${antes.length} mensagem(ns)`);
      ok("B12 e a aprovacao pendente e reencontravel pela conversa (§11)",
        (await (await import("../lib/agentes/aprovacoes/persistencia"))
          .lerAprovacaoVivaDaConversa({ userId: DONO, conversaId: conversa.id }))
          .leitura === "ok");
    }

    // ═══ C. APROVAR: retoma o MESMO turno ═══════════════════════════

    secao("C. Aprovar executa e responde no MESMO chat (§18)");
    const cookie = await cookieDe(DONO);
    {
      const r = await decidir(cookie, AGENTE, aprovacaoId, "aprovar");
      ok("C1  a rota aceitou a aprovacao", r.status === 200,
        `${r.status} ${JSON.stringify(r.corpo).slice(0, 120)}`);
      ok("C2  e a Funcao EXECUTOU agora", r.corpo.executou === true,
        String(r.corpo.executou));
      ok("C3  na MESMA conversa", r.corpo.conversaId === conversa.id,
        String(r.corpo.conversaId));

      const mensagem = r.corpo.mensagem as { conteudo?: string } | undefined;
      console.log(`  resposta: ${(mensagem?.conteudo ?? "").slice(0, 120)}`);
      ok("C4  a resposta final traz 46719.65, vindo da ferramenta",
        temResultado(mensagem?.conteudo ?? ""),
        (mensagem?.conteudo ?? "").slice(0, 100));

      ok("C5  NENHUMA aprovacao nova foi criada (§8)",
        (await contarAprovacoes()) === 1, String(await contarAprovacoes()));

      const depois = await portaC.listarMensagens(DONO, conversa.id);
      ok("C6  as mensagens anteriores CONTINUAM la (§10)",
        antes.every((m) => depois.some((d) => d.id === m.id)),
        `${antes.length} -> ${depois.length}`);
      ok("C7  e o usuario NAO precisou reescrever a pergunta",
        depois.filter((m) => m.papel === "usuario").length ===
          antes.filter((m) => m.papel === "usuario").length,
        `${antes.filter((m) => m.papel === "usuario").length} -> ` +
          `${depois.filter((m) => m.papel === "usuario").length}`);
      ok("C8  a conversa ganhou exatamente UMA mensagem nova",
        depois.length === antes.length + 1, `${antes.length} -> ${depois.length}`);
    }

    // §20: depois de aprovar, nao ha mais pendencia.
    {
      const viva = await (await import("../lib/agentes/aprovacoes/persistencia"))
        .lerAprovacaoVivaDaConversa({ userId: DONO, conversaId: conversa.id });
      ok("C9  e a conversa nao tem mais aprovacao viva (§11)",
        viva.leitura === "ok" && viva.aprovacao === null,
        viva.leitura === "ok" ? String(viva.aprovacao?.estado) : viva.leitura);
    }

    // ═══ D. Duplo clique / retry ════════════════════════════════════

    secao("D. Aprovar de novo nao executa de novo (§19)");
    {
      const antesDeRepetir = await portaC.listarMensagens(DONO, conversa.id);
      const r2 = await decidir(cookie, AGENTE, aprovacaoId, "aprovar");
      ok("D1  o segundo clique responde de forma controlada",
        r2.status === 200 || r2.status === 409, String(r2.status));
      ok("D2  e diz que ja foi executada",
        r2.corpo.jaExecutada === true || String(r2.corpo.codigo ?? "").includes("ja"),
        JSON.stringify(r2.corpo).slice(0, 120));
      const depoisDeRepetir = await portaC.listarMensagens(DONO, conversa.id);
      ok("D3  e NAO acrescentou outra resposta",
        depoisDeRepetir.length === antesDeRepetir.length,
        `${antesDeRepetir.length} -> ${depoisDeRepetir.length}`);
      ok("D4  nem criou aprovacao nova", (await contarAprovacoes()) === 1);

      // A prova de execucao unica esta na AUDITORIA, que e append-only.
      //
      // Contar LINHAS estaria errado: cada execucao grava DUAS — uma de
      // `abertura` e uma de `desfecho`, com o mesmo `request_id`. O
      // primeiro oraculo contou linhas, viu 2 e acusou execucao dupla que
      // nao existia. O que identifica uma execucao e o `request_id`.
      const novas = (await execucoesAprovadas()) - BASE_EXECUCOES;
      ok("D5  a auditoria registra UMA execucao — uma so, apos dois cliques",
        novas === 1, `${novas} execucao(oes) nesta rodada`);
      const { data: linhas } = await db.from("agente_funcao_chamadas")
        .select("request_id, fase")
        .eq("user_id", DONO).eq("funcao_id", ID_CALC).eq("nivel_no_momento", "aprovacao");
      ok("D5a e cada execucao tem abertura E desfecho — a auditoria e completa",
        new Set(((linhas ?? []) as { fase: string }[]).map((l) => l.fase)).size === 2,
        JSON.stringify(((linhas ?? []) as { fase: string }[]).map((l) => l.fase)));
    }

    // ═══ E. Rejeitar ════════════════════════════════════════════════

    secao("E. Negar mantem a conversa viva (§12)");
    {
      const conversa2 = await portaC.criarConversa(DONO, AGENTE, "Para negar");
      const r = await responderNaConversa(
        { userId: DONO, agenteId: AGENTE, conversaId: conversa2.id, texto: PERGUNTA },
        portaC
      );
      if (!r.ok) throw new Error("turno para negar falhou");
      const id2 = String(
        (r.resposta.passos ?? []).find((p) => typeof p.aprovacaoId === "string")?.aprovacaoId ?? ""
      );
      ok("E1  ha uma aprovacao para negar", id2 !== "");

      const antesDeNegar = await portaC.listarMensagens(DONO, conversa2.id);
      const neg = await decidir(cookie, AGENTE, id2, "rejeitar");
      ok("E2  a rota aceitou a negativa", neg.status === 200, String(neg.status));

      const depoisDeNegar = await portaC.listarMensagens(DONO, conversa2.id);
      ok("E3  a conversa CONTINUA — nada foi apagado",
        antesDeNegar.every((m) => depoisDeNegar.some((d) => d.id === m.id)));
      ok("E4  e o agente respondeu que nao foi autorizado",
        (depoisDeNegar[depoisDeNegar.length - 1]?.conteudo ?? "").includes("não autorizou"),
        (depoisDeNegar[depoisDeNegar.length - 1]?.conteudo ?? "").slice(0, 80));
      ok("E5  sem executar nada",
        !temResultado(depoisDeNegar[depoisDeNegar.length - 1]?.conteudo ?? ""));

      const viva = await (await import("../lib/agentes/aprovacoes/persistencia"))
        .lerAprovacaoVivaDaConversa({ userId: DONO, conversaId: conversa2.id });
      ok("E6  e a aprovacao negada nao reaparece como pendente",
        viva.leitura === "ok" && viva.aprovacao === null);
    }

    // ═══ F. Isolamento entre donos ══════════════════════════════════

    secao("F. Aprovacao de um dono nao e decidida por outro (§23)");
    {
      const conversa3 = await portaC.criarConversa(DONO, AGENTE, "Isolamento");
      const r = await responderNaConversa(
        { userId: DONO, agenteId: AGENTE, conversaId: conversa3.id, texto: PERGUNTA },
        portaC
      );
      if (!r.ok) throw new Error("turno de isolamento falhou");
      const id3 = String(
        (r.resposta.passos ?? []).find((p) => typeof p.aprovacaoId === "string")?.aprovacaoId ?? ""
      );

      const intruso = await decidir(await cookieDe(INTRUSO), AGENTE_INTRUSO, id3, "aprovar");
      ok("F1  outro dono recebe 404, e nao 200", intruso.status === 404,
        String(intruso.status));

      const semCookie = await decidir(undefined, AGENTE, id3, "aprovar");
      ok("F2  sem sessao: 401", semCookie.status === 401, String(semCookie.status));

      const forjado = await decidir(`${COOKIE_SESSAO}=nao-assinado`, AGENTE, id3, "aprovar");
      ok("F3  cookie forjado: 401", forjado.status === 401, String(forjado.status));

      const { data } = await db.from("agente_funcao_aprovacoes")
        .select("estado").eq("id", id3).single();
      ok("F4  e a aprovacao continua PENDENTE — ninguem a moveu",
        (data as { estado?: string } | null)?.estado === "pendente",
        String((data as { estado?: string } | null)?.estado));

      // ANCORA: o dono CERTO consegue. Sem isto, F1..F3 passariam com uma
      // rota que responde erro para todo mundo.
      const dono = await decidir(cookie, AGENTE, id3, "aprovar");
      ok("F5  ANCORA: o dono certo consegue aprovar", dono.status === 200,
        String(dono.status));
    }

    // ═══ G. Corpo invalido ══════════════════════════════════════════

    secao("G. A rota so aceita as duas palavras");
    {
      const req = new Request(`http://local/api/agentes/${AGENTE}/aprovacoes/x`, {
        method: "PATCH",
        headers: { cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ decisao: "executar", funcaoId: "outra.coisa" }),
      });
      const r = await rota.PATCH(req, { params: { agenteId: AGENTE, aprovacaoId: "x" } });
      ok("G1  decisao desconhecida: 400", r.status === 400, String(r.status));
    }

    // ═══ H. A MESMA aprovacao, para ferramenta EXTERNA (§24) ════════

    secao("H. Aprovacao de ferramenta EXTERNA executa uma vez so");
    {
      const TOOLKIT = "hackernews";
      const ACAO_EXT = "HACKERNEWS_GET_ITEM_WITH_ID";
      const ID_EXT = "composio.hackernews.hackernews_get_item_with_id";
      const AUTOR = "norvig";

      if (!process.env.COMPOSIO_API_KEY) {
        ok("H0  COMPOSIO_API_KEY presente para a prova externa", false, "ausente");
      } else {
        const {
          vincularFerramentaExternaNoAgente, definirPermissaoDeFerramentaExterna,
        } = await import("../lib/agentes/ferramentas-externas/repositorio");

        /** Execucoes externas distintas, por `request_id`. */
        const execucoesExternas = async (): Promise<number> => {
          const { data } = await db.from("agente_funcao_chamadas")
            .select("request_id").eq("user_id", DONO).eq("funcao_id", ID_EXT);
          return new Set(
            ((data ?? []) as { request_id: string }[]).map((l) => l.request_id)).size;
        };
        // Baseline, pelo mesmo motivo das outras contagens: a auditoria e
        // append-only, entao as rodadas anteriores ficam.
        const BASE_EXT = await execucoesExternas();

        await vincularFerramentaExternaNoAgente({
          userId: DONO, agenteId: AGENTE, provedorExterno: "composio",
          toolkit: TOOLKIT, acao: ACAO_EXT,
        });
        await definirPermissaoDeFerramentaExterna({
          userId: DONO, agenteId: AGENTE, funcaoId: ID_EXT, nivel: "aprovacao",
        });
        // A calculadora sai de cena para o modelo nao ter escolha.
        await db.from("agente_permissoes").delete()
          .eq("user_id", DONO).eq("funcao_id", ID_CALC);

        const conv = await portaC.criarConversa(DONO, AGENTE, "Externa com aprovacao");
        const r = await responderNaConversa(
          {
            userId: DONO, agenteId: AGENTE, conversaId: conv.id,
            texto: "Qual e o autor do item 2921983 do Hacker News? Use a ferramenta.",
          },
          portaC
        );
        ok("H1  o turno terminou de forma controlada", r.ok === true,
          r.ok ? "" : `${r.codigo}`);

        const ext = r.ok
          ? (r.resposta.passos ?? []).filter((p) => p.funcaoId === ID_EXT)
          : [];
        ok("H2  a Funcao externa foi pedida e PAROU por aprovacao",
          ext.some((p) => p.desfecho === "aguardando_aprovacao" && p.executou !== true),
          ext.map((p) => `${p.desfecho}/${p.executou}`).join(","));

        const idExt = String(
          ext.find((p) => typeof p.aprovacaoId === "string")?.aprovacaoId ?? "");
        ok("H3  com aprovacao identificavel", idExt !== "");
        ok("H4  e o adaptador NAO rodou — nada foi executado",
          !((r.ok ? r.resposta.conteudo : "") ?? "").toLowerCase().includes(AUTOR));

        if (idExt !== "") {
          const ap = await decidir(cookie, AGENTE, idExt, "aprovar");
          ok("H5  aprovar executa a acao externa", ap.status === 200,
            `${ap.status} ${JSON.stringify(ap.corpo).slice(0, 140)}`);
          const msg = ap.corpo.mensagem as { conteudo?: string } | undefined;
          console.log(`  resposta: ${(msg?.conteudo ?? "").slice(0, 110)}`);
          ok("H6  e a resposta traz o dado REAL do provedor externo",
            (msg?.conteudo ?? "").toLowerCase().includes(AUTOR),
            (msg?.conteudo ?? "").slice(0, 90));

          // §24: segunda aprovacao NAO executa de novo.
          const de2 = await decidir(cookie, AGENTE, idExt, "aprovar");
          ok("H7  a segunda aprovacao nao executa de novo",
            de2.corpo.jaExecutada === true ||
              String(de2.corpo.codigo ?? "").includes("ja"),
            `${de2.status} ${JSON.stringify(de2.corpo).slice(0, 120)}`);

          const novas = (await execucoesExternas()) - BASE_EXT;
          ok("H8  a auditoria registra UMA execucao externa nesta rodada",
            novas === 1, `${novas}`);
        }
      }
    }

  } finally {
    secao("Limpeza");
    await limpar(db);
    const { data: vivas } = await db.from("agente_funcao_aprovacoes")
      .select("id, estado").eq("user_id", DONO).in("estado", ["pendente", "aprovada"]);
    const { data: todas } = await db.from("agente_funcao_aprovacoes")
      .select("id").eq("user_id", DONO);
    const { count: conv } = await db.from("agente_conversas")
      .select("id", { count: "exact", head: true }).eq("user_id", DONO);
    ok("Z1  nenhuma aprovacao de teste ficou VIVA", (vivas ?? []).length === 0,
      JSON.stringify(vivas));
    ok("Z1a ANCORA: a varredura de fato enxergou aprovacoes",
      (todas ?? []).length >= 1, `${(todas ?? []).length}`);
    ok("Z2  nenhuma conversa de teste sobrou", (conv ?? 0) === 0, String(conv));
  }

  console.log(`\nPASS ${passou}   FAIL ${falhou}`);
  process.exit(falhou === 0 ? 0 : 1);
}

void main();
