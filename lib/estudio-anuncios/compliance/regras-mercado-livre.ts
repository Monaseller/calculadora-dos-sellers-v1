/**
 * REGISTRO DE REGRAS — Mercado Livre (2026-08-23).
 *
 * Cada regra carrega `fonteOficial` e `verificadoEm`. Nada aqui vem de
 * memória do modelo, de blog, de fórum ou de documentação de terceiros:
 * as três páginas oficiais abaixo foram lidas nesta data e os números
 * transcritos literalmente. `docs/MARKETPLACE_COMPLIANCE.md` espelha
 * esta tabela em prosa.
 *
 * FONTES (developers.mercadolibre.com.ar, oficial):
 *   [A] /en_us/list-products        — "List products", atualizada 30/12/2025
 *   [B] /en_us/working-with-pictures — "Working with pictures", atualizada 24/03/2026
 *   [C] /en_us/listing-validator     — "Listing validator", atualizada 30/12/2025
 *
 * O ACHADO MAIS IMPORTANTE DESTA AUDITORIA: quase todo limite numérico do
 * Mercado Livre é **definido pela categoria**, não pela plataforma. A
 * fonte [A] mostra o objeto `settings` de `/categories/$CATEGORY_ID` com
 * `max_title_length`, `max_description_length`, `max_pictures_per_item`,
 * `currencies`, `item_conditions`, `price: "required"` e
 * `stock: "required"` — todos por categoria. Sem `category_id` resolvido,
 * esses limites são **não verificáveis**, e por isso NÃO existe aqui
 * nenhuma regra que congele "título = 60 caracteres": o 60 do exemplo da
 * documentação vale para a categoria do exemplo, não para o site.
 *
 * DIVERGÊNCIA REGISTRADA DENTRO DA PRÓPRIA DOCUMENTAÇÃO OFICIAL: a fonte
 * [A], na seção "Pictures", diz "you should add an array of up to six URL
 * pictures", enquanto o `settings` da mesma página traz
 * `max_pictures_per_item: 12`. Como o número por categoria é o que a API
 * de fato aplica, o limite superior é tratado como NÃO VERIFICÁVEL sem
 * categoria — nunca como 6 nem como 12.
 */
import type { RegraCompliance } from "./tipos";

/**
 * Sobe quando qualquer regra muda. Invalida compliance anterior porque
 * entra no hash da entrada.
 *
 * **v7 (2026-08-29):** as imagens passaram a ser SELECIONADAS de forma
 * deterministica e a entrar no payload por identidade estavel
 * (id + checksum). Quantidade acima do maximo deixou de ser bloqueio e
 * virou ALERTA: agora o excedente e cortado na ordem, em vez de tornar
 * o anuncio impublicavel.
 *
 * **v6 (2026-08-28):** as medidas da embalagem passaram a exigir NUMERO
 * INTEIRO — "Only integers are accepted for dimensions and weight",
 * literal da resposta de /items/validate. O parecer distingue "nao
 * informado" de "formato invalido": um pede preencher, o outro corrigir.
 *
 * **v5 (2026-08-27):** peso e dimensoes da EMBALAGEM viraram bloqueio —
 * exigencia confirmada pela propria API em /items/validate.
 *
 * **v4 (2026-08-26):** modelo da conta (User Products vs legacy) e
 * `family_name` entram como regras — o modelo novo nao envia `title` e
 * exige `family_name` <= `max_title_length` da categoria.
 *
 * **v3 (2026-08-25):** com a CONTA vinculada, `listing_type_id` passou a
 * ser conferido contra os tipos que a conta de fato permite.
 *
 * **v2 (2026-08-24):** com `category_id` resolvido e o snapshot de
 * `settings` gravado, limites que antes eram `nao_verificavel` passaram a
 * ser verificados de verdade — título, descrição, moeda, condição,
 * quantidade de imagens — e os atributos obrigatórios REAIS da categoria
 * passaram a gerar pendência. Pareceres da v1 foram invalidados por isso.
 */
export const VERSAO_REGRAS_ML = 7;

/**
 * Tipos de anúncio citados LITERALMENTE nos exemplos das fontes oficiais
 * [A] e [C] — `gold_pro`, `gold_special`, `bronze`, `silver`. Não é
 * memória: são as strings que aparecem nos JSONs de exemplo das páginas
 * lidas em 2026-08-23.
 *
 * **Por que uma lista aqui em vez de buscar na API:** o endpoint
 * `/sites/{site}/listing_types` responde **403 sem OAuth** (verificado em
 * 2026-08-24), e este módulo não faz chamada autenticada. Então o servidor
 * aceita apenas valores desta lista — nunca string arbitrária — e emite o
 * alerta `ml_tipo_anuncio_nao_verificado_na_conta`, porque **quais deles a
 * conta e a categoria de fato permitem** só a API autenticada sabe.
 */
/**
 * Unidades EXIGIDAS pelos atributos de embalagem, conferidas na API real
 * em 2026-08-27: dimensões só aceitam `cm`, peso só aceita `g`.
 * Guardamos exatamente nelas — não há conversão em lugar nenhum, e
 * portanto não há onde perder precisão.
 */
export const UNIDADE_DIMENSAO_EMBALAGEM_ML = "cm";
export const UNIDADE_PESO_EMBALAGEM_ML = "g";

export const TIPOS_ANUNCIO_DOCUMENTADOS_ML = ["gold_pro", "gold_special", "silver", "bronze"] as const;
export type TipoAnuncioML = (typeof TIPOS_ANUNCIO_DOCUMENTADOS_ML)[number];

const FONTE_A = "https://developers.mercadolibre.com.ar/en_us/list-products (List products, atualizada 30/12/2025)";
const FONTE_B = "https://developers.mercadolibre.com.ar/en_us/working-with-pictures (Working with pictures, atualizada 24/03/2026)";
const FONTE_C = "https://developers.mercadolibre.com.ar/en_us/listing-validator (Listing validator, atualizada 30/12/2025)";
const FONTE_UP = "https://developers.mercadolibre.com.ar/en_us/user-products (User Products, atualizada 19/12/2025)";
/**
 * Fonte VIVA: a própria API declara os atributos, suas unidades e sua
 * obrigatoriedade. Verificada em `GET /categories/MLB425079/attributes`
 * em 2026-08-27 — `SELLER_PACKAGE_HEIGHT/WIDTH/LENGTH` com
 * `allowed_units: [cm]` e `SELLER_PACKAGE_WEIGHT` com
 * `allowed_units: [g]`, todos `hierarchy: ITEM`.
 */
const FONTE_ATRIBUTOS = "GET https://api.mercadolibre.com/categories/{id}/attributes (API oficial, verificada em 2026-08-27) + resposta real de POST /items/validate";
const VERIFICADO_EM = "2026-08-23";

/** Formatos de imagem aceitos — fonte [B], literal: "JPG, JPEG and PNG". */
export const MIMES_IMAGEM_ML = ["image/jpeg", "image/png"] as const;
/** Fonte [B], literal: "You can upload images up to 10 MB". */
export const TAMANHO_MAXIMO_IMAGEM_ML_BYTES = 10 * 1024 * 1024;
/** Fonte [B], literal: "the minimum is 500px x 500px (version M)". */
export const RESOLUCAO_MINIMA_IMAGEM_ML = 500;
/** Fonte [B], literal: "The maximum size accepted is 1920 x 1920 px (version F)". */
export const RESOLUCAO_MAXIMA_IMAGEM_ML = 1920;

function r(
  codigo: string,
  campo: string | null,
  regra: string,
  fonteOficial: string,
  tipo: RegraCompliance["tipo"],
  responsavel: RegraCompliance["responsavel"]
): RegraCompliance {
  return { codigo, marketplace: "ML", campo, regra, fonteOficial, verificadoEm: VERIFICADO_EM, tipo, responsavel };
}

export const REGRAS_ML: RegraCompliance[] = [
  // ── Pré-requisito do projeto (não é regra do marketplace) ────────────
  r(
    "ml_conteudo_nao_aprovado",
    null,
    "Só conteúdo com versão editorial APROVADA pode ser pré-validado. Regra do projeto, não do Mercado Livre: a camada editorial é a fonte única do que vai ao ar.",
    "Decisão de arquitetura do CDS — camada editorial (docs/CHANGELOG.md, 2026-08-20)",
    "bloqueio",
    "usuario"
  ),

  // ── Campos obrigatórios do POST /items — fonte [A] e [C] ────────────
  r("ml_titulo_ausente", "title", "`title` é obrigatório na criação do item.", `${FONTE_A}; ${FONTE_C}`, "bloqueio", "usuario"),
  r(
    "ml_categoria_nao_resolvida",
    "category_id",
    "`category_id` é obrigatório e só aceita IDs pré-estabelecidos do site. Literal da fonte: \"Sellers must define a category in MercadoLibre site. This attribute is mandatory and only accepts pre-established ids.\" O Estúdio não possui mecanismo de descoberta de categoria, e `categoriaProvavel` da IA é texto livre — nunca um `MLB…`.",
    FONTE_A,
    "bloqueio",
    "usuario"
  ),
  r("ml_preco_nao_informado", "price", "`price` é obrigatório. Literal: \"It is a required attribute: when you define a new item, it must have a price.\"", FONTE_A, "bloqueio", "usuario"),
  r("ml_estoque_nao_informado", "available_quantity", "`available_quantity` define o estoque do item e é exigido pelas categorias com `settings.stock = \"required\"`.", FONTE_A, "bloqueio", "usuario"),
  r("ml_condicao_nao_definida", "condition", "`condition` é obrigatório (`new`/`used`/`not_specified`, conforme `settings.item_conditions` da categoria).", `${FONTE_A}; ${FONTE_C}`, "bloqueio", "usuario"),
  r("ml_tipo_anuncio_nao_definido", "listing_type_id", "`listing_type_id` é obrigatório e define limites do anúncio.", `${FONTE_A}; ${FONTE_C}`, "bloqueio", "usuario"),

  // ── Imagens — fonte [B] ──────────────────────────────────────────────
  r("ml_sem_imagem", "pictures", "O item precisa de ao menos uma imagem; dependendo do tipo de anúncio as imagens são obrigatórias.", `${FONTE_A}; ${FONTE_B}`, "bloqueio", "sistema"),
  r("ml_imagem_sem_arquivo", "pictures", "Imagem referenciada sem objeto correspondente no Storage não pode ser enviada ao marketplace.", "Decisão de arquitetura do CDS — materialização (docs/CHANGELOG.md, 2026-08-22)", "bloqueio", "sistema"),
  r("ml_imagem_formato_invalido", "pictures", "Formatos aceitos: JPG, JPEG e PNG. Literal: \"Format JPG, JPEG and PNG.\"", FONTE_B, "bloqueio", "sistema"),
  r("ml_imagem_acima_do_tamanho", "pictures", "Limite de 10 MB por imagem. Literal: \"You can upload images up to 10 MB.\"", FONTE_B, "bloqueio", "sistema"),
  r("ml_imagem_abaixo_da_resolucao_minima", "pictures", "Resolução mínima 500x500 px. Literal: \"the minimum is 500px x 500px (version M)\".", FONTE_B, "bloqueio", "sistema"),
  r("ml_imagem_acima_da_resolucao_maxima", "pictures", "Acima de 1920x1920 px o Mercado Livre redimensiona a imagem. Literal: \"The maximum size accepted is 1920 x 1920 px (version F)\". Não impede publicar — avisa que o arquivo será alterado.", FONTE_B, "alerta", "sistema"),
  r("ml_quantidade_imagens_nao_verificavel", "pictures", "O máximo de imagens é por categoria (`max_pictures_per_item`); a própria documentação diverge (\"up to six\" no texto vs `max_pictures_per_item: 12` no exemplo de settings). Sem categoria, não é verificável.", FONTE_A, "nao_verificavel", "usuario"),
  r("ml_imagem_sem_aprovacao_humana", "pictures", "As imagens da Fase 1 não passam por aprovação editorial própria — só o texto passa. Antes de publicação real, isso exige decisão.", "Decisão de arquitetura do CDS — camada editorial (docs/NEXT_TASK.md)", "alerta", "usuario"),

  // ── Limites por categoria — não verificáveis sem categoria ───────────
  r("ml_titulo_limite_nao_verificavel", "title", "O limite de título é da categoria (`settings.max_title_length`), não do site. Sem categoria resolvida não há como validar o comprimento.", FONTE_A, "nao_verificavel", "usuario"),
  r("ml_descricao_limite_nao_verificavel", "description", "O limite de descrição é da categoria (`settings.max_description_length`).", FONTE_A, "nao_verificavel", "usuario"),
  r("ml_moeda_nao_verificavel", "currency_id", "`currency_id` é obrigatório e precisa ser uma das moedas aceitas pela categoria (`settings.currencies`). Sem categoria, não se sabe qual é válida — e escolher uma seria inventar.", FONTE_A, "nao_verificavel", "usuario"),
  r("ml_atributos_obrigatorios_nao_verificaveis", "attributes", "Os atributos obrigatórios vêm de `/categories/$CATEGORY_ID/attributes`. Sem categoria, o conjunto exigido é desconhecido.", FONTE_A, "nao_verificavel", "usuario"),

  // ── Atributos comuns que a ficha já poderia cobrir ───────────────────
  r("ml_marca_nao_informada", "attributes.BRAND", "BRAND é um dos atributos mais frequentemente exigidos. A ficha do produto não tem marca confirmada, e a IA não pode preenchê-la sem evidência.", FONTE_A, "alerta", "usuario"),
  r("ml_modelo_nao_informado", "attributes.MODEL", "MODEL é exigido em muitas categorias. Não está na ficha do produto.", FONTE_A, "alerta", "usuario"),
  r("ml_gtin_nao_informado", "attributes.GTIN", "Identificadores de produto (GTIN/EAN) são exigidos em parte das categorias. Não existem no Estúdio hoje.", FONTE_A, "alerta", "usuario"),
  r("ml_sku_nao_informado", "attributes.SELLER_SKU", "SELLER_SKU é o campo que o Mercado Livre considera para o SKU do vendedor. Opcional, mas recomendado para rastreio interno.", FONTE_A, "alerta", "usuario"),

  // ── Políticas oficiais de título — texto literal da fonte [A] ────────
  r("ml_titulo_menciona_condicao", "title", "Literal: \"If your product is new, used or refurbished, do not include it in the title\".", FONTE_A, "alerta", "usuario"),
  r("ml_titulo_menciona_estoque", "title", "Literal: \"It is not allowed to mention stock if you do it your publication will be moderated.\"", FONTE_A, "alerta", "usuario"),
  r("ml_titulo_menciona_servico", "title", "Literal: \"Avoid in the title information of other services, such as returns, free shipping or installment payments\".", FONTE_A, "alerta", "usuario"),

  // ── v2: verificáveis DEPOIS que a categoria existe ──────────────────
  // Todos usam o snapshot oficial de `settings` gravado ao salvar a
  // categoria — nenhum número está congelado no código.
  r(
    "ml_categoria_nao_permite_publicacao",
    "category_id",
    "A categoria precisa estar habilitada para publicar. Literal da fonte: \"the listing_allowed field should have true value and the status field, enabled value\". Categoria intermediária costuma ter `listing_allowed: false` — o item vai numa folha.",
    FONTE_A,
    "bloqueio",
    "usuario"
  ),
  r("ml_titulo_acima_do_limite", "title", "O título excede `settings.max_title_length` da categoria escolhida.", FONTE_A, "bloqueio", "usuario"),
  r("ml_descricao_acima_do_limite", "description", "A descrição excede `settings.max_description_length` da categoria escolhida.", FONTE_A, "bloqueio", "usuario"),
  r("ml_condicao_invalida_para_categoria", "condition", "A condição precisa estar em `settings.item_conditions` da categoria.", FONTE_A, "bloqueio", "usuario"),
  r("ml_moeda_indefinida_para_categoria", "currency_id", "`currency_id` é obrigatório e sai de `settings.currencies`. Quando a categoria aceita mais de uma moeda, escolher sozinho seria inventar.", FONTE_A, "bloqueio", "usuario"),
  r("ml_imagens_acima_do_maximo", "pictures", "O número de imagens excede `settings.max_pictures_per_item` da categoria.", `${FONTE_A}; ${FONTE_B}`, "bloqueio", "sistema"),
  r(
    "ml_atributo_obrigatorio_ausente",
    "attributes",
    "Atributo marcado como obrigatório em `GET /categories/{id}/attributes` (tag `required`) e sem valor real disponível. Preencher inventando valor é proibido.",
    FONTE_A,
    "bloqueio",
    "usuario"
  ),
  r(
    "ml_atributo_condicional_ausente",
    "attributes",
    "Atributo marcado como `conditional_required` na categoria: pode ser exigido dependendo do produto. Como a condição de exigência não é conhecida offline, entra como alerta, nunca bloqueio.",
    FONTE_A,
    "alerta",
    "usuario"
  ),
  r("ml_tipo_anuncio_invalido", "listing_type_id", "Valor fora dos tipos de anúncio que aparecem nos exemplos oficiais (`gold_pro`, `gold_special`, `silver`, `bronze`).", `${FONTE_A}; ${FONTE_C}`, "bloqueio", "usuario"),
  r(
    "ml_tipo_anuncio_nao_verificado_na_conta",
    "listing_type_id",
    "Quais tipos de anúncio a conta e a categoria permitem só é sabido via `GET /sites/{site}/listing_types`, que exige OAuth. O valor está entre os documentados, mas a disponibilidade não foi verificada.",
    FONTE_A,
    "alerta",
    "marketplace"
  ),
  r(
    "ml_categoria_nao_folha",
    "category_id",
    "A categoria escolhida tem subcategorias. O Mercado Livre publica em categoria folha; uma categoria intermediária normalmente também traz `listing_allowed: false`.",
    FONTE_A,
    "alerta",
    "usuario"
  ),

  // ── v3: verificavel DEPOIS que a conta esta vinculada ───────────────
  r(
    "ml_tipo_anuncio_nao_disponivel_na_conta",
    "listing_type_id",
    "O tipo de anuncio precisa estar entre os que a CONTA permite, obtidos em  com o token da conta. Enquanto nao houver conta vinculada, so da para conferir contra a lista documentada.",
    FONTE_A,
    "bloqueio",
    "usuario"
  ),
  r(
    "ml_conta_nao_vinculada",
    null,
    "Publicar exige uma conta do Mercado Livre conectada ao canal. Regra do projeto: sem conta nao ha token, e sem token nao ha validacao oficial.",
    "Decisao de arquitetura do CDS — vinculo projeto→loja (docs/CHANGELOG.md, 2026-08-25)",
    "alerta",
    "usuario"
  ),

  // ── v4: modelo da conta (User Products) ─────────────────────────────
  r(
    "ml_modelo_publicacao_nao_resolvido",
    null,
    "O modelo de publicação da conta (User Products ou legacy) precisa ser resolvido em `GET /users/{seller_id}` antes de montar o payload: os dois formatos são incompatíveis. Nunca é inferido do erro de `/items/validate` — aquele erro só diria que algo faltou.",
    FONTE_UP,
    "bloqueio",
    "sistema"
  ),
  r(
    "ml_family_name_nao_informado",
    "family_name",
    "No modelo User Products, `family_name` é obrigatório e é responsabilidade do integrador. Literal da fonte: \"Will the family_name be managed by the integrator? … Yes, it is the responsibility of the seller/integrator.\" NÃO é o título do anúncio: no modelo novo o título é montado pelo Mercado Livre.",
    FONTE_UP,
    "bloqueio",
    "usuario"
  ),
  r(
    "ml_family_name_excede_limite",
    "family_name",
    "Literal da fonte: \"The family_name that can be entered must be less than or equal to the domain's max_title_length.\" O limite vem da categoria/domínio pela API — nunca fixo no código.",
    FONTE_UP,
    "bloqueio",
    "usuario"
  ),
  r(
    "ml_titulo_nao_enviado_no_modelo_novo",
    "title",
    "No modelo User Products o título NÃO é enviado pelo integrador. Literal da fonte [A]: \"In the new way of publishing (User Products) the title field will change its function and should not be included in the publication.\" O título editorial continua existindo e intacto — a diferença vive só no payload.",
    FONTE_A,
    "alerta",
    "marketplace"
  ),

  // ── v5: dados logísticos da EMBALAGEM ───────────────────────────────
  // Exigência confirmada pela própria API em 2026-08-26:
  // `item.attribute.missing.seller.package.dimensions` — "The attributes
  // [seller_package_height, seller_package_width, seller_package_length,
  // seller_package_weight] are all required".
  r(
    "ml_peso_embalagem_nao_informado",
    "attributes.SELLER_PACKAGE_WEIGHT",
    "`SELLER_PACKAGE_WEIGHT` é obrigatório. É o peso da EMBALAGEM DE ENVIO em gramas (allowed_units: apenas `g`) — inclui caixa, enchimento e fita. NUNCA é o peso do produto, e nada no sistema o deriva dele.",
    FONTE_ATRIBUTOS,
    "bloqueio",
    "usuario"
  ),
  r(
    "ml_altura_embalagem_nao_informada",
    "attributes.SELLER_PACKAGE_HEIGHT",
    "`SELLER_PACKAGE_HEIGHT` é obrigatório: altura da EMBALAGEM em centímetros (allowed_units: apenas `cm`). Não é a altura do produto.",
    FONTE_ATRIBUTOS,
    "bloqueio",
    "usuario"
  ),
  r(
    "ml_largura_embalagem_nao_informada",
    "attributes.SELLER_PACKAGE_WIDTH",
    "`SELLER_PACKAGE_WIDTH` é obrigatório: largura da EMBALAGEM em centímetros. Não é a largura do produto.",
    FONTE_ATRIBUTOS,
    "bloqueio",
    "usuario"
  ),
  r(
    "ml_comprimento_embalagem_nao_informado",
    "attributes.SELLER_PACKAGE_LENGTH",
    "`SELLER_PACKAGE_LENGTH` é obrigatório: comprimento da EMBALAGEM em centímetros. Não é o comprimento do produto.",
    FONTE_ATRIBUTOS,
    "bloqueio",
    "usuario"
  ),

  // v6: formato. "Não informado" e "informado errado" são coisas
  // diferentes, e quem lê o parecer precisa saber qual das duas é: uma
  // pede preencher, a outra pede corrigir.
  r(
    "ml_embalagem_medida_nao_inteira",
    "attributes.SELLER_PACKAGE_*",
    "As medidas da embalagem devem ser NÚMEROS INTEIROS. Literal da resposta oficial de `POST /items/validate` (2026-08-27): \"Only integers are accepted for dimensions and weight, with centimeters 'cm' as the unit for dimensions and grams 'g' as the unit for weight. Examples: 10 cm, 100 g\". O valor NÃO é arredondado em lugar nenhum — arredondar publicaria uma medida diferente da informada.",
    FONTE_ATRIBUTOS,
    "bloqueio",
    "usuario"
  ),

  // ── v7: imagens que de fato podem ser ENVIADAS ──────────────────────
  // "Ter imagem" e "poder enviar imagem" não são a mesma coisa: um
  // arquivo ausente no Storage ou num formato recusado conta como
  // imagem no banco e como nada na hora da publicação.
  r(
    "ml_sem_imagem_valida_para_envio",
    "pictures",
    "O projeto tem imagens, mas NENHUMA passa nos requisitos técnicos do Mercado Livre — então não há o que enviar. Literal do validador oficial (2026-08-27): \"Item pictures are mandatory for listing type gold_special\".",
    `${FONTE_B}; ${FONTE_C}`,
    "bloqueio",
    "usuario"
  ),
  r(
    "ml_imagem_principal_ausente",
    "pictures",
    "Nenhuma imagem está marcada como principal. A primeira imagem é a capa do anúncio, e escolher uma capa \"qualquer\" seria decidir apresentação no lugar de quem publica. A ordem enviada é: principal primeiro, depois `ordem` crescente.",
    "Decisão de arquitetura do CDS — seleção determinística de imagens (2026-08-29)",
    "alerta",
    "usuario"
  ),
  r(
    "ml_imagens_excedentes_nao_enviadas",
    "pictures",
    "Há mais imagens válidas do que `max_pictures_per_item` permite nesta categoria. As excedentes NÃO são enviadas. O corte é determinístico (principal, depois `ordem`, depois id) — nunca aleatório — e fica registrado quais ficaram de fora.",
    FONTE_A,
    "alerta",
    "marketplace"
  ),

  // ── Ressalva permanente ─────────────────────────────────────────────
  r(
    "ml_validacao_final_no_marketplace",
    null,
    "A validação definitiva é do próprio Mercado Livre, via `POST /items/validate`, que exige token OAuth. Esta camada é PRÉ-publicação: nenhum \"aprovado\" aqui é garantia de aceitação.",
    FONTE_C,
    "alerta",
    "marketplace"
  ),
];

const PORCODIGO = new Map(REGRAS_ML.map(regra => [regra.codigo, regra]));

/** Falha alto: código de regra inexistente é bug, não item de compliance. */
export function regraML(codigo: string): RegraCompliance {
  const achada = PORCODIGO.get(codigo);
  if (!achada) throw new Error(`Regra de compliance desconhecida: ${codigo}`);
  return achada;
}

// Integridade do registro, no boot: código duplicado tornaria a origem da
// regra ambígua — exatamente o que este arquivo existe para impedir.
if (PORCODIGO.size !== REGRAS_ML.length) {
  throw new Error("REGRAS_ML tem código duplicado.");
}
