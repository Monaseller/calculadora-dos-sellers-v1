/**
 * CDS IA — SKILL-1D.ui-consumer-C. Suite da primeira UI com dados reais.
 *
 * Duas coisas sao protegidas aqui, e nenhuma delas e aparencia.
 *
 * ── 1. A FRONTEIRA ──────────────────────────────────────────────────
 *
 * A area de IA passou a ter rede, e passou a ter num arquivo so. Se
 * amanha um componente visual ganhar o proprio `fetch`, o endereco e o
 * tratamento de status voltam a se espalhar — e e exatamente isso que
 * as sondas nominais desta suite (e as cinco suites historicas da area)
 * existem para impedir.
 *
 * ── 2. O QUE O TRANSPORTE FAZ COM CADA RESPOSTA ─────────────────────
 *
 * As funcoes REAIS de `lib/ia/agentes-http.ts` sao executadas contra um
 * `fetch` duplado. O que se afirma nao e "o mock devolveu o esperado",
 * e sim que 401 vira sessao expirada, que 500 vira falha, que corpo
 * torto vira falha — e que NENHUM dos tres vira lista vazia. Uma tela
 * que diz "voce nao tem agentes" quando na verdade nao conseguiu
 * perguntar e o defeito que esta suite persegue.
 *
 * Nao renderiza React: prova por leitura de fonte e por execucao das
 * funcoes puras, como as demais suites desta area.
 *
 * Rodar:  npx tsx scripts/testar-ia-agentes-ui-source.ts
 * Sem rede, sem banco, sem `--confirmo`.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
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
  console.log(`\n── ${titulo} ${"─".repeat(Math.max(0, 62 - titulo.length))}`);
}

const RAIZ = join(__dirname, "..");
const ler = (rel: string) => readFileSync(join(RAIZ, rel), "utf8");
const codigo = (f: string) =>
  f.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const TRANSPORTE = "lib/ia/agentes-http.ts";
const LISTA = "app/(app)/ia/agentes/page.tsx";
const ROTA_DETALHE = "app/(app)/ia/agentes/[id]/page.tsx";
const CONTAINER = "components/ia/agente/PaginaAgente.tsx";

/** A area varrida pelas cinco suites historicas, na mesma definicao. */
function arquivosDe(dirRel: string): string[] {
  const saida: string[] = [];
  const caminhar = (rel: string) => {
    for (const nome of readdirSync(join(RAIZ, rel))) {
      const filho = `${rel}/${nome}`;
      if (statSync(join(RAIZ, filho)).isDirectory()) caminhar(filho);
      else saida.push(filho);
    }
  };
  caminhar(dirRel);
  return saida.sort();
}
const AREA = [
  ...arquivosDe("lib/ia"),
  ...arquivosDe("components/ia"),
  ...arquivosDe("app/(app)/ia"),
];

const CODIGO_TRANSPORTE = codigo(ler(TRANSPORTE));

console.log("\n══ CDS IA — SKILL-1D.ui-consumer-C: a UI com fonte real ══");

// ─── A. A fronteira de rede ───────────────────────────────────────────

secao("A. Um ponto de rede, e um so");

{
  const comRede = AREA.filter((a) => /\bfetch\s*\(|XMLHttpRequest|axios|WebSocket/.test(codigo(ler(a))));
  ok("A1  exatamente UM arquivo da area tem rede",
    JSON.stringify(comRede) === JSON.stringify([TRANSPORTE]), comRede.join(", "));

  const comEndereco = AREA.filter((a) => /["'`]\/api\//.test(codigo(ler(a))));
  ok("A2  e exatamente UM constroi endereco de API",
    JSON.stringify(comEndereco) === JSON.stringify([TRANSPORTE]), comEndereco.join(", "));

  ok("A3  ANCORA: a varredura leu a area de verdade", AREA.length > 40, String(AREA.length));
  ok("A4  CONTROLE: a sonda de rede acusa quando o padrao existe",
    /\bfetch\s*\(/.test("await fetch(url)"));

  ok("A5  o transporte nao tem React nem hook",
    !/from "react"|useState|useEffect|useMemo|\.tsx/.test(CODIGO_TRANSPORTE));
  ok("A6  zero import de dominio de agentes",
    !/lib\/agentes|diagnosticarAgente|diagnosticarSkill|resolverSkillsDoAgente|resolverConexoesDoAgente|resolverFatosPermissoes/
      .test(CODIGO_TRANSPORTE));
  ok("A7  zero cliente de banco",
    !/getSupabaseServidor|createClient|service_role/i.test(CODIGO_TRANSPORTE));
  ok("A8  zero leitura de ambiente", !/process\.env/.test(CODIGO_TRANSPORTE));
}

secao("B. O que a UI NAO manda");

{
  const paraOServidor = [LISTA, ROTA_DETALHE, CONTAINER, TRANSPORTE];

  ok("B1  nenhum arquivo envia identificador de quem pergunta",
    paraOServidor.every((a) => !/\buserId\b|\buid\b/.test(codigo(ler(a)))));
  ok("B2  nenhum arquivo envia relogio do cliente",
    paraOServidor.every((a) => !/\bagoraMs\s*:/.test(codigo(ler(a)))) &&
      !/agoraMs/.test(CODIGO_TRANSPORTE));
  // B3 juntava duas coisas que a criacao separou: "nenhuma credencial
  // manual" (permanente) e "nenhum header" (de fase — enquanto so havia
  // GET, header nenhum era necessario). Um corpo JSON exige
  // `Content-Type`, e so ele. A parte de credencial NAO afrouxa; a de
  // header passa a ser allowlist do proprio cabecalho.
  ok("B3  zero credencial manual em qualquer arquivo da frente",
    paraOServidor.every(
      (a) => !/Authorization|[Bb]earer|document\.cookie/.test(codigo(ler(a)))
    ));
  ok("B3b headers so no transporte nominal",
    AREA.filter((a) => /headers\s*:/.test(codigo(ler(a)))).join(",") === TRANSPORTE,
    AREA.filter((a) => /headers\s*:/.test(codigo(ler(a)))).join(", ") || "nenhum");
  // ── B3c reconciliado na AGENT-VERTICAL-SLICE-V1-I3 ──────────────
  //
  // Passaram a existir DUAS escritas, e cada corpo JSON traz o seu
  // `Content-Type`. A invariavel nao afrouxa: continua sendo "o unico
  // cabecalho enviado e o do corpo JSON" — mudou quantas vezes ele
  // aparece. TODA ocorrencia de `headers:` tem de ser exatamente aquele
  // cabecalho, e nenhuma credencial entra junto.
  //
  // ── B3c reconciliado de novo na EDITAR-AGENTE-V1 ────────────────
  //
  // TRES corpos JSON, tres `Content-Type`. A invariavel continua sendo
  // "o unico cabecalho enviado e o do corpo JSON": as duas contagens
  // sao comparadas ENTRE SI, entao um `headers:` que nao seja aquele
  // cabecalho reprova, e o veto a credencial no cabecalho nao mudou.
  ok("B3c os UNICOS cabecalhos sao os cinco Content-Type do corpo JSON",
    (CODIGO_TRANSPORTE.match(/headers\s*:/g) ?? []).length === 5 &&
      (CODIGO_TRANSPORTE.match(/headers: \{ "Content-Type": "application\/json" \}/g) ?? [])
        .length === 5 &&
      !/"X-|Cookie|Api-Key|Idempotency-Key/i.test(CODIGO_TRANSPORTE));
  ok("B4  `credentials` omitido — o cookie same-origin ja viaja sozinho",
    !/credentials/.test(CODIGO_TRANSPORTE));
  // As duas LEITURAS continuam GET puro — o que mudou foi a existencia
  // de UMA escrita. `method` e `body` deixam de ser proibidos no arquivo
  // e passam a ser exclusivos de `criarAgenteViaApi`: o corpo de cada
  // funcao e recortado e medido separadamente, para que um `body` que
  // aparecesse em `listarAgentes` reprovasse.
  const corpoDaFuncao = (nome: string): string => {
    const i = CODIGO_TRANSPORTE.indexOf(`export async function ${nome}(`);
    if (i < 0) return "";
    const resto = CODIGO_TRANSPORTE.slice(i + 1);
    const j = resto.indexOf("\nexport ");
    return j < 0 ? resto : resto.slice(0, j);
  };
  // A consulta de conversa entra AQUI, entre as leituras, e nao entre as
  // escritas: ela e GET puro. Classificar toda funcao que cita
  // `/conversa` como escrita confundiria acompanhar com criar.
  // ── B5 reconciliado na PERMISSOES-FUNCTION-V1-B ─────────────────
  //
  // Entrou a QUARTA leitura, `listarPermissoesDoAgente`. A lista e
  // NOMINAL, e por isso precisou crescer: se continuasse com tres
  // nomes, o leitor novo ficaria INVISIVEL — poderia ganhar `method` ou
  // `body` sem ninguem notar, e este assert seguiria verde afirmando
  // que "as leituras sao GET puro". Mesma armadilha que o filtro por
  // `"POST"` teria criado nas escritas.
  const LEITURAS_AUTORIZADAS = [
    "listarAgentes",
    "obterDiagnostico",
    "consultarConversaDoAgente",
    "listarPermissoesDoAgente",
    // FUNCTION-RUNTIME-V1-B2B: o acompanhamento da tarefa de vendas.
    // Leitura pura — nao cria tarefa, nao reexecuta, nao aciona o
    // dispatcher.
    "consultarConsultaVendasDoAgente",
  ];
  /** Toda funcao exportada SEM `method:` e uma leitura. */
  const leiturasReais = [...CODIGO_TRANSPORTE.matchAll(/export async function (\w+)\(/g)]
    .map((m) => m[1])
    .filter((nome) => !/method\s*:/.test(corpoDaFuncao(nome)))
    .sort();
  const leiturasEsperadas = JSON.stringify([...LEITURAS_AUTORIZADAS].sort());

  ok("B5  as quatro leituras continuam GET puro, sem method e sem corpo",
    LEITURAS_AUTORIZADAS.every((f) => {
      const corpo = corpoDaFuncao(f);
      return corpo.length > 50 && !/method\s*:|body\s*:/.test(corpo);
    }));
  ok("B5a0 e as leituras publicadas sao EXATAMENTE as quatro nominais",
    JSON.stringify(leiturasReais) === leiturasEsperadas,
    leiturasReais.join(", ") || "nenhuma");
  ok("B5a1 CONTROLE NEGATIVO: um leitor sumir reprovaria",
    JSON.stringify([...LEITURAS_AUTORIZADAS].slice(1).sort()) !== leiturasEsperadas);
  ok("B5a2 CONTROLE NEGATIVO: um QUINTO leitor reprovaria",
    JSON.stringify([...LEITURAS_AUTORIZADAS, "listarQualquerOutraCoisa"].sort()) !==
      leiturasEsperadas);
  ok("B5a3 CONTROLE NEGATIVO: TROCA mantendo o total de quatro reprovaria",
    JSON.stringify(
      ["listarAgentes", "obterDiagnostico", "consultarConversaDoAgente", "outraLeitura"].sort()
    ) !== leiturasEsperadas);
  ok("B5a4 ANCORA: a varredura enxergou leitores de verdade",
    leiturasReais.length === 5 && corpoDaFuncao("listarPermissoesDoAgente").length > 50);
  // A leitura de permissoes e leitura: nao define nada, nao cria linha e
  // nao executa Funcao.
  ok("B5a5 a leitura de permissoes repassa o sinal e nao escreve",
    /signal\?: AbortSignal/.test(corpoDaFuncao("listarPermissoesDoAgente")) &&
      /\{ signal \}/.test(corpoDaFuncao("listarPermissoesDoAgente")));
  // ── B5b reconciliado na AGENT-VERTICAL-SLICE-V1-I3 ──────────────
  //
  // ANTES: "method e body existem SO na capacidade de criacao" — UMA
  // escrita, a de agente. DEPOIS: DUAS escritas, nomeadas, e somente
  // essas duas. Nao virou `>= 2` nem contagem solta — a suite sabe
  // QUAIS sao, por igualdade de conjunto nos dois sentidos.
  //
  // ── B5b reconciliado de novo na EDITAR-AGENTE-V1 ────────────────
  //
  // A doutrina antiga era "esta area cria, nunca altera nem apaga", e o
  // filtro por `method: "POST"` a expressava. A revogacao foi ratificada
  // e e PARCIAL: entra PATCH, para UM recurso e DOIS campos.
  //
  // Trocar o filtro importa mais do que trocar a contagem. Se ele
  // continuasse so olhando POST, a funcao de PATCH ficaria INVISIVEL e
  // este assert seguiria verde afirmando "exatamente duas escritas" —
  // protecao que morre sem ninguem perceber. Agora o conjunto e de
  // VERBOS: toda funcao com `method:` e uma escrita, e cada uma tem de
  // bater com o verbo que lhe foi autorizado, nominalmente.
  //
  // ── E de novo na PERMISSOES-FUNCTION-V1-B ───────────────────────
  //
  // Quarta escrita: `definirPermissaoDeFuncao`, por PATCH. O mapa
  // continua sendo de VERBOS, e nao de nomes — e por isso a chegada de
  // um SEGUNDO PATCH nao afrouxa nada: cada funcao tem de bater com o
  // verbo que lhe foi autorizado, individualmente.
  const VERBOS_AUTORIZADOS: Readonly<Record<string, string>> = {
    criarAgenteViaApi: "POST",
    enviarMensagemAoAgente: "POST",
    // FUNCTION-RUNTIME-V1-B2B: enfileira `consultar_vendas`. POST porque
    // CRIA uma tarefa — e so isso: quem executa e o dispatcher.
    criarConsultaVendasDoAgente: "POST",
    atualizarAgenteViaApi: "PATCH",
    definirPermissaoDeFuncao: "PATCH",
  };
  const ESCRITAS_AUTORIZADAS = Object.keys(VERBOS_AUTORIZADOS);
  const verboDaFuncao = (nome: string): string | null =>
    /method:\s*"([A-Z]+)"/.exec(corpoDaFuncao(nome))?.[1] ?? null;

  const escritasReais = [...CODIGO_TRANSPORTE.matchAll(/export async function (\w+)\(/g)]
    .map((m) => m[1])
    .filter((nome) => verboDaFuncao(nome) !== null)
    .sort();
  const esperadas = JSON.stringify([...ESCRITAS_AUTORIZADAS].sort());

  /** O par funcao=verbo, que e o que de fato esta sendo protegido: o
   *  conjunto sozinho passaria se `atualizarAgenteViaApi` virasse PUT. */
  const pares = (mapa: Readonly<Record<string, string>>): string =>
    JSON.stringify(Object.keys(mapa).sort().map((n) => `${n}=${mapa[n]}`));
  const paresReais = JSON.stringify(escritasReais.map((n) => `${n}=${verboDaFuncao(n)}`));

  ok("B5b as escritas publicadas sao EXATAMENTE as tres nominais",
    JSON.stringify(escritasReais) === esperadas, escritasReais.join(", ") || "nenhuma");
  ok("B5b0 cada escrita usa EXATAMENTE o verbo autorizado para ela",
    paresReais === pares(VERBOS_AUTORIZADOS),
    escritasReais.map((n) => `${n}=${verboDaFuncao(n)}`).join(", ") || "nenhuma");
  ok("B5b1 cada escrita leva o seu verbo e corpo JSON",
    ESCRITAS_AUTORIZADAS.every(
      (f) =>
        verboDaFuncao(f) === VERBOS_AUTORIZADOS[f] &&
        /body: JSON\.stringify/.test(corpoDaFuncao(f))));
  ok("B5b2 o transporte tem exatamente cinco method e cinco body",
    (CODIGO_TRANSPORTE.match(/method\s*:/g) ?? []).length === 5 &&
      (CODIGO_TRANSPORTE.match(/body\s*:/g) ?? []).length === 5);
  ok("B5b3 a escrita de conversa vai para a rota de conversa, com corpo so de mensagem",
    /ROTA_SUFIXO_CONVERSA/.test(CODIGO_TRANSPORTE) &&
      /body: JSON\.stringify\(\{ mensagem \}\)/.test(corpoDaFuncao("enviarMensagemAoAgente")));
  // A edicao monta o corpo CHAVE A CHAVE, e nunca serializa o objeto
  // recebido: `JSON.stringify(alteracao)` deixaria uma chave nova do
  // formulario viajar sozinha para o servidor.
  ok("B5b3a a edicao monta o corpo chave a chave, sem serializar o argumento",
    /body: JSON\.stringify\(corpoEnviado\)/.test(corpoDaFuncao("atualizarAgenteViaApi")) &&
      !/JSON\.stringify\(alteracao\)/.test(CODIGO_TRANSPORTE));
  ok("B5b3b e o corpo da edicao so pode ganhar `nome` e `instrucoes`",
    /corpoEnviado\.nome = /.test(corpoDaFuncao("atualizarAgenteViaApi")) &&
      /corpoEnviado\.instrucoes = /.test(corpoDaFuncao("atualizarAgenteViaApi")) &&
      !/corpoEnviado\.(ativo|tipo|id|user_id|criado_em)/.test(CODIGO_TRANSPORTE));
  ok("B5b4 CONTROLE NEGATIVO: sumir a criacao de AGENTE reprovaria",
    JSON.stringify(["atualizarAgenteViaApi", "enviarMensagemAoAgente"].sort()) !== esperadas);
  ok("B5b5 CONTROLE NEGATIVO: sumir a criacao de CONVERSA reprovaria",
    JSON.stringify(["atualizarAgenteViaApi", "criarAgenteViaApi"].sort()) !== esperadas);
  ok("B5b5a CONTROLE NEGATIVO: sumir a EDICAO reprovaria",
    JSON.stringify(["criarAgenteViaApi", "enviarMensagemAoAgente"].sort()) !== esperadas);
  ok("B5b6 CONTROLE NEGATIVO: uma QUARTA escrita reprovaria",
    JSON.stringify([...ESCRITAS_AUTORIZADAS, "apagarAgenteViaApi"].sort()) !== esperadas);
  ok("B5b7 CONTROLE NEGATIVO: TROCA mantendo o total de tres reprovaria",
    JSON.stringify(
      ["criarAgenteViaApi", "enviarMensagemAoAgente", "outraEscritaQualquer"].sort()
    ) !== esperadas);
  // Os tres desvios de VERBO, que a igualdade de conjunto sozinha nao
  // pegaria: o conjunto de nomes continuaria identico nos tres casos.
  ok("B5b7a CONTROLE NEGATIVO: PATCH virar PUT reprovaria",
    pares({ ...VERBOS_AUTORIZADOS, atualizarAgenteViaApi: "PUT" }) !==
      pares(VERBOS_AUTORIZADOS));
  ok("B5b7b CONTROLE NEGATIVO: PATCH virar POST reprovaria",
    pares({ ...VERBOS_AUTORIZADOS, atualizarAgenteViaApi: "POST" }) !==
      pares(VERBOS_AUTORIZADOS));
  ok("B5b7c CONTROLE NEGATIVO: MOVER o PATCH para outra funcao reprovaria",
    pares({
      criarAgenteViaApi: "PATCH",
      enviarMensagemAoAgente: "POST",
      atualizarAgenteViaApi: "POST",
    }) !== pares(VERBOS_AUTORIZADOS));
  ok("B5b8 ANCORA: a varredura enxergou funcoes de verdade",
    escritasReais.length === 5 && corpoDaFuncao("criarAgenteViaApi").length > 50);
  // ── A escrita de permissao, nominalmente ─────────────────────────
  // O caminho e montado por um helper compartilhado com a LEITURA —
  // como `caminhoDaConversa` ja faz —, entao a sonda mede o helper no
  // arquivo e o USO dele nas duas funcoes. Exigir a string crua dentro
  // do corpo obrigaria a duplicar o endereco, que e o oposto do que
  // este arquivo existe para garantir.
  ok("B5b9 leitura e escrita de permissao usam o MESMO caminho nominal",
    /const caminhoDasPermissoes = \(agenteId: string\) =>/.test(CODIGO_TRANSPORTE) &&
      /encodeURIComponent\(agenteId\)\}\/permissoes`/.test(CODIGO_TRANSPORTE) &&
      /caminhoDasPermissoes\(agenteId\)/.test(corpoDaFuncao("definirPermissaoDeFuncao")) &&
      /caminhoDasPermissoes\(agenteId\)/.test(corpoDaFuncao("listarPermissoesDoAgente")));
  ok("B5b10 e leva o corpo EXATO de duas chaves, montado a mao",
    /body: JSON\.stringify\(\{ funcaoId: definicao\.funcaoId, nivel: definicao\.nivel \}\)/
      .test(corpoDaFuncao("definirPermissaoDeFuncao")) &&
      !/JSON\.stringify\(definicao\)/.test(CODIGO_TRANSPORTE));
  ok("B5b11 nenhuma chave reservada entra no corpo da permissao",
    !/user_id|agente_id|revisao/.test(corpoDaFuncao("definirPermissaoDeFuncao")));
  ok("B5b12 a escrita de permissao NAO aceita sinal de cancelamento",
    !/signal/.test(corpoDaFuncao("definirPermissaoDeFuncao")));
  ok("B5b8a ANCORA: a sonda de verbo le verbo de verdade",
    verboDaFuncao("atualizarAgenteViaApi") === "PATCH" &&
      verboDaFuncao("listarAgentes") === null);
  ok("B5c e nenhum outro arquivo da area escreve",
    AREA.filter((a) => /method\s*:\s*"(POST|PUT|PATCH|DELETE)"/.test(codigo(ler(a)))).join(",") ===
      TRANSPORTE);
  ok("B6  o agenteId vai escapado no caminho",
    /encodeURIComponent\(agenteId\)/.test(CODIGO_TRANSPORTE));
  // A SKILL-1D.agent-create-ui-B trouxe a criacao visual, e com ela o
  // primeiro POST legitimo da area. A exigencia nao afrouxa: deixa de
  // ser "zero POST" e passa a ser "EXATAMENTE este arquivo", por
  // igualdade de conjunto e caminho nominal — um componente que ganhe
  // POST proprio reprova, e o transporte perder o POST tambem.
  const COM_POST_AUTORIZADO = ["lib/ia/agentes-http.ts"];
  const comPost = AREA.filter((a) => /"POST"|method:\s*"POST"/.test(codigo(ler(a))));
  ok("B7  POST existe SO no transporte nominal",
    JSON.stringify(comPost.slice().sort()) === JSON.stringify(COM_POST_AUTORIZADO),
    comPost.join(", ") || "nenhum");
  // ── B7b reconciliado na EDITAR-AGENTE-V1 ────────────────────────
  //
  // ANTES: duas capacidades, ambas de CRIACAO, e a frase "esta area
  // cria, nunca altera nem apaga" vetando PUT, PATCH e DELETE em bloco.
  //
  // A revogacao foi ratificada e e PARCIAL, e e importante registrar
  // ate onde ela vai. ALTERAR entrou: uma funcao, um recurso, dois
  // campos, por PATCH. SUBSTITUIR e APAGAR continuam fora — PUT
  // reabriria por omissao os campos que o corpo da edicao fecha, e
  // apagar agente e frente propria, com tarefas, aprovacoes e auditoria
  // penduradas nele. O veto nao foi afrouxado; foi reduzido ao que
  // continua verdadeiro.
  //
  // ── B7b reconciliado na PERMISSOES-FUNCTION-V1-B ────────────────
  //
  // O segundo PATCH entra, e a redacao do assert muda junto: "uma
  // edicao" deixou de ser verdade. ALTERAR agora cobre duas coisas —
  // os campos do agente e o nivel de autonomia de uma Funcao.
  // SUBSTITUIR e APAGAR continuam fora: PUT reabriria por omissao os
  // campos que cada corpo fecha, e nao ha o que apagar (negar e
  // `bloqueado`, que GRAVA linha).
  ok("B7b tres criacoes por POST, duas alteracoes por PATCH — e nada alem",
    (CODIGO_TRANSPORTE.match(/method:\s*"POST"/g) ?? []).length === 3 &&
      (CODIGO_TRANSPORTE.match(/method:\s*"PATCH"/g) ?? []).length === 2 &&
      /export async function criarAgenteViaApi\(/.test(CODIGO_TRANSPORTE) &&
      /export async function enviarMensagemAoAgente\(/.test(CODIGO_TRANSPORTE) &&
      /export async function criarConsultaVendasDoAgente\(/.test(CODIGO_TRANSPORTE) &&
      /export async function atualizarAgenteViaApi\(/.test(CODIGO_TRANSPORTE) &&
      /export async function definirPermissaoDeFuncao\(/.test(CODIGO_TRANSPORTE) &&
      !/"PUT"|"DELETE"/.test(CODIGO_TRANSPORTE));
  ok("B7c PUT e DELETE continuam vetados em TODA a area, nao so no transporte",
    AREA.filter((a) => /"PUT"|"DELETE"/.test(codigo(ler(a)))).length === 0,
    AREA.filter((a) => /"PUT"|"DELETE"/.test(codigo(ler(a)))).join(", ") || "nenhum");
  ok("B7d CONTROLE NEGATIVO: a sonda de PUT/DELETE acusa quando o padrao existe",
    /"PUT"|"DELETE"/.test('method: "PUT"') && /"PUT"|"DELETE"/.test('method: "DELETE"'));
  ok("B7e o PATCH mora SO no transporte nominal",
    AREA.filter((a) => /"PATCH"/.test(codigo(ler(a)))).join(",") === TRANSPORTE,
    AREA.filter((a) => /"PATCH"/.test(codigo(ler(a)))).join(", ") || "nenhum");
  ok("B7f CONTROLE NEGATIVO: um dos dois PATCH virar PUT reprovaria",
    pares({ ...VERBOS_AUTORIZADOS, definirPermissaoDeFuncao: "PUT" }) !==
      pares(VERBOS_AUTORIZADOS));
  ok("B7g CONTROLE NEGATIVO: a permissao virar POST reprovaria",
    pares({ ...VERBOS_AUTORIZADOS, definirPermissaoDeFuncao: "POST" }) !==
      pares(VERBOS_AUTORIZADOS));
}

secao("C. As telas migradas nao voltam ao simulado");

{
  ok("C1  a lista nao importa mais os agentes simulados",
    !/MOCK_AGENTES|MOCK_AGENTE_POR_ID/.test(codigo(ler(LISTA))));
  ok("C2  a lista nao importa mais as tarefas simuladas",
    !/MOCK_TAREFAS/.test(codigo(ler(LISTA))));
  ok("C3  a rota de detalhe nao resolve mais no mock",
    !/MOCK_/.test(codigo(ler(ROTA_DETALHE))));
  ok("C4  o container nao usa mock nenhum", !/MOCK_/.test(codigo(ler(CONTAINER))));

  ok("C5  a lista consome o transporte nominal",
    /listarAgentes/.test(codigo(ler(LISTA))) &&
      /from "@\/lib\/ia\/agentes-http"/.test(codigo(ler(LISTA))));
  ok("C6  o container consome as DUAS leituras",
    /listarAgentes/.test(codigo(ler(CONTAINER))) &&
      /obterDiagnostico/.test(codigo(ler(CONTAINER))));
  ok("C7  as duas leituras sao paralelas, nao encadeadas",
    /Promise\.all\(\[\s*listarAgentes/.test(codigo(ler(CONTAINER))));
  ok("C8  as duas recebem o mesmo sinal de cancelamento",
    (codigo(ler(CONTAINER)).match(/controlador\.signal/g) ?? []).length >= 3);
  ok("C9  a lista tambem cancela ao sair",
    /new AbortController\(\)/.test(codigo(ler(LISTA))) &&
      /controlador\.abort\(\)/.test(codigo(ler(LISTA))));
  ok("C10 o container reinicia a leitura quando o agente muda",
    /\}, \[agenteId\]\)/.test(codigo(ler(CONTAINER))));

  ok("C11 os mocks continuam existindo para as telas nao migradas",
    /MOCK_AGENTES/.test(codigo(ler("components/ia/office/Escritorio.tsx"))) &&
      /MOCK_AGENTES/.test(codigo(ler("components/ia/atividade/Timeline.tsx"))));
  ok("C12 a rota de detalhe continua Server Component",
    !/^"use client"/m.test(ler(ROTA_DETALHE)));
  ok("C13 e nao faz rede por conta propria",
    !/\bfetch\s*\(/.test(codigo(ler(ROTA_DETALHE))));
}

// ─── D–G. O transporte REAL, contra um fetch duplado ──────────────────

interface Chamada { url: string; init?: RequestInit }
let chamadas: Chamada[] = [];
let proxima: { status: number; corpo: unknown } | "erro" = { status: 200, corpo: null };

const fetchOriginal = globalThis.fetch;
globalThis.fetch = (async (entrada: unknown, init?: RequestInit) => {
  chamadas.push({ url: String(entrada), init });
  if (proxima === "erro") throw new Error("rede caiu");
  return {
    status: proxima.status,
    ok: proxima.status >= 200 && proxima.status < 300,
    json: async () => {
      if (proxima !== "erro" && proxima.corpo === "ilegivel") throw new Error("json invalido");
      return proxima === "erro" ? null : proxima.corpo;
    },
  } as unknown as Response;
}) as typeof fetch;

function responde(status: number, corpo: unknown): void {
  chamadas = [];
  proxima = { status, corpo };
}

const agente = (id: string, extra: Record<string, unknown> = {}) => ({
  id, nome: `Agente ${id}`, tipo: "mensagens", instrucoes: null,
  ativo: true, criado_em: "2026-08-01T00:00:00.000Z", ...extra,
});
const item = (skillId: string, versao: string, estadoGeral = "PRONTO") =>
  ({ skillId, versao, diagnostico: { estadoGeral, pronto: estadoGeral === "PRONTO", bloqueios: [], limitacoes: [], funcoesUtilizaveis: [] } });

const UUID_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

async function principal(): Promise<void> {
  const { listarAgentes, obterDiagnostico } = await import("../lib/ia/agentes-http");

  secao("D. listarAgentes — cada resposta no seu lugar");

  responde(200, { ok: true, agentes: [agente(UUID_A), agente("bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb", { ativo: false })] });
  const rOk = await listarAgentes();
  ok("D1  200 -> ok com os agentes", rOk.estado === "ok" && rOk.agentes.length === 2);
  ok("D2  o endereco e o metodo sao os publicados",
    chamadas.length === 1 && chamadas[0].url === "/api/agentes" &&
      (chamadas[0].init?.method ?? undefined) === undefined,
    chamadas[0]?.url);
  ok("D3  ativos E inativos atravessam — a tela precisa religar o desligado",
    rOk.estado === "ok" && rOk.agentes.some((a) => a.ativo === false));

  responde(200, { ok: true, agentes: [] });
  const rVazio = await listarAgentes();
  ok("D4  200 com lista vazia -> ok vazio, e nao falha",
    rVazio.estado === "ok" && rVazio.agentes.length === 0);

  responde(401, { ok: false, erro: "Não autenticado." });
  const r401 = await listarAgentes();
  ok("D5  401 -> nao_autenticado", r401.estado === "nao_autenticado");
  ok("D6  e NUNCA lista vazia", r401.estado !== "ok");

  responde(500, { ok: false, erro: "Falha ao listar os agentes." });
  const r500 = await listarAgentes();
  ok("D7  500 -> falha", r500.estado === "falha");
  ok("D8  e NUNCA lista vazia", r500.estado !== "ok");

  for (const [nome, corpo] of [
    ["D9  corpo sem `ok`", { agentes: [] }],
    ["D10 corpo com ok:false", { ok: false, agentes: [] }],
    ["D11 `agentes` que nao e lista", { ok: true, agentes: {} }],
    ["D12 agente sem id", { ok: true, agentes: [{ nome: "x", tipo: "ads", instrucoes: null, ativo: true, criado_em: "z" }] }],
    ["D13 agente com tipo fora do vocabulario", { ok: true, agentes: [agente(UUID_A, { tipo: "vendedor" })] }],
    ["D14 agente com ativo textual", { ok: true, agentes: [agente(UUID_A, { ativo: "sim" })] }],
    ["D15 corpo ilegivel", "ilegivel"],
  ] as [string, unknown][]) {
    responde(200, corpo);
    const r = await listarAgentes();
    ok(`${nome} -> falha, nunca lista parcial`, r.estado === "falha", r.estado);
  }

  proxima = "erro";
  chamadas = [];
  const rRede = await listarAgentes();
  ok("D16 rede caida -> falha, sem excecao vazando", rRede.estado === "falha");

  secao("E. obterDiagnostico — lista, versoes e semSelecao");

  responde(200, {
    ok: true, coleta: "ok",
    diagnosticos: [item("atendimento", "1.0.0"), item("atendimento", "2.0.0", "FALTA_CONEXAO"), item("ads", "1.0.0")],
    semSelecao: [{ plataforma: "shopee", recurso: "chat", obrigatoria: true }],
  });
  const dOk = await obterDiagnostico(UUID_A);
  ok("E1  200 -> ok", dOk.estado === "ok");
  ok("E2  o endereco leva o agenteId escapado",
    chamadas[0]?.url === `/api/agentes/${UUID_A}/diagnostico`, chamadas[0]?.url);
  ok("E3  os TRES itens atravessam — nada de `diagnosticos[0]`",
    dOk.estado === "ok" && dOk.diagnosticos.length === 3);
  ok("E4  duas versoes da MESMA Skill continuam duas",
    dOk.estado === "ok" &&
      dOk.diagnosticos.filter((d) => d.skillId === "atendimento").length === 2);
  ok("E5  e as versoes sao distintas, sem deduplicar",
    dOk.estado === "ok" &&
      JSON.stringify(dOk.diagnosticos.filter((d) => d.skillId === "atendimento").map((d) => d.versao)) ===
        JSON.stringify(["1.0.0", "2.0.0"]));
  ok("E6  semSelecao chega separado, intacto",
    dOk.estado === "ok" && dOk.semSelecao.length === 1);
  ok("E7  zero FALTA_SELECAO inventado",
    !/FALTA_SELECAO/.test(JSON.stringify(dOk)) && !/FALTA_SELECAO/.test(CODIGO_TRANSPORTE));

  responde(200, { ok: true, coleta: "ok", diagnosticos: [], semSelecao: [] });
  const dVazio = await obterDiagnostico(UUID_A);
  ok("E8  200 vazio -> ok vazio, e nao falha",
    dVazio.estado === "ok" && dVazio.diagnosticos.length === 0);

  responde(401, { ok: false });
  ok("E9  401 -> nao_autenticado", (await obterDiagnostico(UUID_A)).estado === "nao_autenticado");
  responde(400, { ok: false });
  ok("E10 400 -> entrada_invalida", (await obterDiagnostico(UUID_A)).estado === "entrada_invalida");
  responde(500, { ok: false });
  ok("E11 500 -> falha", (await obterDiagnostico(UUID_A)).estado === "falha");

  for (const [nome, corpo] of [
    ["E12 sem `diagnosticos`", { ok: true, semSelecao: [] }],
    ["E13 sem `semSelecao`", { ok: true, diagnosticos: [] }],
    ["E14 item sem versao", { ok: true, diagnosticos: [{ skillId: "x", diagnostico: {} }], semSelecao: [] }],
    ["E15 corpo ilegivel", "ilegivel"],
  ] as [string, unknown][]) {
    responde(200, corpo);
    const r = await obterDiagnostico(UUID_A);
    ok(`${nome} -> falha`, r.estado === "falha", r.estado);
  }

  secao("F. O sinal de cancelamento atravessa");

  responde(200, { ok: true, agentes: [] });
  const controlador = new AbortController();
  await listarAgentes(controlador.signal);
  ok("F1  listarAgentes repassa o AbortSignal",
    chamadas[0]?.init?.signal === controlador.signal);

  responde(200, { ok: true, coleta: "ok", diagnosticos: [], semSelecao: [] });
  await obterDiagnostico(UUID_A, controlador.signal);
  ok("F2  obterDiagnostico repassa o AbortSignal",
    chamadas[0]?.init?.signal === controlador.signal);

  // ─── G. A EDICAO — EDITAR-AGENTE-V1 ─────────────────────────────────

  secao("G. atualizarAgenteViaApi — cada resposta no seu lugar");

  const { atualizarAgenteViaApi } = await import("../lib/ia/agentes-http");
  const corpoEnviado = (): Record<string, unknown> =>
    JSON.parse(String(chamadas[0]?.init?.body ?? "{}"));

  responde(200, { ok: true, agente: agente(UUID_A, { nome: "Depois" }) });
  const gOk = await atualizarAgenteViaApi(UUID_A, { nome: "Depois" });
  ok("G1  200 -> ok, com a linha do servidor",
    gOk.estado === "ok" && gOk.agente.nome === "Depois", JSON.stringify(gOk));
  ok("G2  metodo PATCH", chamadas[0]?.init?.method === "PATCH", String(chamadas[0]?.init?.method));
  ok("G3  endereco e o do recurso, com o id escapado",
    chamadas[0]?.url === `/api/agentes/${UUID_A}`, String(chamadas[0]?.url));
  ok("G4  o unico cabecalho e o do corpo JSON",
    JSON.stringify(chamadas[0]?.init?.headers) ===
      JSON.stringify({ "Content-Type": "application/json" }),
    JSON.stringify(chamadas[0]?.init?.headers));
  ok("G5  zero sinal de cancelamento numa escrita",
    chamadas[0]?.init?.signal === undefined);
  ok("G6  o corpo leva SO a chave pedida",
    JSON.stringify(Object.keys(corpoEnviado()).sort()) === JSON.stringify(["nome"]),
    JSON.stringify(corpoEnviado()));

  responde(200, { ok: true, agente: agente(UUID_A, { instrucoes: null }) });
  const gLimpa = await atualizarAgenteViaApi(UUID_A, { instrucoes: null });
  ok("G7  `instrucoes: null` VIAJA — limpar e pedido explicito",
    gLimpa.estado === "ok" && corpoEnviado().instrucoes === null &&
      JSON.stringify(Object.keys(corpoEnviado()).sort()) === JSON.stringify(["instrucoes"]),
    JSON.stringify(corpoEnviado()));

  responde(200, { ok: true, agente: agente(UUID_A) });
  await atualizarAgenteViaApi(UUID_A, { nome: "N", instrucoes: "I" });
  ok("G8  os dois campos juntos viajam, e SO eles",
    JSON.stringify(Object.keys(corpoEnviado()).sort()) ===
      JSON.stringify(["instrucoes", "nome"]),
    JSON.stringify(corpoEnviado()));

  responde(400, { ok: false, erro: "nome inválido." });
  const gNome = await atualizarAgenteViaApi(UUID_A, { nome: "  " });
  ok("G9  400 conhecido -> dados_invalidos com a frase do servidor",
    gNome.estado === "dados_invalidos" && gNome.mensagem === "nome inválido.",
    JSON.stringify(gNome));

  // A frase que descreve um DEFEITO NOSSO nao chega ao usuario: ele nao
  // tem como consertar um corpo que a propria tela montou.
  responde(400, { ok: false, erro: "Alteração inválida." });
  const gGenerico = await atualizarAgenteViaApi(UUID_A, { nome: "N" });
  ok("G10 400 desconhecido -> frase generica, nunca o texto cru",
    gGenerico.estado === "dados_invalidos" &&
      gGenerico.mensagem === "Não foi possível salvar essas alterações.",
    JSON.stringify(gGenerico));

  responde(401, { ok: false, erro: "Não autenticado." });
  ok("G11 401 -> sessao expirada, nunca falha generica",
    (await atualizarAgenteViaApi(UUID_A, { nome: "N" })).estado === "nao_autenticado");

  responde(404, { ok: false, erro: "Agente não encontrado." });
  ok("G12 404 -> nao_encontrado, estado proprio",
    (await atualizarAgenteViaApi(UUID_A, { nome: "N" })).estado === "nao_encontrado");

  responde(500, { ok: false, erro: "Falha ao atualizar o agente." });
  ok("G13 500 -> falha", (await atualizarAgenteViaApi(UUID_A, { nome: "N" })).estado === "falha");

  proxima = "erro";
  chamadas = [];
  ok("G14 rede caida -> falha, nunca sucesso silencioso",
    (await atualizarAgenteViaApi(UUID_A, { nome: "N" })).estado === "falha");

  responde(200, { ok: true, agente: agente(UUID_A, { ativo: "sim" }) });
  ok("G15 200 com agente MALFORMADO -> falha, nunca linha meio montada",
    (await atualizarAgenteViaApi(UUID_A, { nome: "N" })).estado === "falha");

  responde(200, "ilegivel");
  ok("G16 200 com corpo ilegivel -> falha",
    (await atualizarAgenteViaApi(UUID_A, { nome: "N" })).estado === "falha");

  responde(200, { ok: true });
  ok("G17 200 sem `agente` -> falha",
    (await atualizarAgenteViaApi(UUID_A, { nome: "N" })).estado === "falha");

  // ─── I. Permissoes de Function — PERMISSOES-FUNCTION-V1-B ───────────

  secao("I. listarPermissoesDoAgente — leitura pura, contrato fechado");

  const { listarPermissoesDoAgente, definirPermissaoDeFuncao } = await import(
    "../lib/ia/agentes-http"
  );
  const permissao = (extra: Record<string, unknown> = {}) => ({
    id: "vendas.consultar",
    acesso: "leitura",
    idempotente: true,
    conexaoNecessaria: null,
    nivel: null,
    ...extra,
  });

  responde(200, { ok: true, permissoes: [permissao()] });
  const iOk = await listarPermissoesDoAgente(UUID_A);
  ok("I1  200 -> ok, com a lista do servidor",
    iOk.estado === "ok" && iOk.permissoes.length === 1 &&
      iOk.permissoes[0].id === "vendas.consultar", JSON.stringify(iOk));
  ok("I2  endereco e o do recurso, com o id escapado",
    chamadas[0]?.url === `/api/agentes/${UUID_A}/permissoes`, String(chamadas[0]?.url));
  ok("I3  leitura: sem method, sem corpo e sem cabecalho",
    chamadas[0]?.init?.method === undefined && chamadas[0]?.init?.body === undefined &&
      chamadas[0]?.init?.headers === undefined);

  responde(200, { ok: true, permissoes: [permissao()] });
  const controladorPerm = new AbortController();
  await listarPermissoesDoAgente(UUID_A, controladorPerm.signal);
  ok("I4  repassa o AbortSignal", chamadas[0]?.init?.signal === controladorPerm.signal);

  // O ponto central da fase: ausencia continua sendo `null` ATE a tela.
  responde(200, { ok: true, permissoes: [permissao({ nivel: null })] });
  const iNull = await listarPermissoesDoAgente(UUID_A);
  ok("I5  `nivel: null` atravessa como null — nao vira 'bloqueado'",
    iNull.estado === "ok" && iNull.permissoes[0].nivel === null);

  for (const nivel of ["bloqueado", "aprovacao", "automatico"]) {
    responde(200, { ok: true, permissoes: [permissao({ nivel })] });
    const r = await listarPermissoesDoAgente(UUID_A);
    ok(`I6  nivel \`${nivel}\` atravessa literal`,
      r.estado === "ok" && r.permissoes[0].nivel === nivel);
  }

  responde(200, { ok: true, permissoes: [permissao({ nivel: "liberado" })] });
  ok("I7  nivel FORA do vocabulario -> falha, nunca item silencioso",
    (await listarPermissoesDoAgente(UUID_A)).estado === "falha");

  // Um item torto condena a lista INTEIRA: meia lista diria ao dono que
  // uma Funcao nao existe quando ela existe.
  responde(200, { ok: true, permissoes: [permissao(), permissao({ acesso: "total" })] });
  ok("I8  item malformado condena a lista inteira",
    (await listarPermissoesDoAgente(UUID_A)).estado === "falha");
  responde(200, { ok: true, permissoes: [permissao({ idempotente: "sim" })] });
  ok("I8a `idempotente` nao-booleano -> falha",
    (await listarPermissoesDoAgente(UUID_A)).estado === "falha");
  responde(200, { ok: true, permissoes: [permissao({ conexaoNecessaria: { plataforma: 1 } })] });
  ok("I8b conexao malformada -> falha",
    (await listarPermissoesDoAgente(UUID_A)).estado === "falha");

  responde(200, { ok: true, permissoes: [permissao({ conexaoNecessaria: { plataforma: "shopee", recurso: "chat" } })] });
  const iConexao = await listarPermissoesDoAgente(UUID_A);
  ok("I8c conexao bem formada atravessa campo a campo",
    iConexao.estado === "ok" &&
      iConexao.permissoes[0].conexaoNecessaria?.plataforma === "shopee");

  responde(200, { ok: true, permissoes: [] });
  const iVazio = await listarPermissoesDoAgente(UUID_A);
  ok("I9  lista VAZIA e resposta completa, nao falha",
    iVazio.estado === "ok" && iVazio.permissoes.length === 0);

  responde(401, { ok: false });
  ok("I10 401 -> sessao expirada",
    (await listarPermissoesDoAgente(UUID_A)).estado === "nao_autenticado");
  responde(404, { ok: false });
  ok("I11 404 -> nao_encontrado",
    (await listarPermissoesDoAgente(UUID_A)).estado === "nao_encontrado");
  responde(500, { ok: false });
  ok("I12 500 -> falha, NUNCA lista vazia",
    (await listarPermissoesDoAgente(UUID_A)).estado === "falha");
  responde(200, "ilegivel");
  ok("I13 corpo ilegivel -> falha",
    (await listarPermissoesDoAgente(UUID_A)).estado === "falha");
  proxima = "erro";
  chamadas = [];
  ok("I14 rede caida -> falha",
    (await listarPermissoesDoAgente(UUID_A)).estado === "falha");

  secao("I. definirPermissaoDeFuncao — a escrita, com corpo de duas chaves");

  responde(200, { ok: true, permissao: { funcaoId: "vendas.consultar", nivel: "aprovacao" } });
  const iDef = await definirPermissaoDeFuncao(UUID_A, {
    funcaoId: "vendas.consultar",
    nivel: "aprovacao",
  });
  ok("I15 200 -> ok, com o nivel do SERVIDOR",
    iDef.estado === "ok" && iDef.funcaoId === "vendas.consultar" && iDef.nivel === "aprovacao",
    JSON.stringify(iDef));
  ok("I16 metodo PATCH", chamadas[0]?.init?.method === "PATCH", String(chamadas[0]?.init?.method));
  ok("I17 endereco e o do recurso de permissoes",
    chamadas[0]?.url === `/api/agentes/${UUID_A}/permissoes`, String(chamadas[0]?.url));
  ok("I18 o unico cabecalho e o do corpo JSON",
    JSON.stringify(chamadas[0]?.init?.headers) ===
      JSON.stringify({ "Content-Type": "application/json" }));
  ok("I19 zero sinal de cancelamento numa escrita",
    chamadas[0]?.init?.signal === undefined);
  ok("I20 o corpo leva EXATAMENTE funcaoId e nivel",
    JSON.stringify(Object.keys(JSON.parse(String(chamadas[0]?.init?.body ?? "{}"))).sort()) ===
      JSON.stringify(["funcaoId", "nivel"]),
    String(chamadas[0]?.init?.body));

  // O servidor e a autoridade: se ele devolver outro nivel, e o dele que
  // vale — a tela nao pode ecoar o que mandou.
  responde(200, { ok: true, permissao: { funcaoId: "vendas.consultar", nivel: "bloqueado" } });
  const iEco = await definirPermissaoDeFuncao(UUID_A, {
    funcaoId: "vendas.consultar",
    nivel: "automatico",
  });
  ok("I21 o nivel confirmado vem da RESPOSTA, nunca do argumento",
    iEco.estado === "ok" && iEco.nivel === "bloqueado");

  responde(200, { ok: true, permissao: { funcaoId: "vendas.consultar", nivel: "liberado" } });
  ok("I22 nivel invalido na resposta -> falha",
    (await definirPermissaoDeFuncao(UUID_A, { funcaoId: "x.y", nivel: "automatico" })).estado ===
      "falha");
  responde(200, { ok: true });
  ok("I23 resposta sem `permissao` -> falha",
    (await definirPermissaoDeFuncao(UUID_A, { funcaoId: "x.y", nivel: "automatico" })).estado ===
      "falha");

  responde(400, { ok: false, erro: "nível inválido." });
  const iRuim = await definirPermissaoDeFuncao(UUID_A, { funcaoId: "x.y", nivel: "automatico" });
  ok("I24 400 -> dados_invalidos com frase generica, nunca o texto cru",
    iRuim.estado === "dados_invalidos" &&
      iRuim.mensagem === "Não foi possível salvar este nível.",
    JSON.stringify(iRuim));
  responde(401, { ok: false });
  ok("I25 401 -> sessao expirada",
    (await definirPermissaoDeFuncao(UUID_A, { funcaoId: "x.y", nivel: "automatico" })).estado ===
      "nao_autenticado");
  responde(404, { ok: false });
  ok("I26 404 -> nao_encontrado",
    (await definirPermissaoDeFuncao(UUID_A, { funcaoId: "x.y", nivel: "automatico" })).estado ===
      "nao_encontrado");
  responde(500, { ok: false });
  ok("I27 500 -> falha",
    (await definirPermissaoDeFuncao(UUID_A, { funcaoId: "x.y", nivel: "automatico" })).estado ===
      "falha");

  // ── M. O transporte EXECUTADO contra o shape real ────────────────
  //
  // A secao L le a fonte. Esta EXECUTA.
  //
  // A distincao nao e academica: a secao L inteira continuaria verde se
  // alguem trocasse as duas constantes dentro dos validadores —
  // `resumoDaResposta` passando `CAMPOS_BUCKET` e
  // `bucketMarketplaceDaResposta` passando `CAMPOS_RESUMO`. As listas
  // seguiriam com 6 e 4 campos, os call sites seguiriam iguais, e o
  // defeito de producao voltaria identico: baldes validados contra seis
  // campos, todo resultado real recusado.
  //
  // O fixture abaixo e o resultado REAL da primeira execucao em
  // producao — 252 pedidos lidos, R$ 10.246,17 —, com a assimetria que
  // derrubou a primeira tentativa: resumo com SEIS campos, baldes com
  // QUATRO. Se o transporte voltar a exigir seis dos baldes, M2 fica
  // vermelho.
  secao("M. consultarConsultaVendasDoAgente — o shape real de producao");
  {
    const { consultarConsultaVendasDoAgente } = await import("../lib/ia/agentes-http");

    const UUID_TAREFA = "d63c5a98-c1e1-4ee8-a5f7-1aff8f1664aa";

    /** O agregado exatamente como o handler o persistiu em producao. */
    const resultadoReal = () => ({
      periodo: { dataInicio: "2026-09-12", dataFim: "2026-09-13", marketplace: null },
      resumo: {
        linhas: 255,
        pedidos: 252,
        unidades: 276,
        faturamento: 10246.17,
        ticketMedio: 40.66,
        skusDistintos: 9,
      },
      marketplaces: {
        // QUATRO campos. Sem `ticketMedio`, sem `skusDistintos` — e isso
        // e o contrato, nao uma falta.
        Shopee: { linhas: 9, pedidos: 6, unidades: 11, faturamento: 197.14 },
        ML: { linhas: 246, pedidos: 246, unidades: 265, faturamento: 10049.03 },
        outros: { linhas: 0, pedidos: 0, unidades: 0, faturamento: 0 },
      },
      truncado: false,
    });

    const respostaGet = (resultado: unknown) => ({
      ok: true,
      tarefa: {
        id: UUID_TAREFA,
        status: "concluido",
        resultado,
        erroTipo: null,
        criadoEm: "2026-09-14T21:00:26.856Z",
        iniciadoEm: "2026-09-14T21:00:38.657Z",
        concluidoEm: "2026-09-14T21:00:41.282Z",
      },
    });

    // ── O caso que falhou em producao, agora executado ────────────
    responde(200, respostaGet(resultadoReal()));
    const m = await consultarConsultaVendasDoAgente(UUID_A, UUID_TAREFA);

    ok("M1  200 com o shape real -> estado ok e tarefa concluida",
      m.estado === "ok" && m.tarefa.status === "concluido", m.estado);
    ok("M2  O RESULTADO REAL CHEGA PREENCHIDO (era null antes do fix)",
      m.estado === "ok" && m.tarefa.resultado !== null);
    ok("M3  o total traz os seis campos, inclusive os que so ele tem",
      m.estado === "ok" &&
      m.tarefa.resultado?.resumo.ticketMedio === 40.66 &&
      m.tarefa.resultado?.resumo.skusDistintos === 9 &&
      m.tarefa.resultado?.resumo.pedidos === 252 &&
      m.tarefa.resultado?.resumo.faturamento === 10246.17);
    ok("M4  o balde de QUATRO campos e aceito — Shopee",
      m.estado === "ok" &&
      m.tarefa.resultado?.marketplaces.Shopee.pedidos === 6 &&
      m.tarefa.resultado?.marketplaces.Shopee.linhas === 9 &&
      m.tarefa.resultado?.marketplaces.Shopee.unidades === 11 &&
      m.tarefa.resultado?.marketplaces.Shopee.faturamento === 197.14);
    ok("M5  o balde de QUATRO campos e aceito — ML",
      m.estado === "ok" && m.tarefa.resultado?.marketplaces.ML.faturamento === 10049.03);
    ok("M6  o balde de QUATRO campos e aceito — outros (tudo zero)",
      m.estado === "ok" && m.tarefa.resultado?.marketplaces.outros.unidades === 0);
    ok("M7  `marketplace: null` (Todos) atravessa o transporte",
      m.estado === "ok" && m.tarefa.resultado?.periodo.marketplace === null);
    ok("M8  truncado false chega como boolean",
      m.estado === "ok" && m.tarefa.resultado?.truncado === false);
    ok("M9  o GET foi para a route de consultar-vendas, com o tarefaId",
      chamadas.length === 1 &&
      chamadas[0]?.url === `/api/agentes/${UUID_A}/consultar-vendas?tarefaId=${UUID_TAREFA}`,
      String(chamadas[0]?.url));

    // ── O total continua ESTRITO ──────────────────────────────────
    //
    // Corrigir o balde afrouxando o resumo seria trocar um defeito por
    // outro: `ticketMedio` e `skusDistintos` existem no total, e a tela
    // os mostra.
    const semCampoDoTotal = (campo: "ticketMedio" | "skusDistintos") => {
      const r = resultadoReal();
      delete (r.resumo as Record<string, unknown>)[campo];
      return r;
    };

    responde(200, respostaGet(semCampoDoTotal("ticketMedio")));
    const mSemTicket = await consultarConsultaVendasDoAgente(UUID_A, UUID_TAREFA);
    ok("M10 resumo SEM ticketMedio e recusado, fail-closed",
      mSemTicket.estado === "ok" && mSemTicket.tarefa.resultado === null);

    responde(200, respostaGet(semCampoDoTotal("skusDistintos")));
    const mSemSkus = await consultarConsultaVendasDoAgente(UUID_A, UUID_TAREFA);
    ok("M11 resumo SEM skusDistintos e recusado, fail-closed",
      mSemSkus.estado === "ok" && mSemSkus.tarefa.resultado === null);

    // ── O balde continua ESTRITO nos QUATRO ───────────────────────
    const semCampoDoBalde = () => {
      const r = resultadoReal();
      delete (r.marketplaces.Shopee as Record<string, unknown>).faturamento;
      return r;
    };
    responde(200, respostaGet(semCampoDoBalde()));
    const mSemFat = await consultarConsultaVendasDoAgente(UUID_A, UUID_TAREFA);
    ok("M12 balde SEM faturamento e recusado, fail-closed",
      mSemFat.estado === "ok" && mSemFat.tarefa.resultado === null);

    // ── Numero nao-finito continua recusado ───────────────────────
    const comInfinito = () => {
      const r = resultadoReal();
      (r.marketplaces.Shopee as Record<string, unknown>).faturamento = Infinity;
      return r;
    };
    responde(200, respostaGet(comInfinito()));
    const mInf = await consultarConsultaVendasDoAgente(UUID_A, UUID_TAREFA);
    ok("M13 faturamento Infinity num balde e recusado, fail-closed",
      mInf.estado === "ok" && mInf.tarefa.resultado === null);
  }

  globalThis.fetch = fetchOriginal;

  // ─── H. A tela de edicao ────────────────────────────────────────────

  secao("H. EditarAgente — o que a tela faz, e o que ela nao faz");

  {
    const EDITAR = "components/ia/agente/EditarAgente.tsx";
    const CODIGO_EDITAR = codigo(ler(EDITAR));
    const CODIGO_CONTAINER = codigo(ler(CONTAINER));

    ok("H1  a tela existe e e Client Component",
      AREA.includes(EDITAR) && /^"use client"/m.test(ler(EDITAR)));
    ok("H2  exporta default", /export default function EditarAgente\(/.test(CODIGO_EDITAR));
    ok("H3  zero rede propria: ela usa o transporte nominal",
      !/\bfetch\s*\(/.test(CODIGO_EDITAR) && !/["'`]\/api\//.test(CODIGO_EDITAR) &&
        /atualizarAgenteViaApi/.test(CODIGO_EDITAR) &&
        /from "@\/lib\/ia\/agentes-http"/.test(CODIGO_EDITAR));
    ok("H4  zero ambiente, zero banco, zero dominio do servidor",
      !/process\.env|getSupabaseServidor|createClient|lib\/agentes/.test(CODIGO_EDITAR));
    ok("H5  botao de verdade para abrir, com rotulo acessivel",
      /<button[\s\S]{0,200}onClick=\{abrir\}/.test(CODIGO_EDITAR) &&
        /aria-label=\{`Editar nome e instruções de \$\{agente\.nome\}`\}/.test(CODIGO_EDITAR));
    ok("H6  nenhum <div>/<span> fingindo botao",
      !/<span[^>]*onClick/.test(CODIGO_EDITAR) && !/<div[^>]*onClick/.test(CODIGO_EDITAR));
    ok("H7  os campos partem do valor PERSISTIDO, nao de um rascunho antigo",
      /setNome\(agente\.nome\)/.test(CODIGO_EDITAR) &&
        /setInstrucoes\(agente\.instrucoes \?\? ""\)/.test(CODIGO_EDITAR));
    // Cancelar nao pode ter caminho ate a rede: nao chama o transporte e
    // nao avisa o pai. A prova e por AUSENCIA dentro do proprio handler.
    const corpoCancelar = CODIGO_EDITAR.slice(
      CODIGO_EDITAR.indexOf("function cancelar()"),
      CODIGO_EDITAR.indexOf("const nomeValido")
    );
    ok("H8  Cancelar nao escreve e nao avisa o pai",
      corpoCancelar.length > 30 &&
        !/atualizarAgenteViaApi|onAtualizado/.test(corpoCancelar),
      corpoCancelar.slice(0, 80));
    ok("H9  envio duplo fechado em DOIS niveis: disabled E o ref",
      /disabled=\{salvando \|\| !nomeValido\}/.test(CODIGO_EDITAR) &&
        /if \(salvandoRef\.current \|\| !nomeValido\) return;/.test(CODIGO_EDITAR));
    // O ponto central da fase: a tela NAO afirma o que digitou.
    ok("H10 o sucesso usa a LINHA DO SERVIDOR, nunca o rascunho",
      /onAtualizado\(resultado\.agente\)/.test(CODIGO_EDITAR) &&
        !/onAtualizado\(\{/.test(CODIGO_EDITAR) &&
        !/onAtualizado\(nome/.test(CODIGO_EDITAR));
    ok("H11 o erro NAO fecha o formulario nem limpa o que foi digitado",
      !/setEditando\(false\)[\s\S]{0,80}setErro\(resultado/.test(CODIGO_EDITAR) &&
        (CODIGO_EDITAR.match(/setEditando\(false\)/g) ?? []).length === 2 &&
        !/setNome\(""\)|setInstrucoes\(""\)/.test(CODIGO_EDITAR));
    ok("H12 os quatro desfechos da escrita tem tratamento proprio",
      ["dados_invalidos", "nao_autenticado", "nao_encontrado"].every((e) =>
        CODIGO_EDITAR.includes(`resultado.estado === "${e}"`)) &&
        /resultado\.estado === "ok"/.test(CODIGO_EDITAR));
    ok("H13 a tela nao alcanca `ativo` nem `tipo`",
      !/\bativo\b|\btipo\b/.test(CODIGO_EDITAR));
    ok("H14 nada de HTML cru",
      !/dangerouslySetInnerHTML/.test(CODIGO_EDITAR));

    ok("H15 o container monta a edicao pelo especificador com @/",
      /from "@\/components\/ia\/agente\/EditarAgente"/.test(CODIGO_CONTAINER) &&
        /<EditarAgente agente=\{agente\} onAtualizado=\{aoAtualizarAgente\}/.test(CODIGO_CONTAINER));
    // UMA verdade sobre o agente. Um segundo estado com a linha editada
    // divergiria da lista no primeiro refetch.
    ok("H16 o container troca a linha DENTRO da lista, sem segundo estado",
      /setLista\(\(atual\) =>/.test(CODIGO_CONTAINER) &&
        /a\.id === atualizado\.id \? atualizado : a/.test(CODIGO_CONTAINER) &&
        !/setAgente\(|useState<AgenteUI/.test(CODIGO_CONTAINER));
    ok("H17 e a VisaoGeral continua recebendo o agente da lista",
      /<VisaoGeral agente=\{agente\}/.test(CODIGO_CONTAINER));
    ok("H18 ANCORA: as duas fontes foram lidas de verdade",
      CODIGO_EDITAR.length > 1500 && CODIGO_CONTAINER.length > 1500);
  }

  // ─── J. A aba Funcoes ───────────────────────────────────────────────

  secao("J. FuncoesAgente — configura capacidade, e nao executa nada");

  {
    const FUNCOES = "components/ia/agente/FuncoesAgente.tsx";
    const CODIGO_FUNCOES = codigo(ler(FUNCOES));
    const CODIGO_CONTAINER = codigo(ler(CONTAINER));

    ok("J1  a tela existe e e Client Component",
      AREA.includes(FUNCOES) && /^"use client"/m.test(ler(FUNCOES)));
    ok("J2  exporta default e recebe SO `agenteId`",
      /export default function FuncoesAgente\(\{ agenteId \}: \{ agenteId: string \}\)/
        .test(CODIGO_FUNCOES));
    ok("J3  zero rede propria: usa os dois helpers nominais",
      !/\bfetch\s*\(/.test(CODIGO_FUNCOES) && !/["'`]\/api\//.test(CODIGO_FUNCOES) &&
        /listarPermissoesDoAgente/.test(CODIGO_FUNCOES) &&
        /definirPermissaoDeFuncao/.test(CODIGO_FUNCOES) &&
        /from "@\/lib\/ia\/agentes-http"/.test(CODIGO_FUNCOES));
    ok("J4  zero ambiente, banco ou dominio do servidor",
      !/process\.env|getSupabaseServidor|createClient|service_role|lib\/agentes/
        .test(CODIGO_FUNCOES));
    // ── A fronteira desta fase: CONFIGURAR nao e EXECUTAR ───────────
    ok("J5  zero execucao de Function",
      !/executarFuncao|autorizarFuncao|retomarAprovacao|aprovacao[A-Z]|criarTarefa|AdaptadorIA|worker|anthropic/
        .test(CODIGO_FUNCOES));
    ok("J5a e zero botao de executar, testar ou rodar",
      !/>\s*(Executar|Rodar|Testar|Chamar)\s*</.test(ler(FUNCOES)) &&
        !/aria-label="(Executar|Rodar|Testar)/.test(ler(FUNCOES)));
    ok("J5b CONTROLE: a sonda de execucao acusa quando o padrao existe",
      /executarFuncao/.test("await executarFuncao(x)"));

    // ── O catalogo e do SERVIDOR ────────────────────────────────────
    ok("J6  nenhum id de Funcao escrito na tela",
      !/"vendas\.consultar"|'vendas\.consultar'/.test(CODIGO_FUNCOES) &&
        !/MOCK_/.test(CODIGO_FUNCOES));
    ok("J7  a tela NAO pressupoe uma Funcao so",
      !/permissoes\[0\]|\.length === 1/.test(CODIGO_FUNCOES) &&
        /\.map\(\(permissao\)/.test(CODIGO_FUNCOES));
    ok("J7a lista vazia tem estado proprio, e nao some",
      /permissoes\.length === 0/.test(CODIGO_FUNCOES) && /EstadoVazio/.test(CODIGO_FUNCOES));

    // ── `null` e ausencia, e a tela diz isso ────────────────────────
    ok("J8  `nivel: null` vira 'Não configurada', nunca um nivel",
      /permissao\.nivel === null/.test(CODIGO_FUNCOES) &&
        /Não configurada/.test(ler(FUNCOES)));
    ok("J8a e o texto explica que a Funcao esta NEGADA",
      /não pode usar esta função até você escolher um nível/.test(ler(FUNCOES)));
    ok("J8b a tela nunca chama um nivel ausente de ativo, liberado ou automatico",
      !/\b(ativa|habilitada|liberada)\b/i.test(ler(FUNCOES)));

    // ── Os tres niveis gravaveis, e so eles ─────────────────────────
    ok("J9  as opcoes saem do vocabulario canonico, sem lista propria",
      /NIVEIS_AUTONOMIA\.map\(/.test(CODIGO_FUNCOES) &&
        /VOCABULARIO_NIVEL\[nivel\]\.rotulo/.test(CODIGO_FUNCOES) &&
        !/"bloqueado"|"aprovacao"|"automatico"/.test(CODIGO_FUNCOES));
    ok("J9a o placeholder NAO e gravavel e nao volta para null",
      /<option value="" disabled>/.test(ler(FUNCOES)) &&
        !/value=\{null\}|nivel: null/.test(CODIGO_FUNCOES));
    ok("J9b nao existe DELETE nem 'voltar para nao configurada'",
      !/\bDELETE\b|removerPermissao|apagarPermissao/.test(CODIGO_FUNCOES));

    // ── Persistido contra selecionado ───────────────────────────────
    ok("J10 selecao e persistido sao coisas DIFERENTES",
      /const \[selecao, setSelecao\]/.test(CODIGO_FUNCOES) &&
        /escolhido !== undefined && escolhido !== permissao\.nivel/.test(CODIGO_FUNCOES));
    ok("J10a o sucesso usa a resposta do SERVIDOR, nunca o rascunho",
      /p\.id === funcaoId \? \{ \.\.\.p, nivel: resultado\.nivel \}/.test(CODIGO_FUNCOES) &&
        /setSelecao\(\(atual\) => \(\{ \.\.\.atual, \[funcaoId\]: resultado\.nivel \}\)\)/
          .test(CODIGO_FUNCOES) &&
        !/nivel: escolhido|nivel: nivel[,}]/.test(CODIGO_FUNCOES));
    ok("J10a1 CONTROLE NEGATIVO: usar o nivel LOCAL reprovaria",
      !/p\.id === funcaoId \? \{ \.\.\.p, nivel: resultado\.nivel \}/.test(
        CODIGO_FUNCOES.replace("nivel: resultado.nivel", "nivel: nivel")
      ));
    ok("J10b salvar so fica disponivel com alteracao real",
      /disabled=\{emVoo \|\| !alterado\}/.test(CODIGO_FUNCOES));
    ok("J10c o erro NAO limpa a selecao do dono",
      !/setSelecao\(\{\}\)/.test(
        CODIGO_FUNCOES.slice(CODIGO_FUNCOES.indexOf("const mensagem ="))
      ));

    // ── Tudo por Funcao, nada global ────────────────────────────────
    // ── J11.. — a trava, provada por POSICAO e nao por presenca ──────
    //
    // O R1 registrou que a versao anterior deste assert so provava que
    // as pecas existiam: mover a checagem para depois do `await`
    // passaria batido. Agora a ordem e medida por indice no arquivo.
    const iSet = CODIGO_FUNCOES.indexOf("const conjuntoDaOperacao = salvandoRef.current;");
    const iHas = CODIGO_FUNCOES.indexOf("conjuntoDaOperacao.has(funcaoId)");
    const iAdd = CODIGO_FUNCOES.indexOf("conjuntoDaOperacao.add(funcaoId)");
    const iAwait = CODIGO_FUNCOES.indexOf("await definirPermissaoDeFuncao(");
    const iGuard = CODIGO_FUNCOES.indexOf("if (!daMesmaTela()) return;");
    const iFinally = CODIGO_FUNCOES.indexOf("} finally {");
    const iDelete = CODIGO_FUNCOES.indexOf("conjuntoDaOperacao.delete(funcaoId);");
    const iSetLeitura = CODIGO_FUNCOES.indexOf("setLeitura((atual) =>");
    const iSetErros = CODIGO_FUNCOES.indexOf("setErros((atual) => ({ ...atual, [funcaoId]");
    const iConfere = CODIGO_FUNCOES.indexOf("resultado.funcaoId !== funcaoId");

    /** captura -> has -> add -> await, nesta ordem. Como PREDICADO, para
     *  poder ser aplicado tambem a uma fonte MUTADA e provar que a sonda
     *  discrimina em vez de so encontrar palavras. */
    const ordemDaTrava = (fonte: string): boolean => {
      const s = fonte.indexOf("const conjuntoDaOperacao = salvandoRef.current;");
      const h = fonte.indexOf("conjuntoDaOperacao.has(funcaoId)");
      const a = fonte.indexOf("conjuntoDaOperacao.add(funcaoId)");
      const w = fonte.indexOf("await definirPermissaoDeFuncao(");
      return s > 0 && h > s && a > h && w > a;
    };
    const CHAMADA_PATCH =
      "await definirPermissaoDeFuncao(agenteDaOperacao, { funcaoId, nivel });";
    const travaDepoisDoAwait = CODIGO_FUNCOES
      .replace("conjuntoDaOperacao.add(funcaoId);", "")
      .replace(CHAMADA_PATCH, `${CHAMADA_PATCH}\n      conjuntoDaOperacao.add(funcaoId);`);

    ok("J11 a trava e um Set por funcaoId, capturado e fechado ANTES do await",
      /salvandoRef = useRef<Set<string>>/.test(CODIGO_FUNCOES) && ordemDaTrava(CODIGO_FUNCOES));
    ok("J11a `has` e `add` sao adjacentes — nenhum await entre os dois",
      iHas < iAdd && !/await/.test(CODIGO_FUNCOES.slice(iHas, iAdd)));
    ok("J11b CONTROLE NEGATIVO: `add` DEPOIS do await reprovaria a ordem",
      !ordemDaTrava(travaDepoisDoAwait));
    ok("J11b1 ANCORA: a mutacao de controle mexeu no arquivo de verdade",
      travaDepoisDoAwait !== CODIGO_FUNCOES &&
        travaDepoisDoAwait.includes("conjuntoDaOperacao.add(funcaoId)"));
    ok("J11c a liberacao esta em `finally`",
      iFinally > iAwait && iDelete > iFinally);
    ok("J11d CONTROLE NEGATIVO: sem `finally` a sonda reprova",
      !/\} finally \{/.test(CODIGO_FUNCOES.replace("} finally {", "} // nada {")));
    // O conjunto liberado e o CAPTURADO, nunca o `current` do momento:
    // na troca de agente o `current` ja pertence ao agente novo, e um
    // delete ali liberaria a trava de uma operacao REAL dele.
    ok("J11e o `finally` libera o conjunto CAPTURADO, nao `salvandoRef.current`",
      /conjuntoDaOperacao\.delete\(funcaoId\);/.test(CODIGO_FUNCOES) &&
        !/salvandoRef\.current\.delete\(/.test(CODIGO_FUNCOES));
    ok("J11f CONTROLE NEGATIVO: trocar o conjunto por `current` no finally reprovaria",
      /salvandoRef\.current\.delete\(/.test(
        CODIGO_FUNCOES.replace(
          "conjuntoDaOperacao.delete(funcaoId);",
          "salvandoRef.current.delete(funcaoId);"
        )
      ));
    ok("J11g e o Set e RECRIADO na troca, nunca limpo no lugar",
      /salvandoRef\.current = new Set\(\);/.test(CODIGO_FUNCOES) &&
        !/salvandoRef\.current\.clear\(\)/.test(CODIGO_FUNCOES));

    // ── J11h..J11n — PATCH TARDIO, o achado M1 do R1 ─────────────────
    ok("J11h a operacao captura o agente de quem a iniciou",
      /const agenteDaOperacao = agenteId;/.test(CODIGO_FUNCOES) &&
        /definirPermissaoDeFuncao\(agenteDaOperacao,/.test(CODIGO_FUNCOES));
    // A comparacao e contra a REF do agente atual — comparar a closure
    // consigo mesma seria sempre verdadeira e nao provaria nada.
    ok("J11i e compara contra o agente ATUAL, por ref",
      /const agenteAtualRef = useRef\(agenteId\);/.test(CODIGO_FUNCOES) &&
        /const daMesmaTela = \(\) => agenteAtualRef\.current === agenteDaOperacao;/
          .test(CODIGO_FUNCOES) &&
        /agenteAtualRef\.current = agenteId;/.test(CODIGO_FUNCOES));

    // ── J11i1..J11i6 — o TIPO do effect, achado M1 do R2 ─────────────
    //
    // `useEffect` e PASSIVO: o React o agenda, nao o roda no commit.
    // Entre "B ja esta commitado" e "o efeito de B rodou" havia uma
    // janela real — a continuacao de um `await` e microtask e drena
    // antes do macrotask em que o React agenda efeitos passivos —, e
    // nela o ref ainda dizia A. Layout effects rodam SINCRONAMENTE no
    // commit, o que torna a invariante exata.
    //
    // A sonda mede a ATRIBUICAO dentro do callback certo, e nao a
    // palavra `useLayoutEffect` no import ou num comentario: por isso
    // ela recorta o bloco pelo indice e exige a atribuicao dentro dele.
    const iLayout = CODIGO_FUNCOES.indexOf("useLayoutEffect(() => {");
    const iPassivo = CODIGO_FUNCOES.indexOf("useEffect(() => {");
    const iAtribui = CODIGO_FUNCOES.indexOf("agenteAtualRef.current = agenteId;");
    /** A identidade e sincronizada DENTRO do layout effect? */
    const sincronizaNoCommit = (fonte: string): boolean => {
      const inicio = fonte.indexOf("useLayoutEffect(() => {");
      if (inicio < 0) return false;
      const fim = fonte.indexOf("}, [agenteId]);", inicio);
      if (fim < 0) return false;
      return fonte.slice(inicio, fim).includes("agenteAtualRef.current = agenteId;");
    };

    ok("J11i1 a identidade e sincronizada no COMMIT, por useLayoutEffect",
      sincronizaNoCommit(CODIGO_FUNCOES));
    ok("J11i2 o layout effect depende de `agenteId`",
      /useLayoutEffect\(\(\) => \{\s*agenteAtualRef\.current = agenteId;\s*\}, \[agenteId\]\);/
        .test(CODIGO_FUNCOES));
    // UMA atribuicao canonica: duplica-la no efeito passivo faria a
    // protecao parecer existir em dois lugares e um deles seria tarde.
    ok("J11i3 existe UMA unica atribuicao da identidade, e ela e a do commit",
      (CODIGO_FUNCOES.match(/agenteAtualRef\.current = agenteId;/g) ?? []).length === 1 &&
        iAtribui > iLayout && iAtribui < iPassivo);
    ok("J11i4 CONTROLE NEGATIVO: trocar o layout effect por useEffect reprovaria",
      !sincronizaNoCommit(
        CODIGO_FUNCOES.replace("useLayoutEffect(() => {", "useEffect(() => {")
      ));
    ok("J11i5 CONTROLE NEGATIVO: a palavra no import nao basta — sem a atribuicao, reprova",
      !sincronizaNoCommit(
        CODIGO_FUNCOES.replace("agenteAtualRef.current = agenteId;", "")
      ));
    ok("J11i6 ANCORA: o hook e importado de verdade e os dois effects existem",
      /import \{[^}]*useLayoutEffect[^}]*\} from "react";/.test(CODIGO_FUNCOES) &&
        iLayout > 0 && iPassivo > iLayout && iAtribui > 0);
    ok("J11j o guard roda DEPOIS do await e ANTES de todo setState de desfecho",
      iGuard > iAwait && iSetLeitura > iGuard && iSetErros > iGuard && iConfere > iGuard);
    ok("J11k CONTROLE NEGATIVO: remover o guard reprovaria",
      !/if \(!daMesmaTela\(\)\) return;/.test(
        CODIGO_FUNCOES.replace("if (!daMesmaTela()) return;", "")
      ));
    ok("J11l CONTROLE NEGATIVO: um guard sempre verdadeiro reprovaria",
      !/agenteAtualRef\.current === agenteDaOperacao/.test(
        CODIGO_FUNCOES.replace(
          "agenteAtualRef.current === agenteDaOperacao",
          "true /* sempre */"
        )
      ));
    // O caminho de ERRO fica atras do MESMO guard: um `return` unico
    // cobre sucesso e falha, entao nao ha ramo que escreva sem passar
    // por ele.
    ok("J11m o caminho de erro tambem esta atras do guard",
      iSetErros > iGuard &&
        CODIGO_FUNCOES.slice(iGuard, iSetErros).indexOf("if (!daMesmaTela()) return;") === 0);
    ok("J11n o `setSalvando` do finally so ocorre se a tela for a mesma",
      /if \(daMesmaTela\(\)\) \{\s*setSalvando\(/.test(CODIGO_FUNCOES));

    // ── J11o..J11q — a resposta precisa ser sobre a Funcao pedida ────
    ok("J11o o `funcaoId` da resposta e conferido contra o solicitado",
      /if \(resultado\.funcaoId !== funcaoId\) \{/.test(CODIGO_FUNCOES) && iConfere < iSetLeitura);
    ok("J11p divergencia NAO atualiza nada, e vira falha sanitizada",
      /\[funcaoId\]: MENSAGEM_FALHA_SALVAR/.test(CODIGO_FUNCOES) &&
        !/resultado\.funcaoId\]/.test(CODIGO_FUNCOES));
    ok("J11q CONTROLE NEGATIVO: remover a conferencia reprovaria",
      !/if \(resultado\.funcaoId !== funcaoId\) \{/.test(
        CODIGO_FUNCOES.replace("if (resultado.funcaoId !== funcaoId) {", "if (false) {")
      ));
    ok("J11r ANCORA: todos os indices medidos apontam para codigo real",
      [iSet, iHas, iAdd, iAwait, iGuard, iFinally, iDelete, iSetLeitura, iSetErros, iConfere]
        .every((i) => i > 0));
    ok("J11a erro e selecao tambem sao indexados por funcaoId",
      /erros\[permissao\.id\]/.test(CODIGO_FUNCOES) &&
        /selecao\[permissao\.id\]/.test(CODIGO_FUNCOES));

    // ── Troca de agente ─────────────────────────────────────────────
    ok("J12 a leitura reinicia quando o agente muda, com AbortController",
      /useCallback\(/.test(CODIGO_FUNCOES) && /\[agenteId\]/.test(CODIGO_FUNCOES) &&
        /new AbortController\(\)/.test(CODIGO_FUNCOES) &&
        /controlador\.abort\(\)/.test(CODIGO_FUNCOES));
    ok("J12a e resposta de agente anterior NAO povoa a tela do novo",
      /if \(sinal\?\.aborted\) return;/.test(CODIGO_FUNCOES));
    ok("J12b nem estado de selecao, erro ou envio sobrevive a troca",
      /setSelecao\(\{\}\);/.test(CODIGO_FUNCOES) && /setErros\(\{\}\);/.test(CODIGO_FUNCOES) &&
        /salvandoRef\.current = new Set\(\);/.test(CODIGO_FUNCOES));

    ok("J13 os tres estados de leitura existem, e erro tem retry",
      /"carregando"/.test(CODIGO_FUNCOES) && /"pronto"/.test(CODIGO_FUNCOES) &&
        /"erro"/.test(CODIGO_FUNCOES) && /Tentar novamente/.test(ler(FUNCOES)));
    ok("J13a botao de verdade, com rotulo acessivel",
      (ler(FUNCOES).match(/<button/g) ?? []).length >= 2 &&
        /aria-label=/.test(ler(FUNCOES)) &&
        !/<span[^>]*onClick/.test(CODIGO_FUNCOES) && !/<div[^>]*onClick/.test(CODIGO_FUNCOES));
    ok("J14 nada de HTML cru", !/dangerouslySetInnerHTML/.test(CODIGO_FUNCOES));

    ok("J15 o container monta a aba pelo especificador com @/",
      /from "@\/components\/ia\/agente\/FuncoesAgente"/.test(CODIGO_CONTAINER) &&
        /aba === "funcoes" && <FuncoesAgente agenteId=\{agente\.id\} \/>/.test(CODIGO_CONTAINER));
    ok("J15a e NAO monta uma segunda tela em `permissoes`",
      !/aba === "permissoes"/.test(CODIGO_CONTAINER));
    ok("J16 ANCORA: a fonte da tela foi lida de verdade",
      CODIGO_FUNCOES.length > 2000);
  }

  // ── K. FUNCTION-RUNTIME-V1-B2B — executar vendas.consultar ───────
  //
  // A primeira tela que manda uma Funcao REAL trabalhar. Tres coisas a
  // defendem, e nenhuma e visivel numa leitura casual:
  //
  //  1. ela nao tem rede. Toda chamada passa pelo transporte unico, e
  //     A1/A2 continuam exigindo UM arquivo — esta secao prova o lado
  //     de ca: o componente e a lista estao limpos.
  //
  //  2. o polling PARA em `aguardando_aprovacao`. Sem isso a tela
  //     perguntaria para sempre por uma tarefa que so anda quando
  //     alguem decidir — e a decisao ainda nem existe na interface.
  //
  //  3. a permissao aqui e UX. `null` e `bloqueado` nao oferecem o
  //     botao, mas quem recusa de verdade e o runtime; a tela nunca
  //     vira a segunda autoridade.
  secao("K. ExecutarConsultaVendas — dispara a Funcao e acompanha");
  {
    const EXECUTOR = "components/ia/agente/ExecutarConsultaVendas.tsx";
    const FUNCOES_K = "components/ia/agente/FuncoesAgente.tsx";
    const EX = codigo(ler(EXECUTOR));
    const FN = codigo(ler(FUNCOES_K));

    ok("K1  ANCORA: a fonte do executor foi lida de verdade",
      EX.length > 2000 && /export default function ExecutarConsultaVendas\(/.test(EX));

    // ── Rede: nenhuma, dos dois lados ─────────────────────────────
    const semRede = (texto: string): boolean =>
      !/\bfetch\s*\(|XMLHttpRequest|axios|WebSocket/.test(texto) &&
      !/["'`]\/api\//.test(texto);
    ok("K2  o executor nao tem rede nem endereco de API", semRede(EX));
    ok("K2  a lista de Funcoes continua sem rede", semRede(FN));
    ok("K2  CONTROLE NEGATIVO: um fetch no executor reprova",
      !semRede(EX + "\nawait fetch(url);"));
    ok("K2  CONTROLE NEGATIVO: um endereco de API no executor reprova",
      !semRede(EX + '\nconst u = "/api/agentes/x";'));
    ok("K3  e usa o transporte nominal, pelos dois helpers",
      /criarConsultaVendasDoAgente/.test(EX) &&
      /consultarConsultaVendasDoAgente/.test(EX) &&
      /from "@\/lib\/ia\/agentes-http"/.test(EX));

    // ── O executor nao executa ────────────────────────────────────
    ok("K4  zero execucao direta de Funcao ou tarefa",
      !/executarFuncao|executarTarefa|claim_next|reivindicarProximaTarefa|internal\/agentes/.test(EX));
    ok("K4  zero ambiente, banco ou dominio do servidor",
      !/process\.env|getSupabaseServidor|createClient|service_role|lib\/agentes/.test(EX));

    // ── Permissao como UX ─────────────────────────────────────────
    //
    // O predicado e a autoridade da TELA sobre o que oferecer, e o
    // controle negativo prova que ele sabe dizer nao.
    ok("K5  so `aprovacao` e `automatico` habilitam o disparo",
      /function podeDisparar\(nivel: NivelAutonomia \| null\): boolean \{/.test(EX) &&
      /return nivel === "aprovacao" \|\| nivel === "automatico";/.test(EX));
    ok("K5  o bloqueio entra no disabled do botao, nao so no texto",
      /!podeDisparar\(nivel\) \|\|/.test(EX) && /disabled=\{bloqueado\}/.test(EX));
    ok("K5  CONTROLE NEGATIVO: incluir `bloqueado` no predicado reprova",
      !/nivel === "bloqueado"/.test(
        'return nivel === "aprovacao" || nivel === "automatico";'));
    ok("K6  `aprovacao` avisa que a execucao pode parar para decisao",
      /poderá parar e aguardar a sua aprovação/.test(ler(EXECUTOR)));

    // ── Disparo duplo ─────────────────────────────────────────────
    const bloqueia = (texto: string): boolean => {
      const m = texto.match(/const bloqueado =([\s\S]*?);/);
      if (m === null) return false;
      const cond = m[1];
      return (
        /!podeDisparar\(nivel\)/.test(cond) &&
        /enviando/.test(cond) &&
        /emAndamento/.test(cond) &&
        /aguardandoAprovacao/.test(cond)
      );
    };
    ok("K7  submit bloqueado durante envio, execucao viva e espera por aprovacao",
      bloqueia(EX) &&
      /const emAndamento =[\s\S]*?"pendente"[\s\S]*?"rodando"/.test(EX) &&
      /const aguardandoAprovacao =[\s\S]*?"aguardando_aprovacao"/.test(EX));
    ok("K7  CONTROLE NEGATIVO: sem a perna de aprovacao o guarda reprova",
      !bloqueia(EX.replace("    aguardandoAprovacao ||\n", "")));

    // ── Polling ───────────────────────────────────────────────────
    ok("K8  o ritmo e 1500 ms, reagendado por setTimeout",
      /const INTERVALO_CONSULTA_MS = 1500;/.test(EX) &&
      /window\.setTimeout\(/.test(EX) &&
      !/setInterval/.test(EX));
    ok("K8  CONTROLE NEGATIVO: a sonda acusa setInterval quando existe",
      /setInterval/.test("timer = setInterval(f, 1500)"));

    /**
     * A parada. `ehStatusTerminal` e do transporte e trata
     * `aguardando_aprovacao` como terminal — e e exatamente o que esta
     * tela precisa: a tarefa nao anda sem uma decisao que a interface
     * ainda nao oferece.
     */
    const paraNosTerminais = (texto: string): boolean =>
      /if \(ehStatusTerminal\(r\.tarefa\.status\)\) return;/.test(texto) &&
      /ehStatusTerminal/.test(texto);
    ok("K9  o acompanhamento para em todo estado terminal",
      paraNosTerminais(EX));
    ok("K9  CONTROLE NEGATIVO: remover a parada reprova",
      !paraNosTerminais(EX.replace("if (ehStatusTerminal(r.tarefa.status)) return;", "")));
    ok("K9  e `aguardando_aprovacao` conta como terminal no transporte",
      /status !== "pendente" && status !== "rodando"/.test(CODIGO_TRANSPORTE));

    // ── Resposta velha nao sobrescreve nova ───────────────────────
    ok("K10 geracao e AbortController protegem contra resposta atrasada",
      /const geracao = useRef\(0\)/.test(EX) &&
      /new AbortController\(\)/.test(EX) &&
      /if \(minhaGeracao !== geracao\.current\) return;/.test(EX));
    ok("K10 e a desmontagem cancela timer e requisicao",
      /return \(\) => \{[\s\S]*?geracao\.current \+= 1;[\s\S]*?encerrarAcompanhamento\(\);/.test(EX) &&
      /controlador\.current\?\.abort\(\)/.test(EX));

    // ── Falha de rede nao vira falha da tarefa ────────────────────
    ok("K11 falha de acompanhamento e bounded e NAO altera a tarefa",
      /const FALHAS_TOLERADAS = 3;/.test(EX) &&
      /falhasSeguidas\.current >= FALHAS_TOLERADAS/.test(EX));
    ok("K11 e nao existe timeout local que declare erro sozinho",
      !/30_000|60_000|90_000|setTimeout\([^)]*3000\d/.test(EX));

    // ── Query param ───────────────────────────────────────────────
    const soIdNaUrl = (texto: string): boolean => {
      const sets = [...texto.matchAll(/atuais\.set\(([^)]*)\)/g)].map((m) => m[1]);
      return (
        /const PARAM_TAREFA = "tarefaVendas";/.test(texto) &&
        sets.length === 1 &&
        sets[0] === "PARAM_TAREFA, tarefaId"
      );
    };
    ok("K12 a URL guarda o id da tarefa, e nada mais", soIdNaUrl(EX));
    ok("K12 CONTROLE NEGATIVO: gravar o resultado na URL reprova",
      !soIdNaUrl(EX.replace("atuais.set(PARAM_TAREFA, tarefaId);",
        'atuais.set(PARAM_TAREFA, tarefaId);\n      atuais.set("resultado", JSON.stringify(r));')));
    ok("K12 zero armazenamento local de dado financeiro",
      !/localStorage|sessionStorage|indexedDB/i.test(EX));
    ok("K13 recarregar recupera a tarefa pelo SERVIDOR",
      /parametros\?\.get\(PARAM_TAREFA\)/.test(EX) &&
      /UUID_REGEX\.test\(idDaUrl\)/.test(EX) &&
      /void acompanhar\(idDaUrl, minhaGeracao\)/.test(EX));

    // ── Resultado ─────────────────────────────────────────────────
    ok("K14 o resultado e validado no transporte, sem cast cego",
      /function resultadoDaResposta/.test(CODIGO_TRANSPORTE) &&
      !/as any/.test(EX) &&
      !/as any/.test(CODIGO_TRANSPORTE));
    const semDump = (texto: string): boolean =>
      !/JSON\.stringify\(\s*(resultado|dados|tarefa)/.test(texto) &&
      !/<pre/.test(texto);
    ok("K15 nenhum despejo cru do resultado na tela", semDump(EX));
    ok("K15 CONTROLE NEGATIVO: um JSON.stringify(resultado) reprova",
      !semDump(EX + "\n<span>{JSON.stringify(resultado)}</span>"));
    ok("K16 os campos bounded conhecidos sao renderizados",
      /resumo\.pedidos/.test(EX) && /resumo\.unidades/.test(EX) &&
      /resumo\.faturamento/.test(EX) && /resumo\.ticketMedio/.test(EX) &&
      /resumo\.skusDistintos/.test(EX) &&
      /marketplaces\[nome\]/.test(EX) && /truncado &&/.test(EX));
    ok("K16 e nenhuma linha de pedido chega a tela",
      !/pedidos\.map|linhas\.map|order_id|item_subtotal/.test(EX));
    ok("K17 dinheiro sai formatado em BRL, sem recalcular nada",
      /Intl\.NumberFormat\("pt-BR", \{ style: "currency", currency: "BRL" \}\)/.test(EX) &&
      !/\* 100|\/ 100|reduce\(/.test(EX));

    // ── O que a tela NAO faz ──────────────────────────────────────
    const semAcaoProibida = (texto: string): boolean =>
      !/>\s*(Cancelar|Aprovar|Rejeitar)\s*</.test(texto) &&
      !/"DELETE"|"PATCH"/.test(texto) &&
      !/aprovarAprovacao|rejeitarAprovacao|retomarAprovacao|consumirAprovacao/.test(texto);
    ok("K18 nenhuma acao de cancelar, aprovar ou rejeitar", semAcaoProibida(ler(EXECUTOR)));
    ok("K18 CONTROLE NEGATIVO: um botao Cancelar reprova",
      !semAcaoProibida("<button>Cancelar</button>"));
    ok("K19 a espera por aprovacao e informada, sem prometer acao",
      /Esta execução precisa de aprovação/.test(ler(EXECUTOR)) &&
      /etapa seguinte/.test(ler(EXECUTOR)));

    // ── Sem runner generico ───────────────────────────────────────
    // A propriedade e "o id NAO vem de fora", nao "a palavra nao
    // aparece": o predicado local recebe um `funcaoId` para comparar, e
    // isso e o oposto de um runner generico. O que precisa ser provado e
    // que o id e constante de modulo e que nenhuma entrada o escolhe.
    ok("K20 nada de runner generico: a Funcao e fixa no modulo",
      /export const FUNCAO_EXECUTAVEL = "vendas\.consultar";/.test(EX) &&
      /export default function ExecutarConsultaVendas\(\{\s*agenteId,\s*nivel,\s*\}/.test(EX) &&
      !/funcaoId:\s*string;/.test(EX) &&
      !/body: JSON\.stringify\([^)]*funcaoId/.test(EX) &&
      !/searchParams.*funcaoId|get\("funcaoId"\)/.test(EX) &&
      !/jsonSchema|JSONSchema|renderArgs|camposDinamicos/.test(EX));
    ok("K21 a lista monta o executor pelo predicado, sem escrever o id",
      /temSuperficieDeExecucao\(permissao\.id\) && \(/.test(FN) &&
      /<ExecutarConsultaVendas agenteId=\{agenteId\} nivel=\{permissao\.nivel\} \/>/.test(FN) &&
      !/"vendas\.consultar"|'vendas\.consultar'/.test(FN));

    // ── Formulario ────────────────────────────────────────────────
    ok("K22 os tres campos existem, com label ligado ao input",
      /htmlFor="cds-cv-inicio"/.test(EX) && /id="cds-cv-inicio"/.test(EX) &&
      /htmlFor="cds-cv-fim"/.test(EX) && /id="cds-cv-fim"/.test(EX) &&
      /htmlFor="cds-cv-marketplace"/.test(EX) && /id="cds-cv-marketplace"/.test(EX));
    ok("K22 e o marketplace oferece exatamente Todos, Shopee e ML",
      /<option value="">Todos<\/option>/.test(EX) &&
      /<option value="Shopee">Shopee<\/option>/.test(EX) &&
      /<option value="ML">Mercado Livre<\/option>/.test(EX));
    ok("K23 a tela nao duplica a regra de dominio do servidor",
      !/JANELA_MAXIMA|\b14\b/.test(EX) && !/validarFiltroVendas/.test(EX));

    // ── K24..K27 — a trava SINCRONA do envio (B2B-F1) ─────────────
    //
    // O `disabled` do botao e o guard de `bloqueado` sao os dois
    // corretos e os dois TARDIOS: ambos dependem de `enviando` ja ter
    // virado `true` num render. Entre o primeiro evento e esse render
    // existe uma janela, e dois submits despachados no mesmo frame
    // atravessam juntos — duas tarefas `consultar_vendas`, duas
    // execucoes reais e, no nivel `aprovacao`, potencialmente duas
    // Approvals que ninguem consegue apagar.
    //
    // O que fecha a janela e um ref, porque ref muda no instante em que
    // e escrito. A ordem importa tanto quanto a existencia: ler o ref
    // DEPOIS do primeiro `await` nao fecharia nada.

    /** O corpo do handler, por chaves balanceadas — a ordem so pode ser
     *  medida dentro dele. */
    const corpoDoEnviar = (texto: string): string => {
      const i = texto.indexOf("async function enviar(");
      if (i < 0) return "";
      const iAbre = texto.indexOf("{", texto.indexOf(")", i));
      if (iAbre < 0) return "";
      let nivel = 0;
      for (let k = iAbre; k < texto.length; k++) {
        if (texto[k] === "{") nivel += 1;
        else if (texto[k] === "}") {
          nivel -= 1;
          if (nivel === 0) return texto.slice(iAbre, k + 1);
        }
      }
      return "";
    };

    const travaSincrona = (texto: string): boolean => {
      const corpo = corpoDoEnviar(texto);
      if (corpo.length === 0) return false;

      const iGuarda = corpo.indexOf("if (envioEmCursoRef.current) return;");
      const iTrava = corpo.indexOf("envioEmCursoRef.current = true;");
      const iAwait = corpo.indexOf("await ");
      if (iGuarda < 0 || iTrava < 0 || iAwait < 0) return false;

      // Ler, travar, e SO entao entrar no assincrono.
      if (!(iGuarda < iTrava && iTrava < iAwait)) return false;

      // A liberacao nao pode morar aqui: um `finally` devolveria a trava
      // antes de o render materializar `enviando: false` e, no sucesso,
      // antes de a tarefa ativa existir — um instante sem guarda nenhum.
      return (
        !/envioEmCursoRef\.current = false/.test(corpo) && !/\bfinally\b/.test(corpo)
      );
    };

    ok("K24 ANCORA: o corpo do handler de envio foi recortado",
      corpoDoEnviar(EX).length > 400 && corpoDoEnviar(EX).length < EX.length);
    ok("K24 a trava e lida e fechada ANTES do primeiro await", travaSincrona(EX));
    ok("K25 CONTROLE NEGATIVO: sem o early-return da trava, reprova",
      !travaSincrona(EX.replace("if (envioEmCursoRef.current) return;", "")));
    ok("K26 CONTROLE NEGATIVO: travar DEPOIS do await reprova",
      !travaSincrona(
        EX.replace("    envioEmCursoRef.current = true;\n", "").replace(
          "    if (minhaGeracao !== geracao.current) return;\n    setEnviando(false);",
          "    envioEmCursoRef.current = true;\n    if (minhaGeracao !== geracao.current) return;\n    setEnviando(false);"
        )));
    ok("K27 CONTROLE NEGATIVO: liberar a trava num finally do handler reprova",
      !travaSincrona(
        EX.replace("if (bloqueado) return;",
          "if (bloqueado) return;\n    try { /* */ } finally { envioEmCursoRef.current = false; }")));

    // A liberacao vive num efeito, que so roda apos o commit.
    const liberacaoAposRender = (texto: string): boolean =>
      /useEffect\(\(\) => \{\s*if \(!enviando\) envioEmCursoRef\.current = false;\s*\}, \[enviando\]\);/
        .test(texto);
    ok("K28 a trava e devolvida depois do render, atrelada a `enviando`",
      liberacaoAposRender(EX));
    ok("K28 CONTROLE NEGATIVO: liberar sem depender de `enviando` reprova",
      !liberacaoAposRender(EX.replace("}, [enviando]);", "}, []);")));

    // Defesa em profundidade: o ref NAO substituiu os outros dois.
    ok("K29 `disabled` e o guard de estado continuam no lugar",
      /disabled=\{bloqueado\}/.test(EX) && /if \(bloqueado\) return;/.test(EX));

    // ── K30..K31 — a query existente sobrevive (B2B-F1) ───────────
    //
    // A aba desta tela vive em `?aba=funcoes`. Escrever `tarefaVendas`
    // sobre uma query nova, em vez de sobre a atual, jogaria o dono
    // para fora da propria tela em que ele acabou de clicar.
    const partiuDosParamsAtuais = (texto: string): boolean => {
      // O argumento contem `)` — `toString()` —, entao nada de
      // `[^)]*`: a primeira versao desta sonda parava no meio da
      // expressao e reprovava codigo correto. Contar o literal exato e
      // comparar com o total de construcoes diz a mesma coisa sem
      // depender de casar parenteses.
      const daQueryAtual = (
        texto.match(/new URLSearchParams\(parametros\?\.toString\(\) \?\? ""\)/g) ?? []
      ).length;
      const todas = (texto.match(/new URLSearchParams\(/g) ?? []).length;
      if (todas === 0 || daQueryAtual !== todas) return false;

      // E so `tarefaVendas` e tocado — nenhum outro param e escrito nem
      // removido.
      const tocados = [...texto.matchAll(/atuais\.(?:set|delete)\(([^)]*)\)/g)].map((m) =>
        m[1].trim()
      );
      return (
        tocados.length === 2 &&
        tocados.every((a) => a.startsWith("PARAM_TAREFA")) &&
        /router\.replace\(/.test(texto)
      );
    };

    ok("K30 a URL e reescrita a partir dos parametros ATUAIS", partiuDosParamsAtuais(EX));
    ok("K30 CONTROLE NEGATIVO: comecar de uma query vazia reprova",
      !partiuDosParamsAtuais(
        EX.replace(/new URLSearchParams\(parametros\?\.toString\(\) \?\? ""\)/g,
          "new URLSearchParams()")));
    ok("K31 CONTROLE NEGATIVO: mexer num segundo parametro reprova",
      !partiuDosParamsAtuais(
        EX.replace("atuais.set(PARAM_TAREFA, tarefaId);",
          'atuais.set(PARAM_TAREFA, tarefaId);\n      atuais.set("aba", "funcoes");')));
  }

  // ── L. O resultado real de producao (B2B-E2E-F1) ─────────────────
  //
  // Esta secao existe por causa de um defeito que so apareceu na
  // PRIMEIRA execucao real. A consulta funcionou: o dispatcher
  // reivindicou a tarefa, `vendas.consultar` leu 252 pedidos e o
  // agregado foi persistido inteiro. A tela disse "o resultado nao pode
  // ser exibido".
  //
  // A causa era um tipo a menos no transporte. O handler publica DUAS
  // formas — `ResumoConsultarVendas` com seis campos e
  // `BucketMarketplace` com quatro —, e o transporte tinha uma so, de
  // seis, aplicada aos dois. `marketplaces.Shopee.ticketMedio` chegava
  // `undefined`, o validador devolvia `null`, e um resultado perfeito
  // virava uma mensagem de erro.
  //
  // Os asserts abaixo fixam a diferenca nos dois sentidos: o balde NAO
  // pode exigir os campos do total, e o total NAO pode parar de
  // exigi-los. Relaxar qualquer um dos lados reabre um defeito
  // diferente.
  secao("L. Resultado de vendas — resumo e balde sao formas distintas");
  {
    const TRANSPORTE_L = "lib/ia/agentes-http.ts";
    const TR = codigo(ler(TRANSPORTE_L));

    ok("L1  ANCORA: o transporte foi lido e tem o validador de resultado",
      TR.length > 2000 && /function resultadoDaResposta/.test(TR));

    /** As chaves que uma lista NOMINAL do transporte declara. */
    const camposDe = (nome: string): readonly string[] => {
      const m = TR.match(new RegExp(`const ${nome} = \\[([\\s\\S]*?)\\] as const;`));
      if (m === null) return [];
      return [...m[1].matchAll(/"([a-zA-Z]+)"/g)].map((x) => x[1]).sort();
    };

    const RESUMO_REAL = ["faturamento", "linhas", "pedidos", "skusDistintos", "ticketMedio", "unidades"];
    const BUCKET_REAL = ["faturamento", "linhas", "pedidos", "unidades"];

    const campos = (nome: string) => JSON.stringify(camposDe(nome));

    // ── A forma do TOTAL: seis campos ─────────────────────────────
    ok(`L2  o resumo exige os SEIS campos do total ${campos("CAMPOS_RESUMO")}`,
      JSON.stringify(camposDe("CAMPOS_RESUMO")) === JSON.stringify(RESUMO_REAL));

    // ── A forma do BALDE: quatro campos ───────────────────────────
    ok(`L3  o balde de marketplace exige os QUATRO campos ${campos("CAMPOS_BUCKET")}`,
      JSON.stringify(camposDe("CAMPOS_BUCKET")) === JSON.stringify(BUCKET_REAL));

    // ── O GUARD PRINCIPAL DO F1 ───────────────────────────────────
    //
    // A regressao exata: voltar a exigir `ticketMedio` ou
    // `skusDistintos` do balde. Foi isso que reprovou todo resultado
    // real de producao.
    const baldeNaoExigeCamposDoTotal = (texto: string): boolean => {
      const m = texto.match(/const CAMPOS_BUCKET = \[([\s\S]*?)\] as const;/);
      if (m === null) return false;
      const lista = m[1];
      return !/ticketMedio/.test(lista) && !/skusDistintos/.test(lista);
    };
    ok("L4  REGRESSAO: o balde NAO exige ticketMedio nem skusDistintos",
      baldeNaoExigeCamposDoTotal(TR));
    // A mutacao altera o CONTEUDO da lista, nao um recorte com quebra
    // de linha: `CAMPOS_BUCKET` esta numa linha so e `CAMPOS_RESUMO` em
    // varias. A primeira versao desta sonda casava com o formato
    // multilinha, nao mutava nada, e por isso ficava vermelha sobre
    // codigo correto.
    const comCampoExtraNoBalde = (extra: string): string =>
      TR.replace(
        'const CAMPOS_BUCKET = ["linhas", "pedidos", "unidades", "faturamento"] as const;',
        `const CAMPOS_BUCKET = ["linhas", "pedidos", "unidades", "faturamento", "${extra}"] as const;`
      );
    ok("L4  ANCORA: a mutacao do balde altera mesmo a lista",
      comCampoExtraNoBalde("ticketMedio") !== TR);
    ok("L4  CONTROLE NEGATIVO: voltar a exigir ticketMedio no balde reprova",
      !baldeNaoExigeCamposDoTotal(comCampoExtraNoBalde("ticketMedio")));
    ok("L4  CONTROLE NEGATIVO: voltar a exigir skusDistintos no balde reprova",
      !baldeNaoExigeCamposDoTotal(comCampoExtraNoBalde("skusDistintos")));

    // ── E o total continua estrito ────────────────────────────────
    const resumoExigeOsSeis = (texto: string): boolean => {
      const m = texto.match(/const CAMPOS_RESUMO = \[([\s\S]*?)\] as const;/);
      if (m === null) return false;
      return /ticketMedio/.test(m[1]) && /skusDistintos/.test(m[1]);
    };
    ok("L5  o total continua exigindo ticketMedio e skusDistintos",
      resumoExigeOsSeis(TR));
    ok("L5  CONTROLE NEGATIVO: afrouxar o total reprova",
      !resumoExigeOsSeis(TR.replace('  "ticketMedio",\n', "")));

    // ── As duas listas sao DIFERENTES, e por construcao ───────────
    ok("L6  resumo e balde nao compartilham a mesma lista de campos",
      JSON.stringify(camposDe("CAMPOS_RESUMO")) !== JSON.stringify(camposDe("CAMPOS_BUCKET")) &&
      camposDe("CAMPOS_RESUMO").length === 6 &&
      camposDe("CAMPOS_BUCKET").length === 4);

    // ── Cada validador no seu lugar ───────────────────────────────
    ok("L7  o resumo e validado por resumoDaResposta e os tres baldes pelo do balde",
      /const totais = resumoDaResposta\(resumo\);/.test(TR) &&
      /const shopee = bucketMarketplaceDaResposta\(marketplaces\.Shopee\);/.test(TR) &&
      /const ml = bucketMarketplaceDaResposta\(marketplaces\.ML\);/.test(TR) &&
      /const outros = bucketMarketplaceDaResposta\(marketplaces\.outros\);/.test(TR));
    ok("L7  CONTROLE NEGATIVO: validar o balde com o validador do total reprova",
      !/const shopee = bucketMarketplaceDaResposta/.test(
        TR.replace("const shopee = bucketMarketplaceDaResposta(marketplaces.Shopee);",
          "const shopee = resumoDaResposta(marketplaces.Shopee);")));

    // ── O rigor numerico NAO foi relaxado ─────────────────────────
    ok("L8  numero invalido continua recusado nas duas formas",
      /typeof valor !== "number" \|\| !Number\.isFinite\(valor\)/.test(TR) &&
      /function numerosNominais\(/.test(TR));
    ok("L8  CONTROLE NEGATIVO: aceitar nao-finito reprova",
      !/!Number\.isFinite\(valor\)/.test(
        TR.replace('typeof valor !== "number" || !Number.isFinite(valor)',
          'typeof valor !== "number"')));

    // ── O tipo unico antigo nao voltou ────────────────────────────
    ok("L9  o tipo unico que causou o defeito nao existe mais",
      !/NumerosConsultaVendas/.test(TR) &&
      /export interface ResumoConsultaVendasUI/.test(TR) &&
      /export interface BucketMarketplaceUI/.test(TR));

    // ── O resto do contrato do resultado ficou intacto ────────────
    ok("L10 periodo e truncado nao mudaram",
      /if \(typeof truncado !== "boolean"\) return null;/.test(TR) &&
      /if \(marketplace !== null && typeof marketplace !== "string"\) return null;/.test(TR) &&
      /if \(typeof dataInicio !== "string" \|\| typeof dataFim !== "string"\) return null;/.test(TR));

    // ── A tela le do balde so o que o balde tem ───────────────────
    //
    // Se o componente um dia pedir `ticketMedio` de um marketplace, o
    // dado nao existe e o numero teria de ser inventado aqui.
    const EXEC_L = codigo(ler("components/ia/agente/ExecutarConsultaVendas.tsx"));
    ok("L11 o componente nao le ticketMedio nem skusDistintos de um balde",
      !/marketplaces\[nome\]\.ticketMedio/.test(EXEC_L) &&
      !/marketplaces\[nome\]\.skusDistintos/.test(EXEC_L) &&
      /marketplaces\[nome\]\.pedidos/.test(EXEC_L));
  }


  console.log(`\n══ ${passou} PASS / ${falhou} FAIL ══\n`);
  process.exitCode = falhou === 0 ? 0 : 1;
}

principal().catch((e) => {
  globalThis.fetch = fetchOriginal;
  console.log(`  FAIL  excecao nao tratada — ${String(e).slice(0, 300)}`);
  process.exitCode = 1;
});
