/**
 * ANUNCIOS SHOPEE MULTI-STORE V1B — excecao EXATA dos guards para
 * "cada anuncio Shopee pertence a UMA loja" (+ correcao do preco Shopee e da
 * identidade no PATCH manual).
 *
 * Camada SOBRE todas as anteriores (multi-app, UX, multi-store): cada arquivo
 * abaixo so passa se, revertendo EXATAMENTE os hunks aprovados (gerados do
 * diff contra bb8f7ea), o resultado for BYTE-IDENTICO ao blob de bb8f7ea —
 * versao que passou por todos os guards — e se o arquivo na base do guard for
 * um estado ja aprovado (pinado abaixo: o blob de bb8f7ea, os das bases dos
 * guards e das camadas anteriores, ou AUSENTE quando o arquivo ainda nao
 * existia naquela base). Sem curinga: arquivo fora da lista segue travado.
 *
 * NOVOS, so com o conteudo EXATO (sha256, forma LF) e so se nao existiam na
 * base do guard: as duas migrations (20261103 fase 1, 20261104 fase 2), a
 * suite testar-anuncios-shopee-multi-store e este helper (auto-pin).
 *
 * Schema: docs/schema/anuncios.colunas.json continua sendo o de PRODUCAO. A
 * coluna PENDENTE (loja_id) so e reconhecida pelo guard de schema atraves de
 * colunasPendentesAprovadasAnuncios(), e so enquanto a migration da fase 1
 * for byte-exata.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const BASE_ANUNCIOS_MULTI_STORE = "bb8f7ea";
export const HELPER_ANUNCIOS_MULTI_STORE = "scripts/_excecao-anuncios-multi-store.ts";
export const MIGRACAO_ANUNCIOS_FASE1 = "supabase/migrations/20261103_anuncios_loja_fase1.sql";
export const MIGRACAO_ANUNCIOS_FASE2 = "supabase/migrations/20261104_anuncios_loja_fase2.sql";
/** Colunas que a fase 1 acrescenta a public.anuncios (ainda nao aplicada em producao). */
const COLUNAS_PENDENTES_FASE1 = ["loja_id"];

const AUSENTE = "AUSENTE";
const SHA256_NOVOS: Record<string, string> = {
  "supabase/migrations/20261103_anuncios_loja_fase1.sql": "e4caab2f39c91a6103ea68ac09145342358f14182e6e510570422d6f526bdcba",
  "supabase/migrations/20261104_anuncios_loja_fase2.sql": "071a21aa23c8c3fbb19c66930f5c8d289c7188d791000a24b0fc6b6508d742c2",
  "scripts/testar-anuncios-shopee-multi-store.ts": "65a301612c9b1f7f6f06f35a35439987ed5b66f7b2cbd0de1599b89f496ce6ee"
};
const SHA256_HELPER_ANUNCIOS_MULTI_STORE = "8cdc69cf5c5cc3747b7578175b9f9eef9bcf1df65d7b4be7da6d01267fde76d3";
const BLOBS_BASE_APROVADOS: Record<string, string[]> = {
  "lib/sync-shopee.ts": [
    "46d2ba9a174eaed5b8cdaeb4bd6c6230b123d291",
    "a8a183f9f9d2a01a2b76eea400ad6b7211f6d593",
    "d4eddf41a2da86ebebd87bd04c1e085c70a95e59"
  ],
  "app/api/shopee/importar-anuncios/route.ts": [
    "1c9a7c70445ba05b11f5cfeb303cc05eb6299d49",
    "78c6cba992fd9da5675340f9cce84420f72bc994",
    "f6966be9805c4247c83c9e35f590dda350af5adc"
  ],
  "app/api/admin/shopee/backfill-pedidos-0707/route.ts": [
    "1e6da7e39c9f939e8761647a0cafa8b9500d8d4d",
    "aa3fe111cf5f6e7b0d3a12e1fa4a0ee3697992cc",
    "ca6a5690e01cb9c6730c9f75bcab0607deac37c9"
  ],
  "lib/anuncios/servico.ts": [
    "AUSENTE",
    "c85bfe70b2f777ad24e3a5f6cf9bb7e91493e836"
  ],
  "app/api/anuncios/[id]/route.ts": [
    "c075653:app/api/anuncios/[id]/route.ts",
    "c432116aa68c0ab7897d4235f98ab0eab7b6b1b2"
  ],
  "app/(app)/anuncios/FormAnuncio.tsx": [
    "7839d48286112bc9c9da902bbd19e9297d78c5f4",
    "e1216fd04f763327102454571d2ed5cc019ac826"
  ]
};
const PATCH: Record<string, { base: string; novo: string }[]> = {
  "lib/sync-shopee.ts": [
    {
      "base": " * duplicar na rota de backfill pontual). Mesma query, mesmo resultado.\n */\nexport async function carregarMapaAnuncios(userId: string): Promise<Map<string, any>> {\n  const { data: anuncios } = await supabase()",
      "novo": " * duplicar na rota de backfill pontual). Mesma query, mesmo resultado.\n *\n * ANUNCIOS MULTI-LOJA: o mapa e SEMPRE de UMA loja Shopee (dono + loja_id).\n * Nunca junta anuncios de todas as lojas do dono — o mesmo item/model em\n * outra loja e outro anuncio (outro custo). Sem loja → erro (fail-closed).\n */\nexport async function carregarMapaAnuncios(userId: string, lojaId: string): Promise<Map<string, any>> {\n  if (!lojaId) throw new Error(\"carregarMapaAnuncios: loja_obrigatoria\");\n  const { data: anuncios } = await supabase()"
    },
    {
      "base": "    .eq(\"ativo\", true)\n    .eq(\"user_id\", userId);\n",
      "novo": "    .eq(\"ativo\", true)\n    .eq(\"user_id\", userId)\n    .eq(\"loja_id\", lojaId);\n"
    },
    {
      "base": "  const _etapa2InicioMs = Date.now();\n  const mapaAnuncios = await carregarMapaAnuncios(userId);\n  console.log(\"[DIAG-SYNC-SHOPEE] etapa2_anuncios\", { tempoMs: Date.now() - _etapa2InicioMs });",
      "novo": "  const _etapa2InicioMs = Date.now();\n  const mapaAnuncios = await carregarMapaAnuncios(userId, lojaId);\n  console.log(\"[DIAG-SYNC-SHOPEE] etapa2_anuncios\", { tempoMs: Date.now() - _etapa2InicioMs });"
    }
  ],
  "app/api/shopee/importar-anuncios/route.ts": [
    {
      "base": "  }\n  // Busca a loja ESCOLHIDA com refresh automático de token",
      "novo": "  }\n  // ANUNCIOS MULTI-LOJA: anuncio Shopee historico SEM loja_id (backfill ambiguo)\n  // ainda nao tem dono de loja definido. Importar agora criaria uma segunda\n  // linha do mesmo item ao lado dela → recusa ANTES de qualquer chamada a Shopee.\n  const { count: semLoja, error: erroSemLoja } = await supabase()\n    .from(\"anuncios\").select(\"id\", { count: \"exact\", head: true })\n    .eq(\"user_id\", userId).eq(\"marketplace\", \"Shopee\").is(\"loja_id\", null);\n  if (erroSemLoja) {\n    return NextResponse.json({ erro: true, mensagem: \"Não foi possível ler seus anúncios agora.\" }, { status: 503 });\n  }\n  if ((semLoja ?? 0) > 0) {\n    return NextResponse.json({ erro: true, codigo: \"ANUNCIOS_SEM_LOJA\",\n      mensagem: \"Há anúncios Shopee antigos ainda sem loja associada. A importação fica bloqueada até essa associação ser concluída.\" }, { status: 409 });\n  }\n  // Busca a loja ESCOLHIDA com refresh automático de token"
    },
    {
      "base": "\n  // ── 2. Busca existentes no Supabase (apenas deste usuário) ──────────────\n  const { data: existentes } = await supabase()\n    .from(\"anuncios\")",
      "novo": "\n  // ── 2. Busca existentes no Supabase (apenas deste usuário E desta loja) ──\n  // ANUNCIOS MULTI-LOJA: a chave `item|variacao` so vale DENTRO de uma loja.\n  // Leitura falha → para (mapa vazio reinseriria tudo como novo).\n  const lojaId = selecao.lojaId;\n  const { data: existentes, error: erroExistentes } = await supabase()\n    .from(\"anuncios\")"
    },
    {
      "base": "    .eq(\"marketplace\", \"Shopee\")\n    .eq(\"user_id\", userId);\n",
      "novo": "    .eq(\"marketplace\", \"Shopee\")\n    .eq(\"user_id\", userId)\n    .eq(\"loja_id\", lojaId);\n  if (erroExistentes) {\n    return NextResponse.json({ erro: true, mensagem: \"Não foi possível ler seus anúncios agora.\" }, { status: 503 });\n  }\n"
    },
    {
      "base": "  let atualizados = 0;\n  const BATCH = 50;",
      "novo": "  let atualizados = 0;\n  let conflitos = 0;\n  const BATCH = 50;"
    },
    {
      "base": "        // ── Sem variação ──────────────────────────────────────────────────\n        const preco = (item.price_info?.[0]?.current_price ?? item.price ?? 0) / 100000;\n        const sku   = item.sku ?? null;",
      "novo": "        // ── Sem variação ──────────────────────────────────────────────────\n        // Open API v2: price_info.current_price ja vem em REAIS decimais (ex.: 18.23) —\n        // mesma unidade de model_discounted_price usada pelo sync de pedidos. O \"/100000\"\n        // era a convencao da API v1 e gravava 0.0001823 (auditoria: preco×100000 = preco vendido).\n        const preco = Number(item.price_info?.[0]?.current_price ?? item.price ?? 0);\n        const sku   = item.sku ?? null;"
    },
    {
      "base": "          if (!existente.sku && sku) upd.sku = sku;\n          await supabase().from(\"anuncios\").update(upd).eq(\"id\", existente.id);\n          atualizados++;\n        } else {\n          await supabase().from(\"anuncios\").insert({\n            marketplace: \"Shopee\", nome: titulo,",
      "novo": "          if (!existente.sku && sku) upd.sku = sku;\n          // loja_id NAO entra no update (preservado) e o WHERE prende dono + loja.\n          await supabase().from(\"anuncios\").update(upd).eq(\"id\", existente.id).eq(\"user_id\", userId).eq(\"loja_id\", lojaId);\n          atualizados++;\n        } else {\n          const { error: erroInsert } = await supabase().from(\"anuncios\").insert({\n            marketplace: \"Shopee\", nome: titulo,"
    },
    {
      "base": "            margem_desejada: 0, frete_gratis: false, ativo: true,\n            user_id: userId,\n          });\n          importados++;\n        }",
      "novo": "            margem_desejada: 0, frete_gratis: false, ativo: true,\n            user_id: userId, loja_id: lojaId,\n          });\n          if (erroInsert) conflitos++; else importados++;\n        }"
    },
    {
      "base": "          const nomeVar     = model.model_name ? `${titulo} - ${model.model_name}` : titulo;\n          const preco       = (model.price_info?.[0]?.current_price ?? 0) / 100000;\n          const sku         = model.model_sku ?? null;",
      "novo": "          const nomeVar     = model.model_name ? `${titulo} - ${model.model_name}` : titulo;\n          const preco       = Number(model.price_info?.[0]?.current_price ?? 0);   // reais (ver acima)\n          const sku         = model.model_sku ?? null;"
    },
    {
      "base": "            if (!existente.sku && sku) upd.sku = sku;\n            await supabase().from(\"anuncios\").update(upd).eq(\"id\", existente.id);\n            atualizados++;\n          } else {\n            await supabase().from(\"anuncios\").insert({\n              marketplace: \"Shopee\", nome: nomeVar,",
      "novo": "            if (!existente.sku && sku) upd.sku = sku;\n            await supabase().from(\"anuncios\").update(upd).eq(\"id\", existente.id).eq(\"user_id\", userId).eq(\"loja_id\", lojaId);\n            atualizados++;\n          } else {\n            const { error: erroInsert } = await supabase().from(\"anuncios\").insert({\n              marketplace: \"Shopee\", nome: nomeVar,"
    },
    {
      "base": "              margem_desejada: 0, frete_gratis: false, ativo: true,\n              user_id: userId,\n            });\n            importados++;\n          }",
      "novo": "              margem_desejada: 0, frete_gratis: false, ativo: true,\n              user_id: userId, loja_id: lojaId,\n            });\n            // UNIQUE da fase 2: importacao concorrente da MESMA loja → conflito, nunca segunda linha\n            if (erroInsert) conflitos++; else importados++;\n          }"
    },
    {
      "base": "\n  return NextResponse.json({ importados, atualizados, total: allItemIds.length });\n}",
      "novo": "\n  return NextResponse.json({ importados, atualizados, conflitos, total: allItemIds.length, loja_id: lojaId });\n}"
    }
  ],
  "app/api/admin/shopee/backfill-pedidos-0707/route.ts": [
    {
      "base": "  // ── 2) get_order_detail só para os novos (nunca get_order_list) ─────────\n  const mapaAnuncios = await carregarMapaAnuncios(userId);\n",
      "novo": "  // ── 2) get_order_detail só para os novos (nunca get_order_list) ─────────\n  const mapaAnuncios = await carregarMapaAnuncios(userId, loja.lojaId);\n"
    }
  ],
  "lib/anuncios/servico.ts": [
    {
      "base": "  }\n  if (parcial) {",
      "novo": "  }\n  // ANUNCIOS MULTI-LOJA: anuncio Shopee pertence a UMA loja, e a loja nunca vem\n  // do browser. Ele nasce (e ganha a loja) SO pela importacao da loja escolhida;\n  // criar Shopee à mao geraria linha sem loja. (Edicao: ver atualizarAnuncioDoDono.)\n  if (!parcial && campos.marketplace === \"Shopee\") {\n    return { ok: false, erro: \"Anúncio Shopee é criado pela importação da loja Shopee.\" };\n  }\n  if (parcial) {"
    },
    {
      "base": "\n/**",
      "novo": "\n/** Identidade de um anuncio Shopee: vem SEMPRE do banco, nunca do browser (loja_id nem e gravavel). */\nconst IDENTIDADE_SHOPEE = [\"marketplace\", \"ml_item_id\", \"variation_id\"] as const;\n\n/**"
    },
    {
      "base": " * do mesmo jeito: a rota responde 404 sem revelar se ele existe.\n */",
      "novo": " * do mesmo jeito: a rota responde 404 sem revelar se ele existe.\n *\n * ANUNCIOS MULTI-LOJA: a identidade de um anuncio Shopee (marketplace / item /\n * variacao — e a loja, que nem e gravavel) e a do BANCO. Toda escrita continua\n * com `id` E `user_id`; quando o payload traz campo de identidade, a escrita\n * tambem prende o marketplace da row:\n *   - row Shopee: grava SO os campos de negocio (identidade enviada ignorada);\n *   - row ML: comportamento de sempre, mas nunca vira Shopee\n *     (\"identidade_recusada\" → 400, nada gravado).\n */"
    },
    {
      "base": "  cliente: SupabaseClient, dono: string, id: string, campos: Record<string, unknown>\n): Promise<boolean | null> {\n  const { data, error } = await cliente\n    .from(\"anuncios\")\n    .update(campos)\n    .eq(\"id\", id)\n    .eq(\"user_id\", dono)\n    .select(\"id\");\n  if (error) return null;\n  return (data ?? []).length > 0;\n}",
      "novo": "  cliente: SupabaseClient, dono: string, id: string, campos: Record<string, unknown>\n): Promise<boolean | null | \"identidade_recusada\"> {\n  const escrever = async (payload: Record<string, unknown>, marketplace?: \"Shopee\" | \"ML\") => {\n    let q = cliente.from(\"anuncios\").update(payload).eq(\"id\", id).eq(\"user_id\", dono);\n    if (marketplace) q = q.eq(\"marketplace\", marketplace);\n    const { data, error } = await q.select(\"id\");\n    return error ? null : (data ?? []).length > 0;\n  };\n  if (!IDENTIDADE_SHOPEE.some((c) => c in campos)) return escrever(campos);\n\n  const semIdentidade: Record<string, unknown> = { ...campos };\n  for (const c of IDENTIDADE_SHOPEE) delete semIdentidade[c];\n  if (Object.keys(semIdentidade).length > 0) {\n    const shopee = await escrever(semIdentidade, \"Shopee\");\n    if (shopee !== false) return shopee;\n  }\n  if (campos.marketplace !== \"Shopee\") {\n    const ml = await escrever(campos, \"ML\");\n    if (ml !== false) return ml;\n  }\n  // Nada gravado: anuncio Shopee so com identidade (no-op), ML virando Shopee\n  // (recusa) ou anuncio alheio/inexistente (404 identico, nao revela existencia).\n  const { data: atual, error } = await cliente\n    .from(\"anuncios\")\n    .select(\"id, marketplace\")\n    .eq(\"id\", id)\n    .eq(\"user_id\", dono)\n    .maybeSingle();\n  if (error) return null;\n  if (!atual) return false;\n  return (atual as { marketplace: string }).marketplace === \"Shopee\" ? true : \"identidade_recusada\";\n}"
    }
  ],
  "app/api/anuncios/[id]/route.ts": [
    {
      "base": "  }\n  if (!alterou) {",
      "novo": "  }\n  if (alterou === \"identidade_recusada\") {\n    return NextResponse.json({ erro: \"Anúncio Shopee é criado pela importação da loja Shopee.\" }, { status: 400 });\n  }\n  if (!alterou) {"
    }
  ],
  "app/(app)/anuncios/FormAnuncio.tsx": [
    {
      "base": "  useEffect(() => {\n    if (!modoEdicao || !inicial?.ml_item_id) return;\n    const varId = inicial.variation_id ?? \"\";",
      "novo": "  useEffect(() => {\n    // Anúncio Shopee: o item_id não é do ML — nada a re-buscar lá (os dados do\n    // ML sobrescreveriam título/preço/foto do anúncio Shopee).\n    if (!modoEdicao || !inicial?.ml_item_id || inicial.marketplace === \"Shopee\") return;\n    const varId = inicial.variation_id ?? \"\";"
    },
    {
      "base": "    if (r) (payload as any).margem_desejada = Math.round(r.margem * 100) / 100;\n",
      "novo": "    if (r) (payload as any).margem_desejada = Math.round(r.margem * 100) / 100;\n    // Edição: a identidade (marketplace / item / variação) é a da row no banco —\n    // o PATCH não a envia (antes ia \"ML\" fixo e convertia anúncio Shopee em ML).\n    if (inicial) {\n      delete (payload as any).marketplace;\n      delete (payload as any).ml_item_id;\n      delete (payload as any).variation_id;\n    }\n"
    }
  ]
};

const lf = (s: string) => s.replace(/\r\n/g, "\n");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
function blob(raiz: string, rev: string, arquivo: string): string | null {
  try { return lf(execFileSync("git", ["show", `${rev}:${arquivo}`], { cwd: raiz, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })); }
  catch { return null; }
}
function idBlob(raiz: string, rev: string, arquivo: string): string | null {
  try { return execFileSync("git", ["rev-parse", `${rev}:${arquivo}`], { cwd: raiz, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return null; }
}
function ler(raiz: string, arquivo: string): string | null {
  try { return lf(readFileSync(join(raiz, arquivo), "utf8")); } catch { return null; }
}

/** Arquivo atual − hunks aprovados = bb8f7ea, byte a byte (cada hunk exatamente uma vez). */
export function arquivoExatoAnunciosMultiStore(raiz: string, arquivo: string): boolean {
  const hunks = PATCH[arquivo];
  let s = hunks ? ler(raiz, arquivo) : null;
  if (s === null) return false;
  for (const h of hunks) {
    if (s.split(h.novo).length !== 2) return false;
    s = s.replace(h.novo, () => h.base);
  }
  const base = blob(raiz, BASE_ANUNCIOS_MULTI_STORE, arquivo);
  return base !== null && s === base;
}

export function novoExatoAnunciosMultiStore(raiz: string, arquivo: string): boolean {
  if (arquivo === HELPER_ANUNCIOS_MULTI_STORE) {
    const s = ler(raiz, HELPER_ANUNCIOS_MULTI_STORE);
    return s !== null && sha(s.replace(/const SHA256_HELPER_ANUNCIOS_MULTI_STORE = "[0-9a-f]{64}";/, `const SHA256_HELPER_ANUNCIOS_MULTI_STORE = "${"0".repeat(64)}";`)) === SHA256_HELPER_ANUNCIOS_MULTI_STORE;
  }
  const esperado = SHA256_NOVOS[arquivo];
  const s = esperado ? ler(raiz, arquivo) : null;
  return s !== null && sha(s) === esperado;
}

const ehNovo = (f: string) => f in SHA256_NOVOS || f === HELPER_ANUNCIOS_MULTI_STORE;

/** Remove da lista SO o que esta excecao cobre (arquivos exatos com base aprovada; novos exatos ausentes na base). */
export function filtrarExcecaoAnunciosMultiStore(raiz: string, base: string, alterados: string[]): string[] {
  return alterados.filter((f) => {
    if (f in PATCH) { const b = idBlob(raiz, base, f) ?? AUSENTE; return !(BLOBS_BASE_APROVADOS[f].includes(b) && arquivoExatoAnunciosMultiStore(raiz, f)); }
    if (ehNovo(f) && blob(raiz, base, f) === null) return !novoExatoAnunciosMultiStore(raiz, f);
    return true;
  });
}

/**
 * Colunas de public.anuncios que existem SO na migration pendente da fase 1.
 * Vazio se a migration nao for byte-exata (o guard de schema volta a recusar loja_id).
 */
export function colunasPendentesAprovadasAnuncios(raiz: string): string[] {
  return novoExatoAnunciosMultiStore(raiz, MIGRACAO_ANUNCIOS_FASE1) && novoExatoAnunciosMultiStore(raiz, HELPER_ANUNCIOS_MULTI_STORE)
    ? [...COLUNAS_PENDENTES_FASE1] : [];
}
