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
        acao: { texto: "Reconectar ML", href: "/api/auth/mercadolivre" },
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
