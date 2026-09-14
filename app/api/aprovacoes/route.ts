/**
 * GET /api/aprovacoes — APPROVAL-UI-API-A1.
 *
 * A fila real de pedidos de autorizacao do dono. Ate aqui a tela
 * `/ia/aprovacoes` vivia de `MOCK_APROVACOES`: campanhas ficticias que
 * ninguem pediu, com botoes desabilitados. Esta rota substitui a fonte;
 * ela nao liga botao nenhum.
 *
 * ── Somente GET, e isso e a decisao de arquitetura ──────────────────
 *
 * Nao ha `POST`, `PATCH`, `PUT` nem `DELETE` aqui, e a ausencia e
 * deliberada. Aprovar hoje deixaria a aprovacao `aprovada` e a tarefa
 * parada em `aguardando_aprovacao` para sempre: `claim_next_agente_tarefa`
 * nao alcanca esse status, e `retomarAprovacao` nao tem chamador de
 * produto. Rejeitar encalha do mesmo jeito — nenhuma RPC leva a tarefa
 * de `aguardando_aprovacao` a `cancelado`. Um botao que registra
 * decisao e nao move nada seria pior que o botao desabilitado que a
 * tela ja mostra. Decisao entra junto do Resume, num gate so.
 *
 * ── Adapter, nao dominio ────────────────────────────────────────────
 *
 * Autentica e delega. Nao abre banco, nao filtra, nao ordena, nao
 * limita: `listarAprovacoesPendentesDoDono` ja faz as quatro coisas no
 * datastore. Repetir qualquer uma aqui criaria duas verdades.
 *
 * ── O que nunca sai daqui ───────────────────────────────────────────
 *
 * A projecao publica e montada campo a campo, nunca por spread, a
 * partir de um tipo que ja nao carrega `user_id`, `argumentos_hash`,
 * `fingerprint`, `request_id_*` nem `conexao_loja_id`. Sao duas
 * barreiras em serie, e a de baixo — o `select` nominal do helper — e a
 * que impede coluna nova de vazar sozinha. Erro de leitura vira UMA
 * frase fixa: `erro_consulta_aprovacao` e vocabulario nosso, nao
 * contrato publico, e `message`/`details`/`hint` do Supabase nao chegam
 * nem aqui — o helper nao os propaga.
 */
import { NextResponse } from "next/server";
import { autenticarRequisicao } from "@/lib/autenticacao";
import { listarAprovacoesPendentesDoDono } from "@/lib/agentes/aprovacoes/leitura";
import type { AprovacaoPendente } from "@/lib/agentes/aprovacoes/leitura";

/** Fila privada por dono, e que muda a cada pedido de autorizacao.
 *  Nunca estatica, nunca guardada por um intermediario. */
export const dynamic = "force-dynamic";

/** Ponto unico de saida: nenhum branch pode esquecer o `no-store`. */
function responder(corpo: unknown, status: number): NextResponse {
  return NextResponse.json(corpo, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/** Os onze campos publicos de uma aprovacao — campo a campo.
 *
 *  `argumentos` sai como o objeto persistido, sem transformar e sem
 *  serializar: quem renderiza escolhe por allowlist o que mostrar, e um
 *  `JSON.stringify` aqui entregaria a tela um texto que ela teria de
 *  desfazer. O conteudo ja passou pelo validador de entrada da Funcao
 *  antes da aprovacao nascer e pelo CHECK anti-segredo da tabela. */
function paraResposta(linha: AprovacaoPendente) {
  return {
    id: linha.id,
    agenteId: linha.agenteId,
    agenteNome: linha.agenteNome,
    tarefaId: linha.tarefaId,
    funcaoId: linha.funcaoId,
    revisaoFuncao: linha.revisaoFuncao,
    acesso: linha.acesso,
    estado: linha.estado,
    criadoEm: linha.criadoEm,
    expiraEm: linha.expiraEm,
    argumentos: linha.argumentos,
    conexao: linha.conexao,
  };
}

export async function GET(request: Request) {
  try {
    const auth = await autenticarRequisicao(request);
    if (!auth.autenticado) {
      return responder({ ok: false, erro: "Não autenticado." }, 401);
    }

    // `auth.uid` e a unica autoridade de identidade. Nenhum dono chega
    // por query, corpo ou header — nao ha parametro lido nesta rota.
    const resultado = await listarAprovacoesPendentesDoDono(auth.uid);
    if (resultado.erro !== null) {
      return responder({ ok: false, erro: "Falha ao listar as aprovações." }, 500);
    }

    // Fila vazia e resposta COMPLETA, nao ausencia de resposta.
    return responder({ ok: true, aprovacoes: resultado.linhas.map(paraResposta) }, 200);
  } catch {
    // `autenticarRequisicao` LANCA se `SESSION_SECRET` faltar — e o
    // fail-closed da camada de sessao chega ate aqui como 500, nunca
    // como fila vazia com cara de "nada pendente".
    return responder({ ok: false, erro: "Falha ao listar as aprovações." }, 500);
  }
}
