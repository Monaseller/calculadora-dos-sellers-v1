/**
 * A IA de UM agente — AGENT-FACTORY-F7b.4.2 §7/§9.
 *
 * GET    quais IAs este ambiente oferece, e qual este agente escolheu
 * PATCH  grava a escolha, ou a limpa
 *
 * ── Rota propria, pelo mesmo motivo de `/ativacao` e `/memoria` ──────
 *
 * `/agentes/[id]` aceita SO `nome` e `instrucoes`, e a suite cobra essa
 * allowlist. Alargá-la para caber `provedor_ia` tiraria a prova de que
 * `ativo`, `tipo` e `user_id` nao tem caminho de escrita por ali.
 *
 * ── O browser escolhe o PROVEDOR. Nunca o model id ──────────────────
 *
 * Esta rota ignora qualquer `modelo` que venha no corpo. O id concreto
 * (`gpt-5.2`, `claude-...`) e lido do catalogo, que le env — porque quem
 * atualiza a versao do modelo e a operacao, e nao o dono do agente.
 *
 * Aceitar um model id do cliente abriria duas portas de uma vez: cobrar
 * chamada num modelo que ninguem aprovou, e gravar um id inventado que so
 * falharia na hora do chat, longe da tela onde foi digitado.
 *
 * ── Escolha INDISPONIVEL e recusada na ESCRITA ──────────────────────
 *
 * Nao da para gravar um provedor que este ambiente nao tem. A ativacao
 * tambem barra esse estado (`ia_escolhida_indisponivel`), mas ela existe
 * para o caso que chega de FORA do nosso controle — a chave caiu depois de
 * a escolha ter sido gravada. Deixar a tela criar esse estado de proposito
 * seria fabricar o problema que a outra regra existe para sobreviver.
 *
 * ── E esta rota nao concede nada ────────────────────────────────────
 *
 * Escreve tres colunas de `agentes`. Nao toca `agente_permissoes`, nao
 * toca `agente_ferramentas_externas`, nao declara ferramenta e nao ativa
 * agente. Trocar de IA nao muda o que o agente pode fazer.
 */
import { atravessarPorta, lerCorpo, responder } from "@/lib/agentes/api/porta";
import { atualizarAgenteDoDono, lerAgenteDoDono } from "@/lib/agentes/capability";
import { modelosDisponiveis, rotuloDoNivel } from "@/lib/agentes/factory/catalogo-de-modelos";
import { resolverIaDoAgente } from "@/lib/agentes/factory/ia-do-agente";

export const dynamic = "force-dynamic";

const FALHA = "Nao foi possivel carregar as opcoes de IA.";

/** O mesmo formato no GET e na resposta do PATCH: a tela le um so. */
function corpoDoEstado(linha: {
  provedor_ia: string | null;
  modelo_ia: string | null;
  nivel_de_trabalho: string | null;
}) {
  const disponiveis = modelosDisponiveis();
  const ia = resolverIaDoAgente({
    provedorGravado: linha.provedor_ia,
    modeloGravado: linha.modelo_ia,
    nivelGravado: linha.nivel_de_trabalho,
    disponiveis,
  });
  return {
    escolha: {
      provedor: ia.provedorEscolhido,
      nivel: ia.nivelEscolhido,
      // Divergencia e INFORMADA, nao corrigida em silencio: se o ambiente
      // trocou o model id desde a escolha, a tela pode dizer.
      modeloDivergente: ia.modeloEscolhidoDivergente,
      nivelDivergente: ia.nivelEscolhidoDivergente,
    },
    // O que VAI responder, que e diferente do que foi escolhido quando a
    // escolha nao esta disponivel.
    efetivo: { provedor: ia.provedor, modelo: ia.modelo, nivel: ia.nivel },
    desfecho: ia.desfecho,
    // Sem nome de env e sem chave: so o que a tela precisa desenhar.
    opcoes: disponiveis.map((m) => ({
      provedor: m.provedor,
      nome: m.nomeVisivel,
      descricao: m.descricao,
      modeloId: m.modeloId,
      ferramentas: m.ferramentas,
      niveis: m.niveis.map((n) => ({ id: n, rotulo: rotuloDoNivel(n) })),
    })),
  };
}

export async function GET(request: Request, { params }: { params: { agenteId: string } }) {
  try {
    const porta = await atravessarPorta(request, params.agenteId, FALHA);
    if (!porta.ok) return porta.resposta;

    const { linha } = await lerAgenteDoDono(porta.agenteId, porta.userId);
    if (!linha) return responder({ ok: false, erro: "Agente não encontrado." }, 404);

    return responder({ ok: true, ...corpoDoEstado(linha) }, 200);
  } catch {
    return responder({ ok: false, erro: FALHA }, 500);
  }
}

export async function PATCH(request: Request, { params }: { params: { agenteId: string } }) {
  try {
    const porta = await atravessarPorta(request, params.agenteId, FALHA);
    if (!porta.ok) return porta.resposta;

    const corpo = await lerCorpo(request);
    if (corpo === null || !("provedor" in corpo)) {
      return responder({ ok: false, erro: "Informe `provedor`." }, 400);
    }

    // ── `null` LIMPA a escolha ────────────────────────────────────────
    //
    // Volta ao default do ambiente, que e o estado de todo agente criado
    // antes destas colunas. As tres colunas caem juntas: deixar um nivel
    // gravado sem provedor deixaria um rotulo orfao, pertencente a um
    // provedor que ninguem selecionou.
    if (corpo.provedor === null) {
      const { linha, erro } = await atualizarAgenteDoDono(porta.agenteId, porta.userId, {
        provedorIa: null, modeloIa: null, nivelDeTrabalho: null,
      });
      if (erro !== null || !linha) {
        return responder({ ok: false, erro: FALHA }, erro === null ? 404 : 500);
      }
      return responder({ ok: true, ...corpoDoEstado(linha) }, 200);
    }

    if (typeof corpo.provedor !== "string" || corpo.provedor.trim() === "") {
      return responder({ ok: false, erro: "Informe `provedor`." }, 400);
    }
    const provedor = corpo.provedor.trim();

    const opcao = modelosDisponiveis().find((m) => m.provedor === provedor);
    if (opcao === undefined) {
      // 409, e nao 400: o pedido esta bem formado, e o estado do ambiente
      // que nao comporta. A frase nao diz qual env falta.
      return responder({
        ok: false,
        erro: "Esta IA não está disponível neste ambiente.",
      }, 409);
    }

    // ── O nivel, quando vier, tem de existir NESTE provedor ───────────
    //
    // `null`/ausente = usar o default do adaptador. Um rotulo que o
    // provedor nao oferece e RECUSADO em vez de virar default: a pessoa
    // escolheu "maximo" e merece saber que nao foi aplicado.
    let nivel: string | null = null;
    if (corpo.nivel !== undefined && corpo.nivel !== null) {
      if (typeof corpo.nivel !== "string" || corpo.nivel.trim() === "") {
        return responder({ ok: false, erro: "Nível inválido." }, 400);
      }
      nivel = corpo.nivel.trim();
      if (!(opcao.niveis as readonly string[]).includes(nivel)) {
        return responder({
          ok: false,
          erro: "Este nível de trabalho não existe para a IA escolhida.",
        }, 400);
      }
    }

    const { linha, erro } = await atualizarAgenteDoDono(porta.agenteId, porta.userId, {
      provedorIa: provedor,
      // Do CATALOGO, nunca do corpo. Ver o docblock.
      modeloIa: opcao.modeloId,
      nivelDeTrabalho: nivel,
    });
    if (erro !== null || !linha) {
      return responder({ ok: false, erro: FALHA }, erro === null ? 404 : 500);
    }

    return responder({ ok: true, ...corpoDoEstado(linha) }, 200);
  } catch {
    return responder({ ok: false, erro: FALHA }, 500);
  }
}
