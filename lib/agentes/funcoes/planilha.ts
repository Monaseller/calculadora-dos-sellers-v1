/**
 * `planilha.inspecionar`, `planilha.ler`, `planilha.agregar` —
 * AGENT-FACTORY-F3.
 *
 * ── Tres Funcoes, e nao uma com um campo `modo` ─────────────────────
 *
 * Elas devolvem coisas diferentes e merecem permissoes diferentes: um
 * agente pode ter direito de CONTAR sem ter direito de VER as linhas.
 * Com um campo `modo`, essa distincao teria de morar dentro do
 * executor, depois do guard — que e tarde demais.
 *
 * ── Por que INSPECIONAR existe antes de LER ─────────────────────────
 *
 * Sem ela, a primeira coisa que o modelo faz e pedir a planilha
 * inteira, para descobrir o que ha nela. Isso e caro, lento e
 * geralmente inutil. `inspecionar` responde "quais abas, quais colunas,
 * quantas linhas" em algumas dezenas de bytes, e a partir dai o pedido
 * seguinte ja e especifico.
 *
 * ── A fonte do arquivo e uma PORTA ──────────────────────────────────
 *
 * A infraestrutura de upload/Sources ainda nao existe — e gate proprio.
 * Ate la o default NEGA: `fonte_nao_configurada`. Nao ha leitura de
 * filesystem aqui, nao ha caminho, e a producao nao passa a ler por
 * acidente so porque alguem esqueceu de ligar alguma coisa.
 */
import "server-only";
import { abrirArquivo } from "@/lib/agentes/planilhas/fonte";
import { ErroPlanilha, lerCsv, lerXlsx } from "@/lib/agentes/planilhas/leitura";
import {
  MAX_ABAS_INSPECIONADAS,
  MAX_CELULAS_POR_LEITURA,
  MAX_LINHAS_POR_LEITURA,
  acharAba,
  cabecalhos,
  celulaVazia,
  larguraDaAba,
  linhasDeDado,
  pareceFormulaEmTexto,
  textoDaCelula,
  type Aba,
  type Pasta,
} from "@/lib/agentes/planilhas/tabela";
import { agregar, type Filtro, type Operacao } from "@/lib/agentes/planilhas/agregacao";
import { inferirOrdem } from "@/lib/agentes/planilhas/datas";
import type {
  ContextoFuncao,
  ResultadoInterpretacaoSaida,
  ResultadoValidacaoEntrada,
} from "@/lib/agentes/funcoes/registry";

// ─── A porta ──────────────────────────────────────────────────────────
//
// A fonte de arquivo chega em `contexto.fonteDeArquivo`, montada por quem
// conhece a sessao, e vale so para ESTA chamada — F9.1. Nao ha variavel
// de modulo: ela era sobrescrita a cada turno, e dois turnos concorrentes
// na mesma instancia trocavam de resolvedor no meio de um `await`.
//
// Sem fonte no contexto, o default continua NEGANDO
// (`fonte_nao_configurada`): quem nao recebeu fonte, nao le.

/** Erro de dominio desta frente, no formato que o interpretador espera. */
interface FalhaPlanilha {
  readonly ok: false;
  readonly codigo: string;
  readonly mensagem: string;
}

function falha(codigo: string, mensagem: string): FalhaPlanilha {
  return { ok: false, codigo, mensagem };
}

async function abrirPasta(
  contexto: ContextoFuncao,
  fileId: unknown
): Promise<{ pasta: Pasta; nome: string; fileId: string } | FalhaPlanilha> {
  const fonte = contexto.fonteDeArquivo ?? null;
  if (fonte === null) {
    return falha("fonte_nao_configurada", "Nao ha fonte de arquivos configurada neste ambiente.");
  }
  const aberto = await abrirArquivo(fonte, contexto.userId, fileId);
  if (aberto.tipo === "erro") return falha(aberto.codigo, aberto.mensagem);

  const arq = aberto.arquivo;
  try {
    const pasta = arq.extensao === "csv" ? lerCsv(arq.bytes, arq.nome) : lerXlsx(arq.bytes);
    return { pasta, nome: arq.nome, fileId: arq.fileId };
  } catch (e) {
    if (e instanceof ErroPlanilha) return falha(e.codigo, "Nao foi possivel ler o arquivo.");
    return falha("arquivo_ilegivel", "Nao foi possivel ler o arquivo.");
  }
}

// ─── planilha.inspecionar ─────────────────────────────────────────────

export function validarEntradaInspecionar(argumentos: unknown): ResultadoValidacaoEntrada {
  if (typeof argumentos !== "object" || argumentos === null || Array.isArray(argumentos)) {
    return { valida: false, codigo: "entrada_nao_objeto" };
  }
  const a = argumentos as Record<string, unknown>;
  for (const k of Object.keys(a)) {
    if (k !== "fileId") return { valida: false, codigo: "campo_desconhecido" };
  }
  if (typeof a.fileId !== "string" || a.fileId === "") {
    return { valida: false, codigo: "file_id_ausente" };
  }
  return { valida: true };
}

export async function executarInspecionar(
  contexto: ContextoFuncao,
  argumentos: unknown
): Promise<unknown> {
  const aberto = await abrirPasta(contexto, (argumentos as { fileId?: unknown }).fileId);
  if ("ok" in aberto) return aberto;

  const abas = aberto.pasta.abas.slice(0, MAX_ABAS_INSPECIONADAS).map((aba) => {
    let comFormula = 0;
    let textoQuePareceFormula = 0;
    for (const linha of aba.linhas) {
      for (const c of linha) {
        if (c.formula !== null) comFormula += 1;
        else if (pareceFormulaEmTexto(c.bruto)) textoQuePareceFormula += 1;
      }
    }
    const heads = cabecalhos(aba);
    const ordens = heads.map((_, i) =>
      inferirOrdem(aba.linhas.slice(1).map((l) => l[i]?.bruto ?? null))
    );
    return {
      nome: aba.nome,
      linhas: linhasDeDado(aba),
      colunas: larguraDaAba(aba),
      cabecalhos: heads,
      formulasPresentes: comFormula > 0,
      celulasComFormula: comFormula,
      colunasComDataAmbigua: heads.filter((_, i) => ordens[i].ambiguo),
      textoQuePareceFormula,
    };
  });

  const avisos: string[] = [];
  if (aberto.pasta.abas.length > MAX_ABAS_INSPECIONADAS) {
    avisos.push(`A pasta tem ${aberto.pasta.abas.length} abas; foram descritas ${MAX_ABAS_INSPECIONADAS}.`);
  }
  if (abas.some((a) => a.formulasPresentes)) {
    // Dito uma vez, com todas as letras: nenhum recalculo acontece.
    avisos.push("Ha formulas. Os valores vem do que o Excel gravou; nada foi recalculado.");
  }
  if (abas.some((a) => a.textoQuePareceFormula > 0)) {
    avisos.push("Ha celulas de TEXTO comecando por = + - @; foram lidas como texto, nunca executadas.");
  }

  return {
    ok: true,
    arquivo: { fileId: aberto.fileId, nome: aberto.nome },
    abas,
    avisos,
  };
}

// ─── planilha.ler ─────────────────────────────────────────────────────

export function validarEntradaLer(argumentos: unknown): ResultadoValidacaoEntrada {
  if (typeof argumentos !== "object" || argumentos === null || Array.isArray(argumentos)) {
    return { valida: false, codigo: "entrada_nao_objeto" };
  }
  const a = argumentos as Record<string, unknown>;
  const conhecidos = ["fileId", "aba", "colunas", "limite", "inicio"];
  for (const k of Object.keys(a)) {
    if (!conhecidos.includes(k)) return { valida: false, codigo: "campo_desconhecido" };
  }
  if (typeof a.fileId !== "string" || a.fileId === "") {
    return { valida: false, codigo: "file_id_ausente" };
  }
  if (a.aba !== undefined && typeof a.aba !== "string") {
    return { valida: false, codigo: "aba_invalida" };
  }
  if (a.colunas !== undefined &&
      (!Array.isArray(a.colunas) || a.colunas.some((c) => typeof c !== "string"))) {
    return { valida: false, codigo: "colunas_invalidas" };
  }
  if (a.limite !== undefined &&
      (typeof a.limite !== "number" || !Number.isInteger(a.limite) || a.limite < 1)) {
    return { valida: false, codigo: "limite_invalido" };
  }
  if (a.limite !== undefined && (a.limite as number) > MAX_LINHAS_POR_LEITURA) {
    return { valida: false, codigo: "limite_acima_do_teto" };
  }
  if (a.inicio !== undefined &&
      (typeof a.inicio !== "number" || !Number.isInteger(a.inicio) || a.inicio < 0)) {
    return { valida: false, codigo: "inicio_invalido" };
  }
  return { valida: true };
}

function escolherAba(pasta: Pasta, nome: unknown): Aba | FalhaPlanilha {
  if (nome === undefined) {
    const primeira = pasta.abas[0];
    if (!primeira) return falha("aba_inexistente", "O arquivo nao tem abas.");
    return primeira;
  }
  const aba = acharAba(pasta, nome);
  if (aba === null) {
    return falha("aba_inexistente", `A aba '${String(nome)}' nao existe neste arquivo.`);
  }
  return aba;
}

export async function executarLer(
  contexto: ContextoFuncao,
  argumentos: unknown
): Promise<unknown> {
  const a = argumentos as {
    fileId?: unknown; aba?: unknown; colunas?: string[]; limite?: number; inicio?: number;
  };
  const aberto = await abrirPasta(contexto, a.fileId);
  if ("ok" in aberto) return aberto;

  const aba = escolherAba(aberto.pasta, a.aba);
  if ("ok" in aba) return aba;

  const heads = cabecalhos(aba);
  let indices = heads.map((_, i) => i);
  if (a.colunas !== undefined) {
    const faltando = a.colunas.filter(
      (c) => !heads.some((h) => h.toLowerCase() === c.trim().toLowerCase())
    );
    if (faltando.length > 0) {
      return falha("coluna_inexistente", `Coluna(s) inexistente(s): ${faltando.join(", ")}.`);
    }
    indices = a.colunas.map((c) =>
      heads.findIndex((h) => h.toLowerCase() === c.trim().toLowerCase())
    );
  }

  const inicio = a.inicio ?? 0;
  // O teto vale mesmo sem `limite`: "sem limite" nunca significa a
  // planilha inteira. Um pedido calado nao pode custar mais que um
  // pedido explicito.
  const pedido = Math.min(a.limite ?? MAX_LINHAS_POR_LEITURA, MAX_LINHAS_POR_LEITURA);
  const porLinha = Math.max(1, indices.length);
  const cabemPorCelula = Math.floor(MAX_CELULAS_POR_LEITURA / porLinha);
  const limite = Math.max(1, Math.min(pedido, cabemPorCelula));

  const dados = aba.linhas.slice(1);
  const fatia = dados.slice(inicio, inicio + limite);
  const linhas = fatia.map((l) => indices.map((i) => textoDaCelula(l[i])));

  const avisos: string[] = [];
  if (limite < pedido) {
    avisos.push(`A leitura foi cortada em ${limite} linhas pelo teto de celulas (${MAX_CELULAS_POR_LEITURA}).`);
  }

  return {
    ok: true,
    arquivo: { fileId: aberto.fileId, nome: aberto.nome },
    aba: aba.nome,
    colunas: indices.map((i) => heads[i]),
    linhas,
    inicio,
    devolvidas: linhas.length,
    totalDeLinhas: linhasDeDado(aba),
    truncado: inicio + linhas.length < linhasDeDado(aba),
    avisos,
  };
}

// ─── planilha.agregar ─────────────────────────────────────────────────

export function validarEntradaAgregar(argumentos: unknown): ResultadoValidacaoEntrada {
  if (typeof argumentos !== "object" || argumentos === null || Array.isArray(argumentos)) {
    return { valida: false, codigo: "entrada_nao_objeto" };
  }
  const a = argumentos as Record<string, unknown>;
  const conhecidos = ["fileId", "aba", "operacao", "coluna", "filtros", "agruparPor"];
  for (const k of Object.keys(a)) {
    if (!conhecidos.includes(k)) return { valida: false, codigo: "campo_desconhecido" };
  }
  if (typeof a.fileId !== "string" || a.fileId === "") {
    return { valida: false, codigo: "file_id_ausente" };
  }
  if (typeof a.operacao !== "string") return { valida: false, codigo: "operacao_ausente" };
  if (a.aba !== undefined && typeof a.aba !== "string") {
    return { valida: false, codigo: "aba_invalida" };
  }
  if (a.coluna !== undefined && typeof a.coluna !== "string") {
    return { valida: false, codigo: "coluna_invalida" };
  }
  if (a.agruparPor !== undefined && typeof a.agruparPor !== "string") {
    return { valida: false, codigo: "agrupamento_invalido" };
  }
  if (a.filtros !== undefined) {
    if (!Array.isArray(a.filtros)) return { valida: false, codigo: "filtros_invalidos" };
    for (const f of a.filtros) {
      if (typeof f !== "object" || f === null || Array.isArray(f)) {
        return { valida: false, codigo: "filtros_invalidos" };
      }
      const ff = f as Record<string, unknown>;
      if (typeof ff.coluna !== "string" || typeof ff.operador !== "string") {
        return { valida: false, codigo: "filtros_invalidos" };
      }
      for (const k of Object.keys(ff)) {
        if (!["coluna", "operador", "valor", "ate"].includes(k)) {
          return { valida: false, codigo: "filtros_invalidos" };
        }
      }
    }
  }
  return { valida: true };
}

export async function executarAgregar(
  contexto: ContextoFuncao,
  argumentos: unknown
): Promise<unknown> {
  const a = argumentos as {
    fileId?: unknown; aba?: unknown; operacao: Operacao;
    coluna?: string; filtros?: Filtro[]; agruparPor?: string;
  };
  const aberto = await abrirPasta(contexto, a.fileId);
  if ("ok" in aberto) return aberto;

  const aba = escolherAba(aberto.pasta, a.aba);
  if ("ok" in aba) return aba;

  const r = agregar(aba, {
    operacao: a.operacao,
    coluna: a.coluna,
    filtros: a.filtros,
    agruparPor: a.agruparPor,
  });
  if (r.tipo === "erro") return falha(r.codigo, r.mensagem);

  const res = r.resultado;
  return {
    ok: true,
    // PROVENIENCIA — o que a UI precisa para o "Ver detalhes". Nenhum
    // caminho de sistema entra aqui: `fileId` e `nome` sao logicos.
    proveniencia: {
      fileId: aberto.fileId,
      arquivo: aberto.nome,
      aba: aba.nome,
      operacao: res.operacao,
      coluna: res.coluna,
      filtros: a.filtros ?? [],
      agruparPor: a.agruparPor ?? null,
      linhasNaAba: res.linhasNaAba,
      linhasCorrespondentes: res.linhasFiltradas,
      celulasIgnoradas: res.ignoradas,
    },
    valor: res.valor,
    grupos: res.grupos,
    gruposTruncados: res.gruposTruncados,
    avisos: res.avisos,
  };
}

// ─── Interpretador comum ──────────────────────────────────────────────

/**
 * Um so para as tres: a forma de saida delas e a mesma uniao —
 * `{ok:true, …}` ou `{ok:false, codigo, mensagem}`. Tres copias
 * divergiriam no primeiro ajuste.
 */
export function interpretarSaidaPlanilha(saida: unknown): ResultadoInterpretacaoSaida {
  if (typeof saida !== "object" || saida === null || Array.isArray(saida)) {
    return { tipo: "invalida" };
  }
  const s = saida as Record<string, unknown>;
  if (s.ok === false) {
    if (typeof s.codigo !== "string" || typeof s.mensagem !== "string") {
      return { tipo: "invalida" };
    }
    // Leitura idempotente: repetir nao causa dano. Nao e pedido de
    // retry — nao existe retry no executor.
    return { tipo: "erro", codigo: s.codigo, mensagem: s.mensagem, retryable: true };
  }
  if (s.ok !== true) return { tipo: "invalida" };
  return { tipo: "sucesso", data: saida };
}

export { celulaVazia };
