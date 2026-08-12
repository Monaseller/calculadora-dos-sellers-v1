/**
 * Orquestração da etapa `revisao_claude` — domínio puro + pré-condições
 * + validação determinística + chamada ao provedor Anthropic.
 *
 * Mesma divisão das etapas anteriores: este arquivo NÃO decide provedor,
 * NÃO registra prompt/consumo, NÃO avança Pipeline e NÃO persiste.
 *
 * O que esta etapa NUNCA faz: criar conteúdo novo, adaptar marketplace,
 * consultar imagem, tocar Storage, alterar fato. Não há import de
 * storage.ts nem de analise-visual.ts aqui — a ausência é proposital e
 * verificada por teste.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { ErroProvedorIA } from "../ai-gateway/erros";
import { chamarClaudeTexto, obterModeloRevisao } from "../ai-gateway/provedores/anthropic";
import { REVISAO_CLAUDE_JSON_SCHEMA } from "../ai-gateway/provedores/anthropic-revisao-schema";
import type { ContextoExecucaoJob } from "./executar-job";
import type { EnvelopeGeracaoConteudo, GeracaoConteudoIA } from "./geracao-conteudo-tipos";
import { SCHEMA_VERSAO_GERACAO_CONTEUDO } from "./geracao-conteudo-tipos";
import type {
  EntradaRevisaoClaude,
  EnvelopeRevisaoClaude,
  FonteConteudoBase,
  RevisaoClaudeIA,
  TextoRevisado,
} from "./revisao-claude-tipos";
import { SCHEMA_VERSAO_REVISAO_CLAUDE } from "./revisao-claude-tipos";

export const RESTRICOES_REVISAO: string[] = [
  "Revisar apenas a redação: clareza, fluidez, gramática, consistência e estilo.",
  "Nunca inventar informação que não esteja no texto original.",
  "Nunca alterar marca, modelo, medidas, quantidade, materiais ou características técnicas.",
  "Nunca criar benefício, promessa, garantia ou alegação de saúde.",
  "Nunca adicionar preço, frete, prazo, promoção ou chamada para ação.",
  "Nunca transformar uma ressalva ('aparenta', 'parece') em afirmação categórica.",
  "Preferir não alterar a alterar sem ganho claro de clareza.",
];

// ────────────────────────────────────────────────────────────────────
// Extração e remontagem dos trechos revisáveis
// ────────────────────────────────────────────────────────────────────
export interface TrechoRevisavel {
  ref: string;
  textoOriginal: string;
}

/**
 * Enumera os trechos revisáveis do conteúdo-base, em ordem estável.
 * `especificacoes` e `publicoSugerido` ficam de fora por desenho — são
 * fato estruturado e nunca chegam ao revisor.
 */
export function extrairTrechosRevisaveis(base: GeracaoConteudoIA): TrechoRevisavel[] {
  const trechos: TrechoRevisavel[] = [
    { ref: "tituloBase", textoOriginal: base.tituloBase.texto },
    { ref: "descricaoCurta", textoOriginal: base.descricaoCurta.texto },
  ];
  (base.bullets ?? []).forEach((b, i) => trechos.push({ ref: `bullet:${i}`, textoOriginal: b.texto }));
  (base.descricaoLonga ?? []).forEach((p, i) => trechos.push({ ref: `descricaoLonga:${i}`, textoOriginal: p.texto }));
  return trechos;
}

/**
 * Remonta um `GeracaoConteudoIA` completo com os textos revisados.
 * `fatoIds`, `contemRessalva`, `especificacoes` e `publicoSugerido` são
 * copiados verbatim do original — nunca vêm do modelo.
 */
export function remontarConteudoRevisado(base: GeracaoConteudoIA, saida: RevisaoClaudeIA): GeracaoConteudoIA {
  const porRef = new Map(saida.textos.map(t => [t.ref, t.textoRevisado]));
  const texto = (ref: string, fallback: string) => porRef.get(ref) ?? fallback;

  const revisado: GeracaoConteudoIA = {
    tituloBase: { ...base.tituloBase, texto: texto("tituloBase", base.tituloBase.texto) },
    descricaoCurta: { ...base.descricaoCurta, texto: texto("descricaoCurta", base.descricaoCurta.texto) },
  };
  if (base.bullets) {
    revisado.bullets = base.bullets.map((b, i) => ({ ...b, texto: texto(`bullet:${i}`, b.texto) }));
  }
  if (base.descricaoLonga) {
    revisado.descricaoLonga = base.descricaoLonga.map((p, i) => ({ ...p, texto: texto(`descricaoLonga:${i}`, p.texto) }));
  }
  // Copiados verbatim — fora do alcance da revisão por desenho.
  if (base.especificacoes) revisado.especificacoes = base.especificacoes.map(e => ({ ...e }));
  if (base.publicoSugerido) revisado.publicoSugerido = { ...base.publicoSugerido };
  return revisado;
}

// ────────────────────────────────────────────────────────────────────
// Entrada e prompt
// ────────────────────────────────────────────────────────────────────
export function montarEntradaRevisao(base: GeracaoConteudoIA): EntradaRevisaoClaude {
  return { trechos: extrairTrechosRevisaveis(base), restricoes: RESTRICOES_REVISAO };
}

export const PROMPT_SISTEMA_REVISAO = [
  "Você é um revisor de texto de anúncios de e-commerce.",
  "Seu trabalho é melhorar a REDAÇÃO. Você não é autor: não acrescenta informação, não remove informação e não reinterpreta o produto.",
  "",
  "REGRAS INVIOLÁVEIS:",
  ...RESTRICOES_REVISAO.map(r => `- ${r}`),
  "",
  "Para cada trecho recebido devolva um item com a mesma `ref`.",
  "Se melhorou o texto: alterado=true e um `motivo` curto.",
  "Se o texto já estava adequado: alterado=false e `textoRevisado` EXATAMENTE igual ao original, sem `motivo`.",
  "Não invente refs, não omita refs, não repita refs.",
].join("\n");

export function montarPromptUsuarioRevisao(entrada: EntradaRevisaoClaude): string {
  const linhas = ["Revise os trechos abaixo. Devolva um item por trecho, com a mesma `ref`.", ""];
  for (const t of entrada.trechos) {
    linhas.push(`ref: ${t.ref}`, `texto: ${t.textoOriginal}`, "");
  }
  return linhas.join("\n");
}

// ────────────────────────────────────────────────────────────────────
// Validação estrutural (forma)
// ────────────────────────────────────────────────────────────────────
function ehObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function textoNaoVazio(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

const CHAVES_TEXTO = new Set(["ref", "textoRevisado", "alterado", "motivo"]);

export function validarEstruturaRevisao(json: unknown): RevisaoClaudeIA {
  if (!ehObjeto(json)) throw new ErroProvedorIA("validation", "Resposta não é um objeto JSON.");
  for (const chave of Object.keys(json)) {
    if (chave !== "textos" && chave !== "observacoes") {
      throw new ErroProvedorIA("validation", `Propriedade extra não permitida na raiz: "${chave}".`);
    }
  }
  if (!Array.isArray(json.textos) || json.textos.length === 0) {
    throw new ErroProvedorIA("validation", "Campo obrigatório 'textos' ausente ou vazio.");
  }

  const textos: TextoRevisado[] = [];
  for (const item of json.textos) {
    if (!ehObjeto(item)) throw new ErroProvedorIA("validation", "Item de 'textos' não é objeto.");
    for (const chave of Object.keys(item)) {
      if (!CHAVES_TEXTO.has(chave)) {
        throw new ErroProvedorIA("validation", `Propriedade extra não permitida em texto revisado: "${chave}".`);
      }
    }
    if (!textoNaoVazio(item.ref)) throw new ErroProvedorIA("validation", "Item sem `ref`.");
    if (!textoNaoVazio(item.textoRevisado)) {
      throw new ErroProvedorIA("validation", `textoRevisado vazio em "${item.ref}".`);
    }
    if (typeof item.alterado !== "boolean") {
      throw new ErroProvedorIA("validation", `alterado ausente ou não booleano em "${item.ref}".`);
    }
    if (item.alterado && !textoNaoVazio(item.motivo)) {
      throw new ErroProvedorIA("validation", `alterado=true exige 'motivo' em "${item.ref}".`);
    }
    if (!item.alterado && item.motivo !== undefined) {
      throw new ErroProvedorIA("validation", `alterado=false não aceita 'motivo' em "${item.ref}".`);
    }
    const t: TextoRevisado = { ref: item.ref, textoRevisado: item.textoRevisado, alterado: item.alterado };
    if (item.alterado) t.motivo = item.motivo as string;
    textos.push(t);
  }

  const saida: RevisaoClaudeIA = { textos };
  if (json.observacoes !== undefined) {
    if (!Array.isArray(json.observacoes) || json.observacoes.some(o => !textoNaoVazio(o))) {
      throw new ErroProvedorIA("validation", "observacoes inválido (array de texto não-vazio, ou chave ausente).");
    }
    saida.observacoes = json.observacoes as string[];
  }
  return saida;
}

// ────────────────────────────────────────────────────────────────────
// Validação de INTEGRIDADE (conteúdo)
// ────────────────────────────────────────────────────────────────────
export interface ResultadoValidacaoRevisao {
  valido: boolean;
  motivo?: string;
}

function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Números com unidade — detecta medida/quantidade inventada ou alterada. */
function extrairMedidas(textoNormalizado: string): Set<string> {
  const achados = new Set<string>();
  const re = /(\d+(?:[.,]\d+)?)\s*(ml|l|g|kg|mg|cm|mm|m|un|unidades|unidade|pecas|peca|pares|par|w|v)?\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(textoNormalizado)) !== null) {
    achados.add(`${m[1].replace(",", ".")}${m[2] ?? ""}`);
  }
  return achados;
}

const TERMOS_PROIBIDOS_SE_AUSENTES = [
  "gratis", "frete gratis", "desconto", "promocao", "oferta", "cupom",
  "garantia", "garantido", "melhor preco", "imperdivel", "ultimas unidades",
  "compre agora", "aproveite", "clique aqui",
  "cura", "trata", "tratamento", "terapeutico", "medicinal", "emagrece",
  "anti idade", "rejuvenesce", "clinicamente comprovado", "aprovado pela anvisa",
];

/** Hedges que sinalizam ressalva — remover um deles é transformar hipótese em fato. */
const HEDGES = ["aparenta", "aparentemente", "parece", "possivelmente", "provavelmente", "sugere", "indica"];

export function validarIntegridadeRevisao(
  saida: RevisaoClaudeIA,
  entrada: EntradaRevisaoClaude
): ResultadoValidacaoRevisao {
  const originais = new Map(entrada.trechos.map(t => [t.ref, t.textoOriginal]));
  const vistos = new Set<string>();

  for (const t of saida.textos) {
    // 1. ref precisa existir e não repetir
    if (!originais.has(t.ref)) {
      return { valido: false, motivo: `Referência inexistente na entrada: "${t.ref}".` };
    }
    if (vistos.has(t.ref)) {
      return { valido: false, motivo: `Referência duplicada na saída: "${t.ref}".` };
    }
    vistos.add(t.ref);

    const original = originais.get(t.ref)!;
    const origNorm = normalizar(original);
    const revNorm = normalizar(t.textoRevisado);

    // 2. alterado=false precisa ser literalmente idêntico
    if (!t.alterado && t.textoRevisado !== original) {
      return { valido: false, motivo: `"${t.ref}": alterado=false mas o texto difere do original.` };
    }

    // 3. termo proibido introduzido
    for (const termo of TERMOS_PROIBIDOS_SE_AUSENTES) {
      const n = normalizar(termo);
      if (revNorm.includes(n) && !origNorm.includes(n)) {
        return { valido: false, motivo: `"${t.ref}": introduziu termo proibido ausente do original ("${termo}").` };
      }
    }

    // 4. medida/quantidade inventada ou alterada
    const medidasOrig = extrairMedidas(origNorm);
    for (const medida of extrairMedidas(revNorm)) {
      if (!medidasOrig.has(medida)) {
        return { valido: false, motivo: `"${t.ref}": número/medida "${medida}" não existe no texto original.` };
      }
    }

    // 5. ressalva não pode desaparecer (hipótese virando fato)
    for (const hedge of HEDGES) {
      const n = normalizar(hedge);
      if (origNorm.includes(n) && !revNorm.includes(n)) {
        return {
          valido: false,
          motivo: `"${t.ref}": removeu a ressalva "${hedge}" — hipótese não pode virar afirmação categórica.`,
        };
      }
    }
  }

  // 6. todo trecho enviado precisa voltar
  for (const ref of originais.keys()) {
    if (!vistos.has(ref)) {
      return { valido: false, motivo: `Trecho enviado sem revisão na saída: "${ref}".` };
    }
  }

  return { valido: true };
}

// ────────────────────────────────────────────────────────────────────
// Pré-condições de origem
// ────────────────────────────────────────────────────────────────────
interface OrigemConteudoBase {
  conteudoBase: GeracaoConteudoIA;
  jobOrigemId: string;
  resultadoId: string;
  schemaVersao: number;
}

async function validarOrigemEBuscarConteudoBase(
  supabase: SupabaseClient,
  ctx: ContextoExecucaoJob
): Promise<OrigemConteudoBase> {
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
      "job_origem_id ausente — revisao_claude exige o job de geracao_conteudo de origem explícito (nunca inferido por ordenação)."
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
  if (jobOrigem.etapa !== "geracao_conteudo") {
    throw new ErroProvedorIA("validation", `Job de origem tem etapa "${jobOrigem.etapa}", esperado "geracao_conteudo".`);
  }
  if (jobOrigem.status !== "concluido") {
    throw new ErroProvedorIA("validation", `Job de origem não está concluído (status atual: "${jobOrigem.status}").`);
  }

  const { data: resultados, error: erroRes } = await supabase
    .from("estudio_anuncios_resultados_pipeline")
    .select("id, etapa, schema_versao, resultado")
    .eq("job_id", job.job_origem_id);
  if (erroRes) throw new ErroProvedorIA("validation", `Falha ao ler resultado de origem: ${erroRes.message}`.slice(0, 300));
  if (!resultados || resultados.length !== 1) {
    throw new ErroProvedorIA(
      "validation",
      `Esperado exatamente 1 resultado de geracao_conteudo para o job de origem, encontrado ${resultados?.length ?? 0}.`
    );
  }
  const row = resultados[0] as { id: string; etapa: string; schema_versao: number; resultado: unknown };
  if (row.etapa !== "geracao_conteudo") {
    throw new ErroProvedorIA("validation", `Resultado de origem tem etapa "${row.etapa}", esperado "geracao_conteudo".`);
  }
  if (row.schema_versao !== SCHEMA_VERSAO_GERACAO_CONTEUDO) {
    throw new ErroProvedorIA(
      "validation",
      `Resultado de origem tem schema_versao=${row.schema_versao}, esperado ${SCHEMA_VERSAO_GERACAO_CONTEUDO}.`
    );
  }

  const envelope = row.resultado as EnvelopeGeracaoConteudo;
  if (!envelope?.saida?.tituloBase?.texto || !envelope?.saida?.descricaoCurta?.texto) {
    throw new ErroProvedorIA("validation", "Envelope de geracao_conteudo sem tituloBase/descricaoCurta utilizáveis.");
  }

  return {
    conteudoBase: envelope.saida,
    jobOrigemId: job.job_origem_id as string,
    resultadoId: row.id,
    schemaVersao: row.schema_versao,
  };
}

// ────────────────────────────────────────────────────────────────────
// Orquestrador
// ────────────────────────────────────────────────────────────────────
export interface ExecucaoRevisaoClaude {
  envelope: EnvelopeRevisaoClaude;
  modelo: string;
  tokensEntrada: number;
  tokensSaida: number;
  tempoMs: number;
}

export async function executarRevisaoClaudeAnthropic(
  supabaseServico: SupabaseClient,
  ctx: ContextoExecucaoJob
): Promise<ExecucaoRevisaoClaude> {
  const origem = await validarOrigemEBuscarConteudoBase(supabaseServico, ctx);
  const entrada = montarEntradaRevisao(origem.conteudoBase);

  const { resultadoTexto, modelo, tokensEntrada, tokensSaida, tempoMs } = await chamarClaudeTexto({
    promptSistema: PROMPT_SISTEMA_REVISAO,
    promptUsuario: montarPromptUsuarioRevisao(entrada),
    schema: REVISAO_CLAUDE_JSON_SCHEMA,
    modelo: obterModeloRevisao(),
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(resultadoTexto);
  } catch {
    throw new ErroProvedorIA("validation", "JSON inválido devolvido pela Anthropic (falha ao fazer parse).");
  }

  const saida = validarEstruturaRevisao(parsed);

  const integridade = validarIntegridadeRevisao(saida, entrada);
  if (!integridade.valido) {
    throw new ErroProvedorIA("conteudo_rejeitado", (integridade.motivo ?? "Violação de integridade da revisão.").slice(0, 300));
  }

  const conteudoRevisado = remontarConteudoRevisado(origem.conteudoBase, saida);

  const fonteConteudoBase: FonteConteudoBase = {
    jobId: origem.jobOrigemId,
    resultadoId: origem.resultadoId,
    schemaVersao: origem.schemaVersao,
  };

  return {
    envelope: { fonteConteudoBase, entrada, saida, conteudoRevisado },
    modelo,
    tokensEntrada,
    tokensSaida,
    tempoMs,
  };
}

/** Resumo curto e seguro para central_ia_prompts.resultado_resumo. */
export function montarResumoCurtoRevisao(envelope: EnvelopeRevisaoClaude): string {
  const alterados = envelope.saida.textos.filter(t => t.alterado).length;
  const total = envelope.saida.textos.length;
  return `${alterados}/${total} trechos revisados — ${envelope.conteudoRevisado.tituloBase.texto}`.slice(0, 500);
}

export { SCHEMA_VERSAO_REVISAO_CLAUDE };
