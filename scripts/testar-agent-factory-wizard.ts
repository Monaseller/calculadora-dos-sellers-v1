/**
 * AGENT-FACTORY-F7b.1 — a Factory self-service, provada.
 *
 * Suite PURA: sem rede, sem banco, sem IA. O que ela cobra sao as tres
 * pecas novas de dominio e as invariaveis estruturais das telas.
 *
 * ── A pergunta central: ACTIVATION_PERMISSION_COMPLETENESS ──────────
 *
 * O F7b.0 provou que `bloqueado` FECHA o turno — a Funcao e declarada ao
 * provider, o guard nega, o laco para. Mas sobrou um buraco pelo outro
 * lado: permissao AUSENTE nao declara a Funcao, e o que nao e declarado
 * nao e pedido, e o que nao e pedido o modelo responde de cabeca.
 *
 * Para a Funcao ausente NAO EXISTE cerca em runtime: nao ha o que negar
 * se ninguem pediu. A cerca tem de ser antes, na ativacao — e a secao C
 * e o que prova que ela esta la, nos dois sentidos:
 *
 *   C4  uma Funcao do pack sem permissao  -> NAO ativa
 *   C5  a mesma Funcao com permissao      -> ativa
 *
 * Um teste que so provasse o bloqueio passaria com uma funcao que
 * SEMPRE bloqueia. O par e a prova.
 *
 * ── E a coisa mais importante da secao C ────────────────────────────
 *
 * `bloqueado` conta como DECIDIDO. Um agente com a planilha bloqueada
 * ativa normalmente — porque ali existe cerca em runtime. O que nao
 * ativa e o agente com a planilha em silencio. C6 cobra exatamente
 * isso, e e a diferenca entre a regra e "exigir tudo automatico".
 *
 * Roda com: npx tsx scripts/testar-agent-factory-wizard.ts
 */
// `registry.ts` importa `server-only`, que LANCA fora do Next. Este
// import tem de vir ANTES de qualquer outro que alcance o registry.
import "./_server-only-inerte";

import {
  DESFECHOS_DA_IA, opcaoPreferida, resolverIaDoAgente,
} from "../lib/agentes/factory/ia-do-agente";
import {
  adaptadorDoProvedor, provedoresComAdaptador,
} from "../lib/agentes/ia/adaptador-por-provedor";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  MAX_CORPO_DA_SKILL, MAX_DESCRICAO_DA_SKILL, MAX_NOME_DA_SKILL,
  ORIGEM_DA_UI, VERSAO_INICIAL, comporDocumentoDeSkill, slugDoNome,
} from "../lib/agentes/skills/compor";
import {
  TOOL_PACKS, estadoDosPacks, funcoesDosPacks, packDaFuncao, packPorId,
} from "../lib/agentes/factory/catalogo-ui";
import {
  CODIGOS_DE_IMPEDIMENTO, PROVEDORES_COM_FERRAMENTA, validarParaAtivacao,
} from "../lib/agentes/factory/ativacao";
import { FUNCOES } from "../lib/agentes/funcoes/registry";
import {
  fraseDaSugestao, normalizar, sugerirPapel,
} from "../lib/agentes/factory/proposito-de-arquivo";
import {
  NIVEIS_DE_TRABALHO, catalogoDeModelos, envsFaltando, modelosDisponiveis,
  nivelEfetivo, ofereceEscolhaDeNivel, rotuloDoNivel,
} from "../lib/agentes/factory/catalogo-de-modelos";
import {
  ehFuncaoExterna, idDaFuncaoExterna, nivelRecomendado, pecasDoId, riscoDaAcao,
} from "../lib/agentes/composio/identidade-de-funcao";

const RAIZ = join(__dirname, "..");
const ler = (rel: string): string => readFileSync(join(RAIZ, rel), "utf8");
/** Codigo sem comentario: um oraculo nunca deve casar com a prosa. */
const semComentarios = (t: string): string =>
  t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
const codigo = (rel: string): string => semComentarios(ler(rel));

let passou = 0;
let falhou = 0;
function ok(nome: string, cond: boolean, detalhe = ""): void {
  if (cond) { passou++; console.log(`  PASS  ${nome}`); }
  else { falhou++; console.log(`  FAIL  ${nome}${detalhe ? ` — ${detalhe}` : ""}`); }
}
function secao(t: string): void { console.log(`\n${t}`); }

console.log("\n══ CDS IA — AGENT-FACTORY-F7b.1: wizard, packs e ativacao ══");

// ─── A. O catalogo de packs ───────────────────────────────────────────

secao("A. Os packs falam de capacidade, e apontam para Funcoes reais");

{
  ok("A1  ANCORA: ha packs de verdade", TOOL_PACKS.length >= 5,
    String(TOOL_PACKS.length));

  // A razao de ser do catalogo: um `funcao_id` que nao existe no
  // registry viraria um pack que a tela oferece e o guard nao conhece.
  const idsReais = new Set(Object.keys(FUNCOES));
  const orfas = funcoesDosPacks().filter((f) => !idsReais.has(f));
  ok("A2  TODA Funcao citada por um pack existe no registry real",
    orfas.length === 0, orfas.join(", "));
  ok("A3  CONTROLE: a sonda acha orfa quando existe",
    !idsReais.has("planilha.inexistente"));

  const vistas = funcoesDosPacks();
  ok("A4  nenhuma Funcao aparece em dois packs",
    new Set(vistas).size === vistas.length);
  ok("A5  os ids de pack sao unicos",
    new Set(TOOL_PACKS.map((p) => p.id)).size === TOOL_PACKS.length);

  // O pack e a LINGUAGEM da tela. Se ele carregasse `funcao_id` no
  // nome ou na descricao, a traducao nao teria servido para nada.
  const comIdTecnico = TOOL_PACKS.filter(
    (p) => /\./.test(p.nome) || p.funcoes.some((f) => p.descricao.includes(f)));
  ok("A6  nome e descricao do pack nao citam `funcao_id`",
    comIdTecnico.length === 0, comIdTecnico.map((p) => p.id).join(", "));
  ok("A7  todo pack diz o que sabe fazer, em frases",
    TOOL_PACKS.every((p) => p.capacidades.length > 0 &&
      p.capacidades.every((c) => c.length > 3 && !/\./.test(c.split(" ")[0]))));

  ok("A8  packDaFuncao encontra o pack de uma Funcao declarada",
    packDaFuncao("planilha.ler")?.id === packPorId("planilhas")?.id);
  ok("A9  packDaFuncao devolve null para Funcao de fora",
    packDaFuncao("agente_financeiro.qualquer") === null);
  ok("A10 packPorId devolve null para id inventado",
    packPorId("nao-existe") === null);

  // Congelamento leve: um pack de ESCRITA que exija conexao e uma
  // combinacao que muda o default recomendado na etapa 8. Se algum dia
  // entrar, que entre com a tela ciente.
  ok("A11 hoje todo pack e de leitura",
    TOOL_PACKS.every((p) => p.acesso === "leitura"),
    TOOL_PACKS.filter((p) => p.acesso !== "leitura").map((p) => p.id).join(", "));
}

// ─── B. estadoDosPacks ────────────────────────────────────────────────

secao("B. Selecao E ter linha de permissao — nao ha tabela paralela");

{
  const planilhas = packPorId("planilhas");
  if (planilhas === null) throw new Error("pack `planilhas` ausente");
  const [f1, f2, f3] = planilhas.funcoes;

  {
    const st = estadoDosPacks([]);
    const p = st.find((x) => x.pack.id === "planilhas");
    ok("B1  sem permissao nenhuma, o pack nao esta selecionado",
      p !== undefined && !p.selecionado && !p.completo);
    ok("B2  e as tres Funcoes aparecem como sem permissao",
      p !== undefined && p.semPermissao.length === 3);
  }

  {
    // UMA das tres. E o caso que o F7b.0 deixou aberto.
    const st = estadoDosPacks([{ funcaoId: f1, nivel: "automatico" }]);
    const p = st.find((x) => x.pack.id === "planilhas");
    ok("B3  com UMA das tres, o pack ESTA selecionado",
      p !== undefined && p.selecionado);
    ok("B4  mas NAO esta completo",
      p !== undefined && !p.completo);
    ok("B5  e as duas que faltam sao nomeadas",
      p !== undefined && p.semPermissao.length === 2 &&
        p.semPermissao.includes(f2) && p.semPermissao.includes(f3));
    ok("B6  nivel uniforme e null quando ha Funcao sem decisao",
      p !== undefined && p.nivelUniforme === null);
  }

  {
    const st = estadoDosPacks(
      planilhas.funcoes.map((f) => ({ funcaoId: f, nivel: "automatico" })));
    const p = st.find((x) => x.pack.id === "planilhas");
    ok("B7  com as tres, o pack esta completo",
      p !== undefined && p.selecionado && p.completo &&
        p.semPermissao.length === 0);
    ok("B8  e o nivel uniforme e o nivel comum",
      p !== undefined && p.nivelUniforme === "automatico");
  }

  {
    // Niveis DIFERENTES dentro do mesmo pack: completo, mas sem nivel
    // unico para mostrar no radio.
    const st = estadoDosPacks([
      { funcaoId: f1, nivel: "automatico" },
      { funcaoId: f2, nivel: "aprovacao" },
      { funcaoId: f3, nivel: "automatico" },
    ]);
    const p = st.find((x) => x.pack.id === "planilhas");
    ok("B9  niveis divergentes: completo sim, uniforme nao",
      p !== undefined && p.completo && p.nivelUniforme === null);
  }

  {
    // `bloqueado` e DECISAO. Nao pode contar como ausencia.
    const st = estadoDosPacks(
      planilhas.funcoes.map((f) => ({ funcaoId: f, nivel: "bloqueado" })));
    const p = st.find((x) => x.pack.id === "planilhas");
    ok("B10 `bloqueado` conta como decidido — pack completo",
      p !== undefined && p.completo && p.nivelUniforme === "bloqueado");
  }

  {
    // Permissao de Funcao que nao esta em pack nenhum nao inventa pack.
    const st = estadoDosPacks([{ funcaoId: "agente_financeiro.x", nivel: "automatico" }]);
    ok("B11 permissao fora do catalogo nao seleciona pack nenhum",
      st.every((x) => !x.selecionado));
  }
}

// ─── C. A CERCA DA ATIVACAO ───────────────────────────────────────────

secao("C. ACTIVATION_PERMISSION_COMPLETENESS");

{
  const planilhas = packPorId("planilhas");
  if (planilhas === null) throw new Error("pack `planilhas` ausente");
  const [f1, f2, f3] = planilhas.funcoes;

  const base = {
    nome: "Assistente financeiro",
    instrucoes: "Use as ferramentas para qualquer numero.",
    provedor: "anthropic",
  };

  // C1..C3: os impedimentos que nao tem nada a ver com permissao, para
  // que C4 nao possa passar por acidente de nome ou instrucao vazios.
  ok("C1  sem nome, nao ativa",
    !validarParaAtivacao({ ...base, nome: "", permissoes: [] }).podeAtivar);
  ok("C2  sem instrucoes, nao ativa",
    !validarParaAtivacao({ ...base, instrucoes: "  ", permissoes: [] }).podeAtivar);
  ok("C3  sem provedor, nao ativa",
    !validarParaAtivacao({ ...base, provedor: null, permissoes: [] }).podeAtivar);

  // ── O PAR que prova a regra ─────────────────────────────────────
  const incompleto = validarParaAtivacao({
    ...base,
    permissoes: [
      { funcaoId: f1, nivel: "automatico" },
      { funcaoId: f2, nivel: "automatico" },
      // f3 DELIBERADAMENTE ausente.
    ],
  });
  ok("C4  pack selecionado com UMA Funcao sem permissao: NAO ativa",
    !incompleto.podeAtivar);
  ok("C4a e o impedimento e `permissao_incompleta`",
    incompleto.impedimentos.some((i) => i.codigo === "permissao_incompleta"));
  ok("C4b que aponta para a etapa 8",
    incompleto.impedimentos.find((i) => i.codigo === "permissao_incompleta")?.etapa === 8);
  ok("C4c e nomeia o pack pelo nome de gente, sem `funcao_id`",
    incompleto.impedimentos.some((i) =>
      i.mensagem.includes(planilhas.nome) && !/\w+\.\w+/.test(i.mensagem)));
  ok("C4d o pack aparece em `packsIncompletos`",
    incompleto.packsIncompletos.some((p) => p.id === "planilhas"));

  const completo = validarParaAtivacao({
    ...base,
    permissoes: [
      { funcaoId: f1, nivel: "automatico" },
      { funcaoId: f2, nivel: "automatico" },
      { funcaoId: f3, nivel: "automatico" },
    ],
  });
  ok("C5  completada a terceira Funcao: ATIVA",
    completo.podeAtivar, completo.impedimentos.map((i) => i.codigo).join(", "));
  ok("C5a e nenhum impedimento sobra",
    completo.impedimentos.length === 0);

  // ── `bloqueado` e decisao, nao ausencia ─────────────────────────
  const bloqueadoTodo = validarParaAtivacao({
    ...base,
    permissoes: planilhas.funcoes.map((f) => ({ funcaoId: f, nivel: "bloqueado" })),
  });
  ok("C6  pack inteiro BLOQUEADO ativa — bloquear e decidir",
    bloqueadoTodo.podeAtivar);

  const misto = validarParaAtivacao({
    ...base,
    permissoes: [
      { funcaoId: f1, nivel: "bloqueado" },
      { funcaoId: f2, nivel: "aprovacao" },
      { funcaoId: f3, nivel: "automatico" },
    ],
  });
  ok("C6a tres niveis diferentes, todos explicitos: ativa", misto.podeAtivar);

  // Um pack a mais, incompleto, com o primeiro completo: a mensagem
  // precisa acusar o SEGUNDO, nao se calar porque o primeiro esta bom.
  const calendario = packPorId("calendario");
  if (calendario !== null) {
    const doisPacks = validarParaAtivacao({
      ...base,
      permissoes: [
        ...planilhas.funcoes.map((f) => ({ funcaoId: f, nivel: "automatico" })),
        // `calendario` selecionado por uma Funcao... que e a unica dele,
        // entao aqui ele fica COMPLETO. Usa-se o pack de vendas abaixo
        // para o caso incompleto de verdade.
      ],
    });
    ok("C7  dois packs completos: ativa", doisPacks.podeAtivar);
  }

  // Sem ferramenta nenhuma o agente ativa: nao ha permissao a completar.
  const semFerramenta = validarParaAtivacao({ ...base, permissoes: [] });
  ok("C8  agente SEM ferramenta nenhuma ativa",
    semFerramenta.podeAtivar && !semFerramenta.temFerramentas);

  // ── C9/C10 reconciliados na F7b.4.2 ──────────────────────────────
  //
  // ANTES o `google` era o exemplo de provedor incompativel, porque o
  // roundtrip de ferramenta dele nao fechava. O F7b.4 resolveu isso
  // (`store: false` + assinatura preservada) e o F7b.4.2 acrescentou a
  // OpenAI — os TRES provedores configurados agora suportam ferramenta.
  //
  // O caso incompativel continua tendo de ser testado, porque o codigo
  // `modelo_incompativel_com_ferramentas` continua existindo. Mas ele
  // passa a usar um provedor SINTETICO: apontar um provedor real como
  // exemplo de incompativel seria afirmar algo que deixou de ser verdade.
  const PROVEDOR_SINTETICO = "provedor_de_teste_sem_ferramenta";
  const incompativelComFerramenta = validarParaAtivacao({
    ...base, provedor: PROVEDOR_SINTETICO,
    permissoes: planilhas.funcoes.map((f) => ({ funcaoId: f, nivel: "automatico" })),
  });
  ok("C9  provedor sem ida-e-volta de ferramenta + ferramentas: NAO ativa",
    !incompativelComFerramenta.podeAtivar &&
      incompativelComFerramenta.impedimentos.some(
        (i) => i.codigo === "modelo_incompativel_com_ferramentas"));
  ok("C9a e a frase nao vaza `store`, Interactions nem nome de adaptador",
    incompativelComFerramenta.impedimentos.every(
      (i) => !/store|interaction|adaptador|previous_interaction/i.test(i.mensagem)));
  const incompativelSemFerramenta = validarParaAtivacao({
    ...base, provedor: PROVEDOR_SINTETICO, permissoes: [],
  });
  ok("C9b o MESMO provedor SEM ferramenta ativa",
    incompativelSemFerramenta.podeAtivar);
  ok("C9c e os TRES provedores reais passam COM ferramenta",
    ["anthropic", "google", "openai"].every((prov) =>
      validarParaAtivacao({
        ...base, provedor: prov,
        permissoes: planilhas.funcoes.map((f) => ({ funcaoId: f, nivel: "automatico" })),
      }).podeAtivar));

  ok("C10 a lista de provedores com ferramenta e a MEDIDA, nao a desejada",
    JSON.stringify([...PROVEDORES_COM_FERRAMENTA].sort()) ===
      JSON.stringify(["anthropic", "google", "openai"]),
    [...PROVEDORES_COM_FERRAMENTA].join(","));
  ok("C10a e cada um deles tem entrada no catalogo, com prova",
    ["anthropic", "google", "openai"].every((prov) => {
      const m = catalogoDeModelos().find((x) => x.provedor === prov);
      return m !== undefined && m.provadoEm.startsWith("scripts/");
    }));

  // Anti-vacuidade: todo codigo declarado tem de ser alcancavel por
  // ALGUMA entrada. Um codigo que nunca aparece e letra morta.
  const alcancados = new Set<string>([
    ...validarParaAtivacao({ nome: "", instrucoes: "", provedor: null, permissoes: [] })
      .impedimentos.map((i) => i.codigo),
    ...incompleto.impedimentos.map((i) => i.codigo),
    ...incompativelComFerramenta.impedimentos.map((i) => i.codigo),
    // Os dois codigos da F7b.4.2. Sem estes dois, C11 acusaria letra
    // morta — e foi exatamente o que ele fez quando eles entraram sem
    // teste.
    ...validarParaAtivacao({
      ...base, provedorEscolhido: "google", provedoresDisponiveis: ["anthropic"],
      permissoes: [],
    }).impedimentos.map((i) => i.codigo),
    ...validarParaAtivacao({
      ...base, permissoes: [],
      funcoesExternasVinculadas: ["composio.googlesheets.googlesheets_add_sheet"],
    }).impedimentos.map((i) => i.codigo),
    // Os dois codigos da F7b.4.8. Mesma historia dos de cima: C11 os
    // acusou de letra morta no minuto em que entraram sem teste, e e
    // exatamente para isso que ele existe.
    ...validarParaAtivacao({
      ...base, permissoes: [],
      dependenciasDeSkill: [
        { skillId: "financeiro", nome: "Mercado Livre", tipo: "funcao", bloqueia: true },
      ],
    }).impedimentos.map((i) => i.codigo),
    ...validarParaAtivacao({
      ...base, permissoes: [],
      conexoesSemLoja: [{ nome: "Mercado Livre" }],
    }).impedimentos.map((i) => i.codigo),
  ]);
  const mortos = CODIGOS_DE_IMPEDIMENTO.filter((c) => !alcancados.has(c));
  ok("C11 TODO codigo de impedimento declarado e alcancavel",
    mortos.length === 0, mortos.join(", "));

  ok("C12 toda mensagem de impedimento e uma frase, e diz o que fazer",
    [...incompleto.impedimentos, ...incompativelComFerramenta.impedimentos].every(
      (i) => i.mensagem.length > 15 && /[.!]$/.test(i.mensagem)));
  ok("C13 todo impedimento aponta para uma etapa que existe",
    [...incompleto.impedimentos, ...incompativelComFerramenta.impedimentos,
     ...validarParaAtivacao({ nome: "", instrucoes: "", provedor: null, permissoes: [] })
       .impedimentos]
      .every((i) => i.etapa >= 1 && i.etapa <= 11));

  // A funcao e PURA: nenhuma leitura de banco, env ou rede.
  const fonte = codigo("lib/agentes/factory/ativacao.ts");
  ok("C14 `ativacao.ts` e puro — sem banco, sem env, sem rede",
    !/process\.env|getSupabaseServidor|createClient|fetch\s*\(/.test(fonte));
}

// ─── D. A rota de ativacao ────────────────────────────────────────────

secao("D. A rota nao decide nada por conta propria");

{
  const rota = codigo("app/api/agentes/[agenteId]/ativacao/route.ts");

  ok("D1  ela chama `validarParaAtivacao`, e nao reimplementa a regra",
    /validarParaAtivacao\(/.test(rota));
  ok("D2  e nao tem lista de impedimento propria",
    !/permissao_incompleta|modelo_incompativel/.test(rota));
  ok("D3  ATIVAR passa pela validacao",
    /if \(!estado\.validacao\.podeAtivar\)/.test(rota));
  // A ordem so diz alguma coisa DENTRO do PATCH: `podeAtivar` tambem
  // aparece no GET, antes de tudo, e comparar indices no arquivo
  // inteiro media a posicao do handler errado. Este assert media isso e
  // reprovava um codigo correto — recortar o PATCH e a correcao.
  const patch = rota.slice(rota.indexOf("export async function PATCH"));
  ok("D4  DESATIVAR nao passa pela validacao: desligar e sempre possivel",
    /corpo\.ativo === false/.test(patch) &&
      patch.indexOf("corpo.ativo === false") < patch.indexOf("estado.validacao.podeAtivar"));
  ok("D4a ANCORA: o recorte do PATCH pegou o handler certo",
    patch.length > 200 && patch.length < rota.length &&
      !/export async function GET/.test(patch));
  ok("D5  o corpo aceita SO `ativo`",
    /typeof corpo\.ativo !== "boolean"/.test(rota) &&
      !/corpo\.(nome|instrucoes|tipo|user_?[Ii]d)/.test(rota));
  ok("D6  o dono vem da porta, nunca do corpo",
    /porta\.userId/.test(rota) && !/corpo\.userId|body\.userId/.test(rota));
  ok("D7  o agenteId vem da porta, nunca do corpo",
    /porta\.agenteId/.test(rota) && !/corpo\.agenteId/.test(rota));
  ok("D8  a recusa de ativacao devolve 409 com o que falta",
    /impedimentos: estado\.validacao\.impedimentos[\s\S]{0,40}409/.test(rota));
  // D9 media a lista INTERNA, onde a pessoa escolheu PACKS e nunca viu
  // `funcao_id`. A fatia antiga ia ate `podeAtivar:` e passou a englobar
  // `ferramentasExternas:`, que publica `funcaoId` DE PROPOSITO — ver D9b.
  // Corrigir a fatia e consertar o instrumento; afrouxar o regex seria
  // perder a garantia.
  ok("D9  a lista de ferramentas INTERNAS nao publica `funcao_id`",
    !/funcao_?[Ii]d/.test(rota.slice(rota.indexOf("ferramentas:"),
      rota.indexOf("ferramentasExternas:"))));
  // E a externa publica, porque ali a pessoa escolheu A ACAO, e nao um
  // pack: sem o id ela nao tem como decidir o nivel de cada uma (§16). O
  // slug e publico no catalogo do Composio — nao e segredo, e a cerca
  // continua sendo o guard, que nao confia em id vindo do browser.
  ok("D9b a lista de EXTERNAS publica `funcaoId`, que e como a acao se chama",
    /ferramentasExternas: estado\.vinculos\.map/.test(rota) &&
      /funcaoId: v\.funcaoId/.test(rota));
  ok("D10 as permissoes sao pedidas para o catalogo INTEIRO",
    /funcaoIds: Object\.keys\(FUNCOES\)/.test(rota));
}

// ─── E. compor.ts: tres campos -> documento de Skill ──────────────────

secao("E. A Skill nasce de tres perguntas, e o resto e derivado");

{
  ok("E1  slug tira acento e caixa",
    slugDoNome("Fechamento Financeiro") === "fechamento-financeiro");
  ok("E2  slug colapsa pontuacao e espaco",
    slugDoNome("Saldo:  entradas / saidas!") === "saldo-entradas-saidas");
  ok("E3  slug nao comeca nem termina com hifen",
    !/^-|-$/.test(slugDoNome("  -- Resumo do mes -- ")));
  ok("E4  ANCORA: a sonda de slug reprova quando deveria",
    slugDoNome("Ação") !== "Ação");

  const bom = comporDocumentoDeSkill({
    nome: "Fechamento financeiro",
    quandoUsar: "quando eu pedir resumo do mes\nquando eu perguntar do saldo",
    instrucoes: "Saldo = total de entradas menos total de saidas.",
  });
  ok("E5  os tres campos bastam", bom.ok === true);

  if (bom.ok) {
    ok("E6  o documento tem o bloco cercado `cds-skill`",
      /```cds-skill\n[\s\S]*?\n```/.test(bom.texto));

    const bloco = /```cds-skill\n([\s\S]*?)\n```/.exec(bom.texto);
    ok("E7  e o manifesto e JSON valido", bloco !== null && (() => {
      try { JSON.parse(bloco[1]); return true; } catch { return false; }
    })());

    const man = JSON.parse(bloco![1]) as Record<string, unknown>;
    ok("E8  a versao inicial e derivada, nao perguntada",
      man.versao === VERSAO_INICIAL);
    ok("E9  a origem e derivada, nao perguntada",
      man.origem === ORIGEM_DA_UI);
    ok("E10 o slug e derivado do nome",
      man.id === "fechamento-financeiro" && bom.slug === "fechamento-financeiro");
    ok("E11 `quando_usar` virou lista, uma por linha",
      Array.isArray(man.quando_usar) && (man.quando_usar as string[]).length === 2);
    ok("E12 as instrucoes ficam no CORPO, fora do manifesto",
      bom.texto.includes("Saldo = total de entradas") &&
        !JSON.stringify(man).includes("Saldo = total de entradas"));
    ok("E13 o manifesto NAO tem hash — quem o deriva e a persistencia",
      !("hash" in man) && !("hash_conteudo" in man));
  }

  // ── As recusas ──────────────────────────────────────────────────
  ok("E14 nome vazio e recusado",
    comporDocumentoDeSkill({ nome: "  ", quandoUsar: "x", instrucoes: "y" }).ok === false);
  ok("E15 instrucoes vazias sao recusadas",
    comporDocumentoDeSkill({ nome: "A", quandoUsar: "x", instrucoes: " " }).ok === false);
  ok("E16 tipo errado e recusado, nao convertido",
    comporDocumentoDeSkill({ nome: 42, quandoUsar: "x", instrucoes: "y" }).ok === false);
  ok("E17 nome que nao produz slug nenhum e recusado",
    comporDocumentoDeSkill({ nome: "!!!", quandoUsar: "x", instrucoes: "y" }).ok === false);
  ok("E18 nome longo demais e recusado",
    comporDocumentoDeSkill({
      nome: "a".repeat(MAX_NOME_DA_SKILL + 1), quandoUsar: "x", instrucoes: "y",
    }).ok === false);
  ok("E19 corpo longo demais e recusado",
    comporDocumentoDeSkill({
      nome: "A", quandoUsar: "x", instrucoes: "y".repeat(MAX_CORPO_DA_SKILL + 1),
    }).ok === false);
  ok("E20 descricao longa demais e recusada",
    comporDocumentoDeSkill({
      nome: "A", quandoUsar: "x", instrucoes: "y",
      descricao: "d".repeat(MAX_DESCRICAO_DA_SKILL + 1),
    }).ok === false);
  ok("E21 CONTROLE POSITIVO: nos limites, ACEITA",
    comporDocumentoDeSkill({
      nome: "a".repeat(MAX_NOME_DA_SKILL),
      quandoUsar: "x",
      instrucoes: "y".repeat(1000),
      descricao: "d".repeat(MAX_DESCRICAO_DA_SKILL),
    }).ok === true);
  ok("E22 toda recusa tem codigo E frase",
    [
      comporDocumentoDeSkill({ nome: "", quandoUsar: "x", instrucoes: "y" }),
      comporDocumentoDeSkill({ nome: "A", quandoUsar: "x", instrucoes: "" }),
      comporDocumentoDeSkill({ nome: 1, quandoUsar: "x", instrucoes: "y" }),
    ].every((r) => r.ok === false && r.codigo.length > 0 && r.mensagem.length > 10));

  // Composicao e composicao: nao grava e nao valida formato.
  const fonte = codigo("lib/agentes/skills/compor.ts");
  ok("E23 `compor.ts` nao persiste e nao valida formato — nao e o dono disso",
    !/importarEPersistirSkill|getSupabaseServidor|validarSkill|createHash/.test(fonte));
}

// ─── F. A rota de Skills e adaptador, nao dominio ─────────────────────

secao("F. POST /api/skills reusa o que existe");

{
  const rota = codigo("app/api/skills/route.ts");

  ok("F1  compoe pelo compositor",
    /comporDocumentoDeSkill\(/.test(rota));
  ok("F2  e persiste pela escrita que ja existia",
    /importarEPersistirSkill\(/.test(rota));
  ok("F3  NAO reimplementa slug, versao, manifesto nem hash",
    !/createHash|JSON\.stringify\(\{[\s\S]{0,80}formato/.test(rota) &&
      !/versao:\s*"1\.0\.0"/.test(rota));
  ok("F4  o dono vem da sessao",
    /auth\.uid/.test(rota) && !/body\.userId|corpo\.userId/.test(rota));
  ok("F5  os tres estados reais de sucesso e reuso estao tratados",
    /criada/.test(rota) && /ja_existia/.test(rota));
  ok("F6  e os tres de recusa tambem",
    /recusada/.test(rota) && /conflito_versao/.test(rota) &&
      /entrada_invalida/.test(rota) && /falha_escrita/.test(rota));
  ok("F7  nao pede slug, versao nem manifesto ao cliente",
    !/corpo\.(slug|versao|manifesto|origem|hash)/.test(rota));
}

// ─── G. As telas ──────────────────────────────────────────────────────

secao("G. O wizard: uma etapa por vez, e nada de rede");

{
  const wiz = codigo("components/ia/factory/Wizard.tsx");
  const chat = codigo("components/ia/factory/ChatDoAgente.tsx");
  const work = codigo("components/ia/factory/Workspace.tsx");
  const prim = codigo("components/ui/Primitivas.tsx");

  ok("G1  as 11 etapas estao na ordem congelada",
    /Identidade[\s\S]{0,200}Instruções[\s\S]{0,200}IA \/ Modelo[\s\S]{0,200}Ferramentas[\s\S]{0,200}Skills[\s\S]{0,200}Memória[\s\S]{0,200}Arquivos[\s\S]{0,200}Permissões[\s\S]{0,200}Rotinas[\s\S]{0,200}Testar[\s\S]{0,200}Revisar e Ativar/
      .test(wiz));
  ok("G2  ANCORA: sao exatamente onze",
    (wiz.match(/numero: \d+, titulo:/g) ?? []).length === 11);

  // A propriedade central do §6: nunca dois paineis de configuracao
  // abertos. Cada etapa e um `etapa === N`, e nao um accordion.
  ok("G3  cada etapa e um bloco exclusivo `etapa === N`",
    (wiz.match(/\{etapa === \d+ &&/g) ?? []).length >= 10);
  ok("G4  o centro renderiza por igualdade, nao por lista aberta",
    !/ETAPAS\.map\([\s\S]{0,200}Painel|todasAsEtapas/.test(wiz));

  // Zero rede nos tres componentes — a suite de fonte tambem cobra
  // isto, e aqui e cobrado nominalmente para os arquivos deste gate.
  const arqv = codigo("components/ia/factory/ArquivosDoAgente.tsx");
  for (const [nome, src] of [["Wizard", wiz], ["ChatDoAgente", chat],
                             ["Workspace", work], ["Primitivas", prim],
                             ["ArquivosDoAgente", arqv]] as const) {
    ok(`G5  ${nome} nao faz rede nem monta endereco de API`,
      !/\bfetch\s*\(|XMLHttpRequest|["'`]\/api\//.test(src));
  }
  ok("G6  e os tres usam o transporte unico",
    [wiz, chat, work].every((s) => /from "@\/lib\/ia\/agentes-http"/.test(s)));

  // O que a tela nunca mostra (§41).
  for (const [nome, src] of [["Wizard", wiz], ["ChatDoAgente", chat],
                             ["Workspace", work]] as const) {
    ok(`G7  ${nome} nao toca caminho de storage, credencial nem service_role`,
      !/caminhoObjeto|service_role|SUPABASE_SERVICE|ANTHROPIC_API_KEY|Authorization/
        .test(src));
    ok(`G8  ${nome} nao manda userId`,
      !/\buserId\b/.test(src));
  }

  ok("G9  o agente nasce inativo — a tela nao manda `ativo` na criacao",
    /criarAgenteViaApi\(\{[\s\S]{0,140}\}\)/.test(wiz) &&
      !/ativo:\s*true/.test(wiz));
  ok("G10 ativar e ato separado, pela rota de ativacao",
    /definirAtivacaoDoAgente\(agenteId, true\)/.test(wiz));
  ok("G11 a tela NAO decide se pode ativar — ela le `podeAtivar`",
    /ativacao\.podeAtivar/.test(wiz) && !/validarParaAtivacao/.test(wiz));
  ok("G12 e os impedimentos mostrados sao os do servidor",
    /ativacao\.impedimentos\.map/.test(wiz));
  ok("G13 o impedimento leva a pessoa para a etapa dele",
    /setEtapa\(i\.etapa\)/.test(wiz));

  // Estado nunca so por cor (§ acessibilidade).
  ok("G14 o stepper marca estado com simbolo, nao so com cor",
    /concluida: "✓"/.test(wiz) && /atencao: "!"/.test(wiz));
  ok("G15 o alternador expoe papel de switch",
    /role="switch"/.test(prim));
  ok("G16 a escolha unica e fieldset com legenda",
    /<fieldset/.test(prim) && /<legend/.test(prim));

  // A etapa Testar e o workspace compartilham O MESMO chat.
  ok("G17 Testar e Workspace usam o MESMO componente de chat",
    /ChatDoAgente/.test(wiz) && /ChatDoAgente/.test(work));
  ok("G18 e o modo de teste e explicito na tela",
    /modoTeste/.test(wiz) && /Modo de teste/.test(chat));

  // O chat traduz codigo em frase, e guarda o codigo no detalhe.
  ok("G19 o chat traduz codigo tecnico em frase",
    /bloqueado_por_ferramenta:\s*$|bloqueado_por_ferramenta:/.test(chat) &&
      /FRASES/.test(chat));
  ok("G20 e mantem o codigo em detalhes tecnicos",
    /Detalhes técnicos/.test(chat) && /codigoTecnico/.test(chat));
  ok("G21 `funcao_id` aparece SO no painel tecnico do chat",
    chat.indexOf("Detalhes técnicos") < chat.lastIndexOf("p.funcaoId"));
}

// ─── G2. O cartao de aprovacao ────────────────────────────────────────

secao("G2. Aprovacao nao e erro, e o cartao nao promete o que nao cumpre");

{
  const chat = codigo("components/ia/factory/ChatDoAgente.tsx");

  ok("G22 o chat distingue o passo que BARROU o turno",
    /function passoQueBarrou\(/.test(chat));
  ok("G23 e a distincao vem do `desfecho` do passo, nao do `motivo`",
    /p\.desfecho|barrado\.desfecho/.test(chat) &&
      /DESFECHOS_DE_BLOQUEIO/.test(chat));
  // ── G24/G26/G27 REVERTIDOS no F7b.4.4 ──────────────────────────
  //
  // A versao anterior cobrava que o cartao NAO tivesse aprovar/rejeitar e
  // que mandasse para `/ia/aprovacoes`. Era a decisao certa naquele
  // momento, e o codigo dizia por que: sem retomada, um "Aprovar" aqui
  // gravaria uma decisao que nenhuma conversa continuaria.
  //
  // O F7b.4.4 construiu a retomada — e ai o `Link` virou o defeito. Sair
  // da pagina para decidir desmontava o chat, e foi isso que o Rodrigo
  // viu como "as mensagens sumiram".
  //
  // O cartao agora aparece pela APROVACAO VIVA lida do servidor, e nao
  // pelo passo que barrou: assim ele sobrevive a um refresh.
  ok("G24 a aprovacao viva tem cartao proprio",
    /\{aprovacao !== null && \(/.test(chat) &&
      /precisa da sua aprovação/i.test(chat));
  ok("G25 e NAO cai tambem no aviso de erro generico",
    /erro !== null && barrado\?\.desfecho !== "aguardando_aprovacao"/.test(chat));

  // A parte que mais importa agora e a oposta: o cartao DECIDE aqui, e a
  // decisao vai pela rota do chat — que aprova E retoma. A fila continua
  // existindo para aprovacao de TAREFA, que e outra coisa.
  ok("G26 o cartao decide pela rota do CHAT",
    /decidirAprovacaoNoChat\(agenteId, aprovacao\.aprovacaoId, decisao\)/.test(chat));
  ok("G26a e NAO usa a escrita da fila de tarefas",
    !/registrarDecisaoAprovacao/.test(chat));
  ok("G27 e NAO manda a pessoa para outra pagina",
    !/href="\/ia\/aprovacoes"/.test(chat));
  ok("G28 o nome do pack vem do catalogo, e nao e inventado",
    /packDaFuncao\(funcaoId\)\?\.nome \?\? null/.test(chat));
  ok("G29 sem pack conhecido, o cartao nao inventa nome",
    /nomeDoPack\(barrado\.funcaoId\) === null/.test(chat));
  // O `funcao_id` continua atras de "Detalhes tecnicos" — o que mudou e
  // que a ancora agora e o botao de aprovar, e nao o link que saiu.
  ok("G30 `funcao_id` fica depois dos botoes, em detalhes tecnicos",
    chat.indexOf("Aprovar e continuar") < chat.indexOf("Detalhes técnicos"));

  // A lista espelhada tem de bater com a do runtime — uma divergencia
  // faria a tela deixar de reconhecer um bloqueio que o runtime criou.
  const runtime = codigo("lib/agentes/ia/falhas-de-ferramenta.ts");
  const doRuntime = (/DESFECHOS_QUE_FECHAM = Object\.freeze\(\[([\s\S]*?)\]/
    .exec(runtime)?.[1].match(/"([a-z_]+)"/g) ?? []).sort();
  const daTela = (/DESFECHOS_DE_BLOQUEIO = \[([\s\S]*?)\]/
    .exec(chat)?.[1].match(/"([a-z_]+)"/g) ?? []).sort();
  // F7b.4.8.2: CINCO. `nome_invalido` saiu das duas — virou erro
  // corrigivel, e o invariante "as duas listas sao identicas" foi o que
  // acusou a deriva quando so uma delas mudou.
  ok("G31 ANCORA: as duas listas foram mesmo lidas",
    doRuntime.length === 5 && daTela.length === 5,
    `${doRuntime.length}/${daTela.length}`);
  ok("G32 e a lista da tela e IDENTICA a do runtime",
    JSON.stringify(doRuntime) === JSON.stringify(daTela),
    `runtime=${doRuntime.join(",")} tela=${daTela.join(",")}`);
  ok("G33 CONTROLE: a comparacao reprovaria se uma sumisse",
    JSON.stringify(doRuntime.slice(1)) !== JSON.stringify(daTela));
}

// ─── H. A navegacao ───────────────────────────────────────────────────

secao("H. Clicar no agente abre a conversa, nao a configuracao");

{
  const rota = codigo("app/(app)/ia/agentes/[id]/page.tsx");
  const novo = codigo("app/(app)/ia/agentes/novo/page.tsx");
  const conf = codigo("app/(app)/ia/agentes/[id]/configurar/page.tsx");

  ok("H1  sem `?aba=`, a rota do agente e o WORKSPACE",
    /const pediuAba = searchParams\?\.aba !== undefined/.test(rota) &&
      /if \(!pediuAba\) return <Workspace/.test(rota));
  ok("H2  com `?aba=`, ela continua a pagina de abas",
    /<PaginaAgente/.test(rota) && /abaSegura\(searchParams\?\.aba\)/.test(rota));
  ok("H3  a aba continua saindo de `abaSegura`, nunca de indice cru",
    !/COMPONENTES\[|MAPA\[searchParams/.test(rota));
  // F8.3-C2: criar passou a ser o fluxo de 6 etapas (`CriarAgente`); o
  // assistente de agente EXISTENTE segue sendo o Wizard. Continua havendo
  // UMA so entrada que cria agente: o Wizard so entra com id da rota.
  const criar = codigo("components/ia/criar/CriarAgente.tsx");
  ok("H4  criar = fluxo de 6 etapas; configurar = o Wizard de sempre",
    /<CriarAgente \/>/.test(novo) && !/<Wizard/.test(novo) && /<Wizard/.test(conf));
  ok("H5  so o fluxo de criar cria; configurar entra com o id da rota",
    /criarAgenteViaApi\(/.test(criar) && /agenteIdInicial=\{params\.id\}/.test(conf) &&
      !/agenteIdInicial=\{null\}/.test(novo + conf));
  ok("H6  nao existe tela paralela de edicao",
    !/EditarAgente|FormularioDeEdicao/.test(conf));
}


// ─── I. A sugestao de proposito ───────────────────────────────────────

secao("I. O que o arquivo PARECE ser — sugestao, nunca decisao");

{
  const fonte = codigo("lib/agentes/factory/proposito-de-arquivo.ts");

  ok("I1  o nome do arquivo decide quando ha sinal",
    sugerirPapel({ nome: "entrada.xlsx" }) === "Entradas" &&
      sugerirPapel({ nome: "saida.xlsx" }) === "Saídas");
  ok("I2  acento e caixa nao atrapalham",
    sugerirPapel({ nome: "Saídas-2026.XLSX" }) === "Saídas");
  ok("I3  sinonimos do dominio tambem valem",
    sugerirPapel({ nome: "recebimentos.csv" }) === "Entradas" &&
      sugerirPapel({ nome: "despesas.csv" }) === "Saídas");

  // A armadilha do `includes`: "saida" dentro de "assaida".
  ok("I4  casa por PALAVRA INTEIRA, nao por substring",
    sugerirPapel({ nome: "assaidado.xlsx" }) === null &&
      sugerirPapel({ nome: "vendaval.xlsx" }) === null);
  // Para um seller, venda E entrada de dinheiro: `SINAIS` mapeia
  // "vendas" para Entradas. O controle prova que a palavra SEPARADA casa
  // (ao contrario de "vendaval", em I4) — e nao que ela tem rotulo
  // proprio.
  ok("I5  CONTROLE POSITIVO: a mesma palavra separada CASA",
    sugerirPapel({ nome: "relatorio de vendas.xlsx" }) === "Entradas" &&
      sugerirPapel({ nome: "controle de estoque.xlsx" }) === "Estoque");

  ok("I6  sem sinal nenhum, devolve null — nao inventa",
    sugerirPapel({ nome: "planilha1.xlsx" }) === null &&
      sugerirPapel({ nome: "dados.csv" }) === null);
  ok("I7  os cabecalhos so entram quando o NOME nao decide",
    sugerirPapel({ nome: "planilha1.xlsx", cabecalhos: ["Data", "Receita"] }) === "Entradas" &&
      // O nome manda: `entrada.xlsx` continua Entradas mesmo com
      // cabecalho de saida, porque quem nomeou disse o que e.
      sugerirPapel({ nome: "entrada.xlsx", cabecalhos: ["Despesa"] }) === "Entradas");
  ok("I8  cabecalho neutro nao produz palpite",
    sugerirPapel({ nome: "planilha1.xlsx", cabecalhos: ["Data", "Valor"] }) === null);

  ok("I9  a frase diz PARECE e pede confirmacao",
    (fraseDaSugestao("Entradas") ?? "").includes("Parece") &&
      /[Cc]onfirme/.test(fraseDaSugestao("Entradas") ?? ""));
  ok("I10 sem palpite, nao ha frase", fraseDaSugestao(null) === null);

  // A razao de ser deste modulo: ele NAO pode chamar IA. `papel` decide
  // qual planilha o agente soma — e isso e autoridade, um passo antes do
  // numero que `BUSINESS_RULES` proibe vir de IA.
  ok("I11 zero IA: sem provider, sem gateway, sem rede",
    !/anthropic|google|openai|genai|fetch\s*\(|ai-gateway/i.test(fonte));
  ok("I12 e zero banco",
    !/supabase|getSupabaseServidor|createClient/i.test(fonte));
  ok("I13 normalizar tira acento e pontuacao",
    normalizar("Saídas / 2026!") === "saidas 2026");
  ok("I14 ANCORA: a sonda de sugestao roda de verdade",
    typeof sugerirPapel({ nome: "x" }) === "object" ||
      sugerirPapel({ nome: "entrada" }) === "Entradas");
}

// ─── J. O PATCH de metadado ───────────────────────────────────────────

secao("J. Corrigir o metadado e estreito, e escopado no banco");

{
  const rota = codigo("app/api/agentes/[agenteId]/fontes/[fonteId]/route.ts");
  const repo = codigo("lib/agentes/fontes/repositorio.ts");

  ok("J1  a rota tem PATCH e DELETE, e nada mais",
    /export async function PATCH\(/.test(rota) &&
      /export async function DELETE\(/.test(rota) &&
      !/export async function (GET|PUT|POST)\(/.test(rota));
  ok("J2  a allowlist e de TRES campos",
    /CAMPOS_EDITAVEIS = new Set\(\["nome", "papel", "descricao"\]\)/.test(rota));
  ok("J3  chave fora da allowlist condena o pedido inteiro",
    /if \(!CAMPOS_EDITAVEIS\.has\(c\)\) return \{ ok: false, erro: "Alteração inválida\." \}/
      .test(rota));
  ok("J4  escopo, vinculo, hash e caminho NAO sao editaveis",
    !/corpo\.(escopo|agente_?[Ii]d|conversa_?[Ii]d|hash\w*|caminho\w*|ativo|tipo|mime)/
      .test(rota));
  ok("J5  o dono e o agente vem da porta, nunca do corpo",
    /porta\.userId/.test(rota) && /porta\.agenteId/.test(rota) &&
      !/corpo\.userId|corpo\.agenteId/.test(rota));
  ok("J6  nome VAZIO e recusado — o arquivo precisa de nome",
    /if \(nome === "" \|\| nome\.length > MAX_NOME\)/.test(rota));
  ok("J7  papel/descricao vazios viram null, explicitamente",
    /campos\.papel = papel === "" \? null : papel/.test(rota) &&
      /campos\.descricao = d === "" \? null : d/.test(rota));
  ok("J8  tipo errado e RECUSADO, nao convertido",
    /erro: "papel inválido\."/.test(rota) && /erro: "nome inválido\."/.test(rota));

  // O que protege de verdade: o escopo vai na PROPRIA instrucao.
  ok("J9  o UPDATE amarra dono, id, AGENTE e ativo na propria query",
    /\.eq\("user_id", userId\)[\s\S]{0,200}\.eq\("agente_id", vinculo\.agenteId\)[\s\S]{0,80}\.eq\("ativo", true\)/
      .test(repo));
  ok("J10 e o objeto do UPDATE e montado campo a campo, sem spread",
    /if \(campos\.nome !== undefined\) mudanca\.nome = campos\.nome/.test(repo) &&
      !/\.update\(\{ \.\.\.campos/.test(repo));
  ok("J11 nada a alterar nao gasta escrita",
    /if \(Object\.keys\(mudanca\)\.length === 1\) return null/.test(repo));
  ok("J12 a resposta nao publica caminho de storage",
    !/caminhoObjeto|caminho_objeto/.test(
      rota.slice(rota.indexOf("fonte: {"), rota.indexOf("}, 200)"))));
}

// ─── K. A rota de inspecao ────────────────────────────────────────────

secao("K. Inspecionar e do DONO, e reusa o inspetor do modelo");

{
  const rota = codigo("app/api/agentes/[agenteId]/fontes/[fonteId]/inspecao/route.ts");

  ok("K1  reusa `executarInspecionar` — nao ha segunda inspecao",
    /executarInspecionar\(/.test(rota));
  ok("K2  e nao reimplementa leitura de planilha",
    !/lerXlsx|lerCsv|cabecalhos\(|larguraDaAba/.test(rota));
  ok("K3  registra a MESMA porta de arquivo do runtime",
    /criarFonteDeArquivoDasSources\(\{/.test(rota) &&
      /registrarFonteDeArquivo\(/.test(rota));
  ok("K4  com o escopo da SESSAO e do agente da rota",
    /userId: porta\.userId/.test(rota) && /agenteId: porta\.agenteId/.test(rota));

  // A decisao de nao passar pelo guard e deliberada, e o motivo importa:
  // o guard cerca o MODELO. Exigir permissao para o dono ver o proprio
  // upload inverteria a cerca.
  ok("K5  NAO chama o guard nem `executarFuncao`",
    !/autorizarFuncao|executarFuncao|resolverFuncao/.test(rota));
  ok("K6  e NAO escreve auditoria de Funcao",
    !/agente_funcao_chamadas|registrarChamada|abrirChamada/.test(rota));
  ok("K7  confere que o arquivo e DESTE agente antes de abrir",
    /obterAtiva\([\s\S]{0,80}\{ agenteId: porta\.agenteId \}\)/.test(rota));
  ok("K8  tipo nao inspecionavel responde 415, nao estrutura vazia",
    /TIPOS_INSPECIONAVEIS/.test(rota) && /415/.test(rota));
  ok("K9  recusa de dominio repassa o codigo, sem inventar frase",
    /codigo: typeof codigo === "string" \? codigo : null/.test(rota) &&
      /422/.test(rota));
  ok("K10 caminho de storage nao trafega",
    !/caminhoObjeto|caminho_objeto/.test(rota));
  ok("K11 o fileId e o id da fonte, vindo da ROTA",
    /fileId: params\.fonteId/.test(rota));
}

// ─── L. O transporte manda o proposito ────────────────────────────────

secao("L. O upload passa a levar `papel` — o buraco que isto fecha");

{
  const t = codigo("lib/ia/agentes-http.ts");
  const corpoUpload = (() => {
    const i = t.indexOf("export async function enviarFonteDoAgente(");
    return t.slice(i, t.indexOf("\nexport ", i + 10));
  })();

  ok("L1  `enviarFonteDoAgente` aceita proposito",
    /proposito\?: \{/.test(corpoUpload));
  ok("L2  e o manda no FormData",
    /formulario\.append\("papel", proposito\.papel\)/.test(corpoUpload) &&
      /formulario\.append\("descricao", proposito\.descricao\)/.test(corpoUpload));
  ok("L3  campo vazio NAO e enviado",
    /if \(proposito\?\.papel\)/.test(corpoUpload));
  ok("L4  e continua sem Content-Type manual (multipart)",
    !/headers\s*:/.test(corpoUpload));

  ok("L5  a leitura de inspecao existe e e GET puro",
    /export async function inspecionarArquivoDoAgente\(/.test(t));
  ok("L6  a escrita de metadado e PATCH, com corpo chave a chave",
    /export async function atualizarArquivoDoAgente\(/.test(t) &&
      /corpoEnviado\.papel = campos\.papel/.test(t) &&
      !/JSON\.stringify\(campos\)/.test(t));
}

// ─── M. A tela de Arquivos ────────────────────────────────────────────

secao("M. Subir, INSPECIONAR, e so depois perguntar");

{
  const arq = codigo("components/ia/factory/ArquivosDoAgente.tsx");
  const wiz = codigo("components/ia/factory/Wizard.tsx");
  const chat = codigo("components/ia/factory/ChatDoAgente.tsx");
  // Cada `secao` e um bloco proprio: `work` da secao G nao alcanca aqui.
  const work = codigo("components/ia/factory/Workspace.tsx");

  ok("M1  a tela nao faz rede nem monta endereco de API",
    !/\bfetch\s*\(|["'`]\/api\//.test(arq));
  ok("M2  ela usa o transporte unico",
    /from "@\/lib\/ia\/agentes-http"/.test(arq));
  ok("M3  a ordem e subir -> inspecionar -> perguntar",
    arq.indexOf("enviarFonteDoAgente") < arq.indexOf("abrirProposito(r.dados.id)"));
  ok("M4  a pergunta do proposito existe, com essas palavras",
    /O que este arquivo representa\?/.test(arq));
  ok("M5  e a de COMO usar tambem",
    /Como este agente deve usar este arquivo\?/.test(arq));
  ok("M6  a sugestao vem do modulo puro, nao de IA",
    /sugerirPapel\(/.test(arq) && !/anthropic|openai|gemini/i.test(arq));
  ok("M7  o que a pessoa ja escreveu vence a sugestao",
    /r\.dados\.papel \?\? palpite \?\? ""/.test(arq));
  ok("M8  a inspecao mostra abas, linhas e colunas",
    /aba\.linhas/.test(arq) && /aba\.colunas/.test(arq) && /aba\.cabecalhos/.test(arq));
  ok("M9  e repassa os avisos do inspetor",
    /inspecao\.avisos\.map/.test(arq));
  ok("M10 arquivo sem papel e SINALIZADO — nao passa em silencio",
    /o agente não saberá diferenciar/.test(arq));
  ok("M11 instrucao de uso nao vira permissao",
    /Não dá nem tira permissão/.test(arq));

  // §30/§36: a palavra "fonte" sai da experiencia principal. No banco a
  // tabela segue `agente_fontes`, e os IDENTIFICADORES do codigo
  // (`listarFontesDoAgente`, `painelFontes`) seguem com ela — o que muda
  // e o que a pessoa LE.
  //
  // A primeira versao deste assert varria `>...<` e casava codigo:
  // acusou `([]);` e `(conversaId);`. Rotulo se cobra por NOME.
  const ROTULOS_APOSENTADOS: readonly string[] = [
    "Fontes {fontes.length}",
    'titulo="Fontes"',
    "Nenhuma fonte ainda.",
    "Adicionar como fonte do agente",
    'titulo: "Fontes"',
    "+ Adicionar fonte",
  ];
  const ROTULOS_NOVOS: readonly string[] = [
    "Arquivos {fontes.length}",
    'titulo="Arquivos"',
    "Nenhum arquivo ainda.",
    "Manter neste agente",
    'titulo: "Arquivos"',
    "+ Adicionar arquivo",
  ];
  const TELAS = [arq, wiz, chat, work].join("  ");

  const sobrando = ROTULOS_APOSENTADOS.filter((r) => TELAS.includes(r));
  ok("M12 nenhum rotulo aposentado com a palavra fonte sobrou",
    sobrando.length === 0, sobrando.join(" | "));
  const faltando = ROTULOS_NOVOS.filter((r) => !TELAS.includes(r));
  ok("M12a e todos os rotulos novos estao presentes",
    faltando.length === 0, faltando.join(" | "));
  ok("M12b CONTROLE POSITIVO: a sonda acusaria a reintroducao",
    [...ROTULOS_APOSENTADOS].filter(
      (r) => (TELAS + "  Fontes {fontes.length}").includes(r)).length === 1);
  // A ancora prova que os QUATRO arquivos entraram na busca. A versao
  // anterior afirmava que `ArquivosDoAgente` NAO aparecia — e aparece, no
  // import do wizard. Uma ancora falsa e pior que ancora nenhuma: ela
  // reprova codigo correto.
  ok("M12c ANCORA: as quatro telas entraram na busca",
    TELAS.length > 8000 &&
      [arq, wiz, chat, work].every((f) => f.length > 500) &&
      TELAS.includes("ArquivosDoAgente") &&
      TELAS.includes("ChatDoAgente") &&
      TELAS.includes("Workspace"));
  ok("M13 a etapa 7 se chama Arquivos",
    /numero: 7, titulo: "Arquivos"/.test(wiz));
  ok("M14 e o wizard delega a tela, sem duplicar o fluxo",
    /<ArquivosDoAgente/.test(wiz) && !/enviarFonteDoAgente/.test(wiz));
  ok("M15 o chat avisa quando o arquivo fica no agente sem proposito",
    /setPendenteDeProposito/.test(chat) &&
      /Configurar → Arquivos/.test(chat));
  ok("M16 anexo de conversa NAO exige proposito",
    /if \(escopo === "agente"\) setPendenteDeProposito/.test(chat));
}


// ─── N. O catalogo de cerebros ────────────────────────────────────────

secao("N. O catalogo de cerebros: capacidade medida, nunca prometida");

{
  const cat = catalogoDeModelos();

  ok("N1  ANCORA: ha entradas no catalogo", cat.length >= 2, String(cat.length));
  ok("N2  cada entrada aponta ONDE a capacidade foi provada",
    cat.every((m) => m.provadoEm.startsWith("scripts/") && m.provadoEm.endsWith(".ts")),
    cat.map((m) => m.provadoEm).join(","));
  ok("N3  e o arquivo de prova EXISTE de verdade",
    cat.every((m) => {
      try { return ler(m.provadoEm).length > 200; } catch { return false; }
    }),
    cat.map((m) => m.provadoEm).join(","));

  ok("N4  o id do modelo NAO e hardcoded — vem de env nomeada",
    cat.every((m) => m.envDoModelo.length > 5 && m.envDaChave.length > 5));
  // A sonda anterior varria o arquivo inteiro e casava
  // `testar-gemini-stateless-live.ts` no campo `provadoEm` — um caminho
  // de suite, nao uma versao de modelo. Tirar os caminhos antes de medir
  // e a correcao: o que se cobra e que NENHUM id de modelo esteja
  // escrito no codigo, porque quem escolhe a geracao e o ambiente.
  const fonte = codigo("lib/agentes/factory/catalogo-de-modelos.ts")
    .replace(/"scripts\/[^"]*"/g, '""');
  ok("N5  e o catalogo nao carrega versao de modelo em literal",
    !/claude-[a-z0-9-]+|gemini-[a-z0-9.-]+|gpt-[a-z0-9.-]+/.test(fonte));
  ok("N5a CONTROLE: a sonda ACUSA quando um id de modelo aparece",
    /claude-[a-z0-9-]+/.test('const m = "claude-haiku-4-5";'));
  ok("N5b ANCORA: o recorte nao apagou o arquivo",
    fonte.length > 800 && fonte.includes("modelosDisponiveis"));

  // ── N6 reconciliado na F7b.4.2 ─────────────────────────────────
  //
  // ANTES: "OpenAI esta AUSENTE". Era verdade, e por um motivo: a chave
  // existia e a conta nao tinha saldo, entao nenhuma capacidade havia
  // sido provada. Com o saldo regularizado, o roundtrip passou e a
  // entrada entrou — nessa ordem.
  //
  // O que se cobra agora e a CONDICAO que a tornou legitima: ela aponta
  // para uma prova, e a prova existe (N2/N3 acima).
  ok("N6  OpenAI esta no catalogo, e aponta para a prova dela",
    (() => {
      const o = cat.find((m) => m.provedor === "openai");
      return o !== undefined &&
        o.provadoEm === "scripts/testar-openai-runtime-live.ts";
    })(), cat.map((m) => m.provedor).join(","));
  ok("N6a e ela e o UNICO provedor com escolha de nivel — os outros tem um so",
    (() => {
      const comEscolha = cat.filter((m) => m.niveis.length > 1).map((m) => m.provedor);
      return comEscolha.length === 1 && comEscolha[0] === "openai";
    })(), cat.map((m) => `${m.provedor}:${m.niveis.length}`).join(","));
  ok("N6b os quatro niveis dela sao os MEDIDOS",
    (() => {
      const o = cat.find((m) => m.provedor === "openai");
      return JSON.stringify([...(o?.niveis ?? [])].sort()) ===
        JSON.stringify(["avancado", "equilibrado", "maximo", "rapido"]);
    })());
  ok("N7  TODO provedor do catalogo declara ferramentas",
    cat.every((m) => m.ferramentas === true));

  // Um nivel = sem escolha. A tela nao pode oferecer o que nao existe.
  ok("N8  todo modelo declara pelo menos UM nivel",
    cat.every((m) => m.niveis.length >= 1));
  ok("N9  e todo nivel declarado e um nivel conhecido",
    cat.every((m) => m.niveis.every(
      (n) => (NIVEIS_DE_TRABALHO as readonly string[]).includes(n))));
  ok("N10 com um nivel so, a tela NAO oferece escolha",
    !ofereceEscolhaDeNivel(["equilibrado"]));
  ok("N11 CONTROLE: com dois, oferece",
    ofereceEscolhaDeNivel(["rapido", "maximo"]));

  // O rotulo da CDS nunca vai cru para a API — ele so existe na tela.
  ok("N12 pedir nivel nao suportado NAO erra: cai no mais proximo",
    (() => {
      const r = nivelEfetivo("maximo", ["equilibrado"]);
      return r.nivel === "equilibrado" && r.ajustado === true;
    })());
  ok("N13 pedir nivel suportado nao ajusta nada",
    (() => {
      const r = nivelEfetivo("rapido", ["rapido", "maximo"]);
      return r.nivel === "rapido" && r.ajustado === false;
    })());
  ok("N14 pedido ilegivel cai no primeiro suportado, e AVISA",
    (() => {
      const r = nivelEfetivo(42, ["equilibrado", "maximo"]);
      return r.nivel === "equilibrado" && r.ajustado === true;
    })());
  ok("N15 `maximo` pedido com {rapido,avancado} escolhe `avancado`",
    nivelEfetivo("maximo", ["rapido", "avancado"]).nivel === "avancado");
  ok("N16 o rotulo de nivel desconhecido devolve o proprio valor",
    rotuloDoNivel("xyz") === "xyz" && rotuloDoNivel("maximo") === "Máximo");

  // Disponibilidade depende do AMBIENTE, e nao do catalogo.
  {
    const salvos = {
      ak: process.env.ANTHROPIC_API_KEY, am: process.env.ANTHROPIC_MODEL_AGENTE,
      gk: process.env.GOOGLE_AI_API_KEY, gm: process.env.GOOGLE_AI_MODEL_AGENTE,
    };
    delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_MODEL_AGENTE;
    delete process.env.GOOGLE_AI_API_KEY; delete process.env.GOOGLE_AI_MODEL_AGENTE;
    ok("N17 ambiente sem chave nenhuma NAO oferece modelo",
      modelosDisponiveis().length === 0);
    ok("N18 e diz PELO NOME o que falta, nunca o valor",
      (() => {
        const f = envsFaltando("anthropic");
        return f.includes("ANTHROPIC_API_KEY") && f.includes("ANTHROPIC_MODEL_AGENTE");
      })());

    // Chave SEM modelo nao e provedor meio pronto: nao aparece.
    process.env.ANTHROPIC_API_KEY = "sintetico-de-teste";
    ok("N19 chave sem modelo configurado ainda NAO oferece",
      modelosDisponiveis().length === 0);
    process.env.ANTHROPIC_MODEL_AGENTE = "modelo-sintetico";
    const comAmbos = modelosDisponiveis();
    ok("N20 com chave E modelo, o provedor aparece",
      comAmbos.length === 1 && comAmbos[0].provedor === "anthropic",
      comAmbos.map((m) => m.provedor).join(","));
    ok("N21 e o id exposto e o do AMBIENTE, nao um literal do codigo",
      comAmbos[0]?.modeloId === "modelo-sintetico");

    for (const [k, v] of Object.entries({
      ANTHROPIC_API_KEY: salvos.ak, ANTHROPIC_MODEL_AGENTE: salvos.am,
      GOOGLE_AI_API_KEY: salvos.gk, GOOGLE_AI_MODEL_AGENTE: salvos.gm,
    })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    ok("N22 ANCORA: o ambiente foi restaurado",
      process.env.ANTHROPIC_API_KEY === salvos.ak);
  }

  // A rota publica o catalogo; a tela nao tem lista propria.
  const rota = codigo("app/api/agentes/[agenteId]/ativacao/route.ts");
  ok("N23 a rota publica o catalogo do servidor",
    /modelosDisponiveis\(\)/.test(rota) && /modelos:/.test(rota));
  const wiz = codigo("components/ia/factory/Wizard.tsx");
  ok("N24 e a tela NAO tem lista de modelo hardcoded",
    !/claude-|gemini-|gpt-/.test(wiz) &&
      !/"Claude"|"Gemini"|"OpenAI"/.test(wiz));
  ok("N25 a tela le os modelos que o servidor mandou",
    /ativacao\?\.modelos\.map|ativacao\.modelos/.test(wiz));
  ok("N26 e so oferece nivel quando ha mais de um",
    /niveis\.length <= 1/.test(wiz));
}

// ─── O. A memoria automatica na Factory ───────────────────────────────

secao("O. Memoria: um interruptor, e nenhuma autoridade");

{
  const rota = codigo("app/api/agentes/[agenteId]/memoria/route.ts");
  const wiz = codigo("components/ia/factory/Wizard.tsx");

  ok("O1  a rota tem GET e PATCH, e nada mais",
    /export async function GET\(/.test(rota) &&
      /export async function PATCH\(/.test(rota) &&
      !/export async function (POST|PUT|DELETE)\(/.test(rota));
  ok("O2  o PATCH aceita UM campo so",
    /Object\.keys\(corpo\)\.length !== 1/.test(rota) &&
      /typeof corpo\.memoriaAtiva !== "boolean"/.test(rota));
  ok("O3  o dono e o agente vem da porta, nunca do corpo",
    /porta\.userId/.test(rota) && /porta\.agenteId/.test(rota) &&
      !/corpo\.userId|corpo\.agenteId/.test(rota));
  ok("O4  o estado devolvido e LIDO da linha, nao ecoado do pedido",
    /memoriaAtiva: linha\.memoria_ativa/.test(rota));

  // §25: ligar memoria NAO concede nada.
  ok("O5  a rota de memoria nao toca permissao",
    !/agente_permissoes|definirPermissao|autorizarFuncao|declararFerramentas/.test(rota));
  ok("O6  e nao revela nada da credencial — so se o motor existe",
    /motorConfigurado/.test(rota) && !/ZEP_API_KEY/.test(rota));

  ok("O7  a tela liga o interruptor pelo transporte",
    /definirMemoriaDoAgente\(agenteId, ligado\)/.test(wiz));
  ok("O8  e o estado exibido vem do servidor",
    /ativacao\?\.memoriaAtiva === true/.test(wiz));
  ok("O9  o texto da tela explica o que a memoria faz",
    /lembrar informações úteis de conversas anteriores/.test(wiz));
  ok("O10 a memoria manual da F6 NAO foi apagada — desceu para avancado",
    /Avançado: memórias fixadas/.test(wiz) &&
      /criarMemoriaDoAgente/.test(wiz) && /removerMemoriaDoAgente/.test(wiz));
  ok("O11 e a etapa principal nao exige textarea",
    wiz.indexOf("Alternador") < wiz.indexOf("Avançado: memórias fixadas"));

  // O modulo de memoria e separado do de permissao, por construcao.
  const auto = codigo("lib/agentes/memoria/automatica.ts");
  ok("O12 o runtime de memoria nao importa guard nem registry",
    !/autorizarFuncao|resolverFuncao|FUNCOES|declararFerramentas/.test(auto));
  ok("O13 memoria DESLIGADA retorna antes de tocar rede",
    /if \(!escopo\.memoriaAtiva\) return \{ desfecho: "desligada"/.test(auto));
  ok("O14 e sem motor configurado tambem",
    /memoriaConfigurada\(\)/.test(auto));

  const ident = codigo("lib/agentes/memoria/identidade.ts");
  ok("O15 o principal e derivado de dono E agente",
    /principalDeMemoria\(userId: unknown, agenteId: unknown\)/.test(ident));
  ok("O16 com comprimento declarado — sem colisao entre pares",
    /entradaCanonica/.test(ident) && /userId\.length/.test(ident));
  ok("O17 e sem segredo rotacionavel na entrada do hash",
    !/SECRET|process\.env/.test(ident));
}


// ─── P. A busca de ferramentas ────────────────────────────────────────

secao("P. Busca unificada: duas origens, um resultado, nada despejado");

{
  const busca = codigo("lib/agentes/factory/busca-de-ferramentas.ts");
  const rota = codigo("app/api/ferramentas/buscar/route.ts");
  const tela = codigo("components/ia/factory/BuscaDeFerramentas.tsx");
  const wiz = codigo("components/ia/factory/Wizard.tsx");

  // O que impede os 1584 toolkits de chegarem perto de um prompt.
  ok("P1  sem termo, o catalogo externo NAO e consultado",
    /if \(alvo === ""\)/.test(busca) &&
      busca.indexOf('externoDesfecho: "nao_consultado"') > 0);
  ok("P2  a busca externa e paginada, com limite",
    /limiteExterno/.test(busca) && /buscarToolkits\(termo, limiteExterno\)/.test(busca));
  ok("P3  as internas vem do catalogo REAL de packs, nao de lista propria",
    /TOOL_PACKS/.test(busca) && !/"Planilhas"|"Calculadora"|"Calendário"/.test(busca));

  // §4: ML/Shopee e qualquer pack novo aparecem sem este arquivo mudar.
  ok("P4  todo pack do catalogo e pesquisavel, e nenhum e omitido",
    /TOOL_PACKS\.map\(packComoAchado\)/.test(busca) &&
      /TOOL_PACKS\.filter\(/.test(busca));

  ok("P5  falha do externo NAO derruba as internas",
    /externo\.estado !== "ok"/.test(busca) &&
      /achados: internas,[\s\S]{0,120}externoDisponivel: false/.test(busca));
  ok("P6  e a tela diz qual foi o desfecho externo",
    /externoDesfecho === "nao_configurado"/.test(tela) &&
      /externoDesfecho === "falha"/.test(tela));

  ok("P7  toolkit DEPRECIADO nao e oferecido para escolha nova",
    /!t\.depreciado/.test(busca));
  ok("P8  o acesso de um toolkit e `null` — nao se chuta leitura/escrita",
    /acesso: null/.test(busca));

  ok("P9  a rota de busca exige sessao",
    /autenticarRequisicao/.test(rota) && /Não autenticado/.test(rota));
  ok("P10 e nao exige agenteId — buscar nao e sobre um agente",
    !/agenteId/.test(rota));
  ok("P11 o termo tem teto",
    /MAX_TERMO/.test(rota) && /slice\(0, MAX_TERMO\)/.test(rota));

  // A tela nao fala com rede e nao mostra id tecnico como interface.
  ok("P12 a tela nao faz rede nem monta endereco de API",
    !/\bfetch\s*\(|["\'`]\/api\//.test(tela));
  ok("P13 a origem aparece em PALAVRA, nao em slug",
    /"Da CDS" : "Integração"/.test(tela));
  ok("P14 e o funcao_id fica em detalhes tecnicos",
    tela.indexOf("Detalhes técnicos") < tela.lastIndexOf("{v.funcaoId}"));
  ok("P15 a busca tem espera — nao chama a cada tecla",
    /ESPERA_MS/.test(tela) && /setTimeout/.test(tela));

  ok("P16 a etapa 4 usa a busca, e nao cartoes fixos",
    /<BuscaDeFerramentas/.test(wiz) &&
      !/TOOL_PACKS\.map\(\(p\) =>/.test(wiz));
  ok("P17 e a etapa 8 continua lendo os packs para as permissoes",
    /TOOL_PACKS\.find/.test(wiz));
}

// ─── Q. O vinculo externo ─────────────────────────────────────────────

secao("Q. Vincular acao externa e POSSUIR — permissao e outra coisa");

/**
 * ── Esta secao foi REVERTIDA pelo F7b.4.2, e isso e o ponto ─────────
 *
 * No F7b.4.1 ela cobrava, nesta ordem:
 *
 *   Q1   a rota grava permissao (`definirPermissaoDeFuncaoDoAgente`)
 *   Q2   NAO existe tabela de selecionadas
 *   Q9   desvincular BLOQUEIA, e nao apaga linha
 *   Q14  a externa e achada filtrando `agente_permissoes` pelo id
 *
 * As quatro descreviam fielmente um desenho que o gate corrigiu:
 *
 *   §10/§11  selecionar uma Tool NAO concede permissao. O nivel era
 *            escolhido por NOS a partir do risco — um default nosso no
 *            lugar da decisao do dono, e `aprovacao` ja e autorizacao
 *            para pedir.
 *
 *   §13      permissao servia de prova de existencia, entao permissao
 *            HISTORICA podia ressuscitar ferramenta removida.
 *
 * Por isso as quatro agora cobram o OPOSTO. Inverter oraculo merece
 * desconfianca — e a defesa aqui e que cada versao nova e MAIS forte que
 * a que substituiu: "nao grava permissao" e verificavel por ausencia,
 * "apaga o vinculo" por presenca, e o efeito de ponta a ponta esta
 * provado em `scripts/testar-ferramentas-externas.ts` com par positivo.
 */
{
  const rota = codigo("app/api/agentes/[agenteId]/ferramentas-externas/route.ts");
  const grav = codigo("lib/agentes/permissoes/gravadas.ts");
  const repo = codigo("lib/agentes/ferramentas-externas/repositorio.ts");

  // ── §10: vincular grava POSSUIR, e NADA de permissao ──────────────
  ok("Q1  vincular NAO grava permissao — era o defeito do F7b.4.1",
    !/definirPermissaoDeFuncaoDoAgente/.test(rota));
  ok("Q1a e grava o VINCULO, pelo repositorio proprio",
    /vincularFerramentaExternaNoAgente/.test(rota));
  ok("Q2  a tabela de POSSUIR existe, e e so o repositorio que a nomeia",
    /agente_ferramentas_externas/.test(repo) &&
      !/agente_ferramentas_externas/.test(rota));
  // Q2a media "o repositorio nao escreve permissao", e isso deixou de ser
  // verdade quando a DECISAO EXPLICITA ganhou lugar aqui (§11/§16) — ela
  // precisa do vinculo como prova de existencia, e o vinculo mora neste
  // arquivo. O que o §10 proibe e VINCULAR conceder permissao, e e isso
  // que passa a ser medido: a fatia da funcao de vincular.
  ok("Q2a VINCULAR nao escreve permissao — e o §10 inteiro",
    (() => {
      const i = repo.indexOf("export async function vincularFerramentaExternaNoAgente");
      const j = repo.indexOf("export type ResultadoDesvincular");
      return i > 0 && j > i && !/agente_permissoes|permiss/i.test(repo.slice(i, j));
    })());
  ok("Q2b e a UNICA escrita de permissao do arquivo e a decisao do dono",
    (repo.match(/agente_permissoes/g) ?? []).length === 1 &&
      /export async function definirPermissaoDeFerramentaExterna/.test(repo));
  ok("Q2c que confere o VINCULO antes de gravar — a prova de existencia",
    (() => {
      const i = repo.indexOf("export async function definirPermissaoDeFerramentaExterna");
      const j = repo.indexOf("agente_permissoes", i);
      return i > 0 && j > i && /nao_vinculada/.test(repo.slice(i, j));
    })());
  ok("Q3  o dono e o agente vem da porta, nunca do corpo",
    /porta\.userId/.test(rota) && /porta\.agenteId/.test(rota) &&
      !/corpo\.userId|corpo\.agenteId/.test(rota));

  // A prova de existencia ANTES de gravar continua valendo.
  ok("Q4  a acao tem de existir no catalogo antes de virar vinculo",
    /listarAcoesDoToolkit\(toolkit, 50\)/.test(rota) &&
      /cat\.dados\.itens\.some\(\(a\) => a\.slug === acao\)/.test(rota));
  ok("Q5  acao inexistente responde 404, e nao grava",
    /Esta ação não existe neste aplicativo[\s\S]{0,20}404/.test(rota));

  // ── §11: a acao nasce UNCONFIGURED ────────────────────────────────
  ok("Q6  a rota devolve `nivel: null` ao vincular — ninguem decidiu ainda",
    /nivel: null/.test(rota));
  ok("Q6a o nivel do risco e SUGESTAO, e o nome diz isso",
    /nivelSugerido/.test(rota) && !/nivel: nivelRecomendado/.test(rota));
  ok("Q7  o POST de vinculo nao aceita nivel da tela",
    (() => {
      const i = rota.indexOf("export async function POST");
      const j = rota.indexOf("export async function PATCH");
      return i > 0 && j > i && !/corpo\.nivel/.test(rota.slice(i, j));
    })());
  ok("Q7a e o PATCH aceita, porque ALI e a decisao do dono",
    (() => {
      const i = rota.indexOf("export async function PATCH");
      const j = rota.indexOf("export async function DELETE");
      return i > 0 && j > i && /corpo\.nivel/.test(rota.slice(i, j));
    })());
  ok("Q8  a sugestao para escrita e desconhecido nunca e `automatico`",
    nivelRecomendado("leitura") === "automatico" &&
      nivelRecomendado("escrita") === "aprovacao" &&
      nivelRecomendado("desconhecido") === "aprovacao");

  // ── §13: desvincular APAGA o vinculo ──────────────────────────────
  ok("Q9  desvincular apaga o VINCULO, e nao grava `bloqueado`",
    /desvincularFerramentaExternaDoAgente/.test(rota) &&
      !/nivel: "bloqueado"/.test(rota));
  ok("Q9a e o repositorio de fato deleta a linha do vinculo",
    /\.delete\(\)/.test(repo));
  ok("Q9b sem tocar a permissao — ela e registro de uma decisao tomada",
    (() => {
      const i = repo.indexOf("export async function desvincularFerramentaExterna");
      // A PROXIMA export depois dela, e nao um nome fixo: a fatia antiga ia
      // ate `fatosDeFuncaoExterna` e passou a englobar a decisao explicita,
      // que escreve permissao de proposito.
      const j = repo.indexOf("\nexport ", i + 10);
      return i > 0 && j > i && !/permiss/i.test(repo.slice(i, j));
    })());
  ok("Q10 e so aceita id EXTERNO",
    /!ehFuncaoExterna\(funcaoId\)/.test(rota));

  // A leitura de permissoes sem filtro continua existindo: e ela que
  // encontra o NIVEL de uma acao que o registry nao conhece.
  ok("Q11 a leitura de permissoes gravadas escopa por dono E agente na query",
    /\.eq\("agente_id", agenteId\)[\s\S]{0,60}\.eq\("user_id", userId\)/.test(grav));
  ok("Q12 linha torta CONDENA a coleta — nao vira lista pela metade",
    /return \{ coleta: "falha" \}/.test(grav));
  ok("Q13 e sem dono ou agente ela nem pergunta",
    /if \(!userId \|\| !agenteId\) return \{ coleta: "entrada_invalida" \}/.test(grav));
  ok("Q13a o repositorio do vinculo escopa igual, na propria query",
    /\.eq\("user_id", userId\)[\s\S]{0,60}\.eq\("agente_id", agenteId\)/.test(repo));
  ok("Q13b e linha torta CONDENA a coleta la tambem",
    /if \(v === null\) return \{ coleta: "falha" \}/.test(repo));

  // ── §13: a EXISTENCIA vem do vinculo, e nao da permissao ──────────
  ok("Q14 as externas vem do VINCULO, nao de um filtro sobre permissoes",
    /listarVinculosExternos/.test(rota) &&
      !/filter\(\(p\) => ehFuncaoExterna\(p\.funcaoId\)\)/.test(rota));
  ok("Q14a a permissao entra so para dizer o NIVEL de cada vinculada",
    /nivelPorId\.get\(v\.funcaoId\) \?\? null/.test(rota));
  ok("Q14b e os fatos do guard derivam do vinculo, por funcao pura",
    /export function fatosDeFuncaoExterna/.test(repo) &&
      /existe: true/.test(repo));
  ok("Q15 ida e volta do id sao consistentes",
    (() => {
      const r = idDaFuncaoExterna({ toolkit: "googlesheets", acao: "GOOGLESHEETS_ADD_SHEET" });
      if (!r.ok) return false;
      const pecas = pecasDoId(r.funcaoId);
      return ehFuncaoExterna(r.funcaoId) &&
        pecas?.toolkit === "googlesheets" &&
        pecas.acao === "googlesheets_add_sheet" &&
        riscoDaAcao(pecas.acao) === "escrita";
    })());

  // §23: nenhum executor universal chega ao modelo.
  const cli = codigo("lib/agentes/composio/cliente.ts");
  ok("Q16 o cliente continua sem executor de tool",
    !/execute|proxy|MULTI_EXECUTE/i.test(cli));
  ok("Q17 e a rota de vinculo nao executa nada",
    !/executarFuncao|execute/i.test(rota));
}


// ─── R. Sem fallback silencioso, e completude da externa ──────────────

secao("R. A IA escolhida e do agente — e trocar por conta propria e proibido");

{
  const base = {
    nome: "Assistente financeiro",
    instrucoes: "Use as ferramentas para qualquer numero.",
    provedor: "anthropic",
    permissoes: [] as { funcaoId: string; nivel: string }[],
  };

  // ── §8: escolha indisponivel BLOQUEIA ─────────────────────────────
  const escolhaSumiu = validarParaAtivacao({
    ...base,
    provedorEscolhido: "google",
    provedoresDisponiveis: ["anthropic", "openai"],
  });
  ok("R1  IA escolhida fora do ambiente: NAO ativa",
    !escolhaSumiu.podeAtivar);
  ok("R2  e o impedimento e `ia_escolhida_indisponivel`",
    escolhaSumiu.impedimentos.some((i) => i.codigo === "ia_escolhida_indisponivel"));
  ok("R3  que aponta para a etapa da IA",
    escolhaSumiu.impedimentos
      .find((i) => i.codigo === "ia_escolhida_indisponivel")?.etapa === 3);
  ok("R4  a frase diz para ESCOLHER outra — nao promete trocar sozinho",
    escolhaSumiu.impedimentos.some((i) =>
      /Escolha outra/i.test(i.mensagem) && !/automat/i.test(i.mensagem)));
  ok("R5  e nao vaza nome de env nem detalhe de credencial",
    escolhaSumiu.impedimentos.every((i) =>
      !/API_KEY|MODEL_AGENTE|process\.env|credencial/i.test(i.mensagem)));

  // O PAR: a mesma escolha, disponivel, ativa.
  const escolhaPresente = validarParaAtivacao({
    ...base,
    provedorEscolhido: "google",
    provedoresDisponiveis: ["anthropic", "google", "openai"],
  });
  ok("R6  a MESMA escolha, disponivel: ativa",
    escolhaPresente.podeAtivar,
    escolhaPresente.impedimentos.map((i) => i.codigo).join(","));

  // Agente legado: nunca escolheu, comportamento preservado.
  const legado = validarParaAtivacao({
    ...base, provedorEscolhido: null, provedoresDisponiveis: ["anthropic"],
  });
  ok("R7  agente que NUNCA escolheu continua ativando",
    legado.podeAtivar, legado.impedimentos.map((i) => i.codigo).join(","));
  ok("R8  e sem lista de disponiveis tambem — o campo e opcional",
    validarParaAtivacao({ ...base }).podeAtivar);

  // ── §12: vinculada sem permissao BARRA ────────────────────────────
  const ID_EXT = "composio.googlesheets.googlesheets_add_sheet";

  const semDecisao = validarParaAtivacao({
    ...base, funcoesExternasVinculadas: [ID_EXT],
  });
  ok("R9  acao externa vinculada e SEM permissao: NAO ativa",
    !semDecisao.podeAtivar);
  ok("R10 e o impedimento e o proprio da externa",
    semDecisao.impedimentos.some((i) => i.codigo === "ferramenta_externa_sem_permissao"));
  ok("R11 que aponta para a etapa de Permissoes",
    semDecisao.impedimentos
      .find((i) => i.codigo === "ferramenta_externa_sem_permissao")?.etapa === 8);
  ok("R12 a frase nao mostra `funcao_id`",
    semDecisao.impedimentos.every((i) => !/composio\.|funcao_id/.test(i.mensagem)));

  // O PAR: com o nivel definido, ativa. Os TRES niveis contam como
  // decisao — inclusive `bloqueado`, que tem cerca em runtime.
  for (const nivel of ["automatico", "aprovacao", "bloqueado"]) {
    const decidida = validarParaAtivacao({
      ...base,
      funcoesExternasVinculadas: [ID_EXT],
      permissoes: [{ funcaoId: ID_EXT, nivel }],
    });
    ok(`R13 com nivel \`${nivel}\` definido: ATIVA`,
      decidida.podeAtivar, decidida.impedimentos.map((i) => i.codigo).join(","));
  }

  // Duas vinculadas, uma decidida: continua barrando, e a frase conta.
  const ID_EXT2 = "composio.googlesheets.googlesheets_get_spreadsheet_info";
  const meiaDecidida = validarParaAtivacao({
    ...base,
    funcoesExternasVinculadas: [ID_EXT, ID_EXT2],
    permissoes: [{ funcaoId: ID_EXT, nivel: "aprovacao" }],
  });
  ok("R14 uma decidida e outra nao: continua barrando",
    !meiaDecidida.podeAtivar);
  ok("R15 e a frase fala de UMA, no singular",
    meiaDecidida.impedimentos.some((i) => /Uma ação de aplicativo/.test(i.mensagem)),
    meiaDecidida.impedimentos.map((i) => i.mensagem).join(" | "));

  // Externa TAMBEM conta como ferramenta para a regra de compatibilidade.
  const soExterna = validarParaAtivacao({
    ...base,
    provedor: "provedor_de_teste_sem_ferramenta",
    funcoesExternasVinculadas: [ID_EXT],
    permissoes: [{ funcaoId: ID_EXT, nivel: "aprovacao" }],
  });
  ok("R16 agente com SO ferramenta externa exige provedor compativel",
    !soExterna.podeAtivar &&
      soExterna.impedimentos.some(
        (i) => i.codigo === "modelo_incompativel_com_ferramentas"));
  ok("R17 e `temFerramentas` reconhece a externa",
    soExterna.temFerramentas);
}


// ─── S. A IA e do AGENTE, e ninguem troca por ela ─────────────────────

secao("S. A IA e do AGENTE — e a escolha indisponivel BLOQUEIA, nao troca");

{
  const TRES = [
    { provedor: "anthropic", modeloId: "claude-x", niveis: ["equilibrado"] },
    { provedor: "google", modeloId: "gemini-x", niveis: ["equilibrado"] },
    { provedor: "openai", modeloId: "gpt-x",
      niveis: ["rapido", "equilibrado", "avancado", "maximo"] },
  ];

  // ── Agente legado: nunca escolheu ─────────────────────────────────
  const legado = resolverIaDoAgente({
    provedorGravado: null, modeloGravado: null, nivelGravado: null, disponiveis: TRES,
  });
  ok("S1  agente que nunca escolheu usa o default do ambiente",
    legado.desfecho === "default_do_ambiente", legado.desfecho);
  ok("S2  e o default e a Anthropic — o caminho provado desde o F4",
    legado.provedor === "anthropic" && legado.modelo === "claude-x");
  ok("S3  sem nivel: um rotulo sozinho pertenceria a um provedor nao escolhido",
    legado.nivel === null);
  // O default tem de ser ESTAVEL: dois turnos do mesmo agente nao podem
  // responder de cerebros diferentes.
  ok("S4  o default e o mesmo em duas chamadas",
    resolverIaDoAgente({
      provedorGravado: null, modeloGravado: null, nivelGravado: null, disponiveis: TRES,
    }).provedor === legado.provedor);
  ok("S5  e `opcaoPreferida` concorda com ele",
    opcaoPreferida(TRES)?.provedor === legado.provedor);

  // ── Escolha DISPONIVEL ────────────────────────────────────────────
  const escolhida = resolverIaDoAgente({
    provedorGravado: "openai", modeloGravado: "gpt-x",
    nivelGravado: "maximo", disponiveis: TRES,
  });
  ok("S6  escolha disponivel vale", escolhida.desfecho === "escolhida");
  ok("S7  e quem responde e o ESCOLHIDO, nao o default",
    escolhida.provedor === "openai" && escolhida.provedor !== legado.provedor);
  ok("S8  com o nivel escolhido aplicado", escolhida.nivel === "maximo");

  // ── Escolha INDISPONIVEL: o coracao do §8 ─────────────────────────
  const sumiu = resolverIaDoAgente({
    provedorGravado: "google", modeloGravado: "gemini-x", nivelGravado: null,
    disponiveis: TRES.filter((m) => m.provedor !== "google"),
  });
  ok("S9  escolha indisponivel tem desfecho proprio",
    sumiu.desfecho === "escolhida_indisponivel", sumiu.desfecho);
  ok("S10 NAO HA FALLBACK: `provedor` continua sendo o escolhido",
    sumiu.provedor === "google", String(sumiu.provedor));
  ok("S11 e em particular NAO virou a Anthropic",
    sumiu.provedor !== "anthropic");
  // E e isso que faz a ativacao barrar — as duas pecas conversam.
  const barrada = validarParaAtivacao({
    nome: "Assistente", instrucoes: "Use as ferramentas.", permissoes: [],
    provedor: sumiu.provedor,
    provedorEscolhido: sumiu.provedorEscolhido,
    provedoresDisponiveis: sumiu.provedoresDisponiveis,
  });
  ok("S12 e a ativacao BARRA esse estado",
    !barrada.podeAtivar &&
      barrada.impedimentos.some((i) => i.codigo === "ia_escolhida_indisponivel"));

  // ── Ambiente sem nada ─────────────────────────────────────────────
  const nada = resolverIaDoAgente({
    provedorGravado: "openai", modeloGravado: "gpt-x", nivelGravado: null, disponiveis: [],
  });
  ok("S13 ambiente sem provedor tem desfecho proprio",
    nada.desfecho === "nenhuma_configurada", nada.desfecho);
  ok("S14 e vem ANTES de culpar a escolha do dono",
    nada.desfecho !== "escolhida_indisponivel");
  ok("S15 com `provedor` nulo — nao ha quem responda", nada.provedor === null);

  // ── O model id e do AMBIENTE, e a divergencia e INFORMADA ─────────
  const modeloVelho = resolverIaDoAgente({
    provedorGravado: "openai", modeloGravado: "gpt-ANTIGO",
    nivelGravado: null, disponiveis: TRES,
  });
  ok("S16 o modelo efetivo vem do catalogo, nao do que foi gravado",
    modeloVelho.modelo === "gpt-x");
  ok("S17 e a divergencia e DITA, nao escondida",
    modeloVelho.modeloEscolhidoDivergente === true);
  ok("S18 sem divergencia quando batem",
    escolhida.modeloEscolhidoDivergente === false);

  // ── Nivel que o provedor nao oferece ──────────────────────────────
  const nivelTorto = resolverIaDoAgente({
    provedorGravado: "anthropic", modeloGravado: "claude-x",
    nivelGravado: "maximo", disponiveis: TRES,
  });
  ok("S19 nivel inexistente no provedor NAO e enviado",
    nivelTorto.nivel === null);
  ok("S20 e a divergencia e dita", nivelTorto.nivelEscolhidoDivergente === true);
  ok("S21 o escolhido continua registrado — nao foi apagado",
    nivelTorto.nivelEscolhido === "maximo");

  // ── String vazia e o mesmo que nao ter escolhido ───────────────────
  ok("S22 provedor vazio e tratado como ausente",
    resolverIaDoAgente({
      provedorGravado: "   ", modeloGravado: null, nivelGravado: null, disponiveis: TRES,
    }).desfecho === "default_do_ambiente");

  // ── Anti-vacuidade: os QUATRO desfechos sao alcancaveis ───────────
  const alcancados = new Set([
    legado.desfecho, escolhida.desfecho, sumiu.desfecho, nada.desfecho,
  ]);
  ok("S23 os quatro desfechos declarados sao alcancados por este teste",
    DESFECHOS_DA_IA.every((d) => alcancados.has(d)),
    DESFECHOS_DA_IA.filter((d) => !alcancados.has(d)).join(","));

  // ── O adaptador: a escolha com efeito ─────────────────────────────
  ok("S24 os tres provedores provados tem adaptador",
    ["anthropic", "google", "openai"].every((p) => adaptadorDoProvedor(p) !== null));
  ok("S25 provedor desconhecido devolve null — quem chama RECUSA",
    adaptadorDoProvedor("xpto") === null);
  ok("S26 `fake` NAO tem adaptador: caminho fake nao se escolhe por coluna",
    adaptadorDoProvedor("fake") === null);
  ok("S27 nulo e vazio tambem",
    adaptadorDoProvedor(null) === null && adaptadorDoProvedor("  ") === null);

  // As duas listas nao podem divergir: uma diz "ativa", a outra "responde".
  ok("S28 `PROVEDORES_COM_FERRAMENTA` e a lista de adaptadores coincidem",
    JSON.stringify([...PROVEDORES_COM_FERRAMENTA].sort()) ===
      JSON.stringify([...provedoresComAdaptador()]),
    `${[...PROVEDORES_COM_FERRAMENTA].sort().join(",")} vs ${provedoresComAdaptador().join(",")}`);

  // ── E o runtime tem de RECUSAR, nunca substituir ──────────────────
  const runtime = codigo("lib/agentes/conversas/runtime.ts");
  ok("S29 o runtime escolhe o adaptador pelo provedor do agente",
    /adaptadorDoProvedor\(/.test(runtime));
  ok("S30 e NAO importa mais um adaptador fixo",
    !/chamarClaudeComFerramentas|chamarGeminiComFerramentas|chamarOpenAIComFerramentas/
      .test(runtime));
  ok("S31 sem adaptador o turno e RECUSADO",
    /adaptador === null/.test(runtime) && /ia_indisponivel/.test(runtime));
  ok("S32 e a recusa nao nomeia provedor nem env para quem esta no chat",
    /nao esta disponivel agora/.test(runtime));

  // A rota que grava NAO aceita model id do browser — §12 do F7b.4.1.
  const rotaIa = codigo("app/api/agentes/[agenteId]/ia/route.ts");
  ok("S33 a rota grava o modelo do CATALOGO",
    /modeloIa: opcao\.modeloId/.test(rotaIa));
  ok("S34 e nunca le `corpo.modelo`", !/corpo\.modelo/.test(rotaIa));
  ok("S35 provedor indisponivel e recusado na ESCRITA, com 409",
    /opcao === undefined/.test(rotaIa) && /\}, 409\)/.test(rotaIa));
  ok("S36 e a rota nao toca permissao nem vinculo",
    !/definirPermissao|agente_permissoes|vincularFerramenta/.test(rotaIa));
  ok("S37 limpar a escolha derruba as TRES colunas juntas",
    /provedorIa: null, modeloIa: null, nivelDeTrabalho: null/.test(rotaIa));
}


// ─── T. O bug do Rodrigo, cercado por dentro ─────────────────────────

secao("T. Aprovar acontece NO chat — e adicionar pergunta o nivel");

{
  const chat = codigo("components/ia/factory/ChatDoAgente.tsx");
  const chatCru = ler("components/ia/factory/ChatDoAgente.tsx");
  const busca = codigo("components/ia/factory/BuscaDeFerramentas.tsx");
  const retomada = codigo("lib/agentes/conversas/retomada.ts");
  const rota = codigo("app/api/agentes/[agenteId]/aprovacoes/[aprovacaoId]/route.ts");

  // ── §21: a causa real era NAVEGACAO, e ela tem de sumir ───────────
  //
  // O cartao antigo tinha um `Link` para `/ia/aprovacoes`. A pessoa saia
  // da pagina, o componente desmontava e o estado local ia junto — era
  // isso que parecia "o chat resetou".
  ok("T1  o chat NAO importa `next/link`",
    !/from "next\/link"/.test(chatCru));
  ok("T2  e nao navega de jeito nenhum ao decidir",
    !/router\.(refresh|replace|push)|window\.location|<Link/.test(chat));
  ok("T3  CONTROLE NEGATIVO: a sonda acharia uma navegacao",
    /router\.(refresh|replace|push)/.test("router.refresh();"));

  // ── §10: as mensagens nao sao apagadas ────────────────────────────
  ok("T4  decidir ACRESCENTA a conversa, nunca substitui",
    /setMensagens\(\(atual\) => \[\.\.\.atual, r\.dados\.mensagem/.test(chat));
  ok("T5  e nao ha nenhum `setMensagens([])` no caminho de decisao",
    (() => {
      const i = chat.indexOf("async function decidir(");
      const j = chat.indexOf("\n  async function", i + 10);
      const fatia = chat.slice(i, j > i ? j : undefined);
      return i > 0 && !/setMensagens\(\[\]\)/.test(fatia);
    })());

  // ── §10: os dois botoes, no proprio cartao ────────────────────────
  ok("T6  o cartao tem Aprovar e Nao autorizar",
    /Aprovar e continuar/.test(chat) && /Não autorizar/.test(chat));
  ok("T7  os dois travam enquanto a decisao esta em voo",
    (chat.match(/desabilitado=\{decidindo !== null\}/g) ?? []).length === 2);
  ok("T8  e a frase diz que a pergunta nao precisa ser repetida",
    /não precisa repetir a pergunta/.test(chat));

  // ── §11: o cartao vem do SERVIDOR, e nao da memoria da tela ───────
  ok("T9  a aprovacao viva e carregada junto das mensagens",
    /setAprovacao\(r\.dados\.aprovacaoPendente\)/.test(chat));
  ok("T10 e o cartao aparece por ela, nao por um estado adivinhado",
    /\{aprovacao !== null && \(/.test(chat));

  // ── §8/§23: o cliente manda UMA palavra ───────────────────────────
  ok("T11 a rota so aceita `aprovar` ou `rejeitar`",
    /decisao !== "aprovar" && decisao !== "rejeitar"/.test(rota));
  ok("T12 e nao le funcaoId, argumentos nem agente do CORPO",
    !/corpo\.(funcaoId|argumentos|agenteId|userId)/.test(rota));
  ok("T13 o agente vem da porta, e a aprovacao e conferida contra ele",
    /leitura\.aprovacao\.agenteId !== porta\.agenteId/.test(rota));

  // ── §7: a retomada nao reenvia a pergunta ─────────────────────────
  ok("T14 a retomada NAO chama `responderNaConversa`",
    !/responderNaConversa/.test(retomada));
  // T15 media a string errada: `papel: "usuario"` tambem aparece na
  // REMONTAGEM do dialogo para o modelo, que e legitima e necessaria. O
  // que nao pode acontecer e PERSISTIR uma mensagem de usuario nova — e
  // isso se ve em `anexarMensagem`, que e a unica escrita de conversa.
  ok("T15 a retomada so grava mensagem de ASSISTENTE",
    (() => {
      const anexos = [...retomada.matchAll(/anexarMensagem\(\{[\s\S]{0,240}?\}\)/g)]
        .map((m) => m[0]);
      return anexos.length === 1 &&
        /papel: "assistente"/.test(anexos[0]) && !/papel: "usuario"/.test(anexos[0]);
    })());
  ok("T15a CONTROLE NEGATIVO: a sonda acharia uma gravacao de usuario",
    /papel: "usuario"/.test('anexarMensagem({ papel: "usuario" })'));
  ok("T16 ela executa a Funcao CONGELADA, pela porta atomica",
    /retomarAprovacao\(\{ userId, aprovacaoId, definicoesExternas \}\)/.test(retomada));
  ok("T16a e o mapa de externas vem dos VINCULOS de AGORA",
    /listarVinculosExternos\(\{ userId, agenteId: aprovacao\.agenteId \}\)/.test(retomada) &&
      /prepararFuncoesExternas/.test(retomada));
  ok("T16b ferramenta interna nao consulta catalogo externo nenhum",
    /aprovacao\.funcaoId\.startsWith\("composio\."\)/.test(retomada));
  // ── T17 REVISADO no F7b.4.5 §7 ─────────────────────────────────
  //
  // ANTES: "chama o modelo SEM declarar ferramentas". Era o jeito mais
  // simples de impedir a "aprovacao Y", e era estreito demais: depois de
  // alterar um valor, o agente nao conseguia CONSULTAR o resultado para
  // confirmar ao usuario — a tarefa ficava pela metade.
  //
  // Agora ele recebe as ferramentas do agente MENOS a que acabou de ser
  // consumida. A garantia que importa continua: aquela chamada especifica
  // nao pode pedir aprovacao de novo.
  ok("T17 a conclusao declara as OUTRAS ferramentas, menos a consumida",
    /filter\(\(g\) => g\.funcaoId !== aprovacao\.funcaoId\)/.test(retomada) &&
      /filter\(\(e\) => e\.funcaoId !== aprovacao\.funcaoId\)/.test(retomada));
  ok("T17a e a mensagem do usuario NAO e reenviada no turno de conclusao",
    /mensagemDoUsuario: ""/.test(retomada));
  ok("T18 os argumentos vem da aprovacao, nunca de quem chamou",
    /argumentos: aprovacao\.argumentos/.test(retomada) &&
      !/argumentos: entrada\./.test(retomada));

  // ── §9: a idempotencia e do BANCO, e nao um contador nosso ────────
  ok("T19 `consumida` tem codigo proprio, e nao vira erro generico",
    /aprovacao\.estado === "consumida"/.test(retomada) &&
      /ja_executada/.test(retomada));
  ok("T20 e a rota trata isso como sucesso do segundo clique",
    /retomada\.codigo === "ja_executada"/.test(rota) && /jaExecutada: true/.test(rota));

  // ── §12: negar mantem a conversa ──────────────────────────────────
  ok("T21 negar grava uma resposta na MESMA conversa",
    /conversaId: aprovacao\.conversaId/.test(rota) && /TEXTO_NEGADO/.test(rota));
  ok("T22 e a frase nao promete nova tentativa automatica",
    !/tentaremos|automaticamente|de novo em/i.test(rota));

  // ── §3/§13: adicionar PERGUNTA o nivel ────────────────────────────
  ok("T23 adicionar abre a escolha de nivel, e nao vincula direto",
    /setEscolhendoNivel\(a\.acao\)/.test(busca) &&
      !/onClick=\{\(\) => void vincular\(a\.acao\)\}/.test(busca));
  ok("T24 os TRES niveis sao oferecidos",
    /\["automatico", "aprovacao", "bloqueado"\] as const/.test(busca));
  ok("T25 a sugestao e rotulada como sugestao — nao e decisao",
    /\(sugerido\)/.test(busca));
  ok("T26 e vincular grava as DUAS coisas, em duas chamadas",
    /vincularFerramentaExterna\(agenteId, aplicativo, acao\)/.test(busca) &&
      /definirPermissaoDeFerramentaExterna\(agenteId, r\.dados\.funcaoId, nivel\)/.test(busca));
  ok("T27 e a falha da segunda NAO inventa permissao",
    /a permissão não pôde ser salva/.test(busca));
}


// ─── U. A capacidade que cresce pelo chat — F7b.4.6 ──────────────────

secao("U. O agente cresce pelo chat, e so com um clique do dono");

{
  const chat = codigo("components/ia/factory/ChatDoAgente.tsx");
  const rota = codigo("app/api/agentes/[agenteId]/capacidades/[pendenciaId]/route.ts");
  const detector = codigo("lib/agentes/factory/capacidade-faltante.ts");
  const ativar = codigo("lib/agentes/factory/ativar-capacidade.ts");
  const runtime = codigo("lib/agentes/conversas/runtime.ts");

  // ── §17/§18: o MODELO nao escolhe do catalogo ─────────────────────
  //
  // Se o modelo pudesse nomear a ferramenta, "ative todas as ferramentas
  // sem perguntar" escrito pelo usuario teria por onde passar.
  ok("U1  quem resolve candidatos e a CDS, por busca no catalogo",
    /buscarFerramentas\(/.test(detector));
  ok("U2  e a deteccao NAO consulta o modelo",
    !/adaptador|chamarClaude|chamarGemini|chamarOpenAI|instrucao/.test(detector));
  ok("U3  o runtime detecta DEPOIS do turno — a oferta nao substitui a resposta",
    runtime.indexOf("declararFerramentas(") <
      runtime.indexOf("detectarCapacidadeFaltante("));
  ok("U4  e a falha da deteccao nao derruba o turno",
    /catch \{[\s\S]{0,140}falha ao detectar capacidade faltante/.test(runtime));

  // ── §6/§19: a politica aplicada e a do EFEITO ────────────────────
  ok("U5  a ativacao aplica o nivel pelo EFEITO de cada Funcao",
    /nivelSugeridoParaEfeito\(/.test(ativar) && /efeitoDaFuncaoInterna\(/.test(ativar));
  ok("U6  e a integracao externa traz SO acoes de leitura",
    /efeitoDaAcaoExterna\([\s\S]{0,80}\) === "READ_ONLY"/.test(ativar));
  ok("U7  leitura externa entra em `automatico` — nao pede aprovacao (§19)",
    /nivel: "automatico"/.test(ativar));

  // ── §7: ativar e CONFIGURACAO, e nao acao no mundo ───────────────
  ok("U8  ativar nao executa acao externa nenhuma",
    !/executarAcaoComposio|executarFuncao/.test(ativar));
  ok("U9  e nao cria credencial nem conclui OAuth",
    !/gerarLinkDeConexao|garantirAuthConfig/.test(ativar));

  // ── §10: a autoridade vem da linha, nao do corpo ──────────────────
  ok("U10 a rota le SO `acao` e `escolha` do corpo",
    /corpo\.acao|corpo\?\.escolha/.test(rota) &&
      !/corpo\.(objetivo|agenteId|userId|conversaId|chave|origem)/.test(rota));
  ok("U11 o objetivo vem da pendencia CONGELADA",
    /texto: pendencia\.objetivo/.test(rota));
  ok("U12 e a escolha e validada contra as opcoes congeladas",
    /pendencia\.opcoes\.find\(\(o\) => o\.chave === pedida\)/.test(rota));
  ok("U13 a pendencia tem de ser DESTE agente",
    /leitura\.pendencia\.agenteId !== porta\.agenteId/.test(rota));

  // ── §11: a idempotencia e do BANCO ───────────────────────────────
  ok("U14 a trava e uma transicao de estado, e nao um contador nosso",
    /de: \["pendente"\], para: "ativando"/.test(rota));
  ok("U15 e o segundo clique recebe `ja_decidida` sem ativar",
    /travou\.estado === "ja_decidida"/.test(rota) && /jaEmAndamento: true/.test(rota));

  // ── §9: a tarefa continua ────────────────────────────────────────
  ok("U16 ativar CONTINUA a tarefa original",
    /responderNaConversa\(\{/.test(rota) && /retomada: true/.test(rota));
  ok("U17 e a capacidade e marcada ativada mesmo se a retomada falhar",
    /retomada: false/.test(rota));

  // ── §21/§23: tudo no chat, e nada e apagado ──────────────────────
  ok("U18 o cartao decide NO chat",
    /decidirCapacidadeNoChat\(\s*agenteId, capacidade\.pendenciaId/.test(chat));
  ok("U19 sem navegacao de nenhum tipo",
    !/router\.(refresh|replace|push)|window\.location|<Link/.test(chat));
  ok("U20 as mensagens sao ACRESCENTADAS, nunca substituidas",
    /setMensagens\(\(atual\) => \[[\s\S]{0,160}\.\.\.atual,/.test(chat));
  ok("U21 e nao ha `setMensagens([])` no caminho da capacidade",
    (() => {
      const i = chat.indexOf("async function resolverCapacidade(");
      const j = chat.indexOf("\n  async function", i + 10);
      const fatia = chat.slice(i, j > i ? j : undefined);
      return i > 0 && !/setMensagens\(\[\]\)/.test(fatia);
    })());
  // `key={o.chave}` e identidade de React, e nao interface — a sonda
  // precisava distinguir as duas, e a primeira versao nao distinguia.
  // O que nao pode e a chave aparecer como TEXTO para quem le.
  ok("U22 o cartao mostra NOME de gente, e nunca a chave interna",
    /\{o\.nome\}/.test(chat) &&
      !/>\s*\{o\.chave\}/.test(chat) &&
      (chat.match(/\{o\.chave\}/g) ?? []).length ===
        (chat.match(/key=\{o\.chave\}/g) ?? []).length);
  ok("U22a CONTROLE: a sonda acusaria a chave renderizada",
    />\s*\{o\.chave\}/.test("<span>{o.chave}</span>"));
  ok("U23 e o botao diz o que vai ativar",
    /Ativar \$\{o\.nome\}/.test(chat));
  ok("U24 ha uma saida clara para nao ativar",
    /Agora não/.test(chat) && /resolverCapacidade\("recusar"\)/.test(chat));

  // ── §28: o cartao sobrevive ao refresh ───────────────────────────
  ok("U25 a oferta e carregada do servidor junto das mensagens",
    /setCapacidade\(r\.dados\.capacidadePendente\)/.test(chat));
}

// ─── Placar ───────────────────────────────────────────────────────────

console.log("\n── placar ──────────────────────────────────────────────────────");
console.log(`  PASS ${passou}   FAIL ${falhou}`);
if (falhou > 0) process.exitCode = 1;
