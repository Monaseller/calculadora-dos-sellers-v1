/**
 * Cliente do AI Gateway — ponto único que a rota interna (via o
 * executor, lib/estudio-anuncios/executar-job.ts) chama para executar
 * uma tarefa de IA.
 *
 * AJUSTE (2026-08-06 — integração funcional): continua 100% stub
 * determinístico, sem rede, sem SDK, sem variável de ambiente — só
 * ganhou conteúdo fake por etapa (antes só "ping" tinha conteúdo
 * definido, o resto caía em string vazia). Nenhum arquivo é gerado,
 * nenhum Storage é chamado — mesmo para geracao_imagem/
 * geracao_prompts_imagem, o "conteúdo" é só uma referência textual
 * fake, nunca um arquivo real (fora de escopo desta fase). O Gateway
 * não tem retry próprio: cada chamada aqui é 1 única tentativa (quem
 * decide reprocessar é o job, via tentativas/max_tentativas em
 * estudio_anuncios_jobs).
 *
 * A checagem de "etapa suportada nesta fase" NÃO mora aqui — é
 * responsabilidade do executor (ETAPAS_SUPORTADAS_FASE1 em
 * lib/estudio-anuncios/executar-job.ts), que nunca chega a chamar
 * chamarIA() para uma etapa não suportada. Etapas fora do mapeamento
 * abaixo caem no branch `default`, que devolve um conteúdo genérico —
 * isso só seria alcançado se o executor tivesse um bug de sincronia
 * entre as duas listas, não é o caminho esperado.
 *
 * AJUSTE (2026-08-09 — Primeira API real: Gemini para análise visual):
 * este cliente continua 100% fake — as chamadas reais ao Gemini vivem
 * em lib/estudio-anuncios/analise-visual.ts e
 * lib/estudio-anuncios/geracao-conteudo.ts (esta última desde
 * 2026-08-11), ambas sobre lib/ai-gateway/provedores/google.ts, e são
 * alcançadas pelos handlers dedicados do registry (nunca passam por
 * aqui). Como proteção extra contra o executor acidentalmente chamar
 * chamarIA() num desses caminhos por engano, esta função recusa
 * (lança) se decidirProvedor() devolver algo diferente de "fake" —
 * nunca rotula um conteúdo fake como se fosse de um provedor real.
 */
import type { SolicitacaoIA, RespostaIA } from "./tipos";
import { decidirProvedor } from "./roteamento";

function gerarConteudoFake(tarefa: string, projetoId: string): string {
  switch (tarefa) {
    case "ping":
      return "pong";
    case "analise_visual":
      return `analise_visual (fake): produto do projeto ${projetoId} — categoria/atributos estruturais inferidos de forma determinística, sem visão computacional real.`;
    case "geracao_conteudo":
      return `geracao_conteudo (fake): titulo="Produto de teste ${projetoId}" | descricao="Conteudo-base gerado de forma deterministica para validacao de infraestrutura, sem IA real."`;
    case "revisao_claude":
      return "revisao_claude (fake): revisão aprovada sem ressalvas — conteúdo-base considerado adequado (avaliação determinística, sem modelo real).";
    case "adaptacao_marketplace":
      return `adaptacao_marketplace (fake): conteudo-base adaptado ao formato do marketplace para o projeto ${projetoId}, sem chamada real a IA.`;
    case "geracao_prompts_imagem":
      return "geracao_prompts_imagem (fake): prompt visual determinístico — 'produto em fundo neutro, iluminação de estúdio, foco no item' (texto de prompt, não uma imagem).";
    case "geracao_imagem":
      return "geracao_imagem (fake): referencia-fake-sem-arquivo — nenhum arquivo real gerado, nenhum Storage chamado nesta fase.";
    case "calculo_score":
      return "calculo_score (fake): nota_seo=70 | nota_titulo=75 | nota_descricao=70 | nota_imagens=70 | nota_geral=71 (avaliação estrutural determinística, não é previsão de vendas).";
    default:
      return "";
  }
}

export async function chamarIA(solicitacao: SolicitacaoIA): Promise<RespostaIA> {
  const inicio = Date.now();
  const provedor = decidirProvedor(solicitacao.tarefa);
  if (provedor !== "fake") {
    throw new Error(
      `chamarIA(): decidirProvedor("${solicitacao.tarefa}") devolveu "${provedor}", mas este cliente só produz conteúdo fake. ` +
        `O executor deveria ter roteado esta tarefa para o cliente real correspondente antes de chegar aqui.`
    );
  }
  const conteudo = gerarConteudoFake(solicitacao.tarefa, solicitacao.projetoId);

  return {
    provedor,
    modelo: "fake-v1",
    sucesso: true,
    conteudo,
    custoEstimado: 0,
    custoReal: 0,
    tokensEntrada: 0,
    tokensSaida: 0,
    unidadesGeradas: 0,
    tempoMs: Date.now() - inicio,
  };
}
