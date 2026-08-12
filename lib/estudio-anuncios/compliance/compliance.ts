/**
 * Montagem da entrada, hash e persistência do compliance (2026-08-23).
 *
 * SÓ LÊ. Nenhuma função deste arquivo escreve em `resultados_pipeline`,
 * `jobs`, Pipeline, score, imagens, `conteudo_versoes` ou pacotes — um
 * teste varre o código-fonte para garantir. A única escrita é a linha de
 * auditoria do próprio compliance, e ela é feita por RPC, INSERT puro.
 *
 * A FONTE DO CONTEÚDO É SEMPRE A VERSÃO APROVADA: a consulta filtra
 * `aprovado = true`, igual à exportação. Não existe caminho de código
 * capaz de validar uma versão não aprovada — nem por engano.
 *
 * DADOS QUE O ESTÚDIO NÃO TEM continuam `null` e viram bloqueio:
 * preço, estoque, condição, tipo de anúncio, categoria do marketplace,
 * GTIN e SKU. Nada é inferido, nada vem da IA, nada é "estimado".
 */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  EntradaCompliance,
  ImagemCompliance,
  MarketplaceCompliance,
  ResultadoCompliance,
} from "./tipos";
import { VALIDADORES, resultadoNaoImplementado } from "./registry";
import { calcularChecksumsDoProjeto } from "./imagens-ml";

export const SCHEMA_VERSAO_COMPLIANCE = 1;

// ────────────────────────────────────────────────────────────────────
// Hash da entrada — idempotência
// ────────────────────────────────────────────────────────────────────

/**
 * Resume TUDO que pode mudar o parecer: conteúdo aprovado, imagens,
 * categoria, atributos, preço, estoque, logística e a versão das regras.
 *
 * `versaoRegras` entra de propósito: uma versão aprovada hoje pode ser
 * bloqueada amanhã se a regra mudar, e nesse caso a validação anterior
 * **não** pode ser reaproveitada. Deliberadamente fora: qualquer
 * timestamp — senão toda revalidação criaria linha nova.
 */
export function calcularHashEntrada(entrada: EntradaCompliance, versaoRegras: number): string {
  const canonico = {
    marketplace: entrada.marketplace,
    versaoRegras,
    projetoId: entrada.projetoId,
    versaoAprovadaId: entrada.fonteEditorial?.versaoAprovadaId ?? null,
    numeroVersao: entrada.fonteEditorial?.numeroVersao ?? null,
    conteudo: entrada.conteudo
      ? {
          titulo: entrada.conteudo.titulo,
          descricao: entrada.conteudo.descricao,
          bullets: entrada.conteudo.bullets,
          especificacoes: [...entrada.conteudo.especificacoes]
            .map(e => ({ nome: e.nome, valor: e.valor }))
            .sort((a, b) => a.nome.localeCompare(b.nome)),
          cta: entrada.conteudo.cta ?? null,
        }
      : null,
    // Ordenado: a ordem de retorno do banco não é garantida e não pode
    // mudar o hash.
    // `checksum` entra porque é a identidade real do arquivo: trocar os
    // bytes mantendo o mesmo id TEM que invalidar o parecer. Nenhuma URL
    // assinada entra aqui — ela expira e faria o hash mudar sozinho.
    imagens: entrada.imagens
      .map(i => ({
        id: i.imagemGeradaId, mime: i.mimeType, largura: i.largura,
        altura: i.altura, bytes: i.tamanhoBytes, temArquivo: i.temArquivo,
        checksum: i.checksum ?? null,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    ficha: entrada.ficha,
    comercial: entrada.comercial,
    logistica: entrada.logistica,
    // Categoria e seu SNAPSHOT entram no hash: se o Mercado Livre mudar
    // os limites da categoria e o snapshot for renovado, o parecer
    // anterior deixa de valer — que é o comportamento correto.
    categoria: entrada.categoriaMarketplace
      ? {
          id: entrada.categoriaMarketplace.id,
          settings: entrada.categoriaMarketplace.settings,
          atributos: [...entrada.categoriaMarketplace.atributosObrigatorios]
            .map(a => ({ id: a.id, condicional: a.condicional }))
            .sort((a, b) => a.id.localeCompare(b.id)),
        }
      : null,
    // A conta muda o que e valido (tipos de anuncio), entao entra no hash.
    tiposAnuncioDaConta: entrada.tiposAnuncioDaConta ? [...entrada.tiposAnuncioDaConta].sort() : null,
    // Modelo e family_name mudam o payload, entao mudam o parecer.
    modeloPublicacao: entrada.modeloPublicacao,
    familyName: entrada.familyName,
    // Mudar qualquer medida da embalagem muda o parecer e o payload.
    embalagem: entrada.embalagem,
    atributosInformados: [...entrada.atributosInformados]
      .map(a => ({ id: a.id, valueId: a.valueId ?? null, valueName: a.valueName }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
  return createHash("sha256").update(JSON.stringify(canonico)).digest("hex");
}

// ────────────────────────────────────────────────────────────────────
// Montagem da entrada — leitura apenas
// ────────────────────────────────────────────────────────────────────

interface LinhaVersaoAprovada {
  id: string;
  projeto_marketplace_id: string;
  numero_versao: number;
  conteudo: any;
  aprovado_em: string | null;
}

export async function montarEntradaCompliance(
  supabase: SupabaseClient,
  params: { projetoId: string; nomeProduto: string; marketplace: MarketplaceCompliance },
  /**
   * Cliente de SERVIÇO, usado exclusivamente para ler os bytes das
   * imagens no Storage e calcular o checksum. Separado do `supabase`
   * comum de propósito: a checagem de dono já aconteceu antes, e o
   * service role entra só onde o anon não alcança.
   */
  supabaseServico?: SupabaseClient
): Promise<EntradaCompliance> {
  const { projetoId, nomeProduto, marketplace } = params;

  const { data: canalBruto, error: erroCanal } = await supabase
    .from("estudio_anuncios_projetos_marketplace")
    .select(
      "id, marketplace, category_id, categoria_nome, categoria_caminho, categoria_settings, " +
      "categoria_atributos, categoria_verificada_em, condicao, tipo_anuncio_id, moeda, " +
      "preco_centavos, estoque, atributos_marketplace, loja_id, tipos_anuncio_disponiveis, modelo_publicacao, family_name, " +
      "embalagem_peso_g, embalagem_altura_cm, embalagem_largura_cm, embalagem_comprimento_cm"
    )
    .eq("projeto_id", projetoId)
    .eq("marketplace", marketplace)
    .maybeSingle();
  if (erroCanal) throw new Error(`Falha ao ler canal do projeto: ${erroCanal.message}`);
  const canal = canalBruto as any | null;

  let fonteEditorial: EntradaCompliance["fonteEditorial"] = null;
  let conteudo: EntradaCompliance["conteudo"] = null;
  if (canal) {
    const { data: versaoBruta, error: erroV } = await supabase
      .from("estudio_anuncios_conteudo_versoes")
      .select("id, projeto_marketplace_id, numero_versao, conteudo, aprovado_em")
      .eq("projeto_marketplace_id", canal.id)
      .eq("aprovado", true)
      .maybeSingle();
    if (erroV) throw new Error(`Falha ao ler versão aprovada: ${erroV.message}`);
    const versao = versaoBruta as LinhaVersaoAprovada | null;
    if (versao) {
      fonteEditorial = {
        projetoMarketplaceId: canal.id,
        versaoAprovadaId: versao.id,
        numeroVersao: versao.numero_versao,
        aprovadoEm: versao.aprovado_em,
      };
      conteudo = {
        titulo: versao.conteudo?.titulo ?? "",
        descricao: versao.conteudo?.descricao ?? "",
        bullets: versao.conteudo?.bullets ?? [],
        especificacoes: versao.conteudo?.especificacoes ?? [],
        cta: versao.conteudo?.cta,
      };
    }
  }

  const { data: imgs, error: erroImg } = await supabase
    .from("estudio_anuncios_imagens_geradas")
    .select("id, prompt_ordem, finalidade, e_principal, mime_type, largura_px, altura_px, tamanho_bytes, storage_path")
    .eq("projeto_id", projetoId);
  if (erroImg) throw new Error(`Falha ao ler imagens: ${erroImg.message}`);

  const imagens: ImagemCompliance[] = ((imgs ?? []) as any[])
    .map(i => ({
      imagemGeradaId: i.id,
      finalidade: i.finalidade,
      principal: i.e_principal,
      ordem: i.prompt_ordem,
      mimeType: i.mime_type,
      largura: i.largura_px,
      altura: i.altura_px,
      tamanhoBytes: i.tamanho_bytes == null ? null : Number(i.tamanho_bytes),
      // Só a existência do caminho sai daqui — o caminho em si nunca.
      temArquivo: !!i.storage_path,
      // Preenchido logo abaixo, lendo os bytes com service role.
      checksum: null as string | null,
    }))
    .sort((a, b) => (a.principal === b.principal ? (a.ordem ?? 0) - (b.ordem ?? 0) : a.principal ? -1 : 1));

  // Checksum dos BYTES, não de metadado. É o que dá identidade estável à
  // imagem: se alguém trocar o arquivo mantendo o mesmo id, o parecer
  // fica desatualizado e a validação oficial cai junto — que é
  // exatamente o comportamento desejado. Lido com service role, sem
  // gerar URL nenhuma. Opcional de propósito: sem cliente de serviço, a
  // camada continua funcionando e o checksum fica `null`, visível.
  if (supabaseServico) {
    const checksums = await calcularChecksumsDoProjeto(
      supabaseServico, projetoId, imagens.map(i => i.imagemGeradaId)
    );
    for (const i of imagens) i.checksum = checksums.get(i.imagemGeradaId) ?? null;
  }

  const { data: fichaBruta, error: erroFicha } = await supabase
    .from("estudio_anuncios_entradas_produto")
    .select("marca, modelo, categoria, cor, material, peso, unidade_peso, medidas, quantidade")
    .eq("projeto_id", projetoId)
    .maybeSingle();
  if (erroFicha) throw new Error(`Falha ao ler ficha do produto: ${erroFicha.message}`);
  const f = fichaBruta as any | null;

  const ficha: EntradaCompliance["ficha"] = f
    ? {
        marca: f.marca ?? null,
        modelo: f.modelo ?? null,
        categoriaTexto: f.categoria ?? null,
        cor: f.cor ?? null,
        material: f.material ?? null,
        peso: f.peso == null ? null : Number(f.peso),
        unidadePeso: f.unidade_peso ?? null,
        medidas: f.medidas ?? null,
        // ATENÇÃO: `quantidade` é "unidades por embalagem" na ficha do
        // produto. NÃO é estoque, e nenhum validador pode tratá-la como
        // tal — usar isso como `available_quantity` seria inventar estoque.
        quantidadePorEmbalagem: f.quantidade ?? null,
      }
    : null;

  // Snapshot oficial da categoria (2026-08-24). Só existe se a categoria
  // já foi verificada contra a API pública do ML — o CHECK do banco
  // garante que id e snapshot andam juntos.
  const s = canal?.categoria_settings ?? null;
  const categoriaMarketplace: EntradaCompliance["categoriaMarketplace"] = canal?.category_id && s
    ? {
        id: canal.category_id,
        nome: canal.categoria_nome ?? canal.category_id,
        caminho: canal.categoria_caminho ?? canal.categoria_nome ?? canal.category_id,
        ehFolha: typeof s.ehFolha === "boolean" ? s.ehFolha : null,
        verificadaEm: canal.categoria_verificada_em ?? null,
        settings: {
          maxTitleLength: s.maxTitleLength ?? null,
          maxDescriptionLength: s.maxDescriptionLength ?? null,
          maxPicturesPerItem: s.maxPicturesPerItem ?? null,
          currencies: Array.isArray(s.currencies) ? s.currencies : [],
          itemConditions: Array.isArray(s.itemConditions) ? s.itemConditions : [],
          buyingModes: Array.isArray(s.buyingModes) ? s.buyingModes : [],
          listingAllowed: typeof s.listingAllowed === "boolean" ? s.listingAllowed : null,
          status: s.status ?? null,
        },
        atributosObrigatorios: Array.isArray(canal.categoria_atributos)
          ? canal.categoria_atributos.map((a: any) => ({
              id: String(a.id), nome: a.nome ?? String(a.id), condicional: a.condicional === true,
            }))
          : [],
      }
    : null;

  const atributosInformados = Array.isArray(canal?.atributos_marketplace)
    ? (canal.atributos_marketplace as any[])
        .filter(a => a && typeof a.id === "string" && typeof a.value_name === "string")
        .map(a => ({ id: a.id, valueId: a.value_id ?? null, valueName: a.value_name }))
    : [];

  return {
    projetoId,
    nomeProduto,
    marketplace,
    fonteEditorial,
    conteudo,
    imagens,
    ficha,
    categoriaMarketplace,
    // Tipos que a CONTA permite (2026-08-25). null enquanto nao houver
    // conta vinculada ou consulta autenticada — e ai o tipo so e
    // conferido contra a lista documentada.
    tiposAnuncioDaConta: Array.isArray(canal?.tipos_anuncio_disponiveis)
      ? (canal.tipos_anuncio_disponiveis as any[]).map(t => String(t?.id ?? t)).filter(Boolean)
      : null,
    modeloPublicacao: canal?.modelo_publicacao ?? null,
    familyName: canal?.family_name ?? null,
    // Embalagem de ENVIO — ja nas unidades do ML (cm e g). NUMERIC volta
    // como string do Postgres; Number() aqui e exato para 2 casas.
    embalagem: {
      pesoG: canal?.embalagem_peso_g == null ? null : Number(canal.embalagem_peso_g),
      alturaCm: canal?.embalagem_altura_cm == null ? null : Number(canal.embalagem_altura_cm),
      larguraCm: canal?.embalagem_largura_cm == null ? null : Number(canal.embalagem_largura_cm),
      comprimentoCm: canal?.embalagem_comprimento_cm == null ? null : Number(canal.embalagem_comprimento_cm),
    },
    atributosInformados,
    // Dados de publicação configurados por canal. O que não foi
    // preenchido continua null e vira bloqueio — nunca é inferido.
    // GTIN e SKU ainda não têm campo próprio: saem dos atributos
    // informados, que é onde o usuário os coloca.
    comercial: {
      categoriaMarketplaceId: canal?.category_id ?? null,
      precoCentavos: canal?.preco_centavos == null ? null : Number(canal.preco_centavos),
      moeda: canal?.moeda ?? null,
      estoque: canal?.estoque == null ? null : Number(canal.estoque),
      condicao: canal?.condicao ?? null,
      tipoAnuncio: canal?.tipo_anuncio_id ?? null,
      gtin: atributosInformados.find(a => a.id.toUpperCase() === "GTIN")?.valueName ?? null,
      sku: atributosInformados.find(a => a.id.toUpperCase() === "SELLER_SKU")?.valueName ?? null,
    },
    // Peso/medidas da ficha são declarações do usuário sobre o produto,
    // não dados logísticos de embalagem confirmados. Ficam separados de
    // propósito: nenhuma medida vem de foto nem de inferência da IA.
    logistica: {
      pesoGramas: null,
      comprimentoCm: null,
      larguraCm: null,
      alturaCm: null,
    },
  };
}

/** Roda o validador do canal — ou devolve `nao_implementado` honesto. */
export function validarCompliance(entrada: EntradaCompliance): ResultadoCompliance {
  const validador = VALIDADORES[entrada.marketplace];
  if (!validador) {
    return resultadoNaoImplementado(entrada.marketplace, calcularHashEntrada(entrada, 0));
  }
  return validador.validar(entrada, calcularHashEntrada(entrada, validador.versaoRegras));
}

// ────────────────────────────────────────────────────────────────────
// Persistência — imutável, sempre via RPC
// ────────────────────────────────────────────────────────────────────

interface LinhaCompliance {
  id: string;
  projeto_id: string;
  projeto_marketplace_id: string | null;
  versao_conteudo_id: string | null;
  marketplace: string;
  versao_regras: number;
  status: string;
  hash_entrada: string;
  resultado: unknown;
  criado_em: string;
  criado_por: string | null;
}

export interface ComplianceUI {
  id: string;
  marketplace: MarketplaceCompliance;
  status: ResultadoCompliance["status"];
  versaoRegras: number;
  hashEntrada: string;
  criadoEm: string;
  resultado: ResultadoCompliance;
  /**
   * `true` quando a versão aprovada do canal mudou DEPOIS desta validação.
   * O parecer é imutável e descreve o conteúdo de então; se a aprovação
   * mudou, ele não vale mais para o que está aprovado agora. Bloqueia o
   * portão de publicação — ver `podePublicarMarketplace`.
   */
  desatualizado: boolean;
}

const COLUNAS =
  "id, projeto_id, projeto_marketplace_id, versao_conteudo_id, marketplace, versao_regras, status, hash_entrada, resultado, criado_em, criado_por";

function paraUI(l: LinhaCompliance, desatualizado = false): ComplianceUI {
  return {
    id: l.id,
    marketplace: l.marketplace as MarketplaceCompliance,
    status: l.status as ResultadoCompliance["status"],
    versaoRegras: l.versao_regras,
    hashEntrada: l.hash_entrada,
    criadoEm: l.criado_em,
    resultado: l.resultado as ResultadoCompliance,
    desatualizado,
  };
}

/**
 * Grava (ou reencontra) a validação. Idempotência por
 * `(projeto_id, marketplace, hash_entrada)`: mesma entrada + mesma versão
 * de regras devolve a linha existente; qualquer mudança gera linha nova.
 * Registro IMUTÁVEL — a RPC nunca faz UPDATE.
 */
export async function registrarCompliance(
  supabaseServico: SupabaseClient,
  params: { projetoId: string; resultado: ResultadoCompliance; criadoPor: string }
): Promise<{ registro: ComplianceUI; reaproveitado: boolean }> {
  const { resultado } = params;
  const { data, error } = await supabaseServico.rpc("estudio_anuncios_registrar_compliance", {
    p_projeto_id: params.projetoId,
    p_projeto_marketplace_id: resultado.fonteEditorial?.projetoMarketplaceId ?? null,
    p_versao_conteudo_id: resultado.fonteEditorial?.versaoAprovadaId ?? null,
    p_marketplace: resultado.marketplace,
    p_versao_regras: resultado.versaoRegras,
    p_status: resultado.status,
    p_hash_entrada: resultado.hashEntrada,
    p_resultado: resultado,
    p_criado_por: params.criadoPor,
  });
  if (error) throw new Error(`Falha ao registrar compliance: ${error.message}`);
  const registro = paraUI(data as LinhaCompliance);
  // Se a linha devolvida não é a que acabamos de montar, a RPC reencontrou
  // uma anterior com a mesma entrada — a validação foi idempotente.
  const reaproveitado = registro.resultado?.validadoEm !== resultado.validadoEm;
  return { registro, reaproveitado };
}

/**
 * Compliance CORRENTE de cada canal do projeto.
 *
 * DUAS COISAS QUE PARECEM DETALHE E NÃO SÃO:
 *
 * 1. **Corrente ≠ mais recente.** A validação é idempotente por hash,
 *    então revalidar depois de desfazer uma mudança REENCONTRA um parecer
 *    antigo, que passa a ser o correto sem ser o último criado.
 *
 * 2. **A comparação é pelo HASH DA ENTRADA, não pela versão aprovada.**
 *    A primeira tentativa comparava `versao_conteudo_id` com a versão
 *    aprovada agora — e isso não enxergava mudança de preço, estoque,
 *    categoria, condição ou tipo de anúncio, deixando um parecer velho
 *    passar por atual (achado na validação real de 2026-08-24). O hash
 *    cobre TODAS as entradas, inclusive a versão das regras, então é a
 *    única comparação que não deixa buraco.
 *
 * Custo: reconstruir a entrada dos canais que têm parecer. Só desses —
 * projeto sem validação nenhuma não paga nada.
 */
export async function buscarComplianceDoProjeto(
  supabase: SupabaseClient,
  projetoId: string,
  nomeProduto: string,
  /**
   * OBRIGATÓRIO na prática, opcional na assinatura só para não quebrar
   * chamador antigo. Desde 2026-08-29 o hash da entrada inclui o
   * CHECKSUM das imagens, que só é legível com service role — e a
   * comparação de staleness precisa montar a entrada EXATAMENTE como
   * quem gravou o parecer montou. Sem este cliente, o hash sai sempre
   * diferente e todo parecer parece desatualizado. (Defeito estrutural
   * encontrado na validação real de 2026-08-29: os dois lados da
   * comparação precisam enxergar os mesmos dados.)
   */
  supabaseServico?: SupabaseClient
): Promise<ComplianceUI[]> {
  const { data, error } = await supabase
    .from("estudio_anuncios_compliance_marketplace")
    .select(COLUNAS)
    .eq("projeto_id", projetoId)
    .order("criado_em", { ascending: false });
  if (error) throw new Error(`Falha ao ler compliance: ${error.message}`);

  const linhas = (data ?? []) as unknown as LinhaCompliance[];
  if (linhas.length === 0) return [];

  const porCanal = new Map<string, LinhaCompliance[]>();
  for (const linha of linhas) {
    const lista = porCanal.get(linha.marketplace);
    if (lista) lista.push(linha);
    else porCanal.set(linha.marketplace, [linha]);
  }

  const correntes: ComplianceUI[] = [];
  for (const [marketplace, doCanal] of porCanal) {
    // `nao_implementado` não valida conteúdo nem dados de publicação:
    // não envelhece por mudança neles, só quando ganhar validador.
    const comValidador = doCanal.filter(l => l.status !== "nao_implementado");
    if (comValidador.length === 0) {
      correntes.push(paraUI(doCanal[0], false));
      continue;
    }

    const entrada = await montarEntradaCompliance(
      supabase,
      { projetoId, nomeProduto, marketplace: marketplace as MarketplaceCompliance },
      supabaseServico
    );
    const validador = VALIDADORES[marketplace as MarketplaceCompliance];
    const hashAtual = calcularHashEntrada(entrada, validador?.versaoRegras ?? 0);

    const casa = comValidador.find(l => l.hash_entrada === hashAtual);
    correntes.push(casa ? paraUI(casa, false) : paraUI(comValidador[0], true));
  }
  return correntes;
}
