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
import { normalizarLinha } from "@/lib/agentes/normalizar-linha";
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
  resultado: Record<string, unknown>,
  tentativaEsperada: number
): Promise<ResultadoTarefaInterna> {
  if (!tarefaId) return { linha: null, erro: "tarefa_id_ausente" };

  const { data, error } = await getSupabaseServidor().rpc("concluir_tarefa", {
    p_tarefa_id: tarefaId,
    p_resultado: resultado ?? {},
    // APPROVAL-DECISION-RESUME-B0: a tentativa viaja para que a RPC
    // recuse um executor atrasado. Vem de quem leu a linha apos o
    // claim — este wrapper nao a calcula nem a adivinha.
    p_tentativa_esperada: tentativaEsperada,
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
  erroMensagem: string,
  tentativaEsperada: number
): Promise<ResultadoTarefaInterna> {
  if (!tarefaId) return { linha: null, erro: "tarefa_id_ausente" };

  const { data, error } = await getSupabaseServidor().rpc("falhar_tarefa", {
    p_tarefa_id: tarefaId,
    p_erro_tipo: erroTipo,
    // Mesmo fence da irma: sem ele, um executor velho leria
    // `tentativas` da tentativa alheia e escolheria o desfecho dela.
    p_tentativa_esperada: tentativaEsperada,
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
 * Estaciona a tarefa em `aguardando_aprovacao`. Chama a RPC — NUNCA um
 * `UPDATE` direto, pelo mesmo motivo das duas irmas acima.
 *
 * ── Por que `tentativaEsperada`, e por que ela e obrigatoria ────────
 *
 * `status = 'rodando'` NAO e fencing. O `claim_next_agente_tarefa`
 * recupera tarefa orfa com `rodando -> rodando` direto — ela nunca
 * passa por `pendente` — e incrementa `tentativas` no caminho. Sem esta
 * comparacao, um worker da tentativa 1, atrasado alem dos 5 minutos de
 * heartbeat, pausaria a execucao que a tentativa 2 ja esta rodando.
 *
 * `tentativas` serve como fencing token porque so muda no claim: as
 * RPCs terminais nunca a escrevem, e ela permanece constante durante
 * uma execucao inteira.
 *
 * ── A lista de parametros e a defesa ────────────────────────────────
 *
 * Nao entram `userId`, `agenteId`, `status`, `heartbeat`, `nivel`,
 * `erro` nem `resultado`. A LINHA e a autoridade sobre todos eles, e
 * aceitar qualquer um de fora seria deixar o chamador descrever o
 * estado que a RPC deveria verificar.
 *
 * ── Por que `aprovacaoId` E uma excecao legitima ────────────────────
 *
 * Ate a APPROVAL-DECISION-RESUME-D1 ele tambem ficava de fora, e o
 * vinculo com a aprovacao vivia so em
 * `agente_funcao_aprovacoes.tarefa_id`. Aquele caminho nao IDENTIFICA:
 * o unico indice unico sobre estado ativo e `(user_id, fingerprint)`, e
 * fingerprint descreve uma ACAO — duas aprovacoes ativas para a mesma
 * tarefa sao possiveis. Localizar "a aprovacao da tarefa" por
 * `tarefa_id` seria escolher deterministicamente, nao causalmente.
 *
 * O id que entra aqui nao e descricao de estado: e o retorno do proprio
 * executor de Funcao que acabou de criar ou reutilizar a aprovacao,
 * carregado por `PausaPorAprovacao`. E a RPC NAO confia nele — revalida
 * dono, agente, pertencimento a esta tarefa e estado ativo, tudo no
 * mesmo `UPDATE`. Passar o id e dar a ela o que conferir, nao afirmar
 * nada por ela.
 */
export async function aguardarAprovacaoTarefa(
  tarefaId: string,
  tentativaEsperada: number,
  aprovacaoId: string
): Promise<ResultadoTarefaInterna> {
  if (!tarefaId) return { linha: null, erro: "tarefa_id_ausente" };
  // Mesma doutrina das irmas: recusa local do que nao identifica nada,
  // sem reimplementar a validacao que a RPC ja faz. Uma tentativa nao
  // inteira ou <= 0 nao pode ter vindo do claim.
  if (!Number.isInteger(tentativaEsperada) || tentativaEsperada <= 0) {
    return { linha: null, erro: "tentativa_esperada_invalida" };
  }
  // O terceiro parametro ganha a MESMA recusa local que os outros dois.
  // A RPC ja e fail-closed para id ausente (22023), mas deixar o unico
  // parametro sem guarda local seria assimetria sem motivo — e o erro
  // nomeado aqui diz o que faltou, enquanto o do driver nao sai daqui.
  if (!aprovacaoId) return { linha: null, erro: "aprovacao_id_ausente" };

  const { data, error } = await getSupabaseServidor().rpc("aguardar_aprovacao_tarefa", {
    p_tarefa_id: tarefaId,
    p_tentativa_esperada: tentativaEsperada,
    p_aprovacao_id: aprovacaoId,
  });

  if (error) {
    // `message` nunca sai daqui: o erro do driver carrega nome de
    // coluna, de constraint e as vezes de VALOR.
    console.error("[agentes-interno] RPC aguardar_aprovacao_tarefa falhou");
    return { linha: null, erro: "erro_aguardar_aprovacao" };
  }
  return { linha: (normalizarLinha(data) as LinhaTarefa | null) ?? null, erro: null };
}

// `normalizarLinha` saiu daqui para `lib/agentes/normalizar-linha.ts`,
// sem alteracao de comportamento: a lane de retomada precisa da MESMA
// normalizacao de linha composta, e duas copias teriam de concordar
// para sempre. Este modulo continua sendo o unico consumidor de
// producao dela hoje — o import a traz de volta sem reexporta-la.

// ─── O claim, para o dispatcher de sistema ────────────────────────────

/** O que o dispatcher precisa saber sobre a tarefa reivindicada: o id.
 *  Nada mais sai daqui — ver o docblock de `reivindicarProximaTarefa`. */
export interface TarefaReivindicadaMinima {
  tarefaId: string;
}

/**
 * A forma de um UUID. Mesma do resto do repositorio — a rota interna e a
 * de conversa ja usam esta constante em suas proprias copias.
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reivindica a PROXIMA tarefa elegivel da fila — FUNCTION-RUNTIME-V1-B1.
 *
 * ── Fronteira: isto pertence ao DISPATCHER DE SISTEMA ────────────────
 *
 * `claim_next_agente_tarefa()` e GLOBAL: varre `agente_tarefas` inteira
 * e devolve a elegivel MAIS ANTIGA, de QUALQUER dono. Ser global e
 * defeito quando o gatilho e um usuario — o clique de alguem
 * reivindicaria a tarefa de outro. E e a propriedade CORRETA quando o
 * gatilho e o sistema: um dispatcher deve drenar a fila na ordem de
 * chegada, sem privilegiar quem clicou por ultimo.
 *
 * Por isso este wrapper NUNCA pode ser alcancado por rota de usuario.
 * Ele existe para `app/api/internal/agentes/worker`, que so responde a
 * `Authorization: Bearer ${CRON_SECRET}`. Nao ha transporte em
 * `lib/ia/` e nenhuma UI o conhece.
 *
 * ── Por que so o `tarefaId` sai daqui ────────────────────────────────
 *
 * O chamador precisa de um id para passar a `executarTarefa`, e de mais
 * nada. A linha reivindicada carrega `user_id`, `agente_id` e `entrada`
 * — dado de um dono qualquer — e leva-los ate a rota so criaria a
 * tentacao de loga-los ou devolve-los na resposta HTTP. O tenant e
 * resolvido adiante, por `executarTarefa`, que le a LINHA de novo.
 *
 * ── Sem parametro algum ──────────────────────────────────────────────
 *
 * A RPC nao aceita `user_id` nem `tarefa_id`, e este wrapper tambem
 * nao. Nao existe assinatura pela qual alguem peca "a tarefa do usuario
 * X" ou "aquela tarefa ali".
 */
export async function reivindicarProximaTarefa(): Promise<{
  tarefa: TarefaReivindicadaMinima | null;
  erro: string | null;
}> {
  const { data, error } = await getSupabaseServidor().rpc("claim_next_agente_tarefa");

  if (error) {
    // `message` nunca sai daqui: o erro do driver carrega nome de
    // coluna, de constraint e as vezes de VALOR.
    console.error("[agentes-interno] RPC claim_next_agente_tarefa falhou");
    return { tarefa: null, erro: "erro_claim_tarefa" };
  }

  // Fila vazia. `RETURNS public.agente_tarefas` com `RETURN NULL` chega
  // pelo PostgREST como objeto composto de colunas nulas — truthy em
  // JavaScript. A verdade esta no `id`, nunca no invólucro; e o MESMO
  // criterio que `scripts/agentes-worker.mjs` aplica em producao.
  const linha = normalizarLinha(data) as { id?: unknown } | null;
  if (linha === null || typeof linha !== "object") return { tarefa: null, erro: null };

  const id = linha.id;
  if (id === null || id === undefined) return { tarefa: null, erro: null };

  // Reivindicou algo que nao tem a forma de um id: fail-closed. Nao
  // adianta seguir para `executarTarefa` com lixo, e devolver a linha
  // crua para alguem inspecionar seria vazar dado de outro dono.
  if (typeof id !== "string" || !UUID_REGEX.test(id)) {
    console.error("[agentes-interno] claim devolveu linha sem id valido");
    return { tarefa: null, erro: "claim_shape_invalido" };
  }

  return { tarefa: { tarefaId: id }, erro: null };
}
