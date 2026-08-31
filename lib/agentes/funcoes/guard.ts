/**
 * Decisao de autorizacao de uma Funcao — TOOL-REGISTRY-B1.
 *
 * ── A pergunta que este modulo responde ─────────────────────────────
 *
 *   "Este agente pode executar esta Funcao AGORA?"
 *
 * E so isso. Ele nao executa, nao busca, nao persiste e nao explica ao
 * usuario final: devolve uma decisao com codigo estavel, e quem chamou
 * decide o que fazer com ela.
 *
 * ── Por que ele nao busca nada ──────────────────────────────────────
 *
 * Funcao PURA, sem Supabase, sem `fetch`, sem env, sem filesystem e sem
 * `import "server-only"`. Recebe FATOS ja resolvidos por quem tinha
 * autoridade para resolve-los — exatamente o contrato que
 * `diagnosticarSkill` ja usa em `lib/ia/skills/diagnostico.ts`.
 *
 * A ausencia de `server-only` e deliberada e nao afrouxa nada: nao ha
 * segredo, credencial nem identificador de dono neste arquivo, e nao ha
 * onde caberia. Em troca, a suite roda o motor DE VERDADE, sem banco.
 * Um guard que so pudesse ser testado por leitura de fonte seria um
 * guard nao testado.
 *
 * ── Por que ele nao importa o catalogo ──────────────────────────────
 *
 * `registry.ts` e `server-only`, e alcanca a service_role por
 * transitividade. Importa-lo aqui arrastaria essa cadeia para dentro de
 * uma decisao que nao precisa dela. A existencia da Funcao chega como
 * `FatoFuncao`, do mesmo jeito que chega ao diagnostico; o requisito de
 * conexao chega como parametro, resolvido do catalogo por quem chama.
 *
 * O tipo `RequisitoConexaoFuncao` vem do registry em import APAGADO em
 * tempo de compilacao (`import type`) — a forma continua tendo uma unica
 * definicao, sem custo de runtime.
 *
 * ── Fail closed ─────────────────────────────────────────────────────
 *
 * Todo caminho que nao chega ao fim nega. Nao ha default permissivo, nao
 * ha `catch` que libere e nao ha `throw` para negacao normal: negar e
 * resultado esperado, e resultado esperado nao e excecao. `throw` fica
 * reservado a invariante impossivel — e neste modulo nao ha nenhuma.
 */
import type { FatoConexao, FatoFuncao, FatoPermissao } from "@/lib/ia/skills/diagnostico";
import type { RequisitoConexaoFuncao } from "@/lib/agentes/funcoes/registry";

// ─── Vocabulario da decisao ───────────────────────────────────────────

/**
 * Os motivos pelos quais uma execucao NAO acontece.
 *
 * Estaveis por contrato: viram `erro_codigo` no ledger de auditoria e
 * chave de mensagem na interface. Renomear um destes e mudanca de
 * contrato, nao refatoracao.
 */
export const CODIGOS_NEGACAO = [
  "funcao_inexistente",
  "permissao_ausente",
  "permissao_bloqueada",
  "aprovacao_necessaria",
  "conexao_ausente",
] as const;
export type CodigoNegacao = (typeof CODIGOS_NEGACAO)[number];

/**
 * O que aconteceu com a execucao que nao aconteceu.
 *
 *   negado                 nao executa, e nada muda isso sozinho.
 *   aguardando_aprovacao   nao executa AGORA. Alguem pode aprovar.
 *
 * Os dois sao igualmente fail-closed no runtime — a diferenca e para
 * quem le depois. Colapsa-los num `permitido: false` unico faria a
 * interface tratar "o dono proibiu" e "o dono precisa confirmar" como a
 * mesma coisa, e sao decisoes opostas do ponto de vista de quem usa.
 *
 * O nome casa com `agente_tarefas.status`, que ja tem
 * `aguardando_aprovacao` desde a migration de fundacao. Nenhum enum
 * paralelo foi criado.
 */
export const ESTADOS_RECUSA = ["negado", "aguardando_aprovacao"] as const;
export type EstadoRecusa = (typeof ESTADOS_RECUSA)[number];

/**
 * Tudo que a decisao recebe. A lista curta e a defesa.
 *
 * NAO ha `userId`, `agenteId`, `lojaId`, `SupabaseClient`, token nem
 * credencial: autoridade foi resolvida ANTES. E nao ha `tipo` do agente
 * — perfil nao concede capacidade, e um campo aqui seria o convite para
 * que concedesse.
 *
 * `funcaoId` e `unknown` de proposito: o id pode vir de uma Skill, de
 * uma tarefa e um dia de um modelo. Quem decide valida, nunca faz cast.
 */
export interface EntradaGuard {
  funcaoId: unknown;
  /** Resolvido do catalogo por quem chama. `null` = nao exige conexao. */
  conexaoNecessaria: RequisitoConexaoFuncao | null;
  funcoes: readonly FatoFuncao[];
  permissoes: readonly FatoPermissao[];
  conexoes: readonly FatoConexao[];
}

/**
 * A decisao. Uniao discriminada por `permitido`, para que o TypeScript
 * impeca ler `codigo` de um resultado autorizado.
 *
 * O ramo permitido devolve `funcaoId` ja estreitado para `string`, e
 * nada alem: nao devolve o executor, porque quem executa e quem tem o
 * catalogo, e um guard que entrega executor vira despachante.
 */
export type ResultadoGuard =
  | { permitido: true; funcaoId: string }
  | { permitido: false; estado: EstadoRecusa; codigo: CodigoNegacao };

// ─── Auxiliares puros ─────────────────────────────────────────────────

const negar = (codigo: CodigoNegacao): ResultadoGuard => ({
  permitido: false,
  estado: "negado",
  codigo,
});

/**
 * Uma conexao SERVE para o requisito?
 *
 * Existir nao basta. `estado` precisa ser `conectada`: token expirado ou
 * conta desconectada e conexao que existe e nao funciona, e deixa-la
 * passar empurraria a falha para dentro do executor, onde ela viraria
 * erro de infraestrutura em vez de negacao explicada.
 *
 * E `cobertura` precisa ser `confirmada`. SOMENTE ela satisfaz.
 *
 * ── Por que `nao_verificavel` NAO satisfaz ──────────────────────────
 *
 * Uma versao anterior deste guard aceitava `nao_verificavel` com o
 * argumento de que transformar ignorancia em negacao seria invencao.
 * O argumento estava errado por tres motivos, e o terceiro decide.
 *
 * 1. Autorizar e diferente de diagnosticar. Aqui a saida nao e um
 *    relatorio: e a permissao para uma capacidade rodar. "Nao sei se a
 *    conta cobre este recurso" jamais pode virar "pode usar".
 *
 * 2. Na pratica o ramo nunca negava. `coberturaDoRecurso()` retorna
 *    HOJE, para todo recurso, `nao_verificavel` — nao ha produtor de
 *    `confirmada` nem de `ausente` em lugar nenhum do repositorio.
 *    Aceitar `nao_verificavel` tornava a checagem inteira inerte:
 *    codigo que parece guarda, passa no teste e nunca protege.
 *
 * 3. `diagnostico.ts` ja decidiu o contrario para o mesmo fato. Para
 *    requisito OBRIGATORIO, `nao_verificavel` vira pendencia com
 *    `bloqueia: true`. E `conexaoNecessaria != null` significa
 *    exatamente "obrigatoria". Duas respostas opostas para o mesmo fato
 *    e a segunda verdade que este repositorio inteiro evita.
 *
 * ── A consequencia, aceita de propria vontade ───────────────────────
 *
 * Enquanto `coberturaDoRecurso()` nao tiver o que afirmar, TODA Funcao
 * com `conexaoNecessaria` fica bloqueada. Isso e o estado honesto do
 * sistema, nao um defeito deste arquivo: a CDS realmente nao sabe se a
 * conta autoriza o recurso. O caminho para destravar e a integracao
 * registrar o escopo concedido — nunca afrouxar este `===`.
 *
 * `vendas.consultar` nao e afetada: `conexaoNecessaria` e `null`, entao
 * nao passa por aqui.
 */
function conexaoServe(fato: FatoConexao): boolean {
  return fato.estado === "conectada" && fato.cobertura === "confirmada";
}

// ─── A decisao ────────────────────────────────────────────────────────

/**
 * A ordem das checagens NAO e estilistica.
 *
 * 1. EXISTENCIA antes de PERMISSAO. Um fato pode dizer
 *    `nivel: "bloqueado"` para uma Funcao que nem existe; reportar
 *    "bloqueada" ali mandaria o dono liberar uma ferramenta inexistente.
 *    Mesma licao ja registrada em `diagnostico.ts`.
 *
 * 2. PERMISSAO antes de CONEXAO. Sem permissao, o estado da conexao e
 *    irrelevante — e responde-lo vazaria, a quem nao pode usar a Funcao,
 *    se o dono tem ou nao aquela conta ligada.
 *
 * 3. `aprovacao` interrompe ANTES de qualquer checagem de conexao. Nao e
 *    otimizacao: o nivel intermediario nao promete que o resto esta
 *    pronto, e prometer isso faria a interface dizer "so falta aprovar"
 *    quando ainda falta conectar.
 */
export function autorizarFuncao(entrada: EntradaGuard): ResultadoGuard {
  const { funcaoId } = entrada;

  // Id que nao e string nao identifica Funcao nenhuma. Nao existe, e o
  // codigo e o mesmo de um id bem formado e desconhecido: quem pergunta
  // nao aprende a diferenca entre "id invalido" e "id que nao registrei".
  if (typeof funcaoId !== "string" || funcaoId.length === 0) {
    return negar("funcao_inexistente");
  }

  // Ausente da lista conta como inexistente. O padrao seguro e "o
  // sistema nao sabe fazer", nunca "deve saber".
  const existe = entrada.funcoes.find((f) => f.id === funcaoId)?.existe === true;
  if (!existe) return negar("funcao_inexistente");

  // Permissao AUSENTE e permissao BLOQUEADA levam a mesma acao — nao
  // executar — e sao mantidas separadas de proposito. `diagnostico.ts`
  // colapsa as duas em `bloqueado` porque so precisa decidir; aqui o
  // codigo vai para auditoria, e "o dono nunca configurou" e "o dono
  // configurou como proibido" sao fatos diferentes sobre a intencao
  // dele. Nenhum dos dois permite.
  const permissao = entrada.permissoes.find((p) => p.funcaoId === funcaoId);
  if (permissao === undefined) return negar("permissao_ausente");

  if (permissao.nivel === "bloqueado") return negar("permissao_bloqueada");

  if (permissao.nivel === "aprovacao") {
    return { permitido: false, estado: "aguardando_aprovacao", codigo: "aprovacao_necessaria" };
  }

  // Aqui `nivel` so pode ser `automatico`. Nao ha `else` permissivo: se
  // um quarto nivel for adicionado a `NIVEIS_AUTONOMIA` sem passar por
  // este arquivo, o `tsc` reprova o `satisfies` abaixo antes de qualquer
  // valor novo virar "pode executar" por omissao.
  const _exaustivo: "automatico" = permissao.nivel;
  void _exaustivo;

  const requisito = entrada.conexaoNecessaria;
  if (requisito !== null) {
    const fato = entrada.conexoes.find(
      (c) => c.plataforma === requisito.plataforma && c.recurso === requisito.recurso
    );
    // Ausencia do fato e conexao inservivel dao o mesmo codigo: em
    // ambos os casos nao ha conexao utilizavel para o recurso, e a
    // distincao entre "nao ha conta" e "a conta expirou" pertence a
    // tela de Conexoes, que tem o estado inteiro para mostrar.
    if (fato === undefined || !conexaoServe(fato)) return negar("conexao_ausente");
  }

  return { permitido: true, funcaoId };
}
