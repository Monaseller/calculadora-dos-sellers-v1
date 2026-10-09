/**
 * SHOPEE PRODUCT IMPORT V2 — excecao EXATA dos guards para a importacao de
 * anuncios Shopee em FATIAS retomaveis (cursor por item_id concluido, item
 * atomico, orcamento de 35s, lote de INSERT, get_model_list com concorrencia 3).
 *
 * Camada SOBRE todas as anteriores: cada arquivo abaixo so passa se, revertendo
 * EXATAMENTE os hunks aprovados (gerados do diff contra d872390), o resultado
 * for BYTE-IDENTICO ao blob de d872390 — versao que passou por todos os guards —
 * e se o arquivo na base do guard for um estado aprovado (pinado abaixo; AUSENTE
 * quando ainda nao existia naquela base). Sem curinga.
 *
 * NOVOS, so com o conteudo EXATO (sha256, forma LF) e so se nao existiam na base
 * do guard: o motor lib/anuncios/importacao-shopee.ts, o helper da tela
 * app/(app)/anuncios/importacao-shopee.ts (alcancado por page.tsx "use client"),
 * a suite testar-shopee-importacao-retomavel e este helper (auto-pin).
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const BASE_SHOPEE_IMPORT_V2 = "d872390";
export const HELPER_SHOPEE_IMPORT_V2 = "scripts/_excecao-shopee-import-v2.ts";

const AUSENTE = "AUSENTE";
const SHA256_NOVOS: Record<string, string> = {
  "lib/anuncios/importacao-shopee.ts": "5ca809ab045433bb7b1301fd79162aeb532b4e4a5906afd359fa607a0a16a31e",
  "app/(app)/anuncios/importacao-shopee.ts": "e7d6779e325a288296e2f1570bbd7c14203a6ddb907432dff8d8d83063dc5dc0",
  "scripts/testar-shopee-importacao-retomavel.ts": "c47594131d099c978c728a414e4a5fcc8f4fd88c842cadb48d77f355d2424356"
};
const SHA256_HELPER_SHOPEE_IMPORT_V2 = "8fc8200ed29e95f261382cc5c2e3a7d9cb6c2f1a187a374c8e2f749d03c16fdd";
const BLOBS_BASE_APROVADOS: Record<string, string[]> = {
  "app/api/shopee/importar-anuncios/route.ts": [
    "0b6e6474141fa1b3130bf7ec91874c417e1234dc",
    "1c9a7c70445ba05b11f5cfeb303cc05eb6299d49",
    "78c6cba992fd9da5675340f9cce84420f72bc994"
  ],
  "app/(app)/anuncios/page.tsx": [
    "3bc6841b1a9874443ea9afc69210698f468293c4",
    "63aeab767c7bb5fc58c971aa7332bce4331fa478",
    "e0f1e85af8ad4f8ddfc15ec855e486711458d4af"
  ]
};
const PATCH: Record<string, { base: string; novo: string }[]> = {
  "app/api/shopee/importar-anuncios/route.ts": [
    {
      "base": "import { getSupabaseServidor } from \"@/lib/estudio-anuncios/supabase-servidor\";\nimport { shopeeGet } from \"@/lib/shopee-api\";\nimport { autenticarRequisicao } from \"@/lib/autenticacao\";",
      "novo": "import { getSupabaseServidor } from \"@/lib/estudio-anuncios/supabase-servidor\";\nimport { codificarCursor, ErroImportacaoShopee, importarFatiaShopee, lerCursor } from \"@/lib/anuncios/importacao-shopee\";\nimport { autenticarRequisicao } from \"@/lib/autenticacao\";"
    },
    {
      "base": "export async function POST(request: Request) {\n  const auth = await autenticarRequisicao(request);",
      "novo": "export async function POST(request: Request) {\n  const inicioMs = Date.now();   // o orcamento da fatia conta a request inteira\n  const auth = await autenticarRequisicao(request);"
    },
    {
      "base": "  // STORE_SELECTION_REQUIRED (a tela pergunta qual). O cookie \"Usar esta\" NAO decide aqui.\n  const corpoPedido = await request.json().catch(() => ({})) as { loja_id?: string };\n  const selecao = await selecionarLojaShopee(userId, {",
      "novo": "  // STORE_SELECTION_REQUIRED (a tela pergunta qual). O cookie \"Usar esta\" NAO decide aqui.\n  const corpoPedido = await request.json().catch(() => ({})) as { loja_id?: string; cursor?: unknown };\n  const selecao = await selecionarLojaShopee(userId, {"
    },
    {
      "base": "  }\n  // Busca a loja ESCOLHIDA com refresh automático de token",
      "novo": "  }\n  // IMPORT V2 (fatias retomaveis): o cursor e validado ANTES de qualquer\n  // chamada a Shopee — invalido ou de outra loja → 400, nada importado.\n  const cursorLido = lerCursor(corpoPedido.cursor, selecao.lojaId);\n  if (!cursorLido.ok) {\n    return NextResponse.json({ erro: true, codigo: cursorLido.motivo,\n      mensagem: \"Não foi possível continuar a importação (marcador inválido). Inicie a importação novamente.\" }, { status: 400 });\n  }\n  // Busca a loja ESCOLHIDA com refresh automático de token"
    },
    {
      "base": "\n  const { partnerId: partner_id, partnerKey: partner_key, accessToken: access_token, shopId } = lojaAtiva;\n\n  // ── 1. Lista todos os item_ids ativos ────────────────────────────────────\n  const allItemIds: number[] = [];\n  let offset = 0;\n  const pageSize = 100;\n\n  for (;;) {\n    const data = await shopeeGet(\"/api/v2/product/get_item_list\", partner_id, partner_key, access_token, shopId, {\n      offset,\n      page_size: pageSize,\n      item_status: \"NORMAL\",\n    });\n\n    const items: any[] = data?.response?.item ?? [];\n    allItemIds.push(...items.map((i: any) => i.item_id));\n\n    if (!data?.response?.has_next_page) break;\n    offset += pageSize;\n  }\n\n  if (allItemIds.length === 0) {\n    return NextResponse.json({ importados: 0, atualizados: 0, total: 0 });\n  }\n\n  // ── 2. Busca existentes no Supabase (apenas deste usuário E desta loja) ──\n  // ANUNCIOS MULTI-LOJA: a chave `item|variacao` so vale DENTRO de uma loja.\n  // Leitura falha → para (mapa vazio reinseriria tudo como novo).\n  const lojaId = selecao.lojaId;\n  const { data: existentes, error: erroExistentes } = await supabase()\n    .from(\"anuncios\")\n    .select(\"id, ml_item_id, variation_id, sku, custo_produto, insumos, custo_frete, imposto\")\n    .eq(\"marketplace\", \"Shopee\")\n    .eq(\"user_id\", userId)\n    .eq(\"loja_id\", lojaId);\n  if (erroExistentes) {\n    return NextResponse.json({ erro: true, mensagem: \"Não foi possível ler seus anúncios agora.\" }, { status: 503 });\n  }\n\n  const existMap = new Map<string, any>();\n  for (const row of (existentes ?? [])) {\n    const key = `${row.ml_item_id}|${row.variation_id ?? \"\"}`;\n    existMap.set(key, row);\n  }\n\n  // ── 3. Detalhes em lotes de 50 ───────────────────────────────────────────\n  let importados = 0;\n  let atualizados = 0;\n  let conflitos = 0;\n  const BATCH = 50;\n\n  for (let i = 0; i < allItemIds.length; i += BATCH) {\n    const batch = allItemIds.slice(i, i + BATCH);\n\n    const baseInfo = await shopeeGet(\"/api/v2/product/get_item_base_info\", partner_id, partner_key, access_token, shopId, {\n      item_id_list: batch.join(\",\"),\n      need_tax_info: \"false\",\n      need_complaint_policy: \"false\",\n    });\n\n    const items: any[] = baseInfo?.response?.item_list ?? [];\n\n    for (const item of items) {\n      const itemId    = String(item.item_id);\n      const titulo    = item.item_name ?? itemId;\n      const thumbnail = item.image?.image_url_list?.[0] ?? null;\n\n      const hasModels = (item.has_model ?? false) || (item.model_list?.length ?? 0) > 0;\n\n      if (!hasModels) {\n        // ── Sem variação ──────────────────────────────────────────────────\n        // Open API v2: price_info.current_price ja vem em REAIS decimais (ex.: 18.23) —\n        // mesma unidade de model_discounted_price usada pelo sync de pedidos. O \"/100000\"\n        // era a convencao da API v1 e gravava 0.0001823 (auditoria: preco×100000 = preco vendido).\n        const preco = Number(item.price_info?.[0]?.current_price ?? item.price ?? 0);\n        const sku   = item.sku ?? null;\n        const key   = `${itemId}|`;\n        const existente = existMap.get(key);\n\n        if (existente) {\n          // `ativo` NÃO entra no update (F0.c.18A). Exclusão na CDS é\n          // decisão do usuário: importar não pode ressuscitar o que ele\n          // apagou. Linha ativa continua ativa; linha soft-deleted tem os\n          // dados atualizados e permanece `ativo=false`.\n          const upd: any = { nome: titulo, preco_anuncio: preco, thumbnail };\n          if (!existente.sku && sku) upd.sku = sku;\n          // loja_id NAO entra no update (preservado) e o WHERE prende dono + loja.\n          await supabase().from(\"anuncios\").update(upd).eq(\"id\", existente.id).eq(\"user_id\", userId).eq(\"loja_id\", lojaId);\n          atualizados++;\n        } else {\n          const { error: erroInsert } = await supabase().from(\"anuncios\").insert({\n            marketplace: \"Shopee\", nome: titulo,\n            ml_item_id: itemId, variation_id: null,\n            preco_anuncio: preco, sku, thumbnail,\n            custo_produto: 0, insumos: 0, custo_frete: 0, imposto: 0,\n            margem_desejada: 0, frete_gratis: false, ativo: true,\n            user_id: userId, loja_id: lojaId,\n          });\n          if (erroInsert) conflitos++; else importados++;\n        }\n      } else {\n        // ── Com variações: busca modelos ──────────────────────────────────\n        const modelData = await shopeeGet(\"/api/v2/product/get_model_list\", partner_id, partner_key, access_token, shopId, {\n          item_id: item.item_id,\n        });\n        const models: any[] = modelData?.response?.model ?? [];\n\n        for (const model of models) {\n          const variationId = String(model.model_id);\n          const nomeVar     = model.model_name ? `${titulo} - ${model.model_name}` : titulo;\n          const preco       = Number(model.price_info?.[0]?.current_price ?? 0);   // reais (ver acima)\n          const sku         = model.model_sku ?? null;\n          const key         = `${itemId}|${variationId}`;\n          const existente   = existMap.get(key);\n\n          if (existente) {\n            // Ver comentário acima: `ativo` fora do update.\n            const upd: any = { nome: nomeVar, preco_anuncio: preco, thumbnail };\n            if (!existente.sku && sku) upd.sku = sku;\n            await supabase().from(\"anuncios\").update(upd).eq(\"id\", existente.id).eq(\"user_id\", userId).eq(\"loja_id\", lojaId);\n            atualizados++;\n          } else {\n            const { error: erroInsert } = await supabase().from(\"anuncios\").insert({\n              marketplace: \"Shopee\", nome: nomeVar,\n              ml_item_id: itemId, variation_id: variationId,\n              preco_anuncio: preco, sku, thumbnail,\n              custo_produto: 0, insumos: 0, custo_frete: 0, imposto: 0,\n              margem_desejada: 0, frete_gratis: false, ativo: true,\n              user_id: userId, loja_id: lojaId,\n            });\n            // UNIQUE da fase 2: importacao concorrente da MESMA loja → conflito, nunca segunda linha\n            if (erroInsert) conflitos++; else importados++;\n          }\n        }\n      }\n    }\n\n    if (i + BATCH < allItemIds.length) {\n      await new Promise(r => setTimeout(r, 300));\n    }\n  }\n\n  return NextResponse.json({ importados, atualizados, conflitos, total: allItemIds.length, loja_id: lojaId });\n}",
      "novo": "\n  // Uma FATIA por request (orcamento de tempo, item atomico, cursor por item_id\n  // concluido): a tela repete com `cursor` ate `parcial: false`.\n  const lojaId = selecao.lojaId;\n  try {\n    const r = await importarFatiaShopee({ banco: supabase(), userId, lojaId, cred: lojaAtiva, ultimoItem: cursorLido.ultimoItem, inicioMs });\n    return NextResponse.json({\n      parcial: r.parcial, cursor: r.cursor, loja_id: lojaId,\n      importados: r.importados, atualizados: r.atualizados, ignorados: r.ignorados,\n      itens_processados: r.itensProcessados, total: r.total,\n    });\n  } catch (e) {\n    // Progresso ja gravado fica. `cursor` = ultimo item COMPLETO e gravado (retomavel dali).\n    if (e instanceof ErroImportacaoShopee) {\n      console.error(`[importar-anuncios] fatia interrompida (${e.codigo}): ${e.message}`);\n      return NextResponse.json({ erro: true, codigo: e.codigo === \"PROVIDER\" ? \"FALHA_SHOPEE\" : \"FALHA_BANCO\",\n        loja_id: lojaId, cursor: e.ultimoConcluido ? codificarCursor(lojaId, e.ultimoConcluido) : null,\n        mensagem: e.codigo === \"PROVIDER\"\n          ? \"A Shopee recusou ou não respondeu a uma consulta de produtos. O que já foi importado foi mantido; tente novamente.\"\n          : \"Não foi possível gravar parte dos anúncios agora. O que já foi importado foi mantido; tente novamente.\" }, { status: 502 });\n    }\n    throw e;\n  }\n}"
    }
  ],
  "app/(app)/anuncios/page.tsx": [
    {
      "base": "} from \"./paginacao\";\n",
      "novo": "} from \"./paginacao\";\nimport { importarShopeeEmFatias } from \"./importacao-shopee\";\n"
    },
    {
      "base": "      // quando ha uma unica loja Shopee ativa (senao 409 STORE_SELECTION_REQUIRED).\n      const res = await fetch(\"/api/shopee/importar-anuncios\", {\n        method: \"POST\",\n        ...(lojaId ? { headers: { \"Content-Type\": \"application/json\" }, body: JSON.stringify({ loja_id: lojaId }) } : {}),\n      });\n      const corpoTexto = await res.text();\n      if (res.status === 409) {\n        let escolha: { id: string; rotulo: string }[] = [];\n        try {\n          const d = JSON.parse(corpoTexto);\n          if (d?.codigo === \"STORE_SELECTION_REQUIRED\" && Array.isArray(d.lojas)) {\n            escolha = d.lojas.filter((l: { id?: unknown; rotulo?: unknown }) => typeof l?.id === \"string\")\n              .map((l: { id: string; rotulo?: unknown }) => ({ id: l.id, rotulo: String(l.rotulo ?? \"Shopee\") }));\n          }\n        } catch { /* corpo nao-JSON: cai na classificacao padrao abaixo */ }\n        if (escolha.length) { setLojasShopeeEscolha(escolha); setImportandoShopee(false); return; }\n      }\n      // Ver comentário em importarDoML: o corpo cru é que distingue\n      // timeout nosso de erro do marketplace.\n      const r = classificarRespostaImportacao(res.status, corpoTexto, \"Shopee\");\n      if (r.classe !== \"SUCESSO\") {\n        setMsgImportShopee({ ok: false, texto: r.mensagem });\n      } else {\n        const data = r.dados;\n        setMsgImportShopee({\n          ok: true,\n          texto: `🟠 ${data.importados} importados, ${data.atualizados} atualizados — total ${data.total} anúncios na Shopee`,\n        });",
      "novo": "      // quando ha uma unica loja Shopee ativa (senao 409 STORE_SELECTION_REQUIRED).\n      // IMPORT V2: em fatias — enquanto `parcial`, continua com o cursor do servidor.\n      const r = await importarShopeeEmFatias(async (corpo) => {\n        const res = await fetch(\"/api/shopee/importar-anuncios\", {\n          method: \"POST\", headers: { \"Content-Type\": \"application/json\" }, body: JSON.stringify(corpo),\n        });\n        // Ver comentário em importarDoML: o corpo cru é que distingue\n        // timeout nosso de erro do marketplace.\n        return { status: res.status, texto: await res.text() };\n      }, lojaId, (p) => setMsgImportShopee({ ok: true, texto: `🟠 Importando produtos Shopee... ${p.itensProcessados} de ${p.total} processados` }));\n      if (r.tipo === \"escolher_loja\") { setLojasShopeeEscolha(r.lojas); setImportandoShopee(false); return; }\n      if (r.tipo === \"erro\") {\n        setMsgImportShopee({ ok: false, texto: r.mensagem });\n        if (r.progresso.importados + r.progresso.atualizados > 0) await carregar();\n      } else {\n        const p = r.progresso;\n        setMsgImportShopee({\n          ok: true,\n          texto: `🟠 ${p.importados} importados, ${p.atualizados} atualizados, ${p.ignorados} sem mudança — total ${p.total} anúncios na Shopee`,\n        });"
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

/** Arquivo atual − hunks aprovados = d872390, byte a byte (cada hunk exatamente uma vez). */
export function arquivoExatoShopeeImportV2(raiz: string, arquivo: string): boolean {
  const hunks = PATCH[arquivo];
  let s = hunks ? ler(raiz, arquivo) : null;
  if (s === null) return false;
  for (const h of hunks) {
    if (s.split(h.novo).length !== 2) return false;
    s = s.replace(h.novo, () => h.base);
  }
  const base = blob(raiz, BASE_SHOPEE_IMPORT_V2, arquivo);
  return base !== null && s === base;
}

export function novoExatoShopeeImportV2(raiz: string, arquivo: string): boolean {
  if (arquivo === HELPER_SHOPEE_IMPORT_V2) {
    const s = ler(raiz, HELPER_SHOPEE_IMPORT_V2);
    return s !== null && sha(s.replace(/const SHA256_HELPER_SHOPEE_IMPORT_V2 = "[0-9a-f]{64}";/, `const SHA256_HELPER_SHOPEE_IMPORT_V2 = "${"0".repeat(64)}";`)) === SHA256_HELPER_SHOPEE_IMPORT_V2;
  }
  const esperado = SHA256_NOVOS[arquivo];
  const s = esperado ? ler(raiz, arquivo) : null;
  return s !== null && sha(s) === esperado;
}

const ehNovo = (f: string) => f in SHA256_NOVOS || f === HELPER_SHOPEE_IMPORT_V2;

/** Remove da lista SO o que esta excecao cobre (arquivos exatos com base aprovada; novos exatos ausentes na base). */
export function filtrarExcecaoShopeeImportV2(raiz: string, base: string, alterados: string[]): string[] {
  return alterados.filter((f) => {
    if (f in PATCH) { const b = idBlob(raiz, base, f) ?? AUSENTE; return !(BLOBS_BASE_APROVADOS[f].includes(b) && arquivoExatoShopeeImportV2(raiz, f)); }
    if (ehNovo(f) && blob(raiz, base, f) === null) return !novoExatoShopeeImportV2(raiz, f);
    return true;
  });
}
