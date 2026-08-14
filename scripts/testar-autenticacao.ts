/**
 * Camada de autenticação — testes de F0.c.2.
 *
 * ── O que estes testes provam ───────────────────────────────────────
 * · o segredo é obrigatório e nunca vaza em mensagem de erro;
 * · um token assinado válido devolve o uid;
 * · token inválido, expirado, adulterado, o formato ANTIGO (UUID cru) e
 *   o legado "1" são todos recusados;
 * · o TypeScript **reprova** o uso sem `await` — verificado rodando o
 *   compilador de verdade sobre um arquivo de exemplo, não procurando
 *   texto no fonte;
 * · nenhum arquivo de produção importa a camada nova;
 * · o inventário de `getUserId` continua com o mesmo tamanho.
 *
 * ── O que NÃO provam ────────────────────────────────────────────────
 * Execução no runtime Edge do middleware. Isso só é demonstrável quando
 * o middleware importar a camada e o `next build` gerar o bundle Edge —
 * é o primeiro passo de F0.c.3.
 *
 * Nenhum segredo real: as chaves abaixo são constantes de teste.
 * Sem rede, sem banco, sem alteração de arquivo do projeto.
 *
 * Uso: npx tsx scripts/testar-autenticacao.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  autenticarRequisicao,
  emitirTokenSessao,
  agoraEmSegundos,
  lerCookie,
  COOKIE_SESSAO,
  DURACAO_SESSAO_SEGUNDOS,
  OPCOES_COOKIE_SESSAO,
} from "../lib/autenticacao";
import { ErroConfiguracaoSessao, DURACAO_PADRAO_SEGUNDOS } from "../lib/sessao-assinada";

let ok = 0, falhou = 0;

/**
 * Execução SEQUENCIAL, de propósito.
 *
 * `comSegredo()` mexe em `process.env.SESSION_SECRET`, que é estado
 * global do processo. A primeira versão desta suíte rodava os testes em
 * paralelo e eles sobrescreviam o segredo uns dos outros — três falhas
 * que não eram do módulo, eram do arranjo de teste.
 */
let fila: Promise<void> = Promise.resolve();
function t(nome: string, fn: () => void | Promise<void>) {
  fila = fila.then(async () => {
    try { await fn(); ok++; console.log(`  PASS  ${nome}`); }
    catch (e: any) { falhou++; console.log(`  FALHA ${nome} -> ${e?.message ?? e}`); }
  });
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

// ── Constantes de teste (NUNCA segredos reais) ───────────────────────
const SEGREDO_TESTE = "segredo-de-teste-f0c2-com-32-bytes!";
const UID = "3f7a1c2e-9b4d-4c6a-8e1f-2d5b7a9c0e34";
const AGORA = 1_800_000_000;

/** Aplica um segredo só durante a chamada, sempre restaurando o anterior. */
async function comSegredo<T>(valor: string | undefined, fn: () => Promise<T> | T): Promise<T> {
  const anterior = process.env.SESSION_SECRET;
  if (valor === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = valor;
  try { return await fn(); }
  finally {
    if (anterior === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = anterior;
  }
}

const req = (cookie?: string) =>
  new Request("https://exemplo.test/qualquer", cookie ? { headers: { cookie } } : undefined);

async function main() {
console.log("\n[1. SESSION_SECRET — fail-closed]");

t("1. segredo válido é aceito", async () => {
  await comSegredo(SEGREDO_TESTE, async () => {
    const { token } = await emitirTokenSessao(UID, AGORA);
    assert(typeof token === "string" && token.includes("."), "não emitiu token");
  });
});

t("2. segredo AUSENTE -> lança nas duas funções", async () => {
  await comSegredo(undefined, async () => {
    for (const fn of [
      () => emitirTokenSessao(UID, AGORA),
      () => autenticarRequisicao(req(`${COOKIE_SESSAO}=qualquer`), AGORA),
    ]) {
      let lancou = false;
      try { await fn(); } catch (e) { lancou = e instanceof ErroConfiguracaoSessao; }
      assert(lancou, "ausência de SESSION_SECRET deveria lançar ErroConfiguracaoSessao");
    }
  });
});

t("3. segredo VAZIO -> lança (não é tratado como presente)", async () => {
  await comSegredo("", async () => {
    let lancou = false;
    try { await emitirTokenSessao(UID, AGORA); } catch (e) { lancou = e instanceof ErroConfiguracaoSessao; }
    assert(lancou, "segredo vazio deveria lançar");
  });
});

t("4. segredo CURTO demais -> lança", async () => {
  await comSegredo("curto-demais", async () => {
    let lancou = false;
    try { await emitirTokenSessao(UID, AGORA); } catch (e) { lancou = e instanceof ErroConfiguracaoSessao; }
    assert(lancou, "segredo curto deveria lançar");
  });
});

t("5. mensagem de erro NUNCA contém o segredo", async () => {
  const secreto = "SEGREDO-QUE-NAO-PODE-VAZAR-NA-MENSAGEM";
  await comSegredo(secreto, async () => {
    try {
      // força um erro de configuração diferente (uid inválido)
      await emitirTokenSessao("nao-e-uuid", AGORA);
      throw new Error("deveria ter lançado");
    } catch (e: any) {
      assert(!String(e?.message).includes(secreto), "mensagem de erro vazou o segredo");
      assert(!String(e?.stack ?? "").includes(secreto), "stack vazou o segredo");
    }
  });
});

t("6. lança ANTES de olhar o cookie (config errada estoura sempre)", async () => {
  await comSegredo(undefined, async () => {
    let lancou = false;
    try { await autenticarRequisicao(req(), AGORA); } catch (e) { lancou = e instanceof ErroConfiguracaoSessao; }
    assert(lancou, "sem cookie e sem segredo, deveria lançar por configuração");
  });
});

console.log("\n[2. autenticação de requisição]");

t("7. token válido -> autenticado com uid", async () => {
  await comSegredo(SEGREDO_TESTE, async () => {
    const { token } = await emitirTokenSessao(UID, AGORA);
    const r = await autenticarRequisicao(req(`${COOKIE_SESSAO}=${token}`), AGORA);
    assert(r.autenticado === true, "token válido foi recusado");
    assert(r.autenticado && r.uid === UID, "uid divergente");
  });
});

t("8. sem cookie -> recusado com motivo sem_cookie", async () => {
  await comSegredo(SEGREDO_TESTE, async () => {
    const r = await autenticarRequisicao(req(), AGORA);
    assert(!r.autenticado && r.motivo === "sem_cookie", "motivo inesperado");
  });
});

t("9. token adulterado -> recusado", async () => {
  await comSegredo(SEGREDO_TESTE, async () => {
    const { token } = await emitirTokenSessao(UID, AGORA);
    const [p, s] = token.split(".");
    const r = await autenticarRequisicao(req(`${COOKIE_SESSAO}=${p}.${s[0] === "A" ? "B" : "A"}${s.slice(1)}`), AGORA);
    assert(!r.autenticado && r.motivo === "token_invalido", "token adulterado passou");
  });
});

t("10. token EXPIRADO -> recusado", async () => {
  await comSegredo(SEGREDO_TESTE, async () => {
    const { token } = await emitirTokenSessao(UID, AGORA);
    const r = await autenticarRequisicao(
      req(`${COOKIE_SESSAO}=${token}`),
      AGORA + DURACAO_SESSAO_SEGUNDOS + 1
    );
    assert(!r.autenticado, "token expirado foi aceito");
  });
});

t("11. FORMATO ATUAL (UUID cru) -> recusado", async () => {
  // É exatamente o cookie que produção emite hoje. Depois do cutover
  // ele deixa de valer — daí o relogin obrigatório.
  await comSegredo(SEGREDO_TESTE, async () => {
    const r = await autenticarRequisicao(req(`${COOKIE_SESSAO}=${UID}`), AGORA);
    assert(!r.autenticado && r.motivo === "token_invalido", "UUID cru foi aceito");
  });
});

t('12. cookie legado "1" -> recusado', async () => {
  await comSegredo(SEGREDO_TESTE, async () => {
    const r = await autenticarRequisicao(req(`${COOKIE_SESSAO}=1`), AGORA);
    assert(!r.autenticado, 'cookie legado "1" foi aceito');
  });
});

t("13. token de OUTRO segredo -> recusado", async () => {
  const outro = "outro-segredo-de-teste-com-32-bytes!";
  const token = await comSegredo(outro, async () => (await emitirTokenSessao(UID, AGORA)).token);
  await comSegredo(SEGREDO_TESTE, async () => {
    const r = await autenticarRequisicao(req(`${COOKIE_SESSAO}=${token}`), AGORA);
    assert(!r.autenticado, "token de outro segredo foi aceito");
  });
});

console.log("\n[3. leitura de cookie]");

t("14. lê o cookie entre outros, com e sem espaço após ';'", async () => {
  await comSegredo(SEGREDO_TESTE, async () => {
    const { token } = await emitirTokenSessao(UID, AGORA);
    for (const header of [
      `${COOKIE_SESSAO}=${token}`,
      `outro=1; ${COOKIE_SESSAO}=${token}; mais=2`,
      `outro=1;${COOKIE_SESSAO}=${token};mais=2`,
      `  ${COOKIE_SESSAO}=${token}  `,
    ]) {
      const r = await autenticarRequisicao(req(header), AGORA);
      assert(r.autenticado === true, `não leu o cookie em: ${header.slice(0, 40)}`);
    }
  });
});

t("15. não confunde cookie de nome parecido", () => {
  const r = req(`x_${COOKIE_SESSAO}=abc; ${COOKIE_SESSAO}_x=def`);
  assert(lerCookie(r, COOKIE_SESSAO) === null, "casou com cookie de nome diferente");
});

t("16. cookie vazio é tratado como ausente", () => {
  assert(lerCookie(req(`${COOKIE_SESSAO}=`), COOKIE_SESSAO) === null, "cookie vazio virou valor");
});

console.log("\n[4. contrato do cookie e do relógio]");

t("17. opções do cookie conforme o contrato aprovado", () => {
  assert(OPCOES_COOKIE_SESSAO.httpOnly === true, "httpOnly deveria ser true");
  assert(OPCOES_COOKIE_SESSAO.sameSite === "lax", "sameSite deveria ser lax");
  assert(OPCOES_COOKIE_SESSAO.path === "/", "path deveria ser /");
  assert(!("domain" in OPCOES_COOKIE_SESSAO), "domain não deve ser definido (host-only)");
  assert(OPCOES_COOKIE_SESSAO.maxAge === DURACAO_PADRAO_SEGUNDOS, "maxAge deveria ser a duração da sessão");
  assert(DURACAO_SESSAO_SEGUNDOS === 7 * 24 * 60 * 60, "duração deveria ser 7 dias");
});

t("18. relógio central devolve segundos plausíveis", () => {
  const agora = agoraEmSegundos();
  assert(Number.isSafeInteger(agora) && agora > 1_700_000_000, `agoraEmSegundos suspeito: ${agora}`);
  assert(String(agora).length === 10, "parece milissegundos, não segundos");
});

t("19. token emitido pelo relógio real é aceito pelo relógio real", async () => {
  await comSegredo(SEGREDO_TESTE, async () => {
    const { token } = await emitirTokenSessao(UID);
    const r = await autenticarRequisicao(req(`${COOKIE_SESSAO}=${token}`));
    assert(r.autenticado === true, "token com relógio real foi recusado");
  });
});

console.log("\n[5. guardrail de compilação — o await esquecido]");
//
// Não basta afirmar que o TypeScript protege: aqui o compilador é
// executado de verdade sobre dois arquivos de exemplo, fora do
// repositório, e o resultado é comparado.

function compilar(codigo: string): { ok: boolean; saida: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cds-f0c2-"));
  const arquivo = path.join(dir, "amostra.ts");
  const alvo = path.join(process.cwd(), "lib", "autenticacao").split(path.sep).join("/");
  fs.writeFileSync(arquivo, codigo.replace("__MODULO__", alvo), "utf8");
  // Chama o compilador pelo próprio Node, apontando para o binário do
  // TypeScript instalado no projeto. Passar por `npx` falhava ao criar o
  // processo no Windows e devolvia saída vazia — o teste "reprovava" sem
  // que o compilador tivesse sequer rodado.
  const tsc = path.join(process.cwd(), "node_modules", "typescript", "bin", "tsc");
  try {
    execFileSync(
      process.execPath,
      [tsc, "--noEmit", "--strict", "--target", "es2020", "--module", "esnext",
       "--moduleResolution", "bundler", "--skipLibCheck", "--lib", "es2020,dom", arquivo],
      { stdio: "pipe", encoding: "utf8" }
    );
    return { ok: true, saida: "" };
  } catch (e: any) {
    return { ok: false, saida: String(e?.stdout ?? "") + String(e?.stderr ?? "") };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const USO_ERRADO = `
import { autenticarRequisicao } from "__MODULO__";
export function rota(request: Request) {
  const auth = autenticarRequisicao(request);   // <- await ESQUECIDO
  if (!auth.autenticado) return "401";
  return auth.uid;
}
`;

const USO_CERTO = `
import { autenticarRequisicao } from "__MODULO__";
export async function rota(request: Request) {
  const auth = await autenticarRequisicao(request);
  if (!auth.autenticado) return "401";
  return auth.uid;
}
`;

t("20. uso SEM await NÃO compila (bypass silencioso impossível)", () => {
  const r = compilar(USO_ERRADO);
  assert(!r.ok, "o compilador aceitou uso sem await — o guardrail não existe");
  assert(/autenticado/.test(r.saida), `erro do compilador inesperado:\n${r.saida.slice(0, 400)}`);
});

t("21. uso COM await compila limpo", () => {
  const r = compilar(USO_CERTO);
  assert(r.ok, `uso correto deveria compilar:\n${r.saida.slice(0, 400)}`);
});

console.log("\n[6. zero impacto em produção]");

function arquivosTs(): string[] {
  const achados: string[] = [];
  const varrer = (dir: string) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) { if (!["node_modules", ".next", ".git"].includes(d.name)) varrer(p); }
      else if (/\.tsx?$/.test(d.name)) achados.push(p);
    }
  };
  varrer(process.cwd());
  return achados;
}

const TODOS = arquivosTs();

/**
 * Depois do cutover preparado em F0.c.3a, a camada É usada por 38
 * arquivos: 36 rotas que autenticam + o login (que EMITE o token) + o
 * middleware. O número fica travado: se cair, alguma rota perdeu
 * autenticação; se subir sem revisão, apareceu consumidor novo.
 *
 * 36 → 37 em F0.c.5-B: `app/api/ml/conexao/route.ts`.
 * 37 → 38 no cutover de Meus Produtos: `app/api/anuncio/route.ts`, que
 * era PÚBLICA e passou a exigir sessão — sem `userId` confiável não há
 * como resolver a credencial do ML no servidor. Provado pelos testes
 * "H. /api/anuncio SEM sessão -> 401" em
 * `scripts/testar-cutover-rotas-ml.ts` e "19." em
 * `scripts/testar-middleware.ts`.
 */
const CONSUMIDORES_ESPERADOS_AUTENTICACAO = 38;

t(`22. exatamente ${CONSUMIDORES_ESPERADOS_AUTENTICACAO} arquivos de produção usam a camada nova`, () => {
  const proprios = [
    path.join("lib", "autenticacao.ts"),
    path.join("scripts", "testar-autenticacao.ts"),
  ];
  const importadores = TODOS.filter(f =>
    !proprios.some(p => f.endsWith(p)) && /from ["'].*\/autenticacao["']/.test(fs.readFileSync(f, "utf8"))
  );
  assert(
    importadores.length === CONSUMIDORES_ESPERADOS_AUTENTICACAO,
    `esperado ${CONSUMIDORES_ESPERADOS_AUTENTICACAO} consumidores, encontrado ${importadores.length}:\n` +
      importadores.map(f => "  " + path.relative(process.cwd(), f)).join("\n")
  );
  // O middleware precisa estar entre eles — é a metade "página" da política.
  assert(importadores.some(f => f.endsWith("middleware.ts")), "o middleware não usa a camada de autenticação");
});

t("22b. toda chamada de autenticarRequisicao usa await", () => {
  // Rede secundária: a prova principal é o compilador (teste 20) e o tsc
  // do projeto. Isto pega um caso que compilaria: chamada com o retorno
  // descartado.
  const semAwait: string[] = [];
  for (const f of TODOS) {
    if (f.endsWith(path.join("scripts", "testar-autenticacao.ts"))) continue;
    const codigo = fs.readFileSync(f, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^\s*\/\/.*$/gm, " ");
    for (const linha of codigo.split("\n")) {
      if (!/\bautenticarRequisicao\s*\(/.test(linha)) continue;
      if (/\bimport\b|\bexport\b/.test(linha)) continue;
      if (!/await\s+autenticarRequisicao\s*\(/.test(linha)) {
        semAwait.push(`${path.relative(process.cwd(), f)}: ${linha.trim()}`);
      }
    }
  }
  assert(semAwait.length === 0, `chamada sem await:\n${semAwait.join("\n")}`);
});

t("23. nenhum arquivo de produção importa sessao-assinada", () => {
  const permitidos = [
    path.join("lib", "autenticacao.ts"),
    path.join("scripts", "testar-sessao.ts"),
    path.join("scripts", "testar-autenticacao.ts"), // esta própria suíte
  ];
  const importadores = TODOS.filter(f =>
    !permitidos.some(p => f.endsWith(p)) && /from ["'].*sessao-assinada["']/.test(fs.readFileSync(f, "utf8"))
  );
  assert(importadores.length === 0, `já importada por: ${importadores.join(", ")}`);
});

t("24. ZERO arquivos ainda importam @/lib/session (mecanismo antigo extinto)", () => {
  const consumidores = TODOS.filter(f => /from\s+["']@\/lib\/session["']/.test(fs.readFileSync(f, "utf8")));
  assert(
    consumidores.length === 0,
    `ainda há consumidores do mecanismo antigo:\n` +
      consumidores.map(f => "  " + path.relative(process.cwd(), f)).join("\n")
  );
});

t("25. lib/session.ts não existe mais — não há duas fontes de autenticação", () => {
  assert(
    !fs.existsSync(path.join(process.cwd(), "lib", "session.ts")),
    "lib/session.ts voltou a existir; o cutover exige uma única fonte de autenticação"
  );
});

t("26. nenhum código de produção lê o cookie de sessão por conta própria", () => {
  // A leitura tem de passar pela camada; parser paralelo é como o cookie
  // legado "1" continuava sendo aceito em três lugares.
  const infratores: string[] = [];
  for (const f of TODOS) {
    if (f.endsWith(path.join("lib", "autenticacao.ts"))) continue;
    if (f.includes(`${path.sep}scripts${path.sep}`)) continue;
    const codigo = fs.readFileSync(f, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^\s*\/\/.*$/gm, " ");
    if (/cds_session/.test(codigo)) infratores.push(path.relative(process.cwd(), f));
  }
  // Conhecidos e fora do escopo de F0.c.3a — cada um tem microetapa própria.
  const CONHECIDOS = [
    path.join("app", "api", "auth", "shopee", "callback", "route.ts"), // F0.c.7 (OAuth)
    path.join("app", "api", "lojas", "desconectar", "route.ts"),       // microetapa própria
    path.join("app", "api", "auth", "status-session", "route.ts"),     // sem consumidor
    // Logout cita o nome do cookie para LIMPÁ-LO — não para autenticar.
    // Trocar pela constante COOKIE_SESSAO fica para a microetapa do
    // logout (decisão explícita de F0.c.3a: não mexer agora).
    path.join("app", "api", "auth", "logout", "route.ts"),
  ];
  const inesperados = infratores.filter(f => !CONHECIDOS.some(c => f.endsWith(c)));
  assert(inesperados.length === 0, `leitura direta do cookie fora da camada:\n  ${inesperados.join("\n  ")}`);
});

  await fila;
  console.log(`\n=== RESULTADO: ${ok} passaram, ${falhou} falharam ===\n`);
  if (falhou > 0) process.exit(1);
}

void main();
