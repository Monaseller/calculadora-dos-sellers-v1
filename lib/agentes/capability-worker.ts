/**
 * Capability INTERNA DO WORKER — AGENTES-FASE1C.
 *
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  ESTE ARQUIVO NAO FILTRA POR `user_id`. E DELIBERADO.            ║
 * ║  Leia a secao abaixo antes de copiar qualquer coisa daqui.       ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * ── Por que existe separado de `capability.ts` ──────────────────────
 * `lib/agentes/capability.ts` (FASE 1B) e a capability DO USUARIO:
 * TODA operacao dela carrega `user_id` na propria instrucao, e essa
 * invariante e provada assert por assert pela suite da 1B.
 *
 * As operacoes daqui NAO podem carregar `user_id`, porque o worker
 * NAO TEM SESSAO. Ele processa uma fila cross-tenant: reivindica a
 * proxima tarefa de quem quer que seja e a executa.
 *
 * Misturar as duas naturezas no mesmo arquivo destruiria a coisa mais
 * valiosa que a 1B produziu — a leitura "toda funcao deste arquivo tem
 * `user_id`" deixaria de ser verdadeira, e a suite teria de ser
 * afrouxada para acomodar as excecoes. Uma invariante com excecoes
 * documentadas nao e uma invariante; e um costume.
 *
 * Entao: dois arquivos, duas regras, cada uma verdadeira inteira.
 * `capability.ts` NAO FOI ALTERADO por esta fase.
 *
 * ── O que impede isto de virar um buraco de isolamento ──────────────
 * Nao filtrar por dono nao e o mesmo que ignorar o dono.
 *
 *  1. O CLAIM decide sozinho, no banco, qual tarefa sai. Nenhum
 *     chamador escolhe `tarefaId`; ele RECEBE um. Nao ha parametro
 *     pelo qual pedir "a tarefa do usuario X".
 *  2. A tarefa reivindicada CARREGA `user_id` e `agente_id`, e a FK
 *     composta da 1B ja garantiu, no banco, que o par e coerente. O
 *     worker nao escolhe dono — ele le o que o banco validou.
 *  3. O handler recebe `ContextoTarefa`, NUNCA um `SupabaseClient`.
 *     Mesmo sabendo o `userId`, ele nao tem por onde alcancar dado
 *     alheio.
 *  4. As transicoes de estado sao RPCs que recebem SO o `id` da
 *     tarefa. Nenhuma delas aceita `user_id` do chamador — a mesma
 *     regra da rota interna do Estudio.
 *  5. Este modulo e `server-only` e so e importado pela rota interna,
 *     que exige `AGENTES_WORKER_INTERNAL_SECRET`.
 *
 * ── `import "server-only"` ──────────────────────────────────────────
 * Primeira instrucao, barreira de COMPILACAO. Se um Client Component
 * importar isto, o BUILD quebra em vez de embarcar a service_role no
 * bundle do browser.
 */
import "server-only";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import type { LinhaTarefa } from "@/lib/agentes/tipos";

/** Mesma projecao fechada da capability de usuario. Nunca `*`. */
const COLUNAS_TAREFA =
  "id, agente_id, user_id, tipo, entrada, status, progresso, resultado, erro_tipo, " +
  "erro_mensagem, tentativas, max_tentativas, criado_em, iniciado_em, concluido_em, heartbeat_em";

export interface ResultadoTarefaInterna {
  linha: LinhaTarefa | null;
  erro: string | null;
}

/**
 * Le UMA tarefa por id, SEM filtro de dono.
 *
 * ── JUSTIFICATIVA DA AUSENCIA DE `user_id` ──────────────────────────
 * Esta e a operacao mais sensivel do arquivo, entao a justificativa e
 * explicita: o worker acabou de receber este `tarefaId` do CLAIM, que
 * roda no banco e escolhe a tarefa sozinho. Nao existe caminho pelo
 * qual um chamador externo proponha um id — a rota interna que chega
 * aqui exige o segredo do worker e o id vem do proprio ciclo.
 *
 * Exigir `user_id` aqui seria teatro: o unico `user_id` disponivel
 * seria o da propria linha que se quer ler, isto e, o filtro se
 * verificaria contra si mesmo.
 *
 * O que de fato protege e o item 1 da lista no cabecalho: o chamador
 * nao escolhe a tarefa.
 */
export async function lerTarefaParaExecucao(
  tarefaId: string
): Promise<ResultadoTarefaInterna> {
  if (!tarefaId) return { linha: null, erro: "tarefa_id_ausente" };

  const { data, error } = await getSupabaseServidor()
    .from("agente_tarefas")
    .select(COLUNAS_TAREFA)
    .eq("id", tarefaId)
    .maybeSingle();

  if (error) {
    console.error("[agentes-interno] falha ao ler tarefa para execucao");
    return { linha: null, erro: "erro_consulta_tarefa" };
  }
  return { linha: (data as LinhaTarefa | null) ?? null, erro: null };
}

/**
 * Heartbeat + progresso em UMA escrita.
 *
 * ── Por que NAO e uma RPC ───────────────────────────────────────────
 * Porque nao decide nada. Nao ha transicao de estado, nao ha corrida,
 * nao ha invariante a manter sob concorrencia — e um `UPDATE` de duas
 * colunas. RPC existe para transicao atomica; usar uma aqui seria
 * cerimonia, e mais uma funcao a revogar de `anon`.
 *
 * ── Por que as duas colunas juntas ──────────────────────────────────
 * O worker JA precisa escrever `heartbeat_em` periodicamente, senao o
 * claim consideraria a tarefa orfa. Levar `progresso` de carona custa
 * zero round-trips a mais. Foi assim que o progresso saiu de graca, em
 * vez de virar quatro `UPDATE`s so para alimentar uma barra.
 *
 * `.eq("status", "rodando")` NAO e redundante: se a tarefa ja terminou
 * (ou foi reivindicada por outro worker apos uma orfandade), este
 * heartbeat nao pode ressuscitar `progresso` sobre um estado terminal.
 * Zero linhas afetadas e o resultado correto — e por isso a funcao nao
 * trata "nenhuma linha" como erro.
 */
export async function registrarProgresso(
  tarefaId: string,
  progresso: number
): Promise<{ erro: string | null }> {
  if (!tarefaId) return { erro: "tarefa_id_ausente" };

  const valor = Math.trunc(Number(progresso));
  if (!Number.isFinite(valor) || valor < 0 || valor > 100) {
    return { erro: "progresso_invalido" };
  }

  const { error } = await getSupabaseServidor()
    .from("agente_tarefas")
    .update({ progresso: valor, heartbeat_em: new Date().toISOString() })
    .eq("id", tarefaId)
    .eq("status", "rodando");

  if (error) {
    // Heartbeat perdido nao derruba a execucao: o handler continua e a
    // tarefa so viraria orfa depois de 5 minutos sem nenhum sucesso.
    console.error("[agentes-interno] falha ao registrar progresso");
    return { erro: "erro_registro_progresso" };
  }
  return { erro: null };
}

/**
 * Conclui a tarefa. Chama a RPC — NUNCA um `UPDATE` direto.
 *
 * A RPC e a unica autoridade sobre a transicao: ela exige
 * `status = 'rodando'`, forca `progresso = 100`, limpa o erro da
 * tentativa anterior e LANCA se a tarefa nao estiver no estado certo.
 * Um `UPDATE` aqui poderia concluir uma tarefa que outro worker ja
 * reivindicou.
 */
export async function concluirTarefa(
  tarefaId: string,
  resultado: Record<string, unknown>
): Promise<ResultadoTarefaInterna> {
  if (!tarefaId) return { linha: null, erro: "tarefa_id_ausente" };

  const { data, error } = await getSupabaseServidor().rpc("concluir_tarefa", {
    p_tarefa_id: tarefaId,
    p_resultado: resultado ?? {},
  });

  if (error) {
    console.error("[agentes-interno] RPC concluir_tarefa falhou");
    return { linha: null, erro: "erro_concluir_tarefa" };
  }
  return { linha: (normalizarLinha(data) as LinhaTarefa | null) ?? null, erro: null };
}

/**
 * Registra falha. A RPC decide entre devolver a tarefa a fila
 * (`pendente`, se ainda ha tentativa) e encerra-la (`erro`). Essa
 * decisao NAO e do TypeScript: ela le `tentativas`/`max_tentativas` na
 * mesma transacao em que escreve.
 */
export async function falharTarefa(
  tarefaId: string,
  erroTipo: string,
  erroMensagem: string
): Promise<ResultadoTarefaInterna> {
  if (!tarefaId) return { linha: null, erro: "tarefa_id_ausente" };

  const { data, error } = await getSupabaseServidor().rpc("falhar_tarefa", {
    p_tarefa_id: tarefaId,
    p_erro_tipo: erroTipo,
    // Truncado tambem aqui, alem do `left(...,500)` da RPC: mensagem de
    // excecao pode carregar trecho de dado, e o caminho mais curto ate
    // o banco e o melhor lugar para cortar.
    p_erro_mensagem: (erroMensagem ?? "").slice(0, 300),
  });

  if (error) {
    console.error("[agentes-interno] RPC falhar_tarefa falhou");
    return { linha: null, erro: "erro_falhar_tarefa" };
  }
  return { linha: (normalizarLinha(data) as LinhaTarefa | null) ?? null, erro: null };
}

/**
 * As RPCs devolvem `RETURNS public.agente_tarefas`. O PostgREST entrega
 * isso ora como objeto, ora como array de um elemento, dependendo da
 * versao — normalizar aqui evita que cada chamador descubra isso
 * sozinho, em producao.
 */
function normalizarLinha(data: unknown): unknown {
  if (Array.isArray(data)) return data.length > 0 ? data[0] : null;
  return data ?? null;
}
