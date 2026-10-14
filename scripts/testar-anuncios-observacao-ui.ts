/**
 * CDS V2 — Fase 2H-E: observação do marketplace em Meus Produtos, SOMENTE LEITURA.
 *
 * Apresentação REAL (app/(app)/anuncios/observacao.ts), cards REAIS renderizados (CardAnuncio,
 * CardAnuncioVariacoes), agrupamento/recorte REAIS da tela e listagem REAL do servidor
 * (listarAnunciosDoDono) com um PostgREST falso. Prova:
 *   E1 status NULL + visto_em NULL → render seguro, sem ruído (markup idêntico ao da linha sem os campos);
 *   E2 ML "active" → exibido como veio (não vira "Ativo"), com a última observação;
 *   E3 raw arbitrário → byte a byte, entrada intocada, nada além de { status, vistoEm };
 *   E4 Shopee status NULL + visto_em → só a observação, nunca NORMAL;
 *   E5 ativo=false segue fora da listagem (soft delete) — a observação não o traz de volta;
 *   E6 status/visto_em não mudam visibilidade (servidor, recorte, duplicados);
 *   E7 status/visto_em não mudam o agrupamento marketplace|loja_id|item; variações: uma vez no
 *      cabeçalho quando iguais, por linha só quando divergem;
 *   E8 visto_em antigo (ou inválido) não vira stale/inativo nem esconde nada;
 *   E9 o browser não grava os campos (CAMPOS_GRAVAVEIS recusa);
 *   I11 + I9 + I10 + Guard V2 limpos.
 *
 * Sem rede, sem banco. Uso: npx tsx scripts/testar-anuncios-observacao-ui.ts
 */
import "./_server-only-inerte";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// os cards usam o JSX clássico (tsconfig "preserve"), como em testar-criar-agente-v2
(globalThis as unknown as { React: typeof React }).React = React;

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder-de-teste.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "chave-de-teste-invalida";

let ok = 0, falhou = 0;
const imprimir = console.log.bind(console);
async function t(nome: string, fn: () => void | Promise<void>) {
  try { await fn(); ok++; imprimir(`  PASS  ${nome}`); }
  catch (e: any) { falhou++; imprimir(`  FALHA ${nome} -> ${e?.message ?? e}`); }
}
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

const U = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LOJA_A = "11111111-1111-4111-8111-111111111111", LOJA_B = "22222222-2222-4222-8222-222222222222";
const RECENTE = "2026-10-13T12:00:00.000Z", ANTIGO = "2001-01-01T00:00:00.000Z";
const OPCOES_DATA = { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" } as const;
const legivel = (iso: string) => new Date(iso).toLocaleString("pt-BR", OPCOES_DATA);
/** Palavras de estado INFERIDO que nunca podem nascer da observação. */
const INFERIDO = /\b(inactive|inativo|inativa|offline|removido|removida|excluído|stale|desatualizado|NORMAL|Ativo|Pausado)\b/;

let seq = 0;
function linha(over: Record<string, unknown> = {}): any {
  seq++;
  return {
    id: `a-${seq}`, created_at: "2026-10-01T00:00:00.000Z", nome: "Produto X", marketplace: "ML", categoria: null,
    tipo_anuncio: "Clássico", tipo_conta_shopee: null, custo_produto: 10, insumos: 0, custo_frete: 0, frete_gratis: true,
    imposto: 0, margem_desejada: 0, preco_ideal: null, preco_anuncio: 100, ml_item_id: "MLB1", thumbnail: null,
    permalink: null, ativo: true, sku: "S1", peso_kg: null, variation_id: null, logistic_type: null, user_id: U, loja_id: LOJA_A,
    status_marketplace: null, visto_em: null, ...over,
  };
}
const semObservacao = (a: any) => { const { status_marketplace: _s, visto_em: _v, ...resto } = a; return resto; };
const ids = (xs: readonly { id: string }[]) => xs.map((x) => x.id).join(",");

// ── PostgREST falso (só a cadeia de listarAnunciosDoDono) ─────────────────
function clienteListagem(linhas: any[]) {
  const chamadas: { select: string; eq: Array<[string, unknown]> }[] = [];
  return {
    chamadas,
    from(tabela: string) {
      assert(tabela === "anuncios", tabela);
      const st = { select: "", eq: [] as Array<[string, unknown]> };
      const q: any = {
        select(c: string) { st.select = c; return q; },
        eq(k: string, v: unknown) { st.eq.push([k, v]); return q; },
        order() { return q; },
        range(de: number, ate: number) {
          chamadas.push(st);
          const cols = st.select.split(",").map((c) => c.trim());
          const data = linhas.filter((l) => st.eq.every(([k, v]) => l[k] === v)).slice(de, ate + 1)
            .map((l) => Object.fromEntries(cols.map((c) => [c, l[c]])));
          return Promise.resolve({ data, error: null });
        },
      };
      return q;
    },
  };
}

async function principal() {
  const OBS = await import("../app/(app)/anuncios/observacao");
  const AG = await import("../app/(app)/anuncios/agrupamento");
  const PAG = await import("../app/(app)/anuncios/paginacao");
  const SERV = await import("../lib/anuncios/servico");
  const G2 = await import("./_guard-v2");
  const CardAnuncio = (await import("../app/(app)/anuncios/CardAnuncio")).default;
  const CardAnuncioVariacoes = (await import("../app/(app)/anuncios/CardAnuncioVariacoes")).default;
  const nada = () => {};
  const card = (a: any) => renderToStaticMarkup(createElement(CardAnuncio, { anuncio: a, onEditar: nada, onExcluir: nada }));
  const cardVar = (vs: any[]) => renderToStaticMarkup(createElement(CardAnuncioVariacoes, { variacoes: vs, onEditar: nada, onExcluir: nada }));
  const vezes = (html: string, s: string) => html.split(s).length - 1;

  imprimir("\n[1. apresentação]");
  await t("E1. status NULL + visto_em NULL → nada a mostrar; card idêntico ao da linha sem os campos (ML e Shopee)", () => {
    assert(OBS.apresentarObservacao({ status_marketplace: null, visto_em: null }) === null, "null/null apresentou algo");
    assert(OBS.apresentarObservacao({}) === null, "linha sem os campos apresentou algo");
    assert(OBS.apresentarObservacao({ status_marketplace: "   ", visto_em: "" }) === null, "vazio apresentou algo");
    for (const marketplace of ["ML", "Shopee"]) {
      const a = linha({ marketplace });
      const html = card(a);
      assert(html === card(semObservacao(a)), `${marketplace}: NULL adicionou ruído ao card`);
      assert(!html.includes("Última observação") && !html.includes("●") && !INFERIDO.test(html), `${marketplace}: ${html}`);
    }
    const vs = [linha({ variation_id: "1" }), linha({ variation_id: "2" })];
    assert(cardVar(vs) === cardVar(vs.map(semObservacao)), "variações: NULL adicionou ruído");
  });
  await t("E2. ML \"active\" → exibido como veio (nunca \"Ativo\") + última observação no formato da casa", () => {
    const a = linha({ status_marketplace: "active", visto_em: RECENTE });
    const o = OBS.apresentarObservacao(a);
    assert(o && o.status === "active" && o.vistoEm === legivel(RECENTE), JSON.stringify(o));
    const html = card(a);
    assert(html.includes("● active") && html.includes(`Última observação: ${legivel(RECENTE)}`), html);
    assert(!INFERIDO.test(html), "status traduzido/inferido no card");
  });
  await t("E3. raw arbitrário → byte a byte; entrada congelada intocada; saída só { status, vistoEm }", () => {
    for (const raw of ["SOME_PROVIDER_RAW_VALUE", " under_review ", "paused", "closed", "Ção-ü"]) {
      const a = Object.freeze({ status_marketplace: raw, visto_em: RECENTE });
      const antes = JSON.stringify(a);
      const o = OBS.apresentarObservacao(a)!;
      assert(o.status === raw, `${JSON.stringify(raw)} virou ${JSON.stringify(o.status)}`);
      assert(JSON.stringify(Object.keys(o)) === '["status","vistoEm"]', JSON.stringify(Object.keys(o)));
      assert(JSON.stringify(a) === antes, "entrada mudou");
    }
    const html = card(linha({ status_marketplace: "SOME_PROVIDER_RAW_VALUE", visto_em: RECENTE }));
    assert(html.includes("● SOME_PROVIDER_RAW_VALUE"), html);
  });
  await t("E4. Shopee status NULL + visto_em → mostra a observação, nunca inventa status (NORMAL)", () => {
    const a = linha({ marketplace: "Shopee", ml_item_id: "9001", status_marketplace: null, visto_em: RECENTE });
    const o = OBS.apresentarObservacao(a);
    assert(o && o.status === null && o.vistoEm === legivel(RECENTE), JSON.stringify(o));
    const html = card(a);
    assert(html.includes(`Última observação: ${legivel(RECENTE)}`) && !html.includes("●") && !/NORMAL/i.test(html), html);
  });

  imprimir("\n[2. ativo, visibilidade e agrupamento]");
  const listar = async (linhas: any[]) => {
    const c = clienteListagem(linhas);
    const r = await SERV.listarAnunciosDoDono(c as any, U, 0, 999, "tela");
    return { r: r as any[], c };
  };
  await t("E5. ativo=false continua fora da listagem (soft delete) mesmo com status \"active\" recente; projeção lê a observação sem user_id", async () => {
    const vivo = linha({ status_marketplace: null }), apagado = linha({ ativo: false, status_marketplace: "active", visto_em: RECENTE });
    const { r, c } = await listar([vivo, apagado]);
    assert(ids(r) === vivo.id, ids(r));
    assert(JSON.stringify(c.chamadas[0].eq) === JSON.stringify([["ativo", true], ["user_id", U]]), JSON.stringify(c.chamadas[0].eq));
    const cols = c.chamadas[0].select.split(",").map((x) => x.trim());
    assert(cols.includes("status_marketplace") && cols.includes("visto_em") && !cols.includes("user_id"), c.chamadas[0].select);
    assert(r[0].status_marketplace === null && r[0].visto_em === null, "observação não chegou à tela");
    // a apresentação ignora `ativo`: mesma saída para a mesma observação
    const o1 = OBS.apresentarObservacao(linha({ ativo: true, status_marketplace: "active", visto_em: RECENTE }));
    const o2 = OBS.apresentarObservacao(linha({ ativo: false, status_marketplace: "active", visto_em: RECENTE }));
    assert(JSON.stringify(o1) === JSON.stringify(o2), "apresentação depende de ativo");
  });
  const variantes: Array<[string | null, string | null]> = [[null, null], ["active", RECENTE], ["closed", ANTIGO], ["paused", null], [null, ANTIGO], ["SOME_PROVIDER_RAW_VALUE", RECENTE]];
  const universo = () => {
    seq = 0;
    return [
      linha({ ml_item_id: "MLB1", variation_id: "v1" }), linha({ ml_item_id: "MLB1", variation_id: "v2" }),
      linha({ ml_item_id: "MLB1", variation_id: "v1", loja_id: LOJA_B }), linha({ ml_item_id: "MLB2" }), linha({ ml_item_id: "MLB2" }),
      linha({ marketplace: "Shopee", ml_item_id: "9001", variation_id: "m1", loja_id: LOJA_B }), linha({ marketplace: "Shopee", ml_item_id: "9002" }),
      linha({ ml_item_id: null }), linha({ ativo: false, ml_item_id: "MLB3" }),
    ];
  };
  const comObs = (xs: any[], k: number) => xs.map((x, i) => ({ ...x, status_marketplace: variantes[(i + k) % variantes.length][0], visto_em: variantes[(i + k) % variantes.length][1] }));
  const retrato = async (xs: any[]) => {
    const { r } = await listar(xs);
    const g = AG.agruparVariacoes(r);
    return JSON.stringify({
      lista: ids(r), ml: ids(PAG.aplicarFiltroMarketplace(r, "ML")), sp: ids(PAG.aplicarFiltroMarketplace(r, "Shopee")),
      dup: [...AG.idsDuplicadosAntigos(r)].sort().join(","), solo: ids(g.solo), grupos: g.grupos.map(ids),
      chaves: r.map((a: any) => AG.chaveDeGrupoAnuncio(a)),
    });
  };
  await t("E6. status/visto_em não mudam visibilidade: listagem, recorte por marketplace e duplicados idênticos em toda combinação", async () => {
    const ref = await retrato(universo());
    assert(JSON.parse(ref).lista.split(",").length === 8, ref);
    for (let k = 0; k < variantes.length; k++) assert(await retrato(comObs(universo(), k)) === ref, `variante ${k} mudou a visibilidade`);
  });
  await t("E7. status/visto_em não mudam o agrupamento marketplace|loja_id|item; variações com observações diferentes ficam no MESMO grupo", async () => {
    const ref = JSON.parse(await retrato(universo()));
    for (let k = 0; k < variantes.length; k++) {
      const r = JSON.parse(await retrato(comObs(universo(), k)));
      assert(JSON.stringify(r.grupos) === JSON.stringify(ref.grupos) && JSON.stringify(r.chaves) === JSON.stringify(ref.chaves), `variante ${k}`);
    }
    for (const [s, v] of variantes) {
      const base = linha({ ml_item_id: "MLB9", loja_id: LOJA_A });
      assert(AG.chaveDeGrupoAnuncio({ ...base, status_marketplace: s, visto_em: v }) === `ML|${LOJA_A}|MLB9`, "chave mudou com a observação");
    }
  });
  await t("E7b. variações: observação igual → UMA vez no cabeçalho; divergente → por linha; o grupo não muda", () => {
    const iguais = [linha({ variation_id: "1", status_marketplace: "active", visto_em: RECENTE }), linha({ variation_id: "2", status_marketplace: "active", visto_em: RECENTE })];
    const g1 = OBS.observacaoDoGrupo(iguais);
    assert(g1.porLinha === false && g1.comum?.status === "active", JSON.stringify(g1));
    const h1 = cardVar(iguais);
    assert(vezes(h1, "● active") === 1 && vezes(h1, "Última observação") === 1, h1);
    const diferentes = [linha({ variation_id: "1", status_marketplace: "active", visto_em: RECENTE }), linha({ variation_id: "2", status_marketplace: null, visto_em: null })];
    const g2 = OBS.observacaoDoGrupo(diferentes);
    assert(g2.porLinha === true && g2.comum === null, JSON.stringify(g2));
    const h2 = cardVar(diferentes);
    assert(vezes(h2, "● active") === 1 && vezes(h2, "Última observação") === 1 && vezes(h2, "2 variações") === 1, h2);
    assert(OBS.observacaoDoGrupo([]).comum === null, "grupo vazio");
  });
  await t("E8. visto_em antigo (ou inválido) não vira stale/inativo e não esconde nada", async () => {
    const o = OBS.apresentarObservacao({ status_marketplace: "active", visto_em: ANTIGO });
    assert(o && o.status === "active" && o.vistoEm === legivel(ANTIGO) && JSON.stringify(Object.keys(o)) === '["status","vistoEm"]', JSON.stringify(o));
    const html = card(linha({ status_marketplace: null, visto_em: ANTIGO }));
    assert(html.includes(`Última observação: ${legivel(ANTIGO)}`) && !INFERIDO.test(html), html);
    const inv = OBS.apresentarObservacao({ status_marketplace: "active", visto_em: "não-é-data" });
    assert(inv && inv.status === "active" && inv.vistoEm === null, JSON.stringify(inv));
    const todosAntigos = universo().map((x) => ({ ...x, visto_em: ANTIGO }));
    assert(await retrato(todosAntigos) === await retrato(universo()), "visto_em antigo mudou a lista");
  });

  imprimir("\n[3. escrita]");
  await t("E9. o browser não grava status_marketplace/visto_em (PATCH e POST recusam; whitelist sem os campos)", () => {
    assert(!("status_marketplace" in SERV.CAMPOS_GRAVAVEIS) && !("visto_em" in SERV.CAMPOS_GRAVAVEIS), "campo gravável");
    for (const campo of ["status_marketplace", "visto_em"]) {
      const patch = SERV.montarCamposGravaveis({ [campo]: campo === "visto_em" ? RECENTE : "active" }, true);
      assert(!patch.ok && /Campo não permitido/.test(patch.erro), JSON.stringify(patch));
      const post = SERV.montarCamposGravaveis({ nome: "x", marketplace: "ML", [campo]: "active" }, false);
      assert(!post.ok, JSON.stringify(post));
    }
  });

  imprimir("\n[4. guard]");
  await t("I11. Guard V2 limpo (I11_MARKETPLACE_STATUS_UI_IS_READ_ONLY + I9 + I10 + demais)", () => {
    const i11 = G2.observacaoNaUiNaoSoLeitura(), i9 = G2.observacaoMisturadaComAtivo(), i10 = G2.refreshDeIdentidadesForaDaLoja();
    const v2 = G2.invariantesV2(undefined, { zonas: false });
    assert(i11.length === 0 && i9.length === 0 && i10.length === 0 && v2.length === 0, [...i11, ...i9, ...i10, ...v2].join(" | "));
    assert(JSON.stringify(G2.LEITORES_OBSERVACAO) === JSON.stringify(["lib/anuncios/colunas.ts", "app/(app)/anuncios/observacao.ts"]), "leitores nominais mudaram");
  });

  imprimir(`\n${falhou === 0 ? "✓" : "✗"} ANUNCIOS-OBSERVACAO-UI — ${ok} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { imprimir("ERRO FATAL", e?.message ?? e); process.exit(1); });
