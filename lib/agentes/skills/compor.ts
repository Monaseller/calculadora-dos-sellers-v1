/**
 * Dos TRES CAMPOS da UI para o documento de Skill — F7b.1.
 *
 * ── Por que compor, e nao reimplementar ─────────────────────────────
 *
 * `importarEPersistirSkill` recebe UM `texto`: o documento no CDS Skill
 * Format v1 — um bloco cercado ```cds-skill``` com o manifesto em JSON,
 * e o corpo em Markdown depois. Ele extrai, parseia, valida campo a
 * campo, varre segredo, calcula hash e persiste. Sao regras de
 * 20260922, escritas com cuidado, e nada disso e refeito aqui.
 *
 * A UI, porem, nao pode pedir ao lojista um JSON com `formato`, `slug`
 * e SemVer. Ela pede tres coisas que uma pessoa sabe responder:
 *
 *   Nome              "Fechamento financeiro"
 *   Quando usar       "quando eu pedir resumo do mes"
 *   Instrucoes        o corpo, em texto livre
 *
 * Este modulo e a ponte entre as duas coisas, e ele e PURO: recebe os
 * tres campos, devolve o documento. Quem valida continua sendo o
 * formato; se a composicao produzir algo invalido, o serviço RECUSA — e
 * e assim que se descobre, em vez de um documento torto passar porque
 * ninguem conferiu.
 *
 * ── As derivacoes, e por que cada uma ───────────────────────────────
 *
 * `id` (slug)  derivado do nome. Se o slug sair vazio (nome so com
 *              simbolos), NAO se inventa um: recusa, porque um id
 *              gerado aleatoriamente viraria uma Skill que o dono nao
 *              reconhece na lista.
 * `versao`     "1.0.0". Versao nova e trabalho de `promoverSkillVigente`,
 *              que ja existe; a UI de criacao cria a primeira.
 * `origem`     "importada", e nao por gosto. O CHECK do banco aceita
 *              `oficial_cds`, `importada` e `gerada_ia`. Uma Skill
 *              escrita pelo DONO nao e nenhuma das tres com precisao;
 *              `importada` e a menos errada, porque o conteudo vem de
 *              fora do catalogo da CDS. Um quarto valor exigiria
 *              migration, e inventar um aqui quebraria o INSERT.
 */

/** Espelha `LIMITE_DESCRICAO` e `LIMITE_ITEM_TEXTO` do formato. */
export const MAX_NOME_DA_SKILL = 120;
export const MAX_DESCRICAO_DA_SKILL = 200;
export const MAX_CORPO_DA_SKILL = 32 * 1024;

export const VERSAO_INICIAL = "1.0.0";
export const ORIGEM_DA_UI = "importada";

export type ResultadoComposicao =
  | { readonly ok: true; readonly texto: string; readonly slug: string }
  | { readonly ok: false; readonly codigo: string; readonly mensagem: string };

export interface CamposDaSkill {
  readonly nome: unknown;
  readonly quandoUsar: unknown;
  readonly instrucoes: unknown;
  readonly descricao?: unknown;
}

/**
 * Nome -> slug.
 *
 * A gramatica e a do formato: `^[a-z0-9]+(-[a-z0-9]+)*$`. Acentos caem
 * na normalizacao, e nao no descarte: "Fechamento Mensal" vira
 * `fechamento-mensal`, e nao `fechamento`.
 */
export function slugDoNome(nome: string): string {
  return nome
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

function textoLimpo(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t === "" || t.length > max) return null;
  return t;
}

/**
 * Monta o documento.
 *
 * `quando_usar` e uma LISTA no formato. A UI pede um texto; cada linha
 * nao vazia vira um item. Uma pessoa que escreve tres situacoes em tres
 * linhas espera tres itens, e juntar tudo num item so faria a Skill
 * parecer ter uma condicao quando tem tres.
 */
export function comporDocumentoDeSkill(campos: CamposDaSkill): ResultadoComposicao {
  const nome = textoLimpo(campos.nome, MAX_NOME_DA_SKILL);
  if (nome === null) {
    return { ok: false, codigo: "nome_invalido", mensagem: "Dê um nome à Skill." };
  }

  const slug = slugDoNome(nome);
  if (slug === "") {
    return {
      ok: false,
      codigo: "nome_sem_letras",
      mensagem: "O nome precisa ter letras ou números.",
    };
  }

  const quandoBruto = textoLimpo(campos.quandoUsar, 4000);
  if (quandoBruto === null) {
    return {
      ok: false,
      codigo: "quando_usar_ausente",
      mensagem: "Diga quando este agente deve usar esta Skill.",
    };
  }
  const quandoUsar = quandoBruto.split("\n").map((l) => l.trim())
    .filter((l) => l !== "").slice(0, 50);
  if (quandoUsar.length === 0) {
    return {
      ok: false,
      codigo: "quando_usar_ausente",
      mensagem: "Diga quando este agente deve usar esta Skill.",
    };
  }
  if (quandoUsar.some((l) => l.length > 300)) {
    return {
      ok: false,
      codigo: "quando_usar_longo",
      mensagem: "Cada situação deve ter no máximo 300 caracteres.",
    };
  }

  const instrucoes = textoLimpo(campos.instrucoes, MAX_CORPO_DA_SKILL);
  if (instrucoes === null) {
    return {
      ok: false,
      codigo: "instrucoes_ausentes",
      mensagem: "Escreva as instruções da Skill.",
    };
  }

  // ── Descricao: ausente se DERIVA, presente se VALIDA ────────────
  //
  // Antes isto era `textoLimpo(...) ?? quandoUsar[0]`, e o `??` juntava
  // dois casos que nao sao o mesmo. `textoLimpo` devolve `null` tanto
  // para "nao veio" quanto para "veio e nao serve" — entao uma
  // descricao de 400 caracteres era DESCARTADA em silencio e trocada
  // pela primeira situacao. Quem escreveu veria no documento um texto
  // que nao digitou.
  //
  // Ausente e caso legitimo, e ai a primeira situacao serve: o formato
  // exige o campo, e repetir algo que a pessoa ja escreveu e melhor que
  // pedir duas vezes a mesma coisa. Presente e invalida e RECUSA.
  let descricao: string;
  if (campos.descricao === undefined || campos.descricao === null) {
    descricao = quandoUsar[0].slice(0, MAX_DESCRICAO_DA_SKILL);
  } else {
    const dada = textoLimpo(campos.descricao, MAX_DESCRICAO_DA_SKILL);
    if (dada === null) {
      return {
        ok: false,
        codigo: "descricao_invalida",
        mensagem: `A descrição deve ter no máximo ${MAX_DESCRICAO_DA_SKILL} caracteres.`,
      };
    }
    descricao = dada;
  }

  const manifesto = {
    formato: 1,
    id: slug,
    nome,
    versao: VERSAO_INICIAL,
    descricao,
    quando_usar: quandoUsar,
    origem: ORIGEM_DA_UI,
  };

  // `JSON.stringify` com indentacao: o documento fica legivel se algum
  // dia alguem exportar a Skill e abrir num editor.
  const texto = [
    "```" + "cds-skill",
    JSON.stringify(manifesto, null, 2),
    "```",
    "",
    instrucoes,
    "",
  ].join("\n");

  return { ok: true, texto, slug };
}
