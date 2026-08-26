/**
 * Contrato NEUTRO de chamada de IA para agentes — AGENTES-FASE1E-a.
 *
 * ── O que este arquivo e, e o que ele deliberadamente NAO e ─────────
 * E a menor interface capaz de representar "mande um texto e receba uma
 * estrutura validada de volta". Nada mais.
 *
 * Ele NAO e um agente, NAO e um orquestrador e NAO tem autoridade:
 * nao consulta vendas, nao escolhe dono, nao chama capability, nao
 * acessa Supabase, nao executa SQL, nao fala com marketplace e nao
 * pratica acao externa nenhuma. Recebe dados JA PREPARADOS por quem
 * chama e devolve interpretacao. IA aqui e processamento — autoridade
 * continua sendo do codigo.
 *
 * ── Por que a ausencia de campos e a propria protecao ───────────────
 * `PedidoIA` nao tem `userId`, `user_id`, `tenantId`, `projetoId`,
 * `jobId`, `SupabaseClient`, tabela, SQL, RPC, URL, segredo nem
 * definicao de tool. Isso nao e esquecimento: um modelo so consegue
 * pedir aquilo que a assinatura aceita, e esta nao aceita nada disso.
 * A defesa e estrutural, nao textual — nao depende de o prompt pedir
 * bom comportamento.
 *
 * O binding de dono continua exatamente onde a FASE 1D o provou:
 * `executar-tarefa.ts` -> `construirHandler(tarefa.user_id)` ->
 * `criarLeiturasDeVendas(userId)`. A IA entra DEPOIS, sobre dados que
 * ja passaram por ali.
 *
 * ── Por que reusar `ProvedorIA` e `ErroProvedorIA` do ai-gateway ────
 * Porque os dois sao genericos de provedor, nao do Estudio: sao apenas
 * "quem atendeu" e "as 6 categorias de falha de um provedor de IA".
 * Ambos os modulos de origem sao PUROS (nenhum import de runtime), o
 * que os torna seguros para um modulo que precisa continuar sem SDK,
 * sem env e sem rede.
 *
 * O que NAO foi reusado, e por que: `SolicitacaoIA` exige `projetoId`
 * e `jobId` — conceitos do pipeline do Estudio que uma tarefa de agente
 * simplesmente nao tem; e `chamarIA()` so produz fake e lanca quando o
 * provedor e real. Herdar qualquer um dos dois acoplaria agentes ao
 * Estudio sem ganho.
 */
import type { ProvedorIA } from "@/lib/ai-gateway/tipos";

/**
 * A validacao e NOSSA, e viaja junto do pedido.
 *
 * O `schema` do pedido e do PROVEDOR — sugestao de formato que ele pode
 * cumprir mal, parcialmente ou nao cumprir. Por isso quem chama entrega
 * tambem o validador: o adaptador nunca decide o contrato de saida, e
 * nenhum provedor pode declarar valida uma resposta que o nosso codigo
 * recusaria.
 *
 * LANCA em resposta invalida — nunca devolve `null` nem um objeto
 * "quase certo". Sem retorno degradado.
 */
export type ValidadorEstrutural<T> = (bruto: unknown) => T;

/**
 * Tudo que o adaptador recebe.
 *
 * `instrucao` orienta COMPORTAMENTO (tom, formato, o que nao afirmar).
 * `dados` sao os fatos ja preparados — texto, nao objeto vivo, e nunca
 * linha crua de banco. Prompt orienta; prompt NAO autoriza.
 */
export interface PedidoIA<T> {
  /** Instrucao de sistema. Comportamento, jamais autorizacao. */
  instrucao: string;
  /** Fatos ja agregados e serializados por quem chama. */
  dados: string;
  /** Schema declarado ao provedor. Sugestao, nao garantia. */
  schema: object;
  /** Validacao propria, aplicada SEMPRE, mesmo com schema aceito. */
  validar: ValidadorEstrutural<T>;
}

/**
 * O que volta. `conteudo` ja passou por `validar` — quem recebe uma
 * `RespostaEstruturadaIA` recebe algo que o nosso codigo aprovou.
 *
 * Os campos de uso existem porque sem medicao nao ha afirmacao sobre
 * custo. Eles sao os MESMOS que os dois provedores reais ja devolvem
 * hoje (`tokensEntrada`, `tokensSaida`, `tempoMs`), de proposito: o
 * contrato foi desenhado a partir do que Google e Anthropic ja
 * produzem, nao de um formato inventado que depois nao encaixasse.
 *
 * NAO ha custo em dinheiro aqui. Precificacao e contabilidade por dono
 * sao decisao separada (AGENTES-FASE1E-e) e nao entram no contrato
 * antes de existirem.
 */
export interface RespostaEstruturadaIA<T> {
  conteudo: T;
  provedor: ProvedorIA;
  modelo: string;
  tokensEntrada: number;
  tokensSaida: number;
  tempoMs: number;
}

/**
 * O adaptador. Uma funcao, um pedido, uma resposta validada.
 *
 * Generica de proposito: `analise_vendas` e o primeiro uso, nao o
 * unico. Qualquer etapa futura que precise de "texto entra, estrutura
 * validada sai" implementa este mesmo contrato — e Google e Anthropic
 * cabem nele sem adaptacao, porque ambos ja recebem prompt + schema e
 * ja devolvem texto + modelo + tokens + tempo.
 *
 * SEM `tools`, SEM `tool_choice`, SEM function calling. O projeto nao
 * tem nada disso hoje (busca por `tools:`/`tool_choice`/`input_schema`
 * em `lib/` e `app/`: zero ocorrencias), e a 1E-a nao introduz. Um
 * modelo sem tools nao tem por onde alcancar dado que o chamador nao
 * lhe entregou.
 */
export type AdaptadorIA = <T>(pedido: PedidoIA<T>) => Promise<RespostaEstruturadaIA<T>>;
