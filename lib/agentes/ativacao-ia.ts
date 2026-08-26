/**
 * Ativacao da interpretacao de IA no runtime dos agentes —
 * AGENTES-FASE1E-c.
 *
 * ── O que esta fase e, e o que ela NAO e ────────────────────────────
 * E WIRING. Liga a composicao pura da 1E-b ao runtime real, atras de
 * uma flag, usando o FAKE. Nao ha provedor externo, chamada de rede,
 * chave de API, billing, tool, loop de agente nem autonomia de modelo —
 * nada disso entra aqui, e a 1E-d e que decide se entra.
 *
 * ── Por que este arquivo NAO mora em `lib/agentes/ia/` ──────────────
 * Porque `lib/agentes/ia/` e zona PURA: sem env, sem rede, sem SDK, sem
 * relogio. A suite da 1E-a varre aqueles modulos (via `MODULOS_IA`) e
 * reprova `process.env` entre outros termos — e ela esta certa. Este
 * modulo LE ambiente, entao ele e wiring, e mora ao lado do executor e
 * do registry, nao dentro do contrato.
 *
 * A separacao nao e organizacional: e o que mantem a zona pura
 * verificavel. Enfiar o leitor de flag la dentro obrigaria a abrir uma
 * excecao no scanner, e excecao em scanner e como ele para de servir.
 *
 * ── Por que DECORATOR, e nao um parametro novo no handler ───────────
 * Comparadas as quatro opcoes, esta e a menor mudanca que preserva tudo
 * que importa:
 *
 *   A. `criarHandlerAnaliseVendas(capability, interpretar?)` — exigiria
 *      alterar `handlers/analise-vendas.ts`, que a suite da 1D-c mantem
 *      CONGELADO byte a byte (assert G10). Sair do congelamento e
 *      decisao de outra ordem, e nem seria necessaria.
 *   B. `ConstruirHandler` receber dependencias do runtime — mudaria a
 *      assinatura em `tipos-execucao.ts`, no registry E no executor.
 *      Tres arquivos para o que um resolve.
 *   C. executor montar as dependencias — poria capability dentro de
 *      `ContextoTarefa`, que hoje e DADO puro. Piora a fronteira.
 *   D. decorator na composition root — ESTA. Um arquivo novo e uma
 *      linha no registry.
 *
 * O ganho de (D) nao e so tamanho: o handler deterministico continua
 * sem saber que IA existe. Ele nao a escolhe, nao a recebe, nao a
 * menciona. Menos capacidade, nao mais.
 *
 * ── Fail-closed em toda parte ───────────────────────────────────────
 * Flag ausente, vazia, `"1"`, `"TRUE"`, `"yes"` ou lixo => DESLIGADA. O
 * unico valor que liga e a string exata `"true"`, mesma politica ja
 * vigente em `lib/ai-gateway/roteamento.ts` e em `lib/feature-flags.ts`.
 * Verdade por "string nao vazia" nunca — seria ligar IA em producao por
 * causa de um `=false` mal digitado.
 *
 * Nao ha `server-only` aqui de proposito, e a consequencia foi checada:
 * este modulo e alcancado apenas pelo registry, que ja e server-only por
 * transitividade. Se algum dia alguem o importar de um componente
 * cliente, `process.env.AGENTES_IA_INTERPRETACAO_ENABLED` (sem
 * `NEXT_PUBLIC_`) vem `undefined` no bundle, a flag le DESLIGADA e o
 * comportamento degrada para o caminho atual — fail-closed tambem ali.
 */
import { criarAdaptadorFake } from "@/lib/agentes/ia/fake";
import { interpretarAnaliseVendas } from "@/lib/agentes/ia/interpretar-analise-vendas";
import type {
  AnaliseVendasDeterministica,
  AnaliseVendasInterpretada,
} from "@/lib/agentes/ia/interpretar-analise-vendas";
import { identidadeDoContexto } from "@/lib/agentes/observabilidade-ia";
import type { IdentidadeChamadaIA } from "@/lib/agentes/observabilidade-ia";
import type { HandlerTarefa } from "@/lib/agentes/tipos-execucao";

/**
 * O nome da flag.
 *
 * ── Por que NAO `AGENTES_IA_REAL_ENABLED` ───────────────────────────
 * Porque nesta fase o adaptador e FAKE, e uma flag chamada "REAL" que
 * liga um fake e uma armadilha para quem for operar isso as tres da
 * manha. O nome descreve a FUNCIONALIDADE — ha interpretacao de IA no
 * resultado, sim ou nao — e nao quem a produz.
 *
 * A separacao tambem e util adiante: quando existir provedor de
 * verdade, ele ganha flag PROPRIA, seguindo a convencao ja vigente no
 * projeto ("toda etapa com IA real tem flag propria de ambiente, false
 * por padrao"). As duas ficam ortogonais e nenhuma das duas mente:
 * esta liga a funcionalidade, a outra escolhe o provedor.
 */
export const NOME_FLAG_INTERPRETACAO_VENDAS = "AGENTES_IA_INTERPRETACAO_ENABLED";

/**
 * A SEGUNDA flag — AGENTES-FASE1E-d. Escolhe entre fake e provedor real.
 *
 * ── Por que duas flags, e nao uma de tres estados ───────────────────
 * Porque elas desligam coisas DIFERENTES, e o rollback e em dois
 * niveis:
 *
 *   INTERPRETACAO OFF ................ handler base, por identidade
 *   INTERPRETACAO ON + REAL OFF ...... fake deterministico
 *   INTERPRETACAO ON + REAL ON ....... Anthropic real
 *
 * Desligar so a de baixo mantem a funcionalidade viva e tira o gasto e a
 * dependencia externa; desligar a de cima remove o caminho inteiro. Uma
 * variavel unica de tres valores confundiria "a feature existe?" com
 * "quem a atende?", e obrigaria a reler a tabela para saber o que um
 * valor significa.
 *
 * Tambem segue a convencao ja vigente: toda etapa com IA REAL tem flag
 * propria de ambiente, `false` por padrao.
 */
export const NOME_FLAG_PROVEDOR_REAL = "AGENTES_IA_PROVIDER_REAL_ENABLED";

/** Chaves que a interpretacao acrescenta ao resultado. */
export const CHAVE_INTERPRETACAO = "interpretacao";
export const CHAVE_ORIGEM_INTERPRETACAO = "origemInterpretacao";

/**
 * A capability de interpretacao, ja com o adaptador fechado por closure
 * — mesmo formato de `criarLeiturasDeVendas(userId)` devolvendo
 * `lerVendasDoPeriodo`. Quem recebe isto nao escolhe provedor: recebe a
 * funcao pronta ou nao recebe nada.
 */
export type InterpretarAnaliseDeVendas = (
  analise: AnaliseVendasDeterministica,
  /**
   * Quem esta pagando por esta chamada — AGENTES-FASE1E-e.
   *
   * Montada de `ContextoTarefa` pelo decorator, que a tem em maos. Vai
   * para a OBSERVABILIDADE, jamais para o `PedidoIA`: o adaptador
   * continua sem `userId`, `agenteId` ou `tarefaId`, e o modelo continua
   * recebendo apenas instrucao, dados e schema.
   *
   * Preferida a injecao na construcao porque `tarefaId` e `tentativa` so
   * existem no momento da EXECUCAO — o registry constroi o handler antes
   * disso e nao poderia saber nenhum dos dois. Assim o registry nao
   * muda: continua chamando `criarInterpretadorDeVendas()` sem argumento.
   */
  identidade: IdentidadeChamadaIA
) => Promise<AnaliseVendasInterpretada>;

/**
 * O UNICO leitor da flag em todo o runtime dos agentes.
 *
 * Le em tempo de CHAMADA, nao de import. Isso e deliberado e diverge de
 * `lib/feature-flags.ts`, que congela o valor no carregamento do modulo:
 * ali o valor e usado por componente de UI e nunca muda em processo;
 * aqui, prender no import tornaria a flag intestavel sem recarregar
 * modulo, e e exatamente o padrao de `roteamento.ts`, que le a cada
 * decisao.
 */
export function interpretacaoDeVendasHabilitada(): boolean {
  return process.env[NOME_FLAG_INTERPRETACAO_VENDAS] === "true";
}

/**
 * UNICO leitor da flag de provedor real. Mesma politica da outra: so a
 * string exata `"true"` liga; ausente, vazia, `"1"`, `"TRUE"` ou lixo
 * mantem o fake.
 */
export function provedorRealHabilitado(): boolean {
  return process.env[NOME_FLAG_PROVEDOR_REAL] === "true";
}

/**
 * Fabrica minima. Devolve a capability de interpretacao quando a flag
 * esta ligada, e `null` quando nao esta.
 *
 * `null` e nao um no-op de proposito: quem chama tem de DECIDIR o que
 * fazer sem interpretacao, e a decisao fica visivel no registry em vez
 * de escondida atras de uma funcao que finge trabalhar.
 *
 * O provedor entra AQUI, atras da flag propria dele, e em nenhum outro
 * lugar. Nem o handler, nem o registry, nem a entrada da tarefa tem voz
 * nessa escolha.
 *
 * ── O import do provedor real e DINAMICO, e isso e a garantia ───────
 * Com `AGENTES_IA_PROVIDER_REAL_ENABLED` desligada, o modulo do
 * adaptador — e portanto o SDK da Anthropic inteiro — NUNCA e carregado
 * no processo. Nao e "carregado e nao usado": nao entra em
 * `require.cache`. A suite da 1E-c verifica exatamente isso, e continua
 * verde depois desta fase.
 *
 * Um import estatico aqui traria o SDK para dentro do runtime de todo
 * mundo que toca o registry, inclusive com a feature desligada. O custo
 * do import dinamico e um `await` na primeira interpretacao real; o
 * ganho e que "desligado" significa mesmo ausente.
 */
export function criarInterpretadorDeVendas(): InterpretarAnaliseDeVendas | null {
  if (!interpretacaoDeVendasHabilitada()) return null;

  if (!provedorRealHabilitado()) {
    // O FAKE nao e observado, e isso e decisao, nao esquecimento: ele e
    // infraestrutura de teste, seu custo e zero por construcao, e
    // gravar linhas de contabilidade a partir dele encheria a tabela de
    // ruido — alem de por escrita em banco num caminho documentado como
    // deterministico e sem efeito externo. Sem custo, sem contabilidade.
    const { adaptador } = criarAdaptadorFake();
    return (analise) => interpretarAnaliseVendas(analise, adaptador);
  }

  return async (analise, identidade) => {
    const { criarAdaptadorAnthropic, obterModeloInterpretacao } =
      await import("@/lib/agentes/adaptador-anthropic");
    const { criarAdaptadorObservavel, criarRegistradorSupabase } =
      await import("@/lib/agentes/observabilidade-ia");

    // O modelo e resolvido AQUI tambem para que o caminho de erro tenha
    // o que declarar — e a mesma funcao leitora unica da env, entao nao
    // ha segunda fonte de verdade. Se a env faltar, isto lanca antes de
    // abrir conexao, exatamente como ja lancava.
    const observavel = criarAdaptadorObservavel(
      criarAdaptadorAnthropic(),
      identidade,
      criarRegistradorSupabase(),
      { provedor: "anthropic", modelo: obterModeloInterpretacao() }
    );

    // SEM try/catch: modelo ausente, auth, rate limit, timeout,
    // transient, JSON quebrado e resposta fora do contrato sobem
    // inteiros. Nao existe queda para o fake — com o provedor real
    // ligado, falha do provedor e falha da tarefa. A observabilidade
    // NAO participa dessa decisao: ela nunca derruba nem salva a tarefa.
    return interpretarAnaliseVendas(analise, observavel);
  };
}

/**
 * Envolve um handler ja construido, acrescentando interpretacao.
 *
 * ── A garantia de rollback e por IDENTIDADE ─────────────────────────
 * Com a flag desligada esta funcao devolve `base` — o MESMO objeto de
 * funcao, nao um wrapper que por acaso se comporta igual. Nao existe
 * caminho de codigo em que o adaptador seja tocado, porque nao existe
 * codigo novo no meio. E a forma mais forte de "nada mudou" que da para
 * escrever, e a suite verifica exatamente isso, por `===`.
 *
 * ── Aditivo, nunca substitutivo ─────────────────────────────────────
 * O resultado deterministico e espalhado primeiro e as duas chaves de
 * interpretacao vem depois, com nomes que nao colidem com nenhuma chave
 * produzida pela analise (`escopo`, `periodo`, `totais`, `marketplaces`,
 * `skus`, `qualidadeDados`). Os valores aninhados seguem sendo os
 * MESMOS objetos que `agregarVendas` produziu — a IA nunca os toca.
 *
 * ── Sem try/catch, de proposito ─────────────────────────────────────
 * Se a flag esta LIGADA e a interpretacao falha, a tarefa FALHA. Erro
 * do adaptador, resposta invalida e timeout sobem inteiros e o executor
 * os classifica como `handler_falhou`, exatamente como ja faz com
 * qualquer excecao de handler.
 *
 * Persistir a analise deterministica fingindo que a IA passou seria
 * sucesso parcial silencioso: a tarefa terminaria `concluida`, sem
 * interpretacao, e ninguem saberia que o provedor esta fora do ar.
 * Fail-closed aqui vale mais que resultado parcial.
 */
export function comInterpretacaoDeVendas(
  base: HandlerTarefa,
  interpretar: InterpretarAnaliseDeVendas | null
): HandlerTarefa {
  if (interpretar === null) return base;

  return async function handlerAnaliseVendasComInterpretacao(contexto, relatarProgresso) {
    const analise = await base(contexto, relatarProgresso);

    // O handler acabou de montar este objeto com as seis chaves da
    // analise. A conversao e no LIMITE entre o contrato aberto de
    // `HandlerTarefa` (`Record<string, unknown>`) e o contrato fechado
    // da 1E-b — e nao e um voto de confianca: se a forma nao bater,
    // `prepararPedidoInterpretacao` recusa e lanca, sem prompt
    // degradado.
    const interpretado = await interpretar(
      analise as unknown as AnaliseVendasDeterministica,
      identidadeDoContexto(contexto)
    );

    return {
      ...analise,
      [CHAVE_INTERPRETACAO]: interpretado.interpretacao,
      [CHAVE_ORIGEM_INTERPRETACAO]: interpretado.origem,
    };
  };
}
