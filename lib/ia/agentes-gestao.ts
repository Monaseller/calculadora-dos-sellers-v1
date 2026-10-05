/**
 * Gestao de agentes — o que a pagina Agentes mostra. F8.3-C1.
 *
 * Modulo PURO: recebe o que os contratos reais ja devolvem e decide so
 * APRESENTACAO. Nao le rede, nao grava, nao inventa campo.
 *
 * ── Status: uma regra so ────────────────────────────────────────────
 *
 * O estado de cada agente e `aparenciaDoAgente` (a mesma do Escritorio),
 * aplicada aos `sinais` de `listarAgentesDoEscritorio`. Os filtros abaixo
 * so AGRUPAM esse estado; nenhum deles cria estado novo.
 *
 * ── API x Tool: derivado do DOMINIO — F9.2-A ────────────────────────
 *
 * Decisao de produto: API != Tool. Desde o F9.2-A quem decide isso e o
 * catalogo de APIs (`lib/agentes/apis/catalogo.ts`): Mercado Livre e
 * Shopee sao PROVIDERS. O pack `mercadolivre-perguntas` continua gravado
 * em agentes antigos e aqui e so o ALIAS do provider Mercado Livre — os
 * valores exportados abaixo sao os mesmos de antes, agora derivados.
 */
import type { AparenciaAgente } from "@/lib/ia/estados";
import type { TipoAgenteUI } from "@/lib/ia/contratos";
import type {
  ApiDoAgenteUI, AtivacaoDoAgenteUI, ConexaoRequisitoUI, ContaDaApiUI, FerramentaDaAtivacaoUI,
  FerramentaExternaVinculadaUI, LojaDoDonoUI,
} from "@/lib/ia/agentes-http";
import {
  PROVEDORES_DE_API, ehAliasDeApi, provedorDisponivelParaAgentes,
  type IdProvedorDeApi,
} from "@/lib/agentes/apis/catalogo";

/** O alias legado do provider Mercado Livre (id de pack persistido). */
export const PACK_API_MERCADO_LIVRE: string =
  PROVEDORES_DE_API.find((p) => p.id === "mercado_livre")?.aliasesLegados[0] ?? "mercadolivre-perguntas";

/** Packs que, no dominio, sao alias de um provider de API — nunca Tool. */
export const PACKS_APRESENTADOS_COMO_API: readonly string[] = Object.freeze(
  PROVEDORES_DE_API.flatMap((p) => p.aliasesLegados)
);

export function ehPackDeApi(packId: string): boolean {
  return ehAliasDeApi(packId);
}

// ── Filtros ──────────────────────────────────────────────────────────

export const CHAVES_DE_FILTRO_DA_LISTA = ["todos", "ativos", "atencao", "inativos"] as const;
export type FiltroAgentes = (typeof CHAVES_DE_FILTRO_DA_LISTA)[number];

export const ROTULO_DO_FILTRO: Record<FiltroAgentes, string> = {
  todos: "Todos",
  ativos: "Ativos",
  atencao: "Com atenção",
  inativos: "Inativos",
};

/**
 * O filtro, sobre o estado CANONICO:
 *   ativos   = agente ligado (nao `foraDeOperacao`)
 *   atencao  = ligado e em `aguardando_aprovacao` ou `erro`
 *   inativos = `foraDeOperacao`
 */
export function passaNoFiltro(filtro: FiltroAgentes, a: AparenciaAgente): boolean {
  if (filtro === "todos") return true;
  if (filtro === "inativos") return a.foraDeOperacao;
  if (filtro === "ativos") return !a.foraDeOperacao;
  return !a.foraDeOperacao && (a.estado === "aguardando_aprovacao" || a.estado === "erro");
}

/** Busca por nome (e funcao), sem acento e sem caixa. */
export function passaNaBusca(termo: string, nome: string, tipo: string): boolean {
  const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const t = norm(termo.trim());
  return t === "" || norm(`${nome} ${nomeDoTipo(tipo as TipoAgenteUI)}`).includes(t);
}

// ── Funcao (tipo) ────────────────────────────────────────────────────

/** O NOME de cada tipo (o CHECK de `agentes.tipo`). So rotulo. */
const NOME_DO_TIPO: Record<TipoAgenteUI, string> = {
  personalizado: "Personalizado",
  mensagens: "Mensagens",
  ads: "Ads",
  fotos: "Fotos",
  anuncios: "Anúncios",
  financeiro: "Financeiro",
  gerente: "Gerente",
};

export function nomeDoTipo(tipo: TipoAgenteUI): string {
  return NOME_DO_TIPO[tipo] ?? tipo;
}

// ── Projecao API x Tool ──────────────────────────────────────────────

export interface ProjecaoDeCapacidades {
  /** Packs apresentados como API (hoje: Mercado Livre), quando selecionados. */
  readonly packsDeApi: readonly FerramentaDaAtivacaoUI[];
  /** Acoes externas vinculadas (servicos de fora), apresentadas como API. */
  readonly externas: readonly FerramentaExternaVinculadaUI[];
  /** Ferramentas INTERNAS — o que a secao Tools mostra. */
  readonly tools: readonly FerramentaDaAtivacaoUI[];
  /** Quantas APIs distintas: packs de API + toolkits externos distintos. */
  readonly totalApis: number;
}

export function projetarCapacidades(ativacao: Pick<AtivacaoDoAgenteUI, "ferramentas" | "ferramentasExternas">): ProjecaoDeCapacidades {
  const packsDeApi = ativacao.ferramentas.filter((f) => ehPackDeApi(f.id));
  const tools = ativacao.ferramentas.filter((f) => !ehPackDeApi(f.id));
  const toolkits = new Set(ativacao.ferramentasExternas.map((e) => e.toolkit || e.funcaoId));
  return {
    packsDeApi,
    externas: ativacao.ferramentasExternas,
    tools,
    totalApis: packsDeApi.length + toolkits.size,
  };
}

// ── Modelo de IA ─────────────────────────────────────────────────────

export interface ResumoDaIa {
  /** Nome visivel do provedor que RESPONDE, ou null se nenhum. */
  readonly provedor: string | null;
  /** O id concreto do modelo, como o servidor resolveu. */
  readonly modelo: string | null;
  readonly indisponivel: boolean;
}

export function resumoDaIa(ativacao: Pick<AtivacaoDoAgenteUI, "provedor" | "modelo" | "modelos" | "iaDesfecho">): ResumoDaIa {
  const oferta = ativacao.modelos.find((m) => m.provedor === ativacao.provedor);
  return {
    provedor: oferta?.nome ?? ativacao.provedor,
    modelo: ativacao.modelo,
    indisponivel: ativacao.iaDesfecho === "escolhida_indisponivel",
  };
}

// ── Impedimento -> aba (F8.3-C1.5) ───────────────────────────────────

/** As abas da configuracao inline. Mesma ordem de `SECOES`. */
export type AbaDaConfiguracao = "Geral" | "Modelo de IA" | "APIs" | "Tools" | "Memória" | "Status";

/**
 * Onde, NA PROPRIA configuracao, se resolve cada impedimento de ativacao.
 *
 * Os codigos sao os do servidor (`lib/agentes/factory/ativacao.ts`); nada
 * e inventado. `permissao_incompleta` cobre packs de API (Mercado Livre) e
 * internos: vai para APIs so quando quem esta incompleto e pack de API.
 * Codigo desconhecido: `null` — a mensagem aparece, sem botao.
 */
export function abaDoImpedimento(
  codigo: string,
  ativacao: Pick<AtivacaoDoAgenteUI, "ferramentas">
): AbaDaConfiguracao | null {
  switch (codigo) {
    case "nome_ausente":
    case "instrucoes_ausentes":
      return "Geral";
    case "modelo_ausente":
    case "ia_escolhida_indisponivel":
    case "modelo_incompativel_com_ferramentas":
      return "Modelo de IA";
    case "conexao_sem_loja":
    case "ferramenta_externa_sem_permissao":
      return "APIs";
    case "permissao_incompleta": {
      const incompletos = ativacao.ferramentas.filter((f) => !f.completo);
      return incompletos.length > 0 && incompletos.every((f) => ehPackDeApi(f.id)) ? "APIs" : "Tools";
    }
    case "skill_sem_ferramenta":
      return "Tools";
    default:
      return null;
  }
}

/**
 * Trocar de agente com rascunho nao salvo: so com confirmacao explicita.
 * Sem rascunho, troca direto (sem perguntar nada).
 */
export function podeTrocarDeAgente(temRascunho: boolean, confirmar: () => boolean): boolean {
  return !temRascunho || confirmar();
}

// ── Integracoes da CDS (aba APIs) — F8.3-C1.6 ────────────────────────

/**
 * As integracoes que a CDS SUPORTA, na ordem em que aparecem.
 *
 * Fonte desde o F9.2-A: os PROVIDERS do catalogo de APIs. Identidade,
 * marketplace e plataforma vem de la; aqui so ficam logo e frase, que sao
 * apresentacao. `packId` e o alias legado do provider quando ele tem
 * capability para agentes; Shopee nao tem nenhuma ainda, entao `null` e a
 * tela diz isso, sem fingir capacidade.
 */
export interface IntegracaoCds {
  readonly chave: IdProvedorDeApi;
  readonly nome: string;
  /** Valor de `lojas.marketplace` para as contas desta integracao. */
  readonly marketplace: "ML" | "Shopee";
  /** `plataforma` dos requisitos de conexao do agente. */
  readonly plataforma: string;
  readonly logo: string;
  /** O pack de agente que usa a integracao; `null` = sem capacidade ainda. */
  readonly packId: string | null;
  readonly descricao: string;
}

/** So apresentacao, por provider. O resto vem do catalogo. */
const APRESENTACAO_DA_INTEGRACAO: Readonly<Record<IdProvedorDeApi, { logo: string; descricao: string }>> = {
  mercado_livre: {
    logo: "/logo-ml.svg",
    descricao: "Vendas, pedidos e perguntas da sua conta do Mercado Livre.",
  },
  shopee: {
    logo: "/logo-shopee.svg",
    descricao: "Conecte a conta da Shopee pela CDS. Ferramentas da Shopee para agentes ainda não existem.",
  },
};

export const INTEGRACOES_CDS: readonly IntegracaoCds[] = Object.freeze(
  PROVEDORES_DE_API.map((p) => Object.freeze({
    chave: p.id,
    nome: p.nome,
    marketplace: p.marketplace,
    plataforma: p.plataforma,
    logo: APRESENTACAO_DA_INTEGRACAO[p.id].logo,
    packId: provedorDisponivelParaAgentes(p.id) ? p.aliasesLegados[0] ?? null : null,
    descricao: APRESENTACAO_DA_INTEGRACAO[p.id].descricao,
  }))
);

/** As contas do dono que pertencem a uma integracao. */
export function contasDaIntegracao(
  integracao: Pick<IntegracaoCds, "marketplace">, lojas: readonly LojaDoDonoUI[]
): LojaDoDonoUI[] {
  return lojas.filter((l) => l.marketplace === integracao.marketplace);
}

/** O nome visivel de uma conta. Nunca o id. */
export function nomeDaConta(c: { nome: string | null; nickname: string | null }): string {
  const n = (c.nickname ?? c.nome ?? "").trim();
  return n.length > 0 ? n : "Conta sem nome";
}

/**
 * O que fazer ao "Conectar" uma integracao NESTE agente.
 *
 *   sem_requisito   o agente nao pede conta desta plataforma (nada a fazer)
 *   pronta          todo requisito tem conta escolhida e utilizavel
 *   auto            cada requisito pendente tem UMA conta elegivel: a tela
 *                   grava essa conta (um PATCH por requisito) e rele uma vez
 *   escolher        ha requisito com mais de uma conta elegivel, ou com uma
 *                   escolha que nao serve: o dono decide (nada automatico)
 *   conectar_conta  ha requisito sem nenhuma conta elegivel: abrir o fluxo
 *                   de conexao da CDS
 *
 * Automatico SO quando nao ha escolha anterior: uma selecao existente
 * (mesmo invalida) nunca e trocada sem o dono.
 */
export type PlanoDeConexao =
  | { tipo: "sem_requisito" }
  | { tipo: "pronta" }
  | { tipo: "auto"; gravar: readonly { plataforma: string; recurso: string; lojaId: string }[] }
  | { tipo: "escolher" }
  | { tipo: "conectar_conta" };

export function planoDeConexao(
  conexoes: readonly ConexaoRequisitoUI[], plataforma: string
): PlanoDeConexao {
  const daPlataforma = conexoes.filter((c) => c.plataforma === plataforma);
  if (daPlataforma.length === 0) return { tipo: "sem_requisito" };
  const pendentes = daPlataforma.filter((c) => !(c.lojaIdSelecionada !== null && c.utilizavel));
  if (pendentes.length === 0) return { tipo: "pronta" };
  if (pendentes.some((c) => c.lojasElegiveis.length === 0)) return { tipo: "conectar_conta" };
  if (pendentes.every((c) => c.lojaIdSelecionada === null && c.lojasElegiveis.length === 1)) {
    return {
      tipo: "auto",
      gravar: pendentes.map((c) => ({ plataforma: c.plataforma, recurso: c.recurso, lojaId: c.lojasElegiveis[0].id })),
    };
  }
  return { tipo: "escolher" };
}

// ── UMA conta por API — F9.2-A2 ──────────────────────────────────────

/**
 * O que a tela faz com UM provider, a partir de `GET /apis`.
 *
 *   indisponivel    o provider nao tem capability para agentes (Shopee):
 *                   so o selo "Ainda não disponível para agentes"
 *   pronta          a conta do provider esta escolhida e serve
 *   auto            nada escolhido (ou parte escolhida com UMA conta) e ha
 *                   uma conta possivel: grava essa conta no provider
 *   escolher        mais de uma conta possivel, conta escolhida que nao
 *                   serve mais, ou contas diferentes (divergente): o dono
 *                   escolhe UMA — nunca se troca escolha sem ele
 *   conectar_conta  nenhuma conta na CDS: abrir o fluxo de conexao
 *
 * Nao ha recurso aqui: perguntas/vendas sao detalhe do servidor.
 */
export type PlanoDaApi =
  | { tipo: "indisponivel" }
  | { tipo: "pronta"; lojaId: string }
  | { tipo: "auto"; lojaId: string }
  | { tipo: "escolher" }
  | { tipo: "conectar_conta" };

export function planoDaApi(
  api: Pick<ApiDoAgenteUI, "disponivelParaAgentes" | "conexoes" | "contaDoAgente">
): PlanoDaApi {
  if (!api.disponivelParaAgentes) return { tipo: "indisponivel" };
  const c = api.contaDoAgente;
  const elegivel = (id: string) => api.conexoes.some((l) => l.id === id);
  if (c.estado === "definida" && c.utilizavel && elegivel(c.lojaId)) return { tipo: "pronta", lojaId: c.lojaId };
  if (api.conexoes.length === 0) return { tipo: "conectar_conta" };
  // Completar o que ja foi escolhido com a MESMA conta nao e escolher por ele.
  if (c.estado === "incompleta" && elegivel(c.lojaId)) return { tipo: "auto", lojaId: c.lojaId };
  if ((c.estado === "nenhuma" || c.estado === "sem_requisito") && api.conexoes.length === 1) {
    return { tipo: "auto", lojaId: api.conexoes[0].id };
  }
  return { tipo: "escolher" };
}

/** A conta que o select do provider mostra: a escolhida, se for uma so. */
export function contaSelecionadaDaApi(api: Pick<ApiDoAgenteUI, "contaDoAgente">): string | null {
  const c = api.contaDoAgente;
  return c.estado === "definida" || c.estado === "incompleta" ? c.lojaId : null;
}

/** A conta EM USO (escolhida e utilizavel), para "Conta em uso: X". */
export function contaEmUsoDaApi(
  api: Pick<ApiDoAgenteUI, "conexoes" | "contaDoAgente">
): ContaDaApiUI | null {
  const c = api.contaDoAgente;
  if (c.estado !== "definida" || !c.utilizavel) return null;
  return api.conexoes.find((l) => l.id === c.lojaId) ?? null;
}

// ── Busca de Tools (aba Tools) — F8.3-C1.6 ───────────────────────────

/** Tools (packs INTERNOS) que batem com o termo, por nome ou descricao. */
export function filtrarTools<T extends { id: string; nome: string; descricao?: string }>(
  termo: string, packs: readonly T[]
): T[] {
  const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const t = norm(termo.trim());
  return packs.filter((p) => !ehPackDeApi(p.id) &&
    (t === "" || norm(`${p.nome} ${p.descricao ?? ""}`).includes(t)));
}
