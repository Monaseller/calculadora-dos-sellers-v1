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
  chaveDaPagina,
  deslocamentoDaPagina,
  MAX_JANELA_PROVIDER,
  MAX_PAGINAS,
  PAGE_LIMIT,
  sincronizarPerguntas,
  CUSTO_MINIMO_DE_PAGINA_MS,
  ORCAMENTO_EXTERNO_MS,
  ORCAMENTO_TOTAL_MS,
  RESERVA_FINALIZACAO_MS,
  type EntradaSincronizarPerguntas,
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

/**
 * A chave da TENTATIVA deixou de ser opcional no I3B.
 *
 * Uma por chamada, e distintas entre si: duas chamadas com a mesma
 * chave sao, por definicao, a mesma tentativa — e provar comportamento
 * diferente com tentativas iguais confundiria os dois conceitos.
 */
let sequencia = 0;
const entradaPadrao = (): EntradaSincronizarPerguntas => {
  sequencia += 1;
  return { agenteId: AGENTE, idempotencyKey: `n8n:t${sequencia}:sincronizar_perguntas:ag` };
};

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
  /** O que o registro DURAVEL recebeu, na ordem em que recebeu. */
  aberturas: Array<Record<string, unknown>>;
  desfechos: Array<Record<string, unknown>>;
  /** A ordem GLOBAL dos efeitos. E ela que prova que nada tocou o
   *  provider antes de a acao existir. */
  ordem: string[];
  /** O que o CURSOR duravel recebeu, na ordem. */
  escritasDeCursor: Array<Record<string, unknown>>;
}

/** O cursor que os duplos devolvem quando a escrita "aplica". */
const CURSOR_BASE = {
  agenteId: AGENTE, userId: DONO, lojaId: null,
  proximoDeslocamento: 0, versao: 1,
};

function portasFalsas(
  resposta: unknown,
  opcoes: {
    agente?: { agenteId: string; userId: string; ativo: boolean } | null;
    erro?: string | null;
    gravacao?: unknown;
    abertura?: unknown;
    desfecho?: unknown;
    cursor?: unknown;
    escritaDeCursor?: unknown;
  } = {}
): { portas: PortasSincronizacao; espiao: Espiao } {
  const espiao: Espiao = {
    chamadas: [], agentesLidos: [], gravacoes: [],
    aberturas: [], desfechos: [], ordem: [], escritasDeCursor: [],
  };
  const agente =
    opcoes.agente === undefined ? { agenteId: AGENTE, userId: DONO, ativo: true } : opcoes.agente;

  const portas = {
    lerAgente: async (agenteId: string) => {
      espiao.agentesLidos.push(agenteId);
      espiao.ordem.push("agente");
      return { agente, erro: opcoes.erro ?? null };
    },
    executar: async (entrada: Record<string, unknown>) => {
      espiao.chamadas.push(entrada);
      espiao.ordem.push("provider");
      return resposta;
    },
    gravar: async (autoridade: Record<string, unknown>, linhas: unknown[]) => {
      espiao.gravacoes.push({ autoridade, linhas });
      espiao.ordem.push("rpc");
      return opcoes.gravacao ?? {
        tipo: "gravado",
        metricas: {
          recebidas: linhas.length, unicas: linhas.length, duplicadas_no_lote: 0,
          novas: linhas.length, atualizadas: 0, reobservadas: 0,
        },
      };
    },
    abrirAcao: async (e: Record<string, unknown>) => {
      espiao.aberturas.push(e);
      espiao.ordem.push("abertura");
      return opcoes.abertura ?? { estado: "registrada" };
    },
    fecharAcao: async (e: Record<string, unknown>) => {
      espiao.desfechos.push(e);
      espiao.ordem.push("desfecho");
      return opcoes.desfecho ?? { estado: "registrada" };
    },
    lerCursor: async () => {
      espiao.ordem.push("cursor:ler");
      return opcoes.cursor ?? { estado: "ausente" };
    },
    iniciarCursor: async (e: Record<string, unknown>) => {
      espiao.escritasDeCursor.push({ op: "iniciar", ...e });
      espiao.ordem.push("cursor:iniciar");
      return opcoes.escritaDeCursor ?? { estado: "aplicada", continuacao: CURSOR_BASE };
    },
    avancarCursor: async (c: unknown, lojaId: unknown, deslocamento: unknown) => {
      espiao.escritasDeCursor.push({ op: "avancar", lojaId, deslocamento, esperada: c });
      espiao.ordem.push("cursor:avancar");
      return opcoes.escritaDeCursor ?? { estado: "aplicada", continuacao: CURSOR_BASE };
    },
    reiniciarCursor: async (c: unknown, lojaId: unknown) => {
      espiao.escritasDeCursor.push({ op: "reiniciar", lojaId, esperada: c });
      espiao.ordem.push("cursor:reiniciar");
      return opcoes.escritaDeCursor ?? { estado: "aplicada", continuacao: CURSOR_BASE };
    },
    reapontarCursor: async (c: unknown, lojaId: unknown) => {
      espiao.escritasDeCursor.push({ op: "reapontar", lojaId, esperada: c });
      espiao.ordem.push("cursor:reapontar");
      return opcoes.escritaDeCursor ?? { estado: "aplicada", continuacao: CURSOR_BASE };
    },
  } as unknown as PortasSincronizacao;

  return { portas, espiao };
}

const LOJA = "cccccccc-0000-4000-8000-0000000000e1";

const sucessoCom = (
  linhas: PerguntaRecebida[], truncado = false, lojaId: string | null = LOJA,
  providerRecebidas = linhas.length, descartadasNormalizacao = 0,
  // A saude do ledger de FUNCAO daquela pagina. Vinha faltando no duplo,
  // e um `undefined` aqui faria o servico "nao ver" incompletude nenhuma
  // — o duplo confirmaria o que ele mesmo omitiu.
  auditoria: "completa" | "incompleta" = "completa"
) => ({
  tipo: "sucesso" as const,
  requestId: "req-1",
  envelope: {
    data: { linhas, truncado, erro: null, providerRecebidas, descartadasNormalizacao },
  },
  auditoria,
  autoridade: { lojaId },
});

/** Portas cujo executor responde uma coisa DIFERENTE por pagina. */
function portasPorPagina(
  respostas: unknown[],
  opcoes: {
    gravacao?: unknown; abertura?: unknown; desfecho?: unknown;
    cursor?: unknown; escritaDeCursor?: unknown;
  } = {}
): { portas: PortasSincronizacao; espiao: Espiao } {
  const espiao: Espiao = {
    chamadas: [], agentesLidos: [], gravacoes: [],
    aberturas: [], desfechos: [], ordem: [], escritasDeCursor: [],
  };
  const portas = {
    lerAgente: async (agenteId: string) => {
      espiao.agentesLidos.push(agenteId);
      espiao.ordem.push("agente");
      return { agente: { agenteId: AGENTE, userId: DONO, ativo: true }, erro: null };
    },
    executar: async (entrada: Record<string, unknown>) => {
      const i = espiao.chamadas.length;
      espiao.chamadas.push(entrada);
      espiao.ordem.push("provider");
      return respostas[i] ?? respostas[respostas.length - 1];
    },
    gravar: async (autoridade: Record<string, unknown>, linhas: unknown[]) => {
      espiao.gravacoes.push({ autoridade, linhas });
      espiao.ordem.push("rpc");
      return opcoes.gravacao ?? {
        tipo: "gravado",
        metricas: {
          recebidas: linhas.length, unicas: linhas.length, duplicadas_no_lote: 0,
          novas: linhas.length, atualizadas: 0, reobservadas: 0,
        },
      };
    },
    abrirAcao: async (e: Record<string, unknown>) => {
      espiao.aberturas.push(e);
      espiao.ordem.push("abertura");
      return opcoes.abertura ?? { estado: "registrada" };
    },
    fecharAcao: async (e: Record<string, unknown>) => {
      espiao.desfechos.push(e);
      espiao.ordem.push("desfecho");
      return opcoes.desfecho ?? { estado: "registrada" };
    },
    lerCursor: async () => {
      espiao.ordem.push("cursor:ler");
      return opcoes.cursor ?? { estado: "ausente" };
    },
    iniciarCursor: async (e: Record<string, unknown>) => {
      espiao.escritasDeCursor.push({ op: "iniciar", ...e });
      espiao.ordem.push("cursor:iniciar");
      return opcoes.escritaDeCursor ?? { estado: "aplicada", continuacao: CURSOR_BASE };
    },
    avancarCursor: async (c: unknown, lojaId: unknown, deslocamento: unknown) => {
      espiao.escritasDeCursor.push({ op: "avancar", lojaId, deslocamento, esperada: c });
      espiao.ordem.push("cursor:avancar");
      return opcoes.escritaDeCursor ?? { estado: "aplicada", continuacao: CURSOR_BASE };
    },
    reiniciarCursor: async (c: unknown, lojaId: unknown) => {
      espiao.escritasDeCursor.push({ op: "reiniciar", lojaId, esperada: c });
      espiao.ordem.push("cursor:reiniciar");
      return opcoes.escritaDeCursor ?? { estado: "aplicada", continuacao: CURSOR_BASE };
    },
    reapontarCursor: async (c: unknown, lojaId: unknown) => {
      espiao.escritasDeCursor.push({ op: "reapontar", lojaId, esperada: c });
      espiao.ordem.push("cursor:reapontar");
      return opcoes.escritaDeCursor ?? { estado: "aplicada", continuacao: CURSOR_BASE };
    },
  } as unknown as PortasSincronizacao;
  return { portas, espiao };
}

async function main(): Promise<void> {
  console.log("\n══ CDS IA — sincronizar_perguntas: fronteira de dominio (I1) ══");

  // ─── A. Autoridade ──────────────────────────────────────────────────
  secao("A. Autoridade — o chamador nao escolhe dono nem conta");

  {
    const { portas, espiao } = portasFalsas(sucessoCom([pergunta()]));
    await sincronizarPerguntas(entradaPadrao(), portas);
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
      // `controleTempo` entrou no I4B3. Ele e INTERNO — criado pelo
      // servico, nunca recebido — e por isso pertence a este contrato,
      // ao contrario de `lojaId` ou `userId`, que seguem de fora.
      Object.keys(chamada).sort().join(",")
        === "agenteId,argumentos,controleTempo,funcaoId,idempotencyKey,userId",
      Object.keys(chamada).sort().join(","));
  }

  {
    // Chave estranha na entrada nao vira autoridade: o servico so le
    // `agenteId` e `idempotencyKey`, e TypeScript ja recusaria o resto.
    const { portas, espiao } = portasFalsas(sucessoCom([]));
    const entradaSuja = {
      agenteId: AGENTE, idempotencyKey: "n8n:suja:sincronizar_perguntas:ag",
      userId: "OUTRO", lojaId: "OUTRA",
    } as unknown as EntradaSincronizarPerguntas;
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
    await sincronizarPerguntas(entradaPadrao(), portas);
    const chamada = espiao.chamadas[0] ?? {};

    ok("B1  executa exatamente `mercadolivre.perguntas.listar`",
      chamada.funcaoId === FUNCAO_PERGUNTAS_ML, String(chamada.funcaoId));
    ok("B2  UMA pagina: status UNANSWERED, limite 50, deslocamento 0",
      JSON.stringify(chamada.argumentos)
        === JSON.stringify({ status: "UNANSWERED", limite: PAGE_LIMIT, deslocamento: 0 }),
      JSON.stringify(chamada.argumentos));
    ok("B3  o executor e chamado UMA unica vez no I1", espiao.chamadas.length === 1);
    // Antes do I3B a chave era opcional e este invariante dizia "sem
    // chave, nenhuma chave e inventada". Agora ela e obrigatoria, e o
    // que precisa ser provado e o oposto: a chave da pagina SEMPRE
    // deriva da chave da tentativa, sem sorteio no meio.
    ok("B4  a chave da pagina deriva da chave da TENTATIVA",
      typeof chamada.idempotencyKey === "string"
      && (chamada.idempotencyKey as string).endsWith(":p0"),
      String(chamada.idempotencyKey));
  }

  {
    const { portas, espiao } = portasFalsas(sucessoCom([]));
    await sincronizarPerguntas({ agenteId: AGENTE, idempotencyKey: "n8n:op:acao:ag" }, portas);
    ok("B5  a chave da tentativa vira chave da PAGINA",
      (espiao.chamadas[0] ?? {}).idempotencyKey === "n8n:op:acao:ag:p0");
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
    const r = await sincronizarPerguntas(entradaPadrao(), portas);
    ok("C1  negacao de permissao propaga com o codigo do guard",
      r.tipo === "negado" && r.codigo === "permissao_ausente");
  }
  {
    const { portas } = portasFalsas({
      tipo: "erro", requestId: "req-e", envelope: { error: { code: "limite_excedido" } },
    });
    const r = await sincronizarPerguntas(entradaPadrao(), portas);
    ok("C2  erro do provider propaga SO o codigo",
      r.tipo === "erro" && r.codigo === "limite_excedido");
  }
  {
    // `ja_processado` MUDOU DE DONO no I3B. Antes ele nascia da
    // idempotencia de FUNCAO (`falha_auditoria` com `duplicada`); agora
    // nasce da idempotencia de ACAO, e a de Funcao virou invariante
    // quebrado — a chave de pagina deriva da chave da tentativa, entao a
    // repeticao colide na ABERTURA, antes do provider. Chegar aqui e
    // sinal de bug, e a resposta e fechada, nunca silencio.
    const { portas, espiao } = portasFalsas(
      { tipo: "falha_auditoria", requestId: "r", etapa: "abertura", motivo: "duplicada" });
    const r = await sincronizarPerguntas(entradaPadrao(), portas);
    ok("C3  `duplicada` de FUNCAO nao e mais `ja_processado` — e erro fechado",
      r.tipo === "erro" && r.codigo === "falha_auditoria" && r.origem === "auditoria_funcao"
      && espiao.gravacoes.length === 0,
      r.tipo);
    ok("C3b e o desfecho registrado e `erro_interno`, porque o invariante quebrou",
      (espiao.desfechos[0] ?? {}).status === "erro"
      && (espiao.desfechos[0] ?? {}).codigo === "erro_interno",
      JSON.stringify(espiao.desfechos[0] ?? {}));
  }
  {
    // O `ja_processado` de verdade: a ABERTURA perdeu no indice unico.
    const { portas, espiao } = portasFalsas(sucessoCom([pergunta()]), {
      abertura: { estado: "duplicada" },
    });
    const r = await sincronizarPerguntas(entradaPadrao(), portas);
    ok("C3c tentativa repetida para ANTES do provider e da RPC",
      r.tipo === "ja_processado"
      && espiao.chamadas.length === 0
      && espiao.gravacoes.length === 0
      && espiao.desfechos.length === 0);
  }
  {
    const { portas } = portasFalsas(sucessoCom([]), { agente: null });
    const r = await sincronizarPerguntas(entradaPadrao(), portas);
    ok("C4  agente inexistente/alheio nao executa nada",
      r.tipo === "agente_indisponivel" && r.motivo === "inexistente");
  }
  {
    const { portas, espiao } = portasFalsas(sucessoCom([]), {
      agente: { agenteId: AGENTE, userId: DONO, ativo: false },
    });
    const r = await sincronizarPerguntas(entradaPadrao(), portas);
    ok("C5  agente inativo nao executa Funcao alguma",
      r.tipo === "agente_indisponivel" && r.motivo === "inativo" && espiao.chamadas.length === 0);
  }
  {
    const { portas } = portasFalsas({ tipo: "sucesso", requestId: "r", envelope: { data: { fora: 1 } } });
    const r = await sincronizarPerguntas(entradaPadrao(), portas);
    ok("C6  resposta fora de forma falha FECHADA, nao vira lote vazio",
      r.tipo === "erro" && r.codigo === "resposta_funcao_fora_de_forma"
      && r.origem === "contrato",
      r.tipo === "erro" ? r.codigo : r.tipo);
  }

  // ─── D. Filtro de ingestao ──────────────────────────────────────────
  secao("D. Ingestao — o que esta APTO a virar item de trabalho");

  {
    const { portas } = portasFalsas(sucessoCom([]));
    const r = await sincronizarPerguntas(entradaPadrao(), portas);
    ok("D1  zero perguntas e coleta valida, nao erro",
      r.tipo === "sincronizado" && r.perguntas.length === 0
      && r.metricas.provider_recebidas === 0 && r.metricas.ingeriveis === 0);
  }
  {
    const { portas } = portasFalsas(sucessoCom([pergunta()]));
    const r = await sincronizarPerguntas(entradaPadrao(), portas);
    ok("D2  uma pergunta valida e ingerivel",
      r.tipo === "sincronizado" && r.metricas.ingeriveis === 1 && r.perguntas[0].id === "Q1");
  }
  {
    const { portas } = portasFalsas(sucessoCom([pergunta({ status: "ANSWERED" })]));
    const r = await sincronizarPerguntas(entradaPadrao(), portas);
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
    const r = await sincronizarPerguntas(entradaPadrao(), portas);
    ok(`D4  data invalida (${rotulo}) e descartada, nao derruba a varredura`,
      r.tipo === "sincronizado" && r.metricas.descartadas_ingestao === 1 && r.metricas.ingeriveis === 0);
  }
  for (const data of [
    "2026-09-20T10:00:00.000-04:00",
    "2026-09-20T10:00:00Z",
    "2026-09-20T10:00:00-0400",
  ]) {
    const { portas } = portasFalsas(sucessoCom([pergunta({ criadaEm: data })]));
    const r = await sincronizarPerguntas(entradaPadrao(), portas);
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
    const r = await sincronizarPerguntas(entradaPadrao(), portas);
    ok("D6  nenhum item observado some da contabilidade",
      (r.tipo === "sincronizado" || r.tipo === "backlog_truncado")
      && r.metricas.normalizadas
         === r.metricas.ingeriveis + r.metricas.descartadas_ingestao
            + r.metricas.status_inesperados);
    ok("D7  `providerTruncado` do adapter atravessa",
      (r.tipo === "sincronizado" || r.tipo === "backlog_truncado")
      && r.providerTruncado === true);
    ok("D8  `truncado` na pagina 1 faz a varredura buscar a pagina 2",
      (r.tipo === "sincronizado" || r.tipo === "backlog_truncado")
      && r.metricas.paginas === 2);
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
    const r = await sincronizarPerguntas(entradaPadrao(), portas);

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
    await sincronizarPerguntas(entradaPadrao(), portas);
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
    const r = await sincronizarPerguntas(entradaPadrao(), portas);
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
    await sincronizarPerguntas(entradaPadrao(), portas);
    ok(`H1  ${rotulo}: a RPC da inbox NAO e chamada`, espiao.gravacoes.length === 0);
  }

  {
    const { portas, espiao } = portasFalsas(sucessoCom([]), {
      agente: { agenteId: AGENTE, userId: DONO, ativo: false },
    });
    await sincronizarPerguntas(entradaPadrao(), portas);
    ok("H2  agente inativo: nem executa Funcao, nem grava",
      espiao.chamadas.length === 0 && espiao.gravacoes.length === 0);
  }

  {
    const { portas } = portasFalsas(sucessoCom([pergunta()]), {
      gravacao: { tipo: "recusado", codigo: "42501" },
    });
    const r = await sincronizarPerguntas(entradaPadrao(), portas);
    ok("H3  recusa de contrato da RPC vira `persistencia_recusada`, nunca sucesso",
      r.tipo === "persistencia_recusada" && r.codigo === "42501");
  }

  {
    const { portas } = portasFalsas(sucessoCom([pergunta()]), {
      gravacao: { tipo: "erro", codigo: "falha_rpc" },
    });
    const r = await sincronizarPerguntas(entradaPadrao(), portas);
    ok("H4  falha da RPC vira ERRO — provider ok e banco nao e erro, nao sucesso",
      r.tipo === "erro" && r.codigo === "falha_rpc");
  }

  {
    // Pagina vazia AINDA chama a RPC: e assim que a guarda de tenant roda
    // em toda sincronizacao, e nao so quando ha pergunta.
    const { portas, espiao } = portasFalsas(sucessoCom([]));
    const r = await sincronizarPerguntas(entradaPadrao(), portas);
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
    await sincronizarPerguntas(entradaPadrao(), portas);
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
    const r = await sincronizarPerguntas(entradaPadrao(), portas);
    const serializado = JSON.stringify(r);
    ok("H13 o resultado interno nao carrega credencial nem token",
      !/token|senha|secret|service_role|Bearer/i.test(serializado));
  }

  // ─── I. Paginacao com janela BRUTA ──────────────────────────────────
  secao("I. Paginacao — a janela e do provider, nao do que sobrou");

  {
    // G1: pagina 1 nao encheu -> varredura completa, uma pagina so.
    const { portas, espiao } = portasPorPagina([sucessoCom([pergunta()], false)]);
    const r = await sincronizarPerguntas(entradaPadrao(), portas);
    ok("G1  pagina unica incompleta encerra a varredura",
      r.tipo === "sincronizado" && r.metricas.paginas === 1
      && espiao.chamadas.length === 1 && r.metricas.truncado === false);
    ok("G18 a RPC final e chamada EXATAMENTE uma vez", espiao.gravacoes.length === 1);
    ok("G19 nenhuma escrita por pagina", espiao.gravacoes.length === 1);
  }

  {
    // G2: duas paginas, a segunda incompleta.
    const p1 = Array.from({ length: 50 }, (_, i) => pergunta({ id: `A${i}` }));
    const p2 = [pergunta({ id: "B1" }), pergunta({ id: "B2" })];
    const { portas, espiao } = portasPorPagina([sucessoCom(p1, true), sucessoCom(p2, false)]);
    const r = await sincronizarPerguntas(entradaPadrao(), portas);
    ok("G2  duas paginas: tudo coletado num lote so",
      r.tipo === "sincronizado" && r.metricas.paginas === 2
      && r.metricas.ingeriveis === 52 && espiao.gravacoes[0].linhas.length === 52);
    ok("G8  os deslocamentos sao FIXOS: 0 e 50",
      (espiao.chamadas[0].argumentos as { deslocamento: number }).deslocamento === 0
      && (espiao.chamadas[1].argumentos as { deslocamento: number }).deslocamento === 50);
    ok("G17 a janela do provider nao passa de 100",
      r.tipo === "sincronizado" && r.metricas.provider_recebidas <= MAX_JANELA_PROVIDER);
  }

  {
    // G3: pagina 1 cheia, pagina 2 vazia.
    const p1 = Array.from({ length: 50 }, (_, i) => pergunta({ id: `A${i}` }));
    const { portas, espiao } = portasPorPagina([sucessoCom(p1, true), sucessoCom([], false)]);
    const r = await sincronizarPerguntas(entradaPadrao(), portas);
    ok("G3  pagina 2 vazia encerra sem truncamento",
      r.tipo === "sincronizado" && r.metricas.paginas === 2
      && r.metricas.truncado === false && r.metricas.limite_atingido === false
      && espiao.gravacoes[0].linhas.length === 50);
  }

  {
    // G9: pagina BRUTA cheia, mas quase tudo descartado na normalizacao.
    // Se a decisao usasse o que sobrou, a varredura pararia cedo.
    const { portas, espiao } = portasPorPagina([
      sucessoCom([pergunta({ id: "S1" })], true, LOJA, 50, 49),
      sucessoCom([pergunta({ id: "S2" })], false, LOJA, 1, 0),
    ]);
    const r = await sincronizarPerguntas(entradaPadrao(), portas);
    ok("G9  pagina bruta cheia com descarte ainda busca a proxima",
      espiao.chamadas.length === 2 && r.tipo === "sincronizado");
    ok("G10 a contabilidade separa descarte de normalizacao do de ingestao",
      r.tipo === "sincronizado"
      && r.metricas.provider_recebidas === 51
      && r.metricas.normalizadas === 2
      && r.metricas.descartadas_normalizacao === 49
      && r.metricas.provider_recebidas
         === r.metricas.normalizadas + r.metricas.descartadas_normalizacao);
    ok("G10b e a segunda invariante fecha depois do filtro de ingestao",
      r.tipo === "sincronizado"
      && r.metricas.normalizadas
         === r.metricas.ingeriveis + r.metricas.descartadas_ingestao + r.metricas.status_inesperados);
  }

  {
    // G11: teto batido com o provider ainda indicando backlog.
    const cheia = Array.from({ length: 50 }, (_, i) => pergunta({ id: `X${i}` }));
    const { portas, espiao } = portasPorPagina([
      sucessoCom(cheia, true), sucessoCom(cheia.map((q) => ({ ...q, id: `Y${q.id}` })), true),
    ]);
    const r = await sincronizarPerguntas(entradaPadrao(), portas);
    ok("G11 teto atingido com backlog: PERSISTE e devolve `backlog_truncado`",
      r.tipo === "backlog_truncado" && espiao.gravacoes.length === 1
      && espiao.gravacoes[0].linhas.length === 100);
    ok("G11b `truncado` e `limite_atingido` sao explicitos",
      r.tipo === "backlog_truncado"
      && r.metricas.truncado === true && r.metricas.limite_atingido === true);
    ok("G11c nunca ha terceira pagina",
      espiao.chamadas.length === MAX_PAGINAS);
  }

  {
    // G4/G5: falha na pagina 2 -> ZERO persistencia, pagina 1 nao entra.
    const p1 = Array.from({ length: 50 }, (_, i) => pergunta({ id: `A${i}` }));
    for (const [rotulo, falha] of [
      ["erro de provider", { tipo: "erro", requestId: "r2", envelope: { error: { code: "indisponivel" } } }],
      ["negado", { tipo: "negado", requestId: "r2", codigo: "permissao_ausente" }],
      ["indisponivel", { tipo: "indisponivel", requestId: "r2" }],
      ["envelope fora de forma", { tipo: "sucesso", requestId: "r2", envelope: { data: { fora: 1 } }, autoridade: { lojaId: LOJA } }],
    ] as const) {
      const { portas, espiao } = portasPorPagina([sucessoCom(p1, true), falha]);
      const r = await sincronizarPerguntas(entradaPadrao(), portas);
      ok(`G4  pagina 2 (${rotulo}): ZERO persistencia, pagina 1 nao entra`,
        espiao.gravacoes.length === 0 && r.tipo !== "sincronizado"
        && r.tipo !== "backlog_truncado");
    }
  }

  // ─── J. Autoridade entre paginas ────────────────────────────────────
  secao("J. Autoridade — paginas de contas diferentes nunca se misturam");

  {
    const p1 = Array.from({ length: 50 }, (_, i) => pergunta({ id: `A${i}` }));
    const { portas, espiao } = portasPorPagina([
      sucessoCom(p1, true, LOJA), sucessoCom([pergunta({ id: "B1" })], false, LOJA),
    ]);
    const r = await sincronizarPerguntas(entradaPadrao(), portas);
    ok("G12 autoridade A -> A: gravacao permitida, numa conta so",
      r.tipo === "sincronizado" && espiao.gravacoes.length === 1
      && espiao.gravacoes[0].autoridade.lojaId === LOJA);
  }

  {
    const OUTRA = "dddddddd-0000-4000-8000-0000000000e2";
    const p1 = Array.from({ length: 50 }, (_, i) => pergunta({ id: `A${i}` }));
    const { portas, espiao } = portasPorPagina([
      sucessoCom(p1, true, LOJA), sucessoCom([pergunta({ id: "B1" })], false, OUTRA),
    ]);
    const r = await sincronizarPerguntas(entradaPadrao(), portas);
    ok("G13 autoridade A -> B: falha fechada, ZERO persistencia",
      r.tipo === "autoridade_divergente"
      && r.codigo === "autoridade_divergente_entre_paginas"
      && espiao.gravacoes.length === 0);
    ok("G13b a pagina 1 foi lida, mas nao foi gravada",
      espiao.chamadas.length === 2 && espiao.gravacoes.length === 0);
  }

  // ─── K. Chaves de idempotencia por pagina ───────────────────────────
  secao("K. Chave por pagina — deterministica e distinta");

  ok("G14 paginas diferentes dao chaves DIFERENTES",
    chaveDaPagina("n8n:w5m-X:sincronizar_perguntas:ag", 0)
    !== chaveDaPagina("n8n:w5m-X:sincronizar_perguntas:ag", 1));
  ok("G15 mesma tentativa e mesma pagina dao sempre a MESMA chave",
    chaveDaPagina("n8n:w5m-X:sincronizar_perguntas:ag", 0)
    === chaveDaPagina("n8n:w5m-X:sincronizar_perguntas:ag", 0));
  ok("G16 tentativas diferentes dao chaves diferentes",
    chaveDaPagina("n8n:w5m-X:sincronizar_perguntas:ag", 0)
    !== chaveDaPagina("n8n:w5m-Y:sincronizar_perguntas:ag", 0));
  ok("G14b a chave da tentativa e PREFIXO da chave da pagina",
    chaveDaPagina("BASE", 0).startsWith("BASE"));
  ok("G14c o sufixo cabe folgado no limite pratico da chave",
    chaveDaPagina("n8n:" + "o".repeat(128) + ":sincronizar_perguntas:"
      + "11111111-1111-4111-8111-111111111111", 1).length < 256);

  {
    const { portas, espiao } = portasPorPagina([
      sucessoCom(Array.from({ length: 50 }, (_, i) => pergunta({ id: `A${i}` })), true),
      sucessoCom([], false),
    ]);
    await sincronizarPerguntas({ agenteId: AGENTE, idempotencyKey: "BASE" }, portas);
    ok("G14d cada pagina executa com a SUA chave",
      espiao.chamadas[0].idempotencyKey === "BASE:p0"
      && espiao.chamadas[1].idempotencyKey === "BASE:p1");
  }

  {
    // Sem chave, a acao nao chega nem a existir: nao ha abertura, nao ha
    // provider, nao ha RPC. Antes do I3B isto era um caminho valido que
    // simplesmente nao deduplicava.
    const { portas, espiao } = portasPorPagina([sucessoCom([pergunta()], false)]);
    const r = await sincronizarPerguntas(
      { agenteId: AGENTE, idempotencyKey: "   " }, portas);
    ok("G14e chave em branco para ANTES do provider e ANTES da abertura",
      r.tipo === "chave_ausente"
      && espiao.aberturas.length === 0
      && espiao.chamadas.length === 0
      && espiao.gravacoes.length === 0);
  }

  ok("G17b o deslocamento da pagina n e sempre n * PAGE_LIMIT",
    deslocamentoDaPagina(0) === 0 && deslocamentoDaPagina(1) === PAGE_LIMIT
    && MAX_JANELA_PROVIDER === PAGE_LIMIT * MAX_PAGINAS);

  // --- L. O ciclo de vida da ACAO -------------------------------------
  secao("L. Ciclo de vida — a acao existe antes de o provider ser tocado");

  {
    const { portas, espiao } = portasFalsas(sucessoCom([pergunta()]));
    const r = await sincronizarPerguntas(entradaPadrao(), portas);
    // A ORDEM DE ESCRITA, inteira. Ela nao e estilistica: o cursor vem
    // DEPOIS da inbox porque quebrar entre os dois repete um pedaco
    // (barato, a chave natural absorve) e quebrar na ordem inversa
    // perderia perguntas que nenhuma releitura traria de volta.
    ok("L1  agente > abertura > cursor:ler > provider > rpc > cursor > desfecho",
      espiao.ordem.join(">")
        === "agente>abertura>cursor:ler>provider>rpc>cursor:iniciar>desfecho",
      espiao.ordem.join(">"));
    ok("L1c o cursor e lido ANTES do provider e escrito DEPOIS da inbox",
      espiao.ordem.indexOf("cursor:ler") < espiao.ordem.indexOf("provider")
      && espiao.ordem.indexOf("rpc") < espiao.ordem.indexOf("cursor:iniciar")
      && espiao.ordem.indexOf("cursor:iniciar") < espiao.ordem.indexOf("desfecho"));
    ok("L1b o resultado declara a saude do registro",
      r.tipo === "sincronizado" && r.auditoria === "completa");
  }

  {
    // FAIL_CLOSED_BEFORE_PROVIDER. Uma varredura que o marketplace ve e
    // que nenhum registro menciona e pior que uma que nao aconteceu.
    const { portas, espiao } = portasFalsas(sucessoCom([pergunta()]), {
      abertura: { estado: "falhou" },
    });
    const r = await sincronizarPerguntas(entradaPadrao(), portas);
    ok("L2  abertura que nao grava impede provider E rpc",
      r.tipo === "abertura_falhou"
      && espiao.chamadas.length === 0
      && espiao.gravacoes.length === 0
      && espiao.desfechos.length === 0,
      espiao.ordem.join(">"));
  }

  {
    const { portas, espiao } = portasFalsas(sucessoCom([pergunta()]));
    await sincronizarPerguntas(
      { agenteId: AGENTE, idempotencyKey: "n8n:L3:sincronizar_perguntas:ag" }, portas);
    const ab = espiao.aberturas[0] ?? {};
    ok("L3  a abertura leva o dono do BANCO, a acao e a chave da tentativa",
      ab.userId === DONO && ab.agenteId === AGENTE
      && ab.acaoId === ACAO_SINCRONIZAR_PERGUNTAS
      && ab.idempotencyKey === "n8n:L3:sincronizar_perguntas:ag");
    ok("L3b a abertura NAO carrega loja — a conta ainda nao existe",
      !("lojaId" in ab));
    ok("L3c o `requestId` da acao e gerado no servidor, e nao e a chave",
      typeof ab.requestId === "string" && (ab.requestId as string).length === 36
      && ab.requestId !== ab.idempotencyKey);
  }

  {
    const { portas, espiao } = portasFalsas(sucessoCom([pergunta()]));
    const r = await sincronizarPerguntas(entradaPadrao(), portas);
    const ab = espiao.aberturas[0] ?? {};
    const de = espiao.desfechos[0] ?? {};
    ok("L4  abertura e desfecho compartilham identidade, exceto a loja",
      de.requestId === ab.requestId && de.userId === ab.userId
      && de.agenteId === ab.agenteId && de.acaoId === ab.acaoId);
    ok("L4b o desfecho traz a conta AUTORITATIVA da varredura", de.lojaId === LOJA);
    ok("L4c o servico devolve o `requestId` da ACAO, nao o da Funcao",
      r.tipo === "sincronizado" && r.requestId === ab.requestId
      && r.requestId !== "req-1");
  }

  {
    // O mapa inteiro, uma linha por variante do executor. Nenhum destes
    // pares e derivado de substring: cada ramo de `lerPagina` devolve a
    // classificacao junto com a parada.
    const CASOS: ReadonlyArray<readonly [string, unknown, string, string | null]> = [
      ["negado/permissao_ausente",
        { tipo: "negado", requestId: "r", codigo: "permissao_ausente" },
        "negado", "permissao_ausente"],
      ["negado/conexao_ausente",
        { tipo: "negado", requestId: "r", codigo: "conexao_ausente" },
        "negado", "conexao_ausente"],
      ["aguardando_aprovacao",
        { tipo: "aguardando_aprovacao", requestId: "r", aprovacaoId: "a1" },
        "aguardando_aprovacao", "aprovacao_necessaria"],
      ["indisponivel",
        { tipo: "indisponivel", requestId: "r" },
        "erro", "autoridade_indisponivel"],
      ["erro do provider",
        { tipo: "erro", requestId: "r", envelope: { error: { code: "limite_excedido" } } },
        "erro", "provedor_falhou"],
      ["erro do executor",
        { tipo: "erro", requestId: "r", envelope: { error: { code: "executor_falhou" } } },
        "erro", "provedor_falhou"],
      ["saida invalida da Funcao",
        { tipo: "erro", requestId: "r", envelope: { error: { code: "saida_invalida" } } },
        "erro", "contrato_violado"],
      ["erro interno do executor",
        { tipo: "erro", requestId: "r", envelope: { error: { code: "erro_interno" } } },
        "erro", "erro_interno"],
      ["argumento invalido — defeito NOSSO",
        { tipo: "erro", requestId: "r", envelope: { error: { code: "limite_invalido" } } },
        "erro", "erro_interno"],
      ["ledger de Funcao nao gravou",
        { tipo: "falha_auditoria", requestId: "r", etapa: "desfecho" },
        "erro", "auditoria_funcao_falhou"],
      ["envelope fora de forma",
        { tipo: "sucesso", requestId: "r", auditoria: "completa",
          autoridade: { lojaId: LOJA }, envelope: { data: { fora: 1 } } },
        "erro", "contrato_violado"],
      ["sucesso sem conta autoritativa",
        { tipo: "sucesso", requestId: "r", auditoria: "completa",
          autoridade: { lojaId: null },
          envelope: { data: { linhas: [], truncado: false, erro: null,
            providerRecebidas: 0, descartadasNormalizacao: 0 } } },
        "erro", "contrato_violado"],
    ];
    for (const [rotulo, resposta, status, codigo] of CASOS) {
      const { portas, espiao } = portasFalsas(resposta);
      await sincronizarPerguntas(entradaPadrao(), portas);
      const de = espiao.desfechos[0] ?? {};
      ok(`L5  ${rotulo} -> ${status}/${codigo}`,
        espiao.desfechos.length === 1 && de.status === status && de.codigo === codigo,
        JSON.stringify({ s: de.status, c: de.codigo }));
      ok(`L5b ${rotulo}: a RPC da inbox NAO foi chamada`, espiao.gravacoes.length === 0);
    }
  }

  {
    // A persistencia tem tres codigos distintos, e eles pedem acoes
    // diferentes: religar a conta, investigar o lote, olhar o banco.
    const CASOS: ReadonlyArray<readonly [string, unknown, string]> = [
      ["42501 — a loja nao serve", { tipo: "recusado", codigo: "42501" }, "persistencia_negada"],
      ["22023 — lote recusado", { tipo: "recusado", codigo: "22023" }, "persistencia_recusada"],
      ["25000 — lote incompleto", { tipo: "recusado", codigo: "25000" }, "persistencia_recusada"],
      ["falha da RPC", { tipo: "erro", codigo: "falha_rpc" }, "persistencia_falhou"],
      ["resposta da RPC fora de forma",
        { tipo: "erro", codigo: "resposta_rpc_fora_de_forma" }, "persistencia_falhou"],
    ];
    for (const [rotulo, gravacao, codigo] of CASOS) {
      const { portas, espiao } = portasFalsas(sucessoCom([pergunta()]), { gravacao });
      await sincronizarPerguntas(entradaPadrao(), portas);
      const de = espiao.desfechos[0] ?? {};
      ok(`L6  ${rotulo} -> erro/${codigo}`,
        de.status === "erro" && de.codigo === codigo,
        JSON.stringify({ s: de.status, c: de.codigo }));
      // A regra e UMA: conta so no desfecho que de fato gravou. No 42501
      // ela nem poderia ser escrita — a FK composta e a mesma cerca que
      // a RPC acabou de aplicar.
      ok(`L6b ${rotulo}: o desfecho nao reivindica conta nenhuma`,
        de.lojaId === null, String(de.lojaId));
    }
  }

  {
    // A COLISAO fechada. As duas formas ruins produziam a mesma string.
    const daFuncao = portasFalsas(
      { tipo: "sucesso", requestId: "r", auditoria: "completa",
        autoridade: { lojaId: LOJA }, envelope: { data: { fora: 1 } } });
    const rF = await sincronizarPerguntas(entradaPadrao(), daFuncao.portas);

    const daRpc = portasFalsas(sucessoCom([pergunta()]), {
      gravacao: { tipo: "erro", codigo: "resposta_rpc_fora_de_forma" },
    });
    const rR = await sincronizarPerguntas(entradaPadrao(), daRpc.portas);

    ok("L7  os dois `fora de forma` tem codigos DIFERENTES no servico",
      rF.tipo === "erro" && rR.tipo === "erro" && rF.codigo !== rR.codigo,
      `${rF.tipo === "erro" ? rF.codigo : rF.tipo} vs ${rR.tipo === "erro" ? rR.codigo : rR.tipo}`);
    ok("L7b e origens diferentes, declaradas na FONTE",
      rF.tipo === "erro" && rF.origem === "contrato"
      && rR.tipo === "erro" && rR.origem === "persistencia");
    ok("L7c e desfechos de acao diferentes",
      (daFuncao.espiao.desfechos[0] ?? {}).codigo === "contrato_violado"
      && (daRpc.espiao.desfechos[0] ?? {}).codigo === "persistencia_falhou");
  }

  for (const [rotulo, desfecho] of [
    ["o desfecho nao gravou", { estado: "falhou" }],
    ["outra sessao ja fechou esta execucao", { estado: "duplicada" }],
  ] as const) {
    const { portas } = portasFalsas(sucessoCom([pergunta()]), { desfecho });
    const r = await sincronizarPerguntas(entradaPadrao(), portas);
    ok(`L8  ${rotulo}: o resultado de NEGOCIO e preservado`,
      r.tipo === "sincronizado" && r.persistencia.novas === 1);
    ok(`L8b ${rotulo}: e a auditoria e declarada incompleta`,
      r.tipo === "sincronizado" && r.auditoria === "incompleta");
  }

  {
    // Erro de provider cujo desfecho tambem nao grava: a causa primaria
    // NAO vira "falha de auditoria". Sao duas dimensoes.
    const { portas } = portasFalsas(
      { tipo: "erro", requestId: "r", envelope: { error: { code: "limite_excedido" } } },
      { desfecho: { estado: "falhou" } });
    const r = await sincronizarPerguntas(entradaPadrao(), portas);
    ok("L9  causa primaria e saude do registro sao dimensoes separadas",
      r.tipo === "erro" && r.codigo === "limite_excedido" && r.auditoria === "incompleta");
  }

  {
    // A precedencia dos parciais, e o que ela NAO apaga.
    const { portas, espiao } = portasPorPagina([
      sucessoCom(Array.from({ length: 50 }, (_, i) => pergunta({ id: `A${i}` })), true,
        LOJA, 50, 0, "incompleta"),
      sucessoCom([pergunta({ id: "X", status: "ANSWERED" })], true),
    ]);
    const r = await sincronizarPerguntas(entradaPadrao(), portas);
    const de = espiao.desfechos[0] ?? {};
    ok("L10 backlog vence descartes e auditoria incompleta",
      de.status === "parcial" && de.codigo === "backlog_truncado",
      JSON.stringify({ s: de.status, c: de.codigo }));
    const resumo = (de.resumo ?? {}) as Record<string, unknown>;
    ok("L10b o resumo NAO perde os fatos que perderam a precedencia",
      resumo.auditoria_funcao_incompleta === true
      && resumo.status_inesperados === 1
      && resumo.truncado === true
      && resumo.limite_atingido === true,
      JSON.stringify(resumo));
    ok("L10c e o resultado carrega o mesmo no `metricas`",
      r.tipo === "backlog_truncado" && r.metricas.auditoria_funcao_incompleta === true);
  }

  {
    const { portas, espiao } = portasFalsas(
      sucessoCom([pergunta({ id: "Z", status: "ANSWERED" })]));
    await sincronizarPerguntas(entradaPadrao(), portas);
    const de = espiao.desfechos[0] ?? {};
    ok("L11 descarte sem backlog -> parcial/descartes_na_varredura",
      de.status === "parcial" && de.codigo === "descartes_na_varredura");
  }

  {
    const { portas, espiao } = portasFalsas(
      sucessoCom([pergunta()], false, LOJA, 1, 0, "incompleta"));
    const r = await sincronizarPerguntas(entradaPadrao(), portas);
    const de = espiao.desfechos[0] ?? {};
    ok("L12 varredura limpa com ledger de Funcao furado NAO e sucesso limpo",
      de.status === "parcial" && de.codigo === "auditoria_funcao_incompleta",
      JSON.stringify({ s: de.status, c: de.codigo }));
    ok("L12b a inbox recebeu normalmente — o dado do provider e verdadeiro",
      r.tipo === "sincronizado" && r.persistencia.novas === 1);
  }

  {
    const { portas, espiao } = portasFalsas(sucessoCom([pergunta()]));
    await sincronizarPerguntas(entradaPadrao(), portas);
    const de = espiao.desfechos[0] ?? {};
    ok("L13 varredura sem descarte, sem backlog e com ledger inteiro e SUCESSO",
      de.status === "sucesso" && de.codigo === null);
    const resumo = (de.resumo ?? {}) as Record<string, unknown>;
    ok("L13b o resumo nao carrega nada que identifique pergunta ou anuncio",
      Object.keys(resumo).every((k) => !/texto|id_externo|anuncio|pergunta|token|loja/.test(k)),
      Object.keys(resumo).join(","));
    ok("L13c e todo valor do resumo e escalar",
      Object.values(resumo).every((v) => typeof v === "number" || typeof v === "boolean"));
  }

  // --- D. O orcamento de relogio da acao -------------------------------
  secao("D. Orcamento — a acao nao comeca o que nao cabe");

  /**
   * O relogio monotonico, sob controle do teste.
   *
   * O servico le `performance.now()`. Trocar o global e a mesma tecnica
   * do `fetch` nas suites de rede: o codigo de producao nao sabe que
   * esta sendo medido, e o teste decide quanto tempo passou.
   *
   * O que ISTO prova e a REGRA DE DECISAO. Que o cancelamento de rede
   * acontece de verdade e provado onde ele mora — em
   * `testar-ml-auth-refresh-timeout.ts`, com AbortController real.
   */
  function comRelogio<T>(
    avancoPorChamadaDePagina: number,
    corpo: (marcar: () => void) => Promise<T>
  ): Promise<T> {
    const originalNow = performance.now.bind(performance);
    let simulado = 0;
    performance.now = () => simulado;
    const marcar = () => { simulado += avancoPorChamadaDePagina; };
    return corpo(marcar).finally(() => { performance.now = originalNow; });
  }

  ok("D0  o orcamento fecha: externo + reserva = total",
    ORCAMENTO_EXTERNO_MS + RESERVA_FINALIZACAO_MS === ORCAMENTO_TOTAL_MS
    && ORCAMENTO_TOTAL_MS === 38_000 && RESERVA_FINALIZACAO_MS === 8_000,
    `${ORCAMENTO_EXTERNO_MS}+${RESERVA_FINALIZACAO_MS}=${ORCAMENTO_TOTAL_MS}`);
  ok("D0b o total fica abaixo dos dois limites duros (45 s / 60 s)",
    ORCAMENTO_TOTAL_MS < 45_000 && ORCAMENTO_TOTAL_MS < 60_000);
  ok("D0c a reserva NAO cabe uma pagina — ela e so para finalizar",
    RESERVA_FINALIZACAO_MS < CUSTO_MINIMO_DE_PAGINA_MS);

  {
    // Paginas rapidas: as duas cabem, e o comportamento e o de sempre.
    const cheia = Array.from({ length: 50 }, (_, i) => pergunta({ id: `D1-${i}` }));
    const r = await comRelogio(1_000, async (marcar) => {
      const { portas, espiao } = portasPorPagina([
        sucessoCom(cheia, true), sucessoCom([pergunta({ id: "D1-fim" })], false),
      ]);
      const original = portas.executar;
      const p = { ...portas, executar: async (e: never) => { marcar(); return original(e); } };
      const saida = await sincronizarPerguntas(entradaPadrao(), p as PortasSincronizacao);
      return { saida, espiao };
    });
    ok("D1  com orcamento de sobra, a segunda pagina executa",
      r.espiao.chamadas.length === 2 && r.saida.tipo === "sincronizado");
    ok("D1b e o escalar de orcamento sai FALSO",
      r.saida.tipo === "sincronizado"
      && r.saida.metricas.orcamento_esgotado === false);
  }

  {
    // Pagina 1 lenta: sobra menos que o minimo, e a 2 nao comeca.
    const cheia = Array.from({ length: 50 }, (_, i) => pergunta({ id: `D2-${i}` }));
    const r = await comRelogio(ORCAMENTO_EXTERNO_MS - 1_000, async (marcar) => {
      const { portas, espiao } = portasPorPagina([
        sucessoCom(cheia, true), sucessoCom(cheia, true),
      ]);
      const original = portas.executar;
      const p = { ...portas, executar: async (e: never) => { marcar(); return original(e); } };
      const saida = await sincronizarPerguntas(entradaPadrao(), p as PortasSincronizacao);
      return { saida, espiao };
    });
    ok("D2  sem orcamento, a proxima ida ao provider NAO acontece",
      r.espiao.chamadas.length === 1, String(r.espiao.chamadas.length));
    ok("D3  o que a pagina 1 coletou AINDA e gravado",
      r.espiao.gravacoes.length === 1
      && (r.espiao.gravacoes[0].linhas as unknown[]).length === 50);
    ok("D3b e o desfecho da acao e escrito — a reserva serviu para isto",
      r.espiao.desfechos.length === 1);
    ok("D4  a reserva nao foi consumida por uma pagina nova",
      r.espiao.chamadas.length === 1 && r.espiao.desfechos.length === 1);
    ok("D2b o desfecho e `parcial/backlog_truncado`, nunca sucesso limpo",
      (r.espiao.desfechos[0] ?? {}).status === "parcial"
      && (r.espiao.desfechos[0] ?? {}).codigo === "backlog_truncado",
      JSON.stringify(r.espiao.desfechos[0] ?? {}));
    {
      const resumo = ((r.espiao.desfechos[0] ?? {}).resumo ?? {}) as Record<string, unknown>;
      ok("D2c o resumo distingue RELOGIO de teto de paginas",
        resumo.orcamento_esgotado === true && resumo.limite_atingido === false
        && resumo.truncado === true,
        JSON.stringify(resumo));
    }
    ok("D2d e o servico devolve `backlog_truncado`, nao `sincronizado`",
      r.saida.tipo === "backlog_truncado");
  }

  {
    // A fronteira exata: sobra EXATAMENTE o minimo -> pode comecar.
    const cheia = Array.from({ length: 50 }, (_, i) => pergunta({ id: `D5-${i}` }));
    const r = await comRelogio(ORCAMENTO_EXTERNO_MS - CUSTO_MINIMO_DE_PAGINA_MS, async (marcar) => {
      const { portas, espiao } = portasPorPagina([
        sucessoCom(cheia, true), sucessoCom([], false),
      ]);
      const original = portas.executar;
      const p = { ...portas, executar: async (e: never) => { marcar(); return original(e); } };
      await sincronizarPerguntas(entradaPadrao(), p as PortasSincronizacao);
      return espiao;
    });
    ok("D5  restante == minimo ainda permite comecar (`<`, nao `<=`)",
      r.chamadas.length === 2, String(r.chamadas.length));
  }

  {
    // Um milissegundo a menos que o minimo -> nao comeca.
    const cheia = Array.from({ length: 50 }, (_, i) => pergunta({ id: `D6-${i}` }));
    const r = await comRelogio(
      ORCAMENTO_EXTERNO_MS - CUSTO_MINIMO_DE_PAGINA_MS + 1,
      async (marcar) => {
        const { portas, espiao } = portasPorPagina([
          sucessoCom(cheia, true), sucessoCom([], false),
        ]);
        const original = portas.executar;
        const p = { ...portas, executar: async (e: never) => { marcar(); return original(e); } };
        await sincronizarPerguntas(entradaPadrao(), p as PortasSincronizacao);
        return espiao;
      });
    ok("D6  um milissegundo abaixo do minimo ja impede a pagina",
      r.chamadas.length === 1, String(r.chamadas.length));
  }

  {
    // Pagina 1 que NAO indica backlog: o orcamento nem e consultado, e o
    // desfecho e sucesso limpo.
    const r = await comRelogio(ORCAMENTO_EXTERNO_MS - 1_000, async (marcar) => {
      const { portas, espiao } = portasPorPagina([sucessoCom([pergunta()], false)]);
      const original = portas.executar;
      const p = { ...portas, executar: async (e: never) => { marcar(); return original(e); } };
      const saida = await sincronizarPerguntas(entradaPadrao(), p as PortasSincronizacao);
      return { saida, espiao };
    });
    ok("D7  fim de lista com orcamento curto continua sendo SUCESSO limpo",
      (r.espiao.desfechos[0] ?? {}).status === "sucesso"
      && (r.espiao.desfechos[0] ?? {}).codigo === null,
      JSON.stringify(r.espiao.desfechos[0] ?? {}));
    ok("D7b o escalar de orcamento nao mente quando nada foi cortado",
      r.saida.tipo === "sincronizado"
      && r.saida.metricas.orcamento_esgotado === false);
  }

  {
    // A latencia gravada tambem sai do relogio MONOTONICO.
    const r = await comRelogio(7_000, async (marcar) => {
      const { portas, espiao } = portasPorPagina([sucessoCom([pergunta()], false)]);
      const original = portas.executar;
      const p = { ...portas, executar: async (e: never) => { marcar(); return original(e); } };
      await sincronizarPerguntas(entradaPadrao(), p as PortasSincronizacao);
      return espiao;
    });
    ok("D8  a latencia do desfecho vem do relogio monotonico",
      (r.desfechos[0] ?? {}).latenciaMs === 7_000,
      String((r.desfechos[0] ?? {}).latenciaMs));
  }

  {
    const codigo = lerCodigo("lib/agentes/ingestao/sincronizar-perguntas.ts");
    ok("D9  o orcamento NAO entra pela entrada — quem chama nao o escolhe",
      !/orcamento|budget|deadline/i.test(
        codigo.slice(
          codigo.indexOf("interface EntradaSincronizarPerguntas"),
          codigo.indexOf("interface PortasSincronizacao"))));
    ok("D9b a decisao usa `performance.now`, nunca `Date.now`",
      /function agoraMonotonico\(\): number \{\s*return performance\.now\(\);/.test(codigo)
      && !/Date\.now\(\)/.test(codigo));
    ok("D9c a regra vale da SEGUNDA pagina em diante",
      /const restante = restanteDoProviderMs\(controle\);\s*if \(indice > 0\) \{/
        .test(codigo));
    ok("D9d o restante vem do orcamento COMPARTILHADO, nao de aritmetica local",
      /restanteDoProviderMs\(controle\)/.test(codigo)
      && !/ORCAMENTO_EXTERNO_MS - \(agoraMonotonico/.test(codigo));
    ok("D9e a primeira pagina tambem e barrada quando o orcamento ja acabou",
      /\} else if \(restante <= 0\) \{/.test(codigo)
      && /codigo: "orcamento_esgotado_antes_do_provider"/.test(codigo));
    ok("D9f os dois relogios sao criados pelo SERVICO, nunca recebidos",
      /criarControleDeTempo\(\{/.test(codigo)
      && /orcamentoRigidoMs: ORCAMENTO_TOTAL_MS/.test(codigo)
      && /orcamentoDoProviderMs: ORCAMENTO_EXTERNO_MS/.test(codigo));
    ok("D9g os timers sao encerrados num `finally`",
      /\} finally \{\s*encerrar\(\);/.test(codigo));
    ok("D9h a persistencia usa o sinal RIGIDO, nunca o do provider",
      /controle\.sinalRigido/.test(codigo)
      && !/limiteDoProvider\.signal/.test(codigo));
  }

  console.log(`\n── placar ${"─".repeat(54)}`);
  console.log(`  PASS ${passou}   FAIL ${falhou}\n`);
  if (falhou > 0) process.exitCode = 1;
}

void main();
