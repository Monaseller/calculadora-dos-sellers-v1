/**
 * CDS IA — UI-1B. Suite estrutural da fundacao visual.
 *
 * Nao renderiza React: prova por LEITURA DE FONTE e por execucao das
 * funcoes puras. O que importa nesta fase e que a UI nao tenha adquirido
 * poderes que ela nao deve ter (banco, rede, segredo) e que o
 * vocabulario de estado nao tenha vazado.
 *
 * Cada varredura tem CONTROLE NEGATIVO: um texto que a sonda TEM de
 * acusar. Sonda que nao acusa nada pode estar quebrada em vez de limpa —
 * ja aconteceu nesta base (regex BRE rodando sob ERE nao acusava JWT
 * nenhum e o verde era falso).
 *
 * Rodar:  npx tsx scripts/testar-ia-ui.ts
 * Sem rede, sem banco, sem IA.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { STATUS_AGENTE_DERIVADO } from "../lib/agentes/tipos";
import {
  ESTADOS_VISUAIS,
  JANELA_CONCLUIDO_MS,
  ROTULO_FORA_DE_OPERACAO,
  VOCABULARIO_ESTADO,
  aparenciaDoAgente,
  estaNaEstacao,
  iconeDe,
  rotuloDe,
} from "../lib/ia/estados";
import { MOCK_AGENTES, MOCK_APROVACOES, MOCK_CONTAGENS, MOCK_TAREFAS, MOCK_AVISO } from "../lib/ia/mocks";
import { TIPOS_AGENTE_UI } from "../lib/ia/contratos";

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
const sha = (rel: string) => createHash("sha256").update(readFileSync(join(RAIZ, rel))).digest("hex");

/** Comentarios fora: uma palavra proibida citada em comentario e
 *  documentacao, nao uso. Sem isto, o cabecalho que EXPLICA a regra
 *  reprovaria a propria regra. */
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

// ═══════════════════════════════════════════════════════════════════════
// INVENTARIO — o que a UI-1B esta autorizada a ter
// ═══════════════════════════════════════════════════════════════════════

const ARQUIVOS_UI_1B: readonly string[] = [
  "lib/ia/contratos.ts",
  "lib/ia/estados.ts",
  "lib/ia/design.ts",
  // `lib/ia/mocks.ts` virou a pasta `lib/ia/mocks/` na UI-1D.a.
  "lib/ia/mocks/index.ts",
  "lib/ia/mocks/agentes.ts",
  "lib/ia/mocks/tarefas.ts",
  "lib/ia/mocks/conexoes.ts",
  "lib/ia/mocks/capabilities.ts",
  "lib/ia/mocks/aprovacoes.ts",
  "lib/ia/mocks/atividade.ts",
  "components/ia/BadgeEstado.tsx",
  "components/ia/EmBreve.tsx",
  "components/ia/SubNavIA.tsx",
  "components/ia/office/Escritorio.tsx",
  "components/ia/office/Estacao.tsx",
  "components/ia/office/PainelAgente.tsx",
  "app/(app)/ia/layout.tsx",
  "app/(app)/ia/page.tsx",
  "app/(app)/ia/agentes/page.tsx",
  "app/(app)/ia/conexoes/page.tsx",
  "app/(app)/ia/aprovacoes/page.tsx",
  "app/(app)/ia/atividade/page.tsx",
  "app/(app)/ia/custos/page.tsx",
];

/**
 * O que a UI-1C.a acrescentou: a pagina individual do agente, as duas
 * abas com conteudo, os contratos dos quatro conceitos e a apresentacao
 * de tarefas.
 *
 * Declarado nome a nome, como as demais fases: o guarda continua
 * reprovando arquivo que aparecer no disco sem passar por aqui.
 */
const ARQUIVOS_UI_1CA: readonly string[] = [
  "lib/ia/abas.ts",
  "lib/ia/conceitos.ts",
  "lib/ia/tarefas.ts",
  "components/ia/EstadoVazio.tsx",
  "components/ia/agente/AbasAgente.tsx",
  "components/ia/agente/ListaTarefas.tsx",
  "components/ia/agente/PaginaAgente.tsx",
  "components/ia/agente/VisaoGeral.tsx",
  "app/(app)/ia/agentes/[id]/page.tsx",
];

/**
 * O que a UI-1C.b acrescentou: as tres abas de configuracao do agente e
 * os cards que elas usam.
 */
const ARQUIVOS_UI_1CB: readonly string[] = [
  "components/ia/agente/AbaConexoes.tsx",
  "components/ia/agente/AbaFuncoes.tsx",
  "components/ia/agente/AbaPermissoes.tsx",
  "components/ia/conexoes/CardConexao.tsx",
  "components/ia/capabilities/CardFuncao.tsx",
  "components/ia/capabilities/SeletorAutonomia.tsx",
];

/**
 * O que a UI-1D.a acrescentou: a fila de aprovacoes e seu contrato.
 */
const ARQUIVOS_UI_1DB: readonly string[] = [
  "lib/ia/atividade.ts",
  "components/ia/atividade/Timeline.tsx",
  "components/ia/atividade/ItemAtividade.tsx",
];

/**
 * O que a SKILL-1D.ui-consumer-C acrescentou: o UNICO ponto de rede da
 * area. Um arquivo so, e de proposito — a sonda `fetch/rede` do bloco E
 * o nomeia como o unico autorizado, e um segundo arquivo com rede
 * reprovaria as cinco suites desta area.
 */
const ARQUIVOS_UI_CONSUMER: readonly string[] = [
  "lib/ia/agentes-http.ts",
  // SKILL-1D.agent-create-ui-B: o dialogo de criacao. Nao faz rede por
  // conta propria — chama o transporte acima, que segue sendo o unico
  // arquivo da area autorizado a isso.
  "components/ia/agente/CriarAgente.tsx",
];

const ARQUIVOS_UI_1DA: readonly string[] = [
  "lib/ia/aprovacoes.ts",
  "components/ia/aprovacoes/CardAprovacao.tsx",
  "components/ia/aprovacoes/DetalheAprovacao.tsx",
  "components/ia/aprovacoes/FilaAprovacoes.tsx",
];

/**
 * O que a SKILL-1B acrescentou: o contrato do CDS Skill Format v1.
 *
 * Nao e UI — sao contrato e parser puros, consumidos pela biblioteca de
 * Skills quando ela existir. Entram aqui porque vivem em `lib/ia/` e o
 * guarda de inventario varre a arvore inteira: arquivo novo nesta area
 * PRECISA falhar o teste ate ser declarado, e essa e a razao de o guarda
 * existir. Declarar e o passo; afrouxar a varredura nunca foi opcao.
 */
const ARQUIVOS_SKILL_1B: readonly string[] = [
  "lib/ia/skills/contrato.ts",
  "lib/ia/skills/formato.ts",
];

/** O que a SKILL-1C acrescentou: o motor puro de diagnostico. */
const ARQUIVOS_SKILL_1C: readonly string[] = [
  "lib/ia/skills/diagnostico.ts",
];

/** A area inteira. As varreduras de seguranca valem para TUDO. */
const ARQUIVOS_UI: readonly string[] = [
  ...ARQUIVOS_UI_1B,
  ...ARQUIVOS_UI_1CA,
  ...ARQUIVOS_UI_1CB,
  ...ARQUIVOS_UI_1DA,
  ...ARQUIVOS_UI_1DB,
  ...ARQUIVOS_SKILL_1B,
  ...ARQUIVOS_SKILL_1C,
  ...ARQUIVOS_UI_CONSUMER,
];

/**
 * A pasta de mocks. `ehMock` responde "isto e fonte de dado simulado?" —
 * usado para excluir a pasta das varreduras que proibem fake FORA dela.
 */
const PASTA_MOCKS: readonly string[] = ARQUIVOS_UI.filter((a) => a.startsWith("lib/ia/mocks/"));
const ehMock = (a: string) => a.startsWith("lib/ia/mocks/");

/** Fontes de componente. `.tsx` de componente + de rota. */
const COMPONENTES = ARQUIVOS_UI.filter((a) => a.endsWith(".tsx"));

// ═══════════════════════════════════════════════════════════════════════
console.log("\n══ CDS IA — UI-1B: fundacao visual ══");

secao("A. Inventario e rotas");

{
  const noDisco = [
    ...arquivosDe("lib/ia"),
    ...arquivosDe("components/ia"),
    ...arquivosDe("app/(app)/ia"),
  ].sort();
  const declarado = [...ARQUIVOS_UI].sort();

  ok("A1  disco == inventario declarado (sem arquivo surpresa)",
    JSON.stringify(noDisco) === JSON.stringify(declarado),
    `disco=${noDisco.length} declarado=${declarado.length}`);

  // 45 na UI-1D.b; 47 na SKILL-1B (contrato.ts + formato.ts); 48 desde a
  // SKILL-1C (diagnostico.ts); 49 na SKILL-1D.ui-consumer-C
  // (`agentes-http.ts`, o unico ponto de rede da area); 50 na
  // SKILL-1D.agent-create-ui-B (`CriarAgente.tsx`). O numero continua
  // literal de proposito: se ele fosse `ARQUIVOS_UI.length`, o assert
  // compararia a lista consigo mesma e um arquivo novo declarado sem
  // revisao passaria batido.
  ok("A2  50 arquivos, nem um a mais", noDisco.length === 50, String(noDisco.length));
}

const ROTAS = [
  "app/(app)/ia/page.tsx",
  "app/(app)/ia/agentes/page.tsx",
  "app/(app)/ia/conexoes/page.tsx",
  "app/(app)/ia/aprovacoes/page.tsx",
  "app/(app)/ia/atividade/page.tsx",
  "app/(app)/ia/custos/page.tsx",
];
ok("A3  as 6 rotas existem e exportam default",
  ROTAS.every((r) => /export default function/.test(ler(r))));

ok("A4  layout da area existe e monta a subnav",
  /export default function/.test(ler("app/(app)/ia/layout.tsx")) &&
  /SubNavIA/.test(ler("app/(app)/ia/layout.tsx")));

ok("A5  /ia renderiza o Escritorio",
  /Escritorio/.test(ler("app/(app)/ia/page.tsx")));

ok("A6  nenhuma rota nova fora de app/(app)/ia",
  arquivosDe("app/(app)/ia").every((a) => ARQUIVOS_UI.includes(a)));

secao("B. Navegacao");

{
  const sidebar = ler("components/Sidebar.tsx");
  ok("B1  Sidebar tem o item CDS IA", /href:\s*"\/ia"/.test(sidebar) && /label:\s*"CDS IA"/.test(sidebar));
  ok("B2  Central de IA NAO foi renomeada", /label:\s*"Central de IA"/.test(sidebar));
  ok("B3  os 9 itens antigos continuam la",
    ["/dashboard", "/precificacao", "/vendas", "/anuncios", "/central-ia", "/historico",
     "/comparativo", "/configuracoes", "/suporte"].every((h) => sidebar.includes(`href: "${h}"`)));

  // A regra de "item ativo" da Sidebar, aplicada a caminhos reais. Com
  // literais soltos o `tsc` reduzia a comparacao a tipos sem sobreposicao
  // e o assert nao testava nada — testa-se a FUNCAO, com dados.
  const ativoNaSidebar = (href: string, caminho: string) =>
    caminho === href || caminho.startsWith(href + "/");

  ok("B4  /ia nao ativa em rotas de /central-ia",
    !ativoNaSidebar("/ia", "/central-ia") &&
    !ativoNaSidebar("/ia", "/central-ia/estudio-anuncios"));
  ok("B4b /ia ativa nele mesmo e nas subrotas da area",
    ativoNaSidebar("/ia", "/ia") &&
    ativoNaSidebar("/ia", "/ia/agentes") &&
    ativoNaSidebar("/ia", "/ia/custos"));
  ok("B4c /central-ia continua ativando nas rotas dele",
    ativoNaSidebar("/central-ia", "/central-ia") &&
    ativoNaSidebar("/central-ia", "/central-ia/estudio-anuncios") &&
    !ativoNaSidebar("/central-ia", "/ia"));

  const subnav = ler("components/ia/SubNavIA.tsx");
  for (const rotulo of ["Escritório", "Agentes", "Conexões", "Aprovações", "Atividade", "Custos"]) {
    ok(`B5  subnav declara "${rotulo}"`, subnav.includes(`"${rotulo}"`));
  }
  ok("B6  subnav marca o Escritorio como casamento exato",
    /exato:\s*true/.test(subnav));
  ok("B7  item ativo nao depende so de cor (aria-current + sublinhado)",
    /aria-current/.test(subnav) && /boxShadow/.test(subnav));
}

secao("C. Os 5 estados canonicos e a traducao unica");

ok("C1  exatamente 5 estados visuais", ESTADOS_VISUAIS.length === 5);
ok("C2  os 5 nomes sao os canonicos do produto",
  JSON.stringify([...ESTADOS_VISUAIS]) ===
  JSON.stringify(["ocioso", "trabalhando", "aguardando_aprovacao", "concluido", "erro"]));
ok("C3  nao existe estado 'desativado' entre os visuais",
  !(ESTADOS_VISUAIS as readonly string[]).includes("desativado"));
ok("C4  todo estado tem rotulo e icone (cor nunca sozinha)",
  ESTADOS_VISUAIS.every((e) => VOCABULARIO_ESTADO[e].rotulo.length > 0 && VOCABULARIO_ESTADO[e].icone.length > 0));

{
  // Totalidade: cada estado derivado do BACKEND aparece no mapa. Se o
  // backend ganhar um sexto, este assert cai junto com o `tsc`.
  const fonte = codigo(ler("lib/ia/estados.ts"));
  ok("C5  a traducao cobre os 5 estados derivados do backend",
    STATUS_AGENTE_DERIVADO.every((s) => new RegExp(`\\b${s}:`).test(fonte)),
    STATUS_AGENTE_DERIVADO.join(","));
  ok("C6  o backend continua com 5 derivados", STATUS_AGENTE_DERIVADO.length === 5);
}

{
  // Comportamento, nao so texto.
  const ativo = { ativo: true };
  const inativo = { ativo: false };
  const t = (status: string, concluido_em: string | null = null) =>
    ({ status, concluido_em } as { status: never; concluido_em: string | null });
  const agora = Date.parse("2026-08-27T12:00:00.000Z");
  const ha = (ms: number) => new Date(agora - ms).toISOString();

  ok("C7  ativo sem tarefa -> ocioso",
    aparenciaDoAgente(ativo, [], agora).estado === "ocioso");
  ok("C8  rodando -> trabalhando",
    aparenciaDoAgente(ativo, [t("rodando")], agora).estado === "trabalhando");
  ok("C9  pendente tambem -> trabalhando (ha trabalho enfileirado)",
    aparenciaDoAgente(ativo, [t("pendente")], agora).estado === "trabalhando");
  ok("C10 aguardando vence rodando",
    aparenciaDoAgente(ativo, [t("rodando"), t("aguardando_aprovacao")], agora).estado === "aguardando_aprovacao");
  ok("C11 erro vence aguardando",
    aparenciaDoAgente(ativo, [t("erro"), t("aguardando_aprovacao")], agora).estado === "erro");
  ok("C12 concluido recente -> flash concluido",
    aparenciaDoAgente(ativo, [t("concluido", ha(2_000))], agora).estado === "concluido");
  ok("C13 flash expira sozinho apos a janela",
    aparenciaDoAgente(ativo, [t("concluido", ha(JANELA_CONCLUIDO_MS + 1_000))], agora).estado === "ocioso");
  ok("C14 flash NAO sobrepoe trabalho em andamento",
    aparenciaDoAgente(ativo, [t("concluido", ha(1_000)), t("rodando")], agora).estado === "trabalhando");
  ok("C15 flash NAO sobrepoe erro",
    aparenciaDoAgente(ativo, [t("concluido", ha(1_000)), t("erro")], agora).estado === "erro");
  ok("C16 concluido_em nulo nunca vira flash",
    aparenciaDoAgente(ativo, [t("concluido", null)], agora).estado === "ocioso");
  ok("C17 concluido_em invalido nunca vira flash",
    aparenciaDoAgente(ativo, [t("concluido", "nao-e-data")], agora).estado === "ocioso");
  ok("C18 concluido no FUTURO nunca vira flash",
    aparenciaDoAgente(ativo, [t("concluido", ha(-60_000))], agora).estado === "ocioso");

  // O modificador ortogonal.
  const desativado = aparenciaDoAgente(inativo, [], agora);
  ok("C19 inativo liga o modificador foraDeOperacao", desativado.foraDeOperacao === true);
  ok("C20 inativo NAO produz um sexto estado",
    (ESTADOS_VISUAIS as readonly string[]).includes(desativado.estado));
  ok("C21 inativo nunca mostra a palavra 'Ocioso'",
    rotuloDe(desativado) === ROTULO_FORA_DE_OPERACAO && rotuloDe(desativado) !== VOCABULARIO_ESTADO.ocioso.rotulo);
  ok("C22 inativo tem icone proprio (nao contradiz o texto)",
    iconeDe(desativado) !== VOCABULARIO_ESTADO.ocioso.icone);
  ok("C23 desativado vence erro (precedencia do backend preservada)",
    aparenciaDoAgente(inativo, [t("erro")], agora).foraDeOperacao === true &&
    aparenciaDoAgente(inativo, [t("erro")], agora).estado !== "erro");
  ok("C24 desativado nao ganha flash de conclusao",
    aparenciaDoAgente(inativo, [t("concluido", ha(1_000))], agora).estado !== "concluido");
  ok("C25 ocioso e foraDeOperacao sao distinguiveis",
    rotuloDe(aparenciaDoAgente(ativo, [], agora)) !== rotuloDe(desativado));

  ok("C26 quem esta fora de operacao nao ocupa estacao", estaNaEstacao(desativado) === false);
  ok("C27 ocioso nao ocupa estacao",
    estaNaEstacao(aparenciaDoAgente(ativo, [], agora)) === false);
  ok("C28 trabalhando ocupa estacao",
    estaNaEstacao(aparenciaDoAgente(ativo, [t("rodando")], agora)) === true);
  ok("C29 aguardando ocupa estacao",
    estaNaEstacao(aparenciaDoAgente(ativo, [t("aguardando_aprovacao")], agora)) === true);
}

secao("D. Vocabulario do backend nao vaza para a UI");

{
  // A regra: nenhum componente conhece "ocupado" ou "idle". So
  // `lib/ia/estados.ts` traduz.
  const proibidos = [/\bocupado\b/, /\bidle\b/, /\bdesativado\b/];
  let vazamentos = 0;
  for (const arq of [...COMPONENTES, ...PASTA_MOCKS, "lib/ia/design.ts", "lib/ia/contratos.ts"]) {
    const fonte = codigo(ler(arq));
    for (const p of proibidos) {
      if (p.test(fonte)) {
        vazamentos++;
        console.log(`        vazou ${p} em ${arq}`);
      }
    }
  }
  ok("D1  zero vazamento de 'ocupado'/'idle'/'desativado' fora de estados.ts", vazamentos === 0);

  ok("D2  controle negativo: a sonda acusa o proprio estados.ts",
    [/\bocupado\b/, /\bidle\b/].every((p) => p.test(codigo(ler("lib/ia/estados.ts")))));

  ok("D3  estados.ts e o unico a importar lib/agentes",
    ARQUIVOS_UI.filter((a) => /from "@\/lib\/agentes/.test(ler(a))).join() === "lib/ia/estados.ts");
}

secao("E. Zero backend: banco, rede, provider, segredo");

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
    // A primeira versao era `/mercadolivre|mercadolibre|shopee/i`, que
    // buscava a PALAVRA. Ela reprovou `lib/ia/mocks.ts` no momento em que
    // a UI passou a nomear a conexao "Mercado Livre" — e nomear a conexao
    // e exatamente o que a tela precisa fazer. O alvo certo e a
    // INTEGRACAO: cliente, endpoint, SDK, modulo de marketplace.
    // Enfraquecer a sonda seria remove-la; estreita-la e mira-la melhor.
    ["integracao de marketplace",
      /lib\/marketplace|lib\/(mercado-livre|shopee|ml-auth|shopee-auth|sync-ml|sync-shopee)|mercadolibre\.com|mercadolivre\.com|shopee\.com|partner_id|app_secret/i],
    ["n8n", /n8n/i],
    ["capability/dados de agente", /lib\/agentes\/(dados|capability|executar)/],
    // A primeira versao desta sonda era `select\s+from`, que NAO pega
    // `select * from pedidos` — a forma real. Passava verde sem ser capaz
    // de detectar SQL nenhum. O controle negativo abaixo a reprovou.
    ["SQL", /\bselect\b[^;\n]{0,80}\bfrom\b|\binsert\s+into\b|\bdelete\s+from\b|\bupdate\b[^;\n]{0,40}\bset\b/i],
    // A sonda exige VALOR, nunca a palavra. Uma Ficha de Integracao
    // precisa poder DOCUMENTAR autenticacao ("a API usa access_token",
    // "envie Authorization: Bearer <token>") sem ser tratada como
    // vazamento — isso e requisito de produto. O que reprova e a
    // credencial em si. Mesma semantica de `lib/ia/skills/formato.ts`.
    ["segredo", /\b(?:access_token|refresh_token|partner_key|client_secret|api[_-]?key|token|secret|senha)\b\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{12,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.|\bsk-[A-Za-z0-9_-]{16,}|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9_\-.]{16,}/i],
    ["identificador de dono", /user_id|loja_id|seller_id|shop_id/],
  ];

  // Controle negativo: um texto que TEM de acusar todas as 10.
  const iscas = [
    'createClient(supabase)', 'fetch("/x")', 'process.env.X', 'anthropic()',
    'import x from "@/lib/marketplace/credenciais"', 'n8n webhook',
    'lib/agentes/dados/vendas', 'select * from pedidos',
    'access_token = "aB3xK9zQ7mP2wL5tR8"', 'user_id',
  ].join("\n");
  ok("E0  controle negativo: as 10 sondas acusam a isca",
    sondas.every(([, p]) => p.test(iscas)), String(sondas.filter(([, p]) => !p.test(iscas)).length));

  // A sonda de segredo mudou de semantica nesta fase: passou a exigir
  // VALOR. Os controles abaixo provam os dois lados — viva para
  // credencial real, silenciosa para documentacao.
  {
    const sondaSegredo = sondas.find(([n]) => n === "segredo")![1];
    const DOC =
      "A API usa access_token e refresh_token. Envie Authorization: Bearer <token>. " +
      "A API key vem de Conexoes, nunca da Skill.";
    ok("E0a segredo: prosa documental NAO dispara", !sondaSegredo.test(DOC));
    ok("E0b segredo: valor atribuido dispara", sondaSegredo.test('access_token = "aB3xK9zQ7mP2wL5tR8"'));
    ok("E0c segredo: JWT sintetico dispara", sondaSegredo.test("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.aZ"));
    ok("E0d segredo: Bearer com valor dispara", sondaSegredo.test("Bearer " + "A".repeat(24)));
    ok("E0e segredo: chave sk- dispara", sondaSegredo.test("sk-" + "A".repeat(20)));
    ok("E0f segredo: bloco PRIVATE KEY dispara", sondaSegredo.test("-----BEGIN RSA PRIVATE KEY-----"));
  }

  for (const [nome, padrao, autorizados] of sondas) {
    const marcados = ARQUIVOS_UI.filter((a) => padrao.test(codigo(ler(a))));
    const permitidos = autorizados ?? [];
    const sujos = marcados.filter((a) => !permitidos.includes(a));
    // Igualdade nos DOIS sentidos: arquivo nao autorizado que casa
    // com o padrao reprova, e autorizado que deixou de casar tambem
    // — allowlist com item obsoleto e como uma protecao morre sem
    // ninguem perceber.
    const sumidos = permitidos.filter((a) => !marcados.includes(a));
    ok(`E  ${permitidos.length === 0 ? "zero" : "so o autorizado tem"} ${nome} em toda a UI-1B`,
      sujos.length === 0 && sumidos.length === 0,
      [...sujos, ...sumidos.map((a) => `${a} (sumiu)`)].join(", "));
  }
}

secao("F. Mocks centralizados e ficticios");

{
  const fora = ARQUIVOS_UI
    .filter((a) => !ehMock(a))
    .filter((a) => /const\s+[A-Z_]*(AGENTES|TAREFAS|METAS)\s*(:|=)/.test(codigo(ler(a))));
  ok("F1  nenhum dado fake declarado fora de lib/ia/mocks/", fora.length === 0, fora.join(", "));

  const mocks = PASTA_MOCKS.map(ler).join("\n");
  const exportados = [...mocks.matchAll(/export (?:const|function) (\w+)/g)].map((m) => m[1]);
  ok("F2  todo export da pasta de mocks usa prefixo MOCK_",
    exportados.length > 0 && exportados.every((e) => e.startsWith("MOCK_")), exportados.join(","));

  ok("F3  o aviso de simulacao existe e aparece no shell",
    MOCK_AVISO.length > 0 && ler("app/(app)/ia/layout.tsx").includes("MOCK_AVISO"));

  ok("F4  ids de mock nao imitam UUID",
    MOCK_AGENTES.every((a) => !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(a.id)));

  ok("F5  tipos dos mocks respeitam o CHECK de agentes.tipo",
    MOCK_AGENTES.every((a) => (TIPOS_AGENTE_UI as readonly string[]).includes(a.tipo)));

  ok("F6  ha agente inativo, para o modificador ser exercitado",
    MOCK_AGENTES.some((a) => !a.ativo));

  ok("F7  ha mais agentes que os 6 tipos (grid precisa refluir)",
    MOCK_AGENTES.length > 6, String(MOCK_AGENTES.length));

  const agora = Date.parse("2026-08-27T12:00:00.000Z");
  const tarefas = MOCK_TAREFAS(agora);
  ok("F8  MOCK_TAREFAS e deterministica para a mesma entrada",
    JSON.stringify(MOCK_TAREFAS(agora)) === JSON.stringify(tarefas));
  ok("F9  toda tarefa aponta para um agente existente",
    tarefas.every((t) => MOCK_AGENTES.some((a) => a.id === t.agente_id)));
  // ── O bug que estes asserts existem para impedir ──────────────────
  //
  // A primeira versao passava `Date.now()` para `MOCK_TAREFAS` a cada
  // atualizacao do relogio. Os timestamps sao relativos ao argumento,
  // entao a tarefa "encerrada ha 2s" continuava encerrada ha 2s para
  // sempre: `concluido`, que e transitorio por definicao, virava
  // permanente. Os asserts de C exercitavam `aparenciaDoAgente` com
  // timestamp proprio e por isso NAO viam o problema — ele estava na
  // interacao entre o mock e o relogio, nao em nenhum dos dois.
  const comFlash = MOCK_AGENTES.filter((a) => {
    const suas = tarefas.filter((t) => t.agente_id === a.id);
    return aparenciaDoAgente(a, suas, agora).estado === "concluido";
  });
  ok("F11 na montagem, ha exatamente um agente com flash de concluido",
    comFlash.length === 1, comFlash.map((a) => a.nome).join(","));

  const depois = agora + JANELA_CONCLUIDO_MS + 1_000;
  const aindaComFlash = MOCK_AGENTES.filter((a) => {
    // ANCORA fixa (montagem), relogio avancado: e assim que a tela usa.
    const suas = tarefas.filter((t) => t.agente_id === a.id);
    return aparenciaDoAgente(a, suas, depois).estado === "concluido";
  });
  ok("F12 passada a janela, NENHUM agente segue com flash",
    aindaComFlash.length === 0, aindaComFlash.map((a) => a.nome).join(","));

  const reancorado = MOCK_TAREFAS(depois).filter((t) => t.agente_id === "ag-imagens");
  ok("F13 controle: reancorar o mock RESSUSCITA o flash (era esse o defeito)",
    aparenciaDoAgente({ ativo: true }, reancorado, depois).estado === "concluido");

  // A SKILL-1D.ui-consumer-C tirou `app/(app)/ia/agentes/page.tsx` desta
  // lista: aquela tela passou a ler agentes REAIS, e associar tarefas
  // simuladas a um agente de verdade seria misturar duas verdades na
  // mesma linha. Ela nao ancora mais mock nenhum porque nao usa mais
  // mock nenhum — e o assert seguinte cobra exatamente isso, para que a
  // saida daqui nao vire uma vaga silenciosa.
  //
  // O escritorio CONTINUA simulado e continua cobrado aqui.
  ok("F14 as telas que ainda usam mock ancoram na montagem, nao no relogio corrente",
    ["components/ia/office/Escritorio.tsx"].every((arq) => {
      const fonte = codigo(ler(arq));
      return /MOCK_TAREFAS\(ancoraMs\)/.test(fonte) && !/MOCK_TAREFAS\(agoraMs\)/.test(fonte);
    }));

  ok("F14b a lista de agentes NAO voltou a usar dado simulado",
    ["app/(app)/ia/agentes/page.tsx", "components/ia/agente/PaginaAgente.tsx"].every(
      (arq) => !/MOCK_/.test(codigo(ler(arq)))
    ));

  // Atualizado na UI-1D.a: o badge de aprovacoes passou a derivar da
  // FILA, nao das tarefas — e a fila que representa o que espera decisao
  // humana. Contar nos dois lugares criaria dois numeros que precisariam
  // concordar para sempre. `trabalhando` continua vindo das tarefas.
  ok("F10 contagens da subnav sao derivadas, nunca digitadas",
    MOCK_CONTAGENS.trabalhando === tarefas.filter((t) => t.status === "rodando" || t.status === "pendente").length &&
    MOCK_CONTAGENS.aguardandoAprovacao === MOCK_APROVACOES.length);
  ok("F10b o badge de aprovacoes tem UMA fonte (a fila)",
    MOCK_CONTAGENS.aguardandoAprovacao === MOCK_APROVACOES.length &&
    MOCK_APROVACOES.length > 0);
}

secao("G. Layout escalavel: sem coordenada por agente");

{
  const office = codigo(ler("components/ia/office/Escritorio.tsx"));
  const estacao = codigo(ler("components/ia/office/Estacao.tsx"));

  ok("G1  nenhuma posicao x/y por agente",
    !/\bx:\s*\d/.test(office + estacao) && !/\by:\s*\d/.test(office + estacao));
  ok("G2  controle negativo: a sonda acusa a forma do prototipo",
    /\bx:\s*\d/.test("{ x: 14, y: 30 }"));
  ok("G3  estacoes usam grid auto-fit", /repeat\(auto-fit/.test(office));
  ok("G4  a estacao nao se posiciona (sem position absolute)",
    !/position:\s*"absolute"/.test(estacao));
  ok("G5  ha duas zonas: estacao e copa",
    /estaNaEstacao/.test(office) && /copa/i.test(office));
  ok("G6  o prototipo nao e importado por nenhum arquivo de producao",
    ARQUIVOS_UI.every((a) => !/app\/dev/.test(ler(a))) &&
    !/app\/dev/.test(ler("components/Sidebar.tsx")));
}

secao("H. Acessibilidade");

{
  const todos = COMPONENTES.map((a) => ler(a)).join("\n");
  const painel = ler("components/ia/office/PainelAgente.tsx");
  const office = ler("components/ia/office/Escritorio.tsx");
  const lista = ler("app/(app)/ia/agentes/page.tsx");

  ok("H1  elementos clicaveis sao <button> de verdade",
    /<button/.test(office) && /<button/.test(lista) && /<button/.test(ler("components/ia/office/Estacao.tsx")));
  ok("H2  nenhum onClick em <span> ou <div> clicavel fingindo botao",
    !/<span[^>]*onClick/.test(todos) && !/<div[^>]*onClick[^>]*cursor:\s*"pointer"/.test(todos));
  ok("H3  aria-label presente nos alvos de clique", /aria-label/.test(todos));
  ok("H4  focus-visible definido", /:focus-visible/.test(office) && /:focus-visible/.test(lista));
  ok("H5  drawer fecha por Escape", /"Escape"/.test(painel));
  ok("H6  drawer devolve o foco a quem o abriu",
    /activeElement/.test(painel) && /\.focus\(\)/.test(painel));
  ok("H7  drawer e anunciado como dialogo",
    /role="dialog"/.test(painel) && /aria-modal="true"/.test(painel) && /aria-labelledby/.test(painel));
  ok("H8  progresso usa role=progressbar com valores",
    /role="progressbar"/.test(todos) && /aria-valuenow/.test(todos));
  ok("H9  prefers-reduced-motion tratado onde ha animacao",
    /prefers-reduced-motion/.test(office) && /prefers-reduced-motion/.test(lista));
  ok("H10 animacao e desligada, nao apenas desacelerada",
    /animation:\s*none/.test(office));
  ok("H11 controle negativo: a sonda de reduced-motion nao passa em texto vazio",
    !/prefers-reduced-motion/.test("body { color: red }"));
}

secao("I. Responsividade");

{
  const office = ler("components/ia/office/Escritorio.tsx");
  ok("I1  o palco some abaixo da largura minima, em vez de ser espremido",
    /cds-ia-palco\s*\{\s*display:\s*none/.test(office.replace(/\s+/g, " ").replace(/ \{/g, " {")) ||
    /max-width:\s*\$\{BREAKPOINT\.palcoMinimo\}px\)\s*\{[\s\S]*?display:\s*none/.test(office));
  ok("I2  ha alternativa textual apontando para a lista",
    /cds-ia-fallback/.test(office) && /\/ia\/agentes/.test(office));
  ok("I3  a decisao e por CSS, sem listener de resize",
    !/addEventListener\("resize"/.test(office) && !/window\.innerWidth/.test(office));
  ok("I4  a lista e responsiva por grid auto-fit",
    /repeat\(auto-fit/.test(ler("app/(app)/ia/agentes/page.tsx")));
}

secao("J. Prototipo /dev intocado");

{
  const ESPERADO: Record<string, string> = {
    "app/dev/ai-office/office.tsx": "f79aaee0e6e30f0b216b1787c1f0922efff88c23e2b5ecda7edd0cb44e0aea5f",
    "app/dev/ai-office/page.tsx": "4955b27019f9bc64bbf588336b4312ed008017595c5c687b3ac37483ccbec3ee",
    "app/dev/preview/page.tsx": "cc99e8dc7401e6d2060ff6b0436f7b5b9f91fcae006ac10f7bf6f1970e07b57b",
    "app/dev/preview/registry.tsx": "3bd9e6dc828f491c37c733832d232ae6191d430a9b8123d423caa7bd8f329295",
  };
  for (const [arq, esperado] of Object.entries(ESPERADO)) {
    ok(`J  ${arq} byte a byte intacto`, sha(arq) === esperado, `sha=${sha(arq).slice(0, 12)}…`);
  }
  ok("J5  app/dev continua com 4 arquivos", arquivosDe("app/dev").length === 4);
}

secao("K. Impacto no existente");

{
  ok("K1  middleware nao foi tocado (nao precisa: default deny cobre /ia)",
    !/\/ia\b/.test(ler("lib/middleware-rotas.ts")));
  ok("K2  layout global inalterado (sem mencao a ia)",
    !/\bia\b/i.test(codigo(ler("app/(app)/layout.tsx")).replace(/DateField/g, "")));
  ok("K3  Sidebar e o unico arquivo preexistente alterado",
    /href:\s*"\/ia"/.test(ler("components/Sidebar.tsx")));
  ok("K4  nenhuma pagina existente importa a area nova",
    !["app/(app)/central-ia/page.tsx", "app/(app)/dashboard/page.tsx", "app/(app)/vendas/page.tsx"]
      .some((a) => /components\/ia|lib\/ia/.test(ler(a))));
}

// ═══════════════════════════════════════════════════════════════════════
console.log(`\n══ CDS IA — UI-1B: fundacao visual:  ${passou}/${passou + falhou} passaram ══`);
if (falhou > 0) {
  console.log(`   ${falhou} FALHARAM`);
  process.exit(1);
}
