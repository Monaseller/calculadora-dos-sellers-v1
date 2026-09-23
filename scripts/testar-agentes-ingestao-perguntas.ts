/**
 * `sincronizar_perguntas` — suite do I1.
 *
 * Prova a FRONTEIRA DE DOMINIO do serviço de ingestão: de onde vem a
 * autoridade, qual Função é executada, o que é apto a virar item de
 * trabalho, e o que o serviço deliberadamente NÃO faz.
 *
 * ── Sem banco, sem rede, sem marketplace ────────────────────────────
 *
 * As duas portas do serviço (`lerAgente`, `executar`) são injetadas por
 * duplos que REGISTRAM o que receberam. Não é conveniência: o que
 * interessa aqui é justamente o que o serviço PASSA para o executor —
 * e isso só se observa interceptando a chamada.
 *
 * O caminho real continua sendo o padrão do serviço. Esquecer de injetar
 * não silencia nada: executa de verdade.
 *
 * Rodar:  npx tsx scripts/testar-agentes-ingestao-perguntas.ts
 */
// PRIMEIRO import, antes de qualquer coisa do `lib/`: torna `server-only`
// inerte sob `tsx`. Mesma convencao das demais suites do repositorio.
import "./_server-only-inerte";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { acoesRegistradas, resolverAcao } from "@/lib/agentes/acoes/catalogo";
import { normalizarPergunta, type PerguntaRecebida } from "@/lib/agentes/dados/perguntas";
import { FUNCAO_ID as FUNCAO_PERGUNTAS_ML } from "@/lib/agentes/handlers/consultar-perguntas-ml-contrato";
import {
  ACAO_SINCRONIZAR_PERGUNTAS,
  FILTRO_PAGINA_UNICA,
  sincronizarPerguntas,
  type PortasSincronizacao,
} from "@/lib/agentes/ingestao/sincronizar-perguntas";

let passou = 0;
let falhou = 0;

function ok(nome: string, condicao: boolean, detalhe = ""): void {
  if (condicao) {
    passou += 1;
    console.log(`  PASS  ${nome}`);
  } else {
    falhou += 1;
    console.log(`  FAIL  ${nome}${detalhe ? `  — ${detalhe}` : ""}`);
  }
}

function secao(titulo: string): void {
  console.log(`\n── ${titulo} ${"─".repeat(Math.max(2, 62 - titulo.length))}`);
}

const RAIZ = join(__dirname, "..");
const ler = (rel: string) => readFileSync(join(RAIZ, rel), "utf8");
/** Só linha EXECUTAVEL. Comentario nao prova nem refuta invariante —
 *  duas asserções desta suite nasceram casando com a propria prosa. */
const lerCodigo = (rel: string) =>
  ler(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const AGENTE = "11111111-1111-4111-8111-111111111111";
const DONO = "aaaaaaaa-0000-4000-8000-0000000000d1";

const pergunta = (
  over: Partial<PerguntaRecebida> = {}
): PerguntaRecebida => ({
  id: "Q1",
  anuncioId: "MLB1",
  texto: "Acompanha manual?",
  status: "UNANSWERED",
  criadaEm: "2026-09-20T10:00:00.000-04:00",
  ...over,
});

/** O que o executor recebeu. É isto que as provas de autoridade leem. */
interface Espiao {
  chamadas: Array<Record<string, unknown>>;
  agentesLidos: string[];
  gravacoes: Array<{ autoridade: Record<string, unknown>; linhas: unknown[] }>;
}

function portasFalsas(
  resposta: unknown,
  opcoes: {
    agente?: { agenteId: string; userId: string; ativo: boolean } | null;
    erro?: string | null;
    gravacao?: unknown;
  } = {}
): { portas: PortasSincronizacao; espiao: Espiao } {
  const espiao: Espiao = { chamadas: [], agentesLidos: [], gravacoes: [] };
  const agente =
    opcoes.agente === undefined ? { agenteId: AGENTE, userId: DONO, ativo: true } : opcoes.agente;

  const portas = {
    lerAgente: async (agenteId: string) => {
      espiao.agentesLidos.push(agenteId);
      return { agente, erro: opcoes.erro ?? null };
    },
    executar: async (entrada: Record<string, unknown>) => {
      espiao.chamadas.push(entrada);
      return resposta;
    },
    gravar: async (autoridade: Record<string, unknown>, linhas: unknown[]) => {
      espiao.gravacoes.push({ autoridade, linhas });
      return opcoes.gravacao ?? {
        tipo: "gravado",
        metricas: {
          recebidas: linhas.length, unicas: linhas.length, duplicadas_no_lote: 0,
          novas: linhas.length, atualizadas: 0, reobservadas: 0,
        },
      };
    },
  } as unknown as PortasSincronizacao;

  return { portas, espiao };
}

const LOJA = "cccccccc-0000-4000-8000-0000000000e1";

const sucessoCom = (
  linhas: PerguntaRecebida[], truncado = false, lojaId: string | null = LOJA
) => ({
  tipo: "sucesso" as const,
  requestId: "req-1",
  envelope: { data: { linhas, truncado, erro: null } },
  autoridade: { lojaId },
});

async function main(): Promise<void> {
  console.log("\n══ CDS IA — sincronizar_perguntas: fronteira de dominio (I1) ══");

  // ─── A. Autoridade ──────────────────────────────────────────────────
  secao("A. Autoridade — o chamador nao escolhe dono nem conta");

  {
    const { portas, espiao } = portasFalsas(sucessoCom([pergunta()]));
    await sincronizarPerguntas({ agenteId: AGENTE }, portas);
    const chamada = espiao.chamadas[0] ?? {};

    ok("A1  o agente e resolvido no banco, pelo id recebido",
      espiao.agentesLidos.length === 1 && espiao.agentesLidos[0] === AGENTE);
    ok("A2  `userId` passado ao executor vem do AGENTE",
      chamada.userId === DONO);
    ok("A3  o servico nao repassa `lojaId` — a conta vem do binding",
      !("lojaId" in chamada));
    ok("A4  o servico nao repassa `sellerId` nem credencial",
      !("sellerId" in chamada) && !("credencial" in chamada) && !("token" in chamada));
    ok("A5  nenhum campo alem do contrato do executor viaja",
      Object.keys(chamada).sort().join(",") === "agenteId,argumentos,funcaoId,userId",
      Object.keys(chamada).sort().join(","));
  }

  {
    // Chave estranha na entrada nao vira autoridade: o servico so le
    // `agenteId` e `idempotencyKey`, e TypeScript ja recusaria o resto.
    const { portas, espiao } = portasFalsas(sucessoCom([]));
    const entradaSuja = { agenteId: AGENTE, userId: "OUTRO", lojaId: "OUTRA" } as unknown as {
      agenteId: string;
    };
    await sincronizarPerguntas(entradaSuja, portas);
    const chamada = espiao.chamadas[0] ?? {};
    ok("A6  `userId` de fora e IGNORADO — vale o do banco", chamada.userId === DONO);
    ok("A7  `lojaId` de fora nao alcanca o executor", !("lojaId" in chamada));
  }

  {
    const fonte = ler("lib/agentes/ingestao/sincronizar-perguntas.ts");
    const semComentario = fonte.replace(/^\s*(\/\*[\s\S]*?\*\/|\*.*|\/\/.*)$/gm, "");
    ok("A8  o servico nao le `lojaId` de argumento nem de entrada",
      !/entrada\.lojaId|argumentos\.lojaId|p\.lojaId/.test(semComentario));
    const blocoEntrada = fonte.slice(
      fonte.indexOf("interface EntradaSincronizarPerguntas"),
      fonte.indexOf("}", fonte.indexOf("interface EntradaSincronizarPerguntas")));
    ok("A9  a entrada publica do servico nao declara `userId` nem `lojaId`",
      !/\b(userId|lojaId|sellerId)\b/.test(blocoEntrada), blocoEntrada.replace(/\s+/g, " "));
  }

  // ─── B. Execucao da Funcao ──────────────────────────────────────────
  secao("B. Execucao — exatamente a Funcao de leitura, e por ela");

  {
    const { portas, espiao } = portasFalsas(sucessoCom([]));
    await sincronizarPerguntas({ agenteId: AGENTE }, portas);
    const chamada = espiao.chamadas[0] ?? {};

    ok("B1  executa exatamente `mercadolivre.perguntas.listar`",
      chamada.funcaoId === FUNCAO_PERGUNTAS_ML, String(chamada.funcaoId));
    ok("B2  UMA pagina: status UNANSWERED, limite 50, deslocamento 0",
      JSON.stringify(chamada.argumentos) === JSON.stringify(FILTRO_PAGINA_UNICA),
      JSON.stringify(chamada.argumentos));
    ok("B3  o executor e chamado UMA unica vez no I1", espiao.chamadas.length === 1);
    ok("B4  sem `idempotencyKey`, a chave nao e inventada",
      !("idempotencyKey" in chamada));
  }

  {
    const { portas, espiao } = portasFalsas(sucessoCom([]));
    await sincronizarPerguntas({ agenteId: AGENTE, idempotencyKey: "n8n:op:acao:ag" }, portas);
    ok("B5  quando a chave e fornecida, ela atravessa intacta",
      (espiao.chamadas[0] ?? {}).idempotencyKey === "n8n:op:acao:ag");
  }

  {
    const fonte = ler("lib/agentes/ingestao/sincronizar-perguntas.ts");
    const codigo = lerCodigo("lib/agentes/ingestao/sincronizar-perguntas.ts");
    ok("B6  o servico NAO importa o adapter do marketplace",
      !/mercado-livre-perguntas|buscarPerguntasRecebidasML/.test(codigo));
    ok("B7  o servico NAO importa cliente de banco",
      !/getSupabaseServidor|from\s+["']pg["']|supabase-js/.test(fonte));
    ok("B8  a Funcao vem do CONTRATO, nao de literal redigitado",
      /FUNCAO_ID as FUNCAO_PERGUNTAS_ML/.test(fonte)
      && !/"mercadolivre\.perguntas\.listar"/.test(fonte));
  }

  // ─── C. Desfechos do executor ───────────────────────────────────────
  secao("C. Desfechos — recusa e falha atravessam, nunca viram sucesso");

  {
    const { portas } = portasFalsas({
      tipo: "negado", requestId: "req-n", codigo: "permissao_ausente",
    });
    const r = await sincronizarPerguntas({ agenteId: AGENTE }, portas);
    ok("C1  negacao de permissao propaga com o codigo do guard",
      r.tipo === "negado" && r.codigo === "permissao_ausente");
  }
  {
    const { portas } = portasFalsas({
      tipo: "erro", requestId: "req-e", envelope: { error: { code: "limite_excedido" } },
    });
    const r = await sincronizarPerguntas({ agenteId: AGENTE }, portas);
    ok("C2  erro do provider propaga SO o codigo",
      r.tipo === "erro" && r.codigo === "limite_excedido");
  }
  {
    const { portas } = portasFalsas({ tipo: "falha_auditoria", requestId: "r", motivo: "duplicada" });
    const r = await sincronizarPerguntas({ agenteId: AGENTE }, portas);
    ok("C3  abertura duplicada vira `ja_processado`, nunca coleta vazia",
      r.tipo === "ja_processado");
  }
  {
    const { portas } = portasFalsas(sucessoCom([]), { agente: null });
    const r = await sincronizarPerguntas({ agenteId: AGENTE }, portas);
    ok("C4  agente inexistente/alheio nao executa nada",
      r.tipo === "agente_indisponivel" && r.motivo === "inexistente");
  }
  {
    const { portas, espiao } = portasFalsas(sucessoCom([]), {
      agente: { agenteId: AGENTE, userId: DONO, ativo: false },
    });
    const r = await sincronizarPerguntas({ agenteId: AGENTE }, portas);
    ok("C5  agente inativo nao executa Funcao alguma",
      r.tipo === "agente_indisponivel" && r.motivo === "inativo" && espiao.chamadas.length === 0);
  }
  {
    const { portas } = portasFalsas({ tipo: "sucesso", requestId: "r", envelope: { data: { fora: 1 } } });
    const r = await sincronizarPerguntas({ agenteId: AGENTE }, portas);
    ok("C6  resposta fora de forma falha FECHADA, nao vira lote vazio",
      r.tipo === "erro" && r.codigo === "resposta_fora_de_forma");
  }

  // ─── D. Filtro de ingestao ──────────────────────────────────────────
  secao("D. Ingestao — o que esta APTO a virar item de trabalho");

  {
    const { portas } = portasFalsas(sucessoCom([]));
    const r = await sincronizarPerguntas({ agenteId: AGENTE }, portas);
    ok("D1  zero perguntas e coleta valida, nao erro",
      r.tipo === "sincronizado" && r.perguntas.length === 0
      && r.metricas.recebidas === 0 && r.metricas.ingeriveis === 0);
  }
  {
    const { portas } = portasFalsas(sucessoCom([pergunta()]));
    const r = await sincronizarPerguntas({ agenteId: AGENTE }, portas);
    ok("D2  uma pergunta valida e ingerivel",
      r.tipo === "sincronizado" && r.metricas.ingeriveis === 1 && r.perguntas[0].id === "Q1");
  }
  {
    const { portas } = portasFalsas(sucessoCom([pergunta({ status: "ANSWERED" })]));
    const r = await sincronizarPerguntas({ agenteId: AGENTE }, portas);
    ok("D3  status inesperado e CONTADO e excluido, nunca vira item novo",
      r.tipo === "sincronizado" && r.metricas.status_inesperados === 1
      && r.metricas.ingeriveis === 0 && r.perguntas.length === 0);
  }
  for (const [rotulo, data] of [
    ["texto solto", "ontem"],
    ["sem fuso", "2026-09-20T10:00:00"],
    ["so a data", "2026-09-20"],
    ["mes impossivel", "2026-13-20T10:00:00Z"],
    ["vazia", ""],
  ] as const) {
    const { portas } = portasFalsas(sucessoCom([pergunta({ criadaEm: data })]));
    const r = await sincronizarPerguntas({ agenteId: AGENTE }, portas);
    ok(`D4  data invalida (${rotulo}) e descartada, nao derruba a varredura`,
      r.tipo === "sincronizado" && r.metricas.descartadas === 1 && r.metricas.ingeriveis === 0);
  }
  for (const data of [
    "2026-09-20T10:00:00.000-04:00",
    "2026-09-20T10:00:00Z",
    "2026-09-20T10:00:00-0400",
  ]) {
    const { portas } = portasFalsas(sucessoCom([pergunta({ criadaEm: data })]));
    const r = await sincronizarPerguntas({ agenteId: AGENTE }, portas);
    ok(`D5  data ISO com fuso (${data}) e aceita`,
      r.tipo === "sincronizado" && r.metricas.ingeriveis === 1);
  }
  {
    const linhas = [
      pergunta({ id: "A" }),
      pergunta({ id: "B", status: "DELETED" }),
      pergunta({ id: "C", criadaEm: "ontem" }),
      pergunta({ id: "D" }),
    ];
    const { portas } = portasFalsas(sucessoCom(linhas, true));
    const r = await sincronizarPerguntas({ agenteId: AGENTE }, portas);
    ok("D6  nenhum item observado some da contabilidade",
      r.tipo === "sincronizado"
      && r.metricas.recebidas === 4
      && r.metricas.ingeriveis + r.metricas.descartadas + r.metricas.status_inesperados === 4);
    ok("D7  `providerTruncado` do adapter atravessa",
      r.tipo === "sincronizado" && r.providerTruncado === true);
    ok("D8  `paginas` e 1 — o I1 nao pagina",
      r.tipo === "sincronizado" && r.metricas.paginas === 1);
  }

  // ─── E. O normalizador compartilhado (fronteira anterior) ───────────
  secao("E. Normalizador — descarte de forma acontece ANTES do servico");

  ok("E1  texto vazio nao vira PerguntaRecebida",
    normalizarPergunta({ id: "1", item_id: "M", text: "", status: "UNANSWERED", date_created: "2026-09-20T10:00:00Z" }) === null);
  ok("E2  `id` ausente nao vira PerguntaRecebida",
    normalizarPergunta({ item_id: "M", text: "t", status: "UNANSWERED", date_created: "2026-09-20T10:00:00Z" }) === null);
  ok("E3  `item_id` ausente nao vira PerguntaRecebida",
    normalizarPergunta({ id: "1", text: "t", status: "UNANSWERED", date_created: "2026-09-20T10:00:00Z" }) === null);
  ok("E4  item completo vira PerguntaRecebida",
    normalizarPergunta({ id: 1, item_id: 2, text: "t", status: "UNANSWERED", date_created: "2026-09-20T10:00:00Z" }) !== null);

  // ─── F. O que este gate NAO fez ─────────────────────────────────────
  secao("F. Contencao — nada disto foi exposto nem persistido");

  {
    const fonte = ler("lib/agentes/ingestao/sincronizar-perguntas.ts");
    const codigo = lerCodigo("lib/agentes/ingestao/sincronizar-perguntas.ts");
    ok("F1  o servico nao conhece o nome da RPC — quem grava e o cliente",
      !/agente_perguntas_ml_upsert_lote/.test(codigo));
    ok("F2  o servico nao nomeia a tabela da inbox",
      !/agente_perguntas_ml/.test(codigo));
    ok("F3  `sincronizar_perguntas` NAO esta no catalogo de acoes",
      resolverAcao(ACAO_SINCRONIZAR_PERGUNTAS) === null);
    ok("F4  o catalogo segue com as duas acoes de leitura, e so elas",
      [...acoesRegistradas()].sort().join(",") === "consultar_perguntas,consultar_vendas",
      [...acoesRegistradas()].sort().join(","));
    ok("F5  a rota da ponte nao menciona a acao de ingestao",
      !/sincronizar_perguntas/.test(ler("app/api/internal/agentes/acoes/route.ts")));
    ok("F6  nenhuma migration nova entrou nesta frente",
      !/20261010|20261011/.test(ler("lib/agentes/ingestao/sincronizar-perguntas.ts")));
  }

  // ─── G. Handoff de autoridade: buscar e gravar na MESMA conta ───────
  secao("G. Handoff — a conta que gravou e a conta que leu");

  {
    const { portas, espiao } = portasFalsas(sucessoCom([pergunta()]));
    const r = await sincronizarPerguntas({ agenteId: AGENTE }, portas);

    ok("G1  a gravacao usa o `lojaId` devolvido pela PROPRIA execucao",
      espiao.gravacoes.length === 1 && espiao.gravacoes[0].autoridade.lojaId === LOJA,
      JSON.stringify(espiao.gravacoes[0]?.autoridade));
    ok("G2  a gravacao usa o `userId` do AGENTE, nunca do chamador",
      espiao.gravacoes[0].autoridade.userId === DONO);
    ok("G3  a autoridade tem exatamente dois campos",
      Object.keys(espiao.gravacoes[0].autoridade).sort().join(",") === "lojaId,userId");
    ok("G4  a linha enviada tem exatamente as cinco chaves da RPC",
      Object.keys((espiao.gravacoes[0].linhas[0] ?? {}) as object).sort().join(",")
        === "anuncio_id_externo,criada_em_provider,id_externo,provider_status,texto",
      Object.keys((espiao.gravacoes[0].linhas[0] ?? {}) as object).sort().join(","));
    ok("G5  a linha NAO carrega autoridade propria",
      !("user_id" in (espiao.gravacoes[0].linhas[0] as object))
      && !("loja_id" in (espiao.gravacoes[0].linhas[0] as object)));
    ok("G6  o resultado traz as metricas da RPC, alem das da ingestao",
      r.tipo === "sincronizado" && r.persistencia.novas === 1 && r.metricas.ingeriveis === 1);
  }

  {
    // A conta da gravacao NAO pode vir de uma segunda resolucao: se a
    // execucao devolveu outra loja, e essa outra que vale.
    const OUTRA = "dddddddd-0000-4000-8000-0000000000e2";
    const { portas, espiao } = portasFalsas(sucessoCom([pergunta()], false, OUTRA));
    await sincronizarPerguntas({ agenteId: AGENTE }, portas);
    ok("G7  trocar a loja da execucao troca a loja da gravacao — nao ha 2a resolucao",
      espiao.gravacoes[0].autoridade.lojaId === OUTRA);
  }

  {
    const codigo = lerCodigo("lib/agentes/ingestao/sincronizar-perguntas.ts");
    const atribuicoes = codigo.match(/\blojaId\s*=(?!=)/g) ?? [];
    ok("G8  ha UMA unica origem de `lojaId` no servico", atribuicoes.length === 1,
      String(atribuicoes.length));
    ok("G9  e essa origem e `resultado.autoridade`",
      /const\s+lojaId\s*=\s*resultado\.autoridade\.lojaId;/.test(codigo));
    ok("G10 o servico nao resolve binding nem conexao por conta propria",
      !/resolverConexoesDoAgente|resolverFatoConexao|agente_conexoes|bindings/.test(codigo));
  }

  {
    // Funcao sem conexao devolveria `lojaId: null`. Gravar "em lugar
    // nenhum" nao existe: falha fechada.
    const { portas, espiao } = portasFalsas(sucessoCom([pergunta()], false, null));
    const r = await sincronizarPerguntas({ agenteId: AGENTE }, portas);
    ok("G11 sem autoridade de loja, NAO grava e falha fechada",
      r.tipo === "erro" && r.codigo === "autoridade_ausente" && espiao.gravacoes.length === 0);
  }

  // ─── H. Caminhos de falha: a RPC nunca e chamada a toa ──────────────
  secao("H. Falha — provider ruim nao vira gravacao");

  for (const [rotulo, resposta] of [
    ["negado", { tipo: "negado", requestId: "r", codigo: "permissao_ausente" }],
    ["erro de provider", { tipo: "erro", requestId: "r", envelope: { error: { code: "indisponivel" } } }],
    ["indisponivel", { tipo: "indisponivel", requestId: "r" }],
    ["aguardando aprovacao", { tipo: "aguardando_aprovacao", requestId: "r", aprovacaoId: "a1" }],
    ["ja processado", { tipo: "falha_auditoria", requestId: "r", motivo: "duplicada" }],
  ] as const) {
    const { portas, espiao } = portasFalsas(resposta);
    await sincronizarPerguntas({ agenteId: AGENTE }, portas);
    ok(`H1  ${rotulo}: a RPC da inbox NAO e chamada`, espiao.gravacoes.length === 0);
  }

  {
    const { portas, espiao } = portasFalsas(sucessoCom([]), {
      agente: { agenteId: AGENTE, userId: DONO, ativo: false },
    });
    await sincronizarPerguntas({ agenteId: AGENTE }, portas);
    ok("H2  agente inativo: nem executa Funcao, nem grava",
      espiao.chamadas.length === 0 && espiao.gravacoes.length === 0);
  }

  {
    const { portas } = portasFalsas(sucessoCom([pergunta()]), {
      gravacao: { tipo: "recusado", codigo: "42501" },
    });
    const r = await sincronizarPerguntas({ agenteId: AGENTE }, portas);
    ok("H3  recusa de contrato da RPC vira `persistencia_recusada`, nunca sucesso",
      r.tipo === "persistencia_recusada" && r.codigo === "42501");
  }

  {
    const { portas } = portasFalsas(sucessoCom([pergunta()]), {
      gravacao: { tipo: "erro", codigo: "falha_rpc" },
    });
    const r = await sincronizarPerguntas({ agenteId: AGENTE }, portas);
    ok("H4  falha da RPC vira ERRO — provider ok e banco nao e erro, nao sucesso",
      r.tipo === "erro" && r.codigo === "falha_rpc");
  }

  {
    // Pagina vazia AINDA chama a RPC: e assim que a guarda de tenant roda
    // em toda sincronizacao, e nao so quando ha pergunta.
    const { portas, espiao } = portasFalsas(sucessoCom([]));
    const r = await sincronizarPerguntas({ agenteId: AGENTE }, portas);
    ok("H5  pagina vazia chama a RPC com lote vazio",
      espiao.gravacoes.length === 1 && espiao.gravacoes[0].linhas.length === 0);
    ok("H6  e as metricas continuam vindo de UMA fonte",
      r.tipo === "sincronizado" && r.persistencia.novas === 0 && r.metricas.ingeriveis === 0);
  }

  {
    const { portas, espiao } = portasFalsas(sucessoCom([
      pergunta({ id: "A" }),
      pergunta({ id: "B", status: "ANSWERED" }),
      pergunta({ id: "C", criadaEm: "ontem" }),
    ]));
    await sincronizarPerguntas({ agenteId: AGENTE }, portas);
    const enviadas = espiao.gravacoes[0].linhas as Array<{ id_externo: string }>;
    ok("H7  status inesperado e data invalida NAO chegam a RPC",
      enviadas.length === 1 && enviadas[0].id_externo === "A");
  }

  {
    const codigo = lerCodigo("lib/agentes/dados/perguntas-inbox.ts");
    ok("H8  o cliente de persistencia nao resolve agente nem binding",
      !/lerAgenteParaAcaoInterna|resolverConexoesDoAgente|executarFuncao/.test(codigo));
    ok("H9  o cliente nao chama marketplace",
      !/mercado-livre|mercadolibre|buscarPerguntasRecebidas/.test(codigo));
    ok("H10 o cliente nao embute chave de servico",
      !/SUPABASE_SERVICE_ROLE_KEY|service_role_key|eyJ/.test(codigo));
    ok("H11 o cliente usa o mecanismo de servidor ja existente",
      /getSupabaseServidor\(\)\.rpc\(/.test(codigo));
    ok("H12 o cliente e `server-only`", /import "server-only";/.test(codigo));
  }

  {
    const { portas } = portasFalsas(sucessoCom([pergunta()]));
    const r = await sincronizarPerguntas({ agenteId: AGENTE }, portas);
    const serializado = JSON.stringify(r);
    ok("H13 o resultado interno nao carrega credencial nem token",
      !/token|senha|secret|service_role|Bearer/i.test(serializado));
  }

  console.log(`\n── placar ${"─".repeat(54)}`);
  console.log(`  PASS ${passou}   FAIL ${falhou}\n`);
  if (falhou > 0) process.exitCode = 1;
}

void main();
