/**
 * GET/PATCH/DELETE /api/estudio-anuncios/projetos/[id]
 *
 * Mesmo padrão de autenticação/autorização de .../projetos/route.ts —
 * ver comentário lá. GET/PATCH/DELETE sempre filtram por
 * projeto.id + user_id da sessão; inexistente e "de outro usuário"
 * retornam exatamente o mesmo 404 (não vaza se o id existe).
 *
 * DELETE é soft-delete (status='cancelado'), nunca DELETE físico —
 * idempotente (chamar de novo num projeto já cancelado não é erro).
 *
 * AJUSTE (2026-08-06 — UI do Projeto Mestre): GET passou a incluir
 * `pipeline` e `jobs` na mesma resposta (não é uma rota nova — só
 * enriquece esta já existente). Regra de segurança: pipeline/jobs só
 * são buscados DEPOIS de buscarProjetoPorId() confirmar que o projeto
 * pertence a este user_id — nunca antes, nunca com user_id vindo do
 * corpo/query da requisição. Ambos filtram explicitamente por
 * projeto_id = params.id (já confirmado do dono certo nesse ponto),
 * usando o mesmo cliente anon (sem RLS no projeto inteiro — a
 * autorização é 100% esta checagem de propriedade acima, mesmo padrão
 * do resto do arquivo).
 *
 * AJUSTE (2026-08-19 — UI de resultado): GET passou a incluir também
 * `resultado`, o DTO consolidado dos artefatos da Fase 1 (análise
 * visual, conteúdo, revisão, marketplaces, prompts, imagens, score e
 * custos). Continua sendo ESTA rota, não uma paralela — mesma regra de
 * ouro das anteriores: só é buscado DEPOIS de a propriedade do projeto
 * estar confirmada, e tudo filtra por `projeto_id`. As imagens saem
 * daqui como URL assinada de curta duração gerada na hora (service
 * role); `storage_path` nunca é exposto. O score vem da fonte OFICIAL
 * (`resultados_pipeline`, etapa `calculo_score`) — a tabela legada
 * `estudio_anuncios_score` não é lida.
 *
 * AJUSTE (2026-08-08 — Upload real da foto do produto): GET passou a
 * incluir também `fotos` (mesmo padrão acima — só buscadas depois da
 * propriedade confirmada). Cada foto vem com `urlAssinada` gerada NA
 * HORA via service role (getSupabaseServidor()) — nunca persistida no
 * banco, nunca pública. O `storage_path` bruto nunca é exposto nesta
 * resposta.
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { autenticarRequisicao } from "@/lib/autenticacao";
import { buscarProjetoPorId, editarProjeto, cancelarProjetoLogicamente } from "@/lib/estudio-anuncios/projetos";
import { validarEditarProjeto } from "@/lib/estudio-anuncios/validacao";
import { buscarPipelinePorProjeto } from "@/lib/estudio-anuncios/pipeline/pipeline";
import { listarJobsPorProjeto } from "@/lib/estudio-anuncios/jobs";
import { listarFotosPorProjeto } from "@/lib/estudio-anuncios/fotos";
import { montarResultadoProjeto, buscarResultadosPipelinePorProjeto } from "@/lib/estudio-anuncios/resultados";
import { montarEditorialProjeto } from "@/lib/estudio-anuncios/conteudo-editorial";
import { listarPacotesDoProjeto, paraDTOPublico } from "@/lib/estudio-anuncios/exportacao";
import { buscarComplianceDoProjeto } from "@/lib/estudio-anuncios/compliance/compliance";
import { motivoNaoPublicavel, podePublicarMarketplace } from "@/lib/estudio-anuncios/compliance/registry";
import { buscarPublicacaoDoProjeto } from "@/lib/estudio-anuncios/compliance/configuracao-marketplace";
import {
  buscarValidacoesDoProjeto,
  motivoNaoPublicavelML,
  podePublicarMercadoLivre,
} from "@/lib/estudio-anuncios/compliance/validacao-oficial";
import { buscarPublicacoesDoProjeto } from "@/lib/estudio-anuncios/compliance/publicacao-ml";
import { buscarPicturesMapeadas } from "@/lib/estudio-anuncios/compliance/pictures-ml";
import { montarPayloadPublicacaoMercadoLivre } from "@/lib/estudio-anuncios/compliance/payload-ml";
import type { EnvelopeAdaptacaoMarketplace } from "@/lib/estudio-anuncios/adaptacao-marketplace-tipos";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import type { ProjetoComAdaptacoes, ProjetoMestre } from "@/lib/estudio-anuncios/tipos";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function paraResposta<T extends { user_id?: string }>(p: T) {
  const resto = { ...p };
  delete resto.user_id;
  return resto;
}

export async function GET(
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

  try {
    const projeto = await buscarProjetoPorId(supabase, userId, params.id);
    if (!projeto) {
      return NextResponse.json({ ok: false, erro: "Projeto não encontrado." }, { status: 404 });
    }

    // A partir daqui a propriedade do projeto já está confirmada — só
    // então buscamos pipeline/jobs/fotos, sempre filtrando por params.id.
    // fotos usa o service role só para gerar as URLs assinadas (leitura
    // das linhas em si usa o cliente anon comum, mesmo padrão de
    // pipeline/jobs acima).
    const [pipeline, jobs, fotos, resultado, resultadosPorEtapa] = await Promise.all([
      buscarPipelinePorProjeto(supabase, params.id),
      listarJobsPorProjeto(supabase, params.id),
      listarFotosPorProjeto(supabase, getSupabaseServidor(), params.id),
      // SEC-1c-3: 1o argumento migrado de `supabase` (anon) para
      // service_role. `montarResultadoProjeto` delega a
      // `buscarCustoProjeto(supabase, ...)`, que le `central_ia_consumo`
      // com ESTE cliente — e este era o ULTIMO caminho runtime anon
      // daquela tabela. O 2o argumento ja era service_role (Storage) e
      // nao muda. A posse do projeto foi validada na linha 95.
      montarResultadoProjeto(getSupabaseServidor(), getSupabaseServidor(), params.id),
      buscarResultadosPipelinePorProjeto(supabase, params.id),
    ]);

    // Camada editorial (2026-08-20): 2 queries no total — canais do
    // projeto + versões de todos os canais de uma vez, sem N+1. A
    // adaptação vem do resultado que já foi lido acima, não de uma
    // consulta nova.
    const linhaAdaptacao = resultadosPorEtapa.get("adaptacao_marketplace");
    const editorial = await montarEditorialProjeto(
      supabase,
      params.id,
      (linhaAdaptacao?.resultado as EnvelopeAdaptacaoMarketplace | undefined) ?? null,
      linhaAdaptacao?.id ?? null
    );
    const [exportacao, complianceLinhas, publicacao] = await Promise.all([
      // Histórico de pacotes (2026-08-21): 1 query, filtrada por
      // projeto_id, na mesma resposta — nenhuma rota de listagem
      // paralela, e o polling já existente mantém a UI atualizada.
      // SEC-1c-4: 1o argumento migrado de `supabase` (anon) para
      // service_role. Query, filtros e projecao inalterados — a posse do
      // projeto ja foi validada por buscarProjetoPorId acima.
      listarPacotesDoProjeto(getSupabaseServidor(), params.id),
      // Pré-publicação (2026-08-23): último parecer por canal, 1 query,
      // filtrada por projeto_id. `podePublicar` é derivado no servidor
      // pelo portão único — a UI nunca decide isso por conta própria.
      // SEC-1c-4: 1o argumento migrado para service_role. O 4o ja era
      // service_role (checksum das imagens no Storage) e PERMANECE — os
      // dois lados do hash precisam enxergar os mesmos dados.
      buscarComplianceDoProjeto(getSupabaseServidor(), params.id, projeto.nome_produto, getSupabaseServidor()),
      // Dados de publicação por canal (2026-08-24): 1 query, filtrada por
      // projeto_id. Nenhum token, nenhum segredo — só o que o usuário
      // configurou e o snapshot público da categoria.
      buscarPublicacaoDoProjeto(
        supabase,
        params.id,
        // Titulos aprovados so alimentam a SUGESTAO de family_name — o
        // conteudo editorial nao e alterado por isso.
        new Map(editorial.map(c => [c.marketplace, c.versaoAprovada?.conteudo?.titulo ?? null]))
      ),
    ]);

    // Hash do payload de AGORA, por canal (2026-08-25). É ele que diz se
    // a validação oficial ainda descreve o que seria publicado — mesmo
    // princípio do compliance: comparar conteúdo, não data. Montado a
    // partir do parecer de compliance, nunca de dados paralelos.
    const hashPayloadPorCanal = new Map<string, string>();
    for (const c of complianceLinhas) {
      const lojaId = publicacao.find(p => p.marketplace === c.marketplace)?.lojaId ?? null;
      if (!lojaId || !c.resultado?.payload) continue;
      // Compliance desatualizado descreve o payload ANTIGO. Calcular o
      // hash a partir dele faria a validação oficial parecer atual
      // quando os dados já mudaram — sem hash, ela é marcada como
      // desatualizada, que é a afirmação verdadeira.
      if (c.desatualizado) continue;
      // Os picture ids saem do MAPA — a mesma fonte que a validação
      // oficial usa. Aqui não há OAuth e nada é subido: só leitura.
      // Sem isto, o hash sairia sem os ids e TODA validação oficial
      // pareceria desatualizada (mesmo defeito de 2026-08-29 com o
      // checksum: os dois lados da comparação precisam ver o mesmo dado).
      const picturesML = await buscarPicturesMapeadas(
        getSupabaseServidor(),
        lojaId,
        ((c.resultado.payload as any)?.pictures ?? []).map((i: any) => ({
          imagemGeradaId: i.imagem_gerada_id,
          checksum: i.checksum ?? null,
        }))
      );
      hashPayloadPorCanal.set(
        c.marketplace,
        montarPayloadPublicacaoMercadoLivre({
          payloadCompliance: c.resultado.payload,
          lojaId,
          versaoAprovadaId: c.resultado.fonteEditorial?.versaoAprovadaId ?? null,
          // Modelo e family_name saem do próprio parecer — o hash precisa
          // descrever o payload do modelo REAL da conta.
          modelo: (c.resultado.payload as any)?.modelo_publicacao ?? null,
          familyName: (c.resultado.payload as any)?.family_name ?? null,
          picturesML,
        }).hashPayload
      );
    }
    const validacoes = await buscarValidacoesDoProjeto(supabase, params.id, hashPayloadPorCanal);
    // Publicações VIVAS do projeto (2026-08-31). É o que faz o botão de
    // publicar sumir: canal com anúncio criado (ou em estado incerto)
    // não pode publicar de novo, e a UI precisa saber disso.
    const publicacoes = await buscarPublicacoesDoProjeto(getSupabaseServidor(), params.id);

    const projetoResposta = paraResposta(projeto as ProjetoComAdaptacoes & { user_id?: string });

    return NextResponse.json({
      ok: true,
      projeto: {
        ...projetoResposta,
        marketplaces: projeto.adaptacoes.map(a => a.marketplace),
      },
      pipeline: pipeline
        ? {
            id: pipeline.id,
            status: pipeline.status,
            etapaAtual: pipeline.etapaAtual,
            jobAtualId: pipeline.jobAtualId,
            versaoPipeline: pipeline.versaoPipeline,
            versaoCatalogo: pipeline.versaoCatalogo,
            ultimaExecucao: pipeline.ultimaExecucao,
            proximaExecucao: pipeline.proximaExecucao,
            criadoEm: pipeline.criadoEm,
            atualizadoEm: pipeline.atualizadoEm,
            concluidoEm: pipeline.concluidoEm,
            canceladoEm: pipeline.canceladoEm,
            erroTipo: pipeline.erroTipo,
            erroMensagem: pipeline.erroMensagem,
          }
        : null,
      jobs,
      fotos,
      resultado,
      editorial,
      // `paraDTOPublico` remove `storage_path` e `bucket`: depois da
      // materialização (2026-08-22) essas colunas passam a estar
      // preenchidas, e o caminho interno do bucket privado nunca pode
      // sair na resposta. O download é sempre por URL assinada.
      exportacao: exportacao.map(paraDTOPublico),
      publicacao,
      compliance: complianceLinhas.map(c => ({
        ...c,
        podePublicar: podePublicarMarketplace(c.resultado, c.desatualizado),
        motivo: motivoNaoPublicavel(c.resultado, c.desatualizado),
      })),
      // Parecer OFICIAL do marketplace (2026-08-25). `podePublicarML` é
      // derivado no servidor pelo portão dedicado — a UI nunca decide.
      // NENHUM anúncio é criado por este GET.
      validacaoOficial: validacoes.map(v => {
        const ctx = {
          compliance: complianceLinhas.find(x => x.marketplace === v.marketplace) ?? null,
          validacao: v,
          lojaId: publicacao.find(p => p.marketplace === v.marketplace)?.lojaId ?? null,
          hashPayloadAtual: hashPayloadPorCanal.get(v.marketplace) ?? null,
        };
        // Canal com publicação viva NUNCA volta a ser publicável. A
        // decisão é do servidor, e o banco a repete na reserva — a UI só
        // obedece.
        const jaPublicado = publicacoes.find(p => p.marketplace === v.marketplace) ?? null;
        return {
          ...v,
          podePublicarML: !jaPublicado && podePublicarMercadoLivre(ctx),
          motivoML: jaPublicado
            ? (jaPublicado.status === "publicado"
                ? `Este anúncio já foi publicado (item ${jaPublicado.mlItemId}).`
                : "Há uma publicação anterior pendente de reconciliação.")
            : motivoNaoPublicavelML(ctx),
        };
      }),
      // Publicações VIVAS por canal (2026-08-31) — é o que faz o botão
      // de publicar sumir.
      publicacoes,
    });
  } catch (err: any) {
    console.error("[GET /api/estudio-anuncios/projetos/[id]] falhou:", err?.message);
    return NextResponse.json({ ok: false, erro: "Falha ao buscar projeto." }, { status: 500 });
  }
}

export async function PATCH(
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, erro: "Corpo da requisição inválido (JSON esperado)." }, { status: 400 });
  }

  try {
    // Precisa do modo atual do projeto para validar
    // quantidade_imagens_solicitada corretamente quando o PATCH não
    // está trocando o modo junto — e essa busca já serve para
    // devolver 404 cedo se o projeto não existir/não for do usuário.
    const atual = await buscarProjetoPorId(supabase, userId, params.id);
    if (!atual) {
      return NextResponse.json({ ok: false, erro: "Projeto não encontrado." }, { status: 404 });
    }

    const validacao = validarEditarProjeto(body, atual.modo);
    if (!validacao.valido) {
      return NextResponse.json({ ok: false, erro: validacao.erro }, { status: 400 });
    }

    // SEC-1c-3: ESCRITA sai do cliente anon. O isolamento NAO dependia
    // da role e continua nao dependendo: `editarProjeto` aplica
    // `.eq("id", id).eq("user_id", userId)` na propria instrucao de
    // UPDATE, entao registro de outro dono nunca casa o WHERE. `userId`
    // vem de `autenticarRequisicao`, nunca do body.
    const atualizado = await editarProjeto(getSupabaseServidor(), userId, params.id, validacao.dados);
    if (!atualizado) {
      return NextResponse.json({ ok: false, erro: "Projeto não encontrado." }, { status: 404 });
    }

    return NextResponse.json({ ok: true, projeto: paraResposta(atualizado as ProjetoMestre & { user_id?: string }) });
  } catch (err: any) {
    console.error("[PATCH /api/estudio-anuncios/projetos/[id]] falhou:", err?.message);
    return NextResponse.json({ ok: false, erro: "Falha ao editar projeto." }, { status: 500 });
  }
}

export async function DELETE(
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

  try {
    // SEC-1c-3: mesma razao do PATCH — a segunda ESCRITA desta rota
    // deixa de usar o cliente anon. O par (id, user_id) permanece na
    // instrucao de UPDATE.
    const resultado = await cancelarProjetoLogicamente(getSupabaseServidor(), userId, params.id);
    if (!resultado.encontrado) {
      return NextResponse.json({ ok: false, erro: "Projeto não encontrado." }, { status: 404 });
    }
    return NextResponse.json({
      ok: true,
      jaEstavaCancelado: resultado.jaEstavaCancelado,
      projeto: paraResposta(resultado.projeto as ProjetoMestre & { user_id?: string }),
    });
  } catch (err: any) {
    console.error("[DELETE /api/estudio-anuncios/projetos/[id]] falhou:", err?.message);
    return NextResponse.json({ ok: false, erro: "Falha ao excluir projeto." }, { status: 500 });
  }
}
