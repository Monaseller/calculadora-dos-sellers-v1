/**
 * MEMORIA MANUAL DO AGENTE — o contrato puro. AGENT-FACTORY-F6.
 *
 * ── As tres coisas que memoria NAO e ────────────────────────────────
 *
 * NAO e SKILL. Skill e "como o agente executa uma especialidade", tem
 * manifesto, versao e slug, e ja vive em `skills` + `agente_skills`
 * desde a 20260922. F6 REUSA aquilo; nao existe segunda arquitetura de
 * Skill aqui.
 *
 * NAO e FONTE. Fonte e um arquivo que alguem entregou (`agente_fontes`,
 * F5). Memoria e uma frase que alguem escreveu.
 *
 * NAO e HISTORICO DE CONVERSA. O que foi dito no chat fica no chat. Uma
 * frase so vira memoria quando uma PESSOA decide — e a suite prova que
 * conversar nao cria memoria nenhuma.
 *
 * ── Escrita MANUAL, leitura pelo agente ─────────────────────────────
 *
 * O dono cria, edita, ordena, desativa e apaga. O agente LE. Nao existe
 * Function `memoria.criar` no registry, e isso e deliberado: memoria e
 * configuracao do dono, feita pela UI. Um agente que aprende sozinho a
 * partir do que leu numa planilha e um agente que pode ser ensinado por
 * quem escreveu aquela planilha.
 *
 * ── Este modulo e PURO ──────────────────────────────────────────────
 *
 * Sem `server-only`, sem banco. So forma e validacao.
 */

/** Espelha `agente_memorias_conteudo_tamanho`. Ver a migration. */
export const MAX_CONTEUDO_DA_MEMORIA = 2000;
export const MAX_TIPO_DA_MEMORIA = 60;
export const MAX_ORDEM_DA_MEMORIA = 9999;

/**
 * Quantas memorias ativas entram no contexto — e quanto texto.
 *
 * ── Por que ha um teto, e por que estes numeros ─────────────────────
 *
 * Memoria e paga em token a CADA turno, e nao uma vez. Sem teto, uma
 * lista que cresce sozinha encarece toda conversa e vai empurrando a
 * mensagem do usuario para fora da janela — um custo que ninguem
 * percebe subindo.
 *
 * 20 memorias e ~6000 caracteres (~1500 tokens) e o ponto onde duas
 * coisas se encontram: e espaco de sobra para as preferencias que uma
 * pessoa consegue MANTER coerentes, e ja e pouco para caber um
 * documento — quem precisa de documento tem `agente_fontes`.
 *
 * Estourar NAO e erro: as primeiras na ordem do dono entram, e o
 * runtime DECLARA quantas ficaram de fora. Cortar calado seria pior que
 * cortar.
 */
export const MAX_MEMORIAS_ATIVAS_NO_CONTEXTO = 20;
export const MAX_CARACTERES_DE_MEMORIA_NO_CONTEXTO = 6000;

export interface Memoria {
  readonly id: string;
  readonly userId: string;
  readonly agenteId: string;
  readonly conteudo: string;
  readonly tipo: string | null;
  readonly ordem: number;
  readonly ativo: boolean;
  readonly criadoEm: string;
  readonly atualizadoEm: string;
}

export type ResultadoValidacao =
  | { readonly ok: true }
  | { readonly ok: false; readonly codigo: string; readonly mensagem: string };

export interface EntradaDeMemoria {
  readonly conteudo: unknown;
  readonly tipo?: unknown;
  readonly ordem?: unknown;
}

/**
 * Valida o que a PESSOA escreveu.
 *
 * Nao tenta interpretar o texto: memoria e configuracao do dono e ele
 * escreve o que quiser. O que se cobra e forma — nao vazia, dentro do
 * teto, ordem sana.
 */
export function validarEntradaDeMemoria(e: EntradaDeMemoria): ResultadoValidacao {
  if (typeof e.conteudo !== "string" || e.conteudo.trim() === "") {
    return { ok: false, codigo: "conteudo_ausente", mensagem: "A memoria precisa de um conteudo." };
  }
  if (e.conteudo.length > MAX_CONTEUDO_DA_MEMORIA) {
    return {
      ok: false,
      codigo: "conteudo_longo",
      mensagem: `Memoria acima de ${MAX_CONTEUDO_DA_MEMORIA} caracteres. Para documento, use uma fonte.`,
    };
  }
  if (e.tipo !== undefined && e.tipo !== null) {
    if (typeof e.tipo !== "string" || e.tipo.trim() === "" ||
        e.tipo.length > MAX_TIPO_DA_MEMORIA) {
      return { ok: false, codigo: "tipo_invalido", mensagem: "Rotulo invalido." };
    }
  }
  if (e.ordem !== undefined && e.ordem !== null) {
    if (typeof e.ordem !== "number" || !Number.isInteger(e.ordem) ||
        e.ordem < 0 || e.ordem > MAX_ORDEM_DA_MEMORIA) {
      return { ok: false, codigo: "ordem_invalida", mensagem: "Ordem invalida." };
    }
  }
  return { ok: true };
}

/** A forma comparada pelo indice unico da migration. */
export function chaveDeDuplicata(conteudo: string): string {
  return conteudo.trim().toLowerCase();
}

export interface SelecaoDeMemorias {
  readonly incluidas: readonly Memoria[];
  readonly excluidasPorTeto: number;
  readonly caracteres: number;
}

/**
 * Escolhe quais memorias entram no contexto.
 *
 * Ordena pelo que o DONO decidiu (`ordem`, depois data como desempate
 * estavel) e corta no teto. NUNCA por "mais recente ganha": a pessoa
 * editaria uma preferencia antiga e mudaria, sem perceber, qual das
 * duas vale.
 *
 * O que ficou de fora e CONTADO e devolvido, para o runtime poder
 * dizer. Cortar calado e a forma mais facil de um agente parecer
 * teimoso sem ninguem descobrir por que.
 */
export function selecionarMemoriasParaContexto(
  memorias: readonly Memoria[],
  maxItens: number = MAX_MEMORIAS_ATIVAS_NO_CONTEXTO,
  maxCaracteres: number = MAX_CARACTERES_DE_MEMORIA_NO_CONTEXTO
): SelecaoDeMemorias {
  const ativas = memorias.filter((m) => m.ativo);
  const ordenadas = [...ativas].sort((a, b) =>
    a.ordem !== b.ordem ? a.ordem - b.ordem
      : a.criadoEm !== b.criadoEm ? (a.criadoEm < b.criadoEm ? -1 : 1)
      : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const incluidas: Memoria[] = [];
  let caracteres = 0;
  for (const m of ordenadas) {
    if (incluidas.length >= maxItens) break;
    if (caracteres + m.conteudo.length > maxCaracteres) break;
    incluidas.push(m);
    caracteres += m.conteudo.length;
  }
  return { incluidas, excluidasPorTeto: ordenadas.length - incluidas.length, caracteres };
}
