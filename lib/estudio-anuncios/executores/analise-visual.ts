/**
 * Handler específico de `analise_visual`. Extração mecânica do bloco
 * hoje inline em executar-job.ts (branch `if (usaGoogleAnaliseVisual)`
 * + o branch `else` equivalente para o caso analise_visual+fake) —
 * mesmo comportamento observável, só movido de arquivo e reorganizado
 * atrás da interface HandlerEtapa.
 *
 * `provedoresPermitidos = ["fake", "google"]` (não só "google"): hoje,
 * decidirProvedor("analise_visual") só devolve "google" quando
 * GOOGLE_AI_ENABLED="true" — caso contrário devolve "fake", e o job
 * precisa continuar funcionando pelo caminho fake genérico exatamente
 * como antes desta extração (nenhuma regressão quando o Google está
 * desabilitado). Ver ESTUDIO_ANUNCIOS_IA_GERACAO_CONTEUDO_PREPARACAO_
 * IMPLEMENTACAO.md, seção 2.3.1, para a decisão original.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RespostaIA } from "../../ai-gateway/tipos";
import { ErroProvedorIA, estimarCustoUsd } from "../../ai-gateway/provedores/google";
import {
  executarAnaliseVisualGoogle,
  SCHEMA_VERSAO_ANALISE_VISUAL,
  montarResumoCurtoAnaliseVisual,
} from "../analise-visual";
import type { ContextoExecucaoJob } from "../executar-job";
import type { HandlerEtapa, ResultadoHandler } from "./registry";
import { executarViaChamarIAFake } from "./fake-generico";

async function executar(
  ctx: ContextoExecucaoJob,
  supabase: SupabaseClient,
  args: { provedor: "fake" | "google" | string; promptTexto: string }
): Promise<ResultadoHandler> {
  if (args.provedor !== "google") {
    // Google desabilitado (GOOGLE_AI_ENABLED != "true") — mesmo caminho
    // fake genérico que as outras 6 etapas usam, exatamente como o
    // branch `else` de hoje fazia para analise_visual+fake. Nenhum
    // resultado estruturado é produzido neste caminho (resultadoParaPipeline
    // fica null) — geraResultadoEstruturado=true no handler é uma
    // declaração de capacidade, não uma garantia por chamada.
    return executarViaChamarIAFake(ctx, args.promptTexto);
  }

  // executarAnaliseVisualGoogle() lança ErroProvedorIA classificado
  // (auth/rate_limit/transient/unknown) em caso de falha — propagado
  // sem captura aqui de propósito: o catch centralizado em
  // executar-job.ts já sabe distinguir ErroProvedorIA de erro genérico,
  // exatamente como o try/catch que existia neste bloco antes da
  // extração.
  const execucao = await executarAnaliseVisualGoogle(supabase, ctx.projetoId);
  const resultadoParaPipeline = execucao.resultadoCompleto as unknown as Record<string, unknown>;

  const resposta: RespostaIA = {
    provedor: "google",
    modelo: execucao.modelo,
    sucesso: true,
    // resultado_resumo NUNCA recebe o JSON completo — só um resumo
    // curto e seguro (decisão de persistência já aprovada). O JSON
    // completo vai para estudio_anuncios_resultados_pipeline.
    conteudo: montarResumoCurtoAnaliseVisual(execucao.resultadoCompleto),
    // custoEstimado: tabela de preços estática (estimarCustoUsd) — a
    // API do Gemini não devolve custo em dinheiro, só tokens.
    custoEstimado: estimarCustoUsd(execucao.modelo, execucao.tokensEntrada, execucao.tokensSaida),
    // custoReal fica 0 de propósito: não existe fonte de "custo real"
    // vinda da própria API para esta chamada — nunca inventamos esse
    // número.
    custoReal: 0,
    tokensEntrada: execucao.tokensEntrada,
    tokensSaida: execucao.tokensSaida,
    unidadesGeradas: 1,
    tempoMs: execucao.tempoMs,
  };

  return { resposta, resultadoParaPipeline };
}

export const handlerAnaliseVisual: HandlerEtapa = {
  etapa: "analise_visual",
  provedoresPermitidos: ["fake", "google"],
  versaoSaida: SCHEMA_VERSAO_ANALISE_VISUAL,
  dependencia: null,
  geraResultadoEstruturado: true,
  executar,
};
