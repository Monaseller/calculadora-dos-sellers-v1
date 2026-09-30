/**
 * Ativar uma capacidade pelo chat, e continuar a tarefa — F7b.4.6.
 *
 * PATCH  `{ acao: "ativar" | "recusar", escolha?: "<chave>" }`
 *
 * ── O §9 e o motivo de esta rota nao parar na ativacao ──────────────
 *
 * "Ferramenta adicionada." nao e resposta. A pessoa nao pediu uma
 * ferramenta — ela pediu que o arquivo fosse analisado, e a ferramenta
 * apareceu no caminho.
 *
 * Entao a rota ativa E retoma: o objetivo original foi congelado na
 * pendencia, e o turno seguinte roda com ele. A pessoa nao reescreve nada.
 *
 * ── O que o cliente pode mandar ─────────────────────────────────────
 *
 * Uma acao e, quando ha mais de uma opcao, QUAL delas. Nada mais.
 *
 * `objetivo`, `agenteId`, o dono e as OPCOES saem todos da linha gravada.
 * A escolha e validada contra as opcoes congeladas — um `chave` que nao
 * estava no cartao e recusado, mesmo sendo um pack real. Foi a CDS que
 * ofereceu aquelas; nenhuma outra foi consentida.
 */
import { atravessarPorta, lerCorpo, responder } from "@/lib/agentes/api/porta";
import {
  lerCapacidadePendente, moverPendencia,
} from "@/lib/agentes/factory/capacidade-pendente";
import { ativarCapacidade } from "@/lib/agentes/factory/ativar-capacidade";
import { responderNaConversa } from "@/lib/agentes/conversas/runtime";

export const dynamic = "force-dynamic";

const FALHA = "Nao foi possivel ativar esta capacidade.";

/** A frase que fica na conversa quando a pessoa diz "agora nao". */
const TEXTO_RECUSA =
  "Tudo bem, não vou ativar. Se mudar de ideia, é só me pedir de novo — " +
  "ou você pode adicionar a ferramenta na tela de configuração do agente.";

export async function PATCH(
  request: Request,
  { params }: { params: { agenteId: string; pendenciaId: string } }
) {
  try {
    const porta = await atravessarPorta(request, params.agenteId, FALHA);
    if (!porta.ok) return porta.resposta;

    const corpo = await lerCorpo(request);
    const acao = corpo === null ? null : corpo.acao;
    if (acao !== "ativar" && acao !== "recusar") {
      return responder({ ok: false, erro: "Informe `ativar` ou `recusar`." }, 400);
    }

    const leitura = await lerCapacidadePendente({
      userId: porta.userId, pendenciaId: params.pendenciaId,
    });
    if (leitura.leitura === "falha") return responder({ ok: false, erro: FALHA }, 500);
    // A pendencia tem de ser DESTE agente: `atravessarPorta` provou o
    // agente, a leitura provou o dono, e esta linha amarra os dois.
    if (leitura.leitura !== "ok" || leitura.pendencia.agenteId !== porta.agenteId) {
      return responder({ ok: false, erro: "Pendência não encontrada." }, 404);
    }
    const pendencia = leitura.pendencia;

    // ── RECUSAR ─────────────────────────────────────────────────────
    if (acao === "recusar") {
      const m = await moverPendencia({
        userId: porta.userId, pendenciaId: pendencia.id,
        de: ["pendente", "aguardando_conexao"], para: "recusada",
      });
      if (m.estado === "falha") return responder({ ok: false, erro: FALHA }, 500);
      // `ja_decidida` tambem e 200: o estado pedido ja e o estado atual.
      return responder({
        ok: true, acao: "recusar", conversaId: pendencia.conversaId,
        texto: TEXTO_RECUSA,
      }, 200);
    }

    // ── A escolha, validada contra as opcoes CONGELADAS ─────────────
    const pedida = typeof corpo?.escolha === "string" ? corpo.escolha : null;
    const opcao = pendencia.opcoes.length === 1 && pedida === null
      ? pendencia.opcoes[0]
      : pendencia.opcoes.find((o) => o.chave === pedida);
    if (opcao === undefined) {
      // Nao diz quais eram as opcoes: quem chegou aqui com chave errada
      // ou nao leu o cartao, ou esta tentando outra coisa.
      return responder({ ok: false, erro: "Escolha inválida." }, 400);
    }

    // §11: a transicao e a trava. Dois cliques simultaneos — o primeiro
    // move `pendente -> ativando`, o segundo nao encontra linha.
    const travou = await moverPendencia({
      userId: porta.userId, pendenciaId: pendencia.id,
      de: ["pendente"], para: "ativando",
      escolha: { chave: opcao.chave, origem: opcao.origem },
    });
    if (travou.estado === "falha") return responder({ ok: false, erro: FALHA }, 500);
    if (travou.estado === "ja_decidida") {
      // O outro clique esta cuidando, ou ja cuidou. Nao ativa de novo e
      // nao cria binding duplicado.
      return responder({
        ok: true, acao: "ativar", jaEmAndamento: true,
        conversaId: pendencia.conversaId,
      }, 200);
    }

    const r = await ativarCapacidade({
      userId: porta.userId, agenteId: porta.agenteId,
      chave: opcao.chave, origem: opcao.origem,
    });

    if (r.estado === "opcao_invalida" || r.estado === "catalogo_indisponivel" ||
        r.estado === "falha") {
      await moverPendencia({
        userId: porta.userId, pendenciaId: pendencia.id,
        de: ["ativando"], para: "falhou",
      });
      return responder({
        ok: false,
        erro: r.estado === "catalogo_indisponivel"
          ? "O catálogo de aplicativos não respondeu agora."
          : "Não foi possível ativar esta capacidade.",
      }, r.estado === "catalogo_indisponivel" ? 502 : 409);
    }

    // ── Falta conectar a conta: a tarefa espera ──────────────────────
    if (r.estado === "aguardando_conexao") {
      await moverPendencia({
        userId: porta.userId, pendenciaId: pendencia.id,
        de: ["ativando"], para: "aguardando_conexao",
      });
      return responder({
        ok: true,
        acao: "ativar",
        conversaId: pendencia.conversaId,
        ativada: r.nome,
        // A tela mostra o botao de conectar. O objetivo continua guardado
        // na pendencia, e a retomada acontece depois do OAuth.
        precisaConectar: { toolkit: r.toolkit, nome: r.nome },
      }, 200);
    }

    // ── §9: CONTINUAR A TAREFA ORIGINAL ─────────────────────────────
    //
    // O objetivo vem da linha congelada, e nao de uma mensagem nova. Por
    // isso a conversa NAO ganha outra fala do usuario: `responderNaConversa`
    // grava a pergunta, e aqui ela ja e a mesma de antes — repetida no
    // registro, mas nao digitada de novo.
    //
    // A pendencia e fechada ANTES de retomar: se o turno falhar, ela nao
    // fica viva oferecendo de novo o que ja foi ativado.
    await moverPendencia({
      userId: porta.userId, pendenciaId: pendencia.id,
      de: ["ativando"], para: "concluida",
    });

    const turno = await responderNaConversa({
      userId: porta.userId,
      agenteId: porta.agenteId,
      conversaId: pendencia.conversaId,
      texto: pendencia.objetivo,
    });

    if (!turno.ok) {
      return responder({
        ok: true, acao: "ativar", conversaId: pendencia.conversaId,
        ativada: r.nome,
        // A capacidade FOI ativada; so a retomada falhou. Dizer o
        // contrario faria a pessoa clicar de novo sem necessidade.
        retomada: false,
      }, 200);
    }

    return responder({
      ok: true,
      acao: "ativar",
      conversaId: pendencia.conversaId,
      ativada: r.nome,
      retomada: true,
      mensagemDoUsuario: turno.mensagemDoUsuario,
      mensagem: turno.resposta,
    }, 200);
  } catch {
    return responder({ ok: false, erro: FALHA }, 500);
  }
}
