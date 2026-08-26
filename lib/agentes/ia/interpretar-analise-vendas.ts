/**
 * Composicao PURA: analise deterministica de vendas -> interpretacao de
 * IA — AGENTES-FASE1E-b.
 *
 * ── A fronteira que este modulo existe para desenhar ────────────────
 *
 *     numeros   = CDS   (API oficial + calculo deterministico)
 *     texto     = IA    (interpretacao, sem autoridade)
 *
 * Ela nao e uma recomendacao de estilo: e estrutural. A funcao devolve o
 * objeto deterministico PELA MESMA REFERENCIA que recebeu, sob a chave
 * `analise`, e poe o texto do modelo numa chave separada. Nao existe
 * caminho de codigo em que a saida da IA sobrescreva um numero — nao
 * porque alguem se lembrou de nao fazer, mas porque a IA nunca toca no
 * objeto que carrega os numeros.
 *
 * ── O que este modulo NAO faz, e nao tem como fazer ─────────────────
 * Nao busca vendas, nao pagina, nao conhece dono, nao recebe `userId`,
 * nao abre conexao, nao le ambiente, nao escolhe provedor, nao instancia
 * SDK, nao tem singleton. O adaptador CHEGA por parametro. Trocar fake
 * por provedor real e decisao de quem compoe, nunca deste arquivo.
 *
 * O isolamento por dono ja aconteceu antes daqui, na cadeia que a 1D-e
 * provou: executar-tarefa -> construirHandler(tarefa.user_id) ->
 * criarLeiturasDeVendas(userId). O que chega aqui ja e o agregado de UM
 * dono. Este modulo nao tem como saber de quem — e essa ignorancia e a
 * garantia, nao uma limitacao.
 *
 * ── Por que o modulo nao importa o tipo pronto do resultado ─────────
 * Porque ele NAO EXISTE. Medido, nao suposto: `agregarVendas` nao tem
 * anotacao de retorno (o tipo e inferido, com QUATRO chaves), e o objeto
 * de SEIS chaves que a tarefa devolve so existe como literal dentro do
 * closure de `criarHandlerAnaliseVendas`, cuja assinatura publica e
 * `Promise<Record<string, unknown>>`.
 *
 * As duas saidas ruins seriam: alterar `handlers/analise-vendas.ts` para
 * exportar um tipo (arquivo congelado, fora do escopo desta fase), ou
 * redigitar a forma inteira aqui, criando uma copia que envelhece em
 * silencio. A saida adotada e amarrar-se a funcao real via
 * `ReturnType<typeof agregarVendas>`: se a agregacao mudar, o `tsc`
 * acusa aqui. O import e `import type` — apagado por completo na
 * compilacao, entao nao acrescenta uma unica dependencia de runtime.
 */
import {
  SCHEMA_ANALISE_VENDAS_IA,
  validarAnaliseVendasIA,
} from "@/lib/agentes/ia/contrato-analise";
import type { AnaliseVendasIA } from "@/lib/agentes/ia/contrato-analise";
import type { AdaptadorIA, PedidoIA } from "@/lib/agentes/ia/tipos";
import type { agregarVendas } from "@/lib/agentes/handlers/analise-vendas";
import type { ProvedorIA } from "@/lib/ai-gateway/tipos";

/** As quatro chaves agregadas, amarradas a funcao real (ver docblock). */
type Agregado = ReturnType<typeof agregarVendas>;

/**
 * O resultado deterministico completo, como a tarefa `analise_vendas` o
 * devolve hoje: as quatro chaves de `agregarVendas` mais as duas que o
 * handler acrescenta.
 *
 * `escopo` e `periodo` sao redigitados porque nascem de um literal
 * inline, sem tipo a que se referir. As outras quatro derivam da funcao.
 */
export interface AnaliseVendasDeterministica {
  escopo: {
    campoData: string;
    statusConsiderado: string;
    incluiRentabilidade: boolean;
  };
  periodo: {
    inicio: string;
    fim: string;
    marketplace: string | null;
  };
  totais: Agregado["totais"];
  marketplaces: Agregado["marketplaces"];
  skus: Agregado["skus"];
  qualidadeDados: Agregado["qualidadeDados"];
}

/**
 * O que sai: numeros e texto em compartimentos separados.
 *
 * `analise` e a MESMA referencia recebida. `interpretacao` e o texto ja
 * validado. `origem` e metadado da chamada — nunca conteudo.
 */
export interface AnaliseVendasInterpretada {
  analise: AnaliseVendasDeterministica;
  interpretacao: AnaliseVendasIA;
  origem: {
    provedor: ProvedorIA;
    modelo: string;
    tokensEntrada: number;
    tokensSaida: number;
    tempoMs: number;
  };
}

/**
 * Instrucao de sistema. Orienta COMPORTAMENTO; nao concede nada.
 *
 * As tres ultimas regras nao sao genericas — cada uma fecha um erro que
 * este projeto ja identificou como facil de cometer:
 * apresentar receita como rentabilidade (gate 1D-0), ler um top-N
 * cortado como se fosse a lista inteira (por isso `skusOmitidos` e
 * declarado), e responder fora do contrato fechado.
 */
export const INSTRUCAO_INTERPRETACAO_VENDAS = [
  "Voce interpreta um relatorio de vendas JA CALCULADO pelo CDS.",
  "",
  "Os numeros recebidos sao fatos oficiais, apurados das APIs dos",
  "marketplaces por calculo deterministico. Seu papel e explica-los.",
  "",
  "Regras obrigatorias:",
  "- NAO recalcule, NAO corrija e NAO substitua nenhum valor recebido.",
  "- NAO invente metrica, projecao, percentual ou comparacao que nao",
  "  possa ser lida diretamente dos dados fornecidos.",
  "- Voce PODE citar no texto os numeros presentes nos dados.",
  "- NAO proponha nem execute acao. Voce descreve; quem decide e o",
  "  lojista.",
  "- `escopo.incluiRentabilidade` e false: estes valores sao RECEITA,",
  "  nunca lucro nem margem. Nao os trate como rentabilidade.",
  "- `qualidadeDados.skusOmitidos` maior que zero significa ranking",
  "  cortado. Nao afirme que a lista de SKUs esta completa.",
  "- Responda exatamente com resumo, destaques e alertas. Nenhuma",
  "  outra chave.",
].join("\n");

/**
 * Recusa uniforme de entrada malformada.
 *
 * `Error` simples, de proposito: isto nao e falha de provedor (nao
 * haveria `TipoErroIA` honesto para classificar) nem entrada de usuario
 * (`ErroEntradaTarefa` e de tarefa). E erro de COMPOSICAO — quem chamou
 * passou algo que nao e o resultado da analise. Inventar uma categoria
 * para isso engordaria a taxonomia sem que ninguem a consumisse.
 */
function exigir(condicao: boolean, motivo: string): void {
  if (!condicao) {
    throw new Error(`interpretarAnaliseVendas: ${motivo}`);
  }
}

function ehObjeto(valor: unknown): valor is Record<string, unknown> {
  return valor !== null && typeof valor === "object" && !Array.isArray(valor);
}

/**
 * PROJECAO EXPLICITA — o coracao da garantia deste modulo.
 *
 * Monta os fatos campo a campo, a partir de uma lista fixa. Nao e
 * `JSON.stringify(analise)`, e a diferenca importa: serializar o objeto
 * inteiro entregaria ao modelo qualquer coisa que alguem tenha grudado
 * nele — um `user_id`, um cursor, um trecho de linha crua. Aqui, o que
 * nao esta escrito abaixo simplesmente nao chega ao modelo, hoje nem
 * depois que outra pessoa editar o chamador.
 *
 * ── `anuncio` fica de FORA, e isso e deliberado ─────────────────────
 * `ResumoSku` tem `anuncio`, e ele NAO e projetado. Decisao da 1E-a: o
 * titulo do anuncio e texto livre escrito no marketplace, de terceiros,
 * que so faz sentido enviar ao modelo depois de uma decisao propria
 * sobre conteudo nao confiavel no prompt. `anunciosDistintos` (uma
 * contagem) vai; o texto nao. Se a v2 quiser incluir, e uma linha aqui —
 * consciente, nao por descuido.
 */
function projetarFatos(analise: AnaliseVendasDeterministica) {
  return {
    escopo: {
      campoData: analise.escopo.campoData,
      statusConsiderado: analise.escopo.statusConsiderado,
      incluiRentabilidade: analise.escopo.incluiRentabilidade,
    },
    periodo: {
      inicio: analise.periodo.inicio,
      fim: analise.periodo.fim,
      marketplace: analise.periodo.marketplace,
    },
    totais: {
      pedidosPagos: analise.totais.pedidosPagos,
      unidades: analise.totais.unidades,
      faturamento: analise.totais.faturamento,
      ticketMedio: analise.totais.ticketMedio,
    },
    marketplaces: analise.marketplaces.map((m) => ({
      marketplace: m.marketplace,
      pedidos: m.pedidos,
      unidades: m.unidades,
      faturamento: m.faturamento,
    })),
    skus: analise.skus.map((s) => ({
      sku: s.sku,
      marketplace: s.marketplace,
      pedidos: s.pedidos,
      unidades: s.unidades,
      faturamento: s.faturamento,
      anunciosDistintos: s.anunciosDistintos,
    })),
    qualidadeDados: {
      linhas: analise.qualidadeDados.linhas,
      linhasSemSku: analise.qualidadeDados.linhasSemSku,
      linhasSemValor: analise.qualidadeDados.linhasSemValor,
      skusDistintos: analise.qualidadeDados.skusDistintos,
      skusOmitidos: analise.qualidadeDados.skusOmitidos,
    },
  };
}

/**
 * Monta o pedido. PURA e exportada: a suite prova o formato do prompt
 * sem precisar de adaptador nenhum.
 *
 * Deterministica por construcao — a projecao tem ordem fixa de chaves,
 * a instrucao e constante e nao ha relogio, contador nem aleatorio. A
 * mesma analise produz o mesmo `PedidoIA`, byte a byte, sempre.
 *
 * `schema` e `validar` sao passados POR REFERENCIA, nunca reembrulhados:
 * quem recebe o pedido pode comparar por identidade e confirmar que o
 * contrato e o publicado na 1E-a, e nao uma copia divergente.
 */
export function prepararPedidoInterpretacao(
  analise: AnaliseVendasDeterministica
): PedidoIA<AnaliseVendasIA> {
  exigir(ehObjeto(analise), "esperava o resultado da analise de vendas.");
  for (const chave of ["escopo", "periodo", "totais", "qualidadeDados"] as const) {
    exigir(ehObjeto(analise[chave]), `campo "${chave}" ausente ou invalido.`);
  }
  for (const chave of ["marketplaces", "skus"] as const) {
    exigir(Array.isArray(analise[chave]), `campo "${chave}" deveria ser array.`);
  }

  return {
    instrucao: INSTRUCAO_INTERPRETACAO_VENDAS,
    dados: JSON.stringify(projetarFatos(analise), null, 2),
    schema: SCHEMA_ANALISE_VENDAS_IA,
    validar: validarAnaliseVendasIA,
  };
}

/**
 * Interpreta uma analise ja calculada. Dois parametros e nada mais:
 * o resultado deterministico e o adaptador.
 *
 * SEM try/catch, de proposito — mesma regra do handler da 1D-c. Falha do
 * adaptador (transient, rate_limit, auth) e recusa da validacao sobem
 * INTEIRAS. Um `catch` aqui viraria "texto inventado no lugar do erro",
 * que e exatamente o fallback silencioso que este projeto proibe.
 *
 * A unica fonte de nao-determinismo da funcao e a resposta do adaptador.
 * Tudo o mais — pedido, projecao, instrucao — e funcao pura da entrada.
 */
export async function interpretarAnaliseVendas(
  analise: AnaliseVendasDeterministica,
  interpretar: AdaptadorIA
): Promise<AnaliseVendasInterpretada> {
  exigir(typeof interpretar === "function", "exige um AdaptadorIA injetado.");

  const pedido = prepararPedidoInterpretacao(analise);
  const resposta = await interpretar(pedido);

  return {
    // MESMA referencia. Os numeros do CDS atravessam intactos, e nao ha
    // ramo de codigo em que a IA os alcance.
    analise,
    interpretacao: resposta.conteudo,
    origem: {
      provedor: resposta.provedor,
      modelo: resposta.modelo,
      tokensEntrada: resposta.tokensEntrada,
      tokensSaida: resposta.tokensSaida,
      tempoMs: resposta.tempoMs,
    },
  };
}
