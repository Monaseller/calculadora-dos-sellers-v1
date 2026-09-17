/**
 * CDS IA — UI-1D.a. Suite da fila de aprovacoes.
 *
 * Cobre o contrato visual da solicitacao, a separacao entre acao /
 * motivo / risco / conexao, a ausencia de payload bruto, a
 * inelegibilidade acumulada e a ausencia total de interacao de decisao.
 *
 * Nao renderiza React: prova por LEITURA DE FONTE e por execucao das
 * funcoes puras. Toda varredura importante tem CONTROLE NEGATIVO — sonda
 * que nao acusa nada pode estar quebrada em vez de limpa, e nesta base
 * isso ja aconteceu quatro vezes.
 *
 * Rodar:  npx tsx scripts/testar-ia-ui-1d.ts
 * Sem rede, sem banco, sem IA.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  EXPLICACAO_INELEGIVEL,
  MOTIVOS_INELEGIVEL,
  conexaoValida,
  desdeQuando,
  elegibilidade,
  exigeConfirmacao,
  maisAntigasPrimeiro,
  type AprovacaoUI,
} from "../lib/ia/aprovacoes";
import { NIVEIS_AUTONOMIA, RISCOS } from "../lib/ia/conceitos";
import { MOCK_APROVACOES, MOCK_CONTAGENS } from "../lib/ia/mocks";

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

/** A pasta de mocks, nome a nome — sem wildcard. */
const MOCKS_PASTA: readonly string[] = [
  "lib/ia/mocks/agentes.ts",
  "lib/ia/mocks/aprovacoes.ts",
  "lib/ia/mocks/capabilities.ts",
  "lib/ia/mocks/conexoes.ts",
  "lib/ia/mocks/index.ts",
  "lib/ia/mocks/tarefas.ts",
];

const NOVOS_1DA = [
  "lib/ia/aprovacoes.ts",
  "components/ia/aprovacoes/CardAprovacao.tsx",
  "components/ia/aprovacoes/DetalheAprovacao.tsx",
  "components/ia/aprovacoes/FilaAprovacoes.tsx",
];

const ARQUIVOS_AREA: readonly string[] = [
  ...arquivosDe("lib/ia"),
  ...arquivosDe("components/ia"),
  ...arquivosDe("app/(app)/ia"),
];

const CONTRATO = ler("lib/ia/aprovacoes.ts");
const CARD = ler("components/ia/aprovacoes/CardAprovacao.tsx");
const DETALHE = ler("components/ia/aprovacoes/DetalheAprovacao.tsx");
const FILA = ler("components/ia/aprovacoes/FilaAprovacoes.tsx");
const PAGINA = ler("app/(app)/ia/aprovacoes/page.tsx");

const AGORA = Date.parse("2026-08-27T12:00:00.000Z");
const ha = (ms: number) => new Date(AGORA - ms).toISOString();

// ═══════════════════════════════════════════════════════════════════════
console.log("\n══ CDS IA — UI-1D.a: fila de aprovacoes ══");

secao("A. Inventario e pagina");

{
  ok("A1  os 4 arquivos novos existem",
    NOVOS_1DA.every((a) => ARQUIVOS_AREA.includes(a)),
    NOVOS_1DA.filter((a) => !ARQUIVOS_AREA.includes(a)).join(", "));
  ok("A2  componentes exportam default",
    NOVOS_1DA.filter((a) => a.endsWith(".tsx")).every((a) => /export default function/.test(ler(a))));
  ok("A3  /ia/aprovacoes exporta default", /export default function/.test(PAGINA));
  ok("A4  EmBreve foi REMOVIDO da pagina", !/EmBreve/.test(PAGINA));
  ok("A5  controle negativo: a sonda acharia EmBreve",
    /EmBreve/.test('import EmBreve from "@/components/ia/EmBreve";'));
  ok("A6  a pagina monta a fila", /FilaAprovacoes/.test(PAGINA));
  // `atividade` saiu desta lista na UI-1D.b, quando deixou de ser
  // placeholder. Atualizacao consciente: o assert continua exigindo a
  // lista EXATA das areas que ainda nao existem, agora com duas.
  ok("A7  as outras 2 areas continuam EmBreve",
    ["custos", "conexoes"].every(
      (a) => /EmBreve/.test(ler(`app/(app)/ia/${a}/page.tsx`))));
  ok("A7b atividade NAO e mais placeholder",
    !/EmBreve/.test(ler("app/(app)/ia/atividade/page.tsx")));
}

secao("B. Contrato: acao, motivo, risco e conexao SEPARADOS");

{
  const c = codigo(CONTRATO);
  ok("B1  AprovacaoUI existe", /interface AprovacaoUI/.test(c));
  ok("B2  acao canonica e tipo proprio", /interface AcaoCanonica/.test(c));
  ok("B3  os quatro sao campos distintos",
    /acao:\s*AcaoCanonica/.test(c) && /motivo:\s*string/.test(c) &&
    /risco:\s*Risco/.test(c) && /conexao:\s*ConexaoDaAprovacao \| null/.test(c));
  ok("B4  a acao tem identificador tecnico e rotulo humano",
    /capabilityId:\s*string/.test(c) && /rotulo:\s*string/.test(c));
  ok("B5  a acao distingue leitura de escrita e irreversibilidade",
    /acesso:\s*"leitura" \| "escrita"/.test(c) && /irreversivel:\s*boolean/.test(c));
  ok("B6  impacto e campo proprio, nao parte do motivo", /impacto:\s*string/.test(c));
  ok("B7  nivel exigido e sempre registrado", /nivelExigido:\s*NivelAutonomia/.test(c));
  ok("B8  procedencia registrada", /procedencia:\s*Procedencia/.test(c));

  // A regra central: nao existe campo para payload cru.
  ok("B9  NAO ha campo de payload/entrada/args cru",
    !/\b(payload|entrada)\s*:/.test(c) && !/args:\s*Record</.test(c));
  ok("B10 controle negativo: a sonda acharia um campo cru",
    /\b(payload|entrada)\s*:/.test("entrada: Record<string, unknown>;"));
  ok("B11 argumentos sao pares ja legiveis",
    /interface ArgumentoExibivel/.test(c) && /rotulo:\s*string/.test(c) && /valor:\s*string/.test(c));

  ok("B12 a conexao do contrato NAO tem id externo nem credencial",
    !/(seller_id|shop_id|partner_id|access_token|refresh_token|partner_key)/.test(
      c.split("interface AprovacaoUI")[0]));
}

secao("C. Elegibilidade e botoes");

{
  // ── A DORMENCIA GLOBAL ACABOU ─────────────────────────────────────
  //
  // Ate o A3 este bloco provava que NADA podia ser decidido, e a prova era
  // uma constante global lida daqui. A rota de decisao existe agora, entao
  // o assert nao podia continuar exigindo `false` nem virar `true`: a
  // constante saiu do contrato, e o que se prova e a AUSENCIA dela e do
  // motivo que ela alimentava. Procurar no TEXTO, e nao no valor, e o que
  // impede alguem de reintroduzi-la com outro valor.
  ok("C1  a constante global de dormencia sumiu do contrato",
    !/FLUXO_APROVACAO_CONECTADO/.test(CONTRATO) &&
    !/fluxo_nao_conectado/.test(CONTRATO));
  ok("C1a CONTROLE NEGATIVO: a sonda acha a constante quando ela existe",
    /FLUXO_APROVACAO_CONECTADO/.test("export const FLUXO_APROVACAO_CONECTADO = true;"));
  ok("C2  resta UM motivo de inelegibilidade", MOTIVOS_INELEGIVEL.length === 1);
  ok("C2a e ele e `conexao_invalida`", MOTIVOS_INELEGIVEL[0] === "conexao_invalida");
  ok("C3  todo motivo tem explicacao util",
    MOTIVOS_INELEGIVEL.every((m) => EXPLICACAO_INELEGIVEL[m].length > 30));
  ok("C4  a explicacao do fluxo morto NAO esta mais no dicionario",
    !Object.prototype.hasOwnProperty.call(EXPLICACAO_INELEGIVEL, "fluxo_nao_conectado") &&
    Object.keys(EXPLICACAO_INELEGIVEL).length === 1);
  ok("C5  a explicacao de conexao manda reconectar",
    /reconecte a conta/i.test(EXPLICACAO_INELEGIVEL.conexao_invalida));

  const conectada = { rotulo: "X", conta: "Y", estado: "conectada" as const };
  const expirada = { rotulo: "X", conta: "Y", estado: "expirada" as const };
  ok("C6  conexao conectada e valida", conexaoValida(conectada) === true);
  ok("C7  conexao expirada NAO e valida", conexaoValida(expirada) === false);
  ok("C8  acao sem conexao nao e bloqueada por isso", conexaoValida(null) === true);

  // ── A elegibilidade continua real, e continua sendo do MOCK ───────
  //
  // `elegibilidade()` le `conexao.estado`, que so existe em `AprovacaoUI`.
  // Estes asserts exercitam essa superficie, com os fixtures do mock. A
  // fila REAL nao entra aqui — ela nem pode, e E1/E2 provam isso.
  ok("C9  o que nao tem impedimento PODE ser decidido",
    MOCK_APROVACOES.filter((a) => a.conexao === null || a.conexao.estado === "conectada")
      .every((a) => elegibilidade(a).podeDecidir === true));
  ok("C9a e o que tem conexao invalida NAO pode",
    MOCK_APROVACOES.filter((a) => a.conexao !== null && a.conexao.estado !== "conectada")
      .every((a) => elegibilidade(a).podeDecidir === false));
  ok("C9b ANCORA: o mock cobre os dois lados",
    MOCK_APROVACOES.some((a) => elegibilidade(a).podeDecidir === true) &&
    MOCK_APROVACOES.some((a) => elegibilidade(a).podeDecidir === false));
  ok("C10 conexao valida nao acumula motivo, invalida acumula um",
    elegibilidade({ conexao: conectada }).motivos.length === 0 &&
    elegibilidade({ conexao: expirada }).motivos.length === 1);
  ok("C11 e o motivo restante e nominal",
    elegibilidade({ conexao: expirada }).motivos[0] === "conexao_invalida");

  // ── Os botoes decidem, e o disable deixou de ser fixo ─────────────
  ok("C12 Aprovar e Recusar existem como <button>",
    /<button[\s\S]{0,200}Recusar/.test(CARD) && /<button[\s\S]{0,200}Aprovar/.test(CARD));
  // C13 antes so contava `disabled`, e passaria igual com `disabled={x}`.
  // Agora separa as duas formas: zero atributo FIXO, dois condicionais.
  // A sonda de atributo FIXO exige `disabled` seguido de `>`, `/>` ou de
  // outro atributo. O seletor CSS `:disabled {` nao casa — depois dele vem
  // `{`, que nao e letra — e por isso o bloco de estilo do card nao
  // reprova por parecer o que nao e.
  ok("C13 zero `disabled` fixo no JSX, e dois condicionais por `enviando`",
    !/disabled\s*(\/?>|\s[a-zA-Z-])/.test(codigo(CARD)) &&
    (codigo(CARD).match(/disabled=\{enviando\}/g) ?? []).length === 2);
  ok("C13a CONTROLE NEGATIVO: a sonda acha o atributo fixo",
    /disabled\s*(\/?>|\s[a-zA-Z-])/.test('<button type="button" disabled>Aprovar</button>'));
  ok("C14 o card tem os DOIS handlers de decisao",
    /onClick=\{\(\) => onRecusar\(aprovacao\)\}/.test(codigo(CARD)) &&
    /onClick=\{\(\) => onAprovar\(aprovacao\)\}/.test(codigo(CARD)));
  ok("C15 e nao alcanca a rede por conta propria",
    !/fetch\(/.test(codigo(CARD)) && !/registrarDecisaoAprovacao/.test(codigo(CARD)));
  // C16 nao mudou de exigencia, mudou de MOTIVO: antes o card nao tinha
  // estado porque nao havia decisao; agora nao tem porque a fila e a dona.
  ok("C16 ZERO estado de decisao no card — quem guarda e a fila",
    !/useState|useReducer|toast/.test(codigo(CARD)) &&
    /enviando: boolean/.test(codigo(CARD)));
  ok("C16a e a fila guarda POR APROVACAO, nao um booleano global",
    /emVooRef = useRef<Set<string>>/.test(codigo(FILA)) &&
    /useState<ReadonlySet<string>>/.test(codigo(FILA)));
  // C17: o card real deixou de renderizar explicacao de impedimento. Ela
  // pertence ao contrato mock, e continua la — o que sumiu e o consumo.
  ok("C17 o card real NAO renderiza explicacao de inelegibilidade",
    !/EXPLICACAO_INELEGIVEL/.test(CARD) &&
    /EXPLICACAO_INELEGIVEL/.test(CONTRATO));
  ok("C18 a acao agora acontece, e e anunciada de forma acessivel",
    (CARD.match(/aria-busy=\{enviando\}/g) ?? []).length === 2 &&
    /aria-live="polite"/.test(FILA));
  ok("C19 confirmacao secundaria esta preparada, nao usada",
    /export function exigeConfirmacao/.test(CONTRATO) &&
    !/exigeConfirmacao/.test(codigo(CARD)) && !/exigeConfirmacao/.test(codigo(FILA)));
  ok("C20 a regra de confirmacao e risco alto OU irreversivel",
    exigeConfirmacao({ risco: "alto", acao: { irreversivel: false } as never }) === true &&
    exigeConfirmacao({ risco: "baixo", acao: { irreversivel: true } as never }) === true &&
    exigeConfirmacao({ risco: "baixo", acao: { irreversivel: false } as never }) === false);
}

secao("D. Detalhes inline, sem modal e sem payload");

{
  ok("D1  usa <details>/<summary>", /<details/.test(DETALHE) && /<summary/.test(DETALHE));
  ok("D2  NAO usa modal para detalhes",
    !/role="dialog"|aria-modal/.test(DETALHE));
  ok("D3  controle negativo: a sonda acha um dialog",
    /role="dialog"/.test('<div role="dialog">'));
  ok("D4  renderiza argumentos allowlisted, nao objeto",
    /argumentos\.map/.test(DETALHE) && !/JSON\.stringify/.test(codigo(DETALHE)));
  ok("D5  nenhum componente serializa objeto",
    [CARD, DETALHE, FILA].every((f) => !/JSON\.stringify/.test(codigo(f))));
  ok("D6  detalhes separam acao, motivo, impacto e conexao",
    /titulo="Ação"/.test(DETALHE) && /titulo="Motivo do agente"/.test(DETALHE) &&
    /titulo="Impacto se aprovada"/.test(DETALHE) && /titulo="Conexão"/.test(DETALHE));
  ok("D7  o detalhe diz que motivo NAO autoriza",
    /não autoriza/.test(DETALHE));
  ok("D8  mostra a politica que exigiu a aprovacao",
    /nivelExigido/.test(DETALHE) && /VOCABULARIO_NIVEL/.test(DETALHE));
}

secao("E. Fila: pendentes, ordem e estado vazio");

{
  ok("E1  a fila usa EstadoVazio", /EstadoVazio/.test(FILA));
  ok("E2  mensagem de vazio e positiva",
    /Nenhuma aprovação pendente/.test(FILA) && /não estão aguardando/.test(FILA));
  // A primeira versao procurava as PALAVRAS "aprovada/recusada/historico"
  // e reprovava justamente a nota que diz que o historico NAO fica aqui.
  // Procurar palavra em prosa nunca prova comportamento: o que importa e
  // a fila nao ter nocao de item ja decidido.
  ok("E3  a fila nao tem nocao de item decidido",
    !/status\s*===\s*"(aprovada|recusada|aprovado|recusado)"/.test(codigo(FILA)) &&
    !/\.filter\([^)]*decid/i.test(codigo(FILA)));
  // ── E3b migrado na APPROVAL-UI-API-A2 ───────────────────────────
  //
  // Ate aqui este assert exigia que a fila usasse `MOCK_APROVACOES`, e
  // estava certo: ela usava. Agora ela le `GET /api/aprovacoes` pelo
  // transporte, e o assert foi INVERTIDO, nao afrouxado — continua
  // afirmando de onde a fila tira os dados, so que a resposta mudou.
  // Exigir as duas pontas (ausencia do mock E presenca do transporte)
  // e o que impede a fila de ficar sem fonte nenhuma e passar.
  ok("E3b a fila vem da rota real, e NAO do mock",
    !/MOCK_APROVACOES/.test(codigo(FILA)) &&
    /listarAprovacoesPendentes/.test(codigo(FILA)));
  ok("E3b1 CONTROLE NEGATIVO: voltar ao mock reprova",
    /MOCK_APROVACOES/.test("import { MOCK_APROVACOES } from '@/lib/ia/mocks';"));
  ok("E3b2 CONTROLE NEGATIVO: perder o transporte reprova",
    !/listarAprovacoesPendentes/.test(
      codigo(FILA).split("listarAprovacoesPendentes").join("")));
  // A ordem agora e do SERVIDOR (`criado_em DESC, id DESC`). Reordenar
  // aqui criaria duas verdades sobre qual e o topo da fila.
  ok("E3b3 a fila nao reordena o que o servidor ja ordenou",
    !/maisAntigasPrimeiro/.test(codigo(FILA)) && !/\.sort\(/.test(codigo(FILA)));
  ok("E3c controle negativo: a sonda acha um filtro de decididas",
    /status\s*===\s*"(aprovada|recusada|aprovado|recusado)"/.test('x.status === "aprovada"'));
  ok("E4  aponta o historico para Atividade", /Atividade/.test(FILA));
  ok("E5  sem filtros nesta versao",
    !/filtro|filtrar|<select/i.test(codigo(FILA)));
  ok("E6  mais antigas primeiro",
    maisAntigasPrimeiro([
      { id: "nova", solicitadaEm: ha(60_000) } as AprovacaoUI,
      { id: "velha", solicitadaEm: ha(600_000) } as AprovacaoUI,
    ]).map((a) => a.id).join(",") === "velha,nova");
  // ── E7 migrado na APPROVAL-UI-API-A2 ────────────────────────────
  //
  // O aviso de simulacao saiu porque a superficie deixou de simular —
  // manter o selo sobre dado real seria mentir na direcao oposta. O
  // guard equivalente para as superficies que AINDA simulam continua em
  // `testar-ia-ui.ts` (F3), com allowlist nominal fechada nos dois
  // sentidos; aqui provamos apenas a ponta desta tela.
  ok("E7  a fila NAO se anuncia mais como simulada", !/MOCK_AVISO/.test(FILA));
  ok("E7a e o aviso continua existindo para quem ainda simula",
    /MOCK_AVISO/.test(ler("components/ia/atividade/Timeline.tsx")));

  ok("E8  'há X' formatado", desdeQuando(ha(120_000), AGORA) === "há 2 min");
  ok("E9  menos de 1 min", desdeQuando(ha(20_000), AGORA) === "agora há pouco");
  ok("E10 horas e dias",
    desdeQuando(ha(3 * 3_600_000), AGORA) === "há 3 h" &&
    desdeQuando(ha(48 * 3_600_000), AGORA) === "há 2 d");
  ok("E11 futuro nunca vira numero negativo", desdeQuando(ha(-60_000), AGORA) === "—");
  ok("E12 data invalida vira travessao", desdeQuando("nao-e-data", AGORA) === "—");
}

secao("F. Mocks e cenarios");

{
  ok("F1  MOCK_APROVACOES existe e nao esta vazia", MOCK_APROVACOES.length > 0);
  ok("F2  ids nao imitam UUID",
    MOCK_APROVACOES.every((a) => !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(a.id)));
  ok("F3  tarefaId tambem e ficticio",
    MOCK_APROVACOES.every((a) => !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(a.tarefaId)));
  ok("F4  TODA acao esta marcada como cenario futuro",
    MOCK_APROVACOES.every((a) => a.procedencia === "em_breve"));
  // ── F5 migrado na APPROVAL-UI-API-A2 ────────────────────────────
  //
  // O card deixou de ser cenario futuro: ele mostra uma Approval que
  // existe no banco. O que NAO mudou e que ninguem decide ainda, e e
  // isso que o assert passou a exigir — com a mesma severidade, so que
  // sobre a afirmacao correta.
  ok("F5  o card real NAO se apresenta como cenario ficticio",
    !/Cenário futuro/.test(CARD) && !/simulad/i.test(CARD));
  // F5a exigia que o card DISSESSE que a decisao nao estava disponivel.
  // Ela esta, desde o A3. O que precisa continuar valendo e o que o assert
  // protegia de verdade: o card nao pode prometer nada alem do que a
  // decisao faz. Por isso a exigencia vira o par oposto — o texto de
  // impedimento sumiu, e os rotulos de acao sao os reais.
  ok("F5a o card oferece a decisao em vez de explicar por que nao pode",
    !/EXPLICACAO_INELEGIVEL/.test(CARD) &&
    /Aprovar/.test(CARD) && /Recusar/.test(CARD) &&
    /onAprovar/.test(codigo(CARD)) && /onRecusar/.test(codigo(CARD)));
  ok("F5b e nao afirma nenhum desfecho que nao aconteceu",
    !/\bAprovado\b|\bRecusado\b|\bRejeitado\b/.test(CARD));
  ok("F6  cobre risco baixo, medio e alto",
    RISCOS.every((r) => MOCK_APROVACOES.some((a) => a.risco === r)),
    RISCOS.filter((r) => !MOCK_APROVACOES.some((a) => a.risco === r)).join(","));
  ok("F7  cobre conexao valida e invalida",
    MOCK_APROVACOES.some((a) => a.conexao?.estado === "conectada") &&
    MOCK_APROVACOES.some((a) => a.conexao !== null && a.conexao.estado !== "conectada"));
  ok("F8  ha item inelegivel por conexao",
    MOCK_APROVACOES.some((a) => elegibilidade(a).motivos.includes("conexao_invalida")));
  ok("F9  agentes diferentes", new Set(MOCK_APROVACOES.map((a) => a.agenteId)).size > 1);
  ok("F10 acoes diferentes", new Set(MOCK_APROVACOES.map((a) => a.acao.capabilityId)).size > 1);
  ok("F11 ha acao irreversivel, para exercitar a regra futura",
    MOCK_APROVACOES.some((a) => a.acao.irreversivel));
  ok("F12 todo nivel exigido e valido",
    MOCK_APROVACOES.every((a) => (NIVEIS_AUTONOMIA as readonly string[]).includes(a.nivelExigido)));
  ok("F13 toda solicitacao tem motivo E impacto separados",
    MOCK_APROVACOES.every((a) => a.motivo.length > 10 && a.impacto.length > 10 && a.motivo !== a.impacto));
  ok("F14 todo argumento e par rotulo/valor legivel",
    MOCK_APROVACOES.every((a) => a.acao.argumentos.every((x) => x.rotulo.length > 0 && x.valor.length > 0)));

  ok("F15 o badge da subnav deriva da FILA (fonte unica)",
    MOCK_CONTAGENS.aguardandoAprovacao === MOCK_APROVACOES.length);
  ok("F16 nao existe contador separado de aprovacoes",
    !MOCKS_PASTA.some((m) => /MOCK_CONTADOR/.test(ler(m))));
}

secao("G. Zero backend e zero segredo");

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
    ["integracao de marketplace",
      /lib\/marketplace|lib\/(mercado-livre|shopee|ml-auth|shopee-auth|sync-ml|sync-shopee)|mercadolibre\.com|shopee\.com|partner_id|app_secret/i],
    ["n8n", /n8n/i],
    ["dados/capability de agente", /lib\/agentes\/(dados|capability|executar)/],
    ["SQL", /\bselect\b[^;\n]{0,80}\bfrom\b|\binsert\s+into\b|\bupdate\b[^;\n]{0,40}\bset\b/i],
    ["migration/RPC", /supabase\/migrations|apply_migration|create table|alter table|\.rpc\(/i],
    ["rota de API / server action", /app\/api\/|route\.ts|NextResponse|"use server"/],
    // A sonda exige VALOR, nunca a palavra. Uma Ficha de Integracao
    // precisa poder DOCUMENTAR autenticacao ("a API usa access_token",
    // "envie Authorization: Bearer <token>") sem ser tratada como
    // vazamento — isso e requisito de produto, nao tolerancia. O que
    // reprova e a credencial em si. Semantica equivalente a de
    // `lib/ia/skills/formato.ts`, que precisou da mesma distincao.
    ["segredo", /\b(?:access_token|refresh_token|partner_key|client_secret|api[_-]?key|token|secret|senha)\b\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{12,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.|\bsk-[A-Za-z0-9_-]{16,}|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9_\-.]{16,}/i],
    ["identificador externo", /\bseller_id\b|\bshop_id\b|\bpartner_id\b/],
    // `agente_id` NAO entra: e campo legitimo de `TarefaUI`, espelha a
    // coluna do banco desde a UI-1C.a e carrega valores ficticios (`ag-*`,
    // provados em F2/F3). As demais suites da area usam exatamente este
    // par — incluir um terceiro termo reprovaria contrato correto.
    ["identificador de dono", /\buser_id\b|\bloja_id\b/],
    ["viewport em JS", /window\.innerWidth|addEventListener\("resize"|matchMedia/],
    ["resultado bruto", /\bresultado\b\s*:|\.resultado\b/],
  ];

  const isca = [
    'createClient(supabase)', 'fetch("/x")', 'process.env.X', 'anthropic()',
    'import x from "@/lib/marketplace/credenciais"', 'n8n webhook',
    'lib/agentes/dados/vendas', 'select * from pedidos',
    'supabase/migrations/x.sql', '"use server"',
    'access_token = "aB3xK9zQ7mP2wL5tR8"', 'seller_id', 'user_id', 'window.innerWidth',
    'resultado: {}',
  ].join("\n");

  let mortas = 0;
  for (const [nome, p] of sondas) {
    if (!p.test(isca)) { mortas++; console.log(`        SONDA MORTA: ${nome}`); }
  }
  ok("G0  controle negativo: as 15 sondas acusam a isca", mortas === 0, `${mortas} mortas`);
  // A sonda de segredo mudou de semantica nesta fase: passou a exigir
  // VALOR. Os controles abaixo provam os dois lados — que ela continua
  // viva para credencial real, e que nao reprova documentacao.
  {
    const sondaSegredo = sondas.find(([n]) => n === "segredo")![1];
    const DOC =
      "A API usa access_token e refresh_token. Envie Authorization: Bearer <token>. " +
      "A API key vem de Conexoes, nunca da Skill.";
    ok("Gs1 segredo: prosa documental NAO dispara", !sondaSegredo.test(DOC));
    ok("Gs2 segredo: valor atribuido dispara", sondaSegredo.test('access_token = "aB3xK9zQ7mP2wL5tR8"'));
    ok("Gs3 segredo: JWT sintetico dispara", sondaSegredo.test("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.aZ"));
    ok("Gs4 segredo: Bearer com valor dispara", sondaSegredo.test("Bearer " + "A".repeat(24)));
    ok("Gs5 segredo: chave sk- dispara", sondaSegredo.test("sk-" + "A".repeat(20)));
    ok("Gs6 segredo: bloco PRIVATE KEY dispara", sondaSegredo.test("-----BEGIN RSA PRIVATE KEY-----"));
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
    ok(`G  ${permitidos.length === 0 ? "zero" : "so o autorizado tem"} ${nome}`,
      sujos.length === 0 && sumidos.length === 0,
      [...sujos, ...sumidos.map((a) => `${a} (sumiu)`)].join(", "));
  }
}

secao("H. Acessibilidade e responsividade");

{
  // ── H1 migrado na APPROVAL-UI-API-A2 ────────────────────────────
  //
  // `risco` era campo do mock. `agente_funcao_aprovacoes` nao o tem, e
  // nao ha de onde deriva-lo: exibi-lo obrigaria a inventar um nivel de
  // perigo numa tela de autorizacao. O assert nao foi removido — passou
  // a proibir exatamente o que antes exigia.
  ok("H1  o card NAO inventa risco, simbolo nem rotulo de risco",
    !/SIMBOLO_RISCO/.test(CARD) && !/ROTULO_RISCO/.test(CARD) &&
    !/\.risco\b/.test(codigo(CARD)));
  ok("H1a CONTROLE NEGATIVO: a sonda acha risco se ele voltar",
    /SIMBOLO_RISCO/.test("const x = SIMBOLO_RISCO[a.risco];"));
  // O que substitui o selo de risco e o dado que EXISTE: o acesso
  // declarado pela Funcao, com icone e texto.
  ok("H1b o acesso continua com icone E texto",
    /ROTULO_ACESSO/.test(CARD) && /acesso\.icone/.test(CARD) && /acesso\.rotulo/.test(CARD));
  // ── H2 migrado na APPROVAL-UI-API-A2 ────────────────────────────
  //
  // O contrato real de conexao tem DOIS rotulos — plataforma e recurso
  // — e mais nada: sem conta, sem id de loja, sem estado. O card nao
  // pode pintar um estado que o servidor nao informa.
  ok("H2  o card NAO inventa estado nem conta de conexao",
    !/VOCABULARIO_CONEXAO/.test(CARD) &&
    !/conexao\.conta|conexao\.estado/.test(codigo(CARD)));
  ok("H2a e quando ha conexao mostra so os dois rotulos reais",
    /conexao\.plataforma/.test(CARD) && /conexao\.recurso/.test(CARD));
  ok("H2b sem conexao a tela diz isso em texto, nao em simbolo",
    /Não depende de conta externa/.test(CARD));
  ok("H3  headings hierarquicos (h2 fila, h3 card, h5 detalhe)",
    /<h2/.test(FILA) && /<h3/.test(CARD) && /<h5/.test(DETALHE));
  ok("H4  o card e rotulado para leitor de tela", /aria-labelledby/.test(CARD));
  ok("H5  foco visivel nos links e no summary",
    /:focus-visible/.test(CARD) && /:focus-visible/.test(DETALHE));
  ok("H6  botao desabilitado tem cursor proprio, nao so opacidade",
    /cursor:\s*not-allowed/.test(CARD));
  ok("H7  contraste do desabilitado nao apaga o rotulo",
    /opacity:\s*\.5[0-9]?/.test(CARD));
  ok("H8  grids responsivos por CSS",
    /repeat\(auto-fit/.test(FILA) && /repeat\(auto-fit/.test(DETALHE));
  ok("H9  sem tabela horizontal", ![CARD, DETALHE, FILA].some((f) => /<table/.test(f)));
  ok("H10 sem viewport em JS",
    [CARD, DETALHE, FILA].every((f) => !/innerWidth|resize|matchMedia/.test(f)));
  ok("H11 texto longo nao estoura", /overflow-wrap:\s*anywhere/.test(CARD));
}

// ═══════════════════════════════════════════════════════════════════════
console.log(`\n══ CDS IA — UI-1D.a: fila de aprovacoes:  ${passou}/${passou + falhou} passaram ══`);
if (falhou > 0) {
  console.log(`   ${falhou} FALHARAM`);
  process.exit(1);
}
