/**
 * Projecao por ALLOWLIST — TOOL-REGISTRY-B1.
 *
 * ── Por que allowlist, e nunca denylist ─────────────────────────────
 *
 * A alternativa obvia — "copiar tudo e depois remover `authorization`,
 * `token`, `cookie`" — falha de tres jeitos que nao aparecem em teste:
 * o campo novo que ninguem lembrou de proibir passa; a variacao de caixa
 * ou de nome (`x-api-key`, `Auth`, `chave`) passa; e o segredo aninhado
 * dentro de um objeto permitido passa. Uma denylist erra em silencio e
 * na direcao perigosa.
 *
 * Aqui nada atravessa por omissao. O objeto de saida e NOVO e comeca
 * vazio; um campo so existe nele porque alguem escreveu o nome dele numa
 * lista. Esquecer de permitir perde dado — e perder dado de auditoria e
 * um bug barato de achar. Esquecer de proibir vaza credencial.
 *
 * ── Somente escalares atravessam ────────────────────────────────────
 *
 * Valor que nao seja `string`, `number` finito, `boolean` ou `null` e
 * descartado, mesmo com a chave permitida. Isso e o que torna a
 * allowlist RASA suficiente: sem esta regra, permitir um campo `pedido`
 * deixaria passar tudo que estivesse dentro dele — inclusive um
 * `headers` que o chamador anexou sem perceber. Precisa de estrutura?
 * Projete cada folha explicitamente.
 *
 * ── Pureza ──────────────────────────────────────────────────────────
 *
 * Sem I/O, sem env, sem `server-only`. Nao serializa, nao persiste e nao
 * conhece banco: entrega um objeto simples para quem for gravar.
 */

/** Escalares que podem ser persistidos como estao. */
export type ValorSanitizado = string | number | boolean | null;

/** Limite de mensagem de erro que sobe para persistencia ou resposta. */
export const LIMITE_MENSAGEM = 300;

/**
 * `true` somente para objeto simples — literal ou `Object.create(null)`.
 *
 * Rejeita, de proposito e explicitamente: `Request`, `Headers`, `Map`,
 * `Date`, array e qualquer instancia de classe. O motivo nao e purismo.
 * Um `Headers` nao tem propriedades proprias enumeraveis, entao ele ja
 * sairia vazio por acidente — e "por acidente" nao e garantia. Recusar
 * na porta transforma o atalho perigoso ("passa a request inteira, o
 * sanitizador resolve") em resultado obviamente vazio, cedo.
 */
function ehObjetoSimples(valor: unknown): valor is Record<string, unknown> {
  if (typeof valor !== "object" || valor === null) return false;
  const proto = Object.getPrototypeOf(valor);
  return proto === Object.prototype || proto === null;
}

/** `true` para o que pode ser copiado como esta. `NaN` e `Infinity`
 *  ficam de fora: nao sobrevivem a JSON e viram `null` sem aviso. */
function ehEscalar(valor: unknown): valor is ValorSanitizado {
  if (valor === null) return true;
  const t = typeof valor;
  if (t === "string" || t === "boolean") return true;
  return t === "number" && Number.isFinite(valor);
}

/**
 * Constroi um objeto novo com SOMENTE os campos permitidos e escalares.
 *
 * Campo permitido que esteja ausente, herdado ou nao-escalar simplesmente
 * nao aparece na saida — nao vira `null`, nao vira `undefined`, nao vira
 * string. Ausencia e a informacao honesta; um `null` inventado diria que
 * o campo veio vazio, que e outra afirmacao.
 *
 * `Object.defineProperty` em vez de atribuicao direta: uma allowlist que
 * contenha `__proto__` faria `destino[chave] = valor` escrever no
 * prototipo em vez de criar campo. Improvavel, silencioso e gratuito de
 * evitar.
 */
export function projetarPermitidos(
  origem: unknown,
  permitidos: readonly string[]
): Record<string, ValorSanitizado> {
  const destino: Record<string, ValorSanitizado> = {};
  if (!ehObjetoSimples(origem)) return destino;

  for (const chave of permitidos) {
    // `hasOwnProperty` via `Object.prototype`: a origem pode ter
    // prototipo nulo, e `origem.hasOwnProperty` nem existiria nela.
    if (!Object.prototype.hasOwnProperty.call(origem, chave)) continue;

    const valor = origem[chave];
    if (!ehEscalar(valor)) continue;

    Object.defineProperty(destino, chave, {
      value: valor,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  return destino;
}

/**
 * Corta texto para o limite, com reticencia quando corta.
 *
 * Existe porque mensagem de erro de terceiro e superficie de vazamento:
 * o corpo de um 404 do n8n ecoa o path do webhook, e um stack traz
 * caminho de arquivo. Truncar nao sanitiza sozinho — quem chama ainda
 * decide o que vale a pena guardar — mas limita o estrago do que passar.
 *
 * Entrada que nao e string vira string vazia, nunca `"undefined"` nem
 * `"[object Object]"`.
 */
export function truncarMensagem(texto: unknown, limite: number = LIMITE_MENSAGEM): string {
  if (typeof texto !== "string") return "";
  if (limite <= 0) return "";
  if (texto.length <= limite) return texto;
  return `${texto.slice(0, limite)}…`;
}
