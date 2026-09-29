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
import type {
  AdaptadorIAComFerramentas,
  FerramentaDeclarada,
  MensagemDoDialogo,
  PedidoDeFerramenta,
  RespostaDeFerramenta,
} from "@/lib/agentes/ia/ferramentas";
import type { ProvedorIA } from "@/lib/ai-gateway/tipos";

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
  /** Historico anterior, para multi-turno. Vazio na primeira mensagem. */
  readonly historico?: readonly MensagemDoDialogo[];
  readonly maxPassos?: number;
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

/** Uma ferramenta que rodou (ou foi recusada), para auditoria e UI. */
export interface PassoDeFerramenta {
  readonly funcaoId: string;
  readonly desfecho: string;
  readonly requestId: string | null;
  readonly executou: boolean;
}

export interface ResultadoDoLaco {
  readonly texto: string | null;
  readonly passos: readonly PassoDeFerramenta[];
  readonly mensagens: readonly MensagemDoDialogo[];
  readonly motivo: "concluido" | "teto_de_passos";
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
  porta: typeof executarFuncao
): Promise<{ resposta: RespostaDeFerramenta; passo: PassoDeFerramenta }> {
  // Cerca previa: o modelo so pode pedir o que foi DECLARADO a ele. Nao
  // substitui o guard — `executarFuncao` continua sendo a autoridade —,
  // mas evita transformar alucinacao de nome em chamada de catalogo.
  if (!permitidas.has(pedido.nome)) {
    return {
      resposta: { id: pedido.id, conteudo: RECUSAS.nome_invalido, erro: true },
      passo: { funcaoId: pedido.nome, desfecho: "nome_invalido", requestId: null, executou: false },
    };
  }

  const r = await porta({
    userId,
    agenteId,
    funcaoId: pedido.nome,
    argumentos: pedido.argumentos,
  } as Parameters<typeof executarFuncao>[0]);

  if (r.tipo === "sucesso") {
    return {
      resposta: {
        id: pedido.id,
        conteudo: conteudoDeSucesso((r as { envelope?: { data?: unknown } }).envelope?.data),
        erro: false,
      },
      passo: { funcaoId: pedido.nome, desfecho: "sucesso", requestId: r.requestId, executou: true },
    };
  }

  const frase = RECUSAS[r.tipo] ?? RECUSAS.indisponivel;
  return {
    resposta: { id: pedido.id, conteudo: frase, erro: true },
    passo: {
      funcaoId: pedido.nome,
      desfecho: r.tipo,
      requestId: (r as { requestId?: string }).requestId ?? null,
      executou: false,
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
        uso: { provedor, modelo, tokensEntrada, tokensSaida, tempoMs, turnos },
      };
    }

    const respostas: RespostaDeFerramenta[] = [];
    for (const pedido of r.pedidos) {
      const { resposta, passo: p } = await executarUmPedido(
        entrada.userId, entrada.agenteId, pedido, permitidas, porta);
      respostas.push(resposta);
      passos.push(p);
    }
    mensagens.push({ papel: "ferramenta", respostas });
  }

  // Teto atingido com pedido pendente. Devolve o que ha; nao lanca, e
  // NAO executa mais nada.
  return {
    texto: null,
    passos,
    mensagens,
    motivo: "teto_de_passos",
    uso: { provedor, modelo, tokensEntrada, tokensSaida, tempoMs, turnos },
  };
}
