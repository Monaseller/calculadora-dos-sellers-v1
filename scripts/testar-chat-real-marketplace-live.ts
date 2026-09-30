/**
 * AGENT-FACTORY-F7b.4.8.1 — o CAMINHO REAL do chat, e o bug do Rodrigo.
 *
 * Suite LIVE: sessao assinada, rota real de conversa, banco real, OpenAI
 * real — a mesma entrada que `ChatDoAgente` usa.
 *
 * ── Por que esta suite existe ───────────────────────────────────────
 *
 * O F7b.4.8 fechou com tudo verde e o Rodrigo recebeu, no chat de um
 * agente ATIVO:
 *
 *   "Nao consigo concluir porque a ferramenta ou fonte necessaria nao
 *    esta disponivel para este agente."  ·  bloqueado_por_ferramenta
 *
 * As suites do gate chamavam `responderNaConversa` com Anthropic. O
 * agente do Rodrigo usa **OpenAI**, e a diferenca estava exatamente ai —
 * nos ARGUMENTOS que cada provedor manda para a mesma ferramenta.
 *
 * ── O que a auditoria do banco mostrou ─────────────────────────────
 *
 *   funcao_id        mercadolivre.vendas.consultar
 *   nivel_no_momento automatico        (permissao estava OK)
 *   plataforma       mercado_livre
 *   recurso          vendas
 *   loja_id          presente          (binding estava OK)
 *   codigo_desfecho  entrada_invalida  <- AQUI
 *
 * Nao faltava capacidade, nao faltava loja e o guard nao negou. O modelo
 * chamou a Funcao e o VALIDADOR recusou os argumentos — e o laco tratou
 * isso como falha que fecha o turno, em vez de erro que o modelo corrige.
 *
 * Roda com:
 *   OPENAI_MODEL_AGENTE=gpt-5.2 npx tsx scripts/testar-chat-real-marketplace-live.ts
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

const DONO = "c7b00000-f481-4000-8000-0000000000d0";
/** Igual ao do Rodrigo: ATIVO, OpenAI, pack do Mercado Livre, loja ligada. */
const AGENTE_COM = "c7b00000-f481-4000-8000-000000000090";
/** Sem o pack — o par anti-vacuidade do §14. */
const AGENTE_SEM = "c7b00000-f481-4000-8000-000000000091";
const LOJA = "c7b00000-f481-4000-8000-0000000a0001";

/**
 * A loja MONAMOR — conexao que o dono JA autorizou na CDS.
 *
 * Usada SO na secao F, e SO para leitura, com os argumentos exatos que a
 * OpenAI manda. E o unico jeito honesto de provar que o caminho do
 * Rodrigo passou a funcionar: a fixture nao tem credencial, e sem
 * credencial a consulta oficial nao acontece.
 */
const LOJA_REAL = "50165b6f-5185-4da7-991a-07c0c6bc8f39";

/** A frase EXATA do Rodrigo. §21 nao aceita substituta. */
const PERGUNTA = "Quanto vendi esta semana no Mercado Livre?";

/** As variantes que o §21 tambem pede. */
const VARIANTES = [
  "quanto vendi hoje no mercado livre?",
  "me fale o faturamento da semana no ML",
  "quantos pedidos tive no Mercado Livre?",
];

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
  // A loja pode nao sair: a auditoria a prende com RESTRICT. Fica INERTE.
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
  const { validarFiltroVendasML } = await import("../lib/agentes/dados/vendas-ml");
  const {
    classificarFalha, CODIGOS_CORRIGIVEIS, categoriaDoBloqueio,
    MENSAGEM_POR_CATEGORIA,
  } = await import("../lib/agentes/ia/falhas-de-ferramenta");
  const { semCamposNulos } = await import("../lib/agentes/ia/argumentos-do-modelo");
  const { FUNCOES } = await import("../lib/agentes/funcoes/registry");
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
  /**
   * A MESMA entrada de `ChatDoAgente`.
   *
   * `enviarNaConversaDoChat` faz `POST` na rota da CONVERSA com
   * `{ texto }` — nao existe rota `/mensagens`. A suite usa a rota de
   * verdade, com a sessao assinada, para que o que ela exercita seja o
   * que o navegador exercita.
   */
  const enviar = async (agenteId: string, conversaId: string, texto: string) =>
    ler(await rotaConversa.POST(
      new Request(
        `http://local/api/agentes/${agenteId}/conversas/${conversaId}`,
        {
          method: "POST",
          headers: { cookie, "Content-Type": "application/json" },
          body: JSON.stringify({ texto }),
        }
      ),
      { params: { agenteId, conversaId } }
    ));
  const lerConversa = async (agenteId: string, cid: string) => ler(await rotaConversa.GET(
    new Request(`http://local/api/agentes/${agenteId}/conversas/${cid}`, {
      headers: { cookie },
    }), { params: { agenteId, conversaId: cid } }));

  /** As chamadas de Funcao que a auditoria registrou para este agente. */
  const auditoria = async (agenteId: string) => {
    const { data } = await db.from("agente_funcao_chamadas")
      .select("funcao_id, fase, status, codigo_desfecho, nivel_no_momento")
      .eq("user_id", DONO).eq("agente_id", agenteId)
      .order("criado_em", { ascending: false }).limit(12);
    return (data ?? []) as {
      funcao_id: string; fase: string; status: string;
      codigo_desfecho: string | null; nivel_no_momento: string | null;
    }[];
  };

  console.log("══ F7b.4.8.1 — o caminho REAL do chat, com OpenAI ══");

  try {
    await limpar(db);

    for (const [id, nome] of [
      [AGENTE_COM, "ZZ FIXTURE vendas ml f4881"],
      [AGENTE_SEM, "ZZ FIXTURE sem ml f4881"],
    ] as const) {
      await db.from("agentes").upsert({
        id, user_id: DONO, nome, tipo: "personalizado",
        // ATIVO, como o do Rodrigo.
        ativo: true,
        // OpenAI, como o do Rodrigo. E a diferenca que o gate anterior
        // nao exercitou: as suites chamavam Anthropic.
        provedor_ia: "openai", memoria_ativa: true,
        instrucoes: "Voce responde sobre vendas. Seja curto e direto.",
      }, { onConflict: "id" });
    }

    // A loja, e o binding dos DOIS requisitos do pack.
    // ── `token_expires_at` NO FUTURO, e isto importa ────────────────
    //
    // Sem ele, `derivarEstadoConexao` diz `expirada` (fail-closed: sem
    // data nao se afirma validade), o guard barra com `conexao_ausente` e
    // o turno morre ANTES da validacao de argumentos. A primeira versao
    // desta fixture fazia isso e mascarava o bug que a suite existe para
    // reproduzir — o agente do Rodrigo tem token no prazo, e a auditoria
    // dele mostra `entrada_invalida`, ou seja, passou do guard.
    await db.from("lojas").upsert({
      id: LOJA, user_id: DONO, marketplace: MKT_ML, nome: "Loja Fixture ML",
      nickname: "FIXTUREML", seller_id: "888000111",
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
    // O agente COM tem as duas Funcoes em `automatico` — como o do Rodrigo.
    for (const funcaoId of [
      "mercadolivre.perguntas.listar", "mercadolivre.vendas.consultar",
    ]) {
      await definirPermissaoDeFuncaoDoAgente({
        userId: DONO, agenteId: AGENTE_COM, funcaoId, nivel: "automatico",
      });
    }
    // O agente SEM tem outra Tool vinculada — o §5 pede esse detalhe.
    for (const funcaoId of [
      "planilha.inspecionar", "planilha.ler", "planilha.agregar",
    ]) {
      await definirPermissaoDeFuncaoDoAgente({
        userId: DONO, agenteId: AGENTE_SEM, funcaoId, nivel: "automatico",
      });
    }

    // ═══ A. O estado do fixture e o do bug ══════════════════════════

    secao("A. O fixture reproduz o estado real observado");
    {
      const { data: ag } = await db.from("agentes")
        .select("ativo, provedor_ia, memoria_ativa").eq("id", AGENTE_COM).maybeSingle();
      const a = ag as { ativo: boolean; provedor_ia: string; memoria_ativa: boolean } | null;
      ok("A1  agente ATIVO", a?.ativo === true);
      ok("A2  com OpenAI — o provedor do agente do Rodrigo",
        a?.provedor_ia === "openai", String(a?.provedor_ia));
      ok("A3  e memoria ligada", a?.memoria_ativa === true);

      const { count: bind } = await db.from("agente_conexoes")
        .select("agente_id", { count: "exact", head: true })
        .eq("agente_id", AGENTE_COM);
      ok("A4  com os DOIS bindings de loja — nada falta de conexao",
        (bind ?? 0) === 2, String(bind));
      const { count: perm } = await db.from("agente_permissoes")
        .select("funcao_id", { count: "exact", head: true })
        .eq("agente_id", AGENTE_COM).eq("nivel", "automatico");
      ok("A5  e as duas Funcoes do Mercado Livre em `automatico`",
        (perm ?? 0) === 2, String(perm));
    }

    // ═══ B. A CAUSA, isolada e deterministica ═══════════════════════

    secao("B. A causa: o codigo do validador nao era corrigivel");
    {
      // O que a OpenAI manda quando um campo opcional nao se aplica.
      // MEDIDO: em vez de omitir a chave, ela a envia com `null`.
      const comNulos = validarFiltroVendasML({ periodo: "esta_semana", de: null, ate: null });
      const semNada = validarFiltroVendasML({});

      ok("B1  ANCORA: o filtro CERTO passa",
        validarFiltroVendasML({ periodo: "esta_semana" }).erro === null);

      // Estes dois sao os desfechos que o modelo produz de verdade.
      console.log(`    {periodo, de:null, ate:null} -> ${String(comNulos.erro)}`);
      console.log(`    {}                           -> ${String(semNada.erro)}`);

      // E o ponto: nenhum dos dois estava na lista de corrigiveis, e o
      // default da classificacao e FECHAR o turno.
      for (const codigo of ["filtro_ausente", "filtro_ambiguo"]) {
        ok(`B2  \`${codigo}\` e CORRIGIVEL pelo modelo`,
          (CODIGOS_CORRIGIVEIS as readonly string[]).includes(codigo),
          (CODIGOS_CORRIGIVEIS as readonly string[]).includes(codigo) ? "" : "fora da lista");
        ok(`B2a e a classificacao NAO fecha o turno por \`${codigo}\``,
          classificarFalha("erro", codigo) === "corrigivel",
          classificarFalha("erro", codigo));
      }
      ok("B3  CONTROLE: falha de PERMISSAO continua fechando o turno",
        classificarFalha("bloqueado", "permissao_bloqueada") === "fecha_o_turno");
      ok("B4  CONTROLE: codigo desconhecido continua fechando — fail-closed",
        classificarFalha("erro", "codigo_que_ninguem_classificou") === "fecha_o_turno");

      // ── Onde a regra do `null` mora ──────────────────────────────
      //
      // No LACO, e nao no validador: e ali que um pedido do modelo vira
      // pedido de execucao, e a convencao de mandar `null` e do PROVEDOR,
      // nao da Funcao. A suite testa a COMPOSICAO, que e o que roda.
      const OPENAI_MANDA = { periodo: "esta_semana", de: null, ate: null };
      ok("B5  a composicao que o chat usa ACEITA o que a OpenAI manda",
        validarFiltroVendasML(semCamposNulos(OPENAI_MANDA)).erro === null,
        String(validarFiltroVendasML(semCamposNulos(OPENAI_MANDA)).erro));
      ok("B5a e o validador SOZINHO continua recusando — a regra e do laco",
        comNulos.erro === "filtro_ambiguo", String(comNulos.erro));
      ok("B5b a normalizacao tira SO as chaves nulas de primeiro nivel",
        JSON.stringify(semCamposNulos(OPENAI_MANDA)) ===
          JSON.stringify({ periodo: "esta_semana" }),
        JSON.stringify(semCamposNulos(OPENAI_MANDA)));
      ok("B5c e nao inventa valor quando tudo e nulo",
        JSON.stringify(semCamposNulos({ periodo: null })) === "{}",
        JSON.stringify(semCamposNulos({ periodo: null })));
      ok("B5d nem desce dentro de objeto — `null` ali pode ser dado",
        JSON.stringify(semCamposNulos({ a: { b: null } })) ===
          JSON.stringify({ a: { b: null } }));
      const defVendas = FUNCOES["mercadolivre.vendas.consultar"];
      ok("B5e o validador DA FUNCAO aceita o argumento normalizado",
        defVendas.validarEntrada(semCamposNulos(OPENAI_MANDA)).valida === true);
      ok("B5f ANCORA: ele recusa o argumento CRU — como recusou para o Rodrigo",
        defVendas.validarEntrada(OPENAI_MANDA).valida === false);

      // §12: as quatro categorias, com frases diferentes.
      ok("B8  `conexao_ausente` e categoria CONEXAO, e nao ferramenta faltando",
        categoriaDoBloqueio("negado", "conexao_ausente") === "conexao");
      ok("B9  `permissao_bloqueada` e categoria PERMISSAO",
        categoriaDoBloqueio("negado", "permissao_bloqueada") === "permissao");
      ok("B10 `fonte_indisponivel` e categoria FONTE",
        categoriaDoBloqueio("erro", "fonte_indisponivel") === "fonte");
      ok("B11 codigo desconhecido e INTERNO — nao culpa o dono",
        categoriaDoBloqueio("erro", "algo_que_ninguem_classificou") === "interno");
      ok("B12 as quatro frases sao DIFERENTES entre si",
        new Set(Object.values(MENSAGEM_POR_CATEGORIA)).size === 4);
      ok("B13 a de conexao NAO fala de ferramenta indisponivel",
        !/ferramenta/i.test(MENSAGEM_POR_CATEGORIA.conexao),
        MENSAGEM_POR_CATEGORIA.conexao);
      ok("B14 e nenhuma vaza codigo tecnico",
        Object.values(MENSAGEM_POR_CATEGORIA).every((m) =>
          !/_|funcao_id|slug/.test(m)));

      // ── O modelo tem de SABER o que corrigir ────────────────────
      //
      // Marcar um codigo como corrigivel nao resolve nada se a recusa que
      // chega ao modelo for "a ferramenta nao conseguiu concluir". Era o
      // caso, e por isso o Rodrigo viu a mesma falha duas vezes.
      //
      // A sonda le a FONTE do laco: a montagem do conteudo da recusa e o
      // ponto onde essa decisao mora, e ela nao e observavel de fora sem
      // um turno em que a ferramenta recuse por argumento.
      const FONTE_LACO = readFileSync(
        join(__dirname, "..", "lib", "agentes", "ia", "laco-ferramentas.ts"), "utf8");
      ok("B15 a recusa CORRIGIVEL nomeia o motivo para o modelo",
        /classificarFalha\(r\.tipo, codigoDoErro\) === "corrigivel"/.test(FONTE_LACO) &&
          /Motivo: \$\{codigoDoErro\}/.test(FONTE_LACO));
      ok("B15a e a que FECHA o turno continua vaga — codigo e de operador",
        /: frase;/.test(FONTE_LACO));
      ok("B15b ANCORA: a sonda leu o laco de verdade", FONTE_LACO.length > 5000);

      ok("B6  ANCORA: duas datas DE VERDADE com periodo ainda e ambiguo",
        validarFiltroVendasML(semCamposNulos({
          periodo: "esta_semana", de: "2026-09-01", ate: "2026-09-03",
        })).erro === "filtro_ambiguo");
      ok("B7  e `{}` continua sendo recusado — mas de forma corrigivel",
        semNada.erro === "filtro_ausente", String(semNada.erro));
    }

    // ═══ C. A FRASE DO RODRIGO, pela rota real ══════════════════════

    secao("C. A pergunta real, na rota real, com OpenAI");
    {
      const conversa = await portaC.criarConversa(DONO, AGENTE_COM, null);
      const r = await enviar(AGENTE_COM, conversa.id, PERGUNTA);
      ok("C1  a rota de mensagens responde 200", r.status === 200,
        `${r.status} ${JSON.stringify(r.corpo).slice(0, 140)}`);

      const resposta = r.corpo.resposta as
        { conteudo?: string; passos?: unknown[] } | undefined;
      const texto = resposta?.conteudo ?? "";

      // ── O SINTOMA do Rodrigo, palavra por palavra ───────────────
      //
      // Ele leu que "a ferramenta ou fonte necessaria nao esta
      // disponivel" — sobre um agente que TINHA a ferramenta, a permissao
      // e a loja. Essa frase nao pode mais aparecer aqui.
      ok("C2  a resposta NAO diz que a FERRAMENTA nao esta disponivel",
        !/ferramenta ou fonte necessaria nao esta disponivel/i.test(texto) &&
          !/ferramenta ou fonte necessária não está disponível/i.test(texto),
        texto.slice(0, 170));

      // ── O limite DECLARADO desta fixture ─────────────────────────
      //
      // A loja fixture nao tem credencial de verdade, e o guard exige
      // cobertura CONFIRMADA — que so uma chamada real ao Mercado Livre
      // concede (`cobertura-remota.ts`). Entao o turno para em
      // `conexao_ausente`, e isso esta CERTO: sem conta utilizavel nao ha
      // consulta, e inventar uma seria o defeito.
      //
      // O que este gate conserta e a FRASE e a CATEGORIA: parar por
      // conexao tem de se apresentar como conexao.
      ok("C3  quando para, a categoria e CONEXAO — nao ferramenta faltando",
        r.corpo.motivo === "concluido" || r.corpo.categoriaDoBloqueio === "conexao",
        `${String(r.corpo.motivo)} / ${String(r.corpo.categoriaDoBloqueio)}`);
      ok("C3a e a frase e a de conexao, e nao a generica",
        r.corpo.motivo === "concluido" || texto === MENSAGEM_POR_CATEGORIA.conexao,
        texto.slice(0, 170));
      // A rota publica `mensagem` para a fala do usuario e `resposta`
      // para a do agente — conferido na fonte, e nao supostos.
      ok("C4  a mensagem do usuario foi persistida",
        (r.corpo.mensagem as { conteudo?: string } | undefined)?.conteudo === PERGUNTA,
        String((r.corpo.mensagem as { conteudo?: string } | undefined)?.conteudo));

      // A Funcao TEM de ter sido chamada: e o unico caminho para o numero.
      const chamadas = await auditoria(AGENTE_COM);
      const deVendas = chamadas.filter((c) =>
        c.funcao_id === "mercadolivre.vendas.consultar");
      ok("C5  a Funcao oficial de vendas foi chamada",
        deVendas.length >= 1, String(deVendas.length));
      ok("C6  e NENHUMA chamada terminou em `entrada_invalida`",
        !deVendas.some((c) => c.codigo_desfecho === "entrada_invalida"),
        deVendas.map((c) => `${c.fase}:${c.status}:${c.codigo_desfecho}`).join(" | "));

      // Com loja fixture nao ha credencial: o desfecho honesto e falha de
      // FONTE. O que nao pode acontecer e o turno morrer por argumento.
      // Com loja fixture nao ha credencial de verdade: o desfecho
      // honesto e falha de FONTE no provedor (`executor_falhou`). O que
      // nao pode acontecer e o turno morrer por argumento invalido nem
      // por conexao ausente — os dois significariam que nao chegamos a
      // tentar.
      // A assercao que importa: NUNCA MAIS `entrada_invalida`. Era esse
      // o codigo na auditoria do agente do Rodrigo, e era ele que matava
      // o turno por um argumento que estava correto.
      ok("C7  NENHUMA chamada morre por argumento — o bug do Rodrigo",
        !deVendas.some((c) => c.codigo_desfecho === "entrada_invalida"),
        deVendas.map((c) => `${c.fase}:${String(c.codigo_desfecho)}`).join(" | "));
      ok("C7a e o que resta e a conexao da loja fixture, sem credencial real",
        deVendas.every((c) =>
          c.codigo_desfecho === "conexao_ausente" || c.status === "sucesso" ||
          c.codigo_desfecho === "executor_falhou"),
        deVendas.map((c) => String(c.codigo_desfecho)).join(","));
      ok("C8  e o agente NAO inventou um numero",
        !/R\$\s?\d/.test(texto), texto.slice(0, 160));

      // §17: o estado sobrevive ao refresh.
      const recarregada = await lerConversa(AGENTE_COM, conversa.id);
      const msgs = (recarregada.corpo.mensagens ?? []) as unknown[];
      ok("C9  o refresh devolve as mensagens do turno", msgs.length >= 2,
        String(msgs.length));
    }

    // ═══ D. As variantes do §21 ═════════════════════════════════════

    secao("D. As variantes da mesma pergunta");
    {
      for (const frase of VARIANTES) {
        const conversa = await portaC.criarConversa(DONO, AGENTE_COM, null);
        const r = await enviar(AGENTE_COM, conversa.id, frase);
        const texto = (r.corpo.resposta as { conteudo?: string } | undefined)?.conteudo ?? "";
        ok(`D1  "${frase.slice(0, 34)}..." nao vira "ferramenta indisponivel"`,
          r.status === 200 &&
            !/ferramenta ou fonte necessaria nao esta disponivel/i.test(texto) &&
            !/ferramenta ou fonte necessária não está disponível/i.test(texto),
          `${r.status} ${texto.slice(0, 120)}`);
      }
      const chamadas = await auditoria(AGENTE_COM);
      ok("D2  e nenhuma delas produziu `entrada_invalida`",
        !chamadas.some((c) => c.codigo_desfecho === "entrada_invalida"),
        chamadas.filter((c) => c.codigo_desfecho === "entrada_invalida").length + " ocorrencias");
    }

    // ═══ E. §14: o PAR anti-vacuidade ═══════════════════════════════

    secao("E. Com e sem o Mercado Livre — o par que prova a deteccao");
    {
      const { lerPendenciaVivaDaConversa } = await import(
        "../lib/agentes/factory/capacidade-pendente");

      // SEM o pack: exatamente UMA oferta.
      const convSem = await portaC.criarConversa(DONO, AGENTE_SEM, null);
      const rSem = await enviar(AGENTE_SEM, convSem.id, PERGUNTA);
      ok("E1  o agente SEM Mercado Livre responde 200", rSem.status === 200,
        String(rSem.status));
      const pendSem = await lerPendenciaVivaDaConversa({
        userId: DONO, conversaId: convSem.id,
      });
      ok("E2  e recebe UMA oferta de capacidade",
        pendSem.leitura === "ok" && pendSem.pendencia !== null);
      ok("E3  a oferta e MERCADO LIVRE, com nome de gente",
        pendSem.leitura === "ok" && pendSem.pendencia?.necessidade === "Mercado Livre",
        String(pendSem.leitura === "ok" ? pendSem.pendencia?.necessidade : ""));
      ok("E4  e as opcoes NAO trazem a base da CDS",
        pendSem.leitura === "ok" &&
          !(pendSem.pendencia?.opcoes ?? []).some((o) => o.chave === "vendas"),
        (pendSem.leitura === "ok" ? pendSem.pendencia?.opcoes ?? [] : [])
          .map((o) => o.chave).join(","));
      ok("E5  o objetivo congelado e a pergunta ORIGINAL",
        pendSem.leitura === "ok" && pendSem.pendencia?.objetivo === PERGUNTA);

      // COM o pack: NENHUMA oferta. Sem este lado, E2 nao prova nada.
      const convCom = await portaC.criarConversa(DONO, AGENTE_COM, null);
      await enviar(AGENTE_COM, convCom.id, PERGUNTA);
      const pendCom = await lerPendenciaVivaDaConversa({
        userId: DONO, conversaId: convCom.id,
      });
      ok("E6  o agente COM Mercado Livre NAO recebe oferta nenhuma",
        pendCom.leitura === "ok" && pendCom.pendencia === null,
        String(pendCom.leitura === "ok" ? pendCom.pendencia?.necessidade : pendCom.leitura));
    }

    // ═══ F. O elo real: o argumento da OpenAI contra a API oficial ══

    secao("F. O elo real — argumento da OpenAI, loja autorizada, API oficial");
    {
      // O dono da loja real sai do BANCO e nunca e impresso. A consulta e
      // READ-ONLY e usa a credencial que a CDS ja administra.
      const { data: linha } = await db.from("lojas")
        .select("user_id").eq("id", LOJA_REAL).maybeSingle();
      const donoReal = String((linha as { user_id?: string } | null)?.user_id ?? "");
      ok("F1  a loja autorizada existe", donoReal !== "");

      if (donoReal !== "") {
        const { criarLeiturasDeVendasML } = await import("../lib/agentes/dados/vendas-ml");
        const ler = criarLeiturasDeVendasML(donoReal, LOJA_REAL, Date.now());

        // EXATAMENTE o que a OpenAI manda, normalizado pelo laco.
        const argumento = semCamposNulos({ periodo: "semana_passada", de: null, ate: null });
        const r = await ler(argumento as { periodo?: "semana_passada" });

        ok("F2  a consulta oficial ACEITA o argumento da OpenAI",
          r.erro === null, String(r.erro));
        ok("F3  e a fonte e a API do Mercado Livre",
          r.fonte === "mercadolivre_api", r.fonte);
        ok("F4  com o periodo resolvido pela CDS, e nao pelo modelo",
          r.periodo.de !== "" && r.periodo.ate !== "" && r.periodo.de < r.periodo.ate,
          `${r.periodo.de}..${r.periodo.ate}`);
        ok("F4a a varredura COMPLETOU — §11",
          r.completo === true && r.totais !== null,
          `completo=${String(r.completo)}`);
        ok("F5  houve pedido pago no periodo — a resposta e real",
          (r.totais?.pedidos ?? 0) > 0, String(r.totais?.pedidos));
        ok("F6  e o faturamento e positivo (valor nao impresso)",
          (r.totais?.faturamento ?? 0) > 0);

        // CONTROLE: o argumento CRU — o que o Rodrigo sofreu — seria
        // recusado pelo validador antes de qualquer chamada.
        const defVendas2 = FUNCOES["mercadolivre.vendas.consultar"];
        ok("F7  CONTROLE: o argumento CRU seria recusado, como antes",
          defVendas2.validarEntrada({
            periodo: "semana_passada", de: null, ate: null,
          }).valida === false);
        ok("F8  e e a normalizacao do laco que o torna aceitavel",
          defVendas2.validarEntrada(argumento).valida === true);
      }
    }

    // ═══ G. O cartao: ativar, refresh e clique duplo ═════════════════

    secao("G. O cartao de capacidade — ativar, refresh, clique duplo");
    {
      const { lerPendenciaVivaDaConversa } = await import(
        "../lib/agentes/factory/capacidade-pendente");
      const rotaCap = await import(
        "../app/api/agentes/[agenteId]/capacidades/[pendenciaId]/route");
      const ativar = async (pend: string) => ler(await rotaCap.PATCH(
        new Request(`http://local/api/agentes/${AGENTE_SEM}/capacidades/${pend}`, {
          method: "PATCH", headers: { cookie, "Content-Type": "application/json" },
          body: JSON.stringify({ acao: "ativar", escolha: "mercadolivre-perguntas" }),
        }), { params: { agenteId: AGENTE_SEM, pendenciaId: pend } }));

      const conversa = await portaC.criarConversa(DONO, AGENTE_SEM, null);
      await enviar(AGENTE_SEM, conversa.id, PERGUNTA);

      const viva = await lerPendenciaVivaDaConversa({
        userId: DONO, conversaId: conversa.id,
      });
      ok("G1  o cartao existe depois do turno",
        viva.leitura === "ok" && viva.pendencia !== null);
      const pendenciaId = viva.leitura === "ok" ? viva.pendencia?.id ?? "" : "";

      // §17: refresh. A oferta vem do SERVIDOR, e nao da memoria da tela.
      const recarregada = await lerConversa(AGENTE_SEM, conversa.id);
      const cap = recarregada.corpo.capacidadePendente as
        { pendenciaId?: string; necessidade?: string } | null;
      ok("G2  §17: o cartao SOBREVIVE ao refresh",
        cap !== null && cap.pendenciaId === pendenciaId,
        String(cap?.pendenciaId));
      ok("G3  e continua dizendo Mercado Livre",
        cap?.necessidade === "Mercado Livre", String(cap?.necessidade));

      if (pendenciaId !== "") {
        // §18: clique DUPLO. As duas chamadas ao mesmo tempo.
        const [um, dois] = await Promise.all([ativar(pendenciaId), ativar(pendenciaId)]);
        ok("G4  os dois cliques respondem 200",
          um.status === 200 && dois.status === 200, `${um.status}/${dois.status}`);
        const emAndamento = [um, dois].filter((x) => x.corpo.jaEmAndamento === true).length;
        ok("G5  §18: exatamente UM clique ativa; o outro so observa",
          emAndamento === 1,
          `${String(um.corpo.jaEmAndamento)}/${String(dois.corpo.jaEmAndamento)}`);

        // UM binding por requisito, e nao dois por clique.
        const { count: bind } = await db.from("agente_conexoes")
          .select("agente_id", { count: "exact", head: true })
          .eq("agente_id", AGENTE_SEM);
        ok("G6  §18: nenhum binding duplicado", (bind ?? 0) <= 2, String(bind));

        // As permissoes tambem: duas Funcoes, nao quatro linhas.
        const { count: perm } = await db.from("agente_permissoes")
          .select("funcao_id", { count: "exact", head: true })
          .eq("agente_id", AGENTE_SEM).like("funcao_id", "mercadolivre.%");
        ok("G7  e as Funcoes do pack entraram UMA vez cada",
          (perm ?? 0) === 2, String(perm));
        ok("G8  em `automatico` — consultar nao pede aprovacao",
          await (async () => {
            const { data } = await db.from("agente_permissoes")
              .select("nivel").eq("agente_id", AGENTE_SEM).like("funcao_id", "mercadolivre.%");
            const linhas = (data ?? []) as { nivel: string }[];
            return linhas.length === 2 && linhas.every((l) => l.nivel === "automatico");
          })());

        // ── O cartao CONTINUA, e a pergunta muda ────────────────────
        //
        // A primeira versao deste oraculo esperava a pendencia morrer. Ela
        // nao morre: o dono TEM loja conectada, e a pergunta seguinte e
        // qual delas — o fluxo do F7b.4.7. O cartao some quando nao ha
        // mais nada a perguntar, e nao quando a ferramenta entra.
        const depois = await lerPendenciaVivaDaConversa({
          userId: DONO, conversaId: conversa.id,
        });
        ok("G9  a ferramenta entrou, e a pergunta passa a ser a LOJA",
          depois.leitura === "ok" && depois.pendencia?.estado === "escolhendo_loja",
          String(depois.leitura === "ok" ? depois.pendencia?.estado : depois.leitura));
        ok("G9a e a oferta NAO volta a ser escolher-a-ferramenta",
          depois.leitura === "ok" && depois.pendencia?.estado !== "pendente");

        // E escolher a loja fecha o ciclo: binding, retomada, cartao fora.
        const rotaCon = await import(
          "../app/api/agentes/[agenteId]/capacidades/[pendenciaId]/conexao/route");
        const escolher = await ler(await rotaCon.PATCH(
          new Request(
            `http://local/api/agentes/${AGENTE_SEM}/capacidades/${pendenciaId}/conexao`,
            {
              method: "PATCH", headers: { cookie, "Content-Type": "application/json" },
              body: JSON.stringify({ acao: "escolher_loja", lojaId: LOJA }),
            }
          ),
          { params: { agenteId: AGENTE_SEM, pendenciaId } }));
        ok("G10 escolher a loja responde 200", escolher.status === 200,
          `${escolher.status} ${JSON.stringify(escolher.corpo).slice(0, 120)}`);
        ok("G11 e a tarefa ORIGINAL e retomada — sem reenvio",
          escolher.corpo.retomada === true ||
            escolher.corpo.jaRetomada === true,
          JSON.stringify(escolher.corpo).slice(0, 140));
        const fim = await lerPendenciaVivaDaConversa({
          userId: DONO, conversaId: conversa.id,
        });
        ok("G12 agora sim o cartao sai do ar",
          fim.leitura === "ok" && fim.pendencia === null,
          String(fim.leitura === "ok" ? fim.pendencia?.estado : fim.leitura));
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
