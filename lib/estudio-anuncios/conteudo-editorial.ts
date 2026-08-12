/**
 * Camada EDITORIAL humana — leitura, validação e criação de versões de
 * conteúdo por marketplace (2026-08-20).
 *
 * SEPARAÇÃO DE PAPÉIS, que é o princípio central desta camada:
 *
 *   `estudio_anuncios_resultados_pipeline`
 *     = histórico TÉCNICO imutável, produzido pelas etapas de IA.
 *
 *   `estudio_anuncios_conteudo_versoes`
 *     = histórico EDITORIAL humano, append-only.
 *
 * Uma edição manual **nunca** toca em `resultados_pipeline`, em `jobs`,
 * no Pipeline ou no score — ela cria uma versão nova. Nenhuma função
 * deste arquivo escreve em nenhuma tabela da Fase 1, e um teste varre o
 * código-fonte para garantir isso.
 *
 * APPEND-ONLY: editar a versão N cria a versão N+1. Nunca há `UPDATE` de
 * conteúdo — o único `UPDATE` da camada é o da flag `aprovado`, e ele
 * vive dentro da RPC de aprovação, nunca aqui.
 *
 * CRIAÇÃO LAZY: a versão 1 (snapshot da saída oficial de
 * `adaptacao_marketplace`) só é materializada quando existe intenção
 * editorial real — isto é, no primeiro save. Até lá, `resultados_pipeline`
 * segue sendo a única fonte, e a UI edita a partir dele. Isso evita
 * gravar conteúdo que talvez nunca seja editado e deixa explícito no
 * banco quando a camada editorial começou.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EnvelopeAdaptacaoMarketplace, AdaptacaoDeMarketplace } from "./adaptacao-marketplace-tipos";
import { CTAS_PERMITIDOS, MARKETPLACES_SUPORTADOS } from "./adaptacao-marketplace-tipos";

// ────────────────────────────────────────────────────────────────────
// Contrato editorial
// ────────────────────────────────────────────────────────────────────

/**
 * O que é editável. Deliberadamente um subconjunto do contrato de
 * `adaptacao_marketplace`: só o que é texto de anúncio. Fora daqui, por
 * decisão explícita: `marketplace` (define o canal, não é conteúdo),
 * qualquer id técnico, `schema_versao`, provedor/modelo, score, fatos
 * estruturados e dados da análise visual.
 *
 * `especificacoes` continua sendo par nome/valor — o domínio já é
 * estruturado e achatar para texto livre perderia informação.
 */
export interface ConteudoEditorial {
  titulo: string;
  descricao: string;
  bullets: string[];
  especificacoes: { nome: string; valor: string }[];
  cta?: string;
}

export const LIMITES = {
  tituloMax: 300,
  descricaoMax: 10_000,
  bulletMax: 500,
  bulletsMax: 20,
  especNomeMax: 120,
  especValorMax: 500,
  especificacoesMax: 40,
} as const;

export type OrigemVersao = "ia_adaptacao_marketplace" | "edicao_manual" | "ia_openai" | "revisao_claude";

export interface VersaoEditorialUI {
  id: string;
  numeroVersao: number;
  origem: OrigemVersao;
  conteudo: ConteudoEditorial;
  aprovado: boolean;
  aprovadoEm: string | null;
  aprovadoPor: string | null;
  criadoEm: string;
  criadoPor: string | null;
  /** Saída da IA que originou esta linha — responde "nasceu de qual resultado". */
  resultadoPipelineOrigemId: string | null;
}

export interface CanalEditorialUI {
  marketplace: string;
  projetoMarketplaceId: string;
  /** Conteúdo oficial da IA para este canal. `null` quando a adaptação ainda não existe. */
  baseIA: ConteudoEditorial | null;
  /** Resultado de `adaptacao_marketplace` que produziu `baseIA`. */
  baseResultadoId: string | null;
  /** Versão mais recente (maior `numero_versao`), independente de aprovação. */
  versaoAtual: VersaoEditorialUI | null;
  /** Versão aprovada ATUAL — no máximo uma, garantido por índice único parcial. */
  versaoAprovada: VersaoEditorialUI | null;
  historico: VersaoEditorialUI[];
  /** false quando não há adaptação: a UI mostra "Conteúdo ainda não disponível". */
  editavel: boolean;
}

// ────────────────────────────────────────────────────────────────────
// Conversão e validação — funções puras
// ────────────────────────────────────────────────────────────────────

/** Extrai o conteúdo editável de uma adaptação de marketplace. */
export function conteudoDaAdaptacao(a: AdaptacaoDeMarketplace): ConteudoEditorial {
  const base: ConteudoEditorial = {
    titulo: a.titulo,
    descricao: a.descricao,
    bullets: [...(a.bullets ?? [])],
    especificacoes: (a.especificacoes ?? []).map(e => ({ nome: e.nome, valor: e.valor })),
  };
  if (a.cta) base.cta = a.cta;
  return base;
}

export interface ResultadoValidacaoEditorial {
  valido: boolean;
  erro?: string;
  dados?: ConteudoEditorial;
}

const CHAVES_PERMITIDAS = new Set(["titulo", "descricao", "bullets", "especificacoes", "cta"]);
const CHAVES_ESPEC = new Set(["nome", "valor"]);

function ehTexto(v: unknown): v is string {
  return typeof v === "string";
}

/**
 * Valida o payload de uma edição manual.
 *
 * Edição manual é decisão HUMANA: o servidor **não** bloqueia uma mudança
 * só porque ela diverge do que a IA produziu — isso seria transformar a
 * camada editorial em censura. O que ele valida é forma: tipos, tamanhos,
 * campos obrigatórios e ausência de propriedade inesperada. Nenhuma
 * política específica de marketplace é aplicada aqui, porque não existe
 * fonte verificada dessas políticas no repositório.
 */
export function validarConteudoEditorial(bruto: unknown): ResultadoValidacaoEditorial {
  if (typeof bruto !== "object" || bruto === null || Array.isArray(bruto)) {
    return { valido: false, erro: "Conteúdo deve ser um objeto." };
  }
  const obj = bruto as Record<string, unknown>;

  for (const chave of Object.keys(obj)) {
    if (!CHAVES_PERMITIDAS.has(chave)) {
      return { valido: false, erro: `Campo não editável: "${chave}".` };
    }
  }

  if (!ehTexto(obj.titulo) || obj.titulo.trim().length === 0) {
    return { valido: false, erro: "Título é obrigatório." };
  }
  if (obj.titulo.length > LIMITES.tituloMax) {
    return { valido: false, erro: `Título acima de ${LIMITES.tituloMax} caracteres.` };
  }

  if (!ehTexto(obj.descricao) || obj.descricao.trim().length === 0) {
    return { valido: false, erro: "Descrição é obrigatória." };
  }
  if (obj.descricao.length > LIMITES.descricaoMax) {
    return { valido: false, erro: `Descrição acima de ${LIMITES.descricaoMax} caracteres.` };
  }

  if (!Array.isArray(obj.bullets)) {
    return { valido: false, erro: "bullets deve ser uma lista." };
  }
  if (obj.bullets.length > LIMITES.bulletsMax) {
    return { valido: false, erro: `Máximo de ${LIMITES.bulletsMax} destaques.` };
  }
  const bullets: string[] = [];
  for (const b of obj.bullets) {
    if (!ehTexto(b)) return { valido: false, erro: "Cada destaque deve ser texto." };
    if (b.length > LIMITES.bulletMax) return { valido: false, erro: `Destaque acima de ${LIMITES.bulletMax} caracteres.` };
    // Linha vazia é descartada em vez de rejeitada: o editor da UI cria
    // campos vazios naturalmente ao adicionar itens.
    if (b.trim().length > 0) bullets.push(b);
  }

  if (!Array.isArray(obj.especificacoes)) {
    return { valido: false, erro: "especificacoes deve ser uma lista." };
  }
  if (obj.especificacoes.length > LIMITES.especificacoesMax) {
    return { valido: false, erro: `Máximo de ${LIMITES.especificacoesMax} especificações.` };
  }
  const especificacoes: { nome: string; valor: string }[] = [];
  for (const e of obj.especificacoes) {
    if (typeof e !== "object" || e === null || Array.isArray(e)) {
      return { valido: false, erro: "Cada especificação deve ser um objeto {nome, valor}." };
    }
    const spec = e as Record<string, unknown>;
    for (const chave of Object.keys(spec)) {
      if (!CHAVES_ESPEC.has(chave)) return { valido: false, erro: `Campo não permitido em especificação: "${chave}".` };
    }
    if (!ehTexto(spec.nome) || !ehTexto(spec.valor)) {
      return { valido: false, erro: "Especificação precisa de nome e valor em texto." };
    }
    if (spec.nome.length > LIMITES.especNomeMax || spec.valor.length > LIMITES.especValorMax) {
      return { valido: false, erro: "Especificação acima do tamanho permitido." };
    }
    if (spec.nome.trim().length === 0 && spec.valor.trim().length === 0) continue;
    if (spec.nome.trim().length === 0) return { valido: false, erro: "Especificação sem nome." };
    especificacoes.push({ nome: spec.nome, valor: spec.valor });
  }

  const dados: ConteudoEditorial = { titulo: obj.titulo, descricao: obj.descricao, bullets, especificacoes };

  if (obj.cta !== undefined && obj.cta !== null && obj.cta !== "") {
    if (!ehTexto(obj.cta)) return { valido: false, erro: "CTA deve ser texto." };
    // A lista controlada continua valendo: ela existe para impedir promessa
    // inventada, e isso não deixa de valer porque a edição é humana.
    if (!(CTAS_PERMITIDOS as readonly string[]).includes(obj.cta)) {
      return { valido: false, erro: "CTA fora da lista permitida." };
    }
    dados.cta = obj.cta;
  }

  return { valido: true, dados };
}

// ────────────────────────────────────────────────────────────────────
// Leitura
// ────────────────────────────────────────────────────────────────────
interface LinhaVersao {
  id: string;
  projeto_marketplace_id: string;
  numero_versao: number;
  origem: string;
  titulo_principal: string | null;
  conteudo: unknown;
  aprovado: boolean;
  aprovado_em: string | null;
  aprovado_por: string | null;
  criado_em: string;
  criado_por: string | null;
  resultado_pipeline_origem_id: string | null;
}

function paraUI(l: LinhaVersao): VersaoEditorialUI {
  return {
    id: l.id,
    numeroVersao: l.numero_versao,
    origem: l.origem as OrigemVersao,
    conteudo: l.conteudo as ConteudoEditorial,
    aprovado: l.aprovado,
    aprovadoEm: l.aprovado_em,
    aprovadoPor: l.aprovado_por,
    criadoEm: l.criado_em,
    criadoPor: l.criado_por,
    resultadoPipelineOrigemId: l.resultado_pipeline_origem_id,
  };
}

/**
 * Estado editorial de todos os canais do projeto, em UMA passada — sem
 * N+1: uma consulta para os canais, uma para as versões de todos eles, e
 * a adaptação sai do resultado que o chamador já leu.
 */
export async function montarEditorialProjeto(
  supabase: SupabaseClient,
  projetoId: string,
  envelopeAdaptacao: EnvelopeAdaptacaoMarketplace | null,
  resultadoAdaptacaoId: string | null
): Promise<CanalEditorialUI[]> {
  const { data: canais, error } = await supabase
    .from("estudio_anuncios_projetos_marketplace")
    .select("id, marketplace")
    .eq("projeto_id", projetoId);
  if (error) throw new Error(`Falha ao ler canais do projeto: ${error.message}`);

  const linhasCanal = (canais ?? []) as { id: string; marketplace: string }[];
  if (linhasCanal.length === 0) return [];

  const ids = linhasCanal.map(c => c.id);
  const { data: versoes, error: erroV } = await supabase
    .from("estudio_anuncios_conteudo_versoes")
    .select("id, projeto_marketplace_id, numero_versao, origem, titulo_principal, conteudo, aprovado, aprovado_em, aprovado_por, criado_em, criado_por, resultado_pipeline_origem_id")
    .in("projeto_marketplace_id", ids);
  if (erroV) throw new Error(`Falha ao ler versões editoriais: ${erroV.message}`);

  const porCanal = new Map<string, LinhaVersao[]>();
  for (const v of (versoes ?? []) as LinhaVersao[]) {
    const lista = porCanal.get(v.projeto_marketplace_id) ?? [];
    lista.push(v);
    porCanal.set(v.projeto_marketplace_id, lista);
  }

  const adaptacoes = new Map(
    (envelopeAdaptacao?.saida?.adaptacoes ?? []).map(a => [a.marketplace as string, a])
  );

  return linhasCanal
    .sort((a, b) => a.marketplace.localeCompare(b.marketplace))
    .map(canal => {
      const lista = (porCanal.get(canal.id) ?? []).sort((a, b) => b.numero_versao - a.numero_versao);
      const adaptacao = adaptacoes.get(canal.marketplace) ?? null;
      const aprovada = lista.find(v => v.aprovado) ?? null;
      return {
        marketplace: canal.marketplace,
        projetoMarketplaceId: canal.id,
        baseIA: adaptacao ? conteudoDaAdaptacao(adaptacao) : null,
        baseResultadoId: adaptacao ? resultadoAdaptacaoId : null,
        versaoAtual: lista[0] ? paraUI(lista[0]) : null,
        versaoAprovada: aprovada ? paraUI(aprovada) : null,
        historico: lista.map(paraUI),
        // Sem adaptação não há o que editar — a UI mostra o estado em vez
        // de fabricar uma versão editorial vazia.
        editavel: adaptacao !== null,
      };
    });
}

/** Resolve o canal do projeto por nome de marketplace, garantindo que ele pertence ao projeto. */
export async function buscarCanalDoProjeto(
  supabase: SupabaseClient,
  projetoId: string,
  marketplace: string
): Promise<{ id: string; marketplace: string } | null> {
  if (!(MARKETPLACES_SUPORTADOS as readonly string[]).includes(marketplace)) return null;
  const { data, error } = await supabase
    .from("estudio_anuncios_projetos_marketplace")
    .select("id, marketplace")
    .eq("projeto_id", projetoId)
    .eq("marketplace", marketplace)
    .maybeSingle();
  if (error) throw new Error(`Falha ao resolver marketplace do projeto: ${error.message}`);
  return (data as { id: string; marketplace: string } | null) ?? null;
}

/** Versão de um canal, usada para validar o alvo da aprovação. */
export async function buscarVersaoDoCanal(
  supabase: SupabaseClient,
  projetoMarketplaceId: string,
  versaoId: string
): Promise<VersaoEditorialUI | null> {
  const { data, error } = await supabase
    .from("estudio_anuncios_conteudo_versoes")
    .select("id, projeto_marketplace_id, numero_versao, origem, titulo_principal, conteudo, aprovado, aprovado_em, aprovado_por, criado_em, criado_por, resultado_pipeline_origem_id")
    .eq("id", versaoId)
    .eq("projeto_marketplace_id", projetoMarketplaceId)
    .maybeSingle();
  if (error) throw new Error(`Falha ao ler versão: ${error.message}`);
  return data ? paraUI(data as LinhaVersao) : null;
}

// ────────────────────────────────────────────────────────────────────
// Escrita — sempre via RPC atômica, nunca INSERT/UPDATE solto
// ────────────────────────────────────────────────────────────────────

/**
 * Cria uma versão editorial. Toda a atomicidade (numeração sob
 * concorrência, materialização lazy da versão 1, idempotência por
 * `request_id`) vive na RPC — ver a migration 20260820 para o porquê de
 * cada uma. Aqui só se passa o que o servidor já derivou.
 */
export async function criarVersaoEditorial(
  supabaseServico: SupabaseClient,
  params: {
    projetoMarketplaceId: string;
    conteudo: ConteudoEditorial;
    origem: OrigemVersao;
    criadoPor: string;
    requestId: string | null;
    baseConteudo: ConteudoEditorial | null;
    baseResultadoId: string | null;
  }
): Promise<VersaoEditorialUI> {
  const { data, error } = await supabaseServico.rpc("estudio_anuncios_criar_versao_conteudo", {
    p_projeto_marketplace_id: params.projetoMarketplaceId,
    p_conteudo: params.conteudo,
    p_titulo: params.conteudo.titulo,
    p_origem: params.origem,
    p_criado_por: params.criadoPor,
    p_request_id: params.requestId,
    p_base_conteudo: params.baseConteudo,
    p_base_titulo: params.baseConteudo?.titulo ?? null,
    p_base_resultado_id: params.baseResultadoId,
  });
  if (error) throw new Error(`Falha ao criar versão editorial: ${error.message}`);
  return paraUI(data as LinhaVersao);
}

export async function aprovarVersaoEditorial(
  supabaseServico: SupabaseClient,
  versaoId: string,
  aprovadoPor: string
): Promise<VersaoEditorialUI> {
  const { data, error } = await supabaseServico.rpc("estudio_anuncios_aprovar_versao_conteudo", {
    p_versao_id: versaoId,
    p_aprovado_por: aprovadoPor,
  });
  if (error) throw new Error(`Falha ao aprovar versão: ${error.message}`);
  return paraUI(data as LinhaVersao);
}
