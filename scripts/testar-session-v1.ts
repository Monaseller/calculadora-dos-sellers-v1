/**
 * Mecanismo de sessão V1 (`lib/session.ts`) — testes de F0.c.2.5.
 *
 * ── Por que esta suíte existe ───────────────────────────────────────
 * `getUserId` devolvia QUALQUER conteúdo do cookie `cds_session` como se
 * fosse um `user_id`. Enquanto o cookie for um UUID cru isso não
 * incomoda; o problema aparece no dia em que a sessão assinada for
 * ligada e depois revertida: o navegador ainda teria o token novo, o
 * valor inteiro chegaria ao Postgres como UUID inválido e o usuário
 * veria **500** em vez de ser mandado para o login.
 *
 * Esta etapa endurece o V1 para aceitar SOMENTE UUID canônico.
 *
 * ── O que estes testes NÃO são ──────────────────────────────────────
 * Não são dupla aceitação. Nenhum teste aqui faz o mecanismo antigo
 * entender token assinado — o teste 4 prova exatamente o contrário.
 *
 * Sem rede, sem banco, sem credencial.
 *
 * Uso: npx tsx scripts/testar-session-v1.ts
 */
import { getUserId } from "../lib/session";

let ok = 0, falhou = 0;
function t(nome: string, fn: () => void) {
  try { fn(); ok++; console.log(`  PASS  ${nome}`); }
  catch (e: any) { falhou++; console.log(`  FALHA ${nome} -> ${e?.message ?? e}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

const UID = "d35ebb79-f37f-4a42-b7a2-ba1986c6d600";

/** Requisição com (ou sem) o cookie de sessão. */
const req = (valor?: string) =>
  new Request("https://exemplo.test/api/qualquer",
    valor === undefined ? undefined : { headers: { cookie: `cds_session=${valor}` } });

console.log("\n[1. o que continua sendo sessão]");

t("1. UUID canônico válido -> devolve o UUID", () => {
  assert(getUserId(req(UID)) === UID, "UUID válido deveria ser aceito");
});

t("1b. UUID em MAIÚSCULAS -> aceito, devolvido como veio", () => {
  // O login grava minúsculo (crypto.randomUUID), mas recusar maiúsculo
  // seria mudar comportamento sem necessidade.
  const maiusculo = UID.toUpperCase();
  assert(getUserId(req(maiusculo)) === maiusculo, "UUID maiúsculo deveria ser aceito");
});

t("1c. cookie entre outros cookies -> continua funcionando", () => {
  const r = new Request("https://exemplo.test/api/qualquer", {
    headers: { cookie: `outro=1; cds_session=${UID}; mais=2` },
  });
  assert(getUserId(r) === UID, "não leu o cookie entre outros");
});

console.log("\n[2. o que deixa de ser sessão]");

t("2. sem cookie nenhum -> null", () => {
  assert(getUserId(req()) === null, "ausência de cookie deveria ser null");
});

t('3. legado "1" -> null (comportamento preservado)', () => {
  assert(getUserId(req("1")) === null, 'legado "1" deveria continuar recusado');
});

t("4. TOKEN ASSINADO (formato do cutover) -> null", () => {
  // Formato real: base64url(payload) + "." + base64url(assinatura).
  // O mecanismo V1 NÃO entende isto — e não deve mesmo entender.
  const token =
    "eyJ2IjoxLCJ1aWQiOiJkMzVlYmI3OS1mMzdmLTRhNDItYjdhMi1iYTE5ODZjNmQ2MDAiLCJpYXQiOjE4MDAwMDAwMDAsImV4cCI6MTgwMDYwNDgwMH0" +
    ".YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU2Nzg5YWJjZGVm";
  assert(getUserId(req(token)) === null, "token assinado NÃO pode virar user_id");
});

t("5. texto aleatório -> null", () => {
  for (const lixo of ["abc", "admin", "null", "undefined", "0", "true", "../../etc/passwd", "'; DROP TABLE"]) {
    assert(getUserId(req(lixo)) === null, `texto aleatório aceito: ${lixo}`);
  }
});

t("6. UUID incompleto -> null", () => {
  for (const parcial of [
    "d35ebb79-f37f-4a42-b7a2",
    "d35ebb79-f37f-4a42-b7a2-ba1986c6d60",
    "d35ebb79f37f4a42b7a2ba1986c6d600",
    "d35ebb79-f37f-4a42-ba1986c6d600",
  ]) {
    assert(getUserId(req(parcial)) === null, `UUID incompleto aceito: ${parcial}`);
  }
});

t("7. UUID com caracteres extras -> null", () => {
  for (const extra of [
    `${UID}x`,
    `x${UID}`,
    `${UID}${UID}`,
    "d35ebb79-f37f-4a42-b7a2-ba1986c6d60g", // 'g' não é hex
  ]) {
    assert(getUserId(req(extra)) === null, `UUID com extra aceito: ${JSON.stringify(extra)}`);
  }
});

t("7b. espaço em volta do UUID, do jeito que ele REALMENTE chega", () => {
  // A API `Headers` apara espaço nas pontas do header inteiro, então
  // `cds_session=<uuid> ` sozinho nunca chega com o espaço. Ele chega
  // quando existe outro cookie depois — aí o split("; ") do parser deixa
  // o espaço grudado no valor. É este caso que precisa ser recusado.
  const comEspacoAntesDoPontoEVirgula = new Request("https://exemplo.test/x", {
    headers: { cookie: `cds_session=${UID} ; outro=1` },
  });
  assert(getUserId(comEspacoAntesDoPontoEVirgula) === null,
    "UUID com espaço grudado deveria ser recusado");

  const comEspacoDepoisDoIgual = new Request("https://exemplo.test/x", {
    headers: { cookie: `outro=1; cds_session= ${UID}` },
  });
  assert(getUserId(comEspacoDepoisDoIgual) === null,
    "UUID com espaço à frente deveria ser recusado");
});

t("8. cookie presente e vazio -> null", () => {
  assert(getUserId(req("")) === null, "cookie vazio deveria ser null");
});

console.log("\n[3. robustez]");

t("9. nunca lança, para qualquer entrada que o protocolo permita", () => {
  // Só valores que a API `Headers` aceita — os demais são recusados pela
  // própria plataforma antes de chegarem a este código.
  const entradas = ["", "=", ";;;", "%%%", "a".repeat(10_000), "cds_session=", UID];
  for (const v of entradas) {
    try { getUserId(req(v)); }
    catch (e: any) { throw new Error(`lançou para ${JSON.stringify(v.slice(0, 20))}: ${e?.message}`); }
  }
  try {
    getUserId(new Request("https://exemplo.test/x", { headers: { cookie: "a=1;;b=2; cds_session=; c=3" } }));
  } catch (e: any) {
    throw new Error(`lançou para header composto: ${e?.message}`);
  }
});

t("10. header de cookie ausente por completo -> null", () => {
  assert(getUserId(new Request("https://exemplo.test/x")) === null, "sem header deveria ser null");
});

t("11. NÃO existe caminho que aceite algo além de UUID", () => {
  // Trava de desenho: se alguém acrescentar uma segunda forma de aceitar
  // sessão neste arquivo, este teste é o que reclama.
  const aceitos = ["", "1", "abc", "token.assinado", `${UID}x`, "null"]
    .filter(v => getUserId(req(v)) !== null);
  assert(aceitos.length === 0, `aceitou formato indevido: ${aceitos.join(", ")}`);
});

console.log(`\n=== RESULTADO: ${ok} passaram, ${falhou} falharam ===\n`);
if (falhou > 0) process.exit(1);
