/**
 * Vendas A3.4 (Parte A) — métricas do Mercado Livre na tela de Vendas, HÍBRIDAS:
 *
 *   valores   SÓ do serviço canônico (`consultarVendasCanonicas` → corpus `ml_pedidos`): data = `order.date_closed`
 *             em America/Sao_Paulo, todos os status menos `cancel_detail.code = pack_splitted`. Vendas = pedidos,
 *             Unidades = Σ quantity, Vendas brutas = Σ total_amount — calculados LÁ (calcularMetricasML); aqui não há
 *             fórmula, só projeção. Setembro/2026 = 10896 / 11358 / 393745,59 (provado contra o painel do ML).
 *   estado    COMPLETE (número confirmado — período inteiro, ou até `observadoAte` quando inclui hoje),
 *             PARTIAL (corpus ainda sem prova: número NÃO é mostrado como final; "X/Y dias"),
 *             FAILED (leitura/ingestão falhou ou credencial inutilizável: indisponível, sem número).
 *   refresh   não-COMPLETE_FRESH (parcial, velho, falho) ou pedido explícito → o MECANISMO EXISTENTE: coordenador
 *             (`avaliarNecessidadeDeSync` + `garantirProximaAcao`) cria no máximo UM sync_job por loja, que o worker de
 *             ingestão do corpus executa; depois a releitura canônica recalcula. Nenhum writer novo, nenhum cache novo.
 *             Gate: `ENABLE_CANONICAL_SALES_SYNC` (a flag das rotas canônicas) — desligada, só avalia.
 *
 * Nunca lê o legado `pedidos`. `fonte` é sempre o corpus canônico: nunca "ao vivo" (o provider não foi chamado aqui).
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import { alcanceFechamentoML, type JanelaFechamentoML } from "@/lib/vendas/canonico/ml";
import { intervaloSaoPaulo } from "@/lib/vendas/canonico/shopee";
import { consultarVendasCanonicas, ErroVendasCanonicas, type DependenciasConsultaVendas, type EstadoConsulta, type ResultadoVendasCanonicas } from "@/lib/vendas/canonico/service";
import { avaliarNecessidadeDeSync, garantirProximaAcao } from "@/lib/vendas/sync/coordenador";
import { syncCanonicoVendasHabilitado } from "@/lib/vendas/sync/flag-canonica";
import { POLITICA_SYNC_PROPOSTA } from "@/lib/vendas/sync/planejamento";
import { somarDiasNoCalendario } from "@/lib/fuso-sao-paulo";

export type EstadoMetricasHibridasML = "COMPLETE" | "PARTIAL" | "FAILED";
export type ResultadoRevalidacaoML = "JOB_CRIADO" | "AGUARDANDO" | "NOOP" | "DESABILITADO" | "FALHOU" | "NAO_PEDIDA";

export interface MetricasHibridasML {
  estado: EstadoMetricasHibridasML;
  /** Sempre o corpus canônico confirmado — a tela nunca o chama de "ao vivo". */
  fonte: "CANONICO";
  /** Estado do serviço canônico (diagnóstico), ou ERRO quando a consulta falhou. */
  estadoCanonico: EstadoConsulta | "ERRO";
  /** Instante (ISO) em que este estado foi avaliado. */
  estadoEm: string;
  /** Período com hoje: os números valem até aqui (ISO). null fora disso. */
  observadoAte: string | null;
  periodo: { de: string; ate: string };
  /** Só em COMPLETE. Vendas = pedidos; Vendas brutas = R$. */
  metricas: { vendas: number; unidades: number; vendasBrutas: number } | null;
  /** Progresso da confirmação: dias do período com cobertura provada no corpus. */
  dias: { confirmados: number; total: number };
  revalidacao: ResultadoRevalidacaoML;
}

export interface DependenciasMetricasHibridasML extends DependenciasConsultaVendas {
  /** Teste: substitui o coordenador. Padrão = avaliarNecessidadeDeSync + garantirProximaAcao. */
  revalidar?: (a: { userId: string; lojaId: string; de: string; ate: string }) => Promise<ResultadoRevalidacaoML>;
  /** Teste: força a flag do sync canônico. */
  habilitado?: boolean;
}

/** Erros do serviço que são da REQUISIÇÃO (4xx) — sobem para a rota; o resto vira FAILED. */
const ERROS_DE_ENTRADA = new Set(["OWNER_AUSENTE", "LOJA_FORA_DO_OWNER", "MARKETPLACE_INVALIDO", "PERIODO_INVALIDO"]);

function diasDoPeriodo(de: string, ate: string): string[] {
  const dias: string[] = [];
  for (let d = de; d <= ate && dias.length < 400; d = somarDiasNoCalendario(d, 1)) dias.push(d);
  return dias;
}

/** Projeção pura do resultado canônico no estado da tela (sem fórmula: os números são os do serviço). */
export function classificarMetricasML(r: ResultadoVendasCanonicas, lojaId: string): Pick<MetricasHibridasML, "estado" | "metricas" | "observadoAte"> {
  const loja = r.cobertura.lojas.find((l) => l.lojaId === lojaId) ?? null;
  const m = r.metricas.mercadoLivre;
  const confirmado = m !== null && (r.completo || (r.parcial && r.observadoAte !== null && loja?.parteAtual?.estado === "OBSERVADA"));
  if (confirmado) return { estado: "COMPLETE", metricas: { vendas: m.pedidos, unidades: m.unidades, vendasBrutas: m.vendas }, observadoAte: r.parcial ? r.observadoAte : null };
  const falhou = !loja || !loja.ativa || loja.elegibilidade !== "ELEGIVEL"
    || loja.motivos.some((x) => x === "LEITURA_FAILED" || x === "LOJA_SEM_RESULTADO_DO_LEITOR" || x.startsWith("CREDENCIAL_INUTILIZAVEL"));
  return { estado: falhou ? "FAILED" : "PARTIAL", metricas: null, observadoAte: null };
}

/** Dias do período com cobertura `date_closed` provada (a MESMA cadeia de janelas do leitor canônico). */
async function diasConfirmados(cliente: SupabaseClient, userId: string, lojaId: string, dias: string[], hoje: string | null): Promise<number> {
  const { data, error } = await cliente.from("sync_jobs")
    .select("campo_tempo, janela_inicio, janela_fim, listagem_completa, status")
    .eq("user_id", userId).eq("loja_id", lojaId).eq("marketplace", "ML")
    .eq("campo_tempo", "date_closed").not("janela_inicio", "is", null);
  if (error) return 0;
  const janelas: JanelaFechamentoML[] = ((data ?? []) as Record<string, unknown>[]).map((j) => ({
    campoTempo: String(j.campo_tempo), inicio: String(j.janela_inicio), fim: String(j.janela_fim),
    listagemCompleta: (j.listagem_completa as boolean | null) ?? null, status: String(j.status),
  }));
  let n = 0;
  for (const d of dias) {
    if (d === hoje) continue;   // o dia corrente nunca é "confirmado inteiro"
    const { inicio, fim } = intervaloSaoPaulo(d, d);
    const alcance = alcanceFechamentoML(janelas, inicio.getTime());
    if (alcance !== null && alcance >= fim.getTime()) n++;
  }
  return n;
}

export async function metricasHibridasML(
  entrada: { userId: string; lojaId: string; de: string; ate: string; revalidar?: boolean },
  deps: DependenciasMetricasHibridasML = {},
): Promise<MetricasHibridasML> {
  const agoraMs = deps.agoraMs ?? Date.now();
  const cliente: SupabaseClient = deps.cliente ?? getSupabaseServidor();
  const politica = deps.politica ?? POLITICA_SYNC_PROPOSTA;
  const { userId, lojaId, de, ate } = entrada;
  const dias = diasDoPeriodo(de, ate);
  const base = { fonte: "CANONICO" as const, estadoEm: new Date(agoraMs).toISOString(), periodo: { de, ate } };

  let r: ResultadoVendasCanonicas | null = null;
  try {
    r = await consultarVendasCanonicas({ userId, marketplace: "mercado_livre", lojaId, de, ate }, { cliente, agoraMs, politica });
  } catch (e) {
    if (e instanceof ErroVendasCanonicas && ERROS_DE_ENTRADA.has(e.codigo)) throw e;
  }

  const c = r ? classificarMetricasML(r, lojaId) : { estado: "FAILED" as const, metricas: null, observadoAte: null };
  const loja = r?.cobertura.lojas.find((l) => l.lojaId === lojaId) ?? null;
  const hoje = r?.partes.atual?.dia ?? null;

  // refresh pelo coordenador existente: só da parte FECHADA (o dia corrente é do intraday do tick) e só de loja que
  // o worker consegue ingerir (ativa + credencial utilizável). COMPLETE_FRESH sem pedido explícito: nada a fazer.
  let revalidacao: ResultadoRevalidacaoML = "NAO_PEDIDA";
  const fechada = r?.partes.fechada ?? (r ? null : { de, ate: hoje && ate >= hoje ? somarDiasNoCalendario(hoje, -1) : ate });
  const precisa = entrada.revalidar === true || r?.estado !== "COMPLETE_FRESH";
  const ingerivel = loja ? loja.ativa && loja.elegibilidade === "ELEGIVEL" : r === null;
  if (precisa && ingerivel && fechada && fechada.de <= fechada.ate) {
    const revalidar = deps.revalidar ?? (async (a: { userId: string; lojaId: string; de: string; ate: string }): Promise<ResultadoRevalidacaoML> => {
      const av = await avaliarNecessidadeDeSync(cliente, { userId: a.userId, marketplace: "ML", lojaId: a.lojaId, de: a.de, ate: a.ate, origem: "usuario" }, { agoraMs, politica });
      const g = await garantirProximaAcao(cliente, a.userId, [av], { habilitado: deps.habilitado ?? syncCanonicoVendasHabilitado() });
      return g.desabilitado ? "DESABILITADO" : g.criados.length > 0 ? "JOB_CRIADO" : g.aguardando.length > 0 ? "AGUARDANDO" : "NOOP";
    });
    try { revalidacao = await revalidar({ userId, lojaId, de: fechada.de, ate: fechada.ate }); }
    catch { revalidacao = "FALHOU"; }
  }

  let confirmados = 0;
  if (c.estado === "COMPLETE") confirmados = dias.length;
  else { try { confirmados = await diasConfirmados(cliente, userId, lojaId, dias, hoje); } catch { confirmados = 0; } }

  return { ...base, estado: c.estado, estadoCanonico: r?.estado ?? "ERRO", observadoAte: c.observadoAte, metricas: c.metricas,
    dias: { confirmados, total: dias.length }, revalidacao };
}
