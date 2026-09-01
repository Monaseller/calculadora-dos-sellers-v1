/**
 * A identidade canonica de uma acao aprovavel — APPROVAL-B1B.
 *
 * ── A pergunta que este modulo responde ─────────────────────────────
 *
 *   "Estas duas tentativas sao a MESMA acao concreta?"
 *
 * Duas respostas dependem disso. A primeira e o dedupe: nao pode haver
 * duas aprovacoes ativas para a mesma acao, senao o dono aprova uma e a
 * outra fica pendente afirmando a mesma coisa. A segunda e o registro:
 * `argumentos_hash` congela o que o humano leu, para que ninguem possa
 * alegar depois que aprovou outra coisa.
 *
 * ── Modulo puro, de proposito ───────────────────────────────────────
 *
 * Sem I/O, sem Supabase, sem rede, sem env, sem `server-only`. Ele nao
 * decide nada sobre autorizacao — so calcula identidade. A unica
 * dependencia e `node:crypto`, ja usada em cinco modulos deste repo.
 *
 * ── Por que a canonicalizacao e propria, e nao `JSON.stringify` ─────
 *
 * `JSON.stringify` preserva a ordem de INSERCAO das chaves. Para um
 * objeto literal escrito a mao isso e determinismo suficiente — e o que
 * `estudio-anuncios/compliance` faz. Aqui os argumentos vem de fora,
 * como `unknown`, e a ordem das chaves nao e controlada: `{a:1,b:2}` e
 * `{b:2,a:1}` sao a MESMA acao e precisam do mesmo hash.
 */
import { createHash } from "node:crypto";

/** Um valor que o JSON representa sem perda. Tudo fora disto e recusado. */
export type ValorJson =
  | null
  | boolean
  | number
  | string
  | readonly ValorJson[]
  | { readonly [chave: string]: ValorJson };

/**
 * O que a canonicalizacao recusa, e por que ela RECUSA em vez de
 * normalizar.
 *
 * `undefined`, `NaN`, `Infinity`, `Date`, `Map`, `Set`, `BigInt`,
 * funcao, `Symbol` e ciclo nao tem representacao JSON estavel. Convertir
 * qualquer um deles em algo "parecido" produziria um hash que descreve
 * um valor que ninguem escreveu — e o hash existe justamente para
 * afirmar o que foi aprovado. Fail-closed: quem tenta aprovar um
 * argumento assim recebe erro, nunca um congelamento aproximado.
 */
export class ErroArgumentoNaoCanonico extends Error {
  readonly caminho: string;

  constructor(caminho: string, motivo: string) {
    super(`argumento nao canonico em ${caminho}: ${motivo}`);
    this.name = "ErroArgumentoNaoCanonico";
    this.caminho = caminho;
  }
}

/**
 * Serializa em forma canonica determinista.
 *
 * ── Ordenacao ───────────────────────────────────────────────────────
 *
 * Chaves de objeto sao ordenadas por `sort()` padrao — ordem de code
 * unit UTF-16. NAO `localeCompare`: ele depende de ICU e do locale do
 * processo, e um fingerprint de deduplicacao e de seguranca nao pode
 * mudar porque o servidor subiu com outra configuracao regional.
 *
 * A ordem de ARRAY e preservada: `[1,2]` e `[2,1]` sao acoes
 * diferentes, e reordenar apagaria essa diferenca.
 *
 * ── Ciclo ───────────────────────────────────────────────────────────
 *
 * Detectado por pilha de ancestrais, nao por `WeakSet` global: o mesmo
 * objeto pode aparecer duas vezes em ramos irmaos sem que haja ciclo, e
 * recusar isso seria recusar um argumento valido.
 */
export function canonicalizar(valor: unknown): string {
  return escrever(valor, "$", []);
}

function escrever(valor: unknown, caminho: string, ancestrais: readonly object[]): string {
  if (valor === null) return "null";

  const tipo = typeof valor;

  if (tipo === "boolean") return valor ? "true" : "false";

  if (tipo === "string") return JSON.stringify(valor);

  if (tipo === "number") {
    if (!Number.isFinite(valor)) {
      throw new ErroArgumentoNaoCanonico(caminho, "numero nao finito (NaN ou Infinity)");
    }
    // `JSON.stringify` de um numero finito e a forma canonica do proprio
    // ECMAScript: `1.0` vira `1`, `1e2` vira `100`. Deterministica.
    return JSON.stringify(valor);
  }

  if (tipo === "undefined") throw new ErroArgumentoNaoCanonico(caminho, "undefined");
  if (tipo === "bigint") throw new ErroArgumentoNaoCanonico(caminho, "bigint");
  if (tipo === "function") throw new ErroArgumentoNaoCanonico(caminho, "function");
  if (tipo === "symbol") throw new ErroArgumentoNaoCanonico(caminho, "symbol");

  // A partir daqui e objeto.
  const objeto = valor as object;

  if (ancestrais.includes(objeto)) throw new ErroArgumentoNaoCanonico(caminho, "referencia ciclica");
  const abaixo = [...ancestrais, objeto];

  if (Array.isArray(objeto)) {
    return `[${objeto.map((item, i) => escrever(item, `${caminho}[${i}]`, abaixo)).join(",")}]`;
  }

  // `Date`, `Map`, `Set`, `RegExp` e instancias de classe caem aqui: o
  // prototipo denuncia. Aceitar um `Date` significaria escolher um
  // formato de data em nome de quem aprovou.
  const proto = Object.getPrototypeOf(objeto);
  if (proto !== Object.prototype && proto !== null) {
    throw new ErroArgumentoNaoCanonico(caminho, `objeto nao simples (${objeto.constructor?.name ?? "sem prototipo"})`);
  }

  const bruto = objeto as Record<string, unknown>;

  // Chave de Symbol nao aparece em `Object.keys` e desapareceria do
  // hash sem ninguem perceber — o argumento persistido seria diferente
  // do argumento medido. Recusar e a unica leitura honesta.
  if (Object.getOwnPropertySymbols(bruto).length > 0) {
    throw new ErroArgumentoNaoCanonico(caminho, "chave de symbol");
  }

  // ── Por que descriptor, e nao `bruto[chave]` ──────────────────────
  //
  // Acesso por indice EXECUTA getter. Um objeto com accessor tem
  // prototipo `Object.prototype` e passaria pela checagem acima, e o
  // getter rodaria duas vezes: aqui e de novo quando `argumentos` for
  // serializado para o banco. Getter que devolve valores diferentes faz
  // `argumentos_hash` deixar de descrever o valor persistido — que e a
  // unica coisa que esse campo existe para afirmar.
  //
  // Nao ha distincao entre getter deterministico e nao deterministico:
  // property de acesso nao pertence ao contrato de JSON puro deste
  // modulo, e adivinhar qual e seguro seria inventar regra. Setter sem
  // getter tambem e recusado — nao vira `undefined` por interpretacao
  // nossa.
  const chaves = Object.keys(bruto).sort();
  const partes = chaves.map((chave) => {
    const descritor = Object.getOwnPropertyDescriptor(bruto, chave);
    if (descritor === undefined) {
      throw new ErroArgumentoNaoCanonico(`${caminho}.${chave}`, "propriedade sem descritor");
    }
    if (descritor.get !== undefined || descritor.set !== undefined) {
      throw new ErroArgumentoNaoCanonico(`${caminho}.${chave}`, "propriedade de acesso (getter/setter)");
    }
    return `${JSON.stringify(chave)}:${escrever(descritor.value, `${caminho}.${chave}`, abaixo)}`;
  });
  return `{${partes.join(",")}}`;
}

const sha256 = (texto: string): string => createHash("sha256").update(texto, "utf8").digest("hex");

/**
 * O hash dos ARGUMENTOS — calculado uma vez, na criacao, e persistido.
 *
 * ── Por que nunca re-derivar do banco ───────────────────────────────
 *
 * O `jsonb` do Postgres guarda numero como `numeric` e pode normalizar a
 * representacao (`1e2` chega como `100`). Recalcular o hash a partir do
 * valor lido de volta compararia duas representacoes do mesmo numero e
 * acusaria divergencia onde nao ha. O hash e calculado sobre a forma
 * canonica em TypeScript, gravado junto, e daí em diante e um fato.
 */
export function hashDeArgumentos(argumentos: unknown): string {
  return sha256(canonicalizar(argumentos));
}

/**
 * O que identifica a ACAO, para dedupe de aprovacao ativa.
 *
 * ── O que entra, e o que deliberadamente NAO entra ──────────────────
 *
 * `revisao_funcao` cobre tudo que e propriedade da DEFINICAO — o
 * `acesso`, o requisito de conexao e a semantica —, porque mudar
 * qualquer um deles exige bump de revisao pela regra publicada em
 * `DefinicaoFuncao.revisao`. Repetir esses campos aqui duplicaria
 * metadata sem acrescentar discriminacao.
 *
 * `lojaId` NAO e propriedade da definicao: e o alvo vivo, e pode trocar
 * sem que nada na Funcao mude. Aprovar para a loja A e executar contra a
 * loja B seriam acoes diferentes sob a mesma autorizacao, entao ele
 * entra — e duas aprovacoes para lojas distintas nao deduplicam.
 *
 * `requestIdSolicitacao` NAO entra: duas tentativas distintas pedindo a
 * mesma acao concreta DEVEM cair na mesma aprovacao ativa, que e o
 * proposito do dedupe.
 */
export interface AcaoAprovavel {
  userId: string;
  agenteId: string;
  tarefaId: string | null;
  funcaoId: string;
  revisaoFuncao: string;
  conexaoLojaId: string | null;
  argumentosHash: string;
}

export function impressaoDaAcao(acao: AcaoAprovavel): string {
  // Objeto literal com ordem fixa, escrito a mao: aqui a ordem de
  // insercao E controlada, entao a canonicalizacao so precisa cuidar do
  // que veio de fora — e o que veio de fora ja virou `argumentosHash`.
  return sha256(
    canonicalizar({
      user_id: acao.userId,
      agente_id: acao.agenteId,
      tarefa_id: acao.tarefaId,
      funcao_id: acao.funcaoId,
      revisao_funcao: acao.revisaoFuncao,
      conexao_loja_id: acao.conexaoLojaId,
      argumentos_hash: acao.argumentosHash,
    })
  );
}
