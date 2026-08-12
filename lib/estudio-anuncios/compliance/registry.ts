/**
 * Registry de validadores de pré-publicação (2026-08-23).
 *
 * Um lugar só decide qual canal tem validador — sem `switch` espalhado
 * pela aplicação. Adicionar um marketplace é adicionar uma entrada aqui
 * mais o arquivo de regras com fontes oficiais; nada mais muda.
 *
 * SHOPEE FICA `nao_implementado` NESTA V1, E ISSO É DELIBERADO.
 * A tarefa exigia que toda regra viesse da documentação OFICIAL e proibia
 * explicitamente blog, fórum, doc de terceiros e memória do modelo como
 * fonte normativa. A documentação da Shopee Open Platform
 * (open.shopee.com/documents) é uma aplicação client-side: o HTML servido
 * não contém o conteúdo, e as ferramentas disponíveis neste ambiente não
 * conseguem renderizá-la — nenhum endpoint público de documentação em
 * JSON foi encontrado. Sem fonte oficial legível, congelar regra de
 * `v2.product.add_item` seria exatamente o que a tarefa proíbe.
 *
 * Então a escolha é entre um validador Shopee **inventado** e um
 * `nao_implementado` **honesto**. `nao_implementado` é a resposta certa:
 * a arquitetura já está pronta para receber o validador assim que a
 * documentação for acessível, e nenhum usuário verá um "aprovado" que
 * não foi verificado.
 */
import type { MarketplaceCompliance, ResultadoCompliance, ValidadorMarketplace } from "./tipos";
import { validadorMercadoLivre } from "./mercado-livre";

export const VALIDADORES: Partial<Record<MarketplaceCompliance, ValidadorMarketplace>> = {
  ML: validadorMercadoLivre,
};

/**
 * Motivo por canal sem validador. Nunca fica implícito: a UI mostra o
 * texto, e assim ninguém confunde "não implementado" com "sem problemas".
 */
export const MOTIVO_NAO_IMPLEMENTADO: Record<string, string> = {
  Shopee:
    "Validador não implementado: a documentação oficial da Shopee Open Platform não pôde ser lida neste ambiente " +
    "(site renderizado por JavaScript, sem endpoint público de documentação). Nenhuma regra foi congelada a partir " +
    "de fonte não oficial ou de memória.",
  Amazon: "Validador não implementado nesta versão. Escopo da V1: Mercado Livre e Shopee.",
  "TikTok Shop": "Validador não implementado nesta versão. Escopo da V1: Mercado Livre e Shopee.",
};

export function temValidador(marketplace: MarketplaceCompliance): boolean {
  return VALIDADORES[marketplace] != null;
}

/** Resultado honesto para canal sem validador — nunca `aprovado`. */
export function resultadoNaoImplementado(
  marketplace: MarketplaceCompliance,
  hashEntrada: string
): ResultadoCompliance {
  return {
    marketplace,
    status: "nao_implementado",
    motivoNaoImplementado:
      MOTIVO_NAO_IMPLEMENTADO[marketplace] ?? "Validador não implementado para este marketplace.",
    versaoRegras: 0,
    bloqueios: [],
    alertas: [],
    verificacoes: [],
    fonteEditorial: null,
    imagens: [],
    payload: null,
    payloadCompleto: false,
    hashEntrada,
    validadoEm: new Date().toISOString(),
  };
}

/**
 * O ÚNICO portão de publicação. Qualquer integração real futura passa por
 * aqui — nunca por leitura solta de `status`.
 *
 * `nao_implementado` é `false` de propósito: ausência de validador não é
 * ausência de problema.
 *
 * `desatualizado` fecha um buraco real, encontrado na validação de
 * 2026-08-23: o parecer é imutável e congela a versão que estava aprovada
 * no momento da validação. Se a aprovação mudar depois, o parecer mais
 * recente passa a descrever OUTRO conteúdo — e liberar publicação com ele
 * seria aprovar A e publicar B. Parecer desatualizado nunca publica; é
 * preciso revalidar.
 */
export function podePublicarMarketplace(
  resultado: ResultadoCompliance | null | undefined,
  desatualizado = false
): boolean {
  if (!resultado) return false;
  if (desatualizado) return false;
  if (resultado.status !== "aprovado" && resultado.status !== "aprovado_com_alertas") return false;
  if (resultado.bloqueios.length > 0) return false;
  if (!resultado.payloadCompleto || !resultado.payload) return false;
  if (!resultado.fonteEditorial) return false;
  return true;
}

/** Motivo legível de por que ainda não dá para publicar — para a UI. */
export function motivoNaoPublicavel(
  resultado: ResultadoCompliance | null | undefined,
  desatualizado = false
): string | null {
  if (podePublicarMarketplace(resultado, desatualizado)) return null;
  if (!resultado) return "Este canal ainda não foi validado.";
  if (desatualizado) {
    return "A versão aprovada mudou depois desta validação. Valide novamente antes de publicar.";
  }
  if (resultado.status === "nao_implementado") return resultado.motivoNaoImplementado ?? "Sem validador para este canal.";
  if (resultado.bloqueios.length > 0) {
    return `${resultado.bloqueios.length} item(ns) pendente(s) impedem a publicação.`;
  }
  if (!resultado.fonteEditorial) return "Nenhuma versão de conteúdo aprovada para este canal.";
  return "Faltam campos obrigatórios no payload de publicação.";
}
