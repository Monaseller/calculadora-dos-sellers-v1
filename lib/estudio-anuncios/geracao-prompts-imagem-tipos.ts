/**
 * Tipos de domínio da etapa `geracao_prompts_imagem` — independentes de
 * provedor (nenhum tipo aqui depende do SDK do Google/Gemini). Mesmo
 * princípio já aplicado a geracao-conteudo-tipos.ts,
 * adaptacao-marketplace-tipos.ts e revisao-claude-tipos.ts: o schema JSON
 * específico do Google vive em
 * lib/ai-gateway/provedores/google-prompts-imagem-schema.ts, que importa
 * estes tipos — nunca o contrário.
 *
 * PAPEL DA ETAPA: transformar a VERDADE VISUAL confirmada do produto em
 * instruções estruturadas para uma futura geração de imagem. Ela NÃO
 * gera imagem, NÃO chama modelo de imagem, NÃO toca Storage, NÃO baixa
 * bytes de foto e NÃO escreve em estudio_anuncios_imagens_geradas — a
 * responsabilidade termina na produção e persistência dos prompts.
 *
 * ORIGEM SEMÂNTICA (decisão desta tarefa, 2026-08-15): a etapa consome
 * `analise_visual`, NÃO `adaptacao_marketplace` nem `revisao_claude`.
 * Motivo — e é uma decisão de segurança, não de minimalismo:
 *   1. Tudo que pode ser DESENHADO precisa ser visualmente confirmado.
 *      `analise_visual` é o único artefato do Pipeline que classifica
 *      cada atributo por `origem` ("produto" / "embalagem_fisica" /
 *      "material_promocional" / "indeterminado"). Essa classificação é
 *      exatamente o que separa "o produto é verde" de "a arte da
 *      embalagem é verde".
 *   2. Os artefatos de conteúdo (geracao_conteudo / revisao_claude /
 *      adaptacao_marketplace) são texto comercial derivado. Usá-los como
 *      fonte visual LAVA a classificação de origem: uma frase de anúncio
 *      não carrega mais a marca de que aquele atributo veio de material
 *      promocional. Passar copy de marketplace para um gerador de prompt
 *      de imagem aumenta materialmente a chance de transformar alegação
 *      textual em elemento visual confirmado — a proibição central desta
 *      etapa.
 *   3. Nada que `adaptacao_marketplace` produz é desenhável. Os
 *      marketplaces do projeto vêm da tabela
 *      `estudio_anuncios_projetos_marketplace` (mesma fonte que a
 *      própria adaptacao_marketplace usa), não do artefato dela.
 * Consequência prática: uma única origem, um único `job_origem_id`,
 * nenhuma resolução multi-fonte, nenhum `ORDER BY criado_em`.
 *
 * CONFIGURAÇÃO vem do Projeto Mestre (`estudio_anuncios_projetos`), não
 * de constante no código: `quantidade_imagens_solicitada`, `estilo` e
 * `modo` já existem como dado do projeto.
 */
import type { FonteAnaliseVisual } from "./geracao-conteudo-tipos";

/**
 * Tipos de imagem suportados — subconjunto ESTRITO do CHECK real de
 * `estudio_anuncios_imagens_geradas.finalidade` (verificado por
 * information_schema em 2026-08-15):
 *   ['capa_principal','perspectiva','beneficios','medidas','detalhes',
 *    'uso','embalagem','promocional_secundaria']
 *
 * Reusar o vocabulário do banco é deliberado: a futura `geracao_imagem`
 * grava `finalidade` nessa tabela, então o prompt já nasce falando a
 * mesma língua — nenhuma tradução, nenhum mapa paralelo.
 *
 * Três valores do CHECK ficam de fora na v1, cada um por um motivo
 * concreto (não por esquecimento):
 *   - `beneficios`: representar um benefício exige afirmar um efeito que
 *     nenhuma foto confirma. Cairia direto na proibição "alegação
 *     transformada em propriedade física".
 *   - `medidas`: exigiria medida confirmada E número desenhado dentro da
 *     imagem — e a v1 proíbe texto gerado dentro da imagem.
 *   - `promocional_secundaria`: promocional por definição.
 */
export const TIPOS_IMAGEM_SUPORTADOS = [
  "capa_principal",
  "perspectiva",
  "detalhes",
  "uso",
  "embalagem",
  // Liberados em 2026-09-04. A v1 os excluía porque "representar um
  // benefício exige afirmar um efeito que nenhuma foto confirma" — o
  // receio era virar alegação. Mas o benefício aqui é MOSTRADO, não
  // escrito: o produto no contexto real de uso. O que continua proibido
  // é inventar efeito (ver naoConfirmado, que segue indo ao modelo como
  // proibição explícita). Sem estes dois tipos o sistema só sabia fazer
  // variações do mesmo retrato, que foi exatamente a queixa do usuário.
  "beneficios",
  "promocional_secundaria",
] as const;

/**
 * `medidas` existe no CHECK do banco mas continua FORA da lista, e por
 * um motivo que não mudou: uma imagem de dimensões exige numerais
 * desenhados dentro do quadro, e texto gerado pelo modelo de imagem
 * ainda erra. Volta quando a camada gráfica em SVG existir.
 */
export const TIPOS_IMAGEM_PENDENTES_CAMADA_GRAFICA = ["medidas"] as const;

export type TipoImagem = (typeof TIPOS_IMAGEM_SUPORTADOS)[number];

export function isTipoImagem(valor: unknown): valor is TipoImagem {
  return typeof valor === "string" && (TIPOS_IMAGEM_SUPORTADOS as readonly string[]).includes(valor);
}

/** Enquadramentos aceitos — lista fechada, escolhida pelo modelo dentro dela. */
export const ENQUADRAMENTOS_SUPORTADOS = [
  "produto_inteiro",
  "tres_quartos",
  "close_detalhe",
  "plano_medio",
] as const;

export type Enquadramento = (typeof ENQUADRAMENTOS_SUPORTADOS)[number];

export function isEnquadramento(valor: unknown): valor is Enquadramento {
  return typeof valor === "string" && (ENQUADRAMENTOS_SUPORTADOS as readonly string[]).includes(valor);
}

/**
 * Proporções que o contrato reconhece. O valor efetivo NÃO é escolhido
 * pelo modelo: é definido pelo servidor (ver ASPECT_RATIO_PADRAO).
 */
export const ASPECT_RATIOS_SUPORTADOS = ["1:1", "4:5", "9:16"] as const;

export type AspectRatio = (typeof ASPECT_RATIOS_SUPORTADOS)[number];

/**
 * v1 usa "1:1" para TODAS as imagens, de todos os marketplaces.
 *
 * Isto é uma decisão de honestidade, não de preguiça: não existe no
 * repositório nenhuma fonte verificada das políticas de imagem de
 * Mercado Livre, Shopee, Amazon ou TikTok Shop, e a Constituição proíbe
 * afirmar regra de canal sem fonte. "1:1" é o formato quadrado
 * universalmente aceito em listagem de marketplace. Proporção por canal
 * fica registrada como pendência de compliance (ver NEXT_TASK.md), junto
 * da pendência já existente de compliance textual.
 */
export const ASPECT_RATIO_PADRAO: AspectRatio = "1:1";

/**
 * Teto operacional de prompts por job. NÃO é uma regra de marketplace e
 * NÃO substitui `quantidade_imagens_solicitada` — a quantidade produzida
 * é sempre a do projeto. Este limite só existe para que um projeto com
 * quantidade absurda seja rejeitado com `validation` ANTES de qualquer
 * chamada paga (o CHECK do banco só garante > 0, sem teto superior).
 */
export const LIMITE_MAXIMO_PROMPTS_IMAGEM = 12;

/**
 * ────────────────────────────────────────────────────────────────────
 * CORREÇÃO DE FIDELIDADE (2026-09-04) — por que este bloco mudou
 * ────────────────────────────────────────────────────────────────────
 * No primeiro E2E real, o modelo apagou marca e rótulo da embalagem. A
 * auditoria mostrou que não foi desobediência: era o sistema PEDINDO.
 *
 * A lista antiga trazia "não adicionar marca, logotipo, etiqueta ou
 * selo" e "não adicionar texto, letras, números ou tipografia". A
 * intenção era impedir o modelo de INVENTAR marca. Mas um modelo de
 * imagem não distingue "não invente" de "remova o que está aí" — e a
 * embalagem real TEM marca e rótulo. Resultado: produto descaracterizado.
 *
 * Havia um segundo defeito, de forma. O provedor monta a instrução como
 * `NÃO INCLUA, em hipótese alguma: <lista>`. A lista era de REGRAS já
 * negadas, então o texto final lia "não inclua: não alterar as cores do
 * produto" — negação dupla, semanticamente invertida. Um negative prompt
 * precisa listar COISAS a evitar, não regras.
 *
 * Agora: as regras de preservação vivem em INSTRUCAO_FIDELIDADE_PRODUTO
 * (prompt positivo, afirmativo) e o negative prompt lista apenas
 * substantivos — coisas que não devem aparecer no quadro.
 */
export const RESTRICOES_VISUAIS_GLOBAIS: readonly string[] = [
  "texto inventado",
  "marca ou logotipo diferente do que aparece nas fotos de referência",
  "etiqueta, selo ou adesivo inexistente",
  "produto redesenhado ou substituído por outro parecido",
  "produto deformado, derretido ou duplicado",
  "componentes, peças ou acessórios inexistentes",
  "marca d'água",
  "moldura, borda ou colagem",
  "preço, desconto, porcentagem ou banner promocional",
];

/**
 * Restrições adicionais da IMAGEM PRINCIPAL (capa). Só valem para ela:
 * a capa prioriza conformidade e leitura imediata do produto, enquanto
 * as secundárias podem mostrar contexto, uso e cena.
 *
 * A proibição de pessoa/mão saiu do escopo global (2026-09-04) porque
 * era autocontraditória: o próprio sistema oferece o tipo `uso`, e
 * demonstrar uso quase sempre pede uma mão. Ela continua valendo onde
 * faz sentido — a capa.
 */
export const RESTRICOES_IMAGEM_PRINCIPAL: readonly string[] = [
  "pessoa, mão ou modelo humano",
  "cenário elaborado ou props decorativos que disputem atenção",
  "texto sobreposto",
];

/**
 * Instrução de fidelidade — vai no INÍCIO do prompt positivo de toda
 * imagem, antes de qualquer descrição de cena.
 *
 * Existe porque o prompt antigo nunca mencionava as fotos anexadas. Ele
 * lia como briefing text-to-image ("Fotografia de produto: X. Cena:
 * ..."), então o modelo tratava a referência como inspiração de estilo,
 * não como fonte factual — e devolvia "cena gerada por IA" no lugar do
 * produto real. As fotos SÃO enviadas (base64, antes do texto, ver
 * lib/ai-gateway/provedores/google-imagem.ts); faltava dizer o que elas
 * são.
 */
export const INSTRUCAO_FIDELIDADE_PRODUTO =
  "As imagens de referência anexadas mostram o produto REAL e são a fonte factual. " +
  "Preserve com fidelidade a identidade visual do produto: marca, logotipo, rótulo, " +
  "textos e símbolos já impressos na embalagem, formato, proporções, quantidade de itens, " +
  "cores e acabamento. Reproduza o produto exatamente como ele aparece nas referências — " +
  "não o redesenhe, não o substitua por um parecido e não altere o que está escrito nele. " +
  "O que você deve criar é o restante: cenário, composição, iluminação, superfície e contexto.";

/**
 * Texto DENTRO da imagem continua proibido — mas por um motivo
 * diferente do da v1, e a diferença importa.
 *
 * v1 proibia todo texto, inclusive o que já existe na embalagem. Isso
 * era o bug. Agora a proibição é só de texto NOVO: legenda, chamada,
 * benefício escrito, preço. Texto que já está impresso no produto é
 * parte da identidade e deve ser preservado (ver
 * INSTRUCAO_FIDELIDADE_PRODUTO).
 *
 * Texto comercial continua fora do modelo de imagem porque modelos de
 * imagem ainda erram ortografia em português, e texto errado numa peça
 * de anúncio é pior que texto nenhum. A camada gráfica de texto (SVG
 * sobreposto, decidida em 2026-09-04) é o caminho para isso e ainda não
 * foi implementada.
 */
export const TEXTOS_PROIBIDOS_NA_IMAGEM: readonly string[] = [
  "legenda, chamada ou frase publicitária sobreposta",
  "preço, desconto ou porcentagem",
  "selo, carimbo ou badge inventado",
];

/**
 * Verdade visual apresentada ao modelo — derivada de `analise_visual` e
 * já FILTRADA por origem. É o único insumo de produto que o modelo
 * enxerga: ele nunca recebe o resultado bruto de analise_visual, nunca
 * recebe conteúdo de anúncio e nunca recebe fotos.
 */
export interface VerdadeVisual {
  produtoIdentificado: string | null;
  marca: string | null;
  modelo: string | null;
  categoria: string[] | null;
  resumoVisual: string;
  /** origem = "produto" — o que pode ser desenhado como o produto. */
  coresDoProduto: string[];
  materiaisDoProduto: string[];
  componentesDoProduto: string[];
  caracteristicasDoProduto: string[];
  usosConfirmados: string[];
  publicoConfirmado: string[];
  /** origem = "embalagem_fisica" — só desenhável em imagem do tipo `embalagem`. */
  itensDaEmbalagem: string[];
  /**
   * Textos JÁ IMPRESSOS no produto/embalagem, lidos pela análise visual
   * (2026-09-04). Não são insumo criativo — o modelo nunca pode pedir
   * para escrevê-los numa cena. Existem para o lado oposto: são
   * identidade a PRESERVAR, e entram no prompt de fidelidade.
   *
   * Antes desta data iam para `naoConfirmado`, que vira lista de
   * proibição — ou seja, o sistema mandava o gerador apagar a marca
   * impressa na embalagem real. Era a causa direta do produto
   * descaracterizado.
   */
  textosImpressosNoProduto: string[];
  /**
   * Tudo que NÃO pode virar elemento visual: informacoesNaoConfirmadas,
   * alertas e todo item com origem "material_promocional" ou
   * "indeterminado". Vai ao modelo como lista de proibição explícita,
   * nunca como insumo criativo.
   */
  naoConfirmado: string[];
}

/** Configuração efetiva desta execução — lida do Projeto Mestre, congelada junto do resultado. */
export interface ConfiguracaoPromptsImagem {
  quantidadeSolicitada: number;
  estilo: string | null;
  modo: string;
  /**
   * Direção criativa do ensaio, escrita pelo usuário (2026-09-04).
   * `null` = a IA decide. NUNCA é usada como prompt bruto: entra como
   * contexto para o modelo PLANEJAR, e o prompt final continua sendo
   * composto server-side a partir dos campos estruturados.
   */
  direcaoCriativa: string | null;
  /**
   * Instrução por imagem, POSICIONAL: índice 0 = imagem 1. Sempre tem
   * exatamente `quantidadeSolicitada` posições nesta configuração —
   * posições sem instrução ficam `""`, que significa "a IA decide esta
   * imagem". Congelar o array já normalizado evita que o resultado
   * persistido dependa de como o projeto estava no momento da leitura.
   */
  direcoesImagens: string[];
  /** Marketplaces do projeto — contexto/rastreabilidade. Ver nota sobre `marketplace` por prompt no cabeçalho de PromptImagem. */
  marketplaces: string[];
  aspectRatio: AspectRatio;
  tiposPermitidos: TipoImagem[];
  restricoesVisuaisGlobais: string[];
  /** v1: sempre vazio — nenhum texto autorizado dentro da imagem. */
  textosPermitidos: string[];
  textosProibidos: string[];
}

/** Exatamente o que foi apresentado ao modelo nesta chamada. */
export interface EntradaPromptsImagem {
  verdadeVisual: VerdadeVisual;
  restricoes: string[];
}

/**
 * O que o MODELO devolve por imagem — e SÓ isto. Nenhum campo
 * estrutural (principal, aspectRatio, textos permitidos/proibidos,
 * prompt final, negative prompt) é escrito pelo modelo: todos são
 * server-side. Mesmo desenho de segurança estrutural já usado em
 * `revisao_claude`, onde o modelo só podia escrever texto e os fatos
 * eram copiados pelo servidor.
 */
export interface PlanoImagemIA {
  ordem: number;
  tipo: TipoImagem;
  /**
   * O que ESTA imagem precisa vender — a decisão comercial, separada de
   * como o modelo deve produzi-la (2026-09-04). Antes só existia
   * `objetivo` misturado com a descrição da cena, e o resultado eram N
   * variações do mesmo retrato. Aqui o modelo é obrigado a declarar por
   * que esta imagem existe no anúncio.
   */
  objetivo: string;
  cena: string;
  enquadramento: Enquadramento;
  fundo: string;
  iluminacao: string;
  elementosObrigatorios: string[];
  elementosProibidos: string[];
}

export interface PromptsImagemIA {
  imagens: PlanoImagemIA[];
}

/**
 * Prompt final persistido — campos do modelo (PlanoImagemIA) + campos do
 * servidor. `promptTexto` e `negativePrompt` são COMPOSTOS pelo servidor
 * a partir dos campos estruturados: cada palavra do prompt final vem ou
 * de um template server-side, ou de um campo do modelo que já passou
 * pela validação determinística. Nada chega ao prompt final sem passar
 * por uma das duas portas.
 *
 * NÃO existe campo `marketplace` por prompt na v1, e a ausência é
 * deliberada: `quantidade_imagens_solicitada` é do PROJETO, não por
 * canal, então o conjunto de imagens serve o projeto inteiro. Um campo
 * sempre nulo seria pior que campo nenhum. Os marketplaces do projeto
 * ficam registrados em `ConfiguracaoPromptsImagem.marketplaces`.
 */
export interface PromptImagem extends PlanoImagemIA {
  /** Servidor: exatamente 1 prompt principal por job (o de tipo `capa_principal`, ordem 1). */
  principal: boolean;
  aspectRatio: AspectRatio;
  textosPermitidos: string[];
  textosProibidos: string[];
  /**
   * A instrução que o USUÁRIO escreveu para esta imagem, copiada pelo
   * servidor (nunca escrita pelo modelo). `""` = a IA decidiu sozinha.
   * Fica registrada para auditoria: permite comparar o que foi pedido
   * com o que foi planejado.
   */
  instrucaoUsuario: string;
  promptTexto: string;
  negativePrompt: string;
}

/**
 * Envelope persistido em `estudio_anuncios_resultados_pipeline.resultado`.
 *
 * Sem duplicação: os campos escritos pelo modelo aparecem UMA vez, dentro
 * de `prompts` (PromptImagem estende PlanoImagemIA). Não existe um campo
 * `saida` separado repetindo o mesmo conteúdo.
 */
export interface EnvelopeGeracaoPromptsImagem {
  fonteAnaliseVisual: FonteAnaliseVisual;
  configuracao: ConfiguracaoPromptsImagem;
  entrada: EntradaPromptsImagem;
  prompts: PromptImagem[];
}

/** Versão do ENVELOPE inteiro (configuracao + entrada + prompts), não só dos prompts. */
export const SCHEMA_VERSAO_GERACAO_PROMPTS_IMAGEM = 1;

export type { FonteAnaliseVisual };
