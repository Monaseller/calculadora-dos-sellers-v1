/**
 * Testes determinísticos da EXPORTAÇÃO do conteúdo aprovado. Sem banco
 * real, sem rede, custo zero: cliente Supabase de mentira. A atomicidade
 * da RPC é validada contra o banco real na etapa de validação.
 *
 * Uso: npx tsx scripts/testar-exportacao.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  calcularHashConteudo,
  montarItensIncluidos,
  statusDoPacote,
  temAlgumCanalExportavel,
  listarPacotesDoProjeto,
  SCHEMA_VERSAO_PACOTE_EXPORTACAO,
} from "../lib/estudio-anuncios/exportacao";
import type { ItensIncluidos } from "../lib/estudio-anuncios/exportacao";

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
      eq(coluna: string, valor: any) { filtros.push({ tabela, coluna, valor }); linhas = linhas.filter((l: any) => l[coluna] === valor); return api; },
      in(coluna: string, valores: any[]) { filtros.push({ tabela, coluna, valor: valores }); linhas = linhas.filter((l: any) => valores.includes(l[coluna])); return api; },
      maybeSingle: async () => ({ data: linhas[0] ?? null, error: null }),
      then: (r: any) => r({ data: linhas, error: null }),
    };
    return api;
  };
  return { from: (tabela: string) => ({ select: () => construir(tabela) }) } as any;
}

const CONTEUDO = { titulo: "T aprovado", descricao: "D aprovada", bullets: ["b1"], especificacoes: [{ nome: "Cor", valor: "Verde" }] };
function versao(over: Record<string, any> = {}) {
  return {
    id: "v-aprovada", projeto_marketplace_id: CANAL_ML, numero_versao: 3, conteudo: CONTEUDO,
    aprovado: true, aprovado_em: "2026-08-20T12:00:00Z", aprovado_por: "u1", ...over,
  };
}
function baseDados(over: Partial<Record<string, any[]>> = {}) {
  return {
    estudio_anuncios_projetos_marketplace: [
      { projeto_id: PROJ, id: CANAL_ML, marketplace: "ML" },
      { projeto_id: OUTRO, id: "canal-de-outro", marketplace: "ML" },
    ],
    estudio_anuncios_conteudo_versoes: [
      versao({ id: "v1", numero_versao: 1, aprovado: false, aprovado_em: null, aprovado_por: null, conteudo: { ...CONTEUDO, titulo: "NAO APROVADA" } }),
      versao(),
    ],
    estudio_anuncios_imagens_geradas: [
      { projeto_id: PROJ, id: "img-2", prompt_ordem: 2, finalidade: "detalhes", e_principal: false, largura_px: 1024, altura_px: 1024, mime_type: "image/jpeg" },
      { projeto_id: PROJ, id: "img-1", prompt_ordem: 1, finalidade: "capa_principal", e_principal: true, largura_px: 1024, altura_px: 1024, mime_type: "image/jpeg" },
      { projeto_id: OUTRO, id: "img-X", prompt_ordem: 1, finalidade: "capa_principal", e_principal: true, largura_px: 1, altura_px: 1, mime_type: "image/jpeg" },
    ],
    estudio_anuncios_pacotes_exportacao: [],
    ...over,
  } as Record<string, any[]>;
}

async function rodar() {
  console.log("\n[só a versão APROVADA é fonte]");
  await t("1. exporta a versão aprovada, nunca a mais recente não aprovada", async () => {
    const sb = fakeSupabase(baseDados());
    const itens = await montarItensIncluidos(sb, PROJ, "Produto");
    const ml = itens.canais.find(c => c.marketplace === "ML")!;
    assert(ml.exportavel, "ML deveria ser exportável");
    assert((ml as any).conteudo.titulo === "T aprovado", `exportou o conteúdo errado: ${(ml as any).conteudo.titulo}`);
    assert((ml as any).numeroVersao === 3, "número da versão aprovada incorreto");
    assert((ml as any).versaoAprovadaId === "v-aprovada", "referência à versão aprovada incorreta");
  });
  await t("2. a consulta filtra aprovado=true — não existe caminho para não aprovada", async () => {
    filtros.length = 0;
    const sb = fakeSupabase(baseDados());
    await montarItensIncluidos(sb, PROJ, "Produto");
    assert(filtros.some(f => f.tabela === "estudio_anuncios_conteudo_versoes" && f.coluna === "aprovado" && f.valor === true),
      "leitura de versões sem filtro aprovado=true");
  });
  await t("3. canal SEM versão aprovada vira não exportável — zero fallback", async () => {
    const dados = baseDados({ estudio_anuncios_conteudo_versoes: [versao({ aprovado: false, aprovado_em: null, aprovado_por: null })] });
    const sb = fakeSupabase(dados);
    const itens = await montarItensIncluidos(sb, PROJ, "Produto");
    const ml = itens.canais[0];
    assert(!ml.exportavel, "não deveria ser exportável");
    assert(!("conteudo" in ml), "canal não exportável não pode carregar conteúdo");
    assert(/Nenhuma versão aprovada/.test((ml as any).motivo), "motivo ausente");
    assert(!temAlgumCanalExportavel(itens), "não deveria haver canal exportável");
  });
  await t("4. projeto sem NENHUMA versão aprovada não gera pacote", async () => {
    const sb = fakeSupabase(baseDados({ estudio_anuncios_conteudo_versoes: [] }));
    const itens = await montarItensIncluidos(sb, PROJ, "Produto");
    assert(!temAlgumCanalExportavel(itens), "não deveria haver canal exportável");
  });
  await t("5. um canal aprovado e outro não → status parcial", async () => {
    const dados = baseDados();
    dados.estudio_anuncios_projetos_marketplace.push({ projeto_id: PROJ, id: CANAL_SH, marketplace: "Shopee" });
    const sb = fakeSupabase(dados);
    const itens = await montarItensIncluidos(sb, PROJ, "Produto");
    assert(itens.canais.length === 2, "deveriam ser 2 canais");
    assert(statusDoPacote(itens) === "parcial", `status deveria ser parcial, veio ${statusDoPacote(itens)}`);
    assert(temAlgumCanalExportavel(itens), "ainda há canal exportável");
    assert(itens.canais.find(c => c.marketplace === "Shopee")!.exportavel === false, "Shopee não deveria ser exportável");
  });
  await t("6. todos os canais aprovados → status gerado", async () => {
    const sb = fakeSupabase(baseDados());
    assert(statusDoPacote(await montarItensIncluidos(sb, PROJ, "Produto")) === "gerado", "deveria ser gerado");
  });

  console.log("\n[isolamento e conteúdo do pacote]");
  await t("7. nunca inclui canal, versão ou imagem de outro projeto", async () => {
    filtros.length = 0;
    const sb = fakeSupabase(baseDados());
    const itens = await montarItensIncluidos(sb, PROJ, "Produto");
    assert(itens.canais.length === 1 && itens.canais[0].marketplace === "ML", "canal de outro projeto vazou");
    assert(!itens.imagens.some(i => i.imagemGeradaId === "img-X"), "imagem de outro projeto vazou");
    assert(filtros.filter(f => f.coluna === "projeto_id").every(f => f.valor === PROJ), "filtro de projeto incorreto");
  });
  await t("8. o pacote carrega referência E snapshot da versão aprovada", async () => {
    const sb = fakeSupabase(baseDados());
    const ml = (await montarItensIncluidos(sb, PROJ, "Produto")).canais[0] as any;
    assert(ml.versaoAprovadaId && ml.numeroVersao && ml.aprovadoEm && ml.aprovadoPor, "faltou referência auditável");
    assert(ml.conteudo.titulo && ml.conteudo.descricao && Array.isArray(ml.conteudo.bullets), "faltou snapshot por valor");
    assert(ml.conteudo.especificacoes[0].nome === "Cor", "especificação achatada ou perdida");
  });
  await t("9. imagens entram por referência: id, sem bytes e sem URL", async () => {
    const sb = fakeSupabase(baseDados());
    const itens = await montarItensIncluidos(sb, PROJ, "Produto");
    assert(itens.imagens.length === 2, `deveriam ser 2 imagens, vieram ${itens.imagens.length}`);
    assert(itens.imagens[0].principal, "a principal deveria vir primeiro");
    const s = JSON.stringify(itens.imagens);
    assert(!/base64|http|storage_path|urlAssinada/.test(s), "vazou bytes ou URL no pacote");
  });
  await t("10. o pacote declara que imagem não tem aprovação no sistema", async () => {
    const sb = fakeSupabase(baseDados());
    const itens = await montarItensIncluidos(sb, PROJ, "Produto");
    assert(itens.observacoes.some(o => /somente versões aprovadas/i.test(o)), "faltou a observação sobre versões");
    assert(itens.observacoes.some(o => /não existe aprovação de imagem/i.test(o)), "faltou a ressalva sobre imagens");
    assert(itens.schemaVersao === SCHEMA_VERSAO_PACOTE_EXPORTACAO, "schemaVersao ausente");
  });

  console.log("\n[hash: identidade do conteúdo, não do instante]");
  const itensDe = async (dados = baseDados()) => montarItensIncluidos(fakeSupabase(dados), PROJ, "Produto");
  await t("11. mesmo conteúdo aprovado → mesmo hash, mesmo em outro instante", async () => {
    const a = await itensDe();
    const b = await itensDe();
    assert(a.geradoEm !== b.geradoEm || true, "instantes podem coincidir, tudo bem");
    const b2: ItensIncluidos = { ...b, geradoEm: "1999-01-01T00:00:00Z" };
    assert(calcularHashConteudo(a) === calcularHashConteudo(b2), "o instante não pode entrar no hash");
  });
  await t("12. trocar a versão aprovada MUDA o hash", async () => {
    const a = await itensDe();
    const dados = baseDados({ estudio_anuncios_conteudo_versoes: [versao({ id: "v-outra", numero_versao: 4 })] });
    const b = await itensDe(dados);
    assert(calcularHashConteudo(a) !== calcularHashConteudo(b), "hash deveria mudar com outra versão aprovada");
  });
  await t("13. canal a mais, ou imagem a mais, muda o hash", async () => {
    const a = await itensDe();
    const d1 = baseDados();
    d1.estudio_anuncios_projetos_marketplace.push({ projeto_id: PROJ, id: CANAL_SH, marketplace: "Shopee" });
    assert(calcularHashConteudo(a) !== calcularHashConteudo(await itensDe(d1)), "canal novo deveria mudar o hash");
    const d2 = baseDados();
    d2.estudio_anuncios_imagens_geradas.push({ projeto_id: PROJ, id: "img-3", prompt_ordem: 3, finalidade: "uso", e_principal: false, largura_px: 1, altura_px: 1, mime_type: "image/jpeg" });
    assert(calcularHashConteudo(a) !== calcularHashConteudo(await itensDe(d2)), "imagem nova deveria mudar o hash");
  });
  await t("14. hash é estável contra reordenação (ordem do banco não é garantida)", async () => {
    const d1 = baseDados();
    d1.estudio_anuncios_projetos_marketplace = [{ projeto_id: PROJ, id: CANAL_ML, marketplace: "ML" }, { projeto_id: PROJ, id: CANAL_SH, marketplace: "Shopee" }];
    const d2 = baseDados();
    d2.estudio_anuncios_projetos_marketplace = [{ projeto_id: PROJ, id: CANAL_SH, marketplace: "Shopee" }, { projeto_id: PROJ, id: CANAL_ML, marketplace: "ML" }];
    assert(calcularHashConteudo(await itensDe(d1)) === calcularHashConteudo(await itensDe(d2)), "hash mudou só por ordem dos canais");
    const d3 = baseDados();
    d3.estudio_anuncios_imagens_geradas = [...baseDados().estudio_anuncios_imagens_geradas].reverse();
    assert(calcularHashConteudo(await itensDe()) === calcularHashConteudo(await itensDe(d3)), "hash mudou só por ordem das imagens");
  });
  await t("15. hash é sha256 hex de 64 caracteres", async () => {
    const h = calcularHashConteudo(await itensDe());
    assert(/^[0-9a-f]{64}$/.test(h), `formato inesperado: ${h}`);
  });

  console.log("\n[histórico]");
  await t("16. pacotes vêm do mais recente para o mais antigo", async () => {
    const sb = fakeSupabase(baseDados({
      estudio_anuncios_pacotes_exportacao: [
        { projeto_id: PROJ, id: "p1", numero_pacote: 1, status: "gerado", hash_conteudo: "h1", criado_em: "2026-08-21T10:00:00Z", gerado_por: "u1", storage_path: null, itens_incluidos: {} },
        { projeto_id: PROJ, id: "p2", numero_pacote: 2, status: "parcial", hash_conteudo: "h2", criado_em: "2026-08-21T11:00:00Z", gerado_por: "u1", storage_path: null, itens_incluidos: {} },
        { projeto_id: OUTRO, id: "pX", numero_pacote: 1, status: "gerado", hash_conteudo: "hX", criado_em: "2026-08-21T12:00:00Z", gerado_por: "u2", storage_path: null, itens_incluidos: {} },
      ],
    }));
    const lista = await listarPacotesDoProjeto(sb, PROJ);
    assert(lista.length === 2, `deveriam ser 2, vieram ${lista.length}`);
    assert(lista[0].numeroPacote === 2, "o mais recente deveria vir primeiro");
    assert(!lista.some(p => p.id === "pX"), "pacote de outro projeto vazou");
  });

  console.log("\n[garantias estruturais — banco, rota e UI]");
  const semComentarios = (f: string) => f.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  const ler = (p: string) => semComentarios(fs.readFileSync(path.join(process.cwd(), p), "utf-8"));
  const LIB = ler("lib/estudio-anuncios/exportacao.ts");
  const ROTA = ler("app/api/estudio-anuncios/projetos/[id]/exportacao/route.ts");
  const UI = ler("app/(app)/central-ia/estudio-anuncios/[projetoId]/PacotesExportacao.tsx");
  const MIG = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260821_pacotes_exportacao.sql"), "utf-8");

  t("17. o banco garante idempotência, numeração e append-only", () => {
    assert(/idx_pacotes_exportacao_hash[\s\S]*\(projeto_id, hash_conteudo\)/.test(MIG), "sem unique por hash");
    assert(/idx_pacotes_exportacao_numero[\s\S]*\(projeto_id, numero_pacote\)/.test(MIG), "sem unique de numeração");
    assert(/FOR UPDATE/.test(MIG), "sem lock para numerar sob concorrência");
    assert(!/\bUPDATE public\.estudio_anuncios_pacotes|\bDELETE FROM public\.estudio_anuncios_pacotes/.test(MIG), "a RPC altera ou apaga pacote");
  });
  t("18. escrita só via RPC atômica; nenhum INSERT solto", () => {
    assert(/rpc\("estudio_anuncios_gerar_pacote_exportacao"/.test(LIB), "deveria usar a RPC");
    // Checagem precisa de ESCRITA no Supabase: `.from(...)` seguido de
    // insert/update/delete/upsert. Um `.update(` solto casaria com
    // `createHash(...).update(...)`, que não tem nada a ver com banco.
    const escritaSupabase = /\.from\([^)]*\)\s*\.\s*(insert|update|upsert|delete)\(/;
    assert(!escritaSupabase.test(LIB), "escrita direta na tabela");
    assert(!escritaSupabase.test(ROTA), "rota escreve direto no banco");
  });
  t("19. nada da Fase 1 nem da camada editorial é escrito", () => {
    for (const [nome, f] of [["lib", LIB], ["rota", ROTA], ["ui", UI]] as const) {
      for (const tabela of ["resultados_pipeline", "conteudo_versoes", "estudio_anuncios_jobs", "estudio_anuncios_pipeline", "imagens_geradas"]) {
        const depois = f.split(tabela)[1]?.slice(0, 200) ?? "";
        assert(!/\.(insert|update|upsert|delete)\(/.test(depois), `${nome} escreve em ${tabela}`);
      }
      assert(!/pipeline_avancar|pipeline_iniciar|concluir_job|falhar_job|aprovar_versao/.test(f), `${nome} mexe em Pipeline/aprovação`);
    }
  });
  t("20. não publica, não envia arquivo, não chama serviço externo", () => {
    for (const [nome, f] of [["lib", LIB], ["rota", ROTA], ["ui", UI]] as const) {
      assert(!/mercadolibre|mercadolivre|shopee\.|api\.amazon|tiktokapis/i.test(f), `${nome} tem integração de marketplace`);
      assert(!/\.storage\b|upload|createSignedUrl/.test(f), `${nome} mexe em Storage/arquivo`);
      assert(!/publicar|publish/i.test(f), `${nome} contém publicação`);
    }
    assert(!/fetch\(/.test(LIB), "a lib faz chamada de rede");
  });
  t("21. a UI não oferece exportar sem aprovação e bloqueia duplo clique", () => {
    assert(/podeExportar \?/.test(UI), "o botão deveria depender de podeExportar");
    assert(/disabled=\{gerando\}/.test(UI), "sem bloqueio de duplo clique");
    assert(/reaproveitado/.test(UI), "a UI não informa quando nada mudou");
    assert(!/createClient|SUPABASE|SERVICE_ROLE/.test(UI), "UI acessa Supabase/segredo");
  });
  t("22. a rota preserva a ordem de segurança e 409 sem aprovação", () => {
    // Comentários fora: a docstring da rota lista a MESMA ordem, então
    // sem isto o teste provaria a prosa, não o código (F0.c.3a).
    const CODIGO = ROTA.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
    const iSessao = CODIGO.indexOf("autenticarRequisicao");
    const iDono = CODIGO.indexOf("buscarProjetoPorId");
    const iServico = CODIGO.indexOf("getSupabaseServidor()");
    assert(iSessao >= 0 && iDono > iSessao && iServico > iDono, "ordem de segurança quebrada");
    assert(/status: 401/.test(ROTA) && /status: 400/.test(ROTA) && /status: 404/.test(ROTA) && /status: 409/.test(ROTA), "faltam códigos de erro");
    assert(/geradoPor: userId/.test(ROTA), "gerado_por deveria vir da sessão");
    assert(!/body\.(userId|geradoPor)/.test(ROTA), "aceita autor do corpo");
  });
  t("23. a lib nunca lê versaoAtual nem a base da IA", () => {
    assert(!/versaoAtual|baseIA|montarEditorialProjeto/.test(LIB), "a exportação está olhando fonte não aprovada");
  });
}

rodar().then(() => {
  console.log(`\n=== RESULTADO: ${ok} passaram, ${falhou} falharam ===\n`);
  process.exitCode = falhou > 0 ? 1 : 0;
});
