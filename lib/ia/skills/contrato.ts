/**
 * CDS Skill Format v1 — o contrato. SKILL-1B.
 *
 * ── O que uma Skill e, e o que ela nunca podera ser ─────────────────
 *
 * Uma Skill e CONHECIMENTO OPERACIONAL: como um agente deve trabalhar
 * numa frente (atendimento, pos-venda, campanhas). Ela e importavel de
 * fora da CDS, entao e — por definicao — DADO NAO CONFIAVEL. Nunca
 * codigo, nunca autoridade.
 *
 * A consequencia pratica esta na lista de campos que este arquivo NAO
 * declara. Ver o bloco "Ausencias estruturais" abaixo: nao ha onde
 * escrever permissao, autonomia ou segredo, entao nao existe disciplina
 * a ser lembrada nem revisao a ser feita. O contrato recusa antes de
 * qualquer validador rodar.
 *
 * ── Os quatro conceitos, e por que este arquivo cobre so dois ───────
 *
 *   SKILL     conhecimento operacional          ← aqui
 *   FICHA     conhecimento de plataforma/API    ← aqui
 *   FUNCAO    o que o sistema executa           ← `HANDLERS`, nao aqui
 *   CONEXAO   credencial/autorizacao            ← `lojas`, nao aqui
 *
 * Skill e Ficha DESCREVEM; Funcao e Conexao ACONTECEM. Um dado nunca
 * promove a si mesmo a execucao: a Skill REFERENCIA funcoes por id e
 * jamais declara que uma delas existe, nem qual e o risco ou o acesso
 * dela — isso vive em `FuncaoUI`, que e a autoridade.
 *
 * ── Por que "funcao", e nao "capability" ────────────────────────────
 *
 * `capability` ja e palavra ocupada nesta base, com outro significado:
 * modulo `server-only` de acesso privilegiado a dados (ver
 * `lib/agentes/capability.ts`, `lib/marketplace/credenciais.ts`). Usar o
 * mesmo nome para "ferramenta do agente" criaria um homonimo em dezenas
 * de arquivos. `funcao` ja e o vocabulario da area de IA: `FuncaoUI`, a
 * aba "Funcoes", `funcaoDisponivel()`.
 *
 * ── O que este arquivo NAO tem, e nao e esquecimento ────────────────
 *
 * Sem parser, sem I/O, sem `server-only`, sem banco, sem rede. Tipos,
 * dominios fechados e duas funcoes puras. O parser e a validacao vivem
 * em `formato.ts` — quem so precisa dos tipos (a biblioteca, a UI) nao
 * arrasta junto o varredor de segredo.
 *
 * `fontesEfetivas()` NAO existe nesta fase, por decisao explicita:
 * compor Skill com as Fichas que ela referencia e resolucao, e resolucao
 * e fase posterior.
 */

/**
 * A versao do FORMATO — inteira, nao SemVer.
 *
 * Ha um consumidor so, e a unica pergunta que importa e "este arquivo
 * ainda e legivel por este codigo?". Um manifesto com `formato`
 * diferente e RECUSADO, nunca adaptado: adivinhar a intencao de um
 * formato desconhecido e como aceitar resposta de IA fora do contrato.
 *
 * Nao confundir com `versao`, que e a versao do CONTEUDO da Skill e usa
 * SemVer. Sao dois numeros de coisas diferentes, e por isso dois campos.
 */
export const FORMATO_SUPORTADO = 1;

// ─── Procedencia do conhecimento ──────────────────────────────────────

/**
 * De onde a Skill veio. Deliberadamente separado de `verificacao`.
 *
 * Sao dois eixos INDEPENDENTES: uma Skill importada pode estar conferida
 * contra documentacao oficial, e uma oficial da CDS pode estar velha.
 * Um enum so nao conseguiria dizer as duas coisas.
 *
 * NAO reusa `Procedencia` de `lib/ia/conceitos.ts`: aquela responde
 * "este dado da tela e real?" (disponivel/simulado/...), esta responde
 * "de onde veio este conhecimento?". Fundir daria um enum que significa
 * coisas diferentes conforme o contexto.
 */
export const ORIGENS_SKILL = ["oficial_cds", "importada", "gerada_ia"] as const;
export type OrigemSkill = (typeof ORIGENS_SKILL)[number];

export const ROTULO_ORIGEM: Record<OrigemSkill, string> = {
  oficial_cds: "Oficial CDS",
  importada: "Importada",
  gerada_ia: "Gerada por IA",
};

export function ehOrigemSkill(valor: unknown): valor is OrigemSkill {
  return typeof valor === "string" && (ORIGENS_SKILL as readonly string[]).includes(valor);
}

// ─── Plataforma de conexao ────────────────────────────────────────────

/**
 * As plataformas para as quais a CDS tem conexao de marketplace.
 *
 * ── Por que a autoridade nasce AQUI ─────────────────────────────────
 *
 * Ela e usada por tres camadas que nao podem divergir: o parser valida
 * o que entra, a leitura valida o que ja esta persistido, e
 * `MARKETPLACE_POR_PLATAFORMA` traduz para o valor que `lojas` guarda.
 * Este arquivo e puro, ja e dono de `RequisitoConexao` e `ManifestoFicha`
 * — os dois tipos cujo campo `plataforma` isto governa — e ja e a unica
 * dependencia do parser. Colocar a lista em qualquer um dos outros
 * significaria o parser importar `lib/agentes`, invertendo a camada.
 *
 * ── A grafia e canonica, e nao ha alias ─────────────────────────────
 *
 * `mercado_livre` com underscore, porque e essa a grafia que
 * `ConexaoUI.tipo` e o mapa de marketplace ja usam. `mercado-livre`
 * NAO e aceita: duas grafias para a mesma conta produziriam requisitos
 * que nunca se cruzam com a selecao do dono.
 *
 * Antes desta autoridade existir, `plataforma` era validada pelo mesmo
 * slug do `recurso` — que rejeita underscore. O resultado era uma
 * contradicao viva: `mercado_livre` estava no mapa de marketplace e
 * nenhuma Skill conseguia declara-lo.
 */
export const PLATAFORMAS_CONEXAO = ["mercado_livre", "shopee"] as const;
export type PlataformaConexao = (typeof PLATAFORMAS_CONEXAO)[number];

/** Deriva da constante acima — nunca de uma segunda lista. */
export function ehPlataformaConexao(valor: unknown): valor is PlataformaConexao {
  return typeof valor === "string" && (PLATAFORMAS_CONEXAO as readonly string[]).includes(valor);
}

// ─── Verificacao ──────────────────────────────────────────────────────

/**
 * Contra o que este conhecimento foi conferido, e quando.
 *
 * `fontes` NUNCA e array vazio quando a chave existe. Ausencia significa
 * "nao verificado"; presenca significa "verificado contra isto". Uma
 * lista vazia seria a afirmacao sem lastro — o pior dos tres estados,
 * porque parece verificacao. Mesma regra que o projeto ja aplica em
 * structured output: campo opcional e CHAVE AUSENTE, nunca `null` nem
 * `[]`.
 */
export interface Verificacao {
  /** Data ISO curta, `AAAA-MM-DD`. */
  em: string;
  /** URLs `https:`. Ao menos uma. */
  fontes: readonly string[];
}

// ─── Requisitos declarados por uma Skill ──────────────────────────────

/**
 * "Preciso de uma conexao Shopee que sirva para Chat."
 *
 * Dois campos, e o segundo e a razao de este tipo existir. `plataforma`
 * o sistema consegue conferir hoje (`lojas.ativo`, token, validade).
 * `recurso` NAO — a tabela `lojas` nao registra escopo nem recurso
 * autorizado. Declarar `recurso` mesmo assim e o que permite ao
 * diagnostico responder "nao sei se sua conexao Shopee autoriza Chat"
 * em vez de "voce tem Shopee, entao pode".
 *
 * Ter conexao com uma plataforma nunca implicou ter acesso a todos os
 * recursos dela, e o contrato precisa conseguir dizer isso.
 */
export interface RequisitoConexao {
  plataforma: string;
  recurso: string;
  obrigatoria: boolean;
}

/**
 * O que a Skill precisa para operar.
 *
 * Cada lista e OPCIONAL, e ausencia significa "nao preciso disto" — de
 * novo, chave ausente em vez de `[]`. Uma Skill puramente operacional
 * ("Politica Comercial CDS") nao referencia funcao nem conexao alguma, e
 * isso e valido.
 *
 * `funcoes` e `funcoes_opcionais` sao separadas porque a diferenca
 * decide o diagnostico: faltar uma obrigatoria bloqueia; faltar uma
 * opcional apenas reduz o alcance. Uma Skill de atendimento util sem
 * WhatsApp nao pode ser reprovada por nao ter WhatsApp.
 *
 * Aqui so entram IDS. Rotulo, acesso (leitura/escrita), risco e
 * disponibilidade sao de `FuncaoUI` — repetir aqui permitiria uma Skill
 * importada afirmar que uma escrita e leitura.
 */
export interface RequisitosSkill {
  funcoes?: readonly string[];
  funcoes_opcionais?: readonly string[];
  conexoes?: readonly RequisitoConexao[];
}

// ─── Manifesto da Skill ───────────────────────────────────────────────

/**
 * O cabecalho estruturado de uma Skill.
 *
 * ── Ausencias estruturais ───────────────────────────────────────────
 *
 * Nao existem, e nao podem passar a existir:
 *
 *   permissoes / autonomia / nivel   Skill declarar nivel seria Skill
 *                                    concedendo. Nivel vive em
 *                                    `PermissaoUI`, decidido pelo dono.
 *   credencial / token / api_key     Segredo pertence a Conexoes. Sem
 *                                    campo, nao ha onde guardar.
 *   codigo / handler / script        Skill e dado, nunca codigo.
 *   user_id / agente_id              Skill e portatil; amarrar a um dono
 *                                    impediria exportar.
 *
 * A validacao de `formato.ts` descarta e REPORTA qualquer uma dessas
 * chaves se ela chegar num arquivo importado. Mas a defesa primaria e
 * esta: o tipo nao as tem, entao nenhum codigo consegue le-las.
 *
 * ── Por que `quando_usar` e obrigatorio ─────────────────────────────
 *
 * E o unico campo que permite decidir se a Skill e relevante SEM
 * carregar o corpo dela. Sem ele, a unica forma de saber se uma Skill
 * serve seria injetar o texto inteiro — que e exatamente o custo de
 * token que o formato existe para evitar.
 */
export interface ManifestoSkill {
  formato: number;
  /** Slug estavel, unico na biblioteca: `atendimento-shopee`. */
  id: string;
  nome: string;
  /** SemVer do CONTEUDO: `1.2.0`. */
  versao: string;
  /** Uma linha. Aparece na lista da biblioteca. */
  descricao: string;
  /** Frases curtas de roteamento. Ao menos uma. */
  quando_usar: readonly string[];
  requer?: RequisitosSkill;
  /** Ids de Ficha. Nunca conteudo embutido — ver `ManifestoFicha`. */
  fichas?: readonly string[];
  origem: OrigemSkill;
  /** Ausente = esta Skill nao tem verificacao PROPRIA. */
  verificacao?: Verificacao;
}

/**
 * Manifesto + corpo.
 *
 * O corpo e Markdown livre, e e conteudo do USUARIO — nao instrucao de
 * sistema. Quando existir montagem de prompt, ele entrara delimitado e
 * rotulado como configuracao fornecida, jamais concatenado como se fosse
 * autoridade da CDS. As regras invioláveis (nao inventar, nao afirmar
 * sem evidencia, nao conceder permissao) vivem do lado do sistema e nao
 * sao sobrescreviveis por Skill.
 *
 * Nesta fase nada disso roda: nao ha prompt, nao ha modelo, nao ha chat.
 * O corpo e apenas texto validado e guardado como texto.
 */
export interface Skill {
  manifesto: ManifestoSkill;
  corpo: string;
}

// ─── Manifesto da Ficha de Integracao ─────────────────────────────────

/**
 * Conhecimento estruturado sobre uma plataforma/API.
 *
 * ── Por que documento separado, e nao parte da Skill ────────────────
 *
 * "Shopee Atendimento", "Shopee Pos-venda" e "Shopee Monitoramento"
 * compartilhariam a maior parte da mesma documentacao. Embutida, seriam
 * tres copias que divergem na primeira mudanca da plataforma, tres
 * atualizacoes manuais e tres vezes o custo de token quando duas fossem
 * carregadas juntas. A Skill referencia por ID.
 *
 * ── A Ficha DECLARA; ela nao VERIFICA ───────────────────────────────
 *
 * `requisitos_declarados` diz o que a plataforma exige. Nao diz, e nao
 * pode dizer, que a conexao DESTE usuario satisfaz isso — a Ficha nao
 * conhece conexao nenhuma. Conferir e trabalho do diagnostico, que le
 * `lojas`; e para varios requisitos ele so vai conseguir responder "nao
 * tenho como saber", porque a coluna de escopo nao existe.
 *
 * Por isso nao ha aqui: conexao real, estado de autorizacao, segredo,
 * scope concedido, nem codigo.
 */
export interface ManifestoFicha {
  formato: number;
  /** Slug: `shopee-chat`. */
  id: string;
  /** Slug da plataforma: `shopee`. */
  plataforma: string;
  /** Slug do recurso dentro dela: `chat`, `pedidos`, `ads`. */
  recurso: string;
  versao: string;
  /**
   * OBRIGATORIA — ao contrario da Skill.
   *
   * A Ficha e a autoridade documental sobre a plataforma. Uma que nao
   * diz contra o que foi conferida, e quando, nao tem como ser avaliada
   * por quem a le depois. A Skill pode nao ter verificacao propria
   * justamente porque delega essa autoridade as Fichas que referencia —
   * e por isso ela tambem NAO precisa repetir as URLs delas.
   */
  verificacao: Verificacao;
  /**
   * O que a plataforma exige, em frases legiveis.
   *
   * Array VAZIO e valido aqui, e a assimetria com `Verificacao.fontes` e
   * proposital: "esta plataforma nao exige nada de especial" e uma
   * afirmacao possivel e util. Ja "verifiquei contra nenhuma fonte" nao
   * e afirmacao — e verificacao inexistente se passando por existente.
   */
  requisitos_declarados: readonly string[];
}

export interface Ficha {
  manifesto: ManifestoFicha;
  corpo: string;
}

// ─── Derivacao de contrato ────────────────────────────────────────────

/**
 * A Skill tem verificacao propria?
 *
 * Derivada, nunca armazenada em paralelo — mesmo padrao de `permitida()`
 * e `derivarStatusAgente()`. Um campo booleano ao lado de `verificacao`
 * seria uma segunda verdade que um dia discorda da primeira.
 *
 * `false` NAO significa "nao confiavel": significa que a autoridade
 * documental, se houver, esta nas Fichas referenciadas. Quem une as duas
 * coisas e a fase de resolucao, que ainda nao existe.
 */
export function temVerificacaoPropria(skill: Pick<ManifestoSkill, "verificacao">): boolean {
  return skill.verificacao !== undefined;
}
