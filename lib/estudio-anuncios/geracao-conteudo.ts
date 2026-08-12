/**
 * `geracao_conteudo` real — monta a entrada segura a partir do
 * resultado de `analise_visual`, chama o Gemini (texto) e valida
 * estrutura + integridade de `fatoIds` antes de devolver o envelope
 * pronto para persistência. Não decide provedor (isso é
 * lib/ai-gateway/roteamento.ts), não registra prompt/consumo/resultado
 * no banco (isso é executar-job.ts + lib/ai-gateway/registro.ts), não
 * avança job/Pipeline (isso são as RPCs atômicas). Mesma separação de
 * responsabilidade já usada por analise-visual.ts.
 *
 * Baseado em:
 * - ESTUDIO_ANUNCIOS_IA_GERACAO_CONTEUDO_PLANEJAMENTO_V2.md (seções
 *   1-7: fluxo, classificação B/C/D, função de entrada segura, regras
 *   de material_promocional/informacoesNaoConfirmadas/alertas,
 *   rastreabilidade job_origem_id).
 * - ESTUDIO_ANUNCIOS_IA_GERACAO_CONTEUDO_CONTRATO.md (seções 1-15:
 *   contrato de saída, mecanismo de fatoIds, validação e consequência).
 * - ESTUDIO_ANUNCIOS_IA_GERACAO_CONTEUDO_PREPARACAO_IMPLEMENTACAO.md,
 *   seção 3.7 (7 pré-condições de job_origem_id).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { chamarGeminiTexto, ErroProvedorIA } from "../ai-gateway/provedores/google";
import { GERACAO_CONTEUDO_JSON_SCHEMA } from "../ai-gateway/provedores/google-conteudo-schema";
import type { AnaliseVisualCompleta, CampoOrigem, OrigemAtributo } from "../ai-gateway/provedores/google-tipos";
import { SCHEMA_VERSAO_ANALISE_VISUAL } from "../ai-gateway/provedores/google-tipos";
import type {
  EntradaSeguraGeracaoConteudo,
  FatoPermitido,
  DescricaoComRessalva,
  FatoAfetadoPorAlerta,
  FonteAnaliseVisual,
  GeracaoConteudoIA,
  EnvelopeGeracaoConteudo,
  TextoComFatoIds,
  TextoComRessalvaEFatoIds,
  EspecificacaoGerada,
} from "./geracao-conteudo-tipos";
import { SCHEMA_VERSAO_GERACAO_CONTEUDO } from "./geracao-conteudo-tipos";
import type { ContextoExecucaoJob } from "./executar-job";

// ────────────────────────────────────────────────────────────────────
// Normalização de texto (usada por hedge, keyword de informacoesNao-
// Confirmadas/alertas, e correspondência textual de especificacoes) —
// minúsculas + remoção de acentos (NFD), único helper compartilhado por
// toda heurística textual deste arquivo.
// ────────────────────────────────────────────────────────────────────
function normalizarTexto(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
}

function contemAlgumaSubstring(textoNormalizado: string, candidatos: readonly string[]): boolean {
  return candidatos.some(c => textoNormalizado.includes(normalizarTexto(c)));
}

// ────────────────────────────────────────────────────────────────────
// Classificação B/C/D (V2, seção 2) — lista de hedge deliberadamente
// pequena (baseada em 1 exemplo real observado até hoje), documentada
// como incompleta por natureza, cresce com evidência futura, nunca por
// suposição (mesmo texto do V2, seção 2/12).
// ────────────────────────────────────────────────────────────────────
const PALAVRAS_HEDGE = ["aparência de", "parece", "possivelmente", "provável", "tipo"] as const;

function contemHedge(valor: string): boolean {
  return contemAlgumaSubstring(normalizarTexto(valor), PALAVRAS_HEDGE);
}

/**
 * Correspondência por palavra-chave entre um campo e
 * `informacoesNaoConfirmadas` (V2, seção 5: "heurística imperfeita,
 * documentada como tal" — mesmo espírito da lista de hedge). Um item
 * cujo campo aparece mencionado em informacoesNaoConfirmadas vira D,
 * mesmo sem hedge textual no próprio valor.
 */
const PALAVRAS_CHAVE_POR_CAMPO: Record<CampoOrigem, readonly string[]> = {
  produtoIdentificado: ["produto"],
  marca: ["marca"],
  categoriaProvavel: ["categoria"],
  caracteristicasVisiveis: ["característica", "caracteristica"],
  cores: ["cor"],
  materiais: ["material"],
  componentes: ["componente"],
  textosLegiveis: ["texto"],
  quantidadeDeclarada: ["quantidade"],
  possiveisUsos: ["uso"],
  publicoProvavel: ["público", "publico"],
  atributosAdicionais: ["atributo"],
};

function apareceEmInformacoesNaoConfirmadas(campo: CampoOrigem, informacoesNaoConfirmadas: string[]): boolean {
  const palavras = PALAVRAS_CHAVE_POR_CAMPO[campo];
  return informacoesNaoConfirmadas.some(texto => contemAlgumaSubstring(normalizarTexto(texto), palavras));
}

type Classificacao = "B" | "C" | "D";

function classificar(valor: string, campo: CampoOrigem, informacoesNaoConfirmadas: string[]): Classificacao {
  // D tem precedência sobre hedge (V2, seção 2: D é definida por
  // aparecer em informacoesNaoConfirmadas, independente de hedge).
  if (apareceEmInformacoesNaoConfirmadas(campo, informacoesNaoConfirmadas)) return "D";
  if (contemHedge(valor)) return "C";
  return "B";
}

// ────────────────────────────────────────────────────────────────────
// Candidato intermediário — 1 por item de fato em potencial, antes de
// IDs serem atribuídos (atribuição é o último passo, sobre a lista já
// filtrada/reclassificada por alertas).
// ────────────────────────────────────────────────────────────────────
interface Candidato {
  campoOrigem: CampoOrigem;
  valor: string;
  origemAtributo: OrigemAtributo;
}

/**
 * Extrai todos os candidatos a fato dos 12 campos-fonte de
 * AnaliseVisualIA (CampoOrigem). Os 4 campos sem origem própria
 * (produtoIdentificado/marca/categoriaProvavel/quantidadeDeclarada)
 * recebem origem="produto" fixa (contrato, seção 12) — nulos são
 * simplesmente omitidos (decisão de implementação: um campo ausente
 * não gera fato nenhum, nem sequer um registro em
 * informacoesProibidas — não há "conteúdo" a proibir num campo vazio;
 * consistente com a degradação natural de input esparso já descrita
 * na seção 11 do contrato).
 *
 * Regras de serialização (contrato, seção 12): categoriaProvavel vira
 * string única via " > "; quantidadeDeclarada usa textoOrigem (nunca o
 * número). Os outros 9 campos (incluindo atributosAdicionais — o
 * `nome` de cada item NÃO é preservado no valor serializado, por
 * decisão explícita do contrato: "os outros 9 campos... já viram
 * string ao passar pela extração de item individual", sem regra de
 * serialização adicional para atributosAdicionais além dessa) usam o
 * próprio texto do item.
 */
function extrairCandidatos(resultado: AnaliseVisualCompleta): Candidato[] {
  const candidatos: Candidato[] = [];

  if (resultado.produtoIdentificado) {
    candidatos.push({ campoOrigem: "produtoIdentificado", valor: resultado.produtoIdentificado, origemAtributo: "produto" });
  }
  if (resultado.marca) {
    candidatos.push({ campoOrigem: "marca", valor: resultado.marca, origemAtributo: "produto" });
  }
  if (resultado.categoriaProvavel && resultado.categoriaProvavel.length > 0) {
    candidatos.push({ campoOrigem: "categoriaProvavel", valor: resultado.categoriaProvavel.join(" > "), origemAtributo: "produto" });
  }
  if (resultado.quantidadeDeclarada.valor !== null && resultado.quantidadeDeclarada.textoOrigem !== null) {
    candidatos.push({ campoOrigem: "quantidadeDeclarada", valor: resultado.quantidadeDeclarada.textoOrigem, origemAtributo: "produto" });
  }

  for (const item of resultado.caracteristicasVisiveis) {
    candidatos.push({ campoOrigem: "caracteristicasVisiveis", valor: item.descricao, origemAtributo: item.origem });
  }
  for (const item of resultado.cores) {
    candidatos.push({ campoOrigem: "cores", valor: item.valor, origemAtributo: item.origem });
  }
  for (const item of resultado.materiais) {
    candidatos.push({ campoOrigem: "materiais", valor: item.valor, origemAtributo: item.origem });
  }
  for (const item of resultado.componentes) {
    candidatos.push({ campoOrigem: "componentes", valor: item.valor, origemAtributo: item.origem });
  }
  for (const item of resultado.textosLegiveis) {
    candidatos.push({ campoOrigem: "textosLegiveis", valor: item.texto, origemAtributo: item.origem });
  }
  for (const item of resultado.possiveisUsos) {
    candidatos.push({ campoOrigem: "possiveisUsos", valor: item.descricao, origemAtributo: item.origem });
  }
  for (const item of resultado.publicoProvavel) {
    candidatos.push({ campoOrigem: "publicoProvavel", valor: item.descricao, origemAtributo: item.origem });
  }
  for (const item of resultado.atributosAdicionais) {
    candidatos.push({ campoOrigem: "atributosAdicionais", valor: item.valor, origemAtributo: item.origem });
  }

  return candidatos;
}

// ────────────────────────────────────────────────────────────────────
// Efeito de alertas (V2, seção 6) — heurística por palavra-chave no
// TEXTO do alerta, mesma imperfeição já assumida conscientemente para
// hedge/informacoesNaoConfirmadas. "Possível produto diferente entre
// imagens" tem severidade própria — falha a execução inteira, não
// rebaixa/exclui um campo isolado.
// ────────────────────────────────────────────────────────────────────
const PALAVRAS_PRODUTO_DIFERENTE = ["produto diferente", "produtos diferentes"] as const;
const PALAVRAS_DIVERGENCIA_COR = ["cor", "cores"] as const;
const PALAVRAS_QUANTIDADE_DIVERGENTE = ["quantidade"] as const;

function verificarAlertaSeveroDeProdutoDiferente(alertas: string[]): void {
  for (const alerta of alertas) {
    if (contemAlgumaSubstring(normalizarTexto(alerta), PALAVRAS_PRODUTO_DIFERENTE)) {
      throw new ErroProvedorIA(
        "validation",
        `analise_visual sinalizou possível produto diferente entre imagens ("${alerta.slice(0, 150)}") — geracao_conteudo não prossegue sobre um resultado potencialmente ambíguo (V2, seção 6).`
      );
    }
  }
}

/**
 * Aplica o efeito dos alertas sobre a lista de candidatos já
 * classificados como B (fatosPermitidos em potencial), rebaixando para
 * C (descricoesComRessalva) ou excluindo inteiramente, conforme a
 * tabela do V2 (seção 6). Muta a lista `classificados` in-place
 * (troca a classificação de itens afetados) e devolve os registros de
 * `fatosAfetadosPorAlerta` correspondentes.
 */
function aplicarEfeitoDosAlertas(
  classificados: Array<Candidato & { classificacao: Classificacao }>,
  alertas: string[]
): FatoAfetadoPorAlerta[] {
  const afetados: FatoAfetadoPorAlerta[] = [];
  if (alertas.length === 0) return afetados;

  for (const alerta of alertas) {
    const alertaNormalizado = normalizarTexto(alerta);

    // Divergência de cor: rebaixa itens de "cores" classificados B.
    if (contemAlgumaSubstring(alertaNormalizado, PALAVRAS_DIVERGENCIA_COR)) {
      for (const c of classificados) {
        if (c.campoOrigem === "cores" && c.classificacao === "B") {
          c.classificacao = "C";
          afetados.push({ alerta, campoOrigem: c.campoOrigem, valor: c.valor, efeito: "rebaixado" });
        }
      }
    }

    // Quantidade observada divergente: exclui quantidadeDeclarada
    // inteiramente de fatosPermitidos (não rebaixa para C).
    if (contemAlgumaSubstring(alertaNormalizado, PALAVRAS_QUANTIDADE_DIVERGENTE)) {
      for (const c of classificados) {
        if (c.campoOrigem === "quantidadeDeclarada" && c.classificacao === "B") {
          afetados.push({ alerta, campoOrigem: c.campoOrigem, valor: c.valor, efeito: "excluido" });
          // Marcador especial — removido do array de saída depois deste loop.
          (c as any)._excluido = true;
        }
      }
    }

    // Informação conflitante genérica: rebaixa qualquer campo cujo
    // nome (mesma tabela de palavras-chave usada pra
    // informacoesNaoConfirmadas) apareça mencionado no texto do
    // alerta — mesma heurística imperfeita, documentada como tal.
    for (const c of classificados) {
      if (c.classificacao !== "B") continue;
      if (c.campoOrigem === "cores" || c.campoOrigem === "quantidadeDeclarada") continue; // já tratados acima com regra própria
      const palavras = PALAVRAS_CHAVE_POR_CAMPO[c.campoOrigem];
      if (contemAlgumaSubstring(alertaNormalizado, palavras)) {
        c.classificacao = "C";
        afetados.push({ alerta, campoOrigem: c.campoOrigem, valor: c.valor, efeito: "rebaixado" });
      }
    }
  }

  return afetados;
}

/**
 * Monta a entrada segura a partir do resultado de analise_visual —
 * função pura, sem I/O, sem chamada de IA (V2, seção 3). Lança
 * ErroProvedorIA("validation", ...) só no caso severo de "possível
 * produto diferente entre imagens" (V2, seção 6) — todo o resto sempre
 * produz uma entrada válida (possivelmente vazia/mínima em input
 * esparso, nunca lançando por escassez de dado).
 */
export function montarEntradaSeguraGeracaoConteudo(resultado: AnaliseVisualCompleta): EntradaSeguraGeracaoConteudo {
  verificarAlertaSeveroDeProdutoDiferente(resultado.alertas);

  const candidatos = extrairCandidatos(resultado);
  const informacoesProibidas: string[] = [...resultado.informacoesNaoConfirmadas];
  const contextoPromocional: string[] = [];

  const classificadosProduto: Array<Candidato & { classificacao: Classificacao }> = [];

  for (const candidato of candidatos) {
    switch (candidato.origemAtributo) {
      case "material_promocional":
        contextoPromocional.push(candidato.valor);
        break;
      case "embalagem_fisica":
      case "indeterminado":
        informacoesProibidas.push(candidato.valor);
        break;
      case "produto": {
        const classificacao = classificar(candidato.valor, candidato.campoOrigem, resultado.informacoesNaoConfirmadas);
        if (classificacao === "D") {
          informacoesProibidas.push(candidato.valor);
        } else {
          classificadosProduto.push({ ...candidato, classificacao });
        }
        break;
      }
    }
  }

  const fatosAfetadosPorAlerta = aplicarEfeitoDosAlertas(classificadosProduto, resultado.alertas);
  const restantes = classificadosProduto.filter(c => !(c as any)._excluido);

  // Atribuição de IDs — sequencial, 1x por chamada, nunca comparável
  // entre execuções (contrato, seção 2). fatosPermitidos primeiro,
  // depois descricoesComRessalva — ordem arbitrária mas fixa, não
  // afeta rastreabilidade (F*/R* já distinguem os dois conjuntos).
  const fatosPermitidos: FatoPermitido[] = restantes
    .filter(c => c.classificacao === "B")
    .map((c, i) => ({ id: `F${i + 1}`, campoOrigem: c.campoOrigem, valor: c.valor, origem: "produto" as const }));

  const descricoesComRessalva: DescricaoComRessalva[] = restantes
    .filter(c => c.classificacao === "C")
    .map((c, i) => ({ id: `R${i + 1}`, campoOrigem: c.campoOrigem, valor: c.valor, origem: "produto" as const }));

  return {
    fatosPermitidos,
    descricoesComRessalva,
    informacoesProibidas,
    contextoPromocional,
    alertas: [...resultado.alertas],
    fatosAfetadosPorAlerta,
  };
}

// ────────────────────────────────────────────────────────────────────
// Prompt (V2, seção 1/3; contrato, seções 1-12) — dinâmico, porque
// diferente de analise_visual (que recebe imagens via input separado
// do SDK), aqui TODO o contexto precisa estar embutido no texto: não
// há outro canal de entrada.
// ────────────────────────────────────────────────────────────────────
function formatarListaFatos(itens: Array<{ id: string; campoOrigem: string; valor: string }>): string {
  if (itens.length === 0) return "(nenhum)";
  return itens.map(f => `- [${f.id}] (${f.campoOrigem}): ${f.valor}`).join("\n");
}

export function montarPromptGeracaoConteudo(entrada: EntradaSeguraGeracaoConteudo): string {
  return `Você é um Redator de Conteúdo de Produto para Marketplaces.

Sua tarefa é gerar um JSON estruturado de conteúdo-base de anúncio (título, bullets, descrições, especificações, público sugerido) usando EXCLUSIVAMENTE os fatos numerados abaixo. Você nunca inventa, nunca infere além do que está listado, nunca completa lacunas com conhecimento geral sobre o tipo de produto.

FATOS CONFIRMADOS (cite pelo ID exato entre colchetes, ex. "F1", em "fatoIds"/"fatoId" — nunca invente um ID que não esteja nesta lista, nunca cite um fato sem usar seu ID real):
${formatarListaFatos(entrada.fatosPermitidos)}

DESCRIÇÕES COM RESSALVA (informação incerta/hedge-classificada — só pode ser citada em campos que aceitem contemRessalva=true, e nesse caso contemRessalva DEVE ser marcado true; ao usar, mantenha a linguagem de incerteza, ex. "aparenta ter", "possui características de" — nunca afirme como fato confirmado):
${formatarListaFatos(entrada.descricoesComRessalva)}

INFORMAÇÕES PROIBIDAS (nunca mencione, nunca confirme, nunca repita — mesmo que pareçam óbvias ou prováveis):
${entrada.informacoesProibidas.length > 0 ? entrada.informacoesProibidas.map(t => `- ${t}`).join("\n") : "(nenhuma)"}

CONTEXTO PROMOCIONAL (nunca repita como fato do produto, nunca implique benefício/eficácia/resultado de saúde a partir disto — é alegação de marketing, não confirmação):
${entrada.contextoPromocional.length > 0 ? entrada.contextoPromocional.map(t => `- ${t}`).join("\n") : "(nenhum)"}

REGRAS OBRIGATÓRIAS DO CONTRATO:
- tituloBase e descricaoCurta são os únicos campos obrigatórios — nunca podem ter texto vazio ("").
- tituloBase.fatoIds e especificacoes[].fatoId só podem citar IDs que comecem com "F" (nunca "R") — título e especificações nunca vêm de descrição com ressalva.
- Todo campo de saída que carrega fatoIds deve citar pelo menos 1 ID real — nunca gere um campo com fatoIds vazio; se não houver fato suficiente para sustentar um campo, OMITA o campo inteiro (não gere a chave).
- bullets, descricaoCurta, descricaoLonga: cada item tem contemRessalva (boolean). Se qualquer fatoId citado começar com "R", contemRessalva DEVE ser true. Se contemRessalva for false, nenhum fatoId citado pode começar com "R".
- Cada bullet deve conter pelo menos 1 fatoId que não apareça em nenhum outro bullet do mesmo resultado.
- especificacoes: só a partir de fatos com ID "F" — nunca duplique um bullet como especificação reescrita, mas o mesmo fato PODE aparecer em ambos, em formatos diferentes.
- publicoSugerido: sempre sugestivo ("indicado para...", "pode interessar a..."), NUNCA afirmação de indicação clínica/médica, NUNCA menção a faixa etária, condição de saúde ou enquadramento terapêutico — proibição absoluta, mesmo que os fatos sugerissem isso.
- Se o total de fatos disponíveis (confirmados + com ressalva) for pequeno, gere uma saída proporcionalmente mais curta e omita campos não essenciais (especificacoes, descricaoLonga, bullets, publicoSugerido) — nunca preencha por invenção só para parecer completo.
- Produza SOMENTE o JSON do contrato estruturado fornecido. Não inclua texto fora do JSON.
- Responda em português do Brasil.
- Não gere adaptação por marketplace, prompt de geração de imagem, roteiro de vídeo ou score — isso é responsabilidade de outras etapas, fora desta tarefa.`;
}

// ────────────────────────────────────────────────────────────────────
// Validação estrutural do JSON devolvido pelo Gemini (forma, não
// conteúdo — integridade de fatoIds é validarIntegridadeFatoIds()
// abaixo, sempre chamada depois desta).
// ────────────────────────────────────────────────────────────────────
function ehArrayDeStringsNaoVazio(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.every(x => typeof x === "string" && x.length > 0);
}

function validarTextoComFatoIds(valor: unknown, nomeCampo: string): TextoComFatoIds {
  if (typeof valor !== "object" || valor === null) {
    throw new ErroProvedorIA("validation", `"${nomeCampo}" ausente ou não é objeto.`);
  }
  const obj = valor as Record<string, unknown>;
  const chavesExtras = Object.keys(obj).filter(c => c !== "texto" && c !== "fatoIds");
  if (chavesExtras.length > 0) {
    throw new ErroProvedorIA("validation", `"${nomeCampo}" tem propriedade(s) não esperada(s): ${chavesExtras.join(", ")}.`);
  }
  if (typeof obj.texto !== "string" || obj.texto.trim() === "") {
    throw new ErroProvedorIA("validation", `"${nomeCampo}.texto" ausente, não é string ou está vazio.`);
  }
  if (!ehArrayDeStringsNaoVazio(obj.fatoIds)) {
    throw new ErroProvedorIA("validation", `"${nomeCampo}.fatoIds" ausente, não é array de strings ou está vazio.`);
  }
  return { texto: obj.texto, fatoIds: obj.fatoIds };
}

function validarTextoComRessalvaEFatoIds(valor: unknown, nomeCampo: string): TextoComRessalvaEFatoIds {
  if (typeof valor !== "object" || valor === null) {
    throw new ErroProvedorIA("validation", `"${nomeCampo}" ausente ou não é objeto.`);
  }
  const obj = valor as Record<string, unknown>;
  const chavesExtras = Object.keys(obj).filter(c => !["texto", "contemRessalva", "fatoIds"].includes(c));
  if (chavesExtras.length > 0) {
    throw new ErroProvedorIA("validation", `"${nomeCampo}" tem propriedade(s) não esperada(s): ${chavesExtras.join(", ")}.`);
  }
  if (typeof obj.texto !== "string" || obj.texto.trim() === "") {
    throw new ErroProvedorIA("validation", `"${nomeCampo}.texto" ausente, não é string ou está vazio.`);
  }
  if (typeof obj.contemRessalva !== "boolean") {
    throw new ErroProvedorIA("validation", `"${nomeCampo}.contemRessalva" ausente ou não é boolean.`);
  }
  if (!ehArrayDeStringsNaoVazio(obj.fatoIds)) {
    throw new ErroProvedorIA("validation", `"${nomeCampo}.fatoIds" ausente, não é array de strings ou está vazio.`);
  }
  return { texto: obj.texto, contemRessalva: obj.contemRessalva, fatoIds: obj.fatoIds };
}

function validarEspecificacao(valor: unknown, indice: number): EspecificacaoGerada {
  const nomeCampo = `especificacoes[${indice}]`;
  if (typeof valor !== "object" || valor === null) {
    throw new ErroProvedorIA("validation", `"${nomeCampo}" não é um objeto.`);
  }
  const obj = valor as Record<string, unknown>;
  const chavesExtras = Object.keys(obj).filter(c => !["nome", "valor", "fatoId"].includes(c));
  if (chavesExtras.length > 0) {
    throw new ErroProvedorIA("validation", `"${nomeCampo}" tem propriedade(s) não esperada(s): ${chavesExtras.join(", ")}.`);
  }
  if (typeof obj.nome !== "string" || obj.nome.trim() === "") {
    throw new ErroProvedorIA("validation", `"${nomeCampo}.nome" ausente, não é string ou está vazio.`);
  }
  if (typeof obj.valor !== "string" || obj.valor.trim() === "") {
    throw new ErroProvedorIA("validation", `"${nomeCampo}.valor" ausente, não é string ou está vazio.`);
  }
  if (typeof obj.fatoId !== "string" || obj.fatoId.trim() === "") {
    throw new ErroProvedorIA("validation", `"${nomeCampo}.fatoId" ausente, não é string ou está vazio.`);
  }
  return { nome: obj.nome, valor: obj.valor, fatoId: obj.fatoId };
}

const CAMPOS_VALIDOS_RAIZ_GERACAO_CONTEUDO = ["tituloBase", "bullets", "descricaoCurta", "descricaoLonga", "especificacoes", "publicoSugerido"];

export function validarEstruturaGeracaoConteudo(json: unknown): GeracaoConteudoIA {
  if (typeof json !== "object" || json === null) {
    throw new ErroProvedorIA("validation", "Resposta do Gemini não é um objeto JSON.");
  }
  const r = json as Record<string, unknown>;

  const chavesExtrasRaiz = Object.keys(r).filter(c => !CAMPOS_VALIDOS_RAIZ_GERACAO_CONTEUDO.includes(c));
  if (chavesExtrasRaiz.length > 0) {
    throw new ErroProvedorIA("validation", `Resposta tem propriedade(s) de nível raiz não esperada(s): ${chavesExtrasRaiz.join(", ")}.`);
  }

  const tituloBase = validarTextoComFatoIds(r.tituloBase, "tituloBase");
  const descricaoCurta = validarTextoComRessalvaEFatoIds(r.descricaoCurta, "descricaoCurta");

  let bullets: TextoComRessalvaEFatoIds[] | undefined;
  if ("bullets" in r) {
    if (!Array.isArray(r.bullets)) throw new ErroProvedorIA("validation", `"bullets" presente mas não é array.`);
    bullets = r.bullets.map((item, i) => validarTextoComRessalvaEFatoIds(item, `bullets[${i}]`));
  }

  let descricaoLonga: TextoComRessalvaEFatoIds[] | undefined;
  if ("descricaoLonga" in r) {
    if (!Array.isArray(r.descricaoLonga)) throw new ErroProvedorIA("validation", `"descricaoLonga" presente mas não é array.`);
    descricaoLonga = r.descricaoLonga.map((item, i) => validarTextoComRessalvaEFatoIds(item, `descricaoLonga[${i}]`));
  }

  let especificacoes: EspecificacaoGerada[] | undefined;
  if ("especificacoes" in r) {
    if (!Array.isArray(r.especificacoes)) throw new ErroProvedorIA("validation", `"especificacoes" presente mas não é array.`);
    especificacoes = r.especificacoes.map((item, i) => validarEspecificacao(item, i));
  }

  let publicoSugerido: TextoComFatoIds | undefined;
  if ("publicoSugerido" in r) {
    publicoSugerido = validarTextoComFatoIds(r.publicoSugerido, "publicoSugerido");
  }

  return { tituloBase, bullets, descricaoCurta, descricaoLonga, especificacoes, publicoSugerido };
}

// ────────────────────────────────────────────────────────────────────
// Validação de integridade de fatoIds (contrato, seções 2 e 2.1) —
// validador PRIMÁRIO, roda antes de qualquer persistência. As 5 regras
// cruzadas + a checagem de existência de ID no conjunto conhecido.
// ────────────────────────────────────────────────────────────────────
export interface ResultadoValidacaoIntegridade {
  valido: boolean;
  motivo?: string;
}

function validarCitacoes(
  fatoIds: string[],
  contexto: string,
  idsFatosPermitidos: Set<string>,
  idsDescricoesComRessalva: Set<string>,
  somenteF: boolean
): string | null {
  if (fatoIds.length === 0) {
    return `${contexto}: fatoIds vazio — campo presente sem nenhuma citação real é tratado como fabricação (contrato, seção 2).`;
  }
  for (const id of fatoIds) {
    const ehF = id.startsWith("F");
    const ehR = id.startsWith("R");
    if (!ehF && !ehR) {
      return `${contexto}: ID "${id}" não segue o formato esperado (F*/R*).`;
    }
    if (somenteF && ehR) {
      return `${contexto}: cita "${id}" (R*), mas este campo só aceita F* (contrato, seção 2).`;
    }
    if (ehF && !idsFatosPermitidos.has(id)) {
      return `${contexto}: ID "${id}" não existe no conjunto de fatosPermitidos enviado — fabricação.`;
    }
    if (ehR && !idsDescricoesComRessalva.has(id)) {
      return `${contexto}: ID "${id}" não existe no conjunto de descricoesComRessalva enviado — fabricação.`;
    }
  }
  return null;
}

function validarCampoComRessalva(
  campo: TextoComRessalvaEFatoIds,
  contexto: string,
  idsFatosPermitidos: Set<string>,
  idsDescricoesComRessalva: Set<string>
): string | null {
  const erroCitacao = validarCitacoes(campo.fatoIds, contexto, idsFatosPermitidos, idsDescricoesComRessalva, false);
  if (erroCitacao) return erroCitacao;

  const citaAlgumR = campo.fatoIds.some(id => id.startsWith("R"));
  if (campo.contemRessalva === false && citaAlgumR) {
    return `${contexto}: contemRessalva=false mas cita ao menos 1 fatoId "R*" (contrato, seção 2).`;
  }
  if (citaAlgumR && campo.contemRessalva !== true) {
    return `${contexto}: cita fatoId "R*" mas contemRessalva não é true (contrato, seção 2).`;
  }
  return null;
}

export function validarIntegridadeFatoIds(
  saida: GeracaoConteudoIA,
  entrada: EntradaSeguraGeracaoConteudo
): ResultadoValidacaoIntegridade {
  const idsFatosPermitidos = new Set(entrada.fatosPermitidos.map(f => f.id));
  const idsDescricoesComRessalva = new Set(entrada.descricoesComRessalva.map(f => f.id));

  const erroTitulo = validarCitacoes(saida.tituloBase.fatoIds, "tituloBase", idsFatosPermitidos, idsDescricoesComRessalva, true);
  if (erroTitulo) return { valido: false, motivo: erroTitulo };

  const erroDescricaoCurta = validarCampoComRessalva(saida.descricaoCurta, "descricaoCurta", idsFatosPermitidos, idsDescricoesComRessalva);
  if (erroDescricaoCurta) return { valido: false, motivo: erroDescricaoCurta };

  if (saida.bullets) {
    const idsExclusivosPorBullet = saida.bullets.map(b => new Set(b.fatoIds));
    for (let i = 0; i < saida.bullets.length; i++) {
      const erro = validarCampoComRessalva(saida.bullets[i], `bullets[${i}]`, idsFatosPermitidos, idsDescricoesComRessalva);
      if (erro) return { valido: false, motivo: erro };

      // Regra normativa (contrato, seção 4): cada bullet precisa de
      // >=1 fatoId que não apareça em nenhum outro bullet.
      const outrosIds = new Set<string>();
      for (let j = 0; j < idsExclusivosPorBullet.length; j++) {
        if (j === i) continue;
        for (const id of idsExclusivosPorBullet[j]) outrosIds.add(id);
      }
      const temExclusivo = saida.bullets[i].fatoIds.some(id => !outrosIds.has(id));
      if (!temExclusivo) {
        return { valido: false, motivo: `bullets[${i}]: nenhum fatoId exclusivo (todos aparecem em outros bullets) — contrato, seção 4.` };
      }
    }
  }

  if (saida.descricaoLonga) {
    for (let i = 0; i < saida.descricaoLonga.length; i++) {
      const erro = validarCampoComRessalva(saida.descricaoLonga[i], `descricaoLonga[${i}]`, idsFatosPermitidos, idsDescricoesComRessalva);
      if (erro) return { valido: false, motivo: erro };
    }
  }

  if (saida.especificacoes) {
    for (let i = 0; i < saida.especificacoes.length; i++) {
      const erro = validarCitacoes([saida.especificacoes[i].fatoId], `especificacoes[${i}]`, idsFatosPermitidos, idsDescricoesComRessalva, true);
      if (erro) return { valido: false, motivo: erro };
    }
  }

  if (saida.publicoSugerido) {
    const erro = validarCitacoes(saida.publicoSugerido.fatoIds, "publicoSugerido", idsFatosPermitidos, idsDescricoesComRessalva, true);
    if (erro) return { valido: false, motivo: erro };
  }

  return { valido: true };
}

// ────────────────────────────────────────────────────────────────────
// Pré-condições de job_origem_id (PARTE 1, seção 3.7) — 7 checagens,
// todas ANTES de qualquer chamada de IA. Qualquer falha:
// ErroProvedorIA("validation", ...) — o catch centralizado de
// executar-job.ts já sabe mapear isso para erro_tipo="validation" sem
// nenhuma chamada de IA, prompt ou consumo registrados.
// ────────────────────────────────────────────────────────────────────
interface OrigemAnaliseVisual {
  resultado: AnaliseVisualCompleta;
  jobOrigemId: string;
  resultadoId: string;
  schemaVersao: number;
}

async function validarOrigemEBuscarResultado(supabase: SupabaseClient, ctx: ContextoExecucaoJob): Promise<OrigemAnaliseVisual> {
  const { data: job, error: erroJob } = await supabase
    .from("estudio_anuncios_jobs")
    .select("id, projeto_id, job_origem_id")
    .eq("id", ctx.jobId)
    .maybeSingle();
  if (erroJob) throw new ErroProvedorIA("validation", `Falha ao ler job atual: ${erroJob.message}`.slice(0, 300));
  if (!job) throw new ErroProvedorIA("validation", `Job ${ctx.jobId} não encontrado.`);

  // 1. job_origem_id NOT NULL
  if (!job.job_origem_id) {
    throw new ErroProvedorIA(
      "validation",
      "job_origem_id ausente — geracao_conteudo exige um job de analise_visual de origem explícito (nunca inferido por ordenação)."
    );
  }

  const { data: jobOrigem, error: erroJobOrigem } = await supabase
    .from("estudio_anuncios_jobs")
    .select("id, projeto_id, etapa, status")
    .eq("id", job.job_origem_id)
    .maybeSingle();
  if (erroJobOrigem) throw new ErroProvedorIA("validation", `Falha ao ler job de origem: ${erroJobOrigem.message}`.slice(0, 300));

  // 2. origem existe
  if (!jobOrigem) {
    throw new ErroProvedorIA("validation", `Job de origem ${job.job_origem_id} não encontrado.`);
  }
  // 3. mesmo projeto
  if (jobOrigem.projeto_id !== job.projeto_id) {
    throw new ErroProvedorIA(
      "validation",
      `Job de origem pertence a outro projeto (esperado ${job.projeto_id}, encontrado ${jobOrigem.projeto_id}).`
    );
  }
  // 4. etapa = analise_visual
  if (jobOrigem.etapa !== "analise_visual") {
    throw new ErroProvedorIA("validation", `Job de origem tem etapa "${jobOrigem.etapa}", esperado "analise_visual".`);
  }
  // 5. status = concluido
  if (jobOrigem.status !== "concluido") {
    throw new ErroProvedorIA("validation", `Job de origem não está concluído (status atual: "${jobOrigem.status}").`);
  }

  const { data: resultados, error: erroResultados } = await supabase
    .from("estudio_anuncios_resultados_pipeline")
    .select("id, etapa, schema_versao, resultado")
    .eq("job_id", job.job_origem_id);
  if (erroResultados) throw new ErroProvedorIA("validation", `Falha ao ler resultado de analise_visual: ${erroResultados.message}`.slice(0, 300));

  // 6. exatamente 1 resultado
  if (!resultados || resultados.length !== 1) {
    throw new ErroProvedorIA(
      "validation",
      `Esperado exatamente 1 resultado de analise_visual para o job de origem, encontrado ${resultados?.length ?? 0}.`
    );
  }
  const resultadoRow = resultados[0] as { id: string; etapa: string; schema_versao: number; resultado: unknown };

  // 7. schema_versao e etapa do resultado
  if (resultadoRow.etapa !== "analise_visual") {
    throw new ErroProvedorIA("validation", `Resultado de origem tem etapa "${resultadoRow.etapa}", esperado "analise_visual".`);
  }
  if (resultadoRow.schema_versao !== SCHEMA_VERSAO_ANALISE_VISUAL) {
    throw new ErroProvedorIA(
      "validation",
      `Resultado de origem tem schema_versao=${resultadoRow.schema_versao}, esperado ${SCHEMA_VERSAO_ANALISE_VISUAL}.`
    );
  }

  return {
    resultado: resultadoRow.resultado as AnaliseVisualCompleta,
    jobOrigemId: job.job_origem_id as string,
    resultadoId: resultadoRow.id,
    schemaVersao: resultadoRow.schema_versao,
  };
}

// ────────────────────────────────────────────────────────────────────
// Orquestrador
// ────────────────────────────────────────────────────────────────────
export interface ExecucaoGeracaoConteudo {
  envelope: EnvelopeGeracaoConteudo;
  modelo: string;
  tokensEntrada: number;
  tokensSaida: number;
  tempoMs: number;
}

export async function executarGeracaoConteudoGoogle(
  supabaseServico: SupabaseClient,
  ctx: ContextoExecucaoJob
): Promise<ExecucaoGeracaoConteudo> {
  const origem = await validarOrigemEBuscarResultado(supabaseServico, ctx);

  const entrada = montarEntradaSeguraGeracaoConteudo(origem.resultado);

  // Entrada insuficiente (contrato, seção 11): nem produtoIdentificado
  // nem categoriaProvavel disponíveis — literalmente nada pra ancorar
  // um título. Falha ANTES de gastar uma chamada real ao Gemini.
  const temAncoraDeTitulo =
    origem.resultado.produtoIdentificado !== null || (origem.resultado.categoriaProvavel?.length ?? 0) > 0;
  if (!temAncoraDeTitulo) {
    throw new ErroProvedorIA(
      "validation",
      "Entrada insuficiente: analise_visual não produziu produtoIdentificado nem categoriaProvavel — base insuficiente para gerar conteúdo (contrato, seção 11)."
    );
  }

  const promptTexto = montarPromptGeracaoConteudo(entrada);

  const { resultadoTexto, modelo, tokensEntrada, tokensSaida, tempoMs } = await chamarGeminiTexto({
    promptTexto,
    schema: GERACAO_CONTEUDO_JSON_SCHEMA,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(resultadoTexto);
  } catch {
    throw new ErroProvedorIA("validation", "JSON inválido devolvido pelo Gemini (falha ao fazer parse).");
  }

  const saida = validarEstruturaGeracaoConteudo(parsed);

  // Validação PRIMÁRIA de integridade de fatoIds (contrato, seção
  // 2.1) — roda antes de qualquer persistência. Violação vira
  // "conteudo_rejeitado", nunca "validation" genérico — categoria
  // própria já existente no CHECK de estudio_anuncios_jobs.erro_tipo,
  // sem uso até esta implementação.
  const integridade = validarIntegridadeFatoIds(saida, entrada);
  if (!integridade.valido) {
    throw new ErroProvedorIA("conteudo_rejeitado", (integridade.motivo ?? "Violação de integridade de fatoIds.").slice(0, 300));
  }

  const fonteAnaliseVisual: FonteAnaliseVisual = {
    jobId: origem.jobOrigemId,
    resultadoId: origem.resultadoId,
    schemaVersao: origem.schemaVersao,
  };

  const envelope: EnvelopeGeracaoConteudo = { fonteAnaliseVisual, entrada, saida };

  return { envelope, modelo, tokensEntrada, tokensSaida, tempoMs };
}

/** Resumo curto e seguro para central_ia_prompts.resultado_resumo — nunca o envelope inteiro. Mesmo padrão de montarResumoCurtoAnaliseVisual(). */
export function montarResumoCurtoGeracaoConteudo(envelope: EnvelopeGeracaoConteudo): string {
  const resumo = `${envelope.saida.tituloBase.texto} — ${envelope.saida.descricaoCurta.texto}`;
  return resumo.slice(0, 500);
}

export { SCHEMA_VERSAO_GERACAO_CONTEUDO };
