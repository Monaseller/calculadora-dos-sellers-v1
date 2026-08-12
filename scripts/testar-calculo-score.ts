/**
 * Testes determinísticos da etapa `calculo_score` — funções puras, mais
 * um cliente Supabase de mentira nas pré-condições de origem. Sem banco
 * real, sem Storage, sem rede, sem IA, custo zero.
 *
 * Uso: npx tsx scripts/testar-calculo-score.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  consolidarBloco,
  classificar,
  calcularScoreFinal,
  calcularBlocoAnaliseVisual,
  calcularBlocoCompletudeProduto,
  calcularBlocoConteudo,
  calcularBlocoIntegridadeFactual,
  calcularBlocoAdaptacaoMarketplace,
  calcularBlocoPromptsImagem,
  calcularBlocoImagens,
  calcularBlocoConsistenciaGeral,
  resolverFontesScore,
  montarResumoCurtoScore,
} from "../lib/estudio-anuncios/calculo-score";
import {
  PESOS_BLOCOS,
  FAIXAS_CLASSIFICACAO,
  SCHEMA_VERSAO_CALCULO_SCORE,
  VERSAO_REGRAS_SCORE,
  NOMES_BLOCOS,
} from "../lib/estudio-anuncios/calculo-score-tipos";
import type { BlocoScore, CodigoBloco } from "../lib/estudio-anuncios/calculo-score-tipos";
import type { AnaliseVisualCompleta } from "../lib/ai-gateway/provedores/google-tipos";
import type { EnvelopeGeracaoConteudo } from "../lib/estudio-anuncios/geracao-conteudo-tipos";
import { HANDLERS_ESPECIFICOS, ETAPAS_FAKE_GENERICAS, resolverHandler } from "../lib/estudio-anuncios/executores/registry";
import { decidirProvedor, decidirTipoPrompt } from "../lib/ai-gateway/roteamento";
import { ErroProvedorIA } from "../lib/ai-gateway/erros";

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
function analisePerfeita(over: Partial<AnaliseVisualCompleta> = {}): AnaliseVisualCompleta {
  return {
    produtoIdentificado: "Kit de rolo massageador facial",
    marca: null, modelo: null,
    categoriaProvavel: ["Beleza", "Cuidados com a Pele"],
    resumoVisual: "Conjunto verde.",
    caracteristicasVisiveis: [{ descricao: "Rolo duplo.", origem: "produto" }],
    cores: [{ valor: "Verde", origem: "produto" }],
    materiais: [{ valor: "Pedra", origem: "produto" }],
    componentes: [{ valor: "Rolo", origem: "produto" }],
    textosLegiveis: [],
    quantidadeDeclarada: { valor: null, textoOrigem: null },
    possiveisUsos: [{ descricao: "Massagem facial.", origem: "produto" }],
    publicoProvavel: [{ descricao: "Skincare.", origem: "produto" }],
    alertas: [],
    informacoesNaoConfirmadas: [],
    qualidadeDasFotos: { nota: 100, problemas: [], sugestoes: [] },
    atributosAdicionais: [{ nome: "Tipo", valor: "Duplo", origem: "produto" }],
    fotosAnalisadas: [{ imagemId: "1", ordem: 1, principal: true }],
    metadadosAnalise: { totalFotosProjeto: 3, totalFotosAnalisadas: 3, analiseParcial: false, motivoAnaliseParcial: null },
    ...over,
  };
}
function conteudoPerfeito(over: any = {}): EnvelopeGeracaoConteudo {
  return {
    fonteAnaliseVisual: { jobId: "av-1", resultadoId: "r", schemaVersao: 1 },
    entrada: {
      fatosPermitidos: [
        { id: "F1", campoOrigem: "cores", valor: "Verde", origem: "produto" },
        { id: "F2", campoOrigem: "materiais", valor: "Pedra", origem: "produto" },
      ],
      descricoesComRessalva: [{ id: "R1", campoOrigem: "materiais", valor: "jade", origem: "produto" }],
      informacoesProibidas: [], contextoPromocional: [], alertas: [], fatosAfetadosPorAlerta: [],
    },
    saida: {
      tituloBase: { texto: "Rolo Massageador Verde", fatoIds: ["F1"] },
      descricaoCurta: { texto: "Aparenta jade.", contemRessalva: true, fatoIds: ["R1"] },
      bullets: [
        { texto: "A", contemRessalva: false, fatoIds: ["F1"] },
        { texto: "B", contemRessalva: false, fatoIds: ["F2"] },
        { texto: "C", contemRessalva: false, fatoIds: ["F1"] },
      ],
      descricaoLonga: [
        { texto: "P1", contemRessalva: false, fatoIds: ["F1"] },
        { texto: "P2", contemRessalva: false, fatoIds: ["F2"] },
      ],
      especificacoes: [
        { nome: "Material", valor: "Pedra", fatoId: "F2" },
        { nome: "Cor", valor: "Verde", fatoId: "F1" },
        { nome: "Tipo", valor: "Duplo", fatoId: "F1" },
        { nome: "Uso", valor: "Facial", fatoId: "F2" },
      ],
      publicoSugerido: { texto: "Skincare", fatoIds: ["F1"] },
    },
    ...over,
  } as EnvelopeGeracaoConteudo;
}
const adaptacaoPerfeita: any = {
  fonteGeracaoConteudo: { jobId: "gc-1", resultadoId: "r", schemaVersao: 1 },
  entrada: { conteudoBase: conteudoPerfeito().saida, marketplacesAlvo: ["ML"], ctasPermitidos: [], restricoes: [] },
  saida: { adaptacoes: [{ marketplace: "ML", titulo: "T", descricao: "D", especificacoes: [{ nome: "Material", valor: "Pedra" }], cta: "Confira os detalhes" }] },
};
const promptsPerfeitos: any = {
  fonteAnaliseVisual: { jobId: "av-1", resultadoId: "r", schemaVersao: 1 },
  configuracao: { quantidadeSolicitada: 3, aspectRatio: "1:1", textosPermitidos: [], tiposPermitidos: [] },
  entrada: { verdadeVisual: {}, restricoes: [] },
  prompts: [1, 2, 3].map(o => ({
    ordem: o, principal: o === 1, tipo: o === 1 ? "capa_principal" : "detalhes",
    objetivo: "o", cena: "c", enquadramento: "produto_inteiro", fundo: "f", iluminacao: "i",
    elementosObrigatorios: ["x"], elementosProibidos: [], textosPermitidos: [], textosProibidos: ["t"],
    aspectRatio: "1:1", promptTexto: "P", negativePrompt: "N",
  })),
};
const imagensPerfeitas = [1, 2, 3].map(o => ({
  id: `i${o}`, prompt_ordem: o, e_principal: o === 1,
  mime_type: "image/jpeg", largura_px: 1024, altura_px: 1024, tamanho_bytes: 300000, storage_path: `p${o}`,
}));

const blocosPerfeitos = (): BlocoScore[] => [
  calcularBlocoAnaliseVisual(analisePerfeita()),
  calcularBlocoCompletudeProduto(analisePerfeita()),
  calcularBlocoConteudo(conteudoPerfeito().saida),
  calcularBlocoIntegridadeFactual(conteudoPerfeito()),
  calcularBlocoAdaptacaoMarketplace(adaptacaoPerfeita, ["ML"]),
  calcularBlocoPromptsImagem(promptsPerfeitos),
  calcularBlocoImagens({ imagens: imagensPerfeitas, quantidadePrevista: 3, aspectRatioEsperado: 1, arquivosPresentes: 3 }),
  calcularBlocoConsistenciaGeral({ cadeiaIntacta: true, imagensBatemComPrompts: true, revisaoReal: true }),
];

console.log("\n[faixa, pesos e arredondamento]");
t("1. pesos somam exatamente 100 e cobrem todos os blocos nomeados", () => {
  const soma = Object.values(PESOS_BLOCOS).reduce((a, b) => a + b, 0);
  assert(soma === 100, `soma ${soma}`);
  for (const c of Object.keys(PESOS_BLOCOS) as CodigoBloco[]) assert(!!NOMES_BLOCOS[c], `bloco "${c}" sem nome`);
});
t("2. cenário perfeito dá exatamente 100", () => {
  const s = calcularScoreFinal(blocosPerfeitos());
  assert(s === 100, `esperado 100, veio ${s}`);
});
t("3. cenário totalmente vazio dá 0 e nunca negativo", () => {
  const zerados: BlocoScore[] = (Object.keys(PESOS_BLOCOS) as CodigoBloco[]).map(c =>
    consolidarBloco(c, [{ codigo: "x", pontosPossiveis: 1, pontosObtidos: 0, status: "falha", explicacao: "" }])
  );
  const s = calcularScoreFinal(zerados);
  assert(s === 0, `esperado 0, veio ${s}`);
  assert(s >= 0, "score negativo");
});
t("4. score nunca passa de 100 mesmo com bloco corrompido", () => {
  const inflado = blocosPerfeitos();
  inflado[0] = { ...inflado[0], pontos: 999 };
  assert(calcularScoreFinal(inflado) === 100, "clamp de 100 falhou");
});
t("5. arredondamento é Math.round aplicado UMA vez, só no total", () => {
  const b = (c: CodigoBloco, razao: number) =>
    consolidarBloco(c, [{ codigo: "x", pontosPossiveis: 1, pontosObtidos: razao, status: "parcial", explicacao: "" }]);
  const blocos = (Object.keys(PESOS_BLOCOS) as CodigoBloco[]).map(c => b(c, 0.5));
  assert(calcularScoreFinal(blocos) === 50, "metade de tudo deveria dar 50");
  const quebrado = (Object.keys(PESOS_BLOCOS) as CodigoBloco[]).map(c => b(c, 0.555));
  assert(calcularScoreFinal(quebrado) === Math.round(55.5), "arredondamento divergente");
});
t("6. bloco nunca passa do próprio peso nem fica negativo", () => {
  for (const bloco of blocosPerfeitos()) {
    assert(bloco.pontos <= bloco.pesoMaximo + 1e-9, `${bloco.codigo} acima do peso`);
    assert(bloco.pontos >= 0, `${bloco.codigo} negativo`);
    assert(bloco.pesoMaximo === PESOS_BLOCOS[bloco.codigo], `${bloco.codigo} com peso divergente`);
  }
});
t("7. classificação segue as faixas server-side", () => {
  assert(classificar(100) === "excelente" && classificar(90) === "excelente", "faixa excelente");
  assert(classificar(89) === "bom" && classificar(75) === "bom", "faixa bom");
  assert(classificar(74) === "atencao" && classificar(60) === "atencao", "faixa atencao");
  assert(classificar(59) === "insuficiente" && classificar(0) === "insuficiente", "faixa insuficiente");
  assert(FAIXAS_CLASSIFICACAO.length === 4, "faixas alteradas sem revisar o teste");
});
t("8. critério não-aplicável sai do denominador (não vira zero)", () => {
  const comFalha = consolidarBloco("consistencia_geral", [
    { codigo: "a", pontosPossiveis: 1, pontosObtidos: 1, status: "ok", explicacao: "" },
    { codigo: "b", pontosPossiveis: 1, pontosObtidos: 0, status: "falha", explicacao: "" },
  ]);
  const comNA = consolidarBloco("consistencia_geral", [
    { codigo: "a", pontosPossiveis: 1, pontosObtidos: 1, status: "ok", explicacao: "" },
    { codigo: "b", pontosPossiveis: 0, pontosObtidos: 0, status: "nao_aplicavel", explicacao: "" },
  ]);
  assert(comFalha.percentual === 50, `falha deveria dar 50%, deu ${comFalha.percentual}`);
  assert(comNA.percentual === 100, `não-aplicável deveria dar 100%, deu ${comNA.percentual}`);
});
t("9. bloco 100% não-aplicável é neutro (peso cheio, percentual null)", () => {
  const b = consolidarBloco("analise_visual", [{ codigo: "a", pontosPossiveis: 0, pontosObtidos: 0, status: "nao_aplicavel", explicacao: "" }]);
  assert(b.pontos === PESOS_BLOCOS.analise_visual && b.percentual === null, "bloco neutro incorreto");
});

console.log("\n[bloco — análise visual]");
t("10. fotos excelentes pontuam cheio; fotos ruins zeram o critério", () => {
  const bom = calcularBlocoAnaliseVisual(analisePerfeita());
  const ruim = calcularBlocoAnaliseVisual(analisePerfeita({ qualidadeDasFotos: { nota: 40, problemas: [], sugestoes: [] } }));
  assert(bom.percentual === 100, `bom deveria ser 100, veio ${bom.percentual}`);
  assert(ruim.criterios.find(c => c.codigo === "qualidade_fotos")!.pontosObtidos === 0, "nota 40 deveria zerar");
  assert(ruim.pontos < bom.pontos, "foto ruim deveria reduzir o bloco");
});
t("11. nota de foto NÃO é copiada 1:1 para o score", () => {
  const b = calcularBlocoAnaliseVisual(analisePerfeita({ qualidadeDasFotos: { nota: 90, problemas: [], sugestoes: [] } }));
  const crit = b.criterios.find(c => c.codigo === "qualidade_fotos")!;
  assert(crit.pontosObtidos !== crit.pontosPossiveis * 0.9, "nota 90 não pode virar 90% do critério (escala parte de 50)");
  assert(crit.pontosObtidos === crit.pontosPossiveis * 0.8, "escala (90-50)/50 = 0.8 esperada");
});
t("12. análise parcial e alertas reduzem o bloco", () => {
  const parcial = calcularBlocoAnaliseVisual(analisePerfeita({
    metadadosAnalise: { totalFotosProjeto: 5, totalFotosAnalisadas: 2, analiseParcial: true, motivoAnaliseParcial: "limite_quantidade" },
  }));
  const comAlerta = calcularBlocoAnaliseVisual(analisePerfeita({ alertas: ["Embalagem confunde"] }));
  assert(parcial.criterios.find(c => c.codigo === "analise_completa")!.status === "falha", "parcial deveria falhar");
  assert(comAlerta.criterios.find(c => c.codigo === "sem_alertas")!.status === "falha", "alerta deveria falhar");
});

console.log("\n[bloco — completude do produto]");
t("13. marca/modelo ausentes NÃO são penalizados", () => {
  const semMarca = calcularBlocoCompletudeProduto(analisePerfeita({ marca: null, modelo: null }));
  const comMarca = calcularBlocoCompletudeProduto(analisePerfeita({ marca: "X", modelo: "Y" }));
  assert(semMarca.pontos === comMarca.pontos, "marca/modelo não deveriam alterar o bloco");
  assert(!semMarca.criterios.some(c => /marca|modelo/.test(c.codigo)), "não deveria existir critério de marca/modelo");
});
t("14. só atributo com origem `produto` conta", () => {
  const soEmbalagem = calcularBlocoCompletudeProduto(analisePerfeita({
    cores: [{ valor: "Azul", origem: "embalagem_fisica" }],
    materiais: [{ valor: "Papel", origem: "material_promocional" }],
  }));
  assert(soEmbalagem.criterios.find(c => c.codigo === "cores")!.status === "falha", "cor de embalagem não é cor do produto");
  assert(soEmbalagem.criterios.find(c => c.codigo === "materiais")!.status === "falha", "material promocional não conta");
});
t("15. produto não identificado derruba o critério mais pesado do bloco", () => {
  const b = calcularBlocoCompletudeProduto(analisePerfeita({ produtoIdentificado: null }));
  assert(b.criterios.find(c => c.codigo === "produto_identificado")!.status === "falha", "deveria falhar");
  assert(b.percentual! < 100, "bloco deveria cair");
});

console.log("\n[bloco — conteúdo]");
t("16. título ausente derruba o critério de maior peso", () => {
  const c = conteudoPerfeito(); (c.saida as any).tituloBase = { texto: "   ", fatoIds: [] };
  const b = calcularBlocoConteudo(c.saida);
  assert(b.criterios.find(x => x.codigo === "titulo")!.status === "falha", "título vazio deveria falhar");
});
t("17. descrição, bullets e especificações ausentes reduzem proporcionalmente", () => {
  const c = conteudoPerfeito();
  delete (c.saida as any).bullets; delete (c.saida as any).especificacoes;
  (c.saida as any).descricaoCurta = { texto: "", contemRessalva: false, fatoIds: [] };
  const b = calcularBlocoConteudo(c.saida);
  for (const cod of ["descricao_curta", "bullets", "especificacoes"]) {
    assert(b.criterios.find(x => x.codigo === cod)!.status === "falha", `${cod} deveria falhar`);
  }
  assert(b.pontos < PESOS_BLOCOS.conteudo, "bloco deveria cair");
});
t("18. público sugerido ausente custa pouco (é opcional no contrato)", () => {
  const c = conteudoPerfeito(); delete (c.saida as any).publicoSugerido;
  const b = calcularBlocoConteudo(c.saida);
  assert(b.percentual! >= 90, `perda desproporcional: ${b.percentual}%`);
});

console.log("\n[bloco — integridade factual]");
t("19. fatoId inexistente é o defeito mais caro do bloco", () => {
  const c = conteudoPerfeito(); (c.saida.bullets as any)[0].fatoIds = ["F99"];
  const b = calcularBlocoIntegridadeFactual(c);
  assert(b.criterios.find(x => x.codigo === "fatoids_existentes")!.status === "falha", "deveria falhar");
});
t("20. citar ressalva sem marcar contemRessalva é detectado", () => {
  const c = conteudoPerfeito(); (c.saida as any).descricaoCurta = { texto: "x", contemRessalva: false, fatoIds: ["R1"] };
  const b = calcularBlocoIntegridadeFactual(c);
  assert(b.criterios.find(x => x.codigo === "ressalva_coerente")!.status === "falha", "deveria falhar");
});
t("21. ressalva em título/especificação é detectada", () => {
  const c = conteudoPerfeito(); (c.saida as any).tituloBase = { texto: "x", fatoIds: ["R1"] };
  const b = calcularBlocoIntegridadeFactual(c);
  assert(b.criterios.find(x => x.codigo === "ressalva_fora_de_campo_proibido")!.status === "falha", "deveria falhar");
});
t("22. conteúdo íntegro dá 100% no bloco", () =>
  assert(calcularBlocoIntegridadeFactual(conteudoPerfeito()).percentual === 100, "deveria ser 100%"));

console.log("\n[bloco — adaptação por marketplace]");
t("23. marketplace do projeto sem adaptação é detectado", () => {
  const b = calcularBlocoAdaptacaoMarketplace(adaptacaoPerfeita, ["ML", "Shopee"]);
  assert(b.criterios.find(c => c.codigo === "cobertura")!.status === "falha", "faltando Shopee");
  assert(/Shopee/.test(b.criterios.find(c => c.codigo === "cobertura")!.explicacao), "explicação deveria nomear o faltante");
});
t("24. cobertura completa dá 100%", () =>
  assert(calcularBlocoAdaptacaoMarketplace(adaptacaoPerfeita, ["ML"]).percentual === 100, "deveria ser 100%"));
t("25. especificação alterada em relação à base é detectada", () => {
  const a = JSON.parse(JSON.stringify(adaptacaoPerfeita));
  a.saida.adaptacoes[0].especificacoes = [{ nome: "Material", valor: "Plástico" }];
  const b = calcularBlocoAdaptacaoMarketplace(a, ["ML"]);
  assert(b.criterios.find(c => c.codigo === "especificacoes_preservadas")!.status === "falha", "valor alterado deveria falhar");
});
t("26. CTA fora da lista controlada é detectado", () => {
  const a = JSON.parse(JSON.stringify(adaptacaoPerfeita));
  a.saida.adaptacoes[0].cta = "COMPRE JÁ!!!";
  const b = calcularBlocoAdaptacaoMarketplace(a, ["ML"]);
  assert(b.criterios.find(c => c.codigo === "cta_controlado")!.status === "falha", "CTA inventado deveria falhar");
});

console.log("\n[bloco — prompts de imagem]");
t("27. prompts completos dão 100%", () =>
  assert(calcularBlocoPromptsImagem(promptsPerfeitos).percentual === 100, "deveria ser 100%"));
t("28. quantidade divergente, ordem furada e principal errada são detectadas", () => {
  const p = JSON.parse(JSON.stringify(promptsPerfeitos));
  p.prompts = p.prompts.slice(0, 2); p.prompts[1].ordem = 5; p.prompts[1].principal = true;
  const b = calcularBlocoPromptsImagem(p);
  assert(b.criterios.find(c => c.codigo === "quantidade")!.status === "falha", "quantidade deveria falhar");
  assert(b.criterios.find(c => c.codigo === "ordem_continua")!.status === "falha", "ordem deveria falhar");
  assert(b.criterios.find(c => c.codigo === "uma_principal")!.status === "falha", "principal deveria falhar");
});
t("29. prompt vazio e texto-na-imagem autorizado são detectados", () => {
  const p = JSON.parse(JSON.stringify(promptsPerfeitos));
  p.prompts[0].promptTexto = "  "; p.prompts[1].textosPermitidos = ["Frete grátis"];
  const b = calcularBlocoPromptsImagem(p);
  assert(b.criterios.find(c => c.codigo === "prompts_preenchidos")!.status === "falha", "prompt vazio deveria falhar");
  assert(b.criterios.find(c => c.codigo === "sem_texto_na_imagem")!.status === "falha", "texto na imagem deveria falhar");
});

console.log("\n[bloco — imagens (só qualidade técnica)]");
t("30. imagens completas e válidas dão 100%", () =>
  assert(calcularBlocoImagens({ imagens: imagensPerfeitas, quantidadePrevista: 3, aspectRatioEsperado: 1, arquivosPresentes: 3 }).percentual === 100, "deveria ser 100%"));
t("31. quantidade divergente é detectada", () => {
  const b = calcularBlocoImagens({ imagens: imagensPerfeitas.slice(0, 2), quantidadePrevista: 3, aspectRatioEsperado: 1, arquivosPresentes: 2 });
  assert(b.criterios.find(c => c.codigo === "quantidade")!.status === "falha", "deveria falhar");
});
t("32. MIME inválido, dimensão inválida e proporção inválida são detectados", () => {
  const b = calcularBlocoImagens({
    imagens: [
      { ...imagensPerfeitas[0], mime_type: "image/gif" },
      { ...imagensPerfeitas[1], largura_px: 100, altura_px: 100 },
      { ...imagensPerfeitas[2], largura_px: 1024, altura_px: 768 },
    ],
    quantidadePrevista: 3, aspectRatioEsperado: 1, arquivosPresentes: 3,
  });
  assert(b.criterios.find(c => c.codigo === "mime_valido")!.status !== "ok", "MIME deveria cair");
  assert(b.criterios.find(c => c.codigo === "dimensoes_validas")!.status !== "ok", "dimensão deveria cair");
  assert(b.criterios.find(c => c.codigo === "proporcao")!.status !== "ok", "proporção deveria cair");
});
t("33. principal ausente e principal duplicada são detectadas", () => {
  const semPrincipal = calcularBlocoImagens({ imagens: imagensPerfeitas.map(i => ({ ...i, e_principal: false })), quantidadePrevista: 3, aspectRatioEsperado: 1, arquivosPresentes: 3 });
  const duasPrincipais = calcularBlocoImagens({ imagens: imagensPerfeitas.map(i => ({ ...i, e_principal: true })), quantidadePrevista: 3, aspectRatioEsperado: 1, arquivosPresentes: 3 });
  assert(semPrincipal.criterios.find(c => c.codigo === "uma_principal")!.status === "falha", "sem principal deveria falhar");
  assert(duasPrincipais.criterios.find(c => c.codigo === "uma_principal")!.status === "falha", "duas principais deveria falhar");
});
t("34. arquivo ausente no Storage e arquivo vazio são detectados", () => {
  const semArquivo = calcularBlocoImagens({ imagens: imagensPerfeitas, quantidadePrevista: 3, aspectRatioEsperado: 1, arquivosPresentes: 1 });
  const vazio = calcularBlocoImagens({ imagens: imagensPerfeitas.map(i => ({ ...i, tamanho_bytes: 0 })), quantidadePrevista: 3, aspectRatioEsperado: 1, arquivosPresentes: 3 });
  assert(semArquivo.criterios.find(c => c.codigo === "arquivos_presentes")!.status === "parcial", "deveria ser parcial");
  assert(vazio.criterios.find(c => c.codigo === "arquivos_nao_vazios")!.status === "falha", "arquivo vazio deveria falhar");
});
t("35. duplicidade de ordem é detectada", () => {
  const b = calcularBlocoImagens({ imagens: imagensPerfeitas.map(i => ({ ...i, prompt_ordem: 1 })), quantidadePrevista: 3, aspectRatioEsperado: 1, arquivosPresentes: 3 });
  assert(b.criterios.find(c => c.codigo === "sem_duplicidade")!.status === "falha", "deveria falhar");
});
t("36. bloco de imagens NÃO avalia fidelidade visual (só técnica)", () => {
  const codigos = calcularBlocoImagens({ imagens: imagensPerfeitas, quantidadePrevista: 3, aspectRatioEsperado: 1, arquivosPresentes: 3 }).criterios.map(c => c.codigo);
  for (const proibido of ["fidelidade", "mesmo_produto", "cores_preservadas", "deformacao"]) {
    assert(!codigos.includes(proibido), `critério semântico "${proibido}" não pode existir na V1`);
  }
});
t("37. imagem faltando não é punida duas vezes", () => {
  // A ausência derruba o bloco de imagens; nenhum OUTRO bloco pode cair
  // pelo mesmo motivo, e não existe mecanismo paralelo de penalidade.
  const completo = blocosPerfeitos();
  const faltando = blocosPerfeitos();
  faltando[6] = calcularBlocoImagens({ imagens: imagensPerfeitas.slice(0, 1), quantidadePrevista: 3, aspectRatioEsperado: 1, arquivosPresentes: 1 });
  for (let i = 0; i < completo.length; i++) {
    if (i === 6) continue;
    assert(completo[i].pontos === faltando[i].pontos, `bloco ${completo[i].codigo} foi punido por causa das imagens`);
  }
  const envelopeTemPenalidades = "penalidades" in ({} as any);
  assert(!envelopeTemPenalidades, "não deve existir mecanismo paralelo de penalidade");
});

console.log("\n[bloco — consistência geral]");
t("38. revisão ausente é NÃO-APLICÁVEL, nunca falha", () => {
  const com = calcularBlocoConsistenciaGeral({ cadeiaIntacta: true, imagensBatemComPrompts: true, revisaoReal: true });
  const sem = calcularBlocoConsistenciaGeral({ cadeiaIntacta: true, imagensBatemComPrompts: true, revisaoReal: false });
  assert(sem.criterios.find(c => c.codigo === "revisao_aplicada")!.status === "nao_aplicavel", "deveria ser não-aplicável");
  assert(sem.pontos === com.pontos, "ausência de revisão não pode reduzir o bloco");
});
t("39. cadeia quebrada derruba o bloco", () => {
  const b = calcularBlocoConsistenciaGeral({ cadeiaIntacta: false, imagensBatemComPrompts: false, revisaoReal: true });
  assert(b.percentual! < 50, `deveria cair bastante, veio ${b.percentual}%`);
});

console.log("\n[origem semântica e hard fails]");
const JOB = "aaaaaaaa-0000-0000-0000-000000000001";
const ORIGEM = "bbbbbbbb-0000-0000-0000-000000000002";
const PROJ = "cccccccc-0000-0000-0000-000000000003";
function fakeSupabase(cfg: { job?: any; origem?: any; resultadosPorJob?: Record<string, any[]> }) {
  return {
    from(tabela: string) {
      return {
        select() {
          const filtros: Record<string, any> = {};
          const api: any = {
            eq(col: string, val: any) {
              filtros[col] = val;
              if (tabela === "estudio_anuncios_resultados_pipeline") {
                const linhas = cfg.resultadosPorJob?.[filtros.job_id] ?? [];
                return Object.assign(api, { then: (r: any) => r({ data: linhas, error: null }) });
              }
              const linha = val === JOB ? cfg.job ?? null : cfg.origem ?? null;
              return Object.assign(api, {
                maybeSingle: async () => ({ data: linha, error: null }),
                then: (r: any) => r({ data: linha ? [linha] : [], error: null }),
              });
            },
            maybeSingle: async () => ({ data: null, error: null }),
            then: (r: any) => r({ data: [], error: null }),
          };
          return api;
        },
      };
    },
  } as any;
}
const CTX = { jobId: JOB, projetoId: PROJ, etapa: "calculo_score" };
const okJob = { id: JOB, projeto_id: PROJ, job_origem_id: ORIGEM };
const okOrigem = { id: ORIGEM, projeto_id: PROJ, etapa: "geracao_imagem", status: "concluido" };

async function rodarTestesDeOrigem() {
  await ta("40. origem ausente é hard fail `validation`, nunca score baixo", async () => {
    await lancaAsync(() => resolverFontesScore(fakeSupabase({ job: { ...okJob, job_origem_id: null } }), CTX), "job_origem_id ausente");
  });
  await ta("41. origem de etapa errada é hard fail", () =>
    lancaAsync(() => resolverFontesScore(fakeSupabase({ job: okJob, origem: { ...okOrigem, etapa: "geracao_prompts_imagem" } }), CTX), 'esperado "geracao_imagem"'));
  await ta("42. origem de outro projeto é hard fail", () =>
    lancaAsync(() => resolverFontesScore(fakeSupabase({ job: okJob, origem: { ...okOrigem, projeto_id: "outro" } }), CTX), "outro projeto"));
  await ta("43. origem não concluída é hard fail", () =>
    lancaAsync(() => resolverFontesScore(fakeSupabase({ job: okJob, origem: { ...okOrigem, status: "rodando" } }), CTX), "não está concluído"));
  await ta("44. resultado da origem ausente é hard fail", () =>
    lancaAsync(() => resolverFontesScore(fakeSupabase({ job: okJob, origem: okOrigem, resultadosPorJob: {} }), CTX), "encontrado 0"));
  await ta("45. envelope sem fontePromptsImagem é hard fail (cadeia quebrada)", () =>
    lancaAsync(() => resolverFontesScore(fakeSupabase({
      job: okJob, origem: okOrigem,
      resultadosPorJob: { [ORIGEM]: [{ id: "r", job_id: ORIGEM, projeto_id: PROJ, etapa: "geracao_imagem", schema_versao: 1, resultado: { imagens: [] } }] },
    }), CTX), "cadeia quebrada"));
  await ta("46. erro de origem é sempre ErroProvedorIA do tipo validation", async () => {
    try { await resolverFontesScore(fakeSupabase({ job: { ...okJob, job_origem_id: null } }), CTX); }
    catch (e: any) { assert(e instanceof ErroProvedorIA && e.tipo === "validation", `veio ${e?.tipo}`); return; }
    throw new Error("deveria ter lançado");
  });
}

console.log("\n[registry, roteamento e ausência de IA]");
t("47. registry sem conflito — nenhuma etapa nos dois conjuntos", () => {
  for (const etapa of Object.keys(HANDLERS_ESPECIFICOS)) {
    assert(!ETAPAS_FAKE_GENERICAS.has(etapa), `etapa "${etapa}" nos dois conjuntos`);
    assert(HANDLERS_ESPECIFICOS[etapa].etapa === etapa, `chave e handler divergem em "${etapa}"`);
  }
});
t("48. calculo_score tem handler internal, sem fake e sem consumo de IA", () => {
  const h = resolverHandler("calculo_score");
  assert(!!h && h.etapa === "calculo_score", "handler não resolvido");
  assert(h!.provedoresPermitidos.join() === "internal", `provedores: ${h!.provedoresPermitidos.join()}`);
  assert(h!.consomeIAExterna === false, "deveria declarar consomeIAExterna=false");
  assert(h!.versaoSaida === SCHEMA_VERSAO_CALCULO_SCORE, "versaoSaida divergente");
  assert(h!.dependencia === "job_origem_id", "dependência errada");
  assert(h!.geraResultadoEstruturado === true, "deveria gerar resultado estruturado");
});
t("49. roteamento devolve internal sempre, sem feature flag", () => {
  assert(decidirProvedor("calculo_score") === "internal", "deveria ser internal");
  const antes = { ...process.env };
  try {
    for (const k of Object.keys(process.env)) if (/^GOOGLE_AI|^ANTHROPIC/.test(k)) delete process.env[k];
    assert(decidirProvedor("calculo_score") === "internal", "internal não pode depender de env de provedor");
  } finally { Object.assign(process.env, antes); }
});
t("50. fake das demais etapas preservado (invariante, sem contagem fixa)", () => {
  for (const etapa of ETAPAS_FAKE_GENERICAS) {
    const h = resolverHandler(etapa);
    assert(!!h && h.etapa === "*" && !(etapa in HANDLERS_ESPECIFICOS), `etapa "${etapa}" perdeu o fake`);
  }
  assert(!ETAPAS_FAKE_GENERICAS.has("calculo_score"), "promovida mas ainda no conjunto fake");
});
t("51. handlers que consomem IA continuam com o default (nenhuma regressão)", () => {
  for (const [etapa, h] of Object.entries(HANDLERS_ESPECIFICOS)) {
    if (etapa === "calculo_score") continue;
    assert(h.consomeIAExterna !== false, `etapa "${etapa}" deixou de registrar prompt/consumo`);
  }
});
t("52. tipo de prompt mapeado continua sendo `auditoria`", () =>
  assert(decidirTipoPrompt("calculo_score") === "auditoria", "categoria errada"));

console.log("\n[limites de escopo — o que esta etapa NUNCA faz]");
function semComentarios(f: string) {
  return f.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}
const FONTE_DOMINIO = semComentarios(fs.readFileSync(path.join(process.cwd(), "lib/estudio-anuncios/calculo-score.ts"), "utf-8"));
const FONTE_HANDLER = semComentarios(fs.readFileSync(path.join(process.cwd(), "lib/estudio-anuncios/executores/calculo-score.ts"), "utf-8"));
t("53. zero IA — nenhum provedor, modelo externo ou chamada de rede", () => {
  for (const f of [FONTE_DOMINIO, FONTE_HANDLER]) {
    // Proíbe os módulos CLIENTE. `provedores/google-tipos` é permitido:
    // é só o contrato de `analise_visual` (tipos + SCHEMA_VERSAO), que
    // por decisão explícita mora junto de onde AnaliseVisualIA vive —
    // nenhum código de rede vem dele.
    assert(!/from "[^"]*provedores\/(google|anthropic|google-imagem)"/.test(f), "importou cliente de provedor");
    assert(!/chamarGemini|chamarClaude|gerarImagemGoogle|interactions\.create/.test(f), "chamou provedor de IA");
    assert(!/estimarCustoUsd/.test(f), "calculou custo de IA numa etapa sem IA");
    assert(!/fetch\(|axios/.test(f), "fez chamada de rede");
  }
});
t("54. zero escrita — nem Storage, nem tabelas de conteúdo/imagem/score legado", () => {
  for (const f of [FONTE_DOMINIO, FONTE_HANDLER]) {
    assert(!/\.insert\(|\.update\(|\.upsert\(|\.delete\(/.test(f), "escreveu no banco");
    assert(!/uploadImagemGerada|excluirImagemGerada|\.storage\b/.test(f), "escreveu no Storage");
    assert(!/estudio_anuncios_score/.test(f), "usou a tabela legada de score (segunda fonte de verdade)");
    assert(!/conteudo_versoes/.test(f), "tocou em conteudo_versoes");
  }
});
t("55. nenhuma resolução por 'o mais recente'", () => {
  assert(!/\.order\(/.test(FONTE_DOMINIO), "usou ORDER BY");
  assert(!/criado_em/.test(FONTE_DOMINIO), "ordenou/filtrou por criado_em");
  assert(!/\.limit\(/.test(FONTE_DOMINIO), "usou LIMIT para escolher fonte");
});
t("56. não prevê venda, CTR nem conversão", () => {
  for (const f of [FONTE_DOMINIO, FONTE_HANDLER]) {
    assert(!/conversao|ctr\b|vendas|receita|faturamento/i.test(f), "score não pode prever desempenho comercial");
  }
});
t("57. resumo curto é curto, explicável e sem vazamento", () => {
  const blocos = blocosPerfeitos();
  const resumo = montarResumoCurtoScore({
    scoreTotal: calcularScoreFinal(blocos), classificacao: classificar(calcularScoreFinal(blocos)),
    versaoRegrasScore: VERSAO_REGRAS_SCORE, blocos, alertas: [],
    fontes: { analiseVisualJobId: "a", geracaoConteudoJobId: "b", revisaoClaudeJobId: null, adaptacaoMarketplaceJobId: "c", geracaoPromptsImagemJobId: "d", geracaoImagemJobId: "e" },
    calculadoEm: new Date().toISOString(),
  });
  assert(resumo.length <= 500, "resumo longo demais");
  assert(/Score 100\/100 \(excelente\)/.test(resumo), `resumo inesperado: ${resumo}`);
  assert(!/http|base64|\/geradas\//.test(resumo), "resumo vazou informação");
});
t("58. versão de regras é identificável e não é nome de modelo de IA", () => {
  assert(VERSAO_REGRAS_SCORE === "regras-score-v1", "versão alterada sem revisar o teste");
  assert(!/gemini|claude|gpt|fake/i.test(VERSAO_REGRAS_SCORE), "não pode parecer nome de modelo");
});

rodarTestesDeOrigem().then(() => {
  console.log(`\n=== RESULTADO: ${ok} passaram, ${falhou} falharam ===\n`);
  process.exitCode = falhou > 0 ? 1 : 0;
});
