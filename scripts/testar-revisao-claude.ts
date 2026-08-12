/**
 * Testes determinísticos da etapa `revisao_claude` — funções puras, sem
 * banco, sem rede, sem IA. Mesmo padrão dos scripts das etapas
 * anteriores.
 *
 * Uso: npx tsx scripts/testar-revisao-claude.ts
 */
import {
  extrairTrechosRevisaveis,
  remontarConteudoRevisado,
  montarEntradaRevisao,
  montarPromptUsuarioRevisao,
  validarEstruturaRevisao,
  validarIntegridadeRevisao,
  PROMPT_SISTEMA_REVISAO,
  RESTRICOES_REVISAO,
} from "../lib/estudio-anuncios/revisao-claude";
import { SCHEMA_VERSAO_REVISAO_CLAUDE } from "../lib/estudio-anuncios/revisao-claude-tipos";
import { REVISAO_CLAUDE_JSON_SCHEMA } from "../lib/ai-gateway/provedores/anthropic-revisao-schema";
import type { GeracaoConteudoIA } from "../lib/estudio-anuncios/geracao-conteudo-tipos";
import { HANDLERS_ESPECIFICOS, ETAPAS_FAKE_GENERICAS, resolverHandler } from "../lib/estudio-anuncios/executores/registry";
import { decidirProvedor } from "../lib/ai-gateway/roteamento";
import { estimarCustoUsd, modeloTemPrecoCadastrado } from "../lib/ai-gateway/custos";
import { ErroProvedorIA } from "../lib/ai-gateway/erros";
import { mapearErroAnthropic, obterModeloRevisao } from "../lib/ai-gateway/provedores/anthropic";

let ok = 0, falhou = 0;
function t(nome: string, fn: () => void) {
  try { fn(); ok++; console.log(`  PASS  ${nome}`); }
  catch (e: any) { falhou++; console.log(`  FALHA ${nome} -> ${e?.message ?? e}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }
function lanca(fn: () => unknown, trecho: string) {
  try { fn(); } catch (e: any) {
    assert(String(e?.message ?? "").toLowerCase().includes(trecho.toLowerCase()), `mensagem inesperada: ${e?.message}`);
    return;
  }
  throw new Error(`deveria ter lançado (esperado conter "${trecho}")`);
}

const BASE: GeracaoConteudoIA = {
  tituloBase: { texto: "Rolo Massageador Facial Duplo de Pedra Verde", fatoIds: ["F1", "F3"] },
  descricaoCurta: { texto: "Rolo massageador facial que aparenta ser de jade, com duas extremidades.", contemRessalva: true, fatoIds: ["F1", "R1"] },
  bullets: [
    { texto: "Duas extremidades giratorias de tamanhos distintos.", contemRessalva: false, fatoIds: ["F2"] },
    { texto: "Estrutura em metal de tom dourado.", contemRessalva: false, fatoIds: ["F3"] },
  ],
  descricaoLonga: [{ texto: "Indicado para massagem facial e do pescoco.", contemRessalva: false, fatoIds: ["F4"] }],
  especificacoes: [
    { nome: "Material da Estrutura", valor: "Metal", fatoId: "F3" },
    { nome: "Componente Principal", valor: "1 rolo massageador facial duplo", fatoId: "F1" },
  ],
  publicoSugerido: { texto: "Pessoas interessadas em cuidados faciais", fatoIds: ["F5"] },
};

const ENTRADA = montarEntradaRevisao(BASE);
const REFS = ENTRADA.trechos.map(x => x.ref);

function saidaOk(over: Record<string, any> = {}) {
  return {
    textos: ENTRADA.trechos.map(x => ({ ref: x.ref, textoRevisado: x.textoOriginal, alterado: false, ...(over[x.ref] ?? {}) })),
  };
}

console.log("\n=== revisao_claude — testes determinísticos ===\n");

console.log("[schema / contrato]");
t("1. schema Google-agnóstico cobre a raiz do domínio", () => {
  const props = Object.keys(REVISAO_CLAUDE_JSON_SCHEMA.properties).sort().join(",");
  assert(props === "observacoes,textos", `props inesperadas: ${props}`);
  assert(REVISAO_CLAUDE_JSON_SCHEMA.additionalProperties === false, "additionalProperties deve ser false");
});
t("2. schema_versao é constante independente = 1", () => assert(SCHEMA_VERSAO_REVISAO_CLAUDE === 1, "versão inesperada"));
t("3. trechos revisáveis excluem especificacoes e publicoSugerido", () => {
  assert(REFS.includes("tituloBase") && REFS.includes("descricaoCurta"), "faltam obrigatórios");
  assert(REFS.includes("bullet:0") && REFS.includes("bullet:1"), "faltam bullets");
  assert(REFS.includes("descricaoLonga:0"), "falta descricaoLonga");
  assert(!REFS.some(r => /especifica|publico/i.test(r)), "fato estruturado não pode ser revisável");
  assert(REFS.length === 5, `esperado 5 trechos, veio ${REFS.length}`);
});
t("4. prompt não menciona foto/storage/imagem", () => {
  const p = PROMPT_SISTEMA_REVISAO + montarPromptUsuarioRevisao(ENTRADA);
  assert(!/storage|foto|imagem|base64/i.test(p), "prompt não pode mencionar foto/storage");
  assert(p.includes("Rolo Massageador Facial Duplo"), "faltou conteúdo-base");
});
t("5. entrada congela as restrições", () => assert(ENTRADA.restricoes === RESTRICOES_REVISAO, "restrições não congeladas"));

console.log("\n[validação estrutural]");
t("6. saída válida é aceita", () => assert(validarEstruturaRevisao(saidaOk()).textos.length === 5, "esperado 5"));
t("7. propriedade extra na raiz é rejeitada", () => lanca(() => validarEstruturaRevisao({ ...saidaOk(), extra: 1 }), "propriedade extra"));
t("8. propriedade extra no item é rejeitada", () => {
  const s = saidaOk(); (s.textos[0] as any).fatoIds = ["F9"];
  lanca(() => validarEstruturaRevisao(s), "propriedade extra");
});
t("9. textoRevisado vazio é rejeitado", () => lanca(() => validarEstruturaRevisao(saidaOk({ tituloBase: { textoRevisado: "  " } })), "vazio"));
t("10. alterado ausente é rejeitado", () => {
  const s = saidaOk(); delete (s.textos[0] as any).alterado;
  lanca(() => validarEstruturaRevisao(s), "alterado");
});
t("11. alterado=true sem motivo é rejeitado", () =>
  lanca(() => validarEstruturaRevisao(saidaOk({ tituloBase: { textoRevisado: "Novo titulo", alterado: true } })), "motivo"));
t("12. alterado=false com motivo é rejeitado", () =>
  lanca(() => validarEstruturaRevisao(saidaOk({ tituloBase: { alterado: false, motivo: "x" } })), "não aceita"));
t("13. textos vazio é rejeitado", () => lanca(() => validarEstruturaRevisao({ textos: [] }), "ausente ou vazio"));

console.log("\n[integridade — o que impede alterar fato]");
t("14. revisão sem alteração é aceita", () => assert(validarIntegridadeRevisao(saidaOk() as any, ENTRADA).valido, "deveria aceitar"));
t("15. melhoria legítima de redação é aceita", () => {
  const s = saidaOk({ "bullet:0": { textoRevisado: "Duas extremidades giratórias de tamanhos diferentes.", alterado: true, motivo: "acentuação e clareza" } });
  const r = validarIntegridadeRevisao(s as any, ENTRADA);
  assert(r.valido, `deveria aceitar, veio ${JSON.stringify(r)}`);
});
t("16. alterado=false com texto diferente é rejeitado", () => {
  const s = saidaOk({ tituloBase: { textoRevisado: "Outro titulo", alterado: false } });
  const r = validarIntegridadeRevisao(s as any, ENTRADA);
  assert(!r.valido && /difere do original/.test(r.motivo!), `veio ${JSON.stringify(r)}`);
});
t("17. promessa promocional nova é rejeitada", () => {
  const s = saidaOk({ tituloBase: { textoRevisado: "Rolo Massageador com frete gratis", alterado: true, motivo: "x" } });
  const r = validarIntegridadeRevisao(s as any, ENTRADA);
  assert(!r.valido && /termo proibido/.test(r.motivo!), `veio ${JSON.stringify(r)}`);
});
t("18. alegação clínica nova é rejeitada", () => {
  const s = saidaOk({ "descricaoLonga:0": { textoRevisado: "Trata rugas e rejuvenesce a pele.", alterado: true, motivo: "x" } });
  assert(!validarIntegridadeRevisao(s as any, ENTRADA).valido, "deveria rejeitar");
});
t("19. CTA novo é rejeitado", () => {
  const s = saidaOk({ tituloBase: { textoRevisado: "Rolo Massageador Facial — compre agora", alterado: true, motivo: "x" } });
  assert(!validarIntegridadeRevisao(s as any, ENTRADA).valido, "deveria rejeitar");
});
t("20. medida/quantidade inventada é rejeitada", () => {
  const s = saidaOk({ "bullet:0": { textoRevisado: "Duas extremidades de 15 cm cada.", alterado: true, motivo: "x" } });
  const r = validarIntegridadeRevisao(s as any, ENTRADA);
  assert(!r.valido && /medida/.test(r.motivo!), `veio ${JSON.stringify(r)}`);
});
t("21. remover ressalva (hipótese virando fato) é rejeitado", () => {
  const s = saidaOk({ descricaoCurta: { textoRevisado: "Rolo massageador facial de jade, com duas extremidades.", alterado: true, motivo: "x" } });
  const r = validarIntegridadeRevisao(s as any, ENTRADA);
  assert(!r.valido && /ressalva/.test(r.motivo!), `veio ${JSON.stringify(r)}`);
});
t("22. ref inexistente é rejeitada", () => {
  const s = saidaOk(); s.textos.push({ ref: "bullet:99", textoRevisado: "x", alterado: false } as any);
  const r = validarIntegridadeRevisao(s as any, ENTRADA);
  assert(!r.valido && /inexistente/.test(r.motivo!), `veio ${JSON.stringify(r)}`);
});
t("23. ref duplicada é rejeitada", () => {
  const s = saidaOk(); s.textos.push({ ...s.textos[0] });
  const r = validarIntegridadeRevisao(s as any, ENTRADA);
  assert(!r.valido && /duplicada/.test(r.motivo!), `veio ${JSON.stringify(r)}`);
});
t("24. trecho omitido é rejeitado", () => {
  const s = saidaOk(); s.textos.pop();
  const r = validarIntegridadeRevisao(s as any, ENTRADA);
  assert(!r.valido && /sem revisão/.test(r.motivo!), `veio ${JSON.stringify(r)}`);
});

console.log("\n[remontagem — fatos preservados por construção]");
t("25. fatoIds e contemRessalva são preservados verbatim", () => {
  const s = validarEstruturaRevisao(saidaOk({ tituloBase: { textoRevisado: "Titulo Revisado", alterado: true, motivo: "x" } }));
  const rev = remontarConteudoRevisado(BASE, s);
  assert(rev.tituloBase.texto === "Titulo Revisado", "texto não aplicado");
  assert(JSON.stringify(rev.tituloBase.fatoIds) === JSON.stringify(BASE.tituloBase.fatoIds), "fatoIds alterados");
  assert(rev.descricaoCurta.contemRessalva === true, "contemRessalva perdido");
  assert(JSON.stringify(rev.bullets![1].fatoIds) === JSON.stringify(BASE.bullets![1].fatoIds), "fatoIds de bullet alterados");
});
t("26. especificacoes e publicoSugerido são cópia idêntica", () => {
  const rev = remontarConteudoRevisado(BASE, validarEstruturaRevisao(saidaOk()));
  assert(JSON.stringify(rev.especificacoes) === JSON.stringify(BASE.especificacoes), "especificacoes alteradas");
  assert(JSON.stringify(rev.publicoSugerido) === JSON.stringify(BASE.publicoSugerido), "publicoSugerido alterado");
});
t("27. conteudoRevisado tem o mesmo shape de GeracaoConteudoIA", () => {
  const rev = remontarConteudoRevisado(BASE, validarEstruturaRevisao(saidaOk()));
  assert(Object.keys(rev).sort().join(",") === Object.keys(BASE).sort().join(","), "shape divergente — adaptacao_marketplace não conseguiria ler");
});

console.log("\n[registry / roteamento / provedor]");
t("28. registry não tem etapa nos dois conjuntos", () => {
  for (const e of Object.keys(HANDLERS_ESPECIFICOS)) assert(!ETAPAS_FAKE_GENERICAS.has(e), `"${e}" está nos dois`);
});
t("29. revisao_claude resolve para handler específico", () => {
  const h = resolverHandler("revisao_claude");
  assert(!!h && h.etapa === "revisao_claude", "handler não resolvido");
  assert(h!.geraResultadoEstruturado === true, "deveria gerar resultado");
  assert(h!.dependencia === "job_origem_id", "dependência incorreta");
  assert(h!.versaoSaida === SCHEMA_VERSAO_REVISAO_CLAUDE, "versaoSaida incorreta");
});
t("30. provedoresPermitidos é fake+anthropic — nunca google", () => {
  const h = resolverHandler("revisao_claude")!;
  assert(h.provedoresPermitidos.includes("fake") && h.provedoresPermitidos.includes("anthropic"), "faltou fake/anthropic");
  assert(!h.provedoresPermitidos.includes("google" as any), "google não pode ser permitido nesta etapa");
});
t("31. flag ausente/false/caixa-alta mantém fake", () => {
  const antes = process.env.ANTHROPIC_REVISAO_ENABLED;
  delete process.env.ANTHROPIC_REVISAO_ENABLED;
  assert(decidirProvedor("revisao_claude") === "fake", "ausente deveria dar fake");
  process.env.ANTHROPIC_REVISAO_ENABLED = "false";
  assert(decidirProvedor("revisao_claude") === "fake", "false deveria dar fake");
  process.env.ANTHROPIC_REVISAO_ENABLED = "TRUE";
  assert(decidirProvedor("revisao_claude") === "fake", "TRUE deveria dar fake");
  process.env.ANTHROPIC_REVISAO_ENABLED = "true";
  assert(decidirProvedor("revisao_claude") === "anthropic", "true deveria dar anthropic");
  if (antes === undefined) delete process.env.ANTHROPIC_REVISAO_ENABLED; else process.env.ANTHROPIC_REVISAO_ENABLED = antes;
});
t("32. flag desta etapa não afeta as outras", () => {
  // AJUSTE (2026-08-17): fixava `=== "fake"` para outras etapas, e
  // calculo_score passou a rotear para "internal". A invariante e "ligar
  // ESTA flag nao muda o roteamento de NENHUMA outra etapa" — testada
  // comparando antes/depois, sem depender de qual provedor cada etapa usa.
  const antes = process.env.ANTHROPIC_REVISAO_ENABLED;
  const outras = ["calculo_score", "geracao_imagem", "geracao_conteudo", "ping"];
  delete process.env.ANTHROPIC_REVISAO_ENABLED;
  const referencia = outras.map(e => decidirProvedor(e));
  process.env.ANTHROPIC_REVISAO_ENABLED = "true";
  outras.forEach((e, i) => assert(decidirProvedor(e) === referencia[i], `flag vazou para ${e}`));
  if (antes === undefined) delete process.env.ANTHROPIC_REVISAO_ENABLED; else process.env.ANTHROPIC_REVISAO_ENABLED = antes;
});
t("33. etapas fake restantes continuam no fake genérico", () => {
  // Deriva do conjunto real, nunca de uma lista fixa de etapas: uma
  // lista fixa quebra a cada promoção (aconteceu em 2026-08-13, 08-14 e
  // 08-15). A invariante testada é "toda etapa do conjunto fake resolve
  // para o handler compartilhado", que sobrevive a promoções futuras.
  assert(ETAPAS_FAKE_GENERICAS.size > 0, "conjunto fake não pode ficar vazio nesta fase");
  for (const e of ETAPAS_FAKE_GENERICAS) {
    const h = resolverHandler(e);
    assert(!!h && h.etapa === "*", `"${e}" deveria usar o fake genérico`);
  }
  assert(resolverHandler("inexistente") === undefined, "etapa desconhecida deveria dar undefined");
});
t("34. modelo ausente gera erro explícito auth", () => {
  const antes = process.env.ANTHROPIC_MODEL_REVISAO;
  delete process.env.ANTHROPIC_MODEL_REVISAO;
  try { obterModeloRevisao(); throw new Error("deveria ter lançado"); }
  catch (e: any) { assert(e?.tipo === "auth", `esperado auth, veio ${e?.tipo}`); }
  finally { if (antes !== undefined) process.env.ANTHROPIC_MODEL_REVISAO = antes; }
});

console.log("\n[custos — correção estrutural §37.2]");
t("35. modelos Anthropic têm preço cadastrado (não caem em 0)", () => {
  assert(modeloTemPrecoCadastrado("claude-opus-5"), "claude-opus-5 sem preço");
  assert(estimarCustoUsd("claude-opus-5", 1_000_000, 0) === 5, "preço de entrada incorreto");
  assert(estimarCustoUsd("claude-opus-5", 0, 1_000_000) === 25, "preço de saída incorreto");
});
t("36. modelo Gemini continua com o preço de antes (sem regressão)", () => {
  assert(estimarCustoUsd("gemini-3.6-flash", 1_000_000, 0) === 1.5, "preço Gemini regrediu");
});
t("37. modelo desconhecido devolve 0 sem lançar", () =>
  assert(estimarCustoUsd("modelo-inexistente-xyz", 1000, 1000) === 0, "deveria ser 0"));

console.log("\n[mapeamento de erro da Anthropic]");
t("38. 401/403 -> auth, 429 -> rate_limit, 5xx -> transient, 400 -> validation", () => {
  const casos: [number, string][] = [[401, "auth"], [403, "auth"], [429, "rate_limit"], [500, "transient"], [503, "transient"], [400, "validation"], [404, "validation"]];
  for (const [status, esperado] of casos) {
    const e = mapearErroAnthropic(Object.assign(new Error("x"), { status }));
    assert(e instanceof ErroProvedorIA && e.tipo === esperado, `status ${status}: esperado ${esperado}, veio ${e.tipo}`);
  }
});
t("39. timeout sem status -> transient", () => {
  assert(mapearErroAnthropic(new Error("Request timed out")).tipo === "transient", "timeout deveria ser transient");
});
t("40. erro desconhecido -> unknown (nunca inventa categoria)", () => {
  const e = mapearErroAnthropic(new Error("algo estranho"));
  assert(e.tipo === "unknown", `veio ${e.tipo}`);
  const validos = ["transient", "auth", "rate_limit", "conteudo_rejeitado", "validation", "unknown"];
  assert(validos.includes(e.tipo), "categoria fora do CHECK do banco");
});

console.log(`\n=== RESULTADO: ${ok} passaram, ${falhou} falharam ===\n`);
process.exitCode = falhou > 0 ? 1 : 0;
