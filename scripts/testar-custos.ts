/**
 * Testes determinísticos da instrumentação de CUSTO — `custos.ts` e a
 * cadeia que leva o custo até `central_ia_consumo`. Sem banco, sem rede,
 * sem IA, custo zero.
 *
 * Uso: npx tsx scripts/testar-custos.ts
 */
import fs from "node:fs";
import path from "node:path";
import { estimarCustoUsd, modeloTemPrecoCadastrado } from "../lib/ai-gateway/custos";
import { HANDLERS_ESPECIFICOS } from "../lib/estudio-anuncios/executores/registry";

let ok = 0, falhou = 0;
function t(nome: string, fn: () => void) {
  try { fn(); ok++; console.log(`  PASS  ${nome}`); }
  catch (e: any) { falhou++; console.log(`  FALHA ${nome} -> ${e?.message ?? e}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }
const perto = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol;

// ────────────────────────────────────────────────────────────────────
// Preço oficial (ai.google.dev/gemini-api/docs/pricing, 2026-08-18,
// tier Standard). Reproduzido aqui para o teste falhar se a tabela do
// código divergir da fonte — nunca para ser "a" fonte.
// ────────────────────────────────────────────────────────────────────
const MODELO_IMAGEM = "gemini-3.1-flash-image";
const ENTRADA_MTOK = 0.5;
const SAIDA_TEXTO_MTOK = 3;
const SAIDA_IMAGEM_MTOK = 60;
/** Documentado como "1120 tokens por imagem 1K" e confirmado pela API numa chamada real. */
const TOKENS_POR_IMAGEM_1K = 1120;

const custoOficial = (entrada: number, saidaTotal: number, saidaImagem: number) =>
  (entrada / 1e6) * ENTRADA_MTOK +
  ((saidaTotal - saidaImagem) / 1e6) * SAIDA_TEXTO_MTOK +
  (saidaImagem / 1e6) * SAIDA_IMAGEM_MTOK;

console.log("\n[modelo de imagem — preço oficial]");
t("1. modelo de imagem tem preço cadastrado", () =>
  assert(modeloTemPrecoCadastrado(MODELO_IMAGEM), `"${MODELO_IMAGEM}" deveria ter preço`));
t("2. as três taxas batem com a documentação oficial", () => {
  assert(perto(estimarCustoUsd(MODELO_IMAGEM, 1e6, 0, 0), ENTRADA_MTOK), "taxa de entrada divergente");
  assert(perto(estimarCustoUsd(MODELO_IMAGEM, 0, 1e6, 0), SAIDA_TEXTO_MTOK), "taxa de saída de texto divergente");
  assert(perto(estimarCustoUsd(MODELO_IMAGEM, 0, 1e6, 1e6), SAIDA_IMAGEM_MTOK), "taxa de saída de imagem divergente");
});
t("3. saída de imagem NÃO é cobrada à taxa de texto (erro de ~20x)", () => {
  const comoImagem = estimarCustoUsd(MODELO_IMAGEM, 0, TOKENS_POR_IMAGEM_1K, TOKENS_POR_IMAGEM_1K);
  const comoTexto = estimarCustoUsd(MODELO_IMAGEM, 0, TOKENS_POR_IMAGEM_1K, 0);
  assert(perto(comoImagem / comoTexto, SAIDA_IMAGEM_MTOK / SAIDA_TEXTO_MTOK), "as duas taxas não estão separadas");
});
t("4. 1 imagem 1K ≈ US$ 0,067, como diz a documentação", () => {
  const soImagem = estimarCustoUsd(MODELO_IMAGEM, 0, TOKENS_POR_IMAGEM_1K, TOKENS_POR_IMAGEM_1K);
  assert(perto(soImagem, 0.0672), `esperado 0.0672, veio ${soImagem}`);
  assert(Math.abs(soImagem - 0.067) < 0.001, "divergiu do valor por imagem documentado");
});
t("5. caso real de 1 imagem bate com a fórmula oficial", () => {
  // Números medidos na execução real de 2026-08-16 (job cfab1965).
  const c = estimarCustoUsd(MODELO_IMAGEM, 663, 1425, TOKENS_POR_IMAGEM_1K);
  assert(perto(c, custoOficial(663, 1425, TOKENS_POR_IMAGEM_1K)), `divergiu da fórmula: ${c}`);
});
t("6. caso real de 3 imagens bate com a fórmula e é ~3x o de 1", () => {
  const tokensImagem = 3 * TOKENS_POR_IMAGEM_1K;
  const c = estimarCustoUsd(MODELO_IMAGEM, 1684, 4270, tokensImagem);
  assert(perto(c, custoOficial(1684, 4270, tokensImagem)), `divergiu da fórmula: ${c}`);
  const uma = estimarCustoUsd(MODELO_IMAGEM, 0, TOKENS_POR_IMAGEM_1K, TOKENS_POR_IMAGEM_1K);
  const tres = estimarCustoUsd(MODELO_IMAGEM, 0, tokensImagem, tokensImagem);
  assert(perto(tres, uma * 3), "custo de imagem deveria ser linear no número de tokens de imagem");
});
t("7. custo é linear e monotônico no número de imagens", () => {
  let anterior = -1;
  for (const n of [0, 1, 2, 3, 8]) {
    const c = estimarCustoUsd(MODELO_IMAGEM, 100, n * TOKENS_POR_IMAGEM_1K + 200, n * TOKENS_POR_IMAGEM_1K);
    assert(c > anterior, `custo não cresceu de ${anterior} para ${c}`);
    anterior = c;
  }
});

console.log("\n[robustez do cálculo]");
t("8. custo nunca é negativo, nem com relato inconsistente do provedor", () => {
  const c = estimarCustoUsd(MODELO_IMAGEM, 100, 500, 9999); // imagem > total
  assert(c >= 0, `custo negativo: ${c}`);
  assert(perto(c, custoOficial(100, 500, 500)), "clamp deveria tratar imagem como o total");
});
t("9. custo nunca é NaN nem infinito", () => {
  for (const args of [[0, 0, 0], [NaN, 10, 5], [10, NaN, 0], [10, 10, NaN], [Infinity, 0, 0]] as const) {
    const c = estimarCustoUsd(MODELO_IMAGEM, args[0], args[1], args[2]);
    assert(Number.isFinite(c) && c >= 0, `valor inválido para ${JSON.stringify(args)}: ${c}`);
  }
});
t("10. zero tokens custa zero", () =>
  assert(estimarCustoUsd(MODELO_IMAGEM, 0, 0, 0) === 0, "deveria ser 0"));

console.log("\n[modelo desconhecido — nunca inventa preço]");
t("11. modelo desconhecido devolve 0 e emite warn", () => {
  const original = console.warn;
  const avisos: string[] = [];
  console.warn = (m: string) => { avisos.push(String(m)); };
  try {
    const c = estimarCustoUsd("modelo-inexistente-xyz", 1000, 1000, 500);
    assert(c === 0, `deveria ser 0, veio ${c}`);
    assert(avisos.length === 1, `esperado 1 warn, veio ${avisos.length}`);
    assert(/modelo-inexistente-xyz/.test(avisos[0]), "warn deveria nomear o modelo");
    assert(!/sk-|api|key|token=/i.test(avisos[0]), "warn não pode vazar credencial");
  } finally { console.warn = original; }
});
t("12. outros modelos de imagem seguem sem preço (não verificados na prática)", () => {
  // gemini-2.5-flash-image cobra POR IMAGEM ($0.039), unidade que esta
  // tabela não representa — cadastrá-lo por analogia seria inventar.
  for (const m of ["gemini-2.5-flash-image", "gemini-3-pro-image", "gemini-3.1-flash-lite-image"]) {
    assert(!modeloTemPrecoCadastrado(m), `"${m}" não deveria ter preço cadastrado ainda`);
  }
});

console.log("\n[nenhuma regressão nos modelos de texto]");
t("13. Gemini texto mantém exatamente o cálculo anterior", () => {
  assert(estimarCustoUsd("gemini-3.6-flash", 1e6, 0) === 1.5, "entrada regrediu");
  assert(estimarCustoUsd("gemini-3.6-flash", 0, 1e6) === 7.5, "saída regrediu");
  // Caso real de geracao_prompts_imagem (job 6147397d): US$ 0,006897.
  assert(perto(estimarCustoUsd("gemini-3.6-flash", 733, 773), 0.006897, 1e-6), "custo real anterior regrediu");
});
t("14. Anthropic mantém exatamente o cálculo anterior", () => {
  assert(estimarCustoUsd("claude-opus-5", 1e6, 0) === 5, "entrada regrediu");
  assert(estimarCustoUsd("claude-opus-5", 0, 1e6) === 25, "saída regrediu");
  // Caso real de revisao_claude (job e638b379): US$ 0,02688.
  assert(perto(estimarCustoUsd("claude-opus-5", 1201, 835), 0.02688, 1e-9), "custo real anterior regrediu");
  assert(estimarCustoUsd("claude-sonnet-5", 0, 1e6) === 15, "sonnet regrediu");
  assert(estimarCustoUsd("claude-haiku-4-5", 0, 1e6) === 5, "haiku regrediu");
});
t("15. o 4º argumento é opcional e não muda modelo de saída única", () => {
  // Um modelo de texto que recebesse tokens de imagem por engano deve
  // cobrar tudo à taxa única, nunca a uma taxa de imagem inexistente.
  assert(estimarCustoUsd("gemini-3.6-flash", 0, 1000, 1000) === estimarCustoUsd("gemini-3.6-flash", 0, 1000),
    "modelo de saída única não pode ter comportamento diferente com o 4º argumento");
});

console.log("\n[cadeia até o banco]");
function semComentarios(f: string) {
  return f.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}
const ler = (p: string) => semComentarios(fs.readFileSync(path.join(process.cwd(), p), "utf-8"));
const FONTE_PROVEDOR = ler("lib/ai-gateway/provedores/google-imagem.ts");
const FONTE_HANDLER = ler("lib/estudio-anuncios/executores/geracao-imagem.ts");
const FONTE_REGISTRO = ler("lib/ai-gateway/registro.ts");
const FONTE_CUSTOS = ler("lib/ai-gateway/custos.ts");

t("16. a fatia de imagem vem da API, nunca de `unidades x preço`", () => {
  assert(/output_tokens_by_modality/.test(FONTE_PROVEDOR), "deveria ler output_tokens_by_modality");
  assert(!/1120/.test(FONTE_PROVEDOR), "não pode assumir 1120 tokens por imagem — a contagem muda com a resolução");
  assert(!/0\.067|unidadesGeradas\s*\*/.test(FONTE_HANDLER), "não pode multiplicar unidades por preço por imagem");
});
t("17. o handler passa a fatia de imagem para o cálculo", () => {
  assert(/estimarCustoUsd\(/.test(FONTE_HANDLER) && /tokensSaidaImagem/.test(FONTE_HANDLER),
    "o handler deveria repassar tokensSaidaImagem");
});
t("18. a fatia de imagem é persistida (custo re-derivável da linha)", () =>
  assert(/tokens_saida_imagem/.test(FONTE_REGISTRO), "registrarConsumo deveria persistir tokens_saida_imagem"));
t("19. preço vive só em custos.ts — nenhum número mágico espalhado", () => {
  for (const [nome, fonte] of [["provedor", FONTE_PROVEDOR], ["handler", FONTE_HANDLER], ["registro", FONTE_REGISTRO]] as const) {
    assert(!/\b(60|0\.5|0\.067)\s*\/\s*1_?000_?000|PorMilhao/.test(fonte), `preço vazou para ${nome}`);
  }
  assert(/saidaImagemPorMilhao/.test(FONTE_CUSTOS), "a taxa de imagem deveria viver em custos.ts");
});
t("20. o modelo persistido é o configurado, nunca reescrito", () => {
  assert(/modelo: execucao\.modelo/.test(FONTE_HANDLER), "o handler deveria persistir o modelo resolvido");
  assert(!/"gemini-3\.1-flash-image"/.test(FONTE_HANDLER), "o nome do modelo não pode estar fixo no handler");
});
t("21. retry que só reaproveita não cobra: 0 unidades e 0 tokens", () => {
  // `unidadesGeradas` é `imagensGeradasAgora` (as reaproveitadas não
  // contam) e os tokens só acumulam dentro do ramo que chama o provedor.
  assert(/unidadesGeradas: execucao\.imagensGeradasAgora/.test(FONTE_HANDLER), "unidades deveriam ser só as geradas agora");
  assert(estimarCustoUsd(MODELO_IMAGEM, 0, 0, 0) === 0, "execução sem geração deveria custar 0");
});
t("22. calculo_score continua sem consumo (etapa sem IA)", () => {
  const h = HANDLERS_ESPECIFICOS["calculo_score"];
  assert(h.consomeIAExterna === false, "calculo_score deveria seguir sem registrar consumo");
  const outras = Object.entries(HANDLERS_ESPECIFICOS).filter(([e]) => e !== "calculo_score");
  for (const [etapa, handler] of outras) assert(handler.consomeIAExterna !== false, `"${etapa}" deixou de registrar consumo`);
});

console.log(`\n=== RESULTADO: ${ok} passaram, ${falhou} falharam ===\n`);
process.exitCode = falhou > 0 ? 1 : 0;
