/**
 * Cliente Supabase com service_role — EXCLUSIVO de código server-only.
 *
 * Usado por app/api/estudio-anuncios/projetos/route.ts (POST) para
 * chamar a RPC restrita criar_projeto_estudio_anuncios() — a única
 * operação deste módulo que exige service_role (EXECUTE revogado de
 * anon/authenticated, ver
 * supabase/migrations/20260804_criar_projeto_estudio_anuncios_rpc.sql).
 *
 * REGRAS (não violar):
 * - Nunca importar este módulo de um Client Component ("use client")
 *   nem de qualquer arquivo que possa entrar no bundle do browser —
 *   só de route handlers (app/api/**\/route.ts), que já são
 *   server-only por definição do Next.js App Router.
 * - Nunca logar, retornar em resposta HTTP, ou de qualquer outra forma
 *   expor SUPABASE_SERVICE_ROLE_KEY.
 * - Usar exclusivamente para a chamada da RPC restrita — qualquer
 *   outra leitura/escrita deste módulo continua no cliente anon comum.
 *
 * O cliente é criado sob demanda (getSupabaseServidor()), não como
 * singleton de escopo de módulo — assim, ausência de variável de
 * ambiente falha de forma controlada e explícita no momento do uso,
 * em vez de falhar de forma confusa/silenciosa no import do módulo.
 *
 * ── `import "server-only"` — LOJAS-ANON-SELECT ──────────────────────
 * Até esta frente, "server-only" aqui era CONVENÇÃO: um comentário
 * afirmando que o App Router garante o isolamento. Convenção não é
 * barreira. Este módulo instancia a `service_role` — a credencial mais
 * privilegiada do projeto, e a única capaz de ler `access_token`,
 * `refresh_token` e `partner_key` de todos os tenants.
 *
 * O import abaixo transforma a afirmação em erro de compilação: se um
 * componente `"use client"` importar este arquivo, ainda que
 * indiretamente, o build QUEBRA em vez de embarcar a chave no bundle do
 * browser. É exatamente o modo de falha que esta frente existe para
 * fechar, e ele não pode depender de ninguém lembrar da regra.
 */
import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export function getSupabaseServidor(): SupabaseClient {
  // A URL não é segredo (mesmo valor do cliente anon) — reaproveitada
  // do prefixo NEXT_PUBLIC_ de propósito, por instrução explícita. A
  // chave, sim, é segredo, e NUNCA deve ter esse prefixo.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL ausente — não é possível criar o cliente Supabase de servidor.");
  }
  if (!chave) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY ausente — não é possível criar o cliente Supabase de servidor.");
  }

  return createClient(url, chave);
}
