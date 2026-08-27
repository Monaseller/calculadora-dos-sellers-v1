/**
 * Regra PURA de permissao — SKILL-1D.d.2.
 *
 * Sem banco, sem rede, sem `server-only`, sem `Date.now()`. Tudo que
 * decide o que uma linha de `agente_permissoes` significa mora aqui, e
 * por isso a suite executa este modulo de verdade em vez de auditar o
 * fonte dele. `fatos.ts` e `server-only`: ele le a tabela com a
 * service_role e por isso nao pode ser importado por teste.
 *
 * ── O que este modulo NAO decide ────────────────────────────────────
 *
 * Nao decide se a Funcao EXISTE. A SKILL-1C ja avalia existencia ANTES
 * de permissao (`avaliarFuncao`), e inverter isso reportaria
 * BLOQUEADO_POR_PERMISSAO para uma Funcao que nao existe — mandando o
 * dono mexer num interruptor que nao muda nada. Filtrar por existencia
 * aqui duplicaria a autoridade do registry e poderia mascarar
 * FALTA_FUNCAO.
 *
 * Nao decide o que fazer com ausencia. Ausencia nao vira fato: quem
 * interpreta e `nivelDe()` no diagnostico, com `?? "bloqueado"`. Emitir
 * um `bloqueado` explicito criaria duas representacoes do mesmo estado,
 * e duas formas de dizer a mesma coisa acabam discordando.
 */
import { NIVEIS_AUTONOMIA, type NivelAutonomia } from "@/lib/ia/conceitos";
import type { FatoPermissao } from "@/lib/ia/skills/diagnostico";

/**
 * Uma linha crua, como sai do driver.
 *
 * Os campos sao `unknown` de proposito. O CHECK do banco garante que
 * `nivel` e um dos tres e que `funcao_id` tem a forma certa — mas o
 * banco e I/O, e tipar I/O como se ja fosse valido e a forma mais comum
 * de confiar em algo que ninguem verificou. A garantia esta la; a
 * verificacao tambem fica aqui.
 *
 * Nao ha, e nao pode haver, `user_id`, `agente_id`, `criado_em` nem
 * `alterado_em`: nenhum participa da decisao, e campo sem consumidor so
 * cria superficie.
 */
export interface LinhaPermissao {
  funcao_id: unknown;
  nivel: unknown;
}

/**
 * O filtro de autoridade, em funcao pura e exportada.
 *
 * Exportado pelo mesmo motivo que `filtrosTarefasDoAgente` em
 * `capability.ts`: e sobre ele que a suite prova "toda leitura carrega
 * `user_id`". Inspecionar o filtro e barato; inspecionar a query montada
 * exigiria banco.
 *
 * `user_id` entra mesmo com a FK composta existindo. A FK garante que o
 * PAR (agente, dono) e coerente — nao que ele seja o par do dono da
 * sessao. Sem `user_id` aqui, um `agenteId` alheio vazado devolveria as
 * permissoes dele.
 *
 * `String(userId)` porque a coluna e TEXT: comparar sem normalizar vira
 * recusa silenciosa por tipo — que, aqui, se pareceria com "este agente
 * nao tem permissao nenhuma".
 */
export function filtrosPermissoesDoAgente(
  agenteId: string,
  userId: string
): Record<string, unknown> {
  return { agente_id: agenteId, user_id: String(userId) };
}

/** `nivel` cru -> `NivelAutonomia`, sem cast e sem confiar no banco. */
export function nivelValido(valor: unknown): valor is NivelAutonomia {
  return typeof valor === "string" && (NIVEIS_AUTONOMIA as readonly string[]).includes(valor);
}

/**
 * Ids pedidos -> conjunto estavel para consultar.
 *
 * Deduplicar antes da consulta, e nao depois: a PK
 * `(agente_id, funcao_id)` ja impede linha repetida, entao id duplicado
 * na ENTRADA nunca deveria virar fato duplicado na SAIDA. Sem isto, o
 * comportamento dependeria de o chamador ter limpado a propria lista.
 *
 * `sort()` para que a mesma entrada produza sempre a mesma consulta —
 * ordem de declaracao do chamador nao pode mudar o que sai.
 *
 * Nao-strings caem fora: um id que nao e string nao casa com nenhuma
 * linha, e mante-lo so faria a consulta carregar lixo.
 */
export function normalizarFuncaoIds(ids: readonly unknown[]): readonly string[] {
  const limpos = ids.filter((id): id is string => typeof id === "string" && id.length > 0);
  return Object.freeze(Array.from(new Set(limpos)).sort());
}

/**
 * Linhas cruas -> fatos que o diagnostico aceita.
 *
 * ── Linha invalida e DESCARTADA, nunca corrigida ────────────────────
 *
 * Um `nivel` que nao esta em `NIVEIS_AUTONOMIA` nao vira `"bloqueado"`
 * por conversao nem `"automatico"` por descuido: a linha simplesmente
 * nao produz fato. O efeito e o mesmo da ausencia — o motor aplica
 * `?? "bloqueado"` —, e o caminho e o unico em que dado corrompido NAO
 * consegue promover autonomia.
 *
 * Isso vale mesmo com o CHECK do banco cobrindo os tres valores. O CHECK
 * protege a tabela; este filtro protege a decisao. Se um dia alguem
 * relaxar o CHECK, o pior desfecho aqui continua sendo "bloqueado".
 *
 * A contagem de descartes e derivavel por `linhas.length - fatos.length`
 * — quem quiser registrar isso nao precisa de um segundo canal de
 * retorno, e o modulo continua sem efeito colateral.
 */
export function montarFatosPermissoes(
  linhas: readonly LinhaPermissao[]
): readonly FatoPermissao[] {
  const fatos: FatoPermissao[] = [];
  const vistos = new Set<string>();

  for (const linha of linhas) {
    const funcaoId = linha.funcao_id;
    if (typeof funcaoId !== "string" || funcaoId.length === 0) continue;
    if (!nivelValido(linha.nivel)) continue;

    // A PK impede repeticao no banco. O guarda existe para o caso de a
    // entrada nao ter vindo do banco — e porque `nivelDe()` resolve
    // duplicata por `.find()`, ou seja, pela ORDEM, que e exatamente o
    // tipo de decisao que nao deve depender de sorte.
    if (vistos.has(funcaoId)) continue;
    vistos.add(funcaoId);

    fatos.push({ funcaoId, nivel: linha.nivel });
  }

  return Object.freeze(fatos);
}
