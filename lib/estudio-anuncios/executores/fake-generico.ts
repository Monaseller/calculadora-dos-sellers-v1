/**
 * Handler fake genérico — compartilhado por todas as etapas sem
 * comportamento próprio ainda (hoje: ping, geracao_conteudo,
 * revisao_claude, adaptacao_marketplace, geracao_prompts_imagem,
 * geracao_imagem, calculo_score). Extração mecânica do branch `else`
 * que existia em executar-job.ts antes do registry (2026-08-11) —
 * mesmo comportamento observável, só movido de arquivo.
 *
 * `executarViaChamarIAFake()` é exportada separadamente do objeto
 * `handlerFakeGenerico` porque também é reaproveitada por
 * analise-visual.ts no caminho provedor="fake" (Google desabilitado) —
 * hoje esse é exatamente o mesmo caminho que as outras 6 etapas usam,
 * e o registry não deveria duplicar essa lógica em dois arquivos.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { chamarIA } from "../../ai-gateway/cliente";
import type { ContextoExecucaoJob } from "../executar-job";
import type { HandlerEtapa, ResultadoHandler } from "./registry";

export async function executarViaChamarIAFake(
  ctx: ContextoExecucaoJob,
  promptTexto: string
): Promise<ResultadoHandler> {
  const resposta = await chamarIA({
    modulo: "estudio_anuncios",
    projetoId: ctx.projetoId,
    jobId: ctx.jobId,
    tarefa: ctx.etapa,
    promptTexto,
  });

  if (!resposta.sucesso) {
    // Mesma mensagem literal do branch removido de executar-job.ts —
    // capturada pelo catch centralizado no executor, que produz
    // exatamente o mesmo { sucesso: false, erro: { tipo: "unknown",
    // mensagem: "Gateway retornou sucesso=false." } } de antes.
    throw new Error("Gateway retornou sucesso=false.");
  }

  return { resposta, resultadoParaPipeline: null };
}

export const handlerFakeGenerico: HandlerEtapa = {
  // Não é uma etapa fixa — este handler é compartilhado por 7 etapas
  // diferentes (ver ETAPAS_FAKE_GENERICAS em registry.ts) e é
  // parametrizado por ctx.etapa em tempo de execução. O valor abaixo é
  // só um placeholder de preenchimento do campo obrigatório da
  // interface — nunca comparado contra nada (a validação de boot em
  // registry.ts só confere HANDLERS_ESPECIFICOS, que não inclui este
  // objeto).
  etapa: "*",
  provedoresPermitidos: ["fake"],
  geraResultadoEstruturado: false,
  executar: async (ctx, _supabase, { promptTexto }) => executarViaChamarIAFake(ctx, promptTexto),
};
