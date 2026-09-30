/**
 * AGENT-FACTORY-F7a — conversas, historico e as rotas.
 *
 * NAO chama IA, NAO chama rede, NAO chama banco.
 *
 * ── O que esta suite prova ──────────────────────────────────────────
 *
 * A separacao que a Factory inteira depende:
 *
 *   HISTORICO  morre com a conversa
 *   MEMORIA    atravessa
 *   FONTE      atravessa
 *   ANEXO      fica na conversa
 *
 * E as propriedades das rotas novas que nao se ve rodando: toda rota
 * atravessa a porta de autoridade, nenhuma aceita `userId` do corpo, e
 * nenhuma devolve caminho de storage.
 *
 * A prova ponta a ponta contra o banco REAL vive em
 * `testar-agent-factory-infra.ts` — aqui a mesma logica e exercitada
 * com portas de memoria, que e o que permite rodar sem infraestrutura.
 *
 * Rodar:  npx tsx scripts/testar-agentes-conversas.ts
 */
import "./_server-only-inerte";

import { readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  MAX_CONTEUDO_DA_MENSAGEM,
  MAX_MENSAGENS_NO_CONTEXTO,
  recortarHistorico,
  validarMensagemDoUsuario,
  validarTitulo,
  type Mensagem,
} from "@/lib/agentes/conversas/tipos";
import type { NovaMensagem, PortaDeConversas } from "@/lib/agentes/conversas/repositorio";
import type { Conversa } from "@/lib/agentes/conversas/tipos";
import { montarContextoDoAgente } from "@/lib/agentes/ia/contexto-do-agente";
import { criarFonteDeArquivoDasSources } from "@/lib/agentes/fontes/resolvedor";
import { montarCaminhoDaFonte } from "@/lib/agentes/fontes/armazenamento";
import type { FonteComCaminho, NovaFonte, PortaDeFontes } from "@/lib/agentes/fontes/repositorio";
import { paraModelo, type Fonte } from "@/lib/agentes/fontes/tipos";
import type { Memoria } from "@/lib/agentes/memorias/tipos";

const RAIZ = join(__dirname, "..");

let passou = 0;
let falhou = 0;
function ok(nome: string, cond: boolean, detalhe?: string): void {
  if (cond) { passou += 1; console.log(`  PASS  ${nome}`); }
  else { falhou += 1; console.log(`  FAIL  ${nome}${detalhe ? ` — ${detalhe}` : ""}`); }
}
function secao(t: string): void {
  console.log(`\n── ${t} ${"─".repeat(Math.max(2, 58 - t.length))}`);
}
function ler(rel: string): string { return readFileSync(join(RAIZ, rel), "utf8"); }
function semComentarios(f: string): string {
  return f.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const DONO_A = "dono-a";
const DONO_B = "dono-b";
const AG_1 = "11111111-1111-4111-8111-111111111111";
const AG_2 = "22222222-2222-4222-8222-222222222222";

// ─── Portas de memoria, com os mesmos filtros das reais ───────────────

function criarPortaDeConversasFake(
  conversas: Conversa[], mensagens: Mensagem[]
): PortaDeConversas {
  return {
    async criarConversa(userId, agenteId, titulo) {
      const agora = new Date(Date.now() + conversas.length).toISOString();
      const c: Conversa = {
        id: randomUUID(), userId, agenteId, titulo, arquivada: false,
        criadoEm: agora, atualizadoEm: agora,
      };
      conversas.push(c);
      return c;
    },
    async obterConversa(userId, conversaId) {
      return conversas.find((c) => c.userId === userId && c.id === conversaId) ?? null;
    },
    async listarConversas(userId, agenteId) {
      return conversas.filter((c) =>
        c.userId === userId && c.agenteId === agenteId && !c.arquivada);
    },
    // F7b.4.8: a MESMA condicao da porta real — so grava com titulo nulo.
    // Uma fake permissiva faria a suite aprovar uma reescrita que a real
    // recusa, e o oraculo passaria a descrever outro sistema.
    async definirAssuntoSeVazio(userId, conversaId, assunto) {
      if (assunto.trim() === "") return false;
      const c = conversas.find((x) =>
        x.userId === userId && x.id === conversaId && x.titulo === null);
      if (!c) return false;
      (c as { titulo: string | null }).titulo = assunto;
      return true;
    },
    async arquivarConversa(userId, conversaId) {
      const c = conversas.find((x) => x.userId === userId && x.id === conversaId && !x.arquivada);
      if (!c) return false;
      (c as { arquivada: boolean }).arquivada = true;
      return true;
    },
    async listarMensagens(userId, conversaId) {
      return mensagens
        .filter((m) => m.userId === userId && m.conversaId === conversaId)
        .sort((a, b) => a.ordem - b.ordem);
    },
    // F7b.4.8.3: a MESMA condicao da porta real — o envio identifica o
    // turno, e o mesmo `envioId` tem de encontrar o que ja existe.
    async lerTurnoDoEnvio(userId: string, conversaId: string, envioId: string) {
      const daConversa = mensagens
        .filter((m) => m.userId === userId && m.conversaId === conversaId)
        .sort((a, b) => a.ordem - b.ordem);
      // O envio marca UMA linha — a fala do usuario. A resposta e a
      // seguinte, como na porta real: o indice unico parcial nao admite
      // duas linhas com o mesmo envio.
      const usuario = daConversa.find((m) =>
        (m as { envioId?: string | null }).envioId === envioId) ?? null;
      if (usuario === null || usuario.papel !== "usuario") {
        return { usuario: null, assistente: null };
      }
      const proxima = daConversa.find((m) => m.ordem > usuario.ordem) ?? null;
      return {
        usuario,
        assistente: proxima !== null && proxima.papel === "assistente" ? proxima : null,
      };
    },
    async anexarMensagem(n: NovaMensagem) {
      const ordem = mensagens.filter((m) =>
        m.userId === n.userId && m.conversaId === n.conversaId).length;
      const m: Mensagem = {
        id: randomUUID(), userId: n.userId, conversaId: n.conversaId,
        papel: n.papel, conteudo: n.conteudo, ordem,
        passos: n.passos ?? null, provedor: n.provedor ?? null, modelo: n.modelo ?? null,
        tokensEntrada: n.tokensEntrada ?? null, tokensSaida: n.tokensSaida ?? null,
        tempoMs: n.tempoMs ?? null, criadoEm: new Date().toISOString(),
        ...(n.envioId === undefined ? {} : { envioId: n.envioId }),
      } as Mensagem & { envioId?: string | null };
      mensagens.push(m);
      return m;
    },
  };
}

interface LinhaFonteMem extends FonteComCaminho { bytes: Uint8Array }
function soDominio(l: LinhaFonteMem): Fonte {
  const { caminhoObjeto, bytes, ...d } = l; void caminhoObjeto; void bytes; return d;
}
function criarPortaDeFontesFake(linhas: LinhaFonteMem[]): PortaDeFontes {
  return {
    async obterAtiva(userId, fonteId, vinculo) {
      return linhas.find((l) => l.userId === userId && l.id === fonteId && l.ativo &&
        (!vinculo ? true : "agenteId" in vinculo
          ? l.agenteId === vinculo.agenteId : l.conversaId === vinculo.conversaId)) ?? null;
    },
    async listarDoAgente(userId, agenteId) {
      return linhas.filter((l) => l.userId === userId && l.agenteId === agenteId &&
        l.escopo === "agente" && l.ativo).map(soDominio);
    },
    async listarDaConversa(userId, conversaId) {
      return linhas.filter((l) => l.userId === userId && l.conversaId === conversaId &&
        l.escopo === "conversa" && l.ativo).map(soDominio);
    },
    async criar(nova: NovaFonte) {
      const id = randomUUID();
      const l: LinhaFonteMem = {
        id, userId: nova.userId, agenteId: nova.agenteId, conversaId: nova.conversaId,
        escopo: nova.escopo, nome: nova.nome, descricao: nova.descricao, papel: nova.papel,
        tipo: nova.tipo, mime: nova.mime, tamanhoBytes: nova.bytes.length,
        hashSha256: nova.hashSha256,
        caminhoObjeto: montarCaminhoDaFonte({
          userId: nova.userId, escopo: nova.escopo,
          vinculoId: (nova.agenteId ?? nova.conversaId) as string,
          fonteId: id, nomeOriginal: nova.nome, tipo: nova.tipo }),
        ativo: true, substituiId: nova.substituiId,
        criadoEm: new Date().toISOString(), bytes: nova.bytes,
      };
      linhas.push(l);
      return soDominio(l);
    },
    async atualizarMetadado(userId, fonteId, vinculo, campos) {
      // Espelha a porta REAL: escopo por dono + agente + ativo, decidido
      // na PROPRIA busca. Uma fixture mais permissiva que a producao
      // provaria menos do que o sistema entrega — foi assim que o D8
      // passou batido antes.
      if (campos.nome === undefined && campos.papel === undefined &&
          campos.descricao === undefined) {
        return null;
      }
      const l = linhas.find((x) =>
        x.userId === userId && x.id === fonteId &&
        x.agenteId === vinculo.agenteId && x.ativo);
      if (!l) return null;
      if (campos.nome !== undefined) (l as { nome: string }).nome = campos.nome;
      if (campos.papel !== undefined) {
        (l as { papel: string | null }).papel = campos.papel;
      }
      if (campos.descricao !== undefined) {
        (l as { descricao: string | null }).descricao = campos.descricao;
      }
      return soDominio(l);
    },
    async desativar() { return false; },
    async lerBytes(caminho) {
      const l = linhas.find((x) => x.caminhoObjeto === caminho);
      if (!l) throw new Error("objeto inexistente");
      return l.bytes;
    },
  };
}

function memoriaFake(conteudo: string, ordem: number): Memoria {
  return {
    id: randomUUID(), userId: DONO_A, agenteId: AG_1, conteudo, tipo: null,
    ordem, ativo: true, criadoEm: "2026-01-01T00:00:00Z", atualizadoEm: "2026-01-01T00:00:00Z",
  };
}

async function main(): Promise<void> {
  console.log("\n══ CDS IA — F7a: conversas, historico e rotas ══");

  // ═══════════════════════════════════════════════════════════════════
  secao("A. Validacao e recorte do historico");
  // ═══════════════════════════════════════════════════════════════════
  {
    ok("A1  mensagem vazia recusada", !validarMensagemDoUsuario("   ").ok);
    ok("A2  mensagem gigante recusada — documento e FONTE",
      !validarMensagemDoUsuario("x".repeat(MAX_CONTEUDO_DA_MENSAGEM + 1)).ok);
    ok("A3  mensagem normal aceita", validarMensagemDoUsuario("oi").ok);
    ok("A4  titulo nulo e valido", validarTitulo(null).ok && validarTitulo(undefined).ok);
    ok("A5  titulo vazio recusado", !validarTitulo("  ").ok);

    const muitas: Mensagem[] = Array.from({ length: 30 }, (_, i) => ({
      id: `m${i}`, userId: DONO_A, conversaId: "c1",
      papel: i % 2 === 0 ? "usuario" : "assistente", conteudo: `msg ${i}`, ordem: i,
      passos: null, provedor: null, modelo: null, tokensEntrada: null,
      tokensSaida: null, tempoMs: null, criadoEm: "2026-01-01T00:00:00Z",
    }));
    const r = recortarHistorico(muitas);
    ok("A6  o recorte fica no teto", r.incluidas.length === MAX_MENSAGENS_NO_CONTEXTO);
    ok("A7  e mantem as MAIS RECENTES — o fim da conversa e o que importa",
      r.incluidas[r.incluidas.length - 1].conteudo === "msg 29" &&
      r.incluidas[0].conteudo === "msg 10");
    ok("A8  e DECLARA quantas ficaram de fora", r.excluidasPorTeto === 10);
    ok("A9  conversa curta nao e cortada",
      recortarHistorico(muitas.slice(0, 5)).excluidasPorTeto === 0);
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("B. Isolamento de conversa e historico");
  // ═══════════════════════════════════════════════════════════════════
  const conversas: Conversa[] = [];
  const mensagens: Mensagem[] = [];
  const portaC = criarPortaDeConversasFake(conversas, mensagens);
  let chatA: Conversa;
  let chatB: Conversa;
  {
    chatA = await portaC.criarConversa(DONO_A, AG_1, "Chat A");
    chatB = await portaC.criarConversa(DONO_A, AG_1, "Chat B");
    const doOutroAgente = await portaC.criarConversa(DONO_A, AG_2, "Outro agente");
    const doOutroDono = await portaC.criarConversa(DONO_B, AG_1, "Outro dono");

    await portaC.anexarMensagem({ userId: DONO_A, conversaId: chatA.id,
      papel: "usuario", conteudo: "segredo do chat A" });
    await portaC.anexarMensagem({ userId: DONO_A, conversaId: chatA.id,
      papel: "assistente", conteudo: "resposta do A", provedor: "anthropic", modelo: "m" });
    await portaC.anexarMensagem({ userId: DONO_A, conversaId: chatB.id,
      papel: "usuario", conteudo: "assunto do chat B" });

    ok("B1  a ordem e sequencial por conversa",
      (await portaC.listarMensagens(DONO_A, chatA.id)).map((m) => m.ordem).join(",") === "0,1");
    ok("B2  cada conversa comeca do zero",
      (await portaC.listarMensagens(DONO_A, chatB.id))[0].ordem === 0);
    ok("B3  HISTORICO de A nao aparece em B",
      !(await portaC.listarMensagens(DONO_A, chatB.id))
        .some((m) => m.conteudo.includes("segredo do chat A")));
    ok("B4  CONTROLE: em A ele aparece — 'lista vazia' nao e prova",
      (await portaC.listarMensagens(DONO_A, chatA.id))
        .some((m) => m.conteudo.includes("segredo do chat A")));
    ok("B5  conversa de outro dono nao e lida pelo dono A",
      (await portaC.obterConversa(DONO_A, doOutroDono.id)) === null);
    ok("B6  a listagem separa por agente",
      (await portaC.listarConversas(DONO_A, AG_1)).length === 2 &&
      (await portaC.listarConversas(DONO_A, AG_2)).length === 1,
      String(doOutroAgente.id.slice(0, 4)));
    ok("B7  arquivar tira da lista sem apagar o historico",
      (await portaC.arquivarConversa(DONO_A, chatB.id)) === true &&
      (await portaC.listarConversas(DONO_A, AG_1)).length === 1 &&
      (await portaC.listarMensagens(DONO_A, chatB.id)).length === 1);
    ok("B8  arquivar de outro dono nao faz nada",
      (await portaC.arquivarConversa(DONO_B, chatA.id)) === false);
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("C. CROSS-CHAT — o que atravessa e o que nao atravessa");
  // ═══════════════════════════════════════════════════════════════════
  {
    const linhasF: LinhaFonteMem[] = [];
    const portaF = criarPortaDeFontesFake(linhasF);
    const bytes = new Uint8Array([1, 2, 3]);

    // FONTE do agente, criada "no chat A".
    const fonte = await portaF.criar({
      userId: DONO_A, escopo: "agente", agenteId: AG_1, conversaId: null,
      nome: "entradas.xlsx", descricao: null, papel: "Entradas", tipo: "xlsx",
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      bytes, hashSha256: "a".repeat(64), substituiId: null,
    });
    // ANEXO, preso ao chat A.
    const anexo = await portaF.criar({
      userId: DONO_A, escopo: "conversa", agenteId: null, conversaId: chatA.id,
      nome: "temporario.csv", descricao: null, papel: null, tipo: "csv",
      mime: "text/csv", bytes, hashSha256: "b".repeat(64), substituiId: null,
    });

    const noChatA = criarFonteDeArquivoDasSources({
      porta: portaF, userId: DONO_A, agenteId: AG_1, conversaId: chatA.id });
    const noChatB = criarFonteDeArquivoDasSources({
      porta: portaF, userId: DONO_A, agenteId: AG_1, conversaId: chatB.id });

    ok("C1  FONTE do agente resolve no chat A",
      (await noChatA.resolver(DONO_A, fonte.id)) !== null);
    ok("C2  e resolve TAMBEM no chat B — ela e do agente, nao da conversa",
      (await noChatB.resolver(DONO_A, fonte.id)) !== null);

    ok("C3  ANEXO resolve no chat A", (await noChatA.resolver(DONO_A, anexo.id)) !== null);
    ok("C4  e NAO resolve no chat B — ele e da conversa",
      (await noChatB.resolver(DONO_A, anexo.id)) === null);
    ok("C5  nem num resolvedor SEM conversa",
      (await criarFonteDeArquivoDasSources({ porta: portaF, userId: DONO_A, agenteId: AG_1 })
        .resolver(DONO_A, anexo.id)) === null);

    // MEMORIA atravessa: ela e do agente, e o contexto e montado do
    // estado atual a cada turno — nao da conversa.
    const memorias = [memoriaFake("Mostre saldo primeiro.", 1)];
    const fontesDoAgente = (await portaF.listarDoAgente(DONO_A, AG_1)).map(paraModelo);
    const ctxA = montarContextoDoAgente({
      instrucoesDoAgente: "i", skills: [], memorias, fontes: fontesDoAgente });
    const ctxB = montarContextoDoAgente({
      instrucoesDoAgente: "i", skills: [], memorias, fontes: fontesDoAgente });
    ok("C6  MEMORIA aparece nos dois chats",
      ctxA.instrucao.includes("saldo primeiro") && ctxB.instrucao.includes("saldo primeiro"));
    ok("C7  e a FONTE tambem",
      ctxA.instrucao.includes("entradas.xlsx") && ctxB.instrucao.includes("entradas.xlsx"));
    ok("C8  mas o ANEXO do chat A NAO entra no contexto do agente",
      !ctxA.instrucao.includes("temporario.csv") &&
      !ctxB.instrucao.includes("temporario.csv"));
    ok("C9  e o HISTORICO nao entra na instrucao — ele viaja como dialogo",
      !ctxA.instrucao.includes("segredo do chat A"));
    ok("C10 nenhum caminho de storage no contexto",
      !/agente-fontes|dono-a\/agente/.test(ctxA.instrucao));
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("D. O runtime nao abre porta paralela");
  // ═══════════════════════════════════════════════════════════════════
  {
    const RT = semComentarios(ler("lib/agentes/conversas/runtime.ts"));
    ok("D1  o runtime NAO importa autorizarFuncao", !/autorizarFuncao/.test(RT));
    ok("D2  e NAO alcanca `.executor`", !/\.executor\b/.test(RT));
    ok("D3  e NAO importa resolverFuncao", !/resolverFuncao/.test(RT));
    ok("D4  CONTROLE: o detector veria a aresta se existisse",
      /autorizarFuncao/.test(`${RT} autorizarFuncao(`));
    ok("D5  ele passa pelo LACO, que conhece uma porta so",
      /conversarComFerramentas/.test(RT));
    ok("D6  a configuracao e lida a cada turno, nao guardada na conversa",
      /resolverFatosPermissoes/.test(RT) && /resolverSkillsDoAgente/.test(RT) &&
      /listarAtivas/.test(RT) && /listarDoAgente/.test(RT));
    ok("D7  o userId vem da ENTRADA, e o tipo o marca como da sessao",
      /Da SESSAO/.test(ler("lib/agentes/conversas/runtime.ts")));
    ok("D8  mensagem de provedor nao sobe crua ao cliente",
      /provedor_indisponivel/.test(RT) && !/erro:\s*String\(e/.test(RT));

    const REPO = semComentarios(ler("lib/agentes/conversas/repositorio.ts"));
    const corpos = REPO.split("from(TAB_").slice(1).map((c) => c.split("\n    async ")[0]);
    ok("D9  TODA operacao do repositorio filtra user_id",
      corpos.length >= 6 && corpos.every((c) =>
        c.includes('eq("user_id"') || c.includes("user_id: userId") ||
        c.includes("user_id: nova.userId")), String(corpos.length));
    ok("D10 a `ordem` e calculada no servidor, nunca recebida",
      /proximaOrdem/.test(REPO) && !/ordem: nova\.ordem/.test(REPO));
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("E. As rotas novas");
  // ═══════════════════════════════════════════════════════════════════
  {
    const base = join(RAIZ, "app", "api", "agentes", "[agenteId]");
    const novas = [
      "conversas/route.ts", "conversas/[conversaId]/route.ts",
      "memorias/route.ts", "memorias/[memoriaId]/route.ts",
      "fontes/route.ts", "fontes/[fonteId]/route.ts",
      "skills/route.ts", "skills/[skillId]/route.ts",
    ];
    for (const rel of novas) {
      const fonte = readFileSync(join(base, ...rel.split("/")), "utf8");
      const codigo = semComentarios(fonte);
      const nome = rel.replace("/route.ts", "");
      ok(`E1  ${nome}: atravessa a porta de autoridade`,
        /atravessarPorta\(request, params\.agenteId/.test(codigo));
      ok(`E2  ${nome}: NAO aceita userId do corpo nem da query`,
        !/corpo\.userId|corpo\.user_id|searchParams\.get\("userId"\)/.test(codigo));
      ok(`E3  ${nome}: NAO aceita caminho de storage`,
        !/caminho|bucket|storage_path|caminhoObjeto/i.test(codigo));
      ok(`E4  ${nome}: force-dynamic — resposta de agente nao e cacheavel`,
        /force-dynamic/.test(codigo));
    }
    ok("E5  CONTROLE: o detector veria `corpo.userId` se existisse",
      /corpo\.userId/.test("const u = corpo.userId;"));

    const rotaChat = semComentarios(
      readFileSync(join(base, "conversas", "[conversaId]", "route.ts"), "utf8"));
    ok("E6  o chat passa pelo RUNTIME, e nao pelo executor",
      /responderNaConversa/.test(rotaChat) && !/executarFuncao/.test(rotaChat));
    ok("E7  e o userId entregue ao runtime e o da porta",
      /userId: porta\.userId/.test(rotaChat));
    ok("E8  a resposta nao devolve requestId interno ao browser",
      !/requestId/.test(rotaChat.split("function paraUI")[1]?.split("}")[0] ?? ""));

    const rotaFontes = semComentarios(readFileSync(join(base, "fontes", "route.ts"), "utf8"));
    ok("E9  o upload decide o vinculo pelo ESCOPO, como o CHECK do banco",
      /escopo === "agente" \? porta\.agenteId : null/.test(rotaFontes) &&
      /escopo === "conversa" \? conversaId : null/.test(rotaFontes));
    ok("E10 e confere a conversa antes de aceitar anexo",
      /obterConversa/.test(rotaFontes));

    const PORTA = semComentarios(ler("lib/agentes/api/porta.ts"));
    ok("E11 a porta deriva o dono da SESSAO", /autenticarRequisicao/.test(PORTA) &&
      /auth\.uid/.test(PORTA));
    ok("E12 e confere posse do agente", /lerAgenteDoDono/.test(PORTA));
    ok("E13 'nao existe' e 'nao e seu' respondem igual",
      (PORTA.match(/Agente não encontrado/g) ?? []).length === 1);
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("F. A migration");
  // ═══════════════════════════════════════════════════════════════════
  {
    const MIG = ler("supabase/migrations/20261018_agente_conversas.sql");
    ok("F1  FK composta na conversa",
      /foreign key \(agente_id, user_id\)[\s\S]{0,120}references public\.agentes \(id, user_id\)/i
        .test(MIG));
    ok("F2  FK composta na mensagem",
      /foreign key \(conversa_id, user_id\)[\s\S]{0,140}references public\.agente_conversas \(id, user_id\)/i
        .test(MIG));
    ok("F3  ordem UNICA por conversa — historico nao se le diferente a cada vez",
      /unique \(conversa_id, ordem\)/i.test(MIG));
    ok("F4  NAO existe papel `sistema` — instrucao e montada, nao persistida",
      /papel in \('usuario', 'assistente'\)/i.test(MIG) && !/'sistema'/.test(MIG));
    ok("F5  aditiva: zero ALTER/DROP", !/alter table|drop table|drop column/i.test(MIG));
    ok("F6  e sem trigger que promova conversa a memoria",
      !/create trigger|create function/i.test(MIG));
    ok("F7  duas tabelas, exatamente",
      (MIG.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n")
        .match(/create table/gi) ?? []).length === 2);
    ok("F8  e ela existe como arquivo declarado",
      readdirSync(join(RAIZ, "supabase/migrations"))
        .filter((f) => f.startsWith("20261018")).length === 1);
  }

  console.log(`\n── placar ${"─".repeat(52)}`);
  console.log(`  PASS ${passou}   FAIL ${falhou}`);
}

void main().then(
  () => process.exit(falhou > 0 ? 1 : 0),
  (e) => { console.error("ERRO NAO TRATADO:", e); process.exit(1); }
);
