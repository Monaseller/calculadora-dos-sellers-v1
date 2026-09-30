/**
 * As ferramentas EXTERNAS de um agente — AGENT-FACTORY-F7b.4.1.
 *
 * GET     as acoes externas vinculadas, com o nivel de cada uma
 * POST    lista as acoes de um toolkit, ou vincula UMA delas
 * DELETE  desvincula
 *
 * ── Rota propria, e nao `/permissoes` ───────────────────────────────
 *
 * `PATCH /permissoes` valida `funcaoExiste()` contra o registry, e isso
 * esta CORRETO: aquela rota existe para as Functions que a CDS implementa,
 * e aceitar id arbitrario ali seria abrir a porta que a validacao fecha.
 *
 * Acao externa nao esta no registry — ela vem do catalogo. Por isso tem
 * rota propria, com a sua propria prova de existencia: o catalogo do
 * Composio e consultado ANTES de gravar.
 *
 * ── O vinculo E a permissao ─────────────────────────────────────────
 *
 * Nao ha tabela de "selecionadas". Vincular uma acao e gravar a permissao
 * dela em `agente_permissoes`, com o nivel recomendado pelo risco. Isso
 * mantem o guard como autoridade unica: nao existe estado "selecionada
 * mas sem permissao" para alguem reconciliar depois.
 *
 * Escrita e desconhecido nascem em `aprovacao`. NUNCA `automatico`.
 *
 * ── O modelo nao ganha executor universal ───────────────────────────
 *
 * Esta rota grava permissao. Ela nao executa nada, nao devolve credencial
 * e nao cria caminho do modelo para o Composio.
 */
import { atravessarPorta, lerCorpo, responder } from "@/lib/agentes/api/porta";
import { definirPermissaoDeFuncaoDoAgente } from "@/lib/agentes/permissoes/escrita";
import { listarPermissoesGravadas } from "@/lib/agentes/permissoes/gravadas";
import { listarAcoesDoToolkit } from "@/lib/agentes/composio/cliente";
import {
  ehFuncaoExterna, idDaFuncaoExterna, nivelRecomendado, pecasDoId, riscoDaAcao,
} from "@/lib/agentes/composio/identidade-de-funcao";

export const dynamic = "force-dynamic";

const FALHA = "Nao foi possivel carregar as ferramentas externas.";

export async function GET(request: Request, { params }: { params: { agenteId: string } }) {
  try {
    const porta = await atravessarPorta(request, params.agenteId, FALHA);
    if (!porta.ok) return porta.resposta;

    const r = await listarPermissoesGravadas({
      userId: porta.userId,
      agenteId: porta.agenteId,
    });
    if (r.coleta !== "ok") return responder({ ok: false, erro: FALHA }, 500);

    // Externas sao reconheciveis por INSPECAO do id — nao ha coluna que
    // as marque, e nao precisa haver.
    const externas = r.permissoes
      .filter((p) => ehFuncaoExterna(p.funcaoId))
      .map((p) => {
        const pecas = pecasDoId(p.funcaoId);
        return {
          funcaoId: p.funcaoId,
          toolkit: pecas?.toolkit ?? "",
          acao: pecas?.acao ?? "",
          nivel: p.nivel,
          risco: riscoDaAcao(pecas?.acao ?? ""),
        };
      });

    return responder({ ok: true, externas }, 200);
  } catch {
    return responder({ ok: false, erro: FALHA }, 500);
  }
}

export async function POST(request: Request, { params }: { params: { agenteId: string } }) {
  try {
    const porta = await atravessarPorta(request, params.agenteId, FALHA);
    if (!porta.ok) return porta.resposta;

    const corpo = await lerCorpo(request);
    if (corpo === null || typeof corpo.toolkit !== "string" || corpo.toolkit.trim() === "") {
      return responder({ ok: false, erro: "Informe o aplicativo." }, 400);
    }
    const toolkit = corpo.toolkit.trim();

    // ── Sem `acao`: apenas LISTAR as acoes daquele toolkit ──────────
    //
    // A tela precisa disso para a pessoa escolher, em vez de vincular as
    // 36 acoes do Google Sheets de uma vez — §6.
    if (corpo.acao === undefined) {
      const r = await listarAcoesDoToolkit(toolkit, 30);
      if (r.estado === "nao_configurado") {
        return responder({ ok: false, erro: "Catálogo externo não configurado." }, 503);
      }
      if (r.estado !== "ok") {
        return responder({ ok: false, erro: "Catálogo externo indisponível." }, 502);
      }
      return responder({
        ok: true,
        toolkit,
        totalDisponivel: r.dados.totalDisponivel,
        acoes: r.dados.itens.map((a) => {
          const risco = riscoDaAcao(a.slug);
          const id = idDaFuncaoExterna({ toolkit, acao: a.slug });
          return {
            acao: a.slug,
            nome: a.nome,
            descricao: a.descricao,
            risco,
            nivelRecomendado: nivelRecomendado(risco),
            // `null` quando a acao nao produz id valido: a tela nao pode
            // oferecer algo que o banco recusaria ao gravar.
            funcaoId: id.ok ? id.funcaoId : null,
          };
        }),
      }, 200);
    }

    // ── Com `acao`: VINCULAR ────────────────────────────────────────
    if (typeof corpo.acao !== "string" || corpo.acao.trim() === "") {
      return responder({ ok: false, erro: "Informe a ação." }, 400);
    }
    const acao = corpo.acao.trim();

    const id = idDaFuncaoExterna({ toolkit, acao });
    if (!id.ok) {
      return responder({ ok: false, erro: "Ação externa inválida." }, 400);
    }

    // A acao tem de EXISTIR no catalogo. Sem esta checagem um cliente
    // poderia gravar permissao para uma acao inventada, e o agente
    // receberia uma ferramenta que sempre falha.
    const cat = await listarAcoesDoToolkit(toolkit, 50);
    if (cat.estado === "nao_configurado") {
      return responder({ ok: false, erro: "Catálogo externo não configurado." }, 503);
    }
    if (cat.estado !== "ok") {
      return responder({ ok: false, erro: "Catálogo externo indisponível." }, 502);
    }
    if (!cat.dados.itens.some((a) => a.slug === acao)) {
      return responder({ ok: false, erro: "Esta ação não existe neste aplicativo." }, 404);
    }

    // Escrita e desconhecido nascem em `aprovacao` — §11/§18.
    const risco = riscoDaAcao(acao);
    const nivel = nivelRecomendado(risco);

    const r = await definirPermissaoDeFuncaoDoAgente({
      userId: porta.userId,
      agenteId: porta.agenteId,
      funcaoId: id.funcaoId,
      nivel,
    });
    if (r.estado !== "definida") {
      return responder({ ok: false, erro: "Nao foi possivel vincular a ferramenta." }, 500);
    }

    return responder({
      ok: true,
      funcaoId: id.funcaoId,
      toolkit,
      acao,
      risco,
      nivel,
    }, 201);
  } catch {
    return responder({ ok: false, erro: FALHA }, 500);
  }
}

export async function DELETE(request: Request, { params }: { params: { agenteId: string } }) {
  try {
    const porta = await atravessarPorta(request, params.agenteId, FALHA);
    if (!porta.ok) return porta.resposta;

    const funcaoId = new URL(request.url).searchParams.get("funcaoId") ?? "";
    // So EXTERNA. Function interna nao se desvincula — ela existe no
    // registry, e o que muda nela e o nivel.
    if (!ehFuncaoExterna(funcaoId)) {
      return responder({ ok: false, erro: "funcaoId externo inválido." }, 400);
    }

    // Desvincular e BLOQUEAR, nao apagar a linha. Duas razoes: a escolha
    // fica registrada, e um agente que ja rodou com aquela ferramenta
    // continua explicavel. Para o runtime o efeito e o mesmo — o guard
    // nega e o laco fecha o turno, com a Funcao ainda declarada (F7b.0).
    const r = await definirPermissaoDeFuncaoDoAgente({
      userId: porta.userId,
      agenteId: porta.agenteId,
      funcaoId,
      nivel: "bloqueado",
    });
    if (r.estado !== "definida") {
      return responder({ ok: false, erro: "Nao foi possivel remover a ferramenta." }, 500);
    }
    return responder({ ok: true, funcaoId, nivel: "bloqueado" }, 200);
  } catch {
    return responder({ ok: false, erro: FALHA }, 500);
  }
}
