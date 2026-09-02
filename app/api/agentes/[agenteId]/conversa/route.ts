/**
 * A surface de conversa de um agente — AGENT-VERTICAL-SLICE-V1-I2.
 *
 * ── O que ela e ─────────────────────────────────────────────────────
 *
 *   POST  cria UMA tarefa `conversa` para o agente do dono.
 *   GET   consulta UMA tarefa `conversa` daquele agente.
 *
 * Uma tarefa e uma pergunta e uma resposta. Nao ha thread, historico,
 * `conversationId` nem tabela de mensagens: `agente_tarefas.entrada`
 * guarda `{ mensagem }` e `agente_tarefas.resultado` guarda
 * `{ resposta }`. Se isso for pouco, a decisao vem depois do primeiro
 * teste manual — nao antes dele.
 *
 * ── Por que `[agenteId]` e nao `[id]` ───────────────────────────────
 *
 * O Next nao aceita dois nomes diferentes de parametro no mesmo nivel
 * dinamico, e `app/api/agentes/[agenteId]/diagnostico` ja fixou o nome.
 * Criar `[id]` ao lado seria erro de build, nao preferencia de estilo.
 *
 * ── Ela NAO executa ─────────────────────────────────────────────────
 *
 * Nem o POST nem o GET chamam `executarTarefa`, reivindicam tarefa,
 * fazem retry ou falam com provedor. O POST enfileira e devolve 202; o
 * GET le. Quem executa e o worker, que e camada separada e continua
 * sendo acionado manualmente — nao ha cron neste projeto.
 *
 * ── O que o chamador NAO escolhe ────────────────────────────────────
 *
 * `userId` (vem de `auth.uid`), `agenteId` (vem do segmento da rota),
 * `tipo` (fixado aqui), instrucoes (vem do agente persistido, lidas
 * pelo handler), provedor, modelo, `max_tentativas` e `status`. O corpo
 * aceita exatamente uma chave, e qualquer outra e RECUSADA — ignorar em
 * silencio ensinaria quem chama que o campo existe e nao faz nada.
 */
import { NextResponse } from "next/server";

import { autenticarRequisicao } from "@/lib/autenticacao";
import { provedorRealHabilitado } from "@/lib/agentes/ativacao-ia";
import { criarTarefa, lerAgenteDoDono, lerTarefaDoDono } from "@/lib/agentes/capability";
import { TIPO_CONVERSA } from "@/lib/agentes/handlers/conversa";
// O vocabulario CANONICO de falha. Importado, nunca reescrito: uma
// segunda lista aqui envelheceria em relacao a original no dia em que
// uma categoria nova entrasse.
import { TIPOS_ERRO_TAREFA } from "@/lib/agentes/tipos-execucao";

export const dynamic = "force-dynamic";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A unica chave aceita no corpo do POST.
 *
 * `userId`, `user_id`, `agenteId`, `agente_id`, `tipo`, `instrucoes`,
 * `provider`, `model`, `tools`, `maxTentativas`, `status` e `resultado`
 * caem todos aqui — sao exatamente as chaves que alguem tentaria para
 * trocar de dono, de agente, de comportamento ou de estado.
 */
const CAMPOS_ENTRADA = new Set(["mensagem"]);

function responder(corpo: unknown, status: number): NextResponse {
  return NextResponse.json(corpo, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * O modo de IA CONFIGURADO NESTE INSTANTE — e o nome diz isso de
 * proposito.
 *
 * Ele NAO e proveniencia: nao afirma com que provedor uma tarefa ja
 * executada foi atendida, porque isso nao esta persistido em lugar
 * nenhum. Chamar o campo de `modoExecucao` seria afirmar um fato que
 * nao temos, e e assim que um teste manual com fake vira falso
 * positivo.
 *
 * A autoridade e a funcao canonica de `ativacao-ia.ts`, nunca o texto
 * da resposta: `resposta.includes("[fake]")` serve como segunda
 * indicacao, jamais como fonte.
 */
function modoIaConfiguradoAgora(): "real" | "fake" {
  return provedorRealHabilitado() ? "real" : "fake";
}

/** Le a mensagem do corpo com contrato FECHADO. */
type LeituraCorpo =
  | { ok: true; mensagem: string }
  | { ok: false };

async function mensagemDoCorpo(request: Request): Promise<LeituraCorpo> {
  const texto = await request.text().catch(() => "");
  // Corpo ausente NAO vale como "sem mensagem": `mensagem` e obrigatoria,
  // entao um POST sem corpo e erro do chamador, igual a um corpo vazio.
  if (texto.trim().length === 0) return { ok: false };

  let corpo: unknown;
  try {
    corpo = JSON.parse(texto);
  } catch {
    return { ok: false };
  }

  if (typeof corpo !== "object" || corpo === null || Array.isArray(corpo)) {
    return { ok: false };
  }

  for (const chave of Object.keys(corpo)) {
    if (!CAMPOS_ENTRADA.has(chave)) return { ok: false };
  }

  const { mensagem } = corpo as { mensagem?: unknown };
  if (typeof mensagem !== "string" || mensagem.trim().length === 0) {
    return { ok: false };
  }

  return { ok: true, mensagem: mensagem.trim() };
}

/**
 * Extrai a resposta do `resultado` da tarefa, sem confiar nele.
 *
 * `resultado` e `jsonb` — o banco aceita qualquer forma, e devolver o
 * objeto cru poria na resposta HTTP o que quer que tenha sido gravado.
 * Aqui so a string `resposta` atravessa; chave extra nao e exposta e
 * forma inesperada NAO vira texto (nada de `String(valor)`, que
 * produziria `"[object Object]"` e o apresentaria como fala do agente).
 */
function respostaDoResultado(resultado: unknown): { ok: true; resposta: string } | { ok: false } {
  if (typeof resultado !== "object" || resultado === null || Array.isArray(resultado)) {
    return { ok: false };
  }

  // ── Chaves EXATAS, nao "pelo menos `resposta`" ────────────────────
  //
  // Antes bastava existir uma `resposta` string e o resto era ignorado
  // em silencio. Nada vazava — so `resposta` entra no corpo —, mas
  // aceitar parcialmente um resultado fora do contrato e exatamente o
  // que o handler recusa em `validarRespostaConversa` e o que o POST
  // recusa no corpo. Um `resultado` com chave a mais significa que
  // alguem gravou fora do contrato; a hora de parar e essa, nao a
  // seguinte.
  const chaves = Object.keys(resultado);
  if (chaves.length !== 1 || chaves[0] !== "resposta") return { ok: false };

  const { resposta } = resultado as { resposta?: unknown };
  if (typeof resposta !== "string" || resposta.trim().length === 0) return { ok: false };
  return { ok: true, resposta };
}

/**
 * Projeta `erro_tipo` pelo vocabulario que o CODIGO conhece.
 *
 * ── Por que a projecao existe ───────────────────────────────────────
 *
 * `agente_tarefas.erro_tipo` e `text` SEM CHECK de pertencimento: as
 * constraints da tabela sao `concluido_completo`, `erro_explicado`,
 * `progresso_valido`, `status_valido` e `tipo_nao_vazio` — e
 * `erro_explicado` exige PRESENCA, nao vocabulario. `falhar_tarefa`
 * tambem so recusa nulo e vazio. O fechamento existe apenas em
 * TypeScript, em `classificarErro`, que hoje e o unico escritor.
 *
 * "Hoje" e "unico escritor" nao sao garantias de schema, e esta rota
 * nao deve apresentar como confiavel um valor que o banco nao fecha.
 *
 * Desconhecido vira `null` — nunca outro tipo conhecido, nunca
 * `erro_interno`: mapear para uma categoria existente inventaria uma
 * classificacao que ninguem fez.
 */
function erroTipoConhecido(bruto: unknown): string | null {
  if (typeof bruto !== "string") return null;
  return (TIPOS_ERRO_TAREFA as readonly string[]).includes(bruto) ? bruto : null;
}

export async function POST(request: Request, { params }: { params: { agenteId: string } }) {
  try {
    // 1) Sessao. `motivo` morre aqui: para quem chama, 401 e 401.
    const auth = await autenticarRequisicao(request);
    if (!auth.autenticado) {
      return responder({ ok: false, erro: "Não autenticado." }, 401);
    }

    // 2) O agente vem do SEGMENTO, nunca do corpo.
    const { agenteId } = params;
    if (!UUID_REGEX.test(agenteId)) {
      return responder({ ok: false, erro: "agenteId inválido." }, 400);
    }

    // 3) Corpo antes do banco: payload invalido nao merece uma consulta.
    const corpo = await mensagemDoCorpo(request);
    if (!corpo.ok) {
      return responder({ ok: false, erro: "Entrada inválida." }, 400);
    }

    // 4) O agente precisa ser DO DONO. `auth.uid` e a unica origem do
    //    usuario — nao ha corpo, query, header ou segmento por onde
    //    escolher outro.
    const { linha: agente, erro: erroAgente } = await lerAgenteDoDono(agenteId, auth.uid);
    if (erroAgente) {
      return responder({ ok: false, erro: "Falha ao criar a conversa." }, 500);
    }
    // Inexistente e de-outro-dono terminam IGUAIS. Distinguir os dois
    // transformaria esta rota num oraculo de existencia de agentes
    // alheios.
    if (!agente) {
      return responder({ ok: false, erro: "Agente não encontrado." }, 404);
    }
    // O claim ja recusa tarefa de agente inativo; enfileirar mesmo assim
    // criaria uma tarefa que nunca sairia de `pendente`.
    if (!agente.ativo) {
      return responder({ ok: false, erro: "agente_inativo" }, 409);
    }

    // 5) `tipo` e FIXADO aqui. `max_tentativas` nao viaja: o DEFAULT do
    //    banco continua sendo a fonte unica desse numero.
    const { linha: tarefa, erro: erroTarefa } = await criarTarefa(agenteId, auth.uid, {
      tipo: TIPO_CONVERSA,
      entrada: { mensagem: corpo.mensagem },
    });

    if (erroTarefa === "agente_inexistente_ou_de_outro_dono") {
      // Corrida: o agente existia no passo 4 e sumiu antes do insert. A
      // resposta e a mesma de nao existir — o cliente nao precisa saber
      // que houve uma janela.
      return responder({ ok: false, erro: "Agente não encontrado." }, 404);
    }
    if (erroTarefa || !tarefa) {
      return responder({ ok: false, erro: "Falha ao criar a conversa." }, 500);
    }

    // 202: aceita, ainda nao executada. Um 200 aqui sugeriria que a
    // resposta ja existe — e ela so existira quando o worker rodar.
    return responder(
      {
        ok: true,
        tarefaId: tarefa.id,
        status: tarefa.status,
        modoIaConfiguradoAgora: modoIaConfiguradoAgora(),
      },
      202
    );
  } catch {
    // `autenticarRequisicao` LANCA se `SESSION_SECRET` faltar —
    // indisponibilidade e melhor que autenticar sem verificar. O erro nao
    // e inspecionado nem logado: qualquer detalhe daqui e material de
    // reconhecimento.
    return responder({ ok: false, erro: "Falha ao criar a conversa." }, 500);
  }
}

export async function GET(request: Request, { params }: { params: { agenteId: string } }) {
  try {
    const auth = await autenticarRequisicao(request);
    if (!auth.autenticado) {
      return responder({ ok: false, erro: "Não autenticado." }, 401);
    }

    const { agenteId } = params;
    if (!UUID_REGEX.test(agenteId)) {
      return responder({ ok: false, erro: "agenteId inválido." }, 400);
    }

    const tarefaId = new URL(request.url).searchParams.get("tarefaId") ?? "";
    if (!UUID_REGEX.test(tarefaId)) {
      return responder({ ok: false, erro: "tarefaId inválido." }, 400);
    }

    // Leitura TENANT-SCOPED: `lerTarefaDoDono` filtra por `id` E
    // `user_id`. `lerTarefaParaExecucao` NAO serve aqui — ela e a leitura
    // interna do executor, que nao tem sessao e nao representa fronteira
    // de dono.
    const { linha: tarefa, erro } = await lerTarefaDoDono(tarefaId, auth.uid);
    if (erro) {
      return responder({ ok: false, erro: "Falha ao consultar a conversa." }, 500);
    }

    // As tres recusas abaixo devolvem o MESMO 404, de proposito: tarefa
    // de outro dono, tarefa de outro agente e tarefa de outro tipo sao
    // indistinguiveis de fora. Qualquer diferenca — status, corpo,
    // codigo — viraria um canal para descobrir o que existe.
    if (!tarefa) {
      return responder({ ok: false, erro: "Conversa não encontrada." }, 404);
    }
    if (tarefa.agente_id !== agenteId) {
      return responder({ ok: false, erro: "Conversa não encontrada." }, 404);
    }
    if (tarefa.tipo !== TIPO_CONVERSA) {
      return responder({ ok: false, erro: "Conversa não encontrada." }, 404);
    }

    // So tarefa CONCLUIDA tem resposta. Para pendente, rodando ou
    // falhada, `resposta` e `null` — e isso e uma afirmacao, nao um
    // campo que faltou.
    let resposta: string | null = null;
    if (tarefa.status === "concluido") {
      const extraida = respostaDoResultado(tarefa.resultado);
      if (!extraida.ok) {
        // Concluida sem resultado no contrato e defeito interno. Devolver
        // 200 com `resposta: null` diria "ainda pensando" sobre algo que
        // ja terminou, e expor o objeto cru poria jsonb arbitrario na
        // resposta.
        return responder({ ok: false, erro: "erro_interno" }, 500);
      }
      resposta = extraida.resposta;
    }

    // `erroTipo` sai PROJETADO pelo vocabulario do codigo — o banco NAO
    // o fecha, e a versao anterior deste comentario afirmava o contrario.
    // Valor fora da lista vira `null`, e a string original nao aparece em
    // campo nenhum.
    //
    // `erro_mensagem` NAO sai: ela e `err.message` truncado, e o que cabe
    // ali depende de todo throw de todo handler, presente e futuro. Um
    // dia pode sair, quando houver garantia de origem; hoje seria expor
    // por otimismo.
    return responder(
      {
        ok: true,
        tarefa: {
          id: tarefa.id,
          status: tarefa.status,
          resposta,
          erroTipo: erroTipoConhecido(tarefa.erro_tipo),
        },
        modoIaConfiguradoAgora: modoIaConfiguradoAgora(),
      },
      200
    );
  } catch {
    return responder({ ok: false, erro: "Falha ao consultar a conversa." }, 500);
  }
}
