/**
 * CDS IA — F8.3-C1.5: configuracao 100% inline na pagina Agentes.
 *
 * Prova: nenhuma acao de configuracao navega para o assistente/Workspace;
 * Memoria (automatica + fixadas), APIs, Tools e Status agem na propria
 * pagina sobre contratos REAIS; o transporte de memoria manda um campo
 * por vez; impedimento leva a ABA certa; trocar de agente com rascunho
 * pede confirmacao; nada vaza entre agentes; Funcao segue so leitura.
 *
 * Rodar: npx tsx scripts/testar-agentes-config-inline.ts
 */
import "./_env-inerte";
import "./_server-only-inerte";

import { readFileSync } from "node:fs";
import { join } from "node:path";

require.extensions[".css"] = (m: NodeJS.Module) => {
  (m as unknown as { exports: unknown }).exports = new Proxy({}, { get: (_t, k) => String(k) });
};

let passou = 0;
let falhou = 0;
const ok = (nome: string, cond: boolean, det = ""): void => {
  if (cond) { passou += 1; console.log(`  PASS  ${nome}`); }
  else { falhou += 1; console.log(`  FAIL  ${nome}${det ? `  — ${det}` : ""}`); }
};
const secao = (t: string) =>
  console.log(`\n── ${t} ${"─".repeat(Math.max(2, 58 - t.length))}`);
const ler = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const semComentario = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const CONFIG = semComentario(ler("components/ia/agentes/ConfiguracaoDoAgente.tsx"));
const CARTAO = semComentario(ler("components/ia/agentes/CartaoDeAgente.tsx"));
const GESTAO = semComentario(ler("components/ia/agentes/GestaoDeAgentes.tsx"));
const SELETOR = semComentario(ler("components/ia/agentes/SeletorDeAgentes.tsx"));
const CHAT = semComentario(ler("components/ia/agentes/ChatNaGestao.tsx"));
const BUSCA = semComentario(ler("components/ia/factory/BuscaDeFerramentas.tsx"));
const APIS = semComentario(ler("components/ia/agentes/ApisDoAgente.tsx"));
const AREA = CONFIG + CARTAO + GESTAO + SELETOR + APIS;

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const M = "dddddddd-0000-4000-8000-000000000009";

type Chamada = { url: string; metodo: string; corpo: unknown };

async function main(): Promise<void> {
  console.log("\n══ CDS IA — F8.3-C1.5: configuração 100% inline ══");
  const { abaDoImpedimento, podeTrocarDeAgente } = await import("@/lib/ia/agentes-gestao");
  const http = await import("@/lib/ia/agentes-http");
  const { SEM_CONTRATO, SECOES } = await import("@/components/ia/agentes/ConfiguracaoDoAgente");

  // =====================================================================
  secao("A. Nenhuma navegacao externa de configuracao");
  ok("A1  nada aponta para o assistente (/configurar)", !/\/configurar/.test(AREA));
  ok("A2  a configuracao nao usa next/link (so age inline)", !/from "next\/link"|<Link\b/.test(CONFIG));
  ok("A3  sem 'Configurar Memória'", !/Configurar Mem/.test(AREA));
  ok("A4  sem 'configuração completa' / 'assistente' no menu", !/configuração completa|Configuração completa|assistente\)/.test(AREA));
  ok("A5  sem router/redirect/Workspace na configuracao",
    !/useRouter|router\.(push|replace)|window\.location\.(href|assign)|\/ia\/workspace|redirect\(/.test(CONFIG + CARTAO));
  ok("A6  o menu so tem navegacao de USO (Escritorio + tela cheia)",
    (CARTAO.match(/role="menuitem"/g) ?? []).length === 2 &&
      /href=\{`\/ia\?agente=\$\{agente\.id\}`\}/.test(CARTAO) && /href=\{`\/ia\/agentes\/\$\{agente\.id\}`\}/.test(CARTAO));
  ok("A7  Gerenciar (resumo) troca de ABA, nao de pagina",
    /onClick=\{\(\) => setSecao\("APIs"\)\}>\s*Gerenciar/.test(CONFIG) && /onClick=\{\(\) => setSecao\("Tools"\)\}>\s*Gerenciar/.test(CONFIG));
  ok("A8  Configurar (card) so seleciona o agente", /aoConfigurar=\{\(\) => selecionar\(v\.agente\.id\)\}/.test(GESTAO));
  ok("A9  seis abas mantidas", JSON.stringify(SECOES) === JSON.stringify(["Geral", "Modelo de IA", "APIs", "Tools", "Memória", "Status"]));

  // =====================================================================
  secao("B. Memoria inline (automatica + fixadas)");
  ok("B1  automatica: interruptor + definirMemoriaDoAgente", /definirMemoriaDoAgente\(agente\.id, v\)/.test(CONFIG));
  ok("B2  estado do motor exibido", /motorConfigurado \? "Disponível" : "Não configurada neste ambiente"/.test(CONFIG));
  ok("B3  lista real (listarMemoriasDoAgente)", /listarMemoriasDoAgente\(agente\.id\)/.test(CONFIG));
  ok("B4  criar (criarMemoriaDoAgente, conteudo + ordem)", /criarMemoriaDoAgente\(agente\.id, \{\s*conteudo: texto, ordem:/.test(CONFIG));
  ok("B5  editar TEXTO (PATCH conteudo)", /alterarMemoriaDoAgente\(agente\.id, editando\.id, \{ conteudo: texto \}\)/.test(CONFIG));
  ok("B6  ativar/desativar (PATCH ativo)", /alterarMemoriaDoAgente\(agente\.id, m\.id, \{ ativo: !m\.ativo \}\)/.test(CONFIG));
  ok("B7  excluir com confirmacao (2o clique)", /setExcluindo\(m\.id\)/.test(CONFIG) &&
    /Confirmar exclusão/.test(CONFIG) && /removerMemoriaDoAgente\(agente\.id, m\.id\)/.test(CONFIG));
  ok("B8  limite do dominio (MAX_CONTEUDO_DA_MEMORIA), sem numero solto",
    /maxLength=\{MAX_CONTEUDO_DA_MEMORIA\}/.test(CONFIG) && !/maxLength=\{2000\}|2000/.test(CONFIG));
  ok("B9  memoria vazia nao e gravada", /if \(texto === ""\) return;/.test(CONFIG) && /A memória não pode ficar vazia/.test(CONFIG));

  // =====================================================================
  secao("C. Transporte de memoria (fetch simulado)");
  const chamadas: Chamada[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    chamadas.push({ url: String(url), metodo: init?.method ?? "GET", corpo: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ ok: true, memoria: { id: M, conteudo: "x", tipo: null, ordem: 1, ativo: true } }),
      { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    const r1 = await http.alterarMemoriaDoAgente(A, M, { conteudo: "novo texto" });
    const r2 = await http.alterarMemoriaDoAgente(A, M, { ativo: false });
    ok("C1  editar texto: PATCH com SO {conteudo}", chamadas[0]?.metodo === "PATCH" &&
      JSON.stringify(chamadas[0]?.corpo) === JSON.stringify({ conteudo: "novo texto" }), JSON.stringify(chamadas[0]));
    ok("C2  ligar/desligar: PATCH com SO {ativo}", chamadas[1]?.metodo === "PATCH" &&
      JSON.stringify(chamadas[1]?.corpo) === JSON.stringify({ ativo: false }), JSON.stringify(chamadas[1]));
    ok("C3  rota da memoria DESTE agente", chamadas.every((c) => c.url.includes(`/${A}/memorias/${M}`)), chamadas.map((c) => c.url).join(" "));
    ok("C4  resposta parseada", r1.estado === "ok" && r2.estado === "ok");
  } finally {
    globalThis.fetch = original;
  }
  const ROTA = ler("app/api/agentes/[agenteId]/memorias/[memoriaId]/route.ts");
  ok("C5  contrato REAL: a rota ja aceitava conteudo (nada inventado)",
    /if \(typeof corpo\.conteudo === "string"\) mudanca\.conteudo/.test(ROTA));

  // =====================================================================
  secao("D. APIs inline (F8.3-C1.6: integracoes da CDS)");
  ok("D1  ML: adicionar/nivel/remover (no componente da aba APIs)",
    /adicionarPackAoAgente\(agenteId, integracao\.packId as string, null\)/.test(APIS) &&
      /adicionarPackAoAgente\(agenteId, pack\.id, n\)/.test(APIS) && /removerPackDoAgente\(agenteId, pack\.id\)/.test(APIS));
  // F9.2-A2: UMA conta por provider, pelo contrato de APIs.
  ok("D2  ML: conta do provider pelo contrato de APIs (sem sair da pagina)",
    /buscarApisDoAgente\(agenteId, c\.signal\)/.test(APIS) && /definirContaDaApi\(agenteId, /.test(APIS));
  ok("D3  externas vinculadas: nivel + remover", /definirPermissaoDeFerramentaExterna\(agenteId, e\.funcaoId, n\)/.test(APIS) &&
    /desvincularFerramentaExterna\(agenteId, e\.funcaoId\)/.test(APIS));
  ok("D4  sem busca generica de aplicativo na configuracao",
    !/BuscaDeFerramentas|Pesquisar aplicativo/.test(CONFIG + APIS));
  ok("D5  a configuracao usa o componente da aba APIs", /<ApisDoAgente\s+agenteId=\{agente\.id\}/.test(CONFIG));
  ok("D6  BuscaDeFerramentas voltou ao que era (sem apenasExternas)", !/apenasExternas/.test(BUSCA));
  ok("D7  sem ConexoesAgente (fora da paleta) na pagina Agentes", !/ConexoesAgente/.test(CONFIG + APIS));

  // =====================================================================
  secao("E. Tools inline");
  ok("E1  adicionar", /adicionarPackAoAgente\(agente\.id, p\.id, null\)/.test(CONFIG));
  ok("E2  nivel", /adicionarPackAoAgente\(agente\.id, f\.id, n\)/.test(CONFIG));
  ok("E3  remover", /removerPackDoAgente\(agente\.id, f\.id\)/.test(CONFIG));
  ok("E4  Tools sem packs de API (filtrarTools)", /filtrarTools\(termoTool, TOOL_PACKS\)/.test(CONFIG));

  // =====================================================================
  secao("F. Status inline + impedimento -> aba");
  ok("F1  ativar/desativar inline", /definirAtivacaoDoAgente\(agente\.id, v\)/.test(CONFIG));
  ok("F2  impedimento vira botao que troca de ABA", /abaDoImpedimento\(i\.codigo, ativacao\)/.test(CONFIG) &&
    /onClick=\{\(\) => setSecao\(aba\)\}/.test(CONFIG));
  const semPacks = { ferramentas: [] as never[] };
  const comMlIncompleto = { ferramentas: [{ id: "mercadolivre-perguntas", completo: false }] } as never;
  const comInternoIncompleto = { ferramentas: [{ id: "mercadolivre-perguntas", completo: false }, { id: "planilhas", completo: false }] } as never;
  const tabela: [string, unknown, string | null][] = [
    ["nome_ausente", semPacks, "Geral"], ["instrucoes_ausentes", semPacks, "Geral"],
    ["modelo_ausente", semPacks, "Modelo de IA"], ["ia_escolhida_indisponivel", semPacks, "Modelo de IA"],
    ["modelo_incompativel_com_ferramentas", semPacks, "Modelo de IA"],
    ["conexao_sem_loja", semPacks, "APIs"], ["ferramenta_externa_sem_permissao", semPacks, "APIs"],
    ["permissao_incompleta", comMlIncompleto, "APIs"], ["permissao_incompleta", comInternoIncompleto, "Tools"],
    ["skill_sem_ferramenta", semPacks, "Tools"], ["codigo_desconhecido", semPacks, null],
  ];
  for (const [codigo, ativ, aba] of tabela) {
    const r = abaDoImpedimento(codigo, ativ as never);
    ok(`F3  ${codigo}${codigo === "permissao_incompleta" ? (aba === "APIs" ? " (ML)" : " (interno)") : ""} -> ${aba ?? "sem botao"}`, r === aba, String(r));
  }
  const CODIGOS_SERVIDOR = [...new Set(ler("lib/agentes/factory/ativacao.ts").match(/codigo: "[a-z_]+"/g) ?? [])]
    .map((c) => c.slice(9, -1));
  ok("F4  todo codigo do servidor tem aba", CODIGOS_SERVIDOR.length >= 9 &&
    CODIGOS_SERVIDOR.every((c) => abaDoImpedimento(c, comInternoIncompleto) !== null), CODIGOS_SERVIDOR.join(","));

  // =====================================================================
  secao("G. Troca de agente: rascunho + reset + sem vazamento");
  let perguntou = 0;
  ok("G1  sem rascunho: troca direto, sem perguntar", podeTrocarDeAgente(false, () => { perguntou += 1; return false; }) && perguntou === 0);
  ok("G2  com rascunho + cancelar: NAO troca", !podeTrocarDeAgente(true, () => false));
  ok("G3  com rascunho + confirmar: troca", podeTrocarDeAgente(true, () => true));
  ok("G4  selecionar confere o rascunho ANTES de trocar",
    /const selecionar = \(id: string\) => \{\s*if \(id === selecionado\) return;\s*if \(!confirmarDescarte\(\)\) return;\s*setSelecionado\(id\);/.test(GESTAO));
  ok("G5  voltar do navegador tambem confere (e restaura a URL)",
    /aoVoltar[\s\S]{0,300}podeTrocarDeAgente\(rascunhoRef\.current[\s\S]{0,200}gravarSelecaoNaUrl\(selecionadoRef\.current\)/.test(GESTAO));
  ok("G6  rascunho cobre Geral, nova memoria e memoria em edicao",
    /const temRascunho = alteracoesGerais \|\| novaMemoria\.trim\(\) !== "" \|\|[\s\S]{0,140}editando\.texto\.trim\(\) !== memoriaEmEdicao\.conteudo/.test(CONFIG));
  ok("G7  configuracao avisa a pagina (e limpa ao desmontar)",
    /aoAlterarRascunho\?\.\(temRascunho\)/.test(CONFIG) && /useEffect\(\(\) => \(\) => aoAlterarRascunho\?\.\(false\)/.test(CONFIG) &&
      /aoAlterarRascunho=\{aoAlterarRascunho\}/.test(GESTAO));
  ok("G8  editores resetam por agente (key por id na configuracao)", /<ConfiguracaoDoAgente\s+key=\{`cfg:\$\{aberto\.agente\.id\}`\}/.test(GESTAO));
  ok("G9  todo estado de edicao e LOCAL da configuracao (morre no remount)",
    /useState\(""\)/.test(CONFIG) && /useState<\{ id: string; texto: string \} \| null>\(null\)/.test(CONFIG) &&
      !/novaMemoria|editando/.test(GESTAO));
  const RX = /(?:adicionarPackAoAgente|removerPackDoAgente|definir\w+|desvincular\w+|atualizarAgenteViaApi|criarMemoriaDoAgente|alterarMemoriaDoAgente|removerMemoriaDoAgente|listarMemoriasDoAgente|lerAtivacaoDoAgente|lerMemoriaDoAgente|buscarConexoesDoAgente|buscarApisDoAgente)\(([^,)]+)/g;
  const escritas = CONFIG.match(RX) ?? [];
  const escritasApis = APIS.match(RX) ?? [];
  ok("G10 toda leitura/escrita da configuracao usa o id do agente aberto (sem vazamento)",
    escritas.length >= 12 && escritas.every((e) => /\(agente\.id$/.test(e)) &&
      // F9.2-A2: o par conexoes (ler + gravar) virou o par APIs
      // (`buscarApisDoAgente` entrou no RX; `definir\w+` ja cobre a escrita).
      escritasApis.length >= 7 && escritasApis.every((e) => /\(agenteId$/.test(e)) &&
      /<ApisDoAgente\s+agenteId=\{agente\.id\}/.test(CONFIG),
    [...escritas, ...escritasApis].filter((e) => !/\((agente\.id|agenteId)$/.test(e)).join(" | "));
  ok("G11 releitura amarrada ao agente", /\}, \[agente\.id\]\);/.test(CONFIG));

  // =====================================================================
  secao("H. Contratos ausentes / so leitura");
  ok("H1  Funcao so leitura, com a frase padrao", /readOnly aria-readonly="true" title=\{SEM_CONTRATO\}/.test(CONFIG) &&
    SEM_CONTRATO === "Esta configuração ainda não pode ser alterada aqui.");
  ok("H2  Geral salva SO nome e instrucoes", /atualizarAgenteViaApi\(agente\.id, \{ nome: nome\.trim\(\), instrucoes \}\)/.test(CONFIG));

  // =====================================================================
  secao("I. Chat e Office intocados");
  ok("I1  ChatNaGestao segue o host fino", /<ChatDoAgente\s+key=\{`\$\{agenteId\}:\$\{geracao\}`\}/.test(CHAT) && !/rascunho/i.test(CHAT));
  const OFFICE = ["components/ia/office/Escritorio.tsx", "components/ia/office/OfficeSceneV1.tsx",
    "components/ia/office/OfficeAgentPanelV1.tsx", "components/ia/office/OfficeChatHost.tsx",
    "components/ia/office/GerenciarFerramentas.tsx"];
  ok("I2  Office nao importa a area Agentes", OFFICE.every((f) => !/components\/ia\/agentes\//.test(ler(f))));
  // O Office (GerenciarFerramentas, F8.2) ja usava a busca: segue no modo padrao.
  ok("I3  Office segue com a busca COMPLETA (sem apenasExternas)", OFFICE.every((f) => !/apenasExternas/.test(ler(f))));

  console.log(`\n── placar ${"─".repeat(50)}\n  PASS ${passou}   FAIL ${falhou}\n`);
  if (falhou > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
