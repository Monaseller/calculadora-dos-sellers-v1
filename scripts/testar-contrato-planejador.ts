/**
 * Contrato planejador ↔ validador: direção de arte não é fato do produto.
 *
 * ── A falha real que originou esta suíte (2026-09-07) ───────────────
 * O projeto "Cacau shows" (b6d899ab) queimou QUATRO jobs seguidos em
 * `geracao_prompts_imagem`, cada um com 3 tentativas:
 *
 *   job 5 — "usou termo proibido ('rotulo')"            [já corrigido]
 *   job 6 — "reutilizou informação NÃO CONFIRMADA ('composicao')"
 *   job 7 — "reutilizou informação NÃO CONFIRMADA ('composicao')"
 *   job 8 — "reutilizou informação NÃO CONFIRMADA ('composicao')"
 *
 * O mecanismo, lido dos dados reais: a `analise_visual` registrou como
 * não confirmado a FRASE
 *
 *   "Composição química completa da fórmula dos esmaltes"
 *
 * e o validador quebrava cada item de `naoConfirmado` em PALAVRAS,
 * proibindo cada uma isoladamente. Isso baniu globalmente "composicao",
 * "quimica", "completa" e "formula". O planejador então escrevia
 * "composição premium e clara" — direção fotográfica — e era rejeitado.
 *
 * A ironia se repetiu: a instrução do próprio vendedor dizia
 * "composição premium e clara" e "kit completo".
 *
 * Uma palavra não é uma alegação. Estes testes provam que o validador
 * passou a distinguir DIREÇÃO DE ARTE de FATO DO PRODUTO, sem afrouxar
 * a validação factual.
 *
 * NENHUM teste chama IA, rede ou banco.
 *
 * Uso: npx tsx scripts/testar-contrato-planejador.ts
 */
import {
  validarIntegridadePromptsImagem,
  montarConfiguracao,
  montarEntradaPromptsImagem,
} from "../lib/estudio-anuncios/geracao-prompts-imagem";
import type { VerdadeVisual, PromptsImagemIA } from "../lib/estudio-anuncios/geracao-prompts-imagem-tipos";

let ok = 0, falhou = 0;
function t(nome: string, fn: () => void) {
  try { fn(); ok++; console.log(`  PASS  ${nome}`); }
  catch (e: any) { falhou++; console.log(`  FALHA ${nome} -> ${e?.message ?? e}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

/**
 * Verdade visual REAL do projeto "Cacau shows", copiada da
 * `analise_visual` persistida em produção — inclusive os três itens de
 * `naoConfirmado` que causaram as rejeições.
 */
const VV: VerdadeVisual = {
  produtoIdentificado: "Esmaltes para unhas",
  marca: "Impala",
  modelo: "Cacau Show",
  categoria: ["Beleza e Cuidados Pessoais", "Manicure e Pedicure", "Esmaltes"],
  resumoVisual: "Linha de esmaltes em frascos de vidro com tampa cônica marrom",
  coresDoProduto: ["Marrom", "Bege / Nude", "Vinho", "Terracota / Vermelho escuro", "Transparente (vidro)"],
  materiaisDoProduto: ["Vidro", "Plástico"],
  componentesDoProduto: [
    "Frasco de vidro",
    "Tampa plástica cônica com aplicador/pincel embutido",
    "Rótulo informativo na tampa",
  ],
  caracteristicasDoProduto: [
    "Frascos de vidro transparente que permitem ver a cor",
    "Tampa cônica plástica na cor marrom",
    "Variedade de tonalidades em tons terrosos",
  ],
  usosConfirmados: ["esmaltação das unhas"],
  publicoConfirmado: ["adulto"],
  itensDaEmbalagem: [],
  textosImpressosNoProduto: ["Cacau Show", "IMPALA", "Ops, acabou", "perolado", "Vale cada mordida", "cremoso"],
  // ── os três itens REAIS que travaram o pipeline ──
  naoConfirmado: [
    "Volume líquido contido em cada frasco (ex: em ml)",
    "Composição química completa da fórmula dos esmaltes",
    "Confirmação se os produtos são vendidos em kit ou individualmente",
  ],
};

const CONFIG = montarConfiguracao({
  quantidadeSolicitada: 1, estilo: null, modo: "rapido",
  marketplaces: ["ML"], verdadeVisual: VV,
});
const ENTRADA = montarEntradaPromptsImagem(VV);

/** Plano de 1 imagem com um campo sob teste. */
function plano(campo: "objetivo" | "cena" | "fundo" | "iluminacao" | "elementosObrigatorios", texto: string): PromptsImagemIA {
  const base: any = {
    ordem: 1, tipo: "capa_principal",
    objetivo: "apresentar o conjunto",
    cena: "frascos alinhados sobre superficie neutra",
    enquadramento: "produto_inteiro",
    fundo: "cinza claro",
    iluminacao: "difusa",
    elementosObrigatorios: ["frasco de vidro"],
    elementosProibidos: ["fundo poluido"],
  };
  base[campo] = campo === "elementosObrigatorios" ? [texto] : texto;
  return { imagens: [base] };
}
const valida = (campo: any, texto: string) => validarIntegridadePromptsImagem(plano(campo, texto), ENTRADA, CONFIG);

console.log("\n[casos REAIS que travaram o projeto Cacau shows]");

t("1. REGRESSÃO job 6/7/8 — 'composição premium e clara' passa", () => {
  // Texto no espírito exato do que o planejador escreveu e do que a
  // instrução do vendedor pedia.
  const r = valida("cena", "os cinco frascos juntos em composicao premium e clara");
  assert(r.valido, `voltou a rejeitar direção de arte: ${r.motivo}`);
});

t("2. REGRESSÃO — 'kit completo' passa", () => {
  const r = valida("objetivo", "apresentar o kit completo com reconhecimento imediato");
  assert(r.valido, `rejeitado indevidamente: ${r.motivo}`);
});

t("3. REGRESSÃO — 'composição' no fundo passa (direção de arte pura)", () => {
  const r = valida("fundo", "fundo claro com composicao centralizada");
  assert(r.valido, `rejeitado indevidamente: ${r.motivo}`);
});

console.log("\n[DOMÍNIO B — direção de arte é aceita]");

const VISUAIS: [string, string, any][] = [
  ["composição central e equilibrada", "composicao central e equilibrada", "cena"],
  ["fundo claro", "fundo claro e limpo", "fundo"],
  ["iluminação suave", "iluminacao suave e difusa", "iluminacao"],
  ["cena premium", "cena premium com atmosfera elegante", "cena"],
  ["espaço negativo", "amplo espaco negativo ao redor", "cena"],
  ["produto em destaque", "produto em destaque no centro do quadro", "objetivo"],
  ["superfície neutra", "superficie neutra e clean", "fundo"],
  ["perspectiva elevada", "perspectiva levemente elevada", "cena"],
];
for (const [nome, texto, campo] of VISUAIS) {
  t(`aceita: ${nome}`, () => {
    const r = valida(campo, texto);
    assert(r.valido, `rejeitado indevidamente: ${r.motivo}`);
  });
}

console.log("\n[DOMÍNIO A — fato do produto sem fonte continua bloqueado]");

t("4. 'composição química da fórmula' é REJEITADA", () => {
  // Dois termos da MESMA alegação não confirmada: a alegação voltou.
  const r = valida("cena", "frascos com composicao quimica da formula visivel");
  assert(!r.valido, "alegação de fórmula química deveria ser rejeitada");
});

t("5. 'volume líquido de cada frasco' é REJEITADO", () => {
  const r = valida("elementosObrigatorios", "volume liquido de cada frasco");
  assert(!r.valido, "alegação de volume deveria ser rejeitada");
});

t("6. 'fórmula líquida de secagem rápida' é REJEITADA", () => {
  const r = valida("cena", "destacar a formula liquida de secagem rapida");
  assert(!r.valido, "claim de fórmula deveria ser rejeitado");
});

t("7. 'líquido visível dentro do frasco' PASSA (visual, um termo só)", () => {
  // "frasco" está no corpus confirmado; "liquido" sozinho é ambíguo e
  // aqui descreve algo que a análise confirmou ver.
  const r = valida("cena", "reflexo suave no liquido visivel dentro do frasco");
  assert(r.valido, `rejeitado indevidamente: ${r.motivo}`);
});

t("8. termo DISTINTIVO basta sozinho para rejeitar", () => {
  const vv2: VerdadeVisual = { ...VV, naoConfirmado: ["Presença de vitamina E na fórmula"] };
  const cfg2 = montarConfiguracao({ quantidadeSolicitada: 1, estilo: null, modo: "rapido", marketplaces: ["ML"], verdadeVisual: vv2 });
  const r = validarIntegridadePromptsImagem(plano("cena", "frasco com vitamina evidente"), montarEntradaPromptsImagem(vv2), cfg2);
  assert(!r.valido, "termo distintivo de claim deveria bloquear na primeira ocorrência");
});

t("9. medida inventada continua bloqueada", () => {
  const r = valida("cena", "frascos de 10 ml alinhados");
  assert(!r.valido, "número não confirmado deveria ser rejeitado");
});

console.log("\n[DOMÍNIOS C e D — inalterados]");

t("10. preservação de rótulo continua ACEITA", () => {
  const r = valida("cena", "frascos com o rotulo original preservado exatamente como esta");
  assert(r.valido, `preservação foi rejeitada: ${r.motivo}`);
});

t("11. texto promocional novo continua REJEITADO", () => {
  const r = valida("cena", "inserir chamada promocional no topo da imagem");
  assert(!r.valido, "criação de texto deveria ser rejeitada");
});

t("12. criar selo continua REJEITADO", () => {
  const r = valida("cena", "adicionar um selo de qualidade no canto");
  assert(!r.valido, "criação de selo deveria ser rejeitada");
});

console.log("\n[separação por campo]");

t("13. direção de arte num campo não libera claim em OUTRO campo", () => {
  // `fundo` legítimo + `cena` com alegação: a alegação tem de cair.
  const p: any = {
    imagens: [{
      ordem: 1, tipo: "capa_principal",
      objetivo: "apresentar o conjunto",
      cena: "destacar a composicao quimica completa da formula",
      enquadramento: "produto_inteiro",
      fundo: "fundo claro com composicao equilibrada",
      iluminacao: "difusa",
      elementosObrigatorios: ["frasco de vidro"],
      elementosProibidos: [],
    }],
  };
  const r = validarIntegridadePromptsImagem(p, ENTRADA, CONFIG);
  assert(!r.valido, "a alegação factual em `cena` deveria derrubar o plano");
});

t("14. `fundo` e `iluminacao` não passam pela validação factual", () => {
  // Mesmo o par completo de termos, em campo de direção de arte, não é
  // afirmação sobre o produto — descreve o estúdio.
  const p: any = {
    imagens: [{
      ordem: 1, tipo: "capa_principal",
      objetivo: "apresentar o conjunto",
      cena: "frascos alinhados",
      enquadramento: "produto_inteiro",
      fundo: "composicao completa do cenario",
      iluminacao: "difusa",
      elementosObrigatorios: ["frasco de vidro"],
      elementosProibidos: [],
    }],
  };
  const r = validarIntegridadePromptsImagem(p, ENTRADA, CONFIG);
  assert(r.valido, `direção de arte pura foi rejeitada: ${r.motivo}`);
});

t("15. a validação deixou de ser por palavra isolada", () => {
  // Prova direta do defeito antigo: "composicao" sozinho, no campo mais
  // factual que existe, não pode mais condenar.
  const r = valida("elementosObrigatorios", "composicao equilibrada dos frascos");
  assert(r.valido, `uma palavra genérica ainda condena: ${r.motivo}`);
});

console.log(`\n=== RESULTADO: ${ok} passaram, ${falhou} falharam ===\n`);
if (falhou > 0) process.exit(1);
