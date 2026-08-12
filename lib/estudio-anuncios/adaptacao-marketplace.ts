/**
 * Orquestração da etapa `adaptacao_marketplace` — domínio puro +
 * pré-condições + validação determinística + chamada ao provedor.
 *
 * Mesma divisão já usada em geracao-conteudo.ts: este arquivo NÃO
 * decide provedor, NÃO registra prompt/consumo, NÃO avança Pipeline e
 * NÃO persiste resultado — tudo isso é do executor/rota. Aqui só:
 * validar origem, montar entrada, montar prompt, chamar, validar a
 * resposta e devolver o envelope.
 *
 * O que esta etapa NUNCA faz (papel definido na tarefa): pesquisar,
 * olhar fotos, chamar Storage, reinterpretar analise_visual, criar
 * fatos, gerar imagens, calcular score. Não há import de storage.ts nem
 * de analise-visual.ts neste arquivo — a ausência é proposital e
 * verificada por teste.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { ErroProvedorIA, chamarGeminiTexto, obterModeloAdaptacaoMarketplace } from "../ai-gateway/provedores/google";
import { ADAPTACAO_MARKETPLACE_JSON_SCHEMA } from "../ai-gateway/provedores/google-adaptacao-marketplace-schema";
import type { ContextoExecucaoJob } from "./executar-job";
import type { GeracaoConteudoIA, EnvelopeGeracaoConteudo } from "./geracao-conteudo-tipos";
import { SCHEMA_VERSAO_GERACAO_CONTEUDO } from "./geracao-conteudo-tipos";
import type { EnvelopeRevisaoClaude } from "./revisao-claude-tipos";
import { SCHEMA_VERSAO_REVISAO_CLAUDE } from "./revisao-claude-tipos";
import type {
  AdaptacaoDeMarketplace,
  AdaptacaoMarketplaceIA,
  EntradaAdaptacaoMarketplace,
  EnvelopeAdaptacaoMarketplace,
  EspecificacaoAdaptada,
  FonteGeracaoConteudo,
  MarketplaceSuportado,
} from "./adaptacao-marketplace-tipos";
import {
  CTAS_PERMITIDOS,
  SCHEMA_VERSAO_ADAPTACAO_MARKETPLACE,
  isMarketplaceSuportado,
} from "./adaptacao-marketplace-tipos";

// ────────────────────────────────────────────────────────────────────
// Restrições apresentadas ao modelo — congeladas junto do resultado.
// ────────────────────────────────────────────────────────────────────
export const RESTRICOES_ADAPTACAO: string[] = [
  "Nunca inventar fatos que não estejam no conteúdo-base.",
  "Nunca criar especificações novas.",
  "Nunca transformar hipótese ou ressalva em afirmação categórica.",
  "Nunca adicionar promessa, garantia, prazo, frete, preço ou promoção.",
  "Nunca adicionar alegação clínica, terapêutica ou de saúde.",
  "Nunca alterar marca, modelo, quantidade, unidade ou medida.",
  "Nunca criar benefício que não exista no conteúdo-base.",
  "Nunca contradizer o conteúdo-base.",
  "Adaptar apenas formato, estrutura, extensão e terminologia.",
];

/**
 * Diretrizes de FORMATO por marketplace. Deliberadamente restritas a
 * formato/tom — nenhuma regra comercial, de política de anúncio ou de
 * limite de caracteres é afirmada aqui, porque não há fonte verificada
 * dessas políticas no repositório. Tratar limites/políticas reais de
 * cada canal como pendência de compliance (ver NEXT_TASK.md), nunca
 * inventar número.
 */
const DIRETRIZES_POR_MARKETPLACE: Record<MarketplaceSuportado, string> = {
  ML: "Título conciso e objetivo. Linguagem comercial neutra, sem excesso de símbolos ou caixa alta. Estrutura compatível com anúncio de catálogo.",
  Shopee: "Tom mais comercial e direto. Descrição pode ser mais flexível e escaneável. Nunca mencionar promoção, cupom ou preço.",
  Amazon: "Estrutura mais técnica e padronizada. Bullets objetivos, um atributo por bullet. Linguagem formal, sem apelo emocional.",
  "TikTok Shop": "Tom curto, direto e conversacional. Frases breves. Nenhuma promessa de resultado ou desempenho.",
};

// ────────────────────────────────────────────────────────────────────
// Entrada e prompt
// ────────────────────────────────────────────────────────────────────
export function montarEntradaAdaptacao(
  conteudoBase: GeracaoConteudoIA,
  marketplacesAlvo: MarketplaceSuportado[]
): EntradaAdaptacaoMarketplace {
  return {
    conteudoBase,
    marketplacesAlvo,
    ctasPermitidos: [...CTAS_PERMITIDOS],
    restricoes: RESTRICOES_ADAPTACAO,
  };
}

export function montarPromptAdaptacao(entrada: EntradaAdaptacaoMarketplace): string {
  const linhas: string[] = [];
  linhas.push(
    "Você adapta um conteúdo de anúncio JÁ VALIDADO para o formato de cada marketplace indicado.",
    "Você NÃO analisa o produto. Você NÃO acrescenta informação. Você reformata.",
    "",
    "REGRAS INVIOLÁVEIS:"
  );
  for (const r of entrada.restricoes) linhas.push(`- ${r}`);
  linhas.push(
    "",
    "CONTEÚDO-BASE (única fonte de verdade permitida):",
    JSON.stringify(entrada.conteudoBase, null, 1),
    "",
    "MARKETPLACES-ALVO e diretrizes de formato:"
  );
  for (const mk of entrada.marketplacesAlvo) {
    linhas.push(`- ${mk}: ${DIRETRIZES_POR_MARKETPLACE[mk]}`);
  }
  linhas.push(
    "",
    "CTA: opcional. Se usar, copie EXATAMENTE uma das opções abaixo. Nunca escreva outro texto de CTA.",
    ...entrada.ctasPermitidos.map(c => `- "${c}"`),
    "",
    "ESPECIFICAÇÕES: se incluir, cada nome/valor deve corresponder a uma especificação existente no conteúdo-base.",
    "Você pode omitir especificações, nunca criar ou alterar valores.",
    "",
    `Produza exatamente ${entrada.marketplacesAlvo.length} adaptação(ões), uma por marketplace-alvo, sem repetir marketplace.`
  );
  return linhas.join("\n");
}

// ────────────────────────────────────────────────────────────────────
// Validação estrutural (forma) — independente do provedor
// ────────────────────────────────────────────────────────────────────
function ehObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function textoNaoVazio(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

const CHAVES_ADAPTACAO = new Set(["marketplace", "titulo", "bullets", "descricao", "especificacoes", "cta"]);
const CHAVES_ESPEC = new Set(["nome", "valor"]);

export function validarEstruturaAdaptacao(json: unknown): AdaptacaoMarketplaceIA {
  if (!ehObjeto(json)) throw new ErroProvedorIA("validation", "Resposta não é um objeto JSON.");
  for (const chave of Object.keys(json)) {
    if (chave !== "adaptacoes") {
      throw new ErroProvedorIA("validation", `Propriedade extra não permitida na raiz: "${chave}".`);
    }
  }
  const bruto = json.adaptacoes;
  if (!Array.isArray(bruto) || bruto.length === 0) {
    throw new ErroProvedorIA("validation", "Campo obrigatório 'adaptacoes' ausente ou vazio.");
  }

  const adaptacoes: AdaptacaoDeMarketplace[] = [];
  for (const item of bruto) {
    if (!ehObjeto(item)) throw new ErroProvedorIA("validation", "Item de 'adaptacoes' não é objeto.");
    for (const chave of Object.keys(item)) {
      if (!CHAVES_ADAPTACAO.has(chave)) {
        throw new ErroProvedorIA("validation", `Propriedade extra não permitida em adaptação: "${chave}".`);
      }
    }
    if (!isMarketplaceSuportado(item.marketplace)) {
      throw new ErroProvedorIA("validation", `Marketplace inválido: ${JSON.stringify(item.marketplace)}.`);
    }
    if (!textoNaoVazio(item.titulo)) throw new ErroProvedorIA("validation", `Título vazio ou ausente em ${item.marketplace}.`);
    if (!textoNaoVazio(item.descricao)) throw new ErroProvedorIA("validation", `Descrição vazia ou ausente em ${item.marketplace}.`);

    const adaptacao: AdaptacaoDeMarketplace = {
      marketplace: item.marketplace,
      titulo: item.titulo,
      descricao: item.descricao,
    };

    if (item.bullets !== undefined) {
      if (!Array.isArray(item.bullets) || item.bullets.some(b => !textoNaoVazio(b))) {
        throw new ErroProvedorIA("validation", `bullets inválido em ${item.marketplace} (array de texto não-vazio, ou chave ausente).`);
      }
      adaptacao.bullets = item.bullets as string[];
    }

    if (item.especificacoes !== undefined) {
      if (!Array.isArray(item.especificacoes)) {
        throw new ErroProvedorIA("validation", `especificacoes inválido em ${item.marketplace}.`);
      }
      const specs: EspecificacaoAdaptada[] = [];
      for (const e of item.especificacoes) {
        if (!ehObjeto(e)) throw new ErroProvedorIA("validation", `Especificação não é objeto em ${item.marketplace}.`);
        for (const chave of Object.keys(e)) {
          if (!CHAVES_ESPEC.has(chave)) {
            throw new ErroProvedorIA("validation", `Propriedade extra em especificação: "${chave}".`);
          }
        }
        if (!textoNaoVazio(e.nome) || !textoNaoVazio(e.valor)) {
          throw new ErroProvedorIA("validation", `Especificação com nome/valor vazio em ${item.marketplace}.`);
        }
        specs.push({ nome: e.nome, valor: e.valor });
      }
      adaptacao.especificacoes = specs;
    }

    if (item.cta !== undefined) {
      if (typeof item.cta !== "string" || !(CTAS_PERMITIDOS as readonly string[]).includes(item.cta)) {
        throw new ErroProvedorIA("validation", `CTA fora da lista controlada: ${JSON.stringify(item.cta)}.`);
      }
      adaptacao.cta = item.cta as AdaptacaoDeMarketplace["cta"];
    }

    adaptacoes.push(adaptacao);
  }

  return { adaptacoes };
}

// ────────────────────────────────────────────────────────────────────
// Validação de INTEGRIDADE (conteúdo) — o que impede invenção de fato
// ────────────────────────────────────────────────────────────────────
export interface ResultadoValidacaoAdaptacao {
  valido: boolean;
  motivo?: string;
}

/** Normaliza para comparação tolerante a caixa/acento/pontuação/espaço — nunca altera o dado persistido. */
function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Todo texto do conteúdo-base concatenado e normalizado — usado como corpus de referência. */
function corpusDoConteudoBase(base: GeracaoConteudoIA): string {
  const partes: string[] = [base.tituloBase.texto, base.descricaoCurta.texto];
  for (const b of base.bullets ?? []) partes.push(b.texto);
  for (const p of base.descricaoLonga ?? []) partes.push(p.texto);
  for (const e of base.especificacoes ?? []) partes.push(e.nome, e.valor);
  if (base.publicoSugerido) partes.push(base.publicoSugerido.texto);
  return normalizar(partes.join(" "));
}

/**
 * Termos que jamais podem aparecer na adaptação se não existirem no
 * conteúdo-base. Cobre exatamente as proibições da tarefa: promessa
 * promocional, alegação clínica e garantia. Não é um filtro de
 * linguagem geral — é uma checagem de introdução de categoria nova.
 */
const TERMOS_PROIBIDOS_SE_AUSENTES_NA_BASE = [
  "gratis", "frete gratis", "desconto", "promocao", "oferta", "cupom", "off",
  "garantia", "garantido", "melhor preco", "imperdivel", "ultimas unidades",
  "cura", "trata", "tratamento", "terapeutico", "medicinal", "emagrece",
  "anti idade", "rejuvenesce", "clinicamente comprovado", "aprovado pela anvisa",
];

/** Números com unidade — captura "500ml", "2 unidades", "10 cm". Usado para detectar quantidade/medida inventada ou alterada. */
function extrairMedidas(textoNormalizado: string): Set<string> {
  const achados = new Set<string>();
  const re = /(\d+(?:[.,]\d+)?)\s*(ml|l|g|kg|mg|cm|mm|m|un|unidades|unidade|pecas|peca|pares|par|w|v)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(textoNormalizado)) !== null) {
    achados.add(`${m[1].replace(",", ".")}${m[2]}`);
  }
  return achados;
}

export function validarIntegridadeAdaptacao(
  saida: AdaptacaoMarketplaceIA,
  entrada: EntradaAdaptacaoMarketplace
): ResultadoValidacaoAdaptacao {
  const base = entrada.conteudoBase;
  const corpus = corpusDoConteudoBase(base);
  const medidasBase = extrairMedidas(corpus);

  const alvos = new Set<string>(entrada.marketplacesAlvo);
  const vistos = new Set<string>();

  for (const a of saida.adaptacoes) {
    // 1. marketplace precisa ter sido pedido, e não pode repetir
    if (!alvos.has(a.marketplace)) {
      return { valido: false, motivo: `Adaptação para marketplace não solicitado: "${a.marketplace}".` };
    }
    if (vistos.has(a.marketplace)) {
      return { valido: false, motivo: `Marketplace duplicado na saída: "${a.marketplace}".` };
    }
    vistos.add(a.marketplace);

    const textoAdaptado = normalizar(
      [a.titulo, a.descricao, ...(a.bullets ?? []), ...(a.especificacoes ?? []).flatMap(e => [e.nome, e.valor])].join(" ")
    );

    // 2. termo proibido introduzido que não existe na base
    for (const termo of TERMOS_PROIBIDOS_SE_AUSENTES_NA_BASE) {
      const t = normalizar(termo);
      if (textoAdaptado.includes(t) && !corpus.includes(t)) {
        return { valido: false, motivo: `"${a.marketplace}": introduziu termo proibido ausente do conteúdo-base ("${termo}").` };
      }
    }

    // 3. medida/quantidade inventada ou alterada
    for (const medida of extrairMedidas(textoAdaptado)) {
      if (!medidasBase.has(medida)) {
        return { valido: false, motivo: `"${a.marketplace}": medida/quantidade "${medida}" não existe no conteúdo-base (alterada ou inventada).` };
      }
    }

    // 4. especificação precisa corresponder a uma da base (nome E valor)
    if (a.especificacoes) {
      const specsBase = (base.especificacoes ?? []).map(e => ({ nome: normalizar(e.nome), valor: normalizar(e.valor) }));
      for (const e of a.especificacoes) {
        const n = normalizar(e.nome);
        const v = normalizar(e.valor);
        const match = specsBase.find(s => s.nome === n);
        if (!match) {
          return { valido: false, motivo: `"${a.marketplace}": especificação "${e.nome}" não existe no conteúdo-base.` };
        }
        if (match.valor !== v) {
          return { valido: false, motivo: `"${a.marketplace}": valor da especificação "${e.nome}" foi alterado.` };
        }
      }
    }

    // 5. CTA fora da lista congelada nesta chamada
    if (a.cta !== undefined && !entrada.ctasPermitidos.includes(a.cta)) {
      return { valido: false, motivo: `"${a.marketplace}": CTA fora da lista controlada.` };
    }
  }

  // 6. todo marketplace pedido precisa ter sido atendido
  for (const mk of alvos) {
    if (!vistos.has(mk)) {
      return { valido: false, motivo: `Marketplace solicitado sem adaptação na saída: "${mk}".` };
    }
  }

  return { valido: true };
}

// ────────────────────────────────────────────────────────────────────
// Pré-condições de origem — mesma disciplina de geracao_conteudo
// ────────────────────────────────────────────────────────────────────
interface OrigemGeracaoConteudo {
  conteudoBase: GeracaoConteudoIA;
  jobOrigemId: string;
  resultadoId: string;
  schemaVersao: number;
}

async function validarOrigemEBuscarConteudoBase(
  supabase: SupabaseClient,
  ctx: ContextoExecucaoJob
): Promise<OrigemGeracaoConteudo> {
  const { data: job, error: erroJob } = await supabase
    .from("estudio_anuncios_jobs")
    .select("id, projeto_id, job_origem_id")
    .eq("id", ctx.jobId)
    .maybeSingle();
  if (erroJob) throw new ErroProvedorIA("validation", `Falha ao ler job atual: ${erroJob.message}`.slice(0, 300));
  if (!job) throw new ErroProvedorIA("validation", `Job ${ctx.jobId} não encontrado.`);

  if (!job.job_origem_id) {
    throw new ErroProvedorIA(
      "validation",
      "job_origem_id ausente — adaptacao_marketplace exige o job de geracao_conteudo de origem explícito (nunca inferido por ordenação)."
    );
  }

  const { data: jobOrigem, error: erroOrigem } = await supabase
    .from("estudio_anuncios_jobs")
    .select("id, projeto_id, etapa, status")
    .eq("id", job.job_origem_id)
    .maybeSingle();
  if (erroOrigem) throw new ErroProvedorIA("validation", `Falha ao ler job de origem: ${erroOrigem.message}`.slice(0, 300));
  if (!jobOrigem) throw new ErroProvedorIA("validation", `Job de origem ${job.job_origem_id} não encontrado.`);
  if (jobOrigem.projeto_id !== job.projeto_id) {
    throw new ErroProvedorIA(
      "validation",
      `Job de origem pertence a outro projeto (esperado ${job.projeto_id}, encontrado ${jobOrigem.projeto_id}).`
    );
  }
  // AJUSTE (2026-08-14): a origem passou a aceitar DUAS etapas. Desde a
  // migration 20260814, `_avancar` prefere o job de revisao_claude
  // (quando ele produziu artefato real) e só cai em geracao_conteudo
  // quando não existe revisão — ver o cabeçalho daquela migration para a
  // regra completa de precedência. Ambos os envelopes carregam um
  // GeracaoConteudoIA completo; a diferença é só onde ele mora
  // (`saida` vs `conteudoRevisado`), resolvida ao extrair abaixo.
  const ETAPAS_ORIGEM_ACEITAS = ["revisao_claude", "geracao_conteudo"] as const;
  if (!(ETAPAS_ORIGEM_ACEITAS as readonly string[]).includes(jobOrigem.etapa)) {
    throw new ErroProvedorIA(
      "validation",
      `Job de origem tem etapa "${jobOrigem.etapa}", esperado "revisao_claude" ou "geracao_conteudo".`
    );
  }
  if (jobOrigem.status !== "concluido") {
    throw new ErroProvedorIA("validation", `Job de origem não está concluído (status atual: "${jobOrigem.status}").`);
  }

  const { data: resultados, error: erroRes } = await supabase
    .from("estudio_anuncios_resultados_pipeline")
    .select("id, etapa, schema_versao, resultado")
    .eq("job_id", job.job_origem_id);
  if (erroRes) throw new ErroProvedorIA("validation", `Falha ao ler resultado de geracao_conteudo: ${erroRes.message}`.slice(0, 300));
  if (!resultados || resultados.length !== 1) {
    throw new ErroProvedorIA(
      "validation",
      `Esperado exatamente 1 resultado de geracao_conteudo para o job de origem, encontrado ${resultados?.length ?? 0}.`
    );
  }
  const row = resultados[0] as { id: string; etapa: string; schema_versao: number; resultado: unknown };
  if (row.etapa !== jobOrigem.etapa) {
    throw new ErroProvedorIA(
      "validation",
      `Resultado de origem tem etapa "${row.etapa}", divergente do job de origem ("${jobOrigem.etapa}").`
    );
  }

  const versaoEsperada =
    row.etapa === "revisao_claude" ? SCHEMA_VERSAO_REVISAO_CLAUDE : SCHEMA_VERSAO_GERACAO_CONTEUDO;
  if (row.schema_versao !== versaoEsperada) {
    throw new ErroProvedorIA(
      "validation",
      `Resultado de origem (${row.etapa}) tem schema_versao=${row.schema_versao}, esperado ${versaoEsperada}.`
    );
  }

  // Extração do conteúdo-base conforme a etapa de origem. Os dois
  // envelopes carregam um GeracaoConteudoIA completo — em
  // revisao_claude ele é o `conteudoRevisado` (textos revisados, fatos
  // copiados verbatim do original); em geracao_conteudo é a `saida`.
  const conteudoBase =
    row.etapa === "revisao_claude"
      ? (row.resultado as EnvelopeRevisaoClaude)?.conteudoRevisado
      : (row.resultado as EnvelopeGeracaoConteudo)?.saida;

  if (!conteudoBase?.tituloBase?.texto || !conteudoBase?.descricaoCurta?.texto) {
    throw new ErroProvedorIA(
      "validation",
      `Envelope de ${row.etapa} sem tituloBase/descricaoCurta utilizáveis.`
    );
  }

  return {
    conteudoBase,
    jobOrigemId: job.job_origem_id as string,
    resultadoId: row.id,
    schemaVersao: row.schema_versao,
  };
}

/** Marketplaces do projeto — nunca inventados, sempre lidos da tabela. */
async function buscarMarketplacesDoProjeto(
  supabase: SupabaseClient,
  projetoId: string
): Promise<MarketplaceSuportado[]> {
  const { data, error } = await supabase
    .from("estudio_anuncios_projetos_marketplace")
    .select("marketplace")
    .eq("projeto_id", projetoId);
  if (error) throw new ErroProvedorIA("validation", `Falha ao ler marketplaces do projeto: ${error.message}`.slice(0, 300));
  const lista = (data ?? []).map(r => (r as { marketplace: string }).marketplace).filter(isMarketplaceSuportado);
  if (lista.length === 0) {
    throw new ErroProvedorIA(
      "validation",
      "Projeto não tem nenhum marketplace cadastrado — adaptacao_marketplace não tem alvo."
    );
  }
  // Ordem estável (nunca depende da ordem de retorno do banco).
  return [...lista].sort();
}

// ────────────────────────────────────────────────────────────────────
// Orquestrador
// ────────────────────────────────────────────────────────────────────
export interface ExecucaoAdaptacaoMarketplace {
  envelope: EnvelopeAdaptacaoMarketplace;
  modelo: string;
  tokensEntrada: number;
  tokensSaida: number;
  tempoMs: number;
}

export async function executarAdaptacaoMarketplaceGoogle(
  supabaseServico: SupabaseClient,
  ctx: ContextoExecucaoJob
): Promise<ExecucaoAdaptacaoMarketplace> {
  const origem = await validarOrigemEBuscarConteudoBase(supabaseServico, ctx);
  const marketplaces = await buscarMarketplacesDoProjeto(supabaseServico, ctx.projetoId);
  const entrada = montarEntradaAdaptacao(origem.conteudoBase, marketplaces);
  const promptTexto = montarPromptAdaptacao(entrada);

  const { resultadoTexto, modelo, tokensEntrada, tokensSaida, tempoMs } = await chamarGeminiTexto({
    promptTexto,
    schema: ADAPTACAO_MARKETPLACE_JSON_SCHEMA,
    modelo: obterModeloAdaptacaoMarketplace(),
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(resultadoTexto);
  } catch {
    throw new ErroProvedorIA("validation", "JSON inválido devolvido pelo Gemini (falha ao fazer parse).");
  }

  const saida = validarEstruturaAdaptacao(parsed);

  const integridade = validarIntegridadeAdaptacao(saida, entrada);
  if (!integridade.valido) {
    throw new ErroProvedorIA("conteudo_rejeitado", (integridade.motivo ?? "Violação de integridade da adaptação.").slice(0, 300));
  }

  const fonteGeracaoConteudo: FonteGeracaoConteudo = {
    jobId: origem.jobOrigemId,
    resultadoId: origem.resultadoId,
    schemaVersao: origem.schemaVersao,
  };

  return {
    envelope: { fonteGeracaoConteudo, entrada, saida },
    modelo,
    tokensEntrada,
    tokensSaida,
    tempoMs,
  };
}

/** Resumo curto e seguro para central_ia_prompts.resultado_resumo — nunca o envelope inteiro. */
export function montarResumoCurtoAdaptacao(envelope: EnvelopeAdaptacaoMarketplace): string {
  const partes = envelope.saida.adaptacoes.map(a => `${a.marketplace}: ${a.titulo}`);
  return partes.join(" | ").slice(0, 500);
}

export { SCHEMA_VERSAO_ADAPTACAO_MARKETPLACE };
