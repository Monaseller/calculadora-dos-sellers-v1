/**
 * Meus Produtos migrada para `/api/ml/conexao` — F0.c.5, fase C.
 *
 * ── Três camadas de prova ───────────────────────────────────────────
 * 1. ESTRUTURAL — lê o código-fonte da tela e exige que `/api/auth/status`
 *    e `ml_access_token` não decidam mais conexão ali. Comentários são
 *    removidos antes da varredura: um teste tem de falar sobre o código,
 *    não sobre a prosa que o descreve.
 * 2. FUNÇÕES PURAS — cada estado de `/api/ml/conexao` vira um estado de
 *    tela distinto, e 401/503/LOJA_NAO_DEFINIDA nunca viram "desconectado".
 * 3. ACORDO DE CONTRATO — as respostas são geradas pelo
 *    `montarRespostaConexao` REAL do servidor e passadas pelo
 *    interpretador do cliente. Se os dois lados divergirem, quebra aqui.
 *
 * Sem rede, sem banco, sem React, sem credencial.
 *
 * Uso: npx tsx scripts/testar-conexao-ml-tela.ts
 */
import fs from "node:fs";
import path from "node:path";

let ok = 0, falhou = 0;
function t(nome: string, fn: () => void) {
  try { fn(); ok++; console.log(`  PASS  ${nome}`); }
  catch (e: any) { falhou++; console.log(`  FALHA ${nome} -> ${e?.message ?? e}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

import {
  interpretarConexaoML,
  podeOperarML,
  motivoBloqueioML,
  avisoConexaoML,
  interpretarRetornoOAuthML,
  CONEXAO_ML_CARREGANDO,
  type ConexaoML,
} from "../lib/conexao-ml-cliente";
/**
 * O módulo do SERVIDOR entra só como tipo aqui: `import type` é apagado na
 * compilação. O valor é carregado por `import()` dentro de `principal()`,
 * depois dos placeholders de ambiente — `lib/ml-conexao` importa
 * `lib/ml-auth`, que cria um cliente Supabase já no carregamento e exige
 * URL e chave presentes.
 */
import type { ResultadoContaML } from "../lib/ml-conexao";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder-de-teste.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "chave-de-teste-invalida";

const RAIZ = process.cwd();
const TELA = path.join(RAIZ, "app", "(app)", "anuncios", "page.tsx");

/** Fonte sem comentários — o teste avalia código, não texto explicativo. */
function semComentarios(arquivo: string): string {
  return fs.readFileSync(arquivo, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const CODIGO_TELA = semComentarios(TELA);

console.log("\n[1. a tela deixou de perguntar ao navegador]");

t("1. Meus Produtos NÃO usa mais /api/auth/status", () => {
  assert(!CODIGO_TELA.includes("/api/auth/status"),
    "🔴 a tela voltou a decidir conexão ML por /api/auth/status");
});

t("2. Meus Produtos NÃO lê ml_access_token nem ml_refresh_token", () => {
  assert(!/ml_access_token|ml_refresh_token/.test(CODIGO_TELA),
    "🔴 a tela voltou a olhar cookie de credencial do navegador");
});

t("3. Meus Produtos consulta /api/ml/conexao", () => {
  assert(CODIGO_TELA.includes("/api/ml/conexao"), "a tela não consulta o endpoint novo");
});

t("4. o portão das ações vem de podeOperarML, não de um campo solto", () => {
  assert(/const\s+mlConectado\s*=\s*podeOperarML\(/.test(CODIGO_TELA),
    "mlConectado não é mais derivado de podeOperarML");
  assert(!/setMlConectado/.test(CODIGO_TELA),
    "sobrou o setter booleano antigo — há duas fontes de verdade");
});

t("5. nenhum polling e nenhum timer de refresh foram introduzidos", () => {
  assert(!/setInterval/.test(CODIGO_TELA), "🔴 polling introduzido na tela");
  assert(!/setTimeout/.test(CODIGO_TELA), "🔴 timer introduzido na tela");
});

t("6. nenhuma resposta vai para storage ou cookie novo", () => {
  assert(!/localStorage|sessionStorage/.test(CODIGO_TELA), "🔴 estado de conexão em storage");
  assert(!/document\.cookie\s*=/.test(CODIGO_TELA), "🔴 a tela passou a escrever cookie");
});

t("7. a tela não faz refresh por conta própria", () => {
  assert(!/refresh_token|refreshToken/.test(CODIGO_TELA), "🔴 refresh_token no cliente");
  assert(!/oauth\/token/.test(CODIGO_TELA), "🔴 a tela fala direto com o OAuth do ML");
});

console.log("\n[2. escopo — o que esta fase NÃO podia tocar]");

t("8. /api/auth/status continua existindo", () => {
  assert(fs.existsSync(path.join(RAIZ, "app", "api", "auth", "status", "route.ts")),
    "a rota antiga foi removida — não era escopo da fase C");
});

t("9. Precificação continua usando /api/auth/status, intocada", () => {
  const outra = fs.readFileSync(path.join(RAIZ, "app", "(app)", "precificacao", "page.tsx"), "utf8");
  assert(outra.includes("/api/auth/status"),
    "outro consumidor foi migrado junto — a fase C é só Meus Produtos");
});

t("10. a tela não importa o módulo de servidor lib/ml-conexao", () => {
  // Ele cria cliente Supabase no escopo do módulo: importá-lo de um
  // componente "use client" levaria código de credencial ao navegador.
  assert(!/from\s+["']@\/lib\/ml-conexao["']/.test(CODIGO_TELA),
    "🔴 módulo de servidor importado por componente de cliente");
});

console.log("\n[3. cada estado tem tratamento próprio]");

const CENARIOS: Array<[string, number, unknown, ConexaoML["estado"]]> = [
  ["conectado",            200, { conectado: true,  precisaReconectar: false, loja: { id: "L1", nickname: "Loja", marketplace: "ML" } }, "CONECTADO"],
  ["precisa reconectar",   200, { conectado: false, precisaReconectar: true,  motivo: "PRECISA_RECONECTAR", loja: { id: "L1", nickname: "Loja", marketplace: "ML" } }, "PRECISA_RECONECTAR"],
  ["sem loja",             200, { conectado: false, precisaReconectar: false, motivo: "SEM_LOJA" }, "SEM_LOJA"],
  ["loja não definida",    200, { conectado: false, precisaReconectar: false, motivo: "LOJA_NAO_DEFINIDA", lojas: [] }, "LOJA_NAO_DEFINIDA"],
  ["loja inválida",        200, { conectado: false, precisaReconectar: false, motivo: "LOJA_INVALIDA" }, "LOJA_INVALIDA"],
  ["sessão inválida",      401, { erro: "Não autenticado." }, "ERRO_DE_SESSAO"],
  ["infra fora do ar",     503, { erro: "Não foi possível verificar a conexão." }, "ERRO_DE_INFRAESTRUTURA"],
  ["rede não completou",     0, null, "ERRO_DE_INFRAESTRUTURA"],
  ["corpo ilegível",       200, "isto não é json de objeto", "ERRO_DE_INFRAESTRUTURA"],
  ["motivo desconhecido",  200, { conectado: false, precisaReconectar: false, motivo: "ALGO_NOVO" }, "ERRO_DE_INFRAESTRUTURA"],
];

for (const [nome, status, corpo, esperado] of CENARIOS) {
  t(`11. "${nome}" -> ${esperado}`, () => {
    const c = interpretarConexaoML(status, corpo);
    assert(c.estado === esperado, `veio ${c.estado}`);
  });
}

t("12. 401 NÃO é 'Mercado Livre desconectado'", () => {
  const c = interpretarConexaoML(401, { erro: "Não autenticado." });
  const aviso = avisoConexaoML(c)!;
  assert(c.estado === "ERRO_DE_SESSAO", "estado errado");
  assert(!/desconectad|não conectado/i.test(aviso.titulo + aviso.descricao),
    `🔴 401 apresentado como desconexão: ${aviso.titulo}`);
  assert(aviso.acao?.href === "/login", "não oferece o caminho de volta (login)");
});

t("13. 503 NÃO é 'Mercado Livre desconectado'", () => {
  const c = interpretarConexaoML(503, { erro: "x" });
  const aviso = avisoConexaoML(c)!;
  assert(c.estado === "ERRO_DE_INFRAESTRUTURA", "estado errado");
  assert(!/não conectado/i.test(aviso.titulo), `🔴 503 apresentado como desconexão: ${aviso.titulo}`);
  assert(/não quer dizer que o Mercado Livre está desconectado/i.test(aviso.descricao),
    "não deixa claro que não é desconexão");
});

t("14. LOJA_NAO_DEFINIDA NÃO é 'Mercado Livre desconectado'", () => {
  const c = interpretarConexaoML(200, { conectado: false, precisaReconectar: false, motivo: "LOJA_NAO_DEFINIDA", lojas: [] });
  const aviso = avisoConexaoML(c)!;
  assert(!/desconectad|não conectado/i.test(aviso.titulo + aviso.descricao),
    `🔴 apresentado como desconexão: ${aviso.titulo}`);
  assert(aviso.tom === "info", "tratado com tom de problema, não de escolha pendente");
  assert(!aviso.acao, "oferece OAuth quando o que falta é selecionar loja");
});

t("15. LOJA_INVALIDA não sugere nem executa fallback para outra loja", () => {
  const c = interpretarConexaoML(200, { conectado: false, precisaReconectar: false, motivo: "LOJA_INVALIDA" });
  assert(c.estado === "LOJA_INVALIDA", "estado errado");
  assert(c.loja === undefined && c.lojas === undefined, "🔴 alguma loja veio junto da recusa");
  assert(!podeOperarML(c), "🔴 operaria o ML com loja inválida");
});

t("16. PRECISA_RECONECTAR oferece o OAuth existente, COM a loja (F0.c.6c)", () => {
  const LOJA = "11111111-1111-4111-8111-111111111111";
  const c = interpretarConexaoML(200, { conectado: false, precisaReconectar: true, motivo: "PRECISA_RECONECTAR", loja: { id: LOJA, nickname: "n", marketplace: "ML" } });
  const aviso = avisoConexaoML(c)!;
  assert(!!aviso.acao?.href.startsWith("/api/auth/mercadolivre"), `href inesperado: ${aviso.acao?.href}`);
  // Sem `loja_id` o servidor não sabe QUAL conta reautorizar — com duas
  // lojas, reconectaria a errada.
  assert(aviso.acao!.href.includes(`loja_id=${LOJA}`),
    `🔴 o botão perdeu a identidade da loja: ${aviso.acao!.href}`);
});

t("16b. sem loja identificada, o botão cai no OAuth genérico (connect)", () => {
  const aviso = avisoConexaoML({ estado: "PRECISA_RECONECTAR" })!;
  assert(aviso.acao?.href === "/api/auth/mercadolivre", `href inesperado: ${aviso.acao?.href}`);
});

t("16c. o loja_id vai ESCAPADO na URL", () => {
  const c: ConexaoML = { estado: "PRECISA_RECONECTAR", loja: { id: "a b&c=d", nickname: "", marketplace: "ML" } };
  const href = avisoConexaoML(c)!.acao!.href;
  assert(!/loja_id=a b&c=d/.test(href), `🔴 valor não escapado: ${href}`);
  assert(href.includes("loja_id=a%20b%26c%3Dd"), `escape inesperado: ${href}`);
});

t("17. SEM_LOJA preserva o texto e a ação que a tela já tinha", () => {
  const aviso = avisoConexaoML(interpretarConexaoML(200, { conectado: false, precisaReconectar: false, motivo: "SEM_LOJA" }))!;
  assert(aviso.titulo === "Mercado Livre não conectado", "o texto original mudou sem necessidade");
  assert(aviso.acao?.href === "/api/auth/mercadolivre" && aviso.acao.texto === "Conectar ML",
    "a ação original mudou");
});

console.log("\n[3b. retorno do OAuth em Configurações — F0.c.6e]");

t("17b. códigos de sucesso conhecidos viram mensagem de sucesso", () => {
  for (const [codigo, trecho] of [["connected", "conectado"], ["reconnected", "reconectado"]]) {
    const r = interpretarRetornoOAuthML(new URLSearchParams(`ml=${codigo}`))!;
    assert(r.tom === "sucesso", `${codigo} não é sucesso`);
    assert(r.texto.toLowerCase().includes(trecho), `texto inesperado: ${r.texto}`);
  }
});

t("17c. códigos de erro conhecidos viram mensagem específica e segura", () => {
  const esperados = [
    "oauth_cancelado", "state_expirado", "state_invalido", "sessao_invalida",
    "loja_nao_pertence_usuario", "conta_ml_diferente", "duplicidade_loja",
    "token_exchange_falhou", "identidade_falhou", "persistencia_falhou", "configuracao_invalida",
  ];
  for (const codigo of esperados) {
    const r = interpretarRetornoOAuthML(new URLSearchParams(`ml_erro=${codigo}`))!;
    assert(r.tom === "erro", `${codigo} não é erro`);
    assert(r.texto.length > 10, `${codigo} sem mensagem útil`);
    // O código interno nunca é exibido ao usuário.
    assert(!r.texto.includes(codigo), `🔴 ${codigo}: o código interno vazou para a tela`);
  }
});

t("17d. duplicidade_loja avisa que NADA foi alterado", () => {
  const r = interpretarRetornoOAuthML(new URLSearchParams("ml_erro=duplicidade_loja"))!;
  assert(/nenhuma alteração/i.test(r.texto), `texto não tranquiliza: ${r.texto}`);
});

t("17e. código DESCONHECIDO nunca é refletido na tela", () => {
  const hostis = [
    "<script>alert(1)</script>",
    "javascript:alert(1)",
    "codigo_que_nao_existe",
    "<img src=x onerror=alert(1)>",
  ];
  for (const mau of hostis) {
    const r = interpretarRetornoOAuthML(new URLSearchParams({ ml_erro: mau }))!;
    assert(r.tom === "erro", "deveria ser tratado como erro genérico");
    assert(!r.texto.includes(mau), `🔴 conteúdo da query renderizado: ${r.texto}`);
    assert(!/[<>]/.test(r.texto), `🔴 marcação na mensagem: ${r.texto}`);
  }
});

t("17f. sucesso desconhecido NÃO vira sucesso", () => {
  // Não afirmamos o que não sabemos: `?ml=qualquercoisa` não pode
  // produzir "conectado com sucesso".
  assert(interpretarRetornoOAuthML(new URLSearchParams("ml=inventado")) === null,
    "🔴 código de sucesso desconhecido foi aceito");
});

t("17g. sem parâmetro nenhum -> nada é exibido", () => {
  assert(interpretarRetornoOAuthML(new URLSearchParams("")) === null, "exibiu mensagem sem retorno de OAuth");
  assert(interpretarRetornoOAuthML(new URLSearchParams("outra=coisa")) === null, "reagiu a query alheia");
});

t("17h. nenhuma mensagem cita token, seller ou detalhe do provedor", () => {
  const todos = [
    ...["connected", "reconnected"].map(c => `ml=${c}`),
    ...["oauth_cancelado", "state_expirado", "state_invalido", "sessao_invalida",
        "loja_nao_pertence_usuario", "conta_ml_diferente", "duplicidade_loja",
        "token_exchange_falhou", "identidade_falhou", "persistencia_falhou",
        "configuracao_invalida", "inventado"].map(c => `ml_erro=${c}`),
  ];
  for (const qs of todos) {
    const r = interpretarRetornoOAuthML(new URLSearchParams(qs));
    if (!r) continue;
    assert(!/token|seller|bearer|http \d|supabase|relation/i.test(r.texto),
      `🔴 "${qs}" expõe detalhe interno: ${r.texto}`);
  }
});

console.log("\n[4. ações liberadas e bloqueadas]");

t("18. SOMENTE conectado libera ação no Mercado Livre", () => {
  for (const [nome, status, corpo] of CENARIOS) {
    const c = interpretarConexaoML(status, corpo);
    const esperado = c.estado === "CONECTADO";
    assert(podeOperarML(c) === esperado, `"${nome}" (${c.estado}) liberou ação indevidamente`);
  }
  assert(!podeOperarML(CONEXAO_ML_CARREGANDO), "🔴 age antes de saber o estado");
});

t("19. todo estado bloqueado explica o motivo; conectado não tem bloqueio", () => {
  for (const [nome, status, corpo] of CENARIOS) {
    const c = interpretarConexaoML(status, corpo);
    const motivo = motivoBloqueioML(c);
    if (c.estado === "CONECTADO") assert(motivo === null, `"${nome}" bloqueia estando conectado`);
    else assert(!!motivo && motivo.length > 10, `"${nome}" bloqueia sem explicar`);
  }
  assert(!!motivoBloqueioML(CONEXAO_ML_CARREGANDO), "carregando não explica o bloqueio");
});

t("20. carregando não mostra aviso — não pisca 'não conectado'", () => {
  assert(avisoConexaoML(CONEXAO_ML_CARREGANDO) === null, "🔴 aviso durante o carregamento");
  assert(avisoConexaoML({ estado: "CONECTADO" }) === null, "aviso com tudo certo");
});

const RESULTADOS: Array<[string, ResultadoContaML, ConexaoML["estado"]]> = [
  ["ok",                 { ok: true, lojaId: "L1", accessToken: "<access>", sellerId: "s", nickname: "Minha Loja" }, "CONECTADO"],
  ["SEM_LOJA",           { ok: false, motivo: "SEM_LOJA" }, "SEM_LOJA"],
  ["LOJA_INVALIDA",      { ok: false, motivo: "LOJA_INVALIDA" }, "LOJA_INVALIDA"],
  ["LOJA_NAO_DEFINIDA",  { ok: false, motivo: "LOJA_NAO_DEFINIDA", lojas: [{ id: "L1", nickname: "A", marketplace: "ML" }, { id: "L2", nickname: "B", marketplace: "ML" }] }, "LOJA_NAO_DEFINIDA"],
  ["PRECISA_RECONECTAR", { ok: false, motivo: "PRECISA_RECONECTAR", loja: { id: "L1", nickname: "A", marketplace: "ML" } }, "PRECISA_RECONECTAR"],
];

async function principal() {
  const { montarRespostaConexao } = await import("../lib/ml-conexao");

  console.log("\n[5. acordo com o contrato REAL do servidor]");

  for (const [nome, resultado, esperado] of RESULTADOS) {
    t(`21. resposta real do servidor "${nome}" -> ${esperado}`, () => {
      // Passa pelo JSON de verdade: o que a tela recebe é texto, não objeto.
      const corpo = JSON.parse(JSON.stringify(montarRespostaConexao(resultado)));
      const c = interpretarConexaoML(200, corpo);
      assert(c.estado === esperado, `divergência cliente/servidor: veio ${c.estado}`);
    });
  }

  t("22. nenhuma resposta real do servidor carrega credencial para a tela", () => {
    for (const [nome, resultado] of RESULTADOS) {
      const texto = JSON.stringify(montarRespostaConexao(resultado));
      assert(!/<access|<refresh|access_token|refresh_token|authorization|client_secret/i.test(texto),
        `🔴 credencial na resposta de "${nome}": ${texto}`);
    }
  });

  t("23. a loja lida pela tela nunca traz campo além de id/nickname/marketplace", () => {
    const corpo = JSON.parse(JSON.stringify(montarRespostaConexao(
      { ok: true, lojaId: "L1", accessToken: "<access>", sellerId: "segredo-seller", nickname: "Minha Loja" }
    )));
    const c = interpretarConexaoML(200, corpo);
    assert(!!c.loja, "não identificou a loja");
    assert(Object.keys(c.loja!).sort().join(",") === "id,marketplace,nickname",
      `campos inesperados: ${Object.keys(c.loja!)}`);
    assert(!JSON.stringify(c).includes("segredo-seller"), "🔴 seller_id chegou à tela");
  });

  console.log("\n[6. o módulo do cliente é mesmo do cliente]");

  t("24. lib/conexao-ml-cliente.ts não importa nada de servidor", () => {
    const fonte = fs.readFileSync(path.join(RAIZ, "lib", "conexao-ml-cliente.ts"), "utf8");
    for (const proibido of ["@supabase/supabase-js", "next/server", "@/lib/ml-auth", "@/lib/ml-conexao", "process.env"]) {
      assert(!fonte.includes(proibido), `🔴 importa/usa "${proibido}" — vazaria para o bundle do navegador`);
    }
  });

  t("25. o módulo do cliente não tem nenhuma chamada de rede", () => {
    const fonte = semComentarios(path.join(RAIZ, "lib", "conexao-ml-cliente.ts"));
    assert(!/fetch\s*\(/.test(fonte), "o interpretador faz rede — deveria ser puro");
  });

  console.log(`\n=== RESULTADO: ${ok} passaram, ${falhou} falharam ===\n`);
  if (falhou > 0) process.exit(1);
}

void principal();
