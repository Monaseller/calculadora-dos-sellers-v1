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
import { resolverSelecoesDoAgente } from "@/lib/agentes/conexoes/selecao-fatos";
import { listarPermissoesGravadas } from "@/lib/agentes/permissoes/gravadas";
import { listarLojasConectadasDoDono } from "@/lib/marketplace/credenciais";
import {
  PROVEDORES_DE_API,
  capacidadeDaFuncao,
  provedorDisponivelParaAgentes,
  provedorPorId,
  type IdProvedorDeApi,
} from "@/lib/agentes/apis/catalogo";
import {
  contaParaHerdar,
  planejarContaDoProvedor,
  projetarApisDoAgente,
  type ContaDoDono,
  type ProvedorProjetado,
} from "@/lib/agentes/apis/projecao";
import {
  aplicarComCompensacao, chaveDaLinha, type PortasDeConta, type ResultadoDaAplicacao,
} from "@/lib/agentes/apis/aplicacao";
import type { GravacaoDeConta } from "@/lib/agentes/apis/projecao";

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
        | "falha"
        /** Falhou E a compensacao falhou: o provider pode estar dividido. */
        | "inconsistente";
    };

/** As escritas reais de `agente_conexoes`, como porta de `aplicarComCompensacao`. */
function portasReais(userId: string, agenteId: string): PortasDeConta {
  return {
    async definir(g) {
      const r = await definirSelecaoDeLoja({ userId, agenteId, ...g });
      return r.estado === "definida";
    },
    async remover(g) {
      const r = await removerSelecaoDeLoja({ userId, agenteId, ...g });
      // Apagar o que ja nao existe alcancou o estado pedido.
      return r.estado === "removida" || r.estado === "nao_encontrada";
    },
  };
}

/**
 * UMA conta para um provider -> uma linha de `agente_conexoes` por recurso
 * que o agente REALMENTE exige daquele provider.
 *
 * A ordem repete a da rota `/conexoes`: o requisito e provado ANTES de
 * olhar as contas, para a rota nao virar sonda de quais lojas existem.
 *
 * F9.2-A2: tudo ou nada. O estado anterior de cada linha vem dos
 * requisitos resolvidos; se uma escrita falhar, as aplicadas voltam
 * (`aplicacao.ts`). O dono nunca recebe `ok` com o provider dividido.
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

  const aplicado = await aplicarContaAosRecursos({ userId, agenteId, gravacoes: plano.gravacoes });
  if (!aplicado.ok) {
    return { ok: false, codigo: aplicado.codigo === "inconsistente" ? "inconsistente" : "falha" };
  }
  return { ok: true, provedor: plano.provedor, recursos: plano.gravacoes.map((g) => g.recurso) };
}

/**
 * A UNICA forma de gravar a conta de um provider em varios recursos —
 * F9.2-A3. Usada pelo PATCH /apis e pela escolha de loja no chat
 * (`capacidades/[pendenciaId]/conexao`): os dois fluxos que escolhem conta
 * tem a MESMA semantica tudo-ou-nada, sem segunda implementacao de volta.
 *
 * O estado anterior vem das linhas GRAVADAS (`resolverSelecoesDoAgente`,
 * dono conferido), e nao so dos requisitos: uma linha de recurso hoje
 * desligado tambem volta ao que era se a escrita falhar.
 */
export async function aplicarContaAosRecursos(entrada: {
  readonly userId: string;
  readonly agenteId: string;
  readonly gravacoes: readonly GravacaoDeConta[];
}): Promise<ResultadoDaAplicacao | { readonly ok: false; readonly codigo: "falha_leitura" }> {
  const { userId, agenteId } = entrada;
  const lidas = await resolverSelecoesDoAgente({ userId, agenteId });
  if (lidas.coleta !== "ok") return { ok: false, codigo: "falha_leitura" };
  const anteriores = new Map<string, string | null>(
    lidas.selecoes.map((s) => [chaveDaLinha(s), s.lojaId] as const)
  );
  return aplicarComCompensacao(entrada.gravacoes, anteriores, portasReais(userId, agenteId));
}

export type ResultadoDaHeranca =
  | {
      readonly estado:
        /** A Funcao nao e capability de API (Tool, externa): nada a fazer. */
        | "nao_e_api"
        /** O nivel pedido nao habilita (`bloqueado`): desligar nao mexe em conta. */
        | "nao_habilita"
        /** O recurso ja tem conta escolhida. */
        | "ja_vinculada"
        /** O provider ainda nao tem conta: a capability fica sem cobertura. */
        | "sem_conta"
        /** Contas diferentes no provider: nao se adivinha. */
        | "divergente"
        /** A conta do provider nao e mais elegivel (inativa/desconectada). */
        | "conta_indisponivel"
        | "vinculada";
    }
  | { readonly estado: "falha" };

/**
 * A capability que entra DEPOIS herda a conta do provider — F9.2-A2.
 *
 * Chamada ANTES de gravar a permissao (PATCH /permissoes e a ativacao pelo
 * chat). Se o provider tem UMA conta consistente, o recurso novo recebe a
 * mesma loja; so entao a permissao e gravada. `falha` aqui impede a
 * permissao: nao nasce "permissao ativa + recurso sem conta" quando havia
 * conta para herdar. Linha de conexao sem permissao e inofensiva — o guard
 * exige a permissao.
 *
 * Tools e acoes externas passam direto (`nao_e_api`): a semantica delas
 * nao muda.
 */
export async function herdarContaDoProvedor(entrada: {
  readonly userId: string;
  readonly agenteId: string;
  readonly funcaoId: string;
  /** O nivel que vai ser gravado. So `automatico`/`aprovacao` habilitam. */
  readonly nivel: string;
}): Promise<ResultadoDaHeranca> {
  const { userId, agenteId } = entrada;
  const capacidade = capacidadeDaFuncao(entrada.funcaoId);
  if (capacidade === null) return { estado: "nao_e_api" };
  // Desligar (bloqueado) nao cria nem troca conta: a conta do provider
  // continua a mesma para as outras capabilities (F9.2-A3).
  if (entrada.nivel !== "automatico" && entrada.nivel !== "aprovacao") return { estado: "nao_habilita" };
  const provedor = provedorPorId(capacidade.provedor);
  if (provedor === null) return { estado: "nao_e_api" };

  const resolvido = await resolverConexoesDoAgente({ userId, agenteId, agoraMs: Date.now() });
  if (resolvido.coleta !== "ok") return { estado: "falha" };

  const jaTem = resolvido.requisitos.some((r) =>
    r.plataforma === provedor.plataforma && r.recurso === capacidade.recurso && r.lojaIdSelecionada !== null);
  if (jaTem) return { estado: "ja_vinculada" };

  // Primeiro as capabilities LIGADAS (requisitos). Se nenhuma ligada tem
  // conta — ex.: todas foram desligadas e uma volta agora —, as linhas
  // GRAVADAS do provider dizem qual era a conta. Divergente: nao adivinha.
  let herdada = contaParaHerdar(provedor, resolvido.requisitos);
  if ("motivo" in herdada && herdada.motivo === "sem_conta") {
    const lidas = await resolverSelecoesDoAgente({ userId, agenteId });
    if (lidas.coleta !== "ok") return { estado: "falha" };
    herdada = contaParaHerdar(provedor, lidas.selecoes.map((s) => ({
      plataforma: s.plataforma, recurso: s.recurso, lojaIdSelecionada: s.lojaId, utilizavel: true,
    })));
  }
  if ("motivo" in herdada) return { estado: herdada.motivo };

  const elegiveis = await contasDoMarketplace(userId, provedor.marketplace);
  if (elegiveis === null) return { estado: "falha" };
  if (!elegiveis.some((l) => l.id === herdada.lojaId)) return { estado: "conta_indisponivel" };

  const r = await definirSelecaoDeLoja({
    userId, agenteId, plataforma: provedor.plataforma, recurso: capacidade.recurso, lojaId: herdada.lojaId,
  });
  return r.estado === "definida" ? { estado: "vinculada" } : { estado: "falha" };
}
