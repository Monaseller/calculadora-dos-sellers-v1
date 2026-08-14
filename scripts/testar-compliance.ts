/**
 * Testes determinísticos da camada de PRÉ-PUBLICAÇÃO. Sem banco real,
 * sem rede, sem IA, custo zero.
 *
 * Uso: npx tsx scripts/testar-compliance.ts
 */
import fs from "node:fs";
import path from "node:path";
import { validarMercadoLivre, CODIGOS_REGRAS_ML } from "../lib/estudio-anuncios/compliance/mercado-livre";
import { REGRAS_ML, TIPOS_ANUNCIO_DOCUMENTADOS_ML, VERSAO_REGRAS_ML, regraML } from "../lib/estudio-anuncios/compliance/regras-mercado-livre";
import { validarConfiguracaoPublicacao } from "../lib/estudio-anuncios/compliance/configuracao-marketplace";
import {
  MOTIVO_NAO_IMPLEMENTADO,
  motivoNaoPublicavel,
  podePublicarMarketplace,
  resultadoNaoImplementado,
  temValidador,
} from "../lib/estudio-anuncios/compliance/registry";
import {
  calcularHashEntrada,
  montarEntradaCompliance,
  validarCompliance,
} from "../lib/estudio-anuncios/compliance/compliance";
import {
  montarAtributosEmbalagem,
  montarPayloadPublicacaoMercadoLivre,
  montarPayloadTransporteML,
  montarPayloadTransportePorId,
} from "../lib/estudio-anuncios/compliance/payload-ml";
import {
  selecionarImagensML,
  TTL_URL_TRANSPORTE_ML_SEGUNDOS,
} from "../lib/estudio-anuncios/compliance/imagens-ml";
import { derivarStatus, resolverMarketplacePorSlug } from "../lib/estudio-anuncios/compliance/tipos";
import type { EntradaCompliance, ResultadoCompliance } from "../lib/estudio-anuncios/compliance/tipos";

let ok = 0, falhou = 0;
async function t(nome: string, fn: () => void | Promise<void>) {
  try { await fn(); ok++; console.log(`  PASS  ${nome}`); }
  catch (e: any) { falhou++; console.log(`  FALHA ${nome} -> ${e?.message ?? e}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

const PROJ = "11111111-1111-1111-1111-111111111111";
const OUTRO = "22222222-2222-2222-2222-222222222222";
const CANAL = "aaaa1111-0000-0000-0000-000000000001";

function imagem(over: any = {}) {
  return {
    imagemGeradaId: "img-1", finalidade: "capa_principal", principal: true, ordem: 1,
    mimeType: "image/jpeg", largura: 1024, altura: 1024, tamanhoBytes: 459049, temArquivo: true,
    // Identidade estável: sha256 dos bytes reais. Aqui é fixo para o
    // teste ser determinístico.
    checksum: "c".repeat(64), ...over,
  };
}

/** Entrada "melhor caso possível hoje": conteúdo aprovado + imagem boa. */
function entrada(over: Partial<EntradaCompliance> = {}): EntradaCompliance {
  return {
    projetoId: PROJ,
    nomeProduto: "Produto de teste",
    marketplace: "ML",
    fonteEditorial: { projetoMarketplaceId: CANAL, versaoAprovadaId: "v-1", numeroVersao: 3, aprovadoEm: "2026-08-20T12:00:00Z" },
    conteudo: { titulo: "Cadeira Gamer Ergonomica Preta", descricao: "Descrição da cadeira.", bullets: ["b1"], especificacoes: [{ nome: "Cor", valor: "Preto" }] },
    imagens: [imagem()],
    ficha: { marca: null, modelo: null, categoriaTexto: "Móveis / Cadeiras", cor: null, material: null, peso: null, unidadePeso: null, medidas: null, quantidadePorEmbalagem: null },
    comercial: { categoriaMarketplaceId: null, precoCentavos: null, moeda: null, estoque: null, condicao: null, tipoAnuncio: null, gtin: null, sku: null },
    logistica: { pesoGramas: null, comprimentoCm: null, larguraCm: null, alturaCm: null },
    embalagem: { pesoG: null, alturaCm: null, larguraCm: null, comprimentoCm: null },
    categoriaMarketplace: null,
    modeloPublicacao: null,
    familyName: null,
    tiposAnuncioDaConta: null,
    atributosInformados: [],
    ...over,
  } as EntradaCompliance;
}

/**
 * Snapshot de categoria com a MESMA forma que a API pública do Mercado
 * Livre devolve (conferida em 2026-08-24 em `/categories/MLB425079`).
 */
function categoria(over: any = {}): EntradaCompliance["categoriaMarketplace"] {
  return {
    id: "MLB425079", nome: "Manuais", caminho: "Beleza e Cuidados Pessoais › Massageadores › Manuais",
    ehFolha: true, verificadaEm: "2026-08-24T10:00:00Z",
    settings: {
      maxTitleLength: 60, maxDescriptionLength: 50000, maxPicturesPerItem: 12,
      currencies: ["BRL"], itemConditions: ["new", "used", "not_specified"],
      buyingModes: ["buy_it_now"], listingAllowed: true, status: "enabled",
      ...(over.settings ?? {}),
    },
    atributosObrigatorios: over.atributosObrigatorios ?? [
      { id: "BRAND", nome: "Marca", condicional: false },
      { id: "MODEL", nome: "Modelo", condicional: false },
    ],
    ...(over.id ? { id: over.id } : {}),
  };
}

/** Entrada completa: todos os dados de publicação configurados. */
function entradaCompleta(over: Partial<EntradaCompliance> = {}): EntradaCompliance {
  const e = entrada(over);
  return {
    ...e,
    ficha: { ...e.ficha!, marca: "Marca X", modelo: "MX-100" },
    // Medidas da CAIXA, deliberadamente diferentes de qualquer medida do
    // produto: se algum dia alguém derivar uma da outra, estes números
    // denunciam.
    embalagem: { pesoG: 420, alturaCm: 8, larguraCm: 13, comprimentoCm: 23 },
    categoriaMarketplace: categoria(),
    // Modelo resolvido da conta: sem ele o payload nao tem formato certo.
    modeloPublicacao: "legacy",
    comercial: {
      categoriaMarketplaceId: "MLB425079", precoCentavos: 19990, moeda: "BRL", estoque: 5,
      condicao: "new", tipoAnuncio: "gold_special", gtin: "7891234567895", sku: "SKU-1",
    },
    atributosInformados: [
      { id: "GTIN", valueId: null, valueName: "7891234567895" },
      { id: "SELLER_SKU", valueId: null, valueName: "SKU-1" },
    ],
    ...over,
  };
}

const val = (e: EntradaCompliance) => validarMercadoLivre(e, "h".repeat(64));
/** `pictures` virou união (`{source}` | `{id}`); os testes do caminho
 *  por URL estreitam aqui, uma vez só. */
const transporteSource = (p: any, m: Map<string, string>) => {
  const t = montarPayloadTransporteML(p, m);
  return { ...t, pictures: t.pictures as { source: string }[] };
};
const temBloqueio = (r: ResultadoCompliance, c: string) => r.bloqueios.some(b => b.codigo === c);
const temAlerta = (r: ResultadoCompliance, c: string) => r.alertas.some(a => a.codigo === c);

async function rodar() {
  console.log("\n[Mercado Livre — conteúdo aprovado]");
  await t("1. conteúdo aprovado é reconhecido e vira verificação ok", () => {
    const r = val(entrada());
    assert(!temBloqueio(r, "ml_conteudo_nao_aprovado"), "não deveria bloquear com versão aprovada");
    assert(r.verificacoes.some(v => v.codigo === "ml_conteudo_aprovado" && v.resultado === "ok"), "faltou verificação de conteúdo");
    assert(r.fonteEditorial?.numeroVersao === 3, "fonte editorial incorreta");
  });
  await t("2. sem versão aprovada → bloqueio, e nada é inventado no lugar", () => {
    const r = val(entrada({ fonteEditorial: null, conteudo: null }));
    assert(temBloqueio(r, "ml_conteudo_nao_aprovado"), "deveria bloquear sem aprovação");
    assert(temBloqueio(r, "ml_titulo_ausente"), "sem conteúdo, o título também falta");
    assert(r.payload?.title === null, "título deveria ser null, nunca preenchido");
    assert(r.status === "bloqueado", r.status);
  });

  console.log("\n[Mercado Livre — título]");
  await t("3. título presente passa; título vazio bloqueia", () => {
    assert(!temBloqueio(val(entrada()), "ml_titulo_ausente"), "título válido não deveria bloquear");
    const r = val(entrada({ conteudo: { titulo: "   ", descricao: "d", bullets: [], especificacoes: [] } }));
    assert(temBloqueio(r, "ml_titulo_ausente"), "título em branco deveria bloquear");
  });
  await t("4. limite de título é NÃO VERIFICÁVEL sem categoria — nunca 'ok'", () => {
    const r = val(entrada());
    const v = r.verificacoes.find(x => x.codigo === "ml_titulo_limite_nao_verificavel");
    assert(v?.resultado === "nao_verificavel", "o limite de título não pode ser dado como ok");
    assert(temAlerta(r, "ml_titulo_limite_nao_verificavel"), "não verificável precisa virar alerta visível");
    const titulao = "x".repeat(500);
    const r2 = val(entrada({ conteudo: { titulo: titulao, descricao: "d", bullets: [], especificacoes: [] } }));
    assert(!temBloqueio(r2, "ml_titulo_limite_nao_verificavel"), "não pode bloquear por limite que não conhecemos");
  });
  await t("5. políticas oficiais de título viram ALERTA, nunca bloqueio", () => {
    const comCondicao = val(entrada({ conteudo: { titulo: "Cadeira Gamer Nova", descricao: "d", bullets: [], especificacoes: [] } }));
    assert(temAlerta(comCondicao, "ml_titulo_menciona_condicao"), "deveria alertar sobre condição no título");
    assert(comCondicao.bloqueios.every(b => b.codigo !== "ml_titulo_menciona_condicao"), "política de título não pode bloquear");

    const comEstoque = val(entrada({ conteudo: { titulo: "Cadeira Gamer Últimas Unidades", descricao: "d", bullets: [], especificacoes: [] } }));
    assert(temAlerta(comEstoque, "ml_titulo_menciona_estoque"), "deveria alertar sobre estoque no título");

    const comFrete = val(entrada({ conteudo: { titulo: "Cadeira Gamer Frete Grátis", descricao: "d", bullets: [], especificacoes: [] } }));
    assert(temAlerta(comFrete, "ml_titulo_menciona_servico"), "deveria alertar sobre frete no título");

    assert(!temAlerta(val(entrada()), "ml_titulo_menciona_condicao"), "título limpo não deveria alertar");
  });

  console.log("\n[Mercado Livre — categoria]");
  await t("6. categoria resolvida passa e entra no payload", () => {
    const r = val(entradaCompleta());
    assert(!temBloqueio(r, "ml_categoria_nao_resolvida"), "categoria resolvida não deveria bloquear");
    assert(r.payload?.category_id === "MLB425079", "categoria não chegou ao payload");
  });
  await t("7. categoria ausente bloqueia e o texto da IA NÃO vira category_id", () => {
    const r = val(entrada());
    assert(temBloqueio(r, "ml_categoria_nao_resolvida"), "deveria bloquear sem categoria");
    assert(r.payload?.category_id === null, "category_id deveria ser null");
    const msg = r.bloqueios.find(b => b.codigo === "ml_categoria_nao_resolvida")!.mensagem;
    assert(/texto livre/.test(msg) && msg.includes("Móveis / Cadeiras"), "a mensagem deveria explicar que a categoria da ficha é texto livre");
    assert(!/MLB/.test(JSON.stringify(r.payload)), "nenhum MLB pode aparecer sem categoria resolvida");
  });
  await t("8. sem categoria, moeda/atributos/qtd de imagens ficam não verificáveis", () => {
    const r = val(entrada());
    for (const c of ["ml_moeda_nao_verificavel", "ml_atributos_obrigatorios_nao_verificaveis", "ml_quantidade_imagens_nao_verificavel"]) {
      assert(r.verificacoes.some(v => v.codigo === c && v.resultado === "nao_verificavel"), `${c} deveria ser não verificável`);
    }
    const r2 = val(entradaCompleta());
    assert(!r2.verificacoes.some(v => v.codigo === "ml_moeda_nao_verificavel"), "com categoria não deveria mais alegar não verificável");
  });

  console.log("\n[Mercado Livre — preço, estoque, condição, tipo]");
  await t("9. preço presente passa; ausente bloqueia e não é inventado", () => {
    assert(!temBloqueio(val(entradaCompleta()), "ml_preco_nao_informado"), "preço presente não deveria bloquear");
    const r = val(entrada());
    assert(temBloqueio(r, "ml_preco_nao_informado"), "deveria bloquear sem preço");
    assert(r.payload?.price === null, "preço deveria ser null");
  });
  await t("10. preço vai ao payload em reais, a partir de centavos", () => {
    assert(val(entradaCompleta()).payload?.price === 199.9, `preço convertido errado: ${val(entradaCompleta()).payload?.price}`);
  });
  await t("11. estoque presente passa; ausente bloqueia", () => {
    assert(!temBloqueio(val(entradaCompleta()), "ml_estoque_nao_informado"), "estoque presente não deveria bloquear");
    assert(temBloqueio(val(entrada()), "ml_estoque_nao_informado"), "deveria bloquear sem estoque");
  });
  await t("12. quantidade por embalagem NUNCA é usada como estoque", () => {
    const r = val(entrada({ ficha: { ...entrada().ficha!, quantidadePorEmbalagem: 12 } }));
    assert(temBloqueio(r, "ml_estoque_nao_informado"), "unidades por embalagem não podem virar estoque");
    assert(r.payload?.available_quantity === null, "available_quantity deveria continuar null");
  });
  await t("13. condição e tipo de anúncio ausentes bloqueiam, presentes passam", () => {
    const r = val(entrada());
    assert(temBloqueio(r, "ml_condicao_nao_definida") && temBloqueio(r, "ml_tipo_anuncio_nao_definido"), "deveriam bloquear");
    const r2 = val(entradaCompleta());
    assert(!temBloqueio(r2, "ml_condicao_nao_definida") && !temBloqueio(r2, "ml_tipo_anuncio_nao_definido"), "não deveriam bloquear");
    assert(r2.payload?.condition === "new" && r2.payload?.listing_type_id === "gold_special", "não chegaram ao payload");
  });

  console.log("\n[Mercado Livre — atributos]");
  await t("14. marca/modelo/GTIN/SKU ausentes são ALERTA, não bloqueio", () => {
    const r = val(entrada());
    for (const c of ["ml_marca_nao_informada", "ml_modelo_nao_informado", "ml_gtin_nao_informado", "ml_sku_nao_informado"]) {
      assert(temAlerta(r, c), `${c} deveria ser alerta`);
      assert(!temBloqueio(r, c), `${c} não deveria bloquear`);
    }
  });
  await t("15. atributo só entra no payload com valor REAL — nunca vazio", () => {
    const attrs = val(entrada()).payload?.attributes as any[];
    assert(attrs.length === 0, "nenhum atributo deveria ser inventado");
    const attrs2 = val(entradaCompleta()).payload?.attributes as any[];
    assert(attrs2.some(a => a.id === "BRAND" && a.value_name === "Marca X"), "marca real deveria entrar");
    assert(attrs2.every(a => a.value_name && a.value_name.trim() !== ""), "atributo com valor vazio no payload");
  });

  console.log("\n[Mercado Livre — imagens]");
  await t("16. imagem válida passa nos requisitos técnicos oficiais", () => {
    const r = val(entrada());
    assert(r.verificacoes.some(v => v.codigo === "ml_imagens_tecnicamente_validas" && v.resultado === "ok"), "imagem boa deveria passar");
  });
  await t("17. sem imagem bloqueia", () => {
    const r = val(entrada({ imagens: [] }));
    assert(temBloqueio(r, "ml_sem_imagem"), "deveria bloquear sem imagem");
    assert((r.payload?.pictures as any[]).length === 0, "pictures deveria estar vazio");
  });
  await t("18. formato fora de JPG/PNG bloqueia (fonte oficial)", () => {
    assert(temBloqueio(val(entrada({ imagens: [imagem({ mimeType: "image/webp" })] })), "ml_imagem_formato_invalido"), "webp deveria bloquear");
    assert(temBloqueio(val(entrada({ imagens: [imagem({ mimeType: null })] })), "ml_imagem_formato_invalido"), "mime desconhecido deveria bloquear");
    assert(!temBloqueio(val(entrada({ imagens: [imagem({ mimeType: "image/png" })] })), "ml_imagem_formato_invalido"), "png é aceito");
  });
  await t("19. resolução mínima 500x500 e máxima 1920x1920 conforme a fonte", () => {
    assert(temBloqueio(val(entrada({ imagens: [imagem({ largura: 480, altura: 1024 })] })), "ml_imagem_abaixo_da_resolucao_minima"), "abaixo do mínimo deveria bloquear");
    assert(!temBloqueio(val(entrada({ imagens: [imagem({ largura: 500, altura: 500 })] })), "ml_imagem_abaixo_da_resolucao_minima"), "exatamente 500x500 é válido");
    const r = val(entrada({ imagens: [imagem({ largura: 4000, altura: 4000 })] }));
    assert(temAlerta(r, "ml_imagem_acima_da_resolucao_maxima"), "acima do máximo deveria alertar");
    assert(!temBloqueio(r, "ml_imagem_acima_da_resolucao_maxima"), "redimensionamento não impede publicar");
  });
  await t("20. imagem acima de 10 MB bloqueia", () => {
    assert(temBloqueio(val(entrada({ imagens: [imagem({ tamanhoBytes: 11 * 1024 * 1024 })] })), "ml_imagem_acima_do_tamanho"), "deveria bloquear");
    assert(!temBloqueio(val(entrada({ imagens: [imagem({ tamanhoBytes: 10 * 1024 * 1024 })] })), "ml_imagem_acima_do_tamanho"), "exatamente 10 MB é aceito");
  });
  await t("21. imagem sem arquivo no Storage bloqueia", () => {
    assert(temBloqueio(val(entrada({ imagens: [imagem({ temArquivo: false })] })), "ml_imagem_sem_arquivo"), "deveria bloquear");
  });
  await t("22. imagem sem aprovação humana é alerta permanente", () => {
    assert(temAlerta(val(entrada()), "ml_imagem_sem_aprovacao_humana"), "deveria alertar sobre ausência de aprovação de imagem");
  });
  await t("23. o payload referencia imagem por id — nunca bytes nem URL", () => {
    const s = JSON.stringify(val(entrada()).payload);
    assert(/imagem_gerada_id/.test(s), "deveria referenciar por id");
    assert(!/base64|https?:|storage_path|token=/.test(s), "vazou bytes, URL ou caminho");
  });

  console.log("\n[status, portão de publicação e payload]");
  await t("24. derivarStatus: bloqueio > alerta > aprovado", () => {
    const b = [{ codigo: "x", campo: null, mensagem: "", regraVersao: 1, responsavel: "usuario" as const }];
    assert(derivarStatus(b, []) === "bloqueado", "bloqueio deveria dominar");
    assert(derivarStatus([], b) === "aprovado_com_alertas", "alerta sozinho");
    assert(derivarStatus([], []) === "aprovado", "sem nada");
  });
  await t("25. hoje o projeto real NÃO é publicável — e o motivo é explícito", () => {
    const r = val(entrada());
    assert(r.status === "bloqueado", r.status);
    assert(!podePublicarMarketplace(r), "não pode ser publicável com bloqueios");
    assert(!r.payloadCompleto, "payload não pode ser dado como completo");
    assert(/pendente/.test(motivoNaoPublicavel(r) ?? ""), motivoNaoPublicavel(r) ?? "sem motivo");
  });
  await t("26. entrada completa vira publicável, com alertas", () => {
    const r = val(entradaCompleta());
    assert(r.bloqueios.length === 0, `ainda há bloqueios: ${r.bloqueios.map(b => b.codigo).join(",")}`);
    assert(r.status === "aprovado_com_alertas", r.status);
    assert(r.payloadCompleto, "payload deveria estar completo");
    assert(podePublicarMarketplace(r), "deveria ser publicável");
    assert(motivoNaoPublicavel(r) === null, "não deveria haver motivo");
  });
  await t("27. o portão nunca libera com campo obrigatório faltando", () => {
    for (const campo of ["categoriaMarketplaceId", "precoCentavos", "estoque", "condicao", "tipoAnuncio"] as const) {
      const e = entradaCompleta();
      (e.comercial as any)[campo] = null;
      const r = val(e);
      assert(!podePublicarMarketplace(r), `publicável sem ${campo}`);
      assert(!r.payloadCompleto, `payload marcado completo sem ${campo}`);
    }
    const semImagem = val(entradaCompleta({ imagens: [] }));
    assert(!podePublicarMarketplace(semImagem), "publicável sem imagem");
  });
  await t("28. resultado forjado sem fonte editorial não passa no portão", () => {
    const r = { ...val(entradaCompleta()), fonteEditorial: null } as ResultadoCompliance;
    assert(!podePublicarMarketplace(r), "sem fonte editorial não pode publicar");
  });
  await t("28b. parecer DESATUALIZADO nunca publica, mesmo estando aprovado", () => {
    // Achado real de 2026-08-23: o parecer é imutável e congela a versão
    // aprovada de então. Se a aprovação mudar depois, liberar publicação
    // com ele seria aprovar A e publicar B.
    const r = val(entradaCompleta());
    assert(podePublicarMarketplace(r, false), "sem estar desatualizado deveria publicar");
    assert(!podePublicarMarketplace(r, true), "desatualizado não pode publicar");
    assert(/vers[ãa]o aprovada mudou/i.test(motivoNaoPublicavel(r, true) ?? ""), motivoNaoPublicavel(r, true) ?? "sem motivo");
  });

  console.log("\n[marketplaces sem validador]");
  await t("29. Shopee/Amazon/TikTok são nao_implementado, nunca aprovado", () => {
    for (const m of ["Shopee", "Amazon", "TikTok Shop"] as const) {
      assert(!temValidador(m), `${m} não deveria ter validador nesta V1`);
      const r = resultadoNaoImplementado(m, "h".repeat(64));
      assert(r.status === "nao_implementado", `${m} deveria ser nao_implementado`);
      assert(!!r.motivoNaoImplementado, `${m} sem motivo explícito`);
      assert(r.versaoRegras === 0 && r.payload === null, `${m} não pode ter regras nem payload`);
      assert(!podePublicarMarketplace(r), `${m} não pode ser publicável`);
    }
    assert(temValidador("ML"), "ML deveria ter validador");
  });
  await t("30. o motivo da Shopee cita a fonte oficial inacessível", () => {
    assert(/documenta[çc][ãa]o oficial/i.test(MOTIVO_NAO_IMPLEMENTADO.Shopee), "motivo deveria citar a documentação oficial");
    assert(/n[ãa]o oficial|mem[óo]ria/i.test(MOTIVO_NAO_IMPLEMENTADO.Shopee), "motivo deveria dizer que nada veio de fonte não oficial");
  });
  await t("31. validarCompliance roteia pelo registry, sem switch solto", () => {
    assert(validarCompliance(entrada()).marketplace === "ML", "ML deveria ir ao validador");
    const r = validarCompliance(entrada({ marketplace: "Shopee" }));
    assert(r.status === "nao_implementado", "Shopee deveria cair em não implementado");
    assert(/^[0-9a-f]{64}$/.test(r.hashEntrada), "hash ausente mesmo sem validador");
  });
  await t("32. slug de marketplace resolve só o que existe", () => {
    assert(resolverMarketplacePorSlug("mercado-livre") === "ML", "slug do ML");
    assert(resolverMarketplacePorSlug("tiktok-shop") === "TikTok Shop", "slug do TikTok");
    assert(resolverMarketplacePorSlug("MERCADO-LIVRE") === "ML", "slug deveria ser case-insensitive");
    assert(resolverMarketplacePorSlug("ebay") === null, "slug desconhecido deveria ser null");
  });

  console.log("\n[hash e revalidação]");
  await t("33. mesma entrada + mesmas regras → mesmo hash", () => {
    assert(calcularHashEntrada(entrada(), 1) === calcularHashEntrada(entrada(), 1), "hash instável");
    assert(/^[0-9a-f]{64}$/.test(calcularHashEntrada(entrada(), 1)), "formato de hash inesperado");
  });
  await t("34. mudar conteúdo, imagem, preço ou categoria muda o hash", () => {
    const base = calcularHashEntrada(entrada(), 1);
    const variacoes: EntradaCompliance[] = [
      entrada({ conteudo: { titulo: "Outro", descricao: "d", bullets: [], especificacoes: [] } }),
      entrada({ imagens: [imagem({ largura: 800 })] }),
      entrada({ comercial: { ...entrada().comercial, precoCentavos: 100 } }),
      entrada({ comercial: { ...entrada().comercial, categoriaMarketplaceId: "MLB1" } }),
      entrada({ logistica: { pesoGramas: 500, comprimentoCm: null, larguraCm: null, alturaCm: null } }),
      entrada({ fonteEditorial: { projetoMarketplaceId: CANAL, versaoAprovadaId: "v-2", numeroVersao: 4, aprovadoEm: null } }),
    ];
    for (const [i, v] of variacoes.entries()) {
      assert(calcularHashEntrada(v, 1) !== base, `variação ${i} não mudou o hash`);
    }
  });
  await t("35. MUDAR A VERSÃO DAS REGRAS invalida a validação anterior", () => {
    assert(calcularHashEntrada(entrada(), 1) !== calcularHashEntrada(entrada(), 2), "versão de regras precisa entrar no hash");
  });
  await t("36. o hash ignora o instante — revalidar sem mudança reencontra", () => {
    const a = val(entrada());
    const b = val(entrada());
    assert(a.validadoEm !== b.validadoEm || true, "instantes podem coincidir");
    assert(calcularHashEntrada(entrada(), VERSAO_REGRAS_ML) === calcularHashEntrada(entrada(), VERSAO_REGRAS_ML), "hash mudou sozinho");
  });
  await t("37. hash é estável contra reordenação de imagens e especificações", () => {
    const duas = [imagem({ imagemGeradaId: "a" }), imagem({ imagemGeradaId: "b", principal: false, ordem: 2 })];
    const h1 = calcularHashEntrada(entrada({ imagens: duas }), 1);
    const h2 = calcularHashEntrada(entrada({ imagens: [...duas].reverse() }), 1);
    assert(h1 === h2, "ordem das imagens mudou o hash");
    const esp = [{ nome: "A", valor: "1" }, { nome: "B", valor: "2" }];
    const c1 = calcularHashEntrada(entrada({ conteudo: { titulo: "T", descricao: "d", bullets: [], especificacoes: esp } }), 1);
    const c2 = calcularHashEntrada(entrada({ conteudo: { titulo: "T", descricao: "d", bullets: [], especificacoes: [...esp].reverse() } }), 1);
    assert(c1 === c2, "ordem das especificações mudou o hash");
  });

  console.log("\n[registro de regras: origem auditável]");
  await t("38. toda regra tem fonte oficial e data de verificação", () => {
    for (const r of REGRAS_ML) {
      assert(!!r.fonteOficial && r.fonteOficial.length > 10, `${r.codigo} sem fonte`);
      assert(/^\d{4}-\d{2}-\d{2}$/.test(r.verificadoEm), `${r.codigo} sem data de verificação`);
      assert(["bloqueio", "alerta", "nao_verificavel"].includes(r.tipo), `${r.codigo} com tipo inválido`);
    }
  });
  await t("39. regras de marketplace citam URL oficial do Mercado Livre", () => {
    const doMarketplace = REGRAS_ML.filter(r => !/Decis[ãa]o de arquitetura do CDS/.test(r.fonteOficial));
    assert(doMarketplace.length >= 15, `poucas regras oficiais: ${doMarketplace.length}`);
    // Duas fontes contam como oficiais, e só elas: o site de
    // desenvolvedores e a PRÓPRIA API do Mercado Livre. A segunda entrou
    // em 2026-08-27 porque a exigência dos atributos de embalagem é
    // declarada pela API (`/categories/{id}/attributes`) e pelo erro do
    // validador oficial — não por uma página de documentação. Continua
    // sendo a palavra do marketplace, não a de terceiro.
    const oficial = /developers\.mercadolibre\.com|api\.mercadolibre\.com/;
    for (const r of doMarketplace) {
      assert(oficial.test(r.fonteOficial), `${r.codigo} não cita fonte oficial: ${r.fonteOficial}`);
    }
  });
  await t("40. nenhuma fonte é blog, fórum, vídeo ou terceiro", () => {
    const proibidas = /reddit|medium|youtube|stackoverflow|blog|forum|gist|dev\.to/i;
    for (const r of REGRAS_ML) assert(!proibidas.test(r.fonteOficial), `${r.codigo} usa fonte não oficial`);
  });
  await t("41. código de regra desconhecido lança — não vira item silencioso", () => {
    let lancou = false;
    try { regraML("ml_regra_que_nao_existe"); } catch { lancou = true; }
    assert(lancou, "deveria lançar para código desconhecido");
  });
  await t("42. nenhum limite de título/descrição foi congelado no código", () => {
    const fonte = fs.readFileSync(path.join(process.cwd(), "lib/estudio-anuncios/compliance/mercado-livre.ts"), "utf-8");
    assert(!/max_title_length\s*[:=]\s*\d|titulo.{0,20}[<>]=?\s*(60|80|120)\b/i.test(fonte),
      "há limite de título hardcoded — ele é por categoria, não do site");
  });
  await t("43. todo código emitido pelo validador existe no registro", () => {
    const emitidos = new Set<string>();
    for (const e of [entrada(), entradaCompleta(), entrada({ fonteEditorial: null, conteudo: null }), entrada({ imagens: [] }),
                     entrada({ imagens: [imagem({ mimeType: "image/webp", largura: 100, altura: 100, tamanhoBytes: 99 * 1024 * 1024, temArquivo: false })] })]) {
      const r = val(e);
      for (const i of [...r.bloqueios, ...r.alertas]) emitidos.add(i.codigo);
    }
    for (const c of emitidos) assert(CODIGOS_REGRAS_ML.includes(c), `código emitido fora do registro: ${c}`);
    assert(emitidos.size >= 12, `poucos códigos exercitados: ${emitidos.size}`);
  });

  console.log("\n[isolamento: projeto, canal e leitura]");
  await t("44. a montagem lê só o projeto e o canal pedidos, e só aprovadas", () => {
    const filtros: { tabela: string; coluna: string; valor: any }[] = [];
    const dados: Record<string, any[]> = {
      estudio_anuncios_projetos_marketplace: [
        { projeto_id: PROJ, id: CANAL, marketplace: "ML" },
        { projeto_id: OUTRO, id: "canal-outro", marketplace: "ML" },
      ],
      estudio_anuncios_conteudo_versoes: [
        { id: "v-nao", projeto_marketplace_id: CANAL, numero_versao: 4, aprovado: false, conteudo: { titulo: "NAO APROVADA" }, aprovado_em: null },
        { id: "v-sim", projeto_marketplace_id: CANAL, numero_versao: 3, aprovado: true, conteudo: { titulo: "APROVADA" }, aprovado_em: "2026-08-20T12:00:00Z" },
      ],
      estudio_anuncios_imagens_geradas: [
        { projeto_id: PROJ, id: "i1", prompt_ordem: 1, finalidade: "capa", e_principal: true, mime_type: "image/jpeg", largura_px: 1024, altura_px: 1024, tamanho_bytes: 1000, storage_path: "u/p/x.jpg" },
        { projeto_id: OUTRO, id: "iX", prompt_ordem: 1, finalidade: "capa", e_principal: true, mime_type: "image/jpeg", largura_px: 1, altura_px: 1, tamanho_bytes: 1, storage_path: "u/o/x.jpg" },
      ],
      estudio_anuncios_entradas_produto: [{ projeto_id: PROJ, marca: "M", modelo: null, categoria: "C", cor: null, material: null, peso: null, unidade_peso: null, medidas: null, quantidade: 6 }],
    };
    const fake: any = {
      from: (tabela: string) => ({
        select: () => {
          let linhas = dados[tabela] ?? [];
          const api: any = {
            eq(c: string, v: any) { filtros.push({ tabela, coluna: c, valor: v }); linhas = linhas.filter((l: any) => l[c] === v); return api; },
            maybeSingle: async () => ({ data: linhas[0] ?? null, error: null }),
            then: (r: any) => r({ data: linhas, error: null }),
          };
          return api;
        },
      }),
    };
    return montarEntradaCompliance(fake, { projetoId: PROJ, nomeProduto: "P", marketplace: "ML" }).then(e => {
      assert(e.conteudo?.titulo === "APROVADA", `leu a versão errada: ${e.conteudo?.titulo}`);
      assert(filtros.some(f => f.tabela === "estudio_anuncios_conteudo_versoes" && f.coluna === "aprovado" && f.valor === true), "não filtrou aprovado=true");
      assert(e.imagens.length === 1 && e.imagens[0].imagemGeradaId === "i1", "imagem de outro projeto vazou");
      assert(filtros.filter(f => f.coluna === "projeto_id").every(f => f.valor === PROJ), "consultou outro projeto");
      assert(e.ficha?.quantidadePorEmbalagem === 6 && e.comercial.estoque === null, "quantidade da ficha virou estoque");
      assert(e.comercial.categoriaMarketplaceId === null && e.comercial.precoCentavos === null, "campo comercial inventado");
      assert(!JSON.stringify(e).includes("u/p/x.jpg"), "o caminho do Storage vazou para a entrada");
    });
  });

  console.log("\n[v2 — limites REAIS da categoria]");
  await t("53. com categoria, o limite de título passa a ser VERIFICADO", () => {
    const r = val(entradaCompleta());
    assert(r.verificacoes.some(v => v.codigo === "ml_titulo_dentro_do_limite" && v.resultado === "ok"), "deveria verificar o limite de verdade");
    assert(!temAlerta(r, "ml_titulo_limite_nao_verificavel"), "não deveria mais alegar não verificável");
  });
  await t("54. título acima do max_title_length da categoria BLOQUEIA", () => {
    const r = val(entradaCompleta({ conteudo: { titulo: "x".repeat(61), descricao: "d", bullets: [], especificacoes: [] } }));
    assert(temBloqueio(r, "ml_titulo_acima_do_limite"), "61 caracteres com limite 60 deveria bloquear");
    const r2 = val(entradaCompleta({ conteudo: { titulo: "x".repeat(60), descricao: "d", bullets: [], especificacoes: [] } }));
    assert(!temBloqueio(r2, "ml_titulo_acima_do_limite"), "exatamente 60 é válido");
  });
  await t("55. descrição acima do limite da categoria BLOQUEIA", () => {
    const cat = categoria({ settings: { maxDescriptionLength: 50 } });
    const r = val(entradaCompleta({ categoriaMarketplace: cat, conteudo: { titulo: "T", descricao: "x".repeat(200), bullets: [], especificacoes: [] } }));
    assert(temBloqueio(r, "ml_descricao_acima_do_limite"), "deveria bloquear descrição longa");
  });
  await t("56. imagens acima do max_pictures_per_item viram ALERTA, e o excedente é cortado", () => {
    // Mudou em 2026-08-29: antes bloqueava, porque não havia seleção.
    // Agora o corte é determinístico e o anúncio continua publicável —
    // o que não pode é o usuário não ficar sabendo.
    const cat = categoria({ settings: { maxPicturesPerItem: 2 } });
    const tres = [
      imagem({ imagemGeradaId: "a", principal: true, ordem: 1 }),
      imagem({ imagemGeradaId: "b", principal: false, ordem: 2 }),
      imagem({ imagemGeradaId: "c", principal: false, ordem: 3 }),
    ];
    const r = val(entradaCompleta({ categoriaMarketplace: cat, imagens: tres }));
    assert(!temBloqueio(r, "ml_imagens_excedentes_nao_enviadas"), "excedente não pode ser bloqueio");
    const al = r.alertas.find(x => x.codigo === "ml_imagens_excedentes_nao_enviadas");
    assert(!!al && /c/.test(al.mensagem), `deveria alertar e dizer quais ficaram de fora: ${al?.mensagem}`);
    const ids = (r.payload as any).pictures.map((p: any) => p.imagem_gerada_id);
    assert(ids.join(",") === "a,b", `corte deveria ser determinístico: ${ids.join(",")}`);
  });
  await t("57. categoria que não permite publicar BLOQUEIA", () => {
    const cat = categoria({ settings: { listingAllowed: false } });
    assert(temBloqueio(val(entradaCompleta({ categoriaMarketplace: cat })), "ml_categoria_nao_permite_publicacao"), "listing_allowed=false deveria bloquear");
    const cat2 = categoria({ settings: { status: "disabled" } });
    assert(temBloqueio(val(entradaCompleta({ categoriaMarketplace: cat2 })), "ml_categoria_nao_permite_publicacao"), "status desabilitado deveria bloquear");
  });
  await t("58. categoria não folha vira ALERTA, não bloqueio", () => {
    const cat = { ...categoria()!, ehFolha: false };
    const r = val(entradaCompleta({ categoriaMarketplace: cat }));
    assert(temAlerta(r, "ml_categoria_nao_folha") && !temBloqueio(r, "ml_categoria_nao_folha"), "deveria ser alerta");
  });

  console.log("\n[v2 — condição, moeda e tipo de anúncio validados de verdade]");
  await t("59. condição fora de item_conditions da categoria BLOQUEIA", () => {
    const r = val(entradaCompleta({ comercial: { ...entradaCompleta().comercial, condicao: "refurbished" } }));
    assert(temBloqueio(r, "ml_condicao_invalida_para_categoria"), "condição não aceita deveria bloquear");
    assert(!temBloqueio(val(entradaCompleta()), "ml_condicao_invalida_para_categoria"), "'new' é aceita");
  });
  await t("60. preencher condição com qualquer string NÃO remove o bloqueio", () => {
    const r = val(entradaCompleta({ comercial: { ...entradaCompleta().comercial, condicao: "novinho" } }));
    assert(r.status === "bloqueado", "string arbitrária não pode aprovar");
    assert(!podePublicarMarketplace(r), "não pode publicar com condição inválida");
  });
  await t("61. moeda sai da categoria; ambígua ou ausente BLOQUEIA", () => {
    assert(val(entradaCompleta()).verificacoes.some(v => v.codigo === "ml_moeda_definida" && v.resultado === "ok"), "BRL deveria passar");
    const semMoeda = val(entradaCompleta({ comercial: { ...entradaCompleta().comercial, moeda: null } }));
    assert(temBloqueio(semMoeda, "ml_moeda_indefinida_para_categoria"), "sem moeda deveria bloquear");
    const foraDaCategoria = val(entradaCompleta({ comercial: { ...entradaCompleta().comercial, moeda: "USD" } }));
    assert(temBloqueio(foraDaCategoria, "ml_moeda_indefinida_para_categoria"), "moeda fora da categoria deveria bloquear");
  });
  await t("62. tipo de anúncio fora dos documentados BLOQUEIA", () => {
    const r = val(entradaCompleta({ comercial: { ...entradaCompleta().comercial, tipoAnuncio: "premium_turbo" } }));
    assert(temBloqueio(r, "ml_tipo_anuncio_invalido"), "valor inventado deveria bloquear");
    for (const t of TIPOS_ANUNCIO_DOCUMENTADOS_ML) {
      assert(!temBloqueio(val(entradaCompleta({ comercial: { ...entradaCompleta().comercial, tipoAnuncio: t } })), "ml_tipo_anuncio_invalido"), `${t} deveria ser aceito`);
    }
  });
  await t("63. tipo válido gera ALERTA de disponibilidade não verificada", () => {
    assert(temAlerta(val(entradaCompleta()), "ml_tipo_anuncio_nao_verificado_na_conta"), "deveria alertar que a conta não foi verificada");
  });

  console.log("\n[v3 — tipos de anúncio da CONTA vinculada]");
  await t("63b. com a conta, a lista DELA manda — inclusive tipos fora dos documentados", () => {
    // A conta real devolveu gold_premium/gold/free além dos 4 dos
    // exemplos oficiais; barrar por "documentado" recusaria tipo legítimo.
    const daConta = ["gold_pro", "gold_premium", "gold_special", "gold", "silver", "bronze", "free"];
    const r = val(entradaCompleta({ tiposAnuncioDaConta: daConta, comercial: { ...entradaCompleta().comercial, tipoAnuncio: "gold_premium" } }));
    assert(!temBloqueio(r, "ml_tipo_anuncio_invalido"), "tipo real da conta não pode ser recusado pela lista documentada");
    assert(!temBloqueio(r, "ml_tipo_anuncio_nao_disponivel_na_conta"), "está na lista da conta");
    assert(r.verificacoes.some(v => v.codigo === "ml_tipo_anuncio_disponivel_na_conta" && v.resultado === "ok"), "faltou a confirmação com a conta");
    assert(!temAlerta(r, "ml_tipo_anuncio_nao_verificado_na_conta"), "com conta não deveria mais alertar");
  });
  await t("63c. tipo fora da lista da CONTA bloqueia, mesmo se documentado", () => {
    const r = val(entradaCompleta({ tiposAnuncioDaConta: ["gold_pro"], comercial: { ...entradaCompleta().comercial, tipoAnuncio: "bronze" } }));
    assert(temBloqueio(r, "ml_tipo_anuncio_nao_disponivel_na_conta"), "bronze não está nesta conta");
  });
  await t("63d. sem conta, volta a valer a lista documentada + alerta", () => {
    const r = val(entradaCompleta());
    assert(temAlerta(r, "ml_tipo_anuncio_nao_verificado_na_conta"), "sem conta precisa alertar");
    assert(temBloqueio(val(entradaCompleta({ comercial: { ...entradaCompleta().comercial, tipoAnuncio: "gold_premium" } })), "ml_tipo_anuncio_invalido"),
      "sem conta, tipo fora dos documentados bloqueia");
  });
  await t("63e. os tipos da conta entram no hash da entrada", () => {
    const a = calcularHashEntrada(entradaCompleta({ tiposAnuncioDaConta: ["gold_pro"] }), VERSAO_REGRAS_ML);
    const b = calcularHashEntrada(entradaCompleta({ tiposAnuncioDaConta: ["gold_pro", "free"] }), VERSAO_REGRAS_ML);
    assert(a !== b, "mudar os tipos da conta precisa mudar o hash");
  });

  console.log("\n[v2 — atributos obrigatórios REAIS da categoria]");
  await t("64. atributo obrigatório da categoria ausente BLOQUEIA", () => {
    const semMarca = entradaCompleta();
    semMarca.ficha = { ...semMarca.ficha!, marca: null };
    const r = val(semMarca);
    assert(temBloqueio(r, "ml_atributo_obrigatorio_ausente"), "BRAND ausente deveria bloquear");
    assert(/BRAND/.test(r.bloqueios.find(b => b.codigo === "ml_atributo_obrigatorio_ausente")!.mensagem), "a mensagem deveria dizer qual falta");
  });
  await t("65. atributo obrigatório presente libera; nada é inventado", () => {
    const r = val(entradaCompleta());
    assert(!temBloqueio(r, "ml_atributo_obrigatorio_ausente"), "BRAND e MODEL vêm da ficha");
    assert(r.verificacoes.some(v => v.codigo === "ml_atributos_obrigatorios_completos" && v.resultado === "ok"), "faltou a verificação ok");
    const attrs = r.payload?.attributes as any[];
    assert(attrs.every(a => a.value_name && a.value_name.trim() !== ""), "atributo vazio no payload");
  });
  await t("66. atributo CONDICIONAL ausente é alerta, nunca bloqueio", () => {
    const cat = categoria({ atributosObrigatorios: [{ id: "GTIN", nome: "Código universal", condicional: true }] });
    const e = entradaCompleta({ categoriaMarketplace: cat });
    e.comercial = { ...e.comercial, gtin: null };
    e.atributosInformados = [];
    const r = val(e);
    assert(temAlerta(r, "ml_atributo_condicional_ausente"), "condicional deveria alertar");
    assert(!temBloqueio(r, "ml_atributo_obrigatorio_ausente"), "condicional não pode bloquear");
  });
  await t("67. atributo informado pelo usuário conta e entra no payload", () => {
    const cat = categoria({ atributosObrigatorios: [{ id: "MATERIAL", nome: "Material", condicional: false }] });
    const semAtributo = val(entradaCompleta({ categoriaMarketplace: cat }));
    assert(temBloqueio(semAtributo, "ml_atributo_obrigatorio_ausente"), "MATERIAL ausente deveria bloquear");
    const comAtributo = val(entradaCompleta({
      categoriaMarketplace: cat,
      atributosInformados: [{ id: "MATERIAL", valueId: null, valueName: "Jade" }],
    }));
    assert(!temBloqueio(comAtributo, "ml_atributo_obrigatorio_ausente"), "MATERIAL informado deveria liberar");
    assert((comAtributo.payload?.attributes as any[]).some(a => a.id === "MATERIAL" && a.value_name === "Jade"), "não chegou ao payload");
  });

  console.log("\n[v2 — entrada completa fica publicável e o hash muda]");
  await t("68. com tudo configurado, o ML fica publicável", () => {
    const r = val(entradaCompleta());
    assert(r.bloqueios.length === 0, `ainda há bloqueios: ${r.bloqueios.map(b => b.codigo).join(",")}`);
    assert(r.payloadCompleto && podePublicarMarketplace(r), "deveria ser publicável");
    assert(r.payload?.currency_id === "BRL" && r.payload?.price === 199.9 && r.payload?.available_quantity === 5, "payload incompleto");
  });
  await t("69. mudar QUALQUER dado de publicação muda o hash da entrada", () => {
    const base = calcularHashEntrada(entradaCompleta(), VERSAO_REGRAS_ML);
    const variacoes: EntradaCompliance[] = [
      entradaCompleta({ comercial: { ...entradaCompleta().comercial, precoCentavos: 19991 } }),
      entradaCompleta({ comercial: { ...entradaCompleta().comercial, estoque: 6 } }),
      entradaCompleta({ comercial: { ...entradaCompleta().comercial, condicao: "used" } }),
      entradaCompleta({ comercial: { ...entradaCompleta().comercial, tipoAnuncio: "gold_pro" } }),
      entradaCompleta({ categoriaMarketplace: categoria({ settings: { maxTitleLength: 70 } }) }),
      entradaCompleta({ atributosInformados: [{ id: "MATERIAL", valueId: null, valueName: "Jade" }] }),
    ];
    for (const [i, v] of variacoes.entries()) {
      assert(calcularHashEntrada(v, VERSAO_REGRAS_ML) !== base, `variação ${i} não mudou o hash`);
    }
  });
  await t("70. a versão de regras subiu — pareceres antigos ficam inválidos", () => {
    assert(VERSAO_REGRAS_ML >= 2, `versão inesperada: ${VERSAO_REGRAS_ML}`);
    assert(calcularHashEntrada(entradaCompleta(), 1) !== calcularHashEntrada(entradaCompleta(), VERSAO_REGRAS_ML), "a versão precisa entrar no hash");
  });

  console.log("\n[configuração de publicação — validação server-side]");
  const cfg = (corpo: unknown) => validarConfiguracaoPublicacao(corpo, "ML");
  await t("71. rejeita campo não permitido e corpo vazio", async () => {
    assert(!(await cfg({ userId: "x" })).valido, "campo estranho deveria ser rejeitado");
    assert(!(await cfg({})).valido, "corpo vazio deveria ser rejeitado");
    assert(!(await cfg([])).valido, "array deveria ser rejeitado");
    assert(!(await cfg({ categoryId: "MLB1", precoCentavos: 1, hack: 1 })).valido, "campo extra invalida tudo");
  });
  await t("72. preço: zero, negativo e não inteiro são rejeitados", async () => {
    assert(!(await cfg({ precoCentavos: 0 })).valido, "zero deveria ser rejeitado");
    assert(!(await cfg({ precoCentavos: -100 })).valido, "negativo deveria ser rejeitado");
    assert(!(await cfg({ precoCentavos: 19.9 })).valido, "decimal deveria ser rejeitado (o campo é em centavos)");
    assert(!(await cfg({ precoCentavos: "1990" })).valido, "string deveria ser rejeitada");
    const ok = await cfg({ precoCentavos: 19990 });
    assert(ok.valido && ok.dados?.precoCentavos === 19990, "preço válido deveria passar");
  });
  await t("73. estoque: negativo e não inteiro rejeitados; zero é VÁLIDO", async () => {
    assert(!(await cfg({ estoque: -1 })).valido, "negativo deveria ser rejeitado");
    assert(!(await cfg({ estoque: 1.5 })).valido, "decimal deveria ser rejeitado");
    const zero = await cfg({ estoque: 0 });
    assert(zero.valido && zero.dados?.estoque === 0, "zero é estoque válido (pausa o anúncio, não é erro)");
    assert((await cfg({ estoque: 5 })).valido, "estoque positivo deveria passar");
  });
  await t("74. tipo de anúncio: só os documentados", async () => {
    assert(!(await cfg({ tipoAnuncioId: "turbo" })).valido, "valor inventado deveria ser rejeitado");
    assert(!(await cfg({ tipoAnuncioId: "" })).valido, "vazio deveria ser rejeitado");
    for (const t of TIPOS_ANUNCIO_DOCUMENTADOS_ML) {
      assert((await cfg({ tipoAnuncioId: t })).valido, `${t} deveria ser aceito`);
    }
  });
  await t("75. atributos: JSON inválido, valor vazio e repetido são rejeitados", async () => {
    assert(!(await cfg({ atributos: "x" })).valido, "não-lista deveria ser rejeitada");
    assert(!(await cfg({ atributos: [{ id: "BRAND" }] })).valido, "sem value_name deveria ser rejeitado");
    assert(!(await cfg({ atributos: [{ id: "BRAND", value_name: "  " }] })).valido, "valor vazio deveria ser rejeitado");
    assert(!(await cfg({ atributos: [{ id: "", value_name: "x" }] })).valido, "id vazio deveria ser rejeitado");
    assert(!(await cfg({ atributos: [{ id: "BRAND", value_name: "a" }, { id: "brand", value_name: "b" }] })).valido, "repetido deveria ser rejeitado");
    assert(!(await cfg({ atributos: [{ id: "BRAND", value_name: "a", extra: 1 }] })).valido, "campo extra deveria ser rejeitado");
    const ok = await cfg({ atributos: [{ id: "brand", value_name: " Marca X " }] });
    assert(ok.valido && ok.dados?.atributos?.[0].id === "BRAND" && ok.dados?.atributos?.[0].value_name === "Marca X", "normalização incorreta");
  });
  await t("76. só o Mercado Livre aceita configuração nesta versão", async () => {
    assert(!(await validarConfiguracaoPublicacao({ precoCentavos: 1 }, "Shopee")).valido, "Shopee não deveria aceitar");
    assert(!(await validarConfiguracaoPublicacao({ precoCentavos: 1 }, "Amazon")).valido, "Amazon não deveria aceitar");
  });
  await t("76b. condição só é aceita contra a categoria JÁ SALVA", async () => {
    // Achado real de 2026-08-24: sem os settings salvos, qualquer string
    // passava quando a categoria tinha sido salva num request anterior.
    const semCategoria = await validarConfiguracaoPublicacao({ condicao: "new" }, "ML", null);
    assert(!semCategoria.valido, "sem categoria não dá para validar condição");
    const invalida = await validarConfiguracaoPublicacao({ condicao: "refurbished_zzz" }, "ML", { itemConditions: ["new", "used"] });
    assert(!invalida.valido, "condição fora das aceitas deveria ser rejeitada");
    const valida = await validarConfiguracaoPublicacao({ condicao: "used" }, "ML", { itemConditions: ["new", "used"] });
    assert(valida.valido && valida.dados?.condicao === "used", "condição aceita deveria passar");
  });
  await t("77. limpar categoria é intenção explícita, não ausência de campo", async () => {
    const limpa = await cfg({ categoryId: null });
    assert(limpa.valido && limpa.dados?.limparCategoria === true, "categoryId null deveria limpar");
    const ausente = await cfg({ precoCentavos: 100 });
    assert(ausente.valido && ausente.dados?.limparCategoria === false, "campo ausente não pode limpar");
  });

  // ── Dados logísticos da embalagem (2026-08-27) ──────────────────────
  // O fio condutor da seção inteira: a caixa é uma coisa, o produto é
  // outra. Vários testes existem só para provar que ninguém derivou uma
  // da outra em silêncio.
  console.log("\n[dados logísticos — embalagem de envio]");
  const EMB_OK = { pesoG: 420, alturaCm: 8, larguraCm: 13, comprimentoCm: 23 };
  const semMedida = (campo: keyof typeof EMB_OK) =>
    val(entradaCompleta({ embalagem: { ...EMB_OK, [campo]: null } }));

  await t("78. peso da embalagem ausente bloqueia", () => {
    assert(temBloqueio(semMedida("pesoG"), "ml_peso_embalagem_nao_informado"), "faltou o bloqueio de peso");
  });
  await t("79. altura da embalagem ausente bloqueia", () => {
    assert(temBloqueio(semMedida("alturaCm"), "ml_altura_embalagem_nao_informada"), "faltou o bloqueio de altura");
  });
  await t("80. largura da embalagem ausente bloqueia", () => {
    assert(temBloqueio(semMedida("larguraCm"), "ml_largura_embalagem_nao_informada"), "faltou o bloqueio de largura");
  });
  await t("81. comprimento da embalagem ausente bloqueia", () => {
    assert(temBloqueio(semMedida("comprimentoCm"), "ml_comprimento_embalagem_nao_informado"), "faltou o bloqueio de comprimento");
  });
  await t("82. os quatro presentes viram UMA verificação ok, com as unidades", () => {
    const r = val(entradaCompleta());
    assert(!r.bloqueios.some(b => /embalagem/.test(b.codigo)), "não deveria sobrar bloqueio de embalagem");
    const v = r.verificacoes.find(x => x.codigo === "ml_embalagem_completa");
    assert(!!v && v.resultado === "ok", "faltou a verificação de embalagem completa");
    assert(/8 × 13 × 23 cm/.test(v!.detalhe ?? "") && /420 g/.test(v!.detalhe ?? ""), `detalhe sem unidades: ${v!.detalhe}`);
  });
  await t("83. NADA deriva a embalagem do peso/medidas do PRODUTO", () => {
    // Ficha cheia de medidas do produto, embalagem vazia: se alguma
    // linha copiasse uma na outra, os bloqueios sumiriam aqui.
    const e = entradaCompleta({
      embalagem: { pesoG: null, alturaCm: null, larguraCm: null, comprimentoCm: null },
      ficha: { ...entrada().ficha!, peso: 1.5, unidadePeso: "kg", medidas: { altura: 10, largura: 20, comprimento: 30 } },
      logistica: { pesoGramas: 1500, comprimentoCm: 30, larguraCm: 20, alturaCm: 10 },
    });
    const r = val(e);
    for (const c of ["ml_peso_embalagem_nao_informado", "ml_altura_embalagem_nao_informada",
                     "ml_largura_embalagem_nao_informada", "ml_comprimento_embalagem_nao_informado"]) {
      assert(temBloqueio(r, c), `${c} sumiu — alguém derivou embalagem do produto`);
    }
    assert(!JSON.stringify(r.payload).includes("1500"), "peso do produto vazou para o payload");
  });
  await t("84. cada medida entra no hash do parecer", () => {
    const base = calcularHashEntrada(entradaCompleta(), VERSAO_REGRAS_ML);
    for (const campo of ["pesoG", "alturaCm", "larguraCm", "comprimentoCm"] as const) {
      const outro = calcularHashEntrada(
        entradaCompleta({ embalagem: { ...EMB_OK, [campo]: EMB_OK[campo] + 1 } }), VERSAO_REGRAS_ML);
      assert(outro !== base, `mudar ${campo} não mudou o hash`);
    }
  });
  await t("85. hash é estável quando nada muda (idempotência)", () => {
    assert(
      calcularHashEntrada(entradaCompleta(), VERSAO_REGRAS_ML) === calcularHashEntrada(entradaCompleta(), VERSAO_REGRAS_ML),
      "o hash não é determinístico"
    );
  });
  await t("86. payload User Products leva os quatro SELLER_PACKAGE_* nas unidades do ML", () => {
    const attrs = montarAtributosEmbalagem(EMB_OK);
    const mapa = new Map(attrs.map(a => [a.id, a.value_name]));
    assert(mapa.get("SELLER_PACKAGE_HEIGHT") === "8 cm", `altura: ${mapa.get("SELLER_PACKAGE_HEIGHT")}`);
    assert(mapa.get("SELLER_PACKAGE_WIDTH") === "13 cm", `largura: ${mapa.get("SELLER_PACKAGE_WIDTH")}`);
    assert(mapa.get("SELLER_PACKAGE_LENGTH") === "23 cm", `comprimento: ${mapa.get("SELLER_PACKAGE_LENGTH")}`);
    assert(mapa.get("SELLER_PACKAGE_WEIGHT") === "420 g", `peso: ${mapa.get("SELLER_PACKAGE_WEIGHT")}`);
    assert(attrs.length === 4, "montou atributo a mais");
    // `PACKAGE_*` (hierarchy FAMILY) é read_only — nunca é enviado.
    assert(!attrs.some(a => /^PACKAGE_/.test(a.id)), "enviou atributo read_only de família");
  });
  const pComp = {
    category_id: "MLB425079", price: 199.9, currency_id: "BRL", available_quantity: 5,
    listing_type_id: "gold_special", condition: "new", title: "Título legado",
    description: { plain_text: "d" }, attributes: [{ id: "BRAND", value_name: "Marca X" }],
    // Imagens por IDENTIDADE ESTÁVEL — nunca URL. Ver `imagens-ml.ts`.
    pictures: [{ imagem_gerada_id: "img-1", checksum: "a".repeat(64), ordem: 1, principal: true }],
  };
  await t("87. no modelo novo o payload sai completo com embalagem", () => {
    const a = montarPayloadPublicacaoMercadoLivre({
      payloadCompliance: pComp, lojaId: "loja-1", versaoAprovadaId: "v-1",
      modelo: "user_products", familyName: "Massageador Manual X", embalagem: EMB_OK,
    });
    assert(a.completo, `deveria estar completo: ${a.camposFaltando.join(",")}`);
    assert(!("title" in a.payload), "User Products não envia title");
    const ids = a.payload.attributes.map(x => x.id);
    assert(ids.join(",") === [...ids].sort().join(","), "atributos fora de ordem — hash instável");
  });
  await t("88. faltando UMA medida, o payload fica incompleto e diz qual", () => {
    const a = montarPayloadPublicacaoMercadoLivre({
      payloadCompliance: pComp, lojaId: "loja-1", versaoAprovadaId: "v-1",
      modelo: "user_products", familyName: "X", embalagem: { ...EMB_OK, larguraCm: null },
    });
    assert(!a.completo, "deveria estar incompleto");
    assert(a.camposFaltando.includes("seller_package_width"), `camposFaltando: ${a.camposFaltando.join(",")}`);
  });
  await t("89. o modelo LEGADO não regride: title continua, sem SELLER_PACKAGE", () => {
    const a = montarPayloadPublicacaoMercadoLivre({
      payloadCompliance: pComp, lojaId: "loja-1", versaoAprovadaId: "v-1",
      modelo: "legacy", embalagem: EMB_OK,
    });
    assert(a.completo, `legado deveria seguir completo: ${a.camposFaltando.join(",")}`);
    assert((a.payload as any).title === "Título legado", "o legado perdeu o title");
    assert(!("family_name" in a.payload), "o legado ganhou family_name");
    assert(!a.payload.attributes.some(x => /^SELLER_PACKAGE_/.test(x.id)), "o legado ganhou atributo de embalagem");
  });
  await t("90. mudar a embalagem muda o hash do PAYLOAD (revalidação oficial cai)", () => {
    const h = (emb: typeof EMB_OK) => montarPayloadPublicacaoMercadoLivre({
      payloadCompliance: pComp, lojaId: "loja-1", versaoAprovadaId: "v-1",
      modelo: "user_products", familyName: "X", embalagem: emb,
    }).hashPayload;
    assert(h(EMB_OK) === h({ ...EMB_OK }), "hash do payload não é determinístico");
    assert(h(EMB_OK) !== h({ ...EMB_OK, pesoG: 421 }), "mudar o peso não mudou o hash do payload");
  });
  await t("91. server: zero é rejeitado nas quatro medidas", async () => {
    for (const campo of ["embalagemPesoG", "embalagemAlturaCm", "embalagemLarguraCm", "embalagemComprimentoCm"]) {
      assert(!(await cfg({ [campo]: 0 })).valido, `${campo} = 0 deveria ser rejeitado`);
    }
  });
  await t("92. server: negativo é rejeitado nas quatro medidas", async () => {
    for (const campo of ["embalagemPesoG", "embalagemAlturaCm", "embalagemLarguraCm", "embalagemComprimentoCm"]) {
      assert(!(await cfg({ [campo]: -1 })).valido, `${campo} negativo deveria ser rejeitado`);
    }
  });
  await t("93. server: NaN, Infinity e string são rejeitados", async () => {
    assert(!(await cfg({ embalagemPesoG: Number.NaN })).valido, "NaN deveria ser rejeitado");
    assert(!(await cfg({ embalagemPesoG: Number.POSITIVE_INFINITY })).valido, "Infinity deveria ser rejeitado");
    assert(!(await cfg({ embalagemAlturaCm: Number.NEGATIVE_INFINITY })).valido, "-Infinity deveria ser rejeitado");
    assert(!(await cfg({ embalagemLarguraCm: "13" })).valido, "string deveria ser rejeitada");
    assert(!(await cfg({ embalagemComprimentoCm: {} })).valido, "objeto deveria ser rejeitado");
    assert(!(await cfg({ embalagemPesoG: true })).valido, "boolean deveria ser rejeitado");
  });
  await t("94. server: QUALQUER decimal é rejeitado — o ML só aceita inteiro", async () => {
    // Antes desta data a camada aceitava 2 casas. A evidência real de
    // `/items/validate` mostrou que o domínio nunca foi decimal.
    for (const v of [8.75, 8.5, 8.1, 8.755, 0.5]) {
      assert(!(await cfg({ embalagemAlturaCm: v })).valido, `${v} deveria ser rejeitado`);
    }
    const ok = await cfg({ embalagemAlturaCm: 9 });
    assert(ok.valido && ok.dados?.embalagemAlturaCm === 9, "inteiro deveria passar");
  });
  await t("95. server: inteiro passa e chega inteiro", async () => {
    const r = await cfg({ embalagemPesoG: 420, embalagemAlturaCm: 8, embalagemLarguraCm: 13, embalagemComprimentoCm: 23 });
    assert(r.valido, `deveria passar: ${r.erro}`);
    assert(r.dados?.embalagemPesoG === 420 && r.dados?.embalagemComprimentoCm === 23, "valores não chegaram inteiros");
    assert(r.dados?.limparEmbalagem === false, "não era para limpar");
  });
  await t("96. server: campo de embalagem inventado é rejeitado", async () => {
    assert(!(await cfg({ embalagemPeso: 420 })).valido, "nome errado deveria ser rejeitado");
    assert(!(await cfg({ pesoProduto: 420 })).valido, "peso do produto não é campo desta rota");
    assert(!(await cfg({ embalagemPesoKg: 0.42 })).valido, "não existe campo em kg");
  });
  await t("97. server: limpar embalagem é tudo ou nada", async () => {
    const meio = await cfg({ embalagemPesoG: null, embalagemAlturaCm: 8 });
    assert(!meio.valido, "limpar metade deveria ser rejeitado");
    const tudo = await cfg({ embalagemPesoG: null, embalagemAlturaCm: null, embalagemLarguraCm: null, embalagemComprimentoCm: null });
    assert(tudo.valido && tudo.dados?.limparEmbalagem === true, "limpar os quatro deveria valer");
  });
  await t("98. server: campo ausente NUNCA limpa o que já está salvo", async () => {
    const r = await cfg({ precoCentavos: 100 });
    assert(r.valido && r.dados?.limparEmbalagem === false, "ausência não pode virar limpeza");
    assert(r.dados?.embalagemPesoG === null, "não deveria inventar peso");
  });
  await t("99. a persistência da embalagem é RPC, nunca UPDATE solto", () => {
    const CFG = fs.readFileSync(path.join(process.cwd(), "lib/estudio-anuncios/compliance/configuracao-marketplace.ts"), "utf-8");
    assert(/estudio_anuncios_salvar_embalagem/.test(CFG), "faltou a RPC de embalagem");
    assert(!/\.from\([^)]*\)\s*\.\s*(insert|update|upsert|delete)\(/.test(CFG), "escrita direta em tabela");
    assert(/embalagem_peso_g, embalagem_altura_cm, embalagem_largura_cm, embalagem_comprimento_cm/.test(CFG),
      "as colunas de embalagem não são lidas de volta");
    // Escrita por índice dinâmico (`(dados as any)[campo] = ...`) foi
    // justamente o que se removeu daqui: cada medida tem destino próprio.
    assert(!/(dados as any)/.test(CFG), "escrita dinâmica em `dados`");
  });
  await t("100. a migração exige medida positiva e não converte unidade", () => {
    const M = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260827_dados_logisticos_embalagem.sql"), "utf-8");
    assert(/numeric\(10,\s*2\)/i.test(M), "as medidas deveriam ser NUMERIC(10,2)");
    assert(/chk_pm_embalagem_positiva/.test(M) && />\s*0/.test(M), "faltou o CHECK de positividade");
    assert(/add column if not exists/i.test(M), "a migração deveria ser aditiva");
    assert(!/drop\s+(table|column|constraint\s+chk_pm_embalagem)/i.test(M), "a migração destrói algo");
    // Só o SQL executável conta: os comentários citam `peso_kg` de
    // propósito, para explicar por que aquela coluna NÃO é reaproveitada.
    const sql = M.replace(/^\s*--.*$/gm, " ").replace(/IS\s+'[^']*'/g, " ");
    assert(!/\*\s*1000|\/\s*1000|\bkg\b|\bmm\b/i.test(sql), "há conversão de unidade na migração");
  });
  await t("101. a UI fala de EMBALAGEM, com unidade, e nunca de 'medidas do produto'", () => {
    const F = fs.readFileSync(path.join(process.cwd(), "app/(app)/central-ia/estudio-anuncios/[projetoId]/DadosPublicacao.tsx"), "utf-8");
    assert(/Dados logísticos/.test(F), "faltou o bloco Dados logísticos");
    assert(/embalagem utilizada no envio/i.test(F), "faltou a frase que define o que se está medindo");
    assert(/Peso da embalagem \(g\)/.test(F) && /Altura da embalagem \(cm\)/.test(F)
      && /Largura da embalagem \(cm\)/.test(F) && /Comprimento da embalagem \(cm\)/.test(F),
      "os campos precisam dizer que são da embalagem e mostrar a unidade");
    assert(/Não são as medidas do produto/i.test(F), "a UI não avisa que não é o produto");
    // A frase "não são as medidas do produto" é justamente o aviso — o
    // que não pode é ROTULAR campo de embalagem como sendo do produto.
    assert(!/Peso do produto|Medidas do produto:|>s*Produtos*</i.test(F), "a UI rotula a embalagem como produto");
    assert(!/Peso (kg)|(mm)/.test(F), "unidade fora da que o ML aceita");
    assert(!/createClient|SERVICE_ROLE|SUPABASE/.test(F), "UI acessa Supabase/segredo");
  });

  // ── Embalagem: APENAS INTEIROS (2026-08-28) ─────────────────────────
  // Evidência real de `/items/validate`: "Only integers are accepted for
  // dimensions and weight". O tema desta seção é um só — o sistema
  // RECUSA o decimal, nunca o conserta por conta própria.
  console.log("\n[embalagem — apenas inteiros, sem arredondar]");

  await t("102. altura 13 é aceita e chega 13", async () => {
    const r = await cfg({ embalagemAlturaCm: 13 });
    assert(r.valido && r.dados?.embalagemAlturaCm === 13, `deveria aceitar 13: ${r.erro}`);
  });
  await t("103. altura 13.5 é rejeitada — e o erro explica que não se arredonda", async () => {
    const r = await cfg({ embalagemAlturaCm: 13.5 });
    assert(!r.valido, "13.5 deveria ser rejeitado");
    assert(/inteiro/i.test(r.erro ?? ""), `o erro deveria falar em inteiro: ${r.erro}`);
  });
  await t("104. largura 13.5 é rejeitada", async () => {
    assert(!(await cfg({ embalagemLarguraCm: 13.5 })).valido, "13.5 deveria ser rejeitado");
  });
  await t("105. comprimento decimal é rejeitado", async () => {
    assert(!(await cfg({ embalagemComprimentoCm: 23.4 })).valido, "23.4 deveria ser rejeitado");
  });
  await t("106. peso decimal é rejeitado", async () => {
    assert(!(await cfg({ embalagemPesoG: 420.5 })).valido, "420.5 deveria ser rejeitado");
  });
  await t("107. zero é rejeitado nas quatro medidas", async () => {
    for (const c of ["embalagemPesoG", "embalagemAlturaCm", "embalagemLarguraCm", "embalagemComprimentoCm"]) {
      assert(!(await cfg({ [c]: 0 })).valido, `${c} = 0 deveria ser rejeitado`);
    }
  });
  await t("108. negativo é rejeitado, inclusive negativo inteiro", async () => {
    assert(!(await cfg({ embalagemPesoG: -420 })).valido, "-420 deveria ser rejeitado");
    assert(!(await cfg({ embalagemAlturaCm: -8.5 })).valido, "-8.5 deveria ser rejeitado");
  });
  await t("109. string é rejeitada, mesmo parecendo inteiro", async () => {
    assert(!(await cfg({ embalagemAlturaCm: "13" })).valido, "\"13\" deveria ser rejeitado");
    assert(!(await cfg({ embalagemPesoG: "420 g" })).valido, "\"420 g\" deveria ser rejeitado");
  });
  await t("110. NaN é rejeitado", async () => {
    assert(!(await cfg({ embalagemPesoG: Number.NaN })).valido, "NaN deveria ser rejeitado");
  });
  await t("111. Infinity e -Infinity são rejeitados", async () => {
    assert(!(await cfg({ embalagemPesoG: Number.POSITIVE_INFINITY })).valido, "Infinity deveria ser rejeitado");
    assert(!(await cfg({ embalagemAlturaCm: Number.NEGATIVE_INFINITY })).valido, "-Infinity deveria ser rejeitado");
    assert(!(await cfg({ embalagemLarguraCm: true })).valido, "boolean deveria ser rejeitado");
    assert(!(await cfg({ embalagemComprimentoCm: [13] })).valido, "array deveria ser rejeitado");
  });
  await t("112. o payload NÃO arredonda: o que entra é o que sai", () => {
    const attrs = montarAtributosEmbalagem({ pesoG: 420, alturaCm: 8, larguraCm: 13, comprimentoCm: 23 });
    const m = new Map(attrs.map(a => [a.id, a.value_name]));
    assert(m.get("SELLER_PACKAGE_WIDTH") === "13 cm", `largura: ${m.get("SELLER_PACKAGE_WIDTH")}`);
    assert(m.get("SELLER_PACKAGE_WEIGHT") === "420 g", `peso: ${m.get("SELLER_PACKAGE_WEIGHT")}`);
    // Se um decimal chegasse aqui, sairia decimal — e seria recusado pelo
    // ML de forma visível. O que NÃO pode é virar outro número em silêncio.
    const sujo = montarAtributosEmbalagem({ pesoG: 420, alturaCm: 8, larguraCm: 13.5, comprimentoCm: 23 });
    const ms = new Map(sujo.map(a => [a.id, a.value_name]));
    assert(ms.get("SELLER_PACKAGE_WIDTH") === "13.5 cm", `o adapter arredondou: ${ms.get("SELLER_PACKAGE_WIDTH")}`);
  });
  await t("113. banco e payload carregam o MESMO valor", () => {
    // O que o compliance leu da linha é exatamente o que vai no atributo.
    const e = entradaCompleta({ embalagem: { pesoG: 1250, alturaCm: 40, larguraCm: 30, comprimentoCm: 55 } });
    const r = val(e);
    const emb = (r.payload as any).embalagem;
    const attrs = montarAtributosEmbalagem(emb);
    const m = new Map(attrs.map(a => [a.id, a.value_name]));
    assert(emb.pesoG === 1250 && emb.alturaCm === 40, "o parecer alterou o valor lido");
    assert(m.get("SELLER_PACKAGE_WEIGHT") === "1250 g" && m.get("SELLER_PACKAGE_HEIGHT") === "40 cm",
      "o payload divergiu do valor persistido");
  });
  await t("114. a UI usa step=1 e recusa decimal em vez de arredondar", () => {
    const F = fs.readFileSync(path.join(process.cwd(), "app/(app)/central-ia/estudio-anuncios/[projetoId]/DadosPublicacao.tsx"), "utf-8");
    const bloco = F.slice(F.indexOf("Dados logísticos"));
    assert((bloco.match(/step=\{1\}/g) ?? []).length >= 4, "os quatro campos precisam de step=1");
    assert(/apenas números inteiros/i.test(F), "a UI não avisa que só aceita inteiro");
    assert(/quem decide entre 13 e 14 é você/.test(F), "a UI não deixa claro que não arredonda");
    assert(!/inputMode="decimal"/.test(bloco), "campo de embalagem ainda aceita decimal");
  });
  await t("115. NENHUM arredondamento no caminho da embalagem", () => {
    const arred = /Math\.(round|floor|ceil|trunc)|parseInt|toFixed/;
    for (const rel of [
      "lib/estudio-anuncios/compliance/configuracao-marketplace.ts",
      "lib/estudio-anuncios/compliance/payload-ml.ts",
      "lib/estudio-anuncios/compliance/mercado-livre.ts",
    ]) {
      const f = fs.readFileSync(path.join(process.cwd(), rel), "utf-8")
        .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
      assert(!arred.test(f), `${rel} arredonda em algum ponto`);
    }
    const ui = fs.readFileSync(path.join(process.cwd(), "app/(app)/central-ia/estudio-anuncios/[projetoId]/DadosPublicacao.tsx"), "utf-8");
    const bloco = ui.slice(ui.indexOf("const medida ="), ui.indexOf("if (Object.keys(corpo)"));
    assert(!arred.test(bloco), "a UI arredonda a medida antes de enviar");
  });
  await t("116. mudar a medida continua mudando o hash", () => {
    const base = calcularHashEntrada(entradaCompleta(), VERSAO_REGRAS_ML);
    const outro = calcularHashEntrada(entradaCompleta({ embalagem: { ...EMB_OK, alturaCm: 9 } }), VERSAO_REGRAS_ML);
    assert(base !== outro, "mudar a altura não mudou o hash");
    assert(base === calcularHashEntrada(entradaCompleta(), VERSAO_REGRAS_ML), "o hash deixou de ser determinístico");
  });
  await t("117. o modelo LEGADO não regride com a mudança", () => {
    const a = montarPayloadPublicacaoMercadoLivre({
      payloadCompliance: pComp, lojaId: "loja-1", versaoAprovadaId: "v-1",
      modelo: "legacy", embalagem: EMB_OK,
    });
    assert(a.completo && (a.payload as any).title === "Título legado", "o legado quebrou");
    assert(!a.payload.attributes.some(x => /^SELLER_PACKAGE_/.test(x.id)), "o legado ganhou atributo de embalagem");
  });
  await t("118. User Products não regride: inteiro passa, decimal bloqueia antes do ML", () => {
    const a = montarPayloadPublicacaoMercadoLivre({
      payloadCompliance: pComp, lojaId: "loja-1", versaoAprovadaId: "v-1",
      modelo: "user_products", familyName: "X", embalagem: EMB_OK,
    });
    assert(a.completo, `deveria estar completo: ${a.camposFaltando.join(",")}`);
    // O decimal é barrado no PARECER, não no adapter — nunca chega ao
    // `/items/validate`.
    const r = val(entradaCompleta({ embalagem: { ...EMB_OK, larguraCm: 13.5 } }));
    assert(temBloqueio(r, "ml_embalagem_medida_nao_inteira"), "decimal deveria bloquear o parecer");
    assert(!temBloqueio(r, "ml_largura_embalagem_nao_informada"), "informado errado não é o mesmo que não informado");
  });
  await t("119. o parecer distingue AUSENTE de FORMATO INVÁLIDO", () => {
    const ausente = val(entradaCompleta({ embalagem: { ...EMB_OK, larguraCm: null } }));
    assert(temBloqueio(ausente, "ml_largura_embalagem_nao_informada"), "ausente deveria pedir preencher");
    assert(!temBloqueio(ausente, "ml_embalagem_medida_nao_inteira"), "ausente não é formato inválido");

    const invalido = val(entradaCompleta({ embalagem: { ...EMB_OK, larguraCm: 13.5 } }));
    assert(temBloqueio(invalido, "ml_embalagem_medida_nao_inteira"), "decimal deveria pedir corrigir");
    const b = invalido.bloqueios.find(x => x.codigo === "ml_embalagem_medida_nao_inteira");
    assert(/largura \(13\.5 cm\)/.test(b?.mensagem ?? ""), `o bloqueio deveria dizer qual medida: ${b?.mensagem}`);
    // Com tudo inteiro, nenhum dos dois aparece.
    assert(!val(entradaCompleta()).bloqueios.some(x => /embalagem/.test(x.codigo)), "inteiro válido não pode bloquear");
  });
  await t("120. a migration de inteiros não arredonda e audita antes", () => {
    const M = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260828_embalagem_inteiros.sql"), "utf-8");
    const sql = M.replace(/^\s*--.*$/gm, " ").replace(/IS\s+'[^']*'/g, " ");
    assert(/TYPE INTEGER/i.test(sql), "as colunas deveriam virar INTEGER");
    assert(/EMBALAGEM_DECIMAL_PERSISTIDO/.test(sql), "faltou a trava que recusa converter decimal existente");
    assert(/EMBALAGEM_VALOR_NAO_INTEIRO/.test(sql), "a RPC deveria recusar decimal");
    assert(!/round\(|ceil\(|floor\(/i.test(sql), "a migration arredonda em algum ponto");
    // Parâmetro NUMERIC de propósito: INTEGER faria o Postgres arredondar
    // 13.5 -> 14 no cast, exatamente o que não pode acontecer.
    assert(/p_altura_cm\s+NUMERIC/i.test(sql), "o parâmetro da RPC deveria seguir NUMERIC");
    assert(!/DROP FUNCTION/i.test(sql), "a migration derruba função");
  });

  // ── Imagens: identidade estável vs transporte efêmero (2026-08-29) ──
  // O fio da seção: o que identifica uma imagem é `id + checksum`; a URL
  // assinada é credencial de download, vive minutos e não pode encostar
  // no hash nem no banco.
  console.log("\n[imagens — seleção determinística e URL efêmera]");

  const img = (id: string, over: any = {}) => imagem({ imagemGeradaId: id, checksum: `${id}`.padEnd(64, "0"), ...over });
  const catMax = (max: number | null) => categoria({ settings: { maxPicturesPerItem: max } });

  await t("121. zero imagens bloqueia — e o payload sai sem pictures", () => {
    const r = val(entradaCompleta({ imagens: [] }));
    assert(temBloqueio(r, "ml_sem_imagem"), "faltou o bloqueio de imagem ausente");
    assert(((r.payload as any).pictures ?? []).length === 0, "não deveria inventar imagem");
  });
  await t("122. uma imagem válida basta e entra no payload", () => {
    const r = val(entradaCompleta({ imagens: [img("a", { principal: true, ordem: 1 })] }));
    assert(!temBloqueio(r, "ml_sem_imagem") && !temBloqueio(r, "ml_sem_imagem_valida_para_envio"), "não deveria bloquear");
    assert((r.payload as any).pictures.length === 1, "a imagem deveria entrar no payload");
  });
  await t("123. múltiplas imagens entram todas quando cabem no limite", () => {
    const tres = [img("a", { principal: true, ordem: 1 }), img("b", { principal: false, ordem: 2 }), img("c", { principal: false, ordem: 3 })];
    const r = val(entradaCompleta({ categoriaMarketplace: catMax(12), imagens: tres }));
    assert((r.payload as any).pictures.length === 3, "as três deveriam entrar");
  });
  await t("124. a PRINCIPAL vem primeiro, mesmo cadastrada por último", () => {
    const fora = [img("z", { principal: false, ordem: 1 }), img("p", { principal: true, ordem: 9 })];
    const s = selecionarImagensML(fora as any, 12);
    assert(s.selecionadas[0].imagemGeradaId === "p", `capa errada: ${s.selecionadas[0].imagemGeradaId}`);
  });
  await t("125. a ordem é determinística e desempata por id", () => {
    // Mesma `ordem` nas duas: sem o desempate por id, a posição poderia
    // trocar entre execuções e mudar o hash sem nada ter mudado.
    const a = selecionarImagensML([img("b", { principal: false, ordem: 2 }), img("a", { principal: false, ordem: 2 })] as any, 12);
    const b = selecionarImagensML([img("a", { principal: false, ordem: 2 }), img("b", { principal: false, ordem: 2 })] as any, 12);
    assert(a.selecionadas.map(x => x.imagemGeradaId).join() === b.selecionadas.map(x => x.imagemGeradaId).join(),
      "a ordem mudou com a ordem de entrada");
    assert(a.selecionadas[0].imagemGeradaId === "a", "o desempate deveria ser por id");
  });
  await t("126. o limite vem da CATEGORIA, nunca de número fixo", () => {
    const cinco = ["a", "b", "c", "d", "e"].map((id, i) => img(id, { principal: i === 0, ordem: i + 1 }));
    assert(selecionarImagensML(cinco as any, 2).selecionadas.length === 2, "limite 2 não respeitado");
    assert(selecionarImagensML(cinco as any, 12).selecionadas.length === 5, "limite 12 deveria caber todas");
    // Limite desconhecido não pode virar corte inventado.
    assert(selecionarImagensML(cinco as any, null).selecionadas.length === 5, "sem limite não se corta");
  });
  await t("127. o excedente é cortado pelo FIM da ordem, nunca aleatoriamente", () => {
    const cinco = ["a", "b", "c", "d", "e"].map((id, i) => img(id, { principal: i === 0, ordem: i + 1 }));
    const s = selecionarImagensML(cinco as any, 3);
    assert(s.selecionadas.map(x => x.imagemGeradaId).join() === "a,b,c", "corte errado");
    assert(s.excedentes.map(x => x.imagemGeradaId).join() === "d,e", "excedentes errados");
  });
  await t("128. imagem sem objeto no Storage não é selecionada", () => {
    const s = selecionarImagensML([img("a", { temArquivo: false }), img("b", { principal: false, ordem: 2 })] as any, 12);
    assert(s.selecionadas.map(x => x.imagemGeradaId).join() === "b", "a sem arquivo entrou");
    assert(s.invalidas[0].motivo === "sem arquivo no Storage", s.invalidas[0]?.motivo);
  });
  await t("129. MIME fora de JPG/PNG não é selecionado", () => {
    const s = selecionarImagensML([img("a", { mimeType: "image/webp" }), img("b", { principal: false, ordem: 2 })] as any, 12);
    assert(s.selecionadas.map(x => x.imagemGeradaId).join() === "b", "webp entrou");
    assert(/webp/.test(s.invalidas[0].motivo), s.invalidas[0]?.motivo);
  });
  await t("130. dimensão abaixo do mínimo não é selecionada; acima do máximo É", () => {
    const s = selecionarImagensML([img("a", { largura: 400, altura: 400 })] as any, 12);
    assert(s.selecionadas.length === 0 && /abaixo de 500/.test(s.invalidas[0].motivo), "pequena deveria sair");
    // Acima de 1920 o ML REDIMENSIONA (fonte [B]) — é enviável.
    const g = selecionarImagensML([img("b", { largura: 4000, altura: 4000 })] as any, 12);
    assert(g.selecionadas.length === 1, "grande demais não pode ser excluída em silêncio");
  });
  await t("131. todas inválidas → bloqueio próprio, e nada é enviado", () => {
    const r = val(entradaCompleta({ imagens: [img("a", { temArquivo: false }), img("b", { temArquivo: false })] }));
    assert(temBloqueio(r, "ml_sem_imagem_valida_para_envio"), "faltou o bloqueio de 'nenhuma enviável'");
    assert((r.payload as any).pictures.length === 0, "não deveria enviar imagem inválida");
    assert(!temBloqueio(r, "ml_sem_imagem"), "'sem imagem' é outro caso — havia imagens");
  });
  await t("132. imagem de OUTRO projeto não é alcançável pela leitura", () => {
    // A consulta filtra por `projeto_id` além do `id` — não existe
    // caminho de código que leia imagem de outro projeto.
    const F = fs.readFileSync(path.join(process.cwd(), "lib/estudio-anuncios/compliance/imagens-ml.ts"), "utf-8");
    const bloco = F.slice(F.indexOf("export async function lerImagemGeradaDoProjeto"));
    assert(/\.eq\("id", imagemGeradaId\)/.test(bloco) && /\.eq\("projeto_id", projetoId\)/.test(bloco),
      "a leitura precisa filtrar por id E por projeto");
  });
  await t("133. NENHUMA signed URL é persistida ou hasheada", () => {
    const F = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf-8");
    const payloadMl = F("lib/estudio-anuncios/compliance/payload-ml.ts");
    // O hash canônico não pode conter `source` nem `url`.
    // Sem comentários: eles falam de URL justamente para explicar que
    // ela NÃO entra.
    const inicio = payloadMl.indexOf("export function calcularHashPayload");
    const hash = payloadMl
      .slice(inicio, payloadMl.indexOf("\nexport ", inicio + 1))
      .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
    assert(!/source|signedUrl|\burl\b/i.test(hash), "URL entrou no hash do payload");
    const val0 = F("lib/estudio-anuncios/compliance/validacao-oficial.ts");
    // O que é persistido é o artefato canônico, não o de transporte.
    // Com picture ids, que são estáveis — nunca o de transporte.
    assert(/p_payload: artefatoFinal\.payload/.test(val0), "deveria persistir o payload canônico");
    assert(!/p_payload: payloadTransporte/.test(val0), "o payload de transporte NÃO pode ser persistido");
    assert(!/console\.(log|error|warn)\([^)]*url/i.test(val0), "URL em log");
    const imgs = F("lib/estudio-anuncios/compliance/imagens-ml.ts");
    assert(!/console\./.test(imgs), "a camada de imagens não deveria logar nada");
  });
  await t("134. duas URLs diferentes representam a MESMA entrada canônica", () => {
    // É este teste que sustenta a separação identidade/transporte: o
    // hash não pode depender de credencial efêmera.
    const canonico = {
      payloadCompliance: { ...pComp, pictures: [{ imagem_gerada_id: "img-1", checksum: "a".repeat(64), ordem: 1, principal: true }] },
      lojaId: "loja-1", versaoAprovadaId: "v-1", modelo: "user_products" as const,
      familyName: "X", embalagem: EMB_OK,
    };
    const a = montarPayloadPublicacaoMercadoLivre(canonico);
    const b = montarPayloadPublicacaoMercadoLivre(canonico);
    assert(a.hashPayload === b.hashPayload, "o hash canônico deveria ser estável");
    const t1 = transporteSource(a.payload, new Map([["img-1", "https://x/obj?token=AAA"]]));
    const t2 = transporteSource(a.payload, new Map([["img-1", "https://x/obj?token=BBB"]]));
    assert(t1.pictures[0].source !== t2.pictures[0].source, "as URLs deveriam ser diferentes");
    assert(a.hashPayload === b.hashPayload, "URL diferente não pode mexer no hash");
  });
  await t("135. trocar o CHECKSUM (mesmo id) muda o hash — imagem diferente", () => {
    const base = (checksum: string) => montarPayloadPublicacaoMercadoLivre({
      payloadCompliance: { ...pComp, pictures: [{ imagem_gerada_id: "img-1", checksum, ordem: 1, principal: true }] },
      lojaId: "loja-1", versaoAprovadaId: "v-1", modelo: "user_products", familyName: "X", embalagem: EMB_OK,
    }).hashPayload;
    assert(base("a".repeat(64)) !== base("b".repeat(64)), "trocar os bytes precisa invalidar a validação");
    // E trocar o ID também.
    const outroId = montarPayloadPublicacaoMercadoLivre({
      payloadCompliance: { ...pComp, pictures: [{ imagem_gerada_id: "img-9", checksum: "a".repeat(64), ordem: 1, principal: true }] },
      lojaId: "loja-1", versaoAprovadaId: "v-1", modelo: "user_products", familyName: "X", embalagem: EMB_OK,
    }).hashPayload;
    assert(outroId !== base("a".repeat(64)), "trocar a imagem precisa invalidar");
  });
  await t("136. o checksum do parecer entra no hash da ENTRADA", () => {
    const h = (c: string) => calcularHashEntrada(entradaCompleta({ imagens: [imagem({ checksum: c })] }), VERSAO_REGRAS_ML);
    assert(h("a".repeat(64)) !== h("b".repeat(64)), "checksum não entrou no hash da entrada");
  });
  await t("137. a URL de transporte é expirável e o TTL é explícito", () => {
    assert(Number.isInteger(TTL_URL_TRANSPORTE_ML_SEGUNDOS) && TTL_URL_TRANSPORTE_ML_SEGUNDOS > 0,
      "TTL precisa ser um número de segundos");
    assert(TTL_URL_TRANSPORTE_ML_SEGUNDOS <= 900, `TTL longo demais: ${TTL_URL_TRANSPORTE_ML_SEGUNDOS}s`);
    const S = fs.readFileSync(path.join(process.cwd(), "lib/estudio-anuncios/storage.ts"), "utf-8");
    assert(!/getPublicUrl|public:\s*true/.test(S), "há URL pública no Storage");
  });
  await t("138. o builder User Products envia pictures como `source`", () => {
    const a = montarPayloadPublicacaoMercadoLivre({
      payloadCompliance: { ...pComp, pictures: [{ imagem_gerada_id: "i1", checksum: "a".repeat(64), ordem: 1, principal: true }] },
      lojaId: "loja-1", versaoAprovadaId: "v-1", modelo: "user_products", familyName: "X", embalagem: EMB_OK,
    });
    assert(a.completo, `deveria estar completo: ${a.camposFaltando.join(",")}`);
    const tr = transporteSource(a.payload, new Map([["i1", "https://x/o?token=T"]]));
    assert(tr.pictures.length === 1 && tr.pictures[0].source === "https://x/o?token=T", "faltou a source");
    assert(!("title" in tr), "User Products não pode enviar title");
    assert((tr as any).family_name === "X", "family_name sumiu");
    assert(!("variations" in tr), "variations não pode existir");
  });
  await t("139. sem imagem, o payload fica INCOMPLETO e o portão barra", () => {
    const a = montarPayloadPublicacaoMercadoLivre({
      payloadCompliance: { ...pComp, pictures: [] },
      lojaId: "loja-1", versaoAprovadaId: "v-1", modelo: "user_products", familyName: "X", embalagem: EMB_OK,
    });
    assert(!a.completo && a.camposFaltando.includes("pictures"), `camposFaltando: ${a.camposFaltando.join(",")}`);
  });
  await t("140. o LEGADO não regride e recebe pictures pelo mesmo helper", () => {
    const a = montarPayloadPublicacaoMercadoLivre({
      payloadCompliance: pComp, lojaId: "loja-1", versaoAprovadaId: "v-1", modelo: "legacy",
    });
    assert(a.completo, `legado deveria seguir completo: ${a.camposFaltando.join(",")}`);
    assert((a.payload as any).title === "Título legado", "o legado perdeu o title");
    assert(!("family_name" in a.payload), "o legado ganhou family_name");
    assert(a.payload.pictures.length === 1, "o legado deveria receber pictures pelo mesmo caminho");
    const tr = transporteSource(a.payload, new Map([["img-1", "https://x/o?t=1"]]));
    assert(tr.pictures[0].source === "https://x/o?t=1" && (tr as any).title === "Título legado", "transporte quebrou o legado");
  });
  await t("141. imagem sem URL é DESCARTADA, nunca substituída por outra", () => {
    const a = montarPayloadPublicacaoMercadoLivre({
      payloadCompliance: { ...pComp, pictures: [
        { imagem_gerada_id: "i1", checksum: "a".repeat(64), ordem: 1, principal: true },
        { imagem_gerada_id: "i2", checksum: "b".repeat(64), ordem: 2, principal: false },
      ] },
      lojaId: "loja-1", versaoAprovadaId: "v-1", modelo: "user_products", familyName: "X", embalagem: EMB_OK,
    });
    const tr = transporteSource(a.payload, new Map([["i2", "https://x/o?t=2"]]));
    assert(tr.pictures.length === 1 && tr.pictures[0].source === "https://x/o?t=2", "substituiu a capa por outra imagem");
  });
  await t("142. o upload acontece entre o artefato e a chamada, e confere o checksum", () => {
    const V = fs.readFileSync(path.join(process.cwd(), "lib/estudio-anuncios/compliance/validacao-oficial.ts"), "utf-8");
    const iArtefato = V.indexOf("montarPayloadPublicacaoMercadoLivre({");
    const iPics = V.indexOf("garantirPicturesML(");
    const iChamada = V.indexOf("validarItemML(");
    assert(iArtefato < iPics && iPics < iChamada, "o upload precisa vir depois do artefato e antes da chamada");
    assert(/payloadTransporte as unknown as Record/.test(V), "a chamada deveria enviar o payload de transporte");
    const P = fs.readFileSync(path.join(process.cwd(), "lib/estudio-anuncios/compliance/pictures-ml.ts"), "utf-8");
    assert(/lida\.checksum !== c\.checksum/.test(P), "faltou conferir o checksum antes de subir");
    const I = fs.readFileSync(path.join(process.cwd(), "lib/estudio-anuncios/compliance/imagens-ml.ts"), "utf-8");
    assert(/lida\.checksum !== c\.checksum/.test(I), "o caminho por URL também precisa conferir");
  });
  await t("143. o compliance fica STALE quando a imagem muda, e só então", () => {
    const base = calcularHashEntrada(entradaCompleta(), VERSAO_REGRAS_ML);
    assert(calcularHashEntrada(entradaCompleta(), VERSAO_REGRAS_ML) === base, "hash instável sem mudança");
    assert(calcularHashEntrada(entradaCompleta({ imagens: [imagem({ imagemGeradaId: "outra" })] }), VERSAO_REGRAS_ML) !== base,
      "trocar a imagem deveria invalidar o parecer");
  });
  await t("144. ZERO publicação, ZERO bucket público, ZERO IA nesta camada", () => {
    const I = fs.readFileSync(path.join(process.cwd(), "lib/estudio-anuncios/compliance/imagens-ml.ts"), "utf-8");
    assert(!/POST \/items[^/]|criarAnuncio|publicarAnuncio|publishItem/i.test(I), "há caminho de publicação");
    assert(!/getPublicUrl|updateBucket|createBucket|public:\s*true/.test(I), "mexe em visibilidade de bucket");
    assert(!/openai|anthropic|gemini|generateContent|IA_/i.test(I), "há IA nesta camada");
    assert(!/base64|toString\("base64"\)/.test(I), "está embutindo bytes no payload");
  });

  // ── Pictures no CDN do Mercado Livre (2026-08-30) ───────────────────
  // O caminho principal deixou de ser a URL assinada: o `picture id` é
  // estável para a conta, então o payload validado e o que uma
  // publicação futura enviaria passam a ser o MESMO objeto.
  console.log("\n[pictures — upload oficial e mapa idempotente]");

  const picsCanon = (over: any = {}) => [{
    imagem_gerada_id: "i1", checksum: "a".repeat(64), ordem: 1, principal: true, ...over,
  }];
  const artUP = (pictures: any[], picturesML?: Map<string, string>) =>
    montarPayloadPublicacaoMercadoLivre({
      payloadCompliance: { ...pComp, pictures },
      lojaId: "loja-1", versaoAprovadaId: "v-1", modelo: "user_products",
      familyName: "X", embalagem: EMB_OK, picturesML,
    });

  await t("145. o payload leva `pictures: [{ id }]` com o picture id do ML", () => {
    const a = artUP(picsCanon(), new Map([["i1", "959699-MLB123_092026"]]));
    assert(a.payload.pictures[0].ml_picture_id === "959699-MLB123_092026", "o id não entrou no canônico");
    const tr = montarPayloadTransportePorId(a.payload);
    assert(tr.pictures.length === 1 && (tr.pictures[0] as any).id === "959699-MLB123_092026", "transporte errado");
    assert(!("source" in tr.pictures[0]), "não deveria mandar source no caminho principal");
  });
  await t("146. o picture id NÃO é inventado quando falta", () => {
    const a = artUP(picsCanon());
    assert(a.payload.pictures[0].ml_picture_id === null, "não pode inventar id");
    assert(montarPayloadTransportePorId(a.payload).pictures.length === 0, "sem id, nada é enviado");
  });
  await t("147. imagem sem picture id é DESCARTADA, nunca substituída", () => {
    const a = artUP(
      [...picsCanon(), { imagem_gerada_id: "i2", checksum: "b".repeat(64), ordem: 2, principal: false }],
      new Map([["i2", "PIC-2"]])
    );
    const tr = montarPayloadTransportePorId(a.payload);
    assert(tr.pictures.length === 1 && (tr.pictures[0] as any).id === "PIC-2", "trocou a capa por outra imagem");
  });
  await t("148. a ORDEM é preservada: a capa continua primeiro", () => {
    const a = artUP(
      [{ imagem_gerada_id: "capa", checksum: "a".repeat(64), ordem: 1, principal: true },
       { imagem_gerada_id: "b", checksum: "b".repeat(64), ordem: 2, principal: false }],
      new Map([["capa", "PIC-CAPA"], ["b", "PIC-B"]])
    );
    const ids = montarPayloadTransportePorId(a.payload).pictures.map(p => (p as any).id);
    assert(ids.join(",") === "PIC-CAPA,PIC-B", `ordem errada: ${ids.join(",")}`);
  });
  await t("149. o picture id entra no hash; a signed URL nunca", () => {
    const sem = artUP(picsCanon()).hashPayload;
    const com = artUP(picsCanon(), new Map([["i1", "PIC-1"]])).hashPayload;
    const outro = artUP(picsCanon(), new Map([["i1", "PIC-9"]])).hashPayload;
    assert(sem !== com, "o picture id precisa entrar no hash");
    assert(com !== outro, "trocar o picture id precisa mudar o hash");
    // Mesmo id → mesmo hash: estável, ao contrário da URL.
    assert(com === artUP(picsCanon(), new Map([["i1", "PIC-1"]])).hashPayload, "hash instável");
  });
  await t("150. trocar o CHECKSUM muda o hash mesmo com o mesmo picture id", () => {
    const a = artUP(picsCanon(), new Map([["i1", "PIC-1"]])).hashPayload;
    const b = artUP(picsCanon({ checksum: "b".repeat(64) }), new Map([["i1", "PIC-1"]])).hashPayload;
    assert(a !== b, "bytes diferentes precisam invalidar a validação");
  });
  await t("151. o mapa é consultado por (loja, imagem, CHECKSUM) — as três", () => {
    const P = fs.readFileSync(path.join(process.cwd(), "lib/estudio-anuncios/compliance/pictures-ml.ts"), "utf-8");
    const bloco = P.slice(P.indexOf("async function buscarPictureNoMapa"));
    assert(/\.eq\("loja_id", lojaId\)/.test(bloco), "faltou filtrar por loja");
    assert(/\.eq\("imagem_gerada_id", imagemGeradaId\)/.test(bloco), "faltou filtrar por imagem");
    assert(/\.eq\("checksum_sha256", checksum\)/.test(bloco), "faltou filtrar por checksum");
  });
  await t("152. checksum alterado NÃO reutiliza o picture id antigo", () => {
    // Garantia estrutural: a identidade do mapa inclui o checksum, tanto
    // na consulta quanto no índice UNIQUE.
    const M = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260830_pictures_mercado_livre.sql"), "utf-8");
    assert(/uq_pictures_ml_identidade[\s\S]*?\(loja_id, imagem_gerada_id, checksum_sha256\)/.test(M),
      "o UNIQUE precisa incluir o checksum");
  });
  await t("153. a imagem precisa ser DO PROJETO — conferido também no banco", () => {
    const M = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260830_pictures_mercado_livre.sql"), "utf-8");
    assert(/IMAGEM_NAO_PERTENCE_AO_PROJETO/.test(M), "a RPC deveria recusar imagem de outro projeto");
    const P = fs.readFileSync(path.join(process.cwd(), "lib/estudio-anuncios/compliance/pictures-ml.ts"), "utf-8");
    assert(/lerImagemGeradaDoProjeto\(supabaseServico, params\.projetoId/.test(P), "a leitura precisa ser por projeto");
  });
  await t("154. loja de outro usuário nem chega ao upload", () => {
    // `carregarContaML` confere user_id + marketplace + ativo ANTES de
    // entregar a conta; sem conta, `garantirPicturesML` não é chamado.
    const V = fs.readFileSync(path.join(process.cwd(), "lib/estudio-anuncios/compliance/validacao-oficial.ts"), "utf-8");
    const iConta = V.indexOf("carregarContaML(");
    const iPics = V.indexOf("garantirPicturesML(");
    assert(iConta > 0 && iConta < iPics, "a conta precisa ser validada antes do upload");
    const C = fs.readFileSync(path.join(process.cwd(), "lib/estudio-anuncios/compliance/ml-conta.ts"), "utf-8");
    const bloco = C.slice(C.indexOf("export async function carregarContaML"));
    assert(/user_id/.test(bloco) && /ativo/.test(bloco), "a conta deveria conferir dono e estado");
  });
  await t("155. MIME inválido não sobe, e vem do CAMINHO do Storage", () => {
    const P = fs.readFileSync(path.join(process.cwd(), "lib/estudio-anuncios/compliance/pictures-ml.ts"), "utf-8");
    const bloco = P.slice(P.indexOf("function mimeDoCaminho"));
    assert(/image\/jpeg/.test(bloco) && /image\/png/.test(bloco), "só JPG/PNG");
    assert(!/webp|gif|bmp/i.test(bloco), "aceitou formato fora do contrato");
    assert(/MIMES_IMAGEM_ML/.test(bloco), "deveria conferir contra a lista oficial");
  });
  await t("156. checksum divergente bloqueia ANTES do upload", () => {
    const P = fs.readFileSync(path.join(process.cwd(), "lib/estudio-anuncios/compliance/pictures-ml.ts"), "utf-8");
    const iCheck = P.indexOf("lida.checksum !== c.checksum");
    const iUpload = P.indexOf("subirImagemML(conta");
    assert(iCheck > 0 && iCheck < iUpload, "a conferência precisa vir antes de subir");
  });
  await t("157. token NUNCA é persistido, nem no metadado da picture", () => {
    const M = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260830_pictures_mercado_livre.sql"), "utf-8");
    assert(/chk_pic_sem_credencial/.test(M) && /access_token/.test(M), "faltou o CHECK anti-credencial");
    const P = fs.readFileSync(path.join(process.cwd(), "lib/estudio-anuncios/compliance/pictures-ml.ts"), "utf-8");
    assert(!/accessToken/.test(P.replace(/\/\*[\s\S]*?\*\//g, " ")), "a camada de pictures não deveria tocar no token");
    const C = fs.readFileSync(path.join(process.cwd(), "lib/estudio-anuncios/compliance/ml-conta.ts"), "utf-8");
    // Limita ao corpo de subirImagemML: o arquivo ganhou outras funções
    // depois dela, cada uma com seu próprio header.
    const up = C.slice(C.indexOf("export async function subirImagemML"), C.indexOf("// PUBLICAÇÃO REAL"));
    assert((up.match(/accessToken/g) ?? []).length === 1, "o token só pode aparecer no header");
  });
  await t("158. concorrência: o UNIQUE decide, e o perdedor vira órfão REPORTADO", () => {
    const M = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260830_pictures_mercado_livre.sql"), "utf-8");
    assert(/ON CONFLICT \(loja_id, imagem_gerada_id, checksum_sha256\) DO NOTHING/.test(M), "faltou o ON CONFLICT");
    assert(!/UPDATE public\.estudio_anuncios_pictures_marketplace/.test(M), "a RPC não pode fazer UPDATE");
    const P = fs.readFileSync(path.join(process.cwd(), "lib/estudio-anuncios/compliance/pictures-ml.ts"), "utf-8");
    assert(/vencedor !== picture\.id/.test(P), "o perdedor da corrida precisa ser detectado");
    assert(/orfaos\.push/.test(P), "o órfão precisa ser reportado");
  });
  await t("159. upload PARCIAL não é enviado como se estivesse completo", () => {
    const V = fs.readFileSync(path.join(process.cwd(), "lib/estudio-anuncios/compliance/validacao-oficial.ts"), "utf-8");
    assert(/pics\.falhas\.length > 0 \|\| pics\.resolvidas\.length === 0/.test(V), "falha parcial deveria recusar");
    assert(/payloadTransporte\.pictures\.length !== artefatoFinal\.payload\.pictures\.length/.test(V),
      "faltou conferir que TODAS as imagens têm id");
  });
  await t("160. o retry continua das faltantes, sem repetir upload", () => {
    const P = fs.readFileSync(path.join(process.cwd(), "lib/estudio-anuncios/compliance/pictures-ml.ts"), "utf-8");
    // `continue` em vez de `throw`: uma falha não aborta as demais, e o
    // mapa faz a próxima tentativa pular o que já subiu.
    const bloco = P.slice(P.indexOf("export async function garantirPicturesML"));
    assert((bloco.match(/continue;/g) ?? []).length >= 5, "cada falha deveria seguir para a próxima imagem");
    assert(/if \(jaMapeado\)/.test(bloco), "o que já subiu não pode subir de novo");
  });
  await t("161. o caminho por URL assinada continua existindo, isolado", () => {
    const PM = fs.readFileSync(path.join(process.cwd(), "lib/estudio-anuncios/compliance/payload-ml.ts"), "utf-8");
    assert(/export function montarPayloadTransporteML/.test(PM), "o caminho por source foi apagado");
    assert(/export function montarPayloadTransportePorId/.test(PM), "faltou o caminho por id");
    // Mas a validação oficial usa o caminho por ID.
    const V = fs.readFileSync(path.join(process.cwd(), "lib/estudio-anuncios/compliance/validacao-oficial.ts"), "utf-8");
    assert(/montarPayloadTransportePorId\(/.test(V), "a validação deveria usar o picture id");
    assert(!/montarPayloadTransporteML\(/.test(V), "a validação não deveria mais usar signed URL");
  });
  await t("162. o hash da GET e o da validação derivam o id da MESMA fonte", () => {
    // Foi exatamente aqui que nasceu o defeito de 2026-08-29 com o
    // checksum: dois lados da comparação enxergando dados diferentes.
    const R = fs.readFileSync(path.join(process.cwd(), "app/api/estudio-anuncios/projetos/[id]/route.ts"), "utf-8");
    assert(/buscarPicturesMapeadas\(/.test(R), "o GET precisa resolver os picture ids");
    assert(/picturesML,/.test(R), "o hash do GET precisa incluir os ids");
    const P = fs.readFileSync(path.join(process.cwd(), "lib/estudio-anuncios/compliance/pictures-ml.ts"), "utf-8");
    const bloco = P.slice(P.indexOf("export async function buscarPicturesMapeadas"));
    assert(/estudio_anuncios_pictures_marketplace/.test(bloco), "deveria ler o mesmo mapa");
    assert(!/subirImagemML/.test(bloco), "o GET não pode subir imagem");
  });
  await t("163. a camada de PICTURES não publica, e a validação também não", () => {
    for (const rel of [
      // `ml-conta.ts` saiu da lista em 2026-08-31: é o cliente HTTP, e
      // é lá — e só lá — que `POST /items` passou a existir, atrás do
      // portão e da reserva. Ver testes 40–63 em testar-validacao-oficial.
      "lib/estudio-anuncios/compliance/pictures-ml.ts",
      "lib/estudio-anuncios/compliance/validacao-oficial.ts",
    ]) {
      const f = fs.readFileSync(path.join(process.cwd(), rel), "utf-8")
        .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
      assert(!/chamar\("\/items"|fetch\([^)]*\/items[^/]/.test(f), `${rel} tem caminho de publicação`);
      assert(!/criarAnuncio|publicarAnuncio|publishItem/i.test(f), `${rel} tem função de publicação`);
    }
  });

  await t("164. 401/403/429/5xx/timeout no UPLOAD viram falha, nunca sucesso", () => {
    const C = fs.readFileSync(path.join(process.cwd(), "lib/estudio-anuncios/compliance/ml-conta.ts"), "utf-8");
    const up = C.slice(C.indexOf("export async function subirImagemML"));
    // Só 200/201 são sucesso; todo o resto sobe como ErroML classificado.
    assert(/status === 200 \|\| status === 201/.test(up), "só 2xx pode ser sucesso");
    assert(/classificar\(status\)/.test(up), "o status precisa ser classificado (auth/rate_limit/transient)");
    assert(/abort\|timeout/.test(up), "timeout precisa ser tratado");
    assert(/"transient"/.test(up), "timeout/rede deveriam ser transitórios");
    // 200 sem id não pode virar picture inventada.
    assert(/não devolveu um picture id/.test(up), "200 sem id deveria falhar explicitamente");
    const P = fs.readFileSync(path.join(process.cwd(), "lib/estudio-anuncios/compliance/pictures-ml.ts"), "utf-8");
    assert(/falhas\.push\(\{ imagemGeradaId: c\.imagemGeradaId, motivo: `\$\{err\.tipo\}/.test(P),
      "o tipo do erro deveria chegar ao relatório de falhas");
  });
  await t("165. o content-type do multipart NÃO é escrito à mão", () => {
    // O boundary é gerado pelo fetch a partir do FormData; escrevê-lo à
    // mão produz um 400 difícil de diagnosticar.
    const C = fs.readFileSync(path.join(process.cwd(), "lib/estudio-anuncios/compliance/ml-conta.ts"), "utf-8");
    const up = C.slice(C.indexOf("export async function subirImagemML"));
    assert(/new FormData\(\)/.test(up), "deveria usar FormData");
    assert(!/multipart\/form-data"/.test(up.replace(/\/\*[\s\S]*?\*\//g, " ")), "não defina o content-type à mão");
  });

  console.log("\n[garantias estruturais — código, banco, rota e UI]");
  const semComentarios = (f: string) => f.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  const ler = (p: string) => semComentarios(fs.readFileSync(path.join(process.cwd(), p), "utf-8"));
  const LIB = ler("lib/estudio-anuncios/compliance/compliance.ts");
  const VALIDADOR = ler("lib/estudio-anuncios/compliance/mercado-livre.ts");
  const REGISTRY = ler("lib/estudio-anuncios/compliance/registry.ts");
  const REGRAS = ler("lib/estudio-anuncios/compliance/regras-mercado-livre.ts");
  const ROTA = ler("app/api/estudio-anuncios/projetos/[id]/compliance/[marketplace]/route.ts");
  const UI = ler("app/(app)/central-ia/estudio-anuncios/[projetoId]/PrePublicacao.tsx");
  const MIG = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260823_compliance_marketplace.sql"), "utf-8");
  const TODOS = [["lib", LIB], ["validador", VALIDADOR], ["registry", REGISTRY], ["regras", REGRAS], ["rota", ROTA], ["ui", UI]] as const;

  await t("45. ZERO IA e zero custo de IA em toda a camada", () => {
    for (const [nome, f] of TODOS) {
      assert(!/genai|gemini|anthropic|ai-gateway|registrarConsumo|estimarCustoUsd|openai/i.test(f), `${nome} toca em IA`);
    }
  });
  await t("46. NÃO publica: nenhuma chamada a API de marketplace nem OAuth", () => {
    for (const [nome, f] of TODOS) {
      // No registro de regras o host aparece como CITAÇÃO de origem
      // ("a API declarou isto"), nunca como destino de chamada — por
      // isso ele é conferido à parte, logo abaixo.
      const semFontes = f.replace(/const FONTE_[A-Z_]+ = "[^"]*";/g, "");
      assert(!/api\.mercadolibre|partner\.shopeemobile|shopee-auth|ml-auth|getMLToken|refreshShopeeToken/i.test(semFontes), `${nome} chama marketplace/OAuth`);
      // Procura AÇÃO de publicar (função/chamada), não a palavra
      // "publicar" em texto — ela aparece legitimamente em mensagens
      // ("informe o preço antes de publicar") e na citação da fonte
      // oficial que descreve `POST /items/validate`.
      //
      // A UI é exceção desde 2026-08-31: ela RENDERIZA o componente de
      // publicação, que vive em arquivo próprio. Importar não é publicar
      // — e a checagem logo abaixo garante que ela não implementa nada.
      if (nome === "ui") continue;
      assert(!/criarAnuncio|publicarAnuncio|publishItem|criarItem/i.test(f), `${nome} tem função de publicação`);
    }
    // A UI de pré-publicação não pode conter a chamada de publicação:
    // no máximo importar o componente que a faz.
    assert(!/fetch\([^)]*publicar/.test(UI), "a UI de pré-publicação está publicando por conta própria");
    // Todo `api.mercadolibre` no registro de regras vive dentro de uma
    // constante `FONTE_*` — é procedência, não chamada.
    const foraDeFonte = REGRAS.replace(/const FONTE_[A-Z_]+ = "[^"]*";/g, "");
    assert(!/api\.mercadolibre/.test(foraDeFonte), "o registro de regras cita a API fora de uma FONTE_*");
    // A garantia real: nenhuma das quatro peças de domínio faz rede.
    assert(!/fetch\(|axios|XMLHttpRequest/.test(LIB + VALIDADOR + REGISTRY + REGRAS), "a camada faz chamada de rede");
    // A rota só fala com o Supabase — nenhum host externo.
    assert(!/fetch\(/.test(ROTA), "a rota faz chamada externa");
    assert(!/>\s*Publicar\s*</i.test(UI) && !/Publicar anúncio/i.test(UI), "a UI oferece publicar");
  });
  await t("47. nada da Fase 1, editorial, exportação ou score é escrito", () => {
    for (const [nome, f] of TODOS) {
      for (const tabela of ["resultados_pipeline", "conteudo_versoes", "estudio_anuncios_jobs", "estudio_anuncios_pipeline",
                            "imagens_geradas", "pacotes_exportacao", "entradas_produto", "projetos_marketplace"]) {
        const depois = f.split(tabela)[1]?.slice(0, 200) ?? "";
        assert(!/\.(insert|update|upsert|delete)\(/.test(depois), `${nome} escreve em ${tabela}`);
      }
      assert(!/pipeline_avancar|pipeline_iniciar|concluir_job|falhar_job|aprovar_versao|gerar_pacote/.test(f), `${nome} mexe em Pipeline/aprovação/pacote`);
    }
    assert(!/estudio_anuncios_score/.test(LIB + VALIDADOR + REGISTRY), "usa a tabela legada de score");
  });
  await t("48. registro imutável: a RPC é INSERT puro e trava o projeto", () => {
    assert(!/UPDATE public\.estudio_anuncios_compliance|DELETE FROM public\.estudio_anuncios_compliance/.test(MIG), "a RPC altera ou apaga parecer");
    assert(/FOR UPDATE/.test(MIG), "sem lock do projeto");
    assert(/idx_compliance_entrada[\s\S]*\(projeto_id, marketplace, hash_entrada\)/.test(MIG), "sem unique de idempotência");
    assert(/CANAL_DE_OUTRO_PROJETO/.test(MIG), "a RPC aceita canal de outro projeto");
    assert(/SECURITY INVOKER/.test(MIG) && /SET search_path = public/.test(MIG), "RPC fora do padrão");
    assert(/REVOKE EXECUTE[\s\S]*FROM PUBLIC, anon, authenticated/.test(MIG) && /GRANT EXECUTE[\s\S]*TO service_role/.test(MIG), "permissões erradas");
  });
  await t("49. o banco só aceita os 4 status e os 4 marketplaces", () => {
    assert(/chk_compliance_status[\s\S]*aprovado_com_alertas[\s\S]*nao_implementado/.test(MIG), "CHECK de status incompleto");
    assert(/chk_compliance_marketplace[\s\S]*TikTok Shop/.test(MIG), "CHECK de marketplace incompleto");
    assert(/chk_compliance_nao_implementado/.test(MIG), "sem CHECK ligando nao_implementado a versao_regras 0");
  });
  await t("50. a rota preserva a ordem de segurança e não expõe segredo", () => {
    // Só o CORPO do handler: a ordem dos imports no topo não diz nada
    // sobre a ordem em que as checagens rodam.
    const corpo = ROTA.slice(ROTA.indexOf("export async function POST"));
    const iSessao = corpo.indexOf("autenticarRequisicao");
    const iSlug = corpo.indexOf("resolverMarketplacePorSlug");
    const iDono = corpo.indexOf("buscarProjetoPorId");
    const iServico = corpo.indexOf("getSupabaseServidor()");
    assert(iSessao >= 0 && iSlug > iSessao && iDono > iSlug && iServico > iDono, "ordem de segurança quebrada");
    assert(/status: 401/.test(ROTA) && /status: 400/.test(ROTA) && /status: 404/.test(ROTA), "faltam códigos de erro");
    assert(!/403/.test(ROTA), "deveria ser 404, nunca 403");
    assert(/criadoPor: userId/.test(ROTA), "autor deveria vir da sessão");
    assert(!/body\.(userId|criadoPor|marketplace)/.test(ROTA), "aceita dado sensível do corpo");
    assert(!/SERVICE_ROLE|ML_CLIENT_SECRET|partner_key|access_token/.test(ROTA), "segredo exposto na rota");
  });
  await t("51. a UI não decide publicabilidade e não promete aprovação", () => {
    assert(/Pré-publicação/.test(UI), "faltou o rótulo de pré-publicação");
    assert(/não é garantia de aprovação|nao e garantia/i.test(UI), "a UI não avisa que não é garantia");
    assert(/podePublicar/.test(UI) && !/bloqueios\.length === 0 \?/.test(UI), "a UI está derivando publicabilidade sozinha");
    assert(!/createClient|SUPABASE|SERVICE_ROLE/.test(UI), "UI acessa Supabase/segredo");
    assert(/disabled=\{validando\}/.test(UI), "sem bloqueio de duplo clique");
  });
  await t("51b. a UI mostra 'desatualizado' e não trata como aprovado", () => {
    assert(/desatualizado/i.test(UI), "a UI não sinaliza parecer desatualizado");
    assert(/compliance\.desatualizado/.test(UI), "a UI não lê a flag do servidor");
  });
  await t("51c. o GET do projeto passa `desatualizado` ao portão", () => {
    const GET = ler("app/api/estudio-anuncios/projetos/[id]/route.ts");
    assert(/podePublicarMarketplace\(c\.resultado, c\.desatualizado\)/.test(GET), "o GET não considera parecer desatualizado");
    assert(/motivoNaoPublicavel\(c\.resultado, c\.desatualizado\)/.test(GET), "o motivo não considera desatualizado");
  });
  await t("52. o portão de publicação é único e centralizado", () => {
    assert(/export function podePublicarMarketplace/.test(REGISTRY), "o portão deveria viver no registry");
    assert(!/podePublicar\s*=\s*[^p]/.test(VALIDADOR), "o validador está decidindo publicabilidade");
    assert(/podePublicarMarketplace/.test(ROTA), "a rota deveria usar o portão");
  });
}

rodar().then(() => {
  console.log(`\n=== RESULTADO: ${ok} passaram, ${falhou} falharam ===\n`);
  process.exitCode = falhou > 0 ? 1 : 0;
});
