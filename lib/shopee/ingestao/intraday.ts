/**
 * Motor INTRADAY Shopee (SALES-SYNC-D15D) — observa o dia civil do JOB ate o
 * alvo T, para o prefixo [inicio do dia, T) do leitor canonico (data de
 * negocio = pay_time; create_time e so o campo da DESCOBERTA).
 *
 *   dia/T     vem do job (date_from, janela_fim), NUNCA do relogio: um job de
 *             06/10 que retoma em 07/10 continua o MESMO dia e o MESMO T.
 *   descoberta  create_time do dia INTEIRO [inicio do dia, T] a cada
 *             observacao (nao so o delta): pedido que o provedor indexou
 *             atrasado e recuperado na proxima observacao. Nenhum atraso de
 *             indexacao e assumido.
 *   re-detail o check B do leitor exige estado observado DEPOIS de T. Alem dos
 *             listados, re-detalha os pedidos conhecidos (consulta ao corpus,
 *             deterministica, reconstruivel):
 *               pagos em [inicio do dia, T)  — cancelamento pos-pagamento;
 *               nao pagos criados em [inicio do dia − LIMITE_POLITICA_PAGAMENTO_MS, T)
 *                 — o MESMO recorte do leitor (contarNaoPagosSemObservacaoShopee):
 *                 criado ontem/dias atras e pago hoje entra.
 *             Pagamento alem da politica: o sentinela do leitor (fail closed).
 *   escrow    a regra do proprio leitor (escrowShopeeAtual): so pagos sem
 *             escrow atual. Se um escrow necessario FALHA, o alvo NAO conclui
 *             (o motor normal concluiria) — o watermark anterior sobrevive.
 *   fases     as do motor existente (LIST → DETAIL → ESCROW → DONE), com o
 *             mesmo checkpoint: candidatos semeados em pendentesDetalhe na 1a
 *             fatia; pausa/retomada por fase.
 *
 * O motor de janelas normais (motor.ts) nao muda. Fica atras de
 * ENABLE_ASYNC_SYNC_JOBS e o worker so o chama com o intraday habilitado.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { inicioDoDiaEmSaoPaulo, somarDiasNoCalendario } from "@/lib/fuso-sao-paulo";
import { ASYNC_SYNC_JOBS_ENABLED } from "@/lib/feature-flags";
import { LIMITE_POLITICA_PAGAMENTO_MS } from "@/lib/vendas/canonico/shopee";
import { checkpointInicial, executarFatiaShopee, progressoInicial, type OpcoesMotor, type ResultadoFatia } from "./motor";
import type { CheckpointShopee, ProgressoShopee, Relogio, Repositorio, ShopeeApi } from "./tipos";

export interface JobShopeeIntraday {
  id: string;
  userId: string;
  lojaId: string;
  /** O dia civil (AAAA-MM-DD, Sao Paulo) do JOB. */
  dia: string;
  /** O alvo T (ISO): fim EXCLUSIVO do prefixo observado. */
  alvoIso: string;
  checkpoint: CheckpointShopee | null;
  progresso: ProgressoShopee | null;
}

/** Candidatos a re-detail (order_sn), deterministicos: so do dono e da loja. */
export type CandidatosRedetalheShopee = (a: { userId: string; lojaId: string; inicioDiaIso: string; desdeIso: string; alvoIso: string }) => Promise<string[]>;

const PAGINA = 1000;

/** Consulta ao corpus: pagos em [inicio do dia, T) + nao pagos criados em [desde, T). Ordem por order_sn. */
export function criarCandidatosRedetalheShopee(cliente: SupabaseClient): CandidatosRedetalheShopee {
  return async ({ userId, lojaId, inicioDiaIso, desdeIso, alvoIso }) => {
    const out = new Set<string>();
    const ler = async (filtro: (q: any) => any) => {
      for (let de = 0; ; de += PAGINA) {
        const { data, error } = await filtro(cliente.from("shopee_pedidos").select("order_sn").eq("user_id", userId).eq("loja_id", lojaId))
          .order("order_sn", { ascending: true }).range(de, de + PAGINA - 1);
        if (error) throw new Error("candidatos_redetalhe:leitura_falhou");
        const lote = (data ?? []) as { order_sn: string }[];
        for (const r of lote) out.add(r.order_sn);
        if (lote.length < PAGINA) return;
      }
    };
    await ler((q) => q.gte("pay_time", inicioDiaIso).lt("pay_time", alvoIso));
    await ler((q) => q.is("pay_time", null).gte("create_time", desdeIso).lt("create_time", alvoIso));
    return [...out].sort();
  };
}

export async function executarFatiaShopeeIntraday(
  job: JobShopeeIntraday,
  deps: { api: ShopeeApi; repo: Repositorio; relogio: Relogio; candidatos: CandidatosRedetalheShopee },
  opcoes: OpcoesMotor,
): Promise<ResultadoFatia> {
  if (!(opcoes.habilitado ?? ASYNC_SYNC_JOBS_ENABLED)) return { estado: "desabilitado" };
  const { api, repo, relogio } = deps;
  const dono = { id: job.id, userId: job.userId, lojaId: job.lojaId };
  const inicioDia = inicioDoDiaEmSaoPaulo(job.dia);
  const fimDia = /^\d{4}-\d{2}-\d{2}$/.test(job.dia) ? inicioDoDiaEmSaoPaulo(somarDiasNoCalendario(job.dia, 1)) : null;
  const alvo = Date.parse(job.alvoIso);
  const falharCedo = async (motivo: string) => {
    const ck = job.checkpoint ?? checkpointInicial(); const pr = job.progresso ?? progressoInicial();
    pr.ultimo_erro = motivo;
    await repo.salvarJob(dono, { checkpoint: ck, progresso: pr, status: "erro", erroMensagem: motivo, listagemCompleta: false });
    return { estado: "falhou" as const, motivo, checkpoint: ck, progresso: pr };
  };
  if (inicioDia === null || fimDia === null || !Number.isFinite(alvo)) return falharCedo("janela_invalida");
  const ini = Date.parse(inicioDia), fim = Date.parse(fimDia);
  if (!(alvo > ini && alvo <= fim)) return falharCedo("alvo_fora_do_dia");
  // observar o futuro nao prova nada: o detail de cada pedido precisa ser >= T
  if (alvo > relogio.agoraMs()) return falharCedo("alvo_no_futuro");

  // 1a fatia: semeia os candidatos a re-detail (o checkpoint os carrega nas proximas)
  let checkpoint = job.checkpoint;
  if (checkpoint === null) {
    checkpoint = checkpointInicial();
    checkpoint.pendentesDetalhe = await deps.candidatos({ userId: job.userId, lojaId: job.lojaId,
      inicioDiaIso: new Date(ini).toISOString(), desdeIso: new Date(ini - LIMITE_POLITICA_PAGAMENTO_MS).toISOString(), alvoIso: new Date(alvo).toISOString() });
  }

  // Um alvo so vira observacao se TODO escrow necessario foi gravado: o motor
  // normal concluiria mesmo com escrow desistido; aqui isso vira erro.
  const falhasEscrow = (ck: CheckpointShopee) => Object.keys(ck.falhasEscrow ?? {}).length;
  const repoIntraday: Repositorio = {
    ...repo,
    salvarJob: (j, patch) => (patch.status === "concluido" && falhasEscrow(patch.checkpoint as CheckpointShopee) > 0
      ? repo.salvarJob(j, { ...patch, status: "erro", erroMensagem: `escrow_nao_gravado:${falhasEscrow(patch.checkpoint as CheckpointShopee)}` })
      : repo.salvarJob(j, patch)),
  };
  const r = await executarFatiaShopee(
    { id: job.id, userId: job.userId, lojaId: job.lojaId, campoTempo: "create_time",
      janelaInicio: new Date(ini).toISOString(), janelaFim: new Date(alvo).toISOString(), checkpoint, progresso: job.progresso },
    { api, repo: repoIntraday, relogio }, opcoes);
  if (r.estado === "concluido" && falhasEscrow(r.checkpoint) > 0) return { estado: "falhou", motivo: `escrow_nao_gravado:${falhasEscrow(r.checkpoint)}`, checkpoint: r.checkpoint, progresso: r.progresso };
  return r;
}
