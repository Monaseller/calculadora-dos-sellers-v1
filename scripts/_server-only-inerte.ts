/**
 * scripts/_server-only-inerte.ts
 *
 * Neutraliza `server-only` para suítes standalone.
 *
 * ── Por que é necessário ────────────────────────────────────────────
 * O pacote `server-only` resolve por CONDIÇÃO de exportação:
 *
 *     "react-server" → ./empty.js   (no-op)
 *     default        → ./index.js   (lança na primeira linha)
 *
 * O Next.js ativa a condição `react-server` na camada de servidor, então
 * em produção o import é inofensivo. `tsx`/Node puro NÃO ativam essa
 * condição, caem no `default` e o módulo LANÇA — derrubando qualquer
 * suíte que importe, direta ou transitivamente, um módulo marcado como
 * server-only.
 *
 * Isto NÃO enfraquece a barreira: ela existe para impedir que o módulo
 * entre no bundle do CLIENTE, e continua valendo integralmente no build
 * do Next. Aqui só se reproduz, num runner de teste, a condição que a
 * produção já tem.
 *
 * Regras:
 *  - importar SEMPRE como primeira linha do arquivo de teste, antes de
 *    qualquer módulo de `lib/`. O transform CJS do tsx preserva a ordem
 *    dos imports;
 *  - suítes que instalam o próprio duplo de `require` (as de ML) devem
 *    importar este arquivo ANTES — o duplo delas encadeia sobre este;
 *  - não usar fora de `scripts/`.
 */
import Module from "node:module";

const requireOriginal = (Module as any).prototype.require;

(Module as any).prototype.require = function (id: string) {
  if (id === "server-only") return {};
  return requireOriginal.apply(this, arguments as any);
};

export const SERVER_ONLY_INERTE = true;
