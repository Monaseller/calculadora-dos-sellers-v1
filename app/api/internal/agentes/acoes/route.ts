/**
 * POST /api/internal/agentes/acoes — M2-I1-A8.
 *
 * A porta por onde um ORQUESTRADOR EXTERNO pede uma acao de produto.
 *
 * ── O que ela e, e o que ela nao e ──────────────────────────────────
 *
 * Ela traduz e delega. Autentica o servico, le um corpo FECHADO, resolve
 * o DONO a partir do agente, traduz a acao em Funcao pelo catalogo e
 * chama `executarFuncao`. Tudo o que decide autorizacao — permissao,
 * binding, cobertura remota, guard — continua acontecendo la dentro, sem
 * atalho e sem copia.
 *
 * Ela NAO chama o handler da Funcao, NAO chama o adapter do marketplace,
 * NAO resolve credencial, NAO escolhe loja e NAO cria tarefa.
 *
 * ── O que o chamador NAO pode dizer ─────────────────────────────────
 *
 * `funcaoId`, `userId`, `lojaId`, `sellerId`, token, permissao, nivel,
 * `requestId` e `idempotencyKey`. Nenhum deles e ignorado em silencio: o
 * corpo e fechado, e chave desconhecida recusa com 400. Aceitar e
 * ignorar ensinaria o cliente a mandar, e um dia alguem leria.
 *
 * O chamador diz O QUE quer (`acao`), para QUAL agente, com quais
 * argumentos de dominio, qual e a execucao dele (`executionId`) e qual e
 * a INTENCAO dele (`operationId`). O resto e do CDS.
 *
 * ── `executionId` e `operationId` sao coisas diferentes — M2-I1-A8B ──
 *
 * `executionId` identifica UMA execucao do orquestrador. Serve para
 * correlacionar, e muda a cada disparo.
 *
 * `operationId` identifica a INTENCAO. Quem orquestra promete mante-lo
 * estavel enquanto o pedido for o mesmo — um retry de transporte repete
 * o `operationId` e ganha `executionId` novo — e troca-lo quando for
 * outro pedido. E dele, e so dele, que a chave de idempotencia e
 * derivada. Nenhum dos dois e aceito como `idempotencyKey` pronta: a
 * chave final continua sendo montada no servidor.
 *
 * ── SINCRONA, sem tarefa ────────────────────────────────────────────
 *
 * Quem orquestra e quem espera. Esta rota nao enfileira, nao bate
 * heartbeat e nao faz fencing — esses mecanismos pertencem ao motor de
 * tarefas, e esta ponte deliberadamente nao passa por ele.
 *
 * ── Aprovacao TERMINA aqui, nesta versao ────────────────────────────
 *
 * Se o guard pedir aprovacao, a resposta diz isso e a chamada acaba. Nao
 * ha retomada automatica, nao ha callback e nao ha polling de decisao. O
 * orquestrador recebe o estado real e decide o que fazer com ele.
 */
import { NextResponse } from "next/server";

import {
  chaveDeIdempotencia,
  resolverAcao,
  type ContratoDeAcao,
} from "@/lib/agentes/acoes/catalogo";
import { lerAgenteParaAcaoInterna } from "@/lib/agentes/capability-worker";
import { executarFuncao } from "@/lib/agentes/execucao-funcoes/executar";

/**
 * O provedor desta ponte, no namespace de idempotencia.
 *
 * Constante: a rota nao aceita "de quem sou" do pedido. Um segundo
 * orquestrador, se existir, ganha rota e prefixo proprios.
 */
const PROVEDOR = "n8n";

/**
 * Teto do `executionId`.
 *
 * Mesmo numero e mesma razao de `LIMITE_EXECUTION_ID` em
 * `lib/agentes/chamadas/contrato.ts`: "um valor absurdamente longo e
 * sinal de que algo errado esta sendo ecoado para dentro".
 *
 * Reproduzido, e nao importado, de proposito: aquela constante e do
 * contrato de ENVELOPE, que descreve o que o executor devolve. Importa-la
 * aqui criaria uma dependencia entre a porta de entrada e a forma da
 * saida, e as duas passariam a ter de mudar juntas sem motivo.
 */
const LIMITE_EXECUTION_ID = 128;

/**
 * Teto do `operationId`.
 *
 * Mesmo numero e mesma razao do `executionId`: um valor absurdamente
 * longo e sinal de que algo errado esta sendo ecoado para dentro.
 */
const LIMITE_OPERATION_ID = 128;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** As CINCO chaves aceitas, e nenhuma outra. */
const CHAVES_DO_CORPO = [
  "acao",
  "agenteId",
  "argumentos",
  "executionId",
  "operationId",
] as const;

function responder(corpo: unknown, status: number): NextResponse {
  return NextResponse.json(corpo, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

type LeituraCorpo =
  | {
      ok: true;
      acao: string;
      agenteId: string;
      executionId: string;
      operationId: string;
      argumentos: Record<string, unknown>;
    }
  | { ok: false };

/**
 * As chaves de `argumentos` sao as da ACAO, e so elas.
 *
 * Fechado nos dois sentidos, e por ACAO — nunca pela uniao das acoes.
 * Uma lista global deixaria `dataInicio` passar em `consultar_perguntas`
 * so porque vendas precisa dela, e seria por essa fresta que um campo de
 * outra Funcao entraria sem ninguem notar.
 *
 * O que vale aqui e QUAIS chaves viajam. Se o VALOR serve — data no
 * calendario, janela de 14 dias, status conhecido — quem decide e o
 * validador da Funcao, e a resposta dele vira `entrada_invalida`, nao 400.
 */
function argumentosAceitos(
  contrato: ContratoDeAcao,
  argumentos: Record<string, unknown>
): boolean {
  for (const chave of Object.keys(argumentos)) {
    if (!contrato.argumentos.includes(chave)) return false;
  }
  return true;
}

/**
 * Le e valida a FORMA do corpo. Nao valida acao, agente nem argumento de
 * dominio — isso e autoridade de camadas abaixo, e acontece depois.
 *
 * Fechado nos dois sentidos: falta chave, sobra chave, ou tipo errado, e
 * 400. As CHAVES de `argumentos` nao sao conferidas aqui: elas dependem
 * da acao, que so e resolvida depois. `argumentos` ainda precisa ser um
 * objeto simples — e e por ele que `lojaId` seria tentado.
 */
async function lerCorpo(request: Request): Promise<LeituraCorpo> {
  let bruto: unknown;
  try {
    bruto = await request.json();
  } catch {
    return { ok: false };
  }

  if (typeof bruto !== "object" || bruto === null || Array.isArray(bruto)) {
    return { ok: false };
  }

  const o = bruto as Record<string, unknown>;
  const chaves = Object.keys(o).sort();
  if (JSON.stringify(chaves) !== JSON.stringify([...CHAVES_DO_CORPO])) {
    return { ok: false };
  }

  if (typeof o.acao !== "string" || o.acao.length === 0) return { ok: false };
  if (typeof o.agenteId !== "string" || !UUID_REGEX.test(o.agenteId)) return { ok: false };

  const executionId = o.executionId;
  if (typeof executionId !== "string") return { ok: false };
  if (executionId.length === 0 || executionId.length > LIMITE_EXECUTION_ID) {
    return { ok: false };
  }

  // ── `operationId`: a identidade da INTENCAO ─────────────────────────
  //
  // Recusa espaco nas pontas em vez de aparar. Aparar faria `" OP-A"` e
  // `"OP-A"` virarem a MESMA chave em silencio, e quem mandasse o
  // primeiro acharia que mandou o segundo. Duas grafias de uma chave de
  // idempotencia e exatamente o defeito que ela existe para nao ter.
  const operationId = o.operationId;
  if (typeof operationId !== "string") return { ok: false };
  if (operationId !== operationId.trim()) return { ok: false };
  if (operationId.length === 0 || operationId.length > LIMITE_OPERATION_ID) {
    return { ok: false };
  }

  const argumentos = o.argumentos;
  if (typeof argumentos !== "object" || argumentos === null || Array.isArray(argumentos)) {
    return { ok: false };
  }

  return {
    ok: true,
    acao: o.acao,
    agenteId: o.agenteId,
    executionId,
    operationId,
    // Copia campo a campo: ausente continua AUSENTE. Preencher com `null`
    // mandaria a Funcao recusar um valor que ninguem pediu.
    argumentos: { ...(argumentos as Record<string, unknown>) },
  };
}

/**
 * Traduz o desfecho do executor na resposta da ponte.
 *
 * ── `already_processed` nasce AQUI, nao no executor ─────────────────
 *
 * O executor devolve `falha_auditoria` com `motivo: "duplicada"` — um
 * fato sobre o REGISTRO. O significado de produto disso ("essa execucao
 * ja foi processada") e desta camada, que e a unica que sabe o que o
 * `executionId` quis dizer.
 *
 * ── `requestId` no replay e `null`, e isso e deliberado ─────────────
 *
 * O `request_id` da abertura ORIGINAL nao volta no conflito: o insert nao
 * tem `select` e o retorno de duplicidade nao carrega linha. Gerar um id
 * novo aqui o faria passar por original numa superficie que existe
 * exatamente para nao mentir. Quem orquestra ja guardou o da primeira
 * resposta.
 */
function mapear(resultado: Awaited<ReturnType<typeof executarFuncao>>): {
  corpo: Record<string, unknown>;
  status: number;
} {
  switch (resultado.tipo) {
    case "sucesso":
      return {
        corpo: {
          ok: true,
          estado: "executada",
          requestId: resultado.requestId,
          resultado: resultado.envelope.data,
        },
        status: 200,
      };

    case "aguardando_aprovacao":
      return {
        corpo: {
          ok: true,
          estado: "aguardando_aprovacao",
          requestId: resultado.requestId,
          aprovacaoId: resultado.aprovacaoId,
          estadoAprovacao: resultado.estadoAprovacao,
        },
        status: 200,
      };

    case "negado":
      return {
        corpo: { ok: false, estado: "negado", requestId: resultado.requestId, codigo: resultado.codigo },
        status: 200,
      };

    case "erro":
      return {
        corpo: {
          ok: false,
          estado: "erro",
          requestId: resultado.requestId,
          // So o CODIGO. `message` do envelope nao viaja: o adapter ja
          // descartou corpo, header e status do provider, e repetir a
          // frase aqui nao acrescenta fato nenhum.
          codigo: resultado.envelope.error.code,
        },
        status: 200,
      };

    case "falha_auditoria":
      if (resultado.motivo === "duplicada") {
        return {
          corpo: { ok: true, estado: "already_processed", requestId: null },
          status: 200,
        };
      }
      return {
        corpo: { ok: false, estado: "falha_auditoria", requestId: resultado.requestId },
        status: 500,
      };

    case "aprovacao_indisponivel":
      return {
        corpo: {
          ok: false,
          estado: "aprovacao_indisponivel",
          requestId: resultado.requestId,
          codigo: resultado.codigo,
        },
        status: 200,
      };

    case "indisponivel":
      return {
        corpo: { ok: false, estado: "indisponivel", requestId: resultado.requestId },
        status: 404,
      };

    default: {
      // Exaustividade: uma variante nova deixa de compilar aqui.
      const _exaustivo: never = resultado;
      return _exaustivo;
    }
  }
}

export async function POST(request: Request) {
  // ── Auth fail-closed ──────────────────────────────────────────────
  //
  // Segredo PROPRIO. `CRON_SECRET` daria ao portador o poder de acionar
  // o worker; `AGENTES_WORKER_INTERNAL_SECRET`, o de executar tarefa
  // arbitraria por id. Nenhum dos dois e o que esta ponte precisa, e
  // reusar qualquer um desfaria o isolamento entre os dominios — mesma
  // razao escrita em `app/api/internal/agentes/executar/route.ts`.
  //
  // Resposta generica: nao revela se o que faltou foi a configuracao do
  // servidor ou o header de quem chamou.
  const segredo = process.env.N8N_BRIDGE_INTERNAL_SECRET;
  const recebido = request.headers.get("x-worker-secret");
  if (!segredo || !recebido || recebido !== segredo) {
    return responder({ ok: false, erro: "nao_autorizado" }, 401);
  }

  try {
    const corpo = await lerCorpo(request);
    if (!corpo.ok) return responder({ ok: false, erro: "corpo_invalido" }, 400);

    // ── A ACAO vira Funcao aqui, e so aqui ──────────────────────────
    //
    // O contrato vem inteiro: para onde a acao traduz E o que ela aceita.
    // As duas metades andam juntas de proposito — resolver a Funcao sem
    // aplicar o filtro dela seria executar com argumentos de outra acao.
    const contrato = resolverAcao(corpo.acao);
    if (contrato === null) return responder({ ok: false, erro: "acao_desconhecida" }, 400);

    if (!argumentosAceitos(contrato, corpo.argumentos)) {
      return responder({ ok: false, erro: "corpo_invalido" }, 400);
    }

    // ── O DONO vem do BANCO ─────────────────────────────────────────
    const { agente, erro } = await lerAgenteParaAcaoInterna(corpo.agenteId);
    if (erro !== null) return responder({ ok: false, erro: "falha_leitura" }, 500);
    // Inexistente e alheio sao a MESMA resposta: distingui-las seria um
    // oraculo de existencia de recurso alheio.
    if (agente === null) return responder({ ok: false, erro: "agente_nao_encontrado" }, 404);
    // Agente desligado nao age. Mesma recusa das rotas que criam tarefa,
    // e aqui ela importa mais: la a tarefa ficaria parada, aqui a Funcao
    // executaria de fato.
    if (!agente.ativo) return responder({ ok: false, erro: "agente_inativo" }, 409);

    const resultado = await executarFuncao({
      userId: agente.userId,
      agenteId: agente.agenteId,
      funcaoId: contrato.funcaoId,
      argumentos: corpo.argumentos,
      // Derivada no SERVIDOR, a partir do `operationId` — a identidade da
      // INTENCAO. A chave crua do orquestrador nunca vira namespace de
      // dominio, e o `executionId` NAO entra aqui: ele muda a cada
      // disparo, e um retry de transporte nasceria com chave nova.
      idempotencyKey: chaveDeIdempotencia(
        PROVEDOR,
        corpo.operationId,
        corpo.acao,
        agente.agenteId
      ),
    });

    const { corpo: saida, status } = mapear(resultado);
    return responder(saida, status);
  } catch {
    // Sem inspecionar nem logar o erro: qualquer detalhe daqui e material
    // de reconhecimento.
    return responder({ ok: false, erro: "falha_ponte" }, 500);
  }
}
