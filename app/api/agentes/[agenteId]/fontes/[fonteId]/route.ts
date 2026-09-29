/**
 * Uma fonte — AGENT-FACTORY-F7a, ampliada no F7b.3.
 *
 * PATCH   corrige o metadado (nome, papel, descricao)
 * DELETE  desativa
 *
 * ── Por que PATCH entrou ────────────────────────────────────────────
 *
 * `papel` e o campo que o MODELO le para saber que uma planilha e de
 * entradas e a outra de saidas. Ate aqui ele so podia ser definido no
 * upload — antes de a pessoa ter visto o que o arquivo tem dentro. Pedir
 * o papel antes da inspecao e pedir para adivinhar, e um papel errado
 * nao e um rotulo feio: e uma resposta errada.
 *
 * O contrato e FECHADO em tres campos. `escopo`, `agente_id`,
 * `conversa_id`, `hash`, `caminho_objeto` e `ativo` nao entram: mudar
 * qualquer um deles nao e corrigir um rotulo, e mover o arquivo de lugar
 * ou reescrever a prova de qual arquivo foi lido.
 *
 * ── Desativa, nao apaga ─────────────────────────────────────────────
 *
 * O registro e o hash ficam. Um total calculado ontem so continua
 * explicavel se der para dizer QUAL arquivo foi lido — e uma fonte
 * apagada de vez levaria essa resposta junto. Some da lista, some do
 * contexto, some do resolvedor; a linha permanece.
 */
import { atravessarPorta, lerCorpo, responder, UUID_REGEX } from "@/lib/agentes/api/porta";
import { criarPortaDeFontes } from "@/lib/agentes/fontes/repositorio";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";

export const dynamic = "force-dynamic";

/** Limites de tela, nao de banco: o que cabe numa linha de lista. */
const MAX_NOME = 200;
const MAX_PAPEL = 120;
const MAX_DESCRICAO = 500;

/** As UNICAS tres chaves aceitas. Uma a mais reprova o pedido inteiro. */
const CAMPOS_EDITAVEIS = new Set(["nome", "papel", "descricao"]);

type Campos = { nome?: string; papel?: string | null; descricao?: string | null };

/**
 * Le os campos, ou diz por que nao.
 *
 * `null` e pedido LEGITIMO de limpar papel/descricao. Numero e objeto
 * nao sao: converte-los silenciosamente apagaria texto do dono por
 * engano de tipo.
 */
function camposDoCorpo(corpo: Record<string, unknown>):
  { ok: true; campos: Campos } | { ok: false; erro: string } {
  const chaves = Object.keys(corpo);
  if (chaves.length === 0) return { ok: false, erro: "Nada a alterar." };
  for (const c of chaves) {
    if (!CAMPOS_EDITAVEIS.has(c)) return { ok: false, erro: "Alteração inválida." };
  }

  const campos: Campos = {};

  if (chaves.includes("nome")) {
    if (typeof corpo.nome !== "string") return { ok: false, erro: "nome inválido." };
    const nome = corpo.nome.trim();
    // Nome VAZIO nao e limpar: o arquivo precisa de um nome para aparecer
    // na lista e para o modelo poder cita-lo.
    if (nome === "" || nome.length > MAX_NOME) {
      return { ok: false, erro: "nome inválido." };
    }
    campos.nome = nome;
  }

  if (chaves.includes("papel")) {
    if (corpo.papel === null) campos.papel = null;
    else if (typeof corpo.papel === "string") {
      const papel = corpo.papel.trim();
      if (papel.length > MAX_PAPEL) return { ok: false, erro: "papel muito longo." };
      campos.papel = papel === "" ? null : papel;
    } else return { ok: false, erro: "papel inválido." };
  }

  if (chaves.includes("descricao")) {
    if (corpo.descricao === null) campos.descricao = null;
    else if (typeof corpo.descricao === "string") {
      const d = corpo.descricao.trim();
      if (d.length > MAX_DESCRICAO) return { ok: false, erro: "descrição muito longa." };
      campos.descricao = d === "" ? null : d;
    } else return { ok: false, erro: "descrição inválida." };
  }

  return { ok: true, campos };
}

export async function PATCH(
  request: Request,
  { params }: { params: { agenteId: string; fonteId: string } }
) {
  try {
    const porta = await atravessarPorta(request, params.agenteId);
    if (!porta.ok) return porta.resposta;
    if (!UUID_REGEX.test(params.fonteId)) {
      return responder({ ok: false, erro: "fonteId inválido." }, 400);
    }

    const corpo = await lerCorpo(request);
    if (corpo === null) {
      return responder({ ok: false, erro: "Corpo da requisição inválido." }, 400);
    }
    const lido = camposDoCorpo(corpo);
    if (!lido.ok) return responder({ ok: false, erro: lido.erro }, 400);

    // O dono e o AGENTE vem da porta, nunca do corpo. A porta escopa o
    // UPDATE pelos dois na propria instrucao.
    const atualizada = await criarPortaDeFontes(getSupabaseServidor())
      .atualizarMetadado(porta.userId, params.fonteId,
        { agenteId: porta.agenteId }, lido.campos);

    if (atualizada === null) {
      return responder({ ok: false, erro: "Fonte não encontrada." }, 404);
    }

    // `caminhoObjeto` nao existe no tipo de dominio: nao ha o que omitir.
    return responder({
      ok: true,
      fonte: {
        id: atualizada.id, nome: atualizada.nome, descricao: atualizada.descricao,
        papel: atualizada.papel, tipo: atualizada.tipo, escopo: atualizada.escopo,
      },
    }, 200);
  } catch {
    return responder({ ok: false, erro: "Nao foi possivel atualizar a fonte." }, 500);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: { agenteId: string; fonteId: string } }
) {
  try {
    const porta = await atravessarPorta(request, params.agenteId);
    if (!porta.ok) return porta.resposta;
    if (!UUID_REGEX.test(params.fonteId)) {
      return responder({ ok: false, erro: "fonteId inválido." }, 400);
    }

    const portaF = criarPortaDeFontes(getSupabaseServidor());

    // Confere que a fonte e DESTE agente antes de desativar. `desativar`
    // sozinho amarra o dono, mas nao o agente — sem esta checagem, um
    // dono com dois agentes poderia desligar a fonte do outro pela rota
    // errada.
    const doAgente = await portaF.obterAtiva(
      porta.userId, params.fonteId, { agenteId: porta.agenteId });
    if (!doAgente) return responder({ ok: false, erro: "Fonte não encontrada." }, 404);

    const ok = await portaF.desativar(porta.userId, params.fonteId);
    return responder({ ok }, ok ? 200 : 404);
  } catch {
    return responder({ ok: false, erro: "Nao foi possivel remover a fonte." }, 500);
  }
}
