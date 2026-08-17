/**
 * Exclusão em massa de Meus Produtos — lotes, ownership e confirmação.
 *
 * ── O incidente que esta suíte trava ────────────────────────────────
 * "Selecionar todos" → excluir fazia UMA escrita com `.in("id", ids)`
 * carregando a seleção inteira. Com 1076 anúncios isso monta um filtro de
 * 39.819 bytes numa URL de ~39.877, e o PostgREST responde 400 Bad
 * Request. Medido em 2026-08-17 contra os IDs reais: 200 ids passam
 * (7.475 bytes), 400 já falham na rede, 800+ respondem 400; o máximo
 * observado foi 398.
 *
 * O código não lia o erro e removia os cards na linha seguinte ao
 * `await`. Os anúncios sumiam da tela e voltavam no F5 — o banco nunca
 * havia sido tocado: `ativo=false` tinha ZERO linhas no catálogo inteiro.
 *
 * ── Como estes testes provam ────────────────────────────────────────
 * `desativarEmLotes` recebe a escrita como FUNÇÃO. O duplo registra cada
 * lote recebido e pode falhar onde o teste quiser, então sucesso total,
 * erro no primeiro lote, erro intermediário e falha parcial são
 * exercitados de verdade — sem rede, sem banco, sem escrever nada.
 *
 * As partes que não são puras (as três funções da tela e a renderização
 * da mensagem) são verificadas por leitura do código-fonte, com os
 * comentários removidos antes.
 *
 * Uso: npx tsx scripts/testar-exclusao-anuncios.ts
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

let ok = 0, falhou = 0;
let fila: Promise<void> = Promise.resolve();
const imprimir = console.log.bind(console);

function t(nome: string, fn: () => void | Promise<void>) {
  fila = fila.then(async () => {
    try { await fn(); ok++; imprimir(`  PASS  ${nome}`); }
    catch (e: any) { falhou++; imprimir(`  FALHA ${nome} -> ${e?.message ?? e}`); }
  });
}
function secao(titulo: string) { fila = fila.then(() => { imprimir(titulo); }); }
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

const RAIZ = process.cwd();
const TELA = path.join(RAIZ, "app", "(app)", "anuncios", "page.tsx");
const PAGINACAO = path.join(RAIZ, "app", "(app)", "anuncios", "paginacao.ts");

function semComentarios(arquivo: string): string {
  return fs.readFileSync(arquivo, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const CODIGO = semComentarios(TELA);

function corpoDaFuncao(fonte: string, nome: string): string {
  const i = fonte.indexOf(`function ${nome}(`);
  assert(i >= 0, `função ${nome} não encontrada`);
  const abre = fonte.indexOf("{", i);
  let nivel = 0;
  for (let k = abre; k < fonte.length; k++) {
    if (fonte[k] === "{") nivel++;
    else if (fonte[k] === "}") { nivel--; if (nivel === 0) return fonte.slice(abre, k + 1); }
  }
  throw new Error(`fim de ${nome} não encontrado`);
}

const ids = (n: number, pref = "id") =>
  Array.from({ length: n }, (_, i) => `${pref}-${String(i).padStart(5, "0")}`);

/**
 * Duplo da escrita. Registra os lotes recebidos e confirma tudo, salvo
 * onde `falharNoLote` mandar falhar ou `naoConfirmar` esconder ids.
 */
function escrita(opts: { falharNoLote?: number[]; lancarNoLote?: number[]; naoConfirmar?: Set<string> } = {}) {
  const lotes: string[][] = [];
  let chamada = 0;
  return {
    lotes,
    fn: async (lote: string[]) => {
      const indice = chamada++;
      lotes.push([...lote]);
      if (opts.lancarNoLote?.includes(indice)) throw new Error(`excecao no lote ${indice}`);
      if (opts.falharNoLote?.includes(indice)) return { ids: null, erro: `erro no lote ${indice}` };
      const confirmados = opts.naoConfirmar ? lote.filter(i => !opts.naoConfirmar!.has(i)) : lote;
      return { ids: confirmados, erro: null };
    },
  };
}

async function principal() {
  const mod: any = await import(pathToFileURL(PAGINACAO).href);
  const { dividirEmLotes, desativarEmLotes, LOTE_MAXIMO_IDS } = mod;

  secao("\n[1. divisão em lotes]");

  t("1. lote pequeno cabe em uma divisão só", () => {
    const l = dividirEmLotes(ids(7));
    assert(l.length === 1, `veio ${l.length} lotes`);
    assert(l[0].length === 7, `lote com ${l[0].length}`);
  });

  t("2. exatamente 200 -> 1 lote", () => {
    const l = dividirEmLotes(ids(200));
    assert(l.length === 1, `veio ${l.length} lotes, esperado 1`);
    assert(l[0].length === 200, `lote com ${l[0].length}`);
  });

  t("3. 201 -> 2 lotes (200 + 1)", () => {
    const l = dividirEmLotes(ids(201));
    assert(l.length === 2, `veio ${l.length} lotes, esperado 2`);
    assert(l[0].length === 200 && l[1].length === 1, `tamanhos ${l.map((x: string[]) => x.length).join("/")}`);
  });

  t("4. 1076 (o caso real) -> 6 lotes", () => {
    const l = dividirEmLotes(ids(1076));
    assert(l.length === 6, `veio ${l.length} lotes, esperado 6`);
    assert(l.map((x: string[]) => x.length).join(",") === "200,200,200,200,200,76",
      `tamanhos ${l.map((x: string[]) => x.length).join(",")}`);
  });

  t("5. nenhum lote passa de 200", () => {
    for (const n of [1, 199, 200, 201, 399, 1076, 5000]) {
      for (const lote of dividirEmLotes(ids(n))) {
        assert(lote.length <= LOTE_MAXIMO_IDS, `lote com ${lote.length} para n=${n}`);
      }
    }
  });

  t("6. nenhum ID perdido", () => {
    const orig = ids(1076);
    const plano = dividirEmLotes(orig).flat();
    assert(plano.length === orig.length, `${plano.length} != ${orig.length}`);
    assert(plano.join(",") === orig.join(","), "conteúdo ou ordem divergiu");
  });

  t("7. nenhum ID duplicado entre lotes", () => {
    const plano = dividirEmLotes(ids(1076)).flat();
    assert(new Set(plano).size === plano.length, "há id repetido entre lotes");
  });

  t("7b. tamanho de lote inválido lança, não degrada em silêncio", () => {
    for (const mau of [0, -1, 1.5]) {
      let lancou = false;
      try { dividirEmLotes(ids(3), mau); } catch { lancou = true; }
      assert(lancou, `tamanho ${mau} deveria lançar`);
    }
  });

  t("7c. LOTE_MAXIMO_IDS = 200, abaixo do máximo medido (398)", () => {
    assert(LOTE_MAXIMO_IDS === 200, `veio ${LOTE_MAXIMO_IDS}`);
  });

  secao("\n[2. sucesso total]");

  t("9. 1076 ids confirmados -> 6 escritas, nada pendente", async () => {
    const e = escrita();
    const r = await desativarEmLotes(e.fn, ids(1076));
    assert(e.lotes.length === 6, `${e.lotes.length} escritas, esperado 6`);
    assert(r.confirmados.length === 1076, `confirmados=${r.confirmados.length}`);
    assert(r.naoConfirmados.length === 0, `naoConfirmados=${r.naoConfirmados.length}`);
    assert(r.erro === null, `erro=${r.erro}`);
  });

  t("9b. os lotes enviados reconstroem exatamente a entrada", async () => {
    const entrada = ids(1076);
    const e = escrita();
    await desativarEmLotes(e.fn, entrada);
    const enviados = e.lotes.flat();
    assert(enviados.join(",") === entrada.join(","), "os lotes não reconstroem a entrada");
    for (const lote of e.lotes) assert(lote.length <= 200, `lote com ${lote.length}`);
  });

  t("9c. entrada com repetidos é deduplicada antes de dividir", async () => {
    const e = escrita();
    const r = await desativarEmLotes(e.fn, ["a", "b", "a", "c", "b"]);
    const enviados = e.lotes.flat();
    assert(enviados.length === 3, `enviou ${enviados.length} ids, esperado 3`);
    assert(new Set(enviados).size === 3, "id repetido chegou à escrita");
    assert(r.confirmados.length === 3, `confirmados=${r.confirmados.length}`);
  });

  secao("\n[3. erro no primeiro lote, no meio, e falha parcial]");

  t("10. erro no PRIMEIRO lote não contamina os demais", async () => {
    const e = escrita({ falharNoLote: [0] });
    const r = await desativarEmLotes(e.fn, ids(1076));
    assert(e.lotes.length === 6, `parou cedo: ${e.lotes.length} escritas`);
    assert(r.confirmados.length === 876, `confirmados=${r.confirmados.length}, esperado 876`);
    assert(r.naoConfirmados.length === 200, `naoConfirmados=${r.naoConfirmados.length}, esperado 200`);
    assert(r.erro !== null, "erro deveria ser reportado");
  });

  t("11. erro INTERMEDIÁRIO: continua os lotes seguintes", async () => {
    const e = escrita({ falharNoLote: [2] });
    const r = await desativarEmLotes(e.fn, ids(1076));
    assert(e.lotes.length === 6, `estratégia mudou: ${e.lotes.length} escritas, esperado 6`);
    assert(r.confirmados.length === 876, `confirmados=${r.confirmados.length}`);
    assert(r.naoConfirmados.length === 200, `naoConfirmados=${r.naoConfirmados.length}`);
  });

  t("11b. exceção lançada é tratada como falha, não como confirmação", async () => {
    const e = escrita({ lancarNoLote: [1] });
    const r = await desativarEmLotes(e.fn, ids(600));
    assert(e.lotes.length === 3, `${e.lotes.length} escritas, esperado 3`);
    assert(r.confirmados.length === 400, `confirmados=${r.confirmados.length}`);
    assert(r.naoConfirmados.length === 200, `naoConfirmados=${r.naoConfirmados.length}`);
    assert(r.erro !== null, "exceção deveria virar erro reportado");
  });

  t("12. falha parcial: confirmados e não confirmados são disjuntos e completos", async () => {
    const e = escrita({ falharNoLote: [1, 3] });
    const entrada = ids(1076);
    const r = await desativarEmLotes(e.fn, entrada);
    const conf = new Set(r.confirmados);
    const nao = new Set(r.naoConfirmados);
    for (const id of conf) assert(!nao.has(id), `${id} está nos dois conjuntos`);
    assert(conf.size + nao.size === entrada.length,
      `${conf.size}+${nao.size} != ${entrada.length} — algum id sumiu`);
    for (const id of entrada) assert(conf.has(id) || nao.has(id), `${id} sumiu do resultado`);
  });

  t("12b. linha não devolvida pelo banco conta como NÃO confirmada", async () => {
    // Ownership negando a linha: o banco não reclama, só não devolve.
    const e = escrita({ naoConfirmar: new Set(["id-00003", "id-00007"]) });
    const r = await desativarEmLotes(e.fn, ids(10));
    assert(r.confirmados.length === 8, `confirmados=${r.confirmados.length}`);
    assert(r.naoConfirmados.length === 2, `naoConfirmados=${r.naoConfirmados.length}`);
    assert(r.erro !== null, "ausência silenciosa deveria virar erro");
  });

  t("12c. lista vazia não escreve nada e não é erro", async () => {
    const e = escrita();
    const r = await desativarEmLotes(e.fn, []);
    assert(e.lotes.length === 0, `escreveu ${e.lotes.length} lotes`);
    assert(r.confirmados.length === 0 && r.naoConfirmados.length === 0, "resultado deveria ser vazio");
    assert(r.erro === null, `erro=${r.erro} — vazio não é falha`);
  });

  secao("\n[4. a tela: ownership, confirmação e os 3 caminhos]");

  const DESATIVAR = corpoDaFuncao(CODIGO, "desativarAnuncios");
  const APLICAR   = corpoDaFuncao(CODIGO, "aplicarResultadoExclusao");
  const SELEC     = corpoDaFuncao(CODIGO, "deletarSelecionados");
  const INDIV     = corpoDaFuncao(CODIGO, "excluir");
  const DUPL      = corpoDaFuncao(CODIGO, "excluirTodosDuplicados");

  t("8. toda escrita filtra por user_id", () => {
    assert(/\.eq\("user_id",\s*userId\)/.test(DESATIVAR),
      "🔴 escrita sem ownership — sem RLS, um id conhecido bastaria para excluir de outro usuário");
    assert(/if\s*\(!userId\)/.test(DESATIVAR),
      "sem sessão a escrita deveria ser recusada antes de tentar");
  });

  t("8b. a escrita é soft delete, nunca delete físico", () => {
    assert(/\.update\(\{\s*ativo:\s*false\s*\}\)/.test(DESATIVAR), "não faz update ativo:false");
    // Só a CADEIA do Supabase interessa: `n.delete(id)` de um Set em
    // toggleSelect é legítimo e não pode fazer este teste falhar.
    for (const m of CODIGO.matchAll(/from\("anuncios"\)([\s\S]{0,200})/g)) {
      assert(!/\.\s*delete\s*\(/.test(m[1]),
        "🔴 a tela passou a apagar fisicamente linhas de `anuncios`");
    }
    assert(/from\("anuncios"\)/.test(DESATIVAR), "a escrita não passa pela tabela anuncios");
  });

  t("8c. a escrita pede de volta os ids alterados", () => {
    assert(/\.select\("id"\)/.test(DESATIVAR), "sem .select('id') não há como saber o que foi alterado");
    assert(/desativarEmLotes\(/.test(DESATIVAR), "não usa o helper de lotes");
  });

  t("13. a UI NÃO remove ids não confirmados", () => {
    assert(/confirmados/.test(APLICAR), "aplicarResultadoExclusao ignora os confirmados");
    assert(!/naoConfirmados\.(has|includes)/.test(APLICAR.split("setAnuncios")[0] ?? ""),
      "a remoção da lista não pode se basear nos não confirmados");
    assert(/setAnuncios\(prev\s*=>\s*prev\.filter\(a\s*=>\s*!confirmados\.has\(a\.id\)\)\)/.test(APLICAR),
      "a lista deveria remover exatamente os confirmados");
  });

  t("14. a UI remove os ids confirmados", () => {
    assert(/if\s*\(r\.confirmados\.length\)/.test(APLICAR), "não há guarda para lista de confirmados vazia");
  });

  t("14b. falha parcial não exibe mensagem de sucesso", () => {
    const i = APLICAR.indexOf("naoConfirmados.length === 0");
    assert(i >= 0, "não distingue sucesso total de parcial");
    const depois = APLICAR.slice(i);
    assert(/ok:\s*false/.test(depois), "o caminho de falha deveria usar ok:false");
    assert(/ok:\s*true/.test(APLICAR.slice(0, APLICAR.indexOf("ok: false") + 1)) || /ok:\s*true/.test(APLICAR),
      "não há caminho de sucesso");
  });

  t("15. seleção só é limpa quando tudo foi confirmado", () => {
    assert(/if\s*\(r\.naoConfirmados\.length\s*===\s*0\)/.test(SELEC),
      "a limpeza da seleção não olha o resultado");
    assert(/setSelectedIds\(new Set\(r\.naoConfirmados\)\)/.test(SELEC),
      "em falha parcial a seleção deveria manter o que falhou");
  });

  t("16. exclusão individual passa pelo mesmo caminho verificado", () => {
    assert(/desativarAnuncios\(\[id\]\)/.test(INDIV), "exclusão individual não usa o caminho seguro");
    assert(/aplicarResultadoExclusao/.test(INDIV), "individual não confere o resultado");
    assert(!/supabase/.test(INDIV), "individual ainda escreve direto no supabase");
  });

  t("16b. excluir duplicados passa pelo mesmo caminho verificado", () => {
    assert(/desativarAnuncios\(/.test(DUPL), "duplicados não usa o caminho seguro");
    assert(/aplicarResultadoExclusao/.test(DUPL), "duplicados não confere o resultado");
    assert(!/supabase/.test(DUPL), "duplicados ainda escreve direto no supabase");
    assert(/if\s*\(r\.naoConfirmados\.length\s*===\s*0\)\s*setFiltroDuplicados\(false\)/.test(DUPL),
      "só deveria sair do filtro de duplicados se nada ficou pendente");
  });

  t("16c. nenhum dos 3 caminhos escreve direto sem verificação", () => {
    for (const [nome, corpo] of [["deletarSelecionados", SELEC], ["excluir", INDIV], ["excluirTodosDuplicados", DUPL]] as const) {
      assert(!/\.update\(/.test(corpo), `${nome} ainda faz update direto`);
      assert(/desativarAnuncios/.test(corpo), `${nome} não usa desativarAnuncios`);
    }
  });

  secao("\n[5. escopo: o que a exclusão pode alcançar]");

  t("17. 'selecionar todos' usa anunciosFiltrados, não o catálogo inteiro", () => {
    assert(/setSelectedIds\(new Set\(anunciosFiltrados\.map\(a\s*=>\s*a\.id\)\)\)/.test(CODIGO),
      "selecionarTodos deixou de respeitar o filtro visível");
  });

  t("18/19. o recorte por marketplace é o mesmo da lista — ML não alcança Shopee", async () => {
    const filtrar: any = mod.aplicarFiltroMarketplace ?? (await import(pathToFileURL(PAGINACAO).href) as any).aplicarFiltroMarketplace;
    const linhas = [
      { id: "a", marketplace: "ML" }, { id: "b", marketplace: "Shopee" },
      { id: "c", marketplace: "ML" }, { id: "d", marketplace: "Shopee" },
    ];
    const soML = filtrar(linhas, "ML").map((x: any) => x.id);
    const soSP = filtrar(linhas, "Shopee").map((x: any) => x.id);
    assert(soML.join(",") === "a,c", `filtro ML devolveu ${soML.join(",")}`);
    assert(soSP.join(",") === "b,d", `filtro Shopee devolveu ${soSP.join(",")}`);
    for (const id of soML) assert(!soSP.includes(id), `${id} apareceu nos dois recortes`);
    // A exclusão parte de `anunciosFiltrados`, que é a saída deste filtro.
    assert(/const\s+anunciosFiltrados\s*=\s*useMemo/.test(CODIGO), "anunciosFiltrados sumiu");
    assert(/aplicarFiltroMarketplace\(base,\s*filtroMarketplace\)/.test(CODIGO),
      "a lista deixou de usar o recorte canônico");
  });

  secao("\n[6. feedback visível ao usuário]");

  t("20. existe estado e renderização da mensagem de exclusão", () => {
    assert(/msgExclusao,\s*setMsgExclusao\s*\]\s*=\s*useState/.test(CODIGO), "não há estado de mensagem");
    assert(/\{msgExclusao\s*&&\s*\(/.test(CODIGO), "a mensagem não é renderizada");
    assert(/setMsgExclusao\(null\)/.test(CODIGO), "não há como dispensar a mensagem");
  });

  t("21. os 3 caminhos limpam a mensagem antes de tentar", () => {
    for (const [nome, corpo] of [["deletarSelecionados", SELEC], ["excluir", INDIV], ["excluirTodosDuplicados", DUPL]] as const) {
      assert(/setMsgExclusao\(null\)/.test(corpo), `${nome} não limpa a mensagem anterior`);
    }
  });

  await fila;
  imprimir(`\n=== RESULTADO: ${ok} passaram, ${falhou} falharam ===`);
  if (falhou > 0) process.exitCode = 1;
}

principal();
