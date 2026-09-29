/**
 * Servicos de memoria para a futura UI — AGENT-FACTORY-F6.
 *
 * ── Quem e o dono NAO vem do chamador externo ───────────────────────
 *
 * `userId` e parametro, e isso NAO significa que a rota possa aceita-lo
 * do cliente. A regra do projeto vale: a rota deriva o dono da SESSAO e
 * so entao chama daqui. A assinatura obriga que alguem tenha decidido
 * quem e o dono antes; a FK composta da migration e a rede embaixo, para
 * o caso de alguem decidir errado.
 *
 * ── O agente nao alcanca este modulo ────────────────────────────────
 *
 * Nenhuma Function do registry importa isto, e a suite reprova se
 * importar. Memoria e configuracao do dono: ela entra pela UI, nunca
 * por uma conversa.
 */
import "server-only";

import type {
  AlteracaoDeMemoria,
  PortaDeMemorias,
} from "@/lib/agentes/memorias/repositorio";
import type { Memoria } from "@/lib/agentes/memorias/tipos";
import { validarEntradaDeMemoria } from "@/lib/agentes/memorias/tipos";

export type ResultadoDeMemoria =
  | { readonly ok: true; readonly memoria: Memoria }
  | { readonly ok: false; readonly codigo: string; readonly mensagem: string };

export type ResultadoSimples =
  | { readonly ok: true }
  | { readonly ok: false; readonly codigo: string; readonly mensagem: string };

export interface EntradaCriarMemoria {
  readonly userId: string;
  readonly agenteId: string;
  readonly conteudo: unknown;
  readonly tipo?: unknown;
  readonly ordem?: unknown;
}

export async function criarMemoria(
  porta: PortaDeMemorias,
  entrada: EntradaCriarMemoria
): Promise<ResultadoDeMemoria> {
  const v = validarEntradaDeMemoria(entrada);
  if (!v.ok) return { ok: false, codigo: v.codigo, mensagem: v.mensagem };
  try {
    return {
      ok: true,
      memoria: await porta.criar({
        userId: entrada.userId,
        agenteId: entrada.agenteId,
        conteudo: (entrada.conteudo as string).trim(),
        tipo: typeof entrada.tipo === "string" ? entrada.tipo.trim() : null,
        ordem: typeof entrada.ordem === "number" ? entrada.ordem : 0,
      }),
    };
  } catch (e) {
    // O indice unico da migration recusa duplicata EXATA. Isso nao e
    // erro de sistema: e a pessoa mandando de novo o que ja esta la, e
    // ela merece uma frase que explique.
    const msg = String((e as Error).message);
    if (/duplicat|unique|23505/i.test(msg)) {
      return {
        ok: false,
        codigo: "memoria_duplicada",
        mensagem: "Este agente ja tem uma memoria com exatamente esse conteudo.",
      };
    }
    return { ok: false, codigo: "falha_ao_persistir", mensagem: "Nao foi possivel salvar." };
  }
}

export async function listarMemorias(
  porta: PortaDeMemorias, userId: string, agenteId: string,
  opcoes: { readonly somenteAtivas?: boolean } = {}
): Promise<readonly Memoria[]> {
  return opcoes.somenteAtivas
    ? porta.listarAtivas(userId, agenteId)
    : porta.listarTodas(userId, agenteId);
}

export async function atualizarMemoria(
  porta: PortaDeMemorias, userId: string, agenteId: string,
  memoriaId: string, mudanca: AlteracaoDeMemoria
): Promise<ResultadoDeMemoria> {
  if (mudanca.conteudo !== undefined || mudanca.tipo !== undefined ||
      mudanca.ordem !== undefined) {
    const v = validarEntradaDeMemoria({
      conteudo: mudanca.conteudo ?? "placeholder-nao-vazio",
      tipo: mudanca.tipo, ordem: mudanca.ordem,
    });
    if (!v.ok) return { ok: false, codigo: v.codigo, mensagem: v.mensagem };
  }
  try {
    const m = await porta.atualizar(userId, agenteId, memoriaId, mudanca);
    // `null` = nao existe OU nao e deste dono/agente. As duas respondem
    // igual de proposito: distinguir viraria um oraculo para descobrir
    // ids alheios.
    return m === null
      ? { ok: false, codigo: "memoria_nao_encontrada", mensagem: "Memoria nao encontrada." }
      : { ok: true, memoria: m };
  } catch {
    return { ok: false, codigo: "falha_ao_persistir", mensagem: "Nao foi possivel salvar." };
  }
}

/** Ligar/desligar sem apagar. O caminho que a UI usa no dia a dia. */
export async function definirAtivoDaMemoria(
  porta: PortaDeMemorias, userId: string, agenteId: string,
  memoriaId: string, ativo: boolean
): Promise<ResultadoDeMemoria> {
  return atualizarMemoria(porta, userId, agenteId, memoriaId, { ativo });
}

export async function removerMemoria(
  porta: PortaDeMemorias, userId: string, agenteId: string, memoriaId: string
): Promise<ResultadoSimples> {
  try {
    return (await porta.remover(userId, agenteId, memoriaId))
      ? { ok: true }
      : { ok: false, codigo: "memoria_nao_encontrada", mensagem: "Memoria nao encontrada." };
  } catch {
    return { ok: false, codigo: "falha_ao_persistir", mensagem: "Nao foi possivel remover." };
  }
}
