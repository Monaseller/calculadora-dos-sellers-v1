/**
 * Roteamento do AI Gateway — decide qual provedor atende cada tarefa,
 * e qual categoria (central_ia_prompts.tipo) cada tarefa representa.
 *
 * AJUSTE (2026-08-09 — Primeira API real: Gemini para análise visual):
 * decidirProvedor() deixou de ser um stub 100% fixo. Agora lê
 * GOOGLE_AI_ENABLED (única variável de ambiente lida aqui) e roteia
 * `analise_visual` para "google" somente quando ela vale exatamente
 * "true" — todas as outras etapas continuam fixas em "fake", sem
 * exceção, e sem fallback automático para outro provedor em caso de
 * erro (isso é decisão do executor/job, nunca desta função). Uma
 * variável ausente, vazia ou com qualquer outro valor mantém
 * `analise_visual` também em "fake" (comportamento seguro por padrão —
 * nunca chama o Gemini "sem querer").
 *
 * decidirTipoPrompt() foi centralizado aqui (não na rota interna, nem
 * no executor de job) por pedido explícito — é uma decisão de
 * ROTEAMENTO ("qual categoria de conteúdo esta tarefa representa"),
 * mesma natureza de decidirProvedor(), então menor acoplamento fica
 * aqui do que espalhar em outro módulo. Mapeamento aprovado
 * explicitamente (2026-08-06) — não inventa categoria nova fora do
 * CHECK existente de central_ia_prompts.tipo.
 */
import type { ProvedorIA, TipoTarefaIA } from "./tipos";

export function decidirProvedor(tarefa: string): ProvedorIA {
  if (tarefa === "analise_visual" && process.env.GOOGLE_AI_ENABLED === "true") {
    return "google";
  }
  // Flag própria (GOOGLE_AI_GERACAO_CONTEUDO_ENABLED), não
  // GOOGLE_AI_ENABLED — permite habilitar cada etapa em momentos
  // diferentes, sem redefinir o escopo já documentado da flag
  // existente (ver .env.example). Mesmo padrão seguro por default:
  // ausente/vazio/qualquer valor != "true" mantém geracao_conteudo em
  // "fake".
  if (tarefa === "geracao_conteudo" && process.env.GOOGLE_AI_GERACAO_CONTEUDO_ENABLED === "true") {
    return "google";
  }
  // Flag própria (GOOGLE_AI_ADAPTACAO_MARKETPLACE_ENABLED), nunca
  // reaproveitando a de outra etapa — mesmo motivo já registrado acima
  // para geracao_conteudo: cada etapa liga/desliga de forma
  // independente. Mesmo padrão seguro por default: ausente/vazio/
  // qualquer valor != "true" mantém adaptacao_marketplace em "fake".
  if (tarefa === "adaptacao_marketplace" && process.env.GOOGLE_AI_ADAPTACAO_MARKETPLACE_ENABLED === "true") {
    return "google";
  }
  // Primeira etapa roteada para a Anthropic (2026-08-14). Flag própria,
  // como todas as outras — e é aqui que a função deixa de ser
  // "Google ou fake" e passa a ser roteamento de verdade entre dois
  // provedores reais. Mesmo padrão seguro por default: ausente/vazio/
  // qualquer valor != "true" mantém revisao_claude em "fake".
  if (tarefa === "revisao_claude" && process.env.ANTHROPIC_REVISAO_ENABLED === "true") {
    return "anthropic";
  }
  // Flag própria (GOOGLE_AI_PROMPTS_IMAGEM_ENABLED), nunca reaproveitando
  // a de outra etapa — mesma regra das anteriores. Vale reforçar: esta
  // etapa é geração de TEXTO (o planejamento dos prompts), então roteia
  // para "google" como as demais etapas de texto; nenhum provedor de
  // imagem é envolvido aqui.
  if (tarefa === "geracao_prompts_imagem" && process.env.GOOGLE_AI_PROMPTS_IMAGEM_ENABLED === "true") {
    return "google";
  }
  // Primeira etapa que gera IMAGEM de verdade (2026-08-16). Flag própria,
  // como todas as outras — e aqui a independência importa ainda mais: é a
  // única etapa que escreve arquivo em Storage e a única cujo modelo é de
  // imagem, não de texto. Mesmo padrão seguro por default.
  if (tarefa === "geracao_imagem" && process.env.GOOGLE_AI_IMAGEM_ENABLED === "true") {
    return "google";
  }
  // `calculo_score` (2026-08-17) é a única etapa roteada para "internal",
  // e a única SEM feature flag — deliberadamente. As flags das outras
  // existem para controlar chamada paga a provedor externo; aqui não há
  // provedor, não há modelo e não há custo: é cálculo determinístico
  // server-side. Uma flag seria cerimônia sem risco a controlar, e
  // deixaria a etapa capaz de cair num caminho "fake" que não faz sentido
  // para uma regra que roda inteira dentro do servidor.
  if (tarefa === "calculo_score") {
    return "internal";
  }
  return "fake";
}

const MAPA_TIPO_PROMPT: Record<string, TipoTarefaIA> = {
  ping: "texto",
  analise_visual: "auditoria",
  geracao_conteudo: "texto",
  revisao_claude: "revisao",
  adaptacao_marketplace: "texto",
  geracao_prompts_imagem: "imagem",
  geracao_imagem: "imagem",
  calculo_score: "auditoria",
};

/**
 * Mapeia a etapa do job (estudio_anuncios_jobs.etapa) para a categoria
 * de central_ia_prompts.tipo. Lança erro para qualquer tarefa fora do
 * mapeamento aprovado — nunca cai num default silencioso, porque uma
 * tarefa sem categoria mapeada é sinal de que o executor está tentando
 * registrar prompt para uma etapa ainda não suportada.
 */
export function decidirTipoPrompt(tarefa: string): TipoTarefaIA {
  const tipo = MAPA_TIPO_PROMPT[tarefa];
  if (!tipo) {
    throw new Error(`decidirTipoPrompt: nenhum tipo de prompt mapeado para a tarefa "${tarefa}".`);
  }
  return tipo;
}
