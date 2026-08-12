/**
 * Schema JSON (`response_format`) do Gemini para a etapa
 * `geracao_conteudo` — exclusivo do provedor Google, análogo a
 * `ANALISE_VISUAL_JSON_SCHEMA` (google-tipos.ts), mas para esta etapa.
 *
 * Escopo estrito deste arquivo (ESTUDIO_ANUNCIOS_IA_GERACAO_CONTEUDO_
 * PREPARACAO_IMPLEMENTACAO.md, seção 4): só o formato JSON esperado da
 * IA. Nenhuma regra de Pipeline, nenhum acesso a Supabase, nenhuma
 * persistência, nenhuma montagem de entrada segura, nenhuma lógica de
 * job — tudo isso vive em lib/estudio-anuncios/geracao-conteudo.ts.
 * Importa os tipos de domínio de geracao-conteudo-tipos.ts (import
 * type, sem dependência de runtime), nunca redefine o shape à parte.
 *
 * Corresponde a `GeracaoConteudoIA` (o que a IA gera) — não ao
 * envelope completo (`EnvelopeGeracaoConteudo`, que inclui `entrada`/
 * `fonteAnaliseVisual`, montados pelo servidor, nunca pedidos ao
 * modelo).
 *
 * Diferença deliberada em relação a `ANALISE_VISUAL_JSON_SCHEMA`: lá,
 * todo campo é `required` (ausência de valor é representada por
 * `null`). Aqui, só `tituloBase`/`descricaoCurta` são `required` — os
 * demais são genuinamente omissíveis, por decisão explícita e já
 * congelada do contrato (ESTUDIO_ANUNCIOS_IA_GERACAO_CONTEUDO_
 * CONTRATO.md, seção 1: "a escolha, em toda a saída, é entre presente
 * ... e ausente ... nenhum campo é nullable"). Isso ainda não foi
 * validado contra uma chamada real ao Gemini nesta tarefa (proibido —
 * "pare antes da primeira chamada real ao Gemini") — se o modo de
 * structured output do Gemini se comportar como o de outros provedores
 * que exigem 100% dos campos em `required` mesmo quando opcionais
 * (forçando o padrão null-em-vez-de-ausência que `analise_visual`
 * usa), este schema precisará de ajuste com base em evidência real —
 * risco explicitamente registrado, não escondido.
 *
 * Validação de CONTEÚDO (integridade de `fatoIds`, as 5 regras
 * cruzadas F*, R* e contemRessalva da seção 2 do contrato) NÃO vive aqui
 * — é responsabilidade determinística de código de aplicação
 * (geracao-conteudo.ts), rodando depois que o JSON já foi validado
 * estruturalmente contra este schema. Este arquivo garante só a FORMA,
 * nunca o conteúdo.
 */
import type { GeracaoConteudoIA } from "../../estudio-anuncios/geracao-conteudo-tipos";

const SCHEMA_TEXTO_COM_FATO_IDS = {
  type: "object",
  properties: {
    texto: { type: "string" },
    fatoIds: { type: "array", items: { type: "string" } },
  },
  required: ["texto", "fatoIds"],
  additionalProperties: false,
} as const;

const SCHEMA_TEXTO_COM_RESSALVA_E_FATO_IDS = {
  type: "object",
  properties: {
    texto: { type: "string" },
    contemRessalva: { type: "boolean" },
    fatoIds: { type: "array", items: { type: "string" } },
  },
  required: ["texto", "contemRessalva", "fatoIds"],
  additionalProperties: false,
} as const;

const SCHEMA_ESPECIFICACAO = {
  type: "object",
  properties: {
    nome: { type: "string" },
    valor: { type: "string" },
    fatoId: { type: "string" },
  },
  required: ["nome", "valor", "fatoId"],
  additionalProperties: false,
} as const;

export const GERACAO_CONTEUDO_JSON_SCHEMA = {
  type: "object",
  properties: {
    tituloBase: SCHEMA_TEXTO_COM_FATO_IDS,
    bullets: { type: "array", items: SCHEMA_TEXTO_COM_RESSALVA_E_FATO_IDS },
    descricaoCurta: SCHEMA_TEXTO_COM_RESSALVA_E_FATO_IDS,
    descricaoLonga: { type: "array", items: SCHEMA_TEXTO_COM_RESSALVA_E_FATO_IDS },
    especificacoes: { type: "array", items: SCHEMA_ESPECIFICACAO },
    publicoSugerido: SCHEMA_TEXTO_COM_FATO_IDS,
  },
  // Só os 2 campos verdadeiramente obrigatórios do contrato (seção 1) —
  // os outros 4 ficam de fora de propósito, para permitir omissão real
  // em vez de null.
  required: ["tituloBase", "descricaoCurta"],
  additionalProperties: false,
} as const;

// Checagem de compilação (sem efeito em runtime, apagada pelo tsc):
// confirma que o schema acima descreve exatamente as chaves de
// GeracaoConteudoIA, nem a mais nem a menos — se o tipo de domínio
// ganhar/perder um campo de nível superior sem este schema acompanhar,
// isto quebra a build em vez de divergir silenciosamente.
type ChavesSchema = keyof typeof GERACAO_CONTEUDO_JSON_SCHEMA.properties;
type ChavesDominio = keyof GeracaoConteudoIA;
type _AssertMesmasChaves = [ChavesSchema] extends [ChavesDominio]
  ? [ChavesDominio] extends [ChavesSchema]
    ? true
    : never
  : never;
const _assertMesmasChaves: _AssertMesmasChaves = true;
void _assertMesmasChaves;
