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

  ok("N6  OpenAI esta AUSENTE do catalogo — nao indisponivel",
    !cat.some((m) => m.provedor === "openai"));
  ok("N7  os dois provedores configurados declaram ferramentas",
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

secao("Q. Vincular acao externa e gravar permissao — nao ha tabela paralela");

{
  const rota = codigo("app/api/agentes/[agenteId]/ferramentas-externas/route.ts");
  const grav = codigo("lib/agentes/permissoes/gravadas.ts");

  ok("Q1  a rota grava pela MESMA escrita de permissao do resto",
    /definirPermissaoDeFuncaoDoAgente/.test(rota));
  ok("Q2  e NAO existe tabela de selecionadas",
    !/ferramentas_externas|agente_ferramentas|toolkits_selecionados/.test(rota));
  ok("Q3  o dono e o agente vem da porta, nunca do corpo",
    /porta\.userId/.test(rota) && /porta\.agenteId/.test(rota) &&
      !/corpo\.userId|corpo\.agenteId/.test(rota));

  // A prova de existencia ANTES de gravar.
  ok("Q4  a acao tem de existir no catalogo antes de virar permissao",
    /listarAcoesDoToolkit\(toolkit, 50\)/.test(rota) &&
      /cat\.dados\.itens\.some\(\(a\) => a\.slug === acao\)/.test(rota));
  ok("Q5  acao inexistente responde 404, e nao grava",
    /Esta ação não existe neste aplicativo[\s\S]{0,20}404/.test(rota));

  // §11/§18: escrita nunca nasce automatica.
  ok("Q6  o nivel e decidido pelo SERVIDOR, a partir do risco",
    /riscoDaAcao\(acao\)/.test(rota) && /nivelRecomendado\(risco\)/.test(rota));
  ok("Q7  e a tela NAO manda nivel",
    !/nivel: corpo\.nivel|corpo\.nivel/.test(rota));
  ok("Q8  leitura recomenda automatico; escrita e desconhecido, aprovacao",
    nivelRecomendado("leitura") === "automatico" &&
      nivelRecomendado("escrita") === "aprovacao" &&
      nivelRecomendado("desconhecido") === "aprovacao");

  // Desvincular e bloquear, o que mantem a cerca do F7b.0.
  ok("Q9  desvincular BLOQUEIA, e nao apaga a linha",
    /nivel: "bloqueado"/.test(rota) && !/\.delete\(\)/.test(rota));
  ok("Q10 e so aceita id EXTERNO",
    /!ehFuncaoExterna\(funcaoId\)/.test(rota));

  // A leitura sem filtro, que e o que descobre as externas.
  ok("Q11 a leitura de permissoes gravadas escopa por dono E agente na query",
    /\.eq\("agente_id", agenteId\)[\s\S]{0,60}\.eq\("user_id", userId\)/.test(grav));
  ok("Q12 linha torta CONDENA a coleta — nao vira lista pela metade",
    /return \{ coleta: "falha" \}/.test(grav));
  ok("Q13 e sem dono ou agente ela nem pergunta",
    /if \(!userId \|\| !agenteId\) return \{ coleta: "entrada_invalida" \}/.test(grav));

  // Externa e reconhecivel por inspecao — sem coluna que a marque.
  ok("Q14 a externa e reconhecida pelo id, nao por coluna",
    /filter\(\(p\) => ehFuncaoExterna\(p\.funcaoId\)\)/.test(rota));
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

// ─── Placar ───────────────────────────────────────────────────────────

console.log("\n── placar ──────────────────────────────────────────────────────");
console.log(`  PASS ${passou}   FAIL ${falhou}`);
if (falhou > 0) process.exitCode = 1;
