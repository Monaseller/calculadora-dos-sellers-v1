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
 * Estado operacional de uma conexao.
 *
 * Os tres primeiros sao DERIVAVEIS de colunas que `lojas` ja tem:
 * `ativo`, `access_token IS NOT NULL` e `token_expires_at`. `erro` nao
 * e coluna nenhuma — seria inferido do ultimo `sync_jobs` da loja, e
 * por isso e o unico que nunca deve ser apresentado como estado
 * persistido. Ver `PROCEDENCIA_ESTADO_CONEXAO`.
 */
export const ESTADOS_CONEXAO = ["conectada", "expirada", "desconectada", "erro"] as const;
export type EstadoConexao = (typeof ESTADOS_CONEXAO)[number];

export const VOCABULARIO_CONEXAO: Record<
  EstadoConexao,
  { rotulo: string; icone: string; explicacao: string }
> = {
  conectada: {
    rotulo: "Conectada",
    icone: "●",
    explicacao: "A conta está ativa e autorizada.",
  },
  expirada: {
    rotulo: "Expirada",
    icone: "◐",
    explicacao: "A autorização venceu. É preciso reconectar a conta.",
  },
  desconectada: {
    rotulo: "Desconectada",
    icone: "○",
    explicacao: "A conta foi desligada e não é usada por nenhum agente.",
  },
  erro: {
    rotulo: "Erro",
    icone: "✕",
    explicacao: "A última sincronização falhou. Este estado é inferido, não registrado.",
  },
};

/**
 * De onde cada estado viria, se a leitura real existisse.
 *
 * Documenta uma assimetria importante: tres estados sao derivaveis de
 * colunas, um e inferencia sobre outra tabela. A tela usa isto para nao
 * dar o mesmo peso aos quatro.
 */
export const PROCEDENCIA_ESTADO_CONEXAO: Record<EstadoConexao, Procedencia> = {
  conectada: "disponivel",
  expirada: "disponivel",
  desconectada: "disponivel",
  erro: "simulado",
};

/**
 * Uma conta/fonte disponivel para uso pelos agentes.
 *
 * NAO tem, e nao pode ganhar, campo de credencial. A tela mostra que a
 * conexao EXISTE e o que ela oferece; o material de autenticacao fica no
 * backend e nunca chega ao frontend nem ao agente. Este contrato tambem
 * nao tem `seller_id`, `shop_id` nem `partner_id`: o mesmo seller
 * externo pode pertencer a donos diferentes, entao ele nao identifica
 * ninguem — so serviria para vazar.
 *
 * `atribuida` e o vinculo agente↔conexao, que NAO existe no banco. Fica
 * separado do `estado` de proposito: uma conta pode estar perfeitamente
 * conectada e simplesmente nao ter sido dada a este agente.
 */
export interface ConexaoUI {
  id: string;
  tipo: "mercado_livre" | "shopee" | "erp" | "outra";
  rotulo: string;
  conta: string;
  estado: EstadoConexao;
  atribuida: boolean;
  /** ISO. `null` quando nunca sincronizou. */
  ultimaSincronizacao: string | null;
  procedencia: Procedencia;
}

// ── 2. FUNCAO (capability) ────────────────────────────────────────────

export const RISCOS = ["baixo", "medio", "alto"] as const;
export type Risco = (typeof RISCOS)[number];

export const ROTULO_RISCO: Record<Risco, string> = {
  baixo: "Risco baixo",
  medio: "Risco médio",
  alto: "Risco alto",
};

/**
 * Algo que o agente pode fazer usando recursos controlados pelo backend.
 *
 * `acesso` separa leitura de escrita porque a diferenca e de natureza,
 * nao de grau: ler vendas errado mostra numero errado; pausar campanha
 * errado gasta dinheiro do cliente. O termo tecnico e `escrita`; o
 * rotulo que o usuario le e "Ação", porque "escrita" descreve o efeito
 * no sistema e "ação" descreve o que ele percebe.
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

export const ROTULO_ACESSO: Record<FuncaoUI["acesso"], { rotulo: string; icone: string }> = {
  leitura: { rotulo: "Leitura", icone: "◎" },
  escrita: { rotulo: "Ação", icone: "▲" },
};

/** `true` quando o sistema sabe executar a funcao hoje. NAO diz nada
 *  sobre este agente poder usa-la — isso e permissao. */
export function funcaoDisponivel(funcao: Pick<FuncaoUI, "procedencia">): boolean {
  return funcao.procedencia === "disponivel";
}

// ── 3. PERMISSAO + 4. AUTONOMIA, num eixo unico ───────────────────────

/**
 * ── Por que UM eixo, e nao `concedida` + `autonomia` ────────────────
 *
 * A primeira versao deste contrato tinha `concedida: boolean` E um campo
 * de autonomia que incluia `"bloqueado"`. Duas formas de dizer a mesma
 * coisa: `{ concedida: false, autonomia: "automatico" }` era
 * representavel e nao significava nada.
 *
 * Dois campos que precisam concordar para sempre acabam discordando —
 * normalmente numa migracao, e normalmente em producao. Agora ha um
 * unico eixo com tres estados mutuamente exclusivos, e "permitida" e
 * DERIVADA por `permitida()`, nunca armazenada em paralelo.
 */
export const NIVEIS_AUTONOMIA = ["bloqueado", "aprovacao", "automatico"] as const;
export type NivelAutonomia = (typeof NIVEIS_AUTONOMIA)[number];

export const VOCABULARIO_NIVEL: Record<
  NivelAutonomia,
  { rotulo: string; explicacao: string; efeito: string }
> = {
  bloqueado: {
    rotulo: "Bloqueado",
    explicacao: "O agente não pode usar esta função, nem pedir autorização.",
    efeito: "A ferramenta não é entregue ao agente — ele não tem como tentar.",
  },
  aprovacao: {
    rotulo: "Exige aprovação",
    explicacao: "O agente pode solicitar, mas a execução espera sua autorização.",
    efeito: "A tarefa para em “aguardando aprovação” e a decisão acontece em Aprovações.",
  },
  automatico: {
    rotulo: "Automático",
    explicacao: "O agente executa sem perguntar.",
    efeito:
      "Continua sujeito à conexão autorizada, às validações do backend e à idempotência da ação.",
  },
};

/**
 * O vinculo entre um agente e uma funcao, com o grau dele.
 *
 * NAO existe campo `concedida`: ver o bloco acima. Se um dia alguem
 * quiser acrescentar, `permitida()` ja responde a pergunta sem
 * armazenar nada.
 */
export interface PermissaoUI {
  funcaoId: string;
  nivel: NivelAutonomia;
  procedencia: Procedencia;
}

/** "Permitida" e derivada, nunca persistida em paralelo ao nivel. */
export function permitida(permissao: Pick<PermissaoUI, "nivel">): boolean {
  return permissao.nivel !== "bloqueado";
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

/**
 * Divida registrada, sem reproduzir valor nenhum.
 *
 * As credenciais das lojas atuais estao em TEXTO PURO no banco. Isso
 * bloqueia "Adicionar conexao", OAuth novo, reconexao pela UI nova e
 * cadastro de integracao. A tela cita esta constante em vez de repetir a
 * frase, para que exista um lugar so a apagar quando a divida cair.
 */
export const DIVIDA_CREDENCIAIS =
  "As credenciais das contas conectadas ainda são guardadas sem criptografia. Enquanto isso não mudar, esta tela não cadastra, não reconecta e não desconecta nada.";
