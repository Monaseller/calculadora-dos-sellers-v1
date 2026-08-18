/**
 * scripts/_env-inerte.ts
 *
 * Preenche com PLACEHOLDERS as variaveis que o cliente Supabase exige no
 * momento em que o modulo e carregado (`createClient` valida a URL no load,
 * ver lib/shopee-auth.ts). Serve para suites standalone que precisam importar
 * um modulo de `lib/` cuja arvore toca o cliente, mas que testam apenas
 * funcoes puras e nunca fazem IO.
 *
 * Regras:
 *  - so define o que estiver AUSENTE — nunca sobrescreve valor real;
 *  - o valor e deliberadamente invalido para trafego real: se algum teste
 *    tentar bater no banco por engano, a chamada falha em vez de acertar
 *    producao silenciosamente;
 *  - importar SEMPRE como primeira linha do arquivo de teste. O transform CJS
 *    do tsx preserva a ordem dos imports, entao este roda antes dos demais.
 *
 * Nao usar fora de `scripts/`.
 */
const PLACEHOLDERS: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL:      "http://localhost:54321",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "chave-inerte-de-teste",
  SUPABASE_SERVICE_ROLE_KEY:     "chave-inerte-de-teste",
};

for (const [chave, valor] of Object.entries(PLACEHOLDERS)) {
  if (!process.env[chave]) process.env[chave] = valor;
}

export const ENV_INERTE_CARREGADO = true;
