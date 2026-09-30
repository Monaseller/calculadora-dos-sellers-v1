/**
 * O RUNTIME de chat do agente — AGENT-FACTORY-F7a.
 *
 * ── O caminho inteiro, num lugar so ─────────────────────────────────
 *
 *   sessao -> dono -> agente do dono
 *          -> Skills + memorias + fontes + permissoes (estado de AGORA)
 *          -> MEMORIA DO DONO, do grafo do Zep (F7b.4.5)
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
 * ── A memoria de longo prazo, e por que ela nao funcionava ─────────
 *
 * Ate o F7b.4.5 este runtime lia SO `portaMemorias.listarAtivas` — a
 * memoria MANUAL, que o dono escreve a mao. O modulo de memoria
 * automatica existia, estava provado na suite dele, e NAO TINHA CHAMADOR
 * NENHUM em producao.
 *
 * Resultado para quem usava: `memoria_ativa` ligada, nada ingerido, nada
 * recuperado. O Rodrigo disse o nome num chat e o agente nao soube no
 * seguinte — e a suite continuava verde, porque media o modulo e nao o
 * caminho do usuario.
 *
 * Duas coisas foram ligadas aqui, e as duas sao necessarias:
 *
 *   RECUPERAR  `recuperarMemoriaDoDono` busca no GRAFO do principal, e
 *              nao no contexto da thread. Medicao em
 *              `scripts/medir-zep-cross-chat.ts`: thread nova NAO herda
 *              nada de thread anterior, nem depois de 150 s. O grafo, sim.
 *
 *   INGERIR    sem gravar o turno, nao ha o que lembrar depois. A
 *              ingestao acontece DEPOIS de a conversa estar persistida:
 *              se ela falhar, a conversa nao se perde.
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
import { prepararFuncoesExternas } from "@/lib/agentes/composio/preparar-externas";
import {
  ingerirTurno, recuperarMemoriaDoDono,
} from "@/lib/agentes/memoria/automatica";
import { capacidadesDoAgente } from "@/lib/agentes/factory/capacidades";
import { detectarCapacidadeFaltante } from "@/lib/agentes/factory/capacidade-faltante";
import { abrirCapacidadePendente } from "@/lib/agentes/factory/capacidade-pendente";
import { listarVinculosExternos } from "@/lib/agentes/ferramentas-externas/repositorio";
import { listarPermissoesGravadas } from "@/lib/agentes/permissoes/gravadas";
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
      /**
       * Uma capacidade que a tarefa pediu e o agente nao tem — F7b.4.6.
       *
       * Presente so quando ha o que oferecer. A tela mostra o cartao; o
       * turno ja aconteceu e a resposta ja esta gravada.
       */
      readonly capacidadePendente?: { readonly id: string; readonly necessidade: string };
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

  const [
    permissoes, skills, memorias, fontes, historico,
    permissoesGravadas, vinculosExternos, memoriaDoDono,
  ] = await Promise.all([
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
    // F7b.4.3: as duas leituras que sustentam a ferramenta externa. Vao
    // no MESMO `Promise.all` do resto do estado de agora — uma ida a mais
    // em serie custaria um round trip antes de o modelo comecar a falar.
    listarPermissoesGravadas({ userId: entrada.userId, agenteId: entrada.agenteId }),
    listarVinculosExternos({ userId: entrada.userId, agenteId: entrada.agenteId }),
    // F7b.4.5: a memoria do DONO, buscada pela pergunta deste turno. Vai
    // no mesmo `Promise.all` porque e mais uma ida a rede, e em serie ela
    // atrasaria a primeira palavra do agente.
    recuperarMemoriaDoDono(
      {
        userId: entrada.userId,
        agenteId: entrada.agenteId,
        conversaId: entrada.conversaId,
        memoriaAtiva: agente.memoria_ativa,
      },
      entrada.texto.trim()
    ),
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

  // As capacidades em linguagem de gente, montadas dos vinculos REAIS.
  // Sem isto o modelo so conhecia os nomes das Functions declaradas, e
  // respondia `planilha_inspecionar` quando perguntado o que sabia fazer.
  const capacidades = capacidadesDoAgente({
    permissoes: permissoesGravadas.coleta === "ok"
      ? permissoesGravadas.permissoes.map((g) => ({ funcaoId: g.funcaoId, nivel: g.nivel }))
      : [],
    vinculosExternos: vinculosExternos.coleta === "ok"
      ? vinculosExternos.vinculos.map((v) => ({ toolkit: v.toolkit }))
      : [],
    memoriaAtiva: agente.memoria_ativa,
    temArquivos: fontes.length > 0,
    temSkills: skills.coleta === "ok" && skills.skills.length > 0,
  });

  const contexto = montarContextoDoAgente({
    instrucoesDoAgente: agente.instrucoes,
    skills: skills.skills,
    memorias,
    fontes: fontes.map(paraModelo),
    capacidades,
    lembrancasDoDono: memoriaDoDono.lembrancas.map((l) => l.fato),
    // `desligada` e `ligada mas vazia` produzem frases DIFERENTES — era
    // justamente isso que faltava (§11).
    estadoDaMemoria: !agente.memoria_ativa
      ? "desligada"
      : memoriaDoDono.desfecho === "ok" ? "ligada" : "indisponivel",
  });

  // ── As acoes EXTERNAS, declaradas e executaveis — F7b.4.3 ─────────
  //
  // O F7b.4.2 deixou isto explicitamente em aberto: o filtro existia e
  // estava provado, mas nao havia executor nem prova de execucao real, e
  // declarar o que nao se pode executar seria prometer capacidade que o
  // sistema nao tem. As duas coisas existem agora.
  //
  // `prepararFuncoesExternas` aplica as TRES condicoes do §5 — vinculo
  // atual, action ainda no catalogo, permissao explicita — e devolve as
  // duas metades: o que DECLARAR ao modelo e o que EXECUTAR depois do
  // guard. Nenhuma das duas parte da permissao: a autoridade sobre
  // presenca e o vinculo (§6).
  //
  // Falha do catalogo externo NAO derruba o turno: as ferramentas
  // internas continuam declaradas, e o agente continua funcionando com o
  // que e nosso (§13).
  const externas = await prepararFuncoesExternas({
    vinculos: vinculosExternos.coleta === "ok" ? vinculosExternos.vinculos : [],
    permissoes: permissoesGravadas.coleta === "ok"
      // TODAS as gravadas, e nao so as do registry: o nivel de uma acao
      // externa nao aparece em `resolverFatosPermissoes`, que filtra por
      // `Object.keys(FUNCOES)`.
      ? permissoesGravadas.permissoes.map((g) => ({ funcaoId: g.funcaoId, nivel: g.nivel }))
      : [],
  });

  if (externas.sumiramDoCatalogo > 0) {
    // Sem `funcao_id` no log: ele nomeia a ferramenta de um dono.
    console.warn(
      `[conversas/runtime] ${externas.sumiramDoCatalogo} acao(oes) externa(s) ` +
      "nao estao mais no catalogo e nao foram declaradas");
  }

  // ── As permissoes que chegam aqui precisam ser as DUAS ────────────
  //
  // `permissoes.fatos` vem de `resolverFatosPermissoes`, que filtra por
  // `Object.keys(FUNCOES)` — e uma acao externa nunca esta la. Passar so
  // isso fazia `declararFerramentas` nao achar o nivel da externa e nao
  // declarar NENHUMA delas, mesmo com vinculo e permissao gravados.
  //
  // Foi o que `testar-runtime-externo-live` acusou: o modelo respondia
  // "nao tenho acesso a uma ferramenta". O filtro estava certo; o dado que
  // chegava nele e que estava incompleto.
  //
  // A uniao e segura nos dois sentidos: id externo nao esta em `FUNCOES`,
  // entao o laco das internas o ignora; e id interno nao esta em
  // `externas.declaraveis`, entao o laco das externas o ignora.
  const permissoesParaDeclarar = [
    ...permissoes.fatos.map((p) => ({ funcaoId: p.funcaoId, nivel: p.nivel })),
    ...(permissoesGravadas.coleta === "ok"
      ? permissoesGravadas.permissoes
          .filter((g) => !Object.prototype.hasOwnProperty.call(FUNCOES, g.funcaoId))
          .map((g) => ({ funcaoId: g.funcaoId, nivel: g.nivel }))
      : []),
  ];

  const ferramentas = declararFerramentas({
    catalogo: FUNCOES,
    permissoes: permissoesParaDeclarar,
    externas: externas.declaraveis,
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
      // O que o guard vai poder resolver. Montado do VINCULO, nunca da
      // permissao — e por isso que permissao historica nao ressuscita
      // ferramenta removida nem aqui.
      definicoesExternas: externas.definicoes,
      // F7b.4.4: sem isto, uma aprovacao criada neste turno nasce sem
      // saber a qual conversa voltar — e era esse o defeito.
      conversaId: entrada.conversaId,
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
    ...(p.aprovacaoId === undefined ? {} : { aprovacaoId: p.aprovacaoId }),
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

  // ── A capacidade que FALTA — F7b.4.6 §2/§3 ────────────────────────
  //
  // Depois do turno, e nao antes: o agente responde primeiro, com o que
  // ele tem. A deteccao so ACRESCENTA uma oferta — ela nunca substitui a
  // resposta, nunca bloqueia o turno e nunca ativa nada sozinha.
  //
  // Quem resolve os candidatos e a CDS, por busca no catalogo real. O
  // modelo nao nomeia ferramenta e nao participa desta decisao (§17) —
  // por isso "ative todas as ferramentas" escrito pelo usuario nao ativa
  // coisa nenhuma (§18).
  //
  // A falha aqui NAO derruba o turno: a resposta do agente ja esta
  // gravada, e uma oferta que nao apareceu e menos grave que um turno
  // perdido.
  let capacidadePendente: { id: string; necessidade: string } | null = null;
  try {
    const falta = await detectarCapacidadeFaltante({
      texto: entrada.texto,
      nomesQueJaTem: capacidades.map((c) => c.nome),
    });
    if (falta.desfecho === "falta_capacidade") {
      const pendencia = await abrirCapacidadePendente({
        userId: entrada.userId,
        agenteId: entrada.agenteId,
        conversaId: entrada.conversaId,
        // O OBJETIVO e o que a pessoa escreveu. E ele que sera retomado,
        // e e por isso que ela nao precisa repetir depois.
        objetivo: entrada.texto.trim(),
        necessidade: falta.necessidade,
        opcoes: falta.opcoes,
      });
      if (pendencia !== null) {
        capacidadePendente = { id: pendencia.id, necessidade: pendencia.necessidade };
      }
    }
  } catch {
    console.error("[conversas/runtime] falha ao detectar capacidade faltante");
  }

  // ── A INGESTAO — F7b.4.5 ──────────────────────────────────────────
  //
  // DEPOIS de a conversa estar persistida, e de proposito: memoria e
  // servico de terceiro, e uma falha la nao pode custar o que o usuario
  // acabou de dizer. A ordem certa e gravar primeiro, lembrar depois.
  //
  // Sem `await` no caminho de resposta? Nao: o `await` fica, porque em
  // serverless uma promessa solta pode morrer com a invocacao, e ai a
  // memoria falharia de forma invisivel. O custo e alguns milissegundos
  // ao fim de um turno que ja levou segundos.
  //
  // `ingerirTurno` ja devolve cedo quando a memoria esta desligada — sem
  // rede nenhuma. Agente sem memoria nao paga por isto.
  const ingestao = await ingerirTurno(
    {
      userId: entrada.userId,
      agenteId: entrada.agenteId,
      conversaId: entrada.conversaId,
      memoriaAtiva: agente.memoria_ativa,
    },
    [
      { papel: "usuario", conteudo: gravadaDoUsuario.conteudo ?? "" },
      { papel: "assistente", conteudo: resposta.conteudo ?? "" },
    ]
  );
  if (ingestao.desfecho === "falha") {
    // Sem conteudo no log: a mensagem e do usuario. So o fato.
    console.error("[conversas/runtime] falha ao ingerir o turno na memoria");
  }

  return {
    ok: true,
    mensagemDoUsuario: gravadaDoUsuario,
    resposta,
    motivo: saida.motivo,
    historicoTruncado: recorte.excluidasPorTeto,
    ...(capacidadePendente === null ? {} : { capacidadePendente }),
  };
}
