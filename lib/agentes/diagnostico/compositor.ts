/**
 * Diagnostico de UM agente — SKILL-1D.consumer-B2.
 *
 * ── A pergunta que este modulo responde ─────────────────────────────
 *
 *   "cada Skill deste agente esta pronta para operar, e o que falta?"
 *
 * E a primeira peca a compor as quatro camadas publicadas. Ate aqui cada
 * uma sabia responder a sua parte e nenhuma se falava: `skills/fatos`
 * sabe QUAIS Skills o agente usa, `conexoes/agregador` sabe se as contas
 * exigidas servem, `permissoes/fatos` sabe o que o dono liberou,
 * `funcoes/registry` sabe o que a CDS realmente executa, e
 * `diagnosticarSkill` sabe julgar — mas so recebendo tudo pronto.
 *
 * ── Fatos GLOBAIS, motor por Skill ──────────────────────────────────
 *
 * Conexoes, permissoes e funcoes sao resolvidas UMA vez por agente e
 * passadas identicas a cada chamada do motor. Isso e seguro porque
 * `diagnosticarSkill` itera pelos REQUISITOS da Skill que recebe, nunca
 * pela lista de fatos: um fato que so interessa a outra Skill e
 * simplesmente nao consultado. Resolver por Skill multiplicaria leituras
 * para produzir exatamente o mesmo resultado.
 *
 * ── O que este modulo NAO faz ───────────────────────────────────────
 *
 * Nao abre banco: nao importa `getSupabaseServidor`, e nao ha `.from(`,
 * `.select(` nem nome de tabela aqui. Nao le credencial. Nao escreve.
 * Nao julga — `diagnosticarSkill` continua sendo o motor, e este modulo
 * so lhe entrega fatos. Nao escolhe loja, nao escolhe versao vigente,
 * nao agrupa Skills por slug e nao conhece marketplace: `shopee` e
 * `mercado_livre` nao aparecem em lugar nenhum, porque o dominio ja
 * chega canonicalizado.
 *
 * E nao tem consumidor de producao: nenhuma rota, UI ou runtime o chama,
 * e uma sonda da suite cobra esse zero.
 *
 * ── Tudo ou nada ────────────────────────────────────────────────────
 *
 * Falha em qualquer das tres leituras devolve as colecoes VAZIAS. Meia
 * resposta apresentada como resposta inteira faria o dono ver "esta
 * Skill esta pronta" sobre permissoes que ninguem chegou a apurar.
 */
import "server-only";
import { resolverSkillsDoAgente } from "@/lib/agentes/skills/fatos";
import { resolverConexoesDoAgente } from "@/lib/agentes/conexoes/agregador";
import { resolverFatosPermissoes } from "@/lib/agentes/permissoes/fatos";
import { funcaoExiste } from "@/lib/agentes/funcoes/registry";
import { diagnosticarSkill, type Diagnostico, type FatoFuncao } from "@/lib/ia/skills/diagnostico";
import type { RequisitoConexao } from "@/lib/ia/skills/contrato";

/**
 * Tres campos, e a lista curta e a defesa: nao ha Skill, lojaId, selecao,
 * permissao nem fato pre-resolvido na entrada. Descobrir tudo isso a
 * partir do agente E a responsabilidade deste modulo — aceitar qualquer
 * um pronto devolveria ao chamador uma decisao que as camadas de baixo
 * ja tomam com autoridade.
 *
 * `agoraMs` atravessa inalterado ate o agregador, que decide expiracao.
 * Nao ha segunda autoridade temporal aqui.
 */
export interface EntradaDiagnosticoDoAgente {
  userId: string;
  agenteId: string;
  agoraMs: number;
}

/**
 * UM diagnostico, e a identidade de QUEM foi diagnosticado.
 *
 * `skillId` e `manifesto.id` — o slug logico —, nao o uuid da linha:
 * `resolverSkillsDoAgente` devolve `{ manifesto, corpo }` e nao expoe o
 * uuid, e ir busca-lo custaria uma leitura para um dado que ninguem pediu.
 *
 * `versao` acompanha porque duas versoes da MESMA Skill podem estar
 * associadas ao mesmo agente — a 1D.e formalizou que ambas participam.
 * Sem ela, dois itens do envelope ficariam indistinguiveis.
 */
export interface DiagnosticoDeSkill {
  skillId: string;
  versao: string;
  diagnostico: Diagnostico;
}

/**
 * Como a composicao terminou. Mesmo vocabulario das tres camadas que ela
 * coordena — nenhum estado novo nasce aqui.
 */
export type ColetaDiagnostico = "ok" | "falha_leitura" | "entrada_invalida";

/**
 * `diagnosticos` traz UM item por Skill associada, na ordem publicada.
 *
 * `semSelecao` vem do agregador e e apenas TRANSPORTADO: requisito que
 * existe e ainda nao tem loja escolhida. O motor nao o recebe — para ele,
 * a ausencia do `FatoConexao` ja significa `FALTA_CONEXAO`. Guardar a
 * distincao aqui custa nada e preserva a informacao que o diagnostico
 * colapsa: "escolha uma loja" e "a conta escolhida nao serve" pedem
 * acoes diferentes do dono, e o leitor dessa diferenca ainda nao existe.
 */
export interface ResultadoDiagnosticoDoAgente {
  diagnosticos: readonly DiagnosticoDeSkill[];
  semSelecao: readonly RequisitoConexao[];
  coleta: ColetaDiagnostico;
}

const VAZIO = Object.freeze({
  diagnosticos: Object.freeze([]) as readonly DiagnosticoDeSkill[],
  semSelecao: Object.freeze([]) as readonly RequisitoConexao[],
});

const ENTRADA_INVALIDA: ResultadoDiagnosticoDoAgente = Object.freeze({
  ...VAZIO,
  coleta: "entrada_invalida" as const,
});

const FALHA: ResultadoDiagnosticoDoAgente = Object.freeze({
  ...VAZIO,
  coleta: "falha_leitura" as const,
});

const SEM_SKILLS: ResultadoDiagnosticoDoAgente = Object.freeze({
  ...VAZIO,
  coleta: "ok" as const,
});

/** Uma coleta que nao terminou em `ok` vira o resultado publico
 *  correspondente — `entrada_invalida` se a camada de baixo disse que
 *  faltou autoridade, `falha_leitura` para todo o resto. */
function abortar(coleta: string): ResultadoDiagnosticoDoAgente {
  return coleta === "entrada_invalida" ? ENTRADA_INVALIDA : FALHA;
}

/**
 * Os ids de Funcao exigidos por TODAS as Skills, deduplicados e ordenados.
 *
 * `funcoes` e `funcoes_opcionais` entram JUNTAS: a diferenca entre elas e
 * de severidade, e quem decide isso e o motor. Deixar a opcional de fora
 * da coleta faria uma Funcao existente e liberada parecer inexistente.
 *
 * A ordenacao lexicografica existe para que a lista enviada as permissoes
 * nao dependa da ordem das Skills nem da iteracao de um `Set`.
 */
function funcaoIdsDeTodasAsSkills(
  skills: readonly { manifesto: { requer?: { funcoes?: readonly string[]; funcoes_opcionais?: readonly string[] } } }[]
): readonly string[] {
  const ids = new Set<string>();
  for (const s of skills) {
    for (const id of s.manifesto.requer?.funcoes ?? []) ids.add(id);
    for (const id of s.manifesto.requer?.funcoes_opcionais ?? []) ids.add(id);
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

/**
 * Diagnostica todas as Skills de UM agente.
 *
 * ── A ordem das leituras, e por que ela e essa ──────────────────────
 *
 * Skills primeiro, porque sem Skill nao ha o que diagnosticar: um agente
 * sem nenhuma associada custa UMA leitura e nada mais — nem conexoes, nem
 * permissoes, nem motor. Conexoes depois, uma vez. Permissoes por ultimo,
 * ja com a lista completa de Funcoes exigidas, tambem uma vez. O motor e
 * puro e roda por Skill sem custo de I/O.
 *
 * ── Por que `resolverFatosPermissoes` e chamada mesmo sem Funcoes ───
 *
 * Ela ja trata lista vazia: devolve `ok` com zero fatos e ZERO consulta.
 * Repetir esse curto-circuito aqui duplicaria a regra em dois lugares que
 * um dia discordariam.
 */
export async function diagnosticarAgente(
  entrada: EntradaDiagnosticoDoAgente
): Promise<ResultadoDiagnosticoDoAgente> {
  const { userId, agenteId, agoraMs } = entrada;

  // Sem autoridade nao ha pergunta a fazer. Zero leitura.
  if (!userId || !agenteId) return ENTRADA_INVALIDA;

  const skills = await resolverSkillsDoAgente({ userId, agenteId });
  if (skills.coleta !== "ok") {
    // "Nao consegui ler as Skills" NUNCA vira "o agente nao tem Skills":
    // a segunda afirmacao produziria um envelope limpo sobre uma verdade
    // que ninguem apurou.
    return abortar(skills.coleta);
  }

  // Nenhuma Skill e resposta COMPLETA, nao ausencia de resposta. Nada a
  // diagnosticar, e as duas leituras seguintes nem acontecem.
  if (skills.skills.length === 0) return SEM_SKILLS;

  const conexoes = await resolverConexoesDoAgente({ userId, agenteId, agoraMs });
  if (conexoes.coleta !== "ok") return abortar(conexoes.coleta);

  const funcaoIds = funcaoIdsDeTodasAsSkills(skills.skills);

  const permissoes = await resolverFatosPermissoes({ userId, agenteId, funcaoIds });
  if (permissoes.coleta !== "ok") {
    // `conexoes` e `semSelecao` ja estavam em maos — e nao saem assim
    // mesmo. Devolver metade da resposta com aparencia de resposta
    // inteira e o modo de falha que este envelope existe para impedir.
    return abortar(permissoes.coleta);
  }

  // Puro: o registry responde EXISTENCIA, e so para os ids que alguma
  // Skill pediu. Despejar o catalogo inteiro daria ao motor fatos sobre
  // Funcoes que ninguem exigiu.
  const funcoes: readonly FatoFuncao[] = funcaoIds.map((id) => ({ id, existe: funcaoExiste(id) }));

  // Os MESMOS fatos para todas as Skills. `configuracoes` fica de fora:
  // o campo e opcional e nao ha produtor publicado de `FatoConfiguracao`
  // — passar `[]` afirmaria "apurei e nao ha", que e diferente de "nao
  // apurei".
  const diagnosticos = skills.skills.map((s) => ({
    skillId: s.manifesto.id,
    versao: s.manifesto.versao,
    diagnostico: diagnosticarSkill({
      skill: { id: s.manifesto.id, requer: s.manifesto.requer },
      funcoes,
      permissoes: permissoes.fatos,
      conexoes: conexoes.conexoes,
    }),
  }));

  return { diagnosticos, semSelecao: conexoes.semSelecao, coleta: "ok" };
}
