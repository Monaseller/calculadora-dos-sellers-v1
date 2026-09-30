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
  // ── F7b.4.8 §20/§26: os nomes de marketplace SAIRAM daqui ─────
  //
  // Estavam aqui, e era um defeito de produto: "quanto vendi no Mercado
  // Livre" casava com o pack `vendas`, que le a base da CDS. A pessoa
  // pedia a fonte oficial e recebia o espelho, com o nome errado no
  // cartao.
  vendas: [
    "vendas", "vendi", "faturamento", "faturei", "pedidos", "receita",
  ],
  "mercadolivre-perguntas": [
    // `ml` e `meli` sao como as pessoas escrevem de verdade — o §26 traz
    // "me fale o faturamento da semana no ML" como frase obrigatoria. Os
    // dois sao curtos, e `contemTermo` exige fronteira de palavra neles.
    "mercado livre", "mercadolivre", "meli", "ml",
    "perguntas", "pergunta do comprador", "duvidas dos clientes",
  ],
});

/**
 * Gatilhos que NOMEIAM a fonte, e por isso tem precedencia.
 *
 * ── O problema que isto resolve — §30 ───────────────────────────────
 *
 * "Quanto vendi esta semana no Mercado Livre?" dispara DOIS packs:
 * `vendas` por "vendi", e `mercadolivre-perguntas` por "mercado livre".
 * A ordem de `TOOL_PACKS` colocava `vendas` na frente, e a pessoa
 * recebia a base da CDS depois de ter dito de onde queria o numero.
 *
 * ── Por que uma lista explicita, e nao o gatilho mais longo ─────────
 *
 * Ordenar pelo tamanho do termo funcionaria por acidente hoje
 * ("mercado livre" tem 13 caracteres e "faturamento" tem 11) e quebraria
 * no primeiro termo novo. A regra de verdade nao e o tamanho: e que
 * quem NOMEIA a fonte ja escolheu a fonte.
 */
const GATILHOS_DE_MARKETPLACE: ReadonlySet<string> = new Set([
  "mercado livre", "mercadolivre", "meli", "ml",
]);

/**
 * Packs que respondem a MESMA pergunta por FONTES diferentes.
 *
 * ── O defeito que isto corrige ──────────────────────────────────────
 *
 * "Quanto vendi esta semana no Mercado Livre?" dispara os dois packs. A
 * precedencia resolvia a primeira oferta: Mercado Livre. Mas depois de o
 * dono ADICIONAR o Mercado Livre, a mesma frase voltava a casar com
 * `vendas` — o agente ja tinha a fonte oficial, e a CDS oferecia a base
 * interna como se faltasse algo.
 *
 * O teste do §30 pegou: a pendencia renascia no turno retomado, e o
 * cartao reaparecia oferecendo "Vendas registradas na CDS" para uma
 * pergunta que acabara de ser respondida.
 *
 * Nao e precedencia, e EXCLUSAO: quem nomeou a fonte escolheu a fonte, e
 * a outra deixa de ser uma oferta — passa a ser uma resposta diferente
 * para a mesma pergunta.
 *
 * O mapa e do pack VENCEDOR para os que ele exclui. Um pack sem entrada
 * aqui nao exclui ninguem, que e o comportamento de todos os outros.
 */
const FONTES_EXCLUIDAS_POR: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "mercadolivre-perguntas": Object.freeze(["vendas"]),
});

/**
 * Packs que respondem a MESMA pergunta — a familia de fonte.
 *
 * Derivada de `FONTES_EXCLUIDAS_POR`, nos DOIS sentidos, para nao existir
 * uma segunda lista dizendo a mesma coisa ao contrario.
 *
 * ── O bug que isto corrige — §10 ────────────────────────────────────
 *
 * MEDIDO: "consulte as vendas", num agente cuja UNICA fonte de vendas era
 * o Mercado Livre, devolvia o cartao "Preciso de uma ferramenta" com
 * Vendas da CDS, HubSpot e Salesforce. Foi exatamente esse cartao que o
 * Rodrigo viu.
 *
 * O agente ja tinha como responder. A subtracao comparava o pack PEDIDO
 * com os que o agente tem, e `vendas` nao estava entre eles — mas Mercado
 * Livre estava, e ele responde a mesma pergunta por outra fonte.
 *
 * Oferecer uma segunda fonte de vendas a quem ja tem uma nao e ajuda: e
 * convidar o dono a trocar de fonte sem ter pedido.
 */
const FAMILIA_DE_FONTE: Readonly<Record<string, readonly string[]>> = Object.freeze(
  (() => {
    const familia: Record<string, string[]> = {};
    for (const [pack, excluidos] of Object.entries(FONTES_EXCLUIDAS_POR)) {
      for (const outro of excluidos) {
        (familia[pack] ??= []).push(outro);
        (familia[outro] ??= []).push(pack);
      }
    }
    return familia;
  })()
);

/**
 * O pack da fonte que a pessoa NOMEOU, ou `null` — §3/§8.
 *
 * "no Mercado Livre" nao e uma pista: e a fonte escolhida. Enquanto ela
 * estiver na frase, nenhuma outra pode ser oferecida como substituta —
 * nem a base da CDS, nem HubSpot, nem Salesforce.
 *
 * `null` e o caso comum ("consulte as vendas"), e ali o comportamento
 * antigo continua valendo: a CDS oferece as fontes que conhece e quem
 * escolhe e o dono.
 */
export function fonteNomeadaNoTexto(texto: string): string | null {
  const t = normalizar(texto);
  for (const pack of TOOL_PACKS) {
    const gatilhos = GATILHOS[pack.id];
    if (gatilhos === undefined) continue;
    for (const g of gatilhos) {
      if (!GATILHOS_DE_MARKETPLACE.has(g)) continue;
      if (contemTermo(t, g)) return pack.id;
    }
  }
  return null;
}

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

/**
 * O texto contem o TERMO — com fronteira de palavra quando ele e curto.
 *
 * ── Por que a fronteira, e so para os curtos ────────────────────────
 *
 * O §26 exige reconhecer "ML" em "me fale o faturamento da semana no ML".
 * Com `includes`, "ml" casaria dentro de `html`, `xml` e `500ml` — e um
 * gatilho de marketplace disparando em "500ml de tinta" ofereceria o
 * Mercado Livre para quem falava de embalagem.
 *
 * Os gatilhos longos ficam como estavam, por decisao: "planilha" precisa
 * casar dentro de "planilhas", e exigir fronteira ali quebraria plural,
 * que e como as pessoas escrevem.
 *
 * Quatro caracteres e o corte. Acima disso a colisao acidental deixa de
 * ser realista; abaixo, ela e a regra — `aba` casava em "trabalho".
 */
const TAMANHO_QUE_EXIGE_FRONTEIRA = 4;

/**
 * Termos curtos que tambem sao UNIDADE DE MEDIDA.
 *
 * `ml` e Mercado Livre e tambem mililitro. O controle J3 pegou: com
 * fronteira de palavra, "preciso de 250 ml de tinta" casava e oferecia o
 * Mercado Livre a quem falava de embalagem.
 *
 * O que separa os dois e a QUANTIDADE antes: ninguem escreve "250 Mercado
 * Livre", e todo mundo escreve "250 ml". Havendo numero na frente, o termo
 * e unidade — nao fonte.
 *
 * Nao resolve tudo ("vendas em ml" continua ambiguo), e nao precisa: o
 * pior desfecho e nao reconhecer a fonte nomeada, e ai vale o
 * comportamento antigo — a CDS oferece as fontes que conhece e quem
 * escolhe e o dono.
 */
const TERMOS_QUE_TAMBEM_SAO_UNIDADE: ReadonlySet<string> = new Set(["ml"]);

function contemTermo(textoNormalizado: string, termo: string): boolean {
  const t = normalizar(termo);
  if (t.length > TAMANHO_QUE_EXIGE_FRONTEIRA) return textoNormalizado.includes(t);

  // Fronteira por classe de caractere, e nao `\b`: `normalizar` ja tirou
  // acento, entao sobra ASCII e a classe fica previsivel.
  const escapado = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`(^|[^a-z0-9])${escapado}([^a-z0-9]|$)`).test(textoNormalizado)) {
    return false;
  }
  if (!TERMOS_QUE_TAMBEM_SAO_UNIDADE.has(t)) return true;

  // Quantidade antes — colada (`500ml`) ou com espaco (`250 ml`) — e
  // unidade de medida, e nao a fonte.
  return !new RegExp(`[0-9]\\s*${escapado}([^a-z0-9]|$)`).test(textoNormalizado);
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
    const casou = gatilhos.find((g) => contemTermo(t, g));
    if (casou === undefined) continue;
    pedidas.push({ packId: pack.id, termo: casou });
  }
  // Quem nomeou a fonte vence. `sort` estavel preserva a ordem de
  // `TOOL_PACKS` entre os que empatam, entao o resto do comportamento
  // fica exatamente como era.
  const ordenadas = pedidas.sort((a, b) =>
    Number(GATILHOS_DE_MARKETPLACE.has(b.termo)) -
    Number(GATILHOS_DE_MARKETPLACE.has(a.termo)));

  // E a fonte alternativa sai de cena. Sem isto, a oferta reaparecia
  // depois de a pessoa ja ter escolhido de onde queria o numero.
  const excluidos = new Set<string>();
  for (const p of ordenadas) {
    if (!GATILHOS_DE_MARKETPLACE.has(p.termo)) continue;
    for (const outro of FONTES_EXCLUIDAS_POR[p.packId] ?? []) excluidos.add(outro);
  }
  return excluidos.size === 0
    ? ordenadas
    : ordenadas.filter((p) => !excluidos.has(p.packId));
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
/**
 * A capacidade que uma SKILL declara e o agente nao tem — §3/§7.
 *
 * ── Em que isto difere da deteccao por texto ────────────────────────
 *
 * `detectarCapacidadeFaltante` le o que a PESSOA escreveu. Esta le o que
 * a SKILL declarou em `manifesto.requer.funcoes` — estrutura validada
 * por `formato.ts`, e nao palavra achada no corpo dela (§4: texto pode
 * sugerir, binding e contra capability real).
 *
 * As duas existem porque cobrem faltas diferentes. "Analise minha
 * planilha" sem Planilhas e a primeira. Uma Skill Financeiro que declara
 * precisar de Mercado Livre, num agente sem Mercado Livre, e a segunda —
 * e ela apareceria em QUALQUER pergunta, inclusive numa que nao cita
 * marketplace nenhum.
 *
 * ── PURA, e sem leitura nova ───────────────────────────────────────
 *
 * Recebe as Skills e as Funcoes permitidas, que o runtime ja carregou
 * para montar o prompt. Uma consulta a mais por turno para um dado que
 * ja esta em memoria seria custo sem informacao.
 *
 * `null` quando nada falta, quando a Funcao exigida nao pertence a pack
 * nenhum (nao ha o que oferecer) ou quando o requisito e opcional.
 */
export function capacidadeFaltanteDeSkill(entrada: {
  readonly skills: readonly {
    readonly manifesto: {
      readonly id: string;
      readonly requer?: { readonly funcoes?: readonly string[] };
    };
  }[];
  /** As Funcoes que o agente PODE usar. `bloqueado` nao entra. */
  readonly funcoesPermitidas: readonly string[];
}): { readonly skillId: string; readonly opcao: OpcaoDeCapacidade } | null {
  const tem = new Set(entrada.funcoesPermitidas);

  for (const s of entrada.skills) {
    // `funcoes_opcionais` fica de FORA de proposito: faltar uma opcional
    // reduz o alcance e nao impede o trabalho, e abrir um cartao por ela
    // interromperia a conversa para oferecer o que ninguem precisa.
    for (const funcaoId of s.manifesto.requer?.funcoes ?? []) {
      if (tem.has(funcaoId)) continue;
      const pack = TOOL_PACKS.find((p) => p.funcoes.includes(funcaoId));
      // Funcao exigida que nao pertence a pack nenhum nao tem oferta
      // possivel: oferecer nada seria um cartao sem botao.
      if (pack === undefined) continue;
      return {
        skillId: s.manifesto.id,
        opcao: {
          chave: pack.id,
          origem: "cds",
          nome: pack.nome,
          descricao: pack.descricao,
          exigeConexao: pack.exigeConexao,
        },
      };
    }
  }
  return null;
}

export async function detectarCapacidadeFaltante(entrada: {
  readonly texto: string;
  readonly nomesQueJaTem: readonly string[];
}): Promise<DesfechoDaDeteccao> {
  const pedidas = capacidadesPedidasNoTexto(entrada.texto);
  if (pedidas.length === 0) return { desfecho: "nada_falta" };

  const jaTem = new Set(entrada.nomesQueJaTem.map((n) => normalizar(n)));

  // A primeira pedida que o agente NAO tem. Uma de cada vez: dois cartoes
  // ao mesmo tempo viram um formulario, e a pessoa veio aqui conversar.
  // ── §10: ter a MESMA FONTE por outro pack conta como ter ────────
  //
  // Um agente com Mercado Livre nao precisa de "Vendas registradas na
  // CDS" para responder sobre vendas. Comparar so o pack pedido fazia a
  // CDS oferecer uma segunda fonte a quem ja tinha uma.
  const temAFonte = (packId: string): boolean => {
    if (jaTem.has(normalizar(nomeDoPack(packId)))) return true;
    return (FAMILIA_DE_FONTE[packId] ?? []).some((irmao) =>
      jaTem.has(normalizar(nomeDoPack(irmao))));
  };

  const faltando = pedidas.find((p) => !temAFonte(p.packId));
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

  // ── §9: fonte NOMEADA nao recebe alternativa ─────────────────────
  //
  // "Quanto vendi esta semana no Mercado Livre?" tem uma resposta possivel
  // e uma so. Buscar "sales" no catalogo externo e oferecer HubSpot ao
  // lado seria propor a troca de uma fonte que a pessoa acabou de nomear.
  //
  // Sem fonte nomeada, a busca continua — e e ela que faz aparecer o
  // Google Sheets para quem escreveu "planilha" (§5).
  if (fonteNomeadaNoTexto(entrada.texto) === faltando.packId) {
    return opcoes.length === 0
      ? { desfecho: "sem_opcao" }
      : {
          desfecho: "falta_capacidade",
          necessidade: nomeDoPack(faltando.packId),
          opcoes,
        };
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
