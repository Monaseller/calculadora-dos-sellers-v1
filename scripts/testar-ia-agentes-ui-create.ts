/**
 * CDS IA — SKILL-1D.agent-create-ui-B. Suite da criacao visual de agente.
 *
 * A pergunta central desta suite e uma so: **o que sai daqui pela rede?**
 *
 * A criacao e a primeira ESCRITA que a interface dispara. Um corpo com
 * uma chave a mais nao quebra teste nenhum, nao aparece na tela e so se
 * revela no dia em que o servidor mudar de opiniao sobre confiar no
 * cliente. Por isso o corpo efetivo e medido chave a chave, e o
 * cenario de mass assignment passa um objeto de origem cheio de campos
 * privilegiados so para provar que nenhum deles atravessa.
 *
 * As funcoes REAIS do transporte rodam contra um `fetch` duplado que
 * guarda url, metodo, headers e corpo. Nenhum banco, nenhum servidor,
 * nenhuma escrita real — a primeira criacao de verdade e gate proprio.
 *
 * Rodar:  npx tsx scripts/testar-ia-agentes-ui-create.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { TIPOS_AGENTE_UI } from "../lib/ia/contratos";
import { DESCRICAO_TIPO } from "../lib/ia/conceitos";
import { CORES_TIPO } from "../lib/ia/design";

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
const DIALOGO = "components/ia/agente/CriarAgente.tsx";
const LISTA = "app/(app)/ia/agentes/page.tsx";

const CODIGO_TRANSPORTE = codigo(ler(TRANSPORTE));
const CODIGO_DIALOGO = codigo(ler(DIALOGO));
const CODIGO_LISTA = codigo(ler(LISTA));

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

console.log("\n══ CDS IA — SKILL-1D.agent-create-ui-B: criacao visual ══");

// ─── A. Estrutura ─────────────────────────────────────────────────────

secao("A. A escrita mora num lugar so");

{
  const comPost = AREA.filter((a) => /"POST"|method:\s*"POST"/.test(codigo(ler(a))));
  ok("A1  exatamente UM arquivo da area faz POST",
    JSON.stringify(comPost) === JSON.stringify([TRANSPORTE]), comPost.join(", "));
  ok("A2  e e o mesmo boundary de rede de sempre",
    /\bfetch\s*\(/.test(CODIGO_TRANSPORTE) && !/\bfetch\s*\(/.test(CODIGO_DIALOGO) &&
      !/\bfetch\s*\(/.test(CODIGO_LISTA));
  ok("A3  uma unica escrita publicada — nem PUT, nem PATCH, nem DELETE",
    (CODIGO_TRANSPORTE.match(/method:\s*"POST"/g) ?? []).length === 1 &&
      !/"PUT"|"PATCH"|"DELETE"/.test(CODIGO_TRANSPORTE));
  ok("A4  o nome do dominio continua reservado ao servidor",
    /export async function criarAgenteViaApi\(/.test(CODIGO_TRANSPORTE) &&
      !/export async function criarAgente\(/.test(CODIGO_TRANSPORTE));
  ok("A5  o corpo e montado campo a campo, nunca do formulario inteiro",
    /nome: dados\.nome/.test(CODIGO_TRANSPORTE) &&
      !/JSON\.stringify\(dados\)|JSON\.stringify\(form/.test(CODIGO_TRANSPORTE) &&
      !/\.\.\.\s*dados/.test(CODIGO_TRANSPORTE));
  ok("A6  a criacao nao aceita sinal de cancelamento",
    !/criarAgenteViaApi\([^)]*signal/.test(CODIGO_TRANSPORTE));
  ok("A7  ANCORA: a varredura leu a area", AREA.length > 40, String(AREA.length));
}

secao("B. O dialogo pede tres coisas, e nenhuma a mais");

{
  ok("B1  e Client Component", /^"use client"/.test(ler(DIALOGO)));
  ok("B2  tem formulario com submit", /<form onSubmit=/.test(CODIGO_DIALOGO));
  ok("B3  campo de nome", /<input[\s\S]{0,200}value=\{nome\}/.test(CODIGO_DIALOGO));
  ok("B4  select de tipo", /<select[\s\S]{0,200}value=\{tipo\}/.test(CODIGO_DIALOGO));
  ok("B5  textarea de instrucoes", /<textarea[\s\S]{0,200}value=\{instrucoes\}/.test(CODIGO_DIALOGO));
  ok("B6  botao de envio", /type="submit"/.test(CODIGO_DIALOGO));

  ok("B7  o select vem da autoridade, sem lista literal duplicada",
    /TIPOS_AGENTE_UI\.map/.test(CODIGO_DIALOGO) &&
      !/"personalizado"|"mensagens"|"ads"|"fotos"|"anuncios"|"financeiro"|"gerente"/
        .test(CODIGO_DIALOGO));
  ok("B8  o rotulo vem de DESCRICAO_TIPO, e o VALOR e o tipo canonico",
    /value=\{t\}/.test(CODIGO_DIALOGO) && /DESCRICAO_TIPO\[t\]/.test(CODIGO_DIALOGO));

  // ── O setimo perfil (SKILL-1D.agent-custom-type-B) ────────────────
  //
  // `personalizado` existe para que criar um agente nao obrigue a
  // escolher, no primeiro segundo, uma funcao que o dono ainda nao sabe
  // qual e. Ele e o PRIMEIRO da autoridade, e e por isso — e so por
  // isso — que aparece selecionado: nao ha `setTipo("personalizado")`
  // em lugar nenhum.
  ok("B7a a autoridade tem exatamente sete perfis",
    TIPOS_AGENTE_UI.length === 7, String(TIPOS_AGENTE_UI.length));
  ok("B7b `personalizado` e o primeiro — logo, o estado inicial",
    TIPOS_AGENTE_UI[0] === "personalizado" &&
      /useState<TipoAgenteUI>\(TIPOS_AGENTE_UI\[0\]\)/.test(CODIGO_DIALOGO));
  ok("B7c e o default NAO vem de logica paralela",
    !/setTipo\("personalizado"\)|=== "personalizado"/.test(CODIGO_DIALOGO));
  ok("B7d ele tem descricao propria, e as outras seis nao mudaram",
    DESCRICAO_TIPO.personalizado === "Propósito definido por você" &&
      DESCRICAO_TIPO.mensagens === "Atendimento ao comprador");
  ok("B7e e cor propria, neutra, sem tocar as seis de identidade",
    CORES_TIPO.personalizado === "#8b93a5" && CORES_TIPO.mensagens === "#4a9de8");
  ok("B7f toda a autoridade tem descricao e cor",
    TIPOS_AGENTE_UI.every((t) => DESCRICAO_TIPO[t]?.length > 0 && CORES_TIPO[t]?.length > 0));
  ok("B7g o campo se chama `Perfil inicial` na tela, e `tipo` no contrato",
    /<span className="cds-ia-criar-rotulo">Perfil inicial<\/span>/.test(CODIGO_DIALOGO) &&
      !/>Tipo</.test(CODIGO_DIALOGO) && /tipo,/.test(CODIGO_DIALOGO));
  ok("B7h a ajuda diz que o perfil nao limita capacidade",
    /O perfil inicial não limita as capacidades do agente\./.test(CODIGO_DIALOGO) &&
      /aria-describedby=\{AJUDA_ID\}/.test(CODIGO_DIALOGO));
  ok("B7i zero <option> escrito a mao fora do map",
    (CODIGO_DIALOGO.match(/<option/g) ?? []).length === 1);

  ok("B9  zero campo prematuro",
    !/value=\{(modelo|temperatura|tools?|funcao|skill|fonte|conexao|permissao|memoria|avatar|cor|icone|agenda|budget)\}/i
      .test(CODIGO_DIALOGO));
  ok("B10 zero controle de dono, id, ativo ou datas",
    !/value=\{(userId|uid|user_id|id|ativo|criado_em|atualizado_em)\}/.test(CODIGO_DIALOGO));

  ok("B11 acessibilidade no padrao do painel existente",
    /role="dialog"/.test(CODIGO_DIALOGO) && /aria-modal="true"/.test(CODIGO_DIALOGO) &&
      /aria-labelledby=/.test(CODIGO_DIALOGO));
  ok("B12 Escape fecha, e devolve o foco a quem abriu",
    /evento\.key !== "Escape"/.test(CODIGO_DIALOGO) && /anterior\.focus\(\)/.test(CODIGO_DIALOGO));
  ok("B13 mas NAO fecha enquanto a escrita esta em voo",
    /if \(enviandoRef\.current\) return;/.test(CODIGO_DIALOGO) &&
      /if \(!enviando\) onFechar\(\)/.test(CODIGO_DIALOGO));

  ok("B14 envio duplo fechado no botao",
    /disabled=\{enviando \|\| !nomeValido\}/.test(CODIGO_DIALOGO));
  ok("B15 e tambem no handler, antes de qualquer render",
    /if \(enviandoRef\.current \|\| !nomeValido\) return;/.test(CODIGO_DIALOGO));
  ok("B16 nome obrigatorio por trim, sem regra alem da do servidor",
    /nome\.trim\(\) !== ""/.test(CODIGO_DIALOGO));
  ok("B17 instrucoes vazias viram null, explicitamente",
    /instrucoes\.trim\(\) === "" \? null : instrucoes\.trim\(\)/.test(CODIGO_DIALOGO));
  ok("B18 o dialogo nao navega e nao conhece rota",
    !/useRouter|router\.|next\/navigation|next\/link/.test(CODIGO_DIALOGO));
  ok("B19 e nao conhece mock nenhum", !/MOCK_/.test(CODIGO_DIALOGO));
}

secao("C. A lista abre a criacao — e so ela decide a lista");

{
  ok("C1  ha CTA quando a lista esta vazia",
    /Criar primeiro agente/.test(CODIGO_LISTA));
  ok("C2  e ha CTA quando ja existem agentes",
    /Criar agente/.test(CODIGO_LISTA));
  ok("C3  os dois abrem o MESMO dialogo",
    (CODIGO_LISTA.match(/setCriando\(true\)/g) ?? []).length === 2 &&
      (CODIGO_LISTA.match(/<CriarAgente/g) ?? []).length === 1);
  ok("C4  o sucesso insere o objeto que o servidor devolveu",
    /agentes: \[\.\.\.atual\.agentes, novo\]/.test(CODIGO_LISTA));
  ok("C5  sem segunda leitura, sem reload, sem navegacao automatica",
    !/listarAgentes\(\)[\s\S]{0,80}aoCriar|router\.|location\.reload|window\.location/.test(CODIGO_LISTA));
  ok("C6  a lista nao inventa id, ativo nem data para o novo agente",
    !/id:\s*(crypto|randomUUID|`)|ativo:\s*true|criado_em:\s*new Date/.test(CODIGO_LISTA));
  ok("C7  e continua sem mock", !/MOCK_/.test(CODIGO_LISTA));
}

// ─── D–F. O transporte REAL, contra um fetch duplado ──────────────────

interface Chamada { url: string; init?: RequestInit }
let chamadas: Chamada[] = [];
let proxima: { status: number; corpo: unknown } | "erro" = { status: 201, corpo: null };

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

const UUID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const agenteCriado = (extra: Record<string, unknown> = {}) => ({
  id: UUID, nome: "Atendimento", tipo: "mensagens", instrucoes: null,
  ativo: true, criado_em: "2026-08-29T12:00:00.000Z", ...extra,
});
const corpoEnviado = (): Record<string, unknown> =>
  JSON.parse(String(chamadas[0]?.init?.body ?? "{}"));

async function principal(): Promise<void> {
  const { criarAgenteViaApi } = await import("../lib/ia/agentes-http");

  secao("D. A requisicao: metodo, endereco e corpo exato");

  responde(201, { ok: true, agente: agenteCriado() });
  const r = await criarAgenteViaApi({ nome: "Atendimento", tipo: "mensagens", instrucoes: null });

  ok("D1  201 -> ok com o agente criado", r.estado === "ok");
  ok("D2  metodo POST", chamadas[0]?.init?.method === "POST", String(chamadas[0]?.init?.method));
  ok("D3  endereco publicado", chamadas[0]?.url === "/api/agentes", chamadas[0]?.url);
  ok("D4  UM header, e so o necessario para o corpo",
    JSON.stringify(chamadas[0]?.init?.headers) === JSON.stringify({ "Content-Type": "application/json" }),
    JSON.stringify(chamadas[0]?.init?.headers));
  ok("D5  `credentials` omitido", chamadas[0]?.init?.credentials === undefined);
  ok("D6  zero sinal de cancelamento numa escrita", chamadas[0]?.init?.signal === undefined);
  ok("D7  o corpo tem EXATAMENTE tres chaves",
    JSON.stringify(Object.keys(corpoEnviado()).sort()) ===
      JSON.stringify(["instrucoes", "nome", "tipo"]),
    JSON.stringify(Object.keys(corpoEnviado()).sort()));
  ok("D8  e os valores sao os enviados",
    corpoEnviado().nome === "Atendimento" && corpoEnviado().tipo === "mensagens" &&
      corpoEnviado().instrucoes === null);
  ok("D9  o agente devolvido e o do servidor, com uuid dele",
    r.estado === "ok" && r.agente.id === UUID && r.agente.ativo === true);

  // O setimo perfil atravessa o transporte pelo MESMO caminho: nao ha
  // ramo, nao ha tratamento proprio, e o parser da lista o aceita como
  // aceita qualquer outro.
  responde(201, { ok: true, agente: agenteCriado({ tipo: "personalizado", nome: "Meu agente" }) });
  const rPers = await criarAgenteViaApi({
    nome: "Meu agente", tipo: "personalizado", instrucoes: "Cuidar do que eu pedir.",
  });
  ok("D10 POST com `personalizado` -> ok, sem ramo especial",
    rPers.estado === "ok" && rPers.agente.tipo === "personalizado");
  ok("D11 e o corpo continua com as mesmas tres chaves",
    JSON.stringify(Object.keys(corpoEnviado()).sort()) ===
      JSON.stringify(["instrucoes", "nome", "tipo"]) &&
      corpoEnviado().tipo === "personalizado");
  ok("D12 zero branch por perfil no transporte",
    !/=== "personalizado"|personalizado\s*\?/.test(CODIGO_TRANSPORTE));

  const { listarAgentes } = await import("../lib/ia/agentes-http");
  responde(200, { ok: true, agentes: [agenteCriado({ tipo: "personalizado" })] });
  const lPers = await listarAgentes();
  ok("D13 a listagem parseia `personalizado` sem shape novo",
    lPers.estado === "ok" && lPers.agentes.length === 1 &&
      lPers.agentes[0].tipo === "personalizado");

  responde(200, { ok: true, agentes: [agenteCriado({ tipo: "custom" })] });
  ok("D14 e continua recusando um perfil fora da autoridade",
    (await listarAgentes()).estado === "falha");

  secao("E. Mass assignment: o que o cliente pede nao vira coluna");

  // Uma origem "contaminada" — como um objeto de formulario que ganhou
  // chaves com o tempo. A tipagem sozinha nao e prova: o que se mede e o
  // corpo que SAIU.
  const contaminado = {
    nome: "Invasor",
    tipo: "gerente",
    instrucoes: "instrucoes legitimas",
    user_id: "B", userId: "B", uid: "B",
    id: "00000000-dead-4bee-8000-000000000000",
    ativo: false,
    criado_em: "1999-01-01T00:00:00.000Z",
    atualizado_em: "1999-01-01T00:00:00.000Z",
    agoraMs: 123,
    Authorization: "Bearer nao-deve-viajar",
    token: "nao-deve-viajar",
  } as unknown as { nome: string; tipo: "gerente"; instrucoes: string | null };

  responde(201, { ok: true, agente: agenteCriado({ nome: "Invasor", tipo: "gerente" }) });
  await criarAgenteViaApi(contaminado);

  const enviado = corpoEnviado();
  ok("E1  o corpo continua com TRES chaves",
    JSON.stringify(Object.keys(enviado).sort()) === JSON.stringify(["instrucoes", "nome", "tipo"]),
    JSON.stringify(Object.keys(enviado).sort()));
  for (const proibida of [
    "user_id", "userId", "uid", "id", "ativo", "criado_em", "atualizado_em",
    "agoraMs", "Authorization", "token",
  ]) {
    ok(`E2  \`${proibida}\` nao atravessou`, !(proibida in enviado));
  }
  ok("E3  e nada disso vazou por header tampouco",
    JSON.stringify(chamadas[0]?.init?.headers) === JSON.stringify({ "Content-Type": "application/json" }));

  secao("F. Cada resposta no seu lugar");

  for (const [nome, status, corpo, esperado] of [
    ["F1  400 nome invalido", 400, { ok: false, erro: "nome inválido." }, "dados_invalidos"],
    ["F2  400 tipo invalido", 400, { ok: false, erro: "tipo inválido." }, "dados_invalidos"],
    ["F3  400 corpo invalido", 400, { ok: false, erro: "Corpo da requisição inválido (JSON esperado)." }, "dados_invalidos"],
    ["F4  401", 401, { ok: false, erro: "Não autenticado." }, "nao_autenticado"],
    ["F5  500", 500, { ok: false, erro: "Falha ao criar o agente." }, "falha"],
    ["F6  corpo ilegivel", 201, "ilegivel", "falha"],
    ["F7  201 sem `ok`", 201, { agente: agenteCriado() }, "falha"],
    ["F8  201 sem agente", 201, { ok: true }, "falha"],
    ["F9  201 com agente parcial", 201, { ok: true, agente: { id: UUID, nome: "x" } }, "falha"],
    ["F10 201 com tipo fora do vocabulario", 201, { ok: true, agente: agenteCriado({ tipo: "vendedor" }) }, "falha"],
  ] as [string, number, unknown, string][]) {
    responde(status, corpo);
    const res = await criarAgenteViaApi({ nome: "x", tipo: "mensagens", instrucoes: null });
    ok(`${nome} -> ${esperado}`, res.estado === esperado, res.estado);
  }

  proxima = "erro";
  chamadas = [];
  ok("F11 rede caida -> falha, sem excecao vazando",
    (await criarAgenteViaApi({ nome: "x", tipo: "mensagens", instrucoes: null })).estado === "falha");

  // A mensagem que a tela mostra e SEMPRE uma frase nossa.
  responde(400, { ok: false, erro: "nome inválido." });
  const conhecida = await criarAgenteViaApi({ nome: "", tipo: "mensagens", instrucoes: null });
  ok("F12 mensagem publicada atravessa como esta",
    conhecida.estado === "dados_invalidos" && conhecida.mensagem === "nome inválido.");

  responde(400, { ok: false, erro: "violates check constraint agentes_tipo_valido" });
  const desconhecida = await criarAgenteViaApi({ nome: "x", tipo: "mensagens", instrucoes: null });
  ok("F13 mensagem DESCONHECIDA vira generica — nada de texto de banco na tela",
    desconhecida.estado === "dados_invalidos" &&
      !/constraint|agentes_tipo_valido|violates/i.test(desconhecida.mensagem),
    desconhecida.estado === "dados_invalidos" ? desconhecida.mensagem : desconhecida.estado);

  globalThis.fetch = fetchOriginal;

  console.log(`\n══ ${passou} PASS / ${falhou} FAIL ══\n`);
  process.exitCode = falhou === 0 ? 0 : 1;
}

principal().catch((e) => {
  globalThis.fetch = fetchOriginal;
  console.log(`  FAIL  excecao nao tratada — ${String(e).slice(0, 300)}`);
  process.exitCode = 1;
});
