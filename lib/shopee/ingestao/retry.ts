/**
 * Retry com backoff exponencial, FINITO, para chamadas a Shopee.
 * Repete so `rate_limit` e `transitorio`; `permanente` sobe na hora.
 * `dormir` e injetavel (testes nao esperam de verdade).
 */
import { ErroShopee } from "./tipos";

export interface OpcoesRetry {
  tentativas: number;  // total de tentativas (>= 1)
  baseMs: number;      // espera antes da 2a tentativa; dobra a cada uma
  dormir: (ms: number) => Promise<void>;
}

export const RETRY_PADRAO: OpcoesRetry = {
  tentativas: 3,
  baseMs: 1000,
  dormir: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export async function comRetry<T>(fn: () => Promise<T>, o: OpcoesRetry): Promise<T> {
  let ultimo: unknown;
  for (let t = 1; t <= Math.max(1, o.tentativas); t++) {
    try {
      return await fn();
    } catch (e) {
      ultimo = e;
      const tipo = e instanceof ErroShopee ? e.tipo : "transitorio"; // rede/timeout sem tipo = transitorio
      if (tipo === "permanente" || t === o.tentativas) break;
      await o.dormir(o.baseMs * 2 ** (t - 1) * (tipo === "rate_limit" ? 2 : 1));
    }
  }
  throw ultimo;
}
