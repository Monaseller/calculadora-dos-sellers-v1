/**
 * Decidir uma aprovacao DE CHAT, e continuar o turno — F7b.4.4.
 *
 * PATCH  `{ decisao: "aprovar" | "rejeitar" }`
 *
 * ── Por que esta rota existe, se `/api/aprovacoes/[id]/decidir` ja existe
 *
 * Aquela rota decide e para ali — e correto para aprovacao de TAREFA, que
 * tem fila e retomada proprias. Para o chat, decidir e metade do trabalho:
 * a outra metade e voltar ao turno e produzir a resposta.
 *
 * Era exatamente essa metade que faltava. O Rodrigo aprovava na fila, o
 * chat continuava parado, ele repetia a pergunta e o ciclo recomecava.
 *
 * Esta rota decide E retoma, na mesma chamada, para que a tela nao precise
 * orquestrar dois passos — e sobretudo para que ela nao precise NAVEGAR
 * para lugar nenhum. Sair da pagina era o que "apagava" as mensagens.
 *
 * ── O que o cliente pode mandar ─────────────────────────────────────
 *
 * Uma palavra: `aprovar` ou `rejeitar`. Mais nada.
 *
 * `funcaoId`, `argumentos`, `agenteId` e o dono saem todos da linha
 * CONGELADA na criacao da aprovacao. Nao ha campo por onde trocar o que
 * sera executado depois de o dono ter aprovado (§23).
 */
import { atravessarPorta, lerCorpo, responder } from "@/lib/agentes/api/porta";
import { decidirAprovacao } from "@/lib/agentes/aprovacoes/persistencia";
import { lerAprovacaoDaConversaParaRetomada } from "@/lib/agentes/aprovacoes/persistencia";
import { retomarTurnoAprovado } from "@/lib/agentes/conversas/retomada";
import { criarPortaDeConversas } from "@/lib/agentes/conversas/repositorio";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";

export const dynamic = "force-dynamic";

const FALHA = "Nao foi possivel registrar a decisao.";

/** A frase que fica na conversa quando o dono NEGA. */
const TEXTO_NEGADO =
  "Você não autorizou esta ação, então ela não foi executada. " +
  "Se quiser, me peça outra coisa ou mude a permissão desta ferramenta.";

export async function PATCH(
  request: Request,
  { params }: { params: { agenteId: string; aprovacaoId: string } }
) {
  try {
    const porta = await atravessarPorta(request, params.agenteId, FALHA);
    if (!porta.ok) return porta.resposta;

    const corpo = await lerCorpo(request);
    const decisao = corpo === null ? null : corpo.decisao;
    if (decisao !== "aprovar" && decisao !== "rejeitar") {
      return responder({ ok: false, erro: "Informe `aprovar` ou `rejeitar`." }, 400);
    }

    // ── A aprovacao tem de ser DESTE agente ──────────────────────────
    //
    // `atravessarPorta` ja provou que o agente e deste dono, e a leitura
    // abaixo ja escopa por dono. Falta amarrar os dois: sem esta
    // conferencia, o dono poderia decidir a aprovacao de um agente dele
    // por uma rota de outro agente dele — nao e vazamento, mas e uma
    // costura frouxa que um dia vira um.
    const leitura = await lerAprovacaoDaConversaParaRetomada({
      userId: porta.userId, aprovacaoId: params.aprovacaoId,
    });
    if (leitura.leitura === "falha") return responder({ ok: false, erro: FALHA }, 500);
    if (leitura.leitura !== "ok" || leitura.aprovacao.agenteId !== porta.agenteId) {
      return responder({ ok: false, erro: "Aprovação não encontrada." }, 404);
    }
    const aprovacao = leitura.aprovacao;

    // ── REJEITAR ────────────────────────────────────────────────────
    if (decisao === "rejeitar") {
      const r = await decidirAprovacao({
        userId: porta.userId, aprovacaoId: params.aprovacaoId, decisao: "rejeitar",
      });
      // Os codigos sao os da RPC: `rejeitada` = registrada agora,
      // `ja_rejeitada` = o segundo clique, que encontra o estado final que
      // ele mesmo pediu. Os dois sao sucesso para quem clicou.
      if (r.codigo === "ja_rejeitada") {
        return responder({ ok: true, decisao: "rejeitar", jaDecidida: true }, 200);
      }
      if (r.codigo !== "rejeitada") {
        return responder({ ok: false, erro: FALHA, codigo: r.codigo }, 409);
      }

      // §12: a conversa CONTINUA. Uma negacao sem resposta deixaria o
      // chat mudo, e mudo parece quebrado.
      const portaC = criarPortaDeConversas(getSupabaseServidor());
      const mensagem = await portaC.anexarMensagem({
        userId: porta.userId,
        conversaId: aprovacao.conversaId,
        papel: "assistente",
        conteudo: TEXTO_NEGADO,
        passos: [{
          funcaoId: aprovacao.funcaoId,
          desfecho: "negado_pelo_dono",
          executou: false,
          requestId: null,
        }],
      });
      return responder({
        ok: true, decisao: "rejeitar", conversaId: aprovacao.conversaId, mensagem,
      }, 200);
    }

    // ── APROVAR ─────────────────────────────────────────────────────
    //
    // Duas etapas, e a segunda e a que faltava. `decidirAprovacao` marca;
    // `retomarTurnoAprovado` consome, executa e fecha o turno.
    const decidida = await decidirAprovacao({
      userId: porta.userId, aprovacaoId: params.aprovacaoId, decisao: "aprovar",
    });
    // `ja_aprovada` NAO aborta: o segundo clique encontra a aprovacao ja
    // aprovada, e o certo e seguir para a retomada — que e idempotente no
    // banco. Abortar aqui deixaria a primeira aprovacao sem retomada se a
    // rede tivesse caido entre o marcar e o executar.
    //
    // `ja_consumida` tambem segue: a retomada devolve `ja_executada`, que
    // vira 200 mais abaixo.
    if (decidida.codigo !== "aprovada" &&
        decidida.codigo !== "ja_aprovada" &&
        decidida.codigo !== "ja_consumida") {
      return responder({ ok: false, erro: FALHA, codigo: decidida.codigo }, 409);
    }

    const retomada = await retomarTurnoAprovado({
      userId: porta.userId, aprovacaoId: params.aprovacaoId,
    });

    if (!retomada.ok) {
      // `ja_executada` e sucesso do ponto de vista de quem clicou duas
      // vezes: a acao rodou uma vez, que e o estado pedido.
      if (retomada.codigo === "ja_executada") {
        return responder({
          ok: true, decisao: "aprovar", jaExecutada: true,
          conversaId: aprovacao.conversaId,
        }, 200);
      }
      if (retomada.codigo === "aprovacao_nao_encontrada") {
        return responder({ ok: false, erro: "Aprovação não encontrada." }, 404);
      }
      return responder({ ok: false, erro: retomada.mensagem, codigo: retomada.codigo }, 409);
    }

    return responder({
      ok: true,
      decisao: "aprovar",
      conversaId: retomada.conversaId,
      mensagem: retomada.resposta,
      executou: retomada.executou,
    }, 200);
  } catch (e) {
    // O catch mudo custou uma investigacao: a suite via 500 e nao havia
    // nada no log dizendo de onde. A MENSAGEM fica no servidor, truncada;
    // a resposta continua sendo a frase estavel de sempre.
    console.error("[aprovacoes/chat] excecao:",
      String((e as Error).message).slice(0, 300));
    return responder({ ok: false, erro: FALHA }, 500);
  }
}
