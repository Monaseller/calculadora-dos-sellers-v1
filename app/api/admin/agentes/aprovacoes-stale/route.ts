/**
 * A superficie operacional das aberturas stale — APPROVAL-B1D-D2-I2.
 *
 * ── Por que esta rota existe ────────────────────────────────────────
 *
 * O detector (`stale.ts`) e o observador (`observabilidade-stale.ts`)
 * sao CAPABILITY: codigo que ninguem chama nao observa nada. Enquanto
 * nao houvesse uma superficie, "detectar stale" era uma frase, nao um
 * caminho. Esta rota e o menor mecanismo real pelo qual alguem
 * pergunta — e e por isso que ela precisa existir ANTES de a retomada
 * de aprovacao virar alcancavel: quando o resume puder ser chamado, uma
 * queda no meio dele deixa uma abertura sem desfecho, e essa abertura
 * so e encontravel se houver como perguntar.
 *
 * ── O que ela NAO faz ───────────────────────────────────────────────
 *
 * Nao fecha chamada, nao reexecuta Funcao, nao retoma aprovacao, nao
 * escreve em lugar nenhum e nao varre outros tenants. A politica do B1D
 * e AT-MOST-ONCE preservado: olhar nao muda nada.
 *
 * Tambem nao ha cron, fila nem processo de fundo. A deteccao e
 * MANUAL/SOB DEMANDA — quem quiser saber, pergunta. Volume esperado no
 * piloto: zero.
 *
 * ── Um request, um segmento ─────────────────────────────────────────
 *
 * O observador percorre no maximo 20 paginas por chamada. Esta rota
 * chama o observador UMA vez e devolve o segmento como veio, inclusive
 * o `nextCursor`. Ela nao itera ate `esgotado` — iterar aqui tornaria a
 * latencia imprevisivel e transformaria o teto do observador em ficcao.
 * Quem quiser o proximo segmento pede de novo, mandando o cursor.
 *
 * ── A fronteira de tenant ───────────────────────────────────────────
 *
 * `userId` vem EXCLUSIVAMENTE de `auth.uid`. Nao ha campo no corpo, na
 * query nem no cursor pelo qual escolher outro dono — e um corpo que
 * tente enviar `userId` e RECUSADO, nao ignorado: ignorar em silencio
 * ensinaria quem chama que o campo existe e nao faz nada.
 */
import { NextResponse } from "next/server";

import { autenticarRequisicao } from "@/lib/autenticacao";
import { observarAberturasStaleDoUsuario } from "@/lib/agentes/aprovacoes/observabilidade-stale";

/**
 * O unico campo aceito no corpo.
 *
 * Qualquer outra chave e recusada — inclusive `userId`/`user_id`, que
 * sao exatamente as que alguem tentaria para trocar de tenant.
 */
const CAMPOS_ACEITOS = new Set(["cursor"]);

/**
 * O cursor tambem tem contrato FECHADO.
 *
 * Antes esta funcao extraia os dois campos e ignorava o resto — e um
 * `{ criadoEm, requestId, userId: "outro" }` passava, com o `userId`
 * descartado em silencio. Inerte, porque o dono vem de `auth.uid`; mas
 * incoerente: o corpo de fora recusa chave desconhecida e o objeto de
 * dentro aceitava qualquer uma. Descartar em silencio ensina quem chama
 * que o campo existe e nao faz nada, que e a pior das duas respostas.
 */
const CAMPOS_CURSOR_ACEITOS = new Set(["criadoEm", "requestId"]);

function erro(status: number, codigo: string, detalhe?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, erro: codigo, ...detalhe }, { status });
}

/**
 * Valida a FORMA do cursor, e so ela.
 *
 * A autoridade semantica — o que e um timestamp aceitavel, o que e um
 * `request_id` aceitavel — continua no detector, que ja recusa cursor
 * malformado com `entrada_invalida`. Repetir aqui os regex do D1
 * criaria uma segunda copia que envelheceria em relacao a primeira.
 * Esta funcao so impede que um tipo absurdo desca pelas camadas.
 */
function cursorDaEntrada(bruto: unknown): { criadoEm: string; requestId: string } | null | "invalido" {
  if (bruto === undefined || bruto === null) return null;
  if (typeof bruto !== "object" || Array.isArray(bruto)) return "invalido";

  // O payload vem de `JSON.parse`, entao `Object.keys` cobre exatamente
  // as proprias enumeraveis — nao ha herdada a defender aqui.
  for (const chave of Object.keys(bruto)) {
    if (!CAMPOS_CURSOR_ACEITOS.has(chave)) return "invalido";
  }

  const { criadoEm, requestId } = bruto as { criadoEm?: unknown; requestId?: unknown };
  if (typeof criadoEm !== "string" || typeof requestId !== "string") return "invalido";

  return { criadoEm, requestId };
}

export async function POST(request: Request) {
  // Mesma fronteira das outras rotas operacionais do projeto. Se a
  // sessao nao vale, o observador NAO e chamado — a resposta nao pode
  // depender de haver ou nao stale.
  const auth = await autenticarRequisicao(request);
  if (!auth.autenticado) {
    return NextResponse.json({ ok: false, erro: "Sessao invalida." }, { status: 401 });
  }
  const userId = auth.uid; // UNICA origem do usuario. Nunca do body.

  // Corpo ausente ou ilegivel vale como "sem cursor" — mas JSON quebrado
  // e um erro do chamador, e por isso e distinguido de corpo vazio.
  const texto = await request.text().catch(() => "");
  let corpo: unknown = {};
  if (texto.trim().length > 0) {
    try {
      corpo = JSON.parse(texto);
    } catch {
      return erro(400, "entrada_invalida");
    }
  }

  if (typeof corpo !== "object" || corpo === null || Array.isArray(corpo)) {
    return erro(400, "entrada_invalida");
  }

  // Campo desconhecido RECUSA. `userId` no corpo cai aqui, e e o ponto
  // em que a fronteira de tenant fica visivel para quem tentou.
  for (const chave of Object.keys(corpo)) {
    if (!CAMPOS_ACEITOS.has(chave)) return erro(400, "entrada_invalida");
  }

  const cursor = cursorDaEntrada((corpo as { cursor?: unknown }).cursor);
  if (cursor === "invalido") return erro(400, "entrada_invalida");

  const resumo = await observarAberturasStaleDoUsuario({ userId, cursorInicial: cursor });

  // ── 200 exige `ok` DECLARADO, nao "sobrou" ────────────────────────
  //
  // Antes as falhas eram tratadas por `if` e o retorno final assumia
  // sucesso. Funcionava — a uniao tem quatro membros e tres eram
  // tratados —, mas era fail-open na extensao: acrescentar uma variante
  // em `ColetaObservacao` nao quebraria o `tsc` desta rota, e a variante
  // nova sairia como 200 com um resumo que nao e `ok`. O `switch` com
  // `default` inverte isso: o que ninguem tratou vira erro, nao sucesso.
  switch (resumo.coleta) {
    case "ok":
      return NextResponse.json({ ok: true, resumo }, { status: 200 });

    case "falha_leitura":
      // Nao e diagnostico: e ausencia de diagnostico. Responder 200 aqui
      // faria "nao consegui olhar" parecer "nao ha nada".
      return erro(503, "falha_leitura", { paginas: resumo.paginas });

    case "entrada_invalida":
      return erro(400, "entrada_invalida");

    case "contrato_invalido":
      // Cursor que nao avanca: defeito entre as nossas camadas, nao do
      // chamador. Nada do erro interno viaja no corpo.
      return erro(500, "contrato_invalido");

    default:
      // Inalcancavel pelo tipo hoje. Existe para o dia em que deixar de
      // ser — e nao ecoa o valor recebido, que e estado interno.
      return erro(500, "erro_interno");
  }
}
