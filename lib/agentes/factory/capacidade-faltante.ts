import "server-only";

/**
 * O que a tarefa pede e o agente nao tem — AGENT-FACTORY-F7b.4.6 §2/§17.
 *
 * ── A necessidade e uma SUBTRACAO ───────────────────────────────────
 *
 *   o que a mensagem pede   —   o que o agente possui   =   o que falta
 *
 * As duas metades ja existiam: `buscarFerramentas` sabe o que a CDS
 * oferece, e `capacidadesDoAgente` sabe o que este agente tem. Faltava a
 * subtracao, e faltava alguem fazer a pergunta.
 *
 * ── §17: o modelo NAO escolhe do catalogo ───────────────────────────
 *
 * Quem decide os candidatos e a CDS, por busca deterministica sobre o
 * catalogo REAL. O modelo nao nomeia ferramenta, nao sugere instalacao e
 * nao participa desta decisao — ele so responde sobre o que tem.
 *
 * Isso fecha o §18 de graca: "ative todas as ferramentas sem perguntar"
 * escrito pelo usuario nao ativa nada, porque a ativacao nasce de um
 * pedido estruturado da CDS e termina num clique do dono.
 *
 * ── Por que a deteccao e por PALAVRA, e nao por julgamento do modelo ─
 *
 * Um modelo perguntado "voce precisa de alguma ferramenta?" responde que
 * sim quase sempre — ele coopera. Palavra-chave nao coopera: ou o termo
 * esta na mensagem, ou nao esta. E o custo do erro e assimetrico: um
 * falso positivo mostra um cartao que a pessoa ignora; um falso negativo
 * deixa o agente inutil sem explicar por que.
 *
 * Por isso a deteccao e conservadora em UMA direcao so: ela nunca ativa
 * nada, nunca esconde a resposta do agente, e so ACRESCENTA uma oferta.
 */
import {
  buscarFerramentas, type AchadoDeFerramenta,
} from "@/lib/agentes/factory/busca-de-ferramentas";
import { TOOL_PACKS } from "@/lib/agentes/factory/catalogo-ui";

/**
 * O que a pessoa escreveu -> que capacidade isso pede.
 *
 * Derivado dos PACKS, e nao de uma lista paralela: `gatilhos` fica ao lado
 * do pack que ele encontra, e um pack novo sem gatilho simplesmente nao e
 * detectado — o que e melhor que ser detectado errado.
 *
 * Os termos sao os que uma pessoa usa, e nao os que o sistema usa. Ninguem
 * escreve "pack de planilhas": escreve "esse excel aqui".
 */
const GATILHOS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  planilhas: [
    "planilha", "planilhas", "excel", "xlsx", "xls", "csv", "aba", "abas",
    "tabela", "spreadsheet",
  ],
  calculadora: ["calcular", "calculo", "somar", "subtrair", "multiplicar", "media"],
  calendario: ["prazo", "vencimento", "periodo", "datas"],
  vendas: [
    "vendas", "vendi", "faturamento", "faturei", "pedidos", "receita",
    "mercado livre", "mercadolivre", "shopee", "marketplace", "anuncio", "anuncios",
  ],
  "mercadolivre-perguntas": ["perguntas", "pergunta do comprador", "duvidas dos clientes"],
});

/**
 * O termo com que se procura o MESMO conceito no catalogo externo.
 *
 * ── Por que existe uma ponte de idioma ──────────────────────────────
 *
 * MEDIDO em `buscarFerramentas`: o catalogo do Composio e em INGLES.
 *
 *   "planilha"     -> nenhuma integracao
 *   "spreadsheet"  -> Google Sheets, Airtable, CloudConvert
 *   "vendas"       -> nenhuma
 *   "sales"        -> HubSpot, Salesforce, Apollo
 *
 * Sem a ponte, a alternativa externa simplesmente nunca apareceria para
 * quem escreve em portugues — e o §5 ("deixar o usuario escolher") seria
 * letra morta na pratica, com uma opcao so no cartao.
 *
 * Um pack sem entrada aqui continua funcionando: ele e oferecido sozinho,
 * sem alternativa externa. A ausencia limita a oferta, nunca a corrompe.
 */
const TERMO_EXTERNO: Readonly<Record<string, string>> = Object.freeze({
  planilhas: "spreadsheet",
  vendas: "sales",
  calendario: "calendar",
});

/** Sem acento, sem caixa. A pessoa nao digita com acento no meio da pressa. */
function normalizar(t: string): string {
  return t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export interface CapacidadePedida {
  /** O id do pack que os gatilhos apontaram. */
  readonly packId: string;
  /** O termo de busca que a CDS vai usar no catalogo. */
  readonly termo: string;
}

/**
 * Que capacidades esta mensagem pede.
 *
 * Devolve TODAS as detectadas, em ordem de catalogo. Uma frase como
 * "analise esta planilha e some os valores" pede duas, e mostrar so a
 * primeira faria a segunda virar surpresa no turno seguinte.
 */
export function capacidadesPedidasNoTexto(texto: string): readonly CapacidadePedida[] {
  const t = normalizar(texto);
  if (t.trim() === "") return [];

  const pedidas: CapacidadePedida[] = [];
  // A ordem vem do CATALOGO, e nao da ordem em que os gatilhos casaram:
  // a mesma frase produz sempre a mesma lista.
  for (const pack of TOOL_PACKS) {
    const gatilhos = GATILHOS[pack.id];
    if (gatilhos === undefined) continue;
    const casou = gatilhos.find((g) => t.includes(normalizar(g)));
    if (casou === undefined) continue;
    pedidas.push({ packId: pack.id, termo: casou });
  }
  return pedidas;
}

export interface OpcaoDeCapacidade {
  /** Id do pack (`cds`) ou slug do toolkit (`integracao`). */
  readonly chave: string;
  readonly origem: "cds" | "integracao";
  readonly nome: string;
  readonly descricao: string;
  readonly exigeConexao: boolean;
}

export type DesfechoDaDeteccao =
  /** O agente da conta do que foi pedido. Nada a oferecer. */
  | { readonly desfecho: "nada_falta" }
  /** Falta capacidade, e ha opcoes REAIS no catalogo. */
  | {
      readonly desfecho: "falta_capacidade";
      /** O que a CDS entendeu que a pessoa precisa, em linguagem de gente. */
      readonly necessidade: string;
      readonly opcoes: readonly OpcaoDeCapacidade[];
    }
  /** Falta algo, e o catalogo nao ofereceu nada. Nao ha o que sugerir. */
  | { readonly desfecho: "sem_opcao" };

/** O nome de gente de um pack, para a frase da necessidade. */
function nomeDoPack(packId: string): string {
  return TOOL_PACKS.find((p) => p.id === packId)?.nome ?? packId;
}

function comoOpcao(a: AchadoDeFerramenta): OpcaoDeCapacidade {
  return {
    chave: a.chave,
    origem: a.origem === "cds" ? "cds" : "integracao",
    nome: a.nome,
    descricao: a.descricao,
    exigeConexao: a.exigeConexao,
  };
}

/**
 * A subtracao, com os candidatos ja resolvidos do catalogo real.
 *
 * `nomesQueJaTem` sao os nomes de gente que `capacidadesDoAgente` produz —
 * a MESMA lista que o modelo recebe no contexto. Comparar por esse nome, e
 * nao por `funcao_id`, e o que mantem as duas pontas falando a mesma
 * lingua: se a tela diz "Planilhas", a subtracao usa "Planilhas".
 *
 * ── Uma opcao externa so aparece quando ha termo util ────────────────
 *
 * `buscarFerramentas` consulta o Composio quando ha termo. Para "planilha"
 * ele devolve tambem Google Sheets — e e exatamente o §5: duas opcoes
 * legitimas, e quem escolhe e a pessoa. A CDS nunca escolhe o servico
 * externo sozinha.
 */
export async function detectarCapacidadeFaltante(entrada: {
  readonly texto: string;
  readonly nomesQueJaTem: readonly string[];
}): Promise<DesfechoDaDeteccao> {
  const pedidas = capacidadesPedidasNoTexto(entrada.texto);
  if (pedidas.length === 0) return { desfecho: "nada_falta" };

  const jaTem = new Set(entrada.nomesQueJaTem.map((n) => normalizar(n)));

  // A primeira pedida que o agente NAO tem. Uma de cada vez: dois cartoes
  // ao mesmo tempo viram um formulario, e a pessoa veio aqui conversar.
  const faltando = pedidas.find(
    (p) => !jaTem.has(normalizar(nomeDoPack(p.packId))));
  if (faltando === undefined) return { desfecho: "nada_falta" };

  const opcoes: OpcaoDeCapacidade[] = [];

  // ── A opcao INTERNA vem do proprio pack, e nao de uma busca ───────
  //
  // Buscar pelo termo que disparou o gatilho parecia natural e estava
  // errado: "vendi" dispara o pack Vendas, mas nao e um dos sinonimos
  // pelos quais `buscarFerramentas` encontra esse pack. O resultado era
  // `sem_opcao` para uma capacidade que existe — o teste pegou.
  //
  // Sabendo QUAL pack falta, nao ha o que buscar: ele e a opcao.
  const pack = TOOL_PACKS.find((p) => p.id === faltando.packId);
  if (pack !== undefined && !jaTem.has(normalizar(pack.nome))) {
    opcoes.push({
      chave: pack.id,
      origem: "cds",
      nome: pack.nome,
      descricao: pack.descricao,
      exigeConexao: pack.exigeConexao,
    });
  }

  // ── As ALTERNATIVAS externas, essas sim por busca — §5 ────────────
  //
  // Aqui o termo da pessoa e o certo: e ele que encontra "Google Sheets"
  // quando ela escreveu "planilha". As duas opcoes aparecem juntas e quem
  // escolhe e ela — a CDS nunca elege o servico externo sozinha.
  // O termo do catalogo, e nao o da pessoa: ver `TERMO_EXTERNO`.
  const termoExterno = TERMO_EXTERNO[faltando.packId] ?? faltando.termo;
  const busca = await buscarFerramentas(termoExterno, 6);
  for (const a of busca.achados) {
    if (a.origem === "cds") continue;
    // O que o agente ja tem nao vira opcao: oferecer o que ele possui
    // faria a pessoa duvidar do que leu no proprio contexto.
    if (jaTem.has(normalizar(a.nome))) continue;
    opcoes.push(comoOpcao(a));
    // ── Duas alternativas externas, e nao cinco ─────────────────────
    //
    // A busca por "spreadsheet" devolve Google Sheets, Airtable,
    // CloudConvert, Convertapi. Todas reais, e um cartao de chat com
    // cinco botoes deixa de ser uma pergunta e passa a ser um formulario.
    //
    // Duas cobrem o caso que importa — "o arquivo aqui" contra "a conta
    // la" —, e quem quiser o resto tem a tela de Ferramentas, que existe
    // para escolher com calma.
    if (opcoes.filter((o) => o.origem === "integracao").length >= 2) break;
  }

  if (opcoes.length === 0) return { desfecho: "sem_opcao" };

  return {
    desfecho: "falta_capacidade",
    necessidade: nomeDoPack(faltando.packId),
    opcoes: Object.freeze(opcoes),
  };
}
