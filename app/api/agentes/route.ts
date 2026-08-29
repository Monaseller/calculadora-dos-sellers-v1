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
import { criarAgente, listarAgentesDoDono } from "@/lib/agentes/capability";
import type { LinhaAgente } from "@/lib/agentes/tipos";

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

    // Lista vazia e resposta COMPLETA, nao ausencia de resposta.
    return responder({ ok: true, agentes: resultado.linhas.map(paraResposta) }, 200);
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
