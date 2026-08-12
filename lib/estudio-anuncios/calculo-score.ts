/**
 * Cálculo do score do anúncio — etapa `calculo_score`, última da Fase 1.
 *
 * ARQUITETURA: as funções `calcularBloco*()` são **puras** — recebem
 * artefatos já carregados, não tocam banco, não tocam Storage, não fazem
 * chamada externa. Isso é o que permite testar dezenas de cenários sem
 * fixture SQL. Banco e orquestração vivem só em
 * `executarCalculoScoreInterno()`, no fim do arquivo.
 *
 * ZERO IA. Nenhum import de provedor, nenhum modelo, nenhum custo. O
 * `provedor` gravado é `internal` (já aceito pelos CHECKs de
 * `estudio_anuncios_jobs` e `estudio_anuncios_resultados_pipeline`,
 * verificado no banco) e o `modelo` é `VERSAO_REGRAS_SCORE`, que
 * identifica a regra real que produziu o número — nunca uma string de
 * modelo inventada.
 *
 * TABELA LEGADA `estudio_anuncios_score`: existe desde 20260803, está
 * **vazia (0 linhas)** e NÃO é reutilizada aqui. Três motivos concretos,
 * não preferência: (1) é indexada por `projeto_marketplace_id`, ou seja,
 * um score POR MARKETPLACE, enquanto este score avalia o anúncio inteiro
 * (dados + conteúdo + imagens são do projeto, não do canal); (2) não tem
 * `job_id` nem `schema_versao`, então não dá para ter idempotência por
 * job nem versionamento de contrato; (3) tem `conversao_estimada`, que é
 * exatamente o que esta V1 **não** deve produzir. Gravar nas duas seria
 * criar uma segunda fonte de verdade. Ela segue vazia e sem uso,
 * registrada como dívida — não foi alterada nem removida.
 *
 * HARD FAIL ≠ NOTA BAIXA. Entrada estruturalmente inválida (origem
 * quebrada, artefato de outro projeto, schema incompatível, envelope
 * ilegível) levanta `validation` e o job falha. Nunca vira "score 42" —
 * o score avalia artefatos válidos, não substitui validação.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { ErroProvedorIA } from "../ai-gateway/erros";
import type { AnaliseVisualCompleta } from "../ai-gateway/provedores/google-tipos";
import { SCHEMA_VERSAO_ANALISE_VISUAL } from "../ai-gateway/provedores/google-tipos";
import type { ContextoExecucaoJob } from "./executar-job";
import { imagemGeradaExiste } from "./storage";
import type { EnvelopeGeracaoConteudo, GeracaoConteudoIA } from "./geracao-conteudo-tipos";
import { SCHEMA_VERSAO_GERACAO_CONTEUDO } from "./geracao-conteudo-tipos";
import type { EnvelopeRevisaoClaude } from "./revisao-claude-tipos";
import type { EnvelopeAdaptacaoMarketplace } from "./adaptacao-marketplace-tipos";
import { CTAS_PERMITIDOS } from "./adaptacao-marketplace-tipos";
import type { EnvelopeGeracaoPromptsImagem } from "./geracao-prompts-imagem-tipos";
import { isTipoImagem } from "./geracao-prompts-imagem-tipos";
import type { EnvelopeGeracaoImagem } from "./geracao-imagem-tipos";
import {
  DIMENSAO_MAXIMA_PX,
  DIMENSAO_MINIMA_PX,
  MIMES_IMAGEM_GERADA,
  TOLERANCIA_ASPECT_RATIO,
} from "./geracao-imagem-tipos";
import type {
  BlocoScore,
  ClassificacaoScore,
  CodigoBloco,
  CriterioScore,
  EnvelopeCalculoScore,
  FontesScore,
} from "./calculo-score-tipos";
import {
  FAIXAS_CLASSIFICACAO,
  NOMES_BLOCOS,
  PESOS_BLOCOS,
  SCHEMA_VERSAO_CALCULO_SCORE,
  VERSAO_REGRAS_SCORE,
} from "./calculo-score-tipos";

// Validação de boot — os pesos precisam somar exatamente 100. Roda 1x na
// carga do módulo, nunca por requisição: um erro de digitação num peso
// quebra o boot em vez de produzir scores silenciosamente errados.
const SOMA_PESOS = Object.values(PESOS_BLOCOS).reduce((a, b) => a + b, 0);
if (SOMA_PESOS !== 100) {
  throw new Error(`PESOS_BLOCOS soma ${SOMA_PESOS}, deveria somar exatamente 100.`);
}

// ────────────────────────────────────────────────────────────────────
// Helpers de montagem de critério
// ────────────────────────────────────────────────────────────────────
function criterio(
  codigo: string,
  pontosPossiveis: number,
  obtido: boolean | number,
  explicacao: string
): CriterioScore {
  const razao = typeof obtido === "number" ? Math.max(0, Math.min(1, obtido)) : obtido ? 1 : 0;
  const pontosObtidos = pontosPossiveis * razao;
  const status: CriterioScore["status"] = razao === 1 ? "ok" : razao === 0 ? "falha" : "parcial";
  return { codigo, pontosPossiveis, pontosObtidos, status, explicacao };
}

/** Critério que sai do denominador — "não se aplica" nunca é o mesmo que "falhou". */
function naoAplicavel(codigo: string, explicacao: string): CriterioScore {
  return { codigo, pontosPossiveis: 0, pontosObtidos: 0, status: "nao_aplicavel", explicacao };
}

/**
 * Converte os critérios de um bloco para a escala do bloco. Único ponto
 * do código que conhece o peso — nenhum critério precisa saber em que
 * bloco vive, o que mantém as funções de bloco compostas e testáveis.
 */
export function consolidarBloco(codigo: CodigoBloco, criterios: CriterioScore[]): BlocoScore {
  const pesoMaximo = PESOS_BLOCOS[codigo];
  const possiveis = criterios.reduce((a, c) => a + c.pontosPossiveis, 0);
  const obtidos = criterios.reduce((a, c) => a + c.pontosObtidos, 0);
  // Todos não-aplicáveis: bloco neutro. Devolve o peso cheio para não
  // punir o anúncio por algo que o produto não permite avaliar, e marca
  // percentual null para o consumidor saber que não houve medição.
  if (possiveis === 0) {
    return { codigo, nome: NOMES_BLOCOS[codigo], pesoMaximo, pontos: pesoMaximo, percentual: null, criterios };
  }
  const razao = obtidos / possiveis;
  return {
    codigo,
    nome: NOMES_BLOCOS[codigo],
    pesoMaximo,
    pontos: pesoMaximo * razao,
    percentual: Math.round(razao * 100),
    criterios,
  };
}

export function classificar(scoreTotal: number): ClassificacaoScore {
  for (const faixa of FAIXAS_CLASSIFICACAO) {
    if (scoreTotal >= faixa.minimo) return faixa.classificacao;
  }
  return "insuficiente";
}

/**
 * Soma os blocos e fecha a nota. Arredondamento explícito e único:
 * `Math.round()` aplicado **uma vez, só no total** — nunca por bloco,
 * senão o erro de arredondamento se acumularia e a soma dos blocos
 * deixaria de bater com o total. O clamp 0..100 é rede de segurança:
 * com pesos somando 100 e razões em [0,1] o valor já é impossível de
 * sair da faixa, mas um bug futuro num bloco não deve conseguir produzir
 * 103.
 */
export function calcularScoreFinal(blocos: BlocoScore[]): number {
  const bruto = blocos.reduce((a, b) => a + b.pontos, 0);
  return Math.max(0, Math.min(100, Math.round(bruto)));
}

// ────────────────────────────────────────────────────────────────────
// Bloco 1 — Análise visual (peso 10)
// ────────────────────────────────────────────────────────────────────
/**
 * `qualidadeDasFotos.nota` entra ESCALONADA, não 1:1 — nota 90 de foto
 * não vira automaticamente 9/10 do bloco. A escala parte de 50: abaixo
 * disso a foto é ruim o bastante para zerar o critério; de 50 a 100 sobe
 * linearmente. Isso evita que uma nota mediana de foto (60) arraste o
 * score geral como se fosse 60% de qualidade do anúncio inteiro.
 */
export function calcularBlocoAnaliseVisual(analise: AnaliseVisualCompleta): BlocoScore {
  const nota = analise.qualidadeDasFotos?.nota ?? 0;
  const escalonada = Math.max(0, Math.min(1, (nota - 50) / 50));
  const parcial = analise.metadadosAnalise?.analiseParcial === true;
  const alertas = analise.alertas ?? [];
  const analisadas = analise.metadadosAnalise?.totalFotosAnalisadas ?? 0;

  return consolidarBloco("analise_visual", [
    criterio("qualidade_fotos", 4, escalonada, `Qualidade das fotos avaliada em ${nota}/100 (escalonada a partir de 50).`),
    criterio("analise_completa", 3, !parcial, parcial
      ? `Análise parcial (motivo: ${analise.metadadosAnalise?.motivoAnaliseParcial ?? "não informado"}) — parte das fotos não entrou.`
      : "Todas as fotos elegíveis foram analisadas."),
    criterio("sem_alertas", 2, alertas.length === 0, alertas.length === 0
      ? "Nenhum alerta na análise visual."
      : `${alertas.length} alerta(s) na análise visual: ${alertas.slice(0, 3).join("; ")}.`),
    criterio("fotos_suficientes", 1, Math.min(1, analisadas / 3), `${analisadas} foto(s) analisada(s) (3 ou mais dá o ponto cheio).`),
  ]);
}

// ────────────────────────────────────────────────────────────────────
// Bloco 2 — Completude do produto (peso 15)
// ────────────────────────────────────────────────────────────────────
const soDoProduto = <T extends { origem: string }>(lista: T[] | undefined) =>
  (lista ?? []).filter(i => i.origem === "produto");

/**
 * Só conta atributo CONFIRMADO NO PRODUTO (origem="produto") — item de
 * embalagem ou de material promocional não é dado do produto.
 *
 * `marca` e `modelo` **não são pontuados**, e isso é decisão explícita da
 * tarefa: `marca=null` é resposta correta para produto genuinamente sem
 * marca visível, e o sistema não tem como distinguir "sem marca" de
 * "marca não identificada". Pontuar puniria produtos legítimos; forçar
 * `nao_aplicavel` exigiria um julgamento que nenhum artefato sustenta.
 * Então nem entram — a ausência é registrada em `alertas`, sem afetar a
 * nota.
 */
export function calcularBlocoCompletudeProduto(analise: AnaliseVisualCompleta): BlocoScore {
  const cores = soDoProduto(analise.cores);
  const materiais = soDoProduto(analise.materiais);
  const componentes = soDoProduto(analise.componentes);
  const caracteristicas = soDoProduto(analise.caracteristicasVisiveis);
  const atributos = soDoProduto(analise.atributosAdicionais);
  const usos = soDoProduto(analise.possiveisUsos);
  const categoria = analise.categoriaProvavel ?? [];

  return consolidarBloco("completude_produto", [
    criterio("produto_identificado", 4, !!analise.produtoIdentificado?.trim(), analise.produtoIdentificado
      ? `Produto identificado: "${analise.produtoIdentificado}".`
      : "Produto não identificado na análise visual."),
    criterio("categoria", 3, Math.min(1, categoria.length / 2), `Categoria com ${categoria.length} nível(is) (2 ou mais dá o ponto cheio).`),
    criterio("cores", 2, cores.length > 0, `${cores.length} cor(es) confirmada(s) no produto.`),
    criterio("materiais", 2, materiais.length > 0, `${materiais.length} material(is) confirmado(s) no produto.`),
    criterio("componentes_ou_caracteristicas", 2, componentes.length + caracteristicas.length > 0,
      `${componentes.length} componente(s) e ${caracteristicas.length} característica(s) confirmados.`),
    criterio("atributos_adicionais", 1, atributos.length > 0, `${atributos.length} atributo(s) técnico(s) adicional(is).`),
    criterio("usos", 1, usos.length > 0, `${usos.length} uso(s) confirmado(s) para o produto.`),
  ]);
}

// ────────────────────────────────────────────────────────────────────
// Bloco 3 — Conteúdo (peso 20)
// ────────────────────────────────────────────────────────────────────
/**
 * Reconhece o ESTADO do conteúdo; não reimplementa a validação de
 * `geracao_conteudo`. A etapa anterior já garante estruturalmente que
 * `tituloBase`/`descricaoCurta` existem e não são vazios — o score
 * confere mesmo assim porque avalia o artefato como ele está no banco, e
 * uma segunda checagem barata é melhor que confiar num invariante que
 * pode mudar de versão. O que ele NÃO faz é aplicar uma régua própria e
 * divergente (ex.: exigir tamanho mínimo de título que o contrato não
 * exige).
 */
export function calcularBlocoConteudo(conteudo: GeracaoConteudoIA): BlocoScore {
  const bullets = conteudo.bullets ?? [];
  const paragrafos = conteudo.descricaoLonga ?? [];
  const specs = conteudo.especificacoes ?? [];

  return consolidarBloco("conteudo", [
    criterio("titulo", 5, !!conteudo.tituloBase?.texto?.trim(), conteudo.tituloBase?.texto
      ? `Título presente (${conteudo.tituloBase.texto.length} caracteres).`
      : "Título ausente ou vazio."),
    criterio("descricao_curta", 4, !!conteudo.descricaoCurta?.texto?.trim(),
      conteudo.descricaoCurta?.texto ? "Descrição curta presente." : "Descrição curta ausente."),
    criterio("bullets", 4, Math.min(1, bullets.length / 3), `${bullets.length} bullet(s) (3 ou mais dá o ponto cheio).`),
    criterio("descricao_longa", 3, Math.min(1, paragrafos.length / 2), `${paragrafos.length} parágrafo(s) de descrição longa (2 ou mais dá o ponto cheio).`),
    criterio("especificacoes", 3, Math.min(1, specs.length / 4), `${specs.length} especificação(ões) (4 ou mais dá o ponto cheio).`),
    criterio("publico_sugerido", 1, !!conteudo.publicoSugerido?.texto?.trim(),
      conteudo.publicoSugerido ? "Público sugerido presente." : "Público sugerido ausente (opcional no contrato)."),
  ]);
}

// ────────────────────────────────────────────────────────────────────
// Bloco 4 — Integridade factual (peso 15)
// ────────────────────────────────────────────────────────────────────
/**
 * O bloco mais importante do score: mede se o conteúdo continua ancorado
 * na entrada segura. Usa exatamente as mesmas regras do contrato de
 * `geracao_conteudo` (fatoIds existem; quem cita `R*` marca
 * `contemRessalva`; `tituloBase` e `especificacoes` nunca citam `R*`).
 */
export function calcularBlocoIntegridadeFactual(envelope: EnvelopeGeracaoConteudo): BlocoScore {
  const saida = envelope.saida;
  const idsValidos = new Set<string>([
    ...(envelope.entrada?.fatosPermitidos ?? []).map(f => f.id),
    ...(envelope.entrada?.descricoesComRessalva ?? []).map(f => f.id),
  ]);
  const idsRessalva = new Set<string>((envelope.entrada?.descricoesComRessalva ?? []).map(f => f.id));

  const comRessalva = [saida.descricaoCurta, ...(saida.bullets ?? []), ...(saida.descricaoLonga ?? [])];
  const semRessalva = [saida.tituloBase, ...(saida.publicoSugerido ? [saida.publicoSugerido] : [])];
  const todosIds = [
    ...comRessalva.flatMap(t => t?.fatoIds ?? []),
    ...semRessalva.flatMap(t => t?.fatoIds ?? []),
    ...(saida.especificacoes ?? []).map(e => e.fatoId),
  ];

  const idsInexistentes = todosIds.filter(id => !idsValidos.has(id));
  const ressalvaIncoerente = comRessalva.filter(t => t && t.fatoIds?.some(id => idsRessalva.has(id)) && !t.contemRessalva);
  const ressalvaEmCampoProibido = [
    ...semRessalva.filter(t => t?.fatoIds?.some(id => idsRessalva.has(id))),
    ...(saida.especificacoes ?? []).filter(e => idsRessalva.has(e.fatoId)),
  ];
  const semAncoragem = [...comRessalva, ...semRessalva].filter(t => t && (t.fatoIds ?? []).length === 0);

  return consolidarBloco("integridade_factual", [
    criterio("fatoids_existentes", 6, idsInexistentes.length === 0, idsInexistentes.length === 0
      ? `Todos os ${todosIds.length} fatoIds citados existem na entrada segura.`
      : `${idsInexistentes.length} fatoId(s) inexistente(s): ${idsInexistentes.slice(0, 5).join(", ")}.`),
    criterio("ressalva_coerente", 4, ressalvaIncoerente.length === 0, ressalvaIncoerente.length === 0
      ? "Todo trecho que cita ressalva está marcado com contemRessalva."
      : `${ressalvaIncoerente.length} trecho(s) citam ressalva sem marcar contemRessalva.`),
    criterio("ressalva_fora_de_campo_proibido", 3, ressalvaEmCampoProibido.length === 0, ressalvaEmCampoProibido.length === 0
      ? "Nenhuma ressalva em título, público sugerido ou especificação."
      : `${ressalvaEmCampoProibido.length} campo(s) que não aceitam ressalva citam R*.`),
    criterio("ancoragem", 2, Math.min(1, 1 - semAncoragem.length / Math.max(1, comRessalva.length + semRessalva.length)),
      `${semAncoragem.length} trecho(s) sem nenhum fatoId de ancoragem.`),
  ]);
}

// ────────────────────────────────────────────────────────────────────
// Bloco 5 — Adaptação por marketplace (peso 10)
// ────────────────────────────────────────────────────────────────────
/**
 * NÃO avalia compliance real de canal (limite de caracteres, política de
 * anúncio): não existe fonte oficial verificada no repositório e a
 * Constituição proíbe afirmar regra de canal sem fonte. Avalia só o que é
 * verificável: cobertura, presença e preservação.
 */
export function calcularBlocoAdaptacaoMarketplace(
  envelope: EnvelopeAdaptacaoMarketplace,
  marketplacesDoProjeto: string[]
): BlocoScore {
  const adaptacoes = envelope.saida?.adaptacoes ?? [];
  const cobertos = new Set(adaptacoes.map(a => a.marketplace));
  const faltando = marketplacesDoProjeto.filter(m => !cobertos.has(m as never));
  const semTitulo = adaptacoes.filter(a => !a.titulo?.trim());
  const semDescricao = adaptacoes.filter(a => !a.descricao?.trim());

  const specsBase = new Map((envelope.entrada?.conteudoBase?.especificacoes ?? []).map(e => [e.nome, e.valor]));
  const specsAlteradas = adaptacoes.flatMap(a =>
    (a.especificacoes ?? []).filter(e => !specsBase.has(e.nome) || specsBase.get(e.nome) !== e.valor)
  );
  const ctasInvalidos = adaptacoes.filter(
    a => a.cta !== undefined && !(CTAS_PERMITIDOS as readonly string[]).includes(a.cta)
  );

  return consolidarBloco("adaptacao_marketplace", [
    criterio("cobertura", 4, faltando.length === 0, faltando.length === 0
      ? `Todos os ${marketplacesDoProjeto.length} marketplace(s) do projeto têm adaptação.`
      : `Sem adaptação para: ${faltando.join(", ")}.`),
    criterio("titulo_e_descricao", 3, semTitulo.length === 0 && semDescricao.length === 0,
      semTitulo.length === 0 && semDescricao.length === 0
        ? "Todas as adaptações têm título e descrição."
        : `${semTitulo.length} sem título e ${semDescricao.length} sem descrição.`),
    criterio("especificacoes_preservadas", 2, specsAlteradas.length === 0, specsAlteradas.length === 0
      ? "Nenhuma especificação alterada em relação ao conteúdo-base."
      : `${specsAlteradas.length} especificação(ões) divergem do conteúdo-base.`),
    criterio("cta_controlado", 1, ctasInvalidos.length === 0, ctasInvalidos.length === 0
      ? "CTA ausente ou dentro da lista controlada."
      : `${ctasInvalidos.length} CTA(s) fora da lista controlada.`),
  ]);
}

// ────────────────────────────────────────────────────────────────────
// Bloco 6 — Prompts de imagem (peso 10)
// ────────────────────────────────────────────────────────────────────
export function calcularBlocoPromptsImagem(envelope: EnvelopeGeracaoPromptsImagem): BlocoScore {
  const prompts = envelope.prompts ?? [];
  const previstos = envelope.configuracao?.quantidadeSolicitada ?? 0;
  const ordens = prompts.map(p => p.ordem);
  const contigua = ordens.length > 0 && [...ordens].sort((a, b) => a - b).every((o, i) => o === i + 1);
  const principais = prompts.filter(p => p.principal).length;
  const tiposInvalidos = prompts.filter(p => !isTipoImagem(p.tipo));
  const vazios = prompts.filter(p => !p.promptTexto?.trim() || !p.negativePrompt?.trim());
  const comTexto = prompts.filter(p => (p.textosPermitidos ?? []).length > 0);

  return consolidarBloco("prompts_imagem", [
    criterio("quantidade", 3, prompts.length === previstos && previstos > 0,
      `${prompts.length} prompt(s) para ${previstos} previsto(s) no projeto.`),
    criterio("uma_principal", 2, principais === 1, `${principais} prompt(s) marcado(s) como principal (esperado exatamente 1).`),
    criterio("ordem_continua", 2, contigua, contigua ? "Ordens contínuas de 1 a N." : `Ordens não contínuas: ${ordens.join(", ")}.`),
    criterio("tipos_validos", 1, tiposInvalidos.length === 0, tiposInvalidos.length === 0
      ? "Todas as finalidades são válidas." : `${tiposInvalidos.length} finalidade(s) inválida(s).`),
    criterio("prompts_preenchidos", 1, vazios.length === 0, vazios.length === 0
      ? "Todos os prompts têm texto final e negative prompt." : `${vazios.length} prompt(s) incompleto(s).`),
    criterio("sem_texto_na_imagem", 1, comTexto.length === 0, comTexto.length === 0
      ? "Nenhum texto autorizado dentro da imagem (regra da v1)." : `${comTexto.length} prompt(s) autorizam texto na imagem.`),
  ]);
}

// ────────────────────────────────────────────────────────────────────
// Bloco 7 — Imagens (peso 15) — SÓ QUALIDADE TÉCNICA
// ────────────────────────────────────────────────────────────────────
export interface LinhaImagemParaScore {
  id: string;
  prompt_ordem: number | null;
  e_principal: boolean;
  mime_type: string | null;
  largura_px: number | null;
  altura_px: number | null;
  tamanho_bytes: number | null;
  storage_path: string | null;
}

/**
 * **Só qualidade técnica, por decisão explícita.** Fidelidade visual
 * semântica (é o mesmo produto? forma/cor preservadas? acessório
 * inventado?) foi auditada MANUALMENTE em 2026-08-16 e **não é
 * transformada aqui numa regra automática falsa** — não existe sinal
 * determinístico no banco que sustente essa avaliação, e fingir que
 * existe seria pior que não pontuar. Fica registrado como pendência: um
 * auditor visual dedicado, quando houver.
 *
 * `arquivosPresentes` vem do chamador, que conferiu o Storage — a função
 * segue pura.
 */
export function calcularBlocoImagens(params: {
  imagens: LinhaImagemParaScore[];
  quantidadePrevista: number;
  aspectRatioEsperado: number;
  arquivosPresentes: number;
}): BlocoScore {
  const { imagens, quantidadePrevista, aspectRatioEsperado, arquivosPresentes } = params;
  const mimeOk = imagens.filter(i => i.mime_type && (MIMES_IMAGEM_GERADA as readonly string[]).includes(i.mime_type));
  const dimensaoOk = imagens.filter(
    i => i.largura_px && i.altura_px && i.largura_px >= DIMENSAO_MINIMA_PX && i.altura_px >= DIMENSAO_MINIMA_PX
      && i.largura_px <= DIMENSAO_MAXIMA_PX && i.altura_px <= DIMENSAO_MAXIMA_PX
  );
  const proporcaoOk = imagens.filter(i => {
    if (!i.largura_px || !i.altura_px) return false;
    return Math.abs(i.largura_px / i.altura_px - aspectRatioEsperado) / aspectRatioEsperado <= TOLERANCIA_ASPECT_RATIO;
  });
  const naoVazias = imagens.filter(i => (i.tamanho_bytes ?? 0) > 0);
  const principais = imagens.filter(i => i.e_principal).length;
  const ordens = imagens.map(i => i.prompt_ordem);
  const semDuplicidade = new Set(ordens).size === ordens.length;
  const total = Math.max(1, imagens.length);

  return consolidarBloco("imagens", [
    criterio("quantidade", 4, imagens.length === quantidadePrevista && quantidadePrevista > 0,
      `${imagens.length} imagem(ns) persistida(s) para ${quantidadePrevista} prevista(s).`),
    criterio("arquivos_presentes", 3, imagens.length > 0 ? arquivosPresentes / total : 0,
      `${arquivosPresentes} de ${imagens.length} arquivo(s) confirmados no Storage.`),
    criterio("mime_valido", 2, mimeOk.length / total, `${mimeOk.length} de ${imagens.length} com MIME suportado.`),
    criterio("dimensoes_validas", 2, dimensaoOk.length / total,
      `${dimensaoOk.length} de ${imagens.length} dentro de ${DIMENSAO_MINIMA_PX}–${DIMENSAO_MAXIMA_PX}px.`),
    criterio("proporcao", 2, proporcaoOk.length / total,
      `${proporcaoOk.length} de ${imagens.length} dentro da tolerância de proporção.`),
    criterio("uma_principal", 1, principais === 1, `${principais} imagem(ns) principal(is) (esperado exatamente 1).`),
    criterio("sem_duplicidade", 1, semDuplicidade, semDuplicidade
      ? "Nenhuma duplicidade de ordem." : "Há mais de uma imagem para a mesma ordem."),
    criterio("arquivos_nao_vazios", 0.5, naoVazias.length / total, `${naoVazias.length} de ${imagens.length} com bytes > 0.`),
  ]);
}

// ────────────────────────────────────────────────────────────────────
// Bloco 8 — Consistência geral (peso 5)
// ────────────────────────────────────────────────────────────────────
/**
 * Mede se a CADEIA se sustenta: as referências embutidas em cada envelope
 * apontam de fato para os artefatos usados. Não repete o que os outros
 * blocos já mediram — olha só o encaixe entre eles.
 */
export function calcularBlocoConsistenciaGeral(params: {
  cadeiaIntacta: boolean;
  imagensBatemComPrompts: boolean;
  revisaoReal: boolean;
}): BlocoScore {
  return consolidarBloco("consistencia_geral", [
    criterio("cadeia_de_origem", 2.5, params.cadeiaIntacta, params.cadeiaIntacta
      ? "Cada artefato referencia corretamente o artefato que consumiu."
      : "A cadeia de referências entre artefatos está quebrada."),
    criterio("imagens_batem_com_prompts", 1.5, params.imagensBatemComPrompts, params.imagensBatemComPrompts
      ? "Toda imagem corresponde a um prompt existente, com a mesma finalidade."
      : "Há imagem sem prompt correspondente ou com finalidade divergente."),
    // Revisão real não pontua ausência: rodar pelo caminho fake é estado
    // legítimo, e "0 alterações" pode significar conteúdo já bom. Vira
    // bônus pequeno quando existiu, nunca punição quando não existiu.
    params.revisaoReal
      ? criterio("revisao_aplicada", 1, true, "O conteúdo passou por revisão real antes da adaptação.")
      : naoAplicavel("revisao_aplicada", "Revisão não produziu artefato (caminho fake) — não penalizado."),
  ]);
}

// ────────────────────────────────────────────────────────────────────
// Carregamento determinístico das fontes
// ────────────────────────────────────────────────────────────────────
interface ResultadoBruto {
  id: string;
  job_id: string;
  projeto_id: string;
  etapa: string;
  schema_versao: number;
  resultado: any;
}

async function buscarResultadoPorJob(
  supabase: SupabaseClient,
  jobId: string,
  etapaEsperada: string,
  projetoId: string
): Promise<ResultadoBruto> {
  const { data, error } = await supabase
    .from("estudio_anuncios_resultados_pipeline")
    .select("id, job_id, projeto_id, etapa, schema_versao, resultado")
    .eq("job_id", jobId);
  if (error) throw new ErroProvedorIA("validation", `Falha ao ler resultado de ${etapaEsperada}: ${error.message}`.slice(0, 300));
  if (!data || data.length !== 1) {
    throw new ErroProvedorIA("validation", `Esperado exatamente 1 resultado de ${etapaEsperada} para o job ${jobId}, encontrado ${data?.length ?? 0}.`);
  }
  const row = data[0] as ResultadoBruto;
  if (row.etapa !== etapaEsperada) {
    throw new ErroProvedorIA("validation", `Resultado do job ${jobId} tem etapa "${row.etapa}", esperado "${etapaEsperada}".`);
  }
  if (row.projeto_id !== projetoId) {
    throw new ErroProvedorIA("validation", `Artefato de ${etapaEsperada} pertence a outro projeto — cadeia inválida.`);
  }
  return row;
}

/**
 * Resolve TODAS as fontes de forma determinística. Nenhum
 * `ORDER BY criado_em`, nenhum "resultado mais recente".
 *
 * A cadeia é resolvida quase toda por referência EMBUTIDA nos envelopes,
 * que é a forma mais forte disponível:
 *   geracao_imagem → `fontePromptsImagem.jobId` → geracao_prompts_imagem
 *   geracao_prompts_imagem → `fonteAnaliseVisual.jobId` → analise_visual
 *   adaptacao_marketplace → `fonteGeracaoConteudo.jobId` → revisao_claude
 *     ou geracao_conteudo
 *   revisao_claude → `fonteConteudoBase.jobId` → geracao_conteudo
 *
 * Só `adaptacao_marketplace` não é alcançável por link embutido (nada
 * aponta "para frente" a partir das imagens). Para ela vale a mesma regra
 * das RPCs de origem: **exatamente 1 candidato concluído com resultado no
 * projeto**; mais de um levanta ambiguidade explícita em vez de escolher
 * o "mais recente".
 */
export async function resolverFontesScore(
  supabase: SupabaseClient,
  ctx: ContextoExecucaoJob
): Promise<{
  analise: AnaliseVisualCompleta;
  conteudo: EnvelopeGeracaoConteudo;
  revisao: EnvelopeRevisaoClaude | null;
  adaptacao: EnvelopeAdaptacaoMarketplace;
  prompts: EnvelopeGeracaoPromptsImagem;
  imagem: EnvelopeGeracaoImagem;
  fontes: FontesScore;
  cadeiaIntacta: boolean;
}> {
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
      "job_origem_id ausente — calculo_score exige o job de geracao_imagem de origem explícito (nunca inferido por ordenação)."
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
    throw new ErroProvedorIA("validation", `Job de origem pertence a outro projeto (esperado ${job.projeto_id}).`);
  }
  if (jobOrigem.etapa !== "geracao_imagem") {
    throw new ErroProvedorIA("validation", `Job de origem tem etapa "${jobOrigem.etapa}", esperado "geracao_imagem".`);
  }
  if (jobOrigem.status !== "concluido") {
    throw new ErroProvedorIA("validation", `Job de origem não está concluído (status atual: "${jobOrigem.status}").`);
  }

  const projetoId = job.projeto_id as string;
  const rImagem = await buscarResultadoPorJob(supabase, job.job_origem_id, "geracao_imagem", projetoId);
  const imagem = rImagem.resultado as EnvelopeGeracaoImagem;

  const jobPrompts = imagem?.fontePromptsImagem?.jobId;
  if (!jobPrompts) throw new ErroProvedorIA("validation", "Envelope de geracao_imagem sem fontePromptsImagem — cadeia quebrada.");
  const rPrompts = await buscarResultadoPorJob(supabase, jobPrompts, "geracao_prompts_imagem", projetoId);
  const prompts = rPrompts.resultado as EnvelopeGeracaoPromptsImagem;

  const jobAnalise = prompts?.fonteAnaliseVisual?.jobId;
  if (!jobAnalise) throw new ErroProvedorIA("validation", "Envelope de geracao_prompts_imagem sem fonteAnaliseVisual — cadeia quebrada.");
  const rAnalise = await buscarResultadoPorJob(supabase, jobAnalise, "analise_visual", projetoId);
  if (rAnalise.schema_versao !== SCHEMA_VERSAO_ANALISE_VISUAL) {
    throw new ErroProvedorIA("validation", `analise_visual com schema_versao=${rAnalise.schema_versao}, esperado ${SCHEMA_VERSAO_ANALISE_VISUAL}.`);
  }
  const analise = rAnalise.resultado as AnaliseVisualCompleta;

  // adaptacao_marketplace: exatamente 1 no projeto (mesma disciplina das
  // RPCs de origem — nunca "a mais recente").
  const { data: adaptacoes, error: erroAd } = await supabase
    .from("estudio_anuncios_resultados_pipeline")
    .select("id, job_id, projeto_id, etapa, schema_versao, resultado")
    .eq("projeto_id", projetoId)
    .eq("etapa", "adaptacao_marketplace");
  if (erroAd) throw new ErroProvedorIA("validation", `Falha ao ler adaptacao_marketplace: ${erroAd.message}`.slice(0, 300));
  if (!adaptacoes || adaptacoes.length !== 1) {
    throw new ErroProvedorIA(
      "validation",
      `ORIGEM_AMBIGUA: esperado exatamente 1 resultado de adaptacao_marketplace no projeto, encontrado ${adaptacoes?.length ?? 0}.`
    );
  }
  const rAdaptacao = adaptacoes[0] as ResultadoBruto;
  const adaptacao = rAdaptacao.resultado as EnvelopeAdaptacaoMarketplace;

  // Da adaptação sai o conteúdo-base: pode ser a revisão (quando real) ou
  // direto a geração de conteúdo (quando a revisão rodou fake).
  const jobConteudoBase = adaptacao?.fonteGeracaoConteudo?.jobId;
  if (!jobConteudoBase) throw new ErroProvedorIA("validation", "Envelope de adaptacao_marketplace sem fonteGeracaoConteudo — cadeia quebrada.");
  const { data: baseRows, error: erroBase } = await supabase
    .from("estudio_anuncios_resultados_pipeline")
    .select("id, job_id, projeto_id, etapa, schema_versao, resultado")
    .eq("job_id", jobConteudoBase);
  if (erroBase) throw new ErroProvedorIA("validation", `Falha ao ler conteúdo-base: ${erroBase.message}`.slice(0, 300));
  if (!baseRows || baseRows.length !== 1) {
    throw new ErroProvedorIA("validation", `Esperado exatamente 1 resultado para o conteúdo-base, encontrado ${baseRows?.length ?? 0}.`);
  }
  const rBase = baseRows[0] as ResultadoBruto;
  if (rBase.projeto_id !== projetoId) {
    throw new ErroProvedorIA("validation", "Conteúdo-base pertence a outro projeto — cadeia inválida.");
  }

  let revisao: EnvelopeRevisaoClaude | null = null;
  let rConteudo: ResultadoBruto;
  if (rBase.etapa === "revisao_claude") {
    revisao = rBase.resultado as EnvelopeRevisaoClaude;
    const jobConteudo = revisao?.fonteConteudoBase?.jobId;
    if (!jobConteudo) throw new ErroProvedorIA("validation", "Envelope de revisao_claude sem fonteConteudoBase — cadeia quebrada.");
    rConteudo = await buscarResultadoPorJob(supabase, jobConteudo, "geracao_conteudo", projetoId);
  } else if (rBase.etapa === "geracao_conteudo") {
    rConteudo = rBase;
  } else {
    throw new ErroProvedorIA("validation", `Conteúdo-base tem etapa "${rBase.etapa}", esperado "revisao_claude" ou "geracao_conteudo".`);
  }
  if (rConteudo.schema_versao !== SCHEMA_VERSAO_GERACAO_CONTEUDO) {
    throw new ErroProvedorIA("validation", `geracao_conteudo com schema_versao=${rConteudo.schema_versao}, esperado ${SCHEMA_VERSAO_GERACAO_CONTEUDO}.`);
  }
  const conteudo = rConteudo.resultado as EnvelopeGeracaoConteudo;
  if (!conteudo?.saida?.tituloBase) {
    throw new ErroProvedorIA("validation", "Envelope de geracao_conteudo sem saída utilizável — artefato inválido.");
  }

  // A cadeia está íntegra quando a análise visual referenciada pelo
  // conteúdo é a MESMA usada pelos prompts de imagem.
  const cadeiaIntacta = conteudo?.fonteAnaliseVisual?.jobId === jobAnalise;

  return {
    analise,
    conteudo,
    revisao,
    adaptacao,
    prompts,
    imagem,
    cadeiaIntacta,
    fontes: {
      analiseVisualJobId: jobAnalise,
      geracaoConteudoJobId: rConteudo.job_id,
      revisaoClaudeJobId: revisao ? rBase.job_id : null,
      adaptacaoMarketplaceJobId: rAdaptacao.job_id,
      geracaoPromptsImagemJobId: jobPrompts,
      geracaoImagemJobId: job.job_origem_id as string,
    },
  };
}

// ────────────────────────────────────────────────────────────────────
// Orquestrador
// ────────────────────────────────────────────────────────────────────
export interface ExecucaoCalculoScore {
  envelope: EnvelopeCalculoScore;
  modelo: string;
}

export async function executarCalculoScoreInterno(
  supabaseServico: SupabaseClient,
  ctx: ContextoExecucaoJob
): Promise<ExecucaoCalculoScore> {
  const f = await resolverFontesScore(supabaseServico, ctx);

  const { data: mks, error: erroMk } = await supabaseServico
    .from("estudio_anuncios_projetos_marketplace")
    .select("marketplace")
    .eq("projeto_id", ctx.projetoId);
  if (erroMk) throw new ErroProvedorIA("validation", `Falha ao ler marketplaces do projeto: ${erroMk.message}`.slice(0, 300));
  const marketplaces = (mks ?? []).map(m => (m as { marketplace: string }).marketplace).sort();

  const { data: linhasImagem, error: erroImg } = await supabaseServico
    .from("estudio_anuncios_imagens_geradas")
    .select("id, prompt_ordem, e_principal, mime_type, largura_px, altura_px, tamanho_bytes, storage_path")
    .eq("job_id", f.fontes.geracaoImagemJobId);
  if (erroImg) throw new ErroProvedorIA("validation", `Falha ao ler imagens geradas: ${erroImg.message}`.slice(0, 300));
  const imagens = (linhasImagem ?? []) as LinhaImagemParaScore[];

  // Confere presença real dos arquivos — leitura apenas, nada é escrito.
  let arquivosPresentes = 0;
  for (const img of imagens) {
    if (!img.storage_path) continue;
    if (await imagemGeradaExiste(supabaseServico, img.storage_path)) arquivosPresentes++;
  }

  const aspectRatio = f.prompts?.configuracao?.aspectRatio ?? "1:1";
  const [l, a] = aspectRatio.split(":").map(Number);
  const razaoEsperada = l && a ? l / a : 1;

  const ordensPrompts = new Set((f.prompts.prompts ?? []).map(p => p.ordem));
  const imagensBatemComPrompts =
    imagens.length > 0 &&
    imagens.every(i => i.prompt_ordem !== null && ordensPrompts.has(i.prompt_ordem));

  const blocos: BlocoScore[] = [
    calcularBlocoAnaliseVisual(f.analise),
    calcularBlocoCompletudeProduto(f.analise),
    calcularBlocoConteudo(f.conteudo.saida),
    calcularBlocoIntegridadeFactual(f.conteudo),
    calcularBlocoAdaptacaoMarketplace(f.adaptacao, marketplaces),
    calcularBlocoPromptsImagem(f.prompts),
    calcularBlocoImagens({
      imagens,
      quantidadePrevista: f.imagem?.configuracao?.quantidadePrevista ?? 0,
      aspectRatioEsperado: razaoEsperada,
      arquivosPresentes,
    }),
    calcularBlocoConsistenciaGeral({
      cadeiaIntacta: f.cadeiaIntacta,
      imagensBatemComPrompts,
      revisaoReal: f.revisao !== null,
    }),
  ];

  const alertas: string[] = [];
  if (!f.revisao) alertas.push("A revisão de conteúdo não produziu artefato (rodou pelo caminho fake) — não penalizado.");
  if (!f.analise.marca) alertas.push("Marca não identificada na análise visual — não pontuada nem penalizada (pode ser produto sem marca visível).");
  if (!f.analise.modelo) alertas.push("Modelo não identificado na análise visual — não pontuado nem penalizado.");
  alertas.push("Fidelidade visual semântica NÃO é avaliada nesta versão — só qualidade técnica das imagens.");

  const scoreTotal = calcularScoreFinal(blocos);

  return {
    envelope: {
      scoreTotal,
      classificacao: classificar(scoreTotal),
      versaoRegrasScore: VERSAO_REGRAS_SCORE,
      blocos,
      alertas,
      fontes: f.fontes,
      calculadoEm: new Date().toISOString(),
    },
    modelo: VERSAO_REGRAS_SCORE,
  };
}

/** Resumo curto e seguro para o campo de conteúdo da resposta. */
export function montarResumoCurtoScore(envelope: EnvelopeCalculoScore): string {
  const detalhe = envelope.blocos.map(b => `${b.codigo}:${Math.round(b.pontos)}/${b.pesoMaximo}`).join(" ");
  return `Score ${envelope.scoreTotal}/100 (${envelope.classificacao}) — ${detalhe}`.slice(0, 500);
}

export { SCHEMA_VERSAO_CALCULO_SCORE, VERSAO_REGRAS_SCORE };
