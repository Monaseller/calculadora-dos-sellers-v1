/**
 * Validador de pré-publicação — Mercado Livre (2026-08-23).
 *
 * 100% determinístico e puro: recebe a entrada montada pelo servidor e
 * devolve o parecer. Sem banco, sem rede, sem IA, sem Storage — é o que
 * permite testar todos os cenários sem custo.
 *
 * Toda regra aplicada aqui existe em `regras-mercado-livre.ts` com fonte
 * oficial e data de verificação. `regraML()` lança para código
 * desconhecido, então não é possível emitir um bloqueio sem origem.
 *
 * O QUE ESTE VALIDADOR SE RECUSA A FAZER:
 * - inventar `category_id` a partir de `categoriaProvavel` da IA;
 * - inventar preço, estoque, condição ou tipo de anúncio;
 * - usar `quantidade` da ficha (unidades por embalagem) como estoque;
 * - dizer "ok" para limite que depende de categoria não resolvida.
 */
import type {
  EntradaCompliance,
  ItemCompliance,
  ResultadoCompliance,
  ValidadorMarketplace,
  Verificacao,
} from "./tipos";
import { derivarStatus } from "./tipos";
import { selecionarImagensML, type SelecaoImagensML } from "./imagens-ml";
import {
  MIMES_IMAGEM_ML,
  REGRAS_ML,
  TIPOS_ANUNCIO_DOCUMENTADOS_ML,
  UNIDADE_DIMENSAO_EMBALAGEM_ML,
  UNIDADE_PESO_EMBALAGEM_ML,
  RESOLUCAO_MAXIMA_IMAGEM_ML,
  RESOLUCAO_MINIMA_IMAGEM_ML,
  TAMANHO_MAXIMO_IMAGEM_ML_BYTES,
  VERSAO_REGRAS_ML,
  regraML,
} from "./regras-mercado-livre";

/**
 * Termos das políticas oficiais de título. São ALERTAS, nunca bloqueios:
 * são checagens textuais e um falso positivo jamais pode impedir uma
 * publicação legítima.
 */
/**
 * Padrões com fronteira de palavra (`\b`), não substring: "novo" não pode
 * casar dentro de "Innovo", e "nova" precisa casar tanto quanto "novo".
 * A comparação roda sobre o título já sem acento.
 */
const TERMOS_CONDICAO = [/\bnov[oa]s?\b/, /\busad[oa]s?\b/, /\bsemi[ -]?nov[oa]s?\b/, /\bre[ac]ondicionad[oa]s?\b/, /\brefurbished\b/];
const TERMOS_ESTOQUE = [/\bestoque\b/, /\bpronta entrega\b/, /\bultim[ao]s? unidades?\b/, /\bdisponivel\b/];
const TERMOS_SERVICO = [/\bfrete gratis\b/, /\bsem juros\b/, /\bparcelad[oa]\b/, /\bdevoluc[ao]o gratis\b/, /\b\d{1,2}x\b/];

function normalizar(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function contemAlgum(texto: string, padroes: RegExp[]): string | null {
  const n = normalizar(texto);
  const achado = padroes.find(p => p.test(n));
  return achado ? (n.match(achado)?.[0] ?? null) : null;
}

function item(codigo: string, mensagem?: string): ItemCompliance {
  const regra = regraML(codigo);
  return {
    codigo,
    campo: regra.campo,
    mensagem: mensagem ?? regra.regra,
    regraVersao: VERSAO_REGRAS_ML,
    responsavel: regra.responsavel,
  };
}

export function validarMercadoLivre(entrada: EntradaCompliance, hashEntrada: string): ResultadoCompliance {
  const bloqueios: ItemCompliance[] = [];
  const alertas: ItemCompliance[] = [];
  const verificacoes: Verificacao[] = [];

  const anota = (codigo: string, rotulo: string, resultado: Verificacao["resultado"], detalhe?: string) => {
    verificacoes.push({ codigo, rotulo, resultado, detalhe });
    if (resultado === "bloqueio") bloqueios.push(item(codigo, detalhe));
    // `nao_verificavel` também vira alerta: o usuário precisa saber que
    // aquilo NÃO foi validado, em vez de ler silêncio como aprovação.
    if (resultado === "alerta" || resultado === "nao_verificavel") alertas.push(item(codigo, detalhe));
  };

  // ── 1. Conteúdo aprovado ────────────────────────────────────────────
  const conteudo = entrada.conteudo;
  if (!entrada.fonteEditorial || !conteudo) {
    anota("ml_conteudo_nao_aprovado", "Conteúdo aprovado", "bloqueio",
      "Nenhuma versão editorial aprovada para este canal. Aprove uma versão antes de validar.");
  } else {
    verificacoes.push({
      codigo: "ml_conteudo_aprovado",
      rotulo: "Conteúdo aprovado",
      resultado: "ok",
      detalhe: `Versão ${entrada.fonteEditorial.numeroVersao} aprovada.`,
    });
  }

  // A categoria é o que destrava quase todo o resto: os limites do
  // Mercado Livre são POR CATEGORIA, e sem o snapshot oficial eles
  // continuam não verificáveis.
  const cat = entrada.categoriaMarketplace;
  const st = cat?.settings ?? null;

  // ── 2. Título ───────────────────────────────────────────────────────
  const titulo = conteudo?.titulo?.trim() ?? "";
  if (!titulo) {
    anota("ml_titulo_ausente", "Título", "bloqueio");
  } else {
    verificacoes.push({ codigo: "ml_titulo_presente", rotulo: "Título", resultado: "ok", detalhe: `${titulo.length} caracteres.` });

    if (st?.maxTitleLength != null) {
      if (titulo.length > st.maxTitleLength) {
        anota("ml_titulo_acima_do_limite", "Limite de título", "bloqueio",
          `O título tem ${titulo.length} caracteres e o limite desta categoria é ${st.maxTitleLength}.`);
      } else {
        verificacoes.push({
          codigo: "ml_titulo_dentro_do_limite", rotulo: "Limite de título", resultado: "ok",
          detalhe: `${titulo.length} de ${st.maxTitleLength} caracteres permitidos nesta categoria.`,
        });
      }
    } else {
      anota("ml_titulo_limite_nao_verificavel", "Limite de título", "nao_verificavel",
        `O limite depende da categoria do Mercado Livre. Título atual: ${titulo.length} caracteres.`);
    }

    const cond = contemAlgum(titulo, TERMOS_CONDICAO);
    if (cond) anota("ml_titulo_menciona_condicao", "Título sem condição do produto", "alerta",
      `O título menciona "${cond}". A documentação pede que a condição vá no atributo, não no título.`);

    const est = contemAlgum(titulo, TERMOS_ESTOQUE);
    if (est) anota("ml_titulo_menciona_estoque", "Título sem menção a estoque", "alerta",
      `O título menciona "${est}". Mencionar estoque leva a moderação.`);

    const serv = contemAlgum(titulo, TERMOS_SERVICO);
    if (serv) anota("ml_titulo_menciona_servico", "Título sem frete/parcelamento", "alerta",
      `O título menciona "${serv}". A documentação pede para não incluir serviços no título.`);
  }

  // ── 3. Descrição ────────────────────────────────────────────────────
  if (conteudo) {
    const tamDescricao = montarDescricaoPlana(conteudo).length;
    if (st?.maxDescriptionLength != null) {
      if (tamDescricao > st.maxDescriptionLength) {
        anota("ml_descricao_acima_do_limite", "Limite de descrição", "bloqueio",
          `A descrição tem ${tamDescricao} caracteres e o limite desta categoria é ${st.maxDescriptionLength}.`);
      } else {
        verificacoes.push({
          codigo: "ml_descricao_dentro_do_limite", rotulo: "Limite de descrição", resultado: "ok",
          detalhe: `${tamDescricao} de ${st.maxDescriptionLength} caracteres permitidos.`,
        });
      }
    } else {
      anota("ml_descricao_limite_nao_verificavel", "Limite de descrição", "nao_verificavel",
        `O limite depende da categoria. Descrição atual: ${tamDescricao} caracteres.`);
    }
  }

  // ── 4. Categoria ────────────────────────────────────────────────────
  const categoriaId = entrada.comercial.categoriaMarketplaceId?.trim() || null;
  if (!categoriaId || !cat) {
    anota("ml_categoria_nao_resolvida", "Categoria do Mercado Livre", "bloqueio",
      entrada.ficha?.categoriaTexto
        ? `Nenhuma categoria do Mercado Livre resolvida. A ficha traz "${entrada.ficha.categoriaTexto}", que é texto livre — não é um category_id.`
        : "Nenhuma categoria do Mercado Livre resolvida. O category_id precisa ser escolhido entre os IDs oficiais do site.");
  } else {
    verificacoes.push({
      codigo: "ml_categoria_resolvida", rotulo: "Categoria do Mercado Livre", resultado: "ok",
      detalhe: `${cat.caminho} (${cat.id})`,
    });
    // Categoria existir não basta: ela precisa aceitar publicação.
    if (st?.listingAllowed === false || (st?.status != null && st.status !== "enabled")) {
      anota("ml_categoria_nao_permite_publicacao", "Categoria habilitada", "bloqueio",
        `A categoria ${cat.id} não aceita publicação (listing_allowed=${st?.listingAllowed}, status=${st?.status}). Escolha uma subcategoria específica.`);
    }
    if (cat.ehFolha === false) {
      anota("ml_categoria_nao_folha", "Categoria específica", "alerta",
        `${cat.nome} tem subcategorias. O Mercado Livre publica em categoria folha.`);
    }
  }

  // Sem categoria resolvida, o que depende dela continua NÃO VERIFICÁVEL
  // — dizer "ok" aqui seria fingir validação.
  if (!cat) {
    anota("ml_atributos_obrigatorios_nao_verificaveis", "Atributos obrigatórios", "nao_verificavel");
    anota("ml_quantidade_imagens_nao_verificavel", "Quantidade máxima de imagens", "nao_verificavel");
  }

  // ── 5. Preço, estoque, condição, tipo de anúncio ────────────────────
  if (entrada.comercial.precoCentavos == null) {
    anota("ml_preco_nao_informado", "Preço", "bloqueio",
      "O Estúdio de Anúncios não tem preço de publicação. Informe o preço antes de publicar.");
  } else {
    verificacoes.push({ codigo: "ml_preco_informado", rotulo: "Preço", resultado: "ok" });
  }

  if (entrada.comercial.estoque == null) {
    anota("ml_estoque_nao_informado", "Estoque", "bloqueio",
      "Nenhum estoque informado. A quantidade por embalagem da ficha do produto NÃO é estoque e não é usada aqui.");
  } else {
    verificacoes.push({ codigo: "ml_estoque_informado", rotulo: "Estoque", resultado: "ok" });
  }

  // Moeda: sai dos settings da categoria, nunca é digitada.
  const moeda = entrada.comercial.moeda?.trim() || null;
  if (!cat) {
    anota("ml_moeda_nao_verificavel", "Moeda", "nao_verificavel");
  } else if (!moeda || (st && st.currencies.length > 0 && !st.currencies.includes(moeda))) {
    anota("ml_moeda_indefinida_para_categoria", "Moeda", "bloqueio",
      st && st.currencies.length > 1
        ? `Esta categoria aceita mais de uma moeda (${st.currencies.join(", ")}) e nenhuma foi definida.`
        : "Nenhuma moeda derivada da categoria.");
  } else {
    verificacoes.push({ codigo: "ml_moeda_definida", rotulo: "Moeda", resultado: "ok", detalhe: moeda });
  }

  const condicao = entrada.comercial.condicao?.trim() || null;
  if (!condicao) {
    anota("ml_condicao_nao_definida", "Condição do produto", "bloqueio");
  } else if (st && st.itemConditions.length > 0 && !st.itemConditions.includes(condicao)) {
    // Preenchido não basta: precisa ser um valor que a categoria aceita.
    anota("ml_condicao_invalida_para_categoria", "Condição do produto", "bloqueio",
      `"${condicao}" não está entre as condições aceitas por esta categoria (${st.itemConditions.join(", ")}).`);
  } else {
    verificacoes.push({ codigo: "ml_condicao_definida", rotulo: "Condição do produto", resultado: "ok", detalhe: condicao });
  }

  const tipoAnuncio = entrada.comercial.tipoAnuncio?.trim() || null;
  if (!tipoAnuncio) {
    anota("ml_tipo_anuncio_nao_definido", "Tipo de anúncio", "bloqueio");
  } else if (entrada.tiposAnuncioDaConta && entrada.tiposAnuncioDaConta.length > 0) {
    // Com a conta vinculada, a lista DELA é a autoridade — e ela é maior
    // que a documentada (a conta real devolveu `gold_premium`, `gold` e
    // `free` além dos quatro dos exemplos). Barrar pela lista documentada
    // aqui recusaria um tipo legítimo.
    if (!entrada.tiposAnuncioDaConta.includes(tipoAnuncio)) {
      anota("ml_tipo_anuncio_nao_disponivel_na_conta", "Tipo de anúncio", "bloqueio",
        `"${tipoAnuncio}" não está entre os tipos que esta conta permite (${entrada.tiposAnuncioDaConta.join(", ")}).`);
    } else {
      verificacoes.push({ codigo: "ml_tipo_anuncio_definido", rotulo: "Tipo de anúncio", resultado: "ok", detalhe: tipoAnuncio });
      verificacoes.push({
        codigo: "ml_tipo_anuncio_disponivel_na_conta", rotulo: "Disponibilidade do tipo de anúncio",
        resultado: "ok", detalhe: "Confirmado com a conta vinculada.",
      });
    }
  } else if (!(TIPOS_ANUNCIO_DOCUMENTADOS_ML as readonly string[]).includes(tipoAnuncio)) {
    anota("ml_tipo_anuncio_invalido", "Tipo de anúncio", "bloqueio",
      `"${tipoAnuncio}" não está entre os tipos documentados (${TIPOS_ANUNCIO_DOCUMENTADOS_ML.join(", ")}).`);
  } else {
    verificacoes.push({ codigo: "ml_tipo_anuncio_definido", rotulo: "Tipo de anúncio", resultado: "ok", detalhe: tipoAnuncio });
    anota("ml_tipo_anuncio_nao_verificado_na_conta", "Disponibilidade do tipo de anúncio", "alerta");
  }

  // ── 5b. Modelo da conta e family_name (User Products) ───────────────
  // Os dois formatos são incompatíveis: sem saber o modelo, não dá para
  // dizer se falta `title` ou `family_name`.
  const modelo = entrada.modeloPublicacao;
  if (!modelo) {
    anota("ml_modelo_publicacao_nao_resolvido", "Modelo da conta", "bloqueio",
      "Vincule a conta e rode a validação oficial uma vez para resolver o modelo de publicação.");
  } else {
    verificacoes.push({
      codigo: "ml_modelo_publicacao_resolvido", rotulo: "Modelo da conta", resultado: "ok",
      detalhe: modelo === "user_products" ? "User Products (o título é montado pelo Mercado Livre)" : "Modelo anterior (legacy)",
    });
  }

  if (modelo === "user_products") {
    const familia = entrada.familyName?.trim() || null;
    if (!familia) {
      anota("ml_family_name_nao_informado", "Nome da família", "bloqueio",
        "No modelo User Products o Mercado Livre monta o título, e o nome da família passa a ser obrigatório.");
    } else if (st?.maxTitleLength != null && familia.length > st.maxTitleLength) {
      // O limite é o da categoria/domínio, vindo da API — nunca fixo aqui.
      anota("ml_family_name_excede_limite", "Nome da família", "bloqueio",
        `O nome da família tem ${familia.length} caracteres e o limite desta categoria é ${st.maxTitleLength}.`);
    } else {
      verificacoes.push({
        codigo: "ml_family_name_ok", rotulo: "Nome da família", resultado: "ok",
        detalhe: st?.maxTitleLength != null ? `${familia.length} de ${st.maxTitleLength} caracteres.` : `${familia.length} caracteres.`,
      });
    }
    // Aviso permanente: o título editorial continua existindo, mas não
    // é ele que vai para o Mercado Livre neste modelo.
    anota("ml_titulo_nao_enviado_no_modelo_novo", "Título no modelo novo", "alerta");
  }

  // ── 5c. Dados logísticos da EMBALAGEM ───────────────────────────────
  // Exigência confirmada pela própria API. São dados da CAIXA, não do
  // produto — e nada aqui olha para `entrada.ficha.peso`/`medidas`.
  const emb = entrada.embalagem;
  const faltandoEmbalagem: string[] = [];
  if (emb.pesoG == null) { anota("ml_peso_embalagem_nao_informado", "Peso da embalagem", "bloqueio"); faltandoEmbalagem.push("peso"); }
  if (emb.alturaCm == null) { anota("ml_altura_embalagem_nao_informada", "Altura da embalagem", "bloqueio"); faltandoEmbalagem.push("altura"); }
  if (emb.larguraCm == null) { anota("ml_largura_embalagem_nao_informada", "Largura da embalagem", "bloqueio"); faltandoEmbalagem.push("largura"); }
  if (emb.comprimentoCm == null) { anota("ml_comprimento_embalagem_nao_informado", "Comprimento da embalagem", "bloqueio"); faltandoEmbalagem.push("comprimento"); }

  // FORMATO é bloqueio separado de AUSÊNCIA: "não informado" pede
  // preencher, "informado errado" pede corrigir, e o parecer não pode
  // dizer a mesma coisa para as duas. O ML só aceita inteiro aqui, e o
  // valor decimal morre neste ponto — nunca chega ao `/items/validate`.
  const naoInteiras = ([
    ["peso", emb.pesoG, UNIDADE_PESO_EMBALAGEM_ML],
    ["altura", emb.alturaCm, UNIDADE_DIMENSAO_EMBALAGEM_ML],
    ["largura", emb.larguraCm, UNIDADE_DIMENSAO_EMBALAGEM_ML],
    ["comprimento", emb.comprimentoCm, UNIDADE_DIMENSAO_EMBALAGEM_ML],
  ] as const)
    .filter(([, valor]) => valor != null && !Number.isInteger(valor))
    .map(([nome, valor, unidade]) => `${nome} (${valor} ${unidade})`);

  if (naoInteiras.length > 0) {
    anota("ml_embalagem_medida_nao_inteira", "Formato das medidas da embalagem", "bloqueio",
      `O Mercado Livre aceita apenas números inteiros nestas medidas. Corrija: ${naoInteiras.join(", ")}. O valor não é arredondado — publicar uma medida diferente da informada seria pior que recusar.`);
  }

  if (faltandoEmbalagem.length === 0 && naoInteiras.length === 0) {
    verificacoes.push({
      codigo: "ml_embalagem_completa", rotulo: "Dados da embalagem", resultado: "ok",
      detalhe: `${emb.alturaCm} × ${emb.larguraCm} × ${emb.comprimentoCm} ${UNIDADE_DIMENSAO_EMBALAGEM_ML}, ${emb.pesoG} ${UNIDADE_PESO_EMBALAGEM_ML}.`,
    });
  }

  // ── 6. Atributos ────────────────────────────────────────────────────
  // Com a categoria resolvida, as exigências são as REAIS dela. Sem ela,
  // sobram os alertas genéricos dos atributos mais comuns.
  const informados = new Map(
    entrada.atributosInformados
      .filter(a => a.valueName && a.valueName.trim() !== "")
      .map(a => [a.id.toUpperCase(), a.valueName.trim()])
  );
  // A ficha do produto cobre BRAND/MODEL quando preenchida — é dado real
  // do usuário, não inferência.
  if (entrada.ficha?.marca) informados.set("BRAND", entrada.ficha.marca);
  if (entrada.ficha?.modelo) informados.set("MODEL", entrada.ficha.modelo);
  if (entrada.comercial.gtin) informados.set("GTIN", entrada.comercial.gtin);
  if (entrada.comercial.sku) informados.set("SELLER_SKU", entrada.comercial.sku);

  if (cat) {
    const faltando = cat.atributosObrigatorios.filter(a => !informados.has(a.id.toUpperCase()));
    const obrigatorios = faltando.filter(a => !a.condicional);
    const condicionais = faltando.filter(a => a.condicional);

    if (obrigatorios.length > 0) {
      anota("ml_atributo_obrigatorio_ausente", "Atributos obrigatórios da categoria", "bloqueio",
        `Faltam: ${obrigatorios.map(a => `${a.nome} (${a.id})`).join(", ")}.`);
    }
    if (condicionais.length > 0) {
      anota("ml_atributo_condicional_ausente", "Atributos condicionais da categoria", "alerta",
        `Podem ser exigidos: ${condicionais.map(a => `${a.nome} (${a.id})`).join(", ")}.`);
    }
    if (faltando.length === 0 && cat.atributosObrigatorios.length > 0) {
      verificacoes.push({
        codigo: "ml_atributos_obrigatorios_completos", rotulo: "Atributos obrigatórios da categoria",
        resultado: "ok", detalhe: `${cat.atributosObrigatorios.length} atributo(s) exigido(s) preenchido(s).`,
      });
    }
  } else {
    if (!entrada.ficha?.marca) anota("ml_marca_nao_informada", "Marca", "alerta");
    if (!entrada.ficha?.modelo) anota("ml_modelo_nao_informado", "Modelo", "alerta");
  }
  if (!entrada.comercial.gtin) anota("ml_gtin_nao_informado", "GTIN/EAN", "alerta");
  if (!entrada.comercial.sku) anota("ml_sku_nao_informado", "SKU do vendedor", "alerta");

  // ── 7. Imagens ──────────────────────────────────────────────────────
  // A seleção vive fora do `if` porque o PAYLOAD precisa dela: o parecer
  // valida exatamente a lista que será enviada, na ordem que será
  // enviada — não "as imagens do projeto, quaisquer que sejam".
  let selecaoImagens: SelecaoImagensML = { selecionadas: [], excedentes: [], invalidas: [] };
  if (entrada.imagens.length === 0) {
    anota("ml_sem_imagem", "Imagens", "bloqueio", "Nenhuma imagem disponível para este projeto.");
  } else {
    const semArquivo = entrada.imagens.filter(i => !i.temArquivo);
    const formatoRuim = entrada.imagens.filter(i => !i.mimeType || !(MIMES_IMAGEM_ML as readonly string[]).includes(i.mimeType));
    const grandes = entrada.imagens.filter(i => (i.tamanhoBytes ?? 0) > TAMANHO_MAXIMO_IMAGEM_ML_BYTES);
    const pequenas = entrada.imagens.filter(
      i => i.largura != null && i.altura != null && (i.largura < RESOLUCAO_MINIMA_IMAGEM_ML || i.altura < RESOLUCAO_MINIMA_IMAGEM_ML)
    );
    const enormes = entrada.imagens.filter(
      i => (i.largura ?? 0) > RESOLUCAO_MAXIMA_IMAGEM_ML || (i.altura ?? 0) > RESOLUCAO_MAXIMA_IMAGEM_ML
    );

    if (semArquivo.length > 0) {
      anota("ml_imagem_sem_arquivo", "Arquivo das imagens", "bloqueio",
        `${semArquivo.length} imagem(ns) sem arquivo no Storage.`);
    }
    if (formatoRuim.length > 0) {
      anota("ml_imagem_formato_invalido", "Formato das imagens", "bloqueio",
        `${formatoRuim.length} imagem(ns) fora de JPG/JPEG/PNG.`);
    }
    if (grandes.length > 0) {
      anota("ml_imagem_acima_do_tamanho", "Tamanho das imagens", "bloqueio",
        `${grandes.length} imagem(ns) acima de 10 MB.`);
    }
    if (pequenas.length > 0) {
      anota("ml_imagem_abaixo_da_resolucao_minima", "Resolução das imagens", "bloqueio",
        `${pequenas.length} imagem(ns) abaixo de ${RESOLUCAO_MINIMA_IMAGEM_ML}x${RESOLUCAO_MINIMA_IMAGEM_ML} px.`);
    }
    if (enormes.length > 0) {
      anota("ml_imagem_acima_da_resolucao_maxima", "Resolução máxima", "alerta",
        `${enormes.length} imagem(ns) acima de ${RESOLUCAO_MAXIMA_IMAGEM_ML}x${RESOLUCAO_MAXIMA_IMAGEM_ML} px serão redimensionadas pelo Mercado Livre.`);
    }
    // ── Seleção determinística: QUAIS imagens de fato vão ────────────
    // Antes de 2026-08-29 "tem imagem" bastava. Agora o payload carrega
    // a lista exata, na ordem exata, e por isso a seleção precisa
    // acontecer aqui — o parecer valida o que vai ser enviado.
    selecaoImagens = selecionarImagensML(entrada.imagens, st?.maxPicturesPerItem ?? null);
    const selecao = selecaoImagens;

    if (selecao.selecionadas.length === 0) {
      // Havia imagens, nenhuma serve. Sem isto, um projeto com 3 arquivos
      // quebrados pareceria ter imagens e falharia só no marketplace.
      anota("ml_sem_imagem_valida_para_envio", "Imagens enviáveis", "bloqueio",
        `Nenhuma das ${entrada.imagens.length} imagens passa nos requisitos técnicos: ${selecao.invalidas.map(i => i.motivo).join("; ")}.`);
    } else {
      if (!selecao.selecionadas[0].principal) {
        anota("ml_imagem_principal_ausente", "Imagem principal", "alerta",
          "Nenhuma imagem está marcada como principal; a primeira da ordem será usada como capa.");
      }
      if (selecao.excedentes.length > 0 && st?.maxPicturesPerItem != null) {
        anota("ml_imagens_excedentes_nao_enviadas", "Quantidade de imagens", "alerta",
          `${selecao.excedentes.length} imagem(ns) válida(s) não serão enviadas: a categoria aceita no máximo ${st.maxPicturesPerItem}. Ficam de fora, na ordem: ${selecao.excedentes.map(e => e.imagemGeradaId).join(", ")}.`);
      }
      verificacoes.push({
        codigo: "ml_quantidade_imagens_ok", rotulo: "Quantidade de imagens", resultado: "ok",
        detalhe: st?.maxPicturesPerItem != null
          ? `${selecao.selecionadas.length} de ${st.maxPicturesPerItem} permitidas nesta categoria.`
          : `${selecao.selecionadas.length} selecionada(s); o limite da categoria não é conhecido.`,
      });
    }

    if (semArquivo.length + formatoRuim.length + grandes.length + pequenas.length === 0) {
      verificacoes.push({
        codigo: "ml_imagens_tecnicamente_validas",
        rotulo: "Imagens",
        resultado: "ok",
        detalhe: `${entrada.imagens.length} imagem(ns) dentro dos requisitos técnicos.`,
      });
    }
    anota("ml_imagem_sem_aprovacao_humana", "Aprovação das imagens", "alerta");
  }

  // ── 8. Ressalva permanente ──────────────────────────────────────────
  anota("ml_validacao_final_no_marketplace", "Validação final", "alerta");

  // ── 9. Payload ──────────────────────────────────────────────────────
  // Montado SEMPRE, com null onde falta: é ele que a publicação futura vai
  // consumir, então compliance e publicação nunca divergem. `payloadCompleto`
  // é o que distingue "pronto para enviar" de "esqueleto com lacunas".
  const payload = {
    title: titulo || null,
    category_id: categoriaId,
    // Centavos → reais só aqui, na borda: o valor é inteiro em todo o
    // resto do caminho, então não existe float acumulando erro.
    price: entrada.comercial.precoCentavos == null ? null : entrada.comercial.precoCentavos / 100,
    currency_id: moeda,
    available_quantity: entrada.comercial.estoque,
    buying_mode: "buy_it_now",
    listing_type_id: entrada.comercial.tipoAnuncio,
    condition: entrada.comercial.condicao,
    description: conteudo ? { plain_text: montarDescricaoPlana(conteudo) } : null,
    // IDENTIDADE ESTÁVEL, nunca URL. A URL assinada que o Mercado Livre
    // usa para baixar é gerada no instante da chamada e morre em
    // minutos; guardá-la aqui faria o hash mudar sozinho a cada
    // execução e vazaria uma credencial para dentro do banco. O que
    // identifica a imagem é o id + o checksum dos bytes.
    pictures: selecaoImagens.selecionadas.map(i => ({
      imagem_gerada_id: i.imagemGeradaId,
      checksum: i.checksum,
      ordem: i.ordem,
      principal: i.principal,
    })),
    attributes: montarAtributos(entrada),
    // Repassados ao construtor de payload, que decide o formato final
    // conforme o modelo. O compliance NAO monta o payload da API.
    modelo_publicacao: entrada.modeloPublicacao,
    // Embalagem: repassada crua ao construtor, que a transforma nos
    // atributos SELLER_PACKAGE_*. Nunca derivada do produto.
    embalagem: entrada.embalagem,
    family_name: entrada.familyName?.trim() || null,
  };

  // No modelo User Products o titulo NAO vai ao Mercado Livre — exigi-lo
  // aqui barraria uma publicacao legitima; quem vale e o family_name.
  const identificadorPresente = modelo === "user_products"
    ? !!payload.family_name
    : !!payload.title;
  const obrigatoriosPresentes =
    !!modelo && identificadorPresente && !!payload.category_id && payload.price != null &&
    !!payload.currency_id && payload.available_quantity != null && !!payload.listing_type_id &&
    !!payload.condition && payload.pictures.length > 0 &&
    emb.pesoG != null && emb.alturaCm != null && emb.larguraCm != null && emb.comprimentoCm != null;

  const status = derivarStatus(bloqueios, alertas);

  return {
    marketplace: "ML",
    status,
    versaoRegras: VERSAO_REGRAS_ML,
    bloqueios,
    alertas,
    verificacoes,
    fonteEditorial: entrada.fonteEditorial,
    imagens: entrada.imagens,
    payload,
    // Cinto e suspensório: completo exige campos presentes E nenhum
    // bloqueio. Um deles sozinho já bastaria; os dois juntos impedem que
    // uma regra nova de bloqueio passe despercebida pelo portão.
    payloadCompleto: obrigatoriosPresentes && bloqueios.length === 0,
    hashEntrada,
    validadoEm: new Date().toISOString(),
  };
}

/** Descrição plana: o ML aceita `plain_text`; bullets viram linhas. */
function montarDescricaoPlana(conteudo: NonNullable<EntradaCompliance["conteudo"]>): string {
  const partes = [conteudo.descricao?.trim()].filter(Boolean) as string[];
  if (conteudo.bullets?.length) partes.push(conteudo.bullets.map(b => `- ${b}`).join("\n"));
  if (conteudo.especificacoes?.length) {
    partes.push(conteudo.especificacoes.map(e => `${e.nome}: ${e.valor}`).join("\n"));
  }
  return partes.join("\n\n");
}

/**
 * Só entra atributo com valor REAL: informado pelo usuário para o canal
 * ou vindo da ficha do produto. Nada é inferido, nada vem da IA, e
 * ausência nunca vira string vazia — vira omissão, que é o que dispara a
 * pendência. Ordenado por id para o payload ser estável.
 */
function montarAtributos(entrada: EntradaCompliance): { id: string; value_id?: string; value_name: string }[] {
  const porId = new Map<string, { id: string; value_id?: string; value_name: string }>();
  const por = (id: string, valueName: string | null | undefined, valueId?: string | null) => {
    const valor = valueName?.trim();
    if (!valor) return;
    porId.set(id, valueId ? { id, value_id: valueId, value_name: valor } : { id, value_name: valor });
  };

  if (entrada.ficha?.marca) por("BRAND", entrada.ficha.marca);
  if (entrada.ficha?.modelo) por("MODEL", entrada.ficha.modelo);
  por("GTIN", entrada.comercial.gtin);
  por("SELLER_SKU", entrada.comercial.sku);
  // O que o usuário informou para o canal tem precedência sobre a ficha.
  for (const a of entrada.atributosInformados) por(a.id.toUpperCase(), a.valueName, a.valueId ?? undefined);

  return [...porId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export const validadorMercadoLivre: ValidadorMarketplace = {
  marketplace: "ML",
  versaoRegras: VERSAO_REGRAS_ML,
  validar: validarMercadoLivre,
};

/** Exportado para o teste conferir que toda regra do registro é usada. */
export const CODIGOS_REGRAS_ML = REGRAS_ML.map(r => r.codigo);
