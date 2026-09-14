/**
 * `/api/agentes/[agenteId]/consultar-vendas` — FUNCTION-RUNTIME-V1-B2A.
 *
 * A primeira superficie em que uma Funcao REAL vira trabalho da fila.
 *
 * ── O que esta rota e, e o que ela nao e ────────────────────────────
 *
 * Ela e um PRODUTOR de tarefa. `POST` valida o pedido, cria uma
 * `consultar_vendas` e devolve 202; `GET` conta como ela esta. Quem
 * executa e o dispatcher publicado na V1-B1, chamado pelo Vercel Cron a
 * cada minuto — nao esta rota, que nunca reivindica, nunca executa e
 * nunca chama Funcao.
 *
 * ── Por que dedicada, e nao um runner generico ──────────────────────
 *
 * Existe UMA Funcao executavel na superficie. Um endpoint que recebesse
 * `funcaoId` no corpo transformaria a escolha da Funcao em entrada do
 * cliente e exigiria um renderizador de argumentos por schema — muito
 * poder e muita superficie para um consumidor so. Quando houver a
 * segunda Funcao, a duplicacao dira o que generalizar; hoje ela nao
 * diria nada.
 *
 * ── Autoridade ──────────────────────────────────────────────────────
 *
 * Esta rota NAO consulta `agente_permissoes`. A autorizacao de Funcao e
 * de `executarFuncao`, no runtime, que ja produz `negado`,
 * `aguardando_aprovacao` ou sucesso. Pre-checar aqui criaria uma segunda
 * autoridade, e duas autoridades divergem — a pergunta deixaria de ter
 * uma resposta. A UI usa o nivel de permissao apenas para UX.
 *
 * O que ela valida e o PEDIDO: chaves fechadas e filtro bem formado,
 * para que um erro de digitacao vire 400 agora, em vez de uma tarefa que
 * nasce so para falhar daqui a um minuto. `validarFiltroVendas` e a
 * mesma funcao pura que o handler usa — nao ha segunda copia da regra de
 * janela, de data ou do enum de marketplace. E o handler revalida por
 * conta propria: o que chega ate ele pode ter vindo de outro caminho.
 */
import { NextResponse } from "next/server";

import { autenticarRequisicao } from "@/lib/autenticacao";
import { criarTarefa, lerAgenteDoDono, lerTarefaDoDono } from "@/lib/agentes/capability";
import { validarFiltroVendas, type FiltroVendas } from "@/lib/agentes/dados/vendas";
import { TIPO_CONSULTAR_VENDAS } from "@/lib/agentes/handlers/consultar-vendas";
// O vocabulario CANONICO de falha. Importado, nunca reescrito — mesma
// razao da rota de conversa: uma segunda lista aqui envelheceria no dia
// em que uma categoria nova entrasse.
import { TIPOS_ERRO_TAREFA } from "@/lib/agentes/tipos-execucao";

export const dynamic = "force-dynamic";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * As UNICAS chaves aceitas no corpo do POST.
 *
 * `tipo`, `status`, `progresso`, `max_tentativas`, `user_id`, `userId`,
 * `agente_id`, `agenteId`, `funcaoId` e `resultado` caem todas fora —
 * sao exatamente as que alguem tentaria para trocar de dono, de agente,
 * de Funcao ou de estado. O conjunto e fechado por INCLUSAO, nunca por
 * lista de proibidas: uma chave nova e perigosa nasceria permitida.
 */
const CAMPOS_ENTRADA = new Set(["dataInicio", "dataFim", "marketplace"]);

function responder(corpo: unknown, status: number): NextResponse {
  return NextResponse.json(corpo, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * Projeta `erro_tipo` pelo vocabulario que o CODIGO conhece.
 *
 * `agente_tarefas.erro_tipo` e `text` SEM CHECK de pertencimento — o
 * fechamento existe so em TypeScript, em `classificarErro`. Esta rota
 * nao apresenta como confiavel um valor que o banco nao fecha, entao
 * desconhecido vira `null`: nunca outro tipo conhecido, nunca um
 * generico, porque mapear para categoria existente inventaria uma
 * classificacao que ninguem fez.
 */
function erroTipoConhecido(bruto: unknown): string | null {
  if (typeof bruto !== "string") return null;
  return (TIPOS_ERRO_TAREFA as readonly string[]).includes(bruto) ? bruto : null;
}

type LeituraCorpo =
  | { ok: false }
  | { ok: true; filtro: FiltroVendas; marketplaceInformado: boolean };

/**
 * O corpo, campo a campo.
 *
 * Nunca `{...corpo}`: um spread deixaria qualquer chave do chamador
 * chegar a `entrada` da tarefa, e `entrada` e `jsonb` livre — o handler
 * reprova propriedade extra, mas descobrir isso um minuto depois, com a
 * tarefa ja em `erro`, seria tarde e barulhento.
 */
async function filtroDoCorpo(request: Request): Promise<LeituraCorpo> {
  const texto = await request.text().catch(() => "");
  // Corpo ausente nao vale como "periodo vazio": as duas datas sao
  // obrigatorias, entao POST sem corpo e erro do chamador.
  if (texto.trim().length === 0) return { ok: false };

  let corpo: unknown;
  try {
    corpo = JSON.parse(texto);
  } catch {
    return { ok: false };
  }

  if (typeof corpo !== "object" || corpo === null || Array.isArray(corpo)) {
    return { ok: false };
  }

  for (const chave of Object.keys(corpo)) {
    if (!CAMPOS_ENTRADA.has(chave)) return { ok: false };
  }

  const { dataInicio, dataFim, marketplace } = corpo as {
    dataInicio?: unknown;
    dataFim?: unknown;
    marketplace?: unknown;
  };

  // Tipo de transporte apenas. O FORMATO da data, a janela e o enum de
  // marketplace sao de `validarFiltroVendas` — repetir aqui criaria a
  // segunda copia da regra que este slice existe para nao ter.
  if (typeof dataInicio !== "string" || typeof dataFim !== "string") {
    return { ok: false };
  }
  if (marketplace !== undefined && marketplace !== null && typeof marketplace !== "string") {
    return { ok: false };
  }

  // Ausente e `null` sao o MESMO pedido — "todos os marketplaces" —, e e
  // assim que `lerEntradaConsultarVendas` ja os trata. Por isso a chave
  // so viaja quando o chamador escolheu um: `entrada` fica minima e o
  // pedido continua dizendo a mesma coisa.
  const marketplaceInformado = typeof marketplace === "string";

  return {
    ok: true,
    filtro: marketplaceInformado
      ? ({ dataInicio, dataFim, marketplace } as FiltroVendas)
      : ({ dataInicio, dataFim } as FiltroVendas),
    marketplaceInformado,
  };
}

export async function POST(request: Request, { params }: { params: { agenteId: string } }) {
  try {
    // 1) Sessao. `motivo` morre aqui: para quem chama, 401 e 401.
    const auth = await autenticarRequisicao(request);
    if (!auth.autenticado) {
      return responder({ ok: false, erro: "Não autenticado." }, 401);
    }

    // 2) O agente vem do SEGMENTO, nunca do corpo.
    const { agenteId } = params;
    if (!UUID_REGEX.test(agenteId)) {
      return responder({ ok: false, erro: "agenteId inválido." }, 400);
    }

    // 3) Corpo antes do banco: payload invalido nao merece uma consulta.
    const corpo = await filtroDoCorpo(request);
    if (!corpo.ok) {
      return responder({ ok: false, erro: "Entrada inválida." }, 400);
    }

    // 4) O FILTRO, pela funcao pura que o handler tambem usa. Uma tarefa
    //    criada com janela de 30 dias so existiria para falhar — e o
    //    dono descobriria isso um minuto depois, num card vermelho.
    const validacao = validarFiltroVendas(corpo.filtro);
    if (validacao.erro) {
      // O codigo e de DOMINIO e estavel (`janela_excedida`,
      // `data_invalida`, ...). Sai porque a UI precisa dizer o que
      // corrigir; nao ha stack, nem mensagem de driver, nem detalhe.
      return responder({ ok: false, erro: validacao.erro }, 400);
    }

    // 5) O agente precisa ser DO DONO. `auth.uid` e a unica origem do
    //    usuario — nao ha corpo, query, header ou segmento por onde
    //    escolher outro.
    const { linha: agente, erro: erroAgente } = await lerAgenteDoDono(agenteId, auth.uid);
    if (erroAgente) {
      return responder({ ok: false, erro: "Falha ao criar a consulta." }, 500);
    }
    // Inexistente e de-outro-dono terminam IGUAIS: distinguir os dois
    // faria desta rota um oraculo de existencia de agentes alheios.
    if (!agente) {
      return responder({ ok: false, erro: "Agente não encontrado." }, 404);
    }
    // O claim ja recusa tarefa de agente inativo; enfileirar mesmo assim
    // criaria uma tarefa que nunca sairia de `pendente`.
    if (!agente.ativo) {
      return responder({ ok: false, erro: "agente_inativo" }, 409);
    }

    // 6) `tipo` e FIXADO aqui, e `entrada` e montada campo a campo.
    //    `max_tentativas` nao viaja: o DEFAULT do banco continua sendo a
    //    fonte unica desse numero.
    const entrada: Record<string, unknown> = {
      dataInicio: corpo.filtro.dataInicio,
      dataFim: corpo.filtro.dataFim,
    };
    if (corpo.marketplaceInformado) {
      entrada.marketplace = corpo.filtro.marketplace;
    }

    const { linha: tarefa, erro: erroTarefa } = await criarTarefa(agenteId, auth.uid, {
      tipo: TIPO_CONSULTAR_VENDAS,
      entrada,
    });

    if (erroTarefa === "agente_inexistente_ou_de_outro_dono") {
      // Corrida: o agente existia no passo 5 e sumiu antes do insert. A
      // resposta e a mesma de nao existir.
      return responder({ ok: false, erro: "Agente não encontrado." }, 404);
    }
    if (erroTarefa || !tarefa) {
      return responder({ ok: false, erro: "Falha ao criar a consulta." }, 500);
    }

    // 202: aceita, ainda nao executada. Um 200 diria que o resultado ja
    // existe — e ele so existira quando o dispatcher reivindicar a
    // tarefa, o que leva ate a proxima janela do cron, mais a fila.
    return responder({ ok: true, tarefaId: tarefa.id, status: tarefa.status }, 202);
  } catch {
    // `autenticarRequisicao` LANCA se `SESSION_SECRET` faltar —
    // indisponibilidade e melhor que autenticar sem verificar. O erro nao
    // e inspecionado nem logado: qualquer detalhe daqui e material de
    // reconhecimento.
    return responder({ ok: false, erro: "Falha ao criar a consulta." }, 500);
  }
}

export async function GET(request: Request, { params }: { params: { agenteId: string } }) {
  try {
    const auth = await autenticarRequisicao(request);
    if (!auth.autenticado) {
      return responder({ ok: false, erro: "Não autenticado." }, 401);
    }

    const { agenteId } = params;
    if (!UUID_REGEX.test(agenteId)) {
      return responder({ ok: false, erro: "agenteId inválido." }, 400);
    }

    const tarefaId = new URL(request.url).searchParams.get("tarefaId") ?? "";
    if (!UUID_REGEX.test(tarefaId)) {
      return responder({ ok: false, erro: "tarefaId inválido." }, 400);
    }

    // Leitura TENANT-SCOPED: `lerTarefaDoDono` filtra por `id` E
    // `user_id`. `lerTarefaParaExecucao` NAO serve aqui — ela e a leitura
    // interna do executor, que nao tem sessao e nao representa fronteira
    // de dono.
    const { linha: tarefa, erro } = await lerTarefaDoDono(tarefaId, auth.uid);
    if (erro) {
      return responder({ ok: false, erro: "Falha ao consultar." }, 500);
    }

    // ── AS TRES PERNAS DO BINDING, e por que o 404 e o mesmo ────────
    //
    // Tarefa de outro dono, tarefa de outro agente e tarefa de outro
    // TIPO sao indistinguiveis de fora. Qualquer diferenca — status,
    // corpo, codigo, tempo — viraria um canal para descobrir o que
    // existe. A terceira perna nao e zelo: sem ela, um `tarefaId` de
    // conversa lido por esta rota devolveria o `resultado` de uma
    // conversa no lugar de um resumo de vendas.
    if (!tarefa) {
      return responder({ ok: false, erro: "Consulta não encontrada." }, 404);
    }
    if (tarefa.agente_id !== agenteId) {
      return responder({ ok: false, erro: "Consulta não encontrada." }, 404);
    }
    if (tarefa.tipo !== TIPO_CONSULTAR_VENDAS) {
      return responder({ ok: false, erro: "Consulta não encontrada." }, 404);
    }

    // So tarefa CONCLUIDA tem resultado. Para pendente, rodando,
    // aguardando aprovacao ou falhada, `resultado` e `null` — e isso e
    // uma afirmacao, nao um campo que faltou.
    //
    // O resultado NAO e recalculado nem paginado aqui: o handler ja
    // persistiu um agregado de tamanho constante (periodo, resumo, tres
    // buckets fixos, truncado). Esta rota so o projeta.
    let resultado: Record<string, unknown> | null = null;
    if (tarefa.status === "concluido") {
      const bruto = tarefa.resultado;
      if (typeof bruto !== "object" || bruto === null || Array.isArray(bruto)) {
        // Concluida sem objeto no `resultado` e defeito interno.
        // Devolver 200 com `null` diria "ainda processando" sobre algo
        // que ja terminou, e devolver o valor cru poria `jsonb`
        // arbitrario na resposta.
        return responder({ ok: false, erro: "erro_interno" }, 500);
      }
      resultado = bruto as Record<string, unknown>;
    }

    // Projecao por ALLOWLIST. Ficam de fora, deliberadamente:
    // `user_id` (tenant), `agente_id` e `tipo` (quem pergunta ja os
    // conhece — devolve-los so confirmaria um palpite), `entrada`
    // (`jsonb` livre), `heartbeat_em` (relogio interno do executor),
    // `tentativas`/`max_tentativas` (politica de retry, nao estado do
    // pedido) e `erro_mensagem` — que e `err.message` truncado e depende
    // de todo `throw` de todo handler, presente e futuro.
    return responder(
      {
        ok: true,
        tarefa: {
          id: tarefa.id,
          status: tarefa.status,
          resultado,
          erroTipo: erroTipoConhecido(tarefa.erro_tipo),
          criadoEm: tarefa.criado_em,
          iniciadoEm: tarefa.iniciado_em,
          concluidoEm: tarefa.concluido_em,
        },
      },
      200
    );
  } catch {
    return responder({ ok: false, erro: "Falha ao consultar." }, 500);
  }
}
