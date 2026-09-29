/**
 * De onde vem o arquivo — AGENT-FACTORY-F3.
 *
 * ── A propriedade que este modulo existe para garantir ──────────────
 *
 *   O modelo NUNCA nomeia um caminho.
 *
 * E o jeito de garantir nao e limpar o que ele mandou. Sanitizar
 * caminho e uma corrida que se perde: `..%2f`, `....//`, UNC, link
 * simbolico, unicode equivalente. Aqui a Tool recebe um `fileId`
 * OPACO, e nenhuma camada concatena esse id a um caminho. Quem sabe
 * onde o byte mora e a implementacao de `FonteDeArquivo`, que nao
 * recebe nada do modelo alem do id, e o dono vem da sessao.
 *
 * Por isso `../planilha.xlsx`, `C:\x.xlsx`, `\\servidor\x` e
 * `file:///x` nao precisam de tratamento especial: eles simplesmente
 * nao sao ids validos, morrem na gramatica e nunca chegam a uma fonte.
 * A suite cobra cada um desses, e cobra tambem o CONTROLE de que um id
 * legitimo passa — senao "tudo negado" pareceria seguranca.
 *
 * ── Tenant ──────────────────────────────────────────────────────────
 *
 * `resolver` recebe `userId` e devolve `null` para arquivo de outro
 * dono. Nao existe caminho que leia sem dizer por quem — a assinatura
 * nao permite.
 */

/** Extensoes que este gate le. `.xls` (binario BIFF) fica de fora. */
export const EXTENSOES_SUPORTADAS = Object.freeze(["xlsx", "csv"] as const);
export type ExtensaoSuportada = (typeof EXTENSOES_SUPORTADAS)[number];

/**
 * Gramatica do `fileId`. Opaco e curto de proposito.
 *
 * Sem `.`, sem `/`, sem `\`, sem `:`, sem `%`. Um id nao descreve
 * lugar nenhum — ele so identifica.
 */
export const RE_FILE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function fileIdValido(id: unknown): id is string {
  return typeof id === "string" && RE_FILE_ID.test(id);
}

export interface ArquivoResolvido {
  readonly fileId: string;
  /** Nome para mostrar ao humano. NUNCA um caminho de sistema. */
  readonly nome: string;
  readonly extensao: ExtensaoSuportada;
  readonly bytes: Uint8Array;
}

/**
 * A porta de leitura de arquivo.
 *
 * Uma interface, e nao uma funcao concreta, porque a infraestrutura de
 * upload ainda nao existe — ela e gate proprio (Sources). Inventar aqui
 * um armazenamento definitivo seria decidir aquele gate de passagem. O
 * contrato ja fixa o que importa: id opaco dentro, bytes e nome
 * logico fora, dono obrigatorio.
 */
export interface FonteDeArquivo {
  resolver(userId: string, fileId: string): Promise<ArquivoResolvido | null>;
}

export type ResultadoAbertura =
  | { readonly tipo: "ok"; readonly arquivo: ArquivoResolvido }
  | {
      readonly tipo: "erro";
      readonly codigo:
        | "file_id_invalido"
        | "arquivo_nao_encontrado"
        | "extensao_nao_suportada"
        | "fonte_indisponivel";
      readonly mensagem: string;
    };

/**
 * Abre um arquivo pelo id, com todas as recusas no mesmo lugar.
 *
 * "Nao existe" e "nao e seu" respondem a MESMA coisa: um id de outro
 * dono nao pode se distinguir de um id inexistente, senao a resposta
 * viraria um oraculo para descobrir ids alheios.
 */
export async function abrirArquivo(
  fonte: FonteDeArquivo,
  userId: string,
  fileId: unknown
): Promise<ResultadoAbertura> {
  if (!fileIdValido(fileId)) {
    return {
      tipo: "erro",
      codigo: "file_id_invalido",
      mensagem: "fileId invalido: use o identificador do arquivo, nunca um caminho.",
    };
  }
  let arquivo: ArquivoResolvido | null;
  try {
    arquivo = await fonte.resolver(userId, fileId);
  } catch {
    return {
      tipo: "erro",
      codigo: "fonte_indisponivel",
      mensagem: "Nao foi possivel acessar o arquivo agora.",
    };
  }
  if (arquivo === null) {
    return {
      tipo: "erro",
      codigo: "arquivo_nao_encontrado",
      mensagem: "Arquivo nao encontrado.",
    };
  }
  if (!EXTENSOES_SUPORTADAS.includes(arquivo.extensao)) {
    return {
      tipo: "erro",
      codigo: "extensao_nao_suportada",
      mensagem: `Tipo de arquivo nao suportado. Suportados: ${EXTENSOES_SUPORTADAS.join(", ")}.`,
    };
  }
  return { tipo: "ok", arquivo };
}
