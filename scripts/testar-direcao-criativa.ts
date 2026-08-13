/**
 * Testes da direção criativa e do planejamento comercial das imagens
 * (2026-09-04).
 *
 * ── O que originou estes testes ─────────────────────────────────────
 * No primeiro E2E real com IA, as imagens saíram descaracterizadas: a
 * marca e o rótulo da embalagem foram apagados, e as 4 imagens eram
 * variações do mesmo retrato, sem estratégia comercial distinta.
 *
 * A auditoria achou três defeitos ESTRUTURAIS, e não "prompt fraco":
 *   1. O sistema mandava apagar a marca. As restrições globais traziam
 *      "não adicionar marca, logotipo, etiqueta ou selo" — escrito para
 *      impedir INVENÇÃO, mas executado pelo modelo como remoção do que
 *      existe de verdade.
 *   2. O negative prompt era semanticamente invertido: o provedor monta
 *      "NÃO INCLUA, em hipótese alguma: <lista>" e a lista era de REGRAS
 *      já negadas ("não alterar as cores"), produzindo dupla negação.
 *   3. O prompt nunca dizia que as fotos anexadas eram o produto a
 *      preservar — lia como briefing text-to-image.
 *
 * Estes testes existem para que nenhum dos três volte, e para garantir
 * que a direção do usuário realmente chega ao planejamento.
 *
 * NENHUMA chamada de IA acontece aqui. Nenhum provedor pago é tocado:
 * tudo é função pura de domínio + leitura de fonte.
 *
 * Uso: npx tsx scripts/testar-direcao-criativa.ts
 */
import fs from "node:fs";
import path from "node:path";
import { validarDirecaoCriativa, validarDirecoesImagens, validarEditarProjeto } from "../lib/estudio-anuncios/validacao";
import {
  montarConfiguracao,
  montarPromptsFinais,
  montarPromptGeracaoPromptsImagem,
  montarEntradaPromptsImagem,
  normalizarDirecoesImagens,
  calcularTiposPermitidos,
} from "../lib/estudio-anuncios/geracao-prompts-imagem";
import {
  INSTRUCAO_FIDELIDADE_PRODUTO,
  RESTRICOES_VISUAIS_GLOBAIS,
  RESTRICOES_IMAGEM_PRINCIPAL,
  TIPOS_IMAGEM_SUPORTADOS,
} from "../lib/estudio-anuncios/geracao-prompts-imagem-tipos";
import type { VerdadeVisual, PromptsImagemIA } from "../lib/estudio-anuncios/geracao-prompts-imagem-tipos";

let ok = 0, falhou = 0;
function t(nome: string, fn: () => void) {
  try { fn(); ok++; console.log(`  PASS  ${nome}`); }
  catch (e: any) { falhou++; console.log(`  FALHA ${nome} -> ${e?.message ?? e}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

/** Narrowing da união discriminada — falha o teste se veio erro. */
function valorDe<T>(r: { ok: true; valor: T } | { ok: false; erro: string }): T {
  if (!r.ok) throw new Error(`esperava sucesso, veio erro: ${r.erro}`);
  return r.valor;
}

const VV: VerdadeVisual = {
  produtoIdentificado: "Alicate universal 8 polegadas",
  marca: "Mundial",
  modelo: "777",
  categoria: ["Ferramentas", "Manuais"],
  resumoVisual: "Alicate com cabo isolado vermelho",
  coresDoProduto: ["vermelho", "aço"],
  materiaisDoProduto: ["aço", "PVC"],
  componentesDoProduto: ["cabo isolado", "mandíbula"],
  caracteristicasDoProduto: ["cabo antiderrapante"],
  usosConfirmados: ["apertar porcas"],
  publicoConfirmado: ["profissional"],
  itensDaEmbalagem: ["cartela"],
  textosImpressosNoProduto: ["MUNDIAL", "777", "8 POL"],
  naoConfirmado: ["durabilidade de 10 anos"],
};

const cfg = (over: Record<string, unknown> = {}) =>
  montarConfiguracao({
    quantidadeSolicitada: 4, estilo: null, modo: "rapido",
    marketplaces: ["ML"], verdadeVisual: VV, ...over,
  } as any);

const plano = (n: number): PromptsImagemIA => ({
  imagens: Array.from({ length: n }, (_, i) => ({
    ordem: i + 1,
    tipo: (i === 0 ? "capa_principal" : "perspectiva") as any,
    objetivo: i === 0 ? "apresentar o produto" : "mostrar outro ângulo",
    cena: "produto sobre superfície neutra",
    enquadramento: "produto_inteiro" as any,
    fundo: "cinza claro",
    iluminacao: "difusa",
    elementosObrigatorios: ["cabo isolado"],
    elementosProibidos: ["fundo poluído"],
  })),
});

console.log("\n[persistência da direção — validação]");

t("1. direção geral aceita texto, null e vazio (vazio = a IA decide)", () => {
  assert(valorDe(validarDirecaoCriativa("Tons marrons e creme")) === "Tons marrons e creme", "texto deveria passar");
  assert(valorDe(validarDirecaoCriativa(null)) === null, "null é válido");
  assert(valorDe(validarDirecaoCriativa("   ")) === null, "só espaços deveria virar null");
  assert(valorDe(validarDirecaoCriativa(undefined)) === null, "ausente é válido");
});

t("2. direção geral rejeita tipo errado e excesso de tamanho", () => {
  assert(validarDirecaoCriativa(42 as any).ok === false, "número deveria ser rejeitado");
  assert(validarDirecaoCriativa("x".repeat(2001)).ok === false, "acima de 2000 deveria ser rejeitado");
  assert(validarDirecaoCriativa("x".repeat(2000)).ok === true, "exatamente 2000 deveria passar");
});

t("3. instruções por imagem preservam POSIÇÃO — vazio no meio não desloca", () => {
  const r = validarDirecoesImagens(["capa", "", "detalhe", ""]);
  assert(r.ok === true, "deveria ser válido");
  const v = valorDe(r) as string[];
  assert(v.length === 4, `deveria manter 4 posições, veio ${v.length}`);
  assert(v[0] === "capa" && v[1] === "" && v[2] === "detalhe",
    "filtrar vazios moveria a instrução da imagem 3 para a 2");
});

t("4. array totalmente vazio vira null (= nenhuma instrução)", () => {
  assert(valorDe(validarDirecoesImagens(["", "", ""])) === null, "tudo vazio deveria virar null");
  assert(valorDe(validarDirecoesImagens([])) === null, "array vazio deveria virar null");
  assert(valorDe(validarDirecoesImagens(null)) === null, "null é válido");
});

t("5. instruções rejeitam item não-texto, excesso de itens e de tamanho", () => {
  assert(validarDirecoesImagens("texto" as any).ok === false, "string não é lista");
  assert(validarDirecoesImagens([1, 2] as any).ok === false, "número deveria ser rejeitado");
  assert(validarDirecoesImagens(Array(13).fill("x")).ok === false, "acima de 12 posições deveria ser rejeitado");
  assert(validarDirecoesImagens(["x".repeat(501)]).ok === false, "acima de 500 caracteres deveria ser rejeitado");
});

t("6. os dois campos são editáveis pela rota PATCH do projeto", () => {
  const r = validarEditarProjeto({ direcao_criativa: "premium", direcoes_imagens: ["a", ""] }, "rapido");
  assert(r.valido === true, `PATCH deveria aceitar os dois campos: ${(r as any).erro}`);
  const d = (r as any).dados;
  assert(d.direcao_criativa === "premium" && Array.isArray(d.direcoes_imagens), "campos não chegaram normalizados");
});

console.log("\n[quantidade — nunca fixa em 4]");

t("7. N instruções para N imagens, seja N=4, 6, 8 ou 10", () => {
  for (const n of [1, 4, 6, 8, 10, 12]) {
    const c = cfg({ quantidadeSolicitada: n });
    assert(c.direcoesImagens.length === n, `com ${n} imagens deveriam existir ${n} posições, vieram ${c.direcoesImagens.length}`);
  }
});

t("8. reduzir a quantidade não apaga o texto já escrito, só o ignora nesta execução", () => {
  const oito = ["i1", "i2", "i3", "i4", "i5", "i6", "i7", "i8"];
  const c = cfg({ quantidadeSolicitada: 4, direcoesImagens: oito });
  assert(c.direcoesImagens.length === 4, "deveria usar só as 4 primeiras");
  assert(c.direcoesImagens[3] === "i4", "a 4ª instrução deveria ser preservada");
  // O banco continua com as 8 (o CHECK aceita até 12) — normalizar é
  // decisão desta execução, não escrita destrutiva.
  assert(normalizarDirecoesImagens(oito, 8)[7] === "i8", "aumentar de novo deveria trazer o texto de volta");
});

t("9. faltando instrução, a posição vira \"\" — que significa 'a IA decide'", () => {
  const c = cfg({ quantidadeSolicitada: 4, direcoesImagens: ["só a primeira"] });
  assert(c.direcoesImagens[0] === "só a primeira", "a instrução dada deveria ser mantida");
  assert(c.direcoesImagens.slice(1).every(d => d === ""), "as demais deveriam ficar vazias, não undefined");
});

console.log("\n[a direção chega ao planejamento]");

t("10. direção geral aparece na instrução do modelo planejador", () => {
  const c = cfg({ direcaoCriativa: "Tons marrons e creme, aparência premium" });
  const texto = montarPromptGeracaoPromptsImagem(montarEntradaPromptsImagem(VV), c);
  assert(texto.includes("Tons marrons e creme"), "a direção do usuário não chegou ao modelo");
  assert(texto.includes("DIREÇÃO CRIATIVA DO ENSAIO"), "faltou a seção identificando a origem");
  // Não pode destravar o que a verdade visual proíbe.
  assert(/siga a verdade visual/i.test(texto), "faltou a precedência da verdade visual sobre a direção");
});

t("11. instruções individuais chegam identificadas por imagem", () => {
  const c = cfg({ direcoesImagens: ["kit completo", "", "cor aplicada", ""] });
  const texto = montarPromptGeracaoPromptsImagem(montarEntradaPromptsImagem(VV), c);
  assert(texto.includes("Imagem 1: kit completo"), "instrução da imagem 1 ausente");
  assert(texto.includes("Imagem 3: cor aplicada"), "instrução da imagem 3 ausente");
  assert(!texto.includes("Imagem 2:"), "imagem sem instrução não deveria ser listada");
});

t("12. sem nenhuma direção, o modelo não recebe seção vazia", () => {
  const texto = montarPromptGeracaoPromptsImagem(montarEntradaPromptsImagem(VV), cfg());
  assert(!texto.includes("DIREÇÃO CRIATIVA DO ENSAIO"), "não deveria haver seção sem conteúdo");
  assert(!texto.includes("INSTRUÇÕES POR IMAGEM"), "não deveria haver seção sem conteúdo");
});

t("13. a instrução do usuário NÃO é repassada como prompt bruto ao gerador", () => {
  const c = cfg({ direcoesImagens: ["MINHA FRASE LITERAL EXATA", "", "", ""] });
  const prompts = montarPromptsFinais(plano(4), VV, c);
  // Fica registrada para auditoria...
  assert(prompts[0].instrucaoUsuario === "MINHA FRASE LITERAL EXATA", "deveria ficar registrada no prompt persistido");
  // ...mas o texto que vai ao modelo de imagem vem do PLANO, não dela.
  assert(!prompts[0].promptTexto.includes("MINHA FRASE LITERAL EXATA"),
    "a frase do usuário não pode ir crua ao gerador — ela é direção, interpretada pelo planejador");
});

console.log("\n[fidelidade do produto — os três defeitos]");

t("14. DEFEITO 1: o sistema não manda mais apagar marca, rótulo ou texto", () => {
  const juntas = RESTRICOES_VISUAIS_GLOBAIS.join(" | ");
  assert(!/não adicionar marca, logotipo, etiqueta ou selo/.test(juntas),
    "voltou a regra que fazia o modelo remover a marca real");
  assert(!/não adicionar texto, letras, números ou tipografia/.test(juntas),
    "voltou a regra que fazia o modelo apagar o texto impresso na embalagem");
});

t("15. DEFEITO 2: o negative prompt lista COISAS, não regras negadas", () => {
  // O provedor prefixa "NÃO INCLUA, em hipótese alguma:", então um item
  // começando com "não" produz dupla negação.
  for (const r of RESTRICOES_VISUAIS_GLOBAIS) {
    assert(!/^n[ãa]o\s/i.test(r.trim()), `item do negative prompt está escrito como regra negada: "${r}"`);
  }
  for (const r of RESTRICOES_IMAGEM_PRINCIPAL) {
    assert(!/^n[ãa]o\s/i.test(r.trim()), `item do negative prompt está escrito como regra negada: "${r}"`);
  }
});

t("16. DEFEITO 3: o prompt declara as fotos como fonte factual do produto", () => {
  const prompts = montarPromptsFinais(plano(4), VV, cfg());
  for (const p of prompts) {
    assert(p.promptTexto.includes(INSTRUCAO_FIDELIDADE_PRODUTO),
      "todo prompt precisa carregar a instrução de fidelidade");
    assert(p.promptTexto.indexOf(INSTRUCAO_FIDELIDADE_PRODUTO) === 0,
      "a fidelidade precisa vir ANTES da cena — senão o modelo já começou a compor");
  }
  assert(/fonte factual/i.test(INSTRUCAO_FIDELIDADE_PRODUTO), "faltou declarar as referências como fonte factual");
  assert(/marca|logotipo|rótulo/i.test(INSTRUCAO_FIDELIDADE_PRODUTO), "faltou nomear o que preservar");
});

t("17. marca e textos impressos são nomeados no prompt, para poderem ser preservados", () => {
  const p = montarPromptsFinais(plano(1), VV, cfg({ quantidadeSolicitada: 1 }))[0];
  assert(p.promptTexto.includes("MUNDIAL"), "texto impresso não foi nomeado");
  assert(p.promptTexto.includes('marca "Mundial"'), "a marca não foi nomeada para preservação");
});

t("18. texto impresso no produto não é tratado como proibição", () => {
  // `naoConfirmado` vira lista de proibição; texto da embalagem ali
  // mandava o gerador apagar a marca real.
  assert(!VV.naoConfirmado.includes("MUNDIAL"), "texto impresso não pode estar em naoConfirmado");
  const texto = montarPromptGeracaoPromptsImagem(montarEntradaPromptsImagem(VV), cfg());
  // Ancora no CABEÇALHO da lista, não na primeira ocorrência do termo:
  // "NÃO CONFIRMADO" também aparece nas regras invioláveis, bem antes.
  const secaoProibida = texto.slice(texto.indexOf("NÃO CONFIRMADO — proibido"));
  assert(!secaoProibida.includes("MUNDIAL"), "a marca apareceu na seção de proibições");
  assert(/PRESERVAR/.test(texto), "faltou a seção de identidade a preservar");
});

t("19. texto NOVO continua proibido (o modelo de imagem erra ortografia)", () => {
  const p = montarPromptsFinais(plano(1), VV, cfg({ quantidadeSolicitada: 1 }))[0];
  assert(/não acrescente nenhum texto novo/i.test(p.promptTexto), "faltou proibir texto novo");
  assert(p.textosPermitidos.length === 0, "nenhum texto pode ser autorizado dentro da imagem ainda");
  assert(/texto inventado/.test(p.negativePrompt), "o negative prompt deveria barrar texto inventado");
});

console.log("\n[estratégia comercial e principal vs secundárias]");

t("20. o planejador é obrigado a dar função DIFERENTE a cada imagem", () => {
  const texto = montarPromptGeracaoPromptsImagem(montarEntradaPromptsImagem(VV), cfg());
  assert(/PLANEJAMENTO COMERCIAL/.test(texto), "faltou a seção de estratégia comercial");
  assert(/fun[çc][ãa]o DIFERENTE/i.test(texto), "faltou exigir funções diferentes entre as imagens");
  assert(/o que a imagem VENDE/i.test(texto), "faltou separar razão comercial de descrição de cena");
});

t("21. a capa tem restrições próprias; as secundárias, não", () => {
  const prompts = montarPromptsFinais(plano(4), VV, cfg());
  const capa = prompts.find(p => p.principal)!;
  const secundaria = prompts.find(p => !p.principal)!;
  assert(capa.negativePrompt.includes("pessoa, mão ou modelo humano"),
    "a capa deveria barrar pessoa/mão");
  assert(!secundaria.negativePrompt.includes("pessoa, mão ou modelo humano"),
    "imagem secundária não pode herdar a restrição da capa — 'produto em uso' quase sempre pede uma mão");
  assert(prompts.filter(p => p.principal).length === 1, "deve haver exatamente 1 principal");
});

t("22. tipos comerciais liberados; `medidas` segue fora até haver camada gráfica", () => {
  const tipos = calcularTiposPermitidos(VV);
  assert(tipos.includes("promocional_secundaria"), "faltou o tipo que dá variedade comercial");
  assert(tipos.includes("beneficios"), "benefício MOSTRADO (não escrito) deveria ser permitido");
  assert(!(TIPOS_IMAGEM_SUPORTADOS as readonly string[]).includes("medidas"),
    "`medidas` exige numeral desenhado — depende da camada gráfica");
});

t("23. sem uso nem característica confirmada, `beneficios` não é oferecido", () => {
  const pobre: VerdadeVisual = { ...VV, usosConfirmados: [], caracteristicasDoProduto: [], componentesDoProduto: [] };
  assert(!calcularTiposPermitidos(pobre).includes("beneficios"),
    "sem base confirmada, benefício viraria alegação inventada");
});

console.log("\n[segurança]");

t("24. nada nesta mudança cria publicação, anúncio ou POST /items", () => {
  const fontes = [
    "lib/estudio-anuncios/geracao-prompts-imagem.ts",
    "lib/estudio-anuncios/geracao-prompts-imagem-tipos.ts",
    "app/(app)/central-ia/estudio-anuncios/[projetoId]/DirecaoCriativa.tsx",
    "supabase/migrations/20260904_direcao_criativa_estudio.sql",
  ];
  for (const f of fontes) {
    const src = fs.readFileSync(path.join(process.cwd(), f), "utf-8");
    assert(!/POST \/items|api\.mercadolibre|publicacao-ml|portao-ml/i.test(src),
      `${f} introduziu caminho de publicação`);
  }
});

t("25. a migration é idempotente e não destrói dado existente", () => {
  const sql = fs.readFileSync(
    path.join(process.cwd(), "supabase/migrations/20260904_direcao_criativa_estudio.sql"), "utf-8");
  assert(/ADD COLUMN IF NOT EXISTS/.test(sql), "as colunas precisam ser idempotentes");
  // Sem os comentários: o cabeçalho explica POR QUE a RPC de criação não
  // muda e cita "UPDATE" em prosa. Comentário não executa SQL.
  const executavel = sql.replace(/^\s*--.*$/gm, " ");
  assert(!/DROP COLUMN|DELETE FROM|TRUNCATE|UPDATE/i.test(executavel), "a migration não pode destruir dado");
  // DROP CONSTRAINT IF EXISTS antes de ADD é o que a torna re-executável.
  assert(/DROP CONSTRAINT IF EXISTS/.test(sql), "os CHECKs precisam ser re-executáveis");
});

console.log(`\n=== RESULTADO: ${ok} passaram, ${falhou} falharam ===\n`);
if (falhou > 0) process.exit(1);
