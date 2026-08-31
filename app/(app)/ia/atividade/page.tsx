/**
 * `/ia/atividade` — o feed do que aconteceu na operação.
 *
 * ── O que esta area NAO e ───────────────────────────────────────────
 *
 * Nao e a aba Tarefas de todos os agentes juntos, nao e log tecnico e
 * nao e console. A aba Tarefas responde "quais tarefas este agente tem";
 * esta tela responde "o que aconteceu". Por isso aqui nao ha progresso,
 * tentativa, duracao nem espera na fila — sao atributos de estado.
 *
 * ── Honestidade sobre a fonte ───────────────────────────────────────
 *
 * `agente_tarefas` e tabela de estado e sobrescreve historia: o claim
 * reescreve `iniciado_em` a cada tentativa, concluir limpa o erro
 * anterior e o retry devolve `concluido_em` para NULL. O feed deriva
 * apenas o que sobrevive a isso — e prefere omitir um evento a inventar
 * um. Ver `lib/ia/atividade.ts`.
 *
 * A pagina e fina: o feed inteiro vive em `Timeline`, Client Component
 * porque calcula "ha X" e filtra localmente.
 *
 * ── Onde esta o aviso de simulacao desta tela ───────────────────────
 *
 * A tarja global saiu do shell de `/ia` (ver o layout da area): com
 * `/ia/agentes` lendo dado real, um aviso de area inteira passou a
 * mentir sobre as telas verdadeiras.
 *
 * Esta tela CONTINUA simulada e continua avisando — so que o aviso ja
 * morava no corpo, dentro de `Timeline`, e nao aqui. Repeti-lo nesta
 * pagina daria dois avisos para uma simulacao so, que e como se ensina
 * o leitor a parar de ler avisos. Vale a mesma regra de
 * `/ia/aprovacoes`, cujo aviso mora em `FilaAprovacoes`.
 */
import Timeline from "@/components/ia/atividade/Timeline";

export default function PaginaAtividade() {
  return <Timeline />;
}
