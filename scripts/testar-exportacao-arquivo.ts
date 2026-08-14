/**
 * Testes determinísticos da MATERIALIZAÇÃO do pacote em ZIP. Sem banco
 * real, sem Storage, sem rede, custo zero. O ZIP é montado, aberto de
 * volta e conferido entrada por entrada — o comportamento contra o
 * Storage e a RPC é validado à parte, contra o ambiente real.
 *
 * Uso: npx tsx scripts/testar-exportacao-arquivo.ts
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { montarZip, lerZip, crc32, dataDosUtc } from "../lib/estudio-anuncios/zip";
import {
  montarArquivoPacote,
  montarCsvCanal,
  montarEntradasZip,
  nomeArquivoImagem,
  nomeDiretorioPacote,
  nomeDownload,
  sanitizarSegmento,
  resolverImagensDoPacote,
  SCHEMA_VERSAO_ARQUIVO_PACOTE,
} from "../lib/estudio-anuncios/exportacao-arquivo";
import { paraDTOPublico } from "../lib/estudio-anuncios/exportacao";
import type { PacoteExportacaoUI } from "../lib/estudio-anuncios/exportacao";

let ok = 0, falhou = 0;
async function t(nome: string, fn: () => void | Promise<void>) {
  try { await fn(); ok++; console.log(`  PASS  ${nome}`); }
  catch (e: any) { falhou++; console.log(`  FALHA ${nome} -> ${e?.message ?? e}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

const PROJ = "11111111-1111-1111-1111-111111111111";
const OUTRO = "22222222-2222-2222-2222-222222222222";
const texto = (s: string) => new TextEncoder().encode(s);
const decodificar = (b: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(b);

function pacote(over: Partial<PacoteExportacaoUI> = {}, itensOver: any = {}): PacoteExportacaoUI {
  return {
    id: "pac-1",
    numeroPacote: 1,
    status: "gerado",
    hashConteudo: "a".repeat(64),
    criadoEm: "2026-08-21T17:07:47.724Z",
    geradoPor: "user-1",
    storagePath: null,
    arquivo: null,
    itens: {
      schemaVersao: 1,
      projetoId: PROJ,
      nomeProduto: "Cadeira Gamer Ação",
      geradoEm: "2026-08-21T17:07:47.724Z",
      canais: [
        {
          marketplace: "ML", exportavel: true, versaoAprovadaId: "v-ml", numeroVersao: 3,
          aprovadoEm: "2026-08-20T12:00:00Z", aprovadoPor: "user-1",
          conteudo: {
            titulo: 'Cadeira "Pro"; edição', descricao: "Linha 1\nLinha 2", bullets: ["b1", "b2"],
            especificacoes: [{ nome: "Cor", valor: "Preto" }, { nome: "Peso", valor: "12kg" }], cta: "Compre agora",
          },
        },
        { marketplace: "TikTok Shop", exportavel: false, motivo: "Nenhuma versão aprovada para este canal." },
      ],
      imagens: [
        { imagemGeradaId: "img-1", ordem: 1, finalidade: "capa_principal", principal: true, largura: 1024, altura: 1024, mimeType: "image/jpeg" },
        { imagemGeradaId: "img-2", ordem: 2, finalidade: "detalhes", principal: false, largura: 1024, altura: 1024, mimeType: "image/png" },
      ],
      observacoes: ["Somente versões aprovadas foram exportadas."],
      ...itensOver,
    },
    ...over,
  } as PacoteExportacaoUI;
}

const BYTES = new Map<string, Uint8Array>([
  ["img-1", new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3, 4, 5])],
  ["img-2", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9])],
]);

const porCaminho = (entradas: { caminho: string; dados: Uint8Array }[]) =>
  new Map(entradas.map(e => [e.caminho, e.dados]));

async function rodar() {
  console.log("\n[escritor de ZIP: determinístico e legível de volta]");
  await t("1. o ZIP é reaberto com os mesmos caminhos e bytes", () => {
    const entradas = [
      { caminho: "a/1.txt", dados: texto("olá ação") },
      { caminho: "a/2.bin", dados: new Uint8Array([0, 1, 2, 250]) },
    ];
    const lido = lerZip(montarZip(entradas, new Date("2026-08-21T00:00:00Z")));
    assert(lido.length === 2, `deveriam voltar 2 entradas, vieram ${lido.length}`);
    assert(lido[0].caminho === "a/1.txt" && decodificar(lido[0].dados) === "olá ação", "conteúdo de texto divergiu");
    assert(Buffer.compare(Buffer.from(lido[1].dados), Buffer.from(entradas[1].dados)) === 0, "bytes binários divergiram");
  });
  await t("2. mesmos dados + mesmo instante → bytes idênticos", () => {
    const e = [{ caminho: "x.txt", dados: texto("igual") }];
    const q = new Date("2026-08-21T10:11:12Z");
    assert(Buffer.compare(Buffer.from(montarZip(e, q)), Buffer.from(montarZip(e, q))) === 0, "ZIP não é byte-estável");
  });
  await t("3. instante diferente muda os bytes — por isso ele é congelado", () => {
    const e = [{ caminho: "x.txt", dados: texto("igual") }];
    const a = montarZip(e, new Date("2026-08-21T10:11:12Z"));
    const b = montarZip(e, new Date("2020-01-02T03:04:06Z"));
    assert(Buffer.compare(Buffer.from(a), Buffer.from(b)) !== 0, "o instante deveria entrar nos bytes");
  });
  await t("4. caminho repetido é rejeitado, nunca silenciosamente sobrescrito", () => {
    let lancou = false;
    try { montarZip([{ caminho: "x", dados: texto("a") }, { caminho: "x", dados: texto("b") }], new Date()); }
    catch { lancou = true; }
    assert(lancou, "deveria lançar em caminho repetido");
  });
  await t("5. CRC-32 e data DOS conferem com valores conhecidos", () => {
    assert(crc32(texto("123456789")) === 0xcbf43926, "CRC-32 incorreto");
    const d = dataDosUtc(new Date("2026-08-21T10:11:12Z"));
    assert(d.data === (((2026 - 1980) << 9) | (8 << 5) | 21), "data DOS incorreta");
    assert(d.hora === ((10 << 11) | (11 << 5) | 6), "hora DOS incorreta");
    assert(dataDosUtc(new Date("1970-01-01T00:00:00Z")).data === ((1 << 5) | 1), "data pré-1980 deveria ser fixada");
  });

  console.log("\n[nomes determinísticos]");
  await t("6. diretório e nomes de imagem são determinísticos, sem GUID", () => {
    assert(nomeDiretorioPacote(1) === "pacote-0001", nomeDiretorioPacote(1));
    assert(nomeDiretorioPacote(12) === "pacote-0012", nomeDiretorioPacote(12));
    assert(nomeArquivoImagem(1, "capa_principal", "image/jpeg") === "01-capa-principal.jpg", nomeArquivoImagem(1, "capa_principal", "image/jpeg"));
    assert(nomeArquivoImagem(10, "detalhes", "image/png") === "10-detalhes.png", nomeArquivoImagem(10, "detalhes", "image/png"));
    assert(nomeDownload(pacote()) === "pacote-0001.zip", "nome de download inesperado");
  });
  await t("7. segmento de caminho nunca vaza acento, espaço ou travessia", () => {
    assert(sanitizarSegmento("TikTok Shop") === "tiktok-shop", sanitizarSegmento("TikTok Shop"));
    assert(sanitizarSegmento("Mercado Livre") === "mercado-livre", sanitizarSegmento("Mercado Livre"));
    assert(sanitizarSegmento("../../etc") === "etc", sanitizarSegmento("../../etc"));
    assert(!/[^a-z0-9-]/.test(sanitizarSegmento("Ação Promoção!")), "sobrou caractere inválido");
    assert(sanitizarSegmento("///") === "sem-nome", "vazio deveria ter fallback nomeado");
  });

  console.log("\n[estrutura do pacote]");
  const entradas = montarEntradasZip(pacote(), BYTES);
  const mapa = porCaminho(entradas);
  await t("8. a árvore é a esperada, com raiz pacote-0001", () => {
    const caminhos = entradas.map(e => e.caminho);
    for (const esperado of [
      "pacote-0001/manifest.json", "pacote-0001/conteudo.json",
      "pacote-0001/ml/conteudo.csv",
      "pacote-0001/imagens/01-capa-principal.jpg", "pacote-0001/imagens/02-detalhes.png",
    ]) assert(caminhos.includes(esperado), `faltou ${esperado} em ${caminhos.join(", ")}`);
    assert(caminhos.every(c => c.startsWith("pacote-0001/")), "entrada fora da raiz do pacote");
    assert(caminhos.every(c => !c.includes("\\") && !c.includes("..")), "caminho inseguro no ZIP");
  });
  await t("9. canal SEM versão aprovada não ganha diretório nem CSV vazio", () => {
    assert(!entradas.some(e => e.caminho.includes("tiktok")), "criou pasta para canal não exportável");
    const m = JSON.parse(decodificar(mapa.get("pacote-0001/manifest.json")!));
    const tt = m.canais.find((c: any) => c.marketplace === "TikTok Shop");
    assert(tt && tt.exportavel === false && /Nenhuma versão aprovada/.test(tt.motivo), "canal não exportável mal declarado");
    assert(!("conteudo" in tt), "canal não exportável carregou conteúdo");
  });
  await t("10. manifest tem tudo que a tarefa exige, sem duplicar o conteúdo", () => {
    const m = JSON.parse(decodificar(mapa.get("pacote-0001/manifest.json")!));
    assert(m.schemaVersaoArquivo === SCHEMA_VERSAO_ARQUIVO_PACOTE && m.schemaVersaoPacote === 1, "faltou schema");
    assert(m.pacote.id === "pac-1" && m.pacote.numeroPacote === 1 && m.pacote.status === "gerado", "metadados do pacote incompletos");
    assert(m.pacote.hashConteudo === "a".repeat(64) && !!m.pacote.geradoEm, "faltou hash ou data");
    assert(m.projeto.id === PROJ && m.projeto.nomeProduto === "Cadeira Gamer Ação", "projeto incompleto");
    const ml = m.canais.find((c: any) => c.marketplace === "ML");
    assert(ml.versaoAprovadaId === "v-ml" && ml.numeroVersao === 3 && ml.arquivo === "ml/conteudo.csv", "canal mal referenciado");
    assert(m.imagens.length === 2 && m.arquivos.length === 5, "índice de arquivos incompleto");
    // "Não duplicar JSON gigantes": o texto do anúncio não entra aqui.
    assert(!JSON.stringify(m).includes("Linha 1"), "o manifest duplicou o conteúdo do anúncio");
  });
  await t("11. conteudo.json preserva o snapshot congelado sem transformação", () => {
    const c = JSON.parse(decodificar(mapa.get("pacote-0001/conteudo.json")!));
    assert(JSON.stringify(c) === JSON.stringify(pacote().itens), "o JSON técnico divergiu do snapshot");
    const ml = c.canais.find((x: any) => x.marketplace === "ML");
    assert(ml.conteudo.bullets.length === 2 && ml.conteudo.especificacoes[0].nome === "Cor", "estrutura achatada no JSON");
  });

  console.log("\n[CSV]");
  await t("12. CSV tem as colunas pedidas, na ordem, com uma linha de dados", () => {
    const csv = decodificar(mapa.get("pacote-0001/ml/conteudo.csv")!);
    const linhas = csv.replace(/^﻿/, "").trim().split("\r\n");
    assert(linhas.length === 2, `deveriam ser 2 linhas, vieram ${linhas.length}`);
    assert(linhas[0] === "titulo;descricao;bullets;especificacoes;cta;numero_versao;versao_aprovada_id;aprovado_em", linhas[0]);
  });
  await t("13. CSV é UTF-8 válido e preserva acento", () => {
    const bytes = mapa.get("pacote-0001/ml/conteudo.csv")!;
    decodificar(bytes); // `fatal: true` — lança se não for UTF-8 válido
    // Checagem nos BYTES: o TextDecoder consome o BOM ao decodificar.
    assert(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf,
      "faltou BOM UTF-8 (Excel pt-BR mostraria acento quebrado)");
    assert(montarCsvCanal(pacote().itens.canais[0] as any).includes("Compre agora"), "CTA ausente");
    const comAcento = montarCsvCanal({ ...(pacote().itens.canais[0] as any), conteudo: { titulo: "Ação Promoção", descricao: "d", bullets: [], especificacoes: [] } });
    assert(decodificar(texto(comAcento)).includes("Ação Promoção"), "acento não sobreviveu");
  });
  await t("14. aspas, ponto-e-vírgula e quebra de linha são escapados", () => {
    const csv = decodificar(mapa.get("pacote-0001/ml/conteudo.csv")!);
    assert(csv.includes('"Cadeira ""Pro""; edição"'), "aspas/;/ não escapados corretamente");
    assert(csv.includes('"Linha 1\nLinha 2"'), "quebra de linha não protegida por aspas");
  });
  await t("15. bullets e especificações achatados; a estrutura fica no JSON", () => {
    const csv = decodificar(mapa.get("pacote-0001/ml/conteudo.csv")!);
    assert(csv.includes("b1 | b2"), "bullets não achatados");
    assert(csv.includes("Cor=Preto | Peso=12kg"), "especificações não achatadas");
    assert(csv.includes("v-ml"), "faltou a referência à versão aprovada");
  });

  console.log("\n[imagens: cópia exata, ordem e sem IA]");
  await t("16. bytes das imagens entram intactos, principal primeiro", () => {
    const i1 = mapa.get("pacote-0001/imagens/01-capa-principal.jpg")!;
    const i2 = mapa.get("pacote-0001/imagens/02-detalhes.png")!;
    assert(Buffer.compare(Buffer.from(i1), Buffer.from(BYTES.get("img-1")!)) === 0, "bytes da imagem 1 alterados");
    assert(Buffer.compare(Buffer.from(i2), Buffer.from(BYTES.get("img-2")!)) === 0, "bytes da imagem 2 alterados");
    const m = JSON.parse(decodificar(mapa.get("pacote-0001/manifest.json")!));
    assert(m.imagens[0].principal === true && m.imagens[0].arquivo.endsWith("01-capa-principal.jpg"), "a principal deveria ser a 01");
    assert(m.imagens[1].imagemGeradaId === "img-2" && m.imagens[1].ordem === 2, "ordem das imagens não preservada");
  });
  await t("17. imagem referenciada sem bytes é ERRO, nunca ZIP incompleto", () => {
    let msg = "";
    try { montarEntradasZip(pacote(), new Map([["img-1", BYTES.get("img-1")!]])); }
    catch (e: any) { msg = e.message; }
    assert(/img-2/.test(msg), `deveria falhar citando a imagem ausente, veio: ${msg}`);
  });
  await t("18. pacote sem imagens não cria a pasta imagens/", () => {
    const e = montarEntradasZip(pacote({}, { imagens: [] }), new Map());
    assert(!e.some(x => x.caminho.includes("/imagens/")), "criou pasta de imagens vazia");
    assert(e.length === 3, `deveriam ser 3 entradas, vieram ${e.length}`);
  });
  await t("19. imagem de OUTRO projeto nunca é resolvida", async () => {
    const filtros: any[] = [];
    const sb: any = {
      from: () => ({
        select: () => {
          const api: any = {
            eq(col: string, val: any) { filtros.push({ col, val }); return api; },
            in(col: string, val: any) { filtros.push({ col, val }); return api; },
            then: (r: any) => r({ data: [], error: null }),
          };
          return api;
        },
      }),
    };
    let msg = "";
    try { await resolverImagensDoPacote(sb, pacote()); } catch (e: any) { msg = e.message; }
    assert(filtros.some(f => f.col === "projeto_id" && f.val === PROJ), "não filtrou pelo projeto do pacote");
    assert(/não existe mais/.test(msg), `imagem ausente deveria ser erro explícito, veio: ${msg}`);
    assert(!filtros.some(f => f.val === OUTRO), "consultou outro projeto");
  });

  console.log("\n[arquivo do pacote: determinismo e checksum]");
  await t("20. materializar duas vezes o mesmo pacote dá bytes idênticos", () => {
    const a = montarArquivoPacote(pacote(), BYTES);
    const b = montarArquivoPacote(pacote(), BYTES);
    assert(Buffer.compare(Buffer.from(a.bytes), Buffer.from(b.bytes)) === 0, "ZIP não é byte-estável");
    assert(a.checksum === b.checksum, "checksum instável");
    assert(a.checksum === createHash("sha256").update(a.bytes).digest("hex"), "checksum não é do arquivo");
  });
  await t("21. o ZIP real abre e bate com o banco (manifest ↔ pacote)", () => {
    const { bytes } = montarArquivoPacote(pacote(), BYTES);
    const lido = porCaminho(lerZip(bytes));
    const m = JSON.parse(decodificar(lido.get("pacote-0001/manifest.json")!));
    assert(m.pacote.hashConteudo === pacote().hashConteudo, "hash do manifest divergiu do pacote");
    assert(m.pacote.geradoEm === pacote().criadoEm, "data do manifest divergiu");
    for (const arq of m.arquivos) assert(lido.has(`pacote-0001/${arq}`), `manifest lista ${arq}, que não está no ZIP`);
    assert(lido.size === m.arquivos.length, "o ZIP tem arquivo fora do índice do manifest");
  });
  await t("22. conteúdo aprovado diferente → arquivo diferente", () => {
    const outro = pacote();
    (outro.itens.canais[0] as any).conteudo.titulo = "Outro título";
    assert(montarArquivoPacote(pacote(), BYTES).checksum !== montarArquivoPacote(outro, BYTES).checksum, "checksum não reagiu à mudança");
  });

  console.log("\n[o pacote congelado é a fonte — não o estado atual]");
  await t("23. o ZIP sai só de itens_incluidos, sem tocar em versões/adaptações", () => {
    const p = pacote();
    // Nenhuma leitura de banco acontece aqui: se `montarEntradasZip`
    // dependesse do estado atual, não seria possível chamá-la sem cliente.
    const e = montarEntradasZip(p, BYTES);
    const c = JSON.parse(decodificar(porCaminho(e).get("pacote-0001/conteudo.json")!));
    assert(c.canais[0].versaoAprovadaId === "v-ml", "não usou a versão congelada no pacote");
    assert(JSON.stringify(c) === JSON.stringify(p.itens), "o ZIP transformou o snapshot");
  });

  console.log("\n[DTO público: o caminho do Storage nunca sai]");
  await t("24. paraDTOPublico remove storagePath e bucket", () => {
    const p = pacote({
      storagePath: "user/proj/exportacoes/pac-1/pacote-0001.zip",
      arquivo: { bucket: "estudio-anuncios-exportacoes", mimeType: "application/zip", tamanhoBytes: 1234, checksumSha256: "c".repeat(64), materializadoEm: "2026-08-22T10:00:00Z" },
    });
    const dto = paraDTOPublico(p) as any;
    const s = JSON.stringify(dto);
    assert(dto.storagePath === undefined && !/storagePath|exportacoes\//.test(s), "vazou caminho do Storage");
    assert(dto.arquivo.bucket === undefined && !/estudio-anuncios-exportacoes/.test(s), "vazou o bucket");
    assert(dto.materializado === true && dto.arquivo.tamanhoBytes === 1234, "faltou metadado útil");
    assert(paraDTOPublico(pacote()).materializado === false, "não materializado deveria ser false");
  });

  console.log("\n[garantias estruturais — código, banco, rota e UI]");
  const semComentarios = (f: string) => f.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  const ler = (p: string) => semComentarios(fs.readFileSync(path.join(process.cwd(), p), "utf-8"));
  const LIB = ler("lib/estudio-anuncios/exportacao-arquivo.ts");
  const ZIP = ler("lib/estudio-anuncios/zip.ts");
  const ROTA = ler("app/api/estudio-anuncios/projetos/[id]/exportacao/[pacoteId]/arquivo/route.ts");
  const UI = ler("app/(app)/central-ia/estudio-anuncios/[projetoId]/PacotesExportacao.tsx");
  const MIG = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260822_pacotes_exportacao_arquivo.sql"), "utf-8");

  await t("25. materializar não altera hash, itens, número nem status", () => {
    const corpo = MIG.slice(MIG.indexOf("UPDATE public.estudio_anuncios_pacotes_exportacao"));
    const set = corpo.slice(0, corpo.indexOf("WHERE"));
    for (const congelada of ["hash_conteudo", "itens_incluidos", "numero_pacote", "status"]) {
      assert(!new RegExp(`${congelada}\\s*=`).test(set), `a RPC altera ${congelada}`);
    }
    assert(/FOR UPDATE/.test(MIG), "sem lock ao registrar o arquivo");
    assert(/PACOTE_JA_MATERIALIZADO_EM_OUTRO_CAMINHO/.test(MIG), "reaponta o pacote para outro arquivo em silêncio");
    assert(!/\bDELETE FROM public\.estudio_anuncios_pacotes|INSERT INTO public\.estudio_anuncios_pacotes/.test(MIG), "a RPC cria ou apaga pacote");
  });
  await t("26. o banco garante um objeto por pacote e materialização completa", () => {
    assert(/idx_pacotes_exportacao_storage_path[\s\S]*\(storage_path\)/.test(MIG), "sem unique por storage_path");
    assert(/chk_pacotes_exportacao_materializacao/.test(MIG), "sem CHECK de materialização completa");
    assert(/REVOKE EXECUTE[\s\S]*FROM PUBLIC, anon, authenticated/.test(MIG), "RPC exposta a anon/authenticated");
    assert(/GRANT EXECUTE[\s\S]*TO service_role/.test(MIG), "service_role sem EXECUTE");
    assert(/SECURITY INVOKER/.test(MIG) && /SET search_path = public/.test(MIG), "RPC fora do padrão de segurança");
  });
  await t("27. nada da Fase 1, do score ou da camada editorial é escrito", () => {
    for (const [nome, f] of [["lib", LIB], ["rota", ROTA], ["ui", UI]] as const) {
      for (const tabela of ["resultados_pipeline", "conteudo_versoes", "estudio_anuncios_jobs", "estudio_anuncios_pipeline", "imagens_geradas"]) {
        const depois = f.split(tabela)[1]?.slice(0, 200) ?? "";
        assert(!/\.(insert|update|upsert|delete)\(/.test(depois), `${nome} escreve em ${tabela}`);
      }
      assert(!/pipeline_avancar|pipeline_iniciar|concluir_job|falhar_job|aprovar_versao|calculo_score/.test(f), `${nome} mexe em Pipeline/aprovação/score`);
    }
  });
  await t("28. não chama IA, não gasta token, não publica em marketplace", () => {
    for (const [nome, f] of [["lib", LIB], ["zip", ZIP], ["rota", ROTA], ["ui", UI]] as const) {
      assert(!/genai|gemini|anthropic|ai-gateway|registrarConsumo|estimarCustoUsd/i.test(f), `${nome} toca em IA`);
      assert(!/mercadolibre|mercadolivre|shopee\.|api\.amazon|tiktokapis|publicar|publish/i.test(f), `${nome} publica em marketplace`);
    }
  });
  await t("29. bucket privado: nenhuma URL pública, só assinada e curta", () => {
    assert(!/getPublicUrl|public: true|publicUrl/.test(LIB + ROTA + UI), "gerou URL pública");
    assert(/createSignedUrl/.test(ler("lib/estudio-anuncios/storage.ts")), "download deveria usar URL assinada");
    assert(/expiresInSegundos = 300/.test(ler("lib/estudio-anuncios/storage.ts")), "URL assinada do pacote deveria ser curta");
    assert(!/createBucket|updateBucket/.test(LIB + ROTA + ler("lib/estudio-anuncios/storage.ts")), "código cria ou reconfigura bucket");
  });
  await t("30. a rota preserva a ordem de segurança e não vaza caminho", () => {
    // Comentários fora: a docstring lista a MESMA ordem (F0.c.3a).
    const CODIGO = ROTA.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
    const iSessao = CODIGO.indexOf("autenticarRequisicao");
    const iDono = CODIGO.indexOf("buscarProjetoPorId");
    const iPacote = CODIGO.indexOf("buscarPacoteDoProjeto");
    const iServico = CODIGO.indexOf("getSupabaseServidor()");
    assert(iSessao >= 0 && iDono > iSessao && iPacote > iDono && iServico > iPacote, "ordem de segurança quebrada");
    assert(/status: 401/.test(ROTA) && /status: 400/.test(ROTA) && /status: 404/.test(ROTA) && /status: 409/.test(ROTA), "faltam códigos de erro");
    assert(!/403/.test(ROTA), "pacote de outro usuário deveria ser 404, nunca 403");
    assert(/paraDTOPublico/.test(ROTA) && !/storagePath|storage_path/.test(ROTA), "a rota manipula caminho de Storage");
    assert(!/body\.(userId|geradoPor|storagePath)/.test(ROTA), "aceita dado sensível do corpo");
  });
  await t("31. a UI oferece gerar/baixar sem nunca ver o Storage", () => {
    assert(/Gerar arquivo/.test(UI) && /Baixar/.test(UI) && /Gerar novamente/.test(UI), "faltou ação na UI");
    assert(/materializado \?/.test(UI), "a UI não distingue pacote com e sem arquivo");
    assert(/formatarTamanho/.test(UI), "a UI não mostra o tamanho");
    assert(!/storagePath|storage_path|createClient|SERVICE_ROLE/.test(UI), "a UI toca em Storage ou segredo");
    assert(/disabled=\{!!ocupado\}/.test(UI), "sem bloqueio de duplo clique nas ações de arquivo");
  });
  await t("32. o ZIP é montado do pacote congelado, nunca do estado atual", () => {
    assert(!/conteudo_versoes|projetos_marketplace|adaptacao|montarItensIncluidos|montarEditorialProjeto/.test(LIB),
      "a materialização está lendo o estado atual do projeto");
    assert(/new Date\(pacote\.criadoEm\)/.test(LIB), "o ZIP deveria usar o instante congelado do pacote");
    assert(!/new Date\(\)/.test(ZIP), "o escritor de ZIP tem instante implícito");
  });
}

rodar().then(() => {
  console.log(`\n=== RESULTADO: ${ok} passaram, ${falhou} falharam ===\n`);
  process.exitCode = falhou > 0 ? 1 : 0;
});
