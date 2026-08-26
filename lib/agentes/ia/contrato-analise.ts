/**
 * Contrato CONCRETO da analise textual de vendas — AGENTES-FASE1E-a.
 *
 * Define a menor saida util que uma IA pode produzir sobre o agregado
 * que `analise_vendas` ja monta hoje, mais a validacao estrutural que a
 * recusa quando ela nao cumpre o contrato.
 *
 * ── Por que validar mesmo declarando schema ao provedor ─────────────
 * Porque o schema e do PROVEDOR e a validacao e NOSSA. Regra ja escrita
 * em CLAUDE.md e ja paga em bug real: schema aceito nao e resposta
 * conforme. Aqui a resposta so passa se o nosso codigo aprovar.
 *
 * ── Por que o contrato e FECHADO ────────────────────────────────────
 * Chave desconhecida e recusa, nao "ignora e segue". Um contrato aberto
 * deixaria o modelo anexar campo que ninguem pediu — e campo que ninguem
 * pediu e exatamente por onde entra numero inventado, recomendacao
 * disfarcada de dado e vazamento de conteudo nao solicitado. Fechado, a
 * unica saida possivel e a que foi declarada.
 *
 * ── O que este contrato deliberadamente NAO tem ─────────────────────
 * NAO tem numero. Nenhum campo numerico, em nenhum nivel. Nao ha
 * `faturamento`, `ticketMedio`, `variacao`, `projecao`, `percentual`
 * nem `conversao_estimada`. Isso e regra de negocio, nao estilo:
 * numero financeiro vem de API oficial e calculo deterministico
 * (`BUSINESS_RULES.md`, "nunca usar estimativas"). A IA comenta os
 * numeros que o `cds-engine` e a capability ja produziram; ela nunca
 * e a origem de um.
 *
 * NAO tem `proximas_acoes`, `sugestoes`, `comandos` nem coisa que se
 * pareca com ordem. Um campo assim convida quem consome a executar o
 * que o modelo escreveu — e transforma texto de IA em autoridade. A IA
 * descreve; quem decide e o dono da loja.
 *
 * NAO tem identificador de dono, projeto ou job. O modelo nunca ve
 * `user_id`, entao nunca pode devolver um.
 *
 * ── Por que os limites de tamanho existem ───────────────────────────
 * Um `resumo` de 4 MB nao e "resposta generosa", e um incidente:
 * atravessa `tarefas.resultado`, log e tela. Os tetos abaixo sao teto
 * de sanidade estrutural, nao preferencia editorial.
 */
import { ErroProvedorIA } from "@/lib/ai-gateway/erros";

/** As tres unicas chaves aceitas. Contrato fechado — ver docblock. */
export const CHAVES_ANALISE_IA = ["resumo", "destaques", "alertas"] as const;

export const LIMITE_RESUMO_CARACTERES = 1200;
export const LIMITE_ITEM_CARACTERES = 300;
export const LIMITE_ITENS_LISTA = 10;

/**
 * A analise. Tres campos de texto, todos obrigatorios.
 *
 * `alertas` e obrigatorio como CHAVE e pode vir como lista vazia: "nao
 * encontrei problema" e uma afirmacao, e ela precisa ser distinguivel
 * de "o modelo esqueceu de responder". Chave ausente e recusa.
 */
export interface AnaliseVendasIA {
  /** Leitura geral do periodo, em prosa. */
  resumo: string;
  /** Pontos que merecem atencao positiva. Pode ser lista vazia. */
  destaques: string[];
  /** Riscos e anomalias observados. Pode ser lista vazia. */
  alertas: string[];
}

/**
 * Schema declarado ao provedor.
 *
 * `additionalProperties: false` aqui e a MESMA regra que
 * `validarAnaliseVendasIA` aplica do nosso lado — de proposito
 * duplicada. O provedor pode ignorar a sua metade; nos nunca ignoramos
 * a nossa.
 */
export const SCHEMA_ANALISE_VENDAS_IA = {
  type: "object",
  properties: {
    resumo: { type: "string" },
    destaques: { type: "array", items: { type: "string" } },
    alertas: { type: "array", items: { type: "string" } },
  },
  required: ["resumo", "destaques", "alertas"],
  additionalProperties: false,
} as const;

/** Recusa uniforme. `validation` e a categoria que os dois provedores reais
 *  ja usam para "resposta que nao cumpre o contrato" — nao inventamos uma
 *  setima categoria, porque o CHECK do banco nao aceitaria mesmo. */
function recusar(motivo: string): never {
  throw new ErroProvedorIA("validation", `Resposta de IA fora do contrato: ${motivo}`);
}

/**
 * Objeto simples de verdade: nao nulo, nao array, nao Date/Map/Set, e com
 * prototipo `Object.prototype` ou nulo.
 *
 * `typeof x === "object"` sozinho aceita array, `null` e qualquer
 * instancia de classe. O teste de prototipo tambem barra objeto com
 * `__proto__` adulterado vindo de JSON.parse malicioso.
 */
function ehObjetoSimples(valor: unknown): valor is Record<string, unknown> {
  if (valor === null || typeof valor !== "object") return false;
  if (Array.isArray(valor)) return false;
  const proto = Object.getPrototypeOf(valor);
  return proto === Object.prototype || proto === null;
}

/** Texto util: string, com conteudo depois de aparado, dentro do teto. */
function validarTexto(valor: unknown, campo: string, limite: number): string {
  if (typeof valor !== "string") {
    recusar(`"${campo}" deveria ser string, veio ${valor === null ? "null" : typeof valor}.`);
  }
  const aparado = valor.trim();
  if (aparado.length === 0) recusar(`"${campo}" veio vazio ou so com espacos.`);
  if (aparado.length > limite) {
    recusar(`"${campo}" tem ${aparado.length} caracteres, acima do limite de ${limite}.`);
  }
  return aparado;
}

/** Lista de textos uteis. Vazia e valida; item vazio nao e. */
function validarListaDeTextos(valor: unknown, campo: string): string[] {
  if (!Array.isArray(valor)) {
    recusar(`"${campo}" deveria ser array, veio ${valor === null ? "null" : typeof valor}.`);
  }
  if (valor.length > LIMITE_ITENS_LISTA) {
    recusar(`"${campo}" tem ${valor.length} itens, acima do limite de ${LIMITE_ITENS_LISTA}.`);
  }
  return valor.map((item, indice) =>
    validarTexto(item, `${campo}[${indice}]`, LIMITE_ITEM_CARACTERES)
  );
}

/**
 * Valida e NORMALIZA a resposta bruta.
 *
 * Devolve um objeto NOVO, montado campo a campo a partir dos valores ja
 * validados — nunca o objeto recebido, nem uma copia dele. Assim, o que
 * sai daqui contem exatamente as tres chaves do contrato: qualquer coisa
 * que o modelo tenha anexado nao tem como sobreviver a esta funcao, nem
 * por descuido futuro de quem editar o codigo.
 *
 * LANCA `ErroProvedorIA("validation", ...)` em qualquer desvio. Nunca
 * devolve `null`, nunca preenche campo faltante com valor "razoavel",
 * nunca trunca para caber. Fallback silencioso aqui seria propaganda
 * enganosa com aparencia de sucesso.
 */
export function validarAnaliseVendasIA(bruto: unknown): AnaliseVendasIA {
  if (bruto === undefined) recusar("resposta ausente.");
  if (!ehObjetoSimples(bruto)) {
    const tipo = bruto === null ? "null" : Array.isArray(bruto) ? "array" : typeof bruto;
    recusar(`esperava objeto simples, veio ${tipo}.`);
  }

  const permitidas = new Set<string>(CHAVES_ANALISE_IA);
  const recebidas = Object.keys(bruto);

  const inesperadas = recebidas.filter((chave) => !permitidas.has(chave));
  if (inesperadas.length > 0) {
    recusar(`chave(s) nao prevista(s) no contrato: ${inesperadas.join(", ")}.`);
  }
  const faltantes = CHAVES_ANALISE_IA.filter((chave) => !recebidas.includes(chave));
  if (faltantes.length > 0) {
    recusar(`chave(s) obrigatoria(s) ausente(s): ${faltantes.join(", ")}.`);
  }

  return {
    resumo: validarTexto(bruto.resumo, "resumo", LIMITE_RESUMO_CARACTERES),
    destaques: validarListaDeTextos(bruto.destaques, "destaques"),
    alertas: validarListaDeTextos(bruto.alertas, "alertas"),
  };
}
