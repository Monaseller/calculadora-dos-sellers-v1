/**
 * AGENT-FACTORY-F7b.4.7 — invariantes ESTRUTURAIS da conexao inline.
 *
 * Suite PURA: sem rede, sem banco, sem IA, sem provedor.
 *
 * ── O que esta suite existe para impedir ────────────────────────────
 *
 * A suite live (`testar-conexao-inline-live.ts`) prova que o fluxo
 * FUNCIONA. Ela nao prova que ele continua sem poder fazer o que lhe e
 * proibido — para isso seria preciso um teste por tentativa, e algumas
 * nem tem como ser tentadas de fora.
 *
 * Aqui se cobra o que e verificavel na FONTE e na estrutura:
 *
 *   §2   nenhum segredo alcanca o browser
 *   §12  o que decide se e Composio ou nativo NAO e uma lista paralela
 *   §16  a resposta sobre a Shopee e medida, e nao afirmada
 *   §24  completar a capacidade nao manda ninguem para outra tela
 *   §30  o modelo nunca escolhe loja, dono nem conta
 *
 * Roda com: npx tsx scripts/testar-conexao-inline-estrutura.ts
 */
import "./_server-only-inerte";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { MARKETPLACE_POR_PLATAFORMA } from "../lib/agentes/conexoes/estado";
import { TOOL_PACKS } from "../lib/agentes/factory/catalogo-ui";
import { FUNCOES } from "../lib/agentes/funcoes/registry";

let pass = 0;
let fail = 0;
function ok(nome: string, cond: boolean, detalhe = ""): void {
  if (cond) { pass += 1; console.log(`  PASS  ${nome}`); }
  else { fail += 1; console.log(`  FAIL  ${nome}${detalhe ? `  — ${detalhe}` : ""}`); }
}
function secao(t: string): void { console.log(`\n${t}`); }

/** A fonte de um arquivo do repositorio, como texto. */
function fonte(rel: string): string {
  return readFileSync(join(__dirname, "..", rel), "utf8");
}

/**
 * A fonte SEM comentario.
 *
 * Existe por um FAIL desta propria suite: a sonda "o chat nunca chama
 * `setMensagens([])`" reprovou por causa de um COMENTARIO que diz que
 * isso nao acontece. Medir comentario como codigo transforma a
 * explicacao de uma regra na violacao dela.
 */
function semComentarios(fonteTexto: string): string {
  return fonteTexto
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*/g, "$1");
}

/**
 * O corpo de UMA funcao exportada, do `export` ate a proxima coluna zero.
 *
 * Tambem nasceu de um FAIL: a sonda de "so duas chaves publicadas" media
 * o arquivo INTEIRO e reprovava por `o.contaId`, que pertence a
 * `iniciarConexaoExterna` — outra funcao, de outro gate, cujo id opaco de
 * conta pendente a tela de Ferramentas usa de proposito. Medir o arquivo
 * no lugar da funcao mede a vizinhanca.
 */
function corpoDaFuncao(fonteTexto: string, nome: string): string {
  const i = fonteTexto.indexOf(`export async function ${nome}(`);
  if (i < 0) return "";
  const resto = fonteTexto.slice(i);
  // A primeira `}` em coluna zero fecha a funcao: o corpo dela e indentado
  // e nenhuma linha interna comeca assim.
  const fim = resto.search(/\n\}\n/);
  return fim < 0 ? resto : resto.slice(0, fim);
}

const CHAT = fonte("components/ia/factory/ChatDoAgente.tsx");
const TRANSPORTE = fonte("lib/ia/agentes-http.ts");
const ROTA_CONEXAO = fonte(
  "app/api/agentes/[agenteId]/capacidades/[pendenciaId]/conexao/route.ts");
const COMPLETAR = fonte("lib/agentes/factory/completar-capacidade.ts");

// ─── A. Nenhum segredo atravessa para a tela — §2 ─────────────────────

secao("A. O segredo morre no servidor — §2");

{
  // A lista e de NOMES de segredo, e nao de valores: uma suite que
  // comparasse valores teria de conhece-los.
  const PROIBIDOS = [
    "COMPOSIO_API_KEY", "ZEP_API_KEY", "SUPABASE_SERVICE_ROLE_KEY",
    "link_token", "access_token", "refresh_token", "connected_account_id",
  ];
  for (const termo of PROIBIDOS) {
    ok(`A1  o chat nao menciona \`${termo}\``, !CHAT.includes(termo));
  }
  ok("A1a ANCORA: a sonda acha o termo quando ele existe",
    PROIBIDOS.every((t) => `prefixo ${t} sufixo`.includes(t)));

  // O transporte fala com a CDS, e nao com o provedor.
  ok("A2  o transporte nao chama o provedor direto",
    !/composio\.dev|api\.composio/i.test(TRANSPORTE));
  ok("A3  e o chat nao faz rede nenhuma por fora do transporte",
    !/\bfetch\s*\(/.test(CHAT));
  ok("A3a ANCORA: o transporte E quem faz rede",
    /\bfetch\s*\(/.test(TRANSPORTE));

  // A resposta do POST de conexao publica DUAS chaves. A live confere o
  // valor; aqui se confere que o codigo nao le uma terceira.
  const INICIAR = corpoDaFuncao(TRANSPORTE, "iniciarConexaoDaCapacidade");
  ok("A4  a tela so aproveita `urlParaConectar` e `expiraEm`",
    /urlParaConectar/.test(INICIAR) && /expiraEm/.test(INICIAR) &&
      !/o\.linkToken|o\.link_token|o\.contaId|o\.conexaoContaId|o\.token/
        .test(INICIAR));
  ok("A4a ANCORA: o corpo lido e o da funcao, e nao o arquivo",
    INICIAR.length > 200 && INICIAR.length < TRANSPORTE.length / 4 &&
      /conexao`/.test(INICIAR),
    String(INICIAR.length));
  ok("A4b CONTROLE NEGATIVO: uma terceira chave reprovaria",
    /o\.contaId/.test(`${INICIAR} const x = o.contaId;`));
}

// ─── B. Dois mundos, e a classificacao nao e lista paralela — §12 ─────

secao("B. Composio ou nativo: derivado, nunca listado — §12");

{
  // O pack que exige conexao declara a plataforma nas FUNCOES dele. Se a
  // classificacao virasse uma lista de packs neste arquivo, um pack novo
  // entraria calado no mundo errado.
  ok("B1  a plataforma vem do registry, e nao de um mapa de packs",
    /requisitosDeConexaoDoPack\(packId\)\.map\(\(r\) => r\.plataforma\)/.test(COMPLETAR) &&
      !/MARKETPLACE_DO_PACK/.test(COMPLETAR));
  ok("B2  e duas plataformas no mesmo pack NAO viram escolha automatica",
    /plataformas\.size !== 1/.test(COMPLETAR));

  // MEDIDO: `lojas.marketplace` guarda "ML", e nao o slug. Consultar com o
  // slug devolveria zero linha sempre — e o efeito seria pedir ao dono
  // para conectar um Mercado Livre que ele ja conectou.
  ok("B3  a consulta a `lojas` passa pelo tradutor canonico",
    /MARKETPLACE_POR_PLATAFORMA\[marketplace\]/.test(COMPLETAR) &&
      /listarLojasConectadasDoDono\(entrada\.userId, valorNoBanco\)/.test(COMPLETAR));
  ok("B3a e o valor do banco NAO e o slug da plataforma",
    MARKETPLACE_POR_PLATAFORMA["mercado_livre"] === "ML");
  ok("B3b nenhum valor do mapa coincide com a chave dele",
    Object.entries(MARKETPLACE_POR_PLATAFORMA).every(([k, v]) => k !== v),
    Object.entries(MARKETPLACE_POR_PLATAFORMA).map(([k, v]) => `${k}=${v}`).join(","));

  // `vendas` le `pedidos` que o sync ja trouxe: exigir OAuth dele seria
  // pedir duas vezes o que o dono ja deu.
  const vendas = TOOL_PACKS.find((p) => p.id === "vendas");
  ok("B4  `vendas` NAO exige conexao — ele le o que o sync ja trouxe",
    vendas !== undefined && vendas.exigeConexao === false);
  ok("B4a e nenhuma Funcao dele declara requisito de conexao",
    (vendas?.funcoes ?? []).every((f) =>
      FUNCOES[f] === undefined || FUNCOES[f].conexaoNecessaria === null));
}

// ─── C. §16 Shopee: a resposta e MEDIDA ──────────────────────────────

secao("C. Shopee — a resposta e medida, nao afirmada — §16");

{
  // O contrato e agnostico de marketplace: o tradutor cobre a Shopee, e
  // `faltaParaCompletar` nao tem `if` de plataforma nenhum.
  ok("C1  o tradutor canonico cobre a Shopee",
    MARKETPLACE_POR_PLATAFORMA["shopee"] === "Shopee");
  ok("C2  e `completar-capacidade` nao tem ramo por plataforma",
    !/=== "mercado_livre"|=== "shopee"|=== "ML"|=== "Shopee"/.test(COMPLETAR));

  // E aqui esta a medicao que decide a resposta do §16: HOJE nenhuma
  // Funcao do registry pede conexao de Shopee. Entao o contrato aceita a
  // Shopee e NAO EXISTE capacidade que a use — a classificacao honesta e
  // "suportado pelo contrato, sem capacidade", e nao "suportado".
  //
  // Criar uma Funcao de Shopee e dominio funcional novo, fora deste gate.
  const plataformasPedidas = new Set<string>();
  for (const id of Object.keys(FUNCOES)) {
    const r = FUNCOES[id].conexaoNecessaria;
    if (r !== null) plataformasPedidas.add(r.plataforma);
  }
  ok("C3  MEDIDO: a unica plataforma pedida por alguma Funcao e o ML",
    JSON.stringify([...plataformasPedidas].sort()) === JSON.stringify(["mercado_livre"]),
    [...plataformasPedidas].join(",") || "nenhuma");
  ok("C4  logo NENHUMA capacidade de Shopee existe para exercitar o fluxo",
    !plataformasPedidas.has("shopee"));
  ok("C4a ANCORA: a varredura enxergou requisito de verdade",
    plataformasPedidas.size >= 1);
}

// ─── D. Completar a capacidade NAO tira ninguem do chat — §24 ─────────

secao("D. O fluxo termina no chat — §24");

{
  // O aviso antigo mandava abrir Ferramentas para autorizar. Era esse o
  // defeito: a pessoa saia do chat e perdia o que estava fazendo.
  ok("D1  o chat nao manda mais abrir Ferramentas para autorizar",
    !/abra Ferramentas na configura/i.test(CHAT));
  ok("D2  e nao navega para outra tela no meio do fluxo",
    !/next\/link|useRouter|router\.push|window\.location\s*=/.test(CHAT));

  // Tres estados, tres perguntas. O cartao de ESCOLHER FERRAMENTA so
  // aparece em `pendente`: dois cartoes juntos perguntariam duas coisas.
  ok("D3  o cartao de ferramenta so aparece em `pendente`",
    /capacidade !== null && capacidade\.estado === "pendente"/.test(CHAT));
  ok("D4  o de conectar aparece nos estados de conexao",
    /"aguardando_conexao" \|\| cap\.estado === "conectando"/.test(CHAT));
  ok("D5  e o de loja em `escolhendo_loja`",
    /cap\.estado === "escolhendo_loja"/.test(CHAT));

  // §25: voltar do consentimento confere sozinho — UMA vez por pendencia.
  // Sem o travamento, uma conexao que ainda nao existe viraria laco.
  ok("D6  a conferencia automatica acontece uma vez por pendencia",
    /conferidaAoVoltar\.current === capacidade\.pendenciaId/.test(CHAT) &&
      /conferidaAoVoltar\.current = capacidade\.pendenciaId/.test(CHAT));
  ok("D7  e o que ainda falta vem do SERVIDOR, nao da tela",
    /setPrecisaConectar\(r\.dados\.precisaConectar\)/.test(CHAT) &&
      /setEscolherLoja\(r\.dados\.escolherLoja\)/.test(CHAT));

  // §26: nada e apagado. As mensagens sao ACRESCENTADAS.
  const CHAT_CODIGO = semComentarios(CHAT);
  ok("D8  a retomada acrescenta mensagens, e nao substitui a conversa",
    /setMensagens\(\(atual\) => \[\s*\.\.\.atual,/.test(CHAT_CODIGO) &&
      !/setMensagens\(\[\]\)/.test(CHAT_CODIGO));
  ok("D8a ANCORA: o comentario que CITA a regra foi removido da medicao",
    /setMensagens\(\[\]\)/.test(CHAT) && !/setMensagens\(\[\]\)/.test(CHAT_CODIGO));
  ok("D8b CONTROLE NEGATIVO: a sonda acusa a limpeza em codigo de verdade",
    /setMensagens\(\[\]\)/.test(semComentarios("  setMensagens([]);")));
}

// ─── E. O modelo nunca escolhe autoridade — §30 ───────────────────────

secao("E. Loja, dono e conta nao vem do cliente — §30");

{
  // A rota le a ESCOLHA da linha congelada. O cliente diz `lojaId`, e ele
  // e conferido contra a lista oferecida — nao aceito porque foi enviado.
  ok("E1  a chave e a origem vem da pendencia gravada",
    /pendencia\.escolhaChave/.test(ROTA_CONEXAO) &&
      /pendencia\.escolhaOrigem/.test(ROTA_CONEXAO));
  ok("E2  o `lojaId` recebido e conferido contra as lojas oferecidas",
    /Loja inv[aá]lida/.test(ROTA_CONEXAO));
  ok("E3  e o dono NUNCA vem do corpo do pedido",
    !/corpo\?\.userId|corpo\.userId|corpo\?\.ownerId|body\.userId/.test(ROTA_CONEXAO));
  ok("E4  nem a conta conectada",
    !/corpo\?\.contaId|corpo\.contaId|corpo\?\.connectedAccountId/.test(ROTA_CONEXAO));
  ok("E5  o dono sai da porta autenticada",
    /porta\.userId/.test(ROTA_CONEXAO));

  // §8: a transicao E a idempotencia. Sem `de: [...]`, dois retornos do
  // OAuth retomariam a tarefa duas vezes.
  ok("E6  a conclusao so parte de um estado VIVO",
    /de: \["aguardando_conexao", "conectando", "escolhendo_loja"\], para: "concluida"/
      .test(ROTA_CONEXAO));
  ok("E7  e o segundo retorno nao chama o modelo de novo",
    /ja_decidida/.test(ROTA_CONEXAO) && /jaRetomada: true/.test(ROTA_CONEXAO));

  // §10: expirou e nunca conectou sao frases diferentes, e o sinal vem do
  // servidor. A tela nao adivinha por quanto tempo a conta existiu.
  ok("E8  `reconectar` e decidido no servidor",
    /falta\.reconectar/.test(ROTA_CONEXAO));
  ok("E9  e a tela so escolhe a FRASE com ele",
    /precisaConectar\.reconectar/.test(CHAT) &&
      /Reconectar/.test(CHAT));
}

console.log(`\nPASS ${pass}   FAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);
