/**
 * O RUNTIME de chat do agente — AGENT-FACTORY-F7a.
 *
 * ── O caminho inteiro, num lugar so ─────────────────────────────────
 *
 *   sessao -> dono -> agente do dono
 *          -> Skills + memorias + fontes + permissoes (estado de AGORA)
 *          -> contexto (F6)
 *          -> historico da CONVERSA
 *          -> provedor real
 *          -> laco de ferramentas (F2)
 *          -> executarFuncao -> guard -> Funcao -> auditoria
 *          -> persistencia da conversa
 *
 * Esta camada NAO decide autorizacao e NAO executa Funcao: ela costura.
 * Quem autoriza continua sendo `executarFuncao`, e o laco continua
 * conhecendo uma porta so. A suite reprova se este arquivo importar
 * `autorizarFuncao` ou alcançar `definicao.executor`.
 *
 * ── Por que a configuracao e lida A CADA turno ──────────────────────
 *
 * Skills, memorias, fontes e permissoes sao carregadas na hora, e nao
 * guardadas na conversa. O dono pode tirar uma Skill, desativar uma
 * memoria ou bloquear uma ferramenta no meio de um chat — e o turno
 * seguinte tem de obedecer. Congelar isso na abertura faria uma
 * conversa antiga continuar com poderes que ja foram removidos.
 *
 * ── O que a conversa guarda, e o que ela nao guarda ─────────────────
 *
 * Guarda: o que foi dito, em ordem, com a proveniencia das ferramentas.
 * NAO guarda: instrucao, Skill, memoria, fonte — nada disso vira linha
 * de mensagem. Historico e assunto; configuracao e do agente.
 */
import "server-only";

import { lerAgenteDoDono } from "@/lib/agentes/capability";
import { declararFerramentas } from "@/lib/agentes/ia/ferramentas";
import type { MensagemDoDialogo } from "@/lib/agentes/ia/ferramentas";
import {
  conversarComFerramentas, type ResultadoDoLaco,
} from "@/lib/agentes/ia/laco-ferramentas";
import { montarContextoDoAgente } from "@/lib/agentes/ia/contexto-do-agente";
import { chamarClaudeComFerramentas } from "@/lib/ai-gateway/provedores/anthropic-ferramentas";
import { FUNCOES } from "@/lib/agentes/funcoes/registry";
import { resolverFatosPermissoes } from "@/lib/agentes/permissoes/fatos";
import { resolverSkillsDoAgente } from "@/lib/agentes/skills/fatos";
import { criarPortaDeFontes } from "@/lib/agentes/fontes/repositorio";
import { criarPortaDeMemorias } from "@/lib/agentes/memorias/repositorio";
import { criarFonteDeArquivoDasSources } from "@/lib/agentes/fontes/resolvedor";
import { registrarFonteDeArquivo } from "@/lib/agentes/funcoes/planilha";
import { paraModelo } from "@/lib/agentes/fontes/tipos";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import {
  criarPortaDeConversas, type PortaDeConversas,
} from "@/lib/agentes/conversas/repositorio";
import {
  recortarHistorico, validarMensagemDoUsuario, type Mensagem, type PassoRegistrado,
} from "@/lib/agentes/conversas/tipos";

export interface EntradaDoTurno {
  /** Da SESSAO. Nunca do corpo do pedido. */
  readonly userId: string;
  readonly agenteId: string;
  readonly conversaId: string;
  readonly texto: string;
}

export type ResultadoDoTurno =
  | {
      readonly ok: true;
      readonly mensagemDoUsuario: Mensagem;
      readonly resposta: Mensagem;
      readonly motivo: ResultadoDoLaco["motivo"];
      readonly historicoTruncado: number;
    }
  | { readonly ok: false; readonly codigo: string; readonly mensagem: string };

function falha(codigo: string, mensagem: string): ResultadoDoTurno {
  return { ok: false, codigo, mensagem };
}

/**
 * Executa UM turno.
 *
 * Tudo que pode recusar, recusa ANTES de gastar token: mensagem
 * invalida, agente de outro dono, conversa de outro agente. Chamar o
 * provedor para depois descobrir que o dono esta errado seria pagar
 * pela propria falha de autorizacao.
 */
export async function responderNaConversa(
  entrada: EntradaDoTurno,
  portaConversas: PortaDeConversas = criarPortaDeConversas(getSupabaseServidor())
): Promise<ResultadoDoTurno> {
  const v = validarMensagemDoUsuario(entrada.texto);
  if (!v.ok) return falha(v.codigo, v.mensagem);

  const { linha: agente, erro } = await lerAgenteDoDono(entrada.agenteId, entrada.userId);
  if (erro) return falha("indisponivel", "Nao foi possivel carregar o agente.");
  // "nao existe" e "nao e seu" respondem IGUAL: distinguir viraria um
  // oraculo para descobrir agentes alheios.
  if (!agente) return falha("agente_nao_encontrado", "Agente nao encontrado.");

  const conversa = await portaConversas.obterConversa(entrada.userId, entrada.conversaId);
  if (!conversa || conversa.agenteId !== entrada.agenteId) {
    return falha("conversa_nao_encontrada", "Conversa nao encontrada.");
  }

  // ── Estado de AGORA ────────────────────────────────────────────────
  const db = getSupabaseServidor();
  const portaFontes = criarPortaDeFontes(db);
  const portaMemorias = criarPortaDeMemorias(db);

  const [permissoes, skills, memorias, fontes, historico] = await Promise.all([
    // `funcaoIds` = o CATALOGO INTEIRO, e nao um subconjunto: a
    // pergunta e "o que este agente pode", e perguntar so sobre
    // algumas Funcoes devolveria uma resposta que parece completa.
    resolverFatosPermissoes({
      userId: entrada.userId,
      agenteId: entrada.agenteId,
      funcaoIds: Object.keys(FUNCOES),
    }),
    resolverSkillsDoAgente({ userId: entrada.userId, agenteId: entrada.agenteId }),
    portaMemorias.listarAtivas(entrada.userId, entrada.agenteId),
    portaFontes.listarDoAgente(entrada.userId, entrada.agenteId),
    portaConversas.listarMensagens(entrada.userId, entrada.conversaId),
  ]);

  // Falha de leitura NAO vira "este agente nao tem permissao nenhuma":
  // seria degradar silenciosamente para o caso mais restritivo e o
  // usuario veria "ferramenta indisponivel" sem causa.
  if (permissoes.coleta !== "ok") {
    return falha("indisponivel", "Nao foi possivel carregar as permissoes do agente.");
  }
  if (skills.coleta !== "ok") {
    return falha("indisponivel", "Nao foi possivel carregar as Skills do agente.");
  }

  const contexto = montarContextoDoAgente({
    instrucoesDoAgente: agente.instrucoes,
    skills: skills.skills,
    memorias,
    fontes: fontes.map(paraModelo),
  });

  const ferramentas = declararFerramentas({
    catalogo: FUNCOES,
    permissoes: permissoes.fatos.map((p) => ({ funcaoId: p.funcaoId, nivel: p.nivel })),
  });

  // O resolvedor de arquivo vive por CHAMADA e carrega dono e agente
  // fechados. Registrar aqui e o que faz `planilha.*` enxergar as
  // fontes deste agente — e SO as dele.
  registrarFonteDeArquivo(criarFonteDeArquivoDasSources({
    porta: portaFontes,
    userId: entrada.userId,
    agenteId: entrada.agenteId,
    conversaId: entrada.conversaId,
  }));

  const recorte = recortarHistorico(historico);
  const dialogo: MensagemDoDialogo[] = recorte.incluidas.map((m) =>
    m.papel === "usuario"
      ? { papel: "usuario" as const, texto: m.conteudo }
      : { papel: "assistente" as const, texto: m.conteudo, pedidos: [] });

  // A mensagem do usuario e gravada ANTES da chamada. Se o provedor
  // cair, o que a pessoa escreveu nao se perde — e a conversa mostra a
  // pergunta sem resposta, que e a verdade do que aconteceu.
  const gravadaDoUsuario = await portaConversas.anexarMensagem({
    userId: entrada.userId, conversaId: entrada.conversaId,
    papel: "usuario", conteudo: entrada.texto.trim(),
  });

  let saida: ResultadoDoLaco;
  try {
    saida = await conversarComFerramentas({
      userId: entrada.userId,
      agenteId: entrada.agenteId,
      instrucao: contexto.instrucao,
      mensagemDoUsuario: entrada.texto.trim(),
      historico: dialogo,
      ferramentas,
      adaptador: chamarClaudeComFerramentas,
    });
  } catch (e) {
    // Mensagem de provedor NAO sobe crua: ela pode citar cabecalho,
    // corpo e ate credencial. O detalhe fica no log do servidor.
    console.error("[conversas/runtime] falha do provedor:",
      String((e as Error).message).slice(0, 300));
    return falha("provedor_indisponivel", "Nao foi possivel falar com a IA agora.");
  }

  const passos: PassoRegistrado[] = saida.passos.map((p) => ({
    funcaoId: p.funcaoId, desfecho: p.desfecho, executou: p.executou, requestId: p.requestId,
  }));

  const resposta = await portaConversas.anexarMensagem({
    userId: entrada.userId, conversaId: entrada.conversaId,
    papel: "assistente",
    // `texto` e null quando o laco bate o teto de passos. Guardar string
    // vazia quebraria o CHECK, e guardar "null" enganaria quem le.
    conteudo: saida.texto ?? "Nao consegui concluir esta resposta.",
    passos,
    provedor: saida.uso.provedor,
    modelo: saida.uso.modelo,
    tokensEntrada: saida.uso.tokensEntrada,
    tokensSaida: saida.uso.tokensSaida,
    tempoMs: saida.uso.tempoMs,
  });

  return {
    ok: true,
    mensagemDoUsuario: gravadaDoUsuario,
    resposta,
    motivo: saida.motivo,
    historicoTruncado: recorte.excluidasPorTeto,
  };
}
