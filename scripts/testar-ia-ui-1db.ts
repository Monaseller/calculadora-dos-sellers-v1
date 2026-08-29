/**
 * CDS IA — UI-1D.b. Suite do feed de atividade.
 *
 * Cobre o vocabulario proprio de eventos, os tres eixos separados
 * (tipo/severidade/ator), a derivacao hibrida, a ordenacao, os quatro
 * filtros e — o mais importante — a AUSENCIA dos eventos que a fonte
 * nao sustenta.
 *
 * Nao renderiza React: prova por LEITURA DE FONTE e por execucao das
 * funcoes puras. Toda varredura importante tem CONTROLE NEGATIVO — sonda
 * que nao acusa nada pode estar quebrada em vez de limpa, e nesta base
 * isso ja aconteceu cinco vezes.
 *
 * Rodar:  npx tsx scripts/testar-ia-ui-1db.ts
 * Sem rede, sem banco, sem IA.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  FILTROS,
  LIMITE_FEED,
  ROTULO_ATOR,
  ROTULO_FILTRO,
  SEVERIDADES,
  TIPOS_ATOR,
  TIPOS_EVENTO,
  VOCABULARIO_EVENTO,
  aplicarFiltro,
  eventosDeAprovacao,
  eventosDeTarefa,
  maisRecentesPrimeiro,
  montarFeed,
  type EventoAtividade,
} from "../lib/ia/atividade";
import { LIMITE_MENSAGEM_ERRO } from "../lib/ia/tarefas";
import { MOCK_AGENTES, MOCK_APROVACOES, MOCK_ATIVIDADES, MOCK_TAREFAS } from "../lib/ia/mocks";
import type { TarefaUI } from "../lib/ia/contratos";

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
const existe = (rel: string) => existsSync(join(RAIZ, rel));

function codigo(fonte: string): string {
  return fonte.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

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

/** A pasta de mocks, nome a nome — sem wildcard. Sete na UI-1D.b. */
const MOCKS_PASTA: readonly string[] = [
  "lib/ia/mocks/agentes.ts",
  "lib/ia/mocks/aprovacoes.ts",
  "lib/ia/mocks/atividade.ts",
  "lib/ia/mocks/capabilities.ts",
  "lib/ia/mocks/conexoes.ts",
  "lib/ia/mocks/index.ts",
  "lib/ia/mocks/tarefas.ts",
];

const NOVOS_1DB = [
  "lib/ia/atividade.ts",
  "components/ia/atividade/Timeline.tsx",
  "components/ia/atividade/ItemAtividade.tsx",
  "lib/ia/mocks/atividade.ts",
];

const ARQUIVOS_AREA: readonly string[] = [
  ...arquivosDe("lib/ia"),
  ...arquivosDe("components/ia"),
  ...arquivosDe("app/(app)/ia"),
];

const CONTRATO = ler("lib/ia/atividade.ts");
const TIMELINE = ler("components/ia/atividade/Timeline.tsx");
const ITEM = ler("components/ia/atividade/ItemAtividade.tsx");
const PAGINA = ler("app/(app)/ia/atividade/page.tsx");
const MOCK_AT = ler("lib/ia/mocks/atividade.ts");

const AGORA = Date.parse("2026-08-27T12:00:00.000Z");
const ha = (ms: number) => new Date(AGORA - ms).toISOString();

const t = (parcial: Partial<TarefaUI>): TarefaUI => ({
  id: "t1", agente_id: "ag-x", tipo: "generico", entrada: {},
  status: "pendente", progresso: 0, tentativas: 0, max_tentativas: 3,
  erro_tipo: null, erro_mensagem: null,
  criado_em: ha(60_000), iniciado_em: null, concluido_em: null, heartbeat_em: null,
  ...parcial,
});
const AG = { id: "ag-x", nome: "Agente X" };

// ═══════════════════════════════════════════════════════════════════════
console.log("\n══ CDS IA — UI-1D.b: feed de atividade ══");

secao("A. Rota e inventario");

{
  ok("A1  os 4 arquivos novos existem",
    NOVOS_1DB.every((a) => ARQUIVOS_AREA.includes(a)),
    NOVOS_1DB.filter((a) => !ARQUIVOS_AREA.includes(a)).join(", "));
  ok("A2  /ia/atividade NAO e mais placeholder", !/EmBreve/.test(PAGINA));
  ok("A3  controle negativo: a sonda acharia EmBreve",
    /EmBreve/.test('import EmBreve from "@/components/ia/EmBreve";'));
  ok("A4  a pagina monta a Timeline", /Timeline/.test(PAGINA));
  ok("A5  arquitetura page -> Timeline -> ItemAtividade",
    /Timeline/.test(PAGINA) && /ItemAtividade/.test(TIMELINE));
  ok("A6  as areas ainda inexistentes continuam EmBreve",
    ["custos", "conexoes"].every((a) => /EmBreve/.test(ler(`app/(app)/ia/${a}/page.tsx`))));
}

secao("B. Vocabulario: exatamente 6 tipos");

{
  ok("B1  6 tipos de evento", TIPOS_EVENTO.length === 6, String(TIPOS_EVENTO.length));
  ok("B2  os 6 sao os previstos",
    JSON.stringify([...TIPOS_EVENTO]) === JSON.stringify([
      "tarefa.criada", "tarefa.concluida", "tarefa.falhou",
      "ia.chamada", "aprovacao.solicitada", "agente.alterado",
    ]));
  ok("B3  todo tipo tem rotulo e icone",
    TIPOS_EVENTO.every((x) => VOCABULARIO_EVENTO[x].rotulo.length > 0 && VOCABULARIO_EVENTO[x].icone.length > 0));

  // As ausencias sao a parte que importa.
  const PROIBIDOS = [
    "tarefa.iniciada", "tarefa.reivindicada", "tarefa.retry", "tarefa.cancelada",
    "aprovacao.aprovada", "aprovacao.recusada",
    "agente.ativado", "agente.desativado", "conexao.atribuida", "permissao.alterada",
  ];
  ok("B4  nenhum tipo sem fonte historica foi criado",
    PROIBIDOS.every((p) => !(TIPOS_EVENTO as readonly string[]).includes(p)),
    PROIBIDOS.filter((p) => (TIPOS_EVENTO as readonly string[]).includes(p)).join(", "));
  ok("B5  `tarefa.iniciada` NAO existe nem no codigo do contrato",
    !/tarefa\.iniciada/.test(codigo(CONTRATO)));
  ok("B6  controle negativo: a sonda acharia o tipo proibido",
    /tarefa\.iniciada/.test('tipo: "tarefa.iniciada",'));
  ok("B7  `aprovacao.aprovada`/`recusada` nao existem em lugar nenhum da area",
    ARQUIVOS_AREA.every((a) => !/aprovacao\.(aprovada|recusada)/.test(codigo(ler(a)))));

  // Vocabulario proprio, nao reaproveitado de status.
  ok("B8  o contrato NAO importa StatusTarefa/EstadoVisual/EstadoConexao",
    !/StatusTarefa|EstadoVisual|EstadoConexao/.test(codigo(CONTRATO)));
  ok("B9  controle negativo: a sonda acharia o import",
    /StatusTarefa/.test('import type { StatusTarefa } from "x";'));
}

secao("C. Tres eixos separados: tipo, severidade, ator");

{
  ok("C1  3 severidades", SEVERIDADES.length === 3 &&
    JSON.stringify([...SEVERIDADES]) === JSON.stringify(["info", "atencao", "erro"]));
  ok("C2  3 tipos de ator", TIPOS_ATOR.length === 3 &&
    JSON.stringify([...TIPOS_ATOR]) === JSON.stringify(["agente", "usuario", "sistema"]));
  ok("C3  todo ator tem rotulo", TIPOS_ATOR.every((x) => ROTULO_ATOR[x].length > 0));
  ok("C4  sao campos distintos no contrato",
    /tipo:\s*TipoEvento/.test(CONTRATO) && /severidade:\s*Severidade/.test(CONTRATO) &&
    /ator:\s*AtorEvento/.test(CONTRATO));
  ok("C5  nao ha enum unico combinando os eixos",
    !/TipoEventoSeveridade|EventoComAtor|TIPO_SEVERIDADE/.test(CONTRATO));
  ok("C6  `usuario` existe no contrato e NAO tem ocorrencia real",
    (TIPOS_ATOR as readonly string[]).includes("usuario") &&
    !MOCK_ATIVIDADES(AGORA).some((e) => e.ator.tipo === "usuario"));
  ok("C7  nenhum evento afirma decisao humana",
    ARQUIVOS_AREA.every((a) => !/(aprovou|recusou|Rodrigo)/i.test(codigo(ler(a)))));
  ok("C8  controle negativo: a sonda acharia a frase proibida",
    /(aprovou|recusou)/i.test('frase: "Rodrigo aprovou a acao"'));
}

secao("D. Derivacao de tarefas — so o que a fonte sustenta");

{
  const criada = eventosDeTarefa(t({}), AG);
  ok("D1  tarefa pendente gera SO `tarefa.criada`",
    criada.length === 1 && criada[0].tipo === "tarefa.criada");

  const concluida = eventosDeTarefa(
    t({ status: "concluido", concluido_em: ha(10_000) }), AG);
  ok("D2  concluida gera criada + concluida",
    concluida.length === 2 && concluida.map((e) => e.tipo).join(",") === "tarefa.criada,tarefa.concluida");

  const falhou = eventosDeTarefa(
    t({ status: "erro", concluido_em: ha(5_000), erro_tipo: "rede", erro_mensagem: "Tempo esgotado." }), AG);
  ok("D3  falha terminal gera criada + falhou",
    falhou.length === 2 && falhou[1].tipo === "tarefa.falhou");
  ok("D4  falha tem severidade `erro`", falhou[1].severidade === "erro");
  ok("D5  a mensagem de erro vai no detalhe, sanitizada",
    falhou[1].detalhe === "Tempo esgotado.");

  // O coracao da fase: nao inventar historico que a fonte apagou.
  const comRetry = eventosDeTarefa(
    t({ status: "rodando", tentativas: 3, iniciado_em: ha(30_000) }), AG);
  ok("D6  tarefa com 3 tentativas NAO vira 3 eventos",
    comRetry.length === 1, `gerou ${comRetry.length}`);
  ok("D7  `iniciado_em` NAO vira evento",
    comRetry.every((e) => e.tipo !== "tarefa.iniciada" as never));
  ok("D8  tarefa cancelada nao inventa evento de cancelamento",
    eventosDeTarefa(t({ status: "cancelado", concluido_em: ha(1000) }), AG).length === 1);
  ok("D9  concluida SEM `concluido_em` nao gera evento de conclusao",
    eventosDeTarefa(t({ status: "concluido", concluido_em: null }), AG).length === 1);
  ok("D10 eventos derivados usam instante da COLUNA, nao do relogio",
    concluida[1].instante === ha(10_000));
  ok("D11 derivados sao `disponivel` (colunas reais)",
    criada.every((e) => e.procedencia === "disponivel"));
  ok("D12 evento de tarefa aponta para a aba Tarefas do agente",
    criada[0].link?.href === "/ia/agentes/ag-x?aba=tarefas");
  ok("D13 ids de evento sao deterministicos",
    JSON.stringify(eventosDeTarefa(t({}), AG).map((e) => e.id)) ===
    JSON.stringify(criada.map((e) => e.id)));
}

secao("E. Aprovacoes no feed");

{
  const ev = eventosDeAprovacao(MOCK_APROVACOES[0]);
  ok("E1  gera exatamente 1 evento", ev.length === 1);
  ok("E2  tipo `aprovacao.solicitada`", ev[0].tipo === "aprovacao.solicitada");
  ok("E3  severidade `atencao`", ev[0].severidade === "atencao");
  ok("E4  procedencia `em_breve` (nada produz o status hoje)",
    ev[0].procedencia === "em_breve");
  ok("E5  aponta para a fila, nao duplica o card",
    ev[0].link?.href === "/ia/aprovacoes");
  ok("E6  o feed NAO importa CardAprovacao",
    !/CardAprovacao/.test(TIMELINE) && !/CardAprovacao/.test(ITEM));
  ok("E7  nao existe evento de decisao aprovada/recusada",
    !/aprovacao\.(aprovada|recusada)/.test(codigo(CONTRATO)));
}

secao("F. Ordenacao e limite");

{
  const e = (id: string, instante: string): EventoAtividade => ({
    id, tipo: "tarefa.criada", severidade: "info",
    ator: { tipo: "agente", nome: "X" }, agenteId: "a", agenteNome: "X",
    instante, frase: "x", detalhe: null, link: null, procedencia: "disponivel",
  });
  ok("F1  mais recentes primeiro",
    maisRecentesPrimeiro([e("velho", ha(90_000)), e("novo", ha(1_000))])
      .map((x) => x.id).join(",") === "novo,velho");
  ok("F2  desempate deterministico por id",
    maisRecentesPrimeiro([e("aaa", ha(1_000)), e("zzz", ha(1_000))])
      .map((x) => x.id).join(",") === "zzz,aaa");
  ok("F3  ordem e ESTAVEL entre chamadas",
    JSON.stringify(maisRecentesPrimeiro([e("a", ha(1)), e("b", ha(1)), e("c", ha(1))]).map((x) => x.id)) ===
    JSON.stringify(maisRecentesPrimeiro([e("c", ha(1)), e("a", ha(1)), e("b", ha(1))]).map((x) => x.id)));
  ok("F4  instante invalido nao quebra a ordenacao",
    maisRecentesPrimeiro([e("ok", ha(1_000)), e("torto", "nao-e-data")]).length === 2);
  ok("F5  limite do feed e 30", LIMITE_FEED === 30);
  ok("F6  o limite e aplicado de verdade",
    /slice\(0, LIMITE_FEED\)/.test(CONTRATO));
  ok("F7  NAO ha paginacao simulada",
    !/Carregar mais|carregarMais|proximaPagina|setPagina/.test(codigo(TIMELINE)));
  ok("F8  controle negativo: a sonda acharia o botao",
    /Carregar mais/.test("<button>Carregar mais</button>"));
}

secao("G. Filtros: exatamente 4, e funcionais");

{
  ok("G1  4 filtros", FILTROS.length === 4);
  ok("G2  os 4 sao os previstos",
    JSON.stringify([...FILTROS]) === JSON.stringify(["tudo", "tarefas", "aprovacoes", "erros"]));
  ok("G3  todo filtro tem rotulo", FILTROS.every((f) => ROTULO_FILTRO[f].length > 0));
  ok("G4  NAO existe filtro Sistema/Agente/Conexoes/Permissoes",
    !["sistema", "agente", "conexoes", "permissoes"].some((f) => (FILTROS as readonly string[]).includes(f)));
  ok("G5  controle negativo: a sonda acharia um filtro extra",
    ["sistema"].some((f) => ["tudo", "sistema"].includes(f)));

  const feed = montarFeed({
    tarefas: MOCK_TAREFAS(AGORA), agentes: MOCK_AGENTES,
    aprovacoes: MOCK_APROVACOES, extras: MOCK_ATIVIDADES(AGORA),
  });
  ok("G6  o feed nao esta vazio", feed.length > 0);
  ok("G7  `tudo` devolve tudo", aplicarFiltro(feed, "tudo").length === feed.length);
  ok("G8  `tarefas` filtra de verdade e so tipos de tarefa",
    aplicarFiltro(feed, "tarefas").length > 0 &&
    aplicarFiltro(feed, "tarefas").length < feed.length &&
    aplicarFiltro(feed, "tarefas").every((x) => x.tipo.startsWith("tarefa.")));
  ok("G9  `aprovacoes` so tipos de aprovacao",
    aplicarFiltro(feed, "aprovacoes").every((x) => x.tipo.startsWith("aprovacao.")));
  // ── Assert que era VAZIO, e a lacuna que ele escondia ────────────
  //
  // `aplicarFiltro(feed,"erros").every(...)` passava sobre um array
  // VAZIO — `every` de lista vazia e sempre verdadeiro. O filtro nunca
  // foi exercitado.
  //
  // A causa esta em `lib/ia/mocks/tarefas.ts`, FORA do escopo desta
  // fase: as duas tarefas com `status:"erro"` tem `concluido_em: null`,
  // e isso e um estado que o schema real NAO produz — `falhar_tarefa`
  // grava `concluido_em = now()` sempre que o status vira `erro`. Como a
  // derivacao (corretamente) exige o timestamp, nenhum evento de falha
  // nasce. Registrado como ressalva; a correcao e do mock, nao daqui.
  //
  // O filtro passa a ser testado com dados construidos, nao com o que o
  // mock por acaso tiver.
  const comErro: EventoAtividade[] = [
    { id: "x1", tipo: "tarefa.falhou", severidade: "erro", ator: { tipo: "agente", nome: "X" },
      agenteId: "a", agenteNome: "X", instante: ha(1_000), frase: "f", detalhe: null,
      link: null, procedencia: "disponivel" },
    { id: "x2", tipo: "tarefa.criada", severidade: "info", ator: { tipo: "agente", nome: "X" },
      agenteId: "a", agenteNome: "X", instante: ha(2_000), frase: "f", detalhe: null,
      link: null, procedencia: "disponivel" },
    // Severidade `erro` num tipo que NAO e de falha: prova que o filtro
    // olha a severidade, e nao o nome do tipo.
    { id: "x3", tipo: "ia.chamada", severidade: "erro", ator: { tipo: "agente", nome: "X" },
      agenteId: "a", agenteNome: "X", instante: ha(3_000), frase: "f", detalhe: null,
      link: null, procedencia: "simulado" },
  ];
  ok("G10 `erros` filtra por SEVERIDADE, nao por tipo",
    aplicarFiltro(comErro, "erros").map((x) => x.id).join(",") === "x1,x3");
  ok("G10b o filtro de erros NAO passa em vazio (assert nao-vacuo)",
    aplicarFiltro(comErro, "erros").length === 2);
  // ── O tripwire virou garantia ────────────────────────────────────
  //
  // Este assert registrava a lacuna ("o mock nao produz evento de
  // falha"). A lacuna foi corrigida em `mocks/tarefas.ts`, entao ele
  // passou a exigir o contrario: o feed MOCK REAL — nao um array
  // construido aqui — precisa conter falha, e o filtro precisa
  // devolve-la. Apagar o assert teria perdido a garantia.
  const errosNoFeed = aplicarFiltro(feed, "erros");
  ok("G10c o feed mock real contem pelo menos um evento de erro",
    errosNoFeed.length > 0, `${errosNoFeed.length} eventos de erro`);
  ok("G10d o erro do feed real e uma falha de tarefa derivada",
    errosNoFeed.some((x) => x.tipo === "tarefa.falhou" && x.procedencia === "disponivel"));
  ok("G10e o evento de falha carrega a mensagem sanitizada",
    errosNoFeed.every((x) => x.detalhe === null || x.detalhe.length <= LIMITE_MENSAGEM_ERRO + 1));

  // ── E o estado impossivel nao pode voltar ────────────────────────
  //
  // `falhar_tarefa` decide: `tentativas < max_tentativas -> 'pendente'`,
  // senao `'erro'` com `concluido_em = now()`. Logo `status='erro'`
  // implica tentativas esgotadas E timestamp preenchido. O mock tinha
  // duas linhas violando isso, e o sintoma so apareceu quando a
  // Atividade existiu. Agora e o teste que cobra.
  const tarefasMock = MOCK_TAREFAS(AGORA);
  const errosMock = tarefasMock.filter((x) => x.status === "erro");
  ok("G10f ha tarefa terminal em erro no mock", errosMock.length > 0);
  ok("G10g toda tarefa em erro tem `concluido_em` (RPC sempre grava)",
    errosMock.every((x) => x.concluido_em !== null),
    errosMock.filter((x) => x.concluido_em === null).map((x) => x.id).join(", "));
  ok("G10h toda tarefa em erro tem tentativas esgotadas",
    errosMock.every((x) => x.tentativas >= x.max_tentativas),
    errosMock.filter((x) => x.tentativas < x.max_tentativas).map((x) => x.id).join(", "));

  // ── O outro lado da maquina: falha TRANSITORIA ───────────────────
  //
  // `falhar_tarefa` grava `erro_tipo`/`erro_mensagem` nos DOIS caminhos.
  // Logo existe um estado legitimo — e facil de esquecer — em que a
  // tarefa esta de volta na fila CARREGANDO o erro da tentativa
  // anterior. Sem um mock assim, ninguem descobre que derivar "falhou"
  // da mera presenca de `erro_tipo` esta errado.
  //
  // O assert cobra a PROPRIEDADE, nunca o id `tf-8`: trocar de linha nao
  // deve quebrar o teste; perder o cenario deve.
  const retryPendente = tarefasMock.filter(
    (x) => x.status === "pendente" && x.tentativas < x.max_tentativas &&
           x.erro_tipo !== null && x.erro_mensagem !== null && x.concluido_em === null
  );
  ok("G10i ha tarefa pendente carregando erro da tentativa anterior",
    retryPendente.length > 0);
  ok("G10j erro preenchido NAO implica status 'erro'",
    tarefasMock.some((x) => x.erro_tipo !== null && x.status !== "erro"));
  ok("G10k falha transitoria NAO vira evento `tarefa.falhou`",
    retryPendente.every((x) =>
      eventosDeTarefa(x, { id: x.agente_id, nome: "X" })
        .every((e) => e.tipo !== "tarefa.falhou")));
  ok("G10l ...mas falha TERMINAL vira",
    errosMock.every((x) =>
      eventosDeTarefa(x, { id: x.agente_id, nome: "X" })
        .some((e) => e.tipo === "tarefa.falhou")));
  ok("G11 filtrar nao muda a ordem relativa",
    JSON.stringify(aplicarFiltro(feed, "tarefas").map((x) => x.id)) ===
    JSON.stringify(feed.filter((x) => x.tipo.startsWith("tarefa.")).map((x) => x.id)));
  ok("G12 a UI chama aplicarFiltro (nao filtra por conta propria)",
    /aplicarFiltro/.test(TIMELINE));
  ok("G13 filtros sao <button> com aria-pressed, NAO tabs",
    /<button/.test(TIMELINE) && /aria-pressed/.test(TIMELINE) &&
    !/role="tab"/.test(TIMELINE));
  ok("G14 o grupo de filtros e anunciado", /role="group"/.test(TIMELINE));
  ok("G15 selecao nao depende so de cor (classe + aria-pressed)",
    /cds-ia-at-filtro-ativo/.test(TIMELINE));
}

secao("H. Sem periodo, sem tabela, feed em lista");

{
  // A primeira versao procurava a PALAVRA "periodo" e reprovava uma
  // frase de estado vazio. Prosa nao e controle: a sonda passou a mirar
  // o que caracteriza um seletor de periodo de verdade.
  ok("H1  NAO ha seletor de periodo",
    !/<select|setPeriodo|PERIODOS|dataInicio|dataFim|>\s*(7|15|30) dias\s*</i.test(codigo(TIMELINE)));
  ok("H2  controle negativo: a sonda acha um seletor de verdade",
    /<select/.test("<select><option>7 dias</option></select>") &&
    />\s*(7|15|30) dias\s*</.test("<button>30 dias</button>"));
  ok("H3  feed usa <ul>/<li>", /<ul/.test(TIMELINE) && /<li/.test(ITEM));
  ok("H4  NAO usa tabela", !/<table|<thead|<tbody/.test(TIMELINE + ITEM));
  ok("H5  uma coluna: sem grid de colunas no feed",
    !/grid-template-columns/.test(TIMELINE));
}

secao("I. Detalhes, erros e links");

{
  ok("I1  `<details>` so quando ha detalhe",
    /evento\.detalhe !== null/.test(ITEM) && /<details/.test(ITEM));
  ok("I2  controle negativo: a sonda acha um details incondicional",
    /<details/.test("<details><summary>x</summary></details>"));
  ok("I3  NAO usa modal", !/role="dialog"|aria-modal/.test(ITEM + TIMELINE));
  ok("I4  reusa a sanitizacao existente, nao duplica",
    /mensagemDeErro/.test(CONTRATO) && !/replace\(\/\\s\+\/g/.test(CONTRATO));
  ok("I5  o limite de mensagem continua o da aba Tarefas", LIMITE_MENSAGEM_ERRO === 200);
  ok("I6  reusa desdeQuando e formatarInstante",
    /desdeQuando/.test(ITEM) && /formatarInstante/.test(ITEM));
  ok("I7  links sao <Link> reais", /<Link/.test(ITEM));
  ok("I8  nenhuma rota de tarefa inventada",
    ARQUIVOS_AREA.every((a) => !/\/ia\/tarefas\//.test(ler(a))));
  ok("I9  controle negativo: a sonda acharia a rota inventada",
    /\/ia\/tarefas\//.test('href="/ia/tarefas/tf-1"'));
  ok("I10 usa <time> com dateTime legivel", /<time dateTime=/.test(ITEM));
}

secao("J. Nao duplica a aba Tarefas");

{
  ok("J1  o item NAO mostra progresso/tentativa/duracao/espera",
    !/progresso|tentativas|duracaoMs|esperaNaFila|progressbar/.test(codigo(ITEM)));
  ok("J2  controle negativo: a sonda acharia o progresso",
    /progressbar/.test('<div role="progressbar" />'));
  ok("J3  o feed nao importa ListaTarefas nem BadgeEstado",
    !/ListaTarefas|BadgeEstado/.test(TIMELINE + ITEM));
}

secao("K. Estado vazio e aviso de simulacao");

{
  ok("K1  usa EstadoVazio", /EstadoVazio/.test(TIMELINE));
  ok("K2  distingue 'sem eventos' de 'fonte nao conectada'",
    /não está conectada|nao esta conectada/.test(TIMELINE));
  ok("K3  vazio de filtro tem mensagem propria",
    /Nada neste filtro/.test(TIMELINE));
  ok("K4  o aviso de simulacao aparece", /MOCK_AVISO/.test(TIMELINE));
  ok("K5  a tela admite que ha acontecimentos nao registrados",
    /não são registrados|nao sao registrados/.test(TIMELINE));
}

secao("L. Mocks: 7 arquivos, fronteira publica, hibrido");

{
  ok("L1  a pasta tem exatamente 7 arquivos",
    JSON.stringify(arquivosDe("lib/ia/mocks")) === JSON.stringify([...MOCKS_PASTA].sort()),
    arquivosDe("lib/ia/mocks").join(", "));
  ok("L2  `lib/ia/mocks.ts` continua inexistente", !existe("lib/ia/mocks.ts"));
  ok("L3  cada arquivo < 400 linhas",
    MOCKS_PASTA.every((m) => ler(m).split("\n").length < 400),
    MOCKS_PASTA.map((m) => `${m}:${ler(m).split("\n").length}`).join(" "));
  ok("L4  todo export da pasta usa prefixo MOCK_",
    [...MOCKS_PASTA.map(ler).join("\n").matchAll(/export (?:const|function) (\w+)/g)]
      .every((m) => m[1].startsWith("MOCK_")));
  ok("L5  o index reexporta MOCK_ATIVIDADES",
    /MOCK_ATIVIDADES/.test(ler("lib/ia/mocks/index.ts")));
  ok("L6  consumidores usam a fronteira publica",
    ARQUIVOS_AREA.filter((a) => !a.startsWith("lib/ia/mocks/"))
      .every((a) => !/@\/lib\/ia\/mocks\//.test(ler(a))));

  // Hibrido: o mock so guarda o que nao da para derivar.
  const extras = MOCK_ATIVIDADES(AGORA);
  ok("L7  o mock de atividade so tem tipos sem fonte derivavel",
    extras.every((e) => e.tipo === "ia.chamada" || e.tipo === "agente.alterado"),
    extras.map((e) => e.tipo).join(", "));
  ok("L8  nenhum evento de tarefa/aprovacao foi digitado a mao",
    !extras.some((e) => e.tipo.startsWith("tarefa.") || e.tipo.startsWith("aprovacao.")));
  ok("L9  todo extra declara procedencia nao-real",
    extras.every((e) => e.procedencia !== "disponivel"));
  ok("L10 ids de evento nao imitam UUID",
    extras.every((e) => !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(e.id)));
  ok("L11 a derivacao nao importa mock nenhum",
    !/@\/lib\/ia\/mocks/.test(CONTRATO));
  ok("L12 `montarFeed` recebe tudo por parametro (serve para DTO real)",
    /export function montarFeed\(entrada: \{/.test(CONTRATO));
}

secao("M. Zero backend e zero segredo");

{
  const sondas: Array<[string, RegExp, string[]?]> = [
    ["supabase", /supabase|createClient|service_role/i],
    // A SKILL-1D.ui-consumer-C deu a area o seu PRIMEIRO ponto de rede
    // legitimo: a tela de agentes passou a ler a API de agentes e a de
    // diagnostico. A proibicao nao afrouxa, muda de forma — deixa de ser
    // "zero na area" e passa a ser "EXATAMENTE este arquivo", por
    // igualdade nominal de caminho. Um segundo arquivo com rede reprova,
    // e o desaparecimento do autorizado tambem. `XMLHttpRequest`, `axios`
    // e `WebSocket` seguem proibidos em TODA a area, inclusive nele.
    ["fetch/rede", /\bfetch\s*\(|XMLHttpRequest|axios|WebSocket/, ["lib/ia/agentes-http.ts"]],
    ["env", /process\.env/],
    ["provider de IA", /anthropic|@google\/genai|openai|ai-gateway/i],
    ["marketplace", /lib\/marketplace|mercadolibre\.com|shopee\.com|partner_id|app_secret/i],
    ["n8n", /\bn8n\b/i],
    ["dados/capability de agente", /lib\/agentes\/(dados|capability|executar)/],
    ["SQL", /\bselect\b[^;\n]{0,80}\bfrom\b|\binsert\s+into\b|\bdelete\s+from\b/i],
    ["migration/RPC", /supabase\/migrations|create table|alter table|\.rpc\(/i],
    ["rota/Server Action", /app\/api\/|route\.ts|NextResponse|"use server"/],
    // A sonda exige VALOR, nunca a palavra. Uma Ficha de Integracao
    // precisa poder DOCUMENTAR autenticacao ("a API usa access_token",
    // "envie Authorization: Bearer <token>") sem ser tratada como
    // vazamento — isso e requisito de produto, nao tolerancia. O que
    // reprova e a credencial em si. Semantica equivalente a de
    // `lib/ia/skills/formato.ts`, que precisou da mesma distincao.
    ["segredo", /\b(?:access_token|refresh_token|partner_key|client_secret|api[_-]?key|token|secret|senha)\b\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{12,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.|\bsk-[A-Za-z0-9_-]{16,}|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9_\-.]{16,}/i],
    ["identificador externo", /\bseller_id\b|\bshop_id\b|\bpartner_id\b/],
    ["identificador de dono", /\buser_id\b|\bloja_id\b/],
    ["viewport em JS", /window\.innerWidth|addEventListener\("resize"|matchMedia/],
    ["payload/prompt/stack", /\bpayload\b|\bprompt\b|stack trace|\.stack\b|JSON\.stringify/i],
  ];

  const isca = [
    'createClient(supabase)', 'fetch("/x")', 'process.env.X', 'anthropic()',
    'lib/marketplace/credenciais', 'n8n webhook', 'lib/agentes/dados/vendas',
    'select * from pedidos', 'alter table x', 'NextResponse.json()',
    'access_token = "aB3xK9zQ7mP2wL5tR8"', 'seller_id', 'user_id', 'window.innerWidth',
    'JSON.stringify(payload)',
  ].join("\n");

  let mortas = 0;
  for (const [nome, p] of sondas) {
    if (!p.test(isca)) { mortas++; console.log(`        SONDA MORTA: ${nome}`); }
  }
  ok("M0  controle negativo: as 15 sondas acusam a isca", mortas === 0, `${mortas} mortas`);
  // A sonda de segredo mudou de semantica nesta fase: passou a exigir
  // VALOR. Os controles abaixo provam os dois lados — que ela continua
  // viva para credencial real, e que nao reprova documentacao.
  {
    const sondaSegredo = sondas.find(([n]) => n === "segredo")![1];
    const DOC =
      "A API usa access_token e refresh_token. Envie Authorization: Bearer <token>. " +
      "A API key vem de Conexoes, nunca da Skill.";
    ok("Ms1 segredo: prosa documental NAO dispara", !sondaSegredo.test(DOC));
    ok("Ms2 segredo: valor atribuido dispara", sondaSegredo.test('access_token = "aB3xK9zQ7mP2wL5tR8"'));
    ok("Ms3 segredo: JWT sintetico dispara", sondaSegredo.test("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.aZ"));
    ok("Ms4 segredo: Bearer com valor dispara", sondaSegredo.test("Bearer " + "A".repeat(24)));
    ok("Ms5 segredo: chave sk- dispara", sondaSegredo.test("sk-" + "A".repeat(20)));
    ok("Ms6 segredo: bloco PRIVATE KEY dispara", sondaSegredo.test("-----BEGIN RSA PRIVATE KEY-----"));
  }


  for (const [nome, padrao, autorizados] of sondas) {
    const marcados = ARQUIVOS_AREA.filter((a) => padrao.test(codigo(ler(a))));
    const permitidos = autorizados ?? [];
    const sujos = marcados.filter((a) => !permitidos.includes(a));
    // Igualdade nos DOIS sentidos: arquivo nao autorizado que casa
    // com o padrao reprova, e autorizado que deixou de casar tambem
    // — allowlist com item obsoleto e como uma protecao morre sem
    // ninguem perceber.
    const sumidos = permitidos.filter((a) => !marcados.includes(a));
    ok(`M  ${permitidos.length === 0 ? "zero" : "so o autorizado tem"} ${nome}`,
      sujos.length === 0 && sumidos.length === 0,
      [...sujos, ...sumidos.map((a) => `${a} (sumiu)`)].join(", "));
  }

  ok("M16 o feed nao mostra custo em dinheiro",
    !/US\$|R\$|custo_usd/.test(TIMELINE + ITEM + MOCK_AT));
  ok("M17 controle negativo: a sonda acharia o valor",
    /US\$/.test("US$ 0,004"));
}

secao("N. Acessibilidade e responsividade");

{
  ok("N1  hierarquia de headings (h2 na timeline)", /<h2/.test(TIMELINE));
  ok("N2  icone + texto no item",
    /aria-hidden="true"/.test(ITEM) && /vocab\.rotulo/.test(ITEM));
  ok("N3  foco visivel em links e controles",
    /:focus-visible/.test(ITEM) && /:focus-visible/.test(TIMELINE));
  ok("N4  <button> so onde ha acao (filtros)",
    /<button/.test(TIMELINE) && !/<button/.test(ITEM));
  ok("N5  nenhum ARIA promete interacao inexistente",
    !/aria-live|aria-busy|aria-selected/.test(TIMELINE + ITEM));
  ok("N6  responsividade por CSS, sem viewport em JS",
    !/innerWidth|resize|matchMedia/.test(TIMELINE + ITEM));
  ok("N7  texto longo nao estoura", /overflow-wrap:\s*anywhere/.test(ITEM));
  ok("N8  filtros quebram linha em tela estreita", /flex-wrap:\s*wrap/.test(TIMELINE));
}

// ═══════════════════════════════════════════════════════════════════════
console.log(`\n══ CDS IA — UI-1D.b: feed de atividade:  ${passou}/${passou + falhou} passaram ══`);
if (falhou > 0) {
  console.log(`   ${falhou} FALHARAM`);
  process.exit(1);
}
