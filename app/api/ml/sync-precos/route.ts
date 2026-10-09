import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import { calcularFreteMl, calcularFreteFullMl, calcularFreteFlexMl } from "@/lib/tabela-frete-ml";
import { autenticarRequisicao, lerCookie } from "@/lib/autenticacao";
import { contarLojasMLAtivasDoDono, MULTI_ML_CATALOG_NOT_READY, resolverContaML } from "@/lib/ml-conexao";
import { getActivePromoPrice } from "@/lib/ml-promotions";
import { lerTodasAsPaginas } from "@/lib/anuncios/leitura-paginada";

// SEC-3-B1: dados sensiveis (SEC-3) so por service_role, server-side.
// O cliente nasce sob demanda — nunca no import — a partir do helper
// oficial; o isolamento por dono e da propria rota, nao do banco.
let clienteServidor: SupabaseClient | null = null;
function supabase(): SupabaseClient {
  return (clienteServidor ??= getSupabaseServidor());
}

function mapTipoAnuncio(listingTypeId: string): string {
  if (listingTypeId === "gold_premium" || listingTypeId === "gold_pro") return "Premium";
  return "Clássico";
}

// Extrai peso (kg) de shipping.dimensions — formato ML: "LxWxH,gramas"
// ML retorna peso em gramas (inteiro). Alguns items retornam decimal.
// Heurística: se valor >= 200 → definitivamente gramas → ÷1000
//             se valor >= 20  → provavelmente gramas → ÷1000
//             se valor < 20   → provavelmente já em kg (ex: "1.5", "12.5")
function parsePesoSync(dim: string | null | undefined): number | null {
  if (!dim) return null;
  const m = dim.match(/^([\d.]+)[xX]([\d.]+)[xX]([\d.]+),\s*([\d.]+)/);
  if (!m) return null;
  const w = parseFloat(m[4]);
  if (!w || w <= 0) return null;
  // Valores >= 20 são certamente gramas (20 kg é muito raro em e-commerce)
  const pesoKg = w >= 20 ? w / 1000 : w;
  // Sanidade: produto deve pesar entre 1g e 150kg
  return (pesoKg >= 0.001 && pesoKg <= 150) ? pesoKg : null;
}

// Extrai peso (kg) de atributos ML (fallback ao dimensions)
function parsePesoAtributos(attributes: any[]): number | null {
  if (!Array.isArray(attributes)) return null;
  const attr = attributes.find(
    (a: any) => ["WEIGHT","SHIPPING_WEIGHT","ITEM_WEIGHT","NET_WEIGHT"].includes((a.id ?? "").toUpperCase())
  );
  if (!attr?.value_name) return null;
  const str = String(attr.value_name).toLowerCase().trim();
  const gMatch = str.match(/^([\d.,]+)\s*g$/);
  if (gMatch) return parseFloat(gMatch[1].replace(",", ".")) / 1000;
  const kgMatch = str.match(/^([\d.,]+)\s*kg$/);
  if (kgMatch) return parseFloat(kgMatch[1].replace(",", "."));
  return null;
}

// Calcula custo_frete correto pelo tipo de envio + peso + preço
function calcularNovoFrete(
  logisticType: string | null,
  peso: number | null,
  preco: number | null
): number | null {
  if (!preco || preco <= 0) return null;
  const lt = (logisticType ?? "").toLowerCase();
  if (lt === "fulfillment")  return calcularFreteFullMl("P", preco, peso);
  if (lt === "self_service") return calcularFreteFlexMl(preco);
  if (!peso || peso <= 0)    return null;
  return calcularFreteMl(peso, preco);
}

// Busca o body completo de um item MLB (sempre individual — garante shipping.dimensions)
async function fetchItemBody(mlbId: string, token: string): Promise<any | null> {
  const r = await fetch(`https://api.mercadolibre.com/items/${mlbId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) {
    console.log(`[sync] /items/${mlbId} → ${r.status}`);
    return null;
  }
  return r.json();
}

// Resolve MLBU → MLB real via /products/buy_box_winner
async function resolverMLBU(mlbuId: string, token: string): Promise<{ mlbId: string; body: any } | null> {
  for (const pid of [mlbuId, "MLB" + mlbuId.slice(4)]) {
    try {
      const r = await fetch(`https://api.mercadolibre.com/products/${pid}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) continue;
      const prod = await r.json();
      const mlbId: string | null = prod.buy_box_winner?.item_id ?? null;
      if (!mlbId) continue;
      const body = await fetchItemBody(mlbId, token);
      if (body) return { mlbId, body };
    } catch {}
  }
  return null;
}

export async function POST(request: Request) {
  // A sessão vem PRIMEIRO: o token do ML só é resolvido para uma loja que
  // pertence a este usuário (F0.c.4).
  const auth        = await autenticarRequisicao(request);
  const userId      = auth.autenticado ? auth.uid : null;
  if (!userId) {
    return NextResponse.json({ erro: true, mensagem: "Sessão inválida." }, { status: 401 });
  }
  // ── CREDENCIAL RESOLVIDA NO SERVIDOR (F0.c.5) ─────────────────────
  // Mesma troca de `importar-anuncios`: a loja e a credencial passam a
  // sair do mesmo resolvedor que responde à tela, em vez do cookie.
  // CDS V2 Fase 1B: `anuncios` ML ainda nao tem loja_id (Fase 2). Com 2+ contas ML do dono o
  // catalogo falha fechado ANTES de provider/escrita — mesmo com loja_ativa_id apontando uma delas.
  if (await contarLojasMLAtivasDoDono(userId) > 1) {
    return NextResponse.json({ erro: true, codigo: MULTI_ML_CATALOG_NOT_READY,
      mensagem: "Catálogo com mais de uma conta do Mercado Livre ainda não é suportado." }, { status: 409 });
  }
  const conta = await resolverContaML(userId, lerCookie(request, "loja_ativa_id"), { permitirUnica: true });
  if (!conta.ok) {
    // Status 200 preservado: a tela lê `data.erro`/`data.mensagem`. A
    // dívida do "200 para erro" é registrada, não corrigida aqui.
    return NextResponse.json({
      erro: true,
      mensagem: conta.motivo === "LOJA_NAO_DEFINIDA"
        ? "Selecione a loja do Mercado Livre."
        : "Mercado Livre não conectado.",
    });
  }
  const token = conta.accessToken;

  // CDS V2 Fase 0: TODAS as páginas (o PostgREST corta em 1000 sem erro).
  const leitura = await lerTodasAsPaginas<any>(() => supabase()
    .from("anuncios")
    .select("id, ml_item_id, nome, preco_anuncio, frete_gratis, tipo_anuncio, thumbnail, permalink, variation_id, custo_frete, peso_kg, custo_produto, imposto, categoria, sku")
    .eq("ativo", true)
    .eq("marketplace", "ML")
    .eq("user_id", userId)
    .not("ml_item_id", "is", null));

  if (!leitura.ok) {
    // A mensagem crua do Supabase pode conter nome de tabela, coluna e
    // esquema — fica no log, nunca na resposta. E falha de banco e 5xx,
    // não 200 com `erro:true` (o corpo é preservado porque a tela lê
    // `data.erro` e `data.mensagem`).
    console.error("[POST /api/ml/sync-precos] falha ao ler anúncios:", leitura.motivo);
    return NextResponse.json(
      { erro: true, mensagem: "Não foi possível carregar os anúncios agora." },
      { status: 503 }
    );
  }
  const anuncios = leitura.linhas;
  if (!anuncios.length) return NextResponse.json({ erro: false, atualizados: 0, mensagem: "Nenhum anúncio ML encontrado." });

  let atualizados = 0;
  let falhaGravacao = false;
  const detalhes: string[] = [];

  for (const anuncio of anuncios) {
    // Detalhes só entram na resposta depois que o UPDATE da row foi aceito pelo banco.
    const pendentes: string[] = [];
    try {
      let resolvedId: string = anuncio.ml_item_id!;
      let body: any = null;

      // Se já é MLB direto, busca individual (body completo com dimensions)
      if (!resolvedId.toUpperCase().startsWith("MLBU")) {
        body = await fetchItemBody(resolvedId, token);
      } else {
        // MLBU: resolve para o MLB real deste seller
        const resultado = await resolverMLBU(resolvedId, token);
        if (resultado) {
          resolvedId = resultado.mlbId;
          body = resultado.body;
        }
      }

      if (!body) continue;

      const mudancas: Record<string, any> = {};

      // ── ml_item_id: atualiza se MLBU foi resolvido ──────────────────────────
      if (resolvedId !== anuncio.ml_item_id) mudancas.ml_item_id = resolvedId;

      // ── Preço + SKU: usa o da variação se houver ────────────────────────────
      // Prioridade: promoção ativa (seller-promotions) > sale_price > price
      const promoPrice = await getActivePromoPrice(resolvedId, token);
      let novoPreco: number | null = promoPrice ?? body.sale_price?.amount ?? body.price ?? null;
      if (typeof novoPreco !== "number") novoPreco = null;
      let novoSku: string | null = body.seller_custom_field ?? null;
      if (anuncio.variation_id && body.variations?.length) {
        const varId = String(anuncio.variation_id);
        const variation = (body.variations as any[]).find((v: any) => String(v.id) === varId);
        if (variation) {
          // Para variações, o preço de promoção é no nível do item (mesmo promoPrice)
          const varPreco = promoPrice ?? variation.sale_price?.amount ?? variation.price;
          if (typeof varPreco === "number") novoPreco = varPreco;
          if (variation.seller_custom_field) novoSku = variation.seller_custom_field;
        }
      }
      // Só atualiza SKU se ainda não tiver um (não sobrescreve o que o usuário digitou)
      if (novoSku && !(anuncio as any).sku) mudancas.sku = novoSku;
      if (novoPreco !== null && novoPreco !== anuncio.preco_anuncio) {
        mudancas.preco_anuncio = novoPreco;
        const nomeExib = (anuncio.nome ?? "").substring(0, 35);
        pendentes.push(`💰 ${nomeExib}: R$ ${(anuncio.preco_anuncio ?? 0).toFixed(2).replace(".", ",")} → R$ ${novoPreco.toFixed(2).replace(".", ",")}`);
      }

      // ── Logistic type + Peso ────────────────────────────────────────────────
      const logisticType = (body.shipping?.logistic_type as string | null) ?? null;

      // ── Metadados ───────────────────────────────────────────────────────────
      const novoNome      = typeof body.title === "string" ? body.title : null;
      const novoFrete     = body.shipping?.free_shipping ?? false;
      const novoTipo      = body.listing_type_id ? mapTipoAnuncio(body.listing_type_id) : null;
      const novoThumb     = body.thumbnail ?? null;
      const novoPermalink = body.permalink ?? null;

      if (novoNome      && novoNome      !== anuncio.nome)                   mudancas.nome          = novoNome;
      if (logisticType  && logisticType  !== (anuncio as any).logistic_type) mudancas.logistic_type = logisticType;
      if (novoFrete     !== anuncio.frete_gratis)                            mudancas.frete_gratis  = novoFrete;
      if (novoTipo      && novoTipo      !== anuncio.tipo_anuncio)           mudancas.tipo_anuncio  = novoTipo;
      if (novoThumb     && novoThumb     !== anuncio.thumbnail)              mudancas.thumbnail     = novoThumb;
      if (novoPermalink && novoPermalink !== anuncio.permalink)              mudancas.permalink     = novoPermalink;
      const pesoDim      = parsePesoSync(body.shipping?.dimensions as string | null);
      const pesoAttr     = parsePesoAtributos(body.attributes ?? []);
      const pesoAPI      = pesoDim ?? pesoAttr;
      const pesoFinal    = pesoAPI ?? (typeof anuncio.peso_kg === "number" ? anuncio.peso_kg : null);

      if (pesoAPI !== null && pesoAPI !== anuncio.peso_kg) {
        mudancas.peso_kg = pesoAPI;
        console.log(`[sync] ${resolvedId} peso: ${anuncio.peso_kg} → ${pesoAPI} kg (dim=${body.shipping?.dimensions})`);
      }

      // ── Frete: recalcula se preço mudou OU frete está zerado ────────────────
      const isFlex = (logisticType ?? "").toLowerCase() === "self_service";
      const precoMudou = "preco_anuncio" in mudancas;
      const freteZerado = !anuncio.custo_frete || anuncio.custo_frete === 0;
      // Para peso: usa o da API se disponível, senão o salvo no Supabase
      const pesoSalvo = typeof anuncio.peso_kg === "number" && anuncio.peso_kg > 0 ? anuncio.peso_kg : null;
      const pesoParaFrete = pesoFinal; // inclui peso da API + fallback Supabase
      const deveRecalcularFrete = (precoMudou || freteZerado) && (isFlex || pesoParaFrete !== null);

      if (deveRecalcularFrete) {
        const precoParaCalc = (mudancas.preco_anuncio as number | undefined) ?? anuncio.preco_anuncio ?? null;
        const novoCustoFrete = calcularNovoFrete(logisticType, pesoParaFrete, precoParaCalc);

        if (novoCustoFrete !== null) {
          const diff = Math.abs(novoCustoFrete - (anuncio.custo_frete ?? 0));
          if (diff > 0.005) {
            mudancas.custo_frete = novoCustoFrete;
            const nomeExib = (anuncio.nome ?? "").substring(0, 30);
            pendentes.push(`🚚 ${nomeExib}: frete R$ ${(anuncio.custo_frete ?? 0).toFixed(2).replace(".", ",")} → R$ ${novoCustoFrete.toFixed(2).replace(".", ",")}`);
          }
        }
      }

      // CDS V2 Fase 2B0: lucro/margem NÃO são colunas de `anuncios` (DERIVED_UI_FIELDS) —
      // a tela deriva dos campos gravados aqui. Antes iam no UPDATE, que então falhava
      // inteiro (preço/frete incluídos) e mesmo assim contava como atualizado.
      if (Object.keys(mudancas).length > 0) {
        const { error: erroGravacao } = await supabase()
          .from("anuncios")
          .update(mudancas)
          .eq("id", anuncio.id)
          .eq("user_id", userId)
          .eq("marketplace", "ML");
        if (erroGravacao) {
          // Fail-closed: para aqui. O que já foi gravado fica; nada mais é tentado.
          console.error("[POST /api/ml/sync-precos] falha ao gravar anúncio:", erroGravacao.message);
          falhaGravacao = true;
          break;
        }
        atualizados++;
        detalhes.push(...pendentes);
      }

      // Pequena pausa para não bater no rate limit da API ML
      await new Promise(r => setTimeout(r, 80));

    } catch (e) {
      console.log(`[sync] erro em ${anuncio.ml_item_id}: ${e}`);
    }
  }

  if (falhaGravacao) {
    // Mesmo contrato da falha de leitura: 5xx, `erro`/`mensagem` para a tela, sem mensagem crua do banco.
    return NextResponse.json({
      erro: true, atualizados, detalhes,
      mensagem: "Não foi possível salvar os anúncios agora. O que já foi atualizado foi mantido; tente novamente.",
    }, { status: 503 });
  }

  const mensagem = atualizados === 0
    ? `Todos os ${anuncios.length} anúncios já estão atualizados!`
    : `${atualizados} anúncio${atualizados !== 1 ? "s" : ""} atualizado${atualizados !== 1 ? "s" : ""}!`;

  const res = NextResponse.json({ erro: false, atualizados, mensagem, detalhes });
  // CDS V2 Fase 1B: nenhum cookie de credencial ML e emitido (o token nunca vai ao navegador).
  return res;
}
