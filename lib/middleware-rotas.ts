/**
 * Política de ALCANCE do middleware — Fase 0, etapa F0.b.
 *
 * ── O defeito que esta camada corrige ───────────────────────────────
 * A versão anterior mantinha uma lista `PUBLIC` que continha `"/"` e
 * testava com `pathname.startsWith(p)`. Como todo caminho começa com
 * `/`, a condição era SEMPRE verdadeira: o middleware liberava tudo e
 * nunca redirecionou ninguém. A autorização real do sistema passou a
 * ser, na prática, apenas o `getUserId()` de cada rota — e as rotas que
 * não o chamam ficaram sem nenhuma barreira.
 *
 * Aqui o casamento é EXATO (nunca prefixo), o MÉTODO é considerado, e o
 * default é NEGAR.
 *
 * ── O que esta etapa NÃO faz, de propósito ──────────────────────────
 * F0.b é mudança de ALCANCE, não de FORÇA. O cookie continua sendo
 * verificado apenas por PRESENÇA — sem assinatura, sem expiração, sem
 * papel, e sem nenhum tratamento do valor legado "1". Tudo isso é F0.c,
 * onde a sessão passa a ser assinada. Misturar as duas mudanças tornaria
 * impossível saber qual delas quebrou o quê.
 *
 * ── As quatro listas, e por que são separadas ───────────────────────
 * Público e "tem segredo próprio" são coisas diferentes: público é
 * "qualquer um pode"; segredo é "ninguém pode, exceto quem tem a chave"
 * — e quem valida a chave é a ROTA (fail-closed), nunca o middleware.
 * Juntar as duas listas apagaria essa distinção, que é justamente a que
 * mantém os crons funcionando sem abrir nada.
 */

export type Decisao = "liberar" | "bloquear_api" | "redirecionar";

/** Páginas alcançáveis sem sessão. */
export const PAGINAS_PUBLICAS: ReadonlySet<string> = new Set([
  "/",
  "/login",
  "/verificar-email",
]);

/**
 * Assets de `public/` que precisam ser servidos SEM sessão.
 *
 * Hoje: NENHUM — e isso é resultado de inspeção, não de descuido.
 * `public/` tem 3 arquivos; o único referenciado (`logo-cds.png`) é
 * renderizado apenas por `components/Sidebar.tsx`, dentro do layout
 * autenticado `app/(app)/layout.tsx`. O browser que o pede já carrega o
 * cookie, então ele passa pelo caminho normal de sessão. Nenhuma página
 * de `app/(public)` referencia imagem alguma.
 *
 * Menor superfície pública possível: só entra aqui o que comprovadamente
 * é pedido por alguém deslogado. Ver CLASSIFICACAO_ASSETS_PUBLIC abaixo
 * e o teste que impede um asset novo de passar despercebido.
 */
export const ASSETS_PUBLICOS: ReadonlySet<string> = new Set<string>([]);

/**
 * Classificação de TODO arquivo em `public/`. Existe para o teste
 * `scripts/testar-middleware.ts` falhar quando alguém acrescentar um
 * asset e não decidir se ele é público — evitando os dois erros
 * simétricos: liberar por extensão (superfície grande demais) e quebrar
 * a UI em silêncio (asset público bloqueado).
 *
 * "autenticado" = servido normalmente, mas só para quem tem sessão.
 * "publico"     = precisa constar TAMBÉM em ASSETS_PUBLICOS.
 */
export const CLASSIFICACAO_ASSETS_PUBLIC: Readonly<Record<string, "publico" | "autenticado">> = {
  // Usado por components/Sidebar.tsx, dentro de app/(app)/layout.tsx.
  "/logo-cds.png": "autenticado",
  // Sem nenhuma referência no código (verificado em F0.b). Não há motivo
  // para expô-los; se algum dia forem usados em tela pública, mudam aqui.
  "/logo-ml.svg": "autenticado",
  "/logo-shopee.svg": "autenticado",
};

/**
 * Rotas públicas por NECESSIDADE: são o próprio ato de autenticar ou o
 * retorno de um terceiro, que não tem como enviar nosso cookie.
 */
export const ROTAS_PUBLICAS: Readonly<Record<string, readonly string[]>> = {
  "/api/auth/login": ["POST"],
  // GET consta porque app/(app)/precificacao/page.tsx usa
  // href="/api/auth/logout". A rota só exporta POST, então segue
  // devolvendo 405 — comportamento preservado de propósito. Corrigir o
  // link é outra tarefa, fora do escopo de F0.b.
  "/api/auth/logout": ["GET", "POST"],
  "/api/auth/verificar-email": ["GET", "POST"],
  // As três abaixo passam a exigir sessão em F0.c. Em F0.b o fluxo OAuth
  // fica EXATAMENTE como está hoje.
  // `/api/auth/mercadolivre` permanece aqui, mas NÃO é mais pública de
  // fato: desde F0.c.6c ela exige sessão dentro da própria rota e manda
  // para `/login` quando não há. Ela fica na lista porque é NAVEGAÇÃO —
  // o middleware responderia 401 em JSON, que seria um beco sem saída na
  // tela, em vez do redirect que a rota sabe fazer.
  "/api/auth/mercadolivre": ["GET"],
  "/api/auth/shopee": ["GET", "POST"],
  // Callbacks continuam públicos de forma permanente: quem chama é o
  // marketplace. A proteção deles é a validação do code/assinatura
  // dentro da própria rota.
  "/api/auth/mercadolivre/callback": ["GET", "POST"],
  "/api/auth/shopee/callback": ["GET"],
};

/**
 * Rotas SEM cookie e COM segredo próprio. O middleware apenas deixa a
 * requisição CHEGAR; a autorização é da rota (CRON_SECRET /
 * x-worker-secret, ambas fail-closed).
 *
 * ⚠ Remover qualquer entrada daqui derruba um cron EM SILÊNCIO: o
 * agendador receberia um redirect 307 para /login e registraria sucesso.
 */
export const ROTAS_COM_SEGREDO: Readonly<Record<string, readonly string[]>> = {
  "/api/sync": ["GET"], // Vercel Cron 0 3 * * *
  "/api/internal/estudio-anuncios/worker": ["GET"], // Vercel Cron * * * * *
  "/api/internal/estudio-anuncios/executar": ["POST"], // scripts/estudio-anuncios-worker.mjs
  "/api/internal/sync/executar": ["POST"], // scripts/sync-worker.mjs
};

/**
 * DÍVIDA DECLARADA — desaparece em F0.c.
 *
 * Rotas legadas que não usam `cds_session`: elas autorizam pelo cookie
 * httpOnly `ml_access_token` — uma segunda autenticação paralela.
 * Mantidas com o comportamento ATUAL para reduzir o alcance da etapa.
 *
 * 3 → 2 no cutover de Meus Produtos (F0.c.5): `/api/anuncio` saiu. Ela
 * passou a exigir sessão porque, sem `userId` confiável, não há como
 * verificar de quem é a loja nem resolver a credencial no servidor — e
 * era por ela que a busca de anúncio por link perdia SKU e variações em
 * silêncio quando o cookie de 6 horas vencia.
 *
 * F0.c só é dada por concluída quando este objeto estiver VAZIO. O teste
 * trava o tamanho para impedir que a exceção cresça.
 */
export const EXCECOES_TEMPORARIAS_F0C: Readonly<Record<string, readonly string[]>> = {
  "/api/auth/status": ["GET"],
  "/api/ml/item-thumbnails": ["GET"],
};

function casa(
  tabela: Readonly<Record<string, readonly string[]>>,
  caminho: string,
  metodo: string
): boolean {
  const metodos = tabela[caminho];
  return Array.isArray(metodos) && metodos.includes(metodo);
}

/**
 * Decide o alcance de UMA requisição. Função pura: sem I/O, sem
 * `next/server`, sem env — é o que permite testá-la inteira sem HTTP.
 *
 * `temSessao` é presença de cookie, nada além disso (F0.b).
 */
/**
 * Este caminho precisa de sessão para seguir?
 *
 * Acrescentada em F0.c.3a. Com a sessão assinada, verificar custa uma
 * operação de HMAC e **lança** se `SESSION_SECRET` estiver ausente. Sem
 * esta pergunta, o middleware verificaria sessão até para `/login` — o
 * que, num ambiente sem o segredo configurado, deixaria a própria tela
 * de login inacessível e sem caminho de recuperação.
 *
 * Derivada de `decidirAcesso` de propósito: a política de rotas continua
 * existindo em UM lugar só.
 */
export function precisaDeSessao(caminho: string, metodo: string): boolean {
  return decidirAcesso(caminho, metodo, false) !== "liberar";
}

export function decidirAcesso(caminho: string, metodo: string, temSessao: boolean): Decisao {
  if (PAGINAS_PUBLICAS.has(caminho)) return "liberar";
  if (ASSETS_PUBLICOS.has(caminho)) return "liberar";
  if (casa(ROTAS_PUBLICAS, caminho, metodo)) return "liberar";
  if (casa(ROTAS_COM_SEGREDO, caminho, metodo)) return "liberar";
  if (casa(EXCECOES_TEMPORARIAS_F0C, caminho, metodo)) return "liberar";

  if (temSessao) return "liberar";

  // Default deny. API precisa de 401 legível por cliente `fetch`; página
  // precisa de redirect para o login preservando o destino.
  return caminho.startsWith("/api/") ? "bloquear_api" : "redirecionar";
}
