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

console.log(`\n${falhou === 0 ? "✓" : "✗"} DEFAULT-PRIVILEGES-SEC1a — ${passou} passaram, ${falhou} falharam`);
process.exit(falhou === 0 ? 0 : 1);
