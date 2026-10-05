import "server-only";

/**
 * APIs de um agente — leitura e escolha de conta, sobre os contratos que
 * ja existem. F9.2-A.
 *
 * Nenhuma tabela nova e nenhuma regra paralela:
 *
 *   permissoes  `listarPermissoesGravadas`  (agente_permissoes, por funcao_id)
 *   requisitos  `resolverConexoesDoAgente`  (derivados das Funcoes/Skills reais)
 *   contas      `listarLojasConectadasDoDono` (lojas do DONO, ativas, por marketplace)
 *   gravacao    `definirSelecaoDeLoja` / `removerSelecaoDeLoja` (agente_conexoes)
 *
 * `userId` e `agenteId` chegam da porta da rota (sessao + dono do agente
 * ja provados). Nada aqui fala com marketplace nem habilita escrita externa.
 */
import { resolverConexoesDoAgente } from "@/lib/agentes/conexoes/agregador";
import { definirSelecaoDeLoja, removerSelecaoDeLoja } from "@/lib/agentes/conexoes/selecao-escrita";
import { listarPermissoesGravadas } from "@/lib/agentes/permissoes/gravadas";
import { listarLojasConectadasDoDono } from "@/lib/marketplace/credenciais";
import {
  PROVEDORES_DE_API,
  provedorDisponivelParaAgentes,
  provedorPorId,
  type IdProvedorDeApi,
} from "@/lib/agentes/apis/catalogo";
import {
  planejarContaDoProvedor,
  projetarApisDoAgente,
  type ContaDoDono,
  type ProvedorProjetado,
} from "@/lib/agentes/apis/projecao";

async function contasDoMarketplace(userId: string, marketplace: string): Promise<ContaDoDono[] | null> {
  const { linhas, erro } = await listarLojasConectadasDoDono(userId, marketplace);
  if (erro !== null) return null;
  // Recorte: token, seller_id e datas nao saem daqui.
  return linhas.map((l) => ({ id: l.id, nome: l.nome ?? null, nickname: l.nickname ?? null }));
}

export type LeituraDasApis =
  | { readonly ok: true; readonly provedores: readonly ProvedorProjetado[] }
  | { readonly ok: false };

export async function lerApisDoAgente(userId: string, agenteId: string): Promise<LeituraDasApis> {
  const [gravadas, resolvido] = await Promise.all([
    listarPermissoesGravadas({ userId, agenteId }),
    resolverConexoesDoAgente({ userId, agenteId, agoraMs: Date.now() }),
  ]);
  if (gravadas.coleta !== "ok" || resolvido.coleta !== "ok") return { ok: false };

  const contasPorProvedor: Partial<Record<IdProvedorDeApi, readonly ContaDoDono[]>> = {};
  for (const p of PROVEDORES_DE_API) {
    const contas = await contasDoMarketplace(userId, p.marketplace);
    if (contas === null) return { ok: false };
    contasPorProvedor[p.id] = contas;
  }

  return {
    ok: true,
    provedores: projetarApisDoAgente({
      permissoes: gravadas.permissoes,
      requisitos: resolvido.requisitos,
      contasPorProvedor,
    }),
  };
}

export type ResultadoDaConta =
  | { readonly ok: true; readonly provedor: IdProvedorDeApi; readonly recursos: readonly string[] }
  | {
      readonly ok: false;
      readonly codigo:
        | "provedor_desconhecido"
        | "provedor_indisponivel_para_agentes"
        | "sem_requisito"
        | "conta_indisponivel"
        | "falha";
    };

/**
 * UMA conta para um provider -> uma linha de `agente_conexoes` por recurso
 * que o agente REALMENTE exige daquele provider.
 *
 * A ordem repete a da rota `/conexoes`: o requisito e provado ANTES de
 * olhar as contas, para a rota nao virar sonda de quais lojas existem.
 *
 * As gravacoes sao upserts idempotentes por (agente, plataforma, recurso).
 * Se uma falhar no meio, a resposta e `falha` e repetir o mesmo pedido
 * converge — nao ha estado intermediario que uma repeticao piore.
 */
export async function definirContaDoProvedor(entrada: {
  readonly userId: string;
  readonly agenteId: string;
  readonly provedorId: unknown;
  readonly lojaId: unknown;
}): Promise<ResultadoDaConta> {
  const { userId, agenteId } = entrada;
  const provedor = provedorPorId(entrada.provedorId);
  if (provedor === null) return { ok: false, codigo: "provedor_desconhecido" };
  if (!provedorDisponivelParaAgentes(provedor.id)) {
    return { ok: false, codigo: "provedor_indisponivel_para_agentes" };
  }

  const resolvido = await resolverConexoesDoAgente({ userId, agenteId, agoraMs: Date.now() });
  if (resolvido.coleta !== "ok") return { ok: false, codigo: "falha" };
  if (!resolvido.requisitos.some((r) => r.plataforma === provedor.plataforma)) {
    return { ok: false, codigo: "sem_requisito" };
  }

  const elegiveis = entrada.lojaId === null ? [] : await contasDoMarketplace(userId, provedor.marketplace);
  if (elegiveis === null) return { ok: false, codigo: "falha" };

  const plano = planejarContaDoProvedor({
    provedorId: provedor.id,
    lojaId: entrada.lojaId,
    requisitos: resolvido.requisitos,
    elegiveis,
  });
  if (!plano.ok) return plano;

  for (const g of plano.gravacoes) {
    if (g.tipo === "definir") {
      const r = await definirSelecaoDeLoja({
        userId, agenteId, plataforma: g.plataforma, recurso: g.recurso, lojaId: g.lojaId,
      });
      if (r.estado !== "definida") return { ok: false, codigo: "falha" };
    } else {
      const r = await removerSelecaoDeLoja({ userId, agenteId, plataforma: g.plataforma, recurso: g.recurso });
      if (r.estado !== "removida" && r.estado !== "nao_encontrada") return { ok: false, codigo: "falha" };
    }
  }
  return { ok: true, provedor: plano.provedor, recursos: plano.gravacoes.map((g) => g.recurso) };
}
