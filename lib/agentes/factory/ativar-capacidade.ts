import "server-only";

/**
 * Ativar uma capacidade pelo chat, e continuar a tarefa — F7b.4.6 §6–§9.
 *
 * ── O que "ativar" significa, exatamente ────────────────────────────
 *
 * Configuracao. Nao e acao no mundo (§7).
 *
 *   ativar Google Sheets   -> o agente PASSA A TER a capacidade
 *   ler uma planilha       -> roda sozinho (leitura)
 *   editar uma celula      -> pede confirmacao inline
 *
 * Confundir os dois faria "adicionar uma ferramenta" parecer perigoso e
 * "editar dados de alguem" parecer rotina. Sao coisas de naturezas
 * opostas, e o unico ponto em comum e que ambas exigem um clique do dono.
 *
 * ── A politica aplicada e a do contrato de EFEITO (§6/§19) ──────────
 *
 * Cada Funcao do pack recebe o nivel que o efeito dela pede:
 *
 *   READ_ONLY / CALCULATION   -> `automatico`, usavel na hora
 *   tudo o mais               -> `aprovacao`, confirmacao inline
 *
 * Nao ha default global. O nivel sai da classificacao de cada Funcao, que
 * por sua vez sai do `acesso` declarado no registry — nunca do nome.
 *
 * ── O que NAO acontece aqui ─────────────────────────────────────────
 *
 * Nenhuma credencial e criada, nenhum OAuth e concluido, nenhuma acao
 * externa e executada. Ativar uma integracao que exige conta deixa a
 * pendencia em `aguardando_conexao` — e a conexao e outro clique, com
 * outro consentimento.
 */
import { FUNCOES } from "@/lib/agentes/funcoes/registry";
import { TOOL_PACKS } from "@/lib/agentes/factory/catalogo-ui";
import { definirPermissaoDeFuncaoDoAgente } from "@/lib/agentes/permissoes/escrita";
import { herdarContaDoProvedor } from "@/lib/agentes/apis/servico";
import {
  definirPermissaoDeFerramentaExterna, vincularFerramentaExternaNoAgente,
} from "@/lib/agentes/ferramentas-externas/repositorio";
import { listarAcoesDoToolkit } from "@/lib/agentes/composio/cliente";
import { listarContasDoDono } from "@/lib/agentes/composio/conexao";
import {
  efeitoDaAcaoExterna, efeitoDaFuncaoInterna, nivelSugeridoParaEfeito,
} from "@/lib/agentes/factory/efeito";

export type ResultadoDaAtivacao =
  /** Pronta para usar agora. */
  | { readonly estado: "ativada"; readonly nome: string }
  /**
    * Ativada, e falta o dono conectar a conta do provedor.
    *
    * `reconectar` distingue duas situacoes que a mesma tela resolve com o
    * mesmo botao, mas que NAO sao a mesma frase — §10:
    *
    *   false  nunca houve conta deste aplicativo
    *   true   houve, e ela deixou de servir (expirou, foi revogada ou
    *          desativada no provedor)
    *
    * Dizer "conecte sua conta" a quem ja conectou faz a pessoa procurar o
    * que fez de errado. A acao e a mesma; a explicacao nao.
    */
  | {
      readonly estado: "aguardando_conexao";
      readonly nome: string;
      readonly toolkit: string;
      readonly reconectar: boolean;
    }
  | { readonly estado: "opcao_invalida" }
  | { readonly estado: "catalogo_indisponivel" }
  | { readonly estado: "falha" };

/**
 * Ativa um PACK interno.
 *
 * Todas as Funcoes do pack entram de uma vez: o dono escolheu "Planilhas",
 * e nao tres linhas. O nivel de cada uma vem do efeito dela — um pack de
 * leitura fica inteiro em `automatico`, e o proximo turno ja funciona.
 */
async function ativarPackInterno(entrada: {
  readonly userId: string;
  readonly agenteId: string;
  readonly packId: string;
}): Promise<ResultadoDaAtivacao> {
  const pack = TOOL_PACKS.find((p) => p.id === entrada.packId);
  if (pack === undefined) return { estado: "opcao_invalida" };

  for (const funcaoId of pack.funcoes) {
    const definicao = Object.prototype.hasOwnProperty.call(FUNCOES, funcaoId)
      ? FUNCOES[funcaoId]
      : undefined;
    // Uma Funcao do pack que nao existe no registry e defeito de catalogo,
    // nao motivo para conceder algo por engano.
    if (definicao === undefined) return { estado: "opcao_invalida" };

    const nivel = nivelSugeridoParaEfeito(
      efeitoDaFuncaoInterna({ funcaoId, acesso: definicao.acesso }));

    // F9.2-A2: a mesma heranca de conta do PATCH /permissoes, antes da
    // permissao. Tool passa direto; API com conta unica a reaproveita.
    const heranca = await herdarContaDoProvedor({
      userId: entrada.userId, agenteId: entrada.agenteId, funcaoId, nivel,
    });
    if (heranca.estado === "falha") return { estado: "falha" };

    const r = await definirPermissaoDeFuncaoDoAgente({
      userId: entrada.userId, agenteId: entrada.agenteId, funcaoId, nivel,
    });
    if (r.estado !== "definida") return { estado: "falha" };
  }

  // Pack que exige conexao de marketplace continua dependendo dela — o
  // binding de loja e outro sistema (`agente_conexoes`), com tela propria.
  // Aqui a capacidade fica configurada, e o guard cobra a conexao na hora.
  return { estado: "ativada", nome: pack.nome };
}

/** Quantas acoes de um toolkit externo entram de uma vez. */
const MAX_ACOES_EXTERNAS = 12;

/**
 * Ativa uma INTEGRACAO externa.
 *
 * ── Por que so as acoes de LEITURA entram ───────────────────────────
 *
 * Um toolkit tem dezenas de acoes, e boa parte escreve. Vincular todas
 * daria ao agente capacidade de alterar coisas que ninguem revisou — e o
 * dono pediu "consultar minhas vendas", nao "poder mexer em tudo".
 *
 * Entao a ativacao pelo chat traz o que o catalogo marca como
 * `readOnlyHint`. O resto continua disponivel pela tela de Ferramentas,
 * uma a uma, com a confirmacao que cada uma merece.
 */
async function ativarIntegracao(entrada: {
  readonly userId: string;
  readonly agenteId: string;
  readonly toolkit: string;
}): Promise<ResultadoDaAtivacao> {
  const cat = await listarAcoesDoToolkit(entrada.toolkit, 40);
  if (cat.estado === "nao_configurado") return { estado: "catalogo_indisponivel" };
  if (cat.estado !== "ok") return { estado: "catalogo_indisponivel" };

  const somenteLeitura = cat.dados.itens.filter((a) =>
    efeitoDaAcaoExterna({ slug: a.slug, tags: a.tags }) === "READ_ONLY");

  if (somenteLeitura.length === 0) {
    // Nada de leitura para oferecer: ativar so escrita pelo chat seria
    // conceder efeito sem revisao. Melhor nao ativar do que ativar demais.
    return { estado: "opcao_invalida" };
  }

  let precisaConta = false;
  for (const a of somenteLeitura.slice(0, MAX_ACOES_EXTERNAS)) {
    if (!a.semAutenticacao) precisaConta = true;

    const v = await vincularFerramentaExternaNoAgente({
      userId: entrada.userId, agenteId: entrada.agenteId,
      provedorExterno: "composio", toolkit: entrada.toolkit, acao: a.slug,
    });
    if (v.estado === "falha") return { estado: "falha" };
    if (v.estado === "entrada_invalida") continue;

    // Leitura entra em `automatico` — §19. O turno seguinte ja usa.
    const p = await definirPermissaoDeFerramentaExterna({
      userId: entrada.userId, agenteId: entrada.agenteId,
      funcaoId: v.funcaoId, nivel: "automatico",
    });
    if (p.estado !== "definida") return { estado: "falha" };
  }

  const nome = entrada.toolkit;
  if (!precisaConta) return { estado: "ativada", nome };

  // ── A conta ja existe? ────────────────────────────────────────────
  //
  // Se o dono ja conectou este aplicativo antes, nao ha o que pedir: a
  // capacidade esta pronta. Perguntar de novo seria ignorar o que ele ja
  // fez — e o §24 nomeia esse caso.
  const contas = await listarContasDoDono({
    userId: entrada.userId, toolkit: entrada.toolkit,
  });
  const conectada = contas.estado === "ok" &&
    contas.dados.some((c) => c.estado === "conectada");

  // §10: a MESMA leitura ja diz se houve conta antes, sem chamada extra.
  //
  // `com_problema` sozinho NAO basta, e isso foi medido: um link emitido e
  // abandonado tambem termina `EXPIRED`. `autorizouAntes` e a evidencia de
  // que a autorizacao chegou a comecar — sem ela nao se afirma nada.
  //
  // `aguardando_dono` tambem nao conta: ali a conexao foi comecada e nao
  // terminada, e o caminho e concluir, nao reconectar.
  const houveConta = contas.estado === "ok" &&
    contas.dados.some((c) => c.estado === "com_problema" && c.autorizouAntes);

  return conectada
    ? { estado: "ativada", nome }
    : {
        estado: "aguardando_conexao", nome, toolkit: entrada.toolkit,
        reconectar: houveConta,
      };
}

/**
 * Ativa a opcao escolhida.
 *
 * `origem` vem da linha CONGELADA da pendencia, e nao do corpo do pedido:
 * o cliente diz QUAL das opcoes, e a CDS sabe o que cada uma e.
 */
export async function ativarCapacidade(entrada: {
  readonly userId: string;
  readonly agenteId: string;
  readonly chave: string;
  readonly origem: "cds" | "integracao";
}): Promise<ResultadoDaAtivacao> {
  if (!entrada.userId || !entrada.agenteId || entrada.chave.trim() === "") {
    return { estado: "opcao_invalida" };
  }
  return entrada.origem === "cds"
    ? ativarPackInterno({
        userId: entrada.userId, agenteId: entrada.agenteId, packId: entrada.chave,
      })
    : ativarIntegracao({
        userId: entrada.userId, agenteId: entrada.agenteId, toolkit: entrada.chave,
      });
}
