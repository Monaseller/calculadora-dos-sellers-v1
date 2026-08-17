/**
 * Reconciliação financeira Shopee — modo período e cursor. F0.c.19.
 *
 * ── O bug que esta suíte existe para impedir ────────────────────────
 * A rota só permitia selecionar por `limit` (sem data) ou por order_id.
 * Reconciliar UM dia exigia execuções que escolhiam pedidos arbitrários.
 *
 * Ao adicionar paginação, OFFSET seria a escolha óbvia — e estaria errada.
 * A própria reconciliação grava `has_income_data = true`, e o filtro de
 * seleção exclui `has_income_data = true`. Entre uma página e outra as
 * linhas SAEM do conjunto, então o offset passa a apontar para outro
 * lugar e PULA pedidos em silêncio:
 *
 *   250 elegíveis, limit=100
 *   página 1: offset=0   → processa 100 → viram has_income_data=true
 *   página 2: offset=100 → restam 150; offset 100 é o 101º DOS RESTANTES
 *                        → 100 pedidos nunca processados, sem erro nenhum
 *
 * Pior: em `dry_run` nada muda, então o teste passaria e só a execução
 * real falharia.
 *
 * O cursor usa `(data_pagamento, order_id)` — as duas colunas são
 * imutáveis, a reconciliação nunca as escreve, então a posição não se
 * move por baixo da paginação.
 *
 * Sem rede, sem banco, sem credencial: a paginação é simulada sobre um
 * conjunto em memória com o MESMO contrato de ordenação e filtro da rota.
 *
 * Uso: npx tsx scripts/testar-reconciliacao-periodo.ts
 */
import fs from "node:fs";
import path from "node:path";

let ok = 0, falhou = 0;
function t(nome: string, fn: () => void) {
  try { fn(); ok++; console.log(`  PASS  ${nome}`); }
  catch (e: any) { falhou++; console.log(`  FALHA ${nome} -> ${e?.message ?? e}`); }
}
function secao(s: string) { console.log(s); }
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

const RAIZ = process.cwd();
const ROTA = path.join(RAIZ, "app", "api", "admin", "shopee", "reconciliar-financeiro", "route.ts");
const FONTE = fs.readFileSync(ROTA, "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");

// ────────────────────────────────────────────────────────────────────
// Modelo da paginação: mesmo contrato da rota.
// ────────────────────────────────────────────────────────────────────
interface Pedido { d: string; o: string; income: boolean }
interface Cursor { d: string; o: string }

const codificar = (c: Cursor) => Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
const decodificar = (s: string): Cursor => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));

/** Uma página, como a rota faz: filtra, ordena, corta por `limit`. */
function pagina(base: Pedido[], from: string, to: string, cursor: Cursor | null, limit: number, force = false) {
  let elegiveis = base
    .filter(p => p.d >= from && p.d <= to)
    .filter(p => force || !p.income)
    .sort((a, b) => (a.d === b.d ? (a.o < b.o ? -1 : a.o > b.o ? 1 : 0) : (a.d < b.d ? -1 : 1)));
  if (cursor) {
    elegiveis = elegiveis.filter(p => p.d > cursor.d || (p.d === cursor.d && p.o > cursor.o));
  }
  const selecionados = elegiveis.slice(0, limit);
  const temMais = elegiveis.length > limit;
  const ultimo = selecionados[selecionados.length - 1];
  return {
    orderIds: selecionados.map(p => p.o),
    temMais,
    proximoCursor: ultimo ? codificar({ d: ultimo.d, o: ultimo.o }) : null,
  };
}

/** Percorre todas as páginas até has_more=false. */
function percorrer(base: Pedido[], from: string, to: string, limit: number, aoProcessar?: (ids: string[]) => void) {
  const todos: string[] = [];
  const paginas: string[][] = [];
  let cursor: Cursor | null = null;
  for (let i = 0; i < 200; i++) {
    const r = pagina(base, from, to, cursor, limit);
    if (r.orderIds.length === 0) break;
    paginas.push(r.orderIds);
    todos.push(...r.orderIds);
    aoProcessar?.(r.orderIds);
    if (!r.temMais || !r.proximoCursor) break;
    cursor = decodificar(r.proximoCursor);
  }
  return { todos, paginas };
}

/** Fixture com o formato real: 754 pedidos em 04/07. */
function fixture(n: number, dia = "2026-07-04"): Pedido[] {
  return Array.from({ length: n }, (_, i) => ({
    d: dia,
    o: `2607${String(i).padStart(10, "0")}`,
    income: false,
  }));
}

// ════════════════════════════════════════════════════════════════════
secao("\n[1. o bug do OFFSET — a razão desta suíte]");

t("1. OFFSET PULA pedidos quando a escrita muda o filtro", () => {
  // Reproduz o bug de propósito, para provar que ele é real.
  const base = fixture(250);
  const vistos: string[] = [];
  for (let p = 0; p < 3; p++) {
    const elegiveis = base.filter(x => !x.income).sort((a, b) => (a.o < b.o ? -1 : 1));
    const pag = elegiveis.slice(p * 100, p * 100 + 100);
    vistos.push(...pag.map(x => x.o));
    for (const x of pag) x.income = true; // a escrita real
  }
  assert(vistos.length < 250, "o cenário não reproduziu o bug");
  const unicos = new Set(vistos).size;
  assert(unicos < 250, `OFFSET viu ${unicos} de 250 — deveria pular`);
  console.log(`        (OFFSET processou ${unicos} de 250 — ${250 - unicos} pulados)`);
});

t("2. CURSOR não pula, mesmo com a escrita mudando o filtro", () => {
  const base = fixture(250);
  const { todos } = percorrer(base, "2026-07-04", "2026-07-04", 100, ids => {
    for (const id of ids) { const p = base.find(x => x.o === id)!; p.income = true; }
  });
  assert(todos.length === 250, `cursor viu ${todos.length} de 250`);
  assert(new Set(todos).size === 250, "cursor duplicou pedidos");
});

secao("\n[2. fixture real — 04/07/2026, 754 pedidos]");

const BASE = fixture(754);
const { todos, paginas } = percorrer(BASE.map(p => ({ ...p })), "2026-07-04", "2026-07-04", 100);

t("3. total percorrido = 754", () => {
  assert(todos.length === 754, `percorreu ${todos.length}`);
});
t("4. únicos = 754 (overlap zero)", () => {
  assert(new Set(todos).size === 754, `${new Set(todos).size} únicos — há overlap`);
});
t("5. gap zero — conjunto paginado == conjunto direto", () => {
  const direto = new Set(BASE.map(p => p.o));
  const paginado = new Set(todos);
  for (const id of direto) assert(paginado.has(id), `pedido ${id} não apareceu em nenhuma página`);
  assert(direto.size === paginado.size, "conjuntos de tamanhos diferentes");
});
t("6. nenhuma página passa de 100", () => {
  for (const [i, p] of paginas.entries()) assert(p.length <= 100, `página ${i} com ${p.length}`);
});
t("7. 754 em páginas de 100 -> 8 páginas (7×100 + 54)", () => {
  assert(paginas.length === 8, `veio ${paginas.length} páginas`);
  assert(paginas[7].length === 54, `última página com ${paginas[7].length}`);
});
t("8. ordem global crescente e sem repetição entre páginas", () => {
  for (let i = 1; i < todos.length; i++) {
    assert(todos[i] > todos[i - 1], `ordem quebrou em ${i}: ${todos[i-1]} -> ${todos[i]}`);
  }
});

secao("\n[3. escrita parcial e retomada]");

t("9. página que falha no meio: retomar do cursor anterior não pula nem duplica", () => {
  // Página 1 processa 63 de 100 e falha. O cliente NÃO recebe cursor novo.
  const base = fixture(250);
  const p1 = pagina(base, "2026-07-04", "2026-07-04", null, 100);
  const gravados = p1.orderIds.slice(0, 63);
  for (const id of gravados) base.find(x => x.o === id)!.income = true;

  // Retoma do cursor ANTERIOR (null) — a idempotência é que protege.
  const restante = percorrer(base, "2026-07-04", "2026-07-04", 100, ids => {
    for (const id of ids) base.find(x => x.o === id)!.income = true;
  });
  const cobertos = new Set([...gravados, ...restante.todos]);
  assert(cobertos.size === 250, `cobertos ${cobertos.size} de 250 — houve gap`);
  for (const id of gravados) {
    assert(!restante.todos.includes(id), `${id} foi reprocessado — efeito financeiro duplicado`);
  }
});

t("10. reexecutar a mesma página sem escrita devolve o mesmo conjunto", () => {
  const base = fixture(250);
  const a = pagina(base, "2026-07-04", "2026-07-04", null, 100);
  const b = pagina(base, "2026-07-04", "2026-07-04", null, 100);
  assert(a.orderIds.join(",") === b.orderIds.join(","), "seleção não é determinística");
});

t("11. cursor de página cheia aponta para o ÚLTIMO item entregue", () => {
  const base = fixture(250);
  const r = pagina(base, "2026-07-04", "2026-07-04", null, 100);
  const c = decodificar(r.proximoCursor!);
  assert(c.o === r.orderIds[99], `cursor aponta ${c.o}, último entregue foi ${r.orderIds[99]}`);
});

secao("\n[4. janela de datas e cursor entre dias]");

t("12. pedidos fora do período nunca entram", () => {
  const base = [...fixture(10, "2026-07-03"), ...fixture(10, "2026-07-04"), ...fixture(10, "2026-07-05")]
    .map((p, i) => ({ ...p, o: `${p.d}-${String(i).padStart(4, "0")}` }));
  const { todos } = percorrer(base, "2026-07-04", "2026-07-04", 100);
  for (const id of todos) assert(id.startsWith("2026-07-04"), `${id} está fora do período`);
  assert(todos.length === 10, `veio ${todos.length}, esperado 10`);
});

t("13. janela de vários dias atravessa a fronteira sem perder pedidos", () => {
  const base = ["2026-07-04", "2026-07-05", "2026-07-06"].flatMap((d, k) =>
    Array.from({ length: 40 }, (_, i) => ({ d, o: `${d}-${String(i).padStart(4, "0")}`, income: false }))
  );
  const { todos, paginas } = percorrer(base, "2026-07-04", "2026-07-06", 50);
  assert(todos.length === 120, `percorreu ${todos.length} de 120`);
  assert(new Set(todos).size === 120, "duplicou na fronteira entre dias");
  assert(paginas.length === 3, `veio ${paginas.length} páginas`);
});

t("14. cursor com data anterior ao período não ressuscita pedidos já passados", () => {
  const base = fixture(20);
  const c: Cursor = { d: "2026-07-04", o: base[9].o };
  const r = pagina(base, "2026-07-04", "2026-07-04", c, 100);
  assert(r.orderIds.length === 10, `veio ${r.orderIds.length}, esperado 10`);
  assert(!r.orderIds.includes(base[9].o), "o cursor é inclusivo — deveria ser estritamente maior");
});

secao("\n[5. contrato da rota — leitura do código]");

t("15. teto de 100 por request no modo período", () => {
  assert(/MAX_LIMIT_PERIODO\s*=\s*100/.test(FONTE), "teto de 100 ausente");
  assert(/tetoLimit\s*=\s*modoPeriodo\s*\?\s*MAX_LIMIT_PERIODO/.test(FONTE), "teto não é aplicado no modo período");
});
t("16. janela máxima de 7 dias", () => {
  assert(/MAX_DIAS_JANELA\s*=\s*7/.test(FONTE), "janela máxima ausente");
  assert(/dias > MAX_DIAS_JANELA/.test(FONTE), "janela não é validada");
});
t("17. as validações obrigatórias devolvem 400", () => {
  assert(/date_from e date_to sao obrigatorios/.test(FONTE), "falta 400 para período sem datas");
  assert(/devem estar em YYYY-MM-DD/.test(FONTE), "falta 400 para data inválida");
  assert(/date_from nao pode ser maior que date_to/.test(FONTE), "falta 400 para from > to");
  assert(/status:\s*400/.test(FONTE), "nenhum retorno 400");
});
t("18. cursor é validado e preso ao período", () => {
  assert(/bruto\.d < dateFrom \|\| bruto\.d > dateTo/.test(FONTE),
    "🔴 cursor não é verificado contra o período — cursor forjado leria fora da janela");
  assert(/cursor invalido ou fora do periodo/.test(FONTE), "falta 400 para cursor inválido");
});
t("19. NÃO usa offset no modo período", () => {
  assert(!/\.range\(\s*offset/.test(FONTE), "🔴 voltou a paginar por offset");
  assert(/data_pagamento\.gt\.\$\{cursor\.d\}/.test(FONTE), "o cursor não filtra por data_pagamento");
  assert(/order_id\.gt\.\$\{cursor\.o\}/.test(FONTE), "o cursor não desempata por order_id");
});
t("20. filtros de segurança preservados", () => {
  assert(/\.eq\("user_id",\s*userId\)/.test(FONTE), "user_id não vem da sessão");
  assert(/\.eq\("marketplace",\s*"Shopee"\)/.test(FONTE), "marketplace não fixado");
  assert(/\.eq\("status_shopee_raw",\s*"COMPLETED"\)/.test(FONTE), "status_shopee_raw não fixado");
  assert(/getShopeeLojaAtiva\(userId\)/.test(FONTE), "loja não vem de getShopeeLojaAtiva");
  assert(/\.gte\("data_pagamento",\s*dateFrom!\)/.test(FONTE), "período não filtra data_pagamento");
});
t("21. dry_run continua o padrão seguro", () => {
  assert(/dry_run"\)\s*!==\s*"0"/.test(FONTE), "dry_run deixou de ser o padrão");
  assert(/force\s*=\s*url\.searchParams\.get\("force"\)\s*===\s*"1"/.test(FONTE), "force deixou de ser explícito");
});
t("22. segunda leitura garante todos os itens do pedido", () => {
  // Sem isto, um pedido cortado na fronteira da janela de linhas teria o
  // escrow rateado sobre parte dos itens — erro financeiro silencioso.
  assert(/Erro ao completar itens/.test(FONTE), "não há segunda leitura por order_id");
  assert(/\.in\("order_id",\s*orderIds\)/.test(FONTE), "a segunda leitura não é restrita à página");
});
t("23. resposta expõe o contrato de paginação", () => {
  for (const campo of ["encontrados", "processados", "ignorados", "erros", "proximo_cursor", "has_more"]) {
    assert(new RegExp(`${campo}:`).test(FONTE), `resposta sem "${campo}"`);
  }
  assert(/order_ids_da_pagina:\s*modoPeriodo && dryRun/.test(FONTE),
    "order_ids da página deveriam sair só em dry_run");
});
t("24. modo legado por order_id preservado", () => {
  assert(/orderIdParam\s*=\s*url\.searchParams\.get\("order_id"\)/.test(FONTE), "modo order_id sumiu");
  assert(/!orderIdParam && !usandoListaEspecifica/.test(FONTE), "modo período não exclui os modos legados");
});

secao("\n[6. so_selecao — leitura pura, sem chamada externa]");

/** Corpo de um bloco delimitado por chaves, a partir de um marcador. */
function bloco(fonte: string, marcador: string): string {
  const i = fonte.indexOf(marcador);
  assert(i >= 0, `marcador não encontrado: ${marcador}`);
  const abre = fonte.indexOf("{", i);
  let n = 0;
  for (let k = abre; k < fonte.length; k++) {
    if (fonte[k] === "{") n++;
    else if (fonte[k] === "}") { n--; if (n === 0) return fonte.slice(abre, k + 1); }
  }
  throw new Error(`fim de ${marcador} não encontrado`);
}

t("25. A/B. so_selecao esvazia a lista de trabalho — o laço não roda", () => {
  // shopeeGet e get_escrow_detail vivem SÓ dentro deste laço. Lista vazia
  // é prova estrutural mais forte que um `if` espalhado: não há caminho.
  assert(/const orderIdsParaProcessar = soSelecao \? \[\] : orderIds;/.test(FONTE),
    "a lista de trabalho não é esvaziada por so_selecao");
  assert(/for \(const orderId of orderIdsParaProcessar\)/.test(FONTE),
    "o laço não itera sobre a lista guardada");
  const laco = bloco(FONTE, "for (const orderId of orderIdsParaProcessar)");
  assert(/shopeeGet\(/.test(laco), "shopeeGet deveria estar dentro do laço");
  assert(/get_escrow_detail/.test(laco), "get_escrow_detail deveria estar dentro do laço");
  const fora = FONTE.replace(laco, "");
  assert(!/shopeeGet\(/.test(fora), "🔴 há chamada a shopeeGet FORA do laço");
  assert(!/get_escrow_detail/.test(fora), "🔴 há get_escrow_detail FORA do laço");
});

t("26. C. o único UPDATE está dentro de if (!dryRun) e dentro do laço", () => {
  const updates = [...FONTE.matchAll(/supabase\s*\.from\("pedidos"\)\s*\.update\(/g)];
  assert(updates.length === 1, `esperava 1 UPDATE em pedidos, achei ${updates.length}`);
  const laco = bloco(FONTE, "for (const orderId of orderIdsParaProcessar)");
  assert(/\.update\(campos\)/.test(laco), "o UPDATE saiu do laço");
  const guarda = bloco(FONTE, "if (!dryRun) {");
  assert(/\.update\(campos\)/.test(guarda), "🔴 o UPDATE não está guardado por !dryRun");
});

t("27. D/E. atualizarResumosDosDias exige !dryRun", () => {
  assert(/if \(!dryRun && \(diasPagamentoAfetados\.size > 0/.test(FONTE),
    "🔴 dry_run pode gravar em dashboard_resumos_diarios");
  const chamadas = [...FONTE.matchAll(/await atualizarResumosDosDias\(/g)];
  assert(chamadas.length === 1, `esperava 1 chamada, achei ${chamadas.length}`);
  // E com so_selecao os Sets nem chegam a ser preenchidos (laço não roda).
  const laco = bloco(FONTE, "for (const orderId of orderIdsParaProcessar)");
  assert(/diasPagamentoAfetados\.add|diasCriacaoAfetados\.add/.test(laco),
    "os Sets deveriam ser preenchidos só dentro do laço");
});

t("28. F. so_selecao=1 + dry_run=0 devolve 400", () => {
  assert(/soSelecao && url\.searchParams\.get\("dry_run"\) === "0"/.test(FONTE),
    "a combinação contraditória não é detectada");
  assert(/so_selecao=1 e read-only e nao aceita dry_run=0/.test(FONTE),
    "falta a mensagem de 400 para a combinação");
});

t("29. so_selecao fora do modo período devolve 400", () => {
  assert(/soSelecao && !modoPeriodo/.test(FONTE), "so_selecao não é restrito ao modo período");
  assert(/so_selecao=1 so existe no modo periodo/.test(FONTE), "falta o 400 correspondente");
});

t("30. o contrato da resposta do modo seleção", () => {
  assert(/so_selecao:\s*modoPeriodo \? soSelecao : null/.test(FONTE), "resposta sem so_selecao");
  assert(/erros:\s*modoPeriodo \? \(soSelecao \? 0 :/.test(FONTE), "erros deveria ser 0 em so_selecao");
  assert(/linhas_da_pagina:\s*modoPeriodo \? rows\.length : null/.test(FONTE), "falta linhas_da_pagina");
});

t("31. a resposta não expõe dado sensível no modo seleção", () => {
  // `detalhes` só é preenchido dentro do laço, que não roda em so_selecao.
  const laco = bloco(FONTE, "for (const orderId of orderIdsParaProcessar)");
  assert(/detalhes\.push\(/.test(laco), "detalhes deveria ser preenchido só no laço");
  const fora = FONTE.replace(laco, "");
  assert(!/detalhes\.push\(/.test(fora), "🔴 detalhes é preenchido fora do laço");
  assert(!/buyer_username|buyer_cidade|access_token|partnerKey/.test(
    FONTE.slice(FONTE.indexOf("return NextResponse.json({\n    ok:"))),
    "a resposta expõe campo sensível");
});

t("32. G. a paginação não mudou com so_selecao", () => {
  // O corte por cursor e a segunda leitura vêm ANTES do laço, então valem
  // igualmente nos dois modos.
  const iCursor = FONTE.indexOf("data_pagamento.gt.${cursor.d}");
  const iSegunda = FONTE.indexOf("Erro ao completar itens");
  const iLaco   = FONTE.indexOf("for (const orderId of orderIdsParaProcessar)");
  assert(iCursor > 0 && iCursor < iLaco, "o cursor deixou de vir antes do laço");
  assert(iSegunda > 0 && iSegunda < iLaco, "a segunda leitura deixou de vir antes do laço");
});

t("33. H/I. modos legado e financeiro intactos", () => {
  assert(/} else if \(!orderIdParam && !usandoListaEspecifica\) \{\s*orderIds = orderIds\.slice\(0, limit\);/.test(FONTE),
    "o corte do modo legado foi alterado");
  assert(/MAX_LIMIT\s*=\s*500/.test(FONTE), "o teto do modo legado mudou");
  assert(/soSelecao \? \[\] : orderIds/.test(FONTE),
    "sem so_selecao a lista deveria continuar sendo orderIds — modo financeiro intacto");
});

console.log(`\n=== RESULTADO: ${ok} passaram, ${falhou} falharam ===`);
if (falhou > 0) process.exitCode = 1;
