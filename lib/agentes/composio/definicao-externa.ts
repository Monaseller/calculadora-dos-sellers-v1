import "server-only";

/**
 * Uma action externa vestida de `DefinicaoFuncao` — F7b.4.3 §3/§4/§5.
 *
 * ── Por que ela veste a forma das internas ──────────────────────────
 *
 * Porque assim ela atravessa `executarFuncao` SEM que exista uma segunda
 * cerca. O mesmo guard decide, a mesma auditoria abre e fecha, a mesma
 * aprovacao congela argumentos, o mesmo envelope sai. Um caminho paralelo
 * para ferramenta externa seria uma segunda implementacao da autorizacao,
 * e duas cercas que precisam concordar para sempre acabam discordando.
 *
 * O unico ponto novo em `executarFuncao` e a RESOLUCAO da definicao: ela
 * passa a poder vir de um mapa fornecido por quem chama, alem do registry
 * estatico. Nada mais muda — nem a ordem, nem a decisao, nem o registro.
 *
 * ── `conexaoNecessaria` fica `null`, e isso e deliberado ────────────
 *
 * `RequisitoConexaoFuncao` fala de `agente_conexoes` — o sistema de
 * binding de loja de Mercado Livre e Shopee, com `plataforma`/`recurso`,
 * cobertura e `lojaId`. Conexao do Composio e outra coisa: e uma conta do
 * DONO no provedor externo, resolvida por hash dentro do executor.
 *
 * Mapear uma na outra faria o guard procurar um `FatoConexao` que nunca
 * vai existir, e toda action externa seria negada por um motivo falso.
 * A falta de conexao externa aparece onde ela de fato acontece: na
 * execucao, como `conexao_necessaria`, depois de o guard ter autorizado.
 * Fail-closed do mesmo jeito — nada executa —, mas pelo motivo verdadeiro.
 *
 * ── `acesso` vem do RISCO da action ─────────────────────────────────
 *
 * `riscoDaAcao` ja classifica por slug, e escrita vence empate. E como
 * `executarFuncao` recusa `acesso: "escrita"` com `escrita_nao_suportada`
 * (nao ha contrato de idempotency key para efeito externo), uma action de
 * escrita externa e fail-closed por construcao — hoje.
 *
 * Isso e uma LIMITACAO REAL e nao um descuido: soltar escrita externa sem
 * chave de deduplicacao faria um efeito no mundo acontecer duas vezes num
 * retry. Fica registrado aqui para nao ser descoberto como surpresa.
 */
import type {
  ContextoFuncao, DefinicaoFuncao, ResultadoInterpretacaoSaida,
  ResultadoValidacaoEntrada,
} from "@/lib/agentes/funcoes/registry";
import { executarAcaoComposio } from "@/lib/agentes/composio/executor";
import { pecasDoId, riscoDaAcao } from "@/lib/agentes/composio/identidade-de-funcao";

/** O recorte do catalogo que basta para montar a definicao. */
export interface AcaoDoCatalogo {
  readonly slug: string;
  readonly descricao: string;
  /** JSON Schema do provedor. Nao e inventado por nos. */
  readonly parametros: Readonly<Record<string, unknown>>;
  /** Versao do catalogo, usada como `revisao`. */
  readonly versao: string;
}

/**
 * Valida os argumentos contra o schema do PROVEDOR.
 *
 * Deliberadamente conservador: confere que e objeto e que todo campo
 * `required` esta presente e nao vazio. Nao tenta ser um validador de
 * JSON Schema completo — quem valida de verdade e o provedor, e fingir
 * validacao total aqui daria falsa confianca.
 *
 * O que esta checagem ganha e recusar ANTES de gastar a chamada, e
 * sobretudo antes de congelar uma aprovacao que nunca poderia ser
 * consumida (o mesmo motivo que `executarFuncao` valida antes de criar
 * aprovacao).
 */
function validadorDe(parametros: Readonly<Record<string, unknown>>) {
  const obrigatorios: string[] = Array.isArray(parametros.required)
    ? parametros.required.filter((r): r is string => typeof r === "string")
    : [];

  return (argumentos: unknown): ResultadoValidacaoEntrada => {
    if (typeof argumentos !== "object" || argumentos === null || Array.isArray(argumentos)) {
      return { valida: false, codigo: "argumentos_nao_sao_objeto" };
    }
    const a = argumentos as Record<string, unknown>;
    for (const campo of obrigatorios) {
      if (!Object.prototype.hasOwnProperty.call(a, campo)) {
        return { valida: false, codigo: "campo_obrigatorio_ausente" };
      }
      const v = a[campo];
      if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) {
        return { valida: false, codigo: "campo_obrigatorio_vazio" };
      }
    }
    return { valida: true };
  };
}

/**
 * Le o que o executor devolveu.
 *
 * O executor ja classificou; aqui a classificacao vira o veredicto que a
 * auditoria grava. `conexao_necessaria` e `retryable: true` porque a
 * pessoa PODE resolver — conectando a conta — e uma nova tentativa depois
 * disso funciona. `acao_falhou` nao: os mesmos argumentos falhariam igual.
 */
function interpretar(saida: unknown): ResultadoInterpretacaoSaida {
  if (typeof saida !== "object" || saida === null) return { tipo: "invalida" };
  const r = saida as {
    estado?: unknown; codigo?: unknown; toolkit?: unknown; dados?: unknown;
  };

  // `data` e o que segue para o modelo. Passa o `dados` JA recortado pelo
  // executor — nunca o corpo cru do provedor, que carrega `log_id` e o
  // principal derivado.
  if (r.estado === "ok") return { tipo: "sucesso", data: r.dados ?? null };

  if (r.estado === "conexao_necessaria") {
    return {
      tipo: "erro",
      codigo: "conexao_necessaria",
      // A frase que o modelo vai ver. Ela diz o que falta e NAO inventa
      // resultado — e o §13: indisponibilidade nunca vira resposta.
      mensagem: "Este aplicativo ainda não está conectado. Conecte a conta para usar esta ação.",
      retryable: true,
    };
  }
  if (r.estado === "nao_configurado") {
    return {
      tipo: "erro", codigo: "externo_nao_configurado",
      mensagem: "As ações de aplicativos não estão configuradas neste ambiente.",
      retryable: false,
    };
  }
  if (r.estado === "acao_falhou" || r.estado === "falha") {
    const codigo = typeof r.codigo === "string" && r.codigo !== "" ? r.codigo : "erro_externo";
    return {
      tipo: "erro", codigo,
      mensagem: "A ação do aplicativo não pôde ser concluída.",
      // So o que e de fato transitorio. `argumentos_invalidos` repetido
      // falha igual, e marcar como retryable faria o laco insistir.
      retryable: codigo === "tempo_esgotado" || codigo === "limite_excedido",
    };
  }
  return { tipo: "invalida" };
}

/**
 * Monta a `DefinicaoFuncao` de UMA action externa.
 *
 * `null` quando o id nao decompoe: uma Funcao que ninguem consegue nomear
 * nao deveria poder ser executada — a mesma regra de
 * `fatosDeFuncaoExterna`.
 */
export function definicaoDaAcaoExterna(
  funcaoId: string,
  acao: AcaoDoCatalogo
): DefinicaoFuncao | null {
  const pecas = pecasDoId(funcaoId);
  if (pecas === null) return null;

  const risco = riscoDaAcao(acao.slug);
  const acesso: "leitura" | "escrita" = risco === "leitura" ? "leitura" : "escrita";

  return {
    executor: async (contexto: ContextoFuncao, argumentos: unknown): Promise<unknown> => {
      // `contexto.userId` vem de `executarFuncao`, que o recebeu da SESSAO.
      // Nao ha outro caminho para ca, e nao ha campo por onde um id chegar
      // dos argumentos do modelo.
      return executarAcaoComposio({
        userId: contexto.userId,
        toolkit: pecas.toolkit,
        acao: acao.slug,
        argumentos: (argumentos ?? {}) as Readonly<Record<string, unknown>>,
        signal: contexto.sinalDoBanco,
      });
    },
    validarEntrada: validadorDe(acao.parametros),
    interpretarSaida: interpretar,
    // A versao do CATALOGO. Se o provedor mudar a action, a revisao muda
    // junto — que e exatamente o que `revisao` existe para congelar numa
    // aprovacao humana.
    revisao: acao.versao || "externa-1",
    acesso,
    // Desconhecido conta como NAO idempotente: o padrao seguro e supor
    // que repetir tem efeito.
    idempotente: risco === "leitura",
    // Ver o docblock: conexao externa NAO e `agente_conexoes`.
    conexaoNecessaria: null,
  };
}
