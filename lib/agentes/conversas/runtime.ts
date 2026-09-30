/**
 * O RUNTIME de chat do agente — AGENT-FACTORY-F7a.
 *
 * ── O caminho inteiro, num lugar so ─────────────────────────────────
 *
 *   sessao -> dono -> agente do dono
 *          -> Skills + memorias + fontes + permissoes (estado de AGORA)
 *          -> contexto (F6)
 *          -> historico da CONVERSA
 *          -> a IA DO AGENTE (F7b.4.2) -> provedor real
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
 *
 * ── Quem responde, e por que nunca e um substituto — F7b.4.2 ────────
 *
 * O adaptador vem da coluna `provedor_ia` do AGENTE, e nao de uma
 * constante importada no topo. Isso e o §7.
 *
 * E quando a escolha nao esta disponivel, o turno e RECUSADO — §8. Nao ha
 * "tenta a Anthropic": a resposta viria de outro cerebro, com outro
 * comportamento diante das mesmas instrucoes, e ninguem teria pedido. O
 * dono ve `ia_indisponivel` e escolhe outra IA, que e uma decisao dele.
 *
 * Agente que nunca escolheu segue com o default do ambiente — e o
 * comportamento que ele sempre teve, preservado de proposito.
 */
import "server-only";

import { lerAgenteDoDono } from "@/lib/agentes/capability";
import { declararFerramentas } from "@/lib/agentes/ia/ferramentas";
import type { MensagemDoDialogo } from "@/lib/agentes/ia/ferramentas";
import {
  conversarComFerramentas, type ResultadoDoLaco,
} from "@/lib/agentes/ia/laco-ferramentas";
import { montarContextoDoAgente } from "@/lib/agentes/ia/contexto-do-agente";
import { adaptadorDoProvedor } from "@/lib/agentes/ia/adaptador-por-provedor";
import { modelosDisponiveis } from "@/lib/agentes/factory/catalogo-de-modelos";
import { resolverIaDoAgente } from "@/lib/agentes/factory/ia-do-agente";
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

  // ── Qual IA responde por ESTE agente — F7b.4.2 §7/§8 ──────────────
  //
  // Resolvido ANTES de ler Skills, memorias e historico: recusar por IA
  // indisponivel nao precisa de nenhuma dessas leituras, e fazer quatro
  // consultas para depois desistir seria cobrar pelo proprio impedimento.
  const ia = resolverIaDoAgente({
    provedorGravado: agente.provedor_ia,
    modeloGravado: agente.modelo_ia,
    nivelGravado: agente.nivel_de_trabalho,
    disponiveis: modelosDisponiveis(),
  });
  const adaptador = adaptadorDoProvedor(ia.provedor);
  if (adaptador === null) {
    // Uma mensagem so para os dois casos, porque para quem esta no chat a
    // situacao e a mesma: a IA deste agente nao esta respondendo. O
    // detalhe de QUAL esta na tela de configuracao, via `iaDesfecho`.
    //
    // Sem nome de env e sem nome de provedor: o chat nao e o lugar de
    // ensinar como o ambiente e montado.
    return falha("ia_indisponivel",
      "A IA configurada para este agente nao esta disponivel agora.");
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

  // ── As acoes EXTERNAS ainda nao sao declaradas — F7b.4.2 ──────────
  //
  // `declararFerramentas` ja aceita `externas`, e o filtro que sustenta o
  // §13 esta pronto e provado (`scripts/testar-ferramentas-externas.ts`:
  // vinculo removido + permissao historica => NAO declarada). O que falta
  // para ligar aqui nao e o filtro:
  //
  //   1. NAO HA EXECUTOR. Uma acao do Composio nao tem entrada em
  //      `FUNCOES`, e portanto nao tem `executor`. Declarar uma ferramenta
  //      que o modelo pede e que ninguem sabe executar transformaria toda
  //      chamada numa falha de ferramenta.
  //   2. NAO HA CONTA CONECTADA. Sem o OAuth concluido pelo dono, a acao
  //      nao teria credencial para rodar nem se houvesse executor.
  //
  // Declarar antes disso seria prometer ao modelo uma capacidade que o
  // sistema nao tem — o oposto de "nunca inventar dado".
  //
  // O comportamento de HOJE, e por que ele e seguro: uma acao externa nao
  // esta em `FUNCOES`, entao `resolverFatosPermissoes` a devolve com
  // `existe: false`, e o guard NEGA qualquer pedido dela. Fail-closed, sem
  // caminho de execucao, mesmo que um id externo apareca numa permissao.
  const ferramentas = declararFerramentas({
    catalogo: FUNCOES,
    permissoes: permissoes.fatos.map((p) => ({ funcaoId: p.funcaoId, nivel: p.nivel })),
    externas: [],
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
      // `null` = o default do adaptador. Ver `resolverIaDoAgente`: um
      // nivel gravado que o provedor nao oferece vira `null` em vez de
      // ser enviado e recusado pela API.
      nivelDeTrabalho: ia.nivel ?? undefined,
      adaptador,
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
