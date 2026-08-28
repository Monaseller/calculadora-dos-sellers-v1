/**
 * Regra PURA de leitura de Skills — SKILL-1D.f.2.
 *
 * Sem banco, sem rede, sem `server-only`, sem `Date.now()`. Tudo que
 * decide o que as linhas significam mora aqui, e por isso a suite executa
 * este modulo de verdade. `fatos.ts` e `server-only`: ele le `skills` e
 * `agente_skills` com a service_role, e por isso nao pode ser importado
 * por teste.
 *
 * ── FAIL-CLOSED, E A DIFERENCA EM RELACAO A PERMISSOES ──────────────
 *
 * Em `permissoes/estado.ts` uma linha invalida e DESCARTADA: o efeito e
 * o mesmo da ausencia, e ausencia significa bloqueado — descartar falha
 * para o lado seguro e se corrige sozinho.
 *
 * Aqui e o oposto. Descartar uma Skill invalida faria o agente PERDER
 * capacidade que o dono configurou, enquanto a coleta continuaria
 * dizendo "ok". Silencioso e errado. Por isso qualquer linha
 * estruturalmente invalida derruba a COLETA INTEIRA: as funcoes abaixo
 * devolvem `null`, e `fatos.ts` traduz isso em `falha_leitura`.
 *
 * Nunca ha resultado parcial.
 *
 * ── POR QUE NAO REUSAR `importarSkill()` ────────────────────────────
 *
 * Aquele parser trabalha com TEXTO BRUTO de importacao: marcadores
 * `cds-skill`, limite de 64 KB, deteccao de segredo, normalizacao de
 * entrada externa. O banco guarda o objeto JA SANEADO e o corpo em
 * colunas separadas — reusa-lo exigiria re-serializar para `.skill.md`,
 * o que seria absurdo.
 *
 * O que se valida aqui e o SHAPE PERSISTIDO, e so ele. Regras de formato
 * profundo (SemVer, regex de slug, URL `https:`) pertencem ao write path
 * e aos CHECKs do banco — repeti-las aqui criaria uma terceira copia que
 * diverge na primeira mudanca. O que NAO se faz, em nenhuma hipotese, e
 * `manifesto as ManifestoSkill`: a funcao publica promete `Skill[]`.
 */
import {
  FORMATO_SUPORTADO,
  ORIGENS_SKILL,
  type ManifestoSkill,
  type RequisitosSkill,
  type Skill,
  type Verificacao,
  ehPlataformaConexao,
} from "@/lib/ia/skills/contrato";

// ─── Linhas cruas ─────────────────────────────────────────────────────

/**
 * Uma linha de `agente_skills`, como sai do driver. `unknown` de
 * proposito: o banco e I/O, e tipar I/O como se ja fosse valido e a forma
 * mais comum de confiar no que ninguem verificou.
 *
 * `user_id` e `agente_id` NAO entram: sao a autoridade da consulta, e
 * reproduzi-los aqui so ofereceria a tentacao de reconfirmar em memoria
 * o que a instrucao ja garantiu.
 */
export interface LinhaAssociacao {
  skill_id: unknown;
  criado_em: unknown;
}

/** Uma linha de `skills`. `id` existe para casar o mapa, e nao sai no
 *  retorno publico. */
export interface LinhaSkill {
  id: unknown;
  manifesto: unknown;
  corpo: unknown;
}

/** Associacao ja validada e ordenada. */
export interface Associacao {
  skillId: string;
  criadoEm: string;
}

// ─── Filtros de autoridade ────────────────────────────────────────────
//
// Exportados pelo mesmo motivo de `filtrosPermissoesDoAgente`: e sobre
// eles que a suite prova "toda leitura carrega `user_id`". Inspecionar o
// filtro e barato; inspecionar a query montada exigiria banco.
//
// `String(userId)` porque a coluna e TEXT: comparar sem normalizar vira
// recusa silenciosa por tipo — que aqui se pareceria com "este agente nao
// tem Skill nenhuma".

/** QUERY 1 — as associacoes deste agente, deste dono. */
export function filtrosAssociacoesDoAgente(
  agenteId: string,
  userId: string
): Record<string, unknown> {
  return { agente_id: agenteId, user_id: String(userId) };
}

/**
 * QUERY 2 — as Skills, filtradas de novo por dono.
 *
 * Redundante diante da FK composta, e deliberado: a FK garante que o PAR
 * (skill, dono) e coerente, nao que ele seja o par do dono da sessao. O
 * `IN (ids)` sozinho aceitaria um uuid alheio que tivesse vazado.
 */
export function filtrosSkillsDoDono(userId: string): Record<string, unknown> {
  return { user_id: String(userId) };
}

// ─── Validadores estruturais ──────────────────────────────────────────

const texto = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** Lista de textos NAO VAZIA. O contrato e explicito: chave ausente em
 *  vez de `[]` — uma lista vazia seria afirmacao sem lastro. */
const listaDeTextos = (v: unknown): v is readonly string[] =>
  Array.isArray(v) && v.length > 0 && v.every(texto);

const objeto = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `{ em, fontes }`, com `fontes` nunca vazio quando a chave existe. */
function verificacaoValida(v: unknown): v is Verificacao {
  if (!objeto(v)) return false;
  return texto(v.em) && listaDeTextos(v.fontes);
}

/**
 * `RequisitosSkill`. Cada lista e opcional; presente, nao pode ser vazia
 * — "nao preciso disto" se diz OMITINDO a chave.
 */
function requisitosValidos(v: unknown): v is RequisitosSkill {
  if (!objeto(v)) return false;
  if (v.funcoes !== undefined && !listaDeTextos(v.funcoes)) return false;
  if (v.funcoes_opcionais !== undefined && !listaDeTextos(v.funcoes_opcionais)) return false;
  if (v.conexoes !== undefined) {
    if (!Array.isArray(v.conexoes) || v.conexoes.length === 0) return false;
    for (const c of v.conexoes) {
      if (!objeto(c)) return false;
      // `plataforma` pela AUTORIDADE, nao por `texto()`. O parser de
      // importacao ja recusa grafia nao canonica; sem isto, uma Skill
      // gravada antes desta frente entregaria ao agregador um requisito
      // que nenhuma selecao pode satisfazer — `plataformaConhecida`
      // barra a escrita e a leitura da selecao — e o dono veria uma
      // pendencia que nenhuma acao resolve.
      if (!ehPlataformaConexao(c.plataforma) || !texto(c.recurso)) return false;
      if (typeof c.obrigatoria !== "boolean") return false;
    }
  }
  return true;
}

/**
 * O manifesto persistido tem a forma de `ManifestoSkill`?
 *
 * Obrigatorios sempre; opcionais so quando a chave existe. `formato` e
 * comparado com `FORMATO_SUPORTADO` da aplicacao — o CHECK do banco ja
 * exige o mesmo, e a coincidencia e o ponto: se um dia divergirem, esta
 * leitura recusa em vez de entregar manifesto que os leitores nao sabem
 * ler.
 */
export function manifestoValido(v: unknown): v is ManifestoSkill {
  if (!objeto(v)) return false;

  if (v.formato !== FORMATO_SUPORTADO) return false;
  if (!texto(v.id)) return false;
  if (!texto(v.nome)) return false;
  if (!texto(v.versao)) return false;
  if (!texto(v.descricao)) return false;
  if (!listaDeTextos(v.quando_usar)) return false;
  if (typeof v.origem !== "string") return false;
  if (!(ORIGENS_SKILL as readonly string[]).includes(v.origem)) return false;

  if (v.requer !== undefined && !requisitosValidos(v.requer)) return false;
  if (v.fichas !== undefined && !listaDeTextos(v.fichas)) return false;
  if (v.verificacao !== undefined && !verificacaoValida(v.verificacao)) return false;

  return true;
}

// ─── Ordem canonica ───────────────────────────────────────────────────

/**
 * As associacoes, validadas e em ordem DETERMINISTICA.
 *
 * `null` se qualquer linha for invalida ou se houver `skill_id` repetido
 * — repeticao tornaria o mapeamento ambiguo, e ambiguidade aqui e
 * fail-closed.
 *
 * ── POR QUE O DESEMPATE POR `skill_id` NAO E DECORATIVO ─────────────
 *
 * `criado_em` tem `default now()`, e `now()` e `transaction_timestamp()`
 * — CONSTANTE dentro de uma transacao. Associar varias Skills de uma vez
 * produz `criado_em` IDENTICO, que e justamente o caso mais provavel
 * quando o write path existir. Sem o segundo criterio a ordem ficaria
 * indefinida exatamente ali.
 *
 * A ordenacao tambem acontece no SQL. Repeti-la aqui nao e redundancia
 * inutil: e o que torna a ordem PROVAVEL sem banco, e o que impede que a
 * ordem do driver decida qualquer coisa.
 */
export function ordenarAssociacoes(linhas: readonly LinhaAssociacao[]): readonly Associacao[] | null {
  const saida: Associacao[] = [];
  const vistos = new Set<string>();

  for (const l of linhas) {
    if (!texto(l.skill_id) || !texto(l.criado_em)) return null;
    if (vistos.has(l.skill_id)) return null;
    vistos.add(l.skill_id);
    saida.push({ skillId: l.skill_id, criadoEm: l.criado_em });
  }

  saida.sort((a, b) =>
    a.criadoEm < b.criadoEm ? -1 : a.criadoEm > b.criadoEm ? 1 : a.skillId < b.skillId ? -1 : a.skillId > b.skillId ? 1 : 0
  );
  return Object.freeze(saida);
}

// ─── Montagem ─────────────────────────────────────────────────────────

/**
 * Associacoes + linhas de `skills` -> `Skill[]`, na ordem das
 * ASSOCIACOES.
 *
 * A ordem da QUERY 2 nao e autoridade: `.in(ids)` nao promete devolver na
 * ordem pedida. Por isso as linhas viram MAPA e a lista e reconstruida
 * seguindo a ordem canonica.
 *
 * Devolve `null` — coleta inteira falha — quando:
 *
 *   - alguma linha de `skills` e estruturalmente invalida;
 *   - o mesmo `id` aparece duas vezes (mapa ambiguo);
 *   - falta a Skill de alguma associacao.
 *
 * O ultimo caso merece nota: pode significar corrida com um DELETE, ou
 * dado inconsistente. Em qualquer leitura, devolver a coleção sem ela
 * seria dizer "estas sao as Skills do agente" omitindo uma que o dono
 * configurou. Fail-closed.
 */
export function montarSkills(
  associacoes: readonly Associacao[],
  linhas: readonly LinhaSkill[]
): readonly Skill[] | null {
  const porId = new Map<string, Skill>();

  for (const l of linhas) {
    if (!texto(l.id)) return null;
    if (porId.has(l.id)) return null;
    if (!manifestoValido(l.manifesto)) return null;
    if (typeof l.corpo !== "string") return null;

    porId.set(l.id, Object.freeze({ manifesto: l.manifesto, corpo: l.corpo }));
  }

  const saida: Skill[] = [];
  for (const a of associacoes) {
    const s = porId.get(a.skillId);
    if (s === undefined) return null;
    saida.push(s);
  }

  return Object.freeze(saida);
}
