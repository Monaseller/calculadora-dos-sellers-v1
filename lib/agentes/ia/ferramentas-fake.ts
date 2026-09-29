/**
 * Adaptador FAKE com ferramentas — AGENT-FACTORY-F2.
 *
 * ── Para que ele existe ─────────────────────────────────────────────
 *
 * A propriedade que o laco garante — "nenhuma ferramenta roda sem o
 * guard" — precisa ser provada sem depender de um modelo real decidir
 * pedir a ferramenta certa. Um provedor de verdade tornaria a suite
 * nao-deterministica e cara, e transformaria uma prova de SEGURANCA
 * numa aposta sobre o humor do modelo.
 *
 * Aqui o roteiro e escrito pelo teste: turno 1 pede tal ferramenta,
 * turno 2 responde texto. O laco nao sabe que o adaptador e falso —
 * ele cumpre o mesmo contrato.
 *
 * ── Determinismo, sem rede, sem chave ───────────────────────────────
 *
 * Zero `fetch`, zero SDK, zero variavel de ambiente. Alterar este
 * arquivo quebra testes que dependem do determinismo dele, como o
 * `gerarConteudoFake()` do Estudio ja quebra os de la.
 */
import type {
  AdaptadorIAComFerramentas,
  PedidoDeFerramenta,
  PedidoIAComFerramentas,
  RespostaIAComFerramentas,
} from "@/lib/agentes/ia/ferramentas";

/** Um turno roteirizado: ou pede ferramentas, ou fala. */
export type TurnoRoteirizado =
  | { readonly tipo: "pede"; readonly pedidos: readonly Omit<PedidoDeFerramenta, "id">[] }
  | { readonly tipo: "fala"; readonly texto: string };

export interface EspiaoDoFake {
  /** Um registro por ida ao modelo, com o que ele VIU. */
  readonly chamadas: {
    instrucao: string;
    ferramentas: readonly string[];
    mensagens: number;
    ultimaRespostaDeFerramenta: string | null;
  }[];
}

/**
 * Constroi o adaptador a partir de um roteiro.
 *
 * Se o roteiro acabar antes de o laco parar, o fake passa a FALAR — um
 * fake que repetisse o ultimo pedido geraria laco infinito e esconderia
 * o teto de passos, que e justamente uma das coisas a provar.
 */
export function criarAdaptadorFakeComFerramentas(
  roteiro: readonly TurnoRoteirizado[],
  espiao?: EspiaoDoFake
): AdaptadorIAComFerramentas {
  let i = 0;
  return async (pedido: PedidoIAComFerramentas): Promise<RespostaIAComFerramentas> => {
    if (espiao) {
      const ultima = [...pedido.mensagens].reverse()
        .find((m) => m.papel === "ferramenta");
      espiao.chamadas.push({
        instrucao: pedido.instrucao,
        ferramentas: pedido.ferramentas.map((f) => f.nome),
        mensagens: pedido.mensagens.length,
        ultimaRespostaDeFerramenta:
          ultima !== undefined && ultima.papel === "ferramenta"
            ? (ultima.respostas[0]?.conteudo ?? null)
            : null,
      });
    }

    const turno = roteiro[i];
    i += 1;

    const base = {
      provedor: "anthropic" as const,
      modelo: "fake-ferramentas",
      tokensEntrada: 10,
      tokensSaida: 5,
      tempoMs: 1,
    };

    if (turno === undefined || turno.tipo === "fala") {
      return {
        ...base,
        texto: turno === undefined ? "Roteiro esgotado." : turno.texto,
        pedidos: [],
      };
    }

    return {
      ...base,
      texto: null,
      pedidos: turno.pedidos.map((p, n) => ({ id: `fake-${i}-${n}`, ...p })),
    };
  };
}
