/**
 * Camada de PRÉ-PUBLICAÇÃO — contrato de domínio (2026-08-23).
 *
 * O PRINCÍPIO QUE SEPARA ESTA CAMADA DA EDITORIAL:
 *
 *   camada editorial  → "este é o conteúdo que o usuário aprovou"
 *   camada compliance → "este conteúdo atende aos requisitos técnicos
 *                        verificáveis do marketplace?"
 *
 * As duas respostas são independentes. Conteúdo aprovado NÃO significa
 * conteúdo publicável, e nada aqui altera, aprova ou reprova conteúdo —
 * esta camada só LÊ e emite um parecer.
 *
 * O contrato é de DOMÍNIO, não da API de nenhum marketplace: `status`,
 * `bloqueios` e `alertas` têm o mesmo significado para todo canal, e o
 * `payload` específico de cada API fica isolado dentro do validador.
 *
 * ZERO IA. Todas as regras são determinísticas. Nenhuma chamada de
 * provedor, nenhum token gasto — um teste varre o código para garantir.
 */

/** Marketplaces como o banco os guarda (`projetos_marketplace.marketplace`). */
export const MARKETPLACES_COMPLIANCE = ["ML", "Shopee", "Amazon", "TikTok Shop"] as const;
export type MarketplaceCompliance = (typeof MARKETPLACES_COMPLIANCE)[number];

/**
 * Slug usado na URL (`/compliance/mercado-livre`). Separado do valor do
 * banco de propósito: "TikTok Shop" tem espaço e não pode ir cru na rota,
 * e o valor persistido não deve depender de formato de URL.
 */
export const SLUG_POR_MARKETPLACE: Record<MarketplaceCompliance, string> = {
  ML: "mercado-livre",
  Shopee: "shopee",
  Amazon: "amazon",
  "TikTok Shop": "tiktok-shop",
};

export function resolverMarketplacePorSlug(slug: string): MarketplaceCompliance | null {
  const alvo = slug.trim().toLowerCase();
  const achado = (Object.keys(SLUG_POR_MARKETPLACE) as MarketplaceCompliance[]).find(
    m => SLUG_POR_MARKETPLACE[m] === alvo
  );
  return achado ?? null;
}

/**
 * `aprovado`             — nenhum bloqueio segundo as regras IMPLEMENTADAS.
 * `aprovado_com_alertas` — tecnicamente publicável, com ponto que merece
 *                          atenção humana.
 * `bloqueado`            — existe requisito objetivo que impede criar o anúncio.
 * `nao_implementado`     — não existe validador para este canal.
 *
 * `aprovado` NUNCA significa "o marketplace vai aceitar": significa
 * "nenhuma regra que sabemos verificar foi violada". A validação final é
 * sempre do marketplace.
 */
export type StatusCompliance = "aprovado" | "aprovado_com_alertas" | "bloqueado" | "nao_implementado";

/** Quem consegue resolver o item — orienta a UI, não muda a severidade. */
export type ResponsavelPendencia = "usuario" | "sistema" | "marketplace";

export interface ItemCompliance {
  /** Estável e versionado — a UI e os testes se apoiam nele, nunca na mensagem. */
  codigo: string;
  /** Campo do payload afetado; `null` quando a regra é do projeto, não do payload. */
  campo: string | null;
  mensagem: string;
  regraVersao: number;
  responsavel: ResponsavelPendencia;
}

/**
 * Resultado de UMA verificação — é o que a UI mostra como checklist.
 *
 * `nao_verificavel` existe porque muita regra do Mercado Livre é
 * **definida por categoria** (`max_title_length`, `max_pictures_per_item`,
 * atributos obrigatórios). Sem `category_id` resolvido, essas regras não
 * podem ser avaliadas — e dizer "ok" nesse caso seria fingir validação.
 */
export type ResultadoVerificacao = "ok" | "bloqueio" | "alerta" | "nao_verificavel";

export interface Verificacao {
  codigo: string;
  rotulo: string;
  resultado: ResultadoVerificacao;
  detalhe?: string;
}

/** De onde veio o conteúdo validado — sempre a versão APROVADA. */
export interface FonteEditorial {
  projetoMarketplaceId: string;
  versaoAprovadaId: string;
  numeroVersao: number;
  aprovadoEm: string | null;
}

export interface ImagemCompliance {
  imagemGeradaId: string;
  finalidade: string;
  principal: boolean;
  ordem: number | null;
  mimeType: string | null;
  largura: number | null;
  altura: number | null;
  tamanhoBytes: number | null;
  /** Só a existência do objeto — o caminho nunca sai desta camada. */
  temArquivo: boolean;
  /**
   * sha256 dos BYTES reais do objeto (2026-08-29). É a identidade
   * estável da imagem: entra no hash, é persistida no parecer e é
   * conferida de novo antes de enviar. `null` = não foi possível ler o
   * objeto — estado visível, nunca silencioso.
   */
  checksum: string | null;
}

export interface ResultadoCompliance {
  marketplace: MarketplaceCompliance;
  status: StatusCompliance;
  /** Preenchido só em `nao_implementado` — nunca deixa o motivo implícito. */
  motivoNaoImplementado?: string;
  versaoRegras: number;
  bloqueios: ItemCompliance[];
  alertas: ItemCompliance[];
  verificacoes: Verificacao[];
  fonteEditorial: FonteEditorial | null;
  imagens: ImagemCompliance[];
  /**
   * Payload de pré-publicação. Existe mesmo com bloqueios (com `null` nos
   * campos ausentes) porque é ele que a integração futura vai consumir —
   * assim compliance valida A e a publicação envia exatamente A.
   * `payloadCompleto` diz se todos os campos obrigatórios estão presentes.
   */
  payload: Record<string, unknown> | null;
  payloadCompleto: boolean;
  hashEntrada: string;
  validadoEm: string;
}

/** O que o validador recebe. Montado 100% pelo servidor, só de leitura. */
export interface EntradaCompliance {
  projetoId: string;
  nomeProduto: string;
  marketplace: MarketplaceCompliance;
  fonteEditorial: FonteEditorial | null;
  conteudo: {
    titulo: string;
    descricao: string;
    bullets: string[];
    especificacoes: { nome: string; valor: string }[];
    cta?: string;
  } | null;
  imagens: ImagemCompliance[];
  /** Ficha do produto (`entradas_produto`) — pode não existir. */
  ficha: {
    marca: string | null;
    modelo: string | null;
    categoriaTexto: string | null;
    cor: string | null;
    material: string | null;
    peso: number | null;
    unidadePeso: string | null;
    medidas: Record<string, unknown> | null;
    /** Unidades por embalagem — **não é estoque**. Ver comentário em compliance.ts. */
    quantidadePorEmbalagem: number | null;
  } | null;
  /**
   * Dados comerciais de publicação, vindos de
   * `projetos_marketplace` (2026-08-24). Nunca inferidos, nunca da IA:
   * são digitados por uma pessoa e validados no servidor. O que não foi
   * configurado continua `null` e vira bloqueio.
   */
  comercial: {
    categoriaMarketplaceId: string | null;
    precoCentavos: number | null;
    moeda: string | null;
    estoque: number | null;
    condicao: string | null;
    tipoAnuncio: string | null;
    gtin: string | null;
    sku: string | null;
  };

  /**
   * Snapshot OFICIAL da categoria, gravado quando ela foi verificada
   * contra a API pública do Mercado Livre. É o que torna verificáveis os
   * limites que são por categoria — sem ele, o validador continua
   * respondendo `nao_verificavel` em vez de fingir aprovação.
   */
  categoriaMarketplace: {
    id: string;
    nome: string;
    caminho: string;
    ehFolha: boolean | null;
    verificadaEm: string | null;
    settings: {
      maxTitleLength: number | null;
      maxDescriptionLength: number | null;
      maxPicturesPerItem: number | null;
      currencies: string[];
      itemConditions: string[];
      buyingModes: string[];
      listingAllowed: boolean | null;
      status: string | null;
    };
    /** Atributos exigidos pela categoria, como o ML os declara. */
    atributosObrigatorios: { id: string; nome: string; condicional: boolean }[];
  } | null;

  /**
   * Tipos de anúncio que a CONTA vinculada permite, obtidos com OAuth
   * (2026-08-25). `null` enquanto nenhuma conta foi vinculada ou a
   * consulta não foi feita — e aí o tipo só é conferido contra a lista
   * documentada.
   */
  tiposAnuncioDaConta: string[] | null;

  /**
   * Modelo de publicação da CONTA, resolvido em `GET /users/{seller_id}`
   * (2026-08-26). `null` = ainda não resolvido — e aí não dá para saber
   * qual formato de payload é o certo.
   */
  modeloPublicacao: "user_products" | "legacy" | null;

  /**
   * Nome da FAMÍLIA no modelo User Products. Não é o título do anúncio:
   * no modelo novo o título é montado pelo Mercado Livre.
   */
  familyName: string | null;

  /**
   * Dados da EMBALAGEM DE ENVIO (2026-08-27), nas unidades do Mercado
   * Livre: dimensoes em cm, peso em g. NAO sao os dados do produto —
   * nada no sistema os deriva de `ficha.peso` ou `ficha.medidas`.
   */
  embalagem: {
    pesoG: number | null;
    alturaCm: number | null;
    larguraCm: number | null;
    comprimentoCm: number | null;
  };

  /** Atributos preenchidos pelo usuário para este canal (`{id, value_name}`). */
  atributosInformados: { id: string; valueId?: string | null; valueName: string }[];
  /** Logística real. Medida de foto ou inferência de IA NUNCA entra aqui. */
  logistica: {
    pesoGramas: number | null;
    comprimentoCm: number | null;
    larguraCm: number | null;
    alturaCm: number | null;
  };
}

/** Contrato que todo canal implementa — evita `switch` espalhado. */
export interface ValidadorMarketplace {
  marketplace: MarketplaceCompliance;
  versaoRegras: number;
  validar(entrada: EntradaCompliance, hashEntrada: string): ResultadoCompliance;
}

/**
 * Origem auditável de cada regra. Responde "de onde veio essa regra?"
 * sem depender de memória: vive versionado no código e é espelhado em
 * `docs/MARKETPLACE_COMPLIANCE.md`.
 */
export interface RegraCompliance {
  codigo: string;
  marketplace: MarketplaceCompliance;
  campo: string | null;
  regra: string;
  fonteOficial: string;
  verificadoEm: string;
  tipo: "bloqueio" | "alerta" | "nao_verificavel";
  responsavel: ResponsavelPendencia;
}

/** Deriva o status a partir dos itens — uma regra só, em um lugar só. */
export function derivarStatus(bloqueios: ItemCompliance[], alertas: ItemCompliance[]): StatusCompliance {
  if (bloqueios.length > 0) return "bloqueado";
  return alertas.length > 0 ? "aprovado_com_alertas" : "aprovado";
}
