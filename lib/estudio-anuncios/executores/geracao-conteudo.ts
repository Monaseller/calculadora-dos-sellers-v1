/**
 * Handler específico de `geracao_conteudo` — última peça da
 * implementação real desta etapa. Mesmo padrão de
 * executores/analise-visual.ts: `provedoresPermitidos = ["fake",
 * "google"]`, porque decidirProvedor("geracao_conteudo") só devolve
 * "google" quando GOOGLE_AI_GERACAO_CONTEUDO_ENABLED="true" — caso
 * contrário devolve "fake", e o job precisa continuar funcionando pelo
 * caminho fake genérico (nenhuma regressão quando a flag está
 * desligada, que é o estado desta tarefa: false).
 *
 * A troca de geracao_conteudo de ETAPAS_FAKE_GENERICAS para
 * HANDLERS_ESPECIFICOS (registry.ts) é o ÚLTIMO passo atômico desta
 * tarefa — só acontece depois que este arquivo, o domínio
 * (geracao-conteudo-tipos.ts), o schema Google (google-conteudo-
 * schema.ts) e a orquestração (geracao-conteudo.ts) já existem e já
 * passaram por tsc limpo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RespostaIA } from "../../ai-gateway/tipos";
import { estimarCustoUsd } from "../../ai-gateway/provedores/google";
import {
  executarGeracaoConteudoGoogle,
  montarResumoCurtoGeracaoConteudo,
} from "../geracao-conteudo";
import { SCHEMA_VERSAO_GERACAO_CONTEUDO } from "../geracao-conteudo-tipos";
import type { ContextoExecucaoJob } from "../executar-job";
import type { HandlerEtapa, ResultadoHandler } from "./registry";
import { executarViaChamarIAFake } from "./fake-generico";

async function executar(
  ctx: ContextoExecucaoJob,
  supabase: SupabaseClient,
  args: { provedor: "fake" | "google" | string; promptTexto: string }
): Promise<ResultadoHandler> {
  if (args.provedor !== "google") {
    // GOOGLE_AI_GERACAO_CONTEUDO_ENABLED != "true" — mesmo caminho fake
    // genérico que as outras etapas usam. Nenhum resultado estruturado
    // é produzido neste caminho (resultadoParaPipeline fica null).
    return executarViaChamarIAFake(ctx, args.promptTexto);
  }

  // executarGeracaoConteudoGoogle() lança ErroProvedorIA classificado
  // (validation nas 7 pré-condições de job_origem_id e no caso de
  // input insuficiente; conteudo_rejeitado na violação de integridade
  // de fatoIds; auth/rate_limit/transient/unknown do próprio Gemini)
  // — propagado sem captura aqui, mesmo padrão do handler de
  // analise_visual.
  const execucao = await executarGeracaoConteudoGoogle(supabase, ctx);

  const resposta: RespostaIA = {
    provedor: "google",
    modelo: execucao.modelo,
    sucesso: true,
    // resultado_resumo NUNCA recebe o envelope completo — só um resumo
    // curto e seguro (mesmo padrão de analise_visual). O envelope
    // completo vai para estudio_anuncios_resultados_pipeline.
    conteudo: montarResumoCurtoGeracaoConteudo(execucao.envelope),
    custoEstimado: estimarCustoUsd(execucao.modelo, execucao.tokensEntrada, execucao.tokensSaida),
    custoReal: 0,
    tokensEntrada: execucao.tokensEntrada,
    tokensSaida: execucao.tokensSaida,
    unidadesGeradas: 1,
    tempoMs: execucao.tempoMs,
  };

  return {
    resposta,
    resultadoParaPipeline: execucao.envelope as unknown as Record<string, unknown>,
  };
}

export const handlerGeracaoConteudo: HandlerEtapa = {
  etapa: "geracao_conteudo",
  provedoresPermitidos: ["fake", "google"],
  versaoSaida: SCHEMA_VERSAO_GERACAO_CONTEUDO,
  // Único handler até aqui que declara uma dependência real — exigido
  // e validado dentro de executarGeracaoConteudoGoogle() (7
  // pré-condições de job_origem_id), não pelo registry em si (o
  // registry não interpreta este campo nesta tarefa — é metadado
  // declarativo para leitura futura/documentação, ver HandlerEtapa em
  // registry.ts).
  dependencia: "job_origem_id",
  geraResultadoEstruturado: true,
  executar,
};
