/**
 * CDS IA — APPROVAL-B1B. Suite da fundacao persistente de aprovacao.
 *
 * ── O que esta suite prova, e o que ela NAO prova ───────────────────
 *
 * Prova: que os helpers puros funcionam de verdade (executados, nao
 * inspecionados), e que a FONTE da migration e da persistencia respeita
 * o contrato fechado nos gates A0..A4.
 *
 * NAO prova que a migration roda no Postgres real. Nenhum assert aqui
 * afirma isso, e nenhum toca banco. A validacao contra o banco tem gate
 * proprio — APPROVAL-B1B-C0/C1/C2 —, e confundir "a fonte diz" com "o
 * banco aceita" seria exatamente o tipo de afirmacao que este repo
 * proibe.
 *
 * Rodar:  npx tsx scripts/testar-agentes-aprovacoes.ts
 * Sem rede, sem banco, sem IA, sem escrita.
 */
import "./_server-only-inerte";

import Module from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ErroArgumentoNaoCanonico,
  canonicalizar,
  hashDeArgumentos,
  impressaoDaAcao,
  type AcaoAprovavel,
} from "../lib/agentes/aprovacoes/identidade";

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
const ler = (rel: string) => readFileSync(join(RAIZ, rel), "utf8");

/** Comentarios saem ANTES de qualquer sonda: este repo documenta
 *  fartamente o que decidiu NAO fazer, e uma busca ingenua por
 *  `SECURITY DEFINER` casaria com a explicacao de por que ele nao esta
 *  la, reprovando pelo motivo errado. */
const semComentariosSql = (t: string) => t.replace(/--.*$/gm, "");
const semComentariosTs = (t: string) =>
  t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const MIGRATION = "supabase/migrations/20260928_agente_funcao_aprovacoes.sql";
const SQL_BRUTO = ler(MIGRATION);
const SQL = semComentariosSql(SQL_BRUTO);

const PERSISTENCIA = "lib/agentes/aprovacoes/persistencia.ts";
const STALE = "lib/agentes/aprovacoes/stale.ts";
const LEITURA = "lib/agentes/aprovacoes/leitura.ts";
const STALE_BRUTO = ler(STALE);
const STALE_CODIGO = semComentariosTs(STALE_BRUTO);

/** Varredura de fontes reais — a mesma que a secao O ja fazia local,
 *  extraida para que a secao Q prove a ausencia de consumidor sobre
 *  exatamente o mesmo universo. */
const varrerFontes = (dir: string): string[] => {
  const achados: string[] = [];
  const andar = (atual: string): void => {
    for (const e of readdirSync(join(RAIZ, atual), { withFileTypes: true })) {
      const rel = `${atual}/${e.name}`;
      if (e.isDirectory()) {
        if (!/node_modules|\.next/.test(e.name)) andar(rel);
      } else if (/\.tsx?$/.test(e.name)) {
        achados.push(rel);
      }
    }
  };
  andar(dir);
  return achados;
};
const PERS_BRUTO = ler(PERSISTENCIA);
const PERS = semComentariosTs(PERS_BRUTO);

const LEITURA_BRUTO = ler(LEITURA);
const LEIT = semComentariosTs(LEITURA_BRUTO);

const IDENTIDADE = semComentariosTs(ler("lib/agentes/aprovacoes/identidade.ts"));
const REGISTRO = semComentariosTs(ler("lib/agentes/chamadas/registro.ts"));
const GUARD = semComentariosTs(ler("lib/agentes/funcoes/guard.ts"));

const conjuntosIguais = (a: readonly string[], b: readonly string[]): boolean =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/**
 * Recorta o corpo de UMA funcao, do `create or replace` ate o `$$;` que
 * a fecha.
 *
 * ── Por que isto existe ─────────────────────────────────────────────
 *
 * As sondas anteriores fatiavam ate o fim do arquivo. `F9` so passava
 * porque a lista do INSERT empacota varias colunas por linha —
 * reformatar a migration a reprovaria sem que nada de errado tivesse
 * acontecido, e `K11` tinha a mesma forma. Sonda que depende de
 * formatacao alheia nao esta medindo o que diz medir.
 */
function corpoFuncao(nome: string): string {
  const inicio = SQL.indexOf(`create or replace function public.${nome}(`);
  if (inicio < 0) return "";
  const fim = SQL.indexOf("$$;", inicio);
  return fim < 0 ? SQL.slice(inicio) : SQL.slice(inicio, fim + 3);
}

const CORPO_CRIAR = corpoFuncao("aprovacao_criar");
const CORPO_DECIDIR = corpoFuncao("aprovacao_decidir");

/**
 * APPROVAL-DECISION-RESUME-D4 — a migration que RECRIOU `aprovacao_decidir`
 * para encerrar a tarefa causal.
 *
 * O Postgres nao versiona funcao por migration de origem: o estado real
 * da RPC e o DESTA, nao o da 1E-b. Por isso a secao J acima continua
 * valendo como documento HISTORICO — ela descreve o corpo que a 20260928
 * criou — e a secao W abaixo e a AUTORIDADE sobre o contrato vigente.
 */
const MIGRATION_D4 = "supabase/migrations/20261004_aprovacao_decidir_encerra_tarefa.sql";
const SQL_D4_BRUTO = ler(MIGRATION_D4);
const SQL_D4 = semComentariosSql(SQL_D4_BRUTO);
const CORPO_CONSUMIR = corpoFuncao("aprovacao_consumir_e_abrir");

// ─── A. A pasta nova ──────────────────────────────────────────────────

secao("A. A pasta de aprovacoes tem exatamente os modulos autorizados");
{
  // `stale.ts` entrou no APPROVAL-B1D-D1 e `observabilidade-stale.ts` no
  // D2-I1: o primeiro le UMA pagina de aberturas stale, o segundo
  // percorre paginas e agrega. Nenhum dos dois escreve, e nenhum toca
  // lifecycle. A exigencia nao afrouxou — continua igualdade de conjunto
  // nos DOIS sentidos, e a ausencia de qualquer um dos quatro reprova.
  //
  // A1 (APPROVAL-UI-API-A1): o quinto modulo e a fila do dono. Ele le,
  // e so: nenhuma RPC, nenhuma escrita, nenhum lifecycle. A exigencia
  // continua igualdade de conjunto nos dois sentidos.
  const AUTORIZADOS = [
    "identidade.ts",
    "persistencia.ts",
    "stale.ts",
    "observabilidade-stale.ts",
    "leitura.ts",
  ];
  const conteudo = readdirSync(join(RAIZ, "lib", "agentes", "aprovacoes")).sort();

  ok(`A1  lib/agentes/aprovacoes contem exatamente os modulos declarados (${conteudo.join(", ")})`,
    conjuntosIguais(conteudo, AUTORIZADOS));
  ok("A2  CONTROLE: um modulo extra reprovaria",
    !conjuntosIguais([...AUTORIZADOS, "rotas.ts"], AUTORIZADOS));
  ok("A2b CONTROLE: o observador ausente reprovaria",
    !conjuntosIguais(["identidade.ts", "persistencia.ts", "stale.ts"], AUTORIZADOS));
  ok("A2c CONTROLE: o detector ausente reprovaria",
    !conjuntosIguais(["identidade.ts", "persistencia.ts", "observabilidade-stale.ts"], AUTORIZADOS));
  ok("A2d CONTROLE: a fila ausente reprovaria",
    !conjuntosIguais(
      ["identidade.ts", "persistencia.ts", "stale.ts", "observabilidade-stale.ts"],
      AUTORIZADOS));
  ok("A3  CONTROLE: a pasta vazia reprovaria", !conjuntosIguais([], AUTORIZADOS));
  ok("A4  ANCORA: a migration foi lida de verdade", SQL_BRUTO.length > 5000);
}

// ─── B. Canonicalizacao, executada ────────────────────────────────────

secao("B. Canonicalizacao determinista");
{
  ok("B1  ordem de chave nao muda o canonico",
    canonicalizar({ a: 1, b: 2 }) === canonicalizar({ b: 2, a: 1 }));
  ok("B2  e nem o hash",
    hashDeArgumentos({ a: 1, b: 2 }) === hashDeArgumentos({ b: 2, a: 1 }));
  ok("B3  aninhado tambem ordena",
    hashDeArgumentos({ x: { p: 1, q: 2 } }) === hashDeArgumentos({ x: { q: 2, p: 1 } }));

  ok("B4  ordem de ARRAY e significativa",
    hashDeArgumentos({ l: [1, 2] }) !== hashDeArgumentos({ l: [2, 1] }));
  ok("B5  valor diferente muda o hash",
    hashDeArgumentos({ a: 1 }) !== hashDeArgumentos({ a: 2 }));
  ok("B6  chave diferente muda o hash",
    hashDeArgumentos({ a: 1 }) !== hashDeArgumentos({ b: 1 }));

  ok("B7  o hash e sha256 em hex minusculo", /^[0-9a-f]{64}$/.test(hashDeArgumentos({})));
  ok("B8  null, boolean e string atravessam",
    canonicalizar({ n: null, b: true, s: "x" }) === '{"b":true,"n":null,"s":"x"}');
  ok("B9  numero finito e canonico", canonicalizar({ v: 1.0 }) === '{"v":1}');

  const recusa = (nome: string, valor: unknown) => {
    let recusou = false;
    try {
      canonicalizar(valor);
    } catch (e) {
      recusou = e instanceof ErroArgumentoNaoCanonico;
    }
    ok(`B10 recusa ${nome}`, recusou);
  };

  recusa("undefined", { v: undefined });
  recusa("NaN", { v: NaN });
  recusa("Infinity", { v: Infinity });
  recusa("-Infinity", { v: -Infinity });
  recusa("BigInt", { v: BigInt(1) });
  recusa("Date", { v: new Date(0) });
  recusa("Map", { v: new Map() });
  recusa("Set", { v: new Set() });
  recusa("function", { v: () => 1 });
  recusa("symbol", { v: Symbol("x") });
  recusa("chave de symbol", { [Symbol("k")]: 1 });

  const ciclico: Record<string, unknown> = {};
  ciclico.eu = ciclico;
  recusa("ciclo", ciclico);

  // Mesmo objeto em ramos irmaos NAO e ciclo, e recusar seria recusar um
  // argumento valido.
  const compartilhado = { a: 1 };
  ok("B11 objeto repetido em ramos irmaos e aceito",
    canonicalizar({ x: compartilhado, y: compartilhado }) === '{"x":{"a":1},"y":{"a":1}}');

  ok("B12 CONTROLE: um argumento valido NAO e recusado",
    canonicalizar({ dataInicio: "2026-08-01" }) === '{"dataInicio":"2026-08-01"}');

  // ── Accessors: recusados E nunca executados ──────────────────────
  //
  // Provar a recusa nao basta. Se o getter rodasse antes da recusa, ele
  // ja teria produzido efeito colateral, e `argumentos_hash` poderia
  // descrever um valor diferente do que sera persistido — o hash seria
  // calculado sobre uma leitura e o banco guardaria outra.
  //
  // O teste observa SO o contador; nada aqui toca `.espiao` antes da
  // chamada, senao a prova mediria o proprio teste.
  let vezesGetter = 0;
  const comGetter: Record<string, unknown> = {};
  Object.defineProperty(comGetter, "espiao", {
    enumerable: true,
    configurable: true,
    get() {
      vezesGetter++;
      return 1;
    },
  });

  let recusouGetter = false;
  try {
    canonicalizar(comGetter);
  } catch (e) {
    recusouGetter = e instanceof ErroArgumentoNaoCanonico;
  }
  ok("B15 getter enumeravel e RECUSADO", recusouGetter);
  ok("B16 e o getter NAO foi executado", vezesGetter === 0, `vezes=${vezesGetter}`);

  let vezesSetter = 0;
  const comSetter: Record<string, unknown> = {};
  Object.defineProperty(comSetter, "so_setter", {
    enumerable: true,
    configurable: true,
    set() {
      vezesSetter++;
    },
  });

  let recusouSetter = false;
  try {
    canonicalizar(comSetter);
  } catch (e) {
    recusouSetter = e instanceof ErroArgumentoNaoCanonico;
  }
  ok("B17 setter-only enumeravel e RECUSADO — nao vira undefined", recusouSetter);
  ok("B18 e o setter nao foi tocado", vezesSetter === 0);

  ok("B19 a implementacao usa descritor, nunca acesso por indice",
    /Object\.getOwnPropertyDescriptor\(bruto, chave\)/.test(IDENTIDADE) &&
    /descritor\.value/.test(IDENTIDADE) &&
    !/escrever\(bruto\[chave\]/.test(IDENTIDADE));

  // Object.create(null) continua aceito: e dado JSON puro, sem
  // prototipo e sem accessor.
  const semProto = Object.create(null) as Record<string, unknown>;
  semProto.a = 1;
  ok("B20 Object.create(null) com dados puros continua aceito",
    canonicalizar(semProto) === '{"a":1}');

  ok("B13 ordenacao NAO usa localeCompare", !/localeCompare/.test(IDENTIDADE));
  ok("B14 e usa sort() padrao", /Object\.keys\(bruto\)\.sort\(\)/.test(IDENTIDADE));
}

// ─── C. Fingerprint ───────────────────────────────────────────────────

secao("C. A impressao da acao discrimina o que precisa");
{
  const BASE: AcaoAprovavel = {
    userId: "u1",
    agenteId: "ag1",
    tarefaId: null,
    funcaoId: "vendas.consultar",
    revisaoFuncao: "1",
    conexaoLojaId: null,
    argumentosHash: hashDeArgumentos({ dataInicio: "2026-08-01" }),
  };
  const base = impressaoDaAcao(BASE);

  const difere = (nome: string, mudanca: Partial<AcaoAprovavel>) =>
    ok(`C1  ${nome} muda a impressao`, impressaoDaAcao({ ...BASE, ...mudanca }) !== base);

  difere("user diferente", { userId: "u2" });
  difere("agente diferente", { agenteId: "ag2" });
  difere("tarefa diferente", { tarefaId: "tf1" });
  difere("funcao diferente", { funcaoId: "outra.funcao" });
  difere("revisao diferente", { revisaoFuncao: "2" });
  difere("loja diferente", { conexaoLojaId: "loja-a" });
  difere("argumentos diferentes", { argumentosHash: hashDeArgumentos({ dataInicio: "2026-08-02" }) });

  ok("C2  loja NULL e loja preenchida sao acoes diferentes",
    impressaoDaAcao({ ...BASE, conexaoLojaId: null }) !==
      impressaoDaAcao({ ...BASE, conexaoLojaId: "loja-a" }));
  ok("C3  duas lojas distintas nao deduplicam entre si",
    impressaoDaAcao({ ...BASE, conexaoLojaId: "loja-a" }) !==
      impressaoDaAcao({ ...BASE, conexaoLojaId: "loja-b" }));
  ok("C4  a mesma acao da a mesma impressao", impressaoDaAcao({ ...BASE }) === base);
  ok("C5  a impressao e sha256 hex minusculo", /^[0-9a-f]{64}$/.test(base));

  // Os sete campos, nominalmente, na ordem fixa do contrato.
  const CAMPOS = ["user_id", "agente_id", "tarefa_id", "funcao_id", "revisao_funcao", "conexao_loja_id", "argumentos_hash"];
  ok("C6  a impressao usa exatamente os 7 campos declarados",
    CAMPOS.every((c) => new RegExp(`${c}:`).test(IDENTIDADE)));
  ok("C7  e NAO inclui acesso, plataforma, recurso nem request_id_solicitacao",
    !/acesso:|plataforma:|recurso:|requestIdSolicitacao/.test(IDENTIDADE));
}

// ─── D. Schema da migration ───────────────────────────────────────────

secao("D. A tabela tem a forma fechada no desenho");
{
  const corpo = SQL.slice(SQL.indexOf("create table"), SQL.indexOf("create unique index"));

  const COLUNAS = [
    "id", "user_id", "agente_id", "tarefa_id", "funcao_id", "revisao_funcao", "acesso",
    "conexao_plataforma", "conexao_recurso", "conexao_loja_id",
    "argumentos", "argumentos_hash", "fingerprint", "estado", "criado_em", "expira_em",
    "request_id_solicitacao", "decidido_por", "decidido_em", "motivo_recusa",
    "cancelado_por", "cancelado_em", "consumida_em", "request_id_consumo",
  ];
  ok(`D1  as 24 colunas declaradas estao presentes (${COLUNAS.length})`,
    COLUNAS.length === 24 && COLUNAS.every((c) => new RegExp(`^\\s+${c}\\s`, "m").test(corpo)));

  const CHECKS = [
    "estado_valido", "funcao_id_formato", "revisao_nao_vazia", "acesso_valido", "ttl_24h",
    "argumentos_objeto", "argumentos_hash_sha256", "fingerprint_sha256", "sem_segredo",
    "par_decisao", "par_cancelamento", "par_consumo", "par_requisito_conexao",
    "requisito_nao_vazio", "decisao_obrigatoria", "cancelamento_bidirecional",
    "consumo_bidirecional", "motivo_so_em_rejeitada", "pendente_sem_decisao",
  ];
  ok(`D2  os 19 CHECKs nominais existem (${CHECKS.length})`,
    CHECKS.length === 19 && CHECKS.every((c) => SQL.includes(`agente_funcao_aprovacoes_${c}`)));
  ok("D3  e o arquivo declara exatamente 19 constraints CHECK",
    (SQL.match(/check \(/g) ?? []).length === 19,
    String((SQL.match(/check \(/g) ?? []).length));

  ok("D4  as 3 FKs compostas existem",
    (SQL.match(/foreign key \(/g) ?? []).length === 3 &&
      /foreign key \(agente_id, user_id\) references public\.agentes/.test(SQL) &&
      /foreign key \(tarefa_id, user_id\) references public\.agente_tarefas/.test(SQL) &&
      /foreign key \(conexao_loja_id, user_id\) references public\.lojas/.test(SQL));
  ok("D5  todas RESTRICT nos dois lados",
    (SQL.match(/on update restrict on delete restrict/g) ?? []).length === 3);
  ok("D6  nenhuma CASCADE", !/cascade/i.test(SQL));

  ok("D7  exatamente 3 indices explicitos",
    (SQL.match(/create (unique )?index/g) ?? []).length === 3);
  // A sonda de `now()` precisa olhar CADA statement de indice, nao o
  // arquivo inteiro: `now()` aparece legitimamente nas RPCs, e um
  // `[\s\S]*?` solto atravessaria ate la e acusaria o inocente.
  const statementsIndice = SQL.match(/create (unique )?index[\s\S]*?;/g) ?? [];
  ok("D8  o unico parcial de ativa existe, e nenhum indice usa now() no predicado",
    statementsIndice.some((i) =>
      /agente_funcao_aprovacoes_ativa_por_acao/.test(i) &&
      /\(user_id, fingerprint\)/.test(i) &&
      /where estado in \('pendente', 'aprovada'\)/.test(i)) &&
      !statementsIndice.some((i) => /now\(\)/.test(i)),
    String(statementsIndice.length));
  ok("D9  o unico parcial de consumo",
    /agente_funcao_aprovacoes_consumo_unico[\s\S]*?\(user_id, request_id_consumo\)[\s\S]*?where request_id_consumo is not null/.test(SQL));

  ok("D10 exatamente 3 RPCs",
    (SQL.match(/create or replace function/g) ?? []).length === 3 &&
      /function public\.aprovacao_criar\(/.test(SQL) &&
      /function public\.aprovacao_decidir\(/.test(SQL) &&
      /function public\.aprovacao_consumir_e_abrir\(/.test(SQL));
  ok("D11 zero trigger", !/create trigger|create or replace trigger/i.test(SQL));
  ok("D12 zero RLS e zero policy", !/row level security|create policy/i.test(SQL));
  ok("D13 zero SECURITY DEFINER", !/security definer/i.test(SQL));
  ok("D14 as 3 sao SECURITY INVOKER com search_path",
    (SQL.match(/security invoker/g) ?? []).length === 3 &&
      (SQL.match(/set search_path = public/g) ?? []).length === 3);
  ok("D15 CONTROLE: a sonda de DEFINER acharia o padrao",
    /security definer/i.test("SECURITY DEFINER"));
}

// ─── E. Segredo ───────────────────────────────────────────────────────

secao("E. O CHECK de segredo e recursivo e sem distincao de caixa");
{
  const PROIBIDAS = ["token", "access_token", "refresh_token", "secret", "client_secret",
    "authorization", "cookie", "credential", "senha", "password"];

  ok("E1  usa jsonb_path_exists", /not jsonb_path_exists\(/.test(SQL));
  ok("E2  restringe a objeto ANTES de keyvalue()",
    /\$\.\*\* \? \(@\.type\(\) == "object"\)\.keyvalue\(\)/.test(SQL));
  ok("E3  busca recursiva com $.**", /\$\.\*\*/.test(SQL));
  ok("E4  case-insensitive por flag \"i\"", /flag "i"/.test(SQL));
  ok("E5  regex ancorada nos dois lados", /like_regex "\^\(/.test(SQL) && /\)\$" flag/.test(SQL));
  ok(`E6  as 10 chaves proibidas estao na regex`,
    PROIBIDAS.length === 10 && PROIBIDAS.every((k) => new RegExp(`[|(]${k}[|)]`).test(SQL)));
  ok("E7  NAO usa o operador ?| de topo, que seria case-sensitive e raso",
    !/argumentos \?\|/.test(SQL));
  ok("E8  a garantia honesta esta escrita na fonte",
    /nome inocente/i.test(SQL_BRUTO) && /NOMES DE CHAVE/i.test(SQL_BRUTO));
}

// ─── F. Privilegios ───────────────────────────────────────────────────

secao("F. O modelo de privilegios neutraliza os defaults");
{
  const INSERT_COLS = ["user_id", "agente_id", "tarefa_id", "funcao_id", "revisao_funcao",
    "acesso", "conexao_plataforma", "conexao_recurso", "conexao_loja_id",
    "argumentos", "argumentos_hash", "fingerprint"];
  const UPDATE_COLS = ["estado", "decidido_por", "decidido_em", "motivo_recusa",
    "cancelado_por", "cancelado_em", "consumida_em", "request_id_consumo"];

  const posRevokeService = SQL.indexOf("revoke all on table public.agente_funcao_aprovacoes from service_role");
  const posPrimeiroGrant = SQL.indexOf("grant select on table public.agente_funcao_aprovacoes");

  ok("F1  REVOKE ALL da tabela para os QUATRO papeis",
    ["public", "anon", "authenticated", "service_role"].every((p) =>
      SQL.includes(`revoke all on table public.agente_funcao_aprovacoes from ${p};`)));
  ok("F2  o REVOKE de service_role vem ANTES dos grants",
    posRevokeService > 0 && posPrimeiroGrant > posRevokeService,
    `revoke@${posRevokeService} grant@${posPrimeiroGrant}`);

  ok("F3  NAO existe GRANT INSERT table-wide",
    !/grant insert on table public\.agente_funcao_aprovacoes/.test(SQL));
  ok("F4  NAO existe GRANT UPDATE table-wide",
    !/grant update on table public\.agente_funcao_aprovacoes/.test(SQL));
  ok("F5  CONTROLE: a sonda acharia um grant table-wide",
    /grant insert on table public\.agente_funcao_aprovacoes/.test(
      "grant insert on table public.agente_funcao_aprovacoes to service_role;"));

  const blocoInsert = SQL.slice(SQL.indexOf("grant insert ("), SQL.indexOf("grant update ("));
  const blocoUpdate = SQL.slice(SQL.indexOf("grant update ("), SQL.indexOf("comment on table"));

  ok(`F6  o GRANT INSERT lista exatamente as 12 colunas (${INSERT_COLS.length})`,
    INSERT_COLS.length === 12 && INSERT_COLS.every((c) => new RegExp(`^\\s+${c},?$`, "m").test(blocoInsert)));
  ok("F7  e NAO inclui estado, criado_em, expira_em nem lifecycle",
    !/^\s+(estado|criado_em|expira_em|request_id_solicitacao|decidido_por|consumida_em|request_id_consumo),?$/m.test(blocoInsert));
  ok(`F8  o GRANT UPDATE lista exatamente as 8 de lifecycle (${UPDATE_COLS.length})`,
    UPDATE_COLS.length === 8 && UPDATE_COLS.every((c) => new RegExp(`^\\s+${c},?$`, "m").test(blocoUpdate)));
  ok("F9  e NAO inclui nenhum campo congelado",
    !/^\s+(argumentos|argumentos_hash|fingerprint|revisao_funcao|acesso|conexao_loja_id|criado_em|expira_em),?$/m.test(blocoUpdate));

  ok("F10 sem DELETE, TRUNCATE, REFERENCES ou TRIGGER concedidos",
    !/grant[^;]*\b(delete|truncate|references|trigger)\b[^;]*agente_funcao_aprovacoes/.test(SQL));
  ok("F11 anon e authenticated ficam sem nenhum grant",
    !/grant[^;]*to (anon|authenticated)/.test(SQL));

  // EXECUTE das RPCs: 4 revokes e 1 grant para cada uma das 3.
  ok("F12 EXECUTE revogado dos quatro papeis, nas 3 RPCs",
    (SQL.match(/revoke all on function/g) ?? []).length === 12);
  ok("F13 e concedido somente a service_role",
    (SQL.match(/grant execute on function/g) ?? []).length === 3 &&
      !/grant execute on function[^;]*to (anon|authenticated|public)/.test(SQL));
}

// ─── G. TTL e estado inicial ──────────────────────────────────────────

secao("G. TTL e estado inicial pertencem ao banco");
{
  ok("G1  estado nasce pendente por DEFAULT", /estado text not null default 'pendente'/.test(SQL));
  ok("G2  criado_em usa now()", /criado_em timestamptz not null default now\(\)/.test(SQL));
  ok("G3  expira_em usa now\\(\\) \\+ 24 horas",
    /expira_em timestamptz not null default \(now\(\) \+ interval '24 hours'\)/.test(SQL));
  ok("G4  o CHECK prende a igualdade, nao apenas a ordem",
    /check \(expira_em = criado_em \+ interval '24 hours'\)/.test(SQL));
  ok("G5  NAO usa clock_timestamp", !/clock_timestamp/.test(SQL));
  ok("G6  a fonte registra por que a igualdade e necessaria",
    /prenderia so a DURACAO/i.test(SQL_BRUTO));

  const insercao = SQL.slice(SQL.indexOf("insert into public.agente_funcao_aprovacoes ("));
  const listaInsert = insercao.slice(0, insercao.indexOf(")"));
  ok("G7  o INSERT da RPC nao cita estado, criado_em nem expira_em",
    !/\b(estado|criado_em|expira_em|request_id_solicitacao)\b/.test(listaInsert));
  ok("G8  nem qualquer campo de lifecycle",
    !/\b(decidido_por|decidido_em|motivo_recusa|cancelado_por|cancelado_em|consumida_em|request_id_consumo)\b/.test(listaInsert));
}

// ─── H. Dedupe ────────────────────────────────────────────────────────

secao("H. Dedupe pelo indice, nunca por EXCEPTION");
{
  const criar = CORPO_CRIAR;

  ok("H1  usa ON CONFLICT com a chave tenant-scoped do indice parcial",
    /on conflict \(user_id, fingerprint\) where estado in \('pendente', 'aprovada'\)/.test(criar));
  ok("H1a CONTROLE: a chave antiga, so por fingerprint, reprovaria",
    !/on conflict \(user_id, fingerprint\)/.test("on conflict (fingerprint) where estado in ('pendente','aprovada')"));
  ok("H2  DO NOTHING com RETURNING", /do nothing[\s\S]{0,80}returning/.test(criar));
  ok("H3  nenhum bloco EXCEPTION no fluxo de criacao", !/exception/i.test(criar));
  ok("H4  a expiracao e materializada antes do INSERT",
    criar.indexOf("set estado = 'expirada'") < criar.indexOf("insert into public.agente_funcao_aprovacoes"));
  ok("H5  e a fonte explica por que EXCEPTION reverteria o UPDATE",
    /subtransacao/i.test(SQL_BRUTO) && /rollback dela apagaria/i.test(SQL_BRUTO));
  // ── Escopo de tenant da mutacao (achado 1 do R4) ─────────────────
  //
  // O R4 encontrou o UPDATE de expiracao escopado SO por fingerprint,
  // enquanto as outras duas RPCs ja escopavam por `user_id`. Como
  // `p_fingerprint` e parametro cru, um valor arbitrario alcancaria a
  // linha de outro dono. Estes asserts existem porque os 165 anteriores
  // NAO teriam pego isso.
  const expiryCriar = /update public\.agente_funcao_aprovacoes\s+set estado = 'expirada'([\s\S]*?);/.exec(criar)?.[1] ?? "";

  ok("H7  o UPDATE de expiracao de criar existe e foi recortado", expiryCriar.length > 0);
  ok("H8  ele e escopado por user_id", /user_id = p_user_id/.test(expiryCriar));
  ok("H9  e por fingerprint", /fingerprint = p_fingerprint/.test(expiryCriar));
  ok("H10 os dois no MESMO UPDATE, nao em statements diferentes",
    /user_id = p_user_id/.test(expiryCriar) && /fingerprint = p_fingerprint/.test(expiryCriar));

  // CONTROLE NEGATIVO que teria REPROVADO o SQL do R4: o mesmo corpo,
  // com o escopo de tenant removido.
  const semTenant = expiryCriar.replace(/\s*and user_id = p_user_id/, "").replace(/user_id = p_user_id\s*and\s*/, "");
  ok("H11 CONTROLE: o corpo do R4, sem user_id, REPROVA",
    !/user_id = p_user_id/.test(semTenant) && expiryCriar !== semTenant);

  // As TRES RPCs precisam concordar: nenhuma expiracao sem tenant.
  const expiries = [CORPO_CRIAR, CORPO_DECIDIR, CORPO_CONSUMIR].map((c) =>
    /set estado = 'expirada'([\s\S]*?);/.exec(c)?.[1] ?? "");
  ok("H12 as tres RPCs escopam a expiracao por user_id",
    expiries.length === 3 && expiries.every((e) => /user_id = p_user_id/.test(e)));

  // O SELECT de reutilizacao nunca pode olhar outro tenant.
  const reuso = criar.slice(criar.indexOf("select a.id into v_id"));
  ok("H13 o SELECT de reutilizacao e escopado por user_id e fingerprint",
    /a\.user_id = p_user_id/.test(reuso) && /a\.fingerprint = p_fingerprint/.test(reuso));
  ok("H14 e so considera aprovacao ainda valida", /a\.expira_em > now\(\)/.test(reuso));

  // ── Ordem: autoridades ANTES da primeira mutacao ─────────────────
  //
  // ── Por que o detector e UM SO ───────────────────────────────────
  //
  // A versao anterior tinha a regra escrita inline no positivo e uma
  // comparacao reduzida, sobre uma string sintetica, no negativo. O
  // controle negativo entao nao provava nada sobre o detector: provava
  // que uma string inventada tinha `indexOf` numa certa ordem. Um
  // regresso que afrouxasse o positivo deixaria o negativo verde.
  //
  // Agora as duas pontas chamam `ordemCriarCorreta`, e o negativo
  // exercita exatamente a mesma logica que o positivo.
  const MARCOS_ORDEM: readonly [string, string][] = [
    ["ownership do agente", "from public.agentes a"],
    ["autoridade da tarefa", "from public.agente_tarefas t"],
    ["permissao", "from public.agente_permissoes p"],
    ["autoridade da conexao", "from public.agente_conexoes c"],
    ["primeira mutacao de expiry", "set estado = 'expirada'"],
  ];

  /**
   * `true` somente quando os cinco marcos existem E aparecem na ordem
   * exigida. Marcador ausente devolve `false` — `indexOf` retorna -1, e
   * sem esta guarda dois ausentes "ordenariam" entre si e produziriam um
   * verde por acidente.
   */
  const ordemCriarCorreta = (corpo: string): boolean => {
    const posicoes = MARCOS_ORDEM.map(([, marcador]) => corpo.indexOf(marcador));
    if (posicoes.some((p) => p < 0)) return false;
    return posicoes.every((p, i) => i === 0 || p > posicoes[i - 1]);
  };

  ok("H15 as quatro autoridades sao verificadas antes da primeira mutacao",
    ordemCriarCorreta(criar),
    MARCOS_ORDEM.map(([nome, m]) => `${nome}=${criar.indexOf(m)}`).join(" "));

  // ── A fixture negativa deriva do corpo REAL ──────────────────────
  //
  // Recorta o statement de expiracao de onde ele esta e o reinsere logo
  // antes da checagem de permissao. Os cinco marcos continuam no corpo —
  // o detector precisa reprovar por ORDEM, nunca por marcador que sumiu.
  const stmtExpiry = /( *update public\.agente_funcao_aprovacoes\s+set estado = 'expirada'[\s\S]*?;\n)/.exec(criar)?.[1] ?? "";
  const semExpiry = criar.replace(stmtExpiry, "");
  const alvoPermissao = semExpiry.indexOf("  select p.nivel into v_nivel");
  const criarOrdemInvalida =
    semExpiry.slice(0, alvoPermissao) + stmtExpiry + semExpiry.slice(alvoPermissao);

  ok("H16a a fixture negativa foi construida a partir do corpo real",
    stmtExpiry.length > 0 && alvoPermissao > 0 && criarOrdemInvalida !== criar);
  ok("H16b e os cinco marcos continuam presentes nela",
    MARCOS_ORDEM.every(([, m]) => criarOrdemInvalida.includes(m)));
  ok("H16c a mutacao ficou ANTES da permissao, que deveria precede-la",
    criarOrdemInvalida.indexOf("set estado = 'expirada'") <
      criarOrdemInvalida.indexOf("from public.agente_permissoes p"));

  ok("H16 CONTROLE: o MESMO detector reprova a ordem invalida",
    !ordemCriarCorreta(criarOrdemInvalida));
  ok("H16d CONTROLE: e reprova tambem um corpo com marcador ausente",
    !ordemCriarCorreta(criar.replace("from public.agente_conexoes c", "")));

  const posMutacao = criar.indexOf("set estado = 'expirada'");
  ok("H17 a primeira mutacao da funcao e mesmo a expiracao",
    posMutacao > 0 && posMutacao < criar.indexOf("insert into public.agente_funcao_aprovacoes"));

  ok("H6  devolve criada ou reutilizada, nunca fingindo criacao",
    /'criada'/.test(criar) && /'reutilizada'/.test(criar));
}

// ─── I. Criacao: autoridades ──────────────────────────────────────────

secao("I. A RPC de criacao revalida tudo que e do banco");
{
  const criar = CORPO_CRIAR;

  ok("I1  posse do agente", /from public\.agentes a[\s\S]{0,120}a\.user_id = p_user_id/.test(criar));
  ok("I2  tarefa: mesmo dono E mesmo agente",
    /from public\.agente_tarefas t[\s\S]{0,180}t\.agente_id = p_agente_id/.test(criar));
  ok("I3  exige nivel = aprovacao", /v_nivel <> 'aprovacao'/.test(criar));
  ok("I4  recusa permissao ausente", /'permissao_ausente'/.test(criar));
  ok("I5  alvo de conexao completo, incluindo loja",
    /from public\.agente_conexoes c[\s\S]{0,320}c\.loja_id = p_conexao_loja_id/.test(criar));
  ok("I6  nao aceita 'qualquer conexao do agente'",
    /c\.plataforma = p_conexao_plataforma[\s\S]{0,120}c\.recurso = p_conexao_recurso/.test(criar));
  ok("I7  nao recebe p_expira_em", !/p_expira_em/.test(SQL));
}

// ─── J. Decisao ───────────────────────────────────────────────────────

secao("J. Decidir tem caminhos separados");
{
  const decidir = CORPO_DECIDIR;

  ok("J1  aprovar so de pendente e nao vencida",
    /set estado = 'aprovada'[\s\S]{0,220}estado = 'pendente'[\s\S]{0,60}expira_em > now\(\)/.test(decidir));
  ok("J2  rejeitar so de pendente",
    /set estado = 'rejeitada'[\s\S]{0,260}estado = 'pendente'/.test(decidir));
  ok("J3  cancelar aceita pendente OU aprovada",
    /set estado = 'cancelada'[\s\S]{0,240}estado in \('pendente', 'aprovada'\)/.test(decidir));
  ok("J4  cancelar NAO toca decidido_por/em",
    !/set estado = 'cancelada'[\s\S]{0,200}decidido_por =/.test(decidir));
  ok("J5  decidido_por deriva de p_user_id, e nao e parametro",
    /decidido_por = p_user_id/.test(decidir) && !/p_decidido_por/.test(SQL));
  ok("J6  motivo em branco vira NULL", /nullif\(btrim\(coalesce\(p_motivo/.test(decidir));
  ok("J7  a expiracao altera SOMENTE estado",
    /set estado = 'expirada'\s*\n\s*where id = p_aprovacao_id/.test(decidir));
  ok("J8  duplo clique recebe o estado terminal, sem efeito",
    /'ja_aprovada'/.test(decidir) && /'ja_rejeitada'/.test(decidir) &&
      /'ja_cancelada'/.test(decidir) && /'ja_consumida'/.test(decidir));
  ok("J9  outro dono e inexistente sao indistinguiveis",
    /'aprovacao_inexistente'/.test(decidir) && /a\.user_id = p_user_id/.test(decidir));
  ok("J10 decisao fora do vocabulario e recusada", /'decisao_invalida'/.test(decidir));
}

// ─── K. Consumo ───────────────────────────────────────────────────────

secao("K. Consumo e abertura na mesma transacao");
{
  const consumir = CORPO_CONSUMIR;

  ok("K1  trava a linha com FOR UPDATE", /for update;/.test(consumir));
  ok("K2  compara a revisao", /ap\.revisao_funcao is distinct from p_revisao_atual/.test(consumir));
  ok("K3  escrita e recusada ANTES do consumo",
    consumir.indexOf("'escrita_nao_suportada'") < consumir.indexOf("set estado = 'consumida'"));
  ok("K4  permissao atual aceita aprovacao e automatico",
    /v_nivel not in \('aprovacao', 'automatico'\)/.test(consumir));
  ok("K5  permissao ausente e bloqueada param",
    /'permissao_ausente'/.test(consumir) && /'permissao_bloqueada'/.test(consumir));
  ok("K6  o alvo de conexao e reconferido com a MESMA loja",
    /c\.loja_id = ap\.conexao_loja_id/.test(consumir));
  ok("K7  o claim exige estado aprovada",
    /set estado = 'consumida'[\s\S]{0,200}and estado = 'aprovada'/.test(consumir));
  ok("K8  rowCount 0 significa que outro venceu",
    /v_afetadas <> 1 then return 'ja_consumida'/.test(consumir));
  ok("K9  a abertura vem DEPOIS do claim, na mesma funcao",
    consumir.indexOf("set estado = 'consumida'") < consumir.indexOf("insert into public.agente_funcao_chamadas"));
  ok("K10 posse do agente e da tarefa revalidadas aqui dentro",
    /from public\.agentes a[\s\S]{0,140}a\.user_id = p_user_id/.test(consumir) &&
      /t\.agente_id = ap\.agente_id/.test(consumir));
  ok("K11 nenhum authority field vem por parametro",
    !/p_funcao_id|p_acesso|p_conexao_|p_agente_id/.test(consumir));
  ok("K12 a RPC NAO executa a Funcao", !/executor|executarFuncao/i.test(consumir));
}

// ─── L. A abertura: mesmo shape de registrarAbertura ──────────────────

secao("L. A abertura da Tool Call tem o shape nominal de registro.ts");
{
  // Do lado TypeScript: `colunasBase` mais o que `registrarAbertura`
  // acrescenta. Extraido da fonte, nao transcrito.
  const base = /function colunasBase[\s\S]*?\n\}/.exec(REGISTRO)?.[0] ?? "";
  const colunasBase = [...base.matchAll(/^\s{4}([a-z_]+):/gm)].map((m) => m[1]);

  const abertura = REGISTRO.slice(REGISTRO.indexOf("export async function registrarAbertura"));
  const corpoInserir = abertura.slice(abertura.indexOf("return inserir({"), abertura.indexOf("});"));
  const extras = [...corpoInserir.matchAll(/^\s{4}([a-z_]+):/gm)].map((m) => m[1]);

  const doTypeScript = [...colunasBase, ...extras];

  // Do lado SQL: a lista de colunas do INSERT da RPC.
  const insercao = SQL.slice(SQL.indexOf("insert into public.agente_funcao_chamadas ("));
  const lista = insercao.slice(insercao.indexOf("(") + 1, insercao.indexOf(")"));
  const doSql = lista.split(",").map((c) => c.trim()).filter((c) => c.length > 0);

  ok(`L1  registro.ts declara 11 colunas base (${colunasBase.length})`, colunasBase.length === 11,
    colunasBase.join(", "));
  ok(`L2  registrarAbertura acrescenta 6 (${extras.length})`, extras.length === 6, extras.join(", "));
  ok(`L3  total de 17 colunas no TypeScript (${doTypeScript.length})`, doTypeScript.length === 17);
  ok(`L4  o INSERT da RPC tem 17 colunas (${doSql.length})`, doSql.length === 17, doSql.join(", "));
  ok("L5  os dois conjuntos sao IGUAIS, nos dois sentidos",
    conjuntosIguais(doTypeScript, doSql),
    `ts=${[...doTypeScript].sort().join(",")} sql=${[...doSql].sort().join(",")}`);
  ok("L6  CONTROLE: uma coluna a mais reprovaria",
    !conjuntosIguais([...doTypeScript, "extra"], doSql));
  ok("L7  CONTROLE: uma coluna renomeada reprovaria",
    !conjuntosIguais(doTypeScript.map((c) => (c === "loja_id" ? "loja" : c)), doSql));

  ok("L8  a abertura usa fase abertura e status executando",
    /'abertura', 'executando'/.test(SQL));
  ok("L9  entrada_resumo e vazio: nenhum argumento bruto na Tool Call",
    /'\{\}'::jsonb/.test(SQL) && !/ap\.argumentos/.test(SQL));
  ok("L10 acesso vem da linha travada, nao e cravado como leitura",
    /ap\.acesso/.test(SQL) && !/'leitura'::text/.test(SQL));
  ok("L11 loja_id vem do snapshot congelado", /ap\.conexao_loja_id, '\{\}'::jsonb/.test(SQL));
  ok("L12 idempotency_key e latencia sao nulos na abertura",
    /'abertura', 'executando', null, null, null, null/.test(SQL));
}

// ─── M. Escritores ────────────────────────────────────────────────────

secao("M. Quem pode escrever, e apenas quem");
{
  const varrer = (dir: string, achados: string[]): string[] => {
    for (const e of readdirSync(join(RAIZ, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (!/node_modules|\.next/.test(e.name)) varrer(rel, achados);
      } else if (/\.tsx?$/.test(e.name)) {
        achados.push(rel);
      }
    }
    return achados;
  };
  const fontes = [...varrer("lib", []), ...varrer("app", [])];

  // ── M1: dois nomeadores, com papeis distintos e declarados ────────
  //
  // Ate o APPROVAL-B1D-D1 so `persistencia.ts` nomeava a tabela, e o
  // assert exigia conjunto unitario. O detector stale a le — SOMENTE
  // por SELECT, e sem `argumentos` — entao o conjunto passou a ter dois
  // membros NOMEADOS. A exigencia nao afrouxou: continua igualdade de
  // conjunto nos dois sentidos, e um terceiro nomeador reprova.
  //
  // APPROVAL-UI-API-A1: a fila do dono le a tabela — SOMENTE por SELECT,
  // sem RPC e sem escrita — entao o conjunto passou de dois para tres
  // membros NOMEADOS. A exigencia continua a mesma: igualdade de
  // conjunto nos dois sentidos, e um quarto nomeador reprova.
  const NOMEADORES_AUTORIZADOS = [PERSISTENCIA, STALE, LEITURA];

  const tocamTabela = fontes.filter((f) => /agente_funcao_aprovacoes/.test(semComentariosTs(ler(f))));
  ok(`M1  so os nomeadores declarados citam a tabela em lib/ e app/ (${tocamTabela.join(", ") || "nenhum"})`,
    conjuntosIguais(tocamTabela, NOMEADORES_AUTORIZADOS));
  ok("M1a CONTROLE: um terceiro nomeador reprova",
    !conjuntosIguais([...NOMEADORES_AUTORIZADOS, "app/api/x/route.ts"], NOMEADORES_AUTORIZADOS));
  ok("M1b CONTROLE: a persistencia sumir reprova",
    !conjuntosIguais([STALE], NOMEADORES_AUTORIZADOS));
  ok("M1c CONTROLE: o detector sumir reprova",
    !conjuntosIguais([PERSISTENCIA], NOMEADORES_AUTORIZADOS));
  ok("M1d CONTROLE: um caminho parecido nao passa por semelhanca",
    !conjuntosIguais([PERSISTENCIA, "lib/agentes/aprovacoes/stale.test.ts"], NOMEADORES_AUTORIZADOS));

  const chamamRpc = fontes.filter((f) =>
    /aprovacao_criar|aprovacao_decidir|aprovacao_consumir_e_abrir/.test(semComentariosTs(ler(f))));
  ok("M2  so persistencia.ts chama as RPCs", conjuntosIguais(chamamRpc, [PERSISTENCIA]));

  ok("M3  persistencia.ts nao faz INSERT nem UPDATE direto",
    !/\.from\(TABELA\)[\s\S]{0,60}\.(insert|update|upsert|delete)\(/.test(PERS) &&
      !/\.insert\(|\.update\(|\.upsert\(|\.delete\(/.test(PERS));
  ok("M4  e le a tabela apenas por select", /\.from\(TABELA\)\s*\.select\(/.test(PERS));
  ok("M5  as tres RPCs sao constantes fechadas",
    /const RPC_CRIAR = "aprovacao_criar"/.test(PERS) &&
      /const RPC_DECIDIR = "aprovacao_decidir"/.test(PERS) &&
      /const RPC_CONSUMIR = "aprovacao_consumir_e_abrir"/.test(PERS));
  ok("M6  nenhuma string de UPDATE da tabela fora da migration",
    !fontes.some((f) => /update\s+agente_funcao_aprovacoes/i.test(semComentariosTs(ler(f)))));
  ok("M7  CONTROLE: a varredura leu arquivos de verdade", fontes.length > 50);

  // Apenas DOIS escritores legitimos da abertura da Tool Call.
  const escrevemAbertura = fontes.filter((f) => /fase: "abertura"/.test(semComentariosTs(ler(f))));
  ok("M8  no TypeScript, so registro.ts grava abertura",
    conjuntosIguais(escrevemAbertura, ["lib/agentes/chamadas/registro.ts"]),
    escrevemAbertura.join(", "));
  ok("M9  o segundo escritor e a RPC, e esta declarado na fonte",
    /SEGUNDO lugar que insere uma\s*\n--\s*abertura/.test(SQL_BRUTO));
}

// ─── N. Fronteiras da persistencia ────────────────────────────────────

secao("N. A persistencia respeita a fronteira de confianca");
{
  ok("N1  e server-only", /^import "server-only";/m.test(PERS));
  ok("N2  usa o agregador como autoridade da conexao utilizavel",
    /import \{ resolverConexoesDoAgente \}/.test(PERS));
  // Ate a M2-I1-A1 o alvo vinha de uma SEGUNDA leitura, direto da
  // selecao crua. Nao vem mais, e a razao nao foi custo: `agente_conexoes`
  // nao tem invariante de banco ligando `plataforma` ao marketplace da
  // loja, entao a selecao crua responde "qual loja o dono apontou" e nada
  // mais — podia apontar para conta de outro provedor, e o congelamento da
  // aprovacao guardaria justamente a conta que a camada de fatos recusou.
  //
  // O `lojaId` agora vem de `bindings`, que ja nasce reconciliado com o
  // fato. Uma autoridade so, e nao duas que precisariam concordar.
  ok("N3  o alvo vem do BINDING validado, nunca da selecao crua",
    /resolvido\.bindings\.find\(/.test(PERS) && /binding\.lojaId/.test(PERS) &&
      !/selecao\.lojaId/.test(PERS));
  ok("N3a e a segunda leitura de selecao NAO existe mais",
    !/resolverSelecoesDoAgente/.test(PERS));
  ok("N3b o binding e procurado pelo par EXATO, nunca so por plataforma",
    /b\.plataforma === requisito\.plataforma && b\.recurso === requisito\.recurso/.test(PERS));
  ok("N3c sem binding, recusa fechada ANTES de avaliar o fato",
    /if \(binding === undefined\) return \{ codigo: "conexao_indisponivel" \};/.test(PERS));

  // ── M2-I1-A3: a cobertura remota entra entre o binding e o fato ──
  //
  // A ordem e o ponto. Sem binding nao ha conta contra a qual provar, e
  // perguntar ao provider antes disso gastaria rede para descobrir algo
  // que a selecao ja respondia. Depois do `conexaoServe` seria tarde: o
  // fato ja teria sido julgado com a cobertura constante.
  ok("N3d a cobertura remota e chamada UMA vez",
    (PERS.match(/confirmarCoberturaDosFatos\(/g) ?? []).length === 1,
    String((PERS.match(/confirmarCoberturaDosFatos\(/g) ?? []).length));
  ok("N3e e ela fica DEPOIS do binding e ANTES do conexaoServe",
    PERS.indexOf("resolvido.bindings.find(") <
      PERS.indexOf("confirmarCoberturaDosFatos(") &&
    PERS.indexOf("confirmarCoberturaDosFatos(") < PERS.indexOf("conexaoServe(fato)"));
  ok("N3f o fato julgado e o ELEVADO, nunca o cru",
    /const fato = elevados\.conexoes\.find\(/.test(PERS) &&
      !/const fato = resolvido\.conexoes\.find\(/.test(PERS));
  ok("N3g o `acesso` vem do CATALOGO, amarrando o HARD BOUND de leitura",
    /resolverAlvo\(userId, agenteId, requisito, definicao\.acesso\)/.test(PERS) &&
      (PERS.match(/resolverAlvo\(userId, agenteId, requisito, definicao\.acesso\)/g) ?? [])
        .length === 2);
  ok("N3h a persistencia continua sem endpoint, token ou Authorization",
    !/mercadolibre|Authorization|accessToken|getMLLojaById/.test(PERS));
  ok("N3i o alvo so e congelado DEPOIS de tudo isso",
    PERS.indexOf("conexaoServe(fato)") <
      PERS.indexOf("return { plataforma: requisito.plataforma"));
  ok("N3j CONTROLE: a sonda de N3f acha o padrao antigo quando ele existe",
    /const fato = resolvido\.conexoes\.find\(/.test(
      "  const fato = resolvido.conexoes.find((c) => c);"));
  ok("N4  NAO reimplementa a composicao do agregador",
    !/resolverFatosConexao|resolverSkillsDoAgente/.test(PERS));

  // O predicado duplicado do guard, conferido termo a termo.
  const noGuard = /fato\.estado === "conectada" && fato\.cobertura === "confirmada"/.test(GUARD);
  const naPersistencia = /fato\.estado === "conectada" && fato\.cobertura === "confirmada"/.test(PERS);
  ok("N5  o predicado de conexao utilizavel e IDENTICO ao do guard",
    noGuard && naPersistencia);
  ok("N6  e a duplicacao esta declarada na fonte, nao escondida",
    /Duplicacao declarada/.test(PERS_BRUTO));

  ok("N7  revisao, acesso e requisito vem do catalogo, nunca do chamador",
    /definicao\.revisao/.test(PERS) && /definicao\.acesso/.test(PERS) &&
      /definicao\.conexaoNecessaria/.test(PERS));
  ok("N8  a entrada publica nao tem campos de autoridade",
    !/revisao\??:|acesso\??:|requestId\??:|nivel\??:/.test(
      PERS.slice(PERS.indexOf("export interface EntradaCriarAprovacao"), PERS.indexOf("export interface EntradaDecidirAprovacao"))));
  ok("N9  request_id nasce aqui, por randomUUID",
    /const requestId = randomUUID\(\)/.test(PERS) && !/entrada\.requestId/.test(PERS));
  // ── N10: a mesma invariante, com o retorno maior do B1C-I2 ────────
  //
  // Antes o consumo devolvia `{ codigo, requestId }` e a sonda mirava
  // esse literal. Agora ele devolve tambem o CONTEXTO da retomada, e o
  // literal mudou — mas a invariante nao: nada de dentro sai enquanto a
  // RPC nao disser `consumida`. A sonda passa a provar isso pela GUARDA
  // que fica antes, que e onde a invariante realmente mora.
  ok("N10 nada sai do consumo enquanto a RPC nao disser consumida",
    /if \(codigo !== "consumida"\) return \{ codigo: codigo as Exclude<CodigoAprovacao, "consumida"> \};/
      .test(PERS));
  ok("N10a o requestId e o contexto so aparecem DEPOIS dessa guarda",
    PERS.indexOf('if (codigo !== "consumida")') < PERS.indexOf("contexto: {") &&
      PERS.indexOf('if (codigo !== "consumida")') > PERS.indexOf("const requestId = randomUUID()"));
  ok("N10b e o contexto acompanha SOMENTE o retorno de consumida",
    (PERS.match(/contexto: \{/g) ?? []).length === 1);

  ok("N11 o consumo revalida revisao, acesso e requisito",
    /ap\.revisao_funcao !== definicao\.revisao/.test(PERS) &&
      /ap\.acesso !== definicao\.acesso/.test(PERS) &&
      /ap\.conexao_plataforma !== platEsperada/.test(PERS));
  ok("N12 e roda validarEntrada de novo sobre o argumento congelado",
    /definicao\.validarEntrada\(ap\.argumentos\)/.test(PERS));
  // A comparacao passou a usar o local ja estreitado, mas o valor e o
  // mesmo — e a sonda cobra as DUAS metades para que ele nao possa
  // virar outra coisa no caminho.
  ok("N13 e confere a loja congelada contra a atual",
    /const lojaId = ap\.conexao_loja_id \?\? null;/.test(PERS) &&
      /alvo\.lojaId !== lojaId/.test(PERS));

  ok("N14 nenhum erro cru do driver e propagado",
    !/error\.message|\.details|\.hint|\.stack/.test(PERS));
  ok("N15 o log registra so o SQLSTATE", /sqlstate \$\{sqlstate/.test(PERS));
  ok("N16 nenhum argumento bruto e logado", !/console\.[a-z]+\([^)]*argumentos/.test(PERS));
}

// ─── O. A fundacao nasce inerte ───────────────────────────────────────

secao("O. Nada no runtime consome a fundacao ainda");
{
  const varrer = (dir: string, achados: string[]): string[] => {
    for (const e of readdirSync(join(RAIZ, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (!/node_modules|\.next/.test(e.name)) varrer(rel, achados);
      } else if (/\.tsx?$/.test(e.name) && rel !== PERSISTENCIA) {
        achados.push(rel);
      }
    }
    return achados;
  };
  const outros = [...varrer("lib", []), ...varrer("app", [])];

  // ── O1/O2: a inercia acabou, e de proposito ─────────────────────
  //
  // Ate o APPROVAL-B1C-I1 a fundacao tinha ZERO consumidor, e estes
  // dois asserts existiam para provar isso. O I2 os fez disparar — era
  // o objetivo do gate. A reconciliacao nao afrouxa nada: o detector e
  // o mesmo, a varredura e a mesma, e a exigencia deixa de ser
  // "conjunto vazio" para ser "conjunto EXATAMENTE igual ao declarado".
  // Um segundo consumidor continua reprovando, e o desaparecimento do
  // autorizado tambem.
  const EXECUTOR_FUNCOES = "lib/agentes/execucao-funcoes/executar.ts";
  // APPROVAL-DECISION-A3: o segundo consumidor, e o ultimo previsto. A
  // rota de decisao chama `decidirAprovacao`; o executor chama consumo e
  // retomada. Conjunto NOMINAL — um terceiro arquivo reprova, e o
  // desaparecimento de qualquer um dos dois tambem.
  const DECISION_ROUTE = "app/api/aprovacoes/[aprovacaoId]/decidir/route.ts";
  const CONSUMIDORES_AUTORIZADOS = [EXECUTOR_FUNCOES, DECISION_ROUTE];

  const consumidores = outros.filter((f) =>
    /criarAprovacao|decidirAprovacao|consumirAprovacaoEAbrir/.test(semComentariosTs(ler(f))));
  ok(`O1  os consumidores de producao sao exatamente os declarados (${consumidores.join(", ") || "nenhum"})`,
    conjuntosIguais(consumidores, CONSUMIDORES_AUTORIZADOS));
  // ── A3: a topologia rota -> wrapper, contada nominalmente ────────
  {
    const fonteRota = semComentariosTs(ler(DECISION_ROUTE));
    const nOcc = (t: string, re: RegExp) => (t.match(re) ?? []).length;
    ok("O1d a rota importa `decidirAprovacao` exatamente uma vez",
      nOcc(fonteRota, /import \{ decidirAprovacao \}/g) === 1);
    ok("O1e e a chama exatamente uma vez",
      nOcc(fonteRota, /(?<![.\w])decidirAprovacao\(/g) === 1);
    ok("O1f a rota NAO alcanca o banco por conta propria",
      !/getSupabaseServidor|\.rpc\(|aprovacao_decidir/.test(fonteRota));
    ok("O1g e NAO alcanca Resume, Worker, Funcao nem Tool Call",
      !/executarRetomada|executarSlotRetomada|iniciarRetomadaAprovacao/.test(fonteRota) &&
      !/aprovacao_consumir_e_abrir|consumirAprovacaoEAbrir/.test(fonteRota) &&
      !/reivindicarProximaTarefa|executarTarefa|executarFuncao/.test(fonteRota) &&
      !/internal\/agentes\/worker/.test(fonteRota));
    ok("O1h o transporte do cliente NAO usa o simbolo do servidor",
      !/decidirAprovacao/.test(semComentariosTs(ler("lib/ia/agentes-http.ts"))) &&
      /registrarDecisaoAprovacao/.test(ler("lib/ia/agentes-http.ts")));
    ok("O1i CONTROLE: a sonda de chamada acha uma chamada de verdade",
      nOcc("await decidirAprovacao({ userId });", /(?<![.\w])decidirAprovacao\(/g) === 1);
  }
  ok("O1a CONTROLE: um segundo consumidor reprovaria",
    !conjuntosIguais([EXECUTOR_FUNCOES, "app/api/x/route.ts"], CONSUMIDORES_AUTORIZADOS));
  ok("O1b CONTROLE: o autorizado sumir tambem reprovaria",
    !conjuntosIguais([], CONSUMIDORES_AUTORIZADOS));
  ok("O1c CONTROLE: um caminho parecido nao passa por semelhanca",
    !conjuntosIguais(["lib/agentes/execucao-funcoes/executar.test.ts"], CONSUMIDORES_AUTORIZADOS));

  // A sonda mira a REFERENCIA ao modulo novo. Nao pode ser /aprovac/i:
  // os dois arquivos ja falam de `aprovacao_necessaria` e
  // `aguardando_aprovacao` desde o TOOL-CALL-B, e a sonda acusaria
  // vocabulario legitimo que aquele gate nao criou.
  const REFERENCIA_NOVA = /aprovacoes\/|agente_funcao_aprovacoes|criarAprovacao|consumirAprovacaoEAbrir/;
  ok("O2  o executor referencia a fundacao — e e o unico que pode",
    REFERENCIA_NOVA.test(semComentariosTs(ler(EXECUTOR_FUNCOES))));
  ok("O2a e a decisao humana continua FORA do executor: ele nao decide, so retoma",
    !/decidirAprovacao/.test(semComentariosTs(ler(EXECUTOR_FUNCOES))));
  ok("O3  registro.ts continua sem referencia nenhuma",
    !REFERENCIA_NOVA.test(semComentariosTs(ler("lib/agentes/chamadas/registro.ts"))));
  ok("O3b CONTROLE: a sonda acha a referencia quando ela existe",
    REFERENCIA_NOVA.test('import { criarAprovacao } from "@/lib/agentes/aprovacoes/persistencia";'));
  ok("O3c CONTROLE: e nao acha onde ela nao existe",
    !REFERENCIA_NOVA.test('const x = "aguardando_aprovacao";'));
  ok("O4  a persistencia nao chama o executor",
    !/definicao\.executor|executarFuncao/.test(PERS));
  ok("O5  escrita continua fail-closed no executor",
    /escrita_nao_suportada/.test(ler("lib/agentes/execucao-funcoes/executar.ts")));
  ok("O6  ANCORA: a varredura leu arquivos de verdade", outros.length > 50);
}

// ─── P. O contexto de retomada ────────────────────────────────────────
//
// O que o APPROVAL-B1C-I2 acrescentou a persistencia: depois de
// consumir, ela entrega ao executor o contexto SERVER-SIDE da retomada.
// Cada assert aqui existe para que nenhum campo desse contexto possa
// passar a vir de quem chama.

secao("P. O consumo entrega contexto, e nao autoridade");
{
  const CONSUMO = PERS.slice(PERS.indexOf("export async function consumirAprovacaoEAbrir"));

  ok("P1  o SELECT da aprovacao inclui tarefa_id",
    /\.select\("id, funcao_id, revisao_funcao, acesso, conexao_plataforma, conexao_recurso, conexao_loja_id, argumentos, agente_id, tarefa_id"\)/
      .test(PERS));
  ok("P2  e continua sendo UM select so, nao um paralelo",
    (PERS.match(/\.from\(TABELA\)/g) ?? []).length === 1);

  ok("P3  os argumentos do contexto vem da linha congelada",
    /argumentos: ap\.argumentos/.test(CONSUMO));
  ok("P4  a definicao vai resolvida no contexto, nao o id sozinho",
    /definicao,/.test(CONSUMO) && /const definicao: DefinicaoFuncao = FUNCOES\[funcaoId\]/.test(PERS));
  ok("P5  a definicao e resolvida ANTES da RPC de consumo",
    PERS.indexOf("const definicao: DefinicaoFuncao = FUNCOES[funcaoId]") <
      PERS.indexOf("cliente.rpc(RPC_CONSUMIR"));
  // ── P6 — O ALVO DE CONEXAO VEM DO CATALOGO ───────────────────────
  //
  // Esta sonda ficou VERMELHA sobre codigo correto: ela procurava
  // `platEsperada` dentro de `consumirAprovacaoEAbrir`, mas o simbolo
  // nunca morou ali. A prova local migrou para
  // `lerAprovacaoParaRetomada`, que as duas lanes compartilham — o
  // consumo recebe a struct JA validada e so a repassa.
  //
  // Reescrita para a arquitetura de hoje: a regra e a mesma, o lugar
  // mudou. Cada pedaco e checado na funcao que realmente o contem, com
  // fatia propria, para que a sonda nao volte a olhar para o lado errado.
  // ── O RECORTE, E POR QUE ELE PRECISA SER POR CHAVES ──────────────
  //
  // A primeira versao recortava `lerAprovacaoParaRetomada` ate o
  // `indexOf` da funcao seguinte, e `consumirAprovacaoEAbrir` ate o FIM
  // DO ARQUIVO. Os dois funcionavam por acidente de posicao: bastava
  // alguem inserir uma funcao no meio, ou acrescentar qualquer coisa
  // depois do consumo, para o recorte passar a medir o vizinho.
  //
  // Agora o corpo e delimitado por balanceamento de chaves. As chaves
  // dentro de string nao contam: a contagem roda sobre uma copia
  // mascarada de MESMO COMPRIMENTO, entao os indices continuam valendo
  // para fatiar o texto original.
  const mascararTextos = (t: string): string =>
    t.replace(/(["'`])(?:\\.|(?!\1)[\s\S])*?\1/g,
      (m) => m[0] + " ".repeat(Math.max(0, m.length - 2)) + m[m.length - 1]);

  const corpoDaFuncao = (fonte: string, assinatura: string): string => {
    const inicio = fonte.indexOf(assinatura);
    if (inicio === -1) return "";
    const mascarado = mascararTextos(fonte);
    const abre = mascarado.indexOf("{", inicio);
    if (abre === -1) return "";
    let nivel = 0;
    for (let k = abre; k < mascarado.length; k += 1) {
      const c = mascarado[k];
      if (c === "{") nivel += 1;
      else if (c === "}") {
        nivel -= 1;
        if (nivel === 0) return fonte.slice(inicio, k + 1);
      }
    }
    return "";
  };

  const LER_RETOMADA = corpoDaFuncao(PERS, "export async function lerAprovacaoParaRetomada");
  const CONSUMIR = corpoDaFuncao(PERS, "export async function consumirAprovacaoEAbrir");

  // O recorte precisa se provar ANTES de ser usado como evidencia.
  const recorteValido = (fatia: string, assinatura: string): boolean =>
    fatia.length > 0 && fatia.length < PERS.length &&
    fatia.startsWith(assinatura) && fatia.endsWith("\n}") &&
    (mascararTextos(fatia).match(/\{/g) ?? []).length ===
      (mascararTextos(fatia).match(/\}/g) ?? []).length &&
    (fatia.match(/export async function /g) ?? []).length === 1;

  ok("P6  RECORTE: o corpo da leitura de retomada e integro e isolado",
    recorteValido(LER_RETOMADA, "export async function lerAprovacaoParaRetomada"),
    `${LER_RETOMADA.length} chars`);
  ok("P6r RECORTE: o corpo do consumo e integro e isolado, sem depender do EOF",
    recorteValido(CONSUMIR, "export async function consumirAprovacaoEAbrir"),
    `${CONSUMIR.length} chars`);
  ok("P6r1 e os dois recortes nao se sobrepoem",
    !LER_RETOMADA.includes("export async function consumirAprovacaoEAbrir") &&
    !CONSUMIR.includes("export async function lerAprovacaoParaRetomada"));
  ok("P6r2 CONTROLE: uma assinatura inexistente devolve recorte vazio",
    corpoDaFuncao(PERS, "export async function funcaoQueNaoExiste") === "");

  const alvoDoCatalogo = (t: string): boolean =>
    /const requisito = definicao\.conexaoNecessaria;/.test(t) &&
    /const platEsperada = requisito === null \? null : requisito\.plataforma;/.test(t) &&
    /const recEsperado = requisito === null \? null : requisito\.recurso;/.test(t);
  const comparaExplicito = (t: string): boolean =>
    /if \(ap\.conexao_plataforma !== platEsperada \|\| ap\.conexao_recurso !== recEsperado\)/.test(t);
  const rejeitaDivergencia = (t: string): boolean =>
    /codigo: "aprovacao_desatualizada", detalhe: "conexao_divergente"/.test(t);
  const contextoDoCatalogo = (t: string): boolean =>
    /plataforma: platEsperada,/.test(t) && /recurso: recEsperado,/.test(t) &&
    !/plataforma: ap\.conexao_plataforma/.test(t);

  ok("P6  ANCORA: a fatia da leitura de retomada nao esta vazia",
    LER_RETOMADA.length > 0 && LER_RETOMADA.length < PERS.length);
  ok("P6a o alvo esperado vem do CATALOGO, nunca da linha do banco",
    alvoDoCatalogo(LER_RETOMADA));
  ok("P6b a linha congelada e comparada EXPLICITAMENTE com esse alvo",
    comparaExplicito(LER_RETOMADA));
  ok("P6c divergencia REPROVA a aprovacao, nao vira no-op silencioso",
    rejeitaDivergencia(LER_RETOMADA));
  ok("P6d e o contexto devolvido carrega o alvo do catalogo, nao a coluna crua",
    contextoDoCatalogo(LER_RETOMADA));

  // ── P6o — A ORDEM, QUE E METADE DO INVARIANTE ────────────────────
  //
  // Os asserts acima provam que os tokens existem. Existir nao basta:
  // se a comparacao acontecesse DEPOIS do `ok: true`, ou se o alvo
  // esperado fosse montado depois de ja ter sido usado, cada regex
  // continuaria casando e a funcao estaria errada. Ordem e contrato.
  const idx = (t: string): number => LER_RETOMADA.indexOf(t);
  const iFuncoes = idx("FUNCOES[funcaoId]");
  const iRequisito = idx("const requisito = definicao.conexaoNecessaria;");
  const iPlat = idx("const platEsperada = requisito === null");
  const iRec = idx("const recEsperado = requisito === null");
  const iCompara = idx("if (ap.conexao_plataforma !== platEsperada");
  const iRejeita = idx('detalhe: "conexao_divergente"');
  const iOk = idx("ok: true");

  ok("P6o CADEIA: catalogo -> requisito -> plataforma -> recurso, nesta ordem",
    iFuncoes !== -1 && iFuncoes < iRequisito && iRequisito < iPlat && iPlat < iRec,
    `${iFuncoes} < ${iRequisito} < ${iPlat} < ${iRec}`);
  ok("P6o1 o alvo esperado e construido ANTES da comparacao",
    iRec !== -1 && iRec < iCompara, `${iRec} < ${iCompara}`);
  ok("P6o2 a comparacao vem ANTES da rejeicao que ela dispara",
    iCompara !== -1 && iCompara < iRejeita, `${iCompara} < ${iRejeita}`);
  ok("P6o3 e a rejeicao vem ANTES de qualquer caminho de sucesso",
    iRejeita !== -1 && iOk !== -1 && iRejeita < iOk, `${iRejeita} < ${iOk}`);
  ok("P6e o consumo NAO rele a coluna crua: recebe a struct ja validada",
    /const ap = pre\.aprovacao;/.test(CONSUMIR) &&
    !/conexao_plataforma|conexao_recurso/.test(CONSUMIR) &&
    /plataforma: ap\.plataforma,/.test(CONSUMIR) && /recurso: ap\.recurso,/.test(CONSUMIR));

  // ── Os mutantes de P6 ────────────────────────────────────────────
  //
  // Strings em memoria; `persistencia.ts` nao e tocado. Cada um desliga
  // uma peca e precisa reprovar exatamente o oraculo correspondente.
  {
    const m1 = LER_RETOMADA.replace(
      "const requisito = definicao.conexaoNecessaria;",
      "const requisito = ap.conexao_plataforma;");
    ok("P6m1 requisito vindo da LINHA reprova o oraculo do catalogo",
      m1 !== LER_RETOMADA && !alvoDoCatalogo(m1));

    const m2 = LER_RETOMADA.replace(
      "if (ap.conexao_plataforma !== platEsperada || ap.conexao_recurso !== recEsperado)",
      "if (false)");
    ok("P6m2 sem a comparacao explicita, P6b reprova",
      m2 !== LER_RETOMADA && !comparaExplicito(m2));

    const m3 = LER_RETOMADA.replace(
      "ap.conexao_plataforma !== platEsperada",
      "ap.conexao_plataforma === platEsperada");
    ok("P6m3 comparacao invertida tambem reprova P6b",
      m3 !== LER_RETOMADA && !comparaExplicito(m3));

    const m4 = LER_RETOMADA
      .replace("plataforma: platEsperada,", "plataforma: ap.conexao_plataforma,")
      .replace("recurso: recEsperado,", "recurso: ap.conexao_recurso,");
    ok("P6m4 contexto montado com a coluna crua reprova P6d",
      m4 !== LER_RETOMADA && !contextoDoCatalogo(m4));

    const m5 = LER_RETOMADA.replace(
      'codigo: "aprovacao_desatualizada", detalhe: "conexao_divergente"',
      'codigo: "ok", detalhe: "seguiu_assim_mesmo"');
    ok("P6m5 divergencia silenciada reprova P6c",
      m5 !== LER_RETOMADA && !rejeitaDivergencia(m5));

    // ── P6m6 — O MUTANTE QUE FALTAVA: O CONSUMO RELENDO O CRU ──────
    //
    // P6e era so positivo: afirmava que o consumo nao toca as colunas
    // cruas, sem nunca provar que a sonda notaria se ele tocasse. Um
    // assert assim envelhece calado. Aqui o consumo e reescrito em
    // memoria para voltar a ler `conexao_plataforma` da linha, e a
    // sonda precisa reprovar.
    const consumoSemCru = (t: string): boolean =>
      /const ap = pre\.aprovacao;/.test(t) &&
      !/conexao_plataforma|conexao_recurso/.test(t) &&
      /plataforma: ap\.plataforma,/.test(t) && /recurso: ap\.recurso,/.test(t);

    ok("P6m6 ANCORA: o consumo integro passa na sonda de bypass",
      consumoSemCru(CONSUMIR));

    const cru1 = CONSUMIR.replace("plataforma: ap.plataforma,", "plataforma: ap.conexao_plataforma,");
    ok("P6m6a consumo relendo `conexao_plataforma` reprova P6e",
      cru1 !== CONSUMIR && !consumoSemCru(cru1));

    const cru2 = CONSUMIR.replace("recurso: ap.recurso,", "recurso: ap.conexao_recurso,");
    ok("P6m6b consumo relendo `conexao_recurso` reprova P6e",
      cru2 !== CONSUMIR && !consumoSemCru(cru2));

    const semStruct = CONSUMIR.replace("const ap = pre.aprovacao;", "const ap = linhaCrua;");
    ok("P6m6c consumo que abandona a struct validada reprova P6e",
      semStruct !== CONSUMIR && !consumoSemCru(semStruct));

    // ── O MAPA CONGELADO DOS MUTANTES ──────────────────────────────
    //
    // Os IDs locais nasceram antes do vocabulario canonico. Congelando
    // a correspondencia aqui para que ninguem precise reconstrui-la:
    //
    //   M1 remove a comparacao persisted-vs-expected .......... P6m2
    //   M2 remove a rejeicao de divergencia ................... P6m5
    //   M3 contexto devolvido usa o alvo persistido ........... P6m4
    //   M4 alvo esperado deixa de vir do catalogo ............. P6m1
    //   M5 consume rele o campo cru persistido ................ P6m6
    //
    //   (P6m3, comparacao invertida, e cobertura adicional.)
  }

  // ── O nivel: lido, nunca reconstruido ────────────────────────────
  ok("P7  existe uma leitura dedicada da abertura",
    /async function lerNivelDaAbertura\(/.test(PERS));
  ok("P8  ela le a tabela de chamadas, por select",
    /\.from\(TABELA_CHAMADAS\)\s*\n?\s*\.select\("nivel_no_momento"\)/.test(PERS));
  ok("P9  e filtra por dono, request_id e fase de abertura",
    /\.eq\("user_id", userId\)/.test(PERS) && /\.eq\("request_id", requestId\)/.test(PERS) &&
      /\.eq\("fase", "abertura"\)/.test(PERS));
  ok("P10 resultado ambiguo nao vira 'a primeira serve'", /\.maybeSingle\(\)/.test(PERS));
  ok("P11 o nivel do contexto vem dessa leitura, e de nenhum lugar mais",
    /const nivelNoMomento = await lerNivelDaAbertura\(/.test(CONSUMO) &&
      /nivelNoMomento,/.test(CONSUMO));
  ok("P12 a permissao NAO e relida para reconstruir o nivel",
    !/agente_permissoes/.test(semComentariosTs(PERS)));
  ok("P13 nivel fora do vocabulario nao vira fallback",
    /NIVEIS_DE_CHAMADA as readonly unknown\[\]\)\.includes\(bruto\)/.test(PERS) &&
      /: null;/.test(PERS));
  ok("P14 e a leitura que falha para o consumo, em vez de seguir",
    /if \(nivelNoMomento === null\) return \{ codigo: "abertura_ilegivel", requestId \};/.test(CONSUMO));

  // ── `abertura_ilegivel` nao e estado de aprovacao ────────────────
  ok("P15 abertura_ilegivel fica FORA de CodigoAprovacao",
    !/\|\s*"abertura_ilegivel"/.test(
      PERS.slice(PERS.indexOf("export type CodigoAprovacao"), PERS.indexOf("export type ResultadoCriacao"))));
  ok("P16 e aparece so no resultado do consumo, com o requestId junto",
    /\{ codigo: "abertura_ilegivel"; requestId: string \}/.test(PERS));

  // ── A escrita continua fora deste modulo ─────────────────────────
  ok("P17 a leitura nova nao escreve nada",
    !/TABELA_CHAMADAS[\s\S]{0,120}\.(insert|update|upsert|delete)\(/.test(PERS));
  ok("P18 e nao existe literal de abertura aqui — quem grava e registro.ts e a RPC",
    !/fase: "abertura"/.test(PERS));
  ok("P19 CONTROLE: a sonda de P18 acharia o literal",
    /fase: "abertura"/.test('inserir({ fase: "abertura" })'));

  // ── A fronteira de erro nao afrouxou ─────────────────────────────
  ok("P20 a leitura da abertura loga so o SQLSTATE",
    /logarFalha\("leitura_abertura", r\.error\)/.test(PERS) &&
      /function logarFalha/.test(PERS));
  ok("P21 nenhum dado da aprovacao sai em caso de erro",
    !/return \{ codigo: "falha_persistencia", (ap|argumentos|contexto)/.test(PERS));
}

// ─── Q. O detector de aberturas stale ─────────────────────────────────
//
// ── Por que esta secao precisa de duplo, e as anteriores nao ────────
//
// Tudo acima e puro (helpers de identidade) ou varredura de fonte. O
// detector, nao: ele so significa alguma coisa se as TRES leituras
// acontecerem na ordem certa, com os filtros certos, e se a paginacao
// devolver o cursor certo. Isso e comportamento, e comportamento se
// prova executando.
//
// O duplo troca APENAS `supabase-servidor`, pelo mesmo mecanismo de
// `testar-agentes-execucao-funcoes.ts`. Producao continua com uma
// assinatura so — o detector nao ganha porta de injecao.
//
// ── O que o duplo NAO prova ─────────────────────────────────────────
//
// Ele registra os filtros enviados; nao os APLICA. Entao "abertura
// recente nao aparece" nao pode ser provado por comportamento aqui: o
// que se prova e que o corte de idade VAI ao banco, com o valor certo.
// Quem filtra e o Postgres. Confundir as duas coisas seria afirmar que
// a suite testou o servidor.

interface ChamadaDb {
  tabela: string;
  select: string;
  filtros: Record<string, unknown>;
  ins: Record<string, readonly unknown[]>;
  or: string | null;
  ordens: Array<{ coluna: string; asc: boolean }>;
  limite: number | null;
}

interface RespostaDb {
  data?: unknown;
  error?: Record<string, unknown> | null;
}

let chamadasDb: ChamadaDb[] = [];
let respostasDb: RespostaDb[] = [];
let consumidasDb = 0;

function roteiroDb(...rs: RespostaDb[]): void {
  respostasDb = rs;
  chamadasDb = [];
  consumidasDb = 0;
}

function construtorDb(tabela: string): Record<string, unknown> {
  const c: ChamadaDb = {
    tabela,
    select: "",
    filtros: {},
    ins: {},
    or: null,
    ordens: [],
    limite: null,
  };
  const b: Record<string, unknown> = {
    select(colunas: string) {
      c.select = colunas;
      return b;
    },
    eq(coluna: string, valor: unknown) {
      c.filtros[coluna] = valor;
      return b;
    },
    lt(coluna: string, valor: unknown) {
      c.filtros[`${coluna}<`] = valor;
      return b;
    },
    gt(coluna: string, valor: unknown) {
      c.filtros[`${coluna}>`] = valor;
      return b;
    },
    in(coluna: string, valores: readonly unknown[]) {
      c.ins[coluna] = valores;
      return b;
    },
    or(expressao: string) {
      c.or = expressao;
      return b;
    },
    order(coluna: string, opcoes?: { ascending?: boolean }) {
      c.ordens.push({ coluna, asc: opcoes?.ascending !== false });
      return b;
    },
    limit(n: number) {
      c.limite = n;
      return b;
    },
    then(fn: (v: { data: unknown; error: unknown }) => void) {
      chamadasDb.push(c);
      const r = respostasDb[consumidasDb++];
      fn({ data: r?.data ?? null, error: r?.error ?? null });
    },
  };
  return b;
}

const clienteDb = { from: (t: string) => construtorDb(t) };

/**
 * Resposta forcada do observador — usada por UM teste.
 *
 * `null` significa "delegue ao real", que e o estado em toda a suite
 * menos naquele caso. Ela existe porque provar que a rota nao devolve
 * 200 para uma coleta desconhecida exige uma coleta desconhecida — e
 * acrescenta-la a `ColetaObservacao` de producao so para testar seria
 * inventar um estado que o sistema nao tem.
 */
let respostaObservadorForcada: unknown = null;

const requireOriginalDb = (Module as unknown as { prototype: { require: (id: string) => unknown } })
  .prototype.require;
let interceptouDb = false;
let interceptouObservador = false;
(Module as unknown as { prototype: { require: unknown } }).prototype.require = function (
  this: unknown,
  id: string
) {
  if (typeof id === "string" && id.includes("supabase-servidor")) {
    interceptouDb = true;
    return { getSupabaseServidor: () => clienteDb };
  }
  // Envelope DELEGANTE: por padrao chama o observador real, entao todas
  // as secoes anteriores continuam exercitando a implementacao de
  // verdade. So o teste da variante desconhecida troca a resposta.
  if (typeof id === "string" && id.includes("aprovacoes/observabilidade-stale")) {
    interceptouObservador = true;
    const real = requireOriginalDb.apply(this, arguments as unknown as [string]) as Record<
      string,
      unknown
    >;
    return {
      ...real,
      observarAberturasStaleDoUsuario: (entrada: unknown) =>
        respostaObservadorForcada !== null
          ? Promise.resolve(respostaObservadorForcada)
          : (real.observarAberturasStaleDoUsuario as (e: unknown) => Promise<unknown>)(entrada),
    };
  }
  return requireOriginalDb.apply(this, arguments as unknown as [string]);
};

// ── Fixtures ─────────────────────────────────────────────────────────

const DONO = "user-stale-sintetico";
const AGENTE_ST = "44444444-4444-4444-8444-444444444444";
const APROVACAO_ST = "55555555-5555-4555-8555-555555555555";
const FUNCAO_ST = "vendas.consultar";

/** Uma abertura sintetica, ordenavel pelo indice. */
const abertura = (i: number, extra: Record<string, unknown> = {}) => ({
  request_id: `req-${String(i).padStart(4, "0")}`,
  agente_id: AGENTE_ST,
  tarefa_id: null,
  funcao_id: FUNCAO_ST,
  criado_em: `2026-09-01T10:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000+00:00`,
  nivel_no_momento: "aprovacao",
  ...extra,
});

/** A aprovacao consumida que da origem a uma abertura. */
const aprovacaoDe = (i: number, extra: Record<string, unknown> = {}) => ({
  id: `${APROVACAO_ST}-${i}`,
  request_id_consumo: `req-${String(i).padStart(4, "0")}`,
  funcao_id: FUNCAO_ST,
  revisao_funcao: "1",
  agente_id: AGENTE_ST,
  tarefa_id: null,
  ...extra,
});

const desfechoDe = (i: number) => ({ request_id: `req-${String(i).padStart(4, "0")}` });

const linhas = (de: number, ate: number) => {
  const saida: ReturnType<typeof abertura>[] = [];
  for (let i = de; i <= ate; i++) saida.push(abertura(i));
  return saida;
};

const falhaDb: RespostaDb = { data: null, error: { code: "08006" } };

async function principalStale(): Promise<void> {
  const {
    listarAberturasStale,
    calcularCutoff,
    expressaoDeContinuacao,
    IDADE_STALE_APROVACAO_MS,
    PAGINA_STALE,
  } = await import("../lib/agentes/aprovacoes/stale");

  const listar = (cursor?: { criadoEm: string; requestId: string } | null) =>
    listarAberturasStale(cursor === undefined ? { userId: DONO } : { userId: DONO, cursor });

  secao("Q. O detector stale executa de verdade, contra um duplo");
  {
    ok("Q0  ANCORA: o duplo de supabase-servidor foi instalado", interceptouDb);
    ok("Q0a ANCORA: as constantes operacionais existem",
      IDADE_STALE_APROVACAO_MS === 15 * 60 * 1000 && PAGINA_STALE === 100);

    // ── Q1. Caminho feliz ───────────────────────────────────────────
    roteiroDb({ data: [abertura(1)] }, { data: [aprovacaoDe(1)] }, { data: [] });
    const r1 = await listar();

    ok("Q1  abertura velha, com aprovacao consumida e sem desfecho, aparece",
      r1.coleta === "ok" && r1.itens.length === 1 && r1.itens[0]?.requestId === "req-0001");
    ok("Q2  o item traz a aprovacao de origem e a revisao dela",
      r1.itens[0]?.aprovacaoId === `${APROVACAO_ST}-1` && r1.itens[0]?.revisaoFuncao === "1");
    ok("Q3  e se declara originado de aprovacao", r1.itens[0]?.origem === "approval");
    ok("Q4  tres leituras, nessa ordem: aberturas, aprovacoes, desfechos",
      chamadasDb.length === 3 &&
      chamadasDb[0]?.tabela === "agente_funcao_chamadas" &&
      chamadasDb[1]?.tabela === "agente_funcao_aprovacoes" &&
      chamadasDb[2]?.tabela === "agente_funcao_chamadas",
      chamadasDb.map((c) => c.tabela).join(" → "));
    ok("Q5  a confirmacao de desfecho e a ULTIMA leitura",
      chamadasDb[2]?.filtros.fase === "desfecho");
    ok("Q6  capturadoEm e um instante valido",
      typeof r1.capturadoEm === "string" && Number.isFinite(Date.parse(r1.capturadoEm)));
    ok("Q7  idadeMs e coerente com criado_em e o instante da coleta",
      (r1.itens[0]?.idadeMs ?? 0) === Date.parse(r1.capturadoEm) - Date.parse("2026-09-01T10:00:01.000+00:00"));

    // ── Q8. O corte de idade VAI ao banco ───────────────────────────
    const corte = chamadasDb[0]?.filtros["criado_em<"];
    ok("Q8  L1 envia o corte de idade como filtro do banco", typeof corte === "string");
    ok("Q9  e o corte e agora menos o SLA, nao um numero do chamador",
      typeof corte === "string" &&
      Math.abs(
        Date.parse(r1.capturadoEm) - IDADE_STALE_APROVACAO_MS - Date.parse(corte)
      ) < 1000);
    ok("Q10 calcularCutoff e puro e concorda com o filtro enviado",
      calcularCutoff(Date.parse(r1.capturadoEm)) === corte);

    // ── Q11. Filtros e escopo de tenant ─────────────────────────────
    ok("Q11 L1 escopa por dono, fase e status",
      chamadasDb[0]?.filtros.user_id === DONO &&
      chamadasDb[0]?.filtros.fase === "abertura" &&
      chamadasDb[0]?.filtros.status === "executando");
    ok("Q12 L2 escopa por dono e exige aprovacao consumida",
      chamadasDb[1]?.filtros.user_id === DONO && chamadasDb[1]?.filtros.estado === "consumida");
    ok("Q13 L3 escopa por dono e olha so desfechos",
      chamadasDb[2]?.filtros.user_id === DONO && chamadasDb[2]?.filtros.fase === "desfecho");
    ok("Q14 L2 casa pela ponte request_id_consumo",
      JSON.stringify(chamadasDb[1]?.ins.request_id_consumo) === JSON.stringify(["req-0001"]));
    ok("Q15 L1 pede a pagina mais UMA linha, para provar continuacao",
      chamadasDb[0]?.limite === PAGINA_STALE + 1);
    ok("Q16 L1 ordena por criado_em e depois por request_id, ambos ascendentes",
      JSON.stringify(chamadasDb[0]?.ordens) ===
        JSON.stringify([{ coluna: "criado_em", asc: true }, { coluna: "request_id", asc: true }]));
    ok("Q17 sem cursor nao ha filtro de continuacao", chamadasDb[0]?.or === null);
    ok("Q18 L2 NAO seleciona argumentos",
      typeof chamadasDb[1]?.select === "string" && !/argumentos/.test(chamadasDb[1].select));

    // ── Q19. As exclusoes ───────────────────────────────────────────
    roteiroDb({ data: [abertura(1)] }, { data: [aprovacaoDe(1)] }, { data: [desfechoDe(1)] });
    const rFechada = await listar();
    ok("Q19 abertura que JA tem desfecho nao aparece",
      rFechada.coleta === "ok" && rFechada.itens.length === 0);

    roteiroDb({ data: [abertura(1)] }, { data: [] });
    const rAutomatica = await listar();
    ok("Q20 abertura sem aprovacao vinculada nao aparece",
      rAutomatica.coleta === "ok" && rAutomatica.itens.length === 0);
    ok("Q21 e nem chega a perguntar por desfechos", chamadasDb.length === 2);

    // Aprovacao pendente/rejeitada nunca volta da L2, porque a consulta
    // exige `estado='consumida'` — Q12 prova o filtro, e aqui a
    // ausencia de par prova o efeito.
    roteiroDb({ data: [abertura(1)] }, { data: [] });
    const rNaoConsumida = await listar();
    ok("Q22 aprovacao nao consumida nao produz item", rNaoConsumida.itens.length === 0);

    // Cross-tenant: a L2 de outro dono devolve vazio porque a consulta
    // filtra por `user_id`; o detector nunca casa por requestId sozinho.
    roteiroDb({ data: [abertura(1)] }, { data: [] });
    const rOutroDono = await listar();
    ok("Q23 sem par no MESMO dono, nada aparece", rOutroDono.itens.length === 0);

    // ── Q24. Divergencia estrutural falha fechado ───────────────────
    const divergencias: Array<[string, Record<string, unknown>]> = [
      ["agente", { agente_id: "99999999-9999-4999-8999-999999999999" }],
      ["tarefa", { tarefa_id: "66666666-6666-4666-8666-666666666666" }],
      ["funcao", { funcao_id: "vendas.outra" }],
    ];
    let divergentesCorretas = 0;
    for (const [, campo] of divergencias) {
      roteiroDb({ data: [abertura(1)] }, { data: [aprovacaoDe(1, campo)] }, { data: [] });
      const r = await listar();
      if (r.coleta === "falha_leitura" && r.itens.length === 0 && r.nextCursor === null) {
        divergentesCorretas++;
      }
    }
    ok("Q24 aprovacao que diverge da abertura falha fechado, e nao vira stale comum",
      divergentesCorretas === divergencias.length, `${divergentesCorretas}/3`);

    // ── Q25. Falhas de leitura nunca viram lista vazia ──────────────
    roteiroDb(falhaDb);
    const rFalha1 = await listar();
    ok("Q25 falha na L1 -> falha_leitura, e nao 'nenhuma stale'",
      rFalha1.coleta === "falha_leitura" && rFalha1.itens.length === 0 && rFalha1.nextCursor === null);

    roteiroDb({ data: [abertura(1)] }, falhaDb);
    const rFalha2 = await listar();
    ok("Q26 falha na L2 -> falha_leitura", rFalha2.coleta === "falha_leitura" && rFalha2.itens.length === 0);

    roteiroDb({ data: [abertura(1)] }, { data: [aprovacaoDe(1)] }, falhaDb);
    const rFalha3 = await listar();
    ok("Q27 falha na L3 -> falha_leitura", rFalha3.coleta === "falha_leitura" && rFalha3.itens.length === 0);

    roteiroDb({ data: [abertura(1, { criado_em: "ontem" })] });
    const rDeformada = await listar();
    ok("Q28 timestamp deformado falha fechado, em vez de virar idade NaN",
      rDeformada.coleta === "falha_leitura");

    roteiroDb({ data: [abertura(1, { nivel_no_momento: "inventado" })] });
    const rNivel = await listar();
    ok("Q29 nivel fora do vocabulario tambem falha fechado", rNivel.coleta === "falha_leitura");

    // ── Q30. Entrada ────────────────────────────────────────────────
    roteiroDb();
    const rSemDono = await listarAberturasStale({ userId: "" });
    ok("Q30 userId vazio -> entrada_invalida, sem tocar o banco",
      rSemDono.coleta === "entrada_invalida" && chamadasDb.length === 0);

    roteiroDb();
    const rCursorRuim = await listar({ criadoEm: "nao-e-data", requestId: "req-0001" });
    ok("Q31 cursor malformado -> entrada_invalida, e NAO reinicia a varredura",
      rCursorRuim.coleta === "entrada_invalida" && chamadasDb.length === 0);

    roteiroDb();
    const rCursorInjecao = await listar({
      criadoEm: "2026-09-01T10:00:00.000+00:00",
      requestId: 'a",b.gt."x',
    });
    ok("Q32 requestId fora da forma segura tambem e recusado",
      rCursorInjecao.coleta === "entrada_invalida" && chamadasDb.length === 0);
  }

  secao("Q2. Paginacao keyset sem starvation");
  {
    // ── Q33. Exatamente a pagina ────────────────────────────────────
    roteiroDb({ data: linhas(1, PAGINA_STALE) }, { data: [] });
    const rCheia = await listar();
    ok("Q33 exatamente PAGINA linhas -> fim da varredura",
      rCheia.coleta === "ok" && rCheia.nextCursor === null);

    // ── Q34. Pagina + 1 ─────────────────────────────────────────────
    roteiroDb({ data: linhas(1, PAGINA_STALE + 1) }, { data: [] });
    const rExcede = await listar();
    ok("Q34 PAGINA+1 linhas -> ha continuacao", rExcede.nextCursor !== null);
    ok("Q35 o cursor aponta para a centesima linha-FONTE, nao para a 101a",
      rExcede.nextCursor?.requestId === `req-${String(PAGINA_STALE).padStart(4, "0")}`);
    ok("Q36 a linha 101 NAO entra na L2 desta chamada",
      (chamadasDb[1]?.ins.request_id_consumo ?? []).length === PAGINA_STALE);
    ok("Q37 e a pagina vazia de stales ainda assim continua",
      rExcede.itens.length === 0 && rExcede.nextCursor !== null);

    // ── Q38. O cursor vem da FONTE, nao do resultado ────────────────
    //
    // A regressao que este assert trava: se o cursor saisse da ultima
    // stale RETORNADA, uma pagina sem stale devolveria `null` e a
    // varredura pararia antes do fim — tornando registros posteriores
    // permanentemente inalcancaveis.
    roteiroDb({ data: linhas(1, PAGINA_STALE + 1) }, { data: [aprovacaoDe(3)] }, { data: [] });
    const rMista = await listar();
    ok("Q38 com UMA stale na posicao 3, o cursor continua sendo a linha 100",
      rMista.itens.length === 1 &&
      rMista.itens[0]?.requestId === "req-0003" &&
      rMista.nextCursor?.requestId === `req-${String(PAGINA_STALE).padStart(4, "0")}`);

    // ── Q39. A continuacao vai ao banco na forma keyset ─────────────
    const cursor = rExcede.nextCursor;
    roteiroDb({ data: [] });
    await listar(cursor);
    const expressao = chamadasDb[0]?.or;
    ok("Q39 com cursor, L1 envia a expressao de continuacao", typeof expressao === "string");
    ok("Q40 e ela e exatamente criado_em > C  OU  (criado_em = C E request_id > R)",
      expressao === expressaoDeContinuacao(cursor!));
    ok("Q41 os dois valores vao entre aspas, por causa de '.' e ':' no timestamp",
      typeof expressao === "string" &&
      expressao.includes(`criado_em.gt.${JSON.stringify(cursor!.criadoEm)}`) &&
      expressao.includes(`and(criado_em.eq.${JSON.stringify(cursor!.criadoEm)},request_id.gt.${JSON.stringify(cursor!.requestId)})`));
    ok("Q42 a continuacao nao reabre o corte de idade nem o escopo de dono",
      typeof chamadasDb[0]?.filtros["criado_em<"] === "string" &&
      chamadasDb[0]?.filtros.user_id === DONO);

    // ── Q43. A REGRESSAO DA POSICAO 201 ─────────────────────────────
    //
    // 201 aberturas, e a stale e a ULTIMA. Com o desenho antigo — LIMIT
    // sobre as aprovacoes, sem cursor — ela era inalcancavel para
    // sempre. Aqui, tres continuacoes chegam nela.
    // ── Por que cada pagina confere a expressao ENVIADA ─────────────
    //
    // O duplo devolve o que foi roteirizado, na ordem em que foi
    // roteirizado. Entao "a pagina 2 trouxe outras linhas" NAO prova
    // continuacao: provaria a mesma coisa se a implementacao ignorasse
    // `entrada.cursor` por completo. O que amarra a cadeia e conferir,
    // em cada coleta, que a L1 levou ao banco o cursor devolvido pela
    // coleta anterior — e por isso os asserts abaixo comparam contra
    // `expressaoDeContinuacao`, o MESMO helper que a producao usa.
    roteiroDb({ data: linhas(1, PAGINA_STALE + 1) }, { data: [] });
    const p1 = await listar();
    ok("Q43 pagina 1 de 201: nenhuma stale, mas ha continuacao",
      p1.coleta === "ok" && p1.itens.length === 0 && p1.nextCursor !== null);
    ok("Q43a e a primeira coleta nao leva filtro de continuacao nenhum",
      chamadasDb[0]?.or === null);

    roteiroDb({ data: linhas(101, 201) }, { data: [] });
    const p2 = await listar(p1.nextCursor);
    ok("Q44 pagina 2: continua sem stale, e o cursor avancou",
      p2.coleta === "ok" && p2.itens.length === 0 &&
      p2.nextCursor !== null && p2.nextCursor.requestId !== p1.nextCursor?.requestId);
    ok("Q44a A CADEIA: a query da pagina 2 leva o cursor da pagina 1",
      chamadasDb[0]?.or === expressaoDeContinuacao(p1.nextCursor!),
      String(chamadasDb[0]?.or));

    roteiroDb({ data: [abertura(201)] }, { data: [aprovacaoDe(201)] }, { data: [] });
    const p3 = await listar(p2.nextCursor);
    ok("Q45 pagina 3: a stale da POSICAO 201 e finalmente alcancada",
      p3.coleta === "ok" && p3.itens.length === 1 && p3.itens[0]?.requestId === "req-0201");
    ok("Q45a A CADEIA: a query da pagina 3 leva o cursor da pagina 2",
      chamadasDb[0]?.or === expressaoDeContinuacao(p2.nextCursor!),
      String(chamadasDb[0]?.or));
    ok("Q46 e a ultima pagina encerra a varredura", p3.nextCursor === null);

    // ── Q46a. O CONTROLE que fecha o false-green ────────────────────
    //
    // A mutacao hipotetica: uma implementacao que ignore
    // `entrada.cursor` e nunca chame `.or()`. Ela passaria em Q43-Q46
    // se estes asserts nao existissem, porque o roteiro entrega paginas
    // diferentes de qualquer jeito. Aqui a sonda mostra que reprovaria.
    ok("Q46a CONTROLE: se o cursor fosse ignorado, a cadeia reprovaria",
      null !== expressaoDeContinuacao(p1.nextCursor!) &&
      expressaoDeContinuacao(p1.nextCursor!) !== expressaoDeContinuacao(p2.nextCursor!));

    // ── Q47. Ordem e desempate ──────────────────────────────────────
    const mesmoInstante = "2026-09-01T10:00:00.000+00:00";
    roteiroDb(
      {
        data: [
          abertura(9, { criado_em: mesmoInstante }),
          abertura(2, { criado_em: mesmoInstante }),
          abertura(5, { criado_em: mesmoInstante }),
        ],
      },
      { data: [aprovacaoDe(9), aprovacaoDe(2), aprovacaoDe(5)] },
      { data: [] }
    );
    const rEmpate = await listar();
    ok("Q47 timestamps iguais sao desempatados por requestId, de forma estavel",
      rEmpate.itens.map((i) => i.requestId).join(",") === "req-0002,req-0005,req-0009");

    roteiroDb(
      { data: [abertura(30), abertura(10), abertura(20)] },
      { data: [aprovacaoDe(30), aprovacaoDe(10), aprovacaoDe(20)] },
      { data: [] }
    );
    const rOrdem = await listar();
    ok("Q48 e o resultado sai da mais antiga para a mais nova",
      rOrdem.itens.map((i) => i.requestId).join(",") === "req-0010,req-0020,req-0030");

    // ── Q49. Desfecho que aparece entre L1 e L3 ─────────────────────
    roteiroDb(
      { data: [abertura(1), abertura(2)] },
      { data: [aprovacaoDe(1), aprovacaoDe(2)] },
      { data: [desfechoDe(2)] }
    );
    const rCorrida = await listar();
    ok("Q49 desfecho gravado antes da ultima leitura remove a candidata",
      rCorrida.itens.length === 1 && rCorrida.itens[0]?.requestId === "req-0001");
  }

  secao("Q3. O detector so observa — e a suite prova isso pela fonte");
  {
    ok("Q50 stale.ts e server-only", /^import "server-only";/m.test(STALE_BRUTO));
    ok("Q51 zero escrita: nenhum insert, update, upsert, delete ou rpc",
      !/\.insert\(|\.update\(|\.upsert\(|\.delete\(|\.rpc\(/.test(STALE_CODIGO));
    ok("Q52 CONTROLE: a sonda de escrita acharia uma mutacao",
      /\.insert\(|\.update\(|\.upsert\(|\.delete\(|\.rpc\(/.test('cliente.from(T).insert({})'));
    ok("Q53 zero executor: nao alcanca a execucao de Funcao",
      !/execucao-funcoes|executarFuncao|retomarAprovacao|executarComAberturaFeita|definicao\.executor/
        .test(STALE_CODIGO));
    ok("Q54 zero closer: nao registra abertura nem desfecho",
      !/chamadas\/registro|registrarAbertura|registrarDesfecho/.test(STALE_CODIGO));
    ok("Q55 zero argumentos: a coluna nao e lida nem devolvida",
      !/argumentos/.test(STALE_CODIGO));
    ok("Q56 a entrada publica nao aceita idade, corte nem relogio",
      !/(idadeMinimaMs|cutoff|agora|sla)/i.test(
        STALE_CODIGO.slice(
          STALE_CODIGO.indexOf("export interface EntradaAberturasStale"),
          STALE_CODIGO.indexOf("export function calcularCutoff")
        )));
    ok("Q57 o SLA e uma constante do modulo, e nao um parametro",
      /export const IDADE_STALE_APROVACAO_MS = /.test(STALE_CODIGO));
    ok("Q58 a origem Approval e ancorada em request_id_consumo",
      /request_id_consumo/.test(STALE_CODIGO));
    ok("Q59 nenhum erro cru do driver e propagado",
      !/error\.message|\.details|\.hint|\.stack/.test(STALE_CODIGO));
    ok("Q60 o log registra so a origem e o SQLSTATE", /sqlstate \$\{sqlstate/.test(STALE_CODIGO));
    ok("Q61 o tipo publico nao carrega userId nem payload cru",
      !/userId/.test(
        STALE_CODIGO.slice(
          STALE_CODIGO.indexOf("export interface AberturaStale"),
          STALE_CODIGO.indexOf("export type ColetaStale")
        )));

    // ── Q62: o detector ganhou UM consumidor, e ele e nomeado ───────
    //
    // Ate o APPROVAL-B1D-D1 o detector nao tinha consumidor nenhum, e o
    // assert exigia conjunto vazio. O D2-I1 criou o observador, que e a
    // camada logo acima dele — era o objetivo do gate. A exigencia nao
    // afrouxou: mesmo detector, mesma varredura, e agora igualdade de
    // conjunto contra a lista declarada.
    const OBSERVADOR = "lib/agentes/aprovacoes/observabilidade-stale.ts";
    const CONSUMIDORES_DO_DETECTOR = [OBSERVADOR];

    const consumidoresStale = [...varrerFontes("lib"), ...varrerFontes("app")].filter(
      (f) => f !== STALE && /listarAberturasStale/.test(semComentariosTs(ler(f)))
    );
    ok(`Q62 os consumidores do detector sao exatamente os declarados (${consumidoresStale.join(", ") || "nenhum"})`,
      conjuntosIguais(consumidoresStale, CONSUMIDORES_DO_DETECTOR));
    ok("Q62a CONTROLE: um segundo consumidor reprovaria",
      !conjuntosIguais([OBSERVADOR, "app/api/x/route.ts"], CONSUMIDORES_DO_DETECTOR));
    ok("Q62b CONTROLE: o observador sumir tambem reprovaria",
      !conjuntosIguais([], CONSUMIDORES_DO_DETECTOR));
    ok("Q62c CONTROLE: um caminho parecido nao passa por semelhanca",
      !conjuntosIguais(["lib/agentes/aprovacoes/observabilidade.ts"], CONSUMIDORES_DO_DETECTOR));
    ok("Q63 ANCORA: a varredura leu arquivos de verdade",
      [...varrerFontes("lib"), ...varrerFontes("app")].length > 50);
  }

  // ─── R. O observador que percorre paginas ──────────────────────────
  //
  // Ele roda DE VERDADE contra o detector de verdade, que por sua vez
  // roda contra o duplo do Supabase. Nao ha mock do `listarAberturasStale`
  // — o que se prova aqui e a maquina de estados inteira, incluindo os
  // filtros que o detector envia a cada pagina.

  const { observarAberturasStaleDoUsuario, MAX_PAGINAS_OBSERVACAO } = await import(
    "../lib/agentes/aprovacoes/observabilidade-stale"
  );

  /** As respostas de banco de UMA pagina do detector. L2 so acontece se
   *  houver abertura; L3 so se houver aprovacao vinculada. */
  const paginaDb = (
    aberturas: readonly unknown[],
    aprovacoes: readonly unknown[] = [],
    desfechos: readonly unknown[] = []
  ): RespostaDb[] => {
    const saida: RespostaDb[] = [{ data: aberturas }];
    if (aberturas.length > 0) saida.push({ data: aprovacoes });
    if (aprovacoes.length > 0) saida.push({ data: desfechos });
    return saida;
  };

  /** Quantas vezes o detector abriu uma pagina (L1) neste roteiro. */
  const paginasPedidas = () =>
    chamadasDb.filter((c) => c.tabela === "agente_funcao_chamadas" && c.filtros.fase === "abertura")
      .length;

  /** A expressao de continuacao levada na N-esima pagina (1-based). */
  const continuacaoDaPagina = (n: number): string | null | undefined =>
    chamadasDb.filter((c) => c.tabela === "agente_funcao_chamadas" && c.filtros.fase === "abertura")[
      n - 1
    ]?.or;

  const observar = (cursorInicial?: { criadoEm: string; requestId: string } | null) =>
    cursorInicial === undefined
      ? observarAberturasStaleDoUsuario({ userId: DONO })
      : observarAberturasStaleDoUsuario({ userId: DONO, cursorInicial });

  secao("R. O observador agrega segmentos, e sabe continuar");
  {
    ok("R0  ANCORA: o teto do segmento e o declarado", MAX_PAGINAS_OBSERVACAO === 20);

    // ── R1. Uma pagina, nada a observar ─────────────────────────────
    roteiroDb(...paginaDb([]));
    const vazio = await observar();
    ok("D21 pagina unica sem stale -> total 0 e fonte esgotada",
      vazio.coleta === "ok" && vazio.total === 0 && vazio.esgotado === true &&
      vazio.nextCursor === null);
    ok("D21a e o agregado vem neutro, nao indefinido",
      vazio.idadeMaximaMs === null && vazio.maisAntigaEm === null &&
      JSON.stringify(vazio.porFuncao) === "{}" && vazio.paginas === 1);
    ok("R1  sem cursorInicial, a primeira pagina nao leva continuacao",
      continuacaoDaPagina(1) === null);

    // ── R2. Uma pagina com stales ───────────────────────────────────
    roteiroDb(...paginaDb([abertura(1), abertura(2)], [aprovacaoDe(1), aprovacaoDe(2)], []));
    const cheio = await observar();
    ok("D22 pagina com stales agrega o que viu",
      cheio.coleta === "ok" && cheio.total === 2 && cheio.esgotado === true);
    ok("D27 porFuncao conta por Funcao",
      JSON.stringify(cheio.porFuncao) === JSON.stringify({ [FUNCAO_ST]: 2 }));
    ok("D26 maisAntigaEm e o menor criado_em observado",
      cheio.maisAntigaEm === "2026-09-01T10:00:01.000+00:00");
    ok("D25 idadeMaximaMs e a maior idade observada",
      cheio.idadeMaximaMs === Date.parse(cheio.fimEm) - Date.parse("2026-09-01T10:00:01.000+00:00"));

    // ── R3. Duas paginas, e a vazia NAO para o percurso ─────────────
    //
    // A primeira pagina traz 101 aberturas sem aprovacao nenhuma: zero
    // stale, mas ha continuacao. Parar aqui deixaria a segunda pagina
    // inalcancavel — a regressao que este assert trava.
    roteiroDb(
      ...paginaDb(linhas(1, PAGINA_STALE + 1), []),
      ...paginaDb([abertura(201)], [aprovacaoDe(201)], [])
    );
    const duas = await observar();
    ok("D23 pagina sem stale mas com continuacao NAO encerra o percurso",
      duas.paginas === 2 && paginasPedidas() === 2);
    ok("D24 e o segmento soma o que apareceu depois",
      duas.coleta === "ok" && duas.total === 1 && duas.esgotado === true &&
      duas.nextCursor === null);
    ok("R2  a segunda pagina levou o cursor devolvido pela primeira",
      continuacaoDaPagina(2) ===
        expressaoDeContinuacao({
          criadoEm: `2026-09-01T10:01:40.000+00:00`,
          requestId: `req-${String(PAGINA_STALE).padStart(4, "0")}`,
        }));
    ok("D28 inicioEm e o carimbo da PRIMEIRA pagina",
      typeof duas.inicioEm === "string" && Number.isFinite(Date.parse(duas.inicioEm)));
    ok("D29 fimEm e o carimbo da ULTIMA, e nao antecede o inicio",
      Date.parse(duas.fimEm) >= Date.parse(duas.inicioEm));

    // ── R4. O teto do segmento ──────────────────────────────────────
    //
    // Vinte paginas cheias, todas sem aprovacao. A vigesima ainda tem
    // continuacao: o observador precisa parar ali e DEVOLVER o cursor,
    // sem pedir a pagina 21.
    // Cada pagina traz linhas DIFERENTES — 20 x 101 = 2.020 fontes. Se
    // repetissem, o cursor nao andaria e o guard de contrato pararia o
    // percurso na segunda pagina, que e outro teste.
    const roteiroCheio: RespostaDb[] = [];
    for (let p = 0; p < MAX_PAGINAS_OBSERVACAO; p++) {
      const de = p * (PAGINA_STALE + 1) + 1;
      roteiroCheio.push(...paginaDb(linhas(de, de + PAGINA_STALE), []));
    }
    roteiroDb(...roteiroCheio);
    const noTeto = await observar();

    ok("R3  o teto para o segmento em MAX_PAGINAS_OBSERVACAO",
      noTeto.paginas === MAX_PAGINAS_OBSERVACAO && paginasPedidas() === MAX_PAGINAS_OBSERVACAO,
      `${paginasPedidas()} pagina(s)`);
    ok("R4  a pagina 21 NAO e pedida nesta execucao",
      paginasPedidas() <= MAX_PAGINAS_OBSERVACAO);
    ok("R5  atingir o teto nao e esgotar a fonte",
      noTeto.coleta === "ok" && noTeto.esgotado === false && noTeto.nextCursor !== null);
    ok("D19 total 0 COM continuacao e estado valido — nao significa ausencia",
      noTeto.total === 0 && noTeto.nextCursor !== null);

    // ── R6. A CONTINUACAO ENTRE EXECUCOES ───────────────────────────
    //
    // A regressao que este bloco trava: sem `cursorInicial`, a execucao
    // seguinte releria as mesmas 20 paginas e as posteriores (>2.000
    // fontes) nunca seriam observadas.
    const continuar = noTeto.nextCursor!;
    roteiroDb(...paginaDb([abertura(201)], [aprovacaoDe(201)], []));
    const segundoSegmento = await observar(continuar);

    ok("R6  o segundo segmento recebe o cursor do primeiro",
      continuacaoDaPagina(1) === expressaoDeContinuacao(continuar));
    ok("R7  e NAO recomeca do zero", continuacaoDaPagina(1) !== null);
    ok("R8  alcancando a stale posterior ao teto (> MAX_PAGINAS)",
      segundoSegmento.coleta === "ok" && segundoSegmento.total === 1 &&
      segundoSegmento.esgotado === true && segundoSegmento.nextCursor === null);

    // ── R9. Segmento iniciado por cursor que chega ao fim ───────────
    roteiroDb(...paginaDb([]));
    const doCursorAoFim = await observar(continuar);
    ok("R9  segmento que comeca em cursor e chega ao fim: esgotado, sem proximo",
      doCursorAoFim.esgotado === true && doCursorAoFim.nextCursor === null &&
      doCursorAoFim.coleta === "ok");

    // ── R10. Falhas nao viram diagnostico ───────────────────────────
    roteiroDb(falhaDb);
    const falha1 = await observar();
    ok("D30 falha na primeira pagina -> coleta falha_leitura",
      falha1.coleta === "falha_leitura" && falha1.esgotado === false &&
      falha1.nextCursor === null);
    ok("D30a e o agregado volta NEUTRO, para nao virar diagnostico",
      falha1.total === 0 && falha1.idadeMaximaMs === null && falha1.maisAntigaEm === null &&
      JSON.stringify(falha1.porFuncao) === "{}");

    roteiroDb(
      ...paginaDb(linhas(1, PAGINA_STALE + 1), [aprovacaoDe(3)], []),
      falhaDb
    );
    const falha2 = await observar();
    ok("D31 falha numa pagina POSTERIOR tambem interrompe",
      falha2.coleta === "falha_leitura" && falha2.paginas === 2);
    ok("D31a e as metricas parciais da primeira pagina sao descartadas",
      falha2.total === 0 && JSON.stringify(falha2.porFuncao) === "{}" &&
      falha2.nextCursor === null && falha2.esgotado === false);

    // ── R11. Contrato quebrado do detector ──────────────────────────
    roteiroDb();
    const entradaRuim = await observarAberturasStaleDoUsuario({ userId: "" });
    ok("D32 entrada invalida vinda do detector NAO vira ok/zero stale",
      entradaRuim.coleta === "entrada_invalida" && entradaRuim.total === 0 &&
      entradaRuim.esgotado === false && entradaRuim.nextCursor === null);

    // Cursor que nao anda: a mesma pagina voltaria para sempre.
    const parado = { criadoEm: "2026-09-01T10:01:40.000+00:00", requestId: "req-0100" };
    roteiroDb(...paginaDb(linhas(1, PAGINA_STALE + 1), []));
    const naoAnda = await observar(parado);
    ok("D33 cursor que volta igual ao anterior quebra o contrato",
      naoAnda.coleta === "contrato_invalido" && naoAnda.total === 0 &&
      naoAnda.esgotado === false && naoAnda.nextCursor === null);

    // ── R13. CHAVE DE FUNCAO QUE COLIDE COM O PROTOTIPO ─────────────
    //
    // A regressao que este bloco trava: com `{}` como mapa, contar
    // `__proto__` some (o setter ignora) e contar `constructor` produz
    // uma STRING dentro de um `Record<string, number>`. O CHECK do banco
    // recusa esses ids hoje — mas o agregador nao pode estar certo por
    // acidente de constraint alheia.
    const ESPECIAIS = ["__proto__", "constructor"] as const;
    for (const nome of ESPECIAIS) {
      roteiroDb(
        ...paginaDb(
          [abertura(1, { funcao_id: nome }), abertura(2, { funcao_id: nome })],
          [aprovacaoDe(1, { funcao_id: nome }), aprovacaoDe(2, { funcao_id: nome })],
          []
        )
      );
      const r = await observar();
      const contagem = (r.porFuncao as Record<string, unknown>)[nome];

      ok(`R13 funcaoId "${nome}" e contado como numero, e nao some`,
        contagem === 2 && typeof contagem === "number", JSON.stringify(contagem));
      ok(`R13a e vira propriedade PROPRIA de porFuncao ("${nome}")`,
        Object.prototype.hasOwnProperty.call(r.porFuncao, nome));
      ok(`R13b o total nao diverge da contagem ("${nome}")`, r.total === 2);
    }
    ok("R13c CONTROLE: com objeto literal a contagem de __proto__ se perderia",
      (() => {
        const ingenuo: Record<string, unknown> = {};
        for (let i = 0; i < 2; i++) {
          ingenuo["__proto__"] = ((ingenuo["__proto__"] as number) ?? 0) + 1;
        }
        return ingenuo["__proto__"] !== 2;
      })());

    // ── R14. TIMESTAMPS COM OFFSETS DIFERENTES ──────────────────────
    //
    // `2026-09-01T10:00:00-03:00` e 13:00Z — mais NOVO que
    // `2026-09-01T12:00:00Z`. Na ordem lexical `10:00...` vem antes, e a
    // implementacao antiga elegeria a mais nova como "mais antiga".
    const COM_OFFSET = "2026-09-01T10:00:00-03:00";
    const EM_UTC = "2026-09-01T12:00:00Z";
    roteiroDb(
      ...paginaDb(
        [abertura(1, { criado_em: COM_OFFSET }), abertura(2, { criado_em: EM_UTC })],
        [aprovacaoDe(1), aprovacaoDe(2)],
        []
      )
    );
    const comOffsets = await observar();

    ok("R14 ANCORA: os dois carimbos existem e discordam entre texto e tempo",
      COM_OFFSET < EM_UTC && Date.parse(COM_OFFSET) > Date.parse(EM_UTC));
    ok("R14a maisAntigaEm e a temporalmente mais antiga, nao a lexicamente menor",
      comOffsets.maisAntigaEm === EM_UTC, String(comOffsets.maisAntigaEm));
    ok("R14b e as duas continuam contadas", comOffsets.total === 2);

    // ── R12. Tenant ─────────────────────────────────────────────────
    roteiroDb(...paginaDb([]));
    await observar({ criadoEm: "2026-09-01T10:00:00.000+00:00", requestId: "req-9999" });
    ok("D38 o userId enviado ao detector e o da entrada, sempre",
      chamadasDb.every((c) => c.filtros.user_id === undefined || c.filtros.user_id === DONO));
    ok("R10 e o cursor tecnico nunca substitui o tenant",
      chamadasDb[0]?.filtros.user_id === DONO);
  }

  secao("R2. O observador so observa — provado pela fonte");
  {
    const OBS = "lib/agentes/aprovacoes/observabilidade-stale.ts";
    const OBS_BRUTO = ler(OBS);
    const OBS_CODIGO = semComentariosTs(OBS_BRUTO);

    ok("R11 e server-only", /^import "server-only";/m.test(OBS_BRUTO));
    ok("R12 nao fala com o banco: zero import de supabase",
      !/supabase/i.test(OBS_CODIGO));
    ok("R13 consome o detector, e so ele",
      /from "@\/lib\/agentes\/aprovacoes\/stale"/.test(OBS_CODIGO) &&
      (OBS_CODIGO.match(/from "/g) ?? []).length === 1);
    ok("D35 zero escrita",
      !/\.insert\(|\.update\(|\.upsert\(|\.delete\(|\.rpc\(/.test(OBS_CODIGO));
    ok("D36 zero executor",
      !/execucao-funcoes|executarFuncao|retomarAprovacao|executarComAberturaFeita|definicao\.executor/
        .test(OBS_CODIGO));
    ok("D37 zero closer",
      !/chamadas\/registro|registrarAbertura|registrarDesfecho/.test(OBS_CODIGO));
    ok("D34 zero argumentos", !/argumentos/.test(OBS_CODIGO));
    ok("D39 nenhuma enumeracao global de tenants",
      !/perfil|auth\.users|distinct|todos os usuarios/i.test(OBS_CODIGO));
    ok("R14 nao nomeia a tabela de aprovacoes — quem faz isso e a camada de baixo",
      !/agente_funcao_aprovacoes|agente_funcao_chamadas/.test(OBS_CODIGO));
    ok("R15 a entrada publica nao aceita teto, relogio nem SLA",
      !/(maxPaginas|cutoff|agora|idadeMinima|sla)/i.test(
        OBS_CODIGO.slice(
          OBS_CODIGO.indexOf("export interface EntradaObservacaoStale"),
          OBS_CODIGO.indexOf("function mesmoPonto")
        )));
    ok("R16 o teto e constante do modulo",
      /export const MAX_PAGINAS_OBSERVACAO = 20/.test(OBS_CODIGO));
    ok("R17 o log nao carrega dono, id nem cursor",
      !/console\.[a-z]+\([^)]*(userId|requestId|aprovacaoId|cursor)/.test(OBS_CODIGO));
    ok("R18 nao para por pagina vazia — o criterio e o cursor",
      !/itens\.length === 0/.test(OBS_CODIGO) && /nextCursor === null/.test(OBS_CODIGO));

    // ── R19: o observador ganhou UMA superficie, e ela e nomeada ────
    //
    // Ate o D2-I1 o observador era capability sem chamador, e o assert
    // exigia conjunto vazio. O D2-I2 criou a rota operacional — era o
    // objetivo do gate, e sem ela ninguem pergunta. A exigencia nao
    // afrouxou: mesma varredura, mesmo detector, agora com igualdade de
    // conjunto contra a lista declarada.
    const ROTA_STALE = "app/api/admin/agentes/aprovacoes-stale/route.ts";
    const CONSUMIDORES_DO_OBSERVADOR = [ROTA_STALE];

    const consumidoresObs = [...varrerFontes("lib"), ...varrerFontes("app")].filter(
      (f) => f !== OBS && /observarAberturasStaleDoUsuario/.test(semComentariosTs(ler(f)))
    );
    ok(`R19 os consumidores do observador sao exatamente os declarados (${consumidoresObs.join(", ") || "nenhum"})`,
      conjuntosIguais(consumidoresObs, CONSUMIDORES_DO_OBSERVADOR));
    ok("R19a CONTROLE: um segundo consumidor de producao reprovaria",
      !conjuntosIguais([ROTA_STALE, "app/api/x/route.ts"], CONSUMIDORES_DO_OBSERVADOR));
    ok("R19b CONTROLE: a rota sumir reprovaria",
      !conjuntosIguais([], CONSUMIDORES_DO_OBSERVADOR));
    ok("R19c CONTROLE: um caminho parecido nao passa por semelhanca",
      !conjuntosIguais(["app/api/admin/agentes/aprovacoes-stale/rota.ts"],
        CONSUMIDORES_DO_OBSERVADOR));

    // A retomada continua sem superficie: o D2-I2 abre observabilidade,
    // NAO abre execucao. Este assert e o que separa os dois.
    const consumidoresResume = [...varrerFontes("lib"), ...varrerFontes("app")].filter(
      (f) => f !== "lib/agentes/execucao-funcoes/executar.ts" &&
        /retomarAprovacao/.test(semComentariosTs(ler(f)))
    );
    ok(`R20 retomarAprovacao continua SEM consumidor de producao (${consumidoresResume.join(", ") || "nenhum"})`,
      consumidoresResume.length === 0);

    // ── R21..R24 — a fronteira da FUNCTION-RUNTIME-P0 ───────────────
    //
    // O P0 deu ao runtime de Task como PARAR esperando uma decisao
    // humana. Ele NAO liga nenhuma ponta de Approval: nao cria, nao
    // decide, nao consome e nao retoma. O sentinel carrega um
    // `aprovacaoId` como marcador, e so.
    const erros = semComentariosTs(ler("lib/agentes/erros.ts"));
    const executor = semComentariosTs(ler("lib/agentes/executar-tarefa.ts"));
    const capWorker = semComentariosTs(ler("lib/agentes/capability-worker.ts"));

    ok("R21 o sentinel de pausa existe e carrega SO o id da aprovacao",
      /export class PausaPorAprovacao extends Error/.test(erros) &&
      /readonly aprovacaoId: string;/.test(erros));
    ok("R22 e ele NAO alcanca o dominio de Approval",
      !/criarAprovacao|decidirAprovacao|consumirAprovacao|retomarAprovacao|agente_funcao_aprovacoes/
        .test(erros));
    ok("R23 o executor pausa a Task sem tocar em Approval",
      /PausaPorAprovacao/.test(executor) &&
      /aguardarAprovacaoTarefa\(/.test(executor) &&
      !/criarAprovacao|decidirAprovacao|consumirAprovacao|retomarAprovacao|agente_funcao_aprovacoes/
        .test(executor));
    // ── R24 migrado na APPROVAL-DECISION-RESUME-D2 ────────────────
    //
    // Ate aqui a capability nao podia conhecer aprovacao NENHUMA, e
    // estava certo: nao havia onde guardar o vinculo, entao qualquer
    // mencao seria o worker opinando sobre um dominio que nao e dele.
    //
    // O D1 criou o lugar — `agente_tarefas.aprovacao_aguardada_id` — e o
    // D2 liga o caminho. O assert nao afrouxou: ele passou a exigir que
    // a capability conheca EXATAMENTE uma coisa, o `p_aprovacao_id` que
    // repassa, e continue sem conhecer a TABELA de aprovacoes, sem criar
    // e sem retomar. Ela transporta um id; nao decide nada sobre ele.
    ok("R24 a capability de pausa transporta o id, e so isso",
      /aguardar_aprovacao_tarefa/.test(capWorker) &&
      /p_aprovacao_id:\s*aprovacaoId/.test(capWorker) &&
      !/agente_funcao_aprovacoes|criarAprovacao|retomarAprovacao|decidirAprovacao|consumirAprovacao/
        .test(capWorker));
    ok("R24 CONTROLE NEGATIVO: tocar a tabela de aprovacoes reprova",
      /agente_funcao_aprovacoes/.test(capWorker + '\nfrom("agente_funcao_aprovacoes")'));
    ok("R25 CONTROLE: as sondas acusam o padrao que proibem",
      /retomarAprovacao/.test("await retomarAprovacao({ userId, aprovacaoId })"));
  }

  // ─── S. A superficie operacional ───────────────────────────────────
  //
  // A rota roda DE VERDADE: autenticacao real (token assinado de
  // verdade, cookie de verdade), observador real, detector real, contra
  // o duplo de banco. Nao ha auth fake, nao ha observador injetado — a
  // producao nao ganhou nenhuma porta para teste.

  const { POST } = await import("../app/api/admin/agentes/aprovacoes-stale/route");
  const { assinarSessao } = await import("../lib/sessao-assinada");

  const SEGREDO_TESTE = "segredo-de-teste-com-pelo-menos-32-bytes!!";
  process.env.SESSION_SECRET = SEGREDO_TESTE;
  const UID = "77777777-7777-4777-8777-777777777777";

  const tokenValido = await assinarSessao(UID, {
    segredo: SEGREDO_TESTE,
    agoraSegundos: Math.floor(Date.now() / 1000),
  });

  const pedir = (corpo?: unknown, cookie: string | null = `cds_session=${tokenValido}`) =>
    POST(
      new Request("https://cds.local/api/admin/agentes/aprovacoes-stale", {
        method: "POST",
        headers: cookie === null ? {} : { cookie },
        body:
          corpo === undefined
            ? undefined
            : typeof corpo === "string"
              ? corpo
              : JSON.stringify(corpo),
      })
    );

  /** O `user_id` que o detector recebeu na primeira leitura. */
  const donoConsultado = () => chamadasDb[0]?.filtros.user_id;

  secao("S. A rota operacional: autenticada, tenant-scoped e read-only");
  {
    // ── S1. Sem sessao ──────────────────────────────────────────────
    roteiroDb(...paginaDb([]));
    const semAuth = await pedir({}, null);
    ok("S1  sem cookie de sessao -> 401", semAuth.status === 401);
    ok("S2  e o observador NAO e chamado", chamadasDb.length === 0);

    roteiroDb(...paginaDb([]));
    const tokenRuim = await pedir({}, "cds_session=nao-e-um-token");
    ok("S3  token adulterado -> 401", tokenRuim.status === 401);
    ok("S4  e tambem sem tocar o banco", chamadasDb.length === 0);

    // ── S5. Caminho feliz ───────────────────────────────────────────
    roteiroDb(...paginaDb([abertura(1)], [aprovacaoDe(1)], []));
    const ok200 = await pedir({});
    const corpo200 = (await ok200.json()) as { ok: boolean; resumo: Record<string, unknown> };

    ok("S5  sessao valida com coleta ok -> 200", ok200.status === 200 && corpo200.ok === true);
    ok("S6  o tenant consultado e o uid da SESSAO", donoConsultado() === UID);
    ok("S7  o resumo do segmento viaja inteiro",
      ["total", "idadeMaximaMs", "maisAntigaEm", "porFuncao", "paginas", "esgotado",
       "nextCursor", "coleta", "inicioEm", "fimEm"].every((c) => c in corpo200.resumo));
    ok("S8  e traz a stale observada", corpo200.resumo.total === 1);
    ok("S9  UMA passada do observador por request",
      chamadasDb.filter((c) => c.tabela === "agente_funcao_chamadas" &&
        c.filtros.fase === "abertura").length === 1);

    // ── S10. Corpo ──────────────────────────────────────────────────
    roteiroDb(...paginaDb([]));
    const semCorpo = await pedir();
    ok("S10 corpo ausente vale como sem cursor",
      semCorpo.status === 200 && chamadasDb[0]?.or === null);

    roteiroDb(...paginaDb([]));
    const cursorNulo = await pedir({ cursor: null });
    ok("S11 cursor null tambem", cursorNulo.status === 200 && chamadasDb[0]?.or === null);

    const cursorBom = { criadoEm: "2026-09-01T10:01:40.000+00:00", requestId: "req-0100" };
    roteiroDb(...paginaDb([]));
    const comCursor = await pedir({ cursor: cursorBom });
    ok("S12 cursor valido e encaminhado ao detector",
      comCursor.status === 200 && chamadasDb[0]?.or === expressaoDeContinuacao(cursorBom));

    roteiroDb(...paginaDb([]));
    const jsonRuim = await pedir("{ nao e json");
    ok("S13 JSON invalido -> 400", jsonRuim.status === 400 && chamadasDb.length === 0);

    roteiroDb(...paginaDb([]));
    const arrayCorpo = await pedir([1, 2, 3]);
    ok("S14 corpo array -> 400", arrayCorpo.status === 400 && chamadasDb.length === 0);

    roteiroDb(...paginaDb([]));
    const cursorAbsurdo = await pedir({ cursor: { criadoEm: 42, requestId: [] } });
    ok("S15 cursor com tipos absurdos -> 400",
      cursorAbsurdo.status === 400 && chamadasDb.length === 0);

    // ── S16. A FRONTEIRA DE TENANT ──────────────────────────────────
    //
    // O corpo nao pode escolher dono. Recusar, e nao ignorar: ignorar em
    // silencio ensinaria que o campo existe e nao faz nada.
    const OUTRO = "88888888-8888-4888-8888-888888888888";
    for (const [rotulo, corpo] of [
      ["userId", { userId: OUTRO }],
      ["user_id", { user_id: OUTRO }],
      ["cursor + userId", { cursor: null, userId: OUTRO }],
    ] as const) {
      roteiroDb(...paginaDb([]));
      const r = await pedir(corpo);
      ok(`S16 corpo com ${rotulo} -> 400`, r.status === 400);
      ok(`S16a e o observador nem e chamado (${rotulo})`, chamadasDb.length === 0);
    }

    // ── S17. Os codigos de falha ────────────────────────────────────
    roteiroDb(falhaDb);
    const falhaLeitura = await pedir({});
    const corpoFalha = (await falhaLeitura.json()) as Record<string, unknown>;
    ok("S17 falha_leitura -> 503, e nao 200 com zero stale",
      falhaLeitura.status === 503 && corpoFalha.ok === false &&
      corpoFalha.erro === "falha_leitura");
    ok("S18 e nenhum erro cru do driver viaja no corpo",
      !/sqlstate|08006|message|stack|select/i.test(JSON.stringify(corpoFalha)));

    // Cursor parado: o detector devolve o mesmo ponto e o observador
    // classifica como contrato_invalido.
    const parado = { criadoEm: "2026-09-01T10:01:40.000+00:00", requestId: "req-0100" };
    roteiroDb(...paginaDb(linhas(1, PAGINA_STALE + 1), []));
    const contrato = await pedir({ cursor: parado });
    ok("S19 contrato_invalido -> 500", contrato.status === 500);

    // ── S20. Segmento incompleto ────────────────────────────────────
    const roteiroTeto: RespostaDb[] = [];
    for (let p = 0; p < MAX_PAGINAS_OBSERVACAO; p++) {
      const de = p * (PAGINA_STALE + 1) + 1;
      roteiroTeto.push(...paginaDb(linhas(de, de + PAGINA_STALE), []));
    }
    roteiroDb(...roteiroTeto);
    const incompleto = await pedir({});
    const corpoIncompleto = (await incompleto.json()) as { resumo: Record<string, unknown> };

    ok("S20 segmento que atinge o teto volta 200 com esgotado=false",
      incompleto.status === 200 && corpoIncompleto.resumo.esgotado === false);
    ok("S21 e devolve o cursor para o proximo segmento",
      corpoIncompleto.resumo.nextCursor !== null);
    ok("S22 a rota NAO itera sozinha ate esgotar",
      chamadasDb.filter((c) => c.tabela === "agente_funcao_chamadas" &&
        c.filtros.fase === "abertura").length === MAX_PAGINAS_OBSERVACAO);
  }

  secao("S2. A rota nao ganha poder nenhum — provado pela fonte");
  {
    const ROTA = "app/api/admin/agentes/aprovacoes-stale/route.ts";
    const ROTA_CODIGO = semComentariosTs(ler(ROTA));

    ok("S23 a rota usa a autenticacao existente, e nao uma paralela",
      /autenticarRequisicao\(request\)/.test(ROTA_CODIGO) &&
      /from "@\/lib\/autenticacao"/.test(ROTA_CODIGO));
    ok("S24 o userId sai de auth.uid, e de lugar nenhum mais",
      /const userId = auth\.uid;/.test(ROTA_CODIGO) &&
      !/body[^\n]*user_?[Ii]d|corpo[^\n]*\.user_?[Ii]d/.test(ROTA_CODIGO));
    ok("S25 consome o observador, nao o detector",
      /observarAberturasStaleDoUsuario/.test(ROTA_CODIGO) &&
      !/listarAberturasStale|aprovacoes\/stale/.test(ROTA_CODIGO));
    ok("S26 zero Supabase e zero tabela",
      !/supabase/i.test(ROTA_CODIGO) &&
      !/agente_funcao_aprovacoes|agente_funcao_chamadas/.test(ROTA_CODIGO));
    ok("S27 zero escrita",
      !/\.insert\(|\.update\(|\.upsert\(|\.delete\(|\.rpc\(/.test(ROTA_CODIGO));
    ok("S28 zero executor e zero retomada",
      !/executarFuncao|retomarAprovacao|executarComAberturaFeita|execucao-funcoes/
        .test(ROTA_CODIGO));
    ok("S29 zero closer",
      !/registrarAbertura|registrarDesfecho|chamadas\/registro/.test(ROTA_CODIGO));
    ok("S30 zero processo de fundo",
      !/setInterval|setTimeout|cron|scheduler|queue|worker/i.test(ROTA_CODIGO));
    ok("S31 zero varredura de tenants",
      !/perfil|auth\.users|todos os usuarios/i.test(ROTA_CODIGO));
    ok("S32 nao chama o observador mais de uma vez",
      (ROTA_CODIGO.match(/observarAberturasStaleDoUsuario\(/g) ?? []).length === 1);
    ok("S33 nao loga dono, cursor nem id",
      !/console\.[a-z]+\([^)]*(userId|uid|cursor|requestId|aprovacaoId)/.test(ROTA_CODIGO));
    ok("S34 o corpo aceito e uma allowlist fechada",
      /CAMPOS_ACEITOS = new Set\(\["cursor"\]\)/.test(ROTA_CODIGO));
    ok("S35 o cursor tambem tem allowlist fechada",
      /CAMPOS_CURSOR_ACEITOS = new Set\(\["criadoEm", "requestId"\]\)/.test(ROTA_CODIGO));
    ok("S36 o 200 exige coleta ok declarada, e nao sobra de fluxo",
      /case "ok":/.test(ROTA_CODIGO) && /default:/.test(ROTA_CODIGO));
  }

  // ─── S3. As fronteiras que o review D2-I2-R1 apontou ───────────────

  secao("S3. Cursor fechado e status fail-closed");
  {
    ok("S37 ANCORA: o envelope delegante do observador foi instalado", interceptouObservador);

    const CURSOR_BOM = { criadoEm: "2026-09-01T10:01:40.000+00:00", requestId: "req-0100" };

    // ── F1-A. O cursor legitimo continua funcionando ────────────────
    roteiroDb(...paginaDb([]));
    const valido = await pedir({ cursor: CURSOR_BOM });
    ok("F1-A cursor valido sem extras continua aceito",
      valido.status === 200 && chamadasDb[0]?.or === expressaoDeContinuacao(CURSOR_BOM));

    // ── F1-B/C/D. Extras dentro do cursor sao RECUSADOS ─────────────
    //
    // A regressao: antes eles passavam e eram descartados em silencio.
    // `userId` ali era inerte — mas um contexto tecnico com contrato
    // aberto e onde autoridade escondida entra sem ninguem ver.
    const EXTRAS: Array<[string, Record<string, unknown>]> = [
      ["userId", { ...CURSOR_BOM, userId: "88888888-8888-4888-8888-888888888888" }],
      ["user_id", { ...CURSOR_BOM, user_id: "88888888-8888-4888-8888-888888888888" }],
      ["campo generico", { ...CURSOR_BOM, qualquerOutraCoisa: 1 }],
    ];
    let recusados = 0;
    let semTocarBanco = 0;
    for (const [, cursor] of EXTRAS) {
      roteiroDb(...paginaDb([]));
      const r = await pedir({ cursor });
      if (r.status === 400) recusados++;
      if (chamadasDb.length === 0) semTocarBanco++;
    }
    ok(`F1-BCD cursor com campo extra -> 400 nos ${EXTRAS.length} casos`,
      recusados === EXTRAS.length, `${recusados}/${EXTRAS.length}`);
    ok("F1-E e em nenhum deles o observador chega a ser chamado",
      semTocarBanco === EXTRAS.length, `${semTocarBanco}/${EXTRAS.length}`);

    // ── F1-F/G/H. Coleta desconhecida NAO vira sucesso ──────────────
    //
    // A regressao: com o fall-through antigo, qualquer coleta fora das
    // tres tratadas caia no `return` final e virava 200.
    respostaObservadorForcada = {
      total: 7,
      idadeMaximaMs: 1,
      maisAntigaEm: "2026-09-01T10:00:00.000+00:00",
      porFuncao: { "vendas.consultar": 7 },
      paginas: 1,
      esgotado: true,
      nextCursor: null,
      coleta: "variacao_futura",
      inicioEm: "2026-09-01T10:00:00.000+00:00",
      fimEm: "2026-09-01T10:00:00.000+00:00",
    };
    roteiroDb();
    const desconhecida = await pedir({});
    const corpoDesconhecida = await desconhecida.text();
    respostaObservadorForcada = null;

    ok("F1-F coleta desconhecida NAO retorna 200", desconhecida.status !== 200);
    ok("F1-G e responde 500 fail-closed", desconhecida.status === 500);
    ok("F1-H sem ecoar o valor interno nem o resumo",
      !/variacao_futura/.test(corpoDesconhecida) && !/porFuncao|esgotado/.test(corpoDesconhecida),
      corpoDesconhecida);
    ok("F1-I e o corpo e o erro generico sanitizado",
      JSON.parse(corpoDesconhecida).erro === "erro_interno");

    // ── CONTROLE: o envelope volta a delegar ────────────────────────
    roteiroDb(...paginaDb([abertura(1)], [aprovacaoDe(1)], []));
    const voltouAoReal = await pedir({});
    ok("F1-J CONTROLE: com a resposta forcada limpa, o observador real volta",
      voltouAoReal.status === 200 &&
      ((await voltouAoReal.json()) as { resumo: { total: number } }).resumo.total === 1);
  }

  // ── T. A fila do dono: leitura real, executada ───────────────────
  //
  // APPROVAL-UI-API-A1. A secao M prova pela FONTE quem pode nomear a
  // tabela; esta EXECUTA `listarAprovacoesPendentesDoDono` contra o
  // duplo e le a consulta que ela montou. As duas coisas sao
  // necessarias: fonte nao prova o filtro que chega ao datastore, e
  // execucao sozinha nao prova que ninguem mais escreve.
  //
  // O ponto que mais importa aqui e a AUSENCIA: nenhuma RPC, nenhum
  // insert, nenhum update. Uma fila que grava ao ser aberta teria
  // escrito duas vezes numa tela recarregada.
  secao("T. A fila de aprovacoes pendentes do dono");
  {
    const { listarAprovacoesPendentesDoDono, LIMITE_FILA_APROVACOES } = await import(
      "../lib/agentes/aprovacoes/leitura"
    );

    const DONO = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
    const AG = "cccccccc-3333-4333-8333-cccccccccccc";
    const TF = "dddddddd-4444-4444-8444-dddddddddddd";

    /** Uma linha como o Postgres a devolveria — INCLUSIVE os campos
     *  internos, para que a prova de projecao nao seja vacua. */
    const linhaAprovacao = (extra: Record<string, unknown> = {}) => ({
      id: "11111111-1111-4111-8111-111111111111",
      agente_id: AG,
      tarefa_id: TF,
      funcao_id: "vendas.consultar",
      revisao_funcao: "1",
      acesso: "leitura",
      estado: "pendente",
      criado_em: "2026-09-14T21:00:26.856Z",
      expira_em: "2026-09-15T21:00:26.856Z",
      argumentos: { dataInicio: "2026-09-12", dataFim: "2026-09-13" },
      conexao_plataforma: null,
      conexao_recurso: null,
      // Os internos. Se a projecao vazar, estes aparecem.
      user_id: DONO,
      argumentos_hash: "a".repeat(64),
      fingerprint: "b".repeat(64),
      request_id_solicitacao: "req-solicitacao",
      request_id_consumo: null,
      conexao_loja_id: null,
      decidido_por: null,
      ...extra,
    });

    const linhaAgente = { id: AG, nome: "Teste Chat IA Real" };

    // ── T1..T6 — a CONSULTA que chegou ao datastore ───────────────
    roteiroDb({ data: [linhaAprovacao()] }, { data: [linhaAgente] });
    const r = await listarAprovacoesPendentesDoDono(DONO);
    const q1 = chamadasDb[0];
    const q2 = chamadasDb[1];

    ok("T1  ANCORA: o duplo foi exercitado por duas leituras",
      chamadasDb.length === 2 &&
      q1?.tabela === "agente_funcao_aprovacoes" &&
      q2?.tabela === "agentes",
      `${chamadasDb.length}`);
    ok("T2  a consulta filtra pelo DONO no datastore, nao depois em JS",
      q1?.filtros["user_id"] === DONO);
    ok("T3  e filtra estado pendente no datastore",
      q1?.filtros["estado"] === "pendente");
    ok("T4  e exige expira_em ACIMA do instante da leitura",
      typeof q1?.filtros["expira_em>"] === "string" &&
      !Number.isNaN(Date.parse(String(q1?.filtros["expira_em>"]))));
    ok("T5  ordena mais recente primeiro, com desempate estavel por id",
      JSON.stringify(q1?.ordens) ===
        JSON.stringify([
          { coluna: "criado_em", asc: false },
          { coluna: "id", asc: false },
        ]),
      JSON.stringify(q1?.ordens));
    ok("T6  a fila e BOUNDED e o teto e o declarado",
      q1?.limite === LIMITE_FILA_APROVACOES && LIMITE_FILA_APROVACOES === 50,
      String(q1?.limite));

    // ── T7..T9 — o SELECT e nominal ───────────────────────────────
    const colunas = String(q1?.select ?? "").split(",").map((c) => c.trim()).filter(Boolean);
    ok("T7  o select e nominal, nunca `*`",
      !colunas.includes("*") && !/\*/.test(String(q1?.select ?? "")));
    ok(`T8  e pede exatamente as doze colunas publicas (${colunas.length})`,
      JSON.stringify([...colunas].sort()) ===
        JSON.stringify([
          "acesso", "agente_id", "argumentos", "conexao_plataforma", "conexao_recurso",
          "criado_em", "estado", "expira_em", "funcao_id", "id", "revisao_funcao", "tarefa_id",
        ]),
      colunas.join(", "));
    ok("T9  nenhuma coluna interna e sequer LIDA do banco",
      !/user_id|argumentos_hash|fingerprint|request_id|conexao_loja_id|decidido_por|cancelado_por|motivo_recusa/
        .test(String(q1?.select ?? "")));

    // ── T10..T12 — o lookup do nome, em lote e escopado ───────────
    ok("T10 o nome do agente vem de UMA leitura em lote, nao N+1",
      Array.isArray(q2?.ins["id"]) && (q2?.ins["id"] as unknown[]).length === 1);
    ok("T11 e essa leitura tambem e escopada ao dono",
      q2?.filtros["user_id"] === DONO);
    ok("T12 o lookup pede apenas id e nome",
      String(q2?.select ?? "").replace(/\s/g, "") === "id,nome");

    // ── T13..T16 — o que SAI ──────────────────────────────────────
    const item = r.linhas[0] as unknown as Record<string, unknown>;
    ok("T13 a fila devolve a aprovacao com o nome real do agente",
      r.erro === null && r.linhas.length === 1 && item?.agenteNome === "Teste Chat IA Real");
    ok("T14 a projecao tem exatamente os doze campos publicos",
      JSON.stringify(Object.keys(item ?? {}).sort()) ===
        JSON.stringify([
          "acesso", "agenteId", "agenteNome", "argumentos", "conexao", "criadoEm",
          "estado", "expiraEm", "funcaoId", "id", "revisaoFuncao", "tarefaId",
        ]),
      Object.keys(item ?? {}).join(", "));
    ok("T15 NENHUM campo interno atravessa, apesar de existir na linha lida",
      !/userId|user_id|argumentosHash|argumentos_hash|fingerprint|requestId|request_id|lojaId|loja_id|decidido/
        .test(JSON.stringify(item ?? {})));
    ok("T16 os argumentos saem como OBJETO, nao como texto serializado",
      typeof item?.argumentos === "object" && item?.argumentos !== null &&
      (item?.argumentos as Record<string, unknown>).dataInicio === "2026-09-12");

    // ── T17..T20 — contrato do schema respeitado ──────────────────
    roteiroDb({ data: [linhaAprovacao({ tarefa_id: null })] }, { data: [linhaAgente] });
    const semTarefa = await listarAprovacoesPendentesDoDono(DONO);
    ok("T17 tarefaId null e valor legitimo, nao defeito",
      semTarefa.erro === null && semTarefa.linhas.length === 1 &&
      semTarefa.linhas[0]?.tarefaId === null);

    roteiroDb(
      { data: [linhaAprovacao({ conexao_plataforma: "mercado_livre", conexao_recurso: "ads" })] },
      { data: [linhaAgente] }
    );
    const comConexao = await listarAprovacoesPendentesDoDono(DONO);
    ok("T18 requisito de conexao completo vira rotulo, sem loja e sem credencial",
      JSON.stringify(comConexao.linhas[0]?.conexao) ===
        JSON.stringify({ plataforma: "mercado_livre", recurso: "ads" }));

    roteiroDb({ data: [linhaAprovacao({ conexao_recurso: "ads" })] }, { data: [linhaAgente] });
    const meiaConexao = await listarAprovacoesPendentesDoDono(DONO);
    ok("T19 MEIA conexao e recusada fail-closed — alvo que nao existe",
      meiaConexao.erro === "erro_consulta_aprovacao" && meiaConexao.linhas.length === 0);

    roteiroDb({ data: [linhaAprovacao({ argumentos: ["nao", "e", "objeto"] })] }, { data: [linhaAgente] });
    const argsArray = await listarAprovacoesPendentesDoDono(DONO);
    ok("T20 argumentos que nao sao objeto reprovam a leitura inteira",
      argsArray.erro === "erro_consulta_aprovacao" && argsArray.linhas.length === 0);

    // ── T21..T24 — fail-closed ────────────────────────────────────
    roteiroDb({ data: [linhaAprovacao()] }, { data: [] });
    const semNome = await listarAprovacoesPendentesDoDono(DONO);
    ok("T21 agente ausente e ERRO, nunca `Agente desconhecido` inventado",
      semNome.erro === "erro_consulta_aprovacao" && semNome.linhas.length === 0);

    roteiroDb({ error: { message: "select ... from agente_funcao_aprovacoes where user_id = x" } });
    const falhaLeitura = await listarAprovacoesPendentesDoDono(DONO);
    ok("T22 falha do banco vira codigo interno, sem o texto bruto",
      falhaLeitura.erro === "erro_consulta_aprovacao" &&
      !/select|from|where/i.test(String(falhaLeitura.erro)));

    roteiroDb({ data: [linhaAprovacao()] }, { error: { message: "boom" } });
    const falhaNome = await listarAprovacoesPendentesDoDono(DONO);
    ok("T23 falha no lookup do nome tambem e fail-closed",
      falhaNome.erro === "erro_consulta_aprovacao" && falhaNome.linhas.length === 0);

    roteiroDb();
    const semDono = await listarAprovacoesPendentesDoDono("");
    ok("T24 sem dono nao ha leitura nenhuma — nem uma ida ao banco",
      semDono.linhas.length === 0 && semDono.erro === null && chamadasDb.length === 0);

    // ── T25 — fila vazia e resposta completa ──────────────────────
    roteiroDb({ data: [] });
    const vazia = await listarAprovacoesPendentesDoDono(DONO);
    ok("T25 fila vazia e resposta COMPLETA, e nao dispara o segundo lookup",
      vazia.erro === null && vazia.linhas.length === 0 && chamadasDb.length === 1);
  }

  // ── U. A fila NAO escreve, NAO decide e NAO retoma ───────────────
  //
  // Guard de fonte, e o mais importante deste gate. Enquanto o estagio
  // Resume nao existir, aprovar deixaria a Approval `aprovada` e a
  // tarefa parada em `aguardando_aprovacao` para sempre — o claim nao
  // alcanca esse status. Rejeitar encalha igual. Por isso a ausencia e
  // verificada, nao apenas pretendida.
  secao("U. A fila e read-only por construcao");
  {
    const PRODUCAO_A1 = [LEITURA, "app/api/aprovacoes/route.ts"];
    const fontesA1 = PRODUCAO_A1.map((f) => semComentariosTs(ler(f)));

    ok("U0  ANCORA: os dois paths de producao foram lidos",
      fontesA1.every((f) => f.length > 200));

    ok("U1  nenhum dos dois chama `.rpc(`",
      fontesA1.every((f) => !/\.rpc\(/.test(f)));
    ok("U2  nenhum dos dois escreve no banco",
      fontesA1.every((f) => !/\.(insert|update|upsert|delete)\(/.test(f)));
    ok("U3  nenhum nomeia as RPCs de aprovacao",
      fontesA1.every((f) =>
        !/aprovacao_criar|aprovacao_decidir|aprovacao_consumir_e_abrir|aguardar_aprovacao_tarefa/.test(f)));
    ok("U4  nenhum importa decisao, consumo ou retomada",
      fontesA1.every((f) =>
        !/decidirAprovacao|consumirAprovacaoEAbrir|retomarAprovacao|criarAprovacao/.test(f)));
    ok("U5  CONTROLE: a sonda de escrita reprovaria um insert",
      /\.(insert|update|upsert|delete)\(/.test('cliente.from("x").insert({})'));
    ok("U6  CONTROLE: a sonda de RPC reprovaria uma chamada",
      /\.rpc\(/.test('cliente.rpc("aprovacao_decidir")'));

    // A rota expoe UM metodo, e a ausencia dos outros e o contrato.
    const ROTA = semComentariosTs(ler("app/api/aprovacoes/route.ts"));
    const metodos = [...ROTA.matchAll(/export async function ([A-Z]+)\(/g)].map((m) => m[1]);
    ok(`U7  a rota exporta somente GET (${metodos.join(", ") || "nenhum"})`,
      JSON.stringify(metodos) === JSON.stringify(["GET"]));
    ok("U8  CONTROLE: um POST na rota reprovaria",
      JSON.stringify([...(ROTA + "\nexport async function POST(").matchAll(/export async function ([A-Z]+)\(/g)]
        .map((m) => m[1])) !== JSON.stringify(["GET"]));

    // ── Mutacoes: cada filtro e LOAD-BEARING ──────────────────────
    //
    // Um teste que so confere o nome da variavel passaria com o filtro
    // removido. Estas sondas leem a consulta montada e cada uma tem o
    // seu controle negativo.
    const LEIT_FONTE = semComentariosTs(ler(LEITURA));
    const temFiltroDono = (t: string) => /\.eq\("user_id", String\(userId\)\)/.test(t);
    const temFiltroEstado = (t: string) => /\.eq\("estado", "pendente"\)/.test(t);
    const temFiltroExpiracao = (t: string) => /\.gt\("expira_em", agora\)/.test(t);

    ok("U9  o filtro de dono existe na consulta da fila", temFiltroDono(LEIT_FONTE));
    // Global: o escopo de dono aparece DUAS vezes (fila e lookup de
    // nome). Remover so a primeira deixaria a segunda casando, e a
    // sonda ficaria verde sobre codigo mutilado — foi assim que este
    // controle apareceu vermelho pela primeira vez.
    ok("U9  CONTROLE: remover o filtro de dono reprova",
      !temFiltroDono(
        LEIT_FONTE.split('.eq("user_id", String(userId))').join("")));
    ok("U10 o filtro de estado pendente existe", temFiltroEstado(LEIT_FONTE));
    ok("U10 CONTROLE: remover o filtro de estado reprova",
      !temFiltroEstado(LEIT_FONTE.replace('.eq("estado", "pendente")', "")));
    ok("U11 o filtro de expiracao existe", temFiltroExpiracao(LEIT_FONTE));
    ok("U11 CONTROLE: remover o filtro de expiracao reprova",
      !temFiltroExpiracao(LEIT_FONTE.replace('.gt("expira_em", agora)', "")));

    // O lookup do nome tem o SEU proprio escopo de dono, e ele e outro
    // `.eq` — a mutacao precisa distinguir os dois.
    const escoposDeDono = [...LEIT_FONTE.matchAll(/\.eq\("user_id", String\(userId\)\)/g)].length;
    ok("U12 as DUAS leituras carregam o escopo do dono", escoposDeDono === 2, String(escoposDeDono));
    ok("U12 CONTROLE: uma das duas perder o escopo reprova",
      [...LEIT_FONTE.replace('.eq("user_id", String(userId))', "").matchAll(
        /\.eq\("user_id", String\(userId\)\)/g
      )].length !== 2);

    // A projecao nominal e o que impede coluna nova de vazar sozinha.
    const projecaoNominal = (t: string) =>
      /const COLUNAS_APROVACAO =/.test(t) && !/\.select\("\*"\)/.test(t);
    ok("U13 a projecao e nominal e nao ha `select(\"*\")`", projecaoNominal(LEIT_FONTE));
    ok("U13 CONTROLE: trocar por select(\"*\") reprova",
      !projecaoNominal(LEIT_FONTE.replace(".select(COLUNAS_APROVACAO)", '.select("*")')));

    ok("U14 o lookup de nome e escopado e em lote, nao por aprovacao",
      /\.in\("id", ids\)/.test(LEIT_FONTE) && !/for \([\s\S]{0,80}await cliente/.test(LEIT_FONTE));
    ok("U15 a fila e server-only", /^import "server-only";/m.test(ler(LEITURA)));
  }

  // ── V. APPROVAL-DECISION-RESUME-D1 ────────────────────────────────
  //
  // O ponteiro que faltava. Ate aqui uma tarefa parada nao dizia de QUE
  // aprovacao estava esperando, e a ligacao inversa — `tarefa_id` na
  // aprovacao — nao identifica: o unico indice unico sobre estado ativo
  // e `(user_id, fingerprint)`, e fingerprint descreve uma ACAO. Duas
  // aprovacoes ativas para a mesma tarefa sao possiveis.
  //
  // Esta secao prova a FASE ADITIVA: o schema ganha a correlacao, a RPC
  // de pausa ganha um overload que a grava, e NADA de producao muda.
  secao("V. D1 — o ponteiro Task -> Approval, fase aditiva");
  {
    const D1 = "supabase/migrations/20261002_tarefa_aprovacao_aguardada.sql";
    const bruto = ler(D1);
    const mig = semComentariosSql(bruto);

    ok("V0  ANCORA: a migration D1 existe e foi lida",
      bruto.length > 2000 && mig.includes("aprovacao_aguardada_id"));

    // ── A UNIQUE que torna a FK composta possivel ─────────────────
    ok("V1  adiciona UNIQUE (id, user_id) em agente_funcao_aprovacoes",
      /add constraint agente_funcao_aprovacoes_id_por_dono\s+unique\s*\(\s*id\s*,\s*user_id\s*\)/i.test(mig));
    ok("V1  CONTROLE NEGATIVO: sem a UNIQUE, a sonda reprova",
      !/add constraint agente_funcao_aprovacoes_id_por_dono/i.test(
        mig.replace(/add constraint agente_funcao_aprovacoes_id_por_dono[^;]*;/i, "")));
    ok("V2  a PK das aprovacoes nao e removida nem substituida",
      !/drop constraint[^;]*agente_funcao_aprovacoes_pk/i.test(mig) &&
      !/primary key/i.test(mig));

    // ── A coluna ──────────────────────────────────────────────────
    // ── CRIACAO FAIL-CLOSED ───────────────────────────────────────
    //
    // `if not exists` parece cuidado e e decisao as cegas: diante de uma
    // coluna com este nome que ja existisse — de outra pessoa, com outro
    // tipo e outro significado — ele ADOTA em silencio. Este arquivo nao
    // consulta o catalogo; a resposta honesta a uma colisao e abortar.
    //
    // O assert e ESPECIFICO de `add column`, e nao um veto geral a
    // `if not exists`: o proprio corpo da RPC usa `IF NOT EXISTS (...)`
    // como controle de fluxo plpgsql no diagnostico das duas recusas.
    ok("V3  o ponteiro e uuid, nullable, e entra por ADD COLUMN simples",
      /add column aprovacao_aguardada_id uuid null\s*;/i.test(mig) &&
      !/add\s+column\s+if\s+not\s+exists/i.test(mig));
    ok("V3  CONTROLE NEGATIVO: reintroduzir IF NOT EXISTS reprova",
      /add\s+column\s+if\s+not\s+exists/i.test(
        mig.replace("add column aprovacao_aguardada_id", "add column if not exists aprovacao_aguardada_id")));
    ok("V4  o ponteiro NAO tem DEFAULT",
      !/aprovacao_aguardada_id[^;]*\bdefault\b/i.test(mig));

    // ── A FK composta ─────────────────────────────────────────────
    //
    // Sem o par `(ponteiro, user_id)` a tarefa poderia apontar para a
    // aprovacao de OUTRO dono sem o banco reclamar.
    ok("V5  FK composta: (ponteiro, user_id) -> aprovacoes (id, user_id)",
      /foreign key\s*\(\s*aprovacao_aguardada_id\s*,\s*user_id\s*\)\s*references\s+public\.agente_funcao_aprovacoes\s*\(\s*id\s*,\s*user_id\s*\)/i.test(mig));
    ok("V6  a FK e ON UPDATE RESTRICT", /on update restrict/i.test(mig));
    ok("V7  a FK e ON DELETE RESTRICT", /on delete restrict/i.test(mig));
    ok("V8  zero CASCADE no SQL executavel", !/\bcascade\b/i.test(mig));
    ok("V8  CONTROLE NEGATIVO: trocar RESTRICT por CASCADE reprova",
      /\bcascade\b/i.test(mig.replace("on delete restrict", "on delete cascade")));

    // ── O CHECK meio-lado ─────────────────────────────────────────
    //
    // Proibe ponteiro fora da espera. NAO exige ponteiro dentro dela:
    // existem tarefas paradas anteriores a esta coluna, e o bicondicional
    // faria o apply falhar. Elas falham FECHADO depois, nunca erram de
    // alvo.
    ok("V9  existe o CHECK meio-lado do ponteiro",
      /add constraint agente_tarefas_ponteiro_so_na_espera\s+check\s*\(\s*status\s*=\s*'aguardando_aprovacao'\s+or\s+aprovacao_aguardada_id\s+is\s+null\s*\)/i.test(mig));
    ok("V10 o CHECK ainda NAO e bicondicional",
      !/\(\s*status\s*=\s*'aguardando_aprovacao'\s*\)\s*=\s*\(/i.test(mig) &&
      !/aprovacao_aguardada_id\s+is\s+not\s+null/i.test(mig));

    // ── Aditiva de verdade ────────────────────────────────────────
    ok("V11 zero DML e zero backfill",
      !/\binsert\s+into\b/i.test(mig) &&
      !/\bdelete\s+from\b/i.test(mig) &&
      !/\btruncate\b/i.test(mig) &&
      (mig.match(/\bupdate\s+public\./gi) ?? []).length === 1 &&
      /update public\.agente_tarefas t/i.test(mig));
    // ── ADITIVIDADE ESTRITA ───────────────────────────────────────
    //
    // Nao e "nenhum DROP de funcao": e nenhum DROP, ponto. A versao
    // anterior deste assert listava classes — function, table, column,
    // index — e deixava `drop constraint` passar, porque ele parecia
    // idioma de reexecucao. Nao e: `drop constraint if exists` + `add`
    // torna a migration rerunnable REMOVENDO o que encontrar, e num
    // arquivo que nunca consultou o catalogo isso apaga objeto que
    // ninguem inspecionou. A migration nao precisa ser rerunnable
    // destrutivamente — precisa abortar quando o nome ja existir.
    //
    // A palavra-chave inteira, sobre SQL ja sem comentarios: o
    // cabecalho fala de DROP varias vezes, e prosa nao pode reprovar
    // nem aprovar nada.
    ok("V12 ZERO DROP executavel, de qualquer especie",
      !/\bdrop\b/i.test(mig));
    ok("V12 CONTROLE NEGATIVO: um `drop constraint` reprova",
      /\bdrop\b/i.test(mig +
        "\nalter table public.agente_tarefas drop constraint if exists agente_tarefas_ponteiro_so_na_espera;"));
    ok("V12 CONTROLE NEGATIVO: um `drop function` tambem reprova",
      /\bdrop\b/i.test(mig + "\ndrop function if exists public.qualquer(uuid);"));
    // E o guard nao pode ser contornado por idempotencia dinamica: um
    // bloco que engula `duplicate_object` faria o mesmo estrago de forma
    // mais dificil de ler.
    ok("V13 nenhuma idempotencia por bloco dinamico",
      !/(?:^|\n)\s*do\s*\$/i.test(mig) &&
      !/\bexecute\s+(?:format|')/i.test(mig) &&
      !/duplicate_object/i.test(mig));
    // O inventario fechado das TRES formas de colidir em silencio. Elas
    // parecem diferentes e decidem a mesma coisa sem olhar: apagar,
    // adotar, sobrescrever.
    ok("V13b as tres formas de colisao silenciosa estao ausentes",
      !/\bdrop\b/i.test(mig) &&
      !/add\s+column\s+if\s+not\s+exists/i.test(mig) &&
      !/create\s+or\s+replace/i.test(mig));
    ok("V13 ANCORA: as tres constraints entram SO por add constraint",
      [...mig.matchAll(/add constraint\s+([a-z0-9_]+)/gi)].map((m) => m[1]).length === 3);
    ok("V14 nenhum indice de fila/claim nasce neste gate",
      !/create\s+(unique\s+)?index/i.test(mig));

    // ── O overload ────────────────────────────────────────────────
    ok("V15 cria o overload de TRES argumentos da pausa",
      /function public\.aguardar_aprovacao_tarefa\(\s*p_tarefa_id\s+uuid,\s*p_tentativa_esperada\s+integer,\s*p_aprovacao_id\s+uuid\s*\)/i.test(mig));
    // Mesma regra da coluna, do outro lado: `or replace` diante de uma
    // assinatura inesperada SOBRESCREVE corpo que ninguem leu. A de tres
    // argumentos nao existe hoje; se existir no apply, e precondicao
    // quebrada, nao detalhe a contornar.
    ok("V15b a overload nova entra por CREATE FUNCTION, sem OR REPLACE",
      /create\s+function\s+public\.aguardar_aprovacao_tarefa\(/i.test(mig) &&
      !/create\s+or\s+replace/i.test(mig));
    ok("V15b CONTROLE NEGATIVO: trocar por CREATE OR REPLACE reprova",
      /create\s+or\s+replace/i.test(
        mig.replace("create function public.aguardar_aprovacao_tarefa(",
                    "create or replace function public.aguardar_aprovacao_tarefa(")));
    ok("V16 nao dropa, nao altera e nao recria a assinatura de dois argumentos",
      !/drop\s+function/i.test(mig) &&
      !/alter\s+function/i.test(mig) &&
      !/function public\.aguardar_aprovacao_tarefa\(\s*p_tarefa_id\s+uuid,\s*p_tentativa_esperada\s+integer\s*\)/i.test(mig) &&
      !/aguardar_aprovacao_tarefa\(\s*uuid\s*,\s*integer\s*\)/i.test(mig));
    // NO DEFAULT nao e capricho: o PostgREST resolve overload pelo
    // CONJUNTO DE CHAVES do corpo. Com default, o payload de duas chaves
    // casaria as duas assinaturas e a resposta viraria 300.
    ok("V17 nenhum parametro do overload novo tem DEFAULT",
      !/p_aprovacao_id\s+uuid\s+default/i.test(mig) &&
      !/p_tentativa_esperada\s+integer\s+default/i.test(mig) &&
      !/p_tarefa_id\s+uuid\s+default/i.test(mig));
    ok("V18 o overload novo e SECURITY INVOKER com search_path fixo",
      /security invoker[\s\S]{0,60}set search_path = public/i.test(mig));
    ok("V19 ACL do overload novo: quatro REVOKE e um GRANT a service_role",
      (mig.match(/revoke all on function public\.aguardar_aprovacao_tarefa\(uuid, integer, uuid\)/gi) ?? []).length === 4 &&
      (mig.match(/grant execute on function public\.aguardar_aprovacao_tarefa\(uuid, integer, uuid\) to service_role/gi) ?? []).length === 1);
    ok("V20 nenhum REVOKE/GRANT nomeia a assinatura de dois argumentos",
      !/(revoke|grant)[^;]*aguardar_aprovacao_tarefa\(\s*uuid\s*,\s*integer\s*\)/i.test(mig));

    // ── O corpo: fence da tarefa ──────────────────────────────────
    const corpo = mig.slice(mig.indexOf("p_aprovacao_id"));
    ok("V21 ANCORA: o corpo do overload novo foi recortado", corpo.length > 800);
    ok("V22 o UPDATE cerca status e tentativa esperada",
      /t\.status\s*=\s*'rodando'/i.test(corpo) &&
      /t\.tentativas\s*=\s*p_tentativa_esperada/i.test(corpo));

    const setPausa = corpo.slice(corpo.indexOf("set status"), corpo.indexOf("where t.id"));
    ok("V23 ANCORA: a lista do SET foi recortada", setPausa.length > 120);
    // Espera humana nao e tentativa. O numero que identifica o dono da
    // execucao nao pode mudar porque alguem demorou a decidir.
    ok("V24 o SET nao toca tentativas nem progresso",
      !/tentativas/i.test(setPausa) && !/progresso/i.test(setPausa));
    ok("V25 o SET preserva a semantica atual da pausa",
      /heartbeat_em\s*=\s*null/i.test(setPausa) &&
      /resultado\s*=\s*null/i.test(setPausa) &&
      /erro_tipo\s*=\s*null/i.test(setPausa) &&
      /erro_mensagem\s*=\s*null/i.test(setPausa) &&
      /concluido_em\s*=\s*null/i.test(setPausa));
    ok("V26 o ponteiro nasce no MESMO SET que muda o status",
      /aprovacao_aguardada_id\s*=\s*p_aprovacao_id/i.test(setPausa));
    ok("V26 CONTROLE NEGATIVO: um segundo UPDATE do ponteiro reprova",
      ((mig + "\nupdate public.agente_tarefas set aprovacao_aguardada_id = p_aprovacao_id;")
        .match(/\bupdate\s+public\./gi) ?? []).length !== 1);

    // ── O corpo: revalidacao da aprovacao ─────────────────────────
    const validacao = corpo.slice(corpo.indexOf("exists ("), corpo.indexOf("returning t.*"));
    ok("V27 ANCORA: a subconsulta da aprovacao foi recortada", validacao.length > 200);
    ok("V28 a aprovacao e conferida por id", /a\.id\s*=\s*p_aprovacao_id/i.test(validacao));
    ok("V29 ... pelo mesmo dono", /a\.user_id\s*=\s*t\.user_id/i.test(validacao));
    ok("V30 ... pelo mesmo agente", /a\.agente_id\s*=\s*t\.agente_id/i.test(validacao));
    ok("V31 ... e por pertencer a ESTA tarefa", /a\.tarefa_id\s*=\s*t\.id/i.test(validacao));
    ok("V32 ... so em estado ativo", /a\.estado in \('pendente', 'aprovada'\)/i.test(validacao));
    ok("V33 ... e nao vencida", /a\.expira_em\s*>\s*now\(\)/i.test(validacao));
    ok("V34 CONTROLE NEGATIVO: perder o vinculo com a tarefa reprova",
      !/a\.tarefa_id\s*=\s*t\.id/i.test(validacao.replace(/and a\.tarefa_id\s*=\s*t\.id/i, "")));
    ok("V35 CONTROLE NEGATIVO: aceitar `rejeitada` reprova",
      !/a\.estado in \('pendente', 'aprovada'\)/i.test(
        validacao.replace("'pendente', 'aprovada'", "'pendente', 'aprovada', 'rejeitada'")));

    // ── A regra de lock ───────────────────────────────────────────
    //
    // Esta RPC comeca pela TAREFA. As primitivas de aprovacao ja
    // publicadas travam a APROVACAO primeiro. Se esta tambem travasse a
    // aprovacao, a ordem seria Tarefa -> Aprovacao e teriamos inversao
    // contra o que ja roda em producao. Por isso a leitura e MVCC pura.
    ok("V36 a revalidacao da aprovacao NAO trava a linha",
      !/for\s+update/i.test(corpo) &&
      !/for\s+share/i.test(corpo) &&
      !/for\s+no\s+key\s+update/i.test(corpo) &&
      !/for\s+key\s+share/i.test(corpo));
    ok("V36 CONTROLE NEGATIVO: um FOR UPDATE na subconsulta reprova",
      /for\s+update/i.test(corpo.replace("a.expira_em > now()", "a.expira_em > now() for update")));

    // ── Fail-closed, e distinguivel ───────────────────────────────
    ok("V37 as duas recusas sao 55000 e dizem coisas diferentes",
      (corpo.match(/errcode = '55000'/gi) ?? []).length === 2 &&
      /nao esta em rodando na tentativa/i.test(corpo) &&
      /nao pertence a tarefa/i.test(corpo));
    ok("V38 os tres parametros obrigatorios lancam 22023",
      (corpo.match(/errcode = '22023'/gi) ?? []).length === 3);

    // ── O caller de producao NAO muda neste gate ──────────────────
    //
    // Requisito, nao divida. Publicar o caller antes de a migration
    // estar aplicada faria producao chamar uma assinatura que o banco
    // ainda nao tem — a metade errada do cutover.
    // ── V39..V42 migrados na APPROVAL-DECISION-RESUME-D2 ──────────
    //
    // Estes asserts exigiam o CONTRARIO: que o caller continuasse na
    // overload de dois argumentos. Era requisito do D1, nao divida —
    // publicar o caller antes de a migration existir no banco faria
    // producao chamar uma assinatura inexistente.
    //
    // A migration foi aplicada e provada; agora o contrato e o oposto, e
    // os asserts foram INVERTIDOS, nao removidos.
    const CAP_D2 = semComentariosTs(ler("lib/agentes/capability-worker.ts"));
    const EXE_D2 = semComentariosTs(ler("lib/agentes/executar-tarefa.ts"));

    ok("V39 o wrapper de pausa envia as TRES chaves da overload nova",
      /rpc\("aguardar_aprovacao_tarefa"/.test(CAP_D2) &&
      /p_tarefa_id:\s*tarefaId/.test(CAP_D2) &&
      /p_tentativa_esperada:\s*tentativaEsperada/.test(CAP_D2) &&
      /p_aprovacao_id:\s*aprovacaoId/.test(CAP_D2));
    ok("V39 CONTROLE NEGATIVO: perder a chave nova reprova",
      !/p_aprovacao_id/.test(CAP_D2.split("p_aprovacao_id").join("")));

    // A identidade causal e o ponto do D1-R1: o id vem do sentinel que o
    // executor de Funcao lancou, e NAO de uma busca por `tarefa_id`.
    ok("V40 o executor passa err.aprovacaoId, direto do sentinel",
      /aguardarAprovacaoTarefa\([\s\S]{0,120}?err\.aprovacaoId/.test(EXE_D2));
    ok("V40 CONTROLE NEGATIVO: outra origem para o id reprova",
      !/aguardarAprovacaoTarefa\([\s\S]{0,120}?err\.aprovacaoId/.test(
        EXE_D2.replace("err.aprovacaoId", "tarefa.id")));
    ok("V41 o executor nao procura a aprovacao por tarefa_id nem por recencia",
      !/from\("agente_funcao_aprovacoes"\)/.test(EXE_D2) &&
      !/order\(\s*"criado_em"/.test(EXE_D2) &&
      !/randomUUID/.test(EXE_D2));

    // E o ponteiro NAO vira campo de contexto do handler: ele viaja do
    // catch ao wrapper e para ali.
    const CTX_D2 = semComentariosTs(ler("lib/agentes/tipos-execucao.ts"));
    const blocoCtx = CTX_D2.slice(
      CTX_D2.indexOf("export interface ContextoTarefa"),
      CTX_D2.indexOf("}", CTX_D2.indexOf("export interface ContextoTarefa")));
    ok("V42 ContextoTarefa continua com os mesmos 7 campos, sem aprovacao",
      (blocoCtx.match(/readonly\s+\w+\s*:/g) ?? []).length === 7 &&
      !/aprovacao/i.test(blocoCtx));
    ok("V42 CONTROLE NEGATIVO: um oitavo campo reprova",
      ((blocoCtx + "\n  readonly aprovacaoId: string;").match(/readonly\s+\w+\s*:/g) ?? []).length !== 7);
  }
}

// ─── W. D4 — a decisao encerra a tarefa ─────────────────────────────

secao("W. D4 — decisao + reject/cancel lifecycle");
{
  const d4 = SQL_D4;

  // ── W0..W3 — MESMA ASSINATURA, SEM NOVA OVERLOAD ──────────────
  //
  // O D3 custou cinco gates para remover uma overload legada. Repetir
  // o padrao sem necessidade criaria a mesma divida: a informacao que
  // faltava (QUAL tarefa) ja vive em `agente_funcao_aprovacoes.tarefa_id`.
  ok("W0  ANCORA: a migration D4 foi lida e tem corpo plpgsql",
    SQL_D4_BRUTO.length > 3000 && SQL_D4_BRUTO.includes("$$"));
  ok("W1  substitui a MESMA assinatura de quatro parametros",
    /create\s+or\s+replace\s+function\s+public\.aprovacao_decidir\(\s*p_user_id\s+text,\s*p_aprovacao_id\s+uuid,\s*p_decisao\s+text,\s*p_motivo\s+text\s*\)/i
      .test(d4));
  ok("W1b e devolve text, como antes", /\)\s*returns\s+text/i.test(d4));
  ok("W2  exatamente UM create/replace de funcao, zero overload",
    (d4.match(/create\s+(or\s+replace\s+)?function/gi) ?? []).length === 1 &&
    !/drop\s+function/i.test(d4) &&
    !/alter\s+function/i.test(d4));
  ok("W3  nenhum parametro ganhou DEFAULT",
    !/p_(user_id|aprovacao_id|decisao|motivo)\s+\w+\s+default/i.test(d4));
  ok("W3b CONTROLE NEGATIVO: um DEFAULT reprova",
    /p_motivo\s+text\s+default/i.test(d4.replace("p_motivo text", "p_motivo text default null")));

  // ── W4..W6 — SEGURANCA E ACL, RESTATADAS ──────────────────────
  //
  // O D4-R1 NAO conseguiu provar em sessao que `create or replace`
  // preserva ACL. Restatar custa cinco linhas e e fail-closed sob as
  // duas hipoteses — e o `pg_default_acl` deste projeto concede
  // EXECUTE a anon/authenticated em funcao nova (classe SEC1).
  ok("W4  SECURITY INVOKER explicito, nunca DEFINER",
    /security\s+invoker/i.test(d4) && !/security\s+definer/i.test(d4));
  ok("W5  search_path fixado em public",
    /set\s+search_path\s*=\s*public/i.test(d4));
  //
  // Contar quatro REVOKEs NAO basta: quatro linhas identicas `from anon`
  // tambem somam quatro, e nesse estado PUBLIC e authenticated ficariam
  // com EXECUTE — exatamente a classe SEC1 que ja custou um bug a este
  // projeto. Por isso os recipients sao extraidos e comparados como
  // CONJUNTO. Foi o achado D4-R2-M2.
  const recipientesRevoke = (fonte: string): string[] =>
    [...fonte.matchAll(
      /revoke all on function public\.aprovacao_decidir\(text, uuid, text, text\) from (\w+);/gi)]
      .map((m) => m[1].toLowerCase());
  const recipientesGrant = (fonte: string): string[] =>
    [...fonte.matchAll(
      /grant (\w+) on function public\.aprovacao_decidir\(text, uuid, text, text\) to (\w+);/gi)]
      .map((m) => `${m[1].toLowerCase()}:${m[2].toLowerCase()}`);

  const revD4 = recipientesRevoke(d4);
  const grantD4 = recipientesGrant(d4);
  const ESPERADO_REVOKE = ["anon", "authenticated", "public", "service_role"];

  ok("W6  quatro REVOKE, e os quatro recipients sao DISTINTOS e exatos",
    revD4.length === 4 &&
    new Set(revD4).size === 4 &&
    [...revD4].sort().join(",") === ESPERADO_REVOKE.join(","));
  ok("W6b um unico GRANT, execute, exclusivo do service_role",
    grantD4.length === 1 && grantD4[0] === "execute:service_role");
  ok("W6c nenhum GRANT para public, anon ou authenticated",
    !grantD4.some((g) => /:(public|anon|authenticated)$/.test(g)));

  // ── CONTROLES NEGATIVOS DE ACL — a matriz inteira ─────────────
  const semRevoke = (quem: string) =>
    d4.replace(
      `revoke all on function public.aprovacao_decidir(text, uuid, text, text) from ${quem};`, "");
  const aclOk = (fonte: string) => {
    const r = recipientesRevoke(fonte);
    const g = recipientesGrant(fonte);
    return r.length === 4 && new Set(r).size === 4 &&
      [...r].sort().join(",") === ESPERADO_REVOKE.join(",") &&
      g.length === 1 && g[0] === "execute:service_role";
  };

  ok("W6d ANCORA: a ACL da fonte real passa no predicado completo", aclOk(d4));
  ok("W6e CONTROLE NEGATIVO A: sem REVOKE public reprova", !aclOk(semRevoke("public")));
  ok("W6f CONTROLE NEGATIVO B: sem REVOKE anon reprova", !aclOk(semRevoke("anon")));
  ok("W6g CONTROLE NEGATIVO C: sem REVOKE authenticated reprova", !aclOk(semRevoke("authenticated")));
  ok("W6h CONTROLE NEGATIVO D: sem REVOKE service_role reprova", !aclOk(semRevoke("service_role")));
  ok("W6i CONTROLE NEGATIVO E: quatro REVOKEs para o MESMO recipient reprova",
    !aclOk(d4.replace(
      /revoke all on function public\.aprovacao_decidir\(text, uuid, text, text\) from \w+;/gi,
      "revoke all on function public.aprovacao_decidir(text, uuid, text, text) from anon;")));
  ok("W6j CONTROLE NEGATIVO F: sem GRANT service_role reprova",
    !aclOk(d4.replace(
      "grant execute on function public.aprovacao_decidir(text, uuid, text, text) to service_role;", "")));
  ok("W6k CONTROLE NEGATIVO G: um GRANT a anon reprova",
    !aclOk(`${d4}\ngrant execute on function public.aprovacao_decidir(text, uuid, text, text) to anon;`));
  ok("W6l CONTROLE NEGATIVO H: um GRANT a authenticated reprova",
    !aclOk(`${d4}\ngrant execute on function public.aprovacao_decidir(text, uuid, text, text) to authenticated;`));

  // ── W7..W9 — ORDEM DE LOCK: APPROVAL ANTES DA TASK ────────────
  //
  // Nao basta os dois `for update` existirem: o que importa e a ORDEM.
  // Invertida, fecharia ciclo com `aprovacao_consumir_e_abrir`, que
  // trava a aprovacao primeiro.
  const iLockAprov = d4.search(/from public\.agente_funcao_aprovacoes a[\s\S]{0,200}?for update/i);
  const iLockTaref = d4.search(/from public\.agente_tarefas t[\s\S]{0,400}?for update/i);

  ok("W7  ANCORA: os dois locks explicitos existem",
    iLockAprov > 0 && iLockTaref > 0);
  ok("W8  a APROVACAO e travada ANTES da tarefa",
    iLockAprov < iLockTaref);
  ok("W8b CONTROLE NEGATIVO: com a ordem invertida o assert cai",
    !(d4.slice(iLockTaref).search(/from public\.agente_funcao_aprovacoes a[\s\S]{0,200}?for update/i) >= 0
      && iLockTaref < iLockAprov));
  ok("W9  a aprovacao e travada por id E por dono",
    /where a\.id = p_aprovacao_id\s*and a\.user_id = p_user_id\s*for update/i
      .test(d4.replace(/\s+/g, " ").replace(/ and /g, "\n    and ").replace(/\s+/g, " ")) ||
    /a\.id\s*=\s*p_aprovacao_id[\s\S]{0,80}a\.user_id\s*=\s*p_user_id[\s\S]{0,40}for update/i.test(d4));

  // ── W10..W13 — ORDEM DAS CHECAGENS ────────────────────────────
  //
  // `tarefa_incompativel` NUNCA pode mascarar um `ja_aprovada` ou um
  // `expirada`: quem clica duas vezes precisa do motivo real.
  const iJa = d4.indexOf("'ja_consumida'");
  const iTarefa = d4.indexOf("agente_tarefas t");
  const iMismatch = d4.indexOf("'tarefa_incompativel'");

  ok("W10 ANCORA: os tres marcos de ordem existem",
    iJa > 0 && iTarefa > 0 && iMismatch > 0);
  ok("W11 os estados ja_*/expirada sao resolvidos ANTES de olhar a tarefa",
    iJa < iTarefa && iJa < iMismatch);
  ok("W12 a expiracao e materializada antes de tudo e devolve 'expirada'",
    /set estado = 'expirada'/i.test(d4) &&
    d4.indexOf("set estado = 'expirada'") < iTarefa);
  ok("W13 a tarefa so e consultada quando ha vinculo causal",
    /if v_aprovacao\.tarefa_id is not null then/i.test(d4));

  // ── W14..W15 — OS CINCO FENCES CAUSAIS ────────────────────────
  const janelaTarefa = iTarefa > 0 ? d4.slice(iTarefa, iTarefa + 700) : "";
  ok("W14 ANCORA: o bloco da tarefa foi recortado", janelaTarefa.length > 300);
  ok("W15 os CINCO fences causais estao presentes",
    /t\.id\s*=\s*v_aprovacao\.tarefa_id/i.test(janelaTarefa) &&
    /t\.user_id\s*=\s*v_aprovacao\.user_id/i.test(janelaTarefa) &&
    /t\.agente_id\s*=\s*v_aprovacao\.agente_id/i.test(janelaTarefa) &&
    /t\.status\s*=\s*'aguardando_aprovacao'/i.test(janelaTarefa) &&
    /t\.aprovacao_aguardada_id\s*=\s*v_aprovacao\.id/i.test(janelaTarefa));
  ok("W15b e nao fenceia por tentativas — espera humana nao e retry",
    !/t\.tentativas/i.test(janelaTarefa));

  // ── W16..W17 — MISMATCH ANTES DE QUALQUER ESCRITA ─────────────
  //
  // O desenho proibido: UPDATE na aprovacao, depois descobrir que a
  // tarefa nao casa, e devolver um codigo. Isso persistiria metade da
  // transicao — o defeito que o D4 existe para eliminar.
  //
  // Corrigido no D4-F2 (achado D4-R2-M1). A versao anterior comparava um
  // indice da string ORIGINAL com um indice da string MUTADA — dois
  // espacos de endereco diferentes. Passava por coincidencia posicional
  // e nao provava ordenacao nenhuma.
  //
  // Agora e uma PROPRIEDADE de uma unica fonte. E ela precisa distinguir
  // o UPDATE de expiracao, que e legitimo e roda ANTES da fase da tarefa,
  // das escritas de DECISAO, que tem de vir depois do mismatch. Por isso
  // o alvo e `estado = 'aprovada'|'rejeitada'|'cancelada'`, nunca
  // `'expirada'`.
  const ESCRITAS_DE_DECISAO =
    /set\s+estado\s*=\s*'(aprovada|rejeitada|cancelada)'/gi;

  const mismatchAntesDosWritesDecisao = (fonte: string): boolean => {
    const iMis = fonte.indexOf("'tarefa_incompativel'");
    const primeira = [...fonte.matchAll(ESCRITAS_DE_DECISAO)]
      .map((m) => m.index ?? -1)
      .filter((i) => i >= 0)
      .sort((a, b) => a - b)[0];
    if (iMis < 0 || primeira === undefined) return false;
    return iMis < primeira;
  };

  ok("W16 ANCORA: a fonte real tem mismatch E escrita de decisao",
    d4.includes("'tarefa_incompativel'") &&
    [...d4.matchAll(ESCRITAS_DE_DECISAO)].length === 3);
  ok("W17 tarefa_incompativel e decidido ANTES de qualquer escrita de decisao",
    mismatchAntesDosWritesDecisao(d4));

  // A mutacao injeta uma escrita de decisao REAL antes do mismatch, e o
  // helper roda sobre essa MESMA string mutada — nunca cruzando indices.
  const d4ComWriteAntes = d4.replace(
    "return 'tarefa_incompativel';",
    "update public.agente_funcao_aprovacoes set estado = 'rejeitada' where id = p_aprovacao_id;\n      return 'tarefa_incompativel';");

  ok("W17b ANCORA: a mutacao realmente injetou a escrita",
    d4ComWriteAntes !== d4 &&
    [...d4ComWriteAntes.matchAll(ESCRITAS_DE_DECISAO)].length === 4);
  ok("W17c CONTROLE NEGATIVO: com escrita de decisao antes do mismatch, a propriedade CAI",
    !mismatchAntesDosWritesDecisao(d4ComWriteAntes));
  ok("W17d CONTROLE: o UPDATE de expiracao NAO conta como escrita de decisao",
    /set estado = 'expirada'/i.test(d4) &&
    !ESCRITAS_DE_DECISAO.test("set estado = 'expirada'"));

  // ── W18..W20 — APPROVE NAO TOCA A TAREFA ──────────────────────
  //
  // Branch-aware: a funcao inteira TEM update de tarefa (reject e
  // cancel precisam). O que se prova aqui e que o ramo do aprovar
  // retorna antes de chegar nele.
  const iAprovar = d4.search(/if p_decisao = 'aprovar' then/i);
  const iRetornoAprovada = d4.indexOf("return 'aprovada';");
  const iUpdateTarefa = d4.search(/update public\.agente_tarefas/i);

  ok("W18 ANCORA: o ramo do aprovar e o update da tarefa existem",
    iAprovar > 0 && iRetornoAprovada > 0 && iUpdateTarefa > 0);
  ok("W19 o ramo do aprovar RETORNA antes do update da tarefa",
    iAprovar < iRetornoAprovada && iRetornoAprovada < iUpdateTarefa);
  //
  // Endurecido no D4-F2 (achado D4-R2-L2). Antes o assert observava que o
  // UPDATE real fica textualmente depois do return — verdadeiro, mas nao
  // provaria nada contra uma REGRESSAO FUTURA que pusesse um UPDATE
  // dentro do ramo. Agora e um helper sobre o ramo delimitado, com
  // mutacao que injeta exatamente essa regressao.
  const ramoAprovar = (fonte: string): string => {
    const i = fonte.search(/if p_decisao = 'aprovar' then/i);
    if (i < 0) return "";
    const f = fonte.indexOf("return 'aprovada';", i);
    return f < 0 ? "" : fonte.slice(i, f);
  };
  const aprovarNaoTocaTarefa = (fonte: string): boolean => {
    const ramo = ramoAprovar(fonte);
    return ramo.length > 100 && !/update\s+public\.agente_tarefas/i.test(ramo);
  };

  ok("W20 ANCORA: o ramo do aprovar foi delimitado", ramoAprovar(d4).length > 100);
  ok("W20b no ramo do aprovar nao existe UPDATE de tarefa", aprovarNaoTocaTarefa(d4));

  const d4ComTarefaNoAprovar = d4.replace(
    "if p_decisao = 'aprovar' then",
    "if p_decisao = 'aprovar' then\n    update public.agente_tarefas set status = 'cancelado' where id = v_tarefa_id;");

  ok("W20c ANCORA: a mutacao injetou o UPDATE dentro do ramo",
    d4ComTarefaNoAprovar !== d4 &&
    /update\s+public\.agente_tarefas/i.test(ramoAprovar(d4ComTarefaNoAprovar)));
  ok("W20d CONTROLE NEGATIVO: UPDATE de tarefa dentro do ramo approve REPROVA",
    !aprovarNaoTocaTarefa(d4ComTarefaNoAprovar));

  // ── W21..W24 — O UPDATE TERMINAL DA TAREFA ────────────────────
  const iSetTerminal = d4.search(/update public\.agente_tarefas\s+set/i);
  const updTarefa = iSetTerminal > 0 ? d4.slice(iSetTerminal, d4.indexOf("where id = v_tarefa_id") + 40) : "";

  ok("W21 ANCORA: o UPDATE terminal da tarefa foi recortado",
    updTarefa.length > 200 && /where id = v_tarefa_id/.test(updTarefa));
  ok("W22 status e ponteiro mudam no MESMO UPDATE (exigencia do CHECK)",
    /status\s*=\s*'cancelado'/i.test(updTarefa) &&
    /aprovacao_aguardada_id\s*=\s*null/i.test(updTarefa));
  ok("W23 invariantes terminais explicitos",
    /heartbeat_em\s*=\s*null/i.test(updTarefa) &&
    /concluido_em\s*=\s*now\(\)/i.test(updTarefa) &&
    /resultado\s*=\s*null/i.test(updTarefa) &&
    /erro_tipo\s*=\s*null/i.test(updTarefa) &&
    /erro_mensagem\s*=\s*null/i.test(updTarefa));
  ok("W24 progresso e tentativas sao PRESERVADOS",
    !/progresso\s*=/i.test(updTarefa) && !/tentativas\s*=/i.test(updTarefa));
  ok("W24b CONTROLE NEGATIVO: sobrescrever progresso reprova",
    /progresso\s*=/i.test(updTarefa + "\n progresso = 100,"));

  // ── W25..W26 — ZERO TOOL CALL, ZERO FUNCAO ────────────────────
  ok("W25 nao cria Tool Call nem consome a aprovacao",
    !/agente_funcao_chamadas/i.test(d4) &&
    !/aprovacao_consumir_e_abrir/i.test(d4));
  ok("W26 cancelar NAO toca decidido_por/em",
    !/set\s+estado\s*=\s*'cancelada'[\s\S]{0,200}decidido_por\s*=/i.test(d4) &&
    /cancelado_por\s*=\s*p_user_id/i.test(d4));

  // ── W27..W28 — ROWCOUNT INESPERADO ABORTA ─────────────────────
  //
  // Ja sob os dois locks, um UPDATE que afete quantidade diferente de
  // 1 e bug nosso, nao situacao de negocio: levanta e derruba a
  // transacao inteira, em vez de devolver codigo apos escrita parcial.
  //
  // Endurecido no D4-F2 (achado D4-R2-L1). Antes exigia `>= 4` com a
  // realidade em 5: remover UM invariante continuaria verde. Agora o
  // numero nao e solto — ele e amarrado ao INVENTARIO de escritas, e as
  // tres contagens tem de coincidir.
  const escritasDe = (fonte: string) =>
    (fonte.match(/update\s+public\.(agente_funcao_aprovacoes|agente_tarefas)/gi) ?? []).length;
  const diagnosticsDe = (fonte: string) =>
    (fonte.match(/get diagnostics v_afetadas = row_count/gi) ?? []).length;
  const raisesDe = (fonte: string) =>
    (fonte.match(/raise exception[\s\S]{0,240}?errcode = '55000'/gi) ?? []).length;

  const ESCRITAS_ESPERADAS = 5; // expiry + aprovar + rejeitar + cancelar + tarefa terminal

  ok("W27 ANCORA: a funcao tem exatamente as cinco escritas do inventario",
    escritasDe(d4) === ESCRITAS_ESPERADAS);
  ok("W27b toda escrita confere row_count — uma por escrita, sem sobra",
    diagnosticsDe(d4) === ESCRITAS_ESPERADAS);
  ok("W28 e toda escrita LEVANTA 55000 se o row_count surpreender",
    raisesDe(d4) === ESCRITAS_ESPERADAS);
  ok("W28b CONTROLE NEGATIVO: remover UM get diagnostics reprova",
    diagnosticsDe(d4.replace("get diagnostics v_afetadas = row_count;", "")) !== ESCRITAS_ESPERADAS);
  ok("W28c CONTROLE NEGATIVO: remover UM raise 55000 reprova",
    raisesDe(d4.replace(/raise exception[\s\S]{0,240}?errcode = '55000';/i, "")) !== ESCRITAS_ESPERADAS);

  // ── W29..W31 — VOCABULARIO DE RETORNO ─────────────────────────
  ok("W29 todos os codigos historicos preservados",
    ["entrada_invalida", "decisao_invalida", "aprovacao_inexistente",
     "ja_aprovada", "ja_rejeitada", "ja_cancelada", "ja_consumida",
     "expirada", "aprovada", "rejeitada", "cancelada"]
      .every((c) => d4.includes(`'${c}'`)));
  ok("W30 e o unico codigo NOVO e tarefa_incompativel",
    d4.includes("'tarefa_incompativel'"));
  ok("W31 o vocabulario de decisao nao cresceu",
    /p_decisao not in \('aprovar', 'rejeitar', 'cancelar'\)/i.test(d4));

  // ── W32..W33 — tarefa_id NULL segue Approval-only ─────────────
  ok("W32 aprovacao sem tarefa nao procura nem trava tarefa",
    /if v_aprovacao\.tarefa_id is not null then[\s\S]{0,900}?end if;/i.test(d4));
  ok("W33 o update terminal so roda quando houve tarefa casada",
    /if v_tarefa_id is not null then[\s\S]{0,120}update public\.agente_tarefas/i.test(d4));

  // ── W34..W36 — O WRAPPER ──────────────────────────────────────
  const wrapper = ler("lib/agentes/aprovacoes/persistencia.ts");
  ok("W34 o wrapper reconhece tarefa_incompativel",
    /\|\s*"tarefa_incompativel"/.test(wrapper));
  ok("W35 e nao ganhou politica nova nem consulta a tarefa",
    !/agente_tarefas/.test(wrapper) &&
    (wrapper.match(/rpc\(RPC_DECIDIR/g) ?? []).length === 1);
  ok("W36 falha inesperada continua virando falha_persistencia",
    /falha_persistencia/.test(wrapper));

  // ── W37..W38 — FRONTEIRAS: ZERO API, ZERO UI ──────────────────
  const rotaAprov = ler("app/api/aprovacoes/route.ts");
  const cardAprov = ler("components/ia/aprovacoes/CardAprovacao.tsx");

  ok("W37 a rota de aprovacoes continua GET-only",
    /export async function GET\(/.test(rotaAprov) &&
    !/export async function (POST|PATCH|PUT|DELETE)\(/.test(rotaAprov));
  // Comentarios saem ANTES da sonda: este arquivo DOCUMENTA que nao tem
  // `onClick` ("Sem `onClick`, sem estado local, sem toast"), e uma busca
  // ingenua casaria com a propria explicacao, reprovando pelo motivo errado.
  const cardCodigo = semComentariosTs(cardAprov);
  // W38 avancou no A3: os botoes decidem. O que ele protege agora e a
  // FORMA da ligacao — condicional, nunca fixa; handler no card, rede fora
  // dele; e a elegibilidade do mock longe da fila real.
  ok("W38 os botoes decidem, com disable condicional e sem rede no card",
    /onClick=\{\(\) => onAprovar\(aprovacao\)\}/.test(cardCodigo) &&
    /onClick=\{\(\) => onRecusar\(aprovacao\)\}/.test(cardCodigo) &&
    (cardCodigo.match(/disabled=\{enviando\}/g) ?? []).length === 2 &&
    !/disabled\s*(\/?>|\s[a-zA-Z-])/.test(cardCodigo) &&
    !/fetch\(/.test(cardCodigo) && !/registrarDecisaoAprovacao/.test(cardCodigo));
  ok("W38a e o in-flight e anunciado nos dois controles",
    (cardCodigo.match(/aria-busy=\{enviando\}/g) ?? []).length === 2);
  ok("W38b CONTROLE: a sonda de `disabled` fixo acha o atributo fixo",
    /disabled\s*(\/?>|\s[a-zA-Z-])/.test('<button type="button" disabled>Aprovar</button>'));
  ok("W38c a elegibilidade do MOCK nao governa a fila real",
    !/elegibilidade\(/.test(cardCodigo) && !/conexaoValida\(/.test(cardCodigo) &&
    !/as (unknown as )?ConexaoDaAprovacao/.test(cardCodigo));

  // ── W39 — O D4 NAO FAZ O TRABALHO DO D5 NEM DO D7 ─────────────
  ok("W39 nem resume, nem scanner, nem execucao de Funcao",
    !/claim[_ ]?next/i.test(d4) && !/executar/i.test(d4) &&
    !/scanner|varredura/i.test(d4));
}

void principalStale().then(() => {
  console.log(`\n══ ${passou} PASS / ${falhou} FAIL ══\n`);
  process.exit(falhou === 0 ? 0 : 1);
});
