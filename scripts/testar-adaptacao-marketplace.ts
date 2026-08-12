/**
 * Testes determinísticos da etapa `adaptacao_marketplace` — funções
 * puras, sem banco, sem rede, sem IA. Mesmo padrão de
 * scripts/testar-geracao-conteudo.ts.
 *
 * Uso: npx tsx scripts/testar-adaptacao-marketplace.ts
 */
import {
  validarEstruturaAdaptacao,
  validarIntegridadeAdaptacao,
  montarEntradaAdaptacao,
  montarPromptAdaptacao,
  RESTRICOES_ADAPTACAO,
} from "../lib/estudio-anuncios/adaptacao-marketplace";
import {
  CTAS_PERMITIDOS,
  MARKETPLACES_SUPORTADOS,
  SCHEMA_VERSAO_ADAPTACAO_MARKETPLACE,
  isMarketplaceSuportado,
} from "../lib/estudio-anuncios/adaptacao-marketplace-tipos";
import type { MarketplaceSuportado } from "../lib/estudio-anuncios/adaptacao-marketplace-tipos";
import type { GeracaoConteudoIA } from "../lib/estudio-anuncios/geracao-conteudo-tipos";
import { ADAPTACAO_MARKETPLACE_JSON_SCHEMA } from "../lib/ai-gateway/provedores/google-adaptacao-marketplace-schema";
import { HANDLERS_ESPECIFICOS, ETAPAS_FAKE_GENERICAS, resolverHandler } from "../lib/estudio-anuncios/executores/registry";
import { decidirProvedor } from "../lib/ai-gateway/roteamento";

let ok = 0;
let falhou = 0;
function t(nome: string, fn: () => void) {
  try {
    fn();
    ok++;
    console.log(`  PASS  ${nome}`);
  } catch (e: any) {
    falhou++;
    console.log(`  FALHA ${nome} -> ${e?.message ?? e}`);
  }
}
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}
function lanca(fn: () => unknown, trecho: string) {
  try {
    fn();
  } catch (e: any) {
    assert(String(e?.message ?? "").toLowerCase().includes(trecho.toLowerCase()), `mensagem inesperada: ${e?.message}`);
    return;
  }
  throw new Error(`deveria ter lançado (esperado conter "${trecho}")`);
}

const BASE: GeracaoConteudoIA = {
  tituloBase: { texto: "Rolo Massageador Facial Duplo de Pedra Verde", fatoIds: ["F1"] },
  descricaoCurta: { texto: "Rolo massageador facial com duas extremidades e hastes metálicas.", contemRessalva: false, fatoIds: ["F1"] },
  bullets: [
    { texto: "Duas extremidades giratorias de tamanhos distintos.", contemRessalva: false, fatoIds: ["F2"] },
    { texto: "Estrutura em metal de tom dourado.", contemRessalva: false, fatoIds: ["F3"] },
  ],
  descricaoLonga: [{ texto: "Indicado para massagem facial e do pescoco.", contemRessalva: false, fatoIds: ["F4"] }],
  especificacoes: [
    { nome: "Material da Estrutura", valor: "Metal", fatoId: "F3" },
    { nome: "Componente Principal", valor: "1 rolo massageador facial duplo", fatoId: "F1" },
  ],
};

const ALVOS: MarketplaceSuportado[] = ["ML", "Shopee"];
const ENTRADA = montarEntradaAdaptacao(BASE, ALVOS);

function adaptacaoValida(mk: MarketplaceSuportado) {
  return { marketplace: mk, titulo: "Rolo Massageador Facial Duplo", descricao: "Rolo com duas extremidades e hastes metalicas." };
}
function saida(...itens: any[]) {
  return { adaptacoes: itens };
}

console.log("\n=== adaptacao_marketplace — testes determinísticos ===\n");

console.log("[estrutura]");
t("1. domínio válido é aceito", () => {
  const r = validarEstruturaAdaptacao(saida(adaptacaoValida("ML"), adaptacaoValida("Shopee")));
  assert(r.adaptacoes.length === 2, "esperado 2 adaptações");
});
t("2. propriedade extra na adaptação é rejeitada", () =>
  lanca(() => validarEstruturaAdaptacao(saida({ ...adaptacaoValida("ML"), preco: "10" })), "propriedade extra"));
t("2b. propriedade extra na raiz é rejeitada", () =>
  lanca(() => validarEstruturaAdaptacao({ adaptacoes: [adaptacaoValida("ML")], extra: 1 }), "propriedade extra"));
t("3. marketplace inválido é rejeitado", () =>
  lanca(() => validarEstruturaAdaptacao(saida({ ...adaptacaoValida("ML"), marketplace: "Magalu" })), "marketplace inválido"));
t("4. título vazio é rejeitado", () =>
  lanca(() => validarEstruturaAdaptacao(saida({ ...adaptacaoValida("ML"), titulo: "   " })), "título vazio"));
t("5. descrição vazia é rejeitada", () =>
  lanca(() => validarEstruturaAdaptacao(saida({ ...adaptacaoValida("ML"), descricao: "" })), "descrição vazia"));
t("5b. adaptacoes vazio é rejeitado", () => lanca(() => validarEstruturaAdaptacao({ adaptacoes: [] }), "ausente ou vazio"));
t("5c. campo opcional ausente é aceito (nunca null)", () => {
  const r = validarEstruturaAdaptacao(saida(adaptacaoValida("ML")));
  assert(!("bullets" in r.adaptacoes[0]), "bullets não deveria existir");
  assert(!("cta" in r.adaptacoes[0]), "cta não deveria existir");
});

console.log("\n[integridade de conteúdo]");
t("6. fato novo introduzido é rejeitado (promessa)", () => {
  const s = saida({ ...adaptacaoValida("ML"), descricao: "Rolo com frete gratis e desconto." }, adaptacaoValida("Shopee"));
  const r = validarIntegridadeAdaptacao(s as any, ENTRADA);
  assert(!r.valido && /termo proibido/.test(r.motivo!), `esperado rejeição, veio ${JSON.stringify(r)}`);
});
t("7. especificação inexistente é rejeitada", () => {
  const s = saida({ ...adaptacaoValida("ML"), especificacoes: [{ nome: "Voltagem", valor: "220V" }] }, adaptacaoValida("Shopee"));
  const r = validarIntegridadeAdaptacao(s as any, ENTRADA);
  assert(!r.valido && /não existe no conteúdo-base/.test(r.motivo!), `veio ${JSON.stringify(r)}`);
});
t("8. valor de especificação alterado é rejeitado", () => {
  const s = saida({ ...adaptacaoValida("ML"), especificacoes: [{ nome: "Material da Estrutura", valor: "Ouro" }] }, adaptacaoValida("Shopee"));
  const r = validarIntegridadeAdaptacao(s as any, ENTRADA);
  assert(!r.valido && /foi alterado/.test(r.motivo!), `veio ${JSON.stringify(r)}`);
});
t("8b. especificação idêntica à base é aceita", () => {
  const s = saida({ ...adaptacaoValida("ML"), especificacoes: [{ nome: "Material da Estrutura", valor: "Metal" }] }, adaptacaoValida("Shopee"));
  assert(validarIntegridadeAdaptacao(s as any, ENTRADA).valido, "deveria aceitar");
});
t("9. unidade/medida inventada é rejeitada", () => {
  const s = saida({ ...adaptacaoValida("ML"), descricao: "Rolo massageador de 500ml." }, adaptacaoValida("Shopee"));
  const r = validarIntegridadeAdaptacao(s as any, ENTRADA);
  assert(!r.valido && /medida\/quantidade/.test(r.motivo!), `veio ${JSON.stringify(r)}`);
});
t("10. alegação clínica nova é rejeitada", () => {
  const s = saida({ ...adaptacaoValida("ML"), descricao: "Rolo que trata rugas e rejuvenesce a pele." }, adaptacaoValida("Shopee"));
  assert(!validarIntegridadeAdaptacao(s as any, ENTRADA).valido, "deveria rejeitar");
});
t("11. garantia não sustentada é rejeitada", () => {
  const s = saida({ ...adaptacaoValida("ML"), descricao: "Resultado garantido em 7 dias." }, adaptacaoValida("Shopee"));
  assert(!validarIntegridadeAdaptacao(s as any, ENTRADA).valido, "deveria rejeitar");
});
t("12. marketplace não solicitado é rejeitado", () => {
  const s = saida(adaptacaoValida("ML"), adaptacaoValida("Shopee"), adaptacaoValida("Amazon"));
  const r = validarIntegridadeAdaptacao(s as any, ENTRADA);
  assert(!r.valido && /não solicitado/.test(r.motivo!), `veio ${JSON.stringify(r)}`);
});
t("13. marketplace duplicado é rejeitado", () => {
  const s = saida(adaptacaoValida("ML"), adaptacaoValida("ML"));
  const r = validarIntegridadeAdaptacao(s as any, ENTRADA);
  assert(!r.valido && /duplicado/.test(r.motivo!), `veio ${JSON.stringify(r)}`);
});
t("14. marketplace solicitado ausente é rejeitado", () => {
  const r = validarIntegridadeAdaptacao(saida(adaptacaoValida("ML")) as any, ENTRADA);
  assert(!r.valido && /sem adaptação/.test(r.motivo!), `veio ${JSON.stringify(r)}`);
});
t("15. saída íntegra é aceita", () => {
  const s = saida(adaptacaoValida("ML"), adaptacaoValida("Shopee"));
  assert(validarIntegridadeAdaptacao(s as any, ENTRADA).valido, "deveria aceitar");
});

console.log("\n[CTA controlado]");
t("16. CTA fora da lista é rejeitado na estrutura", () =>
  lanca(() => validarEstruturaAdaptacao(saida({ ...adaptacaoValida("ML"), cta: "COMPRE AGORA!!!" })), "cta fora da lista"));
t("17. CTA da lista é aceito", () => {
  const s = saida({ ...adaptacaoValida("ML"), cta: CTAS_PERMITIDOS[0] }, adaptacaoValida("Shopee"));
  const e = validarEstruturaAdaptacao(s);
  assert(e.adaptacoes[0].cta === CTAS_PERMITIDOS[0], "cta deveria ser preservado");
  assert(validarIntegridadeAdaptacao(e, ENTRADA).valido, "integridade deveria aceitar");
});
t("18. CTA fora da lista congelada é rejeitado na integridade", () => {
  const entradaRestrita = { ...ENTRADA, ctasPermitidos: [CTAS_PERMITIDOS[1]] as string[] };
  const s = { adaptacoes: [{ ...adaptacaoValida("ML"), cta: CTAS_PERMITIDOS[0] }, adaptacaoValida("Shopee")] };
  const r = validarIntegridadeAdaptacao(s as any, entradaRestrita);
  assert(!r.valido && /CTA fora da lista/.test(r.motivo!), `veio ${JSON.stringify(r)}`);
});

console.log("\n[contrato / entrada]");
t("19. entrada congela CTAs e restrições", () => {
  assert(ENTRADA.ctasPermitidos.length === CTAS_PERMITIDOS.length, "ctas não congelados");
  assert(ENTRADA.restricoes === RESTRICOES_ADAPTACAO, "restrições não congeladas");
  assert(ENTRADA.marketplacesAlvo.length === 2, "alvos errados");
});
t("20. entrada NÃO reenvia a entrada segura de geracao_conteudo", () => {
  const chaves = Object.keys(ENTRADA).sort().join(",");
  assert(chaves === "conteudoBase,ctasPermitidos,marketplacesAlvo,restricoes", `chaves inesperadas: ${chaves}`);
});
t("21. prompt inclui conteúdo-base, alvos e CTAs; não inclui foto/storage", () => {
  const p = montarPromptAdaptacao(ENTRADA);
  assert(p.includes("Rolo Massageador Facial Duplo de Pedra Verde"), "faltou conteúdo-base");
  assert(p.includes("ML") && p.includes("Shopee"), "faltaram alvos");
  assert(p.includes(CTAS_PERMITIDOS[0]), "faltou CTA");
  assert(!/storage|foto|imagem|base64/i.test(p), "prompt não pode mencionar foto/storage");
});
t("22. schema Google cobre exatamente a raiz do domínio", () => {
  const props = Object.keys(ADAPTACAO_MARKETPLACE_JSON_SCHEMA.properties).sort().join(",");
  assert(props === "adaptacoes", `props inesperadas: ${props}`);
  assert(ADAPTACAO_MARKETPLACE_JSON_SCHEMA.additionalProperties === false, "additionalProperties deve ser false");
});
t("23. marketplaces suportados espelham o CHECK do banco", () => {
  assert(MARKETPLACES_SUPORTADOS.join(",") === "ML,Shopee,Amazon,TikTok Shop", "lista divergente do banco");
  assert(isMarketplaceSuportado("ML") && !isMarketplaceSuportado("Magalu"), "guard incorreto");
});
t("24. schema_versao é constante independente = 1", () => {
  assert(SCHEMA_VERSAO_ADAPTACAO_MARKETPLACE === 1, "versão inesperada");
});

console.log("\n[registry e roteamento]");
t("25. registry não tem etapa nos dois conjuntos", () => {
  for (const etapa of Object.keys(HANDLERS_ESPECIFICOS)) {
    assert(!ETAPAS_FAKE_GENERICAS.has(etapa), `etapa "${etapa}" está nos dois conjuntos`);
  }
});
t("26. adaptacao_marketplace resolve para handler específico", () => {
  const h = resolverHandler("adaptacao_marketplace");
  assert(!!h && h.etapa === "adaptacao_marketplace", "handler específico não resolvido");
  assert(h!.geraResultadoEstruturado === true, "deveria gerar resultado estruturado");
  assert(h!.dependencia === "job_origem_id", "dependência deveria ser job_origem_id");
  assert(h!.versaoSaida === SCHEMA_VERSAO_ADAPTACAO_MARKETPLACE, "versaoSaida incorreta");
});
t("27. provedor não permitido é barrado pelo contrato do handler", () => {
  const h = resolverHandler("adaptacao_marketplace")!;
  assert(!h.provedoresPermitidos.includes("anthropic" as any), "anthropic não deveria ser permitido");
  assert(h.provedoresPermitidos.includes("fake") && h.provedoresPermitidos.includes("google"), "fake+google esperados");
});
t("28. flag ausente/false mantém fake", () => {
  const antes = process.env.GOOGLE_AI_ADAPTACAO_MARKETPLACE_ENABLED;
  delete process.env.GOOGLE_AI_ADAPTACAO_MARKETPLACE_ENABLED;
  assert(decidirProvedor("adaptacao_marketplace") === "fake", "ausente deveria dar fake");
  process.env.GOOGLE_AI_ADAPTACAO_MARKETPLACE_ENABLED = "false";
  assert(decidirProvedor("adaptacao_marketplace") === "fake", "false deveria dar fake");
  process.env.GOOGLE_AI_ADAPTACAO_MARKETPLACE_ENABLED = "TRUE";
  assert(decidirProvedor("adaptacao_marketplace") === "fake", "TRUE (caixa alta) deveria dar fake");
  process.env.GOOGLE_AI_ADAPTACAO_MARKETPLACE_ENABLED = "true";
  assert(decidirProvedor("adaptacao_marketplace") === "google", "true deveria dar google");
  if (antes === undefined) delete process.env.GOOGLE_AI_ADAPTACAO_MARKETPLACE_ENABLED;
  else process.env.GOOGLE_AI_ADAPTACAO_MARKETPLACE_ENABLED = antes;
});
t("29. flag desta etapa não afeta outras etapas", () => {
  // AJUSTE (2026-08-17): mesmo motivo do teste 32 de revisao_claude —
  // compara antes/depois em vez de fixar o provedor de outras etapas.
  const antes = process.env.GOOGLE_AI_ADAPTACAO_MARKETPLACE_ENABLED;
  const outras = ["revisao_claude", "calculo_score", "ping"];
  delete process.env.GOOGLE_AI_ADAPTACAO_MARKETPLACE_ENABLED;
  const referencia = outras.map(e => decidirProvedor(e));
  process.env.GOOGLE_AI_ADAPTACAO_MARKETPLACE_ENABLED = "true";
  outras.forEach((e, i) => assert(decidirProvedor(e) === referencia[i], `flag vazou para ${e}`));
  if (antes === undefined) delete process.env.GOOGLE_AI_ADAPTACAO_MARKETPLACE_ENABLED;
  else process.env.GOOGLE_AI_ADAPTACAO_MARKETPLACE_ENABLED = antes;
});
t("30. etapas fake restantes continuam no fake genérico", () => {
  // Deriva do conjunto real — lista fixa quebrava a cada promoção.
  assert(ETAPAS_FAKE_GENERICAS.size > 0, "conjunto fake não pode ficar vazio");
  for (const etapa of ETAPAS_FAKE_GENERICAS) {
    const h = resolverHandler(etapa);
    assert(!!h && h.etapa === "*", `etapa "${etapa}" deveria usar o handler fake genérico`);
  }
  assert(resolverHandler("etapa_inexistente") === undefined, "etapa desconhecida deveria devolver undefined");
});
t("31. modelo ausente com flag true gera erro explícito (auth)", () => {
  const antes = process.env.GOOGLE_AI_MODEL_ADAPTACAO_MARKETPLACE;
  delete process.env.GOOGLE_AI_MODEL_ADAPTACAO_MARKETPLACE;
  const { obterModeloAdaptacaoMarketplace } = require("../lib/ai-gateway/provedores/google");
  try {
    obterModeloAdaptacaoMarketplace();
    throw new Error("deveria ter lançado");
  } catch (e: any) {
    assert(e?.tipo === "auth", `esperado tipo auth, veio ${e?.tipo}`);
  } finally {
    if (antes !== undefined) process.env.GOOGLE_AI_MODEL_ADAPTACAO_MARKETPLACE = antes;
  }
});
t("32. modelo desconhecido gera custo 0 (sem lançar)", () => {
  const { estimarCustoUsd } = require("../lib/ai-gateway/provedores/google");
  assert(estimarCustoUsd("modelo-inexistente-xyz", 1000, 1000) === 0, "deveria ser 0");
  assert(estimarCustoUsd("gemini-3.6-flash", 1_000_000, 0) === 1.5, "preço conhecido incorreto");
});

console.log(`\n=== RESULTADO: ${ok} passaram, ${falhou} falharam ===\n`);
process.exitCode = falhou > 0 ? 1 : 0;
