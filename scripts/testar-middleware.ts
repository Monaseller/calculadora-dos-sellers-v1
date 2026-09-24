/**
 * Política de alcance do middleware — testes de F0.b.
 *
 * ── O defeito que originou esta suíte ───────────────────────────────
 * `middleware.ts` mantinha `"/"` na lista de rotas públicas e testava
 * com `startsWith`. Como todo caminho começa com `/`, a condição era
 * sempre verdadeira: o middleware liberava TUDO. As rotas internas e os
 * dois crons funcionavam justamente por causa desse defeito.
 *
 * Por isso o primeiro bloco daqui é o mais importante: ele prova que
 * corrigir o alcance NÃO derruba cron nem worker. Um cron bloqueado pelo
 * middleware receberia 307 para /login e registraria sucesso — falha
 * silenciosa, o modo de falha que já custou 54 dias de fila parada neste
 * repositório.
 *
 * NENHUM teste chama IA, rede ou banco. Só o bloco de assets lê disco
 * (lista `public/`), sem abrir conteúdo.
 *
 * Uso: npx tsx scripts/testar-middleware.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  decidirAcesso,
  precisaDeSessao,
  PAGINAS_PUBLICAS,
  ASSETS_PUBLICOS,
  CLASSIFICACAO_ASSETS_PUBLIC,
  ROTAS_PUBLICAS,
  ROTAS_COM_SEGREDO,
  EXCECOES_TEMPORARIAS_F0C,
  type Decisao,
} from "../lib/middleware-rotas";

let ok = 0, falhou = 0;
function t(nome: string, fn: () => void) {
  try { fn(); ok++; console.log(`  PASS  ${nome}`); }
  catch (e: any) { falhou++; console.log(`  FALHA ${nome} -> ${e?.message ?? e}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

/** Sem sessão — o caso que interessa em toda esta suíte. */
const sem = (caminho: string, metodo = "GET"): Decisao => decidirAcesso(caminho, metodo, false);
/** Com sessão (presença de cookie apenas — F0.b não valida força). */
const com = (caminho: string, metodo = "GET"): Decisao => decidirAcesso(caminho, metodo, true);

const UUID = "11111111-1111-1111-1111-111111111111";

// ────────────────────────────────────────────────────────────────────
console.log("\n[1. crons e workers continuam funcionando — BLOQUEANTE]");
// Se qualquer um destes falhar, a fila de produção para em silêncio.

t("1. GET /api/sync (cron 3h) passa sem cookie", () => {
  assert(sem("/api/sync") === "liberar", "cron de sync seria bloqueado pelo middleware");
});

t("2. GET /api/internal/estudio-anuncios/worker (cron 1min) passa sem cookie", () => {
  assert(sem("/api/internal/estudio-anuncios/worker") === "liberar",
    "cron do Estudio seria bloqueado — fila pararia sem sintoma");
});

t("3. POST /api/internal/estudio-anuncios/executar passa sem cookie", () => {
  assert(sem("/api/internal/estudio-anuncios/executar", "POST") === "liberar",
    "worker local perderia acesso a rota interna");
});

t("4. POST /api/internal/sync/executar passa sem cookie", () => {
  assert(sem("/api/internal/sync/executar", "POST") === "liberar", "worker de sync bloqueado");
});

t("4b. POST /api/internal/agentes/executar passa sem cookie", () => {
  // Este assert existe por causa de um FAIL real: no primeiro smoke da
  // AGENTES-FASE1C a rota interna foi criada mas NAO registrada aqui. O
  // worker reivindicou a tarefa, chamou a rota e levou 401 do MIDDLEWARE
  // — nao do handler. A tarefa ficou em `rodando` ate a orfa.
  assert(sem("/api/internal/agentes/executar", "POST") === "liberar",
    "worker de agentes bloqueado pelo middleware — a fila pararia sem sintoma");
});

t("4c. a rota de agentes NAO fica publica, e so por ter segredo proprio", () => {
  // "liberar" aqui significa DEIXAR CHEGAR, nunca "qualquer um pode".
  // O metodo e fechado: so POST.
  assert(sem("/api/internal/agentes/executar", "GET") === "bloquear_api",
    "GET na rota de agentes deveria cair no default deny");
  for (const metodo of ["PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
    assert(sem("/api/internal/agentes/executar", metodo) === "bloquear_api",
      `${metodo} na rota de agentes deveria cair no default deny`);

  // Nao esta em nenhuma lista de coisa publica.
  assert(!("/api/internal/agentes/executar" in ROTAS_PUBLICAS),
    "rota de agentes listada como PUBLICA — ela tem segredo proprio, nao e publica");
  assert(!PAGINAS_PUBLICAS.has("/api/internal/agentes/executar"),
    "rota de agentes listada como pagina publica");

  // A LIBERACAO SO SE JUSTIFICA porque o handler autentica sozinho. Se
  // alguem remover o segredo do handler e esquecer de tirar a rota
  // daqui, a rota vira um endpoint aberto — e este assert quebra.
  // SEM COMENTARIOS. O cabecalho da rota EXPLICA o segredo em prosa —
  // uma busca na fonte crua casaria com a explicacao e passaria mesmo que
  // o codigo tivesse parado de validar. Foi o que aconteceu na primeira
  // versao deste assert, flagrado pelo teste de mutacao.
  const fonteRota = fs
    .readFileSync(path.join(process.cwd(), "app/api/internal/agentes/executar/route.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert(/process\.env\.AGENTES_WORKER_INTERNAL_SECRET/.test(fonteRota),
    "rota liberada no middleware mas NAO le AGENTES_WORKER_INTERNAL_SECRET do ambiente");
  assert(/headers\.get\("x-worker-secret"\)/.test(fonteRota),
    "rota liberada mas nao le o header do segredo");
  assert(/!segredoEsperado/.test(fonteRota),
    "rota liberada mas nao e fail-closed quando a variavel de ambiente falta");
  assert(/segredoRecebido !== segredoEsperado/.test(fonteRota),
    "rota liberada mas nao compara o segredo recebido com o esperado");
});

t("4d. GET /api/internal/agentes/worker passa sem cookie", () => {
  // O DISPATCHER. O teste 4b cobre a rota que o worker MANUAL chama; esta
  // cobre a que o Vercel Cron chama sozinho. Sao portas diferentes, com
  // segredos diferentes, e so esta ultima faz a fila andar sem terminal.
  //
  // O modo de falha aqui e pior que 401: o agendador da Vercel trata 307
  // como sucesso. Sem esta entrada, o cron rodaria a cada minuto, seria
  // redirecionado para /login, registraria 100% de sucesso — e nenhuma
  // Task jamais sairia de `pendente`. Silencio total.
  assert(sem("/api/internal/agentes/worker", "GET") === "liberar",
    "dispatcher de agentes bloqueado pelo middleware — o cron falharia como sucesso");
});

t("4e. o dispatcher NAO fica publico, e so por ter segredo proprio", () => {
  // GET e o unico verbo. O agendador da Vercel so faz GET.
  for (const metodo of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
    assert(sem("/api/internal/agentes/worker", metodo) === "bloquear_api",
      `${metodo} no dispatcher deveria cair no default deny`);

  assert(!("/api/internal/agentes/worker" in ROTAS_PUBLICAS),
    "dispatcher listado como PUBLICO — ele tem segredo proprio, nao e publico");
  assert(!PAGINAS_PUBLICAS.has("/api/internal/agentes/worker"),
    "dispatcher listado como pagina publica");

  // Mesma disciplina do 4c: a liberacao so se justifica porque o HANDLER
  // autentica. Comparacao sobre a fonte SEM COMENTARIOS — o cabecalho da
  // rota fala de CRON_SECRET em prosa, e uma busca no arquivo cru passaria
  // mesmo com a guarda deletada.
  const fonteWorker = fs
    .readFileSync(path.join(process.cwd(), "app/api/internal/agentes/worker/route.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  assert(/process\.env\.CRON_SECRET/.test(fonteWorker),
    "dispatcher liberado no middleware mas NAO le CRON_SECRET do ambiente");
  assert(/headers\.get\("authorization"\)/.test(fonteWorker),
    "dispatcher liberado mas nao le o header Authorization");
  assert(/!segredo/.test(fonteWorker),
    "dispatcher liberado mas nao e fail-closed quando CRON_SECRET falta");
  assert(/auth !== `Bearer \$\{segredo\}`/.test(fonteWorker),
    "dispatcher liberado mas nao compara o Bearer recebido com o esperado");

  // Uma porta so: o dispatcher NAO aceita o segredo do worker manual, nem
  // segredo por query string. Duas portas para a mesma fila dobrariam a
  // superficie sem dobrar utilidade.
  assert(!/x-worker-secret/.test(fonteWorker),
    "dispatcher aceita x-worker-secret — ele tem UMA porta, e ela e o CRON_SECRET");
  assert(!/searchParams/.test(fonteWorker),
    "dispatcher le query string — segredo em URL vaza em log de acesso");

  // O teto declarado no codigo tem de existir: sem ele a funcao herda os
  // 60 s do glob de `vercel.json` e o laco e cortado no meio de uma Task.
  assert(/export const maxDuration = 300/.test(fonteWorker),
    "dispatcher sem maxDuration explicito — herdaria 60 s e cortaria a Task em `rodando`");
});

t("4f. a rota de consultar-vendas e de SESSAO, nao de segredo proprio", () => {
  // FUNCTION-RUNTIME-V1-B2A. A distincao que este assert protege: as
  // rotas de `internal/` se autenticam por segredo e por isso o
  // middleware as deixa CHEGAR sem cookie; esta e de usuario, e tem de
  // cair no default deny. Coloca-la em `ROTAS_COM_SEGREDO` por engano a
  // abriria para qualquer um — o handler nao le `CRON_SECRET` nenhum.
  const caminho = `/api/agentes/${UUID}/consultar-vendas`;

  assert(!(caminho in ROTAS_COM_SEGREDO),
    "consultar-vendas listada como rota com segredo proprio");
  assert(!("/api/agentes/[agenteId]/consultar-vendas" in ROTAS_COM_SEGREDO),
    "consultar-vendas listada com o caminho de template");
  assert(!(caminho in ROTAS_PUBLICAS),
    "consultar-vendas listada como rota publica");
  assert(!PAGINAS_PUBLICAS.has(caminho),
    "consultar-vendas listada como pagina publica");

  // Sem cookie, TODO verbo e negado.
  for (const metodo of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
    assert(sem(caminho, metodo) === "bloquear_api",
      `${metodo} em consultar-vendas deveria cair no default deny`);

  // Com cookie, os dois verbos que a rota expoe passam.
  assert(com(caminho, "POST") === "liberar", "POST bloqueado mesmo com sessao");
  assert(com(caminho, "GET") === "liberar", "GET bloqueado mesmo com sessao");
});

/**
 * Fonte de uma rota SEM comentarios.
 *
 * Mesma razao escrita no teste 4e: os cabecalhos destas rotas falam dos
 * proprios segredos em prosa, e uma busca no arquivo cru passaria verde
 * com a guarda deletada e o comentario intacto.
 */
function fonteSemComentarios(rota: string): string {
  return fs
    .readFileSync(path.join(process.cwd(), rota), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

t("4g. POST /api/internal/agentes/acoes passa sem cookie (ponte do n8n)", () => {
  // M2-I1-A8-FIX2. O modo de falha aqui NAO e silencioso como o do cron —
  // e pior de diagnosticar. O middleware respondia 401, que e exatamente
  // o status que a ponte responde quando o segredo nao confere. Quem
  // estivesse configurando o orquestrador leria "401" e procuraria o erro
  // na chave, que estava certa: a requisicao nunca chegou ao handler.
  //
  // O que distingue os dois e o CORPO, e e por isso que o smoke de
  // producao tem de olhar o corpo, nunca so o status:
  //   middleware -> { erro: true, mensagem: "Sessao invalida." }
  //   handler    -> { ok: false, erro: "nao_autorizado" }
  assert(sem("/api/internal/agentes/acoes", "POST") === "liberar",
    "ponte do n8n bloqueada pelo middleware — o handler nunca veria o segredo");
});

t("4h. a ponte NAO fica publica, e so por ter segredo proprio", () => {
  // POST e o unico verbo que a rota exporta. Um GET liberado seria uma
  // segunda porta para a mesma chave, sem revisao.
  for (const metodo of ["GET", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
    assert(sem("/api/internal/agentes/acoes", metodo) === "bloquear_api",
      `${metodo} na ponte deveria cair no default deny`);

  assert(!("/api/internal/agentes/acoes" in ROTAS_PUBLICAS),
    "ponte listada como PUBLICA — ela tem segredo proprio, nao e publica");
  assert(!PAGINAS_PUBLICAS.has("/api/internal/agentes/acoes"),
    "ponte listada como pagina publica");
  assert(!("/api/internal/agentes/acoes" in EXCECOES_TEMPORARIAS_F0C),
    "ponte listada como excecao temporaria — ela nao e divida, e rota com segredo");

  const fonte = fonteSemComentarios("app/api/internal/agentes/acoes/route.ts");

  assert(/process\.env\.N8N_BRIDGE_INTERNAL_SECRET/.test(fonte),
    "ponte liberada no middleware mas NAO le N8N_BRIDGE_INTERNAL_SECRET do ambiente");
  assert(/headers\.get\("x-worker-secret"\)/.test(fonte),
    "ponte liberada mas nao le o header x-worker-secret");
  assert(/!segredo/.test(fonte),
    "ponte liberada mas nao e fail-closed quando o segredo falta no servidor");
  assert(/!recebido/.test(fonte),
    "ponte liberada mas nao e fail-closed quando o header falta no pedido");
  assert(/recebido !== segredo/.test(fonte),
    "ponte liberada mas nao compara o segredo recebido com o esperado");

  // Segredo PROPRIO: reusar o do cron ou o do worker manual daria ao
  // portador de uma chave o poder de acionar o outro dominio.
  assert(!/CRON_SECRET/.test(fonte),
    "ponte aceita CRON_SECRET — o isolamento entre dominios depende de chaves distintas");
  assert(!/AGENTES_WORKER_INTERNAL_SECRET/.test(fonte),
    "ponte aceita o segredo do worker manual — mesma razao");
  assert(!/searchParams/.test(fonte),
    "ponte le query string — segredo em URL vaza em log de acesso");
});

t("4i. GET /api/internal/agentes/perguntas-poller passa sem cookie", () => {
  // M2-I1-A8-FIX2. Declarar NAO liga o polling: quem liga e a entrada em
  // `crons` de vercel.json, que segue ausente. Ela entra agora porque o
  // modo de falha de uma rota de cron ausente da policy e o 307 tratado
  // como sucesso — o mesmo que ja custou 54 dias de fila parada aqui.
  assert(sem("/api/internal/agentes/perguntas-poller", "GET") === "liberar",
    "poller bloqueado pelo middleware — no dia em que o cron subir, falharia como sucesso");
});

t("4j. o poller NAO fica publico, e so por ter segredo proprio", () => {
  for (const metodo of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
    assert(sem("/api/internal/agentes/perguntas-poller", metodo) === "bloquear_api",
      `${metodo} no poller deveria cair no default deny`);

  assert(!("/api/internal/agentes/perguntas-poller" in ROTAS_PUBLICAS),
    "poller listado como PUBLICO — ele tem segredo proprio");
  assert(!PAGINAS_PUBLICAS.has("/api/internal/agentes/perguntas-poller"),
    "poller listado como pagina publica");
  assert(!("/api/internal/agentes/perguntas-poller" in EXCECOES_TEMPORARIAS_F0C),
    "poller listado como excecao temporaria");

  const fonte = fonteSemComentarios("app/api/internal/agentes/perguntas-poller/route.ts");

  // Mesmo padrao do dispatcher e do worker do Estudio: Bearer, nao header
  // proprio. Rota de cron se autentica como rota de cron.
  assert(/process\.env\.CRON_SECRET/.test(fonte),
    "poller liberado no middleware mas NAO le CRON_SECRET do ambiente");
  assert(/headers\.get\("authorization"\)/.test(fonte),
    "poller liberado mas nao le o header Authorization");
  assert(/!segredo/.test(fonte),
    "poller liberado mas nao e fail-closed quando CRON_SECRET falta");
  assert(/auth !== `Bearer \$\{segredo\}`/.test(fonte),
    "poller liberado mas nao compara o Bearer recebido com o esperado");

  assert(!/x-worker-secret/.test(fonte),
    "poller aceita x-worker-secret — ele tem UMA porta, e ela e o CRON_SECRET");
  assert(!/searchParams/.test(fonte),
    "poller le query string — segredo em URL vaza em log de acesso");
  assert(!/request\.json\(\)/.test(fonte),
    "poller le corpo — ele nao aceita entrada nenhuma, e segredo em body nao e melhor que em URL");
});

t("4k. POST /api/internal/agentes/ingestao-perguntas passa sem cookie", () => {
  // M2-I1-A8B-I4C1. Terceira vez que uma rota interna com segredo proprio
  // nasce fora desta lista, e a primeira em que o defeito morre ANTES do
  // deploy: o invariante 38 reprovou no gate de prontidao do release.
  //
  // O modo de falha e o da ponte, e ele engana: o middleware responde 401,
  // o MESMO status que a rota responde quando o segredo nao confere. Quem
  // configurasse o n8n leria "401" e trocaria a chave, que estava certa.
  assert(sem("/api/internal/agentes/ingestao-perguntas", "POST") === "liberar",
    "rota de ingestao bloqueada pelo middleware — o handler nunca veria o segredo");
});

t("4l. a rota de ingestao NAO fica publica, e so por ter segredo proprio", () => {
  // POST e o unico verbo exportado por route.ts. Qualquer outro liberado
  // seria uma segunda porta para a mesma chave, sem revisao.
  for (const metodo of ["GET", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
    assert(sem("/api/internal/agentes/ingestao-perguntas", metodo) === "bloquear_api",
      `${metodo} na rota de ingestao deveria cair no default deny`);

  assert(!("/api/internal/agentes/ingestao-perguntas" in ROTAS_PUBLICAS),
    "rota de ingestao listada como PUBLICA — ela tem segredo proprio");
  assert(!PAGINAS_PUBLICAS.has("/api/internal/agentes/ingestao-perguntas"),
    "rota de ingestao listada como pagina publica");
  assert(!("/api/internal/agentes/ingestao-perguntas" in EXCECOES_TEMPORARIAS_F0C),
    "rota de ingestao listada como excecao temporaria — ela nao e divida");

  // Declarada UMA vez, e so com POST.
  assert(
    JSON.stringify(ROTAS_COM_SEGREDO["/api/internal/agentes/ingestao-perguntas"]) === '["POST"]',
    "a declaracao da rota de ingestao nao e exatamente [POST]");

  const fonte = fonteSemComentarios("app/api/internal/agentes/ingestao-perguntas/route.ts");

  assert(/process\.env\.N8N_INGESTAO_INTERNAL_SECRET/.test(fonte),
    "rota liberada no middleware mas NAO le N8N_INGESTAO_INTERNAL_SECRET do ambiente");
  assert(/headers\.get\("x-worker-secret"\)/.test(fonte),
    "rota liberada mas nao le o header x-worker-secret");
  assert(/!segredo/.test(fonte),
    "rota liberada mas nao e fail-closed quando o segredo falta no servidor");
  assert(/!recebido/.test(fonte),
    "rota liberada mas nao e fail-closed quando o header falta no pedido");
  assert(/recebido !== segredo/.test(fonte),
    "rota liberada mas nao compara o segredo recebido com o esperado");

  // Segredo PROPRIO. Reusar o da ponte daria a esta porta o alcance
  // daquela, que e o oposto do motivo de ela existir.
  assert(!/N8N_BRIDGE_INTERNAL_SECRET/.test(fonte),
    "rota de ingestao aceita o segredo da ponte generica — o isolamento depende de chaves distintas");
  assert(!/CRON_SECRET/.test(fonte),
    "rota de ingestao aceita CRON_SECRET — mesma razao");
  assert(!/AGENTES_WORKER_INTERNAL_SECRET/.test(fonte),
    "rota de ingestao aceita o segredo do worker manual — mesma razao");
  assert(!/searchParams/.test(fonte),
    "rota le query string — segredo em URL vaza em log de acesso");
});

t("4m. CHEGAR nao e AUTENTICAR: as duas camadas e os dois 401", () => {
  // O que esta suite nao provava, e que deixou o defeito passar: as suites
  // da rota chamam `route.POST()` direto, que e a camada DEPOIS desta.
  // Aqui se prova a ORDEM, nao o handler.
  //
  // Limitacao declarada: `next/server` nao roda fora do Next, entao as duas
  // fronteiras sao provadas SEPARADAMENTE — a decisao pela funcao pura, a
  // forma do 401 pela fonte de cada camada. O encadeamento num unico
  // runtime NAO e provado aqui; fica para o smoke de producao, e e por isso
  // que o smoke tem de olhar o CORPO, nunca so o status.

  // (a) a decisao do middleware e "deixar chegar", nao "esta autenticado"
  assert(sem("/api/internal/agentes/ingestao-perguntas", "POST") === "liberar",
    "a requisicao precisa CHEGAR ao handler");
  assert(precisaDeSessao("/api/internal/agentes/ingestao-perguntas", "POST") === false,
    "rota com segredo proprio nao deve pagar verificacao de sessao");
  // Sessao nao substitui o segredo: com ou sem cookie a decisao e a MESMA,
  // e quem autoriza continua sendo a rota.
  assert(com("/api/internal/agentes/ingestao-perguntas", "POST")
      === sem("/api/internal/agentes/ingestao-perguntas", "POST"),
    "a presenca de sessao muda a decisao — o segredo deixaria de ser a autoridade");

  // (b) o handler continua recusando por conta propria, e com OUTRA forma
  const rota = fonteSemComentarios("app/api/internal/agentes/ingestao-perguntas/route.ts");
  assert(/estado: "nao_autorizado"/.test(rota) && /401/.test(rota),
    "a rota nao devolve o proprio 401 `nao_autorizado`");

  const mw = fonteSemComentarios("middleware.ts");
  assert(/Sessão inválida\./.test(mw),
    "o middleware mudou a mensagem do 401 de sessao — o smoke de producao usa o CORPO para distinguir");
  assert(!/nao_autorizado/.test(mw),
    "o middleware passou a usar o vocabulario da rota — os dois 401 deixariam de ser distinguiveis");
  assert(!/Sessão inválida\./.test(rota),
    "a rota passou a usar a mensagem do middleware — mesma razao");
});

t("5. metodo errado numa rota com segredo NAO e liberado", () => {
  // O middleware não inventa método: worker é GET, executar é POST.
  assert(sem("/api/internal/estudio-anuncios/worker", "POST") === "bloquear_api",
    "POST no worker deveria cair no default deny");
  assert(sem("/api/internal/estudio-anuncios/executar", "GET") === "bloquear_api",
    "GET no executar deveria cair no default deny");
  assert(sem("/api/internal/agentes/executar", "GET") === "bloquear_api",
    "GET no executar de agentes deveria cair no default deny");
});

t("6. as 9 rotas com segredo estao declaradas, nem uma a mais", () => {
  // 5 -> 6 na FUNCTION-RUNTIME-V1-B1: entrou o dispatcher de agentes.
  // 6 -> 8 na M2-I1-A8-FIX2: entraram a ponte do orquestrador externo e o
  // poller de perguntas. As duas ja existiam como rota DEPLOYADA e nao
  // estavam aqui — o middleware as negava com o 401 de sessao antes do
  // segredo proprio de cada uma ser lido. Contagem nunca prova QUAIS; o
  // teste 37 abaixo e que amarra a policy ao filesystem.
  // 8 -> 9 na M2-I1-A8B-I4C1: entrou a porta agendada da ingestao de
  // perguntas, com o mesmo defeito de origem das duas da FIX2 — so que
  // desta vez o invariante 37/38 a descobriu no disco antes do deploy, e
  // nao o smoke de producao depois.
  assert(Object.keys(ROTAS_COM_SEGREDO).length === 9,
    `esperado 9 rotas com segredo, encontrado ${Object.keys(ROTAS_COM_SEGREDO).length}`);
});

// ────────────────────────────────────────────────────────────────────
console.log("\n[2. APIs protegidas devolvem 401]");

t("7. GET /api/estudio-anuncios/projetos sem cookie e bloqueada", () => {
  assert(sem("/api/estudio-anuncios/projetos") === "bloquear_api", "rota do Estudio ficou aberta");
});

t("8. GET /api/dashboard/resumo sem cookie e bloqueada", () => {
  assert(sem("/api/dashboard/resumo") === "bloquear_api", "dashboard ficou aberto");
});

t("9. POST publicar (acao irreversivel no ML) sem cookie e bloqueada", () => {
  assert(sem(`/api/estudio-anuncios/projetos/${UUID}/marketplaces/mercado-livre/publicar`, "POST")
    === "bloquear_api", "rota de publicacao ficou aberta");
});

t("10. rotas administrativas sem cookie sao bloqueadas", () => {
  for (const r of [
    "/api/admin/backfill-resumos-diarios",
    "/api/admin/shopee/reconciliar-financeiro",
    "/api/admin/shopee/backfill-pedidos-0707",
  ]) assert(sem(r) === "bloquear_api", `${r} ficou aberta`);
});

t("11. as mesmas rotas com COOKIE PRESENTE sao liberadas", () => {
  // "cookie presente", nunca "sessao valida": em F0.b o middleware nao
  // verifica assinatura, expiracao nem o valor legado "1". Isso e F0.c.
  assert(com("/api/estudio-anuncios/projetos") === "liberar", "cookie presente foi bloqueado");
  assert(com("/api/dashboard/resumo") === "liberar", "cookie presente foi bloqueado");
  assert(com("/api/admin/backfill-resumos-diarios") === "liberar", "cookie presente foi bloqueado");
});

t("12. caminho de API desconhecido cai no default DENY", () => {
  assert(sem("/api/rota-que-nao-existe") === "bloquear_api", "default deveria ser negar");
  assert(sem("/api/") === "bloquear_api", "default deveria ser negar");
});

// ────────────────────────────────────────────────────────────────────
console.log("\n[3. paginas: redirect, nao 401]");

t("13. /dashboard sem cookie redireciona", () => {
  assert(sem("/dashboard") === "redirecionar", "pagina protegida deveria redirecionar");
});

t("14. pagina profunda do Estudio sem cookie redireciona", () => {
  assert(sem(`/central-ia/estudio-anuncios/${UUID}`) === "redirecionar",
    "pagina protegida deveria redirecionar");
});

t("15. paginas publicas passam sem cookie", () => {
  for (const p of ["/", "/login", "/verificar-email"])
    assert(sem(p) === "liberar", `${p} deveria ser publica`);
  assert(PAGINAS_PUBLICAS.size === 3, "conjunto de paginas publicas mudou sem revisao");
});

t("16. pagina nunca recebe bloquear_api e API nunca recebe redirecionar", () => {
  assert(sem("/qualquer/pagina") === "redirecionar", "pagina deveria redirecionar");
  assert(sem("/api/qualquer") === "bloquear_api", "API deveria devolver 401");
});

// ────────────────────────────────────────────────────────────────────
console.log("\n[4. shopee/debug bloqueada]");

t("17. GET /api/auth/shopee/debug sem cookie e bloqueada", () => {
  // A rota FOI REMOVIDA em SHOPEE-DEBUG1 (2026-08-19) — ver teste 19.
  // Este assert permanece de proposito: se o caminho voltar a existir,
  // ele tem de nascer bloqueado, nunca publico.
  assert(sem("/api/auth/shopee/debug") === "bloquear_api", "debug da Shopee continua publica");
});

t("19. o arquivo da rota shopee/debug nao existe mais", () => {
  // Ela devolvia, a qualquer usuario autenticado: tamanho, 8 primeiros e
  // 8 ultimos caracteres da SHOPEE_PARTNER_KEY (segredo GLOBAL), o
  // baseString da assinatura, TRES assinaturas HMAC validas sobre ele e
  // DUAS URLs de autorizacao Shopee ja assinadas e prontas para uso.
  // Autenticacao reduzia a superficie; nao tornava aceitavel.
  assert(
    !fs.existsSync(path.join(process.cwd(), "app", "api", "auth", "shopee", "debug", "route.ts")),
    "app/api/auth/shopee/debug/route.ts voltou a existir — ela expunha material derivado da partner_key"
  );
});

t("18. shopee/debug nao consta em nenhuma das listas de excecao", () => {
  const alvo = "/api/auth/shopee/debug";
  assert(!(alvo in ROTAS_PUBLICAS), "debug listada como publica");
  assert(!(alvo in ROTAS_COM_SEGREDO), "debug listada como rota com segredo");
  assert(!(alvo in EXCECOES_TEMPORARIAS_F0C), "debug listada como excecao temporaria");
  assert(!PAGINAS_PUBLICAS.has(alvo) && !ASSETS_PUBLICOS.has(alvo), "debug listada como publica");
});

// ────────────────────────────────────────────────────────────────────
console.log("\n[5. rotas legadas: duas mantidas, /api/anuncio migrada]");

t("19. /api/anuncio PASSA A EXIGIR sessao (cutover F0.c.5)", () => {
  // Era a terceira excecao temporaria. Saiu da lista porque a rota agora
  // resolve a credencial do ML no servidor, e isso exige userId confiavel.
  assert(sem("/api/anuncio") === "bloquear_api",
    "/api/anuncio continua publica — a excecao nao foi removida");
  assert(!("/api/anuncio" in EXCECOES_TEMPORARIAS_F0C),
    "/api/anuncio ainda consta na excecao temporaria");
});

t("19b. sem sessao, /api/anuncio recebe 401 de API e NAO redirect HTML", () => {
  // Distincao que importa para o fetch do FormAnuncio: um redirect 307
  // para /login devolveria HTML e o `res.json()` da tela quebraria com
  // erro de parse em vez de uma mensagem util.
  assert(sem("/api/anuncio") !== "redirecionar", "rota de API caiu no fluxo de redirect de pagina");
});

t("20. /api/auth/status NAO e mais excecao — rota removida em F0.c.16", () => {
  // A rota foi deletada do repositorio: seu unico consumidor, a
  // Precificacao, passou a ler /api/ml/conexao. O caminho precisa cair no
  // default deny — se alguem recriar o arquivo, ele nao pode nascer
  // publico por uma entrada esquecida na tabela.
  assert(!("/api/auth/status" in EXCECOES_TEMPORARIAS_F0C),
    "/api/auth/status ainda consta na excecao temporaria");
  assert(sem("/api/auth/status") === "bloquear_api",
    "/api/auth/status continua acessivel sem cds_session");
  assert(com("/api/auth/status") === "liberar",
    "com sessao o caminho deveria seguir o fluxo normal");
});

t("21. /api/ml/item-thumbnails continua acessivel sem cds_session", () => {
  assert(sem("/api/ml/item-thumbnails") === "liberar", "comportamento legado foi alterado em F0.b");
});

t("22. a excecao temporaria tem EXATAMENTE 1 entrada", () => {
  // Trava contra crescimento silencioso. F0.c so termina com este objeto
  // vazio. 3 → 2 no cutover de Meus Produtos (so /api/anuncio saiu);
  // 2 → 1 em F0.c.16 (/api/auth/status migrada para /api/ml/conexao e
  // deletada). A entrada restante e nomeada de proposito: reduzir a
  // contagem trocando UMA rota por outra passaria despercebido.
  const n = Object.keys(EXCECOES_TEMPORARIAS_F0C).length;
  assert(n === 1, `excecao temporaria tem ${n} — F0.c.16 deixou exatamente 1`);
  assert("/api/ml/item-thumbnails" in EXCECOES_TEMPORARIAS_F0C,
    "a unica entrada restante deveria ser /api/ml/item-thumbnails");
});

// ────────────────────────────────────────────────────────────────────
console.log("\n[6. OAuth exatamente como antes]");

const OAUTH_PUBLICAS: [string, string][] = [
  ["/api/auth/login", "POST"],
  ["/api/auth/logout", "POST"],
  ["/api/auth/logout", "GET"],          // href em precificacao/page.tsx (segue 405 na rota)
  ["/api/auth/verificar-email", "GET"],
  ["/api/auth/verificar-email", "POST"],
  ["/api/auth/mercadolivre", "GET"],
  ["/api/auth/mercadolivre/callback", "GET"],
  ["/api/auth/mercadolivre/callback", "POST"],
  ["/api/auth/shopee", "GET"],
  ["/api/auth/shopee", "POST"],
  ["/api/auth/shopee/callback", "GET"],
];

t("23. as 11 combinacoes de auth/OAuth passam sem cookie", () => {
  // 12 → 11 em F0.c.6d: `/api/auth/relay` foi DELETADA. O callback do ML
  // passou a persistir sozinho, e ela era o unico consumidor.
  for (const [caminho, metodo] of OAUTH_PUBLICAS)
    assert(sem(caminho, metodo) === "liberar", `${metodo} ${caminho} foi bloqueada`);
});

t("24. as rotas publicas sao exatamente as 7 previstas", () => {
  // 8 → 7 em F0.c.6d, pela remocao do relay.
  const n = Object.keys(ROTAS_PUBLICAS).length;
  assert(n === 7, `esperado 7 rotas publicas, encontrado ${n}`);
});

t("24b. o relay nao existe mais em lugar nenhum", () => {
  // Ele aceitava access_token e refresh_token por QUERY STRING. Enquanto
  // o arquivo existir, alguem pode reativa-lo sem perceber o que ele fazia.
  assert(!("/api/auth/relay" in ROTAS_PUBLICAS), "relay ainda listado como rota publica");
  assert(!fs.existsSync(path.join(process.cwd(), "app", "api", "auth", "relay", "route.ts")),
    "o arquivo do relay continua no repositorio");
});

t("25. /api/auth/status-session NAO e publica (nao tem consumidor)", () => {
  assert(sem("/api/auth/status-session") === "bloquear_api", "status-session ficou aberta");
});

// ────────────────────────────────────────────────────────────────────
console.log("\n[7. assets de public/ classificados um a um]");

t("26. nenhum asset e publico hoje — e isso e deliberado", () => {
  // logo-cds.png so aparece em components/Sidebar.tsx, dentro do layout
  // autenticado. Quem o pede ja tem cookie.
  assert(ASSETS_PUBLICOS.size === 0,
    "algum asset foi liberado sem registro do motivo em CLASSIFICACAO_ASSETS_PUBLIC");
});

t("27. logo-cds.png sem cookie e tratado como conteudo autenticado", () => {
  assert(sem("/logo-cds.png") === "redirecionar", "asset autenticado deveria seguir a regra de pagina");
  assert(com("/logo-cds.png") === "liberar", "asset deveria carregar para quem tem sessao");
});

t("28. todo arquivo de public/ esta classificado no middleware", () => {
  const dir = path.join(process.cwd(), "public");
  const arquivos = fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true, recursive: true } as any)
        .filter((d: any) => d.isFile())
        .map((d: any) => "/" + path.relative(dir, path.join(d.parentPath ?? d.path ?? dir, d.name)).split(path.sep).join("/"))
    : [];

  const classificados = new Set(Object.keys(CLASSIFICACAO_ASSETS_PUBLIC));
  const novos = arquivos.filter(a => !classificados.has(a));
  assert(novos.length === 0,
    `Novo asset em public/ precisa ser classificado no middleware: ${novos.join(", ")} ` +
    `— decida em lib/middleware-rotas.ts se e "publico" (e some a ASSETS_PUBLICOS) ou "autenticado".`);

  const sumidos = [...classificados].filter(c => !arquivos.includes(c));
  assert(sumidos.length === 0,
    `Asset classificado que nao existe mais em public/: ${sumidos.join(", ")} — remover da classificacao.`);
});

t("29. asset marcado 'publico' precisa constar em ASSETS_PUBLICOS", () => {
  for (const [caminho, classe] of Object.entries(CLASSIFICACAO_ASSETS_PUBLIC)) {
    if (classe === "publico")
      assert(ASSETS_PUBLICOS.has(caminho), `${caminho} classificado como publico mas nao liberado`);
    else
      assert(!ASSETS_PUBLICOS.has(caminho), `${caminho} classificado como autenticado mas esta liberado`);
  }
});

// ────────────────────────────────────────────────────────────────────
console.log("\n[8. cobertura: as 58 rotas do inventario F0.a]");

/** caminho, metodo, decisao esperada SEM sessao. */
const INVENTARIO: [string, string, Decisao][] = [
  // — publicas (7; era 8 ate o relay ser deletado em F0.c.6d)
  ["/api/auth/login", "POST", "liberar"],
  ["/api/auth/logout", "POST", "liberar"],
  ["/api/auth/verificar-email", "GET", "liberar"],
  ["/api/auth/mercadolivre", "GET", "liberar"],
  ["/api/auth/mercadolivre/callback", "GET", "liberar"],
  ["/api/auth/shopee", "GET", "liberar"],
  ["/api/auth/shopee/callback", "GET", "liberar"],
  // — com segredo proprio (6; era 4 ate a AGENTES-FASE1C-FIX1 e 5 ate a
  //   FUNCTION-RUNTIME-V1-B1, quando o dispatcher entrou)
  ["/api/sync", "GET", "liberar"],
  ["/api/internal/estudio-anuncios/worker", "GET", "liberar"],
  ["/api/internal/estudio-anuncios/executar", "POST", "liberar"],
  ["/api/internal/sync/executar", "POST", "liberar"],
  ["/api/internal/agentes/executar", "POST", "liberar"],
  ["/api/internal/agentes/worker", "GET", "liberar"],
  // M2-I1-A8-FIX2: as duas que faltavam. A ponte e chamada por um
  // orquestrador EXTERNO; o poller, pelo cron — que segue NAO publicado.
  ["/api/internal/agentes/acoes", "POST", "liberar"],
  ["/api/internal/agentes/perguntas-poller", "GET", "liberar"],
  // M2-I1-A8B-I4C1: a porta agendada da ingestao de perguntas.
  ["/api/internal/agentes/ingestao-perguntas", "POST", "liberar"],
  // — excecao temporaria F0.c (1; era 3 ate o cutover F0.c.5 e 2 ate a
  //   F0.c.16, quando /api/auth/status saiu do inventario por ter sido
  //   DELETADA — o caminho segue coberto pelo teste 20)
  ["/api/ml/item-thumbnails", "GET", "liberar"],
  // — migrada em F0.c.5: exige sessao como qualquer rota de API
  ["/api/anuncio", "GET", "bloquear_api"],
  // — protegidas: auth e perfil (3)
  ["/api/auth/me", "GET", "bloquear_api"],
  ["/api/auth/status-session", "GET", "bloquear_api"],
  ["/api/auth/shopee/debug", "GET", "bloquear_api"],
  // — protegidas: admin (3)
  ["/api/admin/backfill-resumos-diarios", "GET", "bloquear_api"],
  ["/api/admin/shopee/reconciliar-financeiro", "GET", "bloquear_api"],
  ["/api/admin/shopee/backfill-pedidos-0707", "GET", "bloquear_api"],
  // — protegidas: dados e lojas (5)
  ["/api/dashboard/resumo", "GET", "bloquear_api"],
  ["/api/lojas", "GET", "bloquear_api"],
  ["/api/lojas/ativar", "POST", "bloquear_api"],
  ["/api/lojas/desconectar", "POST", "bloquear_api"],
  ["/api/perfil", "GET", "bloquear_api"],
  // — protegidas: marketplaces (7)
  ["/api/ml/vendas", "GET", "bloquear_api"],
  ["/api/ml/vendas-hoje", "GET", "bloquear_api"],
  ["/api/ml/importar-anuncios", "POST", "bloquear_api"],
  ["/api/ml/sync-precos", "POST", "bloquear_api"],
  ["/api/ml/sync-skus", "POST", "bloquear_api"],
  ["/api/shopee/vendas", "GET", "bloquear_api"],
  ["/api/shopee/importar-anuncios", "POST", "bloquear_api"],
  // — protegidas: sync (3)
  ["/api/sync/iniciar", "POST", "bloquear_api"],
  ["/api/sync/manual", "POST", "bloquear_api"],
  ["/api/sync/status", "GET", "bloquear_api"],
  // — protegidas: agentes (5; 1 na SKILL-1D.endpoint-B, 2 na agent-source-C,
  //   2 na FUNCTION-RUNTIME-V1-B2A)
  // Primeira area de agentes com SESSAO — as outras quatro de
  // `internal/` se autenticam por segredo proprio e ficam la em cima.
  // O mesmo caminho aparece DUAS vezes de proposito: o inventario e por
  // (caminho, metodo), e `/api/agentes` expoe os dois verbos. Aqui a
  // decisao nao depende do metodo — default deny —, e listar os dois
  // prova isso em vez de supor.
  [`/api/agentes/${UUID}/diagnostico`, "GET", "bloquear_api"],
  ["/api/agentes", "GET", "bloquear_api"],
  ["/api/agentes", "POST", "bloquear_api"],
  // FUNCTION-RUNTIME-V1-B2A: a rota que enfileira `consultar_vendas`.
  // Os DOIS verbos, pelo mesmo motivo do par acima — e porque aqui a
  // distincao importa: `POST` cria trabalho, `GET` le estado, e nenhum
  // dos dois pode passar sem sessao.
  [`/api/agentes/${UUID}/consultar-vendas`, "POST", "bloquear_api"],
  [`/api/agentes/${UUID}/consultar-vendas`, "GET", "bloquear_api"],
  // — protegidas: Estudio (15)
  ["/api/estudio-anuncios/projetos", "GET", "bloquear_api"],
  [`/api/estudio-anuncios/projetos/${UUID}`, "GET", "bloquear_api"],
  [`/api/estudio-anuncios/projetos/${UUID}/fotos`, "POST", "bloquear_api"],
  [`/api/estudio-anuncios/projetos/${UUID}/pipeline/iniciar`, "POST", "bloquear_api"],
  [`/api/estudio-anuncios/projetos/${UUID}/pipeline/retomar`, "POST", "bloquear_api"],
  [`/api/estudio-anuncios/projetos/${UUID}/compliance/mercado-livre`, "POST", "bloquear_api"],
  [`/api/estudio-anuncios/projetos/${UUID}/conteudo/mercado-livre/versoes`, "POST", "bloquear_api"],
  [`/api/estudio-anuncios/projetos/${UUID}/conteudo/mercado-livre/aprovar`, "POST", "bloquear_api"],
  [`/api/estudio-anuncios/projetos/${UUID}/marketplaces/mercado-livre`, "PATCH", "bloquear_api"],
  [`/api/estudio-anuncios/projetos/${UUID}/marketplaces/mercado-livre/categorias`, "GET", "bloquear_api"],
  [`/api/estudio-anuncios/projetos/${UUID}/marketplaces/mercado-livre/lojas`, "GET", "bloquear_api"],
  [`/api/estudio-anuncios/projetos/${UUID}/marketplaces/mercado-livre/validacao-oficial`, "POST", "bloquear_api"],
  [`/api/estudio-anuncios/projetos/${UUID}/marketplaces/mercado-livre/publicar`, "POST", "bloquear_api"],
  [`/api/estudio-anuncios/projetos/${UUID}/exportacao`, "POST", "bloquear_api"],
  [`/api/estudio-anuncios/projetos/${UUID}/exportacao/${UUID}/arquivo`, "GET", "bloquear_api"],
];

t("30. as 58 rotas do inventario caem na classe correta", () => {
  // 51 → 50 em F0.c.6d: `/api/auth/relay` deixou de existir.
  // 50 → 49 em F0.c.16: `/api/auth/status` deixou de existir.
  // 49 → 50 na AGENTES-FASE1C-FIX1: `/api/internal/agentes/executar` entrou.
  // 50 → 51 na SKILL-1D.endpoint-B: `/api/agentes/[agenteId]/diagnostico`
  // entrou. E a primeira rota de agentes protegida por SESSAO, e nao por
  // segredo de worker — o inventario prova que ela cai em `bloquear_api`
  // sem cookie e em `liberar` com cookie, como qualquer API privada.
  // 51 → 53 na SKILL-1D.agent-source-C: `GET` e `POST /api/agentes`, a
  // fonte real dos agentes do dono. Duas entradas para um caminho so,
  // porque o inventario e por (caminho, metodo).
  // 53 -> 54 na FUNCTION-RUNTIME-V1-B1: `/api/internal/agentes/worker`, o
  // dispatcher chamado pelo Vercel Cron. Segunda rota de agentes com
  // segredo proprio, e a unica que nao depende de terminal aberto.
  // 54 -> 56 na FUNCTION-RUNTIME-V1-B2A: `POST` e `GET` de
  // `/api/agentes/[agenteId]/consultar-vendas`, a primeira superficie
  // publica que enfileira uma Funcao real. Duas entradas para um
  // caminho so, porque o inventario e por (caminho, metodo).
  // 56 -> 58 na M2-I1-A8-FIX2: `POST /api/internal/agentes/acoes` e
  // `GET /api/internal/agentes/perguntas-poller`.
  //
  // ⚠ ESTA LISTA E MANUAL, e foi por isso que o defeito da FIX2 passou:
  // as duas rotas nasceram no A7 e no A8 sem que nada aqui reclamasse da
  // ausencia delas. Manter o inventario tem valor — ele fixa a DECISAO
  // esperada por (caminho, metodo) —, mas quem descobre rota nova e o
  // teste 37, que varre o filesystem. Os dois sao complementares, e o
  // segundo e o que nao depende de alguem lembrar.
  // 58 -> 59 na M2-I1-A8B-I4C1: `POST /api/internal/agentes/ingestao-perguntas`.
  assert(INVENTARIO.length === 59, `inventario tem ${INVENTARIO.length} rotas, esperado 59`);
  for (const [caminho, metodo, esperado] of INVENTARIO) {
    const obtido = sem(caminho, metodo);
    assert(obtido === esperado, `${metodo} ${caminho}: esperado ${esperado}, obtido ${obtido}`);
  }
});

t("31. toda rota do inventario e liberada com cookie presente", () => {
  for (const [caminho, metodo] of INVENTARIO)
    assert(com(caminho, metodo) === "liberar", `${metodo} ${caminho} bloqueada com cookie presente`);
});

t("32. nenhum caminho aparece em duas listas ao mesmo tempo", () => {
  const listas: [string, string[]][] = [
    ["ROTAS_PUBLICAS", Object.keys(ROTAS_PUBLICAS)],
    ["ROTAS_COM_SEGREDO", Object.keys(ROTAS_COM_SEGREDO)],
    ["EXCECOES_TEMPORARIAS_F0C", Object.keys(EXCECOES_TEMPORARIAS_F0C)],
    ["PAGINAS_PUBLICAS", [...PAGINAS_PUBLICAS]],
    ["ASSETS_PUBLICOS", [...ASSETS_PUBLICOS]],
  ];
  const visto = new Map<string, string>();
  for (const [nome, caminhos] of listas)
    for (const c of caminhos) {
      const antes = visto.get(c);
      assert(!antes, `"${c}" esta em ${antes} E em ${nome}`);
      visto.set(c, nome);
    }
});

// ────────────────────────────────────────────────────────────────────
console.log("\n[9. matcher: o que NEM CHEGA ao middleware]");
//
// `decidirAcesso()` só é consultada para caminhos que o matcher deixa
// passar. Provar a política sem provar o matcher deixaria de fora
// exatamente a camada onde apareceu o achado do `_next` (F0.b.1).
//
// O matcher precisa ser um LITERAL em middleware.ts (o Next extrai
// `config.matcher` estaticamente no build), então ele não pode ser
// importado daqui. A alternativa honesta é ler o arquivo e validar o
// literal — assim uma edição futura no middleware quebra este teste em
// vez de passar despercebida.

const FONTE_MIDDLEWARE = fs.readFileSync(path.join(process.cwd(), "middleware.ts"), "utf8");
const MATCHER_ESPERADO = "/((?!_next|favicon.ico).*)";

function extrairMatcher(fonte: string): string[] {
  const bloco = fonte.match(/matcher:\s*\[([\s\S]*?)\]/);
  if (!bloco) throw new Error("nao encontrei config.matcher em middleware.ts");
  return [...bloco[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
}

const MATCHERS = extrairMatcher(FONTE_MIDDLEWARE);

/** Semântica do Next para padrão simples: casamento ancorado no pathname inteiro. */
function matcherCasa(caminho: string): boolean {
  return MATCHERS.some(p => new RegExp(`^${p}$`).test(caminho));
}

t("33. middleware.ts declara exatamente o matcher esperado", () => {
  assert(MATCHERS.length === 1, `esperado 1 matcher, encontrado ${MATCHERS.length}`);
  assert(MATCHERS[0] === MATCHER_ESPERADO,
    `matcher divergente.\n  esperado: ${MATCHER_ESPERADO}\n  encontrado: ${MATCHERS[0]}`);
});

t("34. infraestrutura interna do Next fica FORA do middleware", () => {
  for (const caminho of [
    "/_next/static/chunks/main-app.js",
    "/_next/static/css/app.css",
    "/_next/static/media/fonte.woff2",
    "/_next/image",
    "/_next/webpack-hmr",
    "/_next/data/build/pagina.json",
    "/favicon.ico",
  ]) assert(!matcherCasa(caminho), `${caminho} NAO deveria entrar no middleware`);
});

t("35. caminhos da CDS continuam ENTRANDO no middleware", () => {
  for (const caminho of [
    "/", "/login", "/verificar-email", "/dashboard",
    `/central-ia/estudio-anuncios/${UUID}`,
    "/api/dashboard/resumo",
    "/api/estudio-anuncios/projetos",
    "/api/internal/estudio-anuncios/worker",
    "/api/sync",
    "/logo-cds.png",
  ]) assert(matcherCasa(caminho), `${caminho} DEVERIA entrar no middleware`);
});

t("36. o matcher nao usa mais a forma antiga (dois casos de _next)", () => {
  assert(!FONTE_MIDDLEWARE.includes("_next/static|_next/image"),
    "matcher ainda excluindo apenas _next/static e _next/image");
});

// ────────────────────────────────────────────────────────────────────
console.log("\n[9b. invariante ESTRUTURAL: policy x filesystem]");
//
// ── O defeito que este bloco existe para impedir ────────────────────
//
// `/api/internal/agentes/acoes` e `/api/internal/agentes/perguntas-poller`
// foram escritas, testadas, commitadas e deployadas sem constar na
// policy. Nada reclamou. As suites do A7 e do A8 importam o modulo da
// rota e chamam o handler direto — provam o handler, que era o contrato,
// e passam ao largo do middleware, que em producao vem ANTES. O
// inventario do teste 30 e uma lista manual, entao tambem nao acusou.
//
// Quem pegou foi o smoke de producao, depois do deploy.
//
// Este bloco fecha a classe: ele DESCOBRE a rota nova no disco em vez de
// esperar que alguem a acrescente a uma lista.
//
// ── Por que o invariante tem uma GUARDA, e nao e so "tem de constar" ─
//
// "toda rota sob app/api/internal/ deve constar na policy" e insegura
// como regra isolada: constar na policy e ser LIBERADA a passar sem
// sessao. No dia em que alguem criar uma rota interna sem segredo
// proprio, essa regra exigiria abri-la — um teste de seguranca virando
// instrucao para produzir um buraco. Por isso a ordem importa:
//
//   (a) a rota tem auth propria fail-closed baseada em process.env;
//       se NAO tem, REPROVA por auth ausente — nunca "resolve"
//       declarando-a;
//   (b) todo metodo que ela EXPORTA consta na policy para o caminho dela;
//   (c) todo metodo declarado para ela e um metodo que ela exporta.
//
// (c) e o simetrico de (b): declarar ["GET","POST"] numa rota que so
// exporta POST abre um verbo que ninguem implementou.

const RAIZ_INTERNA = path.join(process.cwd(), "app/api/internal");
const VERBOS_HTTP = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

type RotaInterna = {
  caminho: string;
  arquivo: string;
  metodos: string[];
  fonte: string;
  naoSuportada: string | null;
};

/**
 * Varre o disco atras de `route.ts` sob `app/api/internal`.
 *
 * Segmento dinamico (`[id]`) e grupo de rota (`(grupo)`) mudam o
 * mapeamento de pasta para URL, e a policy casa caminho EXATO. Em vez de
 * adivinhar — ou pior, de converter `[id]` em curinga, que e o oposto do
 * que esta policy faz — a rota e marcada como NAO SUPORTADA e o teste
 * reprova nominalmente. Ignorar em silencio recriaria o buraco da FIX2.
 */
function descobrirRotasInternas(raiz: string): RotaInterna[] {
  const achadas: RotaInterna[] = [];

  const andar = (dir: string, segmentos: string[]) => {
    for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entrada.isDirectory()) {
        andar(path.join(dir, entrada.name), [...segmentos, entrada.name]);
      } else if (entrada.name === "route.ts" || entrada.name === "route.tsx") {
        const arquivo = path.join(dir, entrada.name);
        const bruto = fs.readFileSync(arquivo, "utf8");
        const fonte = bruto
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/(^|[^:])\/\/.*$/gm, "$1");

        const problematico = segmentos.find(
          (s) => /^\[.*\]$/.test(s) || /^\(.*\)$/.test(s) || s.includes("[") || s.includes("(")
        );

        const metodos = new Set<string>();
        for (const m of fonte.matchAll(
          /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(/g
        )) metodos.add(m[1]);
        for (const m of fonte.matchAll(
          /export\s+const\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*[:=]/g
        )) metodos.add(m[1]);

        achadas.push({
          caminho: "/api/internal/" + segmentos.join("/"),
          arquivo: path.relative(process.cwd(), arquivo).replace(/\\/g, "/"),
          metodos: [...metodos].sort(),
          fonte,
          naoSuportada: problematico
            ? `segmento nao mapeavel para caminho exato: "${problematico}"`
            : null,
        });
      }
    }
  };

  andar(raiz, []);
  return achadas.sort((a, b) => a.caminho.localeCompare(b.caminho));
}

/**
 * A rota se autentica sozinha, e falha FECHADA?
 *
 * Nao basta "o arquivo contem process.env" — isso passaria verde numa
 * rota que le o segredo e nunca o compara. O que se exige e a forma que
 * as SETE rotas internas ja usam, identica em todas:
 *
 *   const <esperado> = process.env.<ALGUMA_COISA_SECRET>;
 *   const <recebido> = request.headers.get("<header>");
 *   if (!<esperado> || !<recebido> || <comparacao com esperado>) -> 401
 *
 * As tres partes da condicao sao exigidas nominalmente. A primeira
 * (`!<esperado>`) e a que mata a mutacao conceitual que interessa:
 * segredo AUSENTE no servidor liberando a requisicao. Sem ela, um deploy
 * sem a variavel configurada abriria a rota para qualquer um.
 */
function temAuthPropriaFailClosed(fonte: string): boolean {
  const env = fonte.match(/const\s+(\w+)\s*=\s*process\.env\.(\w*SECRET\w*)\s*;/);
  if (!env) return false;
  const esperado = env[1];

  const header = fonte.match(/const\s+(\w+)\s*=\s*request\.headers\.get\(\s*"[^"]+"\s*\)\s*;/);
  if (!header) return false;
  const recebido = header[1];

  const guarda = fonte.match(
    new RegExp("if\\s*\\(\\s*!" + esperado + "\\s*\\|\\|\\s*!" + recebido + "\\s*\\|\\|([^)]*)\\)")
  );
  if (!guarda) return false;

  // A terceira clausula tem de COMPARAR, e comparar contra o esperado.
  const comparacao = guarda[1];
  if (!comparacao.includes("!==") || !comparacao.includes(esperado)) return false;

  // E a guarda tem de RECUSAR. Sem isto, `if (...) { /* nada */ }`
  // satisfaria a forma e nao negaria coisa nenhuma.
  const depois = fonte.slice((guarda.index ?? 0) + guarda[0].length, (guarda.index ?? 0) + guarda[0].length + 240);
  return /401/.test(depois);
}

/**
 * As violacoes do invariante. Lista vazia = invariante satisfeito.
 *
 * Funcao PURA sobre (rotas, policy) de proposito: e o que permite os
 * mutantes do teste 38 alimentarem-na com entradas sinteticas em vez de
 * escrever arquivo no repositorio para provar que o oraculo sabe dizer
 * nao.
 */
function violacoesDoInvariante(
  rotas: readonly RotaInterna[],
  policy: Readonly<Record<string, readonly string[]>>
): string[] {
  const violacoes: string[] = [];

  for (const rota of rotas) {
    if (rota.naoSuportada !== null) {
      violacoes.push(`${rota.caminho}: NAO SUPORTADA — ${rota.naoSuportada}`);
      continue;
    }

    if (rota.metodos.length === 0) {
      violacoes.push(`${rota.caminho}: nenhum metodo HTTP exportado reconhecido em ${rota.arquivo}`);
      continue;
    }

    // (a) A GUARDA. Rota interna sem auth propria REPROVA aqui, e o teste
    // nao segue para exigir declaracao — declarar seria abri-la.
    if (!temAuthPropriaFailClosed(rota.fonte)) {
      violacoes.push(
        `${rota.caminho}: rota interna SEM auth propria fail-closed — corrija a ROTA, nao a policy`
      );
      continue;
    }

    const declarados = policy[rota.caminho];
    if (!Array.isArray(declarados)) {
      violacoes.push(
        `${rota.caminho}: ausente de ROTAS_COM_SEGREDO — o middleware a nega antes do segredo dela ser lido`
      );
      continue;
    }

    // (b) e (c) de uma vez: igualdade de CONJUNTO, nunca `includes`.
    const exportados = JSON.stringify([...rota.metodos].sort());
    const naPolicy = JSON.stringify([...declarados].sort());
    if (exportados !== naPolicy) {
      violacoes.push(`${rota.caminho}: exporta ${exportados} mas a policy declara ${naPolicy}`);
    }
  }

  return violacoes;
}

const ROTAS_INTERNAS = descobrirRotasInternas(RAIZ_INTERNA);

t("37. ANTI-VACUIDADE: a varredura enxerga as rotas internas do disco", () => {
  // Parser quebrado, pasta renomeada ou glob vazio devolvem lista curta e
  // deixariam o teste 38 verde por nao ter o que reprovar.
  assert(ROTAS_INTERNAS.length >= 7,
    `a varredura achou ${ROTAS_INTERNAS.length} rotas internas, esperado >= 7`);
  assert(ROTAS_INTERNAS.every((r) => r.caminho.startsWith("/api/internal/")),
    "caminho derivado do disco fora do namespace /api/internal/");
  // As duas da FIX2 tem de estar entre as descobertas — se a varredura
  // nao as ve, ela nao veria a proxima tampouco.
  for (const esperada of ["/api/internal/agentes/acoes", "/api/internal/agentes/perguntas-poller",
                          "/api/internal/agentes/ingestao-perguntas"])
    assert(ROTAS_INTERNAS.some((r) => r.caminho === esperada),
      `${esperada} nao foi descoberta pela varredura`);
  // E a extracao de metodos tem de ter funcionado de fato.
  assert(ROTAS_INTERNAS.every((r) => r.metodos.length > 0),
    "alguma rota interna ficou sem metodo extraido — o regex de export nao casou");
});

t("38. toda rota interna com auth propria esta declarada com os metodos EXATOS", () => {
  const violacoes = violacoesDoInvariante(ROTAS_INTERNAS, ROTAS_COM_SEGREDO);
  assert(violacoes.length === 0, `invariante violado:\n    - ${violacoes.join("\n    - ")}`);
});

t("39. CONTROLES NEGATIVOS: o oraculo estrutural sabe dizer nao", () => {
  const ponte = ROTAS_INTERNAS.find((r) => r.caminho === "/api/internal/agentes/acoes");
  assert(ponte !== undefined, "ancora: a ponte precisa existir para os mutantes");
  const p = ponte as RotaInterna;
  assert(JSON.stringify(p.metodos) === '["POST"]',
    `ancora: a ponte deveria exportar apenas POST, exporta ${JSON.stringify(p.metodos)}`);

  const semPonte = { ...ROTAS_COM_SEGREDO } as Record<string, readonly string[]>;
  delete semPonte["/api/internal/agentes/acoes"];
  // MUT-1
  assert(violacoesDoInvariante([p], semPonte).length > 0,
    "MUT-1 sobreviveu: remover a ponte da policy passou despercebido");

  // MUT-2 — verbo trocado
  assert(violacoesDoInvariante([p], { ...ROTAS_COM_SEGREDO, "/api/internal/agentes/acoes": ["GET"] }).length > 0,
    "MUT-2 sobreviveu: POST trocado por GET passou despercebido");

  // MUT-3 / MUT-9 — verbo a mais que a rota nao exporta
  assert(violacoesDoInvariante([p], { ...ROTAS_COM_SEGREDO, "/api/internal/agentes/acoes": ["POST", "GET"] }).length > 0,
    "MUT-3/MUT-9 sobreviveu: verbo declarado que a rota nao exporta passou despercebido");

  const poller = ROTAS_INTERNAS.find((r) => r.caminho === "/api/internal/agentes/perguntas-poller") as RotaInterna;
  assert(poller !== undefined, "ancora: o poller precisa existir");
  const semPoller = { ...ROTAS_COM_SEGREDO } as Record<string, readonly string[]>;
  delete semPoller["/api/internal/agentes/perguntas-poller"];
  // MUT-4
  assert(violacoesDoInvariante([poller], semPoller).length > 0,
    "MUT-4 sobreviveu: remover o poller da policy passou despercebido");
  // MUT-5
  assert(violacoesDoInvariante([poller], { ...ROTAS_COM_SEGREDO, "/api/internal/agentes/perguntas-poller": ["POST"] }).length > 0,
    "MUT-5 sobreviveu: GET do poller trocado por POST passou despercebido");

  // MUT-8 — rota interna NOVA, com auth propria, ausente da policy.
  const rotaNova: RotaInterna = {
    caminho: "/api/internal/agentes/intrusa",
    arquivo: "sintetica",
    metodos: ["POST"],
    fonte: p.fonte,
    naoSuportada: null,
  };
  assert(violacoesDoInvariante([rotaNova], ROTAS_COM_SEGREDO).length > 0,
    "MUT-8 sobreviveu: rota interna nova e nao declarada passou despercebida");

  // MUT-10 — rota interna SEM auth propria. O oraculo tem de reprovar por
  // AUTH AUSENTE, e nunca "resolver" pedindo que ela seja declarada:
  // declara-la seria liberar passagem para uma rota que nao se defende.
  const semAuth: RotaInterna = {
    caminho: "/api/internal/agentes/sem-guarda",
    arquivo: "sintetica",
    metodos: ["POST"],
    fonte: "export async function POST(request: Request) { return Response.json({ ok: true }); }",
    naoSuportada: null,
  };
  const vSemAuth = violacoesDoInvariante([semAuth], ROTAS_COM_SEGREDO);
  assert(vSemAuth.length > 0, "MUT-10 sobreviveu: rota sem auth propria passou despercebida");
  assert(vSemAuth.some((v) => v.includes("SEM auth propria")),
    `MUT-10: reprovou pelo motivo errado -> ${vSemAuth.join(" | ")}`);
  // E declara-la NAO pode calar o oraculo.
  assert(violacoesDoInvariante([semAuth], {
    ...ROTAS_COM_SEGREDO,
    "/api/internal/agentes/sem-guarda": ["POST"],
  }).some((v) => v.includes("SEM auth propria")),
    "MUT-10: declarar a rota na policy silenciou o oraculo — auth ausente tem de reprovar de qualquer forma");

  // Segmento dinamico: FALHA EXPLICITA, nunca curinga silencioso.
  const dinamica: RotaInterna = {
    caminho: "/api/internal/agentes/[agenteId]",
    arquivo: "sintetica",
    metodos: ["GET"],
    fonte: p.fonte,
    naoSuportada: 'segmento nao mapeavel para caminho exato: "[agenteId]"',
  };
  assert(violacoesDoInvariante([dinamica], ROTAS_COM_SEGREDO).some((v) => v.includes("NAO SUPORTADA")),
    "segmento dinamico passou despercebido — ele mudaria o mapeamento de pasta para URL");

  // A guarda de auth, isolada: as formas que NAO podem passar.
  assert(!temAuthPropriaFailClosed("const s = process.env.X_SECRET;"),
    "ler o segredo sem compara-lo contou como auth");
  assert(!temAuthPropriaFailClosed(
    'const s = process.env.X_SECRET;\nconst r = request.headers.get("h");\nif (r !== s) { return responder(401); }'),
    "guarda sem `!segredo` contou como fail-closed — segredo ausente liberaria a rota");
  assert(temAuthPropriaFailClosed(
    'const s = process.env.X_SECRET;\nconst r = request.headers.get("h");\nif (!s || !r || r !== s) { return responder({}, 401); }'),
    "ANTI-VACUIDADE: a forma correta foi reprovada — o oraculo estaria sempre vermelho");
});

t("40. nenhuma rota interna e liberada por curinga ou por prefixo", () => {
  // MUT-7. A policy casa caminho EXATO, entao uma chave com `*` e inerte:
  // ela so casaria um pathname literalmente igual a ".../*". O risco real
  // nao e ela liberar demais — e alguem acreditar que declarou a rota.
  const comCuringa = { ...ROTAS_COM_SEGREDO, "/api/internal/agentes/*": ["POST"] } as Record<string, readonly string[]>;
  const semAsDuas = { ...comCuringa } as Record<string, readonly string[]>;
  delete semAsDuas["/api/internal/agentes/acoes"];
  delete semAsDuas["/api/internal/agentes/perguntas-poller"];

  assert(decidirAcesso("/api/internal/agentes/acoes", "POST", false) === "liberar",
    "ancora: a ponte deveria estar liberada pela declaracao nominal");

  const ponte = ROTAS_INTERNAS.find((r) => r.caminho === "/api/internal/agentes/acoes") as RotaInterna;
  const poller = ROTAS_INTERNAS.find((r) => r.caminho === "/api/internal/agentes/perguntas-poller") as RotaInterna;
  assert(violacoesDoInvariante([ponte, poller], semAsDuas).length === 2,
    "MUT-7 sobreviveu: o curinga foi aceito no lugar das duas declaracoes nominais");

  // E nenhum prefixo libera: sub-caminho de rota declarada continua negado.
  for (const caminho of [
    "/api/internal/agentes/acoes/extra",
    "/api/internal/agentes/worker/extra",
    "/api/internal",
    "/api/internal/",
    "/api/internal/agentes",
  ]) assert(sem(caminho, "POST") === "bloquear_api", `${caminho} nao deveria ser liberado por prefixo`);
});

t("41. NAO REGRESSAO: desconhecidos, verbos errados e nomes de prototipo", () => {
  // Rota interna que nao existe continua negada, em todo verbo.
  for (const metodo of VERBOS_HTTP)
    assert(sem("/api/internal/agentes/inexistente", metodo) === "bloquear_api",
      `${metodo} em rota interna desconhecida deveria cair no default deny`);

  // Nomes que existem no prototipo de Object. `casa()` nao usa
  // hasOwnProperty — ela sobrevive porque `Array.isArray` reprova o que
  // vem da cadeia de prototipos. Este teste prende esse comportamento:
  // trocar o guard por um `if (metodos)` abriria todos eles de uma vez.
  for (const nome of ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"])
    for (const metodo of ["GET", "POST"])
      assert(sem("/api/internal/agentes/" + nome, metodo) === "bloquear_api",
        `${metodo} em /api/internal/agentes/${nome} foi liberado pelo prototipo`);
  assert(sem("/toString") === "redirecionar", "nome de prototipo como PAGINA nao deveria liberar");

  // As rotas com segredo ja existentes nao mudaram de comportamento.
  assert(sem("/api/sync", "GET") === "liberar", "cron de sync regrediu");
  assert(sem("/api/internal/agentes/worker", "GET") === "liberar", "dispatcher regrediu");
  assert(sem("/api/internal/agentes/worker", "POST") === "bloquear_api", "verbo errado no dispatcher regrediu");
  assert(sem("/api/internal/agentes/executar", "POST") === "liberar", "worker manual regrediu");

  // Rota publica e rota de sessao seguem como estavam.
  assert(sem("/api/auth/login", "POST") === "liberar", "rota publica regrediu");
  assert(sem("/login") === "liberar", "pagina publica regrediu");
  assert(sem("/api/dashboard/resumo") === "bloquear_api", "API de sessao regrediu");
  assert(com("/api/dashboard/resumo") === "liberar", "API de sessao com cookie regrediu");
  assert(sem("/dashboard") === "redirecionar", "pagina de sessao regrediu");

  // MUT-6: o default continua NEGAR. Se alguem trocar o fim de
  // `decidirAcesso` por `return "liberar"`, tudo acima vira decoracao.
  const fontepolicy = fs.readFileSync(path.join(process.cwd(), "lib/middleware-rotas.ts"), "utf8");
  assert(/return caminho\.startsWith\("\/api\/"\) \? "bloquear_api" : "redirecionar";/.test(fontepolicy),
    "o default do middleware deixou de ser NEGAR");
});

// ────────────────────────────────────────────────────────────────────
// 10. INTEGRAÇÃO HTTP — cadeia real: matcher → middleware → decidirAcesso
//
// Opt-in: só roda com um servidor local de pé.
//   Terminal 1:  npm run dev
//   Terminal 2:  MIDDLEWARE_HTTP_BASE=http://localhost:3000 npx tsx scripts/testar-middleware.ts
//
// Sem cookie em nenhuma requisição. Nada é escrito; só GET.
const BASE = process.env.MIDDLEWARE_HTTP_BASE;

type CasoHttp = { caminho: string; esperado: "passou" | "redirect_login" | "401_json"; nota: string };

const CASOS_HTTP: CasoHttp[] = [
  // fora do middleware — o Next responde o que responder (200/400/404),
  // mas NUNCA um redirect para /login
  { caminho: "/_next/static/chunks/nao-existe.js", esperado: "passou", nota: "matcher exclui _next" },
  { caminho: "/_next/image?url=%2Flogo-cds.png&w=64&q=75", esperado: "passou", nota: "matcher exclui _next" },
  { caminho: "/_next/webpack-hmr", esperado: "passou", nota: "matcher exclui _next" },
  { caminho: "/favicon.ico", esperado: "passou", nota: "matcher exclui favicon" },
  // dentro do middleware
  { caminho: "/login", esperado: "passou", nota: "pagina publica" },
  { caminho: "/dashboard", esperado: "redirect_login", nota: "pagina protegida" },
  { caminho: "/api/dashboard/resumo", esperado: "401_json", nota: "API protegida" },
];

async function rodarHttp(base: string) {
  console.log(`\n[10. integracao HTTP contra ${base} — cadeia real]`);
  for (const caso of CASOS_HTTP) {
    const nome = `${caso.caminho}  (${caso.nota})`;
    try {
      const res = await fetch(base + caso.caminho, { redirect: "manual", headers: { cookie: "" } });
      const location = res.headers.get("location") ?? "";
      const ehRedirectLogin = (res.status === 307 || res.status === 302) && location.includes("/login");

      if (caso.esperado === "passou") {
        assert(!ehRedirectLogin, `interceptado pelo middleware (status ${res.status} -> ${location})`);
      } else if (caso.esperado === "redirect_login") {
        assert(ehRedirectLogin, `esperava redirect para /login, veio status ${res.status}`);
        assert(location.includes("redirect=%2Fdashboard") || location.includes("redirect=/dashboard"),
          `redirect sem preservar o destino: ${location}`);
      } else {
        assert(res.status === 401, `esperava 401, veio ${res.status}`);
        const tipo = res.headers.get("content-type") ?? "";
        assert(tipo.includes("application/json"), `esperava JSON, veio "${tipo}"`);
        const corpo: any = await res.json();
        assert(corpo?.erro === true, "corpo 401 sem { erro: true }");
      }
      ok++; console.log(`  PASS  ${nome}`);
    } catch (e: any) {
      falhou++; console.log(`  FALHA ${nome} -> ${e?.message ?? e}`);
    }
  }
}

async function principal() {
  if (BASE) {
    await rodarHttp(BASE);
  } else {
    console.log("\n[10. integracao HTTP] SKIP — defina MIDDLEWARE_HTTP_BASE com `npm run dev` no ar");
    console.log("     ex.: MIDDLEWARE_HTTP_BASE=http://localhost:3000 npx tsx scripts/testar-middleware.ts");
  }

  console.log(`\n=== RESULTADO: ${ok} passaram, ${falhou} falharam ===\n`);
  if (falhou > 0) process.exit(1);
}

void principal();
