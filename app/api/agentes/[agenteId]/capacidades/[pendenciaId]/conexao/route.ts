/**
 * Completar a capacidade sem sair do chat — F7b.4.7.
 *
 * POST   gera o link de conexao externa (Composio)
 * PATCH  `{ acao: "verificar" }`        confere e RETOMA a tarefa
 *        `{ acao: "escolher_loja", lojaId }`  vincula a loja e RETOMA
 *        `{ acao: "recusar" }`          encerra sem insistir
 *
 * ── Por que a volta NAO depende de callback do provedor — §6 ────────
 *
 * MEDIDO: `POST /connected_accounts/link` aceita `callback_url`,
 * `redirect_uri` e `config.callback_url` com 201, e nenhum deles aparece
 * no `redirect_url` devolvido. Nao da para AFIRMAR que o provedor volta
 * para a CDS, e conferir exigiria concluir um OAuth real — proibido aqui.
 *
 * Entao a volta e por CONSULTA: quando a pessoa reabre o chat, a tela
 * pergunta "ja conectou?" e a CDS confere no provedor. Funciona com
 * callback, sem callback, com a aba trocada e no dia seguinte — e nao
 * depende de um comportamento que eu nao pude verificar.
 *
 * ── O que o cliente pode mandar ─────────────────────────────────────
 *
 * Uma acao e, na escolha de loja, qual loja. Nada mais.
 *
 * `objetivo`, `agenteId`, o dono, a `escolha` da capacidade e a conta
 * externa saem todos da linha gravada. O `lojaId` e validado contra as
 * lojas DO DONO — um id de loja alheia nao encontra par.
 */
import { atravessarPorta, lerCorpo, responder } from "@/lib/agentes/api/porta";
import {
  lerCapacidadePendente, moverPendencia,
} from "@/lib/agentes/factory/capacidade-pendente";
import {
  faltaParaCompletar, requisitosDeConexaoDoPack,
} from "@/lib/agentes/factory/completar-capacidade";
import { gerarLinkDeConexao } from "@/lib/agentes/composio/conexao";
import { definirSelecaoDeLoja } from "@/lib/agentes/conexoes/selecao-escrita";
import { responderNaConversa } from "@/lib/agentes/conversas/runtime";

export const dynamic = "force-dynamic";

const FALHA = "Nao foi possivel completar esta capacidade.";

const TEXTO_RECUSA =
  "Tudo bem. Sem essa conexão eu não consigo a parte que depende dela — " +
  "quando quiser, me peça de novo.";

/** A pendencia, conferida contra o agente da rota. */
async function pendenciaDoAgente(
  userId: string, agenteId: string, pendenciaId: string
) {
  const leitura = await lerCapacidadePendente({ userId, pendenciaId });
  if (leitura.leitura === "falha") return { ok: false as const, status: 500 };
  if (leitura.leitura !== "ok" || leitura.pendencia.agenteId !== agenteId) {
    return { ok: false as const, status: 404 };
  }
  return { ok: true as const, pendencia: leitura.pendencia };
}

// ─── POST: o link de conexao externa ──────────────────────────────────

export async function POST(
  request: Request,
  { params }: { params: { agenteId: string; pendenciaId: string } }
) {
  try {
    const porta = await atravessarPorta(request, params.agenteId, FALHA);
    if (!porta.ok) return porta.resposta;

    const p = await pendenciaDoAgente(porta.userId, porta.agenteId, params.pendenciaId);
    if (!p.ok) {
      return responder({
        ok: false, erro: p.status === 404 ? "Pendência não encontrada." : FALHA,
      }, p.status);
    }
    const pendencia = p.pendencia;

    if (pendencia.escolhaChave === null || pendencia.escolhaOrigem === null) {
      return responder({ ok: false, erro: "Escolha a ferramenta primeiro." }, 409);
    }
    // Conexao externa e so para integracao. Marketplace nativo tem o
    // caminho proprio dele — ver `PATCH acao: "escolher_loja"`.
    if (pendencia.escolhaOrigem !== "integracao") {
      return responder({ ok: false, erro: "Esta capacidade não usa conta externa." }, 409);
    }

    const link = await gerarLinkDeConexao({
      userId: porta.userId, toolkit: pendencia.escolhaChave,
    });
    if (link.estado === "nao_configurado") {
      return responder({ ok: false, erro: "Conexão de aplicativos não configurada." }, 503);
    }
    if (link.estado !== "ok") {
      return responder({ ok: false, erro: "Não foi possível iniciar a conexão." }, 502);
    }

    // `conectando`: a pessoa clicou. O cartao passa a dizer "ja conectei?"
    // em vez de "conecte sua conta" — sao momentos diferentes.
    await moverPendencia({
      userId: porta.userId, pendenciaId: pendencia.id,
      de: ["aguardando_conexao", "conectando"], para: "conectando",
      conexao: { toolkit: pendencia.escolhaChave, contaId: link.dados.contaId },
    });

    // SO a URL e o prazo. Nem `link_token`, nem chave, nem o principal
    // derivado — provado em `testar-composio-conexao-live` (C6–C11).
    return responder({
      ok: true,
      urlParaConectar: link.dados.urlParaConectar,
      expiraEm: link.dados.expiraEm,
    }, 201);
  } catch {
    return responder({ ok: false, erro: FALHA }, 500);
  }
}

// ─── PATCH: verificar, escolher loja, ou desistir ─────────────────────

export async function PATCH(
  request: Request,
  { params }: { params: { agenteId: string; pendenciaId: string } }
) {
  try {
    const porta = await atravessarPorta(request, params.agenteId, FALHA);
    if (!porta.ok) return porta.resposta;

    const corpo = await lerCorpo(request);
    const acao = corpo === null ? null : corpo.acao;
    if (acao !== "verificar" && acao !== "escolher_loja" && acao !== "recusar") {
      return responder({ ok: false, erro: "Ação inválida." }, 400);
    }

    const p = await pendenciaDoAgente(porta.userId, porta.agenteId, params.pendenciaId);
    if (!p.ok) {
      return responder({
        ok: false, erro: p.status === 404 ? "Pendência não encontrada." : FALHA,
      }, p.status);
    }
    const pendencia = p.pendencia;

    // ── RECUSAR — §9/§16: a conversa continua, e a CDS nao insiste ───
    if (acao === "recusar") {
      await moverPendencia({
        userId: porta.userId, pendenciaId: pendencia.id,
        de: ["aguardando_conexao", "conectando", "escolhendo_loja"], para: "recusada",
      });
      return responder({
        ok: true, acao: "recusar", conversaId: pendencia.conversaId, texto: TEXTO_RECUSA,
      }, 200);
    }

    if (pendencia.escolhaChave === null || pendencia.escolhaOrigem === null) {
      return responder({ ok: false, erro: "Escolha a ferramenta primeiro." }, 409);
    }

    // ── ESCOLHER LOJA — §13/§14 ─────────────────────────────────────
    if (acao === "escolher_loja") {
      const lojaId = typeof corpo?.lojaId === "string" ? corpo.lojaId : "";
      if (lojaId === "") return responder({ ok: false, erro: "Informe a loja." }, 400);

      const falta = await faltaParaCompletar({
        userId: porta.userId,
        chave: pendencia.escolhaChave, origem: pendencia.escolhaOrigem,
      });
      if (falta.falta !== "escolher_loja") {
        return responder({ ok: false, erro: "Não há loja a escolher agora." }, 409);
      }
      // A loja tem de estar entre as DO DONO. Sem isto, um id de loja
      // alheia chegaria a escrita — e a escrita confia em quem a chama.
      if (!falta.lojas.some((l) => l.lojaId === lojaId)) {
        return responder({ ok: false, erro: "Loja inválida." }, 400);
      }

      // TODOS os requisitos do pack, e nao um: o dono escolheu uma loja,
      // e nao uma loja por Funcao.
      const requisitos = requisitosDeConexaoDoPack(pendencia.escolhaChave);
      if (requisitos.length === 0) {
        return responder({ ok: false, erro: "Esta capacidade não pede conexão." }, 409);
      }
      for (const r of requisitos) {
        const d = await definirSelecaoDeLoja({
          userId: porta.userId, agenteId: porta.agenteId,
          plataforma: r.plataforma, recurso: r.recurso, lojaId,
        });
        // `definida` e o unico sucesso: a escrita e upsert, e substituir
        // uma selecao anterior tambem devolve `definida`.
        if (d.estado !== "definida") {
          return responder({ ok: false, erro: FALHA, codigo: d.estado }, 409);
        }
      }
      return await concluirERetomar(porta.userId, porta.agenteId, pendencia);
    }

    // ── VERIFICAR — a volta do OAuth, por consulta ───────────────────
    const falta = await faltaParaCompletar({
      userId: porta.userId,
      chave: pendencia.escolhaChave, origem: pendencia.escolhaOrigem,
    });

    if (falta.falta === "falha") return responder({ ok: false, erro: FALHA }, 502);

    if (falta.falta === "conta_externa") {
      // Ainda nao conectou. NAO inventa resultado e NAO conclui a tarefa.
      return responder({
        ok: true, conectado: false,
        precisaConectar: {
          toolkit: falta.toolkit, nome: falta.nome, reconectar: falta.reconectar,
        },
        conversaId: pendencia.conversaId,
      }, 200);
    }
    if (falta.falta === "conectar_marketplace") {
      return responder({
        ok: true, conectado: false,
        precisaConectarMarketplace: {
          marketplace: falta.marketplace, nome: falta.nomeDoMarketplace,
        },
        conversaId: pendencia.conversaId,
      }, 200);
    }
    if (falta.falta === "escolher_loja") {
      await moverPendencia({
        userId: porta.userId, pendenciaId: pendencia.id,
        de: ["aguardando_conexao", "conectando", "escolhendo_loja"],
        para: "escolhendo_loja",
      });
      return responder({
        ok: true, conectado: true,
        // §14: uma loja tambem PERGUNTA. A diferenca e a frase, e nao a
        // ausencia de escolha — vincular sozinho seria decidir por alguem.
        escolherLoja: {
          marketplace: falta.marketplace, nome: falta.nomeDoMarketplace,
          lojas: falta.lojas,
        },
        conversaId: pendencia.conversaId,
      }, 200);
    }
    if (falta.falta === "indefinida") {
      return responder({
        ok: true, conectado: false, indefinida: true,
        conversaId: pendencia.conversaId,
      }, 200);
    }

    // `nada` falta: conectado. Retoma.
    return await concluirERetomar(porta.userId, porta.agenteId, pendencia);
  } catch {
    return responder({ ok: false, erro: FALHA }, 500);
  }
}

/**
 * Fecha a pendencia e continua a tarefa — §7.
 *
 * ── A transicao E a idempotencia — §8 ───────────────────────────────
 *
 * `moverPendencia` so fecha a partir de um estado VIVO. Dois retornos do
 * OAuth, ou dois refreshes, produzem uma unica retomada: o primeiro fecha
 * a linha, o segundo nao encontra estado de origem e recebe
 * `ja_decidida` — e nao chama o modelo.
 *
 * Sem isto, recarregar a pagina do callback executaria a tarefa de novo.
 */
async function concluirERetomar(
  userId: string,
  agenteId: string,
  pendencia: { readonly id: string; readonly conversaId: string; readonly objetivo: string }
) {
  const fechou = await moverPendencia({
    userId, pendenciaId: pendencia.id,
    de: ["aguardando_conexao", "conectando", "escolhendo_loja"], para: "concluida",
  });
  if (fechou.estado === "falha") return responder({ ok: false, erro: FALHA }, 500);
  if (fechou.estado === "ja_decidida") {
    // Outro retorno venceu a corrida e a tarefa ja foi retomada. Dizer
    // "conectado" e verdade; retomar de novo seria executar duas vezes.
    return responder({
      ok: true, conectado: true, jaRetomada: true, conversaId: pendencia.conversaId,
    }, 200);
  }

  const turno = await responderNaConversa({
    userId, agenteId, conversaId: pendencia.conversaId, texto: pendencia.objetivo,
  });

  if (!turno.ok) {
    // A conexao FOI feita; so a retomada falhou. Dizer o contrario faria a
    // pessoa reconectar sem necessidade.
    return responder({
      ok: true, conectado: true, retomada: false, conversaId: pendencia.conversaId,
    }, 200);
  }

  return responder({
    ok: true,
    conectado: true,
    retomada: true,
    conversaId: pendencia.conversaId,
    mensagemDoUsuario: turno.mensagemDoUsuario,
    mensagem: turno.resposta,
  }, 200);
}
