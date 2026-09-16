/**
 * APPROVAL-DECISION-RESUME-D5-C2-I1 — persistence da lane de RETOMADA.
 *
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  MODULO DORMENTE. Compila, e nao tem chamador de producao.       ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * ── O que este arquivo e, e o que ele nao e ─────────────────────────
 *
 * E um ADAPTADOR: converte as quatro RPCs da retomada em contratos
 * TypeScript estaveis. Nada mais. Ele nao decide QUANDO retomar, nao
 * procura Approval na fila, nao gera `request_id`, nao consulta o
 * registry de Funcao, nao executa Funcao, nao mapeia resultado
 * comercial e nao mantem heartbeat. Essas decisoes pertencem ao
 * orquestrador (C3) e a separacao de lanes de heartbeat (C2-I2).
 *
 * ── Por que a lane tem terminalizadores PROPRIOS ────────────────────
 *
 * Os terminalizadores genericos cercam por `(id, status, tentativas)` e
 * NAO conhecem `retomada_request_id`. Como a retomada PRESERVA a
 * tentativa N, uma tarefa retomada satisfaz as tres cercas deles — nao
 * ha como recusa-la de la. Por isso este modulo so alcanca as quatro
 * RPCs da retomada, e a suite prova estruturalmente que as genericas
 * nao aparecem aqui.
 *
 * ── Quem valida a entrada ───────────────────────────────────────────
 *
 * O BANCO, e so ele. Nao ha guarda local replicando as validacoes das
 * RPCs: elas ja recusam entrada ausente ou vazia — por codigo
 * (`entrada_invalida`) nas duas que devolvem texto, por SQLSTATE 22023
 * nas duas que devolvem linha. Uma segunda validacao aqui criaria uma
 * segunda fonte de verdade sobre o que e valido, que teria de ser
 * mantida em concordancia para sempre.
 *
 * O efeito colateral e desejavel: TODA invocacao de wrapper faz
 * EXATAMENTE uma chamada RPC, sem ramo que pule o banco.
 *
 * ── Erro bruto nunca sai daqui ──────────────────────────────────────
 *
 * O erro do driver carrega nome de coluna, de constraint e as vezes de
 * VALOR. Deste modulo saem apenas os quatro rotulos de
 * `FalhaPersistenciaRetomada`; `message`, `details` e `hint` nao sao
 * lidos em lugar nenhum. So `code` e inspecionado, para classificar.
 */
import "server-only";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import { normalizarLinha } from "@/lib/agentes/normalizar-linha";
import type { LinhaTarefa } from "@/lib/agentes/tipos";

// ─── Vocabulario de falha do ADAPTADOR ────────────────────────────────

/**
 * Falhas do adaptador — nao do dominio.
 *
 * Um codigo de dominio (`nao_stale`, `ja_consumida`, ...) e SUCESSO de
 * transporte: a RPC respondeu o que tinha a responder. Estes quatro
 * rotulos descrevem o que impediu de chegar a uma resposta util.
 */
export type FalhaPersistenciaRetomada =
  /** SQLSTATE 22023: a RPC recusou a entrada como obrigatoria ausente. */
  | "rpc_entrada_invalida"
  /** SQLSTATE 55000: as cercas do ciclo de retomada nao casaram. */
  | "rpc_fora_de_contrato"
  /** Transporte, permissao, timeout, ou qualquer code nao classificado. */
  | "rpc_indisponivel"
  /** A RPC nao falhou, mas devolveu algo fora do contrato declarado. */
  | "resposta_invalida";

/** Resultado de uma RPC que devolve CODIGO de dominio. */
export type ResultadoCodigoRetomada<TCodigo extends string> =
  | { readonly ok: true; readonly codigo: TCodigo }
  | { readonly ok: false; readonly falha: FalhaPersistenciaRetomada };

/** Resultado de uma RPC que devolve a LINHA da tarefa. */
export type ResultadoLinhaRetomada =
  | { readonly ok: true; readonly linha: LinhaTarefa }
  | { readonly ok: false; readonly falha: FalhaPersistenciaRetomada };

// ─── Classificacao de erro do driver ──────────────────────────────────

/**
 * Le SOMENTE `code`. Um erro sem `code`, ou com code desconhecido, e
 * indisponibilidade: nao se inventa semantica a partir de texto.
 */
function classificarErro(erro: unknown): FalhaPersistenciaRetomada {
  const code =
    typeof erro === "object" && erro !== null && "code" in erro
      ? (erro as { code?: unknown }).code
      : undefined;
  if (code === "22023") return "rpc_entrada_invalida";
  if (code === "55000") return "rpc_fora_de_contrato";
  return "rpc_indisponivel";
}

// ─── Codigos de dominio: INICIO da retomada ───────────────────────────

/**
 * Os 17 codigos de `retomar_aprovacao_iniciar`, que delega a
 * `aprovacao_consumir_abrir_e_retomar`. A lista segue o ponto do fluxo
 * em que cada um aparece, nao a ordem alfabetica.
 */
const CODIGOS_INICIO = [
  "entrada_invalida",
  "aprovacao_inexistente",
  "agente_indisponivel",
  "tarefa_indisponivel",
  "aprovacao_pendente",
  "ja_consumida",
  "ja_rejeitada",
  "ja_cancelada",
  "expirada",
  "aprovacao_desatualizada",
  "escrita_nao_suportada",
  "permissao_ausente",
  "permissao_bloqueada",
  "conexao_indisponivel",
  "tarefa_incompativel",
  "funcao_incompativel",
  "consumida",
] as const;

export type CodigoRetomadaInicio = (typeof CODIGOS_INICIO)[number];

const SET_CODIGOS_INICIO: ReadonlySet<string> = new Set(CODIGOS_INICIO);

/** Type guard de RUNTIME. Sem ele, um cast cegaria a resposta. */
export function ehCodigoRetomadaInicio(valor: unknown): valor is CodigoRetomadaInicio {
  return typeof valor === "string" && SET_CODIGOS_INICIO.has(valor);
}

/** Leitura somente, para diagnostico e teste. Nunca mutavel. */
export function codigosRetomadaInicio(): readonly CodigoRetomadaInicio[] {
  return CODIGOS_INICIO;
}

// ─── Codigos de dominio: RECUPERACAO de retomada travada ──────────────

/**
 * Os 5 codigos de `retomada_recuperar_tarefa_stale`. Os dois ultimos
 * nao aparecem como `return` literal na migration: eles viajam por
 * `v_erro_tipo`, que e o mesmo valor gravado em
 * `agente_tarefas.erro_tipo` e devolvido no fim da funcao.
 */
const CODIGOS_RECUPERACAO = [
  "entrada_invalida",
  "nao_stale",
  "causal_incompativel",
  "execucao_incerta",
  "execucao_ja_ocorrida_resultado_indisponivel",
] as const;

export type CodigoRetomadaRecuperacao = (typeof CODIGOS_RECUPERACAO)[number];

const SET_CODIGOS_RECUPERACAO: ReadonlySet<string> = new Set(CODIGOS_RECUPERACAO);

export function ehCodigoRetomadaRecuperacao(
  valor: unknown
): valor is CodigoRetomadaRecuperacao {
  return typeof valor === "string" && SET_CODIGOS_RECUPERACAO.has(valor);
}

export function codigosRetomadaRecuperacao(): readonly CodigoRetomadaRecuperacao[] {
  return CODIGOS_RECUPERACAO;
}

// ─── Normalizacao e validacao da linha composta ───────────────────────

/**
 * Aceita a linha SO se ela tem a forma minima de uma tarefa.
 *
 * `normalizarLinha` vem do modulo neutro compartilhado — a MESMA
 * implementacao que a lane normal usa. Copiar o corpo dela aqui criaria
 * a segunda fonte de verdade que o D5-C2-I0 existiu para evitar.
 *
 * Validar depois de normalizar nao e cerimonia: `null`, `undefined` e
 * array vazio chegam aqui como `null`, e nenhum deles pode contar como
 * sucesso de um terminalizador.
 */
function lerLinhaDeTarefa(data: unknown): LinhaTarefa | null {
  const linha = normalizarLinha(data);
  if (typeof linha !== "object" || linha === null || Array.isArray(linha)) return null;
  const r = linha as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id === "") return null;
  if (typeof r.user_id !== "string" || r.user_id === "") return null;
  if (typeof r.status !== "string" || r.status === "") return null;
  if (typeof r.tentativas !== "number") return null;
  return linha as LinhaTarefa;
}

// ─── 1. Inicio da retomada ────────────────────────────────────────────

/**
 * Consome a aprovacao, abre a Tool Call e leva a tarefa de
 * `aguardando_aprovacao` para `rodando`, preservando a tentativa N.
 *
 * `requestId` chega PRONTO: quem decide retomar e quem o gera, e o
 * mesmo valor precisa alcancar a aprovacao, a Tool Call e o marcador da
 * tarefa. Gerar aqui — ou aparar espacos — quebraria a causalidade que
 * a FK do D5 existe para garantir.
 *
 * `tipoEsperado` e `funcaoIdEsperada` vem do contrato congelado em
 * TypeScript e sao CERCA: o banco nao conhece o registry, entao ele
 * compara o que a aplicacao afirma contra a linha travada.
 */
export async function iniciarRetomadaAprovacao(
  userId: string,
  aprovacaoId: string,
  requestId: string,
  revisaoAtual: string,
  tipoEsperado: string,
  funcaoIdEsperada: string
): Promise<ResultadoCodigoRetomada<CodigoRetomadaInicio>> {
  const { data, error } = await getSupabaseServidor().rpc("retomar_aprovacao_iniciar", {
    p_user_id: userId,
    p_aprovacao_id: aprovacaoId,
    p_request_id: requestId,
    p_revisao_atual: revisaoAtual,
    p_tipo_tarefa_esperado: tipoEsperado,
    p_funcao_id_esperada: funcaoIdEsperada,
  });

  if (error) {
    console.error("[agentes-retomada] RPC de inicio de retomada falhou");
    return { ok: false, falha: classificarErro(error) };
  }
  // FAIL CLOSED: uma resposta fora do catalogo nao vira codigo por cast.
  // Ela e tratada como resposta invalida, e o chamador nao recebe
  // permissao para seguir.
  if (!ehCodigoRetomadaInicio(data)) {
    console.error("[agentes-retomada] inicio de retomada devolveu codigo fora do contrato");
    return { ok: false, falha: "resposta_invalida" };
  }
  return { ok: true, codigo: data };
}

// ─── 2. Falha terminal de uma retomada ────────────────────────────────

/**
 * Encerra em `erro` uma tarefa cuja retomada falhou DEPOIS do consumo.
 *
 * NUNCA o terminalizador generico de falha: ele devolveria a tarefa
 * para `pendente` enquanto houvesse tentativa, e o caminho generico
 * criaria uma aprovacao nova para uma acao ja executada — ou a
 * executaria direto, se a permissao tiver virado `automatico`.
 */
export async function falharTarefaRetomada(
  tarefaId: string,
  userId: string,
  erroTipo: string,
  erroMensagem: string,
  tentativaEsperada: number,
  retomadaRequestId: string
): Promise<ResultadoLinhaRetomada> {
  const { data, error } = await getSupabaseServidor().rpc("retomada_falhar_tarefa", {
    p_tarefa_id: tarefaId,
    p_user_id: userId,
    p_erro_tipo: erroTipo,
    // MESMO limite da lane normal (300), e pelo mesmo motivo: mensagem
    // de excecao pode carregar trecho de dado, e o caminho mais curto
    // ate o banco e o melhor lugar para cortar. A RPC ainda apara em
    // 500 do lado de la; os dois cortes sao deliberados.
    p_erro_mensagem: (erroMensagem ?? "").slice(0, 300),
    p_tentativa_esperada: tentativaEsperada,
    p_retomada_request_id: retomadaRequestId,
  });

  if (error) {
    console.error("[agentes-retomada] RPC de falha de retomada falhou");
    return { ok: false, falha: classificarErro(error) };
  }
  const linha = lerLinhaDeTarefa(data);
  if (linha === null) {
    console.error("[agentes-retomada] falha de retomada devolveu linha fora do contrato");
    return { ok: false, falha: "resposta_invalida" };
  }
  return { ok: true, linha };
}

// ─── 3. Recuperacao de retomada travada ───────────────────────────────

/**
 * OBSERVACIONAL. Encerra, sem executar nada, uma retomada interrompida
 * cuja tarefa ficou `rodando` com heartbeat vencido.
 *
 * O corte de 5 minutos e calculado DENTRO da RPC, na mesma transacao em
 * que ela le e escreve — um chamador lento com um corte antigo poderia
 * matar uma tarefa que acabou de voltar a respirar. Heartbeat fresco
 * devolve `nao_stale` sem escrever nada.
 *
 * Este wrapper nao reexecuta Funcao, nao fecha Tool Call, nao cria
 * aprovacao e nao tenta uma segunda RPC.
 */
export async function recuperarRetomadaStale(
  tarefaId: string,
  userId: string,
  tentativaEsperada: number,
  retomadaRequestId: string
): Promise<ResultadoCodigoRetomada<CodigoRetomadaRecuperacao>> {
  const { data, error } = await getSupabaseServidor().rpc(
    "retomada_recuperar_tarefa_stale",
    {
      p_tarefa_id: tarefaId,
      p_user_id: userId,
      p_tentativa_esperada: tentativaEsperada,
      p_retomada_request_id: retomadaRequestId,
    }
  );

  if (error) {
    console.error("[agentes-retomada] RPC de recuperacao de retomada falhou");
    return { ok: false, falha: classificarErro(error) };
  }
  if (!ehCodigoRetomadaRecuperacao(data)) {
    console.error("[agentes-retomada] recuperacao devolveu codigo fora do contrato");
    return { ok: false, falha: "resposta_invalida" };
  }
  return { ok: true, codigo: data };
}

// ─── 4. Sucesso da retomada ───────────────────────────────────────────

/**
 * Conclui a tarefa da lane de retomada.
 *
 * NUNCA o terminalizador generico de sucesso: ele nao conhece o
 * marcador, e como a retomada preserva a tentativa N, nao teria como
 * recusar uma tarefa retomada. Pior que na falha, aqui nao ha rede — o
 * CHECK `agente_tarefas_retomada_so_em_execucao_ou_terminal` admite
 * `concluido` com marcador nao-nulo, entao uma conclusao vinda da lane
 * errada passaria em silencio.
 *
 * `resultado` pode chegar vazio: a RPC normaliza nulo para `{}`.
 */
export async function concluirTarefaRetomada(
  tarefaId: string,
  userId: string,
  resultado: Record<string, unknown>,
  tentativaEsperada: number,
  retomadaRequestId: string
): Promise<ResultadoLinhaRetomada> {
  const { data, error } = await getSupabaseServidor().rpc("retomada_concluir_tarefa", {
    p_tarefa_id: tarefaId,
    p_user_id: userId,
    p_resultado: resultado ?? {},
    p_tentativa_esperada: tentativaEsperada,
    p_retomada_request_id: retomadaRequestId,
  });

  if (error) {
    console.error("[agentes-retomada] RPC de conclusao de retomada falhou");
    return { ok: false, falha: classificarErro(error) };
  }
  const linha = lerLinhaDeTarefa(data);
  if (linha === null) {
    console.error("[agentes-retomada] conclusao de retomada devolveu linha fora do contrato");
    return { ok: false, falha: "resposta_invalida" };
  }
  return { ok: true, linha };
}

// ─── 5. A tentativa autoritativa do ciclo de retomada ───────────

/**
 * O desfecho da leitura de N.
 *
 * `sem_correspondencia` NAO e erro: significa que nenhuma linha casou
 * as quatro cercas causais. Depois de um inicio confirmado isso quer
 * dizer que o ciclo mudou entre o start e esta leitura — a tarefa
 * terminalizou, saiu de `rodando`, ou o marcador nao e mais este. Quem
 * descobre isso por uma leitura nao tem contexto para decidir nada.
 */
export type ResultadoTentativaRetomada =
  | { readonly ok: true; readonly tentativas: number }
  | { readonly ok: false; readonly falha: "sem_correspondencia" | "indisponivel" };

/**
 * Le a tentativa N da tarefa que ESTA retomada acabou de colocar em
 * `rodando`.
 *
 * ── Por que a lane normal nao serve ────────────────────────
 *
 * `lerTarefaParaExecucao` ganhou `.is("retomada_request_id", null)` no
 * D5-C2-I2-F3: ela e a cerca de ENTRADA da lane normal e, por
 * construcao, nao enxerga tarefa retomada. Usa-la aqui devolveria
 * sempre `null`.
 *
 * ── Quatro cercas, e N e o DADO ───────────────────────────
 *
 *   id                   a tarefa
 *   user_id              o dono
 *   status = 'rodando'   o ciclo esta aberto
 *   retomada_request_id  ESTE ciclo, e nao outro
 *
 * `tentativas` NAO e cerca nesta leitura — e o que se quer descobrir.
 * Ela vira cerca depois, no heartbeat e nos terminalizadores, onde o
 * valor ja e conhecido. Chamar isto de "cinco cercas" confundiria as
 * duas coisas.
 *
 * ── Leitura, e nada alem ────────────────────────────────
 *
 * Uma query, zero escrita, zero retry. Erro do driver nao vira excecao
 * e nao carrega `message`, `details` nem `hint` — so o rotulo.
 */
export async function lerTentativaDaRetomada(
  tarefaId: string,
  userId: string,
  retomadaRequestId: string
): Promise<ResultadoTentativaRetomada> {
  const { data, error } = await getSupabaseServidor()
    .from("agente_tarefas")
    .select("tentativas")
    .eq("id", tarefaId)
    .eq("user_id", userId)
    .eq("status", "rodando")
    .eq("retomada_request_id", retomadaRequestId)
    .maybeSingle();

  if (error) {
    console.error("[agentes-retomada] leitura da tentativa da retomada falhou");
    return { ok: false, falha: "indisponivel" };
  }

  // `maybeSingle` devolve `null` com `error` null quando nao ha linha:
  // ausencia e desfecho normal aqui, nao falha de transporte.
  const bruto = (data as { tentativas?: unknown } | null)?.tentativas;
  if (typeof bruto !== "number" || !Number.isInteger(bruto)) {
    return { ok: false, falha: "sem_correspondencia" };
  }
  return { ok: true, tentativas: bruto };
}

// ─── 6. Prova de vida da retomada ─────────────────────────────────────

/**
 * O desfecho de UM tick de heartbeat. Tres estados, e nenhum deles e
 * causal: heartbeat e sinal de vida, nunca terminalizador.
 *
 * `sem_correspondencia` NAO e erro. Ele significa que as cercas deixaram
 * de casar — a tarefa terminalizou, a tentativa mudou, o marcador mudou,
 * o dono nao bate, ou ela saiu de `rodando`. Qualquer uma dessas e uma
 * MUDANCA DE CICLO, e quem descobre isso por um batimento nao tem
 * contexto para decidir nada a respeito.
 */
export type ResultadoHeartbeatRetomada =
  /** A linha cercada existia e `heartbeat_em` foi renovado. */
  | "renovado"
  /** Nenhuma linha casou as cinco cercas. Observacional, nunca fatal. */
  | "sem_correspondencia"
  /** Erro de transporte/driver, ou resposta fora do formato esperado. */
  | "indisponivel";

/**
 * UM TICK de prova de vida da tarefa em retomada.
 *
 * ── Por que a lane de retomada precisa do seu proprio batimento ─────
 *
 * `registrarProgresso` cerca por `(id, status)` e, desde o D5-C2-I2,
 * tambem exige marcador NULL — ou seja, ela nao alcanca mais uma tarefa
 * retomada, de proposito. As duas lanes ficam disjuntas por construcao:
 * uma exige marcador NULL, a outra exige igualdade com um request nao
 * vazio, e nenhuma linha satisfaz as duas.
 *
 * ── Um TICK, e nao um timer ─────────────────────────────────────────
 *
 * Esta funcao faz UMA escrita e volta. Ela nao cria `setInterval`, nao
 * agenda nada e nao tem retry: o proximo tick E a proxima tentativa, e
 * quem o agenda e a camada de orquestracao — o mesmo desenho da lane
 * normal, onde o timer vive em `executar-tarefa.ts` e a capability so
 * oferece a escrita. Persistence que agenda a si mesma viraria um
 * processo de fundo escondido dentro de um adaptador.
 *
 * ── So `heartbeat_em` ───────────────────────────────────────────────
 *
 * Nenhum outro campo entra no SET. `progresso` nao: a lane de retomada
 * nao alimenta barra, e o CHECK `agente_tarefas_concluido_completo`
 * torna o valor final assunto do terminalizador. Status, resultado e
 * erro pertencem a quem termina o ciclo, nunca a quem prova que ele
 * ainda esta vivo.
 *
 * ── As cinco cercas viajam no WHERE, nunca no SET ───────────────────
 *
 * `user_id` e CERCA, nao dado: como ele so aparece no filtro, este
 * batimento nao tem como trocar o dono de uma tarefa. O mesmo vale para
 * a tentativa e para o marcador.
 */
export async function registrarHeartbeatRetomada(
  tarefaId: string,
  userId: string,
  tentativaEsperada: number,
  retomadaRequestId: string
): Promise<ResultadoHeartbeatRetomada> {
  // `select("id")` NAO e enfeite: sem ele, zero linhas e uma linha
  // voltam iguais, e o chamador nao conseguiria distinguir "renovei" de
  // "o ciclo mudou". `.single()` esta fora de questao — ele ERRA em zero
  // linhas, e aqui zero linhas e desfecho normal.
  const { data, error } = await getSupabaseServidor()
    .from("agente_tarefas")
    .update({ heartbeat_em: new Date().toISOString() })
    .eq("id", tarefaId)
    .eq("user_id", userId)
    .eq("status", "rodando")
    .eq("tentativas", tentativaEsperada)
    .eq("retomada_request_id", retomadaRequestId)
    .select("id");

  if (error) {
    // Erro de banco NAO terminaliza. Se as batidas realmente pararem, a
    // rede ja existe: depois de 5 minutos a recuperacao pode observar.
    console.error("[agentes-retomada] heartbeat de retomada falhou");
    return "indisponivel";
  }
  // FAIL CLOSED: sem erro mas com formato inesperado nao vira sucesso.
  if (!Array.isArray(data)) {
    console.error("[agentes-retomada] heartbeat de retomada devolveu formato inesperado");
    return "indisponivel";
  }
  return data.length > 0 ? "renovado" : "sem_correspondencia";
}
