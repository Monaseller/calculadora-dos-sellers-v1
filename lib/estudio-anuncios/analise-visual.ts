/**
 * Análise visual real (Gemini) — orquestra seleção de fotos, chamada
 * ao provedor Google e validação do resultado. Não decide provedor
 * (isso é lib/ai-gateway/roteamento.ts), não registra prompt/consumo/
 * resultado no banco (isso é executar-job.ts + lib/ai-gateway/
 * registro.ts), não avança job/Pipeline (isso são as RPCs atômicas).
 *
 * REVISÃO (contrato oficial com origem por atributo — ver
 * google-tipos.ts para o histórico completo da mudança e a
 * justificativa baseada nos 4 testes reais auditados).
 *
 * Estratégia de envio de fotos — só inline nesta versão, nunca File
 * API (ver proposta técnica aprovada): seleciona a foto principal
 * primeiro, depois as demais por `ordem ASC`, respeitando dois
 * limites configuráveis via ambiente (GOOGLE_AI_MAX_IMAGES,
 * GOOGLE_AI_MAX_BYTES — nunca fixados no código). Fotos fora do
 * orçamento simplesmente não entram na análise; isso é registrado
 * explicitamente em `metadadosAnalise`, nunca escondido.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { listarFotosOrdenadasParaAnalise } from "./fotos";
import { baixarObjeto } from "./storage";
import { chamarGeminiComImagens, ErroProvedorIA } from "../ai-gateway/provedores/google";
import {
  ANALISE_VISUAL_JSON_SCHEMA,
  SCHEMA_VERSAO_ANALISE_VISUAL,
  type AnaliseVisualIA,
  type AnaliseVisualCompleta,
  type FotoAnalisada,
  type MetadadosAnalise,
  type OrigemAtributo,
} from "../ai-gateway/provedores/google-tipos";

// ────────────────────────────────────────────────────────────────────
// Limites configuráveis (GOOGLE_AI_MAX_IMAGES / GOOGLE_AI_MAX_BYTES)
// ────────────────────────────────────────────────────────────────────

/** Só usado quando a variável de ambiente está AUSENTE — nunca sobrepõe um valor inválido presente. */
const DEFAULT_MAX_IMAGENS = 3;
const DEFAULT_MAX_BYTES = 12 * 1024 * 1024; // 12582912 — igual ao valor recomendado no .env.example

/** Teto absoluto de segurança — GOOGLE_AI_MAX_BYTES nunca pode ultrapassar isso, mesmo se configurado maior. Margem sob os 20MB combinados (texto+imagens) da API do Gemini. */
const TETO_SEGURO_BYTES_INLINE = 18 * 1024 * 1024;

export interface LimitesAnaliseVisual {
  maxImagens: number;
  maxBytes: number;
}

/**
 * Lê e valida GOOGLE_AI_MAX_IMAGES/GOOGLE_AI_MAX_BYTES. Ausente → usa
 * o default documentado. Presente mas inválido → lança explicitamente
 * (nunca ignora um valor inválido, nunca cai num fallback silencioso).
 */
export function obterLimitesAnaliseVisual(): LimitesAnaliseVisual {
  const rawImagens = process.env.GOOGLE_AI_MAX_IMAGES;
  let maxImagens = DEFAULT_MAX_IMAGENS;
  if (rawImagens !== undefined && rawImagens !== "") {
    const n = Number(rawImagens);
    if (!Number.isInteger(n) || n < 1 || n > 10) {
      throw new ErroProvedorIA(
        "validation",
        `GOOGLE_AI_MAX_IMAGES inválido ("${rawImagens}") — deve ser um inteiro entre 1 e 10.`
      );
    }
    maxImagens = n;
  }

  const rawBytes = process.env.GOOGLE_AI_MAX_BYTES;
  let maxBytes = DEFAULT_MAX_BYTES;
  if (rawBytes !== undefined && rawBytes !== "") {
    const n = Number(rawBytes);
    if (!Number.isInteger(n) || n <= 0) {
      throw new ErroProvedorIA(
        "validation",
        `GOOGLE_AI_MAX_BYTES inválido ("${rawBytes}") — deve ser um inteiro positivo.`
      );
    }
    if (n > TETO_SEGURO_BYTES_INLINE) {
      throw new ErroProvedorIA(
        "validation",
        `GOOGLE_AI_MAX_BYTES (${n}) excede o teto seguro de ${TETO_SEGURO_BYTES_INLINE} bytes para envio inline ao Gemini (limite real da API: 20MB combinados texto+imagens).`
      );
    }
    maxBytes = n;
  }

  return { maxImagens, maxBytes };
}

// ────────────────────────────────────────────────────────────────────
// Seleção + download das fotos
// ────────────────────────────────────────────────────────────────────

interface FotoSelecionada {
  imagemId: string;
  ordem: number;
  principal: boolean;
  mimeType: string;
  buffer: Uint8Array;
}

interface SelecaoFotos {
  selecionadas: FotoSelecionada[];
  totalFotosProjeto: number;
  totalFotosAnalisadas: number;
  analiseParcial: boolean;
  motivoAnaliseParcial: "limite_quantidade" | "limite_bytes" | null;
}

async function selecionarFotosParaAnalise(
  supabaseServico: SupabaseClient,
  projetoId: string
): Promise<SelecaoFotos> {
  const { maxImagens, maxBytes } = obterLimitesAnaliseVisual();

  const todasFotos = await listarFotosOrdenadasParaAnalise(supabaseServico, projetoId);
  if (todasFotos.length === 0) {
    throw new ErroProvedorIA("validation", "Projeto sem fotos — não é possível executar analise_visual.");
  }

  const selecionadas: FotoSelecionada[] = [];
  let bytesAcumulados = 0;
  let motivoParcial: "limite_quantidade" | "limite_bytes" | null = null;

  for (const foto of todasFotos) {
    if (selecionadas.length >= maxImagens) {
      motivoParcial = "limite_quantidade";
      break;
    }
    // Sem MIME real registrado, a foto não pode ser enviada com segurança ao Gemini — pula.
    if (!foto.mime_type) continue;

    const tamanho = foto.tamanho_bytes ?? 0;
    if (bytesAcumulados + tamanho > maxBytes) {
      motivoParcial = "limite_bytes";
      break;
    }

    const buffer = await baixarObjeto(supabaseServico, foto.storage_path);
    selecionadas.push({
      imagemId: foto.id,
      ordem: foto.ordem,
      principal: foto.e_principal,
      mimeType: foto.mime_type,
      buffer,
    });
    bytesAcumulados += tamanho;
  }

  if (selecionadas.length === 0) {
    throw new ErroProvedorIA(
      "validation",
      `Nenhuma foto coube no orçamento configurado (GOOGLE_AI_MAX_BYTES=${maxBytes} bytes) — a própria foto principal já excede o limite.`
    );
  }

  const totalFotosAnalisadas = selecionadas.length;
  const analiseParcial = totalFotosAnalisadas < todasFotos.length;

  return {
    selecionadas,
    totalFotosProjeto: todasFotos.length,
    totalFotosAnalisadas,
    analiseParcial,
    motivoAnaliseParcial: analiseParcial ? motivoParcial : null,
  };
}

// ────────────────────────────────────────────────────────────────────
// Prompt versionado e determinístico
// ────────────────────────────────────────────────────────────────────

const PROMPT_ANALISE_VISUAL_V1 = `Você é um Analista Visual de Produtos para Marketplaces.

Sua tarefa é analisar as fotos fornecidas de um produto e descrever exclusivamente o que é visível nelas, distinguindo sempre a origem de cada informação.

Origem de cada informação — use sempre um destes 4 valores, nunca invente outro:
- "produto": observado diretamente no objeto físico (cor, material, componente, texto gravado ou impresso NO produto em si).
- "embalagem_fisica": observado na caixa, blister ou rótulo físico do produto — não no produto em si.
- "material_promocional": texto ou imagem de propaganda, infográfico ou render publicitário (alegação de benefício, ilustração de marketing) — NUNCA é fato confirmado sobre o produto, mesmo que pareça técnico ou específico.
- "indeterminado": não dá pra saber com segurança se é produto, embalagem física ou material promocional.

Regras obrigatórias:
- NUNCA atribua ao produto uma cor, material, componente ou texto que só aparece na embalagem. Cada item de "cores", "materiais", "componentes" e "textosLegiveis" carrega sua própria origem — misturar produto e embalagem na mesma origem é o erro mais grave que você pode cometer aqui.
- Material promocional pode conter alegações não confirmadas (ex.: "melhora a circulação", "reduz a inflamação", "alivia a tensão"). Nunca repita essas alegações como fato do produto em "resumoVisual" ou "caracteristicasVisiveis". Se alegações desse tipo informarem algum item de "possiveisUsos", marque a origem desse item como "material_promocional", nunca "produto".
- Marca e modelo só podem ser preenchidos quando houver evidência visual clara (texto legível, logo reconhecível). Em caso ambíguo, incerto ou parcial, deixe null e registre a incerteza em "informacoesNaoConfirmadas" — nunca arrisque um palpite.
- Nunca invente medidas, voltagem, potência, materiais não visíveis, certificações, composição exata ou quantidade que não esteja declarada por escrito.
- "categoriaProvavel" é um array representando a hierarquia da categoria, do nível mais genérico ao mais específico (ex.: ["Beleza e Cuidados Pessoais", "Manicure e Pedicure"]) — nunca uma string única concatenada por "/" ou qualquer outro separador.
- "quantidadeDeclarada.valor" só pode ser preenchido quando houver uma declaração textual explícita de quantidade nas fotos (ex.: "contém 1 unidade", "kit com 3 peças") — nunca uma contagem sua a partir da imagem. Quando preenchido, "textoOrigem" deve conter o trecho exato do texto que sustenta esse número. Se não houver nenhuma declaração textual de quantidade, "valor" e "textoOrigem" ficam ambos null.
- "atributosAdicionais" só deve conter especificações realmente visíveis ou legíveis nas fotos (ex.: "76H" de autonomia impresso na embalagem) — nunca invente um atributo que não esteja escrito ou claramente visível.
- Se houver divergência real entre as fotos, risco ou inconsistência, aponte isso explicitamente em "alertas". A ausência simples de uma informação (ex.: nenhuma marca visível, nenhum texto na embalagem) NÃO é um alerta — isso vai em "informacoesNaoConfirmadas".
- Aponte problemas de qualidade das fotos (baixa resolução, desfoque, reflexo, corte, iluminação ruim) em "qualidadeDasFotos.problemas".
- Reconheça texto visível nas fotos, mas nunca complete trechos ilegíveis — se não conseguir ler com segurança, não inclua.
- "qualidadeDasFotos.nota" é uma nota de 0 a 100 sobre a qualidade técnica das fotos em si (nitidez, enquadramento, iluminação) — nunca uma nota do produto.
- Produza SOMENTE o JSON do contrato estruturado fornecido. Não inclua texto fora do JSON.
- Responda em português do Brasil.
- Não gere título comercial, descrição de anúncio, SEO, adaptação por marketplace, prompt de geração de imagem ou roteiro de vídeo — isso é responsabilidade de outras etapas, fora desta tarefa.`;

// ────────────────────────────────────────────────────────────────────
// Validação manual do JSON devolvido pelo Gemini (sem lib nova — ver
// proposta aprovada: schema pequeno e fixo, validação de baixo risco)
// ────────────────────────────────────────────────────────────────────

function ehArrayDeStrings(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(x => typeof x === "string");
}

const ORIGENS_VALIDAS: readonly OrigemAtributo[] = ["produto", "embalagem_fisica", "material_promocional", "indeterminado"];

function ehOrigemValida(v: unknown): v is OrigemAtributo {
  return typeof v === "string" && (ORIGENS_VALIDAS as readonly string[]).includes(v);
}

/**
 * Valida um array de itens `{ [chaveValor]: string, origem }` — usado
 * por caracteristicasVisiveis/cores/materiais/componentes/
 * textosLegiveis/possiveisUsos/publicoProvavel, que só diferem no nome
 * da chave de valor ("descricao"/"valor"/"texto"). Rejeita
 * explicitamente qualquer propriedade fora dessas duas — nunca
 * preserva propriedade extra em silêncio.
 */
function validarArrayComOrigem(valor: unknown, chaveValor: string, nomeCampo: string): void {
  if (!Array.isArray(valor)) {
    throw new ErroProvedorIA("validation", `Campo "${nomeCampo}" ausente ou não é array.`);
  }
  valor.forEach((item, i) => {
    if (typeof item !== "object" || item === null) {
      throw new ErroProvedorIA("validation", `"${nomeCampo}[${i}]" não é um objeto.`);
    }
    const obj = item as Record<string, unknown>;
    const chavesExtras = Object.keys(obj).filter(c => c !== chaveValor && c !== "origem");
    if (chavesExtras.length > 0) {
      throw new ErroProvedorIA("validation", `"${nomeCampo}[${i}]" tem propriedade(s) não esperada(s): ${chavesExtras.join(", ")}.`);
    }
    if (typeof obj[chaveValor] !== "string" || (obj[chaveValor] as string).trim() === "") {
      throw new ErroProvedorIA("validation", `"${nomeCampo}[${i}].${chaveValor}" ausente, não é string ou está vazio.`);
    }
    if (!ehOrigemValida(obj.origem)) {
      throw new ErroProvedorIA("validation", `"${nomeCampo}[${i}].origem" ausente ou fora do enum válido.`);
    }
  });
}

function validarAtributosAdicionais(valor: unknown): void {
  if (!Array.isArray(valor)) {
    throw new ErroProvedorIA("validation", `Campo "atributosAdicionais" ausente ou não é array.`);
  }
  valor.forEach((item, i) => {
    if (typeof item !== "object" || item === null) {
      throw new ErroProvedorIA("validation", `"atributosAdicionais[${i}]" não é um objeto.`);
    }
    const obj = item as Record<string, unknown>;
    const chavesExtras = Object.keys(obj).filter(c => !["nome", "valor", "origem"].includes(c));
    if (chavesExtras.length > 0) {
      throw new ErroProvedorIA("validation", `"atributosAdicionais[${i}]" tem propriedade(s) não esperada(s): ${chavesExtras.join(", ")}.`);
    }
    if (typeof obj.nome !== "string" || obj.nome.trim() === "") {
      throw new ErroProvedorIA("validation", `"atributosAdicionais[${i}].nome" ausente, não é string ou está vazio.`);
    }
    if (typeof obj.valor !== "string" || obj.valor.trim() === "") {
      throw new ErroProvedorIA("validation", `"atributosAdicionais[${i}].valor" ausente, não é string ou está vazio.`);
    }
    if (!ehOrigemValida(obj.origem)) {
      throw new ErroProvedorIA("validation", `"atributosAdicionais[${i}].origem" ausente ou fora do enum válido.`);
    }
  });
}

/** Campos do contrato anterior à revisão de origem — nunca aceitos, mesmo que o Gemini os devolva. */
const CAMPOS_ANTIGOS_REJEITADOS = [
  "materiaisProvaveis",
  "componentesVisiveis",
  "textosLegiveisNaEmbalagem",
  "conteudoDaEmbalagemVisivel",
];

const CAMPOS_VALIDOS_RAIZ = [
  "produtoIdentificado", "marca", "modelo", "categoriaProvavel", "resumoVisual",
  "caracteristicasVisiveis", "cores", "materiais", "componentes", "textosLegiveis",
  "quantidadeDeclarada", "possiveisUsos", "publicoProvavel", "alertas",
  "informacoesNaoConfirmadas", "qualidadeDasFotos", "atributosAdicionais",
];

function validarResultadoAnaliseVisual(json: unknown): AnaliseVisualIA {
  if (typeof json !== "object" || json === null) {
    throw new ErroProvedorIA("validation", "Resposta do Gemini não é um objeto JSON.");
  }
  const r = json as Record<string, unknown>;

  // Rejeita explicitamente campos do contrato antigo — nunca aceitos
  // silenciosamente, nem ignorados.
  const camposAntigosPresentes = CAMPOS_ANTIGOS_REJEITADOS.filter(c => c in r);
  if (camposAntigosPresentes.length > 0) {
    throw new ErroProvedorIA(
      "validation",
      `Resposta usa campo(s) do contrato antigo, não mais aceito(s): ${camposAntigosPresentes.join(", ")}.`
    );
  }

  // Rejeita qualquer propriedade de nível raiz fora do contrato atual —
  // nunca preserva propriedade extra em silêncio (cobre também
  // fotosAnalisadas/metadadosAnalise, caso o modelo tente devolvê-los:
  // eles nunca fazem parte deste allowlist, então caem aqui).
  const chavesExtrasRaiz = Object.keys(r).filter(c => !CAMPOS_VALIDOS_RAIZ.includes(c));
  if (chavesExtrasRaiz.length > 0) {
    throw new ErroProvedorIA("validation", `Resposta tem propriedade(s) de nível raiz não esperada(s): ${chavesExtrasRaiz.join(", ")}.`);
  }

  if (typeof r.resumoVisual !== "string") {
    throw new ErroProvedorIA("validation", `Campo "resumoVisual" ausente ou não é string.`);
  }

  const camposStringOuNull: (keyof AnaliseVisualIA)[] = ["produtoIdentificado", "marca", "modelo"];
  for (const campo of camposStringOuNull) {
    if (r[campo] !== null && typeof r[campo] !== "string") {
      throw new ErroProvedorIA("validation", `Campo "${campo}" deve ser string ou null.`);
    }
  }

  // categoriaProvavel: null OU array não-vazio de strings não-vazias —
  // nunca string simples (regra explícita: hierarquia, nunca
  // concatenação por "/").
  if (r.categoriaProvavel !== null) {
    if (!Array.isArray(r.categoriaProvavel) || r.categoriaProvavel.length === 0) {
      throw new ErroProvedorIA("validation", `Campo "categoriaProvavel" deve ser null ou array não-vazio de strings.`);
    }
    if (!r.categoriaProvavel.every(nivel => typeof nivel === "string" && nivel.trim() !== "")) {
      throw new ErroProvedorIA("validation", `Campo "categoriaProvavel" tem nível vazio ou não-string.`);
    }
  }

  validarArrayComOrigem(r.caracteristicasVisiveis, "descricao", "caracteristicasVisiveis");
  validarArrayComOrigem(r.cores, "valor", "cores");
  validarArrayComOrigem(r.materiais, "valor", "materiais");
  validarArrayComOrigem(r.componentes, "valor", "componentes");
  validarArrayComOrigem(r.textosLegiveis, "texto", "textosLegiveis");
  validarArrayComOrigem(r.possiveisUsos, "descricao", "possiveisUsos");
  validarArrayComOrigem(r.publicoProvavel, "descricao", "publicoProvavel");
  validarAtributosAdicionais(r.atributosAdicionais);

  // quantidadeDeclarada: valor e textoOrigem sempre andam juntos.
  const quantidade = r.quantidadeDeclarada as Record<string, unknown> | undefined;
  if (typeof quantidade !== "object" || quantidade === null) {
    throw new ErroProvedorIA("validation", `Campo "quantidadeDeclarada" ausente ou não é objeto.`);
  }
  const chavesExtrasQtd = Object.keys(quantidade).filter(c => c !== "valor" && c !== "textoOrigem");
  if (chavesExtrasQtd.length > 0) {
    throw new ErroProvedorIA("validation", `"quantidadeDeclarada" tem propriedade(s) não esperada(s): ${chavesExtrasQtd.join(", ")}.`);
  }
  if (quantidade.valor !== null && !(Number.isInteger(quantidade.valor) && (quantidade.valor as number) > 0)) {
    throw new ErroProvedorIA("validation", `"quantidadeDeclarada.valor" deve ser inteiro positivo ou null.`);
  }
  if (quantidade.valor === null) {
    if (quantidade.textoOrigem !== null) {
      throw new ErroProvedorIA("validation", `"quantidadeDeclarada.textoOrigem" deve ser null quando "valor" é null.`);
    }
  } else {
    if (typeof quantidade.textoOrigem !== "string" || quantidade.textoOrigem.trim() === "") {
      throw new ErroProvedorIA("validation", `"quantidadeDeclarada.textoOrigem" deve ser string não-vazia quando "valor" está preenchido.`);
    }
  }

  const camposArrayStringSimples: (keyof AnaliseVisualIA)[] = ["alertas", "informacoesNaoConfirmadas"];
  for (const campo of camposArrayStringSimples) {
    if (!ehArrayDeStrings(r[campo])) {
      throw new ErroProvedorIA("validation", `Campo "${campo}" ausente ou não é array de strings.`);
    }
  }

  const qualidade = r.qualidadeDasFotos as Record<string, unknown> | undefined;
  if (typeof qualidade !== "object" || qualidade === null) {
    throw new ErroProvedorIA("validation", `Campo "qualidadeDasFotos" ausente ou não é objeto.`);
  }
  const chavesExtrasQualidade = Object.keys(qualidade).filter(c => !["nota", "problemas", "sugestoes"].includes(c));
  if (chavesExtrasQualidade.length > 0) {
    throw new ErroProvedorIA("validation", `"qualidadeDasFotos" tem propriedade(s) não esperada(s): ${chavesExtrasQualidade.join(", ")}.`);
  }
  if (typeof qualidade.nota !== "number" || !Number.isFinite(qualidade.nota) || qualidade.nota < 0 || qualidade.nota > 100) {
    throw new ErroProvedorIA("validation", `"qualidadeDasFotos.nota" deve ser um número entre 0 e 100.`);
  }
  if (!ehArrayDeStrings(qualidade.problemas) || !ehArrayDeStrings(qualidade.sugestoes)) {
    throw new ErroProvedorIA("validation", `"qualidadeDasFotos.problemas"/"sugestoes" devem ser arrays de strings.`);
  }

  return r as unknown as AnaliseVisualIA;
}

// ────────────────────────────────────────────────────────────────────
// Orquestrador
// ────────────────────────────────────────────────────────────────────

export interface ExecucaoAnaliseVisual {
  resultadoCompleto: AnaliseVisualCompleta;
  modelo: string;
  tokensEntrada: number;
  tokensSaida: number;
  tempoMs: number;
}

export async function executarAnaliseVisualGoogle(
  supabaseServico: SupabaseClient,
  projetoId: string
): Promise<ExecucaoAnaliseVisual> {
  const selecao = await selecionarFotosParaAnalise(supabaseServico, projetoId);

  const { resultadoTexto, modelo, tokensEntrada, tokensSaida, tempoMs } = await chamarGeminiComImagens({
    promptTexto: PROMPT_ANALISE_VISUAL_V1,
    imagens: selecao.selecionadas.map(f => ({ buffer: f.buffer, mimeType: f.mimeType })),
    schema: ANALISE_VISUAL_JSON_SCHEMA,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(resultadoTexto);
  } catch {
    throw new ErroProvedorIA("validation", "JSON inválido devolvido pelo Gemini (falha ao fazer parse).");
  }

  const resultadoIA = validarResultadoAnaliseVisual(parsed);

  // fotosAnalisadas e metadadosAnalise: montados 100% pelo servidor,
  // nunca pedidos ao nem devolvidos pelo Gemini.
  const fotosAnalisadas: FotoAnalisada[] = selecao.selecionadas.map(f => ({
    imagemId: f.imagemId,
    ordem: f.ordem,
    principal: f.principal,
  }));
  const metadadosAnalise: MetadadosAnalise = {
    totalFotosProjeto: selecao.totalFotosProjeto,
    totalFotosAnalisadas: selecao.totalFotosAnalisadas,
    analiseParcial: selecao.analiseParcial,
    motivoAnaliseParcial: selecao.motivoAnaliseParcial,
  };

  const resultadoCompleto: AnaliseVisualCompleta = {
    ...resultadoIA,
    fotosAnalisadas,
    metadadosAnalise,
  };

  return { resultadoCompleto, modelo, tokensEntrada, tokensSaida, tempoMs };
}

/**
 * Resumo curto e seguro para central_ia_prompts.resultado_resumo —
 * NUNCA o JSON completo (essa coluna não é adequada para guardar o
 * objeto de domínio inteiro; o JSON completo vai só para
 * estudio_anuncios_resultados_pipeline.resultado). Truncado
 * defensivamente para não depender de o schema da coluna nunca mudar.
 */
export function montarResumoCurtoAnaliseVisual(resultado: AnaliseVisualCompleta): string {
  const produto = resultado.produtoIdentificado ?? "produto não identificado";
  const categoria =
    resultado.categoriaProvavel && resultado.categoriaProvavel.length > 0
      ? resultado.categoriaProvavel.join(" / ")
      : "categoria não identificada";
  const resumo = `${produto} (${categoria}): ${resultado.resumoVisual}`;
  return resumo.slice(0, 500);
}

export { SCHEMA_VERSAO_ANALISE_VISUAL };
