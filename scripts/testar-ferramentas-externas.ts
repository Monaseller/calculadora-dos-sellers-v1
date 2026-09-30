/**
 * AGENT-FACTORY-F7b.4.2 §10–§13 — POSSUIR nao e PODER.
 *
 * Suite PURA: sem rede, sem banco, sem IA.
 *
 * ── A pergunta central: REMOVED_TOOL_NOT_DECLARED ───────────────────
 *
 * No F7b.4.1 vincular uma acao externa GRAVAVA a permissao dela, e
 * desvincular gravava `bloqueado`. Isso produzia dois defeitos:
 *
 *   §10/§11  o nivel era escolhido por NOS, a partir do risco. Um default
 *            nosso ocupava o lugar da decisao do dono, e `aprovacao` ja e
 *            autorizacao para pedir.
 *
 *   §13      como a permissao tambem servia de prova de existencia, uma
 *            permissao HISTORICA podia ressuscitar uma ferramenta que o
 *            dono ja tinha removido.
 *
 * Agora sao duas tabelas. A secao C e a prova do §13, e ela e um PAR:
 *
 *   C2  vinculo + permissao          -> DECLARADA   (controle positivo)
 *   C4  permissao SEM vinculo        -> NAO declarada
 *
 * Sem C2 este arquivo passaria com uma funcao que nunca declara nada.
 * Essa foi a licao das secoes C e I do wizard, e vale igual aqui.
 *
 * Roda com: npx tsx scripts/testar-ferramentas-externas.ts
 */
import "./_server-only-inerte";

import { declararFerramentas } from "../lib/agentes/ia/ferramentas";
import type { FuncaoExternaDeclaravel } from "../lib/agentes/ia/ferramentas";
import { fatosDeFuncaoExterna } from "../lib/agentes/ferramentas-externas/repositorio";
import type { VinculoExterno } from "../lib/agentes/ferramentas-externas/repositorio";
import { autorizarFuncao } from "../lib/agentes/funcoes/guard";
import { validarParaAtivacao } from "../lib/agentes/factory/ativacao";
import {
  idDaFuncaoExterna, nivelRecomendado, riscoDaAcao,
} from "../lib/agentes/composio/identidade-de-funcao";

let pass = 0;
let fail = 0;
function ok(nome: string, cond: boolean, detalhe = ""): void {
  if (cond) { pass += 1; console.log(`  PASS  ${nome}`); }
  else { fail += 1; console.log(`  FAIL  ${nome}${detalhe ? `  — ${detalhe}` : ""}`); }
}
function secao(titulo: string): void { console.log(`\n${titulo}`); }

// ─── Fixtures ─────────────────────────────────────────────────────────

const LER = "composio.googlesheets.googlesheets_get_spreadsheet_info";
const ESCREVER = "composio.googlesheets.googlesheets_add_sheet";

function vinculo(funcaoId: string, acao: string): VinculoExterno {
  return {
    id: `vinc-${acao}`,
    provedorExterno: "composio",
    toolkit: "googlesheets",
    acao,
    funcaoId,
    criadoEm: "2026-09-30T00:00:00Z",
  };
}

const V_LER = vinculo(LER, "GOOGLESHEETS_GET_SPREADSHEET_INFO");
const V_ESCREVER = vinculo(ESCREVER, "GOOGLESHEETS_ADD_SHEET");

/**
 * O catalogo externo que quem chama forneceria.
 *
 * Descricao e schema vem do provedor externo na vida real; aqui eles sao
 * fixture, porque o que esta sob teste e o FILTRO, e nao o catalogo.
 */
function declaravel(funcaoId: string): FuncaoExternaDeclaravel {
  return {
    funcaoId,
    descricao: "Acao de aplicativo externo.",
    schemaEntrada: { type: "object", properties: {}, additionalProperties: false },
  };
}

// ─── A. Os fatos de existencia vem do VINCULO ─────────────────────────

secao("A. `existe` e derivado do vinculo, nunca da permissao");

{
  const fatos = fatosDeFuncaoExterna([V_LER, V_ESCREVER]);
  ok("A1  dois vinculos viram dois fatos", fatos.length === 2);
  ok("A2  e os dois afirmam `existe`", fatos.every((f) => f.existe === true));
  ok("A3  com os ids das acoes vinculadas",
    fatos.some((f) => f.id === LER) && fatos.some((f) => f.id === ESCREVER));

  ok("A4  sem vinculo, nenhum fato", fatosDeFuncaoExterna([]).length === 0);

  // Vinculo duplicado nao duplica o fato: o guard procura por id, e uma
  // lista com o mesmo id duas vezes seria ambigua para quem lesse.
  ok("A5  vinculo repetido nao duplica o fato",
    fatosDeFuncaoExterna([V_LER, V_LER]).length === 1);

  // Id que nao decompoe NAO entra. Uma Funcao que ninguem consegue nomear
  // nao deveria poder ser autorizada.
  ok("A6  vinculo com id torto e descartado",
    fatosDeFuncaoExterna([vinculo("composio.googlesheets", "X")]).length === 0);
  ok("A7  e id interno tambem — este modulo so fala de externa",
    fatosDeFuncaoExterna([vinculo("planilha.ler", "X")]).length === 0);
}

// ─── B. O guard nega o que nao esta nos fatos ──────────────────────────

secao("B. O guard consome os fatos, e nega a acao sem vinculo");

{
  const permissoes = [{ funcaoId: ESCREVER, nivel: "automatico" as const }];

  // Controle POSITIVO: com o vinculo presente, o guard autoriza.
  const comVinculo = autorizarFuncao({
    funcaoId: ESCREVER,
    conexaoNecessaria: null,
    funcoes: fatosDeFuncaoExterna([V_ESCREVER]),
    permissoes,
    conexoes: [],
  });
  ok("B1  vinculada + `automatico`: o guard AUTORIZA",
    comVinculo.permitido,
    comVinculo.permitido ? "" : comVinculo.codigo);

  // O caso do §13: a MESMA permissao, sem o vinculo.
  const semVinculo = autorizarFuncao({
    funcaoId: ESCREVER,
    conexaoNecessaria: null,
    funcoes: fatosDeFuncaoExterna([]),
    permissoes,
    conexoes: [],
  });
  ok("B2  permissao historica SEM vinculo: o guard NEGA",
    !semVinculo.permitido);
  ok("B3  e nega por INEXISTENCIA, nao por permissao",
    !semVinculo.permitido && semVinculo.codigo === "funcao_inexistente",
    semVinculo.permitido ? "autorizou" : semVinculo.codigo);

  // E o vinculo sozinho tambem nao basta: POSSUIR nao e PODER.
  const semPermissao = autorizarFuncao({
    funcaoId: ESCREVER,
    conexaoNecessaria: null,
    funcoes: fatosDeFuncaoExterna([V_ESCREVER]),
    permissoes: [],
    conexoes: [],
  });
  ok("B4  vinculada e SEM permissao: o guard NEGA",
    !semPermissao.permitido);
  ok("B5  e o codigo fala de permissao, nao de existencia",
    !semPermissao.permitido && semPermissao.codigo !== "funcao_inexistente",
    semPermissao.permitido ? "autorizou" : semPermissao.codigo);
}

// ─── C. REMOVED_TOOL_NOT_DECLARED ─────────────────────────────────────

secao("C. Ferramenta removida nao e DECLARADA ao modelo");

{
  const catalogoVazio = {};
  const permissaoEscrever = [{ funcaoId: ESCREVER, nivel: "aprovacao" }];

  // C1/C2: o controle POSITIVO. Sem ele o resto seria vacuo.
  const declaradas = declararFerramentas({
    catalogo: catalogoVazio,
    permissoes: permissaoEscrever,
    externas: fatosDeFuncaoExterna([V_ESCREVER]).map((f) => declaravel(f.id)),
  });
  ok("C1  vinculo + permissao produz UMA declaracao", declaradas.length === 1);
  ok("C2  e ela e a acao externa vinculada (CONTROLE POSITIVO)",
    declaradas[0]?.nome === ESCREVER,
    declaradas.map((d) => d.nome).join(","));

  // C3/C4: o vinculo sai, a permissao FICA.
  const semVinculo = declararFerramentas({
    catalogo: catalogoVazio,
    // A permissao historica continua exatamente igual.
    permissoes: permissaoEscrever,
    externas: fatosDeFuncaoExterna([]).map((f) => declaravel(f.id)),
  });
  ok("C3  removido o vinculo, nada e declarado", semVinculo.length === 0,
    semVinculo.map((d) => d.nome).join(","));
  ok("C4  REMOVED_TOOL_NOT_DECLARED: permissao historica nao ressuscita",
    !semVinculo.some((d) => d.nome === ESCREVER));

  // C5: vinculada e SEM decisao tambem nao e declarada — e diferente de
  // `bloqueado`, onde o dono decidiu "nao" e ha cerca em runtime.
  const semDecisao = declararFerramentas({
    catalogo: catalogoVazio,
    permissoes: [],
    externas: fatosDeFuncaoExterna([V_ESCREVER]).map((f) => declaravel(f.id)),
  });
  ok("C5  vinculada e sem permissao: NAO declarada", semDecisao.length === 0);

  // C6: `bloqueado` E declarado, pelo mesmo motivo do F7b.0 — o modelo
  // pede, o guard nega, o laco fecha o turno. Nao declarar faria o modelo
  // responder de cabeca.
  const bloqueada = declararFerramentas({
    catalogo: catalogoVazio,
    permissoes: [{ funcaoId: ESCREVER, nivel: "bloqueado" }],
    externas: fatosDeFuncaoExterna([V_ESCREVER]).map((f) => declaravel(f.id)),
  });
  ok("C6  `bloqueado` E declarado, para o guard ser consultado",
    bloqueada.length === 1 && bloqueada[0]?.nome === ESCREVER);

  // C7: nivel desconhecido nao declara. Nao e decisao.
  ok("C7  nivel desconhecido nao declara",
    declararFerramentas({
      catalogo: catalogoVazio,
      permissoes: [{ funcaoId: ESCREVER, nivel: "talvez" }],
      externas: fatosDeFuncaoExterna([V_ESCREVER]).map((f) => declaravel(f.id)),
    }).length === 0);

  // C8: a declaracao NAO avisa que esta bloqueada — igual as internas. Um
  // modelo que sabe que sera negado desvia, e desviar significa responder
  // de cabeca.
  ok("C8  a descricao nao anuncia bloqueio",
    !/bloquead|negad|proibid/i.test(bloqueada[0]?.descricao ?? ""));

  // C9: sem `externas`, o comportamento antigo e identico. Agentes que
  // nao tem ferramenta externa nao mudam em nada.
  ok("C9  sem `externas`, nada externo e declarado",
    declararFerramentas({ catalogo: catalogoVazio, permissoes: permissaoEscrever })
      .length === 0);
}

// ─── D. Selecionar nao concede — §10/§11 ──────────────────────────────

secao("D. Selecionar uma Tool NAO concede permissao");

{
  // O nivel recomendado existe como SUGESTAO para a tela pre-selecionar.
  // O que este bloco cobra e que ele nunca seja `automatico` para escrita
  // — porque uma sugestao que a pessoa aceita sem ler vira o default.
  ok("D1  escrita nunca e sugerida como `automatico`",
    nivelRecomendado(riscoDaAcao("GOOGLESHEETS_ADD_SHEET")) !== "automatico");
  ok("D2  desconhecido tambem nao",
    nivelRecomendado(riscoDaAcao("XPTO_FAZ_ALGO")) !== "automatico");

  // A ativacao BARRA a vinculada sem decisao. E o estado que o F7b.4.1
  // nao conseguia representar.
  const base = {
    nome: "Assistente",
    instrucoes: "Use as ferramentas para qualquer numero.",
    provedor: "anthropic",
  };
  const barrada = validarParaAtivacao({
    ...base, permissoes: [], funcoesExternasVinculadas: [ESCREVER],
  });
  ok("D3  vinculada e sem decisao: NAO ativa", !barrada.podeAtivar);
  ok("D4  com codigo proprio, separado do pack interno",
    barrada.impedimentos.some((i) => i.codigo === "ferramenta_externa_sem_permissao") &&
      !barrada.impedimentos.some((i) => i.codigo === "permissao_incompleta"));

  // O PAR: decidida, ativa.
  const decidida = validarParaAtivacao({
    ...base,
    permissoes: [{ funcaoId: ESCREVER, nivel: "aprovacao" }],
    funcoesExternasVinculadas: [ESCREVER],
  });
  ok("D5  decidida: ATIVA (CONTROLE POSITIVO)", decidida.podeAtivar,
    decidida.impedimentos.map((i) => i.codigo).join(","));

  // E o id externo nunca aparece na frase mostrada a pessoa.
  ok("D6  nenhum impedimento mostra `funcao_id` externo",
    barrada.impedimentos.every((i) => !/composio\./.test(i.mensagem)));
}

// ─── E. A identidade da acao externa ──────────────────────────────────

secao("E. O id externo continua atravessando o CHECK do banco");

{
  const id = idDaFuncaoExterna({ toolkit: "googlesheets", acao: "GOOGLESHEETS_ADD_SHEET" });
  ok("E1  o id e gerado em minusculas", id.ok && id.funcaoId === ESCREVER,
    id.ok ? id.funcaoId : id.motivo);
  // A mesma acao produz sempre o mesmo id — e o que faz o `unique
  // (agente_id, funcao_id)` ser idempotencia de verdade.
  const outra = idDaFuncaoExterna({ toolkit: "GoogleSheets", acao: "googlesheets_add_sheet" });
  ok("E2  e nao depende da caixa do que veio do catalogo",
    outra.ok && id.ok && outra.funcaoId === id.funcaoId);
}

// ─── Placar ───────────────────────────────────────────────────────────

console.log(`\nPASS ${pass}   FAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);
