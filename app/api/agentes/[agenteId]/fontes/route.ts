/**
 * Fontes de um agente — AGENT-FACTORY-F7a.
 *
 * GET   lista as fontes ATIVAS (e os anexos da conversa, se pedido)
 * POST  recebe upload
 *
 * ── O menu "+" do chat vira `escopo` ────────────────────────────────
 *
 * As duas opcoes que o usuario ve —
 *
 *   "Usar somente nesta conversa"   -> escopo = conversa
 *   "Adicionar como fonte do agente" -> escopo = agente
 *
 * — sao a MESMA rota com um campo diferente. A distincao ja existe no
 * banco desde a F5 (`agente_fontes.escopo`), e nao se repete aqui em
 * forma de duas rotas que teriam de concordar para sempre.
 *
 * ── O cliente nunca nomeia lugar ────────────────────────────────────
 *
 * Nao ha campo de caminho, de bucket nem de chave. O nome enviado e
 * LOGICO e so aparece sanitizado no fim do caminho, que e montado pelo
 * servidor a partir do dono, do escopo e do id.
 */
import { atravessarPorta, responder, UUID_REGEX } from "@/lib/agentes/api/porta";
import { criarPortaDeFontes } from "@/lib/agentes/fontes/repositorio";
import { receberFonte } from "@/lib/agentes/fontes/upload";
import { MAX_BYTES_DA_FONTE } from "@/lib/agentes/fontes/tipos";
import { criarPortaDeConversas } from "@/lib/agentes/conversas/repositorio";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";

export const dynamic = "force-dynamic";

const FALHA = "Nao foi possivel carregar as fontes.";

export async function GET(request: Request, { params }: { params: { agenteId: string } }) {
  try {
    const porta = await atravessarPorta(request, params.agenteId, FALHA);
    if (!porta.ok) return porta.resposta;

    const db = getSupabaseServidor();
    const portaF = criarPortaDeFontes(db);
    const fontes = await portaF.listarDoAgente(porta.userId, porta.agenteId);

    // Anexos so aparecem quando a conversa e dita — e depois de
    // conferir que ela e deste agente. Sem isso, `?conversaId=` viraria
    // um jeito de listar anexo de outra conversa do mesmo dono.
    const url = new URL(request.url);
    const conversaId = url.searchParams.get("conversaId");
    let anexos: { id: string; nome: string; tipo: string }[] = [];
    if (conversaId && UUID_REGEX.test(conversaId)) {
      const c = await criarPortaDeConversas(db).obterConversa(porta.userId, conversaId);
      if (c && c.agenteId === porta.agenteId) {
        anexos = (await portaF.listarDaConversa(porta.userId, conversaId))
          .map((f) => ({ id: f.id, nome: f.nome, tipo: f.tipo }));
      }
    }

    return responder({
      ok: true,
      // `caminhoObjeto` nao existe no tipo de dominio: nao ha o que
      // omitir aqui, o tipo ja impede.
      fontes: fontes.map((f) => ({
        id: f.id, nome: f.nome, descricao: f.descricao, papel: f.papel,
        tipo: f.tipo, tamanhoBytes: f.tamanhoBytes, criadoEm: f.criadoEm,
      })),
      anexos,
    }, 200);
  } catch {
    return responder({ ok: false, erro: FALHA }, 500);
  }
}

export async function POST(request: Request, { params }: { params: { agenteId: string } }) {
  try {
    const porta = await atravessarPorta(request, params.agenteId, FALHA);
    if (!porta.ok) return porta.resposta;

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return responder({ ok: false, erro: "Envio inválido." }, 400);
    }

    const arquivo = form.get("arquivo");
    if (!(arquivo instanceof File)) {
      return responder({ ok: false, erro: "Arquivo ausente." }, 400);
    }
    // Conferido ANTES de ler os bytes: um arquivo grande demais nao
    // precisa ser carregado inteiro na memoria para ser recusado.
    if (arquivo.size > MAX_BYTES_DA_FONTE) {
      return responder({
        ok: false,
        erro: `Arquivo acima do limite de ${Math.floor(MAX_BYTES_DA_FONTE / 1024 / 1024)} MB.`,
        codigo: "tamanho_acima_do_limite",
      }, 413);
    }

    const escopo = form.get("escopo") === "conversa" ? "conversa" : "agente";
    const conversaIdBruto = form.get("conversaId");
    const conversaId = typeof conversaIdBruto === "string" ? conversaIdBruto : null;

    if (escopo === "conversa") {
      if (!conversaId || !UUID_REGEX.test(conversaId)) {
        return responder({ ok: false, erro: "conversaId inválido." }, 400);
      }
      const c = await criarPortaDeConversas(getSupabaseServidor())
        .obterConversa(porta.userId, conversaId);
      if (!c || c.agenteId !== porta.agenteId) {
        return responder({ ok: false, erro: "Conversa não encontrada." }, 404);
      }
    }

    const texto = (chave: string): string | null => {
      const v = form.get(chave);
      return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
    };

    const r = await receberFonte(criarPortaDeFontes(getSupabaseServidor()), {
      userId: porta.userId,
      escopo,
      // O escopo decide QUAL vinculo vai; o outro fica null, como o
      // CHECK `agente_fontes_vinculo_coerente` exige.
      agenteId: escopo === "agente" ? porta.agenteId : null,
      conversaId: escopo === "conversa" ? conversaId : null,
      nome: texto("nome") ?? arquivo.name,
      descricao: texto("descricao"),
      papel: texto("papel"),
      bytes: new Uint8Array(await arquivo.arrayBuffer()),
    });

    if (!r.ok) {
      const status = r.codigo === "tamanho_acima_do_limite" ? 413
        : r.codigo === "falha_ao_persistir" ? 500 : 400;
      return responder({ ok: false, erro: r.mensagem, codigo: r.codigo }, status);
    }

    return responder({
      ok: true,
      fonte: {
        id: r.fonte.id, nome: r.fonte.nome, descricao: r.fonte.descricao,
        papel: r.fonte.papel, tipo: r.fonte.tipo, escopo: r.fonte.escopo,
        tamanhoBytes: r.fonte.tamanhoBytes, criadoEm: r.fonte.criadoEm,
      },
    }, 201);
  } catch {
    return responder({ ok: false, erro: "Nao foi possivel guardar o arquivo." }, 500);
  }
}
