/**
 * Leitura de `GET /api/ml/conexao` no NAVEGADOR — F0.c.5, fase C.
 *
 * ── Por que este arquivo é separado de `lib/ml-conexao.ts` ──────────
 * Aquele módulo cria um cliente Supabase no escopo do módulo e é código
 * de servidor. Importá-lo de um componente `"use client"` arrastaria o
 * SDK e a lógica de credencial para o bundle do navegador. A fronteira
 * é deliberada: **aqui não há segredo, não há rede e não há React** —
 * só a interpretação da resposta, em funções puras.
 *
 * O preço dessa separação é o contrato aparecer duas vezes. O antídoto
 * não é confiança: `scripts/testar-conexao-ml-tela.ts` gera as respostas
 * com o `montarRespostaConexao` REAL do servidor e as passa por
 * `interpretarConexaoML`, de modo que uma divergência entre os dois
 * lados quebra o teste.
 *
 * ── A regra que este módulo existe para impor ───────────────────────
 * "Não consegui verificar" NUNCA vira "Mercado Livre desconectado".
 * 401, 503, falha de rede, corpo ilegível e motivo desconhecido têm
 * estados próprios. Foi confundir essas coisas que produziu o impasse
 * de 2026-08-14, quando a tela declarava desconexão com a credencial
 * intacta no banco.
 */

/** Identificação de loja que trafega na resposta. Nunca há credencial. */
export interface LojaConexaoML {
  id: string;
  nickname: string;
  marketplace: string;
}

export type EstadoConexaoML =
  /** A resposta ainda não chegou. NÃO é desconexão. */
  | "CARREGANDO"
  /** Há loja do usuário com credencial utilizável. */
  | "CONECTADO"
  /** A loja existe, mas a autorização precisa ser renovada pelo OAuth. */
  | "PRECISA_RECONECTAR"
  /** O usuário realmente não tem loja ML utilizável. */
  | "SEM_LOJA"
  /** Mais de uma loja e nenhuma escolhida. Há conexão; falta selecionar. */
  | "LOJA_NAO_DEFINIDA"
  /** A loja indicada pelo navegador não serve. Nunca cair em outra. */
  | "LOJA_INVALIDA"
  /** 401 — sessão da CDS ausente ou inválida. NÃO é desconexão do ML. */
  | "ERRO_DE_SESSAO"
  /** 5xx, rede, corpo ilegível, contrato desconhecido. NÃO é desconexão. */
  | "ERRO_DE_INFRAESTRUTURA";

export interface ConexaoML {
  estado: EstadoConexaoML;
  loja?: LojaConexaoML;
  lojas?: LojaConexaoML[];
}

/** Estado inicial da tela, antes da primeira resposta. */
export const CONEXAO_ML_CARREGANDO: ConexaoML = { estado: "CARREGANDO" };

function lerLoja(v: unknown): LojaConexaoML | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "string") return undefined;
  return {
    id: o.id,
    nickname: typeof o.nickname === "string" ? o.nickname : "",
    marketplace: typeof o.marketplace === "string" ? o.marketplace : "ML",
  };
}

/**
 * Traduz `(status HTTP, corpo)` em estado de tela.
 *
 * `status === 0` é a convenção para "o fetch nem completou" (rede caiu,
 * CORS, aborto). Vira infraestrutura, não desconexão.
 *
 * Um `motivo` que este código não conhece também vira infraestrutura:
 * se o contrato do servidor mudar, a tela precisa dizer "não sei", e
 * não inventar um veredito sobre a conta do usuário.
 */
export function interpretarConexaoML(status: number, corpo: unknown): ConexaoML {
  if (status === 401) return { estado: "ERRO_DE_SESSAO" };
  if (status !== 200) return { estado: "ERRO_DE_INFRAESTRUTURA" };
  if (!corpo || typeof corpo !== "object") return { estado: "ERRO_DE_INFRAESTRUTURA" };

  const o = corpo as Record<string, unknown>;

  if (o.conectado === true) {
    return { estado: "CONECTADO", loja: lerLoja(o.loja) };
  }
  if (o.precisaReconectar === true) {
    return { estado: "PRECISA_RECONECTAR", loja: lerLoja(o.loja) };
  }
  if (o.motivo === "SEM_LOJA") return { estado: "SEM_LOJA" };
  if (o.motivo === "LOJA_INVALIDA") return { estado: "LOJA_INVALIDA" };
  if (o.motivo === "LOJA_NAO_DEFINIDA") {
    const lojas = Array.isArray(o.lojas)
      ? o.lojas.map(lerLoja).filter((l): l is LojaConexaoML => !!l)
      : [];
    return { estado: "LOJA_NAO_DEFINIDA", lojas };
  }
  return { estado: "ERRO_DE_INFRAESTRUTURA" };
}

/**
 * A tela pode disparar uma ação que fala com o Mercado Livre?
 *
 * Só em `CONECTADO`. Todos os outros estados bloqueiam — inclusive os de
 * erro: executar a ação "para ver se dá certo" é o que faz a falha
 * aparecer como erro genérico do marketplace lá na frente.
 */
export function podeOperarML(conexao: ConexaoML): boolean {
  return conexao.estado === "CONECTADO";
}

/** Texto do `title` do botão bloqueado — diz POR QUE, não só "não pode". */
export function motivoBloqueioML(conexao: ConexaoML): string | null {
  switch (conexao.estado) {
    case "CONECTADO":              return null;
    case "CARREGANDO":             return "Verificando a conexão com o Mercado Livre...";
    case "PRECISA_RECONECTAR":     return "A autorização do Mercado Livre expirou — reconecte para usar";
    case "SEM_LOJA":               return "Conecte o Mercado Livre primeiro";
    case "LOJA_NAO_DEFINIDA":      return "Selecione qual loja do Mercado Livre usar";
    case "LOJA_INVALIDA":          return "A loja selecionada não está disponível — escolha outra";
    case "ERRO_DE_SESSAO":         return "Sua sessão expirou — entre novamente";
    case "ERRO_DE_INFRAESTRUTURA": return "Não foi possível verificar a conexão agora";
  }
}

/** Início do OAuth. Sem loja é CONNECT; com loja é RECONNECT daquela loja. */
export const CAMINHO_OAUTH_ML = "/api/auth/mercadolivre";

function hrefReconexao(lojaId: string | undefined): string {
  if (!lojaId) return CAMINHO_OAUTH_ML;
  return `${CAMINHO_OAUTH_ML}?loja_id=${encodeURIComponent(lojaId)}`;
}

export interface AvisoConexaoML {
  tom: "aviso" | "erro" | "info";
  titulo: string;
  descricao: string;
  /** Ação em link. Ausente quando a saída não é uma navegação. */
  acao?: { texto: string; href: string };
}

/**
 * O aviso exibido no topo da lista, ou `null` quando não há o que avisar.
 *
 * `CARREGANDO` devolve `null` de propósito: antes desta fase a tela
 * começava com `mlConectado = false` e piscava "Mercado Livre não
 * conectado" em toda visita, mesmo com a conta perfeita.
 *
 * Os textos de `SEM_LOJA` são os que já existiam na tela — o estado que
 * o aviso antigo de fato representava. Os demais são novos porque antes
 * não existiam: tudo caía no mesmo texto.
 */
export function avisoConexaoML(conexao: ConexaoML): AvisoConexaoML | null {
  switch (conexao.estado) {
    case "CONECTADO":
    case "CARREGANDO":
      return null;

    case "SEM_LOJA":
      return {
        tom: "aviso",
        titulo: "Mercado Livre não conectado",
        descricao: "Conecte para buscar anúncios pelo link automaticamente.",
        acao: { texto: "Conectar ML", href: "/api/auth/mercadolivre" },
      };

    case "PRECISA_RECONECTAR":
      return {
        tom: "aviso",
        titulo: "A autorização do Mercado Livre expirou",
        descricao: "Sua conta continua cadastrada — só é preciso autorizar de novo para voltar a sincronizar.",
        // A loja vai no link (F0.c.6c). Antes o botão mandava para o
        // OAuth genérico, e o servidor não tinha como saber QUAL conta
        // estava sendo reautorizada — com duas lojas, reconectava a
        // errada. O `loja_id` vem do navegador, mas a propriedade é
        // validada no servidor ANTES de o `state` ser assinado.
        acao: { texto: "Reconectar ML", href: hrefReconexao(conexao.loja?.id) },
      };

    case "LOJA_NAO_DEFINIDA":
      // Não é desconexão: a conta está lá, falta escolher qual. O seletor
      // já existe na barra superior — esta fase não cria um segundo.
      return {
        tom: "info",
        titulo: "Selecione a loja do Mercado Livre",
        descricao: "Você tem mais de uma conta conectada. Escolha qual usar no seletor de lojas, no topo da página.",
      };

    case "LOJA_INVALIDA":
      return {
        tom: "aviso",
        titulo: "A loja selecionada não está disponível",
        descricao: "Escolha outra loja no seletor, no topo da página.",
      };

    case "ERRO_DE_SESSAO":
      return {
        tom: "erro",
        titulo: "Sua sessão expirou",
        descricao: "Entre novamente para continuar. Isto não afeta a conexão com o Mercado Livre.",
        acao: { texto: "Fazer login", href: "/login" },
      };

    case "ERRO_DE_INFRAESTRUTURA":
      return {
        tom: "erro",
        titulo: "Não foi possível verificar a conexão",
        descricao: "Isto não quer dizer que o Mercado Livre está desconectado. Tente novamente em instantes.",
      };
  }
}

// ────────────────────────────────────────────────────────────────────
// RETORNO DO OAUTH — F0.c.6e
//
// O callback volta para `/configuracoes` com `?ml=` ou `?ml_erro=`. Esta
// é a única tradução desses códigos.
//
// REGRA: a query NUNCA é renderizada. O que a tela mostra sai da tabela
// abaixo, indexada por um código conhecido; qualquer valor fora dela
// vira `null` e a tela não exibe nada. Sem isso, `?ml_erro=<html>` seria
// texto do atacante dentro da nossa interface.
// ────────────────────────────────────────────────────────────────────

export interface RetornoOAuthML {
  tom: "sucesso" | "erro";
  texto: string;
}

const SUCESSOS: Readonly<Record<string, string>> = {
  connected: "Mercado Livre conectado com sucesso.",
  reconnected: "Mercado Livre reconectado com sucesso.",
};

/**
 * Mensagens de erro.
 *
 * Nenhuma cita token, seller, nome de tabela, status HTTP do provedor ou
 * mensagem do Mercado Livre. Vários códigos distintos compartilham texto
 * de propósito — `state_invalido` cobre desde assinatura adulterada até
 * usuário divergente, e explicar a diferença ajudaria só quem tentou.
 */
const ERROS: Readonly<Record<string, string>> = {
  oauth_cancelado: "Autorização cancelada. Nenhuma alteração foi feita.",
  state_expirado: "A autorização expirou. Tente novamente.",
  state_invalido: "Não foi possível validar esta autorização. Tente novamente.",
  // PKCE (F0.c.7). O usuário não precisa saber o que é `code_verifier`:
  // na prática os dois casos significam "recomece a autorização".
  pkce_cookie_ausente: "Não foi possível validar a autorização do Mercado Livre. Tente novamente.",
  pkce_invalido: "A autorização do Mercado Livre não pôde ser validada. Tente novamente.",
  sessao_invalida: "Sua sessão expirou durante a autorização. Entre novamente e repita.",
  loja_nao_pertence_usuario: "Esta loja não está disponível na sua conta.",
  conta_ml_diferente: "A conta do Mercado Livre autorizada não corresponde à loja que você quis reconectar. Nada foi alterado.",
  duplicidade_loja: "Foi detectada uma inconsistência na vinculação desta conta. Nenhuma alteração foi realizada.",
  token_exchange_falhou: "O Mercado Livre não concluiu a autorização. Tente novamente.",
  identidade_falhou: "Não foi possível confirmar a conta no Mercado Livre. Tente novamente.",
  persistencia_falhou: "Não foi possível salvar a conexão agora. Tente novamente em instantes.",
  configuracao_invalida: "A conexão com o Mercado Livre está indisponível no momento.",
};

/**
 * Lê `?ml=` / `?ml_erro=` e devolve o que a tela deve mostrar, ou `null`.
 *
 * Recebe um `URLSearchParams` — não a string crua — para deixar explícito
 * que a decodificação é do navegador e que aqui só há consulta por chave.
 */
export function interpretarRetornoOAuthML(params: URLSearchParams): RetornoOAuthML | null {
  const erro = params.get("ml_erro");
  if (erro !== null) {
    const texto = ERROS[erro];
    // Código desconhecido: mensagem genérica, NUNCA o valor recebido.
    return { tom: "erro", texto: texto ?? "Não foi possível concluir a conexão com o Mercado Livre." };
  }

  const ok = params.get("ml");
  if (ok !== null) {
    const texto = SUCESSOS[ok];
    // Sucesso desconhecido não é sucesso: não afirmamos o que não sabemos.
    return texto ? { tom: "sucesso", texto } : null;
  }

  return null;
}
