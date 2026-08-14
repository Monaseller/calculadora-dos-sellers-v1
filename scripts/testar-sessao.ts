/**
 * Sessão assinada — testes de F0.c.1.
 *
 * ── O que estes testes provam, e o que NÃO provam ───────────────────
 * PROVAM: o formato do token, a verificação HMAC, a rejeição de
 * adulteração, a validação estrita do payload, o comportamento de
 * expiração em instantes exatos, e que o módulo roda no Node deste
 * projeto.
 *
 * NÃO PROVAM: comportamento no runtime Edge do middleware. Isso não é
 * testável aqui — o que este arquivo verifica é a condição NECESSÁRIA
 * (o módulo não referencia nenhuma API exclusiva de Node). A prova
 * suficiente só vem quando o middleware importar o módulo, em F0.c.3.
 *
 * Nenhum segredo real é usado: as chaves abaixo são constantes de teste,
 * escritas no arquivo de propósito. Nenhum acesso a rede, banco ou env.
 *
 * Uso: npx tsx scripts/testar-sessao.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  assinarSessao,
  verificarSessao,
  ErroConfiguracaoSessao,
  VERSAO_SESSAO,
  DURACAO_PADRAO_SEGUNDOS,
  DURACAO_MAXIMA_SEGUNDOS,
  SEGREDO_MINIMO_BYTES,
  TAMANHO_MAXIMO_TOKEN,
} from "../lib/sessao-assinada";

let ok = 0, falhou = 0;
const pendentes: Promise<void>[] = [];

function t(nome: string, fn: () => void | Promise<void>) {
  const p = (async () => {
    try { await fn(); ok++; console.log(`  PASS  ${nome}`); }
    catch (e: any) { falhou++; console.log(`  FALHA ${nome} -> ${e?.message ?? e}`); }
  })();
  pendentes.push(p);
  return p;
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

// ── Constantes de teste (NUNCA segredos reais) ───────────────────────
const SEGREDO = "segredo-de-teste-com-32-bytes-ok!!";           // 34 bytes
const SEGREDO_OUTRO = "outro-segredo-de-teste-com-32b!!!!";     // 34 bytes
const UID = "3f7a1c2e-9b4d-4c6a-8e1f-2d5b7a9c0e34";
const AGORA = 1_800_000_000; // instante fixo — nenhum teste lê o relógio

/** Assina um payload ARBITRÁRIO com a chave de teste, imitando quem tem o segredo. */
async function assinarBruto(payloadJson: string, segredo = SEGREDO): Promise<string> {
  const enc = new TextEncoder();
  const b64 = (b: Uint8Array) => {
    let s = ""; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const payloadB64 = b64(enc.encode(payloadJson));
  const chave = await crypto.subtle.importKey("raw", enc.encode(segredo), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", chave, enc.encode(payloadB64));
  return `${payloadB64}.${b64(new Uint8Array(sig))}`;
}

const v = (token: unknown, agora = AGORA) => verificarSessao(token, { segredo: SEGREDO, agoraSegundos: agora });

async function main() {
console.log("\n[1. caminho feliz — assinar e verificar]");

t("1. assina um token válido", async () => {
  const tk = await assinarSessao(UID, { segredo: SEGREDO, agoraSegundos: AGORA });
  assert(typeof tk === "string" && tk.length > 0, "token vazio");
  assert(tk.split(".").length === 2, "formato deveria ser payload.assinatura");
  assert(tk.length <= TAMANHO_MAXIMO_TOKEN, `token acima do teto: ${tk.length}`);
});

t("2. verifica um token recém-assinado", async () => {
  const tk = await assinarSessao(UID, { segredo: SEGREDO, agoraSegundos: AGORA });
  assert((await v(tk)) !== null, "token válido foi recusado");
});

t("3. uid é preservado", async () => {
  const s = await v(await assinarSessao(UID, { segredo: SEGREDO, agoraSegundos: AGORA }));
  assert(s?.uid === UID, `uid divergente: ${s?.uid}`);
});

t("4. iat é preservado", async () => {
  const s = await v(await assinarSessao(UID, { segredo: SEGREDO, agoraSegundos: AGORA }));
  assert(s?.iat === AGORA, `iat divergente: ${s?.iat}`);
});

t("5. exp = iat + duração", async () => {
  const s = await v(await assinarSessao(UID, { segredo: SEGREDO, agoraSegundos: AGORA }));
  assert(s?.exp === AGORA + DURACAO_PADRAO_SEGUNDOS, `exp divergente: ${s?.exp}`);
});

t("6. versão é preservada", async () => {
  const s = await v(await assinarSessao(UID, { segredo: SEGREDO, agoraSegundos: AGORA }));
  assert(s?.v === VERSAO_SESSAO, `versao divergente: ${s?.v}`);
});

console.log("\n[2. adulteração]");

t("7. payload adulterado (1 caractere) -> null", async () => {
  const tk = await assinarSessao(UID, { segredo: SEGREDO, agoraSegundos: AGORA });
  const [p, s] = tk.split(".");
  const trocado = (p[5] === "A" ? "B" : "A");
  assert((await v(`${p.slice(0, 5)}${trocado}${p.slice(6)}.${s}`)) === null, "payload adulterado passou");
});

t("8. assinatura adulterada (1 caractere) -> null", async () => {
  const tk = await assinarSessao(UID, { segredo: SEGREDO, agoraSegundos: AGORA });
  const [p, s] = tk.split(".");
  const trocado = (s[0] === "A" ? "B" : "A");
  assert((await v(`${p}.${trocado}${s.slice(1)}`)) === null, "assinatura adulterada passou");
});

t("9. uid trocado no payload (com assinatura antiga) -> null", async () => {
  // Este é o teste que representa a vulnerabilidade V1: hoje trocar o
  // UUID no cookie autentica como outro usuário.
  const tk = await assinarSessao(UID, { segredo: SEGREDO, agoraSegundos: AGORA });
  const assinatura = tk.split(".")[1];
  const outroPayload = await assinarBruto(
    `{"v":1,"uid":"00000000-0000-4000-8000-000000000000","iat":${AGORA},"exp":${AGORA + 60}}`
  );
  const forjado = `${outroPayload.split(".")[0]}.${assinatura}`;
  assert((await v(forjado)) === null, "uid trocado foi aceito");
});

t("10. token assinado com OUTRO segredo -> null", async () => {
  const tk = await assinarSessao(UID, { segredo: SEGREDO_OUTRO, agoraSegundos: AGORA });
  assert((await v(tk)) === null, "token de outro segredo foi aceito");
});

console.log("\n[3. expiração — instantes exatos]");

t("11. token expirado (1s depois de exp) -> null", async () => {
  const tk = await assinarSessao(UID, { segredo: SEGREDO, agoraSegundos: AGORA, duracaoSegundos: 60 });
  assert((await v(tk, AGORA + 61)) === null, "token expirado foi aceito");
});

t("12. no instante EXATO de exp -> INVÁLIDO (exp é exclusivo)", async () => {
  const tk = await assinarSessao(UID, { segredo: SEGREDO, agoraSegundos: AGORA, duracaoSegundos: 60 });
  assert((await v(tk, AGORA + 60)) === null, "no instante exp o token deveria estar expirado");
});

t("36. 1 segundo ANTES de exp -> válido", async () => {
  const tk = await assinarSessao(UID, { segredo: SEGREDO, agoraSegundos: AGORA, duracaoSegundos: 60 });
  assert((await v(tk, AGORA + 59)) !== null, "1s antes de exp deveria valer");
});

t("13. exp == iat (assinado corretamente) -> rejeitado", async () => {
  const tk = await assinarBruto(`{"v":1,"uid":"${UID}","iat":${AGORA},"exp":${AGORA}}`);
  assert((await v(tk)) === null, "exp == iat foi aceito");
});

t("14. exp < iat (assinado corretamente) -> rejeitado", async () => {
  const tk = await assinarBruto(`{"v":1,"uid":"${UID}","iat":${AGORA},"exp":${AGORA - 10}}`);
  assert((await v(tk)) === null, "exp < iat foi aceito");
});

t("15. duração acima do máximo (assinado) -> rejeitado na VERIFICAÇÃO", async () => {
  const tk = await assinarBruto(
    `{"v":1,"uid":"${UID}","iat":${AGORA},"exp":${AGORA + DURACAO_MAXIMA_SEGUNDOS + 1}}`
  );
  assert((await v(tk)) === null, "duração acima do teto foi aceita");
});

t("15b. assinar com duração acima do máximo -> lança", async () => {
  let lancou = false;
  try {
    await assinarSessao(UID, { segredo: SEGREDO, agoraSegundos: AGORA, duracaoSegundos: DURACAO_MAXIMA_SEGUNDOS + 1 });
  } catch (e) { lancou = e instanceof ErroConfiguracaoSessao; }
  assert(lancou, "deveria lançar ErroConfiguracaoSessao");
});

console.log("\n[4. payload estrito]");

t("16. uid que não é UUID (assinado) -> rejeitado", async () => {
  for (const mau of ["nao-e-uuid", "", "3f7a1c2e9b4d4c6a8e1f2d5b7a9c0e34", "../etc/passwd"]) {
    const tk = await assinarBruto(`{"v":1,"uid":${JSON.stringify(mau)},"iat":${AGORA},"exp":${AGORA + 60}}`);
    assert((await v(tk)) === null, `uid inválido aceito: ${mau}`);
  }
});

t("16b. assinar com uid inválido -> lança", async () => {
  let lancou = false;
  try { await assinarSessao("nao-e-uuid", { segredo: SEGREDO, agoraSegundos: AGORA }); }
  catch (e) { lancou = e instanceof ErroConfiguracaoSessao; }
  assert(lancou, "deveria lançar ErroConfiguracaoSessao");
});

t("17. payload sem uid -> rejeitado", async () => {
  assert((await v(await assinarBruto(`{"v":1,"iat":${AGORA},"exp":${AGORA + 60}}`))) === null, "aceitou sem uid");
});

t("18. payload sem iat -> rejeitado", async () => {
  assert((await v(await assinarBruto(`{"v":1,"uid":"${UID}","exp":${AGORA + 60}}`))) === null, "aceitou sem iat");
});

t("19. payload sem exp -> rejeitado", async () => {
  assert((await v(await assinarBruto(`{"v":1,"uid":"${UID}","iat":${AGORA}}`))) === null, "aceitou sem exp");
});

t("20. payload sem versão -> rejeitado", async () => {
  assert((await v(await assinarBruto(`{"uid":"${UID}","iat":${AGORA},"exp":${AGORA + 60}}`))) === null, "aceitou sem v");
});

t("21. versão desconhecida -> rejeitado", async () => {
  for (const versao of ["2", "0", '"1"', "null"]) {
    const tk = await assinarBruto(`{"v":${versao},"uid":"${UID}","iat":${AGORA},"exp":${AGORA + 60}}`);
    assert((await v(tk)) === null, `versao aceita indevidamente: ${versao}`);
  }
});

t("29. tipos errados no payload -> rejeitados", async () => {
  const casos = [
    `{"v":1,"uid":123,"iat":${AGORA},"exp":${AGORA + 60}}`,
    `{"v":1,"uid":"${UID}","iat":"${AGORA}","exp":${AGORA + 60}}`,
    `{"v":1,"uid":"${UID}","iat":${AGORA},"exp":"${AGORA + 60}"}`,
    `{"v":1,"uid":"${UID}","iat":${AGORA}.5,"exp":${AGORA + 60}}`,
    `{"v":1,"uid":"${UID}","iat":-1,"exp":${AGORA + 60}}`,
    `{"v":1,"uid":"${UID}","iat":0,"exp":${AGORA + 60}}`,
    `{"v":1,"uid":"${UID}","iat":${AGORA},"exp":1e400}`,           // Infinity ao parsear
    `{"v":1,"uid":"${UID}","iat":${AGORA},"exp":9007199254740993}`, // acima de MAX_SAFE_INTEGER
    `{"v":1,"uid":null,"iat":${AGORA},"exp":${AGORA + 60}}`,
    `[1,2,3]`,
    `"texto"`,
    `null`,
    `42`,
  ];
  for (const json of casos) {
    assert((await v(await assinarBruto(json))) === null, `payload aceito indevidamente: ${json}`);
  }
});

t("30. campo EXTRA no payload -> rejeitado (parser estrito)", async () => {
  const tk = await assinarBruto(`{"v":1,"uid":"${UID}","iat":${AGORA},"exp":${AGORA + 60},"admin":true}`);
  assert((await v(tk)) === null, "campo extra foi aceito — parser permissivo demais");
});

t("30b. campo duplicado no JSON -> não vira privilégio", async () => {
  // JSON.parse mantém a ÚLTIMA ocorrência; o teste garante que isso não
  // abre caminho para contrabandear um uid diferente.
  const tk = await assinarBruto(
    `{"v":1,"uid":"${UID}","iat":${AGORA},"exp":${AGORA + 60},"uid":"00000000-0000-4000-8000-000000000000"}`
  );
  const s = await v(tk);
  assert(s === null || s.uid !== UID, "duplicidade de chave produziu resultado ambíguo");
});

console.log("\n[5. entrada hostil e malformada]");

t("22. string vazia -> null", async () => { assert((await v("")) === null, "aceitou string vazia"); });

t("23. token sem ponto -> null", async () => {
  assert((await v("semponto")) === null, "aceitou token sem separador");
});

t("24. pontos demais -> null", async () => {
  const tk = await assinarSessao(UID, { segredo: SEGREDO, agoraSegundos: AGORA });
  assert((await v(`${tk}.extra`)) === null, "aceitou token com 3 partes");
  assert((await v("a.b.c")) === null, "aceitou token com 3 partes");
});

t("25. base64url inválido -> null", async () => {
  for (const mau of ["!!!.###", "a+b/c.d", "áéí.óú", "  .  "]) {
    assert((await v(mau)) === null, `aceitou base64 inválido: ${mau}`);
  }
});

t("26. JSON inválido (assinado corretamente) -> null", async () => {
  for (const lixo of ["{isso nao e json", "", "{", "undefined"]) {
    assert((await v(await assinarBruto(lixo))) === null, `aceitou JSON inválido: ${lixo}`);
  }
});

t("27. assinatura vazia -> null", async () => {
  const tk = await assinarSessao(UID, { segredo: SEGREDO, agoraSegundos: AGORA });
  assert((await v(`${tk.split(".")[0]}.`)) === null, "aceitou assinatura vazia");
});

t("28. assinatura truncada ou inflada -> null", async () => {
  const tk = await assinarSessao(UID, { segredo: SEGREDO, agoraSegundos: AGORA });
  const [p, s] = tk.split(".");
  assert((await v(`${p}.${s.slice(0, 20)}`)) === null, "aceitou assinatura truncada");
  assert((await v(`${p}.${s}${s}`)) === null, "aceitou assinatura inflada");
});

t("31. token gigante -> rejeitado de forma controlada", async () => {
  const gigante = "a".repeat(TAMANHO_MAXIMO_TOKEN + 1) + "." + "b".repeat(100);
  const inicio = Date.now();
  assert((await v(gigante)) === null, "aceitou token acima do teto");
  assert((await v("a".repeat(5_000_000) + ".b")) === null, "aceitou token de 5MB");
  assert(Date.now() - inicio < 2000, "rejeição de token gigante demorou demais");
});

t("31b. tipos não-string em token -> null", async () => {
  for (const mau of [null, undefined, 42, {}, [], true]) {
    assert((await v(mau as unknown)) === null, `aceitou token não-string: ${String(mau)}`);
  }
});

console.log("\n[6. segredo — erro de configuração, não entrada de usuário]");

t("32. segredo vazio -> lança (assinar e verificar)", async () => {
  for (const fn of [
    () => assinarSessao(UID, { segredo: "", agoraSegundos: AGORA }),
    () => verificarSessao("qualquer.coisa", { segredo: "", agoraSegundos: AGORA }),
  ]) {
    let lancou = false;
    try { await fn(); } catch (e) { lancou = e instanceof ErroConfiguracaoSessao; }
    assert(lancou, "segredo vazio deveria lançar ErroConfiguracaoSessao");
  }
});

t("33. segredo abaixo do mínimo -> lança", async () => {
  const curto = "a".repeat(SEGREDO_MINIMO_BYTES - 1);
  let lancou = false;
  try { await assinarSessao(UID, { segredo: curto, agoraSegundos: AGORA }); }
  catch (e) { lancou = e instanceof ErroConfiguracaoSessao; }
  assert(lancou, "segredo curto deveria lançar");
});

t("33b. segredo exatamente no mínimo -> aceito", async () => {
  const minimo = "b".repeat(SEGREDO_MINIMO_BYTES);
  const tk = await assinarSessao(UID, { segredo: minimo, agoraSegundos: AGORA });
  assert((await verificarSessao(tk, { segredo: minimo, agoraSegundos: AGORA })) !== null, "mínimo recusado");
});

t("33c. mensagem de erro não contém o segredo", async () => {
  const curto = "SEGREDO-CURTO-SECRETO";
  try { await assinarSessao(UID, { segredo: curto, agoraSegundos: AGORA }); }
  catch (e: any) { assert(!String(e.message).includes(curto), "mensagem de erro vazou o segredo"); }
});

console.log("\n[7. propriedades da assinatura]");

t("34. assinatura de um token não valida outro token", async () => {
  const a = await assinarSessao(UID, { segredo: SEGREDO, agoraSegundos: AGORA });
  const b = await assinarSessao(UID, { segredo: SEGREDO, agoraSegundos: AGORA + 1 });
  const cruzado = `${b.split(".")[0]}.${a.split(".")[1]}`;
  assert((await v(cruzado)) === null, "assinatura cruzada foi aceita");
});

t("35. mesmo payload + mesmo segredo -> assinatura idêntica (determinismo)", async () => {
  const a = await assinarSessao(UID, { segredo: SEGREDO, agoraSegundos: AGORA });
  const b = await assinarSessao(UID, { segredo: SEGREDO, agoraSegundos: AGORA });
  assert(a === b, "assinatura não determinística");
});

t("35b. agoraSegundos inválido -> lança nas duas funções", async () => {
  for (const mau of [0, -1, 1.5, NaN, Infinity]) {
    let l1 = false, l2 = false;
    try { await assinarSessao(UID, { segredo: SEGREDO, agoraSegundos: mau }); } catch (e) { l1 = e instanceof ErroConfiguracaoSessao; }
    try { await verificarSessao("a.b", { segredo: SEGREDO, agoraSegundos: mau }); } catch (e) { l2 = e instanceof ErroConfiguracaoSessao; }
    assert(l1 && l2, `agoraSegundos=${mau} deveria lançar nas duas`);
  }
});

console.log("\n[8. runtime — o que foi realmente verificado]");

t("39. executou no Node deste projeto usando globalThis.crypto.subtle", () => {
  assert(typeof globalThis.crypto?.subtle?.sign === "function", "crypto.subtle indisponível");
  console.log(`        node=${process.versions.node} · subtle=disponível · assinaturas acima produzidas por ele`);
});

t("40. o CÓDIGO do módulo não referencia API exclusiva de Node (condição necessária p/ Edge)", () => {
  // Condição NECESSÁRIA, não suficiente. A prova suficiente é o
  // middleware importar o módulo em F0.c.3 e rodar no Edge.
  //
  // Comentários são removidos antes da varredura: a primeira versão
  // deste teste reprovou o módulo porque a palavra "Buffer" aparecia
  // num comentário explicando que Buffer NÃO é usado. O teste tem de
  // afirmar algo sobre o código, não sobre a prosa.
  const bruto = fs.readFileSync(path.join(process.cwd(), "lib", "sessao-assinada.ts"), "utf8");
  const codigo = bruto.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  for (const proibido of ['from "node:', "require(", "Buffer", "process.env"]) {
    assert(!codigo.includes(proibido), `módulo referencia API não-Edge: ${proibido}`);
  }
  // E confirma que a via criptográfica usada é mesmo a Web Crypto.
  assert(codigo.includes("globalThis.crypto?.subtle"), "módulo não usa globalThis.crypto.subtle");
});

t("41. o módulo só é importado pela camada de autenticação, que também não está em uso", () => {
  // Garantia de que nada em produção depende deste módulo.
  //
  // Ajustado em F0.c.2: `lib/autenticacao.ts` passou a importá-lo, o que
  // é o desenho pretendido — aquela camada é que faz a ponte com o
  // Request. Que ELA também não esteja em uso é garantido pelo teste 22
  // de `scripts/testar-autenticacao.ts`.
  const permitidos = [
    path.join("lib", "sessao-assinada.ts"),
    path.join("lib", "autenticacao.ts"),
    path.join("scripts", "testar-sessao.ts"),
    path.join("scripts", "testar-autenticacao.ts"),
  ];
  const alvos: string[] = [];
  const varrer = (dir: string) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) { if (!["node_modules", ".next", ".git"].includes(d.name)) varrer(p); }
      else if (/\.tsx?$/.test(d.name)) alvos.push(p);
    }
  };
  varrer(process.cwd());
  const importadores = alvos.filter(f =>
    !permitidos.some(p => f.endsWith(p)) &&
    /sessao-assinada/.test(fs.readFileSync(f, "utf8"))
  );
  assert(importadores.length === 0, `módulo importado fora da camada prevista: ${importadores.join(", ")}`);
});

  await Promise.all(pendentes);
  console.log(`\n=== RESULTADO: ${ok} passaram, ${falhou} falharam ===\n`);
  if (falhou > 0) process.exit(1);
}

void main();
