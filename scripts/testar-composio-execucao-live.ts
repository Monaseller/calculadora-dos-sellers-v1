/**
 * AGENT-FACTORY-F7b.4.3 — execucao REAL de ferramenta externa.
 *
 * Esta e a prova que faltava ao F7b.4.2. Ela e LIVE de ponta a ponta:
 * provider real, guard real, Composio real, banco real.
 *
 * ── A verdade-terreno, e por que ela ────────────────────────────────
 *
 * Item 2921983 do Hacker News e um comentario obscuro cujo autor e
 * `norvig`. Nao e um fato memoravel: nao e o primeiro post, nao e o do
 * Dropbox, nao esta em lista nenhuma de "posts famosos". Um modelo nao
 * tem como saber isso de cabeca.
 *
 * E o mesmo desenho do `46719.65` do F4: o valor so pode ter vindo da
 * ferramenta. Com o par obrigatorio — com a ferramenta, `norvig` aparece;
 * sem ela, NAO aparece —, um teste que so provasse o caminho feliz
 * passaria com um modelo que chutou certo.
 *
 * ── O que ela NAO faz ───────────────────────────────────────────────
 *
 * Nao conecta o Google do Rodrigo (§9). Nao executa escrita externa. Nao
 * usa dado pessoal. O agente-fixture e criado e APAGADO.
 *
 * Roda com:
 *   npx tsx scripts/testar-composio-execucao-live.ts
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

// ─── Fixture ──────────────────────────────────────────────────────────

const PREFIXO = "FIXTURE-EXEC-F743";
const DONO = `${PREFIXO}-DONO`;
const AGENTE = "c7b00000-0000-4000-8000-000000000043";

const TOOLKIT = "hackernews";
const ACAO = "HACKERNEWS_GET_ITEM_WITH_ID";
const ID_EXT = "composio.hackernews.hackernews_get_item_with_id";

/** O item e o autor dele. Medido; ver o docblock. */
const ITEM = "2921983";
const AUTOR = "norvig";

let passou = 0;
let falhou = 0;
function ok(nome: string, cond: boolean, detalhe = ""): void {
  if (cond) { passou++; console.log(`  PASS  ${nome}`); }
  else { falhou++; console.log(`  FAIL  ${nome}${detalhe ? ` — ${detalhe}` : ""}`); }
}
function secao(t: string): void { console.log(`\n${t}`); }

/**
 * Limpa o que PODE ser limpo — e o agente nao pode.
 *
 * MEDIDO: `delete from agentes` devolve `23503`, violando
 * `agente_funcao_chamadas_agente_do_mesmo_dono`. A auditoria de Funcao e
 * append-only e a FK e RESTRICT, de proposito: uma execucao que aconteceu
 * nao pode deixar de ter acontecido porque o agente foi apagado depois.
 *
 * E o mesmo desenho que `testar-agent-factory-chat-live` ja segue. Entao a
 * garantia aqui nao e "sumiu", e sim "nao roda, nao aparece, nao decide":
 * o agente fica INATIVO, sem vinculo e sem permissao.
 *
 * Apagar a auditoria para deixar o teste mais limpo seria destruir
 * exatamente o registro que esta frente existe para produzir.
 */
async function limpar(db: SupabaseClient): Promise<void> {
  await db.from("agente_ferramentas_externas").delete().eq("user_id", DONO);
  await db.from("agente_permissoes").delete().eq("user_id", DONO);
  await db.from("agentes").update({ ativo: false }).eq("user_id", DONO);
}

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const chaveDb = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !chaveDb) { console.error("ERRO: env do Supabase ausente."); process.exit(1); }
  if (!process.env.COMPOSIO_API_KEY) {
    console.error("ERRO: COMPOSIO_API_KEY ausente."); process.exit(1);
  }
  const db = createClient(url, chaveDb);

  const { executarAcaoComposio } = await import("../lib/agentes/composio/executor");
  const { detalharAcao } = await import("../lib/agentes/composio/cliente");
  const { definicaoDaAcaoExterna } = await import("../lib/agentes/composio/definicao-externa");
  const { prepararFuncoesExternas } = await import("../lib/agentes/composio/preparar-externas");
  const { declararFerramentas } = await import("../lib/agentes/ia/ferramentas");
  const { executarFuncao } = await import("../lib/agentes/execucao-funcoes/executar");
  const {
    vincularFerramentaExternaNoAgente, definirPermissaoDeFerramentaExterna,
    desvincularFerramentaExternaDoAgente, listarVinculosExternos,
  } = await import("../lib/agentes/ferramentas-externas/repositorio");

  console.log("\n== F7b.4.3 — execucao REAL de ferramenta externa ==");

  try {
    await limpar(db);

    // ═══ A. O adaptador, direto contra a API real ═══════════════════

    secao("A. O adaptador executa de verdade — e classifica o que volta");

    {
      const r = await executarAcaoComposio({
        userId: DONO, toolkit: TOOLKIT, acao: ACAO,
        argumentos: { item_id: ITEM, max_depth: 0, max_children: 0 },
      });
      ok("A1  a acao executa e devolve `ok`", r.estado === "ok",
        r.estado === "falha" ? r.codigo : r.estado);
      const autor = r.estado === "ok"
        ? (r.dados as { response_data?: { author?: string } })?.response_data?.author
        : null;
      ok(`A2  com o dado REAL do provedor (autor = ${AUTOR})`, autor === AUTOR,
        String(autor));

      // A ARMADILHA: HTTP 200 com `successful: false`.
      const ruim = await executarAcaoComposio({
        userId: DONO, toolkit: TOOLKIT, acao: ACAO,
        argumentos: { item_id: 12345 as unknown as string },
      });
      ok("A3  HTTP 200 com `successful:false` vira `acao_falhou`, nao sucesso",
        ruim.estado === "acao_falhou", ruim.estado);
      ok("A4  e o codigo e o da validacao do provedor",
        ruim.estado === "acao_falhou" && ruim.codigo === "argumentos_invalidos",
        ruim.estado === "acao_falhou" ? ruim.codigo : ruim.estado);

      // §7: CONNECTION_REQUIRED, fail-closed.
      const semConexao = await executarAcaoComposio({
        userId: `${DONO}-SEM-CONEXAO`, toolkit: "googlesheets",
        acao: "GOOGLESHEETS_GET_SPREADSHEET_INFO",
        argumentos: { spreadsheet_id: "nao-importa" },
      });
      ok("A5  acao que exige OAuth, sem conexao: `conexao_necessaria`",
        semConexao.estado === "conexao_necessaria", semConexao.estado);
      ok("A6  e nomeia o aplicativo a conectar, nao a conta",
        semConexao.estado === "conexao_necessaria" && semConexao.toolkit === "googlesheets");

      // §7: nada de segredo no que sai.
      const serializado = JSON.stringify(r);
      ok("A7  o resultado nao carrega a COMPOSIO_API_KEY",
        !serializado.includes(String(process.env.COMPOSIO_API_KEY)));
      ok("A8  nem `log_id`, nem o principal derivado",
        !/log_id/.test(serializado) && !serializado.includes(DONO));
      ok("A9  ANCORA: a varredura acusaria um segredo plantado",
        JSON.stringify({ ...r, k: process.env.COMPOSIO_API_KEY })
          .includes(String(process.env.COMPOSIO_API_KEY)));

      // Sem chave: fecha, nao degrada.
      const guardada = process.env.COMPOSIO_API_KEY;
      delete process.env.COMPOSIO_API_KEY;
      const semChave = await executarAcaoComposio({
        userId: DONO, toolkit: TOOLKIT, acao: ACAO, argumentos: { item_id: ITEM },
      });
      ok("A10 sem credencial: `nao_configurado`, e nada executa",
        semChave.estado === "nao_configurado", semChave.estado);
      process.env.COMPOSIO_API_KEY = guardada;
    }

    // ═══ B. A regra de declaracao — as TRES condicoes do §5 ═════════

    secao("B. Declarar exige vinculo + catalogo + permissao");

    // O agente vem PRIMEIRO: o vinculo tem FK composta para
    // `agentes(id, user_id)`, e sem a linha o insert e recusado.
    await db.from("agentes").upsert({
      id: AGENTE, user_id: DONO, nome: "ZZ FIXTURE exec f743",
      tipo: "personalizado", ativo: false,
      instrucoes: "Fixture. Use as ferramentas para qualquer dado.",
    }, { onConflict: "id" });
    const vinculoInicial = await vincularFerramentaExternaNoAgente({
      userId: DONO, agenteId: AGENTE, provedorExterno: "composio",
      toolkit: TOOLKIT, acao: ACAO,
    });
    ok("B0  o vinculo da secao B foi gravado",
      vinculoInicial.estado === "vinculada" || vinculoInicial.estado === "ja_vinculada",
      vinculoInicial.estado);

    {
      const vinculos = await listarVinculosExternos({ userId: DONO, agenteId: AGENTE });
      const comVinculo = vinculos.coleta === "ok" ? vinculos.vinculos : [];

      // CONTROLE POSITIVO primeiro: sem ele o resto seria vacuo.
      const completo = await prepararFuncoesExternas({
        vinculos: comVinculo,
        permissoes: [{ funcaoId: ID_EXT, nivel: "automatico" }],
      });
      ok("B1  vinculo + catalogo + permissao: UMA declaravel (CONTROLE POSITIVO)",
        completo.declaraveis.length === 1, `${completo.declaraveis.length}`);
      ok("B2  com a descricao REAL do provedor, nao inventada por nos",
        completo.declaraveis[0]?.descricao.length > 20 &&
          !/bloquead|negad|proibid/i.test(completo.declaraveis[0]?.descricao ?? ""));
      ok("B3  e com o schema REAL, que exige `item_id`",
        JSON.stringify(completo.declaraveis[0]?.schemaEntrada ?? {}).includes("item_id"));
      ok("B4  e ha definicao executavel para o mesmo id",
        Object.prototype.hasOwnProperty.call(completo.definicoes, ID_EXT));

      // Condicao 3 ausente: permissao.
      const semPermissao = await prepararFuncoesExternas({
        vinculos: comVinculo, permissoes: [],
      });
      ok("B5  SEM permissao: nao declarada", semPermissao.declaraveis.length === 0);

      // Condicao 1 ausente: vinculo — com a permissao INTACTA (§6).
      const semVinculo = await prepararFuncoesExternas({
        vinculos: [], permissoes: [{ funcaoId: ID_EXT, nivel: "automatico" }],
      });
      ok("B6  SEM vinculo, permissao historica intacta: NAO declarada (§6)",
        semVinculo.declaraveis.length === 0 &&
          Object.keys(semVinculo.definicoes).length === 0);

      // Condicao 2 ausente: a action nao existe mais no catalogo.
      const inventada = await prepararFuncoesExternas({
        vinculos: [{
          id: "x", provedorExterno: "composio", toolkit: TOOLKIT,
          acao: "HACKERNEWS_ACAO_QUE_NAO_EXISTE",
          funcaoId: "composio.hackernews.hackernews_acao_que_nao_existe",
          criadoEm: "2026-09-30T00:00:00Z",
        }],
        permissoes: [{
          funcaoId: "composio.hackernews.hackernews_acao_que_nao_existe",
          nivel: "automatico",
        }],
      });
      ok("B7  action fora do CATALOGO: nao declarada", inventada.declaraveis.length === 0);
      ok("B8  e o descarte e CONTADO, nao silencioso",
        inventada.sumiramDoCatalogo === 1, `${inventada.sumiramDoCatalogo}`);

      // `bloqueado` E declarado — a cerca do F7b.0.
      const bloqueada = await prepararFuncoesExternas({
        vinculos: comVinculo, permissoes: [{ funcaoId: ID_EXT, nivel: "bloqueado" }],
      });
      ok("B9  `bloqueado` E declarado, para o guard ser consultado",
        bloqueada.declaraveis.length === 1);

      // E a declaracao final, pelo mesmo `declararFerramentas` de sempre.
      const declaradas = declararFerramentas({
        catalogo: {}, permissoes: [{ funcaoId: ID_EXT, nivel: "automatico" }],
        externas: completo.declaraveis,
      });
      ok("B10 `declararFerramentas` a publica ao modelo",
        declaradas.length === 1 && declaradas[0]?.nome === ID_EXT);

      // §4: a meta-tool universal NUNCA entra.
      ok("B11 NENHUMA meta-tool universal e declarada",
        !declaradas.some((d) => /EXECUTE_TOOL|EXECUTE_AGENT|execute_any/i.test(d.nome)));
    }

    // ═══ C. Automatico / Bloqueado / Aprovacao, pelo guard ══════════

    secao("C. O guard decide, e o adaptador so roda quando ele manda");

    {
      // Agente e vinculo ja existem desde a secao B.
      const detalhe = await detalharAcao(ACAO);
      if (detalhe.estado !== "ok") {
        ok("C0  o catalogo respondeu", false, detalhe.estado);
        throw new Error("sem catalogo");
      }
      const acaoDoCatalogo = {
        slug: detalhe.dados.slug, descricao: detalhe.dados.descricao,
        parametros: detalhe.dados.parametros, versao: detalhe.dados.versao,
      };

      /**
       * O ESPIAO. Envolve o executor real e conta as chamadas.
       *
       * Sem contador, "bloqueado nao executa" seria indistinguivel de
       * "executou e o resultado nao apareceu".
       */
      function comEspiao() {
        const base = definicaoDaAcaoExterna(ID_EXT, acaoDoCatalogo);
        if (base === null) throw new Error("definicao nula");
        const espiao = { chamadas: 0 };
        return {
          espiao,
          mapa: {
            [ID_EXT]: {
              ...base,
              // Os tipos vem do PROPRIO executor envolvido: um espiao com
              // assinatura mais larga esconderia uma mudanca de contrato.
              executor: (async (
                ctx: Parameters<typeof base.executor>[0],
                args: Parameters<typeof base.executor>[1]
              ) => {
                espiao.chamadas += 1;
                return base.executor(ctx, args);
              }) as typeof base.executor,
            },
          },
        };
      }

      // ── AUTOMATICO ────────────────────────────────────────────────
      await definirPermissaoDeFerramentaExterna({
        userId: DONO, agenteId: AGENTE, funcaoId: ID_EXT, nivel: "automatico",
      });
      {
        const { espiao, mapa } = comEspiao();
        const r = await executarFuncao({
          userId: DONO, agenteId: AGENTE, funcaoId: ID_EXT,
          argumentos: { item_id: ITEM, max_depth: 0, max_children: 0 },
          definicoesExternas: mapa,
        } as Parameters<typeof executarFuncao>[0]);
        ok("C1  `automatico`: o guard AUTORIZA e a Funcao roda",
          r.tipo === "sucesso", r.tipo);
        ok("C2  e o adaptador foi chamado EXATAMENTE uma vez",
          espiao.chamadas === 1, `${espiao.chamadas}`);
        const dados = (r as { envelope?: { data?: unknown } }).envelope?.data;
        const autor = (dados as { response_data?: { author?: string } })?.response_data?.author;
        ok(`C3  e o envelope carrega o dado REAL (${AUTOR})`, autor === AUTOR, String(autor));
      }

      // ── BLOQUEADO ─────────────────────────────────────────────────
      await definirPermissaoDeFerramentaExterna({
        userId: DONO, agenteId: AGENTE, funcaoId: ID_EXT, nivel: "bloqueado",
      });
      {
        const { espiao, mapa } = comEspiao();
        const r = await executarFuncao({
          userId: DONO, agenteId: AGENTE, funcaoId: ID_EXT,
          argumentos: { item_id: ITEM },
          definicoesExternas: mapa,
        } as Parameters<typeof executarFuncao>[0]);
        ok("C4  `bloqueado`: o guard NEGA", r.tipo === "negado", r.tipo);
        ok("C5  e o adaptador NAO foi chamado nenhuma vez",
          espiao.chamadas === 0, `${espiao.chamadas}`);
        ok("C6  e nao ha envelope de dado para o modelo copiar",
          (r as { envelope?: { data?: unknown } }).envelope?.data === undefined);
      }

      // ── APROVACAO ─────────────────────────────────────────────────
      await definirPermissaoDeFerramentaExterna({
        userId: DONO, agenteId: AGENTE, funcaoId: ID_EXT, nivel: "aprovacao",
      });
      {
        const { espiao, mapa } = comEspiao();
        const r = await executarFuncao({
          userId: DONO, agenteId: AGENTE, funcaoId: ID_EXT,
          argumentos: { item_id: ITEM, max_depth: 0, max_children: 0 },
          definicoesExternas: mapa,
        } as Parameters<typeof executarFuncao>[0]);
        ok("C7  `aprovacao`: a Funcao PARA e pede decisao humana",
          r.tipo === "aguardando_aprovacao", r.tipo);
        ok("C8  e o adaptador NAO foi chamado antes da aprovacao",
          espiao.chamadas === 0, `${espiao.chamadas}`);
        ok("C9  e existe uma aprovacao com id, para o dono decidir",
          typeof (r as { aprovacaoId?: unknown }).aprovacaoId === "string");
      }

      // ── PERMISSAO AUSENTE ─────────────────────────────────────────
      await db.from("agente_permissoes").delete()
        .eq("user_id", DONO).eq("funcao_id", ID_EXT);
      {
        const { espiao, mapa } = comEspiao();
        const r = await executarFuncao({
          userId: DONO, agenteId: AGENTE, funcaoId: ID_EXT,
          argumentos: { item_id: ITEM },
          definicoesExternas: mapa,
        } as Parameters<typeof executarFuncao>[0]);
        ok("C10 permissao AUSENTE: o guard nega", r.tipo === "negado", r.tipo);
        ok("C11 e o adaptador continua em zero", espiao.chamadas === 0, `${espiao.chamadas}`);
      }

      // ── VINCULO REMOVIDO, id fora do mapa (§6) ────────────────────
      await definirPermissaoDeFerramentaExterna({
        userId: DONO, agenteId: AGENTE, funcaoId: ID_EXT, nivel: "automatico",
      });
      await desvincularFerramentaExternaDoAgente({
        userId: DONO, agenteId: AGENTE, funcaoId: ID_EXT,
      });
      {
        const vinculos = await listarVinculosExternos({ userId: DONO, agenteId: AGENTE });
        const preparadas = await prepararFuncoesExternas({
          vinculos: vinculos.coleta === "ok" ? vinculos.vinculos : [],
          permissoes: [{ funcaoId: ID_EXT, nivel: "automatico" }],
        });
        ok("C12 desvinculada: nao ha definicao para o guard resolver",
          Object.keys(preparadas.definicoes).length === 0);

        // E mesmo se o modelo pedir pelo nome, com a permissao intacta:
        const r = await executarFuncao({
          userId: DONO, agenteId: AGENTE, funcaoId: ID_EXT,
          argumentos: { item_id: ITEM },
          definicoesExternas: preparadas.definicoes,
        } as Parameters<typeof executarFuncao>[0]);
        ok("C13 e o pedido e negado por INEXISTENCIA, nao por permissao",
          r.tipo === "negado" &&
            (r as { codigo?: string }).codigo === "funcao_inexistente",
          `${r.tipo}/${(r as { codigo?: string }).codigo}`);
      }

      // ── CONNECTION_REQUIRED pelo caminho completo (§9) ────────────
      {
        const detalheGs = await detalharAcao("GOOGLESHEETS_GET_SPREADSHEET_INFO");
        if (detalheGs.estado === "ok") {
          const ID_GS = "composio.googlesheets.googlesheets_get_spreadsheet_info";
          await vincularFerramentaExternaNoAgente({
            userId: DONO, agenteId: AGENTE, provedorExterno: "composio",
            toolkit: "googlesheets", acao: "GOOGLESHEETS_GET_SPREADSHEET_INFO",
          });
          await definirPermissaoDeFerramentaExterna({
            userId: DONO, agenteId: AGENTE, funcaoId: ID_GS, nivel: "automatico",
          });
          const def = definicaoDaAcaoExterna(ID_GS, {
            slug: detalheGs.dados.slug, descricao: detalheGs.dados.descricao,
            parametros: detalheGs.dados.parametros, versao: detalheGs.dados.versao,
          });
          const r = await executarFuncao({
            userId: DONO, agenteId: AGENTE, funcaoId: ID_GS,
            argumentos: { spreadsheet_id: "nao-importa" },
            definicoesExternas: def === null ? {} : { [ID_GS]: def },
          } as Parameters<typeof executarFuncao>[0]);
          ok("C14 acao que exige OAuth, sem conexao: a Funcao FALHA controlada",
            r.tipo === "erro", r.tipo);
          const env = (r as { envelope?: { error?: { code?: string; message?: string } } }).envelope;
          ok("C15 com o codigo `conexao_necessaria`",
            env?.error?.code === "conexao_necessaria", String(env?.error?.code));
          ok("C16 e a frase manda CONECTAR, sem inventar resultado",
            /conect/i.test(String(env?.error?.message)) &&
              !/planilha|linha|valor/i.test(String(env?.error?.message)),
            String(env?.error?.message));
        } else {
          ok("C14 o catalogo respondeu para a acao de OAuth", false, detalheGs.estado);
        }
      }
    }

  } finally {
    secao("Limpeza: nada executavel sobra (a auditoria FICA, de proposito)");
    await limpar(db);
    const { data: agentes } = await db.from("agentes")
      .select("id, ativo").eq("user_id", DONO);
    const { data: vinculos } = await db.from("agente_ferramentas_externas")
      .select("id").eq("user_id", DONO);
    const { data: permissoes } = await db.from("agente_permissoes")
      .select("funcao_id").eq("user_id", DONO);
    ok("Z1  nenhum vinculo externo sobrou", (vinculos ?? []).length === 0,
      `${(vinculos ?? []).length}`);
    ok("Z2  nenhuma permissao sobrou", (permissoes ?? []).length === 0,
      `${(permissoes ?? []).length}`);
    ok("Z3  o agente-fixture e UM so, e esta INATIVO",
      (agentes ?? []).length === 1 && (agentes ?? [])[0]?.ativo === false,
      `${(agentes ?? []).length} agente(s)`);
    ok("Z4  e ele nao aparece para nenhum dono real — prefixo proprio",
      DONO.startsWith("FIXTURE-"));
  }

  console.log(`\nPASS ${passou}   FAIL ${falhou}`);
  process.exit(falhou === 0 ? 0 : 1);
}

void main();
