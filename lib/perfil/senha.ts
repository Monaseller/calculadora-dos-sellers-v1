/**
 * Senha — hash, verificacao e comparacao segura. PERFIL-SENHA1b.
 *
 * ── O que este modulo e ─────────────────────────────────────────────
 * A UNICA peca do projeto que sabe comparar senha. Nao toca banco, nao
 * conhece rota, nao conhece `perfil`: recebe strings e devolve booleano.
 * Quem persiste e `lib/perfil/credenciais.ts`; quem decide o fluxo HTTP
 * e a rota de login.
 *
 * ── Argon2id, e por que estes numeros ───────────────────────────────
 * Argon2id e a recomendacao atual do OWASP para hash de senha: resiste
 * a GPU (custo de memoria) e a side-channel (variante `id`). Os tres
 * parametros abaixo sao o MINIMO do OWASP. Estao aqui, num so lugar, e
 * a suite trava cada um deles lendo o hash gerado — reduzir qualquer um
 * quebra o teste, nao passa despercebido.
 *
 * O hash Argon2 e AUTOCONTIDO: carrega variante, versao e os tres
 * parametros no proprio texto. Trocar parametros no futuro nao exige
 * coluna nova nem migration — hashes antigos continuam verificaveis com
 * os parametros com que foram criados.
 *
 * ── O que este modulo NUNCA faz ─────────────────────────────────────
 * Nao loga senha, nao loga hash, nao loga segredo. Nem em erro.
 */
import "server-only";
import { createHash, timingSafeEqual } from "crypto";
import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";

/**
 * `Algorithm.Argon2id` do SDK e um `const enum` AMBIENTE, e este projeto
 * compila com `isolatedModules` — importa-lo e erro de compilacao
 * (TS2748). O valor literal vem da propria declaracao do pacote
 * (`Argon2id = 2` em `index.d.ts`) e foi confirmado gerando um hash: sai
 * com prefixo `$argon2id$`. O teste 3 da suite trava esse prefixo, entao
 * uma troca acidental do numero nao passa despercebida.
 */
const ARGON2ID = 2;

/** Minimo OWASP para Argon2id. NAO reduzir — a suite trava os tres. */
export const PARAMETROS_ARGON2 = {
  algorithm: ARGON2ID,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * Hash de referencia usado SOMENTE para gastar tempo quando o email nao
 * existe — ver `verificarDummy`. E o hash de uma string fixa e publica;
 * nao e segredo e nao autentica ninguem.
 *
 * Gerado uma vez, sob demanda, e reaproveitado: gera-lo a cada
 * requisicao dobraria o custo do caminho mais barato de atacar.
 */
const SENHA_DUMMY = "cds-dummy-nao-e-segredo";
let hashDummy: string | null = null;

/**
 * `$argon2id$v=19$m=...,t=...,p=...$<salt>$<hash>`
 *
 * Reconhecimento ESTRUTURAL, nao heuristica de prefixo solto. Serve para
 * detectar valor corrompido ANTES de chamar o verificador — o binario
 * lanca com texto malformado, e um `throw` nao tratado no meio do login
 * viraria 500 em vez de 401.
 *
 * ATENCAO: isto NAO decide se a conta e legada. Essa decisao e
 * `senha_hash IS NULL`, estrutural, no banco. Uma senha legitima pode
 * comecar com `$argon2id$`, e por isso o formato nunca escolhe o ramo.
 */
const FORMATO_ARGON2ID = /^\$argon2id\$v=\d+\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/;

export function pareceHashArgon2id(valor: unknown): boolean {
  return typeof valor === "string" && FORMATO_ARGON2ID.test(valor);
}

/** Gera o hash Argon2id de uma senha. Lanca se o binario falhar. */
export async function gerarHash(senha: string): Promise<string> {
  return argonHash(senha, PARAMETROS_ARGON2);
}

/**
 * Verifica senha contra hash. FAIL-CLOSED em qualquer anormalidade:
 * hash ausente, formato invalido ou excecao do binario devolvem `false`,
 * nunca `true` e nunca uma excecao que suba para a rota.
 *
 * Devolver `false` para hash corrompido e deliberado: e o que impede o
 * downgrade. Se aqui lancasse, a rota poderia ser tentada a "cair para o
 * plaintext" no catch — exatamente o que nao pode acontecer.
 */
export async function verificarHash(senha: unknown, hash: unknown): Promise<boolean> {
  if (typeof senha !== "string" || !pareceHashArgon2id(hash)) return false;
  try {
    return await argonVerify(hash as string, senha);
  } catch {
    return false;
  }
}

/**
 * Gasta trabalho equivalente ao de uma verificacao real quando NAO ha
 * conta. Sem isto, "email inexistente" responderia em microssegundos e
 * "senha errada" em ~50 ms — diferenca suficiente para enumerar contas
 * pelo relogio, mesmo com status e mensagem identicos.
 *
 * Devolve sempre `false`; o valor existe so para o compilador nao
 * eliminar a chamada.
 */
export async function verificarDummy(senha: unknown): Promise<boolean> {
  if (!hashDummy) hashDummy = await gerarHash(SENHA_DUMMY);
  const candidata = typeof senha === "string" ? senha : "";
  await verificarHash(candidata, hashDummy);
  return false;
}

/**
 * Comparacao de plaintext legado em tempo constante.
 *
 * ── Por que nao `===` ───────────────────────────────────────────────
 * A comparacao de string em JS sai no primeiro byte divergente. Com o
 * plaintext ainda no banco, isso vaza o prefixo correto pelo tempo.
 *
 * ── Por que hash antes de comparar ──────────────────────────────────
 * `timingSafeEqual` LANCA se os buffers tiverem tamanhos diferentes — e
 * o tamanho da senha e justamente o que nao pode vazar. Comparar os
 * SHA-256 resolve os dois problemas de uma vez: sempre 32 bytes, sempre
 * o mesmo custo, e o digest so existe em memoria durante a comparacao.
 *
 * Isto NAO e "hash de senha" — e normalizacao de tamanho para uma
 * comparacao segura de um valor legado que ja esta em claro no banco. O
 * hash de verdade e o Argon2id.
 */
export function plaintextConfere(recebida: unknown, armazenada: unknown): boolean {
  if (typeof recebida !== "string" || typeof armazenada !== "string") return false;
  // `.trim()` preserva a semantica que o login sempre teve: a versao
  // anterior comparava `perfil.senha?.trim() !== senha.trim()`. Mudar
  // isso agora trancaria para fora quem cadastrou senha com espaco.
  const a = createHash("sha256").update(recebida.trim(), "utf8").digest();
  const b = createHash("sha256").update(armazenada.trim(), "utf8").digest();
  return timingSafeEqual(a, b);
}
