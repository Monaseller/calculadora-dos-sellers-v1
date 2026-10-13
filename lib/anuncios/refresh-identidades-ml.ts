/**
 * Refresh de identidades conhecidas — MERCADO LIVRE (CDS V2 Fase 2H-D), por loja.
 * Contrato e regras: lib/anuncios/refresh-identidades.ts (I9 + I10).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { lerTodasAsPaginas } from "@/lib/anuncios/leitura-paginada";
import { gravarObservacoes, observacaoPositiva, type ObservacaoMarketplace } from "@/lib/anuncios/observacao-marketplace";
import { cmpItemML } from "@/lib/anuncios/importacao-ml";
import { resolverContaML } from "@/lib/ml-conexao";
import {
  agruparFonte, codificarCursorRefresh, ErroRefreshIdentidades, LOTE_REFRESH_ML, lerCursorRefresh, MAX_CHAMADAS_REFRESH, ORCAMENTO_REFRESH_MS,
  somarNaoObservado, UUID_REFRESH, type LinhaFonte, type ResultadoRefresh,
} from "@/lib/anuncios/refresh-identidades";

const API_ML = "https://api.mercadolibre.com";
// ── Mercado Livre ─────────────────────────────────────────────────────
async function getML(path: string, token: string, contexto: string): Promise<any> {
  let resp: Response;
  try { resp = await fetch(`${API_ML}${path}`, { headers: { Authorization: `Bearer ${token}` } }); }
  catch (e: any) { throw new ErroRefreshIdentidades("PROVIDER", `${contexto}: ${String(e?.message ?? e).slice(0, 120)}`); }
  if (!resp.ok) throw new ErroRefreshIdentidades(contexto === "users/me" ? "TOKEN" : "PROVIDER", `${contexto}: HTTP ${resp.status}`);
  try { return await resp.json(); } catch { throw new ErroRefreshIdentidades("PROVIDER", `${contexto}: resposta ilegivel`); }
}

/** Rows observadas de um item ML positivo: só as variações que VOLTARAM (ou a row sem variação). */
function linhasObservadasML(rows: LinhaFonte[], body: any): LinhaFonte[] {
  const variacoes: any[] = Array.isArray(body?.variations) ? body.variations : [];
  if (variacoes.length === 0) return rows.filter((r) => r.variation_id === null || r.variation_id === undefined);
  const voltaram = new Set(variacoes.map((v) => String(v?.id)));
  return rows.filter((r) => r.variation_id !== null && r.variation_id !== undefined && voltaram.has(String(r.variation_id)));
}

export async function refrescarIdentidadesML(args: {
  banco: SupabaseClient; userId: string; lojaId: string; cursor?: unknown;
  inicioMs: number; orcamentoMs?: number; agora?: () => number; observadoEm?: () => Date;
}): Promise<ResultadoRefresh> {
  const { banco, userId, lojaId } = args;
  if (!userId || typeof lojaId !== "string" || !UUID_REFRESH.test(lojaId)) throw new ErroRefreshIdentidades("LOJA", "loja ML explicita obrigatoria", "LOJA_INVALIDA");
  const orcamento = args.orcamentoMs ?? ORCAMENTO_REFRESH_MS;
  const agora = args.agora ?? (() => Date.now());
  const observadoEm = args.observadoEm ?? (() => new Date());
  const estourou = () => agora() - args.inicioMs >= orcamento;

  // 1. Cursor preso a ML + loja + refresh — ANTES de qualquer provider.
  const cursorLido = lerCursorRefresh(args.cursor, "ML", lojaId);
  if (!cursorLido.ok) throw new ErroRefreshIdentidades("CURSOR", "cursor recusado", cursorLido.motivo);

  // 2. Credencial DESTA loja (dono + ML + ativa), sem loja única implícita.
  const conta = await resolverContaML(userId, lojaId);
  if (!conta.ok) throw new ErroRefreshIdentidades("LOJA", "loja ML nao resolvida", conta.motivo);
  if (conta.lojaId !== lojaId) throw new ErroRefreshIdentidades("LOJA", "credencial de outra loja", "LOJA_DIVERGENTE");
  const token = conta.accessToken;

  // 3. Fonte (antes do provider: ids inválidos nunca saem daqui).
  const leitura = await lerTodasAsPaginas<LinhaFonte>(() => banco
    .from("anuncios")
    .select("id, ml_item_id, variation_id, loja_id")
    .eq("marketplace", "ML")
    .eq("user_id", userId)
    .eq("loja_id", lojaId)
    .not("ml_item_id", "is", null));
  if (!leitura.ok) throw new ErroRefreshIdentidades("BANCO", "leitura das identidades conhecidas falhou");
  const fonte = agruparFonte(leitura.linhas, lojaId, "ML");
  const ultimo = cursorLido.ultimoItem;
  const restantes = ultimo === null ? fonte.validos : fonte.validos.filter((id) => cmpItemML(id, ultimo) > 0);
  const r: ResultadoRefresh = { marketplace: "ML", lojaId, parcial: false, cursor: null, conhecidos: fonte.validos.length, consultados: 0,
    observados: 0, naoObservados: 0, linhasObservadas: 0, idsInvalidos: ultimo === null ? fonte.invalidos : 0, naoObservadosPorMotivo: {}, chamadasProvider: 0 };
  let cursorItem: string | null = ultimo;

  try {
    if (restantes.length > 0) {
      // 4. O token é da conta desta loja?
      r.chamadasProvider++;
      const me = await getML("/users/me", token, "users/me");
      const sellerToken = me?.id === undefined || me?.id === null ? "" : String(me.id);
      if (!sellerToken) throw new ErroRefreshIdentidades("TOKEN", "users/me sem id");
      if (conta.sellerId && String(conta.sellerId) !== sellerToken) throw new ErroRefreshIdentidades("LOJA", "token de outra conta ML", "CONTA_DIVERGENTE");
    }
    for (let ini = 0; ini < restantes.length; ini += LOTE_REFRESH_ML) {
      if (r.chamadasProvider + 1 > MAX_CHAMADAS_REFRESH || (ini > 0 && estourou())) break;   // lote só começa se puder terminar
      const lote = restantes.slice(ini, ini + LOTE_REFRESH_ML);
      r.chamadasProvider++;
      const raw: any[] = await getML(`/items?ids=${lote.join(",")}&include_attributes=all`, token, "items multiget");
      const instante = observadoEm();
      // positivo = code 200 E body.id IGUAL ao pedido; o resto só vira diagnóstico (nunca status)
      const positivos = new Map<string, any>(), outros = new Map<string, number>();
      for (const x of Array.isArray(raw) ? raw : []) {
        const id = typeof x?.body?.id === "string" ? x.body.id : null;
        if (id === null || !lote.includes(id)) continue;                         // sem id ou id não pedido: não prova nada
        if (x.code === 200) positivos.set(id, x.body); else outros.set(id, Number(x.code));
      }
      const pares: { id: string; obs: ObservacaoMarketplace }[] = [];
      for (const itemId of lote) {
        r.consultados++;
        const body = positivos.get(itemId);
        if (!body) { somarNaoObservado(r, outros.has(itemId) ? `code_${outros.get(itemId)}` : "sem_resposta_positiva"); continue; }
        const linhas = linhasObservadasML(fonte.porItem.get(itemId) ?? [], body);
        if (linhas.length === 0) { somarNaoObservado(r, "variacao_nao_retornada"); continue; }
        const obs = observacaoPositiva(instante, body.status);
        for (const l of linhas) pares.push({ id: l.id, obs });
        r.observados++;
        r.linhasObservadas += linhas.length;
      }
      if (pares.length > 0 && !(await gravarObservacoes(banco, { userId, lojaId, marketplace: "ML" }, pares))) {
        throw new ErroRefreshIdentidades("BANCO", "observacao do refresh recusada pelo banco");
      }
      cursorItem = lote[lote.length - 1];
    }
  } catch (e) {
    const erro = e instanceof ErroRefreshIdentidades ? e : new ErroRefreshIdentidades("PROVIDER", String((e as any)?.message ?? e));
    erro.ultimoConcluido = cursorItem;
    throw erro;
  }

  const fim = restantes.length === 0 || (cursorItem !== null && cmpItemML(cursorItem, restantes[restantes.length - 1]) >= 0);
  r.parcial = !fim;
  r.cursor = fim ? null : codificarCursorRefresh("ML", lojaId, cursorItem!);
  return r;
}
