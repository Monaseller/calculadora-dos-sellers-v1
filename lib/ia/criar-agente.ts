/**
 * Criar agente — o fluxo visual de 6 etapas (F8.3-C2). PURO: sem rede,
 * sem React. A tela (`components/ia/criar/CriarAgente.tsx`) le daqui.
 *
 * ── O que esta camada NAO muda ──────────────────────────────────────
 *
 * O servidor continua falando nas 11 etapas do Wizard antigo: cada
 * impedimento de ativacao traz `etapa` desse numero (ver
 * `lib/agentes/factory/ativacao.ts`). Nada disso foi renumerado. Esta
 * camada so TRADUZ, para a tela, onde cada coisa se resolve agora.
 */
import type { TipoAgenteUI } from "@/lib/ia/contratos";
import type { AtivacaoDoAgenteUI, MemoriaDoAgenteUI } from "@/lib/ia/agentes-http";
import { ROTULO_DO_PROVEDOR, rotuloDoNivel } from "@/lib/agentes/factory/catalogo-de-modelos";
import { PACK_API_MERCADO_LIVRE, abaDoImpedimento, projetarCapacidades } from "@/lib/ia/agentes-gestao";

// ── As 6 etapas ──────────────────────────────────────────────────────

export interface EtapaDeCriacao {
  readonly numero: 1 | 2 | 3 | 4 | 5 | 6;
  readonly titulo: string;
  readonly subtitulo: string;
}

export const ETAPAS_DE_CRIACAO: readonly EtapaDeCriacao[] = Object.freeze([
  { numero: 1, titulo: "Identidade", subtitulo: "Nome e função do agente" },
  { numero: 2, titulo: "Modelo de IA", subtitulo: "Escolha o modelo e parâmetros" },
  { numero: 3, titulo: "APIs", subtitulo: "Conecte as integrações" },
  { numero: 4, titulo: "Tools", subtitulo: "Configure ferramentas" },
  { numero: 5, titulo: "Memória", subtitulo: "Defina o contexto" },
  { numero: 6, titulo: "Criar", subtitulo: "Revise e finalize" },
] as const);

export type NumeroDaEtapa = EtapaDeCriacao["numero"];

export function etapaValida(n: unknown): NumeroDaEtapa | null {
  const v = typeof n === "string" ? Number(n) : n;
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 6 ? (v as NumeroDaEtapa) : null;
}

/**
 * As 11 etapas do Wizard antigo -> as 6 novas. `null` = saiu do fluxo
 * inicial (continua existindo fora dele).
 *
 *   1 Identidade  -> 1      2 Instrucoes -> 1      3 IA -> 2
 *   4 Ferramentas -> 4 (o pack do ML e MOSTRADO em APIs, etapa 3)
 *   5 Skills      -> null (assistente de configuracao existente)
 *   6 Memoria     -> 5      7 Arquivos   -> null (idem)
 *   8 Permissoes  -> 4 (o nivel fica junto da Tool / API, inline)
 *   9 Rotinas     -> null (so "manual" existia; nada a escolher)
 *   10 Testar     -> null (o chat normal e o teste)
 *   11 Revisar e Ativar -> 6
 */
export const ETAPA_ANTIGA_PARA_NOVA: Readonly<Record<number, NumeroDaEtapa | null>> = Object.freeze({
  1: 1, 2: 1, 3: 2, 4: 4, 5: null, 6: 5, 7: null, 8: 4, 9: null, 10: null, 11: 6,
});

const ETAPA_DA_ABA: Readonly<Record<string, NumeroDaEtapa>> = Object.freeze({
  Geral: 1, "Modelo de IA": 2, APIs: 3, Tools: 4, "Memória": 5, Status: 6,
});

/**
 * Onde, NESTE fluxo, se resolve um impedimento do servidor. Pelo CODIGO
 * (a mesma regra da pagina Agentes); codigo desconhecido cai no numero de
 * etapa que o servidor mandou, traduzido; sem traducao, `null`.
 */
export function etapaDoImpedimento(
  impedimento: { codigo: string; etapa: number },
  ativacao: Pick<AtivacaoDoAgenteUI, "ferramentas">
): NumeroDaEtapa | null {
  const aba = abaDoImpedimento(impedimento.codigo, ativacao);
  if (aba !== null) return ETAPA_DA_ABA[aba] ?? null;
  return ETAPA_ANTIGA_PARA_NOVA[impedimento.etapa] ?? null;
}

// ── Etapa 1: Funcao ──────────────────────────────────────────────────

/**
 * As funcoes em cards. Os valores sao os do CHECK de `agentes.tipo`
 * (`TIPOS_AGENTE`) — nenhum novo. A funcao e rotulo/identidade: nao da
 * nem tira capacidade (isso e APIs e Tools).
 */
export const FUNCOES_DE_CRIACAO: readonly { readonly tipo: TipoAgenteUI; readonly rotulo: string }[] = Object.freeze([
  { tipo: "mensagens", rotulo: "Mensagens" },
  { tipo: "financeiro", rotulo: "Financeiro" },
  { tipo: "ads", rotulo: "ADS" },
  { tipo: "anuncios", rotulo: "Anúncios" },
  { tipo: "fotos", rotulo: "Fotos" },
  { tipo: "gerente", rotulo: "Gerente" },
  { tipo: "personalizado", rotulo: "Personalizado" },
] as const);

export function rotuloDaFuncao(tipo: TipoAgenteUI): string {
  return FUNCOES_DE_CRIACAO.find((f) => f.tipo === tipo)?.rotulo ?? "Personalizado";
}

// ── Etapa 3: capacidades do Mercado Livre ────────────────────────────

/**
 * O que a tela pode mostrar como capacidade do ML. `funcao` e a Funcao
 * REAL do pack; `null` = nao existe ainda e aparece DESABILITADA, como
 * "Ainda não disponível". Nada aqui e selecionavel por item: as Funcoes
 * do pack entram juntas (o pack e a unidade que o contrato grava).
 */
export const CAPACIDADES_MERCADO_LIVRE: readonly { readonly rotulo: string; readonly funcao: string | null }[] =
  Object.freeze([
    { rotulo: "Consultar vendas", funcao: "mercadolivre.vendas.consultar" },
    { rotulo: "Consultar perguntas", funcao: "mercadolivre.perguntas.listar" },
    { rotulo: "Ler mensagens", funcao: null },
    { rotulo: "Responder mensagens", funcao: null },
  ] as const);

export { PACK_API_MERCADO_LIVRE };

// ── Resumo (coluna direita) ──────────────────────────────────────────

export interface LinhaDoResumo {
  readonly rotulo: "Nome" | "Função" | "Modelo de IA" | "APIs" | "Tools" | "Memória";
  /** `null` = ainda nao escolhido (a tela mostra um traco). */
  readonly valor: string | null;
}

/**
 * O resumo SO com o que ja foi escolhido de verdade: identidade digitada
 * e, depois que o agente existe, o que o SERVIDOR devolveu na ativacao.
 */
export function resumoDoAgente(entrada: {
  nome: string;
  tipo: TipoAgenteUI;
  ativacao: AtivacaoDoAgenteUI | null;
  memorias: readonly MemoriaDoAgenteUI[] | null;
}): readonly LinhaDoResumo[] {
  const { ativacao } = entrada;
  const nome = entrada.nome.trim() === "" ? null : entrada.nome.trim();
  let modelo: string | null = null;
  let apis: string | null = null;
  let tools: string | null = null;
  let memoria: string | null = null;
  if (ativacao !== null) {
    const escolhido = ativacao.modelos.find((m) => m.provedor === ativacao.provedorEscolhido);
    if (escolhido !== undefined) {
      const nivel = escolhido.niveis.length > 1
        ? rotuloDoNivel(ativacao.nivelDeTrabalho ?? escolhido.niveis[0]) : null;
      modelo = nivel === null ? escolhido.nome : `${escolhido.nome} · ${nivel}`;
    }
    const cap = projetarCapacidades(ativacao);
    const nomesApi = [
      ...cap.packsDeApi.map(() => "Mercado Livre"),
      ...new Set(cap.externas.map((e) => e.toolkit || "Integração externa")),
    ];
    apis = nomesApi.length === 0 ? "Nenhuma" : nomesApi.join(", ");
    tools = cap.tools.length === 0 ? "Nenhuma" : cap.tools.map((t) => t.nome).join(", ");
    const fixadas = (entrada.memorias ?? []).filter((m) => m.ativo).length;
    memoria = (ativacao.memoriaAtiva ? "Ativada" : "Desativada") +
      (fixadas > 0 ? ` · ${fixadas} fixada${fixadas === 1 ? "" : "s"}` : "");
  }
  return [
    { rotulo: "Nome", valor: nome },
    { rotulo: "Função", valor: rotuloDaFuncao(entrada.tipo) },
    { rotulo: "Modelo de IA", valor: modelo },
    { rotulo: "APIs", valor: apis },
    { rotulo: "Tools", valor: tools },
    { rotulo: "Memória", valor: memoria },
  ];
}

/** O nome do provedor, para provedores que o ambiente NAO configurou. */
export function nomeDoProvedor(provedor: string): string {
  return (ROTULO_DO_PROVEDOR as Record<string, string>)[provedor] ?? provedor;
}

// ── Destinos depois de criar ─────────────────────────────────────────

export function destinosDoAgenteCriado(id: string): { agentes: string; escritorio: string } {
  const q = encodeURIComponent(id);
  return { agentes: `/ia/agentes?agente=${q}`, escritorio: `/ia?agente=${q}` };
}

/** O endereco do proprio fluxo para um rascunho (refresh volta nele). */
export function enderecoDoRascunho(id: string, etapa: NumeroDaEtapa): string {
  return `/ia/agentes/novo?agente=${encodeURIComponent(id)}&etapa=${etapa}`;
}
