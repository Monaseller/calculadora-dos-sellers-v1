/**
 * GET /api/admin/backfill-resumos-diarios
 *
 * Recalcula `dashboard_resumos_diarios` para UM dia, a partir de `pedidos`
 * já existente no banco. NÃO chama nenhuma API de marketplace — só lê e
 * escreve no Supabase (regra aprovada 2026-07-10, Parte 7 do backfill).
 *
 * Rota operacional, não exposta em tela/menu — gated pela sessão (autenticarRequisicao),
 * mesmo padrão dos outros endpoints /api/admin/*.
 *
 * Query params:
 *   data         - YYYY-MM-DD (obrigatório): dia a recalcular.
 *   marketplace  - opcional: filtra só um marketplace (ex.: "Shopee").
 *   conta        - opcional: filtra só uma conta.
 *
 * Sem marketplace/conta, recalcula para TODAS as lojas do usuário que
 * tiverem pelo menos 1 pedido com data_pagamento OU data_criacao = data.
 * Cada loja recalcula os dois tipo_data (pagamento e criação) — chamada
 * idempotente, sempre substitui o dia inteiro (nunca soma incremental).
 *
 * Descoberta reescrita em 2026-07-28 (Fase 3 — achado real de timeout em
 * produção, ver docs/BUGS.md): a versão anterior filtrava só por user_id e
 * fazia OR entre data_pagamento/data_criacao — sem marketplace nem loja_id
 * como Index Cond, o Postgres precisava varrer boa parte dos ~375 mil
 * pedidos do usuário pra achar 1 dia (mesma classe de bug da auditoria
 * original do filtro manual de datas). Retry sozinho não resolve — a query
 * é estruturalmente não-sargável, não é falha transitória.
 *
 * Nova estratégia (2 queries sargáveis + 1 cross-check, sem N+1 por loja):
 *   1. DISTINCT loja_id em pedidos, intervalo [data, data+1) de
 *      data_pagamento, usando idx_pedidos_data_pagamento_loja
 *      (data_pagamento, loja_id) WHERE loja_id IS NOT NULL.
 *   2. Mesma coisa para data_criacao, usando idx_pedidos_data_criacao_loja.
 *   3. Os loja_id são unidos via Set (sem user_id ainda — ver nota abaixo)
 *      e só então cruzados com `lojas WHERE user_id=? AND id = ANY(...)`
 *      pra pegar marketplace/nickname e, nesse mesmo passo, garantir que
 *      só lojas do usuário da sessão entram no resultado final. Não há
 *      vazamento entre usuários: nenhum loja_id de outro usuário passa do
 *      cross-check de `lojas`, mesmo que apareça nas duas primeiras
 *      queries (que são globais de propósito, pra poder usar um índice
 *      com a data como coluna líder).
 *
 * Efeito colateral aceito: a contagem "pedidos_sem_loja_id_ignorados" (Fase
 * 1) foi removida — contá-la exigiria escanear pedidos com loja_id NULL
 * nesse intervalo, reintroduzindo uma busca não-sargável (os índices novos
 * são parciais, WHERE loja_id IS NOT NULL, não cobrem essa contagem). Era
 * só diagnóstico, não afeta correção do recálculo.
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { autenticarRequisicao } from "@/lib/autenticacao";
import { atualizarResumoDia } from "@/lib/resumos-diarios";
import { listarLojasDoDonoPorIds } from "@/lib/marketplace/credenciais";

export const maxDuration = 60;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

/** Soma 1 dia a uma data YYYY-MM-DD, sem depender de timezone do ambiente. */
function proximoDiaISO(iso: string): string {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split("T")[0];
}

export async function GET(request: Request) {
  const auth = await autenticarRequisicao(request);
  const userId = auth.autenticado ? auth.uid : null;
  if (!userId) {
    return NextResponse.json({ erro: true, mensagem: "Sessao invalida." }, { status: 401 });
  }

  const url = new URL(request.url);
  const data = url.searchParams.get("data");
  if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data)) {
    return NextResponse.json({ ok: false, erro: "Parametro 'data' obrigatorio, formato YYYY-MM-DD." }, { status: 400 });
  }

  const marketplaceParam = url.searchParams.get("marketplace");
  const contaParam = url.searchParams.get("conta");
  const proximoDia = proximoDiaISO(data);

  // Query 1: lojas com pedido no intervalo, por data_pagamento.
  const { data: porPagamento, error: errPagamento } = await supabase
    .from("pedidos")
    .select("loja_id")
    .gte("data_pagamento", data)
    .lt("data_pagamento", proximoDia)
    .not("loja_id", "is", null);

  if (errPagamento) {
    return NextResponse.json({ ok: false, erro: "Erro ao buscar lojas por data_pagamento: " + errPagamento.message }, { status: 500 });
  }

  // Query 2: idem, por data_criacao.
  const { data: porCriacao, error: errCriacao } = await supabase
    .from("pedidos")
    .select("loja_id")
    .gte("data_criacao", data)
    .lt("data_criacao", proximoDia)
    .not("loja_id", "is", null);

  if (errCriacao) {
    return NextResponse.json({ ok: false, erro: "Erro ao buscar lojas por data_criacao: " + errCriacao.message }, { status: 500 });
  }

  const lojaIdsUnicos = Array.from(new Set([
    ...(porPagamento ?? []).map(r => r.loja_id as string),
    ...(porCriacao ?? []).map(r => r.loja_id as string),
  ]));

  if (lojaIdsUnicos.length === 0) {
    return NextResponse.json({ ok: true, data, lojas_encontradas: 0, resultado: [] });
  }

  // Query 3: cross-check com `lojas` — só aqui o resultado é escopado ao
  // usuário da sessão (segurança multi-tenant), e é onde pegamos
  // marketplace/nickname pra gravar no resumo.
  // LOJAS-ANON-SELECT: era leitura com o cliente ANON. Os dois filtros
  // condicionais viraram opcoes da capability; o escopo por `user_id`
  // continua dentro da consulta.
  const { linhas: lojasDoUsuario, erro: errLojas } = await listarLojasDoDonoPorIds(
    userId,
    lojaIdsUnicos,
    { marketplace: marketplaceParam, nickname: contaParam }
  );
  if (errLojas) {
    return NextResponse.json({ ok: false, erro: "Erro ao cruzar lojas do usuário." }, { status: 500 });
  }

  const resultado: any[] = [];
  for (const loja of (lojasDoUsuario ?? []) as { id: string; marketplace: string; nickname: string | null }[]) {
    const conta = loja.nickname ?? "";
    try {
      await atualizarResumoDia(userId, loja.id, loja.marketplace, conta, "pagamento", data);
      await atualizarResumoDia(userId, loja.id, loja.marketplace, conta, "criacao", data);
      resultado.push({ lojaId: loja.id, marketplace: loja.marketplace, conta, ok: true });
    } catch (err: any) {
      resultado.push({ lojaId: loja.id, marketplace: loja.marketplace, conta, ok: false, erro: err?.message ?? String(err) });
    }
  }

  return NextResponse.json({
    ok: true,
    data,
    lojas_encontradas: resultado.length,
    resultado,
  });
}
