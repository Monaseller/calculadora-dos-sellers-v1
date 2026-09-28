/**
 * CDS IA — M2-I1-A8B-I4O4. A ponte generica APOSENTADA.
 *
 * ── O que esta suite provava, e por que deixou de provar ────────────
 *
 * Ate o I4O2 ela provava o CONTRATO de `POST /api/internal/agentes/acoes`:
 * autenticacao por segredo proprio, catalogo fechado, dono resolvido no
 * banco, execucao de Funcao, replay, aprovacao e sanitizacao. No I4O2 a
 * rota entrou em quarentena terminal (410). No I4O3, uma janela de
 * observacao de 70 h 44 min em producao nao registrou UM unico caller
 * autenticado. No I4O4 a rota foi REMOVIDA.
 *
 * ── Por que isto nao e perda de cobertura ───────────────────────────
 *
 * As dezenas de asserts que provavam a inercia da rota — que ela nao
 * importava catalogo, nao lia o corpo, nao derivava dono, nao montava
 * `lojaId`, nao chamava `executarFuncao` — foram substituidas pelo fato
 * mais forte que existe sobre um arquivo: ELE NAO EXISTE. Um arquivo
 * ausente nao importa nada, nao le corpo nenhum e nao alcanca Funcao
 * alguma, e nao ha mutante capaz de faze-lo voltar em silencio.
 *
 * O que NAO foi apagado e o que nunca foi da rota: o catalogo de acoes e
 * o union do executor de Funcoes. Aquelas provas continuam aqui, palavra
 * por palavra, porque os dois modulos continuam em producao.
 *
 * ── O oraculo de recriacao ──────────────────────────────────────────
 *
 * A secao A reprova se alguem recriar o arquivo da rota. Voltar a ter
 * uma superficie generica e uma decisao de arquitetura — nao um commit.
 *
 * Zero rede. Zero banco. Zero escrita em producao.
 *
 * Rodar:  npx tsx scripts/testar-agentes-ponte-n8n.ts
 */
import "./_server-only-inerte";

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

let passou = 0;
let falhou = 0;

function ok(nome: string, condicao: boolean, detalhe = ""): void {
  if (condicao) {
    passou++;
    console.log(`  PASS  ${nome}`);
  } else {
    falhou++;
    console.log(`  FAIL  ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
  }
}

function secao(titulo: string): void {
  console.log(`\n── ${titulo} ${"─".repeat(Math.max(2, 60 - titulo.length))}`);
}

const RAIZ = join(__dirname, "..");
const ler = (rel: string) => readFileSync(join(RAIZ, rel), "utf8");
const semComentarios = (f: string) =>
  f.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const ID_ML = "mercadolivre.perguntas.listar";
const ACAO = "consultar_perguntas";
const ID_VENDAS = "vendas.consultar";
const ACAO_VENDAS = "consultar_vendas";

const ROTA_APOSENTADA = "app/api/internal/agentes/acoes/route.ts";
const PASTA_APOSENTADA = "app/api/internal/agentes/acoes";
const CAMINHO_APOSENTADO = "/api/internal/agentes/acoes";

/**
 * Todo arquivo de RUNTIME. `scripts/` e `docs/` ficam de fora de
 * proposito: suite e documentacao podem — e devem — continuar falando da
 * rota aposentada, senao o proximo leitor nao descobre que ela existiu.
 * O que nao pode e codigo servido em producao mencionando-a.
 */
function fontesDeRuntime(): readonly string[] {
  const saida: string[] = [];
  const andar = (rel: string) => {
    for (const nome of readdirSync(join(RAIZ, rel))) {
      if (nome === "node_modules" || nome === ".next" || nome.startsWith(".")) continue;
      const filho = rel + "/" + nome;
      if (statSync(join(RAIZ, filho)).isDirectory()) andar(filho);
      else if (/\.(ts|tsx|mjs|js)$/.test(nome)) saida.push(filho);
    }
  };
  for (const raiz of ["app", "lib", "components"]) andar(raiz);
  return saida;
}

async function main(): Promise<void> {
  console.log("\n══ CDS IA — I4O4: a ponte generica aposentada ══");

  const { resolverAcao, acoesRegistradas } = await import("../lib/agentes/acoes/catalogo");
  const { decidirAcesso, ROTAS_COM_SEGREDO } = await import("../lib/middleware-rotas");

  const CATALOGO = semComentarios(ler("lib/agentes/acoes/catalogo.ts"));
  const RUNTIME = fontesDeRuntime();

  // ═══ A. Aposentadoria ═══════════════════════════════════════════════
  secao("A. Aposentadoria da superficie generica");

  ok("I4O4-A1 o arquivo da rota NAO existe",
    !existsSync(join(RAIZ, ROTA_APOSENTADA)));
  ok("I4O4-A2 e a pasta dela tambem nao",
    !existsSync(join(RAIZ, PASTA_APOSENTADA)));
  ok("I4O4-A3 CONTROLE DE ANTI-VACUIDADE: o oraculo de ausencia sabe dizer SIM",
    existsSync(join(RAIZ, "app/api/internal/agentes/ingestao-perguntas/route.ts")));

  ok("I4O4-A4 a policy do middleware nao declara mais o caminho",
    !(CAMINHO_APOSENTADO in ROTAS_COM_SEGREDO));
  ok("I4O4-A5 e o middleware passa a NEGAR o caminho, em todo verbo",
    ["POST", "GET", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].every(
      (m) => decidirAcesso(CAMINHO_APOSENTADO, m, false) === "bloquear_api"));

  {
    // Nenhum arquivo de runtime pode ter CODIGO que alcance o caminho, o
    // codigo terminal da quarentena ou o evento da janela de observacao:
    // os tres existiam so para a rota que saiu.
    //
    // A varredura le apenas linhas EXECUTAVEIS — comentario e strippado
    // antes. Prosa que conta a historia da rota aposentada e desejavel, e
    // um oraculo que a proibisse forcaria a apagar a explicacao de por que
    // a rota dedicada existe. O que nao pode e chamada, literal de
    // caminho ou constante viva.
    const executavel = (f: string) => semComentarios(ler(f));
    const comCaminho = RUNTIME.filter((f) => executavel(f).includes(CAMINHO_APOSENTADO));
    const comCodigo = RUNTIME.filter((f) => executavel(f).includes("main_generico_em_aposentadoria"));
    const comEvento = RUNTIME.filter((f) => executavel(f).includes("MAIN_GENERIC_QUARANTINE_HIT"));
    ok("I4O4-A6 zero referencias EXECUTAVEIS de runtime ao caminho aposentado",
      comCaminho.length === 0, comCaminho.join(", "));
    ok("I4O4-A7 zero referencias executaveis ao codigo de aposentadoria",
      comCodigo.length === 0, comCodigo.join(", "));
    ok("I4O4-A8 zero referencias executaveis ao evento de quarentena",
      comEvento.length === 0, comEvento.join(", "));
    ok("I4O4-A9 CONTROLE: a varredura de runtime enxerga arquivos de verdade",
      RUNTIME.length > 100 &&
      RUNTIME.includes("app/api/internal/agentes/ingestao-perguntas/route.ts"));
    // CONTROLE NEGATIVO do strip: com o comentario PRESERVADO, a prosa
    // historica aparece — o que prova que o oraculo acima esta medindo o
    // strip, e nao um repositorio onde a string simplesmente nao existe.
    const comProsa = RUNTIME.filter((f) => ler(f).includes(CAMINHO_APOSENTADO));
    ok("I4O4-A9b CONTROLE NEGATIVO: sem strip, a prosa historica seria acusada",
      comProsa.length > 0, "nenhum arquivo cita a rota aposentada nem em comentario");
  }

  {
    // O segredo da ponte generica perde o unico leitor de runtime que
    // tinha. A VARIAVEL nao e removida neste gate — isso e decisao
    // separada, e apagar segredo de producao junto com codigo e como se
    // perde acesso sem perceber.
    const leitores = RUNTIME.filter((f) => ler(f).includes("process.env.N8N_BRIDGE_INTERNAL_SECRET"));
    ok("I4O4-A10 nenhum arquivo de runtime LE mais N8N_BRIDGE_INTERNAL_SECRET",
      leitores.length === 0, leitores.join(", "));
  }

  ok("I4O4-A11 a rota DEDICADA da ingestao sobreviveu",
    existsSync(join(RAIZ, "app/api/internal/agentes/ingestao-perguntas/route.ts")) &&
    JSON.stringify(ROTAS_COM_SEGREDO["/api/internal/agentes/ingestao-perguntas"]) === '["POST"]' &&
    decidirAcesso("/api/internal/agentes/ingestao-perguntas", "POST", false) === "liberar");
  ok("I4O4-A12 e ela continua com o segredo PROPRIO dela",
    /process\.env\.N8N_INGESTAO_INTERNAL_SECRET/.test(
      semComentarios(ler("app/api/internal/agentes/ingestao-perguntas/route.ts"))));

  // ═══ B. Catalogo fechado ════════════════════════════════════════════
  //
  // O catalogo NUNCA foi da rota: ele traduz acao de produto em Funcao e
  // continua em producao, alcancado por `/api/agentes/[agenteId]/
  // consultar-vendas`. Tudo nesta secao veio da suite anterior sem uma
  // virgula mudada.
  secao("B. O catalogo de acoes");

  ok("N8N-BRIDGE-3 a acao conhecida mapeia para a Funcao EXATA",
    resolverAcao(ACAO)?.funcaoId === ID_ML);
  // MUT-9: a acao de vendas tem de resolver `vendas.consultar`, e nao
  // qualquer outra — trocar o alvo aqui executaria a Funcao errada com
  // os argumentos certos, que e o pior desfecho possivel.
  ok("N8N-BRIDGE-3g `consultar_vendas` mapeia para `vendas.consultar`",
    resolverAcao(ACAO_VENDAS)?.funcaoId === ID_VENDAS);
  ok("N8N-A8B-MUT-9 CONTROLE NEGATIVO: as duas acoes nao apontam para a mesma Funcao",
    resolverAcao(ACAO)?.funcaoId !== resolverAcao(ACAO_VENDAS)?.funcaoId);
  // ANTI-VACUIDADE: conjunto EXATO, nunca `includes` nem `>= 2`. Uma
  // terceira acao que ninguem revisou reprova aqui.
  ok("N8N-BRIDGE-3a e ha exatamente DUAS acoes registradas",
    JSON.stringify([...acoesRegistradas()].sort()) ===
      JSON.stringify([ACAO_VENDAS, ACAO].sort()));
  ok("N8N-BRIDGE-3h CONTROLE NEGATIVO: o oraculo reprova uma acao a mais",
    JSON.stringify([...acoesRegistradas(), "consultar_anuncios"].sort()) !==
      JSON.stringify([ACAO_VENDAS, ACAO].sort()));

  // ─── Contratos de argumento, por acao ───────────────────────────────
  //
  // MUT-11/MUT-12: o cruzamento e o defeito que esta separacao existe
  // para impedir. Uma whitelist global seria a UNIAO das duas listas, e
  // `dataInicio` passaria em `consultar_perguntas` sem que nada acusasse.
  ok("N8N-BRIDGE-3d perguntas aceita EXATAMENTE status/limite/deslocamento",
    JSON.stringify([...(resolverAcao(ACAO)?.argumentos ?? [])].sort()) ===
      JSON.stringify(["deslocamento", "limite", "status"]));
  ok("N8N-BRIDGE-3e vendas aceita EXATAMENTE dataInicio/dataFim/marketplace",
    JSON.stringify([...(resolverAcao(ACAO_VENDAS)?.argumentos ?? [])].sort()) ===
      JSON.stringify(["dataFim", "dataInicio", "marketplace"]));
  ok("N8N-BRIDGE-3f os dois contratos sao DISJUNTOS",
    (resolverAcao(ACAO)?.argumentos ?? []).every(
      (k) => !(resolverAcao(ACAO_VENDAS)?.argumentos ?? []).includes(k)));
  // MUT-10: se `vendas.consultar` passar a exigir conexao, o caminho de
  // prova sem binding deixa de existir — em silencio.
  ok("N8N-A8B-MUT-10b `vendas.consultar` segue com `conexaoNecessaria: null`",
    /"vendas\.consultar":\s*Object\.freeze\(\{[\s\S]*?conexaoNecessaria:\s*null/
      .test(semComentarios(ler("lib/agentes/funcoes/registry.ts"))));
  ok("N8N-BRIDGE-4 acao desconhecida nao resolve",
    resolverAcao("consultar_anuncios") === null);
  ok("N8N-MUT-10 chaves de PROTOTIPO nao resolvem acao",
    resolverAcao("toString") === null &&
    resolverAcao("constructor") === null &&
    resolverAcao("__proto__") === null &&
    resolverAcao("hasOwnProperty") === null);
  ok("N8N-BRIDGE-4a CONTROLE: acesso direto ao mapa acharia `toString`",
    typeof ({} as Record<string, unknown>)["toString"] === "function");
  ok("N8N-SEC-2 o catalogo usa `hasOwnProperty` e `Object.freeze`",
    /Object\.prototype\.hasOwnProperty\.call/.test(CATALOGO) &&
    /Object\.freeze/.test(CATALOGO));
  ok("N8N-BRIDGE-3b a string da Funcao nao e redigitada no catalogo",
    /FUNCAO_ID as FUNCAO_PERGUNTAS_ML/.test(ler("lib/agentes/acoes/catalogo.ts")) &&
    !/"mercadolivre\.perguntas\.listar"/.test(CATALOGO));
  ok("N8N-SEC-3a e a de vendas tambem vem por import, nao redigitada",
    /FUNCAO_ID as FUNCAO_VENDAS/.test(ler("lib/agentes/acoes/catalogo.ts")) &&
    !/"vendas\.consultar"/.test(CATALOGO));

  // ═══ C. O executor de Funcoes ═══════════════════════════════════════
  //
  // Tambem nunca foi da rota. `executar.ts` e o executor de TODA Funcao,
  // e continua servido em producao.
  secao("C. O union do executor de Funcoes");

  {
    // NOMINAL, e nao contagem: o arquivo tem OUTRO union (`valida` /
    // `invalida` / `erro_interno`), e contar `tipo: "` no arquivo inteiro
    // media os dois juntos. O recorte pega so o bloco do union publico.
    const EXEC = semComentarios(ler("lib/agentes/execucao-funcoes/executar.ts"));
    const inicio = EXEC.indexOf("export type ResultadoExecucaoFuncao =");
    const bloco = EXEC.slice(inicio, EXEC.indexOf("\n\n", inicio));
    const variantes = [...bloco.matchAll(/tipo:\s*"([a-z_]+)"/g)].map((m) => m[1]);
    const SETE = [
      "aguardando_aprovacao", "aprovacao_indisponivel", "erro",
      "falha_auditoria", "indisponivel", "negado", "sucesso",
    ];
    ok("N8N-MUT-16 o executor continua com as SETE variantes nominais",
      JSON.stringify([...variantes].sort()) === JSON.stringify(SETE));
    ok("N8N-MUT-16a CONTROLE: uma oitava variante reprovaria",
      JSON.stringify([...variantes, "duplicada"].sort()) !== JSON.stringify(SETE));
  }
  ok("N8N-MUT-13 `motivo: \"duplicada\"` so nasce do estado `duplicada`",
    /abertura\.estado === "duplicada" \? \{ motivo: "duplicada" as const \} : \{\}/
      .test(ler("lib/agentes/execucao-funcoes/executar.ts")));

  const total = passou + falhou;
  console.log(`\n══ CDS IA — I4O4: ponte generica aposentada:  ${passou}/${total} passaram ══`);
  if (falhou > 0) console.log(`   ${falhou} FALHARAM`);
  console.log("   MAIN_GENERIC_ROUTE = REMOVED / N8N_REAL_CONNECTED = NO / REAL_DB_WRITE = NO");
  process.exitCode = falhou === 0 ? 0 : 1;
}

void main();
