import "server-only";

/**
 * O que ainda falta para a capacidade FUNCIONAR — F7b.4.7.
 *
 * ── Dois mundos, e o §11 manda nao confundi-los ─────────────────────
 *
 *   INTEGRACAO EXTERNA (Composio)
 *     falta uma CONTA. Resolve-se com OAuth no provedor, e a CDS nunca ve
 *     o token — ela guarda um ponteiro opaco para perguntar "ja conectou?".
 *
 *   CAPACIDADE NATIVA (Mercado Livre, Shopee)
 *     a conta talvez JA EXISTA. A CDS tem infraestrutura propria para
 *     esses dois desde antes dos agentes: `lojas` guarda as contas e
 *     `agente_conexoes` diz qual loja cada agente usa.
 *
 *     Aqui o que falta quase sempre nao e conectar — e ESCOLHER. Mandar a
 *     pessoa autenticar de novo o que ela ja autenticou seria pedir duas
 *     vezes a mesma permissao, e o §13 nomeia isso.
 *
 * Por isso este modulo classifica ANTES de agir. Tratar tudo como Composio
 * criaria uma segunda conexao de Mercado Livre ao lado da que existe.
 *
 * ── A ambiguidade nao se resolve sozinha — §14 ──────────────────────
 *
 * Uma loja: pode-se oferecer "usar a sua loja X?", porque nao ha o que
 * confundir. Duas ou mais: a CDS PERGUNTA. Escolher a primeira porque e a
 * primeira faria o agente consultar a loja errada — e o dono descobriria
 * pelo numero errado, que e o pior lugar para descobrir.
 */
import { TOOL_PACKS } from "@/lib/agentes/factory/catalogo-ui";
import { FUNCOES } from "@/lib/agentes/funcoes/registry";
import { listarLojasConectadasDoDono } from "@/lib/marketplace/credenciais";
import { listarContasDoDono } from "@/lib/agentes/composio/conexao";
import {
  MARKETPLACE_POR_PLATAFORMA, nomeDaPlataforma,
} from "@/lib/agentes/conexoes/estado";
import { nomeDoAplicativo } from "@/lib/agentes/factory/capacidades";

/**
 * A plataforma deste pack, DERIVADA das Funcoes dele.
 *
 * Nao existe lista de packs aqui, e isso e deliberado. Cada Funcao declara
 * `conexaoNecessaria.plataforma` ao lado do proprio executor, e e essa
 * declaracao que o guard consulta. Uma segunda lista neste arquivo poderia
 * divergir dela, e a divergencia apareceria como "ativei e ele pede para
 * conectar de novo".
 *
 * Duas plataformas no mesmo pack devolvem `null`: a CDS nao escolhe por
 * qual conta perguntar quando ha duas respostas possiveis.
 *
 * ── Um achado que vale registrar: `vendas` nao entra aqui ───────────
 *
 * "Consultar minhas vendas do Mercado Livre" NAO exige conectar o Mercado
 * Livre. O pack `vendas` declara `exigeConexao: false` e le `pedidos`, que
 * o sync da CDS ja preencheu — a conexao foi feita uma vez, na tela de
 * Conexoes, e o agente consome o resultado dela. Como nenhuma Funcao dele
 * declara `conexaoNecessaria`, ele nunca chega a esta funcao.
 */
function plataformaDoPack(packId: string): string | null {
  const plataformas = new Set(
    requisitosDeConexaoDoPack(packId).map((r) => r.plataforma)
  );
  if (plataformas.size !== 1) return null;
  const [unica] = [...plataformas];
  return unica ?? null;
}

/**
 * Onde mora o nome de gente da plataforma, e o §10 no caminho NATIVO.
 *
 * O mapa de nomes saiu daqui para `conexoes/estado.ts`: ele e o mesmo
 * que a tela de prontidao usa, e duas copias divergiriam no dia em que
 * uma plataforma nova entrasse em uma so.
 *
 * ── §10 no caminho NATIVO: por que nao ha `reconectar` aqui ─────────
 *
 * MEDIDO no codigo de credencial: `ml-auth.ts` e `shopee-auth.ts`
 * RENOVAM o `access_token` com o `refresh_token` no momento da chamada
 * (`getMLToken`, `getShopeeLojaById`). Um token vencido nao prova que a
 * conexao morreu — na maioria dos casos ele e renovado e a chamada
 * funciona.
 *
 * Entao "reconecte o Mercado Livre" a partir de `token_expires_at` seria
 * pessimismo inventado: mandaria o dono refazer um OAuth que talvez nao
 * fosse necessario. Se a renovacao falhar, quem sabe disso e a chamada —
 * e o erro dela ja e classificado.
 *
 * O caso DERIVAVEL sem executar nada — `ativo = false` ou sem
 * `access_token`, que `estado.ts` chama de `desconectada` —
 * `listarLojasConectadasDoDono` ja exclui, e a falta cai em
 * `conectar_marketplace`. Nao ha terceiro caso a afirmar daqui.
 */
export interface LojaOferecida {
  readonly lojaId: string;
  /** O nome que o dono reconhece. Nunca o `seller_id`. */
  readonly nome: string;
}

export type FaltaParaCompletar =
  /** Nada falta. A capacidade funciona agora. */
  | { readonly falta: "nada" }
  /**
   * Precisa de conta no provedor externo.
   *
   * `reconectar: true` quer dizer que havia conta e ela deixou de servir
   * — §10. Mesmo botao, outra frase.
   */
  | {
      readonly falta: "conta_externa";
      readonly toolkit: string;
      readonly nome: string;
      readonly reconectar: boolean;
    }
  /** Ha contas nativas, e precisa dizer QUAL loja. */
  | {
      readonly falta: "escolher_loja";
      readonly marketplace: string;
      readonly nomeDoMarketplace: string;
      readonly lojas: readonly LojaOferecida[];
    }
  /** Capacidade nativa sem nenhuma conta conectada. */
  | {
      readonly falta: "conectar_marketplace";
      readonly marketplace: string;
      readonly nomeDoMarketplace: string;
    }
  /** Exige conexao e a CDS nao sabe de qual conta. Nao chuta. */
  | { readonly falta: "indefinida" }
  | { readonly falta: "falha" };

/**
 * O que falta, depois de a capacidade ter sido ativada.
 *
 * `chave` e `origem` vem da linha CONGELADA da pendencia — nunca do
 * cliente. Este modulo nao escreve nada: ele so olha e responde.
 */
export async function faltaParaCompletar(entrada: {
  readonly userId: string;
  readonly chave: string;
  readonly origem: "cds" | "integracao";
}): Promise<FaltaParaCompletar> {
  if (!entrada.userId || entrada.chave.trim() === "") return { falta: "falha" };

  // ── Integracao externa: e conta no provedor ───────────────────────
  if (entrada.origem === "integracao") {
    const toolkit = entrada.chave.trim().toLowerCase();
    const contas = await listarContasDoDono({ userId: entrada.userId, toolkit });
    if (contas.estado === "nao_configurado") return { falta: "indefinida" };
    if (contas.estado !== "ok") return { falta: "falha" };

    const conectada = contas.dados.some((c) => c.estado === "conectada");
    if (conectada) return { falta: "nada" };
    return {
      falta: "conta_externa", toolkit, nome: nomeDoAplicativo(toolkit),
      // §10: houve conta e ela nao serve mais.
      //
      // `autorizouAntes` e obrigatorio: MEDIDO que um link abandonado
      // termina `EXPIRED` igual a uma credencial revogada, e chamar o
      // primeiro de "sua conexao expirou" inventaria um passado.
      reconectar: contas.dados.some(
        (c) => c.estado === "com_problema" && c.autorizouAntes),
    };
  }

  // ── Pack interno: so alguns exigem conta ──────────────────────────
  const pack = TOOL_PACKS.find((p) => p.id === entrada.chave);
  if (pack === undefined) return { falta: "falha" };
  if (!pack.exigeConexao) return { falta: "nada" };

  const marketplace = plataformaDoPack(pack.id);
  // Exige conexao e nao sabemos de que: melhor dizer que nao sabe do que
  // mandar a pessoa conectar algo que talvez nao seja o certo.
  if (marketplace === null) return { falta: "indefinida" };

  // ── MEDIDO: `lojas.marketplace` guarda "ML" e "Shopee" ────────────
  //
  // Nao `mercado_livre`/`shopee`. A Skill e `agente_conexoes.plataforma`
  // falam em slug; a tabela `lojas` e mais antiga que os dois e fala em
  // "ML". `MARKETPLACE_POR_PLATAFORMA` e o unico ponto de traducao do
  // repositorio, e `app/api/agentes/[agenteId]/conexoes/route.ts` ja o usa.
  //
  // Consultar `lojas` com o slug devolve ZERO linha sempre — e o efeito
  // seria pedir ao dono para conectar um Mercado Livre que ele ja conectou,
  // que e exatamente o que o §13 proibe. O defeito nao aparecia porque a
  // fixture da suite inseria o slug: oraculo e codigo erravam juntos.
  const valorNoBanco = MARKETPLACE_POR_PLATAFORMA[marketplace];
  if (valorNoBanco === undefined) return { falta: "indefinida" };

  const nomeDoMarketplace = nomeDaPlataforma(marketplace);
  const { linhas, erro } = await listarLojasConectadasDoDono(entrada.userId, valorNoBanco);
  if (erro !== null) return { falta: "falha" };

  if (linhas.length === 0) {
    return { falta: "conectar_marketplace", marketplace, nomeDoMarketplace };
  }

  return {
    falta: "escolher_loja",
    marketplace,
    nomeDoMarketplace,
    // O nome que o dono reconhece, e `seller_id` NUNCA: ele e identificador
    // de conta no marketplace e nao diz nada a quem esta lendo.
    lojas: linhas.map((l) => ({
      lojaId: l.id,
      nome: l.nome ?? l.nickname ?? "Loja sem nome",
    })),
  };
}

/**
 * Os requisitos de conexao que este pack declara.
 *
 * Um pack pode ter varias Funcoes com o mesmo requisito `(plataforma,
 * recurso)`, e cada requisito precisa do seu binding. Devolver a lista
 * completa e o que permite gravar todos de uma vez — o dono escolheu uma
 * loja, e nao uma loja por Funcao.
 */
export function requisitosDeConexaoDoPack(
  packId: string
): readonly { readonly plataforma: string; readonly recurso: string }[] {
  const pack = TOOL_PACKS.find((p) => p.id === packId);
  if (pack === undefined || !pack.exigeConexao) return [];

  // Derivado do REGISTRY, e nao de uma lista no pack. `conexaoNecessaria`
  // mora ao lado do executor de cada Funcao, e e ela que o guard consulta
  // — uma segunda declaracao no catalogo de UI poderia divergir dela, e a
  // divergencia apareceria como "configurei e nao funciona".
  const vistos = new Set<string>();
  const requisitos: { plataforma: string; recurso: string }[] = [];
  for (const funcaoId of pack.funcoes) {
    if (!Object.prototype.hasOwnProperty.call(FUNCOES, funcaoId)) continue;
    const r = FUNCOES[funcaoId].conexaoNecessaria;
    if (r === null) continue;
    const chave = `${r.plataforma}|${r.recurso}`;
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    requisitos.push({ plataforma: r.plataforma, recurso: r.recurso });
  }
  return Object.freeze(requisitos);
}
