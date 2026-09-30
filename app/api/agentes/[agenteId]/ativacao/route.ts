/**
 * Ativar e desativar um agente — F7b.1.
 *
 * GET    o que falta para ativar (a tela "Revisar" le daqui)
 * PATCH  liga ou desliga
 *
 * ── Rota propria, e nao um campo no PATCH existente ─────────────────
 *
 * `app/api/agentes/[agenteId]/route.ts` aceita SO `nome` e `instrucoes`,
 * e a suite cobra essa allowlist. Alargá-la para caber `ativo` tiraria
 * a prova de que `ativo`, `tipo` e `user_id` nao tem caminho de escrita
 * por ali — uma garantia que nao vale trocar por um campo a mais.
 *
 * Aqui o unico campo e `ativo`, e ele passa por validacao propria.
 *
 * ── Ativar NAO e salvar ─────────────────────────────────────────────
 *
 * O wizard salva a cada etapa, com o agente em rascunho. Ativar e um ato
 * separado, com regra propria: se falta permissao explicita em alguma
 * Funcao de uma Tool escolhida, NAO ativa — ver
 * `lib/agentes/factory/ativacao.ts`.
 *
 * DESATIVAR nunca e barrado. Desligar tem de ser sempre possivel, mesmo
 * com configuracao pela metade.
 */
import { atravessarPorta, lerCorpo, responder } from "@/lib/agentes/api/porta";
import { atualizarAgenteDoDono, lerAgenteDoDono } from "@/lib/agentes/capability";
import { FUNCOES } from "@/lib/agentes/funcoes/registry";
import { resolverFatosPermissoes } from "@/lib/agentes/permissoes/fatos";
import { validarParaAtivacao } from "@/lib/agentes/factory/ativacao";
import { estadoDosPacks } from "@/lib/agentes/factory/catalogo-ui";
import { modelosDisponiveis } from "@/lib/agentes/factory/catalogo-de-modelos";
import { resolverIaDoAgente } from "@/lib/agentes/factory/ia-do-agente";
import { listarVinculosExternos } from "@/lib/agentes/ferramentas-externas/repositorio";
import { listarPermissoesGravadas } from "@/lib/agentes/permissoes/gravadas";
import { diagnosticarAgente } from "@/lib/agentes/diagnostico/compositor";
import { resolverSelecoesDoAgente } from "@/lib/agentes/conexoes/selecao-fatos";
import { packDaFuncao } from "@/lib/agentes/factory/catalogo-ui";
import { nomeDaPlataforma, MARKETPLACE_POR_PLATAFORMA } from "@/lib/agentes/conexoes/estado";
import { listarLojasConectadasDoDono } from "@/lib/marketplace/credenciais";

export const dynamic = "force-dynamic";

const FALHA = "Nao foi possivel carregar o estado do agente.";

/**
 * O estado completo que a tela Revisar e o PATCH consomem.
 *
 * ── Por que QUATRO leituras, e nao duas — F7b.4.2 ───────────────────
 *
 * `resolverFatosPermissoes` filtra por `funcaoIds` do registry, e isso
 * esta certo para Function interna. Acao externa nao esta no registry, e
 * seria invisivel ali — por isso `listarPermissoesGravadas`, que le TODAS
 * as linhas de permissao, entra junto.
 *
 * E o VINCULO e leitura separada de proposito: e ele, e nao a permissao,
 * que diz quais acoes externas o agente tem (§13). Ler as duas e o que
 * permite distinguir "vinculada e sem decisao" de "nem vinculada".
 */
async function montarEstado(userId: string, agenteId: string) {
  const agoraMs = Date.now();
  const [{ linha }, permissoes, gravadas, vinculos, diagnostico, selecoes] =
    await Promise.all([
      lerAgenteDoDono(agenteId, userId),
      resolverFatosPermissoes({ userId, agenteId, funcaoIds: Object.keys(FUNCOES) }),
      listarPermissoesGravadas({ userId, agenteId }),
      listarVinculosExternos({ userId, agenteId }),
      // F7b.4.8 §3: o que as Skills DECLARAM precisar. O motor ja existia
      // e tinha rota propria de leitura; o que faltava era a prontidao
      // consultar-lo — uma Skill entrava no prompt pedindo um trabalho
      // que o agente nao conseguia fazer.
      diagnosticarAgente({ userId, agenteId, agoraMs }),
      // F7b.4.8 §9: o vinculo de loja. Sem isto um agente com a
      // ferramenta do Mercado Livre e sem loja escolhida ativava, e
      // falhava no primeiro turno com "conexao ausente".
      resolverSelecoesDoAgente({ userId, agenteId }),
    ]);
  if (!linha) return null;
  // Falha de leitura NUNCA vira "nao tem nada": seria apresentar um agente
  // sem ferramenta como pronto para ativar.
  if (permissoes.coleta !== "ok") return "falha_leitura" as const;
  if (gravadas.coleta !== "ok") return "falha_leitura" as const;
  if (vinculos.coleta !== "ok") return "falha_leitura" as const;
  if (diagnostico.coleta !== "ok") return "falha_leitura" as const;
  if (selecoes.coleta !== "ok") return "falha_leitura" as const;

  const fatos = permissoes.fatos.map((p) => ({ funcaoId: p.funcaoId, nivel: p.nivel }));

  const ia = resolverIaDoAgente({
    provedorGravado: linha.provedor_ia,
    modeloGravado: linha.modelo_ia,
    nivelGravado: linha.nivel_de_trabalho,
    disponiveis: modelosDisponiveis(),
  });

  const funcoesExternasVinculadas = vinculos.vinculos.map((v) => v.funcaoId);

  // ── §3/§5: dependencia declarada por Skill, em nome de gente ─────
  //
  // `alvo` e `funcao_id` ou `plataforma/recurso`. Nenhum dos dois entra
  // na frase: a pessoa escolheu "Mercado Livre", e e disso que ela
  // precisa ser avisada.
  const dependenciasDeSkill = diagnostico.diagnosticos.flatMap((d) =>
    [...d.diagnostico.bloqueios, ...d.diagnostico.limitacoes]
      .filter((pend) => pend.tipo === "funcao" || pend.tipo === "conexao")
      .map((pend) => ({
        skillId: d.skillId,
        nome: pend.tipo === "funcao"
          ? (packDaFuncao(pend.alvo)?.nome ?? pend.alvo)
          : nomeDaPlataforma(pend.alvo.split("/")[0] ?? pend.alvo),
        // O pack que RESOLVE — para a tela poder oferecer o botao sem
        // ter de adivinhar o pack pelo nome. `null` quando o que falta
        // nao e uma Funcao de pack (uma conexao, por exemplo).
        packId: pend.tipo === "funcao" ? (packDaFuncao(pend.alvo)?.id ?? null) : null,
        tipo: pend.tipo as "funcao" | "conexao",
        bloqueia: pend.bloqueia,
      })));

  // ── §9: requisito de conexao SEM loja escolhida ─────────────────
  //
  // Duas origens, unidas por `(plataforma, recurso)`:
  //
  //   as Funcoes que o agente PODE usar e declaram `conexaoNecessaria`
  //   os requisitos que as Skills declaram (`semSelecao` do diagnostico)
  //
  // A primeira cobre a ferramenta adicionada direto, que e o caminho do
  // §30. A segunda cobre a Skill. Usar so uma deixaria metade dos
  // agentes ativarem sem loja.
  const jaVinculado = new Set(
    selecoes.selecoes.map((sel) => `${sel.plataforma}/${sel.recurso}`));
  const requisitosAbertos = new Map<string, { plataforma: string; recurso: string }>();
  for (const f of gravadas.permissoes) {
    // `bloqueado` nao precisa de loja: ele nunca vai executar.
    if (f.nivel === "bloqueado") continue;
    const def = Object.prototype.hasOwnProperty.call(FUNCOES, f.funcaoId)
      ? FUNCOES[f.funcaoId] : undefined;
    const req = def?.conexaoNecessaria;
    if (!req) continue;
    const chave = `${req.plataforma}/${req.recurso}`;
    if (jaVinculado.has(chave)) continue;
    requisitosAbertos.set(chave, { plataforma: req.plataforma, recurso: req.recurso });
  }
  for (const req of diagnostico.semSelecao) {
    const chave = `${req.plataforma}/${req.recurso}`;
    if (jaVinculado.has(chave)) continue;
    requisitosAbertos.set(chave, { plataforma: req.plataforma, recurso: req.recurso });
  }
  const conexoesSemLoja = [...requisitosAbertos.values()].map((req) => ({
    plataforma: req.plataforma,
    recurso: req.recurso,
    nome: nomeDaPlataforma(req.plataforma),
  }));

  // ── §10: "Integracoes — Mercado Livre — Monamor" ────────────────
  //
  // O nome da LOJA, e nunca `seller_id` nem o uuid: o dono reconhece
  // "Monamor". Uma consulta por plataforma distinta, e nao uma por
  // vinculo — cinco requisitos de Mercado Livre compartilham a lista.
  const nomesDeLoja = new Map<string, string>();
  for (const plataforma of new Set(selecoes.selecoes.map((sel) => sel.plataforma))) {
    const valorNoBanco = MARKETPLACE_POR_PLATAFORMA[plataforma];
    if (valorNoBanco === undefined) continue;
    const { linhas } = await listarLojasConectadasDoDono(userId, valorNoBanco);
    for (const l of linhas) nomesDeLoja.set(l.id, l.nome ?? l.nickname ?? "Loja");
  }
  const integracoes = selecoes.selecoes.map((sel) => ({
    plataforma: sel.plataforma,
    recurso: sel.recurso,
    nome: nomeDaPlataforma(sel.plataforma),
    loja: nomesDeLoja.get(sel.lojaId) ?? null,
  }));

  return {
    linha,
    fatos,
    ia,
    vinculos: vinculos.vinculos,
    // O nivel de cada acao externa, ou ausente. Montado aqui porque a
    // validacao devolve impedimentos, e nao a tabela — a tela precisa da
    // tabela para mostrar QUAL acao falta decidir.
    niveisExternos: new Map(gravadas.permissoes.map((g) => [g.funcaoId, g.nivel])),
    validacao: validarParaAtivacao({
      nome: linha.nome,
      instrucoes: linha.instrucoes,
      // O provedor que VAI responder. Em `escolhida_indisponivel` ele e o
      // escolhido, e a regra §8 barra — nao ha troca por conta propria.
      provedor: ia.provedor,
      provedorEscolhido: ia.provedorEscolhido,
      provedoresDisponiveis: ia.provedoresDisponiveis,
      funcoesExternasVinculadas,
      dependenciasDeSkill,
      conexoesSemLoja,
      // As permissoes aqui sao TODAS as gravadas, e nao so as do registry:
      // a regra da externa precisa ver o nivel de uma acao que o registry
      // nao conhece.
      permissoes: gravadas.permissoes.map((p) => ({ funcaoId: p.funcaoId, nivel: p.nivel })),
    }),
    packs: estadoDosPacks(fatos),
    dependenciasDeSkill,
    conexoesSemLoja,
    integracoes,
  };
}

export async function GET(request: Request, { params }: { params: { agenteId: string } }) {
  try {
    const porta = await atravessarPorta(request, params.agenteId, FALHA);
    if (!porta.ok) return porta.resposta;

    const estado = await montarEstado(porta.userId, porta.agenteId);
    if (estado === null) return responder({ ok: false, erro: "Agente não encontrado." }, 404);
    if (estado === "falha_leitura") return responder({ ok: false, erro: FALHA }, 500);

    return responder({
      ok: true,
      // O resumo lateral e a tela Revisar leem exatamente isto.
      resumo: {
        nome: estado.linha.nome,
        ativo: estado.linha.ativo,
        temInstrucoes: (estado.linha.instrucoes ?? "").trim() !== "",
        // F7b.4.2: a IA deste AGENTE, e nao a do ambiente. `provedor` e o
        // que vai responder; `provedorEscolhido` e o que o dono gravou. As
        // duas aparecem porque a diferenca entre elas e informacao — e em
        // `escolhida_indisponivel` e a explicacao do impedimento.
        modelo: estado.ia.modelo,
        provedor: estado.ia.provedor,
        provedorEscolhido: estado.ia.provedorEscolhido,
        nivelDeTrabalho: estado.ia.nivel,
        iaDesfecho: estado.ia.desfecho,
        temFerramentas: estado.validacao.temFerramentas,
        memoriaAtiva: estado.linha.memoria_ativa,
      },
      // F7b.4: a tela NAO tem lista de modelos propria. Ela mostra o que
      // este ambiente de fato configurou, com as capacidades que foram
      // medidas — §36. Sem chave, o provedor simplesmente nao aparece.
      modelos: modelosDisponiveis().map((m) => ({
        provedor: m.provedor,
        nome: m.nomeVisivel,
        descricao: m.descricao,
        modeloId: m.modeloId,
        ferramentas: m.ferramentas,
        niveis: m.niveis,
      })),
      // Sem `funcao_id` na superficie: a pessoa escolheu packs.
      ferramentas: estado.packs
        .filter((p) => p.selecionado)
        .map((p) => ({
          id: p.pack.id, nome: p.pack.nome,
          completo: p.completo, nivel: p.nivelUniforme,
          faltando: p.semPermissao.length,
        })),
      // F7b.4.2: as acoes externas que o agente POSSUI, cada uma com o
      // seu nivel ou `null`. `null` e o estado que barra a ativacao, e a
      // tela precisa mostra-lo em vez de inventar um default.
      ferramentasExternas: estado.vinculos.map((v) => ({
        funcaoId: v.funcaoId,
        toolkit: v.toolkit,
        acao: v.acao,
        nivel: estado.niveisExternos.get(v.funcaoId) ?? null,
      })),
      // F7b.4.8 §10: a coluna "Integracoes" do resumo. Nome da
      // plataforma e nome da LOJA — nunca uuid, nunca `seller_id`.
      integracoes: estado.integracoes,
      // O que falta de loja, para a tela poder resolver ALI — §11.
      conexoesSemLoja: estado.conexoesSemLoja,
      // O que as Skills pedem e o agente nao tem. `bloqueia` distingue
      // requisito obrigatorio de opcional: o segundo aparece como aviso,
      // e nao como impedimento.
      dependenciasDeSkill: estado.dependenciasDeSkill,
      podeAtivar: estado.validacao.podeAtivar,
      impedimentos: estado.validacao.impedimentos,
    }, 200);
  } catch {
    return responder({ ok: false, erro: FALHA }, 500);
  }
}

export async function PATCH(request: Request, { params }: { params: { agenteId: string } }) {
  try {
    const porta = await atravessarPorta(request, params.agenteId, FALHA);
    if (!porta.ok) return porta.resposta;

    const corpo = await lerCorpo(request);
    if (corpo === null || typeof corpo.ativo !== "boolean") {
      return responder({ ok: false, erro: "Informe `ativo` como true ou false." }, 400);
    }

    // DESLIGAR nao passa por validacao: parar tem de ser sempre possivel.
    if (corpo.ativo === false) {
      const { linha, erro } = await atualizarAgenteDoDono(
        porta.agenteId, porta.userId, { ativo: false });
      if (erro !== null || !linha) return responder({ ok: false, erro: FALHA }, 500);
      return responder({ ok: true, ativo: false }, 200);
    }

    const estado = await montarEstado(porta.userId, porta.agenteId);
    if (estado === null) return responder({ ok: false, erro: "Agente não encontrado." }, 404);
    if (estado === "falha_leitura") return responder({ ok: false, erro: FALHA }, 500);

    // A cerca do §27: sem permissao explicita em TODA Funcao de Tool
    // escolhida, nao ativa. `bloqueado` conta como decidido.
    if (!estado.validacao.podeAtivar) {
      return responder({
        ok: false,
        erro: "Este agente ainda não pode ser ativado.",
        impedimentos: estado.validacao.impedimentos,
      }, 409);
    }

    const { linha, erro } = await atualizarAgenteDoDono(
      porta.agenteId, porta.userId, { ativo: true });
    if (erro !== null || !linha) return responder({ ok: false, erro: FALHA }, 500);

    return responder({ ok: true, ativo: true }, 200);
  } catch {
    return responder({ ok: false, erro: FALHA }, 500);
  }
}
