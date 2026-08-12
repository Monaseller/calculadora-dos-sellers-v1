/**
 * Construtor ÚNICO do payload de publicação do Mercado Livre
 * (2026-08-25, adaptado a User Products em 2026-08-26).
 *
 * A REGRA QUE ESTE ARQUIVO EXISTE PARA GARANTIR: **compliance valida A e
 * a publicação envia A.** O payload submetido a `/items/validate` e o
 * payload que um futuro `POST /items` consumirá são o MESMO artefato,
 * produzido aqui a partir do parecer de compliance corrente — nunca
 * remontado a partir de "o conteúdo mais recente" ou de dados paralelos.
 *
 * DOIS MODELOS, DOIS BUILDERS, NENHUM `if` espalhado:
 *
 *   `user_products` — modelo novo. **`title` NÃO é enviado** (o Mercado
 *     Livre monta o título) e `family_name` é obrigatório. `variations`
 *     é proibido. Fonte oficial [A], seção Title: *"In the new way of
 *     publishing (User Products) the title field will change its function
 *     and should not be included in the publication."* E a doc de User
 *     Products: *"Will it be possible to send the variations array after
 *     a seller is activated…? No, you will not be able to send the array"*.
 *
 *   `legacy` — modelo anterior: `title` enviado, sem `family_name`.
 *
 * O CONTRATO EDITORIAL NÃO MUDA. O título aprovado continua existindo,
 * versionado e intacto — a diferença vive só aqui, no adapter. Nada neste
 * arquivo escreve em `conteudo_versoes`.
 *
 * NÃO PUBLICA. Não existe `POST /items` aqui.
 */
import { createHash } from "node:crypto";
import type { ModeloPublicacaoML } from "./ml-conta";
import { UNIDADE_DIMENSAO_EMBALAGEM_ML, UNIDADE_PESO_EMBALAGEM_ML } from "./regras-mercado-livre";

/**
 * Sobe quando o formato do payload muda. Entra no hash, então uma
 * mudança aqui invalida as validações oficiais anteriores — o Mercado
 * Livre validou outro documento.
 *
 * **v2 (2026-08-26):** suporte a User Products — `title` sai e
 * `family_name` entra quando a conta está no modelo novo.
 */
export const VERSAO_CONSTRUTOR_PAYLOAD_ML = 4;

/** Campos comuns aos dois modelos. */
interface PayloadBaseML {
  category_id: string | null;
  price: number | null;
  currency_id: string | null;
  available_quantity: number | null;
  buying_mode: string;
  listing_type_id: string | null;
  condition: string | null;
  description: { plain_text: string } | null;
  attributes: { id: string; value_id?: string; value_name: string }[];
  /**
   * IDENTIDADE ESTÁVEL das imagens — nunca URL. Ver `imagens-ml.ts`
   * para a distinção entre este payload (canônico, hasheado, persistido)
   * e o payload de TRANSPORTE (com `source`, efêmero).
   */
  pictures: {
    imagem_gerada_id: string;
    checksum: string | null;
    ordem: number | null;
    principal: boolean;
    /**
     * Picture id do CDN do Mercado Livre (2026-08-30). Ao contrário da
     * URL assinada, é **estável para a conta** — por isso ele PODE
     * viver no payload canônico e entrar no hash. `null` enquanto a
     * imagem não subiu (o compliance não faz OAuth e portanto nunca o
     * conhece).
     */
    ml_picture_id: string | null;
  }[];
}

/** Modelo novo: sem `title`, com `family_name`. */
export interface PayloadUserProductsML extends PayloadBaseML {
  family_name: string | null;
}

/** Modelo anterior: com `title`, sem `family_name`. */
export interface PayloadLegacyML extends PayloadBaseML {
  title: string | null;
}

export type PayloadPublicacaoML = PayloadUserProductsML | PayloadLegacyML;

export interface ArtefatoPublicacaoML {
  modelo: ModeloPublicacaoML;
  payload: PayloadPublicacaoML;
  /** Ids das imagens que a publicação usará — nunca vão à validação. */
  imagensReferenciadas: string[];
  /** `false` quando falta campo obrigatório: o portão barra. */
  completo: boolean;
  camposFaltando: string[];
  hashPayload: string;
  versaoConstrutor: number;
}

export interface EntradaConstrutorML {
  payloadCompliance: Record<string, any> | null;
  /** Conta que vai publicar: entra no hash, não no corpo enviado. */
  lojaId: string;
  versaoAprovadaId: string | null;
  /**
   * Modelo resolvido pela API da conta. `null` = ainda não resolvido —
   * e aí o payload sai incompleto de propósito, porque não dá para
   * escolher o formato sem saber o modelo.
   */
  modelo: ModeloPublicacaoML | null;
  /** Obrigatório em `user_products`; ignorado em `legacy`. */
  familyName?: string | null;
  /**
   * Embalagem de ENVIO, nas unidades do ML (cm e g). Nunca derivada do
   * produto — ver o comentário em `montarAtributosEmbalagem`.
   */
  embalagem?: { pesoG: number | null; alturaCm: number | null; larguraCm: number | null; comprimentoCm: number | null } | null;
  /**
   * `imagem_gerada_id` → `ml_picture_id`, preenchido DEPOIS do upload
   * oficial. Fica fora do compliance de propósito: subir imagem exige
   * OAuth, e a camada de pré-publicação não faz chamada autenticada.
   */
  picturesML?: Map<string, string> | null;
}

const OBRIGATORIOS_COMUNS = [
  "category_id", "price", "currency_id",
  "available_quantity", "listing_type_id", "condition",
] as const;

/**
 * `pictures` é obrigatório e tem checagem própria porque o "vazio" dele
 * é um array, não `null` — o filtro de `OBRIGATORIOS_COMUNS` não pegaria.
 * O validador oficial recusa o anúncio sem imagem
 * (`item.listing_type_id.requiresPictures`, 2026-08-27).
 */
function faltamPictures(payload: PayloadPublicacaoML): boolean {
  return payload.pictures.length === 0;
}

/** Aplica os picture ids do ML sem mexer em mais nada do payload. */
function comPictureIds(base: PayloadBaseML, mapa?: Map<string, string> | null): PayloadBaseML {
  if (!mapa || mapa.size === 0) return base;
  return {
    ...base,
    pictures: base.pictures.map(i => ({ ...i, ml_picture_id: mapa.get(i.imagem_gerada_id) ?? i.ml_picture_id })),
  };
}

function montarBase(p: Record<string, any>): PayloadBaseML {
  return {
    category_id: typeof p.category_id === "string" ? p.category_id : null,
    price: typeof p.price === "number" && p.price > 0 ? p.price : null,
    currency_id: typeof p.currency_id === "string" ? p.currency_id : null,
    available_quantity: typeof p.available_quantity === "number" ? p.available_quantity : null,
    buying_mode: typeof p.buying_mode === "string" ? p.buying_mode : "buy_it_now",
    listing_type_id: typeof p.listing_type_id === "string" ? p.listing_type_id : null,
    condition: typeof p.condition === "string" ? p.condition : null,
    description:
      p.description && typeof p.description.plain_text === "string" && p.description.plain_text.trim() !== ""
        ? { plain_text: p.description.plain_text }
        : null,
    pictures: Array.isArray(p.pictures)
      ? p.pictures
          .filter((i: any) => i && typeof i.imagem_gerada_id === "string")
          .map((i: any) => ({
            imagem_gerada_id: i.imagem_gerada_id,
            checksum: typeof i.checksum === "string" ? i.checksum : null,
            ordem: typeof i.ordem === "number" ? i.ordem : null,
            principal: i.principal === true,
            ml_picture_id: typeof i.ml_picture_id === "string" && i.ml_picture_id !== "" ? i.ml_picture_id : null,
          }))
      : [],
    attributes: Array.isArray(p.attributes)
      ? p.attributes
          .filter((a: any) => a && typeof a.id === "string" && typeof a.value_name === "string" && a.value_name.trim() !== "")
          .map((a: any) => (a.value_id ? { id: a.id, value_id: a.value_id, value_name: a.value_name } : { id: a.id, value_name: a.value_name }))
          .sort((a: any, b: any) => a.id.localeCompare(b.id))
      : [],
  };
}

/**
 * Atributos `SELLER_PACKAGE_*` da EMBALAGEM DE ENVIO.
 *
 * As unidades são as que a API declara e são as ÚNICAS aceitas
 * (verificado em `/categories/{id}/attributes`, 2026-08-27): dimensões em
 * `cm`, peso em `g`. Como guardamos exatamente nessas unidades, **não há
 * conversão** — o valor vai como veio.
 *
 * Nada aqui olha para o peso ou as medidas do PRODUTO: uma caixa não tem
 * o tamanho do que está dentro dela.
 *
 * Só monta os quatro `SELLER_PACKAGE_*` (`hierarchy: ITEM`). Os
 * `PACKAGE_*` (`hierarchy: FAMILY`) são `read_only` e nunca são enviados.
 *
 * **Isto aqui SERIALIZA, não calcula.** O valor persistido é inteiro
 * (o ML só aceita inteiro, confirmado em `/items/validate` 2026-08-27) e
 * sai como está: `13` vira `"13 cm"`, `420` vira `"420 g"`. Não há
 * `Math.round`, `Math.floor`, `Math.ceil` nem `parseInt` — arredondar
 * aqui publicaria um número diferente do que está gravado, e um teste
 * falha se algum deles aparecer neste caminho.
 */
export function montarAtributosEmbalagem(
  embalagem: EntradaConstrutorML["embalagem"]
): { id: string; value_name: string }[] {
  if (!embalagem) return [];
  const attrs: { id: string; value_name: string }[] = [];
  const dim = (id: string, valor: number | null | undefined) => {
    if (valor == null) return;
    attrs.push({ id, value_name: `${valor} ${UNIDADE_DIMENSAO_EMBALAGEM_ML}` });
  };
  dim("SELLER_PACKAGE_HEIGHT", embalagem.alturaCm);
  dim("SELLER_PACKAGE_WIDTH", embalagem.larguraCm);
  dim("SELLER_PACKAGE_LENGTH", embalagem.comprimentoCm);
  if (embalagem.pesoG != null) {
    attrs.push({ id: "SELLER_PACKAGE_WEIGHT", value_name: `${embalagem.pesoG} ${UNIDADE_PESO_EMBALAGEM_ML}` });
  }
  return attrs;
}

/**
 * Modelo NOVO. `title` fica de fora — não é omissão por esquecimento, é
 * o que a documentação manda. `variations` também nunca é montado aqui.
 */
export function montarPayloadUserProducts(
  p: Record<string, any>,
  familyName: string | null | undefined,
  embalagem?: EntradaConstrutorML["embalagem"],
  picturesML?: Map<string, string> | null
): PayloadUserProductsML {
  const nome = typeof familyName === "string" && familyName.trim() !== "" ? familyName.trim() : null;
  const base = comPictureIds(montarBase(p), picturesML);
  // Os atributos de embalagem entram junto dos demais, ordenados por id
  // para o payload ser estável.
  const attrs = [...base.attributes, ...montarAtributosEmbalagem(embalagem)]
    .sort((a, b) => a.id.localeCompare(b.id));
  return { ...base, attributes: attrs, family_name: nome };
}

/** Modelo ANTERIOR, preservado intacto: `title` enviado, sem família. */
export function montarPayloadLegacy(p: Record<string, any>, picturesML?: Map<string, string> | null): PayloadLegacyML {
  return {
    ...comPictureIds(montarBase(p), picturesML),
    title: typeof p.title === "string" && p.title.trim() !== "" ? p.title : null,
  };
}

/**
 * Ponto de entrada único. Escolhe o builder pelo modelo REAL da conta —
 * um `switch` num lugar só, em vez de condicionais espalhadas.
 */
export function montarPayloadPublicacaoMercadoLivre(
  entrada: EntradaConstrutorML
): ArtefatoPublicacaoML {
  const p = entrada.payloadCompliance ?? {};
  const modelo = entrada.modelo;

  const payload: PayloadPublicacaoML =
    modelo === "user_products"
      ? montarPayloadUserProducts(p, entrada.familyName, entrada.embalagem ?? (p.embalagem as any) ?? null, entrada.picturesML)
      : montarPayloadLegacy(p, entrada.picturesML);

  const camposFaltando: string[] = OBRIGATORIOS_COMUNS.filter(
    c => (payload as any)[c] == null
  ).map(String);

  if (faltamPictures(payload)) camposFaltando.push("pictures");

  if (!modelo) {
    // Sem modelo resolvido não há formato certo — o portão precisa barrar.
    camposFaltando.push("modelo_publicacao");
  } else if (modelo === "user_products") {
    if ((payload as PayloadUserProductsML).family_name == null) camposFaltando.push("family_name");
    // Os quatro atributos de embalagem sao obrigatorios (exigencia
    // confirmada pela API em /items/validate, 2026-08-26).
    const ids = new Set(payload.attributes.map(a => a.id));
    for (const id of ["SELLER_PACKAGE_HEIGHT", "SELLER_PACKAGE_WIDTH", "SELLER_PACKAGE_LENGTH", "SELLER_PACKAGE_WEIGHT"]) {
      if (!ids.has(id)) camposFaltando.push(id.toLowerCase());
    }
  } else if ((payload as PayloadLegacyML).title == null) {
    camposFaltando.push("title");
  }

  // Sai do payload já montado, não do bruto: assim reflete a SELEÇÃO
  // (principal primeiro, cortada no limite da categoria), que é o que
  // de fato será enviado.
  const imagensReferenciadas = payload.pictures.map(i => i.imagem_gerada_id);

  return {
    modelo: modelo ?? "legacy",
    payload,
    imagensReferenciadas,
    completo: camposFaltando.length === 0,
    camposFaltando,
    hashPayload: calcularHashPayload(payload, {
      lojaId: entrada.lojaId,
      versaoAprovadaId: entrada.versaoAprovadaId,
      imagens: imagensReferenciadas,
      modelo,
    }),
    versaoConstrutor: VERSAO_CONSTRUTOR_PAYLOAD_ML,
  };
}

/**
 * Hash da SUBMISSÃO. Cobre o payload inteiro (categoria, preço, estoque,
 * condição, tipo de anúncio, atributos, conteúdo aprovado, **título ou
 * family_name conforme o modelo**), a LOJA, as imagens referenciadas, o
 * **modelo da conta** e a versão do construtor.
 *
 * O modelo entra de propósito: uma validação feita no formato legacy não
 * pode valer depois que a conta virou User Products — seria publicar com
 * validação de outro documento.
 *
 * Deliberadamente fora: qualquer instante. Listas são ordenadas porque a
 * ordem não pode mudar o hash.
 */
export function calcularHashPayload(
  payload: PayloadPublicacaoML,
  contexto: {
    lojaId: string;
    versaoAprovadaId: string | null;
    imagens: string[];
    modelo: ModeloPublicacaoML | null;
  }
): string {
  const canonico = {
    versaoConstrutor: VERSAO_CONSTRUTOR_PAYLOAD_ML,
    modelo: contexto.modelo,
    lojaId: contexto.lojaId,
    versaoAprovadaId: contexto.versaoAprovadaId,
    imagens: [...contexto.imagens].sort(),
    payload: {
      // A IDENTIDADE das imagens entra no hash; a URL assinada, nunca.
      // Trocar de imagem, reordenar, ou trocar os BYTES mantendo o mesmo
      // id — os três invalidam a validação oficial anterior. Gerar uma
      // URL nova para os mesmos bytes não invalida nada, que é
      // exatamente o comportamento desejado: a URL é transporte.
      pictures: payload.pictures.map((i, indice) => ({
        id: i.imagem_gerada_id, checksum: i.checksum, posicao: indice,
        // Estável, ao contrário da URL assinada: entra no hash porque
        // muda o documento que o ML validou. Um picture id que troca sem
        // o checksum ter trocado é anomalia — e o hash a torna visível.
        mlPictureId: i.ml_picture_id ?? null,
      })),
      // Só um dos dois existe, conforme o modelo — e é isso que faz o
      // hash mudar quando a conta troca de formato.
      title: (payload as PayloadLegacyML).title ?? null,
      family_name: (payload as PayloadUserProductsML).family_name ?? null,
      category_id: payload.category_id,
      price: payload.price,
      currency_id: payload.currency_id,
      available_quantity: payload.available_quantity,
      buying_mode: payload.buying_mode,
      listing_type_id: payload.listing_type_id,
      condition: payload.condition,
      description: payload.description?.plain_text ?? null,
      attributes: [...payload.attributes]
        .map(a => ({ id: a.id, value_id: a.value_id ?? null, value_name: a.value_name }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    },
  };
  return createHash("sha256").update(JSON.stringify(canonico)).digest("hex");
}

/**
 * Sugestão de `family_name` a partir do conteúdo APROVADO. É sugestão,
 * não dado: quem confirma é a pessoa, e a UI diz isso.
 *
 * Corta em fronteira de palavra para não entregar palavra pela metade, e
 * **nunca** trunca em silêncio dentro do fluxo de gravação — esta função
 * só existe para preencher o campo antes da edição humana.
 */
export function sugerirFamilyName(tituloAprovado: string | null | undefined, limite: number | null): string {
  const base = (tituloAprovado ?? "").trim().replace(/\s+/g, " ");
  if (!base) return "";
  if (!limite || base.length <= limite) return base;
  const cortado = base.slice(0, limite);
  const ultimoEspaco = cortado.lastIndexOf(" ");
  return (ultimoEspaco > limite * 0.6 ? cortado.slice(0, ultimoEspaco) : cortado).trim();
}

// ────────────────────────────────────────────────────────────────────
// PAYLOAD DE TRANSPORTE (2026-08-29)
//
// O único lugar do sistema onde uma URL assinada entra num corpo de
// requisição. A conversão acontece no ÚLTIMO instante, imediatamente
// antes da chamada externa, e o resultado não é persistido, hasheado
// nem logado em ponto nenhum.
// ────────────────────────────────────────────────────────────────────

/** O que de fato vai no corpo de `POST /items/validate`. */
export type PayloadTransporteML =
  Omit<PayloadPublicacaoML, "pictures"> & { pictures: ({ source: string } | { id: string })[] };

/**
 * CAMINHO PRINCIPAL (2026-08-30): `pictures: [{ id }]` com os picture
 * ids do CDN do Mercado Livre.
 *
 * A diferença para o caminho `source` não é de estilo. O picture id é
 * **estável para a conta**, então o payload que foi validado e o payload
 * que um futuro `POST /items` enviaria são o MESMO objeto — não há nada
 * efêmero no meio que possa ter mudado entre validar e publicar. É
 * também o que a documentação oficial recomenda.
 *
 * Imagem sem `ml_picture_id` é DESCARTADA, nunca substituída por outra:
 * publicar uma capa diferente da validada é pior do que enviar uma
 * imagem a menos. A ordem é preservada — a primeira é a capa.
 */
export function montarPayloadTransportePorId(payload: PayloadPublicacaoML): PayloadTransporteML {
  const pictures = payload.pictures
    .map(i => i.ml_picture_id)
    .filter((id): id is string => typeof id === "string" && id !== "")
    .map(id => ({ id }));
  return { ...payload, pictures };
}

/**
 * Troca a identidade estável pela credencial de download.
 *
 * **Isto não afrouxa "validar A e publicar A".** O que define A é o
 * conteúdo semântico mais o `checksum` dos bytes — e o checksum é
 * conferido em `gerarUrlsTransporteML()` antes de a URL ser criada. A
 * URL é só o meio pelo qual o Mercado Livre alcança o mesmo objeto.
 *
 * A ordem é preservada: a primeira `source` é a capa do anúncio, e ela
 * corresponde à primeira `pictures` canônica — a imagem principal.
 *
 * Imagem sem URL correspondente é DESCARTADA, nunca substituída por
 * outra: publicar uma capa diferente da que foi validada seria pior do
 * que enviar uma imagem a menos, e o número enviado é reportado.
 */
export function montarPayloadTransporteML(
  payload: PayloadPublicacaoML,
  urlPorImagem: Map<string, string>
): PayloadTransporteML {
  const pictures = payload.pictures
    .map(i => urlPorImagem.get(i.imagem_gerada_id))
    .filter((url): url is string => typeof url === "string" && url !== "")
    .map(source => ({ source }));
  return { ...payload, pictures };
}
