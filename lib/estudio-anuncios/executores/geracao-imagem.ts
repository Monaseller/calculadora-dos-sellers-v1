/**
 * Handler específico de `geracao_imagem`. Mesmo padrão dos anteriores:
 * `provedoresPermitidos = ["fake", "google"]`, porque
 * decidirProvedor("geracao_imagem") só devolve "google" quando
 * GOOGLE_AI_IMAGEM_ENABLED="true" — caso contrário devolve "fake" e o
 * job continua pelo caminho fake genérico, sem regressão e sem tocar em
 * Storage.
 *
 * A troca de geracao_imagem de ETAPAS_FAKE_GENERICAS para
 * HANDLERS_ESPECIFICOS (registry.ts) é o ÚLTIMO passo atômico da tarefa.
 *
 * CUSTO: `estimarCustoUsd()` não tem preço cadastrado para modelo de
 * imagem, então devolve 0 com `console.warn` — comportamento explícito e
 * já existente, nunca uma tabela de preço inventada. `unidadesGeradas`
 * carrega o número real de imagens produzidas, que é a unidade que
 * importa auditar até haver preço oficial cadastrado em `custos.ts`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RespostaIA } from "../../ai-gateway/tipos";
import { estimarCustoUsd } from "../../ai-gateway/custos";
import { executarGeracaoImagemGoogle, montarResumoCurtoImagem } from "../geracao-imagem";
import { SCHEMA_VERSAO_GERACAO_IMAGEM } from "../geracao-imagem-tipos";
import type { ContextoExecucaoJob } from "../executar-job";
import type { HandlerEtapa, ResultadoHandler } from "./registry";
import { executarViaChamarIAFake } from "./fake-generico";

async function executar(
  ctx: ContextoExecucaoJob,
  supabase: SupabaseClient,
  args: { provedor: "fake" | "google" | string; promptTexto: string }
): Promise<ResultadoHandler> {
  if (args.provedor !== "google") {
    return executarViaChamarIAFake(ctx, args.promptTexto);
  }

  const execucao = await executarGeracaoImagemGoogle(supabase, ctx);

  const resposta: RespostaIA = {
    provedor: "google",
    modelo: execucao.modelo,
    sucesso: true,
    conteudo: montarResumoCurtoImagem(execucao.envelope),
    custoEstimado: estimarCustoUsd(
      execucao.modelo,
      execucao.tokensEntrada,
      execucao.tokensSaida,
      execucao.tokensSaidaImagem
    ),
    custoReal: 0,
    tokensEntrada: execucao.tokensEntrada,
    tokensSaida: execucao.tokensSaida,
    tokensSaidaImagem: execucao.tokensSaidaImagem,
    // Imagens efetivamente produzidas nesta execução — num retry que só
    // reaproveita, é 0, e isso é a verdade do consumo desta chamada.
    unidadesGeradas: execucao.imagensGeradasAgora,
    tempoMs: execucao.tempoMs,
  };

  return {
    resposta,
    resultadoParaPipeline: execucao.envelope as unknown as Record<string, unknown>,
  };
}

export const handlerGeracaoImagem: HandlerEtapa = {
  etapa: "geracao_imagem",
  provedoresPermitidos: ["fake", "google"],
  versaoSaida: SCHEMA_VERSAO_GERACAO_IMAGEM,
  // Consome o EnvelopeGeracaoPromptsImagem — aqui o job anterior na fila
  // É a origem semântica. Exigido e validado dentro de
  // executarGeracaoImagemGoogle(), não pelo registry.
  dependencia: "job_origem_id",
  versoesEntradaAceitas: [1],
  geraResultadoEstruturado: true,
  executar,
};
