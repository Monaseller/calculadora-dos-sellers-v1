/**
 * Suite do handler `analise_vendas` — AGENTES-FASE1D-c.
 *
 * SEM banco, SEM rede, SEM env, SEM IA, SEM service_role.
 *
 * ── Uma ausencia PROPOSITAL no topo deste arquivo ───────────────────
 * As outras suites comecam com `import "./_server-only-inerte"` e
 * `import "./_env-inerte"` porque carregam modulos que tocam
 * `server-only` e variaveis de ambiente.
 *
 * Esta NAO importa nenhum dos dois. A omissao e uma barreira real — mas
 * com um limite MEDIDO, e nao a barreira universal que seria comodo
 * afirmar:
 *
 *  - import de valor USADO de `dados/vendas.ts` (ou de qualquer modulo
 *    com `server-only` no grafo): a suite NAO CARREGA. O pacote
 *    `server-only` resolve para `./index.js` fora da condicao
 *    `react-server`, que o `tsx` nao ativa, e lanca na primeira linha.
 *    Medido pela mutacao M3b.
 *
 *  - import de valor NAO USADO: o esbuild do `tsx` aplica elisao de
 *    import do TypeScript e apaga a declaracao inteira. `server-only`
 *    nem chega a executar, e a suite carrega normalmente. Medido pela
 *    mutacao M3.
 *
 * Por isso as duas provas convivem: a BARREIRA pega o uso real, e a
 * VARREDURA (A13/A16) pega a declaracao mesmo quando ela e apagada
 * antes de rodar. Colocar os shims aqui desligaria a primeira das duas.
 *
 * ── Cinco instrumentos ──────────────────────────────────────────────
 *  1. CAPABILITY FAKE injetada, que registra cada chamada e cada
 *     argumento — a closure e exercitada de verdade, nao inspecionada.
 *  2. HANDLER REAL executado ponta a ponta sobre linhas em memoria.
 *  3. FUNCAO PURA `agregarVendas` executada com casos construidos.
 *  4. INSPECAO DE FONTE, sempre com prova de que o alvo existe antes de
 *     afirmar que algo esta ausente.
 *  5. GIT como oraculo de "arquivo preexistente intocado", com controle
 *     negativo provando que o oraculo enxerga mudanca.
 *
 * ── Guarda de rede ──────────────────────────────────────────────────
 * `globalThis.fetch` e substituido por uma armadilha que conta chamadas
 * e lanca. No fim, o contador tem de ser zero.
 */
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";

import {
  criarHandlerAnaliseVendas,
  validarEntradaAnaliseVendas,
  agregarVendas,
  TIPO_ANALISE_VENDAS,
  LIMITE_SKUS_PADRAO,
  LIMITE_SKUS_MAXIMO,
} from "../lib/agentes/handlers/analise-vendas";
import { ErroEntradaTarefa } from "../lib/agentes/erros";
// AGENTES-FASE1D-d: o import EM RUNTIME de `handlers/registry` saiu daqui,
// e a remocao e parte da prova.
//
// Com o wiring da 1D-d o registry passou a ser a composition root e
// importa `dados/vendas.ts` como VALOR — que carrega `server-only`.
// Medido: importar o registry aqui derruba esta suite INTEIRA no load
// (`server-only/index.js:1` lanca, via `dados/vendas.ts:34`), antes do
// primeiro assert.
//
// A saida NAO foi adicionar `_server-only-inerte`: o shim desligaria a
// barreira que o G13 protege e que a mutacao M3b da 1D-c provou existir.
// A saida foi trocar tres asserts de conveniencia — que liam o registry
// em runtime so para contar tipos — por inspecao de FONTE. O que esta
// suite existe para provar e a pureza do HANDLER, e essa prova depende
// justamente de ela conseguir rodar sem carregar arvore server-only.
import type { ContextoTarefa } from "../lib/agentes/tipos-execucao";
import type { FiltroVendas, LinhaVenda, ResultadoVendas } from "../lib/agentes/dados/vendas";

// ── Armadilha de rede ─────────────────────────────────────────────────
let chamadasDeRede = 0;
(globalThis as unknown as { fetch: unknown }).fetch = (...args: unknown[]) => {
  chamadasDeRede++;
  throw new Error(`suite pura: fetch proibido (${String(args[0]).slice(0, 60)})`);
};

const RAIZ = join(__dirname, "..");
const fonte = (rel: string) => readFileSync(join(RAIZ, rel), "utf8");
/** Fonte sem comentarios: assert de ausencia nao pode ser satisfeito nem
 *  derrubado por prosa. Custou falsos positivos em fases anteriores. */
const codigo = (rel: string) =>
  fonte(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

let passou = 0;
let falhou = 0;
function ok(nome: string, condicao: boolean) {
  if (condicao) passou++;
  else {
    falhou++;
    console.error(`  x ${nome}`);
  }
}

const ARQ_HANDLER = "lib/agentes/handlers/analise-vendas.ts";
const src = codigo(ARQ_HANDLER);
const bruta = fonte(ARQ_HANDLER);

// ── Capability fake ───────────────────────────────────────────────────

interface Espiao {
  ler: (filtro: FiltroVendas) => Promise<ResultadoVendas>;
  chamadas: FiltroVendas[];
  aridade: number;
}

/** Ou responde, ou lanca. Duas formas distintas em vez de um
 *  `() => never`: aquele nao estreita o tipo depois do `typeof`, e a
 *  suite tem de compilar limpa como qualquer codigo do repositorio. */
type RespostaFake = ResultadoVendas | { lanca: Error };

function capabilityFake(resposta: RespostaFake): Espiao {
  const chamadas: FiltroVendas[] = [];
  const ler = async (filtro: FiltroVendas): Promise<ResultadoVendas> => {
    chamadas.push(filtro);
    if ("lanca" in resposta) throw resposta.lanca;
    // Copia defensiva: o handler nao pode receber a MESMA referencia duas
    // vezes, senao "determinismo" passaria por compartilhamento de objeto.
    return { ...resposta, linhas: resposta.linhas.map((l) => ({ ...l })) };
  };
  return { ler, chamadas, aridade: ler.length };
}

function vendas(linhas: LinhaVenda[], truncado = false, erro: string | null = null): ResultadoVendas {
  return { linhas, truncado, erro };
}

function linha(p: Partial<LinhaVenda>): LinhaVenda {
  return {
    order_id: "P1",
    sku: "S1",
    anuncio: "Anuncio 1",
    marketplace: "Shopee",
    qtd: 1,
    item_subtotal: 10,
    faturamento: 10,
    data_pagamento: "2026-07-01",
    ...p,
  };
}

const USER_ID_SENTINELA = "dono-sentinela-9f2b";

function contexto(entrada: Record<string, unknown>): ContextoTarefa {
  return {
    tarefaId: "tarefa-1",
    agenteId: "agente-1",
    userId: USER_ID_SENTINELA,
    tipo: TIPO_ANALISE_VENDAS,
    entrada,
    tentativa: 1,
    maxTentativas: 3,
  };
}

const ENTRADA_OK = { dataInicio: "2026-07-01", dataFim: "2026-07-14" };

function coletorDeProgresso() {
  const valores: number[] = [];
  return { relatar: (p: number) => valores.push(p), valores };
}

async function lancou(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}

/** Caminhos cujo valor NAO sobrevive a um `JSON.stringify` honesto:
 *  Map/Set viram `{}`, Date vira string, function e undefined somem. */
function tiposExoticos(valor: unknown, caminho = "$", achados: string[] = []): string[] {
  if (valor === null) return achados;
  if (Array.isArray(valor)) {
    valor.forEach((v, i) => tiposExoticos(v, `${caminho}[${i}]`, achados));
    return achados;
  }
  const t = typeof valor;
  if (t === "function" || t === "undefined" || t === "symbol" || t === "bigint") {
    achados.push(`${caminho}:${t}`);
    return achados;
  }
  if (t === "number" && !Number.isFinite(valor as number)) {
    achados.push(`${caminho}:nao-finito`);
    return achados;
  }
  if (t === "object") {
    if (valor instanceof Map || valor instanceof Set || valor instanceof Date || valor instanceof RegExp) {
      achados.push(`${caminho}:${(valor as object).constructor.name}`);
      return achados;
    }
    if (Object.getPrototypeOf(valor) !== Object.prototype) {
      achados.push(`${caminho}:prototipo-nao-simples`);
      return achados;
    }
    for (const [k, v] of Object.entries(valor as object)) tiposExoticos(v, `${caminho}.${k}`, achados);
  }
  return achados;
}

// ══ EXTRATORES ESTRUTURAIS ═══════════════════════════════════════════
//
// Os asserts da secao I protegem uma invariante ARQUITETURAL dos
// escritores (`sync-shopee.ts`, `sync-ml.ts`), nao a formatacao deles.
// Por isso ninguem aqui compara trecho grande byte a byte nem depende de
// numero de linha, indentacao, CRLF ou comentario: primeiro DELIMITA o
// bloco por casamento de chaves, depois verifica a RELACAO dentro dele,
// sobre texto com espacos normalizados.

/** Espacos colapsados — imune a quebra de linha, indentacao e CRLF. */
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Devolve o bloco `{...}` que se abre depois da ancora, por contagem de
 * chaves. Interpolacao de template (`${...}`) e balanceada, entao nao
 * desequilibra a contagem. Devolve null se a ancora nao existir — e a
 * secao I trata null como FALHA, nunca como "nada a verificar".
 */
function bloco(texto: string, ancora: RegExp): string | null {
  const m = ancora.exec(texto);
  if (!m) return null;
  const inicio = texto.indexOf("{", m.index);
  if (inicio < 0) return null;
  let nivel = 0;
  for (let i = inicio; i < texto.length; i++) {
    if (texto[i] === "{") nivel++;
    else if (texto[i] === "}" && --nivel === 0) return texto.slice(inicio, i + 1);
  }
  return null;
}

/** Lado direito de uma declaracao, normalizado. */
function ladoDireito(trecho: string, nome: string): string | null {
  const m = new RegExp(`\\b(?:const|let|var)\\s+${nome}\\s*=\\s*([\\s\\S]*?);`).exec(trecho);
  return m ? norm(m[1]) : null;
}

/** Ramo `else` de um ternario ja normalizado. */
function ramoElse(expr: string): string | null {
  const m = /\?(.*):(.*)$/.exec(expr);
  return m ? m[2].trim() : null;
}

/**
 * PREDICADO — Shopee rateia `faturamento` por item?
 *
 * Funcao de TEXTO, nao de arquivo: a suite a aplica ao bloco real e
 * tambem a copias envenenadas em memoria, e essas copias sao o controle
 * negativo. Um predicado que so olha o arquivo verdadeiro nunca prova
 * que sabe dizer "nao".
 */
function shopeeRateiaPorItem(blocoItens: string): boolean {
  const ratio = ladoDireito(blocoItens, "ratioItem");
  const fat = ladoDireito(blocoItens, "faturamento");
  if (!ratio || !fat) return false;
  // o peso do item e itemValue / orderItemsSubtotal
  if (!ratio.replace(/\s/g, "").includes("itemValue/orderItemsSubtotal")) return false;
  // o valor da linha e o total do pedido VEZES esse peso
  if (!fat.replace(/\s/g, "").includes("totalAmount*ratioItem")) return false;
  // e o fallback continua sendo o valor do proprio item
  return ramoElse(fat) === "itemValue";
}

/** PREDICADO — ML calcula `faturamento` a partir do proprio item? */
function mlCalculaPorItem(blocoItens: string): boolean {
  const fat = ladoDireito(blocoItens, "faturamento");
  return fat !== null && fat.replace(/\s/g, "") === "valorUnit*qtd";
}

const ANCORA_SEM_ITENS = /if\s*\(\s*\(\s*order\.item_list\s*\?\?\s*\[\]\s*\)\.length\s*===\s*0\s*\)/;
const ANCORA_LACO_ITENS = /for\s*\(\s*const\s+item\s+of\s*\(\s*order\.item_list/;

/**
 * PREDICADO — a linha `_NOITEM` e a UNICA linha daquele pedido?
 *
 * E o que torna seguro ela carregar o total do pedido em `faturamento`:
 * o bloco sai com `return rows` ANTES do laco de itens, entao nao existe
 * segunda linha do mesmo `order_id` com que somar.
 *
 * O fim do bloco e calculado a partir da CHAVE de abertura, nao do `if` —
 * medir do `if` subestimaria o fim e afrouxaria a comparacao de posicao.
 */
function noitemEhLinhaUnica(fonteShopee: string): boolean {
  const idxIf = fonteShopee.search(ANCORA_SEM_ITENS);
  const idxLaco = fonteShopee.search(ANCORA_LACO_ITENS);
  const b = bloco(fonteShopee, ANCORA_SEM_ITENS);
  if (idxIf < 0 || idxLaco < 0 || !b) return false;
  if (!/_NOITEM/.test(b)) return false;
  if (!/item_subtotal:\s*0\b/.test(b)) return false;
  if (!/\breturn\s+rows\s*;/.test(b)) return false;
  const fimDoBloco = fonteShopee.indexOf("{", idxIf) + b.length;
  return fimDoBloco <= idxLaco;
}

/** Envenena SOMENTE dentro do bloco alvo — poluir o arquivo inteiro
 *  acertaria outra ocorrencia e o controle negativo mediria outra coisa. */
function envenenarBloco(fonte: string, ancora: RegExp, de: RegExp, para: string): string {
  const b = bloco(fonte, ancora);
  return b ? fonte.replace(b, b.replace(de, para)) : fonte;
}

/** Percorre o objeto e devolve todas as chaves e todos os valores string. */
function achatar(valor: unknown, chaves: string[] = [], textos: string[] = []) {
  if (Array.isArray(valor)) {
    for (const v of valor) achatar(v, chaves, textos);
  } else if (valor && typeof valor === "object") {
    for (const [k, v] of Object.entries(valor)) {
      chaves.push(k);
      achatar(v, chaves, textos);
    }
  } else if (typeof valor === "string") {
    textos.push(valor);
  }
  return { chaves, textos };
}

// ── Git como oraculo ──────────────────────────────────────────────────
function gitLimpo(rel: string): boolean {
  const saida = execFileSync("git", ["status", "--porcelain", "--", rel], {
    cwd: RAIZ,
    encoding: "utf8",
  });
  return saida.trim().length === 0;
}

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: RAIZ, encoding: "utf8" });
}

/**
 * Caminhos de `git status --porcelain` v1 — SEM olhar o codigo de status.
 *
 * ── Por que o codigo de status nao entra aqui ───────────────────────
 * Este parser nasceu de um defeito: o assert G11 comparava a linha
 * inteira com `?? <caminho>`. Funcionava enquanto o arquivo estivesse
 * untracked e quebrava no instante do `git add`, quando a mesma linha
 * vira `A  <caminho>`; depois do commit a linha some de vez. Tres
 * estados, um literal — o assert media o VERSIONAMENTO, nao a
 * arquitetura.
 *
 * A propriedade que interessa e "que ARQUIVO aparece", nunca "em que
 * estado ele esta". Entao le-se so o caminho.
 *
 * Formato v1: dois caracteres de status, um espaco, o caminho. Rename e
 * copia trazem `origem -> destino` (vale o destino). Caminho com espaco,
 * acento ou aspas vem entre aspas.
 */
function caminhosDeStatus(saida: string): string[] {
  return saida
    .split("\n")
    .filter((l) => l.length > 3)
    .map((l) => {
      let p = l.slice(3);
      const seta = p.indexOf(" -> ");
      if (seta >= 0) p = p.slice(seta + 4);
      if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
      return p.replace(/\\/g, "/").trim();
    });
}

const ESCOPO_AGENTES = ["lib/agentes", "app/api/internal/agentes", "supabase/migrations"];

/**
 * Arquivos que a AGENTES-FASE1D-d esta autorizada a alterar. Qualquer
 * caminho fora deste conjunto que apareca modificado no escopo dos
 * agentes reprova o G11 — inclusive um quinto arquivo "inofensivo".
 *
 * `ARQ_HANDLER` entra porque ate a 1D-c ele era o unico esperado; hoje
 * ele esta commitado e limpo, entao nem aparece — mas mante-lo aqui faz
 * o predicado valer nos dois momentos.
 */
const ARQUIVOS_1DD: readonly string[] = [
  ARQ_HANDLER,
  "lib/agentes/handlers/registry.ts",
  "lib/agentes/executar-tarefa.ts",
  "scripts/testar-agentes-execucao.ts",
  "scripts/testar-agentes-analise-vendas.ts",
];

/**
 * Os DOIS arquivos que a correcao de performance da 1D-a tocou. Ficam
 * numa lista propria, e nao diluidos na anterior, para que a origem de
 * cada liberacao continue legivel — cada uma tem sua fase e seu motivo.
 */
const ARQUIVOS_1DA_PERF: readonly string[] = [
  "lib/agentes/dados/vendas.ts",
  "scripts/testar-agentes-vendas-capability.ts",
];

/**
 * Os arquivos que a AGENTES-FASE1E-a acrescentou — fundacao neutra de
 * IA. Lista propria, pela mesma razao das duas anteriores: cada
 * liberacao mantem legivel de qual frente ela veio.
 *
 * Aqui os NOMES DE DENTRO de `lib/agentes/ia/` ficam separados dos
 * caminhos completos, porque eles servem a DOIS guardas diferentes — o
 * do Git e o de diretorio. Ver `ARQUIVOS_1EA` e G11l logo abaixo.
 */
const ARQUIVOS_IA_1EA: readonly string[] = [
  "contrato-analise.ts",
  "fake.ts",
  "tipos.ts",
];

/**
 * ── UM BURACO REAL NO ORACULO GIT, E COMO ELE E TAPADO ──────────────
 *
 * `git status --porcelain` COLAPSA diretorio inteiramente untracked numa
 * unica linha. Medido nesta arvore, com um intruso plantado dentro:
 *
 *     ?? lib/agentes/ia/          <- e so isso, com 3 ou com 4 arquivos
 *
 * Ou seja: enquanto `lib/agentes/ia/` estiver untracked, NENHUM arquivo
 * novo colocado la dentro aparece para o G11. Aceitar a forma colapsada
 * sem mais nada abriria exatamente o furo que o G11 existe para fechar —
 * uma pasta franca dentro do escopo dos agentes.
 *
 * Por isso a entrada colapsada e aceita AQUI e o conteudo do diretorio e
 * verificado SEPARADAMENTE, por enumeracao real de disco, em G11l. Os
 * dois andam juntos: quem remover um tem de remover o outro, ou o guarda
 * fica cego sem que nenhum teste reclame.
 *
 * As formas expandidas tambem entram porque o colapso e transitorio: no
 * instante do `git add`/commit os mesmos arquivos passam a aparecer um a
 * um. A propriedade medida e "que arquivo aparece", nunca "em que estado
 * de versionamento ele esta".
 */
const ARQUIVOS_1EA: readonly string[] = [
  "lib/agentes/ia/",
  ...ARQUIVOS_IA_1EA.map((nome) => `lib/agentes/ia/${nome}`),
  "scripts/testar-agentes-ia-adaptador.ts",
];

/**
 * O que a AGENTES-FASE1E-b acrescentou: a composicao pura
 * "analise deterministica -> IA" e a suite dela.
 *
 * OBSERVADO nesta fase, e vale registrar porque confirma o que o
 * docblock de `ARQUIVOS_1EA` previu: agora que `lib/agentes/ia/` esta
 * RASTREADO, o `git status --porcelain` deixou de colapsar a pasta e
 * passou a listar o arquivo novo expandido —
 * `?? lib/agentes/ia/interpretar-analise-vendas.ts`. O colapso era mesmo
 * transitorio, e por isso as duas formas continuam declaradas.
 */
const ARQUIVOS_IA_1EB: readonly string[] = [
  "interpretar-analise-vendas.ts",
];

const ARQUIVOS_1EB: readonly string[] = [
  ...ARQUIVOS_IA_1EB.map((nome) => `lib/agentes/ia/${nome}`),
  "scripts/testar-agentes-ia-interpretacao.ts",
];

/**
 * O que a AGENTES-FASE1E-c acrescentou: o wiring da interpretacao no
 * runtime (flag + decorator) e a suite dele.
 *
 * `lib/agentes/ativacao-ia.ts` fica FORA de `lib/agentes/ia/` de
 * proposito: aquele diretorio e zona pura, varrida pela suite da 1E-a,
 * e este modulo LE `process.env`. Por isso ele entra aqui como caminho
 * proprio e NAO em `ARQUIVOS_IA_ESPERADOS` — o inventario de `ia/`
 * continua com quatro arquivos, e o guarda de la segue valendo intacto.
 */
const ARQUIVOS_1EC: readonly string[] = [
  "lib/agentes/ativacao-ia.ts",
  "scripts/testar-agentes-ia-wiring.ts",
];

/**
 * O que a AGENTES-FASE1E-d acrescentou: o adaptador do provedor real e a
 * suite dele.
 *
 * Tambem fora de `lib/agentes/ia/`, pelo mesmo motivo do wiring: le env
 * e fala com um SDK. O inventario de `ia/` continua com quatro arquivos.
 *
 * `lib/ai-gateway/provedores/anthropic.ts` NAO entra aqui: `ESCOPO_AGENTES`
 * cobre `lib/agentes`, a rota interna e as migrations — o gateway esta
 * fora do escopo deste guarda, e a alteracao dele (timeout opcional) foi
 * autorizada e verificada a parte, na suite da 1E-d.
 */
const ARQUIVOS_1ED: readonly string[] = [
  "lib/agentes/adaptador-anthropic.ts",
  "scripts/testar-agentes-ia-provider.ts",
];

/**
 * O que a AGENTES-FASE1E-e acrescentou: a observabilidade de chamadas de
 * IA e a suite dela.
 *
 * Tambem fora de `lib/agentes/ia/`, pelo mesmo motivo das duas fases
 * anteriores: o modulo compoe acesso a banco (por import dinamico) e
 * calcula custo — e wiring, nao contrato. O inventario de `ia/` continua
 * com quatro arquivos, e o guarda de la segue intacto.
 */
const ARQUIVOS_1EE: readonly string[] = [
  "lib/agentes/observabilidade-ia.ts",
  "scripts/testar-agentes-ia-observabilidade.ts",
  // `ESCOPO_AGENTES` cobre `supabase/migrations`, entao a migration da
  // fase precisa constar aqui alem de em MIGRATIONS_NO_DISCO_NAO_COMMITADAS
  // — os dois guardas olham a mesma pasta por angulos diferentes: um ve
  // o ESCOPO sujo, o outro ve o conjunto de migrations.
  "supabase/migrations/20260919_agentes_ia_chamadas.sql",
  "supabase/migrations/20260826_agentes_ia_chamadas_append_only.sql",
];

/**
 * CONEXOES/CAPABILITIES-1 — saneamento da autoridade de `lojas`.
 *
 * Nao sao arquivos de agentes, mas caem no `ESCOPO_AGENTES` porque ele
 * cobre `supabase/migrations` inteiro. Declaradas nome a nome, como as
 * demais: o guarda continua reprovando migration nao prevista.
 */
const ARQUIVOS_CONEXOES_1: readonly string[] = [
  "supabase/migrations/20260826_lojas_remover_orfaos.sql",
  "supabase/migrations/20260826_lojas_autoridade_dono.sql",
];

/**
 * SKILL-1D.d.1 — permissoes reais por agente e funcao.
 *
 * Tambem nao e arquivo de agentes, mas cai no `ESCOPO_AGENTES` pelo mesmo
 * motivo de `ARQUIVOS_CONEXOES_1`: o escopo cobre `supabase/migrations`
 * inteiro. Declarada nome a nome — o guarda continua reprovando migration
 * nao prevista, e a suite propria da fase e
 * `scripts/testar-ia-skill-1d-d1.ts`, que fica fora do escopo porque
 * `scripts/` nunca esteve em `ESCOPO_AGENTES`.
 */
const ARQUIVOS_SKILL_1DD1: readonly string[] = [
  "supabase/migrations/20260920_agente_permissoes.sql",
];

/**
 * MIGRATIONS que podem estar no DISCO sem estar no HEAD do git.
 *
 * O G12b comparava disco contra HEAD e exigia conjunto vazio — era o
 * assert de fase "a 1D-c nao introduziu migration nova". Ele esta CERTO
 * em reprovar: migration nova nao declarada e exatamente o que ele deve
 * pegar. Entao ele nao e afrouxado — passa a comparar contra uma lista
 * EXPLICITA, nome a nome, como as demais allowlists desta suite.
 *
 * `20260919_agentes_ia_chamadas.sql` (AGENTES-FASE1E-e) esta no disco e
 * ainda nao commitada: e o artefato do gate pre-migration. Ela tambem
 * NAO foi aplicada ao banco — a aplicacao depende de autorizacao
 * explicita, e o proprio cabecalho do arquivo diz isso.
 */
const MIGRATIONS_NO_DISCO_NAO_COMMITADAS: readonly string[] = [
  "20260919_agentes_ia_chamadas.sql",
  // Corretiva de grants: o `grant select, insert` da criacao NAO tornou
  // a tabela append-only, porque GRANT e aditivo e o projeto concede
  // tudo a service_role por ALTER DEFAULT PRIVILEGES. Faltava o REVOKE.
  // Aplicada como versao 20260826193859.
  "20260826_agentes_ia_chamadas_append_only.sql",
  // CONEXOES/CAPABILITIES-1 — saneamento da autoridade de lojas.
  // Aplicadas como 20260826201145 e 20260826201326.
  "20260826_lojas_remover_orfaos.sql",
  "20260826_lojas_autoridade_dono.sql",
  // SKILL-1D.d.1 — `agente_permissoes`. NAO APLICADA: o arquivo e o
  // artefato do gate pre-migration, e o proprio cabecalho dele diz isso.
  // Aplicar ao banco exige autorizacao separada.
  "20260920_agente_permissoes.sql",
];

/**
 * Inventario acumulado de `lib/agentes/ia/`, por frente.
 *
 * O guarda de disco (G11l) compara contra ESTA uniao, nunca contra uma
 * frente isolada — senao cada fase nova reprovaria a anterior.
 */
const ARQUIVOS_IA_ESPERADOS: readonly string[] = [...ARQUIVOS_IA_1EA, ...ARQUIVOS_IA_1EB];

/** Uniao EXPLICITA. Qualquer caminho fora dela reprova o G11. */
const ARQUIVOS_ESPERADOS: readonly string[] = [
  ...ARQUIVOS_1DD,
  ...ARQUIVOS_1DA_PERF,
  ...ARQUIVOS_1EA,
  ...ARQUIVOS_1EB,
  ...ARQUIVOS_1EC,
  ...ARQUIVOS_1ED,
  ...ARQUIVOS_1EE,
  ...ARQUIVOS_CONEXOES_1,
  ...ARQUIVOS_SKILL_1DD1,
];

/**
 * PREDICADO de G11 — funcao de TEXTO, para que o controle negativo possa
 * alimentar uma saida sintetica sem tocar em arquivo nenhum.
 *
 * Verdadeiro quando tudo que aparece no escopo esta entre os arquivos
 * autorizados. Igualdade EXATA de caminho, nao `endsWith`: um
 * `outra/pasta/registry.ts` passaria por sufixo.
 */
function soAutorizadosNoEscopo(saidaPorcelain: string): boolean {
  return caminhosDeStatus(saidaPorcelain).every((p) => ARQUIVOS_ESPERADOS.includes(p));
}

/**
 * Igualdade EXATA de conjunto entre dois inventarios de nomes.
 *
 * Nao e "todo esperado esta presente": um arquivo a mais reprova, e um
 * arquivo que sumiu tambem — os guardas que usam isto valem nas duas
 * direcoes.
 *
 * Funcao de LISTA, nao de disco, pelo mesmo motivo de
 * `soAutorizadosNoEscopo`: os controles negativos alimentam inventario
 * sintetico sem precisar criar arquivo nenhum. A leitura real acontece
 * uma vez, em cada assert.
 */
function mesmoConjuntoDeNomes(encontrados: readonly string[], esperados: readonly string[]): boolean {
  const a = [...encontrados].sort();
  const b = [...esperados].sort();
  return a.length === b.length && a.every((nome, i) => nome === b[i]);
}

/** PREDICADO de G11l — o guarda que o Git nao consegue ser (ver `ARQUIVOS_1EA`). */
function soAutorizadosDentroDeIa(nomes: readonly string[]): boolean {
  return mesmoConjuntoDeNomes(nomes, ARQUIVOS_IA_ESPERADOS);
}

/**
 * INVENTARIO EXPLICITO das suites de agentes em `scripts/`.
 *
 * ── O SEGUNDO buraco do oraculo Git, achado na 1E-a ─────────────────
 * `ESCOPO_AGENTES` cobre `lib/agentes`, a rota interna e as migrations —
 * nunca cobriu `scripts/`. Consequencia MEDIDA: uma suite de agentes
 * inesperada em `scripts/` nao reprovava o G11 (controle negativo M3 da
 * 1E-a escapou com exit 0 antes desta lista existir).
 *
 * Nao da para fechar isso pelo `git status`: seis destas oito ja estao
 * commitadas e limpas, entao simplesmente nao aparecem no porcelain.
 * Por isso o guarda e enumeracao de DISCO, igual ao de `lib/agentes/ia/`
 * — e por isso ele continua valendo depois do commit, quando o oraculo
 * Git fica mudo.
 *
 * `testar-agentes-isolamento-1de.ts` esta aqui e permanece UNTRACKED de
 * proposito: e a ferramenta operacional da prova de isolamento
 * multi-tenant, que a 1D-e decidiu explicitamente nao versionar nesta
 * frente. Declara-la aqui nao a versiona nem a legitima como suite
 * permanente — apenas registra que a presenca dela em disco e conhecida,
 * em vez de reprovar o guarda todo dia. Converte-la em ferramenta de
 * verdade continua sendo frente propria.
 *
 * Sem curinga e sem prefixo permissivo: nome a nome. Uma suite nova
 * exige uma linha nova aqui, de proposito.
 */
const SUITES_AGENTES: readonly string[] = [
  "testar-agentes-analise-vendas.ts",
  "testar-agentes-execucao-banco.ts",
  "testar-agentes-execucao.ts",
  "testar-agentes-fundacao.ts",
  "testar-agentes-ia-adaptador.ts",
  "testar-agentes-ia-interpretacao.ts",
  "testar-agentes-ia-observabilidade.ts",
  "testar-agentes-ia-provider.ts",
  "testar-agentes-ia-wiring.ts",
  "testar-agentes-isolamento-1de.ts",
  "testar-agentes-isolamento-banco.ts",
  "testar-agentes-vendas-capability.ts",
];

/** PREDICADO de G11t. */
function soAutorizadasEmScripts(nomes: readonly string[]): boolean {
  return mesmoConjuntoDeNomes(nomes, SUITES_AGENTES);
}

/**
 * ORACULO DE MIGRATIONS — propriedade POSITIVA e estavel.
 *
 * O G12 antigo concluia "nenhuma migration criada" a partir de uma lista
 * do `git status` estar vazia. Depois do commit essa lista fica vazia
 * SEMPRE, e o assert passaria sem verificar coisa alguma.
 *
 * A fonte de verdade e o proprio HEAD: `git ls-tree` diz quais migrations
 * o repositorio conhece. Compara-se CONJUNTO no disco contra CONJUNTO no
 * HEAD. Isso independe de o arquivo estar untracked, staged ou commitado
 * — e ainda pega o caso oposto, uma migration que suma do disco.
 */
function migrationsDisco(): string[] {
  return readdirSync(join(RAIZ, "supabase/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort();
}
function migrationsHead(): string[] {
  return git("ls-tree", "--name-only", "HEAD", "supabase/migrations/")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.endsWith(".sql"))
    .map((l) => l.slice(l.lastIndexOf("/") + 1))
    .sort();
}
/** Itens de `a` ausentes em `b`. Pura, para o controle negativo. */
const soEmA = (a: string[], b: string[]) => a.filter((x) => !b.includes(x));

async function main() {
  console.log("\nAGENTES-FASE1D-c — handler analise_vendas (puro)\n");

  // ═══ A. CONTRATO / FABRICA ════════════════════════════════════════
  console.log("A. Contrato e fabrica");

  const espiaoBase = capabilityFake(vendas([linha({})]));
  const handler = criarHandlerAnaliseVendas(espiaoBase.ler);

  ok("A1  a fabrica existe e e funcao", typeof criarHandlerAnaliseVendas === "function");
  ok("A2  a fabrica devolve funcao (HandlerTarefa)", typeof handler === "function");
  ok("A3  o handler tem EXATAMENTE 2 parametros", handler.length === 2);
  ok("A4  a fabrica recebe EXATAMENTE 1 parametro", criarHandlerAnaliseVendas.length === 1);
  ok("A5  o unico parametro e a capability (aridade 1, como LerVendasDoPeriodo)", espiaoBase.aridade === 1);
  ok("A6  a fabrica RECUSA construcao sem capability", await lancou(async () => (criarHandlerAnaliseVendas as unknown as () => void)()) instanceof Error);
  ok("A7  capability ausente nao vira estado normal (nao devolve handler)", await lancou(async () => (criarHandlerAnaliseVendas as unknown as (x: unknown) => void)(null)) instanceof Error);
  ok("A8  o handler devolvido e async", handler(contexto(ENTRADA_OK), () => {}) instanceof Promise);

  // Anti-vacuidade: as varreduras abaixo so valem se a fonte foi lida.
  ok("A9  fonte do handler carregada (anti-vacuidade)", src.length > 1000 && /criarHandlerAnaliseVendas/.test(src));
  ok("A10 a fonte NUNCA menciona userId", !/userId/.test(src));
  ok("A11 a fonte NUNCA menciona user_id", !/user_id/.test(src));
  ok("A12 a fonte NUNCA menciona SupabaseClient", !/SupabaseClient/i.test(src));
  ok("A13 nenhum import de supabase / sdk", !/from\s+["'][^"']*supabase[^"']*["']/i.test(src) && !/@supabase\//.test(src));
  ok("A14 sem import de server-only", !/["']server-only["']/.test(src));
  ok("A15 sem createClient", !/createClient/.test(src));
  ok(
    "A16 dados/vendas.ts entra SOMENTE como `import type`",
    /import\s+type\s*\{[^}]*\}\s*from\s+["']@\/lib\/agentes\/dados\/vendas["']/.test(src) &&
      !/(^|\n)\s*import\s+\{[^}]*\}\s*from\s+["']@\/lib\/agentes\/dados\/vendas["']/.test(src)
  );
  ok("A17 nao chama criarLeiturasDeVendas (nao constroi a propria leitura)", !/criarLeiturasDeVendas/.test(src));
  ok("A18 sem process.env", !/process\.env/.test(src));
  ok("A19 sem fetch / http / axios", !/\bfetch\s*\(/.test(src) && !/require\(["']https?["']\)/.test(src) && !/axios/.test(src));
  ok("A20 sem IA: gemini/anthropic/openai/claude/prompt/ai-gateway", !/gemini|anthropic|openai|@google\/genai|ai-gateway|\bprompt\b/i.test(src));
  ok("A21 sem RPC de conclusao/falha", !/concluir_tarefa|falhar_tarefa|concluirTarefa|falharTarefa|\.rpc\(/.test(src));
  ok("A22 sem escrita: insert/update/upsert/delete", !/\.(insert|update|upsert|delete)\(/.test(src));
  ok("A23 sem Storage", !/storage|bucket/i.test(src));
  ok("A24 sem colunas de rentabilidade", !/custo|imposto|margem_contrib|mc_percent|lucro_liquido|\broi\b|seller_income|escrow_amount|tarifa_venda|commission_fee/i.test(src));
  ok("A25 o tipo declarado e analise_vendas", TIPO_ANALISE_VENDAS === "analise_vendas");
  ok("A26 nenhum estado mutavel de modulo (let/var no topo)", !/^(let|var)\s/m.test(src));
  ok("A27 sem Date.now / new Date / Math.random", !/Date\.now|new Date\(|Math\.random/.test(src));

  // ═══ B. CLOSURE ═══════════════════════════════════════════════════
  console.log("B. Closure e injecao");

  {
    const espiao = capabilityFake(vendas([linha({ order_id: "P1", sku: "S1", item_subtotal: 100, qtd: 2 })]));
    const h = criarHandlerAnaliseVendas(espiao.ler);
    const r = await h(contexto({ ...ENTRADA_OK, marketplace: "Shopee" }), () => {});

    ok("B1  a capability fake foi REALMENTE chamada", espiao.chamadas.length === 1);
    ok(
      "B2  o filtro repassado e exatamente {dataInicio, dataFim, marketplace}",
      JSON.stringify(Object.keys(espiao.chamadas[0]).sort()) ===
        JSON.stringify(["dataFim", "dataInicio", "marketplace"])
    );
    ok("B3  dataInicio repassada literalmente", espiao.chamadas[0].dataInicio === "2026-07-01");
    ok("B4  dataFim repassada literalmente", espiao.chamadas[0].dataFim === "2026-07-14");
    ok("B5  marketplace repassado literalmente", espiao.chamadas[0].marketplace === "Shopee");
    ok("B6  limiteSkus NAO vai para a capability", !("limiteSkus" in espiao.chamadas[0]));
    ok("B7  userId NAO vai para a capability", !("userId" in espiao.chamadas[0]) && !("user_id" in espiao.chamadas[0]));
    ok("B8  a saida depende da resposta da capability", (r.totais as { faturamento: number }).faturamento === 100);
  }

  {
    // Duas fabricas, duas capabilities. Nenhuma enxerga a outra.
    const e1 = capabilityFake(vendas([linha({ order_id: "X1", sku: "SA", item_subtotal: 7 })]));
    const e2 = capabilityFake(vendas([linha({ order_id: "Y1", sku: "SB", item_subtotal: 999 })]));
    const h1 = criarHandlerAnaliseVendas(e1.ler);
    const h2 = criarHandlerAnaliseVendas(e2.ler);

    const r1 = await h1(contexto(ENTRADA_OK), () => {});
    const r2 = await h2(contexto(ENTRADA_OK), () => {});
    const r1b = await h1(contexto(ENTRADA_OK), () => {});

    ok("B9  cada handler chamou SOMENTE a sua capability", e1.chamadas.length === 2 && e2.chamadas.length === 1);
    ok("B10 resultados nao se misturam", (r1.totais as { faturamento: number }).faturamento === 7 && (r2.totais as { faturamento: number }).faturamento === 999);
    ok("B11 h1 nao foi contaminado por h2", JSON.stringify(r1) === JSON.stringify(r1b));
    ok("B12 os dois handlers sao objetos distintos", h1 !== h2);
    ok("B13 sem dependencia global mutavel: reordenar as chamadas nao muda nada", (r2.skus as { sku: string }[])[0].sku === "SB");
  }

  // ═══ C. ENTRADA ═══════════════════════════════════════════════════
  console.log("C. Entrada");

  {
    const espiao = capabilityFake(vendas([linha({})]));
    const h = criarHandlerAnaliseVendas(espiao.ler);
    const r = await h(contexto(ENTRADA_OK), () => {});
    ok("C1  entrada valida minima funciona", typeof r === "object" && r !== null);
    ok("C2  marketplace ausente vira null no filtro", espiao.chamadas[0].marketplace === null);
    ok("C3  limiteSkus ausente usa o padrao", LIMITE_SKUS_PADRAO === 10);
  }

  const INVALIDAS: Array<[string, unknown]> = [
    ["entrada vazia", {}],
    ["dataInicio ausente", { dataFim: "2026-07-14" }],
    ["dataFim ausente", { dataInicio: "2026-07-01" }],
    ["dataInicio nao-string", { dataInicio: 20260701, dataFim: "2026-07-14" }],
    ["dataInicio string vazia", { dataInicio: "", dataFim: "2026-07-14" }],
    ["dataFim nao-string", { dataInicio: "2026-07-01", dataFim: null }],
    ["marketplace numerico", { ...ENTRADA_OK, marketplace: 7 }],
    ["marketplace vazio", { ...ENTRADA_OK, marketplace: "" }],
    ["limiteSkus zero", { ...ENTRADA_OK, limiteSkus: 0 }],
    ["limiteSkus negativo", { ...ENTRADA_OK, limiteSkus: -1 }],
    ["limiteSkus fracionario", { ...ENTRADA_OK, limiteSkus: 2.5 }],
    ["limiteSkus acima do maximo", { ...ENTRADA_OK, limiteSkus: LIMITE_SKUS_MAXIMO + 1 }],
    ["limiteSkus string", { ...ENTRADA_OK, limiteSkus: "10" }],
    ["entrada array", []],
    ["entrada string", "nao sou objeto"],
  ];

  for (const [nome, entrada] of INVALIDAS) {
    const espiao = capabilityFake(vendas([]));
    const h = criarHandlerAnaliseVendas(espiao.ler);
    const err = await lancou(() => h(contexto(entrada as Record<string, unknown>), () => {}));
    ok(`C4  "${nome}" lanca ErroEntradaTarefa`, err instanceof ErroEntradaTarefa);
    ok(`C5  "${nome}" nao chega a consultar a capability`, espiao.chamadas.length === 0);
  }

  {
    // A classe tem de ser a MESMA de lib/agentes/erros.ts, nao uma homonima:
    // e o `instanceof` do executor que decide `entrada_invalida`.
    const espiao = capabilityFake(vendas([]));
    const h = criarHandlerAnaliseVendas(espiao.ler);
    const err = (await lancou(() => h(contexto({}), () => {}))) as Error;
    ok("C6  o erro e instancia da classe importada de lib/agentes/erros", err instanceof ErroEntradaTarefa);
    ok("C7  name preservado", err.name === "ErroEntradaTarefa");
    ok("C8  o erro e Error de verdade", err instanceof Error);
    ok("C9  o handler nao tem caminho de retorno com ok:false", !/\bok\s*:\s*(false|true)\b/.test(src));
  }

  {
    // Prova direta de C9: nenhuma execucao com entrada invalida resolve.
    const espiao = capabilityFake(vendas([]));
    const h = criarHandlerAnaliseVendas(espiao.ler);
    let resolveu = false;
    try {
      await h(contexto({}), () => {});
      resolveu = true;
    } catch {
      /* esperado */
    }
    ok("C10 entrada invalida NUNCA resolve a promise", resolveu === false);
  }

  ok("C11 validarEntradaAnaliseVendas e exportada e pura", typeof validarEntradaAnaliseVendas === "function");
  ok("C12 a validacao NAO reimplementa formato de data", !/\\d\{4\}-\\d\{2\}/.test(src) && !/FORMATO_DATA/.test(src));
  ok("C13 a validacao NAO reimplementa a janela de 14 dias", !/JANELA_MAXIMA|\b14\b/.test(src.replace(/limiteSkus[^\n]*/g, "")));
  ok("C14 a validacao NAO reimplementa a lista de marketplaces", !/MARKETPLACES_VALIDOS|"Shopee"|"ML"/.test(src));
  ok("C15 a validacao NAO reimplementa status paid como filtro de query", !/\.eq\(/.test(src));

  // ═══ D. ERROS ═════════════════════════════════════════════════════
  console.log("D. Erros");

  {
    const espiao = capabilityFake({ lanca: new Error("banco caiu") });
    const h = criarHandlerAnaliseVendas(espiao.ler);
    const err = (await lancou(() => h(contexto(ENTRADA_OK), () => {}))) as Error;
    ok("D1  excecao da capability PROPAGA", err instanceof Error);
    ok("D2  a mensagem original nao e trocada", err.message === "banco caiu");
    ok("D3  o handler nao engoliu (nao devolveu objeto)", !(err === null));
  }

  for (const codigoErro of ["filtro_ausente", "data_invalida", "periodo_invertido", "janela_excedida", "marketplace_invalido"]) {
    const espiao = capabilityFake(vendas([], false, codigoErro));
    const h = criarHandlerAnaliseVendas(espiao.ler);
    const err = await lancou(() => h(contexto(ENTRADA_OK), () => {}));
    ok(`D4  erro de filtro "${codigoErro}" vira ErroEntradaTarefa`, err instanceof ErroEntradaTarefa);
  }

  for (const codigoErro of ["user_id_ausente", "erro_consulta_vendas"]) {
    const espiao = capabilityFake(vendas([], false, codigoErro));
    const h = criarHandlerAnaliseVendas(espiao.ler);
    const err = await lancou(() => h(contexto(ENTRADA_OK), () => {}));
    ok(`D5  falha de infraestrutura "${codigoErro}" NAO vira entrada_invalida`, err instanceof Error && !(err instanceof ErroEntradaTarefa));
  }

  {
    const espiao = capabilityFake(vendas([linha({})], true));
    const h = criarHandlerAnaliseVendas(espiao.ler);
    const err = await lancou(() => h(contexto(ENTRADA_OK), () => {}));
    ok("D6  truncado LANCA — total incompleto nunca e devolvido como completo", err instanceof Error);
    ok("D7  truncado e classificado como entrada (retentar o mesmo filtro nao resolve)", err instanceof ErroEntradaTarefa);
  }

  ok("D8  o handler nao classifica erro (nao conhece as categorias do executor)", !/tipo_desconhecido|handler_falhou|erro_interno|entrada_invalida/.test(src));
  ok("D9  o handler nao grava estado", !/registrarProgresso\(|capability-worker|executar-tarefa/.test(src));
  ok("D10 o handler nao chama RPC alguma", !/\.rpc\(/.test(src));
  ok("D11 nenhum catch que descarte erro", !/catch\s*(\([^)]*\))?\s*\{\s*\}/.test(src));
  ok("D12 nenhum try em volta da capability", !/try\s*\{[^}]*lerVendasDoPeriodo/.test(src));

  // ═══ E. PROGRESSO ═════════════════════════════════════════════════
  console.log("E. Progresso");

  {
    const espiao = capabilityFake(vendas([linha({})]));
    const h = criarHandlerAnaliseVendas(espiao.ler);
    const p = coletorDeProgresso();
    await h(contexto(ENTRADA_OK), p.relatar);

    ok("E1  progresso foi reportado", p.valores.length >= 2);
    ok("E2  todo valor esta em 0..100", p.valores.every((v) => v >= 0 && v <= 100));
    ok("E3  a sequencia e monotonica nao-decrescente", p.valores.every((v, i) => i === 0 || v >= p.valores[i - 1]));
    ok("E4  comeca em 0", p.valores[0] === 0);
    ok("E5  termina em 100", p.valores[p.valores.length - 1] === 100);
    ok("E6  a sequencia e deterministica", JSON.stringify(p.valores) === JSON.stringify([0, 10, 60, 100]));
  }

  {
    // Falha no meio: nao chega a 100. Progresso e informacao, nao ritual.
    const espiao = capabilityFake(vendas([], false, "erro_consulta_vendas"));
    const h = criarHandlerAnaliseVendas(espiao.ler);
    const p = coletorDeProgresso();
    await lancou(() => h(contexto(ENTRADA_OK), p.relatar));
    ok("E7  falha no meio nao reporta 100", !p.valores.includes(100));
  }

  ok("E8  sem setInterval / setTimeout / timer proprio", !/setInterval|setTimeout|setImmediate|clearInterval/.test(src));
  ok("E9  sem heartbeat proprio", !/heartbeat/i.test(src));
  ok("E10 sem retry proprio", !/retry|retentar|\btentativas\b|maxTentativas/i.test(src));
  ok("E11 sem laco de repeticao sobre a capability", !/while\s*\(|do\s*\{/.test(src));
  ok("E12 nao le contexto.tentativa", !/contexto\.tentativa/.test(src));

  // ═══ F. SAIDA ═════════════════════════════════════════════════════
  console.log("F. Saida");

  const LINHAS_RICAS: LinhaVenda[] = [
    linha({ order_id: "P1", sku: "SKU-A", anuncio: "Anuncio A", marketplace: "Shopee", qtd: 2, item_subtotal: 50, faturamento: 80 }),
    linha({ order_id: "P1", sku: "SKU-B", anuncio: "Anuncio B", marketplace: "Shopee", qtd: 1, item_subtotal: 30, faturamento: 80 }),
    linha({ order_id: "P2", sku: "SKU-A", anuncio: "Anuncio A2", marketplace: "Shopee", qtd: 1, item_subtotal: 25, faturamento: 25 }),
    linha({ order_id: "P3", sku: "SKU-A", anuncio: "Anuncio A", marketplace: "ML", qtd: 3, item_subtotal: 90, faturamento: 90 }),
    linha({ order_id: "P4", sku: null, anuncio: null, marketplace: "ML", qtd: 1, item_subtotal: null, faturamento: 40 }),
    linha({ order_id: "P5", sku: "SKU-C", anuncio: null, marketplace: "ML", qtd: 0, item_subtotal: 0, faturamento: 0 }),
  ];

  {
    const espiao = capabilityFake(vendas(LINHAS_RICAS));
    const h = criarHandlerAnaliseVendas(espiao.ler);
    const r = await h(contexto(ENTRADA_OK), () => {});
    const totais = r.totais as Record<string, number>;
    const qualidade = r.qualidadeDados as Record<string, number>;
    const skus = r.skus as Array<Record<string, unknown>>;
    const mps = r.marketplaces as Array<Record<string, unknown>>;

    ok("F1  saida e objeto simples (Record<string, unknown>)", typeof r === "object" && r !== null && !Array.isArray(r) && Object.getPrototypeOf(r) === Object.prototype);
    ok("F2  saida e JSON serializavel e estavel na ida e volta", JSON.stringify(JSON.parse(JSON.stringify(r))) === JSON.stringify(r));
    ok("F3  nenhum Map/Set/Date/function/undefined vazando na saida", tiposExoticos(r).length === 0);

    const { chaves, textos } = achatar(r);
    ok("F4  nenhuma chave userId/user_id na saida", !chaves.some((k) => /^user_?id$/i.test(k)));
    ok("F5  o userId do contexto NAO aparece em valor algum", !textos.includes(USER_ID_SENTINELA) && !JSON.stringify(r).includes(USER_ID_SENTINELA));
    ok("F6  nenhuma chave de cliente/credencial", !chaves.some((k) => /supabase|client|token|secret|key|senha|password/i.test(k)));
    ok("F7  nenhuma coluna de rentabilidade na saida", !chaves.some((k) => /custo|imposto|margem|mc_percent|lucro|^roi$|escrow|seller_income|tarifa|commission/i.test(k)));
    ok("F8  a saida declara que NAO inclui rentabilidade", (r.escopo as Record<string, unknown>).incluiRentabilidade === false);
    ok("F9  a saida declara o campo temporal oficial", (r.escopo as Record<string, unknown>).campoData === "data_pagamento");
    ok("F10 a saida declara o status considerado", (r.escopo as Record<string, unknown>).statusConsiderado === "paid");

    ok("F11 pedidosPagos conta order_id DISTINTO", totais.pedidosPagos === 5);
    ok("F12 unidades somam qtd (nulo/zero incluido como zero)", totais.unidades === 8);
    ok("F13 P-FAT: item_subtotal quando positivo, faturamento como fallback", totais.faturamento === 235);
    ok("F14 ticketMedio = faturamento / pedidos distintos", totais.ticketMedio === 47);

    ok("F15 marketplaces agrupados e ordenados", mps.length === 2 && mps[0].marketplace === "ML" && mps[1].marketplace === "Shopee");
    ok("F16 pedidos por marketplace tambem sao distintos", mps[1].pedidos === 2);

    ok("F17 chave do ranking e (sku, marketplace)", skus.length === 4);
    ok("F18 ranking ordenado por faturamento desc", skus[0].sku === "SKU-A" && skus[0].marketplace === "ML" && skus[0].faturamento === 90);
    ok("F19 SKU repetido no mesmo marketplace e agrupado", skus[1].sku === "SKU-A" && skus[1].marketplace === "Shopee" && skus[1].faturamento === 75);
    ok("F20 anunciosDistintos conta rotulos diferentes", skus[1].anunciosDistintos === 2);
    ok("F21 o rotulo escolhido e o anuncio de maior faturamento", skus[1].anuncio === "Anuncio A");
    ok("F22 SKU sem anuncio devolve anuncio null, nao string vazia", skus[3].sku === "SKU-C" && skus[3].anuncio === null);

    ok("F23 linha sem sku fica fora do ranking mas dentro dos totais", qualidade.linhasSemSku === 1 && !skus.some((s) => s.sku === null));
    ok("F24 linha de valor zero e contada, nao descartada", qualidade.linhasSemValor === 1);
    ok("F25 qualidadeDados registra o total de linhas lidas", qualidade.linhas === 6);
    ok("F26 skusDistintos e o universo, nao o recorte", qualidade.skusDistintos === 4);
    ok("F27 corte do ranking e DECLARADO, nunca silencioso", qualidade.skusOmitidos === 0);

    ok("F28 periodo ecoa a entrada", JSON.stringify(r.periodo) === JSON.stringify({ inicio: "2026-07-01", fim: "2026-07-14", marketplace: null }));
    ok("F29 saida pequena: 6 chaves de topo", Object.keys(r).length === 6);
    ok("F30 nenhuma linha crua do banco vaza na saida", !JSON.stringify(r).includes("order_id") && !JSON.stringify(r).includes("data_pagamento\":\"2026-07-01"));
  }

  {
    // Determinismo: mesma capability, mesma entrada, saidas identicas.
    const espiao = capabilityFake(vendas(LINHAS_RICAS));
    const h = criarHandlerAnaliseVendas(espiao.ler);
    const a = await h(contexto(ENTRADA_OK), () => {});
    const b = await h(contexto(ENTRADA_OK), () => {});
    ok("F31 duas execucoes produzem saida byte a byte igual", JSON.stringify(a) === JSON.stringify(b));
    ok("F32 sao objetos distintos (nao a mesma referencia reaproveitada)", a !== b);
  }

  {
    // Corte declarado de verdade.
    const muitos: LinhaVenda[] = [];
    for (let i = 0; i < 25; i++) {
      muitos.push(linha({ order_id: `P${i}`, sku: `SKU-${String(i).padStart(2, "0")}`, item_subtotal: 100 - i }));
    }
    const espiao = capabilityFake(vendas(muitos));
    const h = criarHandlerAnaliseVendas(espiao.ler);
    const r = await h(contexto({ ...ENTRADA_OK, limiteSkus: 5 }), () => {});
    ok("F33 limiteSkus corta o ranking", (r.skus as unknown[]).length === 5);
    ok("F34 o corte aparece em skusOmitidos", (r.qualidadeDados as Record<string, number>).skusOmitidos === 20);
    ok("F35 os totais continuam completos apesar do corte", (r.qualidadeDados as Record<string, number>).skusDistintos === 25);
  }

  {
    const espiao = capabilityFake(vendas([]));
    const h = criarHandlerAnaliseVendas(espiao.ler);
    const r = await h(contexto(ENTRADA_OK), () => {});
    ok("F36 periodo sem vendas nao e erro", (r.totais as Record<string, number>).pedidosPagos === 0);
    ok("F37 ticketMedio com zero pedidos e 0, nao NaN", (r.totais as Record<string, number>).ticketMedio === 0);
    ok("F38 listas vazias, nunca null", Array.isArray(r.skus) && Array.isArray(r.marketplaces));
  }

  {
    // A agregacao e pura e testavel sem handler.
    const a = agregarVendas(LINHAS_RICAS, 10);
    const b = agregarVendas(LINHAS_RICAS, 10);
    ok("F39 agregarVendas e determinista", JSON.stringify(a) === JSON.stringify(b));
    ok("F40 agregarVendas nao muta a entrada", LINHAS_RICAS.length === 6 && LINHAS_RICAS[0].sku === "SKU-A");
    const c = agregarVendas([linha({ item_subtotal: 0.1 }), linha({ order_id: "P9", item_subtotal: 0.2 })], 10);
    ok("F41 dinheiro arredondado em 2 casas (sem ruido de float)", c.totais.faturamento === 0.3);
  }

  {
    // A chave do ranking tem de ser INJETIVA. Com concatenacao por
    // espaco, ("A B","C") e ("A","B C") produzem a mesma string e dois
    // SKUs diferentes se fundiriam numa linha so do relatorio.
    const d = agregarVendas(
      [
        linha({ order_id: "P1", sku: "A B", marketplace: "C", item_subtotal: 10 }),
        linha({ order_id: "P2", sku: "A", marketplace: "B C", item_subtotal: 20 }),
      ],
      10
    );
    ok('F42 chave injetiva: ("A B","C") nao colide com ("A","B C")', d.qualidadeDados.skusDistintos === 2 && d.skus.length === 2);
    ok("F43 os dois SKUs mantem faturamento separado", d.skus[0].faturamento === 20 && d.skus[1].faturamento === 10);
    ok("F44 a chave e serializacao do par, nao concatenacao com separador", /JSON\.stringify\(\[sku, marketplace\]\)/.test(src));
    // `String.fromCharCode(0)` de proposito: um NUL LITERAL aqui tornaria
    // esta suite exatamente o arquivo binario que ela verifica nao existir.
    const NUL = String.fromCharCode(0);
    ok("F45 nenhum byte NUL na fonte do handler (texto, nao binario)", !bruta.includes(NUL));
    ok("F46 nenhum byte NUL na fonte da suite", !fonte("scripts/testar-agentes-analise-vendas.ts").includes(NUL));
    ok("F47 CONTROLE NEGATIVO: a sonda enxerga um NUL quando existe", `a${NUL}b`.includes(NUL));
  }

  // ═══ G. ISOLAMENTO ARQUITETURAL ═══════════════════════════════════
  console.log("G. Isolamento arquitetural");

  // ── G1..G8: o WIRING, por inspecao de fonte ─────────────────────
  //
  // Estes oito eram TRANSITORIOS: afirmavam que a 1D-d ainda nao tinha
  // acontecido ("registry nao conhece analise_vendas", "registry ainda
  // tipa HandlerTarefa"). A 1D-d torna essas premissas falsas de
  // proposito, entao eles foram reformulados para afirmar a arquitetura
  // NOVA — na mesma mudanca que a introduz. Nenhum assert PERMANENTE
  // desta suite foi tocado.
  const srcRegistry = codigo("lib/agentes/handlers/registry.ts");
  const mapaRegistry = bloco(srcRegistry, /export const HANDLERS/);
  const chavesRegistry = [...(mapaRegistry ?? "").matchAll(/\[\s*(TIPO_[A-Z_]+)\s*\]\s*:/g)].map((m) => m[1]).sort();

  ok("G0  fonte do registry carregada (anti-vacuidade)", srcRegistry.length > 300 && /HANDLERS/.test(srcRegistry));
  ok("G1  o mapa do registry foi delimitado (anti-vacuidade)", mapaRegistry !== null && mapaRegistry.length > 40);
  ok("G2  registry registra EXATAMENTE 2 tipos", chavesRegistry.length === 2);
  ok("G3  os tipos sao teste_fundacao e analise_vendas", chavesRegistry.join(",") === "TIPO_ANALISE_VENDAS,TIPO_TESTE_FUNDACAO");
  ok("G4  registry importa o handler e a capability", /criarHandlerAnaliseVendas/.test(srcRegistry) && /criarLeiturasDeVendas/.test(srcRegistry));
  // AGENTES-FASE1E-c: a expressao mudou de forma — o handler passou a ser
  // ENVOLVIDO por `comInterpretacaoDeVendas`. O que este assert existe
  // para provar NAO mudou e continua sendo exigido, item por item:
  // fabrica de aridade 1, `userId` entrando no ato da construcao, e o
  // dono indo SO para a capability. O G5c e a parte que mais importa —
  // se alguem um dia passar `userId` para o interpretador, ele reprova.
  ok("G5  analise_vendas e construido por FABRICA, com o dono no ato",
     /\[TIPO_ANALISE_VENDAS\]: \(userId: string\) =>/.test(norm(mapaRegistry ?? "")));
  ok("G5a a capability continua recebendo o dono",
     /criarHandlerAnaliseVendas\(criarLeiturasDeVendas\(userId\)\)/.test(norm(mapaRegistry ?? "")));
  ok("G5b o handler e envolvido pela interpretacao de IA (1E-c)",
     /comInterpretacaoDeVendas\(\s*criarHandlerAnaliseVendas\(criarLeiturasDeVendas\(userId\)\),\s*criarInterpretadorDeVendas\(\)\s*\)/.test(norm(mapaRegistry ?? "")));
  ok("G5c o dono NAO chega ao interpretador de IA",
     /criarInterpretadorDeVendas\(\)/.test(norm(mapaRegistry ?? "")) &&
     !/criarInterpretadorDeVendas\([^)]/.test(norm(mapaRegistry ?? "")));
  ok("G5d CONTROLE NEGATIVO: G5c reprova se o dono for repassado",
     /criarInterpretadorDeVendas\([^)]/.test("comInterpretacaoDeVendas(h, criarInterpretadorDeVendas(userId))"));
  ok("G6  registry adotou ConstruirHandler e largou HandlerTarefa pronto", /Record<string,\s*ConstruirHandler>/.test(srcRegistry) && !/Record<string,\s*HandlerTarefa>/.test(srcRegistry));
  ok("G6a registry nao passa SupabaseClient nem objeto de dependencias", !/SupabaseClient|getSupabaseServidor|dependencies|LeiturasDeAgente/.test(srcRegistry));
  ok("G6b teste_fundacao nao recebe capability (aridade 0 na fonte)", /\[TIPO_TESTE_FUNDACAO\]: \(\) => handlerTesteFundacao/.test(norm(mapaRegistry ?? "")));

  const srcExecutor = codigo("lib/agentes/executar-tarefa.ts");
  ok("G7  executar-tarefa faz o binding com tarefa.user_id", /construirHandler\(tarefa\.user_id\)/.test(srcExecutor));
  ok("G7a o binding nao vem de entrada/body/query", !/entrada\.userId|body\.user_id|searchParams/.test(srcExecutor));
  ok("G8  executar-tarefa continua chamando handler(contexto, relatarProgresso)", /handler\(contexto,\s*relatarProgresso\)/.test(srcExecutor));
  // ── G8a..G8c: ContextoTarefa NAO mudou nesta fase ────────────────
  //
  // Registro de uma imprecisao do enunciado, resolvida pelo codigo real:
  // `ContextoTarefa` JA POSSUI `readonly userId: string` desde a FASE 1C
  // — o executor o preenche a partir de `tarefa.user_id`. Logo "continua
  // sem userId" nao e satisfazivel literalmente. O que a 1D-d respeita e
  // a regra que importa: NAO ADICIONAR nada ao contexto, e garantir que
  // o handler de dado real nao dependa desse campo.
  //
  // A protecao efetiva nao esta no contexto e sim na CLOSURE: mesmo que
  // o handler lesse `contexto.userId`, nao teria cliente algum com que
  // usa-lo. A capability ja chega amarrada a um dono so.
  const srcTipos = codigo("lib/agentes/tipos-execucao.ts");
  const blocoContexto = bloco(srcTipos, /export interface ContextoTarefa/);
  const camposContexto = [...(blocoContexto ?? "").matchAll(/readonly\s+(\w+)\s*:/g)].map((m) => m[1]).sort();
  ok("G8a ContextoTarefa foi delimitado (anti-vacuidade)", blocoContexto !== null && camposContexto.length > 0);
  ok("G8b ContextoTarefa segue com os MESMOS 7 campos da 1C — nenhum novo",
     camposContexto.join(",") === "agenteId,entrada,maxTentativas,tarefaId,tentativa,tipo,userId");
  ok("G8c o handler de vendas NAO le contexto.userId", !/contexto\.userId/.test(src));

  // Oraculo git: preexistentes intocados. Controle negativo primeiro.
  let gitVivo = false;
  try {
    gitVivo = !gitLimpo("docs/NEXT_TASK.md");
  } catch {
    gitVivo = false;
  }
  ok("G9  CONTROLE NEGATIVO: o oraculo git enxerga arquivo modificado", gitVivo);

  // AGENTES-FASE1D-d: SAIRAM desta lista exatamente os tres arquivos que
  // esta fase esta autorizada a alterar — `registry.ts`,
  // `executar-tarefa.ts` e `testar-agentes-execucao.ts`. Nao saiu mais
  // nenhum: `dados/vendas.ts`, `tipos-execucao.ts`, `erros.ts`,
  // `teste-fundacao.ts`, as capabilities, o worker, a rota interna e o
  // middleware seguem congelados e continuam sendo verificados aqui.
  // AGENTES-FASE1D-a (correcao de performance): sairam TAMBEM
  // `dados/vendas.ts` e `testar-agentes-vendas-capability.ts`. A prova
  // 1D-e revelou que a query de limite inicial da capability usava
  // `.limit(1)` e caia num backward scan de `pedidos_pkey` — 432.472
  // linhas descartadas, 43,5 s, contra um timeout de 8 s. A correcao
  // trocou por `.limit(PAGE_SIZE)`, o que obrigou a alterar os dois.
  //
  // Sair do congelamento NAO e ficar sem protecao: os asserts G10a..G10k
  // logo abaixo cobrem a fronteira que interessa a esta suite. O resto
  // da lista continua exigido byte a byte.
  const CONGELADOS = [
    "lib/agentes/tipos-execucao.ts",
    "lib/agentes/erros.ts",
    "lib/agentes/handlers/teste-fundacao.ts",
    "lib/agentes/handlers/analise-vendas.ts",
    "lib/agentes/capability.ts",
    "lib/agentes/capability-worker.ts",
    "scripts/testar-agentes-fundacao.ts",
    "scripts/testar-middleware.ts",
    "lib/middleware-rotas.ts",
    "scripts/agentes-worker.mjs",
    "app/api/internal/agentes/executar/route.ts",
  ];
  for (const rel of CONGELADOS) {
    ok(`G10 ${rel} identico ao HEAD`, gitVivo && gitLimpo(rel));
  }

  // ── G10a..G10k: a fronteira dos DOIS arquivos liberados ───────────
  //
  // `dados/vendas.ts` deixou de ser congelado byte a byte, mas continua
  // sendo a capability de onde este handler come. O que importa AQUI nao
  // e o arquivo inteiro — a suite da 1D-a ja o cobre em 153 asserts — e
  // sim o contrato de fronteira: a capability publica que o handler
  // recebe, o filtro de tenant, e a query cuja regressao derrubou a 1D-e.
  {
    const srcVendas = codigo("lib/agentes/dados/vendas.ts");
    ok("G10a fonte da capability carregada (anti-vacuidade)", srcVendas.length > 1000);
    ok("G10b capability publica inalterada: criarLeiturasDeVendas -> LerVendasDoPeriodo",
       /export function criarLeiturasDeVendas\(userId: string\): LerVendasDoPeriodo/.test(srcVendas));
    ok("G10c filtro de tenant continua presente", /user_id: String\(userId\)/.test(srcVendas));
    ok("G10d status 'paid' continua obrigatorio", /status: "paid"/.test(srcVendas));
    ok("G10e cursor por id continua: gt(cursor) e lte(limiteInicial)",
       /\.gt\("id", cursor\)/.test(srcVendas) && /\.lte\("id", limiteInicial\)/.test(srcVendas));
    ok("G10f PAGE_SIZE continua 1000", /export const PAGE_SIZE = 1000;/.test(srcVendas));

    // A query do limite, DELIMITADA — um grep global de `.limit(1)`
    // acusaria a paginacao junto.
    const blocoLimite = (() => {
      const i = srcVendas.indexOf("const { data: topo");
      const f = srcVendas.indexOf("if (erroTopo)");
      return i >= 0 && f > i ? srcVendas.slice(i, f) : "";
    })();
    ok("G10g trecho do limite inicial delimitado (anti-vacuidade)", blocoLimite.length > 30);
    ok("G10h limite inicial: ORDER BY id DESC + LIMIT PAGE_SIZE",
       /\.order\("id", \{ ascending: false \}\)/.test(blocoLimite) && /\.limit\(PAGE_SIZE\)/.test(blocoLimite));
    ok("G10i topo[0] continua sendo a origem do limite",
       /topo\[0\]/.test(srcVendas) && /const limiteInicial = primeiraLinha\.id/.test(srcVendas));
    ok("G10j REGRESSAO: .limit(1) nao pode voltar a este trecho", !/\.limit\(\s*1\s*\)/.test(blocoLimite));

    // `testar-agentes-vendas-capability.ts` e suite, e tem de continuar
    // sendo so isso: nenhum arquivo de producao pode passar a importa-la.
    const PRODUCAO = [
      "lib/agentes/dados/vendas.ts",
      "lib/agentes/handlers/analise-vendas.ts",
      "lib/agentes/handlers/registry.ts",
      "lib/agentes/executar-tarefa.ts",
      "lib/agentes/capability-worker.ts",
      "app/api/internal/agentes/executar/route.ts",
    ];
    ok("G10k a suite da 1D-a nao e importada por nenhum arquivo de producao",
       PRODUCAO.every((f) => !/testar-agentes-vendas-capability/.test(codigo(f))));
  }

  {
    // ── G11 — nada inesperado no escopo dos agentes ────────────────
    // Propriedade arquitetural, nao estado do Git: vale com o handler
    // untracked, staged ou ja commitado.
    const saida = git("status", "--porcelain", "--", ...ESCOPO_AGENTES);
    const caminhos = caminhosDeStatus(saida);
    const foraDoEsperado = caminhos.filter((p) => !ARQUIVOS_ESPERADOS.includes(p));

    ok("G11 no escopo dos agentes so aparecem arquivos autorizados (1D-d + correcao 1D-a)", foraDoEsperado.length === 0);

    // Os tres estados de versionamento, todos aceitos.
    ok("G11a aceita untracked", soAutorizadosNoEscopo(`?? ${ARQ_HANDLER}\n`));
    ok("G11b aceita staged", soAutorizadosNoEscopo(`A  ${ARQ_HANDLER}\n`));
    ok("G11c aceita ja commitado (escopo limpo, saida vazia)", soAutorizadosNoEscopo(""));
    ok("G11d aceita os 2 arquivos de producao desta fase, modificados",
       soAutorizadosNoEscopo(" M lib/agentes/handlers/registry.ts\n M lib/agentes/executar-tarefa.ts\n"));

    // Controles negativos sinteticos: o predicado precisa saber dizer
    // NAO, e sem depender de mutacao em disco para isso.
    ok("G11e CONTROLE NEGATIVO: um QUINTO arquivo do escopo reprova", !soAutorizadosNoEscopo(" M lib/agentes/erros.ts\n"));
    // A capability SAIU do congelamento na correcao de performance da
    // 1D-a, entao ela agora e aceita — e quem a protege sao G10a..G10j,
    // nao mais a igualdade byte a byte.
    ok("G11f aceita a capability, liberada pela correcao 1D-a", soAutorizadosNoEscopo(" M lib/agentes/dados/vendas.ts\n"));
    ok("G11f2 CONTROLE NEGATIVO: outra capability do escopo continua reprovando",
       !soAutorizadosNoEscopo(" M lib/agentes/capability-worker.ts\n"));
    ok("G11g CONTROLE NEGATIVO: migration nova no escopo reprova", !soAutorizadosNoEscopo("?? supabase/migrations/99999999_falsa.sql\n"));
    ok("G11h CONTROLE NEGATIVO: autorizados + intruso reprova", !soAutorizadosNoEscopo(" M lib/agentes/handlers/registry.ts\n M lib/agentes/tipos-execucao.ts\n"));
    ok("G11i CONTROLE NEGATIVO: sufixo parecido em outra pasta reprova", !soAutorizadosNoEscopo("?? outra/pasta/registry.ts\n"));
    ok("G11j parser: le o DESTINO de um rename", caminhosDeStatus("R  velho.ts -> lib/agentes/novo.ts\n")[0] === "lib/agentes/novo.ts");
    ok("G11k parser: desempacota caminho entre aspas", caminhosDeStatus('?? "lib/agentes/com espaco.ts"\n')[0] === "lib/agentes/com espaco.ts");

    // ── G11l..G11q — o guarda que o Git NAO consegue ser ───────────
    // Enquanto `lib/agentes/ia/` estiver untracked, o porcelain colapsa
    // a pasta inteira em uma linha e um intruso la dentro fica
    // INVISIVEL para o G11 acima. Medido, nao suposto. Ver o docblock
    // de `ARQUIVOS_1EA`. Estes asserts sao a outra metade do par.
    const conteudoIa = readdirSync(join(RAIZ, "lib", "agentes", "ia")).sort();

    ok("G11l lib/agentes/ia contem exatamente os arquivos declarados (1E-a + 1E-b)", soAutorizadosDentroDeIa(conteudoIa));
    ok("G11m ANCORA: o diretorio foi mesmo lido e nao veio vazio", conteudoIa.length === ARQUIVOS_IA_ESPERADOS.length && conteudoIa.length > 0);
    ok("G11n CONTROLE NEGATIVO: um arquivo A MAIS em ia/ reprova", !soAutorizadosDentroDeIa([...ARQUIVOS_IA_ESPERADOS, "_intruso.ts"]));
    ok("G11o CONTROLE NEGATIVO: arquivo FALTANDO em ia/ reprova", !soAutorizadosDentroDeIa(ARQUIVOS_IA_ESPERADOS.slice(1)));
    ok("G11p CONTROLE NEGATIVO: mesma quantidade, nome trocado, reprova",
       !soAutorizadosDentroDeIa([...ARQUIVOS_IA_ESPERADOS.slice(1), "outro.ts"]));
    ok("G11q a forma COLAPSADA do diretorio e aceita pelo oraculo git (par de G11l)",
       soAutorizadosNoEscopo("?? lib/agentes/ia/\n"));
    ok("G11r a forma EXPANDIDA dos mesmos arquivos tambem e aceita (pos-commit)",
       soAutorizadosNoEscopo(ARQUIVOS_IA_ESPERADOS.map((n) => `A  lib/agentes/ia/${n}`).join("\n") + "\n"));
    ok("G11s CONTROLE NEGATIVO: arquivo expandido NAO declarado em ia/ reprova",
       !soAutorizadosNoEscopo("?? lib/agentes/ia/_intruso.ts\n"));

    // ── G11t..G11w — `scripts/` nunca esteve em ESCOPO_AGENTES ─────
    // Medido na 1E-a: uma suite de agentes inesperada em `scripts/`
    // passava batido. Enumeracao de disco, porque a maioria destas ja
    // esta commitada e limpa — invisivel para o porcelain.
    const suitesEmDisco = readdirSync(join(RAIZ, "scripts"))
      .filter((nome) => nome.startsWith("testar-agentes-"))
      .sort();

    ok("G11t scripts/ contem exatamente as suites de agentes declaradas", soAutorizadasEmScripts(suitesEmDisco));
    ok("G11u ANCORA: o diretorio scripts/ foi lido e achou suites", suitesEmDisco.length === SUITES_AGENTES.length && suitesEmDisco.length > 0);
    ok("G11v CONTROLE NEGATIVO: suite de agentes nao declarada reprova",
       !soAutorizadasEmScripts([...SUITES_AGENTES, "testar-agentes-intruso.ts"]));
    ok("G11w CONTROLE NEGATIVO: suite de agentes que sumiu reprova", !soAutorizadasEmScripts(SUITES_AGENTES.slice(1)));
    ok("G11x a ferramenta operacional 1D-e continua declarada e untracked",
       SUITES_AGENTES.includes("testar-agentes-isolamento-1de.ts") &&
       git("status", "--porcelain", "--", "scripts/testar-agentes-isolamento-1de.ts").startsWith("??"));

    // ── G12 — conjunto de migrations, propriedade positiva ─────────
    const disco = migrationsDisco();
    const head = migrationsHead();
    const novasNoDisco = soEmA(disco, head);
    const sumidasDoDisco = soEmA(head, disco);

    // Anti-vacuidade: sem esta ancora, dois conjuntos vazios "provariam"
    // qualquer coisa — que e exatamente o defeito do G12 antigo.
    ok("G12 ANCORA: o HEAD conhece dezenas de migrations", head.length > 40);
    ok("G12a ANCORA: o disco tambem tem migrations", disco.length > 40);
    ok(`G12b nenhuma migration nao declarada no disco (${novasNoDisco.join(", ") || "nenhuma"})`,
       novasNoDisco.every((m) => MIGRATIONS_NO_DISCO_NAO_COMMITADAS.includes(m)));
    ok("G12b1 CONTROLE NEGATIVO: uma migration nao declarada reprovaria",
       !["99999999_intrusa.sql"].every((m) => MIGRATIONS_NO_DISCO_NAO_COMMITADAS.includes(m)));
    ok("G12b2 a migration da 1E-e declara que NAO foi aplicada",
       readFileSync(join(RAIZ, "supabase", "migrations", "20260919_agentes_ia_chamadas.sql"), "utf8")
         .includes("NAO APLICADA AINDA"));
    ok("G12c nenhuma migration desapareceu do disco", sumidasDoDisco.length === 0);
    ok("G12d as duas migrations desta frente seguem no HEAD", head.includes("20260916_agentes_fundacao.sql") && head.includes("20260917_agentes_execucao.sql"));
    // Controles sobre listas SINTETICAS, nao sobre `disco`/`head` reais:
    // montar o controle a partir do estado real o tornaria sensivel a esse
    // estado — com uma intrusa ja no disco, `[...disco, "falsa"]` daria 2 e
    // o controle acusaria a coisa errada. Aqui ele testa so o comparador.
    ok("G12e CONTROLE NEGATIVO: o comparador detecta arquivo a mais", soEmA(["a.sql", "b.sql", "intrusa.sql"], ["a.sql", "b.sql"]).length === 1);
    ok("G12f CONTROLE NEGATIVO: o comparador detecta arquivo a menos", soEmA(["a.sql", "b.sql"], ["a.sql"]).length === 1);
    ok("G12g o comparador nao acusa conjuntos iguais", soEmA(["a.sql", "b.sql"], ["b.sql", "a.sql"]).length === 0);
  }

  ok("G13 a suite nao importa _server-only-inerte nem _env-inerte", !/_server-only-inerte|_env-inerte/.test(codigo("scripts/testar-agentes-analise-vendas.ts").replace(/ok\([^\n]*\n/g, "")));
  ok("G14 ZERO chamadas de rede durante a suite inteira", chamadasDeRede === 0);

  // ═══ H. SEGREDOS ══════════════════════════════════════════════════
  console.log("H. Segredos");
  for (const [nome, re] of [
    ["JWT", /eyJ[A-Za-z0-9_-]{10,}/],
    ["sbp_/sk-/AIza/AKIA", /sbp_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|AKIA[0-9A-Z]{16}/],
    ["postgres com credencial", /postgres(ql)?:\/\/[^:/@\s]+:[^@\s]+@/],
    ["Bearer literal", /Bearer [A-Za-z0-9._-]{16,}/],
    ["x-worker-secret", /x-worker-secret/i],
  ] as const) {
    ok(`H1 zero ${nome} no handler`, !re.test(bruta));
  }

  // ═══ I. INVARIANTE DO FATURAMENTO POR LINHA ═══════════════════════
  //
  // `agregarVendas` soma valor POR LINHA. Isso so e correto porque os
  // escritores gravam valor DE LINHA nas duas colunas. Essa premissa era
  // tacita ate a auditoria P-FAT; aqui ela vira teste.
  console.log("I. Invariante do faturamento por linha");

  {
    // ── A. FALLBACK MULTI-LINHA RATEADO ────────────────────────────
    // Duas linhas do MESMO pedido, ambas caindo no fallback. E a forma
    // real de um pedido Shopee multi-item pre-Fase-1 e de todo pedido
    // ML (onde `item_subtotal` e 0 por DEFAULT).
    const r = agregarVendas(
      [
        linha({ order_id: "MESMO", sku: "SA", item_subtotal: 0, faturamento: 70 }),
        linha({ order_id: "MESMO", sku: "SB", item_subtotal: 0, faturamento: 30 }),
      ],
      10
    );
    ok("I1  fallback multi-linha soma 70+30 = 100 (total do pedido)", r.totais.faturamento === 100);
    ok("I2  pedidosPagos = 1: duas linhas, um pedido", r.totais.pedidosPagos === 1);
    ok("I3  NAO multiplica pelo numero de linhas (nao da 140 nem 200)", r.totais.faturamento !== 140 && r.totais.faturamento !== 200);
    ok("I4  as duas linhas entraram (nenhuma foi descartada)", r.qualidadeDados.linhas === 2 && r.qualidadeDados.skusDistintos === 2);
    ok("I5  a soma do ranking bate com o total", r.skus.reduce((s, k) => s + k.faturamento, 0) === r.totais.faturamento);
  }

  {
    // ── B. A PREMISSA, EXPLICITA ───────────────────────────────────
    //
    // ATENCAO AO QUE ESTE TESTE NAO DIZ: 200 nao e afirmado como valor
    // de negocio correto. Duas linhas do mesmo pedido carregando, cada
    // uma, o TOTAL do pedido nao correspondem a caminho nenhum de
    // escrita — nem hoje, nem antes do rateio (`git log -S` sobre
    // `sync-shopee.ts` mostra `valorUnit * qtd`, tambem por item).
    //
    // O que este assert documenta e o COMPORTAMENTO de `agregarVendas`:
    // ela soma por linha, sem deduplicar por `order_id`. Logo a
    // correcao do total DEPENDE da invariante dos escritores — a mesma
    // que I6..I13 travam na fonte. Se um dia o dado mudar de forma, e
    // aqui que se ve o que aconteceria.
    const r = agregarVendas(
      [
        linha({ order_id: "MESMO", sku: "SA", item_subtotal: 0, faturamento: 100 }),
        linha({ order_id: "MESMO", sku: "SB", item_subtotal: 0, faturamento: 100 }),
      ],
      10
    );
    ok("I6  PREMISSA: agregarVendas soma por linha, entao valor de PEDIDO repetido daria 200", r.totais.faturamento === 200);
    ok("I7  ...e ainda assim conta 1 pedido — a contagem ja deduplica, a soma nao", r.totais.pedidosPagos === 1);
  }

  {
    // ── C. GUARDA DA INVARIANTE — SHOPEE ───────────────────────────
    const fonteShopee = codigo("lib/sync-shopee.ts");
    const blocoItens = bloco(fonteShopee, /for\s*\(\s*const\s+item\s+of\s*\(\s*order\.item_list/);

    ok("I8  o laco de itens da Shopee foi localizado (anti-vacuidade)", blocoItens !== null && blocoItens.length > 500);
    ok("I9  o bloco e mesmo o que grava a linha de item", blocoItens !== null && /item_subtotal:\s*itemSubtotal/.test(blocoItens));

    if (blocoItens) {
      ok("I10 Shopee: faturamento e RATEADO por item (totalAmount x ratioItem, fallback itemValue)", shopeeRateiaPorItem(blocoItens));

      // Controles negativos: o predicado precisa saber dizer NAO.
      ok(
        "I11 CONTROLE NEGATIVO: remover o rateio derruba o predicado",
        !shopeeRateiaPorItem(blocoItens.replace("totalAmount * ratioItem", "totalAmount"))
      );
      ok(
        "I12 CONTROLE NEGATIVO: trocar o peso do item derruba o predicado",
        !shopeeRateiaPorItem(blocoItens.replace("itemValue / orderItemsSubtotal", "1"))
      );
      ok(
        "I13 CONTROLE NEGATIVO: trocar o fallback por valor de pedido derruba o predicado",
        !shopeeRateiaPorItem(blocoItens.replace(": itemValue", ": totalAmount"))
      );
    } else {
      ok("I10 Shopee: faturamento rateado por item", false);
      ok("I11 CONTROLE NEGATIVO (rateio)", false);
      ok("I12 CONTROLE NEGATIVO (peso)", false);
      ok("I13 CONTROLE NEGATIVO (fallback)", false);
    }
  }

  {
    // ── D. GUARDA DA INVARIANTE — MERCADO LIVRE ────────────────────
    const fonteMl = codigo("lib/sync-ml.ts");
    const blocoItens = bloco(fonteMl, /for\s*\(\s*const\s+orderItem\s+of\s*\(\s*order\.order_items/);

    ok("I14 o laco de order_items do ML foi localizado (anti-vacuidade)", blocoItens !== null && blocoItens.length > 300);
    ok("I15 ML: faturamento = valorUnit x qtd, do proprio item", blocoItens !== null && mlCalculaPorItem(blocoItens));
    ok(
      "I16 CONTROLE NEGATIVO: valor de pedido no lugar derruba o predicado",
      blocoItens !== null && !mlCalculaPorItem(blocoItens.replace("valorUnit * qtd", "order.total_amount"))
    );
    // O ML nao escreve `item_subtotal` — por isso TODA linha de ML usa o
    // fallback, e o fallback precisa mesmo ser por item.
    ok("I17 o sync do ML nao grava item_subtotal (a coluna fica no DEFAULT 0)", !/item_subtotal/.test(fonteMl));
  }

  {
    // ── E. LINHA SHOPEE SEM item_list ──────────────────────────────
    // A unica linha com `faturamento` = total do PEDIDO. Ela e segura
    // por ser a UNICA linha daquele pedido: o bloco retorna antes do
    // laco de itens. E essa saida antecipada que se protege aqui.
    const fonteShopee = codigo("lib/sync-shopee.ts");
    const blocoVazio = bloco(fonteShopee, ANCORA_SEM_ITENS);

    ok("I18 o bloco de pedido sem item_list foi localizado (anti-vacuidade)", blocoVazio !== null && blocoVazio.length > 500);
    ok("I19 ele grava a linha _NOITEM", blocoVazio !== null && /_NOITEM/.test(blocoVazio));
    ok("I20 com item_subtotal = 0", blocoVazio !== null && /item_subtotal:\s*0\b/.test(blocoVazio));
    ok("I21 a linha _NOITEM e a UNICA linha do pedido (sai antes do laco)", noitemEhLinhaUnica(fonteShopee));

    // Controles negativos de verdade: envenena o BLOCO e verifica que o
    // predicado inteiro passa a dizer NAO.
    ok(
      "I22 CONTROLE NEGATIVO: sem `return rows`, a saida antecipada deixa de ser provavel",
      !noitemEhLinhaUnica(envenenarBloco(fonteShopee, ANCORA_SEM_ITENS, /\breturn\s+rows\s*;/, "rows.length;"))
    );
    ok(
      "I23 CONTROLE NEGATIVO: sem `item_subtotal: 0`, o predicado cai",
      !noitemEhLinhaUnica(envenenarBloco(fonteShopee, ANCORA_SEM_ITENS, /item_subtotal:\s*0\b/, "item_subtotal: totalAmount"))
    );
    ok(
      "I24 CONTROLE NEGATIVO: sem a linha _NOITEM, o predicado cai",
      !noitemEhLinhaUnica(envenenarBloco(fonteShopee, ANCORA_SEM_ITENS, /_NOITEM/, "_OUTRO"))
    );
  }

  const total = passou + falhou;
  console.log(`\n${"=".repeat(58)}`);
  console.log(`AGENTES-FASE1D-c — handler analise_vendas:  ${passou}/${total} passaram`);
  if (falhou > 0) {
    console.log(`${falhou} FALHARAM`);
    process.exitCode = 1;
  } else console.log("TODOS OS ASSERTS PASSARAM");
  console.log("=".repeat(58));
}

main().catch((e) => {
  console.error("ERRO NAO TRATADO:", e instanceof Error ? e.message.slice(0, 300) : "desconhecido");
  process.exitCode = 1;
});
