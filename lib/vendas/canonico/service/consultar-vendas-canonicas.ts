/**
 * Consulta canonica de vendas (SALES-CANONICAL-D13) — o UNICO ponto de
 * entrada futuro de Dashboard e Vendas. Ainda nao ligado a nenhuma tela.
 *
 * Nao tem formula: valores vem SO dos leitores oficiais
 * (lerVendasML / lerVendasShopee); frescor vem SO do avaliador do
 * coordenador (avaliarNecessidadeDeSync + POLITICA_SYNC_PROPOSTA); escopo
 * e elegibilidade vem SO da capability de lojas. Este modulo apenas
 * escolhe o escopo, chama e compoe.
 *
 *   Owner-scoped SEMPRE: loja de outro dono → LOJA_FORA_DO_OWNER. Nenhuma
 *   deduplicacao por seller_id/shop_id/nickname; nada soma entre donos.
 *   Marketplace nao selecionado nunca e lido. Em "todos", ML e Shopee
 *   recebem o MESMO periodo resolvido.
 *   READ-ONLY: sem sync na leitura, sem marketplace, sem renovar token,
 *   sem criar job.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import { listarLojasDoDonoParaVendasCanonicas, type LinhaLojaParaVendasCanonicas } from "@/lib/marketplace/credenciais";
import { avaliarNecessidadeDeSync } from "@/lib/vendas/sync/coordenador";
import { POLITICA_SYNC_PROPOSTA } from "@/lib/vendas/sync/planejamento";
import type { AvaliacaoLojaSync, MarketplaceSync } from "@/lib/vendas/sync/tipos";
import { lerVendasML, somarMetricasML, type ResultadoVendasML } from "../ml";
import { lerVendasShopee } from "../shopee";
import type { ResultadoVendas } from "../tipos";
import { ErroPeriodoVendas, resolverPeriodoVendas, type PeriodoVendasResolvido } from "../periodo";
import {
  ErroVendasCanonicas, type ConsultaVendasCanonicas, type DependenciasConsultaVendas, type EstadoCobertura, type EstadoConsulta,
  type EstadoFrescor, type LojaVendasCanonicas, type MarketplaceConsulta, type MarketplaceLoja, type MetricasCombinadas,
  type ResultadoVendasCanonicas,
} from "./tipos";

const MARKETPLACES_CONSULTA: readonly MarketplaceConsulta[] = ["mercado_livre", "shopee", "todos"];
const PARA_SYNC: Record<MarketplaceLoja, MarketplaceSync> = { mercado_livre: "ML", shopee: "Shopee" };
const DE_SYNC: Record<MarketplaceSync, MarketplaceLoja> = { ML: "mercado_livre", Shopee: "shopee" };

/** Metricas que existem de um lado so — documentadas, nunca somadas. */
export const INCOMPATIBILIDADES_ENTRE_MARKETPLACES: readonly string[] = [
  "cancelados: so a Shopee mede (o leitor ML nao produz contagem de cancelados) — nao somado",
  "vendasSemDescontosPlataforma: so Shopee — nao somado",
  "componentes (itens, vouchers, moedas, subsidio, Pix): so Shopee — nao somados",
];

/** Erros conhecidos dos leitores/avaliador → codigo tipado. Mensagem crua nunca sai (pode citar pedido). */
function traduzirErro(e: unknown, origem: string): ErroVendasCanonicas {
  if (e instanceof ErroVendasCanonicas) return e;
  const m = e instanceof Error ? e.message : "";
  if (m === "loja_invalida") return new ErroVendasCanonicas("LOJA_FORA_DO_OWNER", origem);
  if (m === "periodo_invalido") return new ErroVendasCanonicas("PERIODO_INVALIDO", origem);
  if (m === "user_id_ausente") return new ErroVendasCanonicas("OWNER_AUSENTE", origem);
  return new ErroVendasCanonicas("LEITURA_FALHOU", `${origem}:${m === "leitura_falhou" ? "leitura_falhou" : "erro_interno"}`);
}

async function protegido<T>(origem: string, f: () => Promise<T>): Promise<T> {
  try { return await f(); } catch (e) { throw traduzirErro(e, origem); }
}

export async function consultarVendasCanonicas(
  args: ConsultaVendasCanonicas,
  deps: DependenciasConsultaVendas = {},
): Promise<ResultadoVendasCanonicas> {
  const agoraMs = deps.agoraMs ?? Date.now();
  const cliente: SupabaseClient = deps.cliente ?? getSupabaseServidor();

  // ── 1. entrada ──
  const userId = args?.userId;
  if (typeof userId !== "string" || userId === "") throw new ErroVendasCanonicas("OWNER_AUSENTE");
  const marketplace = args.marketplace;
  if (!MARKETPLACES_CONSULTA.includes(marketplace)) throw new ErroVendasCanonicas("MARKETPLACE_INVALIDO", "marketplace_desconhecido");
  const lojaId = args.lojaId ?? null;
  if (lojaId !== null && (typeof lojaId !== "string" || lojaId === "")) throw new ErroVendasCanonicas("LOJA_FORA_DO_OWNER", "loja_id_invalido");

  let periodo: PeriodoVendasResolvido;
  try {
    periodo = resolverPeriodoVendas({ preset: args.preset, de: args.de, ate: args.ate }, agoraMs);
  } catch (e) {
    if (e instanceof ErroPeriodoVendas) throw new ErroVendasCanonicas("PERIODO_INVALIDO", e.detalhe);
    throw e;
  }

  // ── 2. escopo: lojas DO DONO, pela capability ──
  const { linhas, erro } = await listarLojasDoDonoParaVendasCanonicas(userId, cliente, agoraMs);
  if (erro) throw new ErroVendasCanonicas("LEITURA_FALHOU", "lojas");
  const selecionados: MarketplaceLoja[] = marketplace === "todos" ? ["mercado_livre", "shopee"] : [marketplace];
  let escopo: LinhaLojaParaVendasCanonicas[];
  if (lojaId !== null) {
    const loja = linhas.find((l) => l.id === lojaId);
    if (!loja) throw new ErroVendasCanonicas("LOJA_FORA_DO_OWNER");
    if (!selecionados.includes(DE_SYNC[loja.marketplace])) throw new ErroVendasCanonicas("MARKETPLACE_INVALIDO", "loja_de_outro_marketplace");
    escopo = [loja];
  } else {
    escopo = linhas.filter((l) => selecionados.includes(DE_SYNC[l.marketplace]));
  }
  if (!escopo.length) throw new ErroVendasCanonicas("PERIODO_SEM_COBERTURA", "nenhuma_loja_no_escopo");

  const consultados = selecionados.filter((m) => escopo.some((l) => DE_SYNC[l.marketplace] === m));
  const semLoja = lojaId === null ? selecionados.filter((m) => !consultados.includes(m)) : [];
  const idsDe = (m: MarketplaceLoja) => escopo.filter((l) => DE_SYNC[l.marketplace] === m).map((l) => l.id);

  // ── 3. valores: SO os leitores oficiais, SO dos marketplaces com loja no escopo, MESMO periodo ──
  const { de, ate } = periodo;
  const leituraML: ResultadoVendasML | null = consultados.includes("mercado_livre")
    ? await protegido("mercado_livre", () => lerVendasML(cliente, { userId, de, ate, lojaIds: idsDe("mercado_livre") }))
    : null;
  const leituraShopee: ResultadoVendas | null = consultados.includes("shopee")
    ? await protegido("shopee", () => lerVendasShopee(cliente, { userId, de, ate, lojaIds: idsDe("shopee") }))
    : null;

  // ── 4. frescor: SO o avaliador do coordenador (lojas ATIVAS; leitura pura) ──
  const avaliacoes = new Map<string, AvaliacaoLojaSync>();
  for (const m of consultados) {
    const ativas = escopo.filter((l) => DE_SYNC[l.marketplace] === m && l.ativo);
    if (!ativas.length) continue;
    const av = await protegido(`frescor_${m}`, () => avaliarNecessidadeDeSync(cliente,
      { userId, marketplace: PARA_SYNC[m], lojaId: lojaId ?? undefined, de, ate, origem: "usuario" },
      { agoraMs, politica: POLITICA_SYNC_PROPOSTA }));
    for (const a of av.lojas) avaliacoes.set(a.lojaId, a);
  }

  // ── 5. composicao por loja ──
  const lojas: LojaVendasCanonicas[] = escopo.map((l) => {
    const mkt = DE_SYNC[l.marketplace];
    const doLeitor = mkt === "mercado_livre"
      ? leituraML?.lojas.find((r) => r.lojaId === l.id) ?? null
      : leituraShopee?.lojas.find((r) => r.lojaId === l.id) ?? null;
    const motivos: string[] = [];
    if (!l.ativo) motivos.push("LOJA_INATIVA");
    if (l.elegibilidade.estado !== "ELEGIVEL") motivos.push(`CREDENCIAL_INUTILIZAVEL:${l.elegibilidade.motivo}`);
    if (!doLeitor) motivos.push("LOJA_SEM_RESULTADO_DO_LEITOR");
    else if (doLeitor.completude === "FAILED") motivos.push("LEITURA_FAILED");
    if (doLeitor) motivos.push(...doLeitor.motivos.map((m) => `leitor:${m}`));

    let cobertura: EstadoCobertura;
    const bloqueada = !l.ativo || l.elegibilidade.estado !== "ELEGIVEL" || !doLeitor || doLeitor.completude === "FAILED";
    if (bloqueada) cobertura = "INCOMPLETE";
    else if (periodo.parcial) { cobertura = "PARTIAL"; motivos.push("PERIODO_INCLUI_HOJE"); }
    else if (doLeitor!.completude === "COMPLETE") cobertura = "COMPLETE";
    else { cobertura = "INCOMPLETE"; motivos.push("COBERTURA_DO_PERIODO_FECHADO_INCOMPLETA"); }

    const av = avaliacoes.get(l.id);
    const frescor: EstadoFrescor = periodo.parcial ? "IN_PROGRESS" : av ? av.frescor : "DESCONHECIDO";
    const motivosFrescor = av ? av.motivos : [l.ativo ? "FRESCOR_NAO_AVALIADO" : "LOJA_INATIVA_SEM_AVALIACAO_DE_FRESCOR"];

    return {
      lojaId: l.id, marketplace: mkt, ativa: l.ativo, elegibilidade: l.elegibilidade.estado,
      completudeLeitor: doLeitor?.completude ?? null, cobertura, motivos,
      metricas: cobertura === "COMPLETE" ? doLeitor!.metricas : null,
      componentes: cobertura === "COMPLETE" && "componentes" in doLeitor! ? doLeitor!.componentes ?? null : null,
      frescor, motivosFrescor,
    };
  });

  // ── 6. agregado: COMPLETE so se TODAS as lojas forem ──
  const motivosCobertura: string[] = [];
  let cobertura: EstadoCobertura = lojas.some((l) => l.cobertura === "INCOMPLETE") ? "INCOMPLETE"
    : lojas.some((l) => l.cobertura === "PARTIAL") ? "PARTIAL" : "COMPLETE";
  for (const l of lojas) if (l.cobertura !== "COMPLETE") motivosCobertura.push(`${l.marketplace}:${l.lojaId}:${l.cobertura}`);

  const totalML = leituraML?.total ?? null;
  const totalShopee = leituraShopee?.total ?? null;
  if (cobertura === "COMPLETE" && ((leituraML && !totalML) || (leituraShopee && !totalShopee))) {
    cobertura = "INCOMPLETE"; motivosCobertura.push("TOTAL_DO_LEITOR_AUSENTE");
  }

  let combinadas: MetricasCombinadas | null = null;
  if (cobertura === "COMPLETE") {
    // soma de centavo do PROPRIO leitor oficial (somarMetricasML), sobre os campos compativeis
    const partes = [totalML, totalShopee].filter((m) => m !== null).map((m) => ({ pedidos: m!.pedidos, unidades: m!.unidades, vendas: m!.vendas }));
    combinadas = somarMetricasML(partes);
  }

  const frescor: EstadoFrescor = periodo.parcial ? "IN_PROGRESS"
    : lojas.some((l) => l.frescor === "DESCONHECIDO") ? "DESCONHECIDO"
      : lojas.some((l) => l.frescor === "STALE") ? "STALE" : "FRESH";
  const motivosFrescor = [...new Set(lojas.flatMap((l) => l.motivosFrescor.map((m) => `${l.marketplace}:${l.lojaId}:${m}`)))];

  const estado: EstadoConsulta = cobertura === "INCOMPLETE" ? "INCOMPLETE" : cobertura === "PARTIAL" ? "PARTIAL"
    : frescor === "FRESH" ? "COMPLETE_FRESH" : "COMPLETE_STALE";

  return {
    userId, marketplace, lojaId, periodo,
    metricas: {
      combinadas,
      mercadoLivre: cobertura === "COMPLETE" ? totalML : null,
      shopee: cobertura === "COMPLETE" ? totalShopee : null,
      semVendas: combinadas ? combinadas.pedidos === 0 : null,
      incompatibilidades: consultados.length > 1 ? [...INCOMPATIBILIDADES_ENTRE_MARKETPLACES] : [],
    },
    cobertura: { estado: cobertura, motivos: motivosCobertura, marketplacesConsultados: consultados, marketplacesSemLoja: semLoja, lojas },
    frescor: { estado: frescor, motivos: motivosFrescor },
    estado,
  };
}
