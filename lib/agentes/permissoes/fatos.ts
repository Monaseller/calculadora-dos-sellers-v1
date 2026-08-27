/**
 * Leitura autorizada de permissao -> `FatoPermissao` — SKILL-1D.d.2.
 *
 * ── A pergunta que este modulo responde ─────────────────────────────
 *
 *   "Que nivel o DONO configurou para estas Funcoes, neste agente?"
 *
 * Ate aqui a resposta so existia em `MOCK_PERMISSOES`, que e da UI, tem
 * contrato proprio (`PermissaoUI`, com `procedencia`) e nunca foi lida
 * pelo diagnostico. Esta e a primeira fonte REAL de `FatoPermissao`.
 *
 * ── Autoridade ──────────────────────────────────────────────────────
 *
 * `(agente_id, user_id)` na PROPRIA instrucao, nunca comparacao em
 * memoria depois de ler. Agente de outro dono nao volta — e a resposta e
 * indistinguivel de agente inexistente, de proposito: distinguir viraria
 * um oraculo de existencia de ids alheios. Mesma decisao ja tomada em
 * `criarTarefa` e em `resolverFatoConexao`.
 *
 * `funcaoIds` e REQUISITO, vindo da Skill — nunca autoridade. A Skill
 * escolhe sobre QUE Funcoes perguntar; ela nao escolhe o dono. Nao ha, e
 * nao pode haver, `seller_id`, `shop_id`, `partner_id`, token ou
 * credencial na entrada nem na saida.
 *
 * ── Existencia nao se decide aqui ───────────────────────────────────
 *
 * Um `funcao_id` com forma valida e sem executor no registry continua
 * podendo ter linha: o banco valida FORMA, o registry valida EXISTENCIA.
 * Este modulo NAO consulta o registry — alem de a SKILL-1C ja resolver
 * `FALTA_FUNCAO` antes de permissao, `registry.ts` e `server-only` por
 * transitividade da service_role, e importa-lo aqui nao mudaria a
 * decisao, so acoplaria duas autoridades.
 *
 * ── O que este modulo NAO faz ───────────────────────────────────────
 *
 * Nao escreve, nao concede, nao revoga, nao cria linha para Funcao nova
 * e nao promove autonomia em nenhum caminho de erro. Conceder e ato do
 * DONO, por um write path que esta fase nao cria.
 */
import "server-only";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import {
  filtrosPermissoesDoAgente,
  montarFatosPermissoes,
  normalizarFuncaoIds,
  type LinhaPermissao,
} from "@/lib/agentes/permissoes/estado";
import type { FatoPermissao } from "@/lib/ia/skills/diagnostico";

/**
 * Projecao MINIMA. Duas colunas.
 *
 * `criado_em` e `alterado_em` existem na tabela e NAO entram: nenhum dos
 * dois participa da decisao, e `alterado_em` diria "quando mudou" a quem
 * so precisa saber "o que vale agora". `agente_id` e `user_id` tambem
 * ficam de fora — eles ja sao a autoridade da consulta, e reproduzi-los
 * na resposta so ofereceria a tentacao de reconfirmar em memoria o que a
 * instrucao ja garantiu.
 */
const COLUNAS = "funcao_id, nivel";

/**
 * O que o resolvedor recebe.
 *
 * `userId` e `agenteId` sao CONTEXTO — vem da sessao assinada e da
 * selecao ja autorizada pela camada de cima. `funcaoIds` e o REQUISITO,
 * e vem da Skill. A separacao importa: requisito nunca vira autoridade.
 */
export interface EntradaFatosPermissoes {
  userId: string;
  agenteId: string;
  funcaoIds: readonly string[];
}

/**
 * Como a coleta terminou — separado dos fatos, de proposito.
 *
 *   ok                a pergunta foi respondida; ausencia de fato e ausencia real
 *   falha_leitura     o banco nao respondeu; nada foi apurado
 *   entrada_invalida  faltou autoridade; nem houve o que perguntar
 *
 * TRES fatos diferentes, e nenhum deles pode se disfarcar de outro. Os
 * tres produzem lista vazia, e e justamente por isso que a lista sozinha
 * nao serve como resposta: sem este campo, perda de sessao, banco fora do
 * ar e "o dono nao liberou nada" ficariam indistinguiveis — e os tres
 * apareceriam ao usuario como "este agente nao possui permissao".
 *
 * `falha_leitura` NAO e ausencia. Aqui bloquear ate e o resultado SEGURO
 * — mas seria seguro pelo motivo errado: um banco fora do ar viraria "o
 * dono bloqueou tudo", indistinguivel de uma configuracao deliberada.
 *
 * `entrada_invalida` NAO e ausencia nem falha. `userId` ou `agenteId`
 * vazio nao e "este agente nao tem permissao": e nao haver agente nem
 * dono sobre quem perguntar. Um bug de chamador ou uma sessao perdida
 * precisam ser diagnosticaveis como tais.
 *
 * Nao ha `"ausente"`: em lote, ausencia e por `funcao_id`, nao da coleta
 * inteira, e ela ja se expressa pela nao-emissao do fato.
 *
 * ── Fronteira: isto NAO e estado de diagnostico ─────────────────────
 *
 * `ColetaPermissoes` descreve como a LEITURA terminou. Nao entra em
 * `ESTADOS_DIAGNOSTICO`, e a SKILL-1C nao a conhece. Quem futuramente
 * montar `EntradaDiagnostico` decide o que fazer com `entrada_invalida`
 * ANTES de chamar o motor — que continua diagnosticando fatos, e so.
 */
export type ColetaPermissoes = "ok" | "falha_leitura" | "entrada_invalida";

export interface ResultadoFatosPermissoes {
  fatos: readonly FatoPermissao[];
  coleta: ColetaPermissoes;
}

/** Resposta vazia bem-sucedida: "perguntei sobre nada, e nada e a resposta". */
const VAZIO: ResultadoFatosPermissoes = Object.freeze({
  fatos: Object.freeze([]) as readonly FatoPermissao[],
  coleta: "ok",
});

/** Faltou autoridade. Vazio como os outros — mas dizendo por que. */
const ENTRADA_INVALIDA: ResultadoFatosPermissoes = Object.freeze({
  fatos: Object.freeze([]) as readonly FatoPermissao[],
  coleta: "entrada_invalida",
});

/** Aplica o mapa de filtros como `.eq()` encadeados — mesmo padrao de
 *  `capability.ts`, para que o filtro PURO seja o que de fato vai a
 *  consulta, e nao uma copia decorativa dela. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function aplicarFiltros(consulta: any, filtros: Record<string, unknown>): any {
  let q = consulta;
  for (const [coluna, valor] of Object.entries(filtros)) q = q.eq(coluna, valor);
  return q;
}

/**
 * Resolve as permissoes de UM agente para um conjunto de Funcoes.
 *
 * Lote, e nao uma chamada por Funcao: o diagnostico consome
 * `readonly FatoPermissao[]` para tudo que a Skill declara em
 * `requer.funcoes`, e a PK `(agente_id, funcao_id)` ja indexa a leitura
 * por agente. Uma versao singular seria derivavel desta e custaria N
 * viagens ao banco para responder o que uma responde.
 *
 * Nenhum dos dois retornos antecipados toca o banco, e nenhum concede
 * autonomia: os dois devolvem lista vazia, que o motor le como
 * bloqueado. Eles se distinguem pela COLETA, nao pelo efeito.
 */
export async function resolverFatosPermissoes(
  entrada: EntradaFatosPermissoes
): Promise<ResultadoFatosPermissoes> {
  const { userId, agenteId } = entrada;

  // Autoridade PRIMEIRO. Sem dono ou sem agente nao ha pergunta a fazer
  // — e responder "ok, nenhuma permissao" seria afirmar algo sobre um
  // agente que ninguem identificou.
  if (!userId || !agenteId) return ENTRADA_INVALIDA;

  const ids = normalizarFuncaoIds(entrada.funcaoIds ?? []);

  // Requisito vazio e diferente: uma Skill pode legitimamente nao exigir
  // Funcao nenhuma. A pergunta foi feita e respondida — sobre nada.
  if (ids.length === 0) return VAZIO;

  const consulta = aplicarFiltros(
    getSupabaseServidor().from("agente_permissoes").select(COLUNAS),
    filtrosPermissoesDoAgente(agenteId, userId)
  );

  const { data, error } = await consulta.in("funcao_id", [...ids]);

  if (error) {
    // Sem `error.message`: mensagem de driver vaza nome de coluna, de
    // constraint e as vezes de valor, e acaba em log e em resposta HTTP.
    console.error("[permissoes] falha ao ler permissoes do agente");
    return { fatos: Object.freeze([]), coleta: "falha_leitura" };
  }

  const linhas = (Array.isArray(data) ? data : []) as LinhaPermissao[];
  const fatos = montarFatosPermissoes(linhas);

  // Descarte e derivavel, e vale registrar: significa linha que passou
  // pelo CHECK do banco e mesmo assim nao virou fato. Conta apenas —
  // nenhum valor de coluna vai para o log.
  const descartadas = linhas.length - fatos.length;
  if (descartadas > 0) {
    console.error(`[permissoes] ${descartadas} linha(s) descartada(s) por nivel invalido`);
  }

  return { fatos, coleta: "ok" };
}
