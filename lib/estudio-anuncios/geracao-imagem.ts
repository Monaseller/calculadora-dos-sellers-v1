/**
 * Orquestração da etapa `geracao_imagem` — pré-condições + seleção de
 * referências + geração sequencial + validação do arquivo + persistência.
 *
 * Diferente das etapas anteriores, esta persiste DENTRO do orquestrador
 * (Storage + `estudio_anuncios_imagens_geradas`), e isso é deliberado: a
 * recuperação parcial exige que a imagem 1 já esteja gravada antes de a
 * imagem 2 ser pedida. Se a persistência ficasse no executor, uma falha
 * na imagem 3 jogaria fora as duas primeiras — e o provedor já teria
 * cobrado por elas. O que continua fora daqui, como nas outras etapas:
 * decidir provedor, registrar prompt/consumo, avançar Pipeline e gravar
 * `resultados_pipeline` (isso é do executor/rota).
 *
 * GERAÇÃO SEQUENCIAL, nunca paralela: custo controlado, recuperação
 * parcial, retry simples, menor pico de memória (cada imagem pode ter
 * vários MB em Uint8Array) e menor risco de estourar o timeout do
 * Worker.
 *
 * O que esta etapa NUNCA faz (verificado por teste que lê este arquivo):
 * inventar prompt, reinterpretar copy comercial, alterar a quantidade de
 * imagens, criar texto/CTA, alterar marketplace, recalcular score,
 * refazer analise_visual, escrever em `conteudo_versoes`, alterar
 * `estudio_anuncios_imagens_origem` ou tornar objeto público.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { ErroProvedorIA } from "../ai-gateway/erros";
import { gerarImagemGoogle, obterModeloImagem } from "../ai-gateway/provedores/google-imagem";
import { escolherEComporCapa } from "./capa-deterministica";
import type { ReferenciaVisual } from "../ai-gateway/provedores/google-imagem";
import type { ContextoExecucaoJob } from "./executar-job";
import type { EnvelopeGeracaoPromptsImagem, PromptImagem, TipoImagem } from "./geracao-prompts-imagem-tipos";
import { SCHEMA_VERSAO_GERACAO_PROMPTS_IMAGEM, isTipoImagem } from "./geracao-prompts-imagem-tipos";
import type {
  ConfiguracaoGeracaoImagem,
  EnvelopeGeracaoImagem,
  FontePromptsImagem,
  ImagemGeradaRef,
  MimeImagemGerada,
  ReferenciaUtilizada,
} from "./geracao-imagem-tipos";
import {
  DIMENSAO_MAXIMA_PX,
  DIMENSAO_MINIMA_PX,
  MAX_BYTES_REFERENCIAS,
  MAX_REFERENCIAS_VISUAIS,
  MIMES_IMAGEM_GERADA,
  SCHEMA_VERSAO_GERACAO_IMAGEM,
  TAMANHO_MAXIMO_IMAGEM_BYTES,
  TOLERANCIA_ASPECT_RATIO,
} from "./geracao-imagem-tipos";
import {
  baixarObjeto,
  detectarMimeReal,
  excluirImagemGerada,
  imagemGeradaExiste,
  montarCaminhoImagemGerada,
  obterDimensoes,
  uploadImagemGerada,
} from "./storage";

// ────────────────────────────────────────────────────────────────────
// Validação do arquivo recebido — funções puras
// ────────────────────────────────────────────────────────────────────

/** "1:1" → 1. Lança para qualquer forma que não seja `inteiro:inteiro` positivo. */
export function razaoDoAspectRatio(aspectRatio: string): number {
  const m = /^(\d+):(\d+)$/.exec(aspectRatio.trim());
  if (!m) throw new ErroProvedorIA("validation", `aspectRatio inválido no contrato: "${aspectRatio}".`);
  const l = Number(m[1]);
  const a = Number(m[2]);
  if (l <= 0 || a <= 0) throw new ErroProvedorIA("validation", `aspectRatio com valor não-positivo: "${aspectRatio}".`);
  return l / a;
}

export interface DimensoesImagem {
  largura: number;
  altura: number;
}

/**
 * Valida a imagem recebida ANTES de qualquer upload. Toda falha aqui é
 * `conteudo_rejeitado` (o provedor devolveu algo inutilizável), nunca
 * `unknown` — o job entra no retry normal em vez de morrer opaco.
 *
 * Ordem deliberada: bytes → MIME real → dimensões → proporção. Cada
 * checagem só roda se a anterior passou, então a mensagem de erro aponta
 * a primeira causa real, não um efeito colateral.
 */
export function validarImagemRecebida(params: {
  bytes: Uint8Array;
  mimeReal: MimeImagemGerada | null;
  dimensoes: DimensoesImagem | null;
  aspectRatioEsperado: string;
  ordem: number;
}): { mime: MimeImagemGerada; dimensoes: DimensoesImagem } {
  const onde = `imagem ${params.ordem}`;

  if (!params.bytes || params.bytes.length === 0) {
    throw new ErroProvedorIA("conteudo_rejeitado", `${onde}: arquivo vazio (0 bytes).`);
  }
  if (params.bytes.length > TAMANHO_MAXIMO_IMAGEM_BYTES) {
    throw new ErroProvedorIA(
      "conteudo_rejeitado",
      `${onde}: arquivo de ${params.bytes.length} bytes acima do teto de ${TAMANHO_MAXIMO_IMAGEM_BYTES}.`
    );
  }

  // MIME por magic bytes — o MIME declarado pelo provedor nunca é aceito
  // como verdade, mesma disciplina já usada no upload das fotos originais.
  if (!params.mimeReal || !(MIMES_IMAGEM_GERADA as readonly string[]).includes(params.mimeReal)) {
    throw new ErroProvedorIA(
      "conteudo_rejeitado",
      `${onde}: MIME real não suportado (detectado: ${params.mimeReal ?? "irreconhecível"}).`
    );
  }

  if (!params.dimensoes) {
    throw new ErroProvedorIA("conteudo_rejeitado", `${onde}: não foi possível ler as dimensões — arquivo provavelmente corrompido.`);
  }
  const { largura, altura } = params.dimensoes;
  if (largura < DIMENSAO_MINIMA_PX || altura < DIMENSAO_MINIMA_PX) {
    throw new ErroProvedorIA(
      "conteudo_rejeitado",
      `${onde}: ${largura}x${altura} abaixo da dimensão mínima de ${DIMENSAO_MINIMA_PX}px.`
    );
  }
  if (largura > DIMENSAO_MAXIMA_PX || altura > DIMENSAO_MAXIMA_PX) {
    throw new ErroProvedorIA(
      "conteudo_rejeitado",
      `${onde}: ${largura}x${altura} acima da dimensão máxima de ${DIMENSAO_MAXIMA_PX}px.`
    );
  }

  const esperada = razaoDoAspectRatio(params.aspectRatioEsperado);
  const obtida = largura / altura;
  const desvio = Math.abs(obtida - esperada) / esperada;
  if (desvio > TOLERANCIA_ASPECT_RATIO) {
    // Decisão explícita do usuário (2026-08-16): REJEITAR. Nunca crop,
    // nunca resize, nunca aceitar calado.
    throw new ErroProvedorIA(
      "conteudo_rejeitado",
      `${onde}: proporção ${largura}x${altura} desvia ${(desvio * 100).toFixed(1)}% de ${params.aspectRatioEsperado} (tolerância ${(TOLERANCIA_ASPECT_RATIO * 100).toFixed(0)}%).`
    );
  }

  return { mime: params.mimeReal, dimensoes: params.dimensoes };
}

// ────────────────────────────────────────────────────────────────────
// numero_versao — mantém válido o unique (projeto, finalidade, versao)
// ────────────────────────────────────────────────────────────────────

/**
 * Mapa `ordem do prompt` → `numero_versao`.
 *
 * Existe por causa do unique `(projeto_id, finalidade, numero_versao)`,
 * que já vinha da tabela original, combinado com o fato de o contrato de
 * `geracao_prompts_imagem` permitir dois prompts da mesma finalidade
 * (ex.: dois `detalhes`).
 *
 * CORREÇÃO (2026-08-18, §37.2 — defeito real, pego por execução real).
 * A primeira versão numerava só DENTRO do job (1, 2, 3...), o que mantém
 * a unicidade dentro de um job mas **colide entre jobs**: gerar imagens
 * de novo para um projeto que já tinha `capa_principal` versão 1
 * quebrava o INSERT com violação de unique. A ação compensatória removeu
 * o objeto do Storage — mas a imagem já tinha sido gerada e paga.
 *
 * A leitura correta da coluna é a do nome dela: **versão daquela
 * finalidade DENTRO DO PROJETO**. Por isso o número agora parte do maior
 * já existente no projeto (`versoesExistentesPorFinalidade`) e soma o
 * índice dentro deste job. Continua determinístico onde precisa ser: um
 * retry nunca chega ao INSERT de uma imagem já persistida (a idempotência
 * resolve antes), então o número só é calculado para imagem realmente
 * nova.
 */
export function calcularNumeroVersaoPorOrdem(
  prompts: PromptImagem[],
  versoesExistentesPorFinalidade: Map<string, number> = new Map()
): Map<number, number> {
  const contagem = new Map<string, number>();
  const mapa = new Map<number, number>();
  for (const p of [...prompts].sort((a, b) => a.ordem - b.ordem)) {
    const n = (contagem.get(p.tipo) ?? 0) + 1;
    contagem.set(p.tipo, n);
    mapa.set(p.ordem, (versoesExistentesPorFinalidade.get(p.tipo) ?? 0) + n);
  }
  return mapa;
}

// ────────────────────────────────────────────────────────────────────
// Idempotência — decisão isolada em função pura, e por um motivo
// ────────────────────────────────────────────────────────────────────

export type DecisaoIdempotencia =
  | { acao: "reaproveitar"; imagemGeradaId: string; storagePath: string }
  | { acao: "gerar" }
  | { acao: "inconsistencia"; motivo: string };

export interface LinhaImagemExistente {
  id: string;
  storage_path: string | null;
  finalidade: string;
  e_principal: boolean;
}

/**
 * Decide o que fazer com um prompt cuja imagem pode já existir. Extraída
 * do laço de propósito: é a regra mais delicada da etapa (um erro aqui
 * duplica custo ou apaga trabalho pago) e precisa ser testável sem banco,
 * sem Storage e sem provedor.
 *
 * Os quatro cenários da tarefa:
 *   A. linha no banco + arquivo no Storage → reaproveitar (retry barato)
 *   B. linha no banco, arquivo ausente     → INCONSISTÊNCIA explícita.
 *      Nunca regerar por cima: a linha descreve dimensões/MIME/tamanho
 *      de um arquivo específico, e um arquivo novo não seria aquele.
 *      Exige intervenção manual em vez de "consertar" sozinho.
 *   C. arquivo sem linha                   → impossível colidir aqui (o
 *      caminho embute um UUID novo), e o upload usa `upsert:false`, então
 *      um órfão jamais é sobrescrito em silêncio. Detecção de órfão é
 *      papel da auditoria, não deste laço.
 *   D. resultado parcial                   → cada prompt decide sozinho,
 *      então um job que morreu na imagem 3 retoma da 3.
 */
export function decidirIdempotencia(
  linhaExistente: LinhaImagemExistente | null | undefined,
  arquivoExiste: boolean
): DecisaoIdempotencia {
  if (!linhaExistente) return { acao: "gerar" };
  if (!linhaExistente.storage_path) {
    return { acao: "inconsistencia", motivo: `imagem ${linhaExistente.id} registrada sem storage_path.` };
  }
  if (!arquivoExiste) {
    return {
      acao: "inconsistencia",
      motivo: `imagem ${linhaExistente.id} existe no banco mas o arquivo não está no Storage — requer intervenção manual, não é regerada automaticamente.`,
    };
  }
  return { acao: "reaproveitar", imagemGeradaId: linhaExistente.id, storagePath: linhaExistente.storage_path };
}

/**
 * Confere que o caminho montado está mesmo dentro do prefixo do usuário,
 * do projeto e do job antes de qualquer upload. `montarCaminhoImagemGerada`
 * já constrói assim, então isto é defesa em profundidade — o tipo de
 * checagem que só é inútil enquanto ninguém mexe no código acima.
 */
export function validarCaminhoSeguro(caminho: string, userId: string, projetoId: string, jobId: string): void {
  const prefixo = `${userId}/${projetoId}/geradas/${jobId}/`;
  if (!caminho.startsWith(prefixo)) {
    throw new ErroProvedorIA("validation", `Caminho de Storage fora do prefixo permitido do job.`);
  }
  if (caminho.includes("..") || caminho.includes("//") || /[\r\n]/.test(caminho)) {
    throw new ErroProvedorIA("validation", `Caminho de Storage com sequência proibida.`);
  }
  if (caminho.slice(prefixo.length).includes("/")) {
    throw new ErroProvedorIA("validation", `Caminho de Storage com subdiretório inesperado após o job.`);
  }
}

// ────────────────────────────────────────────────────────────────────
// Seleção determinística das referências visuais
// ────────────────────────────────────────────────────────────────────
export interface FotoOriginal {
  id: string;
  ordem: number;
  e_principal: boolean;
  storage_path: string;
  mime_type: string | null;
  tamanho_bytes: number | null;
}

/**
 * Seleciona as fotos que servirão de referência: principal primeiro,
 * depois `ordem` ASC, respeitando teto de quantidade e de bytes. Nunca
 * aleatório, nunca "a mais recente" — o mesmo projeto produz sempre a
 * mesma seleção, o que é pré-requisito para o retry ser reprodutível.
 *
 * Fotos sem MIME aceito são puladas (nunca enviadas "no escuro"), e uma
 * foto que sozinha estoure o orçamento de bytes é pulada em vez de
 * truncar a lista — assim uma foto gigante no meio não elimina as
 * seguintes.
 */
export function selecionarReferencias(fotos: FotoOriginal[]): FotoOriginal[] {
  const ordenadas = [...fotos].sort((a, b) => {
    if (a.e_principal !== b.e_principal) return a.e_principal ? -1 : 1;
    return a.ordem - b.ordem;
  });
  const escolhidas: FotoOriginal[] = [];
  let bytes = 0;
  for (const f of ordenadas) {
    if (escolhidas.length >= MAX_REFERENCIAS_VISUAIS) break;
    if (!f.mime_type || !(MIMES_IMAGEM_GERADA as readonly string[]).includes(f.mime_type)) continue;
    const tamanho = f.tamanho_bytes ?? 0;
    if (bytes + tamanho > MAX_BYTES_REFERENCIAS) continue;
    bytes += tamanho;
    escolhidas.push(f);
  }
  return escolhidas;
}

// ────────────────────────────────────────────────────────────────────
// Pré-condições de origem
// ────────────────────────────────────────────────────────────────────
interface OrigemPromptsImagem {
  prompts: PromptImagem[];
  aspectRatio: string;
  jobOrigemId: string;
  resultadoId: string;
  schemaVersao: number;
}

/** Exportada para teste determinístico com cliente Supabase de mentira. */
export async function validarOrigemEBuscarPrompts(
  supabase: SupabaseClient,
  ctx: ContextoExecucaoJob
): Promise<OrigemPromptsImagem> {
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
      "job_origem_id ausente — geracao_imagem exige o job de geracao_prompts_imagem de origem explícito (nunca inferido por ordenação)."
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
  if (jobOrigem.etapa !== "geracao_prompts_imagem") {
    throw new ErroProvedorIA(
      "validation",
      `Job de origem tem etapa "${jobOrigem.etapa}", esperado "geracao_prompts_imagem" — geracao_imagem executa o contrato de prompts, não decide estratégia visual.`
    );
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
      `Esperado exatamente 1 resultado de geracao_prompts_imagem para o job de origem, encontrado ${resultados?.length ?? 0}.`
    );
  }
  const row = resultados[0] as { id: string; etapa: string; schema_versao: number; resultado: unknown };
  if (row.etapa !== "geracao_prompts_imagem") {
    throw new ErroProvedorIA("validation", `Resultado de origem tem etapa "${row.etapa}", esperado "geracao_prompts_imagem".`);
  }
  if (row.schema_versao !== SCHEMA_VERSAO_GERACAO_PROMPTS_IMAGEM) {
    throw new ErroProvedorIA(
      "validation",
      `Resultado de origem tem schema_versao=${row.schema_versao}, esperado ${SCHEMA_VERSAO_GERACAO_PROMPTS_IMAGEM}.`
    );
  }

  const envelope = row.resultado as EnvelopeGeracaoPromptsImagem;
  const prompts = envelope?.prompts;
  if (!Array.isArray(prompts) || prompts.length === 0) {
    throw new ErroProvedorIA("validation", "Envelope de geracao_prompts_imagem sem prompts utilizáveis.");
  }
  const quantidadePrevista = envelope?.configuracao?.quantidadeSolicitada;
  if (prompts.length !== quantidadePrevista) {
    throw new ErroProvedorIA(
      "validation",
      `Envelope inconsistente: ${prompts.length} prompt(s) para quantidadeSolicitada=${quantidadePrevista}.`
    );
  }
  const principais = prompts.filter(p => p.principal).length;
  if (principais !== 1) {
    throw new ErroProvedorIA("validation", `Envelope com ${principais} imagem(ns) principal(is), esperado exatamente 1.`);
  }
  for (const p of prompts) {
    if (!isTipoImagem(p.tipo)) {
      throw new ErroProvedorIA("validation", `Prompt ${p.ordem} com finalidade inválida: ${JSON.stringify(p.tipo)}.`);
    }
    if (typeof p.promptTexto !== "string" || p.promptTexto.trim().length === 0) {
      throw new ErroProvedorIA("validation", `Prompt ${p.ordem} sem texto final utilizável.`);
    }
  }

  return {
    prompts: [...prompts].sort((a, b) => a.ordem - b.ordem),
    aspectRatio: envelope.configuracao.aspectRatio,
    jobOrigemId: job.job_origem_id as string,
    resultadoId: row.id,
    schemaVersao: row.schema_versao,
  };
}

// ────────────────────────────────────────────────────────────────────
// Orquestrador
// ────────────────────────────────────────────────────────────────────
export interface ExecucaoGeracaoImagem {
  envelope: EnvelopeGeracaoImagem;
  modelo: string;
  tokensEntrada: number;
  tokensSaida: number;
  /** Fatia de `tokensSaida` cobrada como imagem - soma das chamadas desta execucao. */
  tokensSaidaImagem: number;
  tempoMs: number;
  /** Quantas imagens foram efetivamente geradas nesta execução (as reaproveitadas não contam). */
  imagensGeradasAgora: number;
}

export async function executarGeracaoImagemGoogle(
  supabaseServico: SupabaseClient,
  ctx: ContextoExecucaoJob
): Promise<ExecucaoGeracaoImagem> {
  const origem = await validarOrigemEBuscarPrompts(supabaseServico, ctx);
  const modelo = obterModeloImagem();

  const { data: projeto, error: erroProj } = await supabaseServico
    .from("estudio_anuncios_projetos")
    .select("id, user_id")
    .eq("id", ctx.projetoId)
    .maybeSingle();
  if (erroProj) throw new ErroProvedorIA("validation", `Falha ao ler o projeto: ${erroProj.message}`.slice(0, 300));
  if (!projeto?.user_id) throw new ErroProvedorIA("validation", `Projeto ${ctx.projetoId} sem user_id — caminho de Storage não pode ser montado.`);
  const userId = projeto.user_id as string;

  // Referências visuais — só fotos DO MESMO projeto, baixadas via
  // service role, nunca por URL pública nem assinada.
  const { data: fotosBrutas, error: erroFotos } = await supabaseServico
    .from("estudio_anuncios_imagens_origem")
    .select("id, ordem, e_principal, storage_path, mime_type, tamanho_bytes")
    .eq("projeto_id", ctx.projetoId);
  if (erroFotos) throw new ErroProvedorIA("validation", `Falha ao listar fotos do projeto: ${erroFotos.message}`.slice(0, 300));
  const selecionadas = selecionarReferencias((fotosBrutas ?? []) as FotoOriginal[]);

  const referenciasBytes: ReferenciaVisual[] = [];
  const referenciasUtilizadas: ReferenciaUtilizada[] = [];
  for (const f of selecionadas) {
    referenciasBytes.push({ buffer: await baixarObjeto(supabaseServico, f.storage_path), mimeType: f.mime_type as string });
    referenciasUtilizadas.push({ imagemOrigemId: f.id, ordem: f.ordem, principal: f.e_principal });
  }

  const configuracao: ConfiguracaoGeracaoImagem = {
    quantidadePrevista: origem.prompts.length,
    aspectRatio: origem.aspectRatio,
    toleranciaAspectRatio: TOLERANCIA_ASPECT_RATIO,
    dimensaoMinimaPx: DIMENSAO_MINIMA_PX,
    dimensaoMaximaPx: DIMENSAO_MAXIMA_PX,
    referencias: referenciasUtilizadas,
  };

  // Maior numero_versao já existente por finalidade NESTE projeto —
  // inclui imagens de jobs anteriores, que é justamente o caso que
  // quebrava o INSERT antes da correção de 2026-08-18.
  const { data: versoesBrutas, error: erroVersoes } = await supabaseServico
    .from("estudio_anuncios_imagens_geradas")
    .select("finalidade, numero_versao")
    .eq("projeto_id", ctx.projetoId);
  if (erroVersoes) {
    throw new ErroProvedorIA("validation", `Falha ao ler versões existentes: ${erroVersoes.message}`.slice(0, 300));
  }
  const versoesExistentes = new Map<string, number>();
  for (const linha of (versoesBrutas ?? []) as { finalidade: string; numero_versao: number }[]) {
    versoesExistentes.set(linha.finalidade, Math.max(versoesExistentes.get(linha.finalidade) ?? 0, linha.numero_versao));
  }

  const versaoPorOrdem = calcularNumeroVersaoPorOrdem(origem.prompts, versoesExistentes);
  const imagens: ImagemGeradaRef[] = [];
  let tokensEntrada = 0;
  let tokensSaida = 0;
  let tokensSaidaImagem = 0;
  let tempoMs = 0;
  let geradasAgora = 0;

  // SEQUENCIAL, com persistência a cada passo — ver cabeçalho.
  for (const prompt of origem.prompts) {
    // ── Idempotência: esta imagem já existe para este job? ──────────
    const { data: existentes, error: erroExist } = await supabaseServico
      .from("estudio_anuncios_imagens_geradas")
      .select("id, storage_path, finalidade, e_principal")
      .eq("job_id", ctx.jobId)
      .eq("prompt_ordem", prompt.ordem);
    if (erroExist) throw new ErroProvedorIA("validation", `Falha ao checar imagem existente: ${erroExist.message}`.slice(0, 300));

    const linha = (existentes?.[0] as LinhaImagemExistente | undefined) ?? null;
    const arquivoExiste = linha?.storage_path ? await imagemGeradaExiste(supabaseServico, linha.storage_path) : false;
    const decisao = decidirIdempotencia(linha, arquivoExiste);

    if (decisao.acao === "inconsistencia") {
      throw new ErroProvedorIA("validation", `INCONSISTENCIA (prompt ${prompt.ordem}): ${decisao.motivo}`.slice(0, 300));
    }
    if (decisao.acao === "reaproveitar") {
      imagens.push({
        imagemGeradaId: decisao.imagemGeradaId,
        ordem: prompt.ordem,
        principal: linha!.e_principal,
        finalidade: linha!.finalidade as TipoImagem,
        reaproveitada: true,
      });
      continue;
    }

    // ── CAPA: caminho determinístico, sem IA (2026-09-06) ───────────
    // A auditoria de 8 imagens geradas deu 0/8 em fidelidade — marca e
    // rótulo apagados, geometria alterada. Para a capa, que é a imagem
    // de conformidade do anúncio, os pixels do produto passam a vir da
    // fotografia real. Secundárias seguem no caminho atual por enquanto,
    // o que permite validar a capa sem mexer em tudo de uma vez.
    if (prompt.tipo === "capa_principal") {
      const capa = await escolherEComporCapa(
        referenciasUtilizadas.map((r, i) => ({
          imagemOrigemId: r.imagemOrigemId,
          buffer: Buffer.from(referenciasBytes[i].buffer),
        }))
      );
      // NUNCA cai para o Gemini aqui. Sem foto apta, a etapa falha com
      // motivo legível — redesenhar o produto não é alternativa aceitável.
      if (!capa.ok) {
        throw new ErroProvedorIA("conteudo_rejeitado", `Capa (prompt ${prompt.ordem}): ${capa.motivo}`.slice(0, 300));
      }
      const p = capa.capa.proveniencia;
      const imagemId = crypto.randomUUID();
      const caminho = montarCaminhoImagemGerada(userId, ctx.projetoId, ctx.jobId, imagemId, "image/png");
      validarCaminhoSeguro(caminho, userId, ctx.projetoId, ctx.jobId);
      await uploadImagemGerada(supabaseServico, caminho, capa.capa.png, "image/png");

      const { error: erroCapa } = await supabaseServico.from("estudio_anuncios_imagens_geradas").insert({
        id: imagemId,
        projeto_id: ctx.projetoId,
        job_id: ctx.jobId,
        prompt_ordem: prompt.ordem,
        finalidade: prompt.tipo,
        numero_versao: versaoPorOrdem.get(prompt.ordem)!,
        status: "pronta",
        e_principal: prompt.principal,
        storage_path: caminho,
        prompt_utilizado: prompt.promptTexto,
        mime_type: "image/png",
        largura_px: capa.capa.largura,
        altura_px: capa.capa.altura,
        tamanho_bytes: capa.capa.png.length,
        // `internal` já é valor aceito pelo CHECK — é o provedor correto
        // para um caminho que não chama ninguém de fora.
        provedor: "internal",
        modelo: `${p.metodo}@${p.versaoMetodo}`,
        origem_foto_id: p.origemFotoId,
        metodo: p.metodo,
        versao_metodo: p.versaoMetodo,
        houve_ia: false,
        houve_composicao: true,
        checksum_original: p.checksumOriginal,
        checksum_recorte: p.checksumRecorte,
        checksum_final: p.checksumFinal,
        escala_aplicada: p.escala,
      });
      if (erroCapa) {
        await excluirImagemGerada(supabaseServico, caminho);
        throw new ErroProvedorIA("validation", `Falha ao registrar a capa: ${erroCapa.message}`.slice(0, 300));
      }

      imagens.push({
        imagemGeradaId: imagemId,
        ordem: prompt.ordem,
        principal: prompt.principal,
        finalidade: prompt.tipo,
        reaproveitada: false,
      });
      // Sem tokens e sem custo: a capa não passou por provedor de IA.
      continue;
    }

    // ── Geração real ────────────────────────────────────────────────
    const chamada = await gerarImagemGoogle({
      promptTexto: prompt.promptTexto,
      negativePrompt: prompt.negativePrompt,
      referencias: referenciasBytes,
      aspectRatio: origem.aspectRatio,
      modelo,
    });
    tokensEntrada += chamada.tokensEntrada;
    tokensSaida += chamada.tokensSaida;
    tokensSaidaImagem += chamada.tokensSaidaImagem;
    tempoMs += chamada.tempoMs;
    geradasAgora++;

    const mimeReal = (await detectarMimeReal(chamada.bytes)) as MimeImagemGerada | null;
    const { mime, dimensoes } = validarImagemRecebida({
      bytes: chamada.bytes,
      mimeReal,
      dimensoes: obterDimensoes(chamada.bytes),
      aspectRatioEsperado: origem.aspectRatio,
      ordem: prompt.ordem,
    });

    // UUID gerado pelo servidor — nunca nome vindo do modelo. O caminho
    // é prefixado por user/projeto/job, então não cruza usuário, não
    // cruza projeto e não sobrescreve outro job.
    const imagemId = crypto.randomUUID();
    const caminho = montarCaminhoImagemGerada(userId, ctx.projetoId, ctx.jobId, imagemId, mime);
    validarCaminhoSeguro(caminho, userId, ctx.projetoId, ctx.jobId);

    // Upload primeiro (upsert:false — nunca sobrescreve em silêncio),
    // INSERT depois; se o INSERT falhar, o objeto é removido como ação
    // compensatória para não deixar arquivo órfão.
    await uploadImagemGerada(supabaseServico, caminho, chamada.bytes, mime);

    const { data: inserida, error: erroInsert } = await supabaseServico
      .from("estudio_anuncios_imagens_geradas")
      .insert({
        id: imagemId,
        projeto_id: ctx.projetoId,
        job_id: ctx.jobId,
        prompt_ordem: prompt.ordem,
        finalidade: prompt.tipo,
        numero_versao: versaoPorOrdem.get(prompt.ordem) ?? 1,
        storage_path: caminho,
        prompt_utilizado: prompt.promptTexto,
        status: "pronta",
        e_principal: prompt.principal,
        mime_type: mime,
        largura_px: dimensoes.largura,
        altura_px: dimensoes.altura,
        tamanho_bytes: chamada.bytes.length,
        provedor: "google",
        modelo: chamada.modelo,
      })
      .select("id")
      .single();

    if (erroInsert || !inserida) {
      const limpeza = await excluirImagemGerada(supabaseServico, caminho);
      throw new ErroProvedorIA(
        "validation",
        `Falha ao registrar imagem ${prompt.ordem} no banco: ${erroInsert?.message ?? "sem dados"}${limpeza.ok ? " (objeto removido do Storage)" : " (ATENÇÃO: objeto ficou órfão no Storage)"}`.slice(0, 300)
      );
    }

    imagens.push({
      imagemGeradaId: inserida.id as string,
      ordem: prompt.ordem,
      principal: prompt.principal,
      finalidade: prompt.tipo,
      reaproveitada: false,
    });
  }

  if (imagens.length !== configuracao.quantidadePrevista) {
    throw new ErroProvedorIA(
      "validation",
      `Quantidade final divergente: ${imagens.length} imagem(ns) para ${configuracao.quantidadePrevista} previstas.`
    );
  }
  if (imagens.filter(i => i.principal).length !== 1) {
    throw new ErroProvedorIA("validation", `Resultado com ${imagens.filter(i => i.principal).length} imagens principais, esperado 1.`);
  }

  const fontePromptsImagem: FontePromptsImagem = {
    jobId: origem.jobOrigemId,
    resultadoId: origem.resultadoId,
    schemaVersao: origem.schemaVersao,
  };

  return {
    envelope: { fontePromptsImagem, configuracao, imagens },
    modelo,
    tokensEntrada,
    tokensSaida,
    tokensSaidaImagem,
    tempoMs,
    imagensGeradasAgora: geradasAgora,
  };
}

/** Resumo curto e seguro — nunca bytes, nunca caminho de Storage, nunca URL. */
export function montarResumoCurtoImagem(envelope: EnvelopeGeracaoImagem): string {
  const partes = envelope.imagens.map(i => `${i.ordem}:${i.finalidade}${i.principal ? "*" : ""}${i.reaproveitada ? "(reuso)" : ""}`);
  return `${envelope.imagens.length} imagem(ns) — ${partes.join(" | ")}`.slice(0, 500);
}

export { SCHEMA_VERSAO_GERACAO_IMAGEM };
