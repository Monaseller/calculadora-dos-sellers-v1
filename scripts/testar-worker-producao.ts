/**
 * Testes do worker de produção do Estúdio de Anúncios.
 *
 * ── O defeito que originou esta rota ────────────────────────────────
 * A fila do Pipeline só tinha um consumidor: `scripts/estudio-anuncios-
 * worker.mjs`, rodando na máquina de quem desenvolve. Em produção, nada
 * consumia. Clicar em "Iniciar pipeline" enfileirava um job que ficava
 * `pendente`, com zero tentativas, para sempre — sem erro, sem log, sem
 * sintoma nenhum. O usuário descobriu isso testando manualmente.
 *
 * Estes testes existem para que a fila nunca mais fique sem consumidor
 * em produção, e para que o consumidor não vire uma segunda porta aberta.
 *
 * **NENHUM job é executado aqui.** A autenticação é a primeira coisa que
 * a rota faz; os testes verificam que ela para em 401 antes de tocar em
 * banco, IA ou marketplace. O caminho autenticado é verificado com um
 * Supabase inválido de propósito — ele nunca chega a processar nada.
 *
 * Uso: npx tsx scripts/testar-worker-producao.ts
 */
import fs from "node:fs";
import path from "node:path";

let ok = 0, falhou = 0;
async function t(nome: string, fn: () => void | Promise<void>) {
  try { await fn(); ok++; console.log(`  PASS  ${nome}`); }
  catch (e: any) { falhou++; console.log(`  FALHA ${nome} -> ${e?.message ?? e}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

const SEGREDO = "segredo-de-teste-nunca-real";
const ROTA_URL = "/api/internal/estudio-anuncios/worker";

// Valores inválidos de propósito: se a autenticação deixasse de recusar
// primeiro, a consulta seguinte falharia contra um host inexistente — o
// placebo é parte da prova de que nada de banco acontece antes do 401.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder-de-teste.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "chave-de-teste-invalida";

const ROTA = path.join(process.cwd(), "app/api/internal/estudio-anuncios/worker/route.ts");
const FONTE = fs.readFileSync(ROTA, "utf-8");
/** Fonte sem comentários — o texto explicativo cita nomes de variáveis. */
const CODIGO = FONTE.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

async function chamar(env: { segredo?: string; authorization?: string }): Promise<number> {
  const antes = process.env.CRON_SECRET;
  if (env.segredo === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = env.segredo;
  try {
    const mod = await import(`../app/api/internal/estudio-anuncios/worker/route.ts?t=${Date.now()}${Math.random()}`);
    const headers = new Headers();
    if (env.authorization) headers.set("authorization", env.authorization);
    const res = await mod.GET(new Request(`https://exemplo.test${ROTA_URL}`, { headers }));
    return res.status;
  } finally {
    if (antes === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = antes;
  }
}

async function rodar() {
  console.log("\n[worker de produção — autenticação fail closed]");

  await t("1. CRON_SECRET ausente → 401, mesmo com Authorization válido-parecido", async () => {
    assert(await chamar({}) === 401, "sem segredo configurado deveria recusar");
    assert(await chamar({ authorization: `Bearer ${SEGREDO}` }) === 401,
      "sem segredo configurado, nenhum header pode autorizar");
  });

  await t("2. Authorization ausente → 401", async () => {
    assert(await chamar({ segredo: SEGREDO }) === 401, "sem header deveria recusar");
  });

  await t("3. Bearer incorreto → 401", async () => {
    assert(await chamar({ segredo: SEGREDO, authorization: "Bearer errado" }) === 401, "segredo errado deveria recusar");
    assert(await chamar({ segredo: SEGREDO, authorization: SEGREDO }) === 401, "sem o prefixo Bearer deveria recusar");
    assert(await chamar({ segredo: SEGREDO, authorization: `bearer ${SEGREDO}` }) === 401,
      "a comparação é exata — `bearer` minúsculo não passa");
    assert(await chamar({ segredo: SEGREDO, authorization: `Bearer ${SEGREDO}x` }) === 401,
      "sufixo extra não passa");
  });

  await t("4. o segredo NUNCA aparece na resposta nem em log", async () => {
    process.env.CRON_SECRET = SEGREDO;
    const mod = await import(`../app/api/internal/estudio-anuncios/worker/route.ts?t=${Date.now()}b`);
    const res = await mod.GET(new Request(`https://exemplo.test${ROTA_URL}`));
    const corpo = await res.text();
    delete process.env.CRON_SECRET;
    assert(!corpo.includes(SEGREDO), "o segredo vazou no corpo da resposta");
    assert(corpo === JSON.stringify({ erro: true }), `resposta deveria ser genérica: ${corpo}`);
    assert(!/console\.[a-z]+\([^)]*(CRON_SECRET|segredo|auth\b)/.test(CODIGO),
      "segredo ou header de autorização aparece em log");
  });

  await t("5. não existe porta alternativa de autenticação", () => {
    assert(/auth !== `Bearer \$\{segredo\}`/.test(CODIGO), "a comparação deveria ser Bearer + segredo");
    assert(/if \(!segredo \|\| !auth \|\| auth !== /.test(CODIGO),
      "a guarda precisa recusar segredo ausente, header ausente e header errado");
    assert(!/x-cron|cron_token|searchParams\.get\("secret"\)|cookies\(\)/i.test(CODIGO),
      "há mecanismo de autenticação alternativo além do oficial");
    // A rota é INTERNA: nunca pode confiar em `user_id` vindo de fora.
    assert(!/user_id/.test(CODIGO), "a rota não pode ler user_id do chamador");
  });

  console.log("\n[worker de produção — comportamento]");

  await t("6. usa a MESMA lógica da rota interna, não uma reimplementação", () => {
    assert(/from "@\/lib\/estudio-anuncios\/processar-job"/.test(CODIGO),
      "o worker deveria importar processar-job");
    assert(/processarJobDoPipeline/.test(CODIGO) && /reivindicarProximoJob/.test(CODIGO),
      "o worker deveria usar as duas funções compartilhadas");
    // Se o worker validasse estado por conta própria, existiriam duas
    // versões das checagens de coerência — que divergiriam na primeira
    // mudança. Estas são as marcas dessa reimplementação.
    assert(!/STATUS_PIPELINE_EXECUTAVEL|obterDefinicaoEtapa|listarSubetapas|buscarPipelinePorProjeto/.test(CODIGO),
      "o worker está reimplementando validações que pertencem a processar-job");
  });

  await t("7. o claim continua sendo só pela RPC atômica", () => {
    const fonteProcessar = fs.readFileSync(
      path.join(process.cwd(), "lib/estudio-anuncios/processar-job.ts"), "utf-8");
    assert(/claim_next_estudio_anuncios_job/.test(fonteProcessar),
      "o claim deveria continuar na RPC atômica");
    // O worker não pode marcar job como rodando por conta própria: dois
    // crons simultâneos pegariam o mesmo job.
    assert(!/status.*=.*"rodando"|update\(/i.test(CODIGO),
      "o worker não pode alterar status de job diretamente");
  });

  await t("8. NÃO publica nada — nenhum caminho para o marketplace", () => {
    assert(!/POST \/items|\/items\b|publicacao-ml|portao-ml|api\.mercadolibre/i.test(CODIGO),
      "o worker não pode tocar em publicação no Mercado Livre");
  });

  await t("9. o laço reserva folga antes de começar outra etapa", () => {
    // Sem folga, uma etapa de IA começaria perto do fim da janela e seria
    // cortada no meio — deixando o job `rodando` sem ninguém para concluí-lo.
    assert(/FOLGA_MINIMA_MS/.test(CODIGO) && /ORCAMENTO_MS/.test(CODIGO),
      "o orçamento de tempo deveria ser explícito");
    const mod = FONTE;
    const folga = Number(/FOLGA_MINIMA_MS\s*=\s*([\d_]+)/.exec(mod)?.[1]?.replace(/_/g, ""));
    const orcamento = Number(/ORCAMENTO_MS\s*=\s*([\d_]+)/.exec(mod)?.[1]?.replace(/_/g, ""));
    const maxDuration = Number(/maxDuration\s*=\s*(\d+)/.exec(mod)?.[1]);
    assert(folga > 0 && orcamento > folga, "a folga precisa caber dentro do orçamento");
    assert(orcamento < maxDuration * 1000,
      "o orçamento precisa ser menor que maxDuration, para sobrar tempo de responder");
    assert(/Date\.now\(\) - inicio < ORCAMENTO_MS - FOLGA_MINIMA_MS/.test(CODIGO),
      "o laço deveria parar quando não couber mais uma etapa inteira");
  });

  await t("10. fila vazia é resultado normal, não erro", () => {
    assert(/if \(!job\) break;/.test(CODIGO), "sem job pendente o laço deveria apenas terminar");
    assert(!/if \(!job\).*(throw|status: 5)/.test(CODIGO), "fila vazia não pode virar erro");
  });

  console.log("\n[worker de produção — agendamento]");

  await t("11. vercel.json declara o cron do worker", () => {
    const vercel = JSON.parse(fs.readFileSync(path.join(process.cwd(), "vercel.json"), "utf-8"));
    const cron = (vercel.crons ?? []).find((c: any) => c.path === ROTA_URL);
    assert(!!cron, "o cron do worker sumiu do vercel.json — a fila voltaria a não ter consumidor");
    assert(typeof cron.schedule === "string" && cron.schedule.length > 0, "o cron precisa de schedule");
    // O cron de /api/sync continua existindo: este worker é adicional.
    assert((vercel.crons ?? []).some((c: any) => c.path === "/api/sync"),
      "o cron de sync não pode ter sido substituído por este");
  });

  await t("12. a função tem janela maior que o padrão de 60s", () => {
    const vercel = JSON.parse(fs.readFileSync(path.join(process.cwd(), "vercel.json"), "utf-8"));
    const chave = "app/api/internal/estudio-anuncios/worker/route.ts";
    const cfg = vercel.functions?.[chave];
    assert(!!cfg, `vercel.json precisa de configuração própria para ${chave}`);
    // Etapas de IA levam dezenas de segundos: com os 60s do padrão
    // `app/api/**`, o worker seria cortado no meio da primeira.
    assert(cfg.maxDuration > vercel.functions["app/api/**"].maxDuration,
      "o worker precisa de janela maior que o padrão das rotas de API");
    assert(cfg.maxDuration === Number(/maxDuration\s*=\s*(\d+)/.exec(FONTE)?.[1]),
      "maxDuration do vercel.json e do arquivo precisam concordar");
  });

  await t("13. a rota interna antiga continua funcionando para o worker local", () => {
    const interna = fs.readFileSync(
      path.join(process.cwd(), "app/api/internal/estudio-anuncios/executar/route.ts"), "utf-8");
    assert(/x-worker-secret/.test(interna), "o contrato com o worker local mudou");
    assert(/export async function POST/.test(interna), "a rota interna deveria continuar sendo POST");
    assert(/processarJobDoPipeline/.test(interna),
      "a rota interna deveria delegar para a mesma função do worker");
  });

  console.log(`\n${falhou === 0 ? "TODOS OS TESTES PASSARAM" : "HÁ FALHAS"} — ${ok} ok, ${falhou} falha(s)\n`);
  if (falhou > 0) process.exit(1);
}

rodar();
