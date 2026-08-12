/**
 * Dados de PUBLICAÇÃO por canal — validação e persistência (2026-08-24).
 *
 * O QUE ESTA CAMADA GARANTE, e é o ponto inteiro dela: **preencher não é
 * o mesmo que preencher com valor válido.** Um `category_id` só é gravado
 * depois de existir de verdade na API do Mercado Livre; uma condição só é
 * aceita se estiver entre as que a categoria declara; um tipo de anúncio
 * só é aceito se estiver entre os documentados oficialmente. Nunca
 * "salvou, então o bloqueio some".
 *
 * NÃO PUBLICA NADA. As únicas chamadas externas são `GET` públicos de
 * catálogo (ver `ml-catalogo.ts`) — sem OAuth, sem token, sem `POST`.
 *
 * NÃO TOCA em conteúdo, imagens, Pipeline, score ou pareceres de
 * compliance. A escrita é uma só, na linha do canal, via RPC.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { TIPOS_ANUNCIO_DOCUMENTADOS_ML } from "./regras-mercado-livre";
import {
  atributosObrigatoriosML,
  buscarCategoriaML,
  derivarMoedaDaCategoria,
  ErroCatalogoML,
  type CategoriaML,
} from "./ml-catalogo";
import type { MarketplaceCompliance } from "./tipos";
import { sugerirFamilyName } from "./payload-ml";

/** Payload aceito pela rota — deliberadamente pequeno e fechado. */
export interface EntradaConfiguracaoPublicacao {
  categoryId?: string | null;
  condicao?: string;
  tipoAnuncioId?: string;
  precoCentavos?: number;
  estoque?: number;
  atributos?: { id: string; value_id?: string | null; value_name: string }[];
}

export interface ResultadoValidacaoConfig {
  valido: boolean;
  erro?: string;
  dados?: {
    categoryId: string | null;
    categoriaNome: string | null;
    categoriaCaminho: string | null;
    categoriaSettings: Record<string, unknown> | null;
    categoriaAtributos: { id: string; nome: string; condicional: boolean }[] | null;
    moeda: string | null;
    condicao: string | null;
    tipoAnuncioId: string | null;
    precoCentavos: number | null;
    estoque: number | null;
    atributos: { id: string; value_id?: string; value_name: string }[] | null;
    familyName: string | null;
    limparFamilyName: boolean;
    embalagemPesoG: number | null;
    embalagemAlturaCm: number | null;
    embalagemLarguraCm: number | null;
    embalagemComprimentoCm: number | null;
    limparEmbalagem: boolean;
    limparCategoria: boolean;
  };
}

const CHAVES_PERMITIDAS = new Set([
  "categoryId", "condicao", "tipoAnuncioId", "precoCentavos", "estoque", "atributos",
  // 2026-08-26 — modelo User Products.
  "familyName",
  // 2026-08-27 — dados logisticos da embalagem de envio.
  "embalagemPesoG", "embalagemAlturaCm", "embalagemLarguraCm", "embalagemComprimentoCm",
]);

/** Limites de sanidade — não são regra do ML, são proteção do servidor. */
const PRECO_CENTAVOS_MAX = 100_000_000_00; // R$ 100.000.000,00
const ESTOQUE_MAX = 10_000_000;
const MAX_ATRIBUTOS = 60;
const MAX_TAMANHO_VALOR_ATRIBUTO = 255;

/** true quando o payload trouxe ao menos uma medida da embalagem. */
function temEmbalagem(d: NonNullable<ResultadoValidacaoConfig["dados"]>): boolean {
  return d.embalagemPesoG != null || d.embalagemAlturaCm != null
    || d.embalagemLarguraCm != null || d.embalagemComprimentoCm != null;
}

function ehInteiro(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && Number.isFinite(v);
}

/**
 * Valida o payload e resolve a categoria contra a API oficial.
 *
 * Assíncrona de propósito: a verificação de `category_id` **precisa** de
 * uma consulta real. Validar por regex apenas aceitaria `MLB999999999`,
 * que tem o formato certo e não existe.
 */
export async function validarConfiguracaoPublicacao(
  corpo: unknown,
  marketplace: MarketplaceCompliance,
  /**
   * Settings da categoria JÁ SALVA no canal. Sem isto, uma condição
   * inválida passaria quando a categoria tivesse sido salva num request
   * anterior — o valor só seria pego depois, no compliance. Achado na
   * validação real de 2026-08-24.
   */
  settingsSalvos?: { itemConditions?: string[]; maxTitleLength?: number | null } | null,
  /**
   * Tipos de anuncio que a CONTA permite, obtidos com OAuth. Quando
   * existem, mandam sobre a lista documentada — a conta real permite
   * mais tipos do que os exemplos da documentacao mostram.
   */
  tiposDaConta?: string[] | null
): Promise<ResultadoValidacaoConfig> {
  if (marketplace !== "ML") {
    return { valido: false, erro: "Configuração de publicação disponível apenas para o Mercado Livre nesta versão." };
  }
  if (typeof corpo !== "object" || corpo === null || Array.isArray(corpo)) {
    return { valido: false, erro: "Corpo inválido." };
  }
  const body = corpo as Record<string, unknown>;

  for (const chave of Object.keys(body)) {
    if (!CHAVES_PERMITIDAS.has(chave)) {
      return { valido: false, erro: `Campo não permitido: ${chave}.` };
    }
  }
  if (Object.keys(body).length === 0) {
    return { valido: false, erro: "Nenhum campo enviado." };
  }

  const dados: NonNullable<ResultadoValidacaoConfig["dados"]> = {
    categoryId: null, categoriaNome: null, categoriaCaminho: null, categoriaSettings: null,
    categoriaAtributos: null, moeda: null, condicao: null, tipoAnuncioId: null,
    precoCentavos: null, estoque: null, atributos: null, familyName: null,
    limparFamilyName: false, limparCategoria: false,
    embalagemPesoG: null, embalagemAlturaCm: null, embalagemLarguraCm: null,
    embalagemComprimentoCm: null, limparEmbalagem: false,
  };

  // ── Categoria ───────────────────────────────────────────────────────
  let categoria: CategoriaML | null = null;
  if ("categoryId" in body) {
    const bruto = body.categoryId;
    if (bruto === null || bruto === "") {
      // Limpar é intenção explícita, não ausência de campo.
      dados.limparCategoria = true;
    } else if (typeof bruto !== "string") {
      return { valido: false, erro: "categoryId deve ser texto." };
    } else {
      try {
        categoria = await buscarCategoriaML(bruto);
      } catch (err) {
        if (err instanceof ErroCatalogoML) {
          // Nunca aceita a categoria "no escuro" quando a verificação falha.
          return { valido: false, erro: "Não foi possível verificar a categoria no Mercado Livre agora. Tente de novo." };
        }
        throw err;
      }
      if (!categoria) {
        return { valido: false, erro: "Categoria não encontrada no Mercado Livre. Selecione uma categoria real." };
      }
      dados.categoryId = categoria.id;
      dados.categoriaNome = categoria.nome;
      dados.categoriaCaminho = categoria.caminho;
      dados.categoriaSettings = { ...categoria.settings, ehFolha: categoria.ehFolha };
      dados.moeda = derivarMoedaDaCategoria(categoria.settings);
      // Atributos obrigatórios são melhor-esforço: se a consulta falhar,
      // a categoria ainda é válida e o compliance apenas não terá a lista.
      try {
        dados.categoriaAtributos = await atributosObrigatoriosML(categoria.id);
      } catch {
        dados.categoriaAtributos = [];
      }
    }
  }

  // ── Condição ────────────────────────────────────────────────────────
  if ("condicao" in body) {
    const c = body.condicao;
    if (typeof c !== "string" || c.trim() === "") {
      return { valido: false, erro: "condicao inválida." };
    }
    const valor = c.trim();
    // As condições válidas saem da categoria que vale AGORA: a que veio
    // no payload, ou a que já estava salva. Sem a segunda, "salvou =
    // aceito" abriria a porta para qualquer string.
    const aceitas = categoria
      ? categoria.settings.itemConditions
      : (settingsSalvos?.itemConditions ?? []);
    if (aceitas.length === 0) {
      return { valido: false, erro: "Escolha a categoria antes de definir a condição do produto." };
    }
    if (!aceitas.includes(valor)) {
      return {
        valido: false,
        erro: `Condição "${valor}" não é aceita por esta categoria. Aceitas: ${aceitas.join(", ")}.`,
      };
    }
    dados.condicao = valor;
  }

  // ── Tipo de anúncio ─────────────────────────────────────────────────
  // Com a CONTA vinculada, a lista real dela manda — e ela é maior que a
  // documentada (a conta de teste devolveu `gold_premium`, `gold` e
  // `free` além dos quatro dos exemplos, em 2026-08-25). Sem conta, resta
  // a lista documentada; em nenhum caso se aceita string arbitrária.
  if ("tipoAnuncioId" in body) {
    const t = body.tipoAnuncioId;
    const aceitos = tiposDaConta && tiposDaConta.length > 0
      ? tiposDaConta
      : [...TIPOS_ANUNCIO_DOCUMENTADOS_ML];
    if (typeof t !== "string" || !aceitos.includes(t.trim())) {
      return {
        valido: false,
        erro: tiposDaConta && tiposDaConta.length > 0
          ? `Tipo de anúncio inválido. Esta conta permite: ${aceitos.join(", ")}.`
          : `Tipo de anúncio inválido. Valores documentados: ${aceitos.join(", ")}.`,
      };
    }
    dados.tipoAnuncioId = t.trim();
  }

  // ── family_name (modelo User Products) ──────────────────────────────
  // O limite vem de `max_title_length` da categoria — nunca fixo aqui.
  // Literal da fonte: "The family_name that can be entered must be less
  // than or equal to the domain's max_title_length."
  if ("familyName" in body) {
    const f = body.familyName;
    if (f === null || f === "") {
      dados.limparFamilyName = true;
    } else if (typeof f !== "string") {
      return { valido: false, erro: "familyName deve ser texto." };
    } else {
      const valor = f.trim();
      if (valor === "") {
        return { valido: false, erro: "O nome da família não pode ser só espaços." };
      }
      const limite = settingsSalvos?.maxTitleLength ?? null;
      if (limite == null) {
        return { valido: false, erro: "Escolha a categoria antes de definir o nome da família — o limite vem dela." };
      }
      if (valor.length > limite) {
        // Nunca trunca em silêncio: recusa e diz o limite real.
        return { valido: false, erro: `O nome da família tem ${valor.length} caracteres e o limite desta categoria é ${limite}.` };
      }
      dados.familyName = valor;
    }
  }

  // ── Embalagem de ENVIO ──────────────────────────────────────────────
  // Unidades do Mercado Livre: dimensões em cm, peso em g. **Nunca**
  // derivadas do produto — quem informa é uma pessoa que sabe como o
  // item é embalado.
  //
  // INTEIRO, e sem arredondar. O validador oficial respondeu, em
  // 2026-08-27, `item.attribute.invalid.format.seller.package.dimensions`
  // — "Only integers are accepted for dimensions and weight". Reduzir
  // 13,5 para 13 aqui gravaria um número diferente do que a pessoa
  // digitou, sem ela saber; por isso o valor é RECUSADO e o erro diz por
  // quê. Não há `Math.round`, `Math.floor`, `Math.ceil` nem `parseInt`
  // em nenhum ponto deste caminho — há um teste que falha se aparecerem.
  const inteiroPositivo = (valor: unknown, campo: string): { erro: string } | { valor: number } => {
    // `Number.isInteger` já derruba NaN, Infinity, string, boolean,
    // objeto e array de uma vez — todos falham por não serem number.
    if (typeof valor !== "number" || !Number.isInteger(valor)) {
      return { erro: `${campo} deve ser um número inteiro — o Mercado Livre não aceita casas decimais aqui.` };
    }
    if (valor <= 0) return { erro: `${campo} deve ser maior que zero.` };
    if (valor > 100_000) return { erro: `${campo} acima do limite aceito.` };
    return { valor };
  };

  // Escrito campo a campo, sem índice dinâmico: cada medida tem um tipo
  // e um destino próprios, e o compilador confere os quatro.
  const lerMedida = (
    chave: "embalagemPesoG" | "embalagemAlturaCm" | "embalagemLarguraCm" | "embalagemComprimentoCm",
    rotuloCampo: string
  ): { erro: string } | { valor: number | null; presente: boolean } => {
    if (!(chave in body)) return { valor: null, presente: false };
    if (body[chave] === null) return { valor: null, presente: true };
    const r = inteiroPositivo(body[chave], rotuloCampo);
    if ("erro" in r) return { erro: r.erro };
    return { valor: r.valor, presente: true };
  };

  const peso = lerMedida("embalagemPesoG", "O peso da embalagem");
  if ("erro" in peso) return { valido: false, erro: peso.erro };
  const altura = lerMedida("embalagemAlturaCm", "A altura da embalagem");
  if ("erro" in altura) return { valido: false, erro: altura.erro };
  const largura = lerMedida("embalagemLarguraCm", "A largura da embalagem");
  if ("erro" in largura) return { valido: false, erro: largura.erro };
  const comprimento = lerMedida("embalagemComprimentoCm", "O comprimento da embalagem");
  if ("erro" in comprimento) return { valido: false, erro: comprimento.erro };

  const medidas = [peso, altura, largura, comprimento];
  const enviadas = medidas.filter(m => m.presente);
  if (enviadas.length > 0) {
    const limpando = enviadas.filter(m => m.valor === null).length;
    // Limpar é tudo ou nada. Meia embalagem — peso apagado, dimensões
    // gravadas — seria um registro que não descreve caixa nenhuma.
    if (limpando > 0 && limpando !== enviadas.length) {
      return { valido: false, erro: "Para limpar os dados da embalagem, envie os quatro campos como null." };
    }
    if (limpando > 0) {
      dados.limparEmbalagem = true;
    } else {
      dados.embalagemPesoG = peso.valor;
      dados.embalagemAlturaCm = altura.valor;
      dados.embalagemLarguraCm = largura.valor;
      dados.embalagemComprimentoCm = comprimento.valor;
    }
  }

  // ── Preço ───────────────────────────────────────────────────────────
  if ("precoCentavos" in body) {
    const p = body.precoCentavos;
    if (!ehInteiro(p)) {
      return { valido: false, erro: "precoCentavos deve ser inteiro (valor em centavos)." };
    }
    if (p <= 0) return { valido: false, erro: "O preço deve ser maior que zero." };
    if (p > PRECO_CENTAVOS_MAX) return { valido: false, erro: "Preço acima do limite aceito." };
    dados.precoCentavos = p;
  }

  // ── Estoque ─────────────────────────────────────────────────────────
  if ("estoque" in body) {
    const e = body.estoque;
    if (!ehInteiro(e)) return { valido: false, erro: "estoque deve ser inteiro." };
    if (e < 0) return { valido: false, erro: "O estoque não pode ser negativo." };
    if (e > ESTOQUE_MAX) return { valido: false, erro: "Estoque acima do limite aceito." };
    dados.estoque = e;
  }

  // ── Atributos ───────────────────────────────────────────────────────
  if ("atributos" in body) {
    const a = body.atributos;
    if (!Array.isArray(a)) return { valido: false, erro: "atributos deve ser uma lista." };
    if (a.length > MAX_ATRIBUTOS) return { valido: false, erro: "Atributos demais." };
    const limpos: { id: string; value_id?: string; value_name: string }[] = [];
    const vistos = new Set<string>();
    for (const item of a) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        return { valido: false, erro: "Cada atributo deve ser um objeto." };
      }
      const at = item as Record<string, unknown>;
      for (const k of Object.keys(at)) {
        if (!["id", "value_id", "value_name"].includes(k)) {
          return { valido: false, erro: `Campo não permitido em atributo: ${k}.` };
        }
      }
      if (typeof at.id !== "string" || at.id.trim() === "") {
        return { valido: false, erro: "Atributo sem id." };
      }
      if (typeof at.value_name !== "string" || at.value_name.trim() === "") {
        // Valor vazio nunca é gravado: seria "atributo preenchido" falso.
        return { valido: false, erro: `Atributo ${at.id} sem valor.` };
      }
      if (at.value_name.length > MAX_TAMANHO_VALOR_ATRIBUTO) {
        return { valido: false, erro: `Valor muito longo em ${at.id}.` };
      }
      if (at.value_id != null && typeof at.value_id !== "string") {
        return { valido: false, erro: `value_id inválido em ${at.id}.` };
      }
      const id = at.id.trim().toUpperCase();
      if (vistos.has(id)) return { valido: false, erro: `Atributo repetido: ${id}.` };
      vistos.add(id);
      limpos.push(
        at.value_id ? { id, value_id: at.value_id as string, value_name: at.value_name.trim() } : { id, value_name: at.value_name.trim() }
      );
    }
    dados.atributos = limpos;
  }

  return { valido: true, dados };
}

export interface CanalPublicacaoUI {
  marketplace: string;
  /** Conta vinculada. **Nunca** acompanha token. */
  lojaId: string | null;
  lojaVinculadaEm: string | null;
  /** Tipos que a CONTA permite; `null` enquanto não verificado com OAuth. */
  tiposAnuncioDisponiveis: { id: string; nome: string }[] | null;
  categoryId: string | null;
  categoriaNome: string | null;
  categoriaCaminho: string | null;
  categoriaVerificadaEm: string | null;
  /** Condições que a categoria aceita — a UI monta o seletor com isto. */
  condicoesAceitas: string[];
  condicao: string | null;
  tipoAnuncioId: string | null;
  moeda: string | null;
  /** Modelo resolvido da conta e nome da familia (User Products). */
  modeloPublicacao: "user_products" | "legacy" | null;
  familyName: string | null;
  /** Embalagem de ENVIO, nas unidades do ML (cm e g). */
  embalagemPesoG: number | null;
  embalagemAlturaCm: number | null;
  embalagemLarguraCm: number | null;
  embalagemComprimentoCm: number | null;
  /** SUGESTÃO a partir do título aprovado — nunca gravada sozinha. */
  sugestaoFamilyName: string | null;
  maxTitleLength: number | null;
  precoCentavos: number | null;
  estoque: number | null;
  atributos: { id: string; value_name: string }[];
  atributosObrigatorios: { id: string; nome: string; condicional: boolean }[];
  atualizadoEm: string | null;
}

function paraUI(l: any, tituloAprovado?: string | null): CanalPublicacaoUI {
  const s = l.categoria_settings ?? null;
  return {
    marketplace: l.marketplace,
    lojaId: l.loja_id ?? null,
    lojaVinculadaEm: l.loja_vinculada_em ?? null,
    tiposAnuncioDisponiveis: Array.isArray(l.tipos_anuncio_disponiveis) ? l.tipos_anuncio_disponiveis : null,
    categoryId: l.category_id ?? null,
    categoriaNome: l.categoria_nome ?? null,
    categoriaCaminho: l.categoria_caminho ?? null,
    categoriaVerificadaEm: l.categoria_verificada_em ?? null,
    condicoesAceitas: Array.isArray(s?.itemConditions) ? s.itemConditions : [],
    condicao: l.condicao ?? null,
    tipoAnuncioId: l.tipo_anuncio_id ?? null,
    moeda: l.moeda ?? null,
    modeloPublicacao: l.modelo_publicacao ?? null,
    familyName: l.family_name ?? null,
    embalagemPesoG: l.embalagem_peso_g == null ? null : Number(l.embalagem_peso_g),
    embalagemAlturaCm: l.embalagem_altura_cm == null ? null : Number(l.embalagem_altura_cm),
    embalagemLarguraCm: l.embalagem_largura_cm == null ? null : Number(l.embalagem_largura_cm),
    embalagemComprimentoCm: l.embalagem_comprimento_cm == null ? null : Number(l.embalagem_comprimento_cm),
    sugestaoFamilyName: l.family_name
      ? null
      : (sugerirFamilyName(tituloAprovado, typeof s?.maxTitleLength === "number" ? s.maxTitleLength : null) || null),
    maxTitleLength: typeof s?.maxTitleLength === "number" ? s.maxTitleLength : null,
    precoCentavos: l.preco_centavos == null ? null : Number(l.preco_centavos),
    estoque: l.estoque == null ? null : Number(l.estoque),
    atributos: Array.isArray(l.atributos_marketplace)
      ? l.atributos_marketplace.map((a: any) => ({ id: a.id, value_name: a.value_name }))
      : [],
    atributosObrigatorios: Array.isArray(l.categoria_atributos)
      ? l.categoria_atributos.map((a: any) => ({ id: a.id, nome: a.nome ?? a.id, condicional: a.condicional === true }))
      : [],
    atualizadoEm: l.publicacao_atualizada_em ?? null,
  };
}

const COLUNAS_PUBLICACAO =
  "marketplace, loja_id, loja_vinculada_em, tipos_anuncio_disponiveis, category_id, categoria_nome, categoria_caminho, categoria_settings, categoria_atributos, " +
  "categoria_verificada_em, condicao, tipo_anuncio_id, moeda, preco_centavos, estoque, modelo_publicacao, family_name, " +
  "embalagem_peso_g, embalagem_altura_cm, embalagem_largura_cm, embalagem_comprimento_cm, " +
  "atributos_marketplace, publicacao_atualizada_em";

/** Configuração de publicação de todos os canais do projeto. */
export async function buscarPublicacaoDoProjeto(
  supabase: SupabaseClient,
  projetoId: string,
  /** Títulos aprovados por canal — só alimentam a SUGESTÃO. */
  tituloAprovadoPorCanal?: Map<string, string | null>
): Promise<CanalPublicacaoUI[]> {
  const { data, error } = await supabase
    .from("estudio_anuncios_projetos_marketplace")
    .select(COLUNAS_PUBLICACAO)
    .eq("projeto_id", projetoId);
  if (error) throw new Error(`Falha ao ler configuração de publicação: ${error.message}`);
  return ((data ?? []) as any[]).map(l => paraUI(l, tituloAprovadoPorCanal?.get(l.marketplace) ?? null));
}

/** Persistência atômica — toda a lógica de PATCH parcial vive na RPC. */
export async function salvarConfiguracaoPublicacao(
  supabaseServico: SupabaseClient,
  params: {
    projetoId: string;
    marketplace: MarketplaceCompliance;
    dados: NonNullable<ResultadoValidacaoConfig["dados"]>;
    atualizadoPor: string;
  }
): Promise<CanalPublicacaoUI> {
  const { dados } = params;
  const { data, error } = await supabaseServico.rpc("estudio_anuncios_salvar_publicacao_marketplace", {
    p_projeto_id: params.projetoId,
    p_marketplace: params.marketplace,
    p_category_id: dados.categoryId,
    p_categoria_nome: dados.categoriaNome,
    p_categoria_caminho: dados.categoriaCaminho,
    p_categoria_settings: dados.categoriaSettings,
    p_categoria_atributos: dados.categoriaAtributos,
    p_moeda: dados.moeda,
    p_condicao: dados.condicao,
    p_tipo_anuncio_id: dados.tipoAnuncioId,
    p_preco_centavos: dados.precoCentavos,
    p_estoque: dados.estoque,
    p_atributos_marketplace: dados.atributos,
    p_limpar_categoria: dados.limparCategoria,
    p_atualizado_por: params.atualizadoPor,
  });
  if (error) throw new Error(`Falha ao salvar configuração de publicação: ${error.message}`);

  // `family_name` tem RPC própria: a de configuração já tem assinatura
  // fechada, e reescrevê-la exigiria DROP — operação destrutiva que não
  // se justifica para acrescentar um campo.
  if (dados.familyName != null || dados.limparFamilyName) {
    const { data: comFamilia, error: erroFamilia } = await supabaseServico.rpc(
      "estudio_anuncios_salvar_family_name",
      {
        p_projeto_id: params.projetoId,
        p_marketplace: params.marketplace,
        p_family_name: dados.limparFamilyName ? null : dados.familyName,
        p_atualizado_por: params.atualizadoPor,
      }
    );
    if (erroFamilia) throw new Error(`Falha ao salvar o nome da família: ${erroFamilia.message}`);
    if (!temEmbalagem(dados) && !dados.limparEmbalagem) return paraUI(comFamilia);
  }

  // Embalagem também tem RPC própria, pelo mesmo motivo: as RPCs
  // existentes têm assinatura fechada e reescrevê-las exigiria `DROP`.
  if (temEmbalagem(dados) || dados.limparEmbalagem) {
    const { data: comEmbalagem, error: erroEmbalagem } = await supabaseServico.rpc(
      "estudio_anuncios_salvar_embalagem",
      {
        p_projeto_id: params.projetoId,
        p_marketplace: params.marketplace,
        p_peso_g: dados.embalagemPesoG,
        p_altura_cm: dados.embalagemAlturaCm,
        p_largura_cm: dados.embalagemLarguraCm,
        p_comprimento_cm: dados.embalagemComprimentoCm,
        p_limpar: dados.limparEmbalagem,
        p_atualizado_por: params.atualizadoPor,
      }
    );
    if (erroEmbalagem) throw new Error(`Falha ao salvar os dados da embalagem: ${erroEmbalagem.message}`);
    return paraUI(comEmbalagem);
  }

  return paraUI(data);
}
