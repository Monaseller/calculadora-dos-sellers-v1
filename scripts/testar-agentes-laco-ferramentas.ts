/**
 * O laco de ferramentas — contrato, guard e teto. AGENT-FACTORY-F1/F2.
 *
 * ── A assercao que da nome a suite ──────────────────────────────────
 *
 *   NENHUMA ferramenta roda sem passar pelo guard.
 *
 * Ela e provada de DUAS formas, de proposito. Estruturalmente: o laco
 * conhece uma unica porta de execucao e nao alcanca o executor por
 * nenhum outro nome. Comportamentalmente: com a porta recusando, nada
 * executa, e o dialogo continua com a recusa.
 *
 * Uma sonda so estrutural provaria que o texto esta certo hoje; uma so
 * comportamental provaria o caminho testado e nao os outros. As duas
 * juntas cobrem o que cada uma deixa passar.
 *
 * Sem rede, sem banco, sem IA, sem provedor. Rodar:
 *   npx tsx scripts/testar-agentes-laco-ferramentas.ts
 */
import "./_server-only-inerte";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DECLARACOES,
  declararFerramentas,
  type FerramentaDeclarada,
} from "@/lib/agentes/ia/ferramentas";
import { criarAdaptadorFakeComFerramentas, type EspiaoDoFake } from "@/lib/agentes/ia/ferramentas-fake";
// ── F7b.4.8.1: o texto do runtime passou a ter QUATRO versoes ──────
//
// Uma frase so dizia "a ferramenta ou fonte necessaria nao esta
// disponivel" para permissao, para conexao e para fonte. O Rodrigo leu
// isso sobre um agente que TINHA a ferramenta, a permissao e a loja.
//
// A intencao destes asserts nao muda — "o texto e do RUNTIME, e nao do
// modelo". Ela fica mais forte: agora eles cobram a frase da CATEGORIA
// certa, entao uma categoria trocada tambem reprova.
import {
  MENSAGEM_POR_CATEGORIA, categoriaDoBloqueio,
} from "@/lib/agentes/ia/falhas-de-ferramenta";
import {
  conversarComFerramentas,
  MAX_PASSOS_DE_FERRAMENTA,
} from "@/lib/agentes/ia/laco-ferramentas";
import { FUNCOES } from "@/lib/agentes/funcoes/registry";
import {
  lerResposta,
  montarFerramentas,
  montarMensagens,
  mapearNomes,
  montarEscolha,
  sanitizarNome,
} from "@/lib/ai-gateway/provedores/anthropic-ferramentas";
import {
  lerPassos,
  montarFerramentasGoogle,
  montarPassos,
  montarEscolhaGoogle,
} from "@/lib/ai-gateway/provedores/google-ferramentas";

let passou = 0;
let falhou = 0;
const ok = (nome: string, cond: boolean, det = ""): void => {
  if (cond) { passou += 1; console.log(`  PASS  ${nome}`); }
  else { falhou += 1; console.log(`  FAIL  ${nome}${det ? `  — ${det}` : ""}`); }
};
const secao = (t: string) =>
  console.log(`\n── ${t} ${"─".repeat(Math.max(2, 58 - t.length))}`);

const RAIZ = join(__dirname, "..");
const ler = (rel: string) => readFileSync(join(RAIZ, rel), "utf8");

/**
 * As sondas estruturais leem CODIGO, nunca prosa.
 *
 * A primeira versao de D1/D2 reprovava porque o docblock do laco CITA
 * `resolverFuncao` e `autorizarFuncao` para dizer que nao os usa. O
 * arquivo estava certo; a sonda e que media o texto inteiro. Mesmo
 * `semComentarios` que `testar-ia-skill-1d-b.ts` ja usa.
 */
const semComentarios = (f: string) =>
  f.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ 	]*\/\/.*$/gm, "");

const LACO = semComentarios(ler("lib/agentes/ia/laco-ferramentas.ts"));
const CONTRATO = semComentarios(ler("lib/agentes/ia/ferramentas.ts"));
const FAKE = semComentarios(ler("lib/agentes/ia/ferramentas-fake.ts"));
const LACO_BRUTO = ler("lib/agentes/ia/laco-ferramentas.ts");

const DONO = "dono-1";
const AGENTE = "agente-1";
const ID_VENDAS = "vendas.consultar";
const ID_ML = "mercadolivre.perguntas.listar";

/** Uma porta de execucao roteirizada — o lugar do guard nos testes. */
function portaQueResponde(
  respostas: readonly { tipo: string; envelope?: unknown; requestId?: string }[],
  espiao: { chamadas: { funcaoId: string; userId: string; agenteId: string }[] }
) {
  let i = 0;
  return (async (entrada: { funcaoId: string; userId: string; agenteId: string }) => {
    espiao.chamadas.push({
      funcaoId: entrada.funcaoId, userId: entrada.userId, agenteId: entrada.agenteId,
    });
    const r = respostas[Math.min(i, respostas.length - 1)];
    i += 1;
    return { requestId: r.requestId ?? `req-${i}`, ...r };
  }) as never;
}

const TODAS: readonly FerramentaDeclarada[] = declararFerramentas({
  catalogo: FUNCOES,
  permissoes: [{ funcaoId: ID_VENDAS, nivel: "automatico" }],
});

async function main(): Promise<void> {
  console.log("\n══ CDS IA — laco de ferramentas: contrato, guard e teto ══");

  // =====================================================================
  secao("A. Declaracao: o modelo ve o que o dono CONFIGUROU");
  // =====================================================================
  {
    const auto = declararFerramentas({
      catalogo: FUNCOES,
      permissoes: [{ funcaoId: ID_VENDAS, nivel: "automatico" }],
    });
    ok("A1  permissao `automatico` entra", auto.length === 1 && auto[0].nome === ID_VENDAS,
      auto.map((f) => f.nome).join(","));

    ok("A2  permissao `aprovacao` tambem entra — quem aprova precisa ver",
      declararFerramentas({ catalogo: FUNCOES,
        permissoes: [{ funcaoId: ID_VENDAS, nivel: "aprovacao" }] }).length === 1);

    // AGENT-FACTORY-F7b inverteu isto, e para MAIS seguro. Antes
    // `bloqueado` nao era declarado, e o efeito medido num turno REAL
    // foi o modelo responder de cabeca porque o guard nunca era
    // consultado. Agora `bloqueado` E declarado: o modelo pede, o guard
    // nega, o laco fecha o turno.
    ok("A3  `bloqueado` ENTRA — para o guard poder negar e fechar o turno",
      declararFerramentas({ catalogo: FUNCOES,
        permissoes: [{ funcaoId: ID_VENDAS, nivel: "bloqueado" }] }).length === 1);
    ok("A3a mas permissao AUSENTE continua fora — ninguem decidiu nada",
      declararFerramentas({ catalogo: FUNCOES, permissoes: [] }).length === 0);
    ok("A3b e a declaracao NAO avisa que esta bloqueada — um modelo que",
      (() => { const d = declararFerramentas({ catalogo: FUNCOES,
          permissoes: [{ funcaoId: ID_VENDAS, nivel: "bloqueado" }] })[0];
        // ...soubesse desviaria, e desviar significa responder de cabeca.
        return !/bloquead|negad|indisponivel|sem permiss/i.test(d.descricao); })());

    ok("A4  sem permissao NAO entra",
      declararFerramentas({ catalogo: FUNCOES, permissoes: [] }).length === 0);

    ok("A5  permissao para Funcao FORA do catalogo nao entra",
      declararFerramentas({ catalogo: FUNCOES,
        permissoes: [{ funcaoId: "nao.existe", nivel: "automatico" }] }).length === 0);

    const duas = declararFerramentas({ catalogo: FUNCOES, permissoes: [
      { funcaoId: ID_ML, nivel: "automatico" }, { funcaoId: ID_VENDAS, nivel: "automatico" }] });
    ok("A6  ordem estavel — o mesmo agente produz a mesma declaracao",
      duas.map((f) => f.nome).join(",") === [ID_ML, ID_VENDAS].sort().join(","),
      duas.map((f) => f.nome).join(","));

    ok("A7  toda Funcao do catalogo tem declaracao escrita",
      Object.keys(FUNCOES).every((id) => id in DECLARACOES),
      Object.keys(FUNCOES).filter((id) => !(id in DECLARACOES)).join(","));

    ok("A8  a declaracao nao expoe executor, validador nem interpretador",
      TODAS.every((f) => Object.keys(f).sort().join(",") === "descricao,nome,schemaEntrada"));
  }

  // =====================================================================
  secao("B. O caminho feliz, e o que o modelo recebe de volta");
  // =====================================================================
  {
    const espiaoPorta = { chamadas: [] as { funcaoId: string; userId: string; agenteId: string }[] };
    const espiaoFake: EspiaoDoFake = { chamadas: [] };
    const r = await conversarComFerramentas({
      userId: DONO, agenteId: AGENTE, instrucao: "Voce e um agente.",
      mensagemDoUsuario: "Quanto vendi?", ferramentas: TODAS,
      adaptador: criarAdaptadorFakeComFerramentas([
        { tipo: "pede", pedidos: [{ nome: ID_VENDAS, argumentos: { inicio: "2026-09-01", fim: "2026-09-30" } }] },
        { tipo: "fala", texto: "Voce vendeu R$ 10." },
      ], espiaoFake),
      executar: portaQueResponde([{ tipo: "sucesso", envelope: { data: { linhas: 3 } } }], espiaoPorta),
    });

    ok("B1  o laco conclui com texto", r.motivo === "concluido" && r.texto === "Voce vendeu R$ 10.",
      `${r.motivo}/${r.texto}`);
    ok("B2  a ferramenta foi executada UMA vez", espiaoPorta.chamadas.length === 1);
    ok("B3  e com o id pedido", espiaoPorta.chamadas[0]?.funcaoId === ID_VENDAS);
    ok("B4  a autoridade veio do LACO, nunca do modelo",
      espiaoPorta.chamadas[0]?.userId === DONO && espiaoPorta.chamadas[0]?.agenteId === AGENTE);
    ok("B5  o passo foi registrado como executado",
      r.passos.length === 1 && r.passos[0].executou && r.passos[0].desfecho === "sucesso");
    ok("B6  o modelo recebeu o `data` do envelope, nao o objeto de execucao",
      espiaoFake.chamadas[1]?.ultimaRespostaDeFerramenta === '{"linhas":3}',
      String(espiaoFake.chamadas[1]?.ultimaRespostaDeFerramenta));
    ok("B7  o resultado NAO carrega requestId nem auditoria para o modelo",
      !/requestId|auditoria/.test(String(espiaoFake.chamadas[1]?.ultimaRespostaDeFerramenta)));
    ok("B8  uso agregado dos dois turnos", r.uso.turnos === 2 && r.uso.tokensEntrada === 20);
    ok("B9  o modelo viu SOMENTE as ferramentas declaradas",
      espiaoFake.chamadas[0]?.ferramentas.join(",") === ID_VENDAS);
  }

  // =====================================================================
  secao("C. GUARD — a assercao central");
  // =====================================================================
  {
    for (const [rotulo, tipo, frase] of [
      ["C1  guard NEGOU: nao executa, e o dialogo segue", "negado",
       "Esta ferramenta nao esta habilitada para este agente."],
      ["C2  aprovacao PENDENTE: nao executa", "aguardando_aprovacao",
       "Esta acao precisa de aprovacao humana antes de ser executada."],
      ["C3  indisponivel: nao executa", "indisponivel",
       "Nao foi possivel usar esta ferramenta agora."],
    ] as const) {
      const espiaoFake: EspiaoDoFake = { chamadas: [] };
      const r = await conversarComFerramentas({
        userId: DONO, agenteId: AGENTE, instrucao: "i", mensagemDoUsuario: "m",
        ferramentas: TODAS,
        adaptador: criarAdaptadorFakeComFerramentas([
          { tipo: "pede", pedidos: [{ nome: ID_VENDAS, argumentos: {} }] },
          { tipo: "fala", texto: "ok" },
        ], espiaoFake),
        executar: portaQueResponde([{ tipo }], { chamadas: [] }),
      });
      // AGENT-FACTORY-F4.1 mudou isto de proposito, e para MAIS forte.
      //
      // Antes: a recusa voltava ao modelo e "o dialogo seguia" — e foi
      // exatamente ai que a conversa REAL do F4 mostrou o modelo
      // respondendo com um numero que nenhuma ferramenta produziu.
      //
      // Agora o turno FECHA. A frase da recusa continua sendo cobrada
      // (ela viaja no dialogo, para auditoria e para a UI), mas o
      // modelo NAO e chamado outra vez — e e isso que o assert passa a
      // medir. "Nao executou" continua valendo; ganhou-se "e nao teve
      // onde escrever".
      const ultimaFerramenta = [...r.mensagens].reverse()
        .find((m) => m.papel === "ferramenta");
      ok(rotulo,
        r.passos.length === 1 && r.passos[0].executou === false &&
          r.passos[0].desfecho === tipo &&
          ultimaFerramenta?.papel === "ferramenta" &&
          ultimaFerramenta.respostas[0]?.conteudo === frase,
        `${r.passos[0]?.desfecho}/${r.passos[0]?.executou}`);
      ok(`${rotulo.slice(0, 2)}f o turno FECHOU — o modelo nao foi chamado de novo`,
        r.motivo === "bloqueado_por_ferramenta" && espiaoFake.chamadas.length === 1,
        `${r.motivo}/${espiaoFake.chamadas.length}`);
      ok(`${rotulo.slice(0, 2)}g e o texto final e do RUNTIME, na categoria certa`,
        r.bloqueio !== null &&
          r.texto === MENSAGEM_POR_CATEGORIA[
            categoriaDoBloqueio(r.bloqueio.desfecho, r.bloqueio.codigo)] &&
          r.texto !== "ok",
        `${String(r.bloqueio?.categoria)} / ${String(r.texto).slice(0, 60)}`);
    }

    // O modelo pede uma ferramenta que NAO lhe foi declarada.
    const espiaoPorta = { chamadas: [] as { funcaoId: string; userId: string; agenteId: string }[] };
    const r = await conversarComFerramentas({
      userId: DONO, agenteId: AGENTE, instrucao: "i", mensagemDoUsuario: "m",
      ferramentas: TODAS,
      adaptador: criarAdaptadorFakeComFerramentas([
        { tipo: "pede", pedidos: [{ nome: ID_ML, argumentos: {} }] },
        { tipo: "fala", texto: "ok" },
      ]),
      executar: portaQueResponde([{ tipo: "sucesso", envelope: { data: {} } }], espiaoPorta),
    });
    ok("C4  ferramenta NAO declarada nem chega a porta de execucao",
      espiaoPorta.chamadas.length === 0 && r.passos[0]?.desfecho === "nome_invalido",
      `${espiaoPorta.chamadas.length} chamadas`);

    ok("C5  CONTROLE: a mesma montagem EXECUTA quando a ferramenta e declarada",
      (await (async () => {
        const e = { chamadas: [] as { funcaoId: string; userId: string; agenteId: string }[] };
        await conversarComFerramentas({
          userId: DONO, agenteId: AGENTE, instrucao: "i", mensagemDoUsuario: "m",
          ferramentas: TODAS,
          adaptador: criarAdaptadorFakeComFerramentas([
            { tipo: "pede", pedidos: [{ nome: ID_VENDAS, argumentos: {} }] },
            { tipo: "fala", texto: "ok" }]),
          executar: portaQueResponde([{ tipo: "sucesso", envelope: { data: {} } }], e),
        });
        return e.chamadas.length;
      })()) === 1);
  }

  // =====================================================================
  secao("D. Estrutura — uma unica porta de execucao");
  // =====================================================================
  {
    ok("D1  o laco NAO importa `resolverFuncao`", !/resolverFuncao/.test(LACO));
    ok("D2  o laco NAO importa `autorizarFuncao`", !/autorizarFuncao/.test(LACO));
    ok("D3  o laco NAO alcanca `.executor(`", !/\.executor\(/.test(LACO));
    ok("D4  o laco NAO importa o catalogo `FUNCOES`", !/\bFUNCOES\b/.test(LACO));
    ok("D5  a UNICA porta importada da camada de execucao e `executarFuncao`",
      (LACO.match(/from "@\/lib\/agentes\/execucao-funcoes\/executar"/g) ?? []).length === 1 &&
        /import \{ executarFuncao \}/.test(LACO));
    ok("D6  e o default da porta e ela mesma",
      /entrada\.executar \?\? executarFuncao/.test(LACO));
    ok("D7  CONTROLE: as sondas acusam os nomes proibidos quando existem",
      /resolverFuncao/.test("resolverFuncao(x)") && /\.executor\(/.test("d.executor(c,a)"));
    ok("D7a CONTROLE: o docblock CITA os nomes, e por isso a sonda le codigo",
      /resolverFuncao/.test(LACO_BRUTO) && !/resolverFuncao/.test(LACO));

    ok("D8  nenhum modulo de PRODUCAO preenche a porta `executar`",
      !/executar:\s*[a-zA-Z]/.test(LACO + CONTRATO + FAKE));

    ok("D9  nenhuma rede nos modulos novos",
      !/fetch\(|axios|https?:\/\//.test(LACO + CONTRATO + FAKE));
    ok("D10 nenhum `eval` nem `new Function`",
      !/\beval\(|new Function\(/.test(LACO + CONTRATO + FAKE));
    ok("D11 o contrato e o fake sao PUROS — sem server-only",
      !/import "server-only"/.test(CONTRATO) && !/import "server-only"/.test(FAKE));
    ok("D12 o laco E server-only", /import "server-only"/.test(LACO));
  }

  // =====================================================================
  secao("E. Teto de passos");
  // =====================================================================
  {
    const espiaoPorta = { chamadas: [] as { funcaoId: string; userId: string; agenteId: string }[] };
    const pedirSempre = Array.from({ length: 20 }, () => ({
      tipo: "pede" as const, pedidos: [{ nome: ID_VENDAS, argumentos: {} }],
    }));
    const r = await conversarComFerramentas({
      userId: DONO, agenteId: AGENTE, instrucao: "i", mensagemDoUsuario: "m",
      ferramentas: TODAS,
      adaptador: criarAdaptadorFakeComFerramentas(pedirSempre),
      executar: portaQueResponde([{ tipo: "sucesso", envelope: { data: {} } }], espiaoPorta),
    });
    ok("E1  o laco para no teto, e nao gira para sempre",
      r.motivo === "teto_de_passos", r.motivo);
    ok("E2  executou exatamente MAX_PASSOS vezes",
      espiaoPorta.chamadas.length === MAX_PASSOS_DE_FERRAMENTA,
      `${espiaoPorta.chamadas.length} de ${MAX_PASSOS_DE_FERRAMENTA}`);
    ok("E3  e devolve sem texto, sem lancar", r.texto === null && r.passos.length === MAX_PASSOS_DE_FERRAMENTA);

    const r2 = await conversarComFerramentas({
      userId: DONO, agenteId: AGENTE, instrucao: "i", mensagemDoUsuario: "m",
      ferramentas: TODAS, maxPassos: 1,
      adaptador: criarAdaptadorFakeComFerramentas(pedirSempre),
      executar: portaQueResponde([{ tipo: "sucesso", envelope: { data: {} } }], { chamadas: [] }),
    });
    ok("E4  o teto e configuravel e respeitado", r2.motivo === "teto_de_passos" && r2.passos.length === 1);
  }

  // =====================================================================
  secao("F. Multi-turno e contexto");
  // =====================================================================
  {
    const espiaoFake: EspiaoDoFake = { chamadas: [] };
    const primeira = await conversarComFerramentas({
      userId: DONO, agenteId: AGENTE, instrucao: "i", mensagemDoUsuario: "Quanto entrou?",
      ferramentas: TODAS,
      adaptador: criarAdaptadorFakeComFerramentas([{ tipo: "fala", texto: "R$ 10." }], espiaoFake),
      executar: portaQueResponde([{ tipo: "sucesso" }], { chamadas: [] }),
    });
    ok("F1  a primeira volta devolve o dialogo para reuso",
      primeira.mensagens.length === 2 && primeira.mensagens[0].papel === "usuario");

    const espiao2: EspiaoDoFake = { chamadas: [] };
    const segunda = await conversarComFerramentas({
      userId: DONO, agenteId: AGENTE, instrucao: "i", mensagemDoUsuario: "E quanto saiu?",
      ferramentas: TODAS, historico: primeira.mensagens,
      adaptador: criarAdaptadorFakeComFerramentas([{ tipo: "fala", texto: "R$ 3." }], espiao2),
      executar: portaQueResponde([{ tipo: "sucesso" }], { chamadas: [] }),
    });
    ok("F2  a segunda volta enxerga o historico", espiao2.chamadas[0]?.mensagens === 3,
      String(espiao2.chamadas[0]?.mensagens));
    ok("F3  e acumula sem perder a pergunta nova",
      segunda.mensagens.length === 4 &&
        segunda.mensagens[2].papel === "usuario");
    ok("F4  a instrucao do AGENTE chega ao modelo em toda volta",
      espiaoFake.chamadas[0]?.instrucao === "i" && espiao2.chamadas[0]?.instrucao === "i");
  }

  // =====================================================================
  secao("G. Varios pedidos no mesmo turno");
  // =====================================================================
  {
    const espiaoPorta = { chamadas: [] as { funcaoId: string; userId: string; agenteId: string }[] };
    const r = await conversarComFerramentas({
      userId: DONO, agenteId: AGENTE, instrucao: "i", mensagemDoUsuario: "m",
      ferramentas: declararFerramentas({ catalogo: FUNCOES, permissoes: [
        { funcaoId: ID_VENDAS, nivel: "automatico" }, { funcaoId: ID_ML, nivel: "automatico" }] }),
      adaptador: criarAdaptadorFakeComFerramentas([
        { tipo: "pede", pedidos: [{ nome: ID_VENDAS, argumentos: {} }, { nome: ID_ML, argumentos: {} }] },
        { tipo: "fala", texto: "pronto" },
      ]),
      executar: portaQueResponde([{ tipo: "sucesso", envelope: { data: 1 } }], espiaoPorta),
    });
    ok("G1  os dois pedidos passaram pela porta", espiaoPorta.chamadas.length === 2);
    ok("G2  e cada um virou um passo", r.passos.length === 2 && r.passos.every((p) => p.executou));
    ok("G3  um turno com N pedidos gasta UM passo do teto", r.uso.turnos === 2);
  }


  // =====================================================================
  secao("H. Anthropic: as tres conversoes puras");
  // =====================================================================
  {
    const t = montarFerramentas(TODAS);
    ok("H1  ferramenta vira {name, description, input_schema}",
      t.length === 1 && t[0].name === sanitizarNome(ID_VENDAS) &&
        typeof t[0].description === "string" && typeof t[0].input_schema === "object");
    // AGENT-FACTORY-F4: a primeira chamada REAL derrubou o "sem alias".
    // A Anthropic recusa ponto em nome de ferramenta (400 explicito), e
    // todo `funcaoId` da CDS tem um — o CHECK do banco EXIGE. O que o
    // assert protegia continua cobrado, so que na propriedade certa: a
    // traducao tem de ser REVERSIVEL, e o que sai do adaptador de volta
    // e o funcaoId. Ver secao J.
    ok("H2  o `name` e o funcaoId TRADUZIDO, e a traducao volta",
      t[0].name === sanitizarNome(ID_VENDAS) &&
        mapearNomes(TODAS).paraFuncao.get(t[0].name) === ID_VENDAS);

    const msgs = montarMensagens([
      { papel: "usuario", texto: "oi" },
      { papel: "assistente", texto: null,
        pedidos: [{ id: "tu_1", nome: ID_VENDAS, argumentos: { a: 1 } }] },
      { papel: "ferramenta",
        respostas: [{ id: "tu_1", conteudo: '{"x":1}', erro: false }] },
    ]);
    ok("H3  usuario vira role user", msgs[0].role === "user" && msgs[0].content === "oi");
    ok("H4  pedido vira bloco tool_use com id, name e input",
      (() => { const b = (msgs[1].content as unknown as { type: string; id: string; name: string; input: unknown }[])[0];
        return msgs[1].role === "assistant" && b.type === "tool_use" &&
          b.id === "tu_1" && b.name === sanitizarNome(ID_VENDAS) &&
          JSON.stringify(b.input) === '{"a":1}'; })());
    ok("H5  resposta de ferramenta vira role user com tool_result amarrado pelo id",
      (() => { const b = (msgs[2].content as unknown as { type: string; tool_use_id: string; is_error: boolean }[])[0];
        return msgs[2].role === "user" && b.type === "tool_result" &&
          b.tool_use_id === "tu_1" && b.is_error === false; })());
    ok("H6  recusa viaja como is_error, nao some",
      (() => { const m = montarMensagens([{ papel: "ferramenta",
          respostas: [{ id: "tu_9", conteudo: "negado", erro: true }] }]);
        return ((m[0].content as unknown as { is_error: boolean }[])[0]).is_error === true; })());
    ok("H7  turno de assistente VAZIO nao vira mensagem invalida",
      montarMensagens([{ papel: "assistente", texto: null, pedidos: [] }]).length === 0);

    const lida = lerResposta({
      content: [{ type: "text", text: "pensando" },
                { type: "tool_use", id: "tu_2", name: ID_VENDAS, input: { b: 2 } }],
      stop_reason: "tool_use",
    });
    ok("H8  `stop_reason: tool_use` NAO e erro — e o caminho normal",
      lida.pedidos.length === 1 && lida.pedidos[0].id === "tu_2");
    ok("H9  texto e pedido convivem no mesmo turno", lida.texto === "pensando");
    ok("H10 bloco desconhecido e ignorado, nao vira pedido",
      lerResposta({ content: [{ type: "thinking", text: "x" }], stop_reason: "end_turn" })
        .pedidos.length === 0);
    ok("H11 sem pedido, so texto", (() => { const r = lerResposta({
        content: [{ type: "text", text: "pronto" }], stop_reason: "end_turn" });
      return r.texto === "pronto" && r.pedidos.length === 0; })());

    for (const [rotulo, motivo] of [
      ["H12 `refusal` lanca — o content pode vir vazio", "refusal"],
      ["H13 `max_tokens` lanca — um input truncado viraria chamada pela metade", "max_tokens"],
    ] as const) {
      let lancou = false;
      try { lerResposta({ content: [], stop_reason: motivo }); } catch { lancou = true; }
      ok(rotulo, lancou);
    }

    const PROV = ler("lib/ai-gateway/provedores/anthropic-ferramentas.ts");
    ok("H14 o provedor NAO executa ferramenta nem conhece guard",
      !/executarFuncao|autorizarFuncao|resolverFuncao/.test(PROV));
    ok("H15 e reusa o mapeamento de erro existente, sem inventar categoria",
      /mapearErroAnthropic/.test(PROV));
  }

  // =====================================================================
  secao("I. Google: a forma e OUTRA, e por isso o mapeador e outro");
  // =====================================================================
  {
    const g = montarFerramentasGoogle(TODAS);
    ok("I1  ferramenta vira {type:function, name, description, parameters}",
      g.length === 1 && g[0].type === "function" && g[0].name === ID_VENDAS &&
        typeof g[0].parameters === "object");
    ok("I2  NAO ha embrulho `functionDeclarations` — isso e da API antiga",
      !JSON.stringify(g).includes("functionDeclarations"));

    const ps = montarPassos([
      { papel: "usuario", texto: "oi" },
      { papel: "assistente", texto: "vou olhar",
        pedidos: [{ id: "fc_1", nome: ID_VENDAS, argumentos: { a: 1 } }] },
      { papel: "ferramenta",
        respostas: [{ id: "fc_1", conteudo: '{"x":1}', erro: false }] },
    ]);
    ok("I3  usuario vira passo user_input",
      ps[0].type === "user_input");
    ok("I4  texto E pedido no mesmo turno viram DOIS passos, nao um",
      ps.length === 4 && ps[1].type === "model_output" && ps[2].type === "function_call");
    ok("I5  o pedido guarda id, name e arguments",
      (() => { const p = ps[2]; return p.type === "function_call" &&
        p.id === "fc_1" && p.name === ID_VENDAS &&
        JSON.stringify(p.arguments) === '{"a":1}'; })());
    ok("I6  a resposta amarra pelo call_id",
      (() => { const p = ps[3]; return p.type === "function_result" &&
        p.call_id === "fc_1" && p.is_error === false; })());
    ok("I7  recusa viaja como is_error, nao some",
      (() => { const p = montarPassos([{ papel: "ferramenta",
          respostas: [{ id: "fc_9", conteudo: "negado", erro: true }] }])[0];
        return p.type === "function_result" && p.is_error === true; })());
    ok("I8  argumento nao-objeto vira objeto vazio, nunca null",
      (() => { const p = montarPassos([{ papel: "assistente", texto: null,
          pedidos: [{ id: "fc_2", nome: ID_VENDAS, argumentos: null }] }])[0];
        return p.type === "function_call" && JSON.stringify(p.arguments) === "{}"; })());
    ok("I9  turno de assistente VAZIO nao gera passo",
      montarPassos([{ papel: "assistente", texto: null, pedidos: [] }]).length === 0);

    const lido = lerPassos([
      { type: "model_output", content: [{ type: "text", text: "pensando" }] },
      { type: "function_call", id: "fc_3", name: ID_VENDAS, arguments: { b: 2 } },
    ]);
    ok("I10 le texto e pedido do mesmo lote de passos",
      lido.texto === "pensando" && lido.pedidos.length === 1 && lido.pedidos[0].id === "fc_3");
    ok("I11 ECO nao vira pedido — user_input e function_result sao ignorados",
      lerPassos([
        { type: "user_input", content: [{ type: "text", text: "oi" }] },
        { type: "function_result", call_id: "fc_3", result: "{}", is_error: false },
      ]).pedidos.length === 0);
    ok("I12 `thought` nao vira texto do usuario",
      lerPassos([{ type: "thought", content: [{ type: "text", text: "hmm" }] }])
        .texto === null);
    ok("I13 sem passos, nada — e nao lanca",
      (() => { const r = lerPassos(undefined);
        return r.texto === null && r.pedidos.length === 0; })());

    const PROVG = ler("lib/ai-gateway/provedores/google-ferramentas.ts");
    ok("I14 `store: false` esta presente — regra de privacidade, nao otimizacao",
      /store:\s*false/.test(PROVG));
    ok("I15 o provedor NAO executa ferramenta nem conhece guard",
      !/executarFuncao|autorizarFuncao|resolverFuncao/.test(PROVG));
    ok("I16 e reusa cliente e mapeamento de erro existentes",
      /obterClienteGoogle/.test(PROVG) && /mapearErroGoogle/.test(PROVG));

    // Os dois provedores cumprem o MESMO contrato: o laco nao sabe qual
    // esta atras dele. Se um dia divergirem, e aqui que aparece.
    ok("I17 Anthropic e Google produzem o mesmo numero de ferramentas",
      montarFerramentas(TODAS).length === montarFerramentasGoogle(TODAS).length);
    // F4 mediu que os dois divergem, e por que: o Gemini ACEITA ponto
    // (provado na rede), a Anthropic nao. Forcar o mesmo nome nos dois
    // seria degradar o Google por causa de um limite que so a Anthropic
    // tem. O que precisa valer nos dois e a REVERSIBILIDADE.
    ok("I18 cada provedor usa o nome que a SUA API aceita",
      montarFerramentasGoogle(TODAS)[0].name === ID_VENDAS &&
        montarFerramentas(TODAS)[0].name === sanitizarNome(ID_VENDAS));
    ok("I19 e os dois voltam ao MESMO funcaoId",
      mapearNomes(TODAS).paraFuncao.get(montarFerramentas(TODAS)[0].name) ===
        montarFerramentasGoogle(TODAS)[0].name);
  }

  // =====================================================================
  secao("J. AGENT-FACTORY-F4: o nome da ferramenta na rede real");
  // =====================================================================
  //
  // A primeira chamada REAL devolveu 400 da Anthropic: nome de
  // ferramenta nao aceita ponto, e todo `funcaoId` da CDS tem um. Estes
  // asserts congelam a traducao e, sobretudo, a REVERSAO — porque o
  // perigo nunca foi o nome feio, foi um pedido virar outra Funcao.
  {
    ok("J1  ponto vira sublinhado",
      sanitizarNome("calculadora.calcular") === "calculadora_calcular");
    ok("J2  o resultado casa a gramatica que a API exigiu",
      /^[a-zA-Z0-9_-]{1,128}$/.test(sanitizarNome("mercadolivre.perguntas.listar")));
    ok("J3  CONTROLE: o id ORIGINAL nao casaria",
      !/^[a-zA-Z0-9_-]{1,128}$/.test("calculadora.calcular"));

    const mapa = mapearNomes(TODAS);
    ok("J4  o mapa vai e volta sem perder o id",
      TODAS.every((f) => mapa.paraFuncao.get(mapa.paraApi.get(f.nome) as string) === f.nome));

    let lancou = false;
    try {
      mapearNomes([
        { nome: "a.b", descricao: "x", schemaEntrada: {} },
        { nome: "a_b", descricao: "y", schemaEntrada: {} },
      ]);
    } catch { lancou = true; }
    ok("J5  COLISAO lanca em vez de escolher um dos dois", lancou);

    const so = [{ nome: ID_VENDAS, descricao: "d", schemaEntrada: {} }];
    const mapaSo = mapearNomes(so);
    ok("J6  a declaracao sai com o nome da API",
      montarFerramentas(so, mapaSo)[0].name === sanitizarNome(ID_VENDAS));
    ok("J7  e a LEITURA devolve o funcaoId, nunca o nome traduzido",
      lerResposta({ content: [{ type: "tool_use", id: "t1",
        name: sanitizarNome(ID_VENDAS), input: {} }], stop_reason: "tool_use" }, mapaSo)
        .pedidos[0].nome === ID_VENDAS);
    ok("J8  sem mapa, o nome passa CRU — quem recusa e o laco, nao esta camada",
      lerResposta({ content: [{ type: "tool_use", id: "t1", name: "zzz", input: {} }],
        stop_reason: "tool_use" }).pedidos[0].nome === "zzz");
    ok("J9  o ECO do turno anterior tambem viaja traduzido",
      (() => { const m = montarMensagens([{ papel: "assistente", texto: null,
          pedidos: [{ id: "t1", nome: ID_VENDAS, argumentos: {} }] }], mapaSo);
        return ((m[0].content as unknown as { name: string }[])[0]).name ===
          sanitizarNome(ID_VENDAS); })());

    ok("J10 `auto` NAO manda tool_choice — o default da API ja e esse",
      JSON.stringify(montarEscolha("auto")) === "{}" &&
        JSON.stringify(montarEscolha(undefined)) === "{}");
    ok("J11 forcar manda tool_choice com o nome da API",
      JSON.stringify(montarEscolha({ nome: ID_VENDAS }, mapaSo)) ===
        JSON.stringify({ tool_choice: { type: "tool", name: sanitizarNome(ID_VENDAS) } }));
    ok("J12 no Google a escolha mora em generation_config, e nao ao lado de tools",
      JSON.stringify(montarEscolhaGoogle({ nome: ID_VENDAS })) ===
        JSON.stringify({ generation_config: { tool_choice:
          { allowed_tools: { mode: "any", tools: [ID_VENDAS] } } } }));
    ok("J13 e o Google nao traduz o nome — a API real aceita o ponto",
      JSON.stringify(montarEscolhaGoogle({ nome: ID_VENDAS })).includes(ID_VENDAS));

    const GOOG = ler("lib/ai-gateway/provedores/google-ferramentas.ts");
    ok("J14 o Gemini continua com store:false — a regra nao foi trocada por um verde",
      /store:\s*false/.test(GOOG) && !/store:\s*true,/.test(GOOG));
    // ── J15 reconciliado na AGENT-FACTORY-F7b.4 ────────────────────
    //
    // ANTES: "devolver resultado ao Gemini falha com codigo proprio". Era
    // verdade, e a causa estava mal diagnosticada. O F4 concluiu que a
    // API exigia `store: true`; o F7b.4 mediu de novo e achou o campo que
    // faltava — `function_call.signature`, opaco, que precisa voltar
    // verbatim.
    //
    // O portao caiu porque o ciclo passou a fechar, nao porque a regra
    // afrouxou: J14 acima continua exigindo `store: false`. O que se
    // cobra aqui agora e a CONDICAO que fez o ciclo funcionar.
    const GOOG_SC = semComentarios(GOOG);
    ok("J15 o segundo turno NAO e mais barrado por codigo proprio",
      !/throw new ErroProvedorIA\([\s\S]{0,120}CODIGO_RETORNO_BLOQUEADO/.test(GOOG_SC));
    ok("J15a a assinatura opaca do `function_call` e PRESERVADA",
      /signature: p\.assinatura/.test(GOOG_SC) &&
        /assinatura: s\.signature/.test(GOOG_SC));
    ok("J15b e o `function_result` leva `name` — sem ele a API recusa",
      /name: nomePorId\.get\(r\.id\)/.test(GOOG_SC));
    ok("J15c CONTROLE: a assinatura nao e inventada quando nao existe",
      /p\.assinatura !== undefined/.test(GOOG_SC));

    const LACO_F4 = semComentarios(ler("lib/agentes/ia/laco-ferramentas.ts"));
    ok("J16 forcar ferramenta vale SO no primeiro turno",
      /passo === 0/.test(LACO_F4) && /escolhaDeFerramenta/.test(LACO_F4));
    ok("J17 e forcar NAO e autorizacao: o laco segue sem guard proprio",
      !/autorizarFuncao|resolverFuncao/.test(LACO_F4));
  }
}

void main().then(
  () => {
    console.log(`
── placar ${"─".repeat(54)}`);
    console.log(`  PASS ${passou}   FAIL ${falhou}
`);
    if (falhou > 0) process.exitCode = 1;
  },
  (e: unknown) => {
    console.error("ERRO:", (e as { message?: string }).message ?? String(e));
    process.exit(2);
  }
);
