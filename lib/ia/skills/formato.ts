/**
 * CDS Skill Format v1 — leitura de um arquivo importado. SKILL-1B.
 *
 * ── Um pipeline, nao duas camadas ───────────────────────────────────
 *
 * Extrair, parsear e validar estao no MESMO arquivo de proposito. Nao e
 * economia de arquivo: e que a ORDEM e a parte que protege.
 *
 *   1. tamanho          barato, e o unico que roda antes de tudo
 *   2. extrair bloco    duplicado recusa, nunca escolhe
 *   3. JSON.parse       sem eval, sem YAML, sem parser proprio
 *   4. formato          desconhecido recusa, nunca adapta
 *   5. copia campo a campo
 *   6. campos desconhecidos/proibidos -> descartados e REPORTADOS
 *   7. varredura de segredo
 *   8. resultado estruturado
 *
 * Separar em "parser" e "validacao" esconderia essa sequencia em dois
 * lugares, e ela e o contrato.
 *
 * ── Por que JSON, e nao YAML ────────────────────────────────────────
 *
 * A entrada e arquivo de fora, potencialmente hostil. `JSON.parse` esta
 * no runtime e nao executa nada. Um parser de YAML seria dependencia
 * nova de terceiro processando entrada nao confiavel — e ainda traria as
 * armadilhas de tipo implicito (`no` -> `false`, `1.20` -> numero) num
 * arquivo escrito a mao por quem nao conhece essas regras.
 *
 * ── Modulo PURO ─────────────────────────────────────────────────────
 *
 * Recebe `string`, devolve resultado. Nao le disco, nao faz rede, nao
 * toca banco, nao busca URL. Onde o texto foi obtido e problema de
 * quem chama — e nesta fase ninguem chama: nao ha upload nem storage.
 */
import {
  FORMATO_SUPORTADO,
  ehOrigemSkill,
  ehPlataformaConexao,
  type Ficha,
  type ManifestoFicha,
  type ManifestoSkill,
  type RequisitoConexao,
  type RequisitosSkill,
  type Skill,
  type Verificacao,
} from "@/lib/ia/skills/contrato";

// ─── Limites ──────────────────────────────────────────────────────────

/**
 * Teto do arquivo inteiro, em BYTES — nao em caracteres.
 *
 * Medido antes de qualquer parse, porque e a unica barreira que custa
 * quase nada e protege de todas as outras etapas. 64 KB e generoso para
 * conhecimento operacional (o corpo desta fase inteira nao chega perto)
 * e pequeno o bastante para que um arquivo absurdo pare aqui.
 *
 * `TextEncoder` porque `String.length` conta unidades UTF-16: um texto
 * com acento e emoji ocupa mais bytes do que aparenta, e o limite existe
 * para o que sera guardado, nao para o que aparece na tela.
 */
export const LIMITE_BYTES = 64 * 1024;

export const LIMITE_DESCRICAO = 200;
export const LIMITE_ITEM_TEXTO = 300;
export const LIMITE_ITENS_LISTA = 50;

/** As marcas de cerca. Uma por contrato — um arquivo nunca e os dois. */
export const MARCA_SKILL = "cds-skill";
export const MARCA_FICHA = "cds-ficha";

const RE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** SemVer simples: sem pre-release e sem build na v1. */
const RE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;
/** Id de funcao no formato ja vigente: `vendas.consultar`. */
const RE_FUNCAO = /^[a-z0-9]+(?:\.[a-z0-9_]+)+$/;

// ─── Resultado ────────────────────────────────────────────────────────

export const MOTIVOS_RECUSA = [
  "tamanho_excedido",
  "manifesto_ausente",
  "manifesto_duplicado",
  "json_invalido",
  "formato_desconhecido",
  "campo_invalido",
  "campo_proibido",
  "segredo_detectado",
] as const;
export type MotivoRecusa = (typeof MOTIVOS_RECUSA)[number];

/**
 * `detalhe` e texto NOSSO, curto e sem valor bruto.
 *
 * Para `segredo_detectado` ele nomeia o TIPO do achado e onde — jamais o
 * valor. Um relatorio de importacao que ecoa a chave encontrada acaba em
 * log, em print de suporte e em ticket.
 */
export interface Recusa {
  motivo: MotivoRecusa;
  detalhe: string;
}

/**
 * `aceito` e `null` sempre que houver qualquer recusa.
 *
 * ── Duas classes de chave inesperada, e a diferenca e de natureza ───
 *
 * `descartados` sao chaves DESCONHECIDAS e inocentes: nao foram
 * copiadas, nao chegam a lugar nenhum, e a importacao segue. Mas elas
 * sao REPORTADAS, porque o risco real nao e a chave estranha e sim
 * `funcoes_necessarias` digitado errado virando "nenhum requisito" em
 * silencio.
 *
 * Chave PROIBIDA e outra coisa: `nivel`, `autonomia`, `token`,
 * `user_id` e as demais da lista fechada abaixo representam autoridade,
 * execucao, identidade ou segredo. Descartar em silencio aceitaria um
 * arquivo cuja INTENCAO era conceder — e aceitar o resto dele seria
 * dizer "ignorei a parte em que voce tentou se autorizar". Isso RECUSA,
 * com `aceito: null`.
 */
export interface ResultadoImportacao<T> {
  aceito: T | null;
  recusas: readonly Recusa[];
  descartados: readonly string[];
}

// ─── Varredura de segredo ─────────────────────────────────────────────

/**
 * Procura VALOR de segredo, nunca a PALAVRA.
 *
 * Uma Ficha de Integracao precisa poder escrever "a Shopee exige
 * access_token renovado a cada 4 horas" — essa frase e o proposito do
 * documento. Recusar por conter o termo tornaria Ficha impossivel de
 * escrever, e a sonda estaria acusando o assunto em vez do achado.
 *
 * Entao o que dispara e a ATRIBUICAO de um valor opaco, ou uma forma
 * autoevidente de credencial (JWT, chave de provedor, bloco PEM).
 */
const PADROES_SEGREDO: readonly { tipo: string; re: RegExp }[] = [
  {
    tipo: "atribuicao de credencial",
    // `token` e `secret` isolados entram na lista: eles ja sao chaves
    // PROIBIDAS no manifesto, e seria incoerente recusar `token` como
    // campo e aceitar `token: <valor opaco>` na prosa. O risco de falso
    // positivo e baixo porque o gatilho e o VALOR: `token: obtido via
    // OAuth` nao casa (a corrida para no espaco), e `token: https://...`
    // tambem nao (o `:` da URL nao esta na classe de caracteres).
    re: /\b(?:access_token|refresh_token|partner_key|client_secret|api[_-]?key|token|secret|senha|password)\b\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{12,}/i,
  },
  { tipo: "token JWT", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./ },
  { tipo: "chave de provedor", re: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { tipo: "chave privada", re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  { tipo: "cabecalho Authorization", re: /\bBearer\s+[A-Za-z0-9_\-.]{16,}/i },
];

/** Tipos encontrados, sem nenhuma amostra do valor. */
export function acharSegredos(texto: string): readonly string[] {
  return PADROES_SEGREDO.filter((p) => p.re.test(texto)).map((p) => p.tipo);
}

// ─── Extracao do manifesto ────────────────────────────────────────────

export interface BlocoExtraido {
  json: string;
  corpo: string;
}

/**
 * Acha a cerca ```<marca> ... ``` e separa manifesto de corpo.
 *
 * Duas cercas da mesma marca -> RECUSA, nunca "usa a primeira". Escolher
 * em silencio entre dois manifestos e decidir pelo autor qual dos dois
 * vale, e nenhuma das duas escolhas seria defensavel depois.
 *
 * O corpo e tudo o que vem DEPOIS da cerca. Texto antes dela e
 * descartado sem drama: e onde editores costumam deixar titulo ou nota.
 */
export function extrairBloco(texto: string, marca: string): BlocoExtraido | MotivoRecusa {
  const abertura = new RegExp("^[ \\t]*```" + marca + "[ \\t]*$", "gm");
  const inicios: number[] = [];
  for (let m = abertura.exec(texto); m !== null; m = abertura.exec(texto)) {
    inicios.push(m.index + m[0].length);
  }
  if (inicios.length === 0) return "manifesto_ausente";
  if (inicios.length > 1) return "manifesto_duplicado";

  const fechamento = /^[ \t]*```[ \t]*$/gm;
  fechamento.lastIndex = inicios[0];
  const fim = fechamento.exec(texto);
  if (fim === null) return "manifesto_ausente";

  return {
    json: texto.slice(inicios[0], fim.index),
    corpo: texto.slice(fim.index + fim[0].length).trim(),
  };
}

// ─── Validadores de campo ─────────────────────────────────────────────
//
// Cada um devolve o valor ja normalizado ou `null`. Quem chama acumula a
// recusa — TODOS os campos invalidos sao reportados de uma vez, nunca so
// o primeiro. Precedente literal de `elegibilidade()`: corrigir um erro
// para descobrir o proximo e a pior forma de dar retorno.

function textoSimples(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t || t.length > max || t.includes("\n")) return null;
  return t;
}

function slug(v: unknown): string | null {
  return typeof v === "string" && RE_SLUG.test(v) ? v : null;
}

function listaDeTextos(v: unknown, max: number): string[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > LIMITE_ITENS_LISTA) return null;
  const out: string[] = [];
  for (const item of v) {
    const t = textoSimples(item, max);
    if (t === null) return null;
    out.push(t);
  }
  return out;
}

function listaDeIds(v: unknown, re: RegExp): string[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > LIMITE_ITENS_LISTA) return null;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string" || !re.test(item)) return null;
    out.push(item);
  }
  return out;
}

function objetoSimples(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * `fontes` com zero itens e INVALIDO — nao e "sem fontes".
 *
 * Sem verificacao, a chave inteira fica ausente. Uma lista vazia
 * afirmaria "eu fui verificada" e entregaria nada; e o unico dos tres
 * estados que engana.
 */
function verificacao(v: unknown): Verificacao | null {
  const o = objetoSimples(v);
  if (o === null) return null;
  if (typeof o.em !== "string" || !RE_DATA.test(o.em) || Number.isNaN(Date.parse(o.em))) return null;
  if (!Array.isArray(o.fontes) || o.fontes.length === 0) return null;
  const fontes: string[] = [];
  for (const f of o.fontes) {
    // Somente `https:`. E a URL NAO e buscada aqui, nem em fase nenhuma
    // desta importacao: guardar uma referencia e uma coisa, ir ate ela
    // com um arquivo de origem desconhecida e outra bem diferente.
    if (typeof f !== "string" || !f.startsWith("https://") || f.length > LIMITE_ITEM_TEXTO) {
      return null;
    }
    fontes.push(f);
  }
  return { em: o.em, fontes };
}

function requisitoConexao(v: unknown): RequisitoConexao | null {
  const o = objetoSimples(v);
  if (o === null) return null;
  // `plataforma` NAO usa `slug`: o slug rejeita underscore, e
  // `mercado_livre` e grafia canonica do dominio. A autoridade e
  // `ehPlataformaConexao` — mais estrita que o slug, nao mais frouxa:
  // `amazon` e `mercado-livre` passariam no slug e sao recusados aqui.
  // `recurso` continua no slug: ele e chave OPACA, sem vocabulario.
  const plataforma = ehPlataformaConexao(o.plataforma) ? o.plataforma : null;
  const recurso = slug(o.recurso);
  if (plataforma === null || recurso === null || typeof o.obrigatoria !== "boolean") return null;
  return { plataforma, recurso, obrigatoria: o.obrigatoria };
}

// ─── Copia campo a campo ──────────────────────────────────────────────
//
// Chaves conhecidas, copiadas uma a uma. NUNCA spread: `{...bruto}`
// deixaria qualquer chave do arquivo importado entrar no objeto, e a
// lista de ausencias estruturais do contrato viraria decoracao. Mesmo
// padrao de `criarAgente` em `lib/agentes/capability.ts`.

const CHAVES_SKILL = [
  "formato", "id", "nome", "versao", "descricao",
  "quando_usar", "requer", "fichas", "origem", "verificacao",
] as const;

const CHAVES_FICHA = [
  "formato", "id", "plataforma", "recurso", "versao",
  "verificacao", "requisitos_declarados",
] as const;

const CHAVES_REQUER = ["funcoes", "funcoes_opcionais", "conexoes"] as const;

/**
 * As chaves que RECUSAM o arquivo inteiro.
 *
 * Lista FECHADA, comparada por nome normalizado — nunca por "contem".
 * Heuristica de substring reprovaria `tokens_estimados`, que e inocente,
 * e o projeto ja pagou caro por sonda que acusa o assunto em vez do
 * achado. Cada entrada aqui corresponde a uma ausencia estrutural
 * declarada em `contrato.ts`.
 */
const CHAVES_PROIBIDAS: readonly string[] = [
  "permissao", "permissoes", "autonomia", "nivel",
  "credencial", "credenciais", "token", "accesstoken", "refreshtoken",
  "apikey", "partnerkey", "clientsecret", "senha",
  "handler", "script", "codigo",
  "userid", "agenteid",
];

/** `user_id`, `userId` e `USER_ID` sao a mesma tentativa. */
function normalizar(chave: string): string {
  return chave.toLowerCase().replace(/[_-]/g, "");
}

/**
 * Separa o inesperado em inocente (descarta) e proibido (recusa).
 *
 * Roda tambem nos objetos aninhados: `requer.nivel` e exatamente a mesma
 * tentativa que `nivel` na raiz, e um proibido escondido um nivel abaixo
 * nao pode passar por estar fora da lista de chaves conhecidas do topo.
 */
function classificarChaves(
  o: Record<string, unknown>,
  conhecidas: readonly string[],
  prefixo: string,
  recusas: Recusa[],
  descartados: string[]
): void {
  for (const k of Object.keys(o)) {
    if (conhecidas.includes(k)) continue;
    if (CHAVES_PROIBIDAS.includes(normalizar(k))) {
      recusas.push({
        motivo: "campo_proibido",
        detalhe: `${prefixo}${k} — autoridade, execucao, identidade ou segredo nao pertencem a uma Skill`,
      });
    } else {
      descartados.push(prefixo + k);
    }
  }
}

function requisitos(v: unknown, recusas: Recusa[], descartados: string[]): RequisitosSkill | null {
  const o = objetoSimples(v);
  if (o === null) {
    recusas.push({ motivo: "campo_invalido", detalhe: "requer deve ser um objeto" });
    return null;
  }
  classificarChaves(o, CHAVES_REQUER, "requer.", recusas, descartados);

  const out: {
    funcoes?: string[];
    funcoes_opcionais?: string[];
    conexoes?: RequisitoConexao[];
  } = {};

  for (const chave of ["funcoes", "funcoes_opcionais"] as const) {
    if (o[chave] === undefined) continue;
    const ids = listaDeIds(o[chave], RE_FUNCAO);
    if (ids === null) {
      recusas.push({ motivo: "campo_invalido", detalhe: `requer.${chave} invalido` });
    } else {
      out[chave] = ids;
    }
  }

  if (o.conexoes !== undefined) {
    if (!Array.isArray(o.conexoes) || o.conexoes.length === 0) {
      recusas.push({ motivo: "campo_invalido", detalhe: "requer.conexoes invalido" });
    } else {
      const lista: RequisitoConexao[] = [];
      for (const c of o.conexoes) {
        const r = requisitoConexao(c);
        if (r === null) {
          recusas.push({ motivo: "campo_invalido", detalhe: "requer.conexoes tem item invalido" });
          break;
        }
        lista.push(r);
      }
      if (lista.length === o.conexoes.length) out.conexoes = lista;
    }
  }

  return out;
}

function manifestoSkill(
  bruto: Record<string, unknown>,
  recusas: Recusa[],
  descartados: string[]
): ManifestoSkill | null {
  classificarChaves(bruto, CHAVES_SKILL, "", recusas, descartados);

  const id = slug(bruto.id);
  const nome = textoSimples(bruto.nome, LIMITE_ITEM_TEXTO);
  const versao = typeof bruto.versao === "string" && RE_SEMVER.test(bruto.versao) ? bruto.versao : null;
  const descricao = textoSimples(bruto.descricao, LIMITE_DESCRICAO);
  const quando = listaDeTextos(bruto.quando_usar, LIMITE_ITEM_TEXTO);

  if (id === null) recusas.push({ motivo: "campo_invalido", detalhe: "id deve ser um slug" });
  if (nome === null) recusas.push({ motivo: "campo_invalido", detalhe: "nome invalido" });
  if (versao === null) recusas.push({ motivo: "campo_invalido", detalhe: "versao deve ser SemVer" });
  if (descricao === null) recusas.push({ motivo: "campo_invalido", detalhe: "descricao invalida" });
  if (quando === null) recusas.push({ motivo: "campo_invalido", detalhe: "quando_usar invalido" });
  if (!ehOrigemSkill(bruto.origem)) recusas.push({ motivo: "campo_invalido", detalhe: "origem invalida" });

  const requer = bruto.requer === undefined ? undefined : requisitos(bruto.requer, recusas, descartados);

  let fichas: string[] | undefined;
  if (bruto.fichas !== undefined) {
    const lista = listaDeIds(bruto.fichas, RE_SLUG);
    if (lista === null) recusas.push({ motivo: "campo_invalido", detalhe: "fichas invalido" });
    else fichas = lista;
  }

  let verif: Verificacao | undefined;
  if (bruto.verificacao !== undefined) {
    const v = verificacao(bruto.verificacao);
    if (v === null) recusas.push({ motivo: "campo_invalido", detalhe: "verificacao invalida" });
    else verif = v;
  }

  if (recusas.length > 0) return null;

  const m: ManifestoSkill = {
    formato: FORMATO_SUPORTADO,
    id: id as string,
    nome: nome as string,
    versao: versao as string,
    descricao: descricao as string,
    quando_usar: quando as string[],
    origem: bruto.origem as ManifestoSkill["origem"],
  };
  if (requer !== undefined && requer !== null) (m as { requer?: RequisitosSkill }).requer = requer;
  if (fichas !== undefined) (m as { fichas?: readonly string[] }).fichas = fichas;
  if (verif !== undefined) (m as { verificacao?: Verificacao }).verificacao = verif;
  return m;
}

function manifestoFicha(
  bruto: Record<string, unknown>,
  recusas: Recusa[],
  descartados: string[]
): ManifestoFicha | null {
  classificarChaves(bruto, CHAVES_FICHA, "", recusas, descartados);

  const id = slug(bruto.id);
  // Mesma autoridade do requisito: `avaliarConfiguracoes` cruza os dois
  // pares `(plataforma, recurso)` por igualdade literal, entao uma Ficha
  // com grafia que o requisito nao aceita nunca casaria com nada.
  // `id` e `recurso` seguem no slug — `id` e identificador tecnico
  // (`shopee-chat`), nao o nome da plataforma.
  const plataforma = ehPlataformaConexao(bruto.plataforma) ? bruto.plataforma : null;
  const recurso = slug(bruto.recurso);
  const versao = typeof bruto.versao === "string" && RE_SEMVER.test(bruto.versao) ? bruto.versao : null;
  const verif = verificacao(bruto.verificacao);

  if (id === null) recusas.push({ motivo: "campo_invalido", detalhe: "id deve ser um slug" });
  if (plataforma === null) recusas.push({ motivo: "campo_invalido", detalhe: "plataforma invalida" });
  if (recurso === null) recusas.push({ motivo: "campo_invalido", detalhe: "recurso invalido" });
  if (versao === null) recusas.push({ motivo: "campo_invalido", detalhe: "versao deve ser SemVer" });
  // Obrigatoria aqui, ao contrario da Skill: a Ficha e a autoridade
  // documental, e uma sem procedencia nao tem como ser avaliada depois.
  if (verif === null) recusas.push({ motivo: "campo_invalido", detalhe: "verificacao obrigatoria" });

  // Array VAZIO e aceito: "nada de especial exigido" e uma afirmacao
  // util. A chave, porem, precisa existir — omitir seria silencio.
  let reqs: string[] | null = null;
  if (!Array.isArray(bruto.requisitos_declarados)) {
    recusas.push({ motivo: "campo_invalido", detalhe: "requisitos_declarados ausente" });
  } else if (bruto.requisitos_declarados.length === 0) {
    reqs = [];
  } else {
    reqs = listaDeTextos(bruto.requisitos_declarados, LIMITE_ITEM_TEXTO);
    if (reqs === null) recusas.push({ motivo: "campo_invalido", detalhe: "requisitos_declarados invalido" });
  }

  if (recusas.length > 0 || reqs === null) return null;

  return {
    formato: FORMATO_SUPORTADO,
    id: id as string,
    plataforma: plataforma as string,
    recurso: recurso as string,
    versao: versao as string,
    verificacao: verif as Verificacao,
    requisitos_declarados: reqs,
  };
}

// ─── O pipeline ───────────────────────────────────────────────────────

function importar<M>(
  texto: string,
  marca: string,
  validar: (b: Record<string, unknown>, r: Recusa[], d: string[]) => M | null
): ResultadoImportacao<{ manifesto: M; corpo: string }> {
  const recusas: Recusa[] = [];
  const descartados: string[] = [];
  const parar = (motivo: MotivoRecusa, detalhe: string) => ({
    aceito: null,
    recusas: [{ motivo, detalhe }],
    descartados,
  });

  if (typeof texto !== "string") return parar("json_invalido", "entrada nao e texto");

  const bytes = new TextEncoder().encode(texto).length;
  if (bytes > LIMITE_BYTES) {
    return parar("tamanho_excedido", `${bytes} bytes acima do limite de ${LIMITE_BYTES}`);
  }

  const bloco = extrairBloco(texto, marca);
  if (typeof bloco === "string") return parar(bloco, `bloco \`\`\`${marca}\`\`\``);

  let bruto: unknown;
  try {
    bruto = JSON.parse(bloco.json);
  } catch {
    return parar("json_invalido", "manifesto nao e JSON valido");
  }

  const objeto = objetoSimples(bruto);
  if (objeto === null) return parar("json_invalido", "manifesto deve ser um objeto");

  // Formato antes de qualquer campo: um manifesto de outra versao nao
  // deve nem ser avaliado pelas regras desta. Recusa, nunca adaptacao.
  if (objeto.formato !== FORMATO_SUPORTADO) {
    return parar("formato_desconhecido", `formato ${String(objeto.formato)} nao suportado`);
  }

  const manifesto = validar(objeto, recusas, descartados);

  // Varredura no ARQUIVO INTEIRO — manifesto e corpo. Um segredo colado
  // na prosa e tao segredo quanto um colado num campo.
  const achados = acharSegredos(texto);
  for (const tipo of achados) recusas.push({ motivo: "segredo_detectado", detalhe: tipo });

  if (manifesto === null || recusas.length > 0) return { aceito: null, recusas, descartados };
  return { aceito: { manifesto, corpo: bloco.corpo }, recusas, descartados };
}

export function importarSkill(texto: string): ResultadoImportacao<Skill> {
  return importar(texto, MARCA_SKILL, manifestoSkill);
}

export function importarFicha(texto: string): ResultadoImportacao<Ficha> {
  return importar(texto, MARCA_FICHA, manifestoFicha);
}
