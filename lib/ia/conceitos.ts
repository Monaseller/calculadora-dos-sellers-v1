/**
 * CDS IA — os quatro conceitos de configuracao, mantidos SEPARADOS.
 *
 * ── Por que quatro tipos, e nao um objeto so ────────────────────────
 *
 *   CONEXAO    "Mercado Livre — MONAMOR"          uma conta/fonte
 *   FUNCAO     "Consultar vendas"                 algo que se pode fazer
 *   PERMISSAO  "este agente pode usar a funcao"   um vinculo
 *   AUTONOMIA  "pode executar sem perguntar"      o grau desse vinculo
 *
 * Fundir dois deles num objeto so e barato hoje e caro depois: quando o
 * backend existir, cada um vira tabela com dono, historico e regra
 * propria. Um contrato de UI que ja os mistura obriga a desmontar a tela
 * junto com a migracao.
 *
 * ── O que este arquivo NAO e ────────────────────────────────────────
 *
 * Nao e schema, nao e capability, nao e permissao real. Sao tipos de
 * APRESENTACAO. Nada aqui concede nada a ninguem: quem autoriza e o
 * backend, e ele ainda nao existe para tres dos quatro conceitos.
 */
import type { TipoAgenteUI } from "@/lib/ia/contratos";

// ── Honestidade sobre o que existe ────────────────────────────────────

/**
 * O quanto uma informacao da tela e real. Existe para que a UI nunca
 * mostre configuracao ficticia com a mesma cara de configuracao
 * persistida — o erro que transforma demonstracao em promessa.
 *
 *   disponivel      lido de fonte real (ou derivado dela)
 *   simulado        veio do mock; existiria assim quando houver backend
 *   nao_configurado a estrutura existe, este agente nao tem valor
 *   em_breve        a estrutura NAO existe; nada foi decidido ainda
 */
export const PROCEDENCIAS = ["disponivel", "simulado", "nao_configurado", "em_breve"] as const;
export type Procedencia = (typeof PROCEDENCIAS)[number];

export const ROTULO_PROCEDENCIA: Record<Procedencia, string> = {
  disponivel: "Dado real",
  simulado: "Simulado",
  nao_configurado: "Não configurado",
  em_breve: "Em breve",
};

// ── 1. CONEXAO ────────────────────────────────────────────────────────

/**
 * Uma conta/fonte disponivel para uso pelos agentes.
 *
 * NAO tem, e nao pode ganhar, campo de credencial. A tela mostra que a
 * conexao EXISTE e o que ela oferece; o material de autenticacao fica no
 * backend e nunca chega ao frontend nem ao agente.
 *
 * `conta` e rotulo legivel ("MONAMOR"), nunca `seller_id`/`shop_id`
 * completos — o mesmo seller externo pode pertencer a donos diferentes,
 * entao ele nao identifica ninguem e so serviria para vazar.
 */
export interface ConexaoUI {
  id: string;
  tipo: "mercado_livre" | "shopee" | "erp" | "outra";
  rotulo: string;
  conta: string;
  ativa: boolean;
  procedencia: Procedencia;
}

// ── 2. FUNCAO (capability) ────────────────────────────────────────────

export const RISCOS = ["baixo", "medio", "alto"] as const;
export type Risco = (typeof RISCOS)[number];

/**
 * Algo que o agente pode fazer usando recursos controlados pelo backend.
 *
 * `acesso` separa leitura de escrita porque a diferenca e de natureza,
 * nao de grau: ler vendas errado mostra numero errado; pausar campanha
 * errado gasta dinheiro do cliente.
 */
export interface FuncaoUI {
  id: string;
  rotulo: string;
  descricao: string;
  /** `null` = nao depende de conexao externa. */
  conexaoNecessaria: string | null;
  acesso: "leitura" | "escrita";
  risco: Risco;
  procedencia: Procedencia;
}

// ── 3. PERMISSAO + 4. AUTONOMIA ───────────────────────────────────────

export const AUTONOMIAS = ["bloqueado", "aprovacao", "automatico"] as const;
export type Autonomia = (typeof AUTONOMIAS)[number];

export const VOCABULARIO_AUTONOMIA: Record<Autonomia, { rotulo: string; explicacao: string }> = {
  bloqueado: {
    rotulo: "Bloqueado",
    explicacao: "O agente não pode usar esta função, nem pedir autorização.",
  },
  aprovacao: {
    rotulo: "Com aprovação",
    explicacao: "O agente pode solicitar, mas a execução espera sua autorização.",
  },
  automatico: {
    rotulo: "Automático",
    explicacao: "O agente executa sem perguntar.",
  },
};

/**
 * O vinculo entre um agente e uma funcao, mais o grau dele.
 *
 * Permissao e autonomia andam juntas na tela e sao campos separados no
 * tipo: "pode usar" e uma decisao, "pode usar sozinho" e outra. Um
 * booleano unico nao representaria os tres niveis.
 */
export interface PermissaoUI {
  funcaoId: string;
  concedida: boolean;
  autonomia: Autonomia;
  procedencia: Procedencia;
}

// ── Descricao do agente por tipo ──────────────────────────────────────

/**
 * A "funcao" que a Visao Geral mostra.
 *
 * NAO e coluna: `agentes` tem `tipo` e `instrucoes`, e mais nada. Isto e
 * apresentacao derivada do tipo — criar uma coluna `descricao` para o
 * que ja e determinado por `tipo` seria duplicar a verdade.
 */
export const DESCRICAO_TIPO: Record<TipoAgenteUI, string> = {
  mensagens: "Atendimento ao comprador",
  ads: "Campanhas e mídia paga",
  fotos: "Tratamento de imagem",
  anuncios: "Título, descrição e ficha do anúncio",
  financeiro: "Margem, taxas e repasses",
  gerente: "Coordena os demais agentes",
};
