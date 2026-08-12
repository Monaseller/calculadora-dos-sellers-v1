/**
 * PUBLICAÇÃO REAL no Mercado Livre — `POST /items` (2026-08-31).
 *
 * É a única camada do módulo que cria um recurso público. Todo o resto
 * do Estúdio existe para que esta chamada seja segura.
 *
 * ── A REGRA QUE ORGANIZA O ARQUIVO ──────────────────────────────────
 * **Publica-se exatamente o que foi validado.** O payload não é
 * remontado a partir do estado atual do banco: ele é lido da linha de
 * `validacoes_publicacao` que o Mercado Livre aprovou, e o hash é
 * conferido contra o payload de agora. Se qualquer campo semântico
 * mudou, isto recusa e pede nova validação — em vez de publicar um
 * documento que ninguém validou.
 *
 * A única transformação permitida é de TRANSPORTE: as `pictures`
 * canônicas viram `[{ id }]` com os MESMOS `ml_picture_id` já usados na
 * validação. Nenhuma imagem sobe de novo, nenhuma URL assinada é gerada.
 *
 * ── DUAS FASES, E O MOTIVO ──────────────────────────────────────────
 *   1. RESERVA no banco (`em_andamento`), protegida por UNIQUE parcial.
 *   2. `POST /items`, uma vez.
 *   3. Conclusão da reserva com o desfecho.
 *
 * Reservar depois da chamada permitiria que dois cliques disparassem
 * dois POSTs antes de qualquer INSERT — e nasceriam dois anúncios.
 *
 * ── "NÃO SEI" É UM DESFECHO ─────────────────────────────────────────
 * Timeout ou 5xx depois do envio viram `publicacao_incerta`, nunca
 * `falha`. A diferença é a que impede o segundo anúncio: falha convida a
 * tentar de novo; incerto exige reconciliar primeiro.
 *
 * NÃO EDITA, NÃO PAUSA, NÃO FECHA, NÃO EXCLUI. Não existe `DELETE`,
 * `PUT /items` nem alteração de anúncio em lugar nenhum deste arquivo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ErroML,
  buscarItemML,
  carregarContaML,
  listarItensDaContaML,
  publicarItemML,
  type ContaMLInterna,
} from "./ml-conta";
import { montarPayloadTransportePorId, type PayloadPublicacaoML } from "./payload-ml";
import { podePublicarMercadoLivre, type ValidacaoOficialUI } from "./portao-ml";
import type { ComplianceUI } from "./compliance";

export type CodigoRecusaPublicacao =
  | "sem_loja"
  | "sem_validacao"
  | "portao_fechado"
  | "payload_divergente"
  | "ja_publicado"
  | "conta_invalida"
  | "sem_pictures";

export interface PublicacaoUI {
  id: string;
  status: "em_andamento" | "publicado" | "falha" | "publicacao_incerta";
  mlItemId: string | null;
  permalink: string | null;
  statusMl: string | null;
  hashPayload: string;
  criadoEm: string;
  concluidoEm: string | null;
  lojaId: string;
  /** Erros estruturados, quando recusado. Nunca contém credencial. */
  erro: unknown;
}

export interface ResultadoPublicacao {
  publicacao: PublicacaoUI;
  /** Item real consultado em `GET /items/{id}` logo após a criação. */
  itemReal: Record<string, any> | null;
  /** Divergências entre o payload validado e o item criado. */
  divergencias: { campo: string; enviado: unknown; noItem: unknown }[];
}

const COLUNAS =
  "id, status, ml_item_id, permalink, status_ml, hash_payload, criado_em, concluido_em, loja_id, erro";

function paraUI(l: any): PublicacaoUI {
  return {
    id: l.id,
    status: l.status,
    mlItemId: l.ml_item_id ?? null,
    permalink: l.permalink ?? null,
    statusMl: l.status_ml ?? null,
    hashPayload: l.hash_payload,
    criadoEm: l.criado_em,
    concluidoEm: l.concluido_em ?? null,
    lojaId: l.loja_id,
    erro: l.erro ?? null,
  };
}

/** Publicação viva de um canal — é ela que faz o botão sumir. */
export async function buscarPublicacaoDoCanal(
  supabase: SupabaseClient,
  projetoMarketplaceId: string
): Promise<PublicacaoUI | null> {
  const { data, error } = await supabase
    .from("estudio_anuncios_publicacoes")
    .select(COLUNAS)
    .eq("projeto_marketplace_id", projetoMarketplaceId)
    .in("status", ["em_andamento", "publicado", "publicacao_incerta"])
    .maybeSingle();
  if (error) throw new Error(`Falha ao ler a publicação do canal: ${error.message}`);
  return data ? paraUI(data) : null;
}

export async function buscarPublicacoesDoProjeto(
  supabase: SupabaseClient,
  projetoId: string
): Promise<(PublicacaoUI & { marketplace: string })[]> {
  const { data, error } = await supabase
    .from("estudio_anuncios_publicacoes")
    .select(`${COLUNAS}, marketplace`)
    .eq("projeto_id", projetoId)
    .in("status", ["em_andamento", "publicado", "publicacao_incerta"]);
  if (error) throw new Error(`Falha ao ler publicações: ${error.message}`);
  return ((data ?? []) as any[]).map(l => ({ ...paraUI(l), marketplace: l.marketplace }));
}

/**
 * Campos que precisam bater entre o que foi enviado e o item real.
 *
 * `title` não entra: em User Products quem monta o título é o Mercado
 * Livre, e exigir igualdade com o texto editorial compararia duas coisas
 * de semânticas diferentes.
 */
function compararComItemReal(
  enviado: PayloadPublicacaoML,
  item: Record<string, any>
): { campo: string; enviado: unknown; noItem: unknown }[] {
  const d: { campo: string; enviado: unknown; noItem: unknown }[] = [];
  const cmp = (campo: string, a: unknown, b: unknown) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) d.push({ campo, enviado: a, noItem: b });
  };
  cmp("category_id", enviado.category_id, item.category_id ?? null);
  cmp("price", enviado.price, item.price ?? null);
  cmp("available_quantity", enviado.available_quantity, item.available_quantity ?? null);
  cmp("condition", enviado.condition, item.condition ?? null);
  cmp("listing_type_id", enviado.listing_type_id, item.listing_type_id ?? null);
  cmp("currency_id", enviado.currency_id, item.currency_id ?? null);

  // Imagens: compara a QUANTIDADE e a presença dos picture ids. O ML
  // reprocessa a imagem e pode devolver um id derivado, então exigir
  // igualdade literal produziria falso positivo.
  const idsEnviados = enviado.pictures.map(p => p.ml_picture_id).filter(Boolean) as string[];
  const noItem: string[] = Array.isArray(item.pictures)
    ? item.pictures.map((p: any) => String(p?.id ?? "")).filter(Boolean)
    : [];
  if (idsEnviados.length !== noItem.length) {
    d.push({ campo: "pictures.length", enviado: idsEnviados.length, noItem: noItem.length });
  }
  const faltando = idsEnviados.filter(id => !noItem.some(n => n === id || n.includes(id) || id.includes(n)));
  if (faltando.length > 0) d.push({ campo: "pictures.ids", enviado: faltando, noItem });

  // Atributos: só os que ENVIAMOS precisam estar lá. O ML acrescenta
  // muitos por conta própria, e cobrar igualdade de conjunto seria
  // inventar uma regra que não existe.
  const attrsItem = new Map<string, string>(
    (Array.isArray(item.attributes) ? item.attributes : []).map((a: any) => [String(a?.id), String(a?.value_name ?? "")])
  );
  for (const a of enviado.attributes) {
    const v = attrsItem.get(a.id);
    if (v === undefined) d.push({ campo: `attributes.${a.id}`, enviado: a.value_name, noItem: null });
  }
  return d;
}

/**
 * Executa a primeira e única publicação de um canal.
 *
 * Nenhuma chamada externa acontece antes de TODAS as pré-condições
 * passarem e da reserva ser aceita pelo banco.
 */
export async function publicarNoMercadoLivre(
  supabase: SupabaseClient,
  supabaseServico: SupabaseClient,
  params: {
    projetoId: string;
    projetoMarketplaceId: string;
    marketplace: string;
    lojaId: string | null;
    userId: string;
    compliance: ComplianceUI | null;
    validacao: ValidacaoOficialUI | null;
    /** Hash do payload de AGORA — precisa bater com o validado. */
    hashPayloadAtual: string | null;
  }
): Promise<ResultadoPublicacao | { erro: string; codigo: CodigoRecusaPublicacao }> {
  const { compliance, validacao } = params;

  if (!params.lojaId) return { erro: "Vincule uma conta do Mercado Livre antes de publicar.", codigo: "sem_loja" };
  if (!validacao) return { erro: "Este anúncio ainda não passou pela validação oficial.", codigo: "sem_validacao" };

  // Já existe publicação viva? Recusa ANTES de tudo — inclusive antes de
  // carregar a conta.
  const jaExiste = await buscarPublicacaoDoCanal(supabaseServico, params.projetoMarketplaceId);
  if (jaExiste) {
    return {
      erro: jaExiste.status === "publicado"
        ? `Este anúncio já foi publicado (item ${jaExiste.mlItemId}).`
        : jaExiste.status === "publicacao_incerta"
          ? "Há uma publicação anterior em estado incerto. Reconcilie antes de tentar de novo."
          : "Há uma publicação em andamento para este canal.",
      codigo: "ja_publicado",
    };
  }

  // O PORTÃO, de novo, imediatamente antes de agir. Ele já foi conferido
  // na UI e na leitura do projeto; repetir aqui é o que garante que a
  // decisão vale para o instante da publicação, não para o do carregamento.
  if (!podePublicarMercadoLivre({
    compliance, validacao, lojaId: params.lojaId, hashPayloadAtual: params.hashPayloadAtual,
  })) {
    return { erro: "As condições para publicar não estão satisfeitas agora.", codigo: "portao_fechado" };
  }

  // O payload é o VALIDADO, lido da linha que o ML aprovou.
  const { data: linhaVal, error: erroVal } = await supabaseServico
    .from("estudio_anuncios_validacoes_publicacao")
    .select("id, payload, hash_payload, alertas, compliance_id, versao_conteudo_id, loja_id, status")
    .eq("id", validacao.id)
    .maybeSingle();
  if (erroVal) throw new Error(`Falha ao ler a validação oficial: ${erroVal.message}`);
  const val = linhaVal as any;
  if (!val?.payload) return { erro: "A validação oficial não guardou o payload.", codigo: "sem_validacao" };

  // Três conferências que o portão não faz, e que são baratas.
  if (val.hash_payload !== params.hashPayloadAtual) {
    return { erro: "Os dados mudaram depois da validação oficial. Valide de novo antes de publicar.", codigo: "payload_divergente" };
  }
  if (val.loja_id !== params.lojaId) {
    return { erro: "A validação oficial foi feita para outra conta do Mercado Livre.", codigo: "payload_divergente" };
  }

  const payloadValidado = val.payload as PayloadPublicacaoML;
  const transporte = montarPayloadTransportePorId(payloadValidado);
  if (transporte.pictures.length === 0 || transporte.pictures.length !== payloadValidado.pictures.length) {
    // Publicar com menos imagens do que foi validado seria publicar
    // outro anúncio.
    return { erro: "As imagens validadas não estão todas disponíveis. Valide de novo.", codigo: "sem_pictures" };
  }

  const conta = await carregarContaML(supabase, {
    lojaId: params.lojaId, userId: params.userId, marketplace: params.marketplace,
  });
  if (!conta) return { erro: "A conta do Mercado Livre não está disponível ou não pertence a você.", codigo: "conta_invalida" };

  // ── Fase 1: RESERVA ───────────────────────────────────────────────
  const { data: reserva, error: erroReserva } = await supabaseServico.rpc("estudio_anuncios_reservar_publicacao", {
    p_projeto_id: params.projetoId,
    p_projeto_marketplace_id: params.projetoMarketplaceId,
    p_loja_id: params.lojaId,
    p_marketplace: params.marketplace,
    p_validacao_id: val.id,
    p_compliance_id: val.compliance_id ?? null,
    p_versao_conteudo_id: val.versao_conteudo_id ?? null,
    p_hash_payload: val.hash_payload,
    p_payload: transporte,
    p_alertas: val.alertas ?? [],
    p_criado_por: params.userId,
  });
  if (erroReserva || !reserva) {
    const msg = erroReserva?.message ?? "";
    if (/ANUNCIO_JA_PUBLICADO|PUBLICACAO_EM_ANDAMENTO|PUBLICACAO_INCERTA/.test(msg)) {
      return { erro: "Já existe uma publicação para este canal.", codigo: "ja_publicado" };
    }
    throw new Error(`Falha ao reservar a publicação: ${msg}`);
  }
  const publicacaoId = (reserva as any).id as string;

  // Fotografia dos anúncios da conta ANTES de publicar. É o que permite
  // reconciliar sem reenviar, se a resposta vier ambígua.
  let itensAntes: string[] = [];
  try {
    itensAntes = await listarItensDaContaML(conta);
  } catch {
    // Não impede publicar: só torna a reconciliação menos precisa.
  }

  // ── Fase 2: a chamada. UMA vez, sem retry. ────────────────────────
  const r = await publicarItemML(conta, transporte as unknown as Record<string, unknown>);

  // ── Fase 3: fechar a reserva com o que de fato aconteceu ──────────
  const concluir = async (
    status: "publicado" | "falha" | "publicacao_incerta",
    campos: { itemId?: string | null; permalink?: string | null; statusMl?: string | null; resposta?: unknown; erro?: unknown }
  ) => {
    const { data, error } = await supabaseServico.rpc("estudio_anuncios_concluir_publicacao", {
      p_publicacao_id: publicacaoId,
      p_status: status,
      p_ml_item_id: campos.itemId ?? null,
      p_permalink: campos.permalink ?? null,
      p_status_ml: campos.statusMl ?? null,
      p_resposta: campos.resposta ?? null,
      p_erro: campos.erro ?? null,
    });
    if (error || !data) throw new Error(`Falha ao concluir a publicação: ${error?.message ?? "sem retorno"}`);
    return paraUI(data);
  };

  if (r.desfecho === "recusado") {
    // 4xx estruturado: nada foi criado. A reserva vira `falha`, o que
    // libera o canal para uma nova tentativa depois da correção.
    const publicacao = await concluir("falha", {
      resposta: r.respostaBruta, erro: { httpStatus: r.httpStatus, erros: r.erros, alertas: r.alertas },
    });
    return { publicacao, itemReal: null, divergencias: [] };
  }

  if (r.desfecho === "incerto") {
    // NÃO REENVIAR. Investiga comparando a lista de anúncios da conta.
    let encontrado: string | null = null;
    try {
      const depois = await listarItensDaContaML(conta);
      const novos = depois.filter(id => !itensAntes.includes(id));
      if (novos.length === 1) encontrado = novos[0];
    } catch {
      // Reconciliação também falhou: o estado segue incerto, que é a
      // afirmação verdadeira.
    }

    if (encontrado) {
      const item = await buscarItemML(conta, encontrado).catch(() => null);
      const publicacao = await concluir("publicado", {
        itemId: encontrado,
        permalink: typeof item?.permalink === "string" ? item.permalink : null,
        statusMl: typeof item?.status === "string" ? item.status : null,
        resposta: item ?? r.respostaBruta,
        erro: { reconciliado: true, motivoOriginal: r.motivo },
      });
      return { publicacao, itemReal: item, divergencias: item ? compararComItemReal(payloadValidado, item) : [] };
    }

    const publicacao = await concluir("publicacao_incerta", {
      resposta: r.respostaBruta,
      erro: { httpStatus: r.httpStatus, motivo: r.motivo, reconciliacao: "não foi possível determinar se o item foi criado" },
    });
    return { publicacao, itemReal: null, divergencias: [] };
  }

  // ── Criado ────────────────────────────────────────────────────────
  const itemId = String(r.item.id);
  // Consulta oficial do item real: a resposta do POST não é
  // necessariamente o estado final.
  let itemReal: Record<string, any> | null = null;
  try {
    itemReal = await buscarItemML(conta, itemId);
  } catch (err) {
    if (!(err instanceof ErroML)) throw err;
  }
  const fonte = itemReal ?? r.item;

  const publicacao = await concluir("publicado", {
    itemId,
    permalink: typeof fonte.permalink === "string" ? fonte.permalink : null,
    statusMl: typeof fonte.status === "string" ? fonte.status : null,
    resposta: fonte,
  });

  return { publicacao, itemReal: fonte, divergencias: compararComItemReal(payloadValidado, fonte) };
}
