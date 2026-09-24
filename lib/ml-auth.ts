import {
  lerCredencialMLPorLojaEDono,
  lerCredencialMLAtivaDoDono,
  gravarCredencialML,
} from "@/lib/marketplace/credenciais";

/**
 * LOJAS-ANON-SELECT: este módulo tinha um cliente ANON próprio, usado só
 * por `resolverLojaDoUsuario`. O comentário antigo o justificava como
 * "menor privilégio, lê apenas `id`" — e isso descrevia bem a INTENÇÃO,
 * mas não o efeito: o privilégio não era da consulta, era da ROLE, e a
 * role `anon` enxergava a tabela inteira, tokens incluídos.
 *
 * Agora TODA leitura de `lojas` deste módulo passa por
 * `lib/marketplace/credenciais.ts`, e o cliente anon foi removido — não
 * desativado, removido, para que ninguém volte a usá-lo por engano.
 */

function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") || "";
  const entry = header.split("; ").find(c => c.startsWith(`${name}=`));
  return entry ? entry.slice(name.length + 1) : null;
}

export interface MLTokenResult {
  token: string;
  newAccessToken?: string;
  newRefreshToken?: string;
  expires?: number;
  lojaId?: string;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A loja indicada pelo cookie pertence a este usuário?
 *
 * Devolve o id só quando a linha existe, é de marketplace ML e tem
 * `user_id` igual ao da sessão. Loja de outro dono, loja órfã
 * (`user_id NULL`), loja de outro marketplace, id inexistente e id
 * malformado produzem o MESMO resultado: `null`. Quem chama não
 * consegue distinguir os casos, então não há enumeração.
 */
async function resolverLojaDoUsuario(lojaIdBruto: string, userId: string): Promise<string | null> {
  if (!UUID_REGEX.test(lojaIdBruto)) return null;

  // LOJAS-ANON-SELECT: era leitura com o cliente ANON. A capability
  // aplica exatamente os mesmos tres filtros (id + user_id + ML) e
  // devolve `linha: null` em erro — o fail-closed de antes, preservado.
  const { linha } = await lerCredencialMLPorLojaEDono(lojaIdBruto, userId);

  return linha?.id ? String(linha.id) : null;
}

/**
 * Tenta obter um token ML válido, com fallback para refresh automático.
 *
 * ── ISOLAMENTO DE PROPRIEDADE (F0.c.4) ──────────────────────────────
 * `userId` é OBRIGATÓRIO e vem da sessão — nunca do cliente. Antes desta
 * correção, a função resolvia a loja apenas por `loja_ativa_id`, um
 * cookie que qualquer cliente pode enviar com qualquer valor, e
 * consultava `lojas` só por `id`. Um usuário autenticado que informasse
 * o id da loja de outro recebia o **token de Mercado Livre alheio** — e,
 * pelo caminho de refresh, ainda **sobrescrevia os tokens daquela loja**
 * no banco.
 *
 * Agora a propriedade é validada UMA vez, antes de qualquer uso, e o
 * fracasso é fechado: cookie apontando para loja que não é do usuário
 * não cai em outra loja nem segue adiante — devolve `null`, e a rota
 * responde o mesmo "Conta do ML não conectada" de sempre.
 */
export async function getMLToken(request: Request, userId: string): Promise<MLTokenResult | null> {
  if (!userId) return null;

  const lojaIdCookie = getCookie(request, "loja_ativa_id");
  let lojaId: string | null = null;
  if (lojaIdCookie) {
    lojaId = await resolverLojaDoUsuario(lojaIdCookie, userId);
    // Loja declarada mas não pertencente ao usuário: nega tudo. Ignorar o
    // cookie e seguir seria aceitar uma tentativa de usar loja alheia.
    if (!lojaId) return null;
  }

  // 1. Cookie ml_access_token presente → usa direto
  const existing = getCookie(request, "ml_access_token");
  if (existing) return { token: existing };

  const refreshCookie = getCookie(request, "ml_refresh_token");

  // 2. Tenta refresh pelo cookie ml_refresh_token
  if (refreshCookie) {
    const result = await refreshMLToken(refreshCookie);
    if (result) {
      // Só grava na loja já validada como do usuário.
      if (lojaId) await saveTokensToDB(lojaId, userId, result);
      return { ...result, lojaId: lojaId ?? undefined };
    }
  }

  // 3. Fallback: lê access_token/refresh_token do banco pela loja ativa
  if (lojaId) {
    const { linha: loja } = await lerCredencialMLPorLojaEDono(lojaId, userId);

    if (loja?.access_token && new Date(loja.token_expires_at as string) > new Date()) {
      // Token do banco ainda válido → usa e re-emite o cookie
      return { token: loja.access_token, newAccessToken: loja.access_token, lojaId };
    }

    if (loja?.refresh_token) {
      const result = await refreshMLToken(loja.refresh_token);
      if (result) {
        await saveTokensToDB(lojaId, userId, result);
        return { ...result, lojaId };
      }
    }
  }

  return null;
}

/**
 * Margem aplicada à expiração: um token que vence em menos de 5 minutos é
 * tratado como já vencido, para não iniciar uma chamada ao ML que expira
 * no meio. Valor extraído de `getMLLojaAtiva`/`getMLLojaById`, que já
 * usavam exatamente `5 * 60 * 1000` — aqui ele ganha um nome só.
 */
export const MARGEM_EXPIRACAO_SEGUNDOS = 300;

/**
 * A credencial precisa ser renovada? (F0.c.5-A)
 *
 * DIFERENÇA DELIBERADA EM RELAÇÃO AO LEGADO: `token_expires_at` ausente
 * conta como **expirado**. As funções antigas fazem
 * `const expired = loja.token_expires_at && …`, o que trata "não sei
 * quando vence" como "ainda vale" e usa um token possivelmente morto. Sem
 * data não há como afirmar validade, e a resposta segura é renovar.
 *
 * As chamadas antigas NÃO foram reescritas nesta etapa: mudá-las alteraria
 * o comportamento de rotas que a F0.c.5-A não deve tocar (§14). A migração
 * delas é das fases seguintes.
 */
export function credencialExpirada(
  tokenExpiresAt: string | null | undefined,
  agoraMs: number = Date.now()
): boolean {
  if (!tokenExpiresAt) return true;
  const vence = new Date(tokenExpiresAt).getTime();
  if (!Number.isFinite(vence)) return true;
  return vence - MARGEM_EXPIRACAO_SEGUNDOS * 1000 < agoraMs;
}

/**
 * `export` acrescentado em F0.c.5-A. O corpo é o mesmo — o resolvedor novo
 * (`lib/ml-conexao.ts`) precisa do MESMO refresh, e não de uma segunda
 * implementação que possa divergir desta.
 */
export const TIMEOUT_REFRESH_MS = 20_000;

/**
 * O limite da renovacao. OPCIONAL, e com padrao limitado.
 *
 * ── Por que isto existe ─────────────────────────────────────────────
 *
 * Ate o I4B1 este `fetch` nao tinha `AbortController` nem timeout: uma
 * ponta de rede parada segurava a requisicao para sempre. Ele e
 * alcancavel de dentro da ingestao de perguntas — `getMLLojaById` roda
 * no confirmador de cobertura e de novo no adapter — entao qualquer
 * orcamento de acao construido sobre ele seria orcamento sobre um passo
 * ilimitado, que nao e orcamento.
 *
 * ── Por que o padrao e limitado, e nao `undefined` ──────────────────
 *
 * Os tres chamadores existentes passam UM argumento e tratam `null`
 * como falha. Um padrao limitado nao muda o contrato deles: muda apenas
 * o caso em que hoje eles esperariam indefinidamente — e esperar
 * indefinidamente ja era pior para todos, nao so para a ingestao. Os
 * 20 s sao os mesmos das outras duas chamadas ao Mercado Livre
 * (`mercado-livre-concessoes.ts`, `mercado-livre-perguntas.ts`), para
 * que exista UM numero neste caminho e nao tres.
 */
export interface OpcoesRefreshML {
  /** Teto proprio desta chamada. Sem ele, `TIMEOUT_REFRESH_MS`. */
  readonly timeoutMs?: number;
  /** Cancelamento vindo de fora — o deadline de quem orquestra. */
  readonly signal?: AbortSignal;
}

export async function refreshMLToken(
  refreshToken: string,
  opcoes?: OpcoesRefreshML
): Promise<MLTokenResult | null> {
  const limite = opcoes?.timeoutMs ?? TIMEOUT_REFRESH_MS;
  const controlador = new AbortController();
  const externo = opcoes?.signal;

  // ── Abortar de verdade, nao correr contra ─────────────────────────
  //
  // `Promise.race` devolveria cedo e deixaria a requisicao HTTP VIVA,
  // consumindo socket e podendo gravar token depois de quem desistiu ja
  // ter respondido. O sinal vai para dentro do `fetch`, que e o unico
  // lugar de onde a rede pode de fato ser cancelada.
  const relogio = setTimeout(() => controlador.abort(), limite);
  const propagar = () => controlador.abort();
  // Sinal que JA veio abortado nao dispara `abort` de novo: confere-se o
  // estado antes de escutar.
  if (externo?.aborted) controlador.abort();
  else externo?.addEventListener("abort", propagar, { once: true });

  try {
    const res = await fetch("https://api.mercadolibre.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type:    "refresh_token",
        client_id:     process.env.ML_CLIENT_ID!.trim(),
        client_secret: process.env.ML_CLIENT_SECRET!.trim(),
        refresh_token: refreshToken,
      }),
      signal: controlador.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.access_token) return null;
    return {
      token:           data.access_token,
      newAccessToken:  data.access_token,
      newRefreshToken: data.refresh_token ?? refreshToken,
      expires:         data.expires_in ?? 21600,
    };
  } catch {
    // Timeout, cancelamento e queda de rede chegam aqui iguais, e e
    // assim que os tres ja eram tratados: `null` e a falha tipada desta
    // funcao, e os tres chamadores ja a interpretam.
    return null;
  } finally {
    clearTimeout(relogio);
    externo?.removeEventListener("abort", propagar);
  }
}

/**
 * Grava a credencial renovada. `export` e o 3º parâmetro foram
 * acrescentados em F0.c.5-A; os 4 chamadores antigos continuam passando 2
 * argumentos e ignorando o retorno, então o comportamento deles é idêntico.
 *
 * `refreshTokenAnterior` liga uma escrita CONDICIONAL (compare-and-swap):
 * só grava se a linha ainda contiver o refresh_token de onde partimos. É a
 * proteção contra sobrescrita cega quando duas requisições renovam a mesma
 * loja ao mesmo tempo — usando as colunas que já existem, sem migration.
 * Devolve `false` quando nada foi gravado porque outra requisição chegou
 * primeiro; quem chama deve reler a linha em vez de reescrever por cima.
 *
 * `userId` acrescentado na PR #1 e OBRIGATÓRIO: a escrita passa a ser
 * `id + user_id`, nunca só `id`. O filtro soma-se ao CAS sem alterá-lo.
 */
export async function saveTokensToDB(
  lojaId: string,
  userId: string,
  result: MLTokenResult,
  refreshTokenAnterior?: string | null
): Promise<boolean> {
  const updates: Record<string, unknown> = {
    access_token:     result.newAccessToken,
    token_expires_at: new Date(Date.now() + (result.expires ?? 21600) * 1000).toISOString(),
  };
  if (result.newRefreshToken) updates.refresh_token = result.newRefreshToken;

  return gravarCredencialML(lojaId, userId, updates, refreshTokenAnterior);
}

/**
 * Renova a credencial e persiste com COMPARE-AND-SWAP — A2-C2.
 *
 * ── O defeito que esta funcao existe para fechar ────────────────────
 *
 * `getMLLojaById` e `getMLLojaAtiva` chamavam `saveTokensToDB` com TRES
 * argumentos. O quarto — `refreshTokenAnterior` — e o que liga a escrita
 * condicional que `gravarCredencialML` ja implementava. Sem ele a
 * gravacao era CEGA: duas execucoes que lessem a mesma linha vencida
 * renovavam com o MESMO `refresh_token`, o ML rotacionava nas duas, e a
 * segunda escrita apagava a credencial da primeira. O `refresh_token`
 * sobrescrito pode ja nao valer no provider — e a conta cai.
 *
 * ── A politica de quem PERDE o CAS: reler UMA vez ───────────────────
 *
 * Perder significa "outra requisicao rotacionou antes de mim". A
 * credencial que eu recebi pode ate funcionar, mas a do banco e a
 * oficial — e reescrever por cima e exatamente o que causou o defeito.
 * Entao o perdedor RELE e usa o que venceu.
 *
 * Uma releitura, nunca um laco. E ela NAO pode passar por
 * `getMLLojaById`/`getMLLojaAtiva`, que renovariam de novo e poderiam
 * perder de novo — a leitura entra por parametro, ja fechada no dono,
 * e e crua por construcao.
 *
 * ── Validade pela regra canonica ────────────────────────────────────
 *
 * `credencialExpirada` decide se a credencial do vencedor serve. A regra
 * de margem nao e reescrita aqui, e "renovou com 200" nunca vira prova
 * de validade por si.
 *
 * ── Fail-closed, e a mudanca de comportamento que isso traz ─────────
 *
 * Antes, refresh que falhava caia fora do `if` e a funcao devolvia o
 * token VENCIDO — um 401 garantido mais adiante, com diagnostico pior.
 * Agora a falha primeiro PROCURA a credencial que venceu a rotacao
 * (`procurarCredencialVencedora`); so quando nao ha vencedora e que
 * devolve `null`, que quem chama trata como credencial ausente e o dono
 * le como "precisa reconectar".
 *
 * ── O que esta funcao NAO garante ───────────────────────────────────
 *
 * Ela nao impede DUAS chamadas ao `/oauth/token`. O CAS acontece depois
 * do refresh, entao a corrida remota continua possivel — e o que ela
 * garante e que a persistencia local tenha UM vencedor e que o perdedor
 * use a credencial dele. `lib/ml-conexao.ts` acrescenta coalescencia por
 * instancia para o caso comum; traze-la para ca e decisao propria.
 */
async function renovarComCas(
  lojaId: string,
  userId: string,
  refreshAnterior: string,
  reler: Releitura
): Promise<{ accessToken: string } | null> {
  const resultado = await refreshMLToken(refreshAnterior);

  // ── O perdedor REMOTO ─────────────────────────────────────────────
  //
  // O refresh_token do ML e de USO UNICO. Entao, quando duas execucoes
  // partem do mesmo R0, o desfecho documentado NAO e "as duas renovam":
  // e uma renovar e a outra receber `invalid_grant`. Quem falha aqui
  // provavelmente nao tem credencial ruim — tem credencial VELHA, porque
  // outra execucao acabou de rotacionar.
  //
  // Devolver `null` direto transformaria essa corrida benigna num
  // "reconecte a conta" na cara do dono, com a conta sadia. Entao a
  // falha vira BUSCA pela vencedora, nunca um segundo OAuth.
  if (!resultado?.newAccessToken) {
    return procurarCredencialVencedora(refreshAnterior, reler);
  }

  const gravou = await saveTokensToDB(lojaId, userId, resultado, refreshAnterior);
  if (gravou) return { accessToken: resultado.newAccessToken };

  // CAS perdido: outra requisicao gravou antes. Mesma busca, mesmo
  // helper — dois algoritmos para o mesmo problema divergiriam no
  // primeiro conserto feito so de um lado.
  return procurarCredencialVencedora(refreshAnterior, reler);
}

/**
 * Quantas vezes a recuperacao rele a linha. Dois, nunca um laco.
 *
 * A segunda leitura existe por uma janela concreta: o perdedor pode
 * receber `invalid_grant` ANTES de o vencedor terminar de gravar. Uma
 * leitura so, nesse instante, ainda veria a credencial velha e
 * declararia "reconecte" sem motivo.
 *
 * `150` nao e garantia matematica de nada — e um teto operacional.
 * Coberta a janela, o custo maximo de uma falha genuina e esta espera.
 */
const MAX_LEITURAS_DE_RECUPERACAO = 2;
const ESPERA_ENTRE_LEITURAS_MS = 150;

/** A leitura CRUA da credencial, ja fechada no dono por quem a monta. */
type Releitura = () => Promise<{
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
} | null>;

/**
 * A linha relida prova que OUTRA execucao venceu a rotacao?
 *
 * ── Por que `refresh_token` DIFERENTE e obrigatorio ─────────────────
 *
 * "O token esta valido" nao prova vencedor nenhum: a linha pode estar
 * exatamente como a observamos. A evidencia de que houve rotacao e o
 * `refresh_token` ter MUDADO — o resto sao condicoes de uso.
 *
 * ── A conservadoria que isto cria, declarada ────────────────────────
 *
 * Quando o ML renova SEM emitir refresh_token novo, `saveTokensToDB`
 * preserva o anterior: o vencedor grava access e validade, e a coluna
 * `refresh_token` continua sendo R0. Nesse caso o perdedor NAO
 * reconhece a vencedora e falha fechado, mesmo com a conta sadia.
 *
 * E deliberado. A alternativa — aceitar "agora esta valida" como prova
 * — devolveria credencial com base em coincidencia de tempo, e fechar
 * demais custa um pedido de reconexao indevido; fechar de menos custa
 * agir com credencial que ninguem confirmou.
 */
function vencedoraUtilizavel(
  linha: { access_token: string | null; refresh_token: string | null; token_expires_at: string | null },
  refreshObservado: string
): boolean {
  if (!linha.access_token) return false;
  if (!linha.refresh_token) return false;
  if (linha.refresh_token === refreshObservado) return false;
  return !credencialExpirada(linha.token_expires_at);
}

/**
 * Procura a credencial que VENCEU a rotacao — A2-C2.
 *
 * Serve aos dois perdedores, e de proposito: o do CAS (o OAuth deu certo
 * mas outra requisicao gravou antes) e o do provider (o OAuth falhou
 * porque outra requisicao ja consumiu o refresh_token). O problema e o
 * mesmo — "alguem rotacionou, quem?" — e a resposta tem de ser uma.
 *
 * NUNCA emite um segundo OAuth. NUNCA grava. NUNCA devolve a credencial
 * observada de volta. Sem vencedora dentro do limite: `null`, que e a
 * direcao segura.
 */
async function procurarCredencialVencedora(
  refreshObservado: string,
  reler: Releitura
): Promise<{ accessToken: string } | null> {
  for (let leitura = 1; leitura <= MAX_LEITURAS_DE_RECUPERACAO; leitura++) {
    const atual = await reler();

    if (atual !== null && vencedoraUtilizavel(atual, refreshObservado)) {
      return { accessToken: atual.access_token as string };
    }

    // Espera SO entre leituras: a ultima nao paga um atraso que nao
    // vai usar.
    if (leitura < MAX_LEITURAS_DE_RECUPERACAO) {
      await new Promise((resolver) => setTimeout(resolver, ESPERA_ENTRE_LEITURAS_MS));
    }
  }

  return null;
}

/** Busca loja ML ativa pelo userId (para sync server-side sem cookie) */
export async function getMLLojaAtiva(userId: string): Promise<{
  lojaId:      string;
  accessToken: string;
  sellerId:    string;
  nickname:    string;
} | null> {
  const { linha: loja } = await lerCredencialMLAtivaDoDono(userId);

  if (!loja || !loja.access_token) return null;

  let accessToken = loja.access_token;
  const expired = loja.token_expires_at &&
    new Date(loja.token_expires_at).getTime() - 5 * 60 * 1000 < Date.now();

  if (expired && loja.refresh_token) {
    // A2-C2. Mesma corrida de `getMLLojaById`, mesma cura — e o MESMO
    // helper, para que um conserto futuro nao precise ser feito duas
    // vezes em dois lugares que ja provaram divergir.
    const renovada = await renovarComCas(
      loja.id,
      userId,
      loja.refresh_token,
      async () => (await lerCredencialMLAtivaDoDono(userId)).linha
    );
    if (renovada === null) return null;
    accessToken = renovada.accessToken;
  }

  return {
    lojaId:      loja.id,
    accessToken,
    sellerId:    loja.seller_id ?? "",
    nickname:    loja.nickname ?? "ML",
  };
}

/**
 * Busca uma loja ML específica pelo id (não "a mais recente ativa").
 * Adicionado 2026-07-11 para o worker de sincronização (sync_jobs) poder
 * sincronizar exatamente a loja do job — getMLLojaAtiva sempre resolveria
 * para a mais recente, o que quebraria o contrato "job por loja_id
 * específico" quando o usuário tem mais de uma loja ML. Mesma lógica de
 * refresh de token de getMLLojaAtiva, sem o filtro "mais recente ativa".
 *
 * ── PR #1: `userId` passou a ser OBRIGATÓRIO ────────────────────────
 * Esta função consultava `lojas` SÓ por `id` e devolvia token — o que a
 * tornava uma capability cross-tenant cuja segurança dependia
 * inteiramente da disciplina de quem chamava. Agora o par entra na
 * query: par coerente devolve credencial, par incoerente devolve `null`.
 * O `userId` não precisa vir provado — ele RESTRINGE a consulta, e é
 * isso que faz um job forjado em `sync_jobs` falhar fechado.
 *
 * O critério de SELEÇÃO da loja não mudou: continua sendo "exatamente
 * esta loja", nunca "a mais recente".
 */
export async function getMLLojaById(lojaId: string, userId: string): Promise<{
  lojaId:      string;
  accessToken: string;
  sellerId:    string;
  nickname:    string;
} | null> {
  const { linha: loja } = await lerCredencialMLPorLojaEDono(lojaId, userId);

  if (!loja || !loja.access_token) return null;

  let accessToken = loja.access_token;
  const expired = loja.token_expires_at &&
    new Date(loja.token_expires_at).getTime() - 5 * 60 * 1000 < Date.now();

  if (expired && loja.refresh_token) {
    // A2-C2. Este e o caminho que o live de 2026-09-22 exercitou: a
    // credencial estava vencida, foi renovada e persistida — sem CAS.
    const renovada = await renovarComCas(
      loja.id,
      userId,
      loja.refresh_token,
      async () => (await lerCredencialMLPorLojaEDono(lojaId, userId)).linha
    );
    if (renovada === null) return null;
    accessToken = renovada.accessToken;
  }

  return {
    lojaId:      loja.id,
    accessToken,
    sellerId:    loja.seller_id ?? "",
    nickname:    loja.nickname ?? "ML",
  };
}

/** Aplica cookies novos numa NextResponse após refresh */
export function applyMLCookies(res: any, result: MLTokenResult) {
  if (!result.newAccessToken) return;
  const isProd = process.env.NODE_ENV === "production";
  res.cookies.set("ml_access_token", result.newAccessToken, {
    httpOnly: true, secure: isProd, sameSite: "lax", path: "/",
    maxAge: result.expires ?? 21600,
  });
  if (result.newRefreshToken) {
    res.cookies.set("ml_refresh_token", result.newRefreshToken, {
      httpOnly: true, secure: isProd, sameSite: "lax", path: "/",
      maxAge: 86400 * 180,
    });
  }
}
