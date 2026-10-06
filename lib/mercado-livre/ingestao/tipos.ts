/**
 * Motor de ingestao do corpus Mercado Livre (ML-CORPUS-D1) — tipos e portas.
 *
 * DESCOBERTA por `date_closed` (janela comercial FECHADA, dias civis de
 * America/Sao_Paulo) → `ml_pedidos` (grao loja + order_id). A regra de
 * negocio (normalizacao, pack_splitted, unidades, valor) e do servico
 * canonico `lib/vendas/canonico/ml.ts`; o motor so descobre, normaliza
 * com ela, persiste e checkpointa. REFRESH de estado e outra funcao
 * (ver motor.ts) e nao mora aqui.
 */
import type { ErroVendasML } from "@/lib/mercado-livre-vendas";

/** Uma linha de `ml_pedidos`. */
export interface LinhaPedidoML {
  user_id: string;
  loja_id: string;
  order_id: string;
  date_created: string | null;
  date_closed: string | null;
  last_updated: string | null;
  status: string | null;
  cancel_detail_code: string | null;
  total_amount: number;
  unidades: number;
  fetched_at: string;
}

/** Leitura de UM dia civil por fechamento — crua, como a varredura homologada devolve. */
export interface DiaFechadoML {
  brutos: readonly Record<string, unknown>[];
  paginas: number;
  /** false = cobertura do dia nao conferida (nunca e "fim"). */
  completa: boolean;
  erro: ErroVendasML | null;
}

export interface TransporteML {
  listarDiaFechado(args: { userId: string; lojaId: string; dia: string }): Promise<DiaFechadoML>;
}

export interface CheckpointML {
  versao: 1;
  /** Dias (AAAA-MM-DD) ja listados por inteiro e gravados. */
  diasConcluidos: string[];
  /** Falhas transitorias por dia (retomadas na proxima fatia). */
  tentativas: Record<string, number>;
  iniciadoEm: string | null;
}

export interface ProgressoML {
  dias: number;
  diasConcluidos: number;
  paginas: number;
  recebidos: number;
  /** Pedidos da janela (populacao crua, inclusive pack_splitted). */
  listados: number;
  gravados: number;
  pack_splitted: number;
  ultimo_erro: string | null;
}

export interface JobML {
  id: string;
  userId: string;
  lojaId: string;
  /** Dias civis de Sao Paulo, inclusivos. */
  de: string;
  ate: string;
  checkpoint: CheckpointML | null;
  progresso: ProgressoML | null;
}

export interface PatchJobML {
  checkpoint: CheckpointML;
  progresso: ProgressoML;
  status?: "rodando" | "concluido" | "erro";
  listagemCompleta?: boolean;
  erroMensagem?: string | null;
}

export interface RepositorioML {
  /** A loja e ML, ativa e DESTE dono? (ownership vem do banco). */
  lojaDoDono(userId: string, lojaId: string): Promise<boolean>;
  /** Upsert por (loja_id, order_id); devolve quantas linhas eram novas. */
  gravarPedidos(userId: string, lojaId: string, linhas: LinhaPedidoML[]): Promise<{ novas: number }>;
  salvarJob(job: { id: string; userId: string; lojaId: string }, patch: PatchJobML): Promise<void>;
}

export interface RelogioML { agoraMs(): number }
