/**
 * Testes do formulário de dados de publicação (Mercado Livre).
 *
 * ── O defeito que originou estes testes ─────────────────────────────
 * O parecer de compliance listava o que faltava para publicar — inclusive
 * EAN/GTIN e atributos obrigatórios da categoria — mas a tela **não tinha
 * onde preencher**. `ml_atributo_obrigatorio_ausente` é BLOQUEIO, então o
 * fluxo travava num requisito que a interface não permitia atender. Nas
 * palavras do usuário: "os erros não têm onde eu preencher".
 *
 * A causa foi validar o sistema pelos caminhos de script/API, onde os
 * campos eram preenchidos por PATCH — nunca pela tela, que é o caminho
 * real de quem usa.
 *
 * O teste 6 é o mais importante: ele cruza TODOS os códigos de bloqueio
 * do compliance com a capacidade da interface de atendê-los. Um bloqueio
 * novo sem campo correspondente reprova — que é exatamente a classe de
 * defeito que passou despercebida.
 *
 * O formulário é um componente React de client. Sem runner de DOM no
 * projeto, a verificação é por LEITURA da fonte — a mesma convenção de
 * `testar-cron-sync.ts`.
 *
 * Uso: npx tsx scripts/testar-formulario-publicacao.ts
 */
import fs from "node:fs";
import path from "node:path";
import { CODIGOS_REGRAS_ML } from "../lib/estudio-anuncios/compliance/mercado-livre";

let ok = 0, falhou = 0;
async function t(nome: string, fn: () => void | Promise<void>) {
  try { await fn(); ok++; console.log(`  PASS  ${nome}`); }
  catch (e: any) { falhou++; console.log(`  FALHA ${nome} -> ${e?.message ?? e}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

const FORM = path.join(process.cwd(),
  "app/(app)/central-ia/estudio-anuncios/[projetoId]/DadosPublicacao.tsx");
const FONTE = fs.readFileSync(FORM, "utf-8");
const CODIGO = FONTE.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
const REGRAS = fs.readFileSync(path.join(process.cwd(),
  "lib/estudio-anuncios/compliance/mercado-livre.ts"), "utf-8");

async function rodar() {
  console.log("\n[formulário de publicação — atributos]");

  await t("1. existe campo de entrada para atributos, não só um texto informativo", () => {
    // O defeito exato: o bloco listava `atributosObrigatorios` num <p> e
    // parava por aí. Se isto voltar, o fluxo trava de novo.
    assert(/camposAtributos\.map/.test(CODIGO), "os atributos deveriam virar campos, um por atributo");
    assert(/setAtributos/.test(CODIGO), "os campos precisam ser editáveis");
    assert(!/Marca e modelo vêm da ficha do produto/.test(FONTE),
      "voltou o texto que dizia que marca/modelo vinham de outro lugar, sem campo na tela");
  });

  await t("2. todo atributo exigido pela categoria vira campo", () => {
    const bloco = CODIGO.slice(CODIGO.indexOf("const camposAtributos"), CODIGO.indexOf("async function salvarDados"));
    assert(/for \(const a of canal\.atributosObrigatorios\)/.test(bloco),
      "a lista de campos precisa partir dos atributos exigidos pela categoria");
    assert(/for \(const a of canal\.atributos\)/.test(bloco),
      "atributos já gravados fora da categoria atual precisam continuar editáveis — senão " +
      "trocar de categoria esconderia um valor que continua sendo enviado");
  });

  await t("3. GTIN/EAN, marca, modelo e SKU estão sempre disponíveis", () => {
    const universais = CODIGO.slice(CODIGO.indexOf("ATRIBUTOS_UNIVERSAIS"), CODIGO.indexOf("EXEMPLO_ATRIBUTO"));
    for (const id of ["BRAND", "MODEL", "GTIN", "SELLER_SKU"]) {
      assert(new RegExp(`id: "${id}"`).test(universais), `falta o atributo universal ${id}`);
    }
    // O compliance lê GTIN e SKU de `atributosInformados` (compliance.ts),
    // então o id precisa bater exatamente com o que ele procura.
    const compliance = fs.readFileSync(path.join(process.cwd(),
      "lib/estudio-anuncios/compliance/compliance.ts"), "utf-8");
    assert(/=== "GTIN"/.test(compliance) && /=== "SELLER_SKU"/.test(compliance),
      "os ids usados pela tela precisam ser os mesmos que o compliance procura");
  });

  await t("4. o formulário envia os atributos no PATCH", () => {
    assert(/corpo\.atributos = atributosLimpos/.test(CODIGO), "os atributos precisam entrar no corpo");
    // A chave precisa ser aceita pelo backend, senão o PATCH é recusado.
    const config = fs.readFileSync(path.join(process.cwd(),
      "lib/estudio-anuncios/compliance/configuracao-marketplace.ts"), "utf-8");
    const permitidas = config.slice(config.indexOf("CHAVES_PERMITIDAS"), config.indexOf("]);"));
    assert(/"atributos"/.test(permitidas), "o backend não aceita a chave `atributos`");
  });

  await t("5. campo em branco não vira atributo vazio", () => {
    // O backend recusa value_name vazio ("Atributo X sem valor"), e um
    // atributo vazio seria "preenchido" falso no parecer.
    assert(/\.filter\(a => a\.value_name !== ""\)/.test(CODIGO),
      "valores em branco precisam ser removidos antes do envio");
    assert(/value_name: valor\.trim\(\)/.test(CODIGO), "o valor precisa ser aparado");
    assert(/maxLength=\{255\}/.test(CODIGO), "o campo precisa respeitar o limite do backend");
  });

  console.log("\n[formulário de publicação — cobertura dos bloqueios]");

  await t("6. TODO bloqueio do compliance tem como ser resolvido pela tela", () => {
    /**
     * Onde cada bloqueio se resolve. `null` = não é um campo deste
     * formulário, com a justificativa de onde a pessoa resolve.
     * Adicionar bloqueio novo sem decidir isto reprova o teste — de
     * propósito.
     */
    const ONDE_RESOLVER: Record<string, RegExp | null> = {
      // Resolvidos em OUTRAS telas do Estúdio, que já existem.
      ml_conteudo_nao_aprovado: null,      // aprovação de conteúdo
      ml_titulo_ausente: null,             // etapa de conteúdo
      ml_titulo_acima_do_limite: null,     // etapa de conteúdo
      ml_descricao_acima_do_limite: null,  // etapa de conteúdo
      ml_sem_imagem: null,                 // etapa de imagens
      ml_imagem_sem_arquivo: null,
      ml_imagem_formato_invalido: null,
      ml_imagem_acima_do_tamanho: null,
      ml_imagem_abaixo_da_resolucao_minima: null,
      ml_sem_imagem_valida_para_envio: null,
      ml_conta_nao_vinculada: null,        // vínculo de conta (OAuth)
      ml_modelo_publicacao_nao_resolvido: null,
      ml_moeda_indefinida_para_categoria: null, // derivada da categoria
      ml_tipo_anuncio_nao_disponivel_na_conta: null,
      ml_atributos_obrigatorios_nao_verificaveis: null,
      ml_categoria_nao_folha: null,
      ml_categoria_nao_permite_publicacao: null,

      // Resolvidos NESTE formulário — cada um precisa de campo.
      ml_categoria_nao_resolvida: /setBusca|buscarCategoria|sugestoes/,
      ml_preco_nao_informado: /setPreco/,
      ml_estoque_nao_informado: /setEstoque/,
      ml_condicao_nao_definida: /setCondicao/,
      ml_condicao_invalida_para_categoria: /setCondicao/,
      ml_tipo_anuncio_nao_definido: /setTipo/,
      ml_tipo_anuncio_invalido: /setTipo/,
      ml_family_name_nao_informado: /setFamilia/,
      ml_family_name_excede_limite: /setFamilia/,
      ml_peso_embalagem_nao_informado: /setPesoEmb/,
      ml_altura_embalagem_nao_informada: /setAlturaEmb/,
      ml_largura_embalagem_nao_informada: /setLarguraEmb/,
      ml_comprimento_embalagem_nao_informado: /setComprimentoEmb/,
      ml_embalagem_medida_nao_inteira: /deve ser um número inteiro/,
      // O que estava faltando e travava tudo:
      ml_atributo_obrigatorio_ausente: /camposAtributos\.map/,
    };

    // Bloqueios realmente emitidos pelo validador, lidos da fonte.
    const emitidos = new Set(
      [...REGRAS.matchAll(/anota\(\s*"(ml_[a-z_]+)"[^;]*?"bloqueio"/g)].map(m => m[1])
    );
    assert(emitidos.size > 10, `poucos bloqueios encontrados (${emitidos.size}) — a leitura da fonte quebrou`);

    const semDecisao = [...emitidos].filter(c => !(c in ONDE_RESOLVER));
    assert(semDecisao.length === 0,
      `bloqueio(s) sem decisão de onde resolver: ${semDecisao.join(", ")}. ` +
      `Se for campo desta tela, adicione o campo; se não, documente aqui onde a pessoa resolve.`);

    const semCampo = [...emitidos].filter(c => {
      const padrao = ONDE_RESOLVER[c];
      return padrao !== null && !padrao.test(CODIGO);
    });
    assert(semCampo.length === 0,
      `bloqueio(s) que a tela deveria resolver mas não tem campo: ${semCampo.join(", ")}`);
  });

  await t("7. os códigos usados aqui existem de verdade no compliance", () => {
    // Guarda contra o teste 6 virar decorativo por causa de código renomeado.
    for (const codigo of ["ml_atributo_obrigatorio_ausente", "ml_preco_nao_informado", "ml_gtin_nao_informado"]) {
      assert((CODIGOS_REGRAS_ML as readonly string[]).includes(codigo),
        `${codigo} não existe mais no catálogo de regras — atualize este teste`);
    }
  });

  console.log("\n[formulário de publicação — não regride o que já funcionava]");

  await t("8. atributos só são enviados quando mudaram", () => {
    assert(/JSON\.stringify\(atributosLimpos\) !== JSON\.stringify\(atributosAtuais\)/.test(CODIGO),
      "enviar sempre faria 'Nada para salvar' nunca acontecer");
    assert(/Nada para salvar/.test(CODIGO), "a checagem de corpo vazio deveria continuar existindo");
  });

  await t("9. medidas de embalagem continuam sem arredondamento silencioso", () => {
    assert(/o Mercado Livre não aceita casas decimais aqui/.test(FONTE),
      "a recusa explícita de decimais sumiu — arredondar publicaria caixa que ninguém mediu");
    assert(!/Math\.round|toFixed\(0\)/.test(CODIGO), "há arredondamento automático no formulário");
  });

  await t("10. o preço continua convertido por string, sem parseFloat", () => {
    assert(!/parseFloat/.test(CODIGO), "parseFloat em preço perde centavo");
    assert(/textoParaCentavos/.test(CODIGO), "a conversão exata deveria continuar em uso");
  });

  console.log(`\n${falhou === 0 ? "TODOS OS TESTES PASSARAM" : "HÁ FALHAS"} — ${ok} ok, ${falhou} falha(s)\n`);
  if (falhou > 0) process.exit(1);
}

rodar();
