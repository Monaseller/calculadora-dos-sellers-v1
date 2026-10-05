/**
 * Adicionar uma Tool (pack interno) a um agente — o contrato UNICO usado
 * pelo Wizard e pelo Escritorio. F8.2-A.
 *
 * ── Por que este modulo existe ──────────────────────────────────────
 *
 * A regra morava dentro de `Wizard.definirNivelDoPack`: uma permissao
 * por Funcao do pack, com o nivel SUGERIDO pelo efeito quando ninguem o
 * escolheu (`nivelSugeridoParaEfeito`, §28 — ler roda em "automatico",
 * escrever pede aprovacao). O Escritorio passou a adicionar Tools tambem,
 * e copiar o laco faria duas regras que precisariam concordar para
 * sempre. Ela saiu do Wizard e mora aqui, uma vez.
 *
 * ── Remover pack — F8.2-B ──────────────────────────────────────────
 *
 * Decisao de produto: remover uma Tool interna e voltar ao "nao
 * selecionado" — as linhas de permissao do pack saem (DELETE no servidor,
 * `removerPackDoAgente` em `permissoes/escrita.ts`). NUNCA vira
 * `bloqueado`: bloquear continua sendo uma escolha explicita da etapa 8.
 * Acao EXTERNA tem contrato proprio (`desvincularFerramentaExterna`).
 */
import { TOOL_PACKS } from "@/lib/agentes/factory/catalogo-ui";
import { efeitoDaFuncaoInterna, nivelSugeridoParaEfeito } from "@/lib/agentes/factory/efeito";
import type { NivelAutonomia } from "@/lib/ia/conceitos";
import { definirPermissaoDeFuncao, removerFerramentaDoAgente } from "@/lib/ia/agentes-http";

type RespostaDaDefinicao = Awaited<ReturnType<typeof definirPermissaoDeFuncao>>;

export type ResultadoAdicionarPack =
  | { readonly estado: "ok" }
  | { readonly estado: "pack_desconhecido" }
  /** A primeira recusa, como o transporte a devolveu. Para ali. */
  | { readonly estado: "recusado"; readonly resposta: Exclude<RespostaDaDefinicao, { estado: "ok" }> };

/**
 * Grava o nivel de TODAS as Funcoes de um pack.
 *
 * `nivel === null` = ninguem escolheu: vale o nivel sugerido pelo efeito
 * de cada Funcao. `nivel` explicito vence (a etapa 8 do Wizard decide).
 *
 * Para na primeira recusa, de proposito: seguir gravando depois dela
 * deixaria o pack meio configurado sem ninguem avisado.
 */
export async function adicionarPackAoAgente(
  agenteId: string,
  packId: string,
  nivel: NivelAutonomia | null
): Promise<ResultadoAdicionarPack> {
  const pack = TOOL_PACKS.find((p) => p.id === packId);
  if (pack === undefined) return { estado: "pack_desconhecido" };
  for (const funcaoId of pack.funcoes) {
    const efetivo = nivel ?? nivelSugeridoParaEfeito(
      efeitoDaFuncaoInterna({ funcaoId, acesso: pack.acesso }));
    const r = await definirPermissaoDeFuncao(agenteId, { funcaoId, nivel: efetivo });
    if (r.estado !== "ok") return { estado: "recusado", resposta: r };
  }
  return { estado: "ok" };
}

/**
 * Liga ou desliga UMA capability de API — F9.2-A3.
 *
 * Mesmo contrato de sempre (PATCH /permissoes por `funcao_id`), sem
 * semantica nova: ligar grava o nivel do provider (`automatico` ou
 * `aprovacao`); desligar grava `bloqueado`. Desligar NAO remove a conta do
 * provider nem toca as outras capabilities. Ao ligar, o servidor herda a
 * conta do provider para o recurso dela antes de gravar.
 */
export async function definirCapacidadeDaApi(
  agenteId: string,
  funcaoId: string,
  ligada: boolean,
  nivelQuandoLigada: "automatico" | "aprovacao"
): Promise<ResultadoAdicionarPack> {
  const r = await definirPermissaoDeFuncao(agenteId, {
    funcaoId, nivel: ligada ? nivelQuandoLigada : "bloqueado",
  });
  return r.estado === "ok" ? { estado: "ok" } : { estado: "recusado", resposta: r };
}

/**
 * Muda o nivel do provider aplicando-o SO as capabilities ligadas — F9.2-A3.
 *
 * `adicionarPackAoAgente(pack, nivel)` grava TODAS as Funcoes do pack, e
 * religaria uma capability que o dono desligou. Aqui o nivel vale para as
 * ligadas; as desligadas continuam `bloqueado`.
 */
export async function definirNivelDasCapacidadesDaApi(
  agenteId: string,
  funcaoIdsLigadas: readonly string[],
  nivel: NivelAutonomia
): Promise<ResultadoAdicionarPack> {
  for (const funcaoId of funcaoIdsLigadas) {
    const r = await definirPermissaoDeFuncao(agenteId, { funcaoId, nivel });
    if (r.estado !== "ok") return { estado: "recusado", resposta: r };
  }
  return { estado: "ok" };
}

export type ResultadoRemoverPack =
  | { readonly estado: "ok" }
  | { readonly estado: "pack_desconhecido" }
  | { readonly estado: "recusado" };

/**
 * Devolve um pack ao "nao selecionado" — o contrato UNICO de remocao,
 * usado pelo Wizard e pelo Escritorio.
 */
export async function removerPackDoAgente(
  agenteId: string,
  packId: string
): Promise<ResultadoRemoverPack> {
  if (!TOOL_PACKS.some((p) => p.id === packId)) return { estado: "pack_desconhecido" };
  const r = await removerFerramentaDoAgente(agenteId, packId);
  return r.estado === "ok" ? { estado: "ok" } : { estado: "recusado" };
}
