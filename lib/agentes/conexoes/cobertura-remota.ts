/**
 * Cobertura remota — o dono do ESTADO, M2-I1-A3.
 *
 * ── A pergunta que este modulo responde ─────────────────────────────
 *
 *   "este fato de conexao pode ser elevado de `nao_verificavel` para
 *    `confirmada`?"
 *
 * Ele nao sabe o que e Mercado Livre. Sabe que existe uma plataforma,
 * que ela tem um confirmador, e que o resultado dele entra num campo. O
 * provider concreto vive em `lib/mercado-livre-concessoes.ts`, atras
 * desta fronteira, e nenhum token atravessa para ca.
 *
 * ── Por que a elevacao acontece AQUI, e nao em `estado.ts` ──────────
 *
 * `coberturaDoRecurso` e sincrona, pura, e chamada de dentro de
 * `fatoDaLinha` — a funcao em que o `access_token` e deliberadamente
 * destruido. Verificar grant la exigiria reintroduzir o token exatamente
 * onde ele existe para morrer, e tornaria assincrona uma cadeia inteira
 * que hoje nao e. O fato sai de la honesto (`nao_verificavel`) e e
 * elevado depois, por quem pode pagar rede.
 *
 * ── O que ele NAO faz ───────────────────────────────────────────────
 *
 * Nao altera Permission, nao altera nivel, nao escolhe binding, nao cria
 * binding, nao rebaixa `estado`, nao inventa fato e nao guarda cache.
 * So troca UM campo, de UM fato, quando ha evidencia.
 */
import "server-only";
import {
  confirmarCoberturaML,
  type MotivoCoberturaML,
  type PortasCoberturaML,
} from "@/lib/mercado-livre-concessoes";
import type { FatoConexao } from "@/lib/ia/skills/diagnostico";

/**
 * A entrada, e a lista curta e a defesa.
 *
 * ── Por que `requisito` e obrigatorio ───────────────────────────────
 *
 * O executor esta tratando UMA Funcao. Confirmar a cobertura do snapshot
 * inteiro pagaria rede por requisitos que ninguem vai executar — e com
 * cinco Functions configuradas seriam cinco chamadas para usar uma. O
 * requisito em execucao entra por parametro justamente para que a conta
 * seja "uma chamada por execucao", e nao "uma por configuracao".
 *
 * Esse e o carry `FIX1-M1` sendo contido na fronteira certa: o desenho
 * ainda mistura snapshot de configuracao com conexao da execucao atual,
 * mas a REDE nao paga por essa mistura.
 */
export interface EntradaCoberturaRemota {
  readonly userId: string;
  readonly requisito: { readonly plataforma: string; readonly recurso: string };
  readonly lojaId: string;
  readonly acesso: "leitura" | "escrita";
  readonly conexoes: readonly FatoConexao[];
}

export interface ResultadoCoberturaRemota {
  /** Array NOVO. Apenas o fato do requisito pode ter mudado. */
  readonly conexoes: readonly FatoConexao[];
  /** `null` quando confirmou, ou quando nem havia o que confirmar. */
  readonly motivo: MotivoCoberturaML | null;
  /** Quantas chamadas de grant esta invocacao gastou. Para os asserts. */
  readonly chamadasRemotas: number;
}

/**
 * Quem sabe confirmar cada plataforma.
 *
 * Mapa fechado e congelado. Plataforma fora dele nao tem confirmador, e
 * isso NAO e erro: e ausencia de evidencia. O fato sai intacto, em
 * `nao_verificavel`, e o guard nega como sempre negou.
 */
type Confirmador = (
  entrada: { userId: string; lojaId: string; acesso: "leitura" | "escrita" },
  portas?: PortasCoberturaML
) => Promise<{ cobertura: string; motivo: MotivoCoberturaML | null }>;

const CONFIRMADORES: Readonly<Record<string, Confirmador>> = Object.freeze({
  mercado_livre: confirmarCoberturaML,
});

/**
 * Eleva a cobertura do fato do requisito em execucao — se houver prova.
 *
 * ── A chave do match e a TRIPLA ─────────────────────────────────────
 *
 * `(plataforma, recurso)` localiza o fato; `lojaId` e a conta contra a
 * qual a prova foi feita. Um fato de outro par, ou de outro recurso da
 * mesma plataforma, sai intacto — confirmar "ML" inteiro a partir de uma
 * prova de "ML/perguntas" seria inventar cobertura para `ads`.
 *
 * ── Dedupe ──────────────────────────────────────────────────────────
 *
 * Uma invocacao trata UM requisito, entao ha no maximo UMA chamada. O
 * `Map` por `lojaId` existe para que isso continue verdadeiro se um dia
 * esta funcao passar a receber varios requisitos da mesma loja: o grant
 * e por (aplicacao, vendedor), nao por recurso, e perguntar duas vezes
 * seria perguntar a mesma coisa.
 */
export async function confirmarCoberturaDosFatos(
  entrada: EntradaCoberturaRemota,
  portas?: PortasCoberturaML
): Promise<ResultadoCoberturaRemota> {
  const { userId, requisito, lojaId, acesso, conexoes } = entrada;

  const intacto = (motivo: MotivoCoberturaML | null): ResultadoCoberturaRemota =>
    ({ conexoes, motivo, chamadasRemotas: 0 });

  if (!userId || !lojaId) return intacto("credencial_ausente");

  const confirmador = CONFIRMADORES[requisito.plataforma];
  // Plataforma sem confirmador: nada a provar, e nada a inventar. Sem
  // motivo, porque nao houve recusa — houve ausencia de mecanismo.
  if (confirmador === undefined) return intacto(null);

  const alvo = conexoes.findIndex(
    (c) => c.plataforma === requisito.plataforma && c.recurso === requisito.recurso
  );
  // Sem fato para o requisito nao ha o que elevar, e pagar rede aqui
  // seria provar cobertura para uma conexao que nao existe.
  if (alvo === -1) return intacto(null);

  const cache = new Map<string, { cobertura: string; motivo: MotivoCoberturaML | null }>();
  let chamadasRemotas = 0;

  let veredito = cache.get(lojaId);
  if (veredito === undefined) {
    veredito = await confirmador({ userId, lojaId, acesso }, portas);
    chamadasRemotas = 1;
    cache.set(lojaId, veredito);
  }

  if (veredito.cobertura !== "confirmada") {
    return { conexoes, motivo: veredito.motivo, chamadasRemotas };
  }

  // Array NOVO, e so o campo `cobertura` do fato alvo muda. `estado`,
  // `plataforma` e `recurso` saem como a camada de fatos os produziu:
  // reinterpretar qualquer um deles criaria uma segunda autoridade sobre
  // a mesma pergunta.
  const elevados = conexoes.map((c, i) =>
    i === alvo ? { ...c, cobertura: "confirmada" as const } : c
  );

  return { conexoes: Object.freeze(elevados), motivo: null, chamadasRemotas };
}
