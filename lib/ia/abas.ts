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

/**
 * ── Tres abas VOLTARAM a pendentes na SKILL-1D.ui-real-state-Bg2 ────
 *
 * `conexoes`, `funcoes` e `permissoes` foram promovidas na UI-1C.b, e a
 * promocao estava certa para o que existia: elas tinham componente
 * proprio com conteudo. So que o conteudo era simulado, e a
 * SKILL-1D.ui-real-state-B o removeu.
 *
 * O que sobrou foi uma aba anunciada como pronta que abria um "Em
 * breve" — sem o ponto na barra, sem o texto para leitor de tela, com o
 * placeholder montado tres vezes, uma dentro de cada componente.
 *
 * `implementada` voltou a significar UMA coisa: a funcionalidade
 * existe. Nao "ha um arquivo para esta aba".
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

/**
 * As abas que ainda nao existem, e o que cada uma espera.
 *
 * O tipo e derivado de `ABAS`: uma aba que passa a `implementada: true`
 * PRECISA sair daqui, e uma que continue pendente precisa continuar. O
 * `tsc` cobra os dois lados, entao a lista nao envelhece em silencio.
 */
type AbaPendente = Extract<(typeof ABAS)[number], { implementada: false }>["id"];

/**
 * O texto e lido pelo DONO do agente, na tela. Ele diz o que falta em
 * linguagem de produto — nunca nome de tabela, de rota ou de modulo:
 * quem le quer saber o que ainda nao da para fazer, nao como o sistema
 * e montado por dentro.
 */
export const PENDENCIA_ABA: Record<AbaPendente, string> = {
  chat:
    "falta conectar esta aba às conversas reais do agente. As mensagens e o histórico aparecerão aqui quando essa integração estiver disponível — uma resposta fabricada seria indistinguível de uma resposta de verdade, e por isso não existe.",
  conexoes:
    "falta conectar esta aba às contas que o agente realmente usa. As contas da sua conta CDS serão atribuídas a cada agente por aqui.",
  funcoes:
    "falta poder escolher e vincular as funções deste agente. Nenhuma função é listada até que essa escolha exista — um catálogo de exemplo seria lido como capacidade já concedida.",
  permissoes:
    "falta conectar esta aba às permissões do agente e ao fluxo de autorização. Enquanto não houver onde registrar quem decidiu e quando, nenhum nível é exibido e nenhum controle é oferecido.",
  memoria: "as instruções fixas já existem e aparecem na Visão geral. Preferências, memória aprendida e exemplos ainda não têm onde morar.",
  custos:
    "falta conectar esta aba aos custos reais de uso de IA deste agente. Nenhum valor é exibido enquanto essa leitura não estiver disponível — um número aproximado seria pior que nenhum.",
};
