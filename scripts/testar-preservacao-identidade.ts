/**
 * Testes da distinção PRESERVAR identidade existente × CRIAR texto novo
 * (2026-09-05).
 *
 * ── A falha real que originou estes testes ──────────────────────────
 * Primeiro E2E da nova arquitetura de criativos, projeto "Cacau shows"
 * (b6d899ab). As quatro etapas anteriores concluíram com provedores
 * reais — google, google, anthropic, google — e `geracao_prompts_imagem`
 * morreu 3/3 com:
 *
 *   imagem 1 (capa_principal): usou termo proibido em prompt de imagem ("rotulo").
 *
 * A contradição era nossa. A instrução do vendedor pedia "preservar
 * perfeitamente todas as embalagens, marcas e rótulos", e a arquitetura
 * de 2026-09-04 passou a EXIGIR que o planejador instruísse preservação
 * de identidade. Ele obedeceu. A validação, que olhava só a PALAVRA,
 * rejeitou.
 *
 * Enquanto a v1 proibia todo texto na imagem, banir o substantivo
 * equivalia a banir a intenção. Deixou de ser verdade: o mesmo
 * substantivo agora carrega duas intenções opostas.
 *
 *   (A) "preservar o rótulo original"   -> deve PASSAR
 *   (B) "adicionar um selo promocional"  -> deve ser REJEITADO
 *
 * NENHUMA chamada de IA acontece aqui — validação é função pura.
 *
 * Uso: npx tsx scripts/testar-preservacao-identidade.ts
 */
import {
  validarIntegridadePromptsImagem,
  montarConfiguracao,
  montarEntradaPromptsImagem,
  segmentarTrechos,
  RESTRICOES_PROMPTS_IMAGEM,
} from "../lib/estudio-anuncios/geracao-prompts-imagem";
import type { VerdadeVisual, PromptsImagemIA } from "../lib/estudio-anuncios/geracao-prompts-imagem-tipos";

let ok = 0, falhou = 0;
function t(nome: string, fn: () => void) {
  try { fn(); ok++; console.log(`  PASS  ${nome}`); }
  catch (e: any) { falhou++; console.log(`  FALHA ${nome} -> ${e?.message ?? e}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

/** Verdade visual do caso real: esmalte com marca e textos impressos. */
const VV: VerdadeVisual = {
  produtoIdentificado: "Kit de esmaltes",
  marca: "Impala", modelo: "Cacau Show",
  categoria: ["Beleza", "Unhas"],
  resumoVisual: "Cinco vidros de esmalte em tons marrons com tampa preta",
  coresDoProduto: ["marrom", "preto"],
  materiaisDoProduto: ["vidro"],
  componentesDoProduto: ["tampa", "pincel"],
  caracteristicasDoProduto: ["acabamento cremoso"],
  usosConfirmados: ["pintar as unhas"],
  publicoConfirmado: ["adulto"],
  itensDaEmbalagem: ["caixa de papelao"],
  textosImpressosNoProduto: ["IMPALA", "CACAU SHOW", "8ml"],
  naoConfirmado: ["dura 10 dias"],
};

const ENTRADA_BASE = () => montarEntradaPromptsImagem(VV);
const CONFIG = montarConfiguracao({
  quantidadeSolicitada: 1, estilo: null, modo: "rapido",
  marketplaces: ["ML"], verdadeVisual: VV,
});

const ENTRADA = ENTRADA_BASE();

/** Plano de 1 imagem com o campo sob teste. */
function planoCom(campo: "objetivo" | "cena" | "elementosObrigatorios", texto: string): PromptsImagemIA {
  const base: any = {
    ordem: 1, tipo: "capa_principal",
    objetivo: "apresentar o kit", cena: "kit sobre superficie neutra",
    enquadramento: "produto_inteiro", fundo: "cinza claro", iluminacao: "difusa",
    elementosObrigatorios: ["tampa"], elementosProibidos: ["fundo poluido"],
  };
  base[campo] = campo === "elementosObrigatorios" ? [texto] : texto;
  return { imagens: [base] };
}

const valida = (texto: string, campo: "objetivo" | "cena" | "elementosObrigatorios" = "cena") =>
  validarIntegridadePromptsImagem(planoCom(campo, texto), ENTRADA, CONFIG);

console.log("\n[A — identidade JÁ EXISTENTE no produto: deve PASSAR]");

const ACEITOS: [string, string][] = [
  ["preservar rótulo original", "kit com o rotulo original preservado exatamente como esta"],
  ["manter marca original", "composicao mantendo a marca original do produto"],
  ["manter logotipo existente", "produto com o logotipo existente mantido sem alterar"],
  ["preservar textos impressos", "vidros com os textos ja impressos preservados"],
  ["embalagem igual à referência", "embalagem exatamente igual ao original da referencia"],
  ["frase do usuário no E2E real", "preservar perfeitamente todas as embalagens e os rotulos originais"],
  ["números impressos preservados", "numeros impressos no vidro mantidos como estao"],
  ["tipografia original", "tipografia original do rotulo preservada"],
];
for (const [nome, texto] of ACEITOS) {
  t(`aceita: ${nome}`, () => {
    const r = valida(texto);
    assert(r.valido === true, `rejeitado indevidamente: ${(r as any).motivo}`);
  });
}

console.log("\n[B — texto/identidade NOVA: deve ser REJEITADO]");

const REJEITADOS: [string, string][] = [
  ["adicionar texto comercial", "kit com texto adicionado no topo da imagem"],
  ["inventar selo", "produto com um selo criado no canto"],
  ["criar logotipo", "criar um novo logotipo para a marca"],
  ["escrever preço", "escrever o preco promocional sobre a imagem"],
  ["escrever benefício", "incluir palavras descrevendo o beneficio do produto"],
  ["chamada promocional", "inserir chamada promocional em letras grandes"],
  ["novo rótulo", "aplicar um novo rotulo no vidro"],
  ["carimbo inventado", "estampar um carimbo sobre a tampa"],
];
for (const [nome, texto] of REJEITADOS) {
  t(`rejeita: ${nome}`, () => {
    const r = valida(texto);
    assert(r.valido === false, "deveria ter sido rejeitado");
  });
}

console.log("\n[C — a regra é por FRASE, não pelo texto inteiro]");

t("preservar numa frase não libera criar em outra", () => {
  // Sem segmentação, o "preservar" do objetivo autorizaria o
  // "adicionar texto" da cena.
  const plano: any = {
    imagens: [{
      ordem: 1, tipo: "capa_principal",
      objetivo: "preservar o rotulo original do produto",
      cena: "adicionar texto promocional no topo",
      enquadramento: "produto_inteiro", fundo: "cinza", iluminacao: "difusa",
      elementosObrigatorios: ["tampa"], elementosProibidos: [],
    }],
  };
  const r = validarIntegridadePromptsImagem(plano, ENTRADA, CONFIG);
  assert(r.valido === false, "deveria rejeitar: a segunda frase pede criação");
});

t("verbo de criação vence marcador de preservação no mesmo trecho", () => {
  const r = valida("manter o rotulo original e adicionar um novo texto");
  assert(r.valido === false, "creation verb no mesmo trecho precisa rejeitar");
});

t("segmentarTrechos separa por pontuação e conjunção", () => {
  const s = segmentarTrechos(["preservar o rotulo. adicionar texto"]);
  assert(s.length >= 2, `deveria produzir ao menos 2 trechos, veio ${s.length}`);
  assert(s.some(x => x.includes("preservar")) && s.some(x => x.includes("adicionar")),
    "os dois trechos deveriam ser distinguíveis");
});

console.log("\n[D — fail closed: ambiguidade não libera]");

t("menção solta de rótulo, sem intenção declarada, é rejeitada", () => {
  const r = valida("kit com rotulo bem visivel");
  assert(r.valido === false, "menção ambígua deveria ser rejeitada (fail closed)");
  assert(/PRESERVAR/.test((r as any).motivo), `a mensagem deveria orientar a correção: ${(r as any).motivo}`);
});

t("termos promocionais e clínicos seguem proibidos sem exceção", () => {
  for (const texto of [
    "preservar o preco original na etiqueta",
    "manter o banner original do produto",
    "preservar a legenda original",
    "produto que trata a pele, preservando o original",
  ]) {
    assert(valida(texto).valido === false, `deveria rejeitar: "${texto}"`);
  }
});

t("criar marca é rejeitado mesmo com a marca no corpus", () => {
  // "Impala" está em VV.marca, o que libera a MENÇÃO — mas não a criação.
  const r = valida("criar uma nova marca para o produto");
  assert(r.valido === false, "estar no corpus não autoriza inventar identidade");
});

console.log("\n[E — o caso real do E2E não volta]");

t("regressão exata: prompt que quebrou o projeto Cacau shows", () => {
  // Texto no espírito do que o planejador produziu quando instruído a
  // preservar identidade, e que a regra lexical rejeitou.
  const plano: any = {
    imagens: [{
      ordem: 1, tipo: "capa_principal",
      objetivo: "apresentar o kit completo com reconhecimento imediato",
      cena: "os cinco vidros juntos, com marca e rotulo originais preservados exatamente como na referencia",
      enquadramento: "produto_inteiro", fundo: "off-white", iluminacao: "difusa suave",
      elementosObrigatorios: ["tampa preta", "vidros mantidos identicos ao original"],
      elementosProibidos: ["fundo poluido"],
    }],
  };
  const r = validarIntegridadePromptsImagem(plano, ENTRADA, CONFIG);
  assert(r.valido === true, `a regressão voltou: ${(r as any).motivo}`);
});

t("a instrução ao planejador ensina a frasear preservação", () => {
  // Sem isso o modelo escreve "rótulo visível" e cai no fail closed.
  const juntas = (RESTRICOES_PROMPTS_IMAGEM as string[]).join(" ");
  assert(/PRESERVAR/.test(juntas), "faltou ensinar o vocabulário de preservação");
  assert(/verbo de cria/i.test(juntas), "faltou proibir verbo de criação junto de identidade");
});

console.log(`\n=== RESULTADO: ${ok} passaram, ${falhou} falharam ===\n`);
if (falhou > 0) process.exit(1);
