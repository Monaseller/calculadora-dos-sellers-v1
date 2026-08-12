/**
 * Schema JSON (`output_config.format`) da Anthropic para a etapa
 * `revisao_claude` — exclusivo do provedor, análogo a
 * `GERACAO_CONTEUDO_JSON_SCHEMA` e `ADAPTACAO_MARKETPLACE_JSON_SCHEMA`.
 *
 * Escopo estrito: só a FORMA do JSON. Nenhuma regra de Pipeline, nenhum
 * acesso a Supabase, nenhuma validação de conteúdo — isso vive em
 * lib/estudio-anuncios/revisao-claude.ts.
 *
 * Limitações do structured output da Anthropic respeitadas aqui:
 * `additionalProperties: false` é obrigatório em todo objeto; não há
 * suporte a schema recursivo nem a restrições numéricas/de comprimento
 * (`minLength`, `maxLength`, `minimum`) — por isso "texto não vazio" e
 * "motivo obrigatório quando alterado=true" são validados no código, não
 * no schema.
 */
import type { RevisaoClaudeIA } from "../../estudio-anuncios/revisao-claude-tipos";

const SCHEMA_TEXTO_REVISADO = {
  type: "object",
  properties: {
    ref: { type: "string" },
    textoRevisado: { type: "string" },
    alterado: { type: "boolean" },
    motivo: { type: "string" },
  },
  required: ["ref", "textoRevisado", "alterado"],
  additionalProperties: false,
} as const;

export const REVISAO_CLAUDE_JSON_SCHEMA = {
  type: "object",
  properties: {
    textos: { type: "array", items: SCHEMA_TEXTO_REVISADO },
    observacoes: { type: "array", items: { type: "string" } },
  },
  required: ["textos"],
  additionalProperties: false,
} as const;

// Checagem de compilação (apagada pelo tsc): o schema descreve
// exatamente as chaves de nível superior de RevisaoClaudeIA.
type ChavesSchema = keyof typeof REVISAO_CLAUDE_JSON_SCHEMA.properties;
type ChavesDominio = keyof RevisaoClaudeIA;
type _AssertMesmasChaves = [ChavesSchema] extends [ChavesDominio]
  ? [ChavesDominio] extends [ChavesSchema]
    ? true
    : never
  : never;
const _assertMesmasChaves: _AssertMesmasChaves = true;
void _assertMesmasChaves;
