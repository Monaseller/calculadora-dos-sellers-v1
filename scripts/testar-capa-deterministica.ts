/**
 * Testes da capa determinística, do recorte e da validação de fotos.
 *
 * ── O que originou esta suíte (2026-09-06) ──────────────────────────
 * A auditoria visual de 8 imagens geradas pelo modelo deu 0/8 aprovadas
 * por fidelidade: marca e rótulo apagados, tampa alongada, frasco
 * bojudo, quantidade errada e uma cena fisicamente impossível. A
 * conclusão foi que um modelo generativo não pode ser o responsável por
 * reconstruir um produto comercial que precisa permanecer fiel.
 *
 * A capa passou a ser COMPOSTA a partir dos pixels reais da foto. Estes
 * testes existem para provar, deterministicamente, que:
 *   · os pixels do produto não são alterados;
 *   · a escala é uniforme (nada de rótulo esticado);
 *   · nenhuma IA é chamada no caminho da capa;
 *   · sem foto apta o sistema FALHA em vez de redesenhar o produto.
 *
 * NENHUM teste aqui chama IA, rede ou banco. As fotos são fixtures
 * sintéticas geradas com sharp na hora — o resultado não depende de
 * arquivo externo nem de estado do Storage.
 *
 * Uso: npx tsx scripts/testar-capa-deterministica.ts
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import {
  recortarProduto,
  calcularMascaraProduto,
  COBERTURA_FUNDO_MINIMA_PCT,
  VERSAO_METODO_RECORTE,
} from "../lib/estudio-anuncios/recorte";
import {
  analisarQualidadeFoto,
  selecionarReferenciaPrincipal,
  classificarResolucao,
  descreverParaUI,
} from "../lib/estudio-anuncios/qualidade-foto";
import {
  comporCapaDeterministica,
  escolherEComporCapa,
  verificarFidelidadeCapa,
  LADO_CAPA_PX,
  OCUPACAO_PRODUTO,
  METODO_CAPA,
} from "../lib/estudio-anuncios/capa-deterministica";
import { RESOLUCAO_MINIMA_IMAGEM_ML } from "../lib/estudio-anuncios/compliance/regras-mercado-livre";

let ok = 0, falhou = 0;
async function t(nome: string, fn: () => void | Promise<void>) {
  try { await fn(); ok++; console.log(`  PASS  ${nome}`); }
  catch (e: any) { falhou++; console.log(`  FALHA ${nome} -> ${e?.message ?? e}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

// ── Fixtures determinísticas ────────────────────────────────────────

/** Packshot: fundo branco + "produto" retangular colorido centralizado. */
async function packshot(lado = 800, ladoProduto = 600): Promise<Buffer> {
  const off = Math.round((lado - ladoProduto) / 2);
  const produto = await sharp({
    create: { width: ladoProduto, height: Math.round(ladoProduto * 0.75), channels: 3, background: { r: 180, g: 60, b: 40 } },
  }).png().toBuffer();
  return sharp({ create: { width: lado, height: lado, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .composite([{ input: produto, left: off, top: off }]).jpeg({ quality: 95 }).toBuffer();
}

/** Lifestyle: fundo texturado escuro — flood fill não deve achar fundo. */
async function lifestyle(lado = 800): Promise<Buffer> {
  const ruido = Buffer.alloc(lado * lado * 3);
  for (let i = 0; i < lado * lado; i++) {
    const v = 90 + ((i * 37) % 60);
    ruido[i * 3] = v; ruido[i * 3 + 1] = Math.round(v * 0.8); ruido[i * 3 + 2] = Math.round(v * 0.6);
  }
  const fundo = await sharp(ruido, { raw: { width: lado, height: lado, channels: 3 } }).png().toBuffer();
  const produto = await sharp({ create: { width: 300, height: 220, channels: 3, background: { r: 40, g: 90, b: 160 } } }).png().toBuffer();
  return sharp(fundo).composite([{ input: produto, left: 250, top: 280 }]).jpeg({ quality: 95 }).toBuffer();
}

async function rodar() {
  console.log("\n[recorte determinístico]");

  await t("1. packshot em fundo neutro é recortado", async () => {
    const r = await recortarProduto(await packshot());
    assert(r.ok, `deveria recortar: ${!r.ok ? r.falha.motivo : ""}`);
    if (r.ok) {
      assert(r.recorte.pixelsProduto > 0, "nenhum pixel de produto");
      assert(r.recorte.coberturaFundoPct > COBERTURA_FUNDO_MINIMA_PCT, "cobertura de fundo baixa demais");
    }
  });

  await t("2. fundo complexo é RECUSADO, não recortado 'mais ou menos'", async () => {
    const r = await recortarProduto(await lifestyle());
    assert(!r.ok, "fundo texturado não deveria ser recortável");
    if (!r.ok) assert(r.falha.codigo === "fundo_nao_detectado", `código inesperado: ${r.falha.codigo}`);
  });

  await t("3. os pixels internos do produto são BYTE-IDÊNTICOS ao original", async () => {
    // É a assertiva que sustenta a arquitetura inteira: marca, rótulo e
    // cor preservados por construção, não por instrução a um modelo.
    const original = await packshot();
    const r = await recortarProduto(original);
    assert(r.ok, "recorte falhou");
    if (!r.ok) return;
    const orig = await sharp(original).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const cut = await sharp(r.recorte.png).raw().toBuffer({ resolveWithObject: true });
    let dentro = 0, identicos = 0;
    for (let i = 0; i < orig.info.width * orig.info.height; i++) {
      if (cut.data[i * 4 + 3] === 0) continue;
      dentro++;
      if (orig.data[i * 4] === cut.data[i * 4] &&
          orig.data[i * 4 + 1] === cut.data[i * 4 + 1] &&
          orig.data[i * 4 + 2] === cut.data[i * 4 + 2]) identicos++;
    }
    assert(dentro > 1000, "poucos pixels de produto para a medida valer");
    assert(identicos === dentro, `${dentro - identicos} pixels foram alterados — o recorte só pode escrever alpha`);
  });

  await t("4. a máscara é calculável isoladamente (usada pela análise de qualidade)", async () => {
    const { data, info } = await sharp(await packshot()).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const m = calcularMascaraProduto(data, info.width, info.height, info.channels);
    assert(m.alpha.length === info.width * info.height, "tamanho de máscara inesperado");
    assert(m.coberturaFundoPct > 0 && m.coberturaFundoPct < 100, "cobertura fora de faixa");
  });

  console.log("\n[validação e escolha da foto]");

  await t("5. resolução usa o mínimo OFICIAL do Mercado Livre, não número inventado", () => {
    assert(RESOLUCAO_MINIMA_IMAGEM_ML === 500, "a fonte documentada mudou — revisar a política");
    assert(classificarResolucao(RESOLUCAO_MINIMA_IMAGEM_ML - 1) === "insuficiente", "abaixo do mínimo deveria ser insuficiente");
    assert(classificarResolucao(RESOLUCAO_MINIMA_IMAGEM_ML) === "aceitavel", "no mínimo deveria ser aceitável");
    assert(classificarResolucao(1920) === "adequada", "no máximo do ML deveria ser adequada");
  });

  await t("6. packshot grande vira candidato à capa", async () => {
    const a = await analisarQualidadeFoto("f1", await packshot(1000, 800));
    assert(a.aptaParaRecorteDeterministico, `deveria ser apta: ${a.motivoNaoApta}`);
    assert(a.papel === "packshot_principal", `papel inesperado: ${a.papel}`);
    assert(a.caixaProduto !== null, "deveria ter caixa de produto");
  });

  await t("7. lifestyle é marcado como não apto ao recorte, SEM ser descartado", async () => {
    const a = await analisarQualidadeFoto("f2", await lifestyle());
    assert(!a.aptaParaRecorteDeterministico, "fundo complexo não deveria ser apto");
    assert(a.motivoNaoApta !== null, "precisa explicar o porquê");
    // Continua útil para análise visual e contexto — o papel diz isso.
    assert(a.papel === "lifestyle" || a.papel === "referencia_nao_confiavel_para_identidade",
      `papel inesperado: ${a.papel}`);
  });

  await t("8. produto pequeno demais é reprovado para capa", async () => {
    const a = await analisarQualidadeFoto("f3", await packshot(400, 300));
    assert(a.ladoUtilPx < RESOLUCAO_MINIMA_IMAGEM_ML, "fixture deveria ser pequena");
    assert(a.resolucao === "insuficiente", `resolução inesperada: ${a.resolucao}`);
  });

  await t("9. uma foto ruim NÃO invalida as boas", async () => {
    const boa = await analisarQualidadeFoto("boa", await packshot(1000, 800));
    const ruim = await analisarQualidadeFoto("ruim", await lifestyle());
    const s = selecionarReferenciaPrincipal([ruim, boa]);
    assert(s.principalId === "boa", `deveria escolher a boa, escolheu ${s.principalId}`);
    assert(s.bloqueio === null, "não deveria bloquear havendo foto apta");
  });

  await t("10. a escolha não segue ordem de upload quando há evidência melhor", async () => {
    const primeira = await analisarQualidadeFoto("primeira", await packshot(700, 520));
    const melhor = await analisarQualidadeFoto("melhor", await packshot(1400, 1200));
    const s = selecionarReferenciaPrincipal([primeira, melhor]);
    assert(s.principalId === "melhor", "deveria preferir maior lado útil, não a primeira enviada");
  });

  await t("11. sem foto apta, bloqueio explícito e acionável", async () => {
    const s = selecionarReferenciaPrincipal([await analisarQualidadeFoto("x", await lifestyle())]);
    assert(s.principalId === null, "não deveria eleger principal");
    assert(!!s.bloqueio && /fundo neutro/i.test(s.bloqueio), `mensagem precisa orientar: ${s.bloqueio}`);
  });

  await t("12. a UI recebe o motivo, não só o veredicto", async () => {
    const d = descreverParaUI(await analisarQualidadeFoto("y", await lifestyle()));
    assert(d.nivel === "alerta", "deveria alertar");
    assert(d.texto.length > 20, "a explicação precisa ser legível");
  });

  console.log("\n[capa determinística]");

  await t("13. compõe capa quadrada com fundo branco", async () => {
    const r = await comporCapaDeterministica({ origemFotoId: "f1", bufferOriginal: await packshot() });
    assert(r.ok, `deveria compor: ${!r.ok ? r.motivo : ""}`);
    if (!r.ok) return;
    assert(r.capa.largura === LADO_CAPA_PX && r.capa.altura === LADO_CAPA_PX, "capa deveria ser quadrada no lado padrão");
    const { data, info } = await sharp(r.capa.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const canto = (x: number, y: number) => {
      const o = (y * info.width + x) * info.channels;
      return data[o] === 255 && data[o + 1] === 255 && data[o + 2] === 255;
    };
    assert(canto(0, 0) && canto(info.width - 1, info.height - 1), "os cantos precisam ser branco puro");
  });

  await t("14. a escala é UNIFORME — proporção do produto não muda", async () => {
    const original = await packshot(800, 600);
    const rec = await recortarProduto(original);
    assert(rec.ok, "recorte falhou");
    if (!rec.ok) return;
    const r = await comporCapaDeterministica({ origemFotoId: "f1", bufferOriginal: original });
    assert(r.ok, "composição falhou");
    if (!r.ok) return;
    const v = await verificarFidelidadeCapa(r.capa, rec.recorte.caixa);
    assert(v.aprovada, `assertivas falharam: ${v.falhas.join(" | ")}`);
    const desvio = Math.abs(v.aspectFinal - v.aspectOrigem) / v.aspectOrigem;
    assert(desvio <= 0.015, `proporção desviou ${(desvio * 100).toFixed(2)}%`);
  });

  await t("15. há margem de segurança — o produto não encosta na borda", async () => {
    const r = await comporCapaDeterministica({ origemFotoId: "f1", bufferOriginal: await packshot() });
    assert(r.ok, "composição falhou");
    if (!r.ok) return;
    const { data, info } = await sharp(r.capa.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let x0 = info.width, x1 = -1;
    for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
      const o = (y * info.width + x) * info.channels;
      if (data[o] === 255 && data[o + 1] === 255 && data[o + 2] === 255) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
    }
    const ocupacao = (x1 - x0 + 1) / info.width;
    assert(ocupacao <= OCUPACAO_PRODUTO + 0.02, `produto ocupa ${(ocupacao * 100).toFixed(0)}% — sem margem`);
  });

  await t("16. proveniência completa e coerente é registrada", async () => {
    const r = await comporCapaDeterministica({ origemFotoId: "foto-42", bufferOriginal: await packshot() });
    assert(r.ok, "composição falhou");
    if (!r.ok) return;
    const p = r.capa.proveniencia;
    assert(p.houveIA === false, "a capa não pode se declarar com IA");
    assert(p.houveComposicao === true, "a capa é composta");
    assert(p.metodo === METODO_CAPA, `método inesperado: ${p.metodo}`);
    assert(p.versaoRecorte === VERSAO_METODO_RECORTE, "versão do recorte divergente");
    assert(p.origemFotoId === "foto-42", "precisa dizer de qual foto veio");
    for (const c of [p.checksumOriginal, p.checksumRecorte, p.checksumFinal]) {
      assert(/^[0-9a-f]{64}$/.test(c), `checksum inválido: ${c}`);
    }
    assert(p.checksumOriginal !== p.checksumFinal, "original e final não podem ter o mesmo hash");
  });

  await t("17. capa é reprodutível — mesma entrada, mesmo checksum", async () => {
    const foto = await packshot();
    const a = await comporCapaDeterministica({ origemFotoId: "f", bufferOriginal: foto });
    const b = await comporCapaDeterministica({ origemFotoId: "f", bufferOriginal: foto });
    assert(a.ok && b.ok, "composição falhou");
    if (!a.ok || !b.ok) return;
    assert(a.capa.proveniencia.checksumFinal === b.capa.proveniencia.checksumFinal,
      "o método precisa ser determinístico");
  });

  await t("18. sem foto apta, FALHA explícita — nunca cai para IA", async () => {
    const r = await escolherEComporCapa([{ imagemOrigemId: "f1", buffer: await lifestyle() }]);
    assert(!r.ok, "deveria falhar sem foto apta");
    if (!r.ok) {
      assert(r.codigo === "sem_foto_apta", `código inesperado: ${r.codigo}`);
      assert(/fundo neutro/i.test(r.motivo), `mensagem precisa orientar o usuário: ${r.motivo}`);
    }
  });

  await t("19. entre várias, escolhe a apta e compõe", async () => {
    const r = await escolherEComporCapa([
      { imagemOrigemId: "ruim", buffer: await lifestyle() },
      { imagemOrigemId: "boa", buffer: await packshot(1200, 1000) },
    ]);
    assert(r.ok, `deveria compor: ${!r.ok ? r.motivo : ""}`);
    if (r.ok) assert(r.capa.proveniencia.origemFotoId === "boa", "deveria usar a foto apta");
  });

  console.log("\n[garantias estruturais — lidas da fonte]");

  const FONTE_CAPA = fs.readFileSync(path.join(process.cwd(), "lib/estudio-anuncios/capa-deterministica.ts"), "utf-8");
  const FONTE_RECORTE = fs.readFileSync(path.join(process.cwd(), "lib/estudio-anuncios/recorte.ts"), "utf-8");
  const FONTE_GERACAO = fs.readFileSync(path.join(process.cwd(), "lib/estudio-anuncios/geracao-imagem.ts"), "utf-8");

  await t("20. o caminho da capa NÃO importa provedor de IA", () => {
    for (const [nome, src] of [["capa", FONTE_CAPA], ["recorte", FONTE_RECORTE]] as const) {
      assert(!/ai-gateway\/provedores/.test(src), `${nome} importou provedor de IA`);
      assert(!/gerarImagemGoogle|chamarGeminiTexto|anthropic/i.test(src), `${nome} referencia provedor de IA`);
    }
  });

  await t("21. a capa não faz relight, warp, perspectiva nem correção de cor", () => {
    for (const proibido of ["modulate", "linear(", "affine", "recomb", "tint", "normalise", "sharpen", "gamma"]) {
      assert(!FONTE_CAPA.includes(proibido), `operação proibida no caminho da capa: ${proibido}`);
    }
  });

  await t("22. não existe fallback silencioso da capa para o Gemini", () => {
    const bloco = FONTE_GERACAO.slice(
      FONTE_GERACAO.indexOf('if (prompt.tipo === "capa_principal")'),
      FONTE_GERACAO.indexOf("// ── Geração real")
    );
    assert(bloco.length > 200, "o bloco da capa sumiu de geracao-imagem.ts");
    assert(/if \(!capa\.ok\)[\s\S]{0,200}throw/.test(bloco), "capa sem foto apta precisa lançar, não seguir");
    assert(!/gerarImagemGoogle/.test(bloco), "o bloco da capa não pode chamar o gerador de imagem");
    assert(/provedor: "internal"/.test(bloco), "a capa precisa registrar provedor internal");
    assert(/houve_ia: false/.test(bloco), "a capa precisa registrar houve_ia=false");
  });

  await t("23. a migration de proveniência é aditiva e não destrói dado", () => {
    const sql = fs.readFileSync(
      path.join(process.cwd(), "supabase/migrations/20260906_capa_deterministica_e_retry.sql"), "utf-8");
    const executavel = sql.replace(/^\s*--.*$/gm, " ");
    assert(/ADD COLUMN IF NOT EXISTS/.test(executavel), "as colunas precisam ser idempotentes");
    assert(!/DROP COLUMN|DELETE FROM|TRUNCATE/i.test(executavel), "a migration não pode destruir dado");
    // SEC1 (BUGS.md): default privileges concedem EXECUTE a anon/authenticated.
    assert(/REVOKE ALL ON FUNCTION[\s\S]{0,120}FROM PUBLIC, anon, authenticated/.test(executavel),
      "toda função nova precisa de REVOKE explícito (SEC1)");
    assert(/GRANT EXECUTE ON FUNCTION[\s\S]{0,120}TO service_role/.test(executavel), "falta GRANT ao service_role");
  });

  await t("24. o retry é append-only e não reseta o job antigo", () => {
    const sql = fs.readFileSync(
      path.join(process.cwd(), "supabase/migrations/20260906_capa_deterministica_e_retry.sql"), "utf-8");
    const fn = sql.slice(sql.indexOf("estudio_anuncios_pipeline_retomar"));
    assert(/INSERT INTO public\.estudio_anuncios_jobs/.test(fn), "precisa criar job novo");
    assert(!/UPDATE public\.estudio_anuncios_jobs/.test(fn), "não pode alterar job existente");
    assert(!/DELETE FROM public\.estudio_anuncios_jobs/.test(fn), "não pode apagar job");
    assert(/FOR UPDATE/.test(fn), "precisa travar o pipeline");
    assert(/<> 'erro'/.test(fn), "precisa recusar pipeline fora de erro");
    assert(/'pendente', 0,/.test(fn), "o job novo nasce pendente com tentativas zeradas");
  });

  await t("25. a rota de retry não chama o worker", () => {
    const rota = fs.readFileSync(
      path.join(process.cwd(), "app/api/estudio-anuncios/projetos/[id]/pipeline/retomar/route.ts"), "utf-8");
    assert(!/worker|executar|processarJob/i.test(rota.replace(/^\s*\*.*$/gm, "")),
      "a rota não pode acionar execução — quem processa é o cron");
    assert(/getUserId/.test(rota) && /buscarProjetoPorId/.test(rota), "precisa validar sessão e propriedade");
    assert(/estudio_anuncios_pipeline_retomar/.test(rota), "precisa chamar a RPC");
  });

  console.log(`\n=== RESULTADO: ${ok} passaram, ${falhou} falharam ===\n`);
  if (falhou > 0) process.exit(1);
}

rodar();
