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
 * binding, nao inventa fato e nao guarda cache entre invocacoes.
 *
 * ── Por que ele mexe em `estado` — FIX1-M1 ──────────────────────────
 *
 * Ate a FIX1-M1 este modulo prometia trocar UM campo, `cobertura`, e
 * deixar `estado` exatamente como a camada de fatos o produziu. A
 * promessa era sincera e estava ERRADA no efeito.
 *
 * Confirmar cobertura nao e uma leitura inocente: o confirmador resolve
 * a credencial por `getMLLojaById`, e essa funcao RENOVA token vencido e
 * persiste a validade nova. Ou seja, esta funcao provoca uma mudanca no
 * mesmo fato que ela devolve — e devolvia o `estado` de ANTES da
 * mudanca. O guard exige `estado === "conectada"`, entao a primeira
 * execucao renovava a credencial com sucesso e terminava
 * `conexao_ausente`; a segunda passava, porque a validade nova ja estava
 * no banco. Um sistema que precisava ser chamado duas vezes para
 * funcionar uma.
 *
 * A correcao NAO e o guard aceitar `expirada`, e NAO e concluir
 * "conectada" porque o grant respondeu 200 — as duas trocariam uma
 * evidencia por um palpite. E reconciliar: depois de uma operacao que
 * pode ter mexido na credencial, reler o fato pelo produtor CANONICO
 * (`resolverFatoConexao` -> `derivarEstadoConexao`) e usar o `estado`
 * dali. Nenhuma regra de validade e reescrita aqui.
 *
 * Cada campo continua com UM dono: `estado` e da camada de fatos,
 * `cobertura` e desta. O que mudou foi o MOMENTO em que o primeiro e
 * lido — depois do efeito colateral, nao antes.
 */
import "server-only";
import {
  confirmarCoberturaML,
  type MotivoCoberturaML,
  type PortasCoberturaML,
} from "@/lib/mercado-livre-concessoes";
import { resolverFatoConexao } from "@/lib/agentes/conexoes/fatos";
import type { LimiteExterno } from "@/lib/controle-tempo";
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
  portas?: PortasCoberturaML,
  limiteExterno?: LimiteExterno,
  signalDoBanco?: AbortSignal
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
  portas?: PortasCoberturaML,
  /** OPCIONAL. O orcamento COMPARTILHADO do provider, repassado intacto. */
  limiteExterno?: LimiteExterno,
  /** OPCIONAL. O sinal RIGIDO, so para as leituras de BANCO daqui. */
  signalDoBanco?: AbortSignal
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
    veredito = await confirmador(
      { userId, lojaId, acesso }, portas, limiteExterno, signalDoBanco);
    chamadasRemotas = 1;
    cache.set(lojaId, veredito);
  }

  // FIX1-M1. O confirmador RODOU, e resolver a credencial pode te-la
  // renovado. A reconciliacao vem ANTES de olhar o veredito, de
  // proposito: a renovacao acontece ao resolver a credencial, muito
  // antes de o grant ser avaliado, entao ela e igualmente real quando a
  // cobertura e recusada. Amarra-la ao ramo de sucesso deixaria o
  // `estado` velho justamente nos casos de diagnostico.
  const base = await comEstadoReconciliado(
    conexoes, alvo, userId, lojaId, requisito, signalDoBanco);

  if (veredito.cobertura !== "confirmada") {
    return { conexoes: base, motivo: veredito.motivo, chamadasRemotas };
  }

  // Array NOVO, e so o campo `cobertura` do fato alvo muda. `plataforma`
  // e `recurso` saem como a camada de fatos os produziu: reinterpretar
  // qualquer um deles criaria uma segunda autoridade sobre a mesma
  // pergunta.
  const elevados = base.map((c, i) =>
    i === alvo ? { ...c, cobertura: "confirmada" as const } : c
  );

  return { conexoes: Object.freeze(elevados), motivo: null, chamadasRemotas };
}

/**
 * Rele o `estado` do fato alvo pelo produtor CANONICO — FIX1-M1.
 *
 * ── Por que reler, e nao calcular ───────────────────────────────────
 *
 * `resolverFatoConexao` le a linha e aplica `derivarEstadoConexao`, que
 * e a UNICA autoridade sobre validade de credencial neste repositorio.
 * Reproduzir a regra aqui — comparar `token_expires_at` com a margem,
 * ou concluir "conectada" porque a chamada remota respondeu — criaria a
 * segunda verdade que o resto do modulo evita.
 *
 * Do fato relido aproveita-se SOMENTE `estado`. A `cobertura` que ele
 * traz e `nao_verificavel` por construcao (`coberturaDoRecurso` e
 * constante), e deixa-la passar apagaria a elevacao que esta funcao
 * acabou de provar.
 *
 * ── Fail-closed ─────────────────────────────────────────────────────
 *
 * Falha de leitura ou ausencia de linha devolvem o array INTACTO, com o
 * `estado` antigo. Isso nega — que e a direcao segura. "Nao consegui
 * reler" jamais pode virar "esta conectada".
 *
 * ── O relogio ───────────────────────────────────────────────────────
 *
 * `Date.now()`, e nao o `agoraMs` do snapshot: a pergunta aqui e "esta
 * credencial serve AGORA, depois do que acabou de acontecer". Reusar o
 * instante anterior reintroduziria, em miniatura, a defasagem que esta
 * funcao existe para fechar.
 */
async function comEstadoReconciliado(
  conexoes: readonly FatoConexao[],
  alvo: number,
  userId: string,
  lojaId: string,
  requisito: { readonly plataforma: string; readonly recurso: string },
  signalDoBanco?: AbortSignal
): Promise<readonly FatoConexao[]> {
  const atual = await resolverFatoConexao({
    signal: signalDoBanco,
    userId,
    lojaId,
    plataforma: requisito.plataforma,
    recurso: requisito.recurso,
    agoraMs: Date.now(),
  });

  if (atual.coleta !== "ok" || atual.fato === null) return conexoes;

  // Guardado antes do `map` para nao precisar de asserção de nao-nulo
  // dentro do callback: o estreitamento acima ja provou o que importa.
  const estado = atual.fato.estado;
  if (estado === conexoes[alvo].estado) return conexoes;

  return conexoes.map((c, i) => (i === alvo ? { ...c, estado } : c));
}
