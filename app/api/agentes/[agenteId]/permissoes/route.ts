/**
 * GET e PATCH /api/agentes/[agenteId]/permissoes — PERMISSOES-FUNCTION-V1-A.
 *
 * A superficie autenticada de CONFIGURACAO: quais Funcoes este agente
 * pode usar, e em que nivel de autonomia. Ate aqui `agente_permissoes`
 * so podia ser povoada por SQL manual — a tabela estava com zero linhas
 * e o guard, fail-closed, negava tudo por `permissao_ausente`.
 *
 * ── Funcao disponivel e nivel sao a MESMA decisao ───────────────────
 *
 * Nao ha "habilitar" separado de "escolher o nivel". Uma Funcao sem
 * linha em `agente_permissoes` esta ausente, e ausente e negada. Por
 * isso o GET devolve UMA entrada por Funcao REGISTRADA, com `nivel`
 * podendo ser `null` — e nao uma lista de "funcoes habilitadas", que
 * sugeriria capacidade concedida onde nao ha nada gravado.
 *
 * ── `nivel: null` NAO e `"bloqueado"` ───────────────────────────────
 *
 * As duas coisas negam, e o guard as separa de proposito:
 * `permissao_ausente` e "o dono nunca configurou", `permissao_bloqueada`
 * e "o dono proibiu". Colapsar as duas aqui apagaria a intencao do dono
 * na unica tela onde ela e visivel. Quem colapsa e o motor de
 * diagnostico (`?? "bloqueado"`), que e outra camada e outro proposito.
 *
 * ── CONFIGURAR nao e EXECUTAR ───────────────────────────────────────
 *
 * Esta rota grava intencao. Ela nao chama `autorizarFuncao`, nao chama
 * `executarFuncao`, nao abre Approval, nao registra Tool Call, nao cria
 * Task e nao toca conexoes. Quem decide se uma chamada passa continua
 * sendo o guard, na hora da chamada.
 *
 * ── O catalogo e o REGISTRY, nunca uma copia ────────────────────────
 *
 * A lista de Funcoes sai de `listarFuncoesRegistradas()` e os metadados
 * de `resolverFuncao()`. Nao ha lista escrita a mao aqui, e nao ha mock:
 * uma Funcao nova no registry aparece nesta resposta sem ninguem editar
 * este arquivo, e uma suite cobra essa igualdade nos dois sentidos.
 *
 * ── O que nunca sai daqui ───────────────────────────────────────────
 *
 * `executor`, `validarEntrada` e `interpretarSaida` sao codigo. `revisao`
 * e interno e ainda nao tem leitor. `user_id`, `criado_em` e
 * `alterado_em` da permissao nao tem consumidor na tela. Agente
 * inexistente e agente de outro dono produzem a MESMA 404 — distinguir
 * viraria um oraculo de existencia de ids alheios.
 */
import { NextResponse } from "next/server";

import { autenticarRequisicao } from "@/lib/autenticacao";
import { lerAgenteDoDono } from "@/lib/agentes/capability";
import { funcaoExiste, listarFuncoesRegistradas, resolverFuncao } from "@/lib/agentes/funcoes/registry";
import { resolverFatosPermissoes } from "@/lib/agentes/permissoes/fatos";
import { definirPermissaoDeFuncaoDoAgente } from "@/lib/agentes/permissoes/escrita";
import { NIVEIS_AUTONOMIA } from "@/lib/ia/conceitos";

/** Configuracao privada por dono, que muda a cada definicao. Nunca cacheada. */
export const dynamic = "force-dynamic";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * As UNICAS duas chaves aceitas no corpo do PATCH, e as DUAS sao
 * obrigatorias.
 *
 * Contrato fechado nos dois sentidos: nem chave a mais, nem subset. Uma
 * definicao pela metade — Funcao sem nivel, ou nivel sem Funcao — nao e
 * uma decisao que o dono possa ter tomado, e aceita-la exigiria inventar
 * o campo que faltou. `user_id`, `agente_id`, `revisao`, `criado_em` e
 * `alterado_em` caem todos fora: sao exatamente as chaves que alguem
 * tentaria para trocar de dono, de agente, de versao ou de tempo.
 */
const CAMPOS_DEFINICAO = ["funcaoId", "nivel"] as const;

/** Ponto unico de saida: nenhum branch pode esquecer o `no-store`. */
function responder(corpo: unknown, status: number): NextResponse {
  return NextResponse.json(corpo, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * A entrada publica de UMA Funcao — campo a campo, nunca spread.
 *
 * `DefinicaoFuncao` tem sete campos e quatro deles nunca podem sair:
 * tres sao funcoes e `revisao` e interno. Montar a mao garante que um
 * campo novo no registry nao passe a vazar sozinho por aqui.
 */
function entradaDaFuncao(funcaoId: string, nivel: string | null) {
  const definicao = resolverFuncao(funcaoId);
  const requisito = definicao.conexaoNecessaria;
  return {
    id: funcaoId,
    acesso: definicao.acesso,
    idempotente: definicao.idempotente,
    // Objeto novo, tambem campo a campo: devolver a referencia do
    // registry congelado publicaria o objeto do catalogo.
    conexaoNecessaria:
      requisito === null
        ? null
        : { plataforma: requisito.plataforma, recurso: requisito.recurso },
    nivel,
  };
}

/**
 * O que o corpo autoriza definir.
 *
 * `corpo` distingue "nao consegui ler isto como pedido" de `definicao`,
 * que e "li, e o pedido nao e aceitavel". `funcao` e `nivel` tem codigos
 * proprios porque dizem O QUE esta errado sem revelar nada: os dois
 * vocabularios sao publicos — o registry e visivel pelo GET, e os tres
 * niveis sao os mesmos que a tela oferece.
 */
type LeituraDefinicao =
  | { ok: true; funcaoId: string; nivel: string }
  | { ok: false; causa: "corpo" | "definicao" | "funcao" | "nivel" };

async function definicaoDoCorpo(request: Request): Promise<LeituraDefinicao> {
  const texto = await request.text().catch(() => "");
  // Corpo ausente nao e "nada a definir": e pedido malformado.
  if (texto.trim().length === 0) return { ok: false, causa: "corpo" };

  let corpo: unknown;
  try {
    corpo = JSON.parse(texto);
  } catch {
    return { ok: false, causa: "corpo" };
  }

  if (typeof corpo !== "object" || corpo === null || Array.isArray(corpo)) {
    return { ok: false, causa: "corpo" };
  }

  // IGUALDADE DE CONJUNTO, antes de qualquer valor. Ordenar os dois
  // lados e comparar: uma chave a mais reprova, e uma a menos tambem.
  const chaves = Object.keys(corpo).sort();
  const esperadas = [...CAMPOS_DEFINICAO].sort();
  if (JSON.stringify(chaves) !== JSON.stringify(esperadas)) {
    return { ok: false, causa: "definicao" };
  }

  const bruto = corpo as { funcaoId?: unknown; nivel?: unknown };

  // Id nao-string nao identifica Funcao nenhuma, e o proximo passo ja o
  // conferiria contra o registry — mas recusar por TIPO aqui mantem o
  // codigo de erro honesto.
  if (typeof bruto.funcaoId !== "string" || bruto.funcaoId.length === 0) {
    return { ok: false, causa: "funcao" };
  }
  // E conferido contra o REGISTRY aqui tambem, nao so na capability. Nao
  // e duplicacao de regra: e a mesma autoridade consultada duas vezes,
  // em camadas diferentes. Sem isto, uma Funcao desconhecida sairia como
  // "Definição inválida." — generico, quando o vocabulario e PUBLICO (o
  // GET lista exatamente os ids aceitos) e o dono merece saber qual dos
  // dois campos recusou.
  if (!funcaoExiste(bruto.funcaoId)) {
    return { ok: false, causa: "funcao" };
  }
  // Igualdade exata contra o vocabulario canonico: sem alias, sem
  // `toLowerCase`, sem `trim`. Um nivel quase certo e um nivel errado.
  if (
    typeof bruto.nivel !== "string" ||
    !(NIVEIS_AUTONOMIA as readonly string[]).includes(bruto.nivel)
  ) {
    return { ok: false, causa: "nivel" };
  }

  return { ok: true, funcaoId: bruto.funcaoId, nivel: bruto.nivel };
}

/** Sessao + uuid + propriedade do agente. Os tres passos que GET e PATCH
 *  fazem identicos, e por isso ficam num lugar so — a alternativa seria
 *  duas copias que um dia discordariam sobre quem pode ver o que. */
type Porta =
  | { ok: true; userId: string; agenteId: string }
  | { ok: false; resposta: NextResponse };

async function atravessarPorta(
  request: Request,
  agenteIdBruto: string,
  falhaInterna: string
): Promise<Porta> {
  const auth = await autenticarRequisicao(request);
  if (!auth.autenticado) {
    return { ok: false, resposta: responder({ ok: false, erro: "Não autenticado." }, 401) };
  }

  if (typeof agenteIdBruto !== "string" || !UUID_REGEX.test(agenteIdBruto)) {
    return { ok: false, resposta: responder({ ok: false, erro: "agenteId inválido." }, 400) };
  }

  const { linha, erro } = await lerAgenteDoDono(agenteIdBruto, auth.uid);
  if (erro !== null) {
    return { ok: false, resposta: responder({ ok: false, erro: falhaInterna }, 500) };
  }
  // Inexistente e de outro dono sao a MESMA resposta, de proposito.
  if (linha === null) {
    return { ok: false, resposta: responder({ ok: false, erro: "Agente não encontrado." }, 404) };
  }

  return { ok: true, userId: auth.uid, agenteId: agenteIdBruto };
}

const FALHA_LEITURA = "Falha ao ler as permissões.";
const FALHA_ESCRITA = "Falha ao definir a permissão.";

export async function GET(request: Request, { params }: { params: { agenteId: string } }) {
  try {
    const porta = await atravessarPorta(request, params.agenteId, FALHA_LEITURA);
    if (!porta.ok) return porta.resposta;

    // O catalogo REAL. Nao ha lista escrita a mao aqui.
    const funcaoIds = listarFuncoesRegistradas();

    const { fatos, coleta } = await resolverFatosPermissoes({
      userId: porta.userId,
      agenteId: porta.agenteId,
      funcaoIds,
    });
    // `falha_leitura` NAO vira lista sem nivel: um banco fora do ar
    // apareceria como "o dono nao configurou nada", indistinguivel de
    // uma escolha deliberada. `entrada_invalida` com a porta ja
    // atravessada so pode ser defeito nosso.
    if (coleta !== "ok") {
      return responder({ ok: false, erro: FALHA_LEITURA }, 500);
    }

    const permissoes = funcaoIds.map((id) =>
      entradaDaFuncao(id, fatos.find((f) => f.funcaoId === id)?.nivel ?? null)
    );

    return responder({ ok: true, permissoes }, 200);
  } catch {
    return responder({ ok: false, erro: FALHA_LEITURA }, 500);
  }
}

export async function PATCH(request: Request, { params }: { params: { agenteId: string } }) {
  try {
    const porta = await atravessarPorta(request, params.agenteId, FALHA_ESCRITA);
    if (!porta.ok) return porta.resposta;

    const leitura = await definicaoDoCorpo(request);
    if (!leitura.ok) {
      if (leitura.causa === "corpo") {
        return responder(
          { ok: false, erro: "Corpo da requisição inválido (JSON esperado)." },
          400
        );
      }
      if (leitura.causa === "funcao") {
        return responder({ ok: false, erro: "função inválida." }, 400);
      }
      if (leitura.causa === "nivel") {
        return responder({ ok: false, erro: "nível inválido." }, 400);
      }
      return responder({ ok: false, erro: "Definição inválida." }, 400);
    }

    // O dono e `auth.uid`, e so ele. `funcaoId` e reconferido contra o
    // registry DENTRO da capability — vir pelo corpo nao o torna
    // confiavel, e a barreira tem de estar do lado do dominio.
    const resultado = await definirPermissaoDeFuncaoDoAgente({
      userId: porta.userId,
      agenteId: porta.agenteId,
      funcaoId: leitura.funcaoId,
      nivel: leitura.nivel,
    });

    // A Funcao desconhecida ja foi barrada acima; `entrada_invalida`
    // aqui so pode ser defeito nosso, mas continua mapeada como erro do
    // CLIENTE para nao virar 500 no dia em que as duas listas
    // divergirem.
    if (resultado.estado === "entrada_invalida") {
      return responder({ ok: false, erro: "Definição inválida." }, 400);
    }
    // A porta ja provou a propriedade do agente; a FK so recusaria numa
    // corrida com a exclusao do agente. Mesma 404 de sempre.
    if (resultado.estado === "nao_disponivel") {
      return responder({ ok: false, erro: "Agente não encontrado." }, 404);
    }
    if (resultado.estado !== "definida") {
      return responder({ ok: false, erro: FALHA_ESCRITA }, 500);
    }

    return responder(
      { ok: true, permissao: { funcaoId: leitura.funcaoId, nivel: leitura.nivel } },
      200
    );
  } catch {
    return responder({ ok: false, erro: FALHA_ESCRITA }, 500);
  }
}
