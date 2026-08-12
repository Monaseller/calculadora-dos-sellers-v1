/**
 * Handler específico de `geracao_prompts_imagem`. Mesmo padrão dos
 * handlers anteriores: `provedoresPermitidos = ["fake", "google"]`,
 * porque decidirProvedor("geracao_prompts_imagem") só devolve "google"
 * quando GOOGLE_AI_PROMPTS_IMAGEM_ENABLED="true" — caso contrário
 * devolve "fake", e o job precisa continuar funcionando pelo caminho
 * fake genérico, sem regressão.
 *
 * A troca de geracao_prompts_imagem de ETAPAS_FAKE_GENERICAS para
 * HANDLERS_ESPECIFICOS (registry.ts) é o ÚLTIMO passo atômico da tarefa
 * — só depois de domínio, schema, orquestração, validações e testes
 * prontos, com tsc limpo.
 *
 * Esta etapa NÃO gera imagem: ela planeja os prompts. Nenhuma chamada a
 * modelo de imagem, nenhuma escrita em
 * `estudio_anuncios_imagens_geradas`, nenhum acesso a Storage.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RespostaIA } from "../../ai-gateway/tipos";
import { estimarCustoUsd } from "../../ai-gateway/custos";
import { executarGeracaoPromptsImagemGoogle, montarResumoCurtoPromptsImagem } from "../geracao-prompts-imagem";
import { SCHEMA_VERSAO_GERACAO_PROMPTS_IMAGEM } from "../geracao-prompts-imagem-tipos";
import type { ContextoExecucaoJob } from "../executar-job";
import type { HandlerEtapa, ResultadoHandler } from "./registry";
import { executarViaChamarIAFake } from "./fake-generico";

async function executar(
  ctx: ContextoExecucaoJob,
  supabase: SupabaseClient,
  args: { provedor: "fake" | "google" | string; promptTexto: string }
): Promise<ResultadoHandler> {
  if (args.provedor !== "google") {
    // Flag desligada — mesmo caminho fake genérico das demais etapas,
    // sem resultado estruturado.
    return executarViaChamarIAFake(ctx, args.promptTexto);
  }

  const execucao = await executarGeracaoPromptsImagemGoogle(supabase, ctx);

  const resposta: RespostaIA = {
    provedor: "google",
    modelo: execucao.modelo,
    sucesso: true,
    conteudo: montarResumoCurtoPromptsImagem(execucao.envelope),
    custoEstimado: estimarCustoUsd(execucao.modelo, execucao.tokensEntrada, execucao.tokensSaida),
    custoReal: 0,
    tokensEntrada: execucao.tokensEntrada,
    tokensSaida: execucao.tokensSaida,
    unidadesGeradas: execucao.envelope.prompts.length,
    tempoMs: execucao.tempoMs,
  };

  return {
    resposta,
    resultadoParaPipeline: execucao.envelope as unknown as Record<string, unknown>,
  };
}

export const handlerGeracaoPromptsImagem: HandlerEtapa = {
  etapa: "geracao_prompts_imagem",
  provedoresPermitidos: ["fake", "google"],
  versaoSaida: SCHEMA_VERSAO_GERACAO_PROMPTS_IMAGEM,
  // Consome o artefato de analise_visual — a verdade visual, não o
  // conteúdo comercial. Ver o cabeçalho de
  // geracao-prompts-imagem-tipos.ts para o porquê. Exigido e validado
  // dentro de executarGeracaoPromptsImagemGoogle(), não pelo registry.
  dependencia: "job_origem_id",
  versoesEntradaAceitas: [1],
  geraResultadoEstruturado: true,
  executar,
};
