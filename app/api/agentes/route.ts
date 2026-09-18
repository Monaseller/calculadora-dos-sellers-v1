/**
 * GET e POST /api/agentes — SKILL-1D.agent-source-C.
 *
 * A fonte real dos agentes do dono. Ate aqui a tela de IA vivia de
 * mocks: `agentes` so podia ser populada por SQL manual, porque
 * `criarAgente` existia sem nenhum chamador. Esta rota fecha a cadeia
 * `criar -> listar -> diagnosticar` — o `id` que o POST devolve e o
 * mesmo uuid que `GET /api/agentes/[agenteId]/diagnostico` exige.
 *
 * ── Adapter, nao dominio ────────────────────────────────────────────
 *
 * Autentica, le o corpo, monta tres campos e delega. Nao abre banco,
 * nao valida vocabulario por conta propria e nao reimplementa nenhuma
 * regra: `criarAgente` ja apara `nome`, ja recusa `tipo` fora de
 * `TIPOS_AGENTE` e ja copia campo a campo. Repetir isso aqui criaria
 * duas verdades que um dia discordariam.
 *
 * ── O que o cliente NAO controla ────────────────────────────────────
 *
 * O dono e `auth.uid`, e so ele: `CamposNovoAgente` nao tem `user_id`,
 * entao nao ha por onde um corpo pedir agente em nome de outro. `id`,
 * `criado_em` e `atualizado_em` sao do banco; `ativo` nasce `true` pelo
 * DEFAULT. Campos reservados enviados no corpo nao sao recusados com
 * cerimonia — simplesmente nao existe caminho ate o INSERT, porque o
 * objeto entregue ao dominio e montado campo a campo, nunca por spread.
 *
 * ── O que nunca sai daqui ───────────────────────────────────────────
 *
 * `user_id` e `atualizado_em` ficam de fora da resposta: o primeiro e a
 * propria sessao de quem perguntou, o segundo nao tem leitor. Erro de
 * leitura ou de escrita vira UMA frase fixa — o codigo interno do
 * dominio (`erro_criacao_agente`, `nome_invalido`) e vocabulario nosso,
 * nao contrato publico.
 */
import { NextResponse } from "next/server";
import { autenticarRequisicao } from "@/lib/autenticacao";
import {
  STATUS_DE_SINAL_ABERTO,
  criarAgente,
  listarAgentesDoDono,
  listarSinaisDeTarefasDoDono,
  type LinhaTarefaDeSinal,
} from "@/lib/agentes/capability";
import { ehStatusTarefa, type LinhaAgente } from "@/lib/agentes/tipos";
import type { TarefaUI } from "@/lib/ia/contratos";
import { tarefaAtual, tituloDaTarefa } from "@/lib/ia/tarefas";

/** Lista privada por dono, e que muda a cada criacao. Nunca estatica,
 *  nunca guardada por um intermediario. */
export const dynamic = "force-dynamic";

/** Ponto unico de saida: nenhum branch pode esquecer o `no-store`. */
function responder(corpo: unknown, status: number): NextResponse {
  return NextResponse.json(corpo, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * Os seis campos publicos de um agente — campo a campo, nunca spread.
 *
 * `LinhaAgente` traz oito. `user_id` fica de fora porque e a sessao de
 * quem perguntou, e devolve-lo so daria a um XSS um identificador de
 * dono de graca; `atualizado_em` fica de fora porque nenhuma tela o le.
 * Coluna nova na tabela nao passa a vazar sozinha por aqui.
 */
function paraResposta(linha: LinhaAgente) {
  return {
    id: linha.id,
    nome: linha.nome,
    tipo: linha.tipo,
    instrucoes: linha.instrucoes,
    ativo: linha.ativo,
    criado_em: linha.criado_em,
  };
}

// ── O SNAPSHOT OPERACIONAL ────────────────────────────────────────────
//
// `agentes` nao tem coluna de estado, e nao deve ganhar uma: o estado e
// DERIVADO das tarefas. Ate aqui o Escritorio derivava de tarefas
// simuladas, porque a lista de agentes nao trazia sinal nenhum.
//
// O que a rota acrescenta sao DOIS campos, e eles existem para responder
// exatamente duas perguntas que a tela ja fazia:
//
//   `sinais`    — o minimo para `aparenciaDoAgente` decidir a zona, a
//                 cor e o flash de concluido, do lado do cliente, com o
//                 relogio do cliente;
//   `atividade` — o que a estacao escreve embaixo do agente e o que a
//                 barra ja existente preenche.
//
// O que NAO sai daqui: a tarefa. Nem inteira, nem o `id` dela, nem
// `entrada`, nem `resultado`, nem mensagem de erro. `entrada` e lida no
// servidor, por `tituloDaTarefa`, e o que atravessa a rede e a FRASE que
// ela produziu. Um `jsonb` livre na tela funciona ate o dia em que
// alguem grava algo que nao deveria aparecer nela.

interface SinalOperacional {
  status: string;
  concluido_em: string | null;
}

interface AtividadeAtual {
  titulo: string;
  progresso: number;
}

/**
 * `tarefaAtual` pede `TarefaUI` inteira, mas le APENAS `status` e
 * `concluido_em` — e `tituloDaTarefa`, so `tipo` e `entrada`. A projecao
 * desta leitura nao traz `resultado`, `erro_*`, `tentativas` nem
 * `heartbeat_em`, e nao deve trazer.
 *
 * Os campos abaixo existem para satisfazer o TIPO, e nao participam de
 * decisao nenhuma: o objeto e descartado dentro desta funcao e so
 * `titulo` e `progresso` sobrevivem a ela. Alargar a assinatura de
 * `tarefaAtual` para um `Pick<>` seria mais limpo, mas `lib/ia/tarefas.ts`
 * e reusado por outras telas e nao pertence a este recorte.
 *
 * Status fora do vocabulario canonico derruba a linha em vez de virar um
 * `as` — recusa fechada, como no resto do modulo.
 */
function paraTarefaUI(linha: LinhaTarefaDeSinal): TarefaUI | null {
  if (!ehStatusTarefa(linha.status)) return null;
  return {
    id: linha.id,
    agente_id: linha.agente_id,
    tipo: linha.tipo,
    entrada: linha.entrada,
    status: linha.status,
    progresso: linha.progresso,
    criado_em: linha.criado_em,
    concluido_em: linha.concluido_em,
    tentativas: 0,
    max_tentativas: 0,
    erro_tipo: null,
    erro_mensagem: null,
    iniciado_em: null,
    heartbeat_em: null,
  };
}

/**
 * Os sinais de UM agente, deduplicados.
 *
 * `derivarStatusAgente` decide por EXISTENCIA (`includes`/`some`) e
 * `concluiuRecentemente` tambem. Repetir o mesmo status vinte vezes nao
 * muda nenhuma das duas respostas — so engorda a resposta HTTP. Entao
 * vai um sinal por status aberto e, no maximo, UMA conclusao: a de
 * `concluido_em` mais recente.
 *
 * Teto: 5 por agente, qualquer que seja o tamanho do historico.
 *
 * As linhas chegam em `criado_em DESC, id DESC`, entao a primeira de
 * cada status e a mais recente daquele status — e e o `concluido_em`
 * REAL dela que viaja, nunca um `null` de conveniencia.
 */
function sinaisDoAgente(tarefas: readonly LinhaTarefaDeSinal[]): SinalOperacional[] {
  const sinais: SinalOperacional[] = [];
  const jaTemSinal = new Set<string>();
  let ultimaConcluida: LinhaTarefaDeSinal | null = null;

  for (const tarefa of tarefas) {
    if (tarefa.status === "concluido") {
      const melhor = ultimaConcluida?.concluido_em ?? "";
      if ((tarefa.concluido_em ?? "") > melhor) ultimaConcluida = tarefa;
      continue;
    }
    if (!STATUS_DE_SINAL_ABERTO.includes(tarefa.status)) continue;
    if (jaTemSinal.has(tarefa.status)) continue;
    jaTemSinal.add(tarefa.status);
    sinais.push({ status: tarefa.status, concluido_em: tarefa.concluido_em });
  }

  if (ultimaConcluida !== null) {
    sinais.push({ status: "concluido", concluido_em: ultimaConcluida.concluido_em });
  }
  return sinais;
}

/** A tarefa em andamento, resumida. `null` quando nao ha nenhuma. */
function atividadeDoAgente(tarefas: readonly LinhaTarefaDeSinal[]): AtividadeAtual | null {
  const candidatas: TarefaUI[] = [];
  for (const linha of tarefas) {
    const convertida = paraTarefaUI(linha);
    if (convertida !== null) candidatas.push(convertida);
  }

  // A precedencia (`rodando` > `aguardando_aprovacao` > `pendente`) e do
  // helper, nunca daqui. A ordenacao da consulta responde outra
  // pergunta — qual linha vem primeiro DENTRO de um mesmo status.
  const atual = tarefaAtual(candidatas);
  if (atual === null) return null;
  return { titulo: tituloDaTarefa(atual), progresso: atual.progresso };
}

/**
 * Os seis campos publicos MAIS os dois do snapshot, campo a campo.
 *
 * Os seis sao re-listados em vez de espalhados de propósito: e a mesma
 * razao de `paraResposta` existir. Coluna nova na tabela nao passa a
 * vazar sozinha, e a suite compara as duas formas separadamente.
 */
function paraRespostaComSnapshot(
  linha: LinhaAgente,
  sinais: readonly SinalOperacional[],
  atividade: AtividadeAtual | null
) {
  const publico = paraResposta(linha);
  return {
    id: publico.id,
    nome: publico.nome,
    tipo: publico.tipo,
    instrucoes: publico.instrucoes,
    ativo: publico.ativo,
    criado_em: publico.criado_em,
    sinais,
    atividade,
  };
}

export async function GET(request: Request) {
  try {
    const auth = await autenticarRequisicao(request);
    if (!auth.autenticado) {
      return responder({ ok: false, erro: "Não autenticado." }, 401);
    }

    // Uma leitura, ja escopada ao dono e ja ordenada por `criado_em`.
    // A rota nao reordena e nao filtra `ativo`: o desativado precisa
    // aparecer para poder ser reativado.
    const resultado = await listarAgentesDoDono(auth.uid);
    if (resultado.erro !== null) {
      return responder({ ok: false, erro: "Falha ao listar os agentes." }, 500);
    }

    // A SEGUNDA leitura, e a ultima: uma so para TODOS os agentes. Uma
    // consulta por agente seria N+1 por construcao, e N cresce com o
    // numero de agentes do dono. Sem agentes, ela nem acontece.
    const identificadores = resultado.linhas.map((linha) => linha.id);
    const sinais = await listarSinaisDeTarefasDoDono(identificadores, auth.uid);
    if (sinais.erro !== null) {
      return responder({ ok: false, erro: "Falha ao listar os agentes." }, 500);
    }

    // Agrupamento em memoria, preservando a ordem que a consulta deu.
    const porAgente = new Map<string, LinhaTarefaDeSinal[]>();
    for (const linha of sinais.linhas) {
      const doAgente = porAgente.get(linha.agente_id);
      if (doAgente === undefined) porAgente.set(linha.agente_id, [linha]);
      else doAgente.push(linha);
    }

    // Lista vazia e resposta COMPLETA, nao ausencia de resposta.
    return responder(
      {
        ok: true,
        agentes: resultado.linhas.map((linha) => {
          const suas = porAgente.get(linha.id) ?? [];
          return paraRespostaComSnapshot(linha, sinaisDoAgente(suas), atividadeDoAgente(suas));
        }),
      },
      200
    );
  } catch {
    return responder({ ok: false, erro: "Falha ao listar os agentes." }, 500);
  }
}

export async function POST(request: Request) {
  try {
    const auth = await autenticarRequisicao(request);
    if (!auth.autenticado) {
      return responder({ ok: false, erro: "Não autenticado." }, 401);
    }

    let corpo: unknown;
    try {
      corpo = await request.json();
    } catch {
      return responder(
        { ok: false, erro: "Corpo da requisição inválido (JSON esperado)." },
        400
      );
    }
    // Corpo que nao seja objeto (numero, string, `null`, array) nao e
    // requisicao utilizavel — e recusado aqui em vez de virar
    // `nome_invalido`, que descreveria mal o que aconteceu.
    if (typeof corpo !== "object" || corpo === null || Array.isArray(corpo)) {
      return responder(
        { ok: false, erro: "Corpo da requisição inválido (JSON esperado)." },
        400
      );
    }
    const campos = corpo as Record<string, unknown>;

    // CAMPO A CAMPO. `nome` e `tipo` chegam como `unknown` de proposito:
    // quem julga os dois e `criarAgente`, com a autoridade canonica
    // `ehTipoAgente`. Um `as TipoAgente` aqui transformaria string
    // arbitraria em tipo valido para o compilador e deixaria o CHECK do
    // banco descobrir o problema em runtime.
    const resultado = await criarAgente(auth.uid, {
      nome: campos.nome as string,
      tipo: campos.tipo as never,
      instrucoes: campos.instrucoes as string | null | undefined,
    });

    if (resultado.erro === "nome_invalido") {
      return responder({ ok: false, erro: "nome inválido." }, 400);
    }
    if (resultado.erro === "tipo_invalido") {
      return responder({ ok: false, erro: "tipo inválido." }, 400);
    }
    // `user_id_ausente` e `erro_criacao_agente` sao os dois lados de uma
    // falha NOSSA — com a sessao verde, o primeiro so acontece por
    // defeito interno. Nenhum dos dois e erro do cliente, e nenhum dos
    // dois descreve o que houve para quem chamou.
    if (resultado.erro !== null || resultado.linha === null) {
      return responder({ ok: false, erro: "Falha ao criar o agente." }, 500);
    }

    return responder({ ok: true, agente: paraResposta(resultado.linha) }, 201);
  } catch {
    return responder({ ok: false, erro: "Falha ao criar o agente." }, 500);
  }
}
