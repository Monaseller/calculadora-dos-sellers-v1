/**
 * Bateria de testes isolados de geracao_conteudo — só funções puras
 * (montarEntradaSeguraGeracaoConteudo, validarEstruturaGeracaoConteudo,
 * validarIntegridadeFatoIds) + o registry (resolverHandler/
 * HANDLERS_ESPECIFICOS/ETAPAS_FAKE_GENERICAS). Nenhuma chamada real ao
 * Gemini, nenhum acesso ao Supabase — cobre a lógica determinística de
 * classificação/validação com dados sintéticos, sem depender de
 * infraestrutura externa. Rodar com: npx tsx scripts/testar-geracao-conteudo.ts
 */
import {
  montarEntradaSeguraGeracaoConteudo,
  validarEstruturaGeracaoConteudo,
  validarIntegridadeFatoIds,
} from "../lib/estudio-anuncios/geracao-conteudo";
import { SCHEMA_VERSAO_GERACAO_CONTEUDO, type EntradaSeguraGeracaoConteudo, type GeracaoConteudoIA } from "../lib/estudio-anuncios/geracao-conteudo-tipos";
import type { AnaliseVisualCompleta } from "../lib/ai-gateway/provedores/google-tipos";
import { ErroProvedorIA } from "../lib/ai-gateway/provedores/google";
import { resolverHandler, HANDLERS_ESPECIFICOS, ETAPAS_FAKE_GENERICAS } from "../lib/estudio-anuncios/executores/registry";
import { handlerAnaliseVisual } from "../lib/estudio-anuncios/executores/analise-visual";
import { handlerGeracaoConteudo } from "../lib/estudio-anuncios/executores/geracao-conteudo";
import { handlerFakeGenerico } from "../lib/estudio-anuncios/executores/fake-generico";

let total = 0;
let falhas = 0;

function teste(nome: string, fn: () => void) {
  total++;
  try {
    fn();
    console.log(`  OK  ${nome}`);
  } catch (err: any) {
    falhas++;
    console.log(`FALHA  ${nome} — ${err?.message ?? err}`);
  }
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

function assertLanca(fn: () => void, tipoEsperado?: string) {
  try {
    fn();
  } catch (err: any) {
    if (tipoEsperado && err instanceof ErroProvedorIA && err.tipo !== tipoEsperado) {
      throw new Error(`lançou tipo "${err.tipo}", esperado "${tipoEsperado}"`);
    }
    return;
  }
  throw new Error("esperava que lançasse, mas não lançou");
}

// ────────────────────────────────────────────────────────────────────
// Fixture base
// ────────────────────────────────────────────────────────────────────
function baseAnalise(overrides: Partial<AnaliseVisualCompleta> = {}): AnaliseVisualCompleta {
  return {
    produtoIdentificado: null,
    marca: null,
    modelo: null,
    categoriaProvavel: null,
    resumoVisual: "resumo de teste",
    caracteristicasVisiveis: [],
    cores: [],
    materiais: [],
    componentes: [],
    textosLegiveis: [],
    quantidadeDeclarada: { valor: null, textoOrigem: null },
    possiveisUsos: [],
    publicoProvavel: [],
    alertas: [],
    informacoesNaoConfirmadas: [],
    qualidadeDasFotos: { nota: 80, problemas: [], sugestoes: [] },
    atributosAdicionais: [],
    fotosAnalisadas: [{ imagemId: "img1", ordem: 1, principal: true }],
    metadadosAnalise: { totalFotosProjeto: 1, totalFotosAnalisadas: 1, analiseParcial: false, motivoAnaliseParcial: null },
    ...overrides,
  };
}

function saidaMinima(): GeracaoConteudoIA {
  return {
    tituloBase: { texto: "Título de teste", fatoIds: ["F1"] },
    descricaoCurta: { texto: "Descrição curta de teste", contemRessalva: false, fatoIds: ["F1"] },
  };
}

function entradaMinima(): EntradaSeguraGeracaoConteudo {
  return {
    fatosPermitidos: [{ id: "F1", campoOrigem: "produtoIdentificado", valor: "Produto X", origem: "produto" }],
    descricoesComRessalva: [{ id: "R1", campoOrigem: "materiais", valor: "aparência de metal", origem: "produto" }],
    informacoesProibidas: [],
    contextoPromocional: [],
    alertas: [],
    fatosAfetadosPorAlerta: [],
  };
}

console.log("=== CATEGORIA 1 — Registry ===");

teste("resolverHandler(analise_visual) retorna handlerAnaliseVisual", () => {
  assert(resolverHandler("analise_visual") === handlerAnaliseVisual, "handler diferente do esperado");
});
teste("resolverHandler(geracao_conteudo) retorna handlerGeracaoConteudo", () => {
  assert(resolverHandler("geracao_conteudo") === handlerGeracaoConteudo, "handler diferente do esperado");
});
teste("resolverHandler(ping) retorna handlerFakeGenerico", () => {
  assert(resolverHandler("ping") === handlerFakeGenerico, "handler diferente do esperado");
});
// AJUSTE (2026-08-14): comparava dois nomes fixos de etapa fake, e
// revisao_claude deixou de ser fake. Passa a comparar duas etapas
// quaisquer do conjunto real — a invariante é o compartilhamento do
// objeto, não quais etapas específicas o compartilham.
teste("todas as etapas fake compartilham o MESMO objeto handler", () => {
  const etapas = [...ETAPAS_FAKE_GENERICAS];
  // AJUSTE (2026-08-17): exigia >= 2 etapas fake, e com a promocao de
  // calculo_score restou so "ping". A invariante e "TODA etapa fake
  // resolve para o MESMO objeto handler" — verdadeira para qualquer
  // tamanho >= 1, e nao volta a quebrar em promocoes futuras.
  assert(etapas.length >= 1, "conjunto fake nao pode ficar vazio nesta fase");
  const primeiro = resolverHandler(etapas[0]);
  for (const e of etapas) assert(resolverHandler(e) === primeiro, `"${e}" não compartilha o handler`);
});
teste("resolverHandler(etapa_inexistente) retorna undefined", () => {
  assert(resolverHandler("etapa_inexistente") === undefined, "deveria ser undefined");
});
// AJUSTE (2026-08-13): estas duas asserções fixavam as CONTAGENS de cada
// conjunto (2 e 6). Toda etapa promovida a handler específico quebrava
// as duas, sem que nada de fato tivesse regredido — foi o que aconteceu
// ao promover adaptacao_marketplace. Passam a verificar a INVARIANTE
// real (pertinência e ausência de sobreposição), que é o que os
// conjuntos precisam garantir; a contagem é consequência, não regra.
teste("HANDLERS_ESPECIFICOS contém geracao_conteudo e nunca sobrepõe o conjunto fake", () => {
  assert("geracao_conteudo" in HANDLERS_ESPECIFICOS, "geracao_conteudo deveria ter handler específico");
  for (const etapa of Object.keys(HANDLERS_ESPECIFICOS)) {
    assert(!ETAPAS_FAKE_GENERICAS.has(etapa), `etapa "${etapa}" está nos dois conjuntos`);
  }
});
// AJUSTE (2026-08-14): a lista fixa de etapas fake quebrava a cada
// promoção (foi o que aconteceu com revisao_claude). Passa a derivar do
// conjunto real — a invariante é "toda etapa do conjunto fake resolve
// para o handler compartilhado", não "estas cinco etapas são fake".
teste("ETAPAS_FAKE_GENERICAS não contém geracao_conteudo e todas resolvem para o fake genérico", () => {
  assert(!ETAPAS_FAKE_GENERICAS.has("geracao_conteudo"), "geracao_conteudo não deveria estar aqui");
  assert(ETAPAS_FAKE_GENERICAS.size > 0, "conjunto fake não pode ficar vazio");
  for (const etapa of ETAPAS_FAKE_GENERICAS) {
    const h = resolverHandler(etapa);
    assert(!!h && h.etapa === "*", `etapa "${etapa}" deveria usar o handler fake genérico`);
  }
});
teste("handlerAnaliseVisual.provedoresPermitidos contém fake e google", () => {
  assert(handlerAnaliseVisual.provedoresPermitidos.includes("fake"), "falta fake");
  assert(handlerAnaliseVisual.provedoresPermitidos.includes("google"), "falta google");
});
teste("handlerGeracaoConteudo.provedoresPermitidos contém fake e google", () => {
  assert(handlerGeracaoConteudo.provedoresPermitidos.includes("fake"), "falta fake");
  assert(handlerGeracaoConteudo.provedoresPermitidos.includes("google"), "falta google");
});
teste("handlerGeracaoConteudo.versaoSaida === SCHEMA_VERSAO_GERACAO_CONTEUDO", () => {
  assert(handlerGeracaoConteudo.versaoSaida === SCHEMA_VERSAO_GERACAO_CONTEUDO, "versão diferente");
});
teste("handlerGeracaoConteudo.dependencia === job_origem_id", () => {
  assert(handlerGeracaoConteudo.dependencia === "job_origem_id", "dependência diferente");
});

console.log("\n=== CATEGORIA 2 — Classificação B/C/D e roteamento por origem ===");

teste("produtoIdentificado sem hedge vira fatoPermitido", () => {
  const e = montarEntradaSeguraGeracaoConteudo(baseAnalise({ produtoIdentificado: "Rolo facial de jade" }));
  assert(e.fatosPermitidos.some(f => f.valor === "Rolo facial de jade" && f.campoOrigem === "produtoIdentificado"), "fato não encontrado");
});
teste("produtoIdentificado null não gera fato", () => {
  const e = montarEntradaSeguraGeracaoConteudo(baseAnalise({ produtoIdentificado: null }));
  assert(e.fatosPermitidos.length === 0 && e.descricoesComRessalva.length === 0, "não deveria gerar fato");
});
teste("marca com hedge vira descricaoComRessalva, não fatoPermitido", () => {
  const e = montarEntradaSeguraGeracaoConteudo(baseAnalise({ marca: "aparência de marca X" }));
  assert(e.descricoesComRessalva.some(f => f.campoOrigem === "marca"), "não caiu em descricoesComRessalva");
  assert(!e.fatosPermitidos.some(f => f.campoOrigem === "marca"), "não deveria estar em fatosPermitidos");
});
teste("categoriaProvavel vira string única com ' > '", () => {
  const e = montarEntradaSeguraGeracaoConteudo(baseAnalise({ categoriaProvavel: ["Beleza", "Cuidados com a Pele"] }));
  assert(e.fatosPermitidos.some(f => f.valor === "Beleza > Cuidados com a Pele"), "serialização incorreta");
});
teste("quantidadeDeclarada usa textoOrigem, nunca o número", () => {
  const e = montarEntradaSeguraGeracaoConteudo(baseAnalise({ quantidadeDeclarada: { valor: 3, textoOrigem: "contém 3 unidades" } }));
  assert(e.fatosPermitidos.some(f => f.valor === "contém 3 unidades" && f.campoOrigem === "quantidadeDeclarada"), "valor incorreto");
  assert(!e.fatosPermitidos.some(f => f.valor === "3"), "não deveria usar o número");
});
teste("quantidadeDeclarada ambos null não gera fato", () => {
  const e = montarEntradaSeguraGeracaoConteudo(baseAnalise({ quantidadeDeclarada: { valor: null, textoOrigem: null } }));
  assert(!e.fatosPermitidos.some(f => f.campoOrigem === "quantidadeDeclarada"), "não deveria gerar fato");
});
teste("cores origem=produto sem hedge vira fatoPermitido", () => {
  const e = montarEntradaSeguraGeracaoConteudo(baseAnalise({ cores: [{ valor: "verde jade", origem: "produto" }] }));
  assert(e.fatosPermitidos.some(f => f.campoOrigem === "cores" && f.valor === "verde jade"), "não encontrado");
});
teste("cores origem=embalagem_fisica vai para informacoesProibidas, nunca fatosPermitidos/descricoesComRessalva", () => {
  const e = montarEntradaSeguraGeracaoConteudo(baseAnalise({ cores: [{ valor: "azul embalagem", origem: "embalagem_fisica" }] }));
  assert(e.informacoesProibidas.includes("azul embalagem"), "não está em informacoesProibidas");
  assert(!e.fatosPermitidos.some(f => f.valor === "azul embalagem"), "não deveria estar em fatosPermitidos");
  assert(!e.descricoesComRessalva.some(f => f.valor === "azul embalagem"), "não deveria estar em descricoesComRessalva");
});
teste("item origem=material_promocional vai para contextoPromocional", () => {
  const e = montarEntradaSeguraGeracaoConteudo(baseAnalise({ possiveisUsos: [{ descricao: "melhora a circulação", origem: "material_promocional" }] }));
  assert(e.contextoPromocional.includes("melhora a circulação"), "não está em contextoPromocional");
  assert(!e.fatosPermitidos.some(f => f.valor === "melhora a circulação"), "não deveria estar em fatosPermitidos");
});
teste("item origem=indeterminado vai para informacoesProibidas", () => {
  const e = montarEntradaSeguraGeracaoConteudo(baseAnalise({ textosLegiveis: [{ texto: "texto ilegível", origem: "indeterminado" }] }));
  assert(e.informacoesProibidas.includes("texto ilegível"), "não está em informacoesProibidas");
});
teste("campo mencionado em informacoesNaoConfirmadas vira D (informacoesProibidas), mesmo sem hedge", () => {
  const e = montarEntradaSeguraGeracaoConteudo(baseAnalise({ marca: "Nike", informacoesNaoConfirmadas: ["marca não confirmada visualmente"] }));
  assert(e.informacoesProibidas.includes("Nike"), "deveria estar em informacoesProibidas (D)");
  assert(!e.fatosPermitidos.some(f => f.campoOrigem === "marca"), "não deveria estar em fatosPermitidos");
  assert(!e.descricoesComRessalva.some(f => f.campoOrigem === "marca"), "não deveria estar em descricoesComRessalva");
});
teste("informacoesNaoConfirmadas passthrough literal", () => {
  const e = montarEntradaSeguraGeracaoConteudo(baseAnalise({ informacoesNaoConfirmadas: ["nenhum texto legível na embalagem"] }));
  assert(e.informacoesProibidas.includes("nenhum texto legível na embalagem"), "passthrough falhou");
});
teste("alertas passthrough", () => {
  const e = montarEntradaSeguraGeracaoConteudo(baseAnalise({ alertas: ["cor pode variar entre unidades"] }));
  assert(e.alertas.includes("cor pode variar entre unidades"), "alertas não propagados");
});
teste("atributosAdicionais origem=produto vira fatoPermitido (só valor, sem nome)", () => {
  const e = montarEntradaSeguraGeracaoConteudo(baseAnalise({ atributosAdicionais: [{ nome: "Autonomia", valor: "76H", origem: "produto" }] }));
  assert(e.fatosPermitidos.some(f => f.campoOrigem === "atributosAdicionais" && f.valor === "76H"), "não encontrado");
});
teste("publicoProvavel origem=produto vira fatoPermitido (confirma inclusão de publicoProvavel em CampoOrigem)", () => {
  const e = montarEntradaSeguraGeracaoConteudo(baseAnalise({ publicoProvavel: [{ descricao: "praticantes de skincare", origem: "produto" }] }));
  assert(e.fatosPermitidos.some(f => f.campoOrigem === "publicoProvavel"), "publicoProvavel não classificado como fato");
});
teste("publicoProvavel origem=indeterminado vira informacoesProibidas (cenário real da seção 7 do contrato)", () => {
  const e = montarEntradaSeguraGeracaoConteudo(baseAnalise({ publicoProvavel: [{ descricao: "público geral", origem: "indeterminado" }] }));
  assert(e.informacoesProibidas.includes("público geral"), "não caiu em informacoesProibidas");
});

console.log("\n=== CATEGORIA 3 — Efeito de alertas (V2, seção 6) ===");

teste("alerta de divergência de cor rebaixa item de cores (B->C) e registra fatoAfetadoPorAlerta", () => {
  const e = montarEntradaSeguraGeracaoConteudo(
    baseAnalise({ cores: [{ valor: "verde", origem: "produto" }], alertas: ["Divergência de cor entre as fotos"] })
  );
  assert(!e.fatosPermitidos.some(f => f.campoOrigem === "cores"), "não deveria continuar em fatosPermitidos");
  assert(e.descricoesComRessalva.some(f => f.campoOrigem === "cores"), "deveria ter sido rebaixado para descricoesComRessalva");
  assert(e.fatosAfetadosPorAlerta.some(a => a.campoOrigem === "cores" && a.efeito === "rebaixado"), "fatoAfetadoPorAlerta não registrado");
});
teste("alerta de quantidade divergente exclui quantidadeDeclarada inteiramente (não rebaixa)", () => {
  const e = montarEntradaSeguraGeracaoConteudo(
    baseAnalise({ quantidadeDeclarada: { valor: 2, textoOrigem: "contém 2 unidades" }, alertas: ["Quantidade observada diverge do declarado"] })
  );
  assert(!e.fatosPermitidos.some(f => f.campoOrigem === "quantidadeDeclarada"), "não deveria estar em fatosPermitidos");
  assert(!e.descricoesComRessalva.some(f => f.campoOrigem === "quantidadeDeclarada"), "não deveria ter sido rebaixado, e sim excluído");
  assert(e.fatosAfetadosPorAlerta.some(a => a.campoOrigem === "quantidadeDeclarada" && a.efeito === "excluido"), "fatoAfetadoPorAlerta não registrado como excluido");
});
teste("alerta de possível produto diferente entre imagens lança validation (severidade própria)", () => {
  assertLanca(() => montarEntradaSeguraGeracaoConteudo(baseAnalise({ alertas: ["Possível produto diferente entre as imagens enviadas"] })), "validation");
});

console.log("\n=== CATEGORIA 4 — Atribuição de IDs ===");

teste("fatosPermitidos recebem IDs sequenciais F1,F2,F3", () => {
  const e = montarEntradaSeguraGeracaoConteudo(
    baseAnalise({ produtoIdentificado: "A", marca: "B", categoriaProvavel: ["C"] })
  );
  const ids = e.fatosPermitidos.map(f => f.id).sort();
  assert(JSON.stringify(ids) === JSON.stringify(["F1", "F2", "F3"]), `ids: ${ids.join(",")}`);
});
teste("descricoesComRessalva recebem IDs sequenciais R1,R2", () => {
  const e = montarEntradaSeguraGeracaoConteudo(
    baseAnalise({ cores: [{ valor: "aparência de dourado", origem: "produto" }], materiais: [{ valor: "parece plástico", origem: "produto" }] })
  );
  const ids = e.descricoesComRessalva.map(f => f.id).sort();
  assert(JSON.stringify(ids) === JSON.stringify(["R1", "R2"]), `ids: ${ids.join(",")}`);
});
teste("IDs recomeçam em F1/R1 a cada chamada independente (escopo por envelope, contrato seção 2)", () => {
  const e1 = montarEntradaSeguraGeracaoConteudo(baseAnalise({ produtoIdentificado: "X" }));
  const e2 = montarEntradaSeguraGeracaoConteudo(baseAnalise({ produtoIdentificado: "Y" }));
  assert(e1.fatosPermitidos[0].id === "F1" && e2.fatosPermitidos[0].id === "F1", "IDs deveriam recomeçar");
});

console.log("\n=== CATEGORIA 5 — validarEstruturaGeracaoConteudo ===");

teste("saida mínima válida é aceita", () => {
  const r = validarEstruturaGeracaoConteudo(saidaMinima());
  assert(r.tituloBase.texto === "Título de teste", "não retornou o objeto esperado");
});
teste("tituloBase ausente lança validation", () => {
  const s: any = saidaMinima();
  delete s.tituloBase;
  assertLanca(() => validarEstruturaGeracaoConteudo(s), "validation");
});
teste("tituloBase.texto vazio lança validation", () => {
  const s: any = saidaMinima();
  s.tituloBase.texto = "";
  assertLanca(() => validarEstruturaGeracaoConteudo(s), "validation");
});
teste("tituloBase.fatoIds vazio lança validation", () => {
  const s: any = saidaMinima();
  s.tituloBase.fatoIds = [];
  assertLanca(() => validarEstruturaGeracaoConteudo(s), "validation");
});
teste("descricaoCurta sem contemRessalva lança validation", () => {
  const s: any = saidaMinima();
  delete s.descricaoCurta.contemRessalva;
  assertLanca(() => validarEstruturaGeracaoConteudo(s), "validation");
});
teste("propriedade extra na raiz lança validation", () => {
  const s: any = saidaMinima();
  s.campoInventado = "x";
  assertLanca(() => validarEstruturaGeracaoConteudo(s), "validation");
});
teste("bullets presente mas não-array lança validation", () => {
  const s: any = saidaMinima();
  s.bullets = "não é array";
  assertLanca(() => validarEstruturaGeracaoConteudo(s), "validation");
});
teste("bullets[0] com propriedade extra lança validation", () => {
  const s: any = saidaMinima();
  s.bullets = [{ texto: "x", contemRessalva: false, fatoIds: ["F1"], extra: 1 }];
  assertLanca(() => validarEstruturaGeracaoConteudo(s), "validation");
});
teste("especificacoes[0] sem fatoId lança validation", () => {
  const s: any = saidaMinima();
  s.especificacoes = [{ nome: "Peso", valor: "100g" }];
  assertLanca(() => validarEstruturaGeracaoConteudo(s), "validation");
});
teste("publicoSugerido válido é aceito", () => {
  const s: any = saidaMinima();
  s.publicoSugerido = { texto: "indicado para...", fatoIds: ["F1"] };
  const r = validarEstruturaGeracaoConteudo(s);
  assert(r.publicoSugerido?.texto === "indicado para...", "não retornou publicoSugerido");
});
teste("resposta que não é objeto lança validation", () => {
  assertLanca(() => validarEstruturaGeracaoConteudo("string qualquer"), "validation");
});

console.log("\n=== CATEGORIA 6 — validarIntegridadeFatoIds (contrato, seção 2.1) ===");

teste("saida consistente com entrada é válida", () => {
  const r = validarIntegridadeFatoIds(saidaMinima(), entradaMinima());
  assert(r.valido === true, r.motivo ?? "deveria ser válido");
});
teste("tituloBase.fatoIds cita ID inexistente é inválido", () => {
  const s = saidaMinima();
  s.tituloBase.fatoIds = ["F99"];
  const r = validarIntegridadeFatoIds(s, entradaMinima());
  assert(r.valido === false, "deveria ser inválido");
});
teste("tituloBase.fatoIds citando R* é inválido (só aceita F*)", () => {
  const s = saidaMinima();
  s.tituloBase.fatoIds = ["R1"];
  const r = validarIntegridadeFatoIds(s, entradaMinima());
  assert(r.valido === false, "deveria ser inválido");
});
teste("especificacoes[].fatoId citando R* é inválido", () => {
  const s = saidaMinima();
  s.especificacoes = [{ nome: "Material", valor: "metal", fatoId: "R1" }];
  const r = validarIntegridadeFatoIds(s, entradaMinima());
  assert(r.valido === false, "deveria ser inválido");
});
teste("descricaoCurta contemRessalva=false citando R* é inválido", () => {
  const s = saidaMinima();
  s.descricaoCurta = { texto: "x", contemRessalva: false, fatoIds: ["F1", "R1"] };
  const r = validarIntegridadeFatoIds(s, entradaMinima());
  assert(r.valido === false, "deveria ser inválido");
});
teste("descricaoCurta citando R* com contemRessalva=true é válido", () => {
  const s = saidaMinima();
  s.descricaoCurta = { texto: "x", contemRessalva: true, fatoIds: ["F1", "R1"] };
  const r = validarIntegridadeFatoIds(s, entradaMinima());
  assert(r.valido === true, r.motivo ?? "deveria ser válido");
});
teste("descricaoCurta citando R* com contemRessalva=false é inválido (regra inversa)", () => {
  const s = saidaMinima();
  s.descricaoCurta = { texto: "x", contemRessalva: false, fatoIds: ["R1"] };
  const r = validarIntegridadeFatoIds(s, entradaMinima());
  assert(r.valido === false, "deveria ser inválido");
});
teste("campo com fatoIds vazio é inválido (mesma severidade de ID inexistente)", () => {
  const s = saidaMinima();
  s.tituloBase.fatoIds = [];
  const r = validarIntegridadeFatoIds(s, entradaMinima());
  assert(r.valido === false, "deveria ser inválido");
});
teste("dois bullets sem nenhum fatoId exclusivo é inválido", () => {
  const s = saidaMinima();
  s.bullets = [
    { texto: "b1", contemRessalva: false, fatoIds: ["F1"] },
    { texto: "b2", contemRessalva: false, fatoIds: ["F1"] },
  ];
  const r = validarIntegridadeFatoIds(s, entradaMinima());
  assert(r.valido === false, "deveria ser inválido — nenhum fatoId exclusivo por bullet");
});
teste("dois bullets cada um com fatoId exclusivo é válido", () => {
  const entradaComDoisFatos: EntradaSeguraGeracaoConteudo = {
    ...entradaMinima(),
    fatosPermitidos: [
      { id: "F1", campoOrigem: "produtoIdentificado", valor: "Produto X", origem: "produto" },
      { id: "F2", campoOrigem: "cores", valor: "verde", origem: "produto" },
    ],
  };
  const s = saidaMinima();
  s.bullets = [
    { texto: "b1", contemRessalva: false, fatoIds: ["F1"] },
    { texto: "b2", contemRessalva: false, fatoIds: ["F2"] },
  ];
  const r = validarIntegridadeFatoIds(s, entradaComDoisFatos);
  assert(r.valido === true, r.motivo ?? "deveria ser válido");
});
teste("publicoSugerido citando ID inexistente é inválido", () => {
  const s = saidaMinima();
  s.publicoSugerido = { texto: "x", fatoIds: ["F99"] };
  const r = validarIntegridadeFatoIds(s, entradaMinima());
  assert(r.valido === false, "deveria ser inválido");
});
teste("ID com formato inválido (nem F nem R) é inválido", () => {
  const s = saidaMinima();
  s.tituloBase.fatoIds = ["X1"];
  const r = validarIntegridadeFatoIds(s, entradaMinima());
  assert(r.valido === false, "deveria ser inválido");
});

console.log(`\n=== RESULTADO: ${total - falhas}/${total} passaram ===`);
if (falhas > 0) {
  console.log(`${falhas} FALHA(S)`);
  process.exit(1);
}
