/**
 * Schema JSON (`response_format`) do Gemini para a etapa
 * `geracao_prompts_imagem` — exclusivo do provedor Google, análogo a
 * GERACAO_CONTEUDO_JSON_SCHEMA e ADAPTACAO_MARKETPLACE_JSON_SCHEMA.
 *
 * Escopo estrito: só a FORMA do JSON esperado. Nenhuma regra de
 * Pipeline, nenhum acesso a Supabase, nenhuma persistência, nenhuma
 * validação de conteúdo — tudo isso vive em
 * lib/estudio-anuncios/geracao-prompts-imagem.ts. Importa os tipos de
 * domínio (import type, sem dependência de runtime), nunca redefine o
 * shape à parte.
 *
 * Note o que NÃO está aqui, e a ausência é o ponto central do desenho:
 * `principal`, `aspectRatio`, `textosPermitidos`, `textosProibidos`,
 * `promptTexto` e `negativePrompt` nunca são pedidos ao modelo. São
 * montados pelo servidor depois da resposta. O modelo não tem onde
 * escrever uma proporção errada, um texto dentro da imagem ou um segundo
 * "principal".
 *
 * `tipo` e `enquadramento` usam `enum` — primeira linha de defesa,
 * barata, do lado do provedor. A validação determinística NÃO confia
 * nisso: reconfere os dois depois do parse, e `tipo` ainda é reconferido
 * contra o subconjunto PERMITIDO NAQUELE PROJETO (calculado a partir da
 * verdade visual), que é mais estreito que o enum.
 */
import type { PromptsImagemIA } from "../../estudio-anuncios/geracao-prompts-imagem-tipos";
import {
  TIPOS_IMAGEM_SUPORTADOS,
  ENQUADRAMENTOS_SUPORTADOS,
} from "../../estudio-anuncios/geracao-prompts-imagem-tipos";

const SCHEMA_PLANO_IMAGEM = {
  type: "object",
  properties: {
    ordem: { type: "integer", minimum: 1 },
    tipo: { type: "string", enum: [...TIPOS_IMAGEM_SUPORTADOS] },
    objetivo: { type: "string" },
    cena: { type: "string" },
    enquadramento: { type: "string", enum: [...ENQUADRAMENTOS_SUPORTADOS] },
    fundo: { type: "string" },
    iluminacao: { type: "string" },
    elementosObrigatorios: { type: "array", items: { type: "string" } },
    elementosProibidos: { type: "array", items: { type: "string" } },
  },
  // Todos obrigatórios: diferente das etapas de texto, aqui não existe
  // campo genuinamente omissível — um prompt de imagem sem fundo ou sem
  // enquadramento não é um prompt incompleto, é um prompt inválido.
  required: [
    "ordem",
    "tipo",
    "objetivo",
    "cena",
    "enquadramento",
    "fundo",
    "iluminacao",
    "elementosObrigatorios",
    "elementosProibidos",
  ],
  additionalProperties: false,
} as const;

export const GERACAO_PROMPTS_IMAGEM_JSON_SCHEMA = {
  type: "object",
  properties: {
    imagens: { type: "array", items: SCHEMA_PLANO_IMAGEM },
  },
  required: ["imagens"],
  additionalProperties: false,
} as const;

// Checagem de compilação (apagada pelo tsc): confirma que o schema
// descreve exatamente as chaves de nível superior de PromptsImagemIA —
// se o domínio ganhar/perder um campo sem este schema acompanhar, a
// build quebra em vez de divergir em silêncio.
type ChavesSchema = keyof typeof GERACAO_PROMPTS_IMAGEM_JSON_SCHEMA.properties;
type ChavesDominio = keyof PromptsImagemIA;
type _AssertMesmasChaves = [ChavesSchema] extends [ChavesDominio]
  ? [ChavesDominio] extends [ChavesSchema]
    ? true
    : never
  : never;
const _assertMesmasChaves: _AssertMesmasChaves = true;
void _assertMesmasChaves;
