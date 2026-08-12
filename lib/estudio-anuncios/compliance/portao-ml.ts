/**
 * PORTÃO DE PUBLICAÇÃO do Mercado Livre — política pura (2026-08-25).
 *
 * Separado de `validacao-oficial.ts` de propósito: aqui não há cliente
 * HTTP, nem Supabase, nem variável de ambiente. O portão é a regra mais
 * crítica do módulo — um futuro `POST /items` passa por ele — e precisa
 * ser testável sem infraestrutura, sem rede e sem credencial.
 */
import type { ComplianceUI } from "./compliance";
import { podePublicarMarketplace } from "./registry";

/** Um problema apontado pelo Mercado Livre, com o código OFICIAL. */
export interface ProblemaML {
  codigo: string;
  mensagem: string;
  campo: string | null;
  tipo: string | null;
}

export type StatusValidacaoOficial =
  | "validado"
  | "validado_com_alertas"
  | "bloqueado"
  /** Não é veredito sobre o payload: é falha de conversa com o ML. */
  | "erro_comunicacao";

export interface ValidacaoOficialUI {
  id: string;
  marketplace: string;
  status: StatusValidacaoOficial;
  httpStatus: number | null;
  hashPayload: string;
  versaoConstrutor: number;
  erros: ProblemaML[];
  alertas: ProblemaML[];
  criadoEm: string;
  lojaId: string | null;
  /** `true` quando o payload mudou depois desta validação. */
  desatualizada: boolean;
}

export interface RespostaParaStatus {
  /** O ML respondeu 200/204 — sucesso no protocolo. */
  aceito: boolean;
  erros: ProblemaML[];
  alertas: ProblemaML[];
  /**
   * `true` só quando a resposta é o envelope de validação CONHECIDO —
   * `error: "validation_error"` com um `cause` que deu para interpretar.
   * É esta flag que autoriza tratar um HTTP 400 como parecer semântico
   * em vez de falha; sem ela, 400 é 400.
   */
  envelopeValidacaoConhecido: boolean;
}

/**
 * Deriva o status a partir do que o ML respondeu.
 *
 * A CORREÇÃO DE 2026-08-30, e é o ponto inteiro desta função: **o código
 * HTTP do validador não é o veredito.** O `/items/validate` responde
 * `400 validation_error` sempre que tem algo a dizer — inclusive quando
 * esse algo são apenas `warning`s. A versão anterior fazia
 * `if (!aceito) return "bloqueado"`, o que transformava "validado com
 * dois avisos informativos" em "bloqueado" e mantinha o portão fechado
 * sem nenhum erro existir.
 *
 * A documentação oficial separa os dois tipos: `error` exige alterar o
 * JSON; `warning` é informativo e não impede publicar.
 *
 * A exceção ao 400 é ESTREITA de propósito: só vale para o envelope
 * conhecido e interpretado, e só quando não sobrou nenhuma causa
 * bloqueante. Qualquer 400 fora desse formato continua sendo tratado
 * como problema — nunca como aprovação.
 */
export function derivarStatusOficial(r: RespostaParaStatus): StatusValidacaoOficial {
  // Erro é erro, venha em resposta aceita ou recusada.
  if (r.erros.length > 0) return "bloqueado";

  if (r.aceito) return r.alertas.length > 0 ? "validado_com_alertas" : "validado";

  // Recusado, sem nenhum erro: só pode ser o caso conhecido de
  // warnings-only. Fora dele, não se sabe o que aconteceu — e "não sei"
  // nunca vira aprovação.
  if (r.envelopeValidacaoConhecido && r.alertas.length > 0) return "validado_com_alertas";

  return "bloqueado";
}

export interface ContextoPortaoML {
  compliance: ComplianceUI | null | undefined;
  validacao: ValidacaoOficialUI | null | undefined;
  lojaId: string | null | undefined;
  hashPayloadAtual: string | null;
}

/**
 * Só `true` com: conteúdo aprovado, compliance corrente e publicável,
 * loja vinculada, validação oficial corrente (hash igual ao payload de
 * agora) e sem erro bloqueante.
 *
 * `erro_comunicacao` NÃO libera: não saber o que o Mercado Livre acha não
 * é o mesmo que ele ter aprovado.
 */
export function podePublicarMercadoLivre(ctx: ContextoPortaoML): boolean {
  const { compliance, validacao, lojaId, hashPayloadAtual } = ctx;
  if (!lojaId) return false;
  if (!compliance || compliance.desatualizado) return false;
  if (!podePublicarMarketplace(compliance.resultado, compliance.desatualizado)) return false;
  if (!validacao || validacao.desatualizada) return false;
  if (validacao.status !== "validado" && validacao.status !== "validado_com_alertas") return false;
  if (validacao.erros.length > 0) return false;
  // O payload não pode ter mudado depois da validação.
  if (!hashPayloadAtual || validacao.hashPayload !== hashPayloadAtual) return false;
  return true;
}

/** Motivo legível de por que ainda não dá para publicar no ML. */
export function motivoNaoPublicavelML(ctx: ContextoPortaoML): string | null {
  if (podePublicarMercadoLivre(ctx)) return null;
  const { compliance, validacao, lojaId, hashPayloadAtual } = ctx;
  if (!lojaId) return "Nenhuma conta do Mercado Livre vinculada a este canal.";
  if (!compliance) return "Este canal ainda não passou pela pré-publicação.";
  if (compliance.desatualizado) return "O parecer de pré-publicação está desatualizado.";
  if (!podePublicarMarketplace(compliance.resultado, compliance.desatualizado)) {
    return "A pré-publicação ainda tem pendências.";
  }
  if (!validacao) return "Este payload ainda não foi validado no Mercado Livre.";
  if (validacao.desatualizada || (hashPayloadAtual && validacao.hashPayload !== hashPayloadAtual)) {
    return "Os dados mudaram depois da validação oficial. Valide de novo no Mercado Livre.";
  }
  if (validacao.status === "erro_comunicacao") {
    return "Não foi possível falar com o Mercado Livre na última tentativa.";
  }
  if (validacao.erros.length > 0) {
    return `O Mercado Livre apontou ${validacao.erros.length} problema(s) no anúncio.`;
  }
  return "Validação oficial pendente.";
}
