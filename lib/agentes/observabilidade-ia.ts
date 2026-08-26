/**
 * Observabilidade de chamadas de IA dos agentes — AGENTES-FASE1E-e.
 *
 * ── Onde esta camada fica, e por que exatamente aqui ────────────────
 * Ela envolve o `AdaptadorIA` — nao o handler, nao o executor, nao o
 * provedor. Foi comparacao, nao preferencia:
 *
 *   adapter Anthropic ...... tem tokens, NAO tem identidade. Dar
 *                            identidade a ele destruiria a invariante
 *                            que a 1E-a construiu: o adaptador precisa
 *                            ser incapaz de saber de quem e o dado.
 *   decorator do handler ... tem identidade e tokens, mas enxerga UMA
 *                            interpretacao por tarefa. No dia em que um
 *                            handler fizer tres chamadas, ele registra
 *                            uma e a contabilidade mente.
 *   executor ............... tem identidade, mas so ve o resultado
 *                            devolvido — nao ve chamada que FALHOU.
 *   wrapper do AdaptadorIA . ve TODA chamada, inclusive a que falhou, e
 *                            um evento e uma chamada. E esta.
 *
 * A identidade chega por CLOSURE, montada na composicao a partir do
 * `ContextoTarefa`. O adaptador interno continua recebendo apenas
 * `PedidoIA` — ele nao ganha `userId`, `agenteId` nem `tarefaId`, e
 * nao ha assinatura pela qual pudesse pedi-los.
 *
 * ── O que NUNCA e persistido ────────────────────────────────────────
 * Isto e contabilidade, nao log de prompt. Nao entra: `pedido.instrucao`,
 * `pedido.dados`, `pedido.schema`, a resposta bruta, `resumo`,
 * `destaques`, `alertas`, pedido cru, `order_sn`, anuncio, SQL, segredo,
 * API key, header ou stack com payload. O registrador so recebe numeros
 * e rotulos — nao ha caminho pelo qual o conteudo alcance o banco,
 * porque o evento nao tem campo para ele.
 */
import { estimarCustoUsd, modeloTemPrecoCadastrado } from "@/lib/ai-gateway/custos";
import { ErroProvedorIA } from "@/lib/ai-gateway/erros";
import type { ProvedorIA, TipoErroIA } from "@/lib/ai-gateway/tipos";
import type { AdaptadorIA, PedidoIA, RespostaEstruturadaIA } from "@/lib/agentes/ia/tipos";
import type { ContextoTarefa } from "@/lib/agentes/tipos-execucao";

/**
 * Quem pagou pela chamada. Todos os campos vem da linha REIVINDICADA
 * pelo claim, via `ContextoTarefa` — nunca de `agente_tarefas.entrada`.
 * Quem enfileira uma tarefa nao consegue mentir sobre de quem e o custo.
 */
export interface IdentidadeChamadaIA {
  readonly userId: string;
  readonly agenteId: string;
  readonly tarefaId: string;
  readonly tipoTarefa: string;
  readonly tentativa: number;
}

/**
 * O evento contabil de UMA chamada ao modelo.
 *
 * Repare no que NAO existe aqui: nenhum campo de texto livre, nenhum
 * lugar para prompt ou resposta. A allowlist e a propria forma do tipo.
 */
export interface ChamadaIARegistravel {
  readonly identidade: IdentidadeChamadaIA;
  readonly sequencia: number;
  readonly provedor: ProvedorIA;
  readonly modelo: string;
  readonly status: "sucesso" | "erro";
  readonly tipoErro?: TipoErroIA;
  readonly tokensEntrada: number;
  readonly tokensSaida: number;
  readonly tempoMs: number;
}

/**
 * O registrador. Recebe o evento e persiste.
 *
 * NUNCA lanca — ver `criarAdaptadorObservavel`. A assinatura devolve
 * `Promise<void>` de proposito: quem chama nao tem o que fazer com um
 * retorno, e nao deve tomar decisao de negocio a partir dele.
 */
export type RegistrarChamadaIA = (evento: ChamadaIARegistravel) => Promise<void>;

/** Monta a identidade a partir do contexto do claim. Funcao pura. */
export function identidadeDoContexto(contexto: ContextoTarefa): IdentidadeChamadaIA {
  return {
    userId: contexto.userId,
    agenteId: contexto.agenteId,
    tarefaId: contexto.tarefaId,
    tipoTarefa: contexto.tipo,
    tentativa: contexto.tentativa,
  };
}

/**
 * Calcula o custo, distinguindo ZERO de DESCONHECIDO.
 *
 * `estimarCustoUsd()` devolve 0 para modelo sem preco cadastrado, com um
 * `console.warn`. Persistir esse 0 registraria "nao sei o preco" como
 * "custou zero", e um relatorio somando esses zeros mentiria para baixo
 * sem nenhum sinal. Por isso a pergunta vem ANTES do calculo:
 *
 *   preco cadastrado  => numero
 *   sem preco         => null + warn explicito
 *
 * O warn nomeia o modelo (que nao e segredo) para que a correcao seja
 * obvia: cadastrar o preco em `custos.ts`.
 */
export function calcularCustoUsd(modelo: string, tokensEntrada: number, tokensSaida: number): number | null {
  if (!modeloTemPrecoCadastrado(modelo)) {
    console.warn(
      `[agentes/observabilidade] modelo "${modelo}" sem preco cadastrado — custo_usd registrado como NULL, ` +
        `nao como 0. Cadastre o preco em lib/ai-gateway/custos.ts para voltar a ter custo desta chamada.`
    );
    return null;
  }
  return estimarCustoUsd(modelo, tokensEntrada, tokensSaida);
}

/** Nome da tabela. Constante para que a suite possa afirmar sobre ela. */
export const TABELA_CHAMADAS_IA = "agentes_ia_chamadas";

/**
 * O registrador de PRODUCAO: persiste em `agentes_ia_chamadas`.
 *
 * ── Por que import dinamico do cliente ──────────────────────────────
 * `getSupabaseServidor` vive num modulo `server-only`. Estatico aqui,
 * ele arrastaria a barreira para todo mundo que apenas quisesse os
 * TIPOS ou o calculo de custo — e derrubaria a suite pura no load.
 * Dinamico, o banco so entra no processo quando alguem de fato registra.
 *
 * ── NUNCA lanca ─────────────────────────────────────────────────────
 * Falha de INSERT vira log de erro, nao excecao. A tarefa ja pagou pela
 * chamada e o resultado e valido; derrubar por causa da telemetria
 * provocaria uma retentativa PAGA. Ver o docblock de
 * `criarAdaptadorObservavel`.
 *
 * ── 23505 nao e falha ───────────────────────────────────────────────
 * `UNIQUE (tarefa_id, tentativa, sequencia)` e a identidade de uma
 * chamada. Violar essa chave significa que este evento JA foi
 * registrado — reprocessamento, nao duplicata a inserir. Tratado como
 * sucesso silencioso, exatamente como `registro.ts` do Estudio faz com
 * o `job_id`.
 */
export function criarRegistradorSupabase(): RegistrarChamadaIA {
  return async function registrarNoSupabase(evento: ChamadaIARegistravel): Promise<void> {
    try {
      const { getSupabaseServidor } = await import("@/lib/estudio-anuncios/supabase-servidor");

      const { error } = await getSupabaseServidor()
        .from(TABELA_CHAMADAS_IA)
        .insert({
          user_id: evento.identidade.userId,
          agente_id: evento.identidade.agenteId,
          tarefa_id: evento.identidade.tarefaId,
          tipo_tarefa: evento.identidade.tipoTarefa,
          tentativa: evento.identidade.tentativa,
          sequencia: evento.sequencia,
          provedor: evento.provedor,
          modelo: evento.modelo,
          status: evento.status,
          tipo_erro: evento.tipoErro ?? null,
          tokens_entrada: evento.tokensEntrada,
          tokens_saida: evento.tokensSaida,
          tempo_ms: evento.tempoMs,
          // Calculado AQUI, nunca recebido de fora: se o custo viesse no
          // evento, quem chama poderia injetar um valor.
          custo_usd: calcularCustoUsd(evento.modelo, evento.tokensEntrada, evento.tokensSaida),
        });

      if (error) {
        if (error.code === "23505") return; // ja registrado — nao e falha
        console.error(
          `[agentes/observabilidade] INSERT em ${TABELA_CHAMADAS_IA} falhou ` +
            `(tarefa=${evento.identidade.tarefaId} tentativa=${evento.identidade.tentativa} ` +
            `sequencia=${evento.sequencia} codigo=${error.code ?? "-"}). A tarefa NAO foi interrompida.`
        );
      }
    } catch (err) {
      console.error(
        `[agentes/observabilidade] erro inesperado ao registrar chamada de IA ` +
          `(tarefa=${evento.identidade.tarefaId}): ` +
          `${err instanceof Error ? err.message.slice(0, 200) : "desconhecido"}. A tarefa NAO foi interrompida.`
      );
    }
  };
}

/**
 * Envolve um `AdaptadorIA`, registrando cada chamada.
 *
 * ── Sequencia ───────────────────────────────────────────────────────
 * Contador por WRAPPER, nao global: um wrapper e criado por execucao de
 * tarefa, entao a sequencia comeca em 1 a cada execucao e conta as
 * chamadas daquela execucao. Junto de `(tarefa_id, tentativa)` isso
 * forma a identidade unica de uma chamada.
 *
 * ── A observabilidade NUNCA derruba a tarefa ────────────────────────
 * Se a Anthropic respondeu certo e o INSERT falhar, a resposta VALIDA e
 * devolvida assim mesmo e a falha vai para o log. Isso contraria o
 * fail-closed adotado no resto da frente, e e deliberado — os riscos
 * sao assimetricos:
 *
 *   derrubar a tarefa .... o dinheiro ja foi gasto, o resultado era bom,
 *                          e a retentativa gastaria DE NOVO. Um problema
 *                          de telemetria viraria perda de trabalho pago.
 *   concluir e logar ..... risco de subcontagem, que e real — e por isso
 *                          a falha e ruidosa, nunca engolida em silencio.
 *
 * ── Chamada que FALHOU tambem e registrada, quando houve custo ──────
 * JSON invalido e recusa da validacao estrutural acontecem DEPOIS de o
 * provedor responder: os tokens foram consumidos e o `usage` esta em
 * maos. Esses casos entram como `status='erro'` com o `tipo_erro`.
 *
 * LIMITACAO CONHECIDA, medida e nao contornada aqui: `conteudo_rejeitado`
 * (stop_reason=refusal) e `max_tokens` TAMBEM consomem tokens, mas
 * `chamarClaudeTexto` lanca sem ler `resposta.usage` — o numero se perde
 * antes de chegar a este wrapper. Registrar esses dois exigiria mais uma
 * alteracao no provedor compartilhado do Estudio, que esta fora do
 * escopo desta fase. Consequencia pratica: subcontagem nesses dois
 * caminhos. Erros de transporte (auth, rate_limit, transient) nao
 * consumiram nada — nao ha o que registrar.
 */
export function criarAdaptadorObservavel(
  adaptador: AdaptadorIA,
  identidade: IdentidadeChamadaIA,
  registrar: RegistrarChamadaIA,
  /**
   * Provedor e modelo DECLARADOS por quem compos o adaptador.
   *
   * Existem porque no caminho de ERRO a resposta nao chega, e sem isso
   * o wrapper teria de inventar. A primeira versao deste arquivo fixava
   * `"anthropic"` e `"(indisponivel)"` — duas mentiras: uma vira falsa
   * no dia em que o Google entrar, e a outra polui `GROUP BY modelo`
   * com um rotulo que nao e modelo nenhum.
   *
   * No SUCESSO vale o que a resposta trouxe (a API pode resolver um
   * alias para uma versao concreta, e e a concreta que interessa). No
   * ERRO vale o declarado, que e verdade: foi o que tentamos chamar.
   */
  declarado: { provedor: ProvedorIA; modelo: string }
): AdaptadorIA {
  let sequencia = 0;

  return async function adaptadorObservavel<T>(pedido: PedidoIA<T>): Promise<RespostaEstruturadaIA<T>> {
    const minhaSequencia = ++sequencia;

    // Nunca deixa a telemetria interromper o fluxo. `registrar` ja e
    // fail-safe por contrato, mas o `catch` aqui e a rede de seguranca
    // para um registrador injetado que nao respeite isso.
    const registrarSemQuebrar = async (evento: ChamadaIARegistravel) => {
      try {
        await registrar(evento);
      } catch (err) {
        console.error(
          `[agentes/observabilidade] falha ao registrar chamada de IA ` +
            `(tarefa=${evento.identidade.tarefaId} tentativa=${evento.identidade.tentativa} ` +
            `sequencia=${evento.sequencia}): ${err instanceof Error ? err.message.slice(0, 200) : "desconhecido"}`
        );
      }
    };

    try {
      const resposta = await adaptador(pedido);
      await registrarSemQuebrar({
        identidade,
        sequencia: minhaSequencia,
        provedor: resposta.provedor,
        modelo: resposta.modelo,
        status: "sucesso",
        tokensEntrada: resposta.tokensEntrada,
        tokensSaida: resposta.tokensSaida,
        tempoMs: resposta.tempoMs,
      });
      return resposta;
    } catch (err) {
      // `ErroProvedorIA` traz a CATEGORIA da falha; nao traz tokens nem
      // tempo — ver LIMITACAO no docblock. Os contadores vao zerados, e
      // isso NAO significa "custou zero": significa "consumo nao
      // observavel nesta camada". Quem le a tabela distingue pelo
      // `status='erro'`, e o docblock da migration diz isso em texto.
      //
      // Nao ha `catch` mudo: erro que nao seja `ErroProvedorIA` (bug
      // nosso, TypeError, etc.) nao vira linha de contabilidade, porque
      // ali nao houve chamada a provedor nenhum — mas continua subindo.
      if (err instanceof ErroProvedorIA) {
        await registrarSemQuebrar({
          identidade,
          sequencia: minhaSequencia,
          provedor: declarado.provedor,
          modelo: declarado.modelo,
          status: "erro",
          tipoErro: err.tipo,
          tokensEntrada: 0,
          tokensSaida: 0,
          tempoMs: 0,
        });
      }
      // O erro sobe INTEIRO. Fail-closed da IA continua valendo: falha
      // de provedor e falha de tarefa.
      throw err;
    }
  };
}
