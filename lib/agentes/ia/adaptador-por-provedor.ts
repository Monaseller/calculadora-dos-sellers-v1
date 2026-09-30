import "server-only";

/**
 * Do nome do provedor para o adaptador — AGENT-FACTORY-F7b.4.2 §7/§8.
 *
 * Este e o ponto onde a escolha do dono deixa de ser uma coluna e passa a
 * ter efeito: e a unica peca que decide QUEM responde por um agente.
 *
 * ── Por que ele e um mapa explicito, e nao `catalogo[provedor]` ──────
 *
 * O catalogo de modelos e dado (nome, descricao, env, prova). Adaptador e
 * codigo. Fundir os dois faria o catalogo carregar tres modulos
 * `server-only` para responder "que modelos existem?", uma pergunta que a
 * tela faz e que nao deveria arrastar cliente HTTP nenhum.
 *
 * ── O que ele NAO faz ───────────────────────────────────────────────
 *
 * Nao escolhe por conta propria. Provedor desconhecido devolve `null`, e
 * quem chamou recusa o turno — nunca "tenta a Anthropic". Um agente
 * configurado para Gemini que respondesse por Claude porque a chave do
 * Google caiu estaria dando uma resposta que ninguem pediu, com outro
 * comportamento diante das mesmas instrucoes.
 *
 * O `fake` esta de fora de proposito: caminho fake e escolhido por quem
 * monta o teste, e nao por uma coluna que o browser consegue gravar.
 */
import type { AdaptadorIAComFerramentas } from "@/lib/agentes/ia/ferramentas";
import { chamarClaudeComFerramentas } from "@/lib/ai-gateway/provedores/anthropic-ferramentas";
import { chamarGeminiComFerramentas } from "@/lib/ai-gateway/provedores/google-ferramentas";
import { chamarOpenAIComFerramentas } from "@/lib/ai-gateway/provedores/openai-ferramentas";

/**
 * Os tres provedores com ida-e-volta de ferramenta PROVADO.
 *
 * Cada um entrou aqui depois de um roundtrip real, com a Funcao executada
 * pelo guard e o numero vindo dela:
 *
 *   anthropic  F4    scripts/testar-agentes-chamada-real.ts
 *   google     F7b.4 scripts/testar-gemini-stateless-live.ts
 *   openai     F7b.4.2 scripts/testar-openai-runtime-live.ts
 *
 * `PROVEDORES_COM_FERRAMENTA` em `factory/ativacao.ts` e a mesma lista
 * vista pela ativacao, e a suite cobra que as duas nao divirjam.
 */
const ADAPTADORES: Readonly<Record<string, AdaptadorIAComFerramentas>> = Object.freeze({
  anthropic: chamarClaudeComFerramentas,
  google: chamarGeminiComFerramentas,
  openai: chamarOpenAIComFerramentas,
});

/** `null` quando nao ha adaptador. Quem chama RECUSA; nao substitui. */
export function adaptadorDoProvedor(
  provedor: string | null
): AdaptadorIAComFerramentas | null {
  if (provedor === null) return null;
  const chave = provedor.trim();
  if (chave === "") return null;
  return Object.prototype.hasOwnProperty.call(ADAPTADORES, chave)
    ? ADAPTADORES[chave]
    : null;
}

/** Os provedores que este modulo sabe atender. Ordem estavel. */
export function provedoresComAdaptador(): readonly string[] {
  return Object.freeze(Object.keys(ADAPTADORES).sort());
}
