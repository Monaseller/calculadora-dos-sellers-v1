/**
 * VALIDAÇÃO OFICIAL do Mercado Livre — orquestração e persistência
 * (2026-08-25).
 *
 * Fluxo, na ordem, sem atalho:
 *   conteúdo aprovado → compliance local → payload congelado
 *   → `POST /items/validate` → parecer oficial persistido
 *   → (futuro) publicação
 *
 * NENHUM ANÚNCIO É CRIADO. `/items/validate` é o validador oficial e não
 * cria item; não existe `POST /items` em nenhum arquivo deste módulo.
 *
 * DUAS AUTORIDADES, SEPARADAS DE PROPÓSITO: o compliance local diz o que
 * NÓS sabemos verificar; esta camada guarda o que o MERCADO LIVRE
 * respondeu. Quando algo é reprovado, dá para dizer quem reprovou.
 *
 * "Não conseguimos falar com o ML" NUNCA vira "validado": erro de
 * comunicação tem status próprio (`erro_comunicacao`) e não libera o
 * portão.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ErroML,
  carregarContaML,
  listarTiposAnuncioML,
  validarItemML,
  buscarModeloDaContaML,
  type ContaMLInterna,
  type ModeloPublicacaoML,
} from "./ml-conta";
import {
  montarPayloadPublicacaoMercadoLivre,
  montarPayloadTransportePorId,
  VERSAO_CONSTRUTOR_PAYLOAD_ML,
  type ArtefatoPublicacaoML,
} from "./payload-ml";
import { garantirPicturesML } from "./pictures-ml";
import { podePublicarMarketplace } from "./registry";
import {
  derivarStatusOficial,
  motivoNaoPublicavelML,
  podePublicarMercadoLivre,
  type ProblemaML,
  type StatusValidacaoOficial,
  type ValidacaoOficialUI,
} from "./portao-ml";
import type { ComplianceUI } from "./compliance";

const COLUNAS =
  "id, projeto_id, projeto_marketplace_id, loja_id, marketplace, compliance_id, versao_conteudo_id, " +
  "versao_construtor, hash_payload, payload, status, http_status, erros, alertas, criado_em";

function paraUI(l: any, desatualizada: boolean): ValidacaoOficialUI {
  return {
    id: l.id,
    marketplace: l.marketplace,
    status: l.status,
    httpStatus: l.http_status ?? null,
    hashPayload: l.hash_payload,
    versaoConstrutor: l.versao_construtor,
    erros: Array.isArray(l.erros) ? l.erros : [],
    alertas: Array.isArray(l.alertas) ? l.alertas : [],
    criadoEm: l.criado_em,
    lojaId: l.loja_id ?? null,
    desatualizada,
  };
}

export interface ResultadoExecucao {
  validacao: ValidacaoOficialUI;
  reaproveitada: boolean;
  /** Payload realmente submetido — o mesmo que a publicação usará. */
  artefato: ArtefatoPublicacaoML;
}

/**
 * Executa a validação oficial de um canal.
 *
 * Pré-condições checadas antes de gastar uma chamada de rede: compliance
 * corrente, não desatualizado e publicável localmente. Não faz sentido
 * perguntar ao Mercado Livre sobre um payload que nós mesmos sabemos
 * estar incompleto.
 */
export async function executarValidacaoOficial(
  supabase: SupabaseClient,
  supabaseServico: SupabaseClient,
  params: {
    projetoId: string;
    projetoMarketplaceId: string;
    marketplace: string;
    lojaId: string | null;
    userId: string;
    compliance: ComplianceUI | null;
  }
): Promise<ResultadoExecucao | { erro: string; codigo: "sem_loja" | "sem_compliance" | "compliance_bloqueado" | "conta_invalida" }> {
  const { compliance } = params;

  if (!params.lojaId) {
    return { erro: "Vincule uma conta do Mercado Livre antes de validar.", codigo: "sem_loja" };
  }
  if (!compliance) {
    return { erro: "Rode a validação de pré-publicação antes.", codigo: "sem_compliance" };
  }

  const conta = await carregarContaML(supabase, {
    lojaId: params.lojaId,
    userId: params.userId,
    marketplace: params.marketplace,
  });
  if (!conta) {
    return { erro: "A conta do Mercado Livre não está disponível ou não pertence a você.", codigo: "conta_invalida" };
  }

  // O MODELO vem ANTES das checagens de compliance, de propósito.
  //
  // Ele é uma pré-condição do próprio compliance — "falta resolver o
  // modelo" é um dos bloqueios dele. Resolver depois criaria um impasse:
  // o compliance bloqueia por falta de modelo, e o modelo nunca é
  // resolvido porque o compliance bloqueia. (Impasse real, encontrado na
  // validação de 2026-08-26.)
  //
  // Resolvido pela API da conta — nunca inferido do erro de
  // `/items/validate`, que só diria que algum campo faltou.
  let modelo: ModeloPublicacaoML;
  try {
    const info = await buscarModeloDaContaML(conta);
    modelo = info.modelo;
    const { error: erroModelo } = await supabaseServico.rpc("estudio_anuncios_salvar_modelo_publicacao", {
      p_projeto_marketplace_id: params.projetoMarketplaceId,
      p_modelo: info.modelo,
      p_tags: info.tags,
    });
    if (erroModelo) throw new Error(erroModelo.message);
  } catch (err) {
    if (!(err instanceof ErroML)) throw err;
    return {
      erro: `Não foi possível confirmar o modelo de publicação da conta: ${err.message}`,
      codigo: "conta_invalida",
    };
  }

  // Se o parecer foi feito sem conhecer o modelo (ou com outro), ele
  // descreve um payload de formato diferente. Pedir revalidação é
  // honesto; seguir seria validar um documento que o compliance nunca viu.
  const modeloNoParecer = (compliance.resultado.payload as any)?.modelo_publicacao ?? null;
  if (modeloNoParecer !== modelo) {
    return {
      erro: `O modelo de publicação da conta (${modelo}) foi resolvido agora. Rode a pré-publicação novamente para o parecer considerá-lo.`,
      codigo: "sem_compliance",
    };
  }

  if (compliance.desatualizado) {
    return { erro: "O parecer de pré-publicação está desatualizado. Valide novamente antes.", codigo: "sem_compliance" };
  }
  if (!podePublicarMarketplace(compliance.resultado, compliance.desatualizado)) {
    return { erro: "A pré-publicação ainda tem pendências. Resolva-as antes de validar no Mercado Livre.", codigo: "compliance_bloqueado" };
  }

  // O payload sai do parecer de compliance — nunca é remontado.
  const artefato = montarPayloadPublicacaoMercadoLivre({
    payloadCompliance: compliance.resultado.payload,
    lojaId: conta.lojaId,
    versaoAprovadaId: compliance.resultado.fonteEditorial?.versaoAprovadaId ?? null,
    modelo,
    familyName: (compliance.resultado.payload as any)?.family_name ?? null,
    // Embalagem também vem do parecer, explicitamente: as medidas que
    // foram validadas são as que vão ser enviadas, e não as que
    // estiverem no banco no instante da chamada.
    embalagem: (compliance.resultado.payload as any)?.embalagem ?? null,
  });

  if (!artefato.completo) {
    // Faltando campo do modelo real, não vale gastar a chamada: o ML
    // devolveria o mesmo que já sabemos.
    return {
      erro: `Faltam campos obrigatórios para o modelo ${modelo}: ${artefato.camposFaltando.join(", ")}.`,
      codigo: "compliance_bloqueado",
    };
  }

  // ── Imagens no CDN do Mercado Livre ───────────────────────────────
  // Sobe ao `/pictures/items/upload` só o que ainda não subiu com ESTES
  // bytes, e reaproveita o resto pelo mapa `(loja, imagem, checksum)`.
  // O `picture id` é estável para a conta — por isso ele entra no
  // payload canônico e no hash, ao contrário da URL assinada.
  const pics = await garantirPicturesML(supabaseServico, conta, {
    projetoId: params.projetoId,
    marketplace: params.marketplace,
    // O payload fala snake_case (é o formato do ML); a camada de imagens
    // fala camelCase. A tradução é explícita para a fronteira ficar
    // visível — e a ORDEM é preservada, porque a primeira é a capa.
    canonicas: artefato.payload.pictures.map(i => ({
      imagemGeradaId: i.imagem_gerada_id,
      checksum: i.checksum,
      ordem: i.ordem,
      principal: i.principal,
    })),
    criadoPor: params.userId,
  });

  if (pics.falhas.length > 0 || pics.resolvidas.length === 0) {
    // Enviar um subconjunto em silêncio seria validar um anúncio
    // diferente do que foi aprovado. Recusa e diz qual imagem falhou.
    const detalhe = pics.falhas.length > 0
      ? pics.falhas.map(f => f.motivo).join("; ")
      : "nenhuma imagem pôde ser preparada";
    return {
      erro: `${pics.falhas.length || "As"} imagem(ns) não puderam ser enviadas ao Mercado Livre: ${detalhe}.`,
      codigo: "compliance_bloqueado",
    };
  }

  // O artefato é REMONTADO com os picture ids — e é este, com os ids,
  // que vira o documento validado e persistido. Assim o payload que o
  // ML aprovou é exatamente o que uma publicação futura enviaria.
  const artefatoFinal = montarPayloadPublicacaoMercadoLivre({
    payloadCompliance: compliance.resultado.payload,
    lojaId: conta.lojaId,
    versaoAprovadaId: compliance.resultado.fonteEditorial?.versaoAprovadaId ?? null,
    modelo,
    familyName: (compliance.resultado.payload as any)?.family_name ?? null,
    embalagem: (compliance.resultado.payload as any)?.embalagem ?? null,
    picturesML: new Map(pics.resolvidas.map(r => [r.imagemGeradaId, r.mlPictureId])),
  });

  const payloadTransporte = montarPayloadTransportePorId(artefatoFinal.payload);
  if (payloadTransporte.pictures.length !== artefatoFinal.payload.pictures.length) {
    return {
      erro: "Alguma imagem ficou sem picture id do Mercado Livre. Tente validar de novo.",
      codigo: "compliance_bloqueado",
    };
  }

  let status: StatusValidacaoOficial;
  let httpStatus: number | null = null;
  let erros: ProblemaML[] = [];
  let alertas: ProblemaML[] = [];
  let respostaBruta: unknown = null;

  try {
    const r = await validarItemML(conta, payloadTransporte as unknown as Record<string, unknown>);
    httpStatus = r.httpStatus;
    erros = r.erros;
    alertas = r.alertas;
    respostaBruta = r.respostaBruta;
    status = derivarStatusOficial({
      aceito: r.aceito, erros: r.erros, alertas: r.alertas,
      envelopeValidacaoConhecido: r.envelopeValidacaoConhecido,
    });
  } catch (err) {
    if (!(err instanceof ErroML)) throw err;
    // Falha de conversa é registrada como tal — nunca como veredito.
    status = "erro_comunicacao";
    httpStatus = err.httpStatus;
    erros = [{ codigo: `comunicacao_${err.tipo}`, mensagem: err.message, campo: null, tipo: "communication" }];
    respostaBruta = err.corpo ?? null;
  }

  const { data, error } = await supabaseServico.rpc("estudio_anuncios_registrar_validacao_publicacao", {
    p_projeto_id: params.projetoId,
    p_projeto_marketplace_id: params.projetoMarketplaceId,
    p_loja_id: conta.lojaId,
    p_marketplace: params.marketplace,
    p_compliance_id: compliance.id,
    p_versao_conteudo_id: compliance.resultado.fonteEditorial?.versaoAprovadaId ?? null,
    p_versao_construtor: VERSAO_CONSTRUTOR_PAYLOAD_ML,
    p_hash_payload: artefatoFinal.hashPayload,
    p_payload: artefatoFinal.payload,
    p_status: status,
    p_http_status: httpStatus,
    p_erros: erros,
    p_alertas: alertas,
    p_resposta_ml: respostaBruta ?? null,
    p_criado_por: params.userId,
  });
  if (error) throw new Error(`Falha ao registrar a validação oficial: ${error.message}`);

  const linha = data as any;
  // Se a linha devolvida não é a que acabamos de montar, a RPC
  // reencontrou uma anterior com o mesmo payload.
  const reaproveitada = linha.status !== status || linha.criado_em == null
    ? false
    : new Date(linha.criado_em).getTime() < Date.now() - 2000;

  // `artefatoFinal` — o que foi de fato validado, com os picture ids.
  // Devolver o artefato SEM ids faria o portão comparar o hash errado.
  return { validacao: paraUI(linha, false), reaproveitada, artefato: artefatoFinal };
}

/**
 * Validação oficial CORRENTE de cada canal: a que descreve o payload de
 * agora. Se nenhuma descreve, a mais recente aparece marcada como
 * desatualizada — e desatualizada nunca publica.
 *
 * Mesmo princípio do compliance: corrente é a que **casa com o hash
 * atual**, não a mais recente por data.
 */
export async function buscarValidacoesDoProjeto(
  supabase: SupabaseClient,
  projetoId: string,
  hashAtualPorCanal: Map<string, string>
): Promise<ValidacaoOficialUI[]> {
  const { data, error } = await supabase
    .from("estudio_anuncios_validacoes_publicacao")
    .select(COLUNAS)
    .eq("projeto_id", projetoId)
    .order("criado_em", { ascending: false });
  if (error) throw new Error(`Falha ao ler validações oficiais: ${error.message}`);

  const porCanal = new Map<string, any[]>();
  for (const l of (data ?? []) as any[]) {
    const lista = porCanal.get(l.marketplace);
    if (lista) lista.push(l);
    else porCanal.set(l.marketplace, [l]);
  }

  const correntes: ValidacaoOficialUI[] = [];
  for (const [marketplace, linhas] of porCanal) {
    const hashAtual = hashAtualPorCanal.get(marketplace) ?? null;
    const casa = hashAtual ? linhas.find(l => l.hash_payload === hashAtual) : undefined;
    correntes.push(casa ? paraUI(casa, false) : paraUI(linhas[0], true));
  }
  return correntes;
}

/**
 * Resolve e grava o modelo de publicação da conta.
 *
 * Chamado ao VINCULAR a conta, não só na validação: o modelo é
 * pré-condição do compliance, e resolvê-lo cedo evita o impasse
 * "compliance bloqueia por falta de modelo / modelo só é resolvido na
 * validação, que o compliance bloqueia".
 */
export async function resolverModeloDaConta(
  supabase: SupabaseClient,
  supabaseServico: SupabaseClient,
  params: { projetoMarketplaceId: string; lojaId: string; userId: string; marketplace: string }
): Promise<{ modelo: ModeloPublicacaoML; tags: string[] } | { erro: string }> {
  const conta = await carregarContaML(supabase, {
    lojaId: params.lojaId,
    userId: params.userId,
    marketplace: params.marketplace,
  });
  if (!conta) return { erro: "Conta do Mercado Livre indisponível." };

  let info: { modelo: ModeloPublicacaoML; tags: string[] };
  try {
    info = await buscarModeloDaContaML(conta);
  } catch (err) {
    if (err instanceof ErroML) return { erro: err.message };
    throw err;
  }

  const { error } = await supabaseServico.rpc("estudio_anuncios_salvar_modelo_publicacao", {
    p_projeto_marketplace_id: params.projetoMarketplaceId,
    p_modelo: info.modelo,
    p_tags: info.tags,
  });
  if (error) throw new Error(`Falha ao salvar o modelo de publicação: ${error.message}`);
  return { modelo: info.modelo, tags: info.tags };
}

/**
 * Atualiza os tipos de anúncio que a CONTA permite. É o dado que só
 * existe com OAuth — antes desta etapa, `listing_type_id` só podia ser
 * conferido contra a lista documentada.
 */
export async function atualizarTiposAnuncioDaConta(
  supabase: SupabaseClient,
  supabaseServico: SupabaseClient,
  params: { projetoMarketplaceId: string; lojaId: string; userId: string; marketplace: string }
): Promise<{ tipos: { id: string; nome: string }[] } | { erro: string }> {
  const conta = await carregarContaML(supabase, {
    lojaId: params.lojaId,
    userId: params.userId,
    marketplace: params.marketplace,
  });
  if (!conta) return { erro: "Conta do Mercado Livre indisponível." };

  let tipos: { id: string; nome: string }[];
  try {
    tipos = await listarTiposAnuncioML(conta);
  } catch (err) {
    if (err instanceof ErroML) return { erro: err.message };
    throw err;
  }

  const { error } = await supabaseServico.rpc("estudio_anuncios_salvar_tipos_anuncio", {
    p_projeto_marketplace_id: params.projetoMarketplaceId,
    p_tipos: tipos,
  });
  if (error) throw new Error(`Falha ao salvar tipos de anúncio: ${error.message}`);
  return { tipos };
}

export { derivarStatusOficial, motivoNaoPublicavelML, podePublicarMercadoLivre };
export type { ContaMLInterna, ProblemaML, StatusValidacaoOficial, ValidacaoOficialUI };
