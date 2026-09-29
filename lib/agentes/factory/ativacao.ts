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
export const PROVEDORES_COM_FERRAMENTA = Object.freeze(["anthropic"] as const);

export interface EstadoParaAtivacao {
  readonly nome: string | null;
  readonly instrucoes: string | null;
  readonly provedor: string | null;
  readonly permissoes: readonly { readonly funcaoId: string; readonly nivel: string }[];
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

  const packs = estadoDosPacks(estado.permissoes);
  const selecionados = packs.filter((p) => p.selecionado);
  const incompletos = selecionados.filter((p) => !p.completo);
  const temFerramentas = selecionados.length > 0;

  if (incompletos.length > 0) {
    // Uma frase, nomeando as Tools. Nao lista `funcao_id`: a pessoa
    // escolheu "Planilhas", e e disso que ela precisa ser avisada.
    const nomes = incompletos.map((p) => p.pack.nome).join(", ");
    impedimentos.push({
      codigo: "permissao_incompleta", etapa: 8,
      mensagem: `Configure as permissões antes de ativar: ${nomes}.`,
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
