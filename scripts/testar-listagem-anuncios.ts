/**
 * Listagem de Meus Produtos — paginação e filtro de marketplace. F0.c.17b.
 *
 * ── O defeito que esta suíte existe para travar ─────────────────────
 * `carregar()` fazia UMA consulta sem `range`. O PostgREST corta em 1000
 * linhas e responde `content-range: 0-999/*` — sem erro e sem aviso. Com
 * 1076 anúncios ativos, 76 nunca chegavam à tela; e como a ordem é
 * `created_at DESC` e as linhas Shopee eram mais recentes, os 76 cortados
 * eram todos do Mercado Livre. Medido em produção em 2026-08-17: a tela
 * mostrava 198 dos 274 anúncios ML.
 *
 * O limite não vinha do nosso código. Nenhum `select` local o revelava, e
 * nenhum teste podia pegá-lo enquanto a leitura fosse uma chamada só.
 *
 * ── Como estes testes provam ────────────────────────────────────────
 * `buscarPaginado` recebe a busca como FUNÇÃO, então a suíte simula
 * datasets de qualquer tamanho — inclusive > 1000 — sem rede, sem banco e
 * sem React. As camadas que não são puras (a `carregar()` e os handlers de
 * import) são verificadas por leitura do código-fonte, com os comentários
 * removidos antes: um teste tem de falar sobre o código, não sobre a prosa
 * que o descreve.
 *
 * Sem rede, sem banco, sem credencial.
 *
 * Uso: npx tsx scripts/testar-listagem-anuncios.ts
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

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder-de-teste.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "chave-de-teste-invalida";

const RAIZ = process.cwd();
const TELA = path.join(RAIZ, "app", "(app)", "anuncios", "page.tsx");
const PAGINACAO = path.join(RAIZ, "app", "(app)", "anuncios", "paginacao.ts");

/** Fonte sem comentários — o teste avalia código, não texto explicativo. */
function semComentarios(arquivo: string): string {
  return fs.readFileSync(arquivo, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const CODIGO = semComentarios(TELA);

/** Corpo de uma função nomeada, por contagem de chaves. */
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

interface Linha { id: string; marketplace: string; created_at: string }

/** Dataset determinístico com `n` linhas alternando marketplace. */
function dataset(n: number, mlAte = n): Linha[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `id-${String(i).padStart(6, "0")}`,
    marketplace: i < mlAte ? "ML" : "Shopee",
    created_at: `2026-08-17T00:00:${String(i % 60).padStart(2, "0")}`,
  }));
}

/** Fonte paginada que registra os ranges pedidos. */
function fonte(linhas: Linha[]) {
  const ranges: Array<[number, number]> = [];
  return {
    ranges,
    buscar: async (de: number, ate: number) => {
      ranges.push([de, ate]);
      return linhas.slice(de, ate + 1);
    },
  };
}

async function principal() {
  const mod: any = await import(pathToFileURL(PAGINACAO).href);
  const { buscarPaginado, aplicarFiltroMarketplace, TAMANHO_PAGINA_ANUNCIOS, MAX_PAGINAS_ANUNCIOS } = mod;

  secao("\n[1. contrato do módulo de paginação]");

  t("1. paginacao.ts exporta os helpers puros e as constantes", () => {
    assert(typeof buscarPaginado === "function", "buscarPaginado não exportada");
    assert(typeof aplicarFiltroMarketplace === "function", "aplicarFiltroMarketplace não exportada");
    assert(TAMANHO_PAGINA_ANUNCIOS === 1000, `tamanho de página é ${TAMANHO_PAGINA_ANUNCIOS}, esperado 1000`);
    assert(MAX_PAGINAS_ANUNCIOS >= 2, "trava de páginas precisa permitir mais de uma página");
  });

  t("1b. page.tsx NÃO exporta nada além do componente", () => {
    // O Next.js valida os exports de um arquivo de rota: `.next/types/.../
    // page.ts` tipa qualquer nome fora da lista fechada como `never`, e
    // `tsc --noEmit` quebra com TS2344. Foi o que aconteceu quando os
    // helpers moravam no page.tsx — por isso existe o paginacao.ts.
    const PERMITIDOS = new Set([
      "config", "generateStaticParams", "revalidate", "dynamic", "dynamicParams",
      "fetchCache", "preferredRegion", "runtime", "maxDuration",
      "metadata", "generateMetadata", "viewport", "generateViewport",
    ]);
    // Só exports NOMEADOS: `export default` é o próprio componente.
    const nomeados = [...CODIGO.matchAll(
      /^export\s+(?!default\b)(?:async\s+)?(?:function|const|let|var|class|type|interface)\s+(\w+)/gm,
    )].map(m => m[1]);
    for (const nome of nomeados) {
      assert(PERMITIDOS.has(nome),
        `page.tsx exporta "${nome}" — fora da lista fechada do Next.js, quebra o tsc com TS2344`);
    }
    assert(/^export\s+default\s+function\s+AnunciosPage/m.test(CODIGO),
      "page.tsx deveria exportar o componente como default");
    assert(/from\s+["']\.\/paginacao["']/.test(CODIGO),
      "page.tsx deveria importar os helpers de ./paginacao");
  });

  secao("\n[2. A — dataset > 1000 NÃO é truncado]");

  t("2. 1076 linhas (o caso real de produção) chegam inteiras", async () => {
    const f = fonte(dataset(1076, 274));
    const r = await buscarPaginado(f.buscar, 1000, 50);
    assert(r.length === 1076, `veio ${r.length}, esperado 1076 — o truncamento voltou`);
    const ml = r.filter((x: Linha) => x.marketplace === "ML").length;
    assert(ml === 274, `veio ${ml} linhas ML, esperado 274 — foi o ML que o corte comia`);
  });

  t("3. 2500 linhas → 3 páginas, nada perdido", async () => {
    const f = fonte(dataset(2500));
    const r = await buscarPaginado(f.buscar, 1000, 50);
    assert(r.length === 2500, `veio ${r.length}, esperado 2500`);
    assert(f.ranges.length === 3, `pediu ${f.ranges.length} páginas, esperado 3`);
  });

  t("4. exatamente 1000 NÃO encerra na primeira página", async () => {
    // O bug se disfarçava justamente aqui: 1000 linhas parecendo o total.
    const f = fonte(dataset(1000));
    const r = await buscarPaginado(f.buscar, 1000, 50);
    assert(r.length === 1000, `veio ${r.length}`);
    assert(f.ranges.length === 2, `pediu ${f.ranges.length} páginas, esperado 2 (a 2ª confirma o fim)`);
  });

  secao("\n[3. B — a paginação termina]");

  t("5. dataset vazio → 1 chamada, lista vazia", async () => {
    const f = fonte([]);
    const r = await buscarPaginado(f.buscar, 1000, 50);
    assert(r.length === 0, `veio ${r.length}`);
    assert(f.ranges.length === 1, `pediu ${f.ranges.length} páginas, esperado 1`);
  });

  t("6. dataset menor que a página → 1 chamada só", async () => {
    const f = fonte(dataset(500));
    const r = await buscarPaginado(f.buscar, 1000, 50);
    assert(r.length === 500, `veio ${r.length}`);
    assert(f.ranges.length === 1, `pediu ${f.ranges.length} páginas, esperado 1`);
  });

  t("7. trava de páginas impede laço infinito", async () => {
    // Fonte patológica: SEMPRE devolve página cheia. Sem trava, laço eterno.
    let chamadas = 0;
    const infinita = async () => { chamadas++; return dataset(10); };
    const r = await buscarPaginado(infinita, 10, 5);
    assert(chamadas === 5, `chamou ${chamadas} vezes, esperado parar em 5`);
    assert(r.length === 50, `veio ${r.length}, esperado 50`);
  });

  t("8. a trava padrão da tela é finita e conservadora", () => {
    assert(Number.isInteger(MAX_PAGINAS_ANUNCIOS) && MAX_PAGINAS_ANUNCIOS > 0,
      "MAX_PAGINAS_ANUNCIOS precisa ser inteiro positivo");
    assert(MAX_PAGINAS_ANUNCIOS * TAMANHO_PAGINA_ANUNCIOS >= 20000,
      "teto total baixo demais para o catálogo real");
  });

  t("9. erro na primeira página não vira lista vazia silenciosa", async () => {
    let chamadas = 0;
    const r = await buscarPaginado(async () => { chamadas++; return null; }, 1000, 50);
    assert(r.length === 0, `veio ${r.length}`);
    assert(chamadas === 1, `chamou ${chamadas} vezes, deveria parar na 1ª`);
  });

  t("10. erro no meio devolve o acumulado e para", async () => {
    let chamadas = 0;
    const r = await buscarPaginado(async (de: number) => {
      chamadas++;
      return de === 0 ? dataset(10) : null;
    }, 10, 50);
    assert(r.length === 10, `veio ${r.length}, esperado 10`);
    assert(chamadas === 2, `chamou ${chamadas}, esperado 2`);
  });

  secao("\n[4. C — nenhuma duplicidade entre páginas]");

  t("11. 1076 linhas, todos os ids únicos", async () => {
    const f = fonte(dataset(1076, 274));
    const r = await buscarPaginado(f.buscar, 1000, 50);
    const unicos = new Set(r.map((x: Linha) => x.id));
    assert(unicos.size === r.length, `${r.length} linhas mas ${unicos.size} ids únicos — há duplicidade`);
  });

  t("12. os ranges pedidos são contíguos e não se sobrepõem", async () => {
    const f = fonte(dataset(2500));
    await buscarPaginado(f.buscar, 1000, 50);
    assert(f.ranges[0][0] === 0, `primeira página começa em ${f.ranges[0][0]}, esperado 0`);
    for (let i = 0; i < f.ranges.length; i++) {
      const [de, ate] = f.ranges[i];
      assert(ate - de === 999, `página ${i} pediu ${ate - de + 1} linhas, esperado 1000`);
      if (i > 0) assert(de === f.ranges[i - 1][1] + 1,
        `página ${i} começa em ${de}, mas a anterior terminou em ${f.ranges[i - 1][1]} — buraco ou sobreposição`);
    }
  });

  secao("\n[5. D — a ordem é preservada]");

  t("13. a ordem final é exatamente a ordem entregue pelas páginas", async () => {
    const linhas = dataset(2500);
    const f = fonte(linhas);
    const r = await buscarPaginado(f.buscar, 1000, 50);
    for (let i = 0; i < linhas.length; i++) {
      assert(r[i].id === linhas[i].id, `posição ${i}: veio ${r[i].id}, esperado ${linhas[i].id}`);
    }
  });

  t("14. a concatenação não reordena na fronteira das páginas", async () => {
    const f = fonte(dataset(1076, 274));
    const r = await buscarPaginado(f.buscar, 1000, 50);
    assert(r[999].id === "id-000999", `fim da 1ª página: ${r[999].id}`);
    assert(r[1000].id === "id-001000", `início da 2ª página: ${r[1000].id}`);
  });

  secao("\n[6. E/F/G — o filtro de marketplace]");

  const mistas = dataset(1076, 274);

  t("15. E — 'todos' contém ML E Shopee", () => {
    const r = aplicarFiltroMarketplace(mistas, "todos");
    assert(r.length === 1076, `veio ${r.length}, esperado 1076`);
    assert(r.some((x: Linha) => x.marketplace === "ML"), "não há linha ML em 'todos'");
    assert(r.some((x: Linha) => x.marketplace === "Shopee"), "não há linha Shopee em 'todos'");
  });

  t("16. F — 'ML' contém somente ML", () => {
    const r = aplicarFiltroMarketplace(mistas, "ML");
    assert(r.length === 274, `veio ${r.length}, esperado 274`);
    assert(r.every((x: Linha) => x.marketplace === "ML"), "vazou linha não-ML no filtro ML");
  });

  t("17. G — 'Shopee' contém somente Shopee", () => {
    const r = aplicarFiltroMarketplace(mistas, "Shopee");
    assert(r.length === 802, `veio ${r.length}, esperado 802`);
    assert(r.every((x: Linha) => x.marketplace === "Shopee"), "vazou linha não-Shopee no filtro Shopee");
  });

  t("18. o filtro não muta a lista original", () => {
    const antes = mistas.length;
    aplicarFiltroMarketplace(mistas, "ML");
    aplicarFiltroMarketplace(mistas, "Shopee");
    assert(mistas.length === antes, `a lista original mudou de ${antes} para ${mistas.length}`);
  });

  t("19. 'todos' preserva a ordem recebida", () => {
    const r = aplicarFiltroMarketplace(mistas, "todos");
    assert(r[0].id === mistas[0].id && r[r.length - 1].id === mistas[mistas.length - 1].id,
      "'todos' reordenou a lista");
  });

  secao("\n[7. a carregar() da tela usa a leitura paginada]");

  const CARREGAR = corpoDaFuncao(CODIGO, "carregar");

  t("20. carregar() usa buscarPaginado e pede range explícito", () => {
    assert(/buscarPaginado</.test(CARREGAR), "carregar() não usa buscarPaginado");
    assert(/\.range\(/.test(CARREGAR), "carregar() não pede range — o corte de 1000 volta");
  });

  t("21. carregar() preserva os filtros originais", () => {
    assert(/\.eq\("ativo",\s*true\)/.test(CARREGAR), "perdeu o filtro ativo=true");
    assert(/\.eq\("user_id",\s*id\)/.test(CARREGAR), "perdeu o filtro user_id");
    assert(/\.order\("created_at",\s*\{\s*ascending:\s*false\s*\}\)/.test(CARREGAR),
      "perdeu a ordenação created_at DESC");
  });

  t("22. carregar() tem desempate determinístico por id", () => {
    // created_at DESC não é ordem total. Sem desempate, páginas pedidas em
    // requisições separadas podem repetir ou perder linhas na fronteira.
    assert(/\.order\("id",\s*\{\s*ascending:\s*false\s*\}\)/.test(CARREGAR),
      "sem desempate por id a paginação pode duplicar ou perder linhas");
  });

  t("23. consulta falha NÃO substitui a lista por vazia", () => {
    assert(/houveResposta/.test(CARREGAR),
      "perdeu a guarda do 'if (data)' original — erro de rede limparia a tela");
    assert(/if\s*\(houveResposta\)\s*setAnuncios/.test(CARREGAR),
      "setAnuncios deveria estar condicionado a ter havido resposta");
  });

  t("24. a tela continua lendo o Supabase direto, sem endpoint novo", () => {
    // Esta etapa corrige truncamento; criar rota nova era fora de escopo.
    assert(/from\("anuncios"\)/.test(CARREGAR), "carregar() deixou de consultar a tabela anuncios");
    assert(!/fetch\(/.test(CARREGAR), "carregar() passou a chamar um endpoint — fora do escopo desta etapa");
  });

  secao("\n[8. o que esta etapa NÃO podia mudar]");

  t("33. a tela abre com o filtro em 'todos'", () => {
    assert(/filtroMarketplace,\s*setFiltroMarketplace\s*\]\s*=\s*useState<[^>]*>\("todos"\)/.test(CODIGO),
      "o estado inicial do filtro deixou de ser 'todos'");
  });

  t("34. os três recortes continuam existindo na interface", () => {
    for (const chave of ['"todos"', '"ML"', '"Shopee"']) {
      assert(CODIGO.includes(chave), `recorte ${chave} desapareceu da tela`);
    }
  });

  t("35. a lista segue unificada: nenhum filtro fixo de marketplace na consulta", () => {
    assert(!/\.eq\("marketplace"/.test(CARREGAR),
      "a consulta passou a filtrar marketplace no servidor — a visão unificada era intencional");
  });

  t("36. nenhuma escrita nova foi introduzida em carregar()", () => {
    for (const proibido of [".insert(", ".update(", ".upsert(", ".delete("]) {
      assert(!CARREGAR.includes(proibido), `carregar() passou a escrever no banco (${proibido})`);
    }
  });

  await fila;
  imprimir(`\n=== RESULTADO: ${ok} passaram, ${falhou} falharam ===`);
  if (falhou > 0) process.exitCode = 1;
}

principal();
