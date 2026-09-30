/**
 * O que impede um agente de ser ATIVADO — F7b.1.
 *
 * ── O carry que este modulo existe para fechar ──────────────────────
 *
 * O F7b.0 provou que `bloqueado` fecha o turno: a Funcao e declarada, o
 * guard nega, o laco para. Mas ficou uma porta aberta pelo outro lado —
 * permissao AUSENTE nao declara a Funcao, e o modelo entao nao a pede, e
 * nao pedir significa responder de cabeca.
 *
 * Para a Funcao ausente nao existe cerca em runtime: nao ha o que negar
 * se ninguem pediu. A cerca tem de ser ANTES, na ativacao:
 *
 *   uma Tool selecionada so pode ir para producao quando TODAS as
 *   Funcoes dela tem estado EXPLICITO — `automatico`, `aprovacao` ou
 *   `bloqueado`.
 *
 * "Bloqueado" e uma resposta valida e deliberada. "Ninguem decidiu" nao
 * e, porque o efeito dela e silencioso.
 *
 * ── Este modulo e PURO ──────────────────────────────────────────────
 *
 * Recebe o estado, devolve a lista de impedimentos. Quem le banco e a
 * rota; quem decide se ativa e ela, com base nisto.
 */
import { estadoDosPacks, type ToolPack } from "@/lib/agentes/factory/catalogo-ui";

export const CODIGOS_DE_IMPEDIMENTO = Object.freeze([
  "nome_ausente",
  "instrucoes_ausentes",
  "modelo_ausente",
  "permissao_incompleta",
  "modelo_incompativel_com_ferramentas",
  /**
   * F7b.4.2 §8 — a IA que o dono escolheu nao esta disponivel.
   *
   * Existe para que o sistema NAO troque de provedor sozinho. Um agente
   * salvo com Gemini nao deve comecar a responder por Claude porque a
   * chave do Google caiu: a resposta viria de outro cerebro, com outro
   * comportamento, e ninguem teria pedido. Bloquear e a unica opcao
   * honesta — quem escolhe outro provedor e o dono.
   */
  "ia_escolhida_indisponivel",
  /**
   * F7b.4.2 §12 — acao externa vinculada e sem nivel decidido.
   *
   * Separado de `permissao_incompleta`, que fala de pack interno: as duas
   * situacoes se resolvem em lugares diferentes da tela, e um codigo so
   * mandaria a pessoa para o lugar errado.
   */
  "ferramenta_externa_sem_permissao",
  /**
   * F7b.4.8 §3/§5 — uma Skill do agente DECLARA precisar de uma Funcao
   * que o agente nao tem.
   *
   * A declaracao e estruturada: `manifesto.requer.funcoes`, validada por
   * `formato.ts`. Nao e keyword parsing do corpo da Skill — §4 e
   * explicito de que texto livre pode SUGERIR, e nunca virar binding.
   *
   * Sem este codigo, a Skill entrava no prompt pedindo um trabalho que o
   * agente nao conseguia fazer, e o dono descobria pela resposta ruim.
   */
  "skill_sem_ferramenta",
  /**
   * F7b.4.8 §6 — a Funcao existe e falta a CONTA/LOJA dela.
   *
   * Separado de `skill_sem_ferramenta` porque resolve-se em outro lugar:
   * lá se adiciona uma ferramenta, aqui se escolhe uma loja que o dono
   * provavelmente ja conectou. Um codigo so mandaria a pessoa ao lugar
   * errado — a mesma razao que separou `ferramenta_externa_sem_permissao`
   * de `permissao_incompleta`.
   */
  "conexao_sem_loja",
] as const);
export type CodigoDeImpedimento = (typeof CODIGOS_DE_IMPEDIMENTO)[number];

export interface Impedimento {
  readonly codigo: CodigoDeImpedimento;
  /** Frase para a tela. Sem codigo, sem id tecnico. */
  readonly mensagem: string;
  /** A etapa do wizard onde se resolve — para a UI poder levar lá. */
  readonly etapa: number;
}

/**
 * Provedores cujo ida-e-volta de ferramenta funciona.
 *
 * Medido, nao presumido: o Gemini aceita a declaracao e emite o pedido,
 * mas devolver o RESULTADO exige `previous_interaction_id`, que exige
 * `store: true` — e `store: false` e regra de privacidade deste
 * repositorio. Enquanto isso nao mudar, um agente COM ferramentas nao
 * pode ir para producao no Google.
 *
 * Sem ferramenta nenhuma, qualquer provedor configurado serve.
 */
export const PROVEDORES_COM_FERRAMENTA = Object.freeze([
  "anthropic",
  // F7b.4 — `store: false` + assinatura preservada. Provado em
  // `scripts/testar-gemini-stateless-live.ts`.
  "google",
  // F7b.4.2 — roundtrip completo com guard, multi-turno e fail-closed.
  // Provado em `scripts/testar-openai-runtime-live.ts`.
  "openai",
] as const);

export interface EstadoParaAtivacao {
  readonly nome: string | null;
  readonly instrucoes: string | null;
  /**
   * O provedor que VAI responder por este agente.
   *
   * Quem o resolve e a rota: se o agente escolheu um e ele esta
   * disponivel, e ele; se o agente nao escolheu, e o default do ambiente.
   * `null` significa que nao ha nenhum.
   */
  readonly provedor: string | null;
  readonly permissoes: readonly { readonly funcaoId: string; readonly nivel: string }[];
  /**
   * O provedor que o dono ESCOLHEU e gravou — F7b.4.2 §8.
   *
   * `null` para agente que nunca escolheu (comportamento preservado). Ele
   * e comparado com `provedoresDisponiveis`, e a divergencia BLOQUEIA em
   * vez de virar uma troca silenciosa.
   */
  readonly provedorEscolhido?: string | null;
  /** Os provedores que este ambiente de fato configurou. */
  readonly provedoresDisponiveis?: readonly string[];
  /**
   * As acoes externas VINCULADAS — F7b.4.2 §12.
   *
   * Vem do vinculo, e nao da permissao: e a diferenca entre "o agente
   * tem" e "o agente pode".
   */
  readonly funcoesExternasVinculadas?: readonly string[];
  /**
   * O que as Skills do agente DECLARAM precisar e nao esta atendido.
   *
   * Vem do diagnostico que a rota compoe — `diagnosticarAgente` —, e nao
   * de uma segunda leitura aqui: este modulo e puro e nao le banco.
   *
   * `bloqueia: false` existe porque o contrato de Skill distingue
   * `funcoes` de `funcoes_opcionais`: faltar uma obrigatoria impede o
   * trabalho; faltar uma opcional so reduz o alcance, e reprovar a
   * ativacao por isso seria barrar um agente util.
   */
  readonly dependenciasDeSkill?: readonly {
    readonly skillId: string;
    /** O nome de gente do que falta. Nunca `funcao_id`. */
    readonly nome: string;
    readonly tipo: "funcao" | "conexao";
    readonly bloqueia: boolean;
  }[];
  /**
   * Requisitos de conexao que EXISTEM e ainda nao tem loja escolhida.
   *
   * Sao `(plataforma, recurso)` sem linha em `agente_conexoes`. O dono
   * pode ja ter a conta: o que falta e dizer QUAL loja — e e por isso que
   * isto nao e "conecte sua conta".
   */
  readonly conexoesSemLoja?: readonly { readonly nome: string }[];
}

export interface ResultadoDaValidacao {
  readonly podeAtivar: boolean;
  readonly impedimentos: readonly Impedimento[];
  /** Packs com Funcao sem estado explicito — a UI mostra "atenção". */
  readonly packsIncompletos: readonly ToolPack[];
  readonly temFerramentas: boolean;
}

export function validarParaAtivacao(estado: EstadoParaAtivacao): ResultadoDaValidacao {
  const impedimentos: Impedimento[] = [];

  if ((estado.nome ?? "").trim() === "") {
    impedimentos.push({
      codigo: "nome_ausente", etapa: 1,
      mensagem: "Dê um nome ao agente.",
    });
  }
  if ((estado.instrucoes ?? "").trim() === "") {
    impedimentos.push({
      codigo: "instrucoes_ausentes", etapa: 2,
      mensagem: "Escreva como este agente deve trabalhar.",
    });
  }
  if ((estado.provedor ?? "").trim() === "") {
    impedimentos.push({
      codigo: "modelo_ausente", etapa: 3,
      mensagem: "Escolha a IA que este agente vai usar.",
    });
  }

  // ── §8: SEM fallback silencioso ──────────────────────────────────
  //
  // Se o dono gravou um provedor e ele nao esta na lista do ambiente, o
  // agente NAO ativa. A alternativa seria responder por outro cerebro sem
  // avisar, e isso e pior que nao responder: o dono configurou
  // instrucoes, nivel e ferramentas pensando num modelo especifico.
  const escolhido = (estado.provedorEscolhido ?? "").trim();
  if (escolhido !== "") {
    const disponiveis = estado.provedoresDisponiveis ?? [];
    if (!disponiveis.includes(escolhido)) {
      impedimentos.push({
        codigo: "ia_escolhida_indisponivel", etapa: 3,
        // Sem nome de env e sem detalhe de credencial: a pessoa precisa
        // saber que a escolha dela nao esta funcionando, nao como o
        // ambiente e montado.
        mensagem: "A IA escolhida para este agente não está disponível agora. " +
          "Escolha outra para continuar.",
      });
    }
  }

  const packs = estadoDosPacks(estado.permissoes);
  const selecionados = packs.filter((p) => p.selecionado);
  const incompletos = selecionados.filter((p) => !p.completo);
  // Acao externa TAMBEM e ferramenta: um agente que so tem Google Sheets
  // precisa de provedor compativel igual a um que tem Planilhas.
  const temFerramentas =
    selecionados.length > 0 || (estado.funcoesExternasVinculadas ?? []).length > 0;

  if (incompletos.length > 0) {
    // Uma frase, nomeando as Tools. Nao lista `funcao_id`: a pessoa
    // escolheu "Planilhas", e e disso que ela precisa ser avisada.
    const nomes = incompletos.map((p) => p.pack.nome).join(", ");
    impedimentos.push({
      codigo: "permissao_incompleta", etapa: 8,
      mensagem: `Configure as permissões antes de ativar: ${nomes}.`,
    });
  }

  // ── §12: vinculada e sem permissao BARRA a ativacao ──────────────
  //
  // O estado "o agente tem esta acao e ninguem decidiu como ele pode
  // usa-la" e exatamente o que o F7b.4.1 nao conseguia representar,
  // porque vincular gravava permissao. Agora ele existe, e barra.
  //
  // `bloqueado` conta como DECIDIDO, como no resto da area: negar e uma
  // resposta, e ha cerca em runtime para ela. "Ninguem decidiu" nao e.
  const externas = estado.funcoesExternasVinculadas ?? [];
  if (externas.length > 0) {
    const comNivel = new Set(
      estado.permissoes.filter((p) => p.nivel.trim() !== "").map((p) => p.funcaoId));
    const semDecisao = externas.filter((id) => !comNivel.has(id));
    if (semDecisao.length > 0) {
      impedimentos.push({
        codigo: "ferramenta_externa_sem_permissao", etapa: 8,
        mensagem: semDecisao.length === 1
          ? "Uma ação de aplicativo ainda não tem permissão definida."
          : `${semDecisao.length} ações de aplicativos ainda não têm permissão definida.`,
      });
    }
  }

  // ── §3/§5: a Skill declarou, e o agente nao tem ─────────────────
  //
  // Uma frase por Skill, nomeando o que falta. A etapa 4 e Ferramentas:
  // e la que se adiciona, e o cartao do §5 aparece nela.
  const dependencias = (estado.dependenciasDeSkill ?? []).filter((d) => d.bloqueia);
  if (dependencias.length > 0) {
    const nomes = [...new Set(dependencias.map((d) => d.nome))].join(", ");
    impedimentos.push({
      codigo: "skill_sem_ferramenta", etapa: 4,
      mensagem: dependencias.length === 1
        ? `Uma Skill deste agente precisa de ${nomes}.`
        : `As Skills deste agente precisam de: ${nomes}.`,
    });
  }

  // ── §6: a ferramenta esta la, e falta dizer de qual loja ────────
  const semLoja = estado.conexoesSemLoja ?? [];
  if (semLoja.length > 0) {
    const nomes = [...new Set(semLoja.map((c) => c.nome))].join(", ");
    impedimentos.push({
      codigo: "conexao_sem_loja", etapa: 4,
      mensagem: semLoja.length === 1
        ? `Escolha a loja que este agente vai usar em ${nomes}.`
        : `Escolha as lojas que este agente vai usar em: ${nomes}.`,
    });
  }

  if (temFerramentas && estado.provedor !== null &&
      !(PROVEDORES_COM_FERRAMENTA as readonly string[]).includes(estado.provedor)) {
    impedimentos.push({
      codigo: "modelo_incompativel_com_ferramentas", etapa: 3,
      // Sem `store:false`, sem Interactions API, sem nome de adaptador.
      mensagem: "Este modelo ainda não é compatível com todas as ferramentas selecionadas.",
    });
  }

  return {
    podeAtivar: impedimentos.length === 0,
    impedimentos,
    packsIncompletos: incompletos.map((p) => p.pack),
    temFerramentas,
  };
}
