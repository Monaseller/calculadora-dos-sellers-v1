/**
 * PICTURES do Mercado Livre — upload oficial e mapa idempotente
 * (2026-08-30).
 *
 * ── Por que este caminho, e não a URL assinada ──────────────────────
 * A URL assinada funciona e continua no código como alternativa
 * testada (`imagens-ml.ts` / `montarPayloadTransporteML`), mas ela é
 * **efêmera**: some em minutos. O `picture id` que o Mercado Livre
 * devolve é **estável para a conta**, vive no CDN deles, e é o que a
 * própria documentação recomenda:
 *
 *   "We recommend using the obtained ID to make a new publication or
 *    associate the image with an existing publication." — fonte [B]
 *
 * Com ele, o payload validado e o payload que um futuro `POST /items`
 * enviaria são **o mesmo objeto**, sem nada efêmero no meio.
 *
 * ── A IDENTIDADE INCLUI O CHECKSUM ──────────────────────────────────
 * O mapa é `(loja, imagem_gerada_id, checksum) → ml_picture_id`. Sem o
 * checksum, trocar os bytes mantendo o mesmo id reaproveitaria um
 * `picture id` que aponta para a imagem ANTIGA no CDN — publicar-se-ia
 * uma foto que ninguém aprovou, e em silêncio.
 *
 * ── NÃO HÁ ATOMICIDADE ENTRE O ML E O POSTGRES ──────────────────────
 * Subir no ML e gravar aqui são dois sistemas. Em concorrência, os dois
 * uploads acontecem e só um vence o UNIQUE; o perdedor vira um recurso
 * órfão no CDN do Mercado Livre. Isso é **reportado**, não escondido —
 * ver `orfaos` em `ResultadoPicturesML`.
 *
 * NÃO CRIA ANÚNCIO. O único POST daqui é `/pictures/items/upload`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { ErroML, subirImagemML, type ContaMLInterna } from "./ml-conta";
import { lerImagemGeradaDoProjeto, type ImagemCanonicaML } from "./imagens-ml";
import { MIMES_IMAGEM_ML } from "./regras-mercado-livre";

/** Uma imagem já resolvida no CDN do Mercado Livre. */
export interface PictureResolvida {
  imagemGeradaId: string;
  checksum: string;
  mlPictureId: string;
  /** `true` quando veio do mapa e nenhum upload novo foi feito. */
  reaproveitada: boolean;
}

export interface ResultadoPicturesML {
  resolvidas: PictureResolvida[];
  /** Imagens que não puderam ser preparadas, com o motivo. */
  falhas: { imagemGeradaId: string; motivo: string }[];
  /**
   * Uploads que aconteceram no ML mas perderam a corrida do UNIQUE.
   * Ficam no CDN deles sem referência — inofensivos, e visíveis aqui
   * porque fingir que não existiram seria mentir sobre o que foi feito.
   */
  orfaos: { imagemGeradaId: string; mlPictureId: string }[];
}

const EXTENSAO_POR_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
};

/**
 * Consulta o mapa. A busca é por identidade COMPLETA — trocar qualquer
 * uma das três partes é outra identidade e não reaproveita nada.
 */
async function buscarPictureNoMapa(
  supabaseServico: SupabaseClient,
  lojaId: string,
  imagemGeradaId: string,
  checksum: string
): Promise<string | null> {
  const { data, error } = await supabaseServico
    .from("estudio_anuncios_pictures_marketplace")
    .select("ml_picture_id")
    .eq("loja_id", lojaId)
    .eq("imagem_gerada_id", imagemGeradaId)
    .eq("checksum_sha256", checksum)
    .maybeSingle();
  if (error) throw new Error(`Falha ao consultar o mapa de pictures: ${error.message}`);
  return (data as any)?.ml_picture_id ?? null;
}

/**
 * Garante um `ml_picture_id` para cada imagem canônica, subindo ao
 * Mercado Livre apenas o que ainda não existe.
 *
 * A ordem da entrada é preservada na saída: a primeira é a capa.
 *
 * Antes de qualquer upload, cada imagem passa por quatro conferências —
 * pertence ao projeto, o objeto existe, o MIME é aceito e o checksum dos
 * bytes bate com o que o parecer validou. A quarta é a que impede
 * publicar uma imagem diferente da aprovada.
 *
 * Uma falha **não** aborta as demais: as que subiram ficam registradas e
 * uma nova tentativa continua de onde parou, sem repetir upload.
 */
export async function garantirPicturesML(
  supabaseServico: SupabaseClient,
  conta: ContaMLInterna,
  params: {
    projetoId: string;
    marketplace: string;
    canonicas: ImagemCanonicaML[];
    criadoPor: string;
  }
): Promise<ResultadoPicturesML> {
  const resolvidas: PictureResolvida[] = [];
  const falhas: { imagemGeradaId: string; motivo: string }[] = [];
  const orfaos: { imagemGeradaId: string; mlPictureId: string }[] = [];

  for (const c of params.canonicas) {
    if (!c.checksum) {
      falhas.push({ imagemGeradaId: c.imagemGeradaId, motivo: "imagem sem checksum — não dá para garantir identidade" });
      continue;
    }

    // 1. Já subiu antes com ESTES bytes? Então não sobe de novo.
    const jaMapeado = await buscarPictureNoMapa(supabaseServico, conta.lojaId, c.imagemGeradaId, c.checksum);
    if (jaMapeado) {
      resolvidas.push({ imagemGeradaId: c.imagemGeradaId, checksum: c.checksum, mlPictureId: jaMapeado, reaproveitada: true });
      continue;
    }

    // 2. Lê os bytes com service role. A consulta filtra por projeto,
    //    então imagem de outro projeto é inalcançável por construção.
    let lida: Awaited<ReturnType<typeof lerImagemGeradaDoProjeto>>;
    try {
      lida = await lerImagemGeradaDoProjeto(supabaseServico, params.projetoId, c.imagemGeradaId);
    } catch (err: any) {
      falhas.push({ imagemGeradaId: c.imagemGeradaId, motivo: `falha ao ler a imagem: ${err?.message ?? "erro desconhecido"}` });
      continue;
    }
    if (!lida) {
      falhas.push({ imagemGeradaId: c.imagemGeradaId, motivo: "objeto não encontrado no Storage, ou a imagem não é deste projeto" });
      continue;
    }

    // 3. Os bytes precisam ser os MESMOS que o parecer validou.
    if (lida.checksum !== c.checksum) {
      falhas.push({ imagemGeradaId: c.imagemGeradaId, motivo: "o conteúdo da imagem mudou desde a validação" });
      continue;
    }

    // 4. MIME real, derivado do caminho gravado no Storage — nunca de
    //    valor vindo do cliente.
    const mime = mimeDoCaminho(lida.caminho);
    if (!mime) {
      falhas.push({ imagemGeradaId: c.imagemGeradaId, motivo: "formato fora de JPG/JPEG/PNG" });
      continue;
    }

    // 5. Sobe. Só aqui existe chamada externa.
    let picture: Awaited<ReturnType<typeof subirImagemML>>;
    try {
      picture = await subirImagemML(conta, lida.bytes, `${c.imagemGeradaId}.${EXTENSAO_POR_MIME[mime]}`, mime);
    } catch (err) {
      if (!(err instanceof ErroML)) throw err;
      falhas.push({ imagemGeradaId: c.imagemGeradaId, motivo: `${err.tipo}: ${err.message}` });
      continue;
    }

    // 6. Registra. A RPC é INSERT puro e devolve a linha VENCEDORA —
    //    que pode não ser a nossa, se alguém subiu a mesma imagem no
    //    mesmo instante.
    const { data, error } = await supabaseServico.rpc("estudio_anuncios_registrar_picture_ml", {
      p_loja_id: conta.lojaId,
      p_marketplace: params.marketplace,
      p_projeto_id: params.projetoId,
      p_imagem_gerada_id: c.imagemGeradaId,
      p_checksum: c.checksum,
      p_ml_picture_id: picture.id,
      p_max_size: picture.maxSize,
      p_dominant_color: picture.dominantColor,
      p_resposta: picture.respostaBruta ?? null,
      p_criado_por: params.criadoPor,
    });
    if (error || !data) {
      // O upload ACONTECEU e o registro não. Não há transação entre os
      // dois sistemas, então o honesto é dizer isso: o recurso existe no
      // ML e ficou sem referência aqui.
      orfaos.push({ imagemGeradaId: c.imagemGeradaId, mlPictureId: picture.id });
      falhas.push({
        imagemGeradaId: c.imagemGeradaId,
        motivo: `a imagem subiu ao Mercado Livre mas não foi possível registrá-la: ${error?.message ?? "sem retorno"}`,
      });
      continue;
    }

    const vencedor = (data as any).ml_picture_id as string;
    if (vencedor !== picture.id) {
      // Perdemos a corrida. O id que subimos fica órfão no CDN deles.
      orfaos.push({ imagemGeradaId: c.imagemGeradaId, mlPictureId: picture.id });
    }
    resolvidas.push({
      imagemGeradaId: c.imagemGeradaId,
      checksum: c.checksum,
      mlPictureId: vencedor,
      reaproveitada: vencedor !== picture.id,
    });
  }

  return { resolvidas, falhas, orfaos };
}

/**
 * MIME a partir da extensão do caminho no Storage.
 *
 * O caminho é montado pelo servidor com a extensão derivada do MIME REAL
 * detectado no upload (ver `storage.ts`), então é uma fonte confiável —
 * ao contrário de qualquer valor que tenha passado pelo cliente.
 */
function mimeDoCaminho(caminho: string): string | null {
  const ext = caminho.slice(caminho.lastIndexOf(".") + 1).toLowerCase();
  const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "png" ? "image/png" : null;
  return mime && (MIMES_IMAGEM_ML as readonly string[]).includes(mime) ? mime : null;
}

/**
 * Picture ids JÁ MAPEADOS, sem subir nada.
 *
 * Existe porque o hash do payload passou a incluir `ml_picture_id`, e
 * **os dois lados da comparação de staleness precisam derivá-lo da mesma
 * fonte**. O lado que valida obtém os ids do upload; o lado que confere
 * (o GET do projeto) não pode subir imagem nem usar OAuth — então lê o
 * mapa, que é a fonte de verdade dos dois.
 *
 * Sem isto, toda validação oficial pareceria desatualizada e o portão
 * ficaria fechado para sempre. (Mesmo defeito estrutural encontrado em
 * 2026-08-29 com o checksum; ver `BUGS.md`.)
 */
export async function buscarPicturesMapeadas(
  supabaseServico: SupabaseClient,
  lojaId: string,
  canonicas: { imagemGeradaId: string; checksum: string | null }[]
): Promise<Map<string, string>> {
  const comChecksum = canonicas.filter(c => !!c.checksum);
  if (comChecksum.length === 0) return new Map();

  const { data, error } = await supabaseServico
    .from("estudio_anuncios_pictures_marketplace")
    .select("imagem_gerada_id, checksum_sha256, ml_picture_id")
    .eq("loja_id", lojaId)
    .in("imagem_gerada_id", comChecksum.map(c => c.imagemGeradaId));
  if (error) throw new Error(`Falha ao ler o mapa de pictures: ${error.message}`);

  // O checksum é conferido AQUI, não na consulta: uma linha com os bytes
  // antigos não pode responder pela imagem atual.
  const porIdentidade = new Map<string, string>();
  for (const l of (data ?? []) as any[]) {
    porIdentidade.set(`${l.imagem_gerada_id}:${l.checksum_sha256}`, l.ml_picture_id);
  }

  const mapa = new Map<string, string>();
  for (const c of comChecksum) {
    const id = porIdentidade.get(`${c.imagemGeradaId}:${c.checksum}`);
    if (id) mapa.set(c.imagemGeradaId, id);
  }
  return mapa;
}
