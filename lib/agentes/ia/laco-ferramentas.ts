/**
 * O LACO de ferramentas — AGENT-FACTORY-F2.
 *
 * ── A propriedade que este arquivo existe para garantir ─────────────
 *
 *   NENHUMA ferramenta roda sem passar pelo guard.
 *
 * E a forma de garantir nao e checar o guard aqui: e NAO TER como
 * executar de outro jeito. O laco conhece exatamente uma porta de
 * execucao, `executarFuncao`, e ela ja faz guard, abertura, execucao,
 * desfecho e auditoria na ordem certa. Reimplementar a cerca aqui
 * criaria uma segunda cerca — e duas cercas que precisam concordar para
 * sempre acabam discordando.
 *
 * Por isso o laco NAO importa `resolverFuncao`, NAO importa
 * `autorizarFuncao` e NAO alcanca `definicao.executor`. A suite reprova
 * se qualquer um desses nomes aparecer aqui.
 *
 * ── O que o modelo pode e o que ele nao pode ────────────────────────
 *
 * Pode: pedir uma ferramenta pelo id, com argumentos.
 * Nao pode: escolher dono, agente, loja, credencial ou nivel de
 * permissao. Nada disso vem do pedido — `userId` e `agenteId` sao
 * fechados por quem chama o laco, e o `funcaoId` pedido e usado como
 * CHAVE de catalogo, nunca como autoridade.
 *
 * ── Recusa e um desfecho, nao uma excecao ───────────────────────────
 *
 * Guard negou, aprovacao pendente, funcao inexistente, erro de dominio:
 * tudo volta ao modelo como `RespostaDeFerramenta` com `erro: true` e
 * uma frase que ele pode usar. O dialogo continua; o que nao acontece e
 * a execucao. Lancar aqui faria uma negacao esperada derrubar a
 * conversa inteira.
 */
import "server-only";
import { executarFuncao } from "@/lib/agentes/execucao-funcoes/executar";
import type { DefinicaoFuncao } from "@/lib/agentes/funcoes/registry";
import type { FonteDeArquivo } from "@/lib/agentes/planilhas/fonte";
import type {
  AdaptadorIAComFerramentas,
  FerramentaDeclarada,
  MensagemDoDialogo,
  PedidoDeFerramenta,
  RespostaDeFerramenta,
} from "@/lib/agentes/ia/ferramentas";
import { semCamposNulos } from "@/lib/agentes/ia/argumentos-do-modelo";
import {
  MENSAGEM_POR_CATEGORIA,
  categoriaDoBloqueio,
  classificarFalha,
  type CategoriaDeBloqueio,
} from "@/lib/agentes/ia/falhas-de-ferramenta";
import type { ProvedorIA } from "@/lib/ai-gateway/tipos";
import {
  apresentacaoDoPasso, type ApresentacaoDoPasso,
} from "@/lib/agentes/conversas/tipos";

/**
 * Quantos TURNOS de ferramenta um unico pedido do usuario pode gastar.
 *
 * Nao e estetica: sem teto, um modelo que pede a mesma ferramenta em
 * resposta ao proprio resultado gira ate o timeout, gastando credito a
 * cada volta. Quatro passos cobrem "inspecionar, ler, agregar, concluir"
 * — a forma de trabalho que a fabrica precisa — e param antes de um
 * ciclo virar conta.
 *
 * Ao estourar, o laco NAO lanca: devolve o que tem com
 * `motivo: "teto_de_passos"`, e quem chama decide o que dizer.
 */
export const MAX_PASSOS_DE_FERRAMENTA = 4;

/** Mensagens que o MODELO le quando um pedido nao pode rodar. */
const RECUSAS: Readonly<Record<string, string>> = Object.freeze({
  negado: "Esta ferramenta nao esta habilitada para este agente.",
  aguardando_aprovacao: "Esta acao precisa de aprovacao humana antes de ser executada.",
  aprovacao_indisponivel: "Nao foi possivel registrar o pedido de aprovacao.",
  indisponivel: "Nao foi possivel usar esta ferramenta agora.",
  falha_auditoria: "Nao foi possivel registrar o uso desta ferramenta.",
  erro: "A ferramenta nao conseguiu concluir.",
  nome_invalido: "Ferramenta desconhecida.",
});

export interface EntradaDoLaco {
  /** Do runtime/sessao. NUNCA do modelo. */
  readonly userId: string;
  readonly agenteId: string;
  /** Instrucoes do agente. Comportamento, jamais autorizacao. */
  readonly instrucao: string;
  /** O que o usuario disse agora. */
  readonly mensagemDoUsuario: string;
  /** Ferramentas ja filtradas por permissao — ver `declararFerramentas`. */
  readonly ferramentas: readonly FerramentaDeclarada[];
  readonly adaptador: AdaptadorIAComFerramentas;
  /**
   * O nivel de trabalho do agente — F7b.4.2.
   *
   * Atravessa o laco sem ser interpretado: e rotulo da CDS, e traduzir e
   * trabalho do adaptador. O laco nao sabe o que `maximo` significa para
   * a OpenAI, e nao deve saber.
   *
   * Vale para TODOS os passos do mesmo turno, e nao so o primeiro: o
   * esforco e propriedade do agente, nao do passo.
   */
  readonly nivelDeTrabalho?: string;
  /**
   * As Funcoes EXTERNAS deste agente — F7b.4.3.
   *
   * Atravessa o laco sem ser interpretada, como `nivelDeTrabalho`: quem
   * monta e o runtime, a partir dos VINCULOS, e quem usa e
   * `executarFuncao`. O laco nao decide o que existe — ele so entrega.
   */
  readonly definicoesExternas?: Readonly<Record<string, DefinicaoFuncao>>;
  /**
   * A fonte de arquivo DESTE turno — F9.1.
   *
   * Atravessa o laco sem ser interpretada, como `definicoesExternas`: quem
   * monta e o runtime, preso a dono, agente e conversa, e quem usa e
   * `executarFuncao`. Viaja com cada pedido em vez de morar num modulo,
   * entao dois turnos simultaneos nunca enxergam a fonte um do outro.
   */
  readonly fonteDeArquivo?: FonteDeArquivo | null;
  /**
   * A conversa deste turno — F7b.4.4.
   *
   * O laco nao a usa para nada seu: ele so a repassa, junto do id do
   * pedido que o provedor gerou, para que uma aprovacao criada aqui saiba
   * onde voltar.
   */
  readonly conversaId?: string;
  /** Historico anterior, para multi-turno. Vazio na primeira mensagem. */
  readonly historico?: readonly MensagemDoDialogo[];
  readonly maxPassos?: number;
  /**
   * Obriga a PRIMEIRA ferramenta — AGENT-FACTORY-F4.
   *
   * So o primeiro turno: forcar em todos faria o modelo pedir
   * ferramenta para sempre, porque ele nunca teria um turno livre para
   * escrever a resposta final. O laco pararia no teto e o usuario
   * receberia `null` — um bug que parece limite de passos.
   *
   * Producao nao passa este campo. Ele existe para a prova de
   * protocolo, onde a pergunta e "o provedor sabe emitir e receber uma
   * chamada de ferramenta", e nao "o modelo escolhe bem".
   */
  readonly escolhaDeFerramenta?: "auto" | { readonly nome: string };
  /**
   * A PORTA de execucao — opcional, e o default e a porta real.
   *
   * ── Por que ela existe, e por que nao afrouxa a cerca ─────────────
   *
   * O laco precisa ser exercitado sem banco: negacao do guard, aprovacao
   * pendente, teto de passos e multi-pedido sao exatamente onde mora o
   * bug, e prova-los contra Postgres real tornaria a suite lenta e
   * dependente de fixture. E o idioma do projeto ja e este —
   * `PortasSincronizacao`, `criarLeiturasDeVendas`, `ObterAdaptadorDeConversa`.
   *
   * O que a mantem honesta e o DEFAULT: quem nao passa a porta recebe
   * `executarFuncao`, que faz guard, abertura, execucao, desfecho e
   * auditoria. Producao nunca passa — a suite reprova se algum arquivo
   * fora de `scripts/` preencher este campo.
   */
  readonly executar?: typeof executarFuncao;
}

/**
 * Uma ferramenta que rodou (ou foi recusada), para auditoria e UI.
 *
 * `aprovacaoId` so aparece quando o guard pediu decisao humana — F7b.4.4.
 * Sem ele, a tela sabia que "algo precisa de aprovacao" mas nao QUAL
 * aprovacao, e por isso mandava a pessoa para a fila em outra pagina.
 */
export interface PassoDeFerramenta {
  readonly funcaoId: string;
  readonly desfecho: string;
  readonly requestId: string | null;
  readonly executou: boolean;
  /** Codigo de dominio, quando a Funcao devolveu um. F4.1 classifica por ele. */
  readonly codigo: string | null;
  /**
   * A aprovacao criada por ESTE pedido — F7b.4.4.
   *
   * Presente so quando `desfecho === "aguardando_aprovacao"`. E o que
   * permite a tela mostrar Aprovar/Negar no proprio chat, em vez de
   * mandar a pessoa para outra pagina e perder o turno.
   */
  readonly aprovacaoId?: string;
  /**
   * Agregados minimos de apresentacao — F8.1-B4A. So em SUCESSO, e so
   * quando `apresentacaoDoPasso` reconhece a Funcao e a saida completa.
   * Nunca o `data` inteiro.
   */
  readonly apresentacao?: ApresentacaoDoPasso;
}

export interface ResultadoDoLaco {
  readonly texto: string | null;
  readonly passos: readonly PassoDeFerramenta[];
  readonly mensagens: readonly MensagemDoDialogo[];
  readonly motivo: "concluido" | "teto_de_passos" | "bloqueado_por_ferramenta";
  /**
   * Preenchido quando o turno FECHOU por falha de ferramenta — F4.1.
   *
   * Nesse caso `texto` foi escrito pelo RUNTIME, e nao pelo modelo: ele
   * nao chegou a ser chamado de novo. E essa a diferenca entre pedir ao
   * modelo que nao estime e nao lhe dar onde escrever.
   */
  readonly bloqueio: {
    readonly funcaoId: string;
    readonly desfecho: string;
    readonly codigo: string | null;
    /**
     * POR QUE fechou, em categoria — F7b.4.8.1 §12.
     *
     * E o que a tela pode mostrar. `codigo` continua aqui para auditoria
     * e log, e NAO deve subir para o usuario: ele e informacao de
     * operador, e detalhar da pistas sobre a conta de outra pessoa.
     */
    readonly categoria: CategoriaDeBloqueio;
  } | null;
  readonly uso: {
    readonly provedor: ProvedorIA | null;
    readonly modelo: string | null;
    readonly tokensEntrada: number;
    readonly tokensSaida: number;
    readonly tempoMs: number;
    readonly turnos: number;
  };
}

/**
 * Serializa o resultado para o modelo.
 *
 * Passa o `data` do envelope, nunca o objeto de execucao inteiro: o
 * modelo nao precisa de `requestId`, `auditoria` nem forma interna, e
 * cada campo a mais e um campo que pode vazar para o texto final.
 */
function conteudoDeSucesso(saida: unknown): string {
  try {
    return JSON.stringify(saida ?? null);
  } catch {
    return '{"erro":"resultado_nao_serializavel"}';
  }
}

async function executarUmPedido(
  userId: string,
  agenteId: string,
  pedido: PedidoDeFerramenta,
  permitidas: ReadonlySet<string>,
  porta: typeof executarFuncao,
  definicoesExternas?: Readonly<Record<string, DefinicaoFuncao>>,
  origem?: { conversaId: string; textoAssistente: string | null },
  fonteDeArquivo?: FonteDeArquivo | null
): Promise<{ resposta: RespostaDeFerramenta; passo: PassoDeFerramenta }> {
  // Cerca previa: o modelo so pode pedir o que foi DECLARADO a ele. Nao
  // substitui o guard — `executarFuncao` continua sendo a autoridade —,
  // mas evita transformar alucinacao de nome em chamada de catalogo.
  if (!permitidas.has(pedido.nome)) {
    return {
      resposta: { id: pedido.id, conteudo: RECUSAS.nome_invalido, erro: true },
      passo: { funcaoId: pedido.nome, desfecho: "nome_invalido", requestId: null,
        executou: false, codigo: "nome_invalido" },
    };
  }

  const r = await porta({
    userId,
    agenteId,
    funcaoId: pedido.nome,
    // ── F7b.4.8.1: `null` de campo opcional nao e valor ───────────
    //
    // MEDIDO: a OpenAI manda `{periodo, de: null, ate: null}` para uma
    // ferramenta com campos opcionais, em vez de omitir as chaves. Os
    // validadores testavam presenca com `!== undefined`, entao `null`
    // contava como preenchido e a chamada certa era recusada.
    //
    // Aqui, e nao dentro de cada validador: este e o unico lugar onde um
    // pedido do MODELO vira pedido de EXECUCAO, e a convencao e do
    // provedor, nao da Funcao. Ver `argumentos-do-modelo.ts`.
    argumentos: semCamposNulos(pedido.argumentos),
    definicoesExternas,
    // F9.1: so quando o runtime passou. Ausente mantem a entrada de antes.
    ...(fonteDeArquivo === undefined ? {} : { fonteDeArquivo }),
    // `pedido.id` e o id que o PROVEDOR deu a esta chamada. E ele que
    // permite remontar o dialogo depois: todo provedor exige que o
    // resultado da ferramenta cite o id do pedido que o originou.
    ...(origem === undefined ? {} : {
      origemDaConversa: {
        conversaId: origem.conversaId,
        pedidoId: pedido.id,
        textoAssistente: origem.textoAssistente,
      },
    }),
  } as Parameters<typeof executarFuncao>[0]);

  if (r.tipo === "sucesso") {
    const data = (r as { envelope?: { data?: unknown } }).envelope?.data;
    // F8.1-B4A: a MESMA saida que o modelo le, reduzida pela allowlist.
    const apresentacao = apresentacaoDoPasso(pedido.nome, data);
    return {
      resposta: {
        id: pedido.id,
        conteudo: conteudoDeSucesso(data),
        erro: false,
      },
      passo: { funcaoId: pedido.nome, desfecho: "sucesso", requestId: r.requestId,
        executou: true, codigo: null,
        ...(apresentacao === null ? {} : { apresentacao }) },
    };
  }

  const frase = RECUSAS[r.tipo] ?? RECUSAS.indisponivel;
  const codigoDoErro = (r as { codigo?: string }).codigo ?? null;

  /**
   * O que o MODELO le quando a ferramenta recusou.
   *
   * ── Por que o codigo entra, e so as vezes ─────────────────────────
   *
   * Marcar um codigo como "corrigivel" nao serve de nada se a recusa que
   * chega ao modelo for "a ferramenta nao conseguiu concluir". Foi o que
   * o Rodrigo viu acontecer duas vezes seguidas: o modelo tentava, era
   * recusado sem saber por que, e tentava igual.
   *
   * Entao a recusa CORRIGIVEL nomeia o codigo — `filtro_ambiguo` diz o
   * que mudar; "nao conseguiu concluir" nao diz nada.
   *
   * E a recusa que FECHA o turno continua vaga, de proposito: ali o
   * codigo e informacao de operador (`permissao_bloqueada`,
   * `conexao_ausente`), e detalhar daria ao modelo — e a quem estiver
   * lendo por cima do ombro — pistas sobre o que existe na conta de
   * outra pessoa. Mesma razao registrada em `MENSAGEM_POR_CATEGORIA`.
   */
  const conteudoDaRecusa =
    codigoDoErro !== null && classificarFalha(r.tipo, codigoDoErro) === "corrigivel"
      ? `${frase} Motivo: ${codigoDoErro}. Corrija os argumentos e chame de novo.`
      : frase;

  const aprovacaoId = (r as { aprovacaoId?: unknown }).aprovacaoId;
  return {
    resposta: { id: pedido.id, conteudo: conteudoDaRecusa, erro: true },
    passo: {
      funcaoId: pedido.nome,
      desfecho: r.tipo,
      requestId: (r as { requestId?: string }).requestId ?? null,
      executou: false,
      codigo: (r as { codigo?: string }).codigo ?? null,
      // So quando existe. Um campo sempre presente e sempre nulo diria
      // que toda recusa tem aprovacao, e nao tem.
      ...(typeof aprovacaoId === "string" && aprovacaoId !== ""
        ? { aprovacaoId }
        : {}),
    },
  };
}

/**
 * O laco.
 *
 * Alterna modelo e ferramentas ate o modelo parar de pedir, ou ate o
 * teto. Cada ida ao modelo e um turno; cada pedido dentro do turno passa
 * por `executarFuncao`.
 */
export async function conversarComFerramentas(
  entrada: EntradaDoLaco
): Promise<ResultadoDoLaco> {
  const teto = entrada.maxPassos ?? MAX_PASSOS_DE_FERRAMENTA;
  const permitidas = new Set(entrada.ferramentas.map((f) => f.nome));
  // O default e a porta REAL. Sem `executar`, o laco passa pelo guard.
  const porta = entrada.executar ?? executarFuncao;

  const mensagens: MensagemDoDialogo[] = [
    ...(entrada.historico ?? []),
    { papel: "usuario", texto: entrada.mensagemDoUsuario },
  ];
  const passos: PassoDeFerramenta[] = [];

  let provedor: ProvedorIA | null = null;
  let modelo: string | null = null;
  let tokensEntrada = 0;
  let tokensSaida = 0;
  let tempoMs = 0;
  let turnos = 0;

  for (let passo = 0; passo < teto; passo += 1) {
    const r = await entrada.adaptador({
      instrucao: entrada.instrucao,
      mensagens,
      ferramentas: entrada.ferramentas,
      escolhaDeFerramenta: passo === 0 ? entrada.escolhaDeFerramenta : "auto",
      nivelDeTrabalho: entrada.nivelDeTrabalho,
    });
    turnos += 1;
    provedor = r.provedor;
    modelo = r.modelo;
    tokensEntrada += r.tokensEntrada;
    tokensSaida += r.tokensSaida;
    tempoMs += r.tempoMs;

    mensagens.push({ papel: "assistente", texto: r.texto, pedidos: r.pedidos });

    if (r.pedidos.length === 0) {
      return {
        texto: r.texto,
        passos,
        mensagens,
        motivo: "concluido",
        bloqueio: null,
        uso: { provedor, modelo, tokensEntrada, tokensSaida, tempoMs, turnos },
      };
    }

    const respostas: RespostaDeFerramenta[] = [];
    const passosDesteTurno: PassoDeFerramenta[] = [];
    for (const pedido of r.pedidos) {
      const { resposta, passo: p } = await executarUmPedido(
        entrada.userId, entrada.agenteId, pedido, permitidas, porta,
        entrada.definicoesExternas,
        entrada.conversaId === undefined
          ? undefined
          // `r.texto` e o que o modelo disse JUNTO do pedido, e faz parte
          // do turno que sera remontado. Perde-lo mudaria o dialogo.
          : { conversaId: entrada.conversaId, textoAssistente: r.texto },
        entrada.fonteDeArquivo);
      respostas.push(resposta);
      passos.push(p);
      passosDesteTurno.push(p);
    }
    mensagens.push({ papel: "ferramenta", respostas });

    // ── F4.1: a cerca contra numero nao verificado ──────────────────
    //
    // Se ALGUM passo deste turno falhou por indisponibilidade — guard,
    // aprovacao, conexao, fonte, auditoria —, o laco PARA AQUI. O
    // modelo nao e chamado outra vez, entao nao existe turno em que ele
    // possa escrever um total que nenhuma ferramenta produziu.
    //
    // Falha CORRIGIVEL (argumento errado, aba inexistente) nao para: ali
    // o proximo turno e util e o modelo acerta com o que a recusa
    // contou. A lista de corrigiveis e fechada; o default e parar.
    const fechou = passosDesteTurno.find(
      (p) => p.desfecho !== "sucesso" && classificarFalha(p.desfecho, p.codigo) === "fecha_o_turno"
    );
    if (fechou !== undefined) {
      // §12: a frase depende da CATEGORIA. Uma frase so dizia "a
      // ferramenta nao esta disponivel" para quem tinha a ferramenta.
      const categoria = categoriaDoBloqueio(fechou.desfecho, fechou.codigo);
      return {
        // Escrito pelo RUNTIME. Nao veio do modelo e nao passou por ele.
        texto: MENSAGEM_POR_CATEGORIA[categoria],
        passos,
        mensagens,
        motivo: "bloqueado_por_ferramenta",
        bloqueio: {
          funcaoId: fechou.funcaoId, desfecho: fechou.desfecho,
          codigo: fechou.codigo, categoria,
        },
        uso: { provedor, modelo, tokensEntrada, tokensSaida, tempoMs, turnos },
      };
    }
  }

  // Teto atingido com pedido pendente. Devolve o que ha; nao lanca, e
  // NAO executa mais nada.
  return {
    texto: null,
    passos,
    mensagens,
    motivo: "teto_de_passos",
    bloqueio: null,
    uso: { provedor, modelo, tokensEntrada, tokensSaida, tempoMs, turnos },
  };
}
