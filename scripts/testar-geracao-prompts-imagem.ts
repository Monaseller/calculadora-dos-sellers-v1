/**
 * Testes determinísticos da etapa `geracao_prompts_imagem` — funções
 * puras (mais um cliente Supabase de mentira nas pré-condições de
 * origem). Sem banco real, sem rede, sem IA, custo zero.
 *
 * Uso: npx tsx scripts/testar-geracao-prompts-imagem.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  montarVerdadeVisual,
  calcularTiposPermitidos,
  montarConfiguracao,
  validarConfiguracao,
  montarEntradaPromptsImagem,
  montarPromptGeracaoPromptsImagem,
  validarEstruturaPromptsImagem,
  validarIntegridadePromptsImagem,
  montarPromptsFinais,
  montarResumoCurtoPromptsImagem,
  corpusConfirmado,
  validarOrigemEBuscarAnaliseVisual,
  RESTRICOES_PROMPTS_IMAGEM,
} from "../lib/estudio-anuncios/geracao-prompts-imagem";
import {
  ASPECT_RATIO_PADRAO,
  LIMITE_MAXIMO_PROMPTS_IMAGEM,
  RESTRICOES_VISUAIS_GLOBAIS,
  SCHEMA_VERSAO_GERACAO_PROMPTS_IMAGEM,
  TIPOS_IMAGEM_SUPORTADOS,
} from "../lib/estudio-anuncios/geracao-prompts-imagem-tipos";
import { GERACAO_PROMPTS_IMAGEM_JSON_SCHEMA } from "../lib/ai-gateway/provedores/google-prompts-imagem-schema";
import type { AnaliseVisualCompleta } from "../lib/ai-gateway/provedores/google-tipos";
import { HANDLERS_ESPECIFICOS, ETAPAS_FAKE_GENERICAS, resolverHandler } from "../lib/estudio-anuncios/executores/registry";
import { decidirProvedor, decidirTipoPrompt } from "../lib/ai-gateway/roteamento";
import { estimarCustoUsd, modeloTemPrecoCadastrado } from "../lib/ai-gateway/custos";
import { ErroProvedorIA } from "../lib/ai-gateway/erros";
import { obterModeloPromptsImagem } from "../lib/ai-gateway/provedores/google";

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
// Fixtures — modeladas sobre um resultado REAL de analise_visual
// (projeto de teste 44e781d5, 2026-08-14), acrescida de um item de
// embalagem e um de material promocional para exercitar o filtro.
// ────────────────────────────────────────────────────────────────────
const ANALISE: AnaliseVisualCompleta = {
  produtoIdentificado: "Kit de rolo massageador facial e pedra Gua Sha",
  marca: null,
  modelo: null,
  categoriaProvavel: ["Beleza e Cuidados Pessoais", "Cuidados com a Pele"],
  resumoVisual: "Conjunto verde com rolo duplo e placa de pedra.",
  caracteristicasVisiveis: [
    { descricao: "Rolo facial com duas pontas de pedra e armacao metalica dourada.", origem: "produto" },
    { descricao: "Efeito lifting imediato garantido", origem: "material_promocional" },
  ],
  cores: [
    { valor: "Verde", origem: "produto" },
    { valor: "Dourado", origem: "produto" },
  ],
  materiais: [
    { valor: "Pedra", origem: "produto" },
    { valor: "Metal", origem: "produto" },
  ],
  componentes: [
    { valor: "Rolo massageador facial duplo", origem: "produto" },
    { valor: "Placa de massagem Gua Sha", origem: "produto" },
    { valor: "Estojo rigido", origem: "embalagem_fisica" },
  ],
  textosLegiveis: [],
  quantidadeDeclarada: { valor: null, textoOrigem: null },
  possiveisUsos: [{ descricao: "Massagem e estetica facial.", origem: "produto" }],
  publicoProvavel: [{ descricao: "Publico de cuidados pessoais.", origem: "produto" }],
  alertas: [],
  informacoesNaoConfirmadas: ["Composicao mineral exata nao declarada"],
  qualidadeDasFotos: { nota: 80, problemas: [], sugestoes: [] },
  atributosAdicionais: [{ nome: "Tipo de rolo", valor: "Duplo assimetrico", origem: "produto" }],
  fotosAnalisadas: [{ imagemId: "11111111-1111-1111-1111-111111111111", ordem: 1, principal: true }],
  metadadosAnalise: { totalFotosProjeto: 1, totalFotosAnalisadas: 1, analiseParcial: false, motivoAnaliseParcial: null },
};

const VV = montarVerdadeVisual(ANALISE);
const CONFIG = montarConfiguracao({
  quantidadeSolicitada: 3,
  estilo: "marketplace",
  modo: "rapido",
  marketplaces: ["Shopee", "ML"],
  verdadeVisual: VV,
});
const ENTRADA = montarEntradaPromptsImagem(VV);

function imagensOk(): any[] {
  return [
    {
      ordem: 1,
      tipo: "capa_principal",
      objetivo: "Mostrar o conjunto completo com leitura clara",
      cena: "Conjunto apoiado em superficie lisa e neutra",
      enquadramento: "produto_inteiro",
      fundo: "Fundo neutro e uniforme",
      iluminacao: "Luz difusa e suave",
      elementosObrigatorios: ["rolo massageador facial duplo", "placa de massagem gua sha"],
      elementosProibidos: ["nenhum objeto adicional na cena"],
    },
    {
      ordem: 2,
      tipo: "perspectiva",
      objetivo: "Apresentar o conjunto em outro angulo",
      cena: "Conjunto em vista angular sobre a mesma superficie",
      enquadramento: "tres_quartos",
      fundo: "Fundo neutro e uniforme",
      iluminacao: "Luz lateral suave",
      elementosObrigatorios: ["rolo massageador facial duplo"],
      elementosProibidos: ["nao acrescentar elemento novo"],
    },
    {
      ordem: 3,
      tipo: "detalhes",
      objetivo: "Destacar a armacao metalica dourada do rolo",
      cena: "Close da haste do rolo massageador",
      enquadramento: "close_detalhe",
      fundo: "Fundo neutro",
      iluminacao: "Luz direcionada e suave",
      elementosObrigatorios: ["armacao metalica dourada"],
      elementosProibidos: ["nao incluir outros objetos"],
    },
  ];
}
const saidaOk = (over?: (imgs: any[]) => any[]) => ({ imagens: over ? over(imagensOk()) : imagensOk() });

const valida = (json: unknown, config = CONFIG) => validarEstruturaPromptsImagem(json, config);
function integra(json: unknown, config = CONFIG) {
  const saida = valida(json, config);
  return validarIntegridadePromptsImagem(saida, ENTRADA, config);
}

console.log("\n[contrato e estrutura]");
t("1. contrato válido passa nas duas validações", () => {
  const r = integra(saidaOk());
  assert(r.valido, `deveria ser válido: ${r.motivo}`);
});
t("2. propriedade extra na raiz é rejeitada", () =>
  lanca(() => valida({ imagens: imagensOk(), observacoes: [] }), "propriedade extra"));
t("3. propriedade extra dentro da imagem é rejeitada", () =>
  lanca(() => valida(saidaOk(i => { i[0].estilo = "x"; return i; })), "propriedade extra"));
t("4. quantidade diferente da solicitada é rejeitada", () =>
  lanca(() => valida(saidaOk(i => i.slice(0, 2))), "quantidade incorreta"));
t("5. duas imagens principais são rejeitadas", () =>
  lanca(() => valida(saidaOk(i => { i[1].tipo = "capa_principal"; return i; })), "capa_principal precisa ter ordem 1"));
t("6. zero imagens principais é rejeitado", () =>
  lanca(() => valida(saidaOk(i => { i[0].tipo = "perspectiva"; return i; })), "exatamente 1 imagem principal"));
t("7. ordem duplicada é rejeitada", () =>
  lanca(() => valida(saidaOk(i => { i[2].ordem = 2; return i; })), "ordem duplicada"));
t("8. ordem faltando (fora do intervalo) é rejeitada", () =>
  lanca(() => valida(saidaOk(i => { i[2].ordem = 9; return i; })), "fora do intervalo"));
t("9. prompt vazio (campo textual vazio) é rejeitado", () =>
  lanca(() => valida(saidaOk(i => { i[1].cena = "   "; return i; })), 'campo "cena" vazio'));
t("10. tipo inválido é rejeitado", () =>
  // "beneficios" deixou de servir como exemplo de invalido em 2026-09-04
  // (foi liberado). Usa um valor que nunca existiu no CHECK do banco.
  lanca(() => valida(saidaOk(i => { i[1].tipo = "carrossel_animado"; return i; })), "tipo de imagem inválido"));
t("10b. `medidas` continua fora enquanto nao houver camada grafica", () =>
  // Existe no CHECK do banco, mas exige numerais desenhados dentro do
  // quadro — e texto gerado pelo modelo de imagem ainda erra.
  lanca(() => valida(saidaOk(i => { i[1].tipo = "medidas"; return i; })), "tipo de imagem inválido"));
t("11. aspectRatio nunca vem do modelo — é server-side e sempre o padrão", () => {
  assert(!("aspectRatio" in imagensOk()[0]), "modelo não deveria escrever aspectRatio");
  assert(!("aspectRatio" in (GERACAO_PROMPTS_IMAGEM_JSON_SCHEMA.properties.imagens.items.properties as any)), "schema não pode pedir aspectRatio");
  const prompts = montarPromptsFinais(valida(saidaOk()), VV, CONFIG);
  assert(prompts.every(p => p.aspectRatio === ASPECT_RATIO_PADRAO), "aspectRatio divergente do padrão");
});
t("12. marketplace inexistente na configuração é rejeitado", () =>
  lanca(() => validarConfiguracao({ ...CONFIG, marketplaces: ["Mercado Livre"] }), "marketplace inexistente"));

console.log("\n[integridade — verdade visual]");
t("13. marca inventada é rejeitada", () => {
  const r = integra(saidaOk(i => { i[0].elementosObrigatorios = ["logotipo da marca no corpo do rolo"]; return i; }));
  assert(!r.valido && /marca|logo/i.test(r.motivo ?? ""), `motivo inesperado: ${r.motivo}`);
});
t("14. modelo inventado é rejeitado", () => {
  const r = integra(saidaOk(i => { i[1].cena = "conjunto com o modelo gravado na haste"; return i; }));
  assert(!r.valido && /modelo/i.test(r.motivo ?? ""), `motivo inesperado: ${r.motivo}`);
});
t("15. material inventado é rejeitado", () => {
  const r = integra(saidaOk(i => { i[1].cena = "conjunto sobre bandeja de madeira"; return i; }));
  assert(!r.valido && /madeira/i.test(r.motivo ?? ""), `motivo inesperado: ${r.motivo}`);
});
t("16. cor inventada é rejeitada", () => {
  const r = integra(saidaOk(i => { i[1].fundo = "fundo azul intenso"; return i; }));
  assert(!r.valido && /azul/i.test(r.motivo ?? ""), `motivo inesperado: ${r.motivo}`);
});
t("17. cor confirmada em outra flexão é ACEITA (dourado -> dourada)", () => {
  const r = integra(saidaOk());
  assert(r.valido, `flexão de gênero não deveria falhar: ${r.motivo}`);
});
t("17b. fundo neutro (branco/cinza) é ACEITO; a cor do cenário não é atributo do produto", () => {
  // Regressão da primeira chamada real (2026-08-15): "fundo branco" era
  // rejeitado como se fosse cor inventada do produto.
  for (const fundo of ["Fundo branco liso de estudio", "Fundo cinza claro sem textura"]) {
    const r = integra(saidaOk(i => { i[0].fundo = fundo; return i; }));
    assert(r.valido, `"${fundo}" deveria ser aceito: ${r.motivo}`);
  }
  const rProduto = integra(saidaOk(i => { i[0].elementosObrigatorios = ["rolo massageador branco"]; return i; }));
  assert(!rProduto.valido && /produto/i.test(rProduto.motivo ?? ""), `cor do produto deveria falhar: ${rProduto.motivo}`);
});
t("18. quantidade inventada é rejeitada", () => {
  const r = integra(saidaOk(i => { i[1].elementosObrigatorios = ["3 unidades do rolo"]; return i; }));
  assert(!r.valido && /3un|numero|medida/i.test(r.motivo ?? ""), `motivo inesperado: ${r.motivo}`);
});
t("19. medida inventada é rejeitada", () => {
  const r = integra(saidaOk(i => { i[2].cena = "close com escala de 15 cm ao lado"; return i; }));
  assert(!r.valido, `deveria rejeitar: ${r.motivo}`);
});
t("20. preço inventado é rejeitado", () => {
  const r = integra(saidaOk(i => { i[1].cena = "conjunto com etiqueta de preco visivel"; return i; }));
  assert(!r.valido, `deveria rejeitar: ${r.motivo}`);
});
t("20b. vocabulário legítimo não é confundido com preço (regressão da chamada real)", () => {
  // "condições reais de uso" e "fundo off-white" eram rejeitados como se
  // fossem moeda/desconto. Preço e desconto seguem barrados.
  const r = integra(saidaOk(i => { i[1].cena = "conjunto em condicoes reais de uso"; i[1].fundo = "fundo off white"; return i; }));
  assert(r.valido, `deveria ser aceito: ${r.motivo}`);
  assert(!integra(saidaOk(i => { i[1].cena = "conjunto com desconto aplicado"; return i; })).valido, "desconto deveria falhar");
});
t("21. desconto inventado é rejeitado", () => {
  const r = integra(saidaOk(i => { i[1].fundo = "fundo com selo de desconto"; return i; }));
  assert(!r.valido, `deveria rejeitar: ${r.motivo}`);
});
t("22. promoção inventada é rejeitada", () => {
  const r = integra(saidaOk(i => { i[1].objetivo = "reforcar a promocao do conjunto"; return i; }));
  assert(!r.valido, `deveria rejeitar: ${r.motivo}`);
});
t("23. alegação clínica é rejeitada", () => {
  const r = integra(saidaOk(i => { i[1].objetivo = "mostrar que o produto trata a pele"; return i; }));
  assert(!r.valido, `deveria rejeitar: ${r.motivo}`);
});
t("24. texto não autorizado dentro da imagem é rejeitado", () => {
  const r = integra(saidaOk(i => { i[1].elementosObrigatorios = ["texto com o nome do produto"]; return i; }));
  assert(!r.valido, `deveria rejeitar: ${r.motivo}`);
});
t("25. informação NÃO CONFIRMADA reaparecendo é rejeitada", () => {
  const r = integra(saidaOk(i => { i[1].cena = "conjunto com acabamento mineral evidente"; return i; }));
  assert(!r.valido && /mineral/i.test(r.motivo ?? ""), `motivo inesperado: ${r.motivo}`);
});
t("26. alegação promocional filtrada por origem não vira elemento visual", () => {
  assert(VV.naoConfirmado.some(x => /lifting/i.test(x)), "item promocional deveria estar em naoConfirmado");
  assert(!VV.caracteristicasDoProduto.some(x => /lifting/i.test(x)), "item promocional não pode virar característica");
  const r = integra(saidaOk(i => { i[1].objetivo = "evidenciar o efeito lifting"; return i; }));
  assert(!r.valido, `deveria rejeitar: ${r.motivo}`);
});
t("27. embalagem fora de imagem do tipo embalagem é rejeitada", () => {
  const r = integra(saidaOk(i => { i[1].cena = "conjunto ao lado da embalagem"; return i; }));
  assert(!r.valido && /embalagem/i.test(r.motivo ?? ""), `motivo inesperado: ${r.motivo}`);
});
t("28. imagem principal não aceita pessoa/mão", () => {
  const r = integra(saidaOk(i => { i[0].cena = "conjunto segurado por uma pessoa"; return i; }));
  assert(!r.valido && /principal/i.test(r.motivo ?? ""), `motivo inesperado: ${r.motivo}`);
});

console.log("\n[verdade visual e configuração]");
t("29. filtro por origem separa produto, embalagem e não confirmado", () => {
  assert(VV.coresDoProduto.join() === "Verde,Dourado", "cores do produto erradas");
  assert(VV.itensDaEmbalagem.includes("Estojo rigido"), "item de embalagem perdido");
  assert(VV.naoConfirmado.includes("Composicao mineral exata nao declarada"), "informação não confirmada perdida");
  assert(!VV.componentesDoProduto.includes("Estojo rigido"), "embalagem não pode virar componente do produto");
});
t("30. tipos permitidos são derivados da verdade visual, nunca fixos", () => {
  assert(CONFIG.tiposPermitidos.includes("embalagem"), "havendo embalagem, o tipo deveria ser oferecido");
  const semNada = montarVerdadeVisual({ ...ANALISE, componentes: [], caracteristicasVisiveis: [], possiveisUsos: [], atributosAdicionais: [] });
  const tipos = calcularTiposPermitidos(semNada);
  assert(!tipos.includes("embalagem") && !tipos.includes("uso") && !tipos.includes("detalhes"), `tipos demais: ${tipos.join(",")}`);
  assert(tipos.includes("capa_principal"), "capa_principal é sempre permitida");
});
t("31. taxonomia é subconjunto do CHECK real de imagens_geradas.finalidade", () => {
  const CHECK_BANCO = ["capa_principal", "perspectiva", "beneficios", "medidas", "detalhes", "uso", "embalagem", "promocional_secundaria"];
  for (const tipo of TIPOS_IMAGEM_SUPORTADOS) assert(CHECK_BANCO.includes(tipo), `tipo "${tipo}" não existe no CHECK do banco`);
  // 2026-09-04: `beneficios` e `promocional_secundaria` foram liberados
  // — o beneficio e MOSTRADO pela cena, nunca escrito, e sem eles o
  // sistema so sabia fazer variacoes do mesmo retrato. `medidas` segue
  // fora: exige numeral desenhado, que depende da camada grafica.
  for (const liberado of ["beneficios", "promocional_secundaria"]) {
    assert((TIPOS_IMAGEM_SUPORTADOS as readonly string[]).includes(liberado), `"${liberado}" deveria estar liberado`);
  }
  assert(!(TIPOS_IMAGEM_SUPORTADOS as readonly string[]).includes("medidas"),
    "`medidas` so pode voltar quando a camada grafica em SVG existir");
});
t("32. quantidade vem do projeto, nunca de constante — 1, 8 e o teto funcionam", () => {
  for (const q of [1, 8, LIMITE_MAXIMO_PROMPTS_IMAGEM]) {
    validarConfiguracao({ ...CONFIG, quantidadeSolicitada: q });
  }
  lanca(() => validarConfiguracao({ ...CONFIG, quantidadeSolicitada: LIMITE_MAXIMO_PROMPTS_IMAGEM + 1 }), "teto operacional");
  lanca(() => validarConfiguracao({ ...CONFIG, quantidadeSolicitada: 0 }), "inválida");
});
t("33. quantidade 1 produz só a capa principal", () => {
  const c1 = { ...CONFIG, quantidadeSolicitada: 1 };
  const saida = validarEstruturaPromptsImagem({ imagens: [imagensOk()[0]] }, c1);
  assert(saida.imagens.length === 1 && saida.imagens[0].tipo === "capa_principal", "deveria ser só a capa");
});
t("34. textosPermitidos é sempre vazio na v1 e não pode ser forçado", () => {
  assert(CONFIG.textosPermitidos.length === 0, "v1 não autoriza texto na imagem");
  lanca(() => validarConfiguracao({ ...CONFIG, textosPermitidos: ["Frete grátis"] }), "não autoriza nenhum texto");
});

console.log("\n[composição server-side do prompt final]");
t("35. campos estruturais são server-side, exatamente 1 principal, ordem contínua", () => {
  const prompts = montarPromptsFinais(valida(saidaOk()), VV, CONFIG);
  assert(prompts.filter(p => p.principal).length === 1, "deveria haver exatamente 1 principal");
  assert(prompts[0].principal && prompts[0].ordem === 1, "a principal é a de ordem 1");
  assert(prompts.map(p => p.ordem).join() === "1,2,3", "ordem não contínua");
  assert(prompts.every(p => p.promptTexto.length > 0 && p.negativePrompt.length > 0), "prompt/negative vazios");
  assert(prompts.every(p => p.textosPermitidos.length === 0 && p.textosProibidos.length > 0), "textos server-side errados");
});
t("36. negativePrompt junta restrições globais + proibições daquela imagem", () => {
  const prompts = montarPromptsFinais(valida(saidaOk()), VV, CONFIG);
  for (const global of RESTRICOES_VISUAIS_GLOBAIS) {
    assert(prompts[0].negativePrompt.includes(global), `restrição global ausente: ${global}`);
  }
  assert(prompts[0].negativePrompt.includes("nenhum objeto adicional na cena"), "proibição específica ausente");
});
t("37. prompt final não vaza conteúdo comercial nem informação não confirmada", () => {
  const prompts = montarPromptsFinais(valida(saidaOk()), VV, CONFIG);
  for (const p of prompts) {
    assert(!/lifting/i.test(p.promptTexto), "vazou alegação promocional");
    assert(!/mineral/i.test(p.promptTexto), "vazou informação não confirmada");
  }
});
t("38. prompt enviado ao modelo carrega a verdade visual e as proibições", () => {
  const texto = montarPromptGeracaoPromptsImagem(ENTRADA, CONFIG);
  assert(texto.includes("NÃO CONFIRMADO"), "faltou a seção de não confirmado");
  assert(texto.includes("Composicao mineral exata nao declarada"), "faltou o item não confirmado");
  assert(texto.includes("EXATAMENTE 3"), "faltou a quantidade exata");
  for (const r of RESTRICOES_PROMPTS_IMAGEM) assert(texto.includes(r), `restrição ausente: ${r}`);
  // 2026-09-04: a assercao deixou de ser "estes tipos nunca aparecem" e
  // passou a ser "so aparecem os tipos calculados para ESTE projeto" —
  // que e a invariante real. `medidas` continua nunca podendo aparecer.
  assert(!texto.includes("- medidas:"), "`medidas` nao pode ser oferecido ao modelo");
  for (const t of CONFIG.tiposPermitidos) {
    assert(texto.includes(`- ${t}:`), `tipo permitido ausente da instrucao: ${t}`);
  }
});
t("39. resumo curto é curto e não é o envelope inteiro", () => {
  const envelope = { fonteAnaliseVisual: { jobId: "j", resultadoId: "r", schemaVersao: 1 }, configuracao: CONFIG, entrada: ENTRADA, prompts: montarPromptsFinais(valida(saidaOk()), VV, CONFIG) };
  const resumo = montarResumoCurtoPromptsImagem(envelope);
  assert(resumo.length <= 500, "resumo longo demais");
  assert(!resumo.includes("Fotografia de produto"), "resumo não pode conter o prompt inteiro");
});

console.log("\n[origem semântica]");
const JOB = "aaaaaaaa-0000-0000-0000-000000000001";
const ORIGEM = "bbbbbbbb-0000-0000-0000-000000000002";
const PROJ = "cccccccc-0000-0000-0000-000000000003";
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
const CTX = { jobId: JOB, projetoId: PROJ, etapa: "geracao_prompts_imagem" };
const RESULTADO_OK = [{ id: "res-1", etapa: "analise_visual", schema_versao: 1, resultado: ANALISE }];

async function rodarTestesDeOrigem() {
  await ta("40. origem ausente (job_origem_id null) é rejeitada", () =>
  lancaAsync(() => validarOrigemEBuscarAnaliseVisual(fakeSupabase({ job: { id: JOB, projeto_id: PROJ, job_origem_id: null } }), CTX), "job_origem_id ausente"));
  await ta("41. origem de etapa errada (adaptacao_marketplace) é rejeitada", () =>
  lancaAsync(() => validarOrigemEBuscarAnaliseVisual(fakeSupabase({
    job: { id: JOB, projeto_id: PROJ, job_origem_id: ORIGEM },
    origem: { id: ORIGEM, projeto_id: PROJ, etapa: "adaptacao_marketplace", status: "concluido" },
    resultados: RESULTADO_OK,
  }), CTX), 'esperado "analise_visual"'));
  await ta("42. origem de outro projeto é rejeitada", () =>
  lancaAsync(() => validarOrigemEBuscarAnaliseVisual(fakeSupabase({
    job: { id: JOB, projeto_id: PROJ, job_origem_id: ORIGEM },
    origem: { id: ORIGEM, projeto_id: "outro-projeto", etapa: "analise_visual", status: "concluido" },
    resultados: RESULTADO_OK,
  }), CTX), "outro projeto"));
  await ta("43. origem não concluída é rejeitada", () =>
  lancaAsync(() => validarOrigemEBuscarAnaliseVisual(fakeSupabase({
    job: { id: JOB, projeto_id: PROJ, job_origem_id: ORIGEM },
    origem: { id: ORIGEM, projeto_id: PROJ, etapa: "analise_visual", status: "rodando" },
    resultados: RESULTADO_OK,
  }), CTX), "não está concluído"));
  await ta("44. resultado da origem ausente é rejeitado", () =>
  lancaAsync(() => validarOrigemEBuscarAnaliseVisual(fakeSupabase({
    job: { id: JOB, projeto_id: PROJ, job_origem_id: ORIGEM },
    origem: { id: ORIGEM, projeto_id: PROJ, etapa: "analise_visual", status: "concluido" },
    resultados: [],
  }), CTX), "encontrado 0"));
  await ta("45. schema_versao incompatível na origem é rejeitado", () =>
  lancaAsync(() => validarOrigemEBuscarAnaliseVisual(fakeSupabase({
    job: { id: JOB, projeto_id: PROJ, job_origem_id: ORIGEM },
    origem: { id: ORIGEM, projeto_id: PROJ, etapa: "analise_visual", status: "concluido" },
    resultados: [{ ...RESULTADO_OK[0], schema_versao: 2 }],
  }), CTX), "schema_versao"));
  await ta("46. origem válida devolve a análise e a referência embutida", async () => {
  const r = await validarOrigemEBuscarAnaliseVisual(fakeSupabase({
    job: { id: JOB, projeto_id: PROJ, job_origem_id: ORIGEM },
    origem: { id: ORIGEM, projeto_id: PROJ, etapa: "analise_visual", status: "concluido" },
    resultados: RESULTADO_OK,
  }), CTX);
  assert(r.jobOrigemId === ORIGEM && r.resultadoId === "res-1" && r.schemaVersao === 1, "referência de origem incorreta");
  assert(r.analise.produtoIdentificado === ANALISE.produtoIdentificado, "análise devolvida errada");
});

}

console.log("\n[registry, roteamento e custo]");
t("47. registry sem conflito — nenhuma etapa em ambos os conjuntos", () => {
  for (const etapa of Object.keys(HANDLERS_ESPECIFICOS)) {
    assert(!ETAPAS_FAKE_GENERICAS.has(etapa), `etapa "${etapa}" está nos dois conjuntos`);
    assert(HANDLERS_ESPECIFICOS[etapa].etapa === etapa, `chave e handler divergem em "${etapa}"`);
  }
});
t("48. geracao_prompts_imagem tem handler específico com o contrato correto", () => {
  const h = resolverHandler("geracao_prompts_imagem");
  assert(!!h && h.etapa === "geracao_prompts_imagem", "handler não resolvido");
  assert(h!.provedoresPermitidos.join() === "fake,google", `provedores: ${h!.provedoresPermitidos.join()}`);
  assert(h!.versaoSaida === SCHEMA_VERSAO_GERACAO_PROMPTS_IMAGEM, "versaoSaida divergente");
  assert(h!.dependencia === "job_origem_id", "dependência declarada errada");
  assert(h!.geraResultadoEstruturado === true, "deveria gerar resultado estruturado");
});
t("49. fake das outras etapas preservado (invariante, sem contagem fixa)", () => {
  for (const etapa of ETAPAS_FAKE_GENERICAS) {
    const h = resolverHandler(etapa);
    assert(!!h && !(etapa in HANDLERS_ESPECIFICOS), `etapa "${etapa}" perdeu o caminho fake`);
  }
  assert(!ETAPAS_FAKE_GENERICAS.has("geracao_prompts_imagem"), "promovida mas ainda no conjunto fake");
});
t("50. flag ausente/false mantém a etapa em fake; true roteia para google", () => {
  const antes = process.env.GOOGLE_AI_PROMPTS_IMAGEM_ENABLED;
  try {
    delete process.env.GOOGLE_AI_PROMPTS_IMAGEM_ENABLED;
    assert(decidirProvedor("geracao_prompts_imagem") === "fake", "ausente deveria ser fake");
    process.env.GOOGLE_AI_PROMPTS_IMAGEM_ENABLED = "1";
    assert(decidirProvedor("geracao_prompts_imagem") === "fake", '"1" deveria ser fake');
    process.env.GOOGLE_AI_PROMPTS_IMAGEM_ENABLED = "true";
    assert(decidirProvedor("geracao_prompts_imagem") === "google", '"true" deveria ser google');
  } finally {
    if (antes === undefined) delete process.env.GOOGLE_AI_PROMPTS_IMAGEM_ENABLED;
    else process.env.GOOGLE_AI_PROMPTS_IMAGEM_ENABLED = antes;
  }
});
t("51. flag desta etapa não interfere nas outras", () => {
  const antes = process.env.GOOGLE_AI_PROMPTS_IMAGEM_ENABLED;
  const antesConteudo = process.env.GOOGLE_AI_GERACAO_CONTEUDO_ENABLED;
  try {
    process.env.GOOGLE_AI_PROMPTS_IMAGEM_ENABLED = "true";
    delete process.env.GOOGLE_AI_GERACAO_CONTEUDO_ENABLED;
    assert(decidirProvedor("geracao_conteudo") === "fake", "flag vazou para geracao_conteudo");
    assert(decidirProvedor("geracao_imagem") === "fake", "flag vazou para geracao_imagem");
  } finally {
    if (antes === undefined) delete process.env.GOOGLE_AI_PROMPTS_IMAGEM_ENABLED;
    else process.env.GOOGLE_AI_PROMPTS_IMAGEM_ENABLED = antes;
    if (antesConteudo === undefined) delete process.env.GOOGLE_AI_GERACAO_CONTEUDO_ENABLED;
    else process.env.GOOGLE_AI_GERACAO_CONTEUDO_ENABLED = antesConteudo;
  }
});
t("52. modelo vazio falha como auth, antes de qualquer chamada paga", () => {
  const antes = process.env.GOOGLE_AI_MODEL_PROMPTS_IMAGEM;
  try {
    process.env.GOOGLE_AI_MODEL_PROMPTS_IMAGEM = "   ";
    let erro: any;
    try { obterModeloPromptsImagem(); } catch (e) { erro = e; }
    assert(erro instanceof ErroProvedorIA && erro.tipo === "auth", `esperado auth, veio ${erro?.tipo}`);
    process.env.GOOGLE_AI_MODEL_PROMPTS_IMAGEM = " gemini-3.6-flash ";
    assert(obterModeloPromptsImagem() === "gemini-3.6-flash", "trim não aplicado");
  } finally {
    if (antes === undefined) delete process.env.GOOGLE_AI_MODEL_PROMPTS_IMAGEM;
    else process.env.GOOGLE_AI_MODEL_PROMPTS_IMAGEM = antes;
  }
});
t("53. modelo desconhecido custa 0; o modelo desta etapa tem preço cadastrado", () => {
  assert(estimarCustoUsd("modelo-inexistente-xyz", 1000, 1000) === 0, "deveria ser 0");
  assert(modeloTemPrecoCadastrado("gemini-3.6-flash"), "modelo de texto sem preço cadastrado");
  assert(estimarCustoUsd("gemini-3.6-flash", 1_000_000, 0) === 1.5, "preço de entrada regrediu");
});
t("54. tipo de prompt mapeado continua sendo `imagem`", () =>
  assert(decidirTipoPrompt("geracao_prompts_imagem") === "imagem", "categoria de prompt errada"));

console.log("\n[limites de escopo — o que esta etapa NUNCA faz]");
/**
 * Os comentários dos dois arquivos DOCUMENTAM as proibições (citam
 * `estudio_anuncios_imagens_geradas`, Veo, Storage) — varrer o arquivo
 * cru acusaria a própria documentação. As asserções abaixo olham só o
 * CÓDIGO, com os comentários removidos.
 */
function semComentarios(fonte: string): string {
  return fonte.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}
const FONTE_DOMINIO = semComentarios(fs.readFileSync(path.join(process.cwd(), "lib/estudio-anuncios/geracao-prompts-imagem.ts"), "utf-8"));
const FONTE_HANDLER = semComentarios(fs.readFileSync(path.join(process.cwd(), "lib/estudio-anuncios/executores/geracao-prompts-imagem.ts"), "utf-8"));
t("55. nenhuma chamada a Storage nem download de bytes de foto", () => {
  for (const fonte of [FONTE_DOMINIO, FONTE_HANDLER]) {
    assert(!/from ".*storage"/.test(fonte) && !/from ".*fotos"/.test(fonte), "importou storage/fotos");
    assert(!/\.storage\b/.test(fonte), "usou o client de Storage");
    assert(!/chamarGeminiComImagens/.test(fonte), "enviou imagens ao provedor");
  }
});
t("56. nenhuma escrita em imagens_geradas nem em conteudo_versoes", () => {
  for (const fonte of [FONTE_DOMINIO, FONTE_HANDLER]) {
    assert(!/imagens_geradas/.test(fonte), "tocou em estudio_anuncios_imagens_geradas");
    assert(!/conteudo_versoes/.test(fonte), "tocou em estudio_anuncios_conteudo_versoes");
    assert(!/\.insert\(|\.update\(|\.upsert\(|\.delete\(/.test(fonte), "escreveu no banco fora do executor");
  }
});
t("57. nenhuma resolução por 'o mais recente' e nenhum modelo de imagem", () => {
  assert(!/order\(/i.test(FONTE_DOMINIO), "usou ORDER BY");
  assert(!/criado_em/.test(FONTE_DOMINIO), "ordenou/filtrou por criado_em");
  assert(!/(^| )veo( |\b)|dall|stable.?diffusion|generate_?image\b/i.test(FONTE_DOMINIO), "referenciou provedor de imagem");
});
t("58. o domínio não consome artefato comercial (adaptacao/revisao/conteudo)", () => {
  assert(!/adaptacao-marketplace-tipos.*Envelope|EnvelopeAdaptacaoMarketplace/.test(FONTE_DOMINIO), "consumiu envelope de adaptacao");
  assert(!/EnvelopeRevisaoClaude|EnvelopeGeracaoConteudo/.test(FONTE_DOMINIO), "consumiu envelope de conteúdo");
});

rodarTestesDeOrigem().then(() => {
  console.log(`\n=== RESULTADO: ${ok} passaram, ${falhou} falharam ===\n`);
  process.exitCode = falhou > 0 ? 1 : 0;
});
