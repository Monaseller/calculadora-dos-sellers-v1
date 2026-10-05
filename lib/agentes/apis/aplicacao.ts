/**
 * Aplicar UMA conta a varios recursos sem deixar o provider pela metade —
 * F9.2-A2.
 *
 * `agente_conexoes` e gravado linha a linha (`definirSelecaoDeLoja` /
 * `removerSelecaoDeLoja`), e nao ha RPC transacional para ele. Criar uma
 * exigiria migration, e este gate e code-only. Entao a garantia e por
 * COMPENSACAO:
 *
 *   1. tudo e validado ANTES (o plano ja vem pronto);
 *   2. o estado anterior de cada linha e conhecido (quem chama o captura);
 *   3. as linhas sao aplicadas em ordem;
 *   4. se uma falhar, as ja aplicadas — e a que falhou, cujo efeito e
 *      desconhecido — voltam ao estado anterior, na ordem inversa;
 *   5. se a volta tambem falhar, o resultado e `inconsistente`, explicito,
 *      com registro tecnico. Nunca `ok` com provider dividido.
 *
 * PURO: as escritas chegam por porta. A suite injeta falha na primeira,
 * numa intermediaria e na ultima operacao.
 */
import type { GravacaoDeConta } from "@/lib/agentes/apis/projecao";

export interface PortasDeConta {
  definir(g: { plataforma: string; recurso: string; lojaId: string }): Promise<boolean>;
  remover(g: { plataforma: string; recurso: string }): Promise<boolean>;
}

/** Chave estavel de uma linha de `agente_conexoes` (por agente). */
export function chaveDaLinha(g: { plataforma: string; recurso: string }): string {
  return `${g.plataforma}\u0000${g.recurso}`;
}

export type ResultadoDaAplicacao =
  | { readonly ok: true }
  /** Uma escrita falhou e TODAS as aplicadas foram desfeitas. */
  | { readonly ok: false; readonly codigo: "falha_revertida" }
  /** Uma escrita falhou e a volta tambem: o provider pode estar dividido. */
  | { readonly ok: false; readonly codigo: "inconsistente"; readonly naoRevertidos: readonly string[] };

async function tentar(f: () => Promise<boolean>): Promise<boolean> {
  try { return await f(); } catch { return false; }
}

export async function aplicarComCompensacao(
  gravacoes: readonly GravacaoDeConta[],
  /** `chaveDaLinha` -> loja ANTERIOR; `null` (ou ausente) = nao havia linha. */
  anteriores: ReadonlyMap<string, string | null>,
  portas: PortasDeConta
): Promise<ResultadoDaAplicacao> {
  const aplicadas: GravacaoDeConta[] = [];
  for (const g of gravacoes) {
    const ok = await tentar(() => g.tipo === "definir"
      ? portas.definir({ plataforma: g.plataforma, recurso: g.recurso, lojaId: g.lojaId })
      : portas.remover({ plataforma: g.plataforma, recurso: g.recurso }));
    if (ok) { aplicadas.push(g); continue; }

    // Desfaz as aplicadas E a que falhou (o efeito dela e desconhecido).
    const naoRevertidos: string[] = [];
    for (const a of [...aplicadas, g].reverse()) {
      const anterior = anteriores.get(chaveDaLinha(a)) ?? null;
      const voltou = await tentar(() => anterior === null
        ? portas.remover({ plataforma: a.plataforma, recurso: a.recurso })
        : portas.definir({ plataforma: a.plataforma, recurso: a.recurso, lojaId: anterior }));
      if (!voltou) naoRevertidos.push(a.recurso);
    }
    if (naoRevertidos.length > 0) {
      // Sem ids de dono, agente ou loja: o fato e o recurso bastam.
      console.error(`[apis/conta] compensacao incompleta; recursos sem reverter: ${naoRevertidos.join(",")}`);
      return { ok: false, codigo: "inconsistente", naoRevertidos };
    }
    return { ok: false, codigo: "falha_revertida" };
  }
  return { ok: true };
}
