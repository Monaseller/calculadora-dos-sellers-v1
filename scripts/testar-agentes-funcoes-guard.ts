/**
 * CDS IA — TOOL-REGISTRY-B1. Suite do guard de autorizacao de Funcoes.
 *
 * Prova por EXECUCAO da funcao pura. Leitura de fonte so onde a garantia
 * e estrutural (ausencia de I/O, ausencia de `tipo` do agente), e sempre
 * com CONTROLE NEGATIVO — um grep que nunca poderia falhar nao prova
 * nada.
 *
 * O caso que define este gate esta em C: `aprovacao` NAO executa. Nivel
 * intermediario nao e permissao fraca; e interrupcao.
 *
 * Rodar:  npx tsx scripts/testar-agentes-funcoes-guard.ts
 * Sem rede, sem banco, sem IA, sem escrita.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CODIGOS_NEGACAO,
  ESTADOS_RECUSA,
  autorizarFuncao,
  type CodigoNegacao,
  type EntradaGuard,
  type ResultadoGuard,
} from "../lib/agentes/funcoes/guard";
import type { FatoConexao, FatoFuncao, FatoPermissao } from "../lib/ia/skills/diagnostico";

let passou = 0;
let falhou = 0;

function ok(nome: string, condicao: boolean, detalhe = ""): void {
  if (condicao) {
    passou++;
  } else {
    falhou++;
    console.error(`  x ${nome}${detalhe ? `  · ${detalhe}` : ""}`);
  }
}

function secao(titulo: string): void {
  console.log(`\n── ${titulo}`);
}

const RAIZ = join(__dirname, "..");
const fonte = (rel: string) => readFileSync(join(RAIZ, rel), "utf8");
const semComentarios = (t: string) =>
  t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

// ─── Construtores de fato ─────────────────────────────────────────────

const ID = "vendas.consultar";

const F = (id: string, existe = true): FatoFuncao => ({ id, existe });
const P = (funcaoId: string, nivel: FatoPermissao["nivel"]): FatoPermissao => ({ funcaoId, nivel });
const C = (
  plataforma: string,
  recurso: string,
  estado: FatoConexao["estado"] = "conectada",
  cobertura: FatoConexao["cobertura"] = "confirmada"
): FatoConexao => ({ plataforma, recurso, estado, cobertura });

const REQ = { plataforma: "shopee", recurso: "chat" } as const;

const entrada = (p: Partial<EntradaGuard> = {}): EntradaGuard => ({
  funcaoId: ID,
  conexaoNecessaria: null,
  funcoes: [F(ID)],
  permissoes: [P(ID, "automatico")],
  conexoes: [],
  ...p,
});

const negou = (r: ResultadoGuard, codigo: CodigoNegacao) =>
  r.permitido === false && r.estado === "negado" && r.codigo === codigo;

// ─── A. Catalogo real ─────────────────────────────────────────────────

secao("A. vendas.consultar no catalogo real");
{
  // O registry e `server-only` e alcanca a service_role por
  // transitividade — importa-lo aqui exigiria banco. A garantia e
  // estrutural, entao a fonte basta, COM controle negativo.
  const bruta = fonte("lib/agentes/funcoes/registry.ts");
  const src = semComentarios(bruta);

  ok("A1  o catalogo declara vendas.consultar", src.includes('"vendas.consultar"'));
  ok("A2  a entrada tem executor", /executor:\s*executarVendasConsultar/.test(src));
  ok("A3  acesso e leitura", /acesso:\s*"leitura"/.test(src));
  ok("A4  idempotente e true", /idempotente:\s*true/.test(src));
  ok("A5  conexaoNecessaria e null", /conexaoNecessaria:\s*null/.test(src));
  ok(
    "A6  DefinicaoFuncao tem os tres campos operacionais",
    /interface DefinicaoFuncao\s*\{[\s\S]*?acesso[\s\S]*?idempotente[\s\S]*?conexaoNecessaria[\s\S]*?\}/.test(src)
  );

  // Controle negativo: o catalogo NAO ganhou apresentacao nem binding.
  ok("A7  catalogo nao declara risco", !/\brisco\s*:/.test(src));
  ok("A8  catalogo nao declara rotulo/descricao", !/\b(rotulo|descricao)\s*:/.test(src));
  ok("A9  catalogo nao declara workflowId/settingsHash", !/(workflowId|settingsHash)/.test(src));
  ok("A10 controle: o grep le o arquivo real", bruta.length > 1000 && src.includes("FUNCOES"));
  ok("A11 controle: o grep reprovaria id ausente", !src.includes('"cds.ml.consultar_pedido"'));
}

// ─── B. Existencia ────────────────────────────────────────────────────

secao("B. existencia antes de tudo");
{
  ok("B1  id desconhecido nega", negou(autorizarFuncao(entrada({ funcaoId: "nao.existe", funcoes: [] })), "funcao_inexistente"));
  ok("B2  fato existe:false nega", negou(autorizarFuncao(entrada({ funcoes: [F(ID, false)] })), "funcao_inexistente"));
  ok("B3  lista de funcoes vazia nega", negou(autorizarFuncao(entrada({ funcoes: [] })), "funcao_inexistente"));
  ok("B4  id nao-string nega", negou(autorizarFuncao(entrada({ funcaoId: 42 })), "funcao_inexistente"));
  ok("B5  id vazio nega", negou(autorizarFuncao(entrada({ funcaoId: "" })), "funcao_inexistente"));
  ok("B6  id null nega", negou(autorizarFuncao(entrada({ funcaoId: null })), "funcao_inexistente"));

  // A ORDEM importa: Funcao inexistente com permissao bloqueada reporta
  // inexistencia, nao bloqueio. Reportar bloqueio mandaria o dono
  // liberar uma ferramenta que nao existe.
  ok(
    "B7  inexistente + bloqueado reporta INEXISTENTE",
    negou(autorizarFuncao(entrada({ funcoes: [F(ID, false)], permissoes: [P(ID, "bloqueado")] })), "funcao_inexistente")
  );
  // Controle negativo do proprio caso B7.
  ok(
    "B8  controle: existente + bloqueado reporta BLOQUEADO",
    negou(autorizarFuncao(entrada({ permissoes: [P(ID, "bloqueado")] })), "permissao_bloqueada")
  );
}

// ─── C. Permissao e aprovacao ─────────────────────────────────────────

secao("C. permissao");
{
  ok("C1  permissao ausente nega", negou(autorizarFuncao(entrada({ permissoes: [] })), "permissao_ausente"));
  ok(
    "C2  permissao de OUTRA funcao nao serve",
    negou(autorizarFuncao(entrada({ permissoes: [P("outra.coisa", "automatico")] })), "permissao_ausente")
  );
  ok("C3  bloqueado nega", negou(autorizarFuncao(entrada({ permissoes: [P(ID, "bloqueado")] })), "permissao_bloqueada"));

  const apr = autorizarFuncao(entrada({ permissoes: [P(ID, "aprovacao")] }));
  ok("C4  aprovacao NAO permite", apr.permitido === false);
  ok("C5  aprovacao devolve aguardando_aprovacao", apr.permitido === false && apr.estado === "aguardando_aprovacao");
  ok("C6  aprovacao devolve aprovacao_necessaria", apr.permitido === false && apr.codigo === "aprovacao_necessaria");
  ok("C7  aprovacao NAO e negado", apr.permitido === false && apr.estado !== "negado");

  const aut = autorizarFuncao(entrada());
  ok("C8  automatico permite quando o resto esta ok", aut.permitido === true);
  ok("C9  o ramo permitido devolve o id estreitado", aut.permitido === true && aut.funcaoId === ID);

  // `aprovacao` interrompe ANTES da conexao: nao promete que o resto
  // esta pronto. Aqui a conexao exigida esta AUSENTE e ainda assim o
  // codigo e de aprovacao, nao de conexao.
  const aprSemConexao = autorizarFuncao(
    entrada({ permissoes: [P(ID, "aprovacao")], conexaoNecessaria: REQ, conexoes: [] })
  );
  ok("C10 aprovacao precede conexao", aprSemConexao.permitido === false && aprSemConexao.codigo === "aprovacao_necessaria");
  // Controle negativo: com automatico, a mesma entrada acusa conexao.
  ok(
    "C11 controle: automatico na mesma entrada acusa conexao",
    negou(autorizarFuncao(entrada({ conexaoNecessaria: REQ, conexoes: [] })), "conexao_ausente")
  );
}

// ─── D. Conexao ───────────────────────────────────────────────────────

secao("D. conexao");
{
  ok(
    "D1  conexao exigida e ausente nega",
    negou(autorizarFuncao(entrada({ conexaoNecessaria: REQ, conexoes: [] })), "conexao_ausente")
  );
  ok(
    "D2  conexao exigida e presente permite",
    autorizarFuncao(entrada({ conexaoNecessaria: REQ, conexoes: [C("shopee", "chat")] })).permitido === true
  );
  ok(
    "D3  funcao sem requisito NAO e bloqueada por falta de conexao",
    autorizarFuncao(entrada({ conexaoNecessaria: null, conexoes: [] })).permitido === true
  );
  ok(
    "D4  plataforma diferente nao serve",
    negou(autorizarFuncao(entrada({ conexaoNecessaria: REQ, conexoes: [C("mercado_livre", "chat")] })), "conexao_ausente")
  );
  ok(
    "D5  recurso diferente nao serve",
    negou(autorizarFuncao(entrada({ conexaoNecessaria: REQ, conexoes: [C("shopee", "anuncios")] })), "conexao_ausente")
  );
  ok(
    "D6  conexao expirada nao serve",
    negou(autorizarFuncao(entrada({ conexaoNecessaria: REQ, conexoes: [C("shopee", "chat", "expirada")] })), "conexao_ausente")
  );
  ok(
    "D7  conexao desconectada nao serve",
    negou(autorizarFuncao(entrada({ conexaoNecessaria: REQ, conexoes: [C("shopee", "chat", "desconectada")] })), "conexao_ausente")
  );
  ok(
    "D8  conexao em erro nao serve",
    negou(autorizarFuncao(entrada({ conexaoNecessaria: REQ, conexoes: [C("shopee", "chat", "erro")] })), "conexao_ausente")
  );
  // Cobertura `ausente`: ha EVIDENCIA de que nao cobre o recurso.
  ok(
    "D9  cobertura ausente nega mesmo conectada",
    negou(
      autorizarFuncao(entrada({ conexaoNecessaria: REQ, conexoes: [C("shopee", "chat", "conectada", "ausente")] })),
      "conexao_ausente"
    )
  );

  // O caso que o B1R reprovou. `nao_verificavel` significa "a CDS nao
  // tem como saber se a conta cobre este recurso" — e desconhecido NAO
  // autoriza capacidade. Alinhado com `diagnostico.ts`, que para
  // requisito obrigatorio ja trata este fato como bloqueio.
  //
  // Este e o caso REAL: `coberturaDoRecurso()` retorna `nao_verificavel`
  // para todo recurso hoje. Se ele permitisse, a checagem de cobertura
  // seria inerte na pratica.
  ok(
    "D10 cobertura nao_verificavel NEGA (fail-closed)",
    negou(
      autorizarFuncao(
        entrada({ conexaoNecessaria: REQ, conexoes: [C("shopee", "chat", "conectada", "nao_verificavel")] })
      ),
      "conexao_ausente"
    )
  );

  // Somente `confirmada` satisfaz. Explicito, e nao por default do
  // helper: sem este caso, `conexaoServe` poderia negar tudo e a suite
  // continuaria verde.
  ok(
    "D11 somente cobertura confirmada permite",
    autorizarFuncao(entrada({ conexaoNecessaria: REQ, conexoes: [C("shopee", "chat", "conectada", "confirmada")] }))
      .permitido === true
  );

  // Controle negativo do proprio D11: mesma conexao, mesma cobertura,
  // estado invalido — para provar que D11 passa pela cobertura E pelo
  // estado, nao por um `return true` escondido.
  ok(
    "D12 controle: confirmada + expirada continua negando",
    negou(
      autorizarFuncao(entrada({ conexaoNecessaria: REQ, conexoes: [C("shopee", "chat", "expirada", "confirmada")] })),
      "conexao_ausente"
    )
  );

  // Consequencia aceita, provada por execucao: com a cobertura que o
  // sistema REALMENTE produz hoje, uma Funcao com requisito de conexao
  // nao roda — e uma sem requisito roda.
  ok(
    "D13 com a cobertura real de hoje, requisito de conexao bloqueia",
    negou(
      autorizarFuncao(
        entrada({ conexaoNecessaria: REQ, conexoes: [C("shopee", "chat", "conectada", "nao_verificavel")] })
      ),
      "conexao_ausente"
    ) && autorizarFuncao(entrada({ conexaoNecessaria: null })).permitido === true
  );
}

// ─── E. O que NAO participa da decisao ────────────────────────────────

secao("E. tipo do agente e apresentacao ficam fora");
{
  const src = semComentarios(fonte("lib/agentes/funcoes/guard.ts"));

  // `EntradaGuard` nao tem onde caber um `tipo` — a garantia e a
  // ausencia do campo, nao uma checagem em runtime.
  ok("E1  guard nao le tipo de agente", !/\btipo\b\s*[:.]/.test(src));
  ok("E2  guard nao importa FuncaoUI", !src.includes("FuncaoUI"));
  ok("E3  guard nao ramifica por risco", !/\brisco\b/.test(src));
  ok("E4  guard nao conhece agentes.tipo", !/TipoAgente|TIPOS_AGENTE/.test(src));

  // Pureza estrutural.
  ok("E5  sem supabase", !/supabase|Supabase/.test(src));
  ok("E6  sem fetch", !/\bfetch\s*\(/.test(src));
  ok("E7  sem process.env", !/process\.env/.test(src));
  ok("E8  sem filesystem", !/node:fs|readFileSync/.test(src));
  ok("E9  sem server-only", !src.includes('"server-only"'));
  ok("E10 sem throw para negacao", !/\bthrow\b/.test(src));

  // Controle negativo de TODA a varredura acima: se o grep estivesse
  // olhando o arquivo errado ou vazio, isto reprovaria.
  ok("E11 controle: a fonte lida e a do guard", src.includes("autorizarFuncao") && src.length > 500);
  ok("E12 controle: o grep de fetch acharia se houvesse", /\bfetch\s*\(/.test("await fetch(url)"));
}

// ─── F. Contrato dos codigos ──────────────────────────────────────────

secao("F. codigos estaveis");
{
  const esperados = [
    "funcao_inexistente",
    "permissao_ausente",
    "permissao_bloqueada",
    "aprovacao_necessaria",
    "conexao_ausente",
  ];
  ok("F1  os cinco codigos existem", esperados.every((c) => (CODIGOS_NEGACAO as readonly string[]).includes(c)));
  ok("F2  nao ha codigo extra", CODIGOS_NEGACAO.length === esperados.length);
  ok("F3  dois estados de recusa", ESTADOS_RECUSA.length === 2);
  ok(
    "F4  os estados sao negado e aguardando_aprovacao",
    (ESTADOS_RECUSA as readonly string[]).includes("negado") &&
      (ESTADOS_RECUSA as readonly string[]).includes("aguardando_aprovacao")
  );

  // Todo caminho de recusa produz codigo do contrato — varredura real,
  // nao inspecao de tipo.
  const recusas: ResultadoGuard[] = [
    autorizarFuncao(entrada({ funcoes: [] })),
    autorizarFuncao(entrada({ permissoes: [] })),
    autorizarFuncao(entrada({ permissoes: [P(ID, "bloqueado")] })),
    autorizarFuncao(entrada({ permissoes: [P(ID, "aprovacao")] })),
    autorizarFuncao(entrada({ conexaoNecessaria: REQ, conexoes: [] })),
  ];
  ok(
    "F5  toda recusa usa codigo do contrato",
    recusas.every((r) => r.permitido === false && (CODIGOS_NEGACAO as readonly string[]).includes(r.codigo))
  );
  ok("F6  as cinco recusas realmente recusaram", recusas.every((r) => r.permitido === false));
  ok("F7  os cinco codigos sao distintos", new Set(recusas.map((r) => (r.permitido === false ? r.codigo : ""))).size === 5);

  // Fail closed: so UMA combinacao permite, e ela e a completa.
  ok("F8  o caso feliz e o unico que permite", autorizarFuncao(entrada()).permitido === true);
}

// ─── Placar ───────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(66)}`);
console.log(`  ${passou}/${passou + falhou} passaram` + (falhou > 0 ? `  ·  ${falhou} FALHARAM` : ""));
console.log(`${"═".repeat(66)}\n`);
process.exit(falhou > 0 ? 1 : 0);
