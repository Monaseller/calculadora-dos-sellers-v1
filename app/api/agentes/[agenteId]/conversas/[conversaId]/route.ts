/**
 * Uma conversa — AGENT-FACTORY-F7a.
 *
 * GET     o historico
 * POST    envia mensagem e devolve a resposta do agente
 * DELETE  arquiva
 *
 * ── Este POST e o unico caminho de chat ─────────────────────────────
 *
 * O browser nunca fala com o executor de Funcao, nunca com o provedor e
 * nunca com o storage. Ele manda texto para ca; daqui em diante quem
 * decide e o runtime, que passa pelo guard.
 *
 * ── O que NAO sai daqui ─────────────────────────────────────────────
 *
 * Instrucao de sistema, Skill, memoria, caminho de arquivo, credencial,
 * `request_id` interno. A proveniencia que a UI mostra em "Ver dados
 * usados" e so: qual Funcao, qual desfecho, se executou.
 */
import { atravessarPorta, lerCorpo, responder, UUID_REGEX } from "@/lib/agentes/api/porta";
import { criarPortaDeConversas } from "@/lib/agentes/conversas/repositorio";
import { lerAprovacaoVivaDaConversa } from "@/lib/agentes/aprovacoes/persistencia";
import {
  lerPendenciaVivaDaConversa,
} from "@/lib/agentes/factory/capacidade-pendente";
import { faltaParaCompletar } from "@/lib/agentes/factory/completar-capacidade";
import { nomeDoAplicativo } from "@/lib/agentes/factory/capacidades";
import { retomadaDaConversaAnterior } from "@/lib/agentes/conversas/retomada-anterior";
import { responderNaConversa } from "@/lib/agentes/conversas/runtime";
import type { Mensagem } from "@/lib/agentes/conversas/tipos";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";

export const dynamic = "force-dynamic";

const FALHA = "Nao foi possivel carregar a conversa.";

/**
 * A forma que o browser recebe.
 *
 * `userId` e `conversaId` ficam de fora: o cliente ja sabe em que
 * conversa esta, e repetir o dono numa resposta so cria um campo que
 * alguem um dia vai tentar usar como autoridade.
 */
function paraUI(m: Mensagem) {
  return {
    id: m.id,
    papel: m.papel,
    conteudo: m.conteudo,
    criadoEm: m.criadoEm,
    // Proveniencia para "Ver dados usados".
    passos: m.passos ?? [],
    modelo: m.modelo,
    // Tokens e tempo ficam em detalhes tecnicos na UI, mas viajam:
    // sem eles nao ha painel de custo.
    uso: m.papel === "assistente"
      ? { tokensEntrada: m.tokensEntrada, tokensSaida: m.tokensSaida, tempoMs: m.tempoMs }
      : null,
  };
}

async function conferirConversa(
  userId: string, agenteId: string, conversaIdBruto: string
): Promise<{ ok: true; conversaId: string } | { ok: false; status: number; erro: string }> {
  if (typeof conversaIdBruto !== "string" || !UUID_REGEX.test(conversaIdBruto)) {
    return { ok: false, status: 400, erro: "conversaId inválido." };
  }
  const c = await criarPortaDeConversas(getSupabaseServidor())
    .obterConversa(userId, conversaIdBruto);
  // Conversa de outro agente do MESMO dono tambem e 404: o historico
  // pertence ao par (dono, agente), e nao so ao dono.
  if (!c || c.agenteId !== agenteId) {
    return { ok: false, status: 404, erro: "Conversa não encontrada." };
  }
  return { ok: true, conversaId: c.id };
}

export async function GET(
  request: Request,
  { params }: { params: { agenteId: string; conversaId: string } }
) {
  try {
    const porta = await atravessarPorta(request, params.agenteId, FALHA);
    if (!porta.ok) return porta.resposta;

    const c = await conferirConversa(porta.userId, porta.agenteId, params.conversaId);
    if (!c.ok) return responder({ ok: false, erro: c.erro }, c.status);

    const mensagens = await criarPortaDeConversas(getSupabaseServidor())
      .listarMensagens(porta.userId, c.conversaId);

    // ── §11: o cartao de aprovacao sobrevive a um refresh ────────────
    //
    // O estado mora no BANCO, e nao na memoria da tela. Sem isto, recarregar
    // a pagina com uma aprovacao pendente mostrava a conversa parada e nada
    // que explicasse por que — que e metade do que o Rodrigo relatou.
    //
    // `consumida`, `rejeitada` e `expirada` nao voltam: a leitura so
    // considera `pendente` e `aprovada`, os mesmos dois estados do indice
    // parcial do banco.
    const viva = await lerAprovacaoVivaDaConversa({
      userId: porta.userId, conversaId: c.conversaId,
    });

    // ── §28: o cartao de capacidade tambem sobrevive ao refresh ──────
    //
    // Mesma razao da aprovacao: o estado mora no banco. Sem isto, dar
    // refresh com a oferta aberta faria a oferta desaparecer e a pessoa
    // ficaria sem saber por que o agente nao conseguia fazer o que pediu.
    const capacidade = await lerPendenciaVivaDaConversa({
      userId: porta.userId, conversaId: c.conversaId,
    });

    // ── As lojas, SO quando e delas que se esta falando ──────────────
    //
    // Consultar as lojas do dono em todo carregamento de conversa seria
    // uma ida ao banco por mensagem lida, para uma lista que quase nunca
    // e usada. Ela e buscada no estado que a pede.
    //
    // Nos estados de conexao a consulta tambem acontece, por causa do §10:
    // "conecte sua conta" e "sua conexao expirou" sao frases diferentes, e
    // qual das duas dizer nao esta gravado na pendencia — quem sabe e o
    // provedor. O custo e uma consulta enquanto a pendencia esta viva, que
    // e um estado de passagem; guardar a resposta na linha seria guardar um
    // fato que envelhece sozinho.
    const pend = capacidade.leitura === "ok" ? capacidade.pendencia : null;
    const EM_CONEXAO = ["escolhendo_loja", "aguardando_conexao", "conectando"];

    let lojasParaEscolher: readonly { lojaId: string; nome: string }[] = [];
    let reconectarConta = false;
    if (pend !== null && EM_CONEXAO.includes(pend.estado) &&
        pend.escolhaChave !== null && pend.escolhaOrigem !== null) {
      const falta = await faltaParaCompletar({
        userId: porta.userId,
        chave: pend.escolhaChave,
        origem: pend.escolhaOrigem,
      });
      if (falta.falta === "escolher_loja") lojasParaEscolher = falta.lojas;
      if (falta.falta === "conta_externa") reconectarConta = falta.reconectar;
    }

    // ── §19: mesma conversa NAO ganha saudacao nova ───────────────
    //
    // A linha de retomada existe SO enquanto a conversa esta vazia. Quem
    // volta a uma conversa com historico recebe o historico, e nada mais
    // — uma saudacao repetida a cada refresh faria o agente parecer sem
    // memoria do que acabou de dizer.
    //
    // A consulta tambem NAO acontece nesse caso: a condicao vem antes.
    const retomada = mensagens.length === 0
      ? await retomadaDaConversaAnterior({
          userId: porta.userId, agenteId: porta.agenteId, conversaAtualId: c.conversaId,
        })
      : null;

    return responder({
      ok: true,
      mensagens: mensagens.map(paraUI),
      retomada,
      // `null` quando nao ha nenhuma. Sem `funcao_id` na superficie: a tela
      // ja recebe o nome do pack pelo passo da mensagem.
      aprovacaoPendente: viva.leitura === "ok" && viva.aprovacao !== null
        ? { aprovacaoId: viva.aprovacao.aprovacaoId, estado: viva.aprovacao.estado }
        : null,
      // `null` quando nao ha oferta. As opcoes vao com nome e descricao de
      // gente — nunca `funcao_id`, nunca slug.
      capacidadePendente:
        capacidade.leitura === "ok" && capacidade.pendencia !== null
          ? {
              pendenciaId: capacidade.pendencia.id,
              necessidade: capacidade.pendencia.necessidade,
              estado: capacidade.pendencia.estado,
              opcoes: capacidade.pendencia.opcoes.map((o) => ({
                chave: o.chave, nome: o.nome, descricao: o.descricao,
                exigeConexao: o.exigeConexao,
              })),
              // F7b.4.7: o que ainda falta. `conexaoToolkit` diz QUAL
              // aplicativo, para a tela poder dizer "conectar Google" em
              // vez de "conectar". As lojas so vem no estado que as pede.
              conexaoToolkit: capacidade.pendencia.conexaoToolkit,
              // O NOME do aplicativo, e nao o slug: "Google Sheets" e o que
              // o dono reconhece; "googlesheets" e identificador de
              // catalogo e nao pertence a uma frase.
              conexaoNome: capacidade.pendencia.conexaoToolkit === null
                ? null
                : nomeDoAplicativo(capacidade.pendencia.conexaoToolkit),
              reconectar: reconectarConta,
              lojas: lojasParaEscolher,
            }
          : null,
    }, 200);
  } catch {
    return responder({ ok: false, erro: FALHA }, 500);
  }
}

export async function POST(
  request: Request,
  { params }: { params: { agenteId: string; conversaId: string } }
) {
  try {
    const porta = await atravessarPorta(request, params.agenteId, FALHA);
    if (!porta.ok) return porta.resposta;

    const c = await conferirConversa(porta.userId, porta.agenteId, params.conversaId);
    if (!c.ok) return responder({ ok: false, erro: c.erro }, c.status);

    const corpo = await lerCorpo(request);
    if (corpo === null) return responder({ ok: false, erro: "Corpo inválido." }, 400);

    const r = await responderNaConversa({
      // Da SESSAO. O corpo NAO pode dizer quem e o dono.
      userId: porta.userId,
      agenteId: porta.agenteId,
      conversaId: c.conversaId,
      texto: typeof corpo.texto === "string" ? corpo.texto : "",
    });

    if (!r.ok) {
      // `agente_nao_encontrado`/`conversa_nao_encontrada` ja foram
      // filtrados acima; chegar aqui com eles seria corrida real.
      const status = r.codigo === "mensagem_vazia" || r.codigo === "mensagem_longa" ? 400
        : r.codigo === "provedor_indisponivel" ? 503 : 500;
      return responder({ ok: false, erro: r.mensagem, codigo: r.codigo }, status);
    }

    return responder({
      ok: true,
      mensagem: paraUI(r.mensagemDoUsuario),
      resposta: paraUI(r.resposta),
      // `bloqueado_por_ferramenta` (F4.1) vale a pena a UI saber: ela
      // pode explicar que faltou permissao ou fonte, em vez de mostrar
      // a recusa como se fosse a opiniao do agente.
      motivo: r.motivo,
      // §12: a tela precisa saber a CATEGORIA para nao dizer "falta
      // ferramenta" a quem tem a ferramenta. `null` quando o turno nao
      // fechou por bloqueio.
      categoriaDoBloqueio: r.categoriaDoBloqueio,
      historicoTruncado: r.historicoTruncado,
    }, 200);
  } catch {
    return responder({ ok: false, erro: "Nao foi possivel responder agora." }, 500);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: { agenteId: string; conversaId: string } }
) {
  try {
    const porta = await atravessarPorta(request, params.agenteId, FALHA);
    if (!porta.ok) return porta.resposta;

    const c = await conferirConversa(porta.userId, porta.agenteId, params.conversaId);
    if (!c.ok) return responder({ ok: false, erro: c.erro }, c.status);

    const arquivou = await criarPortaDeConversas(getSupabaseServidor())
      .arquivarConversa(porta.userId, c.conversaId);

    return responder({ ok: arquivou }, arquivou ? 200 : 404);
  } catch {
    return responder({ ok: false, erro: "Nao foi possivel arquivar." }, 500);
  }
}
