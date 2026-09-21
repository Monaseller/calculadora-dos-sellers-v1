/**
 * O produtor do polling de perguntas — M2-I1-A7.
 *
 * ── Responsabilidade UNICA ──────────────────────────────────────────
 *
 * Decidir se uma tarefa deve existir, e cria-la quando deve. Nada alem
 * disso.
 *
 * Ele NAO chama `executarFuncao`, NAO chama handler, NAO chama o Mercado
 * Livre, NAO resolve conexao, NAO resolve token e NAO escolhe loja.
 * Quem executa e o worker que ja existe; quem autoriza e o guard; quem
 * escolhe a conta e o binding. Misturar producer e consumer aqui
 * significaria que uma falha na varredura derrubaria a drenagem da fila.
 *
 * ── Elegibilidade e autorizacao sao coisas diferentes ───────────────
 *
 * O filtro daqui e de AGENDAMENTO: "vale a pena enfileirar?". Ele nao
 * substitui `autorizarFuncao`, que roda depois, dentro do executor, sobre
 * o estado REAL da permissao no momento da execucao. Se a permissao
 * mudar entre uma coisa e outra, quem decide e o guard — e e por isso
 * que o tipo tem contrato de retomada.
 *
 * ── Duas camadas de dedupe, e elas nao sao equivalentes ─────────────
 *
 * DURA  — o indice `idx_agente_tarefas_polling_perguntas_ativa`. Atomica,
 *         no banco. Garante no maximo UMA tarefa ativa por agente.
 * MACIA — a janela de 5 minutos, conferida em memoria. Tem corrida, e o
 *         pior caso dela e uma consulta a mais. Ela da o RITMO; ela nao
 *         da garantia.
 *
 * Chamar as duas de "o dedupe" esconderia qual delas se pode confiar sob
 * concorrencia — e a resposta e: so a dura.
 */
import "server-only";

import { criarTarefa } from "@/lib/agentes/capability";
import { TIPO_CONSULTAR_PERGUNTAS_ML } from "@/lib/agentes/handlers/consultar-perguntas-ml-contrato";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";

/** A Funcao cuja permissao torna um agente elegivel. Constante: o
 *  produtor nao aceita "qual Funcao" de lugar nenhum. */
const FUNCAO_ALVO = "mercadolivre.perguntas.listar";

/**
 * O UNICO nivel elegivel.
 *
 * `= "automatico"` e nao `!= "bloqueado"`: o segundo e um predicado
 * ABERTO, e um quarto nivel em `NIVEIS_AUTONOMIA` entraria por omissao.
 * `aprovacao` fica de fora de proposito — enfileirar nesse nivel criaria
 * uma aprovacao que hoje ninguem retoma em producao, e a tarefa viva
 * seguraria o indice, travando as janelas seguintes daquele agente.
 */
const NIVEL_ELEGIVEL = "automatico";

/** Os estados que contam como tarefa VIVA. Mesma lista do predicado do
 *  indice — se as duas divergirem, a releitura deixa de corresponder ao
 *  que o banco recusou. */
export const STATUS_ATIVOS = ["pendente", "rodando", "aguardando_aprovacao"] as const;

/** A janela de cadencia. Nao e a frequencia do cron do worker, que e
 *  outra coisa e roda a cada minuto. */
export const JANELA_MS = 5 * 60 * 1000;

/**
 * Teto da varredura.
 *
 * A Vercel Hobby corta funcao serverless em 60s independentemente do
 * `maxDuration` declarado (divida aberta em `docs/BUGS.md`), entao o
 * produtor NAO pode depender de janela longa. Com teto, uma fila grande
 * atrasa agentes — nao derruba a execucao inteira —, e a proxima janela
 * continua de onde esta: a ordem por `agente_id` e estavel e a camada
 * dura impede duplicar quem ja tem tarefa viva.
 */
export const LIMITE_VARREDURA = 200;

/** O payload, montado campo a campo. Nao ha spread de nada: `userId`,
 *  `agenteId`, `funcaoId`, `lojaId`, `sellerId` e credencial nao tem por
 *  onde entrar. */
export const ENTRADA_POLLING = Object.freeze({
  status: "UNANSWERED",
  limite: 20,
  deslocamento: 0,
});

/** Por que um agente nao gerou tarefa nesta passada. Vocabulario
 *  FECHADO — nenhum destes carrega mensagem, coluna ou valor do driver. */
export type MotivoPulo =
  | "janela_recente"
  | "tarefa_ja_enfileirada"
  | "erro_criacao_tarefa"
  | "agente_indisponivel";

export interface ResultadoPolling {
  readonly criadas: number;
  readonly pulados: Readonly<Record<MotivoPulo, number>>;
  readonly elegiveis: number;
  readonly coleta: "ok" | "falha_leitura";
  /** Quantas consultas a varredura gastou. Para o orcamento das suites. */
  readonly consultas: number;
}

interface Elegivel {
  readonly agenteId: string;
  readonly userId: string;
}

const ZERADO: Readonly<Record<MotivoPulo, number>> = Object.freeze({
  janela_recente: 0,
  tarefa_ja_enfileirada: 0,
  erro_criacao_tarefa: 0,
  agente_indisponivel: 0,
});

const FALHA: ResultadoPolling = Object.freeze({
  criadas: 0,
  pulados: ZERADO,
  elegiveis: 0,
  coleta: "falha_leitura",
  consultas: 0,
});

/**
 * Os agentes elegiveis, em UMA consulta.
 *
 * ── Projecao minima, e ela e deliberada ─────────────────────────────
 *
 * `agente_id, user_id` e mais nada. Sem token, sem refresh, sem
 * `seller_id`, sem loja, sem dado de conexao — o produtor nao precisa de
 * nenhum deles para decidir se uma tarefa deve existir, e uma coluna a
 * mais aqui seria superficie sem contrapartida.
 *
 * ── Varredura CROSS-TENANT, contida neste owner ─────────────────────
 *
 * Todo leitor de `agente_permissoes` fecha por `user_id`, porque todo
 * leitor tem um dono. Este nao tem: ele roda por cron. Em vez de afrouxar
 * um owner existente para aceitar "sem dono" — o que abriria essa porta
 * para qualquer outro chamador —, a varredura global vive aqui, sozinha,
 * com o alvo fixo e a projecao fechada.
 *
 * ── Um JOIN, nao N+1 ────────────────────────────────────────────────
 *
 * `agentes!inner(ativo)` filtra pelo agente ativo dentro da MESMA
 * consulta. Buscar permissoes e depois perguntar por agente seria uma
 * consulta por agente — exatamente o N+1 que este comentario existe para
 * impedir de voltar.
 */
async function lerElegiveis(): Promise<{ linhas: readonly Elegivel[]; erro: boolean }> {
  const { data, error } = await getSupabaseServidor()
    .from("agente_permissoes")
    .select("agente_id, user_id, agentes!inner(ativo)")
    .eq("funcao_id", FUNCAO_ALVO)
    .eq("nivel", NIVEL_ELEGIVEL)
    .eq("agentes.ativo", true)
    .order("agente_id", { ascending: true })
    .limit(LIMITE_VARREDURA);

  if (error) {
    // Sem `error.message`: mensagem de driver vaza nome de coluna, de
    // constraint e as vezes de valor.
    console.error("[poller-perguntas] falha ao ler agentes elegiveis");
    return { linhas: [], erro: true };
  }

  const linhas: Elegivel[] = [];
  for (const bruta of (data ?? []) as Record<string, unknown>[]) {
    const agenteId = bruta.agente_id;
    const userId = bruta.user_id;
    if (typeof agenteId !== "string" || !agenteId) continue;
    if (typeof userId !== "string" || !userId) continue;
    linhas.push({ agenteId, userId });
  }
  return { linhas, erro: false };
}

/**
 * A ultima tarefa de polling de cada agente elegivel, em UMA consulta.
 *
 * Em lote pelo mesmo motivo da anterior: perguntar por agente seria N+1,
 * e o custo cresceria com a base em vez de com a janela. O recorte por
 * `tipo` e por `agente_id IN (...)` e o que mantem a leitura barata.
 */
async function lerUltimas(
  agenteIds: readonly string[]
): Promise<{ porAgente: Map<string, { criadoEm: number; ativa: boolean }>; erro: boolean }> {
  const porAgente = new Map<string, { criadoEm: number; ativa: boolean }>();
  if (agenteIds.length === 0) return { porAgente, erro: false };

  const { data, error } = await getSupabaseServidor()
    .from("agente_tarefas")
    .select("agente_id, status, criado_em")
    .eq("tipo", TIPO_CONSULTAR_PERGUNTAS_ML)
    .in("agente_id", [...agenteIds])
    .order("criado_em", { ascending: false });

  if (error) {
    console.error("[poller-perguntas] falha ao ler tarefas recentes");
    return { porAgente, erro: true };
  }

  for (const bruta of (data ?? []) as Record<string, unknown>[]) {
    const agenteId = bruta.agente_id;
    if (typeof agenteId !== "string" || !agenteId) continue;
    // A ordem e decrescente, entao a PRIMEIRA vista e a mais recente.
    if (porAgente.has(agenteId)) continue;
    const criadoEm = Date.parse(String(bruta.criado_em ?? ""));
    porAgente.set(agenteId, {
      criadoEm: Number.isFinite(criadoEm) ? criadoEm : 0,
      ativa: (STATUS_ATIVOS as readonly string[]).includes(String(bruta.status ?? "")),
    });
  }
  return { porAgente, erro: false };
}

/**
 * Confirma se o `23505` veio do indice do polling.
 *
 * ── Por RELEITURA, nunca por parsing ────────────────────────────────
 *
 * O nome do indice so apareceria dentro de `message`, e extrai-lo de la
 * seria depender do texto do driver. O caminho seguro ja existe no
 * repositorio (`lib/marketplace/credenciais.ts`): relemos o PREDICADO do
 * indice e concluimos pela linha, nao pela frase.
 *
 * Linha ativa encontrada  -> a violacao e a nossa: ja havia tarefa.
 * Nenhuma linha           -> veio de OUTRO indice. Falha fechada.
 */
async function confirmarJaEnfileirada(agenteId: string): Promise<boolean> {
  const { data, error } = await getSupabaseServidor()
    .from("agente_tarefas")
    .select("id")
    .eq("agente_id", agenteId)
    .eq("tipo", TIPO_CONSULTAR_PERGUNTAS_ML)
    .in("status", [...STATUS_ATIVOS])
    .limit(1);

  if (error) {
    console.error("[poller-perguntas] falha ao confirmar tarefa ativa");
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

/**
 * Uma passada do produtor.
 *
 * `agoraMs` entra por parametro para que a janela seja provavel sem
 * relogio de sistema — mesma razao de `agoraMs` no agregador de conexoes.
 */
export async function enfileirarPollingDePerguntas(
  agoraMs: number
): Promise<ResultadoPolling> {
  const elegiveis = await lerElegiveis();
  if (elegiveis.erro) return FALHA;

  const ultimas = await lerUltimas(elegiveis.linhas.map((e) => e.agenteId));
  if (ultimas.erro) return FALHA;

  const pulados: Record<MotivoPulo, number> = { ...ZERADO };
  let criadas = 0;
  let consultas = 2;

  for (const alvo of elegiveis.linhas) {
    const ultima = ultimas.porAgente.get(alvo.agenteId);

    // Camada MACIA. Tarefa viva ou janela nao vencida: nao ha o que
    // enfileirar. A viva conta como `tarefa_ja_enfileirada` porque e
    // exatamente isso — e nao "cedo demais".
    if (ultima !== undefined) {
      if (ultima.ativa) {
        pulados.tarefa_ja_enfileirada++;
        continue;
      }
      if (agoraMs - ultima.criadoEm < JANELA_MS) {
        pulados.janela_recente++;
        continue;
      }
    }

    const { linha, erro } = await criarTarefa(alvo.agenteId, alvo.userId, {
      tipo: TIPO_CONSULTAR_PERGUNTAS_ML,
      // Campo a campo, a partir da constante congelada. Nunca spread.
      entrada: {
        status: ENTRADA_POLLING.status,
        limite: ENTRADA_POLLING.limite,
        deslocamento: ENTRADA_POLLING.deslocamento,
      },
    });
    consultas++;

    if (erro === null && linha !== null) {
      criadas++;
      continue;
    }

    // Camada DURA. Outro produtor ganhou a corrida entre a leitura acima
    // e este insert — que e precisamente o caso que a leitura nao podia
    // cobrir.
    if (erro === "conflito_unico") {
      const ativa = await confirmarJaEnfileirada(alvo.agenteId);
      consultas++;
      if (ativa) {
        pulados.tarefa_ja_enfileirada++;
      } else {
        // 23505 sem linha ativa correspondente: veio de outro indice.
        // Falha fechada — NUNCA `tarefa_ja_enfileirada`.
        pulados.erro_criacao_tarefa++;
      }
      continue;
    }

    // Agente apagado ou trocado de dono entre a varredura e o insert.
    if (erro === "agente_inexistente_ou_de_outro_dono") {
      pulados.agente_indisponivel++;
      continue;
    }

    pulados.erro_criacao_tarefa++;
  }

  return {
    criadas,
    pulados: Object.freeze(pulados),
    elegiveis: elegiveis.linhas.length,
    coleta: "ok",
    consultas,
  };
}
