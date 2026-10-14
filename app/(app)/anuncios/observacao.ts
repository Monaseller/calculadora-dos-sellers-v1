/**
 * Meus Produtos — observação do marketplace, SOMENTE LEITURA (CDS V2 Fase 2H-E).
 *
 * `status_marketplace` = último valor RAW visto no provider; `visto_em` = última observação POSITIVA
 * (ambos gravados só pelo helper de observação, I9). Aqui só se APRESENTA:
 *   • o status sai byte a byte como veio (sem tradução para estado interno — "active" não vira "Ativo");
 *   • a data sai no formato da casa (dd/mm/aaaa hh:mm), sem cálculo de idade;
 *   • NULL = ainda não observado: não vira "inativo", "offline" nem "removido" — some do card;
 *   • Shopee sem status (writer DEFERRED) mostra só a observação, sem inventar NORMAL.
 * `ativo` (estado do usuário) não é lido nem derivado daqui; nada aqui decide visibilidade,
 * agrupamento ou ordem, e nada aqui grava (I11_MARKETPLACE_STATUS_UI_IS_READ_ONLY).
 *
 * Puro (sem React): os cards e os testes usam as mesmas funções. Recebe a linha como veio da API
 * (`Anuncio` não declara os campos: o tipo de leitura vive só aqui).
 */
export interface ObservacaoLida {
  readonly status_marketplace?: string | null;
  readonly visto_em?: string | null;
}

export interface ObservacaoApresentada {
  /** Valor RAW do provider, exatamente como gravado (null = nenhum status observado). */
  status: string | null;
  /** Momento da última observação, legível (null = nunca observado). */
  vistoEm: string | null;
}

function statusRaw(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function dataLegivel(iso: unknown): string | null {
  if (typeof iso !== "string" || iso === "") return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** O que o card mostra; `null` = nada a mostrar (sem ruído para linha ainda não observada). */
export function apresentarObservacao(linha: object): ObservacaoApresentada | null {
  const a = linha as ObservacaoLida;
  const status = statusRaw(a.status_marketplace);
  const vistoEm = dataLegivel(a.visto_em);
  return status === null && vistoEm === null ? null : { status, vistoEm };
}

/**
 * Card de variações: as linhas de um item costumam ter a MESMA observação (o ML devolve um status
 * por item; o lote, um instante) → mostra UMA vez no cabeçalho. Só quando divergem, cada variação
 * mostra a sua (`porLinha`). Não muda o grupo nem a ordem das variações.
 */
export function observacaoDoGrupo(variacoes: readonly object[]): { comum: ObservacaoApresentada | null; porLinha: boolean } {
  const assinatura = (linha: object) => { const v = linha as ObservacaoLida; return JSON.stringify([v.status_marketplace ?? null, v.visto_em ?? null]); };
  const primeira = variacoes[0];
  if (!primeira) return { comum: null, porLinha: false };
  if (variacoes.every((v) => assinatura(v) === assinatura(primeira))) return { comum: apresentarObservacao(primeira), porLinha: false };
  return { comum: null, porLinha: true };
}
