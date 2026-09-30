/**
 * AGENT-FACTORY-F7b.4.8.2 — a fonte NOMEADA manda, e o turno nao morre.
 *
 * Suite LIVE: rota real de conversa, sessao assinada, **OpenAI real**.
 * O §14 e explicito: as provas principais deste gate nao aceitam
 * Anthropic como substituto, porque foi so com OpenAI que os dois bugs
 * apareceram.
 *
 * ── Os dois problemas, rastreados SEPARADAMENTE (§4) ────────────────
 *
 * A. A consulta ao Mercado Livre morria.
 *
 *    MEDIDO na auditoria do agente real, as 20:32 de 2026-09-30, ja com a
 *    F7b.4.8.1 no ar:
 *
 *      funcao_id        mercadolivre.vendas.consultar
 *      codigo_desfecho  entrada_invalida
 *      mensagem         "... Regra: filtro_ambiguo."
 *      nivel            automatico
 *      loja             presente
 *
 *    `filtro_ambiguo` com `null` ja removido significa que o modelo
 *    mandou `periodo` E datas de verdade — o schema oferecia os dois
 *    caminhos e dizia "use um ou o outro" apenas numa descricao.
 *
 * B. Depois, o cartao "Preciso de uma ferramenta" ofereceu Vendas da CDS,
 *    HubSpot e Salesforce.
 *
 *    MEDIDO: o `objetivo` daquela pendencia era **"consulte as vendas"** —
 *    outra mensagem, de 19:46, ANTES da F7b.4.8.1. Ela ficou viva (o
 *    cartao sobrevive a refresh, por contrato) e apareceu ao lado da
 *    resposta nova, parecendo pertencer a pergunta do Mercado Livre.
 *
 *    O defeito real e outro, e e de produto: um agente cuja UNICA fonte
 *    de vendas e o Mercado Livre nao deveria receber oferta de tres
 *    fontes novas de vendas.
 *
 * Roda com:
 *   OPENAI_MODEL_AGENTE=gpt-5.2 npx tsx scripts/testar-fonte-nomeada-live.ts
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

const DONO = "c7b00000-f482-4000-8000-0000000000d0";
/** Como o do Rodrigo: ATIVO, OpenAI, pack do Mercado Livre, loja ligada. */
const AGENTE_COM = "c7b00000-f482-4000-8000-000000000090";
/** Sem o pack — o par anti-vacuidade do §16. */
const AGENTE_SEM = "c7b00000-f482-4000-8000-000000000091";
const LOJA = "c7b00000-f482-4000-8000-0000000a0001";

/**
 * A loja MONAMOR — conexao que o dono JA autorizou na CDS.
 *
 * Usada SO na secao G, e SO para leitura. E o unico jeito de provar que o
 * argumento que o modelo manda hoje chega a API oficial: a fixture nao tem
 * credencial, e o guard exige cobertura CONFIRMADA, que so uma chamada
 * real ao Mercado Livre concede.
 */
const LOJA_REAL = "50165b6f-5185-4da7-991a-07c0c6bc8f39";

/** A frase do §26.1. Obrigatoria no teste de rota real. */
const PERGUNTA = "Quanto vendi esta semana no Mercado Livre?";
/** A frase do §26.2 — a que gerou o cartao errado. */
const GENERICA = "consulte as vendas";

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
  await db.from("lojas").delete().eq("user_id", DONO);
  await db.from("lojas").update({ ativo: false, access_token: null }).eq("user_id", DONO);
  await db.from("agentes").update({ ativo: false }).eq("user_id", DONO);
}

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const chaveDb = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !chaveDb) { console.error("ERRO: env do Supabase ausente."); process.exit(1); }
  if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_MODEL_AGENTE) {
    console.error("ERRO: env da OpenAI ausente. Passe OPENAI_MODEL_AGENTE inline.");
    process.exit(1);
  }
  const db = createClient(url, chaveDb);

  const { emitirTokenSessao, COOKIE_SESSAO } = await import("../lib/autenticacao");
  const { criarPortaDeConversas } = await import("../lib/agentes/conversas/repositorio");
  const { definirPermissaoDeFuncaoDoAgente } = await import(
    "../lib/agentes/permissoes/escrita");
  const { MARKETPLACE_POR_PLATAFORMA } = await import("../lib/agentes/conexoes/estado");
  const { lerPendenciaVivaDaConversa } = await import(
    "../lib/agentes/factory/capacidade-pendente");
  const {
    capacidadesPedidasNoTexto, detectarCapacidadeFaltante, fonteNomeadaNoTexto,
  } = await import("../lib/agentes/factory/capacidade-faltante");
  const { classificarFalha, categoriaDoBloqueio } = await import(
    "../lib/agentes/ia/falhas-de-ferramenta");
  const { DECLARACOES } = await import("../lib/agentes/ia/ferramentas");
  const rotaConversa = await import(
    "../app/api/agentes/[agenteId]/conversas/[conversaId]/route");

  const MKT_ML = MARKETPLACE_POR_PLATAFORMA["mercado_livre"] as string;
  const portaC = criarPortaDeConversas(db);
  const cookie = `${COOKIE_SESSAO}=${(await emitirTokenSessao(DONO)).token}`;

  async function ler(r: Response) {
    let corpo: Record<string, unknown> = {};
    try { corpo = await r.json() as Record<string, unknown>; } catch { /* vazio */ }
    return { status: r.status, corpo };
  }
  /** O MESMO POST que `enviarNaConversaDoChat` faz. */
  const enviar = async (agenteId: string, conversaId: string, texto: string) =>
    ler(await rotaConversa.POST(
      new Request(`http://local/api/agentes/${agenteId}/conversas/${conversaId}`, {
        method: "POST", headers: { cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ texto }),
      }), { params: { agenteId, conversaId } }));

  /**
   * Os PASSOS de ferramenta do turno — §21.
   *
   * A rota publica `resposta.passos`, e e a unica janela de fora para
   * saber QUAL ferramenta o provedor pediu e como cada pedido terminou.
   * Sem isso, `nome_invalido` — que nao escreve auditoria — seria
   * invisivel, e foi exatamente ele que escondeu o segundo passo do bug.
   */
  const passosDe = (corpo: Record<string, unknown>) => {
    const resposta = corpo.resposta as { passos?: unknown[] } | undefined;
    return ((resposta?.passos ?? []) as {
      funcaoId?: string; desfecho?: string; codigo?: string | null;
    }[]);
  };

  console.log("══ F7b.4.8.2 — fonte nomeada e bloqueio terminal (OpenAI real) ══");

  try {
    await limpar(db);

    for (const [id, nome] of [
      [AGENTE_COM, "ZZ FIXTURE vendas ml f4882"],
      [AGENTE_SEM, "ZZ FIXTURE sem ml f4882"],
    ] as const) {
      await db.from("agentes").upsert({
        id, user_id: DONO, nome, tipo: "personalizado", ativo: true,
        provedor_ia: "openai", memoria_ativa: true,
        instrucoes: "Voce responde sobre vendas. Seja curto e direto.",
      }, { onConflict: "id" });
    }
    await db.from("lojas").upsert({
      id: LOJA, user_id: DONO, marketplace: MKT_ML, nome: "Loja Fixture ML",
      nickname: "FIXTUREML2", seller_id: "666000111",
      ativo: true, access_token: "fixture-nao-e-token-real",
      refresh_token: "fixture-nao-e-refresh-real",
      token_expires_at: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
    }, { onConflict: "id" });
    for (const recurso of ["vendas", "perguntas"]) {
      await db.from("agente_conexoes").insert({
        user_id: DONO, agente_id: AGENTE_COM,
        plataforma: "mercado_livre", recurso, loja_id: LOJA,
      });
    }
    for (const funcaoId of [
      "mercadolivre.perguntas.listar", "mercadolivre.vendas.consultar",
    ]) {
      await definirPermissaoDeFuncaoDoAgente({
        userId: DONO, agenteId: AGENTE_COM, funcaoId, nivel: "automatico",
      });
    }
    for (const funcaoId of [
      "planilha.inspecionar", "planilha.ler", "planilha.agregar",
    ]) {
      await definirPermissaoDeFuncaoDoAgente({
        userId: DONO, agenteId: AGENTE_SEM, funcaoId, nivel: "automatico",
      });
    }

    // ═══ A. A fonte NOMEADA e detectada e manda — §3/§8 ══════════════

    secao("A. Quem nomeia a fonte escolheu a fonte — §3/§8/§15");
    {
      ok("A1  a frase do Rodrigo tem fonte NOMEADA",
        fonteNomeadaNoTexto(PERGUNTA) === "mercadolivre-perguntas",
        String(fonteNomeadaNoTexto(PERGUNTA)));
      ok("A2  e a generica NAO tem — §15 mensagem B",
        fonteNomeadaNoTexto(GENERICA) === null,
        String(fonteNomeadaNoTexto(GENERICA)));
      for (const frase of [
        "quanto vendi hoje no mercado livre?",
        "me fale o faturamento da semana no ML",
        "quantos pedidos tive no Mercado Livre?",
      ]) {
        ok(`A3  "${frase.slice(0, 30)}..." tambem nomeia o Mercado Livre`,
          fonteNomeadaNoTexto(frase) === "mercadolivre-perguntas",
          String(fonteNomeadaNoTexto(frase)));
      }

      // §17: prova NEGATIVA de candidatos.
      const pedidas = capacidadesPedidasNoTexto(PERGUNTA);
      ok("A4  a frase resolve para UM pack, o do marketplace",
        pedidas.length === 1 && pedidas[0]?.packId === "mercadolivre-perguntas",
        pedidas.map((p) => p.packId).join(","));
      ok("A5  §17: `vendas` — ZERO candidatos",
        pedidas.every((p) => p.packId !== "vendas"));

      // Agente SEM o pack: a oferta e SO Mercado Livre — nem HubSpot, nem
      // Salesforce, nem a base da CDS.
      const oferta = await detectarCapacidadeFaltante({
        texto: PERGUNTA, nomesQueJaTem: ["Planilhas", "Calculadora"],
      });
      ok("A6  falta capacidade, e ha oferta",
        oferta.desfecho === "falta_capacidade", oferta.desfecho);
      const chaves = oferta.desfecho === "falta_capacidade"
        ? oferta.opcoes.map((o) => o.chave) : [];
      ok("A7  §9: a UNICA opcao e o Mercado Livre",
        chaves.length === 1 && chaves[0] === "mercadolivre-perguntas",
        chaves.join(","));
      ok("A8  §17: HubSpot — ZERO candidatos", !chaves.includes("hubspot"), chaves.join(","));
      ok("A9  §17: Salesforce — ZERO candidatos",
        !chaves.includes("salesforce"), chaves.join(","));
      ok("A10 §17: Vendas da CDS — ZERO candidatos",
        !chaves.includes("vendas"), chaves.join(","));

      // §15 mensagem B: sem fonte nomeada, o comportamento antigo fica.
      const generica = await detectarCapacidadeFaltante({
        texto: GENERICA, nomesQueJaTem: ["Planilhas"],
      });
      ok("A11 §15: sem fonte nomeada, a busca ampla CONTINUA valendo",
        generica.desfecho === "falta_capacidade" &&
          generica.opcoes.some((o) => o.origem === "integracao"),
        generica.desfecho === "falta_capacidade"
          ? generica.opcoes.map((o) => o.chave).join(",") : generica.desfecho);
      ok("A12 ANCORA: e ela oferece a base da CDS, que e uma fonte legitima",
        generica.desfecho === "falta_capacidade" &&
          generica.opcoes.some((o) => o.chave === "vendas"));
    }

    // ═══ B. §10: quem JA tem a fonte nao recebe oferta ══════════════

    secao("B. O agente que JA tem a fonte — §10/§12/§16");
    {
      // O bug B do Rodrigo: "consulte as vendas" num agente cuja unica
      // fonte de vendas e o Mercado Livre oferecia CDS, HubSpot e
      // Salesforce. Ele ja tinha como responder.
      const jaTem = await detectarCapacidadeFaltante({
        texto: GENERICA, nomesQueJaTem: ["Mercado Livre"],
      });
      ok("B1  §10: quem ja tem Mercado Livre NAO recebe oferta de vendas",
        jaTem.desfecho === "nada_falta", jaTem.desfecho);

      const jaTemNomeada = await detectarCapacidadeFaltante({
        texto: PERGUNTA, nomesQueJaTem: ["Mercado Livre"],
      });
      ok("B2  e com a frase NOMEADA tambem nao",
        jaTemNomeada.desfecho === "nada_falta", jaTemNomeada.desfecho);

      // CONTROLE: quem nao tem NADA de vendas continua recebendo oferta.
      const semNada = await detectarCapacidadeFaltante({
        texto: GENERICA, nomesQueJaTem: ["Planilhas"],
      });
      ok("B3  CONTROLE: quem nao tem fonte de vendas AINDA recebe oferta",
        semNada.desfecho === "falta_capacidade", semNada.desfecho);
    }

    // ═══ C. A pergunta do §26.1, na rota real, com OpenAI ═══════════

    secao("C. A pergunta do Rodrigo, rota real, OpenAI real — §22/§26");
    {
      const conversa = await portaC.criarConversa(DONO, AGENTE_COM, null);
      const r = await enviar(AGENTE_COM, conversa.id, PERGUNTA);
      ok("C1  a rota responde 200", r.status === 200, String(r.status));

      const passos = passosDe(r.corpo);
      console.log(`    passos: ${passos.map((p) =>
        `${p.funcaoId}=${p.desfecho}${p.codigo ? `/${p.codigo}` : ""}`).join(" | ") || "nenhum"}`);
      console.log(`    motivo=${String(r.corpo.motivo)} categoria=${String(r.corpo.categoriaDoBloqueio)}`);

      // A primeira falha: argumento ambiguo. Nao pode mais acontecer.
      ok("C2  NENHUM passo termina em `filtro_ambiguo`",
        !passos.some((p) => p.codigo === "filtro_ambiguo"),
        passos.map((p) => String(p.codigo)).join(","));
      ok("C3  nem em `entrada_invalida`",
        !passos.some((p) => p.desfecho === "entrada_invalida"),
        passos.map((p) => String(p.desfecho)).join(","));

      // A segunda: o modelo pedindo ferramenta que nao tem NAO mata o turno.
      ok("C4  e `nome_invalido` nao fecha mais o turno",
        !(passos.some((p) => p.desfecho === "nome_invalido") &&
          r.corpo.motivo === "bloqueado_por_ferramenta"),
        `${passos.map((p) => String(p.desfecho)).join(",")} / ${String(r.corpo.motivo)}`);

      // A ferramenta certa foi pedida.
      ok("C5  a Funcao oficial do Mercado Livre foi pedida",
        passos.some((p) => p.funcaoId === "mercadolivre.vendas.consultar"),
        passos.map((p) => String(p.funcaoId)).join(","));
      ok("C6  e NENHUMA outra fonte de vendas foi tentada — §11",
        !passos.some((p) => p.funcaoId === "vendas.consultar"),
        passos.map((p) => String(p.funcaoId)).join(","));

      // ── §12/§13: se parou, a causa e a CERTA ────────────────────
      //
      // A fixture nao tem credencial de verdade, e o guard exige cobertura
      // CONFIRMADA — que so uma chamada real ao Mercado Livre concede. Ela
      // para em `conexao_ausente`, e isso esta correto.
      //
      // O que este gate cobra e a classificacao: `interno` era a frase
      // generica que o Rodrigo leu, e ela significa "o problema e nosso".
      // Parar por conexao tem de dizer conexao.
      ok("C7  a categoria NAO e `interno` — o problema nao e generico",
        r.corpo.motivo !== "bloqueado_por_ferramenta" ||
          r.corpo.categoriaDoBloqueio !== "interno",
        `${String(r.corpo.motivo)} / ${String(r.corpo.categoriaDoBloqueio)}`);
      ok("C7a e a fonte NAO foi trocada pela base da CDS — §11",
        !passos.some((p) => p.funcaoId === "vendas.consultar"),
        passos.map((p) => String(p.funcaoId)).join(","));

      // §12: e nenhum cartao aparece — a capacidade existe.
      const pend = await lerPendenciaVivaDaConversa({
        userId: DONO, conversaId: conversa.id,
      });
      ok("C8  §12: NENHUM cartao de ferramenta aparece",
        pend.leitura === "ok" && pend.pendencia === null,
        String(pend.leitura === "ok" ? pend.pendencia?.necessidade : pend.leitura));

      const texto = (r.corpo.resposta as { conteudo?: string } | undefined)?.conteudo ?? "";
      ok("C9  e o agente NAO inventou numero", !/R\$\s?\d/.test(texto),
        texto.slice(0, 140));
    }

    // ═══ D. As demais frases do §26 ═════════════════════════════════

    secao("D. As outras frases obrigatorias — §26");
    {
      for (const frase of [
        "quanto vendi hoje no mercado livre?",
        "me fale o faturamento da semana no ML",
        "quantos pedidos tive no Mercado Livre?",
      ]) {
        const conversa = await portaC.criarConversa(DONO, AGENTE_COM, null);
        const r = await enviar(AGENTE_COM, conversa.id, frase);
        const passos = passosDe(r.corpo);
        ok(`D1  "${frase.slice(0, 32)}..." nao morre por argumento`,
          r.status === 200 &&
            !passos.some((p) => p.desfecho === "entrada_invalida"),
          `${r.status} ${passos.map((p) => `${p.funcaoId}=${p.desfecho}`).join(",")}`);
        const pend = await lerPendenciaVivaDaConversa({
          userId: DONO, conversaId: conversa.id,
        });
        ok(`D2  e nao oferece ferramenta nova`,
          pend.leitura === "ok" && pend.pendencia === null,
          String(pend.leitura === "ok" ? pend.pendencia?.necessidade : ""));
      }
    }

    // ═══ E. §16: o par com e sem a ferramenta ═══════════════════════

    secao("E. Agente SEM Mercado Livre — exatamente UMA oferta");
    {
      const conversa = await portaC.criarConversa(DONO, AGENTE_SEM, null);
      const r = await enviar(AGENTE_SEM, conversa.id, PERGUNTA);
      ok("E1  responde 200", r.status === 200, String(r.status));

      const pend = await lerPendenciaVivaDaConversa({
        userId: DONO, conversaId: conversa.id,
      });
      ok("E2  e recebe UMA oferta",
        pend.leitura === "ok" && pend.pendencia !== null);
      const opcoes = pend.leitura === "ok" ? pend.pendencia?.opcoes ?? [] : [];
      ok("E3  a necessidade e Mercado Livre",
        pend.leitura === "ok" && pend.pendencia?.necessidade === "Mercado Livre",
        String(pend.leitura === "ok" ? pend.pendencia?.necessidade : ""));
      ok("E4  §9: a UNICA opcao e o Mercado Livre",
        opcoes.length === 1 && opcoes[0]?.chave === "mercadolivre-perguntas",
        opcoes.map((o) => o.chave).join(","));
      ok("E5  §17: sem Vendas da CDS, sem HubSpot, sem Salesforce",
        !opcoes.some((o) => ["vendas", "hubspot", "salesforce"].includes(o.chave)),
        opcoes.map((o) => o.chave).join(","));
      ok("E6  o objetivo congelado e a pergunta ORIGINAL",
        pend.leitura === "ok" && pend.pendencia?.objetivo === PERGUNTA);
    }

    // ═══ F. A declaracao ao provedor nao convida ao erro ════════════

    secao("F. O schema nao oferece dois caminhos que se excluem");
    {
      const decl = DECLARACOES["mercadolivre.vendas.consultar"];
      ok("F1  a Funcao continua declarada ao provedor", decl !== undefined);
      const schema = (decl?.schemaEntrada ?? {}) as {
        properties?: Record<string, unknown>; required?: string[];
      };
      const props = Object.keys(schema.properties ?? {});
      ok("F2  o modelo so pode mandar `periodo` — a CDS resolve as datas",
        JSON.stringify(props) === JSON.stringify(["periodo"]), props.join(","));
      ok("F3  e `periodo` e OBRIGATORIO — `{}` deixa de ser possivel",
        JSON.stringify(schema.required ?? []) === JSON.stringify(["periodo"]),
        JSON.stringify(schema.required));
      // ── F7b.4.8.3: o enum SAIU, e de proposito ────────────────────
      //
      // Enquanto `periodo` era um enum de sete nomes, "me traz os ultimos
      // 7 dias" e "de 10/09 a 20/09" nao caberiam nele. Agora e texto
      // livre, e quem resolve e `periodo-em-texto.ts`. A ancora passa a
      // cobrar o contrato novo: existe, e string, e NAO restringe.
      const p = (schema.properties as
        { periodo?: { type?: unknown; enum?: unknown[] } })?.periodo;
      ok("F4  ANCORA: `periodo` existe e e string", p?.type === "string",
        String(p?.type));
      ok("F4a e NAO tem enum — a pessoa fala como quiser",
        !Array.isArray(p?.enum), JSON.stringify(p?.enum));

      // O segundo passo do bug: o modelo pediu ferramenta que nao tinha, a
      // cerca barrou, e o TURNO MORREU — com a frase de categoria
      // `interno`, a um passo de uma chamada correta.
      ok("F5  §13: pedir ferramenta inexistente e CORRIGIVEL",
        classificarFalha("nome_invalido", "nome_invalido") === "corrigivel");
      ok("F6  e por isso nao fecha mais o turno como problema nosso",
        classificarFalha("nome_invalido", "nome_invalido") !== "fecha_o_turno");
      ok("F7  CONTROLE: permissao e conexao continuam FECHANDO",
        classificarFalha("negado", "permissao_bloqueada") === "fecha_o_turno" &&
          classificarFalha("negado", "conexao_ausente") === "fecha_o_turno");
      ok("F8  CONTROLE: e a categoria delas nunca e `interno`",
        categoriaDoBloqueio("negado", "permissao_bloqueada") === "permissao" &&
          categoriaDoBloqueio("negado", "conexao_ausente") === "conexao");
      ok("F9  o argumento ambiguo deixou de ser possivel pelo schema",
        !Object.keys(schema.properties ?? {}).includes("de") &&
          !Object.keys(schema.properties ?? {}).includes("ate"));
    }

    // ═══ G. O elo real: o argumento do modelo na API oficial — §19 ═══

    secao("G. O argumento que o modelo manda hoje, na API oficial");
    {
      const { data: linha } = await db.from("lojas")
        .select("user_id").eq("id", LOJA_REAL).maybeSingle();
      const donoReal = String((linha as { user_id?: string } | null)?.user_id ?? "");
      ok("G1  a loja autorizada existe", donoReal !== "");

      if (donoReal !== "") {
        const { criarLeiturasDeVendasML } = await import(
          "../lib/agentes/dados/vendas-ml");
        const { semCamposNulos } = await import(
          "../lib/agentes/ia/argumentos-do-modelo");

        // EXATAMENTE o que o schema novo permite: `periodo` e nada mais.
        const argumento = semCamposNulos({ periodo: "semana_passada" });
        const destinos: string[] = [];
        const espiao: typeof fetch = (e, i) => {
          destinos.push(String(e));
          return fetch(e as RequestInfo, i);
        };
        const r = await criarLeiturasDeVendasML(
          donoReal, LOJA_REAL, Date.now(), undefined, { buscar: espiao }
        )(argumento as { periodo?: "semana_passada" });

        ok("G2  a consulta oficial ACEITA o argumento do modelo",
          r.erro === null, String(r.erro));
        ok("G3  §19: a chamada foi para api.mercadolibre.com",
          destinos.length >= 1 &&
            destinos.every((d) => d.startsWith("https://api.mercadolibre.com/orders/search")),
          destinos.map((d) => d.split("?")[0]).join(" | "));
        ok("G4  e NENHUMA para o Supabase — a fonte nao e o banco",
          !destinos.some((d) => d.includes("supabase")));
        ok("G5  a fonte declarada e a API do Mercado Livre",
          r.fonte === "mercadolivre_api", r.fonte);
        ok("G5a a varredura COMPLETOU — §11",
          r.completo === true && r.totais !== null,
          `completo=${String(r.completo)} parcial=${JSON.stringify(r.parcial)}`);
        ok("G6  houve pedido pago no periodo — resposta real",
          (r.totais?.pedidos ?? 0) > 0, String(r.totais?.pedidos));
        ok("G7  e o periodo foi resolvido pela CDS",
          r.periodo.de !== "" && r.periodo.de < r.periodo.ate,
          `${r.periodo.de}..${r.periodo.ate}`);
      }
    }

  } finally {
    secao("Limpeza");
    await limpar(db);
    const { count: vivas } = await db.from("lojas")
      .select("id", { count: "exact", head: true }).eq("user_id", DONO).eq("ativo", true);
    const { count: pend } = await db.from("agente_capacidades_pendentes")
      .select("id", { count: "exact", head: true }).eq("user_id", DONO);
    ok("Z1  nenhuma loja fixture continua ATIVA", (vivas ?? 0) === 0, String(vivas));
    ok("Z2  nenhuma pendencia sobrou", (pend ?? 0) === 0, String(pend));
    console.log(`\nPASS ${pass}   FAIL ${fail}`);
    process.exit(fail === 0 ? 0 : 1);
  }
}

void main();
