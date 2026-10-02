/**
 * F9.1 — correcoes de producao antes da refatoracao.
 *
 * NAO chama IA, NAO chama rede, NAO chama banco, NAO chama storage.
 *
 * Tres defeitos, tres secoes, e uma regra para cada um:
 *
 *   A/B  DECLARACAO x VALIDADOR. `vendas.consultar` dizia ao modelo
 *        `{inicio, fim}` e o validador lia `{dataInicio, dataFim}`. As
 *        suites antigas chamavam o executor direto, com o formato do
 *        validador, e nunca viam a declaracao. A secao A percorre TODAS
 *        as Funcoes registradas e monta o pedido A PARTIR DO SCHEMA, como
 *        o modelo faria — e o validador tem de aceitar.
 *
 *   C-G  ANEXOS DA CONVERSA. O resolvedor ja abria o anexo, mas o runtime
 *        so listava `listarDoAgente`: o modelo nunca recebia o id. Aqui a
 *        PORTA REAL (`criarPortaDeFontes`) roda sobre uma tabela em
 *        memoria que aplica os `.eq()` de verdade, entao os filtros
 *        provados sao os do repositorio, e nao os de uma fixture.
 *
 *   H    FONTE POR EXECUCAO. `planilha.ts` guardava a fonte numa
 *        variavel de MODULO. Duas execucoes presas numa barreira — as
 *        duas entram, nenhuma sai antes da outra entrar — provam que
 *        cada uma le o proprio arquivo. O controle H0 reconstroi o padrao
 *        antigo com a MESMA barreira e mostra o cruzamento: sem ele, um
 *        "passou" poderia so significar que a barreira nao intercalou.
 *
 * Rodar:  npx tsx scripts/testar-agentes-f9-1-producao.ts
 */
import "./_server-only-inerte";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";

import { FUNCOES, resolverFuncao, type ContextoFuncao } from "@/lib/agentes/funcoes/registry";
import { DECLARACOES, declararFerramentas } from "@/lib/agentes/ia/ferramentas";
import { semCamposNulos } from "@/lib/agentes/ia/argumentos-do-modelo";
import { conversarComFerramentas } from "@/lib/agentes/ia/laco-ferramentas";
import { criarPortaDeFontes } from "@/lib/agentes/fontes/repositorio";
import {
  criarFonteDeArquivoDasSources,
  listarFontesDoTurno,
  unirFontesDoTurno,
} from "@/lib/agentes/fontes/resolvedor";
import { paraModelo, type Fonte } from "@/lib/agentes/fontes/tipos";
import { montarContextoDoAgente } from "@/lib/agentes/ia/contexto-do-agente";
import type { ArquivoResolvido, FonteDeArquivo } from "@/lib/agentes/planilhas/fonte";
import type {
  AdaptadorIAComFerramentas,
  RespostaIAComFerramentas,
} from "@/lib/agentes/ia/ferramentas";

const RAIZ = join(__dirname, "..");

let passou = 0;
let falhou = 0;
function ok(nome: string, cond: boolean, detalhe?: string): void {
  if (cond) { passou += 1; console.log(`  PASS  ${nome}`); }
  else { falhou += 1; console.log(`  FAIL  ${nome}${detalhe ? ` — ${detalhe}` : ""}`); }
}
function secao(t: string): void {
  console.log(`\n── ${t} ${"─".repeat(Math.max(2, 60 - t.length))}`);
}
function ler(rel: string): string { return readFileSync(join(RAIZ, rel), "utf8"); }
function semComentarios(f: string): string {
  return f.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// ─── A. Amostra a partir do SCHEMA, como o modelo montaria ────────────

type Schema = {
  type?: string | string[];
  enum?: unknown[];
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  additionalProperties?: boolean;
};

/**
 * Um valor para UM campo, tirado so do que a declaracao diz.
 *
 * Nada aqui conhece Funcao pelo nome. As pistas sao as que o modelo
 * tambem le: `enum`, o formato escrito na descricao ("AAAA-MM-DD") e o
 * primeiro exemplo dado em "Ex.:". Uma Funcao cujo validador recusa o
 * proprio exemplo da declaracao esta com contrato quebrado — e e
 * exatamente isso que esta secao existe para pegar.
 */
function amostra(s: Schema, completo: boolean): unknown {
  if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0];
  const tipo = Array.isArray(s.type) ? s.type[0] : s.type;
  const desc = s.description ?? "";
  switch (tipo) {
    case "object": return objetoDeAmostra(s, completo);
    case "array": return [amostra(s.items ?? {}, completo)];
    case "integer": return 1;
    case "number": return 1;
    case "boolean": return true;
    default: {
      if (/AAAA-MM-DD/.test(desc)) return "2026-08-01";
      const citado = /Ex\.?:\s*'([^']+)'/.exec(desc);
      if (citado) return citado[1];
      const nu = /Ex\.?:\s*([A-Za-z0-9_]+)/.exec(desc);
      if (nu) return nu[1];
      return "x";
    }
  }
}

function objetoDeAmostra(s: Schema, completo: boolean): Record<string, unknown> {
  const props = s.properties ?? {};
  const exigidos = new Set(s.required ?? []);
  const saida: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (completo || exigidos.has(k)) saida[k] = amostra(v, completo);
  }
  return saida;
}

// ─── C-G. Tabela e storage em memoria, com `.eq()` de verdade ─────────

interface LinhaFonteMem {
  id: string; user_id: string; agente_id: string | null; conversa_id: string | null;
  escopo: string; nome: string; descricao: string | null; papel: string | null;
  tipo: string; mime: string; tamanho_bytes: number; hash_sha256: string;
  caminho_objeto: string; ativo: boolean; substitui_id: string | null; criado_em: string;
}

/**
 * Um cliente MINIMO, so com o que `criarPortaDeFontes` usa para LER.
 *
 * Cada `.eq()` vira filtro aplicado de verdade sobre as linhas. Assim a
 * consulta que decide o isolamento e a do REPOSITORIO: se ele esquecer
 * um `.eq("user_id", …)`, a linha alheia aparece aqui tambem.
 */
function clienteEmMemoria(linhas: LinhaFonteMem[], objetos: Map<string, Uint8Array>) {
  const consultas: Record<string, unknown>[] = [];
  const builder = () => {
    const filtros: Record<string, unknown> = {};
    const executar = () => {
      consultas.push({ ...filtros });
      return linhas
        .filter((l) => Object.entries(filtros).every(([c, v]) => (l as never)[c] === v))
        .sort((a, b) => (a.criado_em < b.criado_em ? -1 : 1));
    };
    const q = {
      select() { return q; },
      eq(c: string, v: unknown) { filtros[c] = v; return q; },
      order() { return q; },
      async maybeSingle() {
        const r = executar();
        return { data: r.length === 1 ? r[0] : null, error: null };
      },
      then(res: (v: { data: LinhaFonteMem[]; error: null }) => unknown, rej?: (e: unknown) => unknown) {
        return Promise.resolve({ data: executar(), error: null }).then(res, rej);
      },
    };
    return q;
  };
  const cliente = {
    from(tabela: string) {
      if (tabela !== "agente_fontes") throw new Error(`tabela inesperada: ${tabela}`);
      return builder();
    },
    storage: {
      from() {
        return {
          async download(caminho: string) {
            const b = objetos.get(caminho);
            if (!b) return { data: null, error: { message: "nao existe" } };
            return { data: { arrayBuffer: async () => b.slice().buffer }, error: null };
          },
        };
      },
    },
  };
  return { cliente: cliente as unknown as SupabaseClient, consultas };
}

const DONO_A = "f91-dono-a";
const DONO_B = "f91-dono-b";
const AG_1 = "f91-agente-1";
const AG_2 = "f91-agente-2";
const AG_B = "f91-agente-b";
const CONV_1 = "f91-conversa-1";   // de AG_1
const CONV_2 = "f91-conversa-2";   // de AG_1
const CONV_3 = "f91-conversa-3";   // de AG_2
const CONV_B = "f91-conversa-b";   // de DONO_B

let seq = 0;
function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}
function csv(cabecalho: string, valor: string): Uint8Array {
  return new TextEncoder().encode(`${cabecalho},Valor\n${valor},10\n`);
}
function linha(
  p: { id: string; user: string; agente?: string; conversa?: string; nome: string; ativo?: boolean }
): LinhaFonteMem {
  seq += 1;
  return {
    id: p.id, user_id: p.user,
    agente_id: p.agente ?? null, conversa_id: p.conversa ?? null,
    escopo: p.conversa ? "conversa" : "agente",
    nome: p.nome, descricao: null, papel: null, tipo: "csv", mime: "text/csv",
    tamanho_bytes: 20, hash_sha256: "0".repeat(64),
    caminho_objeto: `bucket-interno/${p.user}/${p.id}.csv`,
    ativo: p.ativo ?? true, substitui_id: null,
    criado_em: `2026-10-0${Math.min(9, seq)}T00:00:00Z`,
  };
}

// ─── H. Barreira: as duas entram antes de qualquer uma sair ───────────

function barreira(n: number) {
  let chegaram = 0;
  let soltar!: () => void;
  const aberta = new Promise<void>((r) => { soltar = r; });
  return {
    async esperar(): Promise<void> {
      chegaram += 1;
      if (chegaram === n) soltar();
      await aberta;
    },
    get chegaram() { return chegaram; },
  };
}

function fonteNaBarreira(
  b: ReturnType<typeof barreira>, dono: string, fileId: string, bytes: Uint8Array, nome: string
): FonteDeArquivo {
  return {
    async resolver(userId: string, id: string): Promise<ArquivoResolvido | null> {
      await b.esperar();
      if (userId !== dono || id !== fileId) return null;
      return { fileId, nome, extensao: "csv", bytes };
    },
  };
}

function cabecalhosDe(saida: unknown): string {
  const s = saida as { ok?: boolean; abas?: { cabecalhos: string[] }[]; codigo?: string };
  if (s.ok !== true || !s.abas) return `falha:${s.codigo ?? "?"}`;
  return s.abas[0].cabecalhos.join("|");
}

async function main(): Promise<void> {
  console.log("\n══ CDS IA — F9.1: correcoes de producao ══");

  // ═══════════════════════════════════════════════════════════════════
  secao("A. Declaracao x validador — TODAS as Funcoes registradas");
  // ═══════════════════════════════════════════════════════════════════
  const ids = Object.keys(FUNCOES).sort();
  ok("A0  ha Funcoes registradas para percorrer", ids.length >= 8, String(ids.length));
  for (const id of ids) {
    const d = Object.prototype.hasOwnProperty.call(DECLARACOES, id) ? DECLARACOES[id] : undefined;
    ok(`A1  ${id}: tem declaracao`, d !== undefined);
    if (!d) continue;
    const schema = d.schemaEntrada as Schema;
    const props = Object.keys(schema.properties ?? {});
    ok(`A2  ${id}: todo campo exigido esta declarado`,
      (schema.required ?? []).every((r) => props.includes(r)),
      JSON.stringify(schema.required));

    const minimo = objetoDeAmostra(schema, false);
    const vMin = FUNCOES[id].validarEntrada(minimo);
    ok(`A3  ${id}: o MINIMO que a declaracao exige e aceito`, vMin.valida,
      `${JSON.stringify(minimo)} -> ${vMin.valida ? "" : vMin.codigo}`);

    const completo = objetoDeAmostra(schema, true);
    const vCompleto = FUNCOES[id].validarEntrada(completo);
    ok(`A4  ${id}: TODOS os campos declarados sao aceitos juntos`, vCompleto.valida,
      `${JSON.stringify(completo)} -> ${vCompleto.valida ? "" : vCompleto.codigo}`);

    // Opcional que o modelo manda como `null` (medido na OpenAI) passa
    // pelo MESMO saneamento do laco antes de chegar ao validador.
    const comNulos: Record<string, unknown> = { ...minimo };
    for (const p of props) if (!(schema.required ?? []).includes(p)) comNulos[p] = null;
    const vNulos = FUNCOES[id].validarEntrada(semCamposNulos(comNulos));
    ok(`A5  ${id}: opcionais em null, saneados como no laco, sao aceitos`, vNulos.valida,
      vNulos.valida ? "" : vNulos.codigo);
  }

  // CONTROLE: a secao A teria pego o defeito. O schema ANTIGO, aplicado ao
  // MESMO gerador, e recusado pelo validador atual.
  {
    const antigo: Schema = {
      type: "object",
      properties: {
        inicio: { type: "string", description: "Data inicial, AAAA-MM-DD." },
        fim: { type: "string", description: "Data final, AAAA-MM-DD." },
        marketplace: { type: "string", description: "Opcional. ML ou Shopee." },
      },
      required: ["inicio", "fim"],
      additionalProperties: false,
    };
    const v = FUNCOES["vendas.consultar"].validarEntrada(objetoDeAmostra(antigo, false));
    ok("A6  CONTROLE: o schema antigo {inicio,fim} REPROVA no mesmo teste",
      !v.valida && v.codigo === "data_invalida", JSON.stringify(v));
    const vMp = FUNCOES["vendas.consultar"].validarEntrada({
      dataInicio: "2026-08-01", dataFim: "2026-08-01", marketplace: "Mercado Livre" });
    ok("A7  CONTROLE: marketplace fora do enum declarado e recusado pelo validador",
      !vMp.valida && vMp.codigo === "marketplace_invalido", JSON.stringify(vMp));
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("B. vendas.consultar pelo contrato que o MODELO recebe");
  // ═══════════════════════════════════════════════════════════════════
  {
    const declaradas = declararFerramentas({
      catalogo: FUNCOES,
      permissoes: [{ funcaoId: "vendas.consultar", nivel: "automatico" }],
    });
    const decl = declaradas.find((f) => f.nome === "vendas.consultar");
    ok("B1  vendas.consultar e declarada ao modelo", decl !== undefined);
    const schema = (decl?.schemaEntrada ?? {}) as Schema;
    ok("B2  o modelo recebe dataInicio/dataFim, exigidos",
      JSON.stringify(schema.required) === JSON.stringify(["dataInicio", "dataFim"]) &&
        "dataInicio" in (schema.properties ?? {}) && "dataFim" in (schema.properties ?? {}),
      JSON.stringify(schema.required));
    ok("B3  e NAO recebe mais inicio/fim",
      !("inicio" in (schema.properties ?? {})) && !("fim" in (schema.properties ?? {})));
    ok("B4  marketplace e enum com os valores do validador",
      JSON.stringify(schema.properties?.marketplace?.enum) === JSON.stringify(["ML", "Shopee"]));

    // O pedido do modelo, montado com EXATAMENTE as chaves declaradas,
    // atravessa o laco real e chega a porta como chegaria ao executor.
    let recebido: unknown = null;
    let validacao: { valida: boolean; codigo?: string } | null = null;
    const pedidoDoModelo = { dataInicio: "2026-08-01", dataFim: "2026-08-07", marketplace: null };
    let turno = 0;
    const adaptador: AdaptadorIAComFerramentas = async (): Promise<RespostaIAComFerramentas> => {
      turno += 1;
      return {
        texto: turno === 1 ? null : "pronto",
        pedidos: turno === 1
          ? [{ id: "p1", nome: "vendas.consultar", argumentos: pedidoDoModelo }]
          : [],
        provedor: "anthropic", modelo: "fixture", tokensEntrada: 0, tokensSaida: 0, tempoMs: 0,
      };
    };
    const r = await conversarComFerramentas({
      userId: DONO_A, agenteId: AG_1, instrucao: "fixture", mensagemDoUsuario: "vendas da semana",
      ferramentas: declaradas, adaptador,
      executar: (async (e: { argumentos: unknown }) => {
        recebido = e.argumentos;
        const v = FUNCOES["vendas.consultar"].validarEntrada(e.argumentos);
        validacao = v.valida ? { valida: true } : { valida: false, codigo: v.codigo };
        return { tipo: "sucesso" as const, requestId: "r",
          envelope: { data: { linhas: [], truncado: false } }, auditoria: "completa" as const };
      }) as never,
    });
    ok("B5  o laco entregou o pedido do modelo a execucao", recebido !== null, r.motivo);
    ok("B6  o null do opcional foi saneado antes da validacao",
      recebido !== null && !("marketplace" in (recebido as object)), JSON.stringify(recebido));
    ok("B7  e o VALIDADOR REAL aceitou o que o modelo mandou",
      (validacao as { valida: boolean } | null)?.valida === true, JSON.stringify(validacao));
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("C-G. Arquivos do turno — porta REAL sobre tabela em memoria");
  // ═══════════════════════════════════════════════════════════════════
  const linhas: LinhaFonteMem[] = [];
  const objetos = new Map<string, Uint8Array>();
  const add = (p: Parameters<typeof linha>[0], bytes: Uint8Array) => {
    const l = linha(p);
    linhas.push(l);
    objetos.set(l.caminho_objeto, bytes);
    return l;
  };
  const fAg1 = add({ id: uuid(1), user: DONO_A, agente: AG_1, nome: "permanente-ag1.csv" },
    csv("PermanenteAg1", "a"));
  const fConv1 = add({ id: uuid(2), user: DONO_A, conversa: CONV_1, nome: "anexo-conv1.csv" },
    csv("AnexoConv1", "b"));
  const fConv2 = add({ id: uuid(3), user: DONO_A, conversa: CONV_2, nome: "anexo-conv2.csv" },
    csv("AnexoConv2", "c"));
  const fAg2 = add({ id: uuid(4), user: DONO_A, agente: AG_2, nome: "permanente-ag2.csv" },
    csv("PermanenteAg2", "d"));
  const fConv3 = add({ id: uuid(5), user: DONO_A, conversa: CONV_3, nome: "anexo-conv3-ag2.csv" },
    csv("AnexoConv3", "e"));
  const fB = add({ id: uuid(6), user: DONO_B, agente: AG_B, nome: "permanente-dono-b.csv" },
    csv("DonoB", "f"));
  const fConvB = add({ id: uuid(7), user: DONO_B, conversa: CONV_B, nome: "anexo-dono-b.csv" },
    csv("AnexoDonoB", "g"));
  const fConv1Inativo = add({ id: uuid(8), user: DONO_A, conversa: CONV_1,
    nome: "anexo-conv1-removido.csv", ativo: false }, csv("Removido", "h"));

  const { cliente, consultas } = clienteEmMemoria(linhas, objetos);
  const porta = criarPortaDeFontes(cliente);

  const doTurno = await listarFontesDoTurno(porta, DONO_A, AG_1, CONV_1);
  const idsTurno = doTurno.map((f) => f.id);

  ok("C1  arquivo PERMANENTE do agente continua no turno", idsTurno.includes(fAg1.id));
  ok("D1  anexo DESTA conversa agora chega ao turno", idsTurno.includes(fConv1.id));
  ok("D2  na ordem: permanentes primeiro, anexos depois",
    idsTurno.indexOf(fAg1.id) < idsTurno.indexOf(fConv1.id));
  ok("D3  anexo removido (inativo) nao entra", !idsTurno.includes(fConv1Inativo.id));
  ok("E1  anexo de OUTRA conversa do mesmo agente NAO entra", !idsTurno.includes(fConv2.id));
  ok("F1  arquivo de OUTRO agente do mesmo dono NAO entra", !idsTurno.includes(fAg2.id));
  ok("F2  anexo de conversa de OUTRO agente NAO entra", !idsTurno.includes(fConv3.id));
  ok("G1  arquivos de OUTRO dono NAO entram",
    !idsTurno.includes(fB.id) && !idsTurno.includes(fConvB.id));
  ok("C2  exatamente os dois esperados",
    JSON.stringify([...idsTurno].sort()) === JSON.stringify([fAg1.id, fConv1.id].sort()),
    JSON.stringify(idsTurno));
  ok("G2  TODA consulta do turno filtrou user_id e ativo",
    consultas.length > 0 &&
      consultas.every((c) => c.user_id === DONO_A && c.ativo === true),
    JSON.stringify(consultas));

  // O mesmo dono, outra conversa: a visao muda junto.
  const idsConv2 = (await listarFontesDoTurno(porta, DONO_A, AG_1, CONV_2)).map((f) => f.id);
  ok("E2  na conversa 2, o anexo 2 aparece e o anexo 1 NAO",
    idsConv2.includes(fConv2.id) && !idsConv2.includes(fConv1.id) && idsConv2.includes(fAg1.id),
    JSON.stringify(idsConv2));

  // Outro dono pedindo a MESMA conversa por id nao ve nada do dono A.
  const idsIntruso = (await listarFontesDoTurno(porta, DONO_B, AG_1, CONV_1)).map((f) => f.id);
  ok("G3  outro dono com os ids de agente e conversa do dono A ve ZERO",
    idsIntruso.length === 0, JSON.stringify(idsIntruso));

  // O RESOLVEDOR do turno abre exatamente o que foi listado, e nada mais.
  const res = criarFonteDeArquivoDasSources({
    porta, userId: DONO_A, agenteId: AG_1, conversaId: CONV_1 });
  const abre = async (r: FonteDeArquivo, u: string, id: string) => (await r.resolver(u, id)) !== null;
  ok("C3  o resolvedor do turno abre o permanente", await abre(res, DONO_A, fAg1.id));
  ok("D4  e abre o anexo desta conversa", await abre(res, DONO_A, fConv1.id));
  ok("E3  e NAO abre o anexo de outra conversa", !(await abre(res, DONO_A, fConv2.id)));
  ok("F3  e NAO abre arquivo de outro agente", !(await abre(res, DONO_A, fAg2.id)));
  ok("F4  e NAO abre anexo de conversa de outro agente", !(await abre(res, DONO_A, fConv3.id)));
  ok("G4  e NAO abre arquivo de outro dono", !(await abre(res, DONO_A, fB.id)));
  ok("G5  e recusa quando quem pede e outro dono, mesmo com id valido",
    !(await abre(res, DONO_B, fConv1.id)));

  // Ponta a ponta: a Tool le o ANEXO pelo contexto da propria chamada.
  {
    const ctx: ContextoFuncao = { userId: DONO_A, conexao: null, fonteDeArquivo: res };
    const saida = await resolverFuncao("planilha.inspecionar").executor(ctx, { fileId: fConv1.id });
    ok("D5  planilha.inspecionar le o anexo da conversa pelo contexto",
      cabecalhosDe(saida) === "AnexoConv1|Valor", cabecalhosDe(saida));
    const outra = await resolverFuncao("planilha.inspecionar").executor(ctx, { fileId: fConv2.id });
    ok("E4  e o anexo de outra conversa responde como inexistente",
      cabecalhosDe(outra) === "falha:arquivo_nao_encontrado", cabecalhosDe(outra));
  }

  // Deduplicacao pela IDENTIDADE da fonte, nunca pelo nome.
  {
    const a = semCaminhoDe(fAg1);
    const mesmoIdNaConversa = { ...semCaminhoDe(fConv1), id: fAg1.id };
    const homonimo = { ...semCaminhoDe(fConv1), nome: a.nome };
    const unidas = unirFontesDoTurno([a], [mesmoIdNaConversa, homonimo]);
    ok("D6  a mesma fonte (mesmo id) pelas duas listas aparece UMA vez",
      unidas.filter((f) => f.id === fAg1.id).length === 1);
    ok("D7  na repeticao vence a do agente (a permanente)",
      unidas.find((f) => f.id === fAg1.id)?.escopo === "agente");
    ok("D8  dois arquivos DIFERENTES com o mesmo nome continuam os dois",
      unidas.length === 2 && unidas.filter((f) => f.nome === a.nome).length === 2);
  }

  // O que o MODELO recebe: metadado no bloco de fontes, nunca conteudo.
  {
    const ctx = montarContextoDoAgente({
      instrucoesDoAgente: "fixture", skills: [], memorias: [],
      fontes: doTurno.map(paraModelo),
    });
    const bloco = ctx.blocos.find((b) => b.nome === "FONTES_DISPONIVEIS")?.conteudo ?? "";
    ok("D9  o anexo aparece no bloco de fontes, com o id para a Tool",
      bloco.includes("anexo-conv1.csv") && bloco.includes(fConv1.id));
    ok("D10 o CONTEUDO do arquivo NAO entra na instrucao",
      !ctx.instrucao.includes("AnexoConv1") && !ctx.instrucao.includes("PermanenteAg1"));
    ok("D11 nem caminho de storage",
      !ctx.instrucao.includes("bucket-interno") && !ctx.instrucao.includes("caminho"));
    ok("E5  o anexo de outra conversa NAO e citado",
      !ctx.instrucao.includes("anexo-conv2.csv"));
    ok("D12 nenhum bloco de conteudo de fonte foi criado",
      !ctx.blocos.some((b) => (b.nome as string) === "CONTEUDO_DE_FONTE"));
  }

  // O runtime e a retomada usam a listagem do turno DEPOIS de conferir a
  // conversa como deste dono e deste agente — e essa conferencia que
  // impede o anexo de atravessar agentes (a linha de anexo nao tem agente).
  {
    const rt = semComentarios(ler("lib/agentes/conversas/runtime.ts"));
    const iConf = rt.indexOf("conversa.agenteId !== entrada.agenteId");
    const iLista = rt.indexOf("listarFontesDoTurno(portaFontes");
    ok("F5  runtime: lista as fontes do turno so DEPOIS de conferir conversa x agente",
      iConf > 0 && iLista > iConf, `${iConf} < ${iLista}`);
    ok("F6  runtime: nao lista mais SO as do agente",
      !/portaFontes\.listarDoAgente\(/.test(rt));
    const rr = semComentarios(ler("lib/agentes/conversas/retomada.ts"));
    const jConf = rr.indexOf("conversa.agenteId !== aprovacao.agenteId");
    const jLista = rr.indexOf("listarFontesDoTurno(portaFontes");
    ok("F7  retomada: idem, conversa conferida contra o agente da aprovacao antes",
      jConf > 0 && jLista > jConf, `${jConf} < ${jLista}`);
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("H. Fonte por EXECUCAO — concorrencia real com barreira");
  // ═══════════════════════════════════════════════════════════════════
  const bytesA = csv("ArquivoDoA", "1");
  const bytesB = csv("ArquivoDoB", "2");

  // H0 — CONTROLE: o padrao ANTIGO, com a mesma barreira. A variavel abaixo
  // faz o papel do `let fonteAtual` de modulo: cada turno registra a sua
  // e depois le "a atual" quando a Tool roda.
  {
    const b = barreira(2);
    let fonteAtualLegada: FonteDeArquivo | null = null;
    const turnoLegado = async (dono: string, fileId: string, bytes: Uint8Array, nome: string) => {
      fonteAtualLegada = fonteNaBarreira(barreira(1), dono, fileId, bytes, nome);
      await b.esperar();                       // o turno espera o modelo...
      const ctx: ContextoFuncao = { userId: dono, conexao: null,
        fonteDeArquivo: fonteAtualLegada };    // ...e a Tool le "a atual"
      return resolverFuncao("planilha.inspecionar").executor(ctx, { fileId });
    };
    const [la, lb] = await Promise.all([
      turnoLegado(DONO_A, "arquivo-a", bytesA, "a.csv"),
      turnoLegado(DONO_B, "arquivo-b", bytesB, "b.csv"),
    ]);
    ok("H0  CONTROLE: com a fonte de modulo, o turno A perde o PROPRIO arquivo",
      cabecalhosDe(la) !== "ArquivoDoA|Valor" && cabecalhosDe(lb) === "ArquivoDoB|Valor",
      `A=${cabecalhosDe(la)} B=${cabecalhosDe(lb)}`);
  }

  // H1 — o executor real, duas chamadas presas na mesma barreira.
  {
    const b = barreira(2);
    const fa = fonteNaBarreira(b, DONO_A, "arquivo-a", bytesA, "a.csv");
    const fb = fonteNaBarreira(b, DONO_B, "arquivo-b", bytesB, "b.csv");
    const exec = resolverFuncao("planilha.inspecionar").executor;
    const [ra, rb] = await Promise.all([
      exec({ userId: DONO_A, conexao: null, fonteDeArquivo: fa }, { fileId: "arquivo-a" }),
      exec({ userId: DONO_B, conexao: null, fonteDeArquivo: fb }, { fileId: "arquivo-b" }),
    ]);
    ok("H1  as duas execucoes estavam DENTRO da barreira ao mesmo tempo", b.chegaram === 2);
    ok("H2  execucao A le o arquivo A", cabecalhosDe(ra) === "ArquivoDoA|Valor", cabecalhosDe(ra));
    ok("H3  execucao B le o arquivo B", cabecalhosDe(rb) === "ArquivoDoB|Valor", cabecalhosDe(rb));
  }

  // H4 — dois TURNOS inteiros pelo laco real, concorrentes. A porta faz o
  // que `contextoDaFuncao` faz: monta o contexto com a fonte que chegou
  // NA ENTRADA daquela execucao.
  {
    const b = barreira(2);
    const fa = fonteNaBarreira(b, DONO_A, "arquivo-a", bytesA, "a.csv");
    const fb = fonteNaBarreira(b, DONO_B, "arquivo-b", bytesB, "b.csv");
    const vistas: { turno: string; fonte: unknown }[] = [];
    const declaradas = declararFerramentas({
      catalogo: FUNCOES,
      permissoes: [{ funcaoId: "planilha.inspecionar", nivel: "automatico" }],
    });
    const turno = (nome: string, dono: string, fileId: string, fonte: FonteDeArquivo) => {
      let passo = 0;
      const adaptador: AdaptadorIAComFerramentas = async () => {
        passo += 1;
        return {
          texto: passo === 1 ? null : "ok",
          pedidos: passo === 1
            ? [{ id: `${nome}-1`, nome: "planilha.inspecionar", argumentos: { fileId } }] : [],
          provedor: "anthropic", modelo: "fixture", tokensEntrada: 0, tokensSaida: 0, tempoMs: 0,
        };
      };
      return conversarComFerramentas({
        userId: dono, agenteId: `ag-${nome}`, instrucao: "fixture", mensagemDoUsuario: "leia",
        ferramentas: declaradas, adaptador, fonteDeArquivo: fonte,
        executar: (async (e: { userId: string; argumentos: unknown; fonteDeArquivo?: FonteDeArquivo | null }) => {
          vistas.push({ turno: nome, fonte: e.fonteDeArquivo });
          const data = await resolverFuncao("planilha.inspecionar").executor(
            { userId: e.userId, conexao: null, fonteDeArquivo: e.fonteDeArquivo }, e.argumentos);
          return { tipo: "sucesso" as const, requestId: nome, envelope: { data },
            auditoria: "completa" as const };
        }) as never,
      });
    };
    const [ta, tb] = await Promise.all([
      turno("A", DONO_A, "arquivo-a", fa),
      turno("B", DONO_B, "arquivo-b", fb),
    ]);
    ok("H4  cada turno entregou a SUA fonte a execucao",
      vistas.length === 2 &&
        vistas.find((v) => v.turno === "A")?.fonte === fa &&
        vistas.find((v) => v.turno === "B")?.fonte === fb);
    const dialogoA = JSON.stringify(ta.mensagens);
    const dialogoB = JSON.stringify(tb.mensagens);
    ok("H5  o modelo do turno A viu o arquivo A, e so ele",
      dialogoA.includes("ArquivoDoA") && !dialogoA.includes("ArquivoDoB"));
    ok("H6  o modelo do turno B viu o arquivo B, e so ele",
      dialogoB.includes("ArquivoDoB") && !dialogoB.includes("ArquivoDoA"));
  }

  // H7+ — nenhuma volta do estado de modulo, em nenhum caminho.
  {
    const pl = semComentarios(ler("lib/agentes/funcoes/planilha.ts"));
    ok("H7  planilha.ts nao tem `let`/`var` de modulo",
      !/^(let|var)\s/m.test(pl));
    ok("H8  e nao exporta registro de fonte",
      !/registrarFonteDeArquivo|obterFonteDeArquivo|fonteAtual/.test(pl));
    ok("H9  a fonte vem do CONTEXTO da chamada",
      /contexto\.fonteDeArquivo/.test(pl));
    const ex = semComentarios(ler("lib/agentes/execucao-funcoes/executar.ts"));
    ok("H10 executor: os dois caminhos (automatico e aprovado) levam a fonte ao contexto",
      /executarComAberturaFeita\(\s*snapshot, definicao, argumentos, entrada\.controleTempo, entrada\.fonteDeArquivo\)/.test(ex) &&
        /executarComAberturaFeita\(\s*snapshot, contexto\.definicao, contexto\.argumentos, undefined, entrada\.fonteDeArquivo\)/.test(ex) &&
        /contextoDaFuncao\(snapshot, definicao, controle, fonteDeArquivo\)/.test(ex));
    const naoTeste = ["lib/agentes/conversas/runtime.ts", "lib/agentes/conversas/retomada.ts",
      "app/api/agentes/[agenteId]/fontes/[fonteId]/inspecao/route.ts"];
    ok("H11 runtime, retomada e inspecao nao registram fonte em modulo",
      naoTeste.every((f) => !/registrarFonteDeArquivo/.test(ler(f))));
    ok("H12 e os tres passam a fonte adiante explicitamente",
      /fonteDeArquivo,/.test(ler(naoTeste[0])) && /fonteDeArquivo,/.test(ler(naoTeste[1])) &&
        /fonteDeArquivo \}/.test(ler(naoTeste[2])));
  }

  console.log(`\n── placar ${"─".repeat(54)}`);
  console.log(`  PASS ${passou}   FAIL ${falhou}`);
}

function semCaminhoDe(l: LinhaFonteMem): Fonte {
  return {
    id: l.id, userId: l.user_id, agenteId: l.agente_id, conversaId: l.conversa_id,
    escopo: l.escopo as Fonte["escopo"], nome: l.nome, descricao: l.descricao,
    papel: l.papel, tipo: l.tipo as Fonte["tipo"], mime: l.mime,
    tamanhoBytes: l.tamanho_bytes, hashSha256: l.hash_sha256,
    ativo: l.ativo, substituiId: l.substitui_id, criadoEm: l.criado_em,
  };
}

void main().then(
  () => process.exit(falhou > 0 ? 1 : 0),
  (e) => { console.error("ERRO NAO TRATADO:", e); process.exit(1); }
);
