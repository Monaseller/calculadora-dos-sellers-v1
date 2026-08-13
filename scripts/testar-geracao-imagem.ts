/**
 * Testes determinísticos da etapa `geracao_imagem` — funções puras, mais
 * um cliente Supabase de mentira nas pré-condições de origem. Sem banco
 * real, sem Storage, sem rede, sem IA, custo zero.
 *
 * Uso: npx tsx scripts/testar-geracao-imagem.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  razaoDoAspectRatio,
  validarImagemRecebida,
  calcularNumeroVersaoPorOrdem,
  selecionarReferencias,
  decidirIdempotencia,
  validarCaminhoSeguro,
  validarOrigemEBuscarPrompts,
  montarResumoCurtoImagem,
} from "../lib/estudio-anuncios/geracao-imagem";
import {
  DIMENSAO_MAXIMA_PX,
  DIMENSAO_MINIMA_PX,
  MAX_REFERENCIAS_VISUAIS,
  MIMES_IMAGEM_GERADA,
  SCHEMA_VERSAO_GERACAO_IMAGEM,
  TOLERANCIA_ASPECT_RATIO,
} from "../lib/estudio-anuncios/geracao-imagem-tipos";
import { montarCaminhoImagemGerada, BUCKET_IMAGENS_GERADAS, BUCKET_FOTOS_ORIGINAIS } from "../lib/estudio-anuncios/storage";
import type { PromptImagem } from "../lib/estudio-anuncios/geracao-prompts-imagem-tipos";
import { HANDLERS_ESPECIFICOS, ETAPAS_FAKE_GENERICAS, resolverHandler } from "../lib/estudio-anuncios/executores/registry";
import { decidirProvedor, decidirTipoPrompt } from "../lib/ai-gateway/roteamento";
import { estimarCustoUsd } from "../lib/ai-gateway/custos";
import { ErroProvedorIA } from "../lib/ai-gateway/erros";
import { mapearErroGoogle } from "../lib/ai-gateway/provedores/google";
import { obterModeloImagem, obterTimeoutImagemMs } from "../lib/ai-gateway/provedores/google-imagem";

let ok = 0, falhou = 0;
function t(nome: string, fn: () => void) {
  try { fn(); ok++; console.log(`  PASS  ${nome}`); }
  catch (e: any) { falhou++; console.log(`  FALHA ${nome} -> ${e?.message ?? e}`); }
}
async function ta(nome: string, fn: () => Promise<void>) {
  try { await fn(); ok++; console.log(`  PASS  ${nome}`); }
  catch (e: any) { falhou++; console.log(`  FALHA ${nome} -> ${e?.message ?? e}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }
function lanca(fn: () => unknown, trecho: string) {
  try { fn(); } catch (e: any) {
    assert(String(e?.message ?? "").toLowerCase().includes(trecho.toLowerCase()), `mensagem inesperada: ${e?.message}`);
    return;
  }
  throw new Error(`deveria ter lançado (esperado conter "${trecho}")`);
}
async function lancaAsync(fn: () => Promise<unknown>, trecho: string) {
  try { await fn(); } catch (e: any) {
    assert(String(e?.message ?? "").toLowerCase().includes(trecho.toLowerCase()), `mensagem inesperada: ${e?.message}`);
    return;
  }
  throw new Error(`deveria ter lançado (esperado conter "${trecho}")`);
}

// ────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────
const USER = "user-abc";
const PROJ = "cccccccc-0000-0000-0000-000000000003";
const JOB = "aaaaaaaa-0000-0000-0000-000000000001";
const ORIGEM = "bbbbbbbb-0000-0000-0000-000000000002";

function prompt(over: Partial<PromptImagem> = {}): PromptImagem {
  return {
    ordem: 1,
    principal: true,
    tipo: "capa_principal",
    objetivo: "obj",
    cena: "cena",
    enquadramento: "produto_inteiro",
    fundo: "fundo neutro",
    iluminacao: "luz difusa",
    elementosObrigatorios: ["produto"],
    elementosProibidos: ["nada"],
    textosPermitidos: [],
    textosProibidos: ["qualquer texto"],
    aspectRatio: "1:1",
    promptTexto: "Fotografia de produto: X. Proporção: 1:1.",
    negativePrompt: "não adicionar texto",
    ...over,
  } as PromptImagem;
}
const PROMPTS: PromptImagem[] = [
  prompt({ ordem: 1, tipo: "capa_principal", principal: true }),
  prompt({ ordem: 2, tipo: "detalhes", principal: false }),
  prompt({ ordem: 3, tipo: "detalhes", principal: false }),
];
function envelopePrompts(over: Record<string, any> = {}) {
  return {
    fonteAnaliseVisual: { jobId: "x", resultadoId: "y", schemaVersao: 1 },
    configuracao: { quantidadeSolicitada: 3, estilo: null, modo: "rapido", marketplaces: ["ML"], aspectRatio: "1:1", tiposPermitidos: ["capa_principal", "detalhes"], restricoesVisuaisGlobais: [], textosPermitidos: [], textosProibidos: [] },
    entrada: { verdadeVisual: {}, restricoes: [] },
    prompts: PROMPTS,
    ...over,
  };
}
const dim = (l: number, a: number) => ({ largura: l, altura: a });
const bytes = (n = 1024) => new Uint8Array(n);

console.log("\n[validação do arquivo recebido]");
t("1. imagem válida 1:1 passa em todas as checagens", () => {
  const r = validarImagemRecebida({ bytes: bytes(), mimeReal: "image/png", dimensoes: dim(1024, 1024), aspectRatioEsperado: "1:1", ordem: 1 });
  assert(r.mime === "image/png" && r.dimensoes.largura === 1024, "retorno inesperado");
});
t("2. arquivo vazio é rejeitado como conteudo_rejeitado", () => {
  try { validarImagemRecebida({ bytes: new Uint8Array(0), mimeReal: "image/png", dimensoes: dim(1024, 1024), aspectRatioEsperado: "1:1", ordem: 1 }); }
  catch (e: any) { assert(e instanceof ErroProvedorIA && e.tipo === "conteudo_rejeitado" && /vazio/.test(e.message), `erro inesperado: ${e?.tipo} ${e?.message}`); return; }
  throw new Error("deveria ter lançado");
});
t("3. MIME não suportado é rejeitado (nunca confia no declarado)", () =>
  lanca(() => validarImagemRecebida({ bytes: bytes(), mimeReal: "image/gif" as any, dimensoes: dim(1024, 1024), aspectRatioEsperado: "1:1", ordem: 1 }), "mime real não suportado"));
t("4. MIME irreconhecível (arquivo corrompido) é rejeitado", () =>
  lanca(() => validarImagemRecebida({ bytes: bytes(), mimeReal: null, dimensoes: dim(1024, 1024), aspectRatioEsperado: "1:1", ordem: 1 }), "irreconhecível"));
t("5. dimensões ilegíveis são rejeitadas", () =>
  lanca(() => validarImagemRecebida({ bytes: bytes(), mimeReal: "image/png", dimensoes: null, aspectRatioEsperado: "1:1", ordem: 1 }), "não foi possível ler as dimensões"));
t("6. dimensão abaixo do mínimo é rejeitada", () =>
  lanca(() => validarImagemRecebida({ bytes: bytes(), mimeReal: "image/png", dimensoes: dim(DIMENSAO_MINIMA_PX - 1, DIMENSAO_MINIMA_PX - 1), aspectRatioEsperado: "1:1", ordem: 1 }), "abaixo da dimensão mínima"));
t("7. dimensão acima do máximo é rejeitada", () =>
  lanca(() => validarImagemRecebida({ bytes: bytes(), mimeReal: "image/png", dimensoes: dim(DIMENSAO_MAXIMA_PX + 1, DIMENSAO_MAXIMA_PX + 1), aspectRatioEsperado: "1:1", ordem: 1 }), "acima da dimensão máxima"));
t("8. proporção fora da tolerância é REJEITADA (nunca crop/resize silencioso)", () => {
  lanca(() => validarImagemRecebida({ bytes: bytes(), mimeReal: "image/png", dimensoes: dim(1024, 768), aspectRatioEsperado: "1:1", ordem: 2 }), "proporção");
  // dentro da tolerância de 2% continua passando
  const quase = Math.round(1024 * (1 + TOLERANCIA_ASPECT_RATIO / 2));
  validarImagemRecebida({ bytes: bytes(), mimeReal: "image/png", dimensoes: dim(quase, 1024), aspectRatioEsperado: "1:1", ordem: 2 });
});
t("9. arquivo gigante é rejeitado antes de qualquer upload", () =>
  lanca(() => validarImagemRecebida({ bytes: new Uint8Array(21 * 1024 * 1024), mimeReal: "image/png", dimensoes: dim(1024, 1024), aspectRatioEsperado: "1:1", ordem: 1 }), "acima do teto"));
t("10. razaoDoAspectRatio entende o contrato e rejeita lixo", () => {
  assert(razaoDoAspectRatio("1:1") === 1, "1:1 deveria ser 1");
  assert(razaoDoAspectRatio("4:5") === 0.8, "4:5 deveria ser 0.8");
  lanca(() => razaoDoAspectRatio("quadrado"), "aspectratio inválido");
  lanca(() => razaoDoAspectRatio("0:1"), "não-positivo");
});
t("11. MIMEs aceitos são exatamente os do bucket e do CHECK do banco", () => {
  assert(MIMES_IMAGEM_GERADA.join() === "image/jpeg,image/png,image/webp", `lista divergente: ${MIMES_IMAGEM_GERADA.join()}`);
  assert(!(MIMES_IMAGEM_GERADA as readonly string[]).includes("video/mp4"), "esta etapa não gera vídeo");
});

console.log("\n[caminho de Storage]");
t("12. caminho é determinístico, prefixado por user/projeto/job", () => {
  const c = montarCaminhoImagemGerada(USER, PROJ, JOB, "img-1", "image/png");
  assert(c === `${USER}/${PROJ}/geradas/${JOB}/img-1.png`, `caminho inesperado: ${c}`);
  validarCaminhoSeguro(c, USER, PROJ, JOB);
});
t("13. caminho de outro usuário/projeto/job é rejeitado", () => {
  const c = montarCaminhoImagemGerada(USER, PROJ, JOB, "img-1", "image/png");
  lanca(() => validarCaminhoSeguro(c, "outro-user", PROJ, JOB), "fora do prefixo");
  lanca(() => validarCaminhoSeguro(c, USER, "outro-projeto", JOB), "fora do prefixo");
  lanca(() => validarCaminhoSeguro(c, USER, PROJ, "outro-job"), "fora do prefixo");
  lanca(() => validarCaminhoSeguro(`${USER}/${PROJ}/geradas/${JOB}/../../x.png`, USER, PROJ, JOB), "sequência proibida");
  lanca(() => validarCaminhoSeguro(`${USER}/${PROJ}/geradas/${JOB}/sub/x.png`, USER, PROJ, JOB), "subdiretório");
});
t("14. extensão vem do MIME real, nunca de nome do modelo", () => {
  assert(montarCaminhoImagemGerada(USER, PROJ, JOB, "i", "image/jpeg").endsWith(".jpg"), "jpeg -> .jpg");
  assert(montarCaminhoImagemGerada(USER, PROJ, JOB, "i", "image/webp").endsWith(".webp"), "webp -> .webp");
});
t("15. bucket de saída é o de gerados, nunca o das fotos originais", () => {
  assert(BUCKET_IMAGENS_GERADAS === "estudio-anuncios-gerado", "bucket errado");
  assert((BUCKET_IMAGENS_GERADAS as string) !== (BUCKET_FOTOS_ORIGINAIS as string), "não pode escrever no bucket das originais");
});

console.log("\n[idempotência e recuperação parcial]");
t("16. cenário A — banco + arquivo presentes → reaproveitar", () => {
  const d = decidirIdempotencia({ id: "img-1", storage_path: "p", finalidade: "capa_principal", e_principal: true }, true);
  assert(d.acao === "reaproveitar" && d.imagemGeradaId === "img-1", `decisão inesperada: ${d.acao}`);
});
t("17. cenário B — banco sem arquivo → inconsistência explícita, nunca regerar", () => {
  const d = decidirIdempotencia({ id: "img-1", storage_path: "p", finalidade: "capa_principal", e_principal: true }, false);
  assert(d.acao === "inconsistencia" && /storage/i.test(d.motivo), `decisão inesperada: ${JSON.stringify(d)}`);
});
t("18. linha sem storage_path também é inconsistência", () => {
  const d = decidirIdempotencia({ id: "img-1", storage_path: null, finalidade: "capa_principal", e_principal: true }, false);
  assert(d.acao === "inconsistencia", `decisão inesperada: ${d.acao}`);
});
t("19. sem linha → gerar (e o upload usa upsert:false, sem sobrescrever órfão)", () => {
  assert(decidirIdempotencia(null, false).acao === "gerar", "deveria gerar");
  assert(decidirIdempotencia(undefined, true).acao === "gerar", "deveria gerar");
  const fonte = fs.readFileSync(path.join(process.cwd(), "lib/estudio-anuncios/storage.ts"), "utf-8");
  const bloco = fonte.slice(fonte.indexOf("uploadImagemGerada"));
  assert(/upsert:\s*false/.test(bloco), "upload de imagem gerada precisa de upsert:false");
});
t("20. cenário D — falha na imagem 2 preserva a 1, e o retry retoma da 2", () => {
  // Cada prompt decide sozinho: 1 já persistido reaproveita, 2 gera.
  const jaPersistida = { id: "img-1", storage_path: "p1", finalidade: "capa_principal", e_principal: true };
  assert(decidirIdempotencia(jaPersistida, true).acao === "reaproveitar", "imagem 1 deveria ser reaproveitada");
  assert(decidirIdempotencia(null, false).acao === "gerar", "imagem 2 deveria ser gerada");
});
t("21. concorrência: unicidade garantida no BANCO, não só em TypeScript", () => {
  const mig = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260816_imagens_geradas_rastreabilidade.sql"), "utf-8");
  assert(/CREATE UNIQUE INDEX IF NOT EXISTS idx_imagens_geradas_job_prompt/.test(mig), "falta o unique (job_id, prompt_ordem)");
  assert(/\(job_id, prompt_ordem\)/.test(mig), "unique com colunas erradas");
  assert(/CREATE UNIQUE INDEX IF NOT EXISTS idx_imagens_geradas_storage_path/.test(mig), "falta o unique de storage_path");
});
t("22. numero_versao mantém válido o unique (projeto, finalidade, versao)", () => {
  const m = calcularNumeroVersaoPorOrdem(PROMPTS);
  assert(m.get(1) === 1, "capa_principal deveria ser versão 1");
  assert(m.get(2) === 1 && m.get(3) === 2, `dois 'detalhes' deveriam ser 1 e 2, vieram ${m.get(2)} e ${m.get(3)}`);
  // determinístico: mesma entrada, mesmo mapa (pré-requisito do retry)
  const m2 = calcularNumeroVersaoPorOrdem([...PROMPTS].reverse());
  assert(m2.get(2) === 1 && m2.get(3) === 2, "mapa não é determinístico");
});
t("22b. numero_versao continua a partir do que o PROJETO já tem (regressão real)", () => {
  // Defeito real de 2026-08-18: numerar só dentro do job colidia com
  // imagens de jobs anteriores do mesmo projeto — o INSERT quebrava
  // DEPOIS de a imagem ter sido gerada e paga.
  const existentes = new Map<string, number>([["capa_principal", 1], ["detalhes", 2]]);
  const m = calcularNumeroVersaoPorOrdem(PROMPTS, existentes);
  assert(m.get(1) === 2, `capa_principal deveria continuar em 2, veio ${m.get(1)}`);
  assert(m.get(2) === 3 && m.get(3) === 4, `detalhes deveriam ser 3 e 4, vieram ${m.get(2)} e ${m.get(3)}`);
  // Finalidade nunca vista antes começa em 1.
  const so = calcularNumeroVersaoPorOrdem([prompt({ ordem: 1, tipo: "uso", principal: false })], existentes);
  assert(so.get(1) === 1, "finalidade nova deveria começar em 1");
});

console.log("\n[referências visuais]");
const fotos = [
  { id: "f2", ordem: 2, e_principal: false, storage_path: "b", mime_type: "image/png", tamanho_bytes: 1000 },
  { id: "f1", ordem: 1, e_principal: true, storage_path: "a", mime_type: "image/jpeg", tamanho_bytes: 1000 },
  { id: "f3", ordem: 3, e_principal: false, storage_path: "c", mime_type: "image/webp", tamanho_bytes: 1000 },
  { id: "f4", ordem: 4, e_principal: false, storage_path: "d", mime_type: "image/jpeg", tamanho_bytes: 1000 },
];
t("23. seleção é determinística: principal primeiro, depois ordem ASC", () => {
  const s = selecionarReferencias(fotos);
  assert(s[0].id === "f1", "principal deveria vir primeiro");
  assert(s.map(f => f.id).join() === "f1,f2,f3", `seleção inesperada: ${s.map(f => f.id).join()}`);
  assert(s.length <= MAX_REFERENCIAS_VISUAIS, "estourou o teto de referências");
});
t("24. foto com MIME não aceito é pulada, nunca enviada no escuro", () => {
  const s = selecionarReferencias([{ ...fotos[1], mime_type: "image/gif" }, fotos[0]]);
  assert(s.length === 1 && s[0].id === "f2", `seleção inesperada: ${s.map(f => f.id).join()}`);
});
t("25. orçamento de bytes é respeitado e não elimina as seguintes", () => {
  const s = selecionarReferencias([
    { ...fotos[1], tamanho_bytes: 9 * 1024 * 1024 },
    { ...fotos[0], tamanho_bytes: 1000 },
  ]);
  assert(s.length === 1 && s[0].id === "f2", `a foto gigante deveria ser pulada, não truncar a lista: ${s.map(f => f.id).join()}`);
});

console.log("\n[origem semântica]");
function fakeSupabase(cfg: { job?: any; origem?: any; resultados?: any[] }) {
  return {
    from(tabela: string) {
      return {
        select() {
          return {
            eq(_col: string, val: any) {
              if (tabela === "estudio_anuncios_resultados_pipeline") {
                const r = { data: cfg.resultados ?? [], error: null };
                return { maybeSingle: async () => ({ data: (cfg.resultados ?? [])[0] ?? null, error: null }), then: (res: any) => res(r) };
              }
              const linha = val === JOB ? cfg.job ?? null : cfg.origem ?? null;
              return { maybeSingle: async () => ({ data: linha, error: null }), then: (res: any) => res({ data: linha ? [linha] : [], error: null }) };
            },
          };
        },
      };
    },
  } as any;
}
const CTX = { jobId: JOB, projetoId: PROJ, etapa: "geracao_imagem" };
const okJob = { id: JOB, projeto_id: PROJ, job_origem_id: ORIGEM };
const okOrigem = { id: ORIGEM, projeto_id: PROJ, etapa: "geracao_prompts_imagem", status: "concluido" };
const okRes = (env = envelopePrompts()) => [{ id: "res-1", etapa: "geracao_prompts_imagem", schema_versao: 1, resultado: env }];

async function rodarTestesDeOrigem() {
  await ta("26. origem válida devolve prompts ordenados e a referência embutida", async () => {
    const r = await validarOrigemEBuscarPrompts(fakeSupabase({ job: okJob, origem: okOrigem, resultados: okRes() }), CTX);
    assert(r.jobOrigemId === ORIGEM && r.resultadoId === "res-1" && r.schemaVersao === 1, "referência de origem incorreta");
    assert(r.prompts.map(p => p.ordem).join() === "1,2,3", "prompts fora de ordem");
    assert(r.aspectRatio === "1:1", "aspectRatio não veio do envelope");
  });
  await ta("27. origem ausente (job_origem_id null) é rejeitada", () =>
    lancaAsync(() => validarOrigemEBuscarPrompts(fakeSupabase({ job: { ...okJob, job_origem_id: null } }), CTX), "job_origem_id ausente"));
  await ta("28. origem de etapa errada (analise_visual) é rejeitada", () =>
    lancaAsync(() => validarOrigemEBuscarPrompts(fakeSupabase({ job: okJob, origem: { ...okOrigem, etapa: "analise_visual" }, resultados: okRes() }), CTX), 'esperado "geracao_prompts_imagem"'));
  await ta("29. origem de outro projeto é rejeitada", () =>
    lancaAsync(() => validarOrigemEBuscarPrompts(fakeSupabase({ job: okJob, origem: { ...okOrigem, projeto_id: "outro" }, resultados: okRes() }), CTX), "outro projeto"));
  await ta("30. origem não concluída é rejeitada", () =>
    lancaAsync(() => validarOrigemEBuscarPrompts(fakeSupabase({ job: okJob, origem: { ...okOrigem, status: "rodando" }, resultados: okRes() }), CTX), "não está concluído"));
  await ta("31. resultado de prompts ausente é rejeitado", () =>
    lancaAsync(() => validarOrigemEBuscarPrompts(fakeSupabase({ job: okJob, origem: okOrigem, resultados: [] }), CTX), "encontrado 0"));
  await ta("32. schema_versao incompatível é rejeitado", () =>
    lancaAsync(() => validarOrigemEBuscarPrompts(fakeSupabase({ job: okJob, origem: okOrigem, resultados: [{ ...okRes()[0], schema_versao: 2 }] }), CTX), "schema_versao"));
  await ta("33. quantidade divergente da configuração é rejeitada", () =>
    lancaAsync(() => validarOrigemEBuscarPrompts(fakeSupabase({ job: okJob, origem: okOrigem, resultados: okRes(envelopePrompts({ prompts: PROMPTS.slice(0, 2) })) }), CTX), "envelope inconsistente"));
  await ta("34. envelope sem exatamente 1 principal é rejeitado", () =>
    lancaAsync(() => validarOrigemEBuscarPrompts(fakeSupabase({ job: okJob, origem: okOrigem, resultados: okRes(envelopePrompts({ prompts: PROMPTS.map(p => ({ ...p, principal: true })) })) }), CTX), "principal"));
  // "beneficios" virou finalidade VALIDA em 2026-09-04; o exemplo de
  // invalido passou a ser um valor que nunca existiu no CHECK do banco.
  await ta("35. finalidade inválida no envelope é rejeitada", () =>
    lancaAsync(() => validarOrigemEBuscarPrompts(fakeSupabase({ job: okJob, origem: okOrigem, resultados: okRes(envelopePrompts({ prompts: [prompt({ tipo: "carrossel_animado" as any })], configuracao: { ...envelopePrompts().configuracao, quantidadeSolicitada: 1 } })) }), CTX), "finalidade inválida"));
  await ta("36. prompt sem texto final é rejeitado (nunca inventa prompt)", () =>
    lancaAsync(() => validarOrigemEBuscarPrompts(fakeSupabase({ job: okJob, origem: okOrigem, resultados: okRes(envelopePrompts({ prompts: [prompt({ promptTexto: "  " })], configuracao: { ...envelopePrompts().configuracao, quantidadeSolicitada: 1 } })) }), CTX), "sem texto final"));
}

console.log("\n[registry, roteamento, provedor e custo]");
t("37. registry sem conflito — nenhuma etapa nos dois conjuntos", () => {
  for (const etapa of Object.keys(HANDLERS_ESPECIFICOS)) {
    assert(!ETAPAS_FAKE_GENERICAS.has(etapa), `etapa "${etapa}" está nos dois conjuntos`);
    assert(HANDLERS_ESPECIFICOS[etapa].etapa === etapa, `chave e handler divergem em "${etapa}"`);
  }
});
t("38. geracao_imagem tem handler específico com o contrato correto", () => {
  const h = resolverHandler("geracao_imagem");
  assert(!!h && h.etapa === "geracao_imagem", "handler não resolvido");
  assert(h!.provedoresPermitidos.join() === "fake,google", `provedores: ${h!.provedoresPermitidos.join()}`);
  assert(h!.versaoSaida === SCHEMA_VERSAO_GERACAO_IMAGEM, "versaoSaida divergente");
  assert(h!.dependencia === "job_origem_id", "dependência declarada errada");
  assert(h!.geraResultadoEstruturado === true, "deveria gerar resultado estruturado");
});
t("39. fake das demais etapas preservado (invariante, sem contagem fixa)", () => {
  assert(ETAPAS_FAKE_GENERICAS.size > 0, "conjunto fake não pode ficar vazio nesta fase");
  for (const etapa of ETAPAS_FAKE_GENERICAS) {
    const h = resolverHandler(etapa);
    assert(!!h && h.etapa === "*" && !(etapa in HANDLERS_ESPECIFICOS), `etapa "${etapa}" perdeu o caminho fake`);
  }
  assert(!ETAPAS_FAKE_GENERICAS.has("geracao_imagem"), "promovida mas ainda no conjunto fake");
});
t("40. flag false/ausente mantém fake; true roteia para google; não vaza para outras etapas", () => {
  const antes = process.env.GOOGLE_AI_IMAGEM_ENABLED;
  const antesPrompts = process.env.GOOGLE_AI_PROMPTS_IMAGEM_ENABLED;
  try {
    delete process.env.GOOGLE_AI_IMAGEM_ENABLED;
    assert(decidirProvedor("geracao_imagem") === "fake", "ausente deveria ser fake");
    process.env.GOOGLE_AI_IMAGEM_ENABLED = "1";
    assert(decidirProvedor("geracao_imagem") === "fake", '"1" deveria ser fake');
    process.env.GOOGLE_AI_IMAGEM_ENABLED = "true";
    assert(decidirProvedor("geracao_imagem") === "google", '"true" deveria ser google');
    delete process.env.GOOGLE_AI_PROMPTS_IMAGEM_ENABLED;
    // calculo_score roteia para "internal" desde 2026-08-17, entao a
    // checagem compara antes/depois em vez de fixar "fake".
    assert(decidirProvedor("geracao_prompts_imagem") === "fake", "flag vazou para geracao_prompts_imagem");
    delete process.env.GOOGLE_AI_IMAGEM_ENABLED;
    const scoreSemFlag = decidirProvedor("calculo_score");
    process.env.GOOGLE_AI_IMAGEM_ENABLED = "true";
    assert(decidirProvedor("calculo_score") === scoreSemFlag, "flag vazou para calculo_score");
  } finally {
    if (antes === undefined) delete process.env.GOOGLE_AI_IMAGEM_ENABLED; else process.env.GOOGLE_AI_IMAGEM_ENABLED = antes;
    if (antesPrompts === undefined) delete process.env.GOOGLE_AI_PROMPTS_IMAGEM_ENABLED; else process.env.GOOGLE_AI_PROMPTS_IMAGEM_ENABLED = antesPrompts;
  }
});
t("41. modelo ausente/vazio falha como auth, antes de qualquer chamada paga", () => {
  const antes = process.env.GOOGLE_AI_MODEL_IMAGEM;
  try {
    process.env.GOOGLE_AI_MODEL_IMAGEM = "   ";
    let erro: any;
    try { obterModeloImagem(); } catch (e) { erro = e; }
    assert(erro instanceof ErroProvedorIA && erro.tipo === "auth", `esperado auth, veio ${erro?.tipo}`);
    process.env.GOOGLE_AI_MODEL_IMAGEM = " gemini-3.1-flash-image ";
    assert(obterModeloImagem() === "gemini-3.1-flash-image", "trim não aplicado");
  } finally {
    if (antes === undefined) delete process.env.GOOGLE_AI_MODEL_IMAGEM; else process.env.GOOGLE_AI_MODEL_IMAGEM = antes;
  }
});
t("42. timeout próprio, com teto, nunca o de 30s do texto", () => {
  const antes = process.env.GOOGLE_AI_IMAGEM_TIMEOUT_MS;
  try {
    delete process.env.GOOGLE_AI_IMAGEM_TIMEOUT_MS;
    const padrao = obterTimeoutImagemMs();
    assert(padrao === 90_000, `padrão inesperado: ${padrao}`);
    assert(padrao > 30_000, "não pode reaproveitar o timeout de texto");
    process.env.GOOGLE_AI_IMAGEM_TIMEOUT_MS = "120000";
    assert(obterTimeoutImagemMs() === 120_000, "valor explícito ignorado");
    process.env.GOOGLE_AI_IMAGEM_TIMEOUT_MS = "999999999";
    lanca(() => obterTimeoutImagemMs(), "inválido");
    process.env.GOOGLE_AI_IMAGEM_TIMEOUT_MS = "0";
    lanca(() => obterTimeoutImagemMs(), "inválido");
  } finally {
    if (antes === undefined) delete process.env.GOOGLE_AI_IMAGEM_TIMEOUT_MS; else process.env.GOOGLE_AI_IMAGEM_TIMEOUT_MS = antes;
  }
});
t("43. erros do provedor caem nas categorias do CHECK do banco", () => {
  const casos: [number, string][] = [[401, "auth"], [403, "auth"], [429, "rate_limit"], [500, "transient"], [503, "transient"], [400, "validation"]];
  for (const [status, esperado] of casos) {
    const e = mapearErroGoogle(Object.assign(new Error("x"), { status }));
    assert(e.tipo === esperado, `status ${status}: esperado ${esperado}, veio ${e.tipo}`);
  }
  assert(mapearErroGoogle(new Error("Request timed out")).tipo === "transient", "timeout deveria ser transient");
  assert(mapearErroGoogle(Object.assign(new Error("net"), { name: "APIConnectionError" })).tipo === "transient", "erro de rede deveria ser transient");
  const validos = ["transient", "auth", "rate_limit", "conteudo_rejeitado", "validation", "unknown"];
  assert(validos.includes(mapearErroGoogle(new Error("algo estranho")).tipo), "categoria fora do CHECK");
});
t("44. custo do modelo de imagem instrumentado; modelo desconhecido segue 0", () => {
  // AJUSTE (2026-08-18): antes este teste exigia custo 0 para o modelo de
  // imagem, porque nao havia preco oficial cadastrado. O preco foi
  // verificado na documentacao oficial e instrumentado — a asercao passou
  // a ser "cobra as duas taxas de saida corretamente". Detalhe completo
  // em scripts/testar-custos.ts.
  assert(estimarCustoUsd("gemini-3.1-flash-image", 0, 1120, 1120) > 0, "modelo de imagem deveria ter preco cadastrado");
  assert(estimarCustoUsd("gemini-3.1-flash-image", 0, 1120, 1120) !== estimarCustoUsd("gemini-3.1-flash-image", 0, 1120, 0),
    "saida de imagem e de texto precisam ser cobradas a taxas diferentes");
  assert(estimarCustoUsd("modelo-de-imagem-inexistente", 1000, 1000, 500) === 0, "modelo desconhecido deveria custar 0");
  assert(estimarCustoUsd("gemini-3.6-flash", 1_000_000, 0) === 1.5, "preço do modelo de texto regrediu");
});
t("45. tipo de prompt mapeado continua sendo `imagem`", () =>
  assert(decidirTipoPrompt("geracao_imagem") === "imagem", "categoria de prompt errada"));

console.log("\n[limites de escopo — o que esta etapa NUNCA faz]");
function semComentarios(fonte: string): string {
  return fonte.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}
const FONTE_DOMINIO = semComentarios(fs.readFileSync(path.join(process.cwd(), "lib/estudio-anuncios/geracao-imagem.ts"), "utf-8"));
const FONTE_HANDLER = semComentarios(fs.readFileSync(path.join(process.cwd(), "lib/estudio-anuncios/executores/geracao-imagem.ts"), "utf-8"));
const FONTE_PROVEDOR = semComentarios(fs.readFileSync(path.join(process.cwd(), "lib/ai-gateway/provedores/google-imagem.ts"), "utf-8"));
t("46. nenhuma escrita em conteudo_versoes nem alteração das fotos originais", () => {
  for (const f of [FONTE_DOMINIO, FONTE_HANDLER]) {
    assert(!/conteudo_versoes/.test(f), "tocou em conteudo_versoes");
    assert(!/estudio_anuncios_score|calculo_score/.test(f), "tocou em score");
  }
  // imagens_origem só pode ser LIDA (select), nunca escrita.
  assert(/from\("estudio_anuncios_imagens_origem"\)\s*\.select/.test(FONTE_DOMINIO), "deveria ler as fotos originais");
  const trechoOrigem = FONTE_DOMINIO.split('from("estudio_anuncios_imagens_origem")')[1]?.slice(0, 300) ?? "";
  assert(!/\.insert\(|\.update\(|\.delete\(|\.upsert\(/.test(trechoOrigem), "escreveu nas fotos originais");
});
t("47. nenhuma resolução por 'o mais recente' e nenhuma URL pública/assinada", () => {
  for (const f of [FONTE_DOMINIO, FONTE_HANDLER, FONTE_PROVEDOR]) {
    assert(!/\.order\(/.test(f), "usou ORDER BY no banco");
    assert(!/criado_em/.test(f), "ordenou/filtrou por criado_em");
    assert(!/getPublicUrl|createSignedUrl|gerarUrlAssinada/.test(f), "gerou URL pública/assinada sem necessidade");
  }
});
t("48. não reinterpreta conteúdo comercial nem refaz analise_visual", () => {
  assert(!/EnvelopeAdaptacaoMarketplace|EnvelopeRevisaoClaude|EnvelopeGeracaoConteudo|AnaliseVisualCompleta/.test(FONTE_DOMINIO), "consumiu artefato que não é o dela");
  assert(/EnvelopeGeracaoPromptsImagem/.test(FONTE_DOMINIO), "deveria consumir o envelope de prompts");
});
t("49. o prompt vem do envelope, nunca é construído aqui", () => {
  assert(/prompt\.promptTexto/.test(FONTE_DOMINIO), "deveria usar o promptTexto do envelope");
  assert(!/Fotografia de produto:/.test(FONTE_DOMINIO), "não pode montar prompt próprio");
});
t("50. store:false e nenhum log de bytes no cliente de imagem", () => {
  assert(/store:\s*false/.test(FONTE_PROVEDOR), "faltou store:false");
  assert(!/console\.(log|info|warn|error)/.test(FONTE_PROVEDOR), "cliente de imagem não deve logar nada");
});
t("51. resumo curto não vaza caminho de Storage, bytes nem URL", () => {
  const resumo = montarResumoCurtoImagem({
    fontePromptsImagem: { jobId: "j", resultadoId: "r", schemaVersao: 1 },
    configuracao: { quantidadePrevista: 3, aspectRatio: "1:1", toleranciaAspectRatio: TOLERANCIA_ASPECT_RATIO, dimensaoMinimaPx: DIMENSAO_MINIMA_PX, dimensaoMaximaPx: DIMENSAO_MAXIMA_PX, referencias: [] },
    imagens: [
      { imagemGeradaId: "i1", ordem: 1, principal: true, finalidade: "capa_principal", reaproveitada: false },
      { imagemGeradaId: "i2", ordem: 2, principal: false, finalidade: "detalhes", reaproveitada: true },
    ],
  });
  assert(resumo.length <= 500, "resumo longo demais");
  assert(!/geradas\/|http|base64/.test(resumo), `resumo vazou informação: ${resumo}`);
  assert(/reuso/.test(resumo), "reaproveitamento deveria ser visível no resumo");
});

rodarTestesDeOrigem().then(() => {
  console.log(`\n=== RESULTADO: ${ok} passaram, ${falhou} falharam ===\n`);
  process.exitCode = falhou > 0 ? 1 : 0;
});
