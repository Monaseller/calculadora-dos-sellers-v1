/**
 * Refresh de identidades conhecidas — SHOPEE (CDS V2 Fase 2H-D), por loja. SÓ visto_em (status não provado).
 * Contrato e regras: lib/anuncios/refresh-identidades.ts (I9 + I10).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { lerTodasAsPaginas } from "@/lib/anuncios/leitura-paginada";
import { gravarObservacoes, observacaoPositiva, type ObservacaoMarketplace } from "@/lib/anuncios/observacao-marketplace";
import { shopeeGet } from "@/lib/shopee-api";
import {
  agruparFonte, cmpShopee, codificarCursorRefresh, CONCORRENCIA_MODELOS_REFRESH, ErroRefreshIdentidades, LOTE_REFRESH_SHOPEE, lerCursorRefresh,
  MAX_CHAMADAS_REFRESH, ORCAMENTO_REFRESH_MS, somarNaoObservado, UUID_REFRESH, type LinhaFonte, type ResultadoRefresh,
} from "@/lib/anuncios/refresh-identidades";

// ── Shopee ────────────────────────────────────────────────────────────
export interface CredencialShopeeRefresh { partnerId: string; partnerKey: string; accessToken: string; shopId: number | string }
async function chamarShopee(cred: CredencialShopeeRefresh, path: string, params: Record<string, string | number>, contexto: string): Promise<any> {
  let data: any;
  try { data = await shopeeGet(path, cred.partnerId, cred.partnerKey, cred.accessToken, cred.shopId, params); }
  catch (e: any) { throw new ErroRefreshIdentidades("PROVIDER", `${contexto}: ${String(e?.message ?? e).slice(0, 160)}`); }
  if (data?.error) throw new ErroRefreshIdentidades("PROVIDER", `${contexto}: ${String(data.error)} ${String(data.message ?? "").slice(0, 120)}`.trim());
  return data;
}

export async function refrescarIdentidadesShopee(args: {
  banco: SupabaseClient; userId: string; lojaId: string; cred: CredencialShopeeRefresh; cursor?: unknown;
  inicioMs: number; orcamentoMs?: number; agora?: () => number; observadoEm?: () => Date;
}): Promise<ResultadoRefresh> {
  const { banco, userId, lojaId, cred } = args;
  if (!userId || typeof lojaId !== "string" || !UUID_REFRESH.test(lojaId)) throw new ErroRefreshIdentidades("LOJA", "loja Shopee explicita obrigatoria", "LOJA_INVALIDA");
  const orcamento = args.orcamentoMs ?? ORCAMENTO_REFRESH_MS;
  const agora = args.agora ?? (() => Date.now());
  const observadoEm = args.observadoEm ?? (() => new Date());
  const estourou = () => agora() - args.inicioMs >= orcamento;

  const cursorLido = lerCursorRefresh(args.cursor, "Shopee", lojaId);
  if (!cursorLido.ok) throw new ErroRefreshIdentidades("CURSOR", "cursor recusado", cursorLido.motivo);

  const leitura = await lerTodasAsPaginas<LinhaFonte>(() => banco
    .from("anuncios")
    .select("id, ml_item_id, variation_id, loja_id")
    .eq("marketplace", "Shopee")
    .eq("user_id", userId)
    .eq("loja_id", lojaId)
    .not("ml_item_id", "is", null));
  if (!leitura.ok) throw new ErroRefreshIdentidades("BANCO", "leitura das identidades conhecidas falhou");
  const fonte = agruparFonte(leitura.linhas, lojaId, "Shopee");
  const ultimo = cursorLido.ultimoItem;
  const restantes = ultimo === null ? fonte.validos : fonte.validos.filter((id) => cmpShopee(id, ultimo) > 0);
  const r: ResultadoRefresh = { marketplace: "Shopee", lojaId, parcial: false, cursor: null, conhecidos: fonte.validos.length, consultados: 0,
    observados: 0, naoObservados: 0, linhasObservadas: 0, idsInvalidos: ultimo === null ? fonte.invalidos : 0, naoObservadosPorMotivo: {}, chamadasProvider: 0 };
  let cursorItem: string | null = ultimo;
  const podeChamar = () => r.chamadasProvider < MAX_CHAMADAS_REFRESH && !estourou();

  try {
    for (let ini = 0; ini < restantes.length; ini += LOTE_REFRESH_SHOPEE) {
      if (r.chamadasProvider + 1 > MAX_CHAMADAS_REFRESH || (ini > 0 && estourou())) break;
      const lote = restantes.slice(ini, ini + LOTE_REFRESH_SHOPEE);
      r.chamadasProvider++;
      const base = await chamarShopee(cred, "/api/v2/product/get_item_base_info",
        { item_id_list: lote.join(","), need_tax_info: "false", need_complaint_policy: "false" }, "get_item_base_info");
      // SÓ visto_em: status Shopee não provado → nunca passado ao helper
      const obs = observacaoPositiva(observadoEm());
      const porId = new Map<string, any>();
      for (const it of (base?.response?.item_list ?? []) as any[]) if (it?.item_id != null && lote.includes(String(it.item_id))) porId.set(String(it.item_id), it);

      // por item, em ordem; get_model_list com no máximo 3 em voo; item só começa se houver orçamento
      const linhas: (LinhaFonte[] | null | undefined)[] = new Array(lote.length);   // null = não observado
      let proximo = 0, falha: unknown = null;
      const trabalhador = async () => {
        for (;;) {
          if (falha !== null || proximo >= lote.length) return;
          const i = proximo;
          const item = porId.get(lote[i]);
          const rows = fonte.porItem.get(lote[i]) ?? [];
          const temModelos = item ? ((item.has_model ?? false) || (item.model_list?.length ?? 0) > 0) : false;
          if (temModelos && !podeChamar()) return;                                   // não inicia item que não pode terminar
          proximo++;
          if (!item) { linhas[i] = null; continue; }
          if (!temModelos) { linhas[i] = rows.filter((x) => x.variation_id === null || x.variation_id === undefined); continue; }
          try {
            r.chamadasProvider++;
            const md = await chamarShopee(cred, "/api/v2/product/get_model_list", { item_id: lote[i] }, `get_model_list item ${lote[i]}`);
            const voltaram = new Set(((md?.response?.model ?? []) as any[]).map((mm) => String(mm?.model_id)));
            linhas[i] = rows.filter((x) => x.variation_id !== null && x.variation_id !== undefined && voltaram.has(String(x.variation_id)));
          } catch (e) { if (falha === null) falha = e; return; }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCORRENCIA_MODELOS_REFRESH, lote.length) }, trabalhador));

      // prefixo contíguo concluído: só ele é gravado e só ele move o cursor
      let k = 0;
      while (k < lote.length && linhas[k] !== undefined) k++;
      const pares: { id: string; obs: ObservacaoMarketplace }[] = [];
      for (let i = 0; i < k; i++) {
        r.consultados++;
        const ls = linhas[i];
        if (ls === null) { somarNaoObservado(r, "ausente_da_resposta"); continue; }
        if (!ls || ls.length === 0) { somarNaoObservado(r, "model_nao_retornado"); continue; }
        for (const l of ls) pares.push({ id: l.id, obs });
        r.observados++;
        r.linhasObservadas += ls.length;
      }
      if (pares.length > 0 && !(await gravarObservacoes(banco, { userId, lojaId, marketplace: "Shopee" }, pares))) {
        throw new ErroRefreshIdentidades("BANCO", "observacao do refresh recusada pelo banco");
      }
      if (k > 0) cursorItem = lote[k - 1];
      if (falha !== null) throw falha instanceof ErroRefreshIdentidades ? falha : new ErroRefreshIdentidades("PROVIDER", String((falha as any)?.message ?? falha));
      if (k < lote.length) break;                                                    // orçamento acabou no meio do lote
    }
  } catch (e) {
    const erro = e instanceof ErroRefreshIdentidades ? e : new ErroRefreshIdentidades("PROVIDER", String((e as any)?.message ?? e));
    erro.ultimoConcluido = cursorItem;
    throw erro;
  }

  const fim = restantes.length === 0 || (cursorItem !== null && cmpShopee(cursorItem, restantes[restantes.length - 1]) >= 0);
  r.parcial = !fim;
  r.cursor = fim ? null : codificarCursorRefresh("Shopee", lojaId, cursorItem!);
  return r;
}
