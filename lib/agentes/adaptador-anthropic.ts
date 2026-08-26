/**
 * AdaptadorIA real sobre a Anthropic — AGENTES-FASE1E-d.
 *
 * ── Por que aqui, e nao em `lib/agentes/ia/` ────────────────────────
 * Mesma razao de `ativacao-ia.ts`: `lib/agentes/ia/` e zona PURA, e a
 * suite da 1E-a varre aqueles modulos reprovando `process.env` e SDK.
 * Este arquivo le ambiente e fala com um provedor — e wiring, nao
 * contrato. Manter a separacao e o que deixa a zona pura verificavel.
 *
 * ── O que ele NAO faz ───────────────────────────────────────────────
 * Nao le credencial (quem le e `obterCliente()` dentro do provedor —
 * ponto unico, e continua unico), nao constroi cliente, nao escolhe
 * provedor a partir de entrada de tarefa, nao usa tools nem function
 * calling, nao consulta banco, nao contabiliza custo e nao pratica acao
 * externa. Ele traduz `PedidoIA` em uma chamada de texto e traduz a
 * resposta de volta — nada mais.
 *
 * ── Reuso, e onde exatamente foi o corte ────────────────────────────
 * `chamarClaudeTexto` e a camada mais BAIXA do gateway: prompt + schema
 * entram, texto + modelo + tokens + tempo saem. Ela nao conhece
 * `projetoId`, `jobId`, `central_ia_consumo` nem Supabase — as unicas
 * mencoes ao Estudio no arquivo sao prosa de docblock, verificado.
 * Acima dela (`cliente.ts`, `roteamento.ts`, `registro.ts`) tudo e
 * Estudio, e nada disso e importado aqui.
 *
 * O que NAO foi reusado, de proposito: `obterModeloRevisao()`. Aquela
 * funcao e a leitora unica de `ANTHROPIC_MODEL_REVISAO`, que e a
 * semantica de uma etapa do Estudio. Agentes tem env propria.
 */
import { chamarClaudeTexto } from "@/lib/ai-gateway/provedores/anthropic";
import { ErroProvedorIA } from "@/lib/ai-gateway/erros";
import type { ResultadoChamadaAnthropic } from "@/lib/ai-gateway/provedores/anthropic";
import type { AdaptadorIA, PedidoIA, RespostaEstruturadaIA } from "@/lib/agentes/ia/tipos";

/**
 * Teto de tempo de UMA chamada de interpretacao, em milissegundos.
 *
 * 25 s nao e numero redondo escolhido por gosto — e o que cabe no
 * orcamento MEDIDO da tarefa:
 *
 *   worker aborta o HTTP em ......... 60 s (AGENTES_WORKER_HTTP_TIMEOUT_MS)
 *   Vercel Hobby corta a funcao em .. 60 s (independente de maxDuration)
 *   sobra para leitura de vendas, agregacao, validacao e persistencia
 *
 * O provedor precisa terminar BEM antes do corte externo, ou a tarefa
 * fica `executando` segurando o lease enquanto quem a esperava ja
 * desistiu. Com `maxRetries: 0` no cliente, 25 s e o tempo total da
 * chamada, nao de uma tentativa entre varias.
 *
 * Constante server-side, deliberadamente NAO configuravel por entrada
 * de tarefa: timeout e orcamento de infraestrutura, nao preferencia de
 * quem enfileira.
 */
export const TIMEOUT_MS_INTERPRETACAO = 25_000;

/**
 * A env que diz QUAL modelo os agentes usam.
 *
 * Nome proprio, e nao `ANTHROPIC_MODEL_REVISAO`: aquela variavel
 * descreve uma etapa do Estudio, e reaproveita-la amarraria as duas
 * frentes — trocar o modelo da revisao de anuncio mudaria calado o
 * modelo dos agentes. O prefixo `AGENTES_` segue o que a frente ja usa
 * (`AGENTES_IA_INTERPRETACAO_ENABLED`, `AGENTES_WORKER_HTTP_TIMEOUT_MS`).
 *
 * Se um dia existir uma segunda etapa de IA nos agentes, ela ganha
 * variavel propria — a regra "uma variavel, um unico leitor" vale aqui
 * igual ao resto do projeto.
 */
export const NOME_ENV_MODELO_INTERPRETACAO = "AGENTES_ANTHROPIC_MODEL";

/**
 * A forma da funcao de texto do provedor.
 *
 * Declarada aqui, e nao importada como `typeof chamarClaudeTexto`, para
 * que o teste possa injetar um duble sem carregar o SDK e sem que o
 * compilador aceite qualquer funcao: o contrato fica explicito.
 */
export type ChamarTextoAnthropic = (params: {
  promptSistema: string;
  promptUsuario: string;
  schema: object;
  modelo: string;
  maxTokens?: number;
  timeoutMs?: number;
}) => Promise<ResultadoChamadaAnthropic>;

/**
 * UNICO leitor de `AGENTES_ANTHROPIC_MODEL`.
 *
 * Le em tempo de chamada, aparando espaco. Ausente, vazia ou so com
 * espacos => LANCA, classificado como `auth` — mesma escolha ja feita
 * pelo projeto para credencial/modelo faltando (nao existe categoria
 * "config" em `TipoErroIA`). NUNCA cai para o modelo do Estudio, nunca
 * adivinha um nome de modelo, nunca degrada para o fake.
 */
export function obterModeloInterpretacao(): string {
  const bruto = process.env[NOME_ENV_MODELO_INTERPRETACAO];
  const modelo = bruto?.trim() ?? "";
  if (!modelo) {
    throw new ErroProvedorIA(
      "auth",
      `${NOME_ENV_MODELO_INTERPRETACAO} ausente, vazio ou so com espacos — configure essa variavel antes de ligar o provedor real dos agentes.`
    );
  }
  return modelo;
}

/**
 * Constroi o adaptador real.
 *
 * `chamar` tem valor padrao para que o runtime nao precise decidir nada,
 * e existe como parametro para que o TESTE injete um duble — nunca para
 * que a entrada de uma tarefa escolha provedor. Repare que a funcao nao
 * aceita modelo, timeout, credencial nem dono: quem enfileira uma tarefa
 * nao tem por onde influenciar nada disso.
 *
 * ── O provedor NAO decide o tipo final ──────────────────────────────
 * A resposta vem como TEXTO. Ele e desserializado e entao submetido a
 * `pedido.validar` — o mesmo validador que a 1E-a publicou. Isso vale
 * mesmo com `output_config: json_schema` ativo: o schema e do provedor,
 * a validacao e nossa. Ja custou bug real neste projeto acreditar no
 * contrario.
 *
 * ── Sem fallback ────────────────────────────────────────────────────
 * Modelo ausente, auth, rate limit, timeout, transient, JSON quebrado,
 * resposta fora do contrato: tudo LANCA. Em nenhuma hipotese devolve
 * conteudo fake, texto de desculpa ou objeto parcial. Com a flag de
 * provedor real ligada, falha do provedor e falha da tarefa.
 */
export function criarAdaptadorAnthropic(
  chamar: ChamarTextoAnthropic = chamarClaudeTexto
): AdaptadorIA {
  return async function adaptadorAnthropic<T>(
    pedido: PedidoIA<T>
  ): Promise<RespostaEstruturadaIA<T>> {
    // Antes de qualquer rede: se o modelo nao esta configurado, falha
    // aqui, sem gastar token nem abrir conexao.
    const modelo = obterModeloInterpretacao();

    const resposta = await chamar({
      promptSistema: pedido.instrucao,
      promptUsuario: pedido.dados,
      schema: pedido.schema,
      modelo,
      timeoutMs: TIMEOUT_MS_INTERPRETACAO,
    });

    let bruto: unknown;
    try {
      bruto = JSON.parse(resposta.resultadoTexto);
    } catch {
      // A mensagem NAO carrega o texto recebido: resposta de modelo pode
      // conter qualquer coisa, e log nao e lugar para isso.
      throw new ErroProvedorIA(
        "validation",
        "resposta do provedor nao e JSON valido — o contrato exige um objeto serializado."
      );
    }

    // A NOSSA validacao, sempre, mesmo com schema declarado ao provedor.
    const conteudo = pedido.validar(bruto);

    return {
      conteudo,
      provedor: "anthropic",
      // O modelo vem do RETORNO do provedor, nao da env: se a API
      // resolver um alias para uma versao concreta, e a versao concreta
      // que fica registrada.
      modelo: resposta.modelo,
      tokensEntrada: resposta.tokensEntrada,
      tokensSaida: resposta.tokensSaida,
      tempoMs: resposta.tempoMs,
    };
  };
}
