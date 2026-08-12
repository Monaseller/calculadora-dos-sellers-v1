/**
 * Registry de handlers de execução por etapa — única peça que decide
 * COMO uma etapa (estudio_anuncios_jobs.etapa) é executada. Extraído de
 * lib/estudio-anuncios/executar-job.ts (2026-08-11), que até esta
 * extração tinha essa decisão espalhada num único if/else
 * (`usaGoogleAnaliseVisual`) — ver ESTUDIO_ANUNCIOS_IA_GERACAO_CONTEUDO_
 * PREPARACAO_IMPLEMENTACAO.md, seção 2, para o desenho completo e o
 * histórico de revisão (Bloqueio 1: a 1ª versão deste registry só
 * cobria 2 etapas e quebraria as outras 6 hoje suportadas via Gateway
 * fake — corrigido no desenho abaixo).
 *
 * Duas estruturas deliberadamente separadas, nunca uma só:
 *   - HANDLERS_ESPECIFICOS: etapas com comportamento próprio — hoje
 *     analise_visual, geracao_conteudo (2026-08-11),
 *     adaptacao_marketplace (2026-08-13) e revisao_claude (2026-08-14).
 *   - ETAPAS_FAKE_GENERICAS: etapas que compartilham o mesmo caminho
 *     fake genérico (handlerFakeGenerico) — 4 etapas hoje, mesmo
 *     comportamento observável de antes desta extração, só
 *     reorganizado.
 *
 * Regra de sequenciamento para geracao_conteudo (seção 2.4 do
 * documento acima): ela permanece em ETAPAS_FAKE_GENERICAS durante
 * toda a construção da implementação real (tipos + entrada segura +
 * adaptador + validações). Só é movida para HANDLERS_ESPECIFICOS como
 * ÚLTIMA etapa da tarefa, depois de tudo testado — nunca como andaime
 * intermediário. Se esta tarefa for interrompida antes desse ponto, o
 * registry fica neste estado consistente: geracao_conteudo continua em
 * ETAPAS_FAKE_GENERICAS, sem nenhum handler fake/no-op nomeado
 * especificamente para ela.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProvedorIA, RespostaIA } from "../../ai-gateway/tipos";
import type { ContextoExecucaoJob } from "../executar-job";

export interface ResultadoHandler {
  resposta: RespostaIA;
  /**
   * Só relevante quando o handler efetivamente gerou um resultado
   * estruturado nesta chamada — null/undefined quando não (inclusive
   * quando handler.geraResultadoEstruturado=true mas esta chamada em
   * particular caiu num caminho que não produz resultado estruturado,
   * ex.: analise_visual com provedor=fake). geraResultadoEstruturado é
   * uma declaração de capacidade do handler, não uma garantia por
   * chamada.
   */
  resultadoParaPipeline?: Record<string, unknown> | null;
}

/**
 * Contrato de um handler de etapa. `executar()` recebe `provedor` e
 * `promptTexto` já resolvidos pelo executor (decidirProvedor() e
 * PROMPT_TEXTO_POR_ETAPA continuam centralizados em executar-job.ts,
 * fonte única, chamados 1x por execução) — decisão deliberada,
 * diferente do esboço original do documento PARTE 1 (que não passava
 * esses valores para executar()): evita duplicar PROMPT_TEXTO_POR_ETAPA
 * em cada arquivo de handler (risco real de divergência entre o texto
 * enviado ao Gateway fake e o texto registrado em
 * central_ia_prompts.prompt_texto) e evita cada handler ter que chamar
 * decidirProvedor() de novo por conta própria.
 */
export interface HandlerEtapa {
  etapa: string;
  provedoresPermitidos: ProvedorIA[];
  versoesEntradaAceitas?: number[];
  /**
   * Versão do schema de saída que este handler grava em
   * estudio_anuncios_resultados_pipeline.schema_versao, quando
   * geraResultadoEstruturado=true. Corrige acoplamento encontrado na
   * auditoria (PARTE 1, seção 2.2, item 2): antes, SCHEMA_VERSAO_
   * ANALISE_VISUAL era importada e usada incondicionalmente dentro do
   * trecho "genérico" de registro, sem vir do handler que de fato
   * rodou — risco real de um handler futuro (ex. geracao_conteudo)
   * herdar a versão errada por engano, já que ambos começam em 1.
   */
  versaoSaida?: number;
  dependencia?: "job_origem_id" | null;
  geraResultadoEstruturado: boolean;
  /**
   * Se esta etapa consome um provedor de IA EXTERNO. Default `true` —
   * as 6 etapas anteriores todas consomem, e nenhuma precisou declarar
   * nada.
   *
   * CORREÇÃO ESTRUTURAL (2026-08-17, Constituição §37.2, aplicada ANTES
   * de implementar `calculo_score`): `executar-job.ts` chamava
   * `registrarPrompt()` e `registrarConsumo()` **incondicionalmente**,
   * partindo do princípio — até aqui verdadeiro — de que toda etapa fala
   * com um provedor. `calculo_score` é a primeira que não fala: é
   * cálculo determinístico server-side, sem modelo, sem custo, sem
   * chamada externa.
   *
   * O problema não é cosmético: `central_ia_prompts.modelo` e
   * `central_ia_consumo.modelo` são **NOT NULL** no banco. Registrar
   * essas duas linhas para uma etapa sem IA exigiria **inventar uma
   * string de modelo** e gravar consumo de algo que nunca foi consumido
   * — poluindo exatamente as tabelas que existem para auditar gasto real
   * de IA. Declarar `false` aqui faz o executor pular os dois registros.
   */
  consomeIAExterna?: boolean;
  timeoutMs?: number;
  executar: (
    ctx: ContextoExecucaoJob,
    supabase: SupabaseClient,
    args: { provedor: ProvedorIA; promptTexto: string }
  ) => Promise<ResultadoHandler>;
}

// Importados depois da declaração dos tipos acima — analise-visual.ts,
// geracao-conteudo.ts e fake-generico.ts importam HandlerEtapa/
// ResultadoHandler deste mesmo arquivo (import type, portanto sem
// ciclo de valor em runtime).
import { handlerAnaliseVisual } from "./analise-visual";
import { handlerGeracaoConteudo } from "./geracao-conteudo";
import { handlerAdaptacaoMarketplace } from "./adaptacao-marketplace";
import { handlerRevisaoClaude } from "./revisao-claude";
import { handlerGeracaoPromptsImagem } from "./geracao-prompts-imagem";
import { handlerGeracaoImagem } from "./geracao-imagem";
import { handlerCalculoScore } from "./calculo-score";
import { handlerFakeGenerico } from "./fake-generico";

/**
 * Handlers com comportamento próprio — 1 chave = 1 handler dedicado.
 *
 * `geracao_conteudo` entrou aqui como ÚLTIMA etapa da implementação
 * real (2026-08-11) — tipos de domínio, schema Google, entrada segura/
 * orquestração e o handler em si já existem e já passaram por tsc
 * limpo antes desta troca. Movida atomicamente com a remoção
 * correspondente de ETAPAS_FAKE_GENERICAS abaixo, na mesma edição —
 * nunca deixada em nenhum dos dois conjuntos, nunca nos dois ao mesmo
 * tempo (ver validação de boot logo abaixo).
 */
export const HANDLERS_ESPECIFICOS: Readonly<Record<string, HandlerEtapa>> = {
  analise_visual: handlerAnaliseVisual,
  geracao_conteudo: handlerGeracaoConteudo,
  // adaptacao_marketplace entrou aqui como ÚLTIMA etapa da sua
  // implementação real (2026-08-13) — domínio, schema Google,
  // orquestração, validações e testes já existiam e já passaram por tsc
  // limpo antes desta troca. Movida atomicamente com a remoção
  // correspondente de ETAPAS_FAKE_GENERICAS abaixo, na mesma edição.
  adaptacao_marketplace: handlerAdaptacaoMarketplace,
  // revisao_claude promovida em 2026-08-14 — primeira etapa com provedor
  // Anthropic. Movida atomicamente com a remocao correspondente de
  // ETAPAS_FAKE_GENERICAS abaixo, na mesma edicao.
  revisao_claude: handlerRevisaoClaude,
  // geracao_prompts_imagem promovida em 2026-08-15 — primeira etapa da
  // fase de imagens. Continua sendo geracao de TEXTO (planeja prompts,
  // nao gera imagem). Movida atomicamente com a remocao correspondente
  // de ETAPAS_FAKE_GENERICAS abaixo, na mesma edicao.
  geracao_prompts_imagem: handlerGeracaoPromptsImagem,
  // geracao_imagem promovida em 2026-08-16 — primeira etapa que produz
  // ARQUIVO real e a unica que escreve em Storage. Movida atomicamente
  // com a remocao correspondente de ETAPAS_FAKE_GENERICAS abaixo.
  geracao_imagem: handlerGeracaoImagem,
  // calculo_score promovida em 2026-08-17 — ULTIMA etapa da Fase 1 e a
  // unica sem provedor externo (internal, sem modelo, sem custo). Movida
  // atomicamente com a remocao correspondente de ETAPAS_FAKE_GENERICAS.
  calculo_score: handlerCalculoScore,
};

/**
 * Etapas que ainda passam pelo caminho fake genérico, sem handler
 * dedicado — mesmo comportamento observável de antes desta extração,
 * só reorganizado.
 */
export const ETAPAS_FAKE_GENERICAS: ReadonlySet<string> = new Set([
  "ping",
]);

// Validação de boot — roda 1x na carga do módulo (import-time), nunca
// por requisição. Pega inconsistência de configuração do registry antes
// de qualquer job ser processado, não depois de um erro obscuro em
// produção.
for (const etapa of Object.keys(HANDLERS_ESPECIFICOS)) {
  if (ETAPAS_FAKE_GENERICAS.has(etapa)) {
    throw new Error(
      `Registry inconsistente: etapa "${etapa}" registrada como handler específico E genérico simultaneamente.`
    );
  }
  if (HANDLERS_ESPECIFICOS[etapa].etapa !== etapa) {
    throw new Error(
      `Registry inconsistente: handler na chave "${etapa}" declara etapa "${HANDLERS_ESPECIFICOS[etapa].etapa}".`
    );
  }
}

/**
 * Resolve o handler de uma etapa. Retorna undefined para etapa sem
 * handler — o chamador (executar-job.ts) trata isso como erro
 * `validation`, sem fallback silencioso.
 */
export function resolverHandler(etapa: string): HandlerEtapa | undefined {
  if (etapa in HANDLERS_ESPECIFICOS) return HANDLERS_ESPECIFICOS[etapa];
  if (ETAPAS_FAKE_GENERICAS.has(etapa)) return handlerFakeGenerico;
  return undefined;
}
