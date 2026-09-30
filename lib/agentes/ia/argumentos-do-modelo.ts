/**
 * Os argumentos que o MODELO manda, normalizados — F7b.4.8.1.
 *
 * ── O bug que este arquivo existe para corrigir ─────────────────────
 *
 * O Rodrigo perguntou, no chat de um agente ATIVO com Mercado Livre
 * configurado e loja vinculada:
 *
 *   "Quanto vendi esta semana no Mercado Livre?"
 *
 * e recebeu "a ferramenta ou fonte necessaria nao esta disponivel",
 * `bloqueado_por_ferramenta`. A auditoria mostrou a verdade: permissao
 * `automatico`, plataforma e recurso resolvidos, loja presente — e
 * `codigo_desfecho: entrada_invalida`.
 *
 * MEDIDO em `testar-chat-real-marketplace-live`: para uma ferramenta com
 * campos opcionais, a OpenAI **nao omite** a chave que nao se aplica —
 * ela a envia com `null`:
 *
 *   { periodo: "esta_semana", de: null, ate: null }
 *
 * `validarFiltroVendasML` testava presenca com `!== undefined`, entao
 * `de: null` contava como "o dono mandou uma data", e a chamada era
 * recusada como `filtro_ambiguo`. Uma chamada perfeitamente correta.
 *
 * ── Por que a correcao mora AQUI ────────────────────────────────────
 *
 * Nao e defeito de um validador: e a classe inteira. Todo campo opcional
 * de toda Funcao tem o mesmo problema — `validarFiltroPerguntas` recusa
 * `status: null` com `status_invalido` pela mesma razao. Corrigir
 * validador por validador deixaria o proximo repetir o erro.
 *
 * Este e o unico ponto onde um pedido do MODELO vira um pedido de
 * EXECUCAO, e vale para os tres provedores. Uma regra, um lugar.
 *
 * ── O que ela NAO faz ───────────────────────────────────────────────
 *
 * Nao afrouxa validacao. Campo obrigatorio que chegar `null` passa a
 * chegar AUSENTE, e o validador continua recusando — com o codigo de
 * "faltou", que e o que de fato aconteceu, em vez de "invalido".
 *
 * Nao desce na estrutura. So chaves de PRIMEIRO nivel: `null` dentro de
 * um objeto ou de um array pode ser dado de verdade, e mexer nisso seria
 * reescrever o argumento em vez de limpar a convencao do provedor.
 *
 * Nao inventa valor. Nenhum default entra aqui — ausente e ausente.
 *
 * PURO: sem I/O, sem env, sem relogio.
 */

/**
 * `true` apenas para objeto simples — literal ou `Object.create(null)`.
 *
 * Array e instancia de classe ficam de fora: o que nao e um objeto de
 * argumentos sai intacto, e o validador da Funcao decide o que fazer com
 * ele. Mesma disciplina de `funcoes/sanitizar.ts`.
 */
function ehObjetoSimples(valor: unknown): valor is Record<string, unknown> {
  if (typeof valor !== "object" || valor === null) return false;
  const proto = Object.getPrototypeOf(valor);
  return proto === Object.prototype || proto === null;
}

/**
 * Remove as chaves de primeiro nivel cujo valor e `null`.
 *
 * Devolve o MESMO valor quando nao ha nada a remover — assim o caminho
 * comum nao aloca um objeto novo, e um argumento que nao seja objeto
 * atravessa sem ser tocado.
 */
export function semCamposNulos(argumentos: unknown): unknown {
  if (!ehObjetoSimples(argumentos)) return argumentos;

  // `undefined` tambem sai: ele nao sobrevive a JSON, mas um provedor
  // futuro pode entregar o objeto ja desserializado por SDK.
  const nulas = Object.keys(argumentos).filter((k) =>
    argumentos[k] === null || argumentos[k] === undefined);
  if (nulas.length === 0) return argumentos;

  const limpo: Record<string, unknown> = {};
  for (const [chave, valor] of Object.entries(argumentos)) {
    if (valor === null || valor === undefined) continue;
    limpo[chave] = valor;
  }
  return limpo;
}
