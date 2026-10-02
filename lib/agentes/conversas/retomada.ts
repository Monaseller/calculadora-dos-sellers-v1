import "server-only";

/**
 * Retomar o turno depois da decisao humana — AGENT-FACTORY-F7b.4.4.
 *
 * ── O defeito que este modulo corrige ───────────────────────────────
 *
 * O Rodrigo encontrou no Preview: o agente pediu aprovacao, ele aprovou,
 * e o chat ficou parado. Reperguntar pedia aprovacao de novo, em ciclo.
 *
 * A causa nao era visual. Eram tres coisas, e as tres eram de backend:
 *
 *   1. `decidirAprovacao` MARCA o estado e nao faz mais nada. Nao havia
 *      caminho de volta para a conversa.
 *   2. A aprovacao nao guardava `conversa_id` nem o id do pedido do
 *      modelo, entao nao havia como saber a QUAL turno voltar.
 *   3. `retomarAprovacao` existia — executa a Funcao congelada, de forma
 *      atomica — mas nao tinha chamador nenhum em producao, e nao produz
 *      a resposta final do agente.
 *
 * A quarta consequencia era a que o Rodrigo via: o cartao do chat mandava
 * para `/ia/aprovacoes`, outra pagina. Sair da pagina e o que "apagava" as
 * mensagens. Nada as apagou — a tela foi desmontada.
 *
 * ── O que este modulo faz, na ordem ─────────────────────────────────
 *
 *   le a aprovacao (dono, conversa, pedido congelado)
 *   -> `retomarAprovacao` CONSOME e executa, atomicamente
 *   -> remonta o dialogo ate o pedido pendente
 *   -> chama o modelo UMA vez com o resultado da ferramenta
 *   -> grava a resposta final NA MESMA conversa
 *
 * O usuario nao reescreve nada. A mensagem dele ja esta gravada desde o
 * turno original, e nao e reenviada.
 *
 * ── Por que nao reexecutar o turno do zero ──────────────────────────
 *
 * Seria mais simples chamar `responderNaConversa` de novo com a mesma
 * pergunta. E estaria errado: o modelo poderia pedir OUTRA Funcao, ou a
 * mesma com outros argumentos, e aí a aprovacao que o dono deu nao
 * corresponderia ao que ia rodar. Pior, o guard pediria aprovacao de novo
 * e nasceria a "aprovacao Y" que o §8 proibe.
 *
 * Aqui roda exatamente a chamada que foi aprovada, com os argumentos
 * congelados na criacao da aprovacao. A autorizacao vale para AQUELA
 * execucao, e para nenhuma outra.
 *
 * ── Idempotencia: ela ja existia, e nao foi reinventada ─────────────
 *
 * `consumirAprovacaoEAbrir` consome a aprovacao E abre a chamada na MESMA
 * transacao. Dois cliques correndo juntos: o primeiro vence, o segundo
 * recebe `ja_consumida` e NAO executa. Nao ha contador novo, nao ha trava
 * nossa, nao ha janela entre "conferir" e "gravar" — quem garante e o
 * banco, que e o unico que roda em transacao.
 */
import { lerAgenteDoDono } from "@/lib/agentes/capability";
import {
  lerAprovacaoDaConversaParaRetomada,
} from "@/lib/agentes/aprovacoes/persistencia";
import { retomarAprovacao } from "@/lib/agentes/execucao-funcoes/executar";
import { conversarComFerramentas } from "@/lib/agentes/ia/laco-ferramentas";
import { declararFerramentas } from "@/lib/agentes/ia/ferramentas";
import { FUNCOES } from "@/lib/agentes/funcoes/registry";
import type { DefinicaoFuncao } from "@/lib/agentes/funcoes/registry";
import {
  prepararFuncoesExternas, type ExternasPreparadas,
} from "@/lib/agentes/composio/preparar-externas";
import { listarVinculosExternos } from "@/lib/agentes/ferramentas-externas/repositorio";
import { listarPermissoesGravadas } from "@/lib/agentes/permissoes/gravadas";
import { adaptadorDoProvedor } from "@/lib/agentes/ia/adaptador-por-provedor";
import { modelosDisponiveis } from "@/lib/agentes/factory/catalogo-de-modelos";
import { resolverIaDoAgente } from "@/lib/agentes/factory/ia-do-agente";
import { montarContextoDoAgente } from "@/lib/agentes/ia/contexto-do-agente";
import { resolverSkillsDoAgente } from "@/lib/agentes/skills/fatos";
import { criarPortaDeFontes } from "@/lib/agentes/fontes/repositorio";
import { criarPortaDeMemorias } from "@/lib/agentes/memorias/repositorio";
import { paraModelo } from "@/lib/agentes/fontes/tipos";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import {
  criarPortaDeConversas, type PortaDeConversas,
} from "@/lib/agentes/conversas/repositorio";
import {
  apresentacaoDoPasso, recortarHistorico, type Mensagem, type PassoRegistrado,
} from "@/lib/agentes/conversas/tipos";
import type { MensagemDoDialogo } from "@/lib/agentes/ia/ferramentas";

export interface EntradaDaRetomada {
  /** Da SESSAO. Nunca do corpo do pedido. */
  readonly userId: string;
  readonly aprovacaoId: string;
}

export type ResultadoDaRetomada =
  | {
      readonly ok: true;
      readonly conversaId: string;
      readonly resposta: Mensagem;
      /** `true` quando a Funcao aprovada de fato rodou agora. */
      readonly executou: boolean;
    }
  | { readonly ok: false; readonly codigo: string; readonly mensagem: string };

function falha(codigo: string, mensagem: string): ResultadoDaRetomada {
  return { ok: false, codigo, mensagem };
}

/** O `data` de um envelope `ok` — o mesmo que `conteudoDoEnvelope` serializa. */
export function dataDoEnvelope(r: unknown): unknown {
  const env = (r as { envelope?: { ok?: boolean; data?: unknown } }).envelope;
  return env?.ok === true ? env.data : null;
}

/**
 * O texto que o modelo LE como resultado da ferramenta.
 *
 * Mesma forma de `conteudoDeSucesso` no laco: JSON compacto do `data` do
 * envelope. Nao vai o envelope inteiro — `request_id` e contrato interno
 * nao tem o que fazer no contexto do modelo.
 */
function conteudoDoEnvelope(r: unknown): { texto: string; erro: boolean } {
  const env = (r as { envelope?: { ok?: boolean; data?: unknown; error?: { message?: string } } })
    .envelope;
  if (env?.ok === true) {
    try {
      return { texto: JSON.stringify(env.data ?? null), erro: false };
    } catch {
      return { texto: "A ferramenta respondeu algo que nao pode ser lido.", erro: true };
    }
  }
  // A frase do envelope de erro ja e nossa, curta e estavel.
  return {
    texto: env?.error?.message ?? "A ferramenta nao conseguiu concluir.",
    erro: true,
  };
}

/**
 * Executa a Funcao aprovada e fecha o turno com a resposta do agente.
 *
 * `aprovacaoId` e o UNICO dado que vem de fora, e ele e so um ponteiro:
 * dono, agente, conversa, Funcao e argumentos saem todos da linha
 * congelada. Nao ha campo por onde o cliente troque o que sera executado
 * depois de a aprovacao existir (§23).
 */
export async function retomarTurnoAprovado(
  entrada: EntradaDaRetomada,
  portaConversas: PortaDeConversas = criarPortaDeConversas(getSupabaseServidor())
): Promise<ResultadoDaRetomada> {
  const { userId, aprovacaoId } = entrada;
  if (!userId || !aprovacaoId) return falha("entrada_invalida", "Pedido invalido.");

  // ── 1. A aprovacao, escopada pelo dono ────────────────────────────
  const leitura = await lerAprovacaoDaConversaParaRetomada({ userId, aprovacaoId });
  if (leitura.leitura === "falha") {
    return falha("indisponivel", "Nao foi possivel carregar a aprovacao.");
  }
  // "nao existe", "e de outra pessoa" e "nao veio de uma conversa" dao a
  // MESMA resposta: distinguir viraria um oraculo sobre o que existe na
  // conta de outro dono.
  if (leitura.leitura !== "ok") {
    return falha("aprovacao_nao_encontrada", "Aprovacao nao encontrada.");
  }
  const aprovacao = leitura.aprovacao;

  // `consumida` e o SEGUNDO clique, e ele tem codigo proprio: quem chamou
  // precisa distinguir "ja rodou, esta tudo certo" de "ninguem aprovou
  // ainda". O teste live pegou isto — a frase dizia "ja foi executada" e o
  // codigo dizia `aprovacao_nao_aprovada`, entao a rota respondia 409 para
  // um caso que e sucesso.
  if (aprovacao.estado === "consumida") {
    return falha("ja_executada", "Esta acao ja foi executada.");
  }
  if (aprovacao.estado !== "aprovada") {
    return falha("aprovacao_nao_aprovada", "Esta aprovacao ainda nao foi aprovada.");
  }

  const conversa = await portaConversas.obterConversa(userId, aprovacao.conversaId);
  if (!conversa || conversa.agenteId !== aprovacao.agenteId) {
    return falha("conversa_nao_encontrada", "Conversa nao encontrada.");
  }

  const { linha: agente, erro } = await lerAgenteDoDono(aprovacao.agenteId, userId);
  if (erro) return falha("indisponivel", "Nao foi possivel carregar o agente.");
  if (!agente) return falha("agente_nao_encontrado", "Agente nao encontrado.");

  // ── 2. A IA deste agente, pela MESMA regra do turno original ──────
  const ia = resolverIaDoAgente({
    provedorGravado: agente.provedor_ia,
    modeloGravado: agente.modelo_ia,
    nivelGravado: agente.nivel_de_trabalho,
    disponiveis: modelosDisponiveis(),
  });
  const adaptador = adaptadorDoProvedor(ia.provedor);
  if (adaptador === null) {
    return falha("ia_indisponivel",
      "A IA configurada para este agente nao esta disponivel agora.");
  }

  // ── 3. EXECUTA a Funcao aprovada — atomico, uma vez so ────────────
  //
  // Daqui sai `ja_consumida` quando outro clique venceu a corrida. Nesse
  // caso NAO executamos de novo: a Funcao ja rodou, e rodar outra vez
  // seria o efeito duplicado que o §9 proibe.
  // ── Se a Funcao aprovada e EXTERNA, resolve-la pelos VINCULOS ────
  //
  // O mapa e montado a partir dos vinculos de AGORA, e nao dos de quando
  // a aprovacao nasceu. Uma ferramenta removida no meio simplesmente nao
  // esta aqui, e a retomada recusa — aprovacao nao ressuscita ferramenta
  // removida, do mesmo jeito que permissao nao ressuscita (§6).
  //
  // Para Funcao interna nada disso roda: nenhuma consulta ao catalogo
  // externo acontece para quem nao precisa dela.
  // As permissoes saem do escopo do `if` de proposito: elas servem tanto
  // para resolver a acao externa quanto para declarar o que o modelo
  // podera usar DEPOIS, no turno de conclusao (§7).
  const [vinculos, gravadas] = await Promise.all([
    listarVinculosExternos({ userId, agenteId: aprovacao.agenteId }),
    listarPermissoesGravadas({ userId, agenteId: aprovacao.agenteId }),
  ]);
  if (gravadas.coleta !== "ok") {
    return falha("indisponivel", "Nao foi possivel carregar as permissoes do agente.");
  }

  let definicoesExternas: Readonly<Record<string, DefinicaoFuncao>> | undefined;
  let externasPreparadas: ExternasPreparadas | undefined;
  if (vinculos.coleta === "ok" && vinculos.vinculos.length > 0) {
    const preparadas = await prepararFuncoesExternas({
      vinculos: vinculos.vinculos,
      permissoes: gravadas.permissoes.map((g) => ({ funcaoId: g.funcaoId, nivel: g.nivel })),
    });
    definicoesExternas = preparadas.definicoes;
    externasPreparadas = preparadas;
  }
  if (aprovacao.funcaoId.startsWith("composio.") && definicoesExternas === undefined) {
    return falha("indisponivel", "Nao foi possivel carregar as ferramentas do agente.");
  }

  const execucao = await retomarAprovacao({ userId, aprovacaoId, definicoesExternas });

  if (execucao.tipo === "aprovacao_indisponivel") {
    const codigo = (execucao as { codigo?: string }).codigo;
    if (codigo === "ja_consumida") {
      return falha("ja_executada", "Esta acao ja foi executada.");
    }
    return falha("aprovacao_indisponivel", "Esta aprovacao nao esta mais disponivel.");
  }

  const executou = execucao.tipo === "sucesso";
  const resultado = execucao.tipo === "sucesso"
    ? conteudoDoEnvelope(execucao)
    : {
        // Falha de execucao NAO vira resposta inventada: o modelo recebe
        // a recusa e responde a partir dela.
        texto: "A ferramenta nao conseguiu concluir.",
        erro: true,
      };

  // ── 4. Remonta o dialogo ate o pedido pendente ────────────────────
  //
  // O historico vem do BANCO, e nao de nenhum estado de tela. A mensagem
  // do usuario ja esta la desde o turno original — e por isso que ele nao
  // precisa reescrever nada.
  const db = getSupabaseServidor();
  const [skills, memorias, fontes, historico] = await Promise.all([
    resolverSkillsDoAgente({ userId, agenteId: aprovacao.agenteId }),
    criarPortaDeMemorias(db).listarAtivas(userId, aprovacao.agenteId),
    criarPortaDeFontes(db).listarDoAgente(userId, aprovacao.agenteId),
    portaConversas.listarMensagens(userId, aprovacao.conversaId),
  ]);
  if (skills.coleta !== "ok") {
    return falha("indisponivel", "Nao foi possivel carregar as Skills do agente.");
  }

  const contexto = montarContextoDoAgente({
    instrucoesDoAgente: agente.instrucoes,
    skills: skills.skills,
    memorias,
    fontes: fontes.map(paraModelo),
  });

  const recorte = recortarHistorico(historico);
  const dialogo: MensagemDoDialogo[] = recorte.incluidas.map((m) =>
    m.papel === "usuario"
      ? { papel: "usuario" as const, texto: m.conteudo }
      : { papel: "assistente" as const, texto: m.conteudo, pedidos: [] });

  // O turno que ficou pendente, reconstruido a partir da linha congelada.
  // `pedidoId` e o id que o PROVEDOR gerou; sem ele o resultado abaixo nao
  // se liga a pedido nenhum e a API recusa o dialogo.
  dialogo.push({
    papel: "assistente",
    texto: aprovacao.textoAssistente,
    pedidos: [{
      id: aprovacao.pedidoId,
      nome: aprovacao.funcaoId,
      argumentos: aprovacao.argumentos,
    }],
  });
  dialogo.push({
    papel: "ferramenta",
    respostas: [{
      id: aprovacao.pedidoId,
      conteudo: resultado.texto,
      erro: resultado.erro,
    }],
  });

  // ── 5. O modelo conclui — e PODE usar outras ferramentas ──────────
  //
  // ── A revisao do F7b.4.5 §7 ──────────────────────────────────────
  //
  // O F7b.4.4 chamava o modelo com `ferramentas: []`, para que ele nao
  // pedisse nada de novo e nao nascesse a "aprovacao Y". Funcionava, e
  // era estreito demais: depois de alterar um valor, o agente nao
  // conseguia CONSULTAR o resultado para confirmar ao usuario. A tarefa
  // ficava pela metade.
  //
  // Agora ele recebe as ferramentas do agente MENOS uma: a que acabou de
  // ser consumida. Isso preserva a garantia — aquela chamada especifica
  // nao pode pedir aprovacao outra vez — e devolve a capacidade de
  // terminar o trabalho.
  //
  // E com a politica por EFEITO (§2), o que sobra e majoritariamente
  // leitura, que roda sem confirmacao nenhuma.
  const ferramentasParaConcluir = declararFerramentas({
    catalogo: FUNCOES,
    permissoes: gravadas.coleta === "ok"
      ? gravadas.permissoes
          .filter((g) => g.funcaoId !== aprovacao.funcaoId)
          .map((g) => ({ funcaoId: g.funcaoId, nivel: g.nivel }))
      : [],
    externas: (externasPreparadas?.declaraveis ?? [])
      .filter((e) => e.funcaoId !== aprovacao.funcaoId),
  });

  let texto: string | null = null;
  try {
    const r = await conversarComFerramentas({
      userId,
      agenteId: aprovacao.agenteId,
      instrucao: contexto.instrucao,
      // A mensagem do usuario NAO e reenviada: ela ja esta no dialogo
      // remontado, e repeti-la duplicaria o turno.
      mensagemDoUsuario: "",
      historico: dialogo,
      ferramentas: ferramentasParaConcluir,
      definicoesExternas: definicoesExternas,
      conversaId: aprovacao.conversaId,
      nivelDeTrabalho: ia.nivel ?? undefined,
      adaptador,
    });
    texto = r.texto;
  } catch (e) {
    console.error("[conversas/retomada] falha do provedor:",
      String((e as Error).message).slice(0, 300));
    return falha("provedor_indisponivel", "Nao foi possivel falar com a IA agora.");
  }

  // ── 6. A resposta final, NA MESMA conversa ────────────────────────
  // F8.1-B4A: a consulta aprovada que termina em sucesso produz o MESMO
  // contrato de apresentacao da execucao direta — pelo mesmo extrator,
  // sobre o mesmo `data` que o modelo leu. Falha nao gera apresentacao.
  const apresentacao = executou
    ? apresentacaoDoPasso(aprovacao.funcaoId, dataDoEnvelope(execucao))
    : null;
  const passos: PassoRegistrado[] = [{
    funcaoId: aprovacao.funcaoId,
    desfecho: executou ? "sucesso" : "erro",
    executou,
    requestId: (execucao as { requestId?: string }).requestId ?? null,
    ...(apresentacao === null ? {} : { apresentacao }),
  }];

  const resposta = await portaConversas.anexarMensagem({
    userId,
    conversaId: aprovacao.conversaId,
    papel: "assistente",
    conteudo: texto ?? "Nao consegui concluir depois da aprovacao.",
    passos,
  });

  return { ok: true, conversaId: aprovacao.conversaId, resposta, executou };
}
