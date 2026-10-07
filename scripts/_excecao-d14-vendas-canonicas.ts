/**
 * SALES-CANONICAL-D14B — excecao EXATA dos guards de escopo para o patch D14
 * (metricas parciais) nos 3 arquivos canonicos que JA existiam:
 *   lib/vendas/canonico/ml.ts, shopee.ts, tipos.ts
 *
 * Nao e "mudanca aditiva permitida" nem "mudanca de parcial permitida": o
 * arquivo atual so passa se, revertendo EXATAMENTE os hunks aprovados abaixo
 * (gerados do diff D14A contra 1c4fe29), o resultado for BYTE-IDENTICO ao
 * blob de 1c4fe29 (forma canonica LF, como o git guarda). Qualquer outra
 * linha mudada, helper extra (mesmo chamado "parcial"), default trocado ou
 * hunk alterado → a reconstrucao falha → o guard falha.
 *
 * Tambem cobre SO este helper como arquivo novo (para o guard do cron).
 * As excecoes D13 (scripts/_excecao-d13-vendas-canonicas.ts) seguem
 * independentes e nao sao ampliadas.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const BASE_D14 = "1c4fe29";

export const D14_EXISTING_CANONICAL_FILES: readonly string[] = [
  "lib/vendas/canonico/ml.ts",
  "lib/vendas/canonico/shopee.ts",
  "lib/vendas/canonico/tipos.ts",
];

/** Arquivos NOVOS do D14 que os guards de escopo enxergam fora de scripts/testar-*. */
export const ARQUIVOS_NOVOS_D14: readonly string[] = ["scripts/_excecao-d14-vendas-canonicas.ts"];

/** Hunks APROVADOS (contexto de 1 linha): `d14` no arquivo atual ↔ `base` em 1c4fe29. */
const PATCH_D14: Record<string, { base: string; d14: string }[]> = {
  "lib/vendas/canonico/ml.ts": [
    {
      "base": "import { intervaloSaoPaulo } from \"./shopee\";\nimport type { Completude } from \"./tipos\";\n",
      "d14": "import { intervaloSaoPaulo } from \"./shopee\";\nimport { prefixoObservado } from \"./periodo\";\nimport type { Completude, ParcialObservadoLoja } from \"./tipos\";\n"
    },
    {
      "base": "\nexport interface ResultadoVendasLojaML { lojaId: string; completude: Completude; motivos: string[]; metricas: MetricasVendasML | null; estadoEm: string | null }\nexport interface ResultadoVendasML {",
      "d14": "\nexport interface ResultadoVendasLojaML {\n  lojaId: string; completude: Completude; motivos: string[]; metricas: MetricasVendasML | null; estadoEm: string | null;\n  /** SALES-CANONICAL-D14: so quando o chamador pede `parcial: true`. */\n  parcial?: ParcialObservadoLoja<MetricasVendasML>;\n}\n\n/**\n * SALES-CANONICAL-D14 — o prefixo OBSERVADO [inicio, observadoAte) de um\n * periodo aberto. observadoAte = alcance da cadeia date_closed (a MESMA de\n * avaliarCompletudeML); avaliado pelas MESMAS funcoes puras. Nenhuma regra nova.\n */\nexport function parcialObservadoML(inicio: Date, fim: Date, janelas: JanelaFechamentoML[], pedidos: PedidoMLCanonico[]): ParcialObservadoLoja<MetricasVendasML> {\n  const p = prefixoObservado(alcanceFechamentoML(janelas, inicio.getTime()), inicio, fim);\n  if (p.estado !== \"OBSERVADO_ATE\") return { estado: p.estado, observadoAte: null, completude: null, motivos: [], metricas: null };\n  const noPrefixo = filtrarFechadosNoIntervalo(pedidos, inicio, p.ate);\n  const av = avaliarCompletudeML({ inicio, fim: p.ate, janelas, pedidos: noPrefixo });\n  return { estado: p.estado, observadoAte: p.ate.toISOString(), completude: av.completude, motivos: av.motivos,\n    metricas: av.completude === \"COMPLETE\" ? calcularMetricasML(noPrefixo) : null };\n}\nexport interface ResultadoVendasML {"
    },
    {
      "base": "  cliente: SupabaseClient,\n  args: { userId: string; de: string; ate: string; lojaIds?: string[] },\n): Promise<ResultadoVendasML> {",
      "d14": "  cliente: SupabaseClient,\n  /** `parcial` (D14, padrao false): acrescenta `parcial` por loja; sem ele o resultado e o de sempre. */\n  args: { userId: string; de: string; ate: string; lojaIds?: string[]; parcial?: boolean },\n): Promise<ResultadoVendasML> {"
    },
    {
      "base": "    resultados.push({ lojaId, completude: av.completude, motivos: av.motivos, estadoEm: av.estadoEm,\n      metricas: av.completude === \"COMPLETE\" ? calcularMetricasML(pedidos) : null });\n  }",
      "d14": "    resultados.push({ lojaId, completude: av.completude, motivos: av.motivos, estadoEm: av.estadoEm,\n      metricas: av.completude === \"COMPLETE\" ? calcularMetricasML(pedidos) : null,\n      ...(args.parcial === true ? { parcial: parcialObservadoML(inicio, fim, janelas, pedidos) } : {}) });\n  }"
    }
  ],
  "lib/vendas/canonico/shopee.ts": [
    {
      "base": "import type {\n  Completude, ComponentesVendasShopee, MetricasVendas, ResultadoVendas, ResultadoVendasLoja,\n} from \"./tipos\";\n",
      "d14": "import type {\n  Completude, ComponentesVendasShopee, MetricasVendas, ParcialObservadoLoja, ResultadoVendas, ResultadoVendasLoja,\n} from \"./tipos\";\nimport { prefixoObservado } from \"./periodo\";\n"
    },
    {
      "base": "    userId: string; de: string; ate: string; lojaIds?: string[];\n    /**",
      "d14": "    userId: string; de: string; ate: string; lojaIds?: string[];\n    /** SALES-CANONICAL-D14 (padrao false): acrescenta `parcial` por loja; sem ele o resultado e o de sempre. */\n    parcial?: boolean;\n    /**"
    },
    {
      "base": "      pedidosPagos: pedidos, itens, naoPagosSemObservacaoPosPeriodo: naoPagos });\n    const extra = { dimensoes: av.dimensoes, estadoEm: av.estadoEm, baseDescoberta: av.baseDescoberta, descobertaDesde: av.descobertaDesde };\n    if (av.completude !== \"COMPLETE\") {",
      "d14": "      pedidosPagos: pedidos, itens, naoPagosSemObservacaoPosPeriodo: naoPagos });\n    const extra = { dimensoes: av.dimensoes, estadoEm: av.estadoEm, baseDescoberta: av.baseDescoberta, descobertaDesde: av.descobertaDesde,\n      ...(args.parcial === true ? { parcial: await parcialObservadoShopee(cliente, { userId, lojaId, inicio, fim, janelas,\n        ancora: ancora ? new Date(ancora) : null, desdeIso, pedidos, itens }) } : {}) };\n    if (av.completude !== \"COMPLETE\") {"
    },
    {
      "base": "\n/**",
      "d14": "\n/**\n * SALES-CANONICAL-D14 — o prefixo OBSERVADO [inicio, observadoAte) de um\n * periodo aberto. observadoAte = alcance da cadeia create_time (a MESMA de\n * avaliarCompletudeShopee, desde a ancora ou inicio − prazo publicado);\n * avaliado pelas MESMAS funcoes (filtro por pay_time, contagem B ate o\n * corte, completude A/B/C, calcularMetricasShopee). Nenhuma regra nova.\n */\nasync function parcialObservadoShopee(cliente: SupabaseClient, a: {\n  userId: string; lojaId: string; inicio: Date; fim: Date; janelas: JanelaListagem[]; ancora: Date | null; desdeIso: string;\n  pedidos: PedidoShopeeCanonico[]; itens: ItemShopeeCanonico[];\n}): Promise<ParcialObservadoLoja<MetricasVendas>> {\n  const p = prefixoObservado(alcanceDescobertaCriacao(a.janelas, new Date(a.desdeIso).getTime()), a.inicio, a.fim);\n  if (p.estado !== \"OBSERVADO_ATE\") return { estado: p.estado, observadoAte: null, completude: null, motivos: [], metricas: null };\n  const pagos = filtrarPagosNoIntervalo(a.pedidos, a.inicio, p.ate);\n  const naoPagos = await contarNaoPagosSemObservacaoShopee(cliente, { userId: a.userId, lojaId: a.lojaId, desdeIso: a.desdeIso, fimIso: p.ate.toISOString() });\n  const av = avaliarCompletudeShopee({ inicio: a.inicio, fim: p.ate, janelas: a.janelas, ancoraDescoberta: a.ancora,\n    pedidosPagos: pagos, itens: a.itens, naoPagosSemObservacaoPosPeriodo: naoPagos });\n  return { estado: p.estado, observadoAte: p.ate.toISOString(), completude: av.completude, motivos: av.motivos,\n    metricas: av.completude === \"COMPLETE\" ? calcularMetricasShopee(pagos, a.itens).metricas : null };\n}\n\n/**"
    }
  ],
  "lib/vendas/canonico/tipos.ts": [
    {
      "base": "  descobertaDesde?: string;\n}",
      "d14": "  descobertaDesde?: string;\n  /** SALES-CANONICAL-D14: so quando o chamador pede `parcial: true`. */\n  parcial?: ParcialObservadoLoja<MetricasVendas>;\n}\n\n/**\n * SALES-CANONICAL-D14 — o prefixo OBSERVADO [inicio, observadoAte) de um\n * periodo ainda aberto, avaliado com as MESMAS funcoes puras de completude\n * e de metricas do leitor. `observadoAte` vem SO da cadeia de janelas de\n * descoberta completas (nunca do relogio, nunca da existencia de linhas).\n *\n *   SEM_OBSERVACAO  a cadeia nao passa do inicio: nada provado no periodo.\n *   OBSERVADO_ATE   inicio < observadoAte < fim: prefixo avaliavel.\n *   DIA_FECHADO     a cadeia ja alcanca o fim: vale a semantica normal.\n */\nexport interface ParcialObservadoLoja<M> {\n  estado: \"SEM_OBSERVACAO\" | \"OBSERVADO_ATE\" | \"DIA_FECHADO\";\n  observadoAte: string | null;\n  /** Completude do PREFIXO (null fora de OBSERVADO_ATE). */\n  completude: Completude | null;\n  motivos: string[];\n  /** So quando o prefixo e COMPLETE. */\n  metricas: M | null;\n}"
    }
  ]
};

const lf = (s: string) => s.replace(/\r\n/g, "\n");
const blob = (raiz: string, rev: string, arquivo: string) => {
  try { return lf(execFileSync("git", ["show", `${rev}:${arquivo}`], { cwd: raiz, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })); } catch { return null; }
};

/** ATUAL − PATCH_D14 aprovado = bytes de 1c4fe29? */
export function reconstruirBaseD14(raiz: string, arquivo: string): { valido: boolean; motivo: string } {
  const hunks = PATCH_D14[arquivo];
  if (!hunks) return { valido: false, motivo: "arquivo_fora_da_excecao_d14" };
  let s = lf(readFileSync(join(raiz, arquivo), "utf8"));
  for (let i = 0; i < hunks.length; i++) {
    const n = s.split(hunks[i].d14).length - 1;
    if (n !== 1) return { valido: false, motivo: `hunk_${i}_ocorrencias_${n}` };
    s = s.replace(hunks[i].d14, () => hunks[i].base);
  }
  const base = blob(raiz, BASE_D14, arquivo);
  return base !== null && s === base ? { valido: true, motivo: "" } : { valido: false, motivo: "reconstrucao_difere_de_1c4fe29" };
}

function existeNaBase(raiz: string, base: string, arquivo: string): boolean {
  return blob(raiz, base, arquivo) !== null;
}

/**
 * Remove da lista de alterados SO o que a excecao D14 cobre:
 *   - ml.ts/shopee.ts/tipos.ts quando ATUAL − PATCH_D14 = 1c4fe29 E o arquivo
 *     na base do guard e o mesmo de 1c4fe29 (nada mais mudou desde ela);
 *   - este helper, se nao existia na base.
 */
export function filtrarExcecaoD14(raiz: string, base: string, alterados: string[]): string[] {
  return alterados.filter((f) => {
    if (D14_EXISTING_CANONICAL_FILES.includes(f)) {
      const r = reconstruirBaseD14(raiz, f);
      return !(r.valido && blob(raiz, base, f) === blob(raiz, BASE_D14, f));
    }
    if (ARQUIVOS_NOVOS_D14.includes(f) && !existeNaBase(raiz, base, f)) return false;
    return true;
  });
}
