/**
 * POST /api/estudio-anuncios/projetos/[id]/fotos
 *
 * ETAPA (2026-08-08 — Upload real da foto do produto). Substitui o
 * placeholder 501 da Fase 0. Nenhuma IA analisa a foto nesta fase —
 * só validação, upload ao Storage privado e registro no banco.
 *
 * Contrato do corpo da requisição: multipart/form-data, um ou mais
 * arquivos no campo repetido "fotos" (`formData.append("fotos", file)`
 * por arquivo).
 *
 * Segurança (nesta ordem, nunca invertida — mesmo padrão do resto do
 * módulo):
 *   1) autenticarRequisicao(request) — 401 se ausente;
 *   2) valida formato UUID de params.id — 400 se inválido;
 *   3) buscarProjetoPorId(supabase, userId, params.id) — já filtra por
 *      user_id da sessão; projeto inexistente OU de outro usuário
 *      devolvem o MESMO 404 (não vaza existência);
 *   4) só DEPOIS de confirmar a propriedade é que o service role
 *      (getSupabaseServidor()) é usado — nunca antes, e nunca para a
 *      leitura de propriedade em si.
 * Nunca aceita user_id vindo do corpo/query da requisição. Nunca
 * devolve o storage_path/chave do objeto. Nunca gera URL pública —
 * só assinada, via lib/estudio-anuncios/storage.ts.
 *
 * Upload é processado por arquivo (não é uma transação de lote): um
 * arquivo inválido/com falha não derruba os demais. Cada arquivo segue
 * o fluxo validar → gerar imagemId → upload no Storage → INSERT no
 * banco → (se INSERT falhar) excluir o objeto recém-enviado como
 * compensação. Nunca insere no banco apontando para um objeto que
 * ainda não existe no Storage.
 *
 * "Primeira foto = principal" é decidido sequencialmente dentro do
 * próprio request, a partir do estado real do projeto ANTES do lote
 * (lib/estudio-anuncios/fotos.ts:obterEstadoFotosProjeto) — uploads
 * seguintes (neste lote ou em requisições futuras) nunca substituem a
 * principal já existente.
 *
 * Resposta: sempre {ok:true, fotos:[sucessos], falhas:[{nomeOriginal,
 * motivo}]} quando a requisição em si é válida (autenticada, projeto
 * existente e não cancelado, ao menos 1 arquivo, dentro do limite de
 * 10) — mesmo que TODOS os arquivos individuais falhem, o "ok:true"
 * aqui significa "requisição processada", e o cliente deve checar
 * `falhas.length` para decidir se precisa de nova tentativa. Erros de
 * nível de requisição (401/400/404/409/500) usam {ok:false, erro}.
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { autenticarRequisicao } from "@/lib/autenticacao";
import { buscarProjetoPorId } from "@/lib/estudio-anuncios/projetos";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import {
  TAMANHO_MAXIMO_BYTES,
  MAX_FOTOS_POR_PROJETO,
  detectarMimeReal,
  obterDimensoes,
  sanitizarNomeArquivo,
  montarCaminhoObjeto,
  uploadObjeto,
  excluirObjeto,
} from "@/lib/estudio-anuncios/storage";
import { obterEstadoFotosProjeto, inserirFoto, paraRespostaFoto } from "@/lib/estudio-anuncios/fotos";
import type { FotoRespostaAPI, FalhaUploadFoto } from "@/lib/estudio-anuncios/tipos";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  const auth = await autenticarRequisicao(request);
  const userId = auth.autenticado ? auth.uid : null;
  if (!userId) {
    return NextResponse.json({ ok: false, erro: "Não autenticado." }, { status: 401 });
  }

  if (!UUID_REGEX.test(params.id)) {
    return NextResponse.json({ ok: false, erro: "id inválido." }, { status: 400 });
  }

  let projeto;
  try {
    projeto = await buscarProjetoPorId(supabase, userId, params.id);
  } catch (err: any) {
    console.error("[POST /api/estudio-anuncios/projetos/[id]/fotos] falha ao buscar projeto:", err?.message);
    return NextResponse.json({ ok: false, erro: "Falha ao buscar projeto." }, { status: 500 });
  }
  if (!projeto) {
    return NextResponse.json({ ok: false, erro: "Projeto não encontrado." }, { status: 404 });
  }
  if (projeto.status === "cancelado") {
    return NextResponse.json(
      { ok: false, erro: "Projeto cancelado — não é possível enviar fotos." },
      { status: 409 }
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      { ok: false, erro: "Corpo da requisição inválido (multipart/form-data esperado)." },
      { status: 400 }
    );
  }

  const arquivos = formData.getAll("fotos").filter((v): v is File => v instanceof File);
  if (arquivos.length === 0) {
    return NextResponse.json(
      { ok: false, erro: "Nenhum arquivo enviado. Use o campo 'fotos'." },
      { status: 400 }
    );
  }
  if (arquivos.length > MAX_FOTOS_POR_PROJETO) {
    return NextResponse.json(
      { ok: false, erro: `Envie no máximo ${MAX_FOTOS_POR_PROJETO} fotos por vez.` },
      { status: 400 }
    );
  }

  // Service role só a partir daqui — propriedade do projeto já confirmada acima.
  const supabaseServico = getSupabaseServidor();

  let estado;
  try {
    estado = await obterEstadoFotosProjeto(supabaseServico, params.id);
  } catch (err: any) {
    console.error("[POST /api/estudio-anuncios/projetos/[id]/fotos] falha ao consultar estado:", err?.message);
    return NextResponse.json({ ok: false, erro: "Falha ao consultar fotos existentes." }, { status: 500 });
  }

  if (estado.total + arquivos.length > MAX_FOTOS_POR_PROJETO) {
    return NextResponse.json(
      {
        ok: false,
        erro: `O projeto já tem ${estado.total} foto(s) cadastradas. Envie no máximo ${MAX_FOTOS_POR_PROJETO - estado.total} arquivo(s) a mais (limite total: ${MAX_FOTOS_POR_PROJETO}).`,
      },
      { status: 400 }
    );
  }

  const sucessos: FotoRespostaAPI[] = [];
  const falhas: FalhaUploadFoto[] = [];

  let proximaOrdem = estado.proximaOrdem;
  let jaTemPrincipal = estado.temPrincipal;

  for (const arquivo of arquivos) {
    const nomeOriginal = arquivo.name || "arquivo";

    if (arquivo.size === 0) {
      falhas.push({ nomeOriginal, motivo: "Arquivo vazio." });
      continue;
    }
    if (arquivo.size > TAMANHO_MAXIMO_BYTES) {
      falhas.push({ nomeOriginal, motivo: `Arquivo maior que ${TAMANHO_MAXIMO_BYTES / (1024 * 1024)}MB.` });
      continue;
    }

    let buffer: Uint8Array;
    try {
      buffer = new Uint8Array(await arquivo.arrayBuffer());
    } catch {
      falhas.push({ nomeOriginal, motivo: "Falha ao ler o conteúdo do arquivo." });
      continue;
    }

    const mimeReal = await detectarMimeReal(buffer);
    if (!mimeReal) {
      falhas.push({ nomeOriginal, motivo: "Formato não reconhecido ou não permitido (aceitos: JPEG, PNG, WebP)." });
      continue;
    }

    const dimensoes = obterDimensoes(buffer);
    const imagemId = randomUUID();
    const nomeSeguro = sanitizarNomeArquivo(nomeOriginal, mimeReal);
    const caminho = montarCaminhoObjeto(userId, params.id, imagemId, nomeSeguro);

    // 1) Upload primeiro — nunca inserir no banco antes do objeto existir no Storage.
    try {
      await uploadObjeto(supabaseServico, caminho, buffer, mimeReal);
    } catch (errUpload: any) {
      console.error("[POST /api/estudio-anuncios/projetos/[id]/fotos] falha no upload:", errUpload?.message);
      falhas.push({ nomeOriginal, motivo: "Falha ao enviar ao armazenamento. Tente novamente." });
      continue;
    }

    const principalDesta = !jaTemPrincipal;
    const ordemDesta = proximaOrdem;

    // 2) INSERT no banco — se falhar, compensa excluindo o objeto recém-enviado.
    try {
      const inserida = await inserirFoto(supabaseServico, {
        projeto_id: params.id,
        storage_path: caminho,
        ordem: ordemDesta,
        e_principal: principalDesta,
        largura_px: dimensoes?.largura ?? null,
        altura_px: dimensoes?.altura ?? null,
        tamanho_bytes: arquivo.size,
        mime_type: mimeReal,
        nome_original: nomeOriginal.slice(0, 255),
      });

      proximaOrdem += 1;
      if (principalDesta) jaTemPrincipal = true;

      sucessos.push(await paraRespostaFoto(supabaseServico, inserida));
    } catch (errInsert: any) {
      const compensacao = await excluirObjeto(supabaseServico, caminho);
      if (!compensacao.ok) {
        // Nunca mascarar o arquivo órfão — log explícito para limpeza futura manual.
        console.error(
          `[POST /api/estudio-anuncios/projetos/[id]/fotos] ORPHAN OBJECT — upload teve sucesso, INSERT falhou, e a exclusão compensatória também falhou. bucket=estudio-anuncios-originais caminho=${caminho} erroInsert=${errInsert?.message} erroExclusao=${compensacao.erro}`
        );
      } else {
        console.error(
          `[POST /api/estudio-anuncios/projetos/[id]/fotos] INSERT falhou após upload — objeto excluído com sucesso (sem órfão). caminho=${caminho} erro=${errInsert?.message}`
        );
      }
      falhas.push({ nomeOriginal, motivo: "Falha ao registrar a foto. Tente novamente." });
    }
  }

  return NextResponse.json({ ok: true, fotos: sucessos, falhas }, { status: 200 });
}
