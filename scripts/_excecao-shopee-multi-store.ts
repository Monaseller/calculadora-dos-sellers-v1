/**
 * SHOPEE MULTI-STORE V1/V1B — excecao EXATA dos guards para os fluxos legados
 * Shopee com loja EXPLICITA (nenhum fluxo escolhe "a loja mais recente").
 *
 * Camada SOBRE as excecoes multi-app (scripts/_excecao-shopee-multi-app.ts) e
 * UX (scripts/_excecao-shopee-ux.ts): cada arquivo abaixo so passa se,
 * revertendo EXATAMENTE os hunks multi-loja aprovados (gerados do diff contra
 * 5fdb51f), o resultado for BYTE-IDENTICO ao blob de 5fdb51f — que ja contem
 * as camadas multi-app e UX aprovadas — e se o arquivo na base do guard for
 * um blob ja aprovado (pinado abaixo: o de 5fdb51f e os das bases dos guards
 * e das camadas anteriores). Sem curinga: arquivo fora da lista segue travado.
 *
 * NOVOS, so com o conteudo EXATO (sha256, forma LF) e so se nao existiam na
 * base do guard: lib/shopee-loja-selecao.ts, scripts/testar-shopee-multi-store.ts
 * e este helper (auto-pin).
 *
 * OAuth core (rotas start/callback/apps, shopee-apps, shopee-oauth-estado,
 * shopee-auth), canonico (coordenador/worker/intraday/leitores), Dashboard,
 * formulas financeiras e Configuracoes seguem travados.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const BASE_SHOPEE_MULTI_STORE = "5fdb51f";
export const HELPER_SHOPEE_MULTI_STORE = "scripts/_excecao-shopee-multi-store.ts";

const SHA256_NOVOS: Record<string, string> = {
  "lib/shopee-loja-selecao.ts": "ea78214e216b638546eadf5c45597297e18b4db78bd1d397f7e10e246a526885",
  "scripts/testar-shopee-multi-store.ts": "393ecfbffb727e474044c93805bcc07dd484fabd4c115444b012799994921ed0"
};
const SHA256_HELPER_SHOPEE_MULTI_STORE = "e37fed5b98bf6468c3ad8b365b59a995f5d3e67970d3d0ac098342e62ccf6354";
const BLOBS_BASE_APROVADOS: Record<string, string[]> = {
  "lib/sync-shopee.ts": [
    "d4eddf41a2da86ebebd87bd04c1e085c70a95e59"
  ],
  "app/api/sync/route.ts": [
    "46b4270accf897c16761289a4f23f053ebcec557"
  ],
  "app/api/sync/manual/route.ts": [
    "3dde8b3cb63761c3c6e82c1661bf83936505f76f"
  ],
  "app/api/shopee/vendas/route.ts": [
    "3ff91e8bf37b7b5d13f7212dca5cc27e7b90a0c9"
  ],
  "app/api/shopee/importar-anuncios/route.ts": [
    "1c9a7c70445ba05b11f5cfeb303cc05eb6299d49"
  ],
  "app/api/admin/shopee/backfill-pedidos-0707/route.ts": [
    "1e6da7e39c9f939e8761647a0cafa8b9500d8d4d"
  ],
  "app/api/admin/shopee/reconciliar-financeiro/route.ts": [
    "132eb623a2263d55cf47995fafd1c6def6eec0d3"
  ],
  "app/api/admin/shopee/status/route.ts": [
    "9ee8025c1bd669ddc9958b3a7c820e93e817a64b"
  ],
  "app/(app)/anuncios/page.tsx": [
    "e0f1e85af8ad4f8ddfc15ec855e486711458d4af"
  ]
};
const PATCH: Record<string, { base: string; novo: string }[]> = {
  "lib/sync-shopee.ts": [
    {
      "base": "import { obterFaixaShopee, TAXA_CAMPANHA_SHOPEE } from \"@/lib/comissoes-shopee\";\nimport { getShopeeLojaAtiva } from \"@/lib/shopee-auth\";\nimport { LojaIdIntegrityError } from \"@/lib/sync-errors\";",
      "novo": "import { obterFaixaShopee, TAXA_CAMPANHA_SHOPEE } from \"@/lib/comissoes-shopee\";\nimport { LojaIdIntegrityError } from \"@/lib/sync-errors\";"
    },
    {
      "base": "  // A loja e resolvida AQUI e repassada, para nao consultar duas vezes.\n  const loja = lojaOverride ?? await getShopeeLojaAtiva(userId);\n  if (!loja) return RESULTADO_VAZIO();\n",
      "novo": "  // A loja e resolvida AQUI e repassada, para nao consultar duas vezes.\n  // MULTI-LOJA V1: a loja e OBRIGATORIA — nenhum fallback para \"a mais recente\" do dono.\n  const loja = lojaOverride;\n  if (!loja) return { ...RESULTADO_VAZIO(), syncIncompleto: true, motivoFalha: \"loja_obrigatoria\" };\n"
    },
    {
      "base": "): Promise<SyncShopeeResult> {\n  const loja = lojaOverride ?? await getShopeeLojaAtiva(userId);\n  if (!loja) return { found: 0, inserted: 0, upsertErrors: 0, resumoAtualizado: false, resumoPendente: false, diasAfetados: 0, motivoResumoPendente: null };\n",
      "novo": "): Promise<SyncShopeeResult> {\n  // MULTI-LOJA V1: a loja e OBRIGATORIA — nenhum fallback para \"a mais recente\" do dono.\n  const loja = lojaOverride;\n  if (!loja) return { found: 0, inserted: 0, upsertErrors: 0, resumoAtualizado: false, resumoPendente: false, diasAfetados: 0, motivoResumoPendente: null, syncIncompleto: true, motivoFalha: \"loja_obrigatoria\" };\n"
    }
  ],
  "app/api/sync/route.ts": [
    {
      "base": "import { syncShopeeForUserV2 } from \"@/lib/sync-shopee\";\nimport { listarLojasAtivasParaCron } from \"@/lib/marketplace/credenciais\";",
      "novo": "import { syncShopeeForUserV2 } from \"@/lib/sync-shopee\";\nimport { getShopeeLojaById } from \"@/lib/shopee-auth\";\nimport { lojasShopeeAtivasDoDono } from \"@/lib/shopee-loja-selecao\";\nimport { listarLojasAtivasParaCron } from \"@/lib/marketplace/credenciais\";"
    },
    {
      "base": "      //\n      // `undefined` em `lojaOverride` é deliberado e igual ao de antes:\n      // o cron não escolhe loja, quem resolve é `getShopeeLojaAtiva`.\n      marketplaces.has(\"Shopee\")\n        ? syncShopeeForUserV2(userId, ontem, hoje, false, undefined, { modo: \"incremental\" })\n            .then(r  => { results[userId].shopee = r.inserted; })\n            .catch(e => { results[userId].shopee_err = String(e?.message ?? e); })",
      "novo": "      //\n      // MULTI-LOJA V1: acao GLOBAL ao dono → enumera TODAS as lojas Shopee\n      // ativas e sincroniza CADA UMA explicitamente (nunca \"a mais recente\").\n      // Em SEQUENCIA (sem concorrencia nova); falha de uma loja fica registrada\n      // nela e nao pula as outras.\n      marketplaces.has(\"Shopee\")\n        ? sincronizarTodasAsLojasShopee(userId, ontem, hoje)\n            .then(r  => { results[userId].shopee = r.inserted; results[userId].shopee_lojas = r.porLoja; })\n            .catch(e => { results[userId].shopee_err = String(e?.message ?? e); })"
    },
    {
      "base": "}",
      "novo": "}\n\n/** Nightly multi-loja: cada loja Shopee ATIVA do dono, explicitamente, uma por vez. */\nasync function sincronizarTodasAsLojasShopee(userId: string, ontem: string, hoje: string) {\n  const lojas = await lojasShopeeAtivasDoDono(userId);\n  if (lojas === null) throw new Error(\"leitura_lojas_falhou\");\n  const porLoja: Record<string, number | string> = {};\n  let inserted = 0;\n  for (const l of lojas) {\n    try {\n      const loja = await getShopeeLojaById(l.id, userId);\n      if (!loja) { porLoja[l.id] = \"credencial_indisponivel\"; continue; }\n      const r = await syncShopeeForUserV2(userId, ontem, hoje, false, loja, { modo: \"incremental\" });\n      porLoja[l.id] = r.inserted; inserted += r.inserted;\n    } catch (e: any) {\n      porLoja[l.id] = `erro:${String(e?.message ?? e).slice(0, 80)}`;\n    }\n  }\n  return { inserted, porLoja };\n}"
    }
  ],
  "app/api/sync/manual/route.ts": [
    {
      "base": "import { NextResponse } from \"next/server\";\nimport { autenticarRequisicao } from \"@/lib/autenticacao\";\nimport { getShopeeLojaAtiva } from \"@/lib/shopee-auth\";\nimport { getMLLojaAtiva } from \"@/lib/ml-auth\";",
      "novo": "import { NextResponse } from \"next/server\";\nimport { autenticarRequisicao, lerCookie } from \"@/lib/autenticacao\";\nimport { getShopeeLojaById } from \"@/lib/shopee-auth\";\nimport { NOME_COOKIE_LOJA_SHOPEE, selecionarLojaShopee } from \"@/lib/shopee-loja-selecao\";\nimport { getMLLojaAtiva } from \"@/lib/ml-auth\";"
    },
    {
      "base": "\n  try {",
      "novo": "\n  // MULTI-LOJA V1: Shopee so na loja EXPLICITA (body.loja_id) ou no \"Usar esta\" re-conferido,\n  // ou na UNICA ativa — nunca \"a mais recente\". Ambiguidade vira STORE_SELECTION_REQUIRED.\n  const lojaShopee = async () => {\n    const sel = await selecionarLojaShopee(userId, {\n      lojaIdExplicito: (body as { loja_id?: string }).loja_id ?? null, lojaIdCookie: lerCookie(request, NOME_COOKIE_LOJA_SHOPEE), usarCookie: true,\n    });\n    if (!sel.ok) { if (sel.motivo !== \"SEM_LOJA_SHOPEE\") results.shopeeErro = sel.motivo; return null; }\n    return getShopeeLojaById(sel.lojaId, userId);\n  };\n\n  try {"
    },
    {
      "base": "      (marketplace === \"todos\" || marketplace === \"Shopee\")\n        ? getShopeeLojaAtiva(userId)\n            .then(loja => {\n              if (!loja) { results.shopeeErro = \"Shopee não conectada\"; return; }\n              // Timeout global 55s: máximo seguro no Vercel Hobby (maxDuration=60).",
      "novo": "      (marketplace === \"todos\" || marketplace === \"Shopee\")\n        ? lojaShopee()\n            .then(loja => {\n              if (!loja) { results.shopeeErro = results.shopeeErro ?? \"Shopee não conectada\"; return; }\n              // Timeout global 55s: máximo seguro no Vercel Hobby (maxDuration=60)."
    }
  ],
  "app/api/shopee/vendas/route.ts": [
    {
      "base": "import { getSupabaseServidor } from \"@/lib/estudio-anuncios/supabase-servidor\";\nimport { autenticarRequisicao } from \"@/lib/autenticacao\";\nimport { getShopeeLojaAtiva } from \"@/lib/shopee-auth\";\nimport { syncShopeeForUserV2 } from \"@/lib/sync-shopee\";",
      "novo": "import { getSupabaseServidor } from \"@/lib/estudio-anuncios/supabase-servidor\";\nimport { autenticarRequisicao, lerCookie } from \"@/lib/autenticacao\";\nimport { getShopeeLojaById } from \"@/lib/shopee-auth\";\nimport { corpoSelecaoRecusada, NOME_COOKIE_LOJA_SHOPEE, selecionarLojaShopee } from \"@/lib/shopee-loja-selecao\";\nimport { syncShopeeForUserV2 } from \"@/lib/sync-shopee\";"
    },
    {
      "base": "\n  // Verifica conexão Shopee\n  const loja = await getShopeeLojaAtiva(userId);\n  if (!loja) {",
      "novo": "\n  // MULTI-LOJA V1: a loja e EXPLICITA (?loja_id=) ou o \"Usar esta\" re-conferido no\n  // servidor, ou a UNICA loja Shopee ativa — nunca \"a mais recente\". Leitura e\n  // sync ficam restritos a ELA (nada de outra loja do mesmo dono aparece aqui).\n  const selecao = await selecionarLojaShopee(userId, {\n    lojaIdExplicito: searchParams.get(\"loja_id\"), lojaIdCookie: lerCookie(request, NOME_COOKIE_LOJA_SHOPEE), usarCookie: true,\n  });\n  if (!selecao.ok) {\n    if (selecao.motivo === \"SEM_LOJA_SHOPEE\") return NextResponse.json({ erro: true, semConexao: true, mensagem: \"Conta Shopee não conectada.\" });\n    const { status, corpo } = corpoSelecaoRecusada(selecao);\n    return NextResponse.json(corpo, { status });\n  }\n  const lojaId = selecao.lojaId;\n  const loja = await getShopeeLojaById(lojaId, userId);\n  if (!loja) {"
    },
    {
      "base": "      const syncFrom = dateFrom > ontemISO ? dateFrom : ontemISO;\n      const r = await syncShopeeForUserV2(userId, syncFrom, hoje, true); // noBuffer=true → create_time\n      resumoSyncInfo = {",
      "novo": "      const syncFrom = dateFrom > ontemISO ? dateFrom : ontemISO;\n      const r = await syncShopeeForUserV2(userId, syncFrom, hoje, true, loja); // noBuffer=true → create_time\n      resumoSyncInfo = {"
    },
    {
      "base": "        .from(\"pedidos\").select(\"synced_at\")\n        .eq(\"user_id\", userId).eq(\"marketplace\", \"Shopee\")\n        .or(`data_criacao.eq.${hoje},data_pagamento.eq.${hoje}`)",
      "novo": "        .from(\"pedidos\").select(\"synced_at\")\n        .eq(\"user_id\", userId).eq(\"marketplace\", \"Shopee\").eq(\"loja_id\", lojaId)\n        .or(`data_criacao.eq.${hoje},data_pagamento.eq.${hoje}`)"
    },
    {
      "base": "        // da janela de busca — busca e exibição são dimensões separadas.\n        const r = await syncShopeeForUserV2(userId, hoje, hoje, false); // noBuffer=false -> update_time\n        resumoSyncInfo = {",
      "novo": "        // da janela de busca — busca e exibição são dimensões separadas.\n        const r = await syncShopeeForUserV2(userId, hoje, hoje, false, loja); // noBuffer=false -> update_time\n        resumoSyncInfo = {"
    },
    {
      "base": "      .eq(\"user_id\", userId)\n      .eq(\"marketplace\", \"Shopee\");\n",
      "novo": "      .eq(\"user_id\", userId)\n      .eq(\"marketplace\", \"Shopee\")\n      .eq(\"loja_id\", lojaId);\n"
    }
  ],
  "app/api/shopee/importar-anuncios/route.ts": [
    {
      "base": "import { autenticarRequisicao } from \"@/lib/autenticacao\";\nimport { getShopeeLojaAtiva } from \"@/lib/shopee-auth\";\n",
      "novo": "import { autenticarRequisicao } from \"@/lib/autenticacao\";\nimport { getShopeeLojaById } from \"@/lib/shopee-auth\";\nimport { corpoSelecaoRecusada, selecionarLojaShopee } from \"@/lib/shopee-loja-selecao\";\n"
    },
    {
      "base": "\n  // Busca loja Shopee com refresh automático de token\n  const lojaAtiva = await getShopeeLojaAtiva(userId);\n  if (!lojaAtiva) {",
      "novo": "\n  // MULTI-LOJA V1: importa de UMA loja EXPLICITA (loja_id no corpo ou na query),\n  // conferida contra as lojas Shopee ATIVAS do dono. Com uma unica loja ativa o\n  // fluxo direto continua; com duas ou mais e sem loja_id → 409\n  // STORE_SELECTION_REQUIRED (a tela pergunta qual). O cookie \"Usar esta\" NAO decide aqui.\n  const corpoPedido = await request.json().catch(() => ({})) as { loja_id?: string };\n  const selecao = await selecionarLojaShopee(userId, {\n    lojaIdExplicito: corpoPedido.loja_id ?? new URL(request.url).searchParams.get(\"loja_id\"), usarCookie: false,\n  });\n  if (!selecao.ok) {\n    if (selecao.motivo === \"SEM_LOJA_SHOPEE\") {\n      return NextResponse.json({ erro: true, semConexao: true, mensagem: \"Conta Shopee não conectada.\" }, { status: 401 });\n    }\n    const { status, corpo } = corpoSelecaoRecusada(selecao);\n    return NextResponse.json(corpo, { status });\n  }\n  // Busca a loja ESCOLHIDA com refresh automático de token\n  const lojaAtiva = await getShopeeLojaById(selecao.lojaId, userId);\n  if (!lojaAtiva) {"
    }
  ],
  "app/api/admin/shopee/backfill-pedidos-0707/route.ts": [
    {
      "base": "import { autenticarRequisicao } from \"@/lib/autenticacao\";\nimport { getShopeeLojaAtiva } from \"@/lib/shopee-auth\";\nimport { shopeeGet } from \"@/lib/shopee-api\";",
      "novo": "import { autenticarRequisicao } from \"@/lib/autenticacao\";\nimport { getShopeeLojaById } from \"@/lib/shopee-auth\";\nimport { corpoSelecaoRecusada, selecionarLojaShopee } from \"@/lib/shopee-loja-selecao\";\nimport { shopeeGet } from \"@/lib/shopee-api\";"
    },
    {
      "base": "\n  const loja = await getShopeeLojaAtiva(userId);\n  if (!loja) {\n    return NextResponse.json({ ok: false, erro: \"Shopee não conectada ou token inválido.\" }, { status: 400 });\n  }\n",
      "novo": "\n  // MULTI-LOJA V1: rota admin SEMPRE com loja EXPLICITA (loja_id), conferida contra as\n  // lojas Shopee ATIVAS do dono — nunca \"a mais recente\". Sem loja_id → recusa.\n  const selecaoLoja = await selecionarLojaShopee(userId, { lojaIdExplicito: new URL(request.url).searchParams.get(\"loja_id\"), usarCookie: false, exigirExplicita: true });\n  if (!selecaoLoja.ok) {\n    const { status, corpo } = corpoSelecaoRecusada(selecaoLoja);\n    return NextResponse.json({ ok: false, ...corpo }, { status: status === 409 ? 400 : status });\n  }\n  const loja = await getShopeeLojaById(selecaoLoja.lojaId, userId);\n  if (!loja) return NextResponse.json({ ok: false, erro: \"Shopee nao conectada ou token invalido.\" }, { status: 400 });\n"
    },
    {
      "base": "    .eq(\"user_id\", userId)\n    .eq(\"marketplace\", \"Shopee\")\n    .in(\"order_id\", targetOrderIds);",
      "novo": "    .eq(\"user_id\", userId)\n    .eq(\"marketplace\", \"Shopee\").eq(\"loja_id\", loja.lojaId)\n    .in(\"order_id\", targetOrderIds);"
    }
  ],
  "app/api/admin/shopee/reconciliar-financeiro/route.ts": [
    {
      "base": "import { autenticarRequisicao } from \"@/lib/autenticacao\";\nimport { getShopeeLojaAtiva } from \"@/lib/shopee-auth\";\nimport { shopeeGet } from \"@/lib/shopee-api\";",
      "novo": "import { autenticarRequisicao } from \"@/lib/autenticacao\";\nimport { getShopeeLojaById } from \"@/lib/shopee-auth\";\nimport { corpoSelecaoRecusada, selecionarLojaShopee } from \"@/lib/shopee-loja-selecao\";\nimport { shopeeGet } from \"@/lib/shopee-api\";"
    },
    {
      "base": "\n  const loja = await getShopeeLojaAtiva(userId);\n  if (!loja) {\n    return NextResponse.json({ ok: false, erro: \"Shopee nao conectada ou token invalido.\" }, { status: 400 });\n  }\n",
      "novo": "\n  // MULTI-LOJA V1: rota admin SEMPRE com loja EXPLICITA (loja_id), conferida contra as\n  // lojas Shopee ATIVAS do dono — nunca \"a mais recente\". Sem loja_id → recusa.\n  const selecaoLoja = await selecionarLojaShopee(userId, { lojaIdExplicito: url.searchParams.get(\"loja_id\"), usarCookie: false, exigirExplicita: true });\n  if (!selecaoLoja.ok) {\n    const { status, corpo } = corpoSelecaoRecusada(selecaoLoja);\n    return NextResponse.json({ ok: false, ...corpo }, { status: status === 409 ? 400 : status });\n  }\n  const loja = await getShopeeLojaById(selecaoLoja.lojaId, userId);\n  if (!loja) return NextResponse.json({ ok: false, erro: \"Shopee nao conectada ou token invalido.\" }, { status: 400 });\n"
    },
    {
      "base": "    .eq(\"user_id\", userId)\n    .eq(\"marketplace\", \"Shopee\")\n    .in(\"status_shopee_raw\", ELEGIVEIS_FINANCEIRO)",
      "novo": "    .eq(\"user_id\", userId)\n    .eq(\"marketplace\", \"Shopee\").eq(\"loja_id\", loja.lojaId)\n    .in(\"status_shopee_raw\", ELEGIVEIS_FINANCEIRO)"
    },
    {
      "base": "        .eq(\"user_id\", userId)\n        .eq(\"marketplace\", \"Shopee\")\n        .eq(\"status_shopee_raw\", \"COMPLETED\")",
      "novo": "        .eq(\"user_id\", userId)\n        .eq(\"marketplace\", \"Shopee\").eq(\"loja_id\", loja.lojaId)\n        .eq(\"status_shopee_raw\", \"COMPLETED\")"
    }
  ],
  "app/api/admin/shopee/status/route.ts": [
    {
      "base": "import { autenticarRequisicao } from \"@/lib/autenticacao\";\nimport { getShopeeLojaAtiva } from \"@/lib/shopee-auth\";\nimport { shopeeGet } from \"@/lib/shopee-api\";",
      "novo": "import { autenticarRequisicao } from \"@/lib/autenticacao\";\nimport { getShopeeLojaById } from \"@/lib/shopee-auth\";\nimport { corpoSelecaoRecusada, selecionarLojaShopee } from \"@/lib/shopee-loja-selecao\";\nimport { shopeeGet } from \"@/lib/shopee-api\";"
    },
    {
      "base": "\n  const loja = await getShopeeLojaAtiva(userId);\n  if (!loja) return NextResponse.json({ ok: false, erro: \"Shopee nao conectada.\" }, { status: 400 });\n",
      "novo": "\n  // MULTI-LOJA V1: rota admin SEMPRE com loja EXPLICITA (loja_id), conferida contra as\n  // lojas Shopee ATIVAS do dono — nunca \"a mais recente\". Sem loja_id → recusa.\n  const selecaoLoja = await selecionarLojaShopee(userId, { lojaIdExplicito: (body as { loja_id?: string }).loja_id ?? null, usarCookie: false, exigirExplicita: true });\n  if (!selecaoLoja.ok) {\n    const { status, corpo } = corpoSelecaoRecusada(selecaoLoja);\n    return NextResponse.json({ ok: false, ...corpo }, { status: status === 409 ? 400 : status });\n  }\n  const loja = await getShopeeLojaById(selecaoLoja.lojaId, userId);\n  if (!loja) return NextResponse.json({ ok: false, erro: \"Shopee nao conectada ou token invalido.\" }, { status: 400 });\n"
    },
    {
      "base": "            .eq(\"user_id\", userId)            // isolamento entre usuarios\n            .eq(\"marketplace\", \"Shopee\")      // isolamento entre marketplaces\n            .in(\"order_id\", lote);",
      "novo": "            .eq(\"user_id\", userId)            // isolamento entre usuarios\n            .eq(\"marketplace\", \"Shopee\").eq(\"loja_id\", loja.lojaId)      // isolamento entre marketplaces\n            .in(\"order_id\", lote);"
    },
    {
      "base": "          .eq(\"user_id\", userId)\n          .eq(\"marketplace\", \"Shopee\")\n          .in(\"order_id\", g.orderSns);",
      "novo": "          .eq(\"user_id\", userId)\n          .eq(\"marketplace\", \"Shopee\").eq(\"loja_id\", loja.lojaId)\n          .in(\"order_id\", g.orderSns);"
    }
  ],
  "app/(app)/anuncios/page.tsx": [
    {
      "base": "  const [msgImportShopee,    setMsgImportShopee]    = useState<{ ok: boolean; texto: string } | null>(null);\n",
      "novo": "  const [msgImportShopee,    setMsgImportShopee]    = useState<{ ok: boolean; texto: string } | null>(null);\n  // MULTI-LOJA V1: lojas Shopee para escolher quando o dono tem mais de uma (a API responde 409)\n  const [lojasShopeeEscolha, setLojasShopeeEscolha] = useState<{ id: string; rotulo: string }[] | null>(null);\n"
    },
    {
      "base": "\n  async function importarDaShopee() {\n    setImportandoShopee(true);\n    setMsgImportShopee(null);\n    try {\n      const res = await fetch(\"/api/shopee/importar-anuncios\", { method: \"POST\" });\n      // Ver comentário em importarDoML: o corpo cru é que distingue\n      // timeout nosso de erro do marketplace.\n      const r = classificarRespostaImportacao(res.status, await res.text(), \"Shopee\");\n      if (r.classe !== \"SUCESSO\") {",
      "novo": "\n  async function importarDaShopee(lojaId?: string) {\n    setImportandoShopee(true);\n    setMsgImportShopee(null);\n    setLojasShopeeEscolha(null);\n    try {\n      // MULTI-LOJA V1: importa de UMA loja explicita; sem loja_id a API decide so\n      // quando ha uma unica loja Shopee ativa (senao 409 STORE_SELECTION_REQUIRED).\n      const res = await fetch(\"/api/shopee/importar-anuncios\", {\n        method: \"POST\",\n        ...(lojaId ? { headers: { \"Content-Type\": \"application/json\" }, body: JSON.stringify({ loja_id: lojaId }) } : {}),\n      });\n      const corpoTexto = await res.text();\n      if (res.status === 409) {\n        let escolha: { id: string; rotulo: string }[] = [];\n        try {\n          const d = JSON.parse(corpoTexto);\n          if (d?.codigo === \"STORE_SELECTION_REQUIRED\" && Array.isArray(d.lojas)) {\n            escolha = d.lojas.filter((l: { id?: unknown; rotulo?: unknown }) => typeof l?.id === \"string\")\n              .map((l: { id: string; rotulo?: unknown }) => ({ id: l.id, rotulo: String(l.rotulo ?? \"Shopee\") }));\n          }\n        } catch { /* corpo nao-JSON: cai na classificacao padrao abaixo */ }\n        if (escolha.length) { setLojasShopeeEscolha(escolha); setImportandoShopee(false); return; }\n      }\n      // Ver comentário em importarDoML: o corpo cru é que distingue\n      // timeout nosso de erro do marketplace.\n      const r = classificarRespostaImportacao(res.status, corpoTexto, \"Shopee\");\n      if (r.classe !== \"SUCESSO\") {"
    },
    {
      "base": "          <button\n            onClick={importarDaShopee}\n            disabled={importandoShopee}",
      "novo": "          <button\n            onClick={() => importarDaShopee()}\n            disabled={importandoShopee}"
    },
    {
      "base": "      {/* ── Feedback Importar da Shopee ──────────────────────── */}\n      {msgImportShopee && (",
      "novo": "      {/* ── Feedback Importar da Shopee ──────────────────────── */}\n      {lojasShopeeEscolha && (\n        <div role=\"dialog\" aria-label=\"Escolha a loja Shopee para importar\" style={{\n          background: \"rgba(238,77,45,0.06)\", border: \"1px solid rgba(238,77,45,0.25)\",\n          borderRadius: \"14px\", padding: \"14px 18px\", marginBottom: \"16px\",\n        }}>\n          <div style={{ color: \"#EE4D2D\", fontWeight: 800, fontSize: \"14px\", marginBottom: \"10px\" }}>Escolha a loja Shopee para importar</div>\n          <div style={{ display: \"flex\", flexWrap: \"wrap\", gap: \"8px\" }}>\n            {lojasShopeeEscolha.map(l => (\n              <button key={l.id} type=\"button\" onClick={() => importarDaShopee(l.id)}\n                style={{ background: \"rgba(238,77,45,0.15)\", border: \"1px solid rgba(238,77,45,0.3)\", borderRadius: \"8px\", padding: \"7px 14px\", color: \"#EE4D2D\", fontWeight: 700, fontSize: \"13px\", cursor: \"pointer\" }}>\n                {l.rotulo}\n              </button>\n            ))}\n            <button type=\"button\" onClick={() => setLojasShopeeEscolha(null)}\n              style={{ background: \"transparent\", border: \"1px solid rgba(255,255,255,0.15)\", borderRadius: \"8px\", padding: \"7px 14px\", color: \"#9099aa\", fontSize: \"13px\", cursor: \"pointer\" }}>\n              Cancelar\n            </button>\n          </div>\n        </div>\n      )}\n\n      {msgImportShopee && ("
    }
  ]
};

const lf = (s: string) => s.replace(/\r\n/g, "\n");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
function blob(raiz: string, rev: string, arquivo: string): string | null {
  try { return lf(execFileSync("git", ["show", `${rev}:${arquivo}`], { cwd: raiz, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })); }
  catch { return null; }
}
function idBlob(raiz: string, rev: string, arquivo: string): string | null {
  try { return execFileSync("git", ["rev-parse", `${rev}:${arquivo}`], { cwd: raiz, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return null; }
}
function ler(raiz: string, arquivo: string): string | null {
  try { return lf(readFileSync(join(raiz, arquivo), "utf8")); } catch { return null; }
}

/** Arquivo atual − hunks multi-loja aprovados = 5fdb51f, byte a byte (cada hunk exatamente uma vez). */
export function arquivoExatoShopeeMultiStore(raiz: string, arquivo: string): boolean {
  const hunks = PATCH[arquivo];
  let s = hunks ? ler(raiz, arquivo) : null;
  if (s === null) return false;
  for (const h of hunks) {
    if (s.split(h.novo).length !== 2) return false;
    s = s.replace(h.novo, () => h.base);
  }
  const base = blob(raiz, BASE_SHOPEE_MULTI_STORE, arquivo);
  return base !== null && s === base;
}

export function novoExatoShopeeMultiStore(raiz: string, arquivo: string): boolean {
  if (arquivo === HELPER_SHOPEE_MULTI_STORE) {
    const s = ler(raiz, HELPER_SHOPEE_MULTI_STORE);
    return s !== null && sha(s.replace(/const SHA256_HELPER_SHOPEE_MULTI_STORE = "[0-9a-f]{64}";/, `const SHA256_HELPER_SHOPEE_MULTI_STORE = "${"0".repeat(64)}";`)) === SHA256_HELPER_SHOPEE_MULTI_STORE;
  }
  const esperado = SHA256_NOVOS[arquivo];
  const s = esperado ? ler(raiz, arquivo) : null;
  return s !== null && sha(s) === esperado;
}

const ehNovo = (f: string) => f in SHA256_NOVOS || f === HELPER_SHOPEE_MULTI_STORE;

/** Remove da lista SO o que esta excecao cobre (arquivos exatos com base aprovada; novos exatos ausentes na base). */
export function filtrarExcecaoShopeeMultiStore(raiz: string, base: string, alterados: string[]): string[] {
  return alterados.filter((f) => {
    if (f in PATCH) { const b = idBlob(raiz, base, f); return !(b !== null && BLOBS_BASE_APROVADOS[f].includes(b) && arquivoExatoShopeeMultiStore(raiz, f)); }
    if (ehNovo(f) && blob(raiz, base, f) === null) return !novoExatoShopeeMultiStore(raiz, f);
    return true;
  });
}
