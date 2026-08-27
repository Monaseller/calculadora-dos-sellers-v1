/**
 * CDS IA — as 8 abas da pagina do agente.
 *
 * ── Por que a aba vive na URL, e nao no estado ──────────────────────
 *
 * `?aba=tarefas` e compartilhavel, sobrevive a recarga e aparece no
 * historico do navegador. Estado em `useState` nao faz nenhuma das tres.
 *
 * ── Por que uma rota so, e nao 8 rotas-filhas ───────────────────────
 *
 * Oito segmentos criariam oito arquivos de rota que compartilham o mesmo
 * cabecalho e o mesmo carregamento do agente. A aba e uma VISTA do mesmo
 * recurso, nao outro recurso.
 *
 * ── A regra de seguranca deste arquivo ──────────────────────────────
 *
 * Query string e entrada do usuario. `abaSegura()` faz allowlist: o
 * valor bruto e comparado com os 8 ids conhecidos e qualquer outra coisa
 * vira `visao-geral`. Em nenhum momento a string crua indexa um mapa de
 * componentes — indexar objeto com chave vinda da URL e como escolher
 * arquivo com caminho vindo do usuario.
 */

export const ABAS = [
  { id: "visao-geral", rotulo: "Visão geral", implementada: true },
  { id: "chat", rotulo: "Chat", implementada: false },
  { id: "tarefas", rotulo: "Tarefas", implementada: true },
  { id: "conexoes", rotulo: "Conexões", implementada: false },
  { id: "funcoes", rotulo: "Funções", implementada: false },
  { id: "permissoes", rotulo: "Permissões", implementada: false },
  { id: "memoria", rotulo: "Memória", implementada: false },
  { id: "custos", rotulo: "Custos", implementada: false },
] as const;

export type AbaId = (typeof ABAS)[number]["id"];

export const ABA_PADRAO: AbaId = "visao-geral";

/**
 * Allowlist. Ausente, repetida (`?aba=a&aba=b` chega como array),
 * desconhecida ou de tipo errado -> `visao-geral`. Nunca lanca: uma URL
 * torta e coisa banal, e derrubar a pagina por causa dela seria pior que
 * o problema.
 */
export function abaSegura(bruto: unknown): AbaId {
  if (typeof bruto !== "string") return ABA_PADRAO;
  const encontrada = ABAS.find((a) => a.id === bruto);
  return encontrada ? encontrada.id : ABA_PADRAO;
}

/** O que cada aba ainda nao implementada esta esperando. */
export const PENDENCIA_ABA: Record<Exclude<AbaId, "visao-geral" | "tarefas">, string> = {
  chat: "nenhuma conversa é enviada ou armazenada hoje — não existe endpoint, provedor nem histórico. Uma resposta fabricada aqui seria indistinguível de uma resposta real, e por isso não existe.",
  conexoes: "falta o vínculo entre agente e conexão. As contas existem em `lojas`, mas nada registra qual agente usa qual conta.",
  funcoes: "falta o catálogo de funções. Hoje só existem dois tipos de tarefa registrados no runtime, e nenhum deles é uma capability concedível.",
  permissoes: "falta o modelo de permissão e autonomia. Sem onde gravar a decisão, um seletor aqui seria um botão que não decide nada.",
  memoria: "as instruções fixas já existem e aparecem na Visão geral. Preferências, memória aprendida e exemplos ainda não têm onde morar.",
  custos: "falta a camada de leitura. As chamadas de IA já são registradas com modelo, tokens, tempo e custo, mas ainda não há rota autenticada que as leia por dono.",
};
