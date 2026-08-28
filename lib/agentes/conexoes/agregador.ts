/**
 * Requisito -> selecao -> conexao — SKILL-1D.e-B2.
 *
 * ── A pergunta que este modulo responde ─────────────────────────────
 *
 *   "das conexoes que as Skills deste agente exigem, quais estao
 *    resolvidas, e quais ainda nao tem loja escolhida?"
 *
 * Cada peca ja existia e nenhuma se falava. `resolverSkillsDoAgente`
 * sabe QUAIS Skills o agente usa; o manifesto delas declara o que exigem;
 * `resolverSelecoesDoAgente` sabe QUAL loja o dono escolheu para cada
 * requisito; `resolverFatosConexao` sabe se aquela loja SERVE. Este
 * modulo e a costura — e so a costura.
 *
 * ── O que ele NAO faz ───────────────────────────────────────────────
 *
 * Nao abre banco: nao importa `getSupabaseServidor`, nao ha `.from(`,
 * `.select(` nem `.eq(` aqui. Nao le credencial: `FatoConexao` chega
 * pronto e seguro da camada que e dona do segredo. Nao diagnostica:
 * `diagnosticarSkill` continua sendo o motor, e recebe FATOS. Nao
 * escreve, nao consulta permissao e nao tem consumidor de producao.
 *
 * E, acima de tudo, nao ESCOLHE loja. Requisito sem selecao persistida
 * sai em `semSelecao` — nunca vira "a primeira loja compativel".
 *
 * ── Por que UMA chamada em lote, e nao um laco ──────────────────────
 *
 * `resolverFatoConexao` custa uma leitura de `lojas` por requisito, e
 * cada leitura projeta credencial. A auditoria da 1D.e-A2 mediu que nao
 * existe teto estrutural de requisitos: `requer.conexoes` escapa do
 * limite de lista do parser, um agente pode ter quantas Skills quiser e
 * `recurso` e slug aberto. Por isso o join inteiro acontece ANTES, e a
 * camada de conexao e chamada exatamente uma vez.
 *
 * ── Tudo ou nada ────────────────────────────────────────────────────
 *
 * Falha em qualquer das tres leituras devolve as duas colecoes VAZIAS.
 * Uma resposta parcial apresentada como completa faria o diagnostico
 * afirmar "esta conexao falta" sobre algo que ninguem chegou a apurar.
 */
import "server-only";
import { resolverSkillsDoAgente } from "@/lib/agentes/skills/fatos";
import { resolverSelecoesDoAgente } from "@/lib/agentes/conexoes/selecao-fatos";
import { resolverFatosConexao, type PedidoConexao } from "@/lib/agentes/conexoes/fatos";
import type { FatoConexao } from "@/lib/ia/skills/diagnostico";
import type { RequisitoConexao } from "@/lib/ia/skills/contrato";

/**
 * Dois campos, e a lista curta e a defesa: nao ha `lojaId`, `plataforma`,
 * `recurso` nem selecao na entrada. Descobrir a loja a partir da escolha
 * PERSISTIDA e justamente a razao de existir deste modulo — aceita-la de
 * fora devolveria ao chamador a decisao que a 1D.g tirou dele.
 *
 * `agoraMs` entra por parametro, como em `resolverFatosConexao`: a
 * avaliacao de expiracao depende do tempo, e o determinismo e do
 * pipeline inteiro.
 */
export interface EntradaConexoesDoAgente {
  userId: string;
  agenteId: string;
  agoraMs: number;
}

/**
 * Como a composicao terminou.
 *
 * Nao ha `ausente`: ausencia aqui nao e da colecao, e de cada item —
 * requisito sem loja escolhida vai para `semSelecao`, e requisito cuja
 * loja nao serve simplesmente nao produz fato.
 */
export type ColetaConexoesDoAgente = "ok" | "falha_leitura" | "entrada_invalida";

/**
 * As duas colecoes, e a diferenca entre elas e o ponto do modulo.
 *
 * `conexoes` entra SEM ADAPTADOR em `EntradaDiagnostico.conexoes`: fato
 * ausente da lista ja significa "nao ha conexao" para `avaliarConexao`.
 *
 * `semSelecao` guarda o que o diagnostico de hoje nao consegue
 * distinguir. "Voce nao escolheu a loja" e "a conta escolhida nao cobre
 * o recurso" pedem acoes diferentes do dono, e as duas colapsariam em
 * `FALTA_CONEXAO`. Preservar a informacao aqui custa nada e nao inventa
 * estado novo no vocabulario publicado.
 *
 * Um requisito nunca aparece nas duas: ou tem selecao, ou nao tem.
 */
export interface ResultadoConexoesDoAgente {
  conexoes: readonly FatoConexao[];
  semSelecao: readonly RequisitoConexao[];
  coleta: ColetaConexoesDoAgente;
}

const VAZIO = Object.freeze({
  conexoes: Object.freeze([]) as readonly FatoConexao[],
  semSelecao: Object.freeze([]) as readonly RequisitoConexao[],
});

const ENTRADA_INVALIDA: ResultadoConexoesDoAgente = Object.freeze({
  ...VAZIO,
  coleta: "entrada_invalida" as const,
});

const FALHA: ResultadoConexoesDoAgente = Object.freeze({
  ...VAZIO,
  coleta: "falha_leitura" as const,
});

const SEM_REQUISITOS: ResultadoConexoesDoAgente = Object.freeze({
  ...VAZIO,
  coleta: "ok" as const,
});

/**
 * Os requisitos de TODAS as Skills, deduplicados e ordenados.
 *
 * ── Identidade ──────────────────────────────────────────────────────
 *
 * `(plataforma, recurso)`, e nada alem. `obrigatoria` NAO entra na
 * identidade — ela e atributo do requisito, nao parte dele —, e por isso
 * duas declaracoes do mesmo par com exigencias diferentes viram UMA, com
 * `obrigatoria` combinada por OR: se qualquer Skill a exige, ela e
 * exigida. Mesma regra que `diagnosticarSkill` ja aplica dentro de uma
 * Skill; aqui ela vale ENTRE Skills.
 *
 * `skill_id`, slug e versao ficam de fora: nenhum consumidor publicado
 * os le, e proveniencia sem leitor e autoridade sem uso.
 *
 * ── Mapa aninhado, nao chave de texto ───────────────────────────────
 *
 * `Map<plataforma, Map<recurso, ...>>` em vez de `${p}/${r}`: os dois
 * campos sao slugs livres, e concatenar com separador cria a chance de
 * colisao que a estrutura simplesmente nao tem. `chaveConexao` existe em
 * `diagnostico.ts`, mas nao e exportada — e exporta-la exigiria editar um
 * arquivo fora desta frente.
 *
 * ── Ordem ───────────────────────────────────────────────────────────
 *
 * plataforma, depois recurso — a MESMA de `ordenarSelecoes`. Ela dirige
 * o join, os pedidos e as duas colecoes de saida; sem ela, a ordem das
 * Skills (ou a do banco) decidiria a da resposta.
 */
function requisitosDeduplicados(
  skills: readonly { manifesto: { requer?: { conexoes?: readonly RequisitoConexao[] } } }[]
): readonly RequisitoConexao[] {
  const porPlataforma = new Map<string, Map<string, RequisitoConexao>>();

  for (const s of skills) {
    for (const r of s.manifesto.requer?.conexoes ?? []) {
      let porRecurso = porPlataforma.get(r.plataforma);
      if (porRecurso === undefined) {
        porRecurso = new Map<string, RequisitoConexao>();
        porPlataforma.set(r.plataforma, porRecurso);
      }
      const antes = porRecurso.get(r.recurso);
      porRecurso.set(
        r.recurso,
        antes === undefined
          ? { plataforma: r.plataforma, recurso: r.recurso, obrigatoria: r.obrigatoria }
          : { ...antes, obrigatoria: antes.obrigatoria || r.obrigatoria }
      );
    }
  }

  const saida: RequisitoConexao[] = [];
  for (const porRecurso of porPlataforma.values()) for (const r of porRecurso.values()) saida.push(r);

  return saida.sort((a, b) =>
    a.plataforma === b.plataforma
      ? a.recurso.localeCompare(b.recurso)
      : a.plataforma.localeCompare(b.plataforma)
  );
}

/**
 * Compoe as conexoes de UM agente.
 *
 * ── A ordem das leituras, e por que ela e essa ──────────────────────
 *
 * Skills primeiro, porque sem requisito nao ha o que perguntar: agente
 * sem Skill, ou com Skills que nao exigem conexao, custa UMA ou DUAS
 * leituras e nenhuma a mais. Selecoes depois, uma vez so. Conexoes por
 * ultimo, tambem uma vez so, com o join inteiro ja resolvido.
 *
 * ── O join e dirigido pelos REQUISITOS ──────────────────────────────
 *
 * Percorre-se requisito a requisito procurando a selecao EXATA do par —
 * nunca o contrario. E isso que faz selecao obsoleta ser simplesmente
 * ignorada: se `(shopee, pedidos)` esta persistida mas nenhuma Skill a
 * exige mais, ela nao aparece em lugar nenhum e nao vai ao lote.
 *
 * O match e pelos DOIS campos. Casar so por plataforma faria
 * `(shopee, chat)` herdar a loja escolhida para `(shopee, pedidos)` —
 * agir na conta errada por conta de um requisito que ninguem configurou.
 */
export async function resolverConexoesDoAgente(
  entrada: EntradaConexoesDoAgente
): Promise<ResultadoConexoesDoAgente> {
  const { userId, agenteId, agoraMs } = entrada;

  // Sem autoridade nao ha pergunta a fazer. Zero leitura.
  if (!userId || !agenteId) return ENTRADA_INVALIDA;

  const skills = await resolverSkillsDoAgente({ userId, agenteId });
  if (skills.coleta !== "ok") {
    // "Nao consegui ler os requisitos" NUNCA vira "o agente nao tem
    // requisitos": a segunda afirmacao produziria um diagnostico limpo
    // sobre uma verdade que ninguem apurou.
    return skills.coleta === "entrada_invalida" ? ENTRADA_INVALIDA : FALHA;
  }

  const requisitos = requisitosDeduplicados(skills.skills);

  // Nenhum requisito e resposta COMPLETA, nao ausencia de resposta. Nada
  // a cruzar, nada a resolver: as duas leituras seguintes nem acontecem.
  if (requisitos.length === 0) return SEM_REQUISITOS;

  const selecoes = await resolverSelecoesDoAgente({ userId, agenteId });
  if (selecoes.coleta !== "ok") {
    return selecoes.coleta === "entrada_invalida" ? ENTRADA_INVALIDA : FALHA;
  }

  // Indexacao pelo par, na mesma forma da deduplicacao — o join e uma
  // busca exata, nunca uma varredura com criterio parcial.
  const selecaoPorPar = new Map<string, Map<string, string>>();
  for (const s of selecoes.selecoes) {
    let porRecurso = selecaoPorPar.get(s.plataforma);
    if (porRecurso === undefined) {
      porRecurso = new Map<string, string>();
      selecaoPorPar.set(s.plataforma, porRecurso);
    }
    porRecurso.set(s.recurso, s.lojaId);
  }

  const semSelecao: RequisitoConexao[] = [];
  const pedidos: PedidoConexao[] = [];

  for (const r of requisitos) {
    const lojaId = selecaoPorPar.get(r.plataforma)?.get(r.recurso);
    if (lojaId === undefined) {
      semSelecao.push(r);
      continue;
    }
    // O pedido carrega o TRIO minimo. `obrigatoria` fica de fora: a
    // camada de conexao responde se a loja serve, nao o quanto ela
    // importa.
    pedidos.push({ plataforma: r.plataforma, recurso: r.recurso, lojaId });
  }

  // Nenhum requisito escolhido: a colecao de fatos e vazia por direito, e
  // o lote nao roda. Uma consulta sem pedido seria round trip para
  // responder o que ja se sabe.
  if (pedidos.length === 0) {
    return { conexoes: VAZIO.conexoes, semSelecao, coleta: "ok" };
  }

  const fatos = await resolverFatosConexao({ userId, pedidos, agoraMs });
  if (fatos.coleta !== "ok") {
    // `semSelecao` ja estava calculado — e nao sai assim mesmo. Devolver
    // metade da resposta com aparencia de resposta inteira e o modo de
    // falha que este envelope existe para impedir.
    return FALHA;
  }

  // Os fatos saem exatamente como a camada de conexao os produziu:
  // `estado`, `cobertura`, `ativo`, `marketplace` e validade sao dela, e
  // reinterpretar qualquer um aqui criaria uma segunda autoridade sobre a
  // mesma pergunta. Requisito com selecao cuja loja nao serve nao aparece
  // em `conexoes` NEM em `semSelecao`: a escolha existe, e a ausencia do
  // fato ja e o que `avaliarConexao` le como falta de conexao.
  return { conexoes: fatos.fatos, semSelecao, coleta: "ok" };
}
