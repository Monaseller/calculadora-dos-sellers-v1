/**
 * OBS-1 — a fronteira de bucket, PURA.
 *
 * Separado de `estado-esperado.ts` pela mesma razao que este repositorio
 * ja separa `consultar-vendas-contrato.ts` de `consultar-vendas.ts`: o
 * modulo de dominio carrega `server-only` e nao pode ser importado por
 * uma suite de Node, e a hierarquia de teste desta casa comeca por
 * unitario PURO. Uma regra que so pode ser auditada por regex sobre o
 * proprio texto nao e uma regra testada.
 *
 * Aqui nao ha banco, rede, env, nem `server-only`.
 */

/**
 * A cadencia do agendador, em milissegundos.
 *
 * Reproduzida, e nao importada, porque o agendador vive no n8n e nao e
 * modulo deste repositorio. Ela serve a UMA regra — o alinhamento de
 * `esperado_desde` — e o dia em que a cadencia mudar, a constante e a
 * regra mudam juntas, sem migration. Foi por esse motivo que o CHECK de
 * alinhamento NAO entrou no banco.
 */
export const CADENCIA_MS = 300_000;

/**
 * O instante cai numa fronteira de bucket?
 *
 * `esperado_desde` no meio de um bucket cobraria varredura por uma janela
 * que ja tinha comecado antes de alguem pedir observacao — e o primeiro
 * alerta seria sobre um periodo que ninguem prometeu vigiar. A fronteira
 * e o PRIMEIRO bucket inteiro que se espera ver.
 *
 * Trabalha sobre o instante absoluto em UTC, nao sobre campos de
 * calendario: `Date.parse` de um ISO com fuso devolve o mesmo epoch que
 * o equivalente em Z, entao `-03:00` alinhado continua alinhado. Usar
 * `getUTCMinutes()` teria o mesmo efeito aqui e escondria a razao.
 */
export function alinhadoAoBucket(iso: string): boolean {
  if (typeof iso !== "string" || iso.length === 0) return false;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  return t % CADENCIA_MS === 0;
}
