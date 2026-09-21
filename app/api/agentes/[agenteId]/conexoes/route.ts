/**
 * Conexoes de UM agente — a superficie de CONFIGURACAO, M2-I1-A4.
 *
 * ── A pergunta que esta rota responde ───────────────────────────────
 *
 *   "quais contas ja conectadas este agente pode usar, e qual esta
 *    escolhida para cada requisito?"
 *
 * Ela NAO conecta conta nenhuma. Nao faz OAuth, nao recebe token, nao
 * cria credencial e nao fala com marketplace. Conectar uma conta e o
 * fluxo do CDS, que ja existe; aqui o dono apenas ESCOLHE entre o que ja
 * esta conectado.
 *
 * ── Connection != Coverage ──────────────────────────────────────────
 *
 * Escolher a conta e confirmar que o provider ainda concede acesso sao
 * perguntas diferentes, e esta rota so responde a primeira. Nenhum
 * `GET /users/{sellerId}/applications` acontece aqui — nem no GET, nem
 * no PATCH.
 *
 * O motivo e de produto, nao de custo: se a elegibilidade dependesse da
 * cobertura remota, um 429, um token vencido ou uma indisponibilidade do
 * Mercado Livre impediriam o dono de CONFIGURAR — exatamente quando ele
 * mais precisa. A cobertura continua sendo apurada na execucao, onde
 * `guard.ts` a exige.
 *
 * ── Quem decide o que ───────────────────────────────────────────────
 *
 *   sessao            `autenticarRequisicao`
 *   dono do agente    `lerAgenteDoDono`
 *   requisito REAL    `resolverConexoesDoAgente(...).requisitos`
 *   loja elegivel     `listarLojasConectadasDoDono(userId, marketplace)`
 *   persistencia      `definirSelecaoDeLoja` / `removerSelecaoDeLoja`
 *
 * O cliente tem autoridade ZERO sobre qualquer um deles. Ele diz QUAL
 * requisito quer configurar e QUAL conta quer usar; se o requisito nao
 * existir de verdade, ou a conta nao estiver na lista, nada e gravado.
 */
import { NextResponse } from "next/server";

import { autenticarRequisicao } from "@/lib/autenticacao";
import { lerAgenteDoDono } from "@/lib/agentes/capability";
import { resolverConexoesDoAgente } from "@/lib/agentes/conexoes/agregador";
import { MARKETPLACE_POR_PLATAFORMA } from "@/lib/agentes/conexoes/estado";
import {
  definirSelecaoDeLoja,
  removerSelecaoDeLoja,
} from "@/lib/agentes/conexoes/selecao-escrita";
import { listarLojasConectadasDoDono } from "@/lib/marketplace/credenciais";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FALHA_LEITURA = "Falha ao ler as conexões.";
const FALHA_ESCRITA = "Falha ao definir a conexão.";

/** `no-store`: a escolha muda por acao do dono e nunca deve vir de cache. */
function responder(corpo: unknown, status: number): NextResponse {
  return NextResponse.json(corpo, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * A loja como a UI a ve. TRES campos, e a lista curta e a defesa.
 *
 * `listarLojasConectadasDoDono` projeta `id, nome, nickname, seller_id,
 * created_at`. Os dois ultimos NAO saem daqui: `seller_id` e identidade
 * externa sem consumidor demonstrado, e `created_at` e ruido. Campo sem
 * leitor e superficie sem contrapartida.
 *
 * Token, refresh e validade nunca estiveram na projecao — e por isso a
 * sanitizacao aqui e recorte, nao filtro de seguranca de ultima hora.
 */
interface LojaElegivel {
  id: string;
  nome: string | null;
  nickname: string | null;
}

/** Sessao + uuid + propriedade do agente. Mesmo portao das demais rotas
 *  de `[agenteId]`, replicado porque `atravessarPorta` e privada a cada
 *  uma delas — extrair um helper comum tocaria quatro rotas publicadas. */
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
  // Inexistente e de outro dono sao a MESMA resposta, de proposito:
  // distingui-las seria um oraculo de existencia de recurso alheio.
  if (linha === null) {
    return { ok: false, resposta: responder({ ok: false, erro: "Agente não encontrado." }, 404) };
  }

  return { ok: true, userId: auth.uid, agenteId: agenteIdBruto };
}

/**
 * As lojas elegiveis, por MARKETPLACE — nunca por requisito.
 *
 * Cinco requisitos de Mercado Livre compartilham a mesma lista de contas,
 * e perguntar cinco vezes seria perguntar a mesma coisa. A chave e o
 * marketplace derivado da plataforma, e o mapa e consultado uma vez por
 * valor distinto.
 *
 * `null` sinaliza falha de leitura: a rota inteira aborta, porque uma
 * lista parcial apresentada como completa faria o dono concluir que a
 * conta dele sumiu.
 */
async function lojasPorMarketplace(
  userId: string,
  plataformas: readonly string[]
): Promise<Map<string, readonly LojaElegivel[]> | null> {
  const marketplaces = new Set<string>();
  for (const p of plataformas) {
    const m = MARKETPLACE_POR_PLATAFORMA[p];
    if (m !== undefined) marketplaces.add(m);
  }

  const porMarketplace = new Map<string, readonly LojaElegivel[]>();
  for (const marketplace of marketplaces) {
    const { linhas, erro } = await listarLojasConectadasDoDono(userId, marketplace);
    if (erro !== null) return null;
    porMarketplace.set(
      marketplace,
      linhas.map((l) => ({ id: l.id, nome: l.nome ?? null, nickname: l.nickname ?? null }))
    );
  }

  return porMarketplace;
}

export async function GET(request: Request, { params }: { params: { agenteId: string } }) {
  try {
    const porta = await atravessarPorta(request, params.agenteId, FALHA_LEITURA);
    if (!porta.ok) return porta.resposta;

    const resolvido = await resolverConexoesDoAgente({
      userId: porta.userId,
      agenteId: porta.agenteId,
      agoraMs: Date.now(),
    });
    if (resolvido.coleta !== "ok") {
      return responder({ ok: false, erro: FALHA_LEITURA }, 500);
    }

    const lojas = await lojasPorMarketplace(
      porta.userId,
      resolvido.requisitos.map((r) => r.plataforma)
    );
    if (lojas === null) return responder({ ok: false, erro: FALHA_LEITURA }, 500);

    // `marketplace` e DERIVADO aqui, server-side. Aceita-lo do cliente
    // transformaria um rotulo em autoridade sobre qual lista de contas
    // aparece para qual requisito.
    const conexoes = resolvido.requisitos.map((r) => {
      const marketplace = MARKETPLACE_POR_PLATAFORMA[r.plataforma] ?? null;
      return {
        plataforma: r.plataforma,
        recurso: r.recurso,
        obrigatoria: r.obrigatoria,
        marketplace,
        lojaIdSelecionada: r.lojaIdSelecionada,
        // `false` com `lojaIdSelecionada` preenchido e a informacao que o
        // dono precisa para agir: a conta escolhida nao serve.
        utilizavel: r.utilizavel,
        lojasElegiveis: marketplace === null ? [] : lojas.get(marketplace) ?? [],
      };
    });

    return responder({ ok: true, conexoes }, 200);
  } catch {
    return responder({ ok: false, erro: FALHA_LEITURA }, 500);
  }
}

/** O corpo aceito. FECHADO: chave desconhecida recusa. */
type LeituraCorpo =
  | { ok: true; plataforma: string; recurso: string; lojaId: string | null }
  | { ok: false };

/**
 * Le e valida a FORMA do corpo. Nao valida requisito nem loja — isso e
 * autoridade de dominio e acontece depois, com o agregador na mao.
 *
 * Fechado nos dois sentidos: falta chave, sobra chave, ou tipo errado, e
 * 400. Um corpo com `nivel`, `userId` ou `agenteId` e recusado — aceitar
 * e ignorar ensinaria o cliente a mandar, e um dia alguem leria.
 */
async function corpoDoPatch(request: Request): Promise<LeituraCorpo> {
  let bruto: unknown;
  try {
    bruto = await request.json();
  } catch {
    return { ok: false };
  }

  if (typeof bruto !== "object" || bruto === null || Array.isArray(bruto)) {
    return { ok: false };
  }

  const o = bruto as Record<string, unknown>;
  const chaves = Object.keys(o).sort();
  if (JSON.stringify(chaves) !== JSON.stringify(["lojaId", "plataforma", "recurso"])) {
    return { ok: false };
  }

  if (typeof o.plataforma !== "string" || o.plataforma.length === 0) return { ok: false };
  if (typeof o.recurso !== "string" || o.recurso.length === 0) return { ok: false };
  if (o.lojaId !== null && (typeof o.lojaId !== "string" || o.lojaId.length === 0)) {
    return { ok: false };
  }

  return { ok: true, plataforma: o.plataforma, recurso: o.recurso, lojaId: o.lojaId };
}

export async function PATCH(request: Request, { params }: { params: { agenteId: string } }) {
  try {
    const porta = await atravessarPorta(request, params.agenteId, FALHA_ESCRITA);
    if (!porta.ok) return porta.resposta;

    const corpo = await corpoDoPatch(request);
    if (!corpo.ok) return responder({ ok: false, erro: "Corpo inválido." }, 400);

    // ── O REQUISITO primeiro, e a loja depois ─────────────────────
    //
    // A ordem nao e estilo. Provar o requisito antes de olhar a conta
    // impede que um cliente use esta rota para sondar quais lojas do dono
    // existem: sem requisito real, a resposta e a mesma qualquer que seja
    // o `lojaId` enviado.
    const resolvido = await resolverConexoesDoAgente({
      userId: porta.userId,
      agenteId: porta.agenteId,
      agoraMs: Date.now(),
    });
    if (resolvido.coleta !== "ok") {
      return responder({ ok: false, erro: FALHA_ESCRITA }, 500);
    }

    const requisito = resolvido.requisitos.find(
      (r) => r.plataforma === corpo.plataforma && r.recurso === corpo.recurso
    );
    // Plataforma conhecida e recurso com slug valido NAO bastam: o que
    // vale e o requisito existir PARA ESTE agente. Sem ele, gravar
    // criaria um vinculo que nenhuma Skill e nenhuma Funcao pediram.
    if (requisito === undefined) {
      return responder(
        { ok: false, erro: "Requisito não configurado para este agente." },
        409
      );
    }

    if (corpo.lojaId === null) {
      const r = await removerSelecaoDeLoja({
        userId: porta.userId,
        agenteId: porta.agenteId,
        plataforma: corpo.plataforma,
        recurso: corpo.recurso,
      });
      // `nao_encontrada` NAO e erro: apagar o que ja nao existe alcancou
      // o estado pedido. Devolver falha faria a UI mostrar erro para uma
      // tela que ja esta correta.
      if (r.estado !== "removida" && r.estado !== "nao_encontrada") {
        return responder({ ok: false, erro: FALHA_ESCRITA }, 500);
      }
      return responder(
        { ok: true, conexao: { ...corpo, lojaId: null } },
        200
      );
    }

    // ── A LISTA de elegiveis E a validacao ────────────────────────
    //
    // `listarLojasConectadasDoDono` ja filtra por `user_id`, por
    // `marketplace` e por `ativo`. Conferir a pertinencia contra ela
    // cobre dono, provedor e estado de uma vez — uma segunda regra
    // paralela divergiria dela no primeiro conserto feito so de um lado.
    const lojas = await lojasPorMarketplace(porta.userId, [corpo.plataforma]);
    if (lojas === null) return responder({ ok: false, erro: FALHA_ESCRITA }, 500);

    const marketplace = MARKETPLACE_POR_PLATAFORMA[corpo.plataforma];
    const elegiveis = marketplace === undefined ? [] : lojas.get(marketplace) ?? [];

    // Inexistente, alheia, inativa e de marketplace incompativel colapsam
    // na MESMA resposta: distingui-las diria ao cliente o que existe do
    // outro lado da cerca.
    if (!elegiveis.some((l) => l.id === corpo.lojaId)) {
      return responder({ ok: false, erro: "Conta indisponível para este requisito." }, 409);
    }

    const r = await definirSelecaoDeLoja({
      userId: porta.userId,
      agenteId: porta.agenteId,
      plataforma: corpo.plataforma,
      recurso: corpo.recurso,
      lojaId: corpo.lojaId,
    });

    if (r.estado === "entrada_invalida") {
      return responder({ ok: false, erro: "Corpo inválido." }, 400);
    }
    // A porta ja provou a propriedade do agente e a lista provou a da
    // loja; `nao_disponivel` aqui so pode ser corrida com a exclusao de
    // um dos dois. Mesma 404 de sempre.
    if (r.estado === "nao_disponivel") {
      return responder({ ok: false, erro: "Agente não encontrado." }, 404);
    }
    if (r.estado !== "definida") {
      return responder({ ok: false, erro: FALHA_ESCRITA }, 500);
    }

    return responder({ ok: true, conexao: { ...corpo } }, 200);
  } catch {
    return responder({ ok: false, erro: FALHA_ESCRITA }, 500);
  }
}
