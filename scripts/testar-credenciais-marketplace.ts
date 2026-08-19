/**
 * Suíte da capability de credenciais de marketplace — PR #1.
 *
 * Prova a invariante:
 *
 *   "Nenhuma função de credencial acessível pelo código de domínio pode
 *    ler ou alterar credenciais usando apenas loja_id."
 *
 * ── O que esta suíte prova, e como ──────────────────────────────────
 * Sem rede, sem banco, sem IA — como todas as suítes deste projeto.
 * Três instrumentos, deliberadamente distintos:
 *
 *  1. FILTROS (funções puras exportadas pela capability). É onde a
 *     invariante realmente vive: a decisão de quais colunas restringem a
 *     consulta. Um executor em memória, escrito aqui, consome os MESMOS
 *     objetos de filtro que a produção aplica como `.eq()` encadeados, e
 *     reproduz a semântica de recusa cross-tenant.
 *  2. ARIDADE das funções exportadas. `fn.length` prova em runtime que
 *     `getMLLojaById`/`getShopeeLojaById` não podem mais ser chamadas só
 *     com `lojaId`.
 *  3. INSPEÇÃO DE FONTE, padrão que o projeto já usa (ver assert 161 de
 *     `testar-shopee-status.ts`): garante que nenhum módulo de domínio
 *     voltou a montar query de credencial por conta própria.
 *
 * LIMITE DECLARADO: o round-trip real contra o PostgREST não é exercido
 * aqui — isso exigiria banco, e a hierarquia da §19 põe banco depois dos
 * testes puros. O que se prova é o CONTRATO DE FILTRO, que é o que a
 * produção envia. A PRE-CHECK de produção já confirmou, em separado, que
 * não existe par incoerente hoje (7 jobs, 0 divergentes).
 */
import "./_server-only-inerte";
import "./_env-inerte";
import { readFileSync } from "fs";
import { join } from "path";

import {
  filtrosMLPorLojaEDono,
  filtrosMLAtivaDoDono,
  filtrosShopeeDoDono,
  filtrosGravacaoPorLojaEDono,
  lerCredencialMLPorLojaEDono,
  lerCredencialMLAtivaDoDono,
  listarCredenciaisMLDoDono,
  gravarCredencialML,
  lerCredencialShopeeDoDono,
  gravarCredencialShopee,
} from "../lib/marketplace/credenciais";
import { getMLLojaById, saveTokensToDB } from "../lib/ml-auth";
import { getShopeeLojaById } from "../lib/shopee-auth";

const RAIZ = join(__dirname, "..");
const fonte = (rel: string) => readFileSync(join(RAIZ, rel), "utf8");

/**
 * Fonte SEM comentários. Asserção de AUSÊNCIA precisa disto: este projeto
 * documenta fartamente o que decidiu não fazer, e uma busca ingênua por
 * `createClient` ou `SupabaseClient` casaria com a explicação de por que
 * eles não estão lá — passando ou falhando pelo motivo errado.
 */
const codigo = (rel: string) =>
  fonte(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

let passou = 0;
let falhou = 0;
function ok(nome: string, condicao: boolean) {
  if (condicao) {
    passou++;
  } else {
    falhou++;
    console.error(`  ✗ ${nome}`);
  }
}

// ── Executor em memória ───────────────────────────────────────────────
// Reproduz `.eq()` encadeado: a linha só passa se TODOS os filtros baterem.
// É a mesma regra que `aplicarFiltros` aplica na produção.
type Linha = Record<string, unknown>;
function selecionar(tabela: Linha[], filtros: Record<string, unknown>): Linha[] {
  return tabela.filter((linha) =>
    Object.entries(filtros).every(([coluna, valor]) => String(linha[coluna]) === String(valor))
  );
}

const USUARIO_A = "user-aaaa";
const USUARIO_B = "user-bbbb";
const LOJA_A = "11111111-1111-1111-1111-111111111111";
const LOJA_B = "22222222-2222-2222-2222-222222222222";

const LOJAS: Linha[] = [
  {
    id: LOJA_A, user_id: USUARIO_A, marketplace: "ML", ativo: true,
    access_token: "tk-a", refresh_token: "rt-a", token_expires_at: "2030-01-01T00:00:00Z",
  },
  {
    id: LOJA_B, user_id: USUARIO_B, marketplace: "ML", ativo: true,
    access_token: "tk-b", refresh_token: "rt-b", token_expires_at: "2030-01-01T00:00:00Z",
  },
  {
    id: LOJA_A + "-sh", user_id: USUARIO_A, marketplace: "Shopee", ativo: true,
    access_token: "tk-a-sh", refresh_token: "rt-a-sh", partner_key: "pk-a",
  },
  {
    id: LOJA_B + "-sh", user_id: USUARIO_B, marketplace: "Shopee", ativo: true,
    access_token: "tk-b-sh", refresh_token: "rt-b-sh", partner_key: "pk-b",
  },
];

// Envolvido em `main()` porque o transform do tsx é CJS: top-level await
// não é suportado, e parte das asserções chama funções assíncronas.
async function main() {
console.log("\n── 1. A + loja de A: leitura funciona ─────────────────────");
ok("1. ML: A lê a própria loja",
  selecionar(LOJAS, filtrosMLPorLojaEDono(LOJA_A, USUARIO_A)).length === 1);
ok("2. ML: a linha lida é mesmo a de A",
  selecionar(LOJAS, filtrosMLPorLojaEDono(LOJA_A, USUARIO_A))[0].access_token === "tk-a");
ok("3. ML ativa do dono: A encontra a própria",
  selecionar(LOJAS, filtrosMLAtivaDoDono(USUARIO_A)).length === 1);
ok("4. Shopee: A lê a própria loja indicada",
  selecionar(LOJAS, filtrosShopeeDoDono(USUARIO_A, LOJA_A + "-sh")).length === 1);
ok("5. Shopee: A encontra a própria sem indicar loja",
  selecionar(LOJAS, filtrosShopeeDoDono(USUARIO_A)).length === 1);

console.log("── 2 e 14/15. A + loja de B: nenhuma credencial (cross-tenant) ──");
ok("6. ML: A NÃO lê a loja de B",
  selecionar(LOJAS, filtrosMLPorLojaEDono(LOJA_B, USUARIO_A)).length === 0);
ok("7. ML: nenhum token de B alcançável por A",
  selecionar(LOJAS, filtrosMLPorLojaEDono(LOJA_B, USUARIO_A))
    .every((l) => l.access_token !== "tk-b"));
ok("8. ML ativa: A nunca recebe loja de B",
  selecionar(LOJAS, filtrosMLAtivaDoDono(USUARIO_A)).every((l) => l.user_id === USUARIO_A));
ok("9. ML listar: lojaId de B SOMA-SE ao dono e resulta vazio",
  selecionar(LOJAS, { ...filtrosMLAtivaDoDono(USUARIO_A), id: LOJA_B }).length === 0);
ok("10. Shopee: A NÃO lê a loja de B (negativo cross-tenant Shopee)",
  selecionar(LOJAS, filtrosShopeeDoDono(USUARIO_A, LOJA_B + "-sh")).length === 0);
ok("11. Shopee: partner_key de B jamais alcançável por A",
  selecionar(LOJAS, filtrosShopeeDoDono(USUARIO_A, LOJA_B + "-sh"))
    .every((l) => l.partner_key !== "pk-b"));

console.log("── 3. A + loja de B: nenhuma credencial ALTERADA ──────────");
ok("12. gravação ML: filtro de B sob dono A não casa nenhuma linha",
  selecionar(LOJAS, filtrosGravacaoPorLojaEDono(LOJA_B, USUARIO_A)).length === 0);
ok("13. gravação ML: filtro coerente casa exatamente 1 linha",
  selecionar(LOJAS, filtrosGravacaoPorLojaEDono(LOJA_A, USUARIO_A)).length === 1);
ok("14. gravação Shopee: cross-tenant não casa nenhuma linha",
  selecionar(LOJAS, filtrosGravacaoPorLojaEDono(LOJA_B + "-sh", USUARIO_A)).length === 0);

console.log("── 4. Loja inexistente / entrada vazia: fail-closed ───────");
ok("15. loja inexistente não casa nada",
  selecionar(LOJAS, filtrosMLPorLojaEDono("99999999-9999-9999-9999-999999999999", USUARIO_A)).length === 0);
ok("16. lerCredencialMLPorLojaEDono sem lojaId devolve null sem tocar banco",
  (await lerCredencialMLPorLojaEDono("", USUARIO_A)).linha === null);
ok("17. lerCredencialMLPorLojaEDono sem userId devolve null sem tocar banco",
  (await lerCredencialMLPorLojaEDono(LOJA_A, "")).linha === null);
ok("18. lerCredencialMLAtivaDoDono sem userId devolve null",
  (await lerCredencialMLAtivaDoDono("")).linha === null);
ok("19. listarCredenciaisMLDoDono sem userId devolve lista vazia",
  (await listarCredenciaisMLDoDono("")).linhas.length === 0);
ok("20. lerCredencialShopeeDoDono sem userId devolve null",
  (await lerCredencialShopeeDoDono("")).linha === null);
ok("21. gravarCredencialML sem userId devolve false e não grava",
  (await gravarCredencialML(LOJA_A, "", { access_token: "x" })) === false);
ok("22. gravarCredencialML sem lojaId devolve false e não grava",
  (await gravarCredencialML("", USUARIO_A, { access_token: "x" })) === false);
ok("23. gravarCredencialShopee sem userId retorna sem gravar",
  (await gravarCredencialShopee(LOJA_A, "", { access_token: "x" })) === undefined);

console.log("── 5. Worker com par incoerente: sync não executa ─────────");
// user_id=A + loja_id de B é exatamente o job forjado que `sync_jobs`
// (sem RLS) permitiria inserir hoje.
ok("24. ML: par incoerente do worker não resolve credencial",
  selecionar(LOJAS, filtrosMLPorLojaEDono(LOJA_B, USUARIO_A)).length === 0);
ok("25. Shopee: par incoerente do worker não resolve credencial",
  selecionar(LOJAS, filtrosShopeeDoDono(USUARIO_A, LOJA_B + "-sh")).length === 0);
{
  const rota = fonte("app/api/internal/sync/executar/route.ts");
  ok("26. rota interna repassa user_id ao resolver credencial Shopee",
    /getShopeeLojaById\(\s*loja_id\s*,\s*user_id\s*\)/.test(rota));
  ok("27. rota interna repassa user_id ao resolver credencial ML",
    /getMLLojaById\(\s*loja_id\s*,\s*user_id\s*\)/.test(rota));
  ok("28. credencial não resolvida devolve 400 e não segue para o sync",
    /Loja Shopee não encontrada ou sem token válido/.test(rota) &&
    /Loja ML não encontrada ou sem token válido/.test(rota));
  ok("29. x-worker-secret continua fail-closed (autenticação, não ownership)",
    /if \(!segredoEsperado \|\| !segredoRecebido \|\| segredoRecebido !== segredoEsperado\)/.test(rota));
  ok("30. contrato externo da rota inalterado (mesmos campos do body)",
    /const \{ user_id, loja_id, marketplace, date_from, date_to, tipo \} = body \?\? \{\};/.test(rota));
}

console.log("── 6 e 7. CAS do ML preservado ────────────────────────────");
{
  const cred = fonte("lib/marketplace/credenciais.ts");
  ok("31. gravação com refreshAnterior acrescenta refresh_token ao filtro",
    /filtros\.refresh_token = refreshAnterior;/.test(cred));
  ok("32. CAS confirma pela linha realmente afetada (.select(\"id\"))",
    /\.select\("id"\)/.test(cred));
  ok("33. CAS devolve false quando nada foi gravado",
    /return Array\.isArray\(data\) && data\.length > 0;/.test(cred));
  ok("34. ramo legado preservado: escrita incondicional sem .select()",
    /if \(!refreshAnterior\) \{[\s\S]*?return true;/.test(cred));

  // 7. o filtro extra de user_id não altera o resultado do CAS quando o
  //    par é coerente: o CAS continua decidindo apenas pelo refresh_token.
  const linhaAtual = [{ id: LOJA_A, user_id: USUARIO_A, refresh_token: "rt-a" }];
  const casComDonoCerto = { ...filtrosGravacaoPorLojaEDono(LOJA_A, USUARIO_A), refresh_token: "rt-a" };
  const casTokenVelho = { ...filtrosGravacaoPorLojaEDono(LOJA_A, USUARIO_A), refresh_token: "rt-antigo" };
  ok("35. CAS vence quando o refresh_token ainda é o de partida",
    selecionar(linhaAtual, casComDonoCerto).length === 1);
  ok("36. CAS perde a corrida quando o refresh_token já rotacionou",
    selecionar(linhaAtual, casTokenVelho).length === 0);
  ok("37. filtro de user_id não altera o desfecho do CAS coerente",
    selecionar(linhaAtual, casComDonoCerto).length ===
      selecionar(linhaAtual, { id: LOJA_A, refresh_token: "rt-a" }).length);

  const conexao = fonte("lib/ml-conexao.ts");
  ok("38. coalescência por loja preservada em ml-conexao",
    /renovacoesEmVoo/.test(conexao) && /renovacoesEmVoo\.set\(lojaId, promessa\)/.test(conexao));
  ok("39. releitura após corrida preservada",
    /const atual = await relerLoja\(loja\.id, userId\);/.test(conexao));
  ok("40. renovarCredencial repassa userId ao gravar",
    /saveTokensToDB\(lojaId, userId, resultado, refreshToken\)/.test(conexao));
  ok("41. publica\\(\\) continua descartando token",
    /function publica\([\s\S]*?return \{ id: loja\.id, nickname: loja\.nickname \?\? "", marketplace: MARKETPLACE_ML \};/.test(conexao));
}

console.log("── 8. Shopee: semântica de refresh inalterada ─────────────");
{
  const sh = fonte("lib/shopee-auth.ts");
  const cred = fonte("lib/marketplace/credenciais.ts");
  ok("42. Shopee continua SEM compare-and-swap (limite pré-existente)",
    !/refresh_token:\s*refreshAnterior/.test(
      cred.slice(cred.indexOf("gravarCredencialShopee"))
    ));
  ok("43. gravarCredencialShopee não usa .select() de confirmação",
    !/\.select\(/.test(cred.slice(cred.indexOf("export async function gravarCredencialShopee"))));
  ok("44. refresh Shopee mantém a margem de 5 min",
    /5 \* 60 \* 1000/.test(sh));
  ok("45. refresh falho continua devolvendo null, sem usar token inválido",
    /refresh FALHOU/.test(sh));
  ok("46. ausência de CAS na Shopee está documentada, não escondida",
    /NÃO há compare-and-swap aqui, e isso é intencional/.test(cred));
}

console.log("── 9 a 13. Superfície privilegiada ────────────────────────");
{
  const mlAuth = fonte("lib/ml-auth.ts");
  const shAuth = fonte("lib/shopee-auth.ts");
  const conexao = fonte("lib/ml-conexao.ts");
  const cred = fonte("lib/marketplace/credenciais.ts");

  // 9 — nenhum módulo de domínio monta query de credencial.
  const COLUNAS_SENSIVEIS = ["access_token", "refresh_token", "partner_key", "token_expires_at"];
  for (const [nome, src] of [
    ["ml-auth", codigo("lib/ml-auth.ts")],
    ["shopee-auth", codigo("lib/shopee-auth.ts")],
    ["ml-conexao", codigo("lib/ml-conexao.ts")],
  ] as const) {
    const temSelectDeCredencial = COLUNAS_SENSIVEIS.some((c) =>
      new RegExp(`\\.select\\([^)]*${c}`).test(src)
    );
    ok(`47/${nome}: não monta .select() de coluna de credencial`, !temSelectDeCredencial);
    const temUpdateDeCredencial = /\.from\("lojas"\)[\s\S]{0,80}\.update\(/.test(src);
    ok(`48/${nome}: não monta .update() direto em lojas`, !temUpdateDeCredencial);
  }
  ok("49. shopee-auth não instancia mais createClient",
    !/createClient/.test(codigo("lib/shopee-auth.ts")));
  ok("50. ml-conexao não instancia mais createClient",
    !/createClient/.test(codigo("lib/ml-conexao.ts")));
  ok("51. ml-auth mantém createClient APENAS para o caminho anon sem credencial",
    /createClient/.test(mlAuth) &&
    /resolverLojaDoUsuario/.test(mlAuth) &&
    /Cliente ANON — menor privilégio/.test(mlAuth));
  ok("52. resolverLojaDoUsuario segue lendo somente id",
    /\.from\("lojas"\)\s*\n\s*\.select\("id"\)/.test(mlAuth));

  // 10 — barreira server-only, agora em tempo de BUILD.
  const credSemComentarios = codigo("lib/marketplace/credenciais.ts");
  ok("53. capability importa literalmente o pacote server-only",
    /^import "server-only";$/m.test(credSemComentarios));
  ok("54. server-only é o PRIMEIRO import do módulo",
    (credSemComentarios.match(/^import .*$/m) ?? [""])[0] === 'import "server-only";');
  ok("55. guarda de runtime substituta foi removida",
    !/typeof window !== "undefined"/.test(credSemComentarios));
  ok("55b. server-only é dependência direta declarada",
    typeof JSON.parse(fonte("package.json")).dependencies["server-only"] === "string");

  // 11 — nenhuma função exportada aceita lojaId sem userId.
  // `Function.length` conta parâmetros até o primeiro COM VALOR PADRÃO.
  // Opcional de TypeScript (`x?: T`) compila sem default, então conta —
  // por isso `saveTokensToDB` mede 4, e `lerCredencialMLPorLojaEDono`
  // mede 2 (o 3º tem `= {}`). O que cada assert afirma é sempre o mesmo:
  // a função deixou de ser chamável só com `lojaId`.
  ok("56. getMLLojaById exige lojaId + userId", getMLLojaById.length === 2);
  ok("57. getShopeeLojaById exige lojaId + userId", getShopeeLojaById.length === 2);
  ok("58. saveTokensToDB exige lojaId + userId + result (+CAS opcional)",
    saveTokensToDB.length === 4);
  ok("59. lerCredencialMLPorLojaEDono exige lojaId + userId", lerCredencialMLPorLojaEDono.length === 2);
  ok("60. gravarCredencialML exige lojaId + userId + campos (+CAS opcional)",
    gravarCredencialML.length === 4);
  ok("61. gravarCredencialShopee exige lojaId + userId + campos", gravarCredencialShopee.length === 3);
  ok("62. lerCredencialShopeeDoDono começa pelo userId (loja é opcional)",
    lerCredencialShopeeDoDono.length === 2);
  ok("63. nenhuma função de credencial por loja aceita 1 só argumento",
    [getMLLojaById, getShopeeLojaById, lerCredencialMLPorLojaEDono,
     gravarCredencialML, gravarCredencialShopee, saveTokensToDB]
      .every((f) => f.length >= 2));
  ok("63. nenhum filtro por loja existe sem user_id",
    "user_id" in filtrosMLPorLojaEDono(LOJA_A, USUARIO_A) &&
    "user_id" in filtrosGravacaoPorLojaEDono(LOJA_A, USUARIO_A) &&
    "user_id" in filtrosShopeeDoDono(USUARIO_A, LOJA_A) &&
    "user_id" in filtrosMLAtivaDoDono(USUARIO_A));
  ok("64. filtro ML por loja também fixa o marketplace",
    filtrosMLPorLojaEDono(LOJA_A, USUARIO_A).marketplace === "ML");
  ok("65. filtro Shopee por loja também fixa o marketplace",
    filtrosShopeeDoDono(USUARIO_A, LOJA_A).marketplace === "Shopee");
  ok("66. user_id é normalizado para texto (lojas.user_id é TEXT)",
    typeof filtrosMLPorLojaEDono(LOJA_A, USUARIO_A).user_id === "string");

  // 12 — nenhum SupabaseClient exportado nem recebido.
  // Sobre o CÓDIGO, nunca sobre os comentários: a capability explica em
  // prosa que não exporta SupabaseClient, e a prosa não é prova.
  const credCodigo = codigo("lib/marketplace/credenciais.ts");
  ok("67. capability não menciona SupabaseClient em código algum",
    !/SupabaseClient/.test(credCodigo));
  ok("68. capability não recebe SupabaseClient como parâmetro",
    !/:\s*SupabaseClient/.test(credCodigo));
  ok("69. capability não cria um segundo createClient",
    !/createClient/.test(credCodigo));
  ok("70. capability reutiliza getSupabaseServidor",
    /import \{ getSupabaseServidor \} from "@\/lib\/estudio-anuncios\/supabase-servidor";/.test(cred));
  ok("71. capability seleciona colunas explícitas, nunca select(\"*\")",
    !/select\("\*"\)/.test(cred));

  // 13 — nenhum token em resposta HTTP.
  const rotaConexao = fonte("app/api/ml/conexao/route.ts");
  ok("72. GET /api/ml/conexao não devolve accessToken",
    !/accessToken/.test(rotaConexao));
  ok("73. montarRespostaConexao continua montando campo a campo",
    /export function montarRespostaConexao/.test(conexao) &&
    !/\.\.\.resultado/.test(codigo("lib/ml-conexao.ts")));
  const rotaSync = fonte("app/api/internal/sync/executar/route.ts");
  ok("74. rota interna não devolve token nem partner_key",
    !/access_token|partner_key|accessToken|partnerKey/.test(rotaSync));
}

console.log("── PR #2b-1: registrarLojaShopeeOAuth ─────────────────────");
{
  const cred = fonte("lib/marketplace/credenciais.ts");
  const credCodigo = codigo("lib/marketplace/credenciais.ts");
  const trecho = credCodigo.slice(credCodigo.indexOf("registrarLojaShopeeOAuth"));

  ok("77. bootstrap OAuth exige userId e NÃO aceita lojaId",
    /registrarLojaShopeeOAuth\(\s*userId: string,\s*dados: DadosRegistroShopee\s*\)/.test(credCodigo));
  ok("78. SELECT escopado por user_id + marketplace + seller_id",
    /\.eq\("user_id", dono\)[\s\S]{0,120}\.eq\("marketplace", MARKETPLACE_SHOPEE\)[\s\S]{0,120}\.eq\("seller_id", sellerId\)/.test(trecho));
  ok("79. SELECT pede somente id", /\.select\("id"\)/.test(trecho) && !/select\("\*"\)/.test(trecho));
  ok("80. UPDATE é tenant-aware (id + user_id)",
    /\.update\(credenciais\)[\s\S]{0,120}\.eq\("id", lojaId\)[\s\S]{0,80}\.eq\("user_id", dono\)/.test(trecho));
  ok("81. UPDATE confirma linha afetada", /nenhuma linha confirmada no update/.test(trecho));
  ok("82. INSERT grava user_id da sessão", /user_id: dono/.test(trecho));
  ok("83. INSERT grava marketplace e seller_id explícitos",
    /marketplace: MARKETPLACE_SHOPEE/.test(trecho) && /seller_id: sellerId/.test(trecho));
  ok("84. trata 23505 como corrida, não como sucesso", /!== "23505"/.test(trecho));
  ok("85. releitura vazia após 23505 falha fechado", /conflito sem linha correspondente/.test(trecho));
  ok("86. duplicidade do próprio usuário falha fechada",
    /motivo: "duplicidade_loja"/.test(trecho));
  ok("87. NÃO usa upsert nem onConflict", !/\.upsert\(/.test(credCodigo) && !/onConflict/.test(credCodigo));
  ok("88. resultado não devolve credencial",
    !/interface ResultadoRegistroLoja[\s\S]{0,220}(access_token|refresh_token|partner_key)/.test(cred));
  ok("89. o motivo de não usar upsert está documentado",
    /Por que NAO usa upsert/.test(cred));
  ok("90. partner_key segue persistida temporariamente, com justificativa",
    /partner_key: dados\.partnerKey/.test(trecho) && /TEMPORARIAMENTE/.test(cred));
}

console.log("── Caller do Estúdio permanece tenant-aware ───────────────");
{
  const conta = fonte("lib/estudio-anuncios/compliance/ml-conta.ts");
  ok("75. ml-conta repassa userId a getMLLojaById",
    /getMLLojaById\(params\.lojaId, params\.userId\)/.test(conta));
  ok("76. checagens de propriedade anteriores foram preservadas",
    /String\(loja\.user_id\) !== params\.userId/.test(conta) &&
    /loja\.marketplace !== params\.marketplace/.test(conta) &&
    /loja\.ativo !== true/.test(conta));
}

}

main().then(() => {
  console.log(`\n${"═".repeat(58)}`);
  console.log(`  Suíte credenciais de marketplace — PR #1`);
  console.log(`  passou: ${passou}   falhou: ${falhou}`);
  console.log(`${"═".repeat(58)}\n`);
  if (falhou > 0) process.exit(1);
});
