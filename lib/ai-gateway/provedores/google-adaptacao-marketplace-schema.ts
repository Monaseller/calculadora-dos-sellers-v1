/**
 * Schema JSON (`response_format`) do Gemini para a etapa
 * `adaptacao_marketplace` — exclusivo do provedor Google, análogo a
 * `GERACAO_CONTEUDO_JSON_SCHEMA`.
 *
 * Escopo estrito: só a FORMA do JSON esperado. Nenhuma regra de
 * Pipeline, nenhum acesso a Supabase, nenhuma persistência, nenhuma
 * validação de conteúdo — tudo isso vive em
 * lib/estudio-anuncios/adaptacao-marketplace.ts. Importa os tipos de
 * domínio (import type, sem dependência de runtime), nunca redefine o
 * shape à parte.
 *
 * Campos opcionais são genuinamente omissíveis (chave ausente), nunca
 * `null` nem array vazio como substituto — mesmo padrão de
 * geracao_conteudo, agora com respaldo empírico: a validação real de
 * 2026-08-06 confirmou que o structured output do Gemini aceita chave
 * ausente de verdade (`publicoSugerido` voltou fora do JSON). Ver
 * PROJECT_STATE.md §8.
 *
 * `marketplace` e `cta` usam `enum` no schema — primeira linha de
 * defesa, barata, do lado do provedor. A validação determinística de
 * `adaptacao-marketplace.ts` NÃO confia nisso: reconfere os dois contra
 * MARKETPLACES_SUPORTADOS e CTAS_PERMITIDOS depois do parse, porque o
 * schema é do provedor e a garantia tem que ser nossa.
 */
import type { AdaptacaoMarketplaceIA } from "../../estudio-anuncios/adaptacao-marketplace-tipos";
import { MARKETPLACES_SUPORTADOS, CTAS_PERMITIDOS } from "../../estudio-anuncios/adaptacao-marketplace-tipos";

const SCHEMA_ESPECIFICACAO_ADAPTADA = {
  type: "object",
  properties: {
    nome: { type: "string" },
    valor: { type: "string" },
  },
  required: ["nome", "valor"],
  additionalProperties: false,
} as const;

const SCHEMA_ADAPTACAO = {
  type: "object",
  properties: {
    marketplace: { type: "string", enum: [...MARKETPLACES_SUPORTADOS] },
    titulo: { type: "string" },
    bullets: { type: "array", items: { type: "string" } },
    descricao: { type: "string" },
    especificacoes: { type: "array", items: SCHEMA_ESPECIFICACAO_ADAPTADA },
    cta: { type: "string", enum: [...CTAS_PERMITIDOS] },
  },
  // titulo e descricao são os únicos obrigatórios por adaptação, além do
  // próprio marketplace. bullets/especificacoes/cta são omissíveis.
  required: ["marketplace", "titulo", "descricao"],
  additionalProperties: false,
} as const;

export const ADAPTACAO_MARKETPLACE_JSON_SCHEMA = {
  type: "object",
  properties: {
    adaptacoes: { type: "array", items: SCHEMA_ADAPTACAO },
  },
  required: ["adaptacoes"],
  additionalProperties: false,
} as const;

// Checagem de compilação (apagada pelo tsc): confirma que o schema
// descreve exatamente as chaves de nível superior de
// AdaptacaoMarketplaceIA — se o domínio ganhar/perder um campo sem este
// schema acompanhar, a build quebra em vez de divergir em silêncio.
type ChavesSchema = keyof typeof ADAPTACAO_MARKETPLACE_JSON_SCHEMA.properties;
type ChavesDominio = keyof AdaptacaoMarketplaceIA;
type _AssertMesmasChaves = [ChavesSchema] extends [ChavesDominio]
  ? [ChavesDominio] extends [ChavesSchema]
    ? true
    : never
  : never;
const _assertMesmasChaves: _AssertMesmasChaves = true;
void _assertMesmasChaves;
