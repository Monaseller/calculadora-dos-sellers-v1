import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import { autenticarRequisicao, lerCookie } from "@/lib/autenticacao";
import { contarLojasMLAtivasDoDono, MULTI_ML_CATALOG_NOT_READY, resolverContaML } from "@/lib/ml-conexao";
import { lerTodasAsPaginas } from "@/lib/anuncios/leitura-paginada";

// SEC-3-B1: dados sensiveis (SEC-3) so por service_role, server-side.
// O cliente nasce sob demanda — nunca no import — a partir do helper
// oficial; o isolamento por dono e da propria rota, nao do banco.
let clienteServidor: SupabaseClient | null = null;
function supabase(): SupabaseClient {
  return (clienteServidor ??= getSupabaseServidor());
}

// Busca SKU via user_products API (fallback para itens omnichannel)
async function buscarSkuUserProducts(
  catalogProductId: string,
  userId: string,
  token: string
): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.mercadolibre.com/users/${userId}/user_products?catalog_product_id=${catalogProductId}&status=active`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const results = Array.isArray(data) ? data : (data.results ?? []);
    return results[0]?.seller_sku ?? results[0]?.seller_custom_field ?? null;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  // A sessão vem PRIMEIRO. Antes, a rota checava o cookie ANTES da sessão
  // e devolvia "Conta ML não conectada" — ou seja, um não-autenticado
  // recebia uma resposta sobre o estado da conta ML.
  const auth = await autenticarRequisicao(request);
  const userId = auth.autenticado ? auth.uid : null;
  if (!userId) {
    return NextResponse.json({ erro: true, mensagem: "Sessão inválida." }, { status: 401 });
  }

  // ── CREDENCIAL RESOLVIDA NO SERVIDOR (F0.c.5) ─────────────────────
  // Antes: `getToken(request)` lia SÓ o cookie `ml_access_token`, sem
  // nenhum caminho de banco. Com o cookie de 6 horas vencido, esta rota
  // falhava sempre — mesmo com credencial válida em `lojas` e com
  // `/api/ml/conexao` respondendo CONECTADO. Era a inconsistência que o
  // cutover existe para fechar.
  // CDS V2 Fase 1B: `anuncios` ML ainda nao tem loja_id (Fase 2). Com 2+ contas ML do dono o
  // catalogo falha fechado ANTES de provider/escrita — mesmo com loja_ativa_id apontando uma delas.
  if (await contarLojasMLAtivasDoDono(userId) > 1) {
    return NextResponse.json({ erro: true, codigo: MULTI_ML_CATALOG_NOT_READY,
      mensagem: "Catálogo com mais de uma conta do Mercado Livre ainda não é suportado." }, { status: 409 });
  }
  const conta = await resolverContaML(userId, lerCookie(request, "loja_ativa_id"), { permitirUnica: true });
  if (!conta.ok) {
    // Status 200 preservado DE PROPÓSITO nesta etapa: a tela lê
    // `data.erro`/`data.mensagem` e ignora o status. Trocar para 4xx aqui
    // é decisão à parte — fica registrado como dívida, não corrigido de
    // passagem no meio de um cutover.
    return NextResponse.json({
      erro: true,
      mensagem: conta.motivo === "LOJA_NAO_DEFINIDA"
        ? "Selecione a loja do Mercado Livre."
        : "Conta ML não conectada.",
    });
  }
  const token = conta.accessToken;

  // Busca anúncios com ml_item_id mas sem SKU (ou SKU vazio) — apenas deste usuário.
  // CDS V2 Fase 0: TODAS as páginas (o PostgREST corta em 1000 sem erro); falha de
  // leitura é 5xx — antes virava "nada para atualizar" em silêncio.
  // CDS V2 Fase 0C: SÓ anúncios ML — row Shopee (mesmo dono, ativa, sem SKU) nunca vira
  // candidata nem tem o id enviado ao Mercado Livre. Sem loja_id: ML ainda não tem (Fase 2).
  const leitura = await lerTodasAsPaginas<any>(() => supabase()
    .from("anuncios")
    .select("id, ml_item_id, variation_id, nome, sku")
    .eq("marketplace", "ML")
    .eq("ativo", true)
    .eq("user_id", userId)
    .not("ml_item_id", "is", null)
    .or("sku.is.null,sku.eq."));

  if (!leitura.ok) {
    console.error("[POST /api/ml/sync-skus] falha ao ler anúncios:", leitura.motivo);
    return NextResponse.json({ erro: true, mensagem: "Não foi possível carregar os anúncios agora." }, { status: 503 });
  }
  const anuncios = leitura.linhas;
  if (!anuncios.length) {
    return NextResponse.json({ atualizados: 0, mensagem: "Nenhum anúncio para atualizar." });
  }

  // Filtra apenas IDs MLB (MLBU não funciona na /items/)
  const candidatos = anuncios.filter(a =>
    a.ml_item_id?.toUpperCase().startsWith("MLB") &&
    !a.ml_item_id?.toUpperCase().startsWith("MLBU")
  );

  if (!candidatos.length) {
    return NextResponse.json({ atualizados: 0, mensagem: "Nenhum anúncio MLB sem SKU encontrado." });
  }

  // Obtém mlUserId (seller ID do ML) para o fallback user_products
  let mlUserId: string | null = null;
  try {
    const meRes = await fetch("https://api.mercadolibre.com/users/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (meRes.ok) {
      const meData = await meRes.json();
      mlUserId = String(meData.id);
    }
  } catch {}

  let atualizados = 0;
  const erros: string[] = [];

  // CDS V2 Fase 2B0: cada row é a sua identidade exata — item sem variação (variation_id
  // nulo) ou UMA variação (variation_id). SKU/preço vêm SÓ do item ou da variação daquela
  // row; nunca "o SKU da primeira variação", nunca o dado de uma variação na irmã.
  const skuDaVariacao = (fonte: any, variationId: string): string | null =>
    ((fonte?.variations ?? []) as any[]).find((v) => String(v.id) === variationId)?.seller_custom_field || null;

  // Busca em lotes de 20
  const LOTE = 20;
  for (let i = 0; i < candidatos.length; i += LOTE) {
    const lote = candidatos.slice(i, i + LOTE);
    // Variações irmãs no mesmo lote: o item vai UMA vez ao provider.
    const ids  = [...new Set(lote.map(a => a.ml_item_id))].join(",");

    try {
      const res = await fetch(
        `https://api.mercadolibre.com/items?ids=${ids}&attributes=id,title,price,thumbnail,seller_custom_field,variations,catalog_product_id`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (!res.ok) {
        erros.push(`Lote ${i / LOTE + 1}: HTTP ${res.status}`);
        continue;
      }

      const resultados: Array<{ code: number; body: any }> = await res.json();
      const corpos = new Map<string, any>();
      for (const item of resultados) {
        if (item.code === 200 && item.body?.id) corpos.set(String(item.body.id), item.body);
      }

      // Busca individual completa: no máximo uma vez por item (cache por lote).
      const completos = new Map<string, Promise<any | null>>();
      const buscarCompleto = (itemId: string) => {
        if (!completos.has(itemId)) {
          completos.set(itemId, (async () => {
            try {
              const fullRes = await fetch(
                `https://api.mercadolibre.com/items/${itemId}`,
                { headers: { Authorization: `Bearer ${token}` } }
              );
              return fullRes.ok ? await fullRes.json() : null;
            } catch { return null; }
          })());
        }
        return completos.get(itemId)!;
      };

      for (const anuncio of lote) {
        const body = corpos.get(anuncio.ml_item_id);
        if (!body) continue;
        const variationId = anuncio.variation_id ? String(anuncio.variation_id) : null;

        let sku: string | null = null;
        let preco: number | null = null;
        if (variationId) {
          // Row de VARIAÇÃO: só a variação de mesmo id. Sem match → nada de SKU/preço.
          const variacao = ((body.variations ?? []) as any[]).find((v) => String(v.id) === variationId);
          sku = variacao?.seller_custom_field || null;
          preco = typeof variacao?.price === "number" ? variacao.price : null;
          // Fallback: a mesma variação na resposta completa
          if (!sku && mlUserId) sku = skuDaVariacao(await buscarCompleto(body.id), variationId);
        } else {
          // Row SEM variação: só o nível do item.
          sku = body.seller_custom_field || null;
          preco = body.price ?? null;
          // Fallback: resposta completa e, para item sem variações, user_products pelo catalog_product_id
          if (!sku && mlUserId) {
            const fullData = await buscarCompleto(body.id);
            sku = fullData?.seller_custom_field || null;
            if (!sku && fullData?.catalog_product_id && !(fullData.variations?.length)) {
              sku = await buscarSkuUserProducts(fullData.catalog_product_id, mlUserId!, token);
            }
          }
        }
        const thumbnail = body.thumbnail ?? null;

        const updates: Record<string, any> = {};
        // SKU é campo do usuário: só preenche row ainda vazia (a leitura já só traz vazias).
        if (sku && !String(anuncio.sku ?? "").trim()) updates.sku = sku;
        if (preco)     updates.preco_anuncio = preco;
        if (thumbnail) updates.thumbnail     = thumbnail;

        if (Object.keys(updates).length === 0) continue;

        // CDS V2 Fase 0C.1: o provider ML só escreve em row ML — nunca numa row Shopee
        // do mesmo dono que por acaso tenha o mesmo ml_item_id.
        // CDS V2 Fase 2B0: UMA row — `id` (+ dono + ML + item) — nunca o item inteiro
        // (as variações irmãs). SKU preenchido por fora entre a leitura e aqui não é sobrescrito.
        const { data: gravadas, error: updateError } = await supabase()
          .from("anuncios")
          .update(updates)
          .eq("id", anuncio.id)
          .eq("user_id", userId)
          .eq("marketplace", "ML")
          .eq("ml_item_id", anuncio.ml_item_id)
          .or("sku.is.null,sku.eq.")
          .select("id");

        if (updateError) {
          console.error("[POST /api/ml/sync-skus] falha ao gravar anúncio:", updateError.message);
          erros.push(`Anúncio ${anuncio.ml_item_id}${variationId ? `/${variationId}` : ""}: falha ao gravar`);
        } else if ((gravadas ?? []).length > 0) {
          atualizados++;
        }
      }
    } catch (e) {
      erros.push(`Lote ${i / LOTE + 1}: ${e}`);
    }
  }

  return NextResponse.json({
    atualizados,
    total: candidatos.length,
    erros: erros.length ? erros : undefined,
    mensagem: `${atualizados} de ${candidatos.length} anúncio(s) atualizado(s).`,
  });
}
