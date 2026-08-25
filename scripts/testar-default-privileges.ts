/**
 * Suite da frente DEFAULT-PRIVILEGES-SEC1.
 *
 * Prova a invariante:
 *
 *   "A migration que fecha o default privilege de `anon` faz EXATAMENTE
 *    isso — e nada mais."
 *
 * ── Por que esta suite existe ───────────────────────────────────────
 * `ALTER DEFAULT PRIVILEGES` e o comando mais silenciosamente perigoso
 * desta frente: ele nao produz efeito visivel no momento em que roda.
 * Um erro de escopo — atingir `service_role`, `authenticated`,
 * SEQUENCES ou FUNCTIONS por engano — so apareceria muito depois, na
 * forma de uma tabela futura quebrada ou de um privilegio que ninguem
 * lembra de ter perdido.
 *
 * Por isso a guarda e sobre o TEXTO do statement, e e restritiva: o que
 * nao esta explicitamente autorizado tem que estar explicitamente
 * ausente.
 *
 * ── Instrumento ─────────────────────────────────────────────────────
 * Inspecao de fonte, sem rede e sem banco — a invariante e sobre o que
 * a migration DIZ, e isso e propriedade estatica do arquivo.
 *
 * LIMITE DECLARADO: esta suite NAO prova que o default foi aplicado no
 * banco. Isso e fato de catalogo, verificado por probe em gate proprio,
 * e permanece PENDENTE — por decisao explicita, o arquivo vem antes.
 */
import { readFileSync } from "fs";
import { join } from "path";

const RAIZ = join(__dirname, "..");
const fonte = (rel: string) => readFileSync(join(RAIZ, rel), "utf8");

/**
 * Fonte SEM comentarios. As guardas da SEC-1c-3 inspecionam CODIGO da
 * rota e da lib: este projeto documenta fartamente o que decidiu nao
 * fazer, e uma busca ingenua por `supabase` casaria com a explicacao de
 * por que o call site foi migrado — reprovando pelo motivo errado.
 */
const codigo = (rel: string) =>
  fonte(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

let passou = 0;
let falhou = 0;
function ok(nome: string, condicao: boolean) {
  if (condicao) {
    passou++;
  } else {
    falhou++;
    console.error(`  ✗ ${nome}`);
  }
}

const MIGRACAO = "supabase/migrations/20260912_sec1a_revogar_default_anon_tabelas.sql";

let sql = "";
let existe = true;
try {
  sql = fonte(MIGRACAO);
} catch {
  existe = false;
}

// SQL sem comentarios. Toda asserção de AUSENCIA depende disto: a
// migration documenta fartamente o que decidiu NAO tocar, e uma busca
// ingenua por "service_role" ou "SEQUENCES" casaria com a justificativa
// — reprovando pelo motivo errado.
const executavel = sql.replace(/--.*$/gm, "");
const statements = executavel
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);

// ══════════════════════════════════════════════════════════════════════
// 1-4 — O STATEMENT
// ══════════════════════════════════════════════════════════════════════
ok("1. a migration SEC-1a existe", existe);
ok("2. tem exatamente UM statement executavel", statements.length === 1);
ok(
  "3. o statement e exatamente o ALTER DEFAULT PRIVILEGES esperado",
  /^ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE SELECT, INSERT, UPDATE ON TABLES FROM anon$/i.test(
    (statements[0] ?? "").replace(/\s+/g, " ")
  )
);
// Um GRANT executavel aqui reabriria o default em qualquer replay das
// migrations — e o modo de falha mais caro possivel nesta frente.
ok("4. nenhum GRANT executavel", !/\bGRANT\b/i.test(executavel));

// ══════════════════════════════════════════════════════════════════════
// 5 — ROLLBACK DOCUMENTADO, NUNCA ARMADO
// ══════════════════════════════════════════════════════════════════════
ok(
  "5. o rollback aparece SOMENTE como comentario",
  /^--\s+ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public$/m.test(sql) &&
    /^--\s+GRANT SELECT, INSERT, UPDATE ON TABLES TO anon;$/m.test(sql)
);

// ══════════════════════════════════════════════════════════════════════
// 6-11 — O QUE A MIGRATION NAO PODE TOCAR
// ══════════════════════════════════════════════════════════════════════
// Cada uma destas foi excluida do escopo por uma razao propria, e todas
// sao verificadas contra o SQL EXECUTAVEL — a prosa pode e deve
// menciona-las para explicar por que ficaram de fora.
ok("6. nao toca service_role", !/service_role/i.test(executavel));
ok("7. nao toca authenticated", !/authenticated/i.test(executavel));
ok("8. nao toca supabase_admin", !/supabase_admin/i.test(executavel));
ok("9. nao toca SEQUENCES", !/\bSEQUENCES?\b/i.test(executavel));
ok("10. nao toca FUNCTIONS/ROUTINES", !/\b(FUNCTIONS?|ROUTINES?)\b/i.test(executavel));
ok(
  "11. nao toca RLS, policy nem grant de coluna",
  !/\b(ROW LEVEL SECURITY|POLICY|COLUMN)\b/i.test(executavel)
);

// ══════════════════════════════════════════════════════════════════════
// 12-14 — NAO E RETROATIVA: nenhuma tabela existente e alterada
// ══════════════════════════════════════════════════════════════════════
// A distincao entre `ALTER DEFAULT PRIVILEGES ... REVOKE` (regra para o
// futuro) e `REVOKE ... ON TABLE` (efeito imediato) e o coracao desta
// PR. Um `REVOKE` solto aqui atingiria as 33 tabelas de uma vez.
ok(
  "12. NAO existe REVOKE direto em tabela (seria retroativo)",
  !/REVOKE[^;]*\bON\s+(TABLE|ALL TABLES)\b/i.test(executavel)
);
ok("13. nenhuma tabela e nomeada no SQL executavel", !/public\.[a-z_]+/i.test(executavel));
ok(
  "14. o unico REVOKE e o de DEFAULT PRIVILEGES",
  (executavel.match(/\bREVOKE\b/gi) ?? []).length === 1
);

// ══════════════════════════════════════════════════════════════════════
// 15 — SEGREDOS
// ══════════════════════════════════════════════════════════════════════
ok(
  "15. a migration nao contem token, chave nem segredo",
  !/eyJ[A-Za-z0-9_-]{15,}/.test(sql) &&
    !/-----BEGIN/.test(sql) &&
    !/sbp_[a-f0-9]{20,}/.test(sql) &&
    !/(SERVICE_ROLE_KEY|ANON_KEY|SESSION_SECRET)\s*=/.test(sql)
);

// ══════════════════════════════════════════════════════════════════════
// 16-18 — DOCUMENTACAO OBRIGATORIA
// ══════════════════════════════════════════════════════════════════════
// Estes travam a PROSA, nao o comportamento. Existem porque uma
// migration de privilegio sem explicacao vira, meses depois, um comando
// que ninguem sabe se pode reverter.
ok("16. documenta que NAO e retroativa", /NAO E RETROATIVO|nao e retroativ/i.test(sql));
ok(
  "17. documenta que as tabelas existentes nao sao alteradas",
  /33 tabelas/i.test(sql) && /continuar[aã]o tendo/i.test(sql)
);
ok(
  "18. documenta o procedimento de verificacao pos-execucao",
  /baseline/i.test(sql) && /md5\(string_agg/i.test(sql)
);

// ══════════════════════════════════════════════════════════════════════
// SEC-1c-1 — REVOGAR anon EM 10 TABELAS SEM DEPENDENCIA
// ══════════════════════════════════════════════════════════════════════
// Diferente da SEC-1a, esta migration É retroativa: atinge tabelas que
// existem. O contrato aqui é sobre O CONJUNTO — quais tabelas, qual
// role, quais privilégios — e uma 11ª tabela, um `CASCADE` ou um
// `authenticated` a mais teriam efeito imediato em produção.
{
  const MIG_1C1 = "supabase/migrations/20260913_sec1c1_revogar_anon_tabelas_sem_uso.sql";

  // A lista é literal e ordenada: a suíte não deve descobrir as tabelas
  // do mesmo jeito que a migration, senão as duas erram juntas.
  const DEZ = [
    "central_ia_biblioteca_produtos",
    "central_ia_biblioteca_produtos_versoes",
    "central_ia_creditos",
    "central_ia_creditos_lancamentos",
    "central_ia_prompts",
    "estudio_anuncios_auditoria",
    "estudio_anuncios_pendencias",
    "estudio_anuncios_pictures_marketplace",
    "estudio_anuncios_score",
    "estudio_anuncios_videos_gerados",
  ] as const;

  let sql1c1 = "";
  let existe1c1 = true;
  try {
    sql1c1 = fonte(MIG_1C1);
  } catch {
    existe1c1 = false;
  }
  const exec1c1 = sql1c1.replace(/--.*$/gm, "");
  const st1c1 = exec1c1.split(";").map((s) => s.trim()).filter(Boolean);

  ok("19. a migration SEC-1c-1 existe", existe1c1);
  ok("20. tem exatamente 10 statements executaveis", st1c1.length === 10);

  // Cada statement precisa casar a forma canônica INTEIRA. Um `.test()`
  // frouxo aceitaria `REVOKE ALL` ou `FROM anon, authenticated`.
  const FORMA = /^REVOKE SELECT, INSERT, UPDATE ON TABLE public\.([a-z_]+) FROM anon$/;
  const casados = st1c1.map((s) => FORMA.exec(s.replace(/\s+/g, " ")));
  ok("21. todos os 10 seguem a forma canonica exata", casados.every(Boolean));

  const alvos = casados.filter(Boolean).map((m) => m![1]).sort();
  ok(
    "22. as tabelas atingidas sao EXATAMENTE as 10 autorizadas",
    JSON.stringify(alvos) === JSON.stringify([...DEZ].sort())
  );
  ok("23. nenhuma 11a tabela", alvos.length === 10 && new Set(alvos).size === 10);

  // Só `anon`. `authenticated` já tem zero nas 10, e `service_role` é a
  // role que a aplicação usa — atingir qualquer uma delas derrubaria algo.
  ok("24. somente a role anon aparece", !/\b(authenticated|service_role|postgres|PUBLIC)\b/.test(exec1c1));
  ok(
    "25. somente SELECT/INSERT/UPDATE — nunca ALL nem DELETE/TRUNCATE",
    !/\bREVOKE\s+ALL\b/i.test(exec1c1) && !/\b(DELETE|TRUNCATE|TRIGGER|REFERENCES|MAINTAIN)\b/i.test(exec1c1)
  );
  ok("26. nenhum GRANT executavel", !/\bGRANT\b/i.test(exec1c1));
  ok("27. nenhum CASCADE", !/\bCASCADE\b/i.test(exec1c1));
  ok("28. nenhum ALTER DEFAULT PRIVILEGES", !/ALTER\s+DEFAULT\s+PRIVILEGES/i.test(exec1c1));
  ok(
    "29. nenhum ALTER TABLE / ENABLE|DISABLE RLS / POLICY",
    !/\bALTER\s+TABLE\b/i.test(exec1c1) &&
      !/ROW\s+LEVEL\s+SECURITY/i.test(exec1c1) &&
      !/\bPOLICY\b/i.test(exec1c1)
  );
  ok("30. nenhum CREATE ou DROP", !/\b(CREATE|DROP)\b/i.test(exec1c1));
  ok(
    "31. nenhum comando sobre sequences ou functions",
    !/\bSEQUENCES?\b/i.test(exec1c1) && !/\b(FUNCTIONS?|ROUTINES?)\b/i.test(exec1c1)
  );
  ok(
    "32. nao contem token, chave nem segredo",
    !/eyJ[A-Za-z0-9_-]{15,}/.test(sql1c1) &&
      !/-----BEGIN/.test(sql1c1) &&
      !/sbp_[a-f0-9]{20,}/.test(sql1c1)
  );
  // Nenhum mecanismo que rode sozinho ou escolha alvo em tempo de
  // execução: a migration precisa ser auditável por leitura.
  ok(
    "33. sem execucao automatica ou logica dinamica",
    !/\bDO\s*\$\$/i.test(exec1c1) &&
      !/\bEXECUTE\b/i.test(exec1c1) &&
      !/\bpg_catalog\b/i.test(exec1c1) &&
      !/information_schema/i.test(exec1c1) &&
      !/\bFOR\s+\w+\s+IN\b/i.test(exec1c1)
  );
  ok(
    "34. o rollback aparece SOMENTE como comentario",
    (sql1c1.match(/^--\s+GRANT SELECT, INSERT, UPDATE ON TABLE public\.[a-z_]+ TO anon;$/gm) ?? []).length === 10
  );
  ok(
    "35. documenta a baseline verificavel (hashes e contagens)",
    /067e72866cfdeb89b4ded45bb10794a9/.test(sql1c1) && /93/.test(sql1c1) && /30/.test(sql1c1)
  );
}

// ══════════════════════════════════════════════════════════════════════
// SEC-1c-3 — central_ia_consumo + as duas ESCRITAS de projeto
// ══════════════════════════════════════════════════════════════════════
// Diferente das anteriores, esta etapa tem lado de CÓDIGO: o REVOKE só
// é seguro porque um call site saiu do cliente anon. Se alguém reverter
// o código e mantiver a migration, a rota quebra em produção — por isso
// as guardas 36-42 travam o código, não só o SQL.
{
  const ROTA = "app/api/estudio-anuncios/projetos/[id]/route.ts";
  const rota = codigo(ROTA);

  // ── Os 3 call sites migrados ──────────────────────────────────────
  ok(
    "36. montarResultadoProjeto recebe service_role nos DOIS argumentos",
    /montarResultadoProjeto\(getSupabaseServidor\(\), getSupabaseServidor\(\), params\.id\)/.test(rota)
  );
  ok(
    "37. editarProjeto (UPDATE) recebe service_role",
    /editarProjeto\(getSupabaseServidor\(\), userId, params\.id, validacao\.dados\)/.test(rota)
  );
  ok(
    "38. cancelarProjetoLogicamente (UPDATE) recebe service_role",
    /cancelarProjetoLogicamente\(getSupabaseServidor\(\), userId, params\.id\)/.test(rota)
  );

  // ── O isolamento de tenant NÃO pode ter saído junto com a role ────
  // Este é o assert que impede a troca de virar bypass: as duas escritas
  // se protegem pelo par (id, user_id) DENTRO do UPDATE, não pelo
  // privilégio da role. Perder isso com service_role seria catastrófico.
  const projetos = codigo("lib/estudio-anuncios/projetos.ts");
  const corpo = (nome: string) => {
    const i = projetos.indexOf(`export async function ${nome}`);
    if (i < 0) return "";
    const resto = projetos.slice(i + 1);
    const j = resto.indexOf("\nexport ");
    return resto.slice(0, j < 0 ? undefined : j);
  };
  ok(
    "39. editarProjeto mantem .eq(\"id\") + .eq(\"user_id\") na escrita",
    /\.eq\("id", id\)/.test(corpo("editarProjeto")) &&
      /\.eq\("user_id", userId\)/.test(corpo("editarProjeto")) &&
      /\.update\(/.test(corpo("editarProjeto"))
  );
  ok(
    "40. cancelarProjetoLogicamente mantem .eq(\"id\") + .eq(\"user_id\")",
    /\.eq\("id", id\)/.test(corpo("cancelarProjetoLogicamente")) &&
      /\.eq\("user_id", userId\)/.test(corpo("cancelarProjetoLogicamente")) &&
      /\.update\(/.test(corpo("cancelarProjetoLogicamente"))
  );

  // `userId` de sessão, nunca do payload — se viesse do body, o par
  // (id, user_id) seria escolhido pelo atacante e não protegeria nada.
  ok(
    "41. PATCH e DELETE derivam userId de autenticarRequisicao",
    (rota.match(/const auth = await autenticarRequisicao\(request\);/g) ?? []).length === 3 &&
      (rota.match(/const userId = auth\.autenticado \? auth\.uid : null;/g) ?? []).length === 3 &&
      !/userId\s*=\s*(body|corpo|payload|searchParams)/.test(rota)
  );

  // ── A troca é call-site-level, não substituição global ────────────
  ok(
    // O limiar era `>= 8` — um SNAPSHOT de quantos call sites anon esta
    // rota tinha na SEC-1c-3, não o invariante. A SEC-1c-4 migrou mais
    // dois legitimamente e o assert reprovou por SUCESSO da frente.
    // O invariante real é "não houve substituição global do cliente":
    // ele continua declarado E continua servindo alguém. Isso ainda
    // reprova a limpeza oportunista proibida, e deixa de reprovar cada
    // migração futura de call site. A regex também passa a tolerar
    // espaço — a estrita perdia chamadas multilinha.
    "42. o cliente anon da rota PERMANECE para os demais call sites",
    /^const supabase = createClient\(/m.test(rota) &&
      (rota.match(/\w+\(\s*supabase\s*[,)]/g) ?? []).length > 0
  );

  // ── A migration ───────────────────────────────────────────────────
  const MIG_1C3 = "supabase/migrations/20260914_sec1c3_revogar_anon_central_ia_consumo.sql";
  let sql3 = "";
  let existe3 = true;
  try {
    sql3 = fonte(MIG_1C3);
  } catch {
    existe3 = false;
  }
  const exec3 = sql3.replace(/--.*$/gm, "");
  const st3 = exec3.split(";").map((s) => s.trim()).filter(Boolean);

  ok("43. a migration SEC-1c-3 existe", existe3);
  ok("44. tem exatamente UM statement executavel", st3.length === 1);
  ok(
    "45. o statement e o REVOKE exato em central_ia_consumo",
    /^REVOKE SELECT, INSERT, UPDATE ON TABLE public\.central_ia_consumo FROM anon$/i.test(
      (st3[0] ?? "").replace(/\s+/g, " ")
    )
  );
  ok("46. nenhuma OUTRA tabela no SQL executavel", (exec3.match(/public\.[a-z_]+/g) ?? []).length === 1);
  ok("47. nenhum GRANT executavel", !/\bGRANT\b/i.test(exec3));
  ok("48. somente a role anon", !/\b(authenticated|service_role|postgres|PUBLIC)\b/.test(exec3));
  ok(
    "49. nenhum ALTER DEFAULT PRIVILEGES / ALTER TABLE / CASCADE / CREATE / DROP",
    !/ALTER\s+DEFAULT\s+PRIVILEGES/i.test(exec3) &&
      !/\bALTER\s+TABLE\b/i.test(exec3) &&
      !/\bCASCADE\b/i.test(exec3) &&
      !/\b(CREATE|DROP)\b/i.test(exec3)
  );
  ok(
    "50. nao contem token, chave nem segredo",
    !/eyJ[A-Za-z0-9_-]{15,}/.test(sql3) && !/-----BEGIN/.test(sql3) && !/sbp_[a-f0-9]{20,}/.test(sql3)
  );
  ok(
    "51. o rollback aparece SOMENTE como comentario",
    /^--\s+GRANT SELECT, INSERT, UPDATE ON TABLE public\.central_ia_consumo TO anon;$/m.test(sql3)
  );
}

// ══════════════════════════════════════════════════════════════════════
// SEC-1c-4 — cadeia exportacao/compliance: 7 call sites, 4 tabelas
// ══════════════════════════════════════════════════════════════════════
// A maior desta frente até aqui. O risco específico é sutil: várias
// dessas funções recebem DOIS clientes — o 1º migra para service_role,
// o 2º/3º/4º JÁ era service_role e não pode ser mexido. Perder um
// desses argumentos não quebra o build; quebra o hash de compliance em
// silêncio, e todo parecer passa a parecer desatualizado.
{
  const B = "app/api/estudio-anuncios/projetos/[id]";
  const CALL_SITES: Array<[string, string, RegExp]> = [
    ["1. exportacao → montarItensIncluidos", `${B}/exportacao/route.ts`,
      /montarItensIncluidos\(getSupabaseServidor\(\), params\.id, projeto\.nome_produto\)/],
    ["2. [id] → listarPacotesDoProjeto", `${B}/route.ts`,
      /listarPacotesDoProjeto\(getSupabaseServidor\(\), params\.id\)/],
    ["3. [id] → buscarComplianceDoProjeto (+4o srv preservado)", `${B}/route.ts`,
      /buscarComplianceDoProjeto\(getSupabaseServidor\(\), params\.id, projeto\.nome_produto, getSupabaseServidor\(\)\)/],
    ["4. arquivo → buscarPacoteDoProjeto", `${B}/exportacao/[pacoteId]/arquivo/route.ts`,
      /buscarPacoteDoProjeto\(getSupabaseServidor\(\), params\.id, params\.pacoteId\)/],
    ["5. publicar → buscarComplianceDoProjeto (+`servico` preservado)", `${B}/marketplaces/[marketplace]/publicar/route.ts`,
      /buscarComplianceDoProjeto\(getSupabaseServidor\(\), params\.id, projeto\.nome_produto, servico\)/],
    ["6. validacao-oficial → buscarComplianceDoProjeto (+4o srv)", `${B}/marketplaces/[marketplace]/validacao-oficial/route.ts`,
      /buscarComplianceDoProjeto\(getSupabaseServidor\(\), params\.id, projeto\.nome_produto, getSupabaseServidor\(\)\)/],
    ["7. compliance → montarEntradaCompliance (+3o srv preservado)", `${B}/compliance/[marketplace]/route.ts`,
      /montarEntradaCompliance\(\s*getSupabaseServidor\(\),\s*\{[^}]*\},\s*getSupabaseServidor\(\)\s*\)/],
  ];

  let n = 52;
  for (const [rotulo, arq, re] of CALL_SITES) {
    ok(`${n}. ${rotulo}`, re.test(codigo(arq)));
    n++;
  }

  // Nenhum dos 7 pode voltar a passar `supabase` como 1o argumento.
  const FNS = ["montarItensIncluidos", "listarPacotesDoProjeto", "buscarComplianceDoProjeto",
               "buscarPacoteDoProjeto", "montarEntradaCompliance"];
  const ARQS = [`${B}/exportacao/route.ts`, `${B}/route.ts`,
                `${B}/exportacao/[pacoteId]/arquivo/route.ts`,
                `${B}/marketplaces/[marketplace]/publicar/route.ts`,
                `${B}/marketplaces/[marketplace]/validacao-oficial/route.ts`,
                `${B}/compliance/[marketplace]/route.ts`];
  ok(
    "59. nenhuma das 5 funcoes recebe `supabase` como 1o argumento",
    ARQS.every((a) => {
      const c = codigo(a);
      return FNS.every((f) => !new RegExp(`${f}\\(\\s*supabase\\s*[,)]`).test(c));
    })
  );

  // Limpeza oportunista é proibida: o cliente anon segue servindo os
  // outros call sites de cada rota.
  ok(
    "60. o cliente anon PERMANECE nas rotas que ainda o usam",
    ARQS.every((a) => {
      const c = codigo(a);
      const declara = /^const supabase = createClient\(/m.test(c);
      const usa = (c.match(/\w+\(\s*supabase\s*[,)]/g) ?? []).length > 0;
      return declara && usa;
    })
  );

  // ── As libs NÃO mudaram: assinaturas e filtros idênticos ──────────
  const comp = codigo("lib/estudio-anuncios/compliance/compliance.ts");
  const expo = codigo("lib/estudio-anuncios/exportacao.ts");

  ok(
    "61. buscarComplianceDoProjeto continua filtrando projeto_id",
    /from\("estudio_anuncios_compliance_marketplace"\)[\s\S]{0,200}\.eq\("projeto_id", projetoId\)/.test(comp)
  );
  ok(
    "62. montarEntradaCompliance: projetos_marketplace por projeto_id + marketplace",
    /from\("estudio_anuncios_projetos_marketplace"\)[\s\S]{0,700}\.eq\("projeto_id", projetoId\)[\s\S]{0,120}\.eq\("marketplace", marketplace\)/.test(comp)
  );
  ok(
    "63. montarEntradaCompliance: conteudo_versoes por projeto_marketplace_id + aprovado",
    /from\("estudio_anuncios_conteudo_versoes"\)[\s\S]{0,400}\.eq\("projeto_marketplace_id"[\s\S]{0,200}\.eq\("aprovado"/.test(comp)
  );
  ok(
    "64. montarEntradaCompliance: imagens_geradas por projeto_id",
    /from\("estudio_anuncios_imagens_geradas"\)[\s\S]{0,400}\.eq\("projeto_id", projetoId\)/.test(comp)
  );
  ok(
    "65. montarEntradaCompliance: entradas_produto por projeto_id",
    /from\("estudio_anuncios_entradas_produto"\)[\s\S]{0,400}\.eq\("projeto_id", projetoId\)/.test(comp)
  );
  // Assinaturas intactas — a PR troca ARGUMENTO, nunca contrato.
  ok(
    "66. assinaturas das libs inalteradas (1o param segue `supabase`)",
    /export async function buscarComplianceDoProjeto\(\s*supabase: SupabaseClient/.test(comp) &&
      /export async function montarEntradaCompliance\(\s*supabase: SupabaseClient/.test(comp) &&
      /export async function montarItensIncluidos\(\s*supabase: SupabaseClient/.test(expo) &&
      /export async function listarPacotesDoProjeto\(\s*supabase: SupabaseClient/.test(expo) &&
      /export async function buscarPacoteDoProjeto\(\s*supabase: SupabaseClient/.test(expo)
  );

  // ── A migration ───────────────────────────────────────────────────
  const MIG_1C4 = "supabase/migrations/20260915_sec1c4_revogar_anon_cadeia_exportacao_compliance.sql";
  const QUATRO = [
    "estudio_anuncios_compliance_marketplace",
    "estudio_anuncios_entradas_produto",
    "estudio_anuncios_imagens_geradas",
    "estudio_anuncios_pacotes_exportacao",
  ];
  let sql4 = "";
  let existe4 = true;
  try {
    sql4 = fonte(MIG_1C4);
  } catch {
    existe4 = false;
  }
  const exec4 = sql4.replace(/--.*$/gm, "");
  const st4 = exec4.split(";").map((s) => s.trim()).filter(Boolean);
  const FORMA4 = /^REVOKE SELECT, INSERT, UPDATE ON TABLE public\.([a-z_]+) FROM anon$/;
  const cas4 = st4.map((s) => FORMA4.exec(s.replace(/\s+/g, " ")));

  ok("67. a migration SEC-1c-4 existe", existe4);
  ok("68. tem exatamente 4 statements executaveis", st4.length === 4);
  ok("69. todos na forma canonica exata", cas4.length === 4 && cas4.every(Boolean));
  ok(
    "70. atinge EXATAMENTE as 4 tabelas autorizadas, sem repetir",
    JSON.stringify(cas4.filter(Boolean).map((m) => m![1]).sort()) === JSON.stringify(QUATRO)
  );
  ok("71. somente a role anon", !/\b(authenticated|service_role|postgres|PUBLIC)\b/.test(exec4));
  ok(
    "72. somente SELECT/INSERT/UPDATE — nunca ALL nem DELETE/TRUNCATE",
    !/\bREVOKE\s+ALL\b/i.test(exec4) && !/\b(DELETE|TRUNCATE|TRIGGER|REFERENCES|MAINTAIN)\b/i.test(exec4)
  );
  ok(
    "73. sem GRANT, CASCADE, ALTER DEFAULT PRIVILEGES, ALTER TABLE, CREATE/DROP",
    !/\bGRANT\b/i.test(exec4) && !/\bCASCADE\b/i.test(exec4) &&
      !/ALTER\s+DEFAULT\s+PRIVILEGES/i.test(exec4) && !/\bALTER\s+TABLE\b/i.test(exec4) &&
      !/\b(CREATE|DROP)\b/i.test(exec4)
  );
  ok(
    "74. sem SQL dinamico",
    !/\bDO\s*\$\$/i.test(exec4) && !/\bEXECUTE\b/i.test(exec4) &&
      !/information_schema/i.test(exec4) && !/\bpg_catalog\b/i.test(exec4)
  );
  ok(
    "75. nao contem token, chave nem segredo",
    !/eyJ[A-Za-z0-9_-]{15,}/.test(sql4) && !/-----BEGIN/.test(sql4) && !/sbp_[a-f0-9]{20,}/.test(sql4)
  );
  ok(
    "76. rollback SOMENTE como comentario, 4 linhas",
    (sql4.match(/^--\s+GRANT SELECT, INSERT, UPDATE ON TABLE public\.[a-z_]+ TO anon;$/gm) ?? []).length === 4
  );
}

console.log(`\n${falhou === 0 ? "✓" : "✗"} DEFAULT-PRIVILEGES-SEC1 — ${passou} passaram, ${falhou} falharam`);
process.exit(falhou === 0 ? 0 : 1);
