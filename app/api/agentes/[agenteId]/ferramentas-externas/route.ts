/**
 * As ferramentas EXTERNAS de um agente — AGENT-FACTORY-F7b.4.1, corrigido
 * pelo F7b.4.2.
 *
 * GET     as acoes externas vinculadas, cada uma com o seu nivel OU `null`
 * POST    lista as acoes de um toolkit, ou vincula UMA delas
 * PATCH   grava a DECISAO do dono sobre o nivel de UMA delas
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
 * ── O que mudou no F7b.4.2, e por que ───────────────────────────────
 *
 * ANTES (F7b.4.1) esta rota dizia: "o vinculo E a permissao". Vincular
 * gravava uma linha em `agente_permissoes` com o nivel recomendado pelo
 * risco, e desvincular gravava `bloqueado`.
 *
 * Isso estava ERRADO em duas frentes, e o gate corrigiu as duas:
 *
 *   §10/§11  Selecionar uma Tool nao concede permissao. O nivel era
 *            escolhido por NOS, a partir do risco, e nao pelo dono. Um
 *            default nosso ocupava o lugar de uma decisao que e dele — e
 *            `aprovacao` continua sendo autorizacao para pedir.
 *
 *   §13      Desvincular gravando `bloqueado` deixava a permissao antiga
 *            como unico registro da ferramenta. Como a permissao tambem
 *            servia de prova de existencia, uma permissao historica podia
 *            RESSUSCITAR uma ferramenta removida.
 *
 * AGORA sao duas tabelas, com dois significados:
 *
 *   POSSUIR  `agente_ferramentas_externas`  -> o agente TEM esta acao
 *   PODER    `agente_permissoes`            -> COMO ele pode usa-la
 *
 * Vincular cria o POSSUIR e deixa o PODER ausente — `nivel: null`, que e
 * o estado UNCONFIGURED que barra a ativacao (`ferramenta_externa_sem_
 * permissao`). Quem preenche o nivel e o dono, pelo PATCH desta mesma rota
 * — e nao por `PATCH /permissoes`, que valida contra o registry e sempre
 * recusaria um id externo.
 *
 * `nivelSugerido` continua sendo devolvido, mas como SUGESTAO para a tela
 * pre-selecionar — nunca gravado por esta rota.
 *
 * ── O modelo nao ganha executor universal ───────────────────────────
 *
 * Esta rota grava vinculo. Ela nao executa nada, nao devolve credencial e
 * nao cria caminho do modelo para o Composio.
 */
import { atravessarPorta, lerCorpo, responder } from "@/lib/agentes/api/porta";
import { listarPermissoesGravadas } from "@/lib/agentes/permissoes/gravadas";
import { listarAcoesDoToolkit } from "@/lib/agentes/composio/cliente";
import {
  definirPermissaoDeFerramentaExterna,
  desvincularFerramentaExternaDoAgente,
  listarVinculosExternos,
  vincularFerramentaExternaNoAgente,
} from "@/lib/agentes/ferramentas-externas/repositorio";
import {
  ehFuncaoExterna, idDaFuncaoExterna, nivelRecomendado, riscoDaAcao,
} from "@/lib/agentes/composio/identidade-de-funcao";

export const dynamic = "force-dynamic";

const FALHA = "Nao foi possivel carregar as ferramentas externas.";
const PROVEDOR_EXTERNO = "composio";

export async function GET(request: Request, { params }: { params: { agenteId: string } }) {
  try {
    const porta = await atravessarPorta(request, params.agenteId, FALHA);
    if (!porta.ok) return porta.resposta;

    // As duas leituras, nesta ordem de autoridade: o VINCULO define quais
    // acoes o agente tem; a permissao apenas anota o nivel de cada uma.
    const vinculos = await listarVinculosExternos({
      userId: porta.userId,
      agenteId: porta.agenteId,
    });
    if (vinculos.coleta !== "ok") return responder({ ok: false, erro: FALHA }, 500);

    const permissoes = await listarPermissoesGravadas({
      userId: porta.userId,
      agenteId: porta.agenteId,
    });
    if (permissoes.coleta !== "ok") return responder({ ok: false, erro: FALHA }, 500);

    const nivelPorId = new Map(permissoes.permissoes.map((p) => [p.funcaoId, p.nivel]));

    const externas = vinculos.vinculos.map((v) => {
      const risco = riscoDaAcao(v.acao);
      return {
        funcaoId: v.funcaoId,
        toolkit: v.toolkit,
        acao: v.acao,
        // `null` e o estado que a tela precisa poder mostrar: vinculada e
        // ainda sem decisao. Nao ha default aqui de proposito.
        nivel: nivelPorId.get(v.funcaoId) ?? null,
        risco,
        nivelSugerido: nivelRecomendado(risco),
      };
    });

    return responder({
      ok: true,
      externas,
      // Quantas ainda faltam decidir. A tela usa isso para explicar por que
      // o agente nao ativa, sem ter de recalcular a regra.
      semPermissao: externas.filter((e) => e.nivel === null).length,
    }, 200);
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
            // SUGESTAO para a tela pre-selecionar. Nao e gravada.
            nivelSugerido: nivelRecomendado(risco),
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
    // poderia vincular uma acao inventada, e o agente receberia uma
    // ferramenta que sempre falha.
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

    // §10: vincular grava POSSUIR, e nada mais. Nenhuma chamada de
    // permissao acontece aqui — e a ausencia dela que faz a acao nascer
    // UNCONFIGURED.
    const r = await vincularFerramentaExternaNoAgente({
      userId: porta.userId,
      agenteId: porta.agenteId,
      provedorExterno: PROVEDOR_EXTERNO,
      toolkit,
      acao,
    });
    if (r.estado === "entrada_invalida") {
      return responder({ ok: false, erro: "Ação externa inválida." }, 400);
    }
    if (r.estado === "falha") {
      return responder({ ok: false, erro: "Nao foi possivel vincular a ferramenta." }, 500);
    }

    const risco = riscoDaAcao(acao);
    return responder({
      ok: true,
      funcaoId: r.funcaoId,
      toolkit,
      acao,
      risco,
      // Sempre `null`: a acao acabou de ser vinculada e ninguem decidiu
      // ainda. A tela le isto e manda a pessoa para a etapa de permissoes.
      nivel: null,
      nivelSugerido: nivelRecomendado(risco),
      jaVinculada: r.estado === "ja_vinculada",
    }, r.estado === "ja_vinculada" ? 200 : 201);
  } catch {
    return responder({ ok: false, erro: FALHA }, 500);
  }
}

/**
 * A DECISAO do dono sobre UMA acao externa — §11/§16.
 *
 * Separado do POST de proposito. POST diz "o agente tem esta acao"; PATCH
 * diz "e ele pode usa-la assim". Fundir os dois foi o defeito do F7b.4.1.
 *
 * Nao passa por `PATCH /permissoes` porque aquela rota valida contra o
 * registry, e acao externa nao esta la. A prova de existencia aqui e o
 * VINCULO, conferida dentro do repositorio antes de gravar.
 */
export async function PATCH(request: Request, { params }: { params: { agenteId: string } }) {
  try {
    const porta = await atravessarPorta(request, params.agenteId, FALHA);
    if (!porta.ok) return porta.resposta;

    const corpo = await lerCorpo(request);
    if (corpo === null ||
        typeof corpo.funcaoId !== "string" || typeof corpo.nivel !== "string") {
      return responder({ ok: false, erro: "Informe a ação e o nível." }, 400);
    }

    const r = await definirPermissaoDeFerramentaExterna({
      userId: porta.userId,
      agenteId: porta.agenteId,
      funcaoId: corpo.funcaoId,
      nivel: corpo.nivel,
    });
    if (r.estado === "entrada_invalida") {
      return responder({ ok: false, erro: "Ação ou nível inválido." }, 400);
    }
    // 409: o pedido esta bem formado, e o agente que nao tem esta acao. A
    // pessoa precisa adicionar antes de decidir como usar.
    if (r.estado === "nao_vinculada") {
      return responder({
        ok: false, erro: "Esta ação não está adicionada a este agente.",
      }, 409);
    }
    if (r.estado !== "definida") {
      return responder({ ok: false, erro: "Nao foi possivel salvar a permissao." }, 500);
    }
    return responder({ ok: true, funcaoId: corpo.funcaoId, nivel: corpo.nivel }, 200);
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

    // §13: apaga o VINCULO, e nao toca na permissao.
    //
    // A linha de permissao fica onde esta, como registro de uma decisao
    // que o dono tomou um dia. Ela deixa de ter efeito porque nao e mais
    // ela que prova existencia: sem vinculo, `fatosDeFuncaoExterna` nao
    // afirma `existe`, a Funcao nao e declarada ao modelo e o guard a
    // nega. Por isso permissao historica nao ressuscita ferramenta
    // removida — a prova esta em `scripts/testar-ferramentas-externas.ts`.
    const r = await desvincularFerramentaExternaDoAgente({
      userId: porta.userId,
      agenteId: porta.agenteId,
      funcaoId,
    });
    if (r.estado === "entrada_invalida") {
      return responder({ ok: false, erro: "funcaoId externo inválido." }, 400);
    }
    if (r.estado === "falha") {
      return responder({ ok: false, erro: "Nao foi possivel remover a ferramenta." }, 500);
    }
    // `nao_encontrada` tambem e 200: o estado pedido (a acao nao esta mais
    // no agente) e o estado final, e nao ha nada a corrigir.
    return responder({ ok: true, funcaoId, removida: r.estado === "desvinculada" }, 200);
  } catch {
    return responder({ ok: false, erro: FALHA }, 500);
  }
}
