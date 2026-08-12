/**
 * Handler específico de `calculo_score` — última etapa da Fase 1 e a
 * primeira do módulo **sem provedor externo**.
 *
 * Três coisas o distinguem dos seis handlers anteriores:
 *
 * 1. `provedoresPermitidos = ["internal"]` — não há "fake" na lista.
 *    Não é esquecimento: `decidirProvedor("calculo_score")` devolve
 *    sempre "internal", sem feature flag, porque não existe chamada paga
 *    a controlar. Um caminho fake aqui seria um caminho que finge não
 *    calcular o que o servidor calcula de graça.
 *
 * 2. `consomeIAExterna: false` — faz o executor pular
 *    `registrarPrompt()`/`registrarConsumo()`. Sem isso, o job gravaria
 *    uma linha em `central_ia_prompts` e outra em `central_ia_consumo`
 *    com `modelo` NOT NULL, obrigando a inventar uma string de modelo e
 *    a registrar consumo de IA que nunca houve.
 *
 * 3. `modelo` = `VERSAO_REGRAS_SCORE`. A coluna
 *    `resultados_pipeline.modelo` é NOT NULL e precisa dizer o que
 *    produziu aquele número. Como não há modelo de IA, o valor honesto é
 *    a versão da REGRA — quem ler a linha reencontra exatamente os pesos
 *    e critérios usados.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RespostaIA } from "../../ai-gateway/tipos";
import { executarCalculoScoreInterno, montarResumoCurtoScore } from "../calculo-score";
import { SCHEMA_VERSAO_CALCULO_SCORE } from "../calculo-score-tipos";
import type { ContextoExecucaoJob } from "../executar-job";
import type { HandlerEtapa, ResultadoHandler } from "./registry";

async function executar(
  ctx: ContextoExecucaoJob,
  supabase: SupabaseClient,
  args: { provedor: string; promptTexto: string }
): Promise<ResultadoHandler> {
  if (args.provedor !== "internal") {
    // Inalcançável pelo roteamento atual, mas explícito em vez de
    // silencioso: nunca cair num caminho alternativo por engano.
    throw new Error(`calculo_score só executa com provedor "internal" (recebido: "${args.provedor}").`);
  }

  const execucao = await executarCalculoScoreInterno(supabase, ctx);

  const resposta: RespostaIA = {
    provedor: "internal",
    modelo: execucao.modelo,
    sucesso: true,
    conteudo: montarResumoCurtoScore(execucao.envelope),
    // Zeros literais e verdadeiros: nada foi consumido de nenhum provedor.
    custoEstimado: 0,
    custoReal: 0,
    tokensEntrada: 0,
    tokensSaida: 0,
    unidadesGeradas: 1,
    tempoMs: 0,
  };

  return {
    resposta,
    resultadoParaPipeline: execucao.envelope as unknown as Record<string, unknown>,
  };
}

export const handlerCalculoScore: HandlerEtapa = {
  etapa: "calculo_score",
  provedoresPermitidos: ["internal"],
  versaoSaida: SCHEMA_VERSAO_CALCULO_SCORE,
  // Consome o artefato de geracao_imagem — último artefato obrigatório
  // antes do score. As demais fontes são resolvidas deterministicamente a
  // partir dele, por referência embutida nos envelopes.
  dependencia: "job_origem_id",
  versoesEntradaAceitas: [1],
  geraResultadoEstruturado: true,
  consomeIAExterna: false,
  executar,
};
