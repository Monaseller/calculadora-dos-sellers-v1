/**
 * Capability de perfil — PERFIL-SENHA1a.
 *
 * ── O que esta PR fecha ─────────────────────────────────────────────
 * Medido em producao: `anon` tinha SELECT, INSERT e UPDATE em
 * `public.perfil`, tabela SEM RLS. Como a chave anon e publica por
 * natureza — vai no bundle do navegador — qualquer visitante podia ler
 * a senha de todos os usuarios, criar perfis e alterar perfis alheios.
 *
 * Este modulo passa a ser o UNICO caminho ate `perfil`. Depois que as
 * quatro rotas migrarem, a migration da 1a revoga os tres privilegios
 * de `anon`, e a superficie deixa de depender de disciplina.
 *
 * ── Escopo: privilegio, NAO autenticacao ────────────────────────────
 * A 1a nao muda uma virgula do comportamento de login. `senha` continua
 * PLAINTEXT e continua comparada por igualdade na rota. Hash Argon2id,
 * migracao progressiva, enumeracao e timing sao a PERFIL-SENHA1b —
 * deliberadamente separadas, para que esta PR seja revisavel como o que
 * e: troca de cliente Supabase.
 *
 * ── `senha` so cruza ESTA fronteira ─────────────────────────────────
 * De onze operacoes, UMA devolve a coluna `senha`:
 * `lerCredencialDeLogin`. Nenhuma outra a projeta — nem a leitura de
 * perfil da sessao, nem a de `auth/me`. E nenhuma delas, jamais, a
 * escreve em log.
 */
import "server-only";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";

/** Colunas expostas a cada caso de uso. Listas EXPLICITAS, nunca `*`. */
const COLUNAS_LOGIN = "id, email, senha, nome_completo, email_verificado, user_uuid";
const COLUNAS_SESSAO = "user_uuid, nome_completo, email";
const COLUNAS_PERFIL = "id, nome_completo, usuario, email, documento, email_verificado, user_uuid";
const COLUNAS_TOKEN = "id, token_verificacao, token_expiracao, email_verificado";
const COLUNAS_REENVIO = "id, email, email_verificado";

/**
 * A UNICA estrutura deste modulo que carrega a senha. O nome diz de
 * onde ela pode sair: do login, e de mais lugar nenhum.
 */
export interface CredencialDeLogin {
  id: number;
  email: string | null;
  senha: string | null;
  nome_completo: string | null;
  email_verificado: boolean | null;
  user_uuid: string | null;
}

export interface PerfilDaSessao {
  user_uuid: string | null;
  nome_completo: string | null;
  email: string | null;
}

export interface PerfilDoDono {
  id: number;
  nome_completo: string | null;
  usuario: string | null;
  email: string | null;
  documento: string | null;
  email_verificado: boolean | null;
  user_uuid: string | null;
}

export interface PerfilPorToken {
  id: number;
  token_verificacao: string | null;
  token_expiracao: string | null;
  email_verificado: boolean | null;
}

export interface PerfilParaReenvio {
  id: number;
  email: string | null;
  email_verificado: boolean | null;
}

export interface DadosNovoPerfil {
  nomeCompleto: unknown;
  usuario: unknown;
  email: unknown;
  documento: unknown;
  senha: unknown;
  tokenVerificacao: string;
  tokenExpiracao: string;
  userUuid: string;
}

/** Campos que a edicao de perfil aceita. Nada alem disto passa. */
export interface CamposPerfilEditavel {
  nome_completo?: unknown;
  usuario?: unknown;
  email?: unknown;
  documento?: unknown;
  senha?: unknown;
}

// ── Login ────────────────────────────────────────────────────────────

/**
 * Credencial para o login, buscada por email case-insensitive.
 *
 * `.ilike()` e `.single()` reproduzem EXATAMENTE a consulta que a rota
 * fazia antes — inclusive o fato de `single()` errar com zero linhas,
 * que a rota ja tratava descartando o erro. Mudar isso aqui alteraria
 * comportamento de autenticacao, que nao e escopo da 1a.
 *
 * Devolve `senha` porque a comparacao ainda vive na rota. Na 1b a
 * comparacao muda de lugar e esta funcao para de devolve-la.
 */
export async function lerCredencialDeLogin(
  email: string
): Promise<{ credencial: CredencialDeLogin | null; erro: string | null }> {
  if (!email) return { credencial: null, erro: null };

  const { data, error } = await getSupabaseServidor()
    .from("perfil")
    .select(COLUNAS_LOGIN)
    .ilike("email", email)
    .single();

  // `single()` sinaliza "zero linhas" como erro. A rota anterior
  // descartava o erro e tratava `!perfil` — preservado aqui: ausencia
  // vira `null`, nao erro.
  if (error) return { credencial: null, erro: null };
  return { credencial: (data as unknown as CredencialDeLogin | null) ?? null, erro: null };
}

/**
 * Migracao preguicosa de contas antigas: grava `user_uuid` quando falta.
 * Escopo minimo — uma coluna, uma linha, filtrada pelo id ja resolvido.
 */
export async function gravarUserUuid(perfilId: number, userUuid: string): Promise<boolean> {
  if (!perfilId || !userUuid) return false;

  const { error } = await getSupabaseServidor()
    .from("perfil")
    .update({ user_uuid: userUuid })
    .eq("id", perfilId);

  if (error) {
    console.error("[perfil] falha ao gravar user_uuid");
    return false;
  }
  return true;
}

// ── Sessao ───────────────────────────────────────────────────────────

/** `auth/me`: confirma que a sessao aponta para um perfil existente. */
export async function lerPerfilDaSessao(
  userUuid: string
): Promise<{ perfil: PerfilDaSessao | null; erro: string | null }> {
  if (!userUuid) return { perfil: null, erro: null };

  const { data, error } = await getSupabaseServidor()
    .from("perfil")
    .select(COLUNAS_SESSAO)
    .eq("user_uuid", userUuid)
    .single();

  if (error) return { perfil: null, erro: null };
  return { perfil: (data as unknown as PerfilDaSessao | null) ?? null, erro: null };
}

/**
 * `GET /api/perfil`: o perfil do DONO da sessao.
 *
 * `maybeSingle()` — e nao `single()` — porque a rota distingue
 * "perfil inexistente" (200 com `{}`, ausencia legitima) de "banco
 * falhou" (503). Com `single()` os dois colapsariam.
 */
export async function lerPerfilDoDono(
  userUuid: string
): Promise<{ perfil: PerfilDoDono | null; erro: string | null }> {
  if (!userUuid) return { perfil: null, erro: null };

  const { data, error } = await getSupabaseServidor()
    .from("perfil")
    .select(COLUNAS_PERFIL)
    .eq("user_uuid", userUuid)
    .maybeSingle();

  if (error) {
    console.error("[perfil] falha ao consultar perfil do dono");
    return { perfil: null, erro: "erro_consulta_perfil" };
  }
  return { perfil: (data as unknown as PerfilDoDono | null) ?? null, erro: null };
}

// ── Criacao e edicao ─────────────────────────────────────────────────

/** Checagem de email ja cadastrado, antes de criar conta. */
export async function emailJaCadastrado(
  email: string
): Promise<{ existe: boolean; erro: string | null }> {
  if (!email) return { existe: false, erro: null };

  const { data, error } = await getSupabaseServidor()
    .from("perfil")
    .select("id")
    .eq("email", email)
    .maybeSingle();

  if (error) {
    console.error("[perfil] falha ao verificar email existente");
    return { existe: false, erro: "erro_consulta_perfil" };
  }
  return { existe: data !== null, erro: null };
}

/**
 * Cria a conta. Os campos sao NOMEADOS um a um: nada que o cliente
 * mande por fora do contrato chega a `perfil`. `email_verificado` entra
 * como `false` fixo — nao vem do corpo da requisicao.
 *
 * `senha` ainda e gravada como veio (plaintext). Isso e o defeito que a
 * PERFIL-SENHA1b corrige; aqui apenas nao piora.
 */
export async function criarPerfil(
  dados: DadosNovoPerfil
): Promise<{ criado: boolean; erro: string | null }> {
  const { error } = await getSupabaseServidor().from("perfil").insert({
    nome_completo: dados.nomeCompleto,
    usuario: dados.usuario,
    email: dados.email,
    documento: dados.documento,
    senha: dados.senha,
    email_verificado: false,
    token_verificacao: dados.tokenVerificacao,
    token_expiracao: dados.tokenExpiracao,
    user_uuid: dados.userUuid,
  });

  if (error) {
    console.error("[perfil] falha ao criar conta");
    return { criado: false, erro: "erro_criacao_perfil" };
  }
  return { criado: true, erro: null };
}

/**
 * Edicao do perfil do DONO da sessao.
 *
 * Duas barreiras, e as duas importam:
 *  1. `user_uuid` esta no filtro da PROPRIA escrita — nao numa checagem
 *     anterior que um refactor possa remover. Com service_role, essa e a
 *     unica coisa entre um usuario e o perfil de outro.
 *  2. Os campos sao COPIADOS um a um de uma lista fechada. Repassar o
 *     objeto do cliente deixaria alguem gravar `user_uuid`,
 *     `email_verificado` ou `token_verificacao` de brinde.
 */
export async function atualizarPerfilDoDono(
  userUuid: string,
  campos: CamposPerfilEditavel
): Promise<{ atualizado: boolean; erro: string | null }> {
  if (!userUuid) return { atualizado: false, erro: "entrada_invalida" };

  const permitidos: Record<string, unknown> = {};
  if (campos.nome_completo !== undefined) permitidos.nome_completo = campos.nome_completo;
  if (campos.usuario !== undefined) permitidos.usuario = campos.usuario;
  if (campos.email !== undefined) permitidos.email = campos.email;
  if (campos.documento !== undefined) permitidos.documento = campos.documento;
  if (campos.senha !== undefined) permitidos.senha = campos.senha;

  const { error } = await getSupabaseServidor()
    .from("perfil")
    .update(permitidos)
    .eq("user_uuid", userUuid);

  if (error) {
    console.error("[perfil] falha ao atualizar perfil");
    return { atualizado: false, erro: "erro_atualizacao_perfil" };
  }
  return { atualizado: true, erro: null };
}

// ── Verificacao de email ─────────────────────────────────────────────
//
// Este fluxo NAO tem sessao: quem chega traz um token de uso unico no
// link do email. O escopo vem do proprio token, e por isso as operacoes
// abaixo sao estreitas ao extremo — nenhuma aceita campo arbitrario, e
// nenhuma permite escolher QUAIS colunas alterar.

/** Localiza o perfil pelo token do link de verificacao. */
export async function lerPerfilPorTokenVerificacao(
  token: string
): Promise<{ perfil: PerfilPorToken | null; erro: string | null }> {
  if (!token) return { perfil: null, erro: null };

  const { data, error } = await getSupabaseServidor()
    .from("perfil")
    .select(COLUNAS_TOKEN)
    .eq("token_verificacao", token)
    .single();

  if (error) return { perfil: null, erro: null };
  return { perfil: (data as unknown as PerfilPorToken | null) ?? null, erro: null };
}

/**
 * Marca o email como verificado e QUEIMA o token na mesma escrita —
 * um token de verificacao que sobrevive ao uso deixa de ser de uso
 * unico. As tres colunas sao fixas: quem chama nao escolhe.
 */
export async function marcarEmailVerificado(perfilId: number): Promise<boolean> {
  if (!perfilId) return false;

  const { error } = await getSupabaseServidor()
    .from("perfil")
    .update({ email_verificado: true, token_verificacao: null, token_expiracao: null })
    .eq("id", perfilId);

  if (error) {
    console.error("[perfil] falha ao marcar email verificado");
    return false;
  }
  return true;
}

/** Perfil para reenvio do link de verificacao, buscado por email. */
export async function lerPerfilPorEmailParaReenvio(
  email: string
): Promise<{ perfil: PerfilParaReenvio | null; erro: string | null }> {
  if (!email) return { perfil: null, erro: null };

  const { data, error } = await getSupabaseServidor()
    .from("perfil")
    .select(COLUNAS_REENVIO)
    .eq("email", email)
    .single();

  if (error) return { perfil: null, erro: null };
  return { perfil: (data as unknown as PerfilParaReenvio | null) ?? null, erro: null };
}

/** Emite um novo token de verificacao. Só estas duas colunas. */
export async function gravarTokenVerificacao(
  perfilId: number,
  token: string,
  expiracao: string
): Promise<boolean> {
  if (!perfilId || !token) return false;

  const { error } = await getSupabaseServidor()
    .from("perfil")
    .update({ token_verificacao: token, token_expiracao: expiracao })
    .eq("id", perfilId);

  if (error) {
    console.error("[perfil] falha ao gravar token de verificacao");
    return false;
  }
  return true;
}
