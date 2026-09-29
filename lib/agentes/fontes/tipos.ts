/**
 * FONTES DE AGENTE — o contrato puro. AGENT-FACTORY-F5.
 *
 * ── FONTE nao e ANEXO, e nenhum dos dois e MEMORIA ──────────────────
 *
 * FONTE (`escopo: "agente"`) pertence ao agente e sobrevive a conversa:
 * o lojista sobe `entradas.xlsx` uma vez e ela continua la no proximo
 * chat, ate desativar ou substituir.
 *
 * ANEXO (`escopo: "conversa"`) vale so naquele dialogo.
 *
 * MEMORIA e outra coisa: e o que o agente APRENDEU. Fonte e um arquivo
 * que alguem entregou. Gate proprio, e nao se mistura aqui.
 *
 * ── Este modulo e PURO ──────────────────────────────────────────────
 *
 * Sem `server-only`, sem banco, sem storage, sem rede. So a forma e as
 * regras de validacao que nao dependem de I/O — para que a suite as
 * exercite sem subir nada. Quem fala com Postgres e com o bucket vive
 * nos modulos irmaos.
 */

export const ESCOPOS_DE_FONTE = Object.freeze(["agente", "conversa"] as const);
export type EscopoDeFonte = (typeof ESCOPOS_DE_FONTE)[number];

export const TIPOS_DE_FONTE = Object.freeze(["xlsx", "csv"] as const);
export type TipoDeFonte = (typeof TIPOS_DE_FONTE)[number];

/**
 * Os dois MIMEs que a leitura suporta de VERDADE.
 *
 * `.xls` (BIFF binario) fica de fora de proposito: exigiria outra stack
 * de parsing, e prometer suporte sem ter o leitor e pior que recusar.
 * Os valores espelham o CHECK `agente_fontes_mime_valido` — divergir
 * aqui faria o INSERT falhar depois de o arquivo ja estar no bucket.
 */
export const MIME_POR_TIPO: Readonly<Record<TipoDeFonte, string>> = Object.freeze({
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
});

/**
 * 5 MB — o mesmo numero do CHECK, e pela mesma razao escrita la.
 *
 * O leitor descomprime o `.xlsx` INTEIRO em memoria, e xlsx comprime
 * XML a 10x-20x: 5 MB comprimidos ja podem virar ~100 MB de XML, que e
 * o teto util dentro dos 60s e da memoria de uma funcao serverless na
 * Vercel. Nao e numero redondo escolhido no olho.
 */
export const MAX_BYTES_DA_FONTE = 5 * 1024 * 1024;

export const MAX_NOME_DA_FONTE = 200;
export const MAX_DESCRICAO_DA_FONTE = 500;
export const MAX_PAPEL_DA_FONTE = 60;

/** Uma fonte, como o dominio a ve. `caminhoObjeto` NAO esta aqui. */
export interface Fonte {
  readonly id: string;
  readonly userId: string;
  readonly agenteId: string | null;
  readonly conversaId: string | null;
  readonly escopo: EscopoDeFonte;
  readonly nome: string;
  readonly descricao: string | null;
  readonly papel: string | null;
  readonly tipo: TipoDeFonte;
  readonly mime: string;
  readonly tamanhoBytes: number;
  readonly hashSha256: string;
  readonly ativo: boolean;
  readonly substituiId: string | null;
  readonly criadoEm: string;
}

/**
 * O que o MODELO enxerga de uma fonte.
 *
 * Sem hash, sem tamanho, sem caminho, sem dono. O modelo precisa saber
 * QUE a fonte existe e o que ela e — nada mais. Cada campo a mais e um
 * campo que pode vazar para o texto final.
 */
export interface FonteParaModelo {
  readonly id: string;
  readonly nome: string;
  readonly descricao: string | null;
  readonly papel: string | null;
  readonly tipo: TipoDeFonte;
}

export function paraModelo(f: Fonte): FonteParaModelo {
  return { id: f.id, nome: f.nome, descricao: f.descricao, papel: f.papel, tipo: f.tipo };
}

// ─── Validacao de entrada ─────────────────────────────────────────────

export type ResultadoValidacao =
  | { readonly ok: true }
  | { readonly ok: false; readonly codigo: string; readonly mensagem: string };

const RE_EXTENSAO = /\.([A-Za-z0-9]+)$/;

/**
 * Descobre o tipo pela EXTENSAO do nome enviado.
 *
 * E so o primeiro filtro. O MIME real por assinatura de bytes manda —
 * ver `conferirMimeReal`. Aceitar a extensao sozinha e como aceitar
 * `file.type` do cliente, que este repositorio ja proibe.
 */
export function tipoPelaExtensao(nomeOriginal: string): TipoDeFonte | null {
  const m = RE_EXTENSAO.exec(nomeOriginal.trim());
  if (!m) return null;
  const ext = m[1].toLowerCase();
  return (TIPOS_DE_FONTE as readonly string[]).includes(ext) ? (ext as TipoDeFonte) : null;
}

/**
 * Nome seguro para guardar.
 *
 * Nao existe caminho aqui: barras, dois-pontos e pontos consecutivos
 * viram sublinhado antes de qualquer coisa. Mas a defesa de verdade nao
 * e esta — e o fato de o nome NAO compor o caminho do objeto sozinho
 * (ver `montarCaminhoDaFonte`, que prefixa dono e id). Sanitizar e a
 * segunda tranca, nao a primeira.
 */
export function nomeSeguroDaFonte(nomeOriginal: string, tipo: TipoDeFonte): string {
  const semExtensao = nomeOriginal.trim().replace(RE_EXTENSAO, "");
  const base = semExtensao
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/\.{2,}/g, "_")
    .replace(/^[._-]+/, "")
    .slice(0, 80);
  return `${base === "" ? "fonte" : base}.${tipo}`;
}

/** Valida os METADADOS do pedido de upload. Bytes sao conferidos fora. */
export function validarMetadados(entrada: {
  readonly nome: unknown;
  readonly descricao?: unknown;
  readonly papel?: unknown;
  readonly tamanhoBytes: unknown;
  readonly escopo: unknown;
  readonly agenteId?: unknown;
  readonly conversaId?: unknown;
}): ResultadoValidacao {
  if (typeof entrada.nome !== "string" || entrada.nome.trim() === "") {
    return { ok: false, codigo: "nome_ausente", mensagem: "A fonte precisa de um nome." };
  }
  if (entrada.nome.length > MAX_NOME_DA_FONTE) {
    return { ok: false, codigo: "nome_longo", mensagem: "Nome longo demais." };
  }
  if (tipoPelaExtensao(entrada.nome) === null) {
    return {
      ok: false,
      codigo: "extensao_nao_suportada",
      mensagem: `Tipo nao suportado. Aceitos: ${TIPOS_DE_FONTE.join(", ")}.`,
    };
  }
  if (entrada.descricao !== undefined && entrada.descricao !== null) {
    if (typeof entrada.descricao !== "string" || entrada.descricao.length > MAX_DESCRICAO_DA_FONTE) {
      return { ok: false, codigo: "descricao_invalida", mensagem: "Descricao invalida." };
    }
  }
  if (entrada.papel !== undefined && entrada.papel !== null) {
    if (typeof entrada.papel !== "string" || entrada.papel.length > MAX_PAPEL_DA_FONTE) {
      return { ok: false, codigo: "papel_invalido", mensagem: "Papel invalido." };
    }
  }
  if (typeof entrada.tamanhoBytes !== "number" || !Number.isInteger(entrada.tamanhoBytes) ||
      entrada.tamanhoBytes <= 0) {
    return { ok: false, codigo: "tamanho_invalido", mensagem: "Arquivo vazio ou tamanho invalido." };
  }
  if (entrada.tamanhoBytes > MAX_BYTES_DA_FONTE) {
    return {
      ok: false,
      codigo: "tamanho_acima_do_limite",
      mensagem: `Arquivo acima do limite de ${Math.floor(MAX_BYTES_DA_FONTE / 1024 / 1024)} MB.`,
    };
  }
  if (typeof entrada.escopo !== "string" ||
      !(ESCOPOS_DE_FONTE as readonly string[]).includes(entrada.escopo)) {
    return { ok: false, codigo: "escopo_invalido", mensagem: "Escopo invalido." };
  }
  // O mesmo par que o CHECK `agente_fontes_vinculo_coerente` cobra no
  // banco. Conferir aqui evita subir bytes que o INSERT vai recusar.
  if (entrada.escopo === "agente") {
    if (typeof entrada.agenteId !== "string" || entrada.agenteId === "") {
      return { ok: false, codigo: "agente_ausente", mensagem: "Fonte de agente exige um agente." };
    }
    if (entrada.conversaId !== undefined && entrada.conversaId !== null) {
      return { ok: false, codigo: "vinculo_incoerente", mensagem: "Fonte de agente nao leva conversa." };
    }
  } else {
    if (typeof entrada.conversaId !== "string" || entrada.conversaId === "") {
      return { ok: false, codigo: "conversa_ausente", mensagem: "Anexo exige uma conversa." };
    }
    if (entrada.agenteId !== undefined && entrada.agenteId !== null) {
      return { ok: false, codigo: "vinculo_incoerente", mensagem: "Anexo nao leva agente." };
    }
  }
  return { ok: true };
}

/**
 * Confere o MIME REAL contra o tipo declarado pela extensao.
 *
 * `.xlsx` e um ZIP: a assinatura de bytes diz `application/zip`, e e
 * assim que o `file-type` o reconhece. Entao a conferencia aceita zip
 * para xlsx e EXIGE que o conteudo tenha as partes de um workbook —
 * quem faz isso e o leitor, que ja lanca se `xl/workbook.xml` faltar.
 *
 * `.csv` nao tem assinatura: `file-type` devolve `undefined` para ele,
 * e isso NAO e erro. Um binario disfarcado de csv e recusado porque a
 * deteccao devolve um MIME conhecido que nao bate.
 */
export function conferirMimeReal(
  tipoDeclarado: TipoDeFonte,
  mimeDetectado: string | null
): ResultadoValidacao {
  if (tipoDeclarado === "xlsx") {
    const aceitos = [
      "application/zip",
      "application/x-zip-compressed",
      MIME_POR_TIPO.xlsx,
    ];
    if (mimeDetectado === null || !aceitos.includes(mimeDetectado)) {
      return {
        ok: false,
        codigo: "mime_incompativel",
        mensagem: "O conteudo do arquivo nao corresponde a um .xlsx.",
      };
    }
    return { ok: true };
  }
  // csv: sem assinatura e o normal. QUALQUER binario reconhecido e
  // recusado — inclusive zip, exe e imagem renomeados para .csv.
  if (mimeDetectado !== null && mimeDetectado !== "text/csv" && mimeDetectado !== "text/plain") {
    return {
      ok: false,
      codigo: "mime_incompativel",
      mensagem: "O conteudo do arquivo nao corresponde a um .csv.",
    };
  }
  return { ok: true };
}
