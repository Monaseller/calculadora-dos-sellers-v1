/**
 * AGENT-FACTORY-F4.1 + F5 — fail-closed de ferramenta e FONTES.
 *
 * NAO chama IA, NAO chama rede, NAO chama banco.
 *
 * ── Como o isolamento e provado sem Postgres ────────────────────────
 *
 * Em TRES camadas, de proposito. Provar so com a porta de memoria seria
 * provar a fixture:
 *
 *   1. RESOLVEDOR — uma porta ESPIA registra com que argumentos ele
 *      consulta. Prova que dono e agente SEMPRE entram na pergunta.
 *   2. PORTA REAL — leitura do fonte: toda consulta filtra `user_id` e
 *      `ativo`, e nao existe `obterFonte(id)` sem dono na assinatura.
 *   3. MIGRATION — a FK COMPOSTA (user_id, agente_id) existe, entao o
 *      vinculo cruzado e impossivel no banco, e nao so no codigo.
 *
 * A porta de memoria serve ao caminho ponta a ponta (planilha por
 * fonte), e ela repete os mesmos filtros — o que a camada 2 cobra que
 * a real tambem faz.
 *
 * Rodar:  npx tsx scripts/testar-agentes-fontes.ts
 */
import "./_server-only-inerte";

import { readFileSync, readdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

import { FUNCOES, resolverFuncao, type ContextoFuncao } from "@/lib/agentes/funcoes/registry";
import { autorizarFuncao } from "@/lib/agentes/funcoes/guard";
import { declararFerramentas } from "@/lib/agentes/ia/ferramentas";
import { conversarComFerramentas } from "@/lib/agentes/ia/laco-ferramentas";
import { criarAdaptadorFakeComFerramentas } from "@/lib/agentes/ia/ferramentas-fake";
import {
  CODIGOS_CORRIGIVEIS,
  CODIGOS_DE_FONTE_QUE_FECHAM,
  DESFECHOS_QUE_FECHAM,
  MENSAGEM_POR_CATEGORIA,
  categoriaDoBloqueio,
  classificarFalha,
} from "@/lib/agentes/ia/falhas-de-ferramenta";
import type { FonteComCaminho, NovaFonte, PortaDeFontes } from "@/lib/agentes/fontes/repositorio";
import { criarFonteDeArquivoDasSources, montarContextoDeFontes } from "@/lib/agentes/fontes/resolvedor";
import { receberFonte } from "@/lib/agentes/fontes/upload";
import {
  MAX_BYTES_DA_FONTE,
  conferirMimeReal,
  nomeSeguroDaFonte,
  tipoPelaExtensao,
  validarMetadados,
  type Fonte,
} from "@/lib/agentes/fontes/tipos";
import { montarCaminhoDaFonte } from "@/lib/agentes/fontes/armazenamento";
import type { FatoConexao, FatoFuncao, FatoPermissao } from "@/lib/ia/skills/diagnostico";

const RAIZ = join(__dirname, "..");
const FIXTURES = join(RAIZ, "scripts", "fixtures", "planilhas");

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

// ─── Porta de memoria: repete os filtros da real ──────────────────────

interface LinhaMem extends FonteComCaminho { bytes: Uint8Array }

interface EspiaoDaPorta { consultas: { userId: string; fonteId: string; vinculo: unknown }[] }

/** O que a porta REAL devolve: dominio, sem caminho e sem bytes. */
function soDominio(l: LinhaMem): Fonte {
  const { caminhoObjeto, bytes, ...dominio } = l;
  void caminhoObjeto; void bytes;
  return dominio;
}

function criarPortaMemoria(linhas: LinhaMem[], espiao?: EspiaoDaPorta): PortaDeFontes {
  return {
    async obterAtiva(userId, fonteId, vinculo) {
      espiao?.consultas.push({ userId, fonteId, vinculo });
      return linhas.find((l) =>
        l.userId === userId && l.id === fonteId && l.ativo &&
        (!vinculo ? true
          : "agenteId" in vinculo ? l.agenteId === vinculo.agenteId
          : l.conversaId === vinculo.conversaId)) ?? null;
    },
    // `semDominio` existe porque a porta REAL devolve `Fonte`, e nao
    // `FonteComCaminho`: ela passa por `semCaminho`. Uma fixture que
    // vazasse o caminho provaria menos que a producao entrega — e o
    // assert D8 pegou exatamente isso.
    async listarDoAgente(userId, agenteId) {
      return linhas.filter((l) => l.userId === userId && l.agenteId === agenteId &&
        l.escopo === "agente" && l.ativo).map(soDominio);
    },
    async listarDaConversa(userId, conversaId) {
      return linhas.filter((l) => l.userId === userId && l.conversaId === conversaId &&
        l.escopo === "conversa" && l.ativo).map(soDominio);
    },
    // F9.1-D: como a real — SEM filtro de `ativo`.
    async conversaTemOuTeveAnexo(userId, conversaId) {
      return linhas.some((l) => l.userId === userId && l.conversaId === conversaId &&
        l.escopo === "conversa");
    },
    async criar(nova: NovaFonte) {
      const id = randomUUID();
      const caminho = montarCaminhoDaFonte({
        userId: nova.userId, escopo: nova.escopo,
        vinculoId: (nova.agenteId ?? nova.conversaId) as string,
        fonteId: id, nomeOriginal: nova.nome, tipo: nova.tipo,
      });
      const l: LinhaMem = {
        id, userId: nova.userId, agenteId: nova.agenteId, conversaId: nova.conversaId,
        escopo: nova.escopo, nome: nova.nome, descricao: nova.descricao, papel: nova.papel,
        tipo: nova.tipo, mime: nova.mime, tamanhoBytes: nova.bytes.length,
        hashSha256: nova.hashSha256, caminhoObjeto: caminho, ativo: true,
        substituiId: nova.substituiId, criadoEm: new Date().toISOString(),
        bytes: nova.bytes,
      };
      linhas.push(l);
      return soDominio(l);
    },
    async atualizarMetadado(userId, fonteId, vinculo, campos) {
      // Espelha a porta REAL: escopo por dono + agente + ativo, decidido
      // na PROPRIA busca. Uma fixture mais permissiva que a producao
      // provaria menos do que o sistema entrega — foi assim que o D8
      // passou batido antes.
      if (campos.nome === undefined && campos.papel === undefined &&
          campos.descricao === undefined) {
        return null;
      }
      const l = linhas.find((x) =>
        x.userId === userId && x.id === fonteId &&
        x.agenteId === vinculo.agenteId && x.ativo);
      if (!l) return null;
      if (campos.nome !== undefined) (l as { nome: string }).nome = campos.nome;
      if (campos.papel !== undefined) {
        (l as { papel: string | null }).papel = campos.papel;
      }
      if (campos.descricao !== undefined) {
        (l as { descricao: string | null }).descricao = campos.descricao;
      }
      return soDominio(l);
    },
    async desativar(userId, fonteId) {
      const l = linhas.find((x) => x.userId === userId && x.id === fonteId && x.ativo);
      if (!l) return false;
      (l as { ativo: boolean }).ativo = false;
      return true;
    },
    async lerBytes(caminho) {
      const l = linhas.find((x) => x.caminhoObjeto === caminho);
      if (!l) throw new Error("objeto inexistente");
      return l.bytes;
    },
  };
}

const DONO_A = "dono-a";
const DONO_B = "dono-b";
const AGENTE_1 = "11111111-1111-4111-8111-111111111111";
const AGENTE_2 = "22222222-2222-4222-8222-222222222222";

async function subir(
  porta: PortaDeFontes, userId: string, agenteId: string,
  arquivo: string, papel: string
): Promise<Fonte> {
  const bytes = new Uint8Array(readFileSync(join(FIXTURES, arquivo)));
  const r = await receberFonte(porta, {
    userId, escopo: "agente", agenteId, nome: arquivo,
    descricao: `Planilha de ${papel.toLowerCase()}`, papel, bytes,
  });
  if (!r.ok) throw new Error(`upload falhou: ${r.codigo}`);
  return r.fonte;
}

async function main(): Promise<void> {
  console.log("\n══ CDS IA — F4.1 fail-closed + F5 fontes de agente ══");

  // ═══════════════════════════════════════════════════════════════════
  secao("F4.1-A. Classificacao das falhas REAIS");
  // ═══════════════════════════════════════════════════════════════════
  {
    for (const d of ["negado", "aguardando_aprovacao", "indisponivel",
                     "falha_auditoria", "nome_invalido", "aprovacao_indisponivel"]) {
      ok(`A1  desfecho '${d}' FECHA o turno`, classificarFalha(d) === "fecha_o_turno");
    }
    for (const c of ["fonte_nao_configurada", "arquivo_nao_encontrado",
                     "file_id_invalido", "extensao_nao_suportada", "fonte_indisponivel"]) {
      ok(`A2  codigo de fonte '${c}' FECHA o turno`,
        classificarFalha("erro", c) === "fecha_o_turno");
    }
    for (const c of ["aba_inexistente", "coluna_inexistente", "campo_desconhecido"]) {
      ok(`A3  '${c}' e CORRIGIVEL — o modelo acerta no proximo turno`,
        classificarFalha("erro", c) === "corrigivel");
    }
    ok("A4  DEFAULT e FECHAR: codigo novo nao vira permissao",
      classificarFalha("erro", "codigo_que_ninguem_classificou") === "fecha_o_turno");
    ok("A5  e desfecho desconhecido tambem fecha",
      classificarFalha("desfecho_novo") === "fecha_o_turno");
    ok("A6  CONTROLE: as tres listas nao se sobrepoem",
      CODIGOS_CORRIGIVEIS.every((c) =>
        !(CODIGOS_DE_FONTE_QUE_FECHAM as readonly string[]).includes(c) &&
        !(DESFECHOS_QUE_FECHAM as readonly string[]).includes(c)));
    ok("A7  os codigos sao os REAIS do guard, nao inventados",
      (() => { const G = ler("lib/agentes/funcoes/guard.ts");
        return ["permissao_ausente", "permissao_bloqueada", "conexao_ausente"]
          .every((c) => G.includes(c)); })());
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("F4.1-B. O numero nao verificado, fechado por ESTRUTURA");
  // ═══════════════════════════════════════════════════════════════════
  {
    const ID_CALC = "calculadora.calcular";
    const PROIBIDO = "46719.65";
    const funcoes: FatoFuncao[] = Object.keys(FUNCOES).map((id) => ({ id, existe: true }));
    const conexoes: readonly FatoConexao[] = [];
    const declaradas = declararFerramentas({
      catalogo: FUNCOES, permissoes: [{ funcaoId: ID_CALC, nivel: "automatico" }],
    }).filter((f) => f.nome === ID_CALC);

    const rodar = async (permissoes: FatoPermissao[], falarDepois: string) => {
      let execucoes = 0;
      const porta = async (e: { funcaoId: unknown; argumentos: unknown }) => {
        const id = String(e.funcaoId);
        const g = autorizarFuncao({ funcaoId: e.funcaoId, conexaoNecessaria: null,
          funcoes, permissoes, conexoes });
        if (!g.permitido) {
          return g.estado === "aguardando_aprovacao"
            ? { tipo: "aguardando_aprovacao" as const, requestId: "r", codigo: g.codigo }
            : { tipo: "negado" as const, requestId: "r", codigo: g.codigo };
        }
        execucoes += 1;
        const d = resolverFuncao(id);
        return { tipo: "sucesso" as const, requestId: "r",
          envelope: { data: await d.executor({ userId: DONO_A, conexao: null }, e.argumentos) },
          auditoria: "completa" as const };
      };
      const r = await conversarComFerramentas({
        userId: DONO_A, agenteId: AGENTE_1, instrucao: "use as ferramentas",
        mensagemDoUsuario: "quanto sobra de 184530.20 menos 137810.55?",
        ferramentas: declaradas,
        adaptador: criarAdaptadorFakeComFerramentas([
          { tipo: "pede", pedidos: [{ nome: ID_CALC,
            argumentos: { operacao: "subtract", valores: ["184530.20", "137810.55"] } }] },
          // O fake IMITA o modelo real do F4: ele tentaria responder com
          // o numero calculado de cabeca. Se o laco lhe desse o turno,
          // este texto apareceria — e e exatamente o que nao pode.
          { tipo: "fala", texto: falarDepois },
        ]),
        executar: porta as never,
      });
      return { r, execucoes };
    };

    for (const [rotulo, permissoes] of [
      ["sem permissao", [] as FatoPermissao[]],
      ["bloqueado", [{ funcaoId: ID_CALC, nivel: "bloqueado" }] as FatoPermissao[]],
      ["aprovacao pendente", [{ funcaoId: ID_CALC, nivel: "aprovacao" }] as FatoPermissao[]],
    ] as [string, FatoPermissao[]][]) {
      const { r, execucoes } = await rodar(permissoes,
        `Nao consegui usar a ferramenta, mas a conta da R$ ${PROIBIDO}.`);
      ok(`B1  ${rotulo}: functionExecutions = 0`, execucoes === 0, String(execucoes));
      ok(`B2  ${rotulo}: motivo = bloqueado_por_ferramenta`,
        r.motivo === "bloqueado_por_ferramenta", r.motivo);
      ok(`B3  ${rotulo}: ${PROIBIDO} NAO aparece em lugar nenhum`,
        !JSON.stringify(r.mensagens).includes(PROIBIDO) && !(r.texto ?? "").includes(PROIBIDO),
        String(r.texto).slice(0, 90));
      // Ver a nota da F7b.4.8.1 no topo deste arquivo: o texto do runtime
      // passou a ter uma versao por CATEGORIA, e o assert cobra a certa.
      ok(`B4  ${rotulo}: o texto e do RUNTIME, na categoria certa`,
        r.bloqueio !== null &&
          r.texto === MENSAGEM_POR_CATEGORIA[
            categoriaDoBloqueio(r.bloqueio.desfecho, r.bloqueio.codigo)],
        `${String(r.bloqueio?.categoria)} / ${String(r.texto).slice(0, 60)}`);
      ok(`B5  ${rotulo}: o bloqueio diz qual Funcao e qual desfecho`,
        r.bloqueio !== null && r.bloqueio.funcaoId === ID_CALC);
    }

    // CONTROLE ANTI-VACUIDADE: com permissao, o mesmo roteiro CHEGA ao
    // numero — logo o teste acima distingue de verdade.
    {
      const { r, execucoes } = await rodar(
        [{ funcaoId: ID_CALC, nivel: "automatico" }],
        `Sobra R$ ${PROIBIDO}.`);
      ok("B6  CONTROLE: COM permissao a Tool roda", execucoes === 1, String(execucoes));
      ok("B7  CONTROLE: e ai sim o numero aparece — o teste distingue",
        (r.texto ?? "").includes(PROIBIDO), String(r.texto).slice(0, 90));
      ok("B8  CONTROLE: e o numero veio da TOOL",
        JSON.stringify(r.mensagens).includes(PROIBIDO) && r.motivo === "concluido");
    }

    // Fonte ausente tambem fecha. F9.1: "ausente" e o contexto sem
    // `fonteDeArquivo` — nao ha mais registro de modulo a zerar.
    {
      let execucoes = 0;
      const porta = async (e: { funcaoId: unknown; argumentos: unknown }) => {
        execucoes += 1;
        const d = resolverFuncao(String(e.funcaoId));
        const bruto = await d.executor({ userId: DONO_A, conexao: null }, e.argumentos);
        const i = d.interpretarSaida(bruto);
        return i.tipo === "erro"
          ? { tipo: "erro" as const, requestId: "r", codigo: i.codigo, retryable: i.retryable }
          : { tipo: "sucesso" as const, requestId: "r", envelope: { data: bruto },
              auditoria: "completa" as const };
      };
      const decl = declararFerramentas({ catalogo: FUNCOES,
        permissoes: [{ funcaoId: "planilha.agregar", nivel: "automatico" }] })
        .filter((f) => f.nome === "planilha.agregar");
      const r = await conversarComFerramentas({
        userId: DONO_A, agenteId: AGENTE_1, instrucao: "x",
        mensagemDoUsuario: "some a coluna Valor",
        ferramentas: decl,
        adaptador: criarAdaptadorFakeComFerramentas([
          { tipo: "pede", pedidos: [{ nome: "planilha.agregar",
            argumentos: { fileId: "qualquer", operacao: "sum", coluna: "Valor" } }] },
          { tipo: "fala", texto: "O total e R$ 99.999,99." },
        ]),
        executar: porta as never,
      });
      ok("B9  FONTE ausente tambem fecha o turno",
        r.motivo === "bloqueado_por_ferramenta", r.motivo);
      ok("B10 e nenhum total fabricado sai",
        !(r.texto ?? "").includes("99.999,99") &&
          r.bloqueio !== null &&
          r.texto === MENSAGEM_POR_CATEGORIA[
            categoriaDoBloqueio(r.bloqueio.desfecho, r.bloqueio.codigo)],
        `${String(r.bloqueio?.categoria)} / ${String(r.texto).slice(0, 60)}`);
      ok("B10a e a categoria dela e FONTE — e nao falta de permissao",
        r.bloqueio !== null &&
          categoriaDoBloqueio(r.bloqueio.desfecho, r.bloqueio.codigo) === "fonte",
        String(r.bloqueio?.categoria));
      ok("B11 a Funcao chegou a ser chamada, mas nao produziu dado",
        execucoes === 1, String(execucoes));
    }

    // Falha CORRIGIVEL NAO fecha — senao seria fallback ao contrario.
    {
      const decl = declararFerramentas({ catalogo: FUNCOES,
        permissoes: [{ funcaoId: "calendario.periodo", nivel: "automatico" }] })
        .filter((f) => f.nome === "calendario.periodo");
      const porta = async (e: { funcaoId: unknown; argumentos: unknown }) => {
        const d = resolverFuncao(String(e.funcaoId));
        const v = d.validarEntrada(e.argumentos);
        if (!v.valida) {
          return { tipo: "erro" as const, requestId: "r", codigo: v.codigo, retryable: false };
        }
        return { tipo: "sucesso" as const, requestId: "r",
          envelope: { data: await d.executor({ userId: DONO_A, conexao: null }, e.argumentos) },
          auditoria: "completa" as const };
      };
      const r = await conversarComFerramentas({
        userId: DONO_A, agenteId: AGENTE_1, instrucao: "x", mensagemDoUsuario: "qual o periodo?",
        ferramentas: decl,
        adaptador: criarAdaptadorFakeComFerramentas([
          { tipo: "pede", pedidos: [{ nome: "calendario.periodo",
            argumentos: { periodo: "semana_que_vem" } }] },   // invalido
          { tipo: "pede", pedidos: [{ nome: "calendario.periodo",
            argumentos: { periodo: "este_mes" } }] },          // corrigido
          { tipo: "fala", texto: "pronto" },
        ]),
        executar: porta as never,
      });
      ok("B12 argumento invalido NAO fecha — o modelo corrige e segue",
        r.motivo === "concluido" && r.passos.length === 2, `${r.motivo}/${r.passos.length}`);
      ok("B13 e o segundo passo deu certo", r.passos[1].desfecho === "sucesso");
    }

    const FALHAS = semComentarios(ler("lib/agentes/ia/falhas-de-ferramenta.ts"));
    ok("B14 NENHUMA das frases de bloqueio vaza causa tecnica ao usuario",
      Object.values(MENSAGEM_POR_CATEGORIA).every((m) =>
        !/permissao_|fonte_|auditoria/.test(m)),
      Object.values(MENSAGEM_POR_CATEGORIA).join(" | ").slice(0, 120));
    ok("B15 e o modulo diz que PROMPT nao e a cerca",
      /INSTRUCAO_SEM_ESTIMATIVA/.test(FALHAS));
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("F5-C. Upload: validacao antes de qualquer byte guardado");
  // ═══════════════════════════════════════════════════════════════════
  {
    ok("C1  extensao decide o tipo", tipoPelaExtensao("a.xlsx") === "xlsx" &&
      tipoPelaExtensao("b.CSV") === "csv");
    ok("C2  .xls e RECUSADO", tipoPelaExtensao("c.xls") === null);
    ok("C3  executavel recusado", tipoPelaExtensao("d.exe") === null);
    ok("C4  sem extensao recusado", tipoPelaExtensao("semextensao") === null);

    ok("C5  nome seguro nao carrega caminho",
      nomeSeguroDaFonte("../../etc/passwd.csv", "csv") === "etc_passwd.csv",
      nomeSeguroDaFonte("../../etc/passwd.csv", "csv"));
    ok("C6  e nem barra invertida nem dois-pontos",
      !/[\\/:]/.test(nomeSeguroDaFonte("C:\\Windows\\x.xlsx", "xlsx")),
      nomeSeguroDaFonte("C:\\Windows\\x.xlsx", "xlsx"));
    ok("C7  nome vazio vira um nome, nao string vazia",
      nomeSeguroDaFonte("...", "csv") === "fonte.csv", nomeSeguroDaFonte("...", "csv"));

    const base = { nome: "a.xlsx", tamanhoBytes: 10, escopo: "agente", agenteId: AGENTE_1 };
    ok("C8  metadados validos passam", validarMetadados(base).ok === true);
    ok("C9  tamanho acima do limite recusado",
      (() => { const r = validarMetadados({ ...base, tamanhoBytes: MAX_BYTES_DA_FONTE + 1 });
        return !r.ok && r.codigo === "tamanho_acima_do_limite"; })());
    ok("C10 arquivo vazio recusado",
      (() => { const r = validarMetadados({ ...base, tamanhoBytes: 0 });
        return !r.ok && r.codigo === "tamanho_invalido"; })());
    ok("C11 fonte de agente SEM agente recusada",
      (() => { const r = validarMetadados({ ...base, agenteId: undefined });
        return !r.ok && r.codigo === "agente_ausente"; })());
    ok("C12 vinculo incoerente recusado",
      (() => { const r = validarMetadados({ ...base, conversaId: "c1" });
        return !r.ok && r.codigo === "vinculo_incoerente"; })());
    ok("C13 anexo de conversa exige conversa",
      (() => { const r = validarMetadados({ nome: "a.csv", tamanhoBytes: 5,
          escopo: "conversa" }); return !r.ok && r.codigo === "conversa_ausente"; })());
    ok("C14 o limite e 5 MB, e nao um numero qualquer",
      MAX_BYTES_DA_FONTE === 5 * 1024 * 1024);

    ok("C15 MIME real de .xlsx e zip — e isso e ACEITO",
      conferirMimeReal("xlsx", "application/zip").ok === true);
    ok("C16 .xlsx sem assinatura de zip e RECUSADO",
      conferirMimeReal("xlsx", null).ok === false);
    ok("C17 imagem renomeada para .xlsx e recusada",
      conferirMimeReal("xlsx", "image/png").ok === false);
    ok("C18 .csv sem assinatura e o normal",
      conferirMimeReal("csv", null).ok === true);
    ok("C19 binario renomeado para .csv e recusado",
      conferirMimeReal("csv", "application/zip").ok === false);
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("F5-D. Criar, listar, desativar, substituir");
  // ═══════════════════════════════════════════════════════════════════
  const linhas: LinhaMem[] = [];
  const porta = criarPortaMemoria(linhas);
  let entradas: Fonte;
  let saidas: Fonte;
  {
    entradas = await subir(porta, DONO_A, AGENTE_1, "entrada.xlsx", "Entradas");
    saidas = await subir(porta, DONO_A, AGENTE_1, "saida.xlsx", "Saidas");
    ok("D1  .xlsx aceito e registrado", entradas.tipo === "xlsx" && entradas.ativo);
    ok("D2  o papel e metadata LIVRE do dono, nao enum do sistema",
      entradas.papel === "Entradas" && saidas.papel === "Saidas");
    ok("D3  o sistema NAO conhece 'Entradas'/'Saidas' no codigo",
      !/["']Entradas["']|["']Saidas["']/.test(ler("lib/agentes/fontes/tipos.ts")));
    ok("D4  hash sha256 gravado", /^[0-9a-f]{64}$/.test(entradas.hashSha256));
    ok("D5  e o hash bate com o arquivo",
      entradas.hashSha256 ===
        createHash("sha256").update(readFileSync(join(FIXTURES, "entrada.xlsx"))).digest("hex"));

    const csv = await subir(porta, DONO_A, AGENTE_1, "movimentos.csv", "Movimentos");
    ok("D6  .csv aceito", csv.tipo === "csv");

    const lista = await porta.listarDoAgente(DONO_A, AGENTE_1);
    ok("D7  listagem traz as tres", lista.length === 3, String(lista.length));
    ok("D8  e NENHUMA carrega caminho fisico",
      lista.every((f) => !("caminhoObjeto" in f)), JSON.stringify(Object.keys(lista[0])));

    ok("D9  desativar funciona", (await porta.desativar(DONO_A, csv.id)) === true);
    ok("D10 e a fonte some da listagem",
      (await porta.listarDoAgente(DONO_A, AGENTE_1)).length === 2);
    ok("D11 desativar de OUTRO dono nao faz nada",
      (await porta.desativar(DONO_B, entradas.id)) === false);
    ok("D12 desativar NAO apaga — o registro segue para auditoria",
      linhas.some((l) => l.id === csv.id));

    const bytes = new Uint8Array(readFileSync(join(FIXTURES, "saida.xlsx")));
    const sub = await receberFonte(porta, { userId: DONO_A, escopo: "agente",
      agenteId: AGENTE_1, nome: "entrada.xlsx", papel: "Entradas", bytes,
      substituiId: entradas.id });
    ok("D13 substituicao cria NOVA fonte, nao sobrescreve",
      sub.ok && sub.fonte.id !== entradas.id && sub.fonte.substituiId === entradas.id);
    ok("D14 e a antiga continua existindo com o hash dela",
      linhas.find((l) => l.id === entradas.id)?.hashSha256 === entradas.hashSha256);
    await porta.desativar(DONO_A, sub.ok ? sub.fonte.id : "");
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("F5-E. Isolamento — as tres camadas");
  // ═══════════════════════════════════════════════════════════════════
  {
    // Camada 1: o RESOLVEDOR sempre pergunta com dono e agente.
    const espiao: EspiaoDaPorta = { consultas: [] };
    const espiada = criarPortaMemoria(linhas, espiao);
    const res = criarFonteDeArquivoDasSources({
      porta: espiada, userId: DONO_A, agenteId: AGENTE_1 });
    await res.resolver(DONO_A, entradas.id);
    ok("E1  o resolvedor consulta com o dono da SESSAO",
      espiao.consultas.length >= 1 && espiao.consultas[0].userId === DONO_A);
    ok("E2  e com o agente do runtime",
      JSON.stringify(espiao.consultas[0].vinculo) === JSON.stringify({ agenteId: AGENTE_1 }));

    ok("E3  dono divergente entre sessao e chamada = null",
      (await res.resolver(DONO_B, entradas.id)) === null);
    ok("E4  fonte de OUTRO dono nao resolve",
      (await criarFonteDeArquivoDasSources({ porta: espiada, userId: DONO_B,
        agenteId: AGENTE_1 }).resolver(DONO_B, entradas.id)) === null);
    ok("E5  fonte de OUTRO agente do MESMO dono nao resolve",
      (await criarFonteDeArquivoDasSources({ porta: espiada, userId: DONO_A,
        agenteId: AGENTE_2 }).resolver(DONO_A, entradas.id)) === null);
    ok("E6  CONTROLE: o agente certo RESOLVE — 'tudo null' nao e prova",
      (await res.resolver(DONO_A, entradas.id)) !== null);

    for (const hostil of ["../entrada.xlsx", "/etc/passwd", "C:\\x.xlsx",
                          "\\\\servidor\\x", "file:///etc/passwd", "entrada.xlsx",
                          "..%2f..%2f", "", "nao-e-uuid"]) {
      ok(`E7  '${hostil.slice(0, 22)}' nao resolve`,
        (await res.resolver(DONO_A, hostil)) === null);
    }
    ok("E8  id com forma de UUID mas inexistente tambem nao resolve",
      (await res.resolver(DONO_A, randomUUID())) === null);

    const desativada = linhas.find((l) => !l.ativo);
    ok("E9  fonte DESATIVADA nao resolve",
      desativada !== undefined && (await res.resolver(DONO_A, desativada.id)) === null);

    // Camada 2: a porta REAL filtra sempre.
    const REPO = semComentarios(ler("lib/agentes/fontes/repositorio.ts"));
    // O corpo de cada operacao, ate o proximo `async`. Separar LEITURA
    // de ESCRITA importa: `criar` e um INSERT — ele nao tem `eq`, ele
    // GRAVA o `user_id` no payload. Cobrar `eq` dele acusaria uma falha
    // que nao existe, e foi o que a primeira versao deste assert fez.
    const corpos = REPO.split("from(TABELA)").slice(1)
      .map((c) => c.split("\n    async ")[0]);
    const leituras = corpos.filter((c) => c.includes("select(COLUNAS)") && !c.includes(".insert("));
    const escritas = corpos.filter((c) => c.includes(".insert(") || c.includes(".update("));
    ok("E10 TODA LEITURA da porta real filtra user_id",
      leituras.length >= 3 && leituras.every((c) => c.includes('eq("user_id"')),
      `leituras=${leituras.length}`);
    ok("E10a e toda ESCRITA amarra o dono — por `eq` ou gravando a coluna",
      escritas.length >= 2 &&
        escritas.every((c) => c.includes('eq("user_id"') || c.includes("user_id: nova.userId")),
      `escritas=${escritas.length}`);
    ok("E11 e as leituras filtram `ativo`",
      leituras.every((c) => c.includes('"ativo", true')), `leituras=${leituras.length}`);
    ok("E12 nao existe leitura sem dono na ASSINATURA",
      !/obterAtiva\(\s*fonteId/.test(REPO) && /obterAtiva\(userId/.test(REPO));
    ok("E13 CONTROLE: o detector veria uma consulta sem user_id",
      !"from(TABELA).select(COLUNAS).eq(\"id\", x)".includes('eq("user_id"'));

    // Camada 3: a MIGRATION torna o vinculo cruzado impossivel.
    const MIG = ler("supabase/migrations/20261016_agente_fontes.sql");
    ok("E14 a FK e COMPOSTA (user_id, agente_id) -> agentes (user_id, id)",
      /foreign key \(user_id, agente_id\)[\s\S]{0,80}references public\.agentes \(user_id, id\)/i
        .test(MIG));
    ok("E15 e a substituicao tambem e amarrada ao dono",
      /foreign key \(user_id, substitui_id\)/i.test(MIG));
    ok("E16 o CHECK de vinculo impede agente+conversa ao mesmo tempo",
      /agente_fontes_vinculo_coerente/.test(MIG));
    ok("E17 a migration e ADITIVA — nenhum ALTER/DROP de tabela existente",
      !/alter table|drop table|drop column/i.test(MIG));
    ok("E18 e nao mexe em migration historica",
      readdirSync(join(RAIZ, "supabase/migrations"))
        .filter((f) => f.startsWith("20261016")).length === 1);
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("F5-F. Planilha PELA fonte — nenhum path no teste");
  // ═══════════════════════════════════════════════════════════════════
  {
    const res = criarFonteDeArquivoDasSources({
      porta, userId: DONO_A, agenteId: AGENTE_1 });

    // F9.1: a fonte vai no CONTEXTO da chamada, e nao num registro global.
    const chamar = async (id: string, args: unknown, fonte = res) => {
      const ctx: ContextoFuncao = Object.freeze({
        userId: DONO_A, conexao: null, fonteDeArquivo: fonte });
      const d = resolverFuncao(id);
      const v = d.validarEntrada(args);
      if (!v.valida) return { ok: false, codigo: v.codigo } as Record<string, unknown>;
      return (await d.executor(ctx, args)) as Record<string, unknown>;
    };

    const insp = await chamar("planilha.inspecionar", { fileId: entradas.id });
    ok("F1  inspecionar funciona PELA fonte", insp.ok === true, JSON.stringify(insp).slice(0, 120));
    ok("F2  e o nome que volta e o LOGICO, nao um caminho",
      JSON.stringify(insp.arquivo).includes("entrada.xlsx"));
    ok("F3  NENHUM caminho de storage na resposta",
      !/agente-fontes|dono-a\/agente|caminhoObjeto/.test(JSON.stringify(insp)));

    const lido = await chamar("planilha.ler", { fileId: entradas.id, limite: 2 });
    ok("F4  ler funciona pela fonte", lido.ok === true && (lido.linhas as string[][]).length === 2);

    const soma = await chamar("planilha.agregar", {
      fileId: entradas.id, operacao: "sum", coluna: "Valor",
      filtros: [{ coluna: "Data", operador: "entre", valor: "2026-09-01", ate: "2026-09-30" },
                { coluna: "Categoria", operador: "diferente", valor: "controle" }],
    });
    ok("F5  ENTRADAS de setembro = 4969.12 pela fonte", soma.valor === "4969.12",
      String(soma.valor));
    ok("F6  a proveniencia traz o fileId AUTORIZADO",
      (soma.proveniencia as Record<string, unknown>).fileId === entradas.id);
    ok("F7  e nao traz caminho fisico",
      !/agente-fontes|\/agente\//.test(JSON.stringify(soma.proveniencia)));

    const somaSaidas = await chamar("planilha.agregar", {
      fileId: saidas.id, operacao: "sum", coluna: "Valor",
      filtros: [{ coluna: "Data", operador: "entre", valor: "2026-09-01", ate: "2026-09-30" }],
    });
    ok("F8  SAIDAS de setembro = 2600.50 pela fonte", somaSaidas.valor === "2600.50",
      String(somaSaidas.valor));

    const saldo = await chamar("calculadora.calcular",
      { operacao: "subtract", valores: ["4969.12", "2600.50"] });
    ok("F9  SALDO = 2368.62", (saldo as { resultado?: string }).resultado === "2368.62",
      JSON.stringify(saldo));

    // A fonte de OUTRO agente, pedida pela Tool, morre ANTES da leitura.
    const resOutro = criarFonteDeArquivoDasSources({
      porta, userId: DONO_A, agenteId: AGENTE_2 });
    const negado = await chamar("planilha.inspecionar", { fileId: entradas.id }, resOutro);
    ok("F10 fonte de outro agente morre ANTES de ler bytes",
      negado.ok === false && negado.codigo === "arquivo_nao_encontrado",
      JSON.stringify(negado));

    // O arquivo original nao foi tocado.
    ok("F11 a fixture original continua byte-identica",
      createHash("sha256").update(readFileSync(join(FIXTURES, "entrada.xlsx"))).digest("hex")
        === entradas.hashSha256);
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("F5-G. Contexto para o modelo e persistencia");
  // ═══════════════════════════════════════════════════════════════════
  {
    const lista = await porta.listarDoAgente(DONO_A, AGENTE_1);
    const ctx = montarContextoDeFontes(lista);
    ok("G1  o contexto cita nome e papel", ctx.texto.includes("entrada.xlsx") &&
      ctx.texto.includes("Entradas"));
    ok("G2  e o id, para o modelo poder pedir", ctx.texto.includes(entradas.id));
    ok("G3  NAO manda bytes nem conteudo da planilha",
      !ctx.texto.includes("Venda balcao") && ctx.texto.length < 1200,
      String(ctx.texto.length));
    ok("G4  NAO manda hash, tamanho nem caminho",
      !ctx.texto.includes(entradas.hashSha256) && !/agente-fontes/.test(ctx.texto));
    ok("G5  sem fontes, texto VAZIO — nao uma frase negativa",
      montarContextoDeFontes([]).texto === "");
    ok("G6  o que vai ao modelo tem exatamente 5 campos",
      ctx.fontes.every((f) => Object.keys(f).length === 5 &&
        !("userId" in f) && !("hashSha256" in f)));

    // Persistencia: outra "sessao" = outro resolvedor, mesma porta.
    const outraSessao = criarFonteDeArquivoDasSources({
      porta, userId: DONO_A, agenteId: AGENTE_1 });
    const aindaLa = await outraSessao.resolver(DONO_A, entradas.id);
    ok("G7  a fonte sobrevive a uma nova sessao/resolvedor", aindaLa !== null);
    ok("G8  e continua sendo o mesmo arquivo",
      aindaLa !== null && createHash("sha256").update(aindaLa.bytes).digest("hex")
        === entradas.hashSha256);

    // Anexo de conversa: escopo diferente, mesma maquinaria.
    const bytesCsv = new Uint8Array(readFileSync(join(FIXTURES, "movimentos.csv")));
    const anexo = await receberFonte(porta, { userId: DONO_A, escopo: "conversa",
      conversaId: "conversa-1", nome: "movimentos.csv", bytes: bytesCsv });
    ok("G9  anexo de conversa e aceito", anexo.ok === true);
    ok("G10 e NAO aparece entre as fontes do agente",
      !(await porta.listarDoAgente(DONO_A, AGENTE_1)).some(
        (f) => anexo.ok && f.id === anexo.fonte.id));
    ok("G11 mas aparece na conversa dele",
      (await porta.listarDaConversa(DONO_A, "conversa-1")).length === 1);
    ok("G12 o resolvedor SEM conversa nao alcanca o anexo",
      anexo.ok && (await criarFonteDeArquivoDasSources({ porta, userId: DONO_A,
        agenteId: AGENTE_1 }).resolver(DONO_A, anexo.fonte.id)) === null);
    ok("G13 com a conversa declarada, alcanca",
      anexo.ok && (await criarFonteDeArquivoDasSources({ porta, userId: DONO_A,
        agenteId: AGENTE_1, conversaId: "conversa-1" }).resolver(DONO_A, anexo.fonte.id)) !== null);
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("F5-H. Nenhuma credencial, nenhum caminho, nenhum registry novo");
  // ═══════════════════════════════════════════════════════════════════
  {
    const RES = semComentarios(ler("lib/agentes/fontes/resolvedor.ts"));
    ok("H1  o resolvedor nao conhece filesystem",
      !/node:fs|readFile|path\.join/.test(RES));
    ok("H2  nem bucket nem credencial",
      !/SERVICE_ROLE|SUPABASE_|createClient|BUCKET/.test(RES));
    const TIPOS = ler("lib/agentes/fontes/tipos.ts");
    ok("H3  o tipo de dominio NAO tem caminhoObjeto",
      !/caminhoObjeto/.test(TIPOS.slice(TIPOS.indexOf("export interface Fonte"),
        TIPOS.indexOf("export interface FonteParaModelo"))));
    ok("H4  o contexto do modelo tambem nao",
      !/caminhoObjeto|hashSha256|userId/.test(
        TIPOS.slice(TIPOS.indexOf("export interface FonteParaModelo"),
          TIPOS.indexOf("export function paraModelo"))));
    // `semComentarios`: o cabecalho deste modulo EXPLICA por que nao ha
    // `createBucket`, e a palavra aparece la. Medir o texto inteiro
    // acusaria a explicacao como se fosse o codigo.
    const ARM = semComentarios(ler("lib/agentes/fontes/armazenamento.ts"));
    ok("H5  o bucket NAO e publico e nao ha URL publica",
      !/getPublicUrl|public: true/.test(ARM));
    ok("H6  o caminho e prefixado pelo DONO, sempre",
      /\$\{entrada\.userId\}\//.test(ARM));
    ok("H7  o modulo nao cria nem reconfigura bucket",
      !/createBucket|updateBucket/.test(ARM));
    ok("H7a CONTROLE: o detector veria a chamada se ela existisse",
      /createBucket/.test(`${ARM} supabase.storage.createBucket(x)`));

    // §32: F5 nao acrescentou Function — e continua nao tendo
    // acrescentado. O que mudou foi o catalogo INTEIRO: a F7b.4.8
    // publicou `mercadolivre.vendas.consultar`, com gate proprio, prova
    // propria e suite propria.
    //
    // A assercao conta o catalogo, e nao "o que a F5 fez". Por isso ela
    // volta a ser exata num numero novo, em vez de virar `>= 7` — um
    // limite inferior deixaria de acusar a Function que entra sem gate,
    // que e o que ela existe para acusar.
    const ids = Object.keys(FUNCOES);
    ok("H8  o catalogo segue EXATO — oito Funcoes, todas com gate proprio",
      ids.length === 8, String(ids.length));
    ok("H8a e `source.*` continua nao existindo — era o risco desta fase",
      !ids.some((i) => i.startsWith("source.")));
    ok("H9  e nao existe `source.ler` — planilha.ler + resolvedor bastam",
      !ids.some((i) => i.startsWith("source.")));
    const linhasReg = ler("lib/agentes/funcoes/registry.ts").split("\n").length;
    // F7b.4.8: 560 -> 580, e 548 -> 568. A razao esta registrada em
    // `testar-ia-skill-1d-b.ts` (J1), que e o dono do tripwire: ele
    // existe para manter implementacao FORA do registry, e o que sobrou
    // la e o mapa. A entrada nova cabe; um executor nao caberia.
    // F9.1: 568 -> 577 — um CAMPO de `ContextoFuncao` (`fonteDeArquivo`)
    // e o import do tipo. Nenhuma implementacao entrou; o teto 580 segue.
    ok("H10 J1 intacto", linhasReg < 580 && linhasReg === 577, String(linhasReg));
  }

  console.log(`\n── placar ${"─".repeat(54)}`);
  console.log(`  PASS ${passou}   FAIL ${falhou}`);
}

void main().then(
  () => process.exit(falhou > 0 ? 1 : 0),
  (e) => { console.error("ERRO NAO TRATADO:", e); process.exit(1); }
);
