/**
 * `agente_perguntas_ml` — a inbox de perguntas, prova ESTRUTURAL.
 *
 * ── O que esta suite prova, e o que ela NAO prova ───────────────────
 *
 * Ela le o SQL da migration e prova que cada invariante congelado esta
 * LA. Isso e o maximo que se pode provar sem banco — e e honesto dizer
 * o limite: SQL nao roda em TypeScript, entao nada aqui prova
 * COMPORTAMENTO.
 *
 * Os casos de comportamento (upsert, conflito, tenant mismatch,
 * rollback, concorrencia, grants efetivos) vivem em
 * `scripts/testar-agentes-perguntas-inbox-banco.ts`, que exige a
 * migration aplicada e NAO roda neste gate.
 *
 * Confundir as duas seria o erro que o repositorio ja registra: "o que
 * NAO foi testado e declarado explicitamente".
 *
 * Rodar:  npx tsx scripts/testar-agentes-perguntas-inbox.ts
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let passou = 0;
let falhou = 0;

function ok(nome: string, condicao: boolean, detalhe = ""): void {
  if (condicao) {
    passou++;
    console.log(`  PASS  ${nome}`);
  } else {
    falhou++;
    console.log(`  FAIL  ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
  }
}

function secao(titulo: string): void {
  console.log(`\n── ${titulo} ${"─".repeat(Math.max(0, 62 - titulo.length))}`);
}

const RAIZ = join(__dirname, "..");
const ler = (rel: string) => readFileSync(join(RAIZ, rel), "utf8");

const ARQUIVO = "supabase/migrations/20261009_agente_perguntas_ml.sql";
const SQL = ler(ARQUIVO);
/** Sem comentarios: um invariante nao pode ser "provado" pela prosa. */
const CODIGO = SQL.replace(/^\s*--.*$/gm, "");

console.log("\n══ CDS IA — agente_perguntas_ml: invariantes estruturais ══");

// ─── A. A tabela ──────────────────────────────────────────────────────

secao("A. Tabela e colunas");
ok("A1  cria `agente_perguntas_ml`",
  /create\s+table\s+if\s+not\s+exists\s+public\.agente_perguntas_ml/i.test(CODIGO));

for (const [coluna, tipo] of [
  ["id", "uuid"], ["user_id", "text"], ["loja_id", "uuid"],
  ["id_externo", "text"], ["anuncio_id_externo", "text"], ["texto", "text"],
  ["provider_status", "text"], ["criada_em_provider", "timestamptz"],
  ["estado_interno", "text"], ["primeiro_visto_em", "timestamptz"],
  ["ultimo_visto_em", "timestamptz"], ["criado_em", "timestamptz"],
  ["alterado_em", "timestamptz"],
] as const) {
  ok(`A2  coluna \`${coluna}\` ${tipo}`,
    new RegExp(`\\n\\s+${coluna}\\s+${tipo}\\b`, "i").test(CODIGO));
}

ok("A3  `user_id` e text, como no resto do schema (lojas/agentes/conexoes)",
  /\n\s+user_id\s+text\s+not\s+null/i.test(CODIGO));
ok("A4  nenhuma coluna de payload bruto do provider",
  !/\braw\b|payload_bruto|provider_payload|resposta_bruta/i.test(CODIGO));
ok("A5  o `from` do comprador NAO e persistido",
  !/comprador|from_id|buyer/i.test(CODIGO));
ok("A6  `operationId` do bucket NAO entra na tabela",
  !/operation_id|operationid/i.test(CODIGO));

// ─── B. Chave natural e dedupe ────────────────────────────────────────

secao("B. Chave natural e dedupe");
ok("B1  PK em `id`", /id\s+uuid\s+primary\s+key\s+default\s+gen_random_uuid\(\)/i.test(CODIGO));
ok("B2  UNIQUE (loja_id, id_externo) — o dedupe",
  /constraint\s+agente_perguntas_ml_pergunta_unica\s+unique\s*\(\s*loja_id\s*,\s*id_externo\s*\)/i.test(CODIGO));
ok("B3  a chave natural NAO inclui user_id (evitaria duas linhas por dono)",
  !/unique\s*\(\s*user_id\s*,\s*loja_id\s*,\s*id_externo\s*\)/i.test(CODIGO));

// ─── C. Tenancy ───────────────────────────────────────────────────────

secao("C. Cerca de dono");
ok("C1  FK composta (loja_id, user_id) -> lojas(id, user_id)",
  /foreign\s+key\s*\(\s*loja_id\s*,\s*user_id\s*\)\s*references\s+public\.lojas\s*\(\s*id\s*,\s*user_id\s*\)/i.test(CODIGO));
ok("C2  on delete restrict — apagar loja com inbox exige decisao",
  /on\s+update\s+restrict\s+on\s+delete\s+restrict/i.test(CODIGO));
ok("C3  NAO usa cascade (apagaria trabalho)",
  !/on\s+delete\s+cascade/i.test(CODIGO));

// ─── D. CHECKs ────────────────────────────────────────────────────────

secao("D. CHECKs");
ok("D1  estado_interno com vocabulario FECHADO",
  /check\s*\(\s*estado_interno\s+in\s*\(\s*'nova'\s*,\s*'em_processamento'\s*,\s*'aguardando_aprovacao'\s*,\s*'ignorada'\s*,\s*'erro'\s*\)\s*\)/i.test(CODIGO));
ok("D2  default de estado_interno e 'nova'",
  /estado_interno\s+text\s+not\s+null\s+default\s+'nova'/i.test(CODIGO));
ok("D3  `respondida` NAO existe ainda (DEFERRED — depende da Funcao de escrita)",
  !/'respondida'/i.test(CODIGO));
ok("D4  provider_status SEM check de vocabulario (o conjunto e do provider)",
  !/check\s*\(\s*provider_status\s+in\s*\(/i.test(CODIGO));
for (const campo of ["id_externo", "anuncio_id_externo", "texto", "provider_status"]) {
  ok(`D5  \`${campo}\` nao vazio`,
    new RegExp(`check\\s*\\(\\s*length\\(btrim\\(${campo}\\)\\)\\s*>\\s*0\\s*\\)`, "i").test(CODIGO));
}
ok("D6  ultimo_visto_em >= primeiro_visto_em",
  /check\s*\(\s*ultimo_visto_em\s*>=\s*primeiro_visto_em\s*\)/i.test(CODIGO));

// ─── E. Indexes ───────────────────────────────────────────────────────

secao("E. Indices");
ok("E1  fila de trabalho (user_id, loja_id, estado_interno)",
  /create\s+index\s+if\s+not\s+exists\s+idx_agente_perguntas_ml_fila[\s\S]{0,120}\(\s*user_id\s*,\s*loja_id\s*,\s*estado_interno\s*\)/i.test(CODIGO));
ok("E2  frescor (loja_id, ultimo_visto_em desc)",
  /create\s+index\s+if\s+not\s+exists\s+idx_agente_perguntas_ml_frescor[\s\S]{0,120}\(\s*loja_id\s*,\s*ultimo_visto_em\s+desc\s*\)/i.test(CODIGO));

// ─── F. Privilegios da tabela ─────────────────────────────────────────

secao("F. Privilegios da TABELA");
for (const papel of ["public", "anon", "authenticated", "service_role"]) {
  ok(`F1  revoke all da tabela para \`${papel}\``,
    new RegExp(`revoke\\s+all\\s+on\\s+table\\s+public\\.agente_perguntas_ml\\s+from\\s+${papel}\\s*;`, "i").test(CODIGO));
}
ok("F2  grant SELECT/INSERT/UPDATE a service_role",
  /grant\s+select,\s*insert,\s*update\s+on\s+table\s+public\.agente_perguntas_ml\s+to\s+service_role\s*;/i.test(CODIGO));
// V1 nao apaga pergunta: sair da fila e transicao de estado, nunca
// remocao de linha. DELETE concedido seria poder sem pedinte.
ok("F2b SEM grant de DELETE na tabela",
  !/grant[^;]*\bdelete\b[^;]*on\s+table\s+public\.agente_perguntas_ml/i.test(CODIGO));
ok("F3  nenhum grant para anon",
  !/grant[^;]*\bto\s+anon\b/i.test(CODIGO));
ok("F4  nenhum grant para authenticated",
  !/grant[^;]*\bto\s+authenticated\b/i.test(CODIGO));
ok("F5  o revoke nominal existe ALEM do `from public` (licao do SEC1)",
  /from\s+anon\s*;/i.test(CODIGO) && /from\s+authenticated\s*;/i.test(CODIGO));

// ─── G. A RPC ─────────────────────────────────────────────────────────

secao("G. RPC de upsert em lote");
ok("G1  assinatura (text, uuid, jsonb) -> jsonb",
  /create\s+or\s+replace\s+function\s+public\.agente_perguntas_ml_upsert_lote\s*\(\s*p_user_id\s+text\s*,\s*p_loja_id\s+uuid\s*,\s*p_perguntas\s+jsonb\s*\)\s*returns\s+jsonb/i.test(CODIGO));
ok("G2  security invoker", /\bsecurity\s+invoker\b/i.test(CODIGO));
ok("G3  set search_path = public", /set\s+search_path\s*=\s*public/i.test(CODIGO));
ok("G4  NAO e security definer", !/security\s+definer/i.test(CODIGO));

secao("H. A RPC valida o DONO antes de escrever");
const corpoRpc = CODIGO.slice(CODIGO.indexOf("agente_perguntas_ml_upsert_lote"));
const posGuarda = corpoRpc.search(/loja_nao_utilizavel_para_perguntas_ml/);
const posInsert = corpoRpc.search(/insert\s+into\s+public\.agente_perguntas_ml/i);
ok("H0  a guarda exige marketplace = 'ML' na MESMA condicao",
  /from\s+public\.lojas\s+l[\s\S]{0,200}l\.marketplace\s*=\s*'ML'/i.test(corpoRpc));
const recusas42501 = [...corpoRpc.matchAll(
  /raise\s+exception\s+'([a-z_]+)'\s+using\s+errcode\s*=\s*'42501'/gi)].map((m) => m[1]);
ok("H0b recusa unica para inexistente / alheia / outro marketplace",
  recusas42501.length > 0
  && new Set(recusas42501).size === 1
  && recusas42501[0] === "loja_nao_utilizavel_para_perguntas_ml",
  recusas42501.join(","));
ok("H1  confere a posse da loja em `lojas`",
  /select\s+exists\s*\([\s\S]{0,160}from\s+public\.lojas[\s\S]{0,120}l\.id\s*=\s*p_loja_id\s+and\s+l\.user_id\s*=\s*p_user_id/i.test(corpoRpc));
ok("H2  recusa par incoerente com 42501",
  /raise\s+exception\s+'loja_nao_utilizavel_para_perguntas_ml'\s+using\s+errcode\s*=\s*'42501'/i.test(corpoRpc));
ok("H3  a guarda vem ANTES do insert",
  posGuarda !== -1 && posInsert !== -1 && posGuarda < posInsert,
  `guarda@${posGuarda} insert@${posInsert}`);
ok("H4  o comando tambem filtra por dono (o `do update` nao reavalia a FK)",
  /where\s+alvo\.user_id\s*=\s*p_user_id/i.test(corpoRpc));
ok("H5  recusa user_id vazio", /raise\s+exception\s+'user_id ausente'/i.test(corpoRpc));
ok("H6  recusa loja_id nulo", /raise\s+exception\s+'loja_id ausente'/i.test(corpoRpc));

secao("I. Validacao estrutural e duplicata no lote");
ok("I1  linha invalida derruba o LOTE",
  /raise\s+exception\s+'pergunta_estruturalmente_invalida'/i.test(corpoRpc));
// Reconciliado com o dominio: `normalizarPergunta` ja descarta item sem
// texto, entao texto vazio aqui e defeito de chamador — falha fechada.
ok("I2  `texto` E obrigatorio e derruba o lote quando ausente",
  /where\s+id_externo\s+is\s+null[\s\S]{0,260}or\s+texto\s+is\s+null[\s\S]{0,200}criada_em_provider\s+is\s+null/i.test(corpoRpc));
ok("I3  duplicata DIVERGENTE no lote falha",
  /raise\s+exception\s+'duplicata_divergente_no_lote'/i.test(corpoRpc));
ok("I4  duplicata detectada por count(distinct ...) agrupado pela chave",
  /group\s+by\s+id_externo[\s\S]{0,140}having\s+count\(distinct/i.test(corpoRpc));
ok("I5  colapso deterministico por `distinct on` com ordem explicita",
  /select\s+distinct\s+on\s*\(\s*id_externo\s*\)[\s\S]{0,120}order\s+by\s+id_externo\s*,\s*ordem/i.test(corpoRpc));
ok("I6  recusa `p_perguntas` que nao seja array",
  /jsonb_typeof\(p_perguntas\)\s*<>\s*'array'/i.test(corpoRpc));

secao("J. Semantica do conflito");
ok("J1  ultimo_visto_em atualizado em TODA observacao, sem condicao",
  /do\s+update[\s\S]{0,200}ultimo_visto_em\s*=\s*v_observado_em\s*,/i.test(corpoRpc)
  && !/ultimo_visto_em\s*=\s*case/i.test(corpoRpc));
ok("J2  provider_status atualizado com o observado",
  /provider_status\s*=\s*excluded\.provider_status/i.test(corpoRpc));
ok("J3  texto atualizado com o observado (ja resolvido contra o gravado)",
  /texto\s*=\s*excluded\.texto/i.test(corpoRpc));
ok("J4  NAO ha coalesce de texto — texto ausente ja falhou antes",
  !/coalesce\(u\.texto/i.test(corpoRpc));
ok("J5  alterado_em so muda quando algo MATERIAL mudou",
  /alterado_em\s*=\s*case[\s\S]{0,200}is\s+distinct\s+from[\s\S]{0,160}else\s+alvo\.alterado_em/i.test(corpoRpc));

const blocoDoUpdate = (corpoRpc.match(/do\s+update\s+set[\s\S]*?where\s+alvo\.user_id/i) ?? [""])[0];
for (const proibido of ["estado_interno", "primeiro_visto_em", "criado_em"]) {
  ok(`J6  \`${proibido}\` NUNCA e tocado em conflito`,
    !new RegExp(`${proibido}\\s*=`, "i").test(blocoDoUpdate));
}

// A secao K foi retirada: os nomes de metrica mudaram na R1 e a
// secao Q cobre o conjunto novo, sem ambiguidade.

secao("L. Privilegios da RPC");
const ASSINATURA = "public\\.agente_perguntas_ml_upsert_lote\\(text,\\s*uuid,\\s*jsonb\\)";
for (const papel of ["public", "anon", "authenticated", "service_role"]) {
  ok(`L1  revoke all na funcao para \`${papel}\``,
    new RegExp(`revoke\\s+all\\s+on\\s+function\\s+${ASSINATURA}\\s+from\\s+${papel}\\s*;`, "i").test(CODIGO));
}
ok("L2  grant execute somente a service_role",
  new RegExp(`grant\\s+execute\\s+on\\s+function\\s+${ASSINATURA}\\s+to\\s+service_role\\s*;`, "i").test(CODIGO));

secao("M. Documentacao do contrato");
ok("M1  comment on table registra o que provider_status NAO e",
  /comment\s+on\s+table\s+public\.agente_perguntas_ml/i.test(SQL)
  && /ULTIMO STATUS OBSERVADO/i.test(SQL));
ok("M2  comment on column diz LAST_OBSERVED_PROVIDER_STATUS",
  /LAST_OBSERVED_PROVIDER_STATUS, not authoritative current state/i.test(SQL));
ok("M3  comment on function descreve o contrato do upsert",
  /comment\s+on\s+function\s+public\.agente_perguntas_ml_upsert_lote/i.test(SQL));
ok("M4  a migration declara que NAO foi aplicada",
  /NAO APLICADA AINDA/i.test(SQL));

secao("N. Escopo: nada alem da ingestao");
ok("N1  sem RPC de transicao de estado", !/transicao|_transitar|mudar_estado/i.test(CODIGO));
ok("N2  sem Funcao de resposta ao marketplace", !/responder_pergunta|reply/i.test(CODIGO));
ok("N3  sem trigger", !/create\s+trigger/i.test(CODIGO));
ok("N4  sem RLS ligada (padrao das 7 irmas do caminho de agentes)",
  !/enable\s+row\s+level\s+security/i.test(CODIGO));
ok("N5  sem alteracao em tabela existente",
  !/alter\s+table\s+public\.(lojas|agentes|agente_tarefas|agente_conexoes|agente_permissoes|agente_funcao_chamadas)/i.test(CODIGO));

secao("O. Identidade imutavel do provider");
ok("O1  divergencia de anuncio_id_externo ou criada_em_provider FALHA",
  /raise\s+exception\s+'identidade_do_provider_divergente'/i.test(corpoRpc));
ok("O2  a checagem compara contra a linha GRAVADA",
  /where\s+existia[\s\S]{0,260}anuncio_anterior\s+is\s+distinct\s+from\s+anuncio_id_externo[\s\S]{0,200}criada_em_anterior\s+is\s+distinct\s+from\s+criada_em_provider/i.test(corpoRpc));
ok("O3  a checagem vem ANTES do insert",
  corpoRpc.search(/identidade_do_provider_divergente/) <
    corpoRpc.search(/insert\s+into\s+public\.agente_perguntas_ml/i));
ok("O4  `provider_status` e `texto` seguem MUTAVEIS",
  /provider_status\s*=\s*excluded\.provider_status/i.test(corpoRpc)
  && /texto\s*=\s*excluded\.texto/i.test(corpoRpc));

secao("P. Metricas honestas sob concorrencia");
ok("P1  distingue INSERT de UPDATE por `xmax = 0`",
  /returning\s+alvo\.id_externo\s*,\s*\(\s*xmax\s*=\s*0\s*\)\s+as\s+inserida/i.test(corpoRpc));
const trechoMetricas = corpoRpc.slice(corpoRpc.search(/returning\s+alvo\.id_externo/i));
ok("P2  `novas` conta por xmax (`inserida`), nunca pelo `existia` lido antes",
  /count\(\*\)\s+filter\s*\(\s*where\s+g\.inserida\s*\)/i.test(trechoMetricas)
  && /\binto\b[^;]*\bv_novas\b/i.test(trechoMetricas)
  && !/\bexistia\b/i.test(trechoMetricas));
ok("P3  `atualizadas` exige NOT inserida",
  /where\s+not\s+g\.inserida/i.test(corpoRpc));
const corpoIncompleto = corpoRpc.slice(
  corpoRpc.search(/if\s+v_gravadas\s*<>\s*v_unicas/i),
  corpoRpc.search(/return\s+jsonb_build_object/i));
ok("P4  lote incompleto vira ERRO, nunca no-op silencioso",
  (corpoIncompleto.match(/raise\s+exception/gi) ?? []).length === 3
  && !/\breturn\b/i.test(corpoIncompleto),
  String((corpoIncompleto.match(/raise\s+exception/gi) ?? []).length));

secao("Q. Nomes de metrica sem ambiguidade");
for (const m of ["recebidas", "unicas", "duplicadas_no_lote", "novas", "atualizadas", "reobservadas"]) {
  ok(`Q1  devolve \`${m}\``, new RegExp(`'${m}'\\s*,`, "i").test(corpoRpc));
}
ok("Q2  `deduplicadas` — nome ambiguo — foi RETIRADO",
  !/'deduplicadas'/i.test(corpoRpc));
ok("Q3  `duplicadas_no_lote` e o que foi REMOVIDO por duplicidade",
  /'duplicadas_no_lote'\s*,\s*v_recebidas\s*-\s*v_unicas/i.test(corpoRpc));
ok("Q4  `reobservadas` e derivada",
  /'reobservadas'\s*,\s*v_unicas\s*-\s*v_novas\s*-\s*v_atualizadas/i.test(corpoRpc));

secao("R. Lote vazio");
ok("R1  array vazio passa pela checagem de tipo",
  /jsonb_typeof\(p_perguntas\)\s*<>\s*'array'/i.test(corpoRpc));
ok("R2  nenhuma guarda rejeita comprimento zero",
  !/jsonb_array_length\(p_perguntas\)\s*=\s*0[\s\S]{0,80}raise/i.test(corpoRpc));

secao("S. Reentrancia — a RPC nao deixa estado de sessao");
/* DEF1-INBOX-REENTRANCIA: `create temporary table ... on commit drop` so
   some no COMMIT, nao na saida da funcao. Eram QUATRO relacoes temporarias
   encadeadas, e a segunda chamada na MESMA transacao colidia com o que a
   primeira havia deixado. Estes invariantes leem `CODIGO`/`corpoRpc`, que
   ja estao sem comentario — prosa nao prova invariante. */
ok("S1  nenhuma relacao temporaria e criada",
  !/create\s+(global\s+|local\s+)?temp(orary)?\s+table/i.test(CODIGO));
ok("S2  nenhum `on commit` — a RPC nao depende do fim da transacao",
  !/\bon\s+commit\b/i.test(CODIGO));
ok("S3  nenhum uso de `pg_temp`",
  !/\bpg_temp\b/i.test(CODIGO));
ok("S4  nenhum `drop table` — o remendo desencorajado nao foi usado",
  !/\bdrop\s+table\b/i.test(CODIGO));
ok("S5  a normalizacao virou CTE",
  /with\s+entrada\s+as\s*\(/i.test(corpoRpc));
ok("S6  o dedupe deterministico virou CTE",
  /unico\s+as\s*\(\s*select\s+distinct\s+on\s*\(\s*id_externo\s*\)/i.test(corpoRpc));
ok("S7  o INSERT le de CTE, nao de relacao temporaria",
  /from\s+prevista\s+a\s+on\s+conflict/i.test(corpoRpc));
ok("S8  a metrica le o RETURNING da gravacao, e SO ele",
  /into\s+v_gravadas\s*,\s*v_novas\s*,\s*v_atualizadas\s+from\s+gravacao\s+g\s*;/i
    .test(corpoRpc.replace(/\s+/g, " ")));

secao("T. Ordem das recusas preservada apos a reescrita");
const RECUSAS = ["pergunta_estruturalmente_invalida", "duplicata_divergente_no_lote",
                 "identidade_do_provider_divergente", "lote_incompleto"];
const posRecusa = RECUSAS.map((n) =>
  corpoRpc.search(new RegExp(`raise\\s+exception\\s+'${n}'`)));
ok("T1  as quatro recusas continuam existindo",
  posRecusa.every((x) => x >= 0), posRecusa.join(","));
ok("T2  estrutural < duplicata < identidade < lote_incompleto",
  posRecusa.every((x, k) => k === 0 || (x > posRecusa[k - 1] && posRecusa[k - 1] >= 0)));
ok("T3  as tres validacoes ocorrem ANTES do INSERT",
  posRecusa.slice(0, 3).every((x) => x >= 0 && x < posInsert));
ok("T4  `existia` so serve a checagem de identidade, nunca a metrica",
  (corpoRpc.match(/\bexistia\b/g) ?? []).length === 2);

secao("W. Metrica material sob disputa (F6)");
/* O snapshot do comando de escrita e tirado ANTES de o `on conflict`
   bloquear. A sessao perdedora de uma disputa nao enxerga a linha que a
   vencedora criou, entao um "antes" lido ali vem nulo e classificava
   payload IDENTICO como `atualizada`. O veredito material passa a vir do
   proprio `do update`, onde `alvo.*` ja e a linha real pos-espera. */
const iniEscrita = corpoRpc.lastIndexOf("with entrada as (",
  corpoRpc.indexOf("insert into public.agente_perguntas_ml as alvo"));
const fimEscrita = corpoRpc.indexOf("from gravacao g;", iniEscrita) + "from gravacao g;".length;
const trechoEscrita = corpoRpc.slice(iniEscrita, fimEscrita);
ok("W1  o RETURNING exporta o veredito de mudanca material",
  /returning[\s\S]{0,160}as\s+mudou_material/i.test(trechoEscrita));
ok("W2  o veredito vem de `alterado_em` decidido DENTRO do do update",
  /\(\s*alvo\.alterado_em\s*=\s*v_observado_em\s*\)\s+as\s+mudou_material/i.test(trechoEscrita));
ok("W3  `atualizadas` conta por NOT inserida E mudou_material",
  /filter\s*\(\s*where\s+not\s+g\.inserida\s+and\s+g\.mudou_material\s*\)/i
    .test(trechoEscrita.replace(/\s+/g, " ")));
ok("W4  a metrica nao le nenhum estado ANTERIOR ao comando",
  !/_anterior/i.test(trechoEscrita));
ok("W5  o comando de escrita nao le a tabela antes de escrever",
  !/\bjoin\b/i.test(trechoEscrita.slice(0, trechoEscrita.indexOf("insert into"))));
ok("W6  `xmax` serve so a `novas`, nunca a mudanca material",
  (trechoEscrita.match(/\bxmax\b/gi) ?? []).length === 1
  && /\(\s*xmax\s*=\s*0\s*\)\s+as\s+inserida/i.test(trechoEscrita));
ok("W7  a guarda de identidade e VALIDACAO, e corre antes do INSERT",
  /anuncio_anterior/i.test(corpoRpc)
  && corpoRpc.search(/anuncio_anterior/i) < corpoRpc.search(/identidade_do_provider_divergente/)
  && corpoRpc.search(/identidade_do_provider_divergente/) < posInsert);

secao("X. CASE 20 — migrations versionadas intocadas");
/* CASE_20_KIND = REPOSITORY_INTEGRITY. Nao e comportamento de banco, e
   por isso nao mora na suite SQL: prova que esta frente nao alterou
   nenhuma migration ja rastreada no HEAD. */
const git = (...args: string[]) =>
  execFileSync("git", ["-C", RAIZ, ...args], { encoding: "utf8" });

const diffMigrations = git("diff", "--name-only", "HEAD", "--", "supabase/migrations/").trim();
ok("20.1 nenhuma migration rastreada difere do HEAD",
  diffMigrations === "", diffMigrations.replace(/\n/g, " | "));

const estado = git("status", "--short", "--", "supabase/migrations/")
  .split("\n").map((l) => l.trimEnd()).filter((l) => l !== "");
ok("20.2 o unico path novo e a migration desta frente",
  estado.length === 1 && /^\?\? +supabase\/migrations\/20261009_agente_perguntas_ml\.sql$/.test(estado[0]),
  estado.join(" | "));
ok("20.3 nenhuma migration modificada, apagada, renomeada ou em stage",
  estado.every((l) => l.startsWith("??")), estado.join(" | "));

const A7 = "supabase/migrations/20261008_agente_tarefas_polling_perguntas_unica.sql";
ok("20.4 20261008 esta rastreada no HEAD",
  git("ls-files", "--error-unmatch", "--", A7).trim() === A7);
ok("20.5 20261008 nao tem diferenca alguma contra o HEAD",
  git("diff", "HEAD", "--", A7).trim() === "");
ok("20.6 o blob de 20261008 em disco e o mesmo registrado no HEAD",
  git("hash-object", "--", A7).trim() === git("rev-parse", `HEAD:${A7}`).trim());

secao("U. Semantica temporal — um instante por chamada");
/* F2/F3: `now()` e o instante da TRANSACAO, nao da chamada. Duas chamadas
   validas na mesma transacao recebiam o MESMO valor, entao `ultimo_visto_em`
   nao avancava e `alterado_em` nao avancava em mudanca material. A RPC passou
   a capturar UM `clock_timestamp()` por chamada, no DECLARE.

   `corpoRpc` comeca no CREATE FUNCTION, entao os `default now()` da DDL ficam
   de fora — e por isso que U3 pode exigir ZERO `now()` sem conflitar com a
   tabela, que segue com seus defaults. */
const capturas = corpoRpc.match(/\bclock_timestamp\s*\(\s*\)/gi) ?? [];
ok("U1  exatamente UMA captura de relogio na RPC",
  capturas.length === 1, `capturas=${capturas.length}`);
ok("U2  a captura vive no DECLARE, atribuida a `v_observado_em`",
  /v_observado_em\s+timestamptz\s*:=\s*clock_timestamp\s*\(\s*\)\s*;/i.test(corpoRpc));
ok("U3  o corpo da RPC nao usa mais tempo de TRANSACAO",
  !/\bnow\s*\(\s*\)|\bcurrent_timestamp\b|\btransaction_timestamp\s*\(|\bstatement_timestamp\s*\(/i
    .test(corpoRpc));
ok("U4  no INSERT, os dois campos de observacao nascem do mesmo instante",
  /primeiro_visto_em\s*,\s*ultimo_visto_em\s*\)/i.test(corpoRpc)
  && /v_observado_em\s*,\s*v_observado_em/i.test(corpoRpc));
ok("U5  em conflito, `ultimo_visto_em` recebe o instante da chamada",
  /ultimo_visto_em\s*=\s*v_observado_em\s*,/i.test(corpoRpc));
ok("U6  `alterado_em` so recebe o instante DENTRO do case de mudanca material",
  /alterado_em\s*=\s*case\s+when\s+alvo\.provider_status\s+is\s+distinct\s+from\s+excluded\.provider_status\s+or\s+alvo\.texto\s+is\s+distinct\s+from\s+excluded\.texto\s+then\s+v_observado_em\s+else\s+alvo\.alterado_em\s+end/i
    .test(corpoRpc.replace(/\s+/g, " ")));
ok("U7  reobservacao pura preserva `alterado_em`",
  /else\s+alvo\.alterado_em/i.test(corpoRpc));
ok("U8  `criado_em` e `primeiro_visto_em` nao sao tocados no ramo de conflito",
  !/do update[\s\S]*?(criado_em|primeiro_visto_em)\s*=/i.test(corpoRpc));
ok("U9  a DDL preserva os defaults das quatro colunas de tempo",
  ["primeiro_visto_em", "ultimo_visto_em", "criado_em", "alterado_em"].every((c) =>
    new RegExp(`${c} timestamptz not null default now\\(\\)`, "i").test(CODIGO)));
ok("U10 o CHECK de coerencia temporal continua existindo",
  /ultimo_visto_em\s*>=\s*primeiro_visto_em/i.test(CODIGO));

secao("Y. Identidade imutavel SOB DISPUTA (F8)");
/* A validacao de identidade la em cima le o snapshot do proprio comando e
   nao enxerga linha criada por uma concorrente depois dele. Sem cerca no
   `do update`, `texto` e `provider_status` de um payload com identidade
   divergente eram gravados sobre a linha alheia, que mantinha o
   `anuncio_id_externo` da outra — linha hibrida. A cerca agora vive no
   comando de escrita, e um conflito recusado por ela e CLASSIFICADO, nao
   engolido. */
const doUpdate = trechoEscrita.slice(
  trechoEscrita.indexOf("on conflict"),
  trechoEscrita.indexOf("returning"));

ok("Y1  o `where` do do update exige o dono",
  /where\s+alvo\.user_id\s*=\s*p_user_id/i.test(doUpdate));
ok("Y2  o `where` exige `anuncio_id_externo` igual ao observado",
  /alvo\.anuncio_id_externo\s+is\s+not\s+distinct\s+from\s+excluded\.anuncio_id_externo/i
    .test(doUpdate.replace(/\s+/g, " ")));
ok("Y3  o `where` exige `criada_em_provider` igual ao observado",
  /alvo\.criada_em_provider\s+is\s+not\s+distinct\s+from\s+excluded\.criada_em_provider/i
    .test(doUpdate.replace(/\s+/g, " ")));
ok("Y4  a cerca e NULL-safe (is not distinct from, nunca `=`)",
  (doUpdate.match(/is\s+not\s+distinct\s+from/gi) ?? []).length === 2);
ok("Y5  os campos imutaveis continuam FORA do SET",
  !/set[\s\S]*?(anuncio_id_externo|criada_em_provider)\s*=/i
    .test(doUpdate.slice(doUpdate.indexOf("set"), doUpdate.indexOf("where"))));

const posIncompleto = corpoRpc.search(/v_gravadas\s*<>\s*v_unicas/i);
const trechoClassifica = corpoRpc.slice(posIncompleto);
ok("Y6  lote incompleto NAO vira mais um raise cego",
  !/v_gravadas\s*<>\s*v_unicas\s*then\s*raise\s+exception\s+'lote_incompleto'/i
    .test(corpoRpc.replace(/\s+/g, " ")));
ok("Y7  a classificacao usa um comando NOVO, com snapshot novo",
  /with\s+entrada\s+as\s*\(/i.test(trechoClassifica)
  && corpoRpc.lastIndexOf("with entrada as (") > posIncompleto);
ok("Y8  divergencia de identidade em corrida da a MESMA recusa da sequencial",
  /v_identidade_concorrente\s+then\s+raise\s+exception\s+'identidade_do_provider_divergente'\s+using\s+errcode\s*=\s*'22023'/i
    .test(trechoClassifica.replace(/\s+/g, " ")));
ok("Y9  dono divergente em corrida cai na recusa de seguranca 42501",
  /v_dono_concorrente\s+then\s+raise\s+exception\s+'loja_nao_utilizavel_para_perguntas_ml'\s+using\s+errcode\s*=\s*'42501'/i
    .test(trechoClassifica.replace(/\s+/g, " ")));
ok("Y10 `lote_incompleto` sobrevive como ultimo recurso, e so como ultimo",
  /raise\s+exception\s+'lote_incompleto'\s+using\s+errcode\s*=\s*'25000'/i.test(trechoClassifica)
  && trechoClassifica.search(/'lote_incompleto'/)
     > trechoClassifica.search(/'identidade_do_provider_divergente'/)
  && trechoClassifica.search(/'lote_incompleto'/)
     > trechoClassifica.search(/'loja_nao_utilizavel_para_perguntas_ml'/));
ok("Y11 nenhum caminho devolve metrica depois de um conflito recusado",
  corpoRpc.search(/return\s+jsonb_build_object/i) > trechoClassifica.search(/'lote_incompleto'/) + posIncompleto);

secao("Z. O harness de concorrencia e artefato permanente");
/* O CASO 15 nao cabe na suite SQL: disputa exige transacoes separadas.
   Antes ele vivia so no scratchpad e morria no cleanup, entao a prova
   existia nos relatorios e nao no repositorio. Estes invariantes provam
   que ele existe e que o oraculo dele continua EXATO — nao reimplementam
   o harness em regex. */
const HARNESS = "scripts/testar-agentes-perguntas-inbox-concorrencia.ts";
const CONC = ler(HARNESS);

ok("Z1  o harness existe no repositorio", CONC.length > 0);
ok("Z2  a conexao vem de variavel de teste explicita",
  /QUESTION_INBOX_TEST_DATABASE_URL/.test(CONC));
ok("Z3  NAO existe fallback para DATABASE_URL",
  !/process\.env\.DATABASE_URL|process\.env\[\s*["'`]DATABASE_URL/.test(CONC));
ok("Z4  exige a flag --confirmo antes de qualquer escrita",
  /argv\.includes\(\s*"--confirmo"\s*\)/.test(CONC));
ok("Z5  hospedeiro por allowlist local, nao blocklist de producao",
  /HOSTS_LOCAIS/.test(CONC) && /!HOSTS_LOCAIS\.has\(/.test(CONC));
ok("Z6  as tres cercas correm ANTES de abrir conexao",
  CONC.indexOf("conexaoConferida") < CONC.indexOf("new Client("));
ok("Z7  usa `pg` com tres conexoes: duas em disputa e uma observadora",
  /from "pg"/.test(CONC) && (CONC.match(/new Client\(\{\s*connectionString/g) ?? []).length === 3);
ok("Z8  toda sessao recebe os tres timeouts",
  /set statement_timeout/.test(CONC)
  && /set lock_timeout/.test(CONC)
  && /set idle_in_transaction_session_timeout/.test(CONC));
ok("Z9  ha timeout de PROCESSO, alem dos de sessao",
  /TEMPO_MAXIMO_MS/.test(CONC) && /setTimeout\(/.test(CONC) && /process\.exit\(2\)/.test(CONC));
ok("Z10 as conexoes fecham em `finally`",
  /finally\s*\{[\s\S]{0,200}Promise\.all\(\[A\.end\(\), B\.end\(\), C\.end\(\)\]\)/.test(CONC));
ok("Z11 exige LOCK real observado, nunca infere disputa",
  /wait_event_type === "Lock"/.test(CONC)
  && /disputa real observada/.test(CONC));
ok("Z12 o oraculo fixa TODAS as seis metricas, sem alternativa permissiva",
  /Object\.entries\(esperado\)\.every/.test(CONC)
  && !/atualizadas\s*\+\s*reobservadas/.test(
       CONC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\*.*$/gm, "")));
ok("Z13 C1 exige perdedora com reobservadas=1 E atualizadas=0",
  /novas: 0, atualizadas: 0, reobservadas: 1/.test(CONC));
ok("Z14 C2 exige perdedora com atualizadas=1 E reobservadas=0",
  /novas: 0, atualizadas: 1, reobservadas: 0/.test(CONC));
ok("Z15 C3A e C3B exigem SQLSTATE 22023 de identidade divergente",
  /code === "22023"/.test(CONC)
  && /identidade_do_provider_divergente/.test(CONC));
ok("Z16 C4 exige a linha valida do lote AUSENTE",
  /Q-C4-VALID[\s\S]{0,400}=== null/.test(CONC));
ok("Z17 os cinco casos do CASO 15 estao presentes",
  ["C1", "C2", "C3A", "C3B", "C4"].every((c) =>
    new RegExp(`ok\\("${c}\\s`).test(CONC)));
ok("Z18 nenhum segredo literal no arquivo",
  !/postgres(ql)?:\/\/[^"'`\s]*:[^"'`\s@]+@/.test(CONC)
  && !/\b(eyJ|sb_|service_role_key)/.test(CONC));

console.log(`\n── placar ${"─".repeat(54)}`);

console.log(`  PASS ${passou}   FAIL ${falhou}\n`);
if (falhou > 0) process.exitCode = 1;
