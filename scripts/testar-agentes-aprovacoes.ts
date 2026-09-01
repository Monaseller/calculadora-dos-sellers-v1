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
const PERS_BRUTO = ler(PERSISTENCIA);
const PERS = semComentariosTs(PERS_BRUTO);

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
const CORPO_CONSUMIR = corpoFuncao("aprovacao_consumir_e_abrir");

// ─── A. A pasta nova ──────────────────────────────────────────────────

secao("A. A pasta de aprovacoes tem exatamente os modulos autorizados");
{
  const AUTORIZADOS = ["identidade.ts", "persistencia.ts"];
  const conteudo = readdirSync(join(RAIZ, "lib", "agentes", "aprovacoes")).sort();

  ok(`A1  lib/agentes/aprovacoes contem exatamente os modulos declarados (${conteudo.join(", ")})`,
    conjuntosIguais(conteudo, AUTORIZADOS));
  ok("A2  CONTROLE: um modulo extra reprovaria",
    !conjuntosIguais([...AUTORIZADOS, "rotas.ts"], AUTORIZADOS));
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

  const tocamTabela = fontes.filter((f) => /agente_funcao_aprovacoes/.test(semComentariosTs(ler(f))));
  ok(`M1  so persistencia.ts nomeia a tabela em lib/ e app/ (${tocamTabela.join(", ") || "nenhum"})`,
    conjuntosIguais(tocamTabela, [PERSISTENCIA]));

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
  ok("N3  e a selecao apenas para o alvo concreto",
    /import \{ resolverSelecoesDoAgente \}/.test(PERS) &&
      /selecao\.lojaId/.test(PERS));
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
  const CONSUMIDORES_AUTORIZADOS = [EXECUTOR_FUNCOES];

  const consumidores = outros.filter((f) =>
    /criarAprovacao|decidirAprovacao|consumirAprovacaoEAbrir/.test(semComentariosTs(ler(f))));
  ok(`O1  os consumidores de producao sao exatamente os declarados (${consumidores.join(", ") || "nenhum"})`,
    conjuntosIguais(consumidores, CONSUMIDORES_AUTORIZADOS));
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
  ok("P6  o alvo de conexao do contexto vem do CATALOGO ja conferido",
    /plataforma: platEsperada/.test(CONSUMO) && /recurso: recEsperado/.test(CONSUMO));

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

console.log(`\n══ ${passou} PASS / ${falhou} FAIL ══\n`);
process.exit(falhou === 0 ? 0 : 1);
