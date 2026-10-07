/**
 * Motor INTRADAY Mercado Livre (SALES-SYNC-D15C) — observa o dia civil do
 * JOB ate o alvo T.
 *
 *   dia     vem do job (date_from), NUNCA do relogio: um job de 06/10 que
 *           retoma em 07/10 continua relendo 06/10 e cortando no MESMO T.
 *   query   o dia civil INTEIRO por date_closed — a MESMA varredura
 *           homologada do fechamento (transporte.listarDiaFechado: paginacao
 *           completa, 429, releitura do dia curto, conferencia contra
 *           paging.total, teto de paginas → completa=false). Nao ha delta:
 *           cada observacao RE-OBSERVA o prefixo inteiro (check B do D14:
 *           fetched_at de todo pedido do prefixo >= T) e recupera pedido que
 *           o provedor indexou atrasado. Nenhum atraso de indexacao e
 *           assumido.
 *   corte   [inicio do dia, T): date_closed < T (o MESMO intervalo tecnico
 *           do leitor canonico). Pedido em T ou depois NAO e persistido por
 *           esta observacao (sera visto pela proxima ou pelo fechamento).
 *           Nao reusa o `ateInstanteMs` do "Vendas ao vivo", que e INCLUSIVO.
 *   regra   normalizacao/recorte do dia de `linhasDoDia` (servico canonico);
 *           upsert (loja_id, order_id) pelo MESMO repositorio do fechamento.
 *   fim     concluido + listagem_completa=true SO depois de gravar o prefixo
 *           do dia listado por inteiro. Dia incompleto (teto de paginas,
 *           erro transitorio) pausa e, apos `maxTentativasPorDia`, vira erro
 *           — nunca concluido.
 *
 * O motor de fechamento (motor.ts) nao muda. Fica atras de
 * ENABLE_ASYNC_SYNC_JOBS e o worker so o chama com o intraday habilitado.
 */
import { ASYNC_SYNC_JOBS_ENABLED } from "@/lib/feature-flags";
import type { ErroVendasML } from "@/lib/mercado-livre-vendas";
import { CANCELAMENTO_DE_PACOTE_REFEITO } from "@/lib/vendas/canonico/ml";
import { limitesDaJanela } from "./janelas";
import { checkpointInicialML, PADROES_ML, progressoInicialML, type OpcoesMotorML, type ResultadoFatiaML } from "./motor";
import { linhasDoDia } from "./normalizar";
import type { CheckpointML, ProgressoML, RelogioML, RepositorioML, TransporteML } from "./tipos";

export interface JobMLIntraday {
  id: string;
  userId: string;
  lojaId: string;
  /** O dia civil (AAAA-MM-DD, Sao Paulo) do JOB. */
  dia: string;
  /** O alvo T (ISO): fim EXCLUSIVO do prefixo observado. */
  alvoIso: string;
  checkpoint: CheckpointML | null;
  progresso: ProgressoML | null;
}

const PERMANENTES: ReadonlySet<ErroVendasML> = new Set(["credencial_ausente", "nao_autorizado", "resposta_invalida", "periodo_nao_entendido"]);

export async function executarFatiaMLIntraday(
  job: JobMLIntraday,
  deps: { transporte: TransporteML; repo: RepositorioML; relogio: RelogioML },
  opcoes: OpcoesMotorML,
): Promise<ResultadoFatiaML> {
  if (!(opcoes.habilitado ?? ASYNC_SYNC_JOBS_ENABLED)) return { estado: "desabilitado" };
  const o = { ...PADROES_ML, ...opcoes };
  const { transporte, repo, relogio } = deps;
  const ck: CheckpointML = job.checkpoint ? structuredClone(job.checkpoint) : checkpointInicialML();
  const pr: ProgressoML = job.progresso ? structuredClone(job.progresso) : progressoInicialML(1);
  const dono = { id: job.id, userId: job.userId, lojaId: job.lojaId };
  const salvar = (extra: { status?: "rodando" | "concluido" | "erro"; listagemCompleta?: boolean; erroMensagem?: string | null } = {}) =>
    repo.salvarJob(dono, { checkpoint: ck, progresso: pr, ...extra });
  const falhar = async (motivo: string) => {
    pr.ultimo_erro = motivo;
    await salvar({ status: "erro", listagemCompleta: false, erroMensagem: motivo });
    return { estado: "falhou" as const, motivo, checkpoint: ck, progresso: pr };
  };
  const pausar = async (motivo: string) => {
    await salvar({ status: "rodando", listagemCompleta: false });
    return { estado: "pausado" as const, motivo, checkpoint: ck, progresso: pr };
  };
  const cabe = () => relogio.agoraMs() + o.margemMs < o.prazoMs;

  // ── dono; dia e alvo vem do JOB ──
  if (!(await repo.lojaDoDono(job.userId, job.lojaId))) return falhar("loja_invalida");
  const lim = limitesDaJanela(job.dia, job.dia);
  const alvo = Date.parse(job.alvoIso);
  if (!lim || !Number.isFinite(alvo)) return falhar("janela_invalida");
  if (!(alvo > lim.inicio.getTime() && alvo <= lim.fim.getTime())) return falhar("alvo_fora_do_dia");
  // observar o futuro nao prova nada: o fetched_at de cada pedido precisa ser >= T
  if (alvo > relogio.agoraMs()) return falhar("alvo_no_futuro");
  if (ck.iniciadoEm === null) { ck.iniciadoEm = new Date(relogio.agoraMs()).toISOString(); await salvar({ status: "rodando", listagemCompleta: false }); }

  if (!ck.diasConcluidos.includes(job.dia)) {
    if (!cabe()) return pausar("prazo");
    const r = await transporte.listarDiaFechado({ userId: job.userId, lojaId: job.lojaId, dia: job.dia });
    if (r.erro !== null && PERMANENTES.has(r.erro)) return falhar(`listagem:${job.dia}:${r.erro}`);
    if (r.erro !== null || !r.completa) {
      const motivo = `listagem:${job.dia}:${r.erro ?? "dia_incompleto"}`;
      ck.tentativas[job.dia] = (ck.tentativas[job.dia] ?? 0) + 1;
      pr.ultimo_erro = motivo;
      if (ck.tentativas[job.dia] >= o.maxTentativasPorDia) return falhar(motivo);
      return pausar(motivo);
    }
    const agoraIso = new Date(relogio.agoraMs()).toISOString();
    const { linhas } = linhasDoDia(r.brutos, { userId: job.userId, lojaId: job.lojaId, dia: job.dia, agoraIso });
    // [inicio do dia, T): pedido em T ou depois nao pertence a esta observacao
    const prefixo = linhas.filter((l) => l.date_closed !== null && Date.parse(l.date_closed) < alvo);
    const { novas } = await repo.gravarPedidos(job.userId, job.lojaId, prefixo);
    ck.diasConcluidos.push(job.dia); delete ck.tentativas[job.dia];
    pr.diasConcluidos = ck.diasConcluidos.length; pr.paginas += r.paginas; pr.recebidos += r.brutos.length;
    pr.listados += prefixo.length; pr.gravados += novas;
    pr.pack_splitted += prefixo.filter((l) => l.cancel_detail_code === CANCELAMENTO_DE_PACOTE_REFEITO).length;
    await salvar({ status: "rodando", listagemCompleta: false });
  }
  pr.ultimo_erro = null;
  await salvar({ status: "concluido", listagemCompleta: true, erroMensagem: null });
  return { estado: "concluido", checkpoint: ck, progresso: pr };
}
