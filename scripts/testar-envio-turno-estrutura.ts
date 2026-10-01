/**
 * AGENT-FACTORY-F7b.4.8.3 — invariantes ESTRUTURAIS do envio e do periodo.
 *
 * Suite PURA: sem rede, sem banco, sem IA, sem provedor.
 *
 * ── O que ela existe para impedir ───────────────────────────────────
 *
 * As suites live provam que funciona. Nao provam que continua sem poder
 * fazer o que lhe e proibido — e parte disso nem tem como ser tentada de
 * fora:
 *
 *   §27  a tela NAO pode dizer "nao foi possivel enviar" sobre um turno
 *        que o servidor aceitou
 *   §28  a fala do usuario e gravada ANTES de o modelo ser chamado
 *   §29  a identidade do envio NAO vem do modelo nem do corpo como
 *        autoridade de dono
 *   §30  reenviar nao roda de novo
 *   §35  o LLM nao inventa data: quem resolve periodo e a CDS
 *   §40  o modo de teste atravessa o MESMO caminho
 *
 * Roda com: npx tsx scripts/testar-envio-turno-estrutura.ts
 */
import "./_server-only-inerte";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DECLARACOES } from "../lib/agentes/ia/ferramentas";
import { resolverExpressaoDePeriodo } from "../lib/agentes/funcoes/periodo-em-texto";

let pass = 0;
let fail = 0;
function ok(nome: string, cond: boolean, detalhe = ""): void {
  if (cond) { pass += 1; console.log(`  PASS  ${nome}`); }
  else { fail += 1; console.log(`  FAIL  ${nome}${detalhe ? `  — ${detalhe}` : ""}`); }
}
function secao(t: string): void { console.log(`\n${t}`); }

function fonte(rel: string): string {
  return readFileSync(join(__dirname, "..", rel), "utf8");
}
/**
 * A fonte SEM comentario.
 *
 * A suite irma aprendeu isso do jeito ruim: uma sonda reprovou por causa
 * de um COMENTARIO que dizia que o proibido nao acontece. Comentario
 * medido como codigo transforma a explicacao em defeito.
 */
function semComentario(texto: string): string {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
}

const CHAT = semComentario(fonte("components/ia/factory/ChatDoAgente.tsx"));
const CHAT_CRU = fonte("components/ia/factory/ChatDoAgente.tsx");
const HTTP = semComentario(fonte("lib/ia/agentes-http.ts"));
const ROTA = semComentario(
  fonte("app/api/agentes/[agenteId]/conversas/[conversaId]/route.ts"));
const RUNTIME = semComentario(fonte("lib/agentes/conversas/runtime.ts"));
const REPO = semComentario(fonte("lib/agentes/conversas/repositorio.ts"));
const WIZARD = semComentario(fonte("components/ia/factory/Wizard.tsx"));
const VENDAS = semComentario(fonte("lib/agentes/dados/vendas-ml.ts"));
const BRUTO = semComentario(fonte("lib/mercado-livre-vendas.ts"));

console.log("══ F7b.4.8.3 — invariantes estruturais ══");

// ═══ A. §28: a fala do usuario e gravada antes do modelo ═══════════

secao("A. A mensagem e durada antes de qualquer chamada ao modelo");
{
  // A CHAMADA, e nao a mencao: a primeira versao desta sonda procurou
  // "laco" e achou um import na linha 8, concluindo que o modelo vinha
  // antes da gravacao. Medir nome de import como ponto de execucao
  // inverte a ordem do programa.
  const iGrava = RUNTIME.indexOf("await portaConversas.anexarMensagem({");
  const iModelo = RUNTIME.indexOf("await conversarComFerramentas({");
  ok("A1  a gravacao da fala do usuario existe no runtime", iGrava > 0,
    String(iGrava));
  ok("A1a e a chamada ao modelo tambem", iModelo > 0, String(iModelo));
  ok("A2  §28: e ela vem ANTES de o modelo entrar", iGrava > 0 && iModelo > iGrava,
    `grava=${iGrava} modelo=${iModelo}`);
  // ANCORA: a gravacao encontrada e a do USUARIO, e nao a da resposta.
  ok("A2a ANCORA: e a gravacao medida e a da fala do usuario",
    RUNTIME.slice(iGrava, iGrava + 220).includes("papel: \"usuario\""));
  ok("A3  e o `envioId` viaja com ela", /envioId: entrada\.envioId/.test(RUNTIME));
}

// ═══ B. §27: a tela nao mente sobre o envio ════════════════════════

secao("B. A frase de falha nao pode vir antes da pergunta");
{
  const iErro = CHAT.indexOf("Não foi possível enviar.");
  const iReconcilia = CHAT.indexOf("enviarNaConversaDoChat(\n        agenteId, conversa, texto, envioId)");
  ok("B1  a frase de falha ainda existe — ela e certa quando nada chegou",
    iErro > 0, String(iErro));
  ok("B2  §27: mas a RECONCILIACAO vem antes dela",
    iReconcilia > 0 && iReconcilia < iErro, `${iReconcilia} < ${iErro}`);
  ok("B3  e ela e o unico lugar que fala de falha de envio",
    (CHAT.match(/Não foi possível enviar\./g) ?? []).length === 1,
    String((CHAT.match(/Não foi possível enviar\./g) ?? []).length));

  ok("B4  ha estado de envio EM CURSO", /envioEmCurso/.test(CHAT));
  ok("B5  e a tela diz 'em andamento' com ele, sem tom de erro",
    /envioEmCurso !== null && \(/.test(CHAT) &&
      /Consulta em andamento/.test(CHAT_CRU) &&
      /tom="info"/.test(CHAT.slice(CHAT.indexOf("envioEmCurso !== null"),
        CHAT.indexOf("envioEmCurso !== null") + 300)));
  ok("B6  a conferencia reenvia o MESMO envio, e nao um novo",
    /conferirEnvio/.test(CHAT) &&
      !/conferirEnvio[\s\S]{0,600}novoEnvioId\(\)/.test(CHAT));
  ok("B7  e ela tem teto — nao e laco eterno",
    /tentativa < \d+/.test(CHAT));
}

// ═══ C. §29/§30: a identidade do envio ════════════════════════════

secao("C. O envio identifica o turno, e o dono vem da sessao");
{
  ok("C1  a rota le `envioId` do corpo", /corpo\.envioId/.test(ROTA));
  ok("C2  §29: e o limita em tamanho", /slice\(0, 64\)/.test(ROTA));
  ok("C3  §30: com ele, procura o turno que JA existe",
    /lerTurnoDoEnvio/.test(ROTA));
  ok("C4  turno completo volta marcado como reconciliado",
    /reconciliado: true/.test(ROTA));
  ok("C5  turno em curso volta 202, e nao erro",
    /emAndamento: true/.test(ROTA) && /\}, 202\)/.test(ROTA));
  ok("C6  §29: o DONO continua vindo da sessao, nunca do corpo",
    /userId: porta\.userId/.test(ROTA) &&
      !/userId: corpo\.|ownerId: corpo\./.test(ROTA));
  ok("C7  e o `envioId` nao e oferecido ao modelo em ferramenta nenhuma",
    !JSON.stringify(DECLARACOES).includes("envioId"));

  ok("C8  §30: a leitura do envio LANCA em falha de banco",
    /Falha ao ler o envio/.test(REPO));
  ok("C9  e o indice unico parcial existe na migration",
    /envio_id/.test(fonte("supabase/migrations/20261025_mensagem_envio_idempotente.sql")) &&
      /unique index/i.test(
        fonte("supabase/migrations/20261025_mensagem_envio_idempotente.sql")));

  // A corrida entre a leitura e a gravacao: quem fecha e o banco, e a
  // rota tem de LER esse fechamento como reconciliacao.
  ok("C9a o indice violado vira erro TIPADO, e nao texto",
    /class ErroEnvioDuplicado/.test(REPO) && /"23505"/.test(REPO));
  ok("C9b e a rota o trata como turno existente, nao como falha",
    /erro instanceof ErroEnvioDuplicado/.test(ROTA) &&
      /lerTurnoDoEnvio\(porta\.userId, c\.conversaId, erro\.envioId\)/.test(ROTA));
  ok("C9c §27: e ai tambem responde 202 em vez de 500",
    /assistente === null \? 202 : 200/.test(ROTA));
  ok("C9d ANCORA: e qualquer OUTRO erro continua subindo",
    /if \(!\(erro instanceof ErroEnvioDuplicado\)\) throw erro;/.test(ROTA));

  ok("C10 o transporte manda `envioId` quando ele existe",
    /JSON\.stringify\(envioId === undefined \? \{ texto \} : \{ texto, envioId \}\)/
      .test(HTTP));
  ok("C11 e trata resposta ausente como EM ANDAMENTO, nao como falha",
    /emAndamento/.test(HTTP) &&
      /respostaDoAgente === null && !emAndamento/.test(HTTP));
}

// ═══ D. §40: o modo de teste atravessa o mesmo caminho ════════════

secao("D. Modo de teste — paridade, e nao um segundo caminho");
{
  ok("D1  o wizard usa o MESMO componente de chat",
    /<ChatDoAgente[\s\S]{0,120}modoTeste/.test(WIZARD));
  const ocorrencias = (CHAT.match(/modoTeste/g) ?? []).length;
  ok("D2  §40: `modoTeste` aparece poucas vezes — e so aviso",
    ocorrencias <= 3, `${ocorrencias} ocorrencias`);
  ok("D3  §40: ele NAO desvia o envio",
    !/modoTeste[\s\S]{0,200}enviarNaConversaDoChat/.test(CHAT) &&
      !/if \(modoTeste\)[\s\S]{0,200}return/.test(CHAT));
  ok("D4  §40: nem escolhe outra rota, outro provedor ou outro periodo",
    !/modoTeste[\s\S]{0,200}(fetch|\/api\/|periodo|provedor)/.test(CHAT));
  ok("D5  e o unico uso e a faixa de aviso",
    /\{modoTeste && \(/.test(CHAT));
  // ANCORA: se a sonda D3/D4 estiver medindo um arquivo em que
  // `modoTeste` nem aparece, ela passa por vacuidade.
  ok("D5a ANCORA: `modoTeste` EXISTE no arquivo medido", ocorrencias >= 2,
    `${ocorrencias}`);
  ok("D6  e a rota nao conhece modo de teste nenhum",
    !/modoTeste|modo_teste/.test(ROTA));
}

// ═══ E. §35: quem resolve periodo e a CDS ═════════════════════════

secao("E. O modelo nao calcula data");
{
  const decl = DECLARACOES["mercadolivre.vendas.consultar"];
  const schema = JSON.stringify(decl?.schemaEntrada ?? {});
  ok("E1  o schema oferece SO `periodo`",
    /"properties":\{"periodo"/.test(schema) && !/"de"/.test(schema) &&
      !/"ate"/.test(schema), schema.slice(0, 120));
  ok("E2  e ele e obrigatorio", /"required":\["periodo"\]/.test(schema));
  ok("E3  §35: sem enum — a pessoa fala como quiser",
    !/"enum"/.test(schema));
  ok("E4  a descricao manda repetir as palavras da pessoa",
    /PALAVRAS DA PESSOA/.test(decl?.descricao ?? ""));
  ok("E5  e proibe calcular data de cabeca",
    /nao calcule[\s\S]{0,40}datas de cabeca/.test(decl?.descricao ?? ""));
  // F7b.4.8.5-R1: a descricao parou de usar a palavra "BRUTO" solta e
  // passou a DIZER o que o numero e — "o valor dos PRODUTOS ... antes de
  // descontar tarifas". A sonda acompanha o sentido, nao a palavra.
  ok("E6  §10: e diz que o numero e antes de descontar tarifas",
    /antes de descontar tarifas/.test(decl?.descricao ?? ""),
    (decl?.descricao ?? "").slice(0, 80));
  ok("E7  e que periodo passado nao e definitivo",
    /nao apresente periodo fechado como definitivo/.test(decl?.descricao ?? ""));

  ok("E8  quem resolve texto em datas e `periodo-em-texto`",
    /resolverExpressaoDePeriodo/.test(VENDAS));
  ok("E9  e texto que nao se entende vira recusa nomeada",
    /periodo_nao_entendido/.test(VENDAS));

  // A mesma funcao, chamada aqui: paridade de resolucao nao e afirmacao,
  // e sim a MESMA implementacao.
  const r = resolverExpressaoDePeriodo("de 10/09/2026 até 20/09/2026", Date.now());
  ok("E10 e ela e pura e deterministica",
    r?.de === "2026-09-10" && r?.ate === "2026-09-20",
    `${r?.de}..${r?.ate}`);
}

// ═══ F. §11/§21: sem completude nao ha total ══════════════════════

secao("F. A completude e a condicao do total");
{
  // F7b.4.8.5: o campo mudou de nome junto com a semantica — `totais`
  // media pagamento, `vendasBrutas` mede venda. O que esta sonda guarda e
  // a REGRA: varredura incompleta nao entrega numero.
  ok("F1  a leitura devolve `vendasBrutas: null` quando incompleta",
    /vendasBrutas: null/.test(VENDAS));
  ok("F1a e o campo antigo nao sobrou em lugar nenhum",
    !/totais/.test(VENDAS));
  ok("F2  e diz o tamanho do que faltou", /parcial/.test(VENDAS));
  ok("F3  §8: a completude e conferida contra `paging\\.total` do dia",
    /totaisRelatados/.test(BRUTO) && /idsDoDia\.size >= menorTotal/.test(BRUTO));
  ok("F4  §10: e NENHUM `order.status` e enviado",
    !/searchParams\.set\("order\.status"/.test(BRUTO));
  ok("F5  429 nao e mais fatal", !/status === 429\s*$/m.test(BRUTO) &&
    /TENTATIVAS_APOS_429/.test(BRUTO));
  ok("F6  401 e 403 continuam condenando a consulta",
    /status === 401 \|\| resposta\.status === 403/.test(BRUTO));
  ok("F7  e o pagamento que conta e o MAIS ANTIGO aprovado",
    /maisAntigo/.test(BRUTO));
}

// ═══ G. F7b.4.8.5-R1: a tela mostra o texto formatado ═════════════

secao("G. O Markdown do modelo nao volta a aparecer cru");
{
  ok("G1  a bolha do ASSISTENTE usa o renderer",
    /m\.papel === "assistente" \? \(/.test(CHAT) &&
      /<TextoDoAgente texto=\{m\.conteudo\} \/>/.test(CHAT));
  ok("G2  e a fala do USUARIO continua texto puro",
    /\{m\.conteudo\}/.test(CHAT));
  ok("G3  ANCORA: o chat de fato importa o renderer",
    /from "@\/components\/ui\/TextoDoAgente"/.test(CHAT));

  const componente = semComentario(fonte("components/ui/TextoDoAgente.tsx"));
  ok("G4  o renderer NAO usa `dangerouslySetInnerHTML`",
    !componente.includes("dangerouslySetInnerHTML"));
  ok("G5  nem monta HTML por string", !/innerHTML|outerHTML/.test(componente));
  // A lista de esquemas e lida da fonte CRUA: `semComentario` nao entende
  // string, e corta o `//` de dentro de `"http://"` como se fosse
  // comentario de linha. Para esta sonda, o literal importa.
  const componenteCru = fonte("components/ui/TextoDoAgente.tsx");
  ok("G6  e so transforma em link o que comeca por http/https",
    /ESQUEMAS_PERMITIDOS = \["http:\/\/", "https:\/\/"\]/.test(componenteCru),
    componenteCru.slice(componenteCru.indexOf("ESQUEMAS_PERMITIDOS"),
      componenteCru.indexOf("ESQUEMAS_PERMITIDOS") + 70));
  ok("G7  com `rel` seguro", /noopener/.test(componente));
}

// ═══ H. F7b.4.8.5-R1: a definicao de vendas brutas ════════════════

secao("H. O que o modelo e instruido a DIZER");
{
  const d = DECLARACOES["mercadolivre.vendas.consultar"]?.descricao ?? "";
  ok("H1  define venda bruta pelo valor dos PRODUTOS",
    /valor dos PRODUTOS das vendas fechadas/.test(d), d.slice(0, 80));
  ok("H2  e PROIBE a frase que o Rodrigo leu na tela",
    /NAO diga que e o valor pago pelos compradores/.test(d));
  ok("H3  proibe afirmar que inclui frete", /NAO diga que inclui frete/.test(d));
  // A DEFINICAO errada, e nao as palavras dela: a descricao nova cita "o
  // que o comprador pagou" de proposito, para dizer que e OUTRO campo.
  // Proibir a palavra proibiria a propria correcao.
  ok("H4  a definicao errada nao e mais afirmada",
    !/e o que o comprador pagou pelos produtos/.test(d), d.slice(0, 120));
  ok("H4a e a mencao que resta diz que aquilo e OUTRO campo",
    /o que o comprador pagou e outro campo/.test(d));
  ok("H5  segue proibindo chamar de lucro, liquido ou recebido",
    /chame de lucro, de liquido nem de recebido/.test(d));
}

console.log(`\nPASS ${pass}   FAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);
