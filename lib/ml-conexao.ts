/**
 * Resolvedor server-side de conta Mercado Livre — F0.c.5, fase A.
 *
 * ── O que este módulo substitui ─────────────────────────────────────
 * O CDS tinha várias definições de "conectado ao Mercado Livre", e as
 * mais visíveis — Meus Produtos e Precificação — perguntavam ao
 * NAVEGADOR: existe o cookie `ml_access_token`? Como esse cookie vive 6
 * horas e só é renovado por rotas que a própria tela desabilita quando
 * ele falta, o usuário entrava num impasse: a UI dizia "não conectado"
 * justamente porque nada podia renovar a credencial. Foi o incidente de
 * 2026-08-14.
 *
 * Aqui a pergunta muda de lugar:
 *
 *     sessão CDS → uid → loja DO uid → credencial NO BANCO → estado
 *
 * O navegador deixa de ser fonte de verdade. Ele continua podendo dizer
 * QUAL loja (`loja_ativa_id`), que é identidade, nunca credencial.
 *
 * ── Quem já migrou, e o que sobrou ──────────────────────────────────
 * A fase A não migrou nada: este módulo e `GET /api/ml/conexao` nasceram
 * como fundação, sem consumidores. Desde então:
 *
 *   • F0.c.5 fase C — Meus Produtos passou a ler `/api/ml/conexao`;
 *   • F0.c.5 cutover — 4 rotas de ML passaram a usar `resolverContaML`;
 *   • F0.c.16 — Precificação migrou e `/api/auth/status`, sem consumidor,
 *     foi REMOVIDA do repositório.
 *
 * O que AINDA não migrou, e continua autorizando pelo cookie legado
 * `ml_access_token`: `/api/ml/item-thumbnails` (última entrada de
 * `EXCECOES_TEMPORARIAS_F0C`). `getMLToken` e `applyMLCookies` seguem
 * existindo para os consumidores restantes — `getMLToken` mantém o
 * caminho que devolve o cookie ANTES de verificar de qual loja ele é,
 * razão pela qual código novo usa `resolverContaML`, nunca ele.
 *
 * ── O que é reusado, e por quê ──────────────────────────────────────
 * `refreshMLToken`, `saveTokensToDB` e `credencialExpirada` vêm de
 * `lib/ml-auth.ts`. Uma segunda implementação de refresh seria uma
 * segunda chance de divergir do OAuth real do ML. O que NÃO é reusado é a
 * *seleção da loja*: `getMLLojaAtiva` pega "a mais recente ativa" e
 * `getMLLojaById` não verifica dono nenhum — as duas premissas que esta
 * arquitetura precisa abandonar.
 *
 * ── O token nunca sai do servidor ───────────────────────────────────
 * `resolverContaML` devolve `accessToken` porque quem chama é código de
 * servidor. A projeção para HTTP é `montarRespostaConexao`, que monta um
 * objeto campo a campo — nunca por espalhamento do resultado — para que
 * um campo novo no resolvedor não vaze sozinho para a resposta.
 */
import {
  refreshMLToken,
  saveTokensToDB,
  credencialExpirada,
  type MLTokenResult,
} from "@/lib/ml-auth";
import {
  lerCredencialMLPorLojaEDono,
  listarCredenciaisMLDoDono,
  type LinhaCredencialML,
} from "@/lib/marketplace/credenciais";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Só o marketplace tratado aqui. Shopee tem fluxo próprio. */
export const MARKETPLACE_ML = "ML";

/**
 * Identificação de loja que PODE circular. Sem token, sem `seller_id`:
 * o seller aparece repetido entre usuários diferentes no banco atual e
 * não é dado que a UI precise.
 */
export interface LojaPublicaML {
  id: string;
  nickname: string;
  marketplace: string;
}

/**
 * Por que não há conta utilizável.
 *
 * `LOJA_INVALIDA` não estava no rascunho do contrato e foi acrescentado
 * de propósito: quando o cliente INDICA uma loja e ela não é dele, dizer
 * `SEM_LOJA` seria mentira para um usuário que tem lojas, e um motivo
 * específico ("essa loja não existe" vs "essa loja é de outro") permitiria
 * enumerar lojas alheias. Todas as recusas de loja indicada — de outro
 * dono, inexistente, órfã, inativa, de outro marketplace, id malformado —
 * colapsam neste mesmo valor. É a regra de F0.c.4 mantida.
 */
export type MotivoConexaoML =
  | "SEM_LOJA"
  | "LOJA_NAO_DEFINIDA"
  | "LOJA_INVALIDA"
  | "PRECISA_RECONECTAR";

export type ResultadoContaML =
  | { ok: true; lojaId: string; accessToken: string; sellerId: string; nickname: string }
  | { ok: false; motivo: "SEM_LOJA" }
  | { ok: false; motivo: "LOJA_INVALIDA" }
  | { ok: false; motivo: "LOJA_NAO_DEFINIDA"; lojas: LojaPublicaML[] }
  | { ok: false; motivo: "PRECISA_RECONECTAR"; loja: LojaPublicaML };

/**
 * A forma da linha e a lista de colunas sensíveis passaram a viver em
 * `lib/marketplace/credenciais.ts` na PR #1 — uma definição só, no mesmo
 * lugar em que a query é montada.
 */
type LinhaLoja = LinhaCredencialML;

function publica(loja: { id: string; nickname: string | null }): LojaPublicaML {
  return { id: loja.id, nickname: loja.nickname ?? "", marketplace: MARKETPLACE_ML };
}

/** Erro de infraestrutura. Vira 5xx, nunca "desconectado". */
export class ErroConsultaConexaoML extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = "ErroConsultaConexaoML";
  }
}

/**
 * Renovações em voo, por loja, DENTRO DESTA INSTÂNCIA.
 *
 * Duas requisições simultâneas para a mesma loja compartilham uma única
 * chamada ao ML em vez de disputarem o refresh_token. Ver o bloco sobre
 * concorrência em `renovarCredencial`.
 */
const renovacoesEmVoo = new Map<string, Promise<MLTokenResult | null>>();

/**
 * CONCORRÊNCIA DE REFRESH — o que esta etapa resolve e o que não resolve.
 *
 * O risco: A e B veem o token vencido, os dois chamam o ML com o MESMO
 * refresh_token, o ML rotaciona no primeiro e rejeita o segundo. B
 * concluiria "PRECISA_RECONECTAR" com a credencial perfeitamente sadia, e
 * uma escrita atrasada de B poderia ainda sobrescrever a de A.
 *
 * Três defesas, todas sem migration e sem infraestrutura nova:
 *
 *  1. COALESCÊNCIA — na mesma instância, a segunda requisição espera a
 *     promessa da primeira. Cobre o caso comum (mesma função serverless
 *     servindo requisições concorrentes da mesma tela).
 *  2. ESCRITA CONDICIONAL — `saveTokensToDB` só grava se a linha ainda
 *     contiver o refresh_token de onde partimos. Quem perde a corrida não
 *     escreve por cima do vencedor.
 *  3. RELEITURA — perdeu a corrida ou o refresh falhou? Relê a linha antes
 *     de declarar PRECISA_RECONECTAR. Se outra requisição já renovou, o
 *     token novo está lá e o usuário nem percebe.
 *
 * O QUE CONTINUA EM ABERTO: instâncias serverless diferentes não
 * compartilham o Map, então duas máquinas ainda podem chamar o ML em
 * paralelo. O pior caso é UM `PRECISA_RECONECTAR` indevido, quando a
 * releitura acontece antes de a escrita do vencedor ficar visível — e a
 * tela seguinte já se corrige. Nunca há perda de credencial: nada aqui
 * apaga token. Resolver de verdade exigiria lock no Postgres, ou seja,
 * migration — fora do que esta etapa autoriza. O teste
 * "duas renovações concorrentes" documenta o limite em vez de escondê-lo.
 */
async function renovarCredencial(
  lojaId: string,
  refreshToken: string,
  userId: string
): Promise<{ token: string } | null> {
  let promessa = renovacoesEmVoo.get(lojaId);
  const souOOriginal = !promessa;

  if (!promessa) {
    promessa = (async () => {
      const resultado = await refreshMLToken(refreshToken);
      if (!resultado) return null;
      // PR #1: a gravação passou a exigir `id + user_id`. O filtro
      // soma-se ao compare-and-swap (`refresh_token` anterior) — a
      // semântica de "não gravei, outra requisição venceu" é a mesma.
      const gravou = await saveTokensToDB(lojaId, userId, resultado, refreshToken);
      // Não gravou = outra requisição rotacionou antes. O token que
      // recebemos pode até funcionar, mas o do banco é o oficial.
      return gravou ? resultado : null;
    })();
    renovacoesEmVoo.set(lojaId, promessa);
  }

  try {
    const resultado = await promessa;
    return resultado?.newAccessToken ? { token: resultado.newAccessToken } : null;
  } finally {
    if (souOOriginal) renovacoesEmVoo.delete(lojaId);
  }
}

/** Releitura pontual, sempre com o filtro de dono. */
async function relerLoja(lojaId: string, userId: string): Promise<LinhaLoja | null> {
  const { linha, erro } = await lerCredencialMLPorLojaEDono(lojaId, userId, {
    somenteAtiva: true,
  });

  if (erro) throw new ErroConsultaConexaoML(erro);
  return linha;
}

/**
 * Resolve a conta ML utilizável do usuário.
 *
 * ── PROPRIEDADE ─────────────────────────────────────────────────────
 * `userId` vem SEMPRE da sessão; `lojaId` vem do cliente e é apenas uma
 * pista. Os filtros `user_id`, `marketplace` e `ativo` são aplicados em
 * TODA consulta, e `id` só se soma a eles — nunca os substitui. Uma loja
 * de outro dono não produz credencial, não dispara refresh e não chega a
 * gerar chamada ao Mercado Livre.
 *
 * ── MÚLTIPLAS LOJAS ─────────────────────────────────────────────────
 * Sem `lojaId`: zero lojas é SEM_LOJA, uma loja é resolvida, e **duas ou
 * mais é LOJA_NAO_DEFINIDA** — não "a mais recente". Escolher sozinho
 * seria operar na loja errada calado, que é pior que pedir para escolher.
 */
export async function resolverContaML(
  userId: string,
  lojaId?: string | null
): Promise<ResultadoContaML> {
  // Sem sessão não há consulta. Nunca confiar em string vazia.
  if (!userId) return { ok: false, motivo: "LOJA_INVALIDA" };

  // Id malformado é barrado ANTES do banco: além de não ser dono de nada,
  // um valor não-UUID numa coluna uuid faz o Postgres devolver ERRO, e o
  // erro viraria 5xx em vez da recusa limpa que este caso merece.
  if (lojaId != null && lojaId !== "" && !UUID_REGEX.test(lojaId)) {
    return { ok: false, motivo: "LOJA_INVALIDA" };
  }

  const lojaIndicada = lojaId != null && lojaId !== "";

  // `lojaId` SOMA-SE aos filtros de dono dentro da capability — nunca os
  // substitui. É a mesma regra de antes, agora estrutural.
  const { linhas, erro } = await listarCredenciaisMLDoDono(
    userId,
    lojaIndicada ? lojaId : null
  );
  if (erro) throw new ErroConsultaConexaoML(erro);

  if (linhas.length === 0) {
    // Cliente indicou uma loja que não é dele (ou não existe): recusa
    // indistinguível. Sem indicação: ele realmente não tem loja ML.
    return { ok: false, motivo: lojaIndicada ? "LOJA_INVALIDA" : "SEM_LOJA" };
  }

  if (!lojaIndicada && linhas.length > 1) {
    return { ok: false, motivo: "LOJA_NAO_DEFINIDA", lojas: linhas.map(publica) };
  }

  return resolverCredencial(linhas[0], userId);
}

/** CASOS A–D da especificação, nesta ordem. */
async function resolverCredencial(loja: LinhaLoja, userId: string): Promise<ResultadoContaML> {
  const emUso = (token: string): ResultadoContaML => ({
    ok: true,
    lojaId: loja.id,
    accessToken: token,
    sellerId: loja.seller_id ?? "",
    nickname: loja.nickname ?? "",
  });

  // CASO A — ainda válido: usa, sem tocar no ML.
  if (loja.access_token && !credencialExpirada(loja.token_expires_at)) {
    return emUso(loja.access_token);
  }

  // CASO C — vencido e sem como renovar. Só reconectando.
  if (!loja.refresh_token) {
    return { ok: false, motivo: "PRECISA_RECONECTAR", loja: publica(loja) };
  }

  // CASO B — renova server-side e persiste.
  const renovado = await renovarCredencial(loja.id, loja.refresh_token, userId);
  if (renovado) return emUso(renovado.token);

  // CASO D — o refresh não serviu, OU outra requisição venceu a corrida.
  // Antes de mandar o usuário reconectar, confere o que está no banco
  // agora: renovação concorrente bem-sucedida já deixou o token novo lá.
  const atual = await relerLoja(loja.id, userId);
  if (atual?.access_token && !credencialExpirada(atual.token_expires_at)) {
    return {
      ok: true,
      lojaId: atual.id,
      accessToken: atual.access_token,
      sellerId: atual.seller_id ?? "",
      nickname: atual.nickname ?? "",
    };
  }

  // Credencial NÃO é apagada aqui. Um refresh recusado pode ser
  // instabilidade do ML, e apagar transformaria um susto em perda real.
  return { ok: false, motivo: "PRECISA_RECONECTAR", loja: publica(loja) };
}

/** O que `GET /api/ml/conexao` responde. Sem credencial, por construção. */
export interface RespostaConexaoML {
  conectado: boolean;
  precisaReconectar: boolean;
  motivo?: MotivoConexaoML;
  loja?: LojaPublicaML;
  lojas?: LojaPublicaML[];
}

/**
 * Projeta o resultado interno para HTTP.
 *
 * Escrita campo a campo DE PROPÓSITO. `{ ...resultado }` funcionaria hoje
 * e publicaria o `accessToken` no dia em que alguém mexesse no tipo — a
 * classe de erro que este módulo inteiro existe para evitar. Aqui, um
 * campo novo no resolvedor só aparece na resposta se for escrito aqui.
 *
 * `LOJA_NAO_DEFINIDA` não é desconexão: `conectado: false` com
 * `precisaReconectar: false`. A conta está lá; falta escolher qual.
 */
export function montarRespostaConexao(resultado: ResultadoContaML): RespostaConexaoML {
  if (resultado.ok) {
    return {
      conectado: true,
      precisaReconectar: false,
      loja: {
        id: resultado.lojaId,
        nickname: resultado.nickname,
        marketplace: MARKETPLACE_ML,
      },
    };
  }

  if (resultado.motivo === "PRECISA_RECONECTAR") {
    return {
      conectado: false,
      precisaReconectar: true,
      motivo: "PRECISA_RECONECTAR",
      loja: resultado.loja,
    };
  }

  if (resultado.motivo === "LOJA_NAO_DEFINIDA") {
    return {
      conectado: false,
      precisaReconectar: false,
      motivo: "LOJA_NAO_DEFINIDA",
      lojas: resultado.lojas,
    };
  }

  return { conectado: false, precisaReconectar: false, motivo: resultado.motivo };
}
