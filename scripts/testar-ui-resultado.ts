/**
 * Testes determinísticos da leitura que alimenta a UI de resultado —
 * `lib/estudio-anuncios/resultados.ts`. Sem banco real, sem Storage, sem
 * rede, custo zero: usa um cliente Supabase de mentira.
 *
 * Uso: npx tsx scripts/testar-ui-resultado.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  adaptarAnaliseVisual,
  adaptarRevisao,
  buscarResultadosPipelinePorProjeto,
  buscarCustoProjeto,
  buscarImagensGeradasPorProjeto,
  montarResultadoProjeto,
} from "../lib/estudio-anuncios/resultados";
import type { AnaliseVisualCompleta } from "../lib/ai-gateway/provedores/google-tipos";

let ok = 0, falhou = 0;
async function t(nome: string, fn: () => void | Promise<void>) {
  try { await fn(); ok++; console.log(`  PASS  ${nome}`); }
  catch (e: any) { falhou++; console.log(`  FALHA ${nome} -> ${e?.message ?? e}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

const PROJ = "11111111-1111-1111-1111-111111111111";
const OUTRO = "22222222-2222-2222-2222-222222222222";

// ────────────────────────────────────────────────────────────────────
// Cliente de mentira: guarda os filtros aplicados para o teste provar
// que TODA leitura filtra por projeto_id.
// ────────────────────────────────────────────────────────────────────
const filtrosAplicados: { tabela: string; coluna: string; valor: any }[] = [];
function fakeSupabase(dados: Record<string, any[]>) {
  return {
    from(tabela: string) {
      return {
        select() {
          return {
            eq(coluna: string, valor: any) {
              filtrosAplicados.push({ tabela, coluna, valor });
              const linhas = (dados[tabela] ?? []).filter(l => l[coluna] === valor);
              return { then: (r: any) => r({ data: linhas, error: null }) };
            },
          };
        },
      };
    },
    storage: {
      from(bucket: string) {
        return {
          createSignedUrl: async (caminho: string) => {
            // "objeto ausente" é simulado por um caminho conhecido.
            if (caminho.includes("SUMIU")) return { data: null, error: { message: "not found" } };
            return { data: { signedUrl: `https://signed.example/${bucket}/${caminho}?token=xyz` }, error: null };
          },
        };
      },
    },
  } as any;
}

const ANALISE: AnaliseVisualCompleta = {
  produtoIdentificado: "Kit de rolo massageador",
  marca: null, modelo: null,
  categoriaProvavel: ["Beleza", "Skincare"],
  resumoVisual: "Conjunto verde.",
  caracteristicasVisiveis: [
    { descricao: "Rolo duplo de pedra.", origem: "produto" },
    { descricao: "Efeito lifting imediato", origem: "material_promocional" },
  ],
  cores: [{ valor: "Verde", origem: "produto" }, { valor: "Azul", origem: "embalagem_fisica" }],
  materiais: [{ valor: "Pedra", origem: "produto" }],
  componentes: [{ valor: "Rolo", origem: "produto" }],
  textosLegiveis: [{ texto: "JADE ROLLER", origem: "embalagem_fisica" }],
  quantidadeDeclarada: { valor: null, textoOrigem: null },
  possiveisUsos: [{ descricao: "Massagem facial.", origem: "produto" }],
  publicoProvavel: [{ descricao: "Skincare.", origem: "produto" }],
  alertas: ["Embalagem pode confundir"],
  informacoesNaoConfirmadas: ["Composição mineral"],
  qualidadeDasFotos: { nota: 80, problemas: ["Fundo estourado"], sugestoes: ["Difundir a luz"] },
  atributosAdicionais: [{ nome: "Tipo", valor: "Duplo", origem: "produto" }],
  fotosAnalisadas: [{ imagemId: "f1", ordem: 1, principal: true }],
  metadadosAnalise: { totalFotosProjeto: 1, totalFotosAnalisadas: 1, analiseParcial: false, motivoAnaliseParcial: null },
};

const CONTEUDO = {
  fonteAnaliseVisual: { jobId: "av", resultadoId: "r", schemaVersao: 1 },
  entrada: { fatosPermitidos: [], descricoesComRessalva: [], informacoesProibidas: [], contextoPromocional: [], alertas: [], fatosAfetadosPorAlerta: [] },
  saida: {
    tituloBase: { texto: "Titulo original", fatoIds: ["F1"] },
    descricaoCurta: { texto: "Desc original", contemRessalva: false, fatoIds: ["F1"] },
    bullets: [{ texto: "B1", contemRessalva: false, fatoIds: ["F1"] }],
  },
};
const REVISAO = {
  fonteConteudoBase: { jobId: "gc", resultadoId: "r", schemaVersao: 1 },
  entrada: { trechos: [{ ref: "tituloBase", textoOriginal: "Titulo original" }, { ref: "bullet:0", textoOriginal: "B1" }], restricoes: [] },
  saida: {
    textos: [
      { ref: "tituloBase", textoRevisado: "Titulo revisado", alterado: true, motivo: "clareza" },
      { ref: "bullet:0", textoRevisado: "B1", alterado: false },
    ],
    observacoes: ["obs"],
  },
  conteudoRevisado: {
    tituloBase: { texto: "Titulo revisado", fatoIds: ["F1"] },
    descricaoCurta: { texto: "Desc original", contemRessalva: false, fatoIds: ["F1"] },
    bullets: [{ texto: "B1", contemRessalva: false, fatoIds: ["F1"] }],
  },
};
const ADAPTACAO = {
  fonteGeracaoConteudo: { jobId: "gc", resultadoId: "r", schemaVersao: 1 },
  entrada: { conteudoBase: CONTEUDO.saida, marketplacesAlvo: ["ML"], ctasPermitidos: [], restricoes: [] },
  saida: { adaptacoes: [{ marketplace: "ML", titulo: "T-ML", descricao: "D-ML" }, { marketplace: "Shopee", titulo: "T-SH", descricao: "D-SH" }] },
};
const PROMPTS = {
  fonteAnaliseVisual: { jobId: "av", resultadoId: "r", schemaVersao: 1 },
  configuracao: { quantidadeSolicitada: 2, aspectRatio: "1:1" },
  entrada: {},
  prompts: [
    { ordem: 1, principal: true, tipo: "capa_principal", objetivo: "obj1", promptTexto: "P1", negativePrompt: "N" },
    { ordem: 2, principal: false, tipo: "detalhes", objetivo: "obj2", promptTexto: "P2", negativePrompt: "N" },
  ],
};
const SCORE = {
  scoreTotal: 96, classificacao: "excelente", versaoRegrasScore: "regras-score-v1",
  blocos: [{ codigo: "conteudo", nome: "Conteúdo", pesoMaximo: 20, pontos: 18.5, percentual: 93, criterios: [] }],
  alertas: ["alerta"], fontes: {}, calculadoEm: "2026-08-17T00:00:00Z",
};

function baseDados(over: Partial<Record<string, any[]>> = {}) {
  return {
    estudio_anuncios_resultados_pipeline: [
      { projeto_id: PROJ, etapa: "analise_visual", schema_versao: 1, resultado: ANALISE, criado_em: "2026-08-01" },
      { projeto_id: PROJ, etapa: "geracao_conteudo", schema_versao: 1, resultado: CONTEUDO, criado_em: "2026-08-02" },
      { projeto_id: PROJ, etapa: "revisao_claude", schema_versao: 1, resultado: REVISAO, criado_em: "2026-08-03" },
      { projeto_id: PROJ, etapa: "adaptacao_marketplace", schema_versao: 1, resultado: ADAPTACAO, criado_em: "2026-08-04" },
      { projeto_id: PROJ, etapa: "geracao_prompts_imagem", schema_versao: 1, resultado: PROMPTS, criado_em: "2026-08-05" },
      { projeto_id: PROJ, etapa: "calculo_score", schema_versao: 1, resultado: SCORE, criado_em: "2026-08-06" },
      // Artefato de OUTRO projeto — nunca pode aparecer.
      { projeto_id: OUTRO, etapa: "calculo_score", schema_versao: 1, resultado: { ...SCORE, scoreTotal: 1 }, criado_em: "2026-08-06" },
    ],
    estudio_anuncios_imagens_geradas: [
      { projeto_id: PROJ, id: "i2", prompt_ordem: 2, finalidade: "detalhes", e_principal: false, largura_px: 1024, altura_px: 1024, tamanho_bytes: 100, mime_type: "image/jpeg", provedor: "google", modelo: "m", storage_path: "u/p/geradas/j/i2.jpg", numero_versao: 1 },
      { projeto_id: PROJ, id: "i1", prompt_ordem: 1, finalidade: "capa_principal", e_principal: true, largura_px: 1024, altura_px: 1024, tamanho_bytes: 200, mime_type: "image/jpeg", provedor: "google", modelo: "m", storage_path: "u/p/geradas/j/i1.jpg", numero_versao: 1 },
      { projeto_id: OUTRO, id: "iX", prompt_ordem: 1, finalidade: "capa_principal", e_principal: true, largura_px: 1, altura_px: 1, tamanho_bytes: 1, mime_type: "image/jpeg", provedor: "google", modelo: "m", storage_path: "outro/p/geradas/j/iX.jpg", numero_versao: 1 },
    ],
    central_ia_consumo: [
      { projeto_id: PROJ, job_id: "job-av", provedor: "google", modelo: "gemini-3.6-flash", custo_estimado: "0.01", tokens_entrada: 100, tokens_saida: 200, unidades_geradas: 1 },
      { projeto_id: PROJ, job_id: "job-img", provedor: "google", modelo: "gemini-3.1-flash-image", custo_estimado: "0.0684885", tokens_entrada: 663, tokens_saida: 1439, unidades_geradas: 1 },
      // Órfãos: sem job_id, e com job de outro projeto — nenhum entra na soma.
      { projeto_id: PROJ, job_id: null, provedor: "google", modelo: "x", custo_estimado: "999", tokens_entrada: 0, tokens_saida: 0, unidades_geradas: 0 },
      { projeto_id: PROJ, job_id: "job-de-outro", provedor: "google", modelo: "x", custo_estimado: "555", tokens_entrada: 0, tokens_saida: 0, unidades_geradas: 0 },
    ],
    estudio_anuncios_jobs: [
      { projeto_id: PROJ, id: "job-av", etapa: "analise_visual" },
      { projeto_id: PROJ, id: "job-img", etapa: "geracao_imagem" },
      { projeto_id: OUTRO, id: "job-de-outro", etapa: "geracao_imagem" },
    ],
    ...over,
  } as Record<string, any[]>;
}

async function rodar() {
  console.log("\n[isolamento por projeto e fonte oficial]");
  await t("1. toda leitura filtra por projeto_id — nunca vaza outro projeto", async () => {
    filtrosAplicados.length = 0;
    const sb = fakeSupabase(baseDados());
    const r = await montarResultadoProjeto(sb, sb, PROJ);
    assert(filtrosAplicados.length > 0, "nenhum filtro aplicado");
    for (const f of filtrosAplicados) {
      assert(f.coluna === "projeto_id" && f.valor === PROJ, `filtro sem isolamento: ${f.tabela}.${f.coluna}=${f.valor}`);
    }
    assert(r.score!.scoreTotal === 96, "score de outro projeto vazou");
    assert(r.imagens.every(i => i.id !== "iX"), "imagem de outro projeto vazou");
  });
  await t("2. a tabela LEGADA de score nunca é consultada", async () => {
    filtrosAplicados.length = 0;
    const sb = fakeSupabase(baseDados());
    await montarResultadoProjeto(sb, sb, PROJ);
    assert(!filtrosAplicados.some(f => f.tabela === "estudio_anuncios_score"), "leu a tabela legada");
    const fonte = fs.readFileSync(path.join(process.cwd(), "lib/estudio-anuncios/resultados.ts"), "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
    assert(!/estudio_anuncios_score/.test(fonte), "referência à tabela legada no código");
  });
  await t("3. o score vem da fonte oficial (resultados_pipeline/calculo_score)", async () => {
    const sb = fakeSupabase(baseDados());
    const r = await montarResultadoProjeto(sb, sb, PROJ);
    assert(r.score?.versaoRegrasScore === "regras-score-v1", "score não veio do envelope oficial");
    assert(r.score?.classificacao === "excelente" && r.score?.blocos.length === 1, "envelope de score não repassado como está");
  });

  console.log("\n[estados parciais — a tela nunca quebra]");
  const cenariosVazios: [string, string][] = [
    ["6. analise_visual ausente", "analise_visual"],
    ["7. geracao_conteudo ausente", "geracao_conteudo"],
    ["8. revisão ausente", "revisao_claude"],
    ["9. adaptação ausente", "adaptacao_marketplace"],
    ["10. prompts de imagem ausentes", "geracao_prompts_imagem"],
    ["12. score ausente", "calculo_score"],
  ];
  for (const [nome, etapaRemovida] of cenariosVazios) {
    await t(`${nome} → seção null, resto intacto`, async () => {
      const dados = baseDados();
      dados.estudio_anuncios_resultados_pipeline = dados.estudio_anuncios_resultados_pipeline.filter(l => l.etapa !== etapaRemovida);
      const sb = fakeSupabase(dados);
      const r = await montarResultadoProjeto(sb, sb, PROJ);
      const mapa: Record<string, unknown> = {
        analise_visual: r.analiseVisual, geracao_conteudo: r.conteudo, revisao_claude: r.revisao,
        adaptacao_marketplace: r.marketplaces, geracao_prompts_imagem: r.promptsImagem, calculo_score: r.score,
      };
      if (etapaRemovida !== "geracao_conteudo") assert(mapa[etapaRemovida] === null, `${etapaRemovida} deveria ser null`);
      assert(r.custos.porEtapa.length === 2, "custos deveriam continuar");
      assert(r.imagens.length === 2, "imagens deveriam continuar");
    });
  }
  await t("4/5. projeto sem NENHUM artefato devolve tudo null, sem lançar", async () => {
    const sb = fakeSupabase({ estudio_anuncios_resultados_pipeline: [], estudio_anuncios_imagens_geradas: [], central_ia_consumo: [], estudio_anuncios_jobs: [] });
    const r = await montarResultadoProjeto(sb, sb, PROJ);
    assert(r.analiseVisual === null && r.conteudo === null && r.revisao === null, "seções deveriam ser null");
    assert(r.marketplaces === null && r.promptsImagem === null && r.score === null, "seções deveriam ser null");
    assert(r.imagens.length === 0 && r.custos.totalEstimadoUsd === 0, "listas deveriam ser vazias");
  });
  await t("11. imagens ausentes → lista vazia, resto intacto", async () => {
    const dados = baseDados({ estudio_anuncios_imagens_geradas: [] });
    const sb = fakeSupabase(dados);
    const r = await montarResultadoProjeto(sb, sb, PROJ);
    assert(r.imagens.length === 0 && r.score !== null, "imagens vazias não podem afetar o resto");
  });

  console.log("\n[conteúdo e revisão]");
  await t("13. conteúdo exibido é o REVISADO quando existe, com a origem marcada", async () => {
    const sb = fakeSupabase(baseDados());
    const r = await montarResultadoProjeto(sb, sb, PROJ);
    assert(r.conteudo?.tituloBase.texto === "Titulo revisado", "deveria mostrar o revisado");
    assert(r.conteudo?.origem === "revisao_claude", "origem deveria ser revisao_claude");
  });
  await t("14. sem revisão, cai para o conteúdo original — e diz isso", async () => {
    const dados = baseDados();
    dados.estudio_anuncios_resultados_pipeline = dados.estudio_anuncios_resultados_pipeline.filter(l => l.etapa !== "revisao_claude");
    const sb = fakeSupabase(dados);
    const r = await montarResultadoProjeto(sb, sb, PROJ);
    assert(r.conteudo?.tituloBase.texto === "Titulo original", "deveria mostrar o original");
    assert(r.conteudo?.origem === "geracao_conteudo", "origem deveria ser geracao_conteudo");
  });
  await t("15. revisão lista SÓ o que mudou, com antes/depois e motivo", () => {
    const rev = adaptarRevisao(REVISAO as any);
    assert(rev.totalTrechos === 2 && rev.totalAlterados === 1, `contagem errada: ${rev.totalAlterados}/${rev.totalTrechos}`);
    assert(rev.alteracoes.length === 1, "só o trecho alterado deveria aparecer");
    assert(rev.alteracoes[0].textoOriginal === "Titulo original", "antes incorreto");
    assert(rev.alteracoes[0].textoRevisado === "Titulo revisado", "depois incorreto");
    assert(rev.alteracoes[0].motivo === "clareza", "motivo perdido");
    assert(rev.alteracoes[0].rotulo === "Título", "rótulo técnico vazando para a UI");
  });
  await t("16. rótulos amigáveis para bullets e parágrafos", () => {
    const rev = adaptarRevisao({
      entrada: { trechos: [{ ref: "bullet:2", textoOriginal: "x" }, { ref: "descricaoLonga:0", textoOriginal: "y" }] },
      saida: { textos: [{ ref: "bullet:2", textoRevisado: "x2", alterado: true, motivo: "m" }, { ref: "descricaoLonga:0", textoRevisado: "y2", alterado: true, motivo: "m" }] },
    } as any);
    assert(rev.alteracoes[0].rotulo === "Bullet 3", `rótulo: ${rev.alteracoes[0].rotulo}`);
    assert(rev.alteracoes[1].rotulo === "Parágrafo 1", `rótulo: ${rev.alteracoes[1].rotulo}`);
  });

  console.log("\n[análise visual — confirmado vs não confirmado]");
  await t("17. separa por origem: produto vs embalagem/promocional", () => {
    const a = adaptarAnaliseVisual(ANALISE);
    assert(a.confirmado.cores.join() === "Verde", `cores confirmadas: ${a.confirmado.cores.join()}`);
    assert(a.naoConfirmado.itens.some(i => i.valor === "Azul" && i.origem === "embalagem_fisica"), "cor de embalagem deveria ir para não confirmado");
    assert(a.naoConfirmado.itens.some(i => /lifting/.test(i.valor)), "alegação promocional deveria ir para não confirmado");
    assert(!a.confirmado.caracteristicas.some(c => /lifting/.test(c)), "promocional não pode virar característica confirmada");
    assert(a.naoConfirmado.alertas.length === 1 && a.naoConfirmado.informacoesNaoConfirmadas.length === 1, "alertas/não confirmados perdidos");
    assert(a.naoConfirmado.textosLegiveis.join() === "JADE ROLLER", "textos legíveis perdidos");
  });
  await t("18. marca ausente vira null (a UI decide o texto), nunca string inventada", () => {
    const a = adaptarAnaliseVisual(ANALISE);
    assert(a.marca === null && a.modelo === null, "marca/modelo deveriam ser null");
  });

  console.log("\n[marketplaces e prompts]");
  await t("19. múltiplos marketplaces preservados na ordem do artefato", async () => {
    const sb = fakeSupabase(baseDados());
    const r = await montarResultadoProjeto(sb, sb, PROJ);
    assert(r.marketplaces?.length === 2, "deveriam ser 2");
    assert(r.marketplaces!.map(m => m.marketplace).join() === "ML,Shopee", "ordem/conteúdo divergente");
  });
  await t("20. um único marketplace funciona igual", async () => {
    const dados = baseDados();
    const l = dados.estudio_anuncios_resultados_pipeline.find(x => x.etapa === "adaptacao_marketplace")!;
    l.resultado = { ...ADAPTACAO, saida: { adaptacoes: [ADAPTACAO.saida.adaptacoes[0]] } };
    const sb = fakeSupabase(dados);
    const r = await montarResultadoProjeto(sb, sb, PROJ);
    assert(r.marketplaces?.length === 1 && r.marketplaces[0].marketplace === "ML", "deveria ter só ML");
  });
  await t("21. prompts de imagem viram resumo com rótulo amigável", async () => {
    const sb = fakeSupabase(baseDados());
    const r = await montarResultadoProjeto(sb, sb, PROJ);
    assert(r.promptsImagem?.total === 2, "total errado");
    assert(r.promptsImagem!.itens[0].finalidade === "Capa principal", `rótulo técnico vazando: ${r.promptsImagem!.itens[0].finalidade}`);
  });

  console.log("\n[imagens e Storage]");
  await t("22. imagem principal vem primeiro e é marcada", async () => {
    const sb = fakeSupabase(baseDados());
    const imgs = await buscarImagensGeradasPorProjeto(sb, sb, PROJ);
    assert(imgs.length === 2, "deveriam ser 2");
    assert(imgs[0].principal && imgs[0].id === "i1", "a principal deveria vir primeiro");
    assert(imgs[0].finalidadeRotulo === "Capa principal", "rótulo amigável ausente");
  });
  await t("23. URL assinada é gerada; storage_path NUNCA sai no DTO", async () => {
    const sb = fakeSupabase(baseDados());
    const imgs = await buscarImagensGeradasPorProjeto(sb, sb, PROJ);
    assert(imgs.every(i => (i.urlAssinada ?? "").startsWith("https://signed.example/")), "URL assinada ausente");
    // O caminho aparece DENTRO da URL assinada por construção do Supabase
    // — isso é o mecanismo de acesso (escopado e temporário), não vazamento.
    // O que não pode existir é o campo cru `storage_path` no DTO, que daria
    // ao client um identificador permanente do objeto.
    assert(imgs.every(i => !("storage_path" in (i as any))), "storage_path vazou como campo do DTO");
    const semUrls = JSON.stringify(imgs.map(({ urlAssinada, ...resto }) => resto));
    assert(semUrls.indexOf("u/p/geradas") === -1, "caminho do Storage vazou fora da URL assinada");
  });
  await t("24. objeto ausente no Storage vira urlAssinada=null (sem crash)", async () => {
    const dados = baseDados();
    dados.estudio_anuncios_imagens_geradas[1].storage_path = "u/p/geradas/j/SUMIU.jpg";
    const sb = fakeSupabase(dados);
    const imgs = await buscarImagensGeradasPorProjeto(sb, sb, PROJ);
    assert(imgs.some(i => i.urlAssinada === null), "deveria haver imagem sem URL");
    assert(imgs.length === 2, "a linha deve continuar aparecendo");
  });
  await t("25. imagem sem storage_path também não quebra", async () => {
    const dados = baseDados();
    dados.estudio_anuncios_imagens_geradas[0].storage_path = null;
    const sb = fakeSupabase(dados);
    const imgs = await buscarImagensGeradasPorProjeto(sb, sb, PROJ);
    assert(imgs.find(i => i.id === "i2")!.urlAssinada === null, "deveria ser null");
  });

  console.log("\n[custos]");
  await t("26. soma só o consumo do projeto, descartando órfãos", async () => {
    const sb = fakeSupabase(baseDados());
    const c = await buscarCustoProjeto(sb, PROJ);
    assert(c.porEtapa.length === 2, `deveriam ser 2 linhas, vieram ${c.porEtapa.length}`);
    assert(Math.abs(c.totalEstimadoUsd - 0.0784885) < 1e-9, `total errado: ${c.totalEstimadoUsd}`);
    assert(!c.porEtapa.some(e => e.custoEstimadoUsd === 999 || e.custoEstimadoUsd === 555), "consumo órfão foi somado");
  });
  await t("27. etapa é resolvida pelo job, não inventada", async () => {
    const sb = fakeSupabase(baseDados());
    const c = await buscarCustoProjeto(sb, PROJ);
    assert(c.porEtapa.some(e => e.etapa === "analise_visual") && c.porEtapa.some(e => e.etapa === "geracao_imagem"), "etapas incorretas");
  });
  await t("28. custo zero não quebra e sinaliza modelo sem preço", async () => {
    const dados = baseDados();
    dados.central_ia_consumo = [{ projeto_id: PROJ, job_id: "job-img", provedor: "google", modelo: "sem-preco", custo_estimado: "0", tokens_entrada: 10, tokens_saida: 20, unidades_geradas: 1 }];
    const sb = fakeSupabase(dados);
    const c = await buscarCustoProjeto(sb, PROJ);
    assert(c.totalEstimadoUsd === 0 && c.temModeloSemPreco, "deveria sinalizar modelo sem preço");
  });
  await t("29. múltiplos provedores aparecem separados", async () => {
    const dados = baseDados();
    dados.central_ia_consumo.push({ projeto_id: PROJ, job_id: "job-av", provedor: "anthropic", modelo: "claude-opus-5", custo_estimado: "0.02", tokens_entrada: 1, tokens_saida: 1, unidades_geradas: 1 });
    const sb = fakeSupabase(dados);
    const c = await buscarCustoProjeto(sb, PROJ);
    assert(new Set(c.porEtapa.map(e => e.provedor)).size === 2, "deveria haver 2 provedores");
  });

  console.log("\n[desempate e limites de escopo]");
  await t("30. resultado duplicado por etapa não quebra (desempate estável)", async () => {
    const dados = baseDados();
    dados.estudio_anuncios_resultados_pipeline.push({ projeto_id: PROJ, etapa: "calculo_score", schema_versao: 1, resultado: { ...SCORE, scoreTotal: 50 }, criado_em: "2026-08-09" });
    const sb = fakeSupabase(dados);
    const r = await buscarResultadosPipelinePorProjeto(sb, PROJ);
    assert((r.get("calculo_score")!.resultado as any).scoreTotal === 96, "desempate deveria manter o mais antigo");
  });
  await t("31. a UI não faz query no Supabase e não recalcula score", () => {
    const semComentarios = (f: string) => f.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
    const ui = semComentarios(fs.readFileSync(path.join(process.cwd(), "app/(app)/central-ia/estudio-anuncios/[projetoId]/ResultadoProjeto.tsx"), "utf-8"));
    const page = semComentarios(fs.readFileSync(path.join(process.cwd(), "app/(app)/central-ia/estudio-anuncios/[projetoId]/page.tsx"), "utf-8"));
    for (const [nome, f] of [["ResultadoProjeto", ui], ["page", page]] as const) {
      assert(!/createClient|supabase|SUPABASE/.test(f), `${nome} acessa Supabase no client`);
      assert(!/SERVICE_ROLE|DIRECT_URL|DATABASE_URL/.test(f), `${nome} referencia segredo`);
    }
    assert(!/PESOS_BLOCOS|estimarCustoUsd|FAIXAS_CLASSIFICACAO/.test(ui), "a UI está reimplementando regra de score/custo");
    assert(!/scoreTotal\s*=|\.reduce\(.*pontos/.test(ui), "a UI está recalculando o score");
  });
  await t("32. a UI não implementa edição, aprovação, regeneração ou download", () => {
    const ui = fs.readFileSync(path.join(process.cwd(), "app/(app)/central-ia/estudio-anuncios/[projetoId]/ResultadoProjeto.tsx"), "utf-8");
    for (const proibido of ["method: \"POST\"", "method: \"PATCH\"", "method: \"DELETE\"", "download", "aprovar", "regerar", "publicar", "exportar"]) {
      assert(!ui.includes(proibido), `UI de leitura não pode conter "${proibido}"`);
    }
  });

}

rodar().then(() => {
  console.log(`\n=== RESULTADO: ${ok} passaram, ${falhou} falharam ===\n`);
  process.exitCode = falhou > 0 ? 1 : 0;
});
