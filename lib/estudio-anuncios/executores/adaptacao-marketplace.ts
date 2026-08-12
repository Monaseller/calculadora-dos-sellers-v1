/**
 * Handler específico de `adaptacao_marketplace`. Mesmo padrão de
 * executores/geracao-conteudo.ts: `provedoresPermitidos = ["fake",
 * "google"]`, porque decidirProvedor("adaptacao_marketplace") só
 * devolve "google" quando GOOGLE_AI_ADAPTACAO_MARKETPLACE_ENABLED
 * ="true" — caso contrário devolve "fake", e o job precisa continuar
 * funcionando pelo caminho fake genérico, sem regressão.
 *
 * A troca de adaptacao_marketplace de ETAPAS_FAKE_GENERICAS para
 * HANDLERS_ESPECIFICOS (registry.ts) é o ÚLTIMO passo atômico da tarefa
 * — só depois de domínio, schema, orquestração, validações e testes
 * prontos, com tsc limpo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RespostaIA } from "../../ai-gateway/tipos";
import { estimarCustoUsd } from "../../ai-gateway/provedores/google";
import { executarAdaptacaoMarketplaceGoogle, montarResumoCurtoAdaptacao } from "../adaptacao-marketplace";
import { SCHEMA_VERSAO_ADAPTACAO_MARKETPLACE } from "../adaptacao-marketplace-tipos";
import type { ContextoExecucaoJob } from "../executar-job";
import type { HandlerEtapa, ResultadoHandler } from "./registry";
import { executarViaChamarIAFake } from "./fake-generico";

async function executar(
  ctx: ContextoExecucaoJob,
  supabase: SupabaseClient,
  args: { provedor: "fake" | "google" | string; promptTexto: string }
): Promise<ResultadoHandler> {
  if (args.provedor !== "google") {
    // Flag desligada — mesmo caminho fake genérico das demais etapas.
    // Nenhum resultado estruturado é produzido (resultadoParaPipeline
    // fica null), exatamente como antes desta implementação.
    return executarViaChamarIAFake(ctx, args.promptTexto);
  }

  // executarAdaptacaoMarketplaceGoogle() lança ErroProvedorIA
  // classificado (validation nas pré-condições de origem e na validação
  // estrutural; conteudo_rejeitado na violação de integridade;
  // auth/rate_limit/transient/unknown do próprio Gemini) — propagado sem
  // captura, mesmo padrão dos handlers de analise_visual e
  // geracao_conteudo.
  const execucao = await executarAdaptacaoMarketplaceGoogle(supabase, ctx);

  const resposta: RespostaIA = {
    provedor: "google",
    modelo: execucao.modelo,
    sucesso: true,
    conteudo: montarResumoCurtoAdaptacao(execucao.envelope),
    custoEstimado: estimarCustoUsd(execucao.modelo, execucao.tokensEntrada, execucao.tokensSaida),
    custoReal: 0,
    tokensEntrada: execucao.tokensEntrada,
    tokensSaida: execucao.tokensSaida,
    unidadesGeradas: execucao.envelope.saida.adaptacoes.length,
    tempoMs: execucao.tempoMs,
  };

  return {
    resposta,
    resultadoParaPipeline: execucao.envelope as unknown as Record<string, unknown>,
  };
}

export const handlerAdaptacaoMarketplace: HandlerEtapa = {
  etapa: "adaptacao_marketplace",
  provedoresPermitidos: ["fake", "google"],
  versaoSaida: SCHEMA_VERSAO_ADAPTACAO_MARKETPLACE,
  // Consome o artefato de geracao_conteudo — semântica oficial de
  // job_origem_id (migration 20260813). Exigido e validado dentro de
  // executarAdaptacaoMarketplaceGoogle(), não pelo registry.
  dependencia: "job_origem_id",
  versoesEntradaAceitas: [1],
  geraResultadoEstruturado: true,
  executar,
};
