/**
 * `state` assinado do OAuth Mercado Livre — F0.c.6c.
 *
 * Módulo puro: sem rede, sem banco, sem env, sem relógio próprio. Todos
 * os instantes são passados como parâmetro, então "exatamente no segundo
 * de exp" é um teste determinístico, não uma adivinhação.
 *
 * Uso: npx tsx scripts/testar-estado-oauth.ts
 */
import {
  assinarEstado,
  verificarEstado,
  ErroConfiguracaoEstado,
  VERSAO_ESTADO,
  CONTEXTO_ASSINATURA,
  TTL_PADRAO_SEGUNDOS,
  TTL_MAXIMO_SEGUNDOS,
  TAMANHO_MAXIMO_ESTADO,
} from "../lib/estado-oauth";
import { assinarSessao } from "../lib/sessao-assinada";

let ok = 0, falhou = 0;
let fila: Promise<void> = Promise.resolve();
const imprimir = console.log.bind(console);
function t(nome: string, fn: () => void | Promise<void>) {
  fila = fila.then(async () => {
    try { await fn(); ok++; imprimir(`  PASS  ${nome}`); }
    catch (e: any) { falhou++; imprimir(`  FALHA ${nome} -> ${e?.message ?? e}`); }
  });
}
function secao(titulo: string) { fila = fila.then(() => { imprimir(titulo); }); }
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

const SEGREDO = "segredo-de-teste-com-mais-de-32-bytes-000000";
const OUTRO_SEGREDO = "outro-segredo-de-teste-com-mais-de-32-bytes";
const UID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTRO_UID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LOJA = "11111111-1111-4111-8111-111111111111";
const AGORA = 1_800_000_000;

const assinar = (dados: any, agora = AGORA, ttl?: number) =>
  assinarEstado(UID, dados, { segredo: SEGREDO, agoraSegundos: agora, ttlSegundos: ttl });
const verificar = (estado: unknown, agora = AGORA, segredo = SEGREDO) =>
  verificarEstado(estado, { segredo, agoraSegundos: agora });

/** Reescreve o payload de um state mantendo a assinatura original. */
function trocarPayload(estado: string, novoPayloadJson: string): string {
  const assinatura = estado.split(".")[1];
  const b64 = Buffer.from(novoPayloadJson, "utf8").toString("base64url");
  return `${b64}.${assinatura}`;
}

async function principal() {
  secao("\n[1. caminho feliz]");

  t("1. connect: assina e verifica", async () => {
    const s = await assinar({ intent: "connect" });
    const v = await verificar(s);
    assert(v !== null, "não verificou");
    assert(v!.intent === "connect" && v!.uid === UID, `payload errado: ${JSON.stringify(v)}`);
    assert(v!.v === VERSAO_ESTADO, "versão errada");
    assert(v!.exp - v!.iat === TTL_PADRAO_SEGUNDOS, "TTL padrão não aplicado");
  });

  t("2. reconnect: carrega a loja", async () => {
    const s = await assinar({ intent: "reconnect", loja: LOJA });
    const v = await verificar(s);
    assert(v !== null && v.intent === "reconnect", "não verificou como reconnect");
    assert((v as any).loja === LOJA, "loja não sobreviveu");
  });

  t("3. formato: duas partes base64url separadas por ponto", async () => {
    const s = await assinar({ intent: "connect" });
    const partes = s.split(".");
    assert(partes.length === 2, `esperado 2 partes, veio ${partes.length}`);
    assert(/^[A-Za-z0-9_-]+$/.test(partes[0]) && /^[A-Za-z0-9_-]+$/.test(partes[1]),
      "partes não são base64url");
    assert(s.length <= TAMANHO_MAXIMO_ESTADO, `state maior que o teto: ${s.length}`);
  });

  t("4. o state NÃO contém o segredo", async () => {
    const s = await assinar({ intent: "reconnect", loja: LOJA });
    assert(!s.includes(SEGREDO), "🔴 segredo embutido no state");
  });

  secao("\n[2. assinatura]");

  t("5. payload adulterado -> null", async () => {
    const s = await assinar({ intent: "connect" });
    const forjado = trocarPayload(s,
      `{"v":1,"uid":"${OUTRO_UID}","intent":"connect","iat":${AGORA},"exp":${AGORA + 600}}`);
    assert(await verificar(forjado) === null, "🔴 payload trocado foi aceito");
  });

  t("6. assinatura adulterada -> null", async () => {
    const s = await assinar({ intent: "connect" });
    const [p, a] = s.split(".");
    const trocado = a[0] === "A" ? "B" + a.slice(1) : "A" + a.slice(1);
    assert(await verificar(`${p}.${trocado}`) === null, "🔴 assinatura adulterada foi aceita");
  });

  t("7. assinado com OUTRO segredo -> null", async () => {
    const s = await assinarEstado(UID, { intent: "connect" },
      { segredo: OUTRO_SEGREDO, agoraSegundos: AGORA });
    assert(await verificar(s) === null, "🔴 aceitou state de outro segredo");
  });

  t("8. assinatura truncada ou inflada -> null", async () => {
    const s = await assinar({ intent: "connect" });
    const [p, a] = s.split(".");
    assert(await verificar(`${p}.${a.slice(0, -4)}`) === null, "aceitou assinatura truncada");
    assert(await verificar(`${p}.${a}AAAA`) === null, "aceitou assinatura inflada");
  });

  t("9. lixo estrutural -> null, sem estourar", async () => {
    for (const mau of ["", ".", "a.b.c", "semponto", "..", "@@@.@@@", "null"]) {
      assert(await verificar(mau) === null, `aceitou "${mau}"`);
    }
    assert(await verificar(null) === null, "aceitou null");
    assert(await verificar(undefined) === null, "aceitou undefined");
    assert(await verificar(12345) === null, "aceitou número");
    assert(await verificar({}) === null, "aceitou objeto");
  });

  t("10. state gigante é descartado antes de decodificar", async () => {
    assert(await verificar("A".repeat(TAMANHO_MAXIMO_ESTADO + 1) + ".AAAA") === null,
      "aceitou state acima do teto");
  });

  secao("\n[3. SEPARAÇÃO DE DOMÍNIO — o ponto do segredo compartilhado]");

  t("11. um TOKEN DE SESSÃO não passa como state", async () => {
    // Mesma chave, mesmo formato de duas partes. Só o contexto da
    // assinatura separa um do outro.
    const sessao = await assinarSessao(UID, { segredo: SEGREDO, agoraSegundos: AGORA });
    assert(await verificar(sessao) === null, "🔴 token de sessão aceito como state do OAuth");
  });

  t("12. um state não passa como token de sessão", async () => {
    const { verificarSessao } = await import("../lib/sessao-assinada");
    const s = await assinar({ intent: "connect" });
    const v = await verificarSessao(s, { segredo: SEGREDO, agoraSegundos: AGORA });
    assert(v === null, "🔴 state do OAuth aceito como sessão");
  });

  t("13. assinar SEM o contexto não produz state válido", async () => {
    // Reproduz exatamente o que um assinador ingênuo faria: HMAC só do
    // payload. Se isto passasse, a separação de domínio seria decorativa.
    const { createHmac } = await import("node:crypto");
    const payload = `{"v":1,"uid":"${UID}","intent":"connect","iat":${AGORA},"exp":${AGORA + 600}}`;
    const p64 = Buffer.from(payload, "utf8").toString("base64url");
    const semContexto = createHmac("sha256", SEGREDO).update(p64).digest("base64url");
    assert(await verificar(`${p64}.${semContexto}`) === null,
      "🔴 assinatura sem separação de domínio foi aceita");
    // E, como controle, COM o contexto o mesmo payload passa.
    const comContexto = createHmac("sha256", SEGREDO).update(CONTEXTO_ASSINATURA + p64).digest("base64url");
    assert(await verificar(`${p64}.${comContexto}`) !== null,
      "o teste não estaria provando nada: nem com contexto passou");
  });

  secao("\n[4. expiração]");

  t("14. um segundo antes de exp: válido", async () => {
    const s = await assinar({ intent: "connect" });
    assert(await verificar(s, AGORA + TTL_PADRAO_SEGUNDOS - 1) !== null, "expirou cedo demais");
  });

  t("15. exatamente em exp: EXPIRADO (exp é exclusivo)", async () => {
    const s = await assinar({ intent: "connect" });
    assert(await verificar(s, AGORA + TTL_PADRAO_SEGUNDOS) === null, "aceitou no instante de exp");
  });

  t("16. depois de exp: expirado", async () => {
    const s = await assinar({ intent: "connect" });
    assert(await verificar(s, AGORA + TTL_PADRAO_SEGUNDOS + 1) === null, "aceitou expirado");
  });

  t("17. TTL acima do teto é recusado na ASSINATURA", async () => {
    let lancou = false;
    try { await assinar({ intent: "connect" }, AGORA, TTL_MAXIMO_SEGUNDOS + 1); }
    catch (e) { lancou = e instanceof ErroConfiguracaoEstado; }
    assert(lancou, "assinou TTL acima do teto");
  });

  t("18. TTL acima do teto é recusado também na VERIFICAÇÃO", async () => {
    // Defesa contra um emissor futuro com bug: mesmo bem assinado, um
    // state de duração absurda não vale.
    const { createHmac } = await import("node:crypto");
    const exp = AGORA + TTL_MAXIMO_SEGUNDOS + 3600;
    const payload = `{"v":1,"uid":"${UID}","intent":"connect","iat":${AGORA},"exp":${exp}}`;
    const p64 = Buffer.from(payload, "utf8").toString("base64url");
    const sig = createHmac("sha256", SEGREDO).update(CONTEXTO_ASSINATURA + p64).digest("base64url");
    assert(await verificar(`${p64}.${sig}`) === null, "🔴 aceitou state de duração acima do teto");
  });

  secao("\n[5. parser estrito]");

  const forjar = async (payload: string) => {
    const { createHmac } = await import("node:crypto");
    const p64 = Buffer.from(payload, "utf8").toString("base64url");
    const sig = createHmac("sha256", SEGREDO).update(CONTEXTO_ASSINATURA + p64).digest("base64url");
    return `${p64}.${sig}`;
  };

  t("19. campo EXTRA derruba o state, mesmo bem assinado", async () => {
    const s = await forjar(`{"v":1,"uid":"${UID}","intent":"connect","iat":${AGORA},"exp":${AGORA + 600},"admin":true}`);
    assert(await verificar(s) === null, "🔴 campo extra aceito");
  });

  t("20. CONNECT com loja -> rejeitado", async () => {
    const s = await forjar(`{"v":1,"uid":"${UID}","intent":"connect","loja":"${LOJA}","iat":${AGORA},"exp":${AGORA + 600}}`);
    assert(await verificar(s) === null, "🔴 connect com loja aceito");
  });

  t("21. RECONNECT sem loja -> rejeitado", async () => {
    const s = await forjar(`{"v":1,"uid":"${UID}","intent":"reconnect","iat":${AGORA},"exp":${AGORA + 600}}`);
    assert(await verificar(s) === null, "🔴 reconnect sem loja aceito");
  });

  t("22. intent desconhecido -> rejeitado", async () => {
    for (const intent of ["delete", "", "CONNECT", "admin"]) {
      const s = await forjar(`{"v":1,"uid":"${UID}","intent":"${intent}","iat":${AGORA},"exp":${AGORA + 600}}`);
      assert(await verificar(s) === null, `intent "${intent}" aceito`);
    }
  });

  t("23. versão diferente -> rejeitado", async () => {
    const s = await forjar(`{"v":2,"uid":"${UID}","intent":"connect","iat":${AGORA},"exp":${AGORA + 600}}`);
    assert(await verificar(s) === null, "🔴 versão desconhecida aceita");
  });

  t("24. uid ou loja fora do formato UUID -> rejeitado", async () => {
    const s1 = await forjar(`{"v":1,"uid":"nao-e-uuid","intent":"connect","iat":${AGORA},"exp":${AGORA + 600}}`);
    assert(await verificar(s1) === null, "uid inválido aceito");
    const s2 = await forjar(`{"v":1,"uid":"${UID}","intent":"reconnect","loja":"x","iat":${AGORA},"exp":${AGORA + 600}}`);
    assert(await verificar(s2) === null, "loja inválida aceita");
  });

  t("25. exp <= iat -> rejeitado", async () => {
    const s = await forjar(`{"v":1,"uid":"${UID}","intent":"connect","iat":${AGORA},"exp":${AGORA}}`);
    assert(await verificar(s) === null, "exp igual a iat aceito");
  });

  t("26. payload que não é objeto -> rejeitado", async () => {
    for (const p of ["[]", '"texto"', "42", "null"]) {
      assert(await verificar(await forjar(p)) === null, `payload ${p} aceito`);
    }
  });

  secao("\n[6. configuração — lança, não devolve null]");

  t("27. segredo curto demais LANÇA na assinatura e na verificação", async () => {
    let l1 = false, l2 = false;
    try { await assinarEstado(UID, { intent: "connect" }, { segredo: "curto", agoraSegundos: AGORA }); }
    catch (e) { l1 = e instanceof ErroConfiguracaoEstado; }
    try { await verificarEstado("a.b", { segredo: "curto", agoraSegundos: AGORA }); }
    catch (e) { l2 = e instanceof ErroConfiguracaoEstado; }
    assert(l1 && l2, "segredo inadequado não lançou (l1=" + l1 + ", l2=" + l2 + ")");
  });

  t("28. a mensagem de erro NUNCA cita o segredo", async () => {
    try {
      await assinarEstado(UID, { intent: "connect" }, { segredo: "curto", agoraSegundos: AGORA });
    } catch (e: any) {
      assert(!String(e.message).includes("curto-"), "mensagem vazou o segredo");
      assert(/32/.test(e.message), "mensagem não informa o mínimo exigido");
    }
  });

  t("29. uid inválido na assinatura LANÇA (erro de programação)", async () => {
    let lancou = false;
    try { await assinarEstado("nao-e-uuid", { intent: "connect" }, { segredo: SEGREDO, agoraSegundos: AGORA }); }
    catch (e) { lancou = e instanceof ErroConfiguracaoEstado; }
    assert(lancou, "assinou com uid inválido");
  });

  t("30. loja inválida em reconnect LANÇA na assinatura", async () => {
    let lancou = false;
    try { await assinarEstado(UID, { intent: "reconnect", loja: "x" } as any, { segredo: SEGREDO, agoraSegundos: AGORA }); }
    catch (e) { lancou = e instanceof ErroConfiguracaoEstado; }
    assert(lancou, "assinou reconnect com loja inválida");
  });

  t("31. o módulo não lê relógio nem ambiente", async () => {
    const fs = await import("node:fs");
    const fonte = fs.readFileSync("lib/estado-oauth.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    assert(!/Date\.now|new Date/.test(fonte), "🔴 o módulo lê o relógio");
    assert(!/process\.env/.test(fonte), "🔴 o módulo lê variável de ambiente");
    assert(!/fetch\s*\(/.test(fonte), "🔴 o módulo faz rede");
  });

  await fila;
  imprimir(`\n=== RESULTADO: ${ok} passaram, ${falhou} falharam ===\n`);
  if (falhou > 0) process.exit(1);
}

void principal();
