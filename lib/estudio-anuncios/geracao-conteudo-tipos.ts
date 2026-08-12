/**
 * Tipos de domínio da etapa `geracao_conteudo` — independentes de
 * provedor (nenhum tipo aqui depende do SDK do Google/Gemini). Baseado
 * em ESTUDIO_ANUNCIOS_IA_GERACAO_CONTEUDO_CONTRATO.md (contrato
 * congelado e aprovado para implementação, seções 1-15).
 *
 * Vive em lib/estudio-anuncios/ (não em lib/ai-gateway/provedores/) por
 * decisão explícita (Bloqueio 2 da preparação de implementação, ver
 * ESTUDIO_ANUNCIOS_IA_GERACAO_CONTEUDO_PREPARACAO_IMPLEMENTACAO.md,
 * seção 4): acoplar o domínio ao namespace do provedor Google
 * contrariaria o princípio "independente de provedor" que o próprio
 * contrato declara (seção 14: "provedor usado... por desenho, o
 * contrato de domínio é agnóstico"). O schema JSON específico do Google
 * (response_format/structured output) vive em arquivo separado
 * (lib/ai-gateway/provedores/google-conteudo-schema.ts), que importa
 * estes tipos, nunca o contrário.
 *
 * Única exceção consciente: `CampoOrigem` NÃO é definido aqui — é
 * importado de lib/ai-gateway/provedores/google-tipos.ts, por pedido
 * explícito do contrato (seção 12): ele descreve a ESTRUTURA de
 * AnaliseVisualIA (outro contrato), não algo de geracao_conteudo, então
 * vive junto de onde AnaliseVisualIA já vive.
 */
import type { CampoOrigem, OrigemAtributo } from "../ai-gateway/provedores/google-tipos";

/**
 * Subconjunto de OrigemAtributo válido nesta etapa — nunca uma união
 * redefinida à mão (contrato, seção 12): fatosPermitidos/
 * descricoesComRessalva só existem para itens com origem "produto" ou
 * "embalagem_fisica" (os outros 2 valores de OrigemAtributo,
 * "material_promocional" e "indeterminado", nunca chegam a virar fato
 * citável — caem em contextoPromocional/informacoesProibidas antes
 * disso, na montagem da entrada segura).
 */
export type OrigemFatoEntrada = Extract<OrigemAtributo, "produto" | "embalagem_fisica">;

/**
 * Forma comum de um item de entrada segura — usada por FatoPermitido e
 * DescricaoComRessalva (mesmo shape, dois nomes distintos por
 * significado semântico diferente: um é fato confirmado usável em
 * qualquer campo de saída, o outro é hedge-classificado, só usável com
 * contemRessalva=true).
 */
interface ItemFatoEntrada {
  /** Token opaco e estável, atribuído 1x por chamada — "F1"/"F2"... em fatosPermitidos, "R1"/"R2"... em descricoesComRessalva. Não é caminho estrutural, nunca comparável entre execuções diferentes (contrato, seção 2). */
  id: string;
  campoOrigem: CampoOrigem;
  /** Sempre string — ver regras de serialização do contrato (seção 12) para categoriaProvavel (join " > ") e quantidadeDeclarada (usa textoOrigem). */
  valor: string;
  origem: OrigemFatoEntrada;
}

/** Fato confirmado — usável em qualquer campo de saída, inclusive tituloBase/especificacoes (que nunca aceitam ressalva). */
export interface FatoPermitido extends ItemFatoEntrada {}

/** Fato hedge-classificado — só usável em campos que aceitam contemRessalva=true; nunca em tituloBase/especificacoes. */
export interface DescricaoComRessalva extends ItemFatoEntrada {}

/**
 * Metadado server-side (nunca gerado pela IA) — registra que um fato
 * foi rebaixado (de fatosPermitidos para descricoesComRessalva) ou
 * excluído inteiramente por causa de um alerta de analise_visual. O
 * efeito já aconteceu ANTES do prompt ser montado (contrato, seção 10).
 */
export interface FatoAfetadoPorAlerta {
  alerta: string;
  campoOrigem: CampoOrigem;
  valor: string;
  efeito: "rebaixado" | "excluido";
}

/**
 * Referência embutida ao job/resultado de analise_visual que originou
 * esta chamada — copiada no momento da geração, não recalculada depois
 * (contrato, seção 12: "o que a IA realmente viu nesta chamada", mais
 * confiável para auditoria do que só job_origem_id, que fica na tabela
 * de jobs, não no resultado imutável).
 */
export interface FonteAnaliseVisual {
  jobId: string;
  resultadoId: string;
  schemaVersao: number;
}

/**
 * Entrada segura montada por montarEntradaSeguraGeracaoConteudo() —
 * exatamente o que foi de fato apresentado à IA nesta chamada,
 * persistida junto do resultado (contrato, seção 15) para que
 * revisao_claude nunca precise recalcular com uma lista de hedge-words
 * potencialmente diferente da que existia no momento da geração.
 */
export interface EntradaSeguraGeracaoConteudo {
  fatosPermitidos: FatoPermitido[];
  descricoesComRessalva: DescricaoComRessalva[];
  /** Texto puro, nunca citável — só matching textual (substring/paráfrase) por revisao_claude. */
  informacoesProibidas: string[];
  /** Texto puro, mesmo motivo de informacoesProibidas. */
  contextoPromocional: string[];
  /** Cópia direta de analise_visual.alertas, sem transformação. */
  alertas: string[];
  fatosAfetadosPorAlerta: FatoAfetadoPorAlerta[];
}

/** { texto, fatoIds } — usado por tituloBase e publicoSugerido, que nunca carregam contemRessalva (fonte restrita a fatosPermitidos, estruturalmente impossível ter ressalva). fatoIds aqui só aceita "F*". */
export interface TextoComFatoIds {
  texto: string;
  fatoIds: string[];
}

/** { texto, contemRessalva, fatoIds } — usado por descricaoCurta, cada item de bullets e cada parágrafo de descricaoLonga. fatoIds pode misturar F* e R*, mas contemRessalva=true é obrigatório se algum R* for citado (contrato, seção 2). */
export interface TextoComRessalvaEFatoIds {
  texto: string;
  contemRessalva: boolean;
  fatoIds: string[];
}

/** { nome, valor, fatoId } — só a partir de fatosPermitidos (fatoId sempre F*, nunca R*), nunca carrega contemRessalva. */
export interface EspecificacaoGerada {
  nome: string;
  valor: string;
  fatoId: string;
}

/**
 * Saída da IA (contrato, seção 12) — só isto é gerado pelo modelo;
 * `entrada`/`fonteAnaliseVisual` (ver EnvelopeGeracaoConteudo abaixo)
 * são montados/anexados pelo servidor, nunca pedidos à IA.
 *
 * tituloBase e descricaoCurta são os únicos 2 campos verdadeiramente
 * obrigatórios (contrato, seção 1) — "obrigatório" aqui significa
 * presente E não-vazio (texto nunca é ""). Os demais são omissíveis
 * (chave ausente, nunca array/objeto vazio como substituto).
 */
export interface GeracaoConteudoIA {
  tituloBase: TextoComFatoIds;
  bullets?: TextoComRessalvaEFatoIds[];
  descricaoCurta: TextoComRessalvaEFatoIds;
  descricaoLonga?: TextoComRessalvaEFatoIds[];
  especificacoes?: EspecificacaoGerada[];
  publicoSugerido?: TextoComFatoIds;
}

/**
 * Envelope efetivamente persistido em
 * estudio_anuncios_resultados_pipeline.resultado (contrato, seção 15)
 * — não é o que a IA gera (isso é só `saida`), é `entrada`+`saida`
 * congelados juntos no mesmo momento, mais a referência embutida à
 * análise visual de origem.
 *
 * schema_versao (coluna própria da tabela, não campo deste objeto)
 * versiona o ENVELOPE INTEIRO (entrada+saida), não só saida (contrato,
 * seção 14) — uma mudança de shape em qualquer parte de `entrada`
 * também exige bump de SCHEMA_VERSAO_GERACAO_CONTEUDO.
 */
export interface EnvelopeGeracaoConteudo {
  fonteAnaliseVisual: FonteAnaliseVisual;
  entrada: EntradaSeguraGeracaoConteudo;
  saida: GeracaoConteudoIA;
}

/**
 * SCHEMA_VERSAO_GERACAO_CONTEUDO = 1, independente de
 * SCHEMA_VERSAO_ANALISE_VISUAL (contrato, seção 14 — schema_versao é
 * por linha/etapa, não contador global). Reexportado por
 * lib/estudio-anuncios/executores/geracao-conteudo.ts como
 * handler.versaoSaida — nunca importado solto/hardcoded em outro lugar
 * (ver acoplamento corrigido no executor registry, PARTE 1 seção 2.2
 * item 2).
 */
export const SCHEMA_VERSAO_GERACAO_CONTEUDO = 1;

// Reexportado para conveniência de quem só importa deste módulo (o
// domínio de geracao_conteudo) sem precisar saber que CampoOrigem mora
// fisicamente em google-tipos.ts.
export type { CampoOrigem };
