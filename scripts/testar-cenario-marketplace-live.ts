/**
 * AGENT-FACTORY-F7b.4.8 §30/§33/§34/§37 — o cenario inteiro, sem reenvio.
 *
 * Suite LIVE: chama a Anthropic de verdade e escreve no banco.
 *
 * ── O cenario, exatamente como o §30 o descreve ─────────────────────
 *
 *   Financeiro SEM Mercado Livre
 *   "Quanto vendi esta semana no Mercado Livre?"
 *     -> detecta capacidade faltante
 *     -> oferece Mercado Livre               (e nao "Vendas da CDS")
 *     -> o dono adiciona
 *     -> encontra loja conectada, ou pede escolher
 *     -> vincula
 *     -> CONTINUA a tarefa original
 *
 *   USER_RESEND = 0
 *
 * ── O limite DECLARADO desta suite ──────────────────────────────────
 *
 * A loja e uma FIXTURE, com token que nao e token. Entao o ultimo elo —
 * a chamada a API oficial — termina em `credencial_ausente` aqui, e isso
 * e o comportamento CORRETO: sem credencial de verdade nao ha consulta
 * de verdade, e inventar uma seria o defeito.
 *
 * O elo que falta e provado em `testar-ml-vendas-oficial-live.ts`, contra
 * a API real e com a loja que o dono ja autorizou. As duas suites juntas
 * cobrem a cadeia; nenhuma delas finge cobrir o que nao cobre.
 *
 * Por que nao usar a loja real AQUI: seria criar um agente fixture dentro
 * da conta de producao do dono, e ele nao sairia mais de lá — o FK da
 * auditoria impede apagar. Sujeira permanente numa conta real para provar
 * o que a outra suite ja prova.
 *
 * Roda com: npx tsx scripts/testar-cenario-marketplace-live.ts
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

const DONO = "c7b00000-f748-4000-8000-0000000000d0";
const AGENTE = "c7b00000-f748-4000-8000-000000000080";
const LOJA_A = "c7b00000-f748-4000-8000-0000000a0001";
const LOJA_B = "c7b00000-f748-4000-8000-0000000a0002";
/** Um SEGUNDO agente, sem Mercado Livre — o da Skill do §33. */
const AGENTE_SKILL = "c7b00000-f748-4000-8000-000000000081";

/**
 * A Skill fixture do §33.
 *
 * Ela DECLARA precisar da consulta oficial de vendas do Mercado Livre —
 * em `requer.funcoes`, estrutura que `formato.ts` valida. O corpo nao
 * menciona Mercado Livre em lugar nenhum, de proposito: e a prova de que
 * a deteccao le a DECLARACAO, e nao o texto (§4).
 */
const SKILL_FIXTURE = [
  "```cds-skill",
  JSON.stringify({
    formato: 1,
    id: "zz-fixture-financeiro-f748",
    nome: "Fechamento financeiro (fixture)",
    versao: "1.0.0",
    descricao: "Fecha o mes com os numeros do periodo.",
    quando_usar: ["quando pedirem o fechamento do mes"],
    requer: { funcoes: ["mercadolivre.vendas.consultar"] },
    // MEDIDO: as origens validas sao `oficial_cds | importada | gerada_ia`
    // (`ORIGENS_SKILL`). "propria" foi recusada com `campo_invalido`.
    origem: "importada",
  }, null, 2),
  "```",
  "",
  "Peca o periodo, some as entradas e as saidas e apresente o resultado.",
].join("\n");


/** A pergunta do §30, palavra por palavra. */
const PERGUNTA = "Quanto vendi esta semana no Mercado Livre?";

let pass = 0;
let fail = 0;
function ok(nome: string, cond: boolean, detalhe = ""): void {
  if (cond) { pass += 1; console.log(`  PASS  ${nome}`); }
  else { fail += 1; console.log(`  FAIL  ${nome}${detalhe ? `  — ${detalhe}` : ""}`); }
}
function secao(t: string): void { console.log(`\n${t}`); }

async function limpar(db: SupabaseClient): Promise<void> {
  await db.from("agente_capacidades_pendentes").delete().eq("user_id", DONO);
  await db.from("agente_conexoes").delete().eq("user_id", DONO);
  await db.from("agente_conversas").delete().eq("user_id", DONO);
  await db.from("agente_permissoes").delete().eq("user_id", DONO);
  await db.from("agente_skills").delete().eq("user_id", DONO);
  await db.from("skills").delete().eq("user_id", DONO);
  // A loja fixture pode NAO sair: `agente_funcao_chamadas.loja_id`
  // referencia `lojas` com ON DELETE RESTRICT e e append-only. O que nao
  // se apaga fica INERTE — precedente do F7b.4.7.
  await db.from("lojas").delete().eq("user_id", DONO);
  await db.from("lojas").update({ ativo: false, access_token: null }).eq("user_id", DONO);
  await db.from("agentes").update({ ativo: false }).eq("user_id", DONO);
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
  const { lerPendenciaVivaDaConversa } = await import(
    "../lib/agentes/factory/capacidade-pendente");
  const { MARKETPLACE_POR_PLATAFORMA } = await import("../lib/agentes/conexoes/estado");
  const { definirPermissaoDeFuncaoDoAgente } = await import(
    "../lib/agentes/permissoes/escrita");
  const { resolverSelecoesDoAgente } = await import("../lib/agentes/conexoes/selecao-fatos");
  const rotaCap = await import("../app/api/agentes/[agenteId]/capacidades/[pendenciaId]/route");
  const rotaCon = await import(
    "../app/api/agentes/[agenteId]/capacidades/[pendenciaId]/conexao/route");
  const rotaAtiv = await import("../app/api/agentes/[agenteId]/ativacao/route");
  const rotaConversas = await import("../app/api/agentes/[agenteId]/conversas/route");
  const rotaConversa = await import(
    "../app/api/agentes/[agenteId]/conversas/[conversaId]/route");
  const { importarEPersistirSkill, associarSkillAoAgente } = await import(
    "../lib/agentes/skills/escrita");
  const { diagnosticarAgente } = await import("../lib/agentes/diagnostico/compositor");

  const MKT_ML = MARKETPLACE_POR_PLATAFORMA["mercado_livre"] as string;
  const portaC = criarPortaDeConversas(db);
  const cookie = `${COOKIE_SESSAO}=${(await emitirTokenSessao(DONO)).token}`;

  async function ler(r: Response) {
    let corpo: Record<string, unknown> = {};
    try { corpo = await r.json() as Record<string, unknown>; } catch { /* vazio */ }
    return { status: r.status, corpo };
  }
  const ativar = async (p: string, escolha?: string) => ler(await rotaCap.PATCH(
    new Request(`http://local/api/agentes/${AGENTE}/capacidades/${p}`, {
      method: "PATCH", headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify(escolha === undefined
        ? { acao: "ativar" } : { acao: "ativar", escolha }),
    }), { params: { agenteId: AGENTE, pendenciaId: p } }));
  const conexao = async (p: string, corpo: unknown) => ler(await rotaCon.PATCH(
    new Request(`http://local/api/agentes/${AGENTE}/capacidades/${p}/conexao`, {
      method: "PATCH", headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
    }), { params: { agenteId: AGENTE, pendenciaId: p } }));
  const prontidao = async () => ler(await rotaAtiv.GET(
    new Request(`http://local/api/agentes/${AGENTE}/ativacao`, { headers: { cookie } }),
    { params: { agenteId: AGENTE } }));

  const novaConversa = async () => ler(await rotaConversas.POST(
    new Request(`http://local/api/agentes/${AGENTE}/conversas`, {
      method: "POST", headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }), { params: { agenteId: AGENTE } }));
  const lerConversa = async (cid: string) => ler(await rotaConversa.GET(
    new Request(`http://local/api/agentes/${AGENTE}/conversas/${cid}`, {
      headers: { cookie },
    }), { params: { agenteId: AGENTE, conversaId: cid } }));

  console.log("══ F7b.4.8 §30 — o cenario do marketplace, sem reenvio ══");

  try {
    await limpar(db);
    for (const id of [AGENTE, AGENTE_SKILL]) {
      await db.from("agentes").upsert({
        id, user_id: DONO, nome: "ZZ FIXTURE financeiro f748",
        tipo: "personalizado", ativo: false,
        instrucoes: "Voce ajuda com financas. Responda de forma curta.",
      }, { onConflict: "id" });
    }

    // O Financeiro do §30: Planilhas e Calculadora, e NADA de marketplace.
    //
    // As TRES Funcoes de Planilhas, e nao uma: a ativacao exige estado
    // explicito em toda Funcao do pack escolhido, e permitir so uma
    // deixaria o pack "incompleto" — a suite mediria a fixture, e nao o
    // produto. Foi o que aconteceu na primeira execucao.
    for (const funcaoId of [
      "planilha.inspecionar", "planilha.ler", "planilha.agregar",
      "calculadora.calcular",
    ]) {
      await definirPermissaoDeFuncaoDoAgente({
        userId: DONO, agenteId: AGENTE, funcaoId, nivel: "automatico",
      });
    }

    // ═══ A. A pergunta do §30 vira oferta de Mercado Livre ══════════

    secao("A. Ele nao tem, e oferece o Mercado Livre — nao a base da CDS");
    let pendenciaId = "";
    let conversaId = "";
    {
      const conversa = await portaC.criarConversa(DONO, AGENTE, null);
      conversaId = conversa.id;
      const turno = await responderNaConversa({
        userId: DONO, agenteId: AGENTE, conversaId, texto: PERGUNTA,
      });
      ok("A1  o turno acontece — o agente responde com o que tem",
        turno.ok, turno.ok ? "" : turno.codigo);

      const viva = await lerPendenciaVivaDaConversa({ userId: DONO, conversaId });
      ok("A2  e uma capacidade faltante foi detectada",
        viva.leitura === "ok" && viva.pendencia !== null);
      if (viva.leitura === "ok" && viva.pendencia !== null) {
        pendenciaId = viva.pendencia.id;
        const chaves = viva.pendencia.opcoes.map((o) => o.chave);
        ok("A3  a oferta e MERCADO LIVRE — §20/§26",
          chaves.includes("mercadolivre-perguntas"), chaves.join(","));
        ok("A4  e NAO a base de vendas da CDS",
          !chaves.includes("vendas"), chaves.join(","));
        ok("A5  a necessidade aparece com nome de gente",
          viva.pendencia.necessidade === "Mercado Livre",
          viva.pendencia.necessidade);
        ok("A6  o objetivo ORIGINAL ficou congelado — §37",
          viva.pendencia.objetivo === PERGUNTA, viva.pendencia.objetivo);
      }
    }

    // ═══ B. A prontidao reprova antes de ativar ═════════════════════

    secao("B. A prontidao ja sabe que falta loja — §9/§11");
    {
      const antes = await prontidao();
      ok("B1  a rota de prontidao responde", antes.status === 200, String(antes.status));
      ok("B2  e o agente base NAO tem integracao pendente ainda",
        Array.isArray(antes.corpo.conexoesSemLoja) &&
          (antes.corpo.conexoesSemLoja as unknown[]).length === 0,
        JSON.stringify(antes.corpo.conexoesSemLoja));
    }

    // ═══ C. Ativar: ha loja, e a CDS PERGUNTA qual ══════════════════

    secao("C. Duas lojas conectadas: a escolha e explicita — §31");
    {
      for (const [id, nome, seller] of [
        [LOJA_A, "Loja Fixture A", "777000111"],
        [LOJA_B, "Loja Fixture B", "777000222"],
      ] as const) {
        await db.from("lojas").upsert({
          id, user_id: DONO, marketplace: MKT_ML, nome,
          nickname: nome.toUpperCase().replace(/\s/g, ""), seller_id: seller,
          ativo: true, access_token: "fixture-nao-e-token-real",
        }, { onConflict: "id" });
      }

      const r = await ativar(pendenciaId, "mercadolivre-perguntas");
      ok("C1  ativar responde 200", r.status === 200, String(r.status));
      ok("C2  a ferramenta entrou, e o passo seguinte e ESCOLHER a loja",
        r.corpo.escolherLoja !== undefined && r.corpo.escolherLoja !== null,
        JSON.stringify(r.corpo).slice(0, 140));
      const esc = r.corpo.escolherLoja as { nome?: string; lojas?: { lojaId: string; nome: string }[] };
      ok("C3  as DUAS lojas sao oferecidas — nenhuma e eleita sozinha",
        (esc?.lojas ?? []).length === 2, String((esc?.lojas ?? []).length));
      ok("C4  pelo NOME, e nunca por seller_id",
        (esc?.lojas ?? []).some((l) => l.nome === "Loja Fixture A") &&
          !JSON.stringify(esc).includes("777000"));
      ok("C5  e a tarefa NAO foi concluida ainda — §37",
        r.corpo.retomada !== true);

      // A prontidao agora ACUSA a falta de loja.
      const p = await prontidao();
      const semLoja = (p.corpo.conexoesSemLoja ?? []) as { nome: string }[];
      ok("C6  a prontidao passa a acusar loja faltando",
        semLoja.length >= 1, JSON.stringify(semLoja));
      ok("C7  com o nome do marketplace",
        semLoja.some((c) => c.nome === "Mercado Livre"), JSON.stringify(semLoja));
      ok("C8  e o agente NAO pode ser ativado assim",
        p.corpo.podeAtivar === false, String(p.corpo.podeAtivar));
      const imps = (p.corpo.impedimentos ?? []) as { codigo: string }[];
      ok("C9  pelo impedimento proprio",
        imps.some((i) => i.codigo === "conexao_sem_loja"),
        imps.map((i) => i.codigo).join(","));
    }

    // ═══ D. Escolher a loja CONTINUA a tarefa — §37 ═════════════════

    secao("D. Escolher a loja vincula e retoma — USER_RESEND = 0");
    {
      const antes = await portaC.listarMensagens(DONO, conversaId);
      const r = await conexao(pendenciaId, { acao: "escolher_loja", lojaId: LOJA_A });
      ok("D1  escolher responde 200", r.status === 200,
        `${r.status} ${JSON.stringify(r.corpo).slice(0, 120)}`);
      ok("D2  a tarefa foi RETOMADA sem reenvio",
        r.corpo.retomada === true, JSON.stringify(r.corpo).slice(0, 140));

      const msg = r.corpo.mensagemDoUsuario as { conteudo?: string } | undefined;
      ok("D3  e o texto retomado e a pergunta ORIGINAL — §37",
        msg?.conteudo === PERGUNTA, String(msg?.conteudo));

      const depois = await portaC.listarMensagens(DONO, conversaId);
      ok("D4  as mensagens anteriores continuam",
        depois.length > antes.length, `${antes.length} -> ${depois.length}`);

      const sel = await resolverSelecoesDoAgente({ userId: DONO, agenteId: AGENTE });
      ok("D5  o binding de loja foi gravado",
        sel.coleta === "ok" && sel.selecoes.length >= 1,
        `${sel.coleta}/${sel.selecoes.length}`);
      ok("D6  e aponta para a loja ESCOLHIDA",
        sel.coleta === "ok" && sel.selecoes.every((x) => x.lojaId === LOJA_A));
      ok("D7  um binding por requisito do pack — vendas E perguntas",
        sel.coleta === "ok" &&
          new Set(sel.selecoes.map((x) => x.recurso)).size === 2,
        sel.coleta === "ok" ? sel.selecoes.map((x) => x.recurso).join(",") : "");

      // A pendencia morre: a oferta nao volta.
      const morta = await lerPendenciaVivaDaConversa({ userId: DONO, conversaId });
      ok("D8  a pendencia nao fica viva oferecendo de novo",
        morta.leitura === "ok" && morta.pendencia === null);

      // §11: com a loja escolhida, a prontidao para de reclamar.
      const p = await prontidao();
      const semLoja = (p.corpo.conexoesSemLoja ?? []) as unknown[];
      ok("D9  a prontidao para de acusar loja faltando", semLoja.length === 0,
        JSON.stringify(semLoja));
      const integracoes = (p.corpo.integracoes ?? []) as { nome: string; loja: string | null }[];
      ok("D10 e passa a MOSTRAR a integracao — §10",
        integracoes.some((i) => i.nome === "Mercado Livre" && i.loja === "Loja Fixture A"),
        JSON.stringify(integracoes));
      ok("D11 o agente agora pode ser ativado", p.corpo.podeAtivar === true,
        JSON.stringify(p.corpo.impedimentos));
    }

    // ═══ E. O ultimo elo, e o que ele de fato prova ═════════════════

    secao("E. A Funcao oficial esta no agente, e falha FECHADA sem credencial");
    {
      const p = await prontidao();
      const ferramentas = (p.corpo.ferramentas ?? []) as { id: string; nome: string }[];
      ok("E1  o pack aparece com o nome Mercado Livre",
        ferramentas.some((f) => f.id === "mercadolivre-perguntas" &&
          f.nome === "Mercado Livre"),
        JSON.stringify(ferramentas));

      // §28: as duas Funcoes do pack entraram em `automatico`, e nao em
      // `aprovacao` — consultar nao pede confirmacao.
      const { data: niveis } = await db.from("agente_permissoes")
        .select("funcao_id, nivel").eq("user_id", DONO).eq("agente_id", AGENTE)
        .like("funcao_id", "mercadolivre.%");
      const linhas = (niveis ?? []) as { funcao_id: string; nivel: string }[];
      ok("E2  as duas Funcoes do Mercado Livre foram permitidas",
        linhas.length === 2, linhas.map((l) => l.funcao_id).join(","));
      ok("E3  e as DUAS em `automatico` — leitura nao confirma (§28)",
        linhas.length === 2 && linhas.every((l) => l.nivel === "automatico"),
        linhas.map((l) => `${l.funcao_id}=${l.nivel}`).join(","));

      // O elo final: com token de fixture, a consulta oficial RECUSA.
      // Este e o comportamento certo — e o que prova que ela NAO le a
      // tabela `pedidos` como plano B.
      const { criarLeiturasDeVendasML } = await import("../lib/agentes/dados/vendas-ml");
      const r = await criarLeiturasDeVendasML(DONO, LOJA_A, Date.now())(
        { periodo: "esta_semana" });
      ok("E4  sem credencial de verdade, a consulta oficial FALHA",
        r.erro !== null, String(r.erro));
      ok("E5  e NAO cai para a base da CDS como plano B",
        // F7b.4.8.3: erro nao tem total NENHUM — nem zero.
        r.totais === null && r.fonte === "mercadolivre_api",
        `${JSON.stringify(r.totais)}/${r.fonte}`);
      ok("E6  ANCORA: a fonte declarada continua sendo a API oficial",
        r.fonte === "mercadolivre_api");
    }

    // ═══ F. A conversa NOVA sabe de onde pararam — §14..§19 ═════════

    secao("F. A conversa nova retoma o assunto — e nao espera o Zep");
    {
      // O assunto da conversa A foi gravado no turno da secao A, a partir
      // da primeira frase da pessoa. Nenhuma IA e nenhum Zep participaram.
      const { data: conversaA } = await db.from("agente_conversas")
        .select("titulo").eq("id", conversaId).maybeSingle();
      const assuntoA = (conversaA as { titulo: string | null } | null)?.titulo ?? null;
      ok("F1  o assunto da conversa anterior foi gravado — §17",
        assuntoA !== null && assuntoA.length > 0, String(assuntoA));
      ok("F2  e ele CITA o que a pessoa escreveu, sem parafrasear",
        assuntoA !== null && PERGUNTA.startsWith(assuntoA.replace(/\.\.\.$/, "")),
        `${assuntoA} | ${PERGUNTA}`);

      // IMEDIATAMENTE depois — sem `sleep`, sem esperar indexacao. O §18
      // e explicito: a conversa local ja e autoridade suficiente.
      const antes = Date.now();
      const nova = await novaConversa();
      const decorrido = Date.now() - antes;
      ok("F3  a conversa nova e criada", nova.status === 201, String(nova.status));
      const novaId = ((nova.corpo.conversa ?? {}) as { id?: string }).id ?? "";
      ok("F4  com id NOVO — §14", novaId !== "" && novaId !== conversaId);

      const retomada = nova.corpo.retomada;
      ok("F5  e ela nasce com a linha de retomada — §15",
        typeof retomada === "string" && retomada.length > 0, String(retomada));
      ok("F6  que CITA o assunto da conversa anterior — §16",
        typeof retomada === "string" && assuntoA !== null &&
          retomada.includes(assuntoA),
        String(retomada));
      ok("F7  sem esperar os ~15-20s de indexacao do Zep — §18",
        decorrido < 5000, `${decorrido}ms`);

      // §19: voltar a uma conversa COM mensagens nao gera saudacao.
      const antiga = await lerConversa(conversaId);
      ok("F8  a conversa antiga volta com as mensagens", antiga.status === 200);
      ok("F9  e SEM saudacao nova — §19", antiga.corpo.retomada === null,
        String(antiga.corpo.retomada));
      ok("F10 ANCORA: ela TEM mensagens — por isso nao ha saudacao",
        Array.isArray(antiga.corpo.mensagens) &&
          (antiga.corpo.mensagens as unknown[]).length > 0);

      // A conversa nova, vazia, ainda mostra a linha depois de refresh.
      const novaDeNovo = await lerConversa(novaId);
      ok("F11 a linha sobrevive ao refresh enquanto a conversa esta vazia",
        typeof novaDeNovo.corpo.retomada === "string",
        String(novaDeNovo.corpo.retomada));

      // §14: o resto do agente CONTINUA. Ferramentas e conexao seguem.
      const p = await prontidao();
      const ferramentas = (p.corpo.ferramentas ?? []) as { id: string }[];
      ok("F12 conversa nova NAO zera as ferramentas do agente",
        ferramentas.some((f) => f.id === "mercadolivre-perguntas"),
        ferramentas.map((f) => f.id).join(","));
      const integracoes = (p.corpo.integracoes ?? []) as unknown[];
      ok("F13 nem a integracao vinculada", integracoes.length >= 1,
        String(integracoes.length));

      // A retomada NAO e uma mensagem gravada: ela nao entra na trilha.
      const msgsNova = await portaC.listarMensagens(DONO, novaId);
      ok("F14 e a saudacao NAO foi gravada como turno do assistente",
        msgsNova.length === 0, String(msgsNova.length));
    }

    // ═══ G. A Skill DECLARA, e a CDS resolve ali mesmo — §33/§34 ════

    secao("G. A Skill declara o que o agente nao tem — §3/§33");
    {
      const imp = await importarEPersistirSkill({ userId: DONO, texto: SKILL_FIXTURE });
      ok("G1  a Skill fixture foi aceita e persistida",
        imp.estado === "criada" || imp.estado === "ja_existia",
        // Os MOTIVOS entram no detalhe: "recusada" sozinho nao diz o que
        // corrigir, e a suite existe para dizer.
        `${imp.estado} ${JSON.stringify((imp as { motivos?: unknown }).motivos ?? "")}`);
      const skillId = (imp as { skillId?: string }).skillId ?? "";

      if (skillId !== "") {
        const assoc = await associarSkillAoAgente({
          userId: DONO, agenteId: AGENTE_SKILL, skillId,
        });
        ok("G2  e associada ao agente que NAO tem Mercado Livre",
          assoc.estado === "associada" || assoc.estado === "ja_associada",
          assoc.estado);

        // O requisito e DECLARADO: o motor de diagnostico o encontra sem
        // ler uma palavra do corpo da Skill.
        const diag = await diagnosticarAgente({
          userId: DONO, agenteId: AGENTE_SKILL, agoraMs: Date.now(),
        });
        ok("G3  o diagnostico le a Skill", diag.coleta === "ok", diag.coleta);
        ok("G4  e acusa a Funcao declarada que falta",
          diag.diagnosticos.some((d) =>
            d.diagnostico.bloqueios.some((pend) =>
              pend.tipo === "funcao" && pend.alvo === "mercadolivre.vendas.consultar")),
          JSON.stringify(diag.diagnosticos).slice(0, 180));

        // A prontidao traduz isso em impedimento com frase de gente.
        const p = await ler(await rotaAtiv.GET(
          new Request(`http://local/api/agentes/${AGENTE_SKILL}/ativacao`, {
            headers: { cookie },
          }), { params: { agenteId: AGENTE_SKILL } }));
        ok("G5  a prontidao responde", p.status === 200, String(p.status));
        const deps = (p.corpo.dependenciasDeSkill ?? []) as
          { nome: string; packId: string | null; bloqueia: boolean }[];
        ok("G6  a dependencia aparece com NOME de gente",
          deps.some((d) => d.nome === "Mercado Livre"), JSON.stringify(deps));
        ok("G7  e com o pack que RESOLVE — o botao do §5 tem destino",
          deps.some((d) => d.packId === "mercadolivre-perguntas"), JSON.stringify(deps));
        const imps = (p.corpo.impedimentos ?? []) as { codigo: string; etapa: number }[];
        ok("G8  o agente NAO pode ser ativado assim — §34",
          p.corpo.podeAtivar === false, String(p.corpo.podeAtivar));
        ok("G9  pelo impedimento de dependencia de Skill",
          imps.some((i) => i.codigo === "skill_sem_ferramenta"),
          imps.map((i) => i.codigo).join(","));
        ok("G10 que leva para a etapa de Ferramentas — e nao a tela admin",
          imps.find((i) => i.codigo === "skill_sem_ferramenta")?.etapa === 4);

        // ── §5/§33: RESOLVER, e conferir que ficou pronto ───────────
        //
        // O botao do wizard faz exatamente isto: grava o nivel de todas
        // as Funcoes do pack, com o nivel derivado do EFEITO.
        for (const funcaoId of [
          "mercadolivre.perguntas.listar", "mercadolivre.vendas.consultar",
        ]) {
          await definirPermissaoDeFuncaoDoAgente({
            userId: DONO, agenteId: AGENTE_SKILL, funcaoId, nivel: "automatico",
          });
        }
        await db.from("agente_conexoes").insert({
          user_id: DONO, agente_id: AGENTE_SKILL,
          plataforma: "mercado_livre", recurso: "vendas", loja_id: LOJA_A,
        });
        await db.from("agente_conexoes").insert({
          user_id: DONO, agente_id: AGENTE_SKILL,
          plataforma: "mercado_livre", recurso: "perguntas", loja_id: LOJA_A,
        });

        const depois = await ler(await rotaAtiv.GET(
          new Request(`http://local/api/agentes/${AGENTE_SKILL}/ativacao`, {
            headers: { cookie },
          }), { params: { agenteId: AGENTE_SKILL } }));
        const depsDepois = (depois.corpo.dependenciasDeSkill ?? []) as unknown[];
        ok("G11 resolvida, a dependencia DESAPARECE", depsDepois.length === 0,
          JSON.stringify(depsDepois));
        ok("G12 e a Skill fica pronta — o agente pode ativar (§34)",
          depois.corpo.podeAtivar === true,
          JSON.stringify(depois.corpo.impedimentos));

        const diagDepois = await diagnosticarAgente({
          userId: DONO, agenteId: AGENTE_SKILL, agoraMs: Date.now(),
        });
        ok("G13 o diagnostico da Skill passa a PRONTO",
          diagDepois.diagnosticos.every((d) => d.diagnostico.pronto),
          JSON.stringify(diagDepois.diagnosticos).slice(0, 180));
        ok("G14 ANCORA: havia diagnostico para avaliar",
          diagDepois.diagnosticos.length >= 1);
      }
    }

  } finally {
    secao("Limpeza");
    await limpar(db);
    const { count: vivas } = await db.from("lojas")
      .select("id", { count: "exact", head: true }).eq("user_id", DONO).eq("ativo", true);
    const { count: pend } = await db.from("agente_capacidades_pendentes")
      .select("id", { count: "exact", head: true }).eq("user_id", DONO);
    const { count: bind } = await db.from("agente_conexoes")
      .select("agente_id", { count: "exact", head: true }).eq("user_id", DONO);
    ok("Z1  nenhuma loja fixture continua ATIVA", (vivas ?? 0) === 0, String(vivas));
    ok("Z2  nenhuma pendencia sobrou", (pend ?? 0) === 0, String(pend));
    ok("Z3  nenhum binding sobrou", (bind ?? 0) === 0, String(bind));
    console.log(`\nPASS ${pass}   FAIL ${fail}`);
    process.exit(fail === 0 ? 0 : 1);
  }
}

void main();
