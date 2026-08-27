/**
 * Derivacao PURA do estado de uma conexao — SKILL-1D.c.
 *
 * ── Por que este modulo existe separado de `fatos.ts` ───────────────
 *
 * `fatos.ts` e `server-only`: ele le `lojas` com a service_role e por
 * isso LANCA sob `tsx`. Na SKILL-1D.b isso obrigou a suite a provar o
 * registry por leitura de fonte, sem executar nada — limitacao que ficou
 * registrada como o ponto fraco daquela fase.
 *
 * Aqui a decisao e outra: toda a REGRA vive neste modulo puro, que a
 * suite importa e executa de verdade. `fatos.ts` fica com o que so o
 * servidor pode fazer — a consulta — e nada mais. A separacao nao e
 * estetica: e o que torna a regra testavel por execucao.
 *
 * ── O que NAO ha aqui ───────────────────────────────────────────────
 *
 * Sem banco, sem rede, sem `server-only`, sem `Date.now()`. O relogio
 * ENTRA por parametro: uma funcao que le o relogio por dentro nao pode
 * ser testada em duas datas, e "expirado" e exatamente uma pergunta
 * sobre data.
 */
import type { EstadoConexao } from "@/lib/ia/conceitos";
import type { CoberturaRecurso, FatoConexao } from "@/lib/ia/skills/diagnostico";

/**
 * Margem antes do vencimento, em ms.
 *
 * 300 s — o mesmo valor que `MARGEM_EXPIRACAO_SEGUNDOS` de `ml-auth.ts`
 * e o mesmo `5 * 60 * 1000` embutido em `shopee-auth.ts`. Nao importamos
 * nenhum dos dois: `ml-auth.ts` faz `fetch`, e traze-lo para ca
 * contaminaria um modulo que precisa continuar sem rede.
 */
export const MARGEM_EXPIRACAO_MS = 300_000;

/**
 * O valor de `lojas.marketplace` para cada plataforma da Skill.
 *
 * O banco guarda `"ML"` e `"Shopee"`; a Skill declara slugs
 * (`mercado_livre`, `shopee`) — os mesmos de `ConexaoUI.tipo`. Este mapa
 * e o unico ponto de traducao, e ele e fechado: plataforma que a Skill
 * pedir e nao estiver aqui simplesmente nao resolve.
 */
export const MARKETPLACE_POR_PLATAFORMA: Readonly<Record<string, string>> = Object.freeze({
  mercado_livre: "ML",
  shopee: "Shopee",
});

/** A plataforma correspondente ao valor do banco, ou `null`. */
export function plataformaDeMarketplace(marketplace: unknown): string | null {
  if (typeof marketplace !== "string") return null;
  const par = Object.entries(MARKETPLACE_POR_PLATAFORMA).find(([, v]) => v === marketplace);
  return par ? par[0] : null;
}

/**
 * A linha de `lojas` reduzida ao que a REGRA precisa.
 *
 * `temAccessToken` e boolean, nao o token: o segredo morre em `fatos.ts`,
 * na linha em que a coluna vira `true`/`false`, e nunca entra neste
 * modulo. Nao ha campo onde ele caberia — e essa e a garantia, nao a
 * disciplina de quem chama.
 *
 * Tambem NAO ha `seller_id`, `shop_id`, `partner_id`, `partner_key` nem
 * `user_id`: nada disso participa da decisao de estado.
 */
export interface LinhaConexao {
  marketplace: string;
  ativo: boolean | null;
  temAccessToken: boolean;
  token_expires_at: string | null;
}

/**
 * O estado de uma conexao que EXISTE e pertence ao dono.
 *
 * Ausencia de conexao nao e estado: e ausencia de fato. Quem nao tem
 * linha autorizada nao produz `FatoConexao` nenhum, e a SKILL-1C deriva
 * `FALTA_CONEXAO` disso.
 *
 * ── Precedencia, e por que nesta ordem ──────────────────────────────
 *
 *  1. `ativo === false` -> `desconectada`. Vence tudo porque e ACAO
 *     DELIBERADA do dono: `desconectarLojaDoDono` zera `ativo` e os tres
 *     campos de credencial na mesma escrita. Reportar "expirada" para
 *     uma conta que a pessoa desligou seria descrever o efeito colateral
 *     em vez da causa.
 *
 *  2. sem `access_token` -> `desconectada`. Sem credencial nao ha
 *     conexao utilizavel. NAO e `expirada`: expirar afirma uma data, e
 *     aqui nao ha data nenhuma para afirmar.
 *
 *  3. `token_expires_at` ausente ou ilegivel -> `expirada`. FAIL-CLOSED,
 *     e isto e uma escolha registrada: `credencialExpirada` do ML ja se
 *     comporta assim (`if (!tokenExpiresAt) return true`), enquanto o
 *     trecho equivalente de `shopee-auth.ts` faz o oposto — com
 *     `token_expires_at` nulo, `(null && ...)` e falsy e a conexao passa
 *     por valida. Aqui as duas plataformas seguem a regra do ML: sem
 *     data nao ha como afirmar validade, e a resposta segura e recusar.
 *
 *  4. vence dentro da margem -> `expirada`.
 *
 *  5. resto -> `conectada`.
 *
 * `erro` NUNCA e produzido: `PROCEDENCIA_ESTADO_CONEXAO` ja marca esse
 * estado como inferido de `sync_jobs`, nao lido de coluna. Derivar
 * "erro" de uma falha de sync misturaria "a ultima sincronizacao falhou"
 * com "a credencial nao serve" — coisas diferentes.
 */
export function derivarEstadoConexao(linha: LinhaConexao, agoraMs: number): EstadoConexao {
  if (linha.ativo === false) return "desconectada";
  if (!linha.temAccessToken) return "desconectada";

  const vence = linha.token_expires_at === null ? NaN : new Date(linha.token_expires_at).getTime();
  if (!Number.isFinite(vence)) return "expirada";
  if (vence - MARGEM_EXPIRACAO_MS < agoraMs) return "expirada";

  return "conectada";
}

/**
 * A cobertura que esta fase consegue afirmar: NENHUMA.
 *
 * `lojas` guarda token e validade. NAO guarda recurso autorizado, e
 * nenhuma das duas plataformas oferece introspecao de escopo hoje — o
 * OAuth do ML pede `read_catalog write_items offline_access` numa string
 * ESTATICA do codigo, e o concedido nem sequer e gravado; a Shopee
 * autoriza por app da partner, sem parametro de escopo por loja.
 *
 * Entao "Shopee conectada" jamais prova "Shopee Chat autorizado", e
 * "ML conectado" jamais prova "Ads autorizado". Responder `confirmada`
 * seria otimismo inventado; responder `ausente` seria pessimismo
 * inventado. `nao_verificavel` e o unico valor verdadeiro.
 *
 * A funcao ignora `recurso` de proposito — nao ha, e nao pode haver,
 * `if (recurso === "chat")`. Quando alguma integracao real passar a
 * registrar o que autorizou, e ELA que define o que significa coberto.
 */
export function coberturaDoRecurso(_recurso: string): CoberturaRecurso {
  return "nao_verificavel";
}

/**
 * Monta o fato no formato que a SKILL-1C consome.
 *
 * Quatro campos, e nenhum a mais. Sem `lojaId`, sem `userId`, sem
 * `seller_id`, sem `shop_id`, sem token: o contrato publicado nao os tem,
 * e por isso nao ha o que filtrar na saida.
 */
export function montarFatoConexao(
  plataforma: string,
  recurso: string,
  linha: LinhaConexao,
  agoraMs: number
): FatoConexao {
  return {
    plataforma,
    recurso,
    estado: derivarEstadoConexao(linha, agoraMs),
    cobertura: coberturaDoRecurso(recurso),
  };
}
