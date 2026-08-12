/**
 * Testes determinísticos da camada EDITORIAL — validação, conversão e
 * leitura. Sem banco real, sem rede, custo zero: cliente Supabase de
 * mentira. A atomicidade das RPCs é validada contra o banco real na
 * etapa de validação (não dá para simular lock em mock).
 *
 * Uso: npx tsx scripts/testar-conteudo-editorial.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  conteudoDaAdaptacao,
  validarConteudoEditorial,
  montarEditorialProjeto,
  buscarCanalDoProjeto,
  LIMITES,
} from "../lib/estudio-anuncios/conteudo-editorial";
import type { EnvelopeAdaptacaoMarketplace } from "../lib/estudio-anuncios/adaptacao-marketplace-tipos";
import { CTAS_PERMITIDOS } from "../lib/estudio-anuncios/adaptacao-marketplace-tipos";

let ok = 0, falhou = 0;
async function t(nome: string, fn: () => void | Promise<void>) {
  try { await fn(); ok++; console.log(`  PASS  ${nome}`); }
  catch (e: any) { falhou++; console.log(`  FALHA ${nome} -> ${e?.message ?? e}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

const PROJ = "11111111-1111-1111-1111-111111111111";
const OUTRO = "22222222-2222-2222-2222-222222222222";
const CANAL_ML = "aaaa1111-0000-0000-0000-000000000001";
const CANAL_SH = "aaaa2222-0000-0000-0000-000000000002";

const filtros: { tabela: string; coluna: string; valor: any }[] = [];
function fakeSupabase(dados: Record<string, any[]>) {
  const construir = (tabela: string) => {
    let linhas = dados[tabela] ?? [];
    const api: any = {
      eq(coluna: string, valor: any) {
        filtros.push({ tabela, coluna, valor });
        linhas = linhas.filter((l: any) => l[coluna] === valor);
        return api;
      },
      in(coluna: string, valores: any[]) {
        filtros.push({ tabela, coluna, valor: valores });
        linhas = linhas.filter((l: any) => valores.includes(l[coluna]));
        return api;
      },
      maybeSingle: async () => ({ data: linhas[0] ?? null, error: null }),
      then: (r: any) => r({ data: linhas, error: null }),
    };
    return api;
  };
  return { from: (tabela: string) => ({ select: () => construir(tabela) }) } as any;
}

const ADAPTACAO: EnvelopeAdaptacaoMarketplace = {
  fonteGeracaoConteudo: { jobId: "gc", resultadoId: "r", schemaVersao: 1 },
  entrada: { conteudoBase: {} as any, marketplacesAlvo: ["ML", "Shopee"], ctasPermitidos: [], restricoes: [] },
  saida: {
    adaptacoes: [
      { marketplace: "ML", titulo: "Titulo ML", descricao: "Desc ML", bullets: ["b1", "b2"], especificacoes: [{ nome: "Cor", valor: "Verde" }], cta: CTAS_PERMITIDOS[0] },
      { marketplace: "Shopee", titulo: "Titulo SH", descricao: "Desc SH" },
    ],
  },
} as any;

function versao(over: Record<string, any> = {}) {
  return {
    id: "v1", projeto_marketplace_id: CANAL_ML, numero_versao: 1, origem: "ia_adaptacao_marketplace",
    titulo_principal: "Titulo ML", conteudo: { titulo: "Titulo ML", descricao: "Desc ML", bullets: [], especificacoes: [] },
    aprovado: false, aprovado_em: null, aprovado_por: null, criado_em: "2026-08-20T10:00:00Z",
    criado_por: null, resultado_pipeline_origem_id: "res-1", ...over,
  };
}

function baseDados(over: Partial<Record<string, any[]>> = {}) {
  return {
    estudio_anuncios_projetos_marketplace: [
      { projeto_id: PROJ, id: CANAL_ML, marketplace: "ML" },
      { projeto_id: PROJ, id: CANAL_SH, marketplace: "Shopee" },
      { projeto_id: OUTRO, id: "canal-de-outro", marketplace: "ML" },
    ],
    estudio_anuncios_conteudo_versoes: [],
    ...over,
  } as Record<string, any[]>;
}

async function rodar() {
  console.log("\n[conversão da adaptação → conteúdo editável]");
  await t("1. a versão base sai da adaptação do marketplace CORRETO", () => {
    const c = conteudoDaAdaptacao(ADAPTACAO.saida.adaptacoes[0]);
    assert(c.titulo === "Titulo ML" && c.descricao === "Desc ML", "conteúdo errado");
    assert(c.bullets.join() === "b1,b2", "bullets perdidos");
    assert(c.especificacoes[0].nome === "Cor" && c.especificacoes[0].valor === "Verde", "especificação achatada ou perdida");
    assert(c.cta === CTAS_PERMITIDOS[0], "CTA perdido");
  });
  t("2. especificações continuam key/value — o domínio não é achatado", () => {
    const c = conteudoDaAdaptacao(ADAPTACAO.saida.adaptacoes[0]);
    assert(Array.isArray(c.especificacoes) && typeof c.especificacoes[0] === "object", "virou string livre");
  });
  t("3. adaptação sem bullets/especificações vira listas vazias, não undefined", () => {
    const c = conteudoDaAdaptacao(ADAPTACAO.saida.adaptacoes[1]);
    assert(Array.isArray(c.bullets) && c.bullets.length === 0, "bullets deveria ser []");
    assert(Array.isArray(c.especificacoes) && c.especificacoes.length === 0, "especificacoes deveria ser []");
    assert(c.cta === undefined, "CTA não deveria existir");
  });

  console.log("\n[validação do payload editorial]");
  const valido = { titulo: "T", descricao: "D", bullets: ["b"], especificacoes: [{ nome: "n", valor: "v" }] };
  t("4. payload válido é aceito", () => {
    const r = validarConteudoEditorial(valido);
    assert(r.valido && !!r.dados, r.erro ?? "deveria aceitar");
  });
  t("5. título vazio é rejeitado", () => {
    assert(!validarConteudoEditorial({ ...valido, titulo: "   " }).valido, "deveria rejeitar");
    assert(!validarConteudoEditorial({ ...valido, titulo: 123 }).valido, "tipo errado deveria rejeitar");
  });
  t("6. descrição vazia é rejeitada", () =>
    assert(!validarConteudoEditorial({ ...valido, descricao: "" }).valido, "deveria rejeitar"));
  t("7. bullets inválidos são rejeitados; linha em branco é descartada", () => {
    assert(!validarConteudoEditorial({ ...valido, bullets: "b" }).valido, "string no lugar de lista");
    assert(!validarConteudoEditorial({ ...valido, bullets: [1] }).valido, "item não-texto");
    const r = validarConteudoEditorial({ ...valido, bullets: ["a", "   ", "b"] });
    assert(r.valido && r.dados!.bullets.join() === "a,b", "linha em branco deveria ser descartada");
  });
  t("8. especificações inválidas são rejeitadas", () => {
    assert(!validarConteudoEditorial({ ...valido, especificacoes: {} }).valido, "objeto no lugar de lista");
    assert(!validarConteudoEditorial({ ...valido, especificacoes: [{ nome: "n" }] }).valido, "sem valor");
    assert(!validarConteudoEditorial({ ...valido, especificacoes: [{ nome: "", valor: "v" }] }).valido, "sem nome");
    assert(!validarConteudoEditorial({ ...valido, especificacoes: [{ nome: "n", valor: "v", extra: 1 }] }).valido, "campo extra na espec");
  });
  t("9. campo extra no payload é rejeitado (não editável)", () => {
    for (const extra of ["marketplace", "schema_versao", "job_id", "provedor", "score", "fatoIds"]) {
      assert(!validarConteudoEditorial({ ...valido, [extra]: "x" }).valido, `"${extra}" deveria ser rejeitado`);
    }
  });
  t("10. limites de tamanho são aplicados", () => {
    assert(!validarConteudoEditorial({ ...valido, titulo: "x".repeat(LIMITES.tituloMax + 1) }).valido, "título longo");
    assert(!validarConteudoEditorial({ ...valido, descricao: "x".repeat(LIMITES.descricaoMax + 1) }).valido, "descrição longa");
    assert(!validarConteudoEditorial({ ...valido, bullets: Array(LIMITES.bulletsMax + 1).fill("b") }).valido, "bullets demais");
    assert(!validarConteudoEditorial({ ...valido, especificacoes: Array(LIMITES.especificacoesMax + 1).fill({ nome: "n", valor: "v" }) }).valido, "especificações demais");
  });
  t("11. CTA continua restrito à lista controlada, mesmo em edição manual", () => {
    assert(validarConteudoEditorial({ ...valido, cta: CTAS_PERMITIDOS[0] }).valido, "CTA da lista deveria passar");
    assert(!validarConteudoEditorial({ ...valido, cta: "COMPRE JÁ!!!" }).valido, "CTA inventado deveria falhar");
    assert(validarConteudoEditorial({ ...valido, cta: "" }).valido, "CTA vazio deveria ser aceito como ausente");
  });
  t("12. edição divergente da IA é PERMITIDA — decisão humana não é censurada", () => {
    const r = validarConteudoEditorial({
      titulo: "Título totalmente diferente do que a IA escreveu",
      descricao: "Texto novo, com informação que a IA não colocou.",
      bullets: ["afirmação nova"], especificacoes: [{ nome: "Peso", valor: "500g" }],
    });
    assert(r.valido, `edição manual não pode ser bloqueada por divergir da IA: ${r.erro}`);
  });

  console.log("\n[leitura do estado editorial]");
  await t("13. sem versões: base da IA disponível, editável, histórico vazio", async () => {
    const sb = fakeSupabase(baseDados());
    const canais = await montarEditorialProjeto(sb, PROJ, ADAPTACAO, "res-1");
    const ml = canais.find(c => c.marketplace === "ML")!;
    assert(ml.baseIA?.titulo === "Titulo ML", "base da IA ausente");
    assert(ml.baseResultadoId === "res-1", "vínculo com o resultado da IA perdido");
    assert(ml.versaoAtual === null && ml.versaoAprovada === null && ml.historico.length === 0, "não deveria haver versão");
    assert(ml.editavel, "deveria ser editável");
  });
  await t("14. sem adaptação: NÃO editável, sem fabricar versão", async () => {
    const sb = fakeSupabase(baseDados());
    const canais = await montarEditorialProjeto(sb, PROJ, null, null);
    assert(canais.every(c => !c.editavel && c.baseIA === null), "não deveria ser editável sem adaptação");
    assert(canais.every(c => c.historico.length === 0), "não pode fabricar versão");
  });
  await t("15. versão atual = maior número; aprovada = a marcada", async () => {
    const sb = fakeSupabase(baseDados({
      estudio_anuncios_conteudo_versoes: [
        versao({ id: "v1", numero_versao: 1 }),
        versao({ id: "v2", numero_versao: 2, origem: "edicao_manual", aprovado: true, aprovado_em: "2026-08-20T11:00:00Z", aprovado_por: "u1", criado_por: "u1" }),
        versao({ id: "v3", numero_versao: 3, origem: "edicao_manual", criado_por: "u1" }),
      ],
    }));
    const ml = (await montarEditorialProjeto(sb, PROJ, ADAPTACAO, "res-1")).find(c => c.marketplace === "ML")!;
    assert(ml.versaoAtual?.numeroVersao === 3, `atual deveria ser 3, veio ${ml.versaoAtual?.numeroVersao}`);
    assert(ml.versaoAprovada?.numeroVersao === 2, `aprovada deveria ser 2, veio ${ml.versaoAprovada?.numeroVersao}`);
    assert(ml.historico.map(v => v.numeroVersao).join() === "3,2,1", "histórico fora de ordem");
  });
  await t("16. cada marketplace tem histórico independente", async () => {
    const sb = fakeSupabase(baseDados({
      estudio_anuncios_conteudo_versoes: [
        versao({ id: "ml1", projeto_marketplace_id: CANAL_ML, numero_versao: 1 }),
        versao({ id: "ml2", projeto_marketplace_id: CANAL_ML, numero_versao: 2, origem: "edicao_manual" }),
        versao({ id: "sh1", projeto_marketplace_id: CANAL_SH, numero_versao: 1 }),
      ],
    }));
    const canais = await montarEditorialProjeto(sb, PROJ, ADAPTACAO, "res-1");
    assert(canais.find(c => c.marketplace === "ML")!.historico.length === 2, "ML deveria ter 2");
    assert(canais.find(c => c.marketplace === "Shopee")!.historico.length === 1, "Shopee deveria ter 1");
  });
  await t("17. canal de OUTRO projeto nunca aparece", async () => {
    filtros.length = 0;
    const sb = fakeSupabase(baseDados());
    const canais = await montarEditorialProjeto(sb, PROJ, ADAPTACAO, "res-1");
    assert(canais.length === 2, `deveriam ser 2 canais, vieram ${canais.length}`);
    assert(!canais.some(c => c.projetoMarketplaceId === "canal-de-outro"), "canal de outro projeto vazou");
    assert(filtros.some(f => f.tabela === "estudio_anuncios_projetos_marketplace" && f.coluna === "projeto_id" && f.valor === PROJ), "sem filtro por projeto");
  });
  await t("18. marketplace fora do projeto não resolve", async () => {
    const sb = fakeSupabase(baseDados());
    assert((await buscarCanalDoProjeto(sb, PROJ, "Amazon")) === null, "Amazon não pertence ao projeto");
    assert((await buscarCanalDoProjeto(sb, PROJ, "Inexistente")) === null, "marketplace inválido deveria dar null");
    assert((await buscarCanalDoProjeto(sb, PROJ, "ML"))?.id === CANAL_ML, "ML deveria resolver");
  });
  await t("19. a origem viaja para a UI (IA vs manual)", async () => {
    const sb = fakeSupabase(baseDados({
      estudio_anuncios_conteudo_versoes: [
        versao({ id: "v1", numero_versao: 1, origem: "ia_adaptacao_marketplace" }),
        versao({ id: "v2", numero_versao: 2, origem: "edicao_manual", criado_por: "u1" }),
      ],
    }));
    const ml = (await montarEditorialProjeto(sb, PROJ, ADAPTACAO, "res-1")).find(c => c.marketplace === "ML")!;
    assert(ml.historico.find(v => v.numeroVersao === 1)!.origem === "ia_adaptacao_marketplace", "origem da v1");
    assert(ml.historico.find(v => v.numeroVersao === 2)!.origem === "edicao_manual", "origem da v2");
    assert(ml.historico.find(v => v.numeroVersao === 1)!.criadoPor === null, "v1 não tem autor humano");
    assert(ml.historico.find(v => v.numeroVersao === 2)!.criadoPor === "u1", "v2 deveria ter autor");
  });

  console.log("\n[garantias estruturais — banco e código]");
  function semComentarios(f: string) {
    return f.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  }
  const ler = (p: string) => semComentarios(fs.readFileSync(path.join(process.cwd(), p), "utf-8"));
  const LIB = ler("lib/estudio-anuncios/conteudo-editorial.ts");
  const ROTA_VERSOES = ler("app/api/estudio-anuncios/projetos/[id]/conteudo/[marketplace]/versoes/route.ts");
  const ROTA_APROVAR = ler("app/api/estudio-anuncios/projetos/[id]/conteudo/[marketplace]/aprovar/route.ts");
  const UI = ler("app/(app)/central-ia/estudio-anuncios/[projetoId]/EditorConteudo.tsx");
  const MIGRATION = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260820_conteudo_versoes_editorial.sql"), "utf-8");

  t("20. a Fase 1 é intocável — nenhuma escrita em artefato técnico", () => {
    for (const [nome, f] of [["lib", LIB], ["rota versoes", ROTA_VERSOES], ["rota aprovar", ROTA_APROVAR], ["ui", UI]] as const) {
      for (const tabela of ["resultados_pipeline", "estudio_anuncios_jobs", "estudio_anuncios_pipeline", "imagens_geradas"]) {
        const trecho = f.split(tabela)[1]?.slice(0, 200) ?? "";
        assert(!/\.(insert|update|upsert|delete)\(/.test(trecho), `${nome} escreve em ${tabela}`);
      }
      assert(!/pipeline_avancar|pipeline_iniciar|concluir_job|falhar_job/.test(f), `${nome} mexe no Pipeline`);
      assert(!/calcularScoreFinal|PESOS_BLOCOS|estimarCustoUsd/.test(f), `${nome} recalcula score/custo`);
    }
  });
  t("21. append-only: a camada nunca faz UPDATE de conteúdo", () => {
    assert(!/\.update\(/.test(LIB), "lib faz UPDATE direto");
    assert(!/\.update\(/.test(ROTA_VERSOES) && !/\.update\(/.test(ROTA_APROVAR), "rota faz UPDATE direto");
    // O único UPDATE da camada vive na RPC de aprovação, e só toca a flag
    // de aprovação — nunca `conteudo`, `titulo_principal` ou `origem`.
    assert(/SET aprovado = false/.test(MIGRATION), "RPC não rebaixa a aprovada anterior");
    assert(/SET aprovado = true/.test(MIGRATION), "RPC não promove a nova");
    for (const campo of ["SET conteudo", "SET titulo_principal", "SET origem", "SET numero_versao"]) {
      assert(!MIGRATION.includes(campo), `alguma RPC reescreve "${campo}" — a camada é append-only`);
    }
  });
  t("22. escrita só via RPC atômica", () => {
    assert(/rpc\("estudio_anuncios_criar_versao_conteudo"/.test(LIB), "criação deveria usar RPC");
    assert(/rpc\("estudio_anuncios_aprovar_versao_conteudo"/.test(LIB), "aprovação deveria usar RPC");
    assert(!/from\("estudio_anuncios_conteudo_versoes"\)[\s\S]{0,80}\.insert/.test(LIB), "INSERT solto na tabela editorial");
  });
  t("23. o banco garante numeração, uma aprovada e idempotência", () => {
    assert(/FOR UPDATE/.test(MIGRATION), "sem lock para numerar sob concorrência");
    assert(/idx_conteudo_versoes_aprovada_unica[\s\S]*WHERE aprovado/.test(MIGRATION), "sem índice único de aprovada");
    assert(/idx_conteudo_versoes_request[\s\S]*request_id IS NOT NULL/.test(MIGRATION), "sem índice único de idempotência");
    assert(/ADD COLUMN IF NOT EXISTS criado_por/.test(MIGRATION) && /aprovado_por/.test(MIGRATION), "sem autor/aprovador");
    assert(/resultado_pipeline_origem_id[\s\S]*REFERENCES/.test(MIGRATION), "sem vínculo com a saída da IA");
  });
  t("24. o CHECK de origem foi ampliado sem apagar os valores legados", () => {
    assert(/'ia_adaptacao_marketplace'/.test(MIGRATION), "valor novo ausente");
    for (const legado of ["'ia_openai'", "'revisao_claude'", "'edicao_manual'"]) {
      assert(MIGRATION.includes(legado), `valor legado ${legado} foi removido`);
    }
  });
  t("25. autor vem SEMPRE da sessão, nunca do corpo", () => {
    for (const [nome, f] of [["versoes", ROTA_VERSOES], ["aprovar", ROTA_APROVAR]] as const) {
      assert(/getUserId\(request\)/.test(f), `${nome} não lê a sessão`);
      assert(!/body\.(userId|user_id|criadoPor|aprovadoPor)/.test(f), `${nome} aceita autor do corpo`);
    }
    assert(/criadoPor: userId/.test(ROTA_VERSOES), "criado_por deveria vir do userId da sessão");
    assert(/aprovarVersaoEditorial\(getSupabaseServidor\(\), versaoId, userId\)/.test(ROTA_APROVAR), "aprovado_por deveria vir do userId");
  });
  t("26. ordem de segurança preservada nas duas rotas", () => {
    for (const [nome, f] of [["versoes", ROTA_VERSOES], ["aprovar", ROTA_APROVAR]] as const) {
      const iSessao = f.indexOf("getUserId");
      const iDono = f.indexOf("buscarProjetoPorId");
      const iCanal = f.indexOf("buscarCanalDoProjeto");
      const iServico = f.indexOf("getSupabaseServidor()");
      assert(iSessao >= 0 && iDono > iSessao, `${nome}: dono checado antes da sessão`);
      assert(iCanal > iDono, `${nome}: canal resolvido antes do dono`);
      assert(iServico > iCanal, `${nome}: service role usado antes das checagens`);
      assert(/status: 404/.test(f), `${nome}: sem 404 de propriedade`);
    }
  });
  t("27. editar não aprova — as ações são rotas distintas", () => {
    assert(!/aprovarVersaoEditorial/.test(ROTA_VERSOES), "a rota de salvar não pode aprovar");
    assert(!/criarVersaoEditorial/.test(ROTA_APROVAR), "a rota de aprovar não pode criar versão");
    assert(/origem: "edicao_manual"/.test(ROTA_VERSOES), "save deveria gravar origem manual");
    assert(!/aprovado: true/.test(ROTA_VERSOES), "save não pode marcar aprovado");
  });
  t("28. a UI não publica, não exporta e não regenera", () => {
    for (const proibido of ["publicar", "exportar", "regerar", "download", "recalcular", "excluir"]) {
      assert(!new RegExp(proibido, "i").test(UI), `UI não pode conter "${proibido}"`);
    }
    assert(!/createClient|SUPABASE|SERVICE_ROLE/.test(UI), "UI acessa Supabase/segredo no client");
  });
  t("29. a UI protege contra duplo clique e manda requestId", () => {
    assert(/disabled=\{salvando\}/.test(UI), "botão de salvar não é bloqueado durante a requisição");
    assert(/disabled=\{aprovando\}/.test(UI), "botão de aprovar não é bloqueado durante a requisição");
    assert(/requestId: crypto\.randomUUID\(\)/.test(UI), "sem chave de idempotência");
    assert(/Salvar nova versão/.test(UI), 'o botão deve dizer "Salvar nova versão", nunca só "Salvar"');
  });
  t("30. cancelar não grava nada", () => {
    const trecho = UI.split("onCancelar")[1]?.slice(0, 400) ?? "";
    assert(!/fetch\(/.test(trecho), "cancelar dispara requisição");
    assert(/setEditando\(false\)/.test(UI), "cancelar deveria só sair do modo edição");
  });

}

rodar().then(() => {
  console.log(`\n=== RESULTADO: ${ok} passaram, ${falhou} falharam ===\n`);
  process.exitCode = falhou > 0 ? 1 : 0;
});
