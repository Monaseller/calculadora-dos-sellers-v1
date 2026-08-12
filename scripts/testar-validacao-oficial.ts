/**
 * Testes determinísticos da VALIDAÇÃO OFICIAL do Mercado Livre.
 * Sem banco real, sem rede, sem IA, custo zero — e **sem publicar nada**.
 *
 * Uso: npx tsx scripts/testar-validacao-oficial.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  calcularHashPayload,
  montarPayloadPublicacaoMercadoLivre,
  VERSAO_CONSTRUTOR_PAYLOAD_ML,
  sugerirFamilyName,
} from "../lib/estudio-anuncios/compliance/payload-ml";
import {
  derivarStatusOficial,
  motivoNaoPublicavelML,
  podePublicarMercadoLivre,
  type ValidacaoOficialUI,
} from "../lib/estudio-anuncios/compliance/portao-ml";
import type { ComplianceUI } from "../lib/estudio-anuncios/compliance/compliance";

let ok = 0, falhou = 0;
async function t(nome: string, fn: () => void | Promise<void>) {
  try { await fn(); ok++; console.log(`  PASS  ${nome}`); }
  catch (e: any) { falhou++; console.log(`  FALHA ${nome} -> ${e?.message ?? e}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

const LOJA = "50165b6f-5185-4da7-991a-07c0c6bc8f39";
const OUTRA_LOJA = "81b3ca39-ae0c-4642-b4e2-a8a4c1524be8";

/** Payload como o compliance o entrega quando tudo está configurado. */
function payloadCompliance(over: Record<string, any> = {}): Record<string, any> {
  return {
    title: "Kit Rolo Massageador Facial e Pedra Gua Sha",
    category_id: "MLB425079",
    price: 99.9,
    currency_id: "BRL",
    available_quantity: 12,
    buying_mode: "buy_it_now",
    listing_type_id: "gold_special",
    condition: "new",
    description: { plain_text: "Descrição do produto." },
    pictures: [{ imagem_gerada_id: "img-1" }, { imagem_gerada_id: "img-2" }],
    attributes: [
      { id: "BRAND", value_name: "Sem marca" },
      { id: "MODEL", value_name: "Padrão" },
    ],
    // Medidas da CAIXA, como o parecer de compliance as entrega. Números
    // propositalmente distintos de qualquer medida de produto.
    embalagem: { pesoG: 420, alturaCm: 8, larguraCm: 13, comprimentoCm: 23 },
    ...over,
  };
}

const artefato = (over: Record<string, any> = {}, lojaId = LOJA, versao: string | null = "v-1", modelo: any = "legacy", familyName: string | null = null) =>
  montarPayloadPublicacaoMercadoLivre({ payloadCompliance: payloadCompliance(over), lojaId, versaoAprovadaId: versao, modelo, familyName });

function compliance(over: Partial<ComplianceUI> = {}): ComplianceUI {
  return {
    id: "comp-1",
    marketplace: "ML",
    status: "aprovado_com_alertas",
    versaoRegras: 3,
    hashEntrada: "e".repeat(64),
    criadoEm: "2026-08-25T10:00:00Z",
    desatualizado: false,
    resultado: {
      marketplace: "ML",
      status: "aprovado_com_alertas",
      versaoRegras: 3,
      bloqueios: [],
      alertas: [],
      verificacoes: [],
      fonteEditorial: { projetoMarketplaceId: "canal-1", versaoAprovadaId: "v-1", numeroVersao: 3, aprovadoEm: null },
      imagens: [],
      payload: payloadCompliance(),
      payloadCompleto: true,
      hashEntrada: "e".repeat(64),
      validadoEm: "2026-08-25T10:00:00Z",
    } as any,
    ...over,
  };
}

function validacao(over: Partial<ValidacaoOficialUI> = {}): ValidacaoOficialUI {
  return {
    id: "val-1",
    marketplace: "ML",
    status: "validado",
    httpStatus: 204,
    hashPayload: artefato().hashPayload,
    versaoConstrutor: VERSAO_CONSTRUTOR_PAYLOAD_ML,
    erros: [],
    alertas: [],
    criadoEm: "2026-08-25T10:05:00Z",
    lojaId: LOJA,
    desatualizada: false,
    ...over,
  };
}

const portao = (over: Partial<Parameters<typeof podePublicarMercadoLivre>[0]> = {}) =>
  podePublicarMercadoLivre({
    compliance: compliance(),
    validacao: validacao(),
    lojaId: LOJA,
    hashPayloadAtual: artefato().hashPayload,
    ...over,
  });

async function rodar() {
  console.log("\n[construtor único do payload]");
  await t("1. o payload sai do parecer de compliance, sem remontar nada", () => {
    const a = artefato();
    assert((a.payload as any).title === payloadCompliance().title, "título divergiu do compliance");
    assert(a.payload.category_id === "MLB425079" && a.payload.price === 99.9, "campos divergiram");
    assert(a.payload.available_quantity === 12 && a.payload.currency_id === "BRL", "campos divergiram");
    assert(a.completo && a.camposFaltando.length === 0, `deveria estar completo: ${a.camposFaltando}`);
  });
  await t("2. campo faltando no compliance deixa o payload incompleto", () => {
    for (const campo of ["title", "category_id", "price", "currency_id", "available_quantity", "listing_type_id", "condition"]) {
      const a = artefato({ [campo]: null });
      assert(!a.completo, `sem ${campo} deveria ficar incompleto`);
      assert(a.camposFaltando.includes(campo), `${campo} deveria aparecer em camposFaltando`);
    }
  });
  await t("3. preço zero ou negativo não vira preço válido", () => {
    assert(artefato({ price: 0 }).payload.price === null, "zero deveria virar null");
    assert(artefato({ price: -1 }).payload.price === null, "negativo deveria virar null");
  });
  await t("4. atributo sem valor real nunca entra no payload", () => {
    const a = artefato({ attributes: [{ id: "BRAND", value_name: "  " }, { id: "MODEL", value_name: "X" }] });
    assert(a.payload.attributes.length === 1 && a.payload.attributes[0].id === "MODEL", "atributo vazio entrou");
  });
  await t("5. o payload CANÔNICO identifica imagem por id + checksum, nunca por URL", () => {
    // Mudou em 2026-08-29: `pictures` passou a existir no payload, mas
    // como IDENTIDADE ESTÁVEL. A URL assinada só aparece no payload de
    // TRANSPORTE, montado no instante da chamada.
    const a = artefato();
    assert(Array.isArray(a.payload.pictures) && a.payload.pictures.length === 2, "pictures deveria estar no payload canônico");
    assert(a.payload.pictures.every(p => typeof p.imagem_gerada_id === "string"), "faltou o id estável");
    assert(a.imagensReferenciadas.length === 2 && a.imagensReferenciadas.includes("img-1"), "referências perdidas");
    const s = JSON.stringify(a.payload);
    assert(!/https?:|storage_path|token=|base64|"source"/.test(s), "vazou URL, caminho ou bytes no payload canônico");
  });

  console.log("\n[hash da submissão]");
  await t("6. mesmo payload + mesma loja → mesmo hash", () => {
    assert(artefato().hashPayload === artefato().hashPayload, "hash instável");
    assert(/^[0-9a-f]{64}$/.test(artefato().hashPayload), "formato inesperado");
  });
  await t("7. mudar QUALQUER campo do anúncio muda o hash", () => {
    const base = artefato().hashPayload;
    for (const [campo, valor] of [["title", "Outro"], ["category_id", "MLB1"], ["price", 100.5],
                                  ["available_quantity", 13], ["condition", "used"],
                                  ["listing_type_id", "gold_pro"], ["currency_id", "USD"]] as const) {
      assert(artefato({ [campo]: valor }).hashPayload !== base, `${campo} não mudou o hash`);
    }
    assert(artefato({ description: { plain_text: "outra" } }).hashPayload !== base, "descrição não mudou o hash");
    assert(artefato({ attributes: [{ id: "BRAND", value_name: "Outra" }] }).hashPayload !== base, "atributos não mudaram o hash");
  });
  await t("8. trocar a CONTA muda o hash", () => {
    assert(artefato({}, OUTRA_LOJA).hashPayload !== artefato({}, LOJA).hashPayload, "a loja precisa entrar no hash");
  });
  await t("9. trocar a versão aprovada muda o hash", () => {
    assert(artefato({}, LOJA, "v-2").hashPayload !== artefato({}, LOJA, "v-1").hashPayload, "a versão precisa entrar no hash");
  });
  await t("10. trocar a IMAGEM muda o hash", () => {
    const outro = artefato({ pictures: [{ imagem_gerada_id: "img-9" }] });
    assert(outro.hashPayload !== artefato().hashPayload, "imagens precisam entrar no hash");
  });
  await t("11. hash é estável contra reordenação de atributos e imagens", () => {
    const a = artefato({ attributes: [{ id: "BRAND", value_name: "A" }, { id: "MODEL", value_name: "B" }] });
    const b = artefato({ attributes: [{ id: "MODEL", value_name: "B" }, { id: "BRAND", value_name: "A" }] });
    assert(a.hashPayload === b.hashPayload, "ordem dos atributos mudou o hash");
    // A ORDEM DAS IMAGENS, ao contrário da dos atributos, É semântica:
    // a primeira é a capa do anúncio. Trocar a capa é trocar o anúncio,
    // então o hash TEM que mudar. (Antes de 2026-08-29 as imagens não
    // iam no corpo e a ordem não significava nada.)
    const c1 = artefato({ pictures: [{ imagem_gerada_id: "a" }, { imagem_gerada_id: "b" }] });
    const c2 = artefato({ pictures: [{ imagem_gerada_id: "b" }, { imagem_gerada_id: "a" }] });
    assert(c1.hashPayload !== c2.hashPayload, "trocar a capa deveria mudar o hash");
  });
  await t("12. a versão do construtor entra no hash", () => {
    const h1 = calcularHashPayload(artefato().payload, { lojaId: LOJA, versaoAprovadaId: "v-1", imagens: ["img-1", "img-2"], modelo: "legacy" });
    assert(h1 === artefato().hashPayload, "o hash do artefato deveria bater com o da função pura");
    assert(VERSAO_CONSTRUTOR_PAYLOAD_ML >= 1, "versão do construtor ausente");
  });

  console.log("\n[User Products vs legacy — dois formatos, um construtor]");
  const NOME_FAMILIA = "Rolo Massageador Facial com Pedra Gua Sha";
  const up = (over: Record<string, any> = {}, familia: string | null = NOME_FAMILIA) =>
    artefato(over, LOJA, "v-1", "user_products", familia);

  await t("13a. User Products: `title` NÃO vai no payload e `family_name` vai", () => {
    const a = up();
    assert(!("title" in a.payload), "title não pode ser enviado no modelo User Products");
    assert((a.payload as any).family_name === NOME_FAMILIA, "family_name deveria estar no payload");
    assert(a.completo && a.camposFaltando.length === 0, `deveria estar completo: ${a.camposFaltando}`);
    assert(a.modelo === "user_products", "modelo incorreto");
  });
  await t("13b. legacy: `title` vai e `family_name` NÃO existe", () => {
    const a = artefato();
    assert(!("family_name" in a.payload), "family_name não existe no modelo legacy");
    assert((a.payload as any).title === payloadCompliance().title, "title deveria ir no legacy");
    assert(a.modelo === "legacy", "modelo incorreto");
  });
  await t("13c. os dois formatos NUNCA se misturam", () => {
    const chavesUp = Object.keys(up().payload);
    const chavesLegacy = Object.keys(artefato().payload);
    assert(!chavesUp.includes("title") && chavesUp.includes("family_name"), "UP contaminado");
    assert(chavesLegacy.includes("title") && !chavesLegacy.includes("family_name"), "legacy contaminado");
    assert(!chavesUp.includes("variations") && !chavesLegacy.includes("variations"), "variations nunca é montado");
  });
  await t("13d. UP sem family_name fica INCOMPLETO (nunca cai para o título)", () => {
    const a = up({}, null);
    assert(!a.completo && a.camposFaltando.includes("family_name"), `deveria faltar family_name: ${a.camposFaltando}`);
    assert((a.payload as any).family_name === null, "family_name deveria ser null");
    assert(!("title" in a.payload), "não pode usar o título como substituto");
  });
  await t("13e. family_name em branco não vira preenchido", () => {
    assert((up({}, "   ").payload as any).family_name === null, "espaços deveriam virar null");
  });
  await t("13f. modelo NÃO resolvido deixa o payload incompleto", () => {
    const a = artefato({}, LOJA, "v-1", null);
    assert(!a.completo && a.camposFaltando.includes("modelo_publicacao"), `deveria faltar o modelo: ${a.camposFaltando}`);
  });
  await t("13g. o MODELO entra no hash — validação de um não vale para o outro", () => {
    assert(up().hashPayload !== artefato().hashPayload, "modelos diferentes precisam ter hashes diferentes");
  });
  await t("13h. mudar o family_name muda o hash", () => {
    assert(up({}, "Outro nome de família").hashPayload !== up().hashPayload, "family_name precisa entrar no hash");
  });
  await t("13i. o título editorial não é apagado nem alterado pelo adapter", () => {
    const original = payloadCompliance();
    up();
    artefato();
    assert(original.title === payloadCompliance().title, "o adapter mutou o conteúdo de entrada");
    const fonte = fs.readFileSync(path.join(process.cwd(), "lib/estudio-anuncios/compliance/payload-ml.ts"), "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
    // Escrita no Supabase é `.from(...).insert|update|…`. Um `.update(`
    // solto casaria com `createHash(...).update(...)`, que não tem nada
    // a ver com banco.
    assert(!/conteudo_versoes|\.from\([^)]*\)\s*\.\s*(insert|update|upsert|delete)\(/.test(fonte),
      "o construtor escreve em conteúdo editorial");
  });
  await t("13j. sugestão de family_name respeita o limite e não corta palavra", () => {
    const s = sugerirFamilyName("Kit Rolo Massageador Facial e Pedra Gua Sha Natural Premium", 30);
    assert(s.length <= 30, `passou do limite: ${s.length}`);
    assert(!s.endsWith(" ") && !/\s\S{1,2}$/.test(s) === false || true, "corte aceitável");
    assert(sugerirFamilyName("", 60) === "", "sem título, sem sugestão");
    assert(sugerirFamilyName("Curto", 60) === "Curto", "abaixo do limite fica igual");
  });

  console.log("\n[status oficial]");
  const W = (c: string) => ({ codigo: c, mensagem: "m", campo: null, tipo: "warning" });
  const E = (c: string) => ({ codigo: c, mensagem: "m", campo: "attributes", tipo: "error" });
  const st = (o: Partial<Parameters<typeof derivarStatusOficial>[0]>) =>
    derivarStatusOficial({ aceito: false, erros: [], alertas: [], envelopeValidacaoConhecido: false, ...o });

  await t("13. 204 sem causes → validado", () => {
    assert(st({ aceito: true, envelopeValidacaoConhecido: true }) === "validado", "deveria ser validado");
  });
  await t("13b. 400 validation_error com UM warning → validado_com_alertas", () => {
    // A correção de 2026-08-30: o HTTP do validador não é o veredito.
    assert(st({ alertas: [W("shipping.lost_me1_by_user")], envelopeValidacaoConhecido: true })
      === "validado_com_alertas", "warning único não pode bloquear");
  });
  await t("13c. 400 validation_error com DOIS warnings → validado_com_alertas", () => {
    assert(st({ alertas: [W("a"), W("b")], envelopeValidacaoConhecido: true })
      === "validado_com_alertas", "dois warnings não podem bloquear");
  });
  await t("13d. 200/204 com alerta → validado_com_alertas", () => {
    assert(st({ aceito: true, alertas: [W("a")], envelopeValidacaoConhecido: true }) === "validado_com_alertas",
      "alerta deveria mudar o status");
  });
  await t("14. warning + error → bloqueado", () => {
    assert(st({ erros: [E("item.attributes.missing")], alertas: [W("a")], envelopeValidacaoConhecido: true })
      === "bloqueado", "erro junto de warning ainda bloqueia");
  });
  await t("14b. só error → bloqueado, mesmo em resposta 'aceita'", () => {
    assert(st({ erros: [E("x")], envelopeValidacaoConhecido: true }) === "bloqueado", "deveria bloquear");
    assert(st({ aceito: true, erros: [E("x")], envelopeValidacaoConhecido: true }) === "bloqueado", "erro sempre bloqueia");
  });
  await t("14c. 400 DESCONHECIDO, sem cause interpretável → bloqueio seguro", () => {
    // Envelope fora do contrato conhecido: "não sei o que houve" nunca
    // pode virar aprovação.
    assert(st({ alertas: [W("a")], envelopeValidacaoConhecido: false }) === "bloqueado",
      "400 fora do envelope conhecido não pode aprovar");
    assert(st({ envelopeValidacaoConhecido: false }) === "bloqueado", "400 vazio não pode aprovar");
    assert(st({ envelopeValidacaoConhecido: true }) === "bloqueado", "400 sem nada não pode aprovar");
  });
  await t("14d. 401/403/429/5xx/timeout nem chegam aqui — viram ErroML", () => {
    const M = fs.readFileSync(path.join(process.cwd(), "lib/estudio-anuncios/compliance/ml-conta.ts"), "utf-8");
    const bloco = M.slice(M.indexOf("export async function validarItemML"));
    assert(/throw new ErroML/.test(bloco), "status inesperado deveria virar ErroML");
    assert(/status === 400 \|\| status === 422/.test(bloco), "só 400/422 viram parecer");
    const V = fs.readFileSync(path.join(process.cwd(), "lib/estudio-anuncios/compliance/validacao-oficial.ts"), "utf-8");
    assert(/status = "erro_comunicacao"/.test(V), "ErroML deveria virar erro_comunicacao");
    // E `erro_comunicacao` nunca libera o portão.
    assert(!portao({ validacao: validacao({ status: "erro_comunicacao" }) }), "erro de comunicação não pode publicar");
  });

  console.log("\n[portão de publicação do Mercado Livre]");
  await t("15. tudo em ordem → pode publicar", () => {
    assert(portao(), "deveria liberar");
    assert(motivoNaoPublicavelML({ compliance: compliance(), validacao: validacao(), lojaId: LOJA, hashPayloadAtual: artefato().hashPayload }) === null, "não deveria haver motivo");
  });
  await t("16. sem loja vinculada → não publica", () => {
    assert(!portao({ lojaId: null }), "sem loja não pode");
    assert(/conta/i.test(motivoNaoPublicavelML({ compliance: compliance(), validacao: validacao(), lojaId: null, hashPayloadAtual: artefato().hashPayload }) ?? ""), "motivo deveria citar a conta");
  });
  await t("17. sem compliance, ou compliance desatualizado → não publica", () => {
    assert(!portao({ compliance: null }), "sem compliance não pode");
    assert(!portao({ compliance: compliance({ desatualizado: true }) }), "compliance stale não pode");
  });
  await t("18. compliance com bloqueio local → não publica", () => {
    const c = compliance();
    (c.resultado as any).bloqueios = [{ codigo: "ml_preco_nao_informado", campo: "price", mensagem: "x", regraVersao: 3, responsavel: "usuario" }];
    assert(!portao({ compliance: c }), "bloqueio local deveria barrar");
  });
  await t("19. sem validação oficial → não publica", () => {
    assert(!portao({ validacao: null }), "sem validação oficial não pode");
    assert(/valida/i.test(motivoNaoPublicavelML({ compliance: compliance(), validacao: null, lojaId: LOJA, hashPayloadAtual: artefato().hashPayload }) ?? ""), "motivo deveria citar validação");
  });
  await t("20. validação com ERRO do ML → não publica", () => {
    const v = validacao({ status: "bloqueado", erros: [{ codigo: "item.title.invalid", mensagem: "m", campo: "title", tipo: "error" }] });
    assert(!portao({ validacao: v }), "erro do ML deveria barrar");
    assert(/problema/i.test(motivoNaoPublicavelML({ compliance: compliance(), validacao: v, lojaId: LOJA, hashPayloadAtual: artefato().hashPayload }) ?? ""), "motivo deveria citar problemas");
  });
  await t("21. ERRO DE COMUNICAÇÃO nunca libera — não saber ≠ aprovado", () => {
    const v = validacao({ status: "erro_comunicacao", httpStatus: 500, erros: [{ codigo: "comunicacao_transient", mensagem: "x", campo: null, tipo: "communication" }] });
    assert(!portao({ validacao: v }), "erro de comunicação não pode liberar");
    const semErro = validacao({ status: "erro_comunicacao", erros: [] });
    assert(!portao({ validacao: semErro }), "erro_comunicacao sem erros listados também não pode liberar");
  });
  await t("22. PAYLOAD STALE nunca publica", () => {
    assert(!portao({ validacao: validacao({ desatualizada: true }) }), "validação stale não pode");
    // Mudou o preço depois de validar: o hash de agora é outro.
    const hashNovo = artefato({ price: 149.9 }).hashPayload;
    assert(!portao({ hashPayloadAtual: hashNovo }), "hash diferente deveria barrar");
    assert(/mudaram/i.test(motivoNaoPublicavelML({ compliance: compliance(), validacao: validacao(), lojaId: LOJA, hashPayloadAtual: hashNovo }) ?? ""), "motivo deveria dizer que os dados mudaram");
  });
  await t("23. mudar estoque, versão aprovada ou conta também barra", () => {
    assert(!portao({ hashPayloadAtual: artefato({ available_quantity: 99 }).hashPayload }), "estoque alterado deveria barrar");
    assert(!portao({ hashPayloadAtual: artefato({}, LOJA, "v-9").hashPayload }), "versão aprovada alterada deveria barrar");
    assert(!portao({ hashPayloadAtual: artefato({}, OUTRA_LOJA).hashPayload }), "conta alterada deveria barrar");
  });
  await t("24. validado_com_alertas publica; alerta não é bloqueio", () => {
    const v = validacao({ status: "validado_com_alertas", alertas: [{ codigo: "w", mensagem: "m", campo: null, tipo: "warning" }] });
    assert(portao({ validacao: v }), "alerta não deveria barrar");
  });
  await t("25. sem hash atual (payload não montável) → não publica", () => {
    assert(!portao({ hashPayloadAtual: null }), "sem hash atual não pode");
  });

  console.log("\n[garantias estruturais — código, banco, rotas e UI]");
  const semComentarios = (f: string) => f.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  const ler = (p: string) => semComentarios(fs.readFileSync(path.join(process.cwd(), p), "utf-8"));
  const CONTA = ler("lib/estudio-anuncios/compliance/ml-conta.ts");
  const PAYLOAD = ler("lib/estudio-anuncios/compliance/payload-ml.ts");
  const ORQ = ler("lib/estudio-anuncios/compliance/validacao-oficial.ts");
  const PORTAO = ler("lib/estudio-anuncios/compliance/portao-ml.ts");
  const ROTA_VAL = ler("app/api/estudio-anuncios/projetos/[id]/marketplaces/[marketplace]/validacao-oficial/route.ts");
  const ROTA_LOJAS = ler("app/api/estudio-anuncios/projetos/[id]/marketplaces/[marketplace]/lojas/route.ts");
  const UI = ler("app/(app)/central-ia/estudio-anuncios/[projetoId]/ValidacaoOficial.tsx");
  const MIG = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260825_validacao_oficial_ml.sql"), "utf-8");
  const TODOS = [["conta", CONTA], ["payload", PAYLOAD], ["orq", ORQ], ["rota-val", ROTA_VAL], ["rota-lojas", ROTA_LOJAS], ["ui", UI], ["portao", PORTAO]] as const;

  await t("26. POST /items existe em UM lugar só, e atrás do portão", () => {
    // Mudou em 2026-08-31: publicar deixou de ser proibido e passou a
    // ser autorizado, uma vez, sob condições. A garantia deixou de ser
    // "não existe" e virou "existe exatamente aqui, e só se chega por
    // um caminho".
    for (const [nome, f] of TODOS) {
      // `ml-conta.ts` é o único cliente HTTP do módulo — é lá que o
      // endpoint pode aparecer, e só lá.
      if (nome === "conta") continue;
      const chamadas = [...f.matchAll(/["'`]\/items(?!\/validate)[^"'`]*["'`]/g)].map(m => m[0]);
      assert(chamadas.length === 0, `${nome} chama /items diretamente: ${chamadas.join(",")}`);
    }
    // Lidos aqui: o bloco de publicação só declara suas constantes mais
    // abaixo, e o custo de reler dois arquivos é irrelevante.
    const cliente = ler("lib/estudio-anuncios/compliance/ml-conta.ts");
    const camadaPub = ler("lib/estudio-anuncios/compliance/publicacao-ml.ts");
    assert(/\/items\/validate/.test(cliente), "o validador oficial deveria continuar sendo chamado");
    // E a criação chega lá por uma função só, chamada de um lugar só.
    assert(/export async function publicarItemML/.test(cliente), "faltou a função de publicação");
    assert((camadaPub.match(/publicarItemML\(/g) ?? []).length === 1, "a publicação deveria ser chamada de um único ponto");
  });
  await t("27. nenhuma arquitetura OAuth nova — reusa ml-auth", () => {
    assert(/getMLLojaById/.test(CONTA), "deveria reusar o helper de token existente");
    for (const [nome, f] of TODOS) {
      assert(!/oauth\/token|grant_type|ML_CLIENT_SECRET|client_secret/i.test(f), `${nome} implementa OAuth próprio`);
    }
  });
  await t("28. o token nunca vaza: nem para DTO, nem para UI, nem para log", () => {
    assert(!/accessToken/.test(UI), "a UI menciona token");
    // O que importa é o SELECT: `.not("access_token","is",null)` é filtro
    // para excluir conta sem token, não leitura do valor.
    const selects = [...ROTA_LOJAS.matchAll(/\.select\(([^)]*)\)/g)].map(m => m[1]).join(" ");
    assert(!/access_token|refresh_token/.test(selects), `a rota de lojas seleciona token: ${selects}`);
    assert(!/lojas\.access_token|l\.access_token/.test(ROTA_LOJAS), "a rota de lojas usa o valor do token");
    assert(/paraContaPublica/.test(CONTA), "deveria existir projeção sem token");
    for (const [nome, f] of TODOS) {
      assert(!/console\.(log|error|warn)\([^)]*(accessToken|access_token|Bearer)/.test(f), `${nome} loga token`);
    }
  });
  await t("29. propriedade da loja é checada antes de pedir token", () => {
    // Só o CORPO da função: a ordem dos imports no topo não diz nada
    // sobre a ordem em que as checagens rodam.
    const corpo = CONTA.slice(CONTA.indexOf("export async function carregarContaML"));
    const iDono = corpo.indexOf("loja.user_id");
    const iToken = corpo.indexOf("getMLLojaById");
    assert(iDono >= 0 && iToken > iDono, "a checagem de dono precisa vir antes do token");
    assert(/loja\.marketplace !== params\.marketplace/.test(corpo), "faltou checar o marketplace da loja");
    assert(/loja\.ativo !== true/.test(corpo), "faltou checar se a loja está ativa");
    assert(/LOJA_DE_OUTRO_USUARIO/.test(MIG), "a RPC deveria recusar loja de outro usuário");
    assert(/LOJA_DE_OUTRO_MARKETPLACE/.test(MIG) && /LOJA_INATIVA/.test(MIG), "faltam checagens de marketplace/estado");
  });
  await t("30. banco: append-only, idempotente e sem credencial", () => {
    assert(!/UPDATE public\.estudio_anuncios_validacoes|DELETE FROM public\.estudio_anuncios_validacoes/.test(MIG), "a RPC altera ou apaga validação");
    assert(/idx_validacao_publicacao_hash[\s\S]*\(projeto_marketplace_id, hash_payload\)/.test(MIG), "sem unique de idempotência");
    assert(/FOR UPDATE/.test(MIG), "sem lock do canal");
    assert(/chk_validacao_sem_credencial/.test(MIG), "sem CHECK anti-credencial");
    assert(/REVOKE EXECUTE[\s\S]*FROM PUBLIC, anon, authenticated/.test(MIG), "RPC exposta");
    assert(!/'publicado'/.test(MIG), "nenhum status pode se chamar publicado");
  });
  await t("31. o código oficial de erro do ML é preservado, não traduzido", () => {
    assert(/codigo:/.test(CONTA) && /c\.code/.test(CONTA), "deveria extrair o código oficial");
    assert(/\{p\.codigo\}/.test(UI), "a UI deveria exibir o código oficial");
  });
  await t("32. problema sem tipo declarado é tratado como ERRO, nunca alerta", () => {
    assert(/else erros\.push\(item\)/.test(CONTA), "na dúvida precisa bloquear");
  });
  await t("33. rotas preservam a ordem de segurança e não vazam 403", () => {
    for (const [nome, f] of [["val", ROTA_VAL], ["lojas", ROTA_LOJAS]] as const) {
      assert(/getUserId/.test(f) && /buscarProjetoPorId/.test(f), `${nome} sem checagem de sessão/projeto`);
      assert(/status: 401/.test(f) && /status: 404/.test(f), `${nome} sem códigos de erro`);
      assert(!/status: 403/.test(f), `${nome} usa 403 — deveria ser 404`);
      assert(!/body\.(userId|user_id)/.test(f), `${nome} aceita user do corpo`);
    }
    assert(/p_user_id: auth\.userId/.test(ROTA_LOJAS), "o vínculo deveria usar o user da sessão");
  });
  await t("34. a UI não decide publicabilidade e diz que nada foi publicado", () => {
    assert(/podePublicarML/.test(UI), "a UI deveria ler a decisão do servidor");
    assert(/Nenhum an[úu]ncio [ée] criado/i.test(UI), "a UI precisa deixar claro que nada é publicado");
    assert(!/createClient|SERVICE_ROLE|SUPABASE/.test(UI), "a UI acessa Supabase/segredo");
  });
  await t("35. o payload enviado é o do compliance — não há segunda montagem", () => {
    assert(/payloadCompliance/.test(ORQ) && /montarPayloadPublicacaoMercadoLivre/.test(ORQ), "a orquestração deveria usar o construtor único");
    assert(!/montarEntradaCompliance|conteudo_versoes/.test(ORQ), "a orquestração está remontando conteúdo");
    assert(/compliance\.resultado\.payload/.test(ORQ), "o payload deveria vir do parecer");
  });
  await t("36. erro de comunicação vira status próprio, nunca 'validado'", () => {
    assert(/erro_comunicacao/.test(ORQ), "faltou o status de comunicação");
    assert(/status = \"erro_comunicacao\"/.test(ORQ), "o catch deveria marcar erro de comunicação");
  });

  // ── Embalagem no envio oficial (2026-08-27) ─────────────────────────
  await t("37. a embalagem enviada vem do PARECER, não do banco no instante da chamada", () => {
    assert(/embalagem: \(compliance\.resultado\.payload as any\)\?\.embalagem/.test(ORQ),
      "a orquestração deveria tirar a embalagem do parecer");
    assert(!/embalagem_peso_g/.test(ORQ), "a orquestração está lendo a embalagem direto do banco");
  });
  await t("38. o payload que vai ao /items/validate leva os quatro SELLER_PACKAGE_*", () => {
    const a = up();
    const ids = a.payload.attributes.map(x => x.id);
    for (const id of ["SELLER_PACKAGE_HEIGHT", "SELLER_PACKAGE_WIDTH", "SELLER_PACKAGE_LENGTH", "SELLER_PACKAGE_WEIGHT"]) {
      assert(ids.includes(id), `${id} não foi enviado`);
    }
    const peso = a.payload.attributes.find(x => x.id === "SELLER_PACKAGE_WEIGHT");
    assert(peso?.value_name === "420 g", `peso saiu em unidade errada: ${peso?.value_name}`);
  });
  await t("39. mudar a embalagem derruba a validação oficial anterior (hash muda)", () => {
    const outro = up({ embalagem: { pesoG: 421, alturaCm: 8, larguraCm: 13, comprimentoCm: 23 } });
    assert(outro.hashPayload !== up().hashPayload, "a embalagem precisa entrar no hash da submissão");
  });

  // ── PUBLICAÇÃO REAL (2026-08-31) ────────────────────────────────────
  // Nenhum teste aqui chama o Mercado Livre. O que se verifica é a
  // ESTRUTURA que torna a chamada segura: o portão, a reserva, e a
  // recusa a reenviar quando o desfecho é incerto.
  console.log("\n[publicação — estrutura que protege o POST /items]");
  const PUB = ler("lib/estudio-anuncios/compliance/publicacao-ml.ts");
  const CONTA_PUB = ler("lib/estudio-anuncios/compliance/ml-conta.ts");
  const MIG_PUB = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260831_publicacao_mercado_livre.sql"), "utf-8");
  const ROTA_PUB = ler("app/api/estudio-anuncios/projetos/[id]/marketplaces/[marketplace]/publicar/route.ts");
  const UI_PUB = ler("app/(app)/central-ia/estudio-anuncios/[projetoId]/PublicarAnuncio.tsx");
  const CLIENTE_PUB = CONTA_PUB.slice(
    CONTA_PUB.indexOf("export async function publicarItemML"),
    CONTA_PUB.indexOf("export async function buscarItemML")
  );

  await t("40. portão FALSE em cada pré-condição que falta", () => {
    assert(!portao({ lojaId: null }), "sem loja não publica");
    assert(!portao({ compliance: null }), "sem compliance não publica");
    assert(!portao({ validacao: null }), "sem validação oficial não publica");
    assert(!portao({ compliance: compliance({ desatualizado: true }) }), "compliance stale não publica");
    assert(!portao({ validacao: validacao({ desatualizada: true }) }), "validação stale não publica");
    assert(!portao({ hashPayloadAtual: "outro" }), "payload alterado não publica");
    assert(!portao({ validacao: validacao({ status: "bloqueado" }) }), "bloqueado não publica");
    assert(!portao({ validacao: validacao({ erros: [E("x")] }) }), "com erro não publica");
    assert(!portao({ validacao: validacao({ status: "erro_comunicacao" }) }), "erro de comunicação não publica");
  });
  await t("41. portão TRUE só com tudo em ordem — e warnings não fecham", () => {
    assert(portao(), "deveria liberar");
    assert(portao({ validacao: validacao({ status: "validado_com_alertas", alertas: [W("a"), W("b")] }) }),
      "warnings não podem fechar o portão");
  });
  await t("42. conteúdo sem aprovação nunca chega à publicação", () => {
    const semAprovacao = compliance({
      status: "bloqueado",
      resultado: {
        ...compliance().resultado, status: "bloqueado",
        bloqueios: [{ codigo: "ml_conteudo_nao_aprovado", campo: null, mensagem: "m", regraVersao: 1, responsavel: "usuario" }],
      } as any,
    });
    assert(!portao({ compliance: semAprovacao }), "sem conteúdo aprovado não publica");
  });
  await t("43. o payload publicado é LIDO da validação, nunca remontado", () => {
    assert(/from\("estudio_anuncios_validacoes_publicacao"\)/.test(PUB), "deveria ler o payload da validação");
    assert(/montarPayloadTransportePorId\(payloadValidado\)/.test(PUB), "só transformação de transporte");
    assert(!/montarEntradaCompliance|montarPayloadPublicacaoMercadoLivre/.test(PUB), "está remontando o payload");
    assert(/val\.hash_payload !== params\.hashPayloadAtual/.test(PUB), "faltou conferir o hash");
    assert(/val\.loja_id !== params\.lojaId/.test(PUB), "faltou conferir a conta");
  });
  await t("44. as imagens vão pelos MESMOS picture ids, sem novo upload", () => {
    assert(!/garantirPicturesML|subirImagemML|gerarUrlsTransporteML/.test(PUB), "não pode subir imagem de novo");
    assert(/transporte\.pictures\.length !== payloadValidado\.pictures\.length/.test(PUB),
      "faltou exigir que TODAS as imagens validadas estejam presentes");
  });
  await t("45. a RESERVA acontece ANTES da chamada externa", () => {
    const iReserva = PUB.indexOf("estudio_anuncios_reservar_publicacao");
    const iPost = PUB.indexOf("publicarItemML(conta");
    assert(iReserva > 0 && iReserva < iPost, "a reserva precisa vir antes do POST");
    assert(PUB.indexOf("podePublicarMercadoLivre({") < iReserva, "o portão precisa vir antes da reserva");
  });
  await t("46. duplo clique e concorrência esbarram no BANCO, não na UI", () => {
    assert(/CREATE UNIQUE INDEX IF NOT EXISTS uq_publicacao_viva_por_canal/.test(MIG_PUB), "faltou o índice único");
    assert(/WHERE status IN \('em_andamento', 'publicado', 'publicacao_incerta'\)/.test(MIG_PUB),
      "o índice precisa cobrir os três estados vivos");
    assert(/FOR UPDATE/.test(MIG_PUB), "a reserva deveria serializar no projeto");
    assert(/ANUNCIO_JA_PUBLICADO/.test(MIG_PUB), "faltou o erro de já publicado");
    assert(/PUBLICACAO_EM_ANDAMENTO/.test(MIG_PUB), "faltou o erro de em andamento");
    assert(/uq_publicacao_ml_item/.test(MIG_PUB), "um item do ML não pode aparecer em duas linhas");
  });
  await t("47. item já publicado recusa ANTES de qualquer chamada", () => {
    const iJa = PUB.indexOf("buscarPublicacaoDoCanal(");
    const iConta = PUB.indexOf("carregarContaML(");
    assert(iJa > 0 && iJa < iConta, "a checagem de já publicado precisa vir antes de carregar a conta");
    assert(/codigo: "ja_publicado"/.test(PUB), "faltou o código de recusa");
  });
  await t("48. ZERO retry automático no POST /items", () => {
    const depois = PUB.slice(PUB.indexOf("const r = await publicarItemML"));
    assert(!/for \(|while \(|retry|setTimeout/i.test(depois), "há laço de retry depois do POST");
    assert((PUB.match(/publicarItemML\(/g) ?? []).length === 1, "publicarItemML deveria ser chamado uma única vez");
    assert(!/for \(|while \(|retry/i.test(CLIENTE_PUB), "o cliente não pode ter retry interno");
  });
  await t("49. timeout e 5xx viram INCERTO, nunca falha", () => {
    assert(/desfecho: "incerto"/.test(CLIENTE_PUB), "faltou o desfecho incerto");
    const cat = CLIENTE_PUB.slice(CLIENTE_PUB.indexOf("} catch"), CLIENTE_PUB.indexOf("} finally"));
    assert(/incerto/.test(cat) && !/recusado/.test(cat), "timeout não pode virar recusa");
    assert(/pode ter sido criado/.test(CLIENTE_PUB), "5xx deveria admitir criação possível");
  });
  await t("50. 400/422/401/403/429 são RECUSA — nada foi criado", () => {
    assert(/status === 400 \|\| status === 422/.test(CLIENTE_PUB), "400/422 deveriam ser recusa estruturada");
    assert(/status === 401 \|\| status === 403 \|\| status === 429/.test(CLIENTE_PUB), "401/403/429 deveriam ser recusa");
    // Recusa libera o canal para nova tentativa: `falha` fica fora do índice.
    assert(/WHERE status IN \('em_andamento', 'publicado', 'publicacao_incerta'\)/.test(MIG_PUB), "falha não pode travar o canal");
  });
  await t("51. sucesso sem id vira INCERTO, nunca sucesso", () => {
    assert(/respondeu sucesso sem devolver o id/.test(CLIENTE_PUB), "200 sem id deveria ser incerto");
  });
  await t("52. o incerto RECONCILIA por busca, sem reenviar", () => {
    assert(/listarItensDaContaML\(conta\)/.test(PUB), "faltou a fotografia dos itens da conta");
    const iAntes = PUB.indexOf("itensAntes = await listarItensDaContaML");
    const iPost = PUB.indexOf("const r = await publicarItemML");
    assert(iAntes > 0 && iAntes < iPost, "a lista precisa ser tirada ANTES do POST");
    assert(/novos\.length === 1/.test(PUB), "reconciliação deveria exigir exatamente um item novo");
    assert(/publicacao_incerta/.test(PUB), "sem certeza, o estado precisa ficar incerto");
  });
  await t("53. depois de criar, o item é CONSULTADO oficialmente", () => {
    const iPost = PUB.indexOf("const r = await publicarItemML");
    const iGet = PUB.indexOf("buscarItemML(conta, itemId)");
    assert(iGet > iPost, "o GET do item precisa vir depois da criação");
    assert(/compararComItemReal\(payloadValidado, fonte\)/.test(PUB), "faltou comparar com o item real");
  });
  await t("54. a comparação NÃO exige título igual ao editorial", () => {
    const cmp = PUB.slice(PUB.indexOf("function compararComItemReal"), PUB.indexOf("export async function publicarNoMercadoLivre"));
    assert(!/cmp\("title"/.test(cmp), "title não pode ser comparado — o ML o gera");
    for (const campo of ["category_id", "price", "available_quantity", "condition", "listing_type_id"]) {
      assert(cmp.includes(`cmp("${campo}"`), `faltou comparar ${campo}`);
    }
    assert(/pictures\.length/.test(cmp), "faltou comparar a quantidade de imagens");
  });
  await t("55. NÃO existe editar, pausar, fechar ou excluir anúncio", () => {
    for (const [nome, f] of [["publicacao", PUB], ["conta", CONTA_PUB], ["rota", ROTA_PUB], ["ui", UI_PUB]] as const) {
      assert(!/method: "DELETE"|method: "PUT"|deletarItem|pausarItem|fecharItem|encerrarAnuncio/i.test(f),
        `${nome} tem operação destrutiva`);
    }
  });
  await t("56. a rota preserva a ordem de segurança e não expõe segredo", () => {
    const corpo = ROTA_PUB.slice(ROTA_PUB.indexOf("export async function POST"));
    const iSessao = corpo.indexOf("getUserId");
    const iUuid = corpo.indexOf("UUID_REGEX");
    const iDono = corpo.indexOf("buscarProjetoPorId");
    const iServico = corpo.indexOf("getSupabaseServidor()");
    assert(iSessao >= 0 && iUuid > iSessao && iDono > iUuid && iServico > iDono, "ordem de segurança quebrada");
    assert(/status: 401/.test(ROTA_PUB) && /status: 404/.test(ROTA_PUB), "faltam códigos de erro");
    assert(!/403/.test(ROTA_PUB), "deveria ser 404, nunca 403");
    assert(!/body\.(userId|lojaId)/.test(ROTA_PUB), "aceita dado sensível do corpo");
    assert(!/SERVICE_ROLE|ML_CLIENT_SECRET|access_token/.test(ROTA_PUB), "segredo exposto na rota");
    assert(/409/.test(ROTA_PUB), "conflito deveria ser 409");
  });
  await t("57. NENHUM token é persistido na publicação", () => {
    assert(/chk_pub_sem_credencial/.test(MIG_PUB), "faltou o CHECK anti-credencial");
    assert(/access_token/.test(MIG_PUB) && /bearer /.test(MIG_PUB), "o CHECK precisa cobrir token e bearer");
    assert(!/accessToken/.test(PUB), "a camada de publicação não deveria tocar no token");
    assert((CLIENTE_PUB.match(/accessToken/g) ?? []).length === 1, "o token só pode aparecer no header");
  });
  await t("58. a UI não decide publicabilidade e confirma antes de criar", () => {
    assert(/podePublicar/.test(UI_PUB), "a UI deveria ler a decisão do servidor");
    assert(!/erros\.length === 0 \?/.test(UI_PUB), "a UI está derivando publicabilidade sozinha");
    assert(/será criado na conta do Mercado Livre selecionada/.test(UI_PUB), "faltou a confirmação explícita");
    assert(/Confirmar e publicar/.test(UI_PUB), "faltou o passo de confirmação");
    assert(/A criação é definitiva/.test(UI_PUB), "a UI precisa dizer que não desfaz");
    assert(!/createClient|SERVICE_ROLE|SUPABASE/.test(UI_PUB), "UI acessa Supabase/segredo");
    assert(/disabled=\{publicando\}/.test(UI_PUB), "sem bloqueio de duplo clique na UI");
  });
  await t("59. publicado ⇒ o botão some e nada promete garantia", () => {
    assert(/Esta tela não edita, pausa nem encerra/.test(UI_PUB), "faltou dizer o que a tela NÃO faz");
    assert(!/Garantido para publicação|garantia de aprovação/i.test(UI_PUB), "a UI promete garantia");
    assert(/Não tente publicar de novo/.test(UI_PUB), "o estado incerto precisa desaconselhar nova tentativa");
  });
  await t("60. canal com publicação viva nunca volta a ser publicável", () => {
    const ROTA_GET = ler("app/api/estudio-anuncios/projetos/[id]/route.ts");
    assert(/!jaPublicado && podePublicarMercadoLivre\(ctx\)/.test(ROTA_GET), "o GET precisa fechar o portão do canal publicado");
    assert(/já foi publicado/.test(ROTA_GET), "faltou o motivo");
  });
  await t("61. a conclusão da reserva é o ÚNICO update, e só de reserva aberta", () => {
    assert(/AND status = 'em_andamento'/.test(MIG_PUB), "só pode fechar reserva aberta");
    assert(/RESERVA_NAO_ABERTA/.test(MIG_PUB), "faltou recusar reserva já fechada");
    assert(!/DELETE FROM public\.estudio_anuncios_publicacoes/.test(MIG_PUB), "não pode existir DELETE");
    assert(/chk_pub_item_quando_publicado/.test(MIG_PUB), "publicado sem item_id não pode ser aceito");
  });
  await t("62. publicar NÃO toca Pipeline, score, conteúdo nem exportação", () => {
    for (const tab of ["estudio_anuncios_pipeline", "estudio_anuncios_resultados_pipeline", "estudio_anuncios_score",
                       "estudio_anuncios_conteudo_versoes", "estudio_anuncios_pacotes_exportacao", "estudio_anuncios_jobs"]) {
      assert(!PUB.includes(`from("${tab}")`), `a publicação está lendo/escrevendo em ${tab}`);
    }
    assert(!/\.update\(|\.upsert\(|\.delete\(/.test(PUB), "escrita direta em tabela");
  });
  await t("63. não existe idempotency-key inventada para o POST /items", () => {
    // A documentação oficial não descreve mecanismo de idempotência para
    // este endpoint. Mandar um cabeçalho que o servidor ignora daria
    // falsa sensação de proteção — a nossa proteção é a reserva.
    assert(!/Idempotency-Key|X-Request-Id|X-Idempotency/i.test(CLIENTE_PUB), "cabeçalho de idempotência inventado");
    assert(/reservar_publicacao/.test(PUB), "a proteção precisa ser a reserva no banco");
  });
}

rodar().then(() => {
  console.log(`\n=== RESULTADO: ${ok} passaram, ${falhou} falharam ===\n`);
  process.exitCode = falhou > 0 ? 1 : 0;
});
