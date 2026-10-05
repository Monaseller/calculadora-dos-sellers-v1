/**
 * APIs de UM agente, como a tela aprovada precisa — F9.2-A.
 *
 * PURO: recebe o que os contratos reais ja devolvem (permissoes gravadas,
 * requisitos de conexao resolvidos, contas do dono) e decide SO a forma.
 * Quem le banco e `servico.ts`; quem autoriza execucao continua sendo o
 * guard. Nada aqui concede nada.
 *
 * ── Uma conta por provider ──────────────────────────────────────────
 *
 * `agente_conexoes` continua por (plataforma, recurso): e o que o guard e
 * o executor leem, e muda-lo seria migration sem ganho. A pessoa, porem,
 * escolhe UMA conta do Mercado Livre. Esta camada faz as duas coisas
 * conviverem:
 *
 *   leitura   as linhas por recurso viram UMA `contaDoAgente` por provider
 *             (`divergente` quando linhas antigas apontam contas
 *             diferentes — a tela pede uma escolha, e a escolha unifica);
 *   escrita   `planejarContaDoProvedor` expande a conta escolhida para
 *             TODO recurso que o agente realmente exige daquele provider.
 *
 * O cliente nunca diz `recurso`: ele vem dos requisitos REAIS do agente,
 * entao nao ha como gravar vinculo que nenhuma Funcao pediu.
 */
import {
  PROVEDORES_DE_API,
  capacidadeDaFuncao,
  capacidadesDoProvedor,
  provedorDisponivelParaAgentes,
  provedorPorId,
  type EfeitoDaCapacidade,
  type IdProvedorDeApi,
  type ProvedorDeApi,
} from "@/lib/agentes/apis/catalogo";

// ─── Entradas (o que os contratos atuais ja devolvem) ─────────────────

export interface PermissaoDoAgente {
  readonly funcaoId: string;
  readonly nivel: string;
}

export interface RequisitoDoAgente {
  readonly plataforma: string;
  readonly recurso: string;
  readonly lojaIdSelecionada: string | null;
  readonly utilizavel: boolean;
}

/**
 * Uma linha GRAVADA de `agente_conexoes` (`resolverSelecoesDoAgente`, dono
 * conferido) — F9.2-A4. A conta do provider existe mesmo quando nenhuma
 * capability esta ligada: conexao != capability.
 */
export interface SelecaoGravada {
  readonly plataforma: string;
  readonly recurso: string;
  readonly lojaId: string;
}

/** Conta JA filtrada por dono e por `marketplace` (`listarLojasConectadasDoDono`). */
export interface ContaDoDono {
  readonly id: string;
  readonly nome: string | null;
  readonly nickname: string | null;
}

// ─── Saida ────────────────────────────────────────────────────────────

const NIVEIS = ["automatico", "aprovacao", "bloqueado"] as const;
type Nivel = (typeof NIVEIS)[number];

export interface CapacidadeProjetada {
  readonly id: string;
  readonly nome: string;
  readonly descricao: string;
  readonly efeito: EfeitoDaCapacidade;
  readonly disponivel: boolean;
  /**
   * Habilitada = `automatico` ou `aprovacao`. `bloqueado` e "desligada" —
   * a mesma regra do agregador de conexoes e do guard (F9.2-A3).
   */
  readonly habilitadaNoAgente: boolean;
  readonly nivel: Nivel | null;
}

export type ContaDoAgente =
  /** O agente nao exige conta deste provider (nenhuma capability ligada). */
  | { readonly estado: "sem_requisito" }
  | { readonly estado: "nenhuma" }
  /** Todos os recursos apontam para a MESMA conta. */
  | { readonly estado: "definida"; readonly lojaId: string; readonly utilizavel: boolean }
  /** Parte dos recursos tem conta (a MESMA), parte ainda nao. */
  | { readonly estado: "incompleta"; readonly lojaId: string }
  /** Linhas antigas apontam contas DIFERENTES. Nunca se adivinha qual vale. */
  | { readonly estado: "divergente" };

export interface ProvedorProjetado {
  readonly id: IdProvedorDeApi;
  readonly nome: string;
  readonly disponivelParaAgentes: boolean;
  /** Frase pronta quando nao ha capability; `null` quando ha. */
  readonly textoDeStatus: string | null;
  readonly conexoes: readonly ContaDoDono[];
  readonly contaDoAgente: ContaDoAgente;
  /** Vazio quando o provider nao tem capability — nunca checkbox falso. */
  readonly capacidades: readonly CapacidadeProjetada[];
}

function nivelConhecido(n: string | undefined): Nivel | null {
  return (NIVEIS as readonly string[]).includes(n ?? "") ? (n as Nivel) : null;
}

export function contaDoAgente(
  provedor: ProvedorDeApi,
  requisitos: readonly RequisitoDoAgente[],
  /** F9.2-A4: as linhas gravadas, para quando nenhuma capability esta ligada. */
  selecoes: readonly SelecaoGravada[] = [],
  /** As contas elegiveis do dono neste provider (para `utilizavel`). */
  elegiveis?: readonly ContaDoDono[]
): ContaDoAgente {
  const doProvedor = requisitos.filter((r) => r.plataforma === provedor.plataforma);
  if (doProvedor.length === 0) {
    // ── Conexao != capability (F9.2-A4) ──────────────────────────────
    //
    // Todas desligadas nao e "sem conta": as linhas GRAVADAS do provider
    // continuam dizendo qual conta ele usa. Uma conta so -> definida (com
    // zero capabilities ligadas, o que e valido). Contas diferentes ->
    // divergente: nao se adivinha; a escolha unica reconcilia.
    const gravadas = new Set(
      selecoes.filter((s) => s.plataforma === provedor.plataforma).map((s) => s.lojaId)
    );
    if (gravadas.size === 0) return { estado: "sem_requisito" };
    if (gravadas.size > 1) return { estado: "divergente" };
    const lojaId = [...gravadas][0];
    return {
      estado: "definida", lojaId,
      utilizavel: elegiveis === undefined ? true : elegiveis.some((l) => l.id === lojaId),
    };
  }
  const escolhidas = doProvedor.filter((r) => r.lojaIdSelecionada !== null);
  if (escolhidas.length === 0) return { estado: "nenhuma" };
  const distintas = new Set(escolhidas.map((r) => r.lojaIdSelecionada));
  if (distintas.size > 1) return { estado: "divergente" };
  if (escolhidas.length < doProvedor.length) {
    return { estado: "incompleta", lojaId: escolhidas[0].lojaIdSelecionada as string };
  }
  return {
    estado: "definida",
    lojaId: escolhidas[0].lojaIdSelecionada as string,
    utilizavel: doProvedor.every((r) => r.utilizavel),
  };
}

export function projetarApisDoAgente(entrada: {
  readonly permissoes: readonly PermissaoDoAgente[];
  readonly requisitos: readonly RequisitoDoAgente[];
  /** Por provider. Ausente = nenhuma conta conectada na CDS. */
  readonly contasPorProvedor: Readonly<Partial<Record<IdProvedorDeApi, readonly ContaDoDono[]>>>;
  /** F9.2-A4: linhas gravadas de `agente_conexoes` (conta mesmo com tudo desligado). */
  readonly selecoes?: readonly SelecaoGravada[];
}): readonly ProvedorProjetado[] {
  // Permissao de Funcao que nao e capability catalogada NAO vira API
  // aqui (Tool, acao externa, ou id desconhecido seguem seus caminhos).
  const nivelPorCapacidade = new Map<string, Nivel | null>();
  for (const p of entrada.permissoes) {
    if (capacidadeDaFuncao(p.funcaoId) !== null) nivelPorCapacidade.set(p.funcaoId, nivelConhecido(p.nivel));
  }

  return PROVEDORES_DE_API.map((provedor) => {
    const disponivel = provedorDisponivelParaAgentes(provedor.id);
    const capacidades = capacidadesDoProvedor(provedor.id).map((c) => {
      const nivel = nivelPorCapacidade.get(c.funcaoId) ?? null;
      return {
        id: c.id, nome: c.nome, descricao: c.descricao, efeito: c.efeito,
        disponivel: c.status === "disponivel",
        habilitadaNoAgente: nivel === "automatico" || nivel === "aprovacao",
        nivel,
      };
    });
    return {
      id: provedor.id,
      nome: provedor.nome,
      disponivelParaAgentes: disponivel,
      textoDeStatus: disponivel ? null : provedor.textoSemCapacidade,
      conexoes: entrada.contasPorProvedor[provedor.id] ?? [],
      contaDoAgente: contaDoAgente(provedor, entrada.requisitos, entrada.selecoes ?? [],
        entrada.contasPorProvedor[provedor.id] ?? []),
      capacidades,
    };
  });
}

/**
 * A conta que uma capability NOVA deve herdar do provider — F9.2-A2.
 *
 * Existe exatamente UMA loja entre as escolhas atuais do provider: e ela.
 * Nenhuma escolha -> `null` (a capability fica sem cobertura ate o dono
 * escolher). Escolhas diferentes -> `null` tambem: com estado divergente
 * nao se adivinha; a escolha unica do provider reconcilia.
 */
export function contaParaHerdar(
  provedor: ProvedorDeApi,
  requisitos: readonly RequisitoDoAgente[]
): { readonly lojaId: string } | { readonly motivo: "sem_conta" | "divergente" } {
  const lojas = new Set(
    requisitos
      .filter((r) => r.plataforma === provedor.plataforma && r.lojaIdSelecionada !== null)
      .map((r) => r.lojaIdSelecionada as string)
  );
  if (lojas.size === 0) return { motivo: "sem_conta" };
  if (lojas.size > 1) return { motivo: "divergente" };
  return { lojaId: [...lojas][0] };
}

// ─── Escrita: UMA conta -> todos os recursos do provider ──────────────

export type GravacaoDeConta =
  | { readonly tipo: "definir"; readonly plataforma: string; readonly recurso: string; readonly lojaId: string }
  | { readonly tipo: "remover"; readonly plataforma: string; readonly recurso: string };

export type PlanoDeConta =
  | { readonly ok: true; readonly provedor: IdProvedorDeApi; readonly gravacoes: readonly GravacaoDeConta[] }
  | {
      readonly ok: false;
      readonly codigo:
        | "provedor_desconhecido"
        | "provedor_indisponivel_para_agentes"
        | "sem_requisito"
        | "conta_indisponivel";
    };

/**
 * Planeja a escolha de UMA conta para um provider.
 *
 * `provedorId` e `lojaId` vem do cliente e sao tratados como hostis:
 *   - provider so por igualdade no catalogo (sem spoofing);
 *   - recursos SO dos requisitos reais do agente (sem recurso inventado);
 *   - conta SO se estiver na lista de elegiveis do dono para AQUELE
 *     marketplace (sem loja alheia, inativa ou de outro provider).
 * Inexistente, alheia e de outro marketplace colapsam no mesmo codigo.
 */
export function planejarContaDoProvedor(entrada: {
  readonly provedorId: unknown;
  readonly lojaId: unknown;
  readonly requisitos: readonly RequisitoDoAgente[];
  readonly elegiveis: readonly ContaDoDono[];
  /**
   * F9.2-A4: linhas ja gravadas do provider. Entram como recursos a
   * reconciliar: com tudo desligado, a escolha unica ainda reconcilia o que
   * esta salvo (inclusive um estado divergente). Nao inventa recurso: so o
   * que o agente exige agora ou ja tinha gravado.
   */
  readonly selecoes?: readonly SelecaoGravada[];
}): PlanoDeConta {
  const provedor = provedorPorId(entrada.provedorId);
  if (provedor === null) return { ok: false, codigo: "provedor_desconhecido" };
  if (!provedorDisponivelParaAgentes(provedor.id)) {
    return { ok: false, codigo: "provedor_indisponivel_para_agentes" };
  }
  const recursos = [...new Set([
    ...entrada.requisitos.filter((r) => r.plataforma === provedor.plataforma).map((r) => r.recurso),
    ...(entrada.selecoes ?? []).filter((s) => s.plataforma === provedor.plataforma).map((s) => s.recurso),
  ])].sort();
  if (recursos.length === 0) return { ok: false, codigo: "sem_requisito" };

  if (entrada.lojaId === null) {
    return {
      ok: true, provedor: provedor.id,
      gravacoes: recursos.map((recurso) => ({ tipo: "remover", plataforma: provedor.plataforma, recurso })),
    };
  }
  const lojaId = entrada.lojaId;
  if (typeof lojaId !== "string" || !entrada.elegiveis.some((l) => l.id === lojaId)) {
    return { ok: false, codigo: "conta_indisponivel" };
  }
  return {
    ok: true, provedor: provedor.id,
    gravacoes: recursos.map((recurso) => ({ tipo: "definir", plataforma: provedor.plataforma, recurso, lojaId })),
  };
}
