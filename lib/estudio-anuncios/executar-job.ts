/**
 * Executor de jobs do Estúdio de Anúncios — única peça que sabe mapear
 * uma etapa (estudio_anuncios_jobs.etapa) para uma execução real. Hoje
 * duas etapas podem usar provedor real (analise_visual e
 * geracao_conteudo, cada uma atrás da própria feature flag); as outras
 * 6 sempre passam pelo AI Gateway fake.
 * Criado na tarefa de integração funcional (2026-08-06).
 *
 * Responsabilidade estrita, por pedido explícito:
 *   - executa a tarefa atual (Gateway) e registra prompt/consumo;
 *   - devolve um resultado tipado (sucesso/erro classificado);
 *   - NÃO decide o próximo job;
 *   - NÃO altera status do Pipeline;
 *   - NÃO acessa Request/cookies/segredo — só recebe dados já
 *     validados pela rota interna.
 * Quem chama as RPCs atômicas (estudio_anuncios_pipeline_concluir_job/
 * _falhar_job) é a ROTA, não este módulo — reafirma a "regra central"
 * da tarefa: a progressão do fluxo é exclusiva das RPCs.
 *
 * AJUSTE (2026-08-11 — Executor registry): a decisão "qual código
 * executa esta etapa" deixou de ser um if/else único
 * (`usaGoogleAnaliseVisual`) e passou a ser resolvida por
 * `resolverHandler()` (lib/estudio-anuncios/executores/registry.ts).
 * Nenhuma etapa perde comportamento nesta mudança — é extração
 * mecânica, não redesenho: analise_visual (os dois caminhos,
 * fake e google) e as demais etapas fake continuam fazendo
 * exatamente o que faziam antes, só reorganizadas atrás da interface
 * HandlerEtapa. (Na época desta extração eram 7 etapas fake;
 * geracao_conteudo saiu do conjunto ao ganhar handler próprio.) Ver ESTUDIO_ANUNCIOS_IA_GERACAO_CONTEUDO_PREPARACAO_
 * IMPLEMENTACAO.md, seção 2, para o desenho completo.
 *
 * Nova checagem, sem equivalente antes desta mudança:
 * `provedoresPermitidos` — depois que decidirProvedor(etapa) resolve o
 * provedor efetivo e ANTES de chamar handler.executar(), confere se o
 * provedor resolvido está na lista que o handler declara suportar. Não
 * é só documentação — mismatch retorna erro `validation` sem nenhuma
 * chamada de IA acontecer.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { decidirTipoPrompt, decidirProvedor } from "../ai-gateway/roteamento";
import { registrarPrompt, registrarConsumo, registrarResultadoPipeline, ErroIdempotenciaResultadoPipeline } from "../ai-gateway/registro";
import type { ErroIA, ProvedorIA, RespostaIA } from "../ai-gateway/tipos";
import { ErroProvedorIA } from "../ai-gateway/provedores/google";
import { resolverHandler } from "./executores/registry";

/**
 * Etapas com execução suportada nesta fase — única fonte de verdade
 * para essa decisão (a rota importa este mesmo Set para a precondição
 * "etapa deve estar suportada"; o Gateway em si não decide isso).
 * Etapas de vídeo/exportação/busca externa/pós-pendência ficam de fora
 * de propósito (fora de escopo desta tarefa).
 */
export const ETAPAS_SUPORTADAS_FASE1: ReadonlySet<string> = new Set([
  "ping",
  "analise_visual",
  "geracao_conteudo",
  "revisao_claude",
  "adaptacao_marketplace",
  "geracao_prompts_imagem",
  "geracao_imagem",
  "calculo_score",
]);

const PROMPT_TEXTO_POR_ETAPA: Record<string, string> = {
  ping: "ping de teste de infraestrutura",
  analise_visual: "Analisar visualmente o produto do projeto e extrair atributos estruturais.",
  geracao_conteudo: "Gerar título e descrição-base do anúncio a partir da ficha do produto.",
  revisao_claude: "Revisar o conteúdo-base gerado quanto a clareza, consistência e adequação.",
  adaptacao_marketplace: "Adaptar o conteúdo-base ao formato e às regras do marketplace de destino.",
  geracao_prompts_imagem: "Gerar prompt visual determinístico para a geração de imagem do produto.",
  geracao_imagem: "Gerar imagem do produto a partir do prompt visual (referência fake, sem arquivo real).",
  calculo_score: "Calcular a avaliação estrutural do anúncio (SEO, título, descrição, imagens).",
};

export interface ContextoExecucaoJob {
  jobId: string;
  projetoId: string;
  etapa: string;
}

export interface ResultadoExecucaoJob {
  sucesso: boolean;
  conteudo?: string;
  provedor?: ProvedorIA;
  modelo?: string;
  tempoMs?: number;
  erro?: ErroIA;
  promptId?: string;
  consumoId?: string;
  /** Só preenchido quando esta execução persistiu um resultado estruturado em estudio_anuncios_resultados_pipeline (hoje: google+analise_visual e google+geracao_conteudo). */
  resultadoPipelineId?: string;
}

/**
 * Executa a etapa atual do job. Nunca lança — todo erro (etapa não
 * suportada, falha do Gateway, falha ao registrar prompt/consumo) vira
 * `{ sucesso: false, erro: {...} }` classificado, para a rota decidir
 * qual RPC atômica chamar sem precisar de try/catch ao redor desta
 * função para o caminho de erro esperado (só falhas realmente
 * inesperadas, fora deste módulo, devem propagar como exceção).
 */
export async function executarJobEstudioAnuncios(
  supabaseServico: SupabaseClient,
  contexto: ContextoExecucaoJob
): Promise<ResultadoExecucaoJob> {
  if (!ETAPAS_SUPORTADAS_FASE1.has(contexto.etapa)) {
    return {
      sucesso: false,
      erro: {
        tipo: "validation",
        mensagem: `Etapa "${contexto.etapa}" não é suportada nesta fase da integração.`.slice(0, 300),
      },
    };
  }

  let tipoPrompt;
  try {
    // Centralizado em lib/ai-gateway/roteamento.ts — nunca decidido
    // aqui nem na rota. Lança se a etapa não estiver no mapeamento
    // aprovado (não deveria acontecer, já que ETAPAS_SUPORTADAS_FASE1
    // e o mapeamento de decidirTipoPrompt() cobrem o mesmo conjunto de
    // 8 etapas — mas não silenciamos essa divergência se ela ocorrer).
    tipoPrompt = decidirTipoPrompt(contexto.etapa);
  } catch (err: any) {
    return {
      sucesso: false,
      erro: { tipo: "validation", mensagem: (err?.message ?? "tipo de prompt não mapeado").slice(0, 300) },
    };
  }

  const promptTexto = PROMPT_TEXTO_POR_ETAPA[contexto.etapa] ?? contexto.etapa;
  const provedor = decidirProvedor(contexto.etapa);

  const handler = resolverHandler(contexto.etapa);
  if (!handler) {
    // Não deveria acontecer — ETAPAS_SUPORTADAS_FASE1 e o registry
    // cobrem o mesmo conjunto de 8 etapas — mas não silenciamos essa
    // divergência se ela ocorrer (mesmo princípio já aplicado acima ao
    // catch de decidirTipoPrompt()).
    return {
      sucesso: false,
      erro: {
        tipo: "validation",
        mensagem: `Etapa "${contexto.etapa}" não tem handler registrado no executor registry.`.slice(0, 300),
      },
    };
  }

  if (!handler.provedoresPermitidos.includes(provedor)) {
    // Checagem nova (2026-08-11) — pega erro de configuração/roteamento
    // ANTES de qualquer chamada de IA, não depois. Mesma categoria de
    // erro já usada em outras falhas de pré-checagem determinística.
    return {
      sucesso: false,
      erro: {
        tipo: "validation",
        mensagem: `decidirProvedor("${contexto.etapa}") retornou "${provedor}", fora de handler.provedoresPermitidos (${handler.provedoresPermitidos.join(", ")}).`.slice(
          0,
          300
        ),
      },
    };
  }

  let resposta: RespostaIA;
  // Só preenchido quando o handler efetivamente gerou resultado
  // estruturado nesta chamada (hoje: analise_visual+google e
  // geracao_conteudo+google) — o objeto de domínio completo a
  // persistir em estudio_anuncios_resultados_pipeline.
  let resultadoParaPipeline: Record<string, unknown> | null = null;

  try {
    const resultado = await handler.executar(contexto, supabaseServico, { provedor, promptTexto });
    resposta = resultado.resposta;
    resultadoParaPipeline = resultado.resultadoParaPipeline ?? null;
  } catch (err: any) {
    if (err instanceof ErroProvedorIA) {
      return { sucesso: false, erro: { tipo: err.tipo, mensagem: err.message.slice(0, 300) } };
    }
    return {
      sucesso: false,
      erro: {
        tipo: "unknown",
        mensagem: (err?.message ?? `Falha ao executar a etapa "${contexto.etapa}" (provedor: ${provedor}).`).slice(0, 300),
      },
    };
  }

  if (resultadoParaPipeline && handler.versaoSaida === undefined) {
    // Guarda contra o acoplamento encontrado na auditoria (PARTE 1,
    // seção 2.2, item 2): um handler nunca deveria produzir resultado
    // estruturado sem declarar a própria versão de schema — evita
    // herdar silenciosamente uma constante importada de outro módulo.
    return {
      sucesso: false,
      erro: {
        tipo: "unknown",
        mensagem: `Handler da etapa "${contexto.etapa}" retornou resultadoParaPipeline sem declarar versaoSaida.`.slice(0, 300),
      },
    };
  }

  // registrarPrompt()/registrarConsumo() já são idempotentes por
  // job_id (verificam antes de inserir + tratam 23505) — chamar as
  // duas incondicionalmente aqui já cobre os 3 cenários de recuperação
  // parcial (prompt sem consumo, consumo sem prompt, os dois já
  // existentes) sem lógica extra: cada uma decide sozinha se precisa
  // inserir ou só devolver o que já existe.
  try {
    // CORREÇÃO ESTRUTURAL (2026-08-17, §37.2): até aqui os dois registros
    // eram incondicionais, porque toda etapa consumia um provedor de IA.
    // `calculo_score` é a primeira que não consome — cálculo
    // determinístico server-side, sem modelo e sem custo. Como
    // `central_ia_prompts.modelo` e `central_ia_consumo.modelo` são NOT
    // NULL, registrar assim mesmo exigiria inventar uma string de modelo
    // e gravar consumo inexistente, poluindo as tabelas que existem
    // justamente para auditar gasto real de IA. Handlers que declaram
    // `consomeIAExterna: false` pulam os dois. Default continua `true`,
    // então nenhuma das 6 etapas anteriores muda de comportamento.
    const consomeIA = handler.consomeIAExterna !== false;

    const prompt = consomeIA
      ? await registrarPrompt(supabaseServico, {
          projetoId: contexto.projetoId,
          jobId: contexto.jobId,
          tipo: tipoPrompt,
          promptTexto,
          resposta,
        })
      : null;

    const consumo = consomeIA
      ? await registrarConsumo(supabaseServico, {
          projetoId: contexto.projetoId,
          jobId: contexto.jobId,
          resposta,
        })
      : null;

    let resultadoPipelineId: string | undefined;
    if (resultadoParaPipeline) {
      // handler.versaoSaida, não uma constante importada solta — cada
      // handler declara a própria versão (checagem acima já garante que
      // está definida quando resultadoParaPipeline existe).
      const resultadoPipeline = await registrarResultadoPipeline(supabaseServico, {
        projetoId: contexto.projetoId,
        jobId: contexto.jobId,
        etapa: contexto.etapa,
        provedor: resposta.provedor,
        modelo: resposta.modelo,
        schemaVersao: handler.versaoSaida as number,
        resultado: resultadoParaPipeline,
      });
      resultadoPipelineId = resultadoPipeline.id;
    }

    return {
      sucesso: true,
      conteudo: resposta.conteudo,
      provedor: resposta.provedor,
      modelo: resposta.modelo,
      tempoMs: resposta.tempoMs,
      promptId: prompt?.id,
      consumoId: consumo?.id,
      resultadoPipelineId,
    };
  } catch (err: any) {
    if (err instanceof ErroIdempotenciaResultadoPipeline) {
      return { sucesso: false, erro: { tipo: "unknown", mensagem: err.message.slice(0, 300) } };
    }
    return {
      sucesso: false,
      erro: { tipo: "unknown", mensagem: (err?.message ?? "falha ao registrar prompt/consumo/resultado").slice(0, 300) },
    };
  }
}
