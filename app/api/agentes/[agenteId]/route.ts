/**
 * PATCH /api/agentes/[agenteId] — EDITAR-AGENTE-V1.
 *
 * A primeira superficie de ALTERACAO da area de IA. Ate aqui a area
 * sabia criar agente e criar conversa, e nada mais: `instrucoes`
 * gravadas na criacao eram definitivas, e corrigir uma frase exigia
 * apagar o agente e recriar. Esta rota fecha esse buraco — e so ele.
 *
 * ── A doutrina que esta rota revoga, e o quanto dela sobrevive ──────
 *
 * As suites da area vetavam PUT, PATCH e DELETE com uma frase: "esta
 * area cria, nunca altera nem apaga". A revogacao foi ratificada e e
 * PARCIAL. PATCH entra, para UM recurso e DOIS campos. PUT e DELETE
 * continuam proibidos: substituir o recurso inteiro reabriria por
 * omissao os campos que este contrato fecha, e apagar agente e frente
 * propria, com tarefas, aprovacoes e auditoria penduradas nele.
 *
 * ── Contrato FECHADO, e a recusa vem antes do valor ─────────────────
 *
 * So `nome` e `instrucoes` sao aceitos, e a allowlist e conferida ANTES
 * de qualquer validacao de conteudo. Uma chave a mais reprova o pedido
 * inteiro — mesmo acompanhada de chave valida, mesmo que a capability a
 * fosse ignorar de qualquer forma. Ignorar em silencio ensina o cliente
 * a mandar o campo; recusar ensina que ele nao existe.
 *
 * Isso e defesa em profundidade deliberada: hoje `ativo` e `tipo` nao
 * tem caminho ate o UPDATE porque o objeto entregue ao dominio e
 * montado campo a campo. A allowlist garante que continuem sem caminho
 * no dia em que alguem afrouxar a montagem.
 *
 * ── Adapter, nao dominio ────────────────────────────────────────────
 *
 * Autentica, le o corpo, monta no maximo dois campos e delega.
 * `atualizarAgenteDoDono` ja apara `nome`, ja recusa vazio, ja escopa
 * por `(id, user_id)` na PROPRIA instrucao e ja mantem
 * `atualizado_em`. Nada disso e reimplementado aqui.
 *
 * Uma coisa ELA NAO faz, e por isso esta rota faz: `instrucoes` de tipo
 * errado viram `null` na capability — um numero APAGARIA as instrucoes
 * em silencio. Aqui `instrucoes` so passa como string ou `null`
 * explicito; qualquer outra coisa e 400. Limpar instrucoes continua
 * sendo operacao legitima, mas precisa ser pedida, nunca deduzida de um
 * valor invalido.
 *
 * ── O que nunca sai daqui ───────────────────────────────────────────
 *
 * A mesma projecao de seis campos do `POST /api/agentes`: `user_id` e
 * `atualizado_em` ficam de fora. Agente inexistente e agente de outro
 * dono produzem a MESMA 404 — distinguir os dois viraria um oraculo de
 * existencia de ids alheios.
 */
import { NextResponse } from "next/server";

import { autenticarRequisicao } from "@/lib/autenticacao";
import { atualizarAgenteDoDono } from "@/lib/agentes/capability";
import type { LinhaAgente } from "@/lib/agentes/tipos";

/** Recurso privado por dono, que muda a cada edicao. Nunca cacheado. */
export const dynamic = "force-dynamic";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * As UNICAS duas chaves aceitas no corpo.
 *
 * `ativo`, `tipo`, `id`, `user_id`, `criado_em` e `atualizado_em` caem
 * todos fora — sao exatamente as chaves que alguem tentaria para trocar
 * de dono, desligar o agente, mudar o que ele e ou reescrever o tempo.
 */
const CAMPOS_ALTERACAO = new Set(["nome", "instrucoes"]);

/** Ponto unico de saida: nenhum branch pode esquecer o `no-store`. */
function responder(corpo: unknown, status: number): NextResponse {
  return NextResponse.json(corpo, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * Os seis campos publicos de um agente — campo a campo, nunca spread.
 *
 * Identica a projecao do `POST /api/agentes`, e deliberadamente
 * repetida em vez de importada: as duas rotas publicam o mesmo contrato
 * hoje, e um helper compartilhado faria uma coluna nova vazar nas duas
 * de uma vez.
 */
function paraResposta(linha: LinhaAgente) {
  return {
    id: linha.id,
    nome: linha.nome,
    tipo: linha.tipo,
    instrucoes: linha.instrucoes,
    ativo: linha.ativo,
    criado_em: linha.criado_em,
  };
}

/**
 * O que o corpo autoriza alterar.
 *
 * `corpo` distingue "nao consegui ler isto como pedido" de
 * `alteracao`, que e "li, e o pedido nao e aceitavel". `nome` tem
 * codigo proprio porque e o unico erro que o usuario corrige digitando
 * de novo — os outros ele nao tem como corrigir, porque descrevem um
 * cliente mandando o que nao devia.
 */
type LeituraAlteracao =
  | { ok: true; campos: { nome?: string; instrucoes?: string | null } }
  | { ok: false; causa: "corpo" | "alteracao" | "nome" };

async function alteracaoDoCorpo(request: Request): Promise<LeituraAlteracao> {
  const texto = await request.text().catch(() => "");
  // Corpo ausente nao e "nada a alterar": e pedido malformado. Um PATCH
  // sem corpo nao expressa intencao nenhuma.
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

  const chaves = Object.keys(corpo);
  // Vazio reprova: `{}` nao e uma alteracao, e aceita-lo como no-op
  // devolveria 200 sem nada ter mudado.
  if (chaves.length === 0) return { ok: false, causa: "alteracao" };
  // ALLOWLIST ANTES DO VALOR. Uma chave estranha condena o pedido
  // inteiro, mesmo que venha junto de `nome` perfeitamente valido.
  for (const chave of chaves) {
    if (!CAMPOS_ALTERACAO.has(chave)) return { ok: false, causa: "alteracao" };
  }

  const bruto = corpo as { nome?: unknown; instrucoes?: unknown };
  const campos: { nome?: string; instrucoes?: string | null } = {};

  if (chaves.includes("nome")) {
    if (typeof bruto.nome !== "string") return { ok: false, causa: "nome" };
    const nome = bruto.nome.trim();
    if (nome.length === 0) return { ok: false, causa: "nome" };
    campos.nome = nome;
  }

  if (chaves.includes("instrucoes")) {
    // `null` e pedido LEGITIMO de limpar as instrucoes. Numero, booleano
    // e objeto nao sao: a capability os converteria em `null` sem avisar,
    // e apagar conteudo por engano de tipo e perda de trabalho do dono.
    if (bruto.instrucoes !== null && typeof bruto.instrucoes !== "string") {
      return { ok: false, causa: "alteracao" };
    }
    campos.instrucoes = bruto.instrucoes;
  }

  return { ok: true, campos };
}

export async function PATCH(request: Request, { params }: { params: { agenteId: string } }) {
  try {
    // 1) Sessao. `motivo` morre aqui: para quem chama, 401 e 401.
    const auth = await autenticarRequisicao(request);
    if (!auth.autenticado) {
      return responder({ ok: false, erro: "Não autenticado." }, 401);
    }

    // 2) O id vem do CAMINHO, nunca do corpo.
    const agenteId = params.agenteId;
    if (typeof agenteId !== "string" || !UUID_REGEX.test(agenteId)) {
      return responder({ ok: false, erro: "agenteId inválido." }, 400);
    }

    // 3) Contrato fechado, antes de qualquer escrita.
    const leitura = await alteracaoDoCorpo(request);
    if (!leitura.ok) {
      if (leitura.causa === "corpo") {
        return responder(
          { ok: false, erro: "Corpo da requisição inválido (JSON esperado)." },
          400
        );
      }
      if (leitura.causa === "nome") {
        return responder({ ok: false, erro: "nome inválido." }, 400);
      }
      return responder({ ok: false, erro: "Alteração inválida." }, 400);
    }

    // 4) O dono e `auth.uid`, e so ele. O objeto entregue ao dominio tem
    //    no maximo as duas chaves montadas acima.
    const resultado = await atualizarAgenteDoDono(agenteId, auth.uid, leitura.campos);

    // `nome_invalido` ja foi barrado no passo 3 e `nenhum_campo_valido`
    // e inalcancavel com a allowlist nao-vazia. Os dois continuam
    // mapeados: sao erro do CLIENTE, e cai-los no 500 abaixo diria que a
    // culpa foi nossa.
    if (resultado.erro === "nome_invalido") {
      return responder({ ok: false, erro: "nome inválido." }, 400);
    }
    if (resultado.erro === "nenhum_campo_valido") {
      return responder({ ok: false, erro: "Alteração inválida." }, 400);
    }
    if (resultado.erro !== null) {
      return responder({ ok: false, erro: "Falha ao atualizar o agente." }, 500);
    }
    // `null` sem erro = nenhuma linha casou o par (id, user_id).
    // Inexistente e de outro dono sao a MESMA resposta, de proposito.
    if (resultado.linha === null) {
      return responder({ ok: false, erro: "Agente não encontrado." }, 404);
    }

    return responder({ ok: true, agente: paraResposta(resultado.linha) }, 200);
  } catch {
    return responder({ ok: false, erro: "Falha ao atualizar o agente." }, 500);
  }
}
