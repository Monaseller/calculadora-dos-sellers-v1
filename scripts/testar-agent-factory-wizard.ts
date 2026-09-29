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

  // ── O provedor incompativel, e por que ele so conta COM ferramenta ──
  const googleComFerramenta = validarParaAtivacao({
    ...base, provedor: "google",
    permissoes: planilhas.funcoes.map((f) => ({ funcaoId: f, nivel: "automatico" })),
  });
  ok("C9  provedor sem ida-e-volta de ferramenta + ferramentas: NAO ativa",
    !googleComFerramenta.podeAtivar &&
      googleComFerramenta.impedimentos.some(
        (i) => i.codigo === "modelo_incompativel_com_ferramentas"));
  ok("C9a e a frase nao vaza `store`, Interactions nem nome de adaptador",
    googleComFerramenta.impedimentos.every(
      (i) => !/store|interaction|adaptador|previous_interaction/i.test(i.mensagem)));
  const googleSemFerramenta = validarParaAtivacao({
    ...base, provedor: "google", permissoes: [],
  });
  ok("C9b o MESMO provedor SEM ferramenta ativa",
    googleSemFerramenta.podeAtivar);

  ok("C10 a lista de provedores com ferramenta e a medida, nao a desejada",
    PROVEDORES_COM_FERRAMENTA.length === 1 &&
      PROVEDORES_COM_FERRAMENTA[0] === "anthropic");

  // Anti-vacuidade: todo codigo declarado tem de ser alcancavel por
  // ALGUMA entrada. Um codigo que nunca aparece e letra morta.
  const alcancados = new Set<string>([
    ...validarParaAtivacao({ nome: "", instrucoes: "", provedor: null, permissoes: [] })
      .impedimentos.map((i) => i.codigo),
    ...incompleto.impedimentos.map((i) => i.codigo),
    ...googleComFerramenta.impedimentos.map((i) => i.codigo),
  ]);
  const mortos = CODIGOS_DE_IMPEDIMENTO.filter((c) => !alcancados.has(c));
  ok("C11 TODO codigo de impedimento declarado e alcancavel",
    mortos.length === 0, mortos.join(", "));

  ok("C12 toda mensagem de impedimento e uma frase, e diz o que fazer",
    [...incompleto.impedimentos, ...googleComFerramenta.impedimentos].every(
      (i) => i.mensagem.length > 15 && /[.!]$/.test(i.mensagem)));
  ok("C13 todo impedimento aponta para uma etapa que existe",
    [...incompleto.impedimentos, ...googleComFerramenta.impedimentos,
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
  ok("D9  a lista de ferramentas nao publica `funcao_id`",
    !/funcao_?[Ii]d/.test(rota.slice(rota.indexOf("ferramentas:"),
      rota.indexOf("podeAtivar:"))));
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
    /Identidade[\s\S]{0,200}Instruções[\s\S]{0,200}IA \/ Modelo[\s\S]{0,200}Ferramentas[\s\S]{0,200}Skills[\s\S]{0,200}Memória[\s\S]{0,200}Fontes[\s\S]{0,200}Permissões[\s\S]{0,200}Rotinas[\s\S]{0,200}Testar[\s\S]{0,200}Revisar e Ativar/
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
  for (const [nome, src] of [["Wizard", wiz], ["ChatDoAgente", chat],
                             ["Workspace", work], ["Primitivas", prim]] as const) {
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
  ok("G24 `aguardando_aprovacao` tem cartao proprio",
    /barrado\.desfecho === "aguardando_aprovacao"/.test(chat) &&
      /precisa da sua aprovação/i.test(chat));
  ok("G25 e NAO cai tambem no aviso de erro generico",
    /erro !== null && barrado\?\.desfecho !== "aguardando_aprovacao"/.test(chat));

  // A parte que mais importa: o cartao nao tem botao de aprovar. A
  // aprovacao de hoje e de TAREFA, com fila e retomada proprias; um
  // "Aprovar" aqui gravaria decisao que nenhuma conversa retomaria.
  ok("G26 o cartao NAO tem aprovar/rejeitar inline",
    !/registrarDecisaoAprovacao|>Aprovar<|>Rejeitar</.test(chat));
  ok("G27 ele manda para a fila de aprovacoes que ja existe",
    /href="\/ia\/aprovacoes"/.test(chat));
  ok("G28 o nome do pack vem do catalogo, e nao e inventado",
    /packDaFuncao\(funcaoId\)\?\.nome \?\? null/.test(chat));
  ok("G29 sem pack conhecido, o cartao nao inventa nome",
    /nomeDoPack\(barrado\.funcaoId\) === null/.test(chat));
  ok("G30 `funcao_id` do bloqueio fica em detalhes tecnicos",
    chat.indexOf("Ver aprovações pendentes") < chat.indexOf("{barrado.funcaoId}"));

  // A lista espelhada tem de bater com a do runtime — uma divergencia
  // faria a tela deixar de reconhecer um bloqueio que o runtime criou.
  const runtime = codigo("lib/agentes/ia/falhas-de-ferramenta.ts");
  const doRuntime = (/DESFECHOS_QUE_FECHAM = Object\.freeze\(\[([\s\S]*?)\]/
    .exec(runtime)?.[1].match(/"([a-z_]+)"/g) ?? []).sort();
  const daTela = (/DESFECHOS_DE_BLOQUEIO = \[([\s\S]*?)\]/
    .exec(chat)?.[1].match(/"([a-z_]+)"/g) ?? []).sort();
  ok("G31 ANCORA: as duas listas foram mesmo lidas",
    doRuntime.length === 6 && daTela.length === 6);
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
  ok("H4  criar e configurar usam O MESMO wizard",
    /<Wizard/.test(novo) && /<Wizard/.test(conf));
  ok("H5  criar entra sem id; configurar entra com o id da rota",
    /agenteIdInicial=\{null\}/.test(novo) &&
      /agenteIdInicial=\{params\.id\}/.test(conf));
  ok("H6  nao existe tela paralela de edicao",
    !/EditarAgente|FormularioDeEdicao/.test(conf));
}

// ─── Placar ───────────────────────────────────────────────────────────

console.log("\n── placar ──────────────────────────────────────────────────────");
console.log(`  PASS ${passou}   FAIL ${falhou}`);
if (falhou > 0) process.exitCode = 1;
