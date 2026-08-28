/**
 * Escrita autorizada de Skills — SKILL-1D.f.3-A.
 *
 * ── As tres perguntas que este modulo responde ──────────────────────
 *
 *   "guarde esta Skill na biblioteca deste dono"
 *   "este agente passa a usar ESTA versao"
 *   "este agente deixa de usar ESTA versao"
 *
 * A SKILL-1D.f.1 criou onde guardar e a 1D.f.2 ensinou a CARREGAR. Ate
 * aqui nada sabia GRAVAR: `skills` e `agente_skills` so podiam ser
 * povoadas por SQL manual. Este e o primeiro caminho de escrita.
 *
 * ── O que este modulo NAO faz ───────────────────────────────────────
 *
 * Nao promove `vigente`, nao o despromove, nao o envia no INSERT. A
 * coluna nasce `false` por DEFAULT e continua sendo autoridade do banco.
 * Promover exige despromover a versao anterior no MESMO instante, e o
 * client Supabase nao abre transacao multi-statement: duas `.update()`
 * separadas deixariam o slug sem nenhuma vigente se a segunda falhasse.
 * Isso pertence a SKILL-1D.f.4, com RPC dedicada — nao a um workaround
 * aqui.
 *
 * Nao apaga Skill (a ACL permite, o escopo nao), nao resolve versao por
 * slug, nao escolhe "a ultima", nao mescla manifestos. E nao tem
 * consumidor de producao: nenhuma rota, UI ou chat o chama, e uma sonda
 * da suite cobra esse zero.
 */
import "server-only";
import { createHash } from "node:crypto";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import { acharSegredos, importarSkill, type MotivoRecusa } from "@/lib/ia/skills/formato";
import type { ManifestoSkill } from "@/lib/ia/skills/contrato";

const TABELA_SKILLS = "skills";
const TABELA_ASSOCIACOES = "agente_skills";

/**
 * Projecao MINIMA da identidade logica.
 *
 * `manifesto` e `corpo` NAO sao lidos: a decisao de idempotencia se faz
 * por `conteudo_hash`, e trazer o conteudo de volta so ofereceria a
 * tentacao de compara-lo em memoria — ou de loga-lo.
 */
const COLUNAS_IDENTIDADE = "id, conteudo_hash";

/**
 * Os dois unicos SQLSTATE com significado de DOMINIO aqui.
 *
 * `23505` e o UNIQUE da identidade `(user_id, slug, versao)` e a PK
 * `(agente_id, skill_id)`. `23503` e qualquer das FKs compostas de
 * `agente_skills` — e as quatro causas possiveis (agente inexistente,
 * Skill inexistente, agente de outro dono, Skill de outro dono) chegam
 * aqui INDISTINGUIVEIS de proposito: separa-las viraria um oraculo de
 * existencia de recurso alheio.
 *
 * Todo o resto — `23514`, `42501`, timeout, erro de rede — vira
 * `falha_escrita`. Nao ha estado de dominio para "o banco recusou por um
 * motivo que este codigo nao previu", e inventar um seria fingir que a
 * escrita foi entendida.
 */
const SQLSTATE_UNIQUE = "23505";
const SQLSTATE_FK = "23503";

export interface EntradaImportarSkill {
  userId: string;
  texto: string;
}

/**
 * Autoridade da associacao: os TRES campos, sempre juntos. Nao existe
 * `slug` nem `versao` nesta entrada — associar por nome deixaria o
 * agente derivar para outra versao sozinho, que e exatamente o que pinar
 * um `skill_id` existe para impedir.
 */
export interface EntradaAssociacao {
  userId: string;
  agenteId: string;
  skillId: string;
}

/**
 * `skillId` sai APENAS em `criada` e `ja_existia` — os dois casos em que
 * o chamador acabou de criar, ou ja possuia, aquela linha no proprio
 * tenant. `conflito_versao` NAO devolve o id da linha conflitante: ela e
 * do mesmo dono, mas quem tentou gravar conteudo diferente sob a mesma
 * versao nao precisa de ponteiro para ela — precisa publicar outra
 * versao.
 */
export type ResultadoImportarSkill =
  | { estado: "criada"; skillId: string }
  | { estado: "ja_existia"; skillId: string }
  | { estado: "conflito_versao" }
  | { estado: "recusada"; motivos: readonly MotivoRecusa[] }
  | { estado: "entrada_invalida" }
  | { estado: "falha_escrita" };

export interface ResultadoAssociar {
  estado: "associada" | "ja_associada" | "nao_disponivel" | "entrada_invalida" | "falha_escrita";
}

export interface ResultadoDesassociar {
  estado: "desassociada" | "nao_associada" | "entrada_invalida" | "falha_escrita";
}

const IMPORTACAO_ENTRADA_INVALIDA: ResultadoImportarSkill = Object.freeze({ estado: "entrada_invalida" as const });
const IMPORTACAO_CONFLITO: ResultadoImportarSkill = Object.freeze({ estado: "conflito_versao" as const });
const IMPORTACAO_FALHA: ResultadoImportarSkill = Object.freeze({ estado: "falha_escrita" as const });

/** Congelado: o motivo do parser para segredo, reusado pela SEGUNDA
 *  barreira para que os dois caminhos recusem com o mesmo vocabulario. */
const MOTIVOS_SEGREDO: readonly MotivoRecusa[] = Object.freeze(["segredo_detectado" as MotivoRecusa]);

/** Codigo SQLSTATE do erro do PostgREST, sem tocar em `message` — a
 *  mensagem do driver vaza nome de coluna, de constraint e as vezes de
 *  VALOR, e acaba em log e em resposta HTTP. */
function codigoDe(erro: unknown): string | undefined {
  return (erro as { code?: string } | null)?.code;
}

interface LinhaIdentidade {
  id: string;
  conteudo_hash: string;
}

type LeituraIdentidade = { ok: true; linha: LinhaIdentidade | null } | { ok: false };

/**
 * A linha de `(user_id, slug, versao)`, se houver.
 *
 * Fechada por `user_id` na propria instrucao — nunca ler primeiro e
 * conferir o dono depois. Uma Skill de outro dono com o mesmo slug e a
 * mesma versao e invisivel aqui, e e por isso que dois tenants podem
 * publicar `atendimento-shopee@1.0.0` sem colidir.
 */
async function lerPorIdentidade(userId: string, slug: string, versao: string): Promise<LeituraIdentidade> {
  const r = await getSupabaseServidor()
    .from(TABELA_SKILLS)
    .select(COLUNAS_IDENTIDADE)
    .eq("user_id", userId)
    .eq("slug", slug)
    .eq("versao", versao);

  if (r.error) {
    console.error("[skills] falha ao ler identidade da Skill");
    return { ok: false };
  }

  const linhas = (r.data ?? []) as LinhaIdentidade[];

  // `skills_versao_unica` garante 0 ou 1. Duas linhas aqui significariam
  // o UNIQUE ausente do banco — escolher a primeira mascararia isso.
  if (linhas.length > 1) {
    console.error("[skills] identidade ambigua — mais de uma linha para a mesma versao");
    return { ok: false };
  }

  const linha = linhas[0];
  if (!linha) return { ok: true, linha: null };

  if (typeof linha.id !== "string" || !linha.id || typeof linha.conteudo_hash !== "string" || !linha.conteudo_hash) {
    console.error("[skills] linha de identidade estruturalmente invalida");
    return { ok: false };
  }

  return { ok: true, linha };
}

/**
 * Mesmo conteudo -> idempotente. Conteudo diferente -> conflito.
 *
 * Nunca `UPDATE`: `manifesto` e `corpo` sao imutaveis por PRIVILEGIO
 * (`service_role` so tem `update (vigente)`), entao reescrever nem
 * sequer seria possivel — e se fosse, mudaria o conteudo debaixo de todo
 * agente ja associado aquela versao.
 */
function decidirSobreExistente(linha: LinhaIdentidade, conteudoHash: string): ResultadoImportarSkill {
  if (linha.conteudo_hash === conteudoHash) return { estado: "ja_existia", skillId: linha.id };
  return IMPORTACAO_CONFLITO;
}

/**
 * Importa um texto de Skill e persiste a versao.
 *
 * ── O parser e a porta unica ────────────────────────────────────────
 *
 * A entrada e TEXTO EXTERNO. `importarSkill` ja valida marcadores,
 * limite de 64 KB, JSON, formato suportado, shape, campo proibido e
 * segredo — e nada aqui reimplementa nenhuma dessas regras. Nao existe
 * caminho que aceite `manifesto`/`corpo` prontos: sempre texto, sempre
 * pelo parser.
 *
 * ── E por que ha uma SEGUNDA varredura de segredo ───────────────────
 *
 * O parser varre o texto BRUTO. O que vai ao banco e outra coisa: o
 * manifesto ja saneado, serializado, mais o corpo — string diferente,
 * produzida depois da validacao. A segunda varredura usa exatamente a
 * mesma funcao (`acharSegredos`, de `formato.ts`), aplicada ao conteudo
 * que efetivamente sera gravado. Nenhum detector proprio.
 */
export async function importarEPersistirSkill(entrada: EntradaImportarSkill): Promise<ResultadoImportarSkill> {
  const { userId, texto } = entrada;

  // Sem dono ou sem texto nao ha o que gravar, e nao ha pergunta a fazer
  // ao banco. Zero query, zero write.
  if (!userId || !texto) return IMPORTACAO_ENTRADA_INVALIDA;

  // Hash do TEXTO BRUTO, antes do parser e sem normalizar nada: e a
  // impressao digital do que o dono entregou. CRLF e LF produzem hashes
  // diferentes de proposito — sao arquivos diferentes. O hash NAO e
  // identidade: identidade e `(user_id, slug, versao)`, e por isso nao ha
  // UNIQUE sobre ele.
  const conteudoHash = createHash("sha256").update(texto, "utf8").digest("hex");

  const importado = importarSkill(texto);
  if (importado.aceito === null) {
    // So o vocabulario fechado de `MotivoRecusa` sai. `Recusa.detalhe` e
    // texto livre derivado da entrada e fica aqui dentro — nao vai para o
    // retorno nem para o log.
    return { estado: "recusada", motivos: importado.recusas.map((r) => r.motivo) };
  }

  // ── Fechando a janela TOCTOU ──────────────────────────────────────
  //
  // `importarSkill` devolve objeto MUTAVEL. Serializar agora e reidratar
  // logo abaixo faz com que o objeto enviado ao banco NAO seja mais o do
  // parser — ninguem mais segura referencia para ele — e garante que o
  // conteudo varrido pela segunda barreira e byte a byte o mesmo que vai
  // ao INSERT. Sem `Object.freeze` em `formato.ts` e sem infraestrutura
  // nova: a serializacao ja e obrigatoria para gravar.
  const manifestoJson = JSON.stringify(importado.aceito.manifesto);
  const corpo = importado.aceito.corpo;

  // `acharSegredos` devolve os TIPOS encontrados, nunca uma amostra do
  // valor — por isso os tipos podem ir para o log.
  const segredos = acharSegredos(`${manifestoJson}\n${corpo}`);
  if (segredos.length > 0) {
    console.error(`[skills] segredo no conteudo a persistir — escrita abortada (${segredos.join(", ")})`);
    return { estado: "recusada", motivos: MOTIVOS_SEGREDO };
  }

  const manifesto = JSON.parse(manifestoJson) as ManifestoSkill;

  // As quatro colunas promovidas saem do manifesto, nunca da entrada
  // crua: os CHECKs `skills_*_igual_ao_manifesto` exigem que coluna e
  // manifesto digam a mesma coisa, e a unica forma de nao divergir e ter
  // uma fonte so. `origem` vem declarada no arquivo e validada pelo
  // parser contra `ORIGENS_SKILL` — nao se sobrescreve: "gerada_ia" e
  // procedencia, nao autorizacao.
  //
  // `vigente` NAO entra: o DEFAULT `false` do banco e a autoridade, e
  // importar nunca promove.
  const linha = {
    user_id: userId,
    slug: manifesto.id,
    versao: manifesto.versao,
    nome: manifesto.nome,
    origem: manifesto.origem,
    manifesto,
    corpo,
    conteudo_hash: conteudoHash,
  };

  const leitura = await lerPorIdentidade(userId, linha.slug, linha.versao);
  if (!leitura.ok) return IMPORTACAO_FALHA;
  if (leitura.linha) return decidirSobreExistente(leitura.linha, conteudoHash);

  const r = await getSupabaseServidor().from(TABELA_SKILLS).insert(linha).select("id");

  if (r.error) {
    const codigo = codigoDe(r.error);

    // ── A corrida, e por que isto NAO e retry ─────────────────────────
    //
    // Entre a leitura acima e este INSERT, outra importacao da MESMA
    // identidade pode ter gravado. As duas viram ausencia, uma leva o
    // UNIQUE. O INSERT nao se repete — nunca — e nao ha laco: uma unica
    // releitura deterministica diz qual dos dois estados de dominio vale,
    // exatamente como se a linha ja existisse desde o inicio.
    if (codigo === SQLSTATE_UNIQUE) {
      const releitura = await lerPorIdentidade(userId, linha.slug, linha.versao);
      if (!releitura.ok || !releitura.linha) return IMPORTACAO_FALHA;
      return decidirSobreExistente(releitura.linha, conteudoHash);
    }

    console.error(`[skills] falha ao inserir Skill (sqlstate ${codigo ?? "desconhecido"})`);
    return IMPORTACAO_FALHA;
  }

  const criada = ((r.data ?? []) as { id?: unknown }[])[0];
  if (!criada || typeof criada.id !== "string" || !criada.id) {
    // INSERT sem erro e sem id de volta: nao da para afirmar "criada" com
    // um `skillId` que nao se tem.
    console.error("[skills] insert sem id de retorno");
    return IMPORTACAO_FALHA;
  }

  return { estado: "criada", skillId: criada.id };
}

/**
 * Associa UMA versao especifica de Skill a UM agente.
 *
 * O `skill_id` e usado exatamente como recebido. Nao ha resolucao por
 * slug, versao, `vigente`, "ultima" ou "principal" — e a ausencia dessa
 * resolucao e o que mantem o pin: a Skill do agente nao muda sozinha
 * quando outra versao e promovida.
 *
 * O INSERT carrega `user_id` explicitamente, e as FKs compostas
 * `(agente_id, user_id)` e `(skill_id, user_id)` recusam no banco
 * qualquer combinacao que nao seja toda do mesmo dono. Nao se busca o
 * agente primeiro para conferir o dono depois: a conferencia esta na
 * propria escrita.
 */
export async function associarSkillAoAgente(entrada: EntradaAssociacao): Promise<ResultadoAssociar> {
  const { userId, agenteId, skillId } = entrada;

  if (!userId || !agenteId || !skillId) return { estado: "entrada_invalida" };

  const r = await getSupabaseServidor()
    .from(TABELA_ASSOCIACOES)
    .insert({ agente_id: agenteId, skill_id: skillId, user_id: userId });

  if (r.error) {
    const codigo = codigoDe(r.error);

    // Ja associada: o estado final desejado ja vale. Idempotente.
    if (codigo === SQLSTATE_UNIQUE) return { estado: "ja_associada" };

    // Agente inexistente, Skill inexistente, ou qualquer dos dois de
    // outro dono. Um estado so, de proposito.
    if (codigo === SQLSTATE_FK) return { estado: "nao_disponivel" };

    console.error(`[skills] falha ao associar Skill (sqlstate ${codigo ?? "desconhecido"})`);
    return { estado: "falha_escrita" };
  }

  return { estado: "associada" };
}

/**
 * Remove a associacao exata — e so ela.
 *
 * O DELETE e triplamente filtrado e nunca toca `skills`: desassociar e
 * dizer "este agente nao usa mais esta Skill", nao "apague esta Skill da
 * biblioteca". A Skill sobrevive, com todas as outras associacoes dela.
 *
 * Ausencia e sucesso idempotente. E a distincao sai do `.select()` do
 * proprio DELETE, nao de uma consulta previa: como o DELETE ja e fechado
 * por `user_id`, ele so pode devolver linha do proprio dono — perguntar
 * antes "existe?" seria justamente a consulta capaz de responder sobre
 * associacao alheia.
 */
export async function desassociarSkillDoAgente(entrada: EntradaAssociacao): Promise<ResultadoDesassociar> {
  const { userId, agenteId, skillId } = entrada;

  if (!userId || !agenteId || !skillId) return { estado: "entrada_invalida" };

  const r = await getSupabaseServidor()
    .from(TABELA_ASSOCIACOES)
    .delete()
    .eq("user_id", userId)
    .eq("agente_id", agenteId)
    .eq("skill_id", skillId)
    .select("skill_id");

  if (r.error) {
    console.error(`[skills] falha ao desassociar Skill (sqlstate ${codigoDe(r.error) ?? "desconhecido"})`);
    return { estado: "falha_escrita" };
  }

  const removidas = ((r.data ?? []) as unknown[]).length;
  return { estado: removidas > 0 ? "desassociada" : "nao_associada" };
}
