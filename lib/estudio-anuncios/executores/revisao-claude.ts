/**
 * Handler específico de `revisao_claude` — primeira etapa do módulo com
 * provedor Anthropic real. Mesmo padrão dos handlers anteriores:
 * `provedoresPermitidos = ["fake", "anthropic"]`, porque
 * decidirProvedor("revisao_claude") só devolve "anthropic" quando
 * ANTHROPIC_REVISAO_ENABLED="true" — caso contrário devolve "fake" e o
 * job continua funcionando pelo caminho fake genérico, sem regressão.
 *
 * Note o contraste com os outros três handlers: aqui a lista é
 * ["fake", "anthropic"], não ["fake", "google"]. É o `provedoresPermitidos`
 * cumprindo exatamente o papel para o qual foi criado — se o roteamento
 * devolvesse "google" para esta etapa por erro de configuração, o
 * executor barraria como `validation` ANTES de qualquer chamada paga.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RespostaIA } from "../../ai-gateway/tipos";
import { estimarCustoUsd } from "../../ai-gateway/custos";
import { executarRevisaoClaudeAnthropic, montarResumoCurtoRevisao } from "../revisao-claude";
import { SCHEMA_VERSAO_REVISAO_CLAUDE } from "../revisao-claude-tipos";
import type { ContextoExecucaoJob } from "../executar-job";
import type { HandlerEtapa, ResultadoHandler } from "./registry";
import { executarViaChamarIAFake } from "./fake-generico";

async function executar(
  ctx: ContextoExecucaoJob,
  supabase: SupabaseClient,
  args: { provedor: "fake" | "anthropic" | string; promptTexto: string }
): Promise<ResultadoHandler> {
  if (args.provedor !== "anthropic") {
    // Flag desligada — caminho fake genérico, sem resultado estruturado.
    return executarViaChamarIAFake(ctx, args.promptTexto);
  }

  const execucao = await executarRevisaoClaudeAnthropic(supabase, ctx);

  const resposta: RespostaIA = {
    provedor: "anthropic",
    modelo: execucao.modelo,
    sucesso: true,
    conteudo: montarResumoCurtoRevisao(execucao.envelope),
    custoEstimado: estimarCustoUsd(execucao.modelo, execucao.tokensEntrada, execucao.tokensSaida),
    custoReal: 0,
    tokensEntrada: execucao.tokensEntrada,
    tokensSaida: execucao.tokensSaida,
    unidadesGeradas: execucao.envelope.saida.textos.length,
    tempoMs: execucao.tempoMs,
  };

  return {
    resposta,
    resultadoParaPipeline: execucao.envelope as unknown as Record<string, unknown>,
  };
}

export const handlerRevisaoClaude: HandlerEtapa = {
  etapa: "revisao_claude",
  provedoresPermitidos: ["fake", "anthropic"],
  versaoSaida: SCHEMA_VERSAO_REVISAO_CLAUDE,
  dependencia: "job_origem_id",
  versoesEntradaAceitas: [1],
  geraResultadoEstruturado: true,
  executar,
};
