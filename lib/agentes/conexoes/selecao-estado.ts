/**
 * A REGRA da selecao explicita de loja — SKILL-1D.g.1-C.
 *
 * Modulo PURO: sem Supabase, sem `server-only`, sem `process.env`, sem
 * rede, sem relogio. Por isso a suite o EXECUTA de verdade.
 *
 * ── O que uma selecao e, e o que ela nao e ──────────────────────────
 *
 * Uma selecao responde UMA pergunta: "para o requisito
 * `(plataforma, recurso)`, qual loja o dono escolheu?"
 *
 * Ela NAO diz se a loja serve. Token valido, conta ativa e cobertura do
 * recurso sao de `resolverFatoConexao`, e continuam la. Misturar as duas
 * coisas faria "o dono escolheu a Loja 2" virar "a Loja 2 funciona", que
 * sao afirmacoes diferentes e falham por motivos diferentes.
 *
 * ── E, principalmente, o que ela nao FAZ ────────────────────────────
 *
 * Este modulo nunca ESCOLHE. Nao procura loja compativel, nao pega a
 * primeira, nao pega a unica, nao infere por marketplace, nao inventa
 * selecao em memoria. `conexoes/fatos.ts` ja recusou essa
 * responsabilidade por escrito — reintroduzi-la um nivel acima seria
 * contornar a decisao em vez de respeita-la.
 *
 * Ausencia persistida continua ausencia. Quem transforma isso em
 * diagnostico e o agregador futuro, nao aqui.
 */
import { MARKETPLACE_POR_PLATAFORMA } from "@/lib/agentes/conexoes/estado";

/** A linha crua de `agente_conexoes`, como o driver a devolve. */
export interface LinhaSelecao {
  agente_id: unknown;
  user_id: unknown;
  plataforma: unknown;
  recurso: unknown;
  loja_id: unknown;
}

/** A linha crua de `lojas`, na projecao minima desta camada. */
export interface LinhaLoja {
  id: unknown;
  user_id: unknown;
}

/**
 * Uma selecao ja validada.
 *
 * `lojaId` sai; `agenteId` e `userId` NAO. Os dois eram autoridade da
 * consulta — devolve-los so ofereceria a tentacao de reconferir em
 * memoria o que a instrucao ja garantiu.
 */
export interface Selecao {
  plataforma: string;
  recurso: string;
  lojaId: string;
}

/**
 * Como a leitura terminou — separado das selecoes, de proposito.
 *
 *   ok                a pergunta foi respondida; lista vazia e ausencia real
 *   falha_leitura     nao foi possivel montar a resposta INTEIRA
 *   entrada_invalida  faltou autoridade; nem houve o que perguntar
 */
export type ColetaSelecoes = "ok" | "falha_leitura" | "entrada_invalida";

// ─── Filtros ──────────────────────────────────────────────────────────
//
// Mapas de filtro PUROS, aplicados como `.eq()` encadeados por
// `fatos.ts`. Existir aqui e o que torna a autoridade da consulta
// testavel sem banco — e o que impede que a versao testada e a versao
// executada divirjam.

export function filtrosSelecoesDoAgente(agenteId: string, userId: string): Record<string, unknown> {
  return { agente_id: agenteId, user_id: String(userId) };
}

export function filtrosLojasDoDono(userId: string): Record<string, unknown> {
  return { user_id: String(userId) };
}

// ─── Validadores estruturais ──────────────────────────────────────────

const texto = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/**
 * Formato de `recurso`, equivalente ao `RE_SLUG` que
 * `lib/ia/skills/formato.ts` aplica ao validar `RequisitoConexao`, e ao
 * CHECK `agente_conexoes_recurso_formato` no banco.
 *
 * A regex e repetida porque `RE_SLUG` nao e exportado, e exporta-lo
 * exigiria editar um arquivo fora desta frente. A equivalencia esta
 * declarada aqui e provada na suite contra os mesmos casos.
 *
 * NAO ha vocabulario: `recurso` e chave OPACA. Enumerar `chat`,
 * `pedidos` ou `anuncios` transformaria exemplos em regra.
 */
const RE_RECURSO = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * `plataforma` NAO e opaca: ela tem vocabulario, e a autoridade dele e
 * `MARKETPLACE_POR_PLATAFORMA` — a mesma tabela que `resolverFatoConexao`
 * consulta para conferir o marketplace da loja. Uma terceira lista aqui
 * divergiria na primeira mudanca.
 *
 * O banco NAO tem CHECK nesta coluna, de proposito: o HEAD tem uma
 * contradicao viva — `mercado_livre` esta neste mapa, mas o `RE_SLUG` do
 * parser rejeita underscore, entao nenhuma Skill consegue declarar
 * requisito de Mercado Livre hoje. Congelar isso num CHECK produziria
 * migration corretiva na primeira reconciliacao.
 *
 * A ausencia de CHECK e exatamente por que ESTA funcao existe: sem ela,
 * uma linha com plataforma arbitraria viraria selecao valida.
 */
export function plataformaConhecida(v: unknown): v is string {
  return texto(v) && Object.prototype.hasOwnProperty.call(MARKETPLACE_POR_PLATAFORMA, v);
}

export function recursoValido(v: unknown): v is string {
  return texto(v) && RE_RECURSO.test(v);
}

/**
 * Valida e ORDENA as linhas de selecao. `null` = coleta inteira invalida.
 *
 * ── Por que fail-closed derruba TUDO, e nao descarta a linha ────────
 *
 * Em `permissoes/estado.ts` uma linha invalida e DESCARTADA: o efeito e
 * o da ausencia, ausencia significa bloqueado, e falhar para o lado
 * seguro se corrige sozinho.
 *
 * Aqui e outro caso. Descartar uma selecao invalida faria a coleta dizer
 * `ok` enquanto omite uma escolha que o dono fez — e a pergunta desta
 * camada e justamente QUAL conta sofre o efeito. Uma resposta incompleta
 * apresentada como completa e o modo de falha mais caro possivel: agir
 * na loja errada de um cliente real. Mesmo raciocinio de
 * `skills/estado.ts`, e pela mesma razao.
 *
 * ── A ordem, e por que ela e do par ────────────────────────────────
 *
 * `plataforma` depois `recurso` — o mesmo par canonico que
 * `diagnosticarSkill` usa como `chaveConexao`. Nao ha empate possivel:
 * a PK `(agente_id, plataforma, recurso)` garante o par unico por
 * agente, e duplicata aqui e justamente o que derruba a coleta.
 */
export function ordenarSelecoes(
  linhas: readonly LinhaSelecao[],
  agenteId: string,
  userId: string
): readonly Selecao[] | null {
  const out: Selecao[] = [];
  const vistos = new Set<string>();

  for (const l of linhas) {
    // Defesa em profundidade: a consulta ja filtrou por `agente_id` e
    // `user_id`, mas confiar nisso seria confiar no cliente. Linha que
    // nao pertence ao par pedido derruba a coleta.
    if (l.agente_id !== agenteId) return null;
    if (l.user_id !== String(userId)) return null;

    if (!plataformaConhecida(l.plataforma)) return null;
    if (!recursoValido(l.recurso)) return null;
    if (!texto(l.loja_id)) return null;

    const chave = `${l.plataforma}/${l.recurso}`;
    // A PK do banco impede duplicata. Se ela chegar assim mesmo, o
    // estado e inconsistente — e "ultimo vence" escolheria em silencio
    // qual loja age, que e exatamente o que esta camada existe para nao
    // fazer.
    if (vistos.has(chave)) return null;
    vistos.add(chave);

    out.push({ plataforma: l.plataforma, recurso: l.recurso, lojaId: l.loja_id });
  }

  return out.sort((a, b) =>
    a.plataforma === b.plataforma
      ? a.recurso.localeCompare(b.recurso)
      : a.plataforma.localeCompare(b.plataforma)
  );
}

/**
 * Confirma que cada selecao aponta para uma loja REAL do dono.
 * `null` = coleta inteira invalida.
 *
 * A FK composta `(loja_id, user_id) -> lojas(id, user_id)` ja impede
 * referencia quebrada e cross-tenant no banco. Esta funcao existe porque
 * a camada nao recebe o banco: recebe o que um cliente devolveu. Loja
 * ausente ou de outro dono derruba a coleta, e nao vira selecao valida.
 */
export function confirmarLojas(
  selecoes: readonly Selecao[],
  lojas: readonly LinhaLoja[],
  userId: string
): readonly Selecao[] | null {
  const doDono = new Set<string>();

  for (const l of lojas) {
    if (!texto(l.id)) return null;
    // Cross-tenant nao vira selecao, e tambem nao vira mensagem: quem
    // chama nao descobre daqui se a loja e de outro dono ou nao existe.
    if (l.user_id !== String(userId)) return null;
    if (doDono.has(l.id)) return null;
    doDono.add(l.id);
  }

  for (const s of selecoes) {
    if (!doDono.has(s.lojaId)) return null;
  }

  return selecoes;
}

/** Os `lojaId` distintos, para a QUERY 2 em lote.
 *
 *  Deduplicado de proposito: duas capacidades podem legitimamente
 *  apontar para a MESMA loja — `(shopee, chat)` e `(shopee, pedidos)`
 *  na mesma conta e o caso normal, nao um defeito. */
export function lojaIdsDistintos(selecoes: readonly Selecao[]): readonly string[] {
  return [...new Set(selecoes.map((s) => s.lojaId))];
}
