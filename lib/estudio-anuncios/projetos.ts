/**
 * Acesso a dados do CRUD do Projeto Mestre (estudio_anuncios_projetos +
 * estudio_anuncios_projetos_marketplace). Usado só pelas rotas
 * app/api/estudio-anuncios/projetos e .../[id].
 *
 * Mesmo padrão de autorização do resto do CDS (sem RLS): todo SELECT/
 * UPDATE filtra explicitamente por user_id da sessão — nunca confia em
 * user_id vindo do corpo da requisição.
 *
 * criarProjeto() chama a função RPC criar_projeto_estudio_anuncios(),
 * que ainda NÃO existe no banco — proposta na entrega desta tarefa,
 * pendente de aprovação e execução da migration (ver chat). Até lá,
 * POST /api/estudio-anuncios/projetos falha com erro do Postgres
 * "function ... does not exist" — comportamento esperado, não um bug.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CriarProjetoInput, EditarProjetoInput, ProjetoComAdaptacoes, ProjetoMestre, ProjetoMarketplaceAdaptacao } from "./tipos";

// user_id NÃO está na lista de colunas retornadas às rotas — mesmo
// padrão de app/api/lojas/route.ts (não expor o identificador de sessão
// de volta na resposta da API, embora não seja segredo do próprio
// usuário). Sempre usado como filtro (.eq("user_id", userId)), nunca
// selecionado.
const COLUNAS_PROJETO =
  "id, loja_id, nome_produto, marketplace, modo, quantidade_imagens_solicitada, " +
  "estilo, direcao_criativa, direcoes_imagens, " +
  "permitir_busca_externa, biblioteca_produto_id, status, criado_em, atualizado_em, " +
  "concluido_em, cancelado_em";

const COLUNAS_ADAPTACAO = "id, projeto_id, marketplace, status, criado_em, atualizado_em, concluido_em";

export interface ListarProjetosOpcoes {
  status?: string;
  page?: number;
  pageSize?: number;
}

export interface ListarProjetosResultado {
  projetos: ProjetoComAdaptacoes[];
  page: number;
  pageSize: number;
}

export async function listarProjetos(
  supabase: SupabaseClient,
  userId: string,
  opcoes: ListarProjetosOpcoes
): Promise<ListarProjetosResultado> {
  const page = opcoes.page && opcoes.page > 0 ? opcoes.page : 1;
  const pageSize = opcoes.pageSize && opcoes.pageSize > 0 ? Math.min(opcoes.pageSize, 100) : 20;
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let query = supabase
    .from("estudio_anuncios_projetos")
    .select(`${COLUNAS_PROJETO}, adaptacoes:estudio_anuncios_projetos_marketplace(${COLUNAS_ADAPTACAO})`)
    .eq("user_id", userId);

  // Sem filtro explícito de status, ignora cancelados por padrão. Com
  // filtro explícito (mesmo "cancelado"), respeita o que foi pedido.
  query = opcoes.status ? query.eq("status", opcoes.status) : query.neq("status", "cancelado");

  const { data, error } = await query.order("criado_em", { ascending: false }).range(from, to);

  if (error) throw new Error(`Falha ao listar projetos: ${error.message}`);

  return {
    projetos: (data ?? []) as unknown as ProjetoComAdaptacoes[],
    page,
    pageSize,
  };
}

export async function buscarProjetoPorId(
  supabase: SupabaseClient,
  userId: string,
  id: string
): Promise<ProjetoComAdaptacoes | null> {
  const { data, error } = await supabase
    .from("estudio_anuncios_projetos")
    .select(`${COLUNAS_PROJETO}, adaptacoes:estudio_anuncios_projetos_marketplace(${COLUNAS_ADAPTACAO})`)
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw new Error(`Falha ao buscar projeto: ${error.message}`);
  if (!data) return null;
  return data as unknown as ProjetoComAdaptacoes;
}

/**
 * Cria o Projeto Mestre + 1 linha de adaptação por marketplace, de
 * forma atômica, via RPC restrita a service_role (ver
 * supabase/migrations/20260804_criar_projeto_estudio_anuncios_rpc.sql
 * e lib/estudio-anuncios/supabase-servidor.ts). `supabaseServico` é
 * usado EXCLUSIVAMENTE para a chamada da RPC — a leitura de
 * confirmação e das adaptações continua no cliente anon (`supabase`),
 * mesmo padrão do resto do arquivo. Se a RPC falhar (validação interna
 * ou CHECK do banco), nada foi inserido — não há projeto parcial para
 * limpar, e este código não tenta nenhum fallback com INSERTs manuais.
 */
export async function criarProjeto(
  supabase: SupabaseClient,
  supabaseServico: SupabaseClient,
  userId: string,
  input: CriarProjetoInput
): Promise<ProjetoComAdaptacoes> {
  const { data: projetoRpc, error } = await supabaseServico
    .rpc("criar_projeto_estudio_anuncios", {
      p_user_id: userId,
      p_nome_produto: input.nome_produto,
      p_marketplaces: input.marketplaces,
      p_quantidade_imagens: input.quantidade_imagens,
      p_modo: input.modo ?? "rapido",
      p_permitir_busca_externa: input.permitir_busca_externa ?? false,
      p_estilo: input.estilo ?? null,
    })
    .single();

  if (error) throw new Error(`Falha ao criar projeto: ${error.message}`);
  if (!projetoRpc) throw new Error("Falha ao criar projeto: RPC não retornou o projeto criado.");

  const projetoId = (projetoRpc as ProjetoMestre).id;

  // Não confia só no retorno bruto da RPC para montar a resposta —
  // relê o projeto filtrando por id + user_id da sessão (defesa extra,
  // mesmo padrão de autorização do resto do módulo).
  const { data: projetoConfirmado, error: erroConfirma } = await supabase
    .from("estudio_anuncios_projetos")
    .select(COLUNAS_PROJETO)
    .eq("id", projetoId)
    .eq("user_id", userId)
    .maybeSingle();

  if (erroConfirma) throw new Error(`Projeto criado, mas falha ao confirmar leitura: ${erroConfirma.message}`);
  if (!projetoConfirmado) throw new Error("Projeto criado, mas não encontrado ao reler (inconsistência inesperada).");

  const { data: adaptacoes, error: erroAdaptacoes } = await supabase
    .from("estudio_anuncios_projetos_marketplace")
    .select(COLUNAS_ADAPTACAO)
    .eq("projeto_id", projetoId);

  if (erroAdaptacoes) throw new Error(`Projeto criado, mas falha ao buscar adaptações: ${erroAdaptacoes.message}`);

  return {
    ...(projetoConfirmado as unknown as ProjetoMestre),
    adaptacoes: (adaptacoes ?? []) as ProjetoMarketplaceAdaptacao[],
  };
}

/**
 * Retorna o projeto atualizado, ou null se não existir/não pertencer
 * ao usuário (a rota decide se isso vira 404).
 */
export async function editarProjeto(
  supabase: SupabaseClient,
  userId: string,
  id: string,
  input: EditarProjetoInput
): Promise<ProjetoMestre | null> {
  const { data, error } = await supabase
    .from("estudio_anuncios_projetos")
    .update({ ...input, atualizado_em: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", userId)
    .select(COLUNAS_PROJETO)
    .maybeSingle();

  if (error) throw new Error(`Falha ao editar projeto: ${error.message}`);
  return (data as ProjetoMestre | null) ?? null;
}

export type ResultadoCancelamento =
  | { encontrado: false }
  | { encontrado: true; jaEstavaCancelado: boolean; projeto: ProjetoMestre };

/**
 * Soft-delete idempotente: se já estiver cancelado, não regrava
 * cancelado_em (evita apagar o timestamp original do primeiro
 * cancelamento) e retorna jaEstavaCancelado=true.
 */
export async function cancelarProjetoLogicamente(
  supabase: SupabaseClient,
  userId: string,
  id: string
): Promise<ResultadoCancelamento> {
  const { data: atual, error: erroBusca } = await supabase
    .from("estudio_anuncios_projetos")
    .select(COLUNAS_PROJETO)
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();

  if (erroBusca) throw new Error(`Falha ao buscar projeto para exclusão: ${erroBusca.message}`);
  if (!atual) return { encontrado: false };

  const projetoAtual = atual as unknown as ProjetoMestre;
  if (projetoAtual.status === "cancelado") {
    return { encontrado: true, jaEstavaCancelado: true, projeto: projetoAtual };
  }

  const agora = new Date().toISOString();
  const { data: atualizado, error: erroUpdate } = await supabase
    .from("estudio_anuncios_projetos")
    .update({ status: "cancelado", cancelado_em: agora, atualizado_em: agora })
    .eq("id", id)
    .eq("user_id", userId)
    .select(COLUNAS_PROJETO)
    .single();

  if (erroUpdate) throw new Error(`Falha ao cancelar projeto: ${erroUpdate.message}`);
  return { encontrado: true, jaEstavaCancelado: false, projeto: atualizado as unknown as ProjetoMestre };
}
