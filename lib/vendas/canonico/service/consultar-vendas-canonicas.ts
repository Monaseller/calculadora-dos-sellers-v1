/**
 * Consulta canonica de vendas (SALES-CANONICAL-D13/D14) — o UNICO ponto de
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
 *   D14: periodo com hoje = parte FECHADA (semantica normal) + parte ATUAL
 *   (prefixo observado ate o alcance da cadeia de janelas, pelos MESMOS
 *   leitores com `parcial: true`). Sem prova de observacao: metricas null.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import { listarLojasDoDonoParaVendasCanonicas, type LinhaLojaParaVendasCanonicas } from "@/lib/marketplace/credenciais";
import { avaliarNecessidadeDeSync } from "@/lib/vendas/sync/coordenador";
import { POLITICA_SYNC_PROPOSTA } from "@/lib/vendas/sync/planejamento";
import type { AvaliacaoLojaSync, MarketplaceSync } from "@/lib/vendas/sync/tipos";
import { lerVendasML, somarMetricasML, type MetricasVendasML, type ResultadoVendasML } from "../ml";
import { lerVendasShopee, somarMetricas } from "../shopee";
import type { Completude, ComponentesVendasShopee, MetricasVendas, ParcialObservadoLoja, ResultadoVendas } from "../tipos";
import { ErroPeriodoVendas, resolverPeriodoVendas, type PeriodoVendasResolvido } from "../periodo";
import {
  ErroVendasCanonicas, type ConsultaVendasCanonicas, type DependenciasConsultaVendas, type EstadoCobertura, type EstadoConsulta,
  type EstadoFrescor, type LojaVendasCanonicas, type MarketplaceConsulta, type MarketplaceLoja, type MetricasCombinadas,
  type ParteAtualLoja, type PartesDoPeriodo, type ResultadoVendasCanonicas,
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

  // ── 3. partes do periodo (D14): MESMAS fronteiras para todos os marketplaces ──
  //   periodo fechado:  uma parte, lida com a semantica normal (D13).
  //   periodo com hoje: fechada [de, ontem] (semantica normal) + atual [hoje]
  //                     (prefixo observado ate o alcance da cadeia de janelas).
  const hoje = periodo.parcial ? resolverPeriodoVendas({ preset: "HOJE" }, agoraMs) : null;
  const ontem = periodo.parcial ? resolverPeriodoVendas({ preset: "ONTEM" }, agoraMs).de : null;
  const fechada = !periodo.parcial ? { de: periodo.de, ate: periodo.ate } : periodo.de < periodo.hoje ? { de: periodo.de, ate: ontem! } : null;
  const partes: PartesDoPeriodo = { fechada, atual: hoje ? { dia: hoje.de, inicioInclusivo: hoje.inicioInclusivo, fimExclusivo: hoje.fimExclusivo } : null };
  const politica = deps.politica ?? POLITICA_SYNC_PROPOSTA;

  // ── 4. valores: SO os leitores oficiais, SO dos marketplaces com loja no escopo ──
  const lerParte = (m: MarketplaceLoja, parte: { de: string; ate: string }, parcial: boolean): Promise<ResultadoVendasML | ResultadoVendas> =>
    protegido<ResultadoVendasML | ResultadoVendas>(m, () => m === "mercado_livre"
      ? lerVendasML(cliente, { userId, de: parte.de, ate: parte.ate, lojaIds: idsDe(m), ...(parcial ? { parcial: true } : {}) })
      : lerVendasShopee(cliente, { userId, de: parte.de, ate: parte.ate, lojaIds: idsDe(m), ...(parcial ? { parcial: true } : {}) }));
  const leiturasFechada = new Map<MarketplaceLoja, ResultadoVendasML | ResultadoVendas>();
  const leiturasAtual = new Map<MarketplaceLoja, ResultadoVendasML | ResultadoVendas>();
  for (const m of consultados) {
    if (fechada) leiturasFechada.set(m, await lerParte(m, fechada, false));
    if (hoje) leiturasAtual.set(m, await lerParte(m, { de: hoje.de, ate: hoje.ate }, true));
  }
  const lojaDe = (mapa: Map<MarketplaceLoja, ResultadoVendasML | ResultadoVendas>, m: MarketplaceLoja, id: string): LeituraLoja | null =>
    ((mapa.get(m)?.lojas ?? []) as LeituraLoja[]).find((r) => r.lojaId === id) ?? null;

  // ── 5. frescor da parte fechada: SO o avaliador do coordenador (lojas ATIVAS; leitura pura) ──
  const avaliacoes = new Map<string, AvaliacaoLojaSync>();
  if (fechada) for (const m of consultados) {
    const ativas = escopo.filter((l) => DE_SYNC[l.marketplace] === m && l.ativo);
    if (!ativas.length) continue;
    const av = await protegido(`frescor_${m}`, () => avaliarNecessidadeDeSync(cliente,
      { userId, marketplace: PARA_SYNC[m], lojaId: lojaId ?? undefined, de: fechada.de, ate: fechada.ate, origem: "usuario" },
      { agoraMs, politica }));
    for (const a of av.lojas) avaliacoes.set(a.lojaId, a);
  }
  // dia corrente = faixa mais recente da politica canonica (a mesma do planejador)
  const intervaloAtualMs = politica.faixas[0]?.intervaloMs ?? 0;

  // ── 6. composicao por loja ──
  const lojas: LojaVendasCanonicas[] = escopo.map((l) => {
    const mkt = DE_SYNC[l.marketplace];
    const rf = fechada ? lojaDe(leiturasFechada, mkt, l.id) : null;
    const ra = hoje ? lojaDe(leiturasAtual, mkt, l.id) : null;
    const motivos: string[] = [];
    if (!l.ativo) motivos.push("LOJA_INATIVA");
    if (l.elegibilidade.estado !== "ELEGIVEL") motivos.push(`CREDENCIAL_INUTILIZAVEL:${l.elegibilidade.motivo}`);
    const semLeitor = (fechada !== null && !rf) || (hoje !== null && !ra);
    if (semLeitor) motivos.push("LOJA_SEM_RESULTADO_DO_LEITOR");
    const falhou = rf?.completude === "FAILED" || ra?.completude === "FAILED";
    if (falhou) motivos.push("LEITURA_FAILED");
    if (rf) motivos.push(...rf.motivos.map((m) => `leitor:${m}`));

    let cobertura: EstadoCobertura;
    if (!l.ativo || l.elegibilidade.estado !== "ELEGIVEL" || semLeitor || falhou) cobertura = "INCOMPLETE";
    else if (rf && rf.completude !== "COMPLETE") { cobertura = "INCOMPLETE"; motivos.push("COBERTURA_DO_PERIODO_FECHADO_INCOMPLETA"); }
    else if (periodo.parcial) { cobertura = "PARTIAL"; motivos.push("PERIODO_INCLUI_HOJE"); }
    else cobertura = "COMPLETE";

    // parte atual: OBSERVADA so com prova da cadeia de janelas (nunca pela existencia de linhas)
    let parteAtual: ParteAtualLoja | null = null;
    let metricasAtual: MetricasVendasML | MetricasVendas | null = null;
    if (hoje) {
      const p = ra?.parcial;
      let observadoAte: string | null = null; const motivosAtual: string[] = [];
      if (ra && ra.completude === "COMPLETE") { observadoAte = hoje.fimExclusivo; metricasAtual = ra.metricas; }
      else if (p && p.estado === "OBSERVADO_ATE" && p.completude === "COMPLETE" && p.metricas) { observadoAte = p.observadoAte; metricasAtual = p.metricas; }
      else {
        motivosAtual.push(!p || p.estado === "SEM_OBSERVACAO" ? "PARTE_ATUAL_NAO_OBSERVADA"
          : p.estado === "DIA_FECHADO" ? "PARTE_ATUAL_DIA_FECHADO_SEM_PROVA" : "PARTE_ATUAL_OBSERVADA_SEM_PROVA_COMPLETA");
        motivosAtual.push(...(p?.motivos ?? []).map((m) => `leitor:${m}`));
      }
      const frescorAtual: EstadoFrescor = observadoAte === null ? "DESCONHECIDO"
        : agoraMs - Date.parse(observadoAte) <= intervaloAtualMs ? "FRESH" : "STALE";
      if (frescorAtual === "STALE") motivosAtual.push("PARTE_ATUAL_OBSERVACAO_VELHA");
      parteAtual = { estado: observadoAte === null ? "NAO_OBSERVADA" : "OBSERVADA", observadoAte, frescor: frescorAtual, motivos: motivosAtual };
    }

    let metricas: MetricasVendasML | MetricasVendas | null = null;
    if (!periodo.parcial) metricas = cobertura === "COMPLETE" ? rf!.metricas : null;
    else if (cobertura === "PARTIAL" && parteAtual?.estado === "OBSERVADA") metricas = somarDoMarketplace(mkt, [...(fechada ? [rf!.metricas] : []), metricasAtual]);

    const av = avaliacoes.get(l.id);
    const frescorFechada: EstadoFrescor | null = fechada ? (av ? av.frescor : "DESCONHECIDO") : null;
    const frescor = combinarFrescor([frescorFechada, parteAtual?.frescor ?? null]);
    const motivosFrescor = [
      ...(fechada ? (av ? av.motivos : [l.ativo ? "FRESCOR_NAO_AVALIADO" : "LOJA_INATIVA_SEM_AVALIACAO_DE_FRESCOR"]) : []),
      ...(parteAtual ? [`PARTE_ATUAL_${parteAtual.estado}`] : []),
    ];

    return {
      lojaId: l.id, marketplace: mkt, ativa: l.ativo, elegibilidade: l.elegibilidade.estado,
      completudeLeitor: rf?.completude ?? null, cobertura, motivos, metricas,
      componentes: !periodo.parcial && cobertura === "COMPLETE" ? rf!.componentes ?? null : null,
      frescor, motivosFrescor, parteAtual,
    };
  });

  // ── 7. agregado: COMPLETE so se TODAS as lojas forem; PARTIAL com metricas so se TODAS observaram hoje ──
  const motivosCobertura: string[] = [];
  let cobertura: EstadoCobertura = lojas.some((l) => l.cobertura === "INCOMPLETE") ? "INCOMPLETE"
    : lojas.some((l) => l.cobertura === "PARTIAL") ? "PARTIAL" : "COMPLETE";
  for (const l of lojas) if (l.cobertura !== "COMPLETE") motivosCobertura.push(`${l.marketplace}:${l.lojaId}:${l.cobertura}`);
  const todasObservadas = lojas.every((l) => l.parteAtual?.estado === "OBSERVADA");
  if (cobertura === "PARTIAL" && !todasObservadas) {
    for (const l of lojas) if (l.parteAtual?.estado !== "OBSERVADA") motivosCobertura.push(`${l.marketplace}:${l.lojaId}:PARTE_ATUAL_NAO_OBSERVADA`);
  }

  let totalML: MetricasVendasML | null = null, totalShopee: MetricasVendas | null = null;
  if (!periodo.parcial) {
    totalML = (leiturasFechada.get("mercado_livre") as ResultadoVendasML | undefined)?.total ?? null;
    totalShopee = (leiturasFechada.get("shopee") as ResultadoVendas | undefined)?.total ?? null;
    if (cobertura === "COMPLETE" && ((consultados.includes("mercado_livre") && !totalML) || (consultados.includes("shopee") && !totalShopee))) {
      cobertura = "INCOMPLETE"; motivosCobertura.push("TOTAL_DO_LEITOR_AUSENTE");
    }
  } else if (cobertura === "PARTIAL" && todasObservadas) {
    const de = (m: MarketplaceLoja) => lojas.filter((l) => l.marketplace === m).map((l) => l.metricas);
    if (consultados.includes("mercado_livre")) totalML = somarDoMarketplace("mercado_livre", de("mercado_livre")) as MetricasVendasML;
    if (consultados.includes("shopee")) totalShopee = somarDoMarketplace("shopee", de("shopee")) as MetricasVendas;
  }
  // defesa: sem o total de TODO marketplace consultado nao ha metrica (nunca um zero de soma vazia)
  const totaisPresentes = (!consultados.includes("mercado_livre") || totalML !== null) && (!consultados.includes("shopee") || totalShopee !== null);
  const comMetricas = totaisPresentes && (cobertura === "COMPLETE" || (cobertura === "PARTIAL" && todasObservadas));

  let combinadas: MetricasCombinadas | null = null;
  if (comMetricas) {
    // soma de centavo do PROPRIO leitor oficial (somarMetricasML), sobre os campos compativeis
    const partesSoma = [totalML, totalShopee].filter((m) => m !== null).map((m) => ({ pedidos: m!.pedidos, unidades: m!.unidades, vendas: m!.vendas }));
    combinadas = somarMetricasML(partesSoma);
  }

  const frescor = combinarFrescor(lojas.map((l) => l.frescor));
  const motivosFrescor = [...new Set(lojas.flatMap((l) => l.motivosFrescor.map((m) => `${l.marketplace}:${l.lojaId}:${m}`)))];

  const estado: EstadoConsulta = cobertura === "INCOMPLETE" ? "INCOMPLETE"
    : cobertura === "PARTIAL" ? (!todasObservadas ? "PARTIAL_SEM_OBSERVACAO_ATUAL" : frescor === "FRESH" ? "PARTIAL_FRESH" : "PARTIAL_STALE")
      : frescor === "FRESH" ? "COMPLETE_FRESH" : "COMPLETE_STALE";
  const observados = lojas.map((l) => l.parteAtual?.observadoAte ?? null).filter((x): x is string => x !== null).sort();

  return {
    userId, marketplace, lojaId, periodo, partes,
    metricas: {
      combinadas,
      mercadoLivre: comMetricas ? totalML : null,
      shopee: comMetricas ? totalShopee : null,
      semVendas: combinadas ? combinadas.pedidos === 0 : null,
      incompatibilidades: consultados.length > 1 ? [...INCOMPATIBILIDADES_ENTRE_MARKETPLACES] : [],
    },
    cobertura: { estado: cobertura, motivos: motivosCobertura, marketplacesConsultados: consultados, marketplacesSemLoja: semLoja, lojas },
    frescor: { estado: frescor, motivos: motivosFrescor },
    estado,
    parcial: periodo.parcial,
    completo: estado === "COMPLETE_FRESH" || estado === "COMPLETE_STALE",
    fresco: comMetricas ? frescor === "FRESH" : null,
    observadoAte: periodo.parcial && comMetricas ? observados[0] ?? null : null,
  };
}

/** O que o servico le de cada loja no resultado de um leitor (ML ou Shopee). */
interface LeituraLoja {
  lojaId: string;
  completude: Completude;
  motivos: string[];
  metricas: MetricasVendasML | MetricasVendas | null;
  componentes?: ComponentesVendasShopee | null;
  parcial?: ParcialObservadoLoja<MetricasVendasML | MetricasVendas>;
}

/** Soma de centavo do PROPRIO leitor do marketplace (somarMetricasML / somarMetricas). null se faltar qualquer parte. */
function somarDoMarketplace(m: MarketplaceLoja, ms: (MetricasVendasML | MetricasVendas | null)[]): MetricasVendasML | MetricasVendas | null {
  if (!ms.length || ms.some((x) => x === null)) return null;
  const presentes = ms as (MetricasVendasML | MetricasVendas)[];
  return m === "mercado_livre" ? somarMetricasML(presentes as MetricasVendasML[]) : somarMetricas(presentes as MetricasVendas[]);
}

/** DESCONHECIDO > STALE > FRESH (null = parte inexistente). */
function combinarFrescor(fs: (EstadoFrescor | null)[]): EstadoFrescor {
  const v = fs.filter((x): x is EstadoFrescor => x !== null);
  if (!v.length || v.includes("DESCONHECIDO") || v.includes("IN_PROGRESS")) return "DESCONHECIDO";
  return v.includes("STALE") ? "STALE" : "FRESH";
}
