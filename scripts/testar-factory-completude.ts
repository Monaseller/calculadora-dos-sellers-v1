/**
 * AGENT-FACTORY-F7b.4.8 — dependencia de Skill, prontidao e retomada.
 *
 * Suite PURA: sem rede, sem banco, sem IA.
 *
 * ── O que ela cerca ─────────────────────────────────────────────────
 *
 *   §3/§4  a dependencia vem da DECLARACAO da Skill, e nao do texto dela
 *   §9/§11 a prontidao reprova o que falta, com frase de gente
 *   §15–§19 a retomada cita a conversa anterior e nao se repete
 *   §20/§26 o rotulo nao chama de Mercado Livre o que le a base da CDS
 *   §28    leitura nao pede aprovacao
 *
 * Roda com: npx tsx scripts/testar-factory-completude.ts
 */
import "./_server-only-inerte";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  capacidadeFaltanteDeSkill, capacidadesPedidasNoTexto,
} from "../lib/agentes/factory/capacidade-faltante";
import { validarParaAtivacao } from "../lib/agentes/factory/ativacao";
import {
  assuntoDaMensagem, frasesDeRetomada, LIMITE_ASSUNTO, LIMITE_RETOMADA,
} from "../lib/agentes/conversas/retomada-resumo";
import { TOOL_PACKS, packDaFuncao } from "../lib/agentes/factory/catalogo-ui";
import { nomeDaPlataforma, NOME_DA_PLATAFORMA } from "../lib/agentes/conexoes/estado";
import { efeitoDaFuncaoInterna, exigeConfirmacao } from "../lib/agentes/factory/efeito";
import {
  CATEGORIAS_DE_BLOQUEIO, CODIGOS_CORRIGIVEIS, MENSAGEM_POR_CATEGORIA,
  categoriaDoBloqueio, classificarFalha,
} from "../lib/agentes/ia/falhas-de-ferramenta";
import { semCamposNulos } from "../lib/agentes/ia/argumentos-do-modelo";

let pass = 0;
let fail = 0;
function ok(nome: string, cond: boolean, detalhe = ""): void {
  if (cond) { pass += 1; console.log(`  PASS  ${nome}`); }
  else { fail += 1; console.log(`  FAIL  ${nome}${detalhe ? `  — ${detalhe}` : ""}`); }
}
function secao(t: string): void { console.log(`\n${t}`); }

function fonte(rel: string): string {
  return readFileSync(join(__dirname, "..", rel), "utf8");
}
function semComentarios(f: string): string {
  return f.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*/g, "$1");
}

/** Um agente minimo que ATIVA — a base contra a qual se mede o resto. */
const BASE = {
  nome: "Financeiro",
  instrucoes: "Ajude com financas.",
  provedor: "anthropic",
  permissoes: [] as readonly { funcaoId: string; nivel: string }[],
};

console.log("══ F7b.4.8 — completude da Factory ══");

// ─── A. A dependencia e DECLARADA, nao adivinhada — §3/§4 ─────────────

secao("A. A Skill declara; o texto dela nao decide — §3/§4");

{
  const skillComML = {
    manifesto: { id: "financeiro", requer: { funcoes: ["mercadolivre.vendas.consultar"] } },
  };

  const semNada = capacidadeFaltanteDeSkill({
    skills: [skillComML], funcoesPermitidas: [],
  });
  ok("A1  a Skill que declara ML num agente sem ML acusa falta",
    semNada !== null, String(semNada));
  ok("A2  e a oferta e o pack Mercado Livre, pelo NOME",
    semNada?.opcao.chave === "mercadolivre-perguntas" &&
      semNada?.opcao.nome === "Mercado Livre",
    `${semNada?.opcao.chave}/${semNada?.opcao.nome}`);
  ok("A3  a oferta diz que exige conexao",
    semNada?.opcao.exigeConexao === true);
  ok("A4  e aponta QUAL Skill pediu", semNada?.skillId === "financeiro");

  const jaTem = capacidadeFaltanteDeSkill({
    skills: [skillComML], funcoesPermitidas: ["mercadolivre.vendas.consultar"],
  });
  ok("A5  com a Funcao permitida, nada falta", jaTem === null);

  // `bloqueado` NAO conta como ter: quem chama filtra antes, e a suite
  // prova o contrato — a lista recebida e de Funcoes UTILIZAVEIS.
  const skillOpcional = {
    manifesto: { id: "atendimento", requer: { funcoes_opcionais: ["planilha.ler"] } },
  } as unknown as { manifesto: { id: string; requer?: { funcoes?: readonly string[] } } };
  ok("A6  requisito OPCIONAL nao abre cartao — limita, nao impede",
    capacidadeFaltanteDeSkill({ skills: [skillOpcional], funcoesPermitidas: [] }) === null);

  // Funcao exigida fora de qualquer pack nao tem oferta possivel.
  const skillOrfa = {
    manifesto: { id: "orfa", requer: { funcoes: ["funcao.que.nao.existe"] } },
  };
  ok("A7  Funcao sem pack nao vira cartao sem botao",
    capacidadeFaltanteDeSkill({ skills: [skillOrfa], funcoesPermitidas: [] }) === null);

  // §4: o CORPO da Skill nao participa. A prova estrutural e que a
  // funcao so olha `manifesto.requer` — nunca `corpo`.
  const CODIGO = semComentarios(fonte("lib/agentes/factory/capacidade-faltante.ts"));
  const corpoDaFuncao = CODIGO.slice(
    CODIGO.indexOf("export function capacidadeFaltanteDeSkill"),
    CODIGO.indexOf("export async function detectarCapacidadeFaltante"));
  ok("A8  o detector de Skill le `requer`, e nao o corpo dela",
    /requer\?\.funcoes/.test(corpoDaFuncao) && !/\bcorpo\b/.test(corpoDaFuncao));
  ok("A9  e NAO le `funcoes_opcionais` — requisito opcional nao bloqueia",
    !/funcoes_opcionais/.test(corpoDaFuncao));
  ok("A10 ANCORA: a sonda leu a funcao certa", corpoDaFuncao.length > 200);
}

// ─── B. A prontidao reprova o que falta — §9/§11 ─────────────────────

secao("B. A prontidao reprova, com frase de gente — §9/§11");

{
  const pronto = validarParaAtivacao(BASE);
  ok("B1  ANCORA: o agente base ATIVA", pronto.podeAtivar, JSON.stringify(pronto.impedimentos));

  const comDependencia = validarParaAtivacao({
    ...BASE,
    dependenciasDeSkill: [
      { skillId: "financeiro", nome: "Mercado Livre", tipo: "funcao", bloqueia: true },
    ],
  });
  ok("B2  dependencia de Skill BLOQUEIA a ativacao", !comDependencia.podeAtivar);
  ok("B3  com o codigo proprio",
    comDependencia.impedimentos.some((i) => i.codigo === "skill_sem_ferramenta"));
  // A sonda procura um IDENTIFICADOR pontuado (`a.b`), e nao "ponto":
  // a primeira versao proibia o caractere `.` e reprovava por causa do
  // ponto final da frase — media pontuacao, e nao vazamento de id.
  const PARECE_ID = /[a-z_]+\.[a-z_]+/;
  ok("B4  a frase nomeia a capacidade, e nao `funcao_id`",
    comDependencia.impedimentos.some((i) =>
      i.mensagem.includes("Mercado Livre") && !PARECE_ID.test(i.mensagem)),
    comDependencia.impedimentos.map((i) => i.mensagem).join(" | "));
  ok("B4a ANCORA: a sonda ACUSA um `funcao_id` de verdade",
    PARECE_ID.test("precisa de mercadolivre.vendas.consultar.") &&
      !PARECE_ID.test("precisa de Mercado Livre."));
  ok("B5  e leva para a etapa de Ferramentas",
    comDependencia.impedimentos.find((i) => i.codigo === "skill_sem_ferramenta")?.etapa === 4);

  // Opcional NAO bloqueia: barrar um agente util seria o erro oposto.
  const opcional = validarParaAtivacao({
    ...BASE,
    dependenciasDeSkill: [
      { skillId: "atendimento", nome: "Planilhas", tipo: "funcao", bloqueia: false },
    ],
  });
  ok("B6  dependencia OPCIONAL nao bloqueia", opcional.podeAtivar,
    JSON.stringify(opcional.impedimentos));

  const semLoja = validarParaAtivacao({
    ...BASE, conexoesSemLoja: [{ nome: "Mercado Livre" }],
  });
  ok("B7  requisito de conexao SEM loja bloqueia", !semLoja.podeAtivar);
  ok("B8  com codigo PROPRIO — resolve-se em outro lugar",
    semLoja.impedimentos.some((i) => i.codigo === "conexao_sem_loja"));
  ok("B9  e a frase pede ESCOLHER, nao conectar",
    semLoja.impedimentos.some((i) =>
      /Escolha a loja/i.test(i.mensagem) && !/conect/i.test(i.mensagem)),
    semLoja.impedimentos.map((i) => i.mensagem).join(" | "));
  ok("B10 CONTROLE: sem os dois campos, os dois codigos nao aparecem",
    !pronto.impedimentos.some((i) =>
      i.codigo === "skill_sem_ferramenta" || i.codigo === "conexao_sem_loja"));

  // §12: as telas administrativas nao sao requisito. A prova possivel
  // aqui e estrutural: todo impedimento aponta para uma ETAPA do wizard,
  // e nao para uma rota administrativa.
  const todos = validarParaAtivacao({
    ...BASE, nome: "", instrucoes: "", provedor: "",
    dependenciasDeSkill: [
      { skillId: "s", nome: "Mercado Livre", tipo: "funcao", bloqueia: true },
    ],
    conexoesSemLoja: [{ nome: "Mercado Livre" }],
  });
  ok("B11 TODO impedimento aponta para uma etapa do wizard (1..11)",
    todos.impedimentos.length >= 5 &&
      todos.impedimentos.every((i) => i.etapa >= 1 && i.etapa <= 11),
    todos.impedimentos.map((i) => `${i.codigo}=${i.etapa}`).join(","));
  ok("B12 e nenhuma frase manda abrir Aprovacoes, Atividade ou Conexoes",
    todos.impedimentos.every((i) =>
      !/Aprova[çc][õo]es|Atividade|tela de Conex[õo]es/i.test(i.mensagem)),
    todos.impedimentos.map((i) => i.mensagem).join(" | "));
}

// ─── C. A retomada cita, e nao parafraseia — §15/§16/§17 ─────────────

secao("C. A retomada cita a conversa anterior — §15/§16/§17");

{
  ok("C1  o assunto sai da primeira frase",
    assuntoDaMensagem("Vamos fechar agosto. Preciso do total de vendas.") ===
      "Vamos fechar agosto",
    String(assuntoDaMensagem("Vamos fechar agosto. Preciso do total de vendas.")));
  ok("C2  espaco e quebra sao colapsados",
    assuntoDaMensagem("  analise   minhas\n\n entradas  ") === "analise minhas entradas",
    String(assuntoDaMensagem("  analise   minhas\n\n entradas  ")));
  ok("C3  mensagem curta demais nao produz assunto",
    assuntoDaMensagem("oi") === null);
  ok("C4  nao-string nao produz assunto",
    assuntoDaMensagem(undefined) === null && assuntoDaMensagem(42) === null);

  const longa = `Preciso ${"muito ".repeat(40)}de ajuda`;
  const cortado = assuntoDaMensagem(longa);
  ok("C5  assunto longo e cortado no limite",
    cortado !== null && cortado.length <= LIMITE_ASSUNTO + 3,
    String(cortado?.length));
  ok("C6  e sinaliza que ha mais, com reticencias",
    cortado !== null && cortado.endsWith("..."));
  ok("C7  sem cortar palavra no meio",
    cortado !== null && !/\s\w{1,2}\.\.\.$/.test(cortado), String(cortado));

  const frase = frasesDeRetomada({ assuntoAnterior: "fechar o mês de agosto" });
  ok("C8  a retomada CITA o que a pessoa disse",
    frase !== null && frase.includes("«fechar o mês de agosto»"), String(frase));
  ok("C9  e pergunta como continuar",
    frase !== null && /continuar/i.test(frase));
  ok("C10 com o nome do dono, quando a CDS o conhece",
    (frasesDeRetomada({ assuntoAnterior: "x y z", primeiroNome: "Rodrigo" }) ?? "")
      .startsWith("Oi, Rodrigo."));
  ok("C11 e sem nome funciona",
    (frasesDeRetomada({ assuntoAnterior: "x y z" }) ?? "").startsWith("Oi."));
  ok("C12 sem conversa anterior NAO ha saudacao — §19",
    frasesDeRetomada({ assuntoAnterior: null }) === null);
  ok("C13 nem com assunto vazio",
    frasesDeRetomada({ assuntoAnterior: "   " }) === null);

  const gigante = frasesDeRetomada({ assuntoAnterior: "a".repeat(400) });
  ok("C14 a frase respeita o teto de tamanho — §17",
    gigante !== null && gigante.length <= LIMITE_RETOMADA, String(gigante?.length));
  ok("C15 e continua sendo uma pergunta inteira",
    gigante !== null && gigante.trim().endsWith("?"), String(gigante?.slice(-40)));

  // §16/§18: nem IA nem Zep participam. Prova estrutural.
  const CODIGO = semComentarios(fonte("lib/agentes/conversas/retomada-resumo.ts"));
  ok("C16 o resumo NAO chama IA",
    !/adaptador|conversarCom|anthropic|openai|gemini/i.test(CODIGO));
  ok("C17 nem o Zep — §18",
    !/zep|graph|buscarFatos/i.test(CODIGO));
  ok("C18 e nao le banco nem rede",
    !/supabase|fetch\(|from\("/i.test(CODIGO));
  const CODIGO_ANTERIOR = semComentarios(fonte("lib/agentes/conversas/retomada-anterior.ts"));
  ok("C19 a montagem tambem nao espera o Zep",
    !/zep|buscarFatosDoPrincipal/i.test(CODIGO_ANTERIOR));
  ok("C20 ANCORA: ela LE a conversa anterior, que e a autoridade",
    /listarConversas/.test(CODIGO_ANTERIOR));
}

// ─── D. O rotulo diz a fonte — §20/§26 ───────────────────────────────

secao("D. O nome nao mente sobre a fonte — §20/§26");

{
  const ml = TOOL_PACKS.find((p) => p.id === "mercadolivre-perguntas");
  const vendasCds = TOOL_PACKS.find((p) => p.id === "vendas");

  ok("D1  o pack do marketplace se chama Mercado Livre", ml?.nome === "Mercado Livre",
    String(ml?.nome));
  ok("D2  e inclui a consulta de vendas oficial",
    ml?.funcoes.includes("mercadolivre.vendas.consultar") === true,
    (ml?.funcoes ?? []).join(","));
  ok("D3  o pack da base da CDS NAO se chama so `Vendas`",
    vendasCds?.nome === "Vendas registradas na CDS", String(vendasCds?.nome));
  ok("D4  e o nome dele diz de onde le",
    /CDS/.test(vendasCds?.nome ?? ""));
  ok("D5  nenhum pack promete Mercado Livre lendo a base da CDS",
    vendasCds?.funcoes.every((f) => !f.startsWith("mercadolivre.")) === true);

  // §30: quem NOMEIA o marketplace recebe o marketplace.
  const pedidas = capacidadesPedidasNoTexto("Quanto vendi esta semana no Mercado Livre?");
  // A frase casa com os DOIS packs — "vendi" e "Mercado Livre". O que se
  // cobra aqui e o desfecho: sobra UM, e e o que a pessoa nomeou.
  //
  // A primeira versao deste oraculo exigia `>= 2`, descrevendo o
  // comportamento anterior. Ele estava errado como produto: depois de
  // adicionar o Mercado Livre, a mesma frase voltava a oferecer a base da
  // CDS, e o cartao reaparecia para uma pergunta ja respondida. O teste
  // do cenario pegou, e a regra passou a EXCLUIR a fonte alternativa.
  ok("D6  a frase do §30 resolve para UM pack",
    pedidas.length === 1, pedidas.map((x) => x.packId).join(","));
  ok("D7  e ele e o Mercado Livre — quem nomeia a fonte escolheu a fonte",
    pedidas[0]?.packId === "mercadolivre-perguntas",
    pedidas.map((x) => x.packId).join(","));
  ok("D7a ANCORA: o gatilho de `vendas` CASA com a frase — foi excluido, " +
     "e nao deixou de casar",
    capacidadesPedidasNoTexto("Quanto vendi esta semana?")
      .some((x) => x.packId === "vendas"));
  ok("D7b e a base da CDS NAO aparece junto do marketplace",
    !pedidas.some((x) => x.packId === "vendas"),
    pedidas.map((x) => x.packId).join(","));
  ok("D8  CONTROLE: sem citar o marketplace, `vendas` volta a vencer",
    capacidadesPedidasNoTexto("Quanto vendi esta semana?")[0]?.packId === "vendas",
    capacidadesPedidasNoTexto("Quanto vendi esta semana?").map((x) => x.packId).join(","));
  ok("D9  e `mercadolivre` sem espaco tambem tem precedencia",
    capacidadesPedidasNoTexto("faturamento no mercadolivre")[0]?.packId ===
      "mercadolivre-perguntas");

  ok("D10 a Funcao oficial pertence ao pack do marketplace",
    packDaFuncao("mercadolivre.vendas.consultar")?.id === "mercadolivre-perguntas");
  ok("D11 e o nome da plataforma e o que o dono reconhece",
    nomeDaPlataforma("mercado_livre") === "Mercado Livre" &&
      nomeDaPlataforma("shopee") === "Shopee");
  ok("D12 plataforma desconhecida devolve o proprio slug, sem inventar",
    nomeDaPlataforma("xpto") === "xpto");
  ok("D13 ANCORA: o mapa tem as duas plataformas nativas",
    Object.keys(NOME_DA_PLATAFORMA).sort().join(",") === "mercado_livre,shopee");
}

// ─── E. §28: consultar nao pede aprovacao ────────────────────────────

secao("E. Consulta e leitura, e leitura nao confirma — §28");

{
  for (const funcaoId of [
    "mercadolivre.vendas.consultar", "mercadolivre.perguntas.listar", "vendas.consultar",
  ]) {
    const efeito = efeitoDaFuncaoInterna({ funcaoId, acesso: "leitura" });
    ok(`E1  \`${funcaoId}\` e READ_ONLY e nao confirma`,
      efeito === "READ_ONLY" && !exigeConfirmacao(efeito), efeito);
  }
  ok("E2  ANCORA: escrita continua confirmando",
    exigeConfirmacao(efeitoDaFuncaoInterna({ funcaoId: "x.y", acesso: "escrita" })));

  // §29: nenhuma escrita nova entrou no catalogo neste gate.
  const escritas = TOOL_PACKS.filter((p) => p.acesso !== "leitura");
  ok("E3  nenhum pack de ESCRITA foi liberado neste gate",
    escritas.length === 0, escritas.map((p) => p.id).join(","));
}

// ─── F. §32: Shopee nao e fingida ────────────────────────────────────

secao("F. Shopee — nao se finge suporte — §32");

{
  const packsShopee = TOOL_PACKS.filter((p) =>
    p.funcoes.some((f) => f.startsWith("shopee.")));
  ok("F1  NAO existe capability de Shopee — e nao se inventa uma",
    packsShopee.length === 0, packsShopee.map((p) => p.id).join(","));
  ok("F2  e nenhum pack menciona Shopee nas capacidades que oferece",
    TOOL_PACKS.every((p) =>
      !p.capacidades.some((c) => /shopee/i.test(c)) && !/shopee/i.test(p.nome)));
  ok("F3  ANCORA: a traducao de plataforma CONHECE a Shopee — o contrato serve",
    NOME_DA_PLATAFORMA.shopee === "Shopee");
}

// ─── G. §13: Testar e o chat sao o MESMO caminho ─────────────────────

secao("G. Testar e o chat real nao podem divergir — §13");

{
  const WIZARD = semComentarios(fonte("components/ia/factory/Wizard.tsx"));
  const WORKSPACE = semComentarios(fonte("components/ia/factory/Workspace.tsx"));
  const CHAT = semComentarios(fonte("components/ia/factory/ChatDoAgente.tsx"));

  // A paridade nao e uma regra a manter: e uma consequencia de haver UM
  // componente. Dois componentes divergiriam, e o bug do Rodrigo ja
  // mostrou o custo de "no teste funciona, no chat nao".
  ok("G1  a etapa Testar usa o MESMO componente de chat",
    /<ChatDoAgente/.test(WIZARD) && /<ChatDoAgente/.test(WORKSPACE));
  ok("G2  e o wizard nao tem chat proprio",
    !/conversarComFerramentas|responderNaConversa/.test(WIZARD));
  ok("G3  o chat fala com UMA rota de conversa, e nao duas",
    /enviarNaConversaDoChat/.test(CHAT) &&
      !/modoTeste \?.*rota|rotaDeTeste/.test(CHAT));
  ok("G4  `modoTeste` muda a MOLDURA, e nao o caminho",
    /modoTeste/.test(CHAT) &&
      !/modoTeste[^\n]*(fetch|caminhoDoAgente|\/api\/)/.test(CHAT));
  ok("G5  ANCORA: as tres fontes foram lidas",
    WIZARD.length > 1000 && WORKSPACE.length > 500 && CHAT.length > 1000);
}

// ─── H. §12: quatro categorias, quatro frases ───────────────────────

secao("H. Bloqueio nao colapsa numa frase so — §12");

{
  ok("H1  ha exatamente QUATRO categorias",
    CATEGORIAS_DE_BLOQUEIO.length === 4, CATEGORIAS_DE_BLOQUEIO.join(","));
  ok("H2  e cada uma tem frase propria",
    CATEGORIAS_DE_BLOQUEIO.every((c) => (MENSAGEM_POR_CATEGORIA[c] ?? "").length > 20));
  ok("H3  as quatro frases sao diferentes entre si",
    new Set(Object.values(MENSAGEM_POR_CATEGORIA)).size === 4);
  ok("H4  nenhuma vaza codigo tecnico ao usuario",
    Object.values(MENSAGEM_POR_CATEGORIA).every((m) =>
      !/_|funcao_id|slug|http/i.test(m)));

  // O caso do Rodrigo: conexao NAO pode falar de ferramenta faltando.
  ok("H5  conexao e conexao, e nao `ferramenta indisponivel`",
    categoriaDoBloqueio("negado", "conexao_ausente") === "conexao" &&
      !/ferramenta/i.test(MENSAGEM_POR_CATEGORIA.conexao));
  ok("H6  permissao e permissao",
    categoriaDoBloqueio("negado", "permissao_ausente") === "permissao");
  ok("H7  fonte e fonte",
    categoriaDoBloqueio("erro", "arquivo_nao_encontrado") === "fonte");
  ok("H8  e o desconhecido e INTERNO — nao culpa o dono",
    categoriaDoBloqueio("erro", "xpto") === "interno" &&
      categoriaDoBloqueio("erro", null) === "interno");

  // Erro de ARGUMENTO nao fecha o turno: o modelo corrige.
  for (const codigo of [
    "filtro_ausente", "filtro_ambiguo", "data_invalida",
    "periodo_invertido", "status_invalido", "campo_desconhecido", "periodo_invalido",
  ]) {
    ok(`H9  \`${codigo}\` e corrigivel — o modelo tenta de novo`,
      (CODIGOS_CORRIGIVEIS as readonly string[]).includes(codigo) &&
        classificarFalha("erro", codigo) === "corrigivel");
  }
  ok("H10 CONTROLE: seguranca continua fechando o turno",
    classificarFalha("negado", "permissao_bloqueada") === "fecha_o_turno" &&
      classificarFalha("erro", "fonte_indisponivel") === "fecha_o_turno");
  ok("H11 CONTROLE: codigo novo sem classificacao continua fechando",
    classificarFalha("erro", "codigo_inventado_agora") === "fecha_o_turno");
}

// ─── I. O `null` do provedor ────────────────────────────────────────

secao("I. `null` de campo opcional nao e valor — a causa do bug");

{
  ok("I1  chave nula de primeiro nivel sai",
    JSON.stringify(semCamposNulos({ a: 1, b: null })) === JSON.stringify({ a: 1 }));
  ok("I2  `undefined` tambem sai",
    JSON.stringify(semCamposNulos({ a: 1, b: undefined })) === JSON.stringify({ a: 1 }));
  ok("I3  tudo nulo vira objeto vazio — e nao um default inventado",
    JSON.stringify(semCamposNulos({ a: null })) === "{}");
  ok("I4  nada a remover devolve o MESMO objeto",
    (() => { const o = { a: 1 }; return semCamposNulos(o) === o; })());
  ok("I5  NAO desce dentro de objeto — `null` ali pode ser dado",
    JSON.stringify(semCamposNulos({ a: { b: null } })) ===
      JSON.stringify({ a: { b: null } }));
  ok("I6  array atravessa intacto",
    JSON.stringify(semCamposNulos([1, null])) === JSON.stringify([1, null]));
  ok("I7  e o que nao e objeto tambem",
    semCamposNulos("texto") === "texto" && semCamposNulos(null) === null);
}

console.log(`\nPASS ${pass}   FAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);
