/**
 * Leitura consolidada dos artefatos da Fase 1 para a UI de resultado.
 *
 * SOMENTE LEITURA. Nenhuma função aqui escreve, recalcula ou reinterpreta
 * artefato. O score, em particular, é **lido como foi persistido** —
 * nenhuma regra de pontuação é reimplementada aqui nem no client.
 *
 * FONTE OFICIAL, NUNCA A LEGADA: o score vem de
 * `estudio_anuncios_resultados_pipeline` com `etapa='calculo_score'`.
 * A tabela `estudio_anuncios_score` **não é lida** — ela é por
 * marketplace, não tem `job_id`/`schema_versao` e tem
 * `conversao_estimada`, que a Fase 1 deliberadamente não produz. Um
 * teste proíbe qualquer referência a ela neste arquivo.
 *
 * SEGURANÇA: nenhuma destas funções faz checagem de propriedade — quem
 * chama (a rota) já confirmou que o projeto é do usuário autenticado
 * ANTES de chamar, exatamente como pipeline/jobs/fotos já faziam. Todas
 * filtram explicitamente por `projeto_id`, então um artefato de outro
 * projeto nunca entra. `storage_path` nunca é devolvido ao client: sai
 * daqui só como URL assinada de curta duração, gerada na hora e nunca
 * persistida.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { gerarUrlAssinadaImagemGerada } from "./storage";
import type { AnaliseVisualCompleta } from "../ai-gateway/provedores/google-tipos";
import type { EnvelopeGeracaoConteudo, GeracaoConteudoIA } from "./geracao-conteudo-tipos";
import type { EnvelopeRevisaoClaude } from "./revisao-claude-tipos";
import type { EnvelopeAdaptacaoMarketplace } from "./adaptacao-marketplace-tipos";
import type { EnvelopeGeracaoPromptsImagem } from "./geracao-prompts-imagem-tipos";
import type { EnvelopeCalculoScore } from "./calculo-score-tipos";

/** Duração da URL assinada — curta de propósito: é para exibir agora, não para compartilhar. */
const URL_ASSINADA_SEGUNDOS = 900; // 15 min

// ────────────────────────────────────────────────────────────────────
// DTO de leitura — o que a UI realmente precisa, nada além
// ────────────────────────────────────────────────────────────────────

/** Item já classificado por origem — a distinção que dá valor real ao usuário. */
export interface AtributoVisual {
  valor: string;
  origem: string;
}

export interface AnaliseVisualUI {
  produtoIdentificado: string | null;
  marca: string | null;
  modelo: string | null;
  categoria: string[];
  resumoVisual: string;
  /** origem = "produto" — o que foi confirmado no produto em si. */
  confirmado: {
    cores: string[];
    materiais: string[];
    componentes: string[];
    caracteristicas: string[];
    usos: string[];
    publico: string[];
    atributos: { nome: string; valor: string }[];
  };
  /** Tudo que NÃO é do produto: embalagem, material promocional, indeterminado. */
  naoConfirmado: {
    itens: AtributoVisual[];
    informacoesNaoConfirmadas: string[];
    alertas: string[];
    textosLegiveis: string[];
  };
  qualidadeFotos: { nota: number; problemas: string[]; sugestoes: string[] } | null;
  totalFotosAnalisadas: number;
  analiseParcial: boolean;
}

export interface RevisaoUI {
  totalTrechos: number;
  totalAlterados: number;
  /** Só os trechos que MUDARAM — o resto é ruído para quem está lendo. */
  alteracoes: { ref: string; rotulo: string; textoOriginal: string; textoRevisado: string; motivo: string | null }[];
  observacoes: string[];
}

export interface ImagemGeradaUI {
  id: string;
  ordem: number | null;
  finalidade: string;
  finalidadeRotulo: string;
  principal: boolean;
  largura: number | null;
  altura: number | null;
  tamanhoBytes: number | null;
  mimeType: string | null;
  provedor: string | null;
  modelo: string | null;
  /** Curta duração, gerada na hora, nunca persistida. `null` quando o objeto sumiu do Storage. */
  urlAssinada: string | null;
}

export interface CustoEtapaUI {
  etapa: string;
  provedor: string;
  modelo: string;
  custoEstimadoUsd: number;
  tokensEntrada: number | null;
  tokensSaida: number | null;
  unidadesGeradas: number | null;
}

export interface CustosUI {
  totalEstimadoUsd: number;
  porEtapa: CustoEtapaUI[];
  /** true quando alguma linha tem tokens > 0 mas custo 0 — modelo sem preço cadastrado. */
  temModeloSemPreco: boolean;
}

export interface ResultadoProjetoUI {
  analiseVisual: AnaliseVisualUI | null;
  /** Conteúdo FINAL exibido: o revisado quando existe, senão o gerado. */
  conteudo: (GeracaoConteudoIA & { origem: "revisao_claude" | "geracao_conteudo" }) | null;
  revisao: RevisaoUI | null;
  marketplaces: EnvelopeAdaptacaoMarketplace["saida"]["adaptacoes"] | null;
  promptsImagem: { total: number; itens: { ordem: number; finalidade: string; principal: boolean; objetivo: string }[] } | null;
  imagens: ImagemGeradaUI[];
  score: EnvelopeCalculoScore | null;
  custos: CustosUI;
}

// ────────────────────────────────────────────────────────────────────
// Rótulos amigáveis — técnicos só aparecem em "detalhes técnicos"
// ────────────────────────────────────────────────────────────────────
const ROTULO_FINALIDADE: Record<string, string> = {
  capa_principal: "Capa principal",
  perspectiva: "Perspectiva",
  detalhes: "Detalhe",
  uso: "Em uso",
  embalagem: "Embalagem",
  beneficios: "Benefícios",
  medidas: "Medidas",
  promocional_secundaria: "Promocional",
};

const ROTULO_TRECHO: Record<string, string> = {
  tituloBase: "Título",
  descricaoCurta: "Descrição curta",
};

function rotuloTrecho(ref: string): string {
  if (ROTULO_TRECHO[ref]) return ROTULO_TRECHO[ref];
  const m = /^(bullet|descricaoLonga):(\d+)$/.exec(ref);
  if (m) return m[1] === "bullet" ? `Bullet ${Number(m[2]) + 1}` : `Parágrafo ${Number(m[2]) + 1}`;
  return ref;
}

// ────────────────────────────────────────────────────────────────────
// Leitores
// ────────────────────────────────────────────────────────────────────
export interface LinhaResultado {
  /** id do resultado — usado pela camada editorial para registrar de qual saída da IA a versão 1 nasceu. */
  id: string;
  etapa: string;
  schema_versao: number;
  resultado: any;
  criado_em: string;
}

/**
 * Todos os resultados do projeto, indexados por etapa. Se por qualquer
 * motivo houver mais de um resultado para a mesma etapa, fica o de
 * `criado_em` mais antigo — mas isso é só desempate defensivo de
 * exibição, nunca resolução de dependência (a Fase 1 garante 1 por job,
 * e nenhuma decisão de negócio é tomada aqui).
 */
export async function buscarResultadosPipelinePorProjeto(
  supabase: SupabaseClient,
  projetoId: string
): Promise<Map<string, LinhaResultado>> {
  const { data, error } = await supabase
    .from("estudio_anuncios_resultados_pipeline")
    .select("id, etapa, schema_versao, resultado, criado_em")
    .eq("projeto_id", projetoId);
  if (error) throw new Error(`Falha ao ler resultados do pipeline: ${error.message}`);

  const mapa = new Map<string, LinhaResultado>();
  for (const linha of (data ?? []) as LinhaResultado[]) {
    const existente = mapa.get(linha.etapa);
    if (!existente || linha.criado_em < existente.criado_em) mapa.set(linha.etapa, linha);
  }
  return mapa;
}

export async function buscarImagensGeradasPorProjeto(
  supabase: SupabaseClient,
  supabaseServico: SupabaseClient,
  projetoId: string
): Promise<ImagemGeradaUI[]> {
  const { data, error } = await supabase
    .from("estudio_anuncios_imagens_geradas")
    .select("id, prompt_ordem, finalidade, e_principal, largura_px, altura_px, tamanho_bytes, mime_type, provedor, modelo, storage_path, numero_versao")
    .eq("projeto_id", projetoId);
  if (error) throw new Error(`Falha ao ler imagens geradas: ${error.message}`);

  const linhas = (data ?? []) as {
    id: string; prompt_ordem: number | null; finalidade: string; e_principal: boolean;
    largura_px: number | null; altura_px: number | null; tamanho_bytes: number | null;
    mime_type: string | null; provedor: string | null; modelo: string | null;
    storage_path: string | null; numero_versao: number;
  }[];

  // Ordem estável de exibição: principal primeiro, depois pela ordem do
  // prompt, depois pela versão — nunca a ordem de retorno do banco.
  linhas.sort((a, b) => {
    if (a.e_principal !== b.e_principal) return a.e_principal ? -1 : 1;
    if ((a.prompt_ordem ?? 0) !== (b.prompt_ordem ?? 0)) return (a.prompt_ordem ?? 0) - (b.prompt_ordem ?? 0);
    return a.numero_versao - b.numero_versao;
  });

  return Promise.all(
    linhas.map(async l => ({
      id: l.id,
      ordem: l.prompt_ordem,
      finalidade: l.finalidade,
      finalidadeRotulo: ROTULO_FINALIDADE[l.finalidade] ?? l.finalidade,
      principal: l.e_principal,
      largura: l.largura_px,
      altura: l.altura_px,
      tamanhoBytes: l.tamanho_bytes,
      mimeType: l.mime_type,
      provedor: l.provedor,
      modelo: l.modelo,
      // Objeto ausente no Storage devolve null — a UI mostra "indisponível"
      // em vez de uma imagem quebrada.
      urlAssinada: l.storage_path
        ? await gerarUrlAssinadaImagemGerada(supabaseServico, l.storage_path, URL_ASSINADA_SEGUNDOS)
        : null,
    }))
  );
}

/**
 * Custo do projeto. Junta com `estudio_anuncios_jobs` para saber a etapa
 * de cada linha E para **descartar consumo órfão**: linha sem `job_id`,
 * ou cujo job não pertence a este projeto, não entra na soma.
 */
export async function buscarCustoProjeto(supabase: SupabaseClient, projetoId: string): Promise<CustosUI> {
  const { data, error } = await supabase
    .from("central_ia_consumo")
    .select("job_id, provedor, modelo, custo_estimado, tokens_entrada, tokens_saida, unidades_geradas")
    .eq("projeto_id", projetoId);
  if (error) throw new Error(`Falha ao ler consumo do projeto: ${error.message}`);

  const linhas = (data ?? []) as {
    job_id: string | null; provedor: string; modelo: string;
    custo_estimado: string | number | null; tokens_entrada: number | null;
    tokens_saida: number | null; unidades_geradas: number | null;
  }[];

  const { data: jobs, error: erroJobs } = await supabase
    .from("estudio_anuncios_jobs")
    .select("id, etapa")
    .eq("projeto_id", projetoId);
  if (erroJobs) throw new Error(`Falha ao ler jobs do projeto: ${erroJobs.message}`);
  const etapaPorJob = new Map((jobs ?? []).map(j => [(j as { id: string }).id, (j as { etapa: string }).etapa]));

  const porEtapa: CustoEtapaUI[] = [];
  let total = 0;
  let temModeloSemPreco = false;

  for (const l of linhas) {
    // Consumo órfão (sem job, ou job de outro projeto) nunca é somado.
    if (!l.job_id || !etapaPorJob.has(l.job_id)) continue;
    const custo = Number(l.custo_estimado ?? 0);
    const tokens = (l.tokens_entrada ?? 0) + (l.tokens_saida ?? 0);
    if (custo === 0 && tokens > 0 && l.provedor !== "fake") temModeloSemPreco = true;
    total += custo;
    porEtapa.push({
      etapa: etapaPorJob.get(l.job_id)!,
      provedor: l.provedor,
      modelo: l.modelo,
      custoEstimadoUsd: custo,
      tokensEntrada: l.tokens_entrada,
      tokensSaida: l.tokens_saida,
      unidadesGeradas: l.unidades_geradas,
    });
  }

  porEtapa.sort((a, b) => b.custoEstimadoUsd - a.custoEstimadoUsd || a.etapa.localeCompare(b.etapa));
  return { totalEstimadoUsd: total, porEtapa, temModeloSemPreco };
}

// ────────────────────────────────────────────────────────────────────
// Adaptadores de exibição — funções puras, testáveis sem banco
// ────────────────────────────────────────────────────────────────────
export function adaptarAnaliseVisual(analise: AnaliseVisualCompleta): AnaliseVisualUI {
  const doProduto = <T extends { origem: string }>(l: T[] | undefined) => (l ?? []).filter(i => i.origem === "produto");
  const foraDoProduto: AtributoVisual[] = [];

  const coletar = (lista: { origem: string }[] | undefined, extrair: (i: any) => string) => {
    for (const item of lista ?? []) {
      if (item.origem !== "produto") foraDoProduto.push({ valor: extrair(item), origem: item.origem });
    }
  };
  coletar(analise.cores, i => i.valor);
  coletar(analise.materiais, i => i.valor);
  coletar(analise.componentes, i => i.valor);
  coletar(analise.caracteristicasVisiveis, i => i.descricao);
  coletar(analise.possiveisUsos, i => i.descricao);
  coletar(analise.publicoProvavel, i => i.descricao);
  coletar(analise.atributosAdicionais, i => `${i.nome}: ${i.valor}`);

  return {
    produtoIdentificado: analise.produtoIdentificado ?? null,
    marca: analise.marca ?? null,
    modelo: analise.modelo ?? null,
    categoria: analise.categoriaProvavel ?? [],
    resumoVisual: analise.resumoVisual ?? "",
    confirmado: {
      cores: doProduto(analise.cores).map(i => i.valor),
      materiais: doProduto(analise.materiais).map(i => i.valor),
      componentes: doProduto(analise.componentes).map(i => i.valor),
      caracteristicas: doProduto(analise.caracteristicasVisiveis).map(i => i.descricao),
      usos: doProduto(analise.possiveisUsos).map(i => i.descricao),
      publico: doProduto(analise.publicoProvavel).map(i => i.descricao),
      atributos: doProduto(analise.atributosAdicionais).map(i => ({ nome: i.nome, valor: i.valor })),
    },
    naoConfirmado: {
      itens: foraDoProduto,
      informacoesNaoConfirmadas: analise.informacoesNaoConfirmadas ?? [],
      alertas: analise.alertas ?? [],
      textosLegiveis: (analise.textosLegiveis ?? []).map(t => t.texto),
    },
    qualidadeFotos: analise.qualidadeDasFotos ?? null,
    totalFotosAnalisadas: analise.metadadosAnalise?.totalFotosAnalisadas ?? 0,
    analiseParcial: analise.metadadosAnalise?.analiseParcial === true,
  };
}

export function adaptarRevisao(envelope: EnvelopeRevisaoClaude): RevisaoUI {
  const originalPorRef = new Map((envelope.entrada?.trechos ?? []).map(t => [t.ref, t.textoOriginal]));
  const textos = envelope.saida?.textos ?? [];
  return {
    totalTrechos: textos.length,
    totalAlterados: textos.filter(t => t.alterado).length,
    alteracoes: textos
      .filter(t => t.alterado)
      .map(t => ({
        ref: t.ref,
        rotulo: rotuloTrecho(t.ref),
        textoOriginal: originalPorRef.get(t.ref) ?? "",
        textoRevisado: t.textoRevisado,
        motivo: t.motivo ?? null,
      })),
    observacoes: envelope.saida?.observacoes ?? [],
  };
}

/**
 * Monta o DTO completo. Cada seção é independente: uma etapa ausente vira
 * `null` naquela seção, e nada mais quebra — a UI mostra "ainda não
 * disponível" só ali.
 */
export async function montarResultadoProjeto(
  supabase: SupabaseClient,
  supabaseServico: SupabaseClient,
  projetoId: string
): Promise<ResultadoProjetoUI> {
  const [resultados, imagens, custos] = await Promise.all([
    buscarResultadosPipelinePorProjeto(supabase, projetoId),
    buscarImagensGeradasPorProjeto(supabase, supabaseServico, projetoId),
    buscarCustoProjeto(supabase, projetoId),
  ]);

  const envAnalise = resultados.get("analise_visual")?.resultado as AnaliseVisualCompleta | undefined;
  const envConteudo = resultados.get("geracao_conteudo")?.resultado as EnvelopeGeracaoConteudo | undefined;
  const envRevisao = resultados.get("revisao_claude")?.resultado as EnvelopeRevisaoClaude | undefined;
  const envAdaptacao = resultados.get("adaptacao_marketplace")?.resultado as EnvelopeAdaptacaoMarketplace | undefined;
  const envPrompts = resultados.get("geracao_prompts_imagem")?.resultado as EnvelopeGeracaoPromptsImagem | undefined;
  const envScore = resultados.get("calculo_score")?.resultado as EnvelopeCalculoScore | undefined;

  // Conteúdo exibido é o REVISADO quando existe — é o que de fato seguiu
  // para a adaptação. A origem viaja junto para a UI poder dizer isso.
  const conteudoRevisado = envRevisao?.conteudoRevisado;
  const conteudoBase = envConteudo?.saida;
  const conteudo = conteudoRevisado
    ? { ...conteudoRevisado, origem: "revisao_claude" as const }
    : conteudoBase
      ? { ...conteudoBase, origem: "geracao_conteudo" as const }
      : null;

  return {
    analiseVisual: envAnalise ? adaptarAnaliseVisual(envAnalise) : null,
    conteudo,
    revisao: envRevisao ? adaptarRevisao(envRevisao) : null,
    marketplaces: envAdaptacao?.saida?.adaptacoes ?? null,
    promptsImagem: envPrompts?.prompts
      ? {
          total: envPrompts.prompts.length,
          itens: envPrompts.prompts.map(p => ({
            ordem: p.ordem,
            finalidade: ROTULO_FINALIDADE[p.tipo] ?? p.tipo,
            principal: p.principal,
            objetivo: p.objetivo,
          })),
        }
      : null,
    imagens,
    score: envScore ?? null,
    custos,
  };
}
